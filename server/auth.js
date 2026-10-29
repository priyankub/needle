"use strict";

// Two ways in:
//  - a person the reverse proxy has authenticated (user header, plus the proxy
//    secret when one is configured);
//  - a paired device holding a device cookie. Pairing needs a short-lived code
//    that only an authenticated person can create, so wall panels on browsers
//    too old for the proxy's login page still get in.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const config = require("./config");
const log = require("./log");

const DEVICES_FILE = path.join(config.data_dir, "devices.json");
const COOKIE = "needle_device";
const CODE_TTL_MS = 5 * 60 * 1000;
const CODE_MAX_ATTEMPTS = 5;
const CLAIM_WINDOW_MS = 60 * 1000;
const CLAIM_MAX_PER_WINDOW = 10;
const SEEN_WRITE_MS = 10 * 60 * 1000;

let devices = [];
let pending = null;            // { code, expires, attempts, by }
let claim_times = [];

function hash(token) {
    return crypto.createHash("sha256").update(token).digest("hex");
}

function load() {
    try { devices = JSON.parse(fs.readFileSync(DEVICES_FILE, "utf8")); } catch (e) { devices = []; }
}

function save() {
    const tmp = DEVICES_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(devices, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, DEVICES_FILE);
}

function parse_cookies(header) {
    const out = {};
    (header || "").split(";").forEach(part => {
        const i = part.indexOf("=");
        if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    });
    return out;
}

function safe_equal(a, b) {
    const ab = Buffer.from(String(a)), bb = Buffer.from(String(b));
    return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function from_proxy(req) {
    if (!config.proxy_secret) return true;
    return safe_equal(req.headers["x-needle-proxy"] || "", config.proxy_secret);
}

function device_for(req) {
    const token = parse_cookies(req.headers.cookie)[COOKIE];
    if (!token) return null;
    const h = hash(token);
    const d = devices.find(x => safe_equal(x.hash, h));
    if (!d) return null;
    const now = Date.now();
    if (!d.last_seen || now - d.last_seen > SEEN_WRITE_MS) { d.last_seen = now; save(); }
    return d;
}

// Returns { kind: "user", user } | { kind: "device", device } | { kind: "dev" } | null
function identify(req) {
    if (config.auth_mode === "open") return { kind: "open", user: "" };
    if (!from_proxy(req)) return null;
    const user = req.headers[config.auth_user_header];
    // Forward-auth setups often let trusted networks through without a login,
    // so no user header arrives; the proxy marks the route that passed it instead.
    const passed = config.auth_route_value && req.headers["x-needle-auth"] === config.auth_route_value;
    if (user || passed) return { kind: "user", user: user ? String(user) : "trusted network" };
    const device = device_for(req);
    if (device) return { kind: "device", device: device };
    return null;
}

// Cross-site WebSocket hijacking and CSRF guard: browsers always send Origin on
// WebSocket handshakes and cross-site POSTs.
function origin_ok(req) {
    const origin = req.headers.origin;
    if (!origin) return req.method === "GET";
    let host;
    try { host = new URL(origin).host; } catch (e) { return false; }
    const req_host = req.headers["x-forwarded-host"] || req.headers.host;
    return host === req_host || config.extra_origins.indexOf(origin) >= 0;
}

function cookie_header(token, max_age) {
    const parts = [`${COOKIE}=${token}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${max_age}`];
    if (config.secure_cookies) parts.push("Secure");
    return parts.join("; ");
}

function new_code(by) {
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
    pending = { code: code, expires: Date.now() + CODE_TTL_MS, attempts: 0, by: by };
    log.info(`auth: pairing code created by ${by}`);
    return { code: code, expires_in: CODE_TTL_MS / 1000 };
}

function cancel_code() { pending = null; }

// Returns { token, device } or { error }
function claim(code, name, ua) {
    const now = Date.now();
    claim_times = claim_times.filter(t => now - t < CLAIM_WINDOW_MS);
    if (claim_times.length >= CLAIM_MAX_PER_WINDOW) return { error: "Too many attempts. Wait a minute and try again." };
    claim_times.push(now);

    if (!pending || pending.expires < now) { pending = null; return { error: "No pairing code is active. Create one on a signed-in device." }; }
    if (!safe_equal(String(code || "").replace(/\D/g, ""), pending.code)) {
        pending.attempts++;
        if (pending.attempts >= CODE_MAX_ATTEMPTS) { pending = null; return { error: "Too many wrong codes. Create a new one." }; }
        return { error: "That code isn't right." };
    }
    const by = pending.by;
    pending = null;
    const token = crypto.randomBytes(32).toString("base64url");
    const device = {
        id: crypto.randomBytes(6).toString("hex"),
        name: String(name || "").trim().slice(0, 60) || "Wall panel",
        hash: hash(token),
        created: now,
        last_seen: now,
        paired_by: by,
        ua: String(ua || "").slice(0, 200)
    };
    devices.push(device);
    save();
    log.info(`auth: paired device "${device.name}" (${device.id}), approved by ${by}`);
    return { token: token, device: device };
}

function restore(token) {
    if (!token) return null;
    const h = hash(String(token));
    return devices.find(x => safe_equal(x.hash, h)) || null;
}

function list() {
    return devices.map(d => ({ id: d.id, name: d.name, created: d.created, last_seen: d.last_seen, paired_by: d.paired_by, ua: d.ua }));
}

function revoke(id) {
    const before = devices.length;
    devices = devices.filter(d => d.id !== id);
    if (devices.length !== before) { save(); log.info(`auth: revoked device ${id}`); return true; }
    return false;
}

function rename(id, name) {
    const d = devices.find(x => x.id === id);
    if (!d) return false;
    d.name = String(name || "").trim().slice(0, 60) || d.name;
    save();
    return true;
}

load();

module.exports = {
    COOKIE, identify, origin_ok, from_proxy, cookie_header, new_code, cancel_code, claim, restore, list, revoke, rename
};
