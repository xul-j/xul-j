// Browser renderer tests: public/xulj.js in jsdom against the real SSE server.
// Covers menus, selection, context menus and theming. Run: npm run test:browser
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { JSDOM } = require('jsdom');
const { server } = require('../server');
const { stream, intent } = require('../clients/sse');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(p, what, ms = 8000) { const e = Date.now() + ms; while (Date.now() < e) { if (p()) return; await sleep(20); } throw new Error('timed out: ' + what); }
const RENDERER = fs.readFileSync(path.join(__dirname, '../public/xulj.js'), 'utf8');

async function page(base, session, media) {
  const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, d = w.document;
  w.ResizeObserver = class { observe() {} };
  w.matchMedia = (q) => ({ matches: (q.includes('dark') && media.dark) || (q.includes('contrast') && media.contrast), addEventListener() {} });
  Object.defineProperty(w.HTMLElement.prototype, 'clientHeight', { get() { return this.classList.contains('x-tree-viewport') ? 400 : 0; } });
  w.eval(RENDERER);
  const sent = [];
  const ui = new w.XulJ(d.getElementById('root'), (m) => { sent.push(JSON.parse(JSON.stringify(m))); intent(base, session, m); });
  stream(base, session, { onOp: (op) => ui.apply(op) });
  return { w, d, ui, sent, q: (id) => d.querySelector(`[data-xid="${id}"]`) };
}

