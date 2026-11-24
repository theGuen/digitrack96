import { store } from './store';
import { memory, MemoryManager, MemoryError, mb } from './memory';
import { getContext, playbackObjectFor } from './engine';
import { lowPassCoefs, mixObject } from './dsp';
import { encodeWav } from './bounce';
import { getSelected, objectSignature } from './actions';
import { clearHistory } from './history';
import { AudioAsset, AudioObject, MAX_MEMORY_BYTES, SAMPLE_RATE } from './types';

const BOUNCED = ' [bounced]';

/** Render one object exactly as shown (trim, gain, fades, pitch/stretch, reverse, swap, blend, resampling). */
export function renderObject(o: AudioObject, asset: AudioAsset): Float32Array<ArrayBuffer>[] {
  const srcChannels = Math.min(asset.buffer.numberOfChannels, 2);
  const po = playbackObjectFor(o, 0, 0, asset.rate);
  po.startFrame = 0; // render on its own, from time 0
  const len = po.lengthFrames;
  const src = Array.from({ length: srcChannels }, (_, c) => asset.buffer.getChannelData(c));
  const L = new Float32Array(len);
  const R = new Float32Array(len);
  mixObject(po, src, 0, len, L, R);
  return [L, R].slice(0, srcChannels); // mono stays mono
}

/** Sampling rates offered for a lo-fi bounce (AKAI S-20 style "resample"). */
export const BOUNCE_RATES = [44100, 32000, 22050, 16000, 11025, 8000, 4000] as const;

/** Band-limit (4th-order low-pass at 0.42 x target) and decimate to `rate`, as a sampler's resample does. */
function downsample(x: Float32Array<ArrayBuffer>, rate: number): Float32Array<ArrayBuffer> {
  if (rate >= SAMPLE_RATE) return x;
  const c = lowPassCoefs(rate * 0.42, SAMPLE_RATE, Math.SQRT1_2)!;
  const y = Float32Array.from(x);
  for (let pass = 0; pass < 2; pass++) {
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < y.length; i++) {
      const v = y[i];
      const o = c[0] * v + c[1] * x1 + c[2] * x2 - c[3] * y1 - c[4] * y2;
      x2 = x1; x1 = v; y2 = y1; y1 = o;
      y[i] = o;
    }
  }
  const n = Math.max(1, Math.ceil((x.length * rate) / SAMPLE_RATE));
  const out = new Float32Array(n);
  const step = SAMPLE_RATE / rate;
  for (let i = 0; i < n; i++) {
    const p = i * step;
    const k = Math.floor(p);
    const a = y[Math.min(k, y.length - 1)];
    const b = y[Math.min(k + 1, y.length - 1)];
    out[i] = a + (b - a) * (p - k);
  }
  return out;
}

/** Download each selected object as its own 16-bit WAV. The project is not changed. */
export function exportSelectedObjects(): number {
  const used = new Map<string, number>();
  let n = 0;
  for (const o of getSelected()) {
    const asset = memory.get(o.assetId);
    if (!asset) continue;
    const base = asset.name.replace(/\.[^.]*$/, '').replace(/[\\/:*?"<>|]/g, '') || 'object';
    const k = used.get(base) ?? 0;
    used.set(base, k + 1);
    const blob = encodeWav(renderObject(o, asset));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${base}${k ? ` ${k + 1}` : ''}.wav`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    n++;
  }
  return n;
}

/**
 * In-place bounce: renders the selected objects exactly as shown (trim, gain, fades, pitch/stretch,
 * reverse, swap, blend, resampling) into NEW 16-bit samples and swaps them in. Objects that are
 * identical (same sample + same render settings) are rendered ONCE and share the new sample, so copies
 * of a snippet cost no extra RAM. Each object keeps its position, track and mute state; all its other
 * properties reset to neutral. An old sample is freed when nothing uses it any more.
 * Track settings (volume/pan/low-pass) are not baked in.
 */
export function bounceSelectedInPlace(rate: number = SAMPLE_RATE): { objects: number; samples: number } {
  if (store.get().isPlaying) return { objects: 0, samples: 0 };

  const groups = new Map<string, string[]>();
  for (const o of getSelected()) {
    const sig = objectSignature(o);
    groups.set(sig, [...(groups.get(sig) ?? []), o.id]);
  }

  let objects = 0;
  let samples = 0;
  for (const ids of groups.values()) {
    const s = store.get();
    const members = s.objects.filter((x) => ids.includes(x.id));
    const o = members[0];
    const old = o && memory.get(o.assetId);
    if (!o || !old) continue;

    const channels = Math.min(old.buffer.numberOfChannels, 2); // the blend never changes a mono sample
    const len = rate >= SAMPLE_RATE ? playbackObjectFor(o, 0, 0).lengthFrames : Math.max(1, Math.ceil((playbackObjectFor(o, 0, 0).lengthFrames * rate) / SAMPLE_RATE));
    const newBytes = MemoryManager.bytesFor(len, channels);
    // The old sample is only freed if no object OUTSIDE this group still uses it.
    const shared = s.objects.some((x) => !ids.includes(x.id) && x.assetId === o.assetId);
    const freed = shared ? 0 : old.byteSize;
    if (memory.total - freed + newBytes > MAX_MEMORY_BYTES) {
      throw new MemoryError(
        `Not enough memory to bounce "${old.name}".\n` +
          `The new sample needs ${mb(newBytes)} MB, only ${mb(MAX_MEMORY_BYTES - memory.total + freed)} MB would be free.`,
      );
    }

    const data = renderObject(o, old).map((d) => downsample(d, rate));
    const buffer = getContext().createBuffer(channels, len, SAMPLE_RATE); // nominal rate; the real one is asset.rate
    for (const [c, d] of data.entries()) {
      for (let i = 0; i < len; i++) {
        const v = d[i] > 1 ? 1 : d[i] < -1 ? -1 : d[i];
        d[i] = Math.round(v * 32767) / 32767; // 16-bit
      }
      buffer.copyToChannel(d, c);
    }

    const asset: AudioAsset = {
      id: crypto.randomUUID(),
      name: old.name.replace(/ \[bounced[^\]]*\]$/, '') + (rate < SAMPLE_RATE ? ` [bounced ${rate / 1000} kHz]` : BOUNCED),
      buffer,
      byteSize: newBytes,
      rate: Math.min(rate, SAMPLE_RATE),
    };
    if (!shared) memory.remove(old.id);
    memory.add(asset);

    clearHistory(); // swaps sample data: not undoable
    store.set({
      objects: s.objects.map((x) =>
        ids.includes(x.id)
          ? {
              ...x,
              assetId: asset.id,
              trimStart: 0,
              gain: 1,
              fadeInTime: 0,
              fadeOutTime: 0,
              fadeInCurve: 0,
              fadeOutCurve: 0,
              pitchShiftCents: 0,
              resampleMode: rate < SAMPLE_RATE ? ('nearest' as const) : ('linear' as const), // lo-fi stays crunchy
              reverse: false,
              swap: false,
              pan: 0,
            }
          : x,
      ),
      totalMemoryBytes: memory.total,
    });
    objects += ids.length;
    samples++;
  }
  return { objects, samples };
}
