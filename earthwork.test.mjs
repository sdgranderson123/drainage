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

import { profileStats, quantile, hillshade, rampColor, toCSV, parseLatLon, toLocal } from './earthwork.js';

test('profileStats: grade, extremes, steepest 10 m window', () => {
  const rows = []; for (let d = 0; d <= 100; d++) rows.push({ d, z: 10 - 0.01 * d + (d >= 50 && d < 60 ? 0.5 : 0) });
  rows.push({ d: 101, z: NaN });
  const s = profileStats(rows);
  near(s.grade, -0.01, 1e-9); near(s.lo, 9, 1e-9); near(s.hi, 10, 1e-9); near(s.length, 100, 1e-9);
  assert.ok(s.maxUp > 0.03 && s.maxDown > 0.05);
  assert.equal(profileStats([{ d: 0, z: 1 }]), null);
});

test('quantile', () => { near(quantile([5, 1, 3, 2, 4], 0.5), 3); near(quantile([5, 1, 3], 0), 1); near(quantile([5, 1, 3], 1), 5); });

test('hillshade: flat ground = cos(zenith), sun-facing slope brighter', () => {
  const W = 20, H = 20, flat = new Float32Array(W * H).fill(10);
  near(hillshade(flat, W, H, 1, 1)[210], Math.cos(Math.PI / 4), 1e-6);
  const west = new Float32Array(W * H), east = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { west[y * W + x] = x * 0.5; east[y * W + x] = -x * 0.5; }
  // NW sun: ground falling to the west faces the sun.
  assert.ok(hillshade(west, W, H, 1, 1)[210] > hillshade(east, W, H, 1, 1)[210]);
  assert.ok(Number.isNaN(hillshade(new Float32Array([NaN, 1, 1, 1]), 2, 2, 1, 1)[0]));
});

test('rampColor endpoints and clamping', () => {
  assert.deepEqual(rampColor(0), [38, 115, 77]); assert.deepEqual(rampColor(2), [245, 240, 235]);
  assert.equal(rampColor(0.4).length, 3);
});

test('toCSV quotes and uses CRLF', () => {
  assert.equal(toCSV(['a', 'b'], [[1, 'x,y'], [2, 'q"']]), 'a,b\r\n1,"x,y"\r\n2,"q"""\r\n');
});

test('parseLatLon', () => {
  assert.deepEqual(parseLatLon('33.45, -90.65'), { lat: 33.45, lon: -90.65 });
  assert.deepEqual(parseLatLon(' 33.45 -90.65 '), { lat: 33.45, lon: -90.65 });
  assert.equal(parseLatLon('Greenville, MS'), null);
  assert.equal(parseLatLon('95, 10'), null);
});

test('toLocal: 1 arc-second of latitude is ~30.9 m', () => {
  near(toLocal(1 / 3600, 0, 0, 0).y, 30.87, 0.05);
  near(toLocal(33, 1 / 3600, 33, 0).x, 30.87 * Math.cos(33 * Math.PI / 180), 0.05);
});
