import { toLocal, pointInPolygon, polygonArea, fitPlane, planeFromSlope, slopeOf, designZ, volumes, balance,
  profileStats, quantile, hillshade, rampColor, toCSV, parseLatLon, M_TO_FT, M3_TO_YD3, M2_TO_AC } from './earthwork.js';
import { fetchDEM, sample, pointElevation, geocode, lidarSource } from './dem.js';
import { fillDepressions, d8, accumulate, snapOutlet, watershed, flowPath, scsRunoff, tcLag, tcKirpich, tr55Peak, LAND_USE } from './hydro.js';
import { openStorm } from './storm3d.js';

const L = window.L;
const $ = (id) => document.getElementById(id);
const ft = (m, d = 2) => (m * M_TO_FT).toFixed(d);
const fmt = (n) => Math.round(n).toLocaleString('en-US');
const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const dirName = (deg) => COMPASS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem('fg:' + k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem('fg:' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};

// ---------------- map ----------------
const view = store.get('view');
const map = L.map('map', { doubleClickZoom: false, zoomControl: true, preferCanvas: false })
  .setView(view ? [view.lat, view.lng] : [39.5, -96], view ? view.z : 5);
const imagery = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  { maxZoom: 20, maxNativeZoom: 19, attribution: 'Imagery © Esri, Maxar, Earthstar Geographics · Elevation: USGS 3DEP' }).addTo(map);
const labels = L.layerGroup([
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}', { maxZoom: 20, maxNativeZoom: 19 }),
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', { maxZoom: 20, maxNativeZoom: 19 }),
]);
if (store.get('labels') !== false) labels.addTo(map);
L.control.layers({ Satellite: imagery }, { 'Roads & places': labels }, { position: 'topright' }).addTo(map);
L.control.scale({ imperial: true, metric: false }).addTo(map);
map.on('overlayadd overlayremove', (e) => e.layer === labels && store.set('labels', e.type === 'overlayadd'));
map.on('moveend', () => { const c = map.getCenter(); store.set('view', { lat: c.lat, lng: c.lng, z: map.getZoom() }); });

// ---------------- status / busy ----------------
let busy = 0;
function status(msg, err = false) { $('status').textContent = msg || ''; $('status').classList.toggle('err', !!err); }
async function withBusy(fn) {
  busy++; $('progress').hidden = false;
  try { return await fn(); }
  catch (e) { if (e.name !== 'AbortError') { status(e.message || String(e), true); console.error(e); } }
  finally { if (--busy === 0) $('progress').hidden = true; }
}

// ---------------- search / locate ----------------
$('search').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = $('q').value.trim(); if (!q) return;
  const ll = parseLatLon(q);
  if (ll) { map.setView([ll.lat, ll.lon], 17, { animate: false }); status(''); return; }
  withBusy(async () => {
    status('Searching…');
    const r = await geocode(q);
    if (!r) { status(`No US match for “${q}”.`, true); return; }
    if (r.extent) map.fitBounds([[r.extent.ymin, r.extent.xmin], [r.extent.ymax, r.extent.xmax]], { maxZoom: 17, animate: false });
    else map.setView([r.lat, r.lon], 16, { animate: false });
    status(r.label);
  });
});
$('locate').onclick = () => {
  if (!navigator.geolocation) { status('Location is not available in this browser.', true); return; }
  status('Finding your location…');
  navigator.geolocation.getCurrentPosition(
    (p) => { map.setView([p.coords.latitude, p.coords.longitude], 17, { animate: false }); status(''); },
    () => status('Could not get your location.', true), { enableHighAccuracy: true, timeout: 15000 });
};

// ---------------- lidar relief layer ----------------
let relief = null, reliefCtl = null, reliefT;
const RELIEF_MIN_ZOOM = 13;
function reliefWanted() { return $('relief').checked; }
$('relief').onchange = () => {
  $('reliefOpts').hidden = !reliefWanted(); store.set('relief', reliefWanted());
  if (reliefWanted()) loadRelief(); else { clearRelief(); renderLegend(); }
};
$('reliefOpacity').oninput = () => relief?.layer.setOpacity(+$('reliefOpacity').value);
map.on('moveend', () => { if (reliefWanted()) { clearTimeout(reliefT); reliefT = setTimeout(loadRelief, 600); } });
function clearRelief() { reliefCtl?.abort(); if (relief) map.removeLayer(relief.layer); relief = null; }
function loadRelief() {
  if (map.getZoom() < RELIEF_MIN_ZOOM) { clearRelief(); renderLegend(); status('Zoom in closer to see lidar relief.'); return; }
  const b = map.getBounds();
  if (relief && relief.bounds.contains(b)) return;
  reliefCtl?.abort(); reliefCtl = new AbortController();
  const ctl = reliefCtl, pb = b.pad(0.15);
  withBusy(async () => {
    const dem = await fetchDEM({ s: pb.getSouth(), n: pb.getNorth(), w: pb.getWest(), e: pb.getEast() },
      { signal: ctl.signal, onProgress: (m) => status(m) });
    if (ctl.signal.aborted) return;
    if (dem.coverage < 0.01) { status('No lidar coverage here.', true); return; }
    const url = renderRelief(dem);
    if (relief) map.removeLayer(relief.layer);
    const layer = L.imageOverlay(url, [[dem.s, dem.w], [dem.n, dem.e]], { opacity: +$('reliefOpacity').value, className: 'relief' }).addTo(map);
    layer.bringToBack(); imagery.bringToBack();
    relief = { layer, dem, bounds: L.latLngBounds([[dem.s, dem.w], [dem.n, dem.e]]) };
    status(dem.coverage < 0.95 ? `Lidar covers ${Math.round(dem.coverage * 100)}% of this view.` : '');
    renderLegend();
  });
}
function renderRelief(dem) {
  const vals = []; for (let i = 0; i < dem.data.length; i += 7) if (Number.isFinite(dem.data[i])) vals.push(dem.data[i]);
  const lo = quantile(vals, 0.02), hi = quantile(vals, 0.98), span = Math.max(0.3, hi - lo);
  const hs = hillshade(dem.data, dem.W, dem.H, dem.dx, dem.dy, { exaggeration: 3 });
  const c = document.createElement('canvas'); c.width = dem.W; c.height = dem.H;
  const g = c.getContext('2d'), im = g.createImageData(dem.W, dem.H);
  for (let i = 0; i < dem.data.length; i++) {
    const z = dem.data[i]; if (!Number.isFinite(z)) continue;
    const [r, gg, b] = rampColor((z - lo) / span), s = 0.35 + 0.75 * hs[i];
    im.data[i * 4] = Math.min(255, r * s); im.data[i * 4 + 1] = Math.min(255, gg * s); im.data[i * 4 + 2] = Math.min(255, b * s); im.data[i * 4 + 3] = 255;
  }
  g.putImageData(im, 0, 0);
  dem.range = { lo, hi };
  return c.toDataURL();
}

