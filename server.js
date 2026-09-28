'use strict';

const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const store = require('./store');

const app = express();
const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';

const SESSION_SECRET = process.env.SESSION_SECRET || (IS_PROD ? '' : 'dev-only-secret-change-me');
if (!SESSION_SECRET) {
  console.error('SESSION_SECRET must be set in production.');
  process.exit(1);
}

const COOKIE_NAME = 'iw_session';
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

store.seedAdmin();

app.disable('x-powered-by');
app.set('trust proxy', 1); // Render terminates HTTPS in front of the app

/* ---------- security headers (matches the strict CSP the frontend is built for) ---------- */

app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].join('; '));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  if (IS_PROD) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

app.use(express.json({ limit: '100kb' }));

/* ---------- sessions: signed, HttpOnly cookie ---------- */

function sign(value) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('base64url');
}

function createToken(userId) {
  const payload = Buffer.from(JSON.stringify({ uid: userId, exp: Date.now() + SESSION_MS })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function readToken(token) {
  if (!token || !token.includes('.')) return null;
  const [payload, signature] = token.split('.');
  const expected = sign(payload);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return data.exp > Date.now() ? data.uid : null;
  } catch {
    return null;
  }
}

function parseCookies(header = '') {
  const cookies = {};
  header.split(';').forEach((part) => {
    const index = part.indexOf('=');
    if (index < 0) return;
    cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  });
  return cookies;
}

function setSessionCookie(res, userId) {
  const flags = ['HttpOnly', 'SameSite=Lax', 'Path=/', `Max-Age=${Math.floor(SESSION_MS / 1000)}`];
  if (IS_PROD) flags.push('Secure');
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(createToken(userId))}; ${flags.join('; ')}`);
}

function clearSessionCookie(res) {
  const flags = ['HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=0'];
  if (IS_PROD) flags.push('Secure');
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; ${flags.join('; ')}`);
}

app.use((req, res, next) => {
  const userId = readToken(parseCookies(req.headers.cookie)[COOKIE_NAME]);
  req.user = userId ? store.findUserById(userId) : null;
  next();
});

/* Reject cross-site state-changing requests. */
app.use('/api', (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.headers.origin;
  if (origin) {
    try {
      if (new URL(origin).host !== req.headers.host) return res.status(403).json({ error: 'Cross-site request blocked.' });
    } catch {
      return res.status(403).json({ error: 'Cross-site request blocked.' });
    }
  }
  next();
});

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please sign in.' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please sign in.' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Administrator access required.' });
  next();
}

/* ---------- helpers ---------- */

const { db } = store;

function text(value, max) {
  return String(value ?? '').trim().slice(0, max);
}

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function canSeeDocument(user, doc) {
  return user.role === 'admin' || doc.audience === 'all' || doc.audience === user.id;
}

function publicDocument(doc) {
  return {
    id: doc.id,
    title: doc.title,
    description: doc.description,
    originalName: doc.originalName,
    audience: doc.audience,
    createdAt: doc.createdAt
  };
}

function visibleDocuments(user) {
  return db.documents
    .filter((doc) => canSeeDocument(user, doc))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(publicDocument);
}

function projectView() {
  const p = db.project;
  return { ...p, stages: p.stages.map((s) => ({ ...s })), updates: p.updates.map((u) => ({ ...u })) };
}

/* ---------- health check (used by Render) ---------- */

app.get('/healthz', (req, res) => res.type('text').send('ok'));

/* ---------- auth ---------- */

const loginAttempts = new Map();

function loginLimited(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || entry.reset < now) {
    loginAttempts.set(ip, { count: 1, reset: now + 15 * 60 * 1000 });
    return false;
  }
  entry.count += 1;
  return entry.count > 10;
}

app.post('/api/auth/login', (req, res) => {
  if (loginLimited(req.ip)) return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  const email = text(req.body?.email, 200);
  const password = String(req.body?.password ?? '');
  const user = store.findUserByEmail(email);
  const ok = user ? store.verifyPassword(password, user.passwordHash) : (store.verifyPassword(password, 'scrypt$00$00'), false);
  if (!ok) return res.status(401).json({ error: 'Incorrect email or password.' });
  setSessionCookie(res, user.id);
  res.json({ user: store.publicUser(user) });
});

app.post('/api/auth/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: store.publicUser(req.user) });
});

/* ---------- dashboard ---------- */

