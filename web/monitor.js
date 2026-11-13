'use strict';
/* miimo Monitor — PC dashboard. Vanilla JS, no build step. */

// ── 상수 ──────────────────────────────────────────────────────
const SEV = {
  danger:  { ko: '긴급', fg: '#D92D20', tx: '#B42318', bg: '#FEECEB', icon: 'error' },
  caution: { ko: '주의', fg: '#E08A0B', tx: '#B45309', bg: '#FFF4E0', icon: 'warning' },
  info:    { ko: '정보', fg: '#1B6EF3', tx: '#1558C8', bg: '#EAF1FE', icon: 'info' }
};
const IDLE = { fg: '#22C39A', tx: '#0B8465', bg: '#E3F6EF' };
const IDS = ['M1', 'M2', 'M3', 'M4', 'M5'];
const CAT = [
  ['emergency_alarm', 'emergency-alarm', '응급·화재 경보음', 'danger'],
  ['gunshot', 'gunshot', '총소리', 'danger'],
  ['glass_break', 'glass-break', '유리 깨지는 소리', 'danger'],
  ['baby_cry', 'baby-cry', '아기 울음소리', 'danger'],
  ['scream', 'scream', '사람 비명', 'danger'],
  ['explosion', 'explosion', '폭발음', 'danger'],
  ['car_horn', 'car-horn', '차량 경적', 'caution'],
  ['bicycle_approach', 'bicycle-approach', '자전거 접근 소리', 'caution'],
  ['construction_noise', 'construction-noise', '공사장 소음', 'caution'],
  ['knock', 'knock', '노크 소리', 'caution'],
  ['pet_cry', 'pet-cry', '개·고양이 울음소리', 'caution'],
  ['kettle_whistle', 'kettle-whistle', '주전자 끓는 소리', 'caution'],
  ['water_running', 'water-running', '물 흐르는 소리', 'info'],
  ['appliance', 'appliance', '가전제품 작동음', 'info'],
  ['cough', 'cough', '기침 소리', 'info']
].map(a => ({ label: a[0], img: 'assets/sounds/' + a[1] + '.png', ko: a[2], lv: a[3] }));
// 넥밴드 위 물리적 위치 (Top View, % 좌표). 어떤 모터 번호가 놓이는지는 state.posMap 으로 설정.
const POS = [
  { ko: '좌측 팁', x: 23, y: 31.25 },
  { ko: '후방 좌', x: 29.3, y: 69.9 },
  { ko: '후방 중앙', x: 50, y: 79.5 },
  { ko: '후방 우', x: 70.7, y: 69.9 },
  { ko: '우측 팁', x: 77, y: 31.25 }
];
// 임시 방향→위치 매핑 (시뮬레이션 전용. 실제 제어는 Pi 5가 결정해 motors[] 로 전송)
const SECT = [
  { ko: '전방', from: 340, to: 20, pos: [0, 4] },
  { ko: '우측', from: 20, to: 100, pos: [4] },
  { ko: '우측 후방', from: 100, to: 155, pos: [3] },
  { ko: '후방', from: 155, to: 205, pos: [2] },
  { ko: '좌측 후방', from: 205, to: 260, pos: [1] },
  { ko: '좌측', from: 260, to: 340, pos: [0] }
];
const DIRS = ['전방', '우측 전방', '우측', '우측 후방', '후방', '좌측 후방', '좌측', '좌측 전방'];
const CFG = { holdSeconds: 8, autoInterval: 5, autoStart: false }; // 시연 설정
const NECK_SVG = `<path d="M92 118 L92 210 A108 108 0 0 0 308 210 L308 118" fill="none" stroke="#DDE3E8" stroke-width="46" stroke-linecap="round"></path>
<path d="M92 118 L92 210 A108 108 0 0 0 308 210 L308 118" fill="none" stroke="#F6F8F9" stroke-width="40" stroke-linecap="round"></path>
<circle cx="200" cy="196" r="56" fill="#F6F8F9" stroke="#DDE3E8" stroke-width="3"></circle>
<path d="M188 143 L200 124 L212 143 Z" fill="#DDE3E8"></path>`;

// ── 상태 ──────────────────────────────────────────────────────
const state = {
  page: 'dashboard', mode: 'live', ws: 'open', wsUrl: 'ws://raspberrypi.local:8000/ws',
  current: null, phase: 'idle', rot: 0, ack: {}, testing: {}, history: [], pop: 0,
  lastRx: null, pico: true, micLevels: null, inferMs: null, stream: '정상', linked: true, auto: false,
  selId: null, fSev: 'all', fSound: 'all', fRange: 'all',
  posMap: ['M1', 'M2', 'M3', 'M4', 'M5'],
  mute: {}, dropped: 0, // 감지 필터: 차단 라벨 · 걸러진 건수
  sim: { label: 'car_horn', deg: 58, dirValid: true, sev: 'auto', motorMode: 'auto', manual: {}, intensity: 0.8, conf: 93 }
};
let seq = 0, ws = null, bc = null, burst = null, room = null, lv = null;
// 중계 서버(server/server.js)로 서빙될 때: ws://<host>/ws 자동 접속 + 백오프 재연결
let relayUrl = null, wantWs = false, retry = 0;
const seen = [];
const T = { hold: 0, ack: 0, auto: 0, mic: 0, reconnect: 0 };
const app = document.getElementById('app');

function setState(patch) {
  Object.assign(state, typeof patch === 'function' ? patch(state) : patch);
  render();
}
function setSim(patch) { state.sim = Object.assign({}, state.sim, patch); render(); }

// ── 유틸 ──────────────────────────────────────────────────────
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const fmt = d => pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
const dirName = d => DIRS[Math.round(d / 45) % 8];
const bg = img => img ? 'url(' + img + ')' : 'none';
const sectOf = deg => SECT.find(s => s.from > s.to ? (deg >= s.from || deg < s.to) : (deg >= s.from && deg < s.to));
const catOf = label => CAT.find(c => c.label === label);
function motorsFor(deg, intensity, valid) {
  const pos = valid === false ? [2] : sectOf(deg).pos;
  const on = pos.map(i => state.posMap[i]);
  return IDS.map(id => ({ id, active: on.includes(id), intensity: on.includes(id) ? intensity : 0 }));
}

