export const MAX_MEMORY_BYTES = 67_108_864 as const; // 64 MB
export const SAMPLE_RATE = 44100;

export interface AudioAsset {
  id: string;
  name: string;
  buffer: AudioBuffer;
  byteSize: number;
  rate: number; // real sampling rate of the stored frames (44100 or lower after a lo-fi bounce)
}

export interface AudioObject {
  id: string;
  assetId: string;
  trackId: string;
  startTime: number; // Position on timeline in seconds
  trimStart: number; // Offset inside asset in seconds
  duration: number; // Played duration in seconds (timeline time)
  gain: number; // Linear multiplier (0.0 to 2.0)
  fadeInTime: number; // Fade-in duration in seconds
  fadeOutTime: number; // Fade-out duration in seconds
  fadeInCurve: number; // 0 = linear ... 1 = exponential
  fadeOutCurve: number;
  pitchShiftCents: number; // -1200 to +1200
  resampleMode: 'nearest' | 'linear';
  reverse: boolean; // play the trimmed window backwards
  swap: boolean; // swap left and right channels
  isMuted: boolean; // object is skipped on playback/bounce
  pan: number; // -1..1 channel blend: -1 = left channel over both sides, +1 = right channel over both
}

export interface Track {
  id: string;
  name: string;
  volume: number; // 0..1
  pan: number; // -1..1
  isMuted: boolean;
  isSoloed: boolean;
  lowPassHz: number; // 20000 = filter off
  highPassHz: number; // 20 = filter off
}

export interface MasterSettings {
  on: boolean; // glue compressor engaged
  comp: number; // 0..1 single COMP knob (threshold, ratio, release, make-up, drive)
  mix: number; // 0..1 parallel blend (1 = fully compressed)
}

export interface ProjectState {
  master: MasterSettings;
  sampleRate: number;
  totalMemoryBytes: number;
  maxMemoryBytes: typeof MAX_MEMORY_BYTES;
  tracks: Track[];
  objects: AudioObject[];
  isPlaying: boolean;
  playheadPosition: number;
  selectedIds: string[]; // last entry = primary (drives the properties panel)
}

/** Frozen, pre-calculated payload sent to the AudioWorklet on playback start. */
export interface PlaybackObject {
  track: number; // index into PlaybackPayload.tracks
  asset: number; // index into PlaybackPayload.assets
  startFrame: number;
  lengthFrames: number;
  trimFrame: number; // source start (frames)
  ratio: number; // source frames consumed per output frame
  linear: boolean;
  reverse: boolean;
  swap: boolean;
  pan: number;
  gain: number;
  fadeInFrames: number;
  fadeOutFrames: number;
  fadeInCurve: number;
  fadeOutCurve: number;
}

/** Live mixer parameters for one track (changeable during playback). */
export interface PlaybackTrack {
  lp: number[] | null; // biquad [b0,b1,b2,a1,a2], null = bypass
  hp: number[] | null; // same, high-pass
  gL: number; // volume * pan * mute/solo resolved
  gR: number;
}

export interface PlaybackPayload {
  type: 'start';
  startFrame: number;
  endFrame: number;
  tracks: PlaybackTrack[];
  master: MasterSettings;
  assets: Float32Array[][]; // [asset][channel]
  objects: PlaybackObject[];
}
