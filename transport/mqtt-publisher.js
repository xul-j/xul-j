// XUL-J over MQTT, publisher side: gives an app the same `ui.emit(op)` interface the
// SSE server provides, and maps each op onto retained topics (see protocol/mqtt-topics.js).
// Every element is flattened into its own topic so it can be updated on its own.
'use strict';
const { validate } = require('../protocol/validate');

const STRUCT = new Set(['op', 'seq', 'in', 'before', 'children', 'tag', 'id']);
const LIVE_CHUNK = 5000;

class MqttUi {
  constructor(client, { prefix = 'xulj/', app, ring = 200 }) {
    this.client = client;
    this.base = `${prefix}${app}/`;
    this.ringSize = ring;
    this.nodes = new Map(); // id -> { in, tag, order, attrs, kids: [] }
    this.commands = new Map();
    this.sources = new Map(); // source -> { epoch, n }
    this.published = new Set(); // retained topics we own
    this.closed = false;
  }

  // Collect retained topics left by a previous run, so `reset` can delete them.
  async init() {
    const found = new Set();
    const onMsg = (topic, payload, packet) => {
      if (packet.retain && payload.length && topic.startsWith(this.base)) found.add(topic);
    };
    this.client.on('message', onMsg);
    await this.client.subscribeAsync(`${this.base}#`, { qos: 1 });
    await new Promise((r) => setTimeout(r, 800));
    await this.client.unsubscribeAsync(`${this.base}#`);
    this.client.removeListener('message', onMsg);
    found.forEach((t) => this.published.add(t));
  }

  // Route viewers' intents to the app, applying the same allowlist as the SSE server.
  async listen(app, onIntent = () => {}) {
    this.client.on('message', (topic, payload, packet) => {
      if (packet.retain || !topic.startsWith(this.base)) return;
      const [kind, id, extra] = topic.slice(this.base.length).split('/');
      if (extra !== undefined || !id) return;
      let msg;
      if (kind === 'do') {
        const cmd = this.commands.get(id);
        if (!cmd || cmd.disabled) return onIntent({ op: 'do', command: id, refused: true });
        msg = { op: 'do', command: id };
      } else if (kind === 'input') {
        try { msg = { op: 'input', id, value: JSON.parse(payload.toString()).value }; } catch { return; }
        if (!this.nodes.has(id)) return;
      } else return;
      onIntent(msg);
      try { app.intent(msg); } catch (e) { console.error('intent failed', e); }
    });
    await this.client.subscribeAsync([`${this.base}do/+`, `${this.base}input/+`], { qos: 1 });
  }

  pub(topic, body, retain = true) {
    const full = this.base + topic;
    if (retain) {
      if (body === null) this.published.delete(full);
      else this.published.add(full);
    }
    this.client.publish(full, body === null ? '' : JSON.stringify(body), { qos: 1, retain });
  }

  emit(op) {
    const errs = validate(op);
    if (errs.length) throw new Error(`invalid op ${JSON.stringify(op)}:\n  ${errs.join('\n  ')}`);
    switch (op.op) {
      case 'reset': return this.reset();
      case 'node': return this.place(op, op.in, this.orderFor(op.in, op.before));
      case 'replace': {
        const old = this.nodes.get(op.id);
        if (!old) return;
        old.kids.slice().forEach((k) => this.drop(k));
        return this.place(op, old.in, old.order);
      }
      case 'set': {
        const n = this.nodes.get(op.id);
        if (!n) return;
        n.attrs = op.replace ? { ...op.attrs } : { ...n.attrs, ...op.attrs };
        return this.publishNode(op.id);
      }
      case 'remove': return this.drop(op.id);
      case 'command': {
        if (op.deleted) {
          this.commands.delete(op.id);
          return this.pub(`cmd/${op.id}`, null);
        }
        const { op: _o, id, ...state } = op;
        const merged = { ...this.commands.get(id), ...state };
        this.commands.set(id, merged);
        return this.pub(`cmd/${id}`, merged);
      }
      case 'broadcast': return this.pub(`bc/${op.id}`, { value: op.value });
      case 'rows': return this.rows(op);
    }
  }

  orderFor(parentId, beforeId) {
    const siblings = [...this.nodes.values()].filter((n) => n.in === parentId).map((n) => n.order).sort((a, b) => a - b);
    const anchor = beforeId && this.nodes.get(beforeId);
    if (anchor && anchor.in === parentId) {
      const prev = siblings.filter((o) => o < anchor.order).pop();
      return prev === undefined ? anchor.order - 10 : (prev + anchor.order) / 2;
    }
    return siblings.length ? siblings[siblings.length - 1] + 10 : 10;
  }

  // Store and publish an element, then each child as its own topic.
  place(spec, parentId, order) {
    const id = spec.id;
    const attrs = {};
    for (const [k, v] of Object.entries(spec)) if (!STRUCT.has(k)) attrs[k] = v;
    delete attrs.order;
    const parent = this.nodes.get(parentId);
    if (parent && !parent.kids.includes(id)) parent.kids.push(id);
    this.nodes.set(id, { in: parentId, tag: spec.tag, order, attrs, kids: [] });
    this.publishNode(id);
    (spec.children || []).forEach((c, i) => {
      this.place({ ...c, id: c.id || `${id}__${i}` }, id, (i + 1) * 10);
    });
  }

  publishNode(id) {
    const n = this.nodes.get(id);
    this.pub(`node/${id}`, { in: n.in, tag: n.tag, order: n.order, ...n.attrs });
  }

  drop(id) {
    const n = this.nodes.get(id);
    if (!n) return;
    n.kids.slice().forEach((k) => this.drop(k));
    const parent = this.nodes.get(n.in);
    if (parent) parent.kids = parent.kids.filter((k) => k !== id);
    this.nodes.delete(id);
    this.pub(`node/${id}`, null);
  }

  rows(op) {
    let st = this.sources.get(op.source);
    if (!st) {
      st = { epoch: Date.now(), n: 0 };
      this.sources.set(op.source, st);
      this.pub(`rows/${op.source}/epoch`, { epoch: st.epoch });
    }
    if (op.clear) {
      for (let k = 0; k < Math.min(st.n, this.ringSize); k++) this.pub(`rows/${op.source}/ring/${k}`, null);
      // Date.now() keeps epochs increasing across publisher restarts.
      st.epoch = Math.max(Date.now(), st.epoch + 1);
      st.n = 0;
      this.pub(`rows/${op.source}/epoch`, { epoch: st.epoch });
    }
    const rows = op.append || [];
    for (let i = 0; i < rows.length; i += LIVE_CHUNK) {
      this.pub(`rows/${op.source}/live`, { epoch: st.epoch, n0: st.n + i, rows: rows.slice(i, i + LIVE_CHUNK) }, false);
    }
    const tail = Math.max(0, rows.length - this.ringSize);
    for (let i = tail; i < rows.length; i++) {
      const n = st.n + i;
      this.pub(`rows/${op.source}/ring/${n % this.ringSize}`, { epoch: st.epoch, n, row: rows[i] });
    }
    st.n += rows.length;
  }

  reset() {
    for (const topic of [...this.published]) {
      this.client.publish(topic, '', { qos: 1, retain: true });
    }
    this.published.clear();
    this.nodes.clear();
    this.commands.clear();
    for (const st of this.sources.values()) st.n = 0;
    this.sources.clear();
  }
}

module.exports = { MqttUi };