// ── 데이터 계층: 모든 입력(시뮬레이터 / WebSocket / 리모컨)은 같은 메시지 형식으로 ingest() 를 통과 ──
function simMsg(o, ts) {
  const c = catOf(o.label);
  const valid = o.dirValid !== false;
  return {
    type: 'detection', timestamp: (ts || new Date()).toISOString(),
    sound_label: c.label, sound_name: c.ko, confidence: o.conf, severity: o.sev || c.lv,
    direction_deg: o.deg, direction_valid: valid,
    motors: o.motors || motorsFor(o.deg, o.intensity == null ? 0.8 : o.intensity, valid)
  };
}
function normalize(msg, source) {
  const c = catOf(msg.sound_label);
  const hasDeg = typeof msg.direction_deg === 'number';
  return {
    id: ++seq, ts: msg.timestamp ? new Date(msg.timestamp) : new Date(), label: msg.sound_label,
    name: msg.sound_name || (c ? c.ko : String(msg.sound_label)), img: c ? c.img : null,
    conf: typeof msg.confidence === 'number' ? msg.confidence : null,
    sev: SEV[msg.severity] ? msg.severity : (c ? c.lv : 'info'),
    deg: hasDeg ? ((Math.round(msg.direction_deg) % 360) + 360) % 360 : 0,
    dirValid: hasDeg && msg.direction_valid !== false,
    motors: (msg.motors || []).map(m => ({ id: m.id, active: !!m.active, intensity: m.intensity || 0 })),
    ackIds: null, source, raw: msg
  };
}
function ingest(msg, source, autoAck) {
  // 감지 필터: 차단한 라벨은 버림
  if (state.mute[msg.sound_label]) { setState(s => ({ dropped: s.dropped + 1 })); return; }
  const ev = normalize(msg, source);
  burst = { t: Date.now(), deg: ev.deg, valid: ev.dirValid, amp: { danger: 0.8, caution: 0.6, info: 0.4 }[ev.sev] };
  clearTimeout(T.hold); clearTimeout(T.ack);
  const cur = ((state.rot % 360) + 360) % 360;
  setState(s => ({
    current: ev, phase: 'detected', ack: {}, pop: s.pop + 1, lastRx: new Date(),
    rot: ev.dirValid ? s.rot + (((ev.deg - cur + 540) % 360) - 180) : s.rot,
    history: [ev].concat(s.history).slice(0, 200),
    inferMs: typeof msg.inference_ms === 'number' ? msg.inference_ms : s.inferMs
  }));
  // 시뮬레이션에서는 하드웨어 확인(ack)을 가상으로 지연 수신. Live 에서는 motor_state 메시지가 올 때만 확인 처리.
  if (source === 'sim' || autoAck) T.ack = setTimeout(() => applyAck(ev.motors.filter(m => m.active).map(m => m.id)), 300);
  T.hold = setTimeout(() => setState({ phase: 'idle', ack: {} }), CFG.holdSeconds * 1000);
}
function applyAck(ids) {
  if (state.current) state.current.ackIds = ids;
  const ack = {}; ids.forEach(i => { ack[i] = true; });
  setState({ ack });
}
function onMessage(m) {
  if (!m || typeof m !== 'object') return;
  if (m._from === 'remote') { onRemote(m); return; }      // 중계 서버가 전달한 리모컨 메시지
  if (m.type === 'snapshot') { applySnapshot(m); return; } // 접속 직후 서버가 보내는 현재 상태
  if (m.type === 'detection') ingest(m, 'live');
  else if (m.type === 'motor_state') { applyAck((m.motors || []).filter(x => x.active).map(x => x.id)); setState({ lastRx: new Date() }); }
  else if (m.type === 'status') setState(s => ({
    lastRx: new Date(),
    pico: typeof m.pico_connected === 'boolean' ? m.pico_connected : s.pico,
    micLevels: Array.isArray(m.mic_levels) ? m.mic_levels : s.micLevels,
    inferMs: typeof m.inference_ms === 'number' ? m.inference_ms : s.inferMs,
    stream: m.audio_stream || s.stream
  }));
}

// 마이크 레벨 연출: 네 마이크가 같은 공간 소음을 함께 듣고(상관된 잔잔한 움직임),
// 감지 순간에는 소리 방향에 가까운 마이크가 더 크게 반응한 뒤 서서히 가라앉음.
// 실제 status.mic_levels 가 수신되면 이 연출은 멈추고 실측값을 표시.
function micTick() {
  const s = state;
  if (!(s.mode === 'sim' || (s.ws === 'open' && s.linked && !s.micLevels))) return;
  const els = document.querySelectorAll('[data-mic]');
  if (!els.length) return;
  const t = Date.now(), MA = [315, 45, 135, 225];
  room = Math.max(0, Math.min(0.09, (room == null ? 0.03 : room) + (Math.random() - 0.5) * 0.022));
  if (Math.random() < 0.025) room = 0.1 + Math.random() * 0.07;
  const b = burst, dt = b ? t - b.t : 1e9;
  const env = dt < 3500 ? Math.exp(-dt / 1100) * (0.65 + 0.35 * Math.random()) : 0;
  lv = lv || [0.08, 0.08, 0.08, 0.08];
  for (let i = 0; i < 4; i++) {
    const gain = b && b.valid ? 0.6 + 0.4 * Math.cos((b.deg - MA[i]) * Math.PI / 180) : 0.8;
    const target = 0.06 + room * (0.85 + 0.3 * Math.sin(t / 900 + i * 2.1)) + Math.random() * 0.018 + (env ? env * b.amp * gain : 0);
    lv[i] += (target - lv[i]) * (target > lv[i] ? 0.7 : 0.28);
  }
  els.forEach(el => { const v = lv[+el.getAttribute('data-mic')] || 0.06; el.style.transform = 'scaleX(' + Math.max(0.03, Math.min(1, v)).toFixed(3) + ')'; });
}

