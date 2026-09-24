/**
 * TerangaChat Calls — PeerJS + Socket.IO
 *
 * Architecture:
 * - 1-à-1 : P2P PeerJS, signalisation via rooms user:<id>
 * - Groupe : mesh PeerJS (chaque pair se connecte aux autres), room call:<callId>
 * - Limite mesh : 5 participants
 *
 * Debug : window.CALL_DEBUG = true (ou ?callDebug=1)
 */
(function () {
  'use strict';

  const CALL_DEBUG =
    window.CALL_DEBUG === true ||
    new URLSearchParams(window.location.search).get('callDebug') === '1';

  function clog(...args) {
    if (CALL_DEBUG) console.log('[calls]', ...args);
  }

  const MAX_GROUP_PARTICIPANTS = 5;
  const RING_TIMEOUT_MS = 30000;
  const PEER_PATH = (window.peerJsConfig && window.peerJsConfig.path) || '/peerjs';
  const STREAM_WAIT_MS = 10000;

  let peer = null;
  let peerReady = null;
  let localStream = null;
  /** @type {Map<string, import('peerjs').MediaConnection>} */
  const peerConnections = new Map();
  /** peerId -> remote userId */
  const peerIdToUserId = new Map();
  let activeCallId = null;
  let activeCallType = 'audio';
  let isGroupCall = false;
  let isMuted = false;
  let isVideoOn = false;
  let isSpeakerOn = true;
  let callDurationTimer = null;
  let callStartTime = null;
  let ringTimer = null;
  let ringTimeout = null;
  let ringtoneCtx = null;
  let ringtoneOsc = null;
  let incomingCallData = null;
  let endingCall = false;
  let audioUnlocked = false;
  /** peerIds déjà re-dialés une fois */
  const dialRetried = new Set();

  function pagePeerOptions() {
    const isHttps = window.location.protocol === 'https:';
    const port = window.location.port
      ? parseInt(window.location.port, 10)
      : (isHttps ? 443 : 80);
    return {
      host: window.location.hostname,
      port,
      path: PEER_PATH,
      secure: isHttps,
    };
  }

  function getStablePeerId() {
    const key = 'tc_peer_id_' + window.currentUserId;
    try {
      let id = sessionStorage.getItem(key);
      if (!id) {
        id = 'user-' + window.currentUserId + '-' + Math.random().toString(36).slice(2, 9);
        sessionStorage.setItem(key, id);
      }
      return id;
    } catch (e) {
      return 'user-' + window.currentUserId + '-' + Date.now().toString(36);
    }
  }

  function buildIceServers() {
    const host = window.location.hostname;
    const cfg = window.peerJsConfig || {};
    const urls = Array.isArray(cfg.turnUrls) ? cfg.turnUrls.filter(Boolean) : [];
    const turnList = urls.length
      ? urls
      : [`turn:${host}:3478`, `turn:${host}:3478?transport=tcp`];
    const username = cfg.turnUsername || 'teranga';
    const credential = cfg.turnCredential || 'TerangaTurn2026!';

    const servers = [
      { urls: `stun:${host}:3478` },
      { urls: 'stun:stun.l.google.com:19302' },
    ];
    turnList.forEach((url) => {
      servers.push({ urls: url, username, credential });
    });
    // Toujours loggé (diagnostic média)
    console.log('[calls] ICE servers', servers.map((s) => (typeof s.urls === 'string' ? s.urls : s.urls)));
    return servers;
  }

  /** Débloque l'autoplay audio au geste utilisateur (décrocher / appeler) */
  function unlockAudio() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        if (!window.__tcAudioCtx) {
          window.__tcAudioCtx = new AudioCtx();
        }
        window.__tcAudioCtx.resume().catch(() => {});
      }
      audioUnlocked = true;
    } catch (e) {
      clog('unlockAudio failed', e);
    }
  }

  function userIdFromPeerId(peerId) {
    if (!peerId) return null;
    if (peerIdToUserId.has(peerId)) return peerIdToUserId.get(peerId);
    if (peerId.startsWith('user-')) {
      const rest = peerId.slice(5);
      const m = rest.match(
        /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i
      );
      return m ? m[1] : rest;
    }
    return null;
  }

  // ==================== PEERJS ====================
  function ensurePeer() {
    if (peer && !peer.destroyed && peer.open) return Promise.resolve(peer);
    if (peerReady) return peerReady;

    peerReady = new Promise((resolve, reject) => {
      const opts = pagePeerOptions();
      const peerId = getStablePeerId();

      if (peer) {
        try { peer.destroy(); } catch (e) { /* ignore */ }
        peer = null;
      }

      let settled = false;

      peer = new Peer(peerId, {
        host: opts.host,
        port: opts.port,
        path: opts.path,
        secure: opts.secure,
        debug: CALL_DEBUG ? 2 : 0,
        config: {
          iceServers: buildIceServers(),
          // Forcer TURN : les interfaces VM (10.x / vnet) cassent le P2P LAN
          iceTransportPolicy: 'relay',
          sdpSemantics: 'unified-plan',
        },
      });

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        peerReady = null;
        reject(new Error('PeerJS timeout — vérifiez que le serveur PeerJS est accessible'));
      }, 15000);

      peer.on('open', (id) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        console.log('[calls] PeerJS open', id, opts);
        resolve(peer);
      });

      peer.on('error', (err) => {
        console.error('[calls] PeerJS error:', err);
        if (err?.type === 'peer-unavailable') return;
        if (err?.type === 'unavailable-id') {
          // Nouvel ID stable pour cet onglet
          try {
            sessionStorage.removeItem('tc_peer_id_' + window.currentUserId);
          } catch (e) { /* ignore */ }
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            peerReady = null;
            try { peer.destroy(); } catch (e) { /* ignore */ }
            peer = null;
            // Un seul retry
            ensurePeer().then(resolve).catch(reject);
          }
          return;
        }
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        peerReady = null;
        reject(err);
      });

      peer.on('call', (call) => {
        console.log('[calls] Incoming PeerJS call from', call.peer);
        if (!activeCallId || !localStream) {
          clog('Ignoring unexpected PeerJS call (no active session)');
          try { call.close(); } catch (e) { /* ignore */ }
          return;
        }
        handleIncomingPeerCall(call);
      });

      peer.on('disconnected', () => {
        clog('PeerJS disconnected, reconnecting…');
        try {
          if (peer && !peer.destroyed) peer.reconnect();
        } catch (e) { /* ignore */ }
      });
    });

    return peerReady;
  }

  function handleIncomingPeerCall(call) {
    const existing = peerConnections.get(call.peer);
    if (existing) {
      const theirUserId = userIdFromPeerId(call.peer);
      const weArePolite =
        theirUserId && String(window.currentUserId) > String(theirUserId);
      if (weArePolite) {
        clog('Glare: accepting inbound, closing outbound', call.peer);
        try { existing.close(); } catch (e) { /* ignore */ }
        peerConnections.delete(call.peer);
        answerPeerCall(call);
      } else {
        clog('Glare: keeping outbound, closing inbound', call.peer);
        try { call.close(); } catch (e) { /* ignore */ }
      }
      return;
    }
    answerPeerCall(call);
  }

  async function answerPeerCall(call) {
    try {
      if (!localStream) {
        localStream = await getMediaStream(isVideoOn || activeCallType === 'video');
        attachLocalPreview();
      }
      // S'assurer que les pistes sont actives avant answer
      localStream.getTracks().forEach((t) => { t.enabled = true; });
      call.answer(localStream);
      bindMediaConnection(call);
    } catch (err) {
      console.error('[calls] Cannot answer PeerJS call:', err);
      try { call.close(); } catch (e) { /* ignore */ }
    }
  }

  function bindMediaConnection(call) {
    const remotePeerId = call.peer;
    peerConnections.set(remotePeerId, call);

    const pc = call.peerConnection;
    const watchIce = (attempt) => {
      const conn = call.peerConnection;
      if (!conn) {
        if (attempt < 50) setTimeout(() => watchIce(attempt + 1), 100);
        return;
      }
      const logIce = () => {
        console.log('[calls] ICE', remotePeerId, conn.iceConnectionState, 'pc=', conn.connectionState);
        if (conn.iceConnectionState === 'connected' || conn.iceConnectionState === 'completed') {
          setCallStatus('En communication');
          if (!callStartTime) startCallTimer();
        } else if (conn.iceConnectionState === 'failed') {
          setCallStatus('Média échoué (ICE) — vérifiez TURN :3478');
          console.warn('[calls] ICE failed for', remotePeerId);
        }
      };
      conn.addEventListener('iceconnectionstatechange', logIce);
      conn.addEventListener('connectionstatechange', () => {
        console.log('[calls] PC', remotePeerId, conn.connectionState);
      });
      logIce();
    };
    watchIce(0);

    call.on('stream', (remoteStream) => {
      console.log(
        '[calls] Remote stream from',
        remotePeerId,
        'audio=',
        remoteStream.getAudioTracks().length,
        'video=',
        remoteStream.getVideoTracks().length
      );
      attachRemoteStream(remotePeerId, remoteStream);
      setCallStatus('En communication');
      if (!callStartTime) startCallTimer();
    });

    call.on('close', () => {
      clog('Peer connection closed', remotePeerId);
      peerConnections.delete(remotePeerId);
      removeRemoteStream(remotePeerId);
      if (!isGroupCall && peerConnections.size === 0 && activeCallId && !endingCall) {
        cleanupLocalUi('Appel terminé');
      }
    });

    call.on('error', (err) => {
      console.error('[calls] MediaConnection error:', err);
    });

    // Si aucun flux distant après STREAM_WAIT_MS → re-dial une seule fois
    setTimeout(() => {
      if (!activeCallId || endingCall) return;
      if (dialRetried.has(remotePeerId)) return;
      const still = peerConnections.get(remotePeerId);
      if (!still) return;
      const hasRemoteEl = document.querySelector(
        `#remoteVideos [data-peer-id="${CSS.escape(remotePeerId)}"] video`
      );
      const ice = still.peerConnection?.iceConnectionState;
      const mediaOk =
        hasRemoteEl?.srcObject &&
        (ice === 'connected' || ice === 'completed');
      if (mediaOk) return;
      dialRetried.add(remotePeerId);
      clog('No media yet, retry dial', remotePeerId, ice);
      try { still.close(); } catch (e) { /* ignore */ }
      peerConnections.delete(remotePeerId);
      const uid = peerIdToUserId.get(remotePeerId) || userIdFromPeerId(remotePeerId);
      connectToPeer(remotePeerId, uid, { force: true }).catch(() => {});
    }, STREAM_WAIT_MS);
  }

  async function connectToPeer(remotePeerId, remoteUserId, options = {}) {
    if (!remotePeerId || remotePeerId === peer?.id) return;
    if (peerConnections.has(remotePeerId)) return;
    await ensurePeer();
    if (!localStream || !activeCallId) return;

    if (remoteUserId) peerIdToUserId.set(remotePeerId, String(remoteUserId));

    const theirUserId = remoteUserId || userIdFromPeerId(remotePeerId);
    if (!options.force && theirUserId && String(window.currentUserId) >= String(theirUserId)) {
      clog('Waiting for peer dial from', theirUserId);
      return;
    }

    clog('Calling peer', remotePeerId);
    localStream.getAudioTracks().forEach((t) => {
      if (!isMuted) t.enabled = true;
    });
    const call = peer.call(remotePeerId, localStream, {
      metadata: { callId: activeCallId, userId: window.currentUserId },
    });
    if (call) bindMediaConnection(call);
    else console.error('[calls] peer.call returned null for', remotePeerId);
  }

  async function getMediaStream(wantVideo) {
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: !!wantVideo,
      });
    } catch (err) {
      if (wantVideo) {
        clog('Video unavailable, falling back to audio', err);
        return navigator.mediaDevices.getUserMedia({
          audio: true,
          video: false,
        });
      }
      throw err;
    }
  }

  // ==================== MEDIA UI ====================
  function attachLocalPreview() {
    const localVideo = document.getElementById('localVideo');
    if (!localVideo || !localStream) return;
    localVideo.srcObject = localStream;
    localVideo.muted = true;
    localVideo.playsInline = true;
    const hasVideo = localStream.getVideoTracks().some((t) => t.enabled && t.readyState === 'live');
    localVideo.style.display = hasVideo ? 'block' : 'none';
    localVideo.play().catch(() => {});
  }

  function attachRemoteStream(peerId, stream) {
    const container = document.getElementById('remoteVideos');
    if (!container) return;

    let wrap = container.querySelector(`[data-peer-id="${CSS.escape(peerId)}"]`);
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.className = 'remote-peer';
      wrap.dataset.peerId = peerId;
      const video = document.createElement('video');
      video.autoplay = true;
      video.playsInline = true;
      video.className = 'remote-video';
      video.dataset.peerId = peerId;
      const audio = document.createElement('audio');
      audio.autoplay = true;
      audio.className = 'remote-audio';
      audio.dataset.peerId = peerId;
      wrap.appendChild(video);
      wrap.appendChild(audio);
      container.appendChild(wrap);
    }

    const video = wrap.querySelector('video');
    let audio = wrap.querySelector('audio');
    if (!audio) {
      audio = document.createElement('audio');
      audio.autoplay = true;
      audio.className = 'remote-audio';
      wrap.appendChild(audio);
    }

    const hasVideo = stream.getVideoTracks().some((t) => t.readyState === 'live');
    video.srcObject = stream;
    audio.srcObject = stream;
    video.style.display = hasVideo ? 'block' : 'none';
    // Audio-only → <audio> ; vidéo → son via <video> (éviter double lecture)
    if (hasVideo) {
      video.muted = false;
      video.volume = isSpeakerOn ? 1 : 0.25;
      audio.muted = true;
    } else {
      video.muted = true;
      audio.muted = false;
      audio.volume = isSpeakerOn ? 1 : 0.25;
    }

    const playEl = (el, label) => {
      if (!el) return;
      const p = el.play();
      if (p && p.catch) {
        p.catch((err) => {
          console.warn('[calls] play blocked', label, err);
          el.muted = true;
          el.play()
            .then(() => {
              setTimeout(() => {
                el.muted = label === 'video' && !hasVideo;
                if (label === 'audio') el.muted = false;
                el.volume = isSpeakerOn ? 1 : 0.25;
              }, 100);
            })
            .catch((e2) => console.warn('[calls] play failed', label, e2));
        });
      }
    };
    playEl(video, 'video');
    playEl(audio, 'audio');

    stream.getAudioTracks().forEach((t) => {
      console.log('[calls] remote audio track', t.label, t.enabled, t.readyState, 'muted=', t.muted);
      t.enabled = true;
    });

    const avatar = document.getElementById('callAvatar');
    if (avatar) avatar.style.display = hasVideo ? 'none' : '';
  }

  function removeRemoteStream(peerId) {
    const container = document.getElementById('remoteVideos');
    if (!container) return;
    const el = container.querySelector(`[data-peer-id="${CSS.escape(peerId)}"]`);
    if (el) el.remove();
  }

  function clearRemoteStreams() {
    const container = document.getElementById('remoteVideos');
    if (container) container.innerHTML = '';
  }

  function setCallStatus(text) {
    const el = document.getElementById('callStatus');
    if (el) el.textContent = text;
  }

  function showCallModal(title) {
    const modal = document.getElementById('callModal');
    if (!modal) return;
    modal.style.display = 'flex';
    const titleEl = document.getElementById('callTitle');
    if (titleEl) titleEl.textContent = title;
  }

  function hideCallModal() {
    const modal = document.getElementById('callModal');
    if (modal) modal.style.display = 'none';
    const incoming = document.getElementById('incomingCallModal');
    if (incoming) incoming.style.display = 'none';
  }

  // ==================== RINGTONE ====================
  function startRingtone() {
    stopRingtone();
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      ringtoneCtx = new AudioCtx();
      const playBeep = () => {
        if (!ringtoneCtx) return;
        const osc = ringtoneCtx.createOscillator();
        const gain = ringtoneCtx.createGain();
        osc.type = 'sine';
        osc.frequency.value = 880;
        gain.gain.value = 0.08;
        osc.connect(gain);
        gain.connect(ringtoneCtx.destination);
        osc.start();
        osc.stop(ringtoneCtx.currentTime + 0.25);
        ringtoneOsc = osc;
      };
      playBeep();
      ringTimer = setInterval(playBeep, 1200);
    } catch (err) {
      clog('ringtone error', err);
    }
  }

  function stopRingtone() {
    if (ringTimer) {
      clearInterval(ringTimer);
      ringTimer = null;
    }
    try {
      if (ringtoneOsc) ringtoneOsc.stop();
    } catch (e) { /* ignore */ }
    ringtoneOsc = null;
    if (ringtoneCtx) {
      ringtoneCtx.close().catch(() => {});
      ringtoneCtx = null;
    }
    if (ringTimeout) {
      clearTimeout(ringTimeout);
      ringTimeout = null;
    }
  }

  // ==================== TIMER ====================
  function startCallTimer() {
    stopCallTimer();
    callStartTime = Date.now();
    callDurationTimer = setInterval(() => {
      const elapsed = Math.floor((Date.now() - callStartTime) / 1000);
      const mins = Math.floor(elapsed / 60);
      const secs = elapsed % 60;
      const el = document.getElementById('callDuration');
      if (el) el.textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
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

  // ==================== OUTGOING ====================
  async function startCall(callType) {
    const conversationId = window.activeConversationId;
    if (!conversationId) {
      alert('Ouvrez une conversation pour appeler');
      return;
    }

    const isGroup = window.activeConversationType === 'group';

    try {
      unlockAudio();
      await ensurePeer();
      localStream = await getMediaStream(callType === 'video');
      isVideoOn = callType === 'video' && localStream.getVideoTracks().some((t) => t.readyState === 'live');
      isMuted = false;
      activeCallType = isVideoOn ? 'video' : 'audio';
      isGroupCall = isGroup;
      endingCall = false;
      peerIdToUserId.clear();
      dialRetried.clear();

      showCallModal(
        isGroup
          ? (activeCallType === 'video' ? 'Appel vidéo de groupe' : 'Appel audio de groupe')
          : (activeCallType === 'video' ? 'Appel vidéo' : 'Appel audio')
      );
      setCallStatus(isGroup ? 'Appel de groupe…' : 'Appel en cours…');
      attachLocalPreview();
      updateControlButtons();

      if (!peer?.id) await ensurePeer();

      socket.emit('call:initiate', {
        conversationId,
        callType: activeCallType,
        peerId: peer.id,
      });

      clog('call:initiate emitted', { conversationId, callType: activeCallType, peerId: peer.id, isGroup });
    } catch (err) {
      console.error('[calls] startCall error:', err);
      const msg = err?.type || err?.message || '';
      if (/PeerJS|timeout|Unavailable/i.test(String(msg)) || err?.type) {
        alert("Impossible de se connecter au serveur d'appels (PeerJS). Rechargez la page.");
      } else {
        alert("Impossible d'accéder à la caméra/microphone");
      }
      cleanupLocalUi();
    }
  }

  socket.on('call:created', (data) => {
    activeCallId = data.callId;
    isGroupCall = !!data.isGroup;
    clog('call:created', data);
    if (!isGroupCall) {
      // 30s timeout côté appelant aussi
      ringTimeout = setTimeout(() => {
        if (activeCallId === data.callId && peerConnections.size === 0) {
          setCallStatus('Pas de réponse');
          socket.emit('call:missed', { callId: data.callId });
          setTimeout(() => endCall(), 1500);
        }
      }, RING_TIMEOUT_MS);
    }
  });

  // ==================== INCOMING 1-1 ====================
  socket.on('call:incoming', (data) => {
    clog('call:incoming', data);
    incomingCallData = data;
    activeCallId = data.callId;
    activeCallType = data.callType || 'audio';
    isGroupCall = false;

    const modal = document.getElementById('incomingCallModal');
    if (!modal) return;
    modal.style.display = 'flex';
    document.getElementById('incomingCallTitle').textContent =
      data.callType === 'video' ? 'Appel vidéo entrant' : 'Appel audio entrant';
    document.getElementById('incomingCallStatus').textContent =
      (data.callerName || 'Quelqu\'un') + ' vous appelle…';

    const acceptLabel = document.getElementById('acceptCallLabel');
    const rejectLabel = document.getElementById('rejectCallLabel');
    if (acceptLabel) acceptLabel.textContent = 'Accepter';
    if (rejectLabel) rejectLabel.textContent = 'Refuser';

    const acceptBtn = document.getElementById('acceptCallBtn');
    const rejectBtn = document.getElementById('rejectCallBtn');
    if (acceptBtn) acceptBtn.title = 'Accepter';
    if (rejectBtn) rejectBtn.title = 'Refuser';

    startRingtone();
    ringTimeout = setTimeout(() => {
      clog('incoming timeout');
      stopRingtone();
      modal.style.display = 'none';
      socket.emit('call:missed', { callId: data.callId });
      incomingCallData = null;
    }, RING_TIMEOUT_MS);
  });

  // ==================== GROUP INVITE ====================
  socket.on('call:group-invite', (data) => {
    if (activeCallId === data.callId && localStream) return; // already in call
    clog('call:group-invite', data);
    incomingCallData = { ...data, isGroup: true };
    activeCallId = data.callId;
    activeCallType = data.callType || 'audio';
    isGroupCall = true;

    const modal = document.getElementById('incomingCallModal');
    if (!modal) return;
    modal.style.display = 'flex';
    document.getElementById('incomingCallTitle').textContent = 'Appel de groupe en cours';
    document.getElementById('incomingCallStatus').textContent =
      `${data.groupName || 'Groupe'} — ${data.participantCount || 1} participant(s)`;

    const acceptLabel = document.getElementById('acceptCallLabel');
    const rejectLabel = document.getElementById('rejectCallLabel');
    if (acceptLabel) acceptLabel.textContent = 'Rejoindre';
    if (rejectLabel) rejectLabel.textContent = 'Ignorer';

    startRingtone();
  });

  const acceptCallBtn = document.getElementById('acceptCallBtn');
  const rejectCallBtn = document.getElementById('rejectCallBtn');

  if (acceptCallBtn) {
    acceptCallBtn.addEventListener('click', async () => {
      const data = incomingCallData;
      if (!data) return;
      stopRingtone();
      document.getElementById('incomingCallModal').style.display = 'none';

      try {
        unlockAudio();
        await ensurePeer();
        localStream = await getMediaStream(data.callType === 'video');
        isVideoOn = data.callType === 'video' && localStream.getVideoTracks().some((t) => t.readyState === 'live');
        activeCallId = data.callId;
        activeCallType = isVideoOn ? 'video' : (data.callType || 'audio');
        isGroupCall = !!data.isGroup;
        endingCall = false;
        peerIdToUserId.clear();
        dialRetried.clear();
        if (data.peerId && data.callerId) {
          peerIdToUserId.set(data.peerId, String(data.callerId));
        }

        showCallModal(
          isGroupCall
            ? 'Appel de groupe'
            : (activeCallType === 'video' ? 'Appel vidéo' : 'Appel audio')
        );
        setCallStatus('Connexion…');
        attachLocalPreview();
        updateControlButtons();

        if (isGroupCall) {
          socket.emit('call:join', { callId: data.callId, peerId: peer.id });
        } else {
          socket.emit('call:accept', {
            callId: data.callId,
            conversationId: data.conversationId,
            peerId: peer.id,
          });
        }
        incomingCallData = null;
      } catch (err) {
        console.error('[calls] accept error:', err);
        alert("Impossible d'accéder à la caméra/microphone ou au serveur d'appels");
        endCall();
      }
    });
  }

  if (rejectCallBtn) {
    rejectCallBtn.addEventListener('click', () => {
      const data = incomingCallData;
      stopRingtone();
      document.getElementById('incomingCallModal').style.display = 'none';
      if (data) {
        socket.emit('call:reject', {
          callId: data.callId,
          conversationId: data.conversationId,
        });
      }
      incomingCallData = null;
      activeCallId = null;
    });
  }

  // ==================== SIGNALING EVENTS ====================
  socket.on('call:accepted', async (data) => {
    console.log('[calls] call:accepted', data);
    stopRingtone();
    if (ringTimeout) { clearTimeout(ringTimeout); ringTimeout = null; }
    setCallStatus('Connecté — établissement média…');
    const remotePeerId = data.peerId || ('user-' + data.userId);
    if (data.userId) peerIdToUserId.set(remotePeerId, String(data.userId));
    try {
      await ensurePeer();
      // Laisser le callee stabiliser son PeerJS avant le dial
      await new Promise((r) => setTimeout(r, 500));
      await connectToPeer(remotePeerId, data.userId, { force: true });
    } catch (err) {
      console.error('[calls] connect after accept failed:', err);
    }
  });

  socket.on('call:peers', async (data) => {
    clog('call:peers', data);
    if (!data?.participants) return;
    for (const p of data.participants) {
      if (p.peerId && p.userId) peerIdToUserId.set(p.peerId, String(p.userId));
      if (p.peerId) await connectToPeer(p.peerId, p.userId);
    }
    updateParticipantCount(data.participants.length + 1);
  });

  socket.on('call:participant-joined', async (data) => {
    clog('call:participant-joined', data);
    if (data.userId === window.currentUserId) return;
    // 1-à-1 : déjà géré par call:accepted (évite double dial / glare)
    if (!isGroupCall) return;
    if (data.peerId && data.userId) peerIdToUserId.set(data.peerId, String(data.userId));
    if (data.peerId) await connectToPeer(data.peerId, data.userId);
    if (data.participants) updateParticipantCount(data.participants.filter((p) => p.status === 'joined').length);
  });

  socket.on('call:participant-left', (data) => {
    clog('call:participant-left', data);
    const remotePeerId = 'user-' + data.userId;
    const conn = peerConnections.get(remotePeerId);
    if (conn) {
      try { conn.close(); } catch (e) { /* ignore */ }
      peerConnections.delete(remotePeerId);
    }
    removeRemoteStream(remotePeerId);
    if (data.participants) {
      updateParticipantCount(data.participants.filter((p) => p.status === 'joined').length);
    }
  });

  socket.on('call:rejected', () => {
    setCallStatus('Appel refusé');
    setTimeout(() => endCall(), 1500);
  });

  socket.on('call:missed', () => {
    setCallStatus('Appel manqué');
    setTimeout(() => endCall(), 1500);
  });

  socket.on('call:ended', (data) => {
    clog('call:ended', data);
    if (endingCall) return;
    setCallStatus('Appel terminé');
    cleanupLocalUi();
  });

  socket.on('call:error', (data) => {
    console.error('[calls] server error:', data);
    alert(data?.message || 'Erreur d\'appel');
    if (data?.code === 'MAX_PARTICIPANTS') {
      stopRingtone();
      const incoming = document.getElementById('incomingCallModal');
      if (incoming) incoming.style.display = 'none';
      incomingCallData = null;
      return;
    }
    // Échec d'initiation / acceptation → fermer l'UI
    if (activeCallId || localStream) {
      cleanupLocalUi();
    }
  });

  socket.on('call:switch-audio', async () => {
    if (!localStream) return;
    localStream.getVideoTracks().forEach((t) => {
      t.enabled = false;
      t.stop();
    });
    isVideoOn = false;
    attachLocalPreview();
    updateControlButtons();
    setCallStatus('Passage en audio uniquement');
  });

  function updateParticipantCount(n) {
    if (!isGroupCall) return;
    setCallStatus(`${n} participant(s)`);
    if (n > MAX_GROUP_PARTICIPANTS) {
      const ok = confirm(
        'Les appels de groupe sont limités à 5 participants. Passer en audio uniquement ?'
      );
      if (ok && activeCallId) {
        socket.emit('call:switch-audio', { callId: activeCallId });
        localStream?.getVideoTracks().forEach((t) => { t.enabled = false; t.stop(); });
        isVideoOn = false;
        attachLocalPreview();
        updateControlButtons();
      }
    }
  }

  // ==================== CONTROLS ====================
  function updateControlButtons() {
    const muteBtn = document.getElementById('muteBtn');
    const videoBtn = document.getElementById('videoBtn');
    const speakerBtn = document.getElementById('speakerBtn');
    if (muteBtn) {
      muteBtn.innerHTML = isMuted ? '<i class="fas fa-microphone-slash"></i>' : '<i class="fas fa-microphone"></i>';
      muteBtn.classList.toggle('active', isMuted);
    }
    if (videoBtn) {
      videoBtn.innerHTML = isVideoOn ? '<i class="fas fa-video"></i>' : '<i class="fas fa-video-slash"></i>';
      videoBtn.classList.toggle('active', !isVideoOn);
    }
    if (speakerBtn) {
      speakerBtn.innerHTML = isSpeakerOn ? '<i class="fas fa-volume-up"></i>' : '<i class="fas fa-volume-mute"></i>';
      speakerBtn.classList.toggle('active', !isSpeakerOn);
    }
  }

  function cleanupLocalUi(statusText) {
    stopRingtone();
    if (statusText) setCallStatus(statusText);

    peerConnections.forEach((c) => { try { c.close(); } catch (e) { /* ignore */ } });
    peerConnections.clear();
    peerIdToUserId.clear();
    dialRetried.clear();

    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
      localStream = null;
    }
    stopCallTimer();
    clearRemoteStreams();

    const localVideo = document.getElementById('localVideo');
    if (localVideo) {
      localVideo.srcObject = null;
      localVideo.style.display = 'none';
    }
    const avatar = document.getElementById('callAvatar');
    if (avatar) avatar.style.display = '';

    setTimeout(() => hideCallModal(), statusText ? 1200 : 0);
    activeCallId = null;
    incomingCallData = null;
    isGroupCall = false;
  }

  function endCall() {
    if (endingCall) return;
    endingCall = true;
    const duration = callStartTime ? Math.floor((Date.now() - callStartTime) / 1000) : 0;
    const callId = activeCallId;
    if (callId) {
      socket.emit('call:end', {
        callId,
        conversationId: window.activeConversationId,
        duration,
      });
    }
    cleanupLocalUi('Appel terminé');
    endingCall = false;
  }

  const hangupBtn = document.getElementById('hangupBtn');
  if (hangupBtn) hangupBtn.addEventListener('click', endCall);

  const muteBtn = document.getElementById('muteBtn');
  if (muteBtn) {
    muteBtn.addEventListener('click', () => {
      if (!localStream) return;
      isMuted = !isMuted;
      localStream.getAudioTracks().forEach((t) => { t.enabled = !isMuted; });
      updateControlButtons();
    });
  }

  const videoBtn = document.getElementById('videoBtn');
  if (videoBtn) {
    videoBtn.addEventListener('click', async () => {
      if (!localStream) return;
      const videoTracks = localStream.getVideoTracks();
      if (videoTracks.length === 0 && !isVideoOn) {
        try {
          const cam = await navigator.mediaDevices.getUserMedia({ video: true });
          cam.getVideoTracks().forEach((t) => localStream.addTrack(t));
          isVideoOn = true;
          // Renégocier : re-dial avec force (sinon ordre lexico peut bloquer)
          const peers = Array.from(peerConnections.keys());
          peers.forEach((remoteId) => {
            const conn = peerConnections.get(remoteId);
            try { conn.close(); } catch (e) { /* ignore */ }
            peerConnections.delete(remoteId);
            const uid = peerIdToUserId.get(remoteId) || userIdFromPeerId(remoteId);
            connectToPeer(remoteId, uid, { force: true });
          });
        } catch (err) {
          alert('Caméra inaccessible');
          return;
        }
      } else {
        isVideoOn = !isVideoOn;
        videoTracks.forEach((t) => { t.enabled = isVideoOn; });
      }
      attachLocalPreview();
      updateControlButtons();
    });
  }

  const speakerBtn = document.getElementById('speakerBtn');
  if (speakerBtn) {
    speakerBtn.addEventListener('click', () => {
      isSpeakerOn = !isSpeakerOn;
      document.querySelectorAll('#remoteVideos video, #remoteVideos audio').forEach((v) => {
        v.volume = isSpeakerOn ? 1 : 0.25;
        v.muted = false;
      });
      updateControlButtons();
    });
  }

  const callAudioBtn = document.getElementById('callAudioBtn');
  const callVideoBtn = document.getElementById('callVideoBtn');
  if (callAudioBtn) callAudioBtn.addEventListener('click', () => startCall('audio'));
  if (callVideoBtn) callVideoBtn.addEventListener('click', () => startCall('video'));

  // Warm up PeerJS early
  ensurePeer().catch((err) => clog('early peer init failed', err));
})();
