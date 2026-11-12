// Overland-flow storm simulation on a grid (virtual-pipe shallow-water scheme, Mei et al. 2007 style).
// Rain falls on the terrain; SCS curve-number losses decide how much runs off; water flows downhill, ponds in
// low spots and leaves across the grid edge (free outfall). Screening-level visualisation, not a design model.
import { scsRunoff, typeIIFraction } from './hydro.js';

const G = 9.81, IN = 0.0254;

export class StormSim {
  // bed: Float32Array of ground elevations (m, NaN = no data, treated as an outlet), W x H cells of size dx (m).
  // bed: ground elevations (m); NaN = no data. drain (optional Uint8Array): cells outside the study area.
  // Drain and no-data cells remove any water that reaches them, but water only flows into them where the
  // ground falls that way (they keep their real elevation; no-data takes its neighbours' level).
  constructor(bed, W, H, dx, { depthIn = 5, CN = 78, hours = 24, distribution = 'typeII', manning = 0.035, drain = null } = {}) {
    Object.assign(this, { W, H, dx, depthIn, CN, hours, distribution, manning });
    const n = W * H;
    this.b = Float32Array.from(bed);
    this.hole = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (!Number.isFinite(bed[i]) || (drain && drain[i])) this.hole[i] = 1;
    fillGaps(this.b, W, H);
    this.active = 0; for (let i = 0; i < n; i++) if (!this.hole[i]) this.active++;
    this.h = new Float32Array(n);
    this.fx = new Float32Array(n); this.fxl = new Float32Array(n); // flux to right / to left neighbour (m³/s)
    this.fy = new Float32Array(n); this.fyu = new Float32Array(n); // flux down (row+1) / up (row-1)
    this.t = 0; this.rain = 0; this.excess = 0; this.out = 0; this.maxH = new Float32Array(n);
    this.history = []; // {t (s), q (m³/s outflow), i (mm/h rain)}
    this._lastOut = 0; this._lastT = 0;
  }
  cumRainM(t) {
    const hr = t / 3600, f = this.distribution === 'uniform' ? Math.min(1, hr / this.hours) : typeIIFraction(hr * 24 / this.hours);
    return f * this.depthIn * IN;
  }
  cumExcessM(t) { return scsRunoff(this.cumRainM(t) / IN, this.CN) * IN; }
  stored() { let s = 0; for (let i = 0; i < this.h.length; i++) s += this.h[i]; return s * this.dx * this.dx; }

