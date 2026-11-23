import { store } from './store';
import { memory, MemoryManager, mb } from './memory';
import { getContext } from './engine';
import { clearHistory } from './history';
import { centsToRatio } from './dsp';
import { AudioAsset, SAMPLE_RATE } from './types';

/**
 * Optimize Project (lossless for what is currently on the timeline):
 *  1. Merge samples whose audio data is bit-identical into one.
 *  2. Crop every sample to the part its objects actually use (trims/fades/pitch/reverse etc. stay live;
 *     only the ability to trim OUT beyond the used part is given up).
 * Not undoable (it replaces sample data), so the history is cleared.
 */
export interface OptimizePlan {
  before: number;
  after: number;
  lines: string[];
  apply(): void;
}

const MIN_CROP_FRAMES = 1024; // ignore savings smaller than this

function hashAsset(a: AudioAsset): number {
  let h = 2166136261;
  for (let c = 0; c < Math.min(a.buffer.numberOfChannels, 2); c++) {
    const d = a.buffer.getChannelData(c);
    const u = new Uint32Array(d.buffer, d.byteOffset, d.length);
    for (let i = 0; i < u.length; i++) h = Math.imul(h ^ u[i], 16777619);
  }
  return h >>> 0;
}

function sameAudio(a: AudioAsset, b: AudioAsset): boolean {
  const ch = Math.min(a.buffer.numberOfChannels, 2);
  if (a.rate !== b.rate || ch !== Math.min(b.buffer.numberOfChannels, 2) || a.buffer.length !== b.buffer.length) return false;
  for (let c = 0; c < ch; c++) {
    const x = a.buffer.getChannelData(c);
    const y = b.buffer.getChannelData(c);
    const ux = new Uint32Array(x.buffer, x.byteOffset, x.length);
    const uy = new Uint32Array(y.buffer, y.byteOffset, y.length);
    for (let i = 0; i < ux.length; i++) if (ux[i] !== uy[i]) return false;
  }
  return true;
}

export function planOptimize(): OptimizePlan | null {
  const s = store.get();
  if (s.isPlaying) return null;
  const usedIds = [...new Set(s.objects.map((o) => o.assetId))].filter((id) => memory.get(id));
  const lines: string[] = [];
  const before = memory.total;

  // 1. merge bit-identical samples
  const canon = new Map<string, string>(); // assetId -> canonical assetId
  const buckets = new Map<string, string[]>(); // key -> canonical ids
  let dupBytes = 0;
  let dupCount = 0;
  for (const id of usedIds) {
    const a = memory.get(id)!;
    const key = `${a.rate}:${Math.min(a.buffer.numberOfChannels, 2)}:${a.buffer.length}:${hashAsset(a)}`;
    const list = buckets.get(key) ?? [];
    const match = list.find((cid) => sameAudio(memory.get(cid)!, a));
    if (match) {
      canon.set(id, match);
      dupBytes += a.byteSize;
      dupCount++;
    } else {
      canon.set(id, id);
      buckets.set(key, [...list, id]);
    }
  }
  if (dupCount) lines.push(`• ${dupCount} duplicate sample${dupCount > 1 ? 's' : ''} merged (saves ${mb(dupBytes)} MB)`);

  // 2. crop each remaining sample to the range its objects use
  const crops = new Map<string, { start: number; end: number }>();
  let cropBytes = 0;
  const cropLines: string[] = [];
  for (const cid of new Set(canon.values())) {
    const a = memory.get(cid)!;
    const len = a.buffer.length;
    let lo = Infinity;
    let hi = -Infinity;
    for (const o of s.objects) {
      if (canon.get(o.assetId) !== cid) continue;
      const trimFrame = o.trimStart * a.rate;
      lo = Math.min(lo, trimFrame);
      hi = Math.max(hi, trimFrame + Math.round(o.duration * a.rate) * centsToRatio(o.pitchShiftCents));
    }
    if (!Number.isFinite(lo)) continue;
    const start = Math.max(0, Math.floor(lo) - 2); // small margins for interpolation
    const end = Math.min(len, Math.ceil(hi) + 3);
    if (len - (end - start) < MIN_CROP_FRAMES) continue;
    const ch = Math.min(a.buffer.numberOfChannels, 2);
    const saved = a.byteSize - MemoryManager.bytesFor(end - start, ch);
    crops.set(cid, { start, end });
    cropBytes += saved;
    cropLines.push(
      `• ${a.name}: keeps ${((end - start) / a.rate).toFixed(1)} s of ${(len / a.rate).toFixed(1)} s (saves ${mb(saved)} MB)`,
    );
  }
  lines.push(...cropLines.slice(0, 8));
  if (cropLines.length > 8) lines.push(`• …and ${cropLines.length - 8} more cropped sample${cropLines.length - 8 > 1 ? 's' : ''}`);

  if (!dupCount && !crops.size) return null;

  return {
    before,
    after: before - dupBytes - cropBytes,
    lines,
    apply() {
      const cur = store.get();
      const final = new Map<string, { id: string; offsetFrames: number; rate: number }>(); // canonical -> final asset
      // drop duplicates
      for (const [id, c] of canon) if (id !== c) memory.remove(id);
      // crop
      for (const cid of new Set(canon.values())) {
        const crop = crops.get(cid);
        if (!crop) {
          final.set(cid, { id: cid, offsetFrames: 0, rate: SAMPLE_RATE });
          continue;
        }
        const old = memory.get(cid)!;
        const ch = Math.min(old.buffer.numberOfChannels, 2);
        const n = crop.end - crop.start;
        const buffer = getContext().createBuffer(ch, n, SAMPLE_RATE); // nominal rate; the real one is asset.rate
        for (let c = 0; c < ch; c++) buffer.copyToChannel(old.buffer.getChannelData(c).slice(crop.start, crop.end), c);
        const asset: AudioAsset = {
          id: crypto.randomUUID(),
          name: old.name,
          buffer,
          byteSize: MemoryManager.bytesFor(n, ch),
          rate: old.rate,
        };
        memory.remove(cid);
        memory.add(asset);
        final.set(cid, { id: asset.id, offsetFrames: crop.start, rate: old.rate });
      }
      clearHistory(); // sample data replaced: not undoable
      store.set({
        objects: cur.objects.map((o) => {
          const f = final.get(canon.get(o.assetId) ?? o.assetId);
          if (!f) return o;
          return {
            ...o,
            assetId: f.id,
            trimStart: f.offsetFrames ? (o.trimStart * f.rate - f.offsetFrames) / f.rate : o.trimStart,
          };
        }),
        totalMemoryBytes: memory.total,
      });
    },
  };
}
