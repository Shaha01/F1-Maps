// Builds data/tracks.js from the bacinger/f1-circuits GeoJSON (MIT)
// and real terrain elevation (Open-Meteo Elevation API / Copernicus DEM 90 m, fallback OpenTopoData / SRTM 90 m).
// Usage: node tools/build-tracks.mjs <path/to/f1-circuits> [out]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const src = process.argv[2];
const out = process.argv[3] || "data/tracks.js";
if (!src) { console.error("usage: node tools/build-tracks.mjs <f1-circuits dir>"); process.exit(1); }

const geo = JSON.parse(fs.readFileSync(path.join(src, "f1-circuits.geojson"), "utf8"));
const season = JSON.parse(fs.readFileSync(path.join(src, "championships", "f1-locations-2026.json"), "utf8")).map(x => x.id);
const cachePath = path.join(path.dirname(fileURLToPath(import.meta.url)), ".elev-cache.json");
const cache = fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, "utf8")) : {};

const STEP = 12;        // geometry spacing, m
const ELEV_STEP = 30;   // elevation sampling spacing, m
const R = 6371008.8;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function elevations(lats, lons) {
  const res = [];
  for (let i = 0; i < lats.length; i += 100) {
    const la = lats.slice(i, i + 100).map(v => v.toFixed(6)).join(",");
    const lo = lons.slice(i, i + 100).map(v => v.toFixed(6)).join(",");
    const key = la + "|" + lo;
    if (!cache[key]) {
      // Primary: Open-Meteo (Copernicus DEM). It counts every coordinate against an hourly quota,
      // so on 429 fall back to OpenTopoData (SRTM 90 m, 100 points/request, 1 request/s).
      const r = await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${la}&longitude=${lo}`);
      if (r.ok) cache[key] = (await r.json()).elevation;
      else {
        const locs = la.split(",").map((v, k) => v + "," + lo.split(",")[k]).join("|");
        for (let attempt = 0; ; attempt++) {
          const r2 = await fetch(`https://api.opentopodata.org/v1/srtm90m?locations=${locs}`);
          if (r2.ok) { cache[key] = (await r2.json()).results.map(x => x.elevation ?? 0); break; }
          if (attempt > 6) throw new Error("elevation APIs " + r.status + " / " + r2.status);
          await sleep(3000 * (attempt + 1));
        }
      }
      await sleep(1200);
    }
    res.push(...cache[key]);
  }
  return res;
}

function resample(pts, step) {
  // pts closed loop [[x,z],...] (no duplicate end). Returns evenly spaced points + total length.
  const n = pts.length, cum = [0];
  for (let i = 1; i <= n; i++) {
    const a = pts[i - 1], b = pts[i % n];
    cum.push(cum[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const L = cum[n], count = Math.max(32, Math.round(L / step)), outp = [];
  let j = 0;
  for (let k = 0; k < count; k++) {
    const d = (k / count) * L;
    while (cum[j + 1] < d) j++;
    const a = pts[j], b = pts[(j + 1) % n], t = (d - cum[j]) / (cum[j + 1] - cum[j] || 1);
    outp.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return { pts: outp, L };
}

function smoothLoop(arr, passes, w = 1) {
  let a = arr.slice();
  const n = a.length;
  for (let p = 0; p < passes; p++) {
    const b = new Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0, c = 0;
      for (let k = -w; k <= w; k++) { s += a[(i + k + n) % n]; c++; }
      b[i] = s / c;
    }
    a = b;
  }
  return a;
}

function medianLoop(arr, w) {
  const n = arr.length;
  return arr.map((_, i) => {
    const win = [];
    for (let k = -w; k <= w; k++) win.push(arr[(i + k + n) % n]);
    win.sort((x, y) => x - y);
    return win[w];
  });
}

const tracks = [];
for (const f of geo.features) {
  const p = f.properties;
  let coords = f.geometry.coordinates;
  const lon0 = coords.reduce((s, c) => s + c[0], 0) / coords.length;
  const lat0 = coords.reduce((s, c) => s + c[1], 0) / coords.length;
  const kx = (Math.PI / 180) * R * Math.cos(lat0 * Math.PI / 180), ky = (Math.PI / 180) * R;
  let xy = coords.map(c => [(c[0] - lon0) * kx, -(c[1] - lat0) * ky]); // x east, z south
  const first = xy[0], last = xy[xy.length - 1];
  if (Math.hypot(first[0] - last[0], first[1] - last[1]) < 1) xy.pop();

  const geom = resample(xy, STEP);
  // light corner rounding
  let gx = smoothLoop(geom.pts.map(q => q[0]), 2), gz = smoothLoop(geom.pts.map(q => q[1]), 2);

  // elevation samples
  const es = resample(xy, ELEV_STEP).pts;
  const lats = es.map(q => lat0 - q[1] / ky), lons = es.map(q => lon0 + q[0] / kx);
  let el = await elevations(lats, lons);
  // DEM is a surface model: kill building/tree spikes, then smooth
  el = medianLoop(el, 3);
  el = smoothLoop(el, 4, 2);
  // interpolate onto geometry points
  const m = es.length, n = gx.length;
  let ey = gx.map((_, i) => {
    const u = (i / n) * m, i0 = Math.floor(u) % m, i1 = (i0 + 1) % m, t = u - Math.floor(u);
    return el[i0] * (1 - t) + el[i1] * t;
  });
  // limit gradient to a plausible max (~18%)
  const maxD = STEP * 0.18;
  for (let pass = 0; pass < 6; pass++) for (let i = 0; i < n; i++) {
    const prev = ey[(i - 1 + n) % n], d = ey[i] - prev;
    if (Math.abs(d) > maxD) ey[i] = prev + Math.sign(d) * maxD * 0.999 + (d - Math.sign(d) * maxD) * 0.5;
  }
  ey = smoothLoop(ey, 3, 2);
  const minE = Math.min(...ey);

  const r1 = v => Math.round(v * 10) / 10;
  tracks.push({
    id: p.id, name: p.Name, city: p.Location, cc: p.id.slice(0, 2),
    length: p.length, opened: p.opened, firstgp: p.firstgp, altitude: p.altitude,
    season: season.indexOf(p.id), // index in 2026 calendar or -1
    lat: r1(lat0 * 10) / 10, lon: r1(lon0 * 10) / 10,
    base: Math.round(minE),
    x: gx.map(r1), z: gz.map(r1), y: ey.map(v => r1(v - minE)),
  });
  console.log(p.id.padEnd(8), String(n).padStart(4), "pts", Math.round(geom.L), "m  Δh", Math.round(Math.max(...ey) - minE), "m");
  fs.writeFileSync(cachePath, JSON.stringify(cache));
}

fs.writeFileSync(out,
  "/* F1 circuits. Geometry: github.com/bacinger/f1-circuits (MIT). Elevation: Open-Meteo (Copernicus DEM GLO-90) + OpenTopoData (SRTM 90 m). Generated by tools/build-tracks.mjs */\n" +
  "window.TRACKS = " + JSON.stringify(tracks) + ";\n");
console.log("wrote", out, (fs.statSync(out).size / 1024).toFixed(0), "KB");
