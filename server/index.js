"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const zlib = require("zlib");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");
const config = require("./config");
const log = require("./log");
const auth = require("./auth");
const Roon = require("./roon");

const WEB = path.join(__dirname, "..", "web");
const TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".webmanifest": "application/manifest+json"
};

// Static files are small: load them once, with an ETag and a gzipped copy.
function load_static(file) {
    const body = fs.readFileSync(path.join(WEB, file));
    const type = TYPES[path.extname(file)] || "application/octet-stream";
    const etag = '"' + crypto.createHash("sha1").update(body).digest("hex").slice(0, 16) + '"';
    const gz = /^(text|application\/(javascript|json|manifest))/.test(type) || type.indexOf("svg") >= 0 ? zlib.gzipSync(body, { level: 9 }) : null;
    return { body, gz, type, etag };
}

const APP_FILES = { "/": "index.html", "/app.js": "app.js", "/app.css": "app.css" };
const PUBLIC_FILES = {
    "/link": "link.html",
    "/link/icon-180.png": "icon-180.png",
    "/link/icon-192.png": "icon-192.png",
    "/link/icon-512.png": "icon-512.png",
    "/link/manifest.webmanifest": "manifest.webmanifest"
};
const files = {};
Object.keys(APP_FILES).concat(Object.keys(PUBLIC_FILES)).forEach(u => {
    files[u] = load_static(APP_FILES[u] || PUBLIC_FILES[u]);
});

function send_static(req, res, f) {
    const headers = {
        "Content-Type": f.type,
        "ETag": f.etag,
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff",
        "Vary": "Accept-Encoding"
    };
    if (req.headers["if-none-match"] === f.etag) { res.writeHead(304, headers); return res.end(); }
    if (f.gz && /\bgzip\b/.test(req.headers["accept-encoding"] || "")) {
        headers["Content-Encoding"] = "gzip";
        res.writeHead(200, headers);
        return res.end(f.gz);
    }
    res.writeHead(200, headers);
    res.end(f.body);
}

function json(res, status, obj, extra) {
    const body = JSON.stringify(obj);
    res.writeHead(status, Object.assign({ "Content-Type": "application/json", "Cache-Control": "no-store" }, extra || {}));
    res.end(body);
}

function read_body(req, limit) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on("data", c => {
            size += c.length;
            if (size > (limit || 16384)) { reject(new Error("too large")); req.destroy(); return; }
            chunks.push(c);
        });
        req.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            try { resolve(text ? JSON.parse(text) : {}); } catch (e) { reject(new Error("bad json")); }
        });
        req.on("error", reject);
    });
}

const roon = new Roon();

