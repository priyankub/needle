"use strict";

const fs = require("fs");
const path = require("path");

function bool(v, dflt) {
    if (v === undefined || v === "") return dflt;
    return /^(1|true|yes|on)$/i.test(v);
}

const data_dir = process.env.DATA_DIR || path.join(__dirname, "..", "data");
fs.mkdirSync(data_dir, { recursive: true });

module.exports = {
    port: parseInt(process.env.PORT || "8080", 10),
    data_dir: data_dir,

    // Roon Core to connect to. Discovery (SOOD multicast) rarely crosses VLANs,
    // so a fixed host is the normal case; leave ROON_HOST empty to discover.
    roon_host: process.env.ROON_HOST || "",
    roon_port: parseInt(process.env.ROON_PORT || "9330", 10),
    extension_id: process.env.EXTENSION_ID || "net.needle.remote",

    // AUTH_MODE=open (default): no login, like Roon itself, where anything on
    //   the LAN can be a remote. ("none" means the same.)
    // AUTH_MODE=proxy: a reverse proxy authenticates people and passes the user
    //   in AUTH_USER_HEADER. Paired devices (wall panels) use a device cookie instead.
    auth_mode: (process.env.AUTH_MODE || "open") === "none" ? "open" : (process.env.AUTH_MODE || "open"),
    auth_user_header: (process.env.AUTH_USER_HEADER || "X-Forwarded-User").toLowerCase(),
    // Value the proxy puts in X-Needle-Auth on the route that runs forward-auth,
    // and blanks on every other route. Empty disables it.
    auth_route_value: process.env.AUTH_ROUTE_VALUE || "forward-auth",

    // When set, requests must carry this value in X-Needle-Proxy, which the proxy
    // sets on every route. Stops other containers on the proxy network from
    // talking to Needle directly with a forged user header.
    proxy_secret: process.env.PROXY_SECRET || "",

    secure_cookies: bool(process.env.SECURE_COOKIES, true),
    // Origins allowed to open the WebSocket and POST, besides the request's own Host.
    extra_origins: (process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean),

    log_level: process.env.LOG_LEVEL || "info"
};
