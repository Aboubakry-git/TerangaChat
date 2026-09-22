const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const config = require('../config');
const { execute, batch } = require('../config/database');
const { generateId, escapeHtml } = require('../utils/helpers');

const fileStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(config.uploadDir, 'files');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname.replace(/\s/g, '_')}`);
  },
});

const fileUpload = multer({
  storage: fileStorage,
  limits: { fileSize: config.maxFileSize },
});

// ==================== SEARCH USERS ====================
router.get('/search/users', async (req, res) => {
  try {
    const q = req.query.q;
    if (!q || q.length < 2) return res.json({ users: [] });

    const result = await execute('SELECT username, user_id, full_name, avatar_url FROM users_by_username');
    const filtered = result.rows.filter(u =>
      u.username.toLowerCase().includes(q.toLowerCase()) ||
      (u.full_name && u.full_name.toLowerCase().includes(q.toLowerCase()))
    ).slice(0, 20);
    res.json({ users: filtered });
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: 'Erreur de recherche' });
  }
});

// ==================== SEARCH MESSAGES ====================
router.get('/search/messages/:conversationId', async (req, res) => {
  try {
    const q = req.query.q;
    if (!q || q.length < 2) return res.json({ messages: [] });

    const result = await execute(
      'SELECT message_id, content, sender_id, created_at FROM messages WHERE conversation_id = ?',
      [req.params.conversationId]
    );
    const filtered = result.rows
      .filter(m => m.content && m.content.toLowerCase().includes(q.toLowerCase()))
      .slice(0, 20);
    res.json({ messages: filtered });
  } catch (err) {
    res.status(500).json({ error: 'Erreur' });
  }
});

// ==================== CREATE CONVERSATION ====================
router.post('/conversations', async (req, res) => {
  try {
    const userId = req.userId;
    const { type, name, description, memberIds, avatarUrl } = req.body;

    if (type === 'private') {
      const otherId = memberIds[0];
      if (!otherId) return res.status(400).json({ error: 'Destinataire requis' });

      const existing = await execute(
        'SELECT conversation_id FROM user_conversations WHERE user_id = ?',
        [userId]
      );
      for (const row of existing.rows) {
        const convResult = await execute('SELECT type FROM conversations WHERE conversation_id = ?', [row.conversation_id]);
        if (convResult.rows[0] && convResult.rows[0].type === 'private') {
          const members = await execute('SELECT user_id FROM conversation_members WHERE conversation_id = ?', [row.conversation_id]);
          const memberIdsList = members.rows.map(m => m.user_id.toString());
          if (memberIdsList.includes(otherId.toString()) && memberIdsList.includes(userId.toString())) {
            return res.json({ conversationId: row.conversation_id });
          }
        }
      }

      const conversationId = generateId();
      const now = new Date();
      const queries = [
        { query: 'INSERT INTO conversations (conversation_id, type, name, description, avatar_url, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          params: [conversationId, 'private', null, null, null, userId, now, now] },
        { query: 'INSERT INTO conversation_members (conversation_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)',
          params: [conversationId, userId, 'admin', now] },
        { query: 'INSERT INTO conversation_members (conversation_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)',
          params: [conversationId, otherId, 'member', now] },
        { query: 'INSERT INTO user_conversations (user_id, conversation_id, type, last_read_at, archived) VALUES (?, ?, ?, ?, ?)',
          params: [userId, conversationId, 'private', now, false] },
        { query: 'INSERT INTO user_conversations (user_id, conversation_id, type, last_read_at, archived) VALUES (?, ?, ?, ?, ?)',
          params: [otherId, conversationId, 'private', null, false] },
      ];
      await batch(queries);
      res.json({ conversationId });
    } else if (type === 'group') {
      if (!name) return res.status(400).json({ error: 'Nom du groupe requis' });
      if (!memberIds || memberIds.length === 0) return res.status(400).json({ error: 'Au moins un membre requis' });

      // Seules les images envoyées via l'endpoint local d'upload peuvent être utilisées.
      const groupAvatarUrl = typeof avatarUrl === 'string' && avatarUrl.startsWith('/uploads/files/')
        ? avatarUrl
        : null;

      const conversationId = generateId();
      const now = new Date();
      let queries = [
        { query: 'INSERT INTO conversations (conversation_id, type, name, description, avatar_url, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          params: [conversationId, 'group', escapeHtml(name), escapeHtml(description || ''), groupAvatarUrl, userId, now, now] },
        { query: 'INSERT INTO conversation_members (conversation_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)',
          params: [conversationId, userId, 'admin', now] },
        { query: 'INSERT INTO user_conversations (user_id, conversation_id, type, last_read_at, archived) VALUES (?, ?, ?, ?, ?)',
          params: [userId, conversationId, 'group', now, false] },
      ];

      for (const memberId of memberIds) {
        queries.push(
          { query: 'INSERT INTO conversation_members (conversation_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)',
            params: [conversationId, memberId, 'member', now] },
          { query: 'INSERT INTO user_conversations (user_id, conversation_id, type, last_read_at, archived) VALUES (?, ?, ?, ?, ?)',
            params: [memberId, conversationId, 'group', null, false] }
        );
      }
      await batch(queries);
      res.json({ conversationId });
    } else {
      res.status(400).json({ error: 'Type invalide' });
    }
  } catch (err) {
    console.error('Create conversation error:', err);
    res.status(500).json({ error: 'Erreur' });
  }
});

// ==================== MEMBERS ====================
router.get('/conversations/:conversationId/members', async (req, res) => {
  try {
    const membersResult = await execute(
      'SELECT user_id, role FROM conversation_members WHERE conversation_id = ?',
      [req.params.conversationId]
    );
    const members = [];
    for (let i = 0; i < membersResult.rows.length; i++) {
      const m = membersResult.rows[i];
      const r = await execute(
        'SELECT user_id, username, full_name, avatar_url, is_online FROM users WHERE user_id = ?',
        [m.user_id]
      );
      if (r.rows[0]) members.push({ ...r.rows[0], role: m.role });
    }
    res.json({ members });
  } catch (err) {
    res.status(500).json({ error: 'Erreur' });
  }
});

router.post('/conversations/:conversationId/members', async (req, res) => {
  try {
    const { userId: newUserId } = req.body;
    const now = new Date();
    await batch([
      { query: 'INSERT INTO conversation_members (conversation_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)',
        params: [req.params.conversationId, newUserId, 'member', now] },
      { query: 'INSERT INTO user_conversations (user_id, conversation_id, type, last_read_at, archived) VALUES (?, ?, ?, ?, ?)',
        params: [newUserId, req.params.conversationId, 'group', null, false] },
    ]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erreur' });
  }
});

router.delete('/conversations/:conversationId/members/:userId', async (req, res) => {
  try {
    await execute('DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?',
      [req.params.conversationId, req.params.userId]);
    await execute('DELETE FROM user_conversations WHERE user_id = ? AND conversation_id = ?',
      [req.params.userId, req.params.conversationId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erreur' });
  }
});

// ==================== UPLOAD ====================
router.post('/upload', fileUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Aucun fichier' });
  res.json({
    url: `/uploads/files/${req.file.filename}`,
    fileName: req.file.originalname,
    fileSize: req.file.size,
    mimeType: req.file.mimetype,
  });
});

// ==================== ARCHIVE ====================
router.post('/conversations/:conversationId/archive', async (req, res) => {
  try {
    await execute('UPDATE user_conversations SET archived = ? WHERE user_id = ? AND conversation_id = ?',
      [true, req.userId, req.params.conversationId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erreur' });
  }
});

router.post('/conversations/:conversationId/unarchive', async (req, res) => {
  try {
    await execute('UPDATE user_conversations SET archived = ? WHERE user_id = ? AND conversation_id = ?',
      [false, req.userId, req.params.conversationId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erreur' });
  }
});

router.get('/archived', async (req, res) => {
  try {
    const result = await execute(
      'SELECT conversation_id, archived FROM user_conversations WHERE user_id = ?',
      [req.userId]
    );
    const archivedIds = result.rows.filter(r => r.archived).map(r => r.conversation_id);
    const archived = [];
    for (const cid of archivedIds) {
      const r = await execute('SELECT conversation_id, type, name, avatar_url FROM conversations WHERE conversation_id = ?', [cid]);
      if (r.rows[0]) archived.push(r.rows[0]);
    }
    res.json({ conversations: archived });
  } catch (err) {
    res.status(500).json({ error: 'Erreur' });
  }
});

// ==================== CALLS ====================
router.get('/calls', async (req, res) => {
  try {
    const result = await execute(
      'SELECT call_id, conversation_id, caller_id, call_type, status, duration, created_at FROM call_history_by_user WHERE user_id = ? LIMIT 50',
      [req.userId]
    );
    res.json({ calls: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Erreur' });
  }
});

// ==================== NOTIFICATIONS ====================
router.get('/notifications', async (req, res) => {
  try {
    const result = await execute(
      'SELECT notification_id, type, title, body, conversation_id, actor_id, is_read, created_at FROM notifications_by_user_date WHERE user_id = ? LIMIT 50',
      [req.userId]
    );
    res.json({ notifications: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Erreur' });
  }
});

router.post('/notifications/:notificationId/read', async (req, res) => {
  try {
    const { createdAt } = req.body;
    await execute(
      'UPDATE notifications SET is_read = true WHERE user_id = ? AND notification_id = ?',
      [req.userId, req.params.notificationId]
    );
    if (createdAt) {
      await execute(
        'UPDATE notifications_by_user_date SET is_read = true WHERE user_id = ? AND created_at = ? AND notification_id = ?',
        [req.userId, new Date(createdAt), req.params.notificationId]
      );
    }
    await execute('UPDATE unread_notifications_count SET count = count - 1 WHERE user_id = ?', [req.userId]).catch(() => {});
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erreur' });
  }
});

// ==================== EXPORT ====================
router.get('/conversations/:conversationId/export', async (req, res) => {
  try {
    const messages = await execute(
      'SELECT sender_id, content, message_type, created_at FROM messages WHERE conversation_id = ?',
      [req.params.conversationId]
    );
    const sorted = messages.rows.reverse();
    let text = '=== Export de conversation ===\n\n';
    for (const msg of sorted) {
      const userResult = await execute('SELECT username FROM users WHERE user_id = ?', [msg.sender_id]);
      const username = userResult.rows[0]?.username || 'Inconnu';
      const date = new Date(msg.created_at).toLocaleString('fr-FR');
      text += `[${date}] ${username}: ${msg.content || `[${msg.message_type}]`}\n`;
    }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="conversation.txt"');
    res.send(text);
  } catch (err) {
    res.status(500).json({ error: 'Erreur' });
  }
});

module.exports = router;