// ---------------- legend ----------------
function renderLegend() {
  const parts = [];
  if (relief?.dem.range) {
    const stops = [0, .25, .5, .75, 1].map((t) => `rgb(${rampColor(t)}) ${t * 100}%`).join(',');
    parts.push(`<div><b>Elevation, ft</b><div class="bar" style="background:linear-gradient(90deg,${stops})"></div>
      <div class="ends"><span>${ft(relief.dem.range.lo, 1)}</span><span>${ft(relief.dem.range.hi, 1)}</span></div></div>`);
  }
  if (field?.lim) {
    parts.push(`<div${parts.length ? ' style="margin-top:8px"' : ''}><b>Cut / fill, ft</b><div class="bar" style="background:linear-gradient(90deg,var(--fill),#ffffff00 50%,var(--cut))"></div>
      <div class="ends"><span>${ft(field.lim, 2)} fill</span><span>0</span><span>${ft(field.lim, 2)} cut</span></div></div>`);
  }
  $('legend').innerHTML = parts.join(''); $('legend').hidden = !parts.length;
}

// ---------------- hover elevation ----------------
let hoverT, hoverCtl;
const demsForHover = () => [field?.dem, profile?.dem, shed?.dem, relief?.dem].filter(Boolean);
map.on('mousemove', (ev) => showElevation(ev.latlng));
// Touch screens have no hover: a tap (when not drawing) shows the elevation there.
map.on('click', (ev) => { if (!draw.mode) showElevation(ev.latlng); });
function cutFillAt(lat, lng, z) {
  if (!field?.plane || !field.P) return '';
  const q = toLocal(lat, lng, field.origin[0], field.origin[1]);
  if (!pointInPolygon(q.x, q.y, field.P)) return '';
  const d = z - designZ(field.plane, q.x, q.y);
  return ` · ${d >= 0 ? 'cut' : 'fill'} ${ft(Math.abs(d))} ft`;
}
function showElevation(ll) {
  const { lat, lng } = ll, at = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  for (const d of demsForHover()) {
    const z = sample(d, lat, lng);
    if (Number.isFinite(z)) { $('hover').textContent = `${at} · ${ft(z)} ft${cutFillAt(lat, lng, z)}`; return; }
  }
  $('hover').textContent = `${at} · …`;
  clearTimeout(hoverT); hoverCtl?.abort();
  hoverT = setTimeout(async () => {
    const ctl = hoverCtl = new AbortController();
    try {
      const z = await pointElevation(lat, lng, { signal: ctl.signal });
      if (!ctl.signal.aborted) $('hover').textContent = `${at} · ${Number.isFinite(z) ? ft(z) + ' ft' : 'no lidar'}`;
    } catch { if (!ctl.signal.aborted) $('hover').textContent = `${at} · elevation unavailable`; }
  }, 250);
}
map.on('mouseout', () => { clearTimeout(hoverT); hoverCtl?.abort(); });

