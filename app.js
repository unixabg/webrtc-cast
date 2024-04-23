document.addEventListener('DOMContentLoaded', function() {
    const video = document.getElementById('localVideo');
    const connectionStatus = document.getElementById('connectionStatus');
    const startButton = document.getElementById('startButton');
    const stopButton = document.getElementById('stopButton');

    // Configure the RTCPeerConnection with Google's public STUN server
    const peer = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });

    let ws;
    let timeoutHandle;  // Define a variable to store the timeout handle

    function initializeWebSocket() {
        console.log('Attempting to establish WebSocket connection...');
        ws = new WebSocket('ws://ws-server:8080');

        ws.onopen = () => {
            console.log('WebSocket connection established.');
            clearTimeout(timeoutHandle);  // Clear the timeout on successful connection
            updateStatus('Connected', 'green');
            startButton.disabled = false;
        };

        ws.onerror = error => {
            console.error('WebSocket error:', error);
            updateStatus('WebSocket Error', 'red');
        };

        ws.onclose = () => {
            console.log('WebSocket connection closed.');
            updateStatus('Disconnected', 'red');
            startButton.disabled = true;
            stopButton.disabled = true;
        };

        // Setup a timeout to check connection status
        timeoutHandle = setTimeout(() => {
            if (ws.readyState !== WebSocket.OPEN) {
                console.error('Connection attempt timed out.');
                updateStatus('Connection Timed Out', 'orange');
                // Delay closing the WebSocket and updating the status to 'Disconnected'
                setTimeout(() => {
                    if (ws.readyState !== WebSocket.CLOSED) {
                        ws.close();  // Close the socket after showing the timeout message
                    }
                    // Update to 'Disconnected' only if the socket is not already closed
                    if (ws.readyState === WebSocket.CLOSED) {
                        updateStatus('Disconnected', 'red');
                    }
                }, 3000);  // 3 seconds delay before executing the close and final status update
            }
        }, 10000);  // 10 seconds timeout to initially detect the failure
    }

    function updateStatus(text, color) {
        connectionStatus.textContent = `● ${text}`;
        connectionStatus.style.color = color;
    }

    peer.onicecandidate = event => {
        if (event.candidate) {
            ws.send(JSON.stringify({ type: 'candidate', data: event.candidate }));
            console.log('ICE candidate sent:', event.candidate);
        } else {
            console.log('No more ICE candidates.');
        }
    };

    peer.ontrack = event => {
        video.srcObject = event.streams[0];
        console.log('Stream added to local video.');
    };

    startButton.addEventListener('click', () => {
        startScreenSharing();
        startButton.disabled = true;
        stopButton.disabled = false;
    });

    stopButton.addEventListener('click', () => {
        stopScreenSharing();
        startButton.disabled = false;
        stopButton.disabled = true;
    });

    function startScreenSharing() {
        navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
            .then(stream => {
                video.srcObject = stream;
                stream.getTracks().forEach(track => {
                    peer.addTrack(track, stream);
                });
                return peer.createOffer();
            })
            .then(offer => peer.setLocalDescription(offer))
            .then(() => ws.send(JSON.stringify({ type: 'offer', data: peer.localDescription })))
            .catch(error => {
                console.error('Error during screen sharing setup:', error);
                updateStatus('Setup Error', 'red');
            });
    }

    function stopScreenSharing() {
        if (video.srcObject) {
            video.srcObject.getTracks().forEach(track => track.stop());
            video.srcObject = null;
        }
        ws.send(JSON.stringify({ type: 'stream-stopped' }));
        updateStatus('Stopped', 'red');
    }

    initializeWebSocket();
});

