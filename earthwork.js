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
