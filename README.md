# webrtc-cast
Use WebRTC to cast chrome

### Requirements
* Linux
    * Tested with Debian and PiOS
* nodejs, npm, git, and chromium
* npm install express
### Notes
* Clone the project.
* Move to the cloned directory: `cd webrtc-cast`
* If you don't have ssl certs generate self sigend with: `openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem -days 365 -nodes`
* To start the services sometimes I launch each service in an individual terminal so I can debug issues.
    * Launch the https and websocket server on port 8080: `nodejs nodejs/ws.js`
* On both the client and the server you need to accept the ssl certificates. In general setup I run the socket server on ws-server:8080 and the web server on ws-server:8081.
    * If you self sign cert then you must accept ssl key for both https://ws-server:8080
* Lanuch chromium in kiosk mode with something like this: `chromium --disable-features=PreloadMediaEngagementData,MediaEngagementBypassAutoplayPolicies --autoplay-policy=no-user-gesture-required --ignore-certificate-errors --ignore-urlfetcher-cert-requests --ignore-websocket-cert-errors --kiosk  https://localhost:8080/listening-chrome.html`
* Or like this: `chromium --disable-features=PreloadMediaEngagementData,MediaEngagementBypassAutoplayPolicies --autoplay-policy=no-user-gesture-required --ignore-certificate-errors --ignore-urlfetcher-cert-requests --ignore-websocket-cert-errors --kiosk  file:///home/kiosk/webrtc-cast/html/listening-chrome.html`
* On the client machine you want to share your screen go to https://ws-server:8080 and click the client.html.

FIXME
