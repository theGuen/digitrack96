declare name "Vinyl";
declare author "nbtbl";
declare license "MIT";
// Vinyl: a Faust port of the nbtbl VinylSim plugin (same stages, same curves, same constants).
// A pumping compressor, record-surface noise and a warped record. 100 % wet, no samples: all noise is synthesised.
//
//   in -> PRE       high-pass 35 Hz (12 dB/oct), low-pass 15 kHz (6 dB/oct)
//      -> COMP      stereo-linked, soft knee, fast attack / program-dependent release, auto make-up gain,
//                   asymmetric tanh saturation, DC blocker
//      -> NOISE     hiss (pink noise around 2 kHz) and dust/crackle (sparse 1-4 sample pulses through a resonant
//                   1.5-3 kHz band-pass), added BEFORE the pitch modulation so the crackle warbles with the music
//      -> WOW/FLUT  one modulated delay for both channels: wow 0.55 Hz + flutter 6-10 Hz, randomly drifting
//      -> LEVEL     output gain, then a safety soft clipper (linear below 0.7)
//
// The controls are read without smoothing (this is an offline effect: values are set once before the render).
// For live use, smooth `level`, `noise` and `wow` first.
import("stdfaust.lib");

comp  = hslider("Comp[n:1]", 30, 0, 100, 1) / 100;      // threshold -6..-36 dB, ratio 4..12, more make-up
noise = hslider("Noise[n:2]", 25, 0, 100, 1) / 100;     // hiss and crackle; 0 = exactly silent
wow   = hslider("Wow Flut[n:3]", 20, 0, 100, 1) / 100;  // pitch wobble; 0 = off, 100 = about +-5 %
level = hslider("Level[n:4]", 75, 0, 100, 1);           // 75 = unity, 0 = silence, 100 = +6 dB

// ---- helpers ---------------------------------------------------------------------------------------------
// one-pole coefficient that reaches 63 % of a step in `ms`
opc(ms) = 1 - exp(-1 / (ms * 0.001 * ma.SR));
// y += a * (x - y)
lp1(a) = *(a) : + ~ *(1 - a);
// the plugin's Pade tanh (max error 1e-3), so the saturation curve is the same
ftanh(x) = select2(abs(x) > 4.97, a / b, ma.signum(x))
with {
  x2 = x * x;
  a = x * (135135 + x2 * (17325 + x2 * (378 + x2)));
  b = 135135 + x2 * (62370 + x2 * (3150 + x2 * 28));
};
// band-pass with 0 dB peak gain (RBJ), transposed direct form II; the frequency may change while it runs
bandpass(fc, q) = fi.tf22t(al / a0, 0, 0 - al / a0, -2 * cos(w) / a0, (1 - al) / a0)
with {
  w = 2 * ma.PI * max(1, min(fc, 0.49 * ma.SR)) / ma.SR;
  al = sin(w) / (2 * q);
  a0 = 1 + al;
};
// holds x from the sample where t is 1; `hold0` starts at `init` instead of 0
hold(t, x) = select2(t, _, x) ~ _;
hold0(t, init, x) = hold(t, x - init) + init;
// uniform 0..1 from a -1..1 noise
uni = *(0.5) : +(0.5);
rate = ma.SR / 44100;

// ---- PRE ---------------------------------------------------------------------------------------------------
pre = fi.highpass(2, 35) : lp1(1 - exp(0 - 2 * ma.PI * 15000 / ma.SR));

// ---- COMP ---------------------------------------------------------------------------------------------------
thresh = -6 - 30 * comp;
ratio  = 4 + 8 * comp;
slope  = 1 / ratio - 1;                                  // negative
knee   = 8;                                              // dB
// auto make-up: 60 % of the level lost above the threshold, zero at Comp 0 (about +17.5 dB at Comp 100)
makeupRaw(c) = 0.6 * (6 + 30 * c) * (1 - 1 / (4 + 8 * c));
makeup = ba.db2linear(makeupRaw(comp) - makeupRaw(0));
satK   = 1 + 1.5 * comp;                                 // saturation drive
bias   = 0.12;                                           // asymmetry: the positive half clips a little harder
satNorm = 1 / (satK * (1 - ftanh(bias) * ftanh(bias)));  // unity small-signal gain
dcR    = max(0, 1 - 2 * ma.PI * 10 / ma.SR);
dcblock = _ <: _, mem : - : + ~ *(dcR);
sat = *(satK) : +(bias) : ftanh : -(ftanh(bias)) : *(satNorm) : dcblock;

