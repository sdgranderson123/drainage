import { toLocal, pointInPolygon, polygonArea, fitPlane, planeFromSlope, slopeOf, designZ, volumes, balance,
  profileStats, quantile, hillshade, rampColor, toCSV, parseLatLon, M_TO_FT, M3_TO_YD3, M2_TO_AC } from './earthwork.js';
import { fetchDEM as fetchLidar, sample, pointElevation, geocode, lidarSource, robustFetch } from './dem.js';
import { readSurvey, epsgDef, utmEPSG, transformFor, surveyExtent, gridSurvey, Delaunator, loadProj4, crsTable, scanFolder } from './surveyio.js';
import { detectCRS, prjToNotes } from './crs.js';
import { compareSurfaces, mainCluster } from './survey.js';
import { fillDepressions, d8, accumulate, snapOutlet, watershed, flowPath, scsRunoff, tcLag, tcKirpich, tr55Peak, LAND_USE } from './hydro.js';
import { openStorm } from './storm3d.js';
import { applyEdits, rasterPolygon, surfaceDiff, exitPoints, groupExits, wetlandOverlap, cellLatLon } from './design.js';

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
// Status shows in the panel and, while working or on error, in a card on the map where the user is looking.
let lastAction = null;
function status(msg, err = false) {
  $('status').textContent = msg || ''; $('status').classList.toggle('err', !!err);
  if (busy && msg && !err) showMapMsg(msg, 'busy');
}
function showMapMsg(msg, kind) {
  const el = $('mapmsg');
  if (!msg) { el.hidden = true; return; }
  el.hidden = false; el.className = `mapmsg ${kind}`;
  $('mapmsgText').textContent = msg;
  $('mapmsgRetry').hidden = kind !== 'err' || !lastAction;
}
$('mapmsgClose').onclick = () => showMapMsg('');
$('mapmsgRetry').onclick = () => { const a = lastAction; showMapMsg(''); a?.(); };
async function withBusy(fn, retry) {
  busy++; $('progress').hidden = false; showMapMsg('Working…', 'busy');
  if (retry) lastAction = retry;
  try { const r = await fn(); return r; }
  catch (e) { if (e.name !== 'AbortError') { status(e.message || String(e), true); showMapMsg(e.message || String(e), 'err'); console.warn(e); } }
  finally { if (--busy === 0) { $('progress').hidden = true; if (!$('mapmsg').classList.contains('err') && !$('mapmsg').classList.contains('info')) showMapMsg(''); } }
}
function hint(msg) { showMapMsg(msg, 'info'); }

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

