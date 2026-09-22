const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const config = require('../config');
const { execute, batch } = require('../config/database');
const { generateId, validatePassword, validateEmail, validateUsername, escapeHtml } = require('../utils/helpers');

// GET /register
router.get('/register', (req, res) => {
  res.render('auth/register', { error: null, oldInput: {} });
});

// POST /register
router.post('/register', async (req, res) => {
  const { username, email, password, confirmPassword, fullName } = req.body;

  if (!username || !email || !password || !confirmPassword) {
    return res.render('auth/register', { error: 'Tous les champs sont obligatoires', oldInput: req.body });
  }
  if (password !== confirmPassword) {
    return res.render('auth/register', { error: 'Les mots de passe ne correspondent pas', oldInput: req.body });
  }
  if (!validateUsername(username)) {
    return res.render('auth/register', { error: 'Nom d\'utilisateur invalide (3-20 caractères alphanumériques)', oldInput: req.body });
  }
  if (!validateEmail(email)) {
    return res.render('auth/register', { error: 'Adresse email invalide', oldInput: req.body });
  }
  const pwdError = validatePassword(password);
  if (pwdError) {
    return res.render('auth/register', { error: pwdError, oldInput: req.body });
  }

  try {
    const existingUsername = await execute('SELECT user_id FROM users_by_username WHERE username = ?', [username]);
    if (existingUsername.rows.length > 0) {
      return res.render('auth/register', { error: 'Ce nom d\'utilisateur est déjà pris', oldInput: req.body });
    }

    const existingEmail = await execute('SELECT user_id FROM users_by_email WHERE email = ?', [email.toLowerCase()]);
    if (existingEmail.rows.length > 0) {
      return res.render('auth/register', { error: 'Cette adresse email est déjà utilisée', oldInput: req.body });
    }

    const userId = generateId();
    const passwordHash = await bcrypt.hash(password, 10);
    const now = new Date();
    const safeName = fullName ? escapeHtml(fullName.trim()) : '';

    const queries = [
      { query: 'INSERT INTO users (user_id, username, email, password_hash, full_name, avatar_url, status_text, hide_online, hide_last_seen, is_online, last_seen, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        params: [userId, username, email.toLowerCase(), passwordHash, safeName, null, '', false, false, false, now, now, now] },
      { query: 'INSERT INTO users_by_username (username, user_id, full_name, avatar_url) VALUES (?, ?, ?, ?)',
        params: [username, userId, safeName, null] },
      { query: 'INSERT INTO users_by_email (email, user_id) VALUES (?, ?)',
        params: [email.toLowerCase(), userId] },
    ];
    await batch(queries);

    const token = jwt.sign({ userId }, config.jwtSecret, { expiresIn: config.jwtExpiresIn });
    res.cookie('token', token, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 });
    res.redirect('/chat');
  } catch (err) {
    console.error('Register error:', err);
    res.render('auth/register', { error: 'Erreur lors de l\'inscription', oldInput: req.body });
  }
});

// GET /login
router.get('/login', (req, res) => {
  res.render('auth/login', { error: null, oldInput: {} });
});

// POST /login
router.post('/login', async (req, res) => {
  const { identifier, password, rememberMe } = req.body;

  if (!identifier || !password) {
    return res.render('auth/login', { error: 'Veuillez remplir tous les champs', oldInput: req.body });
  }

  try {
    let userResult;
    if (validateEmail(identifier)) {
      userResult = await execute('SELECT user_id FROM users_by_email WHERE email = ?', [identifier.toLowerCase()]);
    } else {
      userResult = await execute('SELECT user_id FROM users_by_username WHERE username = ?', [identifier]);
    }

    if (userResult.rows.length === 0) {
      return res.render('auth/login', { error: 'Identifiants incorrects', oldInput: req.body });
    }

    const userId = userResult.rows[0].user_id;
    const userRows = await execute('SELECT user_id, username, email, password_hash FROM users WHERE user_id = ?', [userId]);
    const user = userRows.rows[0];

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.render('auth/login', { error: 'Identifiants incorrects', oldInput: req.body });
    }

    await execute('UPDATE users SET is_online = true, last_seen = ? WHERE user_id = ?', [new Date(), userId]);

    const maxAge = rememberMe ? 30 * 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
    const token = jwt.sign({ userId }, config.jwtSecret, { expiresIn: rememberMe ? '30d' : config.jwtExpiresIn });
    res.cookie('token', token, { httpOnly: true, maxAge });
    res.redirect('/chat');
  } catch (err) {
    console.error('Login error:', err);
    res.render('auth/login', { error: 'Erreur de connexion', oldInput: req.body });
  }
});