// ---------------- lidar date ----------------
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthYear = (d) => `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
const srcCache = new Map();
// Fills `el` with the lidar collection window for a point; returns the source (or null).
async function showSource(lat, lon, el, warnEl) {
  const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  el.textContent = 'checking…';
  try {
    if (!srcCache.has(key)) srcCache.set(key, lidarSource(lat, lon).catch((e) => { srcCache.delete(key); throw e; }));
    const s = await srcCache.get(key);
    if (!el.isConnected) return null;
    if (!s) { el.textContent = 'unknown'; return null; }
    const span = s.start && monthYear(s.start) !== monthYear(s.end) ? `${monthYear(s.start)} – ${monthYear(s.end)}` : monthYear(s.end);
    el.textContent = s.compilation ? `${span} (10 m compilation)` : span; el.title = s.title;
    const years = (Date.now() - s.end.getTime()) / 3.156e10;
    if (warnEl && years > 5) {
      warnEl.hidden = false;
      warnEl.insertAdjacentHTML('beforeend', `${warnEl.innerHTML ? '<br>' : ''}Lidar is about ${Math.floor(years)} years old. If the ground has been worked since, these numbers will be off.`);
    }
    return s;
  } catch { if (el.isConnected) el.textContent = 'unavailable'; return null; }
}

// ---------------- drawing ----------------
const draw = { mode: null, pts: [], line: null, ghost: null, markers: [] };
const TOOL = { profile: { btn: 'bProf', title: 'Elevation profile', hint: 'Click along the line.', min: 2 },
  field: { btn: 'bField', title: 'Field outline', hint: 'Click each corner of the field.', min: 3 },
  shed: { btn: 'bShed', title: 'Drainage outlet', hint: 'Click the culvert, tile outlet or ditch point the water drains to.', min: 1 } };
function startDraw(mode) {
  cancelDraw();
  draw.mode = mode; draw.pts = [];
  $(TOOL[mode].btn).setAttribute('aria-pressed', 'true');
  $('dbTitle').textContent = TOOL[mode].title; $('dbHint').textContent = TOOL[mode].hint;
  $('drawbar').hidden = false; map.getContainer().style.cursor = 'crosshair';
  updateDraw();
}
function cancelDraw() {
  if (!draw.mode) return;
  $(TOOL[draw.mode].btn).setAttribute('aria-pressed', 'false');
  for (const l of [draw.line, draw.ghost, ...draw.markers]) if (l) map.removeLayer(l);
  Object.assign(draw, { mode: null, pts: [], line: null, ghost: null, markers: [] });
  $('drawbar').hidden = true; map.getContainer().style.cursor = '';
}
function pathLength(pts) { let d = 0; for (let i = 1; i < pts.length; i++) d += map.distance(pts[i - 1], pts[i]); return d; }
function areaOf(pts) {
  const lat0 = pts[0].lat, lon0 = pts[0].lng;
  return polygonArea(pts.map((p) => { const q = toLocal(p.lat, p.lng, lat0, lon0); return [q.x, q.y]; }));
}
function measureText(mode, pts) {
  if (mode === 'shed') return 'One click places the outlet. It snaps to the nearest channel within 160 ft; drag it afterwards to adjust.';
  if (mode === 'profile') return pts.length > 1 ? `${pts.length} points · ${fmt(pathLength(pts) * M_TO_FT)} ft` : `${pts.length} point${pts.length === 1 ? '' : 's'}`;
  return pts.length > 2 ? `${pts.length} corners · ${(areaOf(pts) * M2_TO_AC).toFixed(2)} ac` : `${pts.length} corner${pts.length === 1 ? '' : 's'}`;
}
function updateDraw(cursor) {
  const { mode, pts } = draw; if (!mode) return;
  const shown = cursor ? [...pts, cursor] : pts;
  if (draw.line) map.removeLayer(draw.line);
  draw.line = mode === 'field' && shown.length > 2
    ? L.polygon(shown, { color: '#ffd400', weight: 2, fillOpacity: 0.12, dashArray: cursor ? '6 6' : null, interactive: false }).addTo(map)
    : shown.length > 1 ? L.polyline(shown, { color: '#ffd400', weight: 3, interactive: false }).addTo(map) : null;
  draw.markers.forEach((m) => map.removeLayer(m));
  draw.markers = pts.map((p) => L.circleMarker(p, { radius: 5, color: '#1c2420', weight: 2, fillColor: '#fff', fillOpacity: 1, interactive: false }).addTo(map));
  $('dbMeasure').textContent = measureText(mode, shown);
  $('bUndo').disabled = !pts.length; $('bDone').disabled = pts.length < TOOL[mode].min;
}
map.on('click', (e) => { if (draw.mode) { draw.pts.push(e.latlng); if (draw.mode === 'shed') finishDraw(); else updateDraw(); } });
map.on('mousemove', (e) => { if (draw.mode && draw.pts.length) updateDraw(e.latlng); });
map.on('dblclick', (e) => { if (draw.mode) { L.DomEvent.stop(e); finishDraw(); } });
$('bProf').onclick = () => (draw.mode === 'profile' ? cancelDraw() : startDraw('profile'));
$('bField').onclick = () => (draw.mode === 'field' ? cancelDraw() : startDraw('field'));
$('bShed').onclick = () => (draw.mode === 'shed' ? cancelDraw() : startDraw('shed'));
$('bUndo').onclick = () => { draw.pts.pop(); updateDraw(); };
$('bCancel').onclick = cancelDraw;
$('bDone').onclick = finishDraw;
document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea, select')) return;
  if (e.key === 'Escape') cancelDraw();
  else if (e.key === 'Enter' && draw.mode) { e.preventDefault(); finishDraw(); }
  else if ((e.key === 'Backspace' || (e.key === 'z' && (e.ctrlKey || e.metaKey))) && draw.mode) { e.preventDefault(); draw.pts.pop(); updateDraw(); }
  else if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key === 'p') startDraw('profile');
  else if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key === 'f') startDraw('field');
  else if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key === 'd') startDraw('shed');
});
function finishDraw() {
  if (!draw.mode) return;
  // A double-click adds two clicks at the same spot; drop near-duplicates.
  const pts = draw.pts.filter((p, i) => i === 0 || map.distance(p, draw.pts[i - 1]) > 0.5);
  const mode = draw.mode;
  if (pts.length < TOOL[mode].min) { status(mode === 'field' ? 'A field needs at least 3 corners.' : 'A profile needs at least 2 points.', true); return; }
  cancelDraw();
  if (mode === 'profile') setProfile(pts); else if (mode === 'shed') setShed(pts[pts.length - 1]); else setField(pts);
}

// Editable shape with draggable vertex handles.
function editable(pts, isPoly, onChange) {
  const shape = (isPoly ? L.polygon(pts, { color: '#ffd400', weight: 2.5, fill: false })
    : L.polyline(pts, { color: '#ffd400', weight: 3.5 })).addTo(map);
  const icon = L.divIcon({ className: 'vtx', iconSize: [14, 14] });
  const handles = pts.map((p, i) => {
    const m = L.marker(p, { draggable: true, icon, keyboard: true, title: `Point ${i + 1}: drag to move` }).addTo(map);
    m.on('drag', () => { pts[i] = m.getLatLng(); shape.setLatLngs(pts); });
    m.on('dragend', () => onChange(pts.slice()));
    return m;
  });
  return { shape, remove() { map.removeLayer(shape); handles.forEach((h) => map.removeLayer(h)); } };
}

// ---------------- profile ----------------
let profile = null;
function setProfile(pts) {
  profile?.edit.remove(); profile?.cursor && map.removeLayer(profile.cursor);
  profile = { pts, edit: editable(pts.slice(), false, (p) => { profile.pts = p; computeProfile(); }), rows: [], dem: null, cursor: null };
  store.set('profile', pts.map((p) => [p.lat, p.lng]));
  $('intro').hidden = true;
  computeProfile();
}
let profSeq = 0;
function computeProfile() {
  const seq = ++profSeq, pts = profile.pts;
  withBusy(async () => {
    const b = L.latLngBounds(pts), pad = Math.max(0.0003, (b.getNorth() - b.getSouth()) * 0.05);
    if (!profile.dem || !L.latLngBounds([[profile.dem.s, profile.dem.w], [profile.dem.n, profile.dem.e]]).contains(b)) {
      profile.dem = await fetchDEM({ s: b.getSouth() - pad, n: b.getNorth() + pad, w: b.getWest() - pad, e: b.getEast() + pad }, { onProgress: (m) => status(m) });
    }
    if (seq !== profSeq) return;
    const rows = []; let dist = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], c = pts[i], seg = map.distance(a, c), n = Math.max(1, Math.ceil(seg / Math.max(0.5, profile.dem.dx)));
      for (let k = i === 1 ? 0 : 1; k <= n; k++) {
        const t = k / n, lat = a.lat + (c.lat - a.lat) * t, lon = a.lng + (c.lng - a.lng) * t;
        rows.push({ d: dist + seg * t, lat, lon, z: sample(profile.dem, lat, lon) });
      }
      dist += seg;
    }
    const st = profileStats(rows);
    if (!st) throw new Error('No lidar coverage along this line.');
    profile.rows = rows; profile.stats = st; profile.dist = dist;
    drawProfile();
    const gaps = rows.filter((r) => !Number.isFinite(r.z)).length;
    const pct = (g) => `${(Math.abs(g) * 100).toFixed(2)}%`;
    $('profStats').innerHTML = `
      <dt>Length</dt><dd>${fmt(dist * M_TO_FT)} ft</dd>
      <dt>Start → end</dt><dd>${ft(st.start)} → ${ft(st.end)} ft</dd>
      <dt>Overall grade</dt><dd>${pct(st.grade)} ${st.grade < 0 ? 'downhill' : st.grade > 0 ? 'uphill' : 'level'} (${ft(Math.abs(st.end - st.start))} ft)</dd>
      <dt>Low / high</dt><dd>${ft(st.lo)} / ${ft(st.hi)} ft</dd>
      <dt>Steepest (33 ft run)</dt><dd>↑ ${pct(st.maxUp)} · ↓ ${pct(st.maxDown)}</dd>
      <dt>Lidar cell</dt><dd>${ft(profile.dem.dx, 1)} ft</dd>
      <dt>Lidar flown</dt><dd id="profSrc"></dd>` +
      (gaps ? `<dt>No-data samples</dt><dd>${gaps}</dd>` : '');
    const mid = pts[Math.floor(pts.length / 2)];
    showSource(mid.lat, mid.lng, $('profSrc'));
    $('profBox').hidden = false; status('');
  });
}
function chartGeom() {
  const c = $('prof'), dpr = window.devicePixelRatio || 1, W = c.clientWidth, H = c.clientHeight;
  if (c.width !== Math.round(W * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
  const st = profile.stats, lo = st.lo * M_TO_FT, hi = st.hi * M_TO_FT, pad = Math.max(0.25, (hi - lo) * 0.08);
  const L0 = 44, R0 = 10, T0 = 10, B0 = 22;
  const X = (d) => L0 + (d / profile.dist) * (W - L0 - R0);
  const Y = (zft) => T0 + (1 - (zft - (lo - pad)) / (hi - lo + 2 * pad)) * (H - T0 - B0);
  return { c, dpr, W, H, X, Y, lo: lo - pad, hi: hi + pad, L0, R0, T0, B0 };
}
function drawProfile(cursorIdx = -1) {
  if (!profile?.stats) return;
  const g0 = chartGeom(), { c, dpr, W, H, X, Y } = g0, g = c.getContext('2d');
  const css = getComputedStyle(document.documentElement), muted = css.getPropertyValue('--muted'), line = css.getPropertyValue('--line'), acc = css.getPropertyValue('--acc');
  g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
  g.font = '11px system-ui'; g.fillStyle = muted; g.strokeStyle = line; g.lineWidth = 1;
  const step = niceStep((g0.hi - g0.lo) / 4);
  for (let z = Math.ceil(g0.lo / step) * step; z <= g0.hi; z += step) {
    g.beginPath(); g.moveTo(g0.L0, Y(z)); g.lineTo(W - g0.R0, Y(z)); g.stroke();
    g.textAlign = 'right'; g.fillText(z.toFixed(step < 1 ? 1 : 0), g0.L0 - 5, Y(z) + 4);
  }
  g.textAlign = 'left'; g.fillText('0', g0.L0, H - 6);
  g.textAlign = 'right'; g.fillText(`${fmt(profile.dist * M_TO_FT)} ft`, W - g0.R0, H - 6);
  // area fill + line, broken at no-data gaps
  const rows = profile.rows;
  const grad = g.createLinearGradient(0, g0.T0, 0, H - g0.B0); grad.addColorStop(0, acc + '55'); grad.addColorStop(1, acc + '08');
  let run = [];
  const flush = () => {
    if (run.length > 1) {
      g.beginPath(); run.forEach((r, i) => (i ? g.lineTo : g.moveTo).call(g, X(r.d), Y(r.z * M_TO_FT)));
      g.lineTo(X(run[run.length - 1].d), H - g0.B0); g.lineTo(X(run[0].d), H - g0.B0); g.closePath(); g.fillStyle = grad; g.fill();
      g.beginPath(); run.forEach((r, i) => (i ? g.lineTo : g.moveTo).call(g, X(r.d), Y(r.z * M_TO_FT)));
      g.strokeStyle = acc; g.lineWidth = 2; g.stroke();
    }
    run = [];
  };
  for (const r of rows) { if (Number.isFinite(r.z)) run.push(r); else flush(); } flush();
  // vertex markers on the chart
  let d = 0; g.strokeStyle = line; g.setLineDash([3, 3]);
  for (let i = 1; i < profile.pts.length - 1; i++) { d += map.distance(profile.pts[i - 1], profile.pts[i]); g.beginPath(); g.moveTo(X(d), g0.T0); g.lineTo(X(d), H - g0.B0); g.stroke(); }
  g.setLineDash([]);
  if (cursorIdx >= 0 && Number.isFinite(rows[cursorIdx].z)) {
    const r = rows[cursorIdx];
    g.strokeStyle = muted; g.beginPath(); g.moveTo(X(r.d), g0.T0); g.lineTo(X(r.d), H - g0.B0); g.stroke();
    g.fillStyle = '#ffd400'; g.strokeStyle = '#1c2420'; g.lineWidth = 2;
    g.beginPath(); g.arc(X(r.d), Y(r.z * M_TO_FT), 4.5, 0, 7); g.fill(); g.stroke();
  }
}
function niceStep(x) { const p = 10 ** Math.floor(Math.log10(x)), m = x / p; return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p; }
function profileCursor(clientX) {
  if (!profile?.stats) return;
  const { X } = chartGeom(), rect = $('prof').getBoundingClientRect(), x = clientX - rect.left;
  let best = 0, bd = Infinity;
  profile.rows.forEach((r, i) => { const dd = Math.abs(X(r.d) - x); if (dd < bd) { bd = dd; best = i; } });
  const r = profile.rows[best];
  drawProfile(best);
  $('profTip').textContent = Number.isFinite(r.z) ? `${fmt(r.d * M_TO_FT)} ft along · ${ft(r.z)} ft elevation` : `${fmt(r.d * M_TO_FT)} ft along · no lidar`;
  if (!profile.cursor) profile.cursor = L.circleMarker([r.lat, r.lon], { radius: 6, color: '#1c2420', weight: 2, fillColor: '#ffd400', fillOpacity: 1, interactive: false }).addTo(map);
  else profile.cursor.setLatLng([r.lat, r.lon]);
}
$('prof').addEventListener('pointermove', (e) => profileCursor(e.clientX));
$('prof').addEventListener('pointerleave', () => { drawProfile(); if (profile?.cursor) { map.removeLayer(profile.cursor); profile.cursor = null; } $('profTip').textContent = 'Point at the chart to find that spot on the map.'; });
new ResizeObserver(() => drawProfile()).observe($('prof'));
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => drawProfile());
$('profCsv').onclick = () => profile && download('profile.csv', toCSV(['distance_ft', 'lat', 'lon', 'elev_ft'],
  profile.rows.filter((r) => Number.isFinite(r.z)).map((r) => [ft(r.d), r.lat.toFixed(7), r.lon.toFixed(7), ft(r.z, 3)])));

// ---------------- field cut / fill ----------------
let field = null, overlay = null;
function setField(pts) {
  field?.edit.remove();
  field = { pts, edit: editable(pts.slice(), true, (p) => { field.pts = p; loadField(); }) };
  store.set('field', pts.map((p) => [p.lat, p.lng]));
  $('intro').hidden = true;
  loadField();
}
let fieldSeq = 0;
function loadField() {
  const seq = ++fieldSeq, poly = field.pts;
  withBusy(async () => {
    const b = L.latLngBounds(poly), pad = Math.max(0.0002, (b.getNorth() - b.getSouth()) * 0.02);
    const dem = (field.dem && L.latLngBounds([[field.dem.s, field.dem.w], [field.dem.n, field.dem.e]]).contains(b)) ? field.dem
      : await fetchDEM({ s: b.getSouth() - pad, n: b.getNorth() + pad, w: b.getWest() - pad, e: b.getEast() + pad }, { onProgress: (m) => status(m) });
    if (seq !== fieldSeq) return;
    const lat0 = (dem.s + dem.n) / 2, lon0 = (dem.w + dem.e) / 2;
    const P = poly.map((p) => { const q = toLocal(p.lat, p.lng, lat0, lon0); return [q.x, q.y]; });
    const dLat = (dem.n - dem.s) / dem.H, dLon = (dem.e - dem.w) / dem.W;
    const cellArea = dem.dx * dem.dy;
    const cells = []; let inside = 0;
    for (let j = 0; j < dem.H; j++) for (let i = 0; i < dem.W; i++) {
      const lat = dem.n - (j + 0.5) * dLat, lon = dem.w + (i + 0.5) * dLon, q = toLocal(lat, lon, lat0, lon0);
      if (!pointInPolygon(q.x, q.y, P)) continue;
      inside++;
      const z = dem.data[j * dem.W + i];
      if (Number.isFinite(z)) cells.push({ i, j, lat, lon, x: q.x, y: q.y, z });
    }
    if (cells.length < 10) throw new Error('Too little lidar inside this field — draw a larger area or check coverage.');
    Object.assign(field, { dem, cells, cellArea, P, origin: [lat0, lon0], area: polygonArea(P), coverage: cells.length / Math.max(1, inside) });
    $('fieldBox').hidden = false;
    computeField(); status('');
  });
}
function readNum(id, lo, hi, dflt) { const v = parseFloat($(id).value); const ok = Number.isFinite(v) && v >= lo && v <= hi; $(id).setAttribute('aria-invalid', String(!ok)); return ok ? v : dflt; }
function computeField() {
  if (!field?.cells) return;
  const manual = document.querySelector('input[name=mode]:checked').value === 'manual';
  $('slope').disabled = $('heading').disabled = !manual;
  const ratio = readNum('ratio', 0.5, 2, 1);
  const base = manual ? planeFromSlope(readNum('slope', 0, 10, 0), readNum('heading', 0, 360, 0)) : fitPlane(field.cells);
  const plane = field.plane = balance(field.cells, base, field.cellArea, ratio);
  const v = volumes(field.cells, plane, field.cellArea), s = slopeOf(plane);
  if (!manual) { $('slope').value = s.slopePct.toFixed(3); $('heading').value = Math.round(s.headingDeg) % 360; }
  $('arrow').style.transform = `rotate(${s.headingDeg - 180}deg)`;
  const acres = field.area * M2_TO_AC, cutYd = v.cut * M3_TO_YD3, fillYd = v.fill * M3_TO_YD3;
  let zlo = Infinity, zhi = -Infinity;
  for (const c of field.cells) { if (c.z < zlo) zlo = c.z; if (c.z > zhi) zhi = c.z; }
  $('kpis').innerHTML = `
    <div class="kpi"><span>Area</span><b>${acres.toFixed(1)}</b> ac</div>
    <div class="kpi cut"><span>Cut</span><b>${fmt(cutYd)}</b> yd³</div>
    <div class="kpi fill"><span>Fill</span><b>${fmt(fillYd)}</b> yd³</div>`;
  $('fieldStats').innerHTML = `
    <dt>Design slope</dt><dd>${s.slopePct.toFixed(3)}% toward ${dirName(s.headingDeg)} (${Math.round(s.headingDeg) % 360}°)</dd>
    <dt>Fall across field</dt><dd>${ft(fallAcross(plane))} ft</dd>
    <dt>Cut per acre</dt><dd>${fmt(cutYd / acres)} yd³/ac</dd>
    <dt>Deepest cut / fill</dt><dd>${ft(v.maxCut)} / ${ft(v.maxFill)} ft</dd>
    <dt>Existing low / high</dt><dd>${ft(zlo)} / ${ft(zhi)} ft</dd>
    <dt>Lidar cell / points</dt><dd>${ft(field.dem.dx, 1)} ft · ${fmt(field.cells.length)}</dd>
    <dt>Lidar flown</dt><dd id="fieldSrc"></dd>`;
  const warn = [];
  if (field.coverage < 0.95) warn.push(`Lidar has gaps: ${Math.round(field.coverage * 100)}% of the field has data. Volumes cover only that part.`);
  if (acres > 0 && cutYd / acres > 1500) warn.push('Very large cut per acre. Check the outline doesn’t include ditches, roads, levees or buildings.');
  $('fieldWarn').innerHTML = warn.join('<br>'); $('fieldWarn').hidden = !warn.length;
  const c0 = field.cells[Math.floor(field.cells.length / 2)];
  showSource(c0.lat, c0.lon, $('fieldSrc'), $('fieldWarn'));
  field.lim = Math.max(0.03, Math.max(v.maxCut, v.maxFill) * 0.6);
  drawCutFill(); renderLegend();
}
function fallAcross(plane) {
  let lo = Infinity, hi = -Infinity;
  for (const c of field.cells) { const z = designZ(plane, c.x, c.y); if (z < lo) lo = z; if (z > hi) hi = z; }
  return hi - lo;
}
function drawCutFill() {
  const { dem, cells, plane, lim } = field, c = document.createElement('canvas');
  c.width = dem.W; c.height = dem.H;
  const g = c.getContext('2d'), im = g.createImageData(dem.W, dem.H);
  for (const p of cells) {
    const d = p.z - designZ(plane, p.x, p.y), t = Math.min(1, Math.abs(d) / lim), k = (p.j * dem.W + p.i) * 4;
    const col = d > 0 ? [200, 66, 58] : [45, 104, 196];
    im.data[k] = col[0]; im.data[k + 1] = col[1]; im.data[k + 2] = col[2]; im.data[k + 3] = Math.round(30 + 205 * t);
  }
  g.putImageData(im, 0, 0);
  if (overlay) map.removeLayer(overlay);
  overlay = L.imageOverlay(c.toDataURL(), [[dem.s, dem.w], [dem.n, dem.e]], { opacity: 0.85 }).addTo(map);
  field.edit.shape.bringToFront();
}
let fT;
const refield = () => { clearTimeout(fT); fT = setTimeout(computeField, 200); };
['slope', 'heading', 'ratio'].forEach((id) => $(id).addEventListener('input', refield));
document.querySelectorAll('input[name=mode]').forEach((r) => r.addEventListener('change', computeField));
addEventListener('beforeprint', () => map.invalidateSize());
addEventListener('afterprint', () => map.invalidateSize());
$('printBtn').onclick = () => {
  $('printDate').textContent = new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
  if (field) map.fitBounds(field.edit.shape.getBounds(), { padding: [30, 30], animate: false });
  setTimeout(() => window.print(), 400);
};
$('fieldStorm').onclick = () => {
  if (!field?.dem) return;
  const { dem, cells } = field, mask = new Uint8Array(dem.W * dem.H);
  for (const c of cells) mask[c.j * dem.W + c.i] = 1;
  openStorm(dem, { title: 'Storm on the field', mask, depthIn: designDepth(), CN: +$('cn').value || 78 });
};
$('exCsv').onclick = () => field?.cells && download('field-existing.csv', toCSV(['lat', 'lon', 'elev_ft'],
  field.cells.map((p) => [p.lat.toFixed(7), p.lon.toFixed(7), ft(p.z, 3)])));
$('deCsv').onclick = () => field?.plane && download('field-design.csv', toCSV(['lat', 'lon', 'existing_ft', 'design_ft', 'cut_fill_ft'],
  field.cells.map((p) => { const d = designZ(field.plane, p.x, p.y); return [p.lat.toFixed(7), p.lon.toFixed(7), ft(p.z, 3), ft(d, 3), ft(p.z - d, 3)]; })));

// ---------------- drainage area & peak flow ----------------
const RP = [2, 10, 25, 50, 100];
let shed = null, shedSeq = 0;
{
  $('landUse').innerHTML = LAND_USE.map(([n], i) => `<option value="${i}">${n}</option>`).join('');
  const saved = store.get('rain') || {};
  $('rpInputs').innerHTML = RP.map((y) => `<label>${y}-yr<input id="p${y}" type="number" min="0.5" max="30" step="0.01" inputmode="decimal" value="${saved[y] ?? ''}" placeholder="in"></label>`).join('');
  const lu = store.get('landUse'); if (lu) { $('landUse').value = lu[0]; $('hsg').value = lu[1]; }
  const setCN = () => { $('cn').value = LAND_USE[+$('landUse').value][1][+$('hsg').value]; store.set('landUse', [$('landUse').value, $('hsg').value]); shedResults(); };
  $('landUse').onchange = setCN; $('hsg').onchange = setCN;
  if (!lu) $('cn').value = LAND_USE[0][1][1];
  else $('cn').value = LAND_USE[+lu[0]][1][+lu[1]];
  $('cn').addEventListener('input', shedResults); $('tcMethod').onchange = shedResults;
  RP.forEach((y) => $(`p${y}`).addEventListener('input', () => {
    const r = {}; RP.forEach((k) => { const v = parseFloat($(`p${k}`).value); if (Number.isFinite(v)) r[k] = v; });
    store.set('rain', r); shedResults();
  }));
  $('shedRadius').onchange = () => shed && computeShed(true);
}
function designDepth() { for (const y of [100, 50, 25, 10, 2]) { const v = parseFloat($(`p${y}`).value); if (Number.isFinite(v)) return v; } return 5; }

function setShed(ll) {
  if (shed) shed.layers.forEach((l) => map.removeLayer(l));
  shed = { outlet: ll, layers: [] };
  store.set('shed', [ll.lat, ll.lng]);
  $('intro').hidden = true;
  $('noaaLink').href = `https://hdsc.nws.noaa.gov/pfds/pfds_map_cont.html?lat=${ll.lat.toFixed(4)}&lon=${ll.lng.toFixed(4)}`;
  computeShed(true);
}
function computeShed(refetch) {
  const seq = ++shedSeq, ll = shed.outlet, R = +$('shedRadius').value;
  withBusy(async () => {
    if (refetch || !shed.dem) {
      const dLat = R / 111320, dLon = R / (111320 * Math.cos(ll.lat * Math.PI / 180));
      const dem = await fetchDEM({ s: ll.lat - dLat, n: ll.lat + dLat, w: ll.lng - dLon, e: ll.lng + dLon }, { onProgress: (m) => status(m) });
      if (seq !== shedSeq) return;
      status('Tracing flow paths…');
      await new Promise((r) => setTimeout(r, 20));
      const f = fillDepressions(dem.data, dem.W, dem.H), rec = d8(f, dem.W, dem.H, dem.dx, dem.dy), acc = accumulate(rec, dem.W * dem.H);
      Object.assign(shed, { dem, rec, acc });
    }
    const { dem, rec, acc } = shed;
    const px = Math.floor(((ll.lng - dem.w) / (dem.e - dem.w)) * dem.W), py = Math.floor(((dem.n - ll.lat) / (dem.n - dem.s)) * dem.H);
    if (px < 0 || py < 0 || px >= dem.W || py >= dem.H) throw new Error('Outlet is outside the lidar area.');
    // Snap to the strongest flow line within 50 ft; if that isn't a real channel (2+ acres), look out to 160 ft.
    const chan = (2 * 4046.86) / (dem.dx * dem.dy);
    let out = snapOutlet(acc, dem.W, dem.H, px, py, Math.max(1, Math.round(15 / dem.dx)));
    if (acc[out] < chan) { const far = snapOutlet(acc, dem.W, dem.H, px, py, Math.max(2, Math.round(50 / dem.dx))); if (acc[far] >= chan) out = far; }
    const ws = watershed(rec, dem.W, dem.H, out, dem.dx, dem.dy);
    const cellA = dem.dx * dem.dy, areaM2 = ws.cells.length * cellA;
    const path = flowPath(rec, ws.far, out);
    const zOut = dem.data[out], zTop = dem.data[ws.far], pathLen = ws.len[ws.far];
    // Average land slope over the basin (central differences on the unfilled surface).
    let ss = 0, sn = 0;
    for (const c of ws.cells) {
      const x = c % dem.W, y = (c / dem.W) | 0; if (x < 1 || y < 1 || x >= dem.W - 1 || y >= dem.H - 1) continue;
      const gx = (dem.data[c + 1] - dem.data[c - 1]) / (2 * dem.dx), gy = (dem.data[c + dem.W] - dem.data[c - dem.W]) / (2 * dem.dy);
      if (Number.isFinite(gx) && Number.isFinite(gy)) { ss += Math.hypot(gx, gy); sn++; }
    }
    const idxLL = (i) => [dem.n - ((((i / dem.W) | 0) + 0.5) / dem.H) * (dem.n - dem.s), dem.w + (((i % dem.W) + 0.5) / dem.W) * (dem.e - dem.w)];
    Object.assign(shed, { ws, out, areaM2, L: pathLen, relief: zTop - zOut, pathSlope: pathLen > 0 ? (zTop - zOut) / pathLen : 0, basinSlope: sn ? ss / sn : 0,
      snapped: L.latLng(...idxLL(out)), pathLL: path.filter((_, k) => k % 3 === 0 || k === path.length - 1).map(idxLL) });
    if (seq !== shedSeq) return;
    drawShed(); shedResults(); $('shedBox').hidden = false; status('');
  });
}
function drawShed() {
  shed.layers.forEach((l) => map.removeLayer(l));
  const { dem, ws, acc } = shed, c = document.createElement('canvas'); c.width = dem.W; c.height = dem.H;
  const g = c.getContext('2d'), im = g.createImageData(dem.W, dem.H);
  const ac = (dem.dx * dem.dy) / 4046.86, W = dem.W, H = dem.H;
  for (let i = 0; i < W * H; i++) if (ws.mask[i]) { const k = i * 4; im.data[k] = 120; im.data[k + 1] = 60; im.data[k + 2] = 200; im.data[k + 3] = 70; }
  // Channels (2+ acres draining) drawn wider for bigger flows so they stay visible when the image is scaled down.
  const px = Math.max(1, Math.round(W / Math.max(300, map.getSize().x)));
  for (let i = 0; i < W * H; i++) {
    const a = acc[i] * ac; if (a < 2) continue;
    const r = px * (a >= 640 ? 3 : a >= 40 ? 2 : 1), x0 = i % W, y0 = (i / W) | 0, inB = ws.mask[i];
    for (let y = Math.max(0, y0 - r); y <= Math.min(H - 1, y0 + r); y++) for (let x = Math.max(0, x0 - r); x <= Math.min(W - 1, x0 + r); x++) {
      const k = (y * W + x) * 4;
      if (im.data[k + 2] === 255 && im.data[k + 3] === 255) continue;
      im.data[k] = inB ? 20 : 70; im.data[k + 1] = inB ? 110 : 160; im.data[k + 2] = 255; im.data[k + 3] = inB ? 255 : 170;
    }
  }
  g.putImageData(im, 0, 0);
  const img = L.imageOverlay(c.toDataURL(), [[dem.s, dem.w], [dem.n, dem.e]], { opacity: 0.9 }).addTo(map);
  const box = L.rectangle([[dem.s, dem.w], [dem.n, dem.e]], { color: '#ffffff', weight: 1, dashArray: '4 6', fill: false, interactive: false }).addTo(map);
  const lfp = L.polyline(shed.pathLL, { color: '#ffd400', weight: 3, dashArray: '8 6', interactive: false }).addTo(map);
  const icon = L.divIcon({ className: 'outlet', html: '<span></span>', iconSize: [22, 22] });
  const m = L.marker(shed.snapped, { draggable: true, icon, title: 'Outlet: drag to move', keyboard: true }).addTo(map);
  m.on('dragend', () => {
    const p = m.getLatLng(), b = L.latLngBounds([[dem.s, dem.w], [dem.n, dem.e]]).pad(-0.1);
    shed.outlet = p; store.set('shed', [p.lat, p.lng]);
    computeShed(!b.contains(p));
  });
  shed.layers = [img, box, lfp, m];
}
function shedResults() {
  if (!shed?.ws) return;
  const CN = Math.min(98, Math.max(30, parseFloat($('cn').value) || 78));
  const acres = shed.areaM2 * M2_TO_AC, sqmi = acres / 640, Lft = shed.L * M_TO_FT;
  const tLag = tcLag(Lft, shed.basinSlope * 100, CN), tK = tcKirpich(Lft, shed.pathSlope);
  const Tc = $('tcMethod').value === 'kirpich' ? tK : tLag;
  $('shedKpis').innerHTML = `
    <div class="kpi"><span>Area</span><b>${acres < 100 ? acres.toFixed(1) : fmt(acres)}</b> ac</div>
    <div class="kpi"><span>Flow path</span><b>${fmt(Lft)}</b> ft</div>
    <div class="kpi"><span>Tc</span><b>${Tc < 1 ? Math.round(Tc * 60) : Tc.toFixed(1)}</b> ${Tc < 1 ? 'min' : 'h'}</div>`;
  $('shedStats').innerHTML = `
    <dt>Drainage area</dt><dd>${acres.toFixed(1)} ac · ${sqmi.toFixed(3)} sq mi</dd>
    <dt>Outlet elevation</dt><dd>${ft(shed.dem.data[shed.out])} ft</dd>
    <dt>Relief along flow path</dt><dd>${ft(shed.relief, 1)} ft (${(shed.pathSlope * 100).toFixed(2)}%)</dd>
    <dt>Average land slope</dt><dd>${(shed.basinSlope * 100).toFixed(2)}%</dd>
    <dt>Tc, NRCS lag / Kirpich</dt><dd>${Math.round(tLag * 60)} / ${Math.round(tK * 60)} min</dd>`;
  const warn = [];
  if (shed.ws.touchesEdge) warn.push('The drainage area reaches the edge of the study area, so it is cut off. Choose a larger radius.');
  if (acres < 1) warn.push('Very small area: the click may not be on a flow line. Drag the outlet onto the blue channel.');
  warn.push('Lidar shows the ground surface only. Culverts under roads and tile lines are not in it, so road embankments can wrongly split or merge basins. Check the outline against the field.');
  $('shedWarn').innerHTML = warn.join('<br>'); $('shedWarn').hidden = false;
  const rows = [], notes = new Set();
  for (const y of RP) {
    const P = parseFloat($(`p${y}`).value); if (!Number.isFinite(P)) continue;
    const r = tr55Peak(sqmi, P, CN, Tc); r.notes.forEach((n) => notes.add(n));
    rows.push({ y, P, Q: r.Q, vol: (r.Q / 12) * acres, q: r.q });
  }
  shed.rows = rows; shed.CN = CN; shed.Tc = Tc;
  $('shedTable').innerHTML = rows.length
    ? `<thead><tr><th>Storm</th><th>Rain, in</th><th>Runoff, in</th><th>Volume, ac-ft</th><th>Peak, cfs</th></tr></thead><tbody>` +
      rows.map((r) => `<tr><td>${r.y}-yr 24-h</td><td>${r.P.toFixed(2)}</td><td>${r.Q.toFixed(2)}</td><td>${r.vol.toFixed(1)}</td><td class="peak">${r.q < 10 ? r.q.toFixed(1) : fmt(r.q)}</td></tr>`).join('') +
      `</tbody><caption class="small muted">TR-55 graphical peak, Type II storm, CN ${Math.round(CN)}, Tc ${Math.round(Tc * 60)} min.${[...notes].map((n) => ' ' + n + '.').join('')}</caption>`
    : '<caption class="small muted">Enter the 24-hour rainfall depths above (from NOAA Atlas 14) to get runoff and peak flows.</caption>';
}
$('shedStorm').onclick = () => {
  if (!shed?.ws) return;
  const { dem, ws } = shed;
  // Crop to the basin's bounding box (plus a margin) so the simulation grid stays fine.
  let x0 = dem.W, y0 = dem.H, x1 = 0, y1 = 0;
  for (const c of ws.cells) { const x = c % dem.W, y = (c / dem.W) | 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  const m = 3; x0 = Math.max(0, x0 - m); y0 = Math.max(0, y0 - m); x1 = Math.min(dem.W - 1, x1 + m); y1 = Math.min(dem.H - 1, y1 + m);
  const W = x1 - x0 + 1, H = y1 - y0 + 1, data = new Float32Array(W * H), mask = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = (y + y0) * dem.W + x + x0; data[y * W + x] = dem.data[i]; mask[y * W + x] = ws.mask[i]; }
  openStorm({ data, W, H, dx: dem.dx, dy: dem.dy }, { title: `Storm on the ${(shed.areaM2 * M2_TO_AC).toFixed(0)}-acre drainage area`, mask, depthIn: designDepth(), CN: shed.CN });
};
$('shedCsv').onclick = () => shed?.ws && download('drainage-area.csv', toCSV(
  ['outlet_lat', 'outlet_lon', 'area_ac', 'flow_path_ft', 'tc_min', 'cn', 'storm', 'rain_in', 'runoff_in', 'volume_acft', 'peak_cfs'],
  (shed.rows.length ? shed.rows : [{}]).map((r) => [shed.snapped.lat.toFixed(6), shed.snapped.lng.toFixed(6), (shed.areaM2 * M2_TO_AC).toFixed(2),
    Math.round(shed.L * M_TO_FT), Math.round(shed.Tc * 60), Math.round(shed.CN), r.y ? `${r.y}-yr 24-h` : '', r.P ?? '', r.Q?.toFixed(3) ?? '', r.vol?.toFixed(2) ?? '', r.q?.toFixed(1) ?? ''])));

