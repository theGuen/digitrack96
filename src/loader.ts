import { AudioAsset, SAMPLE_RATE } from './types';
import { MemoryManager, memory, MemoryError } from './memory';
import { getContext } from './engine';
import { addAssetToTimeline } from './actions';

/** Decode WAV/MP3 at 44.1 kHz, crush to 16 bit, enforce the memory ceiling. */
export async function loadFile(file: File): Promise<void> {
  const ctx = getContext();
  const buffer = await ctx.decodeAudioData(await file.arrayBuffer());
  if (buffer.sampleRate !== SAMPLE_RATE) throw new Error('Unexpected sample rate after decode.');

  const channels = Math.min(buffer.numberOfChannels, 2);
  const byteSize = MemoryManager.bytesFor(buffer.length, channels);

  // Check BEFORE committing anything.
  if (!memory.canFit(byteSize)) {
    throw new MemoryError(
      `Not enough memory to load "${file.name}".\n` +
        `Needs ${(byteSize / 1_048_576).toFixed(1)} MB, ` +
        `only ${((memory.max - memory.total) / 1_048_576).toFixed(1)} MB free of ${(memory.max / 1_048_576).toFixed(1)} MB.`,
    );
  }

  // 16-bit quantisation for that authentic noise floor.
  for (let c = 0; c < channels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i++) d[i] = Math.round(d[i] * 32767) / 32767;
  }

  const asset: AudioAsset = { id: crypto.randomUUID(), name: file.name, buffer, byteSize, rate: SAMPLE_RATE };
  memory.add(asset);
  addAssetToTimeline(asset);
}
