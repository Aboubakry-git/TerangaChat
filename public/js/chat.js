const socket = io();
const currentUserId = window.currentUserId;
const currentUsername = window.currentUsername;
let activeConversationId = window.activeConversationId;
let activeConversationType = window.activeConversationType;
let otherUserId = window.otherUserId || '';
let typingTimeout = null;
let isTyping = false;
let replyToId = null;
let editingMessageId = null;
let profileModalUserId = null;

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

function escapeHtmlClient(text) {
  if (!text) return '';
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
  return String(text).replace(/[&<>"']/g, (m) => map[m]);
}

function getInitialsClient(name) {
  if (!name) return '?';
  const parts = String(name).trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.substring(0, 2).toUpperCase();
}

function renderPresenceHtml(label, isOnline) {
  if (!label) return '<span class="presence-text"></span>';
  return `<span class="presence-text${isOnline ? ' online' : ''}">${escapeHtmlClient(label)}</span>`;
}

function updateHeaderPresence(label, isOnline) {
  const statusEl = document.getElementById('presenceStatus');
  if (!statusEl || activeConversationType !== 'private') return;
  statusEl.innerHTML = renderPresenceHtml(label, isOnline);
}

function updateProfileModalPresence(label, isOnline) {
  const el = document.getElementById('userProfilePresence');
  if (!el) return;
  el.innerHTML = renderPresenceHtml(label, isOnline);
  el.classList.toggle('is-online', !!isOnline);
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
  updateConversationPreview(data);
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
  if (!data || !data.userId) return;
  if (otherUserId && data.userId.toString() === otherUserId.toString()) {
    updateHeaderPresence(data.label || '', data.isOnline);
  }
  if (profileModalUserId && data.userId.toString() === profileModalUserId.toString()) {
    updateProfileModalPresence(data.label || '', data.isOnline);
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
  msgEl.dataset.messageId = data.messageId;

  if (data.messageType === 'system') {
    msgEl.className = 'message system';
    msgEl.innerHTML = `<div class="system-message">${data.content || ''}</div>`;
    container.appendChild(msgEl);
    return;
  }

  msgEl.className = 'message ' + (data.senderId === currentUserId ? 'outgoing' : 'incoming');

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
  html += `<div class="message-reactions" data-message-id="${data.messageId}"></div>`;
  html += buildReactionBarHtml();
  html += `<div class="message-actions-menu">
    <button class="msg-action" data-action="reply" title="Répondre"><i class="fas fa-reply"></i></button>
    <button class="msg-action" data-action="react" title="Réagir"><i class="fas fa-smile"></i></button>
    <button class="msg-action" data-action="edit"><i class="fas fa-edit"></i></button>
    <button class="msg-action" data-action="delete"><i class="fas fa-trash"></i></button>
  </div>`;

  msgEl.innerHTML = html;
  container.appendChild(msgEl);
}

const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
const FULL_REACTIONS = [
  '👍', '❤️', '😂', '😮', '😢', '🙏', '🔥', '👏', '🎉', '😍',
  '🥰', '😊', '😎', '🤔', '😭', '😡', '💯', '✨', '💪', '🤝',
  '✅', '❌', '⭐', '🚀', '👀', '🙌', '😘', '🤗', '😴', '🤯',
  '🥳', '💀', '🫡', '💔', '💖', '😜',
];

function buildReactionBarHtml() {
  let html = '<div class="reaction-bar" aria-label="Réagir">';
  QUICK_REACTIONS.forEach((e) => {
    html += `<button type="button" class="reaction-quick-btn" data-emoji="${e}">${e}</button>`;
  });
  html += '<button type="button" class="reaction-quick-btn reaction-more-btn" data-action="more-reactions" title="Plus"><i class="fas fa-plus"></i></button>';
  html += '</div>';
  return html;
}

function renderReactionBadges(container, reactions) {
  if (!container) return;
  if (!reactions || reactions.length === 0) {
    container.innerHTML = '';
    return;
  }
  container.innerHTML = reactions.map((r) => `
    <button type="button" class="reaction-badge${r.reactedByMe ? ' mine' : ''}" data-emoji="${escapeHtmlClient(r.emoji)}" title="${escapeHtmlClient(r.emoji)}">
      <span class="reaction-emoji">${r.emoji}</span>
      <span class="reaction-count">${r.count}</span>
    </button>
  `).join('');
}

function applyReactionLocally(messageId, emoji, userId, added) {
  const msgEl = document.querySelector(`.message[data-message-id="${messageId}"]`);
  if (!msgEl) return;
  const container = msgEl.querySelector('.message-reactions');
  if (!container) return;

  const badges = {};
  container.querySelectorAll('.reaction-badge').forEach((btn) => {
    const e = btn.dataset.emoji;
    badges[e] = {
      emoji: e,
      count: parseInt(btn.querySelector('.reaction-count')?.textContent || '0', 10),
      reactedByMe: btn.classList.contains('mine'),
    };
  });

  const isMe = userId.toString() === currentUserId.toString();

  if (added) {
    // One reaction per user: clear mine from other emojis
    if (isMe) {
      Object.keys(badges).forEach((e) => {
        if (e !== emoji && badges[e].reactedByMe) {
          badges[e].reactedByMe = false;
          badges[e].count = Math.max(0, badges[e].count - 1);
          if (badges[e].count === 0) delete badges[e];
        }
      });
    }
    if (!badges[emoji]) badges[emoji] = { emoji, count: 0, reactedByMe: false };
    if (isMe && badges[emoji].reactedByMe) {
      // already counted
    } else {
      badges[emoji].count += 1;
      if (isMe) badges[emoji].reactedByMe = true;
    }
  } else {
    if (!badges[emoji]) return;
    badges[emoji].count = Math.max(0, badges[emoji].count - 1);
    if (isMe) badges[emoji].reactedByMe = false;
    if (badges[emoji].count === 0) delete badges[emoji];
  }

  renderReactionBadges(container, Object.values(badges));
}

async function toggleReaction(messageId, emoji) {
  if (!activeConversationId || !messageId || !emoji) return;
  try {
    const res = await fetch(`/api/messages/${encodeURIComponent(messageId)}/react`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ conversationId: activeConversationId, emoji }),
    });
    const data = await res.json();
    if (!res.ok) {
      console.error('Reaction failed:', data.error);
      return;
    }
    const msgEl = document.querySelector(`.message[data-message-id="${messageId}"]`);
    if (msgEl && data.reactions) {
      renderReactionBadges(msgEl.querySelector('.message-reactions'), data.reactions);
    }
  } catch (err) {
    console.error('Reaction error:', err);
  }
}