async function handle(req, res) {
    const url = new URL(req.url, "http://x");
    const p = url.pathname;

    if (p === "/healthz") {
        const stalled = roon.stalled();
        return json(res, stalled ? 503 : 200, { ok: !stalled, core: roon.core_info().connected });
    }

    // ---- public: pairing ----
    if (PUBLIC_FILES[p] && req.method === "GET") {
        if (p === "/link" && auth.identify(req)) { res.writeHead(302, { Location: "/" }); return res.end(); }
        return send_static(req, res, files[p]);
    }
    if (p === "/link/claim" || p === "/link/restore") {
        if (req.method !== "POST" || !auth.origin_ok(req)) return json(res, 403, { error: "Forbidden" });
        if (!auth.from_proxy(req)) return json(res, 403, { error: "Forbidden" });
        let body;
        try { body = await read_body(req, 2048); } catch (e) { return json(res, 400, { error: "Bad request" }); }
        if (p === "/link/claim") {
            const r = auth.claim(body.code, body.name, req.headers["user-agent"]);
            if (r.error) return json(res, 400, { error: r.error });
            return json(res, 200, { ok: true, token: r.token, name: r.device.name }, { "Set-Cookie": auth.cookie_header(r.token, 10 * 365 * 86400) });
        }
        const d = auth.restore(body.token);
        if (!d) return json(res, 400, { error: "This device is no longer paired." });
        return json(res, 200, { ok: true, name: d.name }, { "Set-Cookie": auth.cookie_header(String(body.token), 10 * 365 * 86400) });
    }
    if (p === "/link/forget") {
        res.writeHead(302, { Location: "/", "Set-Cookie": auth.cookie_header("", 0) });
        return res.end();
    }

    // ---- everything else needs a signed-in person or a paired device ----
    const who = auth.identify(req);
    if (!who) {
        if (req.method === "GET" && APP_FILES[p]) { res.writeHead(302, { Location: "/link" }); return res.end(); }
        return json(res, 401, { error: "Not signed in" });
    }

    if (APP_FILES[p] && req.method === "GET") return send_static(req, res, files[p]);

    if (p.indexOf("/img/") === 0 && req.method === "GET") {
        const key = decodeURIComponent(p.slice(5));
        if (!/^[A-Za-z0-9_\-.:]{1,200}$/.test(key)) return json(res, 400, { error: "Bad image key" });
        try {
            const img = await roon.get_image(key, Roon.image_size(url.searchParams.get("s")));
            res.writeHead(200, {
                "Content-Type": img.type,
                "Content-Length": img.body.length,
                "Cache-Control": "private, max-age=31536000, immutable"
            });
            return res.end(img.body);
        } catch (e) {
            return json(res, e.code === "no_core" ? 503 : 404, { error: e.message });
        }
    }

    if (p === "/api/me") {
        return json(res, 200, {
            kind: who.kind,
            name: who.kind === "device" ? who.device.name : who.user,
            can_manage: who.kind === "user"
        });
    }

    // Pairing and device management: people only, never a paired device.
    if (p === "/api/pair" || p.indexOf("/api/devices") === 0) {
        if (who.kind !== "user") return json(res, 403, { error: who.kind === "device" ? "Paired devices can't manage pairing." : "Pairing is only used behind a proxy login." });
        if (req.method !== "GET" && !auth.origin_ok(req)) return json(res, 403, { error: "Forbidden" });
        if (p === "/api/pair" && req.method === "POST") return json(res, 200, auth.new_code(who.user));
        if (p === "/api/pair" && req.method === "DELETE") { auth.cancel_code(); return json(res, 200, { ok: true }); }
        if (p === "/api/devices" && req.method === "GET") return json(res, 200, { devices: auth.list() });
        const m = /^\/api\/devices\/([0-9a-f]{12})$/.exec(p);
        if (m && req.method === "DELETE") return json(res, auth.revoke(m[1]) ? 200 : 404, { ok: true });
        if (m && req.method === "PATCH") {
            let body;
            try { body = await read_body(req, 1024); } catch (e) { return json(res, 400, { error: "Bad request" }); }
            return json(res, auth.rename(m[1], body.name) ? 200 : 404, { ok: true });
        }
    }

    json(res, 404, { error: "Not found" });
}

const server = http.createServer((req, res) => {
    handle(req, res).catch(e => {
        log.error("http:", req.method, req.url, e.stack || e);
        if (!res.headersSent) json(res, 500, { error: "Server error" });
        else res.end();
    });
});

// ---- WebSocket: live state and commands ----

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
const clients = new Set();

server.on("upgrade", (req, socket, head) => {
    const p = new URL(req.url, "http://x").pathname;
    const who = auth.identify(req);
    if (p !== "/ws" || !who || !auth.origin_ok(req)) {
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, ws => {
        ws.who = who;
        wss.emit("connection", ws, req);
    });
});