// GET /logout
router.get('/logout', async (req, res) => {
  try {
    const token = req.cookies?.token;
    if (token) {
      const decoded = jwt.verify(token, config.jwtSecret);
      await execute('UPDATE users SET is_online = false, last_seen = ? WHERE user_id = ?', [new Date(), decoded.userId]);
    }
  } catch (e) { /* ignore */ }
  res.clearCookie('token');
  res.redirect('/login');
});

// GET /forgot-password
router.get('/forgot-password', (req, res) => {
  res.render('auth/forgot-password', { error: null, success: null });
});

// POST /forgot-password
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  try {
    const userResult = await execute('SELECT user_id FROM users_by_email WHERE email = ?', [email.toLowerCase()]);
    if (userResult.rows.length === 0) {
      return res.render('auth/forgot-password', { error: 'Aucun compte avec cet email', success: null });
    }

    const userId = userResult.rows[0].user_id;
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 3600000);

    // TTL 1h sur le token
    await execute(
      'INSERT INTO password_reset_tokens (token, user_id, expires_at) VALUES (?, ?, ?) USING TTL 3600',
      [token, userId, expiresAt]
    );

    if (config.smtp.host) {
      const transporter = nodemailer.createTransport({
        host: config.smtp.host,
        port: config.smtp.port,
        auth: { user: config.smtp.user, pass: config.smtp.pass },
      });
      const resetUrl = `${req.protocol}://${req.get('host')}/reset-password?token=${token}`;
      await transporter.sendMail({
        from: config.smtp.from,
        to: email,
        subject: 'Réinitialisation de votre mot de passe',
        html: `<p>Cliquez sur ce lien pour réinitialiser votre mot de passe: <a href="${resetUrl}">${resetUrl}</a></p><p>Ce lien expire dans 1 heure.</p>`,
      });
    }

    res.render('auth/forgot-password', { error: null, success: 'Si un compte existe, un email de réinitialisation a été envoyé.' });
  } catch (err) {
    console.error('Forgot password error:', err);
    res.render('auth/forgot-password', { error: 'Erreur', success: null });
  }
});

// GET /reset-password
router.get('/reset-password', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.redirect('/login');
  res.render('auth/reset-password', { token, error: null });
});

// POST /reset-password
router.post('/reset-password', async (req, res) => {
  const { token, password, confirmPassword } = req.body;
  if (password !== confirmPassword) {
    return res.render('auth/reset-password', { token, error: 'Les mots de passe ne correspondent pas' });
  }
  const pwdError = validatePassword(password);
  if (pwdError) {
    return res.render('auth/reset-password', { token, error: pwdError });
  }

  try {
    const tokenResult = await execute('SELECT user_id, expires_at FROM password_reset_tokens WHERE token = ?', [token]);
    if (tokenResult.rows.length === 0) {
      return res.render('auth/reset-password', { token, error: 'Token invalide ou expiré' });
    }
    if (new Date(tokenResult.rows[0].expires_at) < new Date()) {
      return res.render('auth/reset-password', { token, error: 'Token expiré' });
    }

    const userId = tokenResult.rows[0].user_id;
    const passwordHash = await bcrypt.hash(password, 10);
    await execute('UPDATE users SET password_hash = ?, updated_at = ? WHERE user_id = ?', [passwordHash, new Date(), userId]);
    await execute('DELETE FROM password_reset_tokens WHERE token = ?', [token]);

    res.redirect('/login');
  } catch (err) {
    console.error('Reset password error:', err);
    res.render('auth/reset-password', { token, error: 'Erreur' });
  }
});

module.exports = router;
