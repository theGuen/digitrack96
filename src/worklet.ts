import { Mixer } from './dsp';
import type { PlaybackPayload } from './types';

// AudioWorklet globals are not in the DOM lib typings.
const Base = (globalThis as any).AudioWorkletProcessor as { new (): { port: MessagePort } };

const POS_INTERVAL = 2048;

class SamplerProcessor extends Base {
  private playing = false;
  private frame = 0;
  private endFrame = 0;
  private mixer: Mixer | null = null;
  private sinceReport = 0;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent) => {
      const m = e.data;
      if (m.type === 'start') {
        const p = m as PlaybackPayload;
        this.mixer = new Mixer(p.objects, p.assets, p.tracks, p.master);
        this.frame = p.startFrame;
        this.endFrame = p.endFrame;
        this.sinceReport = 0;
        this.playing = true;
      } else if (m.type === 'tracks') {
        this.mixer?.setTracks(m.tracks);
      } else if (m.type === 'master') {
        this.mixer?.setMaster(m.master);
      } else if (m.type === 'stop') {
        this.playing = false;
        this.port.postMessage({ type: 'stopped', frame: this.frame });
      }
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    const L = out[0];
    const R = out[1] ?? out[0];
    if (!this.playing) return true;

    const n = L.length;
    const f0 = this.frame;
    const f1 = f0 + n;
    this.mixer!.process(f0, L, R, n);

    this.frame = f1;
    this.sinceReport += n;
    if (f1 >= this.endFrame) {
      this.playing = false;
      this.port.postMessage({ type: 'ended', frame: this.endFrame });
    } else if (this.sinceReport >= POS_INTERVAL) {
      this.sinceReport = 0;
      this.port.postMessage({ type: 'pos', frame: f1 });
    }
    return true;
  }
}

(globalThis as any).registerProcessor('sampler-processor', SamplerProcessor);
