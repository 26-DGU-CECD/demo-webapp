'use strict';
/*
 * miimo relay server
 *
 *  PUBLIC listener  (PUBLIC_HOST:PUBLIC_PORT, default 0.0.0.0:80)
 *    - serves web/ static files (monitor dashboard). remote.* are never served here.
 *    - GET /ws : send-only WebSocket. Anything a public client sends is dropped.
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
  requireTailscale: env('REQUIRE_TAILSCALE_HEADER', '1') !== '0',
  maxBody: 16 * 1024
};

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ── state (memory only) ─────────────────────────────────────
const state = { last: null, history: [], ignoredPublicMessages: 0 };
const dashboards = new Set();

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of dashboards) if (ws.readyState === WebSocket.OPEN) ws.send(data);
}
function snapshot() {
  return { type: 'snapshot', now: Date.now(), last: state.last, history: state.history };
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
  if (req.method !== 'GET' && req.method !== 'HEAD') return end(res, 405, 'method not allowed');
  serveStatic(req, res, 'monitor.html', false);
});
const wss = new WebSocketServer({ noServer: true });
pub.on('upgrade', (req, socket, head) => {
  if (new URL(req.url, 'http://x').pathname !== '/ws') { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, ws => {
    dashboards.add(ws);
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    // Public clients are listeners only. Never parse, never broadcast.
    ws.on('message', () => { state.ignoredPublicMessages++; });
    ws.on('close', () => dashboards.delete(ws));
    ws.on('error', () => dashboards.delete(ws));
    ws.send(JSON.stringify(snapshot()));
    log('dashboard connected', req.socket.remoteAddress, 'total', dashboards.size);
  });
});
setInterval(() => {
  for (const ws of dashboards) {
    if (!ws.isAlive) { ws.terminate(); dashboards.delete(ws); continue; }
    ws.isAlive = false; ws.ping();
  }
}, 30000).unref();

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
function validate(m) {
  if (!m || typeof m !== 'object') return 'bad json';
  if (m.type === 'control') return ['idle', 'reset'].includes(m.action) ? null : 'bad action';
  if (m.type !== 'detection') return 'bad type';
  if (typeof m.sound_label !== 'string' || m.sound_label.length > 64) return 'bad sound_label';
  if (m.sound_name != null && (typeof m.sound_name !== 'string' || m.sound_name.length > 64)) return 'bad sound_name';
  if (m.confidence != null && !(isNum(m.confidence) && m.confidence >= 0 && m.confidence <= 1)) return 'bad confidence';
  if (m.severity != null && !['danger', 'caution', 'info'].includes(m.severity)) return 'bad severity';
  if (m.direction_deg != null && !isNum(m.direction_deg)) return 'bad direction_deg';
  if (m.intensity != null && !(isNum(m.intensity) && m.intensity >= 0 && m.intensity <= 1)) return 'bad intensity';
  if (m.motors != null) {
    if (!Array.isArray(m.motors) || m.motors.length > 8) return 'bad motors';
    for (const x of m.motors) if (!x || typeof x.id !== 'string' || (x.intensity != null && !isNum(x.intensity))) return 'bad motors';
  }
  return null;
}
// Keep only known fields so nothing unexpected reaches the dashboards.
function clean(m) {
  if (m.type === 'control') return { type: 'control', action: m.action };
  const out = { type: 'detection', sound_label: m.sound_label };
  for (const k of ['sound_name', 'confidence', 'severity', 'direction_deg', 'direction_valid', 'intensity', 'ack']) if (m[k] !== undefined) out[k] = m[k];
  if (m.motors) out.motors = m.motors.map(x => ({ id: x.id, active: !!x.active, intensity: x.intensity || 0 }));
  return out;
}

const rem = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const who = identity(req);
  if (!who) { log('remote request without tailscale identity', req.socket.remoteAddress, url.pathname); return end(res, 403, 'tailscale identity required'); }

  if (url.pathname === '/api/status' && req.method === 'GET') {
    return end(res, 200, { monitors: dashboards.size, last: state.last, you: who.login });
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
      if (msg.type === 'detection') {
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
      end(res, 200, { ok: true, monitors: dashboards.size, id: msg._id });
    });
  }
  if (url.pathname.startsWith('/api/')) return end(res, 404, 'not found');
  if (req.method !== 'GET' && req.method !== 'HEAD') return end(res, 405, 'method not allowed');
  serveStatic(req, res, 'remote.html', true);
});

pub.listen(CFG.publicPort, CFG.publicHost, () => log(`public  : http://${CFG.publicHost}:${CFG.publicPort}  (dashboard + /ws, send-only)`));
rem.listen(CFG.remotePort, CFG.remoteHost, () => log(`remote  : http://${CFG.remoteHost}:${CFG.remotePort}  (expose with: tailscale serve)  tailscale header ${CFG.requireTailscale ? 'required' : 'NOT required (dev)'}`));
log('web dir :', CFG.webDir);

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { log('shutting down'); pub.close(); rem.close(); for (const ws of dashboards) ws.close(); process.exit(0); });
