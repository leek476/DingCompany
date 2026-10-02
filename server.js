'use strict';

// Load variables from a local .env file (if present) before anything else
// reads process.env — this must run before `require('./db')` below, since
// db.js reads MONGODB_URI the moment it's required. On Render this line is
// a harmless no-op: Render injects Environment-tab variables directly into
// process.env, so there's no .env file there and nothing to load.
require('dotenv').config();

const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { promisify } = require('node:util');
const { ObjectId } = require('mongodb');
const db = require('./db');

const scrypt = promisify(crypto.scrypt);
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;
const MAX_JSON_BYTES = 1_000_000;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const EVENT_HEARTBEAT_MS = 25_000;
const sessions = new Map();
const eventClients = new Set();

const defaultProject = {
  id: 'intercoastal-integrated-utility',
  name: 'Intercoastal Integrated Utility Program',
  sector: 'Integrated Power, Water Supply & Sewage Treatment',
  location: 'Coastal Service District',
  totalProjectValue: 12800000,
  estimatedProjectCost: 8420000,
  projectProgress: 68,
  capitalDeployed: 0,
  remainingCapital: 0,
  status: 'Construction in progress',
  startDate: '2026-06-15',
  projectedCompletion: '2026-12-20',
  duration: '18 months',
  description: 'A resilient utility program that combines dependable power generation, treated water supply and modern sewage treatment for growing coastal communities.',
  capacity: '18 MW power · 9 MGD water · 6 MGD treatment',
  investmentReturnRate: 0,
  stages: [
    { name: 'Site & permits', status: 'complete', date: 'Jun 2026' },
    { name: 'Detailed engineering', status: 'complete', date: 'Jul 2026' },
    { name: 'Equipment procurement', status: 'complete', date: 'Aug 2026' },
    { name: 'Civil construction', status: 'current', date: 'Sep 2026' },
    { name: 'Commissioning', status: 'upcoming', date: 'Dec 2026' }
  ],
  updates: [
    {
      id: 'update-3',
      date: '2026-09-16',
      title: 'Civil works milestone reached',
      body: 'Foundation and intake-structure works have reached their planned September milestone.'
    },
    {
      id: 'update-2',
      date: '2026-09-03',
      title: 'Treatment equipment secured',
      body: 'Primary treatment and pumping equipment has cleared factory acceptance testing.'
    },
    {
      id: 'update-1',
      date: '2026-08-19',
      title: 'Grid interconnection approved',
      body: 'The interconnection design received its technical approval, keeping the power workstream on schedule.'
    }
  ]
};

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = await scrypt(password, salt, 64);
  return `${salt}:${derived.toString('hex')}`;
}

async function passwordMatches(password, stored) {
  const [salt, key] = String(stored || '').split(':');
  if (!salt || !key) return false;
  const derived = await scrypt(password, salt, 64);
  const expected = Buffer.from(key, 'hex');
  return expected.length === derived.length && crypto.timingSafeEqual(expected, derived);
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function cleanText(value, maxLength = 180) {
  return String(value || '').replace(/[<>]/g, '').trim().slice(0, maxLength);
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    investment: Number(user.investment || 0),
    createdAt: user.createdAt,
    profile: {
      name: user.profile?.name || '',
      company: user.profile?.company || '',
      phone: user.profile?.phone || '',
      location: user.profile?.location || ''
    }
  };
}

function sendJson(response, statusCode, payload, extraHeaders = {}) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders
  });
  response.end(JSON.stringify(payload));
}

function sendError(response, statusCode, error) {
  sendJson(response, statusCode, { error });
}

function parseCookies(header = '') {
  return header.split(';').reduce((cookies, part) => {
    const divider = part.indexOf('=');
    if (divider === -1) return cookies;
    const key = part.slice(0, divider).trim();
    const value = part.slice(divider + 1).trim();
    cookies[key] = value;
    return cookies;
  }, {});
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(token, { userId, expiresAt: Date.now() + SESSION_TTL_MS });
  return token;
}

function sessionCookie(token, maxAge = Math.floor(SESSION_TTL_MS / 1000)) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `intercoastal_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`;
}

async function getCurrentUser(request) {
  const token = parseCookies(request.headers.cookie).intercoastal_session;
  const session = token && sessions.get(token);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return db.findUserById(session.userId);
}

