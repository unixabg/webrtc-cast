#!/bin/bash
# MODE/IFACE/AP_IFACE/AP_ADDRESS/FORWARD come from /etc/default/webrtc-cast-ap.
# shellcheck disable=SC2153
# webrtc-cast access point setup for Debian 13 (trixie).
#
# Turns a Wi-Fi card on the cast station into an access point so clients
# that know the passphrase can join it and browse to https://cast:8443.
#
# Two ways to use a radio:
#   dedicated (default)  The card is used only for the AP (a second USB card,
#                        or the built-in card when the station is wired).
#                        Most reliable; any channel/band the card allows.
#   --shared             One card is both the station's uplink (managed mode)
#                        and the AP, via a virtual interface (default ap0).
#                        Needs driver support for managed+AP at once. When
#                        hostapd starts, the AP takes the uplink's channel if
#                        the card allows an AP there; otherwise, on cards that
#                        can use two channels, it keeps its own 2.4 GHz channel
#                        (time-sliced). A timer restarts hostapd if the station
#                        later moves to another channel. Run "check" to see
#                        what a card can do; tested cards: contrib/wifi-cards.md
#
# Usage:
#   ap-setup.sh install --ssid NAME --passphrase PASS [options]
#   ap-setup.sh check   [--iface IF] [--shared]
#   ap-setup.sh uninstall [--purge]
#   ap-setup.sh --help
#
# Run as root. Safe to run from a d-i late_command chroot: services are
# enabled but not started when systemd isn't running.

set -euo pipefail

PROG=webrtc-cast-ap
SELF_INSTALL=/usr/local/sbin/webrtc-cast-ap

# Test hook: write every file under this directory and skip apt/systemctl.
ROOT="${WEBRTC_CAST_AP_ROOT:-}"

CONF_DEFAULT="$ROOT/etc/default/webrtc-cast-ap"
HOSTAPD_CONF="$ROOT/etc/hostapd/hostapd.conf"
DNSMASQ_CONF="$ROOT/etc/dnsmasq.d/webrtc-cast-ap.conf"
AP_UNIT="$ROOT/etc/systemd/system/webrtc-cast-ap.service"
HOSTAPD_DROPIN="$ROOT/etc/systemd/system/hostapd.service.d/webrtc-cast-ap.conf"
DNSMASQ_DROPIN="$ROOT/etc/systemd/system/dnsmasq.service.d/webrtc-cast-ap.conf"
SYSCTL_CONF="$ROOT/etc/sysctl.d/90-webrtc-cast-ap.conf"
NFT_CONF="$ROOT/etc/webrtc-cast-ap/nat.nft"
NM_CONF="$ROOT/etc/NetworkManager/conf.d/webrtc-cast-ap.conf"
DRIFT_SERVICE="$ROOT/etc/systemd/system/webrtc-cast-ap-drift.service"
DRIFT_TIMER="$ROOT/etc/systemd/system/webrtc-cast-ap-drift.timer"

log()  { echo "$PROG: $*"; }
warn() { echo "$PROG: WARNING: $*" >&2; }
die()  { echo "$PROG: ERROR: $*" >&2; exit 1; }

