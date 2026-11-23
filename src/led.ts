const SEG: Record<string, string> = {
  '0': 'abcdef', '1': 'bc', '2': 'abged', '3': 'abgcd', '4': 'fgbc',
  '5': 'afgcd', '6': 'afgedc', '7': 'abc', '8': 'abcdefg', '9': 'abcdfg',
};
const W = 24, H = 42, T = 5, GAP = 6;

function rects(x: number, y: number): Record<string, [number, number, number, number]> {
  const v = (H - 3 * T) / 2;
  return {
    a: [x + T, y, W - 2 * T, T],
    g: [x + T, y + (H - T) / 2, W - 2 * T, T],
    d: [x + T, y + H - T, W - 2 * T, T],
    f: [x, y + T, T, v],
    b: [x + W - T, y + T, T, v],
    e: [x, y + (H + T) / 2, T, v],
    c: [x + W - T, y + (H + T) / 2, T, v],
  };
}

/** Draws MM:SS.cc on a 7-segment LED canvas. */
export function drawLed(canvas: HTMLCanvasElement, seconds: number): void {
  const g = canvas.getContext('2d')!;
  const total = Math.max(0, Math.floor(seconds * 100));
  const cs = total % 100;
  const s = Math.floor(total / 100) % 60;
  const m = Math.floor(total / 6000) % 100;
  const text = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;

  g.clearRect(0, 0, canvas.width, canvas.height);
  g.fillStyle = '#1a0000';
  g.fillRect(0, 0, canvas.width, canvas.height);
  let x = 6;
  const y = 2;
  for (const ch of text) {
    if (ch === ':' || ch === '.') {
      g.fillStyle = '#ff3b30';
      const dots = ch === ':' ? [y + H * 0.3, y + H * 0.7] : [y + H - T];
      for (const dy of dots) g.fillRect(x + 1, dy, T, T);
      x += T + 4;
    } else {
      const lit = SEG[ch];
      for (const [k, r] of Object.entries(rects(x, y))) {
        g.fillStyle = lit.includes(k) ? '#ff3b30' : '#3a0805';
        g.fillRect(...r);
      }
      x += W + GAP;
    }
  }
}
