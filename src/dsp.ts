import type { MasterSettings, PlaybackObject, PlaybackTrack } from './types';

/** Shared by the UI (waveform/fade drawing) and the AudioWorklet. */

/** Fade shape: curve 0 = linear, 1 = strongly exponential. t in 0..1. */
export function fadeGain(t: number, curve: number): number {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return curve <= 0 ? c : Math.pow(c, 1 + curve * 3);
}

export function centsToRatio(cents: number): number {
  return Math.pow(2, cents / 1200);
}

/** Envelope (0..1) at `local` seconds into an object of length `dur`. */
export function envelope(
  local: number,
  dur: number,
  fadeIn: number,
  fadeOut: number,
  curveIn: number,
  curveOut: number,
): number {
  let g = 1;
  if (fadeIn > 0 && local < fadeIn) g *= fadeGain(local / fadeIn, curveIn);
  const rem = dur - local;
  if (fadeOut > 0 && rem < fadeOut) g *= fadeGain(rem / fadeOut, curveOut);
  return g;
}

/** Zero-order hold: y[n] = x[floor(n * ratio)] */
export function sampleNearest(x: Float32Array, pos: number): number {
  return x[Math.floor(pos)];
}

/** Linear interpolation. */
export function sampleLinear(x: Float32Array, pos: number): number {
  const i = Math.floor(pos);
  const f = pos - i;
  const a = x[i];
  const b = i + 1 < x.length ? x[i + 1] : a;
  return a + (b - a) * f;
}

export const LP_OFF_HZ = 20000;

/** RBJ low-pass biquad coefficients [b0,b1,b2,a1,a2]; null when the filter is off. */
export function lowPassCoefs(hz: number, sampleRate: number, q = 0.9): number[] | null {
  if (hz >= LP_OFF_HZ) return null;
  const w0 = (2 * Math.PI * Math.min(hz, sampleRate * 0.45)) / sampleRate;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  const b1 = (1 - cos) / a0;
  return [b1 / 2, b1, b1 / 2, (-2 * cos) / a0, (1 - alpha) / a0];
}

export const HP_OFF_HZ = 20;

/** RBJ high-pass biquad coefficients [b0,b1,b2,a1,a2]; null when the filter is off. */
export function highPassCoefs(hz: number, sampleRate: number, q = 0.9): number[] | null {
  if (hz <= HP_OFF_HZ) return null;
  const w0 = (2 * Math.PI * Math.min(hz, sampleRate * 0.45)) / sampleRate;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  const b1 = -(1 + cos) / a0;
  return [-b1 / 2, b1, -b1 / 2, (-2 * cos) / a0, (1 - alpha) / a0];
}

export function mixObject(
  o: PlaybackObject,
  src: Float32Array[],
  f0: number,
  f1: number,
  L: Float32Array,
  R: Float32Array,
): void {
  const s = Math.max(o.startFrame, f0);
  const e = Math.min(o.startFrame + o.lengthFrames, f1);
  if (s >= e) return;
  const sl = src[0];
  const sr = src[1] ?? src[0];
  const len = sl.length;

  for (let f = s; f < e; f++) {
    const local = f - o.startFrame;
    const pos = o.trimFrame + (o.reverse ? o.lengthFrames - 1 - local : local) * o.ratio;
    const i = Math.floor(pos);
    if (i >= len || i < 0) continue;

    let l: number, r: number;
    if (o.linear) {
      const fr = pos - i;
      const i2 = i + 1 < len ? i + 1 : i;
      l = sl[i] + (sl[i2] - sl[i]) * fr;
      r = sr[i] + (sr[i2] - sr[i]) * fr;
    } else {
      l = sl[i];
      r = sr[i];
    }

    if (o.swap) {
      const t = l;
      l = r;
      r = t;
    }

    // Channel blend (applies after the swap, i.e. to what you hear): pan -0.25 mixes 25% of the left channel over the right (right keeps 75% of itself);
    // -1 = left channel on both sides, right's own signal gone. Mirrored for positive values.
    if (o.pan < 0) {
      const a = -o.pan;
      r = (1 - a) * r + a * l;
    } else if (o.pan > 0) {
      const a = o.pan;
      l = (1 - a) * l + a * r;
    }

    let g = o.gain;
    if (o.fadeInFrames > 0 && local < o.fadeInFrames) g *= fadeGain(local / o.fadeInFrames, o.fadeInCurve);
    const rem = o.lengthFrames - local;
    if (o.fadeOutFrames > 0 && rem < o.fadeOutFrames) g *= fadeGain(rem / o.fadeOutFrames, o.fadeOutCurve);

    const k = f - f0;
    L[k] += l * g;
    R[k] += r * g;
  }
}

