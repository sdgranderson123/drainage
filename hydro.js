// Hydrology on gridded lidar: depression filling, D8 flow, watershed delineation, TR-55 runoff.
// Grids are row-major Float32Array (NaN = no data). Units: metres unless noted.

const DX = [1, 1, 0, -1, -1, -1, 0, 1], DY = [0, 1, 1, 1, 0, -1, -1, -1];

// Min-heap of cell indices keyed by elevation.
class Heap {
  constructor(n) { this.i = new Int32Array(n); this.k = new Float64Array(n); this.n = 0; }
  push(idx, key) {
    let p = this.n++;
    while (p > 0) { const q = (p - 1) >> 1; if (this.k[q] <= key) break; this.i[p] = this.i[q]; this.k[p] = this.k[q]; p = q; }
    this.i[p] = idx; this.k[p] = key;
  }
  pop() {
    const top = this.i[0], last = this.i[--this.n], lk = this.k[this.n];
    let p = 0;
    for (;;) {
      let c = 2 * p + 1; if (c >= this.n) break;
      if (c + 1 < this.n && this.k[c + 1] < this.k[c]) c++;
      if (this.k[c] >= lk) break;
      this.i[p] = this.i[c]; this.k[p] = this.k[c]; p = c;
    }
    this.i[p] = last; this.k[p] = lk;
    return top;
  }
}

// Priority-flood with epsilon (Barnes et al. 2014): fills pits so every cell drains to the edge or to no-data.
export function fillDepressions(z, W, H, eps = 1e-4) {
  const f = Float32Array.from(z), seen = new Uint8Array(W * H), heap = new Heap(W * H);
  const seed = (i) => { if (!seen[i]) { seen[i] = 1; if (Number.isFinite(f[i])) heap.push(i, f[i]); } };
  for (let x = 0; x < W; x++) { seed(x); seed((H - 1) * W + x); }
  for (let y = 0; y < H; y++) { seed(y * W); seed(y * W + W - 1); }
  // Cells next to no-data also drain out.
  for (let i = 0; i < W * H; i++) if (!Number.isFinite(f[i])) {
    seen[i] = 1;
    const x = i % W, y = (i / W) | 0;
    for (let k = 0; k < 8; k++) { const xx = x + DX[k], yy = y + DY[k]; if (xx >= 0 && yy >= 0 && xx < W && yy < H) seed(yy * W + xx); }
  }
  while (heap.n) {
    const c = heap.pop(), x = c % W, y = (c / W) | 0;
    for (let k = 0; k < 8; k++) {
      const xx = x + DX[k], yy = y + DY[k];
      if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
      const n = yy * W + xx; if (seen[n]) continue;
      seen[n] = 1;
      if (f[n] <= f[c]) f[n] = Math.fround(f[c] + eps) > f[c] ? Math.fround(f[c] + eps) : f[c] + eps * 4;
      heap.push(n, f[n]);
    }
  }
  return f;
}

// D8 receivers: index of the steepest-descent neighbour, or -1 (flows off the grid / into no-data).
export function d8(f, W, H, dx = 1, dy = 1) {
  const rec = new Int32Array(W * H).fill(-1), dist = [dx, Math.hypot(dx, dy), dy, Math.hypot(dx, dy), dx, Math.hypot(dx, dy), dy, Math.hypot(dx, dy)];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, zi = f[i]; if (!Number.isFinite(zi)) continue;
    let best = -1, bs = 0, edge = false;
    for (let k = 0; k < 8; k++) {
      const xx = x + DX[k], yy = y + DY[k];
      if (xx < 0 || yy < 0 || xx >= W || yy >= H) { edge = true; continue; }
      const n = yy * W + xx, zn = f[n];
      if (!Number.isFinite(zn)) { edge = true; continue; }
      const s = (zi - zn) / dist[k];
      if (s > bs) { bs = s; best = n; }
    }
    rec[i] = best >= 0 ? best : -1;
    if (best < 0 && !edge) rec[i] = -1;
  }
  return rec;
}

