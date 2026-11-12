// Pure earthwork math. Units: meters internally; helpers convert to feet / cubic yards.
export const M_TO_FT = 3.28084;
export const M3_TO_YD3 = 1.30795;
export const M2_TO_AC = 1 / 4046.8564224;

const R = 6371008.8;
// Local equirectangular projection (meters), fine for field-sized areas.
export function toLocal(lat, lon, lat0, lon0) {
  const k = Math.PI / 180;
  return { x: (lon - lon0) * k * R * Math.cos(lat0 * k), y: (lat - lat0) * k * R };
}

export function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function polygonArea(poly) {
  let s = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) s += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
  return Math.abs(s) / 2;
}

// Least-squares plane z = a + b*x + c*y over points [{x,y,z}].
export function fitPlane(pts) {
  let n = 0, sx = 0, sy = 0, sz = 0, sxx = 0, syy = 0, sxy = 0, sxz = 0, syz = 0;
  for (const p of pts) {
    n++; sx += p.x; sy += p.y; sz += p.z;
    sxx += p.x * p.x; syy += p.y * p.y; sxy += p.x * p.y; sxz += p.x * p.z; syz += p.y * p.z;
  }
  if (n < 3) throw new Error('need at least 3 points');
  // Center to keep the system well-conditioned.
  const mx = sx / n, my = sy / n, mz = sz / n;
  const cxx = sxx - n * mx * mx, cyy = syy - n * my * my, cxy = sxy - n * mx * my;
  const cxz = sxz - n * mx * mz, cyz = syz - n * my * mz;
  const det = cxx * cyy - cxy * cxy;
  if (Math.abs(det) < 1e-12) throw new Error('points are collinear');
  const b = (cxz * cyy - cyz * cxy) / det;
  const c = (cyz * cxx - cxz * cxy) / det;
  return { a: mz - b * mx - c * my, b, c };
}

// slopePct: fall in percent; headingDeg: direction water runs (downhill), clockwise from north.
export function planeFromSlope(slopePct, headingDeg, a = 0) {
  const s = slopePct / 100, h = (headingDeg * Math.PI) / 180;
  return { a, b: -s * Math.sin(h), c: -s * Math.cos(h) };
}

export function slopeOf(plane) {
  const s = Math.hypot(plane.b, plane.c);
  let h = (Math.atan2(-plane.b, -plane.c) * 180) / Math.PI;
  if (h < 0) h += 360;
  return { slopePct: s * 100, headingDeg: s === 0 ? 0 : h };
}

export const designZ = (pl, x, y) => pl.a + pl.b * x + pl.c * y;

// Cut = existing above design. Returns m³ and max depths in m.
export function volumes(pts, plane, cellArea) {
  let cut = 0, fill = 0, maxCut = 0, maxFill = 0;
  for (const p of pts) {
    const d = p.z - designZ(plane, p.x, p.y);
    if (d > 0) { cut += d * cellArea; if (d > maxCut) maxCut = d; }
    else { fill -= d * cellArea; if (-d > maxFill) maxFill = -d; }
  }
  return { cut, fill, maxCut, maxFill };
}

// Shift the plane up/down so cut = fill * ratio (ratio > 1 leaves extra cut for shrink).
export function balance(pts, plane, cellArea, ratio = 1) {
  let lo = Infinity, hi = -Infinity;
  for (const p of pts) {
    const r = p.z - plane.b * p.x - plane.c * p.y;
    if (r < lo) lo = r; if (r > hi) hi = r;
  }
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    const v = volumes(pts, { ...plane, a: mid }, cellArea);
    if (v.cut - v.fill * ratio > 0) lo = mid; else hi = mid;
  }
  return { ...plane, a: (lo + hi) / 2 };
}

