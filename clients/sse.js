// Tiny SSE + intent client for Node (no dependencies).
'use strict';
const http = require('http');

function stream(base, session, { from = 0, onOp, onOpen, onEnd } = {}) {
  const url = new URL(`/stream?session=${session}`, base);
  const req = http.get(url, { headers: from ? { 'Last-Event-ID': String(from) } : {} }, (res) => {
    if (onOpen) onOpen(res);
    res.setEncoding('utf8');
    if (onEnd) res.on('end', () => onEnd(null));
    let buf = '';
    res.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = frame.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
        if (data) onOp(JSON.parse(data));
      }
    });
  });
  if (onEnd) req.on('error', (e) => onEnd(e));
  let closed = false;
  return { close: () => { closed = true; req.destroy(); }, get closed() { return closed; } };
}

function intent(base, session, msg) {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(`/intent?session=${session}`, base), { method: 'POST' }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(msg));
  });
}

module.exports = { stream, intent };
