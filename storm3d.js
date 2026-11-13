// 3D terrain and storm viewer (three.js). One pane, or two side by side (existing vs proposed) with locked
// cameras and a shared storm clock. Terrain shows satellite imagery or elevation colours; outlines, CAD lines
// and design edits are drawn on the ground; tracer particles show where surface water runs.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { StormSim, coarsen } from './storm.js';
import { hillshade, rampColor, quantile, M_TO_FT } from './earthwork.js';

const $ = (id) => document.getElementById(id);
const CFS = 35.3147, ACFT = 1 / 1233.48;
const IMAGERY = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export';
let V = null; // viewer state

// dem: { data, W, H, dx, dy, w, s, e, n }. opts: { title, depthIn, CN, mask, sinks, proposed (Float32Array on the
// same grid), outline [[lat, lon]], lines [{ pts: [[lat, lon]], color }], autoplay, compare, maxCells }
export function openStorm(dem, opts = {}) {
  closeStorm();
  const base = coarsen(dem.data, dem.W, dem.H, dem.dx, dem.dy, opts.maxCells || 128);
  const prop = opts.proposed ? coarsen(opts.proposed, dem.W, dem.H, dem.dx, dem.dy, opts.maxCells || 128) : null;
  const f = base.f, W = base.W, H = base.H;
  let rain = null;
  if (opts.mask) {
    rain = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let cnt = 0; for (let yy = 0; yy < f; yy++) for (let xx = 0; xx < f; xx++) cnt += opts.mask[(y * f + yy) * dem.W + x * f + xx];
      if (cnt * 2 >= f * f) rain[y * W + x] = 1;
    }
  }
  const sinks = (opts.sinks || []).map((k) => {
    const set = new Set();
    for (const i of k.cells) { const x = Math.floor((i % dem.W) / f), y = Math.floor(((i / dem.W) | 0) / f); if (x < W && y < H) set.add(y * W + x); }
    return { cells: [...set], capM3s: k.capM3s };
  });
  // Common height datum so both panes line up.
  let lo = Infinity; for (const g of [base, prop]) if (g) for (const v of g.z) if (v === v && v < lo) lo = v;
  // The grid's lat/lon extent after coarsening (it may lose a few edge cells).
  const ext = { w: dem.w, n: dem.n, e: dem.w + ((dem.e - dem.w) * W * f) / dem.W, s: dem.n - ((dem.n - dem.s) * H * f) / dem.H };
  $('storm').hidden = false; document.body.classList.add('modal-open');
  $('stTitle').textContent = opts.title || 'Storm simulation';
  $('stDepth').value = opts.depthIn ?? 5; $('stCN').value = opts.CN ?? 78;
  $('stCompareRow').hidden = !prop;
  $('stCompare').checked = !!prop && opts.compare !== false;
  V = { dem, opts, W, H, sx: base.dx, sy: base.dy, lo, rain, sinks, ext, base, prop, panes: [], playing: false, raf: 0, lastFrame: performance.now(), chartT: 0, imagery: null };
  buildPanes();
  window.addEventListener('resize', resize);
  loadImagery();
  loop();
  if (opts.autoplay !== false) setPlaying(true); else setPlaying(false);
  return V;
}

