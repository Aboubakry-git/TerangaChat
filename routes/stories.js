const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const config = require('../config');
const { execute } = require('../config/database');
const { generateId, escapeHtml, getInitials } = require('../utils/helpers');

const STORY_MAX_BYTES = 50 * 1024 * 1024;
const DEFAULT_IMAGE_DURATION = 5;
const TEXT_DURATION = 8;

const storiesRoot = path.isAbsolute(config.uploadDir)
  ? path.join(config.uploadDir, 'stories')
  : path.join(__dirname, '..', config.uploadDir, 'stories');

const storyStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(storiesRoot, String(req.userId));
    try {
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    } catch (e) {
      cb(e);
    }
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.bin';
    cb(null, `${Date.now()}-${generateId().slice(0, 8)}${ext}`);
  },
});

const storyUpload = multer({
  storage: storyStorage,
  limits: { fileSize: STORY_MAX_BYTES },
  fileFilter: (req, file, cb) => {
    if (/^image\//.test(file.mimetype) || /^video\//.test(file.mimetype)) {
      return cb(null, true);
    }
    cb(new Error('Type de fichier non autorisé (image ou vidéo)'));
  },
});

function publicStoryUrl(userId, filename) {
  return `/uploads/stories/${userId}/${filename}`;
}

function unlinkStoryFile(mediaUrl) {
  if (!mediaUrl) return;
  const rel = String(mediaUrl).replace(/^\/uploads\//, '');
  const uploadsRoot = path.isAbsolute(config.uploadDir)
    ? config.uploadDir
    : path.join(__dirname, '..', config.uploadDir);
  const filePath = path.join(uploadsRoot, rel);
  fs.unlink(filePath, () => {});
}

async function getContactIds(userId) {
  const uid = userId.toString();
  const convs = await execute(
    'SELECT conversation_id FROM user_conversations WHERE user_id = ?',
    [uid]
  );
  const contacts = new Set();

  for (const row of convs.rows) {
    const cid = row.conversation_id;
    const convRes = await execute(
      'SELECT type FROM conversations WHERE conversation_id = ?',
      [cid]
    );
    const conv = convRes.rows[0];
    if (!conv || conv.type !== 'private') continue;

    const members = await execute(
      'SELECT user_id FROM conversation_members WHERE conversation_id = ?',
      [cid]
    );
    for (const m of members.rows) {
      const mid = m.user_id.toString();
      if (mid !== uid) contacts.add(mid);
    }
  }

  // Exclure les utilisateurs bloqués (dans les deux sens)
  const blocked = await execute(
    'SELECT blocked_id FROM blocked_users WHERE blocker_id = ?',
    [uid]
  ).catch(() => ({ rows: [] }));
  for (const b of blocked.rows) {
    contacts.delete(b.blocked_id.toString());
  }

  return Array.from(contacts);
}

async function loadUserBrief(userId) {
  const r = await execute(
    'SELECT username, full_name, avatar_url FROM users WHERE user_id = ?',
    [userId]
  );
  const u = r.rows[0] || {};
  return {
    userId: userId.toString(),
    username: u.username || 'Utilisateur',
    fullName: u.full_name || u.username || 'Utilisateur',
    avatarUrl: u.avatar_url || null,
    initials: getInitials(u.username || '?'),
  };
}

function mapStoryRow(row) {
  return {
    storyId: row.story_id.toString(),
    userId: row.user_id.toString(),
    mediaType: row.media_type,
    mediaUrl: row.media_url || null,
    caption: row.caption || '',
    background: row.background || '#075E54',
    duration: row.duration || DEFAULT_IMAGE_DURATION,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

async function getActiveStoriesForUser(userId) {
  const now = Date.now();
  const result = await execute(
    'SELECT story_id, user_id, media_type, media_url, caption, background, duration, created_at, expires_at FROM stories WHERE user_id = ?',
    [userId]
  );
  return result.rows
    .filter((r) => r.expires_at && new Date(r.expires_at).getTime() > now)
    .map(mapStoryRow);
}

async function getViewedSet(storyIds, viewerId) {
  const viewed = new Set();
  await Promise.all(
    storyIds.map(async (sid) => {
      const r = await execute(
        'SELECT viewer_id FROM story_views WHERE story_id = ? AND viewer_id = ?',
        [sid, viewerId]
      );
      if (r.rows.length > 0) viewed.add(sid.toString());
    })
  );
  return viewed;
}

function emitToUser(req, userId, event, payload) {
  const io = req.app.get('io');
  if (io) io.to(`user:${userId}`).emit(event, payload);
}

// GET /api/stories/feed
router.get('/feed', async (req, res) => {
  try {
    const me = req.userId.toString();
    const contactIds = await getContactIds(me);
    const targetIds = [me, ...contactIds];

    const feed = [];
    for (const uid of targetIds) {
      const stories = await getActiveStoriesForUser(uid);
      if (stories.length === 0 && uid !== me) continue;

      const brief = await loadUserBrief(uid);
      const viewed = await getViewedSet(
        stories.map((s) => s.storyId),
        me
      );
      const hasUnseen =
        uid !== me && stories.some((s) => !viewed.has(s.storyId));

      feed.push({
        ...brief,
        isMe: uid === me,
        hasUnseen,
        stories: stories.map((s) => ({
          ...s,
          viewed: uid === me ? true : viewed.has(s.storyId),
        })),
      });
    }

    // Mes statuts en premier, puis non vus, puis vus
    feed.sort((a, b) => {
      if (a.isMe !== b.isMe) return a.isMe ? -1 : 1;
      if (a.hasUnseen !== b.hasUnseen) return a.hasUnseen ? -1 : 1;
      const aMax = a.stories[0]?.createdAt || 0;
      const bMax = b.stories[0]?.createdAt || 0;
      return new Date(bMax) - new Date(aMax);
    });

    res.json({ feed });
  } catch (err) {
    console.error('stories feed error:', err);
    res.status(500).json({ error: 'Impossible de charger les statuts' });
  }
});

// POST /api/stories
router.post('/', (req, res) => {
  storyUpload.single('media')(req, res, async (err) => {
    if (err) {
      const msg =
        err.code === 'LIMIT_FILE_SIZE'
          ? 'Fichier trop volumineux (max 50 Mo)'
          : err.message || 'Upload invalide';
      return res.status(400).json({ error: msg });
    }

    try {
      const me = req.userId.toString();
      const text = (req.body.text || req.body.caption || '').trim();
      const caption = escapeHtml((req.body.caption || text || '').trim()).slice(0, 500);
      const background = (req.body.background || '#075E54').slice(0, 32);
      let mediaType = 'text';
      let mediaUrl = null;
      let duration = TEXT_DURATION;

      if (req.file) {
        mediaType = /^video\//.test(req.file.mimetype) ? 'video' : 'image';
        mediaUrl = publicStoryUrl(me, req.file.filename);
        duration =
          mediaType === 'video'
            ? Math.min(parseInt(req.body.duration, 10) || 15, 60)
            : DEFAULT_IMAGE_DURATION;
      } else if (text) {
        mediaType = 'text';
        mediaUrl = null;
        duration = TEXT_DURATION;
      } else {
        return res.status(400).json({ error: 'Ajoutez une image, une vidéo ou un texte' });
      }

      const storyId = generateId();
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);

      const row = {
        story_id: storyId,
        user_id: me,
        media_type: mediaType,
        media_url: mediaUrl,
        caption: mediaType === 'text' ? caption || text : caption,
        background: mediaType === 'text' ? background : null,
        duration,
        created_at: now,
        expires_at: expiresAt,
      };

      await execute(
        `INSERT INTO stories (story_id, user_id, media_type, media_url, caption, background, duration, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.story_id,
          row.user_id,
          row.media_type,
          row.media_url,
          row.caption,
          row.background,
          row.duration,
          row.created_at,
          row.expires_at,
        ]
      );
      await execute(
        `INSERT INTO stories_by_id (story_id, user_id, media_type, media_url, caption, background, duration, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.story_id,
          row.user_id,
          row.media_type,
          row.media_url,
          row.caption,
          row.background,
          row.duration,
          row.created_at,
          row.expires_at,
        ]
      );

      const story = mapStoryRow(row);
      const author = await loadUserBrief(me);
      const payload = { story, author };

      // Notifier les contacts
      const contacts = await getContactIds(me);
      for (const cid of contacts) {
        emitToUser(req, cid, 'story:new', payload);
      }
      emitToUser(req, me, 'story:new', payload);

      res.status(201).json({ story, author });
    } catch (e) {
      console.error('create story error:', e);
      if (req.file) {
        fs.unlink(req.file.path, () => {});
      }
      res.status(500).json({ error: 'Impossible de publier le statut' });
    }
  });
});

// POST /api/stories/:storyId/view
router.post('/:storyId/view', async (req, res) => {
  try {
    const me = req.userId.toString();
    const storyId = req.params.storyId;
    const lookup = await execute(
      'SELECT story_id, user_id, expires_at FROM stories_by_id WHERE story_id = ?',
      [storyId]
    );
    const story = lookup.rows[0];
    if (!story) return res.status(404).json({ error: 'Statut introuvable' });
    if (new Date(story.expires_at).getTime() <= Date.now()) {
      return res.status(410).json({ error: 'Statut expiré' });
    }

    const ownerId = story.user_id.toString();
    if (ownerId === me) {
      return res.json({ ok: true, own: true });
    }

    const now = new Date();
    await execute(
      'INSERT INTO story_views (story_id, viewer_id, viewed_at) VALUES (?, ?, ?)',
      [storyId, me, now]
    );

    const viewer = await loadUserBrief(me);
    emitToUser(req, ownerId, 'story:viewed', {
      storyId,
      viewer,
      viewedAt: now,
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('story view error:', err);
    res.status(500).json({ error: 'Impossible de marquer comme vu' });
  }
});

// GET /api/stories/:storyId/viewers
router.get('/:storyId/viewers', async (req, res) => {
  try {
    const me = req.userId.toString();
    const storyId = req.params.storyId;
    const lookup = await execute(
      'SELECT user_id FROM stories_by_id WHERE story_id = ?',
      [storyId]
    );
    if (lookup.rows.length === 0) {
      return res.status(404).json({ error: 'Statut introuvable' });
    }
    if (lookup.rows[0].user_id.toString() !== me) {
      return res.status(403).json({ error: 'Réservé au propriétaire' });
    }

    const views = await execute(
      'SELECT viewer_id, viewed_at FROM story_views WHERE story_id = ?',
      [storyId]
    );
    const viewers = [];
    for (const v of views.rows) {
      const brief = await loadUserBrief(v.viewer_id);
      viewers.push({
        ...brief,
        viewedAt: v.viewed_at,
      });
    }
    viewers.sort((a, b) => new Date(b.viewedAt) - new Date(a.viewedAt));
    res.json({ viewers, count: viewers.length });
  } catch (err) {
    console.error('story viewers error:', err);
    res.status(500).json({ error: 'Impossible de charger les vues' });
  }
});

// DELETE /api/stories/:storyId
router.delete('/:storyId', async (req, res) => {
  try {
    const me = req.userId.toString();
    const storyId = req.params.storyId;
    const lookup = await execute(
      'SELECT * FROM stories_by_id WHERE story_id = ?',
      [storyId]
    );
    const story = lookup.rows[0];
    if (!story) return res.status(404).json({ error: 'Statut introuvable' });
    if (story.user_id.toString() !== me) {
      return res.status(403).json({ error: 'Non autorisé' });
    }

    await execute(
      'DELETE FROM stories WHERE user_id = ? AND created_at = ? AND story_id = ?',
      [me, story.created_at, storyId]
    );
    await execute('DELETE FROM stories_by_id WHERE story_id = ?', [storyId]);
    await execute('DELETE FROM story_views WHERE story_id = ?', [storyId]);
    await execute('DELETE FROM story_reactions WHERE story_id = ?', [storyId]).catch(() => {});
    unlinkStoryFile(story.media_url);

    const contacts = await getContactIds(me);
    for (const cid of contacts) {
      emitToUser(req, cid, 'story:deleted', { storyId, userId: me });
    }
    emitToUser(req, me, 'story:deleted', { storyId, userId: me });

    res.json({ ok: true });
  } catch (err) {
    console.error('delete story error:', err);
    res.status(500).json({ error: 'Impossible de supprimer le statut' });
  }
});

module.exports = router;
