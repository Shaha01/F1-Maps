/* ==========================================================
   F1 MAPS — 3D circuit viewer
   ========================================================== */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { Line2 } from "three/addons/lines/Line2.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";

// tiny diagnostics hook: __f1.frames() = rendered frames, __f1.quality() = adaptive level (0..3)
window.__f1 = { frames: () => renderCount, quality: () => qLevel };
const NOFX = new URLSearchParams(location.search).has("nofx");

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const store = {
  get(k, d) { try { return localStorage.getItem("f1maps." + k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem("f1maps." + k, v); } catch { /* private mode */ } },
};
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ---------- constants ---------- */
const HALF_W = 7.5;          // half track width, m
const LIFT = 3;              // track floats above the grid, m
const KERB_R = 140;          // corners tighter than this get kerbs, m
const COL = {
  neon: new THREE.Color(0xff2a3d), yellow: new THREE.Color(0xffd400), blue: new THREE.Color(0x3d5cff),
  green: new THREE.Color(0x22e57a), white: new THREE.Color(0xffffff), bg: new THREE.Color(0x050506),
};
const SECTOR_COL = [COL.neon, COL.blue, COL.yellow];

/* ---------- data ---------- */
const TRACKS = (window.TRACKS || []).slice().sort((a, b) => {
  const sa = a.season < 0 ? 999 : a.season, sb = b.season < 0 ? 999 : b.season;
  return sa - sb || a.firstgp - b.firstgp;
});
const byId = Object.fromEntries(TRACKS.map(t => [t.id, t]));

/* ---------- i18n ---------- */
let lang = store.get("lang", "ru");
if (!window.I18N[lang]) lang = "ru";
const t = k => (window.I18N[lang] && window.I18N[lang][k]) ?? window.I18N.ru[k] ?? k;
function country(cc) {
  try { return new Intl.DisplayNames([lang], { type: "region" }).of(cc.toUpperCase()); } catch { return cc.toUpperCase(); }
}
function applyLang() {
  document.documentElement.lang = lang;
  $$("[data-i18n]").forEach(el => { el.textContent = t(el.dataset.i18n); });
  $$("[data-i18n-html]").forEach(el => { el.innerHTML = t(el.dataset.i18nHtml); });
  $$("[data-i18n-ph]").forEach(el => { el.placeholder = t(el.dataset.i18nPh); });
  $$(".lang button").forEach(b => b.classList.toggle("is-active", b.dataset.lang === lang));
  movePill();
}
function movePill() {
  const a = $(".lang button.is-active"), pill = $(".lang__pill");
  if (!a) return;
  pill.style.width = a.offsetWidth + "px";
  pill.style.transform = `translateX(${a.offsetLeft}px)`;
}

/* ---------- track physics (simulated lap) ---------- */
const G = 9.81, VTOP = 93; // m/s ≈ 335 km/h
const latAcc = v => G * Math.min(6.0, 1.8 + 4.6 * (v / 85) ** 2);
const driveAcc = v => Math.max(0.3, 14 * (1 - (v / VTOP) ** 2));
const brakeAcc = v => G * Math.min(6.0, 2.0 + 3.8 * (v / 85) ** 2);
// tuned so simulated laps land within ~±5% of recent pole times on the current calendar

const prepCache = new Map();
function prep(T) {
  if (prepCache.has(T.id)) return prepCache.get(T.id);
  const n = T.x.length;
  let cx = 0, cz = 0;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    minX = Math.min(minX, T.x[i]); maxX = Math.max(maxX, T.x[i]);
    minZ = Math.min(minZ, T.z[i]); maxZ = Math.max(maxZ, T.z[i]);
  }
  cx = (minX + maxX) / 2; cz = (minZ + maxZ) / 2;
  const x = T.x.map(v => v - cx), z = T.z.map(v => v - cz), y = T.y.slice();

  // distances
  const ds = new Float32Array(n), s = new Float32Array(n + 1);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    ds[i] = Math.hypot(x[j] - x[i], z[j] - z[i], y[j] - y[i]);
    s[i + 1] = s[i] + ds[i];
  }
  const L = s[n];

  // corner radius (horizontal), circumradius of i-k, i, i+k
  const K = 3, rad = new Float32Array(n), turn = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = (i - K + n) % n, c = (i + K) % n;
    const ax = x[a], az = z[a], bx = x[i], bz = z[i], qx = x[c], qz = z[c];
    const ab = Math.hypot(bx - ax, bz - az), bc = Math.hypot(qx - bx, qz - bz), ca = Math.hypot(ax - qx, az - qz);
    const cross = (bx - ax) * (qz - az) - (bz - az) * (qx - ax);
    rad[i] = Math.abs(cross) < 1e-6 ? 1e5 : (ab * bc * ca) / (2 * Math.abs(cross));
    turn[i] = Math.sign(cross);
  }

  // speed limit per point, then forward (accel) / backward (brake) passes
  const vlim = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = 50;
    for (let it = 0; it < 8; it++) v = Math.sqrt(latAcc(v) * rad[i]);
    vlim[i] = Math.min(VTOP, v);
  }
  const v = Float32Array.from(vlim);
  for (let pass = 0; pass < 2; pass++) {
    for (let k = 0; k < n; k++) {
      const i = k, j = (k + 1) % n;
      const vn = Math.sqrt(v[i] ** 2 + 2 * driveAcc(v[i]) * ds[i]);
      if (vn < v[j]) v[j] = vn;
    }
  }
  for (let pass = 0; pass < 2; pass++) {
    for (let k = n - 1; k >= 0; k--) {
      const i = k, j = (k + 1) % n;
      const vp = Math.sqrt(v[j] ** 2 + 2 * brakeAcc(v[j]) * ds[i]);
      if (vp < v[i]) v[i] = vp;
    }
  }
  const tc = new Float32Array(n + 1);
  let vmax = 0, vmin = Infinity;
  for (let i = 0; i < n; i++) {
    tc[i + 1] = tc[i] + ds[i] / ((v[i] + v[(i + 1) % n]) / 2);
    vmax = Math.max(vmax, v[i]); vmin = Math.min(vmin, v[i]);
  }
  // longitudinal acceleration a = v dv/ds
  const acc = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    acc[i] = (v[j] ** 2 - v[i] ** 2) / (2 * ds[i]);
  }

  // principal axis for nice framing
  let sxx = 0, szz = 0, sxz = 0;
  for (let i = 0; i < n; i++) { sxx += x[i] * x[i]; szz += z[i] * z[i]; sxz += x[i] * z[i]; }
  const theta = 0.5 * Math.atan2(2 * sxz, sxx - szz);
  const ymax = Math.max(...y);
  let hi = 0;
  for (let i = 1; i < n; i++) if (y[i] > y[hi]) hi = i;

  const P = { n, x, y, z, ds, s, L, rad, turn, v, acc, tc, lap: tc[n], vmax, vmin, theta, ymax, hi };
  prepCache.set(T.id, P);
  return P;
}

/* ---------- formatting ---------- */
const fmtLap = sec => {
  const m = Math.floor(sec / 60), r = sec - m * 60;
  return `${m}:${r.toFixed(3).padStart(6, "0")}`;
};
const kmh = v => Math.round(v * 3.6);
const gearOf = k => (k < 2 ? "N" : String(Math.min(8, 1 + [80, 115, 150, 185, 220, 258, 292].filter(g => k >= g).length)));
const roundLabel = T => (T.season >= 0 ? "R" + String(T.season + 1).padStart(2, "0") : String(T.firstgp));

/* ---------- state ---------- */
const state = {
  id: null, filter: store.get("filter", "season"), cam: "orbit", color: "sector",
  rate: 1, exag: 3, playing: true, query: "",
  clock: 0, lapN: 1, lastLap: null,
};

/* ==========================================================
   UI: list, grid, marquee
   ========================================================== */
