const express = require('express');
const router = express.Router();
const { execute } = require('../config/database');
const { getInitials, buildPublicPresence } = require('../utils/helpers');

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

function formatConversationPreview(msg, userId) {
  if (!msg) {
    return { text: 'Aucun message', empty: true, at: null };
  }

  let text;
  if (msg.is_deleted) {
    text = 'Ce message a été supprimé';
  } else {
    switch (msg.message_type) {
      case 'image':
        text = '📷 Photo';
        break;
      case 'video':
        text = '🎥 Vidéo';
        break;
      case 'file':
        text = `📎 ${msg.file_name || 'Fichier'}`;
        break;
      case 'voice':
        text = '🎤 Message vocal';
        break;
      case 'system':
        text = (msg.content || '').slice(0, 40);
        break;
      default:
        text = (msg.content || '').slice(0, 40);
        break;
    }
  }

  const isMine = msg.sender_id && msg.sender_id.toString() === userId.toString();
  if (isMine && msg.message_type !== 'system') {
    text = `Vous : ${text}`;
  }

  return {
    text: text || 'Aucun message',
    empty: false,
    at: msg.created_at || null,
  };
}

async function loadConversationsWithDetails(userId) {
  const conversationsResult = await execute(
    'SELECT conversation_id FROM user_conversations WHERE user_id = ?',
    [userId]
  );

  const conversationIds = conversationsResult.rows.map(r => r.conversation_id);
  const conversations = [];

  for (const cid of conversationIds) {
    const convResult = await execute(
      'SELECT conversation_id, type, name, description, avatar_url, created_by, created_at FROM conversations WHERE conversation_id = ?',
      [cid]
    );
    if (convResult.rows.length === 0) continue;
    const conv = convResult.rows[0];

    // Si privée, résoudre le nom de l'autre participant
    if (conv.type === 'private') {
      const members = await execute(
        'SELECT user_id FROM conversation_members WHERE conversation_id = ?',
        [cid]
      );
      const otherMember = members.rows.find(m => m.user_id.toString() !== userId.toString());
      if (otherMember) {
        const other = await execute(
          'SELECT username, full_name, avatar_url FROM users WHERE user_id = ?',
          [otherMember.user_id]
        );
        if (other.rows[0]) {
          conv.name = other.rows[0].full_name || other.rows[0].username;
          conv.avatar_url = other.rows[0].avatar_url;
          conv.full_name = other.rows[0].full_name;
        }
      }
    }

    // Dernier message (clustering message_id DESC → LIMIT 1 = plus récent)
    try {
      const lastMsgResult = await execute(
        `SELECT sender_id, content, message_type, file_name, is_deleted, created_at
         FROM messages WHERE conversation_id = ? LIMIT 1`,
        [cid]
      );
      const lastMsg = lastMsgResult.rows[0] || null;
      const preview = formatConversationPreview(lastMsg, userId);
      conv.last_message = lastMsg;
      conv.preview_text = preview.text;
      conv.last_message_at = preview.at || conv.created_at;
    } catch (err) {
      conv.last_message = null;
      conv.preview_text = 'Aucun message';
      conv.last_message_at = conv.created_at;
    }

    conversations.push(conv);
  }

  conversations.sort((a, b) => {
    const ta = new Date(a.last_message_at || a.created_at || 0).getTime();
    const tb = new Date(b.last_message_at || b.created_at || 0).getTime();
    return tb - ta;
  });

  return conversations;
}

function emptyChatLocals(user) {
  return {
    conversations: [],
    activeConversation: null,
    messages: [],
    activeMembers: [],
    otherPeer: null,
    currentUserRole: null,
    getInitials,
    user,
  };
}

// GET /chat
router.get('/', async (req, res) => {
  try {
    const userId = req.user.user_id;
    const conversations = await loadConversationsWithDetails(userId);

    res.render('chat/index', {
      conversations,
      activeConversation: null,
      messages: [],
      activeMembers: [],
      otherPeer: null,
      currentUserRole: null,
      getInitials,
      user: req.user,
    });
  } catch (err) {
    console.error('Chat index error:', err);
    res.render('chat/index', emptyChatLocals(req.user));
  }
});