// (Re)create panes for the current compare setting.
function buildPanes() {
  const cam = V.panes[0] ? { p: V.panes[0].camera.position.clone(), t: V.panes[0].controls.target.clone() } : null;
  V.panes.forEach(disposePane); V.panes = [];
  const box = $('stViews'); box.innerHTML = '';
  const surfaces = V.prop && $('stCompare').checked ? [['Existing', V.base.z], ['Proposed', V.prop.z]] : [[V.prop ? 'Proposed' : '', (V.prop || V.base).z]];
  box.classList.toggle('two', surfaces.length === 2);
  for (const [label, z] of surfaces) V.panes.push(makePane(label, z, box));
  frameCamera(cam); resize(); applyLook(); resetSims();
}
function makePane(label, z, box) {
  const wrap = document.createElement('div'); wrap.className = 'stpane';
  const canvas = document.createElement('canvas'); canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', `3D view of ${label || 'the site'}: drag to rotate, scroll or pinch to zoom`);
  wrap.appendChild(canvas);
  if (label) { const t = document.createElement('span'); t.className = 'stlabel'; t.textContent = label; wrap.appendChild(t); }
  box.appendChild(wrap);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0x9fb4c4); scene.fog = new THREE.Fog(0x9fb4c4, 1, 1e9);
  const camera = new THREE.PerspectiveCamera(45, 1, 1, 1e6);
  const controls = new OrbitControls(camera, renderer.domElement); controls.enableDamping = true; controls.maxPolarAngle = Math.PI * 0.49;
  scene.add(new THREE.HemisphereLight(0xffffff, 0x5a6b55, 0.95));
  const sun = new THREE.DirectionalLight(0xffffff, 1.3); sun.position.set(-1, 2, 1.2); scene.add(sun);
  const { W, H } = V;
  const terrain = new THREE.Mesh(grid(W, H, V.sx, V.sy, true), new THREE.MeshLambertMaterial({ vertexColors: true }));
  const waterGeo = grid(W, H, V.sx, V.sy, false); waterGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(W * H * 4), 4));
  const water = new THREE.Mesh(waterGeo, new THREE.MeshPhongMaterial({ vertexColors: true, transparent: true, shininess: 90, specular: 0x88aacc, depthWrite: false }));
  const NP = 6000, NR = 2000;
  const tracers = points(NP, 0xeaf6ff, 2.4, 0.9), rain = points(NR, 0xc8d4e0, 1.6, 0.7);
  const trails = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(NP * 6), 3)),
    new THREE.LineBasicMaterial({ color: 0xbfe3ff, transparent: true, opacity: 0.55, depthWrite: false }));
  trails.frustumCulled = false;
  const lines = new THREE.Group();
  scene.add(terrain, water, trails, tracers, rain, lines);
  const pane = { label, z, wrap, canvas, renderer, scene, camera, controls, terrain, water, tracers, trails, rain, lines,
    tp: { x: new Float32Array(NP), y: new Float32Array(NP), px: new Float32Array(NP), py: new Float32Array(NP), age: new Float32Array(NP).fill(1e9), n: NP },
    rp: { x: new Float32Array(NR), y: new Float32Array(NR), z: new Float32Array(NR), n: NR }, sim: null };
  // Lock cameras: whichever pane the user drags drives the others.
  controls.addEventListener('change', () => { if (V.syncing) return; V.syncing = true; for (const p of V.panes) if (p !== pane) { p.camera.position.copy(camera.position); p.controls.target.copy(controls.target); p.controls.update(); } V.syncing = false; });
  return pane;
}
function points(n, color, size, opacity) {
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3).fill(-1e6), 3));
  const p = new THREE.Points(g, new THREE.PointsMaterial({ color, size, sizeAttenuation: false, transparent: true, opacity, depthWrite: false }));
  p.frustumCulled = false; return p;
}
function grid(W, H, sx, sy, uv) {
  const g = new THREE.BufferGeometry(), pos = new Float32Array(W * H * 3), idx = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 3; pos[i] = x * sx; pos[i + 2] = y * sy; }
  for (let y = 0; y < H - 1; y++) for (let x = 0; x < W - 1; x++) { const a = y * W + x; idx.push(a, a + W, a + 1, a + 1, a + W, a + W + 1); }
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setIndex(idx);
  if (uv) { const t = new Float32Array(W * H * 2); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { t[(y * W + x) * 2] = (x + 0.5) / W; t[(y * W + x) * 2 + 1] = 1 - (y + 0.5) / H; } g.setAttribute('uv', new THREE.BufferAttribute(t, 2)); }
  return g;
}
function disposePane(p) { p.terrain.geometry.dispose(); p.water.geometry.dispose(); p.tracers.geometry.dispose(); p.rain.geometry.dispose(); p.trails.geometry.dispose(); p.renderer.dispose(); }

