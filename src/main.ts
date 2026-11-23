import { store } from './store';
import { memory, mb, MemoryError } from './memory';
import { engine } from './engine';
import { Timeline } from './timeline';
import { drawLed } from './led';
import { loadFile } from './loader';
import { bounceToWav } from './bounce';
import { planOptimize } from './optimize';
import { showHelp } from './help';
import { showRecorder } from './recorder';
import { bounceSelectedInPlace, exportSelectedObjects } from './freeze';
import { loadProject, newProject, saveProject, ProjectError } from './project';
import { record } from './history';
import { canRedo, canUndo, redo, undo } from './history';
import { getAutosave, putAutosave, requestPersistence } from './storage';
import {
  deleteSelected, duplicateSelected, getPrimary, getSelected, selectIdentical, setPitch, splitAtPlayhead, syncMemory, updateMaster, updateSelected, updateTrack,
} from './actions';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const timeline = new Timeline($('timeline') as HTMLCanvasElement, $('canvas-wrap'));
// ---------- horizontal scrollbar ----------
const hscroll = $('hscroll');
const hscrollInner = $('hscroll-inner');
timeline.onView = () => {
  const w = timeline.contentPx();
  if (hscrollInner.style.width !== `${w}px`) hscrollInner.style.width = `${w}px`;
  if (Math.abs(hscroll.scrollLeft - timeline.scrollPx) > 0.5) hscroll.scrollLeft = timeline.scrollPx;
};
// No feedback loop: setScrollPx is a no-op when the value is unchanged.
hscroll.addEventListener('scroll', () => timeline.setScrollPx(hscroll.scrollLeft));
timeline.draw();

const led = $('led') as HTMLCanvasElement;
const BLOCKS = 24;

// ---------- Win95 dialog ----------
function alertBox(title: string, message: string): void {
  const root = $('dialog-root');
  root.innerHTML = `
    <div class="overlay"><div class="dialog win95-panel">
      <div class="titlebar">${title}</div>
      <div class="body"><div class="icon">×</div><div></div></div>
      <div class="actions"><button class="win95-button">OK</button></div>
    </div></div>`;
  root.querySelector('.body > div:last-child')!.textContent = message;
  const btn = root.querySelector('button')!;
  btn.onclick = () => (root.innerHTML = '');
  btn.focus();
}

/** Win95 OK/Cancel confirmation. */
function confirmBox(title: string, message: string, okLabel = 'OK'): Promise<boolean> {
  return new Promise((resolve) => {
    const root = $('dialog-root');
    root.innerHTML = `
      <div class="overlay"><div class="dialog win95-panel">
        <div class="titlebar"></div>
        <div class="body"><div class="icon" style="background:#000080">?</div><div></div></div>
        <div class="actions" style="gap:8px">
          <button class="win95-button" data-ok></button>
          <button class="win95-button" data-cancel>Cancel</button>
        </div>
      </div></div>`;
    root.querySelector('.titlebar')!.textContent = title;
    root.querySelector('.body > div:last-child')!.textContent = message;
    const ok = root.querySelector<HTMLButtonElement>('[data-ok]')!;
    ok.textContent = okLabel;
    const done = (v: boolean) => {
      root.innerHTML = '';
      resolve(v);
    };
    ok.onclick = () => done(true);
    root.querySelector<HTMLElement>('[data-cancel]')!.onclick = () => done(false);
    ok.focus();
  });
}

// ---------- song name ----------
let songName = '';
const APP_TITLE = 'Digitrack 96 — Boom-Bap Edition';

function cleanName(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const n = raw.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').trim().slice(0, 80);
  return n || 'untitled';
}
function setSongName(name: string): void {
  songName = name;
  $('title').textContent = name ? `${name} — ${APP_TITLE}` : APP_TITLE;
  document.title = name ? `${name} — Digitrack 96` : 'Digitrack 96 — Boom-Bap Edition';
}

