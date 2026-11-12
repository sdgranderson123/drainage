import test from 'node:test';
import assert from 'node:assert/strict';
import { fillDepressions, d8, accumulate, snapOutlet, watershed, flowPath, scsRunoff, tcLag, tcKirpich,
  unitPeakTypeII, tr55Peak, typeIIFraction } from '../hydro.js';

const near = (a, b, t) => assert.ok(Math.abs(a - b) <= t, `${a} vs ${b} (±${t})`);
// V-shaped valley draining south: z = |x - cx| * 0.02 + (H - y) * 0.01
function valley(W, H) {
  const z = new Float32Array(W * H), cx = (W - 1) / 2;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) z[y * W + x] = Math.abs(x - cx) * 0.02 + (H - 1 - y) * 0.01;
  return z;
}

test('fillDepressions removes a pit and leaves no interior sinks', () => {
  const W = 21, H = 21, z = valley(W, H); z[10 * W + 10] -= 5; // pit
  const f = fillDepressions(z, W, H), rec = d8(f, W, H);
  let sinks = 0;
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) if (rec[y * W + x] < 0) sinks++;
  assert.equal(sinks, 0);
  assert.ok(f[10 * W + 10] >= z[10 * W + 10]);
  for (let i = 0; i < W * H; i++) assert.ok(f[i] >= z[i] - 1e-6);
});

test('flat area drains (epsilon gradient)', () => {
  const W = 15, H = 15, z = new Float32Array(W * H).fill(10);
  const rec = d8(fillDepressions(z, W, H), W, H);
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) assert.ok(rec[y * W + x] >= 0);
});

test('valley: whole grid drains to the bottom-centre outlet', () => {
  const W = 41, H = 61, z = valley(W, H), f = fillDepressions(z, W, H), rec = d8(f, W, H), acc = accumulate(rec, W * H);
  const out = snapOutlet(acc, W, H, 17, H - 1, 4);
  assert.equal(out, (H - 1) * W + 20, 'snaps to the channel');
  const ws = watershed(rec, W, H, out);
  // Every cell except those on the bottom row (which flow off-grid directly) drains to the outlet.
  assert.ok(ws.cells.length >= W * (H - 1) * 0.97, `${ws.cells.length} cells`);
  assert.ok(ws.touchesEdge);
  const path = flowPath(rec, ws.far, out);
  assert.equal(path[path.length - 1], out);
  assert.ok(ws.len[ws.far] >= H - 1);
  assert.equal(acc[out], ws.cells.length);
});

test('two basins split at a ridge', () => {
  const W = 40, H = 30, z = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) z[y * W + x] = 10 - Math.abs(x - 19.5) * 0.05 * -1 + (H - 1 - y) * 0.01 - (x < 20 ? 0 : 0);
  // ridge at x = 19.5 rising toward it; each side drains south along its own low edge x=0 / x=39
  const f = fillDepressions(z, W, H), rec = d8(f, W, H), acc = accumulate(rec, W * H);
  const left = watershed(rec, W, H, snapOutlet(acc, W, H, 2, H - 2, 3));
  for (const c of left.cells) assert.ok(c % W < 20, 'left basin stays left of the ridge');
});

test('SCS runoff: TR-55 worked values', () => {
  near(scsRunoff(5, 80), 2.893, 0.002);      // S = 2.5
  near(scsRunoff(4, 75), 1.667, 0.002);      // S = 3.333, Q = 3.333² / 6.667
  assert.equal(scsRunoff(0.5, 70), 0);          // below initial abstraction
});

test('Tc methods give sensible magnitudes', () => {
  near(tcKirpich(3000, 0.01) * 60, 21.9, 0.2);  // 0.0078·3000^0.77·0.01^-0.385 min
  const t = tcLag(5000, 2, 78); assert.ok(t > 0.3 && t < 1.5, String(t));
});

test('TR-55 Type II unit peak discharge matches Exhibit 4-II', () => {
  near(unitPeakTypeII(0.10, 1.0), 10 ** 2.55323, 0.5); // ~357 csm/in at Tc 1 h
  near(unitPeakTypeII(0.30, 0.5), 10 ** (2.46532 - 0.62257 * Math.log10(0.5) - 0.11657 * Math.log10(0.5) ** 2), 0.5);
  assert.ok(unitPeakTypeII(0.1, 0.2) > unitPeakTypeII(0.1, 2));
  assert.ok(unitPeakTypeII(0.1, 1) > unitPeakTypeII(0.5, 1));
});

test('TR-55 peak: 1 sq mi, 5 in, CN 80, Tc 1 h', () => {
  const r = tr55Peak(1, 5, 80, 1);
  near(r.Q, 2.893, 0.002); near(r.IaP, 0.1, 1e-9);
  near(r.q, 357.5 * 2.893, 3);
  assert.deepEqual(r.notes, []);
});

test('Type II distribution: monotonic, half by ~noon, all by 24 h', () => {
  let prev = 0;
  for (let t = 0; t <= 24; t += 0.25) { const f = typeIIFraction(t); assert.ok(f >= prev); prev = f; }
  near(typeIIFraction(12), 0.663, 1e-9); assert.equal(typeIIFraction(24), 1);
});
