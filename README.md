# webrtc-cast
Use WebRTC to cast chrome

### Requirements
* Linux
    * Tested with PiOS
* nodejs, npm, npm http-server, git, and chromium
### Notes
* Clone the project.
* Move to the cloned directory: `cd webrtc-cast`
* If you don't have ssl certs generate self sigend with: `openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem -days 365 -nodes`
* To start the services sometimes I launch each service in an individual terminal so I can debug issues.
    * Launch the websocket server on port 8080: `nodejs nodejs/ws.js`
    * Launch the https server and should start on port 8081 `http-server ./html -S -C cert.pem -o -p 8081`
* On both the client and the server you need to accept the ssl certificates. In general setup I run the socket server on ws-server:8080 and the web server on ws-server:8081.
    * If you self sign cert then you must accept ssl key for both https://ws-server:8080 and https://ws-server:8081
* Lanuch chromium in kiosk mode with something like this: `chromium --disable-features=PreloadMediaEngagementData,MediaEngagementBypassAutoplayPolicies --ignore-certificate-errors --kiosk https://localhost:8081/listening-chrome.html`
* On the client machine you want to share your screen go to https://ws-server and click the client.html. Remember you have to accept the certs for both server and socket server if cert self signed.

FIXME