// Summary of a sampled profile [{d (m), z (m)}], ignoring gaps.
export function profileStats(rows) {
  const ok = rows.filter((r) => Number.isFinite(r.z));
  if (ok.length < 2) return null;
  let lo = Infinity, hi = -Infinity, maxUp = 0, maxDown = 0;
  for (const r of ok) { if (r.z < lo) lo = r.z; if (r.z > hi) hi = r.z; }
  // Steepest grade over a ~10 m window, so 1 m lidar noise doesn't dominate.
  for (let i = 0, j = 0; i < ok.length; i++) {
    while (j < ok.length && ok[j].d - ok[i].d < 10) j++;
    if (j >= ok.length) break;
    const g = (ok[j].z - ok[i].z) / (ok[j].d - ok[i].d);
    if (g > maxUp) maxUp = g; if (-g > maxDown) maxDown = -g;
  }
  const first = ok[0], last = ok[ok.length - 1], run = last.d - first.d;
  return { lo, hi, start: first.z, end: last.z, length: run, grade: run > 0 ? (last.z - first.z) / run : 0, maxUp, maxDown };
}

// Value at fraction q (0..1) of a numeric array (copy-sorted).
export function quantile(values, q) {
  const v = Float64Array.from(values).sort();
  if (!v.length) return NaN;
  const i = Math.min(v.length - 1, Math.max(0, Math.round(q * (v.length - 1))));
  return v[i];
}

// Horn hillshade, 0..1. z: row-major heights (m), dx/dy cell size (m), NaN = no data.
export function hillshade(z, W, H, dx, dy, { azimuth = 315, altitude = 45, exaggeration = 1 } = {}) {
  const out = new Float32Array(W * H).fill(NaN);
  const zen = ((90 - altitude) * Math.PI) / 180;
  const az = ((360 - azimuth + 90) % 360) * Math.PI / 180;
  const cz = Math.cos(zen), sz = Math.sin(zen);
  const g = (x, y) => z[Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const c = z[y * W + x]; if (!Number.isFinite(c)) continue;
    const n = (xx, yy) => { const v = g(xx, yy); return Number.isFinite(v) ? v : c; };
    const a = n(x - 1, y - 1), b = n(x, y - 1), cc = n(x + 1, y - 1), d = n(x - 1, y), f = n(x + 1, y),
      gg = n(x - 1, y + 1), h = n(x, y + 1), i = n(x + 1, y + 1);
    const dzdx = (((cc + 2 * f + i) - (a + 2 * d + gg)) / (8 * dx)) * exaggeration;
    const dzdy = (((gg + 2 * h + i) - (a + 2 * b + cc)) / (8 * dy)) * exaggeration;
    const slope = Math.atan(Math.hypot(dzdx, dzdy));
    let aspect = Math.atan2(dzdy, -dzdx);
    if (aspect < 0) aspect += 2 * Math.PI;
    out[y * W + x] = Math.max(0, cz * Math.cos(slope) + sz * Math.sin(slope) * Math.cos(az - aspect));
  }
  return out;
}

// Elevation colour ramp (low = green, high = brown/white), t in 0..1 -> [r,g,b].
const RAMP = [[0, [38, 115, 77]], [0.25, [120, 170, 80]], [0.5, [230, 220, 120]], [0.75, [200, 130, 60]], [1, [245, 240, 235]]];
export function rampColor(t) {
  t = Math.min(1, Math.max(0, t));
  for (let k = 1; k < RAMP.length; k++) {
    const [t1, c1] = RAMP[k];
    if (t <= t1) {
      const [t0, c0] = RAMP[k - 1], u = (t - t0) / (t1 - t0);
      return c0.map((v, i) => Math.round(v + (c1[i] - v) * u));
    }
  }
  return RAMP[RAMP.length - 1][1];
}

// RFC 4180 CSV with CRLF line endings.
export function toCSV(head, rows) {
  const cell = (v) => { const s = String(v); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [head, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

// Parse "lat, lon" / "lat lon" (decimal degrees). Returns null if not coordinates.
export function parseLatLon(s) {
  const m = String(s).trim().match(/^(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = +m[1], lon = +m[2];
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
}