/**
 * Master glue: one COMP knob lowers the threshold (-6..-36 dB), raises the ratio (4:1..12:1),
 * shortens the release (180..60 ms) and adds make-up gain and a little tanh warmth. Stereo-linked peak
 * detection blended 50/50 with a 30 ms RMS (the louder channel drives both), 5 ms attack, 6 dB soft knee, MIX = parallel blend,
 * tanh safety clipper at the end.
 */
export class MasterComp {
  private env = 0;
  private ms = 0; // running mean-square of the linked input (detector body)
  private readonly msCoef = Math.exp(-1 / (0.03 * 44100)); // 30 ms
  private strength = 0;
  private thresh = -6;
  private makeup = 1;
  private drive = 1;
  private relCoef = 0;
  private readonly atkCoef = Math.exp(-1 / (0.005 * 44100));
  private mix = 1;
  on = false;

  set(m: MasterSettings): void {
    if (m.on && !this.on) this.env = this.ms = 0; // switching on: start clean
    this.on = m.on;
    const c = Math.min(1, Math.max(0, m.comp));
    this.mix = Math.min(1, Math.max(0, m.mix));
    this.thresh = -6 - 30 * c;
    const ratio = 4 + 8 * c;
    this.strength = 1 - 1 / ratio;
    this.relCoef = Math.exp(-1 / ((0.18 - 0.12 * c) * 44100));
    this.makeup = Math.pow(10, (0.5 * -this.thresh * this.strength) / 20);
    this.drive = 1 + 0.5 * c;
  }

  process(L: Float32Array, R: Float32Array, n: number): void {
    const { atkCoef, relCoef, thresh, strength, makeup, drive, mix } = this;
    const norm = 1 / Math.tanh(drive);
    const { msCoef } = this;
    let env = this.env;
    let ms = this.ms;
    for (let k = 0; k < n; k++) {
      const l = L[k], r = R[k];
      const pk = Math.max(Math.abs(l), Math.abs(r));
      ms = msCoef * ms + (1 - msCoef) * pk * pk;
      // Detector = half peak, half RMS (x sqrt2 so a sustained tone reads like its peak): drum hits still lead,
      // but held melodic material counts too, so the whole mix pumps together.
      const sc = 0.5 * pk + 0.7071 * Math.sqrt(ms);
      const co = sc > env ? atkCoef : relCoef;
      env = co * env + (1 - co) * sc;
      const over = 20 * Math.log10(env > 1e-9 ? env : 1e-9) - thresh;
      const eff = over <= -3 ? 0 : over >= 3 ? over : ((over + 3) * (over + 3)) / 12; // soft knee
      const g = Math.pow(10, (-strength * eff) / 20) * makeup;
      L[k] = Math.tanh((Math.tanh(l * g * drive) * norm) * mix + l * (1 - mix));
      R[k] = Math.tanh((Math.tanh(r * g * drive) * norm) * mix + r * (1 - mix));
    }
    this.env = env;
    this.ms = ms;
  }
}

/**
 * Per-track mixer: objects -> track bus -> optional low-pass -> track gain/pan -> master (hard-clipped).
 * Track parameters can be replaced at any time (live mixer); gains ramp across each block to avoid zipper noise.
 * Filter state persists across blocks. Used by the AudioWorklet and the offline bounce.
 */
