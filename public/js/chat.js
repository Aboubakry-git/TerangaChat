const socket = io();
const currentUserId = window.currentUserId;
const currentUsername = window.currentUsername;
let activeConversationId = window.activeConversationId;
let activeConversationType = window.activeConversationType;
let typingTimeout = null;
let isTyping = false;
let replyToId = null;
let editingMessageId = null;
let selectedGroupMembers = [];

socket.emit('user:join', currentUserId);

if (activeConversationId) {
  socket.emit('conversation:open', activeConversationId);
  scrollToBottom();

  // Une conversation ouverte occupe tout l'écran sur téléphone.
  if (window.matchMedia('(max-width: 768px)').matches) {
    document.getElementById('sidebar')?.classList.add('hidden-mobile');
    document.querySelector('.chat-main')?.classList.add('active-mobile');
  }
}

// ==================== SOCKET EVENTS ====================
socket.on('message:receive', (data) => {
  if (data.conversationId === activeConversationId) {
    appendMessage(data);
    scrollToBottom();
    if (data.senderId !== currentUserId) {
      socket.emit('message:read', { conversationId: data.conversationId, messageId: data.messageId });
    }
  }
});

socket.on('message:edited', (data) => {
  const msgEl = document.querySelector(`[data-message-id="${data.messageId}"]`);
  if (msgEl) {
    const contentEl = msgEl.querySelector('.message-content');
    if (contentEl) contentEl.textContent = data.content;
    const metaEl = msgEl.querySelector('.message-meta');
    if (metaEl && !metaEl.querySelector('.edited-tag')) {
      const tag = document.createElement('span');
      tag.className = 'edited-tag';
      tag.textContent = 'modifié';
      metaEl.insertBefore(tag, metaEl.firstChild);
    }
  }
});

socket.on('message:deleted', (data) => {
  const msgEl = document.querySelector(`[data-message-id="${data.messageId}"]`);
  if (msgEl) {
    if (data.deleteForEveryone) {
      const bubble = msgEl.querySelector('.message-bubble');
      if (bubble) bubble.innerHTML = '<span class="message-deleted"><i class="fas fa-ban"></i> Ce message a été supprimé</span>';
    } else {
      msgEl.style.display = 'none';
    }
  }
});

socket.on('message:readReceipt', (data) => {
  const msgEl = document.querySelector(`[data-message-id="${data.messageId}"]`);
  if (msgEl) {
    const checks = msgEl.querySelector('.message-checks');
    if (checks) checks.innerHTML = '<i class="fas fa-check-double" style="color:#009999"></i>';
  }
});

socket.on('typing:start', (data) => {
  if (data.conversationId === activeConversationId && data.userId !== currentUserId) {
    const el = document.getElementById('typingIndicator');
    if (el) el.style.display = 'flex';
  }
});

socket.on('typing:stop', (data) => {
  if (data.conversationId === activeConversationId) {
    const el = document.getElementById('typingIndicator');
    if (el) el.style.display = 'none';
  }
});

socket.on('presence:update', (data) => {
  const statusEl = document.getElementById('presenceStatus');
  if (statusEl && activeConversationType === 'private') {
    statusEl.innerHTML = data.isOnline
      ? '<span class="presence-text online">En ligne</span>'
      : '<span class="presence-text">Hors ligne</span>';
  }
});

socket.on('notification:new', (data) => {
  showNotification(data.title, data.body);
  const badge = document.getElementById('notifBadge');
  if (badge) {
    let count = parseInt(badge.textContent || '0') + 1;
    badge.textContent = count;
    badge.style.display = 'inline-flex';
  }
});

// ==================== MESSAGE SENDING ====================
const messageInput = document.getElementById('messageInput');
const sendBtn = document.getElementById('sendBtn');

if (sendBtn) sendBtn.addEventListener('click', sendMessage);