// ── 리모컨 페이지(miimo Remote)와의 채널: BroadcastChannel + localStorage 이벤트 ──
function bus(msg) {
  msg = Object.assign({ _id: Date.now() + '-' + Math.random().toString(36).slice(2, 8), _from: 'monitor' }, msg);
  try { if (bc) bc.postMessage(msg); } catch (e) { /* noop */ }
  try { localStorage.setItem('miimo-remote-bus', JSON.stringify(msg)); } catch (e) { /* noop */ }
}
function onRemote(m) {
  if (!m || m._from !== 'remote' || seen.includes(m._id)) return;
  seen.push(m._id); if (seen.length > 40) seen.shift();
  if (m.type === 'ping') { bus({ type: 'pong' }); return; }
  if (m.type === 'control') {
    if (m.action === 'idle') { clearTimeout(T.hold); setState({ phase: 'idle', ack: {} }); }
    else if (m.action === 'reset') reset();
    return;
  }
  if (m.type !== 'detection') return;
  const r = remoteMsg(m);
  ingest(r.msg, 'live', r.autoAck);
}
// 리모컨 메시지 → 표준 detection 메시지 (motors 없으면 현재 posMap 으로 채움)
function remoteMsg(m) {
  const msg = Object.assign({}, m); delete msg._id; delete msg._from;
  const autoAck = msg.ack !== false; delete msg.ack;
  const inten = typeof msg.intensity === 'number' ? msg.intensity : 0.8; delete msg.intensity;
  if (!Array.isArray(msg.motors)) msg.motors = motorsFor(((Math.round(msg.direction_deg || 0) % 360) + 360) % 360, inten, msg.direction_valid !== false);
  return { msg, autoAck };
}
// 서버 snapshot: 과거 기록은 조용히 복원, 마지막 감지가 아직 표시 시간 안이면 화면에도 띄움
function applySnapshot(m) {
  const hold = CFG.holdSeconds * 1000;
  const age = m.last && typeof m.last._at === 'number' ? (m.now || Date.now()) - m.last._at : Infinity;
  const fresh = age < hold;
  const items = (Array.isArray(m.history) ? m.history : []).filter(x => x && x.type === 'detection' && !(fresh && x._id === m.last._id));
  const restored = items.map(x => {
    const r = remoteMsg(x), ev = normalize(r.msg, 'live');
    if (r.autoAck) ev.ackIds = ev.motors.filter(a => a.active).map(a => a.id);
    return ev;
  });
  if (restored.length) setState(s => ({ history: restored.concat(s.history).slice(0, 200) }));
  if (fresh) {
    onRemote(m.last);
    clearTimeout(T.hold);
    T.hold = setTimeout(() => setState({ phase: 'idle', ack: {} }), hold - age);
  }
}

// ── WebSocket (Live Mode) ──
function connect() {
  disconnect();
  wantWs = true;
  let sock;
  try { sock = new WebSocket(state.wsUrl); } catch (e) { setState({ ws: 'error' }); scheduleReconnect(); return; }
  ws = sock; setState({ ws: 'connecting' });
  sock.onopen = () => { if (ws === sock) { retry = 0; setState({ ws: 'open', linked: true }); } };
  sock.onmessage = e => { let m; try { m = JSON.parse(e.data); } catch (err) { return; } onMessage(m); };
  sock.onclose = () => { if (ws === sock) { ws = null; setState(s => ({ ws: s.ws === 'open' ? 'idle' : 'error', pico: null, micLevels: null, stream: null })); scheduleReconnect(); } };
}
function scheduleReconnect() {
  if (!wantWs) return;
  const delay = Math.min(15000, 1000 * Math.pow(2, retry)); retry++;
  clearTimeout(T.reconnect);
  T.reconnect = setTimeout(() => { if (wantWs && !ws) connect(); }, delay);
}
function disconnect() {
  wantWs = false; clearTimeout(T.reconnect);
  const sock = ws; ws = null;
  if (sock) { try { sock.close(); } catch (e) { /* noop */ } }
  setState({ ws: 'idle', pico: null, micLevels: null, stream: null, linked: false });
}
function send(obj) { if (ws && state.ws === 'open') { try { ws.send(JSON.stringify(obj)); } catch (e) { /* noop */ } } }

// ── 시연 제어 ──
function setMode(mode) {
  if (mode === state.mode) return;
  clearTimeout(T.hold); clearTimeout(T.ack); setAuto(false);
  if (mode === 'sim') disconnect();
  setState(Object.assign({ mode, phase: 'idle', ack: {} }, mode === 'live' && !relayUrl ? { ws: 'open', pico: true, stream: '정상', linked: true } : {}));
  if (mode === 'live' && relayUrl) connect();
}
function setAuto(on) {
  clearInterval(T.auto);
  if (on) { fireRandom(); T.auto = setInterval(() => fireRandom(), CFG.autoInterval * 1000); }
  setState({ auto: on });
}
function fireRandom(label) {
  if (state.mode !== 'sim') return;
  const c = label ? catOf(label) : CAT[Math.floor(Math.random() * CAT.length)];
  const inten = { danger: 1, caution: 0.8, info: 0.5 }[c.lv];
  ingest(simMsg({ label: c.label, deg: Math.floor(Math.random() * 360), conf: Math.round(75 + Math.random() * 23) / 100, dirValid: Math.random() > 0.12, intensity: inten }), 'sim');
}
function fireSim() {
  const sm = state.sim;
  if (state.mode !== 'sim') return;
  const motors = sm.motorMode === 'manual' ? IDS.map(id => ({ id, active: !!sm.manual[id], intensity: sm.manual[id] ? sm.intensity : 0 })) : null;
  ingest(simMsg({ label: sm.label, deg: sm.deg, conf: sm.conf / 100, dirValid: sm.dirValid, sev: sm.sev === 'auto' ? null : sm.sev, intensity: sm.intensity, motors }), 'sim');
}
function reset() {
  clearTimeout(T.hold); clearTimeout(T.ack); clearInterval(T.auto);
  setState({ current: null, phase: 'idle', ack: {}, history: [], rot: 0, lastRx: null, selId: null, auto: false, testing: {} });
}
function testMotor(id) {
  send({ type: 'motor_test', id, intensity: state.sim.intensity, duration_ms: 1200 });
  setState(s => ({ testing: Object.assign({}, s.testing, { [id]: true }) }));
  setTimeout(() => setState(s => ({ testing: Object.assign({}, s.testing, { [id]: false }) })), 1200);
}

