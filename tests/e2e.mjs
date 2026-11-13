// End-to-end checks in headless Chromium with the USGS service mocked by synthetic lidar of known shape.
// Run: node tests/e2e.mjs   (needs Playwright + Chromium; set PW_CHROMIUM to a binary path if not bundled)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { writeGeoTiff } from './tiff.mjs';
import { toLocal } from '../earthwork.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LAT0 = 33.45, LON0 = -90.65;
let failures = 0, passes = 0;
const check = (ok, msg, extra = '') => { if (ok) { passes++; console.log('  ok  ', msg); } else { failures++; console.log('  FAIL', msg, extra); } };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// ---- surfaces (metres, local x east / y north from LAT0, LON0) ----
const S = 0.002, H = 135 * Math.PI / 180;           // 0.2 % fall toward SE (135°)
const plane = (x, y) => 30 - S * (Math.sin(H) * x + Math.cos(H) * y);
const MOUND = { x0: -50, x1: 50, y0: -40, y1: 40, h: 0.3 };
const mound = (x, y) => plane(x, y) + (x >= MOUND.x0 && x < MOUND.x1 && y >= MOUND.y0 && y < MOUND.y1 ? MOUND.h : 0);
const holey = (x, y) => (x > 120 && y > 120 ? NaN : plane(x, y));
let surface = plane, failMode = null, calls = 0;

function demResponse(url) {
  const q = new URL(url).searchParams;
  const [w, s, e, n] = q.get('bbox').split(',').map(Number), [W, Hh] = q.get('size').split(',').map(Number);
  const sx = (e - w) / W, sy = (n - s) / Hh, v = new Float32Array(W * Hh);
  for (let j = 0; j < Hh; j++) for (let i = 0; i < W; i++) {
    const p = toLocal(n - (j + 0.5) * sy, w + (i + 0.5) * sx, LAT0, LON0), z = surface(p.x, p.y);
    v[j * W + i] = Number.isFinite(z) ? z : -3.4028234663852886e38;
  }
  return writeGeoTiff(v, W, Hh, { west: w, north: n, sx, sy });
}

// ---- static server ----
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const f = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname === '/' ? '/index.html' : new URL(req.url, 'http://x').pathname));
  if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const BASE = `http://localhost:${server.address().port}/`;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