if (messageInput) {
  messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  messageInput.addEventListener('input', () => {
    if (!activeConversationId) return;
    if (!isTyping) {
      isTyping = true;
      socket.emit('typing:start', { conversationId: activeConversationId });
    }
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
      isTyping = false;
      socket.emit('typing:stop', { conversationId: activeConversationId });
    }, 1500);

    messageInput.style.height = 'auto';
    messageInput.style.height = Math.min(messageInput.scrollHeight, 120) + 'px';
  });
}

function sendMessage() {
  const content = messageInput.value.trim();
  if (!content || !activeConversationId) return;

  if (editingMessageId) {
    socket.emit('message:edit', {
      conversationId: activeConversationId,
      messageId: editingMessageId,
      content: content,
    });
    editingMessageId = null;
    messageInput.value = '';
    return;
  }

  socket.emit('message:send', {
    conversationId: activeConversationId,
    content: content,
    messageType: 'text',
    replyToId: replyToId,
  });

  messageInput.value = '';
  messageInput.style.height = 'auto';
  replyToId = null;
  const rp = document.getElementById('replyPreview');
  if (rp) rp.style.display = 'none';
  socket.emit('typing:stop', { conversationId: activeConversationId });
}

function appendMessage(data) {
  const container = document.getElementById('messagesContainer');
  if (!container) return;

  const emptyChat = container.querySelector('.empty-chat');
  if (emptyChat) emptyChat.remove();

  const msgEl = document.createElement('div');
  msgEl.className = 'message ' + (data.senderId === currentUserId ? 'outgoing' : 'incoming');
  msgEl.dataset.messageId = data.messageId;

  const time = new Date(data.createdAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

  let html = '';
  if (activeConversationType === 'group' && data.senderId !== currentUserId) {
    html += `<div class="message-sender">${data.senderName || 'Utilisateur'}</div>`;
  }
  html += `<div class="message-bubble">`;

  if (data.messageType === 'text') {
    html += `<div class="message-content">${data.content || ''}</div>`;
  } else if (data.messageType === 'voice') {
    html += `<div class="message-voice"><button class="voice-play-btn"><i class="fas fa-play"></i></button><div class="voice-wave"><div class="wave-bar"></div><div class="wave-bar"></div><div class="wave-bar"></div><div class="wave-bar"></div><div class="wave-bar"></div></div><span class="voice-duration">${data.duration || 0}s</span><audio src="${data.fileUrl}" preload="metadata"></audio></div>`;
  } else if (data.messageType === 'image') {
    html += `<div class="message-media"><img src="${data.fileUrl}" alt="${data.fileName || ''}" class="message-img" loading="lazy">${data.content ? `<div class="message-caption">${data.content}</div>` : ''}</div>`;
  } else if (data.messageType === 'video') {
    html += `<div class="message-media"><video src="${data.fileUrl}" controls class="message-video"></video>${data.content ? `<div class="message-caption">${data.content}</div>` : ''}</div>`;
  } else if (data.messageType === 'file') {
    html += `<div class="message-file"><i class="fas fa-file"></i><a href="${data.fileUrl}" download="${data.fileName || ''}">${data.fileName || 'Fichier'}</a></div>`;
  }

  html += `<div class="message-meta"><span class="message-time">${time}</span>`;
  if (data.senderId === currentUserId) {
    html += `<span class="message-checks"><i class="fas fa-check"></i></span>`;
  }
  html += `</div></div>`;

  msgEl.innerHTML = html;
  container.appendChild(msgEl);
}

function scrollToBottom() {
  const container = document.getElementById('messagesContainer');
  if (container) container.scrollTop = container.scrollHeight;
}

// ==================== FILE UPLOAD ====================
const attachBtn = document.getElementById('attachBtn');
const fileInput = document.getElementById('fileInput');

if (attachBtn) attachBtn.addEventListener('click', () => fileInput.click());

if (fileInput) {
  fileInput.addEventListener('change', async () => {
    for (const file of fileInput.files) {
      await uploadFile(file);
    }
    fileInput.value = '';
  });
}

async function uploadFile(file) {
  const formData = new FormData();
  formData.append('file', file);

  try {
    const res = await fetch('/api/upload', { method: 'POST', body: formData, credentials: 'same-origin' });
    if (!res.ok) throw new Error('Upload failed');
    const data = await res.json();

    let messageType = 'file';
    if (file.type.startsWith('image/')) messageType = 'image';
    else if (file.type.startsWith('video/')) messageType = 'video';

    socket.emit('message:send', {
      conversationId: activeConversationId,
      content: null,
      messageType,
      fileUrl: data.url,
      fileName: data.fileName,
      fileSize: data.fileSize,
      mimeType: data.mimeType,
    });
  } catch (err) {
    console.error('Upload error:', err);
    alert("Erreur lors de l'envoi du fichier");
  }
}

// ==================== VOICE RECORDING ====================
const voiceRecordBtn = document.getElementById('voiceRecordBtn');
let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;
let recordingStartTime = null;

if (voiceRecordBtn) {
  voiceRecordBtn.addEventListener('click', async () => {
    if (isRecording) stopRecording();
    else startRecording();
  });
}

async function startRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(stream);
    audioChunks = [];
    recordingStartTime = Date.now();

    mediaRecorder.addEventListener('dataavailable', (e) => {
      audioChunks.push(e.data);
    });

    mediaRecorder.addEventListener('stop', async () => {
      const blob = new Blob(audioChunks, { type: 'audio/webm' });
      const duration = Math.floor((Date.now() - recordingStartTime) / 1000);
      const formData = new FormData();
      formData.append('file', blob, 'voice.webm');

      try {
        const res = await fetch('/api/upload', { method: 'POST', body: formData, credentials: 'same-origin' });
        const data = await res.json();
        socket.emit('message:send', {
          conversationId: activeConversationId,
          messageType: 'voice',
          fileUrl: data.url,
          fileName: data.fileName,
          fileSize: data.fileSize,
          mimeType: data.mimeType,
          duration,
        });
      } catch (err) {
        console.error('Voice upload error:', err);
      }

      stream.getTracks().forEach(t => t.stop());
    });

    mediaRecorder.start();
    isRecording = true;
    voiceRecordBtn.innerHTML = '<i class="fas fa-stop"></i>';
    voiceRecordBtn.style.color = '#e74c3c';
  } catch (err) {
    console.error('Recording error:', err);
    alert("Impossible d'accéder au microphone");
  }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  isRecording = false;
  voiceRecordBtn.innerHTML = '<i class="fas fa-microphone"></i>';
  voiceRecordBtn.style.color = '';
}

