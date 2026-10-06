#!/usr/bin/env node
// Runs a XUL-J app over MQTT instead of SSE. The app module is the same one server.js uses.
//   node mqtt-app.js            (credentials from env or mqtt/.env)
'use strict';
const fs = require('fs');
const path = require('path');
const mqtt = require('mqtt');
const { MqttUi } = require('./transport/mqtt-publisher');
const app = require('./app/deploy-console');

function loadEnv() {
  const file = path.join(__dirname, 'mqtt', '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}

async function main() {
  loadEnv();
  const url = process.env.XULJ_BROKER || 'mqtt://127.0.0.1:1884';
  const client = await mqtt.connectAsync(url, {
    username: 'deploy',
    password: process.env.XULJ_DEPLOY_PASSWORD,
    clientId: `xulj-deploy-${process.pid}`,
  });
  const ui = new MqttUi(client, { app: 'deploy' });
  await ui.init();
  const handle = app.start(ui);
  await ui.listen(handle, (m) => console.log('intent', JSON.stringify(m)));
  console.log(`deploy console publishing to ${url} under xulj/deploy/`);
  const stop = () => { ui.closed = true; client.end(false, () => process.exit(0)); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