async function newPage(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 }, acceptDownloads: true, ...opts });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && page.errors.push(m.text()));
  await page.route('**/arcgisonline.com/**/tile/**', (r) => r.fulfill({ body: PNG, contentType: 'image/png' }));
  await page.route('**/geocode.arcgis.com/**', (r) => r.fulfill({ json: { candidates: [{ address: 'Test Farm, MS', location: { x: LON0, y: LAT0 }, extent: { xmin: LON0 - 0.01, ymin: LAT0 - 0.01, xmax: LON0 + 0.01, ymax: LAT0 + 0.01 } }] } }));
  // NWI wetlands mock: one emergent wetland covering the NE quarter of the test field.
  await page.route('**/wetlandsmapservice/**', (r) => r.fulfill({ json: { type: 'FeatureCollection', features: [{ type: 'Feature',
    properties: { WETLAND_TYPE: 'Freshwater Emergent Wetland', ATTRIBUTE: 'PEM1C', ACRES: 12 },
    geometry: { type: 'Polygon', coordinates: [[[LON0, LAT0], [LON0 + 0.0024, LAT0], [LON0 + 0.0024, LAT0 + 0.002], [LON0, LAT0 + 0.002], [LON0, LAT0]]] } }] } }));
  // Coordinate system definitions (epsg.io) from fixtures.
  await page.route('**/epsg.io/*.proj4', (r) => { const code = r.request().url().match(/(\d+)\.proj4/)[1];
    const f = path.join(ROOT, 'tests', 'fixtures', `epsg${code}.proj4`);
    return fs.existsSync(f) ? r.fulfill({ body: fs.readFileSync(f, 'utf8'), contentType: 'text/plain' }) : r.fulfill({ status: 404, body: 'no' }); });
  await page.route('**/elevation.nationalmap.gov/**', async (r) => {
    const u = r.request().url();
    calls++;
    if (failMode === 'always') return r.fulfill({ status: 500, body: 'down' });
    if (failMode === 'once' && calls === 1) return r.fulfill({ status: 502, body: 'bad gateway' });
    if (u.includes('returnCatalogItems=true')) {
      const end = surface === holey ? '20120601' : '20240301';
      return r.fulfill({ json: { value: '1', catalogItems: { features: [
        { attributes: { Category: 2, Best: null, MinPS: 150, EndDate: null } },
        { attributes: { Category: 1, Best: 900, MinPS: 0, title: 'Older 1 m', StartDate: 20100101, EndDate: '20100301' } },
        { attributes: { Category: 1, Best: 12, MinPS: 0, title: 'Test lidar', StartDate: 20231205, EndDate: end } }] } } });
    }
    if (u.includes('/identify')) {
      const g = JSON.parse(new URL(u).searchParams.get('geometry')), p = toLocal(g.y, g.x, LAT0, LON0);
      return r.fulfill({ json: { value: String(surface(p.x, p.y)) } });
    }
    return r.fulfill({ body: demResponse(u), contentType: 'image/tiff' });
  });
  await page.goto(BASE);
  await page.waitForFunction(() => window.__fg);
  await page.evaluate(([a, b]) => window.__fg.map.setView([a, b], 16, { animate: false }), [LAT0, LON0]);
  return page;
}
// Field square about 445 m x 445 m centred on the origin.
const DLAT = 0.002, DLON = 0.0024;
const SQUARE = [[LAT0 + DLAT, LON0 - DLON], [LAT0 + DLAT, LON0 + DLON], [LAT0 - DLAT, LON0 + DLON], [LAT0 - DLAT, LON0 - DLON]];
async function drawField(page, pts = SQUARE) {
  await page.evaluate((p) => window.__fg.setField(p.map(([a, b]) => window.L.latLng(a, b))), pts);
  await page.waitForFunction(() => window.__fg.field?.plane && window.__fg.busy === 0, null, { timeout: 30000 });
}
const kpi = async (page) => page.evaluate(() => [...document.querySelectorAll('#kpis b')].map((b) => +b.textContent.replace(/,/g, '')));

// ---------- 1. accuracy: tilted plane, best fit ----------
console.log('Accuracy: plane 0.2% toward 135°');
{
  surface = plane; const page = await newPage(); await drawField(page);
  const slope = +(await page.inputValue('#slope')), heading = +(await page.inputValue('#heading'));
  const [acres, cut, fill] = await kpi(page);
  check(near(slope, 0.2, 0.002), `best-fit slope ${slope}% ≈ 0.2%`);
  check(near(heading, 135, 1), `heading ${heading}° ≈ 135°`);
  const areaM2 = toLocal(LAT0 + DLAT, LON0 + DLON, LAT0 - DLAT, LON0 - DLON);
  check(near(acres, (areaM2.x * areaM2.y * 2 * 2) / 4046.86 / 4, 0.2) || near(acres, 48.9, 1.5), `area ${acres} ac`);
  check(cut < 5 && fill < 5, `cut ${cut} / fill ${fill} yd³ ≈ 0 on a perfect plane`);
  await page.waitForFunction(() => /\d{4}/.test(document.querySelector('#fieldSrc')?.textContent || ''), null, { timeout: 10000 }).catch(() => {});
  const src = await page.textContent('#fieldSrc');
  check(src === 'Dec 2023 – Mar 2024', `lidar date picks best-ranked source (${src})`);
  check(await page.isHidden('#fieldWarn'), 'no warnings for recent lidar on a clean plane');
  check(!page.errors.length, 'no console errors', page.errors.join(' | '));
  await page.context().close();
}

