"use strict";
// ---------- Dominio ----------
// index.html: Nor-Oriente (valores por defecto). sudamerica.html define window.CFG antes de cargar.
const CFG = Object.assign({
  id: "nor", titulo: "Visor 3D Nor-Oriente", sub: "Amazonas · Cajamarca · Lambayeque",
  lonc: -78.75, latc: -5.75,
  esc: 1,                     // unidades de escena por km en horizontal (Sudamérica < 1: el continente entra en pantalla)
  exag: 6, exagMin: 1, exagMax: 12, exagPaso: 0.5,
  vnx: 64, vny: 64, nw: 3200, nrain: 7000,
  viento: ["10", "925", "850", "700", "500", "250"], vientoIni: "850",
  avisos: true, pines: "nombres",
  dtMax: 4,                               // escala de ΔT 24 h (°C): en el trópico los cambios típicos son de ±1–2 °C
  isoSlp: 1, isoZ: 10, isoT: 1, isoLargo: 0.05, advR: 2,   // advR: suavizado de la advección (±2 puntos = 5×5)   // isolíneas: cada 1 hPa y 10 m (trópico: gradientes débiles); tramo de ajuste al relieve (°)
  isoRadio: 6, isol: [], abiertos: [], limTxt: "Límites de departamentos",
  otro: {href: "sudamerica.html", txt: "Ver Sudamérica →"}
}, window.CFG || {});
const LS = k => CFG.id === "nor" ? k : CFG.id + "_" + k;     // claves de localStorage por dominio
// ---------- Geometría del dominio (unidades de escena: km × CFG.esc en horizontal, km en vertical) ----------
const KX = 111.32 * Math.cos(CFG.latc * Math.PI / 180) * CFG.esc, KY = 110.57 * CFG.esc, LONC = CFG.lonc, LATC = CFG.latc, ZTOP = 16;
const toX = lon => (lon - LONC) * KX, toZ = lat => -(lat - LATC) * KY;
const fromX = x => x / KX + LONC, fromZ = z => -z / KY + LATC;
let T0 = 0;                                // inicio común: 00Z del día de la corrida más reciente
const SPAN = 144;                          // horas mostradas (6 días)
const LAPSE = 0.0065;
const DIAS = ["Dom","Lun","Mar","Mié","Jue","Vie","Sáb"];
const MESES = ["ene","feb","mar","abr","may","jun","jul","ago","set","oct","nov","dic"];
const $ = id => document.getElementById(id);

let DEM, MODELS = {}, PUNTOS = [], model = "GFS", colorMode = "relieve", windLevel = CFG.vientoIni;
let hours = 0, playing = false, scrubbing = false, exag = CFG.exag, selected = null, luzMode = "clara", pinMode = "nombres";

// ---------- Utilidades de interpolación ----------
function makeSampler(lons, lats, qlon, qlat) {         // pesos bilineales precalculados
  const nx = lons.length, ny = lats.length, n = qlon.length;
  const dl = lons[1] - lons[0], da = lats[1] - lats[0];
  const idx = new Int32Array(n * 4), w = new Float32Array(n * 4);
  for (let k = 0; k < n; k++) {
    let fx = (qlon[k] - lons[0]) / dl, fy = (qlat[k] - lats[0]) / da;
    fx = Math.max(0, Math.min(nx - 1.0001, fx)); fy = Math.max(0, Math.min(ny - 1.0001, fy));
    const i = Math.floor(fx), j = Math.floor(fy), a = fx - i, b = fy - j;
    idx.set([j*nx+i, j*nx+i+1, (j+1)*nx+i, (j+1)*nx+i+1], k*4);
    w.set([(1-a)*(1-b), a*(1-b), (1-a)*b, a*b], k*4);
  }
  return {n, idx, w};
}
function applySampler(s, arr, scale, out) {
  out = out || new Float32Array(s.n);
  if (!arr) { out.fill(NaN); return out; }
  for (let k = 0, q = 0; k < s.n; k++, q += 4) {
    let sum = 0, ws = 0;
    for (let m = 0; m < 4; m++) { const v = arr[s.idx[q+m]]; if (v != null && v === v) { sum += v * s.w[q+m]; ws += s.w[q+m]; } }
    out[k] = ws > 0 ? sum / ws * scale : NaN;
  }
  return out;
}
function bil(lons, lats, arr, lon, lat, scale = 1) {
  if (!arr) return NaN;
  const nx = lons.length, ny = lats.length;
  let fx = (lon - lons[0]) / (lons[1] - lons[0]), fy = (lat - lats[0]) / (lats[1] - lats[0]);
  fx = fx < 0 ? 0 : fx > nx - 1.0001 ? nx - 1.0001 : fx; fy = fy < 0 ? 0 : fy > ny - 1.0001 ? ny - 1.0001 : fy;
  const i = fx | 0, j = fy | 0, a = fx - i, b = fy - j, k = j * nx + i;
  const v0 = arr[k], v1 = arr[k+1], v2 = arr[k+nx], v3 = arr[k+nx+1];
  let s = 0, w = 0, ww;
  if (v0 != null && v0 === v0) { ww = (1-a)*(1-b); s += v0*ww; w += ww; }
  if (v1 != null && v1 === v1) { ww = a*(1-b); s += v1*ww; w += ww; }
  if (v2 != null && v2 === v2) { ww = (1-a)*b; s += v2*ww; w += ww; }
  if (v3 != null && v3 === v3) { ww = a*b; s += v3*ww; w += ww; }
  return w > 0 ? s / w * scale : NaN;
}
function demAt(lon, lat) { return bil(DEM.lons, DEM.lats, DEM.z, lon, lat) / 1000; }   // km

// ---------- Tiempo de cada modelo ----------
function prepModel(m) {
  const t0 = Date.parse(m.t0.replace("Z", ":00Z"));
  m.abs = m.steps.map(s => (t0 - T0) / 3.6e6 + s.fh);
  m.intv = m.abs.map((h, k) => k === 0 ? m.step_h : h - m.abs[k-1]);
  if (m.levels) m.steps.forEach(s => { if (s.vol || !s.c3d) return; const b = atob(s.c3d); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); s.vol = u; });
  m.volCache = new Map();
}
function bracket(m, h) {
  const a = m.abs; if (h <= a[0]) return [0, 0, 0];
  for (let k = 0; k < a.length - 1; k++) if (h < a[k+1]) return [k, k+1, (h - a[k]) / (a[k+1] - a[k])];
  return [a.length-1, a.length-1, 0];
}
function rainStep(m, h) {                      // paso cuyo intervalo (t[k-1], t[k]] contiene h
  const a = m.abs; for (let k = 1; k < a.length; k++) if (h <= a[k]) return k; return a.length - 1;
}

// ---------- Escena ----------
const renderer = new THREE.WebGLRenderer({antialias: true, powerPreference: "high-performance"});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1));
renderer.setSize(innerWidth, innerHeight);
$("scene").appendChild(renderer.domElement);
const scene = new THREE.Scene();
// niebla solo en el horizonte lejano (mar exterior): el dominio nunca se opaca, ni con la cámara en su distancia máxima
scene.fog = new THREE.Fog(0x0b1118, 4500, 7500);
let DOM_W = 600, DOM_D = 600;                // ancho y fondo del dominio en la escena (se fijan al armar el relieve)
const camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 5, 9000);   // near 5: más precisión de profundidad
camera.position.set(-260, 420, 520);
const controls = new THREE.OrbitControls(camera, renderer.domElement);
controls.target.set(0, 10, 0); controls.enableDamping = true; controls.maxPolarAngle = Math.PI * 0.49;
controls.minDistance = 40; controls.maxDistance = 3000;
// izquierdo: girar · medio y derecho: desplazar como una mano sobre el mapa · rueda: acercar · flechas: desplazar
controls.mouseButtons = {LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN};
controls.screenSpacePanning = false;        // desplaza sobre el plano del terreno, no hacia arriba/abajo
controls.panSpeed = 1.2; controls.keyPanSpeed = 25;
controls.listenToKeyEvents(window);
// Barra de navegación (pensada para celular: sin clic derecho ni rueda)
{
  // pantalla vertical (celular): la cámara empieza más lejos para que entre todo el ancho del dominio
  if (innerWidth < innerHeight) camera.position.sub(controls.target).multiplyScalar(Math.min(1.45, 0.7 * innerHeight / innerWidth)).add(controls.target);
  const CAM0 = camera.position.clone(), TGT0 = controls.target.clone();
  let mover = false, plano = false, cam3d = null;
  const aplicaModo = () => {
    if (plano) {                               // planta: un dedo / clic izquierdo mueve, dos dedos acercan y mueven; sin giro
      controls.touches = {ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_PAN};
      controls.mouseButtons = {LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN};
      $("bModo").disabled = true; $("bModo").style.opacity = .35; return;
    }
    $("bModo").disabled = false; $("bModo").style.opacity = "";
    // un dedo / clic izquierdo: girar o mover; dos dedos: pellizcar para acercar y además mover (o girar en modo mover)
    controls.touches = {ONE: mover ? THREE.TOUCH.PAN : THREE.TOUCH.ROTATE, TWO: mover ? THREE.TOUCH.DOLLY_ROTATE : THREE.TOUCH.DOLLY_PAN};
    controls.mouseButtons = {LEFT: mover ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: mover ? THREE.MOUSE.ROTATE : THREE.MOUSE.PAN};
    $("bModo").setAttribute("aria-pressed", mover); $("bModoT").textContent = mover ? "Mover ✓" : "Mover";
    $("bModo").title = mover ? "Un dedo mueve el mapa (toca para volver a girar)" : "Un dedo gira el mapa (toca para mover)";
  };
  const aplicaPanel = vis => { document.body.classList.toggle("sinPanel", !vis); $("bPanel").setAttribute("aria-pressed", vis); try { localStorage.setItem("panelVis", vis ? "1" : "0"); } catch (e) {} };
  const zoom = f => {                          // acerca (f < 1) o aleja (f > 1) hacia el centro de la vista
    const off = camera.position.clone().sub(controls.target);
    const d = Math.max(controls.minDistance, Math.min(controls.maxDistance, off.length() * f));
    camera.position.copy(controls.target).add(off.setLength(d)); controls.update();
  };
  // vista en planta: cámara vertical sobre el centro del dominio, norte arriba, encuadrando todo el dominio
  // encuadra el dominio en el espacio libre de la pantalla (sin el panel, la barra ni la línea de tiempo)
  const encuadrePlano = () => {
    const Wp = innerWidth, Hp = innerHeight; let l = 0, r = Wp, t = 0, b = Hp;
    for (const id of ["layers", "nav", "timeline"]) {
      const el = $(id); if (!el || el.hidden || getComputedStyle(el).display === "none") continue;
      const q = el.getBoundingClientRect(); if (!q.width) continue;
      if (q.width > Wp * 0.6) { if ((q.top + q.bottom) / 2 > Hp / 2) b = Math.min(b, q.top); else t = Math.max(t, q.bottom); }
      else if ((q.left + q.right) / 2 < Wp / 2) l = Math.max(l, q.right); else r = Math.min(r, q.left);
    }
    l += 10; r -= 10; t += 10; b -= 10;
    if (r - l < Wp * 0.3 || b - t < Hp * 0.3) { l = 0; r = Wp; t = 0; b = Hp; }    // si queda muy poco espacio, toda la pantalla
    const f = Math.tan(camera.fov * Math.PI / 360);
    const d = Math.min(controls.maxDistance, Math.max(DOM_D * Hp / (2 * f * (b - t)), DOM_W * Hp / (2 * f * (r - l))) + ZTOP);
    const k = 2 * d * f / Hp;                  // unidades de escena por píxel en el plano del terreno
    const cx = -((l + r) / 2 - Wp / 2) * k, cz = -((t + b) / 2 - Hp / 2) * k;   // corre el centro del dominio al centro del espacio libre
    controls.target.set(cx, 0, cz); camera.position.set(cx, d, cz + 0.01); controls.update();
  };
  // Planta con "teleobjetivo": ángulo de 8° y cámara ~5,5 veces más lejos. Con 42° lo alto (campo en altura, sus límites)
  // se corría hacia afuera del centro respecto de lo de abajo (paralaje); así el mapa se ve igual de grande pero el
  // corrimiento por altura es ~5,5 veces menor. Distancias, recorte y niebla se escalan con el mismo factor.
  const FOV3D = camera.fov, FOVP = 8, KP = Math.tan(FOV3D * Math.PI / 360) / Math.tan(FOVP * Math.PI / 360);
  const lente = on => {
    const k = on ? KP : 1;
    camera.fov = on ? FOVP : FOV3D; camera.near = 5 * k; camera.far = 9000 * k; camera.updateProjectionMatrix();
    controls.minDistance = 40 * k; controls.maxDistance = 3000 * k; scene.fog.near = 4500 * k; scene.fog.far = 7500 * k;
  };
  const aplicaPlano = on => {
    if (on === plano) return;
    plano = on;
    if (on) {
      cam3d = {p: camera.position.clone(), t: controls.target.clone()};
      lente(true);
      controls.minPolarAngle = 0; controls.maxPolarAngle = 0; controls.enableRotate = false; encuadrePlano();
    } else {
      lente(false);
      controls.minPolarAngle = 0; controls.maxPolarAngle = Math.PI * 0.49; controls.enableRotate = true;
      if (cam3d) { camera.position.copy(cam3d.p); controls.target.copy(cam3d.t); } controls.update();
    }
    $("bPlano").setAttribute("aria-pressed", on); $("bPlanoT").textContent = on ? "Volver a 3D" : "Planta";
    $("bPlano").title = on ? "Volver a la vista 3D" : "Vista en planta (2D, norte arriba): el mapa solo se mueve y acerca, no gira";
    aplicaModo();
  };
  $("bPlano").onclick = () => aplicaPlano(!plano);
  window.vistaPlano = aplicaPlano;             // el visor abre en planta; con el enlace index.html#3d abre en 3D
  $("bModo").onclick = () => { mover = !mover; aplicaModo(); };
  $("bPanel").onclick = () => { aplicaPanel(document.body.classList.contains("sinPanel")); if (plano) encuadrePlano(); };
  $("bZin").onclick = () => zoom(0.75); $("bZout").onclick = () => zoom(1 / 0.75);
  $("bHome").onclick = () => { if (plano) return encuadrePlano(); camera.position.copy(CAM0); controls.target.copy(TGT0); controls.update(); };
  let pv = null; try { pv = localStorage.getItem("panelVis"); } catch (e) {}
  aplicaPanel(pv === null ? innerWidth > 760 : pv === "1");    // en celular empieza con el panel oculto
  aplicaModo();
}
{
  const el = renderer.domElement;
  el.style.cursor = "grab";
  el.addEventListener("pointerdown", e => { el.style.cursor = e.button === 0 ? "move" : "grabbing"; });
  addEventListener("pointerup", () => { el.style.cursor = "grab"; });
  el.addEventListener("mousedown", e => { if (e.button === 1) e.preventDefault(); });   // sin autodesplazamiento de Chrome
  el.addEventListener("auxclick", e => { if (e.button === 1) e.preventDefault(); });
  el.addEventListener("contextmenu", e => e.preventDefault());
}
const world = new THREE.Group(); scene.add(world);          // en km; escala Y = exageración
const hemi = new THREE.HemisphereLight(0xbfd8ff, 0x2a2016, 0.5); scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff2dc, 1.0); scene.add(sun);

let terrain, terrColors, terrBase, terrLon, terrLat, terrZ, cloudMesh, cloudMat, volTexA, volTexB, hmapTex;
const VNX = CFG.vnx, VNY = CFG.vny, VNZ = 48;

function buildTerrain() {
  const nx = DEM.lons.length, ny = DEM.lats.length, n = nx * ny;
  const pos = new Float32Array(n * 3); terrColors = new Float32Array(n * 3); terrBase = new Float32Array(n * 3);
  terrLon = new Float32Array(n); terrLat = new Float32Array(n); terrZ = new Float32Array(n);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i, z = DEM.z[k] / 1000;
    terrLon[k] = DEM.lons[i]; terrLat[k] = DEM.lats[j]; terrZ[k] = z;
    pos[k*3] = toX(DEM.lons[i]); pos[k*3+1] = z; pos[k*3+2] = toZ(DEM.lats[j]);
    const c = DEM.z[k] <= 0 ? WATER : hypso(DEM.z[k]); terrBase.set(c, k*3);
  }
  const index = [];
  for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    // z = -lat, así que (a, b, c) y (b, d, c) dejan la cara frontal mirando hacia arriba (+y)
    const a = j*nx+i, b = a+1, c = a+nx, d = c+1; index.push(a, b, c, b, d, c);
  }
  const uv = new Float32Array(n * 2);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const k = j * nx + i; uv[k*2] = i / (nx - 1); uv[k*2+1] = j / (ny - 1); }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.BufferAttribute(terrColors, 3));
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  g.setIndex(index); g.computeVertexNormals();
  terrain = new THREE.Mesh(g, new THREE.MeshLambertMaterial({vertexColors: true}));
  world.add(terrain);
  // mar
  const sea = new THREE.Mesh(new THREE.PlaneGeometry(16000, 16000), new THREE.MeshLambertMaterial({color: 0x12324a}));
  // el mar exterior va bien por debajo del terreno (que sobre el océano está a 0 m) para que no se peleen por la profundidad
  sea.rotation.x = -Math.PI / 2; sea.position.y = -0.4; world.add(sea);
  // borde del dominio
  const W = toX(DEM.lons[nx-1]) - toX(DEM.lons[0]), D = toZ(DEM.lats[0]) - toZ(DEM.lats[ny-1]);
  DOM_W = W; DOM_D = D;
  const edge = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(W, ZTOP, D)), new THREE.LineBasicMaterial({color: 0x2b3b4c, transparent: true, opacity: .45}));
  edge.position.y = ZTOP / 2; world.add(edge);
  // mapa de alturas para las nubes
  const hm = new Uint8Array(n); for (let k = 0; k < n; k++) hm[k] = Math.min(255, Math.round(DEM.z[k] / 7000 * 255));
  hmapTex = new THREE.DataTexture(hm, nx, ny, THREE.RedFormat, THREE.UnsignedByteType);
  hmapTex.magFilter = hmapTex.minFilter = THREE.LinearFilter; hmapTex.needsUpdate = true;
  buildClouds(W, D);
  buildHum(W, D);
}

// ---------- Imagen satelital (NASA Blue Marble, dominio público) ----------
let satTex = null, terrSat = null;
function loadSatellite(uri) {
  const img = new Image();
  img.onload = () => {
    satTex = new THREE.Texture(img); satTex.anisotropy = renderer.capabilities.getMaxAnisotropy(); satTex.needsUpdate = true;
    // color por vértice muestreado de la imagen: base de los modos lluvia y CAPE
    const cv = document.createElement("canvas"); cv.width = img.width; cv.height = img.height;
    const cx = cv.getContext("2d"); cx.drawImage(img, 0, 0);
    const px = cx.getImageData(0, 0, img.width, img.height).data, nx = DEM.lons.length, ny = DEM.lats.length;
    terrSat = new Float32Array(nx * ny * 3);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const x = Math.round(i / (nx - 1) * (img.width - 1)), y = Math.round((1 - j / (ny - 1)) * (img.height - 1)), o = (y * img.width + x) * 4, k = (j * nx + i) * 3;
      terrSat[k] = px[o] / 255; terrSat[k+1] = px[o+1] / 255; terrSat[k+2] = px[o+2] / 255;
    }
    lastTerrKey = ""; drawLegend();
  };
  img.src = uri;
}