function outlinePath(T, step = 2) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < T.x.length; i++) {
    minX = Math.min(minX, T.x[i]); maxX = Math.max(maxX, T.x[i]);
    minZ = Math.min(minZ, T.z[i]); maxZ = Math.max(maxZ, T.z[i]);
  }
  const w = maxX - minX, h = maxZ - minZ;
  let d = "";
  for (let i = 0; i < T.x.length; i += step) d += (i ? "L" : "M") + (T.x[i] - minX).toFixed(0) + " " + (T.z[i] - minZ).toFixed(0);
  return { d: d + "Z", vb: `${(-w * 0.04).toFixed(0)} ${(-h * 0.04).toFixed(0)} ${(w * 1.08).toFixed(0)} ${(h * 1.08).toFixed(0)}`, x0: T.x[0] - minX, z0: T.z[0] - minZ, w, h };
}
const outlineCache = new Map();
const outline = T => { if (!outlineCache.has(T.id)) outlineCache.set(T.id, outlinePath(T)); return outlineCache.get(T.id); };

function visibleTracks() {
  const q = state.query.trim().toLowerCase();
  return TRACKS.filter(T => (state.filter === "all" || T.season >= 0) &&
    (!q || (T.name + " " + T.city + " " + country(T.cc)).toLowerCase().includes(q)));
}

function renderList() {
  const list = $("#list");
  const items = visibleTracks();
  list.innerHTML = items.length ? "" : `<li class="list__empty">${t("panel.empty")}</li>`;
  for (const T of items) {
    const o = outline(T);
    const li = document.createElement("li");
    li.innerHTML = `<button type="button" class="row${T.id === state.id ? " is-active" : ""}" data-id="${T.id}">
      <span class="row__n">${roundLabel(T)}</span>
      <svg viewBox="${o.vb}" preserveAspectRatio="xMidYMid meet" aria-hidden="true"><path d="${o.d}"/></svg>
      <span class="row__t"><b></b><span></span></span></button>`;
    $("b", li).textContent = T.name;
    $(".row__t span", li).textContent = `${T.city}, ${country(T.cc)}`;
    list.appendChild(li);
  }
  $("#tCount").textContent = TRACKS.filter(T => state.filter === "all" || T.season >= 0).length;
}

function setFilter(f) {
  state.filter = f;
  store.set("filter", f);
  $$("[data-filter]").forEach(b => b.classList.toggle("is-active", b.dataset.filter === f));
  renderList();
}

function updateInfo(T, P) {
  $("#tRound").textContent = roundLabel(T);
  $("#tPlace").textContent = `${T.city} · ${country(T.cc)}`;
  const title = $("#tTitle");
  const words = T.name.split(" ");
  const last = words.pop();
  title.innerHTML = "";
  if (words.length) title.append(words.join(" ") + " ");
  const o = document.createElement("span");
  o.className = "outline";
  o.textContent = last;
  title.append(o);
  title.classList.toggle("is-long", T.name.length > 26);
  title.classList.remove("is-swap"); void title.offsetWidth; title.classList.add("is-swap");
  $("#fLength").innerHTML = `${(T.length / 1000).toFixed(3)}<small>${t("unit.km")}</small>`;
  $("#fDelta").innerHTML = `${Math.round(P.ymax)}<small>${t("unit.m")}</small>`;
  $("#fAlt").innerHTML = `${T.altitude}<small>${t("unit.m")}</small>`;
  $("#fFirst").textContent = T.firstgp;
  $("#fLap").textContent = fmtLap(P.lap);
  $("#fVmax").innerHTML = `${kmh(P.vmax)}<small>km/h</small>`;
  document.title = `${T.name} — F1 Maps 3D`;
  $$(".row").forEach(r => r.classList.toggle("is-active", r.dataset.id === T.id));
}

/* ==========================================================
   3D
   ========================================================== */
const canvas = $("#scene");
const viewer = $("#viewer");
let renderer, scene, camera, controls, composer, bloom;
const lineMats = [];
let trackGroup = null;
let car, carGlow, trail;
const tags = [];
let cur = null; // { T, P, pts: Vector3[], tan: Vector3[], nrm: Vector3[], r, a, b, midY }
const tmpV = new THREE.Vector3(), tmpV2 = new THREE.Vector3(), carPos = new THREE.Vector3(), carTagPos = new THREE.Vector3();
const desiredPos = new THREE.Vector3(), desiredLook = new THREE.Vector3(), lookAt = new THREE.Vector3();
let tween = null;
const followDir = new THREE.Vector3(0, 0, 1), followFrom = new THREE.Vector3(), followLookFrom = new THREE.Vector3();
let followBlend = 1;
let dirty = true;
let renderCount = 0;
let idleTimer = 0;

/* ---------- adaptive quality ----------
   Bloom + MSAA in a float buffer roughly halves the frame rate on integrated GPUs.
   Start high (the start-lights loader hides the first seconds), measure, and step
   down until frames fit the budget. The settled level is remembered per browser. */
const QUALITY = [
  { dpr: 0.75, samples: 0, bloom: false, bs: 0 },    // 0: no post-processing
  { dpr: 1,    samples: 0, bloom: true,  bs: 0.5 },  // 1: quarter-res bloom
  { dpr: 1.5,  samples: 2, bloom: true,  bs: 0.75 },
  { dpr: 2,    samples: 4, bloom: true,  bs: 1 },    // 3: full quality
];
const qForced = new URLSearchParams(location.search).get("q");
const coarse = matchMedia("(pointer: coarse)").matches;
let qLevel = (() => {
  if (NOFX) return 0;
  if (qForced !== null && QUALITY[+qForced]) return +qForced;
  const saved = +store.get("quality", NaN);
  const def = coarse || (navigator.hardwareConcurrency || 8) <= 4 ? 1 : 3;
  // retry one level above the remembered one, in case the last visit was a bad moment
  return Number.isFinite(saved) ? Math.min(QUALITY.length - 1, saved + 1) : def;
})();
const qLocked = NOFX || qForced !== null;
const perf = { samples: [], last: 0, since: 0, frames: 0 };

function applyQuality() {
  const Q = QUALITY[qLevel];
  const pr = Math.min(devicePixelRatio || 1, Q.dpr);
  renderer.setPixelRatio(pr);
  composer.setPixelRatio(pr);
  for (const rtq of [composer.renderTarget1, composer.renderTarget2]) {
    if (rtq.samples !== Q.samples) { rtq.samples = Q.samples; rtq.dispose(); }
  }
  bloom.enabled = Q.bloom;
  document.body.classList.toggle("q-low", qLevel <= 1);
  resize();
}

function measure(now) {
  if (qLocked || document.hidden) { perf.last = now; return; }
  const ms = perf.last ? now - perf.last : 16;
  perf.last = now;
  if (ms > 250) return; // tab switch, breakpoint, etc.
  perf.samples.push(ms);
  perf.frames++;
  // decide quickly during the loader, then calmly
  const win = perf.frames < 200 ? 30 : 120;
  if (perf.samples.length < win) return;
  const sorted = perf.samples.slice().sort((a, b) => a - b);
  const median = sorted[sorted.length >> 1];
  perf.samples.length = 0;
  if (median > 21 && qLevel > 0) {
    qLevel--;
    applyQuality();
    perf.last = 0;
  } else {
    store.set("quality", qLevel);
  }
}

function initThree() {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
  renderer.toneMapping = THREE.NoToneMapping;
  scene = new THREE.Scene();
  scene.background = COL.bg.clone();
  camera = new THREE.PerspectiveCamera(40, 1, 1, 60000);
  camera.position.set(0, 3000, 4000);

  controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.07;
  controls.maxPolarAngle = Math.PI * 0.48;
  controls.minDistance = 25;
  controls.autoRotate = !reduceMotion;
  controls.autoRotateSpeed = 0.35;
  controls.addEventListener("change", () => { dirty = true; });
  controls.addEventListener("start", () => { controls.autoRotate = false; clearTimeout(idleTimer); });
  controls.addEventListener("end", () => {
    clearTimeout(idleTimer);
    if (!reduceMotion) idleTimer = setTimeout(() => { if (state.cam === "orbit" && state.playing) controls.autoRotate = true; }, 9000);
  });

  scene.add(new THREE.HemisphereLight(0xc8d4ff, 0x0b0b12, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(300, 600, 200);
  scene.add(sun);

  const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: QUALITY[qLevel].samples });
  composer = new EffectComposer(renderer, rt);
  composer.addPass(new RenderPass(scene, camera));
  bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.6, 0.5, 0.18);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  buildCar();
  applyQuality();
  addEventListener("resize", resize);
  new ResizeObserver(resize).observe(viewer);
}

