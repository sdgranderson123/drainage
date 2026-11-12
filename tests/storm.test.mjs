import test from 'node:test';
import assert from 'node:assert/strict';
import { StormSim, coarsen } from '../storm.js';
import { scsRunoff } from '../hydro.js';

const bowl = (W, H) => { const z = new Float32Array(W * H); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) z[y * W + x] = 10 + 0.002 * ((x - W / 2) ** 2 + (y - H / 2) ** 2); return z; };
const ramp = (W, H) => { const z = new Float32Array(W * H); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) z[y * W + x] = 10 - 0.01 * x * 5; return z; };

test('mass balance: rain excess = stored + outflow (within 0.5%)', () => {
  const W = 40, H = 30, sim = new StormSim(ramp(W, H), W, H, 5, { depthIn: 4, CN: 80, hours: 6 });
  while (sim.t < 8 * 3600) sim.step(10);
  const b = sim.balance();
  assert.ok(Math.abs(b.error) / b.excess < 0.005, JSON.stringify(b));
  // Excess equals the SCS runoff depth over the area.
  const expect = scsRunoff(4, 80) * 0.0254 * W * H * 25;
  assert.ok(Math.abs(b.excess - expect) / expect < 1e-6);
  assert.ok(b.out / b.excess > 0.9, 'a ramp drains nearly everything off the low edge');
});

test('closed bowl: water collects at the bottom, little leaves', () => {
  const W = 31, H = 31, sim = new StormSim(bowl(W, H), W, H, 5, { depthIn: 6, CN: 90, hours: 2 });
  while (sim.t < 4 * 3600) sim.step(10);
  const c = sim.h[15 * W + 15], edge = sim.h[2 * W + 2];
  assert.ok(c > 0.05 && c > 20 * edge, `centre ${c} edge ${edge}`);
  const b = sim.balance();
  assert.ok(b.out / b.excess < 0.05, JSON.stringify(b));
  assert.ok(Math.abs(b.error) / b.excess < 0.005);
});

test('no water and no outflow when rain is below initial abstraction', () => {
  const sim = new StormSim(ramp(10, 10), 10, 10, 5, { depthIn: 0.3, CN: 70, hours: 1 });
  while (sim.t < 7200) sim.step(30);
  assert.equal(sim.balance().excess, 0); assert.equal(sim.out, 0);
});

test('coarsen averages blocks and drops mostly-empty ones', () => {
  const W = 8, H = 4, z = Float32Array.from({ length: 32 }, (_, i) => i);
  z[0] = z[1] = z[8] = NaN;
  const c = coarsen(z, W, H, 1, 1, 4);
  assert.equal(c.W, 4); assert.equal(c.H, 2); assert.equal(c.dx, 2);
  assert.ok(Number.isNaN(c.z[0]));
  assert.equal(c.z[1], (2 + 3 + 10 + 11) / 4);
});

test('Manning friction slows flow: rougher surface gives a lower, later outflow peak', () => {
  const run = (n) => { const s = new StormSim(ramp(40, 20), 40, 20, 5, { depthIn: 4, CN: 90, hours: 2, manning: n }); while (s.t < 4 * 3600) s.step(10);
    const pk = s.history.reduce((a, r) => (r.q > a.q ? r : a), { q: 0, t: 0 }); return { pk, bal: s.balance() }; };
  const smooth = run(0.015), rough = run(0.15);
  assert.ok(rough.pk.q < smooth.pk.q, `${rough.pk.q} < ${smooth.pk.q}`);
  assert.ok(rough.pk.t >= smooth.pk.t);
  for (const r of [smooth, rough]) assert.ok(Math.abs(r.bal.error) / r.bal.excess < 0.005);
});

test('no rain on no-data cells (they are drains, not catchment)', () => {
  const W = 20, H = 10, z = ramp(W, H); for (let x = 0; x < W; x++) z[x] = NaN; // top row missing
  const sim = new StormSim(z, W, H, 5, { depthIn: 3, CN: 85, hours: 1 });
  while (sim.t < 3 * 3600) sim.step(10);
  const expect = (W * H - W) * 25 * (3 - 0.2 * (1000 / 85 - 10)) ** 2 / (3 + 0.8 * (1000 / 85 - 10)) * 0.0254;
  assert.ok(Math.abs(sim.balance().excess - expect) / expect < 1e-6);
  assert.ok(Math.abs(sim.balance().error) / sim.balance().excess < 0.005);
});

test('basin ridge: drain cells outside a bowl take no water; edges only spill downhill', () => {
  const W = 31, H = 31, z = bowl(W, H), drain = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if ((x - 15) ** 2 + (y - 15) ** 2 > 12 ** 2) drain[y * W + x] = 1;
  const sim = new StormSim(z, W, H, 5, { depthIn: 5, CN: 90, hours: 2, drain });
  while (sim.t < 4 * 3600) sim.step(10);
  const b = sim.balance();
  assert.ok(b.out / b.excess < 0.02, `bowl lost ${(100 * b.out / b.excess).toFixed(1)}% over its rim`);
  // A flat-across, sloping-down ramp loses water only through its low edge.
  const r = new StormSim(ramp(30, 30), 30, 30, 5, { depthIn: 4, CN: 85, hours: 2 });
  while (r.t < 2.5 * 3600) r.step(10);
  assert.ok(r.balance().out / r.balance().excess > 0.5);
});
