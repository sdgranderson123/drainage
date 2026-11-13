// Browser side of survey import: file reading, LAZ decompression (laz-perf WASM), coordinate systems (proj4 + epsg.io).
import { parsePoints, parseDXF, parseLandXML, parseLAS, lasHeader, decodeLASPoints, unitToMeters, gridSurvey } from './survey.js';
import { robustFetch } from './dem.js';

const LIB = {
  proj4: 'https://cdn.jsdelivr.net/npm/proj4@2.11.0/+esm',
  delaunator: 'https://cdn.jsdelivr.net/npm/delaunator@5.0.1/+esm',
  lazperf: 'https://cdn.jsdelivr.net/npm/laz-perf@0.0.6/lib/web/index.js/+esm',
  lazwasm: 'https://cdn.jsdelivr.net/npm/laz-perf@0.0.6/lib/web/',
};
let proj4P, delP, lazP;
const proj4 = () => (proj4P ||= import(LIB.proj4).then((m) => m.default || m));
export const Delaunator = () => (delP ||= import(LIB.delaunator).then((m) => m.default || m));
const lazModule = () => (lazP ||= import(LIB.lazperf).then((m) => (m.createLazPerf || m.default?.createLazPerf || m.default)({ locateFile: (p) => LIB.lazwasm + p })));

export function fileKind(name) {
  const ext = name.toLowerCase().split('.').pop();
  if (ext === 'las') return 'las'; if (ext === 'laz') return 'laz'; if (ext === 'dxf') return 'dxf';
  if (ext === 'xml' || ext === 'landxml') return 'landxml';
  if (ext === 'dwg') return 'dwg';
  return 'points';
}

// Read and parse one file. Returns the parsed survey plus a description.
export async function readSurvey(file, { order = 'PNEZD', onProgress } = {}) {
  const kind = fileKind(file.name);
  if (kind === 'dwg') throw new Error('DWG is a closed Autodesk format that cannot be read in a browser. In Civil 3D / AutoCAD use Save As → DXF, or export the surface as LandXML or the points as a PNEZD .csv.');
  if (kind === 'las' || kind === 'laz') {
    const buf = await file.arrayBuffer(), h = lasHeader(buf);
    if (!h.compressed) return { ...parseLAS(buf), name: file.name };
    onProgress?.('Decompressing LAZ…');
    const L = await lazModule(), bytes = new Uint8Array(buf), fp = L._malloc(bytes.length);
    L.HEAPU8.set(bytes, fp);
    const z = new L.LASZip();
    try {
      z.open(fp, bytes.length);
      const n = z.getCount(), len = z.getPointLength(), fmt = z.getPointFormat(), dp = L._malloc(len), all = new Uint8Array(n * len);
      for (let k = 0; k < n; k++) { z.getPoint(dp); all.set(L.HEAPU8.subarray(dp, dp + len), k * len); if (k % 500000 === 0) onProgress?.(`Decompressing LAZ… ${Math.round((100 * k) / n)}%`); }
      L._free(dp);
      const pts = decodeLASPoints(new DataView(all.buffer), 0, n, len, fmt & 0x3f, h.scale, h.off);
      return { ...pts, epsg: h.epsg, compressed: true, name: file.name };
    } finally { z.delete(); L._free(fp); }
  }
  const text = await file.text();
  if (kind === 'dxf') return { ...parseDXF(text), name: file.name };
  if (kind === 'landxml') return { ...parseLandXML(text), name: file.name };
  return { ...parsePoints(text, order), name: file.name };
}

// proj4 definition for an EPSG code (epsg.io, then spatialreference.org).
const defCache = new Map();
export async function epsgDef(code) {
  if (defCache.has(code)) return defCache.get(code);
  let def = null;
  for (const url of [`https://epsg.io/${code}.proj4`, `https://spatialreference.org/ref/epsg/${code}/proj4.txt`]) {
    try { const t = (await (await robustFetch(url, { timeout: 15000, tries: 2, name: 'coordinate system lookup' })).text()).trim(); if (t.startsWith('+proj')) { def = t; break; } } catch { /* next */ }
  }
  if (!def) throw new Error(`Could not find a definition for EPSG:${code}. Check the code.`);
  defCache.set(code, def); return def;
}
export const utmEPSG = (lon) => 26900 + Math.floor((lon + 180) / 6) + 1; // NAD83 UTM north zones

// Build transforms for a survey: toLL(x, y) -> [lat, lon]; zScale metres per z unit.
export async function transformFor(def, zUnits) {
  const p = await proj4(), t = p(def, 'WGS84');
  const zScale = zUnits === 'auto' ? unitToMeters(def) : { m: 1, usft: 1200 / 3937, ft: 0.3048 }[zUnits];
  return { toLL: (x, y) => { const [lo, la] = t.forward([x, y]); return [la, lo]; }, zScale, xyUnit: unitToMeters(def) };
}

// Survey extent as lat/lon bounds and centre, sampling at most ~5000 points.
export function surveyExtent(sv, toLL) {
  const n = sv.xyz.length / 3, step = Math.max(1, Math.floor(n / 5000));
  let s = 90, nn = -90, w = 180, e = -180, cl = 0, co = 0, k = 0;
  for (let i = 0; i < n; i += step, k++) {
    const [la, lo] = toLL(sv.xyz[i * 3], sv.xyz[i * 3 + 1]);
    s = Math.min(s, la); nn = Math.max(nn, la); w = Math.min(w, lo); e = Math.max(e, lo); cl += la; co += lo;
  }
  return { s, n: nn, w, e, lat: cl / k, lon: co / k };
}

export { gridSurvey };
