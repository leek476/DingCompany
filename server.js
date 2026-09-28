'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(ROOT, 'uploads');
const DATABASE_FILE = path.join(DATA_DIR, 'database.json');
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;
const MAX_JSON_BYTES = 1_000_000;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const EVENT_HEARTBEAT_MS = 25_000;
const sessions = new Map();
const eventClients = new Set();

let database;

const defaultProject = {
  id: 'intercoastal-integrated-utility',
  name: 'Intercoastal Integrated Utility Program',
  sector: 'Integrated Power, Water Supply & Sewage Treatment',
  location: 'Coastal Service District',
  totalProjectValue: 12800000,
  estimatedProjectCost: 8420000,
  projectProgress: 68,
  status: 'Construction in progress',
  startDate: '2026-06-15',
  projectedCompletion: '2026-12-20',
  duration: '18 months',
  description: 'A resilient utility program that combines dependable power generation, treated water supply and modern sewage treatment for growing coastal communities.',
  capacity: '18 MW power · 9 MGD water · 6 MGD treatment',
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

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function defaultDatabase() {
  return { users: [], project: clone(defaultProject), documents: [], messages: [] };
}

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

async function initializeDatabase() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.mkdir(UPLOAD_DIR, { recursive: true });

  try {
    database = JSON.parse(await fsp.readFile(DATABASE_FILE, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    database = defaultDatabase();
  }

  database.users ||= [];
  database.documents ||= [];
  database.messages ||= [];
  database.project ||= clone(defaultProject);
  database.project.stages ||= clone(defaultProject.stages);
  database.project.updates ||= clone(defaultProject.updates);

  const bootstrapEmail = normalizeEmail(process.env.ADMIN_EMAIL || 'admin@intercoastalwater.com');
  if (!database.users.some((user) => user.email === bootstrapEmail)) {
    const bootstrapPassword = process.env.ADMIN_PASSWORD || 'ChangeMe!2026';
    database.users.push({
      id: crypto.randomUUID(),
      email: bootstrapEmail,
      passwordHash: await hashPassword(bootstrapPassword),
      role: 'admin',
      investment: 0,
      createdAt: new Date().toISOString(),
      profile: {
        name: cleanText(process.env.ADMIN_NAME || 'Intercoastal Administrator', 80),
        company: 'Intercoastal Water LLC',
        phone: '',
        location: 'Coastal Service District'
      }
    });
  }
  saveDatabase();
}

function saveDatabase() {
  const temporaryFile = `${DATABASE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify(database, null, 2), 'utf8');
  fs.renameSync(temporaryFile, DATABASE_FILE);
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

function getCurrentUser(request) {
  const token = parseCookies(request.headers.cookie).intercoastal_session;
  const session = token && sessions.get(token);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }
  const user = database.users.find((candidate) => candidate.id === session.userId);
  return user || null;
}

function requireUser(request, response) {
  const user = getCurrentUser(request);
  if (!user) {
    sendError(response, 401, 'Please sign in to continue.');
    return null;
  }
  return user;
}

function requireAdmin(request, response) {
  const user = requireUser(request, response);
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

function overviewFor(user) {
  const project = database.project;
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

function openEventStream(request, response) {
  const user = getCurrentUser(request);
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
    if (database.users.some((user) => user.email === email)) {
      return sendError(response, 409, 'An account with that email already exists.');
    }
    const user = {
      id: crypto.randomUUID(),
      email,
      passwordHash: await hashPassword(password),
      role: 'user',
      investment: 0,
      createdAt: new Date().toISOString(),
      profile: { name, company: '', phone: '', location: '' }
    };
    database.users.push(user);
    saveDatabase();
    broadcastPortalChange('admin', (client) => client.role === 'admin');
    const token = createSession(user.id);
    return sendJson(response, 201, { user: publicUser(user) }, { 'Set-Cookie': sessionCookie(token) });
  }

  if (request.method === 'POST' && pathname === '/api/auth/login') {
    const body = await readJson(request);
    const email = normalizeEmail(body.email);
    const password = String(body.password || '');
    const user = database.users.find((candidate) => candidate.email === email);
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
    const user = requireUser(request, response);
    if (!user) return;
    return sendJson(response, 200, { user: publicUser(user) });
  }

  if (request.method === 'GET' && pathname === '/api/events') {
    return openEventStream(request, response);
  }

  if (request.method === 'GET' && pathname === '/api/dashboard') {
    const user = requireUser(request, response);
    if (!user) return;
    const documents = database.documents.filter((document) => canAccessDocument(document, user));
    return sendJson(response, 200, {
      user: publicUser(user),
      project: database.project,
      overview: overviewFor(user),
      recentDocuments: documents.slice(0, 3).map(visibleDocument),
      unreadMessages: database.messages.filter((message) => user.role === 'admin' || message.senderId === user.id).length
    });
  }

  if (request.method === 'GET' && pathname === '/api/documents') {
    const user = requireUser(request, response);
    if (!user) return;
    return sendJson(response, 200, {
      documents: database.documents.filter((document) => canAccessDocument(document, user)).map(visibleDocument)
    });
  }

  const documentMatch = /^\/api\/documents\/([a-zA-Z0-9-]+)\/download$/.exec(pathname);
  if (request.method === 'GET' && documentMatch) {
    const user = requireUser(request, response);
    if (!user) return;
    const document = database.documents.find((item) => item.id === documentMatch[1]);
    if (!document || !canAccessDocument(document, user)) return sendError(response, 404, 'Document not found.');
    const documentPath = path.join(UPLOAD_DIR, document.storageName);
    try {
      await fsp.access(documentPath);
    } catch {
      return sendError(response, 404, 'The uploaded file is no longer available.');
    }
    response.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(document.originalName)}`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    return fs.createReadStream(documentPath).pipe(response);
  }

  if (request.method === 'PATCH' && pathname === '/api/profile') {
    const user = requireUser(request, response);
    if (!user) return;
    const body = await readJson(request);
    const name = cleanText(body.name, 80);
    if (name.length < 2) return sendError(response, 400, 'Enter a name with at least 2 characters.');
    user.profile = {
      name,
      company: cleanText(body.company, 100),
      phone: cleanText(body.phone, 40),
      location: cleanText(body.location, 100)
    };
    saveDatabase();
    broadcastPortalChange('profile', (client) => client.userId === user.id || client.role === 'admin');
    return sendJson(response, 200, { user: publicUser(user) });
  }

  if (request.method === 'GET' && pathname === '/api/messages') {
    const user = requireUser(request, response);
    if (!user) return;
    const messages = user.role === 'admin'
      ? database.messages
      : database.messages.filter((message) => message.senderId === user.id || message.recipientId === user.id || message.recipientId === 'all');
    return sendJson(response, 200, { messages: messages.slice(0, 50) });
  }

  if (request.method === 'POST' && pathname === '/api/messages') {
    const user = requireUser(request, response);
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
    database.messages.unshift(messageRecord);
    saveDatabase();
    broadcastPortalChange('messages', (client) => canReceiveMessageChange(client, messageRecord));
    return sendJson(response, 201, { ok: true });
  }

  if (request.method === 'GET' && pathname === '/api/admin/summary') {
    const admin = requireAdmin(request, response);
    if (!admin) return;
    return sendJson(response, 200, {
      users: database.users.map(userSummary),
      documentCount: database.documents.length,
      messageCount: database.messages.length
    });
  }

  if (request.method === 'POST' && pathname === '/api/admin/users') {
    const admin = requireAdmin(request, response);
    if (!admin) return;
    const body = await readJson(request);
    const name = cleanText(body.name, 80);
    const email = normalizeEmail(body.email);
    const password = String(body.password || '');
    const role = body.role === 'admin' ? 'admin' : 'user';
    if (name.length < 2) return sendError(response, 400, 'Enter a full name.');
    if (!validEmail(email)) return sendError(response, 400, 'Enter a valid email address.');
    if (password.length < 8) return sendError(response, 400, 'Use a password with at least 8 characters.');
    if (database.users.some((user) => user.email === email)) {
      return sendError(response, 409, 'An account with that email already exists.');
    }
    const user = {
      id: crypto.randomUUID(),
      email,
      passwordHash: await hashPassword(password),
      role,
      investment: 0,
      createdAt: new Date().toISOString(),
      profile: { name, company: '', phone: '', location: '' }
    };
    database.users.push(user);
    saveDatabase();
    broadcastPortalChange('admin', (client) => client.role === 'admin');
    return sendJson(response, 201, { user: userSummary(user) });
  }

  if (request.method === 'PATCH' && pathname === '/api/admin/project') {
    const admin = requireAdmin(request, response);
    if (!admin) return;
    const body = await readJson(request);

    // The "Save timeline" form on the admin page sends only { stages }.
    // Handle that shape on its own — it must not require the project
    // figures (value/cost/progress) that a different form on the same
    // page is responsible for.
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
      database.project.stages = stages;
      saveDatabase();
      broadcastPortalChange('project');
      return sendJson(response, 200, { project: database.project });
    }

    // Otherwise this is the "Save project figures" form: value, cost and
    // progress are required; status, location and capacity are optional.
    const totalProjectValue = Number(body.totalProjectValue);
    const estimatedProjectCost = Number(body.estimatedProjectCost);
    const projectProgress = Number(body.projectProgress);
    if (![totalProjectValue, estimatedProjectCost, projectProgress].every(Number.isFinite) || totalProjectValue < 0 || estimatedProjectCost < 0 || projectProgress < 0 || projectProgress > 100) {
      return sendError(response, 400, 'Provide valid project value, cost and progress values.');
    }
    database.project.totalProjectValue = Math.round(totalProjectValue);
    database.project.estimatedProjectCost = Math.round(estimatedProjectCost);
    database.project.projectProgress = Math.round(projectProgress * 10) / 10;
    if (body.status) database.project.status = cleanText(body.status, 80);
    if (body.location) database.project.location = cleanText(body.location, 120);
    if (body.capacity) database.project.capacity = cleanText(body.capacity, 120);
    saveDatabase();
    broadcastPortalChange('project');
    return sendJson(response, 200, { project: database.project });
  }

  const investmentMatch = /^\/api\/admin\/users\/([a-zA-Z0-9-]+)\/investment$/.exec(pathname);
  if (request.method === 'PATCH' && investmentMatch) {
    const admin = requireAdmin(request, response);
    if (!admin) return;
    const body = await readJson(request);
    const investment = Number(body.investment);
    const user = database.users.find((candidate) => candidate.id === investmentMatch[1]);
    if (!user || user.role === 'admin') return sendError(response, 404, 'Client account not found.');
    if (!Number.isFinite(investment) || investment < 0) return sendError(response, 400, 'Investment must be a positive number.');
    user.investment = Math.round(investment);
    saveDatabase();
    broadcastPortalChange('investment', (client) => client.userId === user.id || client.role === 'admin');
    return sendJson(response, 200, { user: userSummary(user) });
  }

  if (request.method === 'POST' && pathname === '/api/admin/documents') {
    const admin = requireAdmin(request, response);
    if (!admin) return;
    const buffer = await readRequestBody(request, MAX_UPLOAD_BYTES);
    const { fields, files } = parseMultipart(buffer, request.headers['content-type']);
    const file = files.file;
    if (!file || !file.data.length) return sendError(response, 400, 'Choose a PDF to upload.');
    const isPdf = file.contentType === 'application/pdf' && file.data.subarray(0, 5).toString('ascii') === '%PDF-';
    if (!isPdf) return sendError(response, 400, 'Only valid PDF files can be uploaded.');
    const audience = fields.audience === 'all' ? 'all' : String(fields.audience || '');
    if (audience !== 'all' && !database.users.some((user) => user.id === audience && user.role === 'user')) {
      return sendError(response, 400, 'Choose a valid recipient.');
    }
    const extension = '.pdf';
    const storageName = `${crypto.randomUUID()}${extension}`;
    await fsp.writeFile(path.join(UPLOAD_DIR, storageName), file.data);
    const document = {
      id: crypto.randomUUID(),
      title: cleanText(fields.title, 140) || path.basename(file.filename || 'Project document.pdf', '.pdf'),
      description: cleanText(fields.description, 300),
      originalName: cleanText(path.basename(file.filename || 'Project document.pdf'), 140) || 'Project document.pdf',
      audience,
      storageName,
      createdAt: new Date().toISOString(),
      uploadedBy: admin.id
    };
    database.documents.unshift(document);
    saveDatabase();
    broadcastPortalChange('documents', (client) => canReceiveDocumentChange(client, document));
    return sendJson(response, 201, { document: visibleDocument(document) });
  }

  if (request.method === 'GET' && pathname === '/api/admin/documents') {
    const admin = requireAdmin(request, response);
    if (!admin) return;
    return sendJson(response, 200, { documents: database.documents.map(visibleDocument) });
  }

  const adminDocumentMatch = /^\/api\/admin\/documents\/([a-zA-Z0-9-]+)$/.exec(pathname);
  if (request.method === 'DELETE' && adminDocumentMatch) {
    const admin = requireAdmin(request, response);
    if (!admin) return;
    const index = database.documents.findIndex((item) => item.id === adminDocumentMatch[1]);
    if (index === -1) return sendError(response, 404, 'Document not found.');
    const [removed] = database.documents.splice(index, 1);
    saveDatabase();
    try {
      await fsp.unlink(path.join(UPLOAD_DIR, removed.storageName));
    } catch (error) {
      if (error.code !== 'ENOENT') console.error('Failed to remove an uploaded file from disk.', error);
    }
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
    if (pathname.startsWith('/api/')) return handleApi(request, response, pathname);
    return serveStatic(response, pathname);
  } catch (error) {
    const statusCode = error.statusCode || 500;
    if (statusCode >= 500) console.error(error);
    if (!response.headersSent) return sendError(response, statusCode, statusCode === 500 ? 'Something went wrong. Please try again.' : error.message);
    response.end();
  }
});

initializeDatabase()
  .then(() => server.listen(PORT, () => console.log(`Intercoastal Water portal is running at http://localhost:${PORT}`)))
  .catch((error) => {
    console.error('Unable to start the portal.', error);
    process.exit(1);
  });