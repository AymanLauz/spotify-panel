// Spotify Panel: a small Spotify player in the GNOME top bar.
//
// File layout:
//   Settings ........... constants you may want to tweak
//   Helpers ............ time formatting, scrolling-text (Marquee)
//   SpotifyIndicator ... the top bar item and its popup
//     Top bar .......... prev/play/next, logo, "Artist - Song"
//     Popup ............ cover, title, artist, progress bar, controls
//     Spotify connection  talking to Spotify over D-Bus (MPRIS)
//     Position / seeking  progress bar and jumping within a song
//     Cover ............ album art (downloading is in coverCache.js)
//   Extension .......... where it goes in the top bar, enable/disable

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as Slider from 'resource:///org/gnome/shell/ui/slider.js';

import {CoverCache} from './coverCache.js';

// ======== Settings ========

// Only Spotify is followed; every other MPRIS player (browsers, VLC, ...) is ignored.
const BUS_NAME = 'org.mpris.MediaPlayer2.spotify';
const OBJECT_PATH = '/org/mpris/MediaPlayer2';
const PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';
const SPOTIFY_DESKTOP_ID = 'com.spotify.Client.desktop';

// Fixed width of "Artist - Song" in the top bar, so skipping songs never
// resizes the item (and moves the popup). Longer text ends in "…".
const PANEL_TEXT_WIDTH = 210;
// How often the progress bar updates while the popup is open.
const POSITION_POLL_MS = 1000;
// Spotify keeps reporting the old position for a moment after a seek.
const SEEK_SETTLE_MS = 800;
// Wait this long after the last mouse-wheel step on the bar before seeking.
const SCROLL_SEEK_DELAY_MS = 300;

// The parts of Spotify's D-Bus player interface this extension uses.
const PlayerIface = `<node>
  <interface name="${PLAYER_IFACE}">
    <method name="PlayPause"/>
    <method name="Next"/>
    <method name="Previous"/>
    <method name="SetPosition">
      <arg type="o" direction="in" name="TrackId"/>
      <arg type="x" direction="in" name="Position"/>
    </method>
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="Metadata" type="a{sv}" access="read"/>
    <property name="CanGoNext" type="b" access="read"/>
    <property name="CanGoPrevious" type="b" access="read"/>
    <property name="CanSeek" type="b" access="read"/>
    <signal name="Seeked">
      <arg type="x" name="Position"/>
    </signal>
  </interface>
</node>`;
const PlayerProxy = Gio.DBusProxy.makeProxyWrapper(PlayerIface);

// ======== Helpers ========

