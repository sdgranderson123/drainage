// Browser side of survey import: file reading, LAZ decompression (laz-perf WASM), coordinate systems (proj4 + epsg.io).
import { parsePoints, parseDXF, parseLandXML, parseLAS, lasHeader, decodeLASPoints, unitToMeters, gridSurvey, parseDXFLinework, dxfXrefs, dxfCrsNotes } from './survey.js';
import { robustFetch } from './dem.js';

const LIB = {
  proj4: 'https://cdn.jsdelivr.net/npm/proj4@2.11.0/+esm',
  delaunator: 'https://cdn.jsdelivr.net/npm/delaunator@5.0.1/+esm',
  lazperf: 'https://cdn.jsdelivr.net/npm/laz-perf@0.0.6/lib/web/index.js/+esm',
  lazwasm: 'https://cdn.jsdelivr.net/npm/laz-perf@0.0.6/lib/web/',
  // LibreDWG compiled to WebAssembly (GPL-3.0), loaded only when a DWG is opened (~11 MB).
  libredwg: 'https://cdn.jsdelivr.net/npm/@mlightcad/libredwg-web@0.8.8/dist/libredwg-web.js',
  libredwgWasm: 'https://cdn.jsdelivr.net/npm/@mlightcad/libredwg-web@0.8.8/wasm',
};
let proj4P, delP, lazP, dwgP;
const libredwg = () => (dwgP ||= import(LIB.libredwg).then((m) => m.LibreDwg.create(LIB.libredwgWasm)));
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
  if (kind === 'dwg') {
    onProgress?.('Loading the DWG reader (first time ~11 MB)…');
    const lib = await libredwg();
    onProgress?.(`Converting ${file.name}…`);
    const out = lib.dwg_write_dxf(new Uint8Array(await file.arrayBuffer()));
    if (!out) throw new Error(`${file.name} could not be read. Try Save As → DXF (AutoCAD 2018 DXF) in AutoCAD / Civil 3D.`);
    return cadResult(new TextDecoder('latin1').decode(out), file.name);
  }
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
  if (kind === 'dxf') return cadResult(text, file.name);
  if (kind === 'landxml') return { ...parseLandXML(text), name: file.name };
  return { ...parsePoints(text, order), name: file.name };
}

// CAD drawing: 3D points/faces (if any), plan linework by layer, external references, coordinate notes.
function cadResult(text, name) {
  let pts = { xyz: new Float64Array(0), kind: 'points' };
  try { pts = parseDXF(text); } catch (e) { if (/Binary/.test(e.message)) throw e; }
  return { ...pts, name, cad: true, linework: parseDXFLinework(text), xrefs: dxfXrefs(text), crsNotes: dxfCrsNotes(text) };
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
export const loadProj4 = proj4;
let tableP;
export const crsTable = () => (tableP ||= fetch('crs-us.json').then((r) => r.json()));

// Look through a picked folder: what survey/design files are there, and what do they say about coordinates.
export async function scanFolder(files) {
  const found = [], notes = [];
  const kindOf = (n) => { const k = fileKind(n); return /\.(prj)$/i.test(n) ? 'prj' : /\.(txt|csv|pnezd|xyz)$/i.test(n) ? 'points' : /\.(las|laz|dxf|dwg|xml|landxml)$/i.test(n) ? k : null; };
  for (const f of files) {
    const kind = kindOf(f.name); if (!kind) continue;
    const item = { file: f, kind, path: f.webkitRelativePath || f.name, size: f.size, epsg: null, note: '' };
    try {
      if (kind === 'prj') { const t = await f.text(); item.note = t.slice(0, 200); notes.push(t); }
      else if (kind === 'las' || kind === 'laz') {
        const head = await f.slice(0, 375).arrayBuffer(), off = new DataView(head).getUint32(96, true);
        const h = lasHeader(await f.slice(0, Math.min(f.size, Math.max(375, off))).arrayBuffer());
        item.epsg = h.epsg; item.note = `${h.count.toLocaleString()} points${h.compressed ? ', compressed' : ''}`;
      } else if (kind === 'landxml') {
        const t = await f.slice(0, 400000).text();
        if (!/<LandXML/i.test(t)) continue;
        item.epsg = +(t.match(/epsgCode="(\d+)"/) || [])[1] || null;
        const cs = (t.match(/<CoordinateSystem[^>]*name="([^"]+)"/) || [])[1]; if (cs) { item.note = cs; notes.push(cs); }
        item.note = [item.note, /<Surface\b/.test(t) ? 'surface' : '', /<CgPoint/.test(t) ? 'points' : ''].filter(Boolean).join(', ');
      } else if (kind === 'points') {
        const t = await f.slice(0, 4000).text(), rows = t.split(/\r?\n/).filter((l) => (l.match(/-?\d+\.\d+/g) || []).length >= 3);
        if (rows.length < 3) continue; item.note = `${rows.length}+ coordinate rows`;
      } else if (kind === 'dxf') {
        const t = await f.slice(0, 3e6).text(); const n = (await import('./survey.js')).dxfCrsNotes(t); notes.push(...n); item.note = n[0] || '';
      }
    } catch { /* unreadable: still list it */ }
    found.push(item);
  }
  return { found, notes };
}
