import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { detectCRS, readNotes, prjToNotes } from '../crs.js';
const require = createRequire(import.meta.url);
const proj4 = require('proj4');
const table = JSON.parse(fs.readFileSync(new URL('../crs-us.json', import.meta.url)));
const def = (c) => table.find((s) => s.c === c).p;
const fromLL = (code, lat, lon) => proj4('WGS84', def(code), [lon, lat]);

test('readNotes: the North Substation drawing note', () => {
  const r = readNotes('Basis of Bearings for this drawing is NSRS 2011 Minnesota State Plane, South Zone, US Survey Foot');
  assert.deepEqual([r.state, r.zone, r.unit, r.datum], ['Minnesota', 'South', 'ftUS', '2011']);
  assert.equal(readNotes('West Virginia North Zone').state, 'West Virginia');
  assert.equal(readNotes('NAD83 Arkansas North').state, 'Arkansas');
});

test('North Substation coordinates + note → EPSG 6505', () => {
  const xy = [[2601379.4, 597346.2], [2601420.1, 597314.6]];
  const r = detectCRS(xy, table, proj4, { notes: 'NSRS 2011 Minnesota State Plane, South Zone, US Survey Foot' });
  assert.equal(r[0].code, 6505); assert.ok(Math.abs(r[0].lat - 43.7386) < 0.001 && Math.abs(r[0].lon + 94.0881) < 0.001);
});

test('no notes: map location in Blue Earth picks a Minnesota South US-foot system', () => {
  const xy = [[2601379.4, 597346.2]];
  const r = detectCRS(xy, table, proj4, { lat: 43.74, lon: -94.09 });
  assert.match(r[0].name, /Minnesota South \(ftUS\)/); assert.ok(r[0].km < 1);
});

test('no hints at all: data still lands in a plausible zone only; metre zones rejected for foot data', () => {
  const [x, y] = fromLL(3417, 42.0105, -93.62); // Iowa North ftUS
  const r = detectCRS([[x, y]], table, proj4, {});
  assert.ok(r.length > 0);
  assert.ok(r.slice(0, 3).some((c) => /Iowa North/.test(c.name)), r.slice(0, 5).map((c) => c.name).join('; '));
  assert.ok(r.every((c) => !/Iowa North$/.test(c.name) || c.km === null), 'metre Iowa North would land far away');
});

test('state and county hints', () => {
  const [x, y] = fromLL(6463, 42.0105, -93.62); // NAD83(2011) Iowa North ftUS, Story County
  const r = detectCRS([[x, y]], table, proj4, { state: 'Iowa', county: 'Story' });
  assert.match(r[0].name, /Iowa/);
});

test('.prj name becomes a note detectCRS understands', () => {
  const n = prjToNotes('PROJCS["NAD_1983_2011_StatePlane_Minnesota_South_FIPS_2203_Ft_US",GEOGCS[...]]');
  const r = readNotes(n); assert.deepEqual([r.state, r.zone, r.unit, r.datum], ['Minnesota', 'South', 'ftUS', '2011']);
});

test('UTM data with a UTM note', () => {
  const [x, y] = fromLL(26915, 33.45, -90.65);
  const r = detectCRS([[x, y]], table, proj4, { notes: 'NAD83 UTM Zone 15N, meters' });
  assert.equal(r[0].code, 26915);
});
