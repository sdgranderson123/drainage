import test from 'node:test';
import assert from 'node:assert/strict';
import { fitPlane, planeFromSlope, slopeOf, volumes, balance, pointInPolygon, polygonArea } from './earthwork.js';

const grid = (f) => { const p = []; for (let x = 0; x < 50; x++) for (let y = 0; y < 50; y++) p.push({ x, y, z: f(x, y) }); return p; };
const near = (a, b, t = 1e-6) => assert.ok(Math.abs(a - b) < t, `${a} vs ${b}`);

test('fitPlane recovers an exact plane', () => {
  const pl = fitPlane(grid((x, y) => 10 + 0.002 * x - 0.001 * y));
  near(pl.a, 10); near(pl.b, 0.002); near(pl.c, -0.001);
});

test('slope and heading round-trip; heading is downhill direction', () => {
  const pl = planeFromSlope(0.2, 90); // falls to the east
  assert.ok(pl.b < 0);
  const s = slopeOf(pl); near(s.slopePct, 0.2); near(s.headingDeg, 90);
  near(slopeOf(planeFromSlope(0.5, 225)).headingDeg, 225);
});

test('volumes of a flat field 1 m above design', () => {
  const v = volumes(grid(() => 11), { a: 10, b: 0, c: 0 }, 1);
  near(v.cut, 2500); near(v.fill, 0); near(v.maxCut, 1);
});

test('balance gives equal cut and fill, or the requested ratio', () => {
  const pts = grid((x, y) => 10 + 0.3 * Math.sin(x / 5) + 0.2 * Math.cos(y / 7));
  const pl = fitPlane(pts);
  const v1 = volumes(pts, balance(pts, pl, 1, 1), 1);
  near(v1.cut, v1.fill, 0.01);
  const v2 = volumes(pts, balance(pts, pl, 1, 1.2), 1);
  near(v2.cut, v2.fill * 1.2, 0.01);
});

test('polygon helpers', () => {
  const sq = [[0, 0], [10, 0], [10, 10], [0, 10]];
  assert.equal(pointInPolygon(5, 5, sq), true);
  assert.equal(pointInPolygon(15, 5, sq), false);
  near(polygonArea(sq), 100);
});
