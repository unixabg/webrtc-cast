## Wi-Fi cards tested with the webrtc-cast access point

`contrib/ap-setup.sh check` reports what a card's driver *advertises*. This
file records what cards actually *did* on real hardware, because the two are
not always the same. `check` prints a short note for cards listed here.

### Summary

| Card | ID | Driver / firmware | Dedicated AP | Station + AP, one channel | Station + AP, two channels | Recommended use |
|---|---|---|---|---|---|---|
| Qualcomm Atheros QCA6174 (PCIe) | 168c:003e | ath10k_pci, WLAN.RM.4.4.1-00309 | stable | works, stalls about hourly | drops AP clients within minutes | dedicated AP with a copper uplink; add a second card for a Wi-Fi uplink |

### Qualcomm Atheros QCA6174 (168c:003e, ath10k_pci)

Tested 2026-09-27/28 on Debian 13 (trixie), firmware WLAN.RM.4.4.1-00309.

What the card reports:
* Regulatory: uses its own world-roaming setting (country 99), not the
  system's; every 5 GHz channel is no-IR, so the AP runs on 2.4 GHz only.
* Interface combinations: station + AP on one channel, or on up to two
  channels (time-sliced).

Results:
* Dedicated AP, copper uplink: stable; cast all night with no driver errors.
* Dedicated AP, no uplink at all: casting works (short test).
* Station on 5 GHz ch 149 + AP on 2.4 GHz ch 6 (two channels, time-sliced):
  works at first, then AP clients drop within minutes. The kernel logs
  `ath10k_pci ...: failed to flush transmit queue` and
  `received bcn tmpl tx status on vdev 2`, and hostapd logs
  `did not acknowledge authentication response` while clients retry.
* Station and AP sharing 2.4 GHz ch 1 (one channel): much better, but the
  firmware still logged `failed to flush transmit queue` about once an hour,
  and AP clients were cut off for about a minute each time.
* AP on 5 GHz: not possible (no-IR).
* Joining a network with the AP running: works.

Recommendation: use it as a dedicated AP with a copper uplink. For a Wi-Fi
uplink, add a second (USB) card and keep one job per card.

### Adding a card

Please add a section and a summary row for any card you test:

1. `sudo contrib/ap-setup.sh check --iface <card> --shared` (paste the output)
2. The card's ID (`lspci -nn` or `lsusb`), driver and firmware
   (`journalctl -k -b | grep -i firmware`)
3. The modes you ran (dedicated / shared, bands and channels), for how long,
   and what happened, with the kernel lines
   (`journalctl -k -f | grep <driver>`) and hostapd lines if clients dropped
4. The date and Debian version

If a card needs a note in `check`, add its ID to `known_card_notes` in
`contrib/ap-setup.sh`.
