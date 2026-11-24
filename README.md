# Digitrack 96

A small four-track wave editor for the browser, a homage to the pre-DAW era.

**Open it:** https://theguen.github.io/digitrack96/

It can be installed as an app and works offline once loaded.
Your audio stays on your computer and is never uploaded.

It is made for a desktop browser with a mouse or trackpad (Chrome works best). The layout does not adapt to phones, and tablets are untested.

## What it is

Digitrack 96 is built for non-destructive timeline editing. You drag pieces of audio around, trim them, fade them, stretch them like tape and listen. Nothing is quantized and there is no tempo. Everything is placed by ear and by eye.

It is not meant to master your next mixtape. It is a small tool for re-evaluating how it feels to move wave snippets around without a BPM grid.

## What it does

- **Four tracks** with live volume, pan, mute, solo and a low-pass filter each.
- **Objects**, the pieces of audio on the timeline, with trim, fades, gain, tape-style pitch and stretch, reverse, left/right swap, a channel-blend pan and mute. Every object keeps its own settings.
- **Split**, **Double** (repeat a selection), **Select Identical** and multi-select, with snapping to object edges.
- **Undo** for every non-destructive edit.
- **Bounce Object** renders what you see into a new sample. A sampling-rate choice (44.1 kHz down to 4 kHz) lets you trade fidelity for memory, or add some grit on purpose.
- **Optimize** merges duplicate samples and crops audio nobody uses, with a preview first.
- **Record** from any input (microphone, audio interface, a phone used as a sound card), with a live waveform, monitoring, preview and auto-trim.
- **Master Glue**, a single-knob compressor with a parallel mix.
- **Export Audio** and **Export Object WAV** write 16-bit WAV files.

## The limits are part of the design

The app deliberately works under 1990s rules:

- **64 MB** of sample memory, stored as 16-bit at 44.1 kHz. That is about 6 minutes of stereo or 12 minutes of mono. The RAM meter is always visible.
- Editing is **locked during playback**. Stop first, then edit. The track sliders stay live.
- Samples are prepared before playback starts, so playback itself is simple and steady.

## Using it

Press **?** (or F1) in the app for the full help. In short:

- **Import** audio with the button or by dropping WAV/MP3 files on the window. **Save** writes a `.smp` project file that contains the samples. Your work is also autosaved in the browser, which is a safety net and not a backup.
- **Click** an object to select it. With one object selected, six handles appear: fade in, gain, fade out, stretch, in-point and out-point.
- **Drag** to move, also between tracks. Shift/Ctrl/Cmd-click adds to the selection, dragging on empty space draws a selection box. Hold **Alt** to ignore snapping.

| Key | Action | Key | Action |
| --- | --- | --- | --- |
| `Space` | Play / stop | `S` | Split at the playhead |
| `D` | Double the selection | `M` | Mute object |
| `I` | Select identical | `Del` | Delete |
| `Home` | Rewind | `F1` | Help |
| `Ctrl/Cmd+Z` | Undo (add `Shift` to redo) | `Ctrl/Cmd+S` / `O` | Save / open project |

Everything stays on your computer. Nothing is uploaded.

## Build it yourself

You need Node.js 20 or newer.

```
npm install
npm run dev       # development server on http://localhost:5173
npm run build     # type-check and build the static site into dist/
```

The result in `dist/` is a plain static site. Any host works, as long as it serves over HTTPS (the microphone, the service worker and audio worklets require it).

Pushing to `main` deploys to GitHub Pages through `.github/workflows/deploy.yml`. In the repository settings, set Pages → Source to **GitHub Actions**.

Built with TypeScript, Vite, the Web Audio API (AudioWorklets) and Canvas. There are no runtime dependencies.

## License

[MIT](LICENSE)
