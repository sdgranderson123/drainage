import { fromArrayBuffer } from 'https://cdn.jsdelivr.net/npm/geotiff@2.1.3/+esm';
import { toLocal, pointInPolygon, polygonArea, fitPlane, planeFromSlope, slopeOf, designZ, volumes, balance,
  M_TO_FT, M3_TO_YD3, M2_TO_AC } from './earthwork.js';

const SVC = 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer';
const $ = (id) => document.getElementById(id);
const L = window.L;

const map = L.map('map', { doubleClickZoom: false }).setView([35.0, -90.2], 15);
L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  { maxZoom: 20, maxNativeZoom: 19, attribution: 'Imagery © Esri · Elevation: USGS 3DEP' }).addTo(map);

// ---------- elevation data ----------
async function fetchDEM(bounds) {
  const s = bounds.getSouth(), n = bounds.getNorth(), w = bounds.getWest(), e = bounds.getEast();
  const lat0 = (s + n) / 2;
  const wm = toLocal(lat0, e, lat0, w).x, hm = toLocal(n, w, s, w).y;
  const scale = Math.max(1, Math.max(wm, hm) / 1500); // ~1 m cells, max 1500 px a side
  const W = Math.max(8, Math.round(wm / scale)), H = Math.max(8, Math.round(hm / scale));
  const url = `${SVC}/exportImage?bbox=${w},${s},${e},${n}&bboxSR=4326&imageSR=4326&size=${W},${H}` +
    `&format=tiff&pixelType=F32&noDataInterpretation=esriNoDataMatchAny&interpolation=RSP_BilinearInterpolation&f=image`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`USGS returned ${r.status}`);
  const tif = await fromArrayBuffer(await r.arrayBuffer());
  const img = await tif.getImage();
  const [data] = await img.readRasters();
  return { data, W: img.getWidth(), H: img.getHeight(), s, n, w, e };
}
const valid = (z) => Number.isFinite(z) && z > -500 && z < 9000;

function sample(dem, lat, lon) {
  const px = ((lon - dem.w) / (dem.e - dem.w)) * dem.W - 0.5, py = ((dem.n - lat) / (dem.n - dem.s)) * dem.H - 0.5;
  const x0 = Math.max(0, Math.min(dem.W - 2, Math.floor(px))), y0 = Math.max(0, Math.min(dem.H - 2, Math.floor(py)));
  const fx = Math.min(1, Math.max(0, px - x0)), fy = Math.min(1, Math.max(0, py - y0));
  const g = (x, y) => dem.data[y * dem.W + x];
  const v = [g(x0, y0), g(x0 + 1, y0), g(x0, y0 + 1), g(x0 + 1, y0 + 1)];
  if (!v.every(valid)) return NaN;
  return v[0] * (1 - fx) * (1 - fy) + v[1] * fx * (1 - fy) + v[2] * (1 - fx) * fy + v[3] * fx * fy;
}

// ---------- hover elevation ----------
let hoverT, hoverSeq = 0;
map.on('mousemove', (ev) => {
  clearTimeout(hoverT);
  hoverT = setTimeout(async () => {
    const seq = ++hoverSeq, { lat, lng } = ev.latlng;
    const geom = encodeURIComponent(JSON.stringify({ x: lng, y: lat, spatialReference: { wkid: 4326 } }));
    const url = `${SVC}/identify?geometry=${geom}&geometryType=esriGeometryPoint&returnGeometry=false&returnCatalogItems=false&f=json`;
    try {
      const j = await (await fetch(url)).json();
      if (seq !== hoverSeq) return;
      const z = parseFloat(j.value);
      $('hover').textContent = `${lat.toFixed(6)}, ${lng.toFixed(6)} · ` + (valid(z) ? `${(z * M_TO_FT).toFixed(2)} ft` : 'no data');
    } catch { /* ignore */ }
  }, 150);
});

// ---------- drawing ----------
let mode = null, pts = [], temp = null, layers = L.layerGroup().addTo(map), overlay = null;
function setMode(m) {
  mode = m; pts = [];
  $('bProf').classList.toggle('on', m === 'profile'); $('bField').classList.toggle('on', m === 'field');
  $('bDone').disabled = !m; $('bUndo').disabled = !m;
  map.getContainer().style.cursor = m ? 'crosshair' : '';
  $('hint').textContent = m === 'profile' ? 'Click along the line; double-click or Done to finish.'
    : m === 'field' ? 'Click the field corners; double-click or Done to finish.' : 'Pick a tool.';
  redraw();
}
function redraw() {
  if (temp) map.removeLayer(temp);
  temp = !pts.length ? null : mode === 'field' && pts.length > 2
    ? L.polygon(pts, { color: '#ffd400', weight: 2, fillOpacity: 0.1 }).addTo(map)
    : L.polyline(pts, { color: '#ffd400', weight: 3 }).addTo(map);
}
map.on('click', (e) => { if (mode) { pts.push(e.latlng); redraw(); } });
map.on('dblclick', () => { if (mode) finish(); });
$('bProf').onclick = () => setMode(mode === 'profile' ? null : 'profile');
$('bField').onclick = () => setMode(mode === 'field' ? null : 'field');
$('bUndo').onclick = () => { pts.pop(); redraw(); };
$('bDone').onclick = () => finish();
$('bClear').onclick = () => { layers.clearLayers(); if (overlay) map.removeLayer(overlay); overlay = null; field = null;
  $('profBox').hidden = $('fieldBox').hidden = true; setMode(null); status(''); };
