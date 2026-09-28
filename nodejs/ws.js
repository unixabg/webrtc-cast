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
const validTokens = new Map(); // token -> expiry time (ms), kept in memory
const TOKEN_LIFETIME_MS = 8 * 60 * 60 * 1000; // setup logins last 8 hours
const MAX_LOGIN_FAILURES = 5; // failed logins allowed per IP before a lockout
const LOGIN_LOCKOUT_MS = 5 * 60 * 1000; // lockout length after too many failures
const loginFailures = new Map(); // ip -> { count, lockedUntil }
const DEFAULT_PASSWORD = 'webrtc-cast'; // what ships in password.txt

function isTokenValid(token) {
    if (!token || !validTokens.has(token)) {
        return false;
    }
    if (Date.now() > validTokens.get(token)) {
        validTokens.delete(token); // expired
        return false;
    }
    return true;
}

// Compare passwords in constant time (hash first so lengths match).
function passwordMatches(entered, actual) {
    const a = crypto.createHash('sha256').update(String(entered)).digest();
    const b = crypto.createHash('sha256').update(String(actual)).digest();
    return crypto.timingSafeEqual(a, b);
}
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

// Warn if the setup password is still the one published in the repository.
try {
    if (fs.readFileSync(PASSWORD_FILE, 'utf8').trim() === DEFAULT_PASSWORD) {
        console.warn(`WARNING: ${PASSWORD_FILE} still has the default setup password. Change it.`);
    }
} catch (err) {
    console.warn(`WARNING: could not read ${PASSWORD_FILE}: ${err.message}`);
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
    if (isTokenValid(token)) {
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
    const clientIp = req.socket.remoteAddress;
    const failures = loginFailures.get(clientIp);
    if (failures && failures.lockedUntil > Date.now()) {
        const minutes = Math.ceil((failures.lockedUntil - Date.now()) / 60000);
        console.log(`Login blocked for ${clientIp}: too many failed attempts.`);
        return res.status(429).send(`Too many failed logins. Try again in ${minutes} minute(s).`);
    }

    const password = fs.readFileSync(PASSWORD_FILE, 'utf8').trim();
    const enteredPassword = req.body.password;

    if (enteredPassword && passwordMatches(enteredPassword, password)) {
        loginFailures.delete(clientIp);
        const token = crypto.randomBytes(16).toString('hex');
        validTokens.set(token, Date.now() + TOKEN_LIFETIME_MS);
        console.log('Login successful, token generated');
        res.json({ token });
    } else {
        // Start counting again once a previous lockout has run out.
        const previous = (failures && !failures.lockedUntil) ? failures.count : 0;
        const count = previous + 1;
        const lockedUntil = count >= MAX_LOGIN_FAILURES ? Date.now() + LOGIN_LOCKOUT_MS : 0;
        loginFailures.set(clientIp, { count, lockedUntil });
        console.log(`Login failed from ${clientIp} (${count}/${MAX_LOGIN_FAILURES})`);
        res.status(401).send('Unauthorized: You must provide the correct password.');
    }
});