// ==================== EMOJI ====================
const emojiBtn = document.getElementById('emojiBtn');
const emojiPicker = document.getElementById('emojiPicker');

if (emojiBtn) {
  emojiBtn.addEventListener('click', () => {
    emojiPicker.style.display = emojiPicker.style.display === 'none' ? 'block' : 'none';
  });
}

if (emojiPicker) {
  emojiPicker.querySelectorAll('.emoji-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      messageInput.value += btn.textContent;
      messageInput.focus();
    });
  });
}

// ==================== MESSAGE ACTIONS ====================
document.addEventListener('click', (e) => {
  const actionBtn = e.target.closest('.msg-action');
  if (!actionBtn) return;

  const msgEl = actionBtn.closest('.message');
  const messageId = msgEl.dataset.messageId;
  const action = actionBtn.dataset.action;

  if (action === 'reply') {
    replyToId = messageId;
    const content = msgEl.querySelector('.message-content')?.textContent || 'Message';
    const preview = document.getElementById('replyPreview');
    if (preview) {
      preview.querySelector('.reply-preview-content').textContent = content;
      preview.style.display = 'flex';
    }
    messageInput.focus();
  } else if (action === 'edit') {
    const content = msgEl.querySelector('.message-content')?.textContent || '';
    editingMessageId = messageId;
    messageInput.value = content;
    messageInput.focus();
  } else if (action === 'delete') {
    if (confirm('Supprimer ce message pour tout le monde ?')) {
      socket.emit('message:delete', {
        conversationId: activeConversationId,
        messageId,
        deleteForEveryone: true,
      });
    }
  }
});