  // Advance by about `dtMax` seconds of simulated time (sub-stepped for stability). Returns the step used.
  step(dtMax = 5) {
    const { W, H, dx, b, h, fx, fxl, fy, fyu, hole } = this, A = dx * dx;
    let hm = 0.01; for (let i = 0; i < h.length; i++) if (h[i] > hm) hm = h[i];
    const dt = Math.min(dtMax, (0.5 * dx) / Math.sqrt(G * hm));
    // Rain excess, spread uniformly.
    const add = this.cumExcessM(this.t + dt) - this.cumExcessM(this.t);
    // Rain only on active cells: no-data / outside-area cells are drains and must not add flow.
    this.rain += (this.cumRainM(this.t + dt) - this.cumRainM(this.t)) * A * this.active;
    this.excess += add * A * this.active;
    if (add > 0) for (let i = 0; i < h.length; i++) if (!hole[i]) h[i] += add;
    // Flux update. Outside the grid: free outfall at own bed level.
    const k = dt * G * dx, n2 = this.manning * this.manning;
    // Semi-implicit Manning friction on each pipe: f /= 1 + dt·g·n²·|v| / h^(4/3), with v = f / (h·dx).
    const fric = (f, h1) => { const hh = Math.max(h1, 1e-3), v = f / (hh * dx); return 1 / (1 + dt * G * n2 * v / hh ** (4 / 3)); };
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x, s = b[i] + h[i];
      // Off-grid neighbours: the ground slope carried on outward (free outfall only where land falls out).
      const R = x < W - 1 ? b[i + 1] + h[i + 1] : 2 * b[i] - b[i - 1], Lh = x > 0 ? b[i - 1] + h[i - 1] : 2 * b[i] - b[i + 1];
      const D = y < H - 1 ? b[i + W] + h[i + W] : 2 * b[i] - b[i - W], U = y > 0 ? b[i - W] + h[i - W] : 2 * b[i] - b[i + W];
      const hi = h[i];
      let r = Math.max(0, (fx[i] + k * (s - R)) * fric(fx[i], hi)), l = Math.max(0, (fxl[i] + k * (s - Lh)) * fric(fxl[i], hi));
      let d = Math.max(0, (fy[i] + k * (s - D)) * fric(fy[i], hi)), u = Math.max(0, (fyu[i] + k * (s - U)) * fric(fyu[i], hi));
      const tot = (r + l + d + u) * dt, vol = h[i] * A;
      if (tot > vol && tot > 0) { const sc = vol / tot; r *= sc; l *= sc; d *= sc; u *= sc; }
      fx[i] = r; fxl[i] = l; fy[i] = d; fyu[i] = u;
    }
    // Depth update.
    let out = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const inflow = (x > 0 ? fx[i - 1] : 0) + (x < W - 1 ? fxl[i + 1] : 0) + (y > 0 ? fy[i - W] : 0) + (y < H - 1 ? fyu[i + W] : 0);
      const outflow = fx[i] + fxl[i] + fy[i] + fyu[i];
      // Flux pointing off-grid leaves the model.
      out += ((x === W - 1 ? fx[i] : 0) + (x === 0 ? fxl[i] : 0) + (y === H - 1 ? fy[i] : 0) + (y === 0 ? fyu[i] : 0)) * dt;
      h[i] = Math.max(0, h[i] + (inflow - outflow) * dt / A);
      if (hole[i]) { out += h[i] * A; h[i] = 0; } // no-data cells act as drains (water bodies, voids)
      if (h[i] > this.maxH[i]) this.maxH[i] = h[i];
    }
    this.out += out; this.t += dt;
    if (this.t - this._lastT >= 300 || this.history.length === 0) {
      const q = (this.out - this._lastOut) / Math.max(1e-9, this.t - this._lastT);
      const i = ((this.cumRainM(this.t) - this.cumRainM(this._lastT)) / IN * 25.4) / Math.max(1e-9, (this.t - this._lastT) / 3600);
      this.history.push({ t: this.t, q, i });
      this._lastOut = this.out; this._lastT = this.t;
    }
    return dt;
  }
  // Run until `tEnd` seconds or `budgetMs` of wall time; returns true when finished.
  run(tEnd, budgetMs = 12) {
    const t0 = globalThis.performance.now();
    while (this.t < tEnd && globalThis.performance.now() - t0 < budgetMs) this.step();
    return this.t >= tEnd;
  }
  balance() { const s = this.stored(); return { rain: this.rain, excess: this.excess, stored: s, out: this.out, error: this.excess - s - this.out }; }
}

// Give no-data cells the mean of their valid neighbours (repeated until filled) so they have a ground level.
function fillGaps(b, W, H) {
  for (let pass = 0; pass < 200; pass++) {
    let left = 0; const src = Float32Array.from(b);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x; if (Number.isFinite(src[i])) continue;
      let s = 0, k = 0;
      for (let yy = Math.max(0, y - 1); yy <= Math.min(H - 1, y + 1); yy++) for (let xx = Math.max(0, x - 1); xx <= Math.min(W - 1, x + 1); xx++) {
        const v = src[yy * W + xx]; if (Number.isFinite(v)) { s += v; k++; }
      }
      if (k) b[i] = s / k; else left++;
    }
    if (!left) return;
  }
  for (let i = 0; i < b.length; i++) if (!Number.isFinite(b[i])) b[i] = 0;
}

// Block-average a grid to at most `maxCells` on the long side (NaN-aware). Returns { z, W, H, dx, dy, sx, sy }.
export function coarsen(z, W, H, dx, dy, maxCells = 128) {
  const f = Math.max(1, Math.ceil(Math.max(W, H) / maxCells)), W2 = Math.floor(W / f), H2 = Math.floor(H / f);
  const out = new Float32Array(W2 * H2);
  for (let y = 0; y < H2; y++) for (let x = 0; x < W2; x++) {
    let s = 0, n = 0;
    for (let yy = 0; yy < f; yy++) for (let xx = 0; xx < f; xx++) { const v = z[(y * f + yy) * W + x * f + xx]; if (Number.isFinite(v)) { s += v; n++; } }
    out[y * W2 + x] = n > f * f / 2 ? s / n : NaN;
  }
  return { z: out, W: W2, H: H2, dx: dx * f, dy: dy * f, f };
}
