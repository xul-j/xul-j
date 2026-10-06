#!/usr/bin/env node
// XUL-J MCP server: lets AI agents operate any XUL-J interface (a Node app, or a WinForms/Swing
// app behind net-bridge/java-bridge) through its semantic tree: labelled elements, explicit
// commands, enabled/disabled state, tables and dialogs. No screenshots, no pixel guessing.
//
//   node mcp/server.js --url http://127.0.0.1:8092        (or XULJ_URL=…)
//   claude mcp add xulj -- node /path/to/xul-j/mcp/server.js --url http://127.0.0.1:8092
//
// Speaks MCP over stdio (newline-delimited JSON-RPC). No dependencies; Node 16+.
'use strict';
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { Model } = require('../protocol/model');
const { stream, intent } = require('../clients/sse');

const VERSION = '0.1.0';
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const argv = process.argv.slice(2);
const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const log = (...a) => process.stderr.write(`[xulj-mcp] ${a.join(' ')}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- connection to a XUL-J endpoint -------------------------------------------------------

const conn = {
  base: null, session: null, model: null, sse: null, lastOpAt: 0, downloads: [], notices: [], noticeMark: 0,

  async connect(base) {
    if (this.sse) this.sse.close();
    this.base = new URL(base).toString();
    this.session = `mcp${crypto.randomBytes(6).toString('hex')}`;
    this.model = new Model();
    this.downloads = [];
    this.notices = [];
    this.noticeMark = 0;
    this.open(0);
    await this.until(() => this.model.root.children.length > 0, 10000, 'the interface');
    await this.settle();
  },

  open(from) {
    this.sse = stream(this.base, this.session, {
      from,
      onOp: (op) => {
        this.lastOpAt = Date.now();
        if (op.op === 'download') this.downloads.push({ name: op.name, url: op.url, at: new Date().toISOString() });
        if (op.op === 'notify') this.notices.push(op);
        this.model.apply(op);
      },
      onEnd: () => {
        if (this.sse && this.sse.closed) return;
        setTimeout(() => { if (this.model) this.open(this.model.lastSeq); }, 1000); // resume where we left off
      },
    });
  },

  require() { if (!this.model) throw new ToolError('Not connected. Call connect with the XUL-J URL first (or start the server with --url).'); },

  async until(pred, ms, what) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (pred()) return true; await sleep(25); }
    throw new ToolError(`Timed out waiting for ${what}.`);
  },

  // Waits until the stream has been quiet for a moment (or gives up after `max`).
  async settle(max = 5000) {
    const start = Date.now();
    await sleep(120);
    while (Date.now() - start < max) {
      if (Date.now() - this.lastOpAt >= 250) return true;
      await sleep(50);
    }
    return false;
  },

  async send(msg) {
    this.require();
    const r = await intent(this.base, this.session, msg);
    if (r.status >= 300) throw new ToolError(`${msg.op} refused: HTTP ${r.status} ${r.body}`);
  },
};

class ToolError extends Error {}

// ---- describing the interface ---------------------------------------------------------------

const visible = (m, n) => !m.resolved(n).hidden;
const q = (s) => JSON.stringify(String(s ?? ''));

function describe(m, n) {
  const a = m.resolved(n);
  const id = n.id ? ` [${n.id}]` : '';
  const off = a.disabled ? ' (disabled)' : '';
  const cmd = a.command ? ` → ${a.command}${keyOf(m, a.command)}` : '';
  switch (n.tag) {
    case 'window': return `window ${q(a.label)}${id}${a.modal ? ' MODAL DIALOG' : ''}${a.icon ? ` (${a.icon})` : ''}`;
    case 'label': case 'description': return a.value ? `${n.tag} ${q(a.value)}${id}${a.class && a.class !== 'muted' && a.class !== 'mono' ? ` (${a.class})` : ''}` : null;
    case 'button': case 'toolbarbutton': return `button ${q(a.label)}${id}${cmd}${off}`;
    case 'textbox': return `textbox${id} = ${a.password ? '(password)' : q(a.value)}${a.placeholder ? ` placeholder ${q(a.placeholder)}` : ''}${a.multiline ? ' (multiline)' : ''}${off}`;
    case 'checkbox': return `checkbox ${q(a.label)}${id} = ${a.value ? 'checked' : 'unchecked'}${off}`;
    case 'menulist': {
      const opts = (a.options || []).map((o, i) => `${i === a.selectedIndex ? '*' : ''}${o.label}`).join(' | ');
      return `menulist${id} = ${q((a.options || [])[a.selectedIndex || 0]?.label)} options: ${opts}${off}`;
    }
    case 'progressmeter': return `progress${id} ${Math.round((Number(a.value) || 0) * 100)}%`;
    case 'tree': {
      const rows = m.sources.get(a.rows.source) || [];
      const sel = a.selection || [];
      return `table${id} ${rows.length} rows; columns: ${(a.cols || []).map((c) => c.label).join(', ')}`
        + `${a.seltype && a.seltype !== 'none' ? `; ${a.seltype} selection${sel.length ? `, selected rows ${sel.join(',')}` : ''}` : ''}`
        + `${a.contextmenu ? `; right-click menu [${a.contextmenu}]` : ''}${off}`;
    }
    case 'filepicker': return `file picker${id}${a.accept ? ` accepts ${a.accept}` : ''}${a.value ? ` = ${q(a.value)}` : ' (empty: use upload_file)'}`;
    case 'groupbox': return `group ${q(a.label)}${id}`;
    case 'tabbox': return `tabs${id}`;
    case 'tabpanel': return `tab ${q(a.label)}${id}`;
    case 'menubar': return `menubar${id}`;
    case 'menu': return `menu ${q(a.label)}${id}${a.accesskey ? ` (${a.accesskey})` : ''}${off}`;
    case 'menuitem': return `item ${q(a.label)}${id}${cmd}${typeof a.checked === 'boolean' ? (a.checked ? ' ✓' : ' ☐') : ''}${off}`;
    case 'menupopup': return `right-click menu${id} (open with open_context_menu before choosing)`;
    case 'toolbar': case 'statusbar': return n.tag + id;
    case 'pending': return `(loading ${a.hint || ''})`;
    default: return null; // boxes, spacers, separators: structure only
  }
}

function keyOf(m, command) {
  const c = m.commands.get(command);
  return c && c.key ? ` (${c.key})` : '';
}

function outline(m, maxRows = 5) {
  const out = [];
  const walk = (n, depth) => {
    if (n.tag !== 'root' && !visible(m, n)) return;
    const line = n.tag === 'root' ? null : describe(m, n);
    if (line) out.push(`${'  '.repeat(depth)}${line}`);
    if (n.tag === 'tree' && maxRows > 0) {
      const a = m.resolved(n);
      const rows = m.sources.get(a.rows.source) || [];
      const sel = new Set(a.selection || []);
      rows.slice(0, maxRows).forEach((r, i) => out.push(`${'  '.repeat(depth + 1)}${sel.has(i) ? '>' : ' '} ${i}: ${(a.cols || []).map((c) => r[c.id]).join(' | ')}`));
      if (rows.length > maxRows) out.push(`${'  '.repeat(depth + 1)}… ${rows.length - maxRows} more (read_table)`);
    }
    n.children.forEach((c) => walk(c, line ? depth + 1 : depth));
  };
  walk(m.root, 0);
  const modal = m.root.children.filter((w) => visible(m, w) && m.resolved(w).modal);
  if (modal.length) out.unshift(`NOTE: a modal dialog ${q(m.resolved(modal[modal.length - 1]).label)} is open; answer it before using other windows.`);
  return out.join('\n');
}

// A flat snapshot (one line per element) to report what an action changed.
function snapshot(m) {
  const map = new Map();
  const walk = (n) => {
    if (n.tag !== 'root') {
      if (!visible(m, n)) return;
      const line = describe(m, n);
      if (line && n.id) map.set(n.id, line);
    }
    n.children.forEach(walk);
  };
  walk(m.root);
  return map;
}

function changes(before, after, noticesBefore, downloadsBefore) {
  const out = [];
  for (const [id, line] of after) if (!before.has(id)) out.push(`+ ${line}`);
  for (const [id, line] of before) if (!after.has(id)) out.push(`- ${line}`);
  // Enabling/disabling alone (e.g. a modal dialog closing) is summarised instead of listed.
  const enabled = [], disabled = [];
  const plain = (l) => l.replace(/ \(disabled\)/g, '');
  for (const [id, line] of after) {
    if (!before.has(id) || before.get(id) === line) continue;
    if (plain(before.get(id)) === plain(line)) { (line.includes(' (disabled)') ? disabled : enabled).push(id); continue; }
    out.push(`~ ${line}   (was: ${before.get(id).replace(` [${id}]`, '')})`);
  }
  const list = (ids) => (ids.length > 10 ? `${ids.slice(0, 10).join(', ')} and ${ids.length - 10} more` : ids.join(', '));
  if (enabled.length) out.push(`~ enabled again: ${list(enabled)}`);
  if (disabled.length) out.push(`~ now disabled: ${list(disabled)}`);
  const notes = conn.notices.slice(noticesBefore).map((n) => `! ${n.level || 'info'}: ${n.message}`);
  const dls = conn.downloads.slice(downloadsBefore).map((d) => `↓ download ready: ${q(d.name)} (download_file)`);
  const lines = [...notes, ...dls, ...out];
  return lines.length ? lines.join('\n') : 'No visible change.';
}

// Runs an action and reports what changed once the interface settles.
async function act(fn) {
  conn.require();
  const before = snapshot(conn.model), nb = conn.notices.length, db = conn.downloads.length;
  await fn();
  const quiet = await conn.settle();
  const report = changes(before, snapshot(conn.model), nb, db);
  const modal = conn.model.root.children.filter((w) => visible(conn.model, w) && conn.model.resolved(w).modal).pop();
  return `${report}${quiet ? '' : '\n(the interface is still changing; call get_ui or wait_for)'}${modal ? `\nA modal dialog is open: ${q(conn.model.resolved(modal).label)}.` : ''}`;
}

function node(id, tags) {
  const n = conn.model.ids.get(id);
  if (!n) throw new ToolError(`No element with id ${q(id)}. Call get_ui to see the ids.`);
  if (tags && !tags.includes(n.tag)) throw new ToolError(`[${id}] is a ${n.tag}, not a ${tags.join(' or ')}.`);
  return n;
}

// ---- HTTP helpers for files -------------------------------------------------------------------

function request(method, url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.request(url, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks), headers: res.headers }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

// ---- tools ----------------------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'connect',
    description: 'Connect to a XUL-J interface (a XUL-J server or a net-bridge/java-bridge URL, e.g. http://127.0.0.1:8092). With a per-session bridge this starts your own instance of the app. Returns the interface outline.',
    inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    run: async ({ url }) => { await conn.connect(url); return outline(conn.model); },
  },
  {
    name: 'get_ui',
    description: 'The current interface as an indented outline: windows, menus, buttons with their command ids, fields with values, tables with their first rows, and dialogs. Element ids are in [brackets]; commands look like cmd_x.',
    inputSchema: { type: 'object', properties: { max_rows: { type: 'integer', minimum: 0, maximum: 200, description: 'table rows to include (default 5)' } } },
    run: async ({ max_rows: maxRows = 5 }) => { conn.require(); return outline(conn.model, maxRows); },
  },
  {
    name: 'list_commands',
    description: 'All commands (buttons, menu items, shortcuts) with their labels, keys, and whether they are enabled right now.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      conn.require();
      const m = conn.model, used = new Map();
      for (const n of m.ids.values()) {
        const a = m.resolved(n);
        if (a.command && !used.has(a.command)) used.set(a.command, a.label || '');
      }
      const lines = [...m.commands].map(([id, c]) => `${c.disabled ? '  (disabled) ' : ''}${id}: ${q(c.label || used.get(id) || '')}${c.key ? ` [${c.key}]` : ''}`);
      return lines.sort((a, b) => a.startsWith('  (disabled)') - b.startsWith('  (disabled)')).join('\n') || 'No commands.';
    },
  },
  {
    name: 'do_command',
    description: 'Run a command, exactly as clicking its button or menu item would (e.g. cmd_addButton). Fails if the command is disabled. Returns what changed.',
    inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    run: async ({ command }) => {
      conn.require();
      const c = conn.model.commands.get(command);
      if (!c) throw new ToolError(`Unknown command ${q(command)}. Call list_commands.`);
      if (c.disabled) throw new ToolError(`${command} is disabled right now.`);
      return act(() => conn.send({ op: 'do', command }));
    },
  },
  {
    name: 'set_value',
    description: 'Type into a text box, tick a checkbox (true/false) or pick a menulist option (by its label or value). Like a user, this does not submit anything: run the relevant command afterwards.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, value: { type: ['string', 'number', 'boolean'] } }, required: ['id', 'value'] },
    run: async ({ id, value }) => {
      const n = node(id, ['textbox', 'checkbox', 'menulist']);
      let v = value;
      if (n.tag === 'checkbox') v = value === true || value === 'true';
      if (n.tag === 'menulist') {
        const opts = conn.model.resolved(n).options || [];
        const hit = opts.find((o) => o.value === String(value)) || opts.find((o) => o.label.toLowerCase() === String(value).toLowerCase());
        if (!hit) throw new ToolError(`No option ${q(value)} in [${id}]. Options: ${opts.map((o) => o.label).join(', ')}`);
        v = hit.value;
      }
      if (n.tag === 'textbox') v = String(value);
      return act(() => conn.send({ op: 'input', id, value: v }));
    },
  },
  {
    name: 'read_table',
    description: 'Rows of a table (tree element) as JSON objects keyed by column label, with their row index.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 1000 } }, required: ['id'] },
    run: async ({ id, offset = 0, limit = 50 }) => {
      const n = node(id, ['tree']);
      const a = conn.model.resolved(n);
      const rows = conn.model.sources.get(a.rows.source) || [];
      const sel = new Set(a.selection || []);
      const page = rows.slice(offset, offset + limit).map((r, k) => {
        const o = { row: offset + k };
        for (const c of a.cols || []) o[c.label || c.id] = r[c.id];
        if (sel.has(offset + k)) o.selected = true;
        return o;
      });
      return JSON.stringify({ total: rows.length, offset, rows: page }, null, 1);
    },
  },
  {
    name: 'select_rows',
    description: 'Select table rows by index (an empty list clears the selection). The app sees a normal selection change.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, rows: { type: 'array', items: { type: 'integer', minimum: 0 } } }, required: ['id', 'rows'] },
    run: async ({ id, rows }) => {
      const n = node(id, ['tree']);
      const type = conn.model.resolved(n).seltype;
      if (!type || type === 'none') throw new ToolError(`[${id}] does not allow selection.`);
      if (type === 'single' && rows.length > 1) throw new ToolError(`[${id}] allows only one selected row.`);
      return act(() => conn.send({ op: 'select', id, rows }));
    },
  },
  {
    name: 'activate_row',
    description: 'Open a table row, as double-clicking or pressing Enter on it would.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, row: { type: 'integer', minimum: 0 } }, required: ['id', 'row'] },
    run: async ({ id, row }) => { node(id, ['tree']); return act(() => conn.send({ op: 'activate', id, row })); },
  },
  {
    name: 'open_context_menu',
    description: 'Open the right-click menu of an element (select table rows first). The app updates which items are enabled; returns the items with their commands. Then use do_command.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'the element that has a right-click menu' } }, required: ['id'] },
    run: async ({ id }) => {
      const n = node(id);
      const popupId = conn.model.resolved(n).contextmenu;
      if (!popupId) throw new ToolError(`[${id}] has no right-click menu.`);
      await act(() => conn.send({ op: 'contextmenu', id: popupId, target: id }));
      const popup = conn.model.ids.get(popupId);
      const lines = [];
      const walk = (p, depth) => p.children.forEach((c) => {
        if (!visible(conn.model, c)) return;
        if (c.tag === 'menuseparator') return lines.push(`${'  '.repeat(depth)}—`);
        const line = describe(conn.model, c);
        if (line) lines.push(`${'  '.repeat(depth)}${line}`);
        if (c.tag === 'menu') walk(c, depth + 1);
      });
      if (popup) walk(popup, 0);
      return lines.join('\n') || 'The menu is empty.';
    },
  },
  {
    name: 'upload_file',
    description: 'Give a file to a file picker in an open dialog: either a local path on this machine, or text content plus a file name. Then run the dialog\'s Open command.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, path: { type: 'string' }, content: { type: 'string' }, name: { type: 'string' } }, required: ['id'] },
    run: async ({ id, path: file, content, name }) => {
      node(id, ['filepicker']);
      let body, fname;
      if (file) { body = fs.readFileSync(file); fname = name || path.basename(file); }
      else if (typeof content === 'string') { body = Buffer.from(content, 'utf8'); fname = name || 'upload.txt'; }
      else throw new ToolError('Give either path or content (with name).');
      return act(async () => {
        const r = await request('POST', new URL(`/upload?session=${conn.session}&id=${encodeURIComponent(id)}`, conn.base).toString(), body, { 'X-Filename': encodeURIComponent(fname) });
        if (r.status >= 300) throw new ToolError(`upload refused: HTTP ${r.status} ${r.body}`);
      });
    },
  },
  {
    name: 'download_file',
    description: 'Fetch a file the app produced (after a save dialog); waits up to 10 s for it to be ready. Text files are returned inline; others are saved to save_to (or a temp folder) and the path is returned.',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'file name; defaults to the latest download' }, save_to: { type: 'string' } } },
    run: async ({ name, save_to: saveTo }) => {
      conn.require();
      const pick = () => (name ? [...conn.downloads].reverse().find((x) => x.name === name) : conn.downloads[conn.downloads.length - 1]);
      // The host announces a file once it has stopped changing, which can take a moment after Save.
      if (!pick()) await conn.until(pick, 10000, name ? `a download named ${q(name)}` : 'a download').catch(() => {});
      const d = pick();
      if (!d) throw new ToolError(conn.downloads.length ? `No download named ${q(name)}. Available: ${conn.downloads.map((x) => x.name).join(', ')}` : 'No downloads yet.');
      const r = await request('GET', new URL(d.url, conn.base).toString());
      if (r.status !== 200) throw new ToolError(`download failed: HTTP ${r.status}`);
      const text = r.body.toString('utf8');
      const isText = !saveTo && r.body.length < 200000 && !text.includes('\u0000') && !text.includes('�');
      if (isText) return `${d.name} (${r.body.length} bytes):\n${text}`;
      const target = saveTo || path.join(require('os').tmpdir(), `xulj-${Date.now()}-${d.name}`);
      fs.writeFileSync(target, r.body);
      return `Saved ${d.name} (${r.body.length} bytes) to ${target}`;
    },
  },
  {
    name: 'wait_for',
    description: 'Wait until the interface shows some text (anywhere in the outline) or an element id exists, e.g. after a long-running command. Returns the outline.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' }, id: { type: 'string' }, timeout_ms: { type: 'integer', minimum: 100, maximum: 120000 } } },
    run: async ({ text, id, timeout_ms: ms = 15000 }) => {
      conn.require();
      if (!text && !id) throw new ToolError('Give text or id.');
      await conn.until(() => (id ? conn.model.ids.has(id) : true) && (text ? outline(conn.model, 50).includes(text) : true), ms, text ? q(text) : `[${id}]`);
      await conn.settle(1000);
      return outline(conn.model);
    },
  },
];

const INSTRUCTIONS = `This server operates an application's user interface through XUL-J, a semantic tree of the UI.
Start with get_ui (or connect, if no URL was configured). Elements have ids in [brackets]; buttons and
menu items run commands (cmd_…) with do_command. To fill a form: set_value for each field, then
do_command for the button. Tables: read_table, select_rows, activate_row (double-click), and
open_context_menu for right-click menus. Dialogs appear as MODAL DIALOG windows: answer them with
their buttons' commands before anything else. File dialogs: upload_file into the file picker, or
download_file after saving. Every action returns what changed (+ added, - removed, ~ changed).
Disabled commands cannot run; that is the app's real state, not an error in this server.`;

// ---- MCP over stdio ----------------------------------------------------------------------------------

function reply(id, result) { process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`); }
function fail(id, code, message) { process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`); }