let reactionPaletteMessageId = null;

function openReactionPalette(messageId) {
  reactionPaletteMessageId = messageId;
  const modal = document.getElementById('reactionPaletteModal');
  const grid = document.getElementById('reactionPaletteGrid');
  if (!modal || !grid) return;
  grid.innerHTML = '';
  FULL_REACTIONS.forEach((emoji) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'reaction-palette-btn';
    btn.textContent = emoji;
    btn.dataset.emoji = emoji;
    grid.appendChild(btn);
  });
  modal.style.display = 'flex';
}

socket.on('reaction:added', (data) => {
  if (!data || data.conversationId !== activeConversationId) return;
  if (data.userId === currentUserId) return; // already updated via API response
  applyReactionLocally(data.messageId, data.emoji, data.userId, true);
});

socket.on('reaction:removed', (data) => {
  if (!data || data.conversationId !== activeConversationId) return;
  if (data.userId === currentUserId) return;
  applyReactionLocally(data.messageId, data.emoji, data.userId, false);
});

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
  const reactionBadge = e.target.closest('.reaction-badge');
  if (reactionBadge) {
    const msgEl = reactionBadge.closest('.message');
    if (msgEl) toggleReaction(msgEl.dataset.messageId, reactionBadge.dataset.emoji);
    return;
  }

  const quickBtn = e.target.closest('.reaction-quick-btn');
  if (quickBtn) {
    const msgEl = quickBtn.closest('.message');
    if (!msgEl) return;
    if (quickBtn.dataset.action === 'more-reactions') {
      openReactionPalette(msgEl.dataset.messageId);
      return;
    }
    toggleReaction(msgEl.dataset.messageId, quickBtn.dataset.emoji);
    return;
  }

  const paletteBtn = e.target.closest('.reaction-palette-btn');
  if (paletteBtn && reactionPaletteMessageId) {
    const emoji = paletteBtn.dataset.emoji;
    const modal = document.getElementById('reactionPaletteModal');
    if (modal) modal.style.display = 'none';
    toggleReaction(reactionPaletteMessageId, emoji);
    reactionPaletteMessageId = null;
    return;
  }

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
  } else if (action === 'react') {
    msgEl.classList.add('show-reactions');
    openReactionPalette(messageId);
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

// ==================== NEW GROUP (étape 1) + ADD MEMBERS (étape 2) ====================
const newGroupBtn = document.getElementById('newGroupBtn');
const newGroupModal = document.getElementById('newGroupModal');
const createGroupBtn = document.getElementById('createGroupBtn');
const groupAvatarInput = document.getElementById('groupAvatarInput');
const groupAvatarPreview = document.getElementById('groupAvatarPreview');

const addMembersModal = document.getElementById('addMembersModal');
const addMemberSearch = document.getElementById('addMemberSearch');
const addMemberResults = document.getElementById('addMemberResults');
const addSelectedMembersEl = document.getElementById('addSelectedMembers');
const confirmAddMembersBtn = document.getElementById('confirmAddMembersBtn');
let pendingAddMembers = [];
let addMembersTargetConvId = null;
const currentUserRole = window.currentUserRole || '';

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
    reader.onload = (event) => {
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

if (newGroupBtn) {
  newGroupBtn.addEventListener('click', () => {
    if (newGroupModal) newGroupModal.style.display = 'flex';
  });
}

if (createGroupBtn) {
  createGroupBtn.addEventListener('click', async () => {
    const name = document.getElementById('groupName')?.value.trim();
    const description = document.getElementById('groupDescription')?.value.trim();
    if (!name) return alert('Nom du groupe requis');

    try {
      createGroupBtn.disabled = true;
      const avatarUrl = await uploadGroupAvatar();
      const res = await fetch('/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'group', name, description, avatarUrl }),
        credentials: 'same-origin',
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || 'Erreur lors de la création du groupe');
        return;
      }
      if (data.conversationId) {
        window.location.href = `/chat/${data.conversationId}?addMembers=1`;
      }
    } catch (err) {
      console.error('Create group error:', err);
      alert('Erreur lors de la création du groupe');
    } finally {
      createGroupBtn.disabled = false;
    }
  });
}

function openAddMembersModal(conversationId) {
  addMembersTargetConvId = conversationId || activeConversationId;
  pendingAddMembers = [];
  renderPendingAddMembers();
  if (addMemberSearch) addMemberSearch.value = '';
  if (addMemberResults) addMemberResults.innerHTML = '';
  if (addMembersModal) addMembersModal.style.display = 'flex';
  addMemberSearch?.focus();
}

function renderPendingAddMembers() {
  if (!addSelectedMembersEl) return;
  addSelectedMembersEl.innerHTML = '';
  pendingAddMembers.forEach((m, i) => {
    const el = document.createElement('div');
    el.className = 'selected-member-chip';
    const label = document.createElement('span');
    label.textContent = m.username;
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.setAttribute('aria-label', 'Retirer');
    removeBtn.innerHTML = '<i class="fas fa-times"></i>';
    removeBtn.addEventListener('click', () => {
      pendingAddMembers.splice(i, 1);
      renderPendingAddMembers();
    });
    el.appendChild(label);
    el.appendChild(removeBtn);
    addSelectedMembersEl.appendChild(el);
  });
}

if (addMemberSearch) {
  addMemberSearch.addEventListener('input', async () => {
    const q = addMemberSearch.value.trim();
    if (q.length < 2) { addMemberResults.innerHTML = ''; return; }
    try {
      const res = await fetch(`/api/search/users?q=${encodeURIComponent(q)}`, { credentials: 'same-origin' });
      const data = await res.json();
      addMemberResults.innerHTML = '';
      (data.users || []).forEach((u) => {
        if (u.user_id === currentUserId) return;
        if (pendingAddMembers.find((m) => m.user_id === u.user_id)) return;
        const el = document.createElement('div');
        el.className = 'search-result-item';
        el.innerHTML = `
          <div class="result-avatar">${u.avatar_url ? `<img src="${escapeHtmlClient(u.avatar_url)}" alt="">` : `<div class="avatar-placeholder">${escapeHtmlClient((u.username || '?').substring(0, 2).toUpperCase())}</div>`}</div>
          <div class="result-info"><span class="result-name">${escapeHtmlClient(u.username)}</span></div>
          <i class="fas fa-plus"></i>
        `;
        el.addEventListener('click', () => {
          pendingAddMembers.push(u);
          renderPendingAddMembers();
          addMemberSearch.value = '';
          addMemberResults.innerHTML = '';
        });
        addMemberResults.appendChild(el);
      });
    } catch (err) {
      console.error(err);
    }
  });
}

if (confirmAddMembersBtn) {
  confirmAddMembersBtn.addEventListener('click', async () => {
    const convId = addMembersTargetConvId || activeConversationId;
    if (!convId) return;
    if (pendingAddMembers.length === 0) {
      addMembersModal.style.display = 'none';
      return;
    }
    try {
      confirmAddMembersBtn.disabled = true;
      const res = await fetch(`/api/conversations/${convId}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ userIds: pendingAddMembers.map((m) => m.user_id) }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || 'Erreur');
        return;
      }
      addMembersModal.style.display = 'none';
      pendingAddMembers = [];
      if (convId === activeConversationId) {
        // System messages arrive via socket; refresh member count in header
        const statusEl = document.getElementById('presenceStatus');
        if (statusEl && activeConversationType === 'group') {
          // Soft reload to refresh member list count
          window.location.href = `/chat/${convId}`;
        }
      } else {
        window.location.href = `/chat/${convId}`;
      }
    } catch (err) {
      console.error('Add members error:', err);
      alert('Erreur lors de l\'ajout des membres');
    } finally {
      confirmAddMembersBtn.disabled = false;
    }
  });
}

// Auto-open add-members after group creation
(function autoOpenAddMembers() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('addMembers') === '1' && activeConversationId && activeConversationType === 'group') {
    openAddMembersModal(activeConversationId);
    window.history.replaceState({}, '', `/chat/${activeConversationId}`);
  }
})();

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
    await openGroupInfoModal();
  });
}

const manageMembersBtn = document.getElementById('manageMembersBtn');
if (manageMembersBtn) {
  manageMembersBtn.addEventListener('click', () => openGroupInfoModal());
}

const addMemberBtn = document.getElementById('addMemberBtn');
if (addMemberBtn) {
  addMemberBtn.addEventListener('click', () => openAddMembersModal(activeConversationId));
}

const leaveGroupBtn = document.getElementById('leaveGroupBtn');
if (leaveGroupBtn) {
  leaveGroupBtn.addEventListener('click', async () => {
    if (!activeConversationId) return;
    if (!confirm('Quitter ce groupe ?')) return;
    try {
      const res = await fetch(`/api/conversations/${activeConversationId}/members/${currentUserId}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || 'Erreur');
        return;
      }
      window.location.href = '/chat';
    } catch (err) {
      console.error(err);
      alert('Erreur');
    }
  });
}

