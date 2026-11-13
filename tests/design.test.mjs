import test from 'node:test';
import assert from 'node:assert/strict';
import { groupExits, rasterPolygon, rasterLine, edgeDistance, applyEdits, pipeCapacity, tileAcres, surfaceDiff, exitPoints, wetlandOverlap } from '../design.js';
import { toLocal } from '../earthwork.js';
import { fillDepressions, d8 } from '../hydro.js';

const near = (a, b, t) => assert.ok(Math.abs(a - b) <= t, `${a} vs ${b} (±${t})`);
// 200 m x 200 m grid of 1 m cells around (40, -90).
const LAT0 = 40, LON0 = -90, dLat = 100 / 111194.9, dLon = 100 / (111194.9 * Math.cos(LAT0 * Math.PI / 180));
const dem = { W: 200, H: 200, s: LAT0 - dLat, n: LAT0 + dLat, w: LON0 - dLon, e: LON0 + dLon, dx: 1, dy: 1 };
const ll = (x, y) => [LAT0 + (y / 100) * dLat, LON0 + (x / 100) * dLon]; // local metres -> lat/lon
const square = (x0, y0, x1, y1) => [ll(x0, y0), ll(x1, y0), ll(x1, y1), ll(x0, y1)];
const flat = (v) => new Float32Array(200 * 200).fill(v);

test('rasterPolygon area matches polygon area', () => {
  const m = rasterPolygon(dem, square(-50, -30, 50, 30));
  near(m.reduce((a, b) => a + b, 0), 100 * 60, 250);
});

test('edgeDistance grows inward', () => {
  const m = rasterPolygon(dem, square(-20, -20, 20, 20)), d = edgeDistance(m, 200, 200, 1, 1);
  near(d[100 * 200 + 100], 20, 2); assert.ok(d[100 * 200 + 82] < 4);
});

test('grade edit: raise 2 ft over 100 x 60 m gives the expected fill', () => {
  const { z, info } = applyEdits(dem, flat(10), [{ type: 'grade', pts: square(-50, -30, 50, 30), mode: 'offset', valueFt: 2 }]);
  near(info[0].fillM3, 6000 * 0.6096, 6000 * 0.6096 * 0.05); near(info[0].cutM3, 0, 1e-6);
  near(z[100 * 200 + 100], 10 + 0.6096, 1e-5); near(z[5], 10, 1e-6);
  const set = applyEdits(dem, flat(10), [{ type: 'grade', pts: square(-10, -10, 10, 10), mode: 'elev', valueFt: 30 }]);
  near(set.z[100 * 200 + 100], 30 * 0.3048, 1e-5);
});

test('pond on flat ground: flat bottom, 3:1 sides, prismoid volume', () => {
  const { z, info } = applyEdits(dem, flat(10), [{ type: 'pond', pts: square(-30, -30, 30, 30), depthFt: 6, sideSlope: 3 }]);
  const p = info[0]; near(p.bottom, 10 - 6 * 0.3048, 1e-5);
  near(z[100 * 200 + 100], p.bottom, 1e-5);                      // centre at the bottom
  assert.ok(z[100 * 200 + 71] > p.bottom && z[100 * 200 + 71] < 10); // side slope near the edge
  // Prismoid with 3:1 sides: top 60 x 60, depth 1.83 m, bottom 60 - 2·3·1.83 = 49.0 m.
  const h = 6 * 0.3048, b = 60 - 2 * 3 * h, V = (h / 3) * (60 * 60 + b * b + 60 * b);
  near(p.excavationM3, V, V * 0.06); near(p.storageM3, p.excavationM3, 1e-3);
});

test('tile: capacity by Manning and acres at 3/8 in/day', () => {
  near(pipeCapacity(6, 0.001), 0.154, 0.002);           // 99.07·0.196·0.125^(2/3)·√0.001
  near(pipeCapacity(12, 0.002), 1.38, 0.01);
  near(tileAcres(1), 63.4, 0.5);                         // 1 cfs drains ~63 ac at 3/8"/day
  const z = new Float32Array(200 * 200); for (let y = 0; y < 200; y++) for (let x = 0; x < 200; x++) z[y * 200 + x] = 10 + 0.002 * x;
  const { info } = applyEdits(dem, z, [{ type: 'tile', pts: [ll(-80, 0), ll(80, 0)], depthFt: 4, diaIn: 8 }]);
  near(info[0].lengthM, 160, 3); near(info[0].slope, 0.002, 2e-4);
  assert.equal(info[0].outlet % 200 < 100, true, 'outlet at the low (west) end');
});

test('rasterLine is continuous', () => {
  const c = rasterLine(dem, [ll(-50, -50), ll(50, 40)]);
  for (let k = 1; k < c.length; k++) { const a = c[k - 1], b = c[k]; assert.ok(Math.abs((a % 200) - (b % 200)) <= 1 && Math.abs(((a / 200) | 0) - ((b / 200) | 0)) <= 1); }
});

test('surfaceDiff', () => {
  const r = surfaceDiff(flat(10), flat(9), null, 2); near(r.cutM3, 40000 * 2, 1e-3); near(r.fillM3, 0, 1e-9);
});

test('exitPoints: a field on a slope drains out its low side', () => {
  const z = new Float32Array(200 * 200); for (let y = 0; y < 200; y++) for (let x = 0; x < 200; x++) z[y * 200 + x] = 10 + 0.01 * x + 0.0001 * Math.abs(y - 100);
  const rec = d8(fillDepressions(z, 200, 200), 200, 200), m = rasterPolygon(dem, square(-40, -40, 40, 40));
  const ex = exitPoints(m, rec, 200), total = ex.reduce((a, e) => a + e.cells, 0);
  near(total, m.reduce((a, b) => a + b, 0), 1e-9);              // every inside cell leaves somewhere
  assert.ok(ex.every((e) => e.i % 200 < 70), 'exits are on the low (west) edge');
});

test('wetlandOverlap: acres of NWI polygon inside the area, holes excluded', () => {
  const ring = (x0, y0, x1, y1) => square(x0, y0, x1, y1).map(([a, b]) => [b, a]).concat([[ll(x0, y0)[1], ll(x0, y0)[0]]]);
  const f = { properties: { WETLAND_TYPE: 'Freshwater Emergent Wetland' }, geometry: { type: 'Polygon', coordinates: [ring(0, 0, 80, 80), ring(10, 10, 20, 20)] } };
  const m = rasterPolygon(dem, square(-40, -40, 40, 40));
  const r = wetlandOverlap(dem, m, [f]);
  near(r.totalM2, 40 * 40 - 10 * 10, 120);
  assert.equal(r.byType[0][0], 'Freshwater Emergent Wetland');
});

test('groupExits merges an edge of small exits', () => {
  const ex = Array.from({ length: 50 }, (_, k) => ({ i: 10 * 100 + k, cells: 1 })).concat([{ i: 90 * 100 + 90, cells: 5 }]).sort((a, b) => b.cells - a.cells);
  const g = groupExits(ex, 100, 1, 1, 30);
  assert.equal(g.length, 3); assert.equal(g.reduce((a, x) => a + x.cells, 0), 55);
});

test('rock area is the exact outline area', () => {
  const { info } = applyEdits(dem, flat(10), [{ type: 'rock', pts: square(-50, -30, 50, 30), depthIn: 9 }]);
  near(info[0].areaM2, 6000, 1);
});
