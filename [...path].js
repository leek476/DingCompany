'use strict';

/**
 * Single catch-all serverless function handling every /api/* route.
 * Vercel routes any request under /api/ here (file-based routing on the
 * [...path] filename); static files (index.html, app.js, styles.css) are
 * served separately, straight from the project root, and never reach
 * this function.
 *
 * This is a direct port of the original server.js's handleApi(): same
 * routes, same validation, same response shapes, so app.js needed no
 * changes for any of this. What's different, and why:
 *
 *   - No `http.createServer` / `.listen()` — Vercel invokes this function
 *     per request; there is no persistent process to start.
 *   - `database` is loaded fresh from KV at the top of every request and
 *     saved back after any mutation, instead of living in a module-level
 *     variable — serverless functions don't share memory across requests.
 *   - Real-time push (SSE via /api/events) is gone. A long-lived open
 *     connection doesn't fit a serverless function's execution model, and
 *     the `eventClients` broadcast list can't be shared across instances
 *     anyway. app.js now polls instead — see the note in that file.
 *   - PDF uploads/downloads go through Vercel Blob (lib/store.js) instead
 *     of local disk.
 */

const crypto = require('node:crypto');
const path = require('node:path');
const store = require('../lib/store');

const MAX_JSON_BYTES = 1_000_000;
// Vercel's Node serverless functions cap the request body (historically
// ~4.5 MB on the default plan) well below the original 10 MB. Uploads
// bigger than this are rejected before they'd hit that platform limit
// anyway. Raise it only if your Vercel plan's function payload limit
// allows it — check your plan's current limit before increasing this.
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

/* ------------------------------------------------------------------ *
 * Small helpers — unchanged from the original server.js
 * ------------------------------------------------------------------ */

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

function apiHeaders(response) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'same-origin');
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

function sessionCookie(token, maxAge = 60 * 60 * 12) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `intercoastal_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`;
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

/* ------------------------------------------------------------------ *
 * Auth helpers — session lookup now goes to KV instead of an in-memory
 * Map, and takes the already-loaded `database` to resolve the user.
 * ------------------------------------------------------------------ */

async function getCurrentUser(request, database) {
  const token = parseCookies(request.headers.cookie).intercoastal_session;
  const session = await store.getSession(token);
  if (!session) return null;
  return database.users.find((candidate) => candidate.id === session.userId) || null;
}

async function requireUser(request, response, database) {
  const user = await getCurrentUser(request, database);
  if (!user) {
    sendError(response, 401, 'Please sign in to continue.');
    return null;
  }
  return user;
}

async function requireAdmin(request, response, database) {
  const user = await requireUser(request, response, database);
  if (!user) return null;
  if (user.role !== 'admin') {
    sendError(response, 403, 'Administrator access is required.');
    return null;
  }
  return user;
}

/* ------------------------------------------------------------------ *
 * Route handler
 * ------------------------------------------------------------------ */

