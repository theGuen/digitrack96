Technical Specification: Digitrack 96, a Retro Web Wave Editor

1. Overview & Core Philosophy

A lightweight, web-based digital audio workstation (DAW) inspired by the hard-disk recording software of the mid-1990s, built around hands-on, non-destructive sample editing. The application strictly enforces authentic hardware and UI constraints from 1996 to capture vintage sampler/DAW ergonomics and simplify the audio engine architecture.

Key Constraints ("1996 Limitations")

Playback Timeline Lock: Editing operations (dragging objects, editing trim handles, modifying fade curves) are disabled during audio playback. Spacebar toggles playback.

16 MB RAM Ceiling: Hard limit of 16.0 MB total uncompressed sample memory allocated across all active audio objects.

Pre-calculated DSP Engine: Fades, gains, and trim boundaries are calculated once prior to playback start, eliminating real-time thread synchronization issues.

2. Technical Stack

UI/Rendering: HTML5 Canvas, Vanilla CSS / Tailwind (Windows 95 theme engine)

Audio Core: Web Audio API, custom AudioWorkletProcessor

State Management: Immutable State / Typed Array Transferables via postMessage

Language Target: TypeScript / ES2022+

3. UI/UX Specifications (Windows 95 / Classic 90s Theme)

3.1 Styling & Palette

Background Color: Classic Windows Gray #C0C0C0

Panels & Windows: Sunken/Raised 3D beveled borders using 1px white (#FFFFFF) and dark gray (#808080 / #000000) borders.

Typography: Pixelated or clean monospace/sans-serif fonts (e.g., MS Sans Serif, Courier New, or VT323).

3.2 Key UI Components

Segmented LED Time Counter: Displays current playhead position in MM:SS.ms (00:00.00) format using a vintage LED digital display aesthetic.

System RAM Meter:

Visual gauge showing memory consumption: RAM Used: X.X MB / 16.0 MB.

Bar turns red when approaching or exceeding the 16.0 MB ceiling.

Loads are rejected with a classic error alert if audio exceeds memory allocation.

Multi-Track Canvas Timeline:

Horizontal zoom and scrolling.

Sunken audio tracks with high-contrast waveform visuals.

Non-destructive waveform rendering (trimmed sections are shaded gray or hidden).

Resampling Quality Switch: Toggle button per track or object: [ Dirty (Nearest-Neighbor) | Clean (Linear) ].

3.3 5-Handle Object System

Each audio object rendered on the timeline timeline features 5 interactive control handles when selected:

Top-Left Handle: Fade-in curve control (duration and exponential/linear shape).

Top-Right Handle: Fade-out curve control.

Top-Middle Handle: Object-level gain adjustment (vertical drag).

Bottom-Left Handle: In-point / start trim handle.

Bottom-Right Handle: Out-point / end trim handle.

4. Audio Engine Architecture

+-------------------------------------------------------+
|                    UI Main Thread                     |
|  - Canvas Waveform Renderer                           |
|  - 5-Handle Drag & Drop State                         |
|  - Memory Calculator (16MB Limit)                     |
+---------------------------+---------------------------+
                            |
           Playback Start (Spacebar Press)
           Sends Frozen Timeline Payload
                            |
                            v
+-------------------------------------------------------+
|                    AudioWorklet                       |
|  - Sample-Accurate Buffer Scheduling                  |
|  - Pre-calculated Fade Slopes & Trim Indexing          |
|  - Switchable Resampling (Nearest vs. Linear)         |
+-------------------------------------------------------+


4.1 Memory Allocation Rules

Audio data target: 16-bit 44.1kHz stereo/mono PCM.

Formula: $\text{Bytes} = \text{Samples} \times \text{Channels} \times 2$.

Maximum overall buffer allocation across all loaded sound files = $16,777,216$ bytes (~3 minutes stereo at 44.1kHz).

4.2 Playback Lock Engine

When State.isPlaying === true:

Pointer events on object handles are intercepted and blocked.

UI renders active playhead moving across tracks.

When Spacebar or Stop is pressed:

Audio engine stops immediately.

Pointer events unlock for object editing.

4.3 Resampling & Pitch Shift Logic

Dirty Resampling (Zero-Order Hold / Nearest Neighbor):


$$y[n] = x[\lfloor n \cdot \text{pitchRatio} \rfloor]$$


Produces authentic 90s aliasing and grit when tuning samples down.

Clean Resampling (Linear Interpolation):


$$y[n] = x[i] + (x[i+1] - x[i]) \cdot \text{fraction}$$

5. Data Models & Interface Contracts

export interface AudioAsset {
  id: string;
  name: string;
  buffer: AudioBuffer;
  byteSize: number;
}

export interface AudioObject {
  id: string;
  assetId: string;
  trackId: string;
  startTime: number;     // Position on timeline in seconds
  trimStart: number;     // Offset inside asset in seconds
  duration: number;      // Played duration in seconds
  gain: number;          // Linear multiplier (0.0 to 2.0)
  fadeInTime: number;    // Fade-in duration in seconds
  fadeOutTime: number;   // Fade-out duration in seconds
  pitchShiftCents: number; // Pitch offset (-1200 to +1200)
  resampleMode: 'nearest' | 'linear';
}

export interface Track {
  id: string;
  name: string;
  volume: number;
  pan: number;
  isMuted: boolean;
  isSoloed: boolean;
}

export interface ProjectState {
  sampleRate: number;
  totalMemoryBytes: number;
  maxMemoryBytes: 16777216; // 16 MB
  tracks: Track[];
  objects: AudioObject[];
  isPlaying: boolean;
  playheadPosition: number;
}


6. Implementation Roadmap for AI Agent

Phase 1: Core Engine & Memory Cap

[ ] Implement MemoryManager to track buffer byte sizes.

[ ] Implement file loader (WAV/MP3) that enforces the 16MB ceiling.

[ ] Build basic AudioWorkletProcessor for multi-track playback.

Phase 2: Canvas Timeline & Visuals

[ ] Create canvas-based track container with horizontal scale and zoom.

[ ] Render waveforms inside clip bounds using vintage color palettes.

[ ] Implement 5-handle overlay box for active clip selection.

Phase 3: Windows 95 UI Component Suite

[ ] Build beveled frame CSS system (.win95-panel, .win95-button, .win95-inset).

[ ] Build LED digital counter display component (00:00.00).

[ ] Implement vintage progress bar for the RAM meter.

Phase 4: Editing Mechanics & Audio Sync

[ ] Implement trim (start/end), fade-in/out curves, and gain dragging via handles.

[ ] Add playback lock layer (blocking edits while playing).

[ ] Implement dirty (nearest-neighbor) vs clean (linear) interpolation in AudioWorklet.

[ ] Wire Spacebar shortcut to start/stop playback.
