const express = require('express');
const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Server } = require('socket.io');
const { ExpressPeerServer } = require('peer');
const config = require('./config');
const { authMiddleware, apiAuth } = require('./middleware/auth');
const { setupSocket } = require('./socket');

const app = express();

// ==================== HTTPS ou HTTP ====================
const USE_HTTPS = process.env.USE_HTTPS === 'true' || fs.existsSync(path.join(__dirname, 'certs', 'key.pem'));

let server;
if (USE_HTTPS) {
  const keyPath = path.join(__dirname, 'certs', 'key.pem');
  const certPath = path.join(__dirname, 'certs', 'cert.pem');
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    server = https.createServer({
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath),
    }, app);
    console.log('🔒 HTTPS activé');
  } else {
    server = http.createServer(app);
    console.log('⚠️  Certificats non trouvés, HTTP utilisé');
  }
} else {
  server = http.createServer(app);
  console.log('🌐 HTTP utilisé');
}

const io = new Server(server, { maxHttpBufferSize: 1e8 });

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
// PeerJS same-origin (même port que l'app) — évite firewall / cert séparé sur :9000
app.locals.peerJsPath = config.peerJsPath || '/peerjs';
app.locals.turnUrls = config.turnUrls;
app.locals.turnUsername = config.turnUsername;
app.locals.turnCredential = config.turnCredential;

// ==================== HELMET ====================
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdn.socket.io', 'https://unpkg.com'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://cdnjs.cloudflare.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'https://cdnjs.cloudflare.com', 'data:'],
      imgSrc: ["'self'", 'data:', 'blob:'],
      mediaSrc: ["'self'", 'data:', 'blob:'],
      connectSrc: ["'self'", 'ws:', 'wss:', 'http:', 'https:'],
    },
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
  hsts: USE_HTTPS ? { maxAge: 15552000, includeSubDomains: false } : false,
}));

app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ==================== PEERJS (même serveur HTTP/HTTPS) ====================
const peerPath = config.peerJsPath || '/peerjs';
const peerServer = ExpressPeerServer(server, {
  path: '/',
  allow_discovery: false,
  proxied: true,
});
app.use(peerPath, peerServer);
peerServer.on('connection', (client) => {
  console.log('PeerJS connected:', client.getId());
});
peerServer.on('disconnect', (client) => {
  console.log('PeerJS disconnected:', client.getId());
});

// ==================== RATE LIMITERS ====================
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 2000,
  standardHeaders: true,
  legacyHeaders: false,
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
});

app.use(generalLimiter);

app.use((req, res, next) => {
  res.locals.user = null;
  res.locals.path = req.path;
  res.locals.protocol = req.protocol;
  next();
});

// ==================== ROUTES ====================
const authRoutes = require('./routes/auth');
const chatRoutes = require('./routes/chat');
const profileRoutes = require('./routes/profile');
const apiRoutes = require('./routes/api');
const storiesRoutes = require('./routes/stories');
const { startStoriesCleanupJob } = require('./jobs/storiesCleanup');
const { ensureStoriesSchema } = require('./jobs/ensureStoriesSchema');

// authLimiter uniquement sur POST sensibles
app.use((req, res, next) => {
  const sensitive = ['/login', '/register', '/forgot-password', '/reset-password'];
  if (req.method === 'POST' && sensitive.includes(req.path)) {
    return authLimiter(req, res, next);
  }
  next();
});

app.use('/', authRoutes);
app.use('/chat', authMiddleware, chatRoutes);
app.use('/profile', authMiddleware, profileRoutes);
app.use('/api', apiAuth, apiRoutes);
app.use('/api/stories', apiAuth, storiesRoutes);

app.get('/', (req, res) => {
  const token = req.cookies?.token;
  if (token) return res.redirect('/chat');
  res.redirect('/login');
});

// ==================== FAVICON ====================
app.get('/favicon.ico', (req, res) => {
  const faviconPath = path.join(__dirname, 'public', 'favicon.ico');
  if (fs.existsSync(faviconPath)) {
    res.sendFile(faviconPath);
  } else {
    res.status(204).end();
  }
});

// ==================== ERREURS ====================
app.use((req, res) => {
  res.status(404).render('error', { error: 'Page non trouvée' });
});

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).render('error', { error: 'Une erreur est survenue' });
});

setupSocket(io);
app.set('io', io);

const uploadDir = path.join(__dirname, config.uploadDir);
fs.mkdirSync(path.join(uploadDir, 'avatars'), { recursive: true });
fs.mkdirSync(path.join(uploadDir, 'files'), { recursive: true });
fs.mkdirSync(path.join(uploadDir, 'stories'), { recursive: true });

(async () => {
  try {
    await ensureStoriesSchema();
  } catch (err) {
    console.error('Impossible d\'initialiser le schéma stories:', err.message);
  }
  startStoriesCleanupJob();

  server.listen(config.port, () => {
    const proto = USE_HTTPS ? 'https' : 'http';
    console.log(`🚀 Server running on ${proto}://localhost:${config.port}`);
    console.log(`📡 PeerJS mounted at ${proto}://localhost:${config.port}${peerPath}`);
  });
})();