const cancelReply = document.getElementById('cancelReply');
if (cancelReply) {
  cancelReply.addEventListener('click', () => {
    replyToId = null;
    document.getElementById('replyPreview').style.display = 'none';
  });
}

// ==================== NEW CHAT ====================
const newChatBtn = document.getElementById('newChatBtn');
const startNewChat = document.getElementById('startNewChat');
const newChatModal = document.getElementById('newChatModal');
const newChatSearch = document.getElementById('newChatSearch');
const newChatResults = document.getElementById('newChatResults');

function openNewChat() { newChatModal.style.display = 'flex'; newChatSearch.focus(); }
function closeNewChat() { newChatModal.style.display = 'none'; }

if (newChatBtn) newChatBtn.addEventListener('click', openNewChat);
if (startNewChat) startNewChat.addEventListener('click', openNewChat);

if (newChatSearch) {
  newChatSearch.addEventListener('input', async () => {
    const q = newChatSearch.value.trim();
    if (q.length < 2) { newChatResults.innerHTML = ''; return; }
    try {
      const res = await fetch(`/api/search/users?q=${encodeURIComponent(q)}`, { credentials: 'same-origin' });
      const data = await res.json();
      newChatResults.innerHTML = '';
      if (data.users && data.users.length > 0) {
        data.users.forEach(u => {
          if (u.user_id === currentUserId) return;
          const el = document.createElement('div');
          el.className = 'search-result-item';
          el.innerHTML = `
            <div class="result-avatar">${u.avatar_url ? `<img src="${u.avatar_url}" alt="">` : `<div class="avatar-placeholder">${(u.username||'?').substring(0,2).toUpperCase()}</div>`}</div>
            <div class="result-info"><span class="result-name">${u.username}</span><span class="result-full">${u.full_name || ''}</span></div>
          `;
          el.addEventListener('click', async () => {
            const res = await fetch('/api/conversations', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ type: 'private', memberIds: [u.user_id] }),
              credentials: 'same-origin',
            });
            const data = await res.json();
            if (data.conversationId) window.location.href = `/chat/${data.conversationId}`;
          });
          newChatResults.appendChild(el);
        });
      } else {
        newChatResults.innerHTML = '<p class="no-results">Aucun utilisateur trouvé</p>';
      }
    } catch (err) {
      console.error('Search error:', err);
    }
  });
}

// ==================== NEW GROUP ====================
const newGroupBtn = document.getElementById('newGroupBtn');
const newGroupModal = document.getElementById('newGroupModal');
const groupMemberSearch = document.getElementById('groupMemberSearch');
const groupMemberResults = document.getElementById('groupMemberResults');
const selectedMembersEl = document.getElementById('selectedMembers');
const createGroupBtn = document.getElementById('createGroupBtn');
const groupAvatarInput = document.getElementById('groupAvatarInput');
const groupAvatarPreview = document.getElementById('groupAvatarPreview');

