const { execute, batch } = require('../config/database');
const { generateId, generateTimeUUID, escapeHtml } = require('../utils/helpers');

function setupSocket(io) {
  const userSockets = new Map(); // userId (string) -> socket.id
  const userSocketIds = new Map(); // socket.id -> userId (string)

  io.on('connection', (socket) => {
    console.log('Socket connected:', socket.id);

    socket.on('user:join', async (userId) => {
      const uid = userId.toString();
      socket.userId = uid;
      userSockets.set(uid, socket.id);
      userSocketIds.set(socket.id, uid);

      await execute('UPDATE users SET is_online = true, last_seen = ? WHERE user_id = ?', [new Date(), uid]);
      io.emit('presence:update', { userId: uid, isOnline: true });
    });

    socket.on('conversation:open', async (conversationId) => {
      socket.join(`conv:${conversationId}`);
      if (socket.userId) {
        await execute(
          'UPDATE user_conversations SET last_read_at = ? WHERE user_id = ? AND conversation_id = ?',
          [new Date(), socket.userId, conversationId]
        );
      }
    });

    socket.on('conversation:close', (conversationId) => {
      socket.leave(`conv:${conversationId}`);
    });

    // ==================== MESSAGES ====================
    socket.on('message:send', async (data) => {
      try {
        const { conversationId, content, messageType, fileUrl, fileName, fileSize, mimeType, duration, replyToId } = data;
        if (!socket.userId) return;

        const messageId = generateTimeUUID();
        const now = new Date();
        const safeContent = content ? escapeHtml(content) : null;

        await execute(
          `INSERT INTO messages (conversation_id, message_id, sender_id, content, message_type, file_url, file_name, file_size, mime_type, duration, reply_to_id, is_edited, is_deleted, deleted_for_everyone, is_ephemeral, expires_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [conversationId, messageId, socket.userId, safeContent, messageType || 'text',
           fileUrl || null, fileName || null, fileSize || null, mimeType || null, duration || null,
           replyToId || null, false, false, false, false, null, now, now]
        );

        // Index par contenu
        if (safeContent) {
          await execute(
            'INSERT INTO messages_by_content (conversation_id, message_id, content, sender_id, created_at) VALUES (?, ?, ?, ?, ?)',
            [conversationId, messageId, safeContent, socket.userId, now]
          );
        }

        await execute('UPDATE conversations SET updated_at = ? WHERE conversation_id = ?', [now, conversationId]);

        const userResult = await execute('SELECT username, full_name, avatar_url FROM users WHERE user_id = ?', [socket.userId]);
        const sender = userResult.rows[0] || {};

        const messageData = {
          messageId: messageId.toString(),
          senderId: socket.userId,
          senderName: sender.username,
          senderFullName: sender.full_name,
          senderAvatar: sender.avatar_url,
          content: safeContent,
          messageType: messageType || 'text',
          fileUrl, fileName, fileSize, mimeType, duration,
          replyToId: replyToId ? replyToId.toString() : null,
          createdAt: now,
          conversationId,
        };

        io.to(`conv:${conversationId}`).emit('message:receive', messageData);

        // Notifications
        const membersResult = await execute('SELECT user_id FROM conversation_members WHERE conversation_id = ?', [conversationId]);
        for (const member of membersResult.rows) {
          const memberId = member.user_id.toString();
          if (memberId !== socket.userId) {
            const notifId = generateId();
            await execute(
              'INSERT INTO notifications (user_id, notification_id, type, title, body, conversation_id, actor_id, is_read, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
              [memberId, notifId, 'message', sender.username || 'Utilisateur', safeContent || 'Nouveau message', conversationId, socket.userId, false, now]
            );
            await execute(
              'INSERT INTO notifications_by_user_date (user_id, created_at, notification_id, type, title, body, conversation_id, actor_id, is_read) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
              [memberId, now, notifId, 'message', sender.username || 'Utilisateur', safeContent || 'Nouveau message', conversationId, socket.userId, false]
            );
            await execute('UPDATE unread_notifications_count SET count = count + 1 WHERE user_id = ?', [memberId]);

            const targetSocketId = userSockets.get(memberId);
            if (targetSocketId) {
              io.to(targetSocketId).emit('notification:new', {
                notificationId: notifId,
                type: 'message',
                title: sender.username || 'Utilisateur',
                body: safeContent || 'Nouveau message',
                conversationId,
                createdAt: now,
              });
            }
          }
        }
      } catch (err) {
        console.error('message:send error:', err);
        socket.emit('error', { message: 'Erreur d\'envoi du message' });
      }
    });

    socket.on('message:edit', async (data) => {
      try {
        const { conversationId, messageId, content } = data;
        const safeContent = escapeHtml(content);
        const now = new Date();

        await execute(
          'UPDATE messages SET content = ?, is_edited = true, updated_at = ? WHERE conversation_id = ? AND message_id = ?',
          [safeContent, now, conversationId, messageId]
        );

        io.to(`conv:${conversationId}`).emit('message:edited', {
          messageId: messageId.toString(),
          content: safeContent,
          conversationId,
        });
      } catch (err) {
        console.error('message:edit error:', err);
      }
    });

    socket.on('message:delete', async (data) => {
      try {
        const { conversationId, messageId, deleteForEveryone } = data;
        const now = new Date();

        if (deleteForEveryone) {
          await execute(
            'UPDATE messages SET is_deleted = true, deleted_for_everyone = true, content = null, updated_at = ? WHERE conversation_id = ? AND message_id = ?',
            [now, conversationId, messageId]
          );
        } else {
          await execute(
            'UPDATE messages SET is_deleted = true, updated_at = ? WHERE conversation_id = ? AND message_id = ?',
            [now, conversationId, messageId]
          );
        }

        io.to(`conv:${conversationId}`).emit('message:deleted', {
          messageId: messageId.toString(),
          deleteForEveryone,
          conversationId,
        });
      } catch (err) {
        console.error('message:delete error:', err);
      }
    });

    socket.on('message:read', async (data) => {
      try {
        const { conversationId, messageId } = data;
        if (!socket.userId) return;
        const now = new Date();

        const existing = await execute(
          'SELECT user_id FROM message_read_receipts WHERE conversation_id = ? AND message_id = ? AND user_id = ?',
          [conversationId, messageId, socket.userId]
        );
        if (existing.rows.length === 0) {
          await execute(
            'INSERT INTO message_read_receipts (conversation_id, message_id, user_id, read_at) VALUES (?, ?, ?, ?)',
            [conversationId, messageId, socket.userId, now]
          );
        }

        io.to(`conv:${conversationId}`).emit('message:readReceipt', {
          messageId: messageId.toString(),
          userId: socket.userId,
          conversationId,
        });
      } catch (err) {
        console.error('message:read error:', err);
      }
    });

    // ==================== TYPING ====================
    socket.on('typing:start', (data) => {
      socket.to(`conv:${data.conversationId}`).emit('typing:start', {
        userId: socket.userId,
        conversationId: data.conversationId,
      });
    });

    socket.on('typing:stop', (data) => {
      socket.to(`conv:${data.conversationId}`).emit('typing:stop', {
        userId: socket.userId,
        conversationId: data.conversationId,
      });
    });

    // ==================== CALLS ====================
    socket.on('call:initiate', async (data) => {
      try {
        const { conversationId, callType, peerId } = data;
        const callId = generateId();
        const now = new Date();

        await execute(
          'INSERT INTO call_history (call_id, conversation_id, caller_id, caller_peer_id, call_type, status, duration, started_at, ended_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [callId, conversationId, socket.userId, peerId, callType, 'initiated', 0, now, null, now]
        );

        await execute(
          'INSERT INTO call_history_by_conversation (conversation_id, created_at, call_id, caller_id, call_type, status, duration) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [conversationId, now, callId, socket.userId, callType, 'initiated', 0]
        );

        const membersResult = await execute('SELECT user_id FROM conversation_members WHERE conversation_id = ?', [conversationId]);
        for (const member of membersResult.rows) {
          const memberId = member.user_id.toString();
          if (memberId !== socket.userId) {
            await execute(
              'INSERT INTO call_history_by_user (user_id, created_at, call_id, conversation_id, caller_id, call_type, status, duration) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
              [memberId, now, callId, conversationId, socket.userId, callType, 'initiated', 0]
            );
            const targetSocketId = userSockets.get(memberId);
            if (targetSocketId) {
              io.to(targetSocketId).emit('call:incoming', {
                callId,
                conversationId,
                callerId: socket.userId,
                callType,
                peerId,
              });
            }
          }
        }

        socket.emit('call:created', { callId });
      } catch (err) {
        console.error('call:initiate error:', err);
      }
    });

    socket.on('call:accept', (data) => {
      const { callId, conversationId, peerId } = data;
      io.to(`conv:${conversationId}`).emit('call:accepted', { callId, peerId, userId: socket.userId });
      execute('UPDATE call_history SET status = ? WHERE call_id = ?', ['answered', callId]).catch(() => {});
    });

    socket.on('call:reject', (data) => {
      const { callId, conversationId } = data;
      io.to(`conv:${conversationId}`).emit('call:rejected', { callId, userId: socket.userId });
      execute('UPDATE call_history SET status = ? WHERE call_id = ?', ['declined', callId]).catch(() => {});
    });

    socket.on('call:end', (data) => {
      const { callId, conversationId, duration } = data;
      io.to(`conv:${conversationId}`).emit('call:ended', { callId, userId: socket.userId });
      execute('UPDATE call_history SET status = ?, duration = ?, ended_at = ? WHERE call_id = ?',
        ['ended', duration || 0, new Date(), callId]).catch(() => {});
    });

    socket.on('call:missed', (data) => {
      const { callId } = data;
      execute('UPDATE call_history SET status = ? WHERE call_id = ?', ['missed', callId]).catch(() => {});
    });

    // ==================== DISCONNECT ====================
    socket.on('disconnect', async () => {
      const userId = userSocketIds.get(socket.id);
      if (userId) {
        userSockets.delete(userId);
        userSocketIds.delete(socket.id);
        await execute('UPDATE users SET is_online = false, last_seen = ? WHERE user_id = ?', [new Date(), userId]);
        io.emit('presence:update', { userId, isOnline: false, lastSeen: new Date() });
      }
    });
  });
}

module.exports = { setupSocket };