// ── 뷰 모델 ──
function vals() {
  const s = state, sim = s.mode === 'sim', cur = s.current, det = s.phase === 'detected' && !!cur;
  const wsOpen = s.ws === 'open', offline = !sim && !wsOpen;
  const S = det ? SEV[cur.sev] : null, C = S || IDLE;
  const dot = { ok: '#22C39A', off: '#C5CCD3', bad: '#D92D20', wait: '#E08A0B' };
  const wsSt = { open: ['ok', '연결됨'], connecting: ['wait', '연결 중'], error: ['bad', '연결 실패'], idle: ['off', '미연결'] }[s.ws];
  const pi = sim ? ['off', '미연결'] : wsSt;
  const pico = (!sim && wsOpen) ? (s.pico === true ? ['ok', '연결됨'] : s.pico === false ? ['bad', '끊김'] : ['ok', '확인 중']) : ['off', '미연결'];
  const sock = sim ? ['off', '사용 안 함'] : wsSt;
  const mon = sim ? ['ok', '시뮬레이션'] : wsOpen ? ['ok', '실시간'] : ['off', '중지'];
  const chips = [['Raspberry Pi 5', pi], ['Pico 2H', pico], ['WebSocket', sock], ['모니터링', mon]].map(c => ({ label: c[0], st: c[1][1], dot: dot[c[1][0]] }));

  const showArrow = det && cur.dirValid, dirChecking = det && !cur.dirValid;
  const nodes = POS.map((p, i) => {
    const id = s.posMap[i], cmd = det ? cur.motors.find(m => m.id === id) : null;
    const cmdOn = !!(cmd && cmd.active), test = !!s.testing[id], on = (cmdOn && !!s.ack[id]) || test;
    const col = test && !cmdOn ? IDLE : C;
    return {
      id, ko: p.ko, left: p.x + '%', top: p.y + '%', leftR: +(100 - p.x).toFixed(2) + '%', topR: +(100 - p.y).toFixed(2) + '%', cmdOn, on, test, intensity: cmd ? cmd.intensity : 0,
      bg: on ? col.fg : cmdOn ? col.bg : '#E9EDF0', fg: on ? '#fff' : cmdOn ? col.tx : '#8A94A0',
      border: cmdOn && !on ? '3px dashed ' + col.fg : '3px solid transparent', ringColor: col.fg
    };
  });
  const act = nodes.filter(n => n.cmdOn);
  const allAck = act.length > 0 && act.every(n => n.on);
  const hist = s.history;
  const now = Date.now(), rangeMs = { all: Infinity, '1m': 6e4, '10m': 6e5, '1h': 36e5 }[s.fRange];
  const filtered = hist.filter(e => (s.fSev === 'all' || e.sev === s.fSev) && (s.fSound === 'all' || e.label === s.fSound) && (now - e.ts.getTime() <= rangeMs));
  const sel = filtered.find(e => e.id === s.selId) || filtered[0] || null;
  const levels = s.micLevels, micOn = sim || (wsOpen && s.linked && !levels);
  const mics = [0, 1, 2, 3].map(i => ({
    label: 'MIC ' + (i + 1), i,
    bg: micOn || (wsOpen && levels) ? '#22C39A' : '#C5CCD3',
    tf: micOn ? 'scaleX(0.08)' : 'scaleX(' + (wsOpen && levels ? Math.max(0.02, Math.min(1, levels[i] || 0)) : 0.02) + ')'
  }));
  const note = sim ? { bg: '#F4F6F8', fg: '#16151A', filter: 'none', text: 'Simulation Mode — 가상 데이터로 동작 중이에요. 실제 하드웨어 상태가 아닙니다.' }
    : s.ws === 'open' ? { bg: '#E3F6EF', fg: '#0B8465', filter: 'none', text: '연결 완료! Raspberry Pi 5의 실시간 추론 결과를 받고 있어요.' }
    : s.ws === 'connecting' ? { bg: '#FFF4E0', fg: '#B45309', filter: 'none', text: 'Raspberry Pi 5에 연결하는 중이에요…' }
    : s.ws === 'error' ? { bg: '#FEECEB', fg: '#B42318', filter: 'grayscale(1)', text: '연결에 실패했어요. Raspberry Pi 주소와 같은 Wi-Fi에 있는지 확인해 주세요.' }
    : { bg: '#F4F6F8', fg: '#16151A', filter: 'grayscale(1)', text: 'Live Mode — WebSocket 주소를 확인하고 연결을 눌러 주세요.' };

  return { s, sim, cur, det, wsOpen, offline, S, C, dot, chips, showArrow, dirChecking, nodes, act, allAck, hist, filtered, sel, levels, micOn, mics, note, pi, pico };
}

// ── 템플릿 ──
const sevPill = (S, ko) => `<span class="sev" style="background:${S.bg};color:${S.tx}">${ko}</span>`;
function rowTpl(ev, selId, history) {
  const S = SEV[ev.sev], on = ev.motors.filter(m => m.active).map(m => m.id);
  return `<div class="trow${history ? ' h' : ''}${ev.id === selId ? ' sel' : ''}" data-act="row" data-arg="${ev.id}">
    <span class="t-time">${fmt(ev.ts)}</span>
    <span class="t-snd"><span class="t-ico" style="background:${S.bg}"><span class="ms" style="color:${S.tx}">graphic_eq</span><span class="img" style="background-image:${bg(ev.img)}"></span></span><span class="t-name">${esc(ev.name)}</span></span>
    ${sevPill(S, S.ko)}
    <span class="t-dir"><span class="ms" style="color:${S.tx};transform:rotate(${ev.deg}deg);opacity:${ev.dirValid ? 1 : 0.25}">navigation</span>${ev.dirValid ? dirName(ev.deg) + ' ' + ev.deg + '°' : '방향 확인 중'}</span>
    <span class="t-num">${ev.conf == null ? '—' : Math.round(ev.conf * 100) + '%'}</span>
    <span class="t-mot">${on.length ? on.join(' · ') : '—'}</span>
    ${history ? `<span class="t-src">${ev.source === 'sim' ? 'SIM' : 'LIVE'}</span>` : ''}
  </div>`;
}
const seg = (opts, value, act, cls) => `<div class="seg ${cls || ''}">${opts.map(o => `<button class="${String(o[0]) === String(value) ? 'on' : ''}" data-act="${act}" data-arg="${o[0]}">${o[1]}</button>`).join('')}</div>`;
const micTpl = (m, big) => `<div class="mic">${big ? `<span class="ms" style="color:${m.bg}">mic</span>` : ''}<span class="mic-l">${m.label}</span><div class="bar"><i data-mic="${m.i}" style="background:${m.bg};transform:${m.tf}"></i></div></div>`;

