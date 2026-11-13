// Survey data import: total-station point files (PNEZD), DXF, LandXML surfaces, LAS/LAZ point clouds.
// Parsers return { xyz: Float64Array [x,y,z,...] in the file's own units/CRS, faces?: Uint32Array, kind, epsg?, note? }.
// Gridding projects to lat/lon (proj4 passed in) and interpolates onto a lidar grid.

// ---------------- parsers ----------------

// Point files: P,N,E,Z,D (or other orders). Comma, tab or space separated; header lines and comments skipped.
export function parsePoints(text, order = 'PNEZD') {
  const o = order.toUpperCase(), iN = o.indexOf('N'), iE = o.indexOf('E'), iZ = o.indexOf('Z');
  const out = [], codes = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim(); if (!t || /^[#;/]/.test(t)) continue;
    const f = t.includes(',') ? t.split(',') : t.split(/\s+/);
    const n = +f[iN], e = +f[iE], z = +f[iZ];
    if (!Number.isFinite(n) || !Number.isFinite(e) || !Number.isFinite(z)) continue;
    out.push(e, n, z); codes.push((o.includes('D') ? f.slice(o.indexOf('D')).join(' ') : '').trim());
  }
  return { xyz: Float64Array.from(out), kind: 'points', codes };
}

// ASCII DXF: POINT, 3DFACE (as a TIN), LINE, LWPOLYLINE (with elevation), POLYLINE/VERTEX, INSERT with Z.
export function parseDXF(text) {
  const lines = text.split(/\r?\n/), pts = [], faces = [], labels = [];
  if (/^AutoCAD Binary DXF/.test(text.slice(0, 22))) throw new Error('Binary DXF is not supported. Save as ASCII DXF.');
  let i = 0, inEntities = false;
  const read = () => { const c = +lines[i]; const v = (lines[i + 1] ?? '').trim(); i += 2; return [c, v]; };
  let ent = null;
  const flush = () => {
    if (!ent) return;
    const g = ent.g, num = (c, k = 0) => (g[c] && g[c][k] !== undefined ? +g[c][k] : NaN);
    if (g[67]?.[0] === '1') { ent = null; return; } // paper space (sheets, title blocks)
    switch (ent.type) {
      // Spot elevations written as text ("1456.25", "FG 1456.25", "TC=1455.8", "EL. 1454.0") and survey point
      // blocks with an elevation attribute: elevation at the text's insertion point.
      case 'TEXT': case 'MTEXT': { const z = labelElevation((g[1] || []).join('') + (g[3] || []).join('')); if (z !== null) labels.push(num(10), num(20), z); break; }
      case 'ATTRIB': { if (/^(ELEV|ELEVATION|ELEV\.?|Z|EL|ELV)$/i.test(g[2]?.[0] || '')) { const z = labelElevation(g[1]?.[0] || ''); if (z !== null) labels.push(num(10), num(20), z); } break; }
      case 'POINT': pushPt(num(10), num(20), num(30)); break;
      case 'INSERT': if (num(30)) pushPt(num(10), num(20), num(30)); break;
      case 'LINE': if (num(30) || num(31)) { pushPt(num(10), num(20), num(30)); pushPt(num(11), num(21), num(31)); } break;
      case 'VERTEX': if (num(30)) pushPt(num(10), num(20), num(30)); break;
      case 'LWPOLYLINE': { const z = num(38); if (z) for (let k = 0; k < (g[10] || []).length; k++) pushPt(+g[10][k], +g[20][k], z); break; }
      case '3DFACE': {
        const v = [[10, 20, 30], [11, 21, 31], [12, 22, 32], [13, 23, 33]].map(([a, b, c]) => [num(a), num(b), num(c)]);
        const idx = v.map((p) => pushPt(...p));
        faces.push(idx[0], idx[1], idx[2]);
        const same = v[3][0] === v[2][0] && v[3][1] === v[2][1] && v[3][2] === v[2][2];
        if (!same) faces.push(idx[0], idx[2], idx[3]);
        break;
      }
    }
    ent = null;
  };
  const key = new Map();
  function pushPt(x, y, z) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return -1;
    const k = `${x},${y},${z}`; if (key.has(k)) return key.get(k);
    const id = pts.length / 3; pts.push(x, y, z); key.set(k, id); return id;
  }
  while (i < lines.length - 1) {
    const [c, v] = read();
    if (c === 0) {
      flush();
      if (v === 'SECTION') { const [, name] = read(); inEntities = name === 'ENTITIES'; continue; }
      if (v === 'ENDSEC') { inEntities = false; continue; }
      if (inEntities) ent = { type: v, g: {} };
    } else if (ent) (ent.g[c] ||= []).push(v);
  }
  flush();
  const f = faces.filter((x) => x >= 0);
  // Use text elevations only when the drawing has no real 3D geometry, and only the consistent ones
  // (within 60 units of their median: drops sheet numbers, dimensions and stray numbers).
  let note = '';
  if (pts.length < 9 && labels.length >= 9) {
    const zs = []; for (let k = 2; k < labels.length; k += 3) zs.push(labels[k]);
    const med = zs.slice().sort((a, b) => a - b)[zs.length >> 1];
    for (let k = 0; k < labels.length; k += 3) if (Number.isFinite(labels[k]) && Number.isFinite(labels[k + 1]) && Math.abs(labels[k + 2] - med) <= 60) pts.push(labels[k], labels[k + 1], labels[k + 2]);
    note = `${(pts.length / 3).toLocaleString()} spot elevations read from text labels`;
  }
  return { xyz: Float64Array.from(pts), faces: f.length ? Uint32Array.from(f) : null, kind: f.length ? 'tin' : 'points', note, fromLabels: !!note };
}
// Elevation in a label, or null. Plain numbers need a decimal and 2–5 digits ("1456.25"); prefixed labels
// (FG, EG, TC, TW, BW, FL, EL, ELEV, G, SPOT) are read with or without "=" / ":".
export function labelElevation(raw) {
  const t = String(raw).replace(/\\[A-Za-z][^;]*;|[{}]|\\P/g, ' ').replace(/%%[a-z]/gi, '').trim();
  const m = t.match(/^(?:(?:FG|EG|TC|TW|BW|FL|FFE|EL|ELEV|G|SPOT|GR)\.?\s*[=:]?\s*)?(\d{2,5}\.\d{1,3})(?:\s*(?:'|FT|M))?$/i);
  return m ? +m[1] : null;
}

// LandXML: <Surface> TIN (Pnts/Faces) and/or <CgPoint>s. Coordinates are "northing easting elevation".
export function parseLandXML(text) {
  const doc = new DOMParserImpl().parseFromString(text, 'application/xml');
  const pts = [], faces = [], idMap = new Map();
  const surf = doc.getElementsByTagName('Surface')[0];
  if (surf) {
    for (const p of doc.getElementsByTagName('P')) {
      const [n, e, z] = p.textContent.trim().split(/\s+/).map(Number);
      if ([n, e, z].every(Number.isFinite)) { idMap.set(p.getAttribute('id'), pts.length / 3); pts.push(e, n, z); }
    }
    for (const f of doc.getElementsByTagName('F')) {
      if (f.getAttribute('i') === '1') continue; // invisible face
      const ids = f.textContent.trim().split(/\s+/).map((k) => idMap.get(k));
      if (ids.length >= 3 && ids.every((k) => k !== undefined)) faces.push(ids[0], ids[1], ids[2]);
    }
  }
  for (const c of doc.getElementsByTagName('CgPoint')) {
    const [n, e, z] = c.textContent.trim().split(/\s+/).map(Number);
    if ([n, e, z].every(Number.isFinite)) pts.push(e, n, z);
  }
  const cs = doc.getElementsByTagName('CoordinateSystem')[0];
  const epsg = cs ? parseInt(cs.getAttribute('epsgCode') || (cs.getAttribute('ogcWktCode') || '').match(/AUTHORITY\["EPSG","(\d+)"\]\]\s*$/)?.[1] || '', 10) || null : null;
  const units = doc.getElementsByTagName('Units')[0]?.firstElementChild;
  const unitNote = units?.getAttribute('linearUnit') || null;
  return { xyz: Float64Array.from(pts), faces: faces.length ? Uint32Array.from(faces) : null, kind: faces.length ? 'tin' : 'points', epsg, units: unitNote };
}
// Browser DOMParser, or a tiny fallback for Node tests.
const DOMParserImpl = globalThis.DOMParser || class {
  parseFromString(text) {
    const all = (tag) => [...text.matchAll(new RegExp(`<${tag}(\\s[^>]*)?>([\\s\\S]*?)</${tag}>|<${tag}(\\s[^>]*)?/>`, 'g'))].map((m) => mk(m[1] || m[3] || '', m[2] || ''));
    const mk = (attrs, body) => ({ textContent: body, getAttribute: (a) => (attrs.match(new RegExp(`${a}="([^"]*)"`)) || [])[1] ?? null,
      firstElementChild: (() => { const m = body.match(/<(\w+)(\s[^>]*)?\/?>/); return m ? mk(m[2] || '', '') : null; })() });
    return { getElementsByTagName: all };
  }
};

// LAS 1.0–1.4 (uncompressed). Returns ground points (class 2) if any are classified, else all points.
export function parseLAS(buf) {
  const dv = new DataView(buf), sig = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (sig !== 'LASF') throw new Error('Not a LAS file.');
  const minor = dv.getUint8(25), hdrSize = dv.getUint16(94, true), offset = dv.getUint32(96, true), nVLR = dv.getUint32(100, true);
  const fmt = dv.getUint8(104) & 0x3f, recLen = dv.getUint16(105, true);
  let count = dv.getUint32(107, true);
  if (minor >= 4 && !count) count = Number(dv.getBigUint64(247, true));
  const sx = dv.getFloat64(131, true), sy = dv.getFloat64(139, true), sz = dv.getFloat64(147, true);
  const ox = dv.getFloat64(155, true), oy = dv.getFloat64(163, true), oz = dv.getFloat64(171, true);
  const epsg = lasEPSG(dv, hdrSize, nVLR);
  const pts = decodeLASPoints(dv, offset, count, recLen, fmt, [sx, sy, sz], [ox, oy, oz]);
  return { ...pts, epsg, compressed: false };
}
export function lasHeader(buf) {
  const dv = new DataView(buf);
  return { minor: dv.getUint8(25), hdrSize: dv.getUint16(94, true), offset: dv.getUint32(96, true), nVLR: dv.getUint32(100, true),
    fmt: dv.getUint8(104) & 0x3f, compressed: !!(dv.getUint8(104) & 0x80), recLen: dv.getUint16(105, true),
    count: dv.getUint32(107, true) || (dv.getUint8(25) >= 4 ? Number(dv.getBigUint64(247, true)) : 0),
    scale: [dv.getFloat64(131, true), dv.getFloat64(139, true), dv.getFloat64(147, true)],
    off: [dv.getFloat64(155, true), dv.getFloat64(163, true), dv.getFloat64(171, true)], epsg: lasEPSG(dv, dv.getUint16(94, true), dv.getUint32(100, true)) };
}
// Decode fixed-length point records from a DataView (used for LAS and for decompressed LAZ).
export function decodeLASPoints(dv, offset, count, recLen, fmt, s, o) {
  const clsAt = fmt >= 6 ? 16 : 15, clsMask = fmt >= 6 ? 0xff : 0x1f;
  let ground = 0;
  for (let k = 0; k < count; k++) if ((dv.getUint8(offset + k * recLen + clsAt) & clsMask) === 2) ground++;
  const useGround = ground > 0, n = useGround ? ground : count, xyz = new Float64Array(n * 3);
  let j = 0;
  for (let k = 0; k < count; k++) {
    const p = offset + k * recLen;
    if (useGround && (dv.getUint8(p + clsAt) & clsMask) !== 2) continue;
    xyz[j++] = dv.getInt32(p, true) * s[0] + o[0]; xyz[j++] = dv.getInt32(p + 4, true) * s[1] + o[1]; xyz[j++] = dv.getInt32(p + 8, true) * s[2] + o[2];
  }
  return { xyz, kind: 'cloud', total: count, ground, note: useGround ? `${ground.toLocaleString()} ground points of ${count.toLocaleString()}` : `No ground classification: using all ${count.toLocaleString()} points (buildings and trees included)` };
}
function lasEPSG(dv, hdrSize, nVLR) {
  let p = hdrSize;
  for (let v = 0; v < nVLR && p + 54 <= dv.byteLength; v++) {
    const user = String.fromCharCode(...new Uint8Array(dv.buffer, dv.byteOffset + p + 2, 16)).replace(/\0.*$/, '');
    const rec = dv.getUint16(p + 18, true), len = dv.getUint16(p + 20, true), body = p + 54;
    if (user === 'LASF_Projection' && rec === 34735) {
      const nKeys = dv.getUint16(body + 6, true);
      for (let k = 0; k < nKeys; k++) {
        const kb = body + 8 + k * 8, id = dv.getUint16(kb, true), loc = dv.getUint16(kb + 2, true), val = dv.getUint16(kb + 6, true);
        if ((id === 3072 || id === 2048) && loc === 0 && val > 1000 && val < 32767) return val;
      }
    }
    if (user === 'LASF_Projection' && rec === 2112) {
      const wkt = new TextDecoder().decode(new Uint8Array(dv.buffer, dv.byteOffset + body, len));
      const m = wkt.match(/AUTHORITY\["EPSG",\s*"?(\d+)"?\]\]\s*\0*$/) || wkt.match(/ID\["EPSG",\s*(\d+)\]\]\s*\0*$/);
      if (m) return +m[1];
    }
    p = body + len;
  }
  return null;
}

