import { MAX_MEMORY_BYTES, ProjectState, SAMPLE_RATE, Track } from './types';

type Listener = () => void;

export class Store<T> {
  private listeners = new Set<Listener>();
  constructor(private state: T) {}
  get(): T {
    return this.state;
  }
  set(patch: Partial<T>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }
  subscribe(l: Listener): void {
    this.listeners.add(l);
  }
}

const mkTrack = (i: number, name: string): Track => ({
  id: `track-${i}`,
  name,
  volume: 0.8,
  pan: 0,
  isMuted: false,
  isSoloed: false,
  lowPassHz: 20000,
  highPassHz: 20,
});

export const DEFAULT_MASTER = { on: false, comp: 0.4, mix: 1 };

export const defaultTracks = (): Track[] => [mkTrack(1, 'Drums'), mkTrack(2, 'Bass'), mkTrack(3, 'Sample'), mkTrack(4, 'Vox')];

export const store = new Store<ProjectState>({
  sampleRate: SAMPLE_RATE,
  totalMemoryBytes: 0,
  maxMemoryBytes: MAX_MEMORY_BYTES,
  tracks: defaultTracks(),
  master: { ...DEFAULT_MASTER },
  objects: [],
  isPlaying: false,
  playheadPosition: 0,
  selectedIds: [],
});
