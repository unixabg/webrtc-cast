## WebRTC for casting with Chrome/Chromium

### Requirements
* Linux
    * Tested with Debian and PiOS
* nodejs, npm, git, and chromium
* npm install express

### Kiosk Install
> [!CAUTION]
>
> The kiosk install will make a lot of changes to your install. There is no
> automated undo from the kiosk-install.sh script. Do not proceed if you can
> not easily re-install linux on your system.
>
> The kiosk install requires internet access to install.

* Clone the repository

`git clone https://github.com/unixabg/webrtc-cast.git`

* Change directory to the checkout dir

`cd webrtc-cast`

* For the kiosk install we will use the run as root (or sudo)
contrib/kiosk-install.sh

`sudo contrib/kiosk-install.sh `

* When the installer finishes and you reboot you should have a setup
with a listening-chrome.html running in full screen and a listening
web socket server. Hence, on a client machine go to
https://ipAddressOfCast:8443 to start casting.

### Kiosk listening-chrom.html
#### Status Icons
Internet Status - FIXME - github strips raw svg

<svg viewBox="0 0 24 24" fill="grey" width="20"><path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 8.69 4 5.94 6.11 5.35 9.14 2.42 9.36 0 11.92 0 15c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96z"/></svg> - Internet status unknown
<svg viewBox="0 0 24 24" fill="green" width="20"><path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 8.69 4 5.94 6.11 5.35 9.14 2.42 9.36 0 11.92 0 15c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96z"/></svg> - Internet access working
<svg viewBox="0 0 24 24" fill="red" width="20"><path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 8.69 4 5.94 6.11 5.35 9.14 2.42 9.36 0 11.92 0 15c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96z"/></svg> - Internet access not working

Socket Server Status

<svg viewBox="0 0 24 24" fill="grey" width="20"><circle cx="12" cy="12" r="10" /></svg> - Socket Server status unkown
<svg viewBox="0 0 24 24" fill="green" width="20"><circle cx="12" cy="12" r="10" /></svg> - Socket Server working
<svg viewBox="0 0 24 24" fill="red" width="20"><circle cx="12" cy="12" r="10" /></svg> - Socket Server not working

Streaming Status

<svg viewBox="0 0 24 24" fill="grey" width="20"><path d="M12 5C7.58 5 4 8.58 4 13C4 17.42 7.58 21 12 21C16.42 21 20 17.42 20 13C20 8.58 16.42 5 12 5M12 19C8.69 19 6 16.31 6 13C6 9.69 8.69 7 12 7C15.31 7 18 9.69 18 13C18 16.31 15.31 19 12 19M14.5 11L10 13.5V8.5L14.5 11Z" /></svg> - Listening for stream active
<svg viewBox="0 0 24 24" fill="green" width="20"><path d="M12 5C7.58 5 4 8.58 4 13C4 17.42 7.58 21 12 21C16.42 21 20 17.42 20 13C20 8.58 16.42 5 12 5M12 19C8.69 19 6 16.31 6 13C6 9.69 8.69 7 12 7C15.31 7 18 9.69 18 13C18 16.31 15.31 19 12 19M14.5 11L10 13.5V8.5L14.5 11Z" /></svg> - Stream active
<svg viewBox="0 0 24 24" fill="red" width="20"><path d="M12 5C7.58 5 4 8.58 4 13C4 17.42 7.58 21 12 21C16.42 21 20 17.42 20 13C20 8.58 16.42 5 12 5M12 19C8.69 19 6 16.31 6 13C6 9.69 8.69 7 12 7C15.31 7 18 9.69 18 13C18 16.31 15.31 19 12 19M14.5 11L10 13.5V8.5L14.5 11Z" /></svg> - Listening for stream disabled




### Setup Page
* The setup page password is located in the file ./password.txt
* To change the password to access the setup.page simply edit the
./password.txt file with the password you wish.
* To access the setup page go to the url 
https://ipAddressOfCast:8443/setup and enter the password.

### Display and Scaling Troubleshooting
Projectors vary a lot, so when someone reports the cast "not scaling right"
start here.

#### Resolution readout
The status box on the kiosk screen shows the version followed by
`src WxH → disp WxH`:
* `src` is the resolution being cast from the Chromebook or other device.
* `disp` is the resolution the kiosk is driving the projector at.

The whole cast screen is always shown. If `src` and `disp` have different
shapes (for example 16:9 on a 4:3 projector) you get black bars, which is
expected. If `disp` looks wrong for the projector (for example 1024×768 on a
projector that should be 1280×800), the projector is probably reporting a bad
mode list; see Pinning a display mode below.

#### Checking a unit over SSH
* Display mode X is using, and what the projector advertises
(`*` = current, `+` = preferred):

`sudo -u kiosk DISPLAY=:0 xrandr -q`

* Version the server is serving:

`curl -sk https://localhost:8443/version.txt`

If the current mode is not the projector's real native resolution, or the
list is short and odd (only 1024×768, for example), the projector's EDID is
wrong or not getting through. HDMI switches, extenders and long cable runs
are common causes.

#### Pinning a display mode
To force a resolution on a unit, create `display_mode.txt` in the
webrtc-cast directory with one line:
* `1280x800` - that mode on every connected output
* `1920x1080 60` - with a refresh rate
* `HDMI-1 1280x800` - only on the named output (names come from `xrandr -q`)

If the display doesn't list that mode it is created with `cvt`. Delete the
file to go back to the default. The kiosk launcher applies it with
`contrib/display-mode.sh` before chromium starts, so restart lightdm or
reboot after changing it. Launchers installed by `contrib/kiosk-install.sh`
already call it; an older or custom launcher needs this line added after the
`xset` lines in `/usr/bin/kiosk`:

`sh /home/kiosk/webrtc-cast/contrib/display-mode.sh`

#### TVs cutting off the edges
If the unit drives a TV and the edges are cut off even though the readout
looks right, the TV is overscanning. Set the TV's picture size to
"Just Scan", "Screen Fit", "1:1" or similar.

### Old Notes
* Clone the project.
* Move to the cloned directory: `cd webrtc-cast`
* If you don't have ssl certs generate self sigend with: `openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem -days 365 -nodes`
* To start the services sometimes I launch each service in an individual terminal so I can debug issues.
    * Launch the https and websocket server on port 8443: `nodejs nodejs/ws.js`
* On both the client and the server you need to accept the ssl certificates. In general setup I run the socket server and the web server on ws-server:8443.
    * If you self sign cert then you must accept ssl key for both https://ws-server:8443
* Lanuch chromium in kiosk mode with something like this: `chromium --disable-features=PreloadMediaEngagementData,MediaEngagementBypassAutoplayPolicies --autoplay-policy=no-user-gesture-required --ignore-certificate-errors --ignore-urlfetcher-cert-requests --ignore-websocket-cert-errors --kiosk  https://localhost:8443/listening-chrome.html`
* Or like this: `chromium --disable-features=PreloadMediaEngagementData,MediaEngagementBypassAutoplayPolicies --autoplay-policy=no-user-gesture-required --ignore-certificate-errors --ignore-urlfetcher-cert-requests --ignore-websocket-cert-errors --kiosk  file:///home/kiosk/webrtc-cast/html/listening-chrome.html`
* On the client machine go to https://ws-server:8443 to start casting.

FIXME