function tplHeader(v) {
  const { s, sim } = v;
  const tabs = [['dashboard', 'Dashboard', 'space_dashboard'], ['history', 'Detection History', 'history'], ['device', 'Device & Demo', 'tune']];
  return `<header class="hdr">
    <div class="logo"><div class="logo-box"><img src="assets/miimo.png" alt="miimo"></div>
      <div><div class="logo-t">miimo <span>Monitor</span></div><div class="logo-s">Wearable Sound Recognition System</div></div></div>
    <nav class="tabs">${tabs.map(t => `<button class="tab${s.page === t[0] ? ' on' : ''}" data-act="tab" data-arg="${t[0]}"><span class="ms">${t[2]}</span>${t[1]}</button>`).join('')}</nav>
    <div class="grow"></div>
    <div class="hdr-r">
      ${v.chips.map(c => `<div class="chip"><span class="dot" style="background:${c.dot}"></span><b>${c.label}</b><i>${c.st}</i></div>`).join('')}
      <div class="mode ${sim ? 'sim' : 'live'}"><span class="ms">${sim ? 'science' : 'sensors'}</span>${sim ? 'SIMULATION MODE' : 'LIVE MODE'}</div>
      <div class="mode" style="background:#F0F3F5;color:var(--ink)"><span class="ms">battery_5_bar</span>73%</div>
    </div>
  </header>`;
}

let lastPop = 0, lastRot = 0;
function tplDashboard(v) {
  const { s, cur, det, offline, S, C, showArrow, dirChecking, nodes, act, allAck, hist } = v;
  const pop = s.pop !== lastPop;
  let step1;
  if (det) step1 = `<div class="stack det${pop ? ' pop' : ''}">
      <div class="det-icon" style="background:${S.bg}"><span class="ms" style="color:${S.fg}">graphic_eq</span><span class="img" style="background-image:${bg(cur.img)}"></span></div>
      <div class="det-name">${esc(cur.name)}</div>
      <div class="pills"><span class="pill" style="background:${S.bg};color:${S.tx}"><span class="ms">${S.icon}</span>위험도 ${S.ko}</span>
        <span class="pill gray">신뢰도 <b>${cur.conf == null ? '—' : Math.round(cur.conf * 100) + '%'}</b></span></div>
      <div class="conf"><i style="width:${cur.conf == null ? 0 : Math.round(cur.conf * 100)}%;background:${S.fg}"></i></div>
      <div class="det-time">${fmt(cur.ts)} 감지 · ${cur.source === 'sim' ? '시뮬레이션 데이터' : 'Raspberry Pi 5'}</div></div>`;
  else if (offline) step1 = `<div class="stack">
      <div class="idle-ring off-ring"><img src="assets/miimo.png" alt="miimo"></div>
      <div class="idle-t off-t">${s.ws === 'error' ? 'Raspberry Pi에 연결하지 못했어요' : s.ws === 'connecting' ? '연결하는 중이에요…' : 'Raspberry Pi 연결을 기다려요'}</div>
      <div class="idle-s">Live Mode에서는 Raspberry Pi 5가 보낸 실제 추론 결과만 표시합니다.</div>
      <button class="btn" data-act="tab" data-arg="device"><span class="ms">settings_ethernet</span>연결 설정 열기</button></div>`;
  else step1 = `<div class="stack">
      <div class="idle-ring"><img src="assets/miimo.png" alt="miimo"></div>
      <div class="wave"><span></span><span></span><span></span><span></span><span></span></div>
      <div class="idle-t">주변 소리를 듣고 있어요</div>
      <div class="idle-s">소리가 감지되면 여기에 바로 표시돼요</div></div>`;

  const dial = `<div class="sq">
      <svg viewBox="0 0 400 400"><circle cx="200" cy="200" r="150" fill="#FAFBFC" stroke="#E3E8EC" stroke-width="2"></circle><circle cx="200" cy="200" r="100" fill="none" stroke="#E9EDF0" stroke-width="2" stroke-dasharray="4 7"></circle><circle cx="200" cy="200" r="50" fill="none" stroke="#E9EDF0" stroke-width="2" stroke-dasharray="4 7"></circle><line x1="200" y1="50" x2="200" y2="350" stroke="#E9EDF0" stroke-width="2"></line><line x1="50" y1="200" x2="350" y2="200" stroke="#E9EDF0" stroke-width="2"></line><circle cx="200" cy="200" r="158" fill="none" stroke="#C9D1D9" stroke-width="8" stroke-dasharray="2 25.576"></circle></svg>
      ${dirChecking ? `<div class="sweep" style="background:conic-gradient(from 0deg, rgba(255,255,255,0) 0deg 270deg, ${C.fg} 360deg)"></div>` : ''}
      <div class="arrow" id="dialArrow" style="transform:rotate(${lastRot + 180}deg);opacity:${showArrow ? 1 : 0};color:${C.fg}">
        <svg viewBox="0 0 400 400"><path d="M200 200 L148.7 59.05 A150 150 0 0 1 251.3 59.05 Z" fill="currentColor" opacity=".13"></path><line x1="200" y1="150" x2="200" y2="100" stroke="currentColor" stroke-width="10" stroke-linecap="round"></line><path d="M200 66 L222 100 L178 100 Z" fill="currentColor" stroke="currentColor" stroke-width="8" stroke-linejoin="round"></path><circle cx="200" cy="50" r="9" fill="#fff" stroke="currentColor" stroke-width="5"></circle></svg></div>
      <svg viewBox="0 0 400 400" style="pointer-events:none;transform:rotate(180deg)"><circle cx="200" cy="200" r="44" fill="#fff"></circle><path d="M172 192 L172 204 A28 28 0 0 0 228 204 L228 192" fill="none" stroke="#22C39A" stroke-width="9" stroke-linecap="round"></path><circle cx="200" cy="200" r="17" fill="#16151A"></circle><path d="M193 186 L200 174 L207 186 Z" fill="#16151A"></path></svg>
      <span class="dl top">후방 180°</span><span class="dl bot" style="gap:0">전방 0°</span><span class="dl r">좌측<br>270°</span><span class="dl l">우측<br>90°</span>
    </div>
    <div class="big">${showArrow ? `<span class="big-n" style="color:${C.fg}">${cur.deg}°</span>` : ''}<span class="big-s">${showArrow ? dirName(cur.deg) : dirChecking ? '방향 확인 중' : offline ? '연결 대기' : '대기 중'}</span></div>
    <div class="note">${showArrow ? '0° = 착용자 정면 · 시계 방향' : dirChecking ? '방향 추정이 아직 안정되지 않았어요' : '소리가 감지되면 화살표가 방향을 가리켜요'}</div>`;

  const neck = `<div class="sq">
      <svg viewBox="0 0 400 400" style="transform:rotate(180deg)">${NECK_SVG}</svg>
      <span class="dl top">후방 · 목 뒤</span><span class="dl c">착용자</span><span class="dl bot"><span class="ms">arrow_drop_down</span>전방</span>
      ${nodes.map(m => `<div class="node" style="left:${m.leftR};top:${m.topR}">
        ${m.on ? `<div class="ring" style="border-color:${m.ringColor}"></div><div class="ring d2" style="border-color:${m.ringColor}"></div>` : ''}
        <div class="core${m.on ? ' on' : ''}" style="background:${m.bg};color:${m.fg};border:${m.border}">${m.id}</div></div>`).join('')}
    </div>
    <div class="big">${act.length ? `<span class="big-n" style="color:${C.fg}">${act.map(n => n.id).join(' + ')}</span>` : ''}<span class="big-s">${act.length ? act.map(n => n.ko).join(' · ') : (offline ? '연결 대기' : '대기 중')}</span></div>
    <div class="legend"><span><span class="ldot" style="background:${C.fg}"></span>진동 확인 (하드웨어)</span><span><span class="ldot" style="border:2px dashed ${C.fg}"></span>명령 전송됨</span><span><span class="ldot" style="background:#E3E7EC"></span>비활성</span><span>${act.length ? '강도 ' + Math.round(act[0].intensity * 100) + '% · ' + (allAck ? '확인됨' : '확인 대기') : ''}</span></div>`;

  const sum1 = det ? esc(cur.name) : offline ? 'Raspberry Pi 연결 대기 중' : '소리 인식';
  const sum2 = det ? (cur.dirValid ? dirName(cur.deg) + ' ' + cur.deg + '°' : '방향 확인 중') : offline ? '' : '방향 추정';
  const sum3 = det ? (act.length ? act.map(n => n.id + ' ' + n.ko).join(' + ') + ' 진동' : '진동 없음') : offline ? '' : '넥밴드 진동';
  const arrowOp = offline && !det ? 0 : 1;

  const col = (n, title, tag, body) => `<div class="col"><div class="col-h"><span class="num">${n}</span><span class="col-t">${title}</span><span class="col-tag">${tag}</span></div><div class="col-b">${body}</div></div>`;
  return `<main>
    <section class="hero">
      <div class="hero-bar" style="background:${C.fg}"></div>
      <div class="hero-cols">
        ${col(1, '무슨 소리인가요?', 'AI 환경음 분류', step1)}
        ${col(2, '어느 방향인가요?', '착용자 기준 360°', dial)}
        ${col(3, '어디가 진동하나요?', '넥밴드 TOP VIEW', neck)}
      </div>
      <div class="summary" style="background:${C.bg};color:${C.tx}"><span>${sum1}</span><span class="ms" style="opacity:${arrowOp}">arrow_forward</span><span>${sum2}</span><span class="ms" style="opacity:${arrowOp}">arrow_forward</span><span>${sum3}</span></div>
    </section>
  </main>`;
}