// Aperçu local avant l'envoi : aucun fichier n'est téléversé à cette étape.
if (groupAvatarInput) {
  groupAvatarInput.addEventListener('change', () => {
    const image = groupAvatarInput.files[0];
    if (!image) return;
    if (!image.type.startsWith('image/')) {
      alert('Veuillez choisir une image pour le groupe');
      groupAvatarInput.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = event => {
      groupAvatarPreview.innerHTML = `<img src="${event.target.result}" alt="Aperçu de la photo du groupe">`;
    };
    reader.readAsDataURL(image);
  });
}

async function uploadGroupAvatar() {
  const image = groupAvatarInput?.files[0];
  if (!image) return null;

  const formData = new FormData();
  formData.append('file', image);
  const response = await fetch('/api/upload', {
    method: 'POST',
    body: formData,
    credentials: 'same-origin',
  });
  if (!response.ok) throw new Error('Échec de l’envoi de la photo de groupe');
  const data = await response.json();
  return data.url;
}

if (newGroupBtn) newGroupBtn.addEventListener('click', () => { newGroupModal.style.display = 'flex'; });

if (groupMemberSearch) {
  groupMemberSearch.addEventListener('input', async () => {
    const q = groupMemberSearch.value.trim();
    if (q.length < 2) { groupMemberResults.innerHTML = ''; return; }
    try {
      const res = await fetch(`/api/search/users?q=${encodeURIComponent(q)}`, { credentials: 'same-origin' });
      const data = await res.json();
      groupMemberResults.innerHTML = '';
      if (data.users) {
        data.users.forEach(u => {
          if (u.user_id === currentUserId) return;
          if (selectedGroupMembers.find(m => m.user_id === u.user_id)) return;
          const el = document.createElement('div');
          el.className = 'search-result-item';
          el.innerHTML = `
            <div class="result-avatar">${u.avatar_url ? `<img src="${u.avatar_url}" alt="">` : `<div class="avatar-placeholder">${(u.username||'?').substring(0,2).toUpperCase()}</div>`}</div>
            <div class="result-info"><span class="result-name">${u.username}</span></div>
            <i class="fas fa-plus"></i>
          `;
          el.addEventListener('click', () => {
            selectedGroupMembers.push(u);
            renderSelectedMembers();
            groupMemberSearch.value = '';
            groupMemberResults.innerHTML = '';
          });
          groupMemberResults.appendChild(el);
        });
      }
    } catch (err) { console.error(err); }
  });
}

function renderSelectedMembers() {
  selectedMembersEl.innerHTML = '';
  selectedGroupMembers.forEach((m, i) => {
    const el = document.createElement('div');
    el.className = 'selected-member-chip';
    el.innerHTML = `<span>${m.username}</span><button onclick="removeMember(${i})"><i class="fas fa-times"></i></button>`;
    selectedMembersEl.appendChild(el);
  });
}

window.removeMember = function(i) {
  selectedGroupMembers.splice(i, 1);
  renderSelectedMembers();
};

if (createGroupBtn) {
  createGroupBtn.addEventListener('click', async () => {
    const name = document.getElementById('groupName').value.trim();
    const description = document.getElementById('groupDescription').value.trim();
    if (!name) return alert('Nom du groupe requis');
    if (selectedGroupMembers.length === 0) return alert('Ajoutez au moins un membre');

    try {
      createGroupBtn.disabled = true;
      const avatarUrl = await uploadGroupAvatar();
      const res = await fetch('/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'group',
          name,
          description,
          avatarUrl,
          memberIds: selectedGroupMembers.map(m => m.user_id),
        }),
        credentials: 'same-origin',
      });
      const data = await res.json();
      if (data.conversationId) window.location.href = `/chat/${data.conversationId}`;
    } catch (err) {
      console.error('Create group error:', err);
      alert('Erreur lors de la création du groupe');
    } finally {
      createGroupBtn.disabled = false;
    }
  });
}

// ==================== CONVERSATION MENU ====================
const convMenuBtn = document.getElementById('convMenuBtn');
const convMenu = document.getElementById('convMenu');

if (convMenuBtn) {
  convMenuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    convMenu.style.display = convMenu.style.display === 'block' ? 'none' : 'block';
  });
  document.addEventListener('click', () => { convMenu.style.display = 'none'; });
}

const archiveBtn = document.getElementById('archiveBtn');
if (archiveBtn) {
  archiveBtn.addEventListener('click', async () => {
    await fetch(`/api/conversations/${activeConversationId}/archive`, { method: 'POST', credentials: 'same-origin' });
    alert('Discussion archivée');
  });
}

const exportBtn = document.getElementById('exportBtn');
if (exportBtn) {
  exportBtn.addEventListener('click', () => {
    window.open(`/api/conversations/${activeConversationId}/export`, '_blank');
  });
}

const convInfoBtn = document.getElementById('convInfoBtn');
if (convInfoBtn) {
  convInfoBtn.addEventListener('click', async () => {
    const res = await fetch(`/api/conversations/${activeConversationId}/members`, { credentials: 'same-origin' });
    const data = await res.json();
    const body = document.getElementById('convInfoBody');
    body.innerHTML = '<h4>Membres</h4>';
    if (data.members) {
      data.members.forEach(m => {
        body.innerHTML += `<div class="member-item"><div class="member-avatar">${m.avatar_url ? `<img src="${m.avatar_url}">` : `<div class="avatar-placeholder">${(m.username||'?').substring(0,2).toUpperCase()}</div>`}</div><span>${m.username}</span><span class="badge-role">${m.role}</span></div>`;
      });
    }
    document.getElementById('convInfoModal').style.display = 'flex';
  });
}