// GET /chat/:conversationId
router.get('/:conversationId', async (req, res) => {
  try {
    const userId = req.user.user_id;
    const conversationId = req.params.conversationId;

    const memberCheck = await execute(
      'SELECT user_id FROM conversation_members WHERE conversation_id = ? AND user_id = ?',
      [conversationId, userId]
    );
    if (memberCheck.rows.length === 0) {
      return res.redirect('/chat');
    }

    const convResult = await execute(
      'SELECT conversation_id, type, name, description, avatar_url, created_by, created_at FROM conversations WHERE conversation_id = ?',
      [conversationId]
    );
    if (convResult.rows.length === 0) return res.redirect('/chat');
    const activeConversation = convResult.rows[0];

    const membersResult = await execute(
      'SELECT user_id, role, joined_at FROM conversation_members WHERE conversation_id = ?',
      [conversationId]
    );
    const memberIds = membersResult.rows.map(m => m.user_id);
    const members = [];

    for (let i = 0; i < memberIds.length; i++) {
      const r = await execute(
        `SELECT user_id, username, full_name, avatar_url, status_text,
                is_online, last_seen, hide_online, hide_last_seen
         FROM users WHERE user_id = ?`,
        [memberIds[i]]
      );
      if (r.rows[0]) {
        members.push({ ...r.rows[0], role: membersResult.rows[i].role });
      }
    }

    let otherPeer = null;
    let currentUserRole = null;
    // Résoudre le nom si conversation privée
    if (activeConversation.type === 'private') {
      const otherMember = members.find(m => m.user_id.toString() !== userId.toString());
      if (otherMember) {
        activeConversation.name = otherMember.full_name || otherMember.username;
        activeConversation.avatar_url = otherMember.avatar_url;
        const presence = buildPublicPresence(otherMember);
        otherPeer = {
          userId: otherMember.user_id.toString(),
          username: otherMember.username,
          fullName: otherMember.full_name,
          avatarUrl: otherMember.avatar_url,
          statusText: otherMember.status_text,
          isOnline: presence.isOnline,
          lastSeen: presence.lastSeen,
          presenceLabel: presence.label,
        };
      }
    } else {
      const me = members.find(m => m.user_id.toString() === userId.toString());
      currentUserRole = me?.role || 'member';
    }

    const messagesResult = await execute(
      `SELECT message_id, sender_id, content, message_type, file_url, file_name, file_size, mime_type, duration, reply_to_id, is_edited, is_deleted, deleted_for_everyone, created_at
       FROM messages WHERE conversation_id = ? LIMIT 50`,
      [conversationId]
    );
    const messages = messagesResult.rows.reverse();

    // Ajouter le nom d'expéditeur pour chaque message (utile en groupe)
    const senderIds = [...new Set(messages.map(m => m.sender_id.toString()))];
    const senderMap = {};
    for (const sid of senderIds) {
      const u = await execute('SELECT username FROM users WHERE user_id = ?', [sid]);
      if (u.rows[0]) senderMap[sid] = u.rows[0].username;
    }
    messages.forEach(m => { m.sender_name = senderMap[m.sender_id.toString()] || 'Utilisateur'; });

    // Load reactions for displayed messages
    for (const msg of messages) {
      try {
        const reactResult = await execute(
          'SELECT user_id, emoji FROM message_reactions WHERE message_id = ?',
          [msg.message_id]
        );
        msg.reactions = aggregateReactions(reactResult.rows, userId);
      } catch (err) {
        msg.reactions = [];
      }
    }

    const conversations = await loadConversationsWithDetails(userId);

    await execute(
      'UPDATE user_conversations SET last_read_at = ? WHERE user_id = ? AND conversation_id = ?',
      [new Date(), userId, conversationId]
    );

    res.render('chat/index', {
      conversations,
      activeConversation,
      messages,
      activeMembers: members,
      otherPeer,
      currentUserRole,
      getInitials,
      user: req.user,
    });
  } catch (err) {
    console.error('Chat conversation error:', err);
    res.redirect('/chat');
  }
});

module.exports = router;
