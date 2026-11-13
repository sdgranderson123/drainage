// Site design edits on a lidar grid: ponds, raise/lower areas, drain tile. Pure functions, tested.
// Edits are stored as lat/lon geometry so they can be applied to any grid (field view, storm grid).
import { toLocal, pointInPolygon, polygonArea } from './earthwork.js';

const FT = 0.3048;

// Grid helpers. dem: { W, H, w, s, e, n, dx, dy }.
export function cellLatLon(dem, i) {
  return [dem.n - ((((i / dem.W) | 0) + 0.5) / dem.H) * (dem.n - dem.s), dem.w + (((i % dem.W) + 0.5) / dem.W) * (dem.e - dem.w)];
}
function localPts(dem, latlngs) {
  const lat0 = (dem.s + dem.n) / 2, lon0 = (dem.w + dem.e) / 2;
  return { lat0, lon0, P: latlngs.map(([a, b]) => { const q = toLocal(a, b, lat0, lon0); return [q.x, q.y]; }) };
}
// 1 for cells whose centre is inside the polygon [[lat, lon], ...].
export function rasterPolygon(dem, latlngs) {
  const { lat0, lon0, P } = localPts(dem, latlngs), m = new Uint8Array(dem.W * dem.H);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const [x, y] of P) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  for (let j = 0; j < dem.H; j++) for (let i = 0; i < dem.W; i++) {
    const [la, lo] = cellLatLon(dem, j * dem.W + i), q = toLocal(la, lo, lat0, lon0);
    if (q.x < x0 || q.x > x1 || q.y < y0 || q.y > y1) continue;
    if (pointInPolygon(q.x, q.y, P)) m[j * dem.W + i] = 1;
  }
  return m;
}
// Cells along a polyline (one cell wide, 8-connected), in order from first to last vertex.
export function rasterLine(dem, latlngs) {
  const out = [], seen = new Set();
  const toPx = ([la, lo]) => [((lo - dem.w) / (dem.e - dem.w)) * dem.W - 0.5, ((dem.n - la) / (dem.n - dem.s)) * dem.H - 0.5];
  for (let k = 1; k < latlngs.length; k++) {
    const [ax, ay] = toPx(latlngs[k - 1]), [bx, by] = toPx(latlngs[k]), n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) * 2));
    for (let t = 0; t <= n; t++) {
      const x = Math.round(ax + ((bx - ax) * t) / n), y = Math.round(ay + ((by - ay) * t) / n);
      if (x < 0 || y < 0 || x >= dem.W || y >= dem.H) continue;
      const i = y * dem.W + x; if (!seen.has(i)) { seen.add(i); out.push(i); }
    }
  }
  return out;
}
// Distance (m) from each masked cell to the nearest unmasked cell (two-pass chamfer).
export function edgeDistance(mask, W, H, dx, dy) {
  const d = new Float32Array(W * H), dd = Math.hypot(dx, dy);
  for (let i = 0; i < W * H; i++) d[i] = mask[i] ? 1e9 : 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x; if (!d[i]) continue;
    const edge = x === 0 || y === 0 ? Math.min(dx, dy) / 2 : Infinity;
    d[i] = Math.min(d[i], edge, x > 0 ? d[i - 1] + dx : Infinity, y > 0 ? d[i - W] + dy : Infinity,
      x > 0 && y > 0 ? d[i - W - 1] + dd : Infinity, x < W - 1 && y > 0 ? d[i - W + 1] + dd : Infinity);
  }
  for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) {
    const i = y * W + x; if (!d[i]) continue;
    const edge = x === W - 1 || y === H - 1 ? Math.min(dx, dy) / 2 : Infinity;
    d[i] = Math.min(d[i], edge, x < W - 1 ? d[i + 1] + dx : Infinity, y < H - 1 ? d[i + W] + dy : Infinity,
      x < W - 1 && y < H - 1 ? d[i + W + 1] + dd : Infinity, x > 0 && y < H - 1 ? d[i + W - 1] + dd : Infinity);
  }
  return d;
}

