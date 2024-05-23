const fs = require('fs');
const https = require('https');
const WebSocket = require('ws');
const { exec } = require('child_process');

// Load SSL certificate and private key from file system
const serverOptions = {
    cert: fs.readFileSync('cert.pem'),
    key: fs.readFileSync('key.pem')
};

// Create an HTTPS server for serving HTML files
const httpsServer = https.createServer(serverOptions, (req, res) => {
    console.log(`Received request for: ${req.url}`);
    // Access query params using req.query directly (Express-like approach)
    const queryParams = new URLSearchParams(req.url.split('?')[1]);
    const url = req.url.split('?')[0];

    console.log('Full url is ', req.url);
    console.log('Base url is: ', url);

    if (url === '/setup') {
        const html = `
        <html>
            <body>
                <h1>WebRTC-Cast Setup</h1>
                <table>
                    <tr>
                        <td>
                            <h2>Station WiFi</h2>
                            <form action="/setup-wifi" method="get">
                                <label for="ssid">SSID:</label>
                                <input type="text" id="ssid" name="ssid"><br><br>
                                <label for="psk">PSK:</label>
                                <input type="password" id="psk" name="psk"><br><br>
                                <input type="submit" value="Submit">
                            </form>
                        </td>
                        <td>
                            <h2>AP WiFi</h2>
                            <form action="/setup-ap" method="get">
                                <label for="ap_ssid">SSID:</label>
                                <input type="text" id="ap_ssid" name="ap_ssid"><br><br>
                                <label for="ap_psk">PSK:</label>
                                <input type="password" id="ap_psk" name="ap_psk"><br><br>
                                <input type="submit" value="Submit">
                            </form>
                        </td>
                    </tr>
                    <tr>
                        <td>
                            <button style="background-color: red; color: white; padding: 10px 20px; border: none; border-radius: 5px; cursor: pointer;" onclick="location.href='/reboot'">Reboot</button>
                        </td>
                        <td>
                            <button style="background-color: blue; color: white; padding: 10px 20px; border: none; border-radius: 5px; cursor: pointer;" onclick="fetchNetworkInfo()">Show Network Info</button>
                        </td>
                    </tr>
                </table>
                <pre id="networkInfo" style="background-color: #f0f0f0; padding: 10px; margin-top: 20px; border-radius: 5px; display: none;"></pre>
                <script>
                    function fetchNetworkInfo() {
                        fetch('/network-info')
                            .then(response => response.text())
                            .then(data => {
                                const networkInfoElement = document.getElementById('networkInfo');
                                networkInfoElement.textContent = data;
                                networkInfoElement.style.display = 'block';
                            })
                            .catch(error => {
                                console.error('Error fetching network info:', error);
                            });
                    }
                </script>
            </body>
        </html>
        `;
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
    } else if (url === '/network-info') {
        exec('ip a', (error, stdout, stderr) => {
            if (error) {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end(`Error: ${error.message}`);
                console.log(`Error: ${error.message}`);
            } else {
                res.writeHead(200, { 'Content-Type': 'text/plain' });
                res.end(stdout);
            }
        });
    } else if (url === '/setup-wifi') {
        // Set specific query params
        const ssid = queryParams.get('ssid');
        const psk = queryParams.get('psk');
        console.log(`Station Params: ${ssid} and ${psk}`);

        // Write the Wi-Fi configuration to the file
        exec(`sudo tee /etc/network/interfaces.d/wlan0 << 'EOF'
allow-hotplug wlan0
iface wlan0 inet dhcp
wpa-ssid ${ssid}
wpa-psk ${psk}
EOF`, (error, stdout, stderr) => {
            if (error) {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end(`Error: ${error.message}`);
                console.log(`Error: ${error.message}`);
            } else {
                const html = `
                <html>
                    <head>
                        <meta http-equiv="refresh" content="3; URL='/setup'" />
                    </head>
                    <body>
                        <h1>Station WiFi setup successful!</h1>
                        <h2>Reboot to apply the settings!</h1>
                    </body>
                </html>
                `;
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(html);
                console.log('Wi-Fi configuration written successfully');
            }
        });
    } else if (url === '/setup-ap') {
        // Set specific query params
        const ap_ssid = queryParams.get('ap_ssid');
        const ap_psk = queryParams.get('ap_psk');
        console.log(`AP Params: ${ap_ssid} and ${ap_psk}`);

        // Write the Wi-Fi configuration to the file
        exec(`sudo sed -i 's/^ssid=.*/ssid=${ap_ssid}/; s/^wpa_passphrase=.*/wpa_passphrase=${ap_psk}/' /etc/hostapd/hostapd.conf`, (error, stdout, stderr) => {
            if (error) {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end(`Error: ${error.message}`);
                console.log(`Error: ${error.message}`);
            } else {
                const html = `
                <html>
                    <head>
                        <meta http-equiv="refresh" content="3; URL='/setup'" />
                    </head>
                    <body>
                        <h1>AP WiFi setup successful!</h1>
                        <h2>Reboot to apply the settings!</h1>
                    </body>
                </html>
                `;
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(html);
                console.log('AP configuration written successfully');
            }
        });
    } else if (url === '/reboot') {
        // Reboot the system to apply the setting
        const html = `
        <html>
            <head>
                <meta http-equiv="refresh" content="1; URL='/'" />
            </head>
            <body>
                <h2>Rebooting WebRTC-Cast!</h1>
            </body>
        </html>
        `;
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
        console.log('Reboot called');
        exec(`sudo reboot`, (error, stdout, stderr) => {
            if (error) {
                console.log(`Error: ${error.message}`);
            } else {
                console.log('Reboot called');
            }
        });
    } else {
        // Handle other URLs as before
        if (url === '/') {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(fs.readFileSync('./html/client.html', 'utf8'));
        } else if (url === '/app.js') {
            res.writeHead(200, { 'Content-Type': 'application/javascript' });
            res.end(fs.readFileSync('./html/app.js', 'utf8'));
        } else if (url === '/listening-chrome.html') {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(fs.readFileSync('./html/listening-chrome.html', 'utf8'));
        }
    }
});