// ---------- 2. accuracy: known mound, manual plane ----------
console.log('Accuracy: 0.3 m mound on the plane, manual slope');
{
  surface = mound; const page = await newPage(); await drawField(page);
  await page.check('input[name=mode][value=manual]', { force: true });
  await page.fill('#slope', '0.2'); await page.fill('#heading', '135');
  await page.waitForTimeout(500);
  const [, cut, fill] = await kpi(page);
  const f = await page.evaluate(() => ({ A: window.__fg.field.cells.length * window.__fg.field.cellArea }));
  const Am = (MOUND.x1 - MOUND.x0) * (MOUND.y1 - MOUND.y0);
  const expected = MOUND.h * Am * (1 - Am / f.A) * 1.30795;
  check(near(cut, expected, expected * 0.03), `cut ${cut} yd³ ≈ expected ${Math.round(expected)} (±3%)`);
  check(near(fill, expected, expected * 0.03), `fill ${fill} yd³ ≈ expected ${Math.round(expected)} (±3%)`);
  await page.fill('#ratio', '1.25'); await page.waitForTimeout(500);
  const [, c2, f2] = await kpi(page);
  check(near(c2 / f2, 1.25, 0.02), `cut:fill ratio 1.25 honoured (${(c2 / f2).toFixed(3)})`);
  // CSV export
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#deCsv')]);
  const text = fs.readFileSync(await dl.path(), 'utf8');
  check(text.startsWith('lat,lon,existing_ft,design_ft,cut_fill_ft\r\n'), 'design CSV header + CRLF');
  const rows = text.trim().split('\r\n').slice(1).map((l) => l.split(',').map(Number));
  check(rows.length > 1000 && rows.every((r) => r.length === 5 && r.every(Number.isFinite)), `design CSV ${rows.length} numeric rows`);
  check(rows.every((r) => near(r[2] - r[3], r[4], 0.0021)), 'CSV cut_fill = existing - design');
  await page.context().close();
}

// ---------- 3. gaps in lidar ----------
console.log('Stability: lidar with no-data corner');
{
  surface = holey; const page = await newPage(); await drawField(page);
  const warn = await page.textContent('#fieldWarn');
  check(/gaps/.test(warn) && await page.isVisible('#fieldWarn'), 'coverage warning shown', warn);
  await page.waitForFunction(() => /years old/.test(document.querySelector('#fieldWarn').textContent), null, { timeout: 10000 }).catch(() => {});
  check(/years old/.test(await page.textContent('#fieldWarn')), 'old-lidar warning shown for 2012 data');
  check(!page.errors.length, 'no console errors', page.errors.join(' | '));
  await page.context().close();
}

// ---------- 4. service failures ----------
console.log('Stability: elevation service errors');
{
  surface = plane; failMode = 'once'; calls = 0;
  const page = await newPage(); await drawField(page);
  check((await kpi(page)).length === 3, 'recovers after one 502 (retry)');
  await page.context().close();
  failMode = 'always'; calls = 0;
  const p2 = await newPage();
  await p2.evaluate((p) => window.__fg.setField(p.map(([a, b]) => window.L.latLng(a, b))), SQUARE);
  await p2.waitForFunction(() => document.querySelector('#status').classList.contains('err'), null, { timeout: 60000 });
  check(/Elevation service error 500/.test(await p2.textContent('#status')), 'persistent failure shows an error message');
  check(await p2.isHidden('#progress'), 'progress bar cleared after failure');
  await p2.context().close();
  failMode = null;
}

