// XUL-J prototype server: streams UI operations over SSE, receives intents over POST.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { validate } = require('./protocol/validate');
const app = require('./app/deploy-console');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC = path.join(__dirname, 'public');
const SESSION_TTL_MS = 10 * 60 * 1000;
const sessions = new Map();

class Session {
  constructor(id) {
    this.id = id;
    this.seq = 0;
    this.log = [];
    this.clients = new Set();
    this.commands = new Map();
    this.touched = Date.now();
    this.closed = false;
  }

  emit(op) {
    const errs = validate(op);
    if (errs.length) throw new Error(`invalid op ${JSON.stringify(op)}:\n  ${errs.join('\n  ')}`);
    if (op.op === 'command') this.commands.set(op.id, { ...this.commands.get(op.id), ...op });
    const msg = { ...op, seq: ++this.seq };
    this.log.push(msg);
    const frame = `id: ${msg.seq}\ndata: ${JSON.stringify(msg)}\n\n`;
    for (const res of this.clients) res.write(frame);
  }

  replay(res, from) {
    // A client ahead of us (e.g. the server restarted) gets everything, starting with the reset op.
    const start = from > this.seq ? 0 : from;
    for (const msg of this.log) if (msg.seq > start) res.write(`id: ${msg.seq}\ndata: ${JSON.stringify(msg)}\n\n`);
  }
}

function getSession(id) {
  let s = sessions.get(id);
  if (!s) {
    s = new Session(id);
    sessions.set(id, s);
    s.app = app.start(s);
  }
  s.touched = Date.now();
  return s;
}

setInterval(() => {
  for (const [id, s] of sessions) {
    if (s.clients.size === 0 && Date.now() - s.touched > SESSION_TTL_MS) {
      s.closed = true;
      sessions.delete(id);
    }
  }
}, 60 * 1000).unref();

const INTENTS = {
  do: (m) => typeof m.command === 'string',
  input: (m) => typeof m.id === 'string' && 'value' in m,
  select: (m) => typeof m.id === 'string' && Array.isArray(m.rows) && m.rows.every((r) => Number.isInteger(r) && r >= 0),
  activate: (m) => typeof m.id === 'string' && Number.isInteger(m.row) && m.row >= 0,
  contextmenu: (m) => typeof m.id === 'string' && typeof m.target === 'string',
};

function handleStream(req, res, url) {
  const id = url.searchParams.get('session');
  if (!id || !/^[A-Za-z0-9_-]{4,64}$/.test(id)) return send(res, 400, 'bad session');
  const s = getSession(id);
  const from = Number(req.headers['last-event-id'] || url.searchParams.get('from') || 0);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 1000\n\n');
  s.replay(res, from);
  s.clients.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => {
    clearInterval(ping);
    s.clients.delete(res);
    s.touched = Date.now();
  });
}

function handleIntent(req, res, url) {
  const s = sessions.get(url.searchParams.get('session'));
  if (!s) return send(res, 404, 'no such session');
  let body = '';
  req.on('data', (c) => {
    body += c;
    if (body.length > 64 * 1024) req.destroy();
  });
  req.on('end', () => {
    let msg;
    try { msg = JSON.parse(body); } catch { return send(res, 400, 'bad json'); }
    if (!INTENTS[msg.op] || !INTENTS[msg.op](msg)) return send(res, 400, 'bad intent');
    if (msg.op === 'do') {
      const cmd = s.commands.get(msg.command);
      if (!cmd) return send(res, 404, 'unknown command');
      if (cmd.disabled) return send(res, 409, 'command disabled');
    }
    s.touched = Date.now();
    try {
      s.app.intent(msg);
    } catch (e) {
      console.error(e);
      return send(res, 500, 'app error');
    }
    send(res, 202, 'ok');
  });
}

// Isomorphic protocol modules and the MQTT client bundle, served to the browser.
const SHARED = {
  '/protocol/schema.json': path.join(__dirname, 'protocol', 'schema.json'),
  '/protocol/validate.js': path.join(__dirname, 'protocol', 'validate.js'),
  '/protocol/mqtt-topics.js': path.join(__dirname, 'protocol', 'mqtt-topics.js'),
  '/vendor/mqtt.min.js': path.join(__dirname, 'node_modules', 'mqtt', 'dist', 'mqtt.min.js'),
};

function handleFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'not found');
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

function handleStatic(res, pathname) {
  const file = path.normalize(path.join(PUBLIC, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUBLIC)) return send(res, 403, 'forbidden');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'not found');
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

function send(res, code, text) {
  res.writeHead(code, { 'Content-Type': 'text/plain' });
  res.end(text);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === '/stream') return handleStream(req, res, url);
  if (req.method === 'POST' && url.pathname === '/intent') return handleIntent(req, res, url);
  if (req.method === 'GET' && url.pathname === '/schema.json') return handleFile(res, path.join(__dirname, 'protocol', 'schema.json'));
  if (req.method === 'GET' && SHARED[url.pathname]) return handleFile(res, SHARED[url.pathname]);
  if (req.method === 'GET') return handleStatic(res, url.pathname);
  send(res, 405, 'method not allowed');
});

if (require.main === module) {
  server.listen(PORT, HOST, () => console.log(`XUL-J prototype on http://${HOST}:${PORT}`));
}

module.exports = { server, sessions };
