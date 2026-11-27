import { store } from './store';
import { memory } from './memory';
import { AudioObject } from './types';
import { centsToRatio, envelope, fadeGain } from './dsp';
import { record } from './history';
import { MIN_DURATION, getPrimary, maxDuration, patchObjects, updateObject } from './actions';

export const RULER_H = 24;
export const TRACK_H = 154;
const PAD = 4;
const HS = 8; // handle size
const HIT = 7;
const BUCKET = 64;

type HandleKind = 'fadeIn' | 'fadeOut' | 'gain' | 'trimIn' | 'trimOut' | 'stretch';
type DragKind = HandleKind | 'move' | 'scrub' | 'marquee';

interface Drag {
  kind: DragKind;
  id: string;
  sx: number;
  sy: number;
  orig: AudioObject;
  origs?: AudioObject[]; // all objects moved together
  moved?: boolean;
  recorded?: boolean; // undo snapshot taken for this drag
  collapseOnUp?: boolean; // click (no drag) on a multi-selected object -> select just it
  additive?: boolean; // marquee with shift
  base?: string[]; // selection before an additive marquee
}

interface Marquee { x0: number; y0: number; x1: number; y1: number }

interface Peaks {
  min: Float32Array;
  max: Float32Array;
}

const CURSORS: Record<HandleKind, string> = {
  fadeIn: 'nesw-resize',
  fadeOut: 'nwse-resize',
  gain: 'ns-resize',
  trimIn: 'ew-resize',
  trimOut: 'ew-resize',
  stretch: 'ew-resize',
};

export class Timeline {
  private g: CanvasRenderingContext2D;
  private pps = 100; // pixels per second
  private scrollX = 0;
  private width = 800;
  private drag: Drag | null = null;
  private marquee: Marquee | null = null;
  snapOn = true;
  private dpr = 1;
  private guide: number | null = null; // timeline seconds of the active snap line
  private peaks = new Map<string, Peaks>();
  onLockedAttempt: () => void = () => {};
  onView: () => void = () => {}; // called after every draw so the scrollbar can follow

  /** The vertically scrolling container: the ruler is drawn at its scroll offset so the lanes pass under it. */
  private scroller: HTMLElement | null;

  private get top(): number {
    return Math.max(0, this.scroller?.scrollTop ?? 0);
  }

  constructor(private canvas: HTMLCanvasElement, private wrap: HTMLElement) {
    this.g = canvas.getContext('2d')!;
    this.scroller = wrap.closest<HTMLElement>('#main');
    this.scroller?.addEventListener('scroll', () => this.draw());
    new ResizeObserver(() => this.resize()).observe(wrap);
    canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    canvas.addEventListener('pointermove', (e) => this.onMove(e));
    canvas.addEventListener('pointerup', (e) => this.onUp(e));
    canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    store.subscribe(() => this.draw());
    this.resize();
  }

  zoomBy(factor: number, cx = this.width / 2): void {
    const t = (cx + this.scrollX) / this.pps;
    this.pps = Math.min(40000, Math.max(5, this.pps * factor));
    this.scrollX = Math.max(0, t * this.pps - cx);
    this.draw();
  }

  get scrollPx(): number {
    return this.scrollX;
  }

  setScrollPx(px: number): void {
    const v = Math.max(0, px);
    if (v === this.scrollX) return;
    this.scrollX = v;
    this.draw();
  }

  /** Total scrollable width: last object end (or playhead) plus a generous tail. */
  contentPx(): number {
    const s = store.get();
    const end = Math.max(s.playheadPosition, ...s.objects.map((o) => o.startTime + o.duration), 0);
    return Math.max(Math.ceil((end + 30) * this.pps), this.width + 1);
  }

  get viewWidth(): number {
    return this.width;
  }

  setSnap(on: boolean): void {
    this.snapOn = on;
  }

  /** Nearest snap target (other objects' edges, playhead, 0) within ~8px of `t`, else null. */
  private snapTime(t: number, exclude: string[]): number | null {
    const s = store.get();
    let best: number | null = null;
    let bestD = 8 / this.pps;
    const consider = (c: number) => {
      const d = Math.abs(c - t);
      if (d <= bestD) { bestD = d; best = c; }
    };
    consider(0);
    consider(s.playheadPosition);
    for (const o of s.objects) {
      if (exclude.includes(o.id)) continue;
      consider(o.startTime);
      consider(o.startTime + o.duration);
    }
    return best;
  }