app.get('/api/dashboard', requireAuth, (req, res) => {
  const project = projectView();
  const investment = req.user.role === 'admin' ? 0 : Number(req.user.investment) || 0;
  const share = project.totalProjectValue > 0 ? (investment / project.totalProjectValue) * 100 : 0;
  const margin = Math.max(0, project.totalProjectValue - project.estimatedProjectCost);
  res.json({
    user: store.publicUser(req.user),
    project,
    overview: {
      yourInvestment: investment,
      investmentShare: Number(share.toFixed(2)),
      expectedProjectMargin: margin
    },
    recentDocuments: visibleDocuments(req.user).slice(0, 3)
  });
});

/* ---------- profile ---------- */

app.patch('/api/profile', requireAuth, (req, res) => {
  const name = text(req.body?.name, 80);
  if (!name) return res.status(400).json({ error: 'Please enter your full name.' });
  req.user.profile = {
    name,
    company: text(req.body?.company, 100),
    phone: text(req.body?.phone, 40),
    location: text(req.body?.location, 100)
  };
  store.save();
  res.json({ user: store.publicUser(req.user) });
});

/* ---------- documents ---------- */

app.get('/api/documents', requireAuth, (req, res) => {
  res.json({ documents: visibleDocuments(req.user) });
});

app.get('/api/documents/:id/download', requireAuth, (req, res) => {
  const doc = db.documents.find((d) => d.id === req.params.id);
  if (!doc || !canSeeDocument(req.user, doc)) return res.status(404).json({ error: 'Document not found.' });
  const filePath = path.join(store.UPLOAD_DIR, doc.storedName);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File is no longer available.' });
  const safeName = `${doc.title.replace(/[^\w\- ]+/g, '').trim() || 'document'}.pdf`;
  res.setHeader('Cache-Control', 'private, no-store');
  res.download(filePath, safeName);
});

/* ---------- messages ---------- */

app.get('/api/messages', requireAuth, (req, res) => {
  const me = req.user;
  const messages = db.messages
    .filter((m) => me.role === 'admin' || m.senderId === me.id || m.recipientId === me.id || m.recipientId === 'all')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((m) => ({ id: m.id, subject: m.subject, message: m.message, senderName: m.senderName, createdAt: m.createdAt }));
  res.json({ messages });
});

app.post('/api/messages', requireAuth, (req, res) => {
  const subject = text(req.body?.subject, 120);
  const message = text(req.body?.message, 2000);
  if (!subject || !message) return res.status(400).json({ error: 'Please add a subject and a message.' });

  let recipientId = 'admin';
  if (req.user.role === 'admin') {
    recipientId = text(req.body?.recipientId, 80) || 'all';
    if (recipientId !== 'all' && !store.findUserById(recipientId)) {
      return res.status(400).json({ error: 'That recipient no longer exists.' });
    }
  }

  db.messages.push({
    id: store.newId(),
    subject,
    message,
    senderId: req.user.id,
    senderName: req.user.profile.name || req.user.email,
    recipientId,
    createdAt: new Date().toISOString()
  });
  store.save();
  res.status(201).json({ ok: true });
});

/* ---------- administration ---------- */

app.get('/api/admin/summary', requireAdmin, (req, res) => {
  res.json({
    users: db.users.map((u) => ({
      id: u.id,
      name: u.profile.name || u.email,
      email: u.email,
      role: u.role,
      investment: u.investment || 0
    })),
    documentCount: db.documents.length,
    messageCount: db.messages.length
  });
});

app.patch('/api/admin/project', requireAdmin, (req, res) => {
  const body = req.body || {};
  const p = db.project;

  if (Array.isArray(body.stages)) {
    if (body.stages.length > 30) return res.status(400).json({ error: 'Too many milestones.' });
    const allowed = ['complete', 'current', 'upcoming'];
    p.stages = body.stages
      .map((s) => ({
        name: text(s?.name, 80),
        status: allowed.includes(s?.status) ? s.status : 'upcoming',
        date: text(s?.date, 40)
      }))
      .filter((s) => s.name);
  }

  for (const field of ['totalProjectValue', 'estimatedProjectCost', 'projectProgress']) {
    if (body[field] === undefined) continue;
    const n = finiteNumber(body[field]);
    const max = field === 'projectProgress' ? 100 : 1e12;
    if (n === null || n < 0 || n > max) return res.status(400).json({ error: 'One of the figures is not valid.' });
    p[field] = n;
  }

  if (body.status !== undefined) p.status = text(body.status, 80) || p.status;
  if (body.location !== undefined) p.location = text(body.location, 120);
  if (body.capacity !== undefined) p.capacity = text(body.capacity, 120);

  store.save();
  res.json({ project: projectView() });
});