/* ---------- materials ---------- */
function lineMat(opts) {
  const m = new LineMaterial({ worldUnits: false, ...opts });
  m.resolution.set(canvas.clientWidth || 1, canvas.clientHeight || 1);
  lineMats.push(m);
  return m;
}

const curtainMat = () => new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  uniforms: { uO: { value: 0.3 } },
  vertexShader: `attribute vec3 aCol; attribute float aA; varying vec3 vC; varying float vA;
    void main(){ vC = aCol; vA = aA; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `uniform float uO; varying vec3 vC; varying float vA;
    void main(){ gl_FragColor = vec4(vC * vA * vA * uO, 1.0); }`,
});

const groundMat = r => new THREE.ShaderMaterial({
  uniforms: {
    uR: { value: r }, uBg: { value: COL.bg }, uGlow: { value: COL.neon }, uBlue: { value: new THREE.Color(0x0d1440) },
    uCell: { value: r > 1500 ? 100 : 50 },
  },
  vertexShader: `varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
  fragmentShader: `uniform float uR; uniform vec3 uBg; uniform vec3 uGlow; uniform vec3 uBlue; uniform float uCell; varying vec3 vW;
    float grid(float size){ vec2 c = vW.xz / size; vec2 g = abs(fract(c - 0.5) - 0.5) / max(fwidth(c), vec2(1e-4)); return 1.0 - min(min(g.x, g.y), 1.0); }
    void main(){
      float d = length(vW.xz) / uR;
      float fade = 1.0 - smoothstep(0.6, 2.4, d);
      float g = grid(uCell) * 0.025 + grid(uCell * 5.0) * 0.06;
      vec3 col = uBg + vec3(g) * fade;
      col += uBlue * exp(-d * d * 0.9) * 0.55;
      col += uGlow * exp(-d * d * 2.5) * 0.035;
      gl_FragColor = vec4(col, 1.0);
    }`,
});

function radialTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d");
  const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, "rgba(255,255,255,1)");
  gr.addColorStop(0.18, "rgba(255,255,255,.9)");
  gr.addColorStop(0.35, "rgba(255,255,255,.25)");
  gr.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = gr;
  g.fillRect(0, 0, 128, 128);
  const tx = new THREE.CanvasTexture(c);
  tx.colorSpace = THREE.SRGBColorSpace;
  return tx;
}
function checkerTexture() {
  const c = document.createElement("canvas");
  c.width = 128; c.height = 32;
  const g = c.getContext("2d");
  for (let i = 0; i < 16; i++) for (let j = 0; j < 4; j++) {
    g.fillStyle = (i + j) % 2 ? "#0a0a0c" : "#f3f3f5";
    g.fillRect(i * 8, j * 8, 8, 8);
  }
  const tx = new THREE.CanvasTexture(c);
  tx.colorSpace = THREE.SRGBColorSpace;
  tx.magFilter = THREE.NearestFilter;
  return tx;
}

/* ---------- car ---------- */
function buildCar() {
  car = new THREE.Group();
  const navy = new THREE.MeshStandardMaterial({ color: 0x1e2a78, roughness: 0.35, metalness: 0.4 });
  const red = new THREE.MeshStandardMaterial({ color: 0xff2a3d, roughness: 0.4, emissive: 0x330006 });
  const yel = new THREE.MeshStandardMaterial({ color: 0xffd400, roughness: 0.4 });
  const blk = new THREE.MeshStandardMaterial({ color: 0x0c0c0e, roughness: 0.8 });
  const box = (w, h, l, m, x, y, z) => { const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, l), m); o.position.set(x, y, z); car.add(o); return o; };
  box(0.85, 0.42, 3.6, navy, 0, 0.38, -0.2);       // tub
  box(0.38, 0.26, 1.5, navy, 0, 0.32, 2.2);        // nose
  box(1.9, 0.06, 0.5, red, 0, 0.12, 2.95);         // front wing
  box(0.06, 0.25, 0.55, red, 0.95, 0.2, 2.95);
  box(0.06, 0.25, 0.55, red, -0.95, 0.2, 2.95);
  box(1.55, 0.36, 1.7, navy, 0, 0.32, -0.3);       // sidepods
  box(0.3, 0.42, 1.4, navy, 0, 0.72, -0.9);        // engine cover
  box(0.28, 0.3, 0.5, yel, 0, 0.8, 0.15);          // airbox / helmet
  box(1.05, 0.08, 0.32, red, 0, 0.95, -2.25);      // rear wing
  box(1.05, 0.05, 0.25, yel, 0, 0.82, -2.2);
  box(0.06, 0.62, 0.6, red, 0.55, 0.65, -2.2);
  box(0.06, 0.62, 0.6, red, -0.55, 0.65, -2.2);
  box(0.24, 0.1, 0.06, new THREE.MeshBasicMaterial({ color: 0xff2a3d }), 0, 0.42, -2.55); // rain light
  const wheelG = new THREE.CylinderGeometry(0.36, 0.36, 0.38, 20);
  wheelG.rotateZ(Math.PI / 2);
  for (const [x, z] of [[0.82, 1.65], [-0.82, 1.65], [0.84, -1.6], [-0.84, -1.6]]) {
    const w = new THREE.Mesh(wheelG, blk);
    w.position.set(x, 0.36, z);
    car.add(w);
  }
  scene.add(car);

  carGlow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: radialTexture(), color: 0xff2a3d, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false,
    sizeAttenuation: false, transparent: true,
  }));
  carGlow.scale.set(0.05, 0.05, 1);
  carGlow.renderOrder = 10;
  scene.add(carGlow);

  trail = new Line2(new LineGeometry(), lineMat({ linewidth: 4, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  trail.renderOrder = 5;
  scene.add(trail);
}

/* ---------- color modes ---------- */
function colorAt(i) {
  const P = cur.P;
  if (state.color === "sector") return SECTOR_COL[Math.min(2, Math.floor((P.s[i] / P.L) * 3))];
  if (state.color === "speed") {
    const k = (P.v[i % P.n] - P.vmin) / Math.max(1, P.vmax - P.vmin);
    return k < 0.5 ? tmpCol.copy(COL.blue).lerp(COL.yellow, k * 2) : tmpCol.copy(COL.yellow).lerp(COL.neon, (k - 0.5) * 2);
  }
  const k = P.y[i % P.n] / Math.max(8, P.ymax);
  return k < 0.5 ? tmpCol.copy(COL.blue).lerp(COL.green, k * 2) : tmpCol.copy(COL.green).lerp(COL.yellow, (k - 0.5) * 2);
}
const tmpCol = new THREE.Color();

/* ---------- build track ---------- */
function disposeGroup(g) {
  g.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      const i = lineMats.indexOf(o.material);
      if (i >= 0) lineMats.splice(i, 1);
      if (o.material.map) o.material.map.dispose();
      o.material.dispose();
    }
  });
  scene.remove(g);
}

function computeFrame(P) {
  const n = P.n, pts = [], tan = [], nrm = [];
  for (let i = 0; i < n; i++) pts.push(new THREE.Vector3(P.x[i], P.y[i] * state.exag + LIFT, P.z[i]));
  for (let i = 0; i < n; i++) {
    const a = pts[(i - 1 + n) % n], b = pts[(i + 1) % n];
    const tg = new THREE.Vector3().subVectors(b, a).normalize();
    tan.push(tg);
    nrm.push(new THREE.Vector3(-tg.z, 0, tg.x).normalize());
  }
  return { pts, tan, nrm };
}