// Upstream cell count (including itself) via topological order of the receiver graph.
// Optional `weight` (per-cell, e.g. a field mask) counts only that cell's contribution.
export function accumulate(rec, n, weight = null) {
  const indeg = new Int32Array(n), acc = weight ? Float64Array.from(weight) : new Float64Array(n).fill(1), q = new Int32Array(n);
  for (let i = 0; i < n; i++) if (rec[i] >= 0) indeg[rec[i]]++;
  let h = 0, t = 0;
  for (let i = 0; i < n; i++) if (!indeg[i]) q[t++] = i;
  while (h < t) { const i = q[h++], r = rec[i]; if (r >= 0) { acc[r] += acc[i]; if (--indeg[r] === 0) q[t++] = r; } }
  return acc;
}

// Move the outlet to the highest-accumulation cell within `radius` cells (users click near, not on, the channel).
export function snapOutlet(acc, W, H, x, y, radius) {
  let best = y * W + x, ba = -1;
  for (let yy = Math.max(0, y - radius); yy <= Math.min(H - 1, y + radius); yy++)
    for (let xx = Math.max(0, x - radius); xx <= Math.min(W - 1, x + radius); xx++) {
      if ((xx - x) ** 2 + (yy - y) ** 2 > radius * radius) continue;
      const i = yy * W + xx; if (acc[i] > ba) { ba = acc[i]; best = i; }
    }
  return best;
}

// Cells draining to `outlet`, plus flow-path length (m) from each to the outlet.
export function watershed(rec, W, H, outlet, dx = 1, dy = 1) {
  const n = W * H, inB = new Uint8Array(n), len = new Float64Array(n), up = buildUpstream(rec, n);
  const order = [outlet]; inB[outlet] = 1;
  for (let h = 0; h < order.length; h++) {
    const c = order[h];
    for (let k = up.start[c]; k < up.start[c + 1]; k++) {
      const u = up.list[k]; if (inB[u]) continue;
      inB[u] = 1; order.push(u);
      const ddx = (u % W) - (c % W), ddy = ((u / W) | 0) - ((c / W) | 0);
      len[u] = len[c] + Math.hypot(ddx * dx, ddy * dy);
    }
  }
  let far = outlet, edge = false;
  for (const c of order) {
    if (len[c] > len[far]) far = c;
    const x = c % W, y = (c / W) | 0;
    if (x === 0 || y === 0 || x === W - 1 || y === H - 1) edge = true;
  }
  return { mask: inB, cells: order, len, far, touchesEdge: edge };
}
function buildUpstream(rec, n) {
  const start = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) if (rec[i] >= 0) start[rec[i] + 1]++;
  for (let i = 0; i < n; i++) start[i + 1] += start[i];
  const list = new Int32Array(start[n]), fill = start.slice(0, n);
  for (let i = 0; i < n; i++) if (rec[i] >= 0) list[fill[rec[i]]++] = i;
  return { start, list };
}
// Cells on the D8 path from `from` to `to`.
export function flowPath(rec, from, to) {
  const p = [from]; let c = from;
  while (c !== to && rec[c] >= 0 && p.length < 1e6) { c = rec[c]; p.push(c); }
  return p;
}

// ---- TR-55 (NRCS) ----
// Runoff depth (in) for rainfall P (in) and curve number CN.
export function scsRunoff(P, CN) {
  const S = 1000 / CN - 10, Ia = 0.2 * S;
  return P > Ia ? (P - Ia) ** 2 / (P - Ia + S) : 0;
}
// Time of concentration, NRCS lag method (hours). L = flow length (ft), slopePct = average watershed slope (%).
export function tcLag(Lft, slopePct, CN) {
  const S = 1000 / CN - 10, Y = Math.max(0.1, slopePct);
  return (Lft ** 0.8 * (S + 1) ** 0.7) / (1140 * Y ** 0.5);
}
// Kirpich (hours). L ft, S ft/ft.
export const tcKirpich = (Lft, S) => (0.0078 * Lft ** 0.77 * Math.max(1e-4, S) ** -0.385) / 60;

