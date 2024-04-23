document.addEventListener('DOMContentLoaded', function() {
    const video = document.getElementById('localVideo');
    const peer = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });

    const ws = new WebSocket('ws://ws-server:8080');
    ws.onopen = () => {
        console.log('WebSocket connection established.');
    };

    ws.onmessage = function(event) {
        console.log('WebSocket message received:', event.data);
        const message = JSON.parse(event.data);
        if (message.type === 'answer') {
            peer.setRemoteDescription(new RTCSessionDescription(message.data))
                .then(() => console.log('Remote description successfully set.'))
                .catch(error => console.error('Failed to set remote description:', error));
        } else if (message.type === 'candidate') {
            peer.addIceCandidate(new RTCIceCandidate(message.data))
                .then(() => console.log('ICE candidate successfully added.'))
                .catch(error => console.error('Failed to add ICE candidate:', error));
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


    function startScreenSharing() {
        navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
            .then(stream => {
                console.log('Display media obtained:', stream);
                video.srcObject = stream;
                stream.getTracks().forEach(track => {
                    console.log('Adding track:', track);
                    track.onended = () => {
                        console.log('Track ended:', track.kind);
                        stopScreenSharing(); // Call stop function when the track ends
                    };
                    peer.addTrack(track, stream);
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
            .catch(error => console.error('Error during screen sharing setup:', error));
    }


    function stopScreenSharing() {
        video.srcObject.getTracks().forEach(track => track.stop());
        console.log('Screen sharing stopped.');
        ws.send(JSON.stringify({ type: 'stream-stopped', data: 'Client has stopped the screen sharing.' }));
    }

    // Automatically start sharing when the page is ready
    startScreenSharing();
});

