let peer = null;
let localStream = null;
let currentCall = null;
let callDurationTimer = null;
let callStartTime = null;
let isMuted = false;
let isVideoOn = false;
let peerInitialized = false;

function initPeer() {
  if (peer) return;
  const peerId = 'user-' + window.currentUserId;
  const isHttps = window.location.protocol === 'https:';

  peer = new Peer(peerId, {
    host: window.location.hostname,
    port: isHttps ? 9000 : 9000,      // PeerJS tourne sur 9000 dans les deux cas
    path: '/peerjs',
    secure: isHttps,                  // ← important : HTTPS si l'app est en HTTPS
    debug: 2,
  });

  peer.on('open', (id) => {
    console.log('PeerJS connected:', id);
    peerInitialized = true;

    peer.on('call', (call) => {
      if (localStream) {
        call.answer(localStream);
        handleCall(call);
      } else {
        navigator.mediaDevices.getUserMedia({ audio: true, video: false })
          .then((stream) => {
            localStream = stream;
            call.answer(stream);
            handleCall(call);
          })
          .catch((err) => {
            console.error('Cannot answer call:', err);
            call.close();
          });
      }
    });
  });

  peer.on('error', (err) => {
    console.error('PeerJS error:', err);
  });
}



initPeer();

// ==================== OUTGOING CALLS ====================
const callAudioBtn = document.getElementById('callAudioBtn');
const callVideoBtn = document.getElementById('callVideoBtn');

if (callAudioBtn) callAudioBtn.addEventListener('click', () => startCall('audio'));
if (callVideoBtn) callVideoBtn.addEventListener('click', () => startCall('video'));

async function startCall(callType) {
  if (!window.activeConversationId) return;
  initPeer();

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: callType === 'video',
    });
    localStream = stream;
    isVideoOn = callType === 'video';

    const callModal = document.getElementById('callModal');
    callModal.style.display = 'flex';
    document.getElementById('callTitle').textContent = callType === 'video' ? 'Appel vidéo' : 'Appel audio';
    document.getElementById('callStatus').textContent = 'Appel en cours...';

    if (isVideoOn) {
      const localVideo = document.getElementById('localVideo');
      localVideo.srcObject = stream;
      localVideo.style.display = 'block';
    }

    socket.emit('call:initiate', {
      conversationId: window.activeConversationId,
      callType,
      peerId: peer.id,
    });

    startCallTimer();
  } catch (err) {
    console.error('Call error:', err);
    alert("Impossible d'accéder à la caméra/microphone");
  }
}

// ==================== INCOMING CALLS ====================
socket.on('call:incoming', (data) => {
  const modal = document.getElementById('incomingCallModal');
  modal.style.display = 'flex';
  document.getElementById('incomingCallTitle').textContent = data.callType === 'video' ? 'Appel vidéo entrant' : 'Appel audio entrant';
  document.getElementById('incomingCallStatus').textContent = 'Appel entrant...';
  window.incomingCallData = data;
});

const acceptCallBtn = document.getElementById('acceptCallBtn');
const rejectCallBtn = document.getElementById('rejectCallBtn');

if (acceptCallBtn) {
  acceptCallBtn.addEventListener('click', async () => {
    const data = window.incomingCallData;
    if (!data) return;

    document.getElementById('incomingCallModal').style.display = 'none';
    const callModal = document.getElementById('callModal');
    callModal.style.display = 'flex';
    document.getElementById('callTitle').textContent = data.callType === 'video' ? 'Appel vidéo' : 'Appel audio';

    initPeer();

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: data.callType === 'video',
      });
      localStream = stream;
      isVideoOn = data.callType === 'video';

      if (isVideoOn) {
        const localVideo = document.getElementById('localVideo');
        localVideo.srcObject = stream;
        localVideo.style.display = 'block';
      }

      socket.emit('call:accept', {
        callId: data.callId,
        conversationId: data.conversationId,
        peerId: peer.id,
      });

      startCallTimer();
    } catch (err) {
      console.error('Accept call error:', err);
      endCall();
    }
  });
}

if (rejectCallBtn) {
  rejectCallBtn.addEventListener('click', () => {
    const data = window.incomingCallData;
    if (data) {
      socket.emit('call:reject', { callId: data.callId, conversationId: data.conversationId });
    }
    document.getElementById('incomingCallModal').style.display = 'none';
  });
}

