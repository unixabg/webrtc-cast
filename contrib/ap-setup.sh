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
#                        Needs driver support for managed+AP at once, and the
#                        AP must use the same channel as the uplink; the
#                        channel is synced from the uplink when hostapd starts.
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
  --channel N            Channel (default 6 on 2.4 GHz, 36 on 5 GHz; in
                         --shared mode this is only used until the uplink's
                         channel is known)
  --country CC           Regulatory country code (default US)
  --alias NAME           DNS name clients can use for the station (default
                         cast, so https://cast:8443); --alias '' disables
  --no-isolate           Let AP clients reach each other (default: isolated,
                         clients can only talk to the station)
  --forward UPLINK       Also route AP clients to the network on UPLINK with
                         NAT (gives them internet/LAN access; off by default,
                         casting does not need it)
  --strict               Stop if the card check finds a problem (default: warn)
  --no-start             Enable services but don't start them now

check options:
  --iface IF, --shared   As above; reports whether the card can do AP mode
                         (and managed+AP at once with --shared)

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

# Soft check of the card. Returns 0 if nothing wrong was found, 1 otherwise.
check_card() {
    local iface=$1 shared=$2 problems=0 phy info driver line result channels=""

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
    log "card: $iface ($phy), driver: ${driver:-unknown}"

    if printf '%s\n' "$info" | phy_modes | grep -qx 'AP'; then
        log "  AP mode: supported"
    else
        warn "  AP mode: NOT listed for $iface; hostapd will not be able to run on this card"
        problems=1
    fi

    if [ "$shared" = 1 ]; then
        while IFS= read -r line; do
            result=$(printf '%s\n' "$line" | combination_allows_shared)
            if [ -n "$result" ]; then
                channels=${result#yes }
                break
            fi
        done < <(printf '%s\n' "$info" | phy_combinations)
        if [ -n "$channels" ]; then
            log "  managed + AP at the same time: supported (#channels <= $channels)"
            if [ "$channels" -le 1 ]; then
                log "  the AP must use the uplink's channel; it is synced when hostapd starts,"
                log "  but if the uplink roams to another channel, restart hostapd"
            fi
        else
            warn "  managed + AP at the same time: NOT supported by this driver;"
            warn "  --shared will not work, use a second card for the AP"
            problems=1
        fi
    fi

    case "$driver" in
        iwlwifi)
            warn "  Intel (iwlwifi): AP mode is usually limited to 2.4 GHz; 5 GHz AP is"
            warn "  often refused. Use --band 2.4 or a MediaTek/Atheros card for the AP." ;;
        mt76*|mt7*|ath9k*|ath10k*|ath11k*|ath12k*|brcmfmac)
            log "  driver has a good track record for AP mode" ;;
        8188eu|8192eu|8812au|8814au|8821au|8821cu|88x2bu|88XXau|rtl88xxau|rtl8812au|rtl88x2bu|rtl8821cu)
            warn "  $driver is an out-of-tree Realtek driver; AP mode is often unreliable"
            warn "  and it can break on kernel updates" ;;
    esac

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
    if [ "$FORWARD" = 1 ]; then
        nft delete table ip webrtc_cast_ap 2>/dev/null || true
    fi
    if [ "$MODE" = shared ]; then
        iw dev "$AP_IFACE" del 2>/dev/null || true
    else
        ip addr flush dev "$AP_IFACE" 2>/dev/null || true
    fi
}

# --shared: set hostapd's channel/band to the uplink's before hostapd starts.
cmd_sync_channel() {
    load_config
    [ "$MODE" = shared ] || exit 0
    local freq="" ch mode
    for _ in $(seq 1 30); do
        freq=$(iw dev "$IFACE" link 2>/dev/null | awk '/freq:/ { print $2; exit }')
        [ -n "$freq" ] && break
        sleep 1
    done
    if [ -z "$freq" ]; then
        warn "$IFACE is not connected after 30s; starting the AP on the configured channel"
        exit 0
    fi
    ch=$(freq_to_channel "$freq") || { warn "unknown uplink frequency $freq; leaving channel as is"; exit 0; }
    if [ "${freq%.*}" -ge 5000 ]; then
        mode=a
        warn "uplink is on 5 GHz channel $ch; many cards refuse to start an AP there"
    else
        mode=g
    fi
    sed -i -e "s/^channel=.*/channel=$ch/" -e "s/^hw_mode=.*/hw_mode=$mode/" /etc/hostapd/hostapd.conf
    log "AP channel synced to uplink: channel $ch (hw_mode=$mode)"
}

