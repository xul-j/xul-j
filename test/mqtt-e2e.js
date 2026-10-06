// End-to-end test of XUL-J over MQTT against the real broker (mqtt/ + docker).
// Run: node test/mqtt-e2e.js   (restarts the xulj/deploy app; uses mqtt/.env credentials)
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const mqtt = require('mqtt');
const { validate } = require('../protocol/validate');
const { Model, renderText } = require('../protocol/model');
const { TopicClient } = require('../protocol/mqtt-topics');
const { MqttUi } = require('../transport/mqtt-publisher');
const app = require('../app/deploy-console');

const TCP = process.env.XULJ_BROKER || 'mqtt://127.0.0.1:1884';
const WS = process.env.XULJ_BROKER_WS || 'ws://127.0.0.1:9101';
const env = Object.fromEntries(fs.readFileSync(path.join(__dirname, '../mqtt/.env'), 'utf8').trim().split('\n').map((l) => l.split('=')));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(pred, what, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return; await sleep(20); }
  throw new Error(`timed out waiting for: ${what}`);
}
let passed = 0;
async function step(name, fn) { await fn(); passed++; console.log(`  ok  ${name}`); }

// A viewer = anonymous WebSocket client + headless model.
async function viewer(appName = 'deploy') {
  const model = new Model();
  const rejects = [];
  const topics = new TopicClient({
    app: appName,
    target: { apply: (op) => model.apply(op), lookup: (id) => model.ids.get(id) },
    validate,
    onReject: (t, errs) => rejects.push({ t, errs }),
  });
  const client = await mqtt.connectAsync(WS, { clientId: `xulj-test-${Math.random().toString(16).slice(2, 8)}` });
  client.on('message', (t, p) => topics.message(t, p));
  await client.subscribeAsync(topics.subscription, { qos: 1 });
  const send = (msg) => { const [t, body] = topics.intent(msg); return client.publishAsync(t, body, { qos: 1 }); };
  return { model, client, rejects, send, rows: () => model.sources.get('log') || [] };
}

async function publisher() {
  const client = await mqtt.connectAsync(TCP, { username: 'deploy', password: env.XULJ_DEPLOY_PASSWORD, clientId: `xulj-test-pub-${process.pid}` });
  const ui = new MqttUi(client, { app: 'deploy' });
  await ui.init();
  const refused = [];
  const handle = app.start(ui);
  await ui.listen(handle, (m) => { if (m.refused) refused.push(m); });
  return { client, ui, refused };
}

(async () => {
  let pub = await publisher();
  const a = await viewer();

  await step('UI arrives as retained topics; pending tree replaced in place', async () => {
    await until(() => a.model.ids.get('log')?.tag === 'tree', 'tree');
    assert.strictEqual(a.model.ids.get('log').parent.id, 'tab_log');
  });

  await step('overlay lands before the spacer via `order`', async () => {
    await until(() => a.model.ids.has('tb_rollback'), 'rollback overlay');
    const kids = a.model.ids.get('tb').children.map((c) => c.id);
    assert.strictEqual(kids.indexOf('tb_rollback') + 1, kids.indexOf('tb_spacer'), kids.join(' '));
  });

  await step('a late joiner rebuilds the identical UI from retained state alone', async () => {
    const b = await viewer();
    await until(() => renderText(b.model) === renderText(a.model), 'late joiner converges', 5000);
    b.client.end();
  });

  await step('intents: deploy runs, a disabled command is refused by the publisher', async () => {
    const b = await viewer();
    await until(() => b.model.commands.has('cmd_deploy'), 'commands');
    await b.send({ op: 'do', command: 'cmd_cancel' });
    await until(() => pub.refused.some((m) => m.command === 'cmd_cancel'), 'refusal');
    await b.send({ op: 'do', command: 'cmd_deploy' });
    await until(() => a.model.broadcasters.get('busy') === true, 'busy');
    assert.strictEqual(a.model.resolved(a.model.ids.get('tb_rollback')).disabled, true);
    await until(() => String(a.model.broadcasters.get('status')).startsWith('Deployed'), 'deployed', 10000);
    b.client.end();
  });

  await step('broker ACL drops UI forged by an anonymous viewer', async () => {
    await a.client.publishAsync('xulj/deploy/node/tb_deploy', JSON.stringify({ in: 'tb', tag: 'label', value: 'pwned' }), { qos: 1 });
    await a.client.publishAsync('xulj/deploy/cmd/cmd_deploy', JSON.stringify({ label: 'pwned' }), { qos: 1, retain: true });
    await sleep(400);
    assert.strictEqual(a.model.ids.get('tb_deploy').tag, 'toolbarbutton');
    assert.strictEqual(a.model.commands.get('cmd_deploy').label, 'Deploy');
  });

  await step('client-side schema rejects an invalid element from an authorised publisher', async () => {
    await pub.client.publishAsync('xulj/deploy/node/bad', JSON.stringify({ in: 'tb', tag: 'script', src: 'x.js' }), { qos: 1 });
    await until(() => a.rejects.some((r) => r.t.endsWith('/node/bad')), 'rejection');
    assert(!a.model.ids.has('bad'));
  });

  await step('100k rows: live viewer gets all, late joiner gets the retained ring only', async () => {
    const before = a.rows().length;
    const t0 = Date.now();
    await a.send({ op: 'do', command: 'cmd_bulk' });
    await until(() => a.rows().length >= before + 100000, '100k rows', 30000);
    console.log(`      (${Date.now() - t0} ms for 100k rows through the broker)`);
    await until(() => a.model.broadcasters.get('busy') === false, 'bulk done', 10000);
    const c = await viewer();
    await until(() => c.rows().length === 200, 'ring of 200', 5000);
    assert.deepStrictEqual(c.rows().slice(-3), a.rows().slice(-3));
    c.client.end();
  });

  await step('publisher restart: stale topics are cleared and viewers converge', async () => {
    pub.client.end(true);
    pub = await publisher();
    await until(() => a.model.ids.has('tb_rollback') && a.rows().length === 1, 'restarted UI', 8000);
    const d = await viewer();
    await until(() => renderText(d.model) === renderText(a.model), 'fresh viewer matches', 5000);
    d.client.end();
  });

  await step('a device publishes its own UI; last will marks it offline', async () => {
    const dev = spawn(process.execPath, [path.join(__dirname, '../devices/greenhouse.js')], { stdio: 'ignore' });
    const g = await viewer('greenhouse');
    await until(() => g.model.ids.has('gh_vent') && g.model.broadcasters.get('status') === 'Online', 'greenhouse UI');
    assert.strictEqual(g.model.resolved(g.model.ids.get('gh_vent')).disabled, true, 'vent disabled in auto mode');
    await g.send({ op: 'input', id: 'gh_auto', value: false });
    await until(() => g.model.resolved(g.model.ids.get('gh_vent')).disabled === false, 'manual mode');
    const label = g.model.resolved(g.model.ids.get('gh_vent')).label;
    await g.send({ op: 'do', command: 'cmd_vent' });
    await until(() => g.model.resolved(g.model.ids.get('gh_vent')).label !== label, 'vent toggled');
    await until(() => (g.model.sources.get('readings') || []).some((r) => r.event.startsWith('manual')), 'event row');
    console.log(renderText(g.model, { maxRows: 3 }).split('\n').map((l) => `      ${l}`).join('\n'));
    dev.kill('SIGKILL');
    await until(() => g.model.broadcasters.get('status') === 'Device offline', 'last will', 8000);
    g.client.end();
  });

  console.log(`\n${passed} checks passed.`);
  a.client.end();
  pub.client.end();
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
