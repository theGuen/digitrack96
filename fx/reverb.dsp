declare name "Reverb";
import("stdfaust.lib");
pre   = hslider("Pre-delay[n:1][unit:ms]", 20, 0, 100, 1);
decay = hslider("Decay[n:2][unit:s]", 2.5, 0.2, 8, 0.1);
damp  = hslider("Damping[n:3][unit:Hz]", 6000, 1000, 16000, 100);
mix   = hslider("Mix[n:4]", 0.3, 0, 1, 0.01);
wet = re.zita_rev1_stereo(pre, 200, damp, decay*1.3, decay, 48000);
process = si.bus(2) <: (par(i, 2, *(1 - mix))), (wet : par(i, 2, *(mix))) :> si.bus(2);