# ---------------------------------------------------------------- install

cmd_install() {
    local ssid="" pass="" iface="" shared=0 address="192.168.11.1/24" range=""
    local band="2.4" channel="" country="US" alias="cast" isolate=1 uplink=""
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
            --no-isolate) isolate=0; shift ;;
            --forward) uplink=${2-}; shift 2 ;;
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
    valid_ifname "$AP_IFACE" || die "--ap-iface is not a valid interface name"
    [ -z "$uplink" ] || valid_ifname "$uplink" || die "--forward needs a valid uplink interface name"

    if [ -z "$iface" ]; then
        iface=$(first_wireless_iface) || die "no Wi-Fi card found; pass --iface (see: ip link)"
        log "using Wi-Fi card $iface (pass --iface to choose another)"
    fi
    valid_ifname "$iface" || die "--iface is not a valid interface name"
    [ "$shared" = 1 ] || AP_IFACE=$iface
    [ -z "$uplink" ] || [ "$uplink" != "$AP_IFACE" ] || die "--forward uplink can't be the AP interface"

    # --- soft card check
    if [ -z "$ROOT" ]; then
        if ! check_card "$iface" "$shared"; then
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
        [ -z "$uplink" ] || pkgs="$pkgs nftables"
        # shellcheck disable=SC2086
        apt-get install -y $pkgs
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
FORWARD=$([ -n "$uplink" ] && echo 1 || echo 0)
UPLINK=$uplink
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
        echo "dhcp-range=$range_start,$range_end,$(prefix_to_netmask "$prefix"),12h"
        echo "dhcp-option=option:dns-server,$ap_ip"
        if [ -n "$uplink" ]; then
            echo "dhcp-option=option:router,$ap_ip"
        else
            echo "# No default gateway: clients only reach the cast station."
            echo "dhcp-option=option:router"
            echo "no-resolv"
        fi
        [ -z "$alias" ] || echo "address=/$alias/$ap_ip"
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
        echo "Restart=on-failure"
        echo "RestartSec=5"
    } > "$HOSTAPD_DROPIN"

    cat > "$DNSMASQ_DROPIN" <<EOF
# Written by contrib/ap-setup.sh
[Unit]
Wants=webrtc-cast-ap.service
After=webrtc-cast-ap.service
EOF

    if [ -n "$uplink" ]; then
        mkdir -p "$(dirname "$SYSCTL_CONF")" "$(dirname "$NFT_CONF")"
        echo "net.ipv4.ip_forward=1" > "$SYSCTL_CONF"
        cat > "$NFT_CONF" <<EOF
#!/usr/sbin/nft -f
# Written by contrib/ap-setup.sh: NAT AP clients out through $uplink.
# Own table, so the system's other nftables rules are left alone.
table ip webrtc_cast_ap
delete table ip webrtc_cast_ap
table ip webrtc_cast_ap {
    chain postrouting {
        type nat hook postrouting priority srcnat; policy accept;
        ip saddr $network oifname "$uplink" masquerade
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
        if systemd_running && [ "$nostart" = 0 ]; then
            [ -z "$uplink" ] || sysctl -q -p "$SYSCTL_CONF"
            log "starting the access point ..."
            systemctl restart webrtc-cast-ap.service
            systemctl restart hostapd.service dnsmasq.service ||
                warn "a service failed to start; see: journalctl -u hostapd -u dnsmasq -u webrtc-cast-ap"
        else
            log "services enabled; they start on next boot"
        fi
    fi

    log "done: SSID \"$ssid\" on $AP_IFACE ($ap_ip/$prefix), DHCP $range_start-$range_end"
    if [ -n "$alias" ]; then
        log "clients join the AP and browse to https://$alias:8443"
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
        systemctl disable --now hostapd.service dnsmasq.service 2>/dev/null || true
        systemctl disable --now webrtc-cast-ap.service 2>/dev/null || true
    fi

    rm -f "$AP_UNIT" "$HOSTAPD_DROPIN" "$DNSMASQ_DROPIN" "$DNSMASQ_CONF" \
          "$SYSCTL_CONF" "$NFT_CONF" "$NM_CONF" "$CONF_DEFAULT"
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
        log "check found problems (see warnings above)"
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
    -h|--help|"") usage ;;
    *)            die "unknown command: $1 (see --help)" ;;
esac