function buildTrack() {
  if (trackGroup) disposeGroup(trackGroup);
  for (const tg of tags) tg.el.remove();
  tags.length = 0;
  const { P } = cur;
  Object.assign(cur, computeFrame(P));
  const { pts, nrm } = cur;
  const n = P.n;
  const g = new THREE.Group();
  trackGroup = g;

  // extents for framing
  let r = 0;
  for (const p of pts) r = Math.max(r, Math.hypot(p.x, p.z));
  cur.r = r;
  const u = new THREE.Vector2(Math.cos(P.theta), Math.sin(P.theta));
  let a = 0, b = 0;
  for (const p of pts) { a = Math.max(a, Math.abs(p.x * u.x + p.z * u.y)); b = Math.max(b, Math.abs(-p.x * u.y + p.z * u.x)); }
  cur.a = a; cur.b = b; cur.u = u;
  cur.midY = LIFT + (P.ymax * state.exag) / 2;

  // ground
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(r * 14, r * 14), groundMat(r));
  ground.rotation.x = -Math.PI / 2;
  g.add(ground);

  // road ribbon
  const ribbon = (o0, o1, dy) => {
    const pos = new Float32Array((n + 1) * 6), idx = [];
    for (let k = 0; k <= n; k++) {
      const i = k % n, p = pts[i], q = nrm[i];
      pos.set([p.x + q.x * o0, p.y + dy, p.z + q.z * o0, p.x + q.x * o1, p.y + dy, p.z + q.z * o1], k * 6);
      if (k < n) { const v = k * 2; idx.push(v, v + 1, v + 2, v + 1, v + 3, v + 2); }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    return geo;
  };
  const road = new THREE.Mesh(ribbon(-HALF_W, HALF_W, 0), new THREE.MeshStandardMaterial({ color: 0x1a1a21, roughness: 0.92, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }));
  g.add(road);

  // kerbs (red/white stripes in corners)
  const kp = [], kc = [];
  const red = new THREE.Color(0xff2a3d), wht = new THREE.Color(0xe9e9ee);
  const SUB = 4;
  for (let i = 0; i < n; i++) {
    if (P.rad[i] > KERB_R) continue;
    const j = (i + 1) % n;
    for (const side of [-1, 1]) {
      const o0 = side * HALF_W, o1 = side * (HALF_W + 1.3);
      for (let s = 0; s < SUB; s++) {
        const f0 = s / SUB, f1 = (s + 1) / SUB;
        const A = tmpV.lerpVectors(pts[i], pts[j], f0).clone(), B = tmpV.lerpVectors(pts[i], pts[j], f1).clone();
        const NA = tmpV2.lerpVectors(nrm[i], nrm[j], f0).clone(), NB = tmpV2.lerpVectors(nrm[i], nrm[j], f1).clone();
        const v = [
          A.x + NA.x * o0, A.y + 0.05, A.z + NA.z * o0, A.x + NA.x * o1, A.y + 0.05, A.z + NA.z * o1, B.x + NB.x * o0, B.y + 0.05, B.z + NB.z * o0,
          A.x + NA.x * o1, A.y + 0.05, A.z + NA.z * o1, B.x + NB.x * o1, B.y + 0.05, B.z + NB.z * o1, B.x + NB.x * o0, B.y + 0.05, B.z + NB.z * o0,
        ];
        kp.push(...v);
        const c = (i * SUB + s) % 2 ? red : wht;
        for (let q = 0; q < 6; q++) kc.push(c.r, c.g, c.b);
      }
    }
  }
  if (kp.length) {
    const kg = new THREE.BufferGeometry();
    kg.setAttribute("position", new THREE.Float32BufferAttribute(kp, 3));
    kg.setAttribute("color", new THREE.Float32BufferAttribute(kc, 3));
    g.add(new THREE.Mesh(kg, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, color: 0x9a9aa0 })));
  }

  // edges
  const edge = side => {
    const arr = [];
    for (let k = 0; k <= n; k++) { const i = k % n; arr.push(pts[i].x + nrm[i].x * side * HALF_W, pts[i].y + 0.08, pts[i].z + nrm[i].z * side * HALF_W); }
    const lg = new LineGeometry(); lg.setPositions(arr);
    return new Line2(lg, lineMat({ color: 0xffffff, linewidth: 1, transparent: true, opacity: 0.4 }));
  };
  g.add(edge(1), edge(-1));

  // racing line, colored by mode
  const lp = [], lc = [];
  for (let k = 0; k <= n; k++) {
    const i = k % n;
    lp.push(pts[i].x, pts[i].y + 0.15, pts[i].z);
    const c = colorAt(k === n ? n - 1 : i);
    lc.push(c.r, c.g, c.b);
  }
  const lg = new LineGeometry(); lg.setPositions(lp); lg.setColors(lc);
  const racing = new Line2(lg, lineMat({ linewidth: 3, vertexColors: true }));
  g.add(racing);

  // elevation curtain
  const cp = new Float32Array((n + 1) * 6), cc = new Float32Array((n + 1) * 6), ca = new Float32Array((n + 1) * 2), ci = [];
  for (let k = 0; k <= n; k++) {
    const i = k % n, p = pts[i], c = colorAt(k === n ? n - 1 : i);
    cp.set([p.x, p.y, p.z, p.x, 0, p.z], k * 6);
    cc.set([c.r, c.g, c.b, c.r, c.g, c.b], k * 6);
    ca.set([1, 0], k * 2);
    if (k < n) { const v = k * 2; ci.push(v, v + 1, v + 2, v + 1, v + 3, v + 2); }
  }
  const cg = new THREE.BufferGeometry();
  cg.setAttribute("position", new THREE.BufferAttribute(cp, 3));
  cg.setAttribute("aCol", new THREE.BufferAttribute(cc, 3));
  cg.setAttribute("aA", new THREE.BufferAttribute(ca, 1));
  cg.setIndex(ci);
  cur.curtain = curtainMat();
  g.add(new THREE.Mesh(cg, cur.curtain));

  // shadow line on the ground
  const sp = [];
  for (let k = 0; k <= n; k++) { const i = k % n; sp.push(pts[i].x, 0.1, pts[i].z); }
  const sg = new LineGeometry(); sg.setPositions(sp);
  g.add(new Line2(sg, lineMat({ color: 0x2b4cff, linewidth: 1, transparent: true, opacity: 0.35 })));

  // start/finish checker
  const p0 = pts[0], t0 = cur.tan[0], n0 = nrm[0];
  const sfg = new THREE.BufferGeometry();
  const c4 = [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, st]) => [p0.x + n0.x * sx * HALF_W + t0.x * st * 2, p0.y + 0.12 + t0.y * st * 2, p0.z + n0.z * sx * HALF_W + t0.z * st * 2]);
  sfg.setAttribute("position", new THREE.Float32BufferAttribute(c4.flat(), 3));
  sfg.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 1, 1], 2));
  sfg.setIndex([0, 1, 2, 1, 3, 2]);
  g.add(new THREE.Mesh(sfg, new THREE.MeshBasicMaterial({ map: checkerTexture(), side: THREE.DoubleSide })));

  // beams: start + sector boundaries + highest point
  const beamH = Math.max(60, r * 0.09);
  const beam = (i, col, label, cls) => {
    const p = pts[i];
    const bg = new LineGeometry();
    bg.setPositions([p.x, p.y, p.z, p.x, p.y + beamH, p.z]);
    bg.setColors([col.r, col.g, col.b, 0, 0, 0]);
    g.add(new Line2(bg, lineMat({ linewidth: 2, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })));
    addTag(new THREE.Vector3(p.x, p.y + beamH, p.z), label, cls);
  };
  const idxAt = dist => { let i = 0; while (i < n - 1 && P.s[i + 1] < dist) i++; return i; };
  beam(0, COL.white, "START · FINISH", "tag--start");
  beam(idxAt(P.L / 3), COL.blue, "S2", "tag--s2");
  beam(idxAt((2 * P.L) / 3), COL.yellow, "S3", "tag--s3");
  if (P.ymax > 8) addTag(new THREE.Vector3(pts[P.hi].x, pts[P.hi].y + 4, pts[P.hi].z), `▲ ${cur.T.base + Math.round(P.ymax)} ${t("unit.m")}`, "tag--hi");

  scene.add(g);
  resetTrail(n);
  dirty = true;
  scene.fog = new THREE.FogExp2(0x050506, 0.28 / r);
  controls.maxDistance = r * 20;
  drawProfileBase();
}