// ==================== SEARCH IN CONV ====================
const searchInConvBtn = document.getElementById('searchInConvBtn');
const searchInConv = document.getElementById('searchInConv');
const searchInConvInput = document.getElementById('searchInConvInput');
const closeSearch = document.getElementById('closeSearch');

if (searchInConvBtn) {
  searchInConvBtn.addEventListener('click', () => {
    searchInConv.style.display = searchInConv.style.display === 'none' ? 'flex' : 'none';
  });
}

if (closeSearch) {
  closeSearch.addEventListener('click', () => { searchInConv.style.display = 'none'; });
}

if (searchInConvInput) {
  searchInConvInput.addEventListener('input', async () => {
    const q = searchInConvInput.value.trim();
    if (q.length < 2) return;
    const res = await fetch(`/api/search/messages/${activeConversationId}?q=${encodeURIComponent(q)}`, { credentials: 'same-origin' });
    const data = await res.json();
    console.log('Search results:', data);
  });
}

// ==================== FILTRES ET PANNEAUX LATÉRAUX ====================
// Les attributs data gardent les filtres découplés du rendu serveur.
document.querySelectorAll('.filter-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    const filter = chip.dataset.filter;
    document.querySelectorAll('.filter-chip').forEach(item => item.classList.toggle('active', item === chip));
    document.querySelectorAll('.conversation-item').forEach(item => {
      const visible = filter === 'all'
        || (filter === 'group' && item.dataset.type === 'group')
        || (filter === 'unread' && item.dataset.unread === 'true')
        || (filter === 'favorites' && item.dataset.favorite === 'true');
      item.hidden = !visible;
    });
  });
});

function openSidebarPanel(panel) {
  document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
  const target = document.getElementById(`tab-${panel}`);
  if (!target) return;
  target.classList.add('active');
  if (panel === 'archived') loadArchived();
  if (panel === 'calls') loadCalls();
  if (panel === 'notifications') loadNotifications();
}

// Le menu rassemble les fonctions secondaires sans surcharger la liste de discussions.
const appMenuBtn = document.getElementById('appMenuBtn');
const appMenu = document.getElementById('appMenu');
if (appMenuBtn && appMenu) {
  appMenuBtn.addEventListener('click', event => {
    event.stopPropagation();
    appMenu.style.display = appMenu.style.display === 'block' ? 'none' : 'block';
  });
  appMenu.addEventListener('click', event => event.stopPropagation());
  document.addEventListener('click', () => { appMenu.style.display = 'none'; });
}
document.querySelectorAll('[data-sidebar-panel]').forEach(button => {
  button.addEventListener('click', () => {
    openSidebarPanel(button.dataset.sidebarPanel);
    if (appMenu) appMenu.style.display = 'none';
  });
});

async function loadArchived() {
  try {
    const res = await fetch('/api/archived', { credentials: 'same-origin' });
    const data = await res.json();
    const container = document.getElementById('tab-archived');
    if (data.conversations && data.conversations.length > 0) {
      container.innerHTML = '';
      data.conversations.forEach(c => {
        container.innerHTML += `<a href="/chat/${c.conversation_id}" class="conversation-item"><div class="conv-avatar"><div class="avatar-placeholder"><i class="fas fa-${c.type === 'group' ? 'users' : 'user'}"></i></div></div><div class="conv-info"><span class="conv-name">${c.name || 'Discussion'}</span></div></a>`;
      });
    } else {
      container.innerHTML = '<div class="empty-state"><i class="fas fa-archive"></i><p>Aucune discussion archivée</p></div>';
    }
  } catch (err) { console.error(err); }
}

