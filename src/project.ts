import { DEFAULT_MASTER, defaultTracks, store } from './store';
import { memory, MemoryManager, MemoryError } from './memory';
import { getContext } from './engine';
import { clearHistory } from './history';
import { AudioAsset, AudioObject, MAX_MEMORY_BYTES, MasterSettings, SAMPLE_RATE, Track } from './types';

/**
 * .smp file layout:
 *   "SMP1" | u32 jsonLength (LE) | JSON (space-padded so PCM starts 2-byte aligned) | Int16 LE PCM blobs
 * PCM per asset: channel 0 samples, then channel 1 samples (if stereo).
 */
const MAGIC = 'SMP1';

interface AssetMeta {
  id: string;
  name: string;
  channels: number;
  length: number;
  offset: number; // byte offset into the PCM section
  rate?: number; // sampling rate (absent = 44100)
}

interface ProjectFile {
  version: 1;
  sampleRate: number;
  playheadPosition: number;
  tracks: Track[];
  master?: MasterSettings;
  objects: AudioObject[];
  assets: AssetMeta[];
}

/** Start from scratch: no samples, default tracks and master, playhead at 0. */
export function newProject(): void {
  clearHistory();
  memory.clear();
  store.set({
    tracks: defaultTracks(),
    master: { ...DEFAULT_MASTER },
    objects: [],
    selectedIds: [],
    playheadPosition: 0,
    totalMemoryBytes: 0,
  });
}

export class ProjectError extends Error {}

export function saveProject(): Blob {
  const s = store.get();

  const used = [...new Set(s.objects.map((o) => o.assetId))];
  const metas: AssetMeta[] = [];
  const blobs: Int16Array<ArrayBuffer>[] = [];
  let offset = 0;
  for (const id of used) {
    const a = memory.get(id);
    if (!a) continue;
    const channels = Math.min(a.buffer.numberOfChannels, 2);
    const pcm = new Int16Array(a.buffer.length * channels);
    for (let c = 0; c < channels; c++) {
      const d = a.buffer.getChannelData(c);
      for (let i = 0; i < d.length; i++) pcm[c * d.length + i] = Math.round(d[i] * 32767);
    }
    metas.push({ id, name: a.name, channels, length: a.buffer.length, offset, rate: a.rate });
    blobs.push(pcm);
    offset += pcm.byteLength;
  }

  const project: ProjectFile = {
    version: 1,
    sampleRate: SAMPLE_RATE,
    playheadPosition: s.playheadPosition,
    tracks: s.tracks,
    master: s.master,
    objects: s.objects.filter((o) => metas.some((m) => m.id === o.assetId)),
    assets: metas,
  };
  let json = new TextEncoder().encode(JSON.stringify(project));
  const pad = (8 + json.length) % 2;
  if (pad) {
    const j = new Uint8Array(json.length + 1);
    j.set(json);
    j[json.length] = 0x20;
    json = j;
  }
  const head = new Uint8Array(8);
  head.set([...MAGIC].map((c) => c.charCodeAt(0)));
  new DataView(head.buffer).setUint32(4, json.length, true);
  return new Blob([head, json, ...blobs], { type: 'application/octet-stream' });
}

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

