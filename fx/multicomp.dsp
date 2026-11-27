declare name "Multicomp";
declare author "nbtbl";
declare license "MIT";
declare latency_samples "256";
// Multicomp: a four-band "sub control" compressor. Smooth because each band bends gradually into a ceiling instead
// of using a ratio, and releases at a constant dB-per-second rate; punchy because the attack lets the first
// milliseconds through. The behaviour (band split, curves, timing) was fitted by measurement to a four-band
// compressor set to: crossovers 100 / 700 / 4900 Hz, thresholds -30 / -35 / -35 / -35 dB, headroom 25 / 40 / 30 / 20 dB,
// low band +5 dB. All code and the tables below are original measurements; nothing is copied.
//
//   in -> four parallel bands (18 dB/oct Butterworth high-pass and low-pass per band; not a flat-sum
//         crossover: the small dips at the crossover points are part of the sound)
//      per band:  detector = mean square of (L+R)/2, 3 ms  -> level + DRIVE above threshold -> gain curve (table)
//                 -> attack (reaches 90 % in the attack time) / release (constant 5 dB per release time)
//                 -> gain applied to the band, which is delayed 256 samples (the gain looks ~5 ms ahead)
//      -> band gains (low band +5 dB) -> sum -> OUTPUT
//
// Measured match (same audio through both, at the default Attack/Release): the difference is about 4 % of the
// signal on a drum loop and 2 % on noise, levels within 0.1 dB. It drifts apart at long Release settings (at 400 ms
// this one compresses about 0.8 dB more on bass-heavy material).
//
// The output is 256 samples late (declared above as latency_samples; the host removes it).
// A signal that is only in the difference of left and right (L = -R) is not compressed: the detector listens to L+R.
import("stdfaust.lib");

drive   = hslider("Drive[n:1][unit:dB]", 0, -12, 24, 0.5);                    // dB added to the level the detectors see: more
                                                                              // compression without making the input louder
attack  = hslider("Attack[n:2][unit:ms]", 30, 1, 200, 1) * 0.001;             // seconds to reach 90 % of the gain change
release = hslider("Release[n:3][unit:ms]", 90, 10, 3000, 10) * 0.001;         // seconds per 5 dB of recovery
output  = hslider("Output[n:4][unit:dB]", 0, -24, 12, 0.5) : ba.db2linear;

// ---- the preset ---------------------------------------------------------------------------------------------
x1 = 100; x2 = 700; x3 = 4900;                      // crossovers, Hz
latency = 256;                                      // samples the audio is delayed
ahead   = min(latency, int(0.00526 * ma.SR + 0.5));  // samples the gain runs ahead of the audio (5.26 ms)
detTime = 0.003;                                    // detector averaging, seconds

