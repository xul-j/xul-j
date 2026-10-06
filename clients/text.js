#!/usr/bin/env node
// Terminal renderer for the same XUL-J stream the browser consumes.
//   node clients/text.js [http://localhost:8080] [session]
// Type intents on stdin:  do cmd_deploy | input filter warn | input verbose false
'use strict';
const readline = require('readline');
const { Model, renderText } = require('../protocol/model');
const { stream, intent } = require('./sse');

const base = process.argv[2] || 'http://localhost:8080';
const session = process.argv[3] || `tty${Math.random().toString(36).slice(2, 8)}`;
const model = new Model();
let dirty = false;

function paint() {
  if (!dirty) return;
  dirty = false;
  process.stdout.write('\x1b[2J\x1b[H');
  console.log(renderText(model, { maxRows: 8 }));
  const cmds = [...model.commands].filter(([, c]) => !c.disabled).map(([id]) => id).join(', ');
  console.log(`\nsession ${session} · seq ${model.lastSeq} · enabled: ${cmds}`);
  process.stdout.write('> ');
}
setInterval(paint, 100);

stream(base, session, { onOp: (op) => { model.apply(op); dirty = true; } });

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  const [verb, id, ...rest] = line.trim().split(/\s+/);
  let msg;
  if (verb === 'do') msg = { op: 'do', command: id };
  else if (verb === 'input') {
    const raw = rest.join(' ');
    msg = { op: 'input', id, value: raw === 'true' ? true : raw === 'false' ? false : raw };
  } else if (verb === 'quit') process.exit(0);
  if (!msg) { dirty = true; return; }
  const r = await intent(base, session, msg);
  if (r.status >= 300) console.log(`! ${r.status} ${r.body}`);
  dirty = true;
});
