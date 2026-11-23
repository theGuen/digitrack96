import { AudioAsset, MAX_MEMORY_BYTES } from './types';

export class MemoryError extends Error {}

/** Tracks 16-bit PCM byte cost of all loaded assets against the memory ceiling (MAX_MEMORY_BYTES). */
export class MemoryManager {
  private assets = new Map<string, AudioAsset>();

  /** Bytes = samples * channels * 2 */
  static bytesFor(samples: number, channels: number): number {
    return samples * channels * 2;
  }

  get total(): number {
    let t = 0;
    for (const a of this.assets.values()) t += a.byteSize;
    return t;
  }

  get max(): number {
    return MAX_MEMORY_BYTES;
  }

  canFit(bytes: number): boolean {
    return this.total + bytes <= MAX_MEMORY_BYTES;
  }

  add(asset: AudioAsset): void {
    if (!this.canFit(asset.byteSize)) {
      throw new MemoryError(
        `Not enough memory to load "${asset.name}".\n` +
          `Needs ${mb(asset.byteSize)} MB, only ${mb(MAX_MEMORY_BYTES - this.total)} MB free.`,
      );
    }
    this.assets.set(asset.id, asset);
  }

  clear(): void {
    this.assets.clear();
  }

  remove(id: string): void {
    this.assets.delete(id);
  }

  get(id: string): AudioAsset | undefined {
    return this.assets.get(id);
  }
}

export const mb = (bytes: number) => (bytes / 1_048_576).toFixed(1);
export const memory = new MemoryManager();