// ---- gain curves: gain in dB for a level 0, 0.5, 1 ... 59.5 dB above the threshold (level = sine peak) -------
curveLow = waveform{
  0, 0, -0.001, -0.003, -0.007, -0.013, -0.023, -0.037, -0.060, -0.083, -0.117, -0.150,
  -0.200, -0.245, -0.313, -0.400, -0.498, -0.605, -0.722, -0.850, -0.967, -1.114, -1.271, -1.438,
  -1.614, -1.801, -1.997, -2.202, -2.415, -2.638, -2.869, -3.109, -3.350, -3.583, -3.846, -4.116,
  -4.393, -4.678, -4.988, -5.265, -5.568, -5.878, -6.193, -6.513, -6.839, -7.170, -7.506, -7.846,
  -8.191, -8.541, -8.895, -9.253, -9.615, -9.981, -10.350, -10.723, -11.098, -11.479, -11.862, -12.247,
  -12.636, -13.028, -13.422, -13.819, -14.218, -14.621, -15.026, -15.433, -15.842, -16.253, -16.666, -17.081,
  -17.498, -17.918, -18.339, -18.762, -19.187, -19.613, -20.041, -20.470, -20.901, -21.334, -21.768, -22.203,
  -22.648, -23.070, -23.509, -23.945, -24.387, -24.830, -25.276, -25.720, -26.168, -26.616, -27.064, -27.509,
  -27.959, -28.411, -28.863, -29.316, -29.770, -30.224, -30.682, -31.134, -31.591, -32.049, -32.507, -32.967,
  -33.427, -33.888, -34.349, -34.807, -35.268, -35.719, -36.184, -36.649, -37.115, -37.581, -38.048, -38.506
};
curveLoMid = waveform{
  0, 0, 0, -0.001, -0.003, -0.005, -0.009, -0.015, -0.022, -0.034, -0.046, -0.062,
  -0.078, -0.102, -0.133, -0.163, -0.198, -0.236, -0.279, -0.335, -0.399, -0.468, -0.518, -0.615,
  -0.696, -0.792, -0.893, -1.001, -1.115, -1.235, -1.353, -1.487, -1.611, -1.755, -1.906, -2.064,
  -2.227, -2.397, -2.573, -2.755, -2.944, -3.137, -3.337, -3.542, -3.753, -3.970, -4.192, -4.419,
  -4.652, -4.890, -5.120, -5.375, -5.605, -5.863, -6.145, -6.391, -6.663, -6.939, -7.220, -7.504,
  -7.793, -8.086, -8.402, -8.683, -8.987, -9.295, -9.607, -9.922, -10.241, -10.563, -10.908, -11.217,
  -11.549, -11.884, -12.222, -12.563, -12.906, -13.253, -13.602, -13.954, -14.308, -14.666, -15.025, -15.388,
  -15.752, -16.119, -16.488, -16.859, -17.232, -17.608, -17.986, -18.366, -18.748, -19.132, -19.517, -19.904,
  -20.293, -20.685, -21.078, -21.473, -21.869, -22.267, -22.666, -23.067, -23.469, -23.874, -24.279, -24.686,
  -25.095, -25.505, -25.916, -26.328, -26.741, -27.157, -27.573, -27.991, -28.409, -28.829, -29.250, -29.672
};
curveHiMid = waveform{
  0, 0, -0.001, -0.002, -0.005, -0.009, -0.016, -0.026, -0.042, -0.058, -0.082, -0.106,
  -0.141, -0.175, -0.232, -0.283, -0.352, -0.414, -0.502, -0.598, -0.703, -0.816, -0.929, -1.059,
  -1.182, -1.328, -1.482, -1.645, -1.816, -1.995, -2.181, -2.376, -2.579, -2.790, -3.007, -3.232,
  -3.464, -3.702, -3.939, -4.171, -4.429, -4.694, -4.965, -5.242, -5.524, -5.813, -6.126, -6.404,
  -6.708, -7.017, -7.330, -7.649, -7.971, -8.299, -8.650, -8.965, -9.304, -9.648, -9.995, -10.345,
  -10.700, -11.057, -11.418, -11.782, -12.149, -12.520, -12.893, -13.269, -13.648, -14.029, -14.413, -14.800,
  -15.188, -15.580, -15.974, -16.370, -16.768, -17.169, -17.571, -17.975, -18.381, -18.789, -19.200, -19.611,
  -20.025, -20.440, -20.857, -21.275, -21.695, -22.117, -22.540, -22.964, -23.390, -23.818, -24.246, -24.675,
  -25.106, -25.539, -25.973, -26.407, -26.843, -27.289, -27.711, -28.145, -28.586, -29.028, -29.470, -29.915,
  -30.359, -30.805, -31.251, -31.693, -32.141, -32.589, -33.039, -33.489, -33.940, -34.394, -34.847, -35.295
};
curveHigh = waveform{
  0, 0, -0.001, -0.004, -0.011, -0.021, -0.036, -0.058, -0.093, -0.127, -0.179, -0.235,
  -0.307, -0.397, -0.508, -0.632, -0.753, -0.901, -1.062, -1.235, -1.420, -1.617, -1.825, -2.045,
  -2.275, -2.509, -2.737, -2.997, -3.267, -3.545, -3.852, -4.126, -4.429, -4.739, -5.056, -5.380,
  -5.710, -6.047, -6.389, -6.737, -7.090, -7.449, -7.812, -8.180, -8.553, -8.930, -9.310, -9.695,
  -10.083, -10.476, -10.871, -11.270, -11.672, -12.077, -12.484, -12.894, -13.307, -13.723, -14.142, -14.562,
  -14.985, -15.410, -15.836, -16.265, -16.695, -17.129, -17.563, -18.005, -18.429, -18.869, -19.310, -19.748,
  -20.192, -20.637, -21.084, -21.532, -21.983, -22.432, -22.886, -23.334, -23.787, -24.242, -24.698, -25.155,
  -25.613, -26.071, -26.531, -26.991, -27.449, -27.910, -28.361, -28.826, -29.291, -29.757, -30.223, -30.681,
  -31.149, -31.618, -32.087, -32.557, -33.028, -33.498, -33.970, -34.432, -34.905, -35.379, -35.852, -36.327,
  -36.801, -37.276, -37.751, -38.218, -38.695, -39.172, -39.649, -40.127, -40.604, -41.083, -41.561, -42.031
};
// linear interpolation; above 59.5 dB the last segment is continued
curveDb(wf, d) = a + (b - a) * (q - k)
with {
  q = max(d, 0) * 2;
  k = min(int(q), 118);
  a = wf, k : rdtable;
  b = wf, k + 1 : rdtable;
};

// ---- one band's gain from its detector signal m = (L+R)/2 ------------------------------------------------
lp1(c) = *(c) : + ~ *(1 - c);
bandGain(thresh, wf, m) = g
with {
  p = m * m : lp1(1 - exp(-1 / (detTime * ma.SR)));                    // mean square
  d = 10 * log10(max(2 * p, 1.0e-20)) + drive - thresh;                // dB above threshold (a sine's peak level)
  target = ba.db2linear(curveDb(wf, d));
  ca = 1 - pow(10, -1 / (attack * ma.SR));                             // attack: exponential in linear gain
  kr = pow(10, 0.25 / (release * ma.SR));                              // release: constant dB per second
  step(prev) = select2(target < prev, min(prev * kr, target), prev + ca * (target - prev));
  g = 1 - ((1 - _ : step : 1 - _) ~ _);                                // state kept as 1 - gain so it starts at unity
};

// ---- band split ---------------------------------------------------------------------------------------------
split = _ <: fi.lowpass(3, x1), (fi.highpass(3, x1) : fi.lowpass(3, x2)), (fi.highpass(3, x2) : fi.lowpass(3, x3)), fi.highpass(3, x3);

// one band, both channels: (l, r) -> (l, r)
band(thresh, wf, makeup, l, r) = l@latency * g, r@latency * g
with { g = bandGain(thresh, wf, (l + r) * 0.5)@(latency - ahead) * ba.db2linear(makeup); };

comp(l1, l2, l3, l4, r1, r2, r3, r4) = band(-30, curveLow, 5, l1, r1), band(-35, curveLoMid, 0, l2, r2), band(-35, curveHiMid, 0, l3, r3), band(-35, curveHigh, 0, l4, r4) :> _, _;

process = par(i, 2, split) : comp : par(i, 2, *(output));