app.patch('/api/admin/users/:id/investment', requireAdmin, (req, res) => {
  const user = store.findUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'Client not found.' });
  const amount = finiteNumber(req.body?.investment);
  if (amount === null || amount < 0 || amount > 1e12) return res.status(400).json({ error: 'Enter a valid investment amount.' });
  user.investment = amount;
  store.save();
  res.json({ ok: true });
});

app.post('/api/admin/users', requireAdmin, (req, res) => {
  const name = text(req.body?.name, 80);
  const email = text(req.body?.email, 200).toLowerCase();
  const password = String(req.body?.password ?? '');
  const role = req.body?.role === 'admin' ? 'admin' : 'user';

  if (!name) return res.status(400).json({ error: 'Please enter a full name.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (password.length < 8) return res.status(400).json({ error: 'The password must be at least 8 characters.' });
  if (store.findUserByEmail(email)) return res.status(409).json({ error: 'An account with that email already exists.' });

  const user = store.createUser({ name, email, password, role });
  res.status(201).json({ user: store.publicUser(user) });
});

/* PDF uploads */

const upload = multer({
  storage: multer.diskStorage({
    destination: store.UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}.pdf`)
  }),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 }
});

function isPdfFile(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(5);
    fs.readSync(fd, buffer, 0, 5, 0);
    return buffer.toString('latin1') === '%PDF-';
  } finally {
    fs.closeSync(fd);
  }
}

function removeFile(filePath) {
  fs.unlink(filePath, () => {});
}

app.get('/api/admin/documents', requireAdmin, (req, res) => {
  const documents = [...db.documents].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(publicDocument);
  res.json({ documents });
});

app.post('/api/admin/documents', requireAdmin, (req, res) => {
  upload.single('file')(req, res, (uploadError) => {
    if (uploadError) {
      const tooBig = uploadError.code === 'LIMIT_FILE_SIZE';
      return res.status(400).json({ error: tooBig ? 'That file is larger than 10 MB.' : 'The upload failed. Please try again.' });
    }
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'Choose a PDF to upload.' });

    const title = text(req.body?.title, 140);
    const description = text(req.body?.description, 300);
    const audience = text(req.body?.audience, 80) || 'all';

    if (!title) { removeFile(file.path); return res.status(400).json({ error: 'Please add a document title.' }); }
    if (audience !== 'all' && !store.findUserById(audience)) {
      removeFile(file.path);
      return res.status(400).json({ error: 'That recipient no longer exists.' });
    }
    if (!isPdfFile(file.path)) {
      removeFile(file.path);
      return res.status(400).json({ error: 'That file is not a valid PDF.' });
    }

    db.documents.push({
      id: store.newId(),
      title,
      description,
      audience,
      originalName: text(file.originalname, 200),
      storedName: file.filename,
      createdAt: new Date().toISOString()
    });
    store.save();
    res.status(201).json({ ok: true });
  });
});

app.delete('/api/admin/documents/:id', requireAdmin, (req, res) => {
  const index = db.documents.findIndex((d) => d.id === req.params.id);
  if (index < 0) return res.status(404).json({ error: 'Document not found.' });
  const [doc] = db.documents.splice(index, 1);
  store.save();
  removeFile(path.join(store.UPLOAD_DIR, doc.storedName));
  res.json({ ok: true });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

/* ---------- static files: only the public frontend files are served ---------- */

const send = (file) => (req, res) => res.sendFile(path.join(__dirname, file));
app.get(['/', '/index.html'], send('index.html'));
app.get('/styles.css', send('styles.css'));
app.get('/app.js', send('app.js'));
app.get('/favicon.ico', (req, res) => res.status(204).end()); // no more 500 on favicon requests

const assetDir = path.join(__dirname, 'asset');
if (fs.existsSync(assetDir)) app.use('/asset', express.static(assetDir, { index: false, dotfiles: 'ignore' }));

app.use((req, res) => res.status(404).type('text').send('Not found'));

app.use((error, req, res, next) => {
  console.error(error);
  if (res.headersSent) return next(error);
  res.status(500).json({ error: 'Something went wrong on our side. Please try again.' });
});

app.listen(PORT, '0.0.0.0', () => console.log(`Portal listening on port ${PORT}`));