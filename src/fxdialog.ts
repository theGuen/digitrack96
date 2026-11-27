import { EFFECTS, FxDef, FxParam, runFx, tailSeconds } from './fx';
import { eqCurve, EQ_MIN_HZ, EQ_MAX_HZ, EQ_RANGE_DB } from './eq';
import { getPrimary, getSelected } from './actions';
import { memory } from './memory';
import { getContext } from './engine';
import { renderObject } from './freeze';
import { applyFxToSelection } from './fxapply';
import { SAMPLE_RATE } from './types';

const WAVE_H = 120; // css px

/** FX dialog: pick an effect, set up to four values, preview the selected object through it, apply to render a new sample. */
export function showFx(onDone: (msg: string) => void): void {
  const primary = getPrimary();
  const asset = primary && memory.get(primary.assetId);
  if (!primary || !asset) return;
  const count = getSelected().length;
  const srcData: Float32Array[] = renderObject(primary, asset); // the object as shown, at 44.1 kHz

  const root = document.getElementById('dialog-root')!;
  root.innerHTML = `
    <div class="overlay"><div class="dialog rec fx win95-panel" role="dialog" aria-label="FX">
      <div class="titlebar"><span>FX</span></div>
      <div class="rec-body">
        <label class="rec-row">Effect <select id="fx-sel" class="win95-select">${EFFECTS.map((d) => `<option value="${d.id}">${d.name}</option>`).join('')}</select></label>
        <div class="win95-inset rec-wave"><canvas id="fx-wave"></canvas></div>
        <div class="rec-row"><span class="rec-meter win95-inset"><i id="fx-pos"></i></span><span id="fx-time" class="rec-time"></span></div>
        <div class="win95-inset rec-wave fxcurve-wrap" id="fx-curve-wrap" hidden><canvas id="fx-curve"></canvas></div>
        <div class="fxknobs" id="fx-knobs"></div>
        <div id="fx-msg" class="rec-msg"></div>
      </div>
      <div class="actions">
        <button class="win95-button" id="fx-apply">Apply</button>
        <button class="win95-button" id="fx-prev">▶ Preview</button>
        <button class="win95-button" id="fx-close">Close</button>
      </div>
    </div></div>`;
  const $ = <T extends HTMLElement>(id: string) => root.querySelector<T>('#' + id)!;
  const sel = $<HTMLSelectElement>('fx-sel');
  const wave = $<HTMLCanvasElement>('fx-wave');
  const curve = $<HTMLCanvasElement>('fx-curve');
  const curveWrap = $('fx-curve-wrap');
  const knobs = $('fx-knobs');
  const posBar = $('fx-pos');
  const timeEl = $('fx-time');
  const msg = $('fx-msg');
  const applyBtn = $<HTMLButtonElement>('fx-apply');
  const prevBtn = $<HTMLButtonElement>('fx-prev');

  let def: FxDef = EFFECTS[0];
  let values = def.params.map((p) => p.init);
  let shown: Float32Array[] = srcData; // the object, or the effect's result after a preview
  let src: AudioBufferSourceNode | null = null;
  let t0 = 0;
  let dur = 0;
  let raf = 0;
  let token = 0;
  let timer = 0;
  let busy = false;
  let closed = false;

  const say = (t: string) => { msg.textContent = t; };
  const fmtT = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;

  // ---------- waveform (device-pixel columns, peaks cached so the playhead can animate cheaply) ----------
  let peaks: { data: Float32Array[]; w: number; lo: Float32Array; hi: Float32Array } | null = null;
  function drawWave(progress: number | null): void {
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(1, Math.round(wave.clientWidth * dpr));
    const H = Math.round(WAVE_H * dpr);
    if (wave.width !== W || wave.height !== H) { wave.width = W; wave.height = H; }
    const g = wave.getContext('2d')!;
    g.fillStyle = '#000';
    g.fillRect(0, 0, W, H);
    if (!peaks || peaks.data !== shown || peaks.w !== W) {
      const n = shown[0].length;
      const lo = new Float32Array(W), hi = new Float32Array(W);
      for (let x = 0; x < W; x++) {
        const i0 = Math.floor((x * n) / W);
        const i1 = Math.max(i0 + 1, Math.floor(((x + 1) * n) / W));
        let a = 1, b = -1;
        for (let i = i0; i < i1 && i < n; i++) {
          let v = 0;
          for (const ch of shown) v += ch[i];
          v /= shown.length;
          if (v < a) a = v;
          if (v > b) b = v;
        }
        lo[x] = a; hi[x] = b;
      }
      peaks = { data: shown, w: W, lo, hi };
    }
    const mid = H / 2, amp = mid - 2 * dpr;
    g.fillStyle = '#33ff66';
    for (let x = 0; x < W; x++) {
      if (peaks.hi[x] < peaks.lo[x]) continue;
      g.fillRect(x, mid - peaks.hi[x] * amp, 1, Math.max(1, (peaks.hi[x] - peaks.lo[x]) * amp));
    }
    if (progress !== null) {
      g.fillStyle = '#fff';
      g.fillRect(Math.round(progress * W), 0, Math.max(1, Math.round(dpr)), H);
    }
  }

  // ---------- sliders ----------
  const fmt = (p: { step: number; unit: string }, v: number) => `${p.step < 1 ? v.toFixed(p.step < 0.1 ? 2 : 1) : Math.round(v)}${p.unit ? ' ' + p.unit : ''}`;
  // log-scaled sliders (frequencies) run 0..1000 internally
  const toPos = (p: FxParam, v: number) => (p.log ? (1000 * Math.log(v / p.min)) / Math.log(p.max / p.min) : v);
  const fromPos = (p: FxParam, x: number) => (p.log ? Math.round(p.min * Math.pow(p.max / p.min, x / 1000)) : x);
  const inputs: HTMLInputElement[] = [], outs: HTMLOutputElement[] = [];

  function sync(): void {
    def.params.forEach((p, i) => { inputs[i].value = String(toPos(p, values[i])); outs[i].textContent = fmt(p, values[i]); });
    drawCurve();
  }
  function changed(): void {
    drawCurve();
    if (src) { clearTimeout(timer); timer = window.setTimeout(() => void preview(), 120); } // live: re-render while playing
  }
  function buildKnobs(): void {
    knobs.innerHTML = '';
    inputs.length = outs.length = 0;
    curveWrap.hidden = !def.curve;
    knobs.classList.toggle('two', !!def.curve);
    def.params.forEach((p, i) => {
      const row = document.createElement('label');
      row.className = 'fxknob';
      row.innerHTML = `<span>${p.label}</span><input type="range" min="${p.log ? 0 : p.min}" max="${p.log ? 1000 : p.max}" step="${p.log ? 1 : p.step}" value="${toPos(p, values[i])}" /><output></output>`;
      const input = row.querySelector('input')!, out = row.querySelector('output')!;
      inputs[i] = input; outs[i] = out;
      out.textContent = fmt(p, values[i]);
      input.addEventListener('input', () => {
        values[i] = fromPos(p, +input.value);
        out.textContent = fmt(p, values[i]);
        changed();
      });
      knobs.append(row);
    });
    drawCurve();
  }

  // ---------- spline curve editor (Spline EQ): drag the four points, x = frequency (log), y = gain ----------
  const cx = (hz: number, w: number) => (Math.log(hz / EQ_MIN_HZ) / Math.log(EQ_MAX_HZ / EQ_MIN_HZ)) * w;
  const cy = (db: number, h: number) => h / 2 - (db / EQ_RANGE_DB) * (h / 2 - 8);
  const COLORS = ['#ff4d4d', '#ffb02e', '#33ff66', '#4da3ff'];
  function drawCurve(): void {
    if (!def.curve) return;
    const dpr = window.devicePixelRatio || 1, w = curve.clientWidth, h = curve.clientHeight;
    if (!w) return;
    if (curve.width !== Math.round(w * dpr) || curve.height !== Math.round(h * dpr)) { curve.width = Math.round(w * dpr); curve.height = Math.round(h * dpr); }
    const g = curve.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#000'; g.fillRect(0, 0, w, h);
    g.font = '10px "MS Sans Serif", Tahoma, sans-serif'; g.textAlign = 'left';
    for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
      g.fillStyle = '#2b2b2b'; g.fillRect(Math.round(cx(f, w)), 0, 1, h);
      g.fillStyle = '#808080'; g.fillText(f >= 1000 ? f / 1000 + 'k' : String(f), cx(f, w) + 2, h - 3);
    }
    for (const d of [-12, -6, 0, 6, 12]) {
      g.fillStyle = d === 0 ? '#555' : '#2b2b2b'; g.fillRect(0, Math.round(cy(d, h)), w, 1);
      g.fillStyle = '#808080'; g.fillText(`${d > 0 ? '+' : ''}${d}`, 2, cy(d, h) - 2);
    }
    const pts = [0, 1, 2, 3].map((i) => ({ f: values[i * 2], db: values[i * 2 + 1] }));
    const fn = eqCurve(pts);
    g.strokeStyle = '#33ff66'; g.lineWidth = 2; g.beginPath();
    for (let x = 0; x <= w; x += 2) {
      const hz = EQ_MIN_HZ * Math.pow(EQ_MAX_HZ / EQ_MIN_HZ, x / w);
      if (x) g.lineTo(x, cy(fn(hz), h)); else g.moveTo(x, cy(fn(hz), h));
    }
    g.stroke();
    pts.forEach((p, i) => {
      g.fillStyle = COLORS[i]; g.strokeStyle = '#fff'; g.lineWidth = 1;
      g.fillRect(cx(p.f, w) - 5, cy(p.db, h) - 5, 10, 10); g.strokeRect(cx(p.f, w) - 5.5, cy(p.db, h) - 5.5, 11, 11);
    });
  }
  let dragBand = -1;
  const nearest = (e: PointerEvent) => {
    const w = curve.clientWidth, h = curve.clientHeight;
    let best = -1, bd = 18;
    for (let i = 0; i < 4; i++) {
      const d = Math.hypot(cx(values[i * 2], w) - e.offsetX, cy(values[i * 2 + 1], h) - e.offsetY);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  };
  curve.addEventListener('pointerdown', (e) => { dragBand = nearest(e); if (dragBand >= 0) curve.setPointerCapture(e.pointerId); });
  curve.addEventListener('pointerup', () => { dragBand = -1; });
  curve.addEventListener('pointercancel', () => { dragBand = -1; });
  curve.addEventListener('pointermove', (e) => {
    if (dragBand < 0) { curve.style.cursor = nearest(e) >= 0 ? 'move' : 'default'; return; }
    const w = curve.clientWidth, h = curve.clientHeight;
    const gp = def.params[dragBand * 2 + 1];
    const x = Math.max(0, Math.min(1, e.offsetX / w));
    values[dragBand * 2] = Math.round(EQ_MIN_HZ * Math.pow(EQ_MAX_HZ / EQ_MIN_HZ, x));
    const db = ((h / 2 - e.offsetY) / (h / 2 - 8)) * EQ_RANGE_DB;
    values[dragBand * 2 + 1] = Math.max(gp.min, Math.min(gp.max, Math.round(db * 2) / 2));
    sync();
    changed();
  });

  // ---------- preview ----------
  function stopSound(): void {
    clearTimeout(timer);
    cancelAnimationFrame(raf);
    if (src) { src.onended = null; try { src.stop(); } catch { /* already stopped */ } src.disconnect(); src = null; }
    prevBtn.textContent = '▶ Preview';
    posBar.style.width = '0';
    timeEl.textContent = '';
  }
  function stopPreview(): void {
    token++;
    stopSound();
    drawWave(null);
  }

  async function preview(): Promise<void> {
    const my = ++token;
    try {
      const tail = tailSeconds(def, values);
      say('Rendering…');
      const out = await runFx(def, values, srcData, SAMPLE_RATE, tail);
      if (my !== token || closed) return;
      shown = out;
      const ctx = getContext();
      await ctx.resume();
      const buf = ctx.createBuffer(out.length, out[0].length, SAMPLE_RATE);
      out.forEach((c, k) => buf.copyToChannel(c as Float32Array<ArrayBuffer>, k));
      stopSound();
      const s = ctx.createBufferSource();
      s.buffer = buf;
      s.connect(ctx.destination);
      s.onended = () => { if (src === s) { stopSound(); drawWave(null); } };
      dur = buf.duration;
      t0 = ctx.currentTime;
      s.start();
      src = s;
      prevBtn.textContent = '■ Stop';
      say(tail > 0 ? `Showing the result, ${tail.toFixed(1)} s longer than the object (tail).` : 'Showing the result.');
      const tick = () => {
        if (!src) return;
        const p = Math.min(1, (ctx.currentTime - t0) / dur);
        posBar.style.width = `${p * 100}%`;
        timeEl.textContent = `${fmtT(p * dur)} / ${fmtT(dur)}`;
        drawWave(p);
        raf = requestAnimationFrame(tick);
      };
      tick();
    } catch (e) {
      say((e as Error).message || 'The effect failed.');
    }
  }

  async function apply(): Promise<void> {
    if (busy) return;
    busy = true;
    stopPreview();
    applyBtn.disabled = prevBtn.disabled = true;
    say('Applying…');
    try {
      const r = await applyFxToSelection(def, values);
      if (!r.objects) { say('Nothing to apply.'); return; }
      close();
      onDone(`${def.name} applied to ${r.objects} object${r.objects > 1 ? 's' : ''} as ${r.samples} new sample${r.samples > 1 ? 's' : ''}.`);
    } catch (e) {
      say((e as Error).message || 'The effect failed.');
    } finally {
      busy = false;
      applyBtn.disabled = prevBtn.disabled = false;
    }
  }

  function close(): void {
    closed = true;
    token++;
    stopSound();
    root.innerHTML = '';
    document.removeEventListener('keydown', onKey, true);
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && !busy) {
      e.preventDefault();
      close();
    } else if (e.key === ' ' && !busy && document.activeElement !== sel) {
      e.preventDefault();
      if (src) stopPreview(); else void preview();
    }
    e.stopPropagation(); // keep shortcuts (Space, S, D …) from firing while the dialog is open
  };
  document.addEventListener('keydown', onKey, true);

  sel.onchange = () => {
    stopPreview();
    def = EFFECTS.find((d) => d.id === sel.value)!;
    values = def.params.map((p) => p.init);
    shown = srcData;
    buildKnobs();
    drawWave(null);
    say('');
  };
  prevBtn.onclick = () => { if (src) stopPreview(); else void preview(); };
  applyBtn.onclick = () => void apply();
  $<HTMLButtonElement>('fx-close').onclick = () => { if (!busy) close(); };

  buildKnobs();
  drawWave(null);
  say(count > 1 ? `${count} objects selected: Preview plays the first one, Apply processes all of them.` : `${asset.name}`);
}