async function requireUser(request, response) {
  const user = await getCurrentUser(request);
  if (!user) {
    sendError(response, 401, 'Please sign in to continue.');
    return null;
  }
  return user;
}

async function requireAdmin(request, response) {
  const user = await requireUser(request, response);
  if (!user) return null;
  if (user.role !== 'admin') {
    sendError(response, 403, 'Administrator access is required.');
    return null;
  }
  return user;
}

function readRequestBody(request, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    request.on('data', (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        const error = new Error('Request is too large.');
        error.statusCode = 413;
        reject(error);
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

async function readJson(request) {
  const buffer = await readRequestBody(request, MAX_JSON_BYTES);
  if (!buffer.length) return {};
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    const error = new Error('The request body must be valid JSON.');
    error.statusCode = 400;
    throw error;
  }
}

function parseMultipart(buffer, contentType) {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType || '');
  if (!boundaryMatch) {
    const error = new Error('A multipart boundary is required.');
    error.statusCode = 400;
    throw error;
  }

  const boundary = boundaryMatch[1] || boundaryMatch[2];
  const pieces = buffer.toString('latin1').split(`--${boundary}`);
  const fields = {};
  const files = {};

  for (let piece of pieces.slice(1, -1)) {
    if (piece.startsWith('\r\n')) piece = piece.slice(2);
    if (piece.endsWith('\r\n')) piece = piece.slice(0, -2);
    const headerEnd = piece.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;
    const rawHeaders = piece.slice(0, headerEnd);
    const body = piece.slice(headerEnd + 4);
    const disposition = /content-disposition:\s*form-data;\s*name="([^"]+)"(?:;\s*filename="([^"]*)")?/i.exec(rawHeaders);
    if (!disposition) continue;
    const [, fieldName, fileName] = disposition;
    const contentTypeMatch = /content-type:\s*([^\r\n]+)/i.exec(rawHeaders);
    if (typeof fileName === 'string') {
      files[fieldName] = {
        filename: fileName,
        contentType: contentTypeMatch ? contentTypeMatch[1].trim().toLowerCase() : 'application/octet-stream',
        data: Buffer.from(body, 'latin1')
      };
    } else {
      fields[fieldName] = Buffer.from(body, 'latin1').toString('utf8');
    }
  }
  return { fields, files };
}

function overviewFor(user, project) {
  const yourInvestment = Number(user.investment || 0);
  return {
    yourInvestment,
    totalProjectValue: Number(project.totalProjectValue || 0),
    estimatedProjectCost: Number(project.estimatedProjectCost || 0),
    projectProgress: Number(project.projectProgress || 0),
    investmentShare: project.totalProjectValue ? (yourInvestment / project.totalProjectValue) * 100 : 0,
    expectedProjectMargin: project.totalProjectValue - project.estimatedProjectCost
  };
}

function canAccessDocument(document, user) {
  return user.role === 'admin' || document.audience === 'all' || document.audience === user.id;
}

function visibleDocument(document) {
  return {
    id: document.id,
    title: document.title,
    description: document.description,
    originalName: document.originalName,
    createdAt: document.createdAt,
    audience: document.audience
  };
}

function userSummary(user) {
  return {
    id: user.id,
    name: user.profile?.name || user.email,
    email: user.email,
    company: user.profile?.company || '',
    investment: Number(user.investment || 0),
    role: user.role
  };
}

function apiHeaders(response) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'same-origin');
}

