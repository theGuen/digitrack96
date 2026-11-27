import { runEq } from './eq';

/** Offline effects written in Faust and compiled to WebAssembly (see fx/*.dsp, scripts/build-fx.sh). */
export interface FxParam { label: string; unit: string; index: number; init: number; min: number; max: number; step: number; log?: boolean }
/** `run` marks a native (non-Faust) effect; `curve` shows the spline editor (params are freq / gain pairs). */
export interface FxDef { id: string; name: string; url: string; size: number; params: FxParam[]; /** samples the effect delays its output by (Faust `declare latency_samples`); removed after the render */ latency?: number; run?: (v: number[], d: Float32Array[], rate: number) => Float32Array[]; curve?: boolean }

interface FaustJson {
  name: string; size: number; meta?: Record<string, string>[];
  ui: { items: { label: string; index: number; init: number; min: number; max: number; step: number; meta?: Record<string, string>[] }[] }[];
}

const jsons = import.meta.glob('./fx/*.json', { eager: true, import: 'default' }) as Record<string, FaustJson>;
const urls = import.meta.glob('./fx/*.wasm', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;

const order = ['reverb', 'delay', 'phaser', 'vinyl', 'multicomp'];
export const EFFECTS: FxDef[] = Object.entries(jsons).map(([path, j]) => {
  const id = path.replace(/^.*\//, '').replace(/\.json$/, '');
  const meta = (it: FaustJson['ui'][0]['items'][0], k: string) => it.meta?.find((m) => k in m)?.[k];
  const params = j.ui[0].items
    .map((it) => ({ label: it.label, unit: meta(it, 'unit') ?? '', index: it.index, init: it.init, min: it.min, max: it.max, step: it.step, n: +(meta(it, 'n') ?? 99) }))
    .sort((a, b) => a.n - b.n)
    .slice(0, 4);
  const latency = +(j.meta?.find((m) => 'latency_samples' in m)?.latency_samples ?? 0);
  return { id, name: id[0].toUpperCase() + id.slice(1), url: urls[path.replace('.json', '.wasm')], size: j.size, params, latency };
}).sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));

const EQ_INIT = [[80, 0], [400, 0], [2500, 0], [10000, 0]];
EFFECTS.push({
  id: 'eq', name: 'Spline EQ', url: '', size: 0, curve: true, run: runEq,
  params: EQ_INIT.flatMap(([f, g], i) => [
    { label: `Band ${i + 1} freq`, unit: 'Hz', index: 0, init: f, min: 20, max: 20000, step: 1, log: true },
    { label: `Band ${i + 1} gain`, unit: 'dB', index: 0, init: g, min: -18, max: 18, step: 0.5 },
  ]),
});

const modules = new Map<string, Promise<WebAssembly.Module>>();
function moduleFor(def: FxDef): Promise<WebAssembly.Module> {
  let m = modules.get(def.id);
  if (!m) { m = WebAssembly.compileStreaming(fetch(def.url)).catch(async () => WebAssembly.compile(await (await fetch(def.url)).arrayBuffer())); modules.set(def.id, m); }
  return m;
}

/** Seconds of ringing to append after the sample so reverb / echo tails are not cut off. */
export function tailSeconds(def: FxDef, v: number[]): number {
  if (def.id === 'reverb') return Math.min(10, v[1] * 1.2 + v[0] / 1000);
  if (def.id === 'delay') {
    const rounds = Math.ceil(Math.log(0.001) / Math.log(Math.max(0.05, Math.min(0.95, v[1]))));
    return Math.min(8, (v[0] / 1000) * Math.max(1, rounds));
  }
  return 0;
}

const BLOCK = 1024;

/** Runs the effect over the data (1 or 2 channels, mono is fed to both inputs and summed back). */
export async function runFx(def: FxDef, values: number[], data: Float32Array[], rate: number, tail: number): Promise<Float32Array[]> {
  if (def.run) return def.run(values, data, rate);
  const mod = await moduleFor(def);
  const env: Record<string, (...a: number[]) => number> = {};
  for (const imp of WebAssembly.Module.imports(mod)) {
    const fn = (Math as unknown as Record<string, (...a: number[]) => number>)[imp.name.replace(/^_/, '').replace(/f$/, '')];
    env[imp.name] = fn;
  }
  const inst = new WebAssembly.Instance(mod, { env });
  const x = inst.exports as unknown as {
    memory: WebAssembly.Memory; init(dsp: number, sr: number): void; setParamValue(dsp: number, i: number, v: number): void;
    compute(dsp: number, n: number, inp: number, out: number): void;
  };
  const dsp = 0;
  x.init(dsp, rate);
  def.params.forEach((p, i) => x.setParamValue(dsp, p.index, values[i]));

  // memory: [dsp][in ptrs][out ptrs][in L][in R][out L][out R]
  const ptrs = (def.size + 15) & ~15;
  const inPtrs = ptrs, outPtrs = ptrs + 8;
  const buf = outPtrs + 8;
  const ch = (k: number) => buf + k * BLOCK * 4;
  if (ch(4) > x.memory.buffer.byteLength) throw new Error('effect needs more memory than it has');
  const dv = new DataView(x.memory.buffer);
  for (let k = 0; k < 2; k++) { dv.setInt32(inPtrs + k * 4, ch(k), true); dv.setInt32(outPtrs + k * 4, ch(2 + k), true); }

  const n = data[0].length;
  const total = n + Math.round(tail * rate);
  const mono = data.length === 1;
  const out = data.map(() => new Float32Array(total));
  const f32 = new Float32Array(x.memory.buffer);
  // the effect's own delay is rendered as extra samples at the end and cut off at the start
  const lat = def.latency ?? 0;
  for (let pos = 0; pos < total + lat; pos += BLOCK) {
    const m = Math.min(BLOCK, total + lat - pos);
    for (let k = 0; k < 2; k++) {
      const src = data[mono ? 0 : k];
      const view = f32.subarray(ch(k) / 4, ch(k) / 4 + BLOCK);
      view.fill(0);
      if (pos < n) view.set(src.subarray(pos, Math.min(n, pos + m)));
    }
    x.compute(dsp, m, inPtrs, outPtrs);
    const l = f32.subarray(ch(2) / 4, ch(2) / 4 + m), r = f32.subarray(ch(3) / 4, ch(3) / 4 + m);
    const skip = Math.max(0, lat - pos);   // output samples of this block that fall before the start
    if (skip >= m) continue;
    const at = pos + skip - lat;
    if (mono) for (let i = skip; i < m; i++) out[0][at + i - skip] = (l[i] + r[i]) * 0.5;
    else { out[0].set(l.subarray(skip), at); out[1].set(r.subarray(skip), at); }
  }
  return out;
}