// ---- edits ----
// pond:  { type:'pond', pts, depthFt, sideSlope (H:1V) }  bottom = lowest ground on the pond edge − depth;
//        sides fall inward from the existing ground at sideSlope:1 until they reach the bottom.
// grade: { type:'grade', pts, mode:'offset'|'elev', valueFt }  raise/lower by valueFt, or set to elevation valueFt.
// tile:  { type:'tile', pts, depthFt, diaIn }  pipe at depthFt below ground along the line; outlet at the low end.
export function applyEdits(dem, base, edits) {
  const z = Float32Array.from(base), info = [];
  for (const e of edits) {
    if (e.type === 'grade') {
      const m = rasterPolygon(dem, e.pts); let cut = 0, fill = 0, n = 0;
      for (let i = 0; i < z.length; i++) if (m[i] && Number.isFinite(z[i])) {
        const nz = e.mode === 'elev' ? e.valueFt * FT : z[i] + e.valueFt * FT, d = nz - z[i];
        if (d > 0) fill += d; else cut -= d; z[i] = nz; n++;
      }
      const A = dem.dx * dem.dy;
      info.push({ type: 'grade', cells: n, areaM2: n * A, cutM3: cut * A, fillM3: fill * A });
    } else if (e.type === 'pond') {
      const m = rasterPolygon(dem, e.pts), dist = edgeDistance(m, dem.W, dem.H, dem.dx, dem.dy);
      let rim = Infinity, n = 0;
      for (let i = 0; i < z.length; i++) if (m[i] && dist[i] <= Math.max(dem.dx, dem.dy) * 1.01 && Number.isFinite(z[i])) rim = Math.min(rim, z[i]);
      if (!Number.isFinite(rim)) { info.push({ type: 'pond', cells: 0 }); continue; }
      const bottom = rim - e.depthFt * FT, ss = Math.max(1, e.sideSlope || 3);
      let exc = 0, storage = 0, botCells = 0;
      for (let i = 0; i < z.length; i++) if (m[i] && Number.isFinite(z[i])) {
        // Side slope descends inward from the existing ground at ss:1 until it reaches the bottom.
        const nz = Math.min(z[i], Math.max(bottom, z[i] - dist[i] / ss));
        exc += z[i] - nz; z[i] = nz; n++;
        if (nz < rim) storage += rim - nz;
        if (nz <= bottom + 1e-6) botCells++;
      }
      const A = dem.dx * dem.dy;
      info.push({ type: 'pond', cells: n, areaM2: n * A, rim, bottom, excavationM3: exc * A, storageM3: storage * A, bottomM2: botCells * A });
    } else if (e.type === 'rock') {
      // Rock surfacing: no change to the grade here; area for the quantity.
      // Area from the outline's exact geometry (not counted grid cells) because it drives a material quantity.
      const m = rasterPolygon(dem, e.pts); let n = 0; for (let i = 0; i < m.length; i++) if (m[i]) n++;
      info.push({ type: 'rock', cells: n, areaM2: polygonArea(localPts(dem, e.pts).P) });
    } else if (e.type === 'tile') {
      const cells = rasterLine(dem, e.pts);
      const ok = cells.filter((i) => Number.isFinite(base[i]));
      if (ok.length < 2) { info.push({ type: 'tile', cells: [] }); continue; }
      let len = 0;
      for (let k = 1; k < ok.length; k++) {
        const a = ok[k - 1], b = ok[k];
        len += Math.hypot(((a % dem.W) - (b % dem.W)) * dem.dx, (((a / dem.W) | 0) - ((b / dem.W) | 0)) * dem.dy);
      }
      const z0 = base[ok[0]], z1 = base[ok[ok.length - 1]];
      const outlet = z0 < z1 ? ok[0] : ok[ok.length - 1];
      // Pipe laid at constant cover: invert slope = ground slope end to end (minimum 0.1%).
      const slope = Math.max(0.001, Math.abs(z0 - z1) / Math.max(1, len));
      const cap = pipeCapacity(e.diaIn, slope);
      info.push({ type: 'tile', cells: ok, outlet, lengthM: len, slope, capacityCfs: cap, acresServed: tileAcres(cap) });
    }
  }
  return { z, info };
}

