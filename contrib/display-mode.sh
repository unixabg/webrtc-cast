#!/bin/sh
# Optionally pin the X output resolution before chromium starts.
#
# By default X uses whatever mode the projector/TV advertises as preferred.
# Through HDMI switches, extenders or long runs that EDID can be wrong or
# missing, and the station ends up at 1024x768 or some odd mode. To pin a
# mode for a room, put it in webrtc-cast/display_mode.txt, e.g.:
#
#   1280x800            -> that mode on every connected output
#   1920x1080 60        -> with a refresh rate
#   HDMI-1 1280x800     -> only on the named output (see: xrandr -q)
#
# If the mode is not in the display's EDID list it is created with cvt.
# No file (or an empty one) means leave X alone, same as before.

MODE_FILE="$(dirname "$0")/../display_mode.txt"

[ -s "$MODE_FILE" ] || exit 0
command -v xrandr >/dev/null 2>&1 || { echo "display-mode: xrandr not found"; exit 0; }

# First non-comment, non-blank line.
line=$(grep -v '^[[:space:]]*#' "$MODE_FILE" | grep -v '^[[:space:]]*$' | head -n 1)
[ -n "$line" ] || exit 0

set -- $line
output=""
case "$1" in
    [0-9]*x[0-9]*) ;;
    *) output="$1"; shift ;;
esac
mode="$1"
rate="$2"

case "$mode" in
    [0-9]*x[0-9]*) ;;
    *) echo "display-mode: can't parse '$line' in $MODE_FILE"; exit 0 ;;
esac

if [ -n "$output" ]; then
    outputs="$output"
else
    outputs=$(xrandr -q | awk '/ connected/ {print $1}')
fi

for out in $outputs; do
    rate_arg=""
    [ -n "$rate" ] && rate_arg="--rate $rate"

    if xrandr --output "$out" --mode "$mode" $rate_arg 2>/dev/null; then
        echo "display-mode: $out set to $mode ${rate}"
        continue
    fi

    # Mode not advertised by the display: build it with cvt and add it.
    w=${mode%x*}
    h=${mode#*x}
    modeline=$(cvt "$w" "$h" ${rate:-60} | sed -n 's/^Modeline //p')
    name=$(echo "$modeline" | awk '{print $1}' | tr -d '"')
    params=$(echo "$modeline" | cut -d' ' -f2-)
    if [ -z "$name" ]; then
        echo "display-mode: cvt could not build $mode for $out"
        continue
    fi
    xrandr --newmode "$name" $params 2>/dev/null
    xrandr --addmode "$out" "$name" 2>/dev/null
    if xrandr --output "$out" --mode "$name"; then
        echo "display-mode: $out set to custom $name"
    else
        echo "display-mode: failed to set $mode on $out, leaving the default"
    fi
done

exit 0