async function openGroupInfoModal() {
  if (!activeConversationId) return;
  const body = document.getElementById('convInfoBody');
  const modal = document.getElementById('convInfoModal');
  if (!body || !modal) return;

  body.innerHTML = '<p class="user-profile-loading">Chargement…</p>';
  modal.style.display = 'flex';

  try {
    const res = await fetch(`/api/conversations/${activeConversationId}/members`, { credentials: 'same-origin' });
    const data = await res.json();
    if (!res.ok) {
      body.innerHTML = `<p class="user-profile-error">${escapeHtmlClient(data.error || 'Erreur')}</p>`;
      return;
    }

    const group = data.group || {};
    const isAdmin = !!data.isAdmin;
    let html = '';

    if (activeConversationType === 'group') {
      html += `<div class="group-info-header">
        <h4>${escapeHtmlClient(group.name || 'Groupe')}</h4>
        ${group.description ? `<p class="group-info-desc">${escapeHtmlClient(group.description)}</p>` : ''}
        <p class="group-info-meta">${group.memberCount || data.members?.length || 0} participants</p>
        <p class="group-info-roles-hint">
          <strong>Admin</strong> : ajouter/retirer des membres, gérer le groupe.<br>
          <strong>Membre</strong> : envoyer des messages, quitter le groupe.
        </p>
      </div>`;
    }

    html += '<h4 class="group-members-title">Membres</h4><div class="group-members-list">';
    (data.members || []).forEach((m) => {
      const uid = m.user_id.toString();
      const name = m.full_name || m.username || 'Utilisateur';
      const roleBadge = m.role === 'admin'
        ? '<span class="badge-role badge-admin">Admin</span>'
        : '<span class="badge-role">Membre</span>';
      const presence = isAdmin && m.presence_label
        ? `<span class="member-presence">${escapeHtmlClient(m.presence_label)}</span>`
        : '';
      const canRemove = isAdmin && uid !== currentUserId && m.role !== 'admin';
      html += `<div class="member-item" data-user-id="${escapeHtmlClient(uid)}">
        <div class="member-avatar">${m.avatar_url ? `<img src="${escapeHtmlClient(m.avatar_url)}" alt="">` : `<div class="avatar-placeholder">${escapeHtmlClient(getInitialsClient(name))}</div>`}</div>
        <div class="member-info">
          <span class="member-name">${escapeHtmlClient(name)} ${roleBadge}</span>
          <span class="member-username">@${escapeHtmlClient(m.username || '')}</span>
          ${presence}
        </div>
        ${canRemove ? `<button type="button" class="icon-btn member-remove-btn" data-user-id="${escapeHtmlClient(uid)}" title="Retirer"><i class="fas fa-user-minus"></i></button>` : ''}
      </div>`;
    });
    html += '</div>';

    if (isAdmin) {
      html += `<div class="group-info-actions">
        <button type="button" class="btn btn-primary" id="groupInfoAddMembersBtn"><i class="fas fa-user-plus"></i> Ajouter des membres</button>
      </div>`;
    }

    body.innerHTML = html;

    body.querySelector('#groupInfoAddMembersBtn')?.addEventListener('click', () => {
      modal.style.display = 'none';
      openAddMembersModal(activeConversationId);
    });

    body.querySelectorAll('.member-remove-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const uid = btn.getAttribute('data-user-id');
        if (!uid || !confirm('Retirer ce membre du groupe ?')) return;
        btn.disabled = true;
        try {
          const r = await fetch(`/api/conversations/${activeConversationId}/members/${uid}`, {
            method: 'DELETE',
            credentials: 'same-origin',
          });
          const d = await r.json();
          if (!r.ok) {
            alert(d.error || 'Erreur');
            btn.disabled = false;
            return;
          }
          openGroupInfoModal();
        } catch (err) {
          console.error(err);
          btn.disabled = false;
        }
      });
    });
  } catch (err) {
    console.error(err);
    body.innerHTML = '<p class="user-profile-error">Erreur de chargement</p>';
  }
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