// ---------- Paletas ----------
const ramp = stops => v => {
  if (v <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) if (v <= stops[i][0]) {
    const [a, ca] = stops[i-1], [b, cb] = stops[i], t = (v - a) / (b - a);
    return [ca[0]+(cb[0]-ca[0])*t, ca[1]+(cb[1]-ca[1])*t, ca[2]+(cb[2]-ca[2])*t];
  }
  return stops[stops.length-1][1];
};
const hx = h => [parseInt(h.slice(1,3),16)/255, parseInt(h.slice(3,5),16)/255, parseInt(h.slice(5,7),16)/255];
const WATER = hx("#163a55");
const hypso = ramp([[0,hx("#c9b98f")],[150,hx("#b8a77a")],[400,hx("#5f7f4a")],[1000,hx("#4d7140")],[1800,hx("#7d8450")],[2600,hx("#8f7a58")],[3400,hx("#7c6656")],[4200,hx("#9a8f86")],[5200,hx("#e9e6e1")]]);
const PAL = {
  temperatura: {f: ramp([[-4,hx("#5b3fa3")],[2,hx("#3f6fd8")],[8,hx("#38b3d9")],[14,hx("#4cc38a")],[20,hx("#d8d64a")],[26,hx("#f29b38")],[32,hx("#e2452d")],[38,hx("#9c1430")]]), min:-4, max:38, ticks:[-4,5,14,23,32,38], unit:"°C", title:"Temperatura 2 m (corregida por altitud)"},
  lluvia: {f: ramp([[0,[0,0,0]],[0.2,hx("#9cc9f5")],[1,hx("#5aa8ff")],[3,hx("#2f6fe0")],[8,hx("#5b3fd0")],[15,hx("#c040c8")],[30,hx("#ff5aa0")]]), min:0, max:30, ticks:[0,1,3,8,15,30], unit:"mm/3h", title:"Lluvia en 3 h", log:true},
  // agua precipitable: vapor de toda la columna (mm). Selva húmeda 50–65 mm; sierra 10–25; costa seca < 25
  pwat: {f: ramp([[0,hx("#7a4a1e")],[15,hx("#c9a35e")],[25,hx("#e8e2b0")],[35,hx("#8fd18a")],[45,hx("#2fa36b")],[55,hx("#2a78c8")],[65,hx("#5a35b8")],[75,hx("#b03aa8")]]), min:0, max:75, ticks:[0,15,25,35,45,55,65,75], unit:"mm", title:"Agua precipitable (vapor de toda la columna)"},
  cape: {f: ramp([[0,[0,0,0]],[100,hx("#3a6b4a")],[500,hx("#c8c24a")],[1000,hx("#f29b38")],[2000,hx("#e2452d")],[3000,hx("#b0108a")]]), min:0, max:3000, ticks:[0,500,1000,2000,3000], unit:"J/kg", title:"CAPE"},
  relieve: {f: hypso, min:0, max:5200, ticks:[0,1000,2000,3000,4000,5200], unit:"m", title:"Altitud"},
  // cambio de temperatura a 2 m respecto de la misma hora del día anterior (sin ciclo diario): frentes, friajes, calentamientos
  dt24: {f: ramp([[-CFG.dtMax,hx("#1d3f8f")],[-CFG.dtMax*0.6,hx("#3d7fd1")],[-CFG.dtMax*0.25,hx("#9cc7ee")],[0,hx("#e8e8e8")],[CFG.dtMax*0.25,hx("#f6b08a")],[CFG.dtMax*0.6,hx("#e0552f")],[CFG.dtMax,hx("#9c1b1b")]]),
         min: -CFG.dtMax, max: CFG.dtMax, ticks: [-CFG.dtMax, -CFG.dtMax / 2, 0, CFG.dtMax / 2, CFG.dtMax], unit: "°C", title: "Cambio de temperatura en 24 h (ahora − ayer a la misma hora)"},
  viento: {f: ramp([[0,[0,0,0]],[3,hx("#4f7fb8")],[5,hx("#38b3d9")],[8,hx("#4cc38a")],[11,hx("#d8d64a")],[14,hx("#f29b38")],[17,hx("#e2452d")],[22,hx("#b0108a")]]), min:0, max:22, ticks:[0,5,10,15,20], unit:"m/s", title:"Viento medio a 10 m"}
};
let UMB_W = 8, UMB_G = 14;                 // umbrales de aviso de viento a 10 m (m/s), ajustables en el panel
// Tablas de color precalculadas (256 tonos por paleta): evita crear arreglos por vértice en cada cuadro
for (const k in PAL) {
  const p = PAL[k]; p.lut = new Float32Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255, v = p.log ? Math.expm1(t * Math.log1p(p.max)) : p.min + t * (p.max - p.min), c = p.f(v);
    p.lut[i*3] = c[0]; p.lut[i*3+1] = c[1]; p.lut[i*3+2] = c[2];
  }
  const lm = Math.log1p(p.max);
  p.idx = p.log ? v => { const q = Math.round(Math.log1p(v > 0 ? v : 0) / lm * 255); return q > 255 ? 255 : q; }
                : v => { const q = Math.round((v - p.min) / (p.max - p.min) * 255); return q < 0 ? 0 : q > 255 ? 255 : q; };
}
function drawLegend() {
  const cv = $("legendCv");
  if (colorMode === "natural") {
    cv.hidden = true;
    $("legendTicks").innerHTML = `<span>${satTex ? "Imagen NASA Blue Marble (sin nubes, 500 m) · límites geoBoundaries CC BY 4.0" : "Cargando imagen satelital…"}</span>`;
    return;
  }
  cv.hidden = false;
  const p = PAL[colorMode], ctx = cv.getContext("2d");
  const pos = v => p.log ? Math.log1p(v) / Math.log1p(p.max) : (v - p.min) / (p.max - p.min);
  for (let x = 0; x < cv.width; x++) {
    const t = x / (cv.width - 1); let v = p.log ? Math.expm1(t * Math.log1p(p.max)) : p.min + t * (p.max - p.min);
    let c = p.f(v); if (colorMode === "lluvia" && v < 0.2) c = [0.2,0.25,0.3]; if (colorMode === "cape" && v < 100) c = [0.2,0.25,0.3]; if (colorMode === "viento" && v < 10) c = [0.2,0.25,0.3]; if (colorMode === "dt24" && Math.abs(v) < 0.5) c = [0.2,0.25,0.3];
    if (colorMode === "viento" && Math.abs(v - UMB_W) <= (p.max - p.min) / cv.width) c = [1, 1, 1];   // marca del umbral
    ctx.fillStyle = `rgb(${c[0]*255|0},${c[1]*255|0},${c[2]*255|0})`; ctx.fillRect(x, 0, 1, cv.height);
  }
  $("legendTicks").innerHTML = p.ticks.map(t => `<span style="position:relative">${t}</span>`).join("") ;
  if (colorMode === "pwat") $("legendTicks").innerHTML += `<span style="flex-basis:100%;text-align:left">líneas negras con su valor: cada ${PW_ISO[1]} mm desde ${PW_ISO[0]} mm</span>`;
  if (colorMode === "dt24") $("legendTicks").innerHTML += `<span style="flex-basis:100%;text-align:left">azul: más frío que ayer · rojo: más cálido · sin color: cambio menor de 0,5 °C · las primeras 24 h del pronóstico no tienen día anterior</span>`;
  $("legendTicks").title = p.title + " (" + p.unit + ")" + (colorMode === "viento" ? " · línea blanca: umbral de aviso " + UMB_W + " m/s" : "");
}

// ---------- Muestreadores por modelo ----------
function prepSamplers(m) {
  if (m.sTerr) return;
  m.sTerr = makeSampler(m.lons, m.lats, terrLon, terrLat);
  m.hgtTerr = applySampler(m.sTerr, m.hgt, 0.001);
  // columnas del volumen
  const ql = [], qa = [];
  for (let j = 0; j < VNY; j++) for (let i = 0; i < VNX; i++) { ql.push(DEM.lons[0] + (DEM.lons[DEM.lons.length-1]-DEM.lons[0]) * i/(VNX-1)); qa.push(DEM.lats[0] + (DEM.lats[DEM.lats.length-1]-DEM.lats[0]) * j/(VNY-1)); }
  m.sVol = makeSampler(m.lons, m.lats, ql, qa);
  m.volGround = new Float32Array(VNX*VNY); for (let k = 0; k < VNX*VNY; k++) m.volGround[k] = demAt(ql[k], qa[k]);
  // altura real (km) de cada nivel en las columnas del volumen; si falta, atmósfera estándar
  m.zMean = {};
  if (m.plev && m.zlev) m.plev.forEach((p, l) => { const z = (m.zlev[l] || []).filter(v => v != null && v === v); if (z.length) m.zMean[p] = z.reduce((s, v) => s + v, 0) / z.length / 1000; });
  if (m.plev) m.zVol = m.plev.map((p, l) => { const z = applySampler(m.sVol, m.zlev && m.zlev[l], 0.001); for (let c = 0; c < z.length; c++) if (!(z[c] === z[c])) z[c] = pHeight(p); return z; });
  m.volLon = ql; m.volLat = qa;
}

// ---------- Volumen de nubes ----------
const pHeight = p => 44.331 * (1 - Math.pow(p / 1013.25, 0.190263));   // km, atmósfera estándar

// ===== Método común de nubes (el mismo para GFS, ETA y ECMWF) =====
// Entrada por nivel: humedad relativa (%) y velocidad vertical w (m/s, + ascenso), en los mismos 11 niveles.
// La HR llega ya con una definición común (agua sobre 0 °C, hielo bajo 0 °C) desde los extractores.
// Fracción de nube: Sundqvist et al. (1989): cf = 1 - sqrt((1 - HR) / (1 - HRc)), con HRc 80 % (≥700 hPa) a 65 % (≤300 hPa),
// un solo juego de umbrales para los tres modelos, calibrado contra las capas propias de GFS, ETA y ECMWF.
// Densidad: más opaca cuanto más saturada y con ascenso; por encima de 300 hPa (hielo, cirros) más translúcida.
const RHC = p => p >= 700 ? 0.80 : p <= 300 ? 0.65 : 0.65 + 0.15 * (p - 300) / 400;
function diagCloud(rh, w, p) {
  if (!(rh === rh)) return [0, 0];
  const r = Math.min(1, rh / 100), rc = RHC(p);
  if (r <= rc) return [0, 0];
  const cf = 1 - Math.sqrt((1 - r) / (1 - rc));
  const sat = (r - rc) / (1 - rc);
  const up = w === w ? Math.max(0, Math.min(1, w / 0.3)) : 0;      // ascenso ≥ 0.3 m/s: convección marcada
  let dens = 0.25 + 0.5 * sat + 0.35 * up;
  if (p <= 300) dens *= 0.55;
  return [cf, Math.min(1, dens)];
}
// Capas para meteograma y lectura: baja ≥ 700 hPa, media 600–400, alta ≤ 300 (máximo solapamiento)
const banda = p => p >= 700 ? 0 : p >= 400 ? 1 : 2;
function diagLayers(m, getRH, getW) {          // devuelve [baja, media, alta] en %
  const L = [0, 0, 0];
  for (const p of m.plev) { const [cf] = diagCloud(getRH(p), getW(p), p); const b = banda(p); if (cf > L[b]) L[b] = cf; }
  return L.map(v => v * 100);
}

// Volumen de nubes, mismo proceso para los tres modelos:
//   CANTIDAD = nubosidad propia del modelo en cada capa (baja / media / alta);
//   ALTURA y ESPESOR dentro de la capa = niveles más húmedos según la HR por nivel (perfil de Sundqvist);
//   DENSIDAD = saturación y ascenso. Canales: R fracción, G densidad, B capa (0 baja, 128 media, 255 alta).
const CAPA_COD = [0, 128, 255];
function buildVolume(m, k) {
  const key = k; if (m.volCache.has(key)) return m.volCache.get(key);
  const st = m.steps[k], ncol = VNX * VNY, out = new Uint8Array(ncol * VNZ * 4);
  const dz = ZTOP / VNZ;
  if (m.plev && st["rh" + m.plev[0]]) {
    const NL = m.plev.length, P = m.plev, BAND = P.map(banda);
    const N = [applySampler(m.sVol, st.lcc, 0.01), applySampler(m.sVol, st.mcc, 0.01), applySampler(m.sVol, st.hcc, 0.01)];
    const RH = P.map(p => applySampler(m.sVol, st["rh" + p], 1)), WV = P.map(p => applySampler(m.sVol, st["w" + p], 1));
    const CF = new Float32Array(NL), DN = new Float32Array(NL);
    for (let c = 0; c < ncol; c++) {
      const g = m.volGround[c], zl = l => m.zVol[l][c];
      let la = 0; while (la < NL - 1 && zl(la) < g) la++;                 // primer nivel sobre el suelo
      CF.fill(0); DN.fill(0);
      for (let b = 0; b < 3; b++) {
        const amt = N[b][c]; if (!(amt > 0.02)) continue;
        // niveles de esta capa sobre el suelo (si ninguno lo está, el primer nivel sobre el suelo)
        let ls = []; for (let l = 0; l < NL; l++) if (BAND[l] === b && l >= la) ls.push(l);
        if (!ls.length) ls = [la];
        const shape = ls.map(l => diagCloud(RH[l][c], WV[l][c], P[l])[0]);
        let mx = Math.max(...shape);
        if (mx < 0.02) {                                                   // aire poco húmedo: la nube va al nivel más húmedo
          const r = ls.map(l => RH[l][c] || 0), rm = Math.max(...r);
          for (let i = 0; i < ls.length; i++) shape[i] = Math.exp(-Math.pow((rm - r[i]) / 8, 2));
          mx = 1;
        }
        ls.forEach((l, i) => {
          const r = Math.min(1, (RH[l][c] || 0) / 100), up = WV[l][c] === WV[l][c] ? Math.max(0, Math.min(1, WV[l][c] / 0.3)) : 0;
          CF[l] = Math.max(CF[l], amt * shape[i] / mx);
          DN[l] = Math.min(1, 0.35 + 0.4 * Math.max(0, Math.min(1, (r - 0.6) / 0.4)) + 0.35 * up);
        });
      }
      for (let z = 0; z < VNZ; z++) {
        const h = (z + 0.5) * dz; if (h < g || h > zl(NL - 1) + 0.6) continue;
        let l = 0; while (l < NL - 2 && zl(l + 1) < h) l++;
        const l0 = Math.max(l, la), l1 = Math.max(l + 1, la);
        const t = l0 === l1 ? 0 : Math.max(0, Math.min(1, (h - zl(l0)) / (zl(l1) - zl(l0))));
        const cf = CF[l0] * (1 - t) + CF[l1] * t; if (cf < 0.01) continue;
        const o = (z * ncol + c) * 4;
        out[o] = cf * 255; out[o + 1] = (DN[l0] * (1 - t) + DN[l1] * t) * 255;
        out[o + 2] = CAPA_COD[BAND[l0]] * (1 - t) + CAPA_COD[BAND[l1]] * t; out[o + 3] = 255;
      }
    }
  } else {
    const L = applySampler(m.sVol, st.lcc, 1), M = applySampler(m.sVol, st.mcc, 1), H = applySampler(m.sVol, st.hcc, 1);
    const band = (h, a, b, e) => h < a - e || h > b + e ? 0 : h < a ? 1 - (a - h) / e : h > b ? 1 - (h - b) / e : 1;
    for (let c = 0; c < ncol; c++) {
      const g = m.volGround[c];
      const lb = g + 0.15, lt = g < 1 ? Math.max(g + 0.9, 1.4) : Math.max(g + 1.2, 3.2);
      const mb = Math.max(3.6, g + 1.3), mt = 7.2;
      for (let z = 0; z < VNZ; z++) {
        const h = (z + 0.5) * dz;
        const vl = (L[c]||0) * band(h, lb, lt, 0.35), vm = (M[c]||0) * band(h, mb, mt, 0.5), vh = (H[c]||0) * band(h, 8.6, 11.8, 0.6);
        const v = Math.max(vl, vm, vh), cap = v === vh ? 255 : v === vm ? 128 : 0;
        const o = (z * ncol + c) * 4; out[o] = Math.max(0, Math.min(255, v * 2.55)); out[o + 1] = 150; out[o + 2] = cap; out[o + 3] = 255;
      }
    }
  }
  if (m.volCache.size >= 12) m.volCache.delete(m.volCache.keys().next().value);   // tope de memoria
  m.volCache.set(key, out); return out;
}