/** Win95 text prompt. Resolves with the entered text, or null if cancelled. */
function promptBox(title: string, label: string, value: string): Promise<string | null> {
  return new Promise((resolve) => {
    const root = $('dialog-root');
    root.innerHTML = `
      <div class="overlay"><div class="dialog win95-panel">
        <div class="titlebar"></div>
        <div class="body" style="flex-direction:column;align-items:stretch;gap:8px">
          <label></label>
          <input type="text" class="win95-inset" style="padding:3px 4px;font:inherit;user-select:text" />
        </div>
        <div class="actions" style="gap:8px">
          <button class="win95-button" data-ok>OK</button>
          <button class="win95-button" data-cancel>Cancel</button>
        </div>
      </div></div>`;
    root.querySelector('.titlebar')!.textContent = title;
    root.querySelector('label')!.textContent = label;
    const input = root.querySelector('input')!;
    input.value = value;
    const done = (v: string | null) => {
      root.innerHTML = '';
      resolve(v);
    };
    root.querySelector<HTMLElement>('[data-ok]')!.onclick = () => done(input.value);
    root.querySelector<HTMLElement>('[data-cancel]')!.onclick = () => done(null);
    input.onkeydown = (e) => {
      if (e.key === 'Enter') done(input.value);
      else if (e.key === 'Escape') done(null);
    };
    input.focus();
    input.select();
  });
}

