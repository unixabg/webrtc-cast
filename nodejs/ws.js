const fs = require('fs');
const https = require('https');
const WebSocket = require('ws');
const { exec } = require('child_process');

// Load SSL certificate and private key from file system
const serverOptions = {
    cert: fs.readFileSync('cert.pem'),
    key: fs.readFileSync('key.pem')
};

// Create an HTTP server for serving HTML files
const httpsServer = https.createServer(serverOptions, (req, res) => {
  console.log(`Received request for: ${req.url}`);
  // Access query params using req.query directly (Express-like approach)
  const queryParams = new URLSearchParams(req.url.split('?')[1]);
  const url = req.url.split('?')[0];

  console.log('Full url is ', req.url);
  console.log('Base url is: ', url);

  if (url === '/wifi-setup') {
    const html = `
      <html>
        <body>
          <form action="/setup-wifi" method="get">
            <label for="ssid">SSID:</label>
            <input type="text" id="ssid" name="ssid"><br><br>
            <label for="psk">PSK:</label>
            <input type="password" id="psk" name="psk"><br><br>
            <input type="submit" value="Submit">
          </form>
        </body>
      </html>
    `;
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  } else if (url === '/setup-wifi') {
    // Set specific query params
    const ssid = queryParams.get('ssid');
    const psk = queryParams.get('psk');
    console.log(`Params: ${ssid} and ${psk}`);

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
         //res.writeHead(200, { 'Content-Type': 'text/plain' });
         //res.end('Wi-Fi configuration written successfully');
         const html = `
    <html>
      <head>
        <meta http-equiv="refresh" content="2; URL='/'" />
      </head>
      <body>
        <h1>Wi-Fi setup successful!</h1>
      </body>
    </html>
  `;
         res.writeHead(200, { 'Content-Type': 'text/html' });
         res.end(html);
         console.log('Wi-Fi configuration written successfully');
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
            //ws.send(JSON.stringify({ type: 'ping' }));
            break;
        case 'pong':
            console.log('Pong received, sending pong to clients.', data.data);
            distributeMessage(data, ws);
            break;
         case 'candidate':
            console.log('Candidate received, distributing to other clients.');
            distributeMessage(data, ws);
            break;
        case 'stream-stopped':
            console.log('Stream stopped message received:', data.data);
            // Notify all clients that the stream has been stopped.
            distributeMessage(data, ws);
            break;
        case 'stream-playing':
            console.log('Stream playing message received:', data.data);
            // Send this message back to the sender or handle it as needed
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
