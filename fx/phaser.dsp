declare name "Phaser";
import("stdfaust.lib");
depth = hslider("Depth[n:1]", 1, 0, 1, 0.01);
ratio = hslider("Ratio[n:2]", 1.5, 1.1, 4, 0.01);
speed = hslider("Speed[n:3][unit:Hz]", 0.5, 0.05, 10, 0.01);
mix   = hslider("Mix[n:4]", 0.5, 0, 1, 0.01);
wet = pf.phaser2_stereo(4, 1000, 100, ratio, 5000, speed, depth, 0, 0);
process = si.bus(2) <: (par(i, 2, *(1 - mix))), (wet : par(i, 2, *(mix))) :> si.bus(2);