async function handle(msg) {
  const { id, method, params = {} } = msg;
  const isRequest = id !== undefined && id !== null;
  try {
    switch (method) {
      case 'initialize': {
        const asked = params.protocolVersion;
        return reply(id, {
          protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'xulj', title: 'XUL-J', version: VERSION },
          instructions: INSTRUCTIONS,
        });
      }
      case 'ping': return reply(id, {});
      case 'tools/list':
        return reply(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
      case 'tools/call': {
        const tool = TOOLS.find((t) => t.name === params.name);
        if (!tool) return fail(id, -32602, `Unknown tool: ${params.name}`);
        try {
          const text = await tool.run(params.arguments || {});
          return reply(id, { content: [{ type: 'text', text }] });
        } catch (e) {
          if (!(e instanceof ToolError)) log(e.stack || e);
          return reply(id, { content: [{ type: 'text', text: e.message }], isError: true });
        }
      }
      default:
        if (isRequest) return fail(id, -32601, `Method not found: ${method}`);
        return undefined; // notifications such as notifications/initialized
    }
  } catch (e) {
    log(e.stack || e);
    if (isRequest) fail(id, -32603, String(e.message || e));
  }
}

if (require.main === module) {
  const url = arg('--url') || process.env.XULJ_URL;
  const ready = url ? conn.connect(url).then(() => log(`connected to ${url} as ${conn.session}`), (e) => log(`could not connect to ${url}: ${e.message}`)) : Promise.resolve();
  let chain = ready;
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return fail(null, -32700, 'Parse error'); }
    // Tool calls run in order, after the initial connection; the handshake answers at once.
    if (msg.method === 'tools/call') chain = chain.then(() => handle(msg));
    else handle(msg);
  }).on('close', () => chain.then(() => process.exit(0)));
}

module.exports = { TOOLS, outline, conn };