module.exports = async function handler(request, response) {
  try {
    if (request.method === 'OPTIONS') {
      response.writeHead(204, { Allow: 'GET, POST, PATCH, DELETE, OPTIONS' });
      return response.end();
    }

    const parsedUrl = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    const pathname = decodeURIComponent(parsedUrl.pathname);
    apiHeaders(response);

    const database = await store.getDatabase();

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
        passwordHash: await store.hashPassword(password),
        role: 'user',
        investment: 0,
        createdAt: new Date().toISOString(),
        profile: { name, company: '', phone: '', location: '' }
      };
      database.users.push(user);
      await store.saveDatabase(database);
      const token = await store.createSession(user.id);
      return sendJson(response, 201, { user: publicUser(user) }, { 'Set-Cookie': sessionCookie(token) });
    }

    if (request.method === 'POST' && pathname === '/api/auth/login') {
      const body = await readJson(request);
      const email = normalizeEmail(body.email);
      const password = String(body.password || '');
      const user = database.users.find((candidate) => candidate.email === email);
      if (!user || !(await store.passwordMatches(password, user.passwordHash))) {
        return sendError(response, 401, 'Invalid email or password.');
      }
      const token = await store.createSession(user.id);
      return sendJson(response, 200, { user: publicUser(user) }, { 'Set-Cookie': sessionCookie(token) });
    }

    if (request.method === 'POST' && pathname === '/api/auth/logout') {
      const token = parseCookies(request.headers.cookie).intercoastal_session;
      await store.destroySession(token);
      return sendJson(response, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
    }

    if (request.method === 'GET' && pathname === '/api/auth/me') {
      const user = await requireUser(request, response, database);
      if (!user) return;
      return sendJson(response, 200, { user: publicUser(user) });
    }

    if (request.method === 'GET' && pathname === '/api/dashboard') {
      const user = await requireUser(request, response, database);
      if (!user) return;
      const documents = database.documents.filter((document) => canAccessDocument(document, user));
      return sendJson(response, 200, {
        user: publicUser(user),
        project: database.project,
        overview: overviewFor(user, database.project),
        recentDocuments: documents.slice(0, 3).map(visibleDocument),
        unreadMessages: database.messages.filter((message) => user.role === 'admin' || message.senderId === user.id).length
      });
    }

    if (request.method === 'GET' && pathname === '/api/documents') {
      const user = await requireUser(request, response, database);
      if (!user) return;
      return sendJson(response, 200, {
        documents: database.documents.filter((document) => canAccessDocument(document, user)).map(visibleDocument)
      });
    }

    const documentMatch = /^\/api\/documents\/([a-zA-Z0-9-]+)\/download$/.exec(pathname);
    if (request.method === 'GET' && documentMatch) {
      const user = await requireUser(request, response, database);
      if (!user) return;
      const document = database.documents.find((item) => item.id === documentMatch[1]);
      if (!document || !canAccessDocument(document, user)) return sendError(response, 404, 'Document not found.');
      let fileBuffer;
      try {
        fileBuffer = await store.fetchDocumentBuffer(document.blobUrl);
      } catch {
        return sendError(response, 404, 'The uploaded file is no longer available.');
      }
      response.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(document.originalName)}`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff'
      });
      return response.end(fileBuffer);
    }

    if (request.method === 'PATCH' && pathname === '/api/profile') {
      const user = await requireUser(request, response, database);
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
      await store.saveDatabase(database);
      return sendJson(response, 200, { user: publicUser(user) });
    }

    if (request.method === 'GET' && pathname === '/api/messages') {
      const user = await requireUser(request, response, database);
      if (!user) return;
      const messages = user.role === 'admin'
        ? database.messages
        : database.messages.filter((message) => message.senderId === user.id || message.recipientId === user.id || message.recipientId === 'all');
      return sendJson(response, 200, { messages: messages.slice(0, 50) });
    }

    if (request.method === 'POST' && pathname === '/api/messages') {
      const user = await requireUser(request, response, database);
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
      await store.saveDatabase(database);
      return sendJson(response, 201, { ok: true });
    }

    if (request.method === 'GET' && pathname === '/api/admin/summary') {
      const admin = await requireAdmin(request, response, database);
      if (!admin) return;
      return sendJson(response, 200, {
        users: database.users.map(userSummary),
        documentCount: database.documents.length,
        messageCount: database.messages.length
      });
    }

    if (request.method === 'POST' && pathname === '/api/admin/users') {
      const admin = await requireAdmin(request, response, database);
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
        passwordHash: await store.hashPassword(password),
        role,
        investment: 0,
        createdAt: new Date().toISOString(),
        profile: { name, company: '', phone: '', location: '' }
      };
      database.users.push(user);
      await store.saveDatabase(database);
      return sendJson(response, 201, { user: userSummary(user) });
    }

    if (request.method === 'PATCH' && pathname === '/api/admin/project') {
      const admin = await requireAdmin(request, response, database);
      if (!admin) return;
      const body = await readJson(request);

      // The "Save timeline" form sends only { stages }; handle that shape
      // on its own so it doesn't require the figures fields below.
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
        await store.saveDatabase(database);
        return sendJson(response, 200, { project: database.project });
      }

      // Otherwise this is the "Save project figures" form.
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
      await store.saveDatabase(database);
      return sendJson(response, 200, { project: database.project });
    }

    const investmentMatch = /^\/api\/admin\/users\/([a-zA-Z0-9-]+)\/investment$/.exec(pathname);
    if (request.method === 'PATCH' && investmentMatch) {
      const admin = await requireAdmin(request, response, database);
      if (!admin) return;
      const body = await readJson(request);
      const investment = Number(body.investment);
      const user = database.users.find((candidate) => candidate.id === investmentMatch[1]);
      if (!user || user.role === 'admin') return sendError(response, 404, 'Client account not found.');
      if (!Number.isFinite(investment) || investment < 0) return sendError(response, 400, 'Investment must be a positive number.');
      user.investment = Math.round(investment);
      await store.saveDatabase(database);
      return sendJson(response, 200, { user: userSummary(user) });
    }

    if (request.method === 'POST' && pathname === '/api/admin/documents') {
      const admin = await requireAdmin(request, response, database);
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
      const storageName = `${crypto.randomUUID()}.pdf`;
      const blobUrl = await store.storeDocumentFile(storageName, file.data, 'application/pdf');
      const document = {
        id: crypto.randomUUID(),
        title: cleanText(fields.title, 140) || path.basename(file.filename || 'Project document.pdf', '.pdf'),
        description: cleanText(fields.description, 300),
        originalName: cleanText(path.basename(file.filename || 'Project document.pdf'), 140) || 'Project document.pdf',
        audience,
        blobUrl,
        createdAt: new Date().toISOString(),
        uploadedBy: admin.id
      };
      database.documents.unshift(document);
      await store.saveDatabase(database);
      return sendJson(response, 201, { document: visibleDocument(document) });
    }

    if (request.method === 'GET' && pathname === '/api/admin/documents') {
      const admin = await requireAdmin(request, response, database);
      if (!admin) return;
      return sendJson(response, 200, { documents: database.documents.map(visibleDocument) });
    }

    const adminDocumentMatch = /^\/api\/admin\/documents\/([a-zA-Z0-9-]+)$/.exec(pathname);
    if (request.method === 'DELETE' && adminDocumentMatch) {
      const admin = await requireAdmin(request, response, database);
      if (!admin) return;
      const index = database.documents.findIndex((item) => item.id === adminDocumentMatch[1]);
      if (index === -1) return sendError(response, 404, 'Document not found.');
      const [removed] = database.documents.splice(index, 1);
      await store.saveDatabase(database);
      await store.deleteDocumentFile(removed.blobUrl);
      return sendJson(response, 200, { ok: true });
    }

    return sendError(response, 404, 'This API endpoint was not found.');
  } catch (error) {
    const statusCode = error.statusCode || 500;
    if (statusCode >= 500) console.error(error);
    if (!response.headersSent) return sendError(response, statusCode, statusCode === 500 ? 'Something went wrong. Please try again.' : error.message);
    response.end();
  }
};