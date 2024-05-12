document.addEventListener('DOMContentLoaded', function() {
    const video = document.getElementById('localVideo');
    const connectionStatus = document.getElementById('connectionStatus');
    const startButton = document.getElementById('startButton');
    const stopButton = document.getElementById('stopButton');

    const peer = new RTCPeerConnection();

    // Use the current hostname to dynamically create the WebSocket URL
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.hostname;
    const port = window.location.port ? `:${window.location.port}` : '';
    const wsUrl = `${protocol}//${host}${port}`;
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        console.log('WebSocket connection established.');
        updateStatus('Connected', 'green');
        startButton.disabled = false;
        sendHeartbeat(ws);
    };

    ws.onerror = (event) => {
        console.error('WebSocket Error:', event);
        updateStatus('Connection Error', 'red');
    };

    ws.onclose = () => {
        stopScreenSharing();
        console.log('WebSocket connection closed.');
        updateStatus('Disconnected', 'red');
        startButton.disabled = true;
        stopButton.disabled = true;
    };

    let confirmationTimeout; // Declare the timeout variable globally
    let streamPlayingConfirmed = false; // Flag to track confirmation
    ws.onmessage = function(event) {
        console.log('WebSocket message received:', event.data);
        const message = JSON.parse(event.data);
        switch (message.type) {
            case 'stream-playing':
                console.log('Confirmation received that stream is playing on the receiver side.');
                updateStreamingStatus('Stream is playing', 'green');
                streamPlayingConfirmed = true; // Set the confirmation flag to true
                clearTimeout(confirmationTimeout); // Clear the timeout
                break;
            case 'answer':
                peer.setRemoteDescription(new RTCSessionDescription(message.data))
                    .then(() => console.log('Remote description successfully set.'))
                    .catch(error => {
                        console.error('Failed to set remote description:', error);
                        updateStatus('SDP Error', 'red');
                    });
                break;
            case 'candidate':
                peer.addIceCandidate(new RTCIceCandidate(message.data))
                    .then(() => console.log('ICE candidate successfully added.'))
                    .catch(error => {
                        console.error('Failed to add ICE candidate:', error);
                        updateStatus('ICE Error', 'red');
                    });
                break;
            case 'pong':
                console.log(message.data);
                clearTimeout(confirmationTimeout); // Cancel the timeout if pong response is received
                break;
        }
    };

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

    function updateStatus(text, color) {
        connectionStatus.textContent = `● ${text}`;
        connectionStatus.style.color = color;
    }

    // Heartbeat function to ensure the WebSocket connection is alive
    function sendHeartbeat(ws) {
      setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping' }));
          console.log('Sent ping to server');
          confirmationTimeout = setTimeout(() => {
            console.log('Pong response timed out. Assuming connection lost.');
            stopScreenSharing(); // Stop sharing the stream
          }, 60000); // 60 seconds
        } else {
          console.log('Connection not open, cannot send heartbeat');
        }
      }, 30000); // Send heartbeat every 30 seconds
    }

    // Event listeners for buttons
    startButton.addEventListener('click', () => {
        startScreenSharing();
        startButton.disabled = true;
        stopButton.disabled = false;
    });

    stopButton.addEventListener('click', () => {
        stopScreenSharing();
    });

    function updateStreamingStatus(text, color) {
        const streamingStatus = document.getElementById('streamingStatus');
        streamingStatus.textContent = `● ${text}`;
        streamingStatus.style.color = color;
    }

    function startScreenSharing() {
        navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
            .then(stream => {
                console.log('Display media obtained:', stream);
                video.srcObject = stream;
                // Start the timer as soon as the stream starts
                const confirmationTimeout = setTimeout(() => {
                    if (!streamPlayingConfirmed) {
                        console.error('No confirmation for stream playing received.');
                        handleTrackEnd(); // Stop the streaming
                        updateStreamingStatus('No confirmation received, streaming stopped', 'red');
                    }
                }, 10000); // Timeout set for 10 seconds

                stream.getTracks().forEach(track => {
                    console.log('Adding track:', track);
                    peer.addTrack(track, stream);
                    track.onended = () => {
                        console.log('Track ended:', track.kind);
                        handleTrackEnd();
                    };
                });
                return peer.createOffer();
            })
            .then(offer => {
                console.log('Offer created:', offer);
                return peer.setLocalDescription(offer);
            })
            .then(() => {
                console.log('Sending offer:', peer.localDescription);
                ws.send(JSON.stringify({ type: 'offer', data: peer.localDescription }));
            })
            .catch(error => {
                console.error('Error during screen sharing setup:', error);
                updateStatus('Setup Error', 'red');
                updateStreamingStatus('Streaming failed', 'red');
                setTimeout(() => {
                    updateStatus('Connected', 'green');
                }, 3000);
                startButton.disabled = false;
                stopButton.disabled = true;
            });
    }

    function stopScreenSharing() {
        if (video.srcObject) {
            video.srcObject.getTracks().forEach(track => track.stop());
            updateStreamingStatus('Streaming stopped', 'red'); // Update streaming status
        }
        console.log('Screen sharing stopped.');
        ws.send(JSON.stringify({ type: 'stream-stopped', data: 'Client has stopped the screen sharing.' }));
        startButton.disabled = false;
        stopButton.disabled = true;
    }

    function handleTrackEnd() {
        console.log('Handling track end: Updating UI and signaling state change.');
        document.getElementById('startButton').disabled = false;
        document.getElementById('stopButton').disabled = true;
        stopScreenSharing();
    }
});

