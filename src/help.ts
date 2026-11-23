const HTML = `
<h3>Object handles</h3>
<p>Click an object to select it. With exactly <b>one</b> object selected, six handles appear (not while playing):</p>
<div class="help-handles">
  <svg viewBox="0 0 220 110" width="220" height="110" aria-label="Object with six numbered handles">
    <rect x="20" y="20" width="180" height="70" fill="#000" stroke="#ffff00" stroke-width="2"/>
    <path d="M24 70 q20 -10 30 -4 t30 8 t40 -6 t40 4 t30 -2" fill="none" stroke="#33ff66" stroke-width="2"/>
    <g fill="#c0c0c0" stroke="#000">
      <rect x="15" y="15" width="10" height="10"/><rect x="105" y="15" width="10" height="10"/>
      <rect x="195" y="15" width="10" height="10"/><rect x="195" y="50" width="10" height="10"/>
      <rect x="15" y="85" width="10" height="10"/><rect x="195" y="85" width="10" height="10"/>
    </g>
    <g font-size="11" font-family="Arial" font-weight="bold" fill="#fff">
      <text x="14" y="10">1</text><text x="106" y="10">2</text><text x="196" y="10">3</text>
      <text x="208" y="59">4</text><text x="14" y="108">5</text><text x="196" y="108">6</text>
    </g>
  </svg>
  <ol>
    <li><b>Top left: fade in.</b> Drag sideways for the length, up/down for the shape (linear ↔ exponential).</li>
    <li><b>Top middle: gain.</b> Drag up/down (0 – 200 %).</li>
    <li><b>Top right: fade out.</b> Same as fade in, mirrored.</li>
    <li><b>Right middle: stretch.</b> Tape-style: making the object longer lowers the pitch, shorter raises it (±1200 cents).</li>
    <li><b>Bottom left: in-point</b> (trim the start).</li>
    <li><b>Bottom right: out-point</b> (trim the end).</li>
  </ol>
</div>

<h3>Selecting and moving</h3>
<ul>
  <li>Drag an object to move it, also to another track. <b>Shift/Ctrl/Cmd-click</b> adds or removes objects from the selection.</li>
  <li>Drag on empty space to draw a selection box. <b>Ctrl/Cmd+A</b> selects everything. Click empty space to deselect and place the playhead; click the ruler to move the playhead.</li>
  <li><b>Snap</b> pulls edges to other objects, the playhead and 0. Hold <b>Alt</b> to ignore it for one drag. There is no grid, by design.</li>
  <li>While playing, editing is <b>locked</b> (1996 rules). Press <b>Space</b> to stop. The track sliders (volume, pan, low-pass, mute, solo) stay live.</li>
</ul>

<h3>Keys</h3>
<table class="help-keys">
  <tr><td><kbd>Space</kbd></td><td>Play / stop</td><td><kbd>S</kbd></td><td>Split at the playhead</td></tr>
  <tr><td><kbd>D</kbd></td><td>Double: copy the selection after its right edge</td><td><kbd>M</kbd></td><td>Mute object</td></tr>
  <tr><td><kbd>I</kbd></td><td>Select identical copies</td><td><kbd>Del</kbd></td><td>Delete selection</td></tr>
  <tr><td><kbd>Home</kbd></td><td>Rewind</td><td><kbd>F1</kbd></td><td>This help</td></tr>
  <tr><td><kbd>Ctrl/Cmd+Z</kbd></td><td>Undo (add <kbd>Shift</kbd> to redo)</td><td><kbd>Ctrl/Cmd+S/O</kbd></td><td>Save / open project</td></tr>
  <tr><td colspan="4">Mouse wheel / trackpad or the scrollbar scrolls the timeline, <kbd>Ctrl/Cmd</kbd>+wheel or the Zoom buttons zoom.</td></tr>
</table>

<h3>Object panel (bottom)</h3>
<ul>
  <li><b>Pitch</b> ±1200 cents (also changes the length, like tape). <b>Dirty</b> = nearest-neighbour (gritty, aliased), <b>Clean</b> = linear.</li>
  <li><b>Pan</b> is a channel blend: L 100 puts the left channel on both sides and removes the right one's own signal; L 25 mixes 25 % of the left over the right. It does nothing to mono samples.</li>
  <li><b>Reverse</b>, <b>Swap L/R</b>, <b>Mute</b> work on the whole selection.</li>
  <li><b>Select Identical</b> finds exact copies. <b>Bounce Object</b> bakes what you see into a new sample (identical copies share one). <b>Export Object WAV</b> downloads the object, the project stays unchanged.</li>
  <li>The dropdown next to <b>Bounce Object</b> sets the sampling rate of the new sample. Lower rates (11 kHz, 8 kHz, 4 kHz) cut the highs and add grit, and they save memory. It follows the rate of the selected object.</li>
</ul>

<h3>Master strip (top right)</h3>
<ul>
  <li><b>Glue</b> switches on a simple but aggressive glueing compressor on the whole mix. <b>Comp</b> sets how hard it squeezes: more Comp means lower threshold, higher ratio, faster release and more make-up gain, so quiet parts come up and loud hits are pushed down. <b>Mix</b> blends compressed and dry sound (parallel glue).</li>
  <li>It works while playing and is included in <b>Export Audio</b> and the saved project. Bounce Object and Export Object WAV do not use it.</li>
</ul>

<h3>Projects, files and memory</h3>
<ul>
  <li><b>Import Audio</b> loads WAV/MP3 (or drop files on the window). Everything is converted to 44.1 kHz and crushed to 16 bit.</li>
  <li><b>Record…</b> opens a small recorder: pick an input, press Record (or Space), and watch the waveform. <b>Auto-trim</b> cuts silence from the start and end of the take. <b>Play</b> previews the take as it will be added. <b>Add to Timeline</b> converts it to 44.1 kHz / 16 bit and puts it at the playhead. Microphone access needs your permission,. <b>Monitor</b> plays the input through your speakers or headphones (off by default; it is not exactly real-time, and speakers with a microphone will feed back).</li>
  <li><b>Save…</b> writes a <code>.smp</code> file with the whole project <i>including the samples</i>. <b>Open…</b> (or dropping the file) loads it and replaces the current project.</li>
  <li>Your work is also <b>autosaved in this browser</b> and restored after a reload. That is a safety net, not a backup: browsers can clear it. Save regularly.</li>
  <li><b>Export Audio</b> renders the whole timeline to a 16-bit WAV.</li>
  <li><b>Memory:</b> samples share a budget of 64 MB (about 6:20 of stereo or 12:40 of mono). Double copies share their sample, so they cost nothing. <b>Optimize…</b> merges duplicate samples and crops unused audio to free memory, with a preview first.</li>
  <li><b>Undo</b> covers non-destructive edits. Delete, Bounce Object, Import, Open and Optimize change sample data, so they clear the undo history.</li>
  <li>Everything stays on your computer. Nothing is uploaded.</li>
</ul>
`;

export function showHelp(): void {
  const root = document.getElementById('dialog-root')!;
  root.innerHTML = `
    <div class="overlay"><div class="dialog help win95-panel" role="dialog" aria-label="Help">
      <div class="titlebar"><span>Digitrack 96 — Help</span></div>
      <div class="help-body win95-inset">${HTML}</div>
      <div class="actions"><button class="win95-button" data-close>Close</button></div>
    </div></div>`;
  const close = () => {
    root.innerHTML = '';
    document.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' || e.key === 'Enter') {
      e.preventDefault();
      close();
    }
    e.stopPropagation(); // keep shortcuts (Space, S, D …) from firing while help is open
  };
  document.addEventListener('keydown', onKey, true);
  root.querySelector<HTMLButtonElement>('[data-close]')!.onclick = close;
  root.querySelector<HTMLElement>('.overlay')!.onclick = (e) => {
    if (e.target === e.currentTarget) close();
  };
  root.querySelector<HTMLButtonElement>('[data-close]')!.focus();
}
