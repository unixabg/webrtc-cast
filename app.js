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
    if (event.data instanceof Blob) {
        const reader = new FileReader();
        reader.onload = function() {
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
    if (jsonData.type === 'answer') {
        console.log('Received answer:', jsonData);
        peer.setRemoteDescription(new RTCSessionDescription(jsonData.data))
            .then(() => console.log('Remote description successfully set.'))
            .catch(error => console.error('Failed to set remote description', error));
    } else if (jsonData.type === 'candidate') {
        console.log('Received ICE candidate:', jsonData);
        peer.addIceCandidate(new RTCIceCandidate(jsonData.data))
            .then(() => console.log('ICE candidate successfully added.'))
            .catch(error => console.error('Failed to add ICE candidate', error));
    }
}

peer.onicecandidate = event => {
    if (event.candidate) {
        console.log('Found ICE candidate:', event.candidate);
        ws.send(JSON.stringify({ type: 'candidate', data: event.candidate.toJSON() }));
    } else {
        console.log('No more ICE candidates will be found.');
    }
};

peer.oniceconnectionstatechange = () => {
    console.log('ICE Connection State Change:', peer.iceConnectionState);
    if (peer.iceConnectionState === 'failed') {
        console.error('ICE Connection has failed.');
    }
};

peer.onconnectionstatechange = () => {
    console.log('Connection State Change:', peer.connectionState);
    if (peer.connectionState === 'connected') {
        console.log('Peer connection fully established.');
    }
};

peer.onsignalingstatechange = () => {
    console.log('Signaling State Change:', peer.signalingState);
};

// Function to start screen sharing
function startScreenSharing() {
    console.log('Attempting to start screen sharing...');
    navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
        .then(stream => {
            console.log('Screen sharing started.');
            video.srcObject = stream;
            stream.getTracks().forEach(track => peer.addTrack(track, stream));
            createAndSendOffer();
        })
        .catch(error => {
            console.error('Failed to get display media', error);
        });
}

// Create and send an offer to the peer
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
            console.error('Error creating or sending offer', error);
        });
}

// Optionally, you can add UI buttons or other mechanisms to start screen sharing
document.addEventListener('DOMContentLoaded', () => {
    startScreenSharing();  // Or attach to a button click event
});