async function loadCalls() {
  try {
    const res = await fetch('/api/calls', { credentials: 'same-origin' });
    const data = await res.json();
    const container = document.getElementById('tab-calls');
    if (data.calls && data.calls.length > 0) {
      container.innerHTML = '';
      data.calls.forEach(c => {
        const icon = c.call_type === 'video' ? 'video' : 'phone';
        const statusIcon = c.status === 'missed' ? 'phone-slash' : icon;
        const color = c.status === 'missed' ? '#e74c3c' : '#009999';
        container.innerHTML += `<div class="call-item"><i class="fas fa-${statusIcon}" style="color:${color}"></i><div class="call-info"><span>${c.call_type === 'video' ? 'Appel vidéo' : 'Appel audio'}</span><span class="call-time">${new Date(c.created_at).toLocaleString('fr-FR')}</span></div></div>`;
      });
    } else {
      container.innerHTML = '<div class="empty-state"><i class="fas fa-phone"></i><p>Aucun appel récent</p></div>';
    }
  } catch (err) { console.error(err); }
}

async function loadNotifications() {
  try {
    const res = await fetch('/api/notifications', { credentials: 'same-origin' });
    const data = await res.json();
    const container = document.getElementById('tab-notifications');
    if (data.notifications && data.notifications.length > 0) {
      container.innerHTML = '';
      data.notifications.forEach(n => {
        const icon = n.type === 'call' ? 'phone' : n.type === 'mention' ? 'at' : 'comment';
        const div = document.createElement('div');
        div.className = `notif-item ${n.is_read ? '' : 'unread'}`;
        div.style.cursor = n.conversation_id ? 'pointer' : 'default';
        div.innerHTML = `
          <i class="fas fa-${icon}"></i>
          <div>
            <span class="notif-title">${n.title}</span>
            <span class="notif-body">${n.body || ''}</span>
            <span class="notif-time">${new Date(n.created_at).toLocaleString('fr-FR')}</span>
          </div>
        `;
        if (n.conversation_id) {
          div.addEventListener('click', () => {
            window.location.href = `/chat/${n.conversation_id}`;
          });
        }
        container.appendChild(div);
      });
    } else {
      container.innerHTML = '<div class="empty-state"><i class="fas fa-bell"></i><p>Aucune notification</p></div>';
    }
  } catch (err) { console.error(err); }
}

// ==================== GLOBAL SEARCH ====================
const globalSearch = document.getElementById('globalSearch');
if (globalSearch) {
  globalSearch.addEventListener('input', async () => {
    const q = globalSearch.value.trim();
    if (q.length < 2) return;
    document.querySelectorAll('.conversation-item').forEach(item => {
      const name = item.querySelector('.conv-name')?.textContent.toLowerCase() || '';
      item.style.display = name.includes(q.toLowerCase()) ? '' : 'none';
    });
  });
}

// ==================== NOTIFICATIONS ====================
function showNotification(title, body) {
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification(title, { body, icon: '/favicon.ico' });
  }
}

if ('Notification' in window && Notification.permission === 'default') {
  Notification.requestPermission();
}

// ==================== MOBILE ====================
const mobileBack = document.getElementById('mobileBack');
if (mobileBack) {
  mobileBack.addEventListener('click', () => {
    document.getElementById('sidebar').classList.remove('hidden-mobile');
    document.querySelector('.chat-main').classList.remove('active-mobile');
  });
}

// ==================== VOICE PLAYBACK ====================
document.addEventListener('click', (e) => {
  const playBtn = e.target.closest('.voice-play-btn');
  if (!playBtn) return;

  const audio = playBtn.parentElement.querySelector('audio');
  if (!audio) return;

  if (audio.paused) {
    audio.play();
    playBtn.innerHTML = '<i class="fas fa-pause"></i>';
    audio.addEventListener('ended', () => { playBtn.innerHTML = '<i class="fas fa-play"></i>'; }, { once: true });
  } else {
    audio.pause();
    playBtn.innerHTML = '<i class="fas fa-play"></i>';
  }
});

// ==================== MODALS ====================
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.style.display = 'none';
  });
});
