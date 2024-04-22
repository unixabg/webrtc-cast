const WebSocket = require('ws');
const wss = new WebSocket.Server({ port: 8080 });

console.log('WebSocket server started on ws://localhost:8080');

wss.on('connection', function(ws) {
    console.log('New client connected.');

    // Configure WebSocket connection to handle text messages
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

    ws.on('close', () => {
        console.log('Client has disconnected.');
    });

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