export async function loadProject(file: File): Promise<void> {
  const buf = await file.arrayBuffer();
  if (buf.byteLength < 8 || new TextDecoder().decode(buf.slice(0, 4)) !== MAGIC) {
    throw new ProjectError(`"${file.name}" is not a Digitrack 96 project.`);
  }
  const jsonLen = new DataView(buf).getUint32(4, true);
  if (8 + jsonLen > buf.byteLength) throw new ProjectError('Project file is truncated.');

  let p: ProjectFile;
  try {
    p = JSON.parse(new TextDecoder().decode(buf.slice(8, 8 + jsonLen)));
  } catch {
    throw new ProjectError('Project file is corrupt.');
  }
  if (p.version !== 1 || p.sampleRate !== SAMPLE_RATE) throw new ProjectError('Unsupported project version.');

  const pcmStart = 8 + jsonLen;

  // Stage everything first; only replace the current project once it all checks out.
  const total = p.assets.reduce((t, a) => t + MemoryManager.bytesFor(a.length, a.channels), 0);
  if (total > MAX_MEMORY_BYTES) {
    throw new MemoryError(`Project needs ${(total / 1_048_576).toFixed(1)} MB, more than the ${(MAX_MEMORY_BYTES / 1_048_576).toFixed(1)} MB available.`);
  }

  const ctx = getContext();
  const assets: AudioAsset[] = [];
  for (const m of p.assets) {
    const bytes = m.length * m.channels * 2;
    const start = pcmStart + m.offset;
    if (m.channels < 1 || m.channels > 2 || start + bytes > buf.byteLength) {
      throw new ProjectError(`Sample data for "${m.name}" is missing or corrupt.`);
    }
    const pcm = new Int16Array(buf.slice(start, start + bytes));
    const buffer = ctx.createBuffer(m.channels, m.length, SAMPLE_RATE);
    for (let c = 0; c < m.channels; c++) {
      const d = new Float32Array(m.length);
      for (let i = 0; i < m.length; i++) d[i] = pcm[c * m.length + i] / 32767;
      buffer.copyToChannel(d, c);
    }
    assets.push({ id: m.id, name: m.name, buffer, byteSize: MemoryManager.bytesFor(m.length, m.channels), rate: Math.min(SAMPLE_RATE, Math.max(1000, num(m.rate, SAMPLE_RATE))) });
  }

  const cur = store.get();
  const tracks = cur.tracks.map((t, i) => {
    const s = p.tracks?.[i];
    return s
      ? {
          ...t,
          volume: Math.min(1, Math.max(0, num(s.volume, t.volume))),
          pan: Math.min(1, Math.max(-1, num(s.pan, t.pan))),
          isMuted: !!s.isMuted,
          isSoloed: !!s.isSoloed,
          lowPassHz: Math.min(20000, Math.max(100, num(s.lowPassHz, 20000))),
          highPassHz: Math.min(4000, Math.max(20, num(s.highPassHz, 20))),
        }
      : t;
  });
  const ids = new Set(assets.map((a) => a.id));
  const trackIds = new Set(tracks.map((t) => t.id));
  const objects: AudioObject[] = (p.objects ?? [])
    .filter((o) => ids.has(o.assetId) && trackIds.has(o.trackId))
    .map((o) => ({
      ...o,
      startTime: Math.max(0, num(o.startTime, 0)),
      trimStart: Math.max(0, num(o.trimStart, 0)),
      duration: Math.max(0.01, num(o.duration, 0.01)),
      gain: Math.min(2, Math.max(0, num(o.gain, 1))),
      fadeInTime: Math.max(0, num(o.fadeInTime, 0)),
      fadeOutTime: Math.max(0, num(o.fadeOutTime, 0)),
      fadeInCurve: Math.min(1, Math.max(0, num(o.fadeInCurve, 0))),
      fadeOutCurve: Math.min(1, Math.max(0, num(o.fadeOutCurve, 0))),
      pitchShiftCents: Math.min(1200, Math.max(-1200, num(o.pitchShiftCents, 0))),
      resampleMode: o.resampleMode === 'nearest' ? 'nearest' : 'linear',
      reverse: !!o.reverse,
      swap: !!o.swap,
      isMuted: !!o.isMuted,
      pan: Math.min(1, Math.max(-1, num(o.pan, 0))),
    }));

  clearHistory(); // different samples: old snapshots are meaningless
  memory.clear();
  for (const a of assets) memory.add(a);
  store.set({
    tracks,
    master: {
      on: !!p.master?.on,
      comp: Math.min(1, Math.max(0, num(p.master?.comp, 0.4))),
      mix: Math.min(1, Math.max(0, num(p.master?.mix, 1))),
    },
    objects,
    selectedIds: [],
    playheadPosition: Math.max(0, num(p.playheadPosition, 0)),
    totalMemoryBytes: memory.total,
  });
}
