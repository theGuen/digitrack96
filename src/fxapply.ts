import { store } from './store';
import { memory, MemoryManager, MemoryError, mb } from './memory';
import { getContext } from './engine';
import { getSelected, objectSignature } from './actions';
import { clearHistory } from './history';
import { renderObject } from './freeze';
import { FxDef, runFx, tailSeconds } from './fx';
import { AudioAsset, MAX_MEMORY_BYTES, SAMPLE_RATE } from './types';

/** " [fx: Reverb]" -> " [fx: Reverb, Delay]": the sample name keeps a short history of what was applied. */
function fxName(name: string, fx: string): string {
  const m = / \[fx: ([^\]]+)\]$/.exec(name);
  if (m) return `${name.slice(0, m.index)} [fx: ${m[1]}, ${fx}]`;
  return `${name.replace(/ \[bounced[^\]]*\]$/, '')} [fx: ${fx}]`;
}

/**
 * Destructive effect: renders each selected object exactly as shown (trim, gain, fades, pitch, reverse, swap, blend),
 * runs the effect over it and swaps the result in as a NEW 16-bit sample. Identical objects (same sample + same render
 * settings) are processed once and share the new sample. Reverb and echo tails are appended, so the object gets longer.
 * Each object keeps its position, track and mute state; its other properties reset to neutral (they are baked in).
 */
export async function applyFxToSelection(def: FxDef, values: number[]): Promise<{ objects: number; samples: number }> {
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
    const o = s.objects.find((x) => ids.includes(x.id));
    const old = o && memory.get(o.assetId);
    if (!o || !old) continue;

    const data = renderObject(o, old);
    const channels = data.length;
    const tail = tailSeconds(def, values);
    const newLen = data[0].length + Math.round(tail * SAMPLE_RATE);
    const newBytes = MemoryManager.bytesFor(newLen, channels);
    const shared = s.objects.some((x) => !ids.includes(x.id) && x.assetId === o.assetId);
    const freed = shared ? 0 : old.byteSize;
    if (memory.total - freed + newBytes > MAX_MEMORY_BYTES) {
      throw new MemoryError(
        `Not enough memory to apply ${def.name} to "${old.name}".\n` +
          `The new sample needs ${mb(newBytes)} MB, only ${mb(MAX_MEMORY_BYTES - memory.total + freed)} MB would be free.`,
      );
    }

    const out = await runFx(def, values, data, SAMPLE_RATE, tail);
    const buffer = getContext().createBuffer(channels, newLen, SAMPLE_RATE); // nominal rate; the real one is asset.rate
    for (const [c, d] of out.entries()) {
      for (let i = 0; i < d.length; i++) {
        const v = d[i] > 1 ? 1 : d[i] < -1 ? -1 : d[i];
        d[i] = Math.round(v * 32767) / 32767; // 16-bit
      }
      buffer.copyToChannel(d as Float32Array<ArrayBuffer>, c);
    }

    const asset: AudioAsset = {
      id: crypto.randomUUID(),
      name: fxName(old.name, def.name),
      buffer,
      byteSize: newBytes,
      rate: SAMPLE_RATE,
    };
    // the user can change the project while the effect renders: use the current state again
    const cur = store.get();
    if (cur.isPlaying) throw new Error('Playback started while the effect was rendering. Nothing was changed.');
    if (!shared) memory.remove(old.id);
    memory.add(asset);

    clearHistory(); // swaps sample data: not undoable
    store.set({
      objects: cur.objects.map((x) =>
        ids.includes(x.id)
          ? {
              ...x,
              assetId: asset.id,
              trimStart: 0,
              duration: newLen / SAMPLE_RATE,
              gain: 1,
              fadeInTime: 0,
              fadeOutTime: 0,
              fadeInCurve: 0,
              fadeOutCurve: 0,
              pitchShiftCents: 0,
              resampleMode: 'linear' as const,
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