document.querySelectorAll('[data-close-modal]').forEach(btn => {
  btn.addEventListener('click', () => {
    const id = btn.getAttribute('data-close-modal');
    const modal = document.getElementById(id);
    if (modal) modal.style.display = 'none';
    if (id === 'userProfileModal') profileModalUserId = null;
  });
});

// ==================== USER PROFILE MODAL ====================
async function openUserProfileModal(userId) {
  if (!userId) return;
  profileModalUserId = userId.toString();
  const modal = document.getElementById('userProfileModal');
  const body = document.getElementById('userProfileBody');
  if (!modal || !body) return;

  body.innerHTML = '<div class="user-profile-loading">Chargement…</div>';
  modal.style.display = 'flex';

  try {
    const res = await fetch(`/api/users/${encodeURIComponent(userId)}`, { credentials: 'same-origin' });
    const data = await res.json();
    if (!res.ok || !data.user) {
      body.innerHTML = `<div class="user-profile-error">${escapeHtmlClient(data.error || 'Impossible de charger le profil')}</div>`;
      return;
    }
    renderUserProfileBody(data.user);
  } catch (err) {
    console.error('Profile modal error:', err);
    body.innerHTML = '<div class="user-profile-error">Erreur de chargement</div>';
  }
}

function renderUserProfileBody(user) {
  const body = document.getElementById('userProfileBody');
  if (!body) return;

  const displayName = user.fullName || user.username || 'Utilisateur';
  const initials = getInitialsClient(displayName);
  const avatarHtml = user.avatarUrl
    ? `<img src="${escapeHtmlClient(user.avatarUrl)}" alt="" class="user-profile-avatar-img">`
    : `<div class="avatar-placeholder user-profile-avatar-img">${escapeHtmlClient(initials)}</div>`;

  const statusHtml = user.statusText
    ? `<p class="user-profile-status-text">${escapeHtmlClient(user.statusText)}</p>`
    : '';

  let actionsHtml = '';
  if (!user.isSelf) {
    actionsHtml = user.isBlocked
      ? `<button type="button" class="btn btn-outline-danger" id="userProfileUnblockBtn" data-user-id="${escapeHtmlClient(user.userId)}">
           <i class="fas fa-unlock"></i> Débloquer
         </button>`
      : `<button type="button" class="btn btn-outline-danger" id="userProfileBlockBtn" data-user-id="${escapeHtmlClient(user.userId)}">
           <i class="fas fa-ban"></i> Bloquer
         </button>`;
  }

  body.innerHTML = `
    <div class="user-profile-card">
      <div class="user-profile-avatar">${avatarHtml}</div>
      <h2 class="user-profile-name">${escapeHtmlClient(displayName)}</h2>
      <p class="user-profile-username">@${escapeHtmlClient(user.username || '')}</p>
      <div class="user-profile-presence" id="userProfilePresence">
        ${renderPresenceHtml(user.presenceLabel || '', user.isOnline)}
      </div>
      ${statusHtml}
      <div class="user-profile-actions">${actionsHtml}</div>
    </div>
  `;

  const blockBtn = document.getElementById('userProfileBlockBtn');
  if (blockBtn) {
    blockBtn.addEventListener('click', async () => {
      const uid = blockBtn.getAttribute('data-user-id');
      if (!uid || !confirm('Bloquer cet utilisateur ?')) return;
      blockBtn.disabled = true;
      try {
        await fetch(`/profile/block/${encodeURIComponent(uid)}`, {
          method: 'POST',
          credentials: 'same-origin',
        });
        openUserProfileModal(uid);
      } catch (err) {
        console.error(err);
        blockBtn.disabled = false;
      }
    });
  }

  const unblockBtn = document.getElementById('userProfileUnblockBtn');
  if (unblockBtn) {
    unblockBtn.addEventListener('click', async () => {
      const uid = unblockBtn.getAttribute('data-user-id');
      if (!uid) return;
      unblockBtn.disabled = true;
      try {
        await fetch(`/profile/unblock/${encodeURIComponent(uid)}`, {
          method: 'POST',
          credentials: 'same-origin',
        });
        openUserProfileModal(uid);
      } catch (err) {
        console.error(err);
        unblockBtn.disabled = false;
      }
    });
  }
}

