// XUL-J over MQTT, client side: turns retained/live topic messages into ops for a
// renderer (public/xulj.js) or the headless Model. Works in Node and the browser.
//
//   <prefix><app>/node/<id>              retained  element spec {in, tag, order, ...attrs}; empty = remove
//   <prefix><app>/cmd/<id>               retained  command state; empty = delete
//   <prefix><app>/bc/<id>                retained  {value}
//   <prefix><app>/rows/<src>/epoch       retained  {epoch}; a newer epoch clears the source
//   <prefix><app>/rows/<src>/ring/<k>    retained  {epoch, n, row}: the last N rows, for late joiners
//   <prefix><app>/rows/<src>/live        live      {epoch, n0, rows}
//   <prefix><app>/do/<cmd>               client →  {}
//   <prefix><app>/input/<id>             client →  {value}
(function (root) {
  'use strict';

  class TopicClient {
    // target: { apply(op), lookup(id) -> {tag} | undefined }
    constructor({ prefix = 'xulj/', app, target, validate, onReject }) {
      this.base = `${prefix}${app}/`;
      this.target = target;
      this.validate = validate || (() => []);
      this.onReject = onReject || (() => {});
      this.sources = new Map();
      this.rebuildTimer = null;
    }

    get subscription() { return `${this.base}#`; }
    doTopic(command) { return `${this.base}do/${command}`; }
    inputTopic(id) { return `${this.base}input/${id}`; }

    // Turn a renderer intent into [topic, payload].
    intent(msg) {
      if (msg.op === 'do') return [this.doTopic(msg.command), '{}'];
      if (msg.op === 'input') return [this.inputTopic(msg.id), JSON.stringify({ value: msg.value })];
      return null;
    }

    message(topic, payload) {
      if (!topic.startsWith(this.base)) return;
      const parts = topic.slice(this.base.length).split('/');
      const text = typeof payload === 'string' ? payload : payload.toString();
      let body = null;
      if (text.length) {
        try { body = JSON.parse(text); } catch { return this.onReject(topic, ['payload is not JSON']); }
      }
      const [kind, id] = parts;
      switch (kind) {
        case 'node': return this.node(topic, id, body);
        case 'cmd': return this.emit(topic, body ? { op: 'command', id, ...body } : { op: 'command', id, deleted: true });
        case 'bc': return this.emit(topic, { op: 'broadcast', id, value: body ? body.value : null });
        case 'rows': return body && this.rows(topic, id, parts[2], body);
        default: return; // do/ and input/ are other viewers' intents
      }
    }

    emit(topic, op) {
      const errs = this.validate(op);
      if (errs.length) return this.onReject(topic, errs, op);
      this.target.apply(op);
    }

    node(topic, id, spec) {
      if (!spec) return this.emit(topic, { op: 'remove', id });
      const errs = this.validate({ op: 'node', id, ...spec });
      if (errs.length) return this.onReject(topic, errs, spec);
      const existing = this.target.lookup(id);
      if (existing && existing.tag === spec.tag && !spec.children) {
        // Same widget, new state: update in place so focus and scroll survive.
        const { in: _in, tag: _tag, ...attrs } = spec;
        return this.target.apply({ op: 'set', id, attrs, replace: true });
      }
      if (existing) {
        const { in: _in, ...rest } = spec;
        return this.target.apply({ op: 'replace', id, ...rest });
      }
      this.target.apply({ op: 'node', id, ...spec });
    }

    rows(topic, source, part, body) {
      let st = this.sources.get(source);
      if (!st) {
        st = { epoch: -Infinity, rows: new Map(), maxN: -1, dirty: false };
        this.sources.set(source, st);
      }
      if (typeof body.epoch !== 'number' || body.epoch < st.epoch) return;
      if (body.epoch > st.epoch) {
        st.epoch = body.epoch;
        st.rows.clear();
        st.maxN = -1;
        this.emit(topic, { op: 'rows', source, clear: true });
      }
      let incoming = [];
      if (part === 'ring' && typeof body.n === 'number') incoming = [[body.n, body.row]];
      else if (part === 'live' && Array.isArray(body.rows)) incoming = body.rows.map((r, i) => [body.n0 + i, r]);
      incoming = incoming.filter(([n, r]) => r && typeof r === 'object' && !st.rows.has(n));
      if (!incoming.length) return;
      for (const [n, r] of incoming) st.rows.set(n, r);
      const inOrder = incoming.every(([n], i) => n > (i ? incoming[i - 1][0] : st.maxN));
      if (inOrder && !st.dirty) {
        st.maxN = incoming[incoming.length - 1][0];
        return this.emit(topic, { op: 'rows', source, append: incoming.map(([, r]) => r) });
      }
      // Out-of-order arrival (retained ring slots): rebuild once things settle.
      st.dirty = true;
      clearTimeout(this.rebuildTimer);
      this.rebuildTimer = setTimeout(() => this.rebuild(), 0);
    }

    rebuild() {
      for (const [source, st] of this.sources) {
        if (!st.dirty) continue;
        st.dirty = false;
        const keys = [...st.rows.keys()].sort((a, b) => a - b);
        st.maxN = keys.length ? keys[keys.length - 1] : -1;
        this.emit(`rows/${source}`, { op: 'rows', source, clear: true, append: keys.map((k) => st.rows.get(k)) });
      }
    }
  }

  if (typeof module === 'object' && module.exports) module.exports = { TopicClient };
  else root.XulJTopicClient = TopicClient;
})(this);
