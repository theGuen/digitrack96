import { store } from './store';
import { memory } from './memory';
import { AudioAsset, AudioObject, ProjectState } from './types';
import { centsToRatio } from './dsp';
import { engine } from './engine';
import { clearHistory, record } from './history';

export const MIN_DURATION = 0.01;

const locked = () => store.get().isPlaying;
const uid = () => crypto.randomUUID();

/** Keep fades inside the object after any duration change. */
export function clampFades(o: AudioObject): AudioObject {
  const fadeInTime = Math.min(Math.max(o.fadeInTime, 0), o.duration);
  const fadeOutTime = Math.min(Math.max(o.fadeOutTime, 0), o.duration - fadeInTime);
  return { ...o, fadeInTime, fadeOutTime };
}

/** Longest timeline duration an object can have before running out of source audio. */
export function maxDuration(o: AudioObject): number {
  const asset = memory.get(o.assetId);
  if (!asset) return o.duration;
  return (asset.buffer.length / asset.rate - o.trimStart) / centsToRatio(o.pitchShiftCents);
}

export function syncMemory(): void {
  store.set({ totalMemoryBytes: memory.total });
}

export function updateObject(id: string, patch: Partial<AudioObject>): void {
  if (locked()) return;
  const { objects } = store.get();
  store.set({
    objects: objects.map((o) => (o.id === id ? clampFades({ ...o, ...patch }) : o)),
  });
}

export function setPitch(id: string, cents: number): void {
  if (locked()) return;
  const o = store.get().objects.find((x) => x.id === id);
  if (!o) return;
  const next = { ...o, pitchShiftCents: cents };
  const dur = Math.min(o.duration, Math.max(MIN_DURATION, maxDuration(next)));
  updateObject(id, { pitchShiftCents: cents, duration: dur });
}

/** Selected objects, in timeline-array order. */
export function getSelected(s: ProjectState = store.get()): AudioObject[] {
  return s.objects.filter((o) => s.selectedIds.includes(o.id));
}

/** The object the properties panel / handles refer to (last selected). */
export function getPrimary(s: ProjectState = store.get()): AudioObject | undefined {
  const id = s.selectedIds[s.selectedIds.length - 1];
  return s.objects.find((o) => o.id === id);
}

/** Apply per-object patches in one store update (respects the playback lock). */
export function patchObjects(patches: Map<string, Partial<AudioObject>>): void {
  if (locked()) return;
  const { objects } = store.get();
  store.set({ objects: objects.map((o) => (patches.has(o.id) ? clampFades({ ...o, ...patches.get(o.id) }) : o)) });
}

/** Apply the same patch to every selected object. */
export function updateSelected(patch: Partial<AudioObject>, key?: string): void {
  if (locked()) return;
  record(key);
  patchObjects(new Map(getSelected().map((o) => [o.id, patch])));
}

const r6 = (n: number) => n.toFixed(6);

/** Two objects with the same signature render to exactly the same audio (position/track/mute don't matter). */
export function objectSignature(o: AudioObject): string {
  return [
    o.assetId, r6(o.trimStart), r6(o.duration), r6(o.pitchShiftCents),
    r6(o.gain), r6(o.fadeInTime), r6(o.fadeOutTime), r6(o.fadeInCurve), r6(o.fadeOutCurve),
    o.reverse ? 1 : 0, o.swap ? 1 : 0, r6(o.pan), o.resampleMode,
  ].join('|');
}

/** Select every object that is an exact copy of any selected one (the primary stays primary). */
export function selectIdentical(): number {
  const s = store.get();
  const sigs = new Set(getSelected(s).map(objectSignature));
  if (!sigs.size) return 0;
  const primary = getPrimary(s);
  const ids = s.objects.filter((o) => sigs.has(objectSignature(o))).map((o) => o.id);
  store.set({ selectedIds: primary ? [...ids.filter((i) => i !== primary.id), primary.id] : ids });
  return ids.length;
}