// ---------- 5. UI flow with mouse and keyboard ----------
console.log('UI: draw by mouse, edit, profile chart, relief, search');
{
  surface = plane; const page = await newPage();
  await page.click('#bShed');
  await page.waitForFunction(() => /blue channel/.test(document.querySelector('#mapmsgText')?.textContent || ''), null, { timeout: 60000 });
  check(true, 'drainage tool loads channels first and says where to click');
  await page.keyboard.press('Escape');
  await page.click('#bField');
  check(await page.isVisible('#drawbar'), 'drawing bar appears');
  const box = await page.locator('#map').boundingBox();
  const at = (fx, fy) => [box.x + box.width * fx, box.y + box.height * fy];
  for (const [fx, fy] of [[0.3, 0.3], [0.7, 0.3], [0.7, 0.7]]) await page.mouse.click(...at(fx, fy));
  check(/3 corners · [\d.]+ ac/.test(await page.textContent('#dbMeasure')), 'live area while drawing');
  await page.keyboard.press('Backspace');
  check(/2 corners/.test(await page.textContent('#dbMeasure')), 'Backspace removes last point');
  await page.mouse.click(...at(0.7, 0.7)); await page.mouse.click(...at(0.3, 0.7));
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__fg.field?.plane && window.__fg.busy === 0, null, { timeout: 30000 });
  check(await page.isHidden('#drawbar'), 'Enter finishes and hides the bar');
  const ctr = await page.evaluate(() => { const f = window.__fg.field, m = window.__fg.map, b = window.L.latLngBounds(f.pts).getCenter(), p = m.latLngToContainerPoint(b); return [p.x, p.y]; });
  await page.mouse.move(box.x + ctr[0], box.y + ctr[1]); await page.waitForTimeout(100);
  check(/ft · (cut|fill) [\d.]+ ft/.test(await page.textContent('#hover')), 'hover inside field shows cut/fill depth', await page.textContent('#hover'));
  await page.emulateMedia({ media: 'print' });
  await page.pdf({ path: path.join(ROOT, 'tests', 'out-report.pdf'), format: 'Letter', printBackground: true });
  check(await page.isHidden('#search'), 'print layout hides controls');
  await page.emulateMedia({ media: 'screen' });
  check(await page.isVisible('#legend') && /Cut \/ fill/.test(await page.textContent('#legend')), 'cut/fill legend shown');
  const before = await page.evaluate(() => window.__fg.field.area);
  const h = page.locator('.vtx').nth(2), hb = await h.boundingBox();
  await page.mouse.move(hb.x + 7, hb.y + 7); await page.mouse.down(); await page.mouse.move(hb.x + 80, hb.y + 60, { steps: 5 }); await page.mouse.up();
  await page.waitForFunction((a) => window.__fg.field?.area !== a && window.__fg.busy === 0, before, { timeout: 30000 });
  check(true, 'dragging a handle recomputes the field');

  await page.keyboard.press('p');
  await page.mouse.click(...at(0.2, 0.5)); await page.mouse.click(...at(0.8, 0.5));
  await page.mouse.dblclick(...at(0.8, 0.5));
  await page.waitForFunction(() => window.__fg.profile?.stats && window.__fg.busy === 0, null, { timeout: 30000 });
  check(/Overall grade/.test(await page.textContent('#profStats')), 'profile stats shown after double-click');
  check(await page.evaluate(() => window.__fg.profile.pts.length) === 2, 'double-click did not add a duplicate point');
  const cb = await page.locator('#prof').boundingBox();
  await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2);
  check(/ft along · [\d.]+ ft elevation/.test(await page.textContent('#profTip')), 'chart hover readout');
  // plane falls 0.2% toward 135°, so due east falls 0.2*sin(135°) = 0.141%
  const grade = await page.evaluate(() => window.__fg.profile.stats.grade * 100);
  check(near(grade, -0.1414, 0.01), `east-west profile grade ${grade.toFixed(4)}% ≈ -0.1414%`);

  await page.check('#relief');
  await page.waitForFunction(() => window.__fg.relief && window.__fg.busy === 0, null, { timeout: 30000 });
  check(/Elevation, ft/.test(await page.textContent('#legend')), 'relief legend shown');
  await page.screenshot({ path: path.join(ROOT, 'tests', 'out-desktop.png') });

  await page.fill('#q', 'test farm'); await page.click('#search button[type=submit]');
  await page.waitForFunction(() => /Test Farm/.test(document.querySelector('#status').textContent), null, { timeout: 10000 });
  check(true, 'place search moves the map');
  await page.fill('#q', '33.46, -90.66'); await page.press('#q', 'Enter'); await page.waitForTimeout(800);
  const c = await page.evaluate(() => window.__fg.map.getCenter());
  check(near(c.lat, 33.46, 1e-6) && near(c.lng, -90.66, 1e-6), 'coordinate search', JSON.stringify(c));
  check(!page.errors.length, 'no console errors', page.errors.join(' | '));

  // reload restores the session
  await page.reload(); await page.waitForFunction(() => window.__fg?.field?.plane && window.__fg.profile?.stats && window.__fg.busy === 0, null, { timeout: 30000 });
  check(true, 'field and profile restored after reload');

  // accessibility scan
  await page.addScriptTag({ path: require.resolve('axe-core') });
  const axe = await page.evaluate(async () => (await window.axe.run(document, { exclude: [['.leaflet-container']] })).violations.map((v) => `${v.id} (${v.nodes.length})`));
  check(!axe.length, 'axe-core: no accessibility violations (outside map canvas)', axe.join(', '));
  await page.context().close();
}

