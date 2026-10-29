"use strict";

const config = require("./config");

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[config.log_level] || LEVELS.info;

function out(level, args) {
    if (LEVELS[level] < threshold) return;
    const line = [new Date().toISOString(), level.toUpperCase()].concat(args).join(" ");
    (level === "error" || level === "warn" ? console.error : console.log)(line);
}

module.exports = {
    debug: (...a) => out("debug", a),
    info: (...a) => out("info", a),
    warn: (...a) => out("warn", a),
    error: (...a) => out("error", a)
};
