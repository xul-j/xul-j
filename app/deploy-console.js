// Demo app: a deploy console. Everything the user sees is emitted as XUL-J ops;
// everything the user does arrives as an intent ({op:"do"} or {op:"input"}).
'use strict';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString().slice(11, 23);

const ENVS = ['staging', 'production'];

const STEPS = [
  ['info', 'Resolving revision a1f9c3e'],
  ['debug', 'git fetch --depth=1 origin a1f9c3e'],
  ['info', 'Installing dependencies'],
  ['debug', 'npm ci --omit=dev (412 packages)'],
  ['info', 'Running tests'],
  ['debug', '128 passed, 0 failed'],
  ['warn', 'Bundle size grew 4.2% vs previous release'],
  ['info', 'Building container image'],
  ['debug', 'sha256:5e0c…91ab pushed'],
  ['info', 'Rolling out 3/3 replicas'],
  ['debug', 'replica-1 healthy'],
  ['debug', 'replica-2 healthy'],
  ['debug', 'replica-3 healthy'],
  ['info', 'Switching traffic'],
];

function start(ui) {
  const st = { all: [], filter: '', verbose: true, env: 'staging', run: null };

  const visible = (r) =>
    (st.verbose || r.level !== 'debug') &&
    (!st.filter || `${r.level} ${r.msg}`.toLowerCase().includes(st.filter.toLowerCase()));

  function log(level, msg) {
    const row = { t: now(), level, msg };
    st.all.push(row);
    if (visible(row)) ui.emit({ op: 'rows', source: 'log', append: [row] });
  }

  function refilter() {
    ui.emit({ op: 'rows', source: 'log', clear: true, append: st.all.filter(visible) });
  }

  function setBusy(busy) {
    ui.emit({ op: 'broadcast', id: 'busy', value: busy });
    ui.emit({ op: 'command', id: 'cmd_deploy', disabled: busy });
    ui.emit({ op: 'command', id: 'cmd_cancel', disabled: !busy });
    ui.emit({ op: 'command', id: 'cmd_bulk', disabled: busy });
  }

  const status = (value) => ui.emit({ op: 'broadcast', id: 'status', value });
  const progress = (value) => ui.emit({ op: 'broadcast', id: 'progress', value });

  async function deploy() {
    const run = { cancelled: false };
    st.run = run;
    setBusy(true);
    log('info', `Deploying to ${st.env}`);
    for (let i = 0; i < STEPS.length; i++) {
      await sleep(250);
      if (run.cancelled || ui.closed) break;
      log(...STEPS[i]);
      progress((i + 1) / STEPS.length);
      status(`Deploying to ${st.env}… ${i + 1}/${STEPS.length}`);
    }
    if (run.cancelled) {
      log('error', 'Deploy cancelled by user');
      status('Cancelled');
    } else {
      log('info', `Deployed to ${st.env}`);
      status(`Deployed to ${st.env}`);
    }
    st.run = null;
    setBusy(false);
  }

  async function bulk() {
    setBusy(true);
    const total = 100000;
    const chunk = 10000;
    for (let i = 0; i < total; i += chunk) {
      const rows = [];
      for (let j = i; j < i + chunk; j++) {
        rows.push({ t: now(), level: j % 97 === 0 ? 'warn' : 'debug', msg: `synthetic event #${j + 1}` });
      }
      st.all.push(...rows);
      ui.emit({ op: 'rows', source: 'log', append: rows.filter(visible) });
      progress((i + chunk) / total);
      status(`Streaming rows ${i + chunk}/${total}`);
      await sleep(30);
    }
    status(`${st.all.length} rows in log`);
    setBusy(false);
  }

  // The initial UI is emitted gradually so you can watch it build up.
  (async () => {
    ui.emit({ op: 'reset' });
    ui.emit({ op: 'command', id: 'cmd_deploy', label: 'Deploy', key: 'ctrl+enter' });
    ui.emit({ op: 'command', id: 'cmd_cancel', label: 'Cancel', key: 'escape', disabled: true });
    ui.emit({ op: 'command', id: 'cmd_bulk', label: 'Stream 100k rows' });
    ui.emit({ op: 'command', id: 'cmd_clear', label: 'Clear log', key: 'ctrl+l' });
    ui.emit({ op: 'broadcast', id: 'busy', value: false });
    ui.emit({ op: 'broadcast', id: 'status', value: 'Idle' });
    ui.emit({ op: 'broadcast', id: 'progress', value: 0 });

    ui.emit({ op: 'node', in: 'root', tag: 'window', id: 'win', label: 'Deploy console' });
    await sleep(120);
    ui.emit({
      op: 'node', in: 'win', tag: 'toolbar', id: 'tb',
      children: [
        { tag: 'toolbarbutton', id: 'tb_deploy', command: 'cmd_deploy', class: 'primary' },
        { tag: 'toolbarbutton', id: 'tb_cancel', command: 'cmd_cancel' },
        { tag: 'spacer', id: 'tb_spacer', flex: 1 },
        {
          tag: 'menulist', id: 'env', observes: { disabled: 'busy' },
          options: ENVS.map((e) => ({ value: e, label: e })),
        },
        { tag: 'textbox', id: 'filter', placeholder: 'Filter log…' },
      ],
    });
    await sleep(120);
    ui.emit({
      op: 'node', in: 'win', tag: 'tabbox', id: 'tabs', flex: 1,
      children: [
        {
          tag: 'tabpanel', id: 'tab_log', label: 'Log', flex: 1,
          children: [{ tag: 'pending', id: 'log', hint: 'tree', flex: 1 }],
        },
        {
          tag: 'tabpanel', id: 'tab_settings', label: 'Settings',
          children: [
            {
              tag: 'groupbox', label: 'Log output',
              children: [
                { tag: 'checkbox', id: 'verbose', label: 'Show debug lines', value: true },
                { tag: 'description', value: 'Filtering happens on the server; the tree only receives matching rows.', class: 'muted' },
              ],
            },
            {
              tag: 'groupbox', label: 'Maintenance',
              children: [
                { tag: 'hbox', children: [{ tag: 'button', command: 'cmd_clear' }, { tag: 'button', command: 'cmd_bulk' }] },
              ],
            },
          ],
        },
      ],
    });
    await sleep(120);
    ui.emit({
      op: 'node', in: 'win', tag: 'statusbar', id: 'sb',
      children: [
        { tag: 'label', id: 'sb_status', observes: { value: 'status' } },
        { tag: 'spacer', flex: 1 },
        { tag: 'progressmeter', id: 'sb_progress', observes: { value: 'progress' } },
      ],
    });

    // The log tree arrives "late": the placeholder has been holding its space.
    await sleep(700);
    ui.emit({
      op: 'replace', id: 'log', tag: 'tree', flex: 1, class: 'mono',
      cols: [{ id: 't', label: 'Time', width: 110 }, { id: 'level', label: 'Level', width: 70 }, { id: 'msg', label: 'Message', flex: 1 }],
      rows: { source: 'log' },
    });
    log('info', 'Console ready. Press Deploy (Ctrl+Enter).');

    // A "plugin" overlays a button into the toolbar after the fact, anchored by id.
    await sleep(1200);
    ui.emit({ op: 'command', id: 'cmd_rollback', label: 'Rollback' });
    ui.emit({ op: 'node', in: 'tb', before: 'tb_spacer', tag: 'toolbarbutton', id: 'tb_rollback', command: 'cmd_rollback', class: 'danger', observes: { disabled: 'busy' } });
  })().catch((e) => console.error('app start failed', e));

  return {
    intent(m) {
      if (m.op === 'do') {
        switch (m.command) {
          case 'cmd_deploy': deploy(); break;
          case 'cmd_cancel': if (st.run) st.run.cancelled = true; break;
          case 'cmd_bulk': bulk(); break;
          case 'cmd_clear': st.all = []; refilter(); status('Log cleared'); break;
          case 'cmd_rollback': log('warn', `Rollback of ${st.env} requested (demo: no-op)`); break;
        }
      } else if (m.op === 'input') {
        if (m.id === 'filter') { st.filter = String(m.value); refilter(); }
        if (m.id === 'verbose') { st.verbose = Boolean(m.value); refilter(); }
        if (m.id === 'env') {
          const i = ENVS.indexOf(m.value);
          if (i < 0) return;
          st.env = ENVS[i];
          // Echo the selection so every other client viewing this session follows.
          ui.emit({ op: 'set', id: 'env', attrs: { selectedIndex: i } });
          ui.emit({ op: 'set', id: 'win', attrs: { label: `Deploy console — ${st.env}` } });
        }
        if (m.id === 'filter') ui.emit({ op: 'set', id: 'filter', attrs: { value: st.filter } });
        if (m.id === 'verbose') ui.emit({ op: 'set', id: 'verbose', attrs: { value: st.verbose } });
      }
    },
  };
}

module.exports = { start };