/* ---------- DOM tags pinned to 3D points ---------- */
const tagLayer = document.createElement("div");
tagLayer.className = "tags";
viewer.insertBefore(tagLayer, $(".viewer__ui"));
function addTag(pos, text, cls) {
  const el = document.createElement("span");
  el.className = "tag3d mono " + (cls || "");
  el.textContent = text;
  tagLayer.appendChild(el);
  tags.push({ pos, el });
}
const carTag = document.createElement("span");
carTag.className = "tag3d tag--car mono";
carTag.innerHTML = "<span>P1</span> SHA";
tagLayer.appendChild(carTag);

function placeTag(el, pos, W, H) {
  tmpV.copy(pos).project(camera);
  if (tmpV.z > 1 || tmpV.z < -1) { el.style.opacity = 0; return; }
  el.style.opacity = "";
  el.style.transform = `translate3d(${((tmpV.x * 0.5 + 0.5) * W).toFixed(1)}px, ${((-tmpV.y * 0.5 + 0.5) * H).toFixed(1)}px, 0)`;
}

/* ---------- framing / camera ---------- */
let freeRect = { x: 0, y: 0, w: 1, h: 1 };
function computeViewOffset() {
  const vr = viewer.getBoundingClientRect();
  const W = vr.width, H = vr.height;
  if (cine.on) {
    const bar = Math.min(H * 0.11, W * 0.14);
    freeRect = { x: 0, y: bar, w: W, h: H - 2 * bar };
    camera.setViewOffset(W, H, 0, 0, W, H);
    return;
  }
  const info = $("#info").getBoundingClientRect(), hud = $("#hud").getBoundingClientRect(), panel = $("#panel").getBoundingClientRect();
  const stacked = innerWidth <= 980;
  let L = 0, R = W, T = 72, B = hud.top - vr.top;
  if (stacked) T = info.bottom - vr.top;
  else { L = Math.min(info.right - vr.left, W * 0.42) * 0.92; R = panel.left - vr.left; }
  freeRect = { x: L, y: T, w: Math.max(100, R - L), h: Math.max(100, B - T) };
  const dx = freeRect.x + freeRect.w / 2 - W / 2, dy = freeRect.y + freeRect.h / 2 - H / 2;
  camera.setViewOffset(W, H, -dx, -dy, W, H);
}

function framing(kind) {
  const W = canvas.clientWidth, H = canvas.clientHeight;
  const tv = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * (freeRect.h / H);
  const th = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * (W / H) * (freeRect.w / W);
  const { a, b, u, midY } = cur;
  const h = new THREE.Vector2(-u.y, u.x);
  const target = new THREE.Vector3(0, midY, 0);
  if (kind === "top") {
    const d = Math.max(a / th, b / tv) * (W < H ? 1.15 : 1.12) + midY;
    return { pos: new THREE.Vector3(h.x * d * 0.002, d, h.y * d * 0.002), target };
  }
  const el = THREE.MathUtils.degToRad(42);
  const hy = cur.P.ymax * state.exag;
  const d = Math.max(a / th, (b * Math.sin(el) + hy * Math.cos(el)) / tv) * (W < H ? 1.15 : 1.08) + b * Math.cos(el) * 0.35;
  return { pos: new THREE.Vector3(h.x * Math.cos(el) * d, midY + Math.sin(el) * d, h.y * Math.cos(el) * d), target };
}

const ease = k => 1 - Math.pow(1 - k, 4);
function flyTo(f, dur = 1600) {
  tween = { p0: camera.position.clone(), t0: controls.target.clone(), p1: f.pos, t1: f.target, start: performance.now(), dur: reduceMotion ? 1 : dur };
}

function setCam(mode) {
  const wasFollow = state.cam === "chase" || state.cam === "onboard";
  state.cam = mode;
  if (wasFollow) controls.target.copy(lookAt);
  $$("#camSeg button").forEach(b => b.classList.toggle("is-active", b.dataset.cam === mode));
  controls.enabled = mode === "orbit" || mode === "top";
  controls.enableRotate = mode === "orbit";
  controls.autoRotate = mode === "orbit" && !reduceMotion && state.playing;
  camera.fov = mode === "onboard" ? 68 : mode === "chase" ? 55 : 40;
  camera.updateProjectionMatrix();
  if (mode === "orbit" || mode === "top") flyTo(framing(mode), 1400);
  else {
    tween = null;
    if (!wasFollow) { followLookFrom.copy(controls.target); followFrom.copy(camera.position); }
    else { followLookFrom.copy(lookAt); followFrom.copy(camera.position); }
    followBlend = 0;
    if (cur && cur.tan) followDir.copy(cur.tan[sampleClock(cur.P, state.clock)[0]]);
  }
}

/* ---------- elevation profile (2D) ---------- */
const prof = $("#profile");
const pctx = prof.getContext("2d");
let profBase = null;
function drawProfileBase() {
  if (!cur) return;
  lastProfX = -1;
  const dpr = Math.min(devicePixelRatio, 2);
  const w = prof.clientWidth, h = prof.clientHeight;
  if (!w || !h) return;
  prof.width = w * dpr; prof.height = h * dpr;
  profBase = document.createElement("canvas");
  profBase.width = prof.width; profBase.height = prof.height;
  const g = profBase.getContext("2d");
  g.scale(dpr, dpr);
  const P = cur.P, range = Math.max(10, P.ymax);
  const X = i => (P.s[i] / P.L) * w, Y = i => h - 4 - (P.y[i % P.n] / range) * (h - 10);
  // fill
  const grad = g.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, "rgba(255,42,61,.28)");
  grad.addColorStop(1, "rgba(255,42,61,0)");
  g.beginPath(); g.moveTo(0, h);
  for (let i = 0; i <= P.n; i++) g.lineTo(X(i), Y(i));
  g.lineTo(w, h); g.closePath(); g.fillStyle = grad; g.fill();
  // grid
  g.strokeStyle = "rgba(255,255,255,.06)"; g.lineWidth = 1;
  for (const f of [1 / 3, 2 / 3]) { g.beginPath(); g.moveTo(w * f, 0); g.lineTo(w * f, h); g.stroke(); }
  // colored line
  g.lineWidth = 2; g.lineJoin = "round";
  for (let i = 0; i < P.n; i++) {
    const c = colorAt(i);
    g.strokeStyle = c.getStyle();
    g.beginPath(); g.moveTo(X(i), Y(i)); g.lineTo(X(i + 1), Y(i + 1)); g.stroke();
  }
}
function drawProfile(i, f) {
  if (!profBase) return;
  const dpr = prof.width / prof.clientWidth;
  pctx.setTransform(1, 0, 0, 1, 0, 0);
  pctx.clearRect(0, 0, prof.width, prof.height);
  pctx.drawImage(profBase, 0, 0);
  pctx.scale(dpr, dpr);
  const P = cur.P, w = prof.clientWidth, h = prof.clientHeight, range = Math.max(10, P.ymax);
  const s = P.s[i] + P.ds[i] * f, y = P.y[i] + (P.y[(i + 1) % P.n] - P.y[i]) * f;
  const x = (s / P.L) * w, yy = h - 4 - (y / range) * (h - 10);
  pctx.strokeStyle = "rgba(255,255,255,.5)"; pctx.lineWidth = 1;
  pctx.beginPath(); pctx.moveTo(x, 0); pctx.lineTo(x, h); pctx.stroke();
  pctx.fillStyle = "#fff"; pctx.shadowColor = "#ff2a3d"; pctx.shadowBlur = 10;
  pctx.beginPath(); pctx.arc(x, yy, 3.5, 0, Math.PI * 2); pctx.fill();
  pctx.shadowBlur = 0;
}
function seekFromProfile(e) {
  if (!cur) return;
  const r = prof.getBoundingClientRect();
  const k = Math.min(0.9999, Math.max(0, (e.clientX - r.left) / r.width));
  const P = cur.P, target = k * P.L;
  let i = 0;
  while (i < P.n - 1 && P.s[i + 1] < target) i++;
  const f = (target - P.s[i]) / P.ds[i];
  state.clock = P.tc[i] + (P.tc[i + 1] - P.tc[i]) * f;
  dirty = true;
}
prof.addEventListener("pointerdown", e => {
  seekFromProfile(e);
  prof.setPointerCapture(e.pointerId);
  const mv = ev => seekFromProfile(ev);
  prof.addEventListener("pointermove", mv);
  prof.addEventListener("pointerup", () => prof.removeEventListener("pointermove", mv), { once: true });
});