// Microseconds -> "3:07" (or "1:02:03" for long tracks).
function formatTime(usec) {
    const totalSeconds = Math.max(0, Math.floor(usec / 1_000_000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = String(totalSeconds % 60).padStart(2, '0');
    return hours > 0
        ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
        : `${minutes}:${seconds}`;
}

// True for the harmless error we get when a request is cancelled on purpose.
function isCancelled(error) {
    return error instanceof GLib.Error &&
        error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

/**
 * Slides a label back and forth inside a clipped container so text that is
 * wider than the container can be read in full.
 */
class Marquee {
    constructor(clip, label, {startDelay, pause, pxPerSec}) {
        this._clip = clip;
        this._label = label;
        this._startDelay = startDelay;
        this._pause = pause;
        this._pxPerSec = pxPerSec;
    }

    /** Returns how many pixels the label overflows the clip (<= 0 if it fits). */
    get overflow() {
        const [, labelWidth] = this._label.get_preferred_width(-1);
        return Math.ceil(labelWidth - this._clip.width);
    }

    start() {
        this.stop();
        const overflow = this.overflow;
        if (this._clip.width > 0 && overflow > 0)
            this._slide(overflow, true, this._startDelay);
    }

    stop() {
        this._label.remove_all_transitions();
        this._label.translation_x = 0;
    }

    _slide(overflow, forward, delay) {
        this._label.ease({
            translation_x: forward ? -overflow : 0,
            delay,
            duration: Math.round(overflow / this._pxPerSec * 1000),
            mode: Clutter.AnimationMode.LINEAR,
            onComplete: () => this._slide(overflow, !forward, this._pause),
        });
    }
}

// ======== SpotifyIndicator: the top bar item + popup ========

const SpotifyIndicator = GObject.registerClass(
class SpotifyIndicator extends PanelMenu.Button {
    // Builds everything, then waits for Spotify to start or quit.
    _init(extension) {
        super._init(0.5, 'Spotify', false);

        this._extension = extension;
        this._coverCache = new CoverCache();
        this._proxy = null;
        this._proxyCancellable = null;
        this._seekedId = 0;
        this._pollId = 0;
        this._scrollSeekId = 0;

        this._trackId = '';
        this._panelFullText = '';
        this._length = 0;
        this._coverUrl = '';
        this._shownCoverUrl = null;
        this._status = 'Stopped';
        this._canSeek = false;
        this._dragging = false;
        this._settingSlider = false;
        this._seekSettleUntil = 0;

        this._buildPanel();
        this._buildPopup();

        this.menu.connect('open-state-changed', (_menu, open) => this._onMenuOpenChanged(open));

        this._setShown(false);
        // Called when Spotify opens (appeared) or closes (vanished).
        this._watchId = Gio.bus_watch_name(
            Gio.BusType.SESSION, BUS_NAME, Gio.BusNameWatcherFlags.NONE,
            () => this._onSpotifyAppeared(),
            () => this._onSpotifyVanished());
    }

    // ---- Top bar ----

    // Creates the top bar item: [prev][play][next] [logo][Artist - Song].
    _buildPanel() {
        // PanelMenu.Button opens its menu on a press anywhere inside it, which
        // would include the media buttons. Instead the same press-to-open
        // gesture goes on the logo + text area only; the media buttons sit
        // beside it, so their presses never reach it. The whole thing is still
        // one panel button, so the popup is centered under all of it.
        this._clickGesture?.set_enabled(false);
        this.add_style_class_name('spotify-panel-button');

        const box = new St.BoxLayout({style_class: 'spotify-panel-box'});
        this.add_child(box);

        // Logo + text: pressing here opens the popup.
        const infoBox = new St.BoxLayout({
            style_class: 'spotify-panel-info-box',
            reactive: true,
            track_hover: true,
        });
        this._infoBox = infoBox;
        const openGesture = new Clutter.ClickGesture({recognize_on_press: true});
        openGesture.connect('recognize', () => this.menu.toggle());
        infoBox.add_action(openGesture);

        infoBox.add_child(new St.Icon({
            gicon: Gio.icon_new_for_string(`${this._extension.path}/icons/spotify-symbolic.svg`),
            style_class: 'spotify-panel-logo',
            y_align: Clutter.ActorAlign.CENTER,
        }));

        // The text sits in a fixed-width box that hides whatever doesn't fit.
        this._panelTextClip = new St.Widget({
            style_class: 'spotify-panel-text-clip',
            clip_to_allocation: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._panelText = new St.Label({style_class: 'spotify-panel-text'});
        this._panelTextClip.add_child(this._panelText);
        infoBox.add_child(this._panelTextClip);

        // Keep the fixed width correct if the display scaling changes.
        const themeContext = St.ThemeContext.get_for_stage(global.stage);
        const updateClipWidth = () => {
            this._panelTextClip.width = PANEL_TEXT_WIDTH * themeContext.scale_factor;
            this._updatePanelText();
        };
        themeContext.connectObject('notify::scale-factor', updateClipWidth, this);

        this._panelMarquee = new Marquee(this._panelTextClip, this._panelText,
            {startDelay: 300, pause: 1000, pxPerSec: 60});
        updateClipWidth();
        infoBox.connect('notify::hover', () => this._updatePanelText());

        // Media buttons: these only control playback, never open the popup.
        this._controls = new St.BoxLayout({
            style_class: 'spotify-panel-controls',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._panelPrev = this._makeButton('media-skip-backward-symbolic', 'spotify-panel-control',
            () => this._proxy?.PreviousAsync().catch(logError));
        this._panelPlay = this._makeButton('media-playback-start-symbolic', 'spotify-panel-control',
            () => this._proxy?.PlayPauseAsync().catch(logError));
        this._panelNext = this._makeButton('media-skip-forward-symbolic', 'spotify-panel-control',
            () => this._proxy?.NextAsync().catch(logError));
        this._controls.add_child(this._panelPrev);
        this._controls.add_child(this._panelPlay);
        this._controls.add_child(this._panelNext);
        // Order: prev, play/pause, next, logo, text.
        box.add_child(this._controls);
        box.add_child(infoBox);
    }

    // A round icon button (used in both the top bar and the popup).
    _makeButton(iconName, styleClass, callback) {
        const button = new St.Button({
            style_class: styleClass,
            child: new St.Icon({icon_name: iconName}),
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        button.connect('clicked', callback);
        return button;
    }

    // Shows "Artist - Song" in the top bar; scrolls it while hovered.
    _updatePanelText() {
        // Cut off with "…" at the fixed width normally; on hover the full text
        // slides through the same space, so the top bar never changes width.
        const label = this._panelText;
        this._panelMarquee.stop();
        label.text = this._panelFullText;
        // Measure the full text, not the fixed width set last time.
        label.width = -1;

        if (this._infoBox.hover && this._panelMarquee.overflow > 0) {
            label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            this._panelMarquee.start();
        } else {
            label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            label.width = this._panelTextClip.width;
        }
    }

    // ---- Popup ----

    // Creates the popup, top to bottom: cover, title, artist, progress bar, controls.
    _buildPopup() {
        const popup = new St.BoxLayout({
            style_class: 'spotify-panel-popup',
            orientation: Clutter.Orientation.VERTICAL,
        });
        this.menu.box.add_child(popup);

        // Cover (a Spotify logo is shown until the image is ready).
        this._coverPlaceholder = new St.Icon({
            gicon: Gio.icon_new_for_string(`${this._extension.path}/icons/spotify-symbolic.svg`),
            style_class: 'spotify-panel-cover-placeholder',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        // Clicking the cover or the title brings up the Spotify window.
        this._cover = new St.Button({
            style_class: 'spotify-panel-cover',
            x_align: Clutter.ActorAlign.CENTER,
            child: this._coverPlaceholder,
            accessible_name: 'Open Spotify',
        });
        this._cover.connect('clicked', () => this._raiseSpotify());
        popup.add_child(this._cover);

        // Song title (scrolls when too long).
        this._titleClip = new St.Widget({
            style_class: 'spotify-panel-popup-title-clip',
            clip_to_allocation: true,
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._popupTitle = new St.Label({style_class: 'spotify-panel-popup-title'});
        this._popupTitle.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this._titleClip.add_child(this._popupTitle);
        this._titleClip.connect('notify::width', () => this._updatePopupTitle());
        this._titleClip.reactive = true;
        const titleClick = new Clutter.ClickGesture();
        titleClick.connect('recognize', () => this._raiseSpotify());
        this._titleClip.add_action(titleClick);
        popup.add_child(this._titleClip);

        this._popupMarquee = new Marquee(this._titleClip, this._popupTitle,
            {startDelay: 1500, pause: 1500, pxPerSec: 35});

        // Artist name.
        this._popupArtist = new St.Label({
            style_class: 'spotify-panel-popup-artist',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._popupArtist.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        popup.add_child(this._popupArtist);

        // Progress bar row: [elapsed time] [bar] [song length].
        const timeRow = new St.BoxLayout({style_class: 'spotify-panel-time-row'});
        this._elapsedLabel = new St.Label({
            style_class: 'spotify-panel-time',
            text: formatTime(0),
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._slider = new Slider.Slider(0);
        this._slider.accessible_name = 'Song position';
        this._slider.y_align = Clutter.ActorAlign.CENTER;
        this._lengthLabel = new St.Label({
            style_class: 'spotify-panel-time',
            text: formatTime(0),
            y_align: Clutter.ActorAlign.CENTER,
        });
        timeRow.add_child(this._elapsedLabel);
        timeRow.add_child(this._slider);
        timeRow.add_child(this._lengthLabel);
        popup.add_child(timeRow);

        // Dragging or scrolling the bar jumps within the song.
        this._slider.connect('drag-begin', () => {
            this._dragging = true;
        });
        this._slider.connect('drag-end', () => {
            this._dragging = false;
            this._seekToSlider();
        });
        this._slider.connect('notify::value', () => {
            if (this._settingSlider)
                return;
            this._elapsedLabel.text = formatTime(this._slider.value * this._length);
            // Scroll wheel and arrow keys change the value without a drag.
            if (!this._dragging)
                this._queueScrollSeek();
        });

        // Big prev / play-pause / next buttons.
        const controls = new St.BoxLayout({
            style_class: 'spotify-panel-popup-controls',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._popupPrev = this._makeButton('media-skip-backward-symbolic', 'spotify-panel-popup-control',
            () => this._proxy?.PreviousAsync().catch(logError));
        this._popupPlay = this._makeButton('media-playback-start-symbolic',
            'spotify-panel-popup-control spotify-panel-popup-play',
            () => this._proxy?.PlayPauseAsync().catch(logError));
        this._popupNext = this._makeButton('media-skip-forward-symbolic', 'spotify-panel-popup-control',
            () => this._proxy?.NextAsync().catch(logError));
        controls.add_child(this._popupPrev);
        controls.add_child(this._popupPlay);
        controls.add_child(this._popupNext);
        popup.add_child(controls);
    }

    // Brings the Spotify window to the front (cover/title click).
    _raiseSpotify() {
        this.menu.close();
        // Same as clicking Spotify in the dash: focuses its window, or opens it.
        const app = Shell.AppSystem.get_default().lookup_app(SPOTIFY_DESKTOP_ID);
        if (app)
            app.activate();
        else
            Gio.DBus.session.call(BUS_NAME, OBJECT_PATH, 'org.mpris.MediaPlayer2', 'Raise',
                null, null, Gio.DBusCallFlags.NONE, -1, null).catch(logError);
    }

    // Popup opened/closed: load the cover, start/stop the progress updates and scrolling.
    _onMenuOpenChanged(open) {
        if (open) {
            this._updateCover();
            this._fetchPosition();
        }
        this._updatePopupTitle();
        this._updatePolling();
    }

    // Puts the title in place in the popup.
    _updatePopupTitle() {
        // Centered when it fits; otherwise it scrolls while the popup is open.
        this._popupMarquee.stop();
        const overflow = this._popupMarquee.overflow;
        if (this._titleClip.width <= 0)
            return;
        if (overflow <= 0) {
            this._popupTitle.x = Math.floor(-overflow / 2);
            return;
        }
        this._popupTitle.x = 0;
        if (this.menu.isOpen)
            this._popupMarquee.start();
    }

    // ---- Spotify connection ----

    // Spotify started: connect to it and listen for changes.
    _onSpotifyAppeared() {
        this._disconnectProxy();
        this._proxyCancellable = new Gio.Cancellable();

        new PlayerProxy(Gio.DBus.session, BUS_NAME, OBJECT_PATH, (proxy, error) => {
            if (error) {
                if (!isCancelled(error))
                    console.error(`spotify-panel: could not connect to Spotify: ${error.message}`);
                return;
            }
            this._proxy = proxy;
            proxy.connectObject('g-properties-changed', () => this._sync(), this);
            this._seekedId = proxy.connectSignal('Seeked', (_proxy, _sender, [position]) => {
                if (!this._dragging && GLib.get_monotonic_time() >= this._seekSettleUntil)
                    this._setPosition(position);
            });
            this._sync();
        }, this._proxyCancellable, Gio.DBusProxyFlags.DO_NOT_AUTO_START);
    }

    // Spotify quit: hide the top bar item.
    _onSpotifyVanished() {
        this._disconnectProxy();
        this._trackId = '';
        this._setShown(false);
        this._updatePolling();
    }

    // Drops the connection to Spotify.
    _disconnectProxy() {
        this._proxyCancellable?.cancel();
        this._proxyCancellable = null;
        if (this._proxy) {
            this._proxy.disconnectObject(this);
            if (this._seekedId)
                this._proxy.disconnectSignal(this._seekedId);
            this._seekedId = 0;
            this._proxy = null;
        }
    }

    // Reads what Spotify is playing and updates the top bar and popup.
    // Runs whenever Spotify reports a change (new song, play/pause, ...).
    _sync() {
        const proxy = this._proxy;
        if (!proxy)
            return;

        const metadata = {};
        const raw = proxy.Metadata ?? {};
        for (const key in raw)
            metadata[key] = raw[key].recursiveUnpack();

        const trackId = String(metadata['mpris:trackid'] ?? '');
        const isAd = trackId.startsWith('/com/spotify/ad/');
        let title = typeof metadata['xesam:title'] === 'string' ? metadata['xesam:title'] : '';
        let artists = Array.isArray(metadata['xesam:artist'])
            ? metadata['xesam:artist'].filter(a => a).join(', ') : '';
        if (isAd) {
            title ||= 'Advertisement';
            artists ||= 'Spotify';
        }

        this._length = Number(metadata['mpris:length'] ?? 0);
        this._coverUrl = isAd ? '' : String(metadata['mpris:artUrl'] ?? '');
        this._status = proxy.PlaybackStatus ?? 'Stopped';
        this._canSeek = !!proxy.CanSeek && this._length > 0;

        // Top bar
        const panelText = artists ? `${artists} - ${title}` : title;
        if (panelText !== this._panelFullText) {
            this._panelFullText = panelText;
            this._updatePanelText();
        }
        const playIcon = this._status === 'Playing'
            ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
        this._panelPlay.child.icon_name = playIcon;
        this._popupPlay.child.icon_name = playIcon;
        for (const button of [this._panelPrev, this._popupPrev])
            button.reactive = proxy.CanGoPrevious ?? true;
        for (const button of [this._panelNext, this._popupNext])
            button.reactive = proxy.CanGoNext ?? true;

        // Popup
        if (this._popupTitle.text !== title) {
            this._popupTitle.text = title;
            this._updatePopupTitle();
        }
        this._popupArtist.text = artists;
        this._lengthLabel.text = formatTime(this._length);
        this._slider.reactive = this._canSeek;

        if (trackId !== this._trackId) {
            this._trackId = trackId;
            this._seekSettleUntil = 0;
            this._setPosition(0);
            this._fetchPosition();
        } else if (this.menu.isOpen) {
            // Play/pause changed: resync so the slider doesn't drift.
            this._fetchPosition();
        }

        this._updateCover();
        this._updatePolling();
        this._setShown(title !== '');
    }

    // Shows/hides the whole top bar item.
    _setShown(shown) {
        this.visible = shown;
        this.container.visible = shown;
        if (!shown)
            this.menu.close();
    }

    // ---- Position / seeking ----

    _updatePolling() {
        // Spotify doesn't announce position changes, so it is asked once a
        // second, and only while the popup is open and a song is playing.
        const wanted = !!this._proxy && this.menu.isOpen && this._status === 'Playing';
        if (wanted && !this._pollId) {
            this._pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POSITION_POLL_MS, () => {
                this._fetchPosition();
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!wanted && this._pollId) {
            GLib.source_remove(this._pollId);
            this._pollId = 0;
        }
    }

    // Asks Spotify where in the song it is and moves the bar there.
    async _fetchPosition() {
        if (!this._proxy || !this.menu.isOpen)
            return;
        const cancellable = this._proxyCancellable;
        try {
            const reply = await Gio.DBus.session.call(
                BUS_NAME, OBJECT_PATH, 'org.freedesktop.DBus.Properties', 'Get',
                new GLib.Variant('(ss)', [PLAYER_IFACE, 'Position']),
                new GLib.VariantType('(v)'), Gio.DBusCallFlags.NONE, -1, cancellable);
            const [position] = reply.recursiveUnpack();
            if (cancellable !== this._proxyCancellable || cancellable?.is_cancelled())
                return;
            if (this._dragging || GLib.get_monotonic_time() < this._seekSettleUntil)
                return;
            this._setPosition(Number(position));
        } catch (e) {
            if (!isCancelled(e))
                console.debug(`spotify-panel: position query failed: ${e.message}`);
        }
    }

    // Moves the bar and the elapsed time to `position` (microseconds).
    _setPosition(position) {
        this._settingSlider = true;
        this._slider.value = this._length > 0
            ? Math.clamp(position / this._length, 0, 1) : 0;
        this._settingSlider = false;
        this._elapsedLabel.text = formatTime(Math.min(position, this._length || position));
    }

    // Mouse wheel on the bar: seek once the scrolling stops.
    _queueScrollSeek() {
        if (this._scrollSeekId)
            GLib.source_remove(this._scrollSeekId);
        this._scrollSeekId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SCROLL_SEEK_DELAY_MS, () => {
            this._scrollSeekId = 0;
            this._seekToSlider();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Tells Spotify to jump to where the bar is.
    _seekToSlider() {
        if (this._scrollSeekId) {
            GLib.source_remove(this._scrollSeekId);
            this._scrollSeekId = 0;
        }
        if (!this._proxy || !this._canSeek || !this._trackId)
            return;

        const position = Math.round(this._slider.value * this._length);
        this._seekSettleUntil = GLib.get_monotonic_time() + SEEK_SETTLE_MS * 1000;
        this._setPosition(position);
        try {
            this._proxy.SetPositionAsync(this._trackId, position).catch(logError);
        } catch (e) {
            // e.g. a track id that isn't a valid D-Bus object path
            logError(e);
        }
    }

    // ---- Cover ----

    // Loads the current song's cover into the popup.
    async _updateCover() {
        // Covers are only fetched when the popup is actually opened.
        if (!this.menu.isOpen || this._coverUrl === this._shownCoverUrl)
            return;

        const url = this._coverUrl;
        this._shownCoverUrl = url;
        this._showCover(null);

        try {
            const file = await this._coverCache.lookup(url);
            if (this._shownCoverUrl === url)
                this._showCover(file);
        } catch (e) {
            if (isCancelled(e))
                return;
            console.warn(`spotify-panel: ${e.message}`);
            // Allow a retry next time the popup opens.
            if (this._shownCoverUrl === url)
                this._shownCoverUrl = null;
        }
    }

    // Shows the cover image, or the logo placeholder when there is none.
    _showCover(file) {
        if (file) {
            this._cover.style = `background-image: url("${file.get_uri()}");`;
            this._coverPlaceholder.hide();
        } else {
            this._cover.style = null;
            this._coverPlaceholder.show();
        }
    }

    // Cleans up everything when the extension is turned off.
    _onDestroy() {
        if (this._watchId) {
            Gio.bus_unwatch_name(this._watchId);
            this._watchId = 0;
        }
        this._disconnectProxy();
        if (this._pollId) {
            GLib.source_remove(this._pollId);
            this._pollId = 0;
        }
        if (this._scrollSeekId) {
            GLib.source_remove(this._scrollSeekId);
            this._scrollSeekId = 0;
        }
        this._panelMarquee.stop();
        this._popupMarquee.stop();
        this._coverCache.destroy();
        super._onDestroy();
    }
});

// ======== Extension ========

/**
 * Index in the left panel box right after the Places menu. If Places isn't
 * there yet, use the slot Places itself picks (after Activities), so when it
 * loads later it inserts before us and the order still comes out right.
 */
function panelPosition() {
    const places = Main.panel.statusArea['places-menu'];
    const box = places?.container.get_parent();
    if (box)
        return box.get_children().indexOf(places.container) + 1;

    let position = Main.sessionMode.panel.left.length;
    if ('apps-menu' in Main.panel.statusArea)
        position++;
    return position;
}

// Called by GNOME when the extension is turned on/off.
export default class SpotifyPanelExtension extends Extension {
    enable() {
        this._indicator = new SpotifyIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator, panelPosition(), 'left');
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