function buildClouds(W, D) {
  const mk = () => { const t = new THREE.Data3DTexture(new Uint8Array(VNX*VNY*VNZ*4), VNX, VNY, VNZ); t.format = THREE.RGBAFormat; t.type = THREE.UnsignedByteType; t.minFilter = t.magFilter = THREE.LinearFilter; t.unpackAlignment = 1; t.needsUpdate = true; return t; };
  volTexA = mk(); volTexB = mk();
  cloudMat = new THREE.ShaderMaterial({
    uniforms: {volA:{value:volTexA}, volB:{value:volTexB}, mixT:{value:0}, hmap:{value:hmapTex}, hmapMax:{value:7.0},
      boxKm:{value:new THREE.Vector3(W, ZTOP, D)}, sunDir:{value:new THREE.Vector3(0,1,0)}, daylight:{value:1}, sigma:{value:0.7}, windOff:{value:new THREE.Vector2()}, steps:{value:110},
      layerOn:{value:new THREE.Vector3(1, 1, 1)}, highOpac:{value:0.35}},
    vertexShader: `
      varying vec3 vOrigin; varying vec3 vDirection;
      void main(){
        vOrigin = (inverse(modelMatrix) * vec4(cameraPosition, 1.0)).xyz;
        vDirection = position - vOrigin;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      precision highp float; precision highp sampler3D;
      uniform sampler3D volA; uniform sampler3D volB; uniform float mixT;
      uniform sampler2D hmap; uniform float hmapMax; uniform vec3 boxKm; uniform vec3 sunDir;
      uniform float daylight; uniform float sigma; uniform vec2 windOff; uniform float steps;
      uniform vec3 layerOn; uniform float highOpac;
      varying vec3 vOrigin; varying vec3 vDirection;
      vec2 hitBox(vec3 o, vec3 d){ vec3 inv = 1.0/d; vec3 t0 = (vec3(-0.5)-o)*inv, t1 = (vec3(0.5)-o)*inv;
        vec3 mn = min(t0,t1), mx = max(t0,t1); return vec2(max(max(mn.x,mn.y),mn.z), min(min(mx.x,mx.y),mx.z)); }
      float hash(vec3 p){ p = fract(p*0.3183099+0.1); p *= 17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
      float noise(vec3 x){ vec3 i = floor(x), f = fract(x); f = f*f*(3.0-2.0*f);
        return mix(mix(mix(hash(i),hash(i+vec3(1,0,0)),f.x), mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x), f.y),
                   mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x), mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x), f.y), f.z); }
      float fbm(vec3 p){ return 0.55*noise(p) + 0.3*noise(p*2.07) + 0.15*noise(p*4.3); }
      vec3 tc(vec3 p){ return vec3(p.x+0.5, 0.5-p.z, p.y+0.5); }
      vec4 smp(vec3 t){ return mix(texture(volA,t), texture(volB,t), mixT); }        // r fracción, g densidad, b capa
      // visibilidad por capa: baja / media / alta (las altas además con su propia opacidad)
      float capa(float b){ float lo = 1.0 - smoothstep(0.2, 0.3, b), hi = smoothstep(0.7, 0.8, b);
        return dot(vec3(lo, 1.0 - lo - hi, hi), layerOn * vec3(1.0, 1.0, highOpac)); }
      float cov(vec3 t){ vec4 s = smp(t); return s.r * s.g * capa(s.b); }           // para sombras: cuánto tapa
      void main(){
        vec3 dir = normalize(vDirection);
        vec2 b = hitBox(vOrigin, dir); if (b.x > b.y) discard; b.x = max(b.x, 0.0);
        float dt = (b.y - b.x) / steps;
        vec3 p = vOrigin + dir * (b.x + dt * hash(vec3(gl_FragCoord.xy, 1.0)));
        float stepKm = length(dir * dt * boxKm);
        vec4 acc = vec4(0.0);
        vec3 sunT = vec3(sunDir.x, -sunDir.z, sunDir.y);
        for (int i = 0; i < 200; i++) {
          if (float(i) >= steps) break;
          vec3 t = tc(p);
          float gh = texture(hmap, t.xy).r * hmapMax, hk = t.z * boxKm.y;
          if (hk < gh) break;                                           // choca con el relieve
          vec4 v = smp(t); float c = v.x, vis = capa(v.z);
          if (c > 0.06 && vis > 0.01) {
            vec3 km = vec3(t.x*boxKm.x - windOff.x, t.z*boxKm.y*6.0, t.y*boxKm.z - windOff.y);
            float n = fbm(km / 22.0);
            float d = smoothstep(1.0 - c, 1.0 - c + 0.28, n + 0.18*c) * (0.3 + 1.2 * v.y) * vis;
            d *= smoothstep(0.06, 0.25, c);           // coberturas muy bajas: sin motas sueltas que titilan
            d *= smoothstep(gh, gh + 0.4, hk);        // contacto suave con el suelo (neblina sin ruido)
            if (d > 0.002) {
              float a = 1.0 - exp(-d * sigma * stepKm);
              float sh = cov(t + sunT * vec3(0.015, 0.015, 0.06)) + cov(t + sunT * vec3(0.035, 0.035, 0.14));
              float lit = exp(-sh * 1.6);
              float hgt = t.z;
              vec3 base = mix(vec3(0.34,0.38,0.46), vec3(1.0,0.99,0.97), lit);
              base = mix(base, base*vec3(0.92,0.97,1.08), smoothstep(0.45,0.75,hgt));
              vec3 col = base * (0.18 + 0.82*daylight) + vec3(0.02,0.03,0.06);
              acc.rgb += (1.0 - acc.a) * a * col; acc.a += (1.0 - acc.a) * a;
              if (acc.a > 0.97) break;
            }
          }
          p += dir * dt;
        }
        if (acc.a < 0.01) discard;
        gl_FragColor = vec4(acc.rgb / acc.a, acc.a);
      }`,
    transparent: true, side: THREE.BackSide, depthWrite: false, depthTest: false
  });
  cloudMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), cloudMat);
  cloudMesh.scale.set(W, ZTOP, D); cloudMesh.position.y = ZTOP / 2; cloudMesh.renderOrder = 2;
  world.add(cloudMesh);
}
// ---------- Campo en altura: humedad (relación de mezcla) o viento vertical, en un nivel de presión ----------
// Plano semitransparente a la altura real del nivel, recortado donde el relieve lo atraviesa, con isolíneas.
// Valores en el visor: q en décimas de g/kg (×0.1 → g/kg); w en m/s (×100 → cm/s, + ascenso).
const CAMPOS = {
  q: {nombre: "Humedad", unidad: "g/kg", escala: 0.1, cero: false,
      lev: {925: [0, 20, 2], 850: [0, 18, 2], 700: [0, 12, 1], 500: [0, 6, 0.5]},       // [mín, máx, isolínea]
      stops: ["#8a5a2e", "#c9a35e", "#a9c55a", "#3fae6a", "#2a90b8", "#3557c9", "#8a3bc4"],
      nota: "isohúmedas"},
  w: {nombre: "Viento vertical", unidad: "cm/s", escala: 100, cero: true,
      // la mayoría de valores está entre −8 y +15 cm/s (percentiles 2–98 de ETA y ECMWF); los núcleos convectivos saturan en rojo
      lev: {925: [-10, 10, 2], 850: [-10, 10, 2], 700: [-15, 15, 3], 600: [-15, 15, 3], 500: [-15, 15, 3],
            400: [-15, 15, 3], 300: [-15, 15, 3], 250: [-15, 15, 3]},
      stops: ["#1d3f8f", "#3d7fd1", "#9cc7ee", "#eeeeee", "#f6b08a", "#e0552f", "#9c1b1b"],   // azul descenso · rojo ascenso
      nota: "rojo = ascenso, azul = descenso, línea gruesa = 0"},
  // temperatura del nivel (décimas de °C) y su advección −V·∇T (°C/día, calculada al cargar). Rangos: según los datos (rangosAuto)
  t: {nombre: "Temperatura", unidad: "°C", escala: 0.1, cero: false, lev: {},
      stops: ["#5b3fa3", "#3f6fd8", "#38b3d9", "#4cc38a", "#d8d64a", "#f29b38", "#e2452d"],
      nota: "isotermas"},
  // advecciones: solo color en el plano (sin isolíneas propias); encima van las isolíneas oscuras del campo advectado, con su valor
  ta: {nombre: "Advección de temperatura", unidad: "°C/día", escala: 1, cero: true, sinIso: true, lev: {},
      stops: ["#1d3f8f", "#3d7fd1", "#9cc7ee", "#eeeeee", "#f6b08a", "#e0552f", "#9c1b1b"],
      nota: "rojo = advección cálida, azul = advección fría; líneas negras con valor = isotermas del nivel (°C)"},
  qa: {nombre: "Advección de humedad", unidad: "g/kg/día", escala: 1, cero: true, sinIso: true, lev: {},
      stops: ["#6b3d12", "#b07a35", "#e3c98f", "#eeeeee", "#98d3a0", "#3a9e64", "#14603f"],
      nota: "verde = llega aire más húmedo, marrón = llega aire más seco; líneas negras con valor = relación de mezcla del nivel (g/kg)"},
  // divergencia horizontal ∇·V (10⁻⁵ s⁻¹, calculada al cargar desde u y v del nivel). Rangos: según los datos (rangosAuto)
  // sin isolíneas blancas: en los núcleos fuertes quedaban muy juntas y aclaraban el rojo; solo la línea oscura del cero
  dv: {nombre: "Divergencia", unidad: "10⁻⁵ s⁻¹", escala: 1, cero: true, sinIso: true, lineaCero: true, lev: {},
      stops: ["#1d3f8f", "#3d7fd1", "#9cc7ee", "#eeeeee", "#f6b08a", "#e0552f", "#9c1b1b"],
      nota: "azul = convergencia, rojo = divergencia, línea oscura = 0; favorecen el ascenso la convergencia en 925–850 hPa y la divergencia en 250 hPa"}
};
// ∇·V = (1/(a·cosφ))·∂u/∂λ + (1/a)·∂v/∂φ − v·tanφ/a en cada nivel con viento, diferencias centradas + suavizado de ±CFG.advR puntos.
// Se enmascara solo donde el nivel queda bajo el relieve del modelo.
function divergencia(m) {
  const nx = m.lons.length, ny = m.lats.length, dl = m.lons[1] - m.lons[0], da = m.lats[1] - m.lats[0], A_T = 6.371e6;
  const mx = m.lats.map(la => 1 / (dl * 111320 * Math.cos(la * Math.PI / 180))), my = 1 / (da * 110574);
  const tg = m.lats.map(la => Math.tan(la * Math.PI / 180) / A_T), tmp = new Float32Array(nx * ny), R = CFG.advR, bajo = {};
  const bajoSuelo = p => {
    if (bajo[p]) return bajo[p];
    const l = (m.plev || []).indexOf(+p), z = l >= 0 && m.zlev ? m.zlev[l] : null, b = new Uint8Array(nx * ny);
    for (let k = 0; k < nx * ny; k++) { const h = m.hgt ? m.hgt[k] : 0, zz = z && z[k] != null ? z[k] : pHeight(+p) * 1000; b[k] = h != null && h > zz ? 1 : 0; }   // solo bajo el relieve: la convergencia junto al terreno sí interesa
    return (bajo[p] = b);
  };
  for (const st of m.steps) for (const key of Object.keys(st)) {
    const r = /^u(\d{3,4})$/.exec(key); if (!r) continue;
    const p = r[1], U = st[key], V = st["v" + p]; if (!U || !V) continue;
    const B = bajoSuelo(p);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const i0 = Math.max(0, i - 1), i1 = Math.min(nx - 1, i + 1), j0 = Math.max(0, j - 1), j1 = Math.min(ny - 1, j + 1), k = j * nx + i;
      if (B[k] || B[j * nx + i0] || B[j * nx + i1] || B[j0 * nx + i] || B[j1 * nx + i]) { tmp[k] = NaN; continue; }
      const dux = (U[j * nx + i1] - U[j * nx + i0]) * 0.1 * mx[j] / (i1 - i0);      // 1/s
      const dvy = (V[j1 * nx + i] - V[j0 * nx + i]) * 0.1 * my / (j1 - j0);
      tmp[k] = (dux + dvy - V[k] * 0.1 * tg[j]) * 1e5;                               // 10⁻⁵ s⁻¹
    }
    const D = new Float32Array(nx * ny);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      if (!(tmp[j * nx + i] === tmp[j * nx + i])) { D[j * nx + i] = NaN; continue; }
      let s = 0, n = 0;
      for (let dj = -R; dj <= R; dj++) for (let di = -R; di <= R; di++) {
        const jj = j + dj, ii = i + di; if (jj < 0 || jj >= ny || ii < 0 || ii >= nx) continue;
        const v = tmp[jj * nx + ii]; if (v === v) { s += v; n++; }
      }
      D[j * nx + i] = n ? s / n : NaN;
    }
    st["dv" + p] = D;                                                                // dv850, dv250, ...
  }
}
// −V·∇T y −V·∇q en cada nivel que tenga el campo y viento, en la malla del modelo (diferencias centradas + suavizado de ±CFG.advR puntos).
// T y q se guardan ambos en décimas (°C y g/kg): el resultado queda en °C/día o g/kg/día.
function adveccionT(m) {
  const nx = m.lons.length, ny = m.lats.length, dl = m.lons[1] - m.lons[0], da = m.lats[1] - m.lats[0];
  const mx = m.lats.map(la => 1 / (dl * 111320 * Math.cos(la * Math.PI / 180))), my = 1 / (da * 110574);   // 1/m por celda
  const tmp = new Float32Array(nx * ny), bajo = {}, R = CFG.advR;
  // donde el nivel queda bajo el relieve del modelo la T es extrapolada y da gradientes falsos: se enmascara
  const bajoSuelo = p => {
    if (bajo[p]) return bajo[p];
    const l = (m.plev || []).indexOf(+p), z = l >= 0 && m.zlev ? m.zlev[l] : null, b = new Uint8Array(nx * ny);
    for (let k = 0; k < nx * ny; k++) { const h = m.hgt ? m.hgt[k] : 0, zz = z && z[k] != null ? z[k] : pHeight(+p) * 1000; b[k] = h != null && h > zz - 500 ? 1 : 0; }   // a menos de 500 m del suelo: capa límite, no transporte
    return (bajo[p] = b);
  };
  for (const st of m.steps) for (const key of Object.keys(st)) {
    const r = /^([tq])(\d{3,4})$/.exec(key); if (!r) continue;
    const p = r[2], T = st[key], U = st["u" + p], V = st["v" + p]; if (!T || !U || !V) continue;
    const B = bajoSuelo(p);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const i0 = Math.max(0, i - 1), i1 = Math.min(nx - 1, i + 1), j0 = Math.max(0, j - 1), j1 = Math.min(ny - 1, j + 1), k = j * nx + i;
      if (B[k] || B[j * nx + i0] || B[j * nx + i1] || B[j0 * nx + i] || B[j1 * nx + i]) { tmp[k] = NaN; continue; }
      const dTx = (T[j * nx + i1] - T[j * nx + i0]) * 0.1 * mx[j] / (i1 - i0);      // °C/m
      const dTy = (T[j1 * nx + i] - T[j0 * nx + i]) * 0.1 * my / (j1 - j0);
      tmp[k] = -(U[k] * 0.1 * dTx + V[k] * 0.1 * dTy) * 86400;                        // °C/día
    }
    const A = new Float32Array(nx * ny);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      let s = 0, n = 0;
      if (!(tmp[j * nx + i] === tmp[j * nx + i])) { A[j * nx + i] = NaN; continue; }   // lo enmascarado sigue enmascarado
      for (let dj = -R; dj <= R; dj++) for (let di = -R; di <= R; di++) {
        const jj = j + dj, ii = i + di; if (jj < 0 || jj >= ny || ii < 0 || ii >= nx) continue;
        const v = tmp[jj * nx + ii]; if (v === v) { s += v; n++; }
      }
      A[j * nx + i] = n ? s / n : NaN;
    }
    st[r[1] + "a" + p] = A;                                                          // ta850, qa850, ...
  }
}
// Rangos de color de temperatura y advección según los datos (cambian mucho entre el trópico y Sudamérica)
function rangosAuto() {
  const lindo = x => { for (const r of [0.5, 1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40]) if (x <= r) return r; return 50; };
  for (const v of ["t", "ta", "qa", "dv"]) {
    const C = CAMPOS[v];
    for (const p of [925, 850, 700, 500, 250]) {
      const vals = [];
      for (const m of Object.values(MODELS)) {
        if (!m.steps[0] || !m.steps[0][v + p]) continue;
        for (let s = 0; s < m.steps.length; s += 2) { const a = m.steps[s][v + p]; for (let i = 0; i < a.length; i += 3) if (a[i] === a[i]) vals.push(a[i] * C.escala); }
      }
      if (vals.length < 50) continue;
      vals.sort((x, y) => x - y); const q = f => vals[Math.floor(f * (vals.length - 1))];
      if (v === "t") { const iso = CFG.isoT; C.lev[p] = [Math.floor(q(0.01) / iso) * iso, Math.ceil(q(0.99) / iso) * iso, iso]; }
      else { const R = lindo(Math.max(Math.abs(q(0.02)), Math.abs(q(0.98)))); C.lev[p] = [-R, R, R / 5]; }
    }
  }
}
for (const k in CAMPOS) CAMPOS[k].ramp = ramp(CAMPOS[k].stops.map((h, i) => [i / (CAMPOS[k].stops.length - 1), hx(h)]));
let humVar = "off", humLevel = "off", humMesh = null, humMat = null, humTex = null, humKey = "";
const HUM = {ramp: v => CAMPOS[humVar].ramp(v)};   // usado por las partículas de viento sincronizadas
function buildHum(W, D) {
  // canal R = valor (0–1 en la escala del campo), canal G = hay dato (1) o no (0): lo sin dato no se dibuja.
  // Media precisión flotante, no 8 bits: con 256 niveles los gradientes débiles quedaban en mesetas planas y, si una
  // meseta caía justo en el valor de una isolínea, toda se pintaba blanca (parches pegados a las isolíneas).
  humTex = new THREE.DataTexture(new Uint16Array(VNX * VNY * 2), VNX, VNY, THREE.RGFormat, THREE.HalfFloatType);
  humTex.minFilter = humTex.magFilter = THREE.LinearFilter; humTex.needsUpdate = true;
  humMat = new THREE.ShaderMaterial({
    // opac: la fija el control «Opacidad del campo» (0.75 por defecto)
    uniforms: {qTex: {value: humTex}, hmap: {value: hmapTex}, hmapMax: {value: 7.0}, zKm: {value: 1.5}, vMin: {value: 0}, vMax: {value: 18}, iso: {value: 2}, opac: {value: 0.75}, isoW: {value: 0.45},
               cero: {value: 0}, pal: {value: CAMPOS.q.stops.map(h => { const c = hx(h); return new THREE.Vector3(c[0], c[1], c[2]); })}},
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `
      uniform sampler2D qTex; uniform sampler2D hmap; uniform float hmapMax, zKm, vMin, vMax, iso, opac, cero, isoW; uniform vec3 pal[7];
      varying vec2 vUv;
      vec3 paleta(float t){ t = clamp(t, 0.0, 1.0) * 6.0; int i = int(min(floor(t), 5.0)); float f = t - float(i);
        vec3 a = pal[0], b = pal[1];
        for (int k = 0; k < 6; k++) if (k == i) { a = pal[k]; b = pal[k + 1]; }
        return mix(a, b, f); }
      void main(){
        float g = texture2D(hmap, vUv).r * hmapMax;
        if (g > zKm) discard;                                   // el relieve atraviesa el nivel
        vec2 tx = texture2D(qTex, vUv).rg;
        if (tx.g < 0.5) discard;                                // sin dato (fuera del modelo o enmascarado)
        float t = tx.r, q = vMin + t * (vMax - vMin);           // valor en unidades del campo
        vec3 c = paleta(t);
        // Fuera de escala el valor queda recortado y plano (fwidth = 0): si el tope cae justo en una isolínea, toda la zona
        // se pintaba de blanco en bloques. Ahí no hay isolíneas, y el ancho de la línea nunca es cero.
        // Donde el campo queda plano (fwidth casi 0) tampoco: la línea no tiene posición definida y rellenaba la zona.
        float dentro = step(0.004, t) * step(t, 0.996);
        float f = q / iso, wf = fwidth(f), wq = fwidth(q);
        float line = wf > 1e-4 ? (1.0 - smoothstep(0.0, wf * 1.3, abs(fract(f - 0.5) - 0.5))) * dentro : 0.0;
        c = mix(c, vec3(1.0), line * isoW);                     // isolíneas (0 en las advecciones)
        if (cero > 0.5 && wq > 1e-4 * iso) { float z0 = (1.0 - smoothstep(0.0, wq * 2.2, abs(q))) * dentro; c = mix(c, vec3(0.08), z0 * 0.85); }   // línea de cero
        float near = smoothstep(zKm - 0.5, zKm, g);             // se desvanece al acercarse al relieve
        gl_FragColor = vec4(c, opac * (1.0 - 0.7 * near));
      }`,
    // escribe profundidad: lo que queda debajo del plano (límites sobre el relieve, gotas…) ya no se ve a través de él.
    // Antes los límites del relieve y los del plano se veían a la vez, corridos por la perspectiva (paralaje).
    // polygonOffset: el plano queda un pelo más atrás, para no tapar lo que va a su misma altura (partículas, límites del nivel)
    transparent: true, depthWrite: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 4
  });
  humMesh = new THREE.Mesh(new THREE.PlaneGeometry(W, D), humMat);
  humMesh.rotation.x = -Math.PI / 2; humMesh.visible = false; humMesh.renderOrder = 1;
  world.add(humMesh);
}
const campoField = p => humVar + p;                         // q850, w500, ...
function campoDisponible(m, v, p) { return !!(m.steps[0] && m.steps[0][v + p]); }
function updateHum() {
  const m = MODELS[model], p = +humLevel;
  if (humVar === "off" || humLevel === "off" || !campoDisponible(m, humVar, p)) { humMesh.visible = false; return; }
  humMesh.visible = true;
  const C = CAMPOS[humVar], [lo, hi, iso] = C.lev[p];
  const [a, b, f] = bracket(m, hours), key = model + humVar + p + a + "_" + b + "_" + f.toFixed(2);
  if (key === humKey) return; humKey = key;
  const A = stepField(m, a, campoField(p), C.escala, m.sVol, "v"), B = stepField(m, b, campoField(p), C.escala, m.sVol, "v"), d = humTex.image.data;
  // sin dato: canal G = 0 (el shader no lo dibuja); el valor se deja en el neutro para que el borde no tome un color extremo
  const H = THREE.DataUtils.toHalfFloat, uno = H(1), cer = H(0);
  const nul = H(C.cero ? Math.max(0, Math.min(1, -lo / (hi - lo))) : 0.5);
  for (let i = 0, n = d.length / 2; i < n; i++) {
    const v = A[i] + (B[i] - A[i]) * f, ok = v === v;
    d[2 * i] = ok ? H(Math.max(0, Math.min(1, (v - lo) / (hi - lo)))) : nul; d[2 * i + 1] = ok ? uno : cer;
  }
  humTex.needsUpdate = true;
  const z = zMean(m, p), U = humMat.uniforms; humMesh.position.y = z;
  U.zKm.value = z; U.vMin.value = lo; U.vMax.value = hi; U.iso.value = iso; U.cero.value = C.cero && (!C.sinIso || C.lineaCero) ? 1 : 0; U.isoW.value = C.sinIso ? 0 : 0.45;
  C.stops.forEach((h, i) => { const c = hx(h); U.pal.value[i].set(c[0], c[1], c[2]); });
}
function drawHumLegend() {
  const box = $("humLegend");
  $("campoCnt").textContent = humVar === "off" || humLevel === "off" ? "" : ({q: "humedad ", w: "w ", t: "T ", ta: "adv. T ", qa: "adv. q ", dv: "div. "})[humVar] + humLevel;
  if (humVar === "off" || humLevel === "off") { box.hidden = true; return; }
  box.hidden = false; const C = CAMPOS[humVar], [lo, hi, iso] = C.lev[humLevel], cv = $("humCv"), ctx = cv.getContext("2d");
  for (let x = 0; x < cv.width; x++) { const c = C.ramp(x / (cv.width - 1)); ctx.fillStyle = `rgb(${c[0]*255|0},${c[1]*255|0},${c[2]*255|0})`; ctx.fillRect(x, 0, 1, cv.height); }
  const n = 4; $("humTicks").innerHTML = Array.from({length: n + 1}, (_, i) => `<span>${+(lo + (hi - lo) * i / n).toFixed(1)}</span>`).join("");
  $("humNote").textContent = `${C.nombre} (${C.unidad}) a ${humLevel} hPa ≈ ${(zMean(MODELS[model], +humLevel) * 1000).toFixed(0)} m${C.sinIso ? "" : ` · isolíneas cada ${iso} ${C.unidad}`} · ${C.nota}`;
}
// Normaliza un valor (unidades del visor) del campo activo a 0–1, para colorear partículas
function campoNorm(v) { const C = CAMPOS[humVar], [lo, hi] = C.lev[humLevel]; return (v * C.escala - lo) / (hi - lo); }

let volKeyA = null, volKeyB = null;
function updateVolumes(m) {
  const [a, b, f] = bracket(m, hours);
  const ka = model + a, kb = model + b;
  if (ka !== volKeyA) { volTexA.image.data.set(buildVolume(m, a)); volTexA.needsUpdate = true; volKeyA = ka; }
  if (kb !== volKeyB) { volTexB.image.data.set(buildVolume(m, b)); volTexB.needsUpdate = true; volKeyB = kb; }
  cloudMat.uniforms.mixT.value = f;
}

// ---------- Campos interpolados en el tiempo ----------
const fieldCache = new Map();
function stepField(m, k, name, scale, sampler, cacheTag) {
  const key = model + "|" + cacheTag + "|" + k + "|" + name;
  if (fieldCache.has(key)) return fieldCache.get(key);
  const v = applySampler(sampler, m.steps[k][name], scale);
  if (fieldCache.size > 400) fieldCache.clear();
  fieldCache.set(key, v); return v;
}
const tmpA = {};
function terrainField(m, name, scale) {
  const [a, b, f] = bracket(m, hours);
  const A = stepField(m, a, name, scale, m.sTerr, "t"), B = stepField(m, b, name, scale, m.sTerr, "t");
  const out = tmpA[name] || (tmpA[name] = new Float32Array(A.length));
  for (let i = 0; i < A.length; i++) out[i] = A[i] + (B[i] - A[i]) * f;
  return out;
}

