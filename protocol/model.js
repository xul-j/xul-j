// Headless XUL-J client: applies ops to a plain object tree. Used by the text
// renderer and the tests; the browser renderer implements the same semantics on the DOM.
'use strict';

const STRUCT = new Set(['op', 'seq', 'in', 'before', 'children', 'tag', 'id']);

class Model {
  constructor() { this.reset(); }

  reset() {
    this.root = { tag: 'root', id: 'root', attrs: {}, children: [] };
    this.ids = new Map([['root', this.root]]);
    this.commands = new Map();
    this.broadcasters = new Map();
    this.sources = new Map();
    this.waiting = []; // overlays whose anchor has not arrived yet
    this.lastSeq = 0;
    this.transient = this.transient || []; // download/notify ops (not UI state; survive reset)
  }

  apply(op) {
    if (op.seq) this.lastSeq = op.seq;
    switch (op.op) {
      case 'reset': return this.reset();
      case 'download':
      case 'notify': return this.transient.push(op);
      case 'node':
        if (this.insert(op)) return;
        // A newer version of a still-waiting node supersedes the queued one.
        this.waiting = this.waiting.filter((w) => !op.id || w.id !== op.id);
        return this.waiting.push(op);
      case 'replace': {
        const old = this.ids.get(op.id);
        if (!old) return;
        const fresh = this.build(op);
        fresh.parent = old.parent;
        fresh.external = old.external;
        fresh.attrs.order = fresh.attrs.order ?? old.attrs.order;
        old.parent.children[old.parent.children.indexOf(old)] = fresh;
        // Children that arrived through their own ops survive the swap.
        const kept = old.children.filter((c) => c.external);
        old.children = old.children.filter((c) => !c.external);
        this.unregister(old);
        for (const c of kept) { c.parent = fresh; fresh.children.push(c); }
        this.register(fresh);
        return this.flush();
      }
      case 'set': {
        const n = this.ids.get(op.id);
        if (n) n.attrs = op.replace ? { ...op.attrs } : Object.assign(n.attrs, op.attrs);
        return;
      }
      case 'remove': {
        this.waiting = this.waiting.filter((w) => w.id !== op.id);
        const n = this.ids.get(op.id);
        if (!n || n === this.root) return;
        n.parent.children.splice(n.parent.children.indexOf(n), 1);
        return this.unregister(n);
      }
      case 'command': {
        if (op.deleted) return this.commands.delete(op.id);
        const { op: _o, seq: _s, ...state } = op;
        return this.commands.set(op.id, { ...this.commands.get(op.id), ...state });
      }
      case 'broadcast': return this.broadcasters.set(op.id, op.value);
      case 'rows': {
        const rows = op.clear ? [] : this.sources.get(op.source) || [];
        if (op.append) rows.push(...op.append);
        return this.sources.set(op.source, rows);
      }
    }
  }

  build(spec) {
    const attrs = {};
    for (const [k, v] of Object.entries(spec)) if (!STRUCT.has(k)) attrs[k] = v;
    const n = { tag: spec.tag, id: spec.id, attrs, children: [] };
    for (const c of spec.children || []) {
      const child = this.build(c);
      child.parent = n;
      n.children.push(child);
    }
    return n;
  }

  insert(op) {
    const parent = this.ids.get(op.in);
    if (!parent) return false;
    const n = this.build(op);
    n.parent = parent;
    n.external = true;
    const anchor = op.before && this.ids.get(op.before);
    let at = anchor ? parent.children.indexOf(anchor) : -1;
    if (at < 0 && typeof n.attrs.order === 'number') {
      at = parent.children.findIndex((c) => typeof c.attrs.order === 'number' && c.attrs.order > n.attrs.order);
    }
    if (at >= 0) parent.children.splice(at, 0, n);
    else parent.children.push(n);
    this.register(n);
    this.flush();
    return true;
  }

  flush() {
    const queued = this.waiting;
    this.waiting = [];
    for (const op of queued) if (!this.insert(op)) this.waiting.push(op);
  }

  register(n) {
    if (n.id) this.ids.set(n.id, n);
    n.children.forEach((c) => this.register(c));
  }

  unregister(n) {
    if (n.id && this.ids.get(n.id) === n) this.ids.delete(n.id);
    n.children.forEach((c) => this.unregister(c));
  }

  // Effective attributes: own attrs, then broadcaster-observed attrs, then command state.
  resolved(n) {
    const a = { ...n.attrs };
    for (const [attr, bid] of Object.entries(a.observes || {})) {
      if (this.broadcasters.has(bid)) a[attr] = this.broadcasters.get(bid);
    }
    const cmd = a.command && this.commands.get(a.command);
    if (cmd) {
      if (a.label === undefined) a.label = cmd.label;
      a.disabled = Boolean(a.disabled || cmd.disabled);
    }
    return a;
  }
}

// Text renderer: one line per widget, indented by depth.
function renderText(model, { maxRows = 5 } = {}) {
  const out = [];
  const walk = (n, depth) => {
    const a = model.resolved(n);
    const pad = '  '.repeat(depth);
    const dis = a.disabled ? ' (disabled)' : '';
    switch (n.tag) {
      case 'root': break;
      case 'window': out.push(`${pad}== ${a.modal ? '[modal] ' : ''}${a.label || 'window'} ==`); break;
      case 'filepicker': out.push(`${pad}[choose file${a.accept ? ` ${a.accept}` : ''}…] ${a.value || ''}`); break;
      case 'toolbarbutton':
      case 'button': out.push(`${pad}[ ${a.label || '?'} ]${dis}`); break;
      case 'textbox': out.push(`${pad}[${a.password && a.value ? '•'.repeat(String(a.value).length) : a.value || a.placeholder || ''}_____]`); break;
      case 'checkbox': out.push(`${pad}[${a.value ? 'x' : ' '}] ${a.label}`); break;
      case 'menulist': {
        const opt = (a.options || [])[a.selectedIndex || 0];
        out.push(`${pad}<${opt ? opt.label : ''} v>${dis}`);
        break;
      }
      case 'label':
      case 'description': out.push(`${pad}${a.value ?? a.label ?? ''}`); break;
      case 'progressmeter': {
        const v = Math.max(0, Math.min(1, Number(a.value) || 0));
        out.push(`${pad}[${'#'.repeat(Math.round(v * 20)).padEnd(20, '.')}] ${Math.round(v * 100)}%`);
        break;
      }
      case 'pending': out.push(`${pad}░░░ loading ${a.hint || ''} ░░░`); break;
      case 'tabpanel':
      case 'groupbox': out.push(`${pad}-- ${a.label || n.tag} --`); break;
      case 'tree': {
        const rows = model.sources.get(a.rows.source) || [];
        out.push(`${pad}${a.cols.map((c) => c.label).join(' | ')}   (${rows.length} rows)`);
        for (const r of rows.slice(-maxRows)) out.push(`${pad}  ${a.cols.map((c) => r[c.id]).join(' | ')}`);
        break;
      }
      case 'spacer': return;
      default: if (n.tag !== 'vbox' && n.tag !== 'hbox' && n.tag !== 'box') out.push(`${pad}<${n.tag}>`);
    }
    n.children.forEach((c) => walk(c, n.tag === 'root' ? depth : depth + 1));
  };
  walk(model.root, 0);
  return out.join('\n');
}

module.exports = { Model, renderText };
