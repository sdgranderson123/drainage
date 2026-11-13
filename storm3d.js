// 3D storm viewer: terrain + live water surface (three.js), hyetograph/outflow chart, mass balance.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { StormSim, coarsen } from './storm.js';
import { hillshade, rampColor, quantile, M_TO_FT } from './earthwork.js';

const $ = (id) => document.getElementById(id);
const CFS = 35.3147;
let ctx = null; // current viewer state

// dem: { data, W, H, dx, dy }; opts: { title, depthIn, CN, mask? (Uint8Array, same grid) }
export function openStorm(dem, opts = {}) {
  closeStorm();
  const c = coarsen(dem.data, dem.W, dem.H, dem.dx, dem.dy, opts.maxCells || 128);
  // Optional rain mask (the property or drainage area): rain falls only there, water flows anywhere on the grid.
  c.drain = null; c.rain = null;
  if (opts.mask) {
    const f = c.f; c.rain = new Uint8Array(c.W * c.H);
    for (let y = 0; y < c.H; y++) for (let x = 0; x < c.W; x++) {
      let cnt = 0; for (let yy = 0; yy < f; yy++) for (let xx = 0; xx < f; xx++) cnt += opts.mask[(y * f + yy) * dem.W + x * f + xx];
      if (cnt * 2 >= f * f) c.rain[y * c.W + x] = 1;
    }
  }
  // Tile lines: map fine-grid cells onto the coarse simulation grid.
  c.sinks = (opts.sinks || []).map((k) => {
    const set = new Set();
    for (const i of k.cells) { const x = Math.floor((i % dem.W) / c.f), y = Math.floor(((i / dem.W) | 0) / c.f); if (x < c.W && y < c.H) set.add(y * c.W + x); }
    return { cells: [...set], capM3s: k.capM3s };
  });
  const root = $('storm');
  root.hidden = false; document.body.classList.add('modal-open');
  $('stTitle').textContent = opts.title || 'Storm simulation';
  $('stDepth').value = opts.depthIn ?? 5; $('stCN').value = opts.CN ?? 78;
  const renderer = new THREE.WebGLRenderer({ canvas: $('stCanvas'), antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0x9fb4c4);
  scene.fog = new THREE.Fog(0x9fb4c4, 1, 1e9);
  const camera = new THREE.PerspectiveCamera(45, 1, 1, 1e6);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.maxPolarAngle = Math.PI * 0.49;
  scene.add(new THREE.HemisphereLight(0xffffff, 0x5a6b55, 0.9));
  const sun = new THREE.DirectionalLight(0xffffff, 1.4); sun.position.set(-1, 2, 1.2); scene.add(sun);

  const { W, H } = c, sx = c.dx, sy = c.dy;
  let lo = Infinity; for (const v of c.z) if (Number.isFinite(v) && v < lo) lo = v;
  const vals = []; for (const v of c.z) if (Number.isFinite(v)) vals.push(v);
  const zlo = quantile(vals, 0.02), zhi = quantile(vals, 0.98);
  const terrainGeo = grid(W, H, sx, sy), waterGeo = grid(W, H, sx, sy);
  const tColor = new Float32Array(W * H * 3), hs = hillshade(c.z, W, H, sx, sy, { exaggeration: 3 });
  for (let i = 0; i < W * H; i++) {
    const v = c.z[i], [r, g, b] = Number.isFinite(v) ? rampColor((v - zlo) / Math.max(0.3, zhi - zlo)) : [70, 80, 90];
    const s = (Number.isFinite(hs[i]) ? 0.55 + 0.6 * hs[i] : 0.6) * (c.rain && !c.rain[i] ? 0.7 : 1);
    tColor[i * 3] = Math.min(1, (r / 255) * s); tColor[i * 3 + 1] = Math.min(1, (g / 255) * s); tColor[i * 3 + 2] = Math.min(1, (b / 255) * s);
  }
  // Yellow outline on the edge of the rain area (the property / drainage area).
  if (c.rain) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x; if (!c.rain[i]) continue;
    const edge = x === 0 || y === 0 || x === W - 1 || y === H - 1 || !c.rain[i - 1] || !c.rain[i + 1] || !c.rain[i - W] || !c.rain[i + W];
    if (edge) { tColor[i * 3] = 1; tColor[i * 3 + 1] = 0.83; tColor[i * 3 + 2] = 0; }
  }
  for (const k of c.sinks) for (const i of k.cells) { tColor[i * 3] = 0.55; tColor[i * 3 + 1] = 0.2; tColor[i * 3 + 2] = 0.85; } // tile lines
  terrainGeo.setAttribute('color', new THREE.BufferAttribute(tColor, 3));
  const terrain = new THREE.Mesh(terrainGeo, new THREE.MeshLambertMaterial({ vertexColors: true }));
  const wColor = new Float32Array(W * H * 4);
  waterGeo.setAttribute('color', new THREE.BufferAttribute(wColor, 4));
  const water = new THREE.Mesh(waterGeo, new THREE.MeshPhongMaterial({ vertexColors: true, transparent: true, shininess: 90, specular: 0x88aacc, depthWrite: false }));
  scene.add(terrain, water);
  // Moving water: tracer particles carried by the simulated flow, and falling rain.
  const NP = 6000, pPos = new Float32Array(NP * 3), pGeo = new THREE.BufferGeometry();
  pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
  const tracers = new THREE.Points(pGeo, new THREE.PointsMaterial({ color: 0xeaf6ff, size: 2.4, sizeAttenuation: false, transparent: true, opacity: 0.9, depthWrite: false }));
  const NR = 2500, rPos = new Float32Array(NR * 3), rGeo = new THREE.BufferGeometry();
  rGeo.setAttribute('position', new THREE.BufferAttribute(rPos, 3));
  const rain = new THREE.Points(rGeo, new THREE.PointsMaterial({ color: 0xc8d4e0, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0.7, depthWrite: false }));
  tracers.frustumCulled = rain.frustumCulled = false;
  scene.add(tracers, rain);

  const sim = new StormSim(c.z, W, H, Math.sqrt(sx * sy), { depthIn: +$('stDepth').value, CN: +$('stCN').value, drain: c.drain, rainMask: c.rain, sinks: c.sinks, manning: +$('stN').value });
  ctx = { renderer, scene, camera, controls, terrain, water, c, sim, lo, playing: false, raf: 0, sx, sy, cellArea: sx * sy, opts, dem,
    tracers, rain, tp: { x: new Float32Array(NP), y: new Float32Array(NP), age: new Float32Array(NP).fill(1e9), n: NP },
    rp: { x: new Float32Array(NR), y: new Float32Array(NR), z: new Float32Array(NR), n: NR }, lastFrame: performance.now() };
  setExaggeration();
  frameCamera();
  resize(); window.addEventListener('resize', resize);
  updateWater(); drawChart(); updateStats();
  loop();
  if (opts.autoplay !== false) { ctx.playing = true; $('stPlay').textContent = 'Pause'; }
  return ctx;
}

