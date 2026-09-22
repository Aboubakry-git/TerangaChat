const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const config = require('../config');
const { execute } = require('../config/database');
const { escapeHtml } = require('../utils/helpers');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(config.uploadDir, 'avatars');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${req.user.user_id}-${Date.now()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp/;
    const extOk = allowed.test(path.extname(file.originalname).toLowerCase());
    const mimeOk = allowed.test(file.mimetype);
    if (extOk && mimeOk) cb(null, true);
    else cb(new Error('Format non supporté'));
  },
});

// GET /profile
router.get('/', async (req, res) => {
  try {
    const result = await execute(
      'SELECT user_id, username, email, full_name, avatar_url, status_text, hide_online, hide_last_seen FROM users WHERE user_id = ?',
      [req.user.user_id]
    );
    const profile = result.rows[0];
    res.render('profile/index', { profile, error: null, success: null });
  } catch (err) {
    console.error('Profile error:', err);
    res.redirect('/chat');
  }
});

// POST /profile
router.post('/', upload.single('avatar'), async (req, res) => {
  try {
    const { fullName, statusText, hideOnline, hideLastSeen } = req.body;
    const avatarUrl = req.file ? `/uploads/avatars/${req.file.filename}` : null;

    let query = 'UPDATE users SET full_name = ?, status_text = ?, hide_online = ?, hide_last_seen = ?';
    const params = [
      escapeHtml(fullName || ''),
      (statusText || '').substring(0, 140),
      hideOnline === 'on',
      hideLastSeen === 'on',
    ];
    if (avatarUrl) {
      query += ', avatar_url = ?';
      params.push(avatarUrl);
    }
    query += ', updated_at = ? WHERE user_id = ?';
    params.push(new Date(), req.user.user_id);

    await execute(query, params);

    // Synchroniser users_by_username
    const updated = await execute(
      'SELECT username, full_name, avatar_url FROM users WHERE user_id = ?',
      [req.user.user_id]
    );
    if (updated.rows[0]) {
      await execute(
        'UPDATE users_by_username SET full_name = ?, avatar_url = ? WHERE username = ?',
        [updated.rows[0].full_name, updated.rows[0].avatar_url, updated.rows[0].username]
      );
    }

    const result = await execute(
      'SELECT user_id, username, email, full_name, avatar_url, status_text, hide_online, hide_last_seen FROM users WHERE user_id = ?',
      [req.user.user_id]
    );
    res.render('profile/index', { profile: result.rows[0], error: null, success: 'Profil mis à jour' });
  } catch (err) {
    console.error('Profile update error:', err);
    const result = await execute(
      'SELECT user_id, username, email, full_name, avatar_url, status_text, hide_online, hide_last_seen FROM users WHERE user_id = ?',
      [req.user.user_id]
    );
    res.render('profile/index', { profile: result.rows[0], error: 'Erreur lors de la mise à jour', success: null });
  }
});

// GET /profile/blocked
router.get('/blocked', async (req, res) => {
  try {
    const blockedResult = await execute(
      'SELECT blocked_id, created_at FROM blocked_users WHERE blocker_id = ?',
      [req.user.user_id]
    );
    const blockedUsers = [];
    for (const row of blockedResult.rows) {
      const r = await execute('SELECT user_id, username, full_name, avatar_url FROM users WHERE user_id = ?', [row.blocked_id]);
      if (r.rows[0]) blockedUsers.push(r.rows[0]);
    }
    res.render('profile/blocked', { blockedUsers });
  } catch (err) {
    console.error('Blocked list error:', err);
    res.render('profile/blocked', { blockedUsers: [] });
  }
});

// POST /profile/block/:userId
router.post('/block/:userId', async (req, res) => {
  try {
    await execute(
      'INSERT INTO blocked_users (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)',
      [req.user.user_id, req.params.userId, new Date()]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erreur' });
  }
});

// POST /profile/unblock/:userId
router.post('/unblock/:userId', async (req, res) => {
  try {
    await execute('DELETE FROM blocked_users WHERE blocker_id = ? AND blocked_id = ?', [req.user.user_id, req.params.userId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erreur' });
  }
});

module.exports = router;
