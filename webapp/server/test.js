'use strict';
// End-to-end check of the relay: `npm test`. Starts server.js on spare ports and plays
// remote, dashboard and device against it. Exits non-zero on the first failed assert.
const assert = require('assert');
const { spawn } = require('child_process');
const { WebSocket } = require('ws');

const PUB = 18080, REM = 18787, TOKEN = 'test-token';
const api = (path, body) => fetch(`http://127.0.0.1:${REM}${path}`, body
  ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined)
  .then(async r => ({ code: r.status, json: await r.json() }));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// WebSocket wrapper that queues messages so none are missed between awaits.
function client(path, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${PUB}${path}`, token ? { headers: { Authorization: 'Bearer ' + token } } : undefined);
  const queue = [], waiters = [];
  ws.on('message', d => { const m = JSON.parse(d); const w = waiters.shift(); if (w) w(m); else queue.push(m); });
  return {
    ws, queue,
    opened: new Promise((res, rej) => { ws.on('open', () => res(true)); ws.on('error', rej); ws.on('unexpected-response', (_, r) => rej(new Error('HTTP ' + r.statusCode))); }),
    closed: new Promise(res => ws.on('close', code => res(code))),
    next: () => queue.length ? Promise.resolve(queue.shift()) : Promise.race([new Promise(res => waiters.push(res)), sleep(2000).then(() => { throw new Error('timed out waiting for a message on ' + path); })]),
    send: m => ws.send(JSON.stringify(m))
  };
}
const det = extra => Object.assign({ type: 'detection', sound_label: 'car_horn', severity: 'caution', direction_deg: 112 }, extra);
const active = m => m.motors.filter(x => x.active).map(x => x.id).join();

async function run() {
  // wrong / missing token is refused
  await assert.rejects(client('/device', 'nope').opened, /401/);
  await assert.rejects(client('/device').opened, /401/);

  const dash = client('/ws');
  await dash.opened;
  assert.equal((await dash.next()).type, 'snapshot');

  // no device: motors are filled in by the server, dashboards keep their fake confirmation (no ack:false)
  let r = await api('/api/send', det());
  assert.equal(r.code, 200); assert.equal(r.json.device, false);
  let m = await dash.next();
  assert.equal(m.motors.length, 5); assert.equal(active(m), 'M4'); assert.equal(m.motors[3].intensity, 0.8);
  assert.equal(m.ack, undefined);
  assert.equal((await api('/api/status')).json.device, false);

  // device connects: gets nothing on connect (no snapshot, no replay of the detection above)
  const dev = client('/device', TOKEN);
  await dev.opened;
  await sleep(300);
  assert.equal(dev.queue.length, 0);
  assert.equal((await api('/api/status')).json.device, true);

  dev.send({ type: 'status', pico_connected: true, extra: 'dropped' });
  assert.deepEqual(await dash.next(), { type: 'status', pico_connected: true });

  // detection reaches the device with five motors + severity; dashboards are told not to fake the ack
  r = await api('/api/send', det({ direction_deg: 0, intensity: 1, severity: 'danger' }));
  assert.equal(r.json.device, true);
  m = await dev.next();
  assert.equal(m.type, 'detection'); assert.equal(m.severity, 'danger'); assert.equal(m.motors.length, 5); assert.equal(active(m), 'M1,M5');
  assert.equal(m.motors[0].intensity, 1);
  m = await dash.next();
  assert.equal(m.ack, false); assert.equal(active(m), 'M1,M5');

  // direction_valid:false -> rear centre ; manual motors are normalised to five
  await api('/api/send', det({ direction_valid: false }));
  assert.equal(active(await dev.next()), 'M3'); await dash.next();
  await api('/api/send', det({ motors: [{ id: 'M2', active: true, intensity: 0.5 }] }));
  m = await dev.next(); assert.equal(m.motors.length, 5); assert.equal(active(m), 'M2'); await dash.next();

  // bad input is rejected before it can reach the device
  assert.equal((await api('/api/send', { type: 'detection', sound_label: 'x' })).code, 400);                 // severity missing
  assert.equal((await api('/api/send', det({ motors: [{ id: 'M9', active: true }] }))).code, 400);
  assert.equal((await api('/api/send', det({ motors: [{ id: 'M1', active: true, intensity: 5 }] }))).code, 400);

  // device -> dashboards: only motor_state / status, anything else dropped
  dev.send({ type: 'detection', sound_label: 'spoof', severity: 'danger' });
  dev.send({ type: 'motor_state', motors: [{ id: 'M7', active: true }] });
  dev.ws.send('not json');
  dev.send({ type: 'motor_state', motors: [{ id: 'M2', active: true, intensity: 0.5 }] });
  assert.deepEqual(await dash.next(), { type: 'motor_state', motors: [{ id: 'M2', active: true, intensity: 0.5 }] });

  // a dashboard that connects now restores the last detection as confirmed and learns the pico status
  const dash2 = client('/ws');
  await dash2.opened;
  m = await dash2.next();
  assert.equal(m.type, 'snapshot'); assert.equal(m.last.ack, undefined); assert.equal(m.history[0].ack, undefined); assert.equal(m.history[1].ack, false);
  assert.deepEqual(await dash2.next(), { type: 'status', pico_connected: true });
  dash2.ws.close();

  // strength: default 0.25 rides on every detection; a dashboard can change it via the public listener
  assert.equal(m.strength, 0.25); assert.equal(m.last.strength, 0.25);
  const setStrength = v => fetch(`http://127.0.0.1:${PUB}/api/strength`, { method: 'POST', body: JSON.stringify({ strength: v }) }).then(x => x.status);
  assert.equal(await setStrength(7), 400);
  assert.equal(await setStrength('0.5'), 400);
  assert.equal(await setStrength(0.5), 200);
  assert.deepEqual(await dash.next(), { type: 'config', strength: 0.5 });
  await api('/api/send', det());
  assert.equal((await dev.next()).strength, 0.5); assert.equal((await dash.next()).strength, 0.5);

  // motor test from the dashboard: one motor to the device, its confirmation is not relayed
  const motorTest = id => fetch(`http://127.0.0.1:${PUB}/api/test`, { method: 'POST', body: JSON.stringify({ id }) }).then(x => x.status);
  assert.equal(await motorTest('M9'), 400);
  assert.equal(await motorTest('M2'), 200);
  m = await dev.next();
  assert.deepEqual([m.type, m.sound_label, m.severity, m.strength, active(m), m.motors.length], ['detection', 'motor_test', 'info', 0.5, 'M2', 5]);
  dev.send({ type: 'motor_state', motors: [{ id: 'M2', active: true }] });
  await sleep(150);

  // control goes to the device too (and is the next thing dashboards see: the test reply was dropped)
  await api('/api/send', { type: 'control', action: 'idle' });
  assert.deepEqual([(m = await dev.next()).type, m.action], ['control', 'idle']);
  assert.equal((await dash.next()).type, 'control');

  // a second device replaces the first
  const dev2 = client('/device', TOKEN);
  await dev2.opened;
  assert.equal(await dev.closed, 4000);
  assert.equal((await api('/api/status')).json.device, true);
  await api('/api/send', det());
  assert.equal((await dev2.next()).type, 'detection'); await dash.next();

  // device goes away: dashboards are told, status flips, behaviour returns to "no device"
  dev2.ws.close();
  assert.deepEqual(await dash.next(), { type: 'status', pico_connected: false });
  assert.equal((await api('/api/status')).json.device, false);
  await api('/api/send', det());
  assert.equal((await dash.next()).ack, undefined);
  assert.equal(await motorTest('M2'), 409);
  dash.ws.close();
}

const env = Object.assign({}, process.env, { PUBLIC_HOST: '127.0.0.1', PUBLIC_PORT: PUB, REMOTE_PORT: REM, REQUIRE_TAILSCALE_HEADER: '0', DEVICE_TOKEN: TOKEN, POS_MAP: '', STRENGTH: '' });
const srv = spawn(process.execPath, [require('path').join(__dirname, 'server.js')], { env, stdio: ['ignore', 'pipe', 'inherit'] });
let out = '', started = false;
srv.stdout.on('data', d => {
  out += d;
  if (started || !/public  :/.test(out) || !/remote  :/.test(out)) return; // both listeners bound
  started = true;
  run().then(() => { console.log('ok'); srv.kill(); process.exit(0); },
    e => { console.error(out); console.error(e); srv.kill(); process.exit(1); });
});
srv.on('exit', code => { if (!started) { console.error(out); console.error('server exited early, code ' + code); process.exit(1); } });