export class Mixer {
  private busL: Float32Array[] = [];
  private busR: Float32Array[] = [];
  private z: Float64Array[]; // per track: low-pass [zL1, zL2, zR1, zR2], then high-pass [4..7]
  private curL: Float64Array;
  private curR: Float64Array;
  private master = new MasterComp();

  constructor(
    private objects: PlaybackObject[],
    private assets: Float32Array[][],
    private tracks: PlaybackTrack[],
    master?: MasterSettings,
  ) {
    if (master) this.master.set(master);
    this.z = tracks.map(() => new Float64Array(8));
    this.curL = Float64Array.from(tracks, (t) => t.gL);
    this.curR = Float64Array.from(tracks, (t) => t.gR);
  }

  setMaster(m: MasterSettings): void {
    this.master.set(m);
  }

  setTracks(tracks: PlaybackTrack[]): void {
    if (tracks.length !== this.tracks.length) return;
    this.tracks.forEach((old, i) => {
      if (!old.lp && tracks[i].lp) this.z[i].fill(0, 0, 4); // filter switching on: start clean
      if (!old.hp && tracks[i].hp) this.z[i].fill(0, 4, 8);
    });
    this.tracks = tracks;
  }

  /** Adds frames [f0, f0+n) into L/R. */
  process(f0: number, L: Float32Array, R: Float32Array, n: number): void {
    const f1 = f0 + n;
    for (let t = 0; t < this.tracks.length; t++) {
      const { lp: c, hp: h, gL: tL, gR: tR } = this.tracks[t];
      if (this.curL[t] === 0 && this.curR[t] === 0 && tL === 0 && tR === 0) continue; // silent track

      if (!this.busL[t] || this.busL[t].length < n) {
        this.busL[t] = new Float32Array(n);
        this.busR[t] = new Float32Array(n);
      }
      const bl = this.busL[t], br = this.busR[t];
      bl.fill(0, 0, n);
      br.fill(0, 0, n);
      for (const o of this.objects) {
        if (o.track === t) mixObject(o, this.assets[o.asset], f0, f1, bl, br);
      }

      if (h) {
        const [b0, b1, b2, a1, a2] = h;
        const z = this.z[t];
        let l1 = z[4], l2 = z[5], r1 = z[6], r2 = z[7];
        for (let k = 0; k < n; k++) {
          const xl = bl[k], xr = br[k];
          const yl = b0 * xl + l1; l1 = b1 * xl - a1 * yl + l2; l2 = b2 * xl - a2 * yl; bl[k] = yl;
          const yr = b0 * xr + r1; r1 = b1 * xr - a1 * yr + r2; r2 = b2 * xr - a2 * yr; br[k] = yr;
        }
        z[4] = l1; z[5] = l2; z[6] = r1; z[7] = r2;
      }

      if (c) {
        const [b0, b1, b2, a1, a2] = c;
        const z = this.z[t];
        let l1 = z[0], l2 = z[1], r1 = z[2], r2 = z[3];
        for (let k = 0; k < n; k++) {
          const xl = bl[k], xr = br[k];
          const yl = b0 * xl + l1; l1 = b1 * xl - a1 * yl + l2; l2 = b2 * xl - a2 * yl; bl[k] = yl;
          const yr = b0 * xr + r1; r1 = b1 * xr - a1 * yr + r2; r2 = b2 * xr - a2 * yr; br[k] = yr;
        }
        z[0] = l1; z[1] = l2; z[2] = r1; z[3] = r2;
      }

      const sL = this.curL[t], sR = this.curR[t];
      const dL = (tL - sL) / n, dR = (tR - sR) / n;
      for (let k = 0; k < n; k++) {
        L[k] += bl[k] * (sL + dL * (k + 1));
        R[k] += br[k] * (sR + dR * (k + 1));
      }
      this.curL[t] = tL;
      this.curR[t] = tR;
    }
    if (this.master.on) this.master.process(L, R, n);
    for (let k = 0; k < n; k++) {
      L[k] = L[k] > 1 ? 1 : L[k] < -1 ? -1 : L[k];
      R[k] = R[k] > 1 ? 1 : R[k] < -1 ? -1 : R[k];
    }
  }
}