// ---------------- coordinate systems ----------------
// Metres per unit of a proj4 definition (+units= / +to_meter=).
export function unitToMeters(def) {
  const m = def.match(/\+to_meter=([\d.]+)/); if (m) return +m[1];
  const u = (def.match(/\+units=([\w-]+)/) || [])[1];
  return u === 'us-ft' ? 1200 / 3937 : u === 'ft' ? 0.3048 : 1;
}

// ---------------- gridding ----------------
// Interpolate a parsed survey onto a lidar grid. toLL(x, y) -> [lat, lon]; zScale: metres per file z unit.
// Returns { z: Float32Array (NaN where no survey), cells } . maxEdgeM drops long triangles (gaps, hull edges).
export function gridSurvey(dem, sv, toLL, zScale, Delaunator, { maxEdgeM = 60 } = {}) {
  const n = sv.xyz.length / 3, W = dem.W, H = dem.H, out = new Float32Array(W * H).fill(NaN);
  const px = new Float64Array(n), py = new Float64Array(n), pz = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const [la, lo] = toLL(sv.xyz[k * 3], sv.xyz[k * 3 + 1]);
    px[k] = ((lo - dem.w) / (dem.e - dem.w)) * W - 0.5; py[k] = ((dem.n - la) / (dem.n - dem.s)) * H - 0.5; pz[k] = sv.xyz[k * 3 + 2] * zScale;
  }
  let cells = 0;
  if (sv.kind === 'cloud') {
    // Dense clouds: average the points in each cell, then fill single-cell holes from neighbours.
    const sum = new Float64Array(W * H), cnt = new Uint32Array(W * H);
    for (let k = 0; k < n; k++) {
      const x = Math.round(px[k]), y = Math.round(py[k]); if (x < 0 || y < 0 || x >= W || y >= H) continue;
      sum[y * W + x] += pz[k]; cnt[y * W + x]++;
    }
    for (let i = 0; i < W * H; i++) if (cnt[i]) { out[i] = sum[i] / cnt[i]; cells++; }
    const src = Float32Array.from(out);
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      const i = y * W + x; if (cnt[i]) continue;
      // Median (not mean) of the neighbours, so a gap next to a ditch or curb doesn't smear across the break.
      const v = []; for (const j of [i - 1, i + 1, i - W, i + W, i - W - 1, i - W + 1, i + W - 1, i + W + 1]) if (src[j] === src[j]) v.push(src[j]);
      if (v.length >= 5) { v.sort((a, b) => a - b); out[i] = v.length % 2 ? v[v.length >> 1] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2; cells++; }
    }
    return { z: out, cells };
  }
  // Points / TIN: triangulate (or use the file's faces) and interpolate linearly inside each triangle.
  let tri = sv.faces;
  if (!tri) { const coords = new Float64Array(n * 2); for (let k = 0; k < n; k++) { coords[2 * k] = px[k]; coords[2 * k + 1] = py[k]; } tri = new Delaunator(coords).triangles; }
  const maxPx = maxEdgeM / Math.min(dem.dx, dem.dy);
  for (let t = 0; t < tri.length; t += 3) {
    const a = tri[t], b = tri[t + 1], c = tri[t + 2];
    const ax = px[a], ay = py[a], bx = px[b], by = py[b], cx = px[c], cy = py[c];
    if (Math.hypot(ax - bx, ay - by) > maxPx || Math.hypot(bx - cx, by - cy) > maxPx || Math.hypot(cx - ax, cy - ay) > maxPx) continue;
    const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy); if (Math.abs(det) < 1e-12) continue;
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))), x1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx, cx)));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy))), y1 = Math.min(H - 1, Math.ceil(Math.max(ay, by, cy)));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const l1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / det, l2 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / det, l3 = 1 - l1 - l2;
      if (l1 < -1e-9 || l2 < -1e-9 || l3 < -1e-9) continue;
      const i = y * W + x; if (out[i] !== out[i]) cells++;
      out[i] = l1 * pz[a] + l2 * pz[b] + l3 * pz[c];
    }
  }
  return { z: out, cells };
}

