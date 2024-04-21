const WebSocket = require('ws');
const wss = new WebSocket.Server({ port: 8080 });

console.log('WebSocket server started on ws://localhost:8080');

wss.on('connection', function(ws) {
    console.log('New client connected.');

    // Configure WebSocket connection to handle text messages
    ws.on('message', function(message) {
        console.log(`Received message: ${message}`);

        // Attempt to parse and validate the message
        try {
            const data = JSON.parse(message);
            if (!data.type || !data.data) {
                console.log('Invalid message format');
                // Optionally, send an error back to the client
                ws.send(JSON.stringify({ error: 'Invalid message format' }));
                return; // Skip forwarding if the message is not valid
            }

            // Forward the message to all other connected clients
            wss.clients.forEach(function each(client) {
                if (client !== ws && client.readyState === WebSocket.OPEN) {
                    console.log(`Forwarding message to another client: ${message}`);
                    client.send(message);
                }
            });
        } catch (e) {
            console.error('Error parsing message:', e);
            // Optionally, send an error back to the client
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


