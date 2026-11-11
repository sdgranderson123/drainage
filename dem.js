// USGS 3DEP access: lidar grids (GeoTIFF) and point elevations, with timeouts and retries.
import { fromArrayBuffer } from 'https://cdn.jsdelivr.net/npm/geotiff@2.1.3/+esm';
import { toLocal } from './earthwork.js';

export const SVC = 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer';
export const MAX_PX = 1500;            // max grid size per side
export const valid = (z) => Number.isFinite(z) && z > -500 && z < 9000;

// fetch with timeout + retry on network errors and 429/5xx (USGS often returns 502/504 under load).
export async function robustFetch(url, { signal, timeout = 45000, tries = 3 } = {}) {
  let last;
  for (let k = 0; k < tries; k++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), timeout);
    const onAbort = () => ctl.abort();
    signal?.addEventListener('abort', onAbort);
    try {
      const r = await fetch(url, { signal: ctl.signal });
      if (r.ok) return r;
      last = new Error(`Elevation service error ${r.status}`);
      if (r.status !== 429 && r.status < 500) throw last;
    } catch (e) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      last = e.name === 'AbortError' ? new Error('Elevation service timed out') : e;
      if (/error 4\d\d/.test(last.message) && !/429/.test(last.message)) throw last;
    } finally { clearTimeout(t); signal?.removeEventListener('abort', onAbort); }
    await new Promise((res) => setTimeout(res, 800 * 2 ** k));
  }
  throw last;
}

// Bare-earth grid covering bounds {s,n,w,e} at ~1 m (coarser if the area is large).
export async function fetchDEM({ s, n, w, e }, { signal, onProgress } = {}) {
  const lat0 = (s + n) / 2;
  const wm = toLocal(lat0, e, lat0, w).x, hm = toLocal(n, w, s, w).y;
  const scale = Math.max(1, Math.max(wm, hm) / MAX_PX);
  const W = Math.max(8, Math.round(wm / scale)), H = Math.max(8, Math.round(hm / scale));
  const url = `${SVC}/exportImage?bbox=${w},${s},${e},${n}&bboxSR=4326&imageSR=4326&size=${W},${H}` +
    '&format=tiff&pixelType=F32&noDataInterpretation=esriNoDataMatchAny&interpolation=RSP_BilinearInterpolation&f=image';
  onProgress?.('Downloading lidar…');
  const r = await robustFetch(url, { signal });
  const buf = await r.arrayBuffer();
  onProgress?.('Reading lidar…');
  let img;
  try { img = await (await fromArrayBuffer(buf)).getImage(); }
  catch { throw new Error('Elevation service returned an unreadable image. Try again.'); }
  const [raw] = await img.readRasters();
  const iw = img.getWidth(), ih = img.getHeight();
  // Use the grid's own georeferencing when present; the server may snap the extent.
  let bb = [w, s, e, n];
  try { const g = img.getBoundingBox(); if (g.every(Number.isFinite) && Math.abs(g[0]) <= 180 && Math.abs(g[1]) <= 90) bb = g; } catch { /* keep requested */ }
  const data = new Float32Array(iw * ih);
  let good = 0;
  for (let i = 0; i < data.length; i++) { const z = raw[i]; if (valid(z)) { data[i] = z; good++; } else data[i] = NaN; }
  const latc = (bb[1] + bb[3]) / 2;
  const dx = toLocal(latc, bb[0] + (bb[2] - bb[0]) / iw, latc, bb[0]).x;
  const dy = toLocal(bb[1] + (bb[3] - bb[1]) / ih, bb[0], bb[1], bb[0]).y;
  return { data, W: iw, H: ih, w: bb[0], s: bb[1], e: bb[2], n: bb[3], dx, dy, coverage: good / data.length };
}

// Bilinear sample in metres; NaN outside the grid or next to no-data.
export function sample(dem, lat, lon) {
  if (lat < dem.s || lat > dem.n || lon < dem.w || lon > dem.e) return NaN;
  const px = ((lon - dem.w) / (dem.e - dem.w)) * dem.W - 0.5, py = ((dem.n - lat) / (dem.n - dem.s)) * dem.H - 0.5;
  const x0 = Math.max(0, Math.min(dem.W - 2, Math.floor(px))), y0 = Math.max(0, Math.min(dem.H - 2, Math.floor(py)));
  const fx = Math.min(1, Math.max(0, px - x0)), fy = Math.min(1, Math.max(0, py - y0));
  const g = (x, y) => dem.data[y * dem.W + x];
  const a = g(x0, y0), b = g(x0 + 1, y0), c = g(x0, y0 + 1), d = g(x0 + 1, y0 + 1);
  return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
}

// Single-point elevation (m) from the service; NaN when no data.
export async function pointElevation(lat, lon, { signal } = {}) {
  const geom = encodeURIComponent(JSON.stringify({ x: lon, y: lat, spatialReference: { wkid: 4326 } }));
  const url = `${SVC}/identify?geometry=${geom}&geometryType=esriGeometryPoint&returnGeometry=false&returnCatalogItems=false&f=json`;
  const j = await (await robustFetch(url, { signal, timeout: 15000, tries: 2 })).json();
  const z = parseFloat(j.value);
  return valid(z) ? z : NaN;
}

// Place search (Esri World Geocoder, US only).
export async function geocode(q, { signal } = {}) {
  const url = 'https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates' +
    `?SingleLine=${encodeURIComponent(q)}&countryCode=USA&maxLocations=1&outFields=Match_addr&f=json`;
  const j = await (await robustFetch(url, { signal, timeout: 15000, tries: 2 })).json();
  const c = j.candidates?.[0];
  return c ? { lat: c.location.y, lon: c.location.x, label: c.address, extent: c.extent } : null;
}

// Lidar project covering a point: the best-ranked (lowest "Best") full-resolution source in the 3DEP mosaic.
// Returns { title, start: Date, end: Date } or null. Dates are the project's collection window.
export async function lidarSource(lat, lon, { signal } = {}) {
  const geom = encodeURIComponent(JSON.stringify({ x: lon, y: lat, spatialReference: { wkid: 4326 } }));
  const url = `${SVC}/identify?geometry=${geom}&geometryType=esriGeometryPoint&returnGeometry=false&returnCatalogItems=true&f=json`;
  const j = await (await robustFetch(url, { signal, timeout: 40000, tries: 2 })).json();
  return pickSource(j.catalogItems?.features || []);
}
export function pickSource(features) {
  const ymd = (v) => { const s = String(v ?? ''); return /^\d{8}$/.test(s) ? new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8))) : null; };
  const items = features.map((f) => f.attributes || {})
    .filter((a) => a.Category === 1 && Number.isFinite(a.Best) && a.MinPS === 0 && ymd(a.EndDate));
  if (!items.length) return null;
  // Seamless 1/3 and 1 arc-second compilations outrank project lidar in "Best", but full-resolution
  // requests are served from the 1 m / 1/9 arc-second projects where they exist (checked against the
  // texture of returned grids), so rank by product tier first.
  const tier = (a) => { const t = String(a.title || a.Name);
    return /1 ?meter|one meter/i.test(t) ? 0 : /1\/9 arc/i.test(t) ? 1 : /arc.?second/i.test(t) ? 3 : 2; };
  items.sort((a, b) => tier(a) - tier(b) || a.Best - b.Best);
  const a = items[0];
  return { title: a.title || a.Name, start: ymd(a.StartDate), end: ymd(a.EndDate), compilation: tier(a) === 3 };
}