function send(ws, obj) {
    if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function broadcast(obj) {
    const msg = JSON.stringify(obj);
    clients.forEach(c => { if (c.ws.readyState === 1) c.ws.send(msg); });
}

roon.on("zones", zones => broadcast({ ev: "zones", zones: zones }));
roon.on("seek", seeks => broadcast({ ev: "seek", seeks: seeks }));
roon.on("history", entry => broadcast({ ev: "history", entry: entry }));
roon.on("core", info => {
    broadcast({ ev: "core", core: info });
    // Queue subscriptions die with the core; ask clients to resubscribe.
    clients.forEach(c => { if (c.queue_unsub) { c.queue_unsub = null; c.queue_zone = null; } });
});

const ZONE_CONTROLS = ["play", "pause", "playpause", "stop", "previous", "next"];

function str(v, max) {
    if (typeof v !== "string" || !v || v.length > (max || 200)) throw new Error("bad argument");
    return v;
}

const ops = {
    hello(c, m) {
        if (typeof m.session === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(m.session)) c.session = m.session;
        return { core: roon.core_info(), zones: roon.zone_list(), session: c.session };
    },
    control(c, m) {
        if (ZONE_CONTROLS.indexOf(m.control) < 0) throw new Error("bad control");
        return roon.control(str(m.zone_id), m.control);
    },
    seek(c, m) {
        const how = m.how === "relative" ? "relative" : "absolute";
        return roon.seek(str(m.zone_id), how, Number(m.seconds) || 0);
    },
    volume(c, m) {
        const how = ["absolute", "relative", "relative_step"].indexOf(m.how) >= 0 ? m.how : "absolute";
        return roon.change_volume(str(m.output_id), how, Number(m.value) || 0);
    },
    mute(c, m) {
        return roon.mute(str(m.output_id), m.how === "unmute" ? "unmute" : "mute");
    },
    settings(c, m) {
        return roon.change_settings(str(m.zone_id), m.settings || {});
    },
    transfer(c, m) {
        return roon.transfer_zone(str(m.from), str(m.to));
    },
    group(c, m) {
        if (!Array.isArray(m.output_ids) || m.output_ids.length < 2) throw new Error("bad outputs");
        return roon.group_outputs(m.output_ids.map(x => str(x)));
    },
    ungroup(c, m) {
        if (!Array.isArray(m.output_ids) || !m.output_ids.length) throw new Error("bad outputs");
        return roon.ungroup_outputs(m.output_ids.map(x => str(x)));
    },
    standby(c, m) {
        return roon.standby(str(m.output_id), m.control_key ? str(m.control_key) : undefined);
    },
    power_on(c, m) {
        return roon.convenience_switch(str(m.output_id), m.control_key ? str(m.control_key) : undefined);
    },
    pause_all() {
        return roon.pause_all();
    },
    history(c, m) {
        return { items: roon.get_history(Number(m.limit) || 50) };
    },
    browse(c, m) {
        return roon.browse({
            session: m.aux ? c.session + "-aux" : c.session,
            hierarchy: str(m.hierarchy, 40),
            item_key: m.item_key,
            input: typeof m.input === "string" ? m.input.slice(0, 200) : undefined,
            zone_or_output_id: m.zone_id,
            pop_all: m.pop_all ? true : undefined,
            pop_levels: m.pop_levels ? Number(m.pop_levels) : undefined,
            refresh_list: m.refresh_list ? true : undefined,
            count: m.count
        });
    },
    browse_path(c, m) {
        if (!Array.isArray(m.path) || m.path.length > 6) throw new Error("bad path");
        return roon.browse_path({ session: c.session, hierarchy: str(m.hierarchy, 40), path: m.path.map(x => str(x)), zone_or_output_id: m.zone_id, count: m.count });
    },
    jump(c, m) {
        if (!/^[A-Z#]$/.test(m.letter || "")) throw new Error("bad letter");
        return roon.find_letter({ session: c.session, hierarchy: str(m.hierarchy, 40), level: m.level, total: Math.max(0, Number(m.total) || 0), letter: m.letter })
            .then(offset => ({ offset: offset }));
    },
    load(c, m) {
        return roon.load({ session: c.session, hierarchy: str(m.hierarchy, 40), offset: Number(m.offset) || 0, count: Number(m.count) || 100, level: m.level });
    },
    queue(c, m) {
        if (c.queue_unsub) { c.queue_unsub(); c.queue_unsub = null; c.queue_zone = null; }
        if (!m.zone_id) return {};
        const zone_id = str(m.zone_id);
        c.queue_zone = zone_id;
        c.queue_unsub = roon.subscribe_queue(zone_id, items => {
            if (c.queue_zone === zone_id) send(c.ws, { ev: "queue", zone_id: zone_id, items: items });
        });
        return {};
    },
    play_from_here(c, m) {
        return roon.play_from_here(str(m.zone_id), Number(m.queue_item_id));
    }
};

wss.on("connection", ws => {
    const c = { ws: ws, session: crypto.randomBytes(8).toString("hex"), queue_unsub: null, queue_zone: null, alive: true };
    clients.add(c);
    roon.set_client_count(clients.size);
    log.debug(`ws: open (${ws.who.kind}), ${clients.size} clients`);

    ws.on("pong", () => { c.alive = true; });
    ws.on("message", data => {
        let m;
        try { m = JSON.parse(data); } catch (e) { return; }
        const op = ops[m.op];
        if (!op) return send(ws, { re: m.id, error: "unknown op" });
        Promise.resolve().then(() => op(c, m)).then(
            r => send(ws, { re: m.id, ok: true, data: r === undefined ? {} : r }),
            e => {
                log.debug("ws op failed:", m.op, e.message);
                send(ws, { re: m.id, error: e.message || "failed" });
            }
        );
    });
    ws.on("close", () => {
        if (c.queue_unsub) c.queue_unsub();
        clients.delete(c);
        roon.set_client_count(clients.size);
    });
});

// Drop dead sockets (tablets that went to sleep) so queue subscriptions don't pile up.
setInterval(() => {
    clients.forEach(c => {
        if (!c.alive) { c.ws.terminate(); return; }
        c.alive = false;
        try { c.ws.ping(); } catch (e) { /* closing */ }
    });
}, 25000);

server.listen(config.port, () => {
    log.info(`needle listening on :${config.port} (auth: ${config.auth_mode}${config.proxy_secret ? ", proxy secret set" : ""})`);
    roon.start();
});

function shutdown() {
    log.info("shutting down");
    server.close();
    clients.forEach(c => c.ws.close());
    setTimeout(() => process.exit(0), 500).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