// ---- look: satellite imagery or elevation colours; tint where the design changes the ground ----
function loadImagery() {
  const { ext } = V, aspect = ((ext.e - ext.w) * Math.cos(((ext.n + ext.s) / 2) * Math.PI / 180)) / (ext.n - ext.s);
  const w = aspect >= 1 ? 2048 : Math.round(2048 * aspect), h = aspect >= 1 ? Math.round(2048 / aspect) : 2048;
  const url = `${IMAGERY}?bbox=${ext.w},${ext.s},${ext.e},${ext.n}&bboxSR=4326&imageSR=4326&size=${w},${h}&format=jpg&f=image`;
  new THREE.TextureLoader().setCrossOrigin('anonymous').load(url, (tex) => { if (!V) return; tex.colorSpace = THREE.SRGBColorSpace; V.imagery = tex; applyLook(); },
    undefined, () => { if (V) { V.imageryFailed = true; applyLook(); } });
}
function applyLook() {
  const sat = $('stLook').value === 'satellite' && V.imagery;
  const { W, H, lo } = V, e = exag();
  for (const p of V.panes) {
    const z = p.z, pos = p.terrain.geometry.attributes.position;
    for (let i = 0; i < W * H; i++) pos.array[i * 3 + 1] = z[i] === z[i] ? (z[i] - lo) * e : 0;
    pos.needsUpdate = true; p.terrain.geometry.computeVertexNormals();
    const col = new Float32Array(W * H * 3), changed = p.label === 'Proposed' || (!p.label && V.prop);
    if (sat) col.fill(1);
    else {
      const vals = []; for (const v of z) if (v === v) vals.push(v);
      const zlo = quantile(vals, 0.02), zhi = quantile(vals, 0.98), hs = hillshade(z, W, H, V.sx, V.sy, { exaggeration: 3 });
      for (let i = 0; i < W * H; i++) {
        const [r, g, b] = z[i] === z[i] ? rampColor((z[i] - zlo) / Math.max(0.3, zhi - zlo)) : [70, 80, 90], s = hs[i] === hs[i] ? 0.55 + 0.6 * hs[i] : 0.6;
        col[i * 3] = Math.min(1, (r / 255) * s); col[i * 3 + 1] = Math.min(1, (g / 255) * s); col[i * 3 + 2] = Math.min(1, (b / 255) * s);
      }
    }
    // Proposed: tint ground the design raises (warm) or lowers (cool) so the regrading reads on imagery.
    if (changed && V.prop) for (let i = 0; i < W * H; i++) {
      const d = V.prop.z[i] - V.base.z[i]; if (!(Math.abs(d) > 0.03)) continue;
      const t = Math.min(1, Math.abs(d) / 0.6);
      if (d > 0) { col[i * 3] *= 1; col[i * 3 + 1] *= 1 - 0.18 * t; col[i * 3 + 2] *= 1 - 0.4 * t; }
      else { col[i * 3] *= 1 - 0.35 * t; col[i * 3 + 1] *= 1 - 0.15 * t; col[i * 3 + 2] *= 1; }
    }
    for (const k of V.sinks) for (const i of k.cells) { col[i * 3] = 0.55; col[i * 3 + 1] = 0.2; col[i * 3 + 2] = 0.85; }
    p.terrain.geometry.setAttribute('color', new THREE.BufferAttribute(col, 3));
    p.terrain.material.map = sat ? V.imagery : null; p.terrain.material.needsUpdate = true;
    drawLines(p);
  }
  updateWater();
}
// Outline, CAD lines and edit shapes draped on the ground (lat/lon → grid → surface height).
function drawLines(p) {
  p.lines.clear();
  const { ext, W, H, lo } = V, e = exag(), z = p.z;
  const toXYZ = ([la, lo2]) => {
    const gx = ((lo2 - ext.w) / (ext.e - ext.w)) * W - 0.5, gy = ((ext.n - la) / (ext.n - ext.s)) * H - 0.5;
    const i = Math.min(H - 1, Math.max(0, Math.round(gy))) * W + Math.min(W - 1, Math.max(0, Math.round(gx)));
    return new THREE.Vector3(gx * V.sx, ((z[i] === z[i] ? z[i] : lo) - lo) * e + 0.25, gy * V.sy);
  };
  const add = (pts, color, closed) => {
    const v = []; for (let k = 1; k < pts.length; k++) {
      // densify so the line follows the ground
      const a = pts[k - 1], b = pts[k], n = 8; for (let s = 0; s < n; s++) v.push(toXYZ([a[0] + ((b[0] - a[0]) * s) / n, a[1] + ((b[1] - a[1]) * s) / n]));
    }
    v.push(toXYZ(pts[pts.length - 1])); if (closed) v.push(toXYZ(pts[0]));
    p.lines.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(v), new THREE.LineBasicMaterial({ color })));
  };
  if (V.opts.outline) add(V.opts.outline, 0xffd400, true);
  for (const l of V.opts.lines || []) if (l.pts.length >= 2) add(l.pts, new THREE.Color(l.color), l.closed);
}

