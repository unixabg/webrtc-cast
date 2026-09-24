const fs = require('fs');
const https = require('https');
const WebSocket = require('ws');
const { exec, execFile, spawn } = require('child_process');
const path = require('path');
const express = require('express');
const crypto = require('crypto');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const CASTING_ACTIVE_FILE = path.join(__dirname, '../casting.active'); // Define the path for the casting.active file
const CLOCK_ENABLED_FILE = path.join(__dirname, '../clock.enabled');
const LISTENING_DISABLED_FILE = path.join(__dirname, '../listening.disabled'); // Define the path for the listening.disabled file
const NETWORK_TEST_URL_FILE = path.join(__dirname, '../network_test_url.txt'); // Store in ./ directory
const PASSWORD_FILE = path.join(__dirname, '../password.txt'); // Store password in ./ directory
const TOKEN_SECRET = 'your_secret'; // Use a secret for token generation
const validTokens = new Set(); // Store valid tokens in memory
const DEFAULT_URL_FILE = path.join(__dirname, '../default_url.txt');


const serverOptions = {
    cert: fs.readFileSync(path.join(__dirname, '../cert.pem')), // Read cert from ./ directory
    key: fs.readFileSync(path.join(__dirname, '../key.pem')) // Read key from ./ directory
};

// Create an HTTPS server for serving HTML files
const httpsServer = https.createServer(serverOptions, app);

// Remove casting.active file on startup to ensure no stale state
if (fs.existsSync(CASTING_ACTIVE_FILE)) {
    fs.unlinkSync(CASTING_ACTIVE_FILE);
    console.log('Removed stale casting.active file on startup.');
}

// Serve welcomeclient.html at the root URL
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../html/welcome.html'));
});

// Prevent access to client.html if casting is active or listening is disabled
app.get('/client.html', (req, res) => {
    if (fs.existsSync(CASTING_ACTIVE_FILE)) {
        console.log('Redirecting user to welcome page: Cast is already active.');
        res.redirect('/');
    } else if (fs.existsSync(LISTENING_DISABLED_FILE)) {
        console.log('Redirecting user to welcome page: Casting is disabled.');
        res.redirect('/');
    } else {
        res.sendFile(path.join(__dirname, '../html/client.html'));
    }
});

// Serve version.txt
app.get('/version.txt', (req, res) => {
    res.sendFile(path.join(__dirname, '../version.txt'));
});

app.get('/get-default-url', (req, res) => {
    if (fs.existsSync(DEFAULT_URL_FILE)) {
        const url = fs.readFileSync(DEFAULT_URL_FILE, 'utf8');
        res.send(url.trim());
    } else {
        res.send('');
    }
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

// --- Input validation and shell-free helpers for the setup endpoints ---
// Setup values are never pasted into a shell command line. Commands run via
// execFile (argument list, no shell) and file contents go to `sudo tee` on
// stdin, so quotes, ;, $(), backticks or newlines in a value can't run anything.

// RFC 1123 host label: letters, digits and hyphens, 1-63 chars, no leading/trailing hyphen.
function isValidHostname(name) {
    return typeof name === 'string' && /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(name);
}

// SSID: 1-32 characters, no control characters (a newline would inject config lines).
function isValidSsid(ssid) {
    return typeof ssid === 'string' && ssid.length >= 1 && Buffer.byteLength(ssid, 'utf8') <= 32 &&
        !/[\x00-\x1f\x7f]/.test(ssid) && ssid.trim() === ssid;
}

// WPA passphrase: 8-63 printable ASCII characters, or a 64-digit hex key.
function isValidPsk(psk) {
    return typeof psk === 'string' &&
        (/^[\x20-\x7e]{8,63}$/.test(psk) || /^[0-9A-Fa-f]{64}$/.test(psk));
}

// Write content to a root-owned file through `sudo tee` without a shell.
function sudoWriteFile(filePath, content, callback) {
    const child = spawn('sudo', ['tee', filePath], { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', err => callback(err));
    child.on('close', code => {
        callback(code === 0 ? null : new Error(stderr.trim() || `sudo tee exited with ${code}`));
    });
    child.stdin.end(content);
}

// Function to check if a file exists
function fileExists(filePath) {
    return fs.existsSync(filePath); // This will return true if the file exists, false otherwise
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

// Check token validity
app.get('/check-token', (req, res) => {
    const token = req.headers['x-token'];
    if (token && validTokens.has(token)) {
        res.json({ valid: true });
    } else {
        res.status(401).json({ valid: false });
    }
});

// Invalidate token endpoint
app.post('/logout', checkToken, (req, res) => {
    const token = req.headers['x-token'];
    if (validTokens.has(token)) {
        validTokens.delete(token);
        res.json({ message: 'Logged out successfully' });
    } else {
        res.status(400).json({ message: 'Invalid token' });
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
    if (!isValidHostname(newHostname)) {
        console.log('Rejected invalid hostname.');
        return res.status(400).send('Invalid hostname: use 1-63 letters, digits or hyphens (not starting or ending with a hyphen).');
    }
    console.log(`Setting new hostname to: ${newHostname}`);
    execFile('sudo', ['hostnamectl', 'set-hostname', newHostname], (error, stdout, stderr) => {
        if (error) {
            res.status(500).send(`Error: ${error.message}`);
        } else {
            res.send(`Hostname set to ${newHostname}`);
        }
    });
});

// Network info endpoint accessible without token
app.get('/network-info', (req, res) => {
    exec('ip a', (error, stdout, stderr) => {
        if (error) {
            res.status(500).send(`Error: ${error.message}`);
        } else {
            res.send(stdout);
        }
    });
});

// Restart the lightdm actions protected by token
app.post('/restart-lightdm', checkToken, (req, res) => {
    // Send a response back to the client immediately
    res.send('Restarting LightDM...');

    // Execute the command after sending the response
    exec('sudo systemctl restart lightdm', (error, stdout, stderr) => {
        if (error) {
            console.error(`Error restarting LightDM: ${error.message}`);
        } else {
            console.log('LightDM restarted successfully.');
        }
    });
});

// Endpoint to get Station AP settings with token protection
app.get('/station-ap-settings', checkToken, (req, res) => {
    fs.readFile('/etc/network/interfaces.d/wlan0', 'utf8', (err, data) => {
        if (err) {
            res.status(500).send(`Error reading Station AP settings: ${err.message}`);
        } else {
            res.send(data);
        }
    });
});

// Endpoint to get HostAPD settings with token protection
app.get('/hostapd-settings', checkToken, (req, res) => {
    fs.readFile('/etc/hostapd/hostapd.conf', 'utf8', (err, data) => {
        if (err) {
            res.status(500).send(`Error reading HostAPD settings: ${err.message}`);
        } else {
            res.send(data);
        }
    });
});

// Save network test URL protected by token
app.post('/save-network-test-url', checkToken, (req, res) => {
    const url = req.body.networkTestUrl || 'https://www.google.com';
    fs.writeFileSync(NETWORK_TEST_URL_FILE, url);
    console.log(`Network Test URL set to: ${url}`);
    res.send('Network Test URL saved successfully!');
});

// Save default URL protected by token
app.post('/save-default-url', checkToken, (req, res) => {
    fs.writeFileSync(DEFAULT_URL_FILE, req.body.defaultUrl || '');
    res.send('Default URL saved.');

    // Broadcast to all connected clients to reload
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'reload-default-url' }));
        }
    });
});