// Temperatura a 2 m en el terreno a una hora cualquiera h (null si el modelo no cubre esa hora)
function t2Terreno(m, h, tag) {
  if (h < m.abs[0] - 0.01 || h > m.abs[m.abs.length - 1] + 0.01) return null;
  const [a, b, f] = bracket(m, h), A = stepField(m, a, "t2", 0.1, m.sTerr, "t"), B = stepField(m, b, "t2", 0.1, m.sTerr, "t");
  const o = tmpA[tag] || (tmpA[tag] = new Float32Array(A.length));
  for (let i = 0; i < A.length; i++) o[i] = A[i] + (B[i] - A[i]) * f;
  return o;
}
// ΔT 24 h = T(ahora) − T(24 h antes); la corrección por altitud es la misma y se cancela
function dT24Terreno(m) {
  const A = t2Terreno(m, hours, "dtA"), B = t2Terreno(m, hours - 24, "dtB"); if (!A || !B) return null;
  const o = tmpA.dt24 || (tmpA.dt24 = new Float32Array(A.length));
  for (let i = 0; i < A.length; i++) o[i] = A[i] - B[i];
  return o;
}
let lastTerrKey = "";
// Con un campo en altura a la vista, el terreno va oscurecido y sin color de variable: el plano es semitransparente
// y la lluvia de abajo o el desierto claro de la imagen satelital se transparentaban en parches blanquecinos.
function updateTerrainColors() {
  const campo = humMesh && humMesh.visible && colorMode !== "relieve" && colorMode !== "natural";
  pintarTerreno(campo ? "apagado" : colorMode);
}
function pintarTerreno(colorMode) {                // el parámetro tapa al global: todo lo de abajo usa el modo efectivo
  const m = MODELS[model], n = terrLon.length;
  const key = model + colorMode + (satTex ? "s" : "") + (colorMode === "relieve" || colorMode === "natural" || colorMode === "apagado" ? "" : colorMode === "lluvia" ? rainStep(m, hours) : hours.toFixed(2));
  if (key === lastTerrKey) return;           // nada cambió: no recalcular 49 000 vértices
  lastTerrKey = key;
  const mat = terrain.material, wantMap = colorMode === "natural" && satTex ? satTex : null;
  if (mat.map !== wantMap) { mat.map = wantMap; mat.needsUpdate = true; }
  const base = terrSat || terrBase, dim = terrSat ? 0.62 : 0.45;
  if (colorMode === "natural") { if (satTex) terrColors.fill(1.12); else terrColors.set(terrBase); }
  else if (colorMode === "relieve") { terrColors.set(terrBase); }
  else if (colorMode === "apagado") {              // bajo un campo en altura: relieve oscurecido, el color del plano no se aclara
    for (let i = 0; i < n * 3; i++) terrColors[i] = base[i] * dim + 0.04;
  }
  else if (colorMode === "dt24") {
    const D = dT24Terreno(m), p = PAL.dt24, L = p.lut, base = terrSat || terrBase, dim = terrSat ? 0.62 : 0.45;
    for (let i = 0; i < n; i++) {
      const b0 = base[i*3]*dim+0.03, b1 = base[i*3+1]*dim+0.04, b2 = base[i*3+2]*dim+0.05, v = D ? D[i] : NaN;
      if (!(Math.abs(v) >= 0.5)) { terrColors[i*3]=b0; terrColors[i*3+1]=b1; terrColors[i*3+2]=b2; continue; }   // casi sin cambio: fondo
      const qi = p.idx(v), q = qi * 3, a = Math.min(1, 0.45 + 0.55 * Math.abs(v) / p.max);
      terrColors[i*3]=b0+(L[q]-b0)*a; terrColors[i*3+1]=b1+(L[q+1]-b1)*a; terrColors[i*3+2]=b2+(L[q+2]-b2)*a;
    }
  }
  else if (colorMode === "temperatura") {
    const T = terrainField(m, "t2", 0.1), p = PAL.temperatura, L = p.lut;
    for (let i = 0; i < n; i++) { const q = p.idx(T[i] + (m.hgtTerr[i] - terrZ[i]) * 1000 * LAPSE) * 3; terrColors[i*3]=L[q]; terrColors[i*3+1]=L[q+1]; terrColors[i*3+2]=L[q+2]; }
  } else {
    let V;
    if (colorMode === "lluvia") { const k = rainStep(m, hours); V = stepField(m, k, "pr", 0.1 * 3 / m.intv[k], m.sTerr, "t"); }
    else if (colorMode === "viento") {               // rapidez del viento medio a 10 m en m/s
      const U = terrainField(m, "u10", 0.1), W = terrainField(m, "v10", 0.1);
      V = tmpA.spd10 || (tmpA.spd10 = new Float32Array(n));
      for (let i = 0; i < n; i++) V[i] = Math.hypot(U[i], W[i]);
    }
    else if (colorMode === "pwat") V = m.steps[0].pw ? terrainField(m, "pw", 1) : (tmpA.pwNan || (tmpA.pwNan = new Float32Array(n).fill(NaN)));
    else V = terrainField(m, "cape", 1);
    const p = PAL[colorMode], L = p.lut, thr = colorMode === "lluvia" ? 0.2 : colorMode === "viento" ? 10 : colorMode === "pwat" ? -1 : 100;
    for (let i = 0; i < n; i++) {
      const b0 = base[i*3]*dim+0.03, b1 = base[i*3+1]*dim+0.04, b2 = base[i*3+2]*dim+0.05;
      const v = V[i];
      if (!(v > thr)) { terrColors[i*3]=b0; terrColors[i*3+1]=b1; terrColors[i*3+2]=b2; continue; }
      const qi = p.idx(v), q = qi * 3, a = colorMode === "pwat" ? 0.85 : Math.min(1, 0.55 + 0.45 * qi / 255);
      terrColors[i*3]=b0+(L[q]-b0)*a; terrColors[i*3+1]=b1+(L[q+1]-b1)*a; terrColors[i*3+2]=b2+(L[q+2]-b2)*a;
    }
  }
  terrain.geometry.attributes.color.needsUpdate = true;
}

// ---------- Sol ----------
function sunVector(h) {
  const d = new Date(T0 + h * 3.6e6);
  const solar = (d.getUTCHours() + d.getUTCMinutes()/60 + LONC/15 + 24) % 24;
  const H = (solar - 12) * 15 * Math.PI/180, dec = -16 * Math.PI/180, lat = LATC * Math.PI/180;
  const E = -Math.cos(dec)*Math.sin(H), N = Math.sin(dec)*Math.cos(lat) - Math.cos(dec)*Math.cos(H)*Math.sin(lat), U = Math.sin(dec)*Math.sin(lat) + Math.cos(dec)*Math.cos(H)*Math.cos(lat);
  return new THREE.Vector3(E, U, -N);
}
const skyNight = new THREE.Color(0x070c14), skyDay = new THREE.Color(0x6f8fac), skyDusk = new THREE.Color(0x3b3346);
const MOON = new THREE.Vector3(-0.35, 0.85, 0.4).normalize(), NOON = new THREE.Vector3(0.3, 0.88, 0.37).normalize();
const skyClear = new THREE.Color(0x2c3d52);
function updateSun() {
  let v = sunVector(hours);
  const realDay = THREE.MathUtils.smoothstep(v.y, -0.06, 0.3);
  let day = realDay;
  if (luzMode === "dia") { v = NOON; day = 1; }
  else if (luzMode === "clara") {                        // de noche: luz suave desde arriba para seguir viendo el relieve
    if (v.y < 0.12) v = v.clone().lerp(MOON, THREE.MathUtils.smoothstep(0.12 - v.y, 0, 0.25)).normalize();
    day = Math.max(day, 0.62);
  }
  sun.position.copy(v).multiplyScalar(500);
  sun.intensity = 0.12 + 1.05 * day; hemi.intensity = 0.22 + 0.4 * day;
  sun.color.setHSL(luzMode === "clara" && realDay < 0.5 ? 0.6 : 0.1, 0.5 * (1 - realDay) * (luzMode === "real" ? 1 : 0.4) + 0.2, 0.55 + 0.25 * day);
  const sky = skyNight.clone().lerp(skyDusk, THREE.MathUtils.smoothstep(v.y, -0.12, 0.05)).lerp(skyDay, luzMode === "dia" ? 1 : realDay);
  if (luzMode === "clara") sky.lerp(skyClear, 0.75 * (1 - realDay));
  scene.background = sky; scene.fog.color = sky;
  cloudMat.uniforms.sunDir.value.copy(v.y > 0 ? v : new THREE.Vector3(0.2, 1, 0).normalize());
  cloudMat.uniforms.daylight.value = day;
}

// ---------- Partículas de lluvia ----------
const NRAIN = CFG.nrain;
const rainPos = new Float32Array(NRAIN * 6), rainState = new Float32Array(NRAIN * 4); // x,z,y,ground
const rainGeo = new THREE.BufferGeometry(); rainGeo.setAttribute("position", new THREE.BufferAttribute(rainPos, 3));
const rain = new THREE.LineSegments(rainGeo, new THREE.LineBasicMaterial({color: 0x8cc4ff, transparent: true, opacity: 0.7}));
rain.renderOrder = 3; rain.frustumCulled = false; world.add(rain);
let rainSampler = null;
function rainRate(m, lon, lat) { const k = rainStep(m, hours); return bil(m.lons, m.lats, m.steps[k].pr, lon, lat, 0.1 * 3 / m.intv[k]); }
let rainGrid = null, rainGridKey = null;
function rainGridFor(m) {        // tasa en la grilla del modelo para muestrear rápido
  const k = rainStep(m, hours), key = model + k; if (key === rainGridKey) return rainGrid;
  const s = m.steps[k].pr || [], sc = 0.1 * 3 / m.intv[k], vals = new Float32Array(s.length);
  for (let i = 0; i < s.length; i++) vals[i] = (s[i] || 0) * sc;
  rainGrid = {k, vals}; rainGridKey = key; return rainGrid;
}
function spawnRain(i, m, rg) {
  const lon0 = DEM.lons[0], lon1 = DEM.lons[DEM.lons.length-1], lat0 = DEM.lats[0], lat1 = DEM.lats[DEM.lats.length-1];
  for (let t = 0; t < 12; t++) {
    const lon = lon0 + Math.random() * (lon1 - lon0), lat = lat0 + Math.random() * (lat1 - lat0);
    const r = bil(m.lons, m.lats, rg.vals, lon, lat);
    if (r > 0.3 && Math.random() < Math.min(1, r / 6)) {
      const g = demAt(lon, lat);
      rainState[i*4] = toX(lon); rainState[i*4+1] = toZ(lat); rainState[i*4+3] = g;
      rainState[i*4+2] = g + 1.2 + Math.random() * 2.6; return;
    }
  }
  rainState[i*4+2] = -50; rainState[i*4+3] = -60;
}
function updateRain(dt) {
  const show = $("cRain").checked; rain.visible = show; if (!show) return;
  const m = MODELS[model], rg = rainGridFor(m);
  for (let i = 0; i < NRAIN; i++) {
    rainState[i*4+2] -= dt * 2.4;
    if (rainState[i*4+2] <= rainState[i*4+3]) spawnRain(i, m, rg);
    const x = rainState[i*4], z = rainState[i*4+1], y = rainState[i*4+2];
    rainPos.set([x, y, z, x + 0.15, y + 0.35, z], i*6);
  }
  rainGeo.attributes.position.needsUpdate = true;
}

// ---------- Partículas de viento ----------
// Densidad (partículas activas) y estela (tramos que siguen el viento hacia atrás) ajustables en el panel.
const WDENS = {normal: 1, alta: 2, muyalta: 3}, WTAIL = {cortas: [1, 0.9], largas: [5, 3.2]};   // [tramos, largo]
const NWMAX = CFG.nw * 3, NSEG = 5;
let nwAct = CFG.nw, wSegs = 1, wLargo = 0.9;
const wPos = new Float32Array(NWMAX * NSEG * 6), wCol = new Float32Array(NWMAX * NSEG * 6), wSt = new Float32Array(NWMAX * 4); // lon,lat,age,life
const wGeo = new THREE.BufferGeometry(); wGeo.setAttribute("position", new THREE.BufferAttribute(wPos, 3)); wGeo.setAttribute("color", new THREE.BufferAttribute(wCol, 3));
const wind = new THREE.LineSegments(wGeo, new THREE.LineBasicMaterial({vertexColors: true, transparent: true, opacity: 0.9}));
wind.renderOrder = 4; wind.frustumCulled = false; world.add(wind);
// u y v interpolados juntos (un solo cálculo de índices y pesos): deja el resultado en UV[0], UV[1]
const UV = new Float64Array(2);
function uvAt(lons, lats, U, V, lon, lat) {
  if (!U || !V) { UV[0] = UV[1] = NaN; return; }                   // el modelo no tiene viento en ese nivel
  const nx = lons.length, ny = lats.length;
  let fx = (lon - lons[0]) / (lons[1] - lons[0]), fy = (lat - lats[0]) / (lats[1] - lats[0]);
  fx = fx < 0 ? 0 : fx > nx - 1.0001 ? nx - 1.0001 : fx; fy = fy < 0 ? 0 : fy > ny - 1.0001 ? ny - 1.0001 : fy;
  const i = fx | 0, j = fy | 0, a = fx - i, b = fy - j, k = j * nx + i, w0 = (1-a)*(1-b), w1 = a*(1-b), w2 = (1-a)*b, w3 = a*b;
  const u0 = U[k], u1 = U[k+1], u2 = U[k+nx], u3 = U[k+nx+1];
  if (u0 === u0 && u1 === u1 && u2 === u2 && u3 === u3) {          // caso normal: los 4 vecinos con dato
    UV[0] = u0*w0 + u1*w1 + u2*w2 + u3*w3; UV[1] = V[k]*w0 + V[k+1]*w1 + V[k+nx]*w2 + V[k+nx+1]*w3; return;
  }
  UV[0] = bil(lons, lats, U, lon, lat); UV[1] = bil(lons, lats, V, lon, lat);   // borde con huecos
}
function setWindDens(d, t) {
  nwAct = Math.round(CFG.nw * WDENS[d]); [wSegs, wLargo] = WTAIL[t];
  wPos.fill(0); wCol.fill(0); wGeo.setDrawRange(0, nwAct * wSegs * 2);
}
const windRamp = ramp([[0,hx("#7fa1b8")],[3,hx("#c9e7f2")],[7,hx("#ffe38a")],[12,hx("#ff9a4a")],[20,hx("#ff4a6a")]]);
const windEsc = () => windLevel === "250" ? 3 : windLevel === "500" ? 1.8 : 1;   // la paleta se estira en altura (chorro de 30–70 m/s)
let windGrid = null, windKey = null, wColor = "vel";        // color de partículas: "vel" velocidad, "campo" el del campo en altura
const windSync = () => wColor === "campo" && humVar !== "off" && humLevel !== "off" && humLevel === windLevel;
let wLegKey = "";
function drawWindLegend() {                                 // escala de colores de las partículas (velocidad, por nivel)
  const sync = windSync(), key = windLevel + wColor + sync + humVar + humLevel; if (key === wLegKey) return; wLegKey = key;
  $("wLegend").hidden = windLevel === "off";
  $("wCv").hidden = $("wTicks").hidden = sync;
  if (sync) { $("wNote").textContent = `Partículas con el color de «${CAMPOS[humVar].nombre}» a ${humLevel} hPa: su escala está en «Campo en altura».`; return; }
  const cv = $("wCv"), ctx = cv.getContext("2d"), e = windEsc(), sup = windLevel === "10";
  for (let x = 0; x < cv.width; x++) { const c = windRamp(20 * x / (cv.width - 1)); ctx.fillStyle = `rgb(${c[0]*255|0},${c[1]*255|0},${c[2]*255|0})`; ctx.fillRect(x, 0, 1, cv.height); }
  $("wTicks").innerHTML = [0, 5, 10, 15, 20].map(v => `<span>${Math.round(v * e)}${v === 20 ? "+" : ""}</span>`).join("");
  $("wNote").textContent = `Velocidad del viento a ${sup ? "10 m" : windLevel + " hPa"} (m/s)` + (e > 1 ? " · escala ampliada para el chorro" : "");
}
function windGridFor(m) {
  const sync = windSync();
  const [a, b, f] = bracket(m, hours), key = model + windLevel + (sync ? "q" : "") + a + "_" + b + "_" + f.toFixed(2);
  if (key === windKey) return windGrid;
  const su = "u" + windLevel, sv = "v" + windLevel, A = m.steps[a], B = m.steps[b];
  const mix = (x, y) => { if (!x || !y) return null; const o = new Float32Array(x.length); for (let i = 0; i < x.length; i++) o[i] = (x[i] == null || y[i] == null) ? NaN : (x[i] + (y[i] - x[i]) * f) / 10; return o; };
  // campo para colorear: se divide entre 10 en mix(); se compensa ×10 al usarlo
  windGrid = {u: mix(A[su], B[su]), v: mix(A[sv], B[sv]), q: sync ? mix(A[humVar + windLevel], B[humVar + windLevel]) : null};
  windKey = key; return windGrid;
}
// altura media real de un nivel de presión en el dominio (km), del geopotencial del modelo
function zMean(m, p) { return (m.zMean && m.zMean[p]) || pHeight(p); }
function windHeight(g) { return windLevel === "10" ? g + 0.12 : zMean(MODELS[model], +windLevel); }
function spawnWind(i) {
  wSt[i*4] = DEM.lons[0] + Math.random() * (DEM.lons[DEM.lons.length-1] - DEM.lons[0]);
  wSt[i*4+1] = DEM.lats[0] + Math.random() * (DEM.lats[DEM.lats.length-1] - DEM.lats[0]);
  wSt[i*4+2] = 0; wSt[i*4+3] = 2 + Math.random() * 4;
}
function initWind() { for (let i = 0; i < NWMAX; i++) { spawnWind(i); wSt[i*4+2] = Math.random() * wSt[i*4+3]; } }   // se llama cuando ya hay relieve
function updateWind(dt) {
  wind.visible = windLevel !== "off"; if (!wind.visible) { drawWindLegend(); return; }
  const m = MODELS[model], wg = windGridFor(m), K = CFG.kw || 2.2;   // unidades de escena por segundo de animación por m/s
  const esc = windEsc(); drawWindLegend();
  const lon0 = DEM.lons[0], lon1 = DEM.lons[DEM.lons.length-1], lat0 = DEM.lats[0], lat1 = DEM.lats[DEM.lats.length-1];
  const sup = windLevel === "10", S = wSegs, h = wLargo * K / S;     // largo de cada tramo de la estela por m/s
  for (let i = 0; i < nwAct; i++) {
    let lon = wSt[i*4], lat = wSt[i*4+1];
    uvAt(m.lons, m.lats, wg.u, wg.v, lon, lat); const u = UV[0], v = UV[1];
    const g = demAt(lon, lat), o = i * S * 6;
    wSt[i*4+2] += dt;
    if (!(u === u) || wSt[i*4+2] > wSt[i*4+3] || lon < lon0 || lon > lon1 || lat < lat0 || lat > lat1 || (!sup && g > windHeight(g) - 0.15)) {
      spawnWind(i); wPos.fill(0, o, o + S * 6); wCol.fill(0, o, o + S * 6); continue;
    }
    lon += u * K * dt / KX; lat += v * K * dt / KY; wSt[i*4] = lon; wSt[i*4+1] = lat;
    const sp = Math.hypot(u, v);
    const age = wSt[i*4+2] / wSt[i*4+3], fade = Math.min(1, Math.min(age, 1 - age) * 5);
    // si el plano de humedad está en el mismo nivel, la partícula toma el color de la humedad que lleva
    const c = wg.q ? HUM.ramp(Math.max(0, Math.min(1, campoNorm(bil(m.lons, m.lats, wg.q, lon, lat) * 10)))) : windRamp(sp / esc);
    // estela: S tramos hacia atrás siguiendo el viento local (con S > 1 dibuja la curvatura de la circulación)
    let la = lon, aa = lat, ua = u, va = v, ya = windHeight(g);
    for (let s = 0; s < S; s++) {
      const lb = la - ua * h / KX, ab = aa - va * h / KY;
      let ub = ua, vb = va;
      if (s < S - 1) { uvAt(m.lons, m.lats, wg.u, wg.v, lb, ab); if (UV[0] === UV[0]) { ub = UV[0]; vb = UV[1]; } }   // el último tramo no necesita el viento siguiente
      const yb = sup ? demAt(lb, ab) + 0.12 : ya;
      wPos.set([toX(la), ya, toZ(aa), toX(lb), yb, toZ(ab)], o + s * 6);
      const f0 = fade * (1 - s / S), f1 = fade * (1 - (s + 1) / S) * (S > 1 ? 1 : 0.15);
      wCol.set([c[0]*f0, c[1]*f0, c[2]*f0, c[0]*f1, c[1]*f1, c[2]*f1], o + s * 6);
      la = lb; aa = ab; ua = ub; va = vb; ya = yb;
    }
  }
  wGeo.attributes.position.needsUpdate = true; wGeo.attributes.color.needsUpdate = true;
}
let windOff = new THREE.Vector2();
function meanSteer(m) {
  const [a] = bracket(m, hours), s = m.steps[a]; let u = 0, v = 0, n = 0;
  if (!s.u500) return [0, 0];
  for (let i = 0; i < s.u500.length; i++) { const a = s.u500[i], b = s.v500[i]; if (a != null && a === a && b === b) { u += a / 10; v += b / 10; n++; } }
  return n ? [u / n, v / n] : [0, 0];
}