usage() {
    cat <<'EOF'
Usage:
  ap-setup.sh install --ssid NAME --passphrase PASS [options]
  ap-setup.sh check [--iface IF] [--shared]
  ap-setup.sh uninstall [--purge]

install options:
  --ssid NAME            AP network name (required, 1-32 characters)
  --passphrase PASS      WPA2 passphrase (required, 8-63 printable characters)
  --iface IF             Wi-Fi card to use (default: first wireless card found)
  --shared               Share IF with the station uplink via a virtual AP
                         interface instead of using IF only for the AP
  --ap-iface NAME        Virtual AP interface name in --shared mode (default ap0)
  --address IP/PREFIX    AP address (default 192.168.11.1/24)
  --dhcp-range START,END DHCP pool (default .100-.200 of a /24)
  --band 2.4|5           Band (default 2.4)
  --channel N            Channel (default 6 on 2.4 GHz, 36 on 5 GHz). In
                         --shared mode the AP uses the uplink's channel when
                         the card allows an AP there; otherwise, on cards
                         that can use two channels, it stays on this one.
  --country CC           Regulatory country code (default US)
  --alias NAME           DNS name clients can use for the station (default
                         cast, so https://cast:8443); --alias '' disables
  --domain DOMAIN        Local DNS domain and DHCP search domain (default
                         home.arpa, so cast.home.arpa also works)
  --no-isolate           Let AP clients reach each other (default: isolated,
                         clients can only talk to the station)
  --forward              Also route AP clients out through the station's
                         uplink (copper or Wi-Fi, whichever is active) with
                         NAT, giving them internet/LAN access. Off by default;
                         casting does not need it. Clients always get the
                         station as gateway; without --forward it just
                         doesn't pass their traffic on.
  --strict               Stop if the card check finds a problem (default: warn)
  --no-start             Enable services but don't start them now

check options:
  --iface IF, --shared   As above; reports what the card can do: bands and
                         channels for an AP, station + AP on one card (same
                         channel or two), what that means for webrtc-cast,
                         and the AP channel --shared would pick right now

uninstall options:
  --purge                Also purge the hostapd and dnsmasq packages
EOF
}

# ---------------------------------------------------------------- helpers

need_root() {
    [ -n "$ROOT" ] && return 0
    [ "$(id -u)" = 0 ] || die "run as root"
}

systemd_running() {
    [ -z "$ROOT" ] && [ -d /run/systemd/system ]
}

valid_ifname() { [[ "$1" =~ ^[A-Za-z0-9_.-]{1,15}$ ]]; }

valid_ipv4() {
    local ip=$1 o
    [[ "$ip" =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] || return 1
    for o in "${BASH_REMATCH[@]:1}"; do
        [ "$o" -le 255 ] || return 1
    done
}

ip_to_int() {
    local IFS=.
    # shellcheck disable=SC2086
    set -- $1
    echo $(( ($1 << 24) | ($2 << 16) | ($3 << 8) | $4 ))
}

int_to_ip() {
    local n=$1
    echo "$(( (n >> 24) & 255 )).$(( (n >> 16) & 255 )).$(( (n >> 8) & 255 )).$(( n & 255 ))"
}

# 192.168.11.1/24 -> 192.168.11.0/24
cidr_network() {
    local ip=${1%/*} prefix=${1#*/} mask n
    mask=$(( prefix == 0 ? 0 : (0xFFFFFFFF << (32 - prefix)) & 0xFFFFFFFF ))
    n=$(( $(ip_to_int "$ip") & mask ))
    echo "$(int_to_ip "$n")/$prefix"
}

prefix_to_netmask() {
    local prefix=$1
    int_to_ip $(( prefix == 0 ? 0 : (0xFFFFFFFF << (32 - prefix)) & 0xFFFFFFFF ))
}

first_wireless_iface() {
    local d name
    for d in /sys/class/net/*; do
        name=${d##*/}
        [ "$name" = "${AP_IFACE:-ap0}" ] && continue
        if [ -d "$d/wireless" ] || [ -e "$d/phy80211" ]; then
            echo "$name"
            return 0
        fi
    done
    return 1
}

# Derive a locally administered MAC for the virtual AP interface from the
# card's MAC, so ap0 and the station don't share an address.
derive_ap_mac() {
    local base=$1 first rest
    first=$(( 16#${base%%:*} ))
    rest=${base#*:}
    first=$(( (first | 0x02) & 0xFE ))  # locally administered, unicast
    local mac
    mac=$(printf '%02x:%s' "$first" "$rest")
    if [ "$mac" = "$base" ]; then
        # already locally administered: flip the low bit of the last octet
        local last=$(( 16#${base##*:} ^ 0x01 ))
        mac=$(printf '%s:%02x' "${base%:*}" "$last")
    fi
    echo "$mac"
}

freq_to_channel() {
    local f=${1%.*}
    if [ "$f" -eq 2484 ]; then echo 14
    elif [ "$f" -ge 2412 ] && [ "$f" -le 2472 ]; then echo $(( (f - 2407) / 5 ))
    elif [ "$f" -ge 5000 ] && [ "$f" -lt 5925 ]; then echo $(( (f - 5000) / 5 ))
    else return 1
    fi
}

# ------------------------------------------------------------ card check

# Print the phy's supported interface modes, one per line.
phy_modes() {
    awk '
        /Supported interface modes:/ { f = 1; next }
        f && /^[[:space:]]+\*/ { sub(/^[[:space:]]+\*[[:space:]]+/, ""); print; next }
        f { exit }
    '
}

# Print each "valid interface combinations" entry joined onto one line.
phy_combinations() {
    awk '
        /valid interface combinations:/ { f = 1; next }
        f && /^[[:space:]]+\*/ { if (c != "") print c; c = $0; next }
        f && /^[[:space:]]+(total|#)/ { c = c " " $0; next }
        f { if (c != "") print c; c = ""; f = 0 }
        END { if (c != "") print c }
    '
}

# For one combination line: print "yes <channels>" if it allows one managed
# and one AP interface at the same time, otherwise nothing.
combination_allows_shared() {
    awk '
        {
            s = $0; m = 0; a = 0
            while (match(s, /#[{][^}]*[}] <= [0-9]+/)) {
                g = substr(s, RSTART, RLENGTH); s = substr(s, RSTART + RLENGTH)
                n = g; sub(/.*<= /, "", n)
                inner = g; sub(/^#[{] */, "", inner); sub(/ *[}].*/, "", inner)
                k = split(inner, t, / *, */); hm = 0; ha = 0
                for (i = 1; i <= k; i++) { if (t[i] == "managed") hm = 1; if (t[i] == "AP") ha = 1 }
                if (hm && ha) { if (n + 0 >= 2) { m = 1; a = 1 } }
                else { if (hm) m = 1; if (ha) a = 1 }
            }
            tot = 0
            if (match($0, /total <= [0-9]+/)) { x = substr($0, RSTART, RLENGTH); sub(/.*<= /, "", x); tot = x + 0 }
            ch = 1
            if (match($0, /#channels <= [0-9]+/)) { x = substr($0, RSTART, RLENGTH); sub(/.*<= /, "", x); ch = x + 0 }
            if (m && a && tot >= 2) print "yes " ch
        }
    '
}

# Print "<freq> <channel> <status>" for each channel of a phy. status is ok
# (an AP may start there), radar (DFS: needs a radar check first, not used),
# noir (client only) or disabled. Reads `iw phy X channels`, falling back to
# the frequency list in `iw phy X info` on older iw.
phy_channel_list() {
    local phy=$1 out
    out=$(iw phy "$phy" channels 2>/dev/null || true)
    [ -n "$out" ] || out=$(iw phy "$phy" info 2>/dev/null || true)
    printf '%s\n' "$out" | parse_channel_list
}

parse_channel_list() {
    awk '
        function rank(s) { return s == "disabled" ? 3 : s == "noir" ? 2 : s == "radar" ? 1 : 0 }
        function mark(s) { if (rank(s) > rank(st)) st = s }
        function flags(l) {
            l = tolower(l)
            if (l ~ /disabled/) mark("disabled")
            if (l ~ /no ir/) mark("noir")
            if (l ~ /radar/) mark("radar")
        }
        function flush() { if (ch != "") print f, ch, st; ch = "" }
        /\* [0-9.]+ MHz \[[0-9]+\]/ {
            flush()
            match($0, /[0-9.]+ MHz/); f = substr($0, RSTART, RLENGTH); sub(/ MHz/, "", f); sub(/\..*/, "", f)
            match($0, /\[[0-9]+\]/); ch = substr($0, RSTART + 1, RLENGTH - 2)
            st = "ok"; rest = $0; sub(/.*\]/, "", rest); flags(rest)
            next
        }
        ch != "" && /^[[:space:]]+(No IR|Radar detection|Disabled)/ { flags($0); next }
        END { flush() }
    '
}

band_of_freq() {
    if [ "$1" -lt 3000 ]; then echo 2.4
    elif [ "$1" -lt 5925 ]; then echo 5
    else echo 6
    fi
}

# "1 2 3 4 11" -> "1-4, 11" (use step 4 for 5/6 GHz channel numbers)
compress_channels() {
    awk -v step="$1" '
        function add() { out = out (out == "" ? "" : ", ") (s == p ? s : s "-" p) }
        { for (i = 1; i <= NF; i++) { c = $i + 0
              if (!n) { s = c; p = c; n = 1; continue }
              if (c == p + step) { p = c; continue }
              add(); s = c; p = c } }
        END { if (n) add(); print out }
    '
}

# From a channel list, print for one band: "<ok channels as ranges>|<ok>|<noir>|<radar>|<total>"
band_summary() {
    local chanlist=$1 band=$2 step=1 ok
    [ "$band" = 2.4 ] || step=4
    ok=$(printf '%s\n' "$chanlist" | while read -r f c s; do
            [ -n "$f" ] && [ "$(band_of_freq "$f")" = "$band" ] && [ "$s" = ok ] && echo "$c"
         done | sort -n | tr '\n' ' ' | compress_channels "$step")
    printf '%s\n' "$chanlist" | awk -v b="$band" -v ok="$ok" '
        { band = ($1 < 3000) ? "2.4" : ($1 < 5925) ? "5" : "6" }
        band == b { t++; if ($3 == "ok") o++; else if ($3 == "noir") n++; else if ($3 == "radar") r++ }
        END { printf "%s|%d|%d|%d|%d\n", ok, o, n, r, t }
    '
}

channel_status() {
    printf '%s\n' "$1" | awk -v c="$2" '$2 == c { print $3; found = 1; exit } END { if (!found) print "unknown" }'
}

# Highest #channels over all combinations that allow a managed and an AP
# interface at the same time; 0 if none does.
best_shared_channels() {
    local info=$1 line result best=0 n
    while IFS= read -r line; do
        result=$(printf '%s\n' "$line" | combination_allows_shared)
        if [ -n "$result" ]; then
            n=${result#yes }
            [ "$n" -gt "$best" ] && best=$n
        fi
    done < <(printf '%s\n' "$info" | phy_combinations)
    echo "$best"
}

# Print "<system country> <card's own country or empty>".
reg_countries() {
    local reg global own
    reg=$(iw reg get 2>/dev/null || true)
    global=$(printf '%s\n' "$reg" | awk '/^global/ { g = 1; next } g && /^country/ { sub(/:.*/, "", $2); print $2; exit }')
    own=$(printf '%s\n' "$reg" | awk -v p="phy#${1#phy}" '
        index($0, p) == 1 && (length($0) == length(p) || substr($0, length(p) + 1, 1) == " ") { f = 1; next }
        f && /^country/ { sub(/:.*/, "", $2); print $2; exit }
        f && /^(phy#|global)/ { exit }')
    echo "${global:-?} $own"
}

# Decide the AP channel in --shared mode. Prints "<channel> <hw_mode> same|separate",
# or "none <status of the uplink channel>" when no channel works.
#   - the uplink's channel if an AP may start there (one channel, no time-slicing)
#   - otherwise the configured channel, if the card can use a second channel
decide_ap_channel() {
    local chanlist=$1 channels=$2 ufreq=${3%.*} cch=$4 cmode=$5 uch st
    uch=$(freq_to_channel "$ufreq" 2>/dev/null || true)
    st=unknown
    [ -z "$uch" ] || st=$(channel_status "$chanlist" "$uch")
    if [ -n "$uch" ] && [ "$ufreq" -lt 5925 ] && [ "$st" = ok ]; then
        if [ "$ufreq" -lt 3000 ]; then echo "$uch g same"; else echo "$uch a same"; fi
    elif [ "${channels:-0}" -ge 2 ]; then
        echo "$cch $cmode separate"
    else
        echo "none $st"
    fi
}

describe_status() {
    case "$1" in
        noir) echo "client-only for this card (no-IR)" ;;
        radar) echo "a DFS/radar channel" ;;
        disabled) echo "disabled for this card" ;;
        *) echo "not usable for an AP" ;;
    esac
}

# "vendor:device" of a card, e.g. 168c:003e (PCI) or 0e8d:7612 (USB), if known.
card_id() {
    local dev vendor device
    dev=$(readlink -f "/sys/class/net/$1/device" 2>/dev/null) || return 0
    if [ -r "$dev/vendor" ] && [ -r "$dev/device" ]; then
        vendor=$(cat "$dev/vendor"); device=$(cat "$dev/device")
        echo "${vendor#0x}:${device#0x}"
    elif [ -r "$dev/../idVendor" ] && [ -r "$dev/../idProduct" ]; then
        echo "$(cat "$dev/../idVendor"):$(cat "$dev/../idProduct")"
    fi
}

# Results seen on real hardware (details in contrib/wifi-cards.md). What the
# driver advertises isn't always what works, so tested cards get a note.
known_card_notes() {
    case "$(card_id "$1")" in
        168c:003e)
            echo "Tested (contrib/wifi-cards.md): QCA6174 is stable as a dedicated AP (all night);"
            echo "station + AP on one shared channel works but the firmware stalls about hourly;"
            echo "on two channels (time-sliced) it drops AP clients within minutes."
            echo ;;
    esac
}

# Report what the card can do, in plain language. Returns 0 if nothing wrong
# was found for the requested mode, 1 otherwise. $3/$4: configured AP channel.
check_card() {
    local iface=$1 shared=$2 cch=${3:-6} cmode=${4:-g}
    local problems=0 phy info driver chip slot ap_mode channels chanlist sysc own
    local s6 ok24 ok5 n5 r5 t5 ranges24 ranges5 link ufreq ussid dch dmode dhow

    if ! command -v iw >/dev/null 2>&1; then
        warn "iw is not installed; can't check the card (apt install iw)"
        return 1
    fi
    if [ ! -e "/sys/class/net/$iface" ]; then
        warn "no network interface named $iface (see: ip link)"
        return 1
    fi
    phy=$(cat "/sys/class/net/$iface/phy80211/name" 2>/dev/null || true)
    if [ -z "$phy" ]; then
        warn "$iface is not a Wi-Fi interface"
        return 1
    fi
    info=$(iw phy "$phy" info 2>/dev/null || true)
    if [ -z "$info" ]; then
        warn "iw phy $phy info returned nothing; can't check the card"
        return 1
    fi

    driver=$(basename "$(readlink -f "/sys/class/net/$iface/device/driver" 2>/dev/null)" 2>/dev/null || true)
    slot=$(basename "$(readlink -f "/sys/class/net/$iface/device" 2>/dev/null)" 2>/dev/null || true)
    chip=""
    if command -v lspci >/dev/null 2>&1 && [ -n "$slot" ]; then
        chip=$(lspci -s "$slot" 2>/dev/null | sed 's/^[^:]*: *//; s/^[^:]*: *//' | head -n 1)
    fi

    ap_mode=no
    printf '%s\n' "$info" | phy_modes | grep -qx 'AP' && ap_mode=yes
    channels=$(best_shared_channels "$info")
    chanlist=$(phy_channel_list "$phy")
    read -r sysc own <<<"$(reg_countries "$phy")"

    IFS='|' read -r ranges24 ok24 _ _ _ <<<"$(band_summary "$chanlist" 2.4)"
    IFS='|' read -r ranges5 ok5 n5 r5 t5 <<<"$(band_summary "$chanlist" 5)"
    s6=$(band_summary "$chanlist" 6)

    echo "Wi-Fi card: $iface ($phy), driver ${driver:-unknown}"
    [ -z "$chip" ] || echo "Chip:       $chip"
    if [ -n "$own" ]; then
        echo "Regulatory: the card uses its own setting (country $own), not the system's ($sysc)"
        case "$own" in
            00|99) echo "            (world-roaming: the card is cautious and may refuse an AP on 5 GHz)" ;;
        esac
    else
        echo "Regulatory: follows the system setting (country $sysc)"
    fi
    echo

    if [ "$ap_mode" = no ]; then
        echo "Access point mode: NOT supported; hostapd can't run on this card."
        problems=1
    else
        echo "Where this card can run an access point (as advertised):"
        if [ "${ok24:-0}" -gt 0 ]; then
            printf '  %-8s yes   channels %s\n' "2.4 GHz" "$ranges24"
        else
            printf '  %-8s no\n' "2.4 GHz"
        fi
        if [ "${t5:-0}" -gt 0 ]; then
            if [ "${ok5:-0}" -gt 0 ]; then
                printf '  %-8s yes   channels %s' "5 GHz" "$ranges5"
                [ "${r5:-0}" -eq 0 ] || printf ' (%s DFS channels not used)' "$r5"
                echo
            elif [ "${n5:-0}" -gt 0 ]; then
                printf '  %-8s no    client only (the card marks 5 GHz "no-IR")\n' "5 GHz"
            else
                printf '  %-8s no\n' "5 GHz"
            fi
        fi
        s6=${s6#*|}; s6=${s6%%|*}
        [ "${s6:-0}" -eq 0 ] || printf '  %-8s not used by this script\n' "6 GHz"
    fi
    echo

    echo "Station + AP on this one card:"
    if [ "$channels" -eq 0 ]; then
        echo "  not supported"
    elif [ "$channels" -eq 1 ]; then
        echo "  same channel only (the AP must share the uplink's channel)"
    else
        echo "  yes, up to $channels channels (the radio time-slices between them;"
        echo "  on some cards that drops AP clients, so one shared channel is preferred)"
    fi
    echo

    local verdict_24 verdict_5 verdict_ded verdict_ap5
    if [ "$ap_mode" = no ]; then
        verdict_ded="not possible with this card"
        verdict_24="not possible: use a second card for the AP"
        verdict_5="not possible: use a second card for the AP"
        verdict_ap5="not possible with this card"
    else
        if [ "${ok24:-0}" -gt 0 ] && [ "${ok5:-0}" -gt 0 ]; then
            verdict_ded="works: AP on 2.4 GHz (or 5 GHz with --band 5)"
        elif [ "${ok24:-0}" -gt 0 ]; then
            verdict_ded="works: AP on 2.4 GHz"
        elif [ "${ok5:-0}" -gt 0 ]; then
            verdict_ded="works: AP on 5 GHz (--band 5)"
        else
            verdict_ded="not possible: no channel allows an AP"
        fi
        if [ "$channels" -ge 1 ] && [ "${ok24:-0}" -gt 0 ]; then
            verdict_24="works: AP shares the uplink channel"
        else
            verdict_24="not possible: use a second card for the AP"
        fi
        if [ "$channels" -ge 1 ] && [ "${ok5:-0}" -gt 0 ]; then
            verdict_5="works: AP shares the uplink channel (if it isn't a DFS channel)"
            [ "$channels" -lt 2 ] || [ "${ok24:-0}" -eq 0 ] || verdict_5="$verdict_5, else 2.4 GHz time-sliced"
        elif [ "$channels" -ge 2 ] && [ "${ok24:-0}" -gt 0 ]; then
            verdict_5="time-sliced: AP on 2.4 GHz, may drop AP clients; prefer 2.4 GHz uplink"
        else
            verdict_5="not possible: use a second card for the AP"
        fi
        if [ "${ok5:-0}" -gt 0 ]; then verdict_ap5="works (--band 5)"; else verdict_ap5="not possible with this card"; fi
    fi
    echo "What that means for webrtc-cast:"
    printf '  %-36s %s\n' "AP only (wired or no uplink)" "$verdict_ded"
    printf '  %-36s %s\n' "Wi-Fi uplink on 2.4 GHz + AP" "$verdict_24"
    printf '  %-36s %s\n' "Wi-Fi uplink on 5 GHz + AP" "$verdict_5"
    printf '  %-36s %s\n' "AP on 5 GHz" "$verdict_ap5"
    echo

    link=$(iw dev "$iface" link 2>/dev/null || true)
    ufreq=$(printf '%s\n' "$link" | awk '/freq:/ { print $2; exit }')
    ussid=$(printf '%s\n' "$link" | sed -n 's/^[[:space:]]*SSID: //p' | head -n 1)
    if [ -n "$ufreq" ]; then
        local uch
        uch=$(freq_to_channel "${ufreq%.*}" 2>/dev/null || echo "?")
        printf 'Currently:  %s is connected to "%s" on %s GHz channel %s\n' "$iface" "$ussid" "$(band_of_freq "${ufreq%.*}")" "$uch"
        read -r dch dmode dhow <<<"$(decide_ap_channel "$chanlist" "$channels" "$ufreq" "$cch" "$cmode")"
        if [ "$dch" = none ]; then
            echo "            with --shared the AP could not start: channel $uch is $(describe_status "$dmode")"
            echo "            and the card can't run the AP on a second channel"
            [ "$shared" = 0 ] || problems=1
        elif [ "$dhow" = same ]; then
            echo "            with --shared the AP would use channel $dch (shared with the uplink)"
        else
            echo "            with --shared the AP would use channel $dch on its own (time-sliced)"
        fi
        echo
    fi

    known_card_notes "$iface"

    case "$driver" in
        iwlwifi)
            echo "Driver note: Intel cards usually allow an AP on 2.4 GHz only." ;;
        mt76*|mt7*|ath9k*|ath10k*|ath11k*|ath12k*|brcmfmac)
            echo "Driver note: $driver has a good track record for AP mode." ;;
        8188eu|8192eu|8812au|8814au|8821au|8821cu|88x2bu|88XXau|rtl88xxau|rtl8812au|rtl88x2bu|rtl8821cu)
            echo "Driver note: $driver is an out-of-tree Realtek driver; AP mode is often"
            echo "             unreliable and it can break on kernel updates." ;;
    esac
    echo "This is what the driver advertises; test anything marked time-sliced before relying on it."

    [ "$shared" = 0 ] || [ "$channels" -ge 1 ] || problems=1
    return $problems
}

# ------------------------------------------------------ runtime helpers
# Called by the installed systemd units (from $SELF_INSTALL).

load_config() {
    [ -r /etc/default/webrtc-cast-ap ] || die "/etc/default/webrtc-cast-ap not found; run install first"
    # shellcheck disable=SC1091
    . /etc/default/webrtc-cast-ap
}

cmd_iface_up() {
    load_config
    if [ "$MODE" = shared ]; then
        if [ ! -e "/sys/class/net/$AP_IFACE" ]; then
            log "creating $AP_IFACE on $IFACE"
            iw dev "$IFACE" interface add "$AP_IFACE" type __ap
            ip link set dev "$AP_IFACE" address "$(derive_ap_mac "$(cat "/sys/class/net/$IFACE/address")")"
        fi
    fi
    ip addr flush dev "$AP_IFACE"
    ip addr add "$AP_ADDRESS" dev "$AP_IFACE"
    if [ "$FORWARD" = 1 ]; then
        nft -f /etc/webrtc-cast-ap/nat.nft
    fi
}

cmd_iface_down() {
    load_config
    ip route del default dev "$AP_IFACE" metric 9999 2>/dev/null || true
    if [ "$FORWARD" = 1 ]; then
        nft delete table ip webrtc_cast_ap 2>/dev/null || true
    fi
    if [ "$MODE" = shared ]; then
        iw dev "$AP_IFACE" del 2>/dev/null || true
    else
        ip addr flush dev "$AP_IFACE" 2>/dev/null || true
    fi
}

# Last-resort default route via the AP, added after hostapd has brought the
# interface up (the kernel refuses routes through a down interface, and drops
# them when it goes down). Chrome only offers WebRTC addresses on the
# default-route interface, so a station with no uplink at all would offer
# nothing. The huge metric means any real uplink route always wins. Never
# fails: it runs as hostapd's ExecStartPost and must not stop the AP.
cmd_route_up() {
    load_config
    for _ in $(seq 1 10); do
        if ip route replace default dev "$AP_IFACE" metric 9999 2>/dev/null; then
            exit 0
        fi
        sleep 1
    done
    warn "could not add the fallback default route via $AP_IFACE (the AP still works)"
    exit 0
}

set_hostapd_channel() {
    sed -i -e "s/^channel=.*/channel=$1/" -e "s/^hw_mode=.*/hw_mode=$2/" /etc/hostapd/hostapd.conf
}

# --shared: pick the AP channel before hostapd starts (see decide_ap_channel).
# Exits non-zero when no channel works, so hostapd isn't started on a channel
# the card refuses; systemd retries, which picks it up if the uplink moves.
cmd_sync_channel() {
    load_config
    [ "$MODE" = shared ] || exit 0
    local freq="" phy chanlist ch mode how uch
    local cch=${AP_CHANNEL:-6} cmode=${AP_HWMODE:-g}
    for _ in $(seq 1 30); do
        freq=$(iw dev "$IFACE" link 2>/dev/null | awk '/freq:/ { print $2; exit }')
        [ -n "$freq" ] && break
        sleep 1
    done
    if [ -z "$freq" ]; then
        warn "$IFACE is not connected after 30s; starting the AP on channel $cch"
        set_hostapd_channel "$cch" "$cmode"
        exit 0
    fi
    phy=$(cat "/sys/class/net/$IFACE/phy80211/name")
    chanlist=$(phy_channel_list "$phy")
    uch=$(freq_to_channel "${freq%.*}" 2>/dev/null || echo "?")
    read -r ch mode how <<<"$(decide_ap_channel "$chanlist" "${CHANNELS:-1}" "$freq" "$cch" "$cmode")"
    if [ "$ch" = none ]; then
        warn "the uplink is on channel $uch, which is $(describe_status "$mode"),"
        warn "and the card can't run the AP on a second channel. Connect the uplink on"
        warn "2.4 GHz, or use a second card for the AP."
        exit 1
    fi
    set_hostapd_channel "$ch" "$mode"
    if [ "$how" = same ]; then
        log "AP on channel $ch, shared with the uplink"
    else
        log "uplink on channel $uch; AP on its own channel $ch (time-sliced)"
    fi
}

# Print the frequencies (MHz) where this card may start an AP, space-separated
# (no DFS, no-IR, disabled or 6 GHz channels). The setup page uses this to keep
# the station on channels the AP can share, which avoids time-slicing.
cmd_ap_freqs() {
    load_config
    local phy
    phy=$(cat "/sys/class/net/$IFACE/phy80211/name" 2>/dev/null) || exit 1
    phy_channel_list "$phy" | awk '$3 == "ok" && $1 < 5925 { printf "%s%s", sep, $1; sep = " " } END { print "" }'
}

# --shared: run every minute by webrtc-cast-ap-drift.timer. hostapd only picks
# its channel when it starts; if the station later reconnects on another channel
# (a router on "auto" moves), restart hostapd so the AP follows it again instead
# of silently falling back to time-slicing.
cmd_check_drift() {
    load_config
    [ "$MODE" = shared ] || exit 0
    systemctl is-active --quiet hostapd || exit 0
    local freq cur phy chanlist ch mode how
    freq=$(iw dev "$IFACE" link 2>/dev/null | awk '/freq:/ { print $2; exit }')
    [ -n "$freq" ] || exit 0
    cur=$(iw dev "$AP_IFACE" info 2>/dev/null | awk '$1 == "channel" { print $2; exit }')
    [ -n "$cur" ] || exit 0
    phy=$(cat "/sys/class/net/$IFACE/phy80211/name" 2>/dev/null) || exit 0
    chanlist=$(phy_channel_list "$phy")
    read -r ch mode how <<<"$(decide_ap_channel "$chanlist" "${CHANNELS:-1}" "$freq" "${AP_CHANNEL:-6}" "${AP_HWMODE:-g}")"
    [ "$ch" != none ] || exit 0
    [ "$ch" != "$cur" ] || exit 0
    log "station now on channel $(freq_to_channel "${freq%.*}" 2>/dev/null || echo "?"); AP on $cur should be on $ch ($how): restarting hostapd"
    systemctl restart hostapd
}

# ---------------------------------------------------------------- install

cmd_install() {
    local ssid="" pass="" iface="" shared=0 address="192.168.11.1/24" range=""
    local band="2.4" channel="" country="US" alias="cast" domain="home.arpa" isolate=1 forward=0
    local strict=0 nostart=0
    AP_IFACE=ap0

    while [ $# -gt 0 ]; do
        case "$1" in
            --ssid) ssid=${2-}; shift 2 ;;
            --passphrase) pass=${2-}; shift 2 ;;
            --iface) iface=${2-}; shift 2 ;;
            --shared) shared=1; shift ;;
            --ap-iface) AP_IFACE=${2-}; shift 2 ;;
            --address) address=${2-}; shift 2 ;;
            --dhcp-range) range=${2-}; shift 2 ;;
            --band) band=${2-}; shift 2 ;;
            --channel) channel=${2-}; shift 2 ;;
            --country) country=${2-}; shift 2 ;;
            --alias) alias=${2-}; shift 2 ;;
            --domain) domain=${2-}; shift 2 ;;
            --no-isolate) isolate=0; shift ;;
            --forward)
                forward=1; shift
                # older form: --forward UPLINK (the uplink name is no longer needed)
                if [ $# -gt 0 ] && [ "${1#-}" = "$1" ]; then
                    warn "--forward no longer takes an interface name; ignoring '$1'"
                    shift
                fi ;;
            --strict) strict=1; shift ;;
            --no-start) nostart=1; shift ;;
            -h|--help) usage; exit 0 ;;
            *) die "unknown option: $1 (see --help)" ;;
        esac
    done

    need_root
    [ -f "$0" ] || die "run this script from a file (not piped into bash); it installs a copy of itself"

    # --- validate
    [ -n "$ssid" ] || die "--ssid is required"
    [[ "$ssid" =~ [[:cntrl:]] ]] && die "--ssid must not contain control characters"
    [ "$(printf '%s' "$ssid" | wc -c)" -le 32 ] || die "--ssid is longer than 32 bytes"
    [[ "$pass" =~ ^[\ -~]{8,63}$ ]] || die "--passphrase must be 8-63 printable ASCII characters"

    [[ "$address" =~ ^([0-9.]+)/([0-9]{1,2})$ ]] || die "--address must look like 192.168.11.1/24"
    local ap_ip=${BASH_REMATCH[1]} prefix=${BASH_REMATCH[2]}
    valid_ipv4 "$ap_ip" || die "--address has an invalid IP: $ap_ip"
    { [ "$prefix" -ge 8 ] && [ "$prefix" -le 30 ]; } || die "--address prefix must be /8 to /30"
    local network
    network=$(cidr_network "$address")
    [ "$ap_ip" != "${network%/*}" ] || die "--address is the network address; use a host address like ${network%.*}.1"

    local range_start range_end
    if [ -n "$range" ]; then
        range_start=${range%,*}; range_end=${range#*,}
        if ! valid_ipv4 "$range_start" || ! valid_ipv4 "$range_end"; then
            die "--dhcp-range must look like 192.168.11.100,192.168.11.200"
        fi
        [ "$(cidr_network "$range_start/$prefix")" = "$network" ] && [ "$(cidr_network "$range_end/$prefix")" = "$network" ] ||
            die "--dhcp-range must be inside $network"
    else
        [ "$prefix" = 24 ] || die "--dhcp-range is required when the prefix isn't /24"
        range_start="${ap_ip%.*}.100"; range_end="${ap_ip%.*}.200"
    fi
    local ap_int s_int e_int
    ap_int=$(ip_to_int "$ap_ip"); s_int=$(ip_to_int "$range_start"); e_int=$(ip_to_int "$range_end")
    [ "$s_int" -le "$e_int" ] || die "--dhcp-range start is after its end"
    { [ "$ap_int" -lt "$s_int" ] || [ "$ap_int" -gt "$e_int" ]; } || die "--dhcp-range must not include the AP address $ap_ip"

    local hw_mode
    case "$band" in
        2.4) hw_mode=g; channel=${channel:-6}
             [[ "$channel" =~ ^([1-9]|1[0-4])$ ]] || die "--channel must be 1-14 on 2.4 GHz" ;;
        5)   hw_mode=a; channel=${channel:-36}
             [[ "$channel" =~ ^[0-9]{2,3}$ ]] || die "--channel must be a 5 GHz channel like 36" ;;
        *)   die "--band must be 2.4 or 5" ;;
    esac
    [[ "$country" =~ ^[A-Z]{2}$ ]] || die "--country must be a two-letter code like US"
    [ -z "$alias" ] || [[ "$alias" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$ ]] || die "--alias must be a simple host name"
    [[ "$domain" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$ ]] || die "--domain must be a domain name like home.arpa"
    valid_ifname "$AP_IFACE" || die "--ap-iface is not a valid interface name"

    if [ -z "$iface" ]; then
        iface=$(first_wireless_iface) || die "no Wi-Fi card found; pass --iface (see: ip link)"
        log "using Wi-Fi card $iface (pass --iface to choose another)"
    fi
    valid_ifname "$iface" || die "--iface is not a valid interface name"
    [ "$shared" = 1 ] || AP_IFACE=$iface

    # --- card report / soft check
    local channels=1
    if [ -z "$ROOT" ]; then
        local phy_info
        phy_info=$(iw phy "$(cat "/sys/class/net/$iface/phy80211/name" 2>/dev/null)" info 2>/dev/null || true)
        [ -z "$phy_info" ] || channels=$(best_shared_channels "$phy_info")
        [ "$channels" -ge 1 ] || channels=1
        if ! check_card "$iface" "$shared" "$channel" "$hw_mode"; then
            [ "$strict" = 1 ] && die "card check failed (--strict)"
            warn "card check found problems; continuing anyway (use --strict to stop)"
        fi
    fi

    if [ "$shared" = 0 ] && [ -z "$ROOT" ]; then
        if grep -qsE "^[[:space:]]*(auto|allow-hotplug|iface)[[:space:]]+$iface\b" /etc/network/interfaces /etc/network/interfaces.d/* 2>/dev/null; then
            warn "$iface is also configured in /etc/network/interfaces*; in dedicated mode"
            warn "remove that so ifupdown doesn't fight hostapd over the card"
        fi
    fi

    # --- packages
    if [ -z "$ROOT" ]; then
        log "installing packages ..."
        export DEBIAN_FRONTEND=noninteractive
        local pkgs="hostapd dnsmasq iw"
        [ "$forward" = 0 ] || pkgs="$pkgs nftables"
        # shellcheck disable=SC2086
        apt-get install -y $pkgs
    fi

    # --- a previous install: stop it while its config and helper are still in
    # place, so its interface teardown (e.g. removing a shared-mode ap0) runs
    if [ -z "$ROOT" ] && [ -r "$CONF_DEFAULT" ]; then
        local old_mode old_ap
        old_mode=$(sed -n 's/^MODE=//p' "$CONF_DEFAULT")
        old_ap=$(sed -n 's/^AP_IFACE=//p' "$CONF_DEFAULT")
        if systemd_running; then
            log "stopping the previous access point ..."
            systemctl stop webrtc-cast-ap-drift.timer hostapd.service dnsmasq.service webrtc-cast-ap.service 2>/dev/null || true
        fi
        if [ "$old_mode" = shared ] && valid_ifname "$old_ap" && [ -e "/sys/class/net/$old_ap" ]; then
            iw dev "$old_ap" del 2>/dev/null || true
        fi
    fi

    # --- files
    log "writing configuration ..."
    mkdir -p "$(dirname "$CONF_DEFAULT")" "$(dirname "$HOSTAPD_CONF")" "$(dirname "$DNSMASQ_CONF")" \
             "$(dirname "$AP_UNIT")" "$(dirname "$HOSTAPD_DROPIN")" "$(dirname "$DNSMASQ_DROPIN")"

    cat > "$CONF_DEFAULT" <<EOF
# Written by contrib/ap-setup.sh; used by $SELF_INSTALL
MODE=$([ "$shared" = 1 ] && echo shared || echo dedicated)
IFACE=$iface
AP_IFACE=$AP_IFACE
AP_ADDRESS=$ap_ip/$prefix
FORWARD=$forward
# --shared: most channels the card can use at once (1 = AP must share the
# uplink's channel), and the AP's own channel when it can't share it.
CHANNELS=$channels
AP_CHANNEL=$channel
AP_HWMODE=$hw_mode
EOF

    if [ -f "$HOSTAPD_CONF" ] && [ ! -f "$HOSTAPD_CONF.webrtc-cast-ap.bak" ] &&
       ! grep -q 'webrtc-cast-ap' "$HOSTAPD_CONF"; then
        cp -p "$HOSTAPD_CONF" "$HOSTAPD_CONF.webrtc-cast-ap.bak"
    fi
    # ssid= and wpa_passphrase= stay single lines: the setup page edits them.
    ( umask 077
      cat > "$HOSTAPD_CONF" <<EOF
# Written by contrib/ap-setup.sh (webrtc-cast-ap)
interface=$AP_IFACE
driver=nl80211
ssid=$ssid
country_code=$country
ieee80211d=1
hw_mode=$hw_mode
channel=$channel
ieee80211n=1
wmm_enabled=1
auth_algs=1
ignore_broadcast_ssid=0
ap_isolate=$isolate
wpa=2
wpa_key_mgmt=WPA-PSK
rsn_pairwise=CCMP
wpa_passphrase=$pass
EOF
    )
    chmod 0600 "$HOSTAPD_CONF"

    {
        echo "# Written by contrib/ap-setup.sh (webrtc-cast-ap)"
        echo "interface=$AP_IFACE"
        echo "# Serve only the AP (not lo) so nothing else on port 53 is disturbed."
        echo "except-interface=lo"
        echo "bind-dynamic"
        echo "# Don't hand out /etc/hosts (it maps cast to 127.0.0.1 for the kiosk)."
        echo "no-hosts"
        echo "dhcp-range=$range_start,$range_end,$(prefix_to_netmask "$prefix"),12h"
        echo "dhcp-option=option:dns-server,$ap_ip"
        echo "# The station is the clients' default gateway even without forwarding:"
        echo "# Chrome only offers WebRTC addresses on the default-route interface,"
        echo "# so without a gateway casting times out."
        echo "dhcp-option=option:router,$ap_ip"
        if [ "$forward" = 0 ]; then
            echo "# No forwarding: nothing upstream to ask, answer local names only."
            echo "no-resolv"
        fi
        echo "# Local domain and search list, so a bare name like cast resolves on"
        echo "# clients that won't send single-label names to DNS (systemd-resolved)."
        echo "domain=$domain"
        echo "dhcp-option=option:domain-search,$domain"
        echo "local=/$domain/"
        if [ -n "$alias" ]; then
            echo "local=/$alias/"
            echo "address=/$alias/$ap_ip"
            echo "address=/$alias.$domain/$ap_ip"
        fi
    } > "$DNSMASQ_CONF"

    cat > "$AP_UNIT" <<EOF
# Written by contrib/ap-setup.sh
[Unit]
Description=webrtc-cast access point interface ($AP_IFACE)
BindsTo=sys-subsystem-net-devices-$iface.device
After=sys-subsystem-net-devices-$iface.device
Before=hostapd.service dnsmasq.service network-pre.target
Wants=network-pre.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=$SELF_INSTALL iface-up
ExecStop=$SELF_INSTALL iface-down

[Install]
WantedBy=multi-user.target
EOF

    {
        echo "# Written by contrib/ap-setup.sh"
        echo "[Unit]"
        echo "Requires=webrtc-cast-ap.service"
        echo "After=webrtc-cast-ap.service"
        if [ "$shared" = 1 ]; then
            echo "Wants=network-online.target"
            echo "After=network-online.target"
        fi
        echo
        echo "[Service]"
        [ "$shared" = 0 ] || echo "ExecStartPre=$SELF_INSTALL sync-channel"
        echo "ExecStartPost=$SELF_INSTALL route-up"
        echo "Restart=on-failure"
        echo "RestartSec=15"
    } > "$HOSTAPD_DROPIN"

    cat > "$DNSMASQ_DROPIN" <<EOF
# Written by contrib/ap-setup.sh
[Unit]
Wants=webrtc-cast-ap.service
After=webrtc-cast-ap.service
EOF

    if [ "$forward" = 1 ]; then
        mkdir -p "$(dirname "$SYSCTL_CONF")" "$(dirname "$NFT_CONF")"
        echo "net.ipv4.ip_forward=1" > "$SYSCTL_CONF"
        cat > "$NFT_CONF" <<EOF
#!/usr/sbin/nft -f
# Written by contrib/ap-setup.sh: NAT AP clients out through whichever
# uplink is active (every interface except the AP), copper or Wi-Fi.
# Own table, so the system's other nftables rules are left alone.
table ip webrtc_cast_ap
delete table ip webrtc_cast_ap
table ip webrtc_cast_ap {
    chain postrouting {
        type nat hook postrouting priority srcnat; policy accept;
        ip saddr $network oifname != "$AP_IFACE" masquerade
    }
}
EOF
    else
        rm -f "$SYSCTL_CONF" "$NFT_CONF"
    fi

    if [ -d "$ROOT/etc/NetworkManager" ]; then
        mkdir -p "$(dirname "$NM_CONF")"
        printf '[keyfile]\nunmanaged-devices=interface-name:%s\n' "$AP_IFACE" > "$NM_CONF"
    fi

    if [ "$shared" = 1 ]; then
        cat > "$DRIFT_SERVICE" <<EOF
# Written by contrib/ap-setup.sh
[Unit]
Description=webrtc-cast access point: follow the station's channel
After=hostapd.service

[Service]
Type=oneshot
ExecStart=$SELF_INSTALL check-drift
EOF
        cat > "$DRIFT_TIMER" <<EOF
# Written by contrib/ap-setup.sh
[Unit]
Description=webrtc-cast access point: check the station's channel every minute

[Timer]
OnBootSec=2min
OnUnitActiveSec=1min

[Install]
WantedBy=timers.target
EOF
    else
        rm -f "$DRIFT_SERVICE" "$DRIFT_TIMER"
    fi

    if [ -z "$ROOT" ]; then
        install -m 0755 "$0" "$SELF_INSTALL"
    else
        mkdir -p "$ROOT$(dirname "$SELF_INSTALL")"
        install -m 0755 "$0" "$ROOT$SELF_INSTALL"
    fi

    # --- services
    if [ -z "$ROOT" ]; then
        systemctl daemon-reload 2>/dev/null || true
        systemctl unmask hostapd
        systemctl enable webrtc-cast-ap.service hostapd.service dnsmasq.service
        if [ "$shared" = 1 ]; then
            systemctl enable webrtc-cast-ap-drift.timer
        else
            systemctl disable webrtc-cast-ap-drift.timer 2>/dev/null || true
        fi
        if systemd_running && [ "$nostart" = 0 ]; then
            [ "$forward" = 0 ] || sysctl -q -p "$SYSCTL_CONF"
            log "starting the access point ..."
            systemctl restart webrtc-cast-ap.service
            systemctl restart hostapd.service dnsmasq.service ||
                warn "a service failed to start; see: journalctl -u hostapd -u dnsmasq -u webrtc-cast-ap"
            [ "$shared" = 0 ] || systemctl restart webrtc-cast-ap-drift.timer
        else
            log "services enabled; they start on next boot"
        fi
    fi

    log "done: SSID \"$ssid\" on $AP_IFACE ($ap_ip/$prefix), DHCP $range_start-$range_end"
    if [ -n "$alias" ]; then
        log "clients join the AP and browse to https://$alias:8443 (or https://$alias.$domain:8443)"
    else
        log "clients join the AP and browse to https://$ap_ip:8443"
    fi
}

# -------------------------------------------------------------- uninstall

cmd_uninstall() {
    local purge=0
    while [ $# -gt 0 ]; do
        case "$1" in
            --purge) purge=1; shift ;;
            -h|--help) usage; exit 0 ;;
            *) die "unknown option: $1" ;;
        esac
    done
    need_root

    local forward=0
    if [ -r "$CONF_DEFAULT" ]; then
        forward=$(sed -n 's/^FORWARD=//p' "$CONF_DEFAULT")
    fi

    if [ -z "$ROOT" ]; then
        systemctl disable --now webrtc-cast-ap-drift.timer 2>/dev/null || true
        systemctl disable --now hostapd.service dnsmasq.service 2>/dev/null || true
        systemctl disable --now webrtc-cast-ap.service 2>/dev/null || true
    fi

    rm -f "$AP_UNIT" "$HOSTAPD_DROPIN" "$DNSMASQ_DROPIN" "$DNSMASQ_CONF" \
          "$SYSCTL_CONF" "$NFT_CONF" "$NM_CONF" "$CONF_DEFAULT" "$DRIFT_SERVICE" "$DRIFT_TIMER"
    rmdir "$(dirname "$HOSTAPD_DROPIN")" "$(dirname "$DNSMASQ_DROPIN")" "$(dirname "$NFT_CONF")" 2>/dev/null || true

    if [ -f "$HOSTAPD_CONF.webrtc-cast-ap.bak" ]; then
        mv -f "$HOSTAPD_CONF.webrtc-cast-ap.bak" "$HOSTAPD_CONF"
        log "restored the previous $HOSTAPD_CONF"
    elif [ -f "$HOSTAPD_CONF" ] && grep -q 'webrtc-cast-ap' "$HOSTAPD_CONF"; then
        rm -f "$HOSTAPD_CONF"
    fi

    if [ -z "$ROOT" ]; then
        [ "$forward" != 1 ] || sysctl -q -w net.ipv4.ip_forward=0 || true
        systemctl daemon-reload 2>/dev/null || true
        if [ "$purge" = 1 ]; then
            DEBIAN_FRONTEND=noninteractive apt-get purge -y hostapd dnsmasq
        fi
        rm -f "$SELF_INSTALL"
    else
        rm -f "$ROOT$SELF_INSTALL"
    fi
    log "access point removed"
}

# ------------------------------------------------------------------ check

cmd_check() {
    local iface="" shared=0
    AP_IFACE=ap0
    while [ $# -gt 0 ]; do
        case "$1" in
            --iface) iface=${2-}; shift 2 ;;
            --shared) shared=1; shift ;;
            -h|--help) usage; exit 0 ;;
            *) die "unknown option: $1" ;;
        esac
    done
    if [ -z "$iface" ]; then
        iface=$(first_wireless_iface) || die "no Wi-Fi card found; pass --iface (see: ip link)"
    fi
    if check_card "$iface" "$shared"; then
        log "check passed"
    else
        log "check found problems (see above)"
        exit 1
    fi
}

# ------------------------------------------------------------------- main

case "${1-}" in
    install)      shift; cmd_install "$@" ;;
    uninstall)    shift; cmd_uninstall "$@" ;;
    check)        shift; cmd_check "$@" ;;
    iface-up)     cmd_iface_up ;;
    iface-down)   cmd_iface_down ;;
    sync-channel) cmd_sync_channel ;;
    route-up)     cmd_route_up ;;
    check-drift)  cmd_check_drift ;;
    ap-freqs)     cmd_ap_freqs ;;
    -h|--help|"") usage ;;
    *)            die "unknown command: $1 (see --help)" ;;
esac