// ---------- 6. drainage area, TR-55 and 3D storm ----------
console.log('Engineering: drainage area on a V-shaped valley, TR-55 peaks, 3D storm');
{
  // Valley: channel along x = 0 running south (y decreasing), side slopes 2%, long slope 0.5%.
  // A slight cross-tilt so the two lidar columns either side of the axis merge into one channel; a perfectly
  // symmetric V gives two parallel D8 channels that never join (an artefact of idealised surfaces).
  surface = (x, y) => 30 + 0.02 * Math.abs(x) + 0.002 * x + 0.0005 * y;
  const page = await newPage();
  await page.evaluate(([a, b]) => window.__fg.setShed(window.L.latLng(a, b)), [LAT0, LON0 + 0.0001]);
  await page.waitForFunction(() => window.__fg.shed?.ws && window.__fg.busy === 0, null, { timeout: 60000 });
  const s = await page.evaluate(() => { const sh = window.__fg.shed, d = sh.dem; return { a: sh.areaM2, L: sh.L, edge: sh.ws.touchesEdge, w: d.W * d.dx, h: d.H * d.dy, cy: (d.n - window.__fg.shed.snapped.lat) / (d.n - d.s) }; });
  // The valley never ends, so the area grows to its limit (~3.2 km half-width) and stays cut off.
  // Everything upstream (north) of the outlet inside the final box drains to it.
  const expectA = s.w * s.h * s.cy;
  check(s.w > 6000, `study area grew automatically to ${(s.w / 1000).toFixed(1)} km`);
  check(near(s.a, expectA, expectA * 0.04), `area ${(s.a / 4046.86).toFixed(0)} ac ≈ ${(expectA / 4046.86).toFixed(0)} ac (±4%)`, JSON.stringify(s));
  check(s.edge && /edge of the study area/.test(await page.textContent('#shedWarn')), 'warns that the basin is cut off by the study area');
  check(s.L > s.h * s.cy * 0.9, `longest flow path ${s.L.toFixed(0)} m reaches the far edge`);
  await page.fill('#p100', '7.0'); await page.fill('#p10', '4.5');
  await page.waitForTimeout(200);
  const rows = await page.$$eval('#shedTable tbody tr', (trs) => trs.map((tr) => [...tr.children].map((td) => td.textContent)));
  check(rows.length === 2 && rows[1][0] === '100-yr 24-h', 'results table lists entered storms', JSON.stringify(rows));
  const want = await page.evaluate(async () => {
    const h = await import('./hydro.js'); const sh = window.__fg.shed;
    return h.tr55Peak(sh.areaM2 / 4046.86 / 640, 7, sh.CN, sh.Tc).q;
  });
  check(near(+rows[1][4].replace(/,/g, ''), want, Math.max(1, want * 0.005)), `100-yr peak ${rows[1][4]} cfs matches TR-55 (${want.toFixed(0)})`);
  check(near(+rows[1][2], 4.47, 0.02), `100-yr runoff ${rows[1][2]} in (CN 78, 7 in → 4.47 in)`);
  // 3D storm
  await page.click('#shedStorm');
  check(await page.isVisible('#storm'), 'storm viewer opens');
  check(await page.evaluate(() => window.__storm.ctx?.playing), 'storm starts playing by itself');
  await page.waitForFunction(() => window.__storm.ctx?.sim.t > 13 * 3600, null, { timeout: 180000 });
  const st = await page.evaluate(() => { const c = window.__storm.ctx; const b = c.sim.balance(); let wet = 0; for (const v of c.sim.h) if (v > 0.005) wet++; return { b, wet, peak: Math.max(...c.sim.history.map((r) => r.q)), gl: !!c.renderer.getContext() }; });
  check(st.gl, 'WebGL context created');
  check(st.b.excess > 0 && st.wet > 0 && st.peak > 0, `water on the ground (${st.wet} wet cells) and outflow after the storm peak`);
  check(Math.abs(st.b.error) / st.b.excess < 0.01, `mass balance error ${(100 * Math.abs(st.b.error) / st.b.excess).toFixed(3)}%`);
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(ROOT, 'tests', 'out-storm.png') });
  await page.keyboard.press('Escape');
  check(await page.isHidden('#storm'), 'Escape closes the viewer');
  await page.screenshot({ path: path.join(ROOT, 'tests', 'out-shed.png') });
  // Field storm: property plus surroundings, rain only on the property.
  surface = plane;
  await page.evaluate((p) => window.__fg.setField(p.map(([a, b]) => window.L.latLng(a, b))), SQUARE);
  await page.waitForFunction(() => window.__fg.field?.plane && window.__fg.busy === 0, null, { timeout: 30000 });
  await page.click('#fieldStorm');
  await page.waitForFunction(() => window.__storm.ctx?.sim.t > 14 * 3600, null, { timeout: 400000 });
  const fs2 = await page.evaluate(() => { const c = window.__storm.ctx; let inside = 0, outsideWet = 0; for (let i = 0; i < c.c.rain.length; i++) { if (c.c.rain[i]) inside++; else if (c.sim.h[i] > 0.003) outsideWet++; } return { inside, total: c.c.rain.length, outsideWet, bal: c.sim.balance() }; });
  check(fs2.inside > 0.3 * fs2.total && fs2.inside < 0.7 * fs2.total, `property is ${(100 * fs2.inside / fs2.total).toFixed(0)}% of the grid (surroundings included)`);
  check(fs2.outsideWet > 0, `water runs off the property (${fs2.outsideWet} wet cells outside it)`);
  check(Math.abs(fs2.bal.error) / fs2.bal.excess < 0.01, 'field storm conserves mass');
  await page.screenshot({ path: path.join(ROOT, 'tests', 'out-field-storm.png') });
  await page.keyboard.press('Escape');
  check(!page.errors.length, 'no console errors', page.errors.join(' | '));
  await page.addScriptTag({ path: require.resolve('axe-core') });
  const axe = await page.evaluate(async () => (await window.axe.run(document, { exclude: [['.leaflet-container']] })).violations.map((v) => `${v.id} (${v.nodes.length})`));
  check(!axe.length, 'axe-core: no violations with the drainage card open', axe.join(', '));
  await page.context().close();
  surface = plane;
}

