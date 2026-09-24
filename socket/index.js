const { execute, batch } = require('../config/database');
const { generateId, generateTimeUUID, escapeHtml, buildPublicPresence } = require('../utils/helpers');

async function emitPresence(io, userId, isOnline) {
  const uid = userId.toString();
  const result = await execute(
    'SELECT is_online, last_seen, hide_online, hide_last_seen FROM users WHERE user_id = ?',
    [uid]
  );
  const row = result.rows[0] || {};
  const presence = buildPublicPresence({
    ...row,
    is_online: isOnline,
    last_seen: isOnline ? row.last_seen : (row.last_seen || new Date()),
  });
  io.emit('presence:update', {
    userId: uid,
    isOnline: presence.isOnline,
    lastSeen: presence.lastSeen,
    label: presence.label,
  });
}

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
      socket.join(`user:${uid}`);

      await execute('UPDATE users SET is_online = true, last_seen = ? WHERE user_id = ?', [new Date(), uid]);
      await emitPresence(io, uid, true);
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
    // Architecture:
    // - Signalisation Socket.IO via rooms user:<id> et call:<callId>
    // - Média WebRTC via PeerJS (P2P 1-à-1, mesh groupe ≤5)
    // - Persistance: call_sessions + call_participants (+ call_history legacy)

    const MAX_GROUP_CALL_PARTICIPANTS = 5;
    if (!io.activeCalls) io.activeCalls = new Map();

    async function getCallerMeta(userId) {
      const r = await execute('SELECT username, full_name, avatar_url FROM users WHERE user_id = ?', [userId]);
      const u = r.rows[0] || {};
      return {
        callerId: userId.toString(),
        callerName: u.full_name || u.username || 'Utilisateur',
        callerAvatar: u.avatar_url || null,
      };
    }

    function listActiveParticipants(call) {
      return Array.from(call.participants.entries())
        .filter(([, p]) => p.status === 'joined' || p.status === 'ringing')
        .map(([userId, p]) => ({
          userId,
          peerId: p.peerId,
          status: p.status,
          username: p.username,
        }));
    }

    socket.on('call:initiate', async (data) => {
      try {
        if (!socket.userId) {
          socket.emit('call:error', { message: 'Session non initialisée — rechargez la page' });
          return;
        }
        const { conversationId, callType, peerId } = data || {};
        if (!conversationId || !peerId) {
          socket.emit('call:error', { message: 'Données d\'appel invalides' });
          return;
        }

        const memberCheck = await execute(
          'SELECT user_id FROM conversation_members WHERE conversation_id = ? AND user_id = ?',
          [conversationId, socket.userId]
        );
        if (memberCheck.rows.length === 0) {
          socket.emit('call:error', { message: 'Vous n\'êtes pas membre de cette conversation' });
          return;
        }

        const convResult = await execute(
          'SELECT type, name FROM conversations WHERE conversation_id = ?',
          [conversationId]
        );
        const conv = convResult.rows[0];
        if (!conv) {
          socket.emit('call:error', { message: 'Conversation introuvable' });
          return;
        }

        const isGroup = conv.type === 'group';
        const callId = generateId();
        const now = new Date();
        const meta = await getCallerMeta(socket.userId);

        // Persistance best-effort — ne doit pas bloquer la signalisation
        await execute(
          'INSERT INTO call_sessions (call_id, conversation_id, initiator_id, call_type, status, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [callId, conversationId, socket.userId, callType || 'audio', 'ringing', now, null]
        ).catch((err) => console.warn('call_sessions insert:', err.message));
        await execute(
          'INSERT INTO call_participants (call_id, user_id, joined_at, left_at, status) VALUES (?, ?, ?, ?, ?)',
          [callId, socket.userId, now, null, 'joined']
        ).catch((err) => console.warn('call_participants insert:', err.message));
        await execute(
          'INSERT INTO call_history (call_id, conversation_id, caller_id, caller_peer_id, call_type, status, duration, started_at, ended_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [callId, conversationId, socket.userId, peerId, callType || 'audio', 'initiated', 0, now, null, now]
        ).catch(() => {});

        const call = {
          callId: callId.toString(),
          conversationId: conversationId.toString(),
          initiatorId: socket.userId,
          callType: callType || 'audio',
          isGroup,
          groupName: conv.name || 'Groupe',
          status: 'ringing',
          participants: new Map(),
          createdAt: now,
        };
        call.participants.set(socket.userId, {
          peerId,
          status: 'joined',
          username: meta.callerName,
        });
        io.activeCalls.set(call.callId, call);
        socket.join(`call:${call.callId}`);

        const membersResult = await execute(
          'SELECT user_id FROM conversation_members WHERE conversation_id = ?',
          [conversationId]
        );

        const payload = {
          callId: call.callId,
          conversationId: call.conversationId,
          callType: call.callType,
          isGroup,
          groupName: call.groupName,
          peerId,
          ...meta,
        };

        let notified = 0;
        for (const member of membersResult.rows) {
          const memberId = member.user_id.toString();
          if (memberId === socket.userId) continue;

          await execute(
            'INSERT INTO call_participants (call_id, user_id, joined_at, left_at, status) VALUES (?, ?, ?, ?, ?)',
            [callId, memberId, null, null, 'invited']
          ).catch(() => {});

          if (isGroup) {
            io.to(`user:${memberId}`).emit('call:group-invite', {
              ...payload,
              participantCount: 1,
            });
          } else {
            io.to(`user:${memberId}`).emit('call:incoming', payload);
          }
          notified += 1;
        }

        if (!isGroup && notified === 0) {
          socket.emit('call:error', { message: 'Aucun correspondant dans cette conversation' });
          io.activeCalls.delete(call.callId);
          return;
        }

        socket.emit('call:created', {
          callId: call.callId,
          conversationId: call.conversationId,
          callType: call.callType,
          isGroup,
        });
      } catch (err) {
        console.error('call:initiate error:', err);
        socket.emit('call:error', { message: "Impossible de démarrer l'appel" });
      }
    });

    socket.on('call:accept', async (data) => {
      try {
        if (!socket.userId) return;
        const { callId, peerId } = data || {};
        const call = io.activeCalls.get(callId);
        if (!call || call.status === 'ended') {
          socket.emit('call:error', { message: 'Appel terminé ou introuvable' });
          return;
        }
        if (call.isGroup) {
          socket.emit('call:error', { message: 'Utilisez call:join pour un appel de groupe' });
          return;
        }

        const now = new Date();
        const meta = await getCallerMeta(socket.userId);
        call.status = 'active';
        call.participants.set(socket.userId, {
          peerId,
          status: 'joined',
          username: meta.callerName,
        });
        socket.join(`call:${callId}`);

        await execute(
          'INSERT INTO call_participants (call_id, user_id, joined_at, left_at, status) VALUES (?, ?, ?, ?, ?)',
          [callId, socket.userId, now, null, 'joined']
        ).catch(() => {});
        await execute('UPDATE call_sessions SET status = ? WHERE call_id = ?', ['active', callId]).catch(() => {});
        await execute('UPDATE call_history SET status = ? WHERE call_id = ?', ['answered', callId]).catch(() => {});

        io.to(`user:${call.initiatorId}`).emit('call:accepted', {
          callId,
          conversationId: call.conversationId,
          peerId,
          userId: socket.userId,
          username: meta.callerName,
        });
        io.to(`call:${callId}`).emit('call:participant-joined', {
          callId,
          userId: socket.userId,
          peerId,
          username: meta.callerName,
          participants: listActiveParticipants(call),
        });
      } catch (err) {
        console.error('call:accept error:', err);
      }
    });

    socket.on('call:reject', async (data) => {
      try {
        if (!socket.userId) return;
        const { callId } = data || {};
        const call = io.activeCalls.get(callId);
        if (!call) return;

        await execute(
          'INSERT INTO call_participants (call_id, user_id, joined_at, left_at, status) VALUES (?, ?, ?, ?, ?)',
          [callId, socket.userId, null, new Date(), 'declined']
        ).catch(() => {});

        if (!call.isGroup) {
          call.status = 'ended';
          io.activeCalls.delete(callId);
          await execute('UPDATE call_sessions SET status = ?, ended_at = ? WHERE call_id = ?',
            ['declined', new Date(), callId]).catch(() => {});
          await execute('UPDATE call_history SET status = ? WHERE call_id = ?', ['declined', callId]).catch(() => {});
          io.to(`user:${call.initiatorId}`).emit('call:rejected', {
            callId,
            userId: socket.userId,
            conversationId: call.conversationId,
          });
        } else {
          io.to(`user:${call.initiatorId}`).emit('call:invite-ignored', {
            callId,
            userId: socket.userId,
          });
        }
      } catch (err) {
        console.error('call:reject error:', err);
      }
    });

    socket.on('call:join', async (data) => {
      try {
        if (!socket.userId) return;
        const { callId, peerId } = data || {};
        const call = io.activeCalls.get(callId);
        if (!call || call.status === 'ended') {
          socket.emit('call:error', { message: 'Appel terminé ou introuvable' });
          return;
        }

        const joinedCount = Array.from(call.participants.values())
          .filter((p) => p.status === 'joined').length;
        if (joinedCount >= MAX_GROUP_CALL_PARTICIPANTS) {
          socket.emit('call:error', {
            message: `Les appels de groupe sont limités à ${MAX_GROUP_CALL_PARTICIPANTS} participants pour le moment`,
            code: 'MAX_PARTICIPANTS',
          });
          return;
        }

        const now = new Date();
        const meta = await getCallerMeta(socket.userId);
        call.status = 'active';
        call.participants.set(socket.userId, {
          peerId,
          status: 'joined',
          username: meta.callerName,
        });
        socket.join(`call:${callId}`);

        await execute(
          'INSERT INTO call_participants (call_id, user_id, joined_at, left_at, status) VALUES (?, ?, ?, ?, ?)',
          [callId, socket.userId, now, null, 'joined']
        ).catch(() => {});
        await execute('UPDATE call_sessions SET status = ? WHERE call_id = ?', ['active', callId]).catch(() => {});

        const participants = listActiveParticipants(call);
        socket.emit('call:peers', {
          callId,
          participants: participants.filter((p) => p.userId !== socket.userId),
        });
        socket.to(`call:${callId}`).emit('call:participant-joined', {
          callId,
          userId: socket.userId,
          peerId,
          username: meta.callerName,
          participants,
        });

        const membersResult = await execute(
          'SELECT user_id FROM conversation_members WHERE conversation_id = ?',
          [call.conversationId]
        );
        for (const member of membersResult.rows) {
          const memberId = member.user_id.toString();
          if (call.participants.get(memberId)?.status === 'joined') continue;
          io.to(`user:${memberId}`).emit('call:group-invite', {
            callId: call.callId,
            conversationId: call.conversationId,
            callType: call.callType,
            isGroup: true,
            groupName: call.groupName,
            participantCount: joinedCount + 1,
            callerId: call.initiatorId,
            callerName: call.groupName,
          });
        }
      } catch (err) {
        console.error('call:join error:', err);
      }
    });

    socket.on('call:missed', async (data) => {
      try {
        const { callId } = data || {};
        const call = io.activeCalls.get(callId);
        if (!call || call.isGroup) return;
        call.status = 'ended';
        io.activeCalls.delete(callId);
        await execute('UPDATE call_sessions SET status = ?, ended_at = ? WHERE call_id = ?',
          ['missed', new Date(), callId]).catch(() => {});
        await execute('UPDATE call_history SET status = ? WHERE call_id = ?', ['missed', callId]).catch(() => {});
        io.to(`user:${call.initiatorId}`).emit('call:missed', {
          callId,
          conversationId: call.conversationId,
        });
      } catch (err) {
        console.error('call:missed error:', err);
      }
    });

    socket.on('call:end', async (data) => {
      try {
        if (!socket.userId) return;
        const { callId, duration } = data || {};
        const call = io.activeCalls.get(callId);
        const now = new Date();
        if (!call) return;

        if (call.isGroup) {
          const part = call.participants.get(socket.userId);
          if (part) part.status = 'left';
          socket.leave(`call:${callId}`);
          await execute(
            'INSERT INTO call_participants (call_id, user_id, joined_at, left_at, status) VALUES (?, ?, ?, ?, ?)',
            [callId, socket.userId, now, now, 'left']
          ).catch(() => {});

          io.to(`call:${callId}`).emit('call:participant-left', {
            callId,
            userId: socket.userId,
            participants: listActiveParticipants(call),
          });

          const stillJoined = Array.from(call.participants.values()).filter((p) => p.status === 'joined');
          if (stillJoined.length === 0 || socket.userId === call.initiatorId) {
            call.status = 'ended';
            io.activeCalls.delete(callId);
            io.to(`call:${callId}`).emit('call:ended', {
              callId,
              userId: socket.userId,
              conversationId: call.conversationId,
            });
            await execute('UPDATE call_sessions SET status = ?, ended_at = ? WHERE call_id = ?',
              ['ended', now, callId]).catch(() => {});
          }
        } else {
          call.status = 'ended';
          io.activeCalls.delete(callId);
          const endPayload = {
            callId,
            userId: socket.userId,
            conversationId: call.conversationId,
          };
          io.to(`call:${callId}`).emit('call:ended', endPayload);
          io.to(`user:${call.initiatorId}`).emit('call:ended', endPayload);
          for (const [uid] of call.participants) {
            if (uid !== socket.userId) io.to(`user:${uid}`).emit('call:ended', endPayload);
          }
          await execute('UPDATE call_sessions SET status = ?, ended_at = ? WHERE call_id = ?',
            ['ended', now, callId]).catch(() => {});
          await execute('UPDATE call_history SET status = ?, duration = ?, ended_at = ? WHERE call_id = ?',
            ['ended', duration || 0, now, callId]).catch(() => {});
        }
      } catch (err) {
        console.error('call:end error:', err);
      }
    });

    socket.on('call:switch-audio', (data) => {
      const { callId } = data || {};
      if (!callId) return;
      socket.to(`call:${callId}`).emit('call:switch-audio', {
        callId,
        userId: socket.userId,
      });
    });

    // ==================== DISCONNECT ====================
    socket.on('disconnect', async () => {
      const userId = userSocketIds.get(socket.id);
      if (userId) {
        userSockets.delete(userId);
        userSocketIds.delete(socket.id);
        const now = new Date();
        await execute('UPDATE users SET is_online = false, last_seen = ? WHERE user_id = ?', [now, userId]);
        await emitPresence(io, userId, false);

        // Quitter les appels actifs pour éviter les sessions fantômes
        if (io.activeCalls) {
          for (const [callId, call] of io.activeCalls.entries()) {
            const part = call.participants.get(userId);
            if (!part || (part.status !== 'joined' && part.status !== 'ringing')) continue;

            part.status = 'left';
            socket.leave(`call:${callId}`);

            if (call.isGroup) {
              io.to(`call:${callId}`).emit('call:participant-left', {
                callId,
                userId,
                participants: listActiveParticipants(call),
              });
              const stillJoined = Array.from(call.participants.values()).filter((p) => p.status === 'joined');
              if (stillJoined.length === 0 || userId === call.initiatorId) {
                call.status = 'ended';
                io.activeCalls.delete(callId);
                io.to(`call:${callId}`).emit('call:ended', {
                  callId,
                  userId,
                  conversationId: call.conversationId,
                });
              }
            } else {
              call.status = 'ended';
              io.activeCalls.delete(callId);
              const endPayload = { callId, userId, conversationId: call.conversationId };
              io.to(`call:${callId}`).emit('call:ended', endPayload);
              io.to(`user:${call.initiatorId}`).emit('call:ended', endPayload);
              for (const [uid] of call.participants) {
                if (uid !== userId) io.to(`user:${uid}`).emit('call:ended', endPayload);
              }
            }
          }
        }
      }
    });
  });
}

module.exports = { setupSocket };
