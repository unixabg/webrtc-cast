const fs = require('fs');
const https = require('https');
const WebSocket = require('ws');

// Load SSL certificate and private key from file system
const serverOptions = {
    cert: fs.readFileSync('cert.pem'),
    key: fs.readFileSync('key.pem')
};

// Create an HTTPS server using the loaded certificate and key
const httpsServer = https.createServer(serverOptions);
httpsServer.listen(8080, () => console.log('HTTPS and WebSocket server started on wss://localhost:8080'));

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