function download(blob: Blob, filename: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function status(msg: string): void {
  $('status').textContent = msg;
}

// ---------- track headers ----------
const headers = $('headers');
for (const t of store.get().tracks) {
  const el = document.createElement('div');
  el.className = 'thead win95-panel';
  el.innerHTML = `
    <div class="name"><span>${t.name}</span><small data-lpv="${t.id}">LP off</small></div>
    <div class="row">
      <button class="win95-button small" data-m="${t.id}">M</button>
      <button class="win95-button small" data-s="${t.id}">S</button>
    </div>
    <div class="row"><label>Vol</label><input type="range" min="0" max="1" step="0.01" value="${t.volume}" data-v="${t.id}"></div>
    <div class="row"><label>Pan</label><input type="range" min="-1" max="1" step="0.01" value="${t.pan}" data-p="${t.id}"></div>
    <div class="row"><label>LP</label><input type="range" min="0" max="1" step="0.005" value="1" data-lp="${t.id}" title="Low-pass cutoff (right = off)"></div>`;
  headers.appendChild(el);
}
headers.addEventListener('click', (e) => {
  const b = e.target as HTMLElement;
  const tracks = store.get().tracks;
  if (b.dataset.m) updateTrack(b.dataset.m, { isMuted: !tracks.find((t) => t.id === b.dataset.m)!.isMuted });
  if (b.dataset.s) updateTrack(b.dataset.s, { isSoloed: !tracks.find((t) => t.id === b.dataset.s)!.isSoloed });
});
headers.addEventListener('input', (e) => {
  const i = e.target as HTMLInputElement;
  if (i.dataset.v) updateTrack(i.dataset.v, { volume: +i.value });
  if (i.dataset.p) updateTrack(i.dataset.p, { pan: +i.value });
  if (i.dataset.lp) updateTrack(i.dataset.lp, { lowPassHz: Math.round(100 * Math.pow(200, +i.value)) });
});

// ---------- loading ----------
async function loadFiles(files: FileList | File[]): Promise<void> {
  for (const f of Array.from(files)) {
    if (store.get().isPlaying) return alertBox('Digitrack 96', 'Stop playback before loading audio.');
    if (f.name.toLowerCase().endsWith('.smp')) {
      await openProject(f);
      continue;
    }
    try {
      status(`Loading ${f.name}…`);
      await loadFile(f);
      status(`Loaded ${f.name}.`);
    } catch (err) {
      status('Load failed.');
      alertBox(err instanceof MemoryError ? 'Out of Memory' : 'Error', (err as Error).message || 'Could not decode file.');
    }
  }
}
async function openProject(f: File): Promise<void> {
  try {
    status(`Opening ${f.name}…`);
    await loadProject(f);
    setSongName(cleanName(f.name.replace(/\.[^.]*$/, '').replace(/ \(\d+\)$/, '')));
    status(`Opened ${f.name}.`);
  } catch (err) {
    status('Open failed.');
    alertBox(
      err instanceof MemoryError ? 'Out of Memory' : 'Error',
      err instanceof ProjectError || err instanceof MemoryError ? err.message : 'Could not open project.',
    );
  }
}
async function saveAs(): Promise<void> {
  const entered = await promptBox('Save Project', 'Song name:', songName || 'untitled');
  if (entered === null) return;
  const name = cleanName(entered);
  setSongName(name);
  const blob = saveProject();
  download(blob, `${name}.smp`);
  status(`Saved ${name}.smp (${(blob.size / 1_048_576).toFixed(1)} MB).`);
}
const projInput = $('proj') as HTMLInputElement;
$('btn-new').onclick = async () => {
  if (store.get().objects.length) {
    const ok = await confirmBox(
      'New Project',
      'Start a new empty project?\nEverything in the current project is removed. Save it first if you want to keep it.',
      'New',
    );
    if (!ok) return;
  }
  newProject();
  setSongName('');
  status('New project.');
};
$('btn-open').onclick = () => projInput.click();
projInput.onchange = () => {
  if (projInput.files?.[0]) void openProject(projInput.files[0]);
  projInput.value = '';
};
$('btn-save').onclick = () => void saveAs();
const fileInput = $('file') as HTMLInputElement;
$('btn-load').onclick = () => fileInput.click();
fileInput.onchange = () => {
  if (fileInput.files) void loadFiles(fileInput.files);
  fileInput.value = '';
};
window.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dragover'); });
window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dragover'); });
window.addEventListener('drop', (e) => {
  e.preventDefault();
  document.body.classList.remove('dragover');
  if (e.dataTransfer?.files.length) void loadFiles(e.dataTransfer.files);
});

// ---------- transport ----------
let raf = 0;
function tick(): void {
  if (!store.get().isPlaying) return;
  store.set({ playheadPosition: engine.getPosition() });
  raf = requestAnimationFrame(tick);
}

async function togglePlay(): Promise<void> {
  const s = store.get();
  if (s.isPlaying) {
    const pos = engine.stop();
    cancelAnimationFrame(raf);
    store.set({ isPlaying: false, playheadPosition: pos });
    status('Stopped. Editing unlocked.');
    return;
  }
  const ok = await engine.start(s);
  if (!ok) {
    status('Nothing to play from the playhead.');
    return;
  }
  store.set({ isPlaying: true });
  status('Playing — editing is locked (1996 rules), mixer is live. SPACE to stop.');
  raf = requestAnimationFrame(tick);
}
engine.onEnded = (pos) => {
  cancelAnimationFrame(raf);
  store.set({ isPlaying: false, playheadPosition: pos });
  status('End of timeline. Editing unlocked.');
};
timeline.onLockedAttempt = () => status('LOCKED: editing is disabled during playback. Press SPACE to stop.');

$('btn-play').onclick = () => void togglePlay();
$('btn-rew').onclick = () => {
  if (store.get().isPlaying) return;
  store.set({ playheadPosition: 0 });
  timeline.rewind();
};
$('btn-split').onclick = splitAtPlayhead;
$('btn-bounce').onclick = async () => {
  const blob = bounceToWav(store.get());
  if (!blob) return alertBox('Digitrack 96', 'Nothing to export.');
  if (!songName) {
    const entered = await promptBox('Export Audio', 'Song name:', 'untitled');
    if (entered === null) return;
    setSongName(cleanName(entered));
  }
  download(blob, `${songName}.wav`);
  status(`Exported ${(blob.size / 1_048_576).toFixed(1)} MB to ${songName}.wav (16-bit, 44.1 kHz stereo).`);
};
$('btn-optimize').onclick = async () => {
  if (store.get().isPlaying) return;
  const plan = planOptimize();
  if (!plan) return alertBox('Optimize Project', 'Nothing to optimize: no duplicate samples and no unused audio.');
  const msg =
    `RAM: ${mb(plan.before)} MB  →  ${mb(plan.after)} MB  (saves ${mb(plan.before - plan.after)} MB)\n\n` +
    `${plan.lines.join('\n')}\n\n` +
    'Everything on the timeline sounds exactly the same, and trims, fades and pitch stay editable. ' +
    'You can no longer trim outward past the kept audio. This cannot be undone, so Save first if unsure.';
  if (await confirmBox('Optimize Project', msg, 'Optimize')) {
    plan.apply();
    status(`Optimized: RAM ${mb(plan.before)} → ${mb(plan.after)} MB.`);
  }
};
$('btn-help').onclick = showHelp;
$('btn-rec').onclick = showRecorder;
$('btn-undo').onclick = undo;
$('btn-redo').onclick = redo;
$('btn-dup').onclick = duplicateSelected;
$('btn-del').onclick = deleteSelected;
// ---------- master strip ----------
$('m-on').onclick = () => updateMaster({ on: !store.get().master.on });
$('m-comp').oninput = (e) => updateMaster({ comp: Number((e.target as HTMLInputElement).value) / 100 });
$('m-mix').oninput = (e) => updateMaster({ mix: Number((e.target as HTMLInputElement).value) / 100 });

$('btn-snap').onclick = () => {
  timeline.setSnap(!timeline.snapOn);
  $('btn-snap').classList.toggle('on', timeline.snapOn);
  status(timeline.snapOn ? 'Snap on (hold Alt to bypass).' : 'Snap off.');
};
$('btn-zin').onclick = () => timeline.zoomBy(1.5);
$('btn-zout').onclick = () => timeline.zoomBy(1 / 1.5);

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement && e.target.type !== 'range') return;
  if ((e.metaKey || e.ctrlKey) && (e.code === 'KeyS' || e.code === 'KeyO')) {
    e.preventDefault();
    if (!store.get().isPlaying) $(e.code === 'KeyS' ? 'btn-save' : 'btn-open').click();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.code === 'KeyA') {
    e.preventDefault();
    if (!store.get().isPlaying) store.set({ selectedIds: store.get().objects.map((o) => o.id) });
    return;
  }
  if ((e.metaKey || e.ctrlKey) && (e.code === 'KeyZ' || e.code === 'KeyY')) {
    e.preventDefault();
    (e.code === 'KeyY' || e.shiftKey ? redo : undo)();
    return;
  }
  if (e.code === 'F1') {
    e.preventDefault();
    showHelp();
    return;
  }
  if (e.code === 'Space') {
    e.preventDefault();
    (document.activeElement as HTMLElement | null)?.blur?.();
    void togglePlay();
  } else if (e.code === 'Delete' || e.code === 'Backspace') {
    e.preventDefault();
    deleteSelected();
  } else if (e.code === 'KeyS' && !e.metaKey && !e.ctrlKey) {
    splitAtPlayhead();
  } else if (e.code === 'KeyI' && !e.metaKey && !e.ctrlKey) {
    if (!store.get().isPlaying) identical();
  } else if (e.code === 'KeyM' && !e.metaKey && !e.ctrlKey) {
    toggleObjectMute();
  } else if (e.code === 'KeyD' && !e.metaKey && !e.ctrlKey) {
    duplicateSelected();
  } else if (e.code === 'Home') {
    $('btn-rew').click();
  }
});