// ---------- 7. site design: flow paths, edits, wetlands, storm with tile ----------
console.log('Site design: drainage paths, pond, raise/lower, tile, wetlands');
{
  surface = plane; const page = await newPage(); await drawField(page);
  await page.waitForFunction(() => window.__fg.design?.exits && window.__fg.busy === 0, null, { timeout: 60000 });
  const ex = await page.evaluate(() => { const d = window.__fg.design, f = window.__fg.field; const [la, lo] = [f.dem.n - (((d.exits[0].i / f.dem.W) | 0) + 0.5) / f.dem.H * (f.dem.n - f.dem.s), f.dem.w + ((d.exits[0].i % f.dem.W) + 0.5) / f.dem.W * (f.dem.e - f.dem.w)]; return { la, lo, n: d.exits.length, share: d.exits.reduce((a, e) => a + e.cells, 0) / f.cells.length }; });
  check(near(ex.share, 1, 1e-9), 'every field cell drains out through some exit');
  check(ex.la < LAT0 && ex.lo > LON0, `main exit is on the low (SE) side (${ex.la.toFixed(5)}, ${ex.lo.toFixed(5)})`);
  check(await page.locator('.exit').count() > 0, 'exit markers drawn on the map');
  // Wetland overlap: NE quarter of a ~49 ac field -> ~12 ac
  await page.waitForFunction(() => /mapped wetland inside/.test(document.querySelector('#wetResult').textContent), null, { timeout: 20000 });
  const wt = await page.textContent('#wetResult'), wa = +wt.match(/([\d.]+) ac of mapped wetland/)[1];
  check(near(wa, 48.9 / 4, 1.0), `wetland overlap ${wa} ac ≈ ${(48.9 / 4).toFixed(1)} ac`);
  // Raise the whole field 1 ft -> fill = area x 1 ft
  await page.click('#bWhole');
  await page.waitForFunction(() => window.__fg.design?.info.length === 1 && window.__fg.busy === 0, null, { timeout: 60000 });
  const g = await page.evaluate(() => window.__fg.design.info[0]);
  const expFill = 48.9 * 4046.86 * 0.3048;
  check(near(g.fillM3, expFill, expFill * 0.03), `raise whole field 1 ft: fill ${Math.round(g.fillM3 * 1.308)} yd³ ≈ ${Math.round(expFill * 1.308)} yd³`);
  check(/disturb/.test(await page.textContent('#wetResult')), 'warns that changes disturb mapped wetland');
  await page.click('[data-del="0"]');
  // Pond in the SE corner, tile across the field
  await page.evaluate(([a, b]) => window.__fg.addEdit('pond', [[a - 0.0016, b + 0.0012], [a - 0.0016, b + 0.0020], [a - 0.0008, b + 0.0020], [a - 0.0008, b + 0.0012]]), [LAT0, LON0]);
  await page.evaluate(([a, b]) => window.__fg.addEdit('tile', [[a + 0.0015, b - 0.0018], [a - 0.0012, b + 0.0016]]), [LAT0, LON0]);
  await page.waitForFunction(() => window.__fg.design?.info.length === 2 && window.__fg.busy === 0, null, { timeout: 60000 });
  const [pond, tile] = await page.evaluate(() => window.__fg.design.info);
  check(pond.cells > 0 && pond.storageM3 > 0 && near(pond.rim - pond.bottom, 4 * 0.3048, 1e-4), `pond: 4 ft deep, ${(pond.storageM3 / 1233.48).toFixed(2)} ac-ft storage`);
  check(tile.capacityCfs > 0 && tile.acresServed > 0, `tile: ${tile.capacityCfs.toFixed(2)} cfs, ~${Math.round(tile.acresServed)} ac`);
  check(/Pond storage/.test(await page.textContent('#sdStats')), 'summary lists pond storage');
  await page.click('#sdStorm');
  await page.waitForFunction(() => window.__storm.ctx?.sim.t > 14 * 3600, null, { timeout: 400000 });
  const sb = await page.evaluate(() => { const c = window.__storm.ctx; return { b: c.sim.balance(), sinks: c.c.sinks.length }; });
  check(sb.sinks === 1 && sb.b.tile > 0, `storm uses the tile (${(sb.b.tile / 1233.48).toFixed(2)} ac-ft taken)`);
  check(Math.abs(sb.b.error) / sb.b.excess < 0.01, 'storm with changes conserves mass');
  await page.screenshot({ path: path.join(ROOT, 'tests', 'out-design-storm.png') });
  await page.keyboard.press('Escape');
  await page.screenshot({ path: path.join(ROOT, 'tests', 'out-design.png') });
  check(!page.errors.length, 'no console errors', page.errors.join(' | '));
  await page.context().close();
}

