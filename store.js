'use strict';

/**
 * Persistence layer for Vercel's serverless environment.
 *
 * The original server kept everything in a local JSON file, local disk
 * uploads, and an in-memory sessions Map. None of that survives on Vercel:
 * serverless functions are stateless, the filesystem is read-only (except
 * /tmp, which is wiped between invocations and never shared across them),
 * and there's no memory shared between requests. This file swaps each of
 * those three things for a Vercel-managed service with the same shape:
 *
 *   - the whole `database` object  -> one JSON value in Vercel KV
 *   - sessions (in-memory Map)     -> one KV key per token, with a TTL
 *   - uploaded PDFs (local disk)   -> Vercel Blob
 *
 * Requires two things attached to the Vercel project (dashboard -> Storage):
 * a KV store and a Blob store. Attaching them injects the env vars these
 * SDKs read automatically (KV_REST_API_URL/TOKEN, BLOB_READ_WRITE_TOKEN) —
 * nothing to configure here.
 */

const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { Redis } = require('@upstash/redis');

const scrypt = promisify(crypto.scrypt);
const DATABASE_KEY = 'intercoastal:database';
const SESSION_PREFIX = 'intercoastal:session:';
const SESSION_TTL_SECONDS = 60 * 60 * 12; // 12 hours — matches the original SESSION_TTL_MS

// Vercel's own "KV" product was discontinued (Dec 2024) — every existing
// store was migrated to plain Upstash Redis, and @vercel/kv is a dead
// package (no releases since Sept 2024, and its own npm listing says so).
// @upstash/redis is the direct replacement with the same get/set/del
// surface. Redis.fromEnv() reads whichever env vars your Vercel project
// actually has — it checks both the legacy KV_REST_API_URL/KV_REST_API_TOKEN
// names and the current UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN
// names, so it works however you attached the store.
//
// Built lazily (on first real use, inside a request) rather than at
// module load time: if the env vars are ever genuinely missing, this way
// the error surfaces as a normal caught 500 with a readable message
// instead of a hard, undebuggable FUNCTION_INVOCATION_FAILED crash.
let redisClient;
function redis() {
  if (!redisClient) redisClient = Redis.fromEnv();
  return redisClient;
}

// Same reasoning as redis() above, applied to Blob: require it lazily, on
// first actual use inside a request, so a missing BLOB_READ_WRITE_TOKEN
// (Blob store not attached yet) surfaces as a caught, readable 500 instead
// of an opaque platform-level crash.
let blobModule;
function blob() {
  if (!blobModule) blobModule = require('@vercel/blob');
  return blobModule;
}

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

/* ------------------------------------------------------------------ *
 * Database (one JSON document in KV, read-modify-write per request)
 * ------------------------------------------------------------------ */

async function getDatabase() {
  const stored = await redis().get(DATABASE_KEY);
  const database = stored || defaultDatabase();
  database.users ||= [];
  database.documents ||= [];
  database.messages ||= [];
  database.project ||= clone(defaultProject);
  database.project.stages ||= clone(defaultProject.stages);
  database.project.updates ||= clone(defaultProject.updates);

  // Bootstrap the admin account if it's missing — same idempotent check the
  // original server ran on every startup, just run per-load here instead.
  const bootstrapEmail = String(process.env.ADMIN_EMAIL || 'admin@intercoastalwater.com').trim().toLowerCase();
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
        name: String(process.env.ADMIN_NAME || 'Intercoastal Administrator').slice(0, 80),
        company: 'Intercoastal Water LLC',
        phone: '',
        location: 'Coastal Service District'
      }
    });
    await redis().set(DATABASE_KEY, database);
  } else if (!stored) {
    await redis().set(DATABASE_KEY, database);
  }

  return database;
}

async function saveDatabase(database) {
  await redis().set(DATABASE_KEY, database);
}

/* ------------------------------------------------------------------ *
 * Sessions (one KV key per token, Redis-native TTL instead of a
 * manually-checked expiresAt field)
 * ------------------------------------------------------------------ */

async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  await redis().set(`${SESSION_PREFIX}${token}`, { userId }, { ex: SESSION_TTL_SECONDS });
  return token;
}

async function getSession(token) {
  if (!token) return null;
  return (await redis().get(`${SESSION_PREFIX}${token}`)) || null;
}

async function destroySession(token) {
  if (token) await redis().del(`${SESSION_PREFIX}${token}`);
}

/* ------------------------------------------------------------------ *
 * Document files (Vercel Blob instead of local disk). Blobs are stored
 * "public" (Blob has no per-request auth of its own), so the actual
 * access check — canAccessDocument() in api/[...path].js — happens
 * server-side and the file bytes are proxied through our function.
 * The Blob URL itself is never sent to the browser.
 * ------------------------------------------------------------------ */

async function storeDocumentFile(storageName, buffer, contentType) {
  const { put } = blob();
  const uploaded = await put(`documents/${storageName}`, buffer, {
    access: 'public',
    contentType,
    addRandomSuffix: false
  });
  return uploaded.url;
}

async function fetchDocumentBuffer(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error('The uploaded file is no longer available.');
  return Buffer.from(await response.arrayBuffer());
}

async function deleteDocumentFile(url) {
  if (!url) return;
  try {
    const { del } = blob();
    await del(url);
  } catch (error) {
    // Non-fatal: the database record is already gone, which is what the
    // rest of the app checks. A stray blob left in storage isn't visible
    // to users and can be cleaned up later.
    console.error('Failed to remove a file from Blob storage.', error);
  }
}

module.exports = {
  defaultProject,
  clone,
  defaultDatabase,
  getDatabase,
  saveDatabase,
  hashPassword,
  passwordMatches,
  createSession,
  getSession,
  destroySession,
  storeDocumentFile,
  fetchDocumentBuffer,
  deleteDocumentFile
};