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
  await p2.waitForFunction(() => document.querySelector('#status').classList.contains('err'), null, { timeout: 30000 });
  check(/Elevation service error 500/.test(await p2.textContent('#status')), 'persistent failure shows an error message');
  check(await p2.isHidden('#progress'), 'progress bar cleared after failure');
  await p2.context().close();
  failMode = null;
}

// ---------- 5. UI flow with mouse and keyboard ----------
console.log('UI: draw by mouse, edit, profile chart, relief, search');
{
  surface = plane; const page = await newPage();
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
  await page.mouse.move(...at(0.5, 0.5)); await page.waitForTimeout(100);
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

// ---------- 6. phone layout + dark mode ----------
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
