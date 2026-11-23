// AudioWorklet that hands the input (up to 2 channels) back to the page in blocks.
const Base = (globalThis as any).AudioWorkletProcessor as { new (): { port: MessagePort } };

const BLOCK = 2048;

class RecorderProcessor extends Base {
  private bufs: Float32Array[] = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
  private fill = 0;
  private channels = 1;

  process(inputs: Float32Array[][]): boolean {
    const inp = inputs[0];
    if (!inp || !inp.length) return true;
    this.channels = Math.min(2, inp.length);
    const n = inp[0].length;
    for (let k = 0; k < n; k++) {
      this.bufs[0][this.fill] = inp[0][k];
      this.bufs[1][this.fill] = (inp[1] ?? inp[0])[k];
      if (++this.fill === BLOCK) {
        const out = this.bufs.slice(0, this.channels);
        this.port.postMessage({ chs: out }, out.map((b) => b.buffer));
        this.bufs = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
        this.fill = 0;
      }
    }
    return true;
  }
}

(globalThis as any).registerProcessor('recorder-processor', RecorderProcessor);