// Compare survey with lidar where both exist: median and spread of (survey − lidar), metres.
export function compareSurfaces(survey, lidar) {
  const d = [];
  for (let i = 0; i < survey.length; i++) if (survey[i] === survey[i] && lidar[i] === lidar[i]) d.push(survey[i] - lidar[i]);
  if (!d.length) return null;
  d.sort((a, b) => a - b);
  const med = d[d.length >> 1], abs = d.map((v) => Math.abs(v - med)).sort((a, b) => a - b);
  return { n: d.length, median: med, mad: abs[abs.length >> 1], p95: abs[Math.floor(abs.length * 0.95)] };
}

// ---------------- CAD linework (overlay) ----------------
// Model-space linework by layer from an ASCII DXF: LINE, LWPOLYLINE, POLYLINE/VERTEX, ARC, CIRCLE, SPLINE.
// Returns { layers: { name: [{ pts: [[x, y], ...], closed }] } }. Paper-space entities (67 = 1) are skipped.
export function parseDXFLinework(text) {
  const lines = text.split(/\r?\n/), layers = {};
  let i = 0, section = '', ent = null, poly = null;
  const add = (layer, pts, closed) => { if (pts.length >= 2 && pts.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))) (layers[layer] ||= []).push({ pts, closed: !!closed }); };
  const arcPts = (cx, cy, r, a0, a1) => {
    if (a1 <= a0) a1 += 360;
    const n = Math.max(4, Math.ceil((a1 - a0) / 10)), out = [];
    for (let k = 0; k <= n; k++) { const a = ((a0 + ((a1 - a0) * k) / n) * Math.PI) / 180; out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); }
    return out;
  };
  const finish = () => {
    if (!ent) return;
    const g = ent.g, f = (c, k = 0) => +(g[c]?.[k]), layer = g[8]?.[0] ?? '0', paper = g[67]?.[0] === '1';
    if (!paper) switch (ent.type) {
      case 'LINE': add(layer, [[f(10), f(20)], [f(11), f(21)]]); break;
      case 'LWPOLYLINE': add(layer, (g[10] || []).map((x, k) => [+x, +g[20][k]]), (+(g[70]?.[0] || 0)) & 1); break;
      case 'ARC': add(layer, arcPts(f(10), f(20), f(40), f(50), f(51))); break;
      case 'CIRCLE': add(layer, arcPts(f(10), f(20), f(40), 0, 360), true); break;
      case 'SPLINE': { const pts = (g[11]?.length ? g[11].map((x, k) => [+x, +g[21][k]]) : (g[10] || []).map((x, k) => [+x, +g[20][k]])); add(layer, pts); break; }
      case 'POLYLINE': if (!paper) poly = { layer, closed: (+(g[70]?.[0] || 0)) & 1, pts: [] }; break;
      case 'VERTEX': if (poly) poly.pts.push([f(10), f(20)]); break;
      case 'SEQEND': if (poly) { add(poly.layer, poly.pts, poly.closed); poly = null; } break;
    }
    ent = null;
  };
  while (i < lines.length - 1) {
    const c = +lines[i], v = (lines[i + 1] ?? '').trim(); i += 2;
    if (c === 0) {
      finish();
      if (v === 'SECTION') { section = (lines[i + 1] ?? '').trim(); i += 2; continue; }
      if (v === 'ENDSEC') { section = ''; continue; }
      if (section === 'ENTITIES') ent = { type: v, g: {} };
    } else if (ent) (ent.g[c] ||= []).push(v);
  }
  finish();
  return { layers };
}
// Drop shapes far from the main cluster (legends, title blocks drawn near 0,0 in model space).
export function mainCluster(lin, maxDist) {
  const xs = [], ys = [];
  for (const shapes of Object.values(lin.layers)) for (const s of shapes) { xs.push(s.pts[0][0]); ys.push(s.pts[0][1]); }
  if (!xs.length) return { layers: {}, dropped: 0 };
  const med = (a) => a.slice().sort((p, q) => p - q)[a.length >> 1], mx = med(xs), my = med(ys);
  const out = {}; let dropped = 0;
  for (const [name, shapes] of Object.entries(lin.layers)) {
    const keep = shapes.filter((s) => s.pts.every(([x, y]) => Math.hypot(x - mx, y - my) <= maxDist));
    dropped += shapes.length - keep.length; if (keep.length) out[name] = keep;
  }
  return { layers: out, dropped, centre: [mx, my] };
}