// ---------- Isolíneas: presión a nivel del mar (isobaras) y altura geopotencial de 500 hPa ----------
// Curvas de nivel (cuadrados marchantes) sobre la malla del modelo, interpoladas en el tiempo.
// Isobaras: sobre el relieve (o el mar). Z500: a la altura media del nivel de 500 hPa. Etiquetas A/B en máximos y mínimos.
const ISO = {
  slp:  {campo: "slp",  esc: 0.1, paso: () => CFG.isoSlp, color: [0.95, 0.97, 1.0], nombre: "Presión a nivel del mar", unidad: "hPa", umbral: () => CFG.isoSlp * 0.5},
  z500: {campo: "z500", esc: 1,   paso: () => CFG.isoZ,   color: [1.0, 0.80, 0.42], nombre: "Altura de 500 hPa",       unidad: "m",   umbral: () => CFG.isoZ * 0.5, alt: m => zMean(m, 500)},
  // isolíneas del campo advectado en el nivel del plano (isotermas con la advección de T, isohúmedas con la de q):
  // negras y con su valor, para no confundirlas con los límites del mapa; sin etiquetas A/B
  niv: {campo: () => (humVar === "qa" ? "q" : "t") + humLevel, esc: 0.1, paso: () => humVar === "qa" ? CAMPOS.q.lev[humLevel][2] : CFG.isoT,
        color: [0.04, 0.04, 0.06], oscuro: true, nombre: "Isolíneas del nivel", umbral: () => 99, alt: m => zMean(m, +humLevel) + 0.03, sinEtiquetas: true, valores: true},
  // agua precipitable: líneas negras sobre el relieve en los valores altos (la barra de color no los separa bien)
  pw: {campo: "pw", esc: 1, paso: () => PW_ISO[1], desde: () => PW_ISO[0], color: [0.03, 0.03, 0.04], oscuro: true, nombre: "Agua precipitable", unidad: "mm",
       umbral: () => 99, sinEtiquetas: true, valores: true}
};
const PW_ISO = [40, 5];                       // isolíneas de PWAT: desde 40 mm, cada 5 mm
const isoOn = {slp: false, z500: false, niv: false, pw: false};
const isoObj = {}, isoLbl = [];
for (const k in ISO) {
  const g = new THREE.BufferGeometry();
  const o = new THREE.LineSegments(g, new THREE.LineBasicMaterial({vertexColors: true, transparent: true, opacity: 0.92, depthWrite: false}));
  o.renderOrder = 5; o.frustumCulled = false; o.visible = false; world.add(o); isoObj[k] = {o, key: ""};
}
function contornos(m, F, paso, desde) {          // [{v, s: [lon, lat, lon, lat, ...]}]; desde: primer valor (opcional)
  const nx = m.lons.length, ny = m.lats.length; let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < F.length; i++) { const v = F[i]; if (v === v) { if (v < lo) lo = v; if (v > hi) hi = v; } }
  const out = [];
  if (!(hi > lo)) return out;
  for (let L = Math.max(Math.ceil(lo / paso) * paso, desde == null ? -Infinity : desde); L <= hi; L += paso) {
    const s = [];
    for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
      const k = j * nx + i, a = F[k], b = F[k + 1], c = F[k + nx + 1], d = F[k + nx];   // a SO, b SE, c NE, d NO
      if (!(a === a && b === b && c === c && d === d)) continue;
      const A = a > L, B = b > L, C = c > L, D = d > L;
      if (A === B && B === C && C === D) continue;
      const x0 = m.lons[i], x1 = m.lons[i + 1], y0 = m.lats[j], y1 = m.lats[j + 1];
      const e = q => q === 0 ? [x0 + (x1 - x0) * (L - a) / (b - a), y0] : q === 1 ? [x1, y0 + (y1 - y0) * (L - b) / (c - b)]
                   : q === 2 ? [x0 + (x1 - x0) * (L - d) / (c - d), y1] : [x0, y0 + (y1 - y0) * (L - a) / (d - a)];
      const cr = []; if (A !== B) cr.push(0); if (B !== C) cr.push(1); if (D !== C) cr.push(2); if (A !== D) cr.push(3);
      let pares;
      if (cr.length === 2) pares = [[cr[0], cr[1]]];
      else pares = ((a + b + c + d) / 4 > L) === A ? [[0, 1], [2, 3]] : [[0, 3], [1, 2]];   // punto de silla: decide el centro
      for (const [p, q] of pares) { const P = e(p), Q = e(q); s.push(P[0], P[1], Q[0], Q[1]); }
    }
    out.push({v: L, s});
  }
  return out;
}
function extremos(m, F, R, umbral) {              // máximos y mínimos locales en una ventana de ±R puntos
  const nx = m.lons.length, ny = m.lats.length, out = [];
  for (let j = R; j < ny - R; j++) for (let i = R; i < nx - R; i++) {
    const v = F[j * nx + i]; if (!(v === v)) continue;
    let mx = true, mn = true, s = 0, n = 0;
    for (let dj = -R; dj <= R && (mx || mn); dj++) for (let di = -R; di <= R; di++) {
      if (!di && !dj) continue; const w = F[(j + dj) * nx + i + di]; if (!(w === w)) { mx = mn = false; break; }
      if (w >= v) mx = false; if (w <= v) mn = false; s += w; n++;
    }
    if ((mx || mn) && Math.abs(v - s / n) >= umbral) out.push({lon: m.lons[i], lat: m.lats[j], v, alta: mx});
  }
  return out;
}
function isoCampo(m, k) {                         // campo en la malla del modelo a la hora actual
  const I = ISO[k], c = typeof I.campo === "function" ? I.campo() : I.campo, [a, b, f] = bracket(m, hours), A = m.steps[a][c], B = m.steps[b][c];
  if (!A || !B) return null;
  const o = new Float32Array(A.length);
  for (let i = 0; i < A.length; i++) o[i] = (A[i] == null || B[i] == null || !(A[i] === A[i]) || !(B[i] === B[i])) ? NaN : (A[i] + (B[i] - A[i]) * f) * I.esc;
  return o;
}
function updateIso() {
  const m = MODELS[model], [a, b, f] = bracket(m, hours);
  let algun = false;
  for (const k in ISO) {
    const I = ISO[k], obj = isoObj[k], F = isoOn[k] ? isoCampo(m, k) : null;
    obj.o.visible = !!F; if (!F) { obj.key = ""; continue; }
    algun = true;
    const key = model + humVar + humLevel + a + "_" + b + "_" + f.toFixed(1); if (key === obj.key) continue; obj.key = key;
    const paso = I.paso(), pos = [], col = [], z5 = I.alt ? I.alt(m) : 0, lado = CFG.isoLargo, vals = [];
    for (const {v, s} of contornos(m, F, paso, I.desde ? I.desde() : null)) {
      const fuerte = Math.abs(Math.round(v / paso)) % 4 === 0, br = I.oscuro ? 1 : fuerte ? 1 : 0.55;   // cada 4 isolíneas, más brillante
      if (I.valores && s.length) {                 // valor de la isolínea en 2 de sus tramos (a 1/3 y 2/3 de la lista)
        for (const fr of [0.33, 0.67]) { const q = Math.floor(s.length / 4 * fr) * 4; vals.push({v, lon: (s[q] + s[q + 2]) / 2, lat: (s[q + 1] + s[q + 3]) / 2}); }
      }
      const c = [I.color[0] * br, I.color[1] * br, I.color[2] * br];
      for (let q = 0; q < s.length; q += 4) {
        if (I.alt) { pos.push(toX(s[q]), z5, toZ(s[q + 1]), toX(s[q + 2]), z5, toZ(s[q + 3])); col.push(...c, ...c); continue; }
        // isobaras: en tramos cortos que siguen el relieve (o el nivel del mar)
        const n = Math.max(1, Math.ceil(Math.hypot(s[q + 2] - s[q], s[q + 3] - s[q + 1]) / lado));
        for (let t = 0; t < n; t++) {
          const l0 = s[q] + (s[q + 2] - s[q]) * t / n, a0 = s[q + 1] + (s[q + 3] - s[q + 1]) * t / n;
          const l1 = s[q] + (s[q + 2] - s[q]) * (t + 1) / n, a1 = s[q + 1] + (s[q + 3] - s[q + 1]) * (t + 1) / n;
          pos.push(toX(l0), Math.max(0, demAt(l0, a0)) + 0.08, toZ(a0), toX(l1), Math.max(0, demAt(l1, a1)) + 0.08, toZ(a1)); col.push(...c, ...c);
        }
      }
    }
    const g = obj.o.geometry;
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    g.attributes.position.needsUpdate = true;
    // etiquetas A/B (alta/baja) de este campo
    for (let i = isoLbl.length - 1; i >= 0; i--) if (isoLbl[i].k === k) { isoLbl[i].el.remove(); isoLbl.splice(i, 1); }
    for (const x of vals) {
      const el = document.createElement("div"); el.className = "hl iv";
      el.textContent = +x.v.toFixed(paso < 1 ? 1 : 0); labelsEl.appendChild(el);
      isoLbl.push({k, el, lon: x.lon, lat: x.lat, y: I.alt ? z5 + 0.05 : Math.max(0, demAt(x.lon, x.lat)) + 0.12});   // sobre el relieve si la línea lo sigue
    }
    if (!I.sinEtiquetas) for (const x of extremos(m, F, CFG.isoRadio, I.umbral()).slice(0, 40)) {
      const el = document.createElement("div");
      el.className = "hl " + (k === "z500" ? "z" : x.alta ? "alta" : "baja");
      el.innerHTML = `<b>${x.alta ? "A" : "B"}</b><small>${k === "z500" ? Math.round(x.v) : x.v.toFixed(0)}</small>`;
      labelsEl.appendChild(el);
      isoLbl.push({k, el, lon: x.lon, lat: x.lat, y: k === "z500" ? z5 + 0.2 : Math.max(0, demAt(x.lon, x.lat)) + 0.4});
    }
  }
  for (const k in ISO) if (!isoOn[k] || !obj0(k)) for (let i = isoLbl.length - 1; i >= 0; i--) if (isoLbl[i].k === k) { isoLbl[i].el.remove(); isoLbl.splice(i, 1); }
  return algun;
}
const obj0 = k => isoObj[k].o.visible;
function isoNota() {
  const m = MODELS[model], p = [];
  if (isoOn.slp) p.push(m.steps[0].slp ? `<b>Isobaras</b> cada ${CFG.isoSlp} hPa (blancas, más brillantes cada ${CFG.isoSlp * 4})` : `${model} no trae presión a nivel del mar`);
  if (isoOn.z500) p.push(m.steps[0].z500 ? `<b>Z500</b> cada ${CFG.isoZ} m (amarillas) a ≈${(zMean(m, 500) * 1000).toFixed(0)} m` : `${model} no trae Z500`);
  $("isoNote").innerHTML = p.length ? p.join(" · ") + ". <b>A</b> alta (azul), <b>B</b> baja (rojo)." : "Isobaras y altura de 500 hPa para ubicar altas, bajas, vaguadas y dorsales.";
  const n = (isoOn.slp ? 1 : 0) + (isoOn.z500 ? 1 : 0); $("isoCnt").textContent = n ? n + " activa" + (n > 1 ? "s" : "") : ""; $("isoCnt").className = "cnt cero";
}

// ---------- Límites departamentales ----------
let bordes = null, bordesAlto = null; const deptLabels = [];
function bordesNivel() {                           // límites encima del campo en altura, a su altura
  if (!bordesAlto) return;
  bordesAlto.visible = !!(bordes && bordes.visible && humMesh && humMesh.visible);
  if (bordesAlto.visible) bordesAlto.position.y = humMesh.position.y + 0.02;
}
function buildLimites(L) {
  const pos = [];
  for (const line of L.lineas) {
    for (let k = 0; k + 3 < line.length; k += 2) {
      const lo0 = line[k], la0 = line[k+1], lo1 = line[k+2], la1 = line[k+3];
      // densificar cada ~1.5 km para que la línea siga el relieve y no se hunda en los valles
      const n = Math.max(1, Math.ceil(Math.hypot((lo1 - lo0) * KX, (la1 - la0) * KY) / 1.5));
      for (let s = 0; s < n; s++) {
        const a = s / n, b = (s + 1) / n;
        const la = lo0 + (lo1 - lo0) * a, aa = la0 + (la1 - la0) * a, lb = lo0 + (lo1 - lo0) * b, ab = la0 + (la1 - la0) * b;
        pos.push(toX(la), demAt(la, aa) + 0.06, toZ(aa), toX(lb), demAt(lb, ab) + 0.06, toZ(ab));
      }
    }
  }
  const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  bordes = new THREE.LineSegments(g, new THREE.LineBasicMaterial({color: 0xf4f0e6, transparent: true, opacity: 0.85}));
  bordes.renderOrder = 2; world.add(bordes);         // después del campo en altura (1): bajo el plano no se dibujan
  // copia plana de los límites a la altura del campo en altura (el plano tapa los del relieve); oscuros, para no
  // confundirlos con las isolíneas blancas. Se muestra solo con un campo activo (ver bordesNivel)
  const plano = [];
  for (const line of L.lineas) for (let k = 0; k + 3 < line.length; k += 2)
    plano.push(toX(line[k]), 0, toZ(line[k+1]), toX(line[k+2]), 0, toZ(line[k+3]));
  const g2 = new THREE.BufferGeometry(); g2.setAttribute("position", new THREE.Float32BufferAttribute(plano, 3));
  bordesAlto = new THREE.LineSegments(g2, new THREE.LineBasicMaterial({color: 0x0c0c10, transparent: true, opacity: 0.85, depthWrite: false}));
  bordesAlto.renderOrder = 3; bordesAlto.visible = false; world.add(bordesAlto);
  for (const [nombre, lon, lat] of L.nombres) {
    const el = document.createElement("div"); el.className = "dept"; el.textContent = nombre;
    labelsEl.appendChild(el); deptLabels.push({el, lon, lat, g: demAt(lon, lat)});
  }
}
function setLimites(on) { if (bordes) bordes.visible = on; deptLabels.forEach(d => d.el.hidden = !on); }

// ---------- Puntos ----------
const labelsEl = $("labels");
function addPin(p) {
  const el = document.createElement("div"); el.className = "pin" + (p.tmp ? " tmp" : "");
  el.innerHTML = `<span>${p.nombre}</span><i></i><b></b>`; el.title = p.nombre; el.addEventListener("click", e => { e.stopPropagation(); selectPoint(p); });
  labelsEl.appendChild(el); p.el = el; p.g = demAt(p.lon, p.lat);
}
const vtmp = new THREE.Vector3();
function updateLabels() {
  const w = innerWidth, h = innerHeight;
  if (bordes && bordes.visible) for (const d of deptLabels) {
    // con un campo en altura, el nombre va sobre el plano (junto a los límites de ese nivel), salvo que el relieve lo supere
    const yk = bordesAlto && bordesAlto.visible ? Math.max(d.g + 1.5, humMesh.position.y + 0.3) : d.g + 1.5;
    vtmp.set(toX(d.lon), yk * exag, toZ(d.lat)).project(camera);
    const vis = vtmp.z < 1 && Math.abs(vtmp.x) < 1 && Math.abs(vtmp.y) < 1;
    d.el.style.display = vis ? "" : "none";
    if (vis) d.el.style.transform = `translate(${(vtmp.x*0.5+0.5)*w}px, ${(-vtmp.y*0.5+0.5)*h}px) translate(-50%,-50%)`;
  }
  for (const d of isoLbl) {
    vtmp.set(toX(d.lon), d.y * exag, toZ(d.lat)).project(camera);
    const vis = vtmp.z < 1 && Math.abs(vtmp.x) < 1 && Math.abs(vtmp.y) < 1;
    d.el.style.display = vis ? "" : "none";
    if (vis) d.el.style.transform = `translate(${(vtmp.x*0.5+0.5)*w}px, ${(-vtmp.y*0.5+0.5)*h}px) translate(-50%,-50%)`;
  }
  for (const p of PUNTOS) {
    vtmp.set(toX(p.lon), (p.g + 0.05) * exag, toZ(p.lat)).project(camera);
    const vis = vtmp.z < 1 && Math.abs(vtmp.x) < 1.05 && Math.abs(vtmp.y) < 1.05;
    p.el.style.display = vis ? "" : "none";
    if (vis) p.el.style.transform = `translate(${(vtmp.x*0.5+0.5)*w}px, ${(-vtmp.y*0.5+0.5)*h}px) translate(-50%,${pinMode === "puntos" ? "-50%" : "-100%"})`;
  }
}

// Serie de un punto para un modelo
function series(m, p) {
  const s = makeSampler(m.lons, m.lats, [p.lon], [p.lat]);
  const hm = applySampler(s, m.hgt, 1)[0];
  const corr = (hm - p.g * 1000) * LAPSE;
  return m.steps.map((st, k) => {
    const o = {h: m.abs[k], t: applySampler(s, st.t2, 0.1)[0] + corr, pr: k === 0 ? 0 : (applySampler(s, st.pr, 0.1)[0] || 0), intv: m.intv[k],
               l: applySampler(s, st.lcc, 1)[0], mm: applySampler(s, st.mcc, 1)[0], hh: applySampler(s, st.hcc, 1)[0]};
    // viento medio a 10 m y ráfaga (si el modelo la trae), en m/s
    o.w = Math.hypot(applySampler(s, st.u10, 0.1)[0], applySampler(s, st.v10, 0.1)[0]);   // m/s
    o.g = st.g10 ? applySampler(s, st.g10, 0.1)[0] : NaN;
    return o;                                    // franjas del meteograma: nubosidad baja/media/alta propia del modelo
  });
}
function serAll(p) {                             // series de los tres modelos de un punto (se calculan una vez)
  if (!p.serAll) { p.serAll = {}; for (const k in MODELS) p.serAll[k] = series(MODELS[k], p); }
  return p.serAll;
}
const horaLocal = h => String(new Date(T0 + (h - 5) * 3.6e6).getUTCHours()).padStart(2, "0") + " h";
// ---------- Avisos de viento a 10 m ----------
// Para cada punto y día local (01 h a 01 h), los modelos cuyo viento medio o ráfaga supera el umbral, con su máximo y la hora.
function updateAvisos() {
  const dias = [];
  for (let d = 0; d < 6; d++) {
    const a = d * 24 + 6, b = a + 24, lista = [];
    for (const p of PUNTOS) {
      if (p.tmp) continue;
      const S = serAll(p), hits = [];
      for (const k in S) {
        let bw = null, bg = null;
        for (const s of S[k]) {
          if (s.h < a || s.h > b || s.h > SPAN) continue;
          if (s.w >= UMB_W && (!bw || s.w > bw.w)) bw = s;
          if (s.g >= UMB_G && (!bg || s.g > bg.g)) bg = s;
        }
        if (bw || bg) hits.push({k, bw, bg});
      }
      if (hits.length) lista.push({p, hits, h: (hits[0].bw || hits[0].bg).h, top: Math.max(...hits.map(x => x.bw ? x.bw.w : 0))});
    }
    lista.sort((x, y) => y.hits.length - x.hits.length || y.top - x.top);
    if (lista.length) dias.push({d, lista});
  }
  const el = $("avisos"); AVISOS = [];
  if (!dias.length) el.innerHTML = `<div class="note">Ningún punto supera ${UMB_W} m/s de viento medio${hayRafaga() ? ` ni ${UMB_G} m/s de ráfaga` : ""} en los próximos 6 días.</div>`;
  else el.innerHTML = dias.map(({d, lista}) => {
    const date = new Date(T0 + d * 864e5);
    return `<div class="av-day">${DIAS[date.getUTCDay()]} ${String(date.getUTCDate()).padStart(2, "0")}</div>` + lista.map(it => {
      const i = AVISOS.push(it) - 1;
      const det = it.hits.map(x => `<i>${x.k}</i> ${x.bw ? Math.round(x.bw.w) + " m/s " + horaLocal(x.bw.h) : ""}${x.bg ? (x.bw ? " · " : "") + "ráf. " + Math.round(x.bg.g) + " " + horaLocal(x.bg.h) : ""}`).join(" &nbsp; ");
      return `<button type="button" class="av" data-i="${i}"><b>${it.p.nombre}</b><small>${det}</small></button>`;
    }).join("");
  }).join("");
  el.querySelectorAll && el.querySelectorAll(".av").forEach(b => b.onclick = () => { const it = AVISOS[+b.dataset.i]; selectPoint(it.p); setHours(Math.max(0, Math.min(SPAN, it.h))); });
  const con = new Set(); dias.forEach(x => x.lista.forEach(it => con.add(it.p)));
  // plegado: solo el contador; los puntos se marcan en rojo únicamente con el panel abierto (para no distraer)
  const abierto = !!$("avisoGrp").open;
  PUNTOS.forEach(p => p.el && p.el.classList.toggle("aviso", abierto && con.has(p)));
  const cnt = $("avisoCount"); cnt.textContent = con.size ? con.size + (con.size === 1 ? " punto" : " puntos") : "0";
  cnt.className = "cnt" + (con.size ? "" : " cero"); cnt.title = con.size ? "Puntos con aviso en los próximos 6 días" : "Sin avisos";
  $("avisoNote").innerHTML = `Puntos marcados en rojo en el mapa. Viento del modelo en su malla (${Object.keys(MODELS).join(", ")}): suaviza el relieve, en abras, cumbres y quebradas el viento real puede ser mayor.${hayRafaga() ? ` Ráfaga: solo ECMWF (GFS y ETA no la traen en tus archivos)${finRafaga()}.` : ""} Clic en un aviso para ver el punto a esa hora.`;
  if (selected) selectPoint(selected);
}
let AVISOS = [];
const hayRafaga = () => Object.values(MODELS).some(m => m.steps[0] && m.steps[0].g10);
function finRafaga() {         // Open-Meteo da la ráfaga del ECMWF solo hasta ~+90 h: decir hasta cuándo hay
  const m = Object.values(MODELS).find(x => x.steps[0] && x.steps[0].g10); if (!m) return "";
  let last = null;
  for (let k = 1; k < m.steps.length; k++) { const a = m.steps[k].g10; if (a.some(v => v === v)) last = k; else if (last !== null) break; }
  if (last === null || m.abs[last] >= SPAN) return "";
  const d = new Date(T0 + (m.abs[last] - 5) * 3.6e6);
  return `, disponible hasta el ${DIAS[d.getUTCDay()]} ${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, "0")} h`;
}
// Días de 7 h a 7 h local (12Z a 12Z), como el reporte de las estaciones:
// Tmín = noche que termina a las 7 h del día (00Z–12Z), Tmáx = de 7 a 19 h (12Z–00Z), lluvia = 7 h del día a 7 h del siguiente.
function daily(ser) {
  const out = [];
  for (let d = 0; d < 6; d++) {
    const h = d * 24, date = new Date(T0 + d * 864e5);
    const entre = (a, b) => ser.filter(s => s.h >= a && s.h <= b && s.t === s.t);
    const noche = entre(h, h + 12), dia = entre(h + 12, h + 24), dia24 = entre(h + 12, h + 36);
    const pp = ser.filter(s => s.h > h + 12 && s.h <= h + 36);
    const full = ser.length && ser[0].h <= h && ser[ser.length-1].h >= h + 36;
    const gs = dia24.map(s => s.g).filter(g => g === g);
    const nubs = dia.map(s => 100 * (1 - (1 - (s.l || 0) / 100) * (1 - (s.mm || 0) / 100)));
    out.push(noche.length || dia.length ? {d, date, full,
      tx: dia.length ? Math.max(...dia.map(s => s.t)) : NaN, tn: noche.length ? Math.min(...noche.map(s => s.t)) : NaN,
      pp: pp.length ? pp.reduce((x, s) => x + s.pr, 0) : NaN, nub: nubs.length ? nubs.reduce((a, b) => a + b, 0) / nubs.length : NaN,
      wx: dia24.length ? Math.max(...dia24.map(s => s.w)) : NaN, gx: gs.length ? Math.max(...gs) : NaN} : {d, date, full: false});
  }
  return out;
}
const codigo = pp => pp < 1 ? "A" : pp < 5 ? "B" : pp <= 10 ? "C" : "D";
// Texto del día según la nubosidad baja+media de día (7–19 h) y la lluvia (mismos cortes que herramientas/pronostico.py)
function frase(nub, pp) {
  let cielo = nub !== nub || nub == null ? "Cielo" : nub < 20 ? "Cielo despejado" : nub < 45 ? "Cielo con nubes dispersas" : nub < 75 ? "Cielo nublado parcial" : "Cielo nublado";
  if (pp !== pp || pp == null || pp < 0.3) return cielo;
  if (cielo === "Cielo despejado" || cielo === "Cielo") cielo = "Cielo con nubes dispersas";
  if (pp >= 5 && cielo === "Cielo con nubes dispersas") cielo = "Cielo nublado parcial";      // lluvia de 5 mm o más: al menos nublado parcial
  return cielo + (pp < 1 ? " con lloviznas aisladas" : pp < 5 ? " con lluvia ligera" : pp < 10 ? " con lluvia ligera a moderada" : pp < 20 ? " con lluvia moderada" : " con lluvia moderada a fuerte");
}
const nubTxt = n => n == null || n !== n ? "—" : n < 20 ? "Despejado" : n < 45 ? "Nubes dispersas" : n < 75 ? "Nublado parcial" : "Nublado";