// Full-flow capacity (cfs) of a round pipe, Manning n = 0.015 (corrugated plastic tile, smooth-ish).
export function pipeCapacity(diaIn, slope, n = 0.015) {
  const D = diaIn / 12, A = (Math.PI * D * D) / 4, R = D / 4;
  return (1.486 / n) * A * R ** (2 / 3) * Math.sqrt(slope);
}
// Acres a tile main can serve at a drainage coefficient (in/day); 3/8 in/day is typical Midwest cropland.
export const tileAcres = (cfs, dcIn = 0.375) => (cfs * 86400) / ((dcIn / 12) * 43560);

// Volumes between two surfaces inside a mask (m³): cut = existing above design.
export function surfaceDiff(base, design, mask, cellArea) {
  let cut = 0, fill = 0;
  for (let i = 0; i < base.length; i++) if ((!mask || mask[i]) && Number.isFinite(base[i]) && Number.isFinite(design[i])) {
    const d = base[i] - design[i]; if (d > 0) cut += d; else fill -= d;
  }
  return { cutM3: cut * cellArea, fillM3: fill * cellArea };
}

// Where water leaves a polygon: cells inside whose D8 receiver is outside, grouped by exit and weighted by
// the inside area draining through them. Returns [{ i, cells }] sorted by size.
export function exitPoints(mask, rec, W) {
  const n = mask.length, inflow = new Float64Array(n), indeg = new Int32Array(n), q = [];
  for (let i = 0; i < n; i++) if (mask[i]) { inflow[i] = 1; const r = rec[i]; if (r >= 0 && mask[r]) indeg[r]++; }
  for (let i = 0; i < n; i++) if (mask[i] && !indeg[i]) q.push(i);
  const exits = [];
  for (let h = 0; h < q.length; h++) {
    const i = q[h], r = rec[i];
    if (r >= 0 && mask[r]) { inflow[r] += inflow[i]; if (--indeg[r] === 0) q.push(r); } else exits.push({ i, cells: inflow[i] });
  }
  exits.sort((a, b) => b.cells - a.cells);
  return exits;
}

// NWI wetlands (GeoJSON from the USFWS service) overlapping a mask on the grid: acres by wetland type.
export function wetlandOverlap(dem, mask, features) {
  const A = dem.dx * dem.dy, byType = new Map(), hit = new Uint8Array(dem.W * dem.H);
  for (const f of features) {
    const g = f.geometry; if (!g) continue;
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    for (const poly of polys) {
      const outer = rasterPolygon(dem, poly[0].map(([lo, la]) => [la, lo]));
      const holes = poly.slice(1).map((r) => rasterPolygon(dem, r.map(([lo, la]) => [la, lo])));
      let cells = 0;
      for (let i = 0; i < outer.length; i++) if (outer[i] && mask[i] && !hit[i] && !holes.some((h) => h[i])) { hit[i] = 1; cells++; }
      if (cells) { const t = f.properties?.WETLAND_TYPE || 'Wetland'; byType.set(t, (byType.get(t) || 0) + cells * A); }
    }
  }
  let total = 0; for (const v of byType.values()) total += v;
  return { totalM2: total, byType: [...byType.entries()].sort((a, b) => b[1] - a[1]), mask: hit };
}

// Merge exit cells closer than `radius` metres into one exit at the largest member (sheet flow leaves along a
// whole edge one cell at a time; grouping makes those edges show up as one place).
export function groupExits(exits, W, dx, dy, radius) {
  const groups = [];
  for (const e of exits) { // exits are sorted largest first
    const x = (e.i % W) * dx, y = ((e.i / W) | 0) * dy;
    const g = groups.find((g) => Math.hypot(g.x - x, g.y - y) <= radius);
    if (g) g.cells += e.cells; else groups.push({ i: e.i, x, y, cells: e.cells });
  }
  return groups.sort((a, b) => b.cells - a.cells);
}