// gain computer in dB (soft knee), smoothed in the dB domain; returns the linear gain for a detector signal
compGain(det) = ba.db2linear(gr) * makeup
with {
  // Level in dB the way the plugin measures it: its fast log2 is exact at every power of two but reads up to
  // 1.85 dB low in between (it uses ln of the mantissa). That is part of how the plugin was tuned by ear, so it
  // is kept. For the mathematically exact detector use:  levelDb = 20 * log10(x);
  x = max(det, 1.0e-12);
  e = floor(log(x) / log(2));
  levelDb = 6.0205999 * (e + log(x) - e * log(2));
  over = levelDb - thresh;
  target = select2(2 * over < 0 - knee, select2(2 * over <= knee, slope * over, slope * (over + knee / 2) ^ 2 / (2 * knee)), 0);
  // program-dependent release: sustained material (slow average near the peak) recovers slowly, hits quickly
  peak = (_ <: select2(det > _, *(exp(-1 / (0.120 * ma.SR))), det)) ~ _;
  slow = det : lp1(opc(400));
  sustain = select2(peak' > 1.0e-5, 0, max(0, min(1, slow' / max(peak', 1.0e-5))));
  relMs = max(60, min(180, 60 + (120 - 50 * comp) * sustain));
  step(prev) = prev + select2(target < prev, opc(relMs), opc(8 - 6 * comp)) * (target - prev);
  gr = step ~ _;
};
compressor(l, r) = (l * g : sat), (r * g : sat) with { g = compGain(max(abs(l), abs(r))); };

// ---- NOISE --------------------------------------------------------------------------------------------------
noiseOn = noise > 0.0005;
fadeIn  = min(1, noise * 20);
// Paul Kellet's economy pink filter (tuned for 44.1 kHz; hissRate keeps the level close at other rates)
pink = _ <: (*(0.0990460) : + ~ *(0.99765)), (*(0.2965164) : + ~ *(0.96300)), (*(1.0526913) : + ~ *(0.57000)), *(0.1848) :> *(0.14);
hissAmp = rate ^ 0.3 * 3 * ba.db2linear(-64 + 32 * noise) * fadeIn * noiseOn;   // about -32 dBFS rms at Noise 100
hiss = pink : bandpass(2000, 0.7) : *(hissAmp);

// dust: a sparse pulse, 1-4 samples wide, random sign, size, filter centre and pan
clickProb = (0.6 + 28 * noise * sqrt(noise)) / ma.SR;    // pulses per second / rate
crackleAmp = rate ^ 0.55 * 14 * ba.db2linear(-48 + 30 * noise) * fadeIn * noiseOn;
// r1..r6: independent uniform 0..1 randoms. Returns the left and right crackle signals.
crackle(r1, r2, r3, r4, r5, r6) = c * select2(side, pan, 1), c * select2(side, 1, pan)
with {
  left = (_ <: select2((_ == 0) & (r1 < clickProb), max(0, _ - 1), int(r2 * 4))) ~ _;   // samples still to play
  trig = (left' == 0) & (r1 < clickProb);
  active = trig | (left' > 0);
  amp = hold(trig, select2(r3 < 0.5, 1, -1) * (0.08 + 0.92 * r4 * r4 * r4));
  fc = hold0(trig, 2200, 1500 + 1500 * r5);
  side = hold(trig, r6 < 0.5);
  pan = hold(trig, 0.6 + 0.4 * ((r6 * 2) : ma.frac));
  c = amp * active : bandpass(fc, 3) : *(crackleAmp);
};
noiseStage(l, r) = (no.multinoise(8) : (hiss, hiss, (par(i, 6, uni) : crackle))) : mixIn
with { mixIn(hl, hr, cl, cr) = l + hl + cl, r + hr + cr; };

// ---- WOW / FLUTTER ------------------------------------------------------------------------------------------
// flutter drifts: a new random speed (6-10 Hz) and strength (0.7-1.3) every 0.35 s, gliding over about 250 ms
tick = ba.time > 0 : &(ba.pulse(int(0.35 * ma.SR)));
glide = si.smooth(exp(-1 / (0.25 * ma.SR)));
flutHz  = 8 + (hold(tick, 4 * uni(no.noises(10, 8)) - 2) : glide);
flutAmp = 1 + (hold(tick, 0.6 * uni(no.noises(10, 9)) - 0.3) : glide);
pitchWow  = 0.05 * wow ^ 1.25;                           // peak pitch deviation: gentle start, seasick above ~30 %
pitchFlut = 0.18 * pitchWow * flutAmp;                   // flutter is about 18 % of the wow, in pitch
wowS  = pitchWow / (2 * ma.PI * 0.55);                   // delay amplitude in seconds = deviation / (2 pi f)
flutS = pitchFlut / (2 * ma.PI * flutHz);
// the base delay follows the depth, so nothing is delayed when the effect is off
delaySamples = max(0, (wowS * (1 + os.osc(0.55)) + flutS * (1 + os.osc(flutHz))) * ma.SR);
warp = par(i, 2, de.fdelay(8192, delaySamples));

// ---- LEVEL + safety clip ---------------------------------------------------------------------------------------
levelGain = select2(level <= 75, ba.db2linear(6 * (level - 75) / 25), (level / 75) ^ 2);
safety(x) = select2(abs(x) <= 0.7, ma.signum(x) * (0.7 + 0.3 * ftanh((abs(x) - 0.7) / 0.3)), x);

process = par(i, 2, pre) : compressor : noiseStage : warp : par(i, 2, *(levelGain) : safety);
