"use strict";

// Talks to the Roon Core as a Roon extension and keeps the state browser
// clients need: zones, per-client browse sessions, queue subscriptions, images.

const fs = require("fs");
const path = require("path");
const EventEmitter = require("events");
const RoonApi = require("node-roon-api");
const RoonApiStatus = require("node-roon-api-status");
const RoonApiTransport = require("node-roon-api-transport");
const RoonApiBrowse = require("node-roon-api-browse");
const RoonApiImage = require("node-roon-api-image");
const config = require("./config");
const log = require("./log");
const pkg = require("../package.json");

const STATE_FILE = path.join(config.data_dir, "roon-state.json");
const HISTORY_FILE = path.join(config.data_dir, "history.json");
const HISTORY_MAX = 300;
const QUEUE_MAX = 150;
const IMAGE_SIZES = [64, 120, 240, 360, 600, 1000];
const IMAGE_CACHE_BYTES = 256 * 1024 * 1024;

function read_state() {
    try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch (e) { return {}; }
}

function write_state(state) {
    const tmp = STATE_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, STATE_FILE);
}

// Insertion-ordered Map as an LRU bounded by total bytes.
class ImageCache {
    constructor(max_bytes) { this.max = max_bytes; this.bytes = 0; this.map = new Map(); }
    get(k) {
        const v = this.map.get(k);
        if (!v) return null;
        this.map.delete(k);
        this.map.set(k, v);
        return v;
    }
    set(k, v) {
        if (this.map.has(k)) { this.bytes -= this.map.get(k).body.length; this.map.delete(k); }
        this.map.set(k, v);
        this.bytes += v.body.length;
        while (this.bytes > this.max && this.map.size) {
            const first = this.map.keys().next().value;
            this.bytes -= this.map.get(first).body.length;
            this.map.delete(first);
        }
    }
}