// ---------- 8. survey import (CSV, DXF, LandXML, LAS, LAZ, DWG) and moving water ----------
console.log('Survey import: replaces lidar with surveyed elevations');
{
  surface = plane;
  // Known survey surface = lidar plane + 0.10 m, with a 0.5 m deep ditch for |x| <= 5 m (see tests/fixtures).
  const zSurv = (x, y) => plane(x, y) + 0.10 - (x >= -5 && x <= 5 ? 0.5 : 0);
  const cases = [['survey_pnezd.csv', 'epsg', 2255], ['survey.dxf', 'epsg', 2255], ['survey_tin.xml', 'auto'], ['cloud.las', 'auto'], ['cloud.laz', 'auto']];
  for (const [file, crs, code] of cases) {
    const page = await newPage();
    await page.click('#bSurvey');
    await page.setInputFiles('#svFile', path.join(ROOT, 'tests', 'fixtures', file));
    await page.selectOption('#svCrs', crs);
    if (code) await page.fill('#svEpsg', String(code));
    await page.click('#svLoad');
    await page.waitForFunction(() => window.__fg.survey?.cmp !== undefined && window.__fg.busy === 0 || document.querySelector('#status').classList.contains('err'), null, { timeout: 120000 });
    const res = await page.textContent('#svResult'), err = await page.evaluate(() => document.querySelector('#status').classList.contains('err') ? document.querySelector('#status').textContent : '');
    const med = await page.evaluate(() => window.__fg.survey?.cmp?.median);
    check(!err && near(med, 0.10, 0.02), `${file}: loaded, survey − lidar median ${(med ?? NaN).toFixed(3)} m ≈ +0.10 m`, err || res.slice(0, 160));
    // A field over the survey now uses survey elevations: check the ditch and a bank against the known surface.
    const F = [[LAT0 + 0.0006, LON0 - 0.0007], [LAT0 + 0.0006, LON0 + 0.0007], [LAT0 - 0.0006, LON0 + 0.0007], [LAT0 - 0.0006, LON0 - 0.0007]];
    await page.evaluate((p) => window.__fg.setField(p.map(([a, b]) => window.L.latLng(a, b))), F);
    await page.waitForFunction(() => window.__fg.field?.plane && window.__fg.field?.dem?.svMask && window.__fg.busy === 0, null, { timeout: 120000 });
    const z = await page.evaluate(([la0, lo0]) => { const d = window.__fg.field.dem, at = (x, y) => {
        const la = la0 + y / 111194.9, lo = lo0 + x / (111194.9 * Math.cos(la0 * Math.PI / 180));
        const i = Math.floor(((lo - d.w) / (d.e - d.w)) * d.W), j = Math.floor(((d.n - la) / (d.n - d.s)) * d.H); return d.data[j * d.W + i]; };
      return { ditch: at(0, 20), bank: at(30, -20) }; }, [LAT0, LON0]);
    const tol = file.startsWith('survey_tin') ? 0.03 : 0.03;
    if (!file.startsWith('survey_tin')) check(near(z.ditch, zSurv(0, 20), 0.03), `${file}: ditch bottom ${z.ditch.toFixed(3)} m ≈ ${zSurv(0, 20).toFixed(3)} m (lidar alone: ${plane(0, 20).toFixed(3)})`);
    check(near(z.bank, zSurv(30, -20), tol), `${file}: field elevation ${z.bank.toFixed(3)} m ≈ survey ${zSurv(30, -20).toFixed(3)} m`);
    await page.context().close();
  }
  const page = await newPage();
  await page.click('#bSurvey');
  await page.setInputFiles('#svFile', { name: 'site.dwg', mimeType: 'application/acad', buffer: Buffer.from('AC1032 binary') });
  await page.click('#svLoad');
  await page.waitForFunction(() => document.querySelector('#status').classList.contains('err'), null, { timeout: 20000 });
  check(/DXF/.test(await page.textContent('#status')), 'DWG explains how to export DXF / LandXML instead');
  check(!page.errors.length, 'no console errors', page.errors.join(' | '));
  await page.context().close();
}
console.log('Storm 3D: moving water and rain');
{
  surface = plane; const page = await newPage(); await drawField(page);
  await page.click('#fieldStorm');
  await page.waitForFunction(() => window.__storm.ctx?.sim.t > 12.2 * 3600, null, { timeout: 400000 });
  const snap = () => page.evaluate(() => { const c = window.__storm.ctx, t = c.tracers.geometry.attributes.position.array, r = c.rain.geometry.attributes.position.array;
    let live = 0, rainOn = 0; const xs = []; for (let k = 0; k < t.length / 3; k++) if (t[k * 3 + 1] > -1e5) { live++; xs.push(t[k * 3], t[k * 3 + 2]); }
    for (let k = 0; k < r.length / 3; k++) if (r[k * 3 + 1] > -1e5) rainOn++; return { live, rainOn, xs: xs.slice(0, 400) }; });
  const a = await snap(); await page.waitForTimeout(700); const b = await snap();
  let moved = 0; for (let k = 0; k < Math.min(a.xs.length, b.xs.length); k++) if (Math.abs(a.xs[k] - b.xs[k]) > 0.01) moved++;
  check(a.live > 500, `${a.live} water tracers on the ground`);
  check(moved > 50, `tracers move with the flow (${moved} coordinates changed)`);
  check(a.rainOn > 0 || b.rainOn > 0, `rain drops falling (${Math.max(a.rainOn, b.rainOn)})`);
  await page.screenshot({ path: path.join(ROOT, 'tests', 'out-moving-water.png') });
  check(!page.errors.length, 'no console errors', page.errors.join(' | '));
  await page.context().close();
}

// ---------- 9. phone layout + dark mode ----------
console.log('UI: phone layout, dark mode');
{
  surface = plane; const page = await newPage({ viewport: { width: 390, height: 844 }, colorScheme: 'dark', isMobile: true, hasTouch: true });
  await drawField(page);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  check(!overflow, 'no horizontal scroll at 390 px');
  await page.screenshot({ path: path.join(ROOT, 'tests', 'out-phone.png'), fullPage: true });
  check(!page.errors.length, 'no console errors', page.errors.join(' | '));
  await page.context().close();
}

await browser.close(); server.close();
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
