// End-to-end test: real server, real SSE, headless model.  Run: node test/e2e.js
'use strict';
const assert = require('assert');
const { server } = require('../server');
const { validate } = require('../protocol/validate');
const { Model, renderText } = require('../protocol/model');
const { stream, intent } = require('../clients/sse');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(pred, what, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return; await sleep(20); }
  throw new Error(`timed out waiting for: ${what}`);
}

let passed = 0;
async function step(name, fn) {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
}

(async () => {
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const session = 'test1234';
  const model = new Model();
  const ops = [];
  let conn = stream(base, session, { onOp: (op) => { ops.push(op); model.apply(op); } });

  await step('schema rejects bad ops', async () => {
    assert(validate({ op: 'node', in: 'root', tag: 'blink' }).length > 0);
    assert(validate({ op: 'nope' }).length > 0);
    assert(validate({ op: 'command', id: 'c', key: 'Ctrl+Bad Key' }).length > 0);
    assert(validate({ op: 'set', id: '1bad', attrs: {} }).length > 0);
    assert.deepStrictEqual(validate({ op: 'node', in: 'root', tag: 'hbox', children: [{ tag: 'label', value: 'x' }] }), []);
  });

  await step('initial UI streams in progressively, pending node holds the tree slot', async () => {
    await until(() => model.ids.get('log')?.tag === 'pending', 'pending log');
    await until(() => model.ids.get('log')?.tag === 'tree', 'tree replaces pending');
    assert.strictEqual(model.ids.get('log').parent.id, 'tab_log');
  });

  await step('every op on the wire is valid and seq is gapless', async () => {
    ops.forEach((op, i) => {
      assert.deepStrictEqual(validate(op), [], JSON.stringify(op));
      assert.strictEqual(op.seq, i + 1);
    });
  });

  await step('late overlay inserts Rollback before the spacer', async () => {
    await until(() => model.ids.has('tb_rollback'), 'rollback overlay');
    const kids = model.ids.get('tb').children.map((c) => c.id);
    assert.strictEqual(kids.indexOf('tb_rollback') + 1, kids.indexOf('tb_spacer'));
  });

  await step('disabled command is refused by the server', async () => {
    const r = await intent(base, session, { op: 'do', command: 'cmd_cancel' });
    assert.strictEqual(r.status, 409);
    assert.strictEqual((await intent(base, session, { op: 'do', command: 'cmd_evil' })).status, 404);
    assert.strictEqual((await intent(base, session, { op: 'eval', code: '1' })).status, 400);
  });

  await step('deploy flips commands and broadcasters; widgets follow', async () => {
    assert.strictEqual((await intent(base, session, { op: 'do', command: 'cmd_deploy' })).status, 202);
    await until(() => model.broadcasters.get('busy') === true, 'busy');
    const deployBtn = model.resolved(model.ids.get('tb_deploy'));
    const envList = model.resolved(model.ids.get('env'));
    const rollback = model.resolved(model.ids.get('tb_rollback'));
    assert.strictEqual(deployBtn.disabled, true);
    assert.strictEqual(envList.disabled, true, 'menulist observes busy');
    assert.strictEqual(rollback.disabled, true, 'overlaid button observes busy');
    assert.strictEqual(model.resolved(model.ids.get('tb_cancel')).disabled, false);
    await until(() => String(model.broadcasters.get('status')).startsWith('Deployed'), 'deploy done');
    assert.strictEqual(model.resolved(model.ids.get('tb_deploy')).disabled, false);
    assert.strictEqual(model.broadcasters.get('progress'), 1);
  });

  await step('server-side filter replaces the row set', async () => {
    await intent(base, session, { op: 'input', id: 'filter', value: 'warn' });
    await until(() => (model.sources.get('log') || []).every((r) => r.level === 'warn'), 'filtered rows');
    assert(model.sources.get('log').length >= 1);
    await intent(base, session, { op: 'input', id: 'filter', value: '' });
    await until(() => model.sources.get('log').length > 5, 'unfiltered rows');
  });

  await step('dropped connection resumes from last seq without duplicates', async () => {
    conn.close();
    const lastSeq = model.lastSeq;
    await intent(base, session, { op: 'input', id: 'env', value: 'production' }); // happens while offline
    const resumed = [];
    conn = stream(base, session, { from: lastSeq, onOp: (op) => { resumed.push(op); model.apply(op); } });
    await until(() => model.ids.get('win').attrs.label.endsWith('production'), 'missed op replayed');
    assert(resumed.every((op) => op.seq > lastSeq), 'only newer ops replayed');
    assert.strictEqual(model.resolved(model.ids.get('env')).selectedIndex, 1, 'selection echoed to other clients');
  });

  await step('a fresh client with no state rebuilds the identical UI', async () => {
    const fresh = new Model();
    const c = stream(base, session, { onOp: (op) => fresh.apply(op) });
    await until(() => fresh.lastSeq === model.lastSeq, 'fresh client caught up');
    c.close();
    assert.strictEqual(renderText(fresh), renderText(model));
  });

  await step('100k rows stream in chunks', async () => {
    await intent(base, session, { op: 'input', id: 'verbose', value: true });
    const before = model.sources.get('log').length;
    const t0 = Date.now();
    await intent(base, session, { op: 'do', command: 'cmd_bulk' });
    await until(() => model.sources.get('log').length >= before + 100000, '100k rows', 20000);
    console.log(`      (${Date.now() - t0} ms for 100k rows over SSE)`);
  });

  conn.close();
  console.log(`\n${passed} checks passed. Final text rendering:\n`);
  console.log(renderText(model, { maxRows: 3 }));
  server.close();
  process.exit(0);
})().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
