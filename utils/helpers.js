const { v4: uuidv4 } = require('uuid');
const cassandra = require('cassandra-driver');

function generateId() {
  return uuidv4();
}

function generateTimeUUID() {
  return cassandra.types.TimeUuid.now();
}

function formatDate(date) {
  if (!date) return '';
  const d = new Date(date);
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function formatTime(date) {
  if (!date) return '';
  const d = new Date(date);
  return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

function formatDateTime(date) {
  if (!date) return '';
  const now = new Date();
  const d = new Date(date);
  const diff = now - d;
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));

  if (days === 0) {
    return formatTime(date);
  } else if (days === 1) {
    return 'Hier';
  } else if (days < 7) {
    const dayNames = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];
    return dayNames[d.getDay()];
  } else {
    return formatDate(date);
  }
}

function formatDuration(seconds) {
  if (!seconds) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function formatFileSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
}

function getInitials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return name.substring(0, 2).toUpperCase();
}

function validatePassword(password) {
  if (password.length < 8) return 'Le mot de passe doit contenir au moins 8 caractères';
  if (!/[A-Z]/.test(password)) return 'Le mot de passe doit contenir au moins une majuscule';
  if (!/[0-9]/.test(password)) return 'Le mot de passe doit contenir au moins un chiffre';
  if (!/[^A-Za-z0-9]/.test(password)) return 'Le mot de passe doit contenir au moins un caractère spécial';
  return null;
}

function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validateUsername(username) {
  return /^[a-zA-Z0-9_]{3,20}$/.test(username);
}

function escapeHtml(text) {
  if (!text) return '';
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
  return String(text).replace(/[&<>"']/g, (m) => map[m]);
}

/** Relative last-seen label (FR), e.g. "il y a 5 min". */
function formatLastSeen(date) {
  if (!date) return '';
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  const diffMs = Date.now() - d.getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "à l'instant";
  if (mins < 60) return `il y a ${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `il y a ${hours} h`;
  const days = Math.floor(hours / 24);
  if (days === 1) return `hier à ${formatTime(d)}`;
  if (days < 7) return `il y a ${days} j`;
  return formatDate(d);
}

/**
 * Sanitize presence for public view (respects hide_online / hide_last_seen).
 * Returns { isOnline, lastSeen, label }.
 */
function buildPublicPresence(user) {
  if (!user) {
    return { isOnline: false, lastSeen: null, label: '' };
  }
  const hideOnline = !!user.hide_online;
  const hideLastSeen = !!user.hide_last_seen;
  const actuallyOnline = !!user.is_online;
  const isOnline = actuallyOnline && !hideOnline;
  const lastSeen = hideLastSeen ? null : (user.last_seen || null);

  let label = '';
  if (isOnline) {
    label = 'En ligne';
  } else if (lastSeen) {
    label = `Vu ${formatLastSeen(lastSeen)}`;
  } else if (!hideOnline || !hideLastSeen) {
    label = 'Hors ligne';
  }

  return { isOnline, lastSeen, label };
}

module.exports = {
  generateId,
  generateTimeUUID,
  formatDate,
  formatTime,
  formatDateTime,
  formatDuration,
  formatFileSize,
  formatLastSeen,
  buildPublicPresence,
  getInitials,
  validatePassword,
  validateEmail,
  validateUsername,
  escapeHtml,
};