// ---------------- remove ----------------
document.querySelectorAll('[data-clear]').forEach((b) => b.addEventListener('click', () => {
  if (b.dataset.clear === 'profile' && profile) {
    profSeq++; profile.edit.remove(); if (profile.cursor) map.removeLayer(profile.cursor); profile = null;
    $('profBox').hidden = true; store.set('profile', null);
  }
  if (b.dataset.clear === 'field' && field) {
    fieldSeq++; field.edit.remove(); if (overlay) map.removeLayer(overlay); overlay = null; field = null;
    $('fieldBox').hidden = true; store.set('field', null); renderLegend();
  }
  if (b.dataset.clear === 'shed' && shed) {
    shedSeq++; shed.layers.forEach((l) => map.removeLayer(l)); shed = null;
    $('shedBox').hidden = true; store.set('shed', null);
  }
  $('intro').hidden = !!(profile || field || shed);
}));

function download(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' })); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ---------------- restore last session ----------------
const toLL = (a) => (Array.isArray(a) ? a.filter((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite)).map(([a1, b1]) => L.latLng(a1, b1)) : []);
{
  const f = toLL(store.get('field')), p = toLL(store.get('profile'));
  if (f.length >= 3) setField(f);
  if (p.length >= 2) setProfile(p);
  const o = toLL([store.get('shed')].filter(Boolean));
  if (o.length) setShed(o[0]);
  if (store.get('relief')) { $('relief').checked = true; $('reliefOpts').hidden = false; loadRelief(); }
}

// Test hook (read-only state + programmatic drawing).
window.__fg = { map, setField, setProfile, setShed, get shed() { return shed; }, get field() { return field; }, get profile() { return profile; }, get relief() { return relief; }, get busy() { return busy; } };