$('go').onclick = () => { const m = $('q').value.split(/[ ,]+/).map(Number); if (m.length >= 2 && m.every(Number.isFinite)) map.setView([m[0], m[1]], 17); };
const status = (t) => { $('status').textContent = t; };

async function finish() {
  // A double-click also fires two clicks; drop a duplicate last point.
  const dedup = pts.filter((p, i) => i === 0 || map.distance(p, pts[i - 1]) > 0.5);
  const m = mode; setMode(null);
  if (temp) { map.removeLayer(temp); temp = null; }
  try {
    if (m === 'profile' && dedup.length >= 2) await doProfile(dedup);
    else if (m === 'field' && dedup.length >= 3) await doField(dedup);
    else status('Not enough points.');
  } catch (err) { status('Error: ' + err.message); console.error(err); }
}

// ---------- profile ----------
let profRows = [];
async function doProfile(line) {
  status('Loading lidar…');
  const dem = await fetchDEM(L.latLngBounds(line).pad(0.05));
  layers.addLayer(L.polyline(line, { color: '#ffd400', weight: 3 }));
  profRows = []; let dist = 0;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1], b = line[i], seg = map.distance(a, b), n = Math.max(1, Math.ceil(seg));
    for (let k = i === 1 ? 0 : 1; k <= n; k++) {
      const t = k / n, lat = a.lat + (b.lat - a.lat) * t, lon = a.lng + (b.lng - a.lng) * t;
      profRows.push({ d: dist + seg * t, lat, lon, z: sample(dem, lat, lon) });
    }
    dist += seg;
  }
  const ok = profRows.filter((r) => valid(r.z));
  if (!ok.length) throw new Error('No lidar coverage on this line.');
  drawProfile(ok, dist);
  const zs = ok.map((r) => r.z), first = ok[0], last = ok[ok.length - 1];
  const fall = (first.z - last.z) * M_TO_FT;
  $('profStats').innerHTML = `<tr><td>Length</td><td>${(dist * M_TO_FT).toFixed(0)} ft</td></tr>
    <tr><td>Start → end</td><td>${(first.z * M_TO_FT).toFixed(2)} → ${(last.z * M_TO_FT).toFixed(2)} ft</td></tr>
    <tr><td>Low / high</td><td>${(Math.min(...zs) * M_TO_FT).toFixed(2)} / ${(Math.max(...zs) * M_TO_FT).toFixed(2)} ft</td></tr>
    <tr><td>Overall slope</td><td>${(Math.abs(fall / (dist * M_TO_FT)) * 100).toFixed(3)} % ${fall >= 0 ? 'down' : 'up'}</td></tr>`;
  $('profBox').hidden = false; status('');
}
function drawProfile(rows, dist) {
  const c = $('prof'), g = c.getContext('2d'), W = c.width, H = c.height, P = 40;
  g.clearRect(0, 0, W, H);
  const zs = rows.map((r) => r.z * M_TO_FT), lo = Math.min(...zs), hi = Math.max(...zs), span = Math.max(0.5, hi - lo);
  const X = (d) => P + (d / dist) * (W - P - 10), Y = (z) => H - 24 - ((z - lo) / span) * (H - 40);
  g.font = '18px system-ui'; g.fillStyle = '#66707a'; g.strokeStyle = '#e3e7eb';
  for (let i = 0; i <= 4; i++) { const z = lo + (span * i) / 4; g.beginPath(); g.moveTo(P, Y(z)); g.lineTo(W, Y(z)); g.stroke(); g.fillText(z.toFixed(1), 0, Y(z) + 5); }
  g.fillText(`${(dist * M_TO_FT).toFixed(0)} ft`, W - 80, H - 2);
  g.strokeStyle = '#1f6feb'; g.lineWidth = 3; g.beginPath();
  rows.forEach((r, i) => (i ? g.lineTo : g.moveTo).call(g, X(r.d), Y(r.z * M_TO_FT))); g.stroke();
}
$('profCsv').onclick = () => csv('profile.csv', ['distance_ft', 'lat', 'lon', 'elev_ft'],
  profRows.filter((r) => valid(r.z)).map((r) => [(r.d * M_TO_FT).toFixed(2), r.lat.toFixed(7), r.lon.toFixed(7), (r.z * M_TO_FT).toFixed(3)]));

