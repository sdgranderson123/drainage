import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { parsePoints, parseDXF, parseLandXML, parseLAS, lasHeader, unitToMeters, gridSurvey, compareSurfaces } from '../survey.js';
import { toLocal } from '../earthwork.js';
const require = createRequire(import.meta.url);
const proj4 = require('proj4'), Delaunator = require('delaunator').default || require('delaunator');
const F = new URL('./fixtures/', import.meta.url);
const read = (f) => fs.readFileSync(new URL(f, F), 'utf8');
const near = (a, b, t, m = '') => assert.ok(Math.abs(a - b) <= t, `${m} ${a} vs ${b} (±${t})`);
const LAT0 = 33.45, LON0 = -90.65, S = 0.002, Hd = 135 * Math.PI / 180;
// Known survey surface (metres) at local x, y: lidar plane + 0.10 m, minus a 0.5 m ditch for |x| <= 5 m.
const zTrue = (x, y) => 30 - S * (Math.sin(Hd) * x + Math.cos(Hd) * y) + 0.10 - (x >= -5 && x <= 5 ? 0.5 : 0);
const def2255 = read('epsg2255.proj4').trim(), def26915 = read('epsg26915.proj4').trim();
const toLL = (def) => { const t = proj4(def, 'WGS84'); return (x, y) => { const [lo, la] = t.forward([x, y]); return [la, lo]; }; };
// 1 m grid, 300 m square around the site
const dLat = 150 / 111194.9, dLon = 150 / (111194.9 * Math.cos(LAT0 * Math.PI / 180));
const dem = { W: 300, H: 300, s: LAT0 - dLat, n: LAT0 + dLat, w: LON0 - dLon, e: LON0 + dLon, dx: 1, dy: 1 };
function checkGrid(g, lim, tol, skipDitchEdge = true) {
  let n = 0, worst = 0;
  for (let j = 0; j < dem.H; j++) for (let i = 0; i < dem.W; i++) {
    const v = g.z[j * dem.W + i]; if (v !== v) continue;
    const la = dem.n - (j + 0.5) * (dem.n - dem.s) / dem.H, lo = dem.w + (i + 0.5) * (dem.e - dem.w) / dem.W, p = toLocal(la, lo, LAT0, LON0);
    if (Math.abs(p.x) > lim || Math.abs(p.y) > lim) continue;
    if (skipDitchEdge && Math.abs(Math.abs(p.x) - 5) < 1.5) continue; // cell straddles the ditch wall
    worst = Math.max(worst, Math.abs(v - zTrue(p.x, p.y))); n++;
  }
  assert.ok(n > 100, `${n} cells checked`); assert.ok(worst <= tol, `worst error ${worst.toFixed(4)} m > ${tol}`);
  return worst;
}

test('PNEZD points: parse, project (MS West ftUS), triangulate; ditch is captured', () => {
  const sv = parsePoints(read('survey_pnezd.csv'));
  assert.equal(sv.xyz.length / 3, 380);
  const g = gridSurvey(dem, sv, toLL(def2255), unitToMeters(def2255), Delaunator, { maxEdgeM: 40 });
  checkGrid(g, 140, 0.01); // linear in each triangle on a planar surface: within rounding of 0.001 ft
  // Ditch bottom present at x=0
  const j = 150, i = 150; near(g.z[j * 300 + i], zTrue(0, 0), 0.02, 'ditch centre');
});

test('DXF POINT entities', () => {
  const sv = parseDXF(read('survey.dxf'));
  assert.equal(sv.xyz.length / 3, 380); assert.equal(sv.kind, 'points');
  checkGrid(gridSurvey(dem, sv, toLL(def2255), unitToMeters(def2255), Delaunator, { maxEdgeM: 40 }), 140, 0.01);
});

test('LandXML TIN with faces and epsgCode', () => {
  const sv = parseLandXML(read('survey_tin.xml'));
  assert.equal(sv.epsg, 2255); assert.equal(sv.kind, 'tin'); assert.equal(sv.faces.length / 3, 15 * 15 * 2);
  // Grid TIN (20 m) has no ditch shots: compare only away from the ditch.
  const g = gridSurvey(dem, sv, toLL(def2255), unitToMeters(def2255), Delaunator, { maxEdgeM: 40 });
  let worst = 0;
  for (let j = 0; j < 300; j += 3) for (let i = 0; i < 300; i += 3) {
    const v = g.z[j * 300 + i]; if (v !== v) continue;
    const la = dem.n - (j + 0.5) * (dem.n - dem.s) / 300, lo = dem.w + (i + 0.5) * (dem.e - dem.w) / 300, p = toLocal(la, lo, LAT0, LON0);
    if (Math.abs(p.x) < 25) continue; // triangles spanning the ditch
    worst = Math.max(worst, Math.abs(v - zTrue(p.x, p.y)));
  }
  assert.ok(worst < 0.01, String(worst));
});

test('LAS: header, EPSG from GeoKeys, ground class only, binned to 1 m', () => {
  const buf = fs.readFileSync(new URL('cloud.las', F)), ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
  const h = lasHeader(ab); assert.equal(h.epsg, 26915); assert.equal(h.compressed, false);
  const sv = parseLAS(ab);
  assert.equal(sv.epsg, 26915); assert.ok(sv.ground > 40000 && sv.total > sv.ground, sv.note);
  const g = gridSurvey(dem, sv, toLL(def26915), 1, Delaunator);
  checkGrid(g, 95, 0.02); // buildings (class 6) excluded
});

test('LAZ header is recognised as compressed', () => {
  const buf = fs.readFileSync(new URL('cloud.laz', F)), ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
  const h = lasHeader(ab); assert.equal(h.compressed, true); assert.equal(h.epsg, 26915);
});

test('units from proj4 definitions', () => {
  near(unitToMeters(def2255), 1200 / 3937, 1e-12); assert.equal(unitToMeters(def26915), 1);
  near(unitToMeters('+proj=tmerc +units=ft'), 0.3048, 1e-12);
});

test('compareSurfaces finds a datum offset', () => {
  const a = Float32Array.from({ length: 1000 }, (_, i) => 10 + (i % 7) * 0.01), b = a.map((v) => v - 0.3);
  const c = compareSurfaces(a, b); near(c.median, 0.3, 1e-5); near(c.mad, 0, 1e-5);
});

test('DXF 3DFACE becomes a TIN; binary DXF rejected', () => {
  const dxf = '0\nSECTION\n2\nENTITIES\n0\n3DFACE\n8\n0\n10\n0\n20\n0\n30\n1\n11\n10\n21\n0\n31\n2\n12\n10\n22\n10\n32\n3\n13\n10\n23\n10\n33\n3\n0\nENDSEC\n0\nEOF\n';
  const sv = parseDXF(dxf); assert.equal(sv.kind, 'tin'); assert.equal(sv.faces.length, 3); assert.equal(sv.xyz.length, 9);
  assert.throws(() => parseDXF('AutoCAD Binary DXF\r\n\x1a\0'), /Binary DXF/);
});