// TR-55 Exhibit 4-II / Table F-1, Type II rainfall: log10(qu) = C0 + C1 log10(Tc) + C2 log10(Tc)^2, qu in csm/in.
const TYPE_II = [[0.10, 2.55323, -0.61512, -0.16403], [0.30, 2.46532, -0.62257, -0.11657], [0.35, 2.41896, -0.61594, -0.08820],
  [0.40, 2.36409, -0.59857, -0.05621], [0.45, 2.29238, -0.57005, -0.02281], [0.50, 2.20282, -0.51599, -0.01259]];
export function unitPeakTypeII(IaP, TcHr) {
  const r = Math.min(0.5, Math.max(0.1, IaP)), t = Math.min(10, Math.max(0.1, TcHr)), lt = Math.log10(t);
  const q = (row) => 10 ** (row[1] + row[2] * lt + row[3] * lt * lt);
  for (let k = 1; k < TYPE_II.length; k++) {
    if (r <= TYPE_II[k][0]) { const a = TYPE_II[k - 1], b = TYPE_II[k], u = (r - a[0]) / (b[0] - a[0]); return q(a) + (q(b) - q(a)) * u; }
  }
  return q(TYPE_II[TYPE_II.length - 1]);
}
// Peak discharge (cfs), TR-55 graphical method, no pond adjustment. Am = area (sq mi), P = 24-h rain (in).
export function tr55Peak(AmSqMi, P, CN, TcHr) {
  const Q = scsRunoff(P, CN), S = 1000 / CN - 10, IaP = (0.2 * S) / P;
  const notes = [];
  if (IaP > 0.5) notes.push('Ia/P above 0.5: outside TR-55 range');
  if (TcHr < 0.1 || TcHr > 10) notes.push('Tc outside 0.1–10 h: TR-55 table limit applied');
  if (AmSqMi > 25) notes.push('Area over 25 sq mi: beyond TR-55 graphical method');
  return { q: Q > 0 ? unitPeakTypeII(IaP, TcHr) * AmSqMi * Q : 0, Q, IaP, notes };
}

// SCS Type II 24-h cumulative rainfall fraction at hour t (0..24), from the NRCS tabulated distribution.
const TYPE_II_CUM = [[0, 0], [2, 0.022], [4, 0.048], [6, 0.080], [8, 0.120], [9, 0.147], [10, 0.181], [10.5, 0.204], [11, 0.235],
  [11.5, 0.283], [11.75, 0.357], [12, 0.663], [12.5, 0.735], [13, 0.772], [13.5, 0.799], [14, 0.820], [16, 0.880], [20, 0.952], [24, 1]];
export function typeIIFraction(t) {
  if (t <= 0) return 0; if (t >= 24) return 1;
  for (let k = 1; k < TYPE_II_CUM.length; k++) {
    const [t1, f1] = TYPE_II_CUM[k];
    if (t <= t1) { const [t0, f0] = TYPE_II_CUM[k - 1]; return f0 + (f1 - f0) * (t - t0) / (t1 - t0); }
  }
  return 1;
}

// Common curve numbers (TR-55 Table 2-2), by hydrologic soil group A/B/C/D.
export const LAND_USE = [
  ['Row crops, straight row, good', [67, 78, 85, 89]],
  ['Row crops, contoured & terraced, good', [62, 71, 78, 81]],
  ['Small grain, straight row, good', [63, 75, 83, 87]],
  ['Pasture, good', [39, 61, 74, 80]],
  ['Meadow (hay)', [30, 58, 71, 78]],
  ['Woods, good', [30, 55, 70, 77]],
  ['Farmsteads', [59, 74, 82, 86]],
  ['Residential, 1/4 acre lots', [61, 75, 83, 87]],
  ['Commercial / paved', [89, 92, 94, 95]],
];
