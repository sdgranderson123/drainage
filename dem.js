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
      last = e.name === 'AbortError' ? new Error('The USGS elevation service timed out. It is often slow; try again in a minute.')
        : e instanceof TypeError ? new Error('Could not reach the USGS elevation service (it is busy or down). Try again in a minute.') : e;
      if (/error 4\d\d/.test(last.message) && !/429/.test(last.message)) throw last;
    } finally { clearTimeout(t); signal?.removeEventListener('abort', onAbort); }
    await new Promise((res) => setTimeout(res, 1000 * 2 ** k + Math.random() * 500));
  }
  throw last;
}

// Bare-earth grid covering bounds {s,n,w,e} at ~1 m (coarser if the area is large).
// Large areas are fetched as compressed tiles (<= TILE px) in parallel: the service times out (504, which the
// browser reports only as "Failed to fetch") on single large requests, and one failed tile retries alone.
export const TILE = 600;
export async function fetchDEM({ s, n, w, e }, { signal, onProgress, maxPx = MAX_PX } = {}) {
  const lat0 = (s + n) / 2;
  const wm = toLocal(lat0, e, lat0, w).x, hm = toLocal(n, w, s, w).y;
  const scale = Math.max(1, Math.max(wm, hm) / maxPx);
  const W = Math.max(8, Math.round(wm / scale)), H = Math.max(8, Math.round(hm / scale));
  const nx = Math.ceil(W / TILE), ny = Math.ceil(H / TILE);
  const data = new Float32Array(W * H).fill(NaN);
  const jobs = [];
  for (let ty = 0; ty < ny; ty++) for (let tx = 0; tx < nx; tx++) {
    const x0 = Math.floor((tx * W) / nx), x1 = Math.floor(((tx + 1) * W) / nx), y0 = Math.floor((ty * H) / ny), y1 = Math.floor(((ty + 1) * H) / ny);
    jobs.push({ x0, y0, tw: x1 - x0, th: y1 - y0,
      bb: [w + ((e - w) * x0) / W, n - ((n - s) * y1) / H, w + ((e - w) * x1) / W, n - ((n - s) * y0) / H] });
  }
  let done = 0;
  const say = () => onProgress?.(jobs.length > 1 ? `Downloading lidar… ${done} of ${jobs.length}` : 'Downloading lidar…');
  say();
  const one = async (j) => {
    const [jw, js, je, jn] = j.bb;
    const url = `${SVC}/exportImage?bbox=${jw},${js},${je},${jn}&bboxSR=4326&imageSR=4326&size=${j.tw},${j.th}` +
      '&format=tiff&compression=LZ77&pixelType=F32&noDataInterpretation=esriNoDataMatchAny&interpolation=RSP_BilinearInterpolation&f=image';
    const r = await robustFetch(url, { signal, tries: 4 });
    const buf = await r.arrayBuffer();
    let img;
    try { img = await (await fromArrayBuffer(buf)).getImage(); }
    catch { throw new Error('The elevation service sent an unreadable file. Try again.'); }
    const [raw] = await img.readRasters();
    const iw = Math.min(img.getWidth(), j.tw), ih = Math.min(img.getHeight(), j.th);
    for (let y = 0; y < ih; y++) for (let x = 0; x < iw; x++) {
      const z = raw[y * img.getWidth() + x];
      data[(j.y0 + y) * W + j.x0 + x] = valid(z) ? z : NaN;
    }
    done++; say();
  };
  // At most 4 requests at a time.
  const queue = jobs.slice();
  await Promise.all(Array.from({ length: Math.min(3, jobs.length) }, async () => { while (queue.length) await one(queue.shift()); }));
  let good = 0; for (let i = 0; i < data.length; i++) if (data[i] === data[i]) good++;
  const latc = (s + n) / 2;
  const dx = toLocal(latc, w + (e - w) / W, latc, w).x, dy = toLocal(s + (n - s) / H, w, s, w).y;
  return { data, W, H, w, s, e, n, dx, dy, coverage: good / data.length };
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