function selectPoint(p) {
  selected = p; PUNTOS.forEach(q => q.el.classList.toggle("sel", q === p));
  $("point").hidden = false;
  $("ptName").textContent = p.nombre;
  $("ptMeta").textContent = `${p.lat.toFixed(3)}°, ${p.lon.toFixed(3)}° · ${Math.round(p.g * 1000)} m (relieve)`;
  p.ser = serAll(p);
  const D = {}; for (const k in MODELS) D[k] = daily(p.ser[k]);
  const mods = Object.keys(MODELS);
  const rd = v => v === v && v != null ? Math.round(v) : "—";
  let html = `<thead><tr><th>Día</th>${mods.map(k => `<th style="color:${MCOL[k]}">${k}</th>`).join("")}<th title="Código y texto según el modelo elegido arriba">Texto ${model}</th></tr></thead><tbody>`;
  for (let i = 0; i < 6; i++) {
    const d = D[mods[0]][i].d, date = D[mods[0]][i].date;
    const cur = d >= 1 && d <= 3;
    html += `<tr><td class="${cur?"cur":""}">${DIAS[date.getUTCDay()]} ${String(date.getUTCDate()).padStart(2,"0")}</td>`;
    for (const k of mods) { const r = D[k][i];
      html += r.tx === undefined ? `<td class="${cur?"cur":""}">—</td>` : `<td class="${cur?"cur":""}"><span class="mx">${rd(r.tx)}</span>/<span class="mn">${rd(r.tn)}</span> <span class="pp">${r.pp === r.pp ? r.pp.toFixed(1) : "—"}</span>${r.full?"":"*"}<span class="vv${r.wx >= UMB_W || r.gx >= UMB_G ? " warn" : ""}" title="Viento medio máx. a 10 m${r.gx === r.gx ? " / ráfaga máx." : ""}">${rd(r.wx)}${r.gx === r.gx ? "/" + Math.round(r.gx) : ""} m/s</span></td>`; }
    const e = D[model] && D[model][i]; const c = e && e.pp === e.pp && e.pp !== undefined ? codigo(e.pp) : "";
    html += `<td class="${cur?"cur":""}">${c ? `<span class="code" title="${model}: ${frase(e.nub, e.pp)} (nubes bajas+medias ${Math.round(e.nub)} %, lluvia ${e.pp.toFixed(1)} mm)">${c}</span><span class="vv">${nubTxt(e.nub)}</span>` : ""}</td></tr>`;
  }
  $("daily").innerHTML = html + "</tbody>";
  $("dailyNote").innerHTML = `Por modelo: <span class="mx">Tmáx</span>/<span class="mn">Tmín</span> °C y <span class="pp">lluvia</span> mm del día, corregido a la altitud del relieve. <b>Día de 7 h a 7 h</b>, como las estaciones: Tmín = noche que termina a las 7 h, Tmáx = de 7 a 19 h, lluvia = de 7 h a 7 h del día siguiente. <b>*</b> día incompleto en ese modelo. <b>Texto ${model}</b>: letra según la lluvia de ese modelo (A &lt;1 mm, B 1–5, C 5–10, D &gt;10) y nubosidad baja+media de día; pasa el cursor sobre la letra para el texto completo. Cambia con el modelo elegido arriba. Debajo de cada valor: viento medio máx. a 10 m (y ráfaga máx. en ECMWF) en m/s; <b style="color:#ff6b57">rojo</b> = supera el umbral de aviso.`;
  const sp = PRON && sitioDePunto(p);
  $("ptPron").hidden = !sp; if (sp) $("ptPron").onclick = () => abrirPron(sp.id);
  const lat = p.lat.toFixed(3), lon = p.lon.toFixed(3);
  $("ptLinks").innerHTML = [
    ["Windy", `https://www.windy.com/${lat}/${lon}?${lat},${lon},10`],
    ["Ventusky", `https://www.ventusky.com/?p=${lat};${lon};9`],
    ["Satélite GOES (NOAA)", "https://www.star.nesdis.gov/GOES/sector.php?sat=G19&sector=nsa"],
    ["SENAMHI pronóstico", "https://www.senamhi.gob.pe/?p=pronostico-meteorologico"]
  ].map(([t, u]) => `<a href="${u}" target="_blank" rel="noopener">${t} ↗</a>`).join("");
  drawMeteo();
}
$("closePt").onclick = () => { $("point").hidden = true; selected = null; PUNTOS.forEach(q => q.el.classList.remove("sel")); };

// ---------- Meteograma ----------
const MCOL = {GFS: "#ff8a4c", ETA: "#c7a3ff", WRF: "#7be0a8", ECMWF: "#4fc3e8"};
function drawMeteo() {
  if (!selected) return;
  const cv = $("meteo"), dpr = Math.min(2, devicePixelRatio), W = cv.clientWidth, H = cv.clientHeight;
  cv.width = W * dpr; cv.height = H * dpr; const c = cv.getContext("2d"); c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, W, H);
  const L = 30, R = W - 8, X = h => L + (h / SPAN) * (R - L);
  const tTop = 8, tBot = 128, cTop = 152, cRow = 13, pTop = 206, pBot = 270;
  const all = []; for (const k in selected.ser) selected.ser[k].forEach(s => { if (s.h >= 0 && s.h <= SPAN && s.t === s.t) all.push(s.t); });
  const tmin = Math.floor(Math.min(...all) - 1), tmax = Math.ceil(Math.max(...all) + 1);
  const Y = t => tBot - (t - tmin) / (tmax - tmin) * (tBot - tTop);
  c.font = "10px 'IBM Plex Mono', monospace"; c.fillStyle = "#8fa0b1"; c.strokeStyle = "#253342"; c.lineWidth = 1;
  // noches sombreadas y separadores de día
  for (let d = 0; d <= 6; d++) {
    const n0 = d * 24 - 5 + 18, n1 = n0 + 12;  // 18 h a 06 h local
    c.fillStyle = "rgba(0,0,0,0.22)"; c.fillRect(X(Math.max(0, n0)), tTop, Math.max(0, X(Math.min(SPAN, n1)) - X(Math.max(0, n0))), pBot - tTop);
    const md = d * 24 + 5; if (md <= SPAN) { c.strokeStyle = "#253342"; c.beginPath(); c.moveTo(X(md), tTop); c.lineTo(X(md), pBot + 4); c.stroke(); }
    const date = new Date(T0 + (d * 24 + 17) * 3.6e6);
    if (d * 24 + 17 < SPAN) { c.fillStyle = "#8fa0b1"; c.textAlign = "center"; c.fillText(`${DIAS[date.getUTCDay()]} ${date.getUTCDate()}`, X(d * 24 + 17), pBot + 14); }
  }
  // eje T
  c.textAlign = "right"; c.fillStyle = "#8fa0b1";
  for (let t = Math.ceil(tmin / 5) * 5; t <= tmax; t += 5) { c.fillText(t + "°", L - 4, Y(t) + 3); c.strokeStyle = "rgba(143,160,177,0.12)"; c.beginPath(); c.moveTo(L, Y(t)); c.lineTo(R, Y(t)); c.stroke(); }
  for (const k in selected.ser) {
    c.strokeStyle = MCOL[k]; c.lineWidth = k === model ? 2.2 : 1.1; c.globalAlpha = k === model ? 1 : 0.65; c.beginPath(); let first = true;
    for (const s of selected.ser[k]) { if (s.h < 0 || s.h > SPAN || s.t !== s.t) continue; first ? c.moveTo(X(s.h), Y(s.t)) : c.lineTo(X(s.h), Y(s.t)); first = false; }
    c.stroke(); c.globalAlpha = 1;
  }
  // leyenda modelos
  c.textAlign = "left"; let lx = L + 4; for (const k in MCOL) { if (!selected.ser[k]) continue; c.fillStyle = MCOL[k]; c.fillRect(lx, tTop + 2, 10, 3); c.fillStyle = "#cfd8e1"; c.fillText(k, lx + 13, tTop + 7); lx += 13 + c.measureText(k).width + 10; }
  // franjas de nubes del modelo activo
  const ser = selected.ser[model];
  c.textAlign = "left"; c.fillStyle = "#cfd8e1";
  c.fillText(`Nubosidad · ${model} (más clara = más nubes)`, L + 2, cTop - 4);
  c.fillText(`Lluvia · ${model} (mm cada 3 h)`, L + 2, pTop - 2);
  ["hh", "mm", "l"].forEach((f, r) => {
    c.fillStyle = "#8fa0b1"; c.textAlign = "right"; c.fillText(["Alta", "Med", "Baja"][r], L - 4, cTop + r * cRow + 10);
    for (let k = 1; k < ser.length; k++) {
      const s = ser[k], p = ser[k-1]; if (s.h < 0 || p.h > SPAN) continue; const v = (s[f] || 0) / 100;
      c.fillStyle = `rgba(230,236,242,${0.06 + 0.9 * v})`; c.fillRect(X(Math.max(0, p.h)), cTop + r * cRow, X(Math.min(SPAN, s.h)) - X(Math.max(0, p.h)) + 0.5, cRow - 2);
    }
  });
  // lluvia
  const pm = Math.max(4, ...ser.filter(s => s.h >= 0 && s.h <= SPAN).map(s => s.pr * 3 / s.intv));
  c.fillStyle = "#8fa0b1"; c.textAlign = "right"; c.fillText(pm.toFixed(0), L - 4, pTop + 8); c.fillText("mm", L - 4, pTop + 20); c.fillText("/3h", L - 4, pTop + 30);
  for (let k = 1; k < ser.length; k++) {
    const s = ser[k], p = ser[k-1]; if (s.h < 0 || p.h > SPAN) continue; const r = s.pr * 3 / s.intv; if (r < 0.05) continue;
    const y = pBot - r / pm * (pBot - pTop); c.fillStyle = "#5aa8ff"; c.fillRect(X(Math.max(0, p.h)) + 0.5, y, X(Math.min(SPAN, s.h)) - X(Math.max(0, p.h)) - 1, pBot - y);
  }
  c.strokeStyle = "#253342"; c.beginPath(); c.moveTo(L, pBot); c.lineTo(R, pBot); c.stroke();
  // hora actual
  c.strokeStyle = "#e3eaf1"; c.lineWidth = 1.2; c.beginPath(); c.moveTo(X(hours), tTop); c.lineTo(X(hours), pBot); c.stroke();
  const cur = ser.reduce((a, s) => Math.abs(s.h - hours) < Math.abs(a.h - hours) ? s : a, ser[0]);
  c.fillStyle = "#e3eaf1"; c.textAlign = hours > SPAN * 0.7 ? "right" : "left";
  c.fillText(`${cur.t.toFixed(1)}°C`, X(hours) + (hours > SPAN * 0.7 ? -4 : 4), Y(cur.t) - 4);
}
$("meteo").addEventListener("click", e => { const r = e.target.getBoundingClientRect(); const h = (e.clientX - r.left - 30) / (r.width - 38) * SPAN; setHours(Math.max(0, Math.min(SPAN, h))); });