function grid(W, H, sx, sy) {
  const g = new THREE.BufferGeometry(), pos = new Float32Array(W * H * 3), idx = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 3; pos[i] = x * sx; pos[i + 2] = y * sy; }
  for (let y = 0; y < H - 1; y++) for (let x = 0; x < W - 1; x++) { const a = y * W + x; idx.push(a, a + W, a + 1, a + 1, a + W, a + W + 1); }
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setIndex(idx);
  return g;
}
function exag() { return +$('stExag').value; }
function setExaggeration() {
  const { c, terrain, lo } = ctx, p = terrain.geometry.attributes.position, e = exag();
  for (let i = 0; i < c.W * c.H; i++) p.array[i * 3 + 1] = Number.isFinite(c.z[i]) ? (c.z[i] - lo) * e : 0;
  p.needsUpdate = true; terrain.geometry.computeVertexNormals();
  updateWater();
}
function frameCamera() {
  const { c, camera, controls, sx, sy } = ctx, w = c.W * sx, h = c.H * sy, r = Math.hypot(w, h);
  controls.target.set(w / 2, 0, h / 2);
  // Nearly straight down with a slight tilt so relief still reads; drag to orbit.
  camera.position.set(w * 0.5, r * 1.05, h * 0.5 + r * 0.38);
  camera.near = r / 1000; camera.far = r * 20; camera.updateProjectionMatrix();
  ctx.scene.fog.near = r * 1.5; ctx.scene.fog.far = r * 6;
}
function resize() {
  if (!ctx) return;
  const cv = $('stCanvas'), w = cv.clientWidth, h = cv.clientHeight;
  ctx.renderer.setSize(w, h, false); ctx.camera.aspect = w / Math.max(1, h); ctx.camera.updateProjectionMatrix();
  drawChart();
}
const MIN_SHOW = 0.0008; // m: show even thin sheet flow
function updateWater() {
  const { c, sim, water, lo } = ctx, p = water.geometry.attributes.position, col = water.geometry.attributes.color, e = exag();
  const showMax = $('stShowMax').checked, h = showMax ? sim.maxH : sim.h, W = c.W, H = c.H, b = sim.b;
  // Display level per vertex: highest wet water surface among the 3x3 neighbours, so one-cell channels
  // render as continuous ribbons instead of isolated triangles. Physics is unaffected.
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, bed = Number.isFinite(c.z[i]) ? c.z[i] : lo;
    let lvl = -Infinity;
    for (let yy = Math.max(0, y - 1); yy <= Math.min(H - 1, y + 1); yy++) for (let xx = Math.max(0, x - 1); xx <= Math.min(W - 1, x + 1); xx++) {
      const j = yy * W + xx; if (h[j] > MIN_SHOW) { const s2 = b[j] + h[j]; if (s2 > lvl) lvl = s2; }
    }
    const d = Math.max(0, lvl - bed), wet = d > MIN_SHOW;
    p.array[i * 3 + 1] = wet ? (lvl - lo) * e + 0.02 : (bed - lo) * e - 0.05;
    // Depth on a log scale (1 mm → 0, 0.5 m → 1) so sheet flow shows faintly and channels/ponds strongly.
    const t = Math.min(1, Math.max(0, Math.log10(Math.max(d, 1e-3) / 1e-3) / Math.log10(500)));
    col.array[i * 4] = 0.35 - 0.3 * t; col.array[i * 4 + 1] = 0.65 - 0.4 * t; col.array[i * 4 + 2] = 1.0 - 0.3 * t;
    col.array[i * 4 + 3] = wet ? 0.3 + 0.65 * t : 0;
  }
  p.needsUpdate = true; col.needsUpdate = true; water.geometry.computeVertexNormals();
}
function updateStats() {
  const { sim, cellArea, c } = ctx, b = sim.balance(), hr = sim.t / 3600;
  let wet = 0, deep = 0, maxd = 0;
  for (let i = 0; i < sim.h.length; i++) { if (sim.h[i] > 0.01) wet++; if (sim.h[i] > 0.15) deep++; if (sim.maxH[i] > maxd) maxd = sim.maxH[i]; }
  const area = sim.active * cellArea, toAcFt = 1 / 1233.48, rainIn = sim.cumRainM(sim.t) / 0.0254;
  const peak = sim.history.reduce((m, r) => Math.max(m, r.q), 0);
  $('stClock').textContent = `${String(Math.floor(hr)).padStart(2, '0')}:${String(Math.floor((hr % 1) * 60)).padStart(2, '0')}`;
  $('stStats').innerHTML = `
    <dt>Rain so far</dt><dd>${rainIn.toFixed(2)} in</dd>
    <dt>Runoff so far</dt><dd>${(b.excess / area / 0.0254).toFixed(2)} in · ${(b.excess * toAcFt).toFixed(1)} ac-ft</dd>
    <dt>${c.rain ? 'Water on the property' : 'Ponded now'}</dt><dd>${((c.rain ? sim.storedInMask() : b.stored) * toAcFt).toFixed(1)} ac-ft</dd>
    <dt>${c.rain ? 'Ran off the property' : 'Left the area'}</dt><dd>${((c.rain ? b.excess - sim.storedInMask() - b.tile : b.out) * toAcFt).toFixed(1)} ac-ft</dd>
    ${c.sinks.length ? `<dt>Taken by drain tile</dt><dd>${(b.tile * toAcFt).toFixed(1)} ac-ft</dd>` : ''}
    <dt>Peak outflow</dt><dd>${Math.round(peak * CFS).toLocaleString('en-US')} cfs</dd>
    <dt>Wet / over 6 in deep</dt><dd>${(wet * cellArea / 4046.86).toFixed(1)} / ${(deep * cellArea / 4046.86).toFixed(1)} ac</dd>
    <dt>Deepest water</dt><dd>${(maxd * M_TO_FT).toFixed(2)} ft</dd>
    <dt>Mass balance error</dt><dd>${b.excess > 0 ? (100 * Math.abs(b.error) / b.excess).toFixed(2) : '0.00'}%</dd>`;
}
function drawChart() {
  if (!ctx) return;
  const cv = $('stChart'), dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
  if (!W) return;
  cv.width = W * dpr; cv.height = H * dpr;
  const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
  const css = getComputedStyle(document.documentElement), muted = css.getPropertyValue('--muted'), line = css.getPropertyValue('--line');
  const hist = ctx.sim.history, T = 24 * 3600, L0 = 34, R0 = 34, T0 = 8, B0 = 18;
  const X = (t) => L0 + (t / T) * (W - L0 - R0);
  const imax = Math.max(1, ...hist.map((r) => r.i)), qmax = Math.max(0.01, ...hist.map((r) => r.q));
  g.strokeStyle = line; g.strokeRect(L0, T0, W - L0 - R0, H - T0 - B0);
  g.font = '10px system-ui'; g.fillStyle = muted;
  for (let h = 0; h <= 24; h += 6) { g.textAlign = 'center'; g.fillText(`${h}h`, X(h * 3600), H - 5); }
  // rain bars from top
  g.fillStyle = '#6b9ef0aa';
  for (let k = 1; k < hist.length; k++) { const a = hist[k - 1], b = hist[k], hh = (b.i / imax) * (H - T0 - B0) * 0.45; g.fillRect(X(a.t), T0, Math.max(1, X(b.t) - X(a.t) - 0.5), hh); }
  // outflow line
  g.strokeStyle = '#c8423a'; g.lineWidth = 2; g.beginPath();
  hist.forEach((r, k) => { const y = H - B0 - (r.q / qmax) * (H - T0 - B0) * 0.9; (k ? g.lineTo : g.moveTo).call(g, X(r.t), y); }); g.stroke();
  g.fillStyle = muted; g.textAlign = 'left'; g.fillText(`${(imax / 25.4).toFixed(2)} in/h`, 2, T0 + 9);
  g.textAlign = 'right'; g.fillStyle = '#c8423a'; g.fillText(`${Math.round(qmax * CFS)} cfs`, W - 2, T0 + 9);
  // now marker
  g.strokeStyle = muted; g.lineWidth = 1; g.beginPath(); g.moveTo(X(ctx.sim.t), T0); g.lineTo(X(ctx.sim.t), H - B0); g.stroke();
}
let chartT = 0;
// Tracers: placed on wet cells (deeper water more likely), moved along the depth-averaged velocity.
const VIS = 5;     // cells per second of screen time for 1 m/s of flow (real speeds are far too fast to see at 1 h/s)
function respawn(tp, k) {
  const { sim, c } = ctx, n = c.W * c.H;
  for (let t = 0; t < 30; t++) {
    const i = (Math.random() * n) | 0, h = sim.h[i];
    if (h > 0.002 && Math.random() < Math.min(1, h / 0.02)) { tp.x[k] = (i % c.W) + Math.random(); tp.y[k] = ((i / c.W) | 0) + Math.random(); tp.age[k] = Math.random() * 2; return true; }
  }
  tp.age[k] = 1e9; return false;
}
function updateParticles(dtWall) {
  const { sim, c, tp, tracers, lo } = ctx, W = c.W, H = c.H, e = exag(), dx = sim.dx, pos = tracers.geometry.attributes.position.array;
  const { fx, fxl, fy, fyu, h, b } = sim;
  for (let k = 0; k < tp.n; k++) {
    let x = tp.x[k], y = tp.y[k];
    let ix = x | 0, iy = y | 0, i = iy * W + ix;
    if (tp.age[k] > 6 || ix < 0 || iy < 0 || ix >= W || iy >= H || h[i] < 0.0015) { if (!respawn(tp, k)) { pos[k * 3 + 1] = -1e6; continue; } x = tp.x[k]; y = tp.y[k]; ix = x | 0; iy = y | 0; i = iy * W + ix; }
    const hh = Math.max(h[i], 0.002);
    // Depth-averaged velocity (m/s) from the pipe fluxes through the cell's faces.
    const u = ((fx[i] - fxl[i]) + (ix > 0 ? fx[i - 1] : 0) - (ix < W - 1 ? fxl[i + 1] : 0)) / (2 * hh * dx);
    const v = ((fy[i] - fyu[i]) + (iy > 0 ? fy[i - W] : 0) - (iy < H - 1 ? fyu[i + W] : 0)) / (2 * hh * dx);
    let mx = u * VIS * dtWall, my = v * VIS * dtWall; const m = Math.hypot(mx, my); if (m > 0.9) { mx *= 0.9 / m; my *= 0.9 / m; }
    tp.x[k] = x + mx; tp.y[k] = y + my; tp.age[k] += dtWall;
    const j = (Math.min(H - 1, Math.max(0, tp.y[k] | 0))) * W + Math.min(W - 1, Math.max(0, tp.x[k] | 0));
    pos[k * 3] = tp.x[k] * ctx.sx; pos[k * 3 + 2] = tp.y[k] * ctx.sy; pos[k * 3 + 1] = (b[j] + h[j] - lo) * e + 0.08;
  }
  tracers.geometry.attributes.position.needsUpdate = true;
}
// Rain: count follows the current intensity; drops fall and restart above the terrain.
function updateRain(dtWall) {
  const { sim, c, rp, rain, lo } = ctx, e = exag(), pos = rain.geometry.attributes.position.array;
  const now = sim.t, iNow = (sim.cumRainM(now + 300) - sim.cumRainM(now)) / 300 * 3600 / 0.0254; // in/h
  const active = ctx.playing ? Math.min(rp.n, Math.round(rp.n * Math.min(1, iNow / 1.5))) : 0;
  const top = Math.max(30, (Math.max(c.W * ctx.sx, c.H * ctx.sy)) * 0.15);
  for (let k = 0; k < rp.n; k++) {
    if (k >= active) { pos[k * 3 + 1] = -1e6; continue; }
    rp.z[k] -= top * 1.6 * dtWall;
    if (!(rp.z[k] > 0) || rp.z[k] > top * 2) { rp.x[k] = Math.random() * c.W; rp.y[k] = Math.random() * c.H; rp.z[k] = top * (0.3 + Math.random()); }
    const j = Math.min(c.H - 1, rp.y[k] | 0) * c.W + Math.min(c.W - 1, rp.x[k] | 0);
    pos[k * 3] = rp.x[k] * ctx.sx; pos[k * 3 + 2] = rp.y[k] * ctx.sy; pos[k * 3 + 1] = (sim.b[j] - lo) * e + rp.z[k];
  }
  rain.geometry.attributes.position.needsUpdate = true;
}
function loop() {
  if (!ctx) return;
  ctx.raf = requestAnimationFrame(loop);
  const { sim } = ctx;
  if (ctx.playing) {
    const speed = +$('stSpeed').value; // simulated seconds per wall second
    const target = Math.min(24 * 3600 + 2 * 3600, sim.t + speed / 60);
    const done = sim.run(target, 14);
    updateWater();
    const nowT = performance.now(), dtw = Math.min(0.1, (nowT - ctx.lastFrame) / 1000); ctx.lastFrame = nowT;
    updateParticles(dtw); updateRain(dtw);
    if (performance.now() - chartT > 250) { chartT = performance.now(); updateStats(); drawChart(); }
    if (done && sim.t >= 26 * 3600) { ctx.playing = false; $('stPlay').textContent = 'Replay'; updateStats(); drawChart(); }
  }
  ctx.controls.update();
  ctx.renderer.render(ctx.scene, ctx.camera);
}
function reset() {
  if (!ctx) return;
  const { c, sx, sy } = ctx;
  ctx.sim = new StormSim(c.z, c.W, c.H, Math.sqrt(sx * sy), { depthIn: +$('stDepth').value || 5, CN: Math.min(98, Math.max(30, +$('stCN').value || 78)), drain: c.drain, rainMask: c.rain, sinks: c.sinks, manning: +$('stN').value || 0.06 });
  updateWater(); updateStats(); drawChart();
}
export function closeStorm() {
  if (!ctx) return;
  cancelAnimationFrame(ctx.raf); window.removeEventListener('resize', resize);
  ctx.terrain.geometry.dispose(); ctx.water.geometry.dispose(); ctx.tracers.geometry.dispose(); ctx.rain.geometry.dispose(); ctx.renderer.dispose();
  ctx = null;
  $('storm').hidden = true; document.body.classList.remove('modal-open');
}
// Wire controls once.
$('stPlay').onclick = () => {
  if (!ctx) return;
  if (ctx.sim.t >= 26 * 3600) reset();
  ctx.playing = !ctx.playing; $('stPlay').textContent = ctx.playing ? 'Pause' : 'Play storm';
};
$('stReset').onclick = () => { if (ctx) { ctx.playing = false; $('stPlay').textContent = 'Play storm'; reset(); } };
$('stClose').onclick = closeStorm;
$('stExag').oninput = () => ctx && setExaggeration();
$('stShowMax').onchange = () => ctx && updateWater();
['stDepth', 'stCN', 'stN'].forEach((id) => $(id).addEventListener('change', () => { if (ctx) { ctx.playing = false; $('stPlay').textContent = 'Play storm'; reset(); } }));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && ctx) closeStorm(); });
window.__storm = { get ctx() { return ctx; } };
