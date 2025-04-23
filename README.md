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