// ---------- Pronóstico aproximado: observado (estaciones Voz y Data) + pronóstico calibrado ----------
// Datos de herramientas/pronostico.py (data/pronostico.js). Día de 7 h a 7 h. Por variable: si hay observado se muestra
// el observado; si no, el consenso de los modelos calibrados. Así se ve la continuidad: primero lo medido, luego lo que viene.
let PRON = null, pronSitio = null, pronTab = "punto";
const fmtF = s => { const d = new Date(s + "T12:00:00Z"); return `${DIAS[d.getUTCDay()]} ${String(d.getUTCDate()).padStart(2, "0")}`; };
const ppF = v => v == null || v !== v ? "—" : v > 0 && v < 0.1 ? "T" : v.toFixed(1);
const tF = v => v == null || v !== v ? "—" : v.toFixed(1);
const PV = [["tn", "Tmín", "#7aa7ff"], ["tx", "Tmáx", "#ff8a4c"], ["pp", "Lluvia", "#5aa8ff"]];
function pronValor(s, fe, i) {                  // {v, ob}: observado si existe, si no el pronóstico calibrado
  const o = s.obs[fe]; if (o && o[i] != null) return {v: o[i], ob: true};
  const p = s.pron[fe]; if (p && p.c[i] != null) return {v: p.c[i], ob: false, p};
  return null;
}
function sitioDePunto(p) {
  if (!PRON) return null;
  const s = PRON.sitios.find(x => x.id === "p:" + p.nombre); if (s) return s;
  let best = null, bd = 10;                     // punto temporal: estación a menos de 10 km
  for (const x of PRON.sitios) { const d = 111.2 * Math.hypot(x.lat - p.lat, (x.lon - p.lon) * Math.cos(p.lat * Math.PI / 180)); if (d < bd) { bd = d; best = x; } }
  return best;
}
function abrirPron(id) {
  $("pron").hidden = false;
  if (id) { const s = PRON.sitios.find(x => x.id === id); if (s) { pronSitio = s; $("pronSitio").value = id; } setPronTab("punto"); }
  else setPronTab(pronTab);
  $("closePron").focus();
}
function setPronTab(t) {
  pronTab = t;
  [["punto", "pronPunto"], ["resumen", "pronResumen"], ["modelos", "pronModelos"]].forEach(([k, id]) => $(id).hidden = k !== t);
  seg("segPron", [["punto", "Por lugar"], ["resumen", "Resumen de tus puntos"], ["modelos", "¿Qué modelo va mejor?"]], () => pronTab, setPronTab);
  if (t === "punto") renderPronPunto(); else if (t === "resumen") renderPronResumen(); else renderPronModelos();
}
function initPron(P) {
  PRON = P;
  const sel = $("pronSitio"), grupos = {};
  for (const s of P.sitios) { const g = s.punto ? "Tus puntos de pronóstico" : "Estaciones · " + s.dep; (grupos[g] = grupos[g] || []).push(s); }
  sel.innerHTML = Object.entries(grupos).map(([g, l]) => `<optgroup label="${g}">${l.map(s => `<option value="${s.id}">${s.nombre}${s.punto && s.est && s.est.toLowerCase() !== s.nombre.toLowerCase() ? " (est. " + s.est + ")" : ""}${!s.punto ? " · " + s.prov : ""}</option>`).join("")}</optgroup>`).join("");
  pronSitio = P.sitios[0]; sel.value = pronSitio.id;
  sel.onchange = () => { pronSitio = P.sitios.find(x => x.id === sel.value); renderPronPunto(); };
  $("pronPorModelo").onchange = renderPronPunto; $("pronTodas").onchange = renderPronResumen;
  try { if (localStorage.getItem("pronAnt") === "0") $("pronAnt").checked = false; } catch (e) {}
  $("pronAnt").onchange = () => { try { localStorage.setItem("pronAnt", $("pronAnt").checked ? "1" : "0"); } catch (e) {} renderPronPunto(); };
  $("pronAnt").closest("label").hidden = !Object.keys(P.anteriores || {}).length;
  $("bPron").hidden = false; $("bPron").onclick = () => abrirPron(selected ? (sitioDePunto(selected) || {}).id : null);
  $("closePron").onclick = () => { $("pron").hidden = true; };
  addEventListener("keydown", e => { if (e.key === "Escape" && !$("pron").hidden) $("pron").hidden = true; });
  const cor = Object.entries(P.corridas).map(([m, d]) => m + " " + d.slice(8, 10) + "/" + d.slice(5, 7)).join(", ");
  $("pronSub").textContent = `Observado hasta ${P.ult_obs ? fmtF(P.ult_obs) : "—"} · corridas 00Z: ${cor} · actualizado ${P.gen}`;
}
// corridas anteriores a mostrar (de la más nueva a la más vieja) con su color; [] si la casilla está apagada
const ANT_COL = ["#ffd166", "#c77dff", "#7be0a8"];
function corridasAnt(s) {
  if (!PRON || !$("pronAnt").checked) return [];
  return Object.keys(PRON.anteriores || {}).sort().reverse().slice(0, ANT_COL.length).map((r, i) => ({r, col: ANT_COL[i], d: (s && s.ant && s.ant[r]) || {}}));
}
function leyendaPron(s) {
  const dd = r => r.slice(8, 10) + "/" + r.slice(5, 7), hace = r => Math.round((Date.parse(PRON.hoy) - Date.parse(r)) / 864e5);
  $("pronLeg").innerHTML = `<span><i style="border-color:#ff8a4c"></i>Tmáx observada</span><span><i class="dash" style="border-color:#ff8a4c"></i>Tmáx pronosticada</span>` +
    `<span><i style="border-color:#7aa7ff"></i>Tmín observada</span><span><i class="dash" style="border-color:#7aa7ff"></i>Tmín pronosticada</span>` +
    `<span><i class="box" style="background:#5aa8ff;border-color:#5aa8ff"></i>Lluvia observada</span><span><i class="box" style="background:rgba(90,168,255,.25);border-color:#5aa8ff"></i>Lluvia pronosticada</span>` +
    `<span><i class="box" style="background:rgba(143,160,177,.25);border-color:transparent"></i>Rango de los modelos</span>` +
    corridasAnt(s).filter(a => Object.keys(a.d).length).map(a => `<span><i class="dash" style="border-color:${a.col}"></i>Pronóstico de la corrida del ${dd(a.r)} (hace ${hace(a.r)} día${hace(a.r) > 1 ? "s" : ""})</span>`).join("");
}
function renderPronPunto() {
  const s = pronSitio, P = PRON; if (!s) return;
  $("pronMeta").textContent = `${s.dep}${s.prov ? " · " + s.prov : ""} · ${s.alt} m${s.est ? " · estación " + s.est : " · sin estación cercana: se calibra con el sesgo de toda la región"}`;
  leyendaPron(s); drawPron();
  const ANT = corridasAnt(s), ddA = r => r.slice(8, 10) + "/" + r.slice(5, 7);
  const mods = P.modelos, verM = $("pronPorModelo").checked, iH = P.fechas.indexOf(P.hoy);
  let h = `<thead><tr><th>Día</th><th>Tmín °C</th><th>Tmáx °C</th><th>Lluvia mm</th><th title="Nubes bajas y medias de 7 a 19 h">Nubosidad</th><th title="Proporción de modelos (pesada por su acierto) con 1 mm o más">Prob. lluvia</th>${verM ? mods.map(m => `<th style="color:${MCOL[m]}">${m}<br>mín/máx lluvia</th>`).join("") : ""}<th>Texto</th></tr></thead><tbody>`;
  P.fechas.forEach((fe, i) => {
    const o = s.obs[fe], p = s.pron[fe]; if (!o && !p) return;
    const vals = PV.map((_, k) => pronValor(s, fe, k));
    const nOb = vals.filter(v => v && v.ob).length, nPr = vals.filter(v => v && !v.ob).length;
    const bd = nOb && nPr ? `<span class="badge mix" title="Lo ya medido es observado; el resto, pronóstico">obs+pron</span>` : nOb ? `<span class="badge ob">obs</span>` : `<span class="badge pr">pron</span>`;
    const cel = (k, fmt) => { const v = vals[k]; if (!v) return "<td>—</td>";
      if (v.ob) {                                  // observado: lo que habían pronosticado las corridas anteriores, al pasar el mouse
        const prev = ANT.filter(a => a.d[fe] && a.d[fe][k] != null).map(a => `corrida ${ddA(a.r)}: ${fmt(a.d[fe][k])}`);
        return `<td class="ob"${prev.length ? ` title="Pronosticado — ${prev.join(" · ")}"` : ""}>${fmt(v.v)}</td>`;
      }
      const a = v.p.rng[2 * k], b = v.p.rng[2 * k + 1];
      return `<td class="pr" title="Consenso calibrado. Rango de los modelos: ${fmt(a)} a ${fmt(b)}">${fmt(v.v)}<small>${fmt(a)}–${fmt(b)}</small></td>`; };
    const nub = p ? p.c[3] : null, prob = p ? p.c[4] : null;
    h += `<tr class="${fe === P.hoy ? "hoy" : ""}${i === iH && iH > 0 ? " sep" : ""}"><td>${fmtF(fe)}${fe === P.hoy ? " · hoy" : ""}${bd}</td>${cel(0, tF)}${cel(1, tF)}${cel(2, ppF)}` +
         `<td>${nub == null ? "—" : nubTxt(nub) + `<small>${nub} %</small>`}</td><td>${prob == null ? "—" : prob + " %"}</td>`;
    if (verM) h += mods.map(m => { const x = p && p.m[m]; return x ? `<td><span class="mn">${tF(x[0])}</span>/<span class="mx">${tF(x[1])}</span> <span class="pp">${ppF(x[2])}</span><small>sin calibrar ${tF(x[4])}/${tF(x[5])} ${ppF(x[6])}</small></td>` : "<td>—</td>"; }).join("");
    h += `<td style="white-space:normal;min-width:150px;text-align:left">${p && nPr ? p.txt : ""}</td></tr>`;
  });
  $("pronTbl").innerHTML = h + "</tbody>";
  // qué se corrige en este lugar
  const ses = Object.entries(s.sesgo || {}).filter(([, v]) => v[2] > 0);
  const lado = (v, n) => Math.abs(v) < 0.3 ? `${n} casi sin sesgo` : `${n} ${v > 0 ? "más cálida" : "más fría"} ${Math.abs(v).toFixed(1)} °C`;
  $("pronNota").innerHTML = (s.mejor ? `<b>En este lugar va mejor ${s.mejor.m}</b> (error medio de Tmáx y Tmín ${s.mejor.mae} °C en ${s.mejor.n} comparaciones). ` : "") +
    (ses.length ? "Corrección aplicada (lo que cada modelo suele errar aquí): " + ses.map(([m, v]) => `<b>${m}</b> ${lado(v[1], "Tmáx")}, ${lado(v[0], "Tmín")} (${v[2]} datos)`).join(" · ") + ". " :
                  (s.est ? "Aún no hay días suficientes para corregir los modelos en esta estación: se usa la corrección de la región si existe. " : "")) +
    `<br><b>Día de 7 h a 7 h</b>: Tmín = noche que termina a las 7 h; Tmáx = de 7 a 19 h; lluvia = de 7 h a 7 h del día siguiente (como la red Voz y Data). ` +
    `<b>Negrita</b> = observado; <i>cursiva</i> = pronóstico (consenso de los modelos calibrados, con su rango debajo). T = traza. ` +
    `Los modelos se llevan a la altitud real de la estación (6.5 °C/km) y se les resta el error medio de los últimos 30 días; la lluvia se escala según cuánto llovió de verdad frente a lo pronosticado en la región. Nubosidad = nubes bajas y medias juntas, de 7 a 19 h.`;
}
function drawPron() {
  const s = pronSitio, P = PRON, cv = $("pronCv"); if (!s || $("pron").hidden || pronTab !== "punto") return;
  const dpr = Math.min(2, devicePixelRatio), W = cv.clientWidth, H = cv.clientHeight;
  cv.width = W * dpr; cv.height = H * dpr; const c = cv.getContext("2d"); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, W, H);
  const F = P.fechas, n = F.length, L = 34, R = W - 8, cw = (R - L) / n, X = i => L + cw * (i + 0.5);
  const tTop = 16, tBot = H - 128, pTop = H - 104, pBot = H - 44, nTop = H - 36, nH = 13;
  const iH = Math.max(0, F.indexOf(P.hoy));
  // rango de temperatura
  const all = [];
  const ANT = corridasAnt(s);
  F.forEach(fe => { for (const k of [0, 1]) { const v = pronValor(s, fe, k); if (v) all.push(v.v); const p = s.pron[fe]; if (p && !(v && v.ob)) { if (p.rng[2*k] != null) all.push(p.rng[2*k], p.rng[2*k+1]); }
    for (const a of ANT) if (a.d[fe] && a.d[fe][k] != null) all.push(a.d[fe][k]); } });
  if (!all.length) { c.fillStyle = "#8fa0b1"; c.fillText("Sin datos para este lugar", L, 40); return; }
  const tmin = Math.floor(Math.min(...all) - 1), tmax = Math.ceil(Math.max(...all) + 1.5);
  const Y = t => tBot - (t - tmin) / (tmax - tmin) * (tBot - tTop);
  c.font = "10px 'IBM Plex Mono', monospace";
  // zona de pronóstico y separador "hoy"
  const xH = L + cw * iH;
  c.fillStyle = "rgba(79,195,232,.06)"; c.fillRect(xH, tTop - 12, R - xH, pBot - tTop + 12);
  c.strokeStyle = "#4fc3e8"; c.setLineDash([3, 3]); c.beginPath(); c.moveTo(xH, tTop - 12); c.lineTo(xH, pBot); c.stroke(); c.setLineDash([]);
  c.fillStyle = "#7be0a8"; c.textAlign = "right"; c.fillText("← observado", xH - 4, tTop - 4);
  c.fillStyle = "#4fc3e8"; c.textAlign = "left"; c.fillText("pronóstico →", xH + 4, tTop - 4);
  // eje
  const paso = tmax - tmin > 14 ? 5 : 2;
  c.textAlign = "right"; c.fillStyle = "#8fa0b1";
  for (let t = Math.ceil(tmin / paso) * paso; t <= tmax; t += paso) { c.fillText(t + "°", L - 4, Y(t) + 3); c.strokeStyle = "rgba(143,160,177,0.12)"; c.beginPath(); c.moveTo(L, Y(t)); c.lineTo(R, Y(t)); c.stroke(); }
  // temperaturas: rango de los modelos, línea (continua = observado, a trazos = pronóstico) y valores
  for (const [k, col, arriba] of [[1, "#ff8a4c", true], [0, "#7aa7ff", false]]) {
    c.fillStyle = k ? "rgba(255,138,76,.16)" : "rgba(122,167,255,.16)";
    const band = F.map((fe, i) => { const p = s.pron[fe], v = pronValor(s, fe, k); return p && v && !v.ob && p.rng[2*k] != null ? [X(i), Y(p.rng[2*k]), Y(p.rng[2*k+1])] : null; });
    for (let i = 0; i < n; i++) if (band[i]) { const a = band[i], b = band[i + 1];
      if (b) { c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.lineTo(b[0], b[2]); c.lineTo(a[0], a[2]); c.closePath(); c.fill(); }
      else c.fillRect(a[0] - 3, a[2], 6, a[1] - a[2]); }
    // corridas anteriores: línea fina a trazos de su color (debajo de la actual), con puntitos
    for (const a of ANT) {
      const q = F.map((fe, i) => a.d[fe] && a.d[fe][k] != null ? [X(i), Y(a.d[fe][k])] : null);
      c.strokeStyle = a.col; c.lineWidth = 1.4; c.setLineDash([2, 3]); c.globalAlpha = 0.9;
      for (let i = 0; i < n - 1; i++) if (q[i] && q[i + 1]) { c.beginPath(); c.moveTo(q[i][0], q[i][1]); c.lineTo(q[i + 1][0], q[i + 1][1]); c.stroke(); }
      c.setLineDash([]); c.fillStyle = a.col;
      q.forEach(p => { if (p) { c.beginPath(); c.arc(p[0], p[1], 2.2, 0, 7); c.fill(); } });
      c.globalAlpha = 1;
    }
    const pts = F.map((fe, i) => { const v = pronValor(s, fe, k); return v ? {x: X(i), y: Y(v.v), v: v.v, ob: v.ob} : null; });
    c.strokeStyle = col; c.lineWidth = 2;
    for (let i = 0; i < n - 1; i++) { const a = pts[i], b = pts[i + 1]; if (!a || !b) continue;
      c.setLineDash(a.ob && b.ob ? [] : [5, 4]); c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke(); }
    c.setLineDash([]);
    pts.forEach(p => { if (!p) return;
      c.beginPath(); c.arc(p.x, p.y, 3.5, 0, 7); if (p.ob) { c.fillStyle = col; c.fill(); } else { c.fillStyle = "#0e161f"; c.fill(); c.lineWidth = 1.6; c.stroke(); }
      if (cw > 26) { c.fillStyle = p.ob ? "#e3eaf1" : col; c.textAlign = "center"; c.fillText(p.v.toFixed(cw > 40 ? 1 : 0), p.x, arriba ? p.y - 7 : p.y + 14); } });
  }
  // lluvia
  const pv = F.map((fe, i) => pronValor(s, fe, 2));
  const pm = Math.max(5, ...pv.filter(Boolean).map(v => v.v), ...F.map(fe => s.pron[fe] && s.pron[fe].rng[5] || 0),
                      ...ANT.flatMap(a => F.map(fe => a.d[fe] && a.d[fe][2] || 0)));
  const YP = v => pBot - Math.min(1, v / pm) * (pBot - pTop);
  c.fillStyle = "#8fa0b1"; c.textAlign = "right"; c.fillText(Math.round(pm) + "", L - 4, pTop + 8); c.fillText("mm", L - 4, pTop + 20);
  c.textAlign = "left"; c.fillStyle = "#cfd8e1"; c.fillText("Lluvia del día (7 h a 7 h)", L + 2, pTop - 6);
  pv.forEach((v, i) => { if (!v) return;
    const x = X(i) - cw * 0.28, w = cw * 0.56, y = YP(v.v);
    const p = s.pron[F[i]];
    if (!v.ob && p && p.rng[5] != null) { c.strokeStyle = "rgba(143,160,177,.6)"; c.beginPath(); c.moveTo(X(i), YP(p.rng[4])); c.lineTo(X(i), YP(p.rng[5])); c.stroke(); }
    if (v.ob) { c.fillStyle = "#5aa8ff"; c.fillRect(x, y, w, pBot - y); }
    else { c.fillStyle = "rgba(90,168,255,.25)"; c.fillRect(x, y, w, pBot - y); c.strokeStyle = "#5aa8ff"; c.lineWidth = 1; c.strokeRect(x + 0.5, y + 0.5, w - 1, pBot - y - 1); }
    if (cw > 24 && (v.v >= 0.05)) { c.fillStyle = v.ob ? "#e3eaf1" : "#9ccaff"; c.textAlign = "center"; c.fillText(ppF(v.v), X(i), y - 3); }
  });
  // lluvia de las corridas anteriores: una marca horizontal de su color a la altura de lo pronosticado
  F.forEach((fe, i) => ANT.forEach((a, j) => {
    const v = a.d[fe] && a.d[fe][2]; if (v == null) return;
    const w = cw * 0.7, x = X(i) - w / 2, y = Math.min(pBot - 1.5, YP(v));
    c.strokeStyle = a.col; c.lineWidth = 2; c.setLineDash(j ? [3, 2] : []); c.beginPath(); c.moveTo(x, y); c.lineTo(x + w, y); c.stroke(); c.setLineDash([]);
  }));
  c.strokeStyle = "#253342"; c.beginPath(); c.moveTo(L, pBot); c.lineTo(R, pBot); c.stroke();
  // nubosidad baja+media (solo pronóstico)
  c.fillStyle = "#8fa0b1"; c.textAlign = "right"; c.fillText("Nub.", L - 4, nTop + 10);
  F.forEach((fe, i) => { const p = s.pron[fe]; if (!p || p.c[3] == null) return;
    const v = p.c[3] / 100; c.fillStyle = `rgba(230,236,242,${0.06 + 0.85 * v})`; c.fillRect(L + cw * i + 1, nTop, cw - 2, nH);
    if (cw > 30) { c.fillStyle = v > 0.5 ? "#0b1118" : "#e3eaf1"; c.textAlign = "center"; c.fillText(p.c[3] + "%", X(i), nTop + 10); } });
  // días
  F.forEach((fe, i) => { c.fillStyle = fe === P.hoy ? "#4fc3e8" : "#8fa0b1"; c.textAlign = "center";
    const t = fmtF(fe); c.fillText(cw > 38 ? t : t.slice(-2), X(i), H - 8); });
}
function renderPronResumen() {
  const P = PRON, todas = $("pronTodas").checked, iH = Math.max(0, P.fechas.indexOf(P.hoy));
  const ayer = P.fechas[iH - 1], dias = P.fechas.slice(iH, iH + 4);
  const lista = P.sitios.filter(s => todas || s.punto);
  const cel = (s, fe) => {
    const v = PV.map((_, k) => pronValor(s, fe, k)), p = s.pron[fe];
    if (!v.some(Boolean)) return "<td>—</td>";
    const f = (x, fmt, cls) => x ? `<span class="${cls}"${x.ob ? ' style="font-weight:700;font-style:normal"' : ' style="font-style:italic"'}>${fmt(x.v)}</span>` : "—";
    return `<td title="${p ? p.txt : "observado"}">${f(v[1], x => Math.round(x), "mx")}/${f(v[0], x => Math.round(x), "mn")} ${f(v[2], ppF, "pp")}<small>${p && p.c[3] != null ? nubTxt(p.c[3]) : "obs"}${p && p.c[4] != null ? " · " + p.c[4] + "% lluvia" : ""}</small></td>`;
  };
  let h = `<thead><tr><th>Lugar</th>${ayer ? `<th>${fmtF(ayer)}<br>ayer</th>` : ""}${dias.map(fe => `<th>${fmtF(fe)}${fe === P.hoy ? "<br>hoy" : ""}</th>`).join("")}</tr></thead><tbody>`;
  for (const s of lista) h += `<tr data-id="${s.id}"><td>${s.nombre}<small>${s.alt} m${s.mejor ? " · mejor " + s.mejor.m : ""}</small></td>${ayer ? cel(s, ayer) : ""}${dias.map(fe => cel(s, fe)).join("")}</tr>`;
  $("pronRes").innerHTML = h + "</tbody>";
  $("pronRes").querySelectorAll("tbody tr").forEach(tr => tr.onclick = () => { pronSitio = P.sitios.find(x => x.id === tr.dataset.id); $("pronSitio").value = pronSitio.id; setPronTab("punto"); });
  $("pronResNota").innerHTML = `<span class="mx">Tmáx</span>/<span class="mn">Tmín</span> °C y <span class="pp">lluvia</span> mm; <b>negrita</b> = observado, <i>cursiva</i> = pronóstico calibrado. Debajo: nubosidad baja+media de día y probabilidad de lluvia (≥1 mm). Clic en una fila para ver el detalle.`;
}
function renderPronModelos() {
  const P = PRON, R = P.rank || {}, mods = P.modelos;
  const mejor = (v, campo = "mae_cal", mayor = false) => {
    const c = mods.filter(m => R[v] && R[v][m] && R[v][m].n >= 20);
    if (c.length < 2) return null;
    return c.reduce((a, b) => (mayor ? R[v][b][campo] > R[v][a][campo] : R[v][b][campo] < R[v][a][campo]) ? b : a);
  };
  const tarj = (tit, v, unid) => { const m = mejor(v); if (!m) return `<div><span>${tit}</span><b>—</b><span>faltan días para comparar</span></div>`;
    const x = R[v][m]; return `<div><span>${tit}: va mejor</span><b style="color:${MCOL[m]}">${m}</b><span>error medio ${x.mae_cal} ${unid} (${x.n} comparaciones)</span></div>`; };
  $("pronMejor").innerHTML = tarj("Tmáx", "tx", "°C") + tarj("Tmín", "tn", "°C") + tarj("Lluvia", "pp", "mm");
  const best = {tx: mejor("tx"), tn: mejor("tn"), pp: mejor("pp"), ac: mejor("pp", "acierto", true)};
  const cel = (v, m, fmt) => { const x = R[v] && R[v][m]; if (!x) return "<td>—</td><td>—</td>";
    return `<td class="${best[v] === m ? "best" : ""}">${x.mae_cal.toFixed(1)}<small>sin calibrar ${x.mae.toFixed(1)}</small></td><td>${fmt(x)}</td>`; };
  const sg = x => (x.sesgo > 0 ? "+" : "") + x.sesgo.toFixed(1);
  let h = `<thead><tr><th>Modelo</th><th>Tmáx error °C</th><th>Tmáx sesgo</th><th>Tmín error °C</th><th>Tmín sesgo</th><th>Lluvia error mm</th><th title="Días bien clasificados como con lluvia (≥1 mm) o sin lluvia">Acierto lluvia sí/no</th><th>Peso en el consenso (Tmáx/Tmín/lluvia)</th></tr></thead><tbody>`;
  for (const m of mods) {
    const pp = R.pp && R.pp[m];
    h += `<tr><td style="color:${MCOL[m]};font-weight:700">${m}</td>${cel("tx", m, sg)}${cel("tn", m, sg)}` +
         (pp ? `<td class="${best.pp === m ? "best" : ""}">${pp.mae_cal.toFixed(1)}<small>sin calibrar ${pp.mae.toFixed(1)}</small></td><td class="${best.ac === m ? "best" : ""}">${pp.acierto} %<small>llovió ${Math.round(pp.obs)} / modelo ${Math.round(pp.mod)} mm</small></td>` : "<td>—</td><td>—</td>") +
         `<td>${["tx", "tn", "pp"].map(v => { const w = P.pesos[v] || {}, tot = Object.values(w).reduce((a, b) => a + b, 0); return tot ? Math.round(100 * (w[m] || 0) / tot) + "%" : "—"; }).join(" / ")}</td></tr>`;
  }
  $("pronRank").innerHTML = h + "</tbody>";
  const vf = P.verif;
  $("pronRankNota").innerHTML = (vf ? `Comparado con las estaciones de la región entre el ${fmtF(vf[0])} y el ${fmtF(vf[1])} (${vf[2]} días con datos), plazos de 0 a 5 días. ` : "Aún no hay días para comparar. ") +
    `<b>Error</b> = diferencia media absoluta con lo observado (más bajo es mejor); en grande, después de calibrar; debajo, el modelo tal cual (ya llevado a la altitud de la estación). ` +
    `<b>Sesgo</b> = si el modelo sale más cálido (+) o más frío (−) en promedio. Cada día que se agregan observados la comparación se vuelve más confiable; con menos de una semana tómalo como indicativo. ` +
    `Un modelo solo aparece como «mejor» cuando hay al menos dos con 20 comparaciones o más.`;
}

