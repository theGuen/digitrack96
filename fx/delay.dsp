declare name "Delay";
import("stdfaust.lib");
time = hslider("Time[n:1][unit:ms]", 320, 10, 1500, 1) * 0.001;
fb   = hslider("Feedback[n:2]", 0.4, 0, 0.95, 0.01);
tone = hslider("Tone[n:3][unit:Hz]", 5000, 500, 16000, 100);
mix  = hslider("Mix[n:4]", 0.3, 0, 1, 0.01);
echo = (+ : de.fdelay(131072, time * ma.SR - 1)) ~ (fi.lowpass(1, tone) : *(fb));
process = si.bus(2) <: (par(i, 2, *(1 - mix))), (par(i, 2, echo) : par(i, 2, *(mix))) :> si.bus(2);
