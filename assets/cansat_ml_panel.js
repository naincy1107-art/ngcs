/* cansat_ml_panel.js
 * Small read-only panel: shows the classification the CanSat's onboard ML sends in the
 * LAST field (OPTIONAL DATA) of its telemetry packet, e.g.  vegetation|90%
 * It only listens to the "telemetry_update" Socket.IO event. It changes nothing else.
 */
(function () {
  "use strict";

  var STALE_AFTER_MS = 3000;   // no new CanSat packet for this long -> show STALE

  // ---- parsing (pure function, unit-tested) -------------------------------------------
  // Accepts:  vegetation|90%   vegetation|90   vegetation|0.9
  //           FIX=1|R=-1.0|P=-1.6|Y=-110.5|vegetation|90%     (class|number is found anywhere)
  //           FIX=1|ML=OPEN|CONF=92.4                          (keyed form)
  function parseMl(text) {
    if (typeof text !== "string") return null;
    var tokens = text.split("|").map(function (t) { return t.trim(); });

    var kClass = null, kConf = null, m, i;
    for (i = 0; i < tokens.length; i++) {
      if ((m = /^ML=(.+)$/i.exec(tokens[i]))) kClass = m[1].trim();
      if ((m = /^CONF=(\d+(?:\.\d+)?)\s*(%?)$/i.exec(tokens[i]))) kConf = { v: parseFloat(m[1]), pct: m[2] === "%" };
    }
    if (kClass && kConf) return build(kClass, kConf.v, kConf.pct);

    for (i = tokens.length - 1; i >= 1; i--) {
      var n = /^(\d+(?:\.\d+)?)\s*(%?)$/.exec(tokens[i]);
      if (n && /^[A-Za-z][A-Za-z _-]*$/.test(tokens[i - 1])) {
        return build(tokens[i - 1], parseFloat(n[1]), n[2] === "%");
      }
    }
    return null;
  }

  function build(cls, value, hadPercent) {
    var conf = (!hadPercent && value <= 1) ? value * 100 : value;   // 0.9 -> 90 %
    conf = Math.max(0, Math.min(100, conf));
    return { className: cls, confidence: conf };
  }

  if (typeof module !== "undefined" && module.exports) {   // for the test script only
    module.exports = { parseMl: parseMl };
    return;
  }

  // ---- panel ----------------------------------------------------------------------------
  var el = {};
  var lastPacket = -1, lastChangeMs = 0, lastShown = null;

  function byId(id) { return document.getElementById(id); }

  function render(cansat, connected) {
    if (!el.cls) return;
    var raw = (cansat && cansat.optional_data) || "";
    var pc = cansat ? Number(cansat.packet_count) || 0 : 0;

    if (!cansat || !connected || pc <= 0) {
      el.cls.textContent = "--"; el.conf.textContent = "-- %";
      el.status.textContent = "Waiting for CanSat packets";
      el.raw.textContent = "";
      el.led.className = "led";
      return;
    }

    if (pc !== lastPacket) { lastPacket = pc; lastChangeMs = Date.now(); }
    var ml = parseMl(raw);
    el.raw.textContent = "Last field: " + (raw || "(empty)");

    if (!ml) {
      el.cls.textContent = "--"; el.conf.textContent = "-- %";
      el.status.textContent = "Packet " + pc + " has no ML result (expected class|NN%)";
      el.led.className = "led";
      return;
    }

    lastShown = ml;
    el.cls.textContent = ml.className.toUpperCase();
    el.conf.textContent = ml.confidence.toFixed(ml.confidence % 1 === 0 ? 0 : 1) + " %";
    var age = Date.now() - lastChangeMs;
    if (age > STALE_AFTER_MS) {
      el.status.textContent = "STALE - no new packet for " + Math.round(age / 1000) + " s (packet " + pc + ")";
      el.led.className = "led";
    } else {
      el.status.textContent = "Live - packet " + pc;
      el.led.className = "led cyan";
    }
  }

  var lastSnap = null;
  function onSnapshot(snap) {
    lastSnap = snap;
    if (snap) render(snap.cansat, !!snap.cansat_connected);
  }

  function attach() {
    // Re-check staleness once a second even when no packets arrive.
    setInterval(function () { if (lastSnap) render(lastSnap.cansat, !!lastSnap.cansat_connected); }, 1000);

    var tries = 0;
    (function waitForSocket() {
      // Reuse the dashboard's own connection when it exists (global `socket` from script.js).
      var s = null;
      try { s = (typeof socket !== "undefined") ? socket : null; } catch (e) { s = null; }
      if (s && typeof s.on === "function") { s.on("telemetry_update", onSnapshot); return; }
      if (++tries < 20) { setTimeout(waitForSocket, 500); return; }
      // Fallback: own connection, same address logic as script.js.
      if (typeof io !== "undefined") {
        var url = (location.protocol === "file:" || !location.port || location.port !== "5000") ? "http://localhost:5000" : "";
        var own = url ? io(url) : io();
        own.on("telemetry_update", onSnapshot);
      }
    })();
  }

  function init() {
    el.cls = byId("csml-class"); el.conf = byId("csml-conf"); el.status = byId("csml-status");
    el.raw = byId("csml-raw"); el.led = byId("csml-led");
    if (!el.cls) return;      // panel markup not present -> do nothing
    attach();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
