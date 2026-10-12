// Downloads album covers and keeps them on disk (~/.cache/spotify-panel).

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

// Lets the async file/network calls below be used with `await`.
Gio._promisify(Soup.Session.prototype, 'send_and_read_async');
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');
Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.File.prototype, 'set_attributes_async');
Gio._promisify(Gio.File.prototype, 'delete_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');

// Cache size limit; the oldest covers are deleted past this.
const MAX_CACHE_BYTES = 8 * 1024 * 1024;

/**
 * Album covers downloaded from Spotify's CDN, kept on disk in
 * ~/.cache/spotify-panel so replayed songs don't download them again.
 * Least recently shown covers are deleted once the folder passes MAX_CACHE_BYTES.
 */
export class CoverCache {
    constructor() {
        this._dir = Gio.File.new_for_path(
            GLib.build_filenamev([GLib.get_user_cache_dir(), 'spotify-panel']));
        this._session = new Soup.Session({timeout: 15});
        this._cancellable = new Gio.Cancellable();
    }

    /**
     * Returns a local Gio.File for the cover at `url`, downloading it if needed.
     * Returns null if there is no usable cover.
     */
    async lookup(url) {
        if (!url)
            return null;

        if (url.startsWith('file://'))
            return Gio.File.new_for_uri(url);

        if (!url.startsWith('https://') && !url.startsWith('http://'))
            return null;

        const name = `${GLib.compute_checksum_for_string(GLib.ChecksumType.SHA1, url, -1)}.jpg`;
        const file = this._dir.get_child(name);

        // Already downloaded before: use the saved copy.
        if (file.query_exists(null)) {
            this._touch(file).catch(() => {});
            return file;
        }

        // Not saved yet: download it and save it.
        const message = Soup.Message.new('GET', url);
        if (!message)
            return null;

        const bytes = await this._session.send_and_read_async(
            message, GLib.PRIORITY_DEFAULT, this._cancellable);
        if (message.get_status() !== Soup.Status.OK)
            throw new Error(`Cover download failed: HTTP ${message.get_status()}`);

        GLib.mkdir_with_parents(this._dir.get_path(), 0o755);
        await file.replace_contents_bytes_async(
            bytes, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, this._cancellable);

        this._prune().catch(e => console.warn(`spotify-panel: cover cache prune failed: ${e.message}`));
        return file;
    }

    // Stops any download in progress (extension turned off).
    destroy() {
        this._cancellable.cancel();
        this._session.abort();
    }

    // Marks a cover as recently used so it isn't the next one deleted.
    async _touch(file) {
        const info = new Gio.FileInfo();
        info.set_modification_date_time(GLib.DateTime.new_now_utc());
        await file.set_attributes_async(
            info, Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_LOW, this._cancellable);
    }

    // Deletes the least recently used covers until the cache fits the limit.
    async _prune() {
        const enumerator = await this._dir.enumerate_children_async(
            'standard::name,standard::size,time::modified',
            Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_LOW, this._cancellable);

        const entries = [];
        let infos;
        while ((infos = await enumerator.next_files_async(100, GLib.PRIORITY_LOW, this._cancellable)).length > 0) {
            for (const info of infos) {
                entries.push({
                    name: info.get_name(),
                    size: info.get_size(),
                    mtime: info.get_modification_date_time()?.to_unix() ?? 0,
                });
            }
        }

        let total = entries.reduce((sum, e) => sum + e.size, 0);
        entries.sort((a, b) => a.mtime - b.mtime);

        for (const entry of entries) {
            if (total <= MAX_CACHE_BYTES)
                break;
            await this._dir.get_child(entry.name).delete_async(GLib.PRIORITY_LOW, this._cancellable);
            total -= entry.size;
        }
    }
}