function tplHistory(v) {
  const { s, hist, filtered, sel } = v;
  const selS = sel ? SEV[sel.sev] : IDLE;
  const selOn = sel ? sel.motors.filter(m => m.active).map(m => m.id) : [];
  let detail = '';
  if (sel) {
    const rows = [
      ['신뢰도', sel.conf == null ? '—' : Math.round(sel.conf * 100) + '%'],
      ['방향 추정', sel.dirValid ? '유효' : '불가 · 확인 중'],
      ['모터 제어 명령', selOn.length ? selOn.join(', ') : '없음'],
      ['하드웨어 확인', sel.ackIds ? (sel.ackIds.length ? sel.ackIds.join(', ') : '없음') + (sel.source === 'sim' ? ' (가상)' : '') : '수신되지 않음'],
      ['진동 강도', selOn.length ? Math.round(sel.motors.find(m => m.active).intensity * 100) + '%' : '—'],
      ['출처', sel.source === 'sim' ? '시뮬레이션' : 'Raspberry Pi 5 (Live)']
    ];
    detail = `<section class="card detail" style="flex:1 1 380px;min-width:0">
      <div class="d-head"><span class="d-ico" style="background:${selS.bg}"><span class="ms" style="color:${selS.tx}">graphic_eq</span><span class="img" style="background-image:${bg(sel.img)}"></span></span>
        <div style="min-width:0"><div class="d-name">${esc(sel.name)}</div><div class="d-meta">${sevPill(selS, selS.ko)}<i>${sel.ts.getFullYear()}.${pad(sel.ts.getMonth() + 1)}.${pad(sel.ts.getDate())} ${fmt(sel.ts)}</i></div></div></div>
      <div class="d-grid">
        <div class="d-box"><div class="mini-dial"><div class="ar" style="transform:rotate(${sel.deg}deg);opacity:${sel.dirValid ? 1 : 0}"><i style="background:${selS.fg}"></i><b style="background:${selS.fg}"></b></div><div class="ctr"></div></div>
          <div class="cap">${sel.dirValid ? dirName(sel.deg) + ' ' + sel.deg + '°' : '방향 확인 중'}</div></div>
        <div class="d-box"><div class="mini-neck"><svg viewBox="0 0 400 400"><path d="M92 118 L92 210 A108 108 0 0 0 308 210 L308 118" fill="none" stroke="#DDE3E8" stroke-width="44" stroke-linecap="round"></path><circle cx="200" cy="196" r="54" fill="#fff" stroke="#DDE3E8" stroke-width="4"></circle><path d="M186 146 L200 124 L214 146 Z" fill="#DDE3E8"></path></svg>
          ${POS.map((p, i) => { const id = s.posMap[i], on = selOn.includes(id), ack = !!(sel.ackIds && sel.ackIds.includes(id)); return `<div class="nd" style="left:${p.x}%;top:${p.y}%;background:${on && ack ? selS.fg : on ? selS.bg : '#fff'};border-color:${on ? selS.fg : '#C5CCD3'};border-style:${on && !ack ? 'dashed' : 'solid'}"></div>`; }).join('')}</div>
          <div class="cap">${selOn.length ? selOn.join(' · ') : '진동 없음'}</div></div>
      </div>
      <div>${rows.map(r => `<div class="dkv"><span>${r[0]}</span><span>${r[1]}</span></div>`).join('')}</div>
      <div><div class="cap-sm">WEBSOCKET PAYLOAD</div><pre class="json">${esc(JSON.stringify(sel.raw, null, 2))}</pre></div>
    </section>`;
  }
  return `<main>
    <div class="filters">
      <div class="h1">감지 기록</div><span class="cnt" style="font-size:15px">${filtered.length} / ${hist.length}건</span><div class="grow"></div>
      ${seg([['all', '전체'], ['danger', '긴급'], ['caution', '주의'], ['info', '정보']], s.fSev, 'fSev', 'dk')}
      <select class="sel" data-act="fSound"><option value="all">모든 소리</option>${CAT.map(c => `<option value="${c.label}"${s.fSound === c.label ? ' selected' : ''}>${c.ko}</option>`).join('')}</select>
      ${seg([['all', '전체 시간'], ['1m', '최근 1분'], ['10m', '최근 10분'], ['1h', '최근 1시간']], s.fRange, 'fRange', 'dk')}
    </div>
    <div class="row2s">
      <section class="card" style="flex:2 1 680px;min-width:0;padding:12px 24px 16px;overflow-x:auto">
        <div class="trow h head"><span>시간</span><span>소리</span><span>위험도</span><span>방향</span><span>신뢰도</span><span>진동 모듈</span><span>출처</span></div>
        ${filtered.map(e => rowTpl(e, sel ? sel.id : null, true)).join('')}
        ${filtered.length ? '' : `<div class="empty tall"><img src="assets/miimo.png" alt=""><span>조건에 맞는 감지 기록이 없어요</span></div>`}
      </section>
      ${detail}
    </div>
  </main>`;
}

