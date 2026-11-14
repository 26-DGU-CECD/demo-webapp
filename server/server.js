'use strict';
/*
 * miimo relay server
 *
 *  PUBLIC listener  (PUBLIC_HOST:PUBLIC_PORT, default 0.0.0.0:80)
 *    - serves web/ static files (monitor dashboard). remote.* are never served here.
 *    - GET /ws : send-only WebSocket. Anything a public client sends is dropped.
 *    - POST /api/strength : { strength: 0..1 } global vibration strength, set from the dashboard.
 *    - POST /api/test : { id: "M1".."M5" } buzz one motor on the device (dashboard motor test).
 *    - GET /device : two-way WebSocket for the one hardware bridge (bridge.py -> Pico).
 *      Requires `Authorization: Bearer <DEVICE_TOKEN>`. Disabled when DEVICE_TOKEN is empty.
 *      Receives detection/control only (no snapshot); may send motor_state / status.
 *  REMOTE listener  (REMOTE_HOST:REMOTE_PORT, default 127.0.0.1:8787)
 *    - exposed to the tailnet only via `tailscale serve`.
 *    - serves remote.html + assets
 *    - POST /api/send   : detection / control message -> broadcast to dashboards
 *    - GET  /api/status : { monitors, last }
 *    - every request must carry Tailscale-User-Login (set by tailscale serve) unless
 *      REQUIRE_TAILSCALE_HEADER=0 (local development only).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');

const env = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);
const CFG = {
  publicHost: env('PUBLIC_HOST', '0.0.0.0'),
  publicPort: +env('PUBLIC_PORT', 80),
  remoteHost: env('REMOTE_HOST', '127.0.0.1'),
  remotePort: +env('REMOTE_PORT', 8787),
  webDir: path.resolve(env('WEB_DIR', path.join(__dirname, '..', 'web'))),
  historyLimit: +env('HISTORY_LIMIT', 50),
  // Starting vibration strength (0..1). Dashboards can change it at runtime; resets to this on restart.
  strength: +env('STRENGTH', 0.25),
  requireTailscale: env('REQUIRE_TAILSCALE_HEADER', '1') !== '0',
  deviceToken: env('DEVICE_TOKEN', ''),
  // Which motor sits at each neckband position: left tip, rear left, rear centre, rear right, right tip.
  posMap: env('POS_MAP', 'M1,M2,M3,M4,M5').split(',').map(x => x.trim()),
  maxBody: 16 * 1024
};

const log = (...a) => console.log(new Date().toISOString(), ...a);

const IDS = ['M1', 'M2', 'M3', 'M4', 'M5'];
if (CFG.posMap.slice().sort().join() !== IDS.join()) { console.error('POS_MAP must list M1..M5 exactly once each, got: ' + CFG.posMap.join(',')); process.exit(1); }

// ── state (memory only) ─────────────────────────────────────
if (!(CFG.strength >= 0 && CFG.strength <= 1)) { console.error('STRENGTH must be a number from 0 to 1'); process.exit(1); }
const state = { last: null, history: [], ignoredPublicMessages: 0, strength: CFG.strength };
const dashboards = new Set();
let device = null;        // the single hardware bridge socket
let deviceStatus = null;  // last status it reported, replayed to newly connected dashboards
// ponytail: one flag, not per-command ids — the device's motor_state carries no command id, so a
// reply to a motor test is told apart only by "a test was the last thing sent". Add ids if that ever misfires.
let testing = false;
const deviceOpen = () => !!device && device.readyState === WebSocket.OPEN;

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of dashboards) if (ws.readyState === WebSocket.OPEN) ws.send(data);
}
function snapshot() {
  return { type: 'snapshot', now: Date.now(), last: state.last, history: state.history, strength: state.strength };
}

// ── static files ────────────────────────────────────────────
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json', '.webp': 'image/webp', '.jpg': 'image/jpeg' };
const REMOTE_ONLY = new Set(['remote.html', 'remote.js']);

function serveStatic(req, res, indexFile, allowRemoteFiles) {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') p = '/' + indexFile;
  const rel = path.normalize(p).replace(/^(\.\.[/\\])+/, '');
  const file = path.join(CFG.webDir, rel);
  if (!file.startsWith(CFG.webDir + path.sep)) return end(res, 403, 'forbidden');
  if (!allowRemoteFiles && REMOTE_ONLY.has(path.basename(file))) return end(res, 404, 'not found');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return end(res, 404, 'not found');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  });
}
function end(res, code, text, headers) {
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, headers || {}));
  res.end(typeof text === 'string' ? JSON.stringify({ error: text }) : JSON.stringify(text));
}

// ── PUBLIC: dashboard + send-only websocket ─────────────────
const pub = http.createServer((req, res) => {
  // The one thing a dashboard may change: global vibration strength (Device page slider).
  // Unauthenticated like the rest of the public listener, so it only accepts a bounded number.
  const route = req.method + ' ' + new URL(req.url, 'http://x').pathname;
  // Device page "motor test": buzz one motor on the real device. Sent as an ordinary detection
  // (one motor, info = single pulse) so the device needs no extra message type. Dashboards are not told.
  if (route === 'POST /api/test') {
    return readJson(req, (err, body) => {
      if (err || !body || !IDS.includes(body.id)) return end(res, 400, 'bad id');
      if (!deviceOpen()) return end(res, 409, 'no device');
      testing = true;
      device.send(JSON.stringify({ type: 'detection', sound_label: 'motor_test', severity: 'info', strength: state.strength,
        motors: IDS.map(id => ({ id, active: id === body.id, intensity: id === body.id ? 1 : 0 })) }));
      log('motor test', req.socket.remoteAddress, body.id);
      end(res, 200, { ok: true });
    });
  }
  if (route === 'POST /api/strength') {
    return readJson(req, (err, body) => {
      if (err || !body || !isUnit(body.strength)) return end(res, 400, 'bad strength');
      state.strength = body.strength;
      log('strength', req.socket.remoteAddress, state.strength);
      broadcast({ type: 'config', strength: state.strength });
      end(res, 200, { ok: true, strength: state.strength });
    });
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return end(res, 405, 'method not allowed');
  serveStatic(req, res, 'monitor.html', false);
});
const wss = new WebSocketServer({ noServer: true, maxPayload: CFG.maxBody });
pub.on('upgrade', (req, socket, head) => {
  const p = new URL(req.url, 'http://x').pathname;
  if (p === '/device' && CFG.deviceToken) return upgradeDevice(req, socket, head);
  if (p !== '/ws') { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, ws => {
    dashboards.add(ws);
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    // Public clients are listeners only. Never parse, never broadcast.
    ws.on('message', () => { state.ignoredPublicMessages++; });
    ws.on('close', () => dashboards.delete(ws));
    ws.on('error', () => dashboards.delete(ws));
    ws.send(JSON.stringify(snapshot()));
    if (deviceOpen() && deviceStatus) ws.send(JSON.stringify(deviceStatus));
    log('dashboard connected', req.socket.remoteAddress, 'total', dashboards.size);
  });
});
setInterval(() => {
  for (const ws of device ? [...dashboards, device] : dashboards) {
    if (!ws.isAlive) { ws.terminate(); dashboards.delete(ws); continue; }
    ws.isAlive = false; ws.ping();
  }
}, 30000).unref();

// ── DEVICE: the hardware bridge (token auth, one at a time) ─
function tokenOk(req) {
  const got = Buffer.from(String(req.headers.authorization || ''));
  const want = Buffer.from('Bearer ' + CFG.deviceToken);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
// Only these two message types are relayed, reduced to known fields.
function cleanDevice(m) {
  if (!m || typeof m !== 'object') return null;
  if (m.type === 'status') return typeof m.pico_connected === 'boolean' ? { type: 'status', pico_connected: m.pico_connected } : null;
  if (m.type !== 'motor_state' || !Array.isArray(m.motors) || m.motors.length > IDS.length) return null;
  const motors = [];
  for (const x of m.motors) {
    if (!x || !IDS.includes(x.id) || typeof x.active !== 'boolean' || (x.intensity != null && !isUnit(x.intensity))) return null;
    motors.push({ id: x.id, active: x.active, intensity: x.intensity || 0 });
  }
  return { type: 'motor_state', motors };
}
function upgradeDevice(req, socket, head) {
  if (!tokenOk(req)) {
    log('device rejected (bad token)', req.socket.remoteAddress);
    socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    return;
  }
  wss.handleUpgrade(req, socket, head, ws => {
    if (device) { log('device replaced by a new connection'); device.close(4000, 'replaced'); }
    device = ws; deviceStatus = null;
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (data, isBinary) => {
      if (isBinary || device !== ws) return;
      let m; try { m = JSON.parse(data); } catch (e) { return; }
      const out = cleanDevice(m);
      if (!out) return;
      if (out.type === 'motor_state' && testing) return; // confirmation of a motor test, not of a detection on screen
      if (out.type === 'status') deviceStatus = out;
      // Real confirmation arrived: stored copies no longer need ack:false, so a dashboard
      // that reloads restores this detection as confirmed.
      else if (state.last && out.motors.some(x => x.active)) {
        delete state.last.ack;
        if (state.history[0] && state.history[0]._id === state.last._id) delete state.history[0].ack;
      }
      broadcast(out);
    });
    const gone = () => {
      if (device !== ws) return; // already replaced
      device = null; deviceStatus = null;
      broadcast({ type: 'status', pico_connected: false });
      log('device disconnected');
    };
    ws.on('close', gone);
    ws.on('error', gone);
    log('device connected', req.socket.remoteAddress);
  });
}

// ── direction -> motors ─────────────────────────────────────
// Same table as SECT in web/monitor.js (which keeps a copy for simulation mode). Change both together.
// [from deg, to deg, positions] ; positions index into CFG.posMap.
const SECT = [[340, 20, [0, 4]], [20, 100, [4]], [100, 155, [3]], [155, 205, [2]], [205, 260, [1]], [260, 340, [0]]];
function motorsFor(deg, intensity, valid) {
  const d = ((Math.round(deg) % 360) + 360) % 360;
  const pos = valid === false ? [2] : SECT.find(([from, to]) => (from > to ? d >= from || d < to : d >= from && d < to))[2];
  const on = pos.map(i => CFG.posMap[i]);
  return IDS.map(id => ({ id, active: on.includes(id), intensity: on.includes(id) ? intensity : 0 }));
}

// ── REMOTE: tailnet-only control plane ──────────────────────
function identity(req) {
  const login = req.headers['tailscale-user-login'];
  const name = req.headers['tailscale-user-name'];
  if (login) return { login: String(login), name: name ? String(name) : '' };
  if (!CFG.requireTailscale) return { login: 'dev@localhost', name: 'dev' };
  return null;
}
function readJson(req, cb) {
  let body = '', over = false;
  req.on('data', c => { body += c; if (body.length > CFG.maxBody) { over = true; req.destroy(); } });
  req.on('end', () => { if (over) return cb(new Error('too large')); try { cb(null, JSON.parse(body)); } catch (e) { cb(e); } });
  req.on('error', cb);
}
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const isUnit = v => isNum(v) && v >= 0 && v <= 1;
function validate(m) {
  if (!m || typeof m !== 'object') return 'bad json';
  if (m.type === 'control') return ['idle', 'reset'].includes(m.action) ? null : 'bad action';
  if (m.type !== 'detection') return 'bad type';
  if (typeof m.sound_label !== 'string' || m.sound_label.length > 64) return 'bad sound_label';
  if (m.sound_name != null && (typeof m.sound_name !== 'string' || m.sound_name.length > 64)) return 'bad sound_name';
  if (m.confidence != null && !(isNum(m.confidence) && m.confidence >= 0 && m.confidence <= 1)) return 'bad confidence';
  if (!['danger', 'caution', 'info'].includes(m.severity)) return 'bad severity'; // required: the device picks its pattern from it
  if (m.direction_deg != null && !isNum(m.direction_deg)) return 'bad direction_deg';
  if (m.intensity != null && !(isNum(m.intensity) && m.intensity >= 0 && m.intensity <= 1)) return 'bad intensity';
  if (m.motors != null) {
    if (!Array.isArray(m.motors) || m.motors.length > IDS.length) return 'bad motors';
    for (const x of m.motors) if (!x || !IDS.includes(x.id) || (x.intensity != null && !isUnit(x.intensity))) return 'bad motors';
  }
  return null;
}
// Keep only known fields so nothing unexpected reaches the dashboards or the device.
// motors always comes out as all five, M1..M5: given ones normalised, otherwise derived from the direction.
function clean(m) {
  if (m.type === 'control') return { type: 'control', action: m.action };
  const out = { type: 'detection', sound_label: m.sound_label };
  for (const k of ['sound_name', 'confidence', 'severity', 'direction_deg', 'direction_valid', 'intensity', 'ack']) if (m[k] !== undefined) out[k] = m[k];
  out.motors = m.motors
    ? IDS.map(id => { const x = m.motors.find(y => y.id === id), on = !!(x && x.active); return { id, active: on, intensity: on ? x.intensity || 0 : 0 }; })
    : motorsFor(m.direction_deg || 0, isUnit(m.intensity) ? m.intensity : 0.8, m.direction_valid !== false);
  return out;
}

const rem = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const who = identity(req);
  if (!who) { log('remote request without tailscale identity', req.socket.remoteAddress, url.pathname); return end(res, 403, 'tailscale identity required'); }

  if (url.pathname === '/api/status' && req.method === 'GET') {
    return end(res, 200, { monitors: dashboards.size, device: deviceOpen(), last: state.last, you: who.login });
  }
  if (url.pathname === '/api/send' && req.method === 'POST') {
    return readJson(req, (err, body) => {
      if (err) return end(res, 400, 'bad json');
      const why = validate(body);
      if (why) { log('rejected', who.login, why); return end(res, 400, why); }
      const msg = clean(body);
      msg._id = typeof body._id === 'string' && body._id.length <= 40 ? body._id : crypto.randomUUID();
      msg._from = 'remote';
      msg._by = who.login;
      msg.timestamp = new Date().toISOString(); // server clock, not the phone's
      const toDevice = deviceOpen();
      testing = false;
      if (msg.type === 'detection') {
        // A real device will confirm with motor_state, so tell dashboards not to fake it.
        if (toDevice) msg.ack = false;
        msg.strength = state.strength; // global strength for this vibration; the device uses it as its drive level
        state.last = Object.assign({ _at: Date.now() }, msg);
        state.history.unshift(msg);
        if (state.history.length > CFG.historyLimit) state.history.length = CFG.historyLimit;
        log('detection', who.login, msg.sound_label, msg.direction_deg + '°', 'sev=' + (msg.severity || 'auto'), '->', dashboards.size, 'dashboards');
      } else {
        if (msg.action === 'reset') { state.last = null; state.history = []; }
        else if (state.last) state.last = null;
        log('control', who.login, msg.action, '->', dashboards.size, 'dashboards');
      }
      broadcast(msg);
      if (toDevice) device.send(JSON.stringify(msg));
      end(res, 200, { ok: true, monitors: dashboards.size, device: toDevice, id: msg._id });
    });
  }
  if (url.pathname.startsWith('/api/')) return end(res, 404, 'not found');
  if (req.method !== 'GET' && req.method !== 'HEAD') return end(res, 405, 'method not allowed');
  serveStatic(req, res, 'remote.html', true);
});

pub.listen(CFG.publicPort, CFG.publicHost, () => log(`public  : http://${CFG.publicHost}:${CFG.publicPort}  (dashboard + /ws, send-only)`));
rem.listen(CFG.remotePort, CFG.remoteHost, () => log(`remote  : http://${CFG.remoteHost}:${CFG.remotePort}  (expose with: tailscale serve)  tailscale header ${CFG.requireTailscale ? 'required' : 'NOT required (dev)'}`));
log('web dir :', CFG.webDir);
log('device  :', CFG.deviceToken ? '/device enabled on the public listener (token required)' : '/device disabled (DEVICE_TOKEN is empty)');

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { log('shutting down'); pub.close(); rem.close(); for (const ws of dashboards) ws.close(); if (device) device.close(); process.exit(0); });
