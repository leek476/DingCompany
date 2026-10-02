'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { copyFile, mkdtemp, rm } = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const REPOSITORY_ROOT = path.resolve(__dirname, '..');
const TEST_TIMEOUT_MS = 15_000;
const EVENT_TIMEOUT_MS = 2_000;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function withTimeout(promise, milliseconds, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), milliseconds);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function reservePort() {
  const probe = http.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const { port } = probe.address();
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

function startPortal(directory, port) {
  let output = '';
  const child = spawn(process.execPath, ['server.js'], {
    cwd: directory,
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'test',
      ADMIN_EMAIL: 'admin.realtime@example.test',
      ADMIN_PASSWORD: 'RealtimeAdminPass!2026',
      ADMIN_NAME: 'Realtime Test Administrator'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });

  return { child, output: () => output };
}

async function waitForPortal(baseUrl, childProcess) {
  const deadline = Date.now() + 5_000;
  let lastError;

  while (Date.now() < deadline) {
    if (childProcess.child.exitCode !== null) {
      throw new Error(`The test portal exited during startup.\n${childProcess.output()}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/auth/me`);
      await response.text();
      if (response.status === 401) return;
      lastError = new Error(`Unexpected readiness response: ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(40);
  }

  throw new Error(`The test portal did not become ready. ${lastError?.message || ''}\n${childProcess.output()}`);
}

async function stopPortal(childProcess) {
  if (!childProcess || childProcess.exitCode !== null) return;

  const exited = once(childProcess, 'exit');
  childProcess.kill('SIGTERM');
  const stopped = await Promise.race([
    exited,
    delay(2_000).then(() => false)
  ]);
  if (stopped === false && childProcess.exitCode === null) {
    childProcess.kill('SIGKILL');
    await once(childProcess, 'exit');
  }
}

async function jsonRequest(baseUrl, pathname, { method = 'GET', cookie, json } = {}) {
  const headers = { Accept: 'application/json' };
  if (cookie) headers.Cookie = cookie;
  if (json !== undefined) headers['Content-Type'] = 'application/json';

  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers,
    body: json === undefined ? undefined : JSON.stringify(json)
  });
  const text = await response.text();
  return {
    response,
    body: text ? JSON.parse(text) : null
  };
}

function sessionCookie(response) {
  const header = response.headers.get('set-cookie');
  assert.ok(header, 'A successful authentication response should set a session cookie.');
  return header.split(';', 1)[0];
}

function parseSseFrame(frame) {
  let event = 'message';
  const data = [];

  for (const line of frame.replace(/\r/g, '').split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const separator = line.indexOf(':');
    const field = separator === -1 ? line : line.slice(0, separator);
    const value = separator === -1 ? '' : line.slice(separator + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    if (field === 'data') data.push(value);
  }

  if (!data.length) return null;
  return { event, data: JSON.parse(data.join('\n')) };
}

async function nextSseEvent(stream) {
  while (true) {
    const separator = stream.buffer.indexOf('\n\n');
    if (separator !== -1) {
      const frame = stream.buffer.slice(0, separator);
      stream.buffer = stream.buffer.slice(separator + 2);
      const event = parseSseFrame(frame);
      if (event) return event;
      continue;
    }

    const { done, value } = await stream.reader.read();
    if (done) throw new Error('The SSE stream ended before the expected event arrived.');
    stream.buffer += stream.decoder.decode(value, { stream: true });
  }
}

async function nextPortalChange(stream) {
  while (true) {
    const event = await nextSseEvent(stream);
    if (event.event === 'portal-change') return event;
  }
}

async function openSseStream(baseUrl, cookie) {
  const controller = new AbortController();
  const response = await fetch(`${baseUrl}/api/events`, {
    headers: { Accept: 'text/event-stream', Cookie: cookie },
    signal: controller.signal
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /^text\/event-stream/i);

  const stream = {
    controller,
    decoder: new TextDecoder(),
    reader: response.body.getReader(),
    buffer: ''
  };
  const connected = await withTimeout(nextSseEvent(stream), EVENT_TIMEOUT_MS, 'Timed out waiting for the SSE connection event.');
  assert.equal(connected.event, 'connected');
  assert.ok(Number.isFinite(Date.parse(connected.data.at)), 'The connection event should include an ISO timestamp.');
  return stream;
}

function closeSseStream(stream) {
  if (!stream) return;
  stream.controller.abort();
  stream.reader.cancel().catch(() => {});
}

function assertPortalChange(event, type) {
  assert.equal(event.event, 'portal-change');
  assert.deepEqual(Object.keys(event.data).sort(), ['at', 'type']);
  assert.equal(event.data.type, type);
  assert.ok(Number.isFinite(Date.parse(event.data.at)), 'Change events should include an ISO timestamp.');
}

async function assertNoPortalChange(stream) {
  const result = await Promise.race([
    nextPortalChange(stream).then((event) => ({ event })),
    delay(450).then(() => null)
  ]);
  assert.equal(result, null, `An unrelated client received a private event: ${JSON.stringify(result?.event?.data)}`);
}

test('authenticates SSE clients and scopes project and investment changes', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'intercoastal-realtime-test-'));
  const serverPath = path.join(temporaryRoot, 'server.js');
  let childProcess;
  const streams = [];

  t.after(async () => {
    for (const stream of streams) closeSseStream(stream);
    await stopPortal(childProcess?.child);
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  await copyFile(path.join(REPOSITORY_ROOT, 'server.js'), serverPath);
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  childProcess = startPortal(temporaryRoot, port);
  await waitForPortal(baseUrl, childProcess);

  const unauthenticatedEvents = await jsonRequest(baseUrl, '/api/events');
  assert.equal(unauthenticatedEvents.response.status, 401);

  const invalidLogin = await jsonRequest(baseUrl, '/api/auth/login', {
    method: 'POST',
    json: { email: 'admin.realtime@example.test', password: 'not-the-password' }
  });
  assert.equal(invalidLogin.response.status, 401);

  const adminLogin = await jsonRequest(baseUrl, '/api/auth/login', {
    method: 'POST',
    json: { email: 'admin.realtime@example.test', password: 'RealtimeAdminPass!2026' }
  });
  assert.equal(adminLogin.response.status, 200);
  const adminCookie = sessionCookie(adminLogin.response);

  const clientRegistration = await jsonRequest(baseUrl, '/api/auth/register', {
    method: 'POST',
    json: { name: 'Realtime Client', email: 'realtime.client@example.test', password: 'ClientPass!2026' }
  });
  assert.equal(clientRegistration.response.status, 201);
  const clientCookie = sessionCookie(clientRegistration.response);
  const clientId = clientRegistration.body.user.id;

  const observerRegistration = await jsonRequest(baseUrl, '/api/auth/register', {
    method: 'POST',
    json: { name: 'Unrelated Client', email: 'unrelated.client@example.test', password: 'ObserverPass!2026' }
  });
  assert.equal(observerRegistration.response.status, 201);
  const observerCookie = sessionCookie(observerRegistration.response);

  const adminStream = await openSseStream(baseUrl, adminCookie);
  const clientStream = await openSseStream(baseUrl, clientCookie);
  const observerStream = await openSseStream(baseUrl, observerCookie);
  streams.push(adminStream, clientStream, observerStream);

  const dashboard = await jsonRequest(baseUrl, '/api/dashboard', { cookie: adminCookie });
  assert.equal(dashboard.response.status, 200);
  const project = dashboard.body.project;
  const projectUpdate = await jsonRequest(baseUrl, '/api/admin/project', {
    method: 'PATCH',
    cookie: adminCookie,
    json: {
      totalProjectValue: project.totalProjectValue + 1_000,
      estimatedProjectCost: project.estimatedProjectCost,
      projectProgress: project.projectProgress,
      status: project.status,
      capitalDeployed: 350000,
      remainingCapital: 150000
    }
  });
  assert.equal(projectUpdate.response.status, 200);
  assert.equal(projectUpdate.body.project.capitalDeployed, 350000);
  assert.equal(projectUpdate.body.project.remainingCapital, 150000);

  const projectEvents = await Promise.all([
    withTimeout(nextPortalChange(adminStream), EVENT_TIMEOUT_MS, 'Admin did not receive the project event.'),
    withTimeout(nextPortalChange(clientStream), EVENT_TIMEOUT_MS, 'Client did not receive the shared project event.'),
    withTimeout(nextPortalChange(observerStream), EVENT_TIMEOUT_MS, 'Observer did not receive the shared project event.')
  ]);
  projectEvents.forEach((event) => assertPortalChange(event, 'project'));

  const investmentUpdate = await jsonRequest(baseUrl, `/api/admin/users/${encodeURIComponent(clientId)}/investment`, {
    method: 'PATCH',
    cookie: adminCookie,
    json: { investment: 275_000 }
  });
  assert.equal(investmentUpdate.response.status, 200);

  const [adminInvestmentEvent, clientInvestmentEvent] = await Promise.all([
    withTimeout(nextPortalChange(adminStream), EVENT_TIMEOUT_MS, 'Admin did not receive the investment event.'),
    withTimeout(nextPortalChange(clientStream), EVENT_TIMEOUT_MS, 'The invested client did not receive the investment event.')
  ]);
  assertPortalChange(adminInvestmentEvent, 'investment');
  assertPortalChange(clientInvestmentEvent, 'investment');
  await assertNoPortalChange(observerStream);
});