function tplDevice(v) {
  const { s, sim, cur, det, wsOpen, S, C, nodes, act, note, dot, pi, pico } = v;
  const dev = (icon, n, d, l, st) => `<div class="dev"><span class="ms">${icon}</span><div style="min-width:0"><div class="dev-n">${n}</div><div class="dev-d">${d}</div>${l ? `<div class="dev-l">${l}</div>` : ''}</div><span class="dev-st"><span class="dot" style="background:${st[0]}"></span>${st[1]}</span></div>`;
  return `<main>
    <section class="card" style="padding:24px;display:flex;flex-direction:column;gap:20px">
      <div class="filters">
        <span class="h2 lg">연결</span>
        ${seg([['live', 'Live Mode'], ['sim', 'Simulation Mode']], s.mode, 'mode', 'nu')}
        <div class="grow"></div>
        <div class="ws"><input id="wsUrl" value="${esc(s.wsUrl)}" spellcheck="false">
          <button class="btn${wsOpen || s.ws === 'connecting' ? ' off' : ''}" data-act="wsAction"><span class="ms">${wsOpen ? 'link_off' : 'link'}</span>${wsOpen ? '연결 해제' : s.ws === 'connecting' ? '취소' : '연결'}</button></div>
      </div>
      <div class="conn-grid">
        ${dev('memory', 'Pico 2H', '마이크 4 · 진동 모듈 5', 'USB Serial ↔ Pi 5', [dot[pico[0]], pico[1]])}
        ${dev('developer_board', 'Raspberry Pi 5', 'AI 분류 · 방향 추정', 'WebSocket ↔ PC', [dot[pi[0]], pi[1]])}
        ${dev('laptop_mac', 'PC 브라우저', 'miimo Monitor', '', ['#22C39A', '실행 중'])}
      </div>
      <div class="banner" style="background:${note.bg}"><img src="assets/miimo.png" alt="" style="filter:${note.filter}"><span style="color:${note.fg}">${note.text}</span></div>
    </section>

    <div class="row2s" style="align-items:stretch">
        <section class="card" style="flex:1 1 440px;min-width:0;padding:24px">
          <div class="card-h" style="margin-bottom:6px"><span class="h2 lg">진동 모듈 테스트</span><span class="hint" style="margin-left:auto">${wsOpen ? '누르면 motor_test 명령 전송' : '하드웨어 미연결 · UI 동작만'}</span></div>
          <div class="test-wrap">
            <div class="sq neck280"><svg viewBox="0 0 400 400">${NECK_SVG}</svg><span class="dl top" style="font-weight:900;color:#16151A">전방</span>
              ${nodes.map(m => `<button class="node btn-node" data-act="test" data-arg="${m.id}" style="left:${m.left};top:${m.top}">
                ${m.on ? `<span class="ring" style="border-color:${m.ringColor}"></span>` : ''}
                <span class="core${m.on ? ' on' : ''}" style="background:${m.bg};color:${m.fg};border:${m.border};font-size:14px">${m.id}</span></button>`).join('')}</div>
            <div class="test-list">${nodes.map(n => `<button class="tbtn${n.test ? ' on' : ''}" data-act="test" data-arg="${n.id}"><b>${n.id}</b><i>${n.ko}</i><em><span class="ms">vibration</span>${n.test ? '진동 중' : '테스트'}</em></button>`).join('')}</div>
          </div>
        </section>

        <section class="card" style="flex:1 1 440px;min-width:0;padding:24px">
          <div class="card-h" style="margin-bottom:14px"><span class="h2 lg">방향 → 모터 매핑</span></div>
          <div class="wrap">
            <div style="flex:1 1 190px;min-width:0"><div class="sub-l">위치별 모터 번호</div>
              ${POS.map((p, i) => `<div class="pos-row"><span>${p.ko}</span><select data-act="pos" data-arg="${i}">${IDS.map(id => `<option value="${id}"${s.posMap[i] === id ? ' selected' : ''}>${id}</option>`).join('')}</select></div>`).join('')}</div>
            <div style="flex:1 1 220px;min-width:0"><div class="sub-l">방향 구간별 진동</div>
              ${SECT.map(x => `<div class="sect-row"><b>${x.ko}</b><i>${x.from}°–${x.to}°</i><em>${x.pos.map(i => s.posMap[i]).join(' + ')}</em></div>`).join('')}</div>
          </div>
        </section>

        <section class="card" style="flex:1 1 440px;min-width:0;padding:24px;display:flex;flex-direction:column;gap:18px">
          <div class="card-h" style="margin:0"><span class="h2 lg">감지 필터</span></div>
          <div><div class="card-h"><span class="lbl" style="margin:0">받을 소리 라벨</span><span class="hint">${CAT.filter(c => !s.mute[c.label]).length}/${CAT.length} 허용 · 걸러짐 ${s.dropped}건</span><button class="link-btn" data-act="muteNone">전체 허용</button></div>
            ${[['danger', '위험음'], ['caution', '경고음'], ['info', '편의음']].map(g => {
              const list = CAT.filter(c => c.lv === g[0]), off = list.every(c => s.mute[c.label]), G = SEV[g[0]];
              return `<div class="card-h" style="margin:14px 0 8px"><span class="ms" style="font-size:20px;color:${G.fg}">${G.icon}</span><span class="lbl" style="margin:0;color:${G.tx}">${g[1]}</span><span class="hint">${list.filter(c => !s.mute[c.label]).length}/${list.length}</span>
                <button class="link-btn" style="color:${off ? 'var(--dim)' : G.tx}" data-act="muteLv" data-arg="${g[0]}"><span class="ms">${off ? 'notifications_off' : 'notifications_active'}</span>${g[1]} ${off ? '켜기' : '끄기'}</button></div>
              <div class="tiles">${list.map(c => `<button class="tile${s.mute[c.label] ? '' : ' on'}" style="opacity:${s.mute[c.label] ? 0.45 : 1}" data-act="mute" data-arg="${c.label}"><i style="background-image:${bg(c.img)}"></i><span>${c.ko}</span></button>`).join('')}</div>`;
            }).join('')}</div>
        </section>
    </div>
  </main>`;
}

