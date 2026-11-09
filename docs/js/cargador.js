/* Cargador del visor: descarga librerías y datos en paralelo con barra de progreso,
   descomprime los datos binarios y al final arranca js/visor.js. Funciona con doble clic (file://). */
(function () {
  "use strict";
  var bar = document.getElementById("loadbar"), msg = document.getElementById("loadmsg"), pct = document.getElementById("loadpct");
  var LIBS = [
    ["https://cdn.jsdelivr.net/npm/three@0.147.0/build/three.min.js", 620000, "Three.js"],
    ["https://cdn.jsdelivr.net/npm/three@0.147.0/examples/js/controls/OrbitControls.js", 30000, "controles 3D"]
  ];
  var DIR = (window.CFG && window.CFG.datos) || "data/";        // sudamerica.html usa data_sa/
  var DATA = (window.INDICE || []).map(function (d) { return [DIR + d.f, d.b, d.t]; });
  var UNPACK = DATA.reduce(function (s, d) { return s + d[1] * 0.25; }, 0);
  var TOTAL = LIBS.concat(DATA).reduce(function (s, d) { return s + d[1]; }, 0) + UNPACK + 45000;
  var done = 0;
  function progress(w, label) {
    done += w;
    var p = Math.min(100, Math.round(done / TOTAL * 100));
    bar.style.width = p + "%"; pct.textContent = p + " %"; if (label) msg.textContent = label;
  }
  function load(src) {
    return new Promise(function (res, rej) {
      var s = document.createElement("script"); s.src = src; s.async = false;
      s.onload = res; s.onerror = function () { rej(new Error("no se pudo cargar " + src)); };
      document.head.appendChild(s);
    });
  }
  function frame() { return new Promise(function (r) { setTimeout(r, 0); }); }
  // Cualquier error del visor se muestra en la pantalla de carga en vez de quedar oculto
  window.addEventListener("error", function (e) {
    var ld = document.getElementById("loading");
    if (ld && !ld.hidden) { msg.textContent = "Error: " + (e.message || e) + (e.filename ? " (" + e.filename.split("/").pop() + ":" + e.lineno + ")" : ""); bar.style.background = "#f3c05f"; }
  });

  async function inflate(b64) {
    var bin = atob(b64), u = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    var stream = new Blob([u]).stream().pipeThrough(new DecompressionStream("deflate"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  function readField(buf, off, typ, n, S, mult, out) {
    var k, i, v, base;
    if (typ === "i16" || typ === "u16") {
      for (k = 0; k < S; k++) {            // cada paso: n bytes bajos y luego n bytes altos
        var a = new Float32Array(n), lo = off + k * 2 * n, hi = lo + n;
        for (i = 0; i < n; i++) {
          v = buf[lo + i] | (buf[hi + i] << 8);
          if (typ === "i16") { if (v === 32768) { a[i] = NaN; continue; } if (v > 32767) v -= 65536; }
          else if (v === 65535) { a[i] = NaN; continue; }
          a[i] = v * mult;
        }
        out[k] = a;
      }
      return off + 2 * S * n;
    }
    for (k = 0; k < S; k++) {
      var b = new Float32Array(n); base = off + k * n;
      for (i = 0; i < n; i++) {
        v = buf[base + i];
        if (typ === "i8") { if (v === 128) { b[i] = NaN; continue; } if (v > 127) v -= 256; }
        else if (v === 255) { b[i] = NaN; continue; }
        b[i] = v * mult;
      }
      out[k] = b;
    }
    return off + S * n;
  }
  async function unpack(name, p) {
    if (p.json) return p.json;
    if (p.img) return p.img;
    var buf = await inflate(p.b64), m = p.meta;
    if (name === "dem") {
      var n0 = m.lons.length * m.lats.length, z = new Float32Array(n0);
      for (var i = 0; i < n0; i++) z[i] = buf[i] | (buf[n0 + i] << 8);
      return { lons: m.lons, lats: m.lats, z: z, fuente: m.fuente };
    }
    var n = m.lons.length * m.lats.length, S = m.fh.length, off = 0;
    var steps = m.fh.map(function (fh) { return { fh: fh }; });
    m.fields.forEach(function (f) {
      var arrs = new Array(S); off = readField(buf, off, f[1], n, S, f[2], arrs);
      for (var k = 0; k < S; k++) steps[k][f[0]] = arrs[k];
    });
    if (m.levels) { var L = m.levels.length * n; for (var k = 0; k < S; k++) { steps[k].vol = buf.subarray(off, off + L); off += L; } }
    return { model: m.model, t0: m.t0, step_h: m.step_h, lons: m.lons, lats: m.lats, hgt: m.hgt, levels: m.levels,
             plev: m.plev, zlev: m.zlev, fuente: m.fuente, steps: steps };
  }

  (async function () {
    try {
      if (!DATA.length) throw new Error("no hay data/indice.js; ejecuta herramientas\\actualizar_datos.bat");
      if (typeof DecompressionStream === "undefined") throw new Error("este navegador es muy antiguo; usa Chrome, Edge o Firefox actualizados");
      msg.textContent = "Descargando librerías y datos…";
      var libs = (async function () { for (var i = 0; i < LIBS.length; i++) { await load(LIBS[i][0]); progress(LIBS[i][1], LIBS[i][2] + " listo"); } })();
      var data = Promise.all(DATA.map(function (d) { return load(d[0]).then(function () { progress(d[1], d[2] + " descargado"); }); }));
      await Promise.all([libs, data]);
      window.DATOS = {};
      for (var i = 0; i < DATA.length; i++) {
        var name = DATA[i][0].slice(DIR.length).replace(/\.js$/, "");
        msg.textContent = "Preparando " + DATA[i][2] + "…"; await frame();
        window.DATOS[name] = await unpack(name, window.PKG[name]);
        progress(DATA[i][1] * 0.25);
      }
      delete window.PKG;
      msg.textContent = "Construyendo la escena 3D…"; await frame();
      await load("js/visor.js");
      progress(45000);
    } catch (e) {
      msg.textContent = "Error: " + e.message; bar.style.background = "#f3c05f"; console.error(e);
    }
  })();
})();
