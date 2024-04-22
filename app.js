const video = document.getElementById('localVideo');
const peer = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
});

// Setup WebSocket connection #replace ws-server with your ws-server#
const ws = new WebSocket('ws://ws-server:8080');
ws.onopen = () => {
    console.log('WebSocket connection established.');
};

ws.onmessage = function(event) {
    console.log('WebSocket message received:', event.data);
    if (event.data instanceof Blob) {
        // If the data is a Blob, we need to convert it to text before processing
        var reader = new FileReader();
        reader.onload = function() {
            console.log('Received Blob message converted to text:', reader.result);
            try {
                const jsonData = JSON.parse(reader.result);
                handleJsonData(jsonData);
            } catch (error) {
                console.error('Error parsing JSON from Blob:', error);
            }
        };
        reader.onerror = function() {
            console.error('Error reading Blob:', reader.error);
        };
        reader.readAsText(event.data);
    } else {
        // If the data is not a Blob, assume it is a JSON string
        try {
            const jsonData = JSON.parse(event.data);
            handleJsonData(jsonData);
        } catch (error) {
            console.error('Error parsing JSON:', error);
        }
    }
};

function handleJsonData(jsonData) {
    console.log('Processing received data:', jsonData);
    switch (jsonData.type) {
        case 'answer':
            peer.setRemoteDescription(new RTCSessionDescription(jsonData.data))
                .then(() => console.log('Remote description successfully set.'))
                .catch(error => console.error('Failed to set remote description:', error));
            break;
        case 'candidate':
            peer.addIceCandidate(new RTCIceCandidate(jsonData.data))
                .then(() => console.log('ICE candidate successfully added.'))
                .catch(error => console.error('Failed to add ICE candidate:', error));
            break;
    }
}

peer.onicecandidate = event => {
    console.log('ICE candidate event:', event);
    if (event.candidate) {
        ws.send(JSON.stringify({ type: 'candidate', data: event.candidate.toJSON() }));
        console.log('ICE candidate sent:', event.candidate);
    } else {
        console.log('No more ICE candidates will be found.');
    }
};

peer.oniceconnectionstatechange = () => {
    console.log('ICE Connection State Change:', peer.iceConnectionState);
};

peer.onconnectionstatechange = () => {
    console.log('Connection State Change:', peer.connectionState);
};

peer.onsignalingstatechange = () => {
    console.log('Signaling State Change:', peer.signalingState);
};

function startScreenSharing() {
    console.log('Attempting to start screen sharing...');
    navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
        .then(stream => {
            console.log('Screen sharing started.');
            video.srcObject = stream;
            stream.getTracks().forEach(track => {
                peer.addTrack(track, stream);
                track.onended = () => {
                    console.log('Screen sharing stopped by the user.');
                    ws.send(JSON.stringify({ type: 'info', data: 'Screen sharing stopped by the user.' }));
                };
            });
            createAndSendOffer();
        })
        .catch(error => {
            console.error('Failed to get display media:', error);
            ws.send(JSON.stringify({ type: 'error', data: 'Failed to start screen sharing.' }));
        });
}

function createAndSendOffer() {
    console.log('Creating offer...');
    peer.createOffer()
        .then(offer => {
            console.log('Offer created:', offer.sdp);
            return peer.setLocalDescription(offer);
        })
        .then(() => {
            const offerData = JSON.stringify({ type: 'offer', data: peer.localDescription.toJSON() });
            console.log('Sending offer:', offerData);
            ws.send(offerData);
        })
        .catch(error => {
            console.error('Error creating or sending offer:', error);
        });
}

document.addEventListener('DOMContentLoaded', () => {
    startScreenSharing();  // This can be attached to a button or automatically triggered
});

