import test from 'node:test';
import assert from 'node:assert/strict';
// dem.js imports geotiff from a CDN URL; stub it for Node.
import { register } from 'node:module';
register('data:text/javascript,' + encodeURIComponent(`export async function resolve(s, c, n) {
  if (s.startsWith('https://cdn.jsdelivr.net/npm/geotiff')) return { url: 'data:text/javascript,export const fromArrayBuffer=()=>{}', shortCircuit: true };
  return n(s, c); }`));
const { pickSource } = await import('../dem.js');

const item = (title, Best, s, e) => ({ attributes: { Category: 1, MinPS: 0, title, Best, StartDate: s, EndDate: e } });
test('prefers 1 m project lidar over higher-ranked arc-second compilations (real Delta catalog)', () => {
  const r = pickSource([
    { attributes: { Category: 2, MinPS: 150, EndDate: null } },
    item('USGS 1/3 Arc Second n34w091 20260423', 3661, 20140101, '20250203'),
    item('USGS 1 Arc Second n34w091 20260423', 11186, 20140101, '20250203'),
    item('USGS 1 Meter 15 x71y371 MS_Central_Delta_2018_D18', 49254, 20180218, '20201213'),
    item('USGS NED ned19_n33x50_w090x75_ms_yazoodeltamsrvrbsn_2009 1/9 arc-second 2012', 150554, 20090219, '20100802'),
  ]);
  assert.match(r.title, /MS_Central_Delta_2018/);
  assert.equal(r.end.toISOString().slice(0, 10), '2020-12-13');
  assert.equal(r.compilation, false);
});
test('among 1 m projects, lowest Best wins', () => {
  const r = pickSource([item('USGS one meter AR Ouachita 2016', 80141, 20170120, '20170326'), item('USGS 1 Meter AR_Eastern_D23', 264, 20231205, '20250203')]);
  assert.match(r.title, /AR_Eastern/);
});
test('falls back to 1/9 then compilation, flags compilation', () => {
  assert.match(pickSource([item('USGS 1/3 Arc Second x', 1, 20140101, '20250203'), item('ned19 1/9 arc-second', 9, 20090101, '20100101')]).title, /1\/9/);
  assert.equal(pickSource([item('USGS 1/3 Arc Second x', 1, 20140101, '20250203')]).compilation, true);
  assert.equal(pickSource([]), null);
});