export function addAssetToTimeline(asset: AudioAsset): void {
  const s = store.get();
  const trackId = getPrimary(s)?.trackId ?? s.tracks[0].id;
  const obj: AudioObject = {
    id: uid(),
    assetId: asset.id,
    trackId,
    startTime: s.playheadPosition,
    trimStart: 0,
    duration: asset.buffer.length / asset.rate,
    gain: 1,
    fadeInTime: 0,
    fadeOutTime: 0,
    fadeInCurve: 0,
    fadeOutCurve: 0,
    pitchShiftCents: 0,
    resampleMode: 'linear',
    reverse: false,
    swap: false,
    isMuted: false,
    pan: 0,
  };
  clearHistory(); // new sample data: earlier snapshots can't be restored safely
  store.set({ objects: [...s.objects, obj], selectedIds: [obj.id], totalMemoryBytes: memory.total });
}

export function deleteSelected(): void {
  const s = store.get();
  if (s.isPlaying || !s.selectedIds.length) return;
  const victims = getSelected(s);
  const objects = s.objects.filter((o) => !s.selectedIds.includes(o.id));
  for (const v of victims) {
    if (!objects.some((o) => o.assetId === v.assetId)) memory.remove(v.assetId);
  }
  clearHistory(); // frees samples: not undoable
  store.set({ objects, selectedIds: [], totalMemoryBytes: memory.total });
}

/** Split every selected object that straddles the playhead (chop!). */
export function splitAtPlayhead(): void {
  const s = store.get();
  if (s.isPlaying) return;
  const head = s.playheadPosition;
  const rights: string[] = [];
  const objects = s.objects.flatMap((o) => {
    if (!s.selectedIds.includes(o.id)) return [o];
    const local = head - o.startTime;
    if (local <= MIN_DURATION || local >= o.duration - MIN_DURATION) return [o];
    const ratio = centsToRatio(o.pitchShiftCents);
    const cut = (o.reverse ? o.duration - local : local) * ratio; // source offset of the cut
    const left = clampFades({
      ...o,
      duration: local,
      fadeOutTime: 0,
      trimStart: o.reverse ? o.trimStart + cut : o.trimStart,
    });
    const right = clampFades({
      ...o,
      id: uid(),
      startTime: head,
      trimStart: o.reverse ? o.trimStart : o.trimStart + cut,
      duration: o.duration - local,
      fadeInTime: 0,
    });
    rights.push(right.id);
    return [left, right];
  });
  if (!rights.length) return;
  record();
  store.set({ objects, selectedIds: rights });
}

/**
 * Copy all selected objects as a block, appended after the right-most selected edge
 * (relative layout and tracks preserved). Independent properties, shared assets = no extra RAM.
 * The copies become the selection, so repeated calls keep chaining.
 */
export function duplicateSelected(): void {
  const s = store.get();
  if (s.isPlaying) return;
  const sel = getSelected(s);
  if (!sel.length) return;
  const left = Math.min(...sel.map((o) => o.startTime));
  const right = Math.max(...sel.map((o) => o.startTime + o.duration));
  const shift = right - left;
  record();
  const copies = sel.map((o) => ({ ...o, id: uid(), startTime: o.startTime + shift }));
  store.set({ objects: [...s.objects, ...copies], selectedIds: copies.map((c) => c.id) });
}

export function updateTrack(id: string, patch: Partial<import('./types').Track>): void {
  const s = store.get();
  // Slider drags (numbers) merge into one step; toggles are individual steps.
  const prop = Object.keys(patch)[0];
  record(typeof (patch as Record<string, unknown>)[prop] === 'number' ? `track:${id}:${prop}` : undefined);
  store.set({ tracks: s.tracks.map((t) => (t.id === id ? { ...t, ...patch } : t)) });
  // The mixer is live: it is allowed (and audible) during playback.
  engine.updateTracks(store.get());
}

/** Master strip (glue compressor). Live while playing; not part of undo. */
export function updateMaster(patch: Partial<import('./types').MasterSettings>): void {
  store.set({ master: { ...store.get().master, ...patch } });
  engine.updateMaster(store.get());
}
