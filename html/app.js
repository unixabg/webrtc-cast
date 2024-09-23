document.addEventListener('DOMContentLoaded', function() {
    const video = document.getElementById('localVideo');
    const connectionStatus = document.getElementById('connectionStatus');
    const toggleShareButton = document.getElementById('toggleShareButton');
    const toggleMuteButton = document.getElementById('toggleMuteButton');
    const diagnosticsContent = document.getElementById('diagnosticsContent');

    const peer = new RTCPeerConnection();

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.hostname;
    const port = window.location.port ? `:${window.location.port}` : '';
    const wsUrl = `${protocol}//${host}${port}`;
    const ws = new WebSocket(wsUrl);

    let pingPongFailure = false; // Flag to watch ping pong
    let isMuted = true; // Initially muted
    let isSharing = false; // Initially not sharing
    let currentStream; // To hold the stream
    let confirmationTimeout; // Declare the timeout variable globally
    let streamPlayingConfirmed = false; // Flag to track confirmation

    function logToDiagnostics(message) {
        const logEntry = document.createElement('div');
        logEntry.textContent = message;
        diagnosticsContent.appendChild(logEntry);
        diagnosticsContent.scrollTop = diagnosticsContent.scrollHeight;
    }

    ws.onopen = () => {
        logToDiagnostics('WebSocket connection established.');
        updateStatus('Connected', 'green');
        toggleShareButton.disabled = false;
        sendHeartbeat(ws);
    };

    ws.onerror = (event) => {
        logToDiagnostics('WebSocket Error: ' + event);
        updateStatus('Connection Error', 'red');
    };

    ws.onclose = () => {
        stopScreenSharing();
        logToDiagnostics('WebSocket connection closed.');
        updateStatus('Disconnected', 'red');
        toggleShareButton.disabled = true;
        toggleMuteButton.disabled = true;
    };

    ws.onmessage = function(event) {
        logToDiagnostics('WebSocket message received: ' + event.data);
        const message = JSON.parse(event.data);
        switch (message.type) {
            case 'stream-playing':
                logToDiagnostics('Confirmation received that stream is playing on the receiver side.');
                updateStreamingStatus('Stream is playing', 'green');
                streamPlayingConfirmed = true; // Set the confirmation flag to true
                clearTimeout(confirmationTimeout); // Clear the timeout
                toggleMuteButton.disabled = false;
                break;
            case 'answer':
                peer.setRemoteDescription(new RTCSessionDescription(message.data))
                    .then(() => logToDiagnostics('Answer received. Remote description successfully set.'))
                    .catch(error => {
                        logToDiagnostics('Failed to set remote description: ' + error);
                        updateStatus('SDP Error', 'red');
                    });
                break;
            case 'pong':
                pingPongFailure = false;
                logToDiagnostics('Clearing pong confirmationTimeout');
                clearTimeout(confirmationTimeout); // Cancel the timeout if pong response is received
                break;
        }
    };

    peer.ontrack = event => {
        video.srcObject = event.streams[0];
        logToDiagnostics('Stream added to local video.');
    };

    function updateStatus(text, color) {
        connectionStatus.textContent = `● ${text}`;
        connectionStatus.style.color = color;
    }

    function updateStreamingStatus(text, color) {
        const streamingStatus = document.getElementById('streamingStatus');
        streamingStatus.textContent = `● ${text}`;
        streamingStatus.style.color = color;
    }

    // Heartbeat function to ensure the WebSocket connection is alive
    function sendHeartbeat(ws) {
        setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'ping' }));
                logToDiagnostics('Sent ping to listening server');
                confirmationTimeout = setTimeout(() => {
                    logToDiagnostics('Pong response timed out. Assuming connection lost.');
                    pingPongFailure = true;
                    stopScreenSharing(); // Stop sharing the stream
                }, 10000); // 10 seconds
            } else {
                logToDiagnostics('Connection not open, cannot send heartbeat');
            }
        }, 5000); // Send heartbeat every 5 seconds
    }

    // Automatically start screen sharing when the page loads
    startScreenSharing();

    // Event listeners for buttons
    toggleShareButton.addEventListener('click', () => {
        if (isSharing) {
            stopScreenSharing();
        } else {
            startScreenSharing();
        }
    });

    toggleMuteButton.addEventListener('click', () => {
        logToDiagnostics(`${isMuted ? 'Unmute' : 'Mute'} button clicked.`);
        ws.send(JSON.stringify({ type: isMuted ? 'unmute-audio' : 'mute-audio' }));
        isMuted = !isMuted;
        toggleMuteButton.textContent = isMuted ? 'Unmute Audio' : 'Mute Audio';
    });

    function startScreenSharing(retryCount = 0) {
        const maxRetries = 3; // Maximum number of retries

        function handleRetryOrFailure() {
            if (retryCount < maxRetries) {
                logToDiagnostics(`Retry ${retryCount + 1} of ${maxRetries}`);
                startScreenSharing(retryCount + 1); // Retry the process
            } else {
                logToDiagnostics('Maximum retries reached. Stopping attempts.');
                updateStreamingStatus('Streaming failed', 'red');
                setTimeout(() => {
                    window.location.href = '/';
                }, 3000);
            }
        }

        function sendOffer(stream, retryCount) {
            stream.getTracks().forEach(track => {
                if (!peer.getSenders().some(sender => sender.track === track)) {
                    peer.addTrack(track, stream);
                }
            });

            peer.createOffer().then(offer => {
                return peer.setLocalDescription(offer);
            }).then(() => {
                logToDiagnostics('Sending offer: ' + peer.localDescription);
                ws.send(JSON.stringify({ type: 'offer', data: peer.localDescription }));
                setTimeout(() => {
                    if (!streamPlayingConfirmed) {
                        logToDiagnostics('No confirmation for stream playing received.');
                        handleRetryOrFailure();
                    }
                }, 5000); // Timeout set for 5 seconds
            }).catch(error => {
                logToDiagnostics('Error during offer creation or sending: ' + error);
                handleRetryOrFailure();
            });
        }

        if (retryCount === 0) { // Only prompt for the stream if it's the first attempt
            navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
                .then(stream => {
                    currentStream = stream;
                    video.srcObject = stream;

                    // Handle the browser UI stop action
                    stream.getTracks().forEach(track => {
                        track.onended = () => {
                            logToDiagnostics('User has stopped sharing through the browser UI.');
                            handleTrackEnd(); // Handle as if the stop button was clicked
                        };
                    });

                    sendOffer(stream, retryCount);
                })
                .catch(error => {
                    logToDiagnostics('Error obtaining display media: ' + error);
                    updateStatus('Setup Error', 'red');
                    toggleShareButton.disabled = false;
                    setTimeout(() => {
                        window.location.href = '/';
                    }, 3000);
                });
        } else {
            logToDiagnostics(`Retry ${retryCount} of ${maxRetries}`);
            sendOffer(currentStream, retryCount);
        }

        isSharing = true;
        toggleShareButton.textContent = 'Stop Sharing';
        toggleMuteButton.disabled = true; // Disable mute button until stream-playing confirmed
    }

    function stopScreenSharing() {
        if (video.srcObject) {
            const tracks = video.srcObject.getTracks(); // Get all tracks from the stream
            tracks.forEach(track => track.stop()); // Stop each track
            video.srcObject = null; // Clear the srcObject to release the stream
            logToDiagnostics('Screen sharing stopped.');
            updateStreamingStatus('Streaming stopped', 'red'); // Update streaming status on UI
        } else {
            logToDiagnostics('No stream to stop.');
        }

        // Reset UI components
        isSharing = false;
        toggleShareButton.textContent = 'Start Sharing';
        toggleShareButton.disabled = false;
        toggleMuteButton.disabled = true;

        if (pingPongFailure) {
            updateStatus('Network Error', 'red');
            updateStreamingStatus('Please reload the page to attempt new connection', 'red');
            toggleShareButton.disabled = true;
        } else {
            logToDiagnostics('Ping Pong Good.');
        }

        ws.send(JSON.stringify({ type: 'stream-stopped', data: 'Client has stopped the screen sharing.' }));

        streamPlayingConfirmed = false;

        ws.send(JSON.stringify({ type: 'listening-refresh', data: 'Stop screen sharing requesting a page refresh on a retry share attempt.' }));

        updateStreamingStatus('Streaming stopped. Page will reload...', 'red'); // Update streaming status on UI

        if (confirmationTimeout) {
            clearTimeout(confirmationTimeout);
            confirmationTimeout = null;
        }
        setTimeout(() => {
            window.location.href = '/';
            //window.location.reload(); // Refresh the page to handle reconnection
        }, 3000); // Delay the refresh to give users time to see the status update
    }

    function handleTrackEnd() {
        logToDiagnostics('Handling track end: Updating UI and signaling state change.');
        stopScreenSharing();
    }
});

