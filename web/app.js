/* Needle client. ES5 only: it has to run on iOS 9 Safari (no fetch, no
   arrow functions, no let/const, no template strings). */
(function () {
    "use strict";

    // ------------------------------------------------------------ helpers

    function $(id) { return document.getElementById(id); }
    function el(tag, cls, text) {
        var e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text !== undefined && text !== null) e.textContent = text;
        return e;
    }
    function icon(name) { return el("span", "ic ic-" + name); }
    function store(k, v) {
        try {
            if (v === undefined) return window.localStorage.getItem("needle." + k);
            if (v === null) window.localStorage.removeItem("needle." + k);
            else window.localStorage.setItem("needle." + k, v);
        } catch (e) { /* private mode */ }
        return null;
    }
    function fmt_time(s) {
        s = Math.max(0, Math.floor(s || 0));
        var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
        var mm = h ? (m < 10 ? "0" + m : "" + m) : "" + m;
        return (h ? h + ":" : "") + mm + ":" + (sec < 10 ? "0" + sec : sec);
    }
    function rand_id(n) {
        var c = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", s = "";
        for (var i = 0; i < n; i++) s += c.charAt(Math.floor(Math.random() * c.length));
        return s;
    }
    function img_url(key, size) {
        var dpr = window.devicePixelRatio || 1;
        return "/img/" + encodeURIComponent(key) + "?s=" + Math.round(size * dpr);
    }
    function set_art(node, key, size) {
        if (key) {
            node.style.backgroundImage = "url(\"" + img_url(key, size) + "\")";
            node.className = node.className.replace(/\s*\bph\b/g, "");
        } else {
            node.style.backgroundImage = "";
            if (!/\bph\b/.test(node.className)) node.className += " ph";
        }
    }
    function toggle_class(node, cls, on) {
        var has = (" " + node.className + " ").indexOf(" " + cls + " ") >= 0;
        if (on && !has) node.className += " " + cls;
        else if (!on && has) node.className = (" " + node.className + " ").replace(" " + cls + " ", " ").replace(/^\s+|\s+$/g, "");
    }
    function xhr(method, url, body, cb) {
        var x = new XMLHttpRequest();
        x.open(method, url, true);
        x.setRequestHeader("Content-Type", "application/json");
        x.onreadystatechange = function () {
            if (x.readyState !== 4) return;
            var data = null;
            try { data = JSON.parse(x.responseText); } catch (e) { /* not json */ }
            cb(x.status >= 200 && x.status < 300 ? null : ((data && data.error) || ("HTTP " + x.status)), data);
        };
        x.send(body ? JSON.stringify(body) : null);
    }

    var toast_timer = null;
    function toast(msg) {
        var t = $("toast");
        t.textContent = msg;
        toggle_class(t, "show", true);
        clearTimeout(toast_timer);
        toast_timer = setTimeout(function () { toggle_class(t, "show", false); }, 2600);
    }

    // ------------------------------------------------------------ theme

    function apply_theme() {
        var t = store("theme") || "dark";
        var light = t === "light" || (t === "auto" && window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches);
        toggle_class(document.documentElement, "light", light);
    }
    apply_theme();

    // ------------------------------------------------------------ socket

    var session = store("session");
    if (!session) { session = rand_id(20); store("session", session); }

    var ws = null, ws_ok = false, req_id = 0, pending = {}, retry_ms = 500, retry_timer = null;
    var on_open_hooks = [];

    function connect() {
        clearTimeout(retry_timer);
        if (ws) return;   // already open or connecting
        var proto = location.protocol === "https:" ? "wss://" : "ws://";
        try { ws = new WebSocket(proto + location.host + "/ws"); } catch (e) { schedule_reconnect(); return; }
        ws.onopen = function () {
            ws_ok = true;
            retry_ms = 500;
            call("hello", { session: session }, function (err, d) {
                if (err) return;
                set_core(d.core);
                set_zones(d.zones);
                for (var i = 0; i < on_open_hooks.length; i++) on_open_hooks[i]();
            });
        };
        ws.onmessage = function (ev) {
            var m;
            try { m = JSON.parse(ev.data); } catch (e) { return; }
            if (m.re !== undefined) {
                var cb = pending[m.re];
                delete pending[m.re];
                if (cb) cb(m.error || null, m.data);
                return;
            }
            if (m.ev === "zones") set_zones(m.zones);
            else if (m.ev === "seek") on_seek(m.seeks);
            else if (m.ev === "queue") on_queue(m.zone_id, m.items);
            else if (m.ev === "history") {
                if (history_items) { history_items.unshift(m.entry); if (history_items.length > 60) history_items.pop(); }
                if (top() && top().home) render_home();
            }
            else if (m.ev === "core") { set_core(m.core); if (m.core.connected) { resubscribe_queue(); reload_page(); } }
        };
        ws.onclose = function () {
            ws_ok = false;
            ws = null;
            for (var k in pending) if (pending.hasOwnProperty(k)) pending[k]("Disconnected");
            pending = {};
            show_offline("Reconnecting…");
            schedule_reconnect();
        };
        ws.onerror = function () { /* onclose follows */ };
    }
    function schedule_reconnect() {
        clearTimeout(retry_timer);
        retry_timer = setTimeout(connect, retry_ms);
        retry_ms = Math.min(retry_ms * 2, 8000);
    }
    function call(op, args, cb) {
        if (!ws || !ws_ok) { if (cb) cb("Not connected"); return; }
        var id = ++req_id;
        var m = args || {};
        m.op = op;
        m.id = id;
        if (cb) pending[id] = cb;
        ws.send(JSON.stringify(m));
    }
    function show_offline(text) {
        if (text) { $("offline-text").textContent = text; toggle_class($("offline"), "show", true); }
        else toggle_class($("offline"), "show", false);
    }

    // Tablets kill sockets while asleep; reconnect as soon as we're visible.
    document.addEventListener("visibilitychange", function () {
        if (!document.hidden && !ws) { retry_ms = 500; connect(); }
    });
    window.addEventListener("pageshow", function () { if (!ws) { retry_ms = 500; connect(); } });

    // ------------------------------------------------------------ core & zones

    var core = { connected: false };
    var zones = {}, zone_order = [];
    var zone_id = store("zone");
    var seek_base = { pos: 0, at: 0 };

    function set_core(c) {
        core = c || { connected: false };
        if (!core.connected) show_offline(core.message || "Roon Core not connected");
        else show_offline(null);
    }

    function set_zones(list) {
        zones = {};
        zone_order = [];
        for (var i = 0; i < (list || []).length; i++) { zones[list[i].zone_id] = list[i]; zone_order.push(list[i].zone_id); }
        if (!zone_id || !zones[zone_id]) {
            // A zone can vanish when outputs are grouped; follow it by output.
            var picked = null;
            if (zone_id && last_outputs.length) {
                for (var j = 0; j < zone_order.length && !picked; j++) {
                    var outs = zones[zone_order[j]].outputs || [];
                    for (var k = 0; k < outs.length; k++) if (last_outputs.indexOf(outs[k].output_id) >= 0) { picked = zone_order[j]; break; }
                }
            }
            if (!picked) for (var p = 0; p < zone_order.length; p++) if (zones[zone_order[p]].state === "playing") { picked = zone_order[p]; break; }
            if (!picked) for (var q = 0; q < zone_order.length; q++) if (zones[zone_order[q]].now_playing) { picked = zone_order[q]; break; }
            if (!picked && zone_order.length) picked = zone_order[0];
            select_zone(picked, true);
        }
        render_zone();
        if (sheet_kind === "zones") render_zone_sheet();
        if (top() && top().home) render_home();
    }

    var last_outputs = [];
    function select_zone(id, quiet) {
        var changed = id !== zone_id;
        zone_id = id;
        if (id) store("zone", id);
        var z = zones[id];
        last_outputs = [];
        if (z) for (var i = 0; i < (z.outputs || []).length; i++) last_outputs.push(z.outputs[i].output_id);
        render_zone();
        if (changed || !quiet) resubscribe_queue();
    }

    function cur_zone() { return zone_id ? zones[zone_id] : null; }

    function on_seek(seeks) {
        for (var i = 0; i < seeks.length; i++) {
            var z = zones[seeks[i].zone_id];
            if (z && z.now_playing) z.now_playing.seek_position = seeks[i].seek_position;
            if (seeks[i].zone_id === zone_id) { seek_base = { pos: seeks[i].seek_position || 0, at: Date.now() }; render_progress(); }
        }
    }

    // ------------------------------------------------------------ now playing rendering

    var last_art_key = null;

    function render_zone() {
        var z = cur_zone();
        $("zone-name").textContent = z ? z.display_name : "No zone";
        $("np-zone-name").textContent = z ? z.display_name : "";
        var np = z && z.now_playing;
        var l1 = "", l2 = "", l3 = "";
        if (np) {
            var three = np.three_line || {}, two = np.two_line || {};
            l1 = three.line1 || two.line1 || (np.one_line && np.one_line.line1) || "";
            l2 = three.line2 || two.line2 || "";
            l3 = three.line3 || "";
        }
        $("bar-line1").textContent = l1 || (z ? "Nothing playing" : "No zones");
        $("bar-line2").textContent = l2;
        $("np-line1").textContent = l1 || "Nothing playing";
        $("np-line2").textContent = l2;
        $("np-line3").textContent = l3;

        var key = np && np.image_key;
        if (key !== last_art_key) {
            last_art_key = key;
            set_art($("bar-art"), key, 54);
            set_art($("np-art"), key, 600);
            $("np-bg").style.backgroundImage = key ? "url(\"" + img_url(key, 120) + "\")" : "";
        }

        var playing = z && z.state === "playing";
        var btns = document.querySelectorAll(".play-btn .ic");
        for (var i = 0; i < btns.length; i++) btns[i].className = "ic " + (playing ? "ic-pause" : "ic-play");

        var ctl = document.querySelectorAll("[data-ctl]");
        for (var c = 0; c < ctl.length; c++) {
            var what = ctl[c].getAttribute("data-ctl");
            var allowed = !z ? false :
                what === "previous" ? z.is_previous_allowed :
                what === "next" ? z.is_next_allowed :
                (z.is_play_allowed || z.is_pause_allowed);
            ctl[c].style.opacity = allowed ? "" : "0.35";
        }

        var s = (z && z.settings) || {};
        toggle_class($("np-shuffle"), "on", !!s.shuffle);
        toggle_class($("np-loop"), "on", s.loop === "loop" || s.loop === "loop_one");
        toggle_class($("np-loop"), "one", s.loop === "loop_one");
        toggle_class($("np-radio"), "on", !!s.auto_radio);

        if (np) seek_base = { pos: np.seek_position || 0, at: Date.now() };
        render_progress();
        render_volume($("bar-volume"), z, false);
        render_volume($("np-volume"), z, true);
        highlight_queue();
    }

    function cur_pos() {
        var z = cur_zone();
        if (!z || !z.now_playing) return 0;
        var p = seek_base.pos;
        if (z.state === "playing") p += (Date.now() - seek_base.at) / 1000;
        var len = z.now_playing.length || 0;
        return len ? Math.min(p, len) : p;
    }

    var seek_drag = false;
    function render_progress() {
        var z = cur_zone();
        var len = (z && z.now_playing && z.now_playing.length) || 0;
        var pos = cur_pos();
        var frac = len ? pos / len : 0;
        $("bar-progress-fill").style.width = (frac * 100).toFixed(2) + "%";
        if (!seek_drag) {
            set_slider($("np-seekbar"), frac);
            $("np-pos").textContent = fmt_time(pos);
        }
        $("np-len").textContent = len ? fmt_time(len) : "";
        toggle_class($("np-seekbar"), "disabled", !(z && z.is_seek_allowed && len));
    }
    setInterval(function () {
        var z = cur_zone();
        if (z && z.state === "playing") render_progress();
    }, 500);

    // ------------------------------------------------------------ sliders

    function set_slider(node, frac) {
        frac = Math.max(0, Math.min(1, frac || 0));
        node.querySelector(".slider-fill").style.width = (frac * 100) + "%";
        node.querySelector(".slider-knob").style.left = (frac * 100) + "%";
    }

    // Calls on_move(frac) while dragging and on_end(frac) on release.
    function bind_slider(node, on_move, on_end) {
        var active = false;
        function frac_at(x) {
            var r = node.getBoundingClientRect();
            return Math.max(0, Math.min(1, (x - r.left) / r.width));
        }
        function point(e) {
            var t = e.touches && e.touches.length ? e.touches[0] : (e.changedTouches && e.changedTouches.length ? e.changedTouches[0] : e);
            return t.clientX;
        }
        function start(e) {
            if (/\bdisabled\b/.test(node.className)) return;
            active = true;
            var f = frac_at(point(e));
            set_slider(node, f);
            on_move(f);
            e.preventDefault();
        }
        function move(e) {
            if (!active) return;
            var f = frac_at(point(e));
            set_slider(node, f);
            on_move(f);
            e.preventDefault();
        }
        function end(e) {
            if (!active) return;
            active = false;
            var f = frac_at(point(e));
            set_slider(node, f);
            on_end(f);
        }
        node.addEventListener("touchstart", start, false);
        node.addEventListener("touchmove", move, false);
        node.addEventListener("touchend", end, false);
        node.addEventListener("touchcancel", end, false);
        node.addEventListener("mousedown", function (e) {
            start(e);
            function mm(ev) { move(ev); }
            function mu(ev) { end(ev); document.removeEventListener("mousemove", mm); document.removeEventListener("mouseup", mu); }
            document.addEventListener("mousemove", mm);
            document.addEventListener("mouseup", mu);
        }, false);
    }

    bind_slider($("np-seekbar"), function (f) {
        seek_drag = true;
        var z = cur_zone();
        var len = (z && z.now_playing && z.now_playing.length) || 0;
        $("np-pos").textContent = fmt_time(f * len);
    }, function (f) {
        var z = cur_zone();
        var len = (z && z.now_playing && z.now_playing.length) || 0;
        seek_drag = false;
        if (!z || !len) return;
        var secs = Math.round(f * len);
        seek_base = { pos: secs, at: Date.now() };
        call("seek", { zone_id: z.zone_id, how: "absolute", seconds: secs }, err_toast);
        render_progress();
    });

    // ------------------------------------------------------------ volume

    // Output ids being dragged right now, with the time of the last local change,
    // so incoming zone updates don't make the knob jump back mid-drag.
    var vol_hold = {};

    function vol_frac(v) {
        if (!v || v.max === v.min) return 0;
        return (v.value - v.min) / (v.max - v.min);
    }
    function vol_label(v) {
        if (!v) return "";
        if (v.type === "db") return (Math.round(v.value * 2) / 2) + " dB";
        return String(Math.round(v.value));
    }

    function volume_control(output, compact) {
        var v = output.volume;
        var wrap = el("div", "volume" + (compact ? "" : " wide"));
        if (!v) return wrap;
        var mute = el("button", "icon-btn vol-btn");
        mute.type = "button";
        mute.appendChild(icon(v.is_muted ? "mute" : "vol"));
        mute.addEventListener("click", function () {
            call("mute", { output_id: output.output_id, how: v.is_muted ? "unmute" : "mute" }, err_toast);
        });
        wrap.appendChild(mute);

        if (v.type === "incremental") {
            var dn = el("button", "icon-btn vol-step", "−"), up = el("button", "icon-btn vol-step", "+");
            dn.type = up.type = "button";
            dn.addEventListener("click", function () { call("volume", { output_id: output.output_id, how: "relative_step", value: -1 }, err_toast); });
            up.addEventListener("click", function () { call("volume", { output_id: output.output_id, how: "relative_step", value: 1 }, err_toast); });
            wrap.appendChild(dn);
            wrap.appendChild(up);
            return wrap;
        }

        var slider = el("div", "slider");
        slider.innerHTML = "<div class=\"slider-track\"><div class=\"slider-fill\"></div></div><div class=\"slider-knob\"></div>";
        var val = el("span", "vol-val", compact ? null : vol_label(v));
        wrap.appendChild(slider);
        if (!compact) wrap.appendChild(val);
        set_slider(slider, vol_frac(v));

        var last_sent = 0, send_timer = null, target = null;
        function to_value(f) {
            var step = v.step || 1;
            return Math.round((v.min + f * (v.max - v.min)) / step) * step;
        }
        function flush() {
            send_timer = null;
            if (target === null) return;
            last_sent = Date.now();
            call("volume", { output_id: output.output_id, how: "absolute", value: target });
            target = null;
        }
        bind_slider(slider, function (f) {
            vol_hold[output.output_id] = Date.now();
            target = to_value(f);
            val.textContent = vol_label({ type: v.type, value: target });
            // Throttle so a drag doesn't flood the Core.
            if (!send_timer) send_timer = setTimeout(flush, Math.max(0, 120 - (Date.now() - last_sent)));
        }, function (f) {
            vol_hold[output.output_id] = Date.now();
            target = to_value(f);
            clearTimeout(send_timer);
            flush();
        });
        wrap.slider = slider;
        wrap.output_id = output.output_id;
        return wrap;
    }

    // The bar and Now Playing show the zone's volume when it has one output;
    // grouped zones get a button that opens the per-output sheet.
    function render_volume(node, z, wide) {
        var outs = (z && z.outputs) || [];
        var key = z ? z.zone_id + "|" + outs.map(function (o) { return o.output_id + ":" + (o.volume ? o.volume.type + o.volume.is_muted : "none"); }).join(",") : "";
        if (node.vkey === key && node.firstChild) {
            // Same controls: just move the slider, unless the user is dragging it.
            if (outs.length === 1 && outs[0].volume && node.firstChild.slider) {
                var held = vol_hold[outs[0].output_id];
                if (!held || Date.now() - held > 1200) {
                    set_slider(node.firstChild.slider, vol_frac(outs[0].volume));
                    var vv = node.firstChild.querySelector(".vol-val");
                    if (vv) vv.textContent = vol_label(outs[0].volume);
                }
            }
            return;
        }
        node.vkey = key;
        node.innerHTML = "";
        if (!z) return;
        if (outs.length === 1) {
            if (outs[0].volume) node.appendChild(volume_control(outs[0], !wide));
        } else if (outs.length > 1) {
            var b = el("button", "pill");
            b.type = "button";
            b.appendChild(icon("vol"));
            b.appendChild(document.createTextNode(outs.length + " outputs"));
            b.addEventListener("click", function () { open_zone_sheet(); });
            node.appendChild(b);
        }
    }

    // ------------------------------------------------------------ transport buttons

    function err_toast(err) { if (err) toast(err); }

    var ctl_btns = document.querySelectorAll("[data-ctl]");
    for (var ci = 0; ci < ctl_btns.length; ci++) {
        ctl_btns[ci].addEventListener("click", function (e) {
            e.stopPropagation();
            var z = cur_zone();
            if (!z) return toast("Pick a zone first");
            call("control", { zone_id: z.zone_id, control: this.getAttribute("data-ctl") }, err_toast);
        });
    }
    $("np-shuffle").addEventListener("click", function () {
        var z = cur_zone(); if (!z) return;
        call("settings", { zone_id: z.zone_id, settings: { shuffle: !(z.settings && z.settings.shuffle) } }, err_toast);
    });
    $("np-loop").addEventListener("click", function () {
        var z = cur_zone(); if (!z) return;
        var cur = (z.settings && z.settings.loop) || "disabled";
        var next = cur === "disabled" ? "loop" : cur === "loop" ? "loop_one" : "disabled";
        call("settings", { zone_id: z.zone_id, settings: { loop: next } }, err_toast);
    });
    $("np-radio").addEventListener("click", function () {
        var z = cur_zone(); if (!z) return;
        call("settings", { zone_id: z.zone_id, settings: { auto_radio: !(z.settings && z.settings.auto_radio) } }, err_toast);
    });

    // ------------------------------------------------------------ now playing view

    var np_open = false;
    function open_np() {
        if (np_open) return;
        np_open = true;
        toggle_class($("np"), "open", true);
        push_state("np");
    }
    function close_np(from_pop) {
        if (!np_open) return;
        np_open = false;
        toggle_class($("np"), "open", false);
        toggle_class($("np"), "queue-open", false);
        if (!from_pop) history_back();
    }
    $("bar-track").addEventListener("click", open_np);
    $("np-close").addEventListener("click", function () { close_np(false); });
    $("np-zone").addEventListener("click", open_zone_sheet);
    $("btn-zone").addEventListener("click", open_zone_sheet);
    $("np-queue-toggle").addEventListener("click", function () {
        var np = $("np");
        if (window.innerWidth <= 900) toggle_class(np, "queue-open", !/\bqueue-open\b/.test(np.className));
        else toggle_class(np, "queue-hidden", !/\bqueue-hidden\b/.test(np.className));
    });

    // ------------------------------------------------------------ queue

    var queue_items = [], queue_zone = null;

    function resubscribe_queue() {
        queue_zone = zone_id;
        queue_items = [];
        render_queue();
        if (zone_id) call("queue", { zone_id: zone_id });
    }
    on_open_hooks.push(resubscribe_queue);

    function on_queue(zid, items) {
        if (zid !== queue_zone) return;
        queue_items = items || [];
        render_queue();
    }

    function render_queue() {
        var list = $("queue-list");
        list.innerHTML = "";
        if (!queue_items.length) { list.appendChild(el("div", "empty", "The queue is empty")); return; }
        var frag = document.createDocumentFragment();
        for (var i = 0; i < queue_items.length; i++) {
            var q = queue_items[i];
            var row = el("div", "row");
            row.setAttribute("data-qid", q.queue_item_id);
            var art = el("div", "art");
            set_art(art, q.image_key, 44);
            row.appendChild(art);
            var txt = el("div", "txt");
            var two = q.two_line || {};
            txt.appendChild(el("div", "t1", two.line1 || (q.one_line && q.one_line.line1) || ""));
            txt.appendChild(el("div", "t2", two.line2 || ""));
            row.appendChild(txt);
            row.appendChild(el("div", "end", q.length ? fmt_time(q.length) : ""));
            row.addEventListener("click", (function (qid) {
                return function () { if (zone_id) call("play_from_here", { zone_id: zone_id, queue_item_id: qid }, err_toast); };
            })(q.queue_item_id));
            frag.appendChild(row);
        }
        list.appendChild(frag);
        highlight_queue();
    }

    // Roon puts the playing track first in the queue.
    function highlight_queue() {
        var rows = $("queue-list").querySelectorAll(".row");
        for (var i = 0; i < rows.length; i++) toggle_class(rows[i], "playing", i === 0 && !!(cur_zone() && cur_zone().now_playing));
    }

    // ------------------------------------------------------------ browse

    // id: stable key for the nav entry; h: Roon hierarchy; path: titles to walk
    // from that hierarchy's root (Tracks only exists under browse > Library).
    var NAV_TOP = [
        { id: "home", title: "Home", icon: "home", home: true },
        { section: "Library" },
        { id: "albums", h: "albums", title: "Albums", icon: "album", jump: true },
        { id: "artists", h: "artists", title: "Artists", icon: "artist", jump: true },
        { id: "tracks", h: "browse", path: ["Library", "Tracks"], title: "Tracks", icon: "note", jump: true },
        { id: "composers", h: "composers", title: "Composers", icon: "composer", jump: true },
        { id: "genres", h: "genres", title: "Genres", icon: "genre" },
        { id: "playlists", h: "playlists", title: "Playlists", icon: "playlist" },
        { id: "radio", h: "internet_radio", title: "Live Radio", icon: "radio" }
    ];
    var NAV_BOTTOM = [
        { section: "More" },
        { id: "browse", h: "browse", title: "Browse", icon: "browse" },
        { id: "roon-settings", h: "browse", path: ["Settings"], title: "Roon Settings", icon: "gear" }
    ];
    // Streaming services found at the top of the Core's browse tree.
    var services = [];
    var NAV_KNOWN = { "Library": 1, "Playlists": 1, "My Live Radio": 1, "Genres": 1, "Settings": 1 };

    function nav_entries() {
        var out = NAV_TOP.slice();
        if (services.length) {
            out.push({ section: "Streaming" });
            for (var i = 0; i < services.length; i++) {
                out.push({ id: "svc-" + services[i], h: "browse", path: [services[i]], title: services[i], icon: "browse" });
                out.push({ id: "svc-fav-" + services[i], h: "browse", path: [services[i], "Your Favorites"], title: "Your Favorites", icon: "heart", sub: true });
            }
        }
        return out.concat(NAV_BOTTOM);
    }
    function nav_by_id(id) {
        var all = nav_entries();
        for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
        return null;
    }

    function load_services() {
        // aux: a separate browse session, so this doesn't move the page being shown.
        call("browse", { hierarchy: "browse", pop_all: true, count: 50, aux: true }, function (err, d) {
            if (err || !d.page) return;
            var found = [];
            for (var i = 0; i < d.page.items.length; i++) {
                var t = d.page.items[i].title;
                if (!NAV_KNOWN[t] && d.page.items[i].hint === "list") found.push(t);
            }
            services = found;
            render_nav();
        });
    }
    on_open_hooks.push(load_services);

    // stack[i] = { hierarchy, title, list, items, total, level, scroll, view, base }
    // items holds a window of the list starting at index base, so a jump to
    // "M" in 8000 albums doesn't have to load everything before it.
    var stack = [];
    var nav_busy = false;
    var root_spec = null;
    var view_pref = {};
    try { view_pref = JSON.parse(store("views") || "{}") || {}; } catch (e) { view_pref = {}; }

    function render_nav() {
        var box = $("nav-items");
        box.innerHTML = "";
        var all = nav_entries();
        for (var i = 0; i < all.length; i++) {
            var n = all[i];
            if (n.section) { box.appendChild(el("div", "nav-section", n.section)); continue; }
            var b = el("button", "nav-link" + (n.sub ? " sub" : "") + (root_spec && root_spec.id === n.id ? " on" : ""));
            b.type = "button";
            b.appendChild(icon(n.icon));
            b.appendChild(document.createTextNode(n.title));
            b.addEventListener("click", (function (spec) {
                return function () { close_nav(); open_root(spec); };
            })(n));
            box.appendChild(b);
        }
    }

    function open_root(spec) {
        if (nav_busy || !spec) return;
        if (spec.home) {
            var d0 = stack.length;
            root_spec = spec;
            store("root", spec.id);
            stack = [{ home: true, title: "Home", list: {}, items: [], total: 0, level: 0, base: 0, scroll: 0 }];
            render_nav();
            render_page(true);
            replace_or_push_root(d0);
            return;
        }
        nav_busy = true;
        function done(err, d) {
            nav_busy = false;
            if (err) return toast(err);
            if (!d.page) return toast((d.result && d.result.message) || "Nothing here");
            var depth = stack.length;
            root_spec = spec;
            stack = [make_page(spec.h, d.page, spec.title)];
            stack[0].jump = !!spec.jump;
            if (spec.id && spec.id !== "search") store("root", spec.id);
            render_nav();
            render_page(true);
            // Keep one history entry for the browse stack so Android back works.
            replace_or_push_root(depth);
        }
        if (spec.path) call("browse_path", { hierarchy: spec.h, path: spec.path, zone_id: zone_id, count: 100 }, done);
        else {
            var args = { hierarchy: spec.h, pop_all: true, zone_id: zone_id, count: 100 };
            if (spec.input !== undefined) args.input = spec.input;
            call("browse", args, done);
        }
    }

    function make_page(hierarchy, page, title) {
        return {
            hierarchy: hierarchy,
            title: title || (page.list && page.list.title) || "",
            list: page.list || {},
            items: page.items || [],
            total: (page.list && page.list.count) || (page.items || []).length,
            level: page.list ? page.list.level : 0,
            base: 0,
            scroll: 0
        };
    }

    function top() { return stack[stack.length - 1]; }

    function open_item(item) {
        var t = top();
        if (!t || nav_busy) return;
        if (item.input_prompt) return prompt_input(item);
        if (item.hint === "action_list") return open_actions(item);
        if (item.hint === "action") return run_action(item, t.level, true);
        if (item.hint === "header") return;
        nav_busy = true;
        t.scroll = $("content").scrollTop;
        call("browse", { hierarchy: t.hierarchy, item_key: item.item_key, zone_id: zone_id, count: 100 }, function (err, d) {
            nav_busy = false;
            if (err) return toast(err);
            handle_result(t, d);
        });
    }

    function handle_result(from, d) {
        var r = d.result || {};
        if (r.action === "list" && d.page) {
            stack.push(make_page(from.hierarchy, d.page));
            push_state("browse");
            render_page(true);
        } else if (r.action === "message") {
            toast(r.message);
        } else if (r.action === "replace_item" && r.item) {
            for (var i = 0; i < from.items.length; i++) if (from.items[i].item_key === r.item.item_key) from.items[i] = r.item;
            render_page(false);
        } else if (r.action === "remove_item" && r.item) {
            from.items = from.items.filter(function (x) { return x.item_key !== r.item.item_key; });
            render_page(false);
        }
    }

    function go_back(from_pop) {
        if (stack.length <= 1 || nav_busy) return false;
        var t = top();
        stack.pop();
        var prev = top();
        render_page(false);
        if (!from_pop) history_back();
        // Move the Core's session back too and refresh the items (their keys
        // belong to the level we left).
        nav_busy = true;
        call("browse", { hierarchy: t.hierarchy, pop_levels: 1, zone_id: zone_id, count: 1 }, function (err) {
            if (err) { nav_busy = false; return; }
            refresh_window(prev, function () { nav_busy = false; });
        });
        return true;
    }

    // Reloads the window a page currently shows, keeping the scroll position.
    function refresh_window(t, cb) {
        var count = Math.max(100, t.items.length);
        call("load", { hierarchy: t.hierarchy, offset: t.base, count: count, level: t.level }, function (err, d) {
            if (cb) cb();
            if (err || !d || !d.items) return;
            t.items = d.items;
            t.list = d.list || t.list;
            t.total = (d.list && d.list.count) || t.total;
            if (top() !== t) return;
            var sc = $("content").scrollTop;
            render_page(false);
            $("content").scrollTop = sc;
        });
    }

    // Brings the Core's session back to the page we're showing, after an
    // action list or a dismissed menu may have left it a level deeper.
    function resync(level, then) {
        var t = top();
        if (!t || t.home) { if (then) then(); return; }
        call("load", { hierarchy: t.hierarchy, offset: 0, count: 1 }, function (err, d) {
            if (err || !d || !d.list) { if (then) then(); return; }
            var extra = d.list.level - level;
            if (extra > 0) call("browse", { hierarchy: t.hierarchy, pop_levels: extra, zone_id: zone_id, count: 1 }, function () { if (then) then(); });
            else if (then) then();
        });
    }

    function reload_page() {
        // After a Core reconnect, item keys are stale: start again from the root.
        var spec = root_spec || nav_by_id(store("root") || "home") || NAV_TOP[0];
        stack = [];
        root_spec = null;
        open_root(spec);
    }

    function load_more() {
        var t = top();
        if (!t || t.home || t.loading || t.base + t.items.length >= t.total) return;
        t.loading = true;
        var page_ref = t;
        call("load", { hierarchy: t.hierarchy, offset: t.base + t.items.length, count: 100, level: t.level }, function (err, d) {
            page_ref.loading = false;
            if (err || !d || !d.items) return;
            if (top() !== page_ref) return;
            var start = page_ref.items.length;
            page_ref.items = page_ref.items.concat(d.items);
            append_items(page_ref, start);
        });
    }

    // After a jump the window starts mid-list; scrolling up fills in earlier items.
    function load_prev() {
        var t = top();
        if (!t || t.home || t.loading || t.base <= 0) return;
        t.loading = true;
        var page_ref = t;
        var from = Math.max(0, t.base - 100);
        call("load", { hierarchy: t.hierarchy, offset: from, count: t.base - from, level: t.level }, function (err, d) {
            page_ref.loading = false;
            if (err || !d || !d.items || top() !== page_ref) return;
            var c = $("content");
            var before = c.scrollHeight, sc = c.scrollTop;
            page_ref.items = d.items.concat(page_ref.items);
            page_ref.base = from;
            render_page(false);
            c.scrollTop = sc + (c.scrollHeight - before);
        });
    }

    function jump_to(letter) {
        var t = top();
        if (!t || t.home || t.jumping) return;
        t.jumping = true;
        call("jump", { hierarchy: t.hierarchy, level: t.level, total: t.total, letter: letter }, function (err, d) {
            if (err) { t.jumping = false; return toast(err); }
            // Start a little before the match so the letter isn't the very first tile.
            var from = Math.max(0, d.offset - 6);
            call("load", { hierarchy: t.hierarchy, offset: from, count: 100, level: t.level }, function (err2, p) {
                t.jumping = false;
                if (err2 || !p || !p.items || top() !== t) return;
                t.items = p.items;
                t.base = from;
                render_page(false);
                var target = $("content").querySelector("[data-idx=\"" + d.offset + "\"]");
                $("content").scrollTop = target ? target.offsetTop - 70 : 0;
                lazy_images();
            });
        });
    }

    // ---- actions (Play Now, Add Next, Queue, Start Radio...)

    function open_actions(item, auto_pick) {
        var t = top();
        nav_busy = true;
        call("browse", { hierarchy: t.hierarchy, item_key: item.item_key, zone_id: zone_id, count: 30 }, function (err, d) {
            nav_busy = false;
            if (err) return toast(err);
            if (!d.page || !d.page.items) return handle_result(t, d);
            var actions = d.page.items.filter(function (a) { return a.hint === "action" || a.hint === "action_list"; });
            if (auto_pick) {
                var pick = null;
                for (var i = 0; i < actions.length && !pick; i++) if (auto_pick.test(actions[i].title)) pick = actions[i];
                if (pick) return run_action(pick, t.level);
            }
            show_action_sheet(item, d.page, actions, t.level);
        });
    }

    // refresh: the action sits on the page itself (a profile, a display
    // setting), so reload the page afterwards to show its new state.
    function run_action(a, back_to_level, refresh) {
        var t = top();
        call("browse", { hierarchy: t.hierarchy, item_key: a.item_key, zone_id: zone_id }, function (err, d) {
            if (err) { toast(err); return resync(back_to_level); }
            var r = (d && d.result) || {};
            if (r.action === "message") toast(r.message);
            else if (r.action === "list" && d.page) {
                // An action that opens a list (rare): show it as a page.
                stack.push(make_page(t.hierarchy, d.page));
                push_state("browse");
                render_page(true);
                return;
            } else if (!refresh) toast(a.title === "Play Now" ? "Playing" : a.title);
            resync(back_to_level, refresh ? function () { refresh_window(t); } : null);
        });
    }

    function show_action_sheet(item, page, actions, level) {
        var box = el("div");
        box.appendChild(el("h3", null, item.title));
        if (item.subtitle) box.appendChild(el("div", "sheet-sub", item.subtitle));
        var z = cur_zone();
        box.appendChild(el("div", "sheet-sub", z ? "On " + z.display_name : "No zone selected"));
        var acted = false;
        for (var i = 0; i < actions.length; i++) {
            var row = el("div", "row");
            row.appendChild(el("div", "txt")).appendChild(el("div", "t1", actions[i].title));
            row.addEventListener("click", (function (a) {
                return function () { acted = true; close_sheet(); run_action(a, level); };
            })(actions[i]));
            box.appendChild(row);
        }
        open_sheet("actions", box, function () { if (!acted) resync(level); });
    }

    function prompt_input(item) {
        var p = item.input_prompt;
        var box = el("div");
        box.appendChild(el("h3", null, p.prompt || item.title));
        var f = el("form", "field");
        var input = el("input");
        input.type = p.is_password ? "password" : "text";
        input.value = p.value || "";
        f.appendChild(input);
        box.appendChild(f);
        var acts = el("div", "sheet-actions");
        var go = el("button", "pill primary", p.action || "OK");
        go.type = "submit";
        acts.appendChild(go);
        box.appendChild(acts);
        function submit(e) {
            if (e) e.preventDefault();
            close_sheet();
            var t = top();
            call("browse", { hierarchy: t.hierarchy, item_key: item.item_key, input: input.value, zone_id: zone_id, count: 100 }, function (err, d) {
                if (err) return toast(err);
                handle_result(t, d);
            });
        }
        f.addEventListener("submit", submit);
        go.addEventListener("click", submit);
        open_sheet("input", box);
        setTimeout(function () { input.focus(); }, 300);
    }

    // ---- page rendering

    // Albums and artists read best as a grid; tracks and menus as rows.
    function default_view(t) {
        var items = t.items, with_art = 0, actionable = 0;
        for (var i = 0; i < items.length; i++) {
            if (items[i].image_key) with_art++;
            if (items[i].hint === "action_list") actionable++;
        }
        if (!items.length) return "rows";
        if (stack.length === 1 && /^(albums|artists|composers)$/.test(t.hierarchy)) return "grid";
        // An artist's or genre's albums under a Play header.
        if (has_play_header(t) && !is_tracklist(t) && with_art > 0) return "grid";
        if (actionable > items.length / 2) return "rows";
        return with_art >= items.length * 0.6 ? "grid" : "rows";
    }

    function view_key(t) { return t.hierarchy + ":" + (t.list.title || ""); }
    function view_of(t) { return t.view || view_pref[view_key(t)] || default_view(t); }

    $("btn-view").addEventListener("click", function () {
        var t = top(); if (!t) return;
        t.view = view_of(t) === "grid" ? "rows" : "grid";
        view_pref[view_key(t)] = t.view;
        store("views", JSON.stringify(view_pref));
        render_page(false);
    });

    // Albums, artists, composers and genres start with a "Play Album" /
    // "Play Artist" row; that row becomes the header's Play buttons.
    function has_play_header(t) {
        var first = t.items[0];
        return !!(stack.length > 1 && first && first.hint === "action_list" && /^Play /.test(first.title || ""));
    }
    // A track list (an album's tracks): mostly action_list rows after the header.
    function is_tracklist(t) {
        var n = 0;
        for (var i = 1; i < t.items.length; i++) if (t.items[i].hint === "action_list") n++;
        return t.items.length > 1 && n >= (t.items.length - 1) / 2;
    }

    function render_page(reset_scroll) {
        var t = top();
        var content = $("content");
        content.innerHTML = "";
        var jb = $("jumpbar");
        if (jb) jb.parentNode.removeChild(jb);
        if (!t) return;
        $("title").textContent = t.title || t.list.title || "";
        toggle_class($("btn-back"), "hidden", stack.length <= 1);
        if (t.home) {
            toggle_class($("main"), "has-jump", false);
            toggle_class($("btn-view"), "hidden", true);
            render_home();
            content.scrollTop = reset_scroll ? 0 : (t.scroll || 0);
            return;
        }
        var jumping = stack.length === 1 && t.jump && t.total > 150;
        toggle_class($("main"), "has-jump", jumping);
        if (jumping) $("main").appendChild(jump_bar());
        var tracks = has_play_header(t) && is_tracklist(t);
        var view = tracks ? "rows" : view_of(t);
        $("btn-view").firstChild.className = "ic " + (view === "grid" ? "ic-list" : "ic-grid");
        toggle_class($("btn-view"), "hidden", tracks);

        if (has_play_header(t)) content.appendChild(play_header(t));
        else if (stack.length > 1 && (t.list.subtitle || t.list.image_key)) content.appendChild(simple_header(t));

        var box = el("div", view === "grid" ? "grid" : "rows");
        box.id = "items";
        content.appendChild(box);
        t.rendered_view = box.className;
        if (!t.items.length) box.appendChild(el("div", "empty", "Nothing here"));
        append_items(t, 0);
        content.scrollTop = reset_scroll ? 0 : (t.scroll || 0);
        lazy_images();
    }

    var LETTERS = "#ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    function jump_bar() {
        var bar = el("div", "jumpbar");
        bar.id = "jumpbar";
        for (var i = 0; i < LETTERS.length; i++) bar.appendChild(el("span", null, LETTERS.charAt(i)));
        // Touch: slide a finger down the bar like the iOS contacts index.
        var last = null;
        function at(y) {
            var r = bar.getBoundingClientRect();
            var i = Math.floor((y - r.top) / r.height * LETTERS.length);
            return LETTERS.charAt(Math.max(0, Math.min(LETTERS.length - 1, i)));
        }
        function pick(e) {
            var t = e.touches && e.touches.length ? e.touches[0] : e;
            var l = at(t.clientY);
            if (l === last) return;
            last = l;
            toast(l === "#" ? "#" : l);
            clearTimeout(bar.timer);
            bar.timer = setTimeout(function () { jump_to(l); }, 180);
            e.preventDefault();
        }
        bar.addEventListener("touchstart", function (e) { last = null; pick(e); }, false);
        bar.addEventListener("touchmove", pick, false);
        bar.addEventListener("click", function (e) { last = null; pick(e); }, false);
        return bar;
    }

    function pill(text, ic, cls, fn) {
        var b = el("button", "pill" + (cls ? " " + cls : ""));
        b.type = "button";
        if (ic) b.appendChild(icon(ic));
        b.appendChild(document.createTextNode(text));
        b.addEventListener("click", fn);
        return b;
    }

    function play_header(t) {
        var h = el("div", "list-head");
        var first = t.items[0];
        var round = /^Play (Artist|Composer)/.test(first.title);
        if (t.list.image_key || !round) {
            var art = el("div", "art");
            if (round) art.style.borderRadius = "50%";
            set_art(art, t.list.image_key, 180);
            h.appendChild(art);
        }
        var tx = el("div", "list-head-text");
        var kind = /^Play (\w+)/.exec(first.title);
        if (kind) tx.appendChild(el("div", "kicker", kind[1]));
        tx.appendChild(el("h2", null, t.list.title));
        if (t.list.subtitle) tx.appendChild(el("div", "sub", t.list.subtitle));
        var acts = el("div", "actions");
        acts.appendChild(pill("Play", "play", "primary", function () { open_actions(first, /^Play Now$/i); }));
        // Roon has no shuffle action: turn the zone's shuffle on, then play.
        acts.appendChild(pill("Shuffle", "shuffle", "", function () {
            var z = cur_zone();
            if (!z) return toast("Pick a zone first");
            call("settings", { zone_id: z.zone_id, settings: { shuffle: true } }, function (err) {
                if (err) return toast(err);
                open_actions(first, /^Play Now$/i);
            });
        }));
        acts.appendChild(pill("Radio", "radio", "", function () { open_actions(first, /^Start Radio$/i); }));
        acts.appendChild(pill("More", "more", "", function () { open_actions(first); }));
        tx.appendChild(acts);
        h.appendChild(tx);
        return h;
    }

    function simple_header(t) {
        var h = el("div", "list-head");
        if (t.list.image_key) {
            var art = el("div", "art");
            set_art(art, t.list.image_key, 180);
            h.appendChild(art);
        }
        var tx = el("div", "list-head-text");
        tx.appendChild(el("h2", null, t.list.title));
        if (t.list.subtitle) tx.appendChild(el("div", "sub", t.list.subtitle));
        h.appendChild(tx);
        return h;
    }

    function append_items(t, start) {
        var box = $("items");
        if (!box) return;
        var grid = /\bgrid\b/.test(box.className);
        var header = has_play_header(t);
        var numbered = header && is_tracklist(t);
        var round = (t.hierarchy === "artists" || t.hierarchy === "composers") && stack.length === 1 || /^(Artists|Composers)$/.test(t.list.title || "");
        var frag = document.createDocumentFragment();
        for (var i = start; i < t.items.length; i++) {
            // The "Play Album" / "Play Artist" row is the header's Play button.
            if (header && i === 0 && t.base === 0) continue;
            var node = grid ? tile(t.items[i], round) : row(t.items[i], numbered);
            node.setAttribute("data-idx", t.base + i);
            frag.appendChild(node);
        }
        var more = $("loading-more");
        if (more) more.parentNode.removeChild(more);
        box.appendChild(frag);
        if (t.base + t.items.length < t.total) {
            var lm = el("div", "loading-more", "Loading…");
            lm.id = "loading-more";
            box.appendChild(lm);
        }
        lazy_images();
    }

    function tile(it, round) {
        var d = el("div", "tile" + (round ? " round" : ""));
        var art = el("div", "art" + (it.image_key ? "" : " ph"));
        if (it.image_key) art.setAttribute("data-img", it.image_key);
        d.appendChild(art);
        d.appendChild(el("div", "t1", it.title));
        if (it.subtitle) d.appendChild(el("div", "t2", it.subtitle));
        d.addEventListener("click", function () { open_item(it); });
        return d;
    }

    function row(it, album) {
        if (it.hint === "header") return el("div", "row header", it.title);
        var r = el("div", "row");
        var title = it.title || "";
        if (album) {
            var m = /^(\d+)\.\s+(.*)$/.exec(title);
            r.appendChild(el("div", "num", m ? m[1] : ""));
            if (m) title = m[2];
        } else if (it.image_key) {
            var art = el("div", "art");
            art.setAttribute("data-img", it.image_key);
            r.appendChild(art);
        }
        var txt = el("div", "txt");
        txt.appendChild(el("div", "t1", title));
        if (it.subtitle) txt.appendChild(el("div", "t2", it.subtitle));
        r.appendChild(txt);
        var end = el("div", "end");
        end.appendChild(icon(it.hint === "list" ? "chev" : it.hint === "action_list" ? "more" : ""));
        if (it.hint !== "list" && it.hint !== "action_list") end.innerHTML = "";
        r.appendChild(end);
        r.addEventListener("click", function () { open_item(it); });
        return r;
    }

    // Load art only for tiles near the viewport; the A5 can't take hundreds at once.
    var lazy_timer = null;
    function lazy_images() {
        clearTimeout(lazy_timer);
        lazy_timer = setTimeout(function () {
            var content = $("content");
            var vh = content.clientHeight;
            var nodes = content.querySelectorAll("[data-img]");
            var top_y = content.getBoundingClientRect().top;
            for (var i = 0; i < nodes.length; i++) {
                var r = nodes[i].getBoundingClientRect();
                if (r.bottom < top_y - 400 || r.top > top_y + vh + 800) continue;
                var key = nodes[i].getAttribute("data-img");
                nodes[i].removeAttribute("data-img");
                var size = Math.max(r.width, 44);
                nodes[i].style.backgroundImage = "url(\"" + img_url(key, size) + "\")";
            }
        }, 60);
    }

    $("content").addEventListener("scroll", function () {
        lazy_images();
        var c = $("content");
        if (c.scrollTop + c.clientHeight > c.scrollHeight - 1200) load_more();
        if (c.scrollTop < 600) load_prev();
    });
    window.addEventListener("resize", lazy_images);

    $("btn-back").addEventListener("click", function () { go_back(false); });

    // ---- home: every zone at a glance, and what played recently

    var history_items = null;

    function time_ago(ms) {
        var s = Math.max(0, (Date.now() - ms) / 1000);
        if (s < 60) return "just now";
        if (s < 3600) return Math.floor(s / 60) + " min ago";
        if (s < 86400) return Math.floor(s / 3600) + " h ago";
        return Math.floor(s / 86400) + " d ago";
    }

    function render_home() {
        var t = top();
        if (!t || !t.home) return;
        var content = $("content");
        var sc = content.scrollTop;
        content.innerHTML = "";
        content.appendChild(el("div", "home-head", "Zones"));
        var cards = el("div", "zone-cards");
        for (var i = 0; i < zone_order.length; i++) cards.appendChild(zone_card(zones[zone_order[i]]));
        if (!zone_order.length) cards.appendChild(el("div", "empty", core.connected ? "No zones" : "Not connected to Roon"));
        content.appendChild(cards);

        content.appendChild(el("div", "home-head", "Recently played"));
        var list = el("div", "rows");
        if (history_items === null) {
            list.appendChild(el("div", "empty", "Loading…"));
            call("history", { limit: 60 }, function (err, d) {
                history_items = err ? [] : d.items;
                render_home();
            });
        } else if (!history_items.length) {
            list.appendChild(el("div", "empty", "Nothing yet. Tracks show up here once they play in any zone."));
        } else {
            for (var h = 0; h < history_items.length; h++) list.appendChild(history_row(history_items[h]));
        }
        content.appendChild(list);
        content.scrollTop = sc;
        lazy_images();
    }

    function zone_card(z) {
        var np = z.now_playing;
        var c = el("div", "zone-card" + (z.zone_id === zone_id ? " on" : ""));
        var art = el("div", "art" + (np && np.image_key ? "" : " ph"));
        if (np && np.image_key) art.setAttribute("data-img", np.image_key);
        c.appendChild(art);
        var tx = el("div", "zc-text");
        tx.appendChild(el("div", "zc-zone", z.display_name));
        var two = (np && np.two_line) || {};
        tx.appendChild(el("div", "t1", two.line1 || (np ? "" : "Idle")));
        tx.appendChild(el("div", "t2", two.line2 || ""));
        c.appendChild(tx);
        if (np) {
            var b = el("button", "icon-btn zc-play");
            b.type = "button";
            b.appendChild(icon(z.state === "playing" ? "pause" : "play"));
            b.addEventListener("click", function (e) {
                e.stopPropagation();
                call("control", { zone_id: z.zone_id, control: "playpause" }, err_toast);
            });
            c.appendChild(b);
        }
        c.addEventListener("click", function () { select_zone(z.zone_id); if (np) open_np(); else render_home(); });
        return c;
    }

    function first_artist(s) { return String(s || "").split(/\s+\/\s+|,\s*/)[0]; }

    function history_row(hi) {
        var r = el("div", "row");
        var art = el("div", "art" + (hi.image_key ? "" : " ph"));
        if (hi.image_key) art.setAttribute("data-img", hi.image_key);
        r.appendChild(art);
        var txt = el("div", "txt");
        txt.appendChild(el("div", "t1", hi.line1));
        txt.appendChild(el("div", "t2", [hi.line2, hi.line3].filter(function (x) { return x; }).join(" · ")));
        r.appendChild(txt);
        r.appendChild(el("div", "end", time_ago(hi.at) + " · " + hi.zone));
        r.addEventListener("click", function () { open_search(hi.line1 + " " + first_artist(hi.line2), "Tracks"); });
        return r;
    }

    // ---- search

    // Searches, then opens one result category (Tracks, Albums, Artists) when asked.
    function open_search(q, prefer) {
        if (nav_busy) return;
        close_np(false);
        nav_busy = true;
        call("browse", { hierarchy: "search", pop_all: true, input: q, zone_id: zone_id, count: 100 }, function (err, d) {
            nav_busy = false;
            if (err) return toast(err);
            if (!d.page) return toast("No results");
            var depth = stack.length;
            root_spec = { id: "search", h: "search", title: "Search: " + q, input: q };
            stack = [make_page("search", d.page, "Search: " + q)];
            render_nav();
            render_page(true);
            replace_or_push_root(depth);
            if (!prefer) return;
            for (var i = 0; i < d.page.items.length; i++) {
                if (d.page.items[i].title === prefer) { open_item(d.page.items[i]); return; }
            }
        });
    }

    $("search-form").addEventListener("submit", function (e) {
        e.preventDefault();
        var q = $("search").value.replace(/^\s+|\s+$/g, "");
        if (!q) return;
        $("search").blur();
        close_nav();
        open_search(q);
    });

    // Now Playing: the artist and album lines lead to their pages.
    $("np-line2").addEventListener("click", function () {
        var a = first_artist($("np-line2").textContent);
        if (a) open_search(a, "Artists");
    });
    $("np-line3").addEventListener("click", function () {
        var al = $("np-line3").textContent;
        if (al) open_search(al, "Albums");
    });

    // Desktop keys: space plays/pauses, "/" jumps to search, Escape closes things.
    document.addEventListener("keydown", function (e) {
        var tag = (e.target && e.target.tagName) || "";
        if (tag === "INPUT" || tag === "TEXTAREA") {
            if (e.keyCode === 27) e.target.blur();
            return;
        }
        if (e.keyCode === 32) {
            e.preventDefault();
            var z = cur_zone();
            if (z) call("control", { zone_id: z.zone_id, control: "playpause" }, err_toast);
        } else if (e.keyCode === 191) {
            e.preventDefault();
            toggle_class(document.body, "nav-open", true);
            $("search").focus();
        } else if (e.keyCode === 27) {
            if (sheet_kind) close_sheet(false);
            else if (np_open) close_np(false);
        }
    });

    // ---- small-screen nav drawer

    function close_nav() { toggle_class(document.body, "nav-open", false); }
    $("btn-menu").addEventListener("click", function () { toggle_class(document.body, "nav-open", true); });
    $("nav-scrim").addEventListener("click", close_nav);

    // ------------------------------------------------------------ history (Android back button)

    var hist_depth = 0, ignore_pop = 0;
    function push_state(kind) {
        hist_depth++;
        try { history.pushState({ needle: kind, d: hist_depth }, ""); } catch (e) { /* old webview */ }
    }
    function history_back() {
        if (hist_depth > 0) { hist_depth--; ignore_pop++; history.back(); }
    }
    function replace_or_push_root() {
        // Opening a new root clears the browse stack's history entries.
        while (hist_depth > (np_open ? 1 : 0) + (sheet_kind ? 1 : 0)) { hist_depth--; ignore_pop++; history.back(); }
    }
    window.addEventListener("popstate", function () {
        if (ignore_pop > 0) { ignore_pop--; return; }
        if (hist_depth > 0) hist_depth--;
        if (sheet_kind) { close_sheet(true); return; }
        if (np_open) { close_np(true); return; }
        go_back(true);
    });

    // ------------------------------------------------------------ sheets

    var sheet_kind = null, sheet_on_close = null;
    function open_sheet(kind, content, on_close) {
        if (sheet_kind) close_sheet();
        sheet_kind = kind;
        sheet_on_close = on_close || null;
        var s = $("sheet");
        s.innerHTML = "";
        s.appendChild(content);
        s.scrollTop = 0;
        toggle_class($("sheet-wrap"), "open", true);
        push_state("sheet");
    }
    function close_sheet(from_pop) {
        if (!sheet_kind) return;
        sheet_kind = null;
        toggle_class($("sheet-wrap"), "open", false);
        var cb = sheet_on_close;
        sheet_on_close = null;
        if (cb) cb();
        if (!from_pop) history_back();
    }
    $("sheet-scrim").addEventListener("click", function () { close_sheet(false); });

    // ---- zones sheet

    function open_zone_sheet() {
        open_sheet("zones", el("div"));
        render_zone_sheet();
    }

    function zone_np_line(z) {
        var np = z.now_playing;
        if (!np) return "Idle";
        var two = np.two_line || {};
        var s = two.line1 || (np.one_line && np.one_line.line1) || "";
        if (two.line2) s += " · " + two.line2;
        return (z.state === "playing" ? "▶ " : z.state === "paused" ? "❚❚ " : "") + s;
    }

    function render_zone_sheet() {
        var box = el("div");
        box.appendChild(el("h3", null, "Zones"));
        for (var i = 0; i < zone_order.length; i++) {
            var z = zones[zone_order[i]];
            var r = el("div", "row check-row" + (z.zone_id === zone_id ? " on" : ""));
            r.appendChild(icon("speaker"));
            var txt = el("div", "txt");
            txt.appendChild(el("div", "t1", z.display_name));
            txt.appendChild(el("div", "t2", zone_np_line(z)));
            r.appendChild(txt);
            r.appendChild(icon("check"));
            r.addEventListener("click", (function (id) {
                return function () { select_zone(id); render_zone_sheet(); };
            })(z.zone_id));
            box.appendChild(r);
            if (z.zone_id === zone_id) {
                for (var o = 0; o < (z.outputs || []).length; o++) {
                    var out = z.outputs[o];
                    var pw = power_row(out);
                    if (pw) box.appendChild(pw);
                    if (!out.volume) continue;
                    var zv = el("div", "zone-vol");
                    if (z.outputs.length > 1) zv.appendChild(el("div", "label", out.display_name));
                    zv.appendChild(volume_control(out, false));
                    box.appendChild(zv);
                }
            }
        }
        if (!zone_order.length) box.appendChild(el("div", "empty", core.connected ? "No zones found" : "Not connected to Roon"));
        var acts = el("div", "sheet-actions");
        acts.appendChild(pill("Pause all zones", "pause", "", function () { call("pause_all", {}, err_toast); }));
        if (cur_zone() && zone_order.length > 1) {
            var tr = el("button", "pill", "Transfer queue…");
            tr.type = "button";
            tr.addEventListener("click", open_transfer_sheet);
            acts.appendChild(tr);
            var gr = el("button", "pill", "Group…");
            gr.type = "button";
            gr.addEventListener("click", open_group_sheet);
            acts.appendChild(gr);
        }
        box.appendChild(acts);
        var s = $("sheet");
        // Keep the slider being dragged: rebuild only when nothing is held.
        for (var k in vol_hold) if (vol_hold.hasOwnProperty(k) && Date.now() - vol_hold[k] < 1200) return;
        var sc = s.scrollTop;
        s.innerHTML = "";
        s.appendChild(box);
        s.scrollTop = sc;
    }

    // Devices Roon can switch (an AV receiver, say). Many report their state as
    // "indeterminate", so offer both directions rather than a toggle.
    function power_row(out) {
        var ctls = (out.source_controls || []).filter(function (sc) { return sc.supports_standby; });
        if (!ctls.length) return null;
        var wrap = el("div", "zone-power");
        ctls.forEach(function (sc) {
            var line = el("div", "zp-line");
            var state = sc.status === "standby" ? "off" : sc.status === "selected" ? "on" : "";
            line.appendChild(el("span", "zp-name", sc.display_name + (state ? " · " + state : "")));
            line.appendChild(pill("Turn on", "power", "small", function () {
                call("power_on", { output_id: out.output_id, control_key: sc.control_key }, function (err) { toast(err || sc.display_name + " on"); });
            }));
            line.appendChild(pill("Standby", "power", "small", function () {
                call("standby", { output_id: out.output_id, control_key: sc.control_key }, function (err) { toast(err || sc.display_name + " standby"); });
            }));
            wrap.appendChild(line);
        });
        return wrap;
    }

    function open_transfer_sheet() {
        var from = cur_zone();
        if (!from) return;
        var box = el("div");
        box.appendChild(el("h3", null, "Transfer queue"));
        box.appendChild(el("div", "sheet-sub", "Move what's playing on " + from.display_name + " to:"));
        for (var i = 0; i < zone_order.length; i++) {
            var z = zones[zone_order[i]];
            if (z.zone_id === from.zone_id) continue;
            var r = el("div", "row");
            r.appendChild(icon("speaker"));
            var txt = el("div", "txt");
            txt.appendChild(el("div", "t1", z.display_name));
            txt.appendChild(el("div", "t2", zone_np_line(z)));
            r.appendChild(txt);
            r.addEventListener("click", (function (to) {
                return function () {
                    close_sheet();
                    call("transfer", { from: from.zone_id, to: to.zone_id }, function (err) {
                        if (err) return toast(err);
                        select_zone(to.zone_id);
                        toast("Moved to " + to.display_name);
                    });
                };
            })(z));
            box.appendChild(r);
        }
        open_sheet("transfer", box);
    }

    function open_group_sheet() {
        var z = cur_zone();
        if (!z) return;
        var outputs = [], seen = {};
        for (var i = 0; i < zone_order.length; i++) {
            var oz = zones[zone_order[i]];
            for (var o = 0; o < (oz.outputs || []).length; o++) {
                var out = oz.outputs[o];
                if (seen[out.output_id]) continue;
                seen[out.output_id] = true;
                outputs.push({ id: out.output_id, name: out.display_name, can_group: out.can_group_with_output_ids || [] });
            }
        }
        var mine = (z.outputs || []).map(function (x) { return x.output_id; });
        var primary = mine[0];
        var allowed = {};
        var p = null;
        for (var a = 0; a < outputs.length; a++) if (outputs[a].id === primary) p = outputs[a];
        (p ? p.can_group : []).forEach(function (id) { allowed[id] = true; });
        allowed[primary] = true;
        var chosen = {};
        mine.forEach(function (id) { chosen[id] = true; });

        var box = el("div");
        box.appendChild(el("h3", null, "Group with " + z.display_name));
        outputs.forEach(function (out) {
            if (!allowed[out.id]) return;
            var r = el("div", "row check-row" + (chosen[out.id] ? " on" : ""));
            r.appendChild(icon("speaker"));
            var txt = el("div", "txt");
            txt.appendChild(el("div", "t1", out.name));
            r.appendChild(txt);
            r.appendChild(icon("check"));
            if (out.id !== primary) r.addEventListener("click", function () {
                chosen[out.id] = !chosen[out.id];
                toggle_class(r, "on", chosen[out.id]);
            });
            box.appendChild(r);
        });
        var acts = el("div", "sheet-actions");
        var save = el("button", "pill primary", "Done");
        save.type = "button";
        save.addEventListener("click", function () {
            var want = [primary];
            Object.keys(chosen).forEach(function (id) { if (chosen[id] && id !== primary) want.push(id); });
            var drop = mine.filter(function (id) { return !chosen[id]; });
            close_sheet();
            function regroup() {
                if (want.length > 1) call("group", { output_ids: want }, err_toast);
            }
            if (drop.length) call("ungroup", { output_ids: drop }, function (err) { if (err) toast(err); regroup(); });
            else regroup();
        });
        acts.appendChild(save);
        box.appendChild(acts);
        open_sheet("group", box);
    }

    // ---- settings sheet

    var me = { kind: "unknown", can_manage: false };
    xhr("GET", "/api/me", null, function (err, d) { if (!err && d) me = d; });

    function open_settings() {
        close_nav();
        var box = el("div");
        box.appendChild(el("h3", null, "Settings"));
        box.appendChild(el("div", "sheet-sub", me.kind === "device" ? "This device: " + me.name : me.name ? "Signed in as " + me.name : ""));

        box.appendChild(el("div", "sheet-sub", "Theme"));
        var seg = el("div", "seg");
        var theme = store("theme") || "dark";
        ["dark", "light", "auto"].forEach(function (t) {
            var b = el("button", t === theme ? "on" : "", t.charAt(0).toUpperCase() + t.slice(1));
            b.type = "button";
            b.addEventListener("click", function () { store("theme", t); apply_theme(); open_settings(); });
            seg.appendChild(b);
        });
        box.appendChild(seg);

        box.appendChild(el("div", "sheet-sub", "Roon: " + (core.connected ? core.name + " (" + core.version + ")" : (core.message || "not connected"))));

        var acts = el("div", "sheet-actions");
        if (me.can_manage) {
            var pair = el("button", "pill primary", "Pair a device");
            pair.type = "button";
            pair.addEventListener("click", open_pair_sheet);
            acts.appendChild(pair);
            var devs = el("button", "pill", "Paired devices");
            devs.type = "button";
            devs.addEventListener("click", open_devices_sheet);
            acts.appendChild(devs);
        }
        var reload = el("button", "pill", "Reload");
        reload.type = "button";
        reload.addEventListener("click", function () { location.reload(); });
        acts.appendChild(reload);
        box.appendChild(acts);
        open_sheet("settings", box);
    }
    $("btn-settings").addEventListener("click", open_settings);

    function open_pair_sheet() {
        xhr("POST", "/api/pair", {}, function (err, d) {
            if (err) return toast(err);
            var box = el("div");
            box.appendChild(el("h3", null, "Pair a device"));
            box.appendChild(el("div", "sheet-sub", "On the tablet, open " + location.host + "/link and enter this code. It works once and expires in 5 minutes."));
            box.appendChild(el("div", "code-big", d.code.slice(0, 3) + " " + d.code.slice(3)));
            var acts = el("div", "sheet-actions");
            var done = el("button", "pill", "Done");
            done.type = "button";
            done.addEventListener("click", function () { close_sheet(); });
            acts.appendChild(done);
            box.appendChild(acts);
            open_sheet("pair", box, function () { xhr("DELETE", "/api/pair", null, function () {}); });
        });
    }

    function open_devices_sheet() {
        xhr("GET", "/api/devices", null, function (err, d) {
            if (err) return toast(err);
            var box = el("div");
            box.appendChild(el("h3", null, "Paired devices"));
            if (!d.devices.length) box.appendChild(el("div", "empty", "No paired devices"));
            d.devices.forEach(function (dev) {
                var r = el("div", "row");
                var txt = el("div", "txt");
                txt.appendChild(el("div", "t1", dev.name));
                txt.appendChild(el("div", "t2", "Last seen " + new Date(dev.last_seen).toLocaleString() + " · paired by " + (dev.paired_by || "?")));
                r.appendChild(txt);
                var rm = el("button", "pill", "Remove");
                rm.type = "button";
                rm.addEventListener("click", function (e) {
                    e.stopPropagation();
                    if (rm.getAttribute("data-sure")) {
                        xhr("DELETE", "/api/devices/" + dev.id, null, function (err2) {
                            if (err2) return toast(err2);
                            toast(dev.name + " removed");
                            open_devices_sheet();
                        });
                    } else {
                        rm.setAttribute("data-sure", "1");
                        rm.textContent = "Tap to confirm";
                    }
                });
                r.appendChild(rm);
                box.appendChild(r);
            });
            open_sheet("devices", box);
        });
    }

    // ------------------------------------------------------------ start

    render_nav();
    render_zone();
    show_offline("Connecting…");
    on_open_hooks.push(function () { if (!stack.length) reload_page(); });
    connect();
})();
