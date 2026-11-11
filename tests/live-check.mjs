// Live cross-check (real USGS service): grid samples from fetchDEM vs. the service's own point query.
// A georeferencing shift or unit error shows up as a systematic difference. Run: node tests/live-check.mjs
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import { createRequire } from 'node:module'; import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url); const { chromium } = require('playwright');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = http.createServer((q, r) => { const f = path.join(ROOT, q.url === '/' ? 'index.html' : q.url.split('?')[0]);
  if (!f.startsWith(ROOT) || !fs.existsSync(f)) { r.writeHead(404); return r.end(); }
  r.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript' : f.endsWith('.css') ? 'text/css' : 'text/html' }); fs.createReadStream(f).pipe(r); });
await new Promise((r) => server.listen(0, r));
const ALL = [['MS Delta', 33.4512, -90.6431], ['Iowa', 42.0105, -93.6200], ['Arkansas', 34.7750, -91.5010], ['California CV', 36.6100, -119.9000]];
const SITES = process.env.ONLY ? ALL.filter(([n]) => process.env.ONLY.split(',').includes(n)) : ALL;
const browser = await chromium.launch(); const page = await browser.newPage();
await page.goto(`http://localhost:${server.address().port}/`); await page.waitForFunction(() => window.__fg);
let worst = 0, bad = 0;
for (const [name, lat, lon] of SITES) {
  const r = await page.evaluate(async ([lat, lon]) => {
    const { fetchDEM, sample, pointElevation } = await import('./dem.js');
    const d = 0.003, dem = await fetchDEM({ s: lat - d, n: lat + d, w: lon - d, e: lon + d });
    const out = [];
    for (const [a, b] of [[0, 0], [0.001, 0.001], [-0.0012, 0.0008], [0.0015, -0.001], [-0.0007, -0.0016]]) {
      const g = sample(dem, lat + a, lon + b), p = await pointElevation(lat + a, lon + b);
      out.push([g, p]);
    }
    const { lidarSource } = await import('./dem.js');
    const src = await lidarSource(lat, lon).catch((e) => ({ title: 'lookup failed: ' + e.message }));
    return { out, dx: dem.dx, cov: dem.coverage, src: src && `${src.title}${src.end ? ` (${src.start?.toISOString().slice(0, 7)} – ${src.end.toISOString().slice(0, 7)})` : ''}` };
  }, [lat, lon]).catch((e) => ({ err: e.message }));
  if (r.err) { console.log(`${name}: ERROR ${r.err}`); bad++; continue; }
  const diffs = r.out.filter(([g, p]) => Number.isFinite(g) && Number.isFinite(p)).map(([g, p]) => (g - p) * 3.28084);
  const mx = Math.max(...diffs.map(Math.abs)), mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
  worst = Math.max(worst, mx);
  console.log(`${name}: cell ${(r.dx * 3.28084).toFixed(1)} ft, coverage ${(r.cov * 100).toFixed(0)}%, ` +
    `grid − point: mean ${mean.toFixed(3)} ft, max |${mx.toFixed(3)}| ft over ${diffs.length} pts\n    source: ${r.src}`);
}
console.log(`worst difference ${worst.toFixed(3)} ft${bad ? `, ${bad} site(s) failed` : ''}`);
await browser.close(); server.close();