// ---------------- survey import ----------------
// A loaded survey replaces lidar elevations wherever it has coverage, in every grid the app fetches.
let survey = null, surveyLayers = [];
async function fetchDEM(bounds, opts) {
  const dem = await fetchLidar(bounds, opts);
  if (survey) await burnSurvey(dem);
  return dem;
}
async function burnSurvey(dem) {
  const ex = survey.extent;
  if (ex.n < dem.s || ex.s > dem.n || ex.e < dem.w || ex.w > dem.e) return;
  const g = gridSurvey(dem, survey.sv, survey.tf.toLL, survey.tf.zScale, await Delaunator(), { maxEdgeM: survey.maxEdgeM });
  dem.lidar = Float32Array.from(dem.data); dem.svMask = new Uint8Array(dem.W * dem.H);
  for (let i = 0; i < g.z.length; i++) if (g.z[i] === g.z[i]) { dem.data[i] = g.z[i]; dem.svMask[i] = 1; }
  dem.surveyCells = g.cells;
}
$('bSurvey').onclick = () => { $('svBox').hidden = false; $('svBox').scrollIntoView({ behavior: 'smooth', block: 'start' }); $('intro').hidden = true; };
$('svFile').onchange = () => {
  const f = $('svFile').files[0]; if (!f) return;
  const isPts = !/\.(las|laz|dxf|xml|landxml|dwg)$/i.test(f.name);
  $('svOrderRow').hidden = !isPts;
};
$('svCrs').onchange = () => { $('svEpsg').hidden = $('svCrs').value !== 'epsg'; };
try { const e = localStorage.getItem('fg:lastEpsg'); if (e) $('svEpsg').value = e; } catch { /* ignore */ }
$('svLoad').onclick = () => importSurvey();
// 3D from the Survey & design card: use the field outline if there is one, otherwise the drawing's site boundary
// (fence / boundary / largest closed outline) or the extent of the design surface or survey.
// Pick a site outline from what was loaded: a closed shape (fence/boundary layers first), a fence/boundary
// polyline that nearly closes, else a rectangle around the drawing (or the design/survey extent).
function autoOutline() {
  const SITE = /FENCE|BOUND|LIMIT|SITE|PROP|ROW|PARCEL/i;
  let best = null;
  const consider = (ring, name, closedFlag) => {
    if (ring.length < 3) return;
    const a = areaOf(ring); if (!(a > 50)) return; // ignore symbols / tiny shapes
    const score = a * (SITE.test(name) ? 4 : 1) * (closedFlag ? 1 : 0.9);
    if (!best || score > best.score) best = { score, pts: ring.slice(), name };
  };
  if (cad) for (const [name, l] of Object.entries(cad.layers)) l.group.eachLayer((sh) => {
    if (sh instanceof L.Polygon) { consider(sh.getLatLngs()[0], name, true); return; }
    if (!SITE.test(name)) return;
    // Open polyline on a site layer: treat as closed when its ends are close relative to its length.
    const pts = sh.getLatLngs(); if (pts.length < 3) return;
    let len = 0; for (let k = 1; k < pts.length; k++) len += map.distance(pts[k - 1], pts[k]);
    if (map.distance(pts[0], pts[pts.length - 1]) <= Math.max(3, len * 0.4)) consider(pts, name, false); // gate gaps, or a side left open
  });
  if (best) return { pts: best.pts, from: `the ${best.name} outline` };
  let b = cad?.bounds;
  const ext = (designSurf || survey)?.extent;
  if (!b && ext) b = L.latLngBounds([[ext.s, ext.w], [ext.n, ext.e]]);
  if (!b) return null;
  b = b.pad(0.1);
  return { pts: [b.getNorthWest(), b.getNorthEast(), b.getSouthEast(), b.getSouthWest()], from: cad?.bounds ? 'the extent of the drawing' : 'the extent of the surface' };
}
async function ensureField() {
  if (field?.dem && design) return true;
  if (!field) {
    const o = autoOutline();
    if (!o) { hint('Load a drawing or surface, or outline the site with Field cut & fill.'); return false; }
    setField(o.pts);
    hint(`Site outline taken from ${o.from}. Drag the white corner handles to adjust it.`);
  }
  for (let k = 0; k < 600 && !(field?.dem && design && busy === 0); k++) await new Promise((r) => setTimeout(r, 200));
  return !!(field?.dem && design);
}
$('sv3dStorm').onclick = async () => { if (await ensureField()) openDesignStorm(); };
$('sv3d').onclick = async () => { if (await ensureField()) openDesignStorm({ autoplay: false }); };
// Folder picking needs webkitdirectory (desktop Chrome/Edge/Firefox/Safari). Elsewhere fall back to picking files.
if (!('webkitdirectory' in document.createElement('input')) || /iPhone|iPad|iPod/.test(navigator.userAgent)) {
  $('svFolder').removeAttribute('webkitdirectory');
  $('svScanLbl').firstChild.textContent = 'Scan files… ';
  $('svScanHelp').textContent = 'This device can’t pick a whole folder. Select the files instead (hold to select several).';
}
$('svFolder').onchange = async () => {
  const files = [...$('svFolder').files];
  if (!files.length) { $('svScanResult').innerHTML = '<div class="warn">The browser returned no files. If it asked to “Upload” the folder, choose Upload (nothing is sent anywhere).</div>'; return; }
  $('svScanResult').innerHTML = `<div>Reading ${files.length.toLocaleString()} files…</div>`;
  await withBusy(async () => {
    status(`Searching ${files.length.toLocaleString()} files…`);
    const { found, notes } = await scanFolder(files);
    folderNotes = notes;
    if (!found.length) { $('svScanResult').innerHTML = '<div class="warn">No survey, lidar or drawing files found in that folder.</div>'; status(''); return; }
    const label = { las: 'Lidar (LAS)', laz: 'Lidar (LAZ)', landxml: 'LandXML', points: 'Point file', dxf: 'DXF drawing', dwg: 'DWG drawing', prj: 'Coordinate system (.prj)' };
    const order = ['las', 'laz', 'landxml', 'points', 'dxf', 'dwg', 'prj'];
    found.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.path.localeCompare(b.path));
    const mb = (n) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.ceil(n / 1e3)} KB`);
    $('svScanResult').innerHTML = `<div><b>Found ${found.filter((f) => f.kind !== 'prj').length} usable files</b>${notes.length ? ` and coordinate clues: “${prjToNotes(notes[0]).slice(0, 120)}”` : ''}.</div>
      <ul class="scanlist">${found.map((f, k) => `<li><label><input type="checkbox" data-scan="${k}" ${f.kind === 'prj' ? 'disabled' : ['las', 'laz', 'landxml', 'points'].includes(f.kind) ? 'checked' : ''}>
        <span><b>${label[f.kind]}</b> ${f.path}<small> · ${mb(f.size)}${f.epsg ? ` · EPSG:${f.epsg}` : ''}${f.note ? ` · ${f.note.replace(/</g, '&lt;').slice(0, 80)}` : ''}</small></span></label></li>`).join('')}</ul>
      <div class="row"><button type="button" class="btn primary" id="svLoadScan">Load checked files</button></div>`;
    $('svLoadScan').onclick = () => importSurvey([...$('svScanResult').querySelectorAll('[data-scan]:checked')].map((cb) => found[+cb.dataset.scan].file));
    status('');
  });
};
$('svRemove').onclick = () => {
  $('svNext').hidden = true; for (const e of [survey, designSurf]) (e?.layers || []).forEach((l) => map.removeLayer(l)); survey = null; designSurf = null; clearCad(); $('svResult').innerHTML = ''; $('svRemove').hidden = true; reloadAllSurfaces(); };
let designSurf = null, cad = null;
let folderNotes = [];
async function importSurvey(filesOverride) {
  const files = filesOverride || [...$('svFile').files];
  if (!files.length) { status('Choose a file first.', true); return; }
  const role = $('svRole').value;
  await withBusy(async () => {
    const parsed = [];
    for (const f of files) { status(`Reading ${f.name}…`); parsed.push(await readSurvey(f, { order: $('svOrder').value, onProgress: (m) => status(m) })); }
    // Coordinate system: from a file, a typed EPSG code, or UTM for the map location.
    let code = null, how = '';
    const pick = $('svCrs').value, notes = parsed.flatMap((p) => p.crsNotes || []);
    if (pick === 'epsg') { code = parseInt($('svEpsg').value, 10); how = 'entered'; if (!code) throw new Error('Enter the EPSG code of the coordinate system.' + (notes.length ? ` The drawing says: “${notes[0]}”.` : '')); }
    else if (pick === 'utm') { code = utmEPSG(map.getCenter().lng); how = 'UTM for the map location'; }
    else { const p = parsed.find((x) => x.epsg); if (p) { code = p.epsg; how = 'read from the file'; } }
    let guess = null;
    if (!code) {
      // Work it out: try every US state plane / UTM / regional system and keep the ones that put the data in
      // their own area of use, ranked by the drawing notes, the folder's .prj files, state/county and the map.
      status('Working out the coordinate system…');
      const xy = sampleXY(parsed);
      if (!xy.length) throw new Error('No coordinates found to place on the map.');
      const notesAll = [...notes, ...folderNotes.map(prjToNotes)].join(' . ');
      const c = map.getCenter(), cands = detectCRS(xy, await crsTable(), await loadProj4(), { notes: notesAll, lat: c.lat, lon: c.lng, state: $('svState').value.trim(), county: $('svCounty').value.trim() });
      if (!cands.length) throw new Error('These coordinates don’t fit any US state plane or UTM system. They may be on a local (assumed) grid; the surveyor would need to provide the transformation.');
      guess = cands; code = cands[0].code;
      how = cands[0].why.length ? `auto-detected from ${cands[0].why.join(', ')}` : cands[0].km != null && cands[0].km < 30 ? 'auto-detected: lands where the map is' : 'best guess: please confirm';
      $('svEpsg').value = String(code);
    }
    try { localStorage.setItem('fg:lastEpsg', String(code)); } catch { /* ignore */ }
    status(`Looking up EPSG:${code}…`);
    const def = await epsgDef(code), tf = await transformFor(def, $('svZ').value), maxEdgeM = (+$('svEdge').value || 200) * 0.3048;
    // CAD linework from every drawing, in one overlay.
    const lw = parsed.filter((p) => p.linework);
    if (lw.length) { setCad(lw, tf, files.map((f) => f.name)); cad.src = { lw: lw.map((p) => ({ linework: p.linework })), def, code }; }
    // Elevations: merge all files that carry 3D data.
    const withZ = parsed.filter((p) => p.xyz.length >= 9);
    const msgs = [];
    if (role !== 'linework' && withZ.length) {
      const n = withZ.reduce((a, p) => a + p.xyz.length, 0), xyz = new Float64Array(n); let o = 0;
      const faces = [], kind = withZ.some((p) => p.kind === 'cloud') ? 'cloud' : withZ.length === 1 && withZ[0].faces ? 'tin' : 'points';
      for (const p of withZ) { if (kind === 'tin') faces.push(...p.faces); xyz.set(p.xyz, o); o += p.xyz.length; }
      const sv = { xyz, faces: kind === 'tin' ? Uint32Array.from(faces) : null, kind, note: withZ.map((p) => p.note).filter(Boolean).join('; ') };
      const extent = surveyExtent(sv, tf.toLL);
      if (!(Math.abs(extent.lat) <= 90 && Math.abs(extent.lon) <= 180) || extent.n - extent.s > 2 || extent.e - extent.w > 2)
        throw new Error(`With EPSG:${code} the points land in an impossible place. The coordinate system is probably wrong.`);
      const entry = { sv, tf, extent, code, def, maxEdgeM, zUnits: $('svZ').value, name: withZ.map((p) => p.name).join(', ') };
      status('Comparing with USGS lidar…');
      const pad = 0.0005, cmpDem = await fetchLidar({ s: extent.s - pad, n: extent.n + pad, w: extent.w - pad, e: extent.e + pad }, { maxPx: 600, onProgress: (m) => status(m) });
      const g = gridSurvey(cmpDem, sv, tf.toLL, tf.zScale, await Delaunator(), { maxEdgeM });
      entry.cmp = compareSurfaces(g.z, cmpDem.data); entry.coverAc = (g.cells * cmpDem.dx * cmpDem.dy) / 4046.86;
      if (role === 'design') designSurf = entry; else survey = entry;
      drawSurvey(entry, role);
      map.fitBounds([[extent.s, extent.w], [extent.n, extent.e]], { padding: [40, 40], animate: false });
      msgs.push(surveyResultHTML(entry, role, how));
    } else if (role !== 'linework') msgs.push(`<div class="warn">No elevations found in ${files.map((f) => f.name).join(', ')}. Civil 3D surfaces don’t survive a plain DWG/DXF: export the surface with <b>Output → Export to LandXML</b>, or run <b>EXPORTTOAUTOCAD</b> first.</div>`);
    // Missing external references.
    const have = new Set(files.map((f) => f.name.toLowerCase().replace(/\.(dwg|dxf)$/, '')));
    const missing = parsed.flatMap((p) => p.xrefs || []).filter((x) => !have.has(x.name.toLowerCase()) && !have.has((x.path.split(/[\\/]/).pop() || '').toLowerCase().replace(/\.dwg$/, '')));
    if (missing.length) msgs.push(`<div class="warn">This drawing pulls in ${missing.length} external reference${missing.length > 1 ? 's' : ''} that ${missing.length > 1 ? 'were' : 'was'} not included: ${missing.map((x) => `<b>${x.path.split(/[\\/]/).pop() || x.name}</b>`).join(', ')}. The site plan, topo and surfaces usually live there. Add those files too (pick them all at once), or use eTransmit / XREF → Bind in AutoCAD.</div>`);
    if (lw.length && cad) msgs.push(`Drawing linework: ${cad.count.toLocaleString()} shapes on ${Object.keys(cad.layers).length} layers${cad.dropped ? ` (${cad.dropped} legend/title shapes away from the site skipped)` : ''}.`);
    if (guess) msgs.unshift(suggestHTML(guess, code));
    else if (how) msgs.unshift(`<div>Coordinate system EPSG:${code} (${how}).</div>`);
    $('svResult').innerHTML = msgs.join(''); $('svRemove').hidden = false; status('');
    $('svNext').hidden = !(designSurf || cad || survey);
    if (!field && (designSurf || cad)) {
      const o = autoOutline();
      if (o) { setField(o.pts); msgs.push(`<div class="okline">Site outline set from ${o.from}. Drag the white corner handles on the map to adjust it; results update.</div>`); $('svResult').innerHTML = msgs.join(''); }
    }
    const sel = $('svSuggest'); if (sel) sel.onchange = () => { $('svCrs').value = 'epsg'; $('svEpsg').hidden = false; $('svEpsg').value = sel.value; importSurvey(files); };
    if (cad?.bounds && !withZ.length) map.fitBounds(cad.bounds, { padding: [60, 60], maxZoom: 19, animate: false });
    reloadAllSurfaces();
  }, importSurvey);
}
// A few coordinates from whatever was loaded (survey points, else drawing linework).
function sampleXY(parsed) {
  const out = [];
  for (const p of parsed) {
    const n = p.xyz.length / 3; for (let k = 0; k < n && out.length < 40; k += Math.max(1, Math.floor(n / 20))) out.push([p.xyz[k * 3], p.xyz[k * 3 + 1]]);
    if (p.linework && out.length < 40) {
      const m = mainCluster(p.linework, 20000);
      for (const shapes of Object.values(m.layers)) for (const sh of shapes) { out.push(sh.pts[0]); if (out.length >= 40) break; }
    }
  }
  return out;
}
function suggestHTML(c, code) {
  const top = c[0], km = (x) => (x.km == null ? '' : x.km < 1 ? ', where the map is' : `, ${x.km < 10 ? x.km.toFixed(1) : Math.round(x.km)} km from the map`);
  return `<div class="okline"><b>Coordinate system: ${top.name}</b> (EPSG:${code})${top.why.length ? ` — matches ${top.why.join(', ')}` : ''}${km(top)}.
    <label class="small">Not right? Other systems that fit these coordinates:
    <select id="svSuggest">${c.slice(0, 8).map((x) => `<option value="${x.code}"${x.code === code ? ' selected' : ''}>${x.name} (EPSG:${x.code})${km(x)}</option>`).join('')}</select></label></div>`;
}
function surveyResultHTML(entry, role, how) {
  const { sv, code, cmp } = entry, n = sv.xyz.length / 3;
  let html = `<div><b>${role === 'design' ? 'Proposed design' : 'Existing ground'}</b> from ${entry.name}: ${fmt(n)} ${sv.kind === 'cloud' ? 'points' : sv.kind === 'tin' ? 'TIN points' : 'shots'}${sv.note ? ` (${sv.note})` : ''}. EPSG:${code} (${how}). Covers ${entry.coverAc.toFixed(1)} ac.</div>`;
  if (!cmp) return html + '<div class="warn">No lidar to compare against here.</div>';
  const off = cmp.median * M_TO_FT, spread = cmp.mad * M_TO_FT;
  html += `<div>Versus USGS lidar: median ${off >= 0 ? '+' : ''}${off.toFixed(2)} ft, typical spread ±${spread.toFixed(2)} ft.</div>`;
  if (role === 'design') return html + `<div class="okline">Used as the proposed grade. See Site design for cut/fill, drainage paths and Storm 3D with the design.</div>`;
  if (Math.abs(off) > 0.5) return html + `<div class="warn">The survey sits ${Math.abs(off).toFixed(2)} ft ${off > 0 ? 'above' : 'below'} the lidar everywhere: probably a different vertical datum (NAVD88 vs NGVD29 or an assumed benchmark) or wrong Z units.</div>`;
  if (spread > 1) return html + '<div class="warn">Survey and lidar disagree a lot from place to place. The coordinate system may be wrong, or the ground changed since the lidar was flown.</div>';
  return html + '<div class="okline">Matches the lidar closely. Survey elevations now replace lidar inside the pink box.</div>';
}
// ---- CAD linework overlay ----
const CAD_COLORS = ['#e83e8c', '#ff9f1c', '#2ec4b6', '#9b5de5', '#f15bb5', '#00bbf9', '#fee440', '#8ac926', '#ff595e', '#6a4c93'];
function setCad(lw, tf, names) {
  clearCad();
  const layers = {}; let dropped = 0, count = 0;
  for (const p of lw) {
    const m = mainCluster(p.linework, 20000); // shapes over ~4 mi from the drawing's centre are legends / sheets
    dropped += m.dropped;
    for (const [name, shapes] of Object.entries(m.layers)) (layers[name] ||= []).push(...shapes);
  }
  const groups = {}, b = L.latLngBounds([]);
  Object.keys(layers).sort().forEach((name, k) => {
    const color = CAD_COLORS[k % CAD_COLORS.length], g = L.layerGroup();
    for (const s of layers[name]) {
      const ll = s.pts.map(([x, y]) => tf.toLL(x, y)); ll.forEach((p) => b.extend(p)); count++;
      const shape = (s.closed ? L.polygon(ll, { color, weight: 2, fillOpacity: 0.06 }) : L.polyline(ll, { color, weight: 2 }));
      if (s.closed && ll.length >= 3) shape.on('click', (e) => cadPopup(e.latlng, name, ll));
      shape.addTo(g);
    }
    groups[name] = { group: g.addTo(map), color, n: layers[name].length, closed: layers[name].filter((s) => s.closed).length };
  });
  cad = { layers: groups, dropped, count, bounds: b.isValid() ? b : null, names };
  $('cadLayers').innerHTML = Object.entries(groups).map(([name, l]) =>
    `<li><label><input type="checkbox" data-cad="${encodeURIComponent(name)}" checked><span class="sw" style="background:${l.color}"></span>${name}<small>${l.n}${l.closed ? ` · ${l.closed} closed` : ''}</small></label></li>`).join('');
  $('cadLayers').querySelectorAll('[data-cad]').forEach((cb) => cb.onchange = () => { const l = cad.layers[decodeURIComponent(cb.dataset.cad)]; cb.checked ? l.group.addTo(map) : map.removeLayer(l.group); });
  $('cadBox').hidden = !count;
}
function clearCad() { if (cad) Object.values(cad.layers).forEach((l) => map.removeLayer(l.group)); cad = null; $('cadBox').hidden = true; }
$('cadAll').onclick = () => cad && $('cadLayers').querySelectorAll('[data-cad]').forEach((cb) => { if (!cb.checked) { cb.checked = true; cb.onchange(); } });
$('cadNone').onclick = () => cad && $('cadLayers').querySelectorAll('[data-cad]').forEach((cb) => { if (cb.checked) { cb.checked = false; cb.onchange(); } });
function cadPopup(at, layer, ll) {
  if (draw.mode) return;
  const area = areaOf(ll.map(([a, b]) => L.latLng(a, b))) * M2_TO_AC;
  const pop = L.popup({ maxWidth: 240 }).setLatLng(at).setContent(`<div class="cadpop"><b>${layer}</b><span>${area.toFixed(2)} ac closed shape</span>
    <button type="button" data-act="field">Use as field outline</button><button type="button" data-act="rock">Rock surfacing area</button>
    <button type="button" data-act="grade">Raise / lower this area</button><button type="button" data-act="pond">Make a pond here</button></div>`).openOn(map);
  pop.getElement().querySelectorAll('[data-act]').forEach((btn) => btn.onclick = () => {
    const pts = ll.map(([a, b]) => L.latLng(a, b)), act = btn.dataset.act; map.closePopup();
    if (act === 'field') setField(pts);
    else if (!field?.dem) hint('Set a field outline first (click the fence or site boundary and choose “Use as field outline”).');
    else addEdit(act, pts);
  });
}
function drawSurvey(entry, role) {
  (entry.layers || []).forEach((l) => map.removeLayer(l)); entry.layers = [];
  const { sv, tf, extent } = entry, n = sv.xyz.length / 3, col = role === 'design' ? '#00a36c' : '#e83e8c';
  entry.layers.push(L.rectangle([[extent.s, extent.w], [extent.n, extent.e]], { color: col, weight: 2, dashArray: '6 4', fill: false, interactive: false }).addTo(map));
  if (n <= 3000 && sv.kind !== 'cloud') {
    const g = L.layerGroup();
    for (let k = 0; k < n; k++) { const [la, lo] = tf.toLL(sv.xyz[k * 3], sv.xyz[k * 3 + 1]); L.circleMarker([la, lo], { radius: 2.5, color: col, weight: 1, fillOpacity: 0.9, interactive: false }).addTo(g); }
    entry.layers.push(g.addTo(map));
  }
}
// After a survey change, reload every surface so results use the new elevations.
function reloadAllSurfaces() {
  if (relief) { clearRelief(); if (reliefWanted()) loadRelief(); }
  flow = null;
  if (profile) { profile.dem = null; computeProfile(); }
  if (field) { field.dem = null; loadField(); }
  if (shed) { computeShed(); }
}

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
function fromSurvey(d, lat, lng) {
  if (!d.svMask) return false;
  const x = Math.floor(((lng - d.w) / (d.e - d.w)) * d.W), y = Math.floor(((d.n - lat) / (d.n - d.s)) * d.H);
  return x >= 0 && y >= 0 && x < d.W && y < d.H && d.svMask[y * d.W + x] === 1;
}
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
    if (Number.isFinite(z)) { $('hover').textContent = `${at} · ${ft(z)} ft${fromSurvey(d, lat, lng) ? ' (survey)' : ''}${cutFillAt(lat, lng, z)}`; return; }
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
  pond: { btn: 'bPond', title: 'Retention pond', hint: 'Click the corners of the pond.', min: 3 },
  grade: { btn: 'bGrade', title: 'Raise / lower area', hint: 'Click the corners of the area to adjust.', min: 3 },
  rock: { btn: 'bRock', title: 'Rock surfacing area', hint: 'Click the corners of the rock area.', min: 3 },
  tile: { btn: 'bTile', title: 'Drain tile', hint: 'Click along the tile line, outlet end last or first.', min: 2 },
  shed: { btn: 'bShed', title: 'Drainage outlet', hint: 'Click the culvert, tile outlet or ditch point the water drains to.', min: 1 } };
function startDraw(mode) {
  cancelDraw();
  draw.mode = mode; draw.pts = [];
  $(TOOL[mode].btn).setAttribute('aria-pressed', 'true');
  $('dbTitle').textContent = TOOL[mode].title; $('dbHint').textContent = TOOL[mode].hint;
  $('drawbar').hidden = false; map.getContainer().style.cursor = 'crosshair'; map.getContainer().classList.add('drawing');
  $('bUndo').hidden = $('bDone').hidden = mode === 'shed';
  if (mode === 'shed') showChannels();
  updateDraw();
}
function cancelDraw() {
  if (!draw.mode) return;
  $(TOOL[draw.mode].btn).setAttribute('aria-pressed', 'false');
  for (const l of [draw.line, draw.ghost, ...draw.markers]) if (l) map.removeLayer(l);
  Object.assign(draw, { mode: null, pts: [], line: null, ghost: null, markers: [] });
  $('drawbar').hidden = true; map.getContainer().style.cursor = ''; map.getContainer().classList.remove('drawing');
}
function pathLength(pts) { let d = 0; for (let i = 1; i < pts.length; i++) d += map.distance(pts[i - 1], pts[i]); return d; }
function areaOf(pts) {
  const lat0 = pts[0].lat, lon0 = pts[0].lng;
  return polygonArea(pts.map((p) => { const q = toLocal(p.lat, p.lng, lat0, lon0); return [q.x, q.y]; }));
}
function measureText(mode, pts) {
  if (mode === 'shed') return 'Tap the culvert or channel. It snaps to the nearest blue channel.';
  if (mode === 'tile') return pts.length > 1 ? `${fmt(pathLength(pts) * M_TO_FT)} ft of tile` : 'Click the start of the tile line.';
  if (mode === 'pond' || mode === 'grade' || mode === 'rock') return pts.length > 2 ? `${(areaOf(pts) * M2_TO_AC).toFixed(2)} ac` : `${pts.length} corner${pts.length === 1 ? '' : 's'}`;
  if (mode === 'profile') return pts.length > 1 ? `${pts.length} points · ${fmt(pathLength(pts) * M_TO_FT)} ft` : `${pts.length} point${pts.length === 1 ? '' : 's'}`;
  return pts.length > 2 ? `${pts.length} corners · ${(areaOf(pts) * M2_TO_AC).toFixed(2)} ac` : `${pts.length} corner${pts.length === 1 ? '' : 's'}`;
}
function updateDraw(cursor) {
  const { mode, pts } = draw; if (!mode) return;
  const shown = cursor ? [...pts, cursor] : pts;
  if (draw.line) map.removeLayer(draw.line);
  draw.line = (mode === 'field' || mode === 'pond' || mode === 'grade' || mode === 'rock') && shown.length > 2
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
  if (e.target.closest('input, textarea, select') || dlg.open) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && !draw.mode && (e.key === 'z' || e.key === 'Z') && !e.shiftKey) { e.preventDefault(); undo(); return; }
  if (mod && !draw.mode && (e.key === 'y' || ((e.key === 'z' || e.key === 'Z') && e.shiftKey))) { e.preventDefault(); redo(); return; }
  if (mod && (e.key === 's' || e.key === 'S')) { e.preventDefault(); $('pjSave').click(); return; }
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
  if (mode === 'pond' || mode === 'grade' || mode === 'tile' || mode === 'rock') { addEdit(mode, pts); return; }
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
  profile = { pts, edit: editable(pts.slice(), false, (p) => { profile.pts = p; store.set('profile', p.map((q) => [q.lat, q.lng])); computeProfile(); commitSoon(); }), rows: [], dem: null, cursor: null };
  commitSoon();
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
        const zp = design && field?.dem && designChanged() ? sample({ ...field.dem, data: design.z }, lat, lon) : NaN;
        rows.push({ d: dist + seg * t, lat, lon, z: sample(profile.dem, lat, lon), zp });
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
  const st = profile.stats; let lo = st.lo * M_TO_FT, hi = st.hi * M_TO_FT;
  for (const r of profile.rows) if (Number.isFinite(r.zp)) { lo = Math.min(lo, r.zp * M_TO_FT); hi = Math.max(hi, r.zp * M_TO_FT); }
  const pad = Math.max(0.25, (hi - lo) * 0.08);
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
  // Proposed grade along the same line (where the design covers it), with cut/fill shading between the two.
  if (rows.some((r) => Number.isFinite(r.zp) && Math.abs(r.zp - r.z) > 0.003)) {
    for (let k = 1; k < rows.length; k++) {
      const a = rows[k - 1], b = rows[k]; if (!(Number.isFinite(a.zp) && Number.isFinite(b.zp) && Number.isFinite(a.z) && Number.isFinite(b.z))) continue;
      g.beginPath(); g.moveTo(X(a.d), Y(a.z * M_TO_FT)); g.lineTo(X(b.d), Y(b.z * M_TO_FT)); g.lineTo(X(b.d), Y(b.zp * M_TO_FT)); g.lineTo(X(a.d), Y(a.zp * M_TO_FT)); g.closePath();
      g.fillStyle = (a.zp + b.zp) > (a.z + b.z) ? 'rgba(45,104,196,0.35)' : 'rgba(200,66,58,0.35)'; g.fill();
    }
    g.strokeStyle = '#e07b00'; g.lineWidth = 2.5; g.beginPath(); let on = false;
    for (const r of rows) { if (!Number.isFinite(r.zp)) { on = false; continue; } (on ? g.lineTo : g.moveTo).call(g, X(r.d), Y(r.zp * M_TO_FT)); on = true; }
    g.stroke();
    $('profKey').hidden = false;
  } else $('profKey').hidden = true;
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
  $('profTip').textContent = Number.isFinite(r.z) ? `${fmt(r.d * M_TO_FT)} ft along · ${ft(r.z)} ft existing${Number.isFinite(r.zp) && Math.abs(r.zp - r.z) > 0.003 ? ` · ${ft(r.zp)} ft proposed (${r.zp > r.z ? 'fill' : 'cut'} ${ft(Math.abs(r.zp - r.z))} ft)` : ''}` : `${fmt(r.d * M_TO_FT)} ft along · no lidar`;
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
  const oldDem = field?.dem;
  field?.edit.remove();
  field = { pts, dem: oldDem, edit: editable(pts.slice(), true, (p) => { field.pts = p; store.set('field', p.map((q) => [q.lat, q.lng])); loadField(); commitSoon(); }) };
  commitSoon();
  store.set('field', pts.map((p) => [p.lat, p.lng]));
  $('intro').hidden = true;
  loadField();
}
let fieldSeq = 0;
function loadField() {
  const seq = ++fieldSeq, poly = field.pts;
  withBusy(async () => {
    // Load the surroundings too (30% each side) so flow paths and storms show where water goes off the field.
    const b = L.latLngBounds(poly), pad = Math.max(0.0006, Math.max(b.getNorth() - b.getSouth(), b.getEast() - b.getWest()) * 0.3);
    const dem = (field.dem && L.latLngBounds([[field.dem.s, field.dem.w], [field.dem.n, field.dem.e]]).pad(-0.12).contains(b)) ? field.dem
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
    const mask = new Uint8Array(dem.W * dem.H); for (const c of cells) mask[c.j * dem.W + c.i] = 1;
    const newDem = field.dem !== dem;
    Object.assign(field, { dem, cells, cellArea, P, mask, origin: [lat0, lon0], area: polygonArea(P), coverage: cells.length / Math.max(1, inside) });
    $('fieldBox').hidden = false; $('sdBox').hidden = false;
    computeField(); status('');
    refreshDesign();
    if (newDem || !field.wet) loadWetlands(); else showWetlandResult();
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
$('fieldStorm').onclick = () => openDesignStorm();
$('exCsv').onclick = () => field?.cells && download('field-existing.csv', toCSV(['lat', 'lon', 'elev_ft'],
  field.cells.map((p) => [p.lat.toFixed(7), p.lon.toFixed(7), ft(p.z, 3)])));
$('deCsv').onclick = () => field?.plane && download('field-design.csv', toCSV(['lat', 'lon', 'existing_ft', 'design_ft', 'cut_fill_ft'],
  field.cells.map((p) => { const d = designZ(field.plane, p.x, p.y); return [p.lat.toFixed(7), p.lon.toFixed(7), ft(p.z, 3), ft(d, 3), ft(p.z - d, 3)]; })));

// ---------------- site design: flow paths, edits, wetlands ----------------
const EDIT_COLORS = { pond: '#2d68c4', grade: '#e07b00', tile: '#7a3cc8', rock: '#8a8a8a' };
const EDIT_LABEL = { pond: 'Pond', grade: 'Raise / lower', tile: 'Drain tile', rock: 'Rock surfacing' };
let edits = (store.get('edits') || []).filter((e) => e && Array.isArray(e.pts));
let designLayers = [], editLayers = [], wetLayer = null, design = null, designSeq = 0;
function saveEdits() { store.set('edits', edits); commitSoon(); }
function clearDesignLayers() { [...designLayers, ...editLayers].forEach((l) => map.removeLayer(l)); designLayers = []; editLayers = []; if (wetLayer) map.removeLayer(wetLayer); wetLayer = null; }
['bPond', 'bGrade', 'bTile', 'bRock'].forEach((id) => { $(id).onclick = () => {
  if (!field?.dem) { hint('Outline the field first (Field cut & fill), then add ponds, tile or grading inside it.'); return; }
  const m = { bPond: 'pond', bGrade: 'grade', bTile: 'tile', bRock: 'rock' }[id]; draw.mode === m ? cancelDraw() : startDraw(m);
}; });
$('bWhole').onclick = () => { if (field?.pts) addEdit('grade', field.pts.slice()); };
function addEdit(type, pts) {
  const e = { type, pts: pts.map((p) => [p.lat, p.lng]), id: Date.now().toString(36) };
  if (type === 'pond') Object.assign(e, { depthFt: 4, sideSlope: 3 });
  if (type === 'grade') Object.assign(e, { mode: 'offset', valueFt: 1 });
  if (type === 'tile') Object.assign(e, { depthFt: 4, diaIn: 6 });
  if (type === 'rock') Object.assign(e, { depthIn: 9, tonsPerYd: 1.4 });
  edits.push(e); saveEdits(); refreshDesign();
}
const surfaceMode = () => document.querySelector('input[name=surf]:checked').value;
document.querySelectorAll('input[name=surf]').forEach((r) => r.addEventListener('change', () => refreshDesign()));
$('showFlow').onchange = () => refreshDesign();
$('showWet').onchange = () => { if (wetLayer) (($('showWet').checked) ? wetLayer.addTo(map) : map.removeLayer(wetLayer)); };
function renderEditList() {
  const label = EDIT_LABEL;
  $('editList').innerHTML = edits.map((e, k) => {
    const inf = design?.info[k] || {};
    let fields = '', stat = '';
    if (e.type === 'pond') {
      fields = `<label>Depth, ft<input data-k="${k}" data-f="depthFt" type="number" min="1" max="30" step="0.5" value="${e.depthFt}"></label>
        <label>Side slope, H:1<input data-k="${k}" data-f="sideSlope" type="number" min="1" max="10" step="0.5" value="${e.sideSlope}"></label>`;
      if (inf.cells) stat = `${(inf.areaM2 * M2_TO_AC).toFixed(2)} ac · bottom ${ft(inf.bottom, 1)} ft · storage ${(inf.storageM3 / 1233.48).toFixed(2)} ac-ft · dig ${fmt(inf.excavationM3 * M3_TO_YD3)} yd³`;
    } else if (e.type === 'grade') {
      fields = `<label>Change<select data-k="${k}" data-f="mode"><option value="offset"${e.mode === 'offset' ? ' selected' : ''}>Raise/lower by, ft</option><option value="elev"${e.mode === 'elev' ? ' selected' : ''}>Set to elevation, ft</option></select></label>
        <label>Value<input data-k="${k}" data-f="valueFt" type="number" step="0.1" value="${e.valueFt}"></label>`;
      if (inf.cells) stat = `${(inf.areaM2 * M2_TO_AC).toFixed(2)} ac · cut ${fmt(inf.cutM3 * M3_TO_YD3)} yd³ · fill ${fmt(inf.fillM3 * M3_TO_YD3)} yd³`;
    } else if (e.type === 'rock') {
      fields = `<label>Depth, in<input data-k="${k}" data-f="depthIn" type="number" min="1" max="36" step="1" value="${e.depthIn}"></label>
        <label>Tons per yd³<input data-k="${k}" data-f="tonsPerYd" type="number" min="1" max="2" step="0.05" value="${e.tonsPerYd}"></label>`;
      if (inf.cells) { const yd = (inf.areaM2 * (e.depthIn * 0.0254)) * M3_TO_YD3; stat = `${fmt(inf.areaM2 * 10.7639)} ft² (${(inf.areaM2 * M2_TO_AC).toFixed(2)} ac) · ${fmt(yd)} yd³ · ${fmt(yd * e.tonsPerYd)} tons`; }
    } else {
      fields = `<label>Diameter<select data-k="${k}" data-f="diaIn">${[4, 5, 6, 8, 10, 12, 15, 18].map((d) => `<option value="${d}"${+e.diaIn === d ? ' selected' : ''}>${d} in</option>`).join('')}</select></label>
        <label>Depth, ft<input data-k="${k}" data-f="depthFt" type="number" min="2" max="10" step="0.5" value="${e.depthFt}"></label>`;
      if (inf.cells?.length) stat = `${fmt(inf.lengthM * M_TO_FT)} ft at ${(inf.slope * 100).toFixed(2)}% · carries ${inf.capacityCfs.toFixed(2)} cfs · serves ~${Math.round(inf.acresServed)} ac at 3/8 in/day`;
    }
    return `<li class="edit"><div class="edhead"><span class="sw" style="background:${EDIT_COLORS[e.type]}"></span><b>${label[e.type]} ${k + 1}</b>
      <button type="button" class="link" data-del="${k}">Remove</button></div><div class="grid2">${fields}</div><div class="small muted">${stat || '—'}</div></li>`;
  }).join('') || '<li class="small muted">No changes yet. Add a pond, raise or lower an area, or lay drain tile.</li>';
  $('editList').querySelectorAll('[data-del]').forEach((b) => b.onclick = () => { edits.splice(+b.dataset.del, 1); saveEdits(); refreshDesign(); });
  $('editList').querySelectorAll('[data-f]').forEach((el) => el.onchange = () => {
    const e = edits[+el.dataset.k], f = el.dataset.f; e[f] = f === 'mode' ? el.value : parseFloat(el.value); saveEdits(); refreshDesign();
  });
}
function drawEditShapes() {
  editLayers.forEach((l) => map.removeLayer(l)); editLayers = [];
  edits.forEach((e, k) => {
    const c = EDIT_COLORS[e.type];
    const lyr = e.type === 'tile' ? L.polyline(e.pts, { color: c, weight: 4, dashArray: '2 6' }) : L.polygon(e.pts, { color: c, weight: 2, fillOpacity: e.type === 'pond' ? 0.35 : 0.12 });
    lyr.bindTooltip(`${EDIT_LABEL[e.type]} ${k + 1}`);
    editLayers.push(lyr.addTo(map));
    const inf = design?.info[k];
    if (e.type === 'tile' && inf?.outlet != null) editLayers.push(L.circleMarker(cellLatLon(field.dem, inf.outlet), { radius: 6, color: '#fff', weight: 2, fillColor: c, fillOpacity: 1 }).bindTooltip('Tile outlet').addTo(map));
  });
}
// Rebuild the design surface, flow paths, exits and the summary. Heavy steps run after a paint.
function refreshDesign() {
  if (!field?.dem) return;
  const seq = ++designSeq;
  withBusy(async () => {
    status('Updating drainage paths…'); await new Promise((r) => setTimeout(r, 30));
    const { dem, mask } = field;
    design = applyEdits(dem, dem.data, edits);
    // Proposed design surface (FG): replaces the grade where it covers; later edits are on top of it.
    if (designSurf) {
      const g = gridSurvey(dem, designSurf.sv, designSurf.tf.toLL, designSurf.tf.zScale, await Delaunator(), { maxEdgeM: designSurf.maxEdgeM });
      const base = applyEdits(dem, Float32Array.from(dem.data).map((v, i) => (g.z[i] === g.z[i] ? g.z[i] : v)), edits);
      design = { ...base, fgCells: g.cells };
    }
    if (seq !== designSeq) return;
    const surf = surfaceMode() === 'design' ? design.z : dem.data;
    const fl = fillDepressions(surf, dem.W, dem.H), rec = d8(fl, dem.W, dem.H, dem.dx, dem.dy);
    // Accumulate only water that starts on the field, so paths show the field's drainage and where it goes after.
    const fromField = accumulate(rec, dem.W * dem.H, mask);
    const exits = groupExits(exitPoints(mask, rec, dem.W), dem.W, dem.dx, dem.dy, Math.max(20, Math.sqrt(field.area) * 0.2));
    if (seq !== designSeq) return;
    Object.assign(design, { rec, fromField, exits });
    designLayers.forEach((l) => map.removeLayer(l)); designLayers = [];
    if ($('showFlow').checked) {
      const ac = (dem.dx * dem.dy) / 4046.86, thr = Math.max(0.25, field.area * M2_TO_AC * 0.01) / ac;
      designLayers.push(L.imageOverlay(flowImage(dem, fromField, thr, mask), [[dem.s, dem.w], [dem.n, dem.e]], { opacity: 0.95, interactive: false }).addTo(map));
      const total = field.cells.length;
      exits.filter((x) => x.cells / total >= 0.05).slice(0, 6).forEach((x) => {
        const pct = (100 * x.cells) / total, acres = x.cells * ac;
        const m = L.marker(cellLatLon(dem, x.i), { icon: L.divIcon({ className: 'exit', html: `<span>${Math.round(pct)}%</span>`, iconSize: [34, 34] }), keyboard: false })
          .bindTooltip(`${acres.toFixed(1)} ac (${pct.toFixed(0)}% of the field) drains off here`).addTo(map);
        designLayers.push(m);
      });
    }
    drawEditShapes(); renderEditList(); designSummary();
    if (profile?.stats) computeProfile();
    field.edit.shape.bringToFront();
    status('');
  }, refreshDesign);
}
function flowImage(dem, acc, thr, mask) {
  const W = dem.W, H = dem.H, c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d'), im = g.createImageData(W, H);
  const px = Math.max(1, Math.round(W / Math.max(300, map.getSize().x)));
  let mx = 0; for (let i = 0; i < W * H; i++) if (acc[i] > mx) mx = acc[i];
  for (let i = 0; i < W * H; i++) {
    if (acc[i] < thr) continue;
    const t = Math.min(1, Math.log(acc[i] / thr) / Math.log(Math.max(2, mx / thr))), r = px * (t > 0.66 ? 3 : t > 0.33 ? 2 : 1);
    const x0 = i % W, y0 = (i / W) | 0, off = !mask[i];
    for (let y = Math.max(0, y0 - r); y <= Math.min(H - 1, y0 + r); y++) for (let x = Math.max(0, x0 - r); x <= Math.min(W - 1, x0 + r); x++) {
      const k = (y * W + x) * 4; if (im.data[k + 3] === 255) continue;
      // inside the field: blue; after leaving it: orange so off-site flow stands out
      if (off) { im.data[k] = 255; im.data[k + 1] = 140; im.data[k + 2] = 0; } else { im.data[k] = 30; im.data[k + 1] = 120; im.data[k + 2] = 255; }
      im.data[k + 3] = 255;
    }
  }
  g.putImageData(im, 0, 0); return c.toDataURL();
}
function designSummary() {
  const v = surfaceDiff(field.dem.data, design.z, null, field.dem.dx * field.dem.dy);
  const ponds = design.info.filter((i) => i.type === 'pond' && i.cells), tiles = design.info.filter((i) => i.type === 'tile' && i.cells?.length);
  const total = field.cells.length, ac = (field.dem.dx * field.dem.dy) / 4046.86, main = design.exits[0];
  $('sdStats').innerHTML = `
    <dt>Water leaves the field</dt><dd>${main ? `main exit takes ${Math.round((100 * main.cells) / total)}%` : '—'}${design.exits.length > 1 ? `, ${design.exits.filter((x) => x.cells / total >= 0.05).length} exits over 5%` : ''}</dd>
    <dt>Changes: cut / fill</dt><dd>${fmt(v.cutM3 * M3_TO_YD3)} / ${fmt(v.fillM3 * M3_TO_YD3)} yd³</dd>
    <dt>Net</dt><dd>${v.fillM3 > v.cutM3 ? `import ${fmt((v.fillM3 - v.cutM3) * M3_TO_YD3)} yd³` : `export ${fmt((v.cutM3 - v.fillM3) * M3_TO_YD3)} yd³`}</dd>
    ${ponds.length ? `<dt>Pond storage</dt><dd>${(ponds.reduce((a, p) => a + p.storageM3, 0) / 1233.48).toFixed(2)} ac-ft</dd>` : ''}
    ${design.fgCells ? `<dt>Proposed design surface</dt><dd>${designSurf.name}</dd>` : ''}
    ${(() => { const r = edits.map((e, k) => [e, design.info[k]]).filter(([e, i]) => e.type === 'rock' && i?.cells); if (!r.length) return '';
      const yd = r.reduce((a, [e, i]) => a + i.areaM2 * e.depthIn * 0.0254 * M3_TO_YD3, 0), t = r.reduce((a, [e, i]) => a + i.areaM2 * e.depthIn * 0.0254 * M3_TO_YD3 * e.tonsPerYd, 0);
      return `<dt>Rock surfacing</dt><dd>${fmt(yd)} yd³ · ${fmt(t)} tons</dd>`; })()}
    ${tiles.length ? `<dt>Tile capacity</dt><dd>${tiles.reduce((a, t) => a + t.capacityCfs, 0).toFixed(2)} cfs</dd>` : ''}`;
  showWetlandResult();
}
function designChanged() {
  if (!design || !field?.dem) return false;
  const a = field.dem.data, z = design.z; for (let i = 0; i < z.length; i++) if (Math.abs(z[i] - a[i]) > 0.003) return true;
  return false;
}
// Storm (or still 3D view) on the field: existing ground and, when there is a design, the proposed grade beside it.
function openDesignStorm({ autoplay = true } = {}) {
  if (!field?.dem || !design) return;
  const sinks = design.info.filter((i) => i.type === 'tile' && i.cells?.length).map((i) => ({ cells: i.cells, capM3s: i.capacityCfs * 0.0283168 }));
  const changed = designChanged(), d = field.dem;
  // Lines draped on the ground: CAD layers that are switched on (near the field) and the design edits.
  const lines = [], fb = L.latLngBounds(field.pts).pad(0.6);
  if (cad) for (const [, l] of Object.entries(cad.layers)) if (map.hasLayer(l.group)) l.group.eachLayer((shape) => {
    const ll = shape.getLatLngs(), ring = Array.isArray(ll[0]) ? ll[0] : ll;
    if (ring.length >= 2 && fb.contains(ring[0])) lines.push({ pts: ring.map((p) => [p.lat, p.lng]), color: l.color, closed: shape instanceof L.Polygon });
  });
  for (const e of edits) lines.push({ pts: e.pts, color: EDIT_COLORS[e.type], closed: e.type !== 'tile' });
  openStorm(d, { proposed: changed ? design.z : null, outline: field.pts.map((p) => [p.lat, p.lng]), lines, autoplay,
    title: `${autoplay ? 'Storm on' : '3D view of'} the ${(field.area * M2_TO_AC).toFixed(field.area * M2_TO_AC < 10 ? 1 : 0)}-acre site${changed ? ': existing vs proposed' : ''}`,
    mask: field.mask, sinks, depthIn: designDepth(), CN: +$('cn').value || 78, maxCells: 128 });
}
$('sdStorm').onclick = () => openDesignStorm();
$('sd3d').onclick = () => openDesignStorm({ autoplay: false });

// NWI wetlands (USFWS National Wetlands Inventory). Mapped wetlands are a screening layer, not a delineation.
const NWI = 'https://fwspublicservices.wim.usgs.gov/wetlandsmapservice/rest/services/Wetlands/MapServer/0/query';
// Wetlands sit below drawings and edits so they never block clicks on shapes drawn over them.
map.createPane('wetlands').style.zIndex = 350;
function loadWetlands() {
  if (!field?.dem) return;
  const d = field.dem;
  $('wetResult').textContent = 'Checking the National Wetlands Inventory…';
  (async () => {
    try {
      const url = `${NWI}?where=1%3D1&geometry=${d.w},${d.s},${d.e},${d.n}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects` +
        '&outFields=ATTRIBUTE,WETLAND_TYPE,ACRES&outSR=4326&returnGeometry=true&geometryPrecision=6&f=geojson';
      const r = await robustFetch(url, { timeout: 60000, tries: 6, name: 'USFWS wetlands service' });
      const gj = await r.json();
      field.wet = { features: gj.features || [], overlap: wetlandOverlap(d, field.mask, gj.features || []) };
      if (wetLayer) map.removeLayer(wetLayer);
      wetLayer = L.geoJSON(gj, { pane: 'wetlands', style: { color: '#0f9b8e', weight: 1.5, fillColor: '#0f9b8e', fillOpacity: 0.28, dashArray: '4 3' },
        onEachFeature: (f, l) => l.bindTooltip(`${f.properties.WETLAND_TYPE} (${f.properties.ATTRIBUTE}), ${(+f.properties.ACRES).toFixed(2)} ac`) });
      if ($('showWet').checked) wetLayer.addTo(map);
      showWetlandResult();
    } catch (e) { console.warn('NWI', e); $('wetResult').innerHTML = '<span class="err">The USFWS wetlands service is not responding (it goes down at times).</span> <button type="button" class="link" id="wetRetry">Try again</button>'; $('wetRetry').onclick = loadWetlands; }
  })();
}
function showWetlandResult() {
  const w = field?.wet; if (!w) return;
  const o = w.overlap, acres = o.totalM2 * M2_TO_AC;
  // Edits that disturb mapped wetland
  let touched = 0;
  if (design && acres > 0) for (let i = 0; i < o.mask.length; i++) if (o.mask[i] && Math.abs(design.z[i] - field.dem.data[i]) > 0.03) touched++;
  const tA = touched * field.dem.dx * field.dem.dy * M2_TO_AC;
  $('wetResult').innerHTML = acres > 0.005
    ? `<b class="err">${acres.toFixed(2)} ac of mapped wetland inside the field</b> (${o.byType.map(([t, a]) => `${t} ${(a * M2_TO_AC).toFixed(2)} ac`).join('; ')}).` +
      (tA > 0.005 ? ` <b class="err">Your changes disturb ${tA.toFixed(2)} ac of it.</b>` : '') +
      ' Check permitting (Section 404 / Swampbuster) before work.'
    : `No mapped wetlands inside the field${w.features.length ? ` (${w.features.length} nearby, shown in teal)` : ''}.`;
}

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
  $('shedRadius').onchange = () => { if (shed) { flow = null; computeShed(); } };
}
function designDepth() { for (const y of [100, 50, 25, 10, 2]) { const v = parseFloat($(`p${y}`).value); if (Number.isFinite(v)) return v; } return 5; }

// Flow grid (filled DEM, D8 receivers, accumulation) for an area; reused across clicks.
let flow = null, chanLayer = null, flowSeq = 0;
async function buildFlow(bounds, onProgress) {
  const dem = await fetchDEM(bounds, { onProgress });
  onProgress('Tracing where water flows…');
  await new Promise((r) => setTimeout(r, 30));
  const f = fillDepressions(dem.data, dem.W, dem.H), rec = d8(f, dem.W, dem.H, dem.dx, dem.dy), acc = accumulate(rec, dem.W * dem.H);
  return { dem, rec, acc, bounds: L.latLngBounds([[dem.s, dem.w], [dem.n, dem.e]]) };
}
// Show the channel network for the current view so the user can see where to click.
function showChannels() {
  const z = map.getZoom();
  if (z < 13) { hint('Zoom in closer (to a few miles across), then pick the tool again to see the drainage channels.'); return; }
  const v = map.getBounds();
  if (flow && flow.bounds.contains(v)) { drawChannels(); hint('Click a blue channel at the culvert or outlet you want to size.'); return; }
  const seq = ++flowSeq, pb = v.pad(0.1);
  withBusy(async () => {
    const fl = await buildFlow({ s: pb.getSouth(), n: pb.getNorth(), w: pb.getWest(), e: pb.getEast() }, (m) => status(m));
    if (seq !== flowSeq) return;
    flow = fl; drawChannels(); status('');
    if (draw.mode === 'shed') hint('Click a blue channel at the culvert or outlet you want to size.');
  }, showChannels);
}
function channelImage(fl, mask) {
  const { dem, acc } = fl, W = dem.W, H = dem.H, c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d'), im = g.createImageData(W, H), ac = (dem.dx * dem.dy) / 4046.86;
  if (mask) for (let i = 0; i < W * H; i++) if (mask[i]) { const k = i * 4; im.data[k] = 120; im.data[k + 1] = 60; im.data[k + 2] = 200; im.data[k + 3] = 75; }
  const px = Math.max(1, Math.round(W / Math.max(300, map.getSize().x)));
  for (let i = 0; i < W * H; i++) {
    const a = acc[i] * ac; if (a < 2) continue;
    const r = px * (a >= 640 ? 3 : a >= 40 ? 2 : 1), x0 = i % W, y0 = (i / W) | 0, inB = mask ? mask[i] : 1;
    for (let y = Math.max(0, y0 - r); y <= Math.min(H - 1, y0 + r); y++) for (let x = Math.max(0, x0 - r); x <= Math.min(W - 1, x0 + r); x++) {
      const k = (y * W + x) * 4;
      if (im.data[k + 2] === 255 && im.data[k + 3] === 255) continue;
      im.data[k] = inB ? 20 : 70; im.data[k + 1] = inB ? 110 : 160; im.data[k + 2] = 255; im.data[k + 3] = inB ? 255 : 170;
    }
  }
  g.putImageData(im, 0, 0);
  return c.toDataURL();
}
function drawChannels() {
  if (chanLayer) map.removeLayer(chanLayer);
  if (shed?.ws) return; // the basin view draws its own channels
  chanLayer = L.imageOverlay(channelImage(flow), [[flow.dem.s, flow.dem.w], [flow.dem.n, flow.dem.e]], { opacity: 0.9, interactive: false }).addTo(map);
}

function setShed(ll) {
  if (shed) shed.layers.forEach((l) => map.removeLayer(l));
  shed = { outlet: ll, layers: [] };
  commitSoon();
  store.set('shed', [ll.lat, ll.lng]);
  $('intro').hidden = true;
  $('noaaLink').href = `https://hdsc.nws.noaa.gov/pfds/pfds_map_cont.html?lat=${ll.lat.toFixed(4)}&lon=${ll.lng.toFixed(4)}`;
  computeShed();
}
function boxAround(ll, R) {
  const dLat = R / 111320, dLon = R / (111320 * Math.cos(ll.lat * Math.PI / 180));
  return { s: ll.lat - dLat, n: ll.lat + dLat, w: ll.lng - dLon, e: ll.lng + dLon };
}
function computeShed() {
  const seq = ++shedSeq, ll = shed.outlet;
  withBusy(async () => {
    // Start from the loaded flow grid if it holds the outlet with some margin, else load around the outlet.
    let fl = flow && flow.bounds.pad(-0.05).contains(ll) ? flow : null, R = +$('shedRadius').value;
    for (let attempt = 0; ; attempt++) {
      if (!fl) {
        fl = await buildFlow(boxAround(ll, R), (m) => status(attempt ? `Drainage area is bigger than the loaded area. Loading a larger area… ${m}` : m));
        if (seq !== shedSeq) return;
        flow = fl;
      }
      const res = delineate(fl, ll);
      // Grow the area until the basin no longer touches its edge (up to ~4 mi across).
      if (res.ws.touchesEdge && attempt < 3) {
        const cur = fl.bounds, half = Math.max(cur.getNorth() - cur.getSouth(), (cur.getEast() - cur.getWest()) * Math.cos(ll.lat * Math.PI / 180)) * 111320 / 2;
        if (half < 3200) { R = Math.min(3200, half * 2); fl = null; continue; }
      }
      Object.assign(shed, res);
      break;
    }
    if (seq !== shedSeq) return;
    if (chanLayer) { map.removeLayer(chanLayer); chanLayer = null; }
    drawShed(); shedResults(); $('shedBox').hidden = false; status('');
    if (shed.areaM2 * M2_TO_AC < 1) hint('That spot drains less than an acre. Drag the blue outlet marker onto a channel.');
    else if (window.matchMedia('(max-width: 760px)').matches) hint(`Drainage area: ${(shed.areaM2 * M2_TO_AC).toFixed(1)} acres. Results are below the map.`);
  }, computeShed);
}
function delineate(fl, ll) {
  const { dem, rec, acc } = fl;
  const px = Math.floor(((ll.lng - dem.w) / (dem.e - dem.w)) * dem.W), py = Math.floor(((dem.n - ll.lat) / (dem.n - dem.s)) * dem.H);
  if (px < 0 || py < 0 || px >= dem.W || py >= dem.H) throw new Error('That point is outside the loaded lidar. Try again.');
  // Snap to the strongest flow line within 50 ft; if that isn't a real channel (2+ acres), look out to 160 ft.
  const chan = (2 * 4046.86) / (dem.dx * dem.dy);
  let out = snapOutlet(acc, dem.W, dem.H, px, py, Math.max(1, Math.round(15 / dem.dx)));
  for (const r of [50, 150]) {
    if (acc[out] >= chan) break;
    const far = snapOutlet(acc, dem.W, dem.H, px, py, Math.max(2, Math.round(r / dem.dx))); if (acc[far] >= chan) out = far;
  }
  const ws = watershed(rec, dem.W, dem.H, out, dem.dx, dem.dy);
  const areaM2 = ws.cells.length * dem.dx * dem.dy, path = flowPath(rec, ws.far, out);
  const zOut = dem.data[out], zTop = dem.data[ws.far], pathLen = ws.len[ws.far];
  let ss = 0, sn = 0;
  for (const c of ws.cells) {
    const x = c % dem.W, y = (c / dem.W) | 0; if (x < 1 || y < 1 || x >= dem.W - 1 || y >= dem.H - 1) continue;
    const gx = (dem.data[c + 1] - dem.data[c - 1]) / (2 * dem.dx), gy = (dem.data[c + dem.W] - dem.data[c - dem.W]) / (2 * dem.dy);
    if (Number.isFinite(gx) && Number.isFinite(gy)) { ss += Math.hypot(gx, gy); sn++; }
  }
  const idxLL = (i) => [dem.n - ((((i / dem.W) | 0) + 0.5) / dem.H) * (dem.n - dem.s), dem.w + (((i % dem.W) + 0.5) / dem.W) * (dem.e - dem.w)];
  return { dem, rec, acc, ws, out, areaM2, L: pathLen, relief: zTop - zOut, pathSlope: pathLen > 0 ? (zTop - zOut) / pathLen : 0, basinSlope: sn ? ss / sn : 0,
    snapped: L.latLng(...idxLL(out)), pathLL: path.filter((_, k) => k % 3 === 0 || k === path.length - 1).map(idxLL) };
}
function drawShed() {
  shed.layers.forEach((l) => map.removeLayer(l));
  const { dem, ws } = shed;
  const url = channelImage({ dem, acc: shed.acc }, ws.mask);
  const img = L.imageOverlay(url, [[dem.s, dem.w], [dem.n, dem.e]], { opacity: 0.9 }).addTo(map);
  const box = L.rectangle([[dem.s, dem.w], [dem.n, dem.e]], { color: '#ffffff', weight: 1, dashArray: '4 6', fill: false, interactive: false }).addTo(map);
  const lfp = L.polyline(shed.pathLL, { color: '#ffd400', weight: 3, dashArray: '8 6', interactive: false }).addTo(map);
  const icon = L.divIcon({ className: 'outlet', html: '<span></span>', iconSize: [22, 22] });
  const m = L.marker(shed.snapped, { draggable: true, icon, title: 'Outlet: drag to move', keyboard: true }).addTo(map);
  m.on('dragend', () => {
    const p = m.getLatLng(), b = L.latLngBounds([[dem.s, dem.w], [dem.n, dem.e]]).pad(-0.1);
    shed.outlet = p; store.set('shed', [p.lat, p.lng]);
    computeShed(); commitSoon();
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
  const m = Math.max(3, Math.round(0.15 * Math.max(x1 - x0, y1 - y0))); x0 = Math.max(0, x0 - m); y0 = Math.max(0, y0 - m); x1 = Math.min(dem.W - 1, x1 + m); y1 = Math.min(dem.H - 1, y1 + m);
  const W = x1 - x0 + 1, H = y1 - y0 + 1, data = new Float32Array(W * H), mask = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = (y + y0) * dem.W + x + x0; data[y * W + x] = dem.data[i]; mask[y * W + x] = ws.mask[i]; }
  if (shed.areaM2 * M2_TO_AC < 1) { hint('This drainage area is under an acre, too small to simulate. Drag the outlet onto a bigger channel first.'); return; }
  openStorm({ data, W, H, dx: dem.dx, dy: dem.dy }, { title: `Storm on the ${(shed.areaM2 * M2_TO_AC).toFixed(0)}-acre drainage area`, mask, depthIn: designDepth(), CN: shed.CN, maxCells: 128 });
};
$('shedCsv').onclick = () => shed?.ws && download('drainage-area.csv', toCSV(
  ['outlet_lat', 'outlet_lon', 'area_ac', 'flow_path_ft', 'tc_min', 'cn', 'storm', 'rain_in', 'runoff_in', 'volume_acft', 'peak_cfs'],
  (shed.rows.length ? shed.rows : [{}]).map((r) => [shed.snapped.lat.toFixed(6), shed.snapped.lng.toFixed(6), (shed.areaM2 * M2_TO_AC).toFixed(2),
    Math.round(shed.L * M_TO_FT), Math.round(shed.Tc * 60), Math.round(shed.CN), r.y ? `${r.y}-yr 24-h` : '', r.P ?? '', r.Q?.toFixed(3) ?? '', r.vol?.toFixed(2) ?? '', r.q?.toFixed(1) ?? ''])));

// ---------------- remove ----------------
function clearProfile() {
  if (!profile) return;
  profSeq++; profile.edit.remove(); if (profile.cursor) map.removeLayer(profile.cursor); profile = null;
  $('profBox').hidden = true; store.set('profile', null);
}
function clearField() {
  if (!field) return;
  fieldSeq++; field.edit.remove(); if (overlay) map.removeLayer(overlay); overlay = null; clearDesignLayers(); field = null; $('sdBox').hidden = true;
  $('fieldBox').hidden = true; store.set('field', null); renderLegend();
}
function clearShed() {
  if (!shed) return;
  shedSeq++; shed.layers.forEach((l) => map.removeLayer(l)); shed = null;
  $('shedBox').hidden = true; store.set('shed', null);
}
function updateIntro() { $('intro').hidden = !!(profile || field || shed); }
document.querySelectorAll('[data-clear]').forEach((b) => b.addEventListener('click', () => {
  ({ profile: clearProfile, field: clearField, shed: clearShed })[b.dataset.clear]?.();
  updateIntro(); commitSoon();
}));

function download(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' })); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ---------------- project: undo/redo, save, open, export, new ----------------
// Light state (outline, edits, profile, outlet, inputs) goes in the undo history. Imported files (drawing,
// survey, design surface) are part of a saved/exported project but not of undo.
const INPUTS = ['slope', 'heading', 'ratio', 'cn', 'landUse', 'hsg', 'tcMethod', 'shedRadius', 'p2', 'p10', 'p25', 'p50', 'p100'];
let restoring = false, hist = [], histAt = -1, commitT, projectName = store.get('projectName') || '';
const llArr = (pts) => pts.map((p) => [+p.lat.toFixed(8), +p.lng.toFixed(8)]);
function lightState() {
  return { field: field ? llArr(field.pts) : null, profile: profile ? llArr(profile.pts) : null, shed: shed ? llArr([shed.outlet])[0] : null,
    edits: JSON.parse(JSON.stringify(edits)), mode: document.querySelector('input[name=mode]:checked').value,
    inputs: Object.fromEntries(INPUTS.map((id) => [id, $(id).value])) };
}
function commitSoon() { if (restoring) return; clearTimeout(commitT); commitT = setTimeout(commit, 250); }
function commit() {
  const st = JSON.stringify(lightState());
  if (hist[histAt] === st) return;
  hist = hist.slice(0, histAt + 1); hist.push(st); if (hist.length > 100) hist.shift(); histAt = hist.length - 1;
  updateProjectUI();
}
async function applyLight(st) {
  restoring = true;
  try {
    for (const [id, v] of Object.entries(st.inputs || {})) if ($(id) && v != null) $(id).value = v;
    const m = document.querySelector(`input[name=mode][value="${st.mode || 'fit'}"]`); if (m) m.checked = true;
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    if (!same(st.profile, profile ? llArr(profile.pts) : null)) { if (st.profile) setProfile(toLL(st.profile)); else clearProfile(); }
    if (!same(st.shed, shed ? llArr([shed.outlet])[0] : null)) { if (st.shed) setShed(L.latLng(...st.shed)); else clearShed(); }
    const editsChanged = !same(st.edits, edits);
    edits = JSON.parse(JSON.stringify(st.edits || [])); store.set('edits', edits);
    if (!same(st.field, field ? llArr(field.pts) : null)) { if (st.field) setField(toLL(st.field)); else clearField(); }
    else if (field?.dem) { computeField(); if (editsChanged) refreshDesign(); }
    store.set('rain', Object.fromEntries(RP.map((y) => [y, parseFloat($(`p${y}`).value)]).filter(([, v]) => Number.isFinite(v))));
    if (shed?.ws) shedResults();
    updateIntro();
  } finally { setTimeout(() => { restoring = false; }, 0); }
}
function undo() { if (histAt > 0) { histAt--; applyLight(JSON.parse(hist[histAt])); updateProjectUI(); } }
function redo() { if (histAt < hist.length - 1) { histAt++; applyLight(JSON.parse(hist[histAt])); updateProjectUI(); } }
function updateProjectUI() {
  $('pjUndo').disabled = histAt <= 0; $('pjRedo').disabled = histAt >= hist.length - 1;
  $('pjName').textContent = projectName || 'Untitled project';
}
INPUTS.forEach((id) => $(id).addEventListener('change', commitSoon));
document.querySelectorAll('input[name=mode]').forEach((r) => r.addEventListener('change', commitSoon));

// Full project = light state + imported data (typed arrays kept as-is in IndexedDB; base64 in exported files).
function entryData(e) {
  return e && { sv: { xyz: e.sv.xyz, faces: e.sv.faces, kind: e.sv.kind, note: e.sv.note }, code: e.code, def: e.def, zUnits: e.zUnits || 'auto',
    maxEdgeM: e.maxEdgeM, name: e.name, extent: e.extent, cmp: e.cmp, coverAc: e.coverAc };
}
function projectData() {
  return { app: 'FieldGrade', version: 1, name: projectName, savedAt: new Date().toISOString(), state: lightState(),
    view: { ...map.getCenter(), z: map.getZoom() }, survey: entryData(survey), designSurf: entryData(designSurf), cad: cad?.src || null };
}
async function restoreEntry(d) {
  if (!d) return null;
  const tf = await transformFor(d.def, d.zUnits || 'auto');
  return { ...d, sv: { ...d.sv }, tf };
}
async function loadProject(pj) {
  await withBusy(async () => {
    status('Opening project…');
    newProject(true);
    projectName = pj.name || ''; store.set('projectName', projectName); updateProjectUI();
    if (pj.view) map.setView([pj.view.lat, pj.view.lng], pj.view.z, { animate: false });
    survey = await restoreEntry(pj.survey); designSurf = await restoreEntry(pj.designSurf);
    if (survey) drawSurvey(survey, 'existing'); if (designSurf) drawSurvey(designSurf, 'design');
    if (pj.cad) { const tf = await transformFor(pj.cad.def, 'auto'); setCad(pj.cad.lw, tf, ['project']); cad.src = pj.cad; }
    if (survey || designSurf || cad) { $('svNext').hidden = false; $('svRemove').hidden = false; $('svResult').innerHTML = `<div>Opened with ${[survey && 'existing-ground survey', designSurf && 'proposed design surface', cad && 'drawing linework'].filter(Boolean).join(', ')}.</div>`; }
    hist = []; histAt = -1;
    await applyLight(pj.state || {});
    setTimeout(commit, 300);
    status(`Opened “${projectName || 'project'}”.`);
  });
}
function newProject(silent) {
  restoring = true;
  cancelDraw(); clearProfile(); clearShed(); clearField();
  for (const e of [survey, designSurf]) (e?.layers || []).forEach((l) => map.removeLayer(l));
  survey = null; designSurf = null; clearCad(); flow = null;
  edits = []; store.set('edits', edits);
  $('svResult').innerHTML = ''; $('svNext').hidden = true; $('svRemove').hidden = true; $('svScanResult').innerHTML = '';
  projectName = ''; store.set('projectName', '');
  updateIntro(); restoring = false;
  hist = []; histAt = -1; commit();
  if (!silent) status('New project.');
}

// IndexedDB store for saved projects.
const idb = () => new Promise((res, rej) => { const r = indexedDB.open('fieldgrade', 1); r.onupgradeneeded = () => r.result.createObjectStore('projects', { keyPath: 'name' }); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
async function idbDo(mode, fn) { const db = await idb(); return new Promise((res, rej) => { const tx = db.transaction('projects', mode), out = fn(tx.objectStore('projects')); tx.oncomplete = () => res(out.result); tx.onerror = () => rej(tx.error); }); }
async function saveProject(name) {
  projectName = name; store.set('projectName', name);
  await idbDo('readwrite', (st) => st.put(projectData()));
  updateProjectUI(); status(`Saved “${name}” in this browser.`);
}
// Export: JSON with typed arrays as base64.
const b64 = (ta) => { const u = new Uint8Array(ta.buffer, ta.byteOffset, ta.byteLength); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (str, T) => { const s = atob(str), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return new T(u.buffer); };
function encodeArrays(o) { return JSON.stringify(o, (k, v) => (v instanceof Float64Array ? { $f64: b64(v) } : v instanceof Uint32Array ? { $u32: b64(v) } : v)); }
function decodeArrays(text) { return JSON.parse(text, (k, v) => (v && v.$f64 ? unb64(v.$f64, Float64Array) : v && v.$u32 ? unb64(v.$u32, Uint32Array) : v)); }
function exportProject() {
  const name = (projectName || 'fieldgrade-project').replace(/[^\w\- ]+/g, '').trim() || 'fieldgrade-project';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([encodeArrays(projectData())], { type: 'application/json' })); a.download = `${name}.fieldgrade.json`;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  status(`Exported ${a.download}.`);
}

// Toolbar and dialogs
const dlg = $('pjDlg');
function openDialog(title, html) { $('pjDlgTitle').textContent = title; $('pjDlgBody').innerHTML = html; dlg.showModal(); }
$('pjDlgClose').onclick = () => dlg.close();
$('pjUndo').onclick = undo; $('pjRedo').onclick = redo;
$('pjExport').onclick = exportProject;
$('pjNew').onclick = () => {
  openDialog('Start a new project?', `<p>This clears the outline, changes, profile, drainage outlet and imported files from the map. Saved projects are kept.</p>
    <div class="row"><button type="button" class="btn primary" id="pjNewYes">Start new</button><button type="button" class="btn" id="pjNewNo">Cancel</button></div>`);
  $('pjNewYes').onclick = () => { dlg.close(); newProject(); }; $('pjNewNo').onclick = () => dlg.close();
};
$('pjSave').onclick = () => {
  openDialog('Save project', `<form id="pjSaveForm" class="grid2"><label class="span2">Project name<input id="pjSaveName" required value="${(projectName || '').replace(/"/g, '&quot;')}" placeholder="e.g. North Substation grading"></label>
    <div class="row span2"><button type="submit" class="btn primary">Save</button><button type="button" class="btn" id="pjSaveCancel">Cancel</button></div></form>
    <p class="small muted">Saved in this browser on this computer. Use Export to share it or open it elsewhere.</p>`);
  $('pjSaveName').focus(); $('pjSaveCancel').onclick = () => dlg.close();
  $('pjSaveForm').onsubmit = (e) => { e.preventDefault(); const n = $('pjSaveName').value.trim(); if (!n) return; dlg.close(); withBusy(() => saveProject(n)); };
};
$('pjOpen').onclick = async () => {
  let list = [];
  try { list = await idbDo('readonly', (st) => st.getAll()); } catch { /* private mode */ }
  list.sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''));
  openDialog('Open project', `${list.length ? `<ul class="pjlist">${list.map((p, k) => `<li><button type="button" class="link pjopen" data-k="${k}"><b>${p.name}</b></button>
      <small>${new Date(p.savedAt).toLocaleString()}</small><button type="button" class="link pjdel" data-k="${k}">Delete</button></li>`).join('')}</ul>` : '<p class="small muted">No saved projects in this browser yet.</p>'}
    <div class="row"><label class="btn filebtn">Open an exported file…<input type="file" id="pjFile" accept=".json,application/json" class="sr"></label></div>`);
  dlg.querySelectorAll('.pjopen').forEach((b) => b.onclick = () => { dlg.close(); loadProject(list[+b.dataset.k]); });
  dlg.querySelectorAll('.pjdel').forEach((b) => b.onclick = async () => { await idbDo('readwrite', (st) => st.delete(list[+b.dataset.k].name)); b.closest('li').remove(); });
  $('pjFile').onchange = async () => {
    const f = $('pjFile').files[0]; if (!f) return; dlg.close();
    try { const pj = decodeArrays(await f.text()); if (pj.app !== 'FieldGrade') throw new Error(); loadProject(pj); }
    catch { status('That file is not a FieldGrade project.', true); }
  };
};
// Draw your own site outline from the Survey & design card.
$('svDrawOutline').onclick = () => { startDraw('field'); hint('Click the corners of your proposed site. Double-click or press Enter to finish. It replaces the current outline.'); };
$('svAutoOutline').onclick = () => { const o = autoOutline(); if (!o) { hint('Load a drawing or surface first.'); return; } setField(o.pts); hint(`Site outline taken from ${o.from}. Drag the white corner handles to adjust it.`); };

// ---------------- restore last session ----------------
const toLL = (a) => (Array.isArray(a) ? a.filter((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite)).map(([a1, b1]) => L.latLng(a1, b1)) : []);
{
  const f = toLL(store.get('field')), p = toLL(store.get('profile'));
  if (f.length >= 3) setField(f);
  if (p.length >= 2) setProfile(p);
  const o = toLL([store.get('shed')].filter(Boolean));
  if (o.length) setShed(o[0]);
  if (store.get('relief')) { $('relief').checked = true; $('reliefOpts').hidden = false; loadRelief(); }
  hist = []; histAt = -1; setTimeout(commit, 400); updateProjectUI();
}

// Test hook (read-only state + programmatic drawing).
window.__fg = { undo, redo, get hist() { return { n: hist.length, at: histAt }; }, projectData, loadProject, decodeArrays, encodeArrays, newProject, get survey() { return survey; }, get designSurf() { return designSurf; }, get cad() { return cad; }, importSurvey, get design() { return design; }, get edits() { return edits; }, addEdit: (t, p) => addEdit(t, p.map(([a, b]) => L.latLng(a, b))), map, setField, setProfile, setShed, get shed() { return shed; }, get flow() { return flow; }, get field() { return field; }, get profile() { return profile; }, get relief() { return relief; }, get busy() { return busy; } };