// ==================== CALL ACCEPTED ====================
socket.on('call:accepted', (data) => {
  document.getElementById('callStatus').textContent = 'Connecté';
  if (peer && localStream && data.userId) {
    const remotePeerId = 'user-' + data.userId;
    const call = peer.call(remotePeerId, localStream);
    if (call) handleCall(call);
  }
});

function handleCall(call) {
  currentCall = call;
  call.on('stream', (remoteStream) => {
    const remoteVideos = document.getElementById('remoteVideos');
    remoteVideos.innerHTML = '';
    const video = document.createElement('video');
    video.srcObject = remoteStream;
    video.autoplay = true;
    video.playsInline = true;
    video.className = 'remote-video';
    remoteVideos.appendChild(video);
    document.getElementById('callStatus').textContent = 'En communication';
  });
  call.on('close', () => {
    document.getElementById('callStatus').textContent = 'Appel terminé';
  });
}

// ==================== CONTROLS ====================
const hangupBtn = document.getElementById('hangupBtn');
if (hangupBtn) hangupBtn.addEventListener('click', endCall);

function endCall() {
  if (currentCall) { try { currentCall.close(); } catch (e) {} currentCall = null; }
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  stopCallTimer();
  const callModal = document.getElementById('callModal');
  if (callModal) callModal.style.display = 'none';
  const localVideo = document.getElementById('localVideo');
  if (localVideo) localVideo.style.display = 'none';
  const remoteVideos = document.getElementById('remoteVideos');
  if (remoteVideos) remoteVideos.innerHTML = '';

  const duration = callStartTime ? Math.floor((Date.now() - callStartTime) / 1000) : 0;
  if (window.activeConversationId) {
    socket.emit('call:end', {
      conversationId: window.activeConversationId,
      callId: window.incomingCallData?.callId,
      duration,
    });
  }
}

const muteBtn = document.getElementById('muteBtn');
if (muteBtn) {
  muteBtn.addEventListener('click', () => {
    if (localStream) {
      isMuted = !isMuted;
      localStream.getAudioTracks().forEach(t => t.enabled = !isMuted);
      muteBtn.innerHTML = isMuted ? '<i class="fas fa-microphone-slash"></i>' : '<i class="fas fa-microphone"></i>';
      muteBtn.classList.toggle('active', isMuted);
    }
  });
}

const videoBtn = document.getElementById('videoBtn');
if (videoBtn) {
  videoBtn.addEventListener('click', () => {
    if (localStream) {
      isVideoOn = !isVideoOn;
      localStream.getVideoTracks().forEach(t => t.enabled = isVideoOn);
      videoBtn.innerHTML = isVideoOn ? '<i class="fas fa-video"></i>' : '<i class="fas fa-video-slash"></i>';
      videoBtn.classList.toggle('active', !isVideoOn);
    }
  });
}

// ==================== TIMER ====================
function startCallTimer() {
  callStartTime = Date.now();
  callDurationTimer = setInterval(() => {
    const elapsed = Math.floor((Date.now() - callStartTime) / 1000);
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    const el = document.getElementById('callDuration');
    if (el) el.textContent = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }, 1000);
}

function stopCallTimer() {
  if (callDurationTimer) {
    clearInterval(callDurationTimer);
    callDurationTimer = null;
  }
  callStartTime = null;
  const el = document.getElementById('callDuration');
  if (el) el.textContent = '00:00';
}

socket.on('call:rejected', (data) => {
  const el = document.getElementById('callStatus');
  if (el) el.textContent = 'Appel refusé';
  setTimeout(() => endCall(), 2000);
});

socket.on('call:ended', (data) => {
  if (currentCall) { try { currentCall.close(); } catch (e) {} currentCall = null; }
  const el = document.getElementById('callStatus');
  if (el) el.textContent = 'Appel terminé';
  setTimeout(() => {
    const callModal = document.getElementById('callModal');
    if (callModal) callModal.style.display = 'none';
    if (localStream) {
      localStream.getTracks().forEach(t => t.stop());
      localStream = null;
    }
    stopCallTimer();
  }, 2000);
});