// Get network test URL endpoint accessible without token
app.get('/get-network-test-url', (req, res) => {
    if (fs.existsSync(NETWORK_TEST_URL_FILE)) {
        const url = fs.readFileSync(NETWORK_TEST_URL_FILE, 'utf8');
        res.send(url);
    } else {
        res.send('https://www.google.com');
    }
});

// Get hostname endpoint accessible without token
app.get('/get-hostname', (req, res) => {
    exec('hostname', (error, stdout, stderr) => {
        if (error) {
            res.status(500).send(`Error: ${error.message}`);
        } else {
            res.send(stdout.trim());
        }
    });
});

// Setup WiFi endpoint protected by token
app.get('/setup-wifi', checkToken, (req, res) => {
    const ssid = req.query.ssid;
    const psk = req.query.psk;
    if (!isValidSsid(ssid)) {
        return res.status(400).send('Invalid SSID: 1-32 characters, no control characters or leading/trailing spaces.');
    }
    if (!isValidPsk(psk)) {
        return res.status(400).send('Invalid PSK: 8-63 printable characters, or a 64-digit hex key.');
    }
    console.log(`Setting up Station WiFi with SSID: ${JSON.stringify(ssid)}`); // never log the PSK
    const config = [
        'allow-hotplug wlan0',
        'iface wlan0 inet dhcp',
        `wpa-ssid ${ssid}`,
        `wpa-psk ${psk}`,
        ''
    ].join('\n');
    sudoWriteFile('/etc/network/interfaces.d/wlan0', config, (error) => {
        if (error) {
            res.status(500).send(`Error setting up station WiFi: ${error.message}`);
            console.log(`Error setting up station WiFi: ${error.message}`);
        } else {
            res.send('Station WiFi setup successful!');
        }
    });
});

