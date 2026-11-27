/** Spline EQ: a smooth gain curve through a few draggable points, applied as a linear-phase FIR (like ReaFIR's drawn curve). */

export const EQ_MIN_HZ = 20;
export const EQ_MAX_HZ = 20000;
export const EQ_RANGE_DB = 18;

/** Monotone cubic (PCHIP) interpolation through (log-frequency, dB) points: smooth, no overshoot, flat beyond the outer points. */
export function eqCurve(points: { f: number; db: number }[]): (hz: number) => number {
  const p = points.map((q) => ({ x: Math.log2(Math.max(1, q.f)), y: q.db })).sort((a, b) => a.x - b.x);
  const n = p.length;
  if (n === 0) return () => 0;
  if (n === 1) return () => p[0].y;
  const h: number[] = [], d: number[] = [];
  for (let i = 0; i < n - 1; i++) { h[i] = Math.max(1e-6, p[i + 1].x - p[i].x); d[i] = (p[i + 1].y - p[i].y) / h[i]; }
  const m: number[] = new Array(n).fill(0);
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] > 0) {
      const w1 = 2 * h[i] + h[i - 1], w2 = h[i] + 2 * h[i - 1];
      m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
    }
  }
  const end = (h0: number, h1: number, d0: number, d1: number) => {
    let s = ((2 * h0 + h1) * d0 - h0 * d1) / (h0 + h1);
    if (s * d0 <= 0) s = 0;
    else if (d0 * d1 <= 0 && Math.abs(s) > 3 * Math.abs(d0)) s = 3 * d0;
    return s;
  };
  if (n === 2) { m[0] = d[0]; m[1] = d[0]; }
  else { m[0] = end(h[0], h[1], d[0], d[1]); m[n - 1] = end(h[n - 2], h[n - 3], d[n - 2], d[n - 3]); }
  return (hz: number) => {
    const x = Math.log2(Math.max(1, hz));
    if (x <= p[0].x) return p[0].y;
    if (x >= p[n - 1].x) return p[n - 1].y;
    let i = 0;
    while (x > p[i + 1].x) i++;
    const t = (x - p[i].x) / h[i], t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * p[i].y + (t3 - 2 * t2 + t) * h[i] * m[i] + (-2 * t3 + 3 * t2) * p[i + 1].y + (t3 - t2) * h[i] * m[i + 1];
  };
}

/** In-place iterative radix-2 FFT (inverse when `inv`, unscaled). */
function fft(re: Float32Array | Float64Array, im: Float32Array | Float64Array, inv: boolean): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inv ? 2 : -2) * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang), half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half;
        const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

const TAPS = 4096;

/** Linear-phase FIR (length TAPS, delay TAPS/2) whose magnitude follows the curve. */
export function designFir(curve: (hz: number) => number, rate: number): Float64Array {
  const re = new Float64Array(TAPS), im = new Float64Array(TAPS);
  for (let k = 0; k <= TAPS / 2; k++) {
    const g = Math.pow(10, curve(Math.min(EQ_MAX_HZ, Math.max(EQ_MIN_HZ, (k * rate) / TAPS))) / 20);
    re[k] = g;
    if (k > 0 && k < TAPS / 2) re[TAPS - k] = g;
  }
  fft(re, im, true); // zero-phase impulse response, centred on index 0 (wrapped)
  const h = new Float64Array(TAPS);
  for (let i = 0; i < TAPS; i++) {
    const src = (i - TAPS / 2 + TAPS) % TAPS;
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / TAPS); // Hann
    h[i] = (re[src] / TAPS) * w;
  }
  return h;
}

/** Overlap-add FIR convolution; output has the same length as the input (the FIR delay is compensated). */
function convolve(x: Float32Array, h: Float64Array): Float32Array {
  const B = 16384, N = 32768;
  const hr = new Float64Array(N), hi = new Float64Array(N);
  hr.set(h);
  fft(hr, hi, false);
  const n = x.length, delay = h.length >> 1;
  const y = new Float32Array(n + h.length);
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let pos = 0; pos < n; pos += B) {
    re.fill(0); im.fill(0);
    const m = Math.min(B, n - pos);
    for (let i = 0; i < m; i++) re[i] = x[pos + i];
    fft(re, im, false);
    for (let i = 0; i < N; i++) { const a = re[i] * hr[i] - im[i] * hi[i]; im[i] = re[i] * hi[i] + im[i] * hr[i]; re[i] = a; }
    fft(re, im, true);
    const lim = Math.min(m + h.length - 1, y.length - pos);
    for (let i = 0; i < lim; i++) y[pos + i] += re[i] / N;
  }
  return y.slice(delay, delay + n);
}

/** values = [f1, g1, f2, g2, ...]: frequency in Hz and gain in dB per band. */
export function runEq(values: number[], data: Float32Array[], rate: number): Float32Array[] {
  const pts: { f: number; db: number }[] = [];
  for (let i = 0; i + 1 < values.length; i += 2) pts.push({ f: values[i], db: values[i + 1] });
  const h = designFir(eqCurve(pts), rate);
  return data.map((c) => convolve(c, h));
}