function formatSidebarPreview(data) {
  if (!data) return { text: 'Aucun message', empty: true };
  if (data.isDeleted || data.deleted) {
    return {
      text: data.senderId === currentUserId ? 'Vous : Ce message a été supprimé' : 'Ce message a été supprimé',
      empty: false,
    };
  }
  let text;
  switch (data.messageType || data.type) {
    case 'image':
      text = '📷 Photo';
      break;
    case 'video':
      text = '🎥 Vidéo';
      break;
    case 'file':
      text = `📎 ${data.fileName || data.file_name || 'Fichier'}`;
      break;
    case 'voice':
      text = '🎤 Message vocal';
      break;
    case 'system':
      text = (data.content || '').slice(0, 40);
      break;
    default:
      text = (data.content || '').slice(0, 40);
      break;
  }
  if (data.senderId === currentUserId && (data.messageType || data.type) !== 'system') {
    text = `Vous : ${text}`;
  }
  return { text: text || 'Aucun message', empty: false };
}

function updateConversationPreview(data) {
  const convId = data.conversationId;
  if (!convId) return;
  const item = document.querySelector(`.conversation-item[data-id="${convId}"]`);
  if (!item) return;
  const preview = formatSidebarPreview(data);
  const previewEl = item.querySelector('.conv-preview');
  if (previewEl) {
    previewEl.textContent = preview.text;
    previewEl.classList.toggle('conv-preview--empty', preview.empty);
  }
  const timeEl = item.querySelector('.conv-time');
  if (timeEl) {
    const d = data.createdAt ? new Date(data.createdAt) : new Date();
    timeEl.textContent = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    timeEl.setAttribute('datetime', d.toISOString());
  }
  // Remonter la conversation en tête de liste
  const list = item.parentElement;
  if (list && list.firstElementChild !== item) {
    list.insertBefore(item, list.firstElementChild);
  }
}

// ==================== STORIES (ouvrir le compositeur) ====================
function openStoryComposerModal() {
  if (typeof window.openStoryComposer === 'function') {
    window.openStoryComposer();
    return;
  }
  const modal = document.getElementById('storyComposerModal');
  if (modal) modal.style.display = 'flex';
}

document.querySelectorAll('[data-action="add-story"]').forEach((el) => {
  el.addEventListener('click', openStoryComposerModal);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openStoryComposerModal();
    }
  });
});

const statusHeaderBtn = document.getElementById('statusHeaderBtn');
if (statusHeaderBtn) {
  statusHeaderBtn.addEventListener('click', openStoryComposerModal);
}

const chatHeaderInfo = document.getElementById('chatHeaderInfo');
if (chatHeaderInfo && otherUserId) {
  const openProfile = () => openUserProfileModal(otherUserId);
  chatHeaderInfo.addEventListener('click', openProfile);
  chatHeaderInfo.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openProfile();
    }
  });
}