class Roon extends EventEmitter {
    constructor() {
        super();
        this.core = null;
        this.transport = null;
        this.browser = null;
        this.image = null;
        this.zones = {};
        this.status_text = "Waiting for authorization in Roon (Settings → Extensions)";
        this.images = new ImageCache(IMAGE_CACHE_BYTES);
        this.image_waiters = new Map();
        this.reconnect_delay = 1000;
        this.clients = 0;
        this.last_track = {};     // zone_id -> "line1|line2" last recorded
        this.history = [];
        try { this.history = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8")); } catch (e) { this.history = []; }
        this.history_timer = null;

        this.api = new RoonApi({
            // Two instances with the same id knock each other off the Core
            // every second, so a dev instance needs its own id.
            extension_id: config.extension_id,
            display_name: config.extension_id === "net.needle.remote" ? "Needle" : "Needle (" + config.extension_id + ")",
            display_version: pkg.version,
            publisher: "Needle",
            email: "needle@localhost",
            website: "https://github.com/priyankub/needle",
            log_level: config.log_level === "debug" ? "all" : "none",
            get_persisted_state: read_state,
            set_persisted_state: write_state,
            core_found: core => this._core_found(core),
            core_lost: core => this._core_lost(core)
        });
        this.svc_status = new RoonApiStatus(this.api);
        this.api.init_services({
            required_services: [RoonApiTransport, RoonApiBrowse, RoonApiImage],
            provided_services: [this.svc_status]
        });
        this._set_status();
    }

    start() {
        if (config.roon_host) this._connect();
        else {
            log.info("roon: no ROON_HOST set, discovering cores on the local network");
            this.api.start_discovery();
        }
    }

    _connect() {
        log.info(`roon: connecting to ${config.roon_host}:${config.roon_port}`);
        let opened = false;
        const moo = this.api.ws_connect({
            host: config.roon_host,
            port: config.roon_port,
            onclose: () => {
                const delay = opened ? 1000 : this.reconnect_delay;
                this.reconnect_delay = Math.min(this.reconnect_delay * 2, 30000);
                log.warn(`roon: connection closed, retrying in ${delay / 1000}s`);
                setTimeout(() => this._connect(), delay);
            }
        });
        const onopen = moo.transport.onopen;
        moo.transport.onopen = () => { opened = true; this.reconnect_delay = 1000; onopen(); };
    }

    _core_found(core) {
        log.info(`roon: authorized by core "${core.display_name}" (${core.core_id})`);
        this.core = core;
        this.transport = core.services.RoonApiTransport;
        this.browser = core.services.RoonApiBrowse;
        this.image = core.services.RoonApiImage;
        this.was_connected = true;
        this.transport.subscribe_zones((response, msg) => this._on_zones(response, msg));
        this._set_status();
        this.emit("core", this.core_info());
    }

    _core_lost(core) {
        log.warn(`roon: lost core "${core.display_name}"`);
        this.core = this.transport = this.browser = this.image = null;
        this.zones = {};
        this._set_status();
        this.emit("core", this.core_info());
        this.emit("zones", []);
    }

    _on_zones(response, msg) {
        if (response === "Subscribed") {
            this.zones = {};
            (msg.zones || []).forEach(z => { this.zones[z.zone_id] = z; this._record(z); });
            this.emit("zones", this.zone_list());
        } else if (response === "Changed") {
            let structural = false;
            (msg.zones_removed || []).forEach(id => { delete this.zones[id]; structural = true; });
            (msg.zones_added || []).forEach(z => { this.zones[z.zone_id] = z; structural = true; });
            (msg.zones_changed || []).forEach(z => { this.zones[z.zone_id] = z; structural = true; });
            if (structural) this.emit("zones", this.zone_list());
            (msg.zones_added || []).concat(msg.zones_changed || []).forEach(z => this._record(z));
            if (msg.zones_seek_changed) {
                const seeks = [];
                msg.zones_seek_changed.forEach(s => {
                    const z = this.zones[s.zone_id];
                    if (!z) return;
                    if (z.now_playing) z.now_playing.seek_position = s.seek_position;
                    z.queue_time_remaining = s.queue_time_remaining;
                    seeks.push({ zone_id: s.zone_id, seek_position: s.seek_position });
                });
                if (seeks.length) this.emit("seek", seeks);
            }
        }
    }

    // Roon doesn't expose its play history to extensions, so keep our own:
    // a track counts once it's playing in a zone.
    _record(z) {
        const np = z.now_playing;
        if (!np || z.state !== "playing") return;
        const three = np.three_line || {};
        const key = (three.line1 || "") + "|" + (three.line2 || "");
        if (!three.line1 || this.last_track[z.zone_id] === key) return;
        this.last_track[z.zone_id] = key;
        const prev = this.history[0];
        if (prev && prev.line1 === three.line1 && prev.line2 === three.line2 && Date.now() - prev.at < 60000) return;
        const entry = {
            at: Date.now(),
            zone: z.display_name,
            line1: three.line1,
            line2: three.line2 || "",
            line3: three.line3 || "",
            image_key: np.image_key || null,
            length: np.length || 0
        };
        this.history.unshift(entry);
        if (this.history.length > HISTORY_MAX) this.history.length = HISTORY_MAX;
        this.emit("history", entry);
        clearTimeout(this.history_timer);
        this.history_timer = setTimeout(() => {
            const tmp = HISTORY_FILE + ".tmp";
            try {
                fs.writeFileSync(tmp, JSON.stringify(this.history));
                fs.renameSync(tmp, HISTORY_FILE);
            } catch (e) { log.warn("history: save failed:", e.message); }
        }, 5000);
    }

    get_history(limit) {
        return this.history.slice(0, Math.min(limit || 50, HISTORY_MAX));
    }

    pause_all() {
        this._need();
        return new Promise((res, rej) => this.transport.pause_all(this._cb(res, rej)));
    }

    set_client_count(n) {
        this.clients = n;
        this._set_status();
    }

    _set_status() {
        if (this.core) this.status_text = `Connected to ${this.core.display_name}. ${this.clients} open client${this.clients === 1 ? "" : "s"}.`;
        else if (this.was_connected) this.status_text = "Reconnecting to the Roon Core…";
        this.svc_status.set_status(this.status_text, false);
    }

    core_info() {
        return this.core
            ? { connected: true, name: this.core.display_name, version: this.core.display_version }
            : { connected: false, message: this.status_text };
    }

    zone_list() {
        return Object.keys(this.zones).map(k => this.zones[k]).sort((a, b) => a.display_name.localeCompare(b.display_name));
    }

    _need() {
        if (!this.core) { const e = new Error("Not connected to Roon"); e.code = "no_core"; throw e; }
    }

    // ---- transport ----

    _cb(resolve, reject) {
        return (err, body) => err ? reject(new Error(String(err))) : resolve(body || {});
    }

    control(zone_id, control) {
        this._need();
        return new Promise((res, rej) => this.transport.control(zone_id, control, this._cb(res, rej)));
    }

    seek(zone_id, how, seconds) {
        this._need();
        return new Promise((res, rej) => this.transport.seek(zone_id, how, seconds, this._cb(res, rej)));
    }

    change_volume(output_id, how, value) {
        this._need();
        return new Promise((res, rej) => this.transport.change_volume(output_id, how, value, this._cb(res, rej)));
    }

    mute(output_id, how) {
        this._need();
        return new Promise((res, rej) => this.transport.mute(output_id, how, this._cb(res, rej)));
    }

    change_settings(zone_id, settings) {
        this._need();
        const allowed = {};
        ["shuffle", "auto_radio", "loop"].forEach(k => { if (k in settings) allowed[k] = settings[k]; });
        return new Promise((res, rej) => this.transport.change_settings(zone_id, allowed, this._cb(res, rej)));
    }

    transfer_zone(from_id, to_id) {
        this._need();
        return new Promise((res, rej) => this.transport.transfer_zone(from_id, to_id, this._cb(res, rej)));
    }

    group_outputs(output_ids) {
        this._need();
        return new Promise((res, rej) => this.transport.group_outputs(output_ids, this._cb(res, rej)));
    }

    ungroup_outputs(output_ids) {
        this._need();
        return new Promise((res, rej) => this.transport.ungroup_outputs(output_ids, this._cb(res, rej)));
    }

    standby(output_id, control_key) {
        this._need();
        const opts = control_key ? { control_key: control_key } : {};
        return new Promise((res, rej) => this.transport.standby(output_id, opts, this._cb(res, rej)));
    }

    // Powers a device on and switches it to Roon's input (Roon's "convenience switch").
    convenience_switch(output_id, control_key) {
        this._need();
        const opts = control_key ? { control_key: control_key } : {};
        return new Promise((res, rej) => this.transport.convenience_switch(output_id, opts, this._cb(res, rej)));
    }

    play_from_here(zone_id, queue_item_id) {
        this._need();
        return new Promise((res, rej) => this.transport.play_from_here(zone_id, queue_item_id, this._cb(res, rej)));
    }

    // Keeps a full copy of the queue so clients always get the whole list.
    subscribe_queue(zone_id, cb) {
        this._need();
        let items = [];
        const sub = this.transport.subscribe_queue(zone_id, QUEUE_MAX, (response, msg) => {
            if (response === "Subscribed") items = msg.items || [];
            else if (response === "Changed") {
                (msg.changes || []).forEach(c => {
                    if (c.operation === "remove") items.splice(c.index, c.count);
                    else if (c.operation === "insert") items.splice.apply(items, [c.index, 0].concat(c.items));
                });
            } else return;
            cb(items);
        });
        return () => { try { sub.unsubscribe(); } catch (e) { /* core gone */ } };
    }

    // ---- browse ----

    // One browse session per client so people browsing on different devices
    // don't move each other's place in the hierarchy.
    browse(opts) {
        this._need();
        const req = {
            hierarchy: opts.hierarchy,
            multi_session_key: opts.session
        };
        ["item_key", "input", "zone_or_output_id", "pop_all", "pop_levels", "refresh_list", "set_display_offset"].forEach(k => {
            if (opts[k] !== undefined && opts[k] !== null) req[k] = opts[k];
        });
        return new Promise((res, rej) => this.browser.browse(req, this._cb(res, rej))).then(result => {
            if (result.action !== "list") return { result: result };
            return this.load({ hierarchy: opts.hierarchy, session: opts.session, offset: 0, count: opts.count || 100 })
                .then(page => ({ result: result, page: page }));
        });
    }

    load(opts) {
        this._need();
        const req = {
            hierarchy: opts.hierarchy,
            multi_session_key: opts.session,
            offset: opts.offset || 0,
            count: Math.min(opts.count || 100, 500)
        };
        if (opts.level !== undefined) req.level = opts.level;
        return new Promise((res, rej) => this.browser.load(req, this._cb(res, rej)));
    }

    // Opens a page reached by titles from a hierarchy's root, e.g.
    // browse > Library > Tracks. Steps that don't exist stop the walk.
    async browse_path(opts) {
        let r = await this.browse({ hierarchy: opts.hierarchy, session: opts.session, pop_all: true, zone_or_output_id: opts.zone_or_output_id, count: 200 });
        for (const step of opts.path) {
            const items = (r.page && r.page.items) || [];
            const it = items.find(x => x.title === step);
            if (!it) { const e = new Error(`"${step}" isn't available`); e.code = "no_path"; throw e; }
            r = await this.browse({ hierarchy: opts.hierarchy, session: opts.session, item_key: it.item_key, zone_or_output_id: opts.zone_or_output_id, count: opts.count || 100 });
        }
        return r;
    }

    // Index of the first item at or after a letter in an alphabetical list,
    // by binary search over single-item loads. "#" is digits and symbols.
    async find_letter(opts) {
        const key = title => {
            const t = String(title || "").replace(/^the\s+/i, "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
            const m = /[A-Za-z0-9]/.exec(t);
            const c = m ? m[0].toUpperCase() : "#";
            return c >= "A" && c <= "Z" ? c : "#";
        };
        const target = opts.letter === "#" ? "#" : String(opts.letter).toUpperCase();
        if (target === "#") return 0;
        let lo = 0, hi = opts.total;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            const page = await this.load({ hierarchy: opts.hierarchy, session: opts.session, offset: mid, count: 1, level: opts.level });
            const t = page.items && page.items[0] ? page.items[0].title : "";
            if (key(t) < target) lo = mid + 1; else hi = mid;
        }
        return lo;
    }

    // ---- images ----

    static image_size(n) {
        n = parseInt(n, 10) || 240;
        for (const s of IMAGE_SIZES) if (n <= s) return s;
        return IMAGE_SIZES[IMAGE_SIZES.length - 1];
    }

    get_image(key, size) {
        const ck = key + "@" + size;
        const hit = this.images.get(ck);
        if (hit) return Promise.resolve(hit);
        // Many tiles ask for the same image at once; fetch it once.
        if (this.image_waiters.has(ck)) return this.image_waiters.get(ck);
        this._need();
        const p = new Promise((resolve, reject) => {
            this.image.get_image(key, { scale: "fit", width: size, height: size, format: "image/jpeg" }, (err, type, body) => {
                if (err) return reject(new Error(String(err)));
                const v = { type: type, body: Buffer.from(body) };
                this.images.set(ck, v);
                resolve(v);
            });
        });
        this.image_waiters.set(ck, p);
        const done = () => this.image_waiters.delete(ck);
        p.then(done, done);
        return p;
    }
}

module.exports = Roon;
