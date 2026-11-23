import { store } from './store';
import { AudioObject, Track } from './types';

/**
 * Undo/redo for non-destructive edits only. A snapshot is just the (immutable) objects + tracks arrays,
 * so it is cheap. Edits that add/remove sample data (delete, bounce object, import, open project)
 * call clearHistory(), because snapshots would then refer to samples that are gone.
 */
interface Snap {
  objects: AudioObject[];
  tracks: Track[];
}

const LIMIT = 200;
const COALESCE_MS = 600;
const undoStack: Snap[] = [];
let redoStack: Snap[] = [];
let lastKey = '';
let lastTime = 0;

const snap = (): Snap => ({ objects: store.get().objects, tracks: store.get().tracks });

/** Call BEFORE changing the project. Same `key` within 600 ms (slider drags) merges into one step. */
export function record(key?: string): void {
  const now = performance.now();
  const merge = key !== undefined && key === lastKey && now - lastTime < COALESCE_MS && undoStack.length > 0;
  lastKey = key ?? '';
  lastTime = now;
  if (merge) return;
  undoStack.push(snap());
  if (undoStack.length > LIMIT) undoStack.shift();
  redoStack = [];
}

export const canUndo = () => undoStack.length > 0;
export const canRedo = () => redoStack.length > 0;

function apply(s: Snap): void {
  const ids = new Set(s.objects.map((o) => o.id));
  store.set({
    objects: s.objects,
    tracks: s.tracks,
    selectedIds: store.get().selectedIds.filter((id) => ids.has(id)),
  });
}

export function undo(): void {
  if (store.get().isPlaying) return;
  const prev = undoStack.pop();
  if (!prev) return;
  redoStack.push(snap());
  lastKey = '';
  apply(prev);
}

export function redo(): void {
  if (store.get().isPlaying) return;
  const next = redoStack.pop();
  if (!next) return;
  undoStack.push(snap());
  lastKey = '';
  apply(next);
}

export function clearHistory(): void {
  undoStack.length = 0;
  redoStack = [];
  lastKey = '';
  store.set({}); // refresh button states
}