function exag() { return +$('stExag').value; }
function frameCamera(cam) {
  const w = V.W * V.sx, h = V.H * V.sy, r = Math.hypot(w, h);
  for (const p of V.panes) {
    if (cam) { p.camera.position.copy(cam.p); p.controls.target.copy(cam.t); }
    else { p.controls.target.set(w / 2, 0, h / 2); p.camera.position.set(w * 0.5, r * 1.05, h * 0.5 + r * 0.38); }
    p.camera.near = r / 1000; p.camera.far = r * 20; p.camera.updateProjectionMatrix();
    p.scene.fog.near = r * 1.5; p.scene.fog.far = r * 6;
  }
}
function resize() {
  if (!V) return;
  for (const p of V.panes) { const w = p.canvas.clientWidth, h = p.canvas.clientHeight; p.renderer.setSize(w, h, false); p.camera.aspect = w / Math.max(1, h); p.camera.updateProjectionMatrix(); }
  drawChart();
}

// ---- simulation ----
function resetSims() {
  const opt = { depthIn: +$('stDepth').value || 5, CN: Math.min(98, Math.max(30, +$('stCN').value || 78)), rainMask: V.rain, sinks: V.sinks, manning: +$('stN').value || 0.06 };
  for (const p of V.panes) {
    // Drain tile only belongs to the proposed design.
    p.sim = new StormSim(p.z, V.W, V.H, Math.sqrt(V.sx * V.sy), { ...opt, sinks: p.label === 'Existing' ? [] : V.sinks });
    p.tp.age.fill(1e9);
  }
  updateWater(); updateStats(); drawChart();
}
const MIN_SHOW = 0.0008;
function updateWater() {
  if (!V) return;
  const { W, H, lo } = V, e = exag(), showMax = $('stShowMax').checked;
  for (const p of V.panes) {
    if (!p.sim) continue;
    const pos = p.water.geometry.attributes.position, col = p.water.geometry.attributes.color, h = showMax ? p.sim.maxH : p.sim.h, b = p.sim.b, z = p.z;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x, bed = z[i] === z[i] ? z[i] : lo;
      let lvl = -Infinity;
      for (let yy = Math.max(0, y - 1); yy <= Math.min(H - 1, y + 1); yy++) for (let xx = Math.max(0, x - 1); xx <= Math.min(W - 1, x + 1); xx++) {
        const j = yy * W + xx; if (h[j] > MIN_SHOW) { const s2 = b[j] + h[j]; if (s2 > lvl) lvl = s2; }
      }
      const d = Math.max(0, lvl - bed), wet = d > MIN_SHOW, t = Math.min(1, Math.max(0, Math.log10(Math.max(d, 1e-3) / 1e-3) / Math.log10(500)));
      pos.array[i * 3] = x * V.sx; pos.array[i * 3 + 2] = y * V.sy;
      pos.array[i * 3 + 1] = wet ? (lvl - lo) * e + 0.02 : (bed - lo) * e - 0.05;
      col.array[i * 4] = 0.35 - 0.3 * t; col.array[i * 4 + 1] = 0.65 - 0.4 * t; col.array[i * 4 + 2] = 1.0 - 0.3 * t; col.array[i * 4 + 3] = wet ? 0.3 + 0.65 * t : 0;
    }
    pos.needsUpdate = true; col.needsUpdate = true; p.water.geometry.computeVertexNormals();
  }
}
// Tracers ride the depth-averaged velocity; short trails show the direction water is moving.
const VIS = 5;
function updateParticles(p, dtWall) {
  const { W, H, lo } = V, e = exag(), sim = p.sim, tp = p.tp, pos = p.tracers.geometry.attributes.position.array, tr = p.trails.geometry.attributes.position.array;
  const { fx, fxl, fy, fyu, h, b } = sim, dx = sim.dx, n = W * H;
  const yAt = (x, y) => { const j = Math.min(H - 1, Math.max(0, y | 0)) * W + Math.min(W - 1, Math.max(0, x | 0)); return (b[j] + h[j] - lo) * e + 0.08; };
  for (let k = 0; k < tp.n; k++) {
    let x = tp.x[k], y = tp.y[k], ix = x | 0, iy = y | 0, i = iy * W + ix;
    if (tp.age[k] > 6 || ix < 0 || iy < 0 || ix >= W || iy >= H || h[i] < 0.0015) {
      let ok = false;
      for (let t = 0; t < 30 && !ok; t++) { const j = (Math.random() * n) | 0; if (h[j] > 0.002 && Math.random() < Math.min(1, h[j] / 0.02)) { x = (j % W) + Math.random(); y = ((j / W) | 0) + Math.random(); ok = true; } }
      if (!ok) { pos[k * 3 + 1] = -1e6; tr[k * 6 + 1] = tr[k * 6 + 4] = -1e6; tp.age[k] = 1e9; continue; }
      tp.age[k] = Math.random() * 2; tp.px[k] = x; tp.py[k] = y; ix = x | 0; iy = y | 0; i = iy * W + ix;
    }
    const hh = Math.max(h[i], 0.002);
    const u = ((fx[i] - fxl[i]) + (ix > 0 ? fx[i - 1] : 0) - (ix < W - 1 ? fxl[i + 1] : 0)) / (2 * hh * dx);
    const v = ((fy[i] - fyu[i]) + (iy > 0 ? fy[i - W] : 0) - (iy < H - 1 ? fyu[i + W] : 0)) / (2 * hh * dx);
    let mx = u * VIS * dtWall, my = v * VIS * dtWall; const m = Math.hypot(mx, my); if (m > 0.9) { mx *= 0.9 / m; my *= 0.9 / m; }
    tp.px[k] = tp.px[k] * 0.85 + x * 0.15; tp.py[k] = tp.py[k] * 0.85 + y * 0.15; // trail tail lags behind
    tp.x[k] = x + mx; tp.y[k] = y + my; tp.age[k] += dtWall;
    pos[k * 3] = tp.x[k] * V.sx; pos[k * 3 + 2] = tp.y[k] * V.sy; pos[k * 3 + 1] = yAt(tp.x[k], tp.y[k]);
    tr[k * 6] = tp.px[k] * V.sx; tr[k * 6 + 2] = tp.py[k] * V.sy; tr[k * 6 + 1] = yAt(tp.px[k], tp.py[k]);
    tr[k * 6 + 3] = pos[k * 3]; tr[k * 6 + 4] = pos[k * 3 + 1]; tr[k * 6 + 5] = pos[k * 3 + 2];
  }
  p.tracers.geometry.attributes.position.needsUpdate = true; p.trails.geometry.attributes.position.needsUpdate = true;
}
function updateRain(p, dtWall) {
  const { W, H, lo } = V, e = exag(), sim = p.sim, rp = p.rp, pos = p.rain.geometry.attributes.position.array;
  const iNow = (sim.cumRainM(sim.t + 300) - sim.cumRainM(sim.t)) / 300 * 3600 / 0.0254;
  const active = V.playing ? Math.min(rp.n, Math.round(rp.n * Math.min(1, iNow / 1.5))) : 0, top = Math.max(30, Math.max(W * V.sx, H * V.sy) * 0.15);
  for (let k = 0; k < rp.n; k++) {
    if (k >= active) { pos[k * 3 + 1] = -1e6; continue; }
    rp.z[k] -= top * 1.6 * dtWall;
    if (!(rp.z[k] > 0) || rp.z[k] > top * 2) { rp.x[k] = Math.random() * W; rp.y[k] = Math.random() * H; rp.z[k] = top * (0.3 + Math.random()); }
    const j = Math.min(H - 1, rp.y[k] | 0) * W + Math.min(W - 1, rp.x[k] | 0);
    pos[k * 3] = rp.x[k] * V.sx; pos[k * 3 + 2] = rp.y[k] * V.sy; pos[k * 3 + 1] = (sim.b[j] - lo) * e + rp.z[k];
  }
  p.rain.geometry.attributes.position.needsUpdate = true;
}
function stats(p) {
  const sim = p.sim, b = sim.balance(), cellA = V.sx * V.sy, masked = !!V.rain;
  let wet = 0, deep = 0, maxd = 0; for (let i = 0; i < sim.h.length; i++) { if (sim.h[i] > 0.01) wet++; if (sim.h[i] > 0.15) deep++; if (sim.maxH[i] > maxd) maxd = sim.maxH[i]; }
  const inArea = masked ? sim.storedInMask() : b.stored;
  return { rain: sim.cumRainM(sim.t) / 0.0254, runoff: b.excess * ACFT, onSite: inArea * ACFT, off: (masked ? b.excess - inArea - b.tile : b.out) * ACFT,
    tile: b.tile * ACFT, peak: sim.history.reduce((m, r) => Math.max(m, r.q), 0) * CFS, wet: (wet * cellA) / 4046.86, deep: (deep * cellA) / 4046.86, maxd: maxd * M_TO_FT,
    err: b.excess > 0 ? (100 * Math.abs(b.error)) / b.excess : 0 };
}
function updateStats() {
  if (!V?.panes[0]?.sim) return;
  const t = Math.min(...V.panes.map((p) => p.sim.t)) / 3600;
  $('stClock').textContent = `${String(Math.floor(t)).padStart(2, '0')}:${String(Math.floor((t % 1) * 60)).padStart(2, '0')}`;
  const S = V.panes.map(stats), masked = !!V.rain, two = S.length === 2;
  const row = (label, f, better) => {
    const cells = S.map((s) => `<td>${f(s)}</td>`).join('');
    let delta = '';
    if (two && better) { const d = better(S[1]) - better(S[0]); delta = `<td class="${Math.abs(d) < 1e-9 ? '' : d < 0 ? 'good' : 'bad'}">${d > 0 ? '+' : ''}${Math.abs(d) >= 10 ? Math.round(d).toLocaleString('en-US') : d.toFixed(1)}</td>`; }
    else if (two) delta = '<td></td>';
    return `<tr><th scope="row">${label}</th>${cells}${delta}</tr>`;
  };
  $('stStats').innerHTML = `<thead><tr><th></th>${V.panes.map((p) => `<th>${p.label || 'Value'}</th>`).join('')}${two ? '<th>Change</th>' : ''}</tr></thead><tbody>
    ${row('Rain so far, in', (s) => s.rain.toFixed(2))}
    ${row('Runoff, ac-ft', (s) => s.runoff.toFixed(1))}
    ${row(masked ? 'Water on the site, ac-ft' : 'Ponded, ac-ft', (s) => s.onSite.toFixed(1))}
    ${row(masked ? 'Ran off the site, ac-ft' : 'Left the area, ac-ft', (s) => s.off.toFixed(1), (s) => s.off)}
    ${V.sinks.length ? row('Taken by tile, ac-ft', (s) => s.tile.toFixed(1)) : ''}
    ${row('Peak outflow, cfs', (s) => Math.round(s.peak).toLocaleString('en-US'), (s) => s.peak)}
    ${row('Over 6 in deep, ac', (s) => s.deep.toFixed(2), (s) => s.deep)}
    ${row('Deepest water, ft', (s) => s.maxd.toFixed(2))}
    ${row('Mass balance error, %', (s) => s.err.toFixed(2))}</tbody>`;
}
function drawChart() {
  if (!V?.panes[0]?.sim) return;
  const cv = $('stChart'), dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight; if (!W) return;
  cv.width = W * dpr; cv.height = H * dpr;
  const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
  const css = getComputedStyle(document.documentElement), muted = css.getPropertyValue('--muted'), line = css.getPropertyValue('--line');
  const T = 24 * 3600, L0 = 34, R0 = 34, T0 = 8, B0 = 18, X = (t) => L0 + (t / T) * (W - L0 - R0);
  const hist0 = V.panes[0].sim.history, imax = Math.max(1, ...hist0.map((r) => r.i));
  const qmax = Math.max(0.01, ...V.panes.flatMap((p) => p.sim.history.map((r) => r.q)));
  g.strokeStyle = line; g.strokeRect(L0, T0, W - L0 - R0, H - T0 - B0); g.font = '10px system-ui'; g.fillStyle = muted;
  for (let h = 0; h <= 24; h += 6) { g.textAlign = 'center'; g.fillText(`${h}h`, X(h * 3600), H - 5); }
  g.fillStyle = '#6b9ef0aa';
  for (let k = 1; k < hist0.length; k++) { const a = hist0[k - 1], b = hist0[k]; g.fillRect(X(a.t), T0, Math.max(1, X(b.t) - X(a.t) - 0.5), (b.i / imax) * (H - T0 - B0) * 0.45); }
  V.panes.forEach((p, n) => {
    g.strokeStyle = V.panes.length === 2 && n === 0 ? '#7a8590' : '#c8423a'; g.lineWidth = 2; g.setLineDash(V.panes.length === 2 && n === 0 ? [5, 4] : []); g.beginPath();
    p.sim.history.forEach((r, k) => { const y = H - B0 - (r.q / qmax) * (H - T0 - B0) * 0.9; (k ? g.lineTo : g.moveTo).call(g, X(r.t), y); }); g.stroke();
  });
  g.setLineDash([]); g.fillStyle = muted; g.textAlign = 'left'; g.fillText(`${(imax / 25.4).toFixed(2)} in/h`, 2, T0 + 9);
  g.textAlign = 'right'; g.fillStyle = '#c8423a'; g.fillText(`${Math.round(qmax * CFS)} cfs`, W - 2, T0 + 9);
  g.strokeStyle = muted; g.lineWidth = 1; g.beginPath(); g.moveTo(X(V.panes[0].sim.t), T0); g.lineTo(X(V.panes[0].sim.t), H - B0); g.stroke();
  $('stChartKey').innerHTML = V.panes.length === 2 ? '<span class="sw rain"></span>Rain <span class="sw dash"></span>Existing outflow <span class="sw flow"></span>Proposed outflow' : '<span class="sw rain"></span>Rain intensity <span class="sw flow"></span>Outflow';
}
function loop() {
  if (!V) return;
  V.raf = requestAnimationFrame(loop);
  const now = performance.now(), dtw = Math.min(0.1, (now - V.lastFrame) / 1000); V.lastFrame = now;
  if (V.playing && V.panes[0]?.sim) {
    // Advance every pane toward the same storm time so the comparison stays in step.
    const t0 = Math.min(...V.panes.map((p) => p.sim.t)), target = Math.min(26 * 3600, t0 + +$('stSpeed').value / 60), budget = 14 / V.panes.length;
    for (const p of V.panes) p.sim.run(target, budget);
    updateWater();
    for (const p of V.panes) { updateParticles(p, dtw); updateRain(p, dtw); }
    if (now - V.chartT > 250) { V.chartT = now; updateStats(); drawChart(); }
    if (Math.min(...V.panes.map((p) => p.sim.t)) >= 26 * 3600) { setPlaying(false); $('stPlay').textContent = 'Replay'; updateStats(); drawChart(); }
  }
  for (const p of V.panes) { p.controls.update(); p.renderer.render(p.scene, p.camera); }
}
function setPlaying(on) { V.playing = on; $('stPlay').textContent = on ? 'Pause' : 'Play storm'; }
export function closeStorm() {
  if (!V) return;
  cancelAnimationFrame(V.raf); window.removeEventListener('resize', resize);
  V.panes.forEach(disposePane); V.imagery?.dispose(); V = null;
  $('storm').hidden = true; document.body.classList.remove('modal-open');
}
$('stPlay').onclick = () => { if (!V) return; if (V.panes[0].sim.t >= 26 * 3600) resetSims(); setPlaying(!V.playing); };
$('stReset').onclick = () => { if (V) { setPlaying(false); resetSims(); } };
$('stClose').onclick = closeStorm;
$('stExag').oninput = () => V && applyLook();
$('stLook').onchange = () => V && applyLook();
$('stShowMax').onchange = () => V && updateWater();
$('stCompare').onchange = () => { if (V) { const was = V.playing; buildPanes(); setPlaying(was); } };
['stDepth', 'stCN', 'stN'].forEach((id) => $(id).addEventListener('change', () => { if (V) { setPlaying(false); resetSims(); } }));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && V) closeStorm(); });
// Test hook: state of the viewer (first pane mirrors the old single-pane fields).
window.__storm = { get ctx() { if (!V) return null; const p = V.panes[V.panes.length - 1]; return { sim: p.sim, playing: V.playing, c: { W: V.W, H: V.H, rain: V.rain, sinks: V.sinks }, tracers: p.tracers, rain: p.rain, renderer: p.renderer, panes: V.panes, V }; } };