// Check token validity
app.get('/check-token', (req, res) => {
    const token = req.headers['x-token'];
    if (isTokenValid(token)) {
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

// --- Wi-Fi station and access point -------------------------------------
// The access point is installed and configured by contrib/ap-setup.sh; the
// setup page only shows its status. The station (the unit's own Wi-Fi
// connection) is an ifupdown stanza for the station card, applied right away.

const AP_CONFIG_FILE = '/etc/default/webrtc-cast-ap';
const AP_SETUP_TOOL = '/usr/local/sbin/webrtc-cast-ap';

function isValidIfname(name) {
    return typeof name === 'string' && /^[A-Za-z0-9_.-]{1,15}$/.test(name);
}

// The server runs as the kiosk user, whose PATH has no /usr/sbin (iw, ifup
// and friends live there), so give the tools we run a full system PATH.
const SYSTEM_ENV = { ...process.env, PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' };

// execFile as a promise; never rejects.
function runFile(cmd, args, timeout = 15000) {
    return new Promise(resolve => {
        execFile(cmd, args, { timeout, maxBuffer: 1024 * 1024, env: SYSTEM_ENV }, (error, stdout, stderr) => {
            resolve({ ok: !error, stdout: stdout || '', stderr: stderr || '', error });
        });
    });
}

// /etc/default/webrtc-cast-ap (KEY=VALUE lines) or null when no AP is installed.
function readApConfig() {
    let text;
    try {
        text = fs.readFileSync(AP_CONFIG_FILE, 'utf8');
    } catch (err) {
        return null;
    }
    const cfg = {};
    for (const line of text.split('\n')) {
        const m = line.match(/^([A-Z_]+)=(.*)$/);
        if (m) cfg[m[1]] = m[2].trim();
    }
    return cfg;
}

function wirelessIfaces() {
    try {
        return fs.readdirSync('/sys/class/net').filter(name =>
            isValidIfname(name) &&
            (fs.existsSync(`/sys/class/net/${name}/wireless`) || fs.existsSync(`/sys/class/net/${name}/phy80211`)));
    } catch (err) {
        return [];
    }
}

// The card the station uses: the shared card in --shared mode, otherwise a
// Wi-Fi card that isn't the AP (e.g. the built-in card next to a USB AP card).
function stationIface(cfg) {
    if (cfg && cfg.MODE === 'shared') {
        return isValidIfname(cfg.IFACE) ? cfg.IFACE : null;
    }
    const apIface = cfg ? cfg.AP_IFACE : null;
    return wirelessIfaces().find(name => name !== apIface) || null;
}

function stationConfigPath(iface) {
    return `/etc/network/interfaces.d/${iface}`;
}

function freqToChannel(freq) {
    const f = Math.round(Number(freq));
    if (f === 2484) return 14;
    if (f >= 2412 && f <= 2472) return (f - 2407) / 5;
    if (f >= 5000 && f < 5925) return (f - 5000) / 5;
    return null;
}

function bandOf(freq) {
    const f = Number(freq);
    return f < 3000 ? '2.4 GHz' : (f < 5925 ? '5 GHz' : '6 GHz');
}

// iw prints unprintable SSID bytes as \xNN
function decodeIwSsid(s) {
    return s.replace(/\\x([0-9a-fA-F]{2})/g, (m, hex) => String.fromCharCode(parseInt(hex, 16)));
}

async function stationLink(iface) {
    const r = await runFile('iw', ['dev', iface, 'link']);
    const ssid = (r.stdout.match(/^\s*SSID: (.*)$/m) || [])[1];
    const freq = (r.stdout.match(/^\s*freq: ([0-9.]+)/m) || [])[1];
    if (!r.ok || !freq) return { connected: false };
    return { connected: true, ssid: ssid ? decodeIwSsid(ssid) : '', band: bandOf(freq), channel: freqToChannel(freq) };
}

async function ipv4Of(iface) {
    const r = await runFile('ip', ['-4', '-o', 'addr', 'show', 'dev', iface]);
    return (r.stdout.match(/inet ([0-9.]+\/[0-9]+)/) || [])[1] || '';
}

// Run a station change detached from this server (via systemd-run), so it
// finishes even though the AP (and maybe this page's connection) goes away.
// $1 = station card, $2 = 1 when the AP shares the card and must be paused.
function startStationJob(name, script, iface, shared) {
    const unit = `webrtc-cast-${name}-${Date.now()}`;
    execFile('sudo', ['systemd-run', '--collect', '--quiet', '--unit', unit, '--',
        '/bin/sh', '-c', script, 'sh', iface, shared ? '1' : '0'], { env: SYSTEM_ENV }, (error) => {
        if (error) console.error(`Failed to start ${unit}: ${error.message}`);
        else console.log(`Started ${unit} for ${iface}.`);
    });
}

const STATION_CONNECT_SCRIPT =
    'ifdown --force "$1" >/dev/null 2>&1; ' +
    'if [ "$2" = 1 ]; then systemctl stop hostapd; fi; ' +
    'timeout 60 ifup "$1"; rc=$?; ' +
    // hostapd picks its channel from the station's when it starts (ap-setup.sh)
    'if [ "$2" = 1 ]; then systemctl start hostapd; fi; ' +
    'exit $rc';

const STATION_FORGET_SCRIPT =
    'ifdown --force "$1" >/dev/null 2>&1; ' +
    'rm -f "/etc/network/interfaces.d/$1"; ' +
    'if [ "$2" = 1 ]; then systemctl restart hostapd; fi; ' +
    'exit 0';

// In --shared mode the station and the AP use one radio. Keeping the station on
// channels where the AP may also run lets them share one channel; otherwise the
// radio time-slices, which drops AP clients on some cards (contrib/wifi-cards.md).
// Returns the allowed frequencies (MHz), or null when there's no restriction.
async function apShareableFreqs(cfg) {
    if (!cfg || cfg.MODE !== 'shared') return null;
    const tool = fs.existsSync(AP_SETUP_TOOL) ? AP_SETUP_TOOL : path.join(__dirname, '../contrib/ap-setup.sh');
    const r = await runFile('bash', [tool, 'ap-freqs']);
    const freqs = r.stdout.trim().split(/\s+/).filter(f => /^[0-9]{4}$/.test(f)).map(Number);
    return freqs.length ? freqs : null;
}

// Access point status (read-only)
app.get('/ap-status', checkToken, async (req, res) => {
    const cfg = readApConfig();
    if (!cfg) {
        return res.json({ installed: false });
    }
    const apIface = isValidIfname(cfg.AP_IFACE) ? cfg.AP_IFACE : '';
    const conf = (await runFile('sudo', ['cat', '/etc/hostapd/hostapd.conf'])).stdout;
    const confValue = key => ((conf.match(new RegExp(`^${key}=(.*)$`, 'm')) || [])[1] || '').trim();
    const services = {};
    const active = await runFile('systemctl', ['is-active', 'webrtc-cast-ap', 'hostapd', 'dnsmasq']);
    ['webrtc-cast-ap', 'hostapd', 'dnsmasq'].forEach((name, i) => {
        services[name] = (active.stdout.split('\n')[i] || 'unknown').trim();
    });
    let channel = null, band = '', clients = null;
    if (apIface) {
        const info = await runFile('iw', ['dev', apIface, 'info']);
        const m = info.stdout.match(/channel (\d+) \(([0-9.]+) MHz\)/);
        if (m) {
            channel = Number(m[1]);
            band = bandOf(m[2]);
        }
        const dump = await runFile('sudo', ['iw', 'dev', apIface, 'station', 'dump']);
        if (dump.ok) clients = (dump.stdout.match(/^Station /gm) || []).length;
    }
    let names = [];
    try {
        const dns = fs.readFileSync('/etc/dnsmasq.d/webrtc-cast-ap.conf', 'utf8');
        names = [...dns.matchAll(/^address=\/([^/]+)\//gm)].map(m => m[1]);
    } catch (err) { /* not readable: leave empty */ }
    res.json({
        installed: true,
        mode: cfg.MODE || '',
        card: cfg.IFACE || '',
        apIface,
        address: cfg.AP_ADDRESS || '',
        forward: cfg.FORWARD === '1',
        ssid: confValue('ssid'),
        channel,
        band,
        configuredChannel: confValue('channel'),
        services,
        clients,
        names
    });
});

// Plain-text card report from ap-setup.sh check (for screenshots / support)
app.get('/ap-card-report', checkToken, async (req, res) => {
    const cfg = readApConfig();
    const iface = cfg && isValidIfname(cfg.IFACE) ? cfg.IFACE : (wirelessIfaces()[0] || '');
    if (!iface) {
        return res.type('text/plain').send('No Wi-Fi card found.');
    }
    const tool = fs.existsSync(AP_SETUP_TOOL) ? AP_SETUP_TOOL : path.join(__dirname, '../contrib/ap-setup.sh');
    const args = [tool, 'check', '--iface', iface];
    if (!cfg || cfg.MODE === 'shared') args.push('--shared');
    const r = await runFile('bash', args, 30000);
    res.type('text/plain').send((r.stdout + r.stderr).trim() || 'The card check produced no output.');
});

// Station status
app.get('/station-status', checkToken, async (req, res) => {
    const cfg = readApConfig();
    const iface = stationIface(cfg);
    if (!iface) {
        return res.json({
            available: false,
            reason: cfg && cfg.MODE === 'dedicated'
                ? 'The Wi-Fi card is used only for the access point (dedicated mode).'
                : 'No Wi-Fi card found.'
        });
    }
    const saved = (await runFile('sudo', ['cat', stationConfigPath(iface)])).stdout;
    const configuredSsid = ((saved.match(/^\s*wpa-ssid (.*)$/m) || [])[1] || '').trim();
    const link = await stationLink(iface);
    res.json({
        available: true,
        iface,
        sharedWithAp: !!(cfg && cfg.MODE === 'shared'),
        configuredSsid,
        ...link,
        ip: link.connected ? await ipv4Of(iface) : ''
    });
});

// Nearby networks for the station card
app.get('/station-scan', checkToken, async (req, res) => {
    const cfg = readApConfig();
    const iface = stationIface(cfg);
    if (!iface) {
        return res.status(400).json({ error: 'No Wi-Fi card is available for the station.' });
    }
    await runFile('sudo', ['ip', 'link', 'set', 'dev', iface, 'up']);
    let r = await runFile('sudo', ['iw', 'dev', iface, 'scan'], 25000);
    let cached = false;
    if (!r.ok) {
        // e.g. busy while the AP runs on the same radio: use the last results
        r = await runFile('sudo', ['iw', 'dev', iface, 'scan', 'dump'], 10000);
        cached = true;
    }
    const best = new Map();
    for (const block of r.stdout.split(/^BSS /m).slice(1)) {
        const ssidRaw = (block.match(/^\s*SSID: (.*)$/m) || [])[1];
        const freq = (block.match(/^\s*freq: ([0-9.]+)/m) || [])[1];
        const signal = Number((block.match(/^\s*signal: (-?[0-9.]+)/m) || [])[1]);
        if (!ssidRaw || !freq) continue; // hidden network or incomplete entry
        const ssid = decodeIwSsid(ssidRaw);
        const entry = { ssid, freq: Math.round(Number(freq)), band: bandOf(freq), channel: freqToChannel(freq), signal: Number.isFinite(signal) ? Math.round(signal) : null };
        const key = `${ssid}|${entry.band}`;
        if (!best.has(key) || (entry.signal ?? -999) > (best.get(key).signal ?? -999)) best.set(key, entry);
    }
    const networks = [...best.values()].sort((a, b) => (b.signal ?? -999) - (a.signal ?? -999));
    const allowed = await apShareableFreqs(cfg);
    networks.forEach(net => { net.apShareable = !allowed || allowed.includes(net.freq); });
    res.json({ networks, cached, restricted: !!allowed, error: !r.ok ? 'Scan failed; type the network name instead.' : '' });
});

// Save the station network and connect now
app.post('/station-connect', checkToken, async (req, res) => {
    const { ssid, psk } = req.body || {};
    if (!isValidSsid(ssid)) {
        return res.status(400).json({ error: 'Invalid network name: 1-32 characters, no control characters or leading/trailing spaces.' });
    }
    if (!isValidPsk(psk)) {
        return res.status(400).json({ error: 'Invalid password: 8-63 printable characters, or a 64-digit hex key.' });
    }
    const cfg = readApConfig();
    const iface = stationIface(cfg);
    if (!iface) {
        return res.status(400).json({ error: 'No Wi-Fi card is available for the station.' });
    }
    const shared = !!(cfg && cfg.MODE === 'shared');
    console.log(`Station ${iface}: connecting to ${JSON.stringify(ssid)}`); // never log the password
    const lines = [
        `allow-hotplug ${iface}`,
        `iface ${iface} inet dhcp`,
        `    wpa-ssid ${ssid}`,
        `    wpa-psk ${psk}`
    ];
    const allowed = await apShareableFreqs(cfg);
    if (allowed) {
        // keep the station where the shared AP can follow it (one channel, no time-slicing)
        lines.push(`    wpa-freq-list ${allowed.join(' ')}`);
    }
    lines.push('');
    const config = lines.join('\n');
    const file = stationConfigPath(iface);
    sudoWriteFile(file, config, async (error) => {
        if (error) {
            console.log(`Error writing ${file}: ${error.message}`);
            return res.status(500).json({ error: `Error saving the station settings: ${error.message}` });
        }
        await runFile('sudo', ['chmod', '600', file]); // it holds the Wi-Fi password
        res.json({ ok: true, sharedWithAp: shared });
        // Give the response a moment to reach the browser before the AP pauses.
        setTimeout(() => startStationJob('station-connect', STATION_CONNECT_SCRIPT, iface, shared), 1000);
    });
});

// Forget the station network
app.post('/station-forget', checkToken, (req, res) => {
    const cfg = readApConfig();
    const iface = stationIface(cfg);
    if (!iface) {
        return res.status(400).json({ error: 'No Wi-Fi card is available for the station.' });
    }
    const shared = !!(cfg && cfg.MODE === 'shared');
    console.log(`Station ${iface}: forgetting the saved network`);
    res.json({ ok: true, sharedWithAp: shared });
    setTimeout(() => startStationJob('station-forget', STATION_FORGET_SCRIPT, iface, shared), 1000);
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

