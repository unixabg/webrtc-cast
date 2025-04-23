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