/* ---------- load a track ---------- */
function selectTrack(id, { fly = true, push = true } = {}) {
  const T = byId[id] || TRACKS[0];
  if (!T) return;
  state.id = T.id;
  store.set("track", T.id);
  if (push) {
    const url = new URL(location.href);
    url.searchParams.set("track", T.id);
    history.replaceState(null, "", url);
  }
  const P = prep(T);
  cur = { T, P };
  updateInfo(T, P);
  state.clock = 0; state.lapN = 1; state.lastLap = null;
  if (!renderer) return;
  buildTrack();
  computeViewOffset();
  if (state.cam === "orbit" || state.cam === "top") {
    if (fly) {
      const f = framing(state.cam);
      camera.position.copy(f.pos).multiplyScalar(1.9).setY(f.pos.y * 2.4);
      controls.target.copy(f.target);
      flyTo(f, 2000);
    } else {
      const f = framing(state.cam);
      camera.position.copy(f.pos); controls.target.copy(f.target);
    }
  }
}

function step(dir) {
  const list = TRACKS.filter(T => state.filter === "all" || T.season >= 0);
  const pool = list.some(T => T.id === state.id) ? list : TRACKS;
  const i = pool.findIndex(T => T.id === state.id);
  selectTrack(pool[(i + dir + pool.length) % pool.length].id);
  const row = $(`.row[data-id="${state.id}"]`);
  if (row) row.scrollIntoView({ block: "nearest", behavior: reduceMotion ? "auto" : "smooth" });
}

/* ==========================================================
   CINEMA MODE — no UI, an auto-director cuts between shots,
   one lap per circuit, then on to the next one
   ========================================================== */
const cine = {
  on: false, shot: null, t: 0, dur: 0, a: 0, side: 1, snap: true, fading: false,
  pendingNext: false, laps: 0, fs: false, recent: [], uiTimer: 0, cardTimer: 0,
  anchor: new THREE.Vector3(), cam: new THREE.Vector3(), look: new THREE.Vector3(),
};
const UP = new THREE.Vector3(0, 1, 0);
const SHOTS = {
  //            fov  duration
  wide:      { fov: 36, dur: [9, 11] },
  drone:     { fov: 44, dur: [7, 9] },
  trackside: { fov: 22, dur: [5.5, 6.5] },
  low:       { fov: 60, dur: [6, 8] },
  onboard:   { fov: 72, dur: [7, 9] },
  heli:      { fov: 32, dur: [7, 9] },
  front:     { fov: 40, dur: [5, 7] },
};
const cineEl = $("#cine"), cineFade = $("#cineFade"), cineCard = $("#cineCard");
const rand = (a, b) => a + Math.random() * (b - a);

function cineIndexAhead(i, meters) {
  const P = cur.P;
  let k = i, d = 0;
  while (d < meters) { d += P.ds[k]; k = (k + 1) % P.n; }
  return k;
}

function startShot(name) {
  const [i] = sampleClock(cur.P, state.clock);
  const def = SHOTS[name];
  cine.shot = name;
  cine.wide = null;
  cine.t = 0;
  cine.dur = rand(def.dur[0], def.dur[1]);
  cine.a = Math.random() * Math.PI * 2;
  cine.side = Math.random() < 0.5 ? -1 : 1;
  cine.snap = true;
  cine.recent = [name, ...cine.recent].slice(0, 3);
  camera.fov = def.fov;
  camera.updateProjectionMatrix();
  followDir.copy(cur.tan[i]);
  if (name === "trackside") {
    // park a long-lens camera beside the track where the car will be in ~3 s
    const v = cur.P.v[i];
    const k = cineIndexAhead(i, Math.max(60, v * 3.2));
    const p = cur.pts[k], nn = cur.nrm[k];
    cine.anchor.set(p.x + nn.x * cine.side * (HALF_W + rand(14, 26)), p.y + rand(2.5, 6), p.z + nn.z * cine.side * (HALF_W + rand(14, 26)));
  }
}

function nextShot() {
  const pool = Object.keys(SHOTS).filter(s => s !== "wide" && !cine.recent.includes(s));
  // the overview comes back now and then
  const name = Math.random() < 0.14 && cine.recent[0] !== "wide" ? "wide" : pool[Math.floor(Math.random() * pool.length)];
  startShot(name);
}

function cineCamera(dt, pos, fwd) {
  cine.t += dt;
  followDir.lerp(fwd, 1 - Math.exp(-dt * (cine.shot === "onboard" ? 10 : 2.5))).normalize();
  const h = followDir;
  const side = tmpV.set(-h.z, 0, h.x).normalize().multiplyScalar(cine.side);
  let smooth = 0; // 0 = locked to target, otherwise lerp rate
  let lookSmooth = 0;
  const c = cine.cam, l = cine.look;
  const k = cine.t / cine.dur;

  switch (cine.shot) {
    case "wide": {
      const f = cine.wide || (cine.wide = framing("orbit"));
      const ang = cine.a * 0.15 + cine.t * 0.05;
      const off = f.pos.clone().sub(f.target).applyAxisAngle(UP, ang).multiplyScalar(1.02 - 0.1 * k);
      c.copy(f.target).add(off);
      l.copy(f.target);
      break;
    }
    case "drone": {
      const ang = cine.a + cine.t * 0.24, R = 34 - 6 * k;
      c.set(pos.x + Math.cos(ang) * R, pos.y + 11 + Math.sin(cine.t * 0.4) * 3, pos.z + Math.sin(ang) * R);
      l.copy(pos).addScaledVector(UP, 0.8);
      break;
    }
    case "trackside":
      c.copy(cine.anchor);
      l.copy(pos).addScaledVector(UP, 0.7);
      lookSmooth = 7;
      break;
    case "low":
      c.copy(pos).addScaledVector(h, -7.5).addScaledVector(side, 2.4).addScaledVector(UP, 1.15);
      l.copy(pos).addScaledVector(h, 22).addScaledVector(UP, 0.7);
      break;
    case "onboard":
      c.copy(pos).addScaledVector(fwd, 0.5).addScaledVector(UP, 1.12);
      l.copy(pos).addScaledVector(h, 40).addScaledVector(UP, 0.9);
      break;
    case "heli":
      c.copy(pos).addScaledVector(h, -70).addScaledVector(side, 55).addScaledVector(UP, 95 - 25 * k);
      l.copy(pos);
      smooth = 1.6; lookSmooth = 5;
      break;
    case "front":
      c.copy(pos).addScaledVector(h, 12 - 3 * k).addScaledVector(side, 1.6).addScaledVector(UP, 1.6);
      l.copy(pos).addScaledVector(UP, 0.8);
      break;
  }

  if (cine.snap || !smooth) camera.position.copy(c);
  else camera.position.lerp(c, 1 - Math.exp(-dt * smooth));
  if (cine.snap || !lookSmooth) lookAt.copy(l);
  else lookAt.lerp(l, 1 - Math.exp(-dt * lookSmooth));
  cine.snap = false;
  camera.lookAt(lookAt);

  // dip to black before every cut
  if (!cine.fading && cine.t > cine.dur - 0.42) { cine.fading = true; cineFade.classList.add("is-black"); }
  if (cine.t >= cine.dur) {
    cine.fading = false;
    if (cine.pendingNext) {
      cine.pendingNext = false;
      cineTrack(1);
    } else nextShot();
    cineFade.classList.remove("is-black");
  }
}

function cineLap() {
  // a full lap is done: finish the current shot quickly and move to the next circuit
  cine.laps++;
  cine.pendingNext = true;
  cine.dur = Math.min(cine.dur, cine.t + 0.45);
}

function cineTrack(dir) {
  step(dir);
  cine.laps = 0;
  cine.pendingNext = false;
  cine.recent = [];
  startShot("wide");
  showCard();
}