// ---------- object panel ----------
const pitch = $('o-pitch') as HTMLInputElement;
const setPitchSelected = (cents: number) => {
  if (store.get().isPlaying) return;
  record('pitch');
  getSelected().forEach((o) => setPitch(o.id, cents));
};
pitch.oninput = () => setPitchSelected(+pitch.value);
$('o-pitch-reset').onclick = () => setPitchSelected(0);
const panEl = $('o-pan') as HTMLInputElement;
panEl.oninput = () => updateSelected({ pan: +panEl.value / 100 }, 'pan');
$('o-pan-reset').onclick = () => updateSelected({ pan: 0 });
$('o-dirty').onclick = () => updateSelected({ resampleMode: 'nearest' });
$('o-clean').onclick = () => updateSelected({ resampleMode: 'linear' });

// Toggles act on the whole selection, flipping relative to the primary object.
function toggleObjectMute(): void {
  const p = getPrimary();
  if (p) updateSelected({ isMuted: !p.isMuted });
}
$('o-mute').onclick = toggleObjectMute;
$('o-swap').onclick = () => {
  const p = getPrimary();
  if (p) updateSelected({ swap: !p.swap });
};
const identical = () => {
  const n = selectIdentical();
  if (n) status(`${n} identical object${n > 1 ? 's' : ''} selected.`);
};
$('o-ident').onclick = identical;
$('o-export').onclick = () => {
  const n = exportSelectedObjects();
  if (n) status(`Exported ${n} object${n > 1 ? 's' : ''} as WAV (16-bit, 44.1 kHz). Project unchanged.`);
};
let lastSelKey = '';
$('o-freeze').onclick = () => {
  try {
    const rate = Number(($('o-rate') as HTMLSelectElement).value);
    const rateTxt = rate < 44100 ? ` at ${rate / 1000} kHz` : '';
    const before = memory.total;
    const { objects: n, samples } = bounceSelectedInPlace(rate);
    if (n) status(`Bounced ${n} object${n > 1 ? 's' : ''} in place into ${samples} sample${samples > 1 ? 's' : ''}${rateTxt}${memory.total < before ? ` — freed ${mb(before - memory.total)} MB` : ''}.`);
  } catch (err) {
    alertBox('Out of Memory', (err as Error).message);
  }
};
$('o-rev').onclick = () => {
  const p = getPrimary();
  if (p) updateSelected({ reverse: !p.reverse });
};