// External references (xrefs) a DXF depends on: BLOCK records flagged as xref (70 & 4) with their file path.
export function dxfXrefs(text) {
  const lines = text.split(/\r?\n/), out = [];
  let section = '', inBlock = false, g = {};
  for (let i = 0; i < lines.length - 1; i += 2) {
    const c = lines[i].trim(), v = (lines[i + 1] ?? '').trim();
    if (c === '0') {
      if (inBlock && (+(g['70'] || 0) & 4)) out.push({ name: g['2'], path: g['1'] || '' });
      inBlock = false; g = {};
      if (v === 'SECTION') { section = (lines[i + 3] ?? '').trim(); continue; }
      if (section === 'BLOCKS' && v === 'BLOCK') inBlock = true;
    } else if (inBlock && !(c in g)) g[c] = v;
  }
  return out;
}
// Text in the drawing that names a coordinate system or vertical datum (to help pick the EPSG code).
export function dxfCrsNotes(text) {
  const lines = text.split(/\r?\n/), hits = new Set(), re = /\b(State Plane|NAD ?83|NSRS ?2011|NAVD ?(19)?88|NGVD ?(19)?29|Vertical Datum)\b/i;
  for (let i = 0; i < lines.length - 1; i += 2) {
    const c = lines[i].trim(); if (c !== '1' && c !== '3') continue; // text strings only
    const t = lines[i + 1].replace(/\\[A-Za-z][^;]*;|[{}]|\\P/g, ' ').replace(/\s+/g, ' ');
    if (!re.test(t)) continue;
    // Split into sentences without regex lookbehind (a syntax error before Safari 16.4).
    for (const sent of t.replace(/\.\s+/g, '.\n').replace(/\s(?=\d\.\s)/g, '\n').split('\n')) if (re.test(sent)) hits.add(sent.trim().slice(0, 160));
  }
  return [...hits].slice(0, 4);
}
