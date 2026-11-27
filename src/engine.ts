import workletUrl from './worklet.ts?worker&url';
import { centsToRatio, highPassCoefs, lowPassCoefs } from './dsp';
import { memory } from './memory';
import { AudioObject, PlaybackObject, PlaybackPayload, PlaybackTrack, ProjectState, SAMPLE_RATE } from './types';

let ctx: AudioContext | null = null;

export function getContext(): AudioContext {
  if (!ctx) ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
  return ctx;
}

/** Track mixer parameters (volume, pan, mute/solo, low-pass) — also sent live while playing. */
export function buildTrackParams(s: ProjectState): PlaybackTrack[] {
  const anySolo = s.tracks.some((t) => t.isSoloed);
  return s.tracks.map((t) => {
    const audible = anySolo ? t.isSoloed : !t.isMuted;
    const panL = t.pan <= 0 ? 1 : 1 - t.pan;
    const panR = t.pan >= 0 ? 1 : 1 + t.pan;
    const v = audible ? t.volume : 0;
    return { lp: lowPassCoefs(t.lowPassHz, SAMPLE_RATE), hp: highPassCoefs(t.highPassHz, SAMPLE_RATE), gL: v * panL, gR: v * panR };
  });
}

/** Frozen, pre-calculated playback description of one object. */
export function playbackObjectFor(o: AudioObject, assetIdx: number, trackIdx: number, rate = SAMPLE_RATE): PlaybackObject {
  const sr = SAMPLE_RATE;
  return {
    track: trackIdx,
    asset: assetIdx,
    startFrame: Math.round(o.startTime * sr),
    lengthFrames: Math.round(o.duration * sr),
    trimFrame: o.trimStart * rate,
    ratio: centsToRatio(o.pitchShiftCents) * (rate / sr), // source frames per output frame
    linear: o.resampleMode === 'linear',
    reverse: o.reverse,
    swap: o.swap,
    pan: o.pan,
    gain: o.gain,
    fadeInFrames: Math.round(o.fadeInTime * sr),
    fadeOutFrames: Math.round(o.fadeOutTime * sr),
    fadeInCurve: o.fadeInCurve,
    fadeOutCurve: o.fadeOutCurve,
  };
}

/** Resolve everything (fades, trims, mute/solo, pan) once, before playback starts. */
export function loopFrames(s: ProjectState): { start: number; end: number } | null {
  const l = s.loop;
  const start = Math.round(l.start * SAMPLE_RATE);
  const end = Math.round(l.end * SAMPLE_RATE);
  return l.on && end - start >= 64 ? { start, end } : null;
}

export function buildPayload(s: ProjectState, fromStart = false): PlaybackPayload | null {
  const sr = SAMPLE_RATE;
  const assetIndex = new Map<string, number>();
  const assets: Float32Array[][] = [];
  const objects: PlaybackObject[] = [];
  let endFrame = 0;

  for (const o of s.objects) {
    const track = s.tracks.find((t) => t.id === o.trackId);
    const asset = memory.get(o.assetId);
    if (!track || !asset) continue;
    const startFrame = Math.round(o.startTime * sr);
    const lengthFrames = Math.round(o.duration * sr);
    endFrame = Math.max(endFrame, startFrame + lengthFrames);
    if (o.isMuted) continue; // object mute is an edit-time property; track mute/solo are live

    let idx = assetIndex.get(o.assetId);
    if (idx === undefined) {
      idx = assets.length;
      assetIndex.set(o.assetId, idx);
      const chans: Float32Array[] = [];
      for (let c = 0; c < Math.min(asset.buffer.numberOfChannels, 2); c++) {
        chans.push(asset.buffer.getChannelData(c).slice());
      }
      assets.push(chans);
    }

    objects.push(playbackObjectFor(o, idx, s.tracks.indexOf(track), asset.rate));
  }

  const loop = loopFrames(s);
  let startFrame = fromStart ? 0 : Math.round(s.playheadPosition * sr);
  if (loop && startFrame >= loop.end) startFrame = loop.start;
  if (!objects.length || (!loop && startFrame >= endFrame)) return null;
  return { type: 'start', startFrame, endFrame, loop, tracks: buildTrackParams(s), master: { ...s.master }, assets, objects };
}

export class Engine {
  private node: AudioWorkletNode | null = null;
  private lastFrame = 0;
  private lastCtxTime = 0;
  private playing = false;
  private loop: { start: number; end: number } | null = null;
  onEnded: (position: number) => void = () => {};

  private async init(): Promise<AudioWorkletNode> {
    if (this.node) return this.node;
    const c = getContext();
    await c.audioWorklet.addModule(workletUrl);
    const node = new AudioWorkletNode(c, 'sampler-processor', { outputChannelCount: [2] });
    node.connect(c.destination);
    node.port.onmessage = (e) => {
      const m = e.data;
      this.lastFrame = m.frame;
      this.lastCtxTime = c.currentTime;
      if (m.type === 'ended') {
        this.playing = false;
        this.onEnded(m.frame / SAMPLE_RATE);
      }
    };
    this.node = node;
    return node;
  }

  async start(s: ProjectState): Promise<boolean> {
    const payload = buildPayload(s);
    if (!payload) return false;
    const node = await this.init();
    await getContext().resume();
    this.loop = payload.loop;
    this.lastFrame = payload.startFrame;
    this.lastCtxTime = getContext().currentTime;
    this.playing = true;
    node.port.postMessage(payload, payload.assets.flat().map((a) => a.buffer));
    return true;
  }

  /** Push live mixer changes (volume/pan/mute/solo/low-pass) to the running worklet. */
  updateTracks(s: ProjectState): void {
    if (this.playing) this.node?.port.postMessage({ type: 'tracks', tracks: buildTrackParams(s) });
  }

  /** Push loop on/off or moved markers to the running worklet. */
  updateLoop(s: ProjectState): void {
    this.loop = loopFrames(s);
    if (this.playing) this.node?.port.postMessage({ type: 'loop', loop: this.loop });
  }

  /** Push live master-strip changes to the running worklet. */
  updateMaster(s: ProjectState): void {
    if (this.playing) this.node?.port.postMessage({ type: 'master', master: { ...s.master } });
  }

  /** Stop immediately; returns the position where playback stopped. */
  stop(): number {
    const pos = this.getPosition();
    this.playing = false;
    this.node?.port.postMessage({ type: 'stop' });
    return pos;
  }

  getPosition(): number {
    const c = getContext();
    const extra = this.playing ? c.currentTime - this.lastCtxTime : 0;
    let f = this.lastFrame + extra * SAMPLE_RATE;
    const l = this.loop;
    if (this.playing && l && f >= l.end) f = l.start + ((f - l.start) % (l.end - l.start));
    return f / SAMPLE_RATE;
  }
}

export const engine = new Engine();