function showCard() {
  const T = cur.T, P = cur.P;
  $("#cineKicker").innerHTML = "";
  const b = document.createElement("b");
  b.textContent = roundLabel(T);
  $("#cineKicker").append(b, ` ${T.city} · ${country(T.cc)}`);
  $("#cineTitle").textContent = T.name;
  $("#cineMeta").textContent = `${(T.length / 1000).toFixed(3)} ${t("unit.km")} · Δ ${Math.round(P.ymax)} ${t("unit.m")} · ${t("fact.lap")} ${fmtLap(P.lap)}`;
  cineCard.classList.remove("is-on");
  void cineCard.offsetWidth;
  clearTimeout(cine.cardTimer);
  setTimeout(() => cineCard.classList.add("is-on"), 700);
  cine.cardTimer = setTimeout(() => cineCard.classList.remove("is-on"), 6500);
}

function cineWake() {
  if (!cine.on) return;
  cineEl.classList.add("is-ui");
  document.body.classList.remove("cine-idle");
  clearTimeout(cine.uiTimer);
  cine.uiTimer = setTimeout(() => { cineEl.classList.remove("is-ui"); document.body.classList.add("cine-idle"); }, 2200);
}

function enterCinema() {
  if (cine.on || !cur || !renderer) return;
  cine.on = true;
  $("#panel").classList.remove("is-open");
  document.body.classList.add("is-cinema", "cine-idle");
  cineEl.setAttribute("aria-hidden", "false");
  controls.enabled = false;
  controls.autoRotate = false;
  tween = null;
  if (!state.playing) togglePlay();
  const el = document.documentElement;
  if (el.requestFullscreen && !document.fullscreenElement) {
    el.requestFullscreen().then(() => { cine.fs = true; }).catch(() => { cine.fs = false; });
  }
  resize();
  cine.laps = 0;
  cine.pendingNext = false;
  cine.recent = [];
  startShot("wide");
  showCard();
  cineWake();
}

function exitCinema() {
  if (!cine.on) return;
  cine.on = false;
  document.body.classList.remove("is-cinema", "cine-idle");
  cineEl.setAttribute("aria-hidden", "true");
  cineEl.classList.remove("is-ui");
  cineFade.classList.remove("is-black");
  cineCard.classList.remove("is-on");
  clearTimeout(cine.cardTimer);
  if (cine.fs && document.fullscreenElement) document.exitFullscreen().catch(() => {});
  cine.fs = false;
  resize();
  controls.target.copy(lookAt);
  setCam(state.cam);
}

document.addEventListener("fullscreenchange", () => {
  // Esc in fullscreen is swallowed by the browser: leaving fullscreen means leaving cinema
  if (!document.fullscreenElement && cine.on && cine.fs) { cine.fs = false; exitCinema(); }
});
addEventListener("pointermove", cineWake, { passive: true });
addEventListener("pointerdown", cineWake, { passive: true });

/* ---------- main loop ---------- */
const clock = new THREE.Clock();
const hud = { speed: $("#hSpeed"), gear: $("#hGear"), thr: $("#hThr"), brk: $("#hBrk"), lap: $("#hLap"), lapN: $("#hLapN"), elev: $("#hElev"), s: [$("#hS1"), $("#hS2"), $("#hS3")] };

function sampleClock(P, c) {
  let lo = 0, hi = P.n;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (P.tc[m] <= c) lo = m; else hi = m; }
  const f = (c - P.tc[lo]) / Math.max(1e-6, P.tc[lo + 1] - P.tc[lo]);
  return [lo, Math.min(1, Math.max(0, f))];
}

/* trail: fixed-size line, rewritten in place every frame (no allocations) */
let trailN = 0;
function resetTrail(n) {
  trailN = Math.max(12, Math.round(n * 0.06)) + 1; // points incl. the car itself
  trail.geometry.dispose();
  trail.geometry = new LineGeometry();
  trail.geometry.setPositions(new Float32Array(trailN * 3));
  trail.geometry.setColors(new Float32Array(trailN * 3));
  trail.frustumCulled = false;
}
function updateTrail(i, f, n) {
  const g = trail.geometry;
  const pa = g.attributes.instanceStart.data, ca = g.attributes.instanceColorStart.data;
  const P = pa.array, C = ca.array, last = trailN - 1;
  const q0 = cur.pts[i], q1 = cur.pts[(i + 1) % n], ff = Math.max(f, 0.02);
  for (let k = 0; k < trailN; k++) {
    let x, y, z;
    if (k === last) { x = q0.x + (q1.x - q0.x) * ff; y = q0.y + (q1.y - q0.y) * ff; z = q0.z + (q1.z - q0.z) * ff; }
    else { const q = cur.pts[(i - (last - 1 - k) + n * 2) % n]; x = q.x; y = q.y; z = q.z; }
    const kk = k / last;
    // segment k-1 ends here, segment k starts here (interleaved start/end layout)
    if (k > 0) { const o = (k - 1) * 6 + 3; P[o] = x; P[o + 1] = y + 0.3; P[o + 2] = z; C[o] = kk; C[o + 1] = 0.16 * kk + (k === last ? 0.14 : 0); C[o + 2] = 0.24 * kk + (k === last ? 0.11 : 0); }
    if (k < last) { const o = k * 6; P[o] = x; P[o + 1] = y + 0.3; P[o + 2] = z; C[o] = kk; C[o + 1] = 0.16 * kk; C[o + 2] = 0.24 * kk; }
  }
  pa.needsUpdate = true;
  ca.needsUpdate = true;
}

/* HUD: touch the DOM only when a value actually changes */
const hudCache = new Map();
function setText(el, v) { if (hudCache.get(el) !== v) { hudCache.set(el, v); el.textContent = v; } }
function setHeight(el, v) { const s = v.toFixed(0) + "%"; if (hudCache.get(el) !== s) { hudCache.set(el, s); el.style.height = s; } }
let lastSector = -1, lastProfX = -1;

