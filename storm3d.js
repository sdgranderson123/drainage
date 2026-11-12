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
  // Optional study-area mask: cells outside it drain water away but keep their ground level.
  c.drain = null;
  if (opts.mask) {
    const f = c.f; c.drain = new Uint8Array(c.W * c.H);
    for (let y = 0; y < c.H; y++) for (let x = 0; x < c.W; x++) {
      let cnt = 0; for (let yy = 0; yy < f; yy++) for (let xx = 0; xx < f; xx++) cnt += opts.mask[(y * f + yy) * dem.W + x * f + xx];
      if (cnt * 2 < f * f) c.drain[y * c.W + x] = 1;
    }
  }
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
    const s = (Number.isFinite(hs[i]) ? 0.55 + 0.6 * hs[i] : 0.6) * (c.drain && c.drain[i] ? 0.45 : 1);
    tColor[i * 3] = Math.min(1, (r / 255) * s); tColor[i * 3 + 1] = Math.min(1, (g / 255) * s); tColor[i * 3 + 2] = Math.min(1, (b / 255) * s);
  }
  terrainGeo.setAttribute('color', new THREE.BufferAttribute(tColor, 3));
  const terrain = new THREE.Mesh(terrainGeo, new THREE.MeshLambertMaterial({ vertexColors: true }));
  const wColor = new Float32Array(W * H * 4);
  waterGeo.setAttribute('color', new THREE.BufferAttribute(wColor, 4));
  const water = new THREE.Mesh(waterGeo, new THREE.MeshPhongMaterial({ vertexColors: true, transparent: true, shininess: 90, specular: 0x88aacc, depthWrite: false }));
  scene.add(terrain, water);

  const sim = new StormSim(c.z, W, H, Math.sqrt(sx * sy), { depthIn: +$('stDepth').value, CN: +$('stCN').value, drain: c.drain, manning: +$('stN').value });
  ctx = { renderer, scene, camera, controls, terrain, water, c, sim, lo, playing: false, raf: 0, sx, sy, cellArea: sx * sy, opts, dem };
  setExaggeration();
  frameCamera();
  resize(); window.addEventListener('resize', resize);
  updateWater(); drawChart(); updateStats();
  loop();
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
  camera.position.set(w * 0.5 - r * 0.35, r * 0.55, h * 0.5 + r * 0.75);
  camera.near = r / 1000; camera.far = r * 20; camera.updateProjectionMatrix();
  ctx.scene.fog.near = r * 1.5; ctx.scene.fog.far = r * 6;
}
function resize() {
  if (!ctx) return;
  const cv = $('stCanvas'), w = cv.clientWidth, h = cv.clientHeight;
  ctx.renderer.setSize(w, h, false); ctx.camera.aspect = w / Math.max(1, h); ctx.camera.updateProjectionMatrix();
  drawChart();
}
const MIN_SHOW = 0.003; // m
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
    const t = Math.min(1, d / 0.3);
    col.array[i * 4] = 0.15 - 0.1 * t; col.array[i * 4 + 1] = 0.45 - 0.2 * t; col.array[i * 4 + 2] = 0.95 - 0.25 * t;
    col.array[i * 4 + 3] = wet ? 0.45 + 0.5 * t : 0;
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
    <dt>Ponded now</dt><dd>${(b.stored * toAcFt).toFixed(1)} ac-ft</dd>
    <dt>Left the area</dt><dd>${(b.out * toAcFt).toFixed(1)} ac-ft</dd>
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
function loop() {
  if (!ctx) return;
  ctx.raf = requestAnimationFrame(loop);
  const { sim } = ctx;
  if (ctx.playing) {
    const speed = +$('stSpeed').value; // simulated seconds per wall second
    const target = Math.min(24 * 3600 + 2 * 3600, sim.t + speed / 60);
    const done = sim.run(target, 14);
    updateWater();
    if (performance.now() - chartT > 250) { chartT = performance.now(); updateStats(); drawChart(); }
    if (done && sim.t >= 26 * 3600) { ctx.playing = false; $('stPlay').textContent = 'Replay'; updateStats(); drawChart(); }
  }
  ctx.controls.update();
  ctx.renderer.render(ctx.scene, ctx.camera);
}
function reset() {
  if (!ctx) return;
  const { c, sx, sy } = ctx;
  ctx.sim = new StormSim(c.z, c.W, c.H, Math.sqrt(sx * sy), { depthIn: +$('stDepth').value || 5, CN: Math.min(98, Math.max(30, +$('stCN').value || 78)), drain: c.drain, manning: +$('stN').value || 0.06 });
  updateWater(); updateStats(); drawChart();
}
export function closeStorm() {
  if (!ctx) return;
  cancelAnimationFrame(ctx.raf); window.removeEventListener('resize', resize);
  ctx.terrain.geometry.dispose(); ctx.water.geometry.dispose(); ctx.renderer.dispose();
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