// Bind WebSocket server to HTTPS server
const wss = new WebSocket.Server({ server: httpsServer });
console.log('Secure WebSocket server started on wss://localhost:8080');

// Handle new WebSocket connections
wss.on('connection', function(ws) {
    console.log('New client connected.');

    // Handle incoming messages from clients
    ws.on('message', function(message) {
        console.log(`Received message: ${message}`);
        try {
            const data = JSON.parse(message);
            handleClientMessage(data, ws);
        } catch (e) {
            console.error('Error parsing message:', e);
            ws.send(JSON.stringify({ error: 'Failed to parse message as JSON' }));
        }
    });

    // Log when a client disconnects
    ws.on('close', () => {
        console.log('Client has disconnected.');
    });

    // Log errors related to the WebSocket connection
    ws.on('error', (error) => {
        console.error(`WebSocket error: ${error}`);
    });
});

function handleClientMessage(data, ws) {
    console.log('Handling client message:', data);
    switch (data.type) {
        case 'info':
            console.log('Info message received:', data.data);
            break;
        case 'error':
            console.log('Error message received:', data.data);
            break;
        case 'offer':
            console.log('Offer received, distributing to other clients.');
            distributeMessage(data, ws);
            break;
        case 'answer':
            console.log('Answer received, distributing to other clients.');
            distributeMessage(data, ws);
            break;
        case 'ping':
            console.log('Ping received, sending ping to clients.');
            distributeMessage(data, ws);
            break;
        case 'pong':
            console.log('Pong received, sending pong to clients.', data.data);
            distributeMessage(data, ws);
            break;
        case 'candidate':
            console.log('Candidate received, distributing to other clients.');
            distributeMessage(data, ws);
            break;
        case 'listening-refresh':
            console.log('Client called for a listening refresh:', data.data);
            distributeMessage(data, ws);
            break;
        case 'stream-stopped':
            console.log('Stream stopped message received:', data.data);
            distributeMessage(data, ws);
            break;
        case 'stream-playing':
            console.log('Stream playing message received:', data.data);
            distributeMessage(data, ws);
            break;
        case 'unmute-audio':
            console.log('Unmute audio signal received.');
            distributeMessage(data, ws);
            break;
         case 'mute-audio':
            console.log('Mute audio signal received.');
            distributeMessage(data, ws);
            break;
        default:
            console.error('Unhandled message type:', data.type);
            ws.send(JSON.stringify({ error: 'Unhandled message type' }));
    }
}

function distributeMessage(data, ws) {
    console.log('Distributing message to other clients.');
    wss.clients.forEach(function each(client) {
        if (client !== ws && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(data));
            console.log('Message sent to a client:', data.type);
        }
    });
}

// Start the HTTPS server
httpsServer.listen(8080, () => {
    console.log('HTTP and WebSocket server started on http://localhost:8080');
});

