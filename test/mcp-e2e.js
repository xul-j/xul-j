// End-to-end test of the MCP server (mcp/server.js) against the demo deploy console over SSE.
// Run: node test/mcp-e2e.js
'use strict';
const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');
const readline = require('readline');
const { server } = require('../server');

let passed = 0;
async function step(name, fn) { await fn(); passed++; console.log(`  ok  ${name}`); }

function mcpClient(url) {
  const child = spawn(process.execPath, [path.join(__dirname, '../mcp/server.js'), '--url', url], { stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map();
  let next = 1;
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    const msg = JSON.parse(line);
    const p = pending.get(msg.id);
    if (p) { pending.delete(msg.id); p(msg); }
  });
  const rpc = (method, params) => new Promise((resolve) => {
    const id = next++;
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const call = async (name, args = {}) => {
    const r = await rpc('tools/call', { name, arguments: args });
    return { text: r.result.content[0].text, error: Boolean(r.result.isError) };
  };
  return { child, rpc, call, notify: (method) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`) };
}

(async () => {
  await new Promise((r) => server.listen(0, r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const c = mcpClient(url);

  await step('MCP handshake and tool list', async () => {
    const init = await c.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    assert.strictEqual(init.result.protocolVersion, '2025-06-18');
    assert.strictEqual(init.result.serverInfo.name, 'xulj');
    assert.match(init.result.instructions, /get_ui/);
    c.notify('notifications/initialized');
    const tools = (await c.rpc('tools/list', {})).result.tools.map((t) => t.name);
    for (const t of ['connect', 'get_ui', 'list_commands', 'do_command', 'set_value', 'read_table', 'select_rows', 'activate_row', 'open_context_menu', 'upload_file', 'download_file', 'wait_for']) assert(tools.includes(t), t);
    assert.strictEqual((await c.rpc('nope', {})).error.code, -32601);
  });

  await step('get_ui: a labelled outline with ids, commands and tables', async () => {
    const { text } = await c.call('wait_for', { id: 'tb_rollback' });
    assert.match(text, /window "Deploy console" \[win\]/);
    assert.match(text, /button "Deploy" \[tb_deploy\] → cmd_deploy \(ctrl\+enter\)/);
    assert.match(text, /menulist \[env\] = "staging"/);
    assert.match(text, /table \[log\] \d+ rows; columns: Time, Level, Message; multiple selection; right-click menu \[log_menu\]/);
    assert.match(text, /item "Show debug lines" \[mi_verbose\] → cmd_verbose ✓/);
  });

  await step('list_commands shows enabled and disabled commands', async () => {
    const { text } = await c.call('list_commands');
    assert.match(text, /^cmd_deploy: "Deploy" \[ctrl\+enter\]$/m);
    assert.match(text, /\(disabled\) cmd_cancel: "Cancel"/);
  });

  await step('set_value picks a menulist option by its label; actions report what changed', async () => {
    const { text } = await c.call('set_value', { id: 'env', value: 'Production' });
    assert.match(text, /~ menulist \[env\] = "production"/);
    assert.match(text, /~ window "Deploy console — production"/);
    assert((await c.call('set_value', { id: 'env', value: 'mars' })).error);
  });

  await step('do_command runs a command; disabled ones are refused with a reason', async () => {
    const refused = await c.call('do_command', { command: 'cmd_cancel' });
    assert(refused.error && /disabled/.test(refused.text));
    // The deploy streams a step every 250 ms, so the action settles only when it is done:
    // one call returns the outcome (or says it is still changing).
    const { text } = await c.call('do_command', { command: 'cmd_deploy' });
    assert.match(text, /~ label "Deployed to production" \[sb_status\]   \(was: label "Idle"\)|still changing/);
    const done = await c.call('wait_for', { text: 'Deployed to production' });
    assert.match(done.text, /label "Deployed to production"/);
  });

  await step('read_table, select_rows, open_context_menu, activate_row', async () => {
    const t = JSON.parse((await c.call('read_table', { id: 'log', limit: 3 })).text);
    assert(t.total > 5 && t.rows[0].Message && t.rows[0].row === 0);
    let r = await c.call('select_rows', { id: 'log', rows: [1] });
    assert.match(r.text, /selected rows 1/);
    r = await c.call('open_context_menu', { id: 'log' });
    assert.match(r.text, /item "Show details" \[cm_details\] → cmd_details$/m, 'enabled now that a row is selected');
    r = await c.call('do_command', { command: 'cmd_details' });
    assert.match(r.text, /^! info: .+/m, 'notification reported');
    r = await c.call('activate_row', { id: 'log', row: 0 });
    assert.match(r.text, /^! info: /m);
    assert((await c.call('open_context_menu', { id: 'env' })).error, 'no context menu there');
  });

  await step('unknown ids and tools fail clearly', async () => {
    const r = await c.call('set_value', { id: 'nope', value: 1 });
    assert(r.error && /get_ui/.test(r.text));
    const u = await c.rpc('tools/call', { name: 'fly', arguments: {} });
    assert.strictEqual(u.error.code, -32602);
  });

  console.log(`\n${passed} checks passed.`);
  c.child.kill();
  server.close();
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