// ── 렌더 ──
function render() {
  const v = vals();
  const page = state.page === 'history' ? tplHistory(v) : state.page === 'device' ? tplDevice(v) : tplDashboard(v);
  app.innerHTML = tplHeader(v) + page;
  lastPop = state.pop;
  const arrow = document.getElementById('dialArrow');
  if (arrow) {
    const target = state.rot + 180;
    if (lastRot !== state.rot) requestAnimationFrame(() => { arrow.style.transform = 'rotate(' + target + 'deg)'; });
    else arrow.style.transform = 'rotate(' + target + 'deg)';
  }
  lastRot = state.rot;
}

// ── 이벤트 ──
const ACT = {
  tab: a => setState({ page: a }),
  row: a => setState({ page: 'history', selId: +a }),
  fSev: a => setState({ fSev: a }),
  fRange: a => setState({ fRange: a }),
  mode: a => setMode(a),
  wsAction: () => { if (state.mode === 'sim') setMode('live'); if (state.ws === 'open' || state.ws === 'connecting') disconnect(); else connect(); },
  sound: a => setSim({ label: a }),
  toggleDirValid: () => setSim({ dirValid: !state.sim.dirValid }),
  simSev: a => setSim({ sev: a }),
  simInt: a => setSim({ intensity: +a }),
  simMotor: a => setSim({ motorMode: a }),
  manual: a => setSim({ motorMode: 'manual', manual: Object.assign({}, state.sim.manual, { [a]: !state.sim.manual[a] }) }),
  fireSim: () => fireSim(),
  reset: () => reset(),
  toggleAuto: () => { if (state.mode === 'sim') setAuto(!state.auto); },
  test: a => testMotor(a),
  mute: a => setState(s => ({ mute: Object.assign({}, s.mute, { [a]: !s.mute[a] }) })),
  muteNone: () => setState({ mute: {} }),
  // 위험도 그룹 일괄: 전부 꺼져 있으면 켜고, 아니면 전부 끔
  muteLv: a => setState(s => {
    const list = CAT.filter(c => c.lv === a), on = !list.every(c => s.mute[c.label]), mute = Object.assign({}, s.mute);
    list.forEach(c => { mute[c.label] = on; });
    return { mute };
  })
};
app.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el || el.tagName === 'SELECT') return;
  const fn = ACT[el.dataset.act];
  if (fn) fn(el.dataset.arg, el);
});
app.addEventListener('change', e => {
  const el = e.target;
  if (el.dataset.act === 'fSound') setState({ fSound: el.value });
  else if (el.dataset.act === 'pos') {
    const i = +el.dataset.arg, v = el.value, m = state.posMap.slice(), j = m.indexOf(v);
    m[j] = m[i]; m[i] = v; setState({ posMap: m });
  } else if (el.id === 'simDeg') setSim({ deg: +el.value });
  else if (el.id === 'simConf') setSim({ conf: +el.value });
});
app.addEventListener('input', e => {
  const el = e.target;
  if (el.id === 'simDeg') { state.sim.deg = +el.value; document.getElementById('simDegText').textContent = el.value + '°'; document.getElementById('simDirName').textContent = dirName(+el.value); }
  else if (el.id === 'simConf') { state.sim.conf = +el.value; document.getElementById('simConfText').textContent = el.value + '%'; }
  else if (el.id === 'wsUrl') state.wsUrl = el.value;
});

// ── 시작 ──
function init() {
  // URL 옵션: ?page=dashboard|history|device  ?auto=1 (시뮬레이션 자동 시연으로 시작)
  const q = new URLSearchParams(location.search);
  if (['dashboard', 'history', 'device'].includes(q.get('page'))) state.page = q.get('page');
  if (q.get('auto') === '1') CFG.autoStart = true;
  // http(s)로 서빙되면 같은 호스트의 중계 서버 /ws 에 자동 접속. file:// 로 열면 기존 동작 그대로.
  if (/^https?:$/.test(location.protocol)) {
    relayUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
    state.wsUrl = relayUrl; state.ws = 'idle'; state.pico = null; state.linked = false;
  }
  const seeds = [['glass_break', 262, 0.91, 40], ['car_horn', 58, 0.93, 95], ['knock', 184, 0.84, 170], ['water_running', 120, 0.78, 260], ['baby_cry', 318, 0.89, 420]];
  state.history = seeds.map(a => {
    const ev = normalize(simMsg({ label: a[0], deg: a[1], conf: a[2] }, new Date(Date.now() - a[3] * 1000)), 'live');
    ev.ackIds = ev.motors.filter(m => m.active).map(m => m.id);
    return ev;
  });
  try { bc = new BroadcastChannel('miimo-remote'); bc.onmessage = e => onRemote(e.data); } catch (e) { /* noop */ }
  window.addEventListener('storage', e => { if (e.key === 'miimo-remote-bus' && e.newValue) { try { onRemote(JSON.parse(e.newValue)); } catch (err) { /* noop */ } } });
  T.mic = setInterval(micTick, 100);
  render();
  if (CFG.autoStart) { setMode('sim'); setAuto(true); }
  else if (relayUrl) connect();
}
init();