function frame(now) {
  requestAnimationFrame(frame);
  measure(now);
  const dt = Math.min(0.05, clock.getDelta());
  if (!cur || !cur.pts) return;

  // nothing moves: skip the frame entirely (damping still settles through controls.update)
  const active = state.playing || tween || cine.on || followBlend < 1 || dirty || (controls.enabled && controls.autoRotate);
  if (!active) { if (controls.enabled) controls.update(); if (!dirty) return; }
  dirty = false;

  const P = cur.P, n = P.n;
  if (state.playing) {
    state.clock += dt * state.rate;
    if (state.clock >= P.lap) { state.clock -= P.lap; state.lapN++; state.lastLap = P.lap; if (cine.on) cineLap(); }
  }
  const [i, f] = sampleClock(P, state.clock);
  const j = (i + 1) % n;
  const pos = carPos.lerpVectors(cur.pts[i], cur.pts[j], f);
  const fwd = tmpV2.lerpVectors(cur.tan[i], cur.tan[j], f).normalize();
  car.position.copy(pos);
  car.lookAt(pos.x + fwd.x, pos.y + fwd.y, pos.z + fwd.z);
  const far = cine.on ? cine.shot === "wide" : state.cam === "orbit" || state.cam === "top";
  carGlow.visible = far;
  if (far) {
    carGlow.position.set(pos.x, pos.y + 1.5, pos.z);
    const pulse = 0.045 + Math.sin(now / 180) * 0.008;
    carGlow.scale.set(pulse, pulse, 1);
  }
  updateTrail(i, f, n);

  // cameras
  const follow = cine.on ? cine.shot !== "wide" : state.cam === "chase" || state.cam === "onboard";
  if (cine.on) {
    cineCamera(dt, pos, fwd);
  } else if (follow) {
    // smooth the heading, not the position, so the camera never lags behind at 300+ km/h
    followDir.lerp(fwd, 1 - Math.exp(-dt * (state.cam === "onboard" ? 10 : 3.5))).normalize();
    const h = followDir;
    if (state.cam === "chase") {
      desiredPos.set(pos.x - h.x * 13, pos.y + 4.6 - h.y * 13, pos.z - h.z * 13);
      desiredLook.set(pos.x + h.x * 10, pos.y + 1.2 + h.y * 10, pos.z + h.z * 10);
    } else {
      desiredPos.set(pos.x + fwd.x * 0.5, pos.y + 1.12 + fwd.y * 0.5, pos.z + fwd.z * 0.5);
      desiredLook.set(pos.x + h.x * 40, pos.y + 0.9 + h.y * 40, pos.z + h.z * 40);
    }
    // blend in from wherever the camera was when the mode switched
    followBlend = Math.min(1, followBlend + dt / (reduceMotion ? 0.01 : 1.2));
    const e = ease(followBlend);
    camera.position.lerpVectors(followFrom, desiredPos, e);
    lookAt.lerpVectors(followLookFrom, desiredLook, e);
    camera.lookAt(lookAt);
  } else if (tween) {
    const kt = Math.min(1, (now - tween.start) / tween.dur), e = ease(kt);
    camera.position.lerpVectors(tween.p0, tween.p1, e);
    controls.target.lerpVectors(tween.t0, tween.t1, e);
    camera.lookAt(controls.target);
    if (kt >= 1) tween = null;
  } else if (active) {
    controls.update();
  }

  if (cur.curtain) {
    const u = cur.curtain.uniforms.uO, target = cine.on && follow ? 0 : follow ? 0.06 : 0.3;
    if (Math.abs(target - u.value) > 0.002) { u.value += (target - u.value) * Math.min(1, dt * 4); dirty = true; }
  }

  // HUD (hidden in cinema mode, so skip it there)
  if (!cine.on) {
    const v = P.v[i] + (P.v[j] - P.v[i]) * f;
    const k = kmh(v);
    setText(hud.speed, k);
    setText(hud.gear, gearOf(k));
    const a = P.acc[i];
    setHeight(hud.thr, a > -0.5 ? Math.min(100, 35 + (a / driveAcc(v)) * 65) : 0);
    setHeight(hud.brk, a < -0.5 ? Math.min(100, (-a / brakeAcc(v)) * 100) : 0);
    setText(hud.lap, fmtLap(state.clock));
    setText(hud.lapN, state.lapN);
    const sec = Math.min(2, Math.floor(((P.s[i] + P.ds[i] * f) / P.L) * 3));
    if (sec !== lastSector) {
      lastSector = sec;
      hud.s.forEach((el, q) => { el.classList.toggle("is-done", q < sec); el.classList.toggle("is-now", q === sec); });
    }
    setText(hud.elev, `${Math.round(cur.T.base + P.y[i])} ${t("unit.m")}`);
    const px = Math.round(((P.s[i] + P.ds[i] * f) / P.L) * prof.clientWidth * 2);
    if (px !== lastProfX) { lastProfX = px; drawProfile(i, f); }

    const W = canvas.clientWidth, H = canvas.clientHeight;
    for (const tg of tags) placeTag(tg.el, tg.pos, W, H);
    carTag.style.display = far ? "" : "none";
    if (far) placeTag(carTag, carTagPos.set(pos.x, pos.y + 2, pos.z), W, H);
  }

  renderCount++;
  if (bloom.enabled) composer.render();
  else renderer.render(scene, camera);
}

function resize() {
  if (!renderer) return;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  composer.setSize(w, h);
  const pr = renderer.getPixelRatio(), bs = QUALITY[qLevel].bs || 0.5;
  bloom.setSize(Math.round(w * pr * bs), Math.round(h * pr * bs));
  dirty = true;
  if (typeof cine !== "undefined") cine.wide = null;
  camera.aspect = w / h;
  for (const m of lineMats) m.resolution.set(w, h);
  computeViewOffset();
  camera.updateProjectionMatrix();
  drawProfileBase();
  movePill();
}

/* ==========================================================
   events
   ========================================================== */
function bindUI() {
  $$(".lang button").forEach(b => b.addEventListener("click", () => {
    lang = b.dataset.lang; store.set("lang", lang);
    applyLang(); renderList();
    if (cur) { updateInfo(cur.T, cur.P); if (renderer) buildTrack(); }
  }));
  $$("[data-filter]").forEach(b => b.addEventListener("click", () => setFilter(b.dataset.filter)));
  $("#search").addEventListener("input", e => { state.query = e.target.value; renderList(); });
  $("#list").addEventListener("click", e => {
    const r = e.target.closest(".row");
    if (!r) return;
    selectTrack(r.dataset.id);
    $("#panel").classList.remove("is-open");
  });
  $("#prevTrack").addEventListener("click", () => step(-1));
  $("#nextTrack").addEventListener("click", () => step(1));
  $("#openList").addEventListener("click", () => $("#panel").classList.add("is-open"));
  $("#closeList").addEventListener("click", () => $("#panel").classList.remove("is-open"));
  $("#play").addEventListener("click", togglePlay);
  $("#cineBtn").addEventListener("click", enterCinema);
  $("#cineExit").addEventListener("click", exitCinema);
  $$("#camSeg button").forEach(b => b.addEventListener("click", () => setCam(b.dataset.cam)));
  $$("#colorSeg button").forEach(b => b.addEventListener("click", () => {
    state.color = b.dataset.color;
    $$("#colorSeg button").forEach(x => x.classList.toggle("is-active", x === b));
    if (cur && renderer) buildTrack();
  }));
  $$("#rateSeg button").forEach(b => b.addEventListener("click", () => {
    state.rate = +b.dataset.rate;
    $$("#rateSeg button").forEach(x => x.classList.toggle("is-active", x === b));
  }));
  let exT = 0;
  $("#exag").addEventListener("input", e => {
    state.exag = +e.target.value;
    $("#exagVal").textContent = "×" + state.exag;
    clearTimeout(exT);
    exT = setTimeout(() => {
      if (!cur || !renderer) return;
      buildTrack();
      if (state.cam === "orbit" || state.cam === "top") { const f = framing(state.cam); controls.target.y = f.target.y; }
    }, 60);
  });
  addEventListener("keydown", e => {
    if (e.target.closest("input, textarea")) return;
    if (cine.on && (e.key === "ArrowRight" || e.key === "ArrowLeft")) cineTrack(e.key === "ArrowRight" ? 1 : -1);
    else if (e.key === "ArrowRight") step(1);
    else if (e.key === "ArrowLeft") step(-1);
    else if (e.key === " " && e.target === document.body) { e.preventDefault(); togglePlay(); }
    else if (!cine.on && ["1", "2", "3", "4"].includes(e.key)) setCam(["orbit", "top", "chase", "onboard"][+e.key - 1]);
    else if (e.key === "Escape") { if (cine.on) exitCinema(); else $("#panel").classList.remove("is-open"); }
    else if (e.code === "KeyC" && !e.ctrlKey && !e.metaKey && !e.altKey) { if (cine.on) exitCinema(); else enterCinema(); }
  });
}
function togglePlay() {
  state.playing = !state.playing;
  $("#play").classList.toggle("is-on", state.playing);
  // pause freezes the whole scene, so the GPU can idle
  if (controls) controls.autoRotate = state.playing && state.cam === "orbit" && !reduceMotion && !cine.on;
  dirty = true;
}

/* ---------- loader: five red lights, then lights out ---------- */
function runLoader() {
  const loader = $("#loader");
  const lights = $$(".light", loader);
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    loader.classList.add("is-done");
    document.body.classList.remove("is-loading");
  };
  loader.addEventListener("click", finish);
  if (reduceMotion) { finish(); return; }
  lights.forEach((l, i) => setTimeout(() => l.classList.add("is-on"), 250 + i * 320));
  setTimeout(() => { lights.forEach(l => l.classList.remove("is-on")); $("#loaderText").classList.add("is-on"); }, 250 + 5 * 320 + 450);
  setTimeout(finish, 250 + 5 * 320 + 1500);
}

/* ---------- boot ---------- */
applyLang();
bindUI();
setFilter(state.filter);
runLoader();

const initial = new URL(location.href).searchParams.get("track") || store.get("track", TRACKS[0] && TRACKS[0].id);
try {
  initThree();
  resize();
  selectTrack(byId[initial] ? initial : TRACKS[0].id, { push: false });
  $("#sceneStatus").classList.add("is-hidden");
  requestAnimationFrame(frame);
} catch (err) {
  console.error(err);
  $("#sceneStatus").textContent = t("viewer.error");
  selectTrack(byId[initial] ? initial : TRACKS[0].id, { push: false });
}
