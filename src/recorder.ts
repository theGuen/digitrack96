import recorderUrl from './recorder-worklet.ts?worker&url';
import { memory, MemoryManager, MemoryError, mb } from './memory';
import { getContext } from './engine';
import { addAssetToTimeline } from './actions';
import { AudioAsset, SAMPLE_RATE } from './types';

const TRIM_DB = -48; // auto-trim threshold
const PRE_MS = 5;
const POST_MS = 40;
const PEAK_BLOCK = 1024; // frames per drawn peak

let takeCount = 0;

/** Record dialog: pick an input, record, see the waveform, auto-trim silence, add to the timeline. */
export function showRecorder(): void {
  const root = document.getElementById('dialog-root')!;
  root.innerHTML = `
    <div class="overlay"><div class="dialog rec win95-panel" role="dialog" aria-label="Record">
      <div class="titlebar"><span>Record</span></div>
      <div class="rec-body">
        <label class="rec-row">Source <select id="rec-src" class="win95-select"></select></label>
        <div class="win95-inset rec-wave"><canvas id="rec-canvas" width="520" height="120"></canvas></div>
        <div class="rec-row"><span class="rec-meter win95-inset"><i id="rec-level"></i></span><span id="rec-time" class="rec-time">0:00.0</span></div>
        <label class="rec-row"><input type="checkbox" id="rec-mon" /> Monitor input through the speakers (use headphones to avoid feedback)</label>
        <label class="rec-row"><input type="checkbox" id="rec-trim" checked /> Auto-trim silence (below ${TRIM_DB} dB)</label>
        <div id="rec-msg" class="rec-msg">Waiting for microphone access…</div>
      </div>
      <div class="actions">
        <button class="win95-button" id="rec-go" disabled>● Record</button>
        <button class="win95-button" id="rec-play" disabled>▶ Play</button>
        <button class="win95-button" id="rec-add" disabled>Add to Timeline</button>
        <button class="win95-button" id="rec-close">Close</button>
      </div>
    </div></div>`;
  const $ = <T extends HTMLElement>(id: string) => root.querySelector<T>('#' + id)!;
  const src = $<HTMLSelectElement>('rec-src');
  const canvas = $<HTMLCanvasElement>('rec-canvas');
  const g = canvas.getContext('2d')!;
  const goBtn = $<HTMLButtonElement>('rec-go');
  const addBtn = $<HTMLButtonElement>('rec-add');
  const playBtn = $<HTMLButtonElement>('rec-play');
  const msg = $('rec-msg');
  const level = $('rec-level');
  const time = $('rec-time');
  const trimBox = $<HTMLInputElement>('rec-trim');
  const monBox = $<HTMLInputElement>('rec-mon');

  let ctx: AudioContext | null = null;
  let stream: MediaStream | null = null;
  let node: AudioWorkletNode | null = null;
  let srcNode: MediaStreamAudioSourceNode | null = null;
  let monitoring = false;
  let recording = false;
  let closed = false;
  let chunks: Float32Array[][] = []; // [block][channel]
  let channels = 1;
  let frames = 0;
  let peaks: { lo: number; hi: number }[] = [];
  let curLo = 1, curHi = -1, curN = 0;
  let trim: { a: number; b: number } | null = null; // in recorded frames, null = nothing usable
  let preview: AudioBufferSourceNode | null = null;
  let previewT0 = 0; // ctx time the preview started
  let raf = 0;

  const say = (t: string) => { msg.textContent = t; };
  const fmt = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
  const rate = () => ctx?.sampleRate ?? SAMPLE_RATE;

  function draw(): void {
    const W = canvas.width, H = canvas.height, mid = H / 2;
    g.fillStyle = '#000';
    g.fillRect(0, 0, W, H);
    const all = curN ? [...peaks, { lo: curLo, hi: curHi }] : peaks;
    if (all.length) {
      g.fillStyle = '#33ff66';
      for (let x = 0; x < W; x++) {
        const i0 = Math.floor((x * all.length) / W);
        const i1 = Math.max(i0 + 1, Math.floor(((x + 1) * all.length) / W));
        let lo = 1, hi = -1;
        for (let i = i0; i < i1 && i < all.length; i++) {
          if (all[i].lo < lo) lo = all[i].lo;
          if (all[i].hi > hi) hi = all[i].hi;
        }
        if (hi < lo) continue;
        g.fillRect(x, mid - hi * (mid - 2), 1, Math.max(1, (hi - lo) * (mid - 2)));
      }
    } else {
      g.fillStyle = '#2b5';
      g.fillRect(0, mid, W, 1);
    }
    if (trim && !recording && frames > 0) {
      // dim what auto-trim will cut away
      g.fillStyle = 'rgba(0,0,0,.65)';
      g.fillRect(0, 0, (trim.a / frames) * W, H);
      g.fillRect((trim.b / frames) * W, 0, W - (trim.b / frames) * W, H);
      g.fillStyle = '#0ff';
      g.fillRect(Math.round((trim.a / frames) * W), 0, 1, H);
      g.fillRect(Math.round((trim.b / frames) * W) - 1, 0, 1, H);
    }
    if (preview && trim && ctx) {
      const p = trim.a + (ctx.currentTime - previewT0) * rate();
      const x = Math.round((p / frames) * W);
      g.fillStyle = '#fff';
      g.fillRect(x, 0, 1, H);
    }
  }

  function findTrim(): { a: number; b: number } | null {
    const thr = Math.pow(10, TRIM_DB / 20);
    const at = (i: number) => {
      const blk = chunks[Math.floor(i / chunks[0][0].length)];
      const k = i % chunks[0][0].length;
      let v = 0;
      for (const ch of blk) v = Math.max(v, Math.abs(ch[k]));
      return v;
    };
    if (!frames) return null;
    let a = 0;
    let b = frames - 1;
    if (trimBox.checked) {
      while (a < frames && at(a) < thr) a++;
      if (a >= frames) return null; // only silence
      while (b > a && at(b) < thr) b--;
      a = Math.max(0, a - Math.round((PRE_MS / 1000) * rate()));
      b = Math.min(frames - 1, b + Math.round((POST_MS / 1000) * rate()));
    }
    return { a, b: b + 1 };
  }

  function refreshTrim(): void {
    trim = recording ? null : findTrim();
    addBtn.disabled = recording || !trim;
    playBtn.disabled = recording || !trim;
    if (!recording && frames) {
      if (!trim) say('Only silence was recorded.');
      else {
        const secs = (trim.b - trim.a) / rate();
        const bytes = MemoryManager.bytesFor(Math.round(secs * SAMPLE_RATE), channels);
        say(`Take: ${secs.toFixed(2)} s (${mb(bytes)} MB of ${mb(memory.max - memory.total)} MB free)${trim.a > 0 || trim.b < frames ? ' — trimmed' : ''}.`);
      }
    }
    draw();
  }

  function stopPreview(): void {
    if (preview) {
      preview.onended = null;
      try { preview.stop(); } catch { /* already stopped */ }
      preview.disconnect();
      preview = null;
    }
    cancelAnimationFrame(raf);
    playBtn.textContent = '▶ Play';
  }

  function startPreview(): void {
    if (!trim || !ctx || recording) return;
    stopPreview();
    const { a, b } = trim;
    const bl = chunks[0][0].length;
    const buf = ctx.createBuffer(channels, b - a, rate());
    for (let c = 0; c < channels; c++) {
      const d = new Float32Array(b - a);
      for (let i = 0; i < d.length; i++) {
        const idx = a + i;
        d[i] = chunks[Math.floor(idx / bl)][c][idx % bl];
      }
      buf.copyToChannel(d, c);
    }
    const s = ctx.createBufferSource();
    s.buffer = buf;
    s.connect(ctx.destination);
    s.onended = () => { stopPreview(); draw(); };
    previewT0 = ctx.currentTime;
    preview = s;
    s.start();
    playBtn.textContent = '■ Stop';
    const tick = () => {
      if (!preview) return;
      draw();
      raf = requestAnimationFrame(tick);
    };
    tick();
  }

  function onChunk(chs: Float32Array[]): void {
    let pk = 0;
    for (const ch of chs) for (let i = 0; i < ch.length; i += 4) pk = Math.max(pk, Math.abs(ch[i]));
    const db = pk > 0 ? 20 * Math.log10(pk) : -90;
    level.style.width = `${Math.max(0, Math.min(100, ((db + 60) / 60) * 100))}%`;
    level.className = db > -1 ? 'hot' : '';
    if (!recording) return;

    channels = chs.length;
    chunks.push(chs);
    frames += chs[0].length;
    for (let i = 0; i < chs[0].length; i++) {
      let v = 0;
      for (const ch of chs) v += ch[i];
      v /= chs.length;
      if (v < curLo) curLo = v;
      if (v > curHi) curHi = v;
      if (++curN === PEAK_BLOCK) {
        peaks.push({ lo: curLo, hi: curHi });
        curLo = 1; curHi = -1; curN = 0;
      }
    }
    time.textContent = fmt(frames / rate());
    draw();
    // memory ceiling: the take will be stored as 16-bit at 44.1 kHz
    const need = MemoryManager.bytesFor(Math.round((frames / rate()) * SAMPLE_RATE), channels);
    if (need > memory.max - memory.total) {
      stopRecording();
      say('Memory full: recording stopped.');
    }
  }

  async function openSource(deviceId?: string): Promise<void> {
    node?.disconnect();
    srcNode?.disconnect();
    stream?.getTracks().forEach((t) => t.stop());
    node = srcNode = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: { ideal: 2 },
        },
      });
    } catch (err) {
      say(`No microphone access (${(err as Error).name}). Allow it in the browser and try again.`);
      return;
    }
    if (closed) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    if (!ctx) {
      ctx = new AudioContext(); // native device rate, resampled to 44.1 kHz when added
      await ctx.audioWorklet.addModule(recorderUrl);
    }
    await ctx.resume();
    srcNode = ctx.createMediaStreamSource(stream);
    node = new AudioWorkletNode(ctx, 'recorder-processor', { numberOfOutputs: 0 });
    node.port.onmessage = (e) => onChunk(e.data.chs as Float32Array[]);
    srcNode.connect(node);
    if (monitoring) srcNode.connect(ctx.destination); // monitor: whatever latency the browser gives us
    // list inputs (labels are available now that permission was granted)
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
    const cur = stream.getAudioTracks()[0]?.getSettings().deviceId;
    src.innerHTML = '';
    devs.forEach((d, i) => {
      const o = document.createElement('option');
      o.value = d.deviceId;
      o.textContent = d.label || `Input ${i + 1}`;
      src.appendChild(o);
    });
    if (cur) src.value = cur;
    goBtn.disabled = false;
    if (!frames) say('Ready. Press Record (or Space).');
  }

  function startRecording(): void {
    chunks = []; peaks = []; frames = 0; curLo = 1; curHi = -1; curN = 0; trim = null;
    time.textContent = fmt(0);
    stopPreview();
    recording = true;
    src.disabled = true;
    playBtn.disabled = true;
    addBtn.disabled = true;
    goBtn.textContent = '■ Stop';
    say('Recording…');
    draw();
  }

  function stopRecording(): void {
    if (!recording) return;
    recording = false;
    src.disabled = false;
    goBtn.textContent = '● Record';
    refreshTrim();
  }

  function addToTimeline(): void {
    if (!trim) return;
    try {
      const inRate = rate();
      const a = trim.a, b = trim.b;
      const outLen = Math.max(1, Math.round(((b - a) / inRate) * SAMPLE_RATE));
      const bytes = MemoryManager.bytesFor(outLen, channels);
      if (!memory.canFit(bytes)) {
        throw new MemoryError(`Not enough memory: the take needs ${mb(bytes)} MB, only ${mb(memory.max - memory.total)} MB free.`);
      }
      const bl = chunks[0][0].length;
      const sample = (c: number, i: number) => {
        const idx = Math.min(frames - 1, i);
        return chunks[Math.floor(idx / bl)][c][idx % bl];
      };
      const buffer = getContext().createBuffer(channels, outLen, SAMPLE_RATE);
      for (let c = 0; c < channels; c++) {
        const d = new Float32Array(outLen);
        for (let i = 0; i < outLen; i++) {
          const p = a + (i * inRate) / SAMPLE_RATE;
          const k = Math.floor(p);
          const x0 = sample(c, k);
          const v = x0 + (sample(c, k + 1) - x0) * (p - k); // linear resample to 44.1 kHz
          d[i] = Math.round(Math.max(-1, Math.min(1, v)) * 32767) / 32767; // 16-bit
        }
        buffer.copyToChannel(d, c);
      }
      const asset: AudioAsset = { id: crypto.randomUUID(), name: `Recording ${++takeCount}`, buffer, byteSize: bytes, rate: SAMPLE_RATE };
      memory.add(asset);
      addAssetToTimeline(asset);
      close();
    } catch (err) {
      say((err as Error).message);
    }
  }

  function close(): void {
    stopPreview();
    closed = true;
    recording = false;
    node?.disconnect();
    srcNode?.disconnect();
    stream?.getTracks().forEach((t) => t.stop());
    void ctx?.close();
    root.innerHTML = '';
    document.removeEventListener('keydown', onKey, true);
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && !recording) {
      e.preventDefault();
      close();
    } else if (e.key === ' ' && !goBtn.disabled && document.activeElement !== src) {
      e.preventDefault();
      if (recording) stopRecording(); else startRecording();
    }
    e.stopPropagation(); // keep shortcuts (Space, S, D …) from firing while the recorder is open
  };
  document.addEventListener('keydown', onKey, true);

  goBtn.onclick = () => (recording ? stopRecording() : startRecording());
  addBtn.onclick = addToTimeline;
  $<HTMLButtonElement>('rec-close').onclick = () => { if (!recording) close(); };
  trimBox.onchange = () => { if (frames && !recording) { stopPreview(); refreshTrim(); } };
  playBtn.onclick = () => (preview ? stopPreview() : startPreview());
  monBox.onchange = () => {
    monitoring = monBox.checked;
    if (!srcNode || !ctx) return;
    if (monitoring) srcNode.connect(ctx.destination);
    else srcNode.disconnect(ctx.destination);
  };
  src.onchange = () => { goBtn.disabled = true; void openSource(src.value); };

  draw();
  void openSource();
}