// ---------- Tooltip (lectura bajo el cursor) ----------
const ray = new THREE.Raycaster(), mouse = new THREE.Vector2(); let lastHover = 0;
// Recorre el rayo sobre el relieve (pasos de ~2 km y bisección) en vez de probar ~97 000 triángulos
function pickTerrain(ev) {
  mouse.set(ev.clientX / innerWidth * 2 - 1, -ev.clientY / innerHeight * 2 + 1);
  ray.setFromCamera(mouse, camera);
  const o = ray.ray.origin, d = ray.ray.direction, oy = o.y / exag, dy = d.y / exag;
  const len = Math.hypot(d.x, dy, d.z), step = 2 / len, tMax = 4000 / len;
  const lon0 = DEM.lons[0], lon1 = DEM.lons[DEM.lons.length-1], lat0 = DEM.lats[0], lat1 = DEM.lats[DEM.lats.length-1];
  const below = t => { const lon = fromX(o.x + d.x * t), lat = fromZ(o.z + d.z * t); return lon >= lon0 && lon <= lon1 && lat >= lat0 && lat <= lat1 && oy + dy * t <= demAt(lon, lat); };
  for (let t = 0; t < tMax; t += step) {
    if (!below(t)) { if (oy + dy * t < 0) return null; continue; }
    {
      let a = Math.max(0, t - step), b = t;
      for (let i = 0; i < 10; i++) { const mm = (a + b) / 2; if (below(mm)) b = mm; else a = mm; }
      return {lon: fromX(o.x + d.x * b), lat: fromZ(o.z + d.z * b)};
    }
  }
  return null;
}
renderer.domElement.addEventListener("pointermove", ev => {
  if (ev.buttons || performance.now() - lastHover < 60) return; lastHover = performance.now();
  const q = pickTerrain(ev), tip = $("tip"); if (!q) { tip.hidden = true; return; }
  const m = MODELS[model], [a, b, f] = bracket(m, hours), g = demAt(q.lon, q.lat);
  const at = (name, sc) => { const A = bil(m.lons, m.lats, m.steps[a][name], q.lon, q.lat, sc), B = bil(m.lons, m.lats, m.steps[b][name], q.lon, q.lat, sc); return A + (B - A) * f; };
  const T = at("t2", 0.1) + (bil(m.lons, m.lats, m.hgt, q.lon, q.lat) - g * 1000) * LAPSE;
  // ΔT 24 h en el punto (misma corrección de altitud en ambas horas: se cancela)
  const tEn = h => { if (h < m.abs[0] - 0.01) return NaN; const [a2, b2, f2] = bracket(m, h); const A = bil(m.lons, m.lats, m.steps[a2].t2, q.lon, q.lat, 0.1), B = bil(m.lons, m.lats, m.steps[b2].t2, q.lon, q.lat, 0.1); return A + (B - A) * f2; };
  const d24 = tEn(hours) - tEn(hours - 24);
  const r = rainRate(m, q.lon, q.lat), u = at("u10", 0.1), v = at("v10", 0.1);
  const dir = (Math.atan2(-u, -v) * 180 / Math.PI + 360) % 360, card = ["N","NE","E","SE","S","SO","O","NO"][Math.round(dir / 45) % 8];
  const nat = `${Math.round(at("lcc",1))}/${Math.round(at("mcc",1))}/${Math.round(at("hcc",1))} %`;
  const wk = Math.hypot(u, v), gk = m.steps[a].g10 ? at("g10", 0.1) : NaN;
  const vtxt = `Viento 10 m ${card} ${wk.toFixed(1)} m/s${gk === gk ? ` · ráfaga ${gk.toFixed(1)} m/s` : ""}${wk >= UMB_W || gk >= UMB_G ? ` <b style="color:#ff6b57">⚠ aviso</b>` : ""}`;
  const qs = m.steps[a].q850 ? [925, 850, 700, 500].map(p => zMean(m, p) > g ? at("q" + p, 0.1).toFixed(1) : "—").join(" / ") : null;
  // w (cm/s, + ascenso) y omega (Pa/s, − ascenso) ≈ −ρ·g·w con ρ = p/(R·T) de la atmósfera estándar
  const omega = (w, p) => { const z = pHeight(p) * 1000, T = Math.max(216.65, 288.15 - 0.0065 * z); return -w * (p * 100) / (287.05 * T) * 9.80665; };
  const WL = [850, 700, 500, 300], ws = m.steps[a].w500 ? WL.map(p => zMean(m, p) > g ? at("w" + p, 100).toFixed(0) : "—").join(" / ") : null;
  const TL = [850, 500, 250].filter(p => m.steps[a]["t" + p] && m.steps[a]["ta" + p]);
  const tl = TL.length ? TL.map(p => zMean(m, p) > g ? at("t" + p, 0.1).toFixed(1) : "—").join(" / ") : null;
  const tav = TL.length ? TL.map(p => zMean(m, p) > g ? (v => (v > 0 ? "+" : "") + v.toFixed(1))(at("ta" + p, 1)) : "—").join(" / ") : null;
  const QAL = [850, 700, 500].filter(p => m.steps[a]["qa" + p]);
  const qav = QAL.length ? QAL.map(p => zMean(m, p) > g ? (v => (v > 0 ? "+" : "") + v.toFixed(1))(at("qa" + p, 1)) : "—").join(" / ") : null;
  const DVL = [925, 850, 500, 250].filter(p => m.steps[a]["dv" + p]);
  const dvs = DVL.length ? DVL.map(p => zMean(m, p) > g ? (v => v === v ? (v > 0 ? "+" : "") + v.toFixed(1) : "—")(at("dv" + p, 1)) : "—").join(" / ") : null;
  const pwt = m.steps[a].pw ? `Agua precipitable ${at("pw", 1).toFixed(0)} mm<br>` : "";
  const om = m.steps[a].w500 ? WL.map(p => zMean(m, p) > g ? omega(at("w" + p, 1), p).toFixed(2) : "—").join(" / ") : null;
  tip.innerHTML = `${q.lat.toFixed(2)}°, ${q.lon.toFixed(2)}° · ${Math.round(g * 1000)} m<br>T ${T.toFixed(1)} °C${d24 === d24 ? ` (${d24 >= 0 ? "+" : ""}${d24.toFixed(1)} en 24 h)` : ""} · lluvia ${r.toFixed(1)} mm/3h<br>Nubes baja/media/alta (${model}) ${nat}<br>${pwt}${qs ? `Rel. mezcla 925/850/700/500 ${qs} g/kg<br>` : ""}${dvs ? `Divergencia ${DVL.join("/")} ${dvs} ×10⁻⁵ s⁻¹<br>` : ""}${ws ? `w 850/700/500/300 ${ws} cm/s<br>ω 850/700/500/300 ${om} Pa/s<br>` : ""}${tl ? `T ${TL.join("/")} ${tl} °C<br>Advección T ${TL.join("/")} ${tav} °C/día<br>` : ""}${qav ? `Advección q ${QAL.join("/")} ${qav} g/kg/día<br>` : ""}${vtxt}<br>CAPE ${Math.round(at("cape",1))} J/kg${m.steps[a].slp ? ` · PNM ${at("slp", 0.1).toFixed(1)} hPa` : ""}${m.steps[a].z500 ? ` · Z500 ${Math.round(at("z500", 1))} m` : ""}`;
  tip.hidden = false; tip.style.left = Math.min(innerWidth - 270, ev.clientX + 14) + "px"; tip.style.top = (ev.clientY + 14) + "px";
});
renderer.domElement.addEventListener("pointerleave", () => $("tip").hidden = true);
renderer.domElement.addEventListener("dblclick", ev => {
  const q = pickTerrain(ev); if (!q) return;
  const p = {nombre: `Punto ${q.lat.toFixed(2)}, ${q.lon.toFixed(2)}`, lat: q.lat, lon: q.lon, tmp: true};
  PUNTOS.push(p); addPin(p); selectPoint(p);
});

// ---------- UI ----------
function seg(id, items, get, set) {
  const el = $(id); el.innerHTML = "";
  items.forEach(([v, t]) => { const b = document.createElement("button"); b.type = "button"; b.textContent = t; b.setAttribute("aria-pressed", get() === v); b.onclick = () => { set(v); [...el.children].forEach((c, i) => c.setAttribute("aria-pressed", items[i][0] === get())); }; el.appendChild(b); });
}
function fmtTime(h) {
  const d = new Date(T0 + h * 3.6e6 - 5 * 3.6e6);   // hora local
  const hh = String(d.getUTCHours()).padStart(2, "0"), mm = String(d.getUTCMinutes()).padStart(2, "0");
  return [`${DIAS[d.getUTCDay()]} ${d.getUTCDate()} ${MESES[d.getUTCMonth()]} · ${hh}:${mm}`, `hora local · ${new Date(T0 + h*3.6e6).toISOString().slice(11,16)} UTC`];
}
function setHours(h) { hours = h; $("tslider").value = h; }
function modelNote() {
  const m = MODELS[model];
  const run = new Date(Date.parse(m.t0.replace("Z", ":00Z")));
  const rs = `corrida ${String(run.getUTCHours()).padStart(2,"0")}Z ${run.getUTCDate()}-${MESES[run.getUTCMonth()]}`;
  const dl = m.lons.length > 1 ? Math.abs(m.lons[1] - m.lons[0]) : 0;
  const res = model === "ETA" ? Math.round(dl * 111) + " km" : +dl.toFixed(2) + "°";      // malla en la que se muestra
  const txt = `${model === "ECMWF" ? "ECMWF IFS" : model} · malla ${res} · ${rs} · pasos de ${m.step_h} h${m.fuente ? " · " + m.fuente : ""}`;
  const com = m.plev ? ` · nubes: cantidad propia del modelo (baja/media/alta), ubicadas en altura según la humedad de ${m.plev.length} niveles (mismo proceso para todos)` : " · nubes por capas del modelo";
  $("modelNote").textContent = txt + com;
}
function buildDays() {
  let html = "";
  for (let d = 0; d <= 6; d++) { const h = d * 24 + 5; if (h > SPAN) break; const pct = h / SPAN * 100; html += `<i style="left:${pct}%"></i>`;
    const mid = h + 12; if (mid < SPAN) { const dt = new Date(T0 + (mid - 5) * 3.6e6); html += `<span style="left:${mid / SPAN * 100}%">${DIAS[dt.getUTCDay()]} ${dt.getUTCDate()}</span>`; } }
  $("days").innerHTML = html;
}

// ---------- Bucle ----------
let last = performance.now(), meteoTick = 0;
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  if (playing && !scrubbing) { hours += dt * parseFloat($("speed").value); if (hours > SPAN) hours = 0; $("tslider").value = hours; }
  const m = MODELS[model];
  world.scale.y = exag;
  const [su, sv] = meanSteer(m);
  if (playing) { const k = 3.6 * CFG.esc * dt * parseFloat($("speed").value); windOff.x += su * k; windOff.y += sv * k; }   // arrastre de la textura de nubes (km → escena)
  cloudMat.uniforms.windOff.value.copy(windOff);
  cloudMesh.visible = $("cClouds").checked;
  if (cloudMesh.visible) updateVolumes(m);
  isoOn.niv = (humVar === "ta" || humVar === "qa") && humLevel !== "off";   // con advección: isolíneas del campo advectado
  isoOn.pw = colorMode === "pwat" && !humMesh.visible;                                        // con el color PWAT: sus isolíneas altas
  updateTerrainColors(); updateSun(); updateHum(); bordesNivel(); updateRain(dt); updateWind(dt); updateIso();
  const [a, b] = fmtTime(hours); $("clock").innerHTML = `${a}<small>${b}</small>`;
  document.body.classList.toggle("conPunto", !$("point").hidden);   // la barra de navegación se corre si la ficha está abierta
  controls.update(); renderer.render(scene, camera); updateLabels();
  if (selected && (meteoTick += dt) > 0.2) { meteoTick = 0; drawMeteo(); }
  requestAnimationFrame(frame);
}

// ---------- Arranque ----------
// Los datos llegan como scripts (data/*.js) que llenan window.DATOS: así funciona con doble clic, sin servidor.
function load(name) { const d = (window.DATOS || {})[name]; if (!d) throw new Error("falta data/" + name + ".js"); return d; }
(() => {
  try {
    DEM = load("dem");
    const p = load("puntos");
    MODELS = {}; for (const [k, f] of [["GFS","gfs"],["ETA","eta"],["WRF","wrf"],["ECMWF","ecmwf"]]) { if ((window.DATOS || {})[f]) MODELS[k] = load(f); }
    if (!Object.keys(MODELS).length) throw new Error("no hay datos de modelos en data/");
    if (!MODELS[model]) model = Object.keys(MODELS)[0];
    const latest = Math.max(...Object.values(MODELS).map(m => Date.parse(m.t0.replace("Z", ":00Z"))));
    T0 = Math.floor(latest / 864e5) * 864e5;
    for (const k in MODELS) { prepModel(MODELS[k]); adveccionT(MODELS[k]); divergencia(MODELS[k]); }
    rangosAuto();
    buildTerrain(); for (const k in MODELS) prepSamplers(MODELS[k]);
    initWind();
    PUNTOS = p; PUNTOS.forEach(addPin);
    if (window.DATOS.pronostico && window.DATOS.pronostico.sitios && window.DATOS.pronostico.sitios.length) initPron(window.DATOS.pronostico);
    if (window.DATOS.limites) { buildLimites(window.DATOS.limites); $("cLim").onchange = e => setLimites(e.target.checked); }
    else $("limRow").hidden = true;
    seg("segModel", Object.keys(MODELS).map(k => [k, k]), () => model, v => { model = v; volKeyA = volKeyB = null; humKey = ""; modelNote(); drawHumLegend(); isoNota(); if (selected) selectPoint(selected); });   // la tabla diaria y su texto dependen del modelo
    colorMode = "lluvia";                        // al abrir: lluvia sobre el terreno (con la imagen satelital de fondo) y nubes apagadas
    if (window.DATOS.satelite) loadSatellite(window.DATOS.satelite);
    seg("segColor", (window.DATOS.satelite ? [["natural","Natural"]] : []).concat([["relieve","Relieve"],["temperatura","Temperatura"],["dt24","ΔT 24 h"],["lluvia","Lluvia"],["viento","Viento"],["cape","CAPE"]]).concat(Object.values(MODELS).some(m => m.steps[0] && m.steps[0].pw) ? [["pwat","PWAT"]] : []), () => colorMode, v => { colorMode = v; drawLegend(); });
    // Avisos de viento: panel plegable (cerrado al abrir; se recuerda) y umbrales (se recuerdan en este navegador)
    $("avisoGrp").hidden = !CFG.avisos;
    $("avisoGrp").addEventListener("toggle", () => updateAvisos());
    // Secciones plegables del panel: cada una recuerda si quedó abierta (por dominio)
    document.querySelectorAll("details.plegable").forEach(d => {
      const k = LS("sec_" + d.dataset.k);
      let s = null; try { s = localStorage.getItem(k); } catch (e) {}
      d.open = s === null ? CFG.abiertos.includes(d.dataset.k) : s === "1";
      d.addEventListener("toggle", () => { try { localStorage.setItem(k, d.open ? "1" : "0"); } catch (e) {} });
    });
    // Isolíneas (presión a nivel del mar y Z500)
    $("slpPaso").textContent = `cada ${CFG.isoSlp} hPa`; $("zPaso").textContent = `cada ${CFG.isoZ} m`;
    for (const [id, k] of [["cSlp", "slp"], ["cZ500", "z500"]]) {
      const hay = Object.values(MODELS).some(m => m.steps[0] && m.steps[0][k]);
      $(id).closest("label").hidden = !hay;
      let s = null; try { s = localStorage.getItem(LS("iso_" + k)); } catch (e) {}
      isoOn[k] = hay && (s === null ? CFG.isol.includes(k) : s === "1"); $(id).checked = isoOn[k];
      $(id).onchange = e => { isoOn[k] = e.target.checked; try { localStorage.setItem(LS("iso_" + k), isoOn[k] ? "1" : "0"); } catch (er) {} isoNota(); };
    }
    isoNota();
    $("limTxt").textContent = CFG.limTxt;
    try { const s = JSON.parse(localStorage.getItem("umbVientoMs") || "null"); if (s && s.w > 0 && s.g > 0) { UMB_W = s.w; UMB_G = s.g; } } catch (e) {}
    $("rowUmbG").hidden = !hayRafaga();
    const setUmb = () => {
      UMB_W = +$("rUmbW").value; UMB_G = +$("rUmbG").value; $("oUmbW").textContent = UMB_W; $("oUmbG").textContent = UMB_G;
      try { localStorage.setItem("umbVientoMs", JSON.stringify({w: UMB_W, g: UMB_G})); } catch (e) {}
      updateAvisos(); drawLegend();
    };
    $("rUmbW").value = UMB_W; $("rUmbG").value = UMB_G; $("rUmbW").oninput = setUmb; $("rUmbG").oninput = setUmb; setUmb();
    const setPin = v => { pinMode = v; labelsEl.classList.toggle("dots", v === "puntos"); labelsEl.classList.toggle("hidepins", v === "ocultos"); try { localStorage.setItem(LS("pinMode"), v); } catch (e) {} };
    pinMode = CFG.pines;
    try { const s = localStorage.getItem(LS("pinMode")); if (["nombres","puntos","ocultos"].includes(s)) pinMode = s; } catch (e) {}
    seg("segPin", [["nombres","Nombres"],["puntos","Solo puntos"],["ocultos","Ocultos"]], () => pinMode, setPin); setPin(pinMode);
    seg("segLuz",[["real","Real"],["clara","Noche clara"],["dia","Siempre de día"]], () => luzMode, v => { luzMode = v; });
    // niveles de viento del dominio que tenga al menos un modelo
    const hayV = l => l === "10" || Object.values(MODELS).some(m => m.steps[0] && m.steps[0]["u" + l]);
    const vs = CFG.viento.filter(hayV);
    const WIND_OPTS = [["off","No"]].concat(vs.map((l, i) => [l, l === "10" ? "10 m" : i === vs.length - 1 ? l + " hPa" : l]));
    if (!vs.includes(windLevel)) windLevel = vs.includes("850") ? "850" : vs[0];
    const buildWindSeg = () => seg("segWind", WIND_OPTS, () => windLevel, v => { windLevel = v; windKey = null; });
    buildWindSeg();
    // densidad de partículas y largo de estelas (se recuerdan por dominio)
    let wDens = "normal", wTail = "cortas";
    try { const a = localStorage.getItem(LS("wDens")), b = localStorage.getItem(LS("wTail")); if (WDENS[a]) wDens = a; if (WTAIL[b]) wTail = b; } catch (e) {}
    const aplicaW = () => { setWindDens(wDens, wTail); try { localStorage.setItem(LS("wDens"), wDens); localStorage.setItem(LS("wTail"), wTail); } catch (e) {} };
    seg("segWDens", [["normal","Normal"],["alta","Alta"],["muyalta","Muy alta"]], () => wDens, v => { wDens = v; aplicaW(); });
    seg("segWTail", [["cortas","Cortas"],["largas","Largas"]], () => wTail, v => { wTail = v; aplicaW(); });
    aplicaW();
    try { if (localStorage.getItem(LS("wColor")) === "campo") wColor = "campo"; } catch (e) {}
    seg("segWCol", [["vel","Velocidad"],["campo","Como el campo"]], () => wColor, v => { wColor = v; windKey = null; try { localStorage.setItem(LS("wColor"), v); } catch (e) {} });
    // Campo en altura: variable y nivel. Si el nivel tiene viento horizontal, las partículas pasan a ese nivel
    // y se colorean con el campo (humedad que transportan, o si el aire sube o baja).
    const setCampoNivel = v => {
      humLevel = v; humKey = ""; windKey = null;
      if (v !== "off" && MODELS[model].steps[0]["u" + v]) { windLevel = v; buildWindSeg(); }
      drawHumLegend();
    };
    // opacidad del campo en altura (se recuerda por dominio); con el terreno oscurecido debajo, bajarla no trae parches
    const setHumOp = v => { humMat.uniforms.opac.value = v; $("rHumOp").value = v; $("oHumOp").textContent = Math.round(v * 100) + " %"; try { localStorage.setItem(LS("humOp"), v); } catch (e) {} };
    { let s = null; try { s = parseFloat(localStorage.getItem(LS("humOp"))); } catch (e) {} setHumOp(s >= 0.4 && s <= 1 ? s : 0.75); }
    $("rHumOp").oninput = e => setHumOp(+e.target.value);
    const buildLevSeg = () => {
      $("segHumLev").hidden = humVar === "off";
      if (humVar === "off") return;
      const levs = Object.keys(CAMPOS[humVar].lev).map(Number).sort((a, b) => b - a).filter(p => Object.values(MODELS).some(m => campoDisponible(m, humVar, p)));
      if (!levs.includes(+humLevel)) humLevel = String(humVar === "w" ? (levs.includes(500) ? 500 : levs[0]) : (levs.includes(850) ? 850 : levs[0]));
      seg("segHumLev", levs.map(p => [String(p), String(p)]), () => humLevel, setCampoNivel);
      setCampoNivel(humLevel);
    };
    const hayCampo = v => Object.keys(CAMPOS[v].lev).some(p => Object.values(MODELS).some(m => campoDisponible(m, v, p)));
    seg("segHum", [["off","No"],["q","Humedad"],["w","Viento vertical"],["t","Temperatura"],["ta","Advección T"],["qa","Advección q"],["dv","Divergencia"]].filter(([v]) => v === "off" || hayCampo(v)), () => humVar, v => { humVar = v; humKey = ""; windKey = null; buildLevSeg(); drawHumLegend(); });
    buildLevSeg();
    const Q = {alta: [120, 1.25], media: [80, 1], baja: [48, 0.75]};
    let quality = "media";
    const setQ = v => { quality = v; cloudMat.uniforms.steps.value = Q[v][0]; renderer.setPixelRatio(Math.min(devicePixelRatio, Q[v][1])); renderer.setSize(innerWidth, innerHeight); };
    seg("segQ", [["alta","Alta"],["media","Media"],["baja","Baja"]], () => quality, setQ); setQ("media");
    $("titulo").textContent = CFG.titulo; $("subtitulo").textContent = CFG.sub; document.title = CFG.titulo;
    if (CFG.otro) { $("otroDom").href = CFG.otro.href; $("otroDom").textContent = CFG.otro.txt; } else $("otroDom").hidden = true;
    Object.assign($("rExag"), {min: CFG.exagMin, max: CFG.exagMax, step: CFG.exagPaso}); $("rExag").value = exag; $("oExag").textContent = exag + "×";
    $("rExag").oninput = e => { exag = +e.target.value; $("oExag").textContent = exag + "×"; PUNTOS.forEach(p => p); };
    const setCapas = () => cloudMat.uniforms.layerOn.value.set(+$("cBaja").checked, +$("cMedia").checked, +$("cAlta").checked);
    ["cBaja", "cMedia", "cAlta"].forEach(id => $(id).onchange = setCapas);
    $("rAlta").oninput = e => { cloudMat.uniforms.highOpac.value = +e.target.value; $("oAlta").textContent = Math.round(+e.target.value * 100) + " %"; };
    $("rDens").oninput =e => { cloudMat.uniforms.sigma.value = +e.target.value; $("oDens").textContent = (+e.target.value).toFixed(2); };
    // Mientras se arrastra la bolita, la animación no la mueve (si no, le gana al mouse)
    const ts = $("tslider");
    ts.max = SPAN; ts.oninput = e => { hours = +e.target.value; };
    ts.addEventListener("pointerdown", () => { scrubbing = true; });
    addEventListener("pointerup", () => { scrubbing = false; });
    addEventListener("pointercancel", () => { scrubbing = false; });
    ts.addEventListener("keydown", e => e.stopPropagation());   // las flechas mueven la hora, no el mapa
    $("play").onclick = () => { playing = !playing; $("play").textContent = playing ? "❚❚" : "▶"; $("play").setAttribute("aria-label", playing ? "Pausar" : "Reproducir"); };
    const nowH = (Date.now() - T0) / 3.6e6; setHours(nowH > 0 && nowH < SPAN ? nowH : 30);
    modelNote(); drawLegend(); buildDays();
    if (location.hash !== "#3d") vistaPlano(true);      // empieza en planta (2D); con index.html#3d empieza en 3D
    $("loading").hidden = true;
    requestAnimationFrame(frame);
  } catch (err) {
    $("loadmsg").textContent = "No se pudieron cargar los datos: " + err.message + ". Ejecuta herramientas\\actualizar_datos.bat";
    console.error(err);
  }
})();
addEventListener("resize", () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); if (selected) drawMeteo(); if (PRON) drawPron(); });