// ---------- RAM meter ----------
const ramBar = $('ram-bar');
for (let i = 0; i < BLOCKS; i++) ramBar.appendChild(document.createElement('i'));

// ---------- render UI from state ----------
function render(): void {
  const s = store.get();
  drawLed(led, s.playheadPosition);

  const frac = s.totalMemoryBytes / s.maxMemoryBytes;
  $('ram-label').textContent = `RAM Used: ${mb(s.totalMemoryBytes)} MB / ${mb(s.maxMemoryBytes)} MB`;
  ramBar.classList.toggle('hot', frac >= 0.9);
  Array.from(ramBar.children).forEach((c, i) => c.classList.toggle('lit', i < Math.ceil(frac * BLOCKS - 1e-9)));

  const playBtn = $('btn-play');
  playBtn.textContent = s.isPlaying ? '■ Stop' : '▶ Play';
  playBtn.classList.toggle('active', s.isPlaying);
  $('main').classList.toggle('locked', s.isPlaying);
  $('lock').textContent = s.isPlaying ? 'LOCKED' : 'EDIT';
  $('lock').classList.toggle('locked', s.isPlaying);
  ($('btn-undo') as HTMLButtonElement).disabled = s.isPlaying || !canUndo();
  ($('btn-redo') as HTMLButtonElement).disabled = s.isPlaying || !canRedo();
  for (const id of ['btn-new', 'btn-open', 'btn-save', 'btn-load', 'btn-rec', 'btn-rew', 'btn-split', 'btn-dup', 'btn-del', 'btn-bounce', 'btn-optimize']) ($(id) as HTMLButtonElement).disabled = s.isPlaying;

  s.tracks.forEach((t, i) => {
    const el = headers.children[i + 1];
    for (const [attr, v] of [['v', t.volume], ['p', t.pan], ['lp', Math.log(t.lowPassHz / 100) / Math.log(200)]] as const) {
      const inp = el.querySelector<HTMLInputElement>(`[data-${attr}]`)!;
      if (document.activeElement !== inp) inp.value = String(v);
    }
    el.querySelector<HTMLElement>('[data-lpv]')!.textContent =
      t.lowPassHz >= 20000 ? 'LP off' : `LP ${t.lowPassHz >= 1000 ? (t.lowPassHz / 1000).toFixed(1) + 'k' : t.lowPassHz}`;
    el.querySelector<HTMLElement>('[data-m]')!.classList.toggle('on', t.isMuted);
    el.querySelector<HTMLElement>('[data-s]')!.classList.toggle('on', t.isSoloed);
  });

  const m = s.master;
  $('m-on').classList.toggle('on', m.on);
  for (const [id, v] of [['m-comp', m.comp], ['m-mix', m.mix]] as const) {
    const inp = $(id) as HTMLInputElement;
    if (document.activeElement !== inp) inp.value = String(Math.round(v * 100));
  }

  const o = getPrimary(s);
  const count = s.selectedIds.length;
  const selKey = s.selectedIds.join(',') + '|' + (o?.assetId ?? '');
  if (selKey !== lastSelKey) {
    lastSelKey = selKey;
    // dropdown follows the selected object's sample rate (so a bounce only changes it if you pick something lower)
    const sel = $('o-rate') as HTMLSelectElement;
    const r = o ? memory.get(o.assetId)?.rate ?? 44100 : 44100;
    const opts = [...sel.options].map((x) => Number(x.value));
    sel.value = String(opts.reduce((best, v) => (Math.abs(v - r) < Math.abs(best - r) ? v : best), 44100));
  }
  $('objpanel').classList.toggle('disabled', !o || s.isPlaying);
  if (o) {
    $('o-name').textContent = count > 1 ? `${count} objects selected` : (memory.get(o.assetId)?.name ?? '?');
    if (document.activeElement !== pitch) pitch.value = String(o.pitchShiftCents);
    $('o-pitch-val').textContent = `${o.pitchShiftCents > 0 ? '+' : ''}${o.pitchShiftCents} c`;
    const pv = Math.round(o.pan * 100);
    if (document.activeElement !== panEl) panEl.value = String(pv);
    $('o-pan-val').textContent = pv === 0 ? 'C' : `${pv < 0 ? 'L' : 'R'} ${Math.abs(pv)}`;
    $('o-rev').classList.toggle('on', o.reverse);
    $('o-swap').classList.toggle('on', o.swap);
    $('o-mute').classList.toggle('on', o.isMuted);
    $('o-dirty').classList.toggle('on', o.resampleMode === 'nearest');
    $('o-clean').classList.toggle('on', o.resampleMode === 'linear');
    $('o-info').textContent = count > 1 ? `primary: ${memory.get(o.assetId)?.name ?? '?'}` :
      `start ${o.startTime.toFixed(2)}s  len ${o.duration.toFixed(2)}s  gain ${(o.gain * 100).toFixed(0)}%  ` +
      `fade ${o.fadeInTime.toFixed(2)}/${o.fadeOutTime.toFixed(2)}s`;
  } else {
    $('o-name').textContent = '— nothing selected —';
    $('o-info').textContent = '—';
    $('o-rev').classList.remove('on');
    $('o-swap').classList.remove('on');
    $('o-mute').classList.remove('on');
    $('o-dirty').classList.remove('on');
    $('o-clean').classList.remove('on');
  }
}
store.subscribe(render);
syncMemory();
render();

