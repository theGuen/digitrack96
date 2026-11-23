import { buildPayload } from './engine';
import { Mixer } from './dsp';
import { ProjectState, SAMPLE_RATE } from './types';

/** Render the whole timeline (0 .. last object end) to a 16-bit 44.1 kHz stereo WAV. */
export function bounceToWav(s: ProjectState): Blob | null {
  const p = buildPayload(s, true);
  if (!p) return null;
  const n = p.endFrame;
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const mixer = new Mixer(p.objects, p.assets, p.tracks, p.master);
  const CHUNK = 4096;
  for (let f = 0; f < n; f += CHUNK) {
    const len = Math.min(CHUNK, n - f);
    mixer.process(f, L.subarray(f, f + len), R.subarray(f, f + len), len);
  }

  return encodeWav([L, R]);
}
/** 16-bit PCM WAV from 1 (mono) or 2 (stereo) float channels at 44.1 kHz. Values are clipped to +-1. */
export function encodeWav(chans: Float32Array[]): Blob {
  const ch = chans.length;
  const n = chans[0].length;
  const dataBytes = n * ch * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const str = (o: number, t: string) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, 36 + dataBytes, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true);
  v.setUint32(24, SAMPLE_RATE, true); v.setUint32(28, SAMPLE_RATE * ch * 2, true);
  v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, dataBytes, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      const x = chans[c][i];
      v.setInt16(o, Math.round((x > 1 ? 1 : x < -1 ? -1 : x) * 32767), true);
      o += 2;
    }
  }
  return new Blob([buf], { type: 'audio/wav' });
}
