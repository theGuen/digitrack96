# Digitrack 96

A small sample-chopping DAW for the browser with a 1996 feel, made for boom-bap and sample-based beats.
It is an **instrument**, not a grid: no BPM, no quantize. You place everything by ear and by eye.

**Try it:** https://theguen.github.io/digitrack96/

## The idea

- **64 MB of sample memory**, 16-bit, 44.1 kHz. The limit is the point: record the good bars, chop, move on.
- **Four tracks** with live volume, pan, mute, solo and a low-pass each.
- **Objects** (the clips on the timeline) with trim, fades, gain, pitch/stretch (tape style: length changes pitch), reverse, left/right swap, a channel-blend pan and mute.
- **Double** repeats a loop, **Select Identical** finds exact copies, **Optimize** merges duplicate samples and crops unused audio.
- **Bounce Object** bakes what you see into a new sample. Choose a sampling rate (44.1 kHz down to 4 kHz) to save memory and add lo-fi grit.
- **Record** from any input (microphone, audio interface, a phone used as a sound card), with live waveform, monitor, preview and auto-trim.
- **Master Glue**: one simple, aggressive compressor knob plus a parallel mix.
- **Save** writes a `.smp` file with the samples inside. Your work is also autosaved in the browser, which is a safety net and not a backup.
- Works offline once opened (installable as an app). Everything stays on your computer; nothing is uploaded.

Press **?** (or F1) in the app for the handle diagram and the keys.

## Run it

```
npm install
npm run dev       # http://localhost:5173
npm run build     # static site in dist/
```

Any static host works, as long as it serves over HTTPS (needed for the microphone, the service worker and audio worklets).
Pushing to `main` deploys to GitHub Pages through `.github/workflows/deploy.yml`
(Settings → Pages → Source: *GitHub Actions*).

## Built with

TypeScript, Vite, the Web Audio API with AudioWorklets, and Canvas. No runtime dependencies.