// ---------- autosave to browser storage ----------
let persistent = false;
let autosaveReady = false; // don't overwrite a stored session before we've tried to restore it
let lastObjects = store.get().objects;
let lastTracks = store.get().tracks;
let lastName = songName;
let autosaveTimer = 0;

async function autosaveNow(): Promise<void> {
  if (store.get().isPlaying) {
    scheduleAutosave(); // try again after playback
    return;
  }
  try {
    await putAutosave({ name: songName, savedAt: Date.now(), blob: saveProject() });
    const t = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    status(`Autosaved to browser storage at ${t}${persistent ? '' : ' (not marked persistent — the browser may clear it)'}.`);
  } catch {
    status('Autosave failed (browser storage full or blocked). Use Save… to keep your work.');
  }
}
function scheduleAutosave(): void {
  clearTimeout(autosaveTimer);
  autosaveTimer = window.setTimeout(() => void autosaveNow(), 2000);
}

store.subscribe(() => {
  if (!autosaveReady) return;
  const s = store.get();
  // Only react to real project changes (not playhead movement / selection).
  if (s.objects !== lastObjects || s.tracks !== lastTracks || songName !== lastName) {
    lastObjects = s.objects;
    lastTracks = s.tracks;
    lastName = songName;
    scheduleAutosave();
  }
});

(async () => {
  persistent = await requestPersistence();
  try {
    const saved = await getAutosave();
    if (saved) {
      await loadProject(new File([saved.blob], `${saved.name || 'untitled'}.smp`));
      setSongName(saved.name);
      status(`Restored last session${saved.name ? ` "${saved.name}"` : ''} from browser storage.`);
    }
  } catch {
    status('Could not restore the last session from browser storage.');
  } finally {
    lastObjects = store.get().objects;
    lastTracks = store.get().tracks;
    lastName = songName;
    autosaveReady = true;
  }
})();

// ---------- PWA: offline cache (production builds only) ----------
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}
