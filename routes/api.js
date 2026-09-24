const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const config = require('../config');
const { execute, batch } = require('../config/database');
const { generateId, generateTimeUUID, escapeHtml, buildPublicPresence } = require('../utils/helpers');

const ALLOWED_REACTIONS = new Set([
  '👍', '❤️', '😂', '😮', '😢', '🙏', '🔥', '👏', '🎉', '😍',
  '🥰', '😊', '😎', '🤔', '😭', '😡', '💯', '✨', '💪', '🤝',
  '✅', '❌', '⭐', '🚀', '👀', '🙌', '😘', '🤗', '😴', '🤯',
  '🥳', '💀', '🫡', '💔', '💖', '😜',
]);

function aggregateReactions(rows, currentUserId) {
  const byEmoji = new Map();
  const uid = currentUserId.toString();
  for (const row of rows) {
    const emoji = row.emoji;
    if (!byEmoji.has(emoji)) {
      byEmoji.set(emoji, { emoji, count: 0, reactedByMe: false });
    }
    const entry = byEmoji.get(emoji);
    entry.count += 1;
    if (row.user_id.toString() === uid) entry.reactedByMe = true;
  }
  return Array.from(byEmoji.values());
}

async function assertConversationMember(userId, conversationId) {
  const check = await execute(
    'SELECT user_id FROM conversation_members WHERE conversation_id = ? AND user_id = ?',
    [conversationId, userId]
  );
  return check.rows.length > 0;
}

async function getUserReactions(messageId, userId) {
  const result = await execute(
    'SELECT emoji FROM message_reactions WHERE message_id = ? AND user_id = ?',
    [messageId, userId]
  );
  return result.rows.map((r) => r.emoji);
}

async function loadReactionSummary(messageId, currentUserId) {
  const result = await execute(
    'SELECT user_id, emoji FROM message_reactions WHERE message_id = ?',
    [messageId]
  );
  return aggregateReactions(result.rows, currentUserId);
}

async function getMemberRole(conversationId, userId) {
  const result = await execute(
    'SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?',
    [conversationId, userId]
  );
  return result.rows[0]?.role || null;
}

/**
 * Insert a system message in a conversation and broadcast it.
 * Used for group membership events (create / add / leave / remove).
 */
