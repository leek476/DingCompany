'use strict';

/*
 * MongoDB-backed persistence for the Intercoastal portal, using the
 * official `mongodb` driver (no ORM) to stay close to the original
 * vanilla-Node style of server.js.
 *
 * Required environment variable: MONGODB_URI
 *   mongodb+srv://USER:PASSWORD@CLUSTER.mongodb.net/intercoastal?retryWrites=true&w=majority
 *
 * Users, the project record, messages and document metadata are stored
 * as plain documents keyed by the same `id` (a crypto.randomUUID()
 * string) the rest of server.js already uses — so nothing else in the
 * app has to change shape. Uploaded PDFs are stored in GridFS instead
 * of the local uploads/ folder, so there is no Render disk to manage.
 */

const { MongoClient, GridFSBucket } = require('mongodb');
const { Readable } = require('node:stream');
const crypto = require('node:crypto');

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error('MONGODB_URI is not set. Add it in Render → Environment, or in a local .env file.');
  process.exit(1);
}

let client;
let db;
let bucket;
let users;
let documents;
let messages;
let projects;

async function connect() {
  client = new MongoClient(MONGODB_URI);
  await client.connect();
  // client.db() with no argument requires the database name to already be
  // part of MONGODB_URI (e.g. .../intercoastal?...). Atlas's own "copy
  // connection string" button omits it by default, which makes client.db()
  // throw immediately — so fall back to an explicit name here instead.
  db = client.db(process.env.MONGODB_DB_NAME || 'intercoastal');
  bucket = new GridFSBucket(db, { bucketName: 'documents' });
  users = db.collection('users');
  documents = db.collection('documents');
  messages = db.collection('messages');
  projects = db.collection('project');

  await users.createIndex({ email: 1 }, { unique: true });
  await users.createIndex({ id: 1 }, { unique: true });
  await documents.createIndex({ id: 1 }, { unique: true });
  await messages.createIndex({ id: 1 }, { unique: true });

  console.log('Connected to MongoDB');
}

/* ---------- project (singleton document, fixed id) ---------- */

const PROJECT_ID = 'intercoastal-integrated-utility';

async function getProject(defaultProject) {
  let project = await projects.findOne({ id: PROJECT_ID });
  if (!project) {
    project = { ...defaultProject };
    await projects.insertOne(project);
  }
  return stripMongoId(project);
}

async function saveProject(update) {
  await projects.updateOne({ id: PROJECT_ID }, { $set: update }, { upsert: true });
  return getProject(update);
}

/* ---------- users ---------- */

function stripMongoId(doc) {
  if (!doc) return doc;
  const { _id, ...rest } = doc;
  return rest;
}

async function findUserByEmail(email) {
  const user = await users.findOne({ email });
  return stripMongoId(user);
}

async function findUserById(id) {
  const user = await users.findOne({ id });
  return stripMongoId(user);
}

async function allUsers() {
  const list = await users.find({}).toArray();
  return list.map(stripMongoId);
}

async function insertUser(user) {
  await users.insertOne(user);
  return user;
}

async function updateUser(id, update) {
  await users.updateOne({ id }, { $set: update });
  return findUserById(id);
}

async function userCountByEmail(email) {
  return users.countDocuments({ email });
}

/* ---------- documents (metadata) + GridFS (file bytes) ---------- */

async function insertDocument(doc) {
  await documents.insertOne(doc);
  return doc;
}

async function findDocument(id) {
  const doc = await documents.findOne({ id });
  return stripMongoId(doc);
}

async function allDocuments() {
  const list = await documents.find({}).sort({ createdAt: -1 }).toArray();
  return list.map(stripMongoId);
}

async function deleteDocument(id) {
  const doc = await documents.findOne({ id });
  if (!doc) return null;
  await documents.deleteOne({ id });
  return stripMongoId(doc);
}

function uploadFileToGridFS(buffer, filename) {
  return new Promise((resolve, reject) => {
    const uploadStream = bucket.openUploadStream(filename, { contentType: 'application/pdf' });
    Readable.from(buffer).pipe(uploadStream)
      .on('error', reject)
      .on('finish', () => resolve(uploadStream.id));
  });
}

function downloadFileStream(fileId) {
  return bucket.openDownloadStream(fileId);
}

async function deleteFileFromGridFS(fileId) {
  try { await bucket.delete(fileId); } catch { /* already gone is fine */ }
}

/* ---------- messages ---------- */

async function insertMessage(message) {
  await messages.insertOne(message);
  return message;
}

async function messagesFor(user) {
  const query = user.role === 'admin'
    ? {}
    : { $or: [{ senderId: user.id }, { recipientId: user.id }, { recipientId: 'all' }] };
  const list = await messages.find(query).sort({ createdAt: -1 }).limit(50).toArray();
  return list.map(stripMongoId);
}

async function countMessages() {
  return messages.countDocuments();
}

/* ---------- admin seeding ---------- */

async function seedAdmin({ hashPassword, cleanText }) {
  const bootstrapEmail = String(process.env.ADMIN_EMAIL || 'admin@intercoastalwater.com').trim().toLowerCase();
  const existing = await findUserByEmail(bootstrapEmail);
  if (existing) {
    console.log(`Administrator already exists: ${bootstrapEmail}`);
    return;
  }
  const anyAdmin = await users.findOne({ role: 'admin' });
  if (anyAdmin) {
    console.log(`Administrator already exists: ${anyAdmin.email}`);
    return;
  }
  const bootstrapPassword = process.env.ADMIN_PASSWORD || 'ChangeMe!2026';
  await insertUser({
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
  console.log(`Created administrator account for ${bootstrapEmail}`);
}

module.exports = {
  connect,
  getProject,
  saveProject,
  findUserByEmail,
  findUserById,
  allUsers,
  insertUser,
  updateUser,
  userCountByEmail,
  insertDocument,
  findDocument,
  allDocuments,
  deleteDocument,
  uploadFileToGridFS,
  downloadFileStream,
  deleteFileFromGridFS,
  insertMessage,
  messagesFor,
  countMessages,
  seedAdmin
};