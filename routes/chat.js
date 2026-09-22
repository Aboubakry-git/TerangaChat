const express = require('express');
const router = express.Router();
const { execute } = require('../config/database');
const { getInitials } = require('../utils/helpers');

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
          conv.name = other.rows[0].username;
          conv.avatar_url = other.rows[0].avatar_url;
          conv.full_name = other.rows[0].full_name;
        }
      }
    }
    conversations.push(conv);
  }

  return conversations;
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
      getInitials,
      user: req.user,
    });
  } catch (err) {
    console.error('Chat index error:', err);
    res.render('chat/index', {
      conversations: [],
      activeConversation: null,
      messages: [],
      activeMembers: [],
      getInitials,
      user: req.user,
    });
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
        'SELECT user_id, username, full_name, avatar_url, is_online, last_seen FROM users WHERE user_id = ?',
        [memberIds[i]]
      );
      if (r.rows[0]) {
        members.push({ ...r.rows[0], role: membersResult.rows[i].role });
      }
    }

    // Résoudre le nom si conversation privée
    if (activeConversation.type === 'private') {
      const otherMember = members.find(m => m.user_id.toString() !== userId.toString());
      if (otherMember) {
        activeConversation.name = otherMember.username;
        activeConversation.avatar_url = otherMember.avatar_url;
      }
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
      getInitials,
      user: req.user,
    });
  } catch (err) {
    console.error('Chat conversation error:', err);
    res.redirect('/chat');
  }
});

module.exports = router;