// ---------- field cut/fill ----------
let field = null;
async function doField(poly) {
  status('Loading lidar…');
  const bounds = L.latLngBounds(poly), dem = await fetchDEM(bounds.pad(0.02));
  layers.addLayer(L.polygon(poly, { color: '#ffd400', weight: 2, fill: false }));
  const lat0 = (dem.s + dem.n) / 2, lon0 = (dem.w + dem.e) / 2;
  const P = poly.map((p) => { const q = toLocal(p.lat, p.lng, lat0, lon0); return [q.x, q.y]; });
  const dLat = (dem.n - dem.s) / dem.H, dLon = (dem.e - dem.w) / dem.W;
  const cell = toLocal(lat0 + dLat, lon0 + dLon, lat0, lon0), cellArea = Math.abs(cell.x * cell.y);
  const cells = [];
  for (let j = 0; j < dem.H; j++) for (let i = 0; i < dem.W; i++) {
    const z = dem.data[j * dem.W + i]; if (!valid(z)) continue;
    const lat = dem.n - (j + 0.5) * dLat, lon = dem.w + (i + 0.5) * dLon, q = toLocal(lat, lon, lat0, lon0);
    if (pointInPolygon(q.x, q.y, P)) cells.push({ i, j, lat, lon, x: q.x, y: q.y, z });
  }
  if (cells.length < 10) throw new Error('Too few lidar cells inside the field.');
  field = { dem, cells, cellArea, area: polygonArea(P), plane: null };
  $('fieldBox').hidden = false; compute(); status('');
}
function compute() {
  if (!field) return;
  const ratio = Math.min(2, Math.max(0.5, parseFloat($('ratio').value) || 1));
  const manual = document.querySelector('input[name=mode]:checked').value === 'manual';
  const base = manual ? planeFromSlope(parseFloat($('slope').value) || 0, parseFloat($('heading').value) || 0) : fitPlane(field.cells);
  const plane = balance(field.cells, base, field.cellArea, ratio);
  field.plane = plane;
  const v = volumes(field.cells, plane, field.cellArea), s = slopeOf(plane), acres = field.area * M2_TO_AC;
  if (!manual) { $('slope').value = s.slopePct.toFixed(3); $('heading').value = s.headingDeg.toFixed(0); }
  const cutYd = v.cut * M3_TO_YD3, fillYd = v.fill * M3_TO_YD3;
  $('fieldStats').innerHTML = `<tr><td>Area</td><td>${acres.toFixed(2)} ac</td></tr>
    <tr><td>Design slope</td><td>${s.slopePct.toFixed(3)} % toward ${s.headingDeg.toFixed(0)}°</td></tr>
    <tr><td class="cut">Cut</td><td class="cut">${Math.round(cutYd).toLocaleString()} yd³</td></tr>
    <tr><td class="fill">Fill</td><td class="fill">${Math.round(fillYd).toLocaleString()} yd³</td></tr>
    <tr><td>Cut per acre</td><td>${Math.round(cutYd / acres).toLocaleString()} yd³/ac</td></tr>
    <tr><td>Max cut / fill</td><td>${(v.maxCut * M_TO_FT).toFixed(2)} / ${(v.maxFill * M_TO_FT).toFixed(2)} ft</td></tr>`;
  drawOverlay(Math.max(v.maxCut, v.maxFill));
}
function drawOverlay(maxD) {
  const { dem, cells, plane } = field, c = document.createElement('canvas');
  c.width = dem.W; c.height = dem.H;
  const g = c.getContext('2d'), im = g.createImageData(dem.W, dem.H), lim = Math.max(0.03, maxD * 0.6);
  for (const p of cells) {
    const d = p.z - designZ(plane, p.x, p.y), t = Math.min(1, Math.abs(d) / lim), k = (p.j * dem.W + p.i) * 4;
    const [r, gg, b] = d > 0 ? [209, 69, 59] : [47, 111, 214];
    im.data[k] = r; im.data[k + 1] = gg; im.data[k + 2] = b; im.data[k + 3] = Math.round(40 + 190 * t);
  }
  g.putImageData(im, 0, 0);
  if (overlay) map.removeLayer(overlay);
  overlay = L.imageOverlay(c.toDataURL(), [[dem.s, dem.w], [dem.n, dem.e]], { opacity: 0.75 }).addTo(map);
}
$('recalc').onclick = compute;
document.querySelectorAll('input[name=mode]').forEach((r) => (r.onchange = compute));
$('exCsv').onclick = () => field && csv('existing.csv', ['lat', 'lon', 'elev_ft'],
  field.cells.map((p) => [p.lat.toFixed(7), p.lon.toFixed(7), (p.z * M_TO_FT).toFixed(3)]));
$('deCsv').onclick = () => field && csv('design.csv', ['lat', 'lon', 'existing_ft', 'design_ft', 'cut_fill_ft'],
  field.cells.map((p) => { const d = designZ(field.plane, p.x, p.y);
    return [p.lat.toFixed(7), p.lon.toFixed(7), (p.z * M_TO_FT).toFixed(3), (d * M_TO_FT).toFixed(3), ((p.z - d) * M_TO_FT).toFixed(3)]; }));

function csv(name, head, rows) {
  const blob = new Blob([[head, ...rows].map((r) => r.join(',')).join('\n')], { type: 'text/csv' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

window.__fg = { map, finish, setMode, get field() { return field; }, get pts() { return pts; } }; // test hook