  private resize(): void {
    const dpr = window.devicePixelRatio || 1;
    this.dpr = dpr;
    this.width = Math.max(200, this.wrap.clientWidth);
    const h = RULER_H + store.get().tracks.length * TRACK_H;
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${h}px`;
    this.canvas.width = Math.round(this.width * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  // ---------- geometry ----------
  private t2x = (t: number) => t * this.pps - this.scrollX;
  private x2t = (x: number) => (x + this.scrollX) / this.pps;
  private laneIndex(trackId: string) {
    return store.get().tracks.findIndex((t) => t.id === trackId);
  }
  private rect(o: AudioObject) {
    const x0 = this.t2x(o.startTime);
    const x1 = this.t2x(o.startTime + o.duration);
    const y0 = RULER_H + this.laneIndex(o.trackId) * TRACK_H + PAD;
    return { x0, x1, y0, y1: y0 + TRACK_H - PAD * 2 };
  }
  private handles(o: AudioObject): Record<HandleKind, { x: number; y: number }> {
    const r = this.rect(o);
    return {
      fadeIn: { x: r.x0 + o.fadeInTime * this.pps, y: r.y0 },
      fadeOut: { x: r.x1 - o.fadeOutTime * this.pps, y: r.y0 },
      gain: { x: (r.x0 + r.x1) / 2, y: r.y0 },
      trimIn: { x: r.x0, y: r.y1 },
      trimOut: { x: r.x1, y: r.y1 },
      stretch: { x: r.x1, y: (r.y0 + r.y1) / 2 },
    };
  }

  // ---------- peaks ----------
  private getPeaks(assetId: string): Peaks | null {
    let p = this.peaks.get(assetId);
    if (p) return p;
    const asset = memory.get(assetId);
    if (!asset) return null;
    const b = asset.buffer;
    const n = Math.ceil(b.length / BUCKET);
    const min = new Float32Array(n);
    const max = new Float32Array(n);
    const chans = Array.from({ length: Math.min(2, b.numberOfChannels) }, (_, c) => b.getChannelData(c));
    for (let i = 0; i < n; i++) {
      let lo = 1, hi = -1;
      const end = Math.min(b.length, (i + 1) * BUCKET);
      for (let k = i * BUCKET; k < end; k++) {
        let v = 0;
        for (const ch of chans) v += ch[k];
        v /= chans.length;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      min[i] = lo;
      max[i] = hi;
    }
    p = { min, max };
    this.peaks.set(assetId, p);
    return p;
  }

  // ---------- drawing ----------
  draw(): void {
    const g = this.g;
    const s = store.get();
    const W = this.width;
    const H = RULER_H + s.tracks.length * TRACK_H;
    g.clearRect(0, 0, W, H);

    // lanes (sunken)
    s.tracks.forEach((t, i) => {
      const y = RULER_H + i * TRACK_H;
      g.fillStyle = '#2b2b2b';
      g.fillRect(0, y, W, TRACK_H);
      g.fillStyle = '#000';
      g.fillRect(0, y, W, 1);
      g.fillStyle = '#fff';
      g.fillRect(0, y + TRACK_H - 1, W, 1);
      void t;
    });

    this.drawGrid(W, H);
    if (s.objects.length === 0) {
      g.save();
      g.font = '14px "MS Sans Serif", Tahoma, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillStyle = '#9a9a9a';
      const vw = this.wrap.clientWidth || W;
      g.fillText('Drop a WAV here, then press ? for help', Math.min(vw, W) / 2, RULER_H + (s.tracks.length * TRACK_H) / 2);
      g.restore();
    }
    const single = s.selectedIds.length === 1;
    for (const o of s.objects) {
      const sel = s.selectedIds.includes(o.id);
      this.drawObject(o, sel, sel && single && !s.isPlaying);
    }
    if (this.marquee) {
      const m = this.marquee;
      g.save();
      g.strokeStyle = '#fff';
      g.setLineDash([3, 3]);
      g.strokeRect(Math.min(m.x0, m.x1) + 0.5, Math.min(m.y0, m.y1) + 0.5, Math.abs(m.x1 - m.x0), Math.abs(m.y1 - m.y0));
      g.restore();
    }
    if (this.guide !== null) {
      const gx = Math.round(this.t2x(this.guide));
      g.save();
      g.strokeStyle = '#00ffff';
      g.setLineDash([4, 3]);
      g.beginPath();
      g.moveTo(gx + 0.5, RULER_H);
      g.lineTo(gx + 0.5, H);
      g.stroke();
      g.restore();
    }
    const top = this.top;
    g.save();
    g.translate(0, top);
    this.drawRuler(W);
    g.restore();

    // playhead
    const px = this.t2x(s.playheadPosition);
    if (px >= 0 && px <= W) {
      g.fillStyle = '#ff2a2a';
      g.fillRect(Math.round(px), 0, 1, H);
      g.beginPath();
      g.moveTo(px - 5, top); g.lineTo(px + 6, top); g.lineTo(px + 0.5, top + 9);
      g.fill();
    }
    if (s.isPlaying && (px > W - 40 || px < 0)) {
      this.scrollX = Math.max(0, s.playheadPosition * this.pps - 40);
    }
    this.onView();
  }

  private tickStep(): number {
    const steps = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
    return steps.find((s) => s * this.pps >= 70) ?? 300;
  }

  private drawGrid(W: number, H: number): void {
    const g = this.g;
    const step = this.tickStep();
    g.fillStyle = '#3d3d3d';
    for (let t = Math.floor(this.x2t(0) / step) * step; this.t2x(t) < W; t += step) {
      g.fillRect(Math.round(this.t2x(t)), RULER_H, 1, H - RULER_H);
    }
  }

  private drawRuler(W: number): void {
    const g = this.g;
    g.fillStyle = '#c0c0c0';
    g.fillRect(0, 0, W, RULER_H);
    g.fillStyle = '#fff'; g.fillRect(0, 0, W, 1);
    g.fillStyle = '#808080'; g.fillRect(0, RULER_H - 2, W, 1);
    g.fillStyle = '#000'; g.fillRect(0, RULER_H - 1, W, 1);
    const step = this.tickStep();
    g.fillStyle = '#000';
    g.font = '10px "MS Sans Serif", Tahoma, sans-serif';
    g.textBaseline = 'middle';
    for (let t = Math.floor(this.x2t(0) / step) * step; this.t2x(t) < W; t += step) {
      const x = Math.round(this.t2x(t));
      g.fillRect(x, RULER_H - 8, 1, 6);
      g.fillText(fmtRuler(t, step), x + 3, RULER_H / 2 - 2);
    }
  }

  private drawObject(o: AudioObject, selected: boolean, showHandles: boolean): void {
    const g = this.g;
    const r = this.rect(o);
    if (r.x1 < 0 || r.x0 > this.width) return;
    const w = r.x1 - r.x0;
    const h = r.y1 - r.y0;
    const track = store.get().tracks.find((t) => t.id === o.trackId);
    const dim = track?.isMuted || o.isMuted ? 0.3 : 1;

    g.save();
    g.beginPath();
    g.rect(r.x0, r.y0, w, h);
    g.clip();
    g.fillStyle = '#000';
    g.fillRect(r.x0, r.y0, w, h);

    // waveform
    const asset0 = memory.get(o.assetId);
    const pk = this.getPeaks(o.assetId);
    if (asset0 && pk) {
      const buf = asset0.buffer;
      const sr = asset0.rate;
      const ratio = centsToRatio(o.pitchShiftCents);
      const mid = r.y0 + h / 2;
      const amp = h / 2 - 2;
      const color = o.resampleMode === 'nearest' ? '#ffb000' : '#33ff66';
      const spp = (ratio * sr) / this.pps; // source samples per CSS pixel
      const step = 1 / this.dpr; // one device pixel in CSS px
      const xa = Math.max(0, Math.floor(r.x0));
      const xb = Math.min(this.width, Math.ceil(r.x1));
      const chans = Array.from({ length: Math.min(2, buf.numberOfChannels) }, (_, c) => buf.getChannelData(c));
      const sampleAt = (i: number): number => {
        if (i < 0 || i >= buf.length) return 0;
        let v = 0;
        for (const ch of chans) v += ch[i];
        return v / chans.length;
      };
      const envAt = (t: number) =>
        o.gain * envelope(t, o.duration, o.fadeInTime, o.fadeOutTime, o.fadeInCurve, o.fadeOutCurve);
      const srcPos = (t: number) => (o.trimStart + (o.reverse ? o.duration - t : t) * ratio) * sr;

      g.globalAlpha = dim;
      g.fillStyle = color;
      g.strokeStyle = color;
      if (spp < 4) {
        // Sample level: thin 1-device-pixel line through the real (interpolated) samples.
        g.lineWidth = step;
        g.beginPath();
        let first = true;
        for (let x = xa; x <= xb; x += step) {
          const t = clamp((x - r.x0) / this.pps, 0, o.duration);
          const p = srcPos(t);
          const i = Math.floor(p);
          const f = p - i;
          const v = sampleAt(i) * (1 - f) + sampleAt(i + 1) * f;
          const y = clamp(mid - v * envAt(t) * amp, r.y0, r.y1);
          if (first) { g.moveTo(x, y); first = false; } else g.lineTo(x, y);
        }
        g.stroke();
        if (spp <= 1 / 6) {
          // Very close: show the individual sample points.
          const p0 = srcPos(clamp((xa - r.x0) / this.pps, 0, o.duration));
          const p1 = srcPos(clamp((xb - r.x0) / this.pps, 0, o.duration));
          for (let i = Math.floor(Math.min(p0, p1)); i <= Math.ceil(Math.max(p0, p1)); i++) {
            const u = (i / sr - o.trimStart) / ratio;
            if (u < 0 || u > o.duration) continue;
            const t = o.reverse ? o.duration - u : u;
            const x = r.x0 + t * this.pps;
            const y = clamp(mid - sampleAt(i) * envAt(t) * amp, r.y0, r.y1);
            g.fillRect(x - step * 1.5, y - step * 1.5, step * 3, step * 3);
          }
        }
      } else if (spp < BUCKET) {
        // Zoomed in: exact min/max of the real samples per DEVICE pixel column.
        for (let x = xa; x < xb; x += step) {
          const t0 = Math.max(0, (x - r.x0) / this.pps);
          const t1 = Math.min(o.duration, (x + step - r.x0) / this.pps);
          if (t1 < t0) continue;
          const [p0, p1] = [srcPos(t0), srcPos(t1)];
          const i0 = Math.floor(Math.min(p0, p1));
          const i1 = Math.floor(Math.max(p0, p1)) + 1; // include next sample: no gaps between columns
          let lo = 1, hi = -1;
          for (let i = i0; i <= i1; i++) {
            const v = sampleAt(i);
            if (v < lo) lo = v;
            if (v > hi) hi = v;
          }
          const env = envAt((t0 + t1) / 2);
          const yTop = Math.max(r.y0, mid - hi * env * amp);
          const yBot = Math.min(r.y1, mid - lo * env * amp);
          g.fillRect(x, yTop, step, Math.max(step, yBot - yTop));
        }
      } else {
        // Zoomed out: precomputed 64-sample peaks, one CSS pixel per column.
        for (let x = xa; x < xb; x++) {
          const t0 = Math.max(0, (x - r.x0) / this.pps);
          const t1 = Math.min(o.duration, (x + 1 - r.x0) / this.pps);
          const [u0, u1] = o.reverse ? [o.duration - t1, o.duration - t0] : [t0, t1];
          const b0 = Math.max(0, Math.floor(((o.trimStart + u0 * ratio) * sr) / BUCKET));
          const b1 = Math.min(pk.min.length - 1, Math.max(b0, Math.floor(((o.trimStart + u1 * ratio) * sr) / BUCKET)));
          let lo = 1, hi = -1;
          for (let b = b0; b <= b1; b++) {
            if (pk.min[b] < lo) lo = pk.min[b];
            if (pk.max[b] > hi) hi = pk.max[b];
          }
          if (hi < lo) continue;
          const env = envAt((t0 + t1) / 2);
          const yTop = Math.max(r.y0, mid - hi * env * amp);
          const yBot = Math.min(r.y1, mid - lo * env * amp);
          g.fillRect(x, yTop, 1, Math.max(1, yBot - yTop));
        }
      }
      g.globalAlpha = 1;
    }

    // fade lines
    g.strokeStyle = '#fff';
    g.lineWidth = 1;
    if (o.fadeInTime > 0) this.fadeLine(r.x0, r.y1, o.fadeInTime * this.pps, h, o.fadeInCurve, false);
    if (o.fadeOutTime > 0) this.fadeLine(r.x1, r.y1, o.fadeOutTime * this.pps, h, o.fadeOutCurve, true);

    // label
    const asset = memory.get(o.assetId);
    g.fillStyle = '#000080';
    g.fillRect(r.x0, r.y0, Math.min(w, 160), 13);
    g.fillStyle = '#fff';
    g.font = '10px "MS Sans Serif", Tahoma, sans-serif';
    g.textBaseline = 'middle';
    const tags = `${o.gain !== 1 ? ` ${(o.gain * 100).toFixed(0)}%` : ''}${o.pitchShiftCents ? ` ${o.pitchShiftCents > 0 ? '+' : ''}${o.pitchShiftCents}c` : ''}${o.reverse ? ' REV' : ''}${o.swap ? ' SWAP' : ''}${o.isMuted ? ' MUTE' : ''}${o.pan ? ` P${o.pan < 0 ? 'L' : 'R'}${Math.round(Math.abs(o.pan) * 100)}` : ''}`;
    g.fillText(`${asset?.name ?? '?'}${tags}`, r.x0 + 3, r.y0 + 7, 154);
    g.restore();

    // border
    g.strokeStyle = selected ? '#ffff00' : '#c0c0c0';
    g.lineWidth = selected ? 2 : 1;
    g.strokeRect(r.x0 + 0.5, r.y0 + 0.5, w - 1, h - 1);

    if (showHandles) {
      const hs = this.handles(o);
      for (const k of Object.keys(hs) as HandleKind[]) {
        const p = hs[k];
        g.fillStyle = '#c0c0c0';
        g.fillRect(p.x - HS / 2, p.y - HS / 2, HS, HS);
        g.strokeStyle = '#000';
        g.lineWidth = 1;
        g.strokeRect(p.x - HS / 2 + 0.5, p.y - HS / 2 + 0.5, HS - 1, HS - 1);
        g.fillStyle = '#fff';
        g.fillRect(p.x - HS / 2 + 1, p.y - HS / 2 + 1, HS - 3, 1);
        g.fillRect(p.x - HS / 2 + 1, p.y - HS / 2 + 1, 1, HS - 3);
      }
    }
  }

  private fadeLine(xEdge: number, yBottom: number, wPx: number, h: number, curve: number, mirror: boolean): void {
    const g = this.g;
    g.beginPath();
    const steps = Math.max(2, Math.min(40, Math.floor(wPx / 3)));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const dx = t * wPx;
      const x = mirror ? xEdge - dx : xEdge + dx;
      const y = yBottom - fadeGain(t, curve) * h;
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.stroke();
  }

  // ---------- interaction ----------
  private pos(e: PointerEvent) {
    const b = this.canvas.getBoundingClientRect();
    return { x: e.clientX - b.left, y: e.clientY - b.top };
  }

  private hitHandle(x: number, y: number): { kind: HandleKind; o: AudioObject } | null {
    const s = store.get();
    if (s.selectedIds.length !== 1) return null; // handles only for a single selection
    const o = getPrimary(s);
    if (!o) return null;
    const hs = this.handles(o);
    for (const k of ['fadeIn', 'fadeOut', 'gain', 'trimIn', 'trimOut', 'stretch'] as HandleKind[]) {
      if (Math.abs(x - hs[k].x) <= HIT && Math.abs(y - hs[k].y) <= HIT) return { kind: k, o };
    }
    return null;
  }

  private hitObject(x: number, y: number): AudioObject | null {
    const objs = store.get().objects;
    for (let i = objs.length - 1; i >= 0; i--) {
      const r = this.rect(objs[i]);
      if (x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1) return objs[i];
    }
    return null;
  }

  private onDown(e: PointerEvent): void {
    const { x, y } = this.pos(e);
    const s = store.get();
    // Playback lock: all pointer editing is intercepted while playing.
    if (s.isPlaying) {
      this.onLockedAttempt();
      return;
    }
    this.canvas.setPointerCapture(e.pointerId);

    if (y < this.top + RULER_H) {
      this.drag = { kind: 'scrub', id: '', sx: x, sy: y, orig: null as unknown as AudioObject };
      store.set({ playheadPosition: Math.max(0, this.x2t(x)) });
      return;
    }
    const h = this.hitHandle(x, y);
    if (h) {
      this.drag = { kind: h.kind, id: h.o.id, sx: x, sy: y, orig: h.o };
      return;
    }
    const o = this.hitObject(x, y);
    const add = e.shiftKey || e.metaKey || e.ctrlKey;
    if (o) {
      const inSel = s.selectedIds.includes(o.id);
      if (add && inSel) {
        store.set({ selectedIds: s.selectedIds.filter((i) => i !== o.id) });
        return;
      }
      let ids = s.selectedIds;
      let collapse = false;
      if (add) ids = [...ids, o.id];
      else if (!inSel) ids = [o.id];
      else if (ids.length > 1) collapse = true;
      // keep the clicked object as primary (last)
      ids = [...ids.filter((i) => i !== o.id), o.id];
      store.set({ selectedIds: ids });
      const origs = store.get().objects.filter((v) => ids.includes(v.id));
      this.drag = { kind: 'move', id: o.id, sx: x, sy: y, orig: o, origs, collapseOnUp: collapse };
    } else {
      // empty space: drag = rubber-band select, plain click = deselect + set playhead
      this.drag = {
        kind: 'marquee', id: '', sx: x, sy: y, orig: null as unknown as AudioObject,
        additive: add, base: add ? s.selectedIds : [],
      };
    }
  }

  private onMove(e: PointerEvent): void {
    const { x, y } = this.pos(e);
    const s = store.get();
    if (s.isPlaying) {
      this.canvas.style.cursor = 'not-allowed';
      return;
    }
    const d = this.drag;
    if (!d) {
      const h = this.hitHandle(x, y);
      this.canvas.style.cursor = h ? CURSORS[h.kind] : y < this.top + RULER_H ? 'col-resize' : this.hitObject(x, y) ? 'move' : 'default';
      return;
    }
    const dx = x - d.sx;
    const dy = y - d.sy;
    if (!d.moved && Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
    // One undo step per drag, snapshotted just before the first change.
    if (!d.recorded && d.kind !== 'scrub' && d.kind !== 'marquee' && (d.kind !== 'move' || d.moved)) {
      record();
      d.recorded = true;
    }
    const dt = dx / this.pps;
    const o = d.orig;
    const ratio = centsToRatio(o?.pitchShiftCents ?? 0);
    const snapping = this.snapOn && !e.altKey;
    this.guide = null;
    // Edge-drag handles: snap the moving edge, then express it as a delta again.
    const snapEdge = (edge: number): number => {
      if (!snapping) return edge;
      const sn = this.snapTime(edge, [o.id]);
      if (sn === null) return edge;
      this.guide = sn;
      return sn;
    };

    switch (d.kind) {
      case 'scrub':
        store.set({ playheadPosition: Math.max(0, this.x2t(x)) });
        break;
      case 'marquee': {
        if (!d.moved) break;
        this.marquee = { x0: d.sx, y0: d.sy, x1: x, y1: y };
        const m = this.marquee;
        const [xa, xb] = [Math.min(m.x0, m.x1), Math.max(m.x0, m.x1)];
        const [ya, yb] = [Math.min(m.y0, m.y1), Math.max(m.y0, m.y1)];
        const hit = s.objects
          .filter((v) => {
            const r = this.rect(v);
            return r.x1 >= xa && r.x0 <= xb && r.y1 >= ya && r.y0 <= yb;
          })
          .map((v) => v.id);
        store.set({ selectedIds: [...new Set([...(d.base ?? []), ...hit])] });
        break;
      }
      case 'move': {
        if (!d.moved) break;
        const origs = d.origs ?? [o];
        const n = s.tracks.length;
        const lane = Math.min(n - 1, Math.max(0, Math.floor((y - RULER_H) / TRACK_H)));
        const lanes = origs.map((v) => this.laneIndex(v.trackId));
        let dLane = lane - this.laneIndex(o.trackId);
        dLane = clamp(dLane, -Math.min(...lanes), n - 1 - Math.max(...lanes));
        const minStart = Math.min(...origs.map((v) => v.startTime));
        let dT = Math.max(dt, -minStart);
        if (snapping) {
          // Snap whichever edge (start or end) of any moved object lands closest to a target.
          const ids = origs.map((v) => v.id);
          let bestAdj: number | null = null;
          let bestTarget = 0;
          for (const v of origs) {
            for (const edge of [v.startTime + dT, v.startTime + v.duration + dT]) {
              const sn = this.snapTime(edge, ids);
              if (sn !== null && (bestAdj === null || Math.abs(sn - edge) < Math.abs(bestAdj))) {
                bestAdj = sn - edge;
                bestTarget = sn;
              }
            }
          }
          if (bestAdj !== null) {
            dT = Math.max(dT + bestAdj, -minStart);
            this.guide = bestTarget;
          }
        }
        patchObjects(
          new Map(
            origs.map((v) => [
              v.id,
              { startTime: v.startTime + dT, trackId: s.tracks[this.laneIndex(v.trackId) + dLane].id },
            ]),
          ),
        );
        break;
      }
      case 'fadeIn':
        updateObject(d.id, {
          fadeInTime: Math.max(0, o.fadeInTime + dt),
          fadeInCurve: clamp(o.fadeInCurve + dy / (TRACK_H * 0.6), 0, 1),
        });
        break;
      case 'fadeOut':
        updateObject(d.id, {
          fadeOutTime: Math.max(0, o.fadeOutTime - dt),
          fadeOutCurve: clamp(o.fadeOutCurve + dy / (TRACK_H * 0.6), 0, 1),
        });
        break;
      case 'gain':
        updateObject(d.id, { gain: clamp(o.gain - dy / (TRACK_H * 0.5), 0, 2) });
        break;
      case 'stretch': {
        // Tape-style: the source window stays fixed, length change => pitch change.
        const win = o.duration * ratio; // source seconds being played
        const want = Math.max(MIN_DURATION, snapEdge(o.startTime + o.duration + dt) - o.startTime);
        const cents = clamp(Math.round(1200 * Math.log2(win / want)), -1200, 1200);
        updateObject(d.id, { pitchShiftCents: cents, duration: win / centsToRatio(cents) });
        break;
      }
      case 'trimIn': {
        // Reversed: the left edge is the END of the source window, so trimStart stays put.
        const room = o.reverse ? maxDuration(o) - o.duration : o.trimStart / ratio;
        const lo = Math.max(-room, -o.startTime);
        const hi = o.duration - MIN_DURATION;
        const t = clamp(snapEdge(o.startTime + dt) - o.startTime, lo, hi);
        updateObject(d.id, {
          startTime: o.startTime + t,
          trimStart: o.reverse ? o.trimStart : o.trimStart + t * ratio,
          duration: o.duration - t,
        });
        break;
      }
      case 'trimOut': {
        // Reversed: the right edge is the START of the source window.
        const max = o.reverse ? o.duration + o.trimStart / ratio : maxDuration(o);
        const dur = clamp(snapEdge(o.startTime + o.duration + dt) - o.startTime, MIN_DURATION, Math.max(MIN_DURATION, max));
        updateObject(d.id, {
          duration: dur,
          trimStart: o.reverse ? o.trimStart + (o.duration - dur) * ratio : o.trimStart,
        });
        break;
      }
    }
  }

  private onUp(e: PointerEvent): void {
    const d = this.drag;
    if (d && !d.moved) {
      if (d.kind === 'marquee') {
        const { x } = this.pos(e);
        store.set({ selectedIds: d.additive ? store.get().selectedIds : [], playheadPosition: Math.max(0, this.x2t(x)) });
      } else if (d.kind === 'move' && d.collapseOnUp) {
        store.set({ selectedIds: [d.id] });
      }
    }
    this.marquee = null;
    this.guide = null;
    this.drag = null;
    this.draw();
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      this.zoomBy(Math.exp(-e.deltaY * 0.01), this.pos(e as unknown as PointerEvent).x);
    } else {
      this.scrollX = Math.max(0, this.scrollX + (e.deltaX || e.deltaY));
      this.draw();
    }
  }

  rewind(): void {
    this.scrollX = 0;
    this.draw();
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function fmtRuler(t: number, step: number): string {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  const dec = step < 1 ? (step < 0.01 ? 3 : step < 0.1 ? 2 : 1) : 0;
  return `${m}:${s.toFixed(dec).padStart(dec ? dec + 3 : 2, '0')}`;
}
