const fs = require('fs');
const https = require('https');
const WebSocket = require('ws');
const { exec } = require('child_process');
const path = require('path');
const express = require('express');
const crypto = require('crypto');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const NETWORK_TEST_URL_FILE = path.join(__dirname, '../network_test_url.txt'); // Store in ./ directory
const PASSWORD_FILE = path.join(__dirname, '../password.txt'); // Store password in ./ directory
const TOKEN_SECRET = 'your_secret'; // Use a secret for token generation
const validTokens = new Set(); // Store valid tokens in memory

const serverOptions = {
    cert: fs.readFileSync(path.join(__dirname, '../cert.pem')), // Read cert from ./ directory
    key: fs.readFileSync(path.join(__dirname, '../key.pem')) // Read key from ./ directory
};

// Create an HTTPS server for serving HTML files
const httpsServer = https.createServer(serverOptions, app);

// Serve client.html at the root URL
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../html/client.html'));
});

// Middleware to check for token
function checkToken(req, res, next) {
    const token = req.headers['x-token'];
    if (token && validTokens.has(token)) {
        next();
    } else {
        res.status(401).send('<html><body><h1>Unauthorized</h1><p>You must provide the correct token.</p></body></html>');
    }
}

// Serve login.html
app.get('/setup', (req, res) => {
    res.sendFile(path.join(__dirname, '../html/login.html'));
});

// Handle login and generate token
app.post('/login', (req, res) => {
    const password = fs.readFileSync(PASSWORD_FILE, 'utf8').trim();
    const enteredPassword = req.body.password;

    if (enteredPassword && enteredPassword === password) {
        const token = crypto.randomBytes(16).toString('hex');
        validTokens.add(token);
        console.log('Login successful, token generated');
        res.json({ token });
    } else {
        console.log('Login failed');
        res.status(401).send('Unauthorized: You must provide the correct password.');
    }
});

// Serve setup.html with token protection
app.get('/setup-protected', (req, res) => {
    console.log('Accessing setup-protected page');
    res.sendFile(path.join(__dirname, '../html/setup.html'));
});

// Setup actions protected by token
app.post('/set-hostname', checkToken, (req, res) => {
    const newHostname = req.body.hostname;
    console.log(`Setting new hostname to: ${newHostname}`);
    exec(`sudo hostnamectl set-hostname ${newHostname}`, (error, stdout, stderr) => {
        if (error) {
            res.status(500).send(`Error: ${error.message}`);
        } else {
            res.send(`Hostname set to ${newHostname}`);
        }
    });
});

app.get('/network-info', checkToken, (req, res) => {
    exec('ip a', (error, stdout, stderr) => {
        if (error) {
            res.status(500).send(`Error: ${error.message}`);
        } else {
            res.send(stdout);
        }
    });
});

app.post('/save-network-test-url', checkToken, (req, res) => {
    const url = req.body.networkTestUrl || 'https://www.google.com';
    fs.writeFileSync(NETWORK_TEST_URL_FILE, url);
    console.log(`Network Test URL set to: ${url}`);
    res.send('Network Test URL saved successfully!');
});

app.get('/get-network-test-url', checkToken, (req, res) => {
    if (fs.existsSync(NETWORK_TEST_URL_FILE)) {
        const url = fs.readFileSync(NETWORK_TEST_URL_FILE, 'utf8');
        res.send(url);
    } else {
        res.send('https://www.google.com');
    }
});

app.get('/get-hostname', checkToken, (req, res) => {
    exec('hostname', (error, stdout, stderr) => {
        if (error) {
            res.status(500).send(`Error: ${error.message}`);
        } else {
            res.send(stdout.trim());
        }
    });
});

app.get('/setup-wifi', checkToken, (req, res) => {
    const ssid = req.query.ssid;
    const psk = req.query.psk;
    console.log(`Setting up Station WiFi with SSID: ${ssid}`);
    exec(`sudo tee /etc/network/interfaces.d/wlan0 << 'EOF'
allow-hotplug wlan0
iface wlan0 inet dhcp
wpa-ssid ${ssid}
wpa-psk ${psk}
EOF`, (error, stdout, stderr) => {
        if (error) {
            res.status(500).send(`Error setting up station WiFi: ${error.message}`);
            console.log(`Error setting up station WiFi: ${error.message}`);
        } else {
            res.send('Station WiFi setup successful!');
        }
    });
});

app.get('/setup-ap', checkToken, (req, res) => {
    const ap_ssid = req.query.ap_ssid;
    const ap_psk = req.query.ap_psk;
    console.log(`Setting up AP WiFi with SSID: ${ap_ssid}`);
    exec(`sudo sed -i 's/^ssid=.*/ssid=${ap_ssid}/; s/^wpa_passphrase=.*/wpa_passphrase=${ap_psk}/' /etc/hostapd/hostapd.conf`, (error, stdout, stderr) => {
        if (error) {
            res.status(500).send(`Error setting up AP WiFi: ${error.message}`);
            console.log(`Error setting up AP WiFi: ${error.message}`);
        } else {
            res.send('AP WiFi setup successful!');
        }
    });
});

app.get('/reboot', checkToken, (req, res) => {
    console.log('Rebooting WebRTC-Cast');
    res.send('<html><head><meta http-equiv="refresh" content="1; URL=\'/\'" /></head><body><h2>Rebooting WebRTC-Cast!</h2></body></html>');
    exec('sudo reboot', (error, stdout, stderr) => {
        if (error) {
            console.log(`Error: ${error.message}`);
        } else {
            console.log('Reboot called');
        }
    });
});

app.use(express.static(path.join(__dirname, '../html')));

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
    console.log('HTTP and WebSocket server started on https://localhost:8080');
});