(async () => {
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;

  // ---- menus ------------------------------------------------------------------------
  {
    const { w, d, ui, sent, q } = await page(base, 'browser-menus', {});
    const btn = (id) => q(id).querySelector(':scope > .x-menu-button');
    const popup = (id) => q(id).querySelector(':scope > .x-menupopup');
    const key = (target, k, extra = {}) => target.dispatchEvent(new w.KeyboardEvent('keydown', { key: k, bubbles: true, ...extra }));
    // The app builds its UI gradually; wait for all of it, not just the menus.
    await until(() => q('mi_env_production') && q('verbose') && q('tb_rollback'), 'UI rendered');
    // Regression: nothing may be open on load (a context menu once showed up un-hidden).
    assert.deepStrictEqual([...d.querySelectorAll('.x-menupopup')].filter((p) => !p.hidden).length, 0, 'no popup open on load');
    console.log('  ok  no menu or context menu is open on load');
    await until(() => q('mi_env_production') && q('verbose') && q('tb_rollback'), 'UI rendered');

    assert.strictEqual(q('mb').getAttribute('role'), 'menubar');
    assert(popup('m_deploy').hidden && popup('m_log').hidden, 'menus start closed');
    assert.strictEqual(q('mi_deploy').querySelector('.x-menu-label').textContent, 'Deploy');
    assert.strictEqual(q('mi_deploy').querySelector('.x-menu-accel').textContent, 'Ctrl+Enter');
    assert.strictEqual(q('mi_verbose').getAttribute('role'), 'menuitemcheckbox');
    assert.strictEqual(q('mi_verbose').getAttribute('aria-checked'), 'true');
    assert.strictEqual(q('mi_verbose').querySelector('.x-menu-check').textContent, '✓');
    assert.strictEqual(q('ms_deploy').getAttribute('role'), 'separator');
    console.log('  ok  menubar, items, accelerator text, check item and separator rendered');

    btn('m_deploy').click();
    assert(!popup('m_deploy').hidden && btn('m_deploy').getAttribute('aria-expanded') === 'true');
    btn('m_log').dispatchEvent(new w.Event('pointerenter'));
    assert(popup('m_deploy').hidden && !popup('m_log').hidden, 'hovering the bar switches menus');
    assert.strictEqual(sent.length, 0, 'opening menus is local: no intents');
    console.log('  ok  click opens, hovering across the bar switches, no round trips');

    key(d.body, 'Escape');
    assert(popup('m_log').hidden, 'Escape closes');
    key(d.body, 'd', { altKey: true });
    assert(!popup('m_deploy').hidden, 'Alt+D opens Deploy');
    assert.strictEqual(d.activeElement, q('mi_deploy'), 'focus on the first item');
    key(d.activeElement, 'ArrowDown');
    // Cancel is disabled (nothing running), so focus skips to the Environment submenu.
    assert.strictEqual(d.activeElement, btn('m_env'));
    key(d.activeElement, 'ArrowRight');
    assert(!popup('m_env').hidden, 'ArrowRight opens the submenu');
    assert.strictEqual(d.activeElement, q('mi_env_staging'));
    key(d.activeElement, 'ArrowDown');
    assert.strictEqual(d.activeElement, q('mi_env_production'));
    key(d.activeElement, 'ArrowLeft');
    assert(popup('m_env').hidden && d.activeElement === btn('m_env'), 'ArrowLeft closes the submenu');
    console.log('  ok  Alt+D, arrows into and out of a submenu; disabled items are skipped');

    key(d.activeElement, 'ArrowRight');
    q('mi_env_production').click();
    assert(!d.querySelector('.x-menu.x-open'), 'choosing an item closes all menus');
    assert.deepStrictEqual(sent.pop(), { op: 'do', command: 'cmd_env_production' });
    await until(() => q('mi_env_production').getAttribute('aria-checked') === 'true' && q('mi_env_staging').getAttribute('aria-checked') === 'false', 'radio-style check moved');
    console.log('  ok  choosing an item sends one intent; the check moves when the server answers');

    btn('m_log').click();
    d.body.dispatchEvent(new w.Event('pointerdown', { bubbles: true }));
    assert(popup('m_log').hidden, 'clicking outside closes');
    btn('m_log').click();
    q('mi_verbose').click();
    await until(() => q('mi_verbose').getAttribute('aria-checked') === 'false' && q('verbose').querySelector('input').checked === false, 'verbose off');
    console.log('  ok  outside click closes; check item toggles, and the Settings checkbox follows');

    q('tb_deploy').click();
    await until(() => q('mi_env_staging').disabled && btn('m_log') && q('mi_bulk').disabled, 'busy disables items');
    console.log('  ok  items follow command state while busy');
  }

  // ---- selection, context menus, theming ------------------------------------------------------
  {
    const media = { dark: false, contrast: false };
    const { w, d, ui, sent, q } = await page(base, 'browser-select', media);
    const session = 'browser-select';
    const rows = () => [...q('log').querySelectorAll('.x-row')];
    const row = (i) => q('log').querySelector(`.x-row[data-index="${i}"]`);
    const selected = () => rows().filter((r) => r.classList.contains('x-selected')).map((r) => Number(r.dataset.index));
    const last = (op) => [...sent].reverse().find((m) => m.op === op);
    await until(() => q('tb_rollback') && rows().length >= 1, 'UI');
    for (let i = 0; i < 4; i++) await intent(base, session, { op: 'do', command: 'cmd_rollback' }); // more rows
    await until(() => rows().length >= 5, 'rows');

    assert.strictEqual(q('log').tabIndex, 0);
    assert.strictEqual(q('log').getAttribute('aria-multiselectable'), 'true');
    row(1).click();
    assert.deepStrictEqual(selected(), [1], 'shown at once');
    assert.deepStrictEqual(last('select'), { op: 'select', id: 'log', rows: [1] });
    row(3).dispatchEvent(new w.MouseEvent('click', { bubbles: true, shiftKey: true }));
    assert.deepStrictEqual(last('select').rows, [1, 2, 3], 'shift extends from the anchor');
    row(2).dispatchEvent(new w.MouseEvent('click', { bubbles: true, ctrlKey: true }));
    assert.deepStrictEqual(last('select').rows, [1, 3], 'ctrl toggles');
    await until(() => JSON.stringify(selected()) === '[1,3]', 'echo agrees');
    console.log('  ok  click, shift-click, ctrl-click; optimistic and echoed');

    q('log').focus();
    q('log').dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    assert.deepStrictEqual(last('select').rows, [3], 'arrow moves from the cursor');
    q('log').dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    q('log').dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, shiftKey: true }));
    assert.deepStrictEqual(last('select').rows, [0, 1]);
    q('log').dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    assert.deepStrictEqual(last('activate'), { op: 'activate', id: 'log', row: 1 });
    row(0).dispatchEvent(new w.MouseEvent('dblclick', { bubbles: true }));
    assert.deepStrictEqual(last('activate'), { op: 'activate', id: 'log', row: 0 });
    console.log('  ok  keyboard: arrows, Home, shift-extend, Enter and double-click activate');

    await sleep(200);
    const ev = new w.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 90 });
    row(4).dispatchEvent(ev);
    assert(ev.defaultPrevented, 'browser menu suppressed');
    assert.deepStrictEqual(last('select').rows, [4], 'right-click selects the row first');
    const popup = q('log_menu');
    assert(!popup.hidden && popup.classList.contains('x-open'), 'popup open');
    assert.strictEqual(popup.style.left, '120px');
    assert.deepStrictEqual(last('contextmenu'), { op: 'contextmenu', id: 'log_menu', target: 'log' });
    await until(() => !q('cm_only_level').disabled, 'items enabled by the selection, live while open');
    assert.strictEqual(d.activeElement, q('cm_details'));
    popup.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    assert.strictEqual(d.activeElement, q('cm_only_level'));
    popup.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert(popup.hidden && d.activeElement === q('log'), 'Escape closes and returns focus');
    q('log').dispatchEvent(new w.KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true }));
    assert(!popup.hidden, 'Shift+F10 opens it from the keyboard');
    q('cm_details').click();
    assert(popup.hidden);
    assert.deepStrictEqual(last('do'), { op: 'do', command: 'cmd_details' });
    console.log('  ok  context menu: right-click selects then opens at the pointer; keys; Shift+F10; item click');

    const root = d.getElementById('root');
    ui.apply({ op: 'theme', tokens: { accent: '#000080', accentText: '#ffffff', surface: '#ffffff', text: '#000000', radius: 0, density: 'compact', font: 'mono' } });
    assert.strictEqual(root.style.getPropertyValue('--accent'), '#000080');
    assert.strictEqual(root.style.getPropertyValue('--x-radius'), '0px');
    assert(root.classList.contains('x-density-compact') && ui.rowH === 20);
    assert(/monospace/.test(root.style.getPropertyValue('--x-font')));
    ui.apply({ op: 'theme', tokens: { accent: '#ffff00', accentText: '#ffffff', text: '#777777', surface: '#888888' } });
    assert.strictEqual(root.style.getPropertyValue('--accent'), '', 'low-contrast pair dropped');
    assert.strictEqual(root.style.getPropertyValue('--text'), '');
    assert.strictEqual(ui.themeDropped.length, 2, ui.themeDropped.join());
    console.log('  ok  theme tokens → scoped CSS variables, density, font; low-contrast pairs dropped:', ui.themeDropped.join(', '));
    media.dark = true;
    ui.apply({ op: 'theme', tokens: { accent: '#000080', accentText: '#ffffff', radius: 2 } });
    assert.strictEqual(root.style.getPropertyValue('--accent'), '', 'light palette not forced on a dark-mode viewer');
    assert.strictEqual(root.style.getPropertyValue('--x-radius'), '2px', 'non-colour tokens still apply');
    ui.apply({ op: 'theme', tokens: { accent: '#000080', accentText: '#ffffff' }, dark: { accent: '#7aa2ff', accentText: '#0f1420' } });
    assert.strictEqual(root.style.getPropertyValue('--accent'), '#7aa2ff', 'explicit dark palette used');
    media.contrast = true;
    ui.applyTheme();
    assert.strictEqual(root.style.getPropertyValue('--accent'), '', 'high contrast ignores producer colours');
    console.log('  ok  viewer wins: dark mode needs a dark palette; high contrast ignores producer colours');
  }

  console.log('\nBrowser tests passed.');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
