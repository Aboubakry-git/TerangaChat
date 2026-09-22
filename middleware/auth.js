const jwt = require('jsonwebtoken');
const config = require('../config');
const { execute } = require('../config/database');

async function authMiddleware(req, res, next) {
  const token = req.cookies?.token;
  if (!token) return res.redirect('/login');

  try {
    const decoded = jwt.verify(token, config.jwtSecret);
    const result = await execute(
      'SELECT user_id, username, email, full_name, avatar_url, status_text FROM users WHERE user_id = ?',
      [decoded.userId]
    );

    if (result.rows.length === 0) return res.redirect('/login');

    req.user = result.rows[0];
    req.user.user_id = result.rows[0].user_id;
    res.locals.user = req.user;
    next();
  } catch (err) {
    res.clearCookie('token');
    res.redirect('/login');
  }
}

function apiAuth(req, res, next) {
  const token = req.cookies?.token || req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Non authentifié' });

  try {
    const decoded = jwt.verify(token, config.jwtSecret);
    req.userId = decoded.userId;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token invalide' });
  }
}

module.exports = { authMiddleware, apiAuth };
