#!/bin/bash

# Create /etc/asound.conf
echo "defaults.ctl.card 0" > /etc/asound.conf
echo "defaults.pcm.card 0" >> /etc/asound.conf
echo "defaults.pcm.device 3" >> /etc/asound.conf

# Create /etc/pulse/default.pa.d/alsa-hdmi.pa
mkdir -p /etc/pulse/default.pa.d
echo "load-module module-alsa-sink device=hw:0,3" > /etc/pulse/default.pa.d/alsa-hdmi.pa
echo "set-default-sink alsa_output.hw_0_3" >> /etc/pulse/default.pa.d/alsa-hdmi.pa

# Unmute just in case
# amixer -c 0
# amixer -c 0 sset 'IEC958',0 unmute
amixer -c 0 set 'IEC958' unmute
amixer set Master 80% unmute