// Setup AP WiFi endpoint protected by token
app.get('/setup-ap', checkToken, (req, res) => {
    const ap_ssid = req.query.ap_ssid;
    const ap_psk = req.query.ap_psk;
    if (!isValidSsid(ap_ssid)) {
        return res.status(400).send('Invalid SSID: 1-32 characters, no control characters or leading/trailing spaces.');
    }
    // hostapd's wpa_passphrase must be 8-63 characters (a 64-hex key goes in wpa_psk instead).
    if (!isValidPsk(ap_psk) || ap_psk.length > 63) {
        return res.status(400).send('Invalid PSK: 8-63 printable characters.');
    }
    console.log(`Setting up AP WiFi with SSID: ${JSON.stringify(ap_ssid)}`); // never log the PSK
    const HOSTAPD_CONF = '/etc/hostapd/hostapd.conf';
    // Read with sudo (like the old sed did) in case hostapd.conf isn't world-readable.
    execFile('sudo', ['cat', HOSTAPD_CONF], (readError, current) => {
        if (readError) {
            console.log(`Error reading ${HOSTAPD_CONF}: ${readError.message}`);
            return res.status(500).send(`Error reading ${HOSTAPD_CONF}: ${readError.message}`);
        }
        // Same edit the old sed did (replace the ssid= and wpa_passphrase= lines), done
        // in JS. Replacer functions keep $ in a value from being treated as a pattern.
        const updated = current
            .replace(/^ssid=.*$/m, () => `ssid=${ap_ssid}`)
            .replace(/^wpa_passphrase=.*$/m, () => `wpa_passphrase=${ap_psk}`);
        sudoWriteFile(HOSTAPD_CONF, updated, (error) => {
            if (error) {
                res.status(500).send(`Error setting up AP WiFi: ${error.message}`);
                console.log(`Error setting up AP WiFi: ${error.message}`);
            } else {
                res.send('AP WiFi setup successful!');
            }
        });
    });
});

// Reboot endpoint protected by token
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

// Check for updates protected by token
app.get('/check-for-updates', checkToken, (req, res) => {
    exec('git pull', { cwd: path.join(__dirname, '../') }, (error, stdout, stderr) => {
        if (error) {
            console.error(`Error during git pull: ${error.message}`);
            res.status(500).send(`Error during update: ${stderr}`);
        } else {
            console.log('Update successful: ' + stdout);
            res.send('Update successful: ' + stdout);
        }
    });
});

// Endpoint to check if casting is active
app.get('/check-casting-active', (req, res) => {
    const isActive = fs.existsSync(CASTING_ACTIVE_FILE);
    res.json({ isActive });
});

// Endpoint to check if `listening.disabled` exists without token
app.get('/check-listening-disabled', (req, res) => {
    const isDisabled = fs.existsSync(LISTENING_DISABLED_FILE);
    res.json({ isDisabled });
});

// Endpoint to toggle the `listening.disabled` file protected by token
app.post('/toggle-listening-disabled', checkToken, (req, res) => {
    const action = req.query.action;

    if (action === 'disable') {
        // Create the `listening.disabled` file
        fs.writeFileSync(LISTENING_DISABLED_FILE, 'External connections disabled');
        console.log('External connections disabled.');
        res.json({ success: true });
    } else if (action === 'enable') {
        // Remove the `listening.disabled` file
        if (fs.existsSync(LISTENING_DISABLED_FILE)) {
            fs.unlinkSync(LISTENING_DISABLED_FILE);
            console.log('External connections enabled.');
        }
        res.json({ success: true });
    } else {
        res.json({ success: false, message: 'Invalid action' });
    }
});

// --- Clock toggle using touch file ---
// Endpoint to check if `clock.enabled` exists without token
app.get('/check-clock-enabled', (req, res) => {
    const isEnabled = fs.existsSync(CLOCK_ENABLED_FILE);
    res.json({ isEnabled });
});

// Endpoint to toggle the `clock.enabled` file protected by token
app.post('/toggle-clock-enabled', checkToken, (req, res) => {
    const action = req.query.action;

    if (action === 'enable') {
        // Create the `clock.enabled` file
        fs.writeFileSync(CLOCK_ENABLED_FILE, 'Clock overlay enabled');
        console.log('Clock overlay enabled.');
        res.json({ success: true });
    } else if (action === 'disable') {
        // Remove the `clock.enabled` file
        if (fs.existsSync(CLOCK_ENABLED_FILE)) {
            fs.unlinkSync(CLOCK_ENABLED_FILE);
            console.log('Clock overlay disabled.');
        }
        res.json({ success: true });
    } else {
        res.json({ success: false, message: 'Invalid action' });
    }
});

app.use(express.static(path.join(__dirname, '../html')));

// Bind WebSocket server to HTTPS server
const wss = new WebSocket.Server({ server: httpsServer });
console.log('Secure WebSocket server started on wss://localhost:8443');

// Handle new WebSocket connections
wss.on('connection', function(ws, req) {
    // Check if the `listening.disabled` file exists
    if (fileExists(LISTENING_DISABLED_FILE)) {
        // If the file exists, only allow connections from localhost
        const clientIp = req.socket.remoteAddress;

        if (clientIp !== '::1' && clientIp !== '127.0.0.1') {
            console.log(`Rejected connection from ${clientIp} due to listening.disabled being present.`);
            ws.close(); // Close the WebSocket connection
            return;
        }
    }

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
            if (fs.existsSync(CASTING_ACTIVE_FILE)) {
                fs.unlinkSync(CASTING_ACTIVE_FILE);
            }
            distributeMessage(data, ws);
            break;
        case 'stream-playing':
            console.log('Stream playing message received:', data.data);
            fs.writeFileSync(CASTING_ACTIVE_FILE, 'Stream is active');
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
httpsServer.listen(8443, () => {
    console.log('HTTP and WebSocket server started on https://localhost:8443');
});

