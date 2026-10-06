#!/usr/bin/env node
// A simulated greenhouse sensor that publishes its own interface over MQTT.
// No web server, no XUL-J library: just retained JSON on topics, as a microcontroller would do.
'use strict';
const fs = require('fs');
const path = require('path');
const mqtt = require('mqtt');

const env = fs.existsSync(path.join(__dirname, '../mqtt/.env'))
  ? Object.fromEntries(fs.readFileSync(path.join(__dirname, '../mqtt/.env'), 'utf8').trim().split('\n').map((l) => l.split('=')))
  : {};
const B = 'xulj/greenhouse/';
const client = mqtt.connect(process.env.XULJ_BROKER || 'mqtt://127.0.0.1:1884', {
  username: 'greenhouse',
  password: process.env.XULJ_GREENHOUSE_PASSWORD || env.XULJ_GREENHOUSE_PASSWORD,
  // If the device drops off, the broker blanks its status for every viewer.
  will: { topic: `${B}bc/status`, payload: JSON.stringify({ value: 'Device offline' }), retain: true, qos: 1 },
});

const retain = (topic, body) => client.publish(B + topic, JSON.stringify(body), { retain: true, qos: 1 });
const state = { temp: 24.0, humidity: 0.55, vent: false, auto: true, n: 0, epoch: Date.now() };

function publishUi() {
  retain('node/gh', { in: 'root', tag: 'window', label: 'Greenhouse 3', order: 10 });
  retain('node/gh_box', { in: 'gh', tag: 'vbox', flex: 1, order: 10 });
  retain('node/gh_temp', { in: 'gh_box', tag: 'label', class: 'mono', observes: { value: 'temp' }, order: 10 });
  retain('node/gh_hum_row', { in: 'gh_box', tag: 'hbox', order: 20 });
  retain('node/gh_hum_l', { in: 'gh_hum_row', tag: 'label', value: 'Humidity', order: 10 });
  retain('node/gh_hum', { in: 'gh_hum_row', tag: 'progressmeter', observes: { value: 'humidity' }, order: 20 });
  retain('node/gh_ctl', { in: 'gh_box', tag: 'hbox', order: 30 });
  retain('node/gh_vent', { in: 'gh_ctl', tag: 'button', command: 'cmd_vent', class: 'primary', order: 10 });
  retain('node/gh_auto', { in: 'gh_ctl', tag: 'checkbox', label: 'Automatic venting', observes: { value: 'auto' }, order: 20 });
  retain('node/gh_log', {
    in: 'gh_box', tag: 'tree', flex: 1, class: 'mono', order: 40,
    cols: [{ id: 't', label: 'Time', width: 90 }, { id: 'temp', label: '°C', width: 60 }, { id: 'event', label: 'Event', flex: 1 }],
    rows: { source: 'readings' },
  });
  retain('node/gh_sb', { in: 'gh', tag: 'statusbar', order: 20 });
  retain('node/gh_status', { in: 'gh_sb', tag: 'label', observes: { value: 'status' }, order: 10 });
  retain('rows/readings/epoch', { epoch: state.epoch });
  publishVent();
  retain('bc/auto', { value: state.auto });
  retain('bc/status', { value: 'Online' });
  // Its own look: themes are scoped per app, so it doesn't restyle the other apps on the page.
  retain('theme', { tokens: { accent: '#2e7d32', accentText: '#ffffff', radius: 10, density: 'comfortable', font: 'rounded' } });
  publishReadings();
}

function publishReadings() {
  retain('bc/temp', { value: `${state.temp.toFixed(1)} °C · vent ${state.vent ? 'open' : 'closed'}` });
  retain('bc/humidity', { value: Number(state.humidity.toFixed(3)) });
}

function publishVent() {
  retain('cmd/cmd_vent', { label: state.vent ? 'Close vent' : 'Open vent', key: 'ctrl+v', disabled: state.auto });
}

function reading(event = '') {
  const row = { t: new Date().toISOString().slice(11, 19), temp: state.temp.toFixed(1), event };
  const n = state.n++;
  client.publish(`${B}rows/readings/live`, JSON.stringify({ epoch: state.epoch, n0: n, rows: [row] }), { qos: 1 });
  retain(`rows/readings/ring/${n % 50}`, { epoch: state.epoch, n, row });
}

function tick() {
  state.temp += (Math.random() - 0.45) * 0.4 - (state.vent ? 0.35 : 0);
  state.humidity = Math.min(1, Math.max(0, state.humidity + (Math.random() - 0.5) * 0.03 - (state.vent ? 0.01 : 0)));
  if (state.auto && !state.vent && state.temp > 27) { state.vent = true; publishVent(); reading('auto: vent opened'); }
  if (state.auto && state.vent && state.temp < 23) { state.vent = false; publishVent(); reading('auto: vent closed'); }
  publishReadings();
  reading();
}

client.on('connect', () => {
  publishUi();
  client.subscribe([`${B}do/+`, `${B}input/+`], { qos: 1 });
  console.log('greenhouse online');
});

client.on('message', (topic, payload, packet) => {
  if (packet.retain) return;
  if (topic === `${B}do/cmd_vent` && !state.auto) {
    state.vent = !state.vent;
    publishVent();
    reading(`manual: vent ${state.vent ? 'opened' : 'closed'}`);
  }
  if (topic === `${B}input/gh_auto`) {
    try { state.auto = Boolean(JSON.parse(payload).value); } catch { return; }
    retain('bc/auto', { value: state.auto });
    publishVent();
    reading(`auto venting ${state.auto ? 'on' : 'off'}`);
  }
});

setInterval(tick, 1000);