async function insertSystemMessage(req, conversationId, content, actorId) {
  const messageId = generateTimeUUID();
  const now = new Date();
  const safeContent = escapeHtml(content);

  await execute(
    `INSERT INTO messages (conversation_id, message_id, sender_id, content, message_type, file_url, file_name, file_size, mime_type, duration, reply_to_id, is_edited, is_deleted, deleted_for_everyone, is_ephemeral, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [conversationId, messageId, actorId, safeContent, 'system',
     null, null, null, null, null, null, false, false, false, false, null, now, now]
  );
  await execute('UPDATE conversations SET updated_at = ? WHERE conversation_id = ?', [now, conversationId]);

  const payload = {
    messageId: messageId.toString(),
    senderId: actorId.toString(),
    senderName: null,
    content: safeContent,
    messageType: 'system',
    createdAt: now,
    conversationId,
  };

  const io = req.app.get('io');
  if (io) io.to(`conv:${conversationId}`).emit('message:receive', payload);
  return payload;
}

async function notifyUser(req, { userId, type, title, body, conversationId, actorId }) {
  const now = new Date();
  const notifId = generateId();
  await execute(
    'INSERT INTO notifications (user_id, notification_id, type, title, body, conversation_id, actor_id, is_read, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [userId, notifId, type, title, body, conversationId, actorId, false, now]
  );
  await execute(
    'INSERT INTO notifications_by_user_date (user_id, created_at, notification_id, type, title, body, conversation_id, actor_id, is_read) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [userId, now, notifId, type, title, body, conversationId, actorId, false]
  );
  await execute('UPDATE unread_notifications_count SET count = count + 1 WHERE user_id = ?', [userId]);

  const io = req.app.get('io');
  if (io) {
    io.to(`user:${userId.toString()}`).emit('notification:new', {
      notificationId: notifId,
      type,
      title,
      body,
      conversationId,
      actorId: actorId?.toString?.() || actorId,
    });
  }
}

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

// ==================== PUBLIC USER PROFILE (presence-aware) ====================
router.get('/users/:userId', async (req, res) => {
  try {
    const targetId = req.params.userId;
    const result = await execute(
      `SELECT user_id, username, full_name, avatar_url, status_text,
              is_online, last_seen, hide_online, hide_last_seen
       FROM users WHERE user_id = ?`,
      [targetId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Utilisateur introuvable' });
    }

    const u = result.rows[0];
    const presence = buildPublicPresence(u);

    let isBlocked = false;
    const blocked = await execute(
      'SELECT blocked_id FROM blocked_users WHERE blocker_id = ? AND blocked_id = ?',
      [req.userId, targetId]
    );
    isBlocked = blocked.rows.length > 0;

    res.json({
      user: {
        userId: u.user_id.toString(),
        username: u.username,
        fullName: u.full_name,
        avatarUrl: u.avatar_url,
        statusText: u.status_text,
        isOnline: presence.isOnline,
        lastSeen: presence.lastSeen,
        presenceLabel: presence.label,
        isBlocked,
        isSelf: u.user_id.toString() === req.userId.toString(),
      },
    });
  } catch (err) {
    console.error('Get user error:', err);
    res.status(500).json({ error: 'Erreur' });
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
      if (!name || !String(name).trim()) {
        return res.status(400).json({ error: 'Nom du groupe requis' });
      }

      // Flux WhatsApp : création avec l'admin seul. Les membres s'ajoutent ensuite.
      const groupAvatarUrl = typeof avatarUrl === 'string' && avatarUrl.startsWith('/uploads/files/')
        ? avatarUrl
        : null;

      const conversationId = generateId();
      const now = new Date();
      const safeName = escapeHtml(String(name).trim());
      const safeDescription = escapeHtml(description || '');

      await batch([
        { query: 'INSERT INTO conversations (conversation_id, type, name, description, avatar_url, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          params: [conversationId, 'group', safeName, safeDescription, groupAvatarUrl, userId, now, now] },
        { query: 'INSERT INTO conversation_members (conversation_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)',
          params: [conversationId, userId, 'admin', now] },
        { query: 'INSERT INTO user_conversations (user_id, conversation_id, type, last_read_at, archived) VALUES (?, ?, ?, ?, ?)',
          params: [userId, conversationId, 'group', now, false] },
      ]);

      const actorResult = await execute('SELECT username, full_name FROM users WHERE user_id = ?', [userId]);
      const actorName = actorResult.rows[0]?.full_name || actorResult.rows[0]?.username || 'Un admin';
      await insertSystemMessage(
        req,
        conversationId,
        `${actorName} a créé le groupe « ${String(name).trim()} »`,
        userId
      );

      res.json({ conversationId, openAddMembers: true });
    } else {
      res.status(400).json({ error: 'Type invalide' });
    }
  } catch (err) {
    console.error('Create conversation error:', err);
    res.status(500).json({ error: 'Erreur' });
  }
});

// ==================== MEMBERS ====================
// Admin : voit tout + peut ajouter/retirer. Membre : infos publiques du groupe uniquement.
router.get('/conversations/:conversationId/members', async (req, res) => {
  try {
    const conversationId = req.params.conversationId;
    const myRole = await getMemberRole(conversationId, req.userId);
    if (!myRole) return res.status(403).json({ error: 'Accès refusé' });

    const isAdmin = myRole === 'admin';
    const convResult = await execute(
      'SELECT conversation_id, type, name, description, avatar_url, created_by, created_at FROM conversations WHERE conversation_id = ?',
      [conversationId]
    );
    const conv = convResult.rows[0];
    if (!conv) return res.status(404).json({ error: 'Conversation introuvable' });

    const membersResult = await execute(
      'SELECT user_id, role, joined_at FROM conversation_members WHERE conversation_id = ?',
      [conversationId]
    );
    const members = [];
    for (const m of membersResult.rows) {
      const r = await execute(
        `SELECT user_id, username, full_name, avatar_url, status_text, is_online, last_seen, hide_online, hide_last_seen
         FROM users WHERE user_id = ?`,
        [m.user_id]
      );
      if (!r.rows[0]) continue;
      const u = r.rows[0];
      const publicMember = {
        user_id: u.user_id,
        username: u.username,
        full_name: u.full_name,
        avatar_url: u.avatar_url,
        role: m.role,
      };
      if (isAdmin) {
        const presence = buildPublicPresence(u);
        publicMember.is_online = presence.isOnline;
        publicMember.presence_label = presence.label;
        publicMember.status_text = u.status_text;
        publicMember.joined_at = m.joined_at;
      }
      members.push(publicMember);
    }

    res.json({
      myRole,
      isAdmin,
      group: {
        conversationId: conv.conversation_id,
        name: conv.name,
        description: isAdmin ? conv.description : (conv.description || null),
        avatarUrl: conv.avatar_url,
        // Membres : infos publiques seulement (pas created_by détaillé)
        memberCount: members.length,
      },
      members,
      // Droits documentés pour l'UI
      permissions: {
        canAddMembers: isAdmin,
        canRemoveMembers: isAdmin,
        canRename: isAdmin,
        canLeave: true,
        canSendMessages: true,
      },
    });
  } catch (err) {
    console.error('Get members error:', err);
    res.status(500).json({ error: 'Erreur' });
  }
});

router.post('/conversations/:conversationId/members', async (req, res) => {
  try {
    const conversationId = req.params.conversationId;
    const actorId = req.userId;
    const myRole = await getMemberRole(conversationId, actorId);
    if (myRole !== 'admin') {
      return res.status(403).json({ error: 'Seul un admin peut ajouter des membres' });
    }

    const ids = [];
    if (Array.isArray(req.body.userIds)) ids.push(...req.body.userIds);
    if (req.body.userId) ids.push(req.body.userId);
    const uniqueIds = [...new Set(ids.map((id) => id.toString()))].filter((id) => id !== actorId.toString());
    if (uniqueIds.length === 0) {
      return res.status(400).json({ error: 'Aucun membre à ajouter' });
    }

    const convResult = await execute(
      'SELECT name FROM conversations WHERE conversation_id = ?',
      [conversationId]
    );
    const groupName = convResult.rows[0]?.name || 'le groupe';
    const actorResult = await execute('SELECT username, full_name FROM users WHERE user_id = ?', [actorId]);
    const actorName = actorResult.rows[0]?.full_name || actorResult.rows[0]?.username || 'Un admin';

    const added = [];
    for (const newUserId of uniqueIds) {
      const already = await getMemberRole(conversationId, newUserId);
      if (already) continue;

      const now = new Date();
      await batch([
        { query: 'INSERT INTO conversation_members (conversation_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)',
          params: [conversationId, newUserId, 'member', now] },
        { query: 'INSERT INTO user_conversations (user_id, conversation_id, type, last_read_at, archived) VALUES (?, ?, ?, ?, ?)',
          params: [newUserId, conversationId, 'group', null, false] },
      ]);

      const memberResult = await execute('SELECT username, full_name FROM users WHERE user_id = ?', [newUserId]);
      const memberName = memberResult.rows[0]?.full_name || memberResult.rows[0]?.username || 'un utilisateur';

      await insertSystemMessage(
        req,
        conversationId,
        `${actorName} a ajouté ${memberName}`,
        actorId
      );

      await notifyUser(req, {
        userId: newUserId,
        type: 'group_invite',
        title: groupName,
        body: `${actorName} vous a ajouté au groupe ${groupName}`,
        conversationId,
        actorId,
      });

      added.push(newUserId);
    }

    res.json({ success: true, added });
  } catch (err) {
    console.error('Add member error:', err);
    res.status(500).json({ error: 'Erreur' });
  }
});

router.delete('/conversations/:conversationId/members/:userId', async (req, res) => {
  try {
    const conversationId = req.params.conversationId;
    const targetId = req.params.userId;
    const actorId = req.userId;
    const myRole = await getMemberRole(conversationId, actorId);
    const isSelf = actorId.toString() === targetId.toString();

    if (!isSelf && myRole !== 'admin') {
      return res.status(403).json({ error: 'Seul un admin peut retirer un membre' });
    }
    if (!(await getMemberRole(conversationId, targetId))) {
      return res.status(404).json({ error: 'Membre introuvable' });
    }

    await execute('DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?',
      [conversationId, targetId]);
    await execute('DELETE FROM user_conversations WHERE user_id = ? AND conversation_id = ?',
      [targetId, conversationId]);

    const actorResult = await execute('SELECT username, full_name FROM users WHERE user_id = ?', [actorId]);
    const actorName = actorResult.rows[0]?.full_name || actorResult.rows[0]?.username || 'Quelqu\'un';
    const targetResult = await execute('SELECT username, full_name FROM users WHERE user_id = ?', [targetId]);
    const targetName = targetResult.rows[0]?.full_name || targetResult.rows[0]?.username || 'un membre';

    const content = isSelf
      ? `${actorName} a quitté le groupe`
      : `${actorName} a retiré ${targetName}`;
    await insertSystemMessage(req, conversationId, content, actorId);

    res.json({ success: true });
  } catch (err) {
    console.error('Remove member error:', err);
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

// ==================== MESSAGE REACTIONS ====================
router.post('/messages/:messageId/react', async (req, res) => {
  try {
    const { conversationId, emoji } = req.body;
    const messageId = req.params.messageId;
    const userId = req.userId;

    if (!conversationId || !emoji) {
      return res.status(400).json({ error: 'conversationId et emoji requis' });
    }
    if (!ALLOWED_REACTIONS.has(emoji)) {
      return res.status(400).json({ error: 'Emoji non autorisé' });
    }
    if (!(await assertConversationMember(userId, conversationId))) {
      return res.status(403).json({ error: 'Accès refusé' });
    }

    const existing = await getUserReactions(messageId, userId);
    const io = req.app.get('io');

    // Same emoji → toggle off
    if (existing.includes(emoji)) {
      await execute(
        'DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?',
        [messageId, userId, emoji]
      );
      if (io) {
        io.to(`conv:${conversationId}`).emit('reaction:removed', {
          conversationId,
          messageId: messageId.toString(),
          userId: userId.toString(),
          emoji,
        });
      }
      const reactions = await loadReactionSummary(messageId, userId);
      return res.json({ action: 'removed', emoji, reactions });
    }

    // One reaction per user: remove previous emoji(s)
    for (const prev of existing) {
      await execute(
        'DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?',
        [messageId, userId, prev]
      );
      if (io) {
        io.to(`conv:${conversationId}`).emit('reaction:removed', {
          conversationId,
          messageId: messageId.toString(),
          userId: userId.toString(),
          emoji: prev,
        });
      }
    }

    const now = new Date();
    await execute(
      'INSERT INTO message_reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)',
      [messageId, userId, emoji, now]
    );

    if (io) {
      io.to(`conv:${conversationId}`).emit('reaction:added', {
        conversationId,
        messageId: messageId.toString(),
        userId: userId.toString(),
        emoji,
        createdAt: now,
      });
    }

    const reactions = await loadReactionSummary(messageId, userId);
    res.json({ action: 'added', emoji, reactions });
  } catch (err) {
    console.error('React error:', err);
    res.status(500).json({ error: 'Erreur' });
  }
});

router.delete('/messages/:messageId/react', async (req, res) => {
  try {
    const { conversationId, emoji } = req.body;
    const messageId = req.params.messageId;
    const userId = req.userId;

    if (!conversationId || !emoji) {
      return res.status(400).json({ error: 'conversationId et emoji requis' });
    }
    if (!(await assertConversationMember(userId, conversationId))) {
      return res.status(403).json({ error: 'Accès refusé' });
    }

    await execute(
      'DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?',
      [messageId, userId, emoji]
    );

    const io = req.app.get('io');
    if (io) {
      io.to(`conv:${conversationId}`).emit('reaction:removed', {
        conversationId,
        messageId: messageId.toString(),
        userId: userId.toString(),
        emoji,
      });
    }

    const reactions = await loadReactionSummary(messageId, userId);
    res.json({ action: 'removed', emoji, reactions });
  } catch (err) {
    console.error('Unreact error:', err);
    res.status(500).json({ error: 'Erreur' });
  }
});

router.get('/messages/:messageId/reactions', async (req, res) => {
  try {
    const { conversationId } = req.query;
    if (!conversationId) return res.status(400).json({ error: 'conversationId requis' });
    if (!(await assertConversationMember(req.userId, conversationId))) {
      return res.status(403).json({ error: 'Accès refusé' });
    }
    const reactions = await loadReactionSummary(req.params.messageId, req.userId);
    res.json({ reactions });
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