function writeEvent(response, event, payload) {
  response.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function removeEventClient(client) {
  eventClients.delete(client);
}

function broadcastPortalChange(type, canReceive = () => true) {
  const payload = { type, at: new Date().toISOString() };
  for (const client of eventClients) {
    if (!canReceive(client)) continue;
    if (client.response.destroyed || client.response.writableEnded) {
      removeEventClient(client);
      continue;
    }
    try {
      writeEvent(client.response, 'portal-change', payload);
    } catch {
      removeEventClient(client);
    }
  }
}

function canReceiveDocumentChange(client, document) {
  return client.role === 'admin' || document.audience === 'all' || document.audience === client.userId;
}

function canReceiveMessageChange(client, message) {
  return client.role === 'admin'
    || message.senderId === client.userId
    || message.recipientId === 'all'
    || message.recipientId === client.userId;
}

async function openEventStream(request, response) {
  const user = await getCurrentUser(request);
  if (!user) {
    sendError(response, 401, 'Please sign in to continue.');
    return;
  }

  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  response.flushHeaders?.();

  const client = { response, userId: user.id, role: user.role };
  const removeClient = () => removeEventClient(client);
  eventClients.add(client);
  response.on('close', removeClient);
  response.on('error', removeClient);

  try {
    response.write('retry: 3000\n\n');
    writeEvent(response, 'connected', { at: new Date().toISOString() });
  } catch {
    removeClient();
  }
}

const eventHeartbeat = setInterval(() => {
  for (const client of eventClients) {
    if (client.response.destroyed || client.response.writableEnded) {
      removeEventClient(client);
      continue;
    }
    try {
      client.response.write(': keep-alive\n\n');
    } catch {
      removeEventClient(client);
    }
  }
}, EVENT_HEARTBEAT_MS);
eventHeartbeat.unref();

async function handleApi(request, response, pathname) {
  apiHeaders(response);

  if (request.method === 'POST' && pathname === '/api/auth/register') {
    const body = await readJson(request);
    const name = cleanText(body.name, 80);
    const email = normalizeEmail(body.email);
    const password = String(body.password || '');
    if (name.length < 2) return sendError(response, 400, 'Enter your full name.');
    if (!validEmail(email)) return sendError(response, 400, 'Enter a valid email address.');
    if (password.length < 8) return sendError(response, 400, 'Use a password with at least 8 characters.');
    if (await db.userCountByEmail(email)) return sendError(response, 409, 'An account with that email already exists.');
    const user = {
      id: crypto.randomUUID(),
      email,
      passwordHash: await hashPassword(password),
      role: 'user',
      investment: 0,
      createdAt: new Date().toISOString(),
      profile: { name, company: '', phone: '', location: '' }
    };
    await db.insertUser(user);
    broadcastPortalChange('admin', (client) => client.role === 'admin');
    const token = createSession(user.id);
    return sendJson(response, 201, { user: publicUser(user) }, { 'Set-Cookie': sessionCookie(token) });
  }

  if (request.method === 'POST' && pathname === '/api/auth/login') {
    const body = await readJson(request);
    const email = normalizeEmail(body.email);
    const password = String(body.password || '');
    const user = await db.findUserByEmail(email);
    if (!user || !(await passwordMatches(password, user.passwordHash))) {
      return sendError(response, 401, 'Invalid email or password.');
    }
    const token = createSession(user.id);
    return sendJson(response, 200, { user: publicUser(user) }, { 'Set-Cookie': sessionCookie(token) });
  }

  if (request.method === 'POST' && pathname === '/api/auth/logout') {
    const token = parseCookies(request.headers.cookie).intercoastal_session;
    if (token) sessions.delete(token);
    return sendJson(response, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
  }

  if (request.method === 'GET' && pathname === '/api/auth/me') {
    const user = await requireUser(request, response);
    if (!user) return;
    return sendJson(response, 200, { user: publicUser(user) });
  }

  if (request.method === 'GET' && pathname === '/api/events') {
    return openEventStream(request, response);
  }

  if (request.method === 'GET' && pathname === '/api/dashboard') {
    const user = await requireUser(request, response);
    if (!user) return;
    const project = await db.getProject(defaultProject);
    const allDocs = await db.allDocuments();
    const documents = allDocs.filter((document) => canAccessDocument(document, user));
    const allMsgs = await db.messagesFor(user);
    return sendJson(response, 200, {
      user: publicUser(user),
      project,
      overview: overviewFor(user, project),
      recentDocuments: documents.slice(0, 3).map(visibleDocument),
      unreadMessages: allMsgs.filter((message) => user.role === 'admin' || message.senderId === user.id).length
    });
  }

  if (request.method === 'GET' && pathname === '/api/documents') {
    const user = await requireUser(request, response);
    if (!user) return;
    const allDocs = await db.allDocuments();
    return sendJson(response, 200, {
      documents: allDocs.filter((document) => canAccessDocument(document, user)).map(visibleDocument)
    });
  }

  const documentMatch = /^\/api\/documents\/([a-zA-Z0-9-]+)\/download$/.exec(pathname);
  if (request.method === 'GET' && documentMatch) {
    const user = await requireUser(request, response);
    if (!user) return;
    const document = await db.findDocument(documentMatch[1]);
    if (!document || !canAccessDocument(document, user)) return sendError(response, 404, 'Document not found.');
    response.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(document.originalName)}`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    const stream = db.downloadFileStream(new ObjectId(document.fileId));
    stream.on('error', () => { if (!response.headersSent) sendError(response, 404, 'The uploaded file is no longer available.'); else response.end(); });
    return stream.pipe(response);
  }

  if (request.method === 'PATCH' && pathname === '/api/profile') {
    const user = await requireUser(request, response);
    if (!user) return;
    const body = await readJson(request);
    const name = cleanText(body.name, 80);
    if (name.length < 2) return sendError(response, 400, 'Enter a name with at least 2 characters.');
    const profile = {
      name,
      company: cleanText(body.company, 100),
      phone: cleanText(body.phone, 40),
      location: cleanText(body.location, 100)
    };
    const updated = await db.updateUser(user.id, { profile });
    broadcastPortalChange('profile', (client) => client.userId === user.id || client.role === 'admin');
    return sendJson(response, 200, { user: publicUser(updated) });
  }

  if (request.method === 'GET' && pathname === '/api/messages') {
    const user = await requireUser(request, response);
    if (!user) return;
    const list = await db.messagesFor(user);
    return sendJson(response, 200, { messages: list });
  }

  if (request.method === 'POST' && pathname === '/api/messages') {
    const user = await requireUser(request, response);
    if (!user) return;
    const body = await readJson(request);
    const subject = cleanText(body.subject, 120);
    const message = cleanText(body.message, 2000);
    if (!subject || !message) return sendError(response, 400, 'Add a subject and message.');
    const messageRecord = {
      id: crypto.randomUUID(),
      senderId: user.id,
      senderName: user.profile?.name || user.email,
      recipientId: user.role === 'admin' ? (body.recipientId || 'all') : 'admin',
      subject,
      message,
      createdAt: new Date().toISOString()
    };
    await db.insertMessage(messageRecord);
    broadcastPortalChange('messages', (client) => canReceiveMessageChange(client, messageRecord));
    return sendJson(response, 201, { ok: true });
  }

  if (request.method === 'GET' && pathname === '/api/admin/summary') {
    const admin = await requireAdmin(request, response);
    if (!admin) return;
    const [list, documentCount, messageCount] = await Promise.all([db.allUsers(), db.allDocuments().then((d) => d.length), db.countMessages()]);
    return sendJson(response, 200, { users: list.map(userSummary), documentCount, messageCount });
  }

  if (request.method === 'POST' && pathname === '/api/admin/users') {
    const admin = await requireAdmin(request, response);
    if (!admin) return;
    const body = await readJson(request);
    const name = cleanText(body.name, 80);
    const email = normalizeEmail(body.email);
    const password = String(body.password || '');
    const role = body.role === 'admin' ? 'admin' : 'user';
    if (name.length < 2) return sendError(response, 400, 'Enter a full name.');
    if (!validEmail(email)) return sendError(response, 400, 'Enter a valid email address.');
    if (password.length < 8) return sendError(response, 400, 'Use a password with at least 8 characters.');
    if (await db.userCountByEmail(email)) return sendError(response, 409, 'An account with that email already exists.');
    const user = {
      id: crypto.randomUUID(),
      email,
      passwordHash: await hashPassword(password),
      role,
      investment: 0,
      createdAt: new Date().toISOString(),
      profile: { name, company: '', phone: '', location: '' }
    };
    await db.insertUser(user);
    broadcastPortalChange('admin', (client) => client.role === 'admin');
    return sendJson(response, 201, { user: userSummary(user) });
  }

  if (request.method === 'PATCH' && pathname === '/api/admin/project') {
    const admin = await requireAdmin(request, response);
    if (!admin) return;
    const body = await readJson(request);

    if (Array.isArray(body.stages)) {
      const validStatuses = new Set(['complete', 'current', 'upcoming']);
      const stages = body.stages
        .map((stage) => ({
          name: cleanText(stage?.name, 80),
          status: validStatuses.has(stage?.status) ? stage.status : 'upcoming',
          date: cleanText(stage?.date, 40)
        }))
        .filter((stage) => stage.name);
      if (!stages.length) return sendError(response, 400, 'Add at least one milestone with a name.');
      const project = await db.saveProject({ stages });
      broadcastPortalChange('project');
      return sendJson(response, 200, { project });
    }

    const totalProjectValue = Number(body.totalProjectValue);
    const estimatedProjectCost = Number(body.estimatedProjectCost);
    const projectProgress = Number(body.projectProgress);
    if (![totalProjectValue, estimatedProjectCost, projectProgress].every(Number.isFinite) || totalProjectValue < 0 || estimatedProjectCost < 0 || projectProgress < 0 || projectProgress > 100) {
      return sendError(response, 400, 'Provide valid project value, cost and progress values.');
    }
    const update = {
      totalProjectValue: Math.round(totalProjectValue),
      estimatedProjectCost: Math.round(estimatedProjectCost),
      projectProgress: Math.round(projectProgress * 10) / 10
    };
    if (body.capitalDeployed !== undefined && body.capitalDeployed !== '') {
      const capitalDeployed = Number(body.capitalDeployed);
      if (!Number.isFinite(capitalDeployed) || capitalDeployed < 0) {
        return sendError(response, 400, 'Capital deployed must be a valid non-negative number.');
      }
      update.capitalDeployed = Math.round(capitalDeployed);
    }
    if (body.remainingCapital !== undefined && body.remainingCapital !== '') {
      const remainingCapital = Number(body.remainingCapital);
      if (!Number.isFinite(remainingCapital) || remainingCapital < 0) {
        return sendError(response, 400, 'Remaining capital must be a valid non-negative number.');
      }
      update.remainingCapital = Math.round(remainingCapital);
    }
    if (body.status) update.status = cleanText(body.status, 80);
    if (body.location) update.location = cleanText(body.location, 120);
    if (body.capacity) update.capacity = cleanText(body.capacity, 120);

    // Admin-editable dates and the investment-return rate. Dates come from
    // <input type="date"> as YYYY-MM-DD, which is exactly what dateLabel()
    // and the input's own value attribute expect on the frontend, so they
    // are stored as-is rather than reformatted.
    if (body.startDate !== undefined) {
      const startDate = cleanText(body.startDate, 20);
      if (startDate && !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
        return sendError(response, 400, 'Start date must be a valid date.');
      }
      update.startDate = startDate;
    }
    if (body.projectedCompletion !== undefined) {
      const projectedCompletion = cleanText(body.projectedCompletion, 20);
      if (projectedCompletion && !/^\d{4}-\d{2}-\d{2}$/.test(projectedCompletion)) {
        return sendError(response, 400, 'Target completion must be a valid date.');
      }
      update.projectedCompletion = projectedCompletion;
    }
    if (body.investmentReturnRate !== undefined && body.investmentReturnRate !== '') {
      const investmentReturnRate = Number(body.investmentReturnRate);
      if (!Number.isFinite(investmentReturnRate) || investmentReturnRate < 0 || investmentReturnRate > 1000) {
        return sendError(response, 400, 'Investment return rate must be a number between 0 and 1000.');
      }
      update.investmentReturnRate = investmentReturnRate;
    }

    const project = await db.saveProject(update);
    broadcastPortalChange('project');
    return sendJson(response, 200, { project });
  }

  const investmentMatch = /^\/api\/admin\/users\/([a-zA-Z0-9-]+)\/investment$/.exec(pathname);
  if (request.method === 'PATCH' && investmentMatch) {
    const admin = await requireAdmin(request, response);
    if (!admin) return;
    const body = await readJson(request);
    const investment = Number(body.investment);
    const user = await db.findUserById(investmentMatch[1]);
    if (!user || user.role === 'admin') return sendError(response, 404, 'Client account not found.');
    if (!Number.isFinite(investment) || investment < 0) return sendError(response, 400, 'Investment must be a positive number.');
    const updated = await db.updateUser(user.id, { investment: Math.round(investment) });
    broadcastPortalChange('investment', (client) => client.userId === user.id || client.role === 'admin');
    return sendJson(response, 200, { user: userSummary(updated) });
  }

  if (request.method === 'POST' && pathname === '/api/admin/documents') {
    const admin = await requireAdmin(request, response);
    if (!admin) return;
    const buffer = await readRequestBody(request, MAX_UPLOAD_BYTES);
    const { fields, files } = parseMultipart(buffer, request.headers['content-type']);
    const file = files.file;
    if (!file || !file.data.length) return sendError(response, 400, 'Choose a PDF to upload.');
    const isPdf = file.contentType === 'application/pdf' && file.data.subarray(0, 5).toString('ascii') === '%PDF-';
    if (!isPdf) return sendError(response, 400, 'Only valid PDF files can be uploaded.');
    const audience = fields.audience === 'all' ? 'all' : String(fields.audience || '');
    if (audience !== 'all') {
      const recipient = await db.findUserById(audience);
      if (!recipient || recipient.role !== 'user') return sendError(response, 400, 'Choose a valid recipient.');
    }
    const originalName = cleanText(path.basename(file.filename || 'Project document.pdf'), 140) || 'Project document.pdf';
    const fileId = await db.uploadFileToGridFS(file.data, originalName);
    const document = {
      id: crypto.randomUUID(),
      title: cleanText(fields.title, 140) || path.basename(originalName, '.pdf'),
      description: cleanText(fields.description, 300),
      originalName,
      audience,
      fileId: fileId.toString(),
      createdAt: new Date().toISOString(),
      uploadedBy: admin.id
    };
    await db.insertDocument(document);
    broadcastPortalChange('documents', (client) => canReceiveDocumentChange(client, document));
    return sendJson(response, 201, { document: visibleDocument(document) });
  }

  if (request.method === 'GET' && pathname === '/api/admin/documents') {
    const admin = await requireAdmin(request, response);
    if (!admin) return;
    const list = await db.allDocuments();
    return sendJson(response, 200, { documents: list.map(visibleDocument) });
  }

  const adminDocumentMatch = /^\/api\/admin\/documents\/([a-zA-Z0-9-]+)$/.exec(pathname);
  if (request.method === 'DELETE' && adminDocumentMatch) {
    const admin = await requireAdmin(request, response);
    if (!admin) return;
    const removed = await db.deleteDocument(adminDocumentMatch[1]);
    if (!removed) return sendError(response, 404, 'Document not found.');
    await db.deleteFileFromGridFS(new ObjectId(removed.fileId));
    broadcastPortalChange('documents', (client) => canReceiveDocumentChange(client, removed));
    return sendJson(response, 200, { ok: true });
  }

  return sendError(response, 404, 'This API endpoint was not found.');
}

const staticFiles = new Map([
  ['/', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/index.html', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/styles.css', { file: 'styles.css', type: 'text/css; charset=utf-8' }],
  ['/app.js', { file: 'app.js', type: 'text/javascript; charset=utf-8' }],
  ['/dashboard.html', { file: 'index.html', type: 'text/html; charset=utf-8' }]
]);

async function serveStatic(response, pathname) {
  if (pathname === '/favicon.ico') {
    response.writeHead(204);
    return response.end();
  }
  const asset = staticFiles.get(pathname);
  if (!asset) return sendError(response, 404, 'Page not found.');
  try {
    const content = await fsp.readFile(path.join(ROOT, asset.file));
    response.writeHead(200, {
      'Content-Type': asset.type,
      'Cache-Control': asset.file === 'index.html' ? 'no-store' : 'public, max-age=3600',
      'Content-Security-Policy': "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'",
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin'
    });
    response.end(content);
  } catch {
    sendError(response, 500, 'Unable to load application files.');
  }
}

const server = http.createServer(async (request, response) => {
  try {
    const parsedUrl = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    const pathname = decodeURIComponent(parsedUrl.pathname);
    if (request.method === 'OPTIONS') {
      response.writeHead(204, { Allow: 'GET, POST, PATCH, DELETE, OPTIONS' });
      return response.end();
    }
    if (pathname.startsWith('/api/')) return await handleApi(request, response, pathname);
    return await serveStatic(response, pathname);
  } catch (error) {
    const statusCode = error.statusCode || 500;
    if (statusCode >= 500) console.error(error);
    if (!response.headersSent) return sendError(response, statusCode, statusCode === 500 ? 'Something went wrong. Please try again.' : error.message);
    response.end();
  }
});

db.connect()
  .then(() => db.seedAdmin({ hashPassword, cleanText }))
  .then(() => server.listen(PORT, () => console.log(`Intercoastal Water portal is running at http://localhost:${PORT}`)))
  .catch((error) => {
    console.error('Unable to start the portal.', error);
    process.exit(1);
  });