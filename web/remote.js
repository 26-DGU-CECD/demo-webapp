'use strict';
/* miimo Remote — drives the Monitor page in another tab via BroadcastChannel + localStorage. */

const SEV = {
  danger:  { ko: '긴급', fg: '#D92D20', tx: '#B42318', bg: '#FEECEB' },
  caution: { ko: '주의', fg: '#E08A0B', tx: '#B45309', bg: '#FFF4E0' },
  info:    { ko: '정보', fg: '#1B6EF3', tx: '#1558C8', bg: '#EAF1FE' }
};
const IDS = ['M1', 'M2', 'M3', 'M4', 'M5'];
const DIRS = ['전방', '우측 전방', '우측', '우측 후방', '후방', '좌측 후방', '좌측', '좌측 전방'];
const CAT = [
  ['emergency_alarm', 'emergency-alarm', '응급·화재 경보음', 'danger'],
  ['gunshot', 'gunshot', '총소리', 'danger'],
  ['glass_break', 'glass-break', '유리 깨지는 소리', 'danger'],
  ['baby_cry', 'baby-cry', '아기 울음소리', 'danger'],
  ['scream', 'scream', '사람 비명', 'danger'],
  ['car_horn', 'car-horn', '차량 경적', 'caution'],
  ['bicycle_approach', 'bicycle-approach', '자전거 접근 소리', 'caution'],
  ['construction_noise', 'construction-noise', '공사장 소음', 'caution'],
  ['knock', 'knock', '노크 소리', 'caution'],
  ['pet_cry', 'pet-cry', '개·고양이 울음소리', 'caution'],
  ['water_running', 'water-running', '물 흐르는 소리', 'info'],
  ['appliance', 'appliance', '가전제품 작동음', 'info']
].map(a => ({ label: a[0], img: 'assets/sounds/' + a[1] + '.png', ko: a[2], lv: a[3] }));
const KEY = 'miimo-remote-presets';
const CELLS = [[315, '좌측 전방'], [0, '전방'], [45, '우측 전방'], [270, '좌측'], [null, '착용자'], [90, '우측'], [225, '좌측 후방'], [180, '후방'], [135, '우측 후방']];

const state = { presets: [], selId: null, lastPong: 0, log: [], flashId: null };
let n = 0, bc = null, flashT = 0;
const seen = [];
const app = document.getElementById('app');

const pad = x => String(x).padStart(2, '0');
const now = () => { const d = new Date(); return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); };
const cat = l => CAT.find(c => c.label === l) || CAT[0];
const dirName = d => DIRS[Math.round(d / 45) % 8];
const dirText = p => p.dirValid ? dirName(p.deg) + ' ' + p.deg + '°' : '방향 확인 중';
const motorText = p => { if (p.motorMode !== 'manual') return '자동 매핑'; const on = IDS.filter(id => p.manual[id]); return on.length ? on.join(' · ') : '진동 없음'; };
const mk = (label, deg, extra) => Object.assign({ id: 'p' + (++n) + '-' + Date.now().toString(36), label, deg, dirValid: true, sev: 'auto', intensity: 0.8, conf: 93, motorMode: 'auto', manual: {}, ack: true }, extra || {});
const defaults = () => [['car_horn', 58], ['emergency_alarm', 0], ['glass_break', 262], ['baby_cry', 318], ['knock', 180], ['bicycle_approach', 135], ['scream', 90], ['water_running', 225]]
  .map(a => mk(a[0], a[1], { intensity: { danger: 1, caution: 0.8, info: 0.4 }[cat(a[0]).lv] }));

function setState(patch) { Object.assign(state, patch); render(); }
function save() { try { localStorage.setItem(KEY, JSON.stringify(state.presets)); } catch (e) { /* noop */ } }
function sel() { return state.presets.find(p => p.id === state.selId) || state.presets[0]; }
function patch(obj) {
  const id = sel().id;
  state.presets = state.presets.map(p => p.id === id ? Object.assign({}, p, obj) : p);
  save(); render();
}
function addLog(text) { state.log = [{ time: now(), text }].concat(state.log).slice(0, 6); }

// ── 채널 ──
// 중계 서버(server/server.js)로 서빙되면 /api/send 로도 보냄. 탭 간 BC/localStorage 경로는 예비로 유지.
const API = /^https?:$/.test(location.protocol) ? '' : null;
function bus(msg) {
  msg = Object.assign({ _id: Date.now() + '-' + Math.random().toString(36).slice(2, 8), _from: 'remote' }, msg);
  try { if (bc) bc.postMessage(msg); } catch (e) { /* noop */ }
  try { localStorage.setItem('miimo-remote-bus', JSON.stringify(msg)); } catch (e) { /* noop */ }
  if (API !== null && (msg.type === 'detection' || msg.type === 'control')) {
    fetch(API + '/api/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(msg) })
      .then(r => r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)))
      .then(j => markMonitors(j.monitors))
      .catch(err => { addLog('전송 실패 · ' + err.message); render(); });
  }
}
function markMonitors(n) { if (n > 0) { const was = isOnline(); state.lastPong = Date.now(); if (!was) render(); } }
function onBus(m) {
  if (!m || m._from !== 'monitor' || seen.includes(m._id)) return;
  seen.push(m._id); if (seen.length > 40) seen.shift();
  if (m.type === 'pong') { const was = isOnline(); state.lastPong = Date.now(); if (!was) render(); }
}
const isOnline = () => Date.now() - state.lastPong < 4000;
function fire(p) {
  const c = cat(p.label);
  const msg = {
    type: 'detection', timestamp: new Date().toISOString(), sound_label: c.label, sound_name: c.ko,
    confidence: p.conf / 100, severity: p.sev === 'auto' ? c.lv : p.sev,
    direction_deg: p.deg, direction_valid: p.dirValid, intensity: p.intensity, ack: p.ack
  };
  if (p.motorMode === 'manual') msg.motors = IDS.map(id => ({ id, active: !!p.manual[id], intensity: p.manual[id] ? p.intensity : 0 }));
  bus(msg);
  addLog(c.ko + ' · ' + dirText(p) + ' · ' + motorText(p));
  clearTimeout(flashT);
  setState({ flashId: p.id });
  flashT = setTimeout(() => setState({ flashId: null }), 450);
}
function control(action) { bus({ type: 'control', action }); addLog(action === 'idle' ? '대기 화면으로 전환' : '대시보드 기록 초기화'); render(); }

// ── 템플릿 ──
const seg = (opts, value, act) => `<div class="seg">${opts.map(o => `<button class="${String(o[0]) === String(value) ? 'on' : ''}" data-act="${act}" data-arg="${o[0]}">${o[1]}</button>`).join('')}</div>`;
function render() {
  const s = state, p = sel(), selIdx = s.presets.indexOf(p), selC = cat(p.label);
  const online = isOnline();
  const near = Math.round(p.deg / 45) % 8 * 45;
  app.innerHTML = `<header class="hdr">
    <div class="logo"><div class="logo-box"><img src="assets/miimo.png" alt="miimo"></div>
      <div><div class="logo-t">miimo <span>Remote</span></div><div class="logo-s">대시보드 실시간 조작</div></div></div>
    <div class="grow"></div>
    <div class="link-st ${online ? 'on' : 'off'}"><span class="dot" style="background:${online ? '#22C39A' : '#E08A0B'}"></span>${online ? '대시보드 연결됨' : '대시보드 응답 없음 · 대시보드 페이지를 열어 주세요'}</div>
    <a class="pill-link" href="monitor.html" target="_blank"><span class="ms">space_dashboard</span>대시보드 열기</a>
  </header>
  <main>
    <div class="left">
      <section class="card">
        <div class="card-h"><span class="h2">원터치 버튼</span><span class="hint">누르면 대시보드에 바로 표시돼요 · 숫자 키 1–9</span></div>
        <div class="presets">
          ${s.presets.map((q, i) => { const c = cat(q.label), S = SEV[q.sev === 'auto' ? c.lv : q.sev], isSel = q.id === p.id, flash = q.id === s.flashId;
            return `<div class="pwrap">
              <button class="preset${isSel ? ' sel' : ''}" data-act="fire" data-arg="${q.id}" style="${flash ? `border-color:${S.fg};background:${S.bg}` : ''}">
                <span class="p-top"><span class="p-ico" style="background:${S.bg}"><i style="background-image:url(${c.img})"></i></span>${i < 9 ? `<span class="p-key">${i + 1}</span>` : ''}</span>
                <span class="p-name">${c.ko}</span>
                <span class="p-dir"><span class="ms" style="color:${S.tx};transform:rotate(${q.deg}deg);opacity:${q.dirValid ? 1 : 0.25}">navigation</span>${dirText(q)}</span>
                <span class="p-tags"><span class="sev" style="background:${S.bg};color:${S.tx}">${S.ko}</span><span class="mot">${motorText(q)}</span></span>
              </button>
              <button class="edit${isSel ? ' sel' : ''}" title="이 버튼 설정" data-act="edit" data-arg="${q.id}"><span class="ms">tune</span></button>
            </div>`; }).join('')}
          <button class="add" data-act="add"><span class="ms">add</span>버튼 추가</button>
        </div>
      </section>
      <section class="card" style="padding:20px 24px">
        <div class="log-h"><span class="h2 sm">보낸 신호</span><div class="grow"></div>
          <button class="btn" data-act="idle"><span class="ms">hearing</span>대기 화면으로</button>
          <button class="btn" data-act="resetMon"><span class="ms">restart_alt</span>기록 초기화</button></div>
        ${s.log.map(l => `<div class="log-row"><b>${l.time}</b><span>${l.text}</span></div>`).join('')}
        ${s.log.length ? '' : '<div class="log-empty">아직 보낸 신호가 없어요</div>'}
      </section>
    </div>

    <section class="card editor">
      <div class="ed-h"><span class="h2">버튼 설정</span><span class="ed-tag">버튼 ${selIdx + 1} · ${selC.ko}</span><span class="hint sm" style="margin-left:auto">바꾸면 자동 저장</span></div>
      <div><div class="lbl" style="margin-bottom:10px">소리 종류</div>
        <div class="tiles">${CAT.map(c => `<button class="tile${c.label === p.label ? ' on' : ''}" data-act="sound" data-arg="${c.label}"><i style="background-image:url(${c.img})"></i><span>${c.ko}</span></button>`).join('')}</div></div>
      <div class="dir-wrap">
        <div class="dir-grid">${CELLS.map(c => { const center = c[0] == null, on = !center && p.dirValid && c[0] === near;
          return `<button class="${center ? 'c' : on ? 'on' : ''}"${center ? '' : ` data-act="dir" data-arg="${c[0]}"`}>${c[1]}</button>`; }).join('')}</div>
        <div class="dir-r">
          <div class="vals"><span class="lbl" style="margin:0">방향</span><span class="n" id="degText">${p.deg}°</span><span class="d" id="dirName">${dirName(p.deg)}</span></div>
          <input type="range" min="0" max="359" value="${p.deg}" id="deg">
          <div class="note">0° = 착용자 정면 · 시계 방향</div>
          <button class="tog" data-act="toggleValid"><span>방향 추정 유효 <i>· 끄면 ‘방향 확인 중’</i></span><span class="sw${p.dirValid ? ' on' : ''}"></span></button>
        </div>
      </div>
      <div class="wrap">
        <div><div class="lbl">위험도</div>${seg([['auto', '자동 (' + SEV[selC.lv].ko + ')'], ['danger', '긴급'], ['caution', '주의'], ['info', '정보']], p.sev, 'sev')}</div>
        <div><div class="lbl">진동 강도</div>${seg([[0.4, '약 40%'], [0.8, '중 80%'], [1, '강 100%']], p.intensity, 'int')}</div>
      </div>
      <div>
        <div class="vals"><span class="lbl" style="margin:0">신뢰도</span><span class="n sm" id="confText">${p.conf}%</span></div>
        <input type="range" min="50" max="99" value="${p.conf}" id="conf">
      </div>
      <div><div class="lbl">진동 모듈</div>
        <div style="display:flex;flex-wrap:wrap;align-items:center;gap:10px">${seg([['auto', '자동 (방향 매핑)'], ['manual', '직접 선택']], p.motorMode, 'motorMode')}
          <div class="mbtns" style="opacity:${p.motorMode === 'manual' ? 1 : 0.35}">${IDS.map(id => `<button class="${p.manual[id] ? 'on' : ''}" data-act="manual" data-arg="${id}">${id}</button>`).join('')}</div></div>
        <button class="tog" style="margin-top:8px" data-act="toggleAck"><span>진동 확인 신호 <i>· 끄면 ‘명령 전송됨’에서 멈춤</i></span><span class="sw${p.ack ? ' on' : ''}"></span></button>
      </div>
      <div class="actions">
        <button class="btn primary" data-act="fireSel"><span class="ms">bolt</span>이 설정으로 보내기</button>
        <button class="btn danger" data-act="remove" style="opacity:${s.presets.length > 1 ? 1 : 0.4}"><span class="ms">delete</span>버튼 삭제</button>
      </div>
    </section>
  </main>`;
}

// ── 이벤트 ──
const ACT = {
  fire: a => fire(state.presets.find(p => p.id === a)),
  edit: a => setState({ selId: a }),
  add: () => { const p = mk('car_horn', 0); state.presets = state.presets.concat([p]); save(); setState({ selId: p.id }); },
  idle: () => control('idle'),
  resetMon: () => control('reset'),
  sound: a => patch({ label: a }),
  dir: a => patch({ deg: +a, dirValid: true }),
  toggleValid: () => patch({ dirValid: !sel().dirValid }),
  sev: a => patch({ sev: a }),
  int: a => patch({ intensity: +a }),
  motorMode: a => patch({ motorMode: a }),
  manual: a => patch({ motorMode: 'manual', manual: Object.assign({}, sel().manual, { [a]: !sel().manual[a] }) }),
  toggleAck: () => patch({ ack: !sel().ack }),
  fireSel: () => fire(sel()),
  remove: () => {
    if (state.presets.length <= 1) return;
    const idx = state.presets.indexOf(sel());
    state.presets = state.presets.filter(p => p.id !== sel().id); save();
    setState({ selId: state.presets[Math.min(idx, state.presets.length - 1)].id });
  }
};
app.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const fn = ACT[el.dataset.act];
  if (fn) fn(el.dataset.arg);
});
app.addEventListener('input', e => {
  const el = e.target;
  if (el.id === 'deg') { sel().deg = +el.value; document.getElementById('degText').textContent = el.value + '°'; document.getElementById('dirName').textContent = dirName(+el.value); }
  else if (el.id === 'conf') { sel().conf = +el.value; document.getElementById('confText').textContent = el.value + '%'; }
});
app.addEventListener('change', e => {
  if (e.target.id === 'deg') patch({ deg: +e.target.value });
  else if (e.target.id === 'conf') patch({ conf: +e.target.value });
});
window.addEventListener('keydown', e => {
  const t = e.target && e.target.tagName;
  if (t === 'INPUT' || t === 'SELECT' || t === 'TEXTAREA' || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key >= '1' && e.key <= '9') { const p = state.presets[+e.key - 1]; if (p) fire(p); }
  else if (e.key === '0' || e.key === 'Escape') control('idle');
});

// ── 시작 ──
function init() {
  let presets = null;
  try { const raw = JSON.parse(localStorage.getItem(KEY)); if (Array.isArray(raw) && raw.length) presets = raw; } catch (e) { /* noop */ }
  if (!presets) presets = defaults();
  state.presets = presets; state.selId = presets[0].id;
  try { bc = new BroadcastChannel('miimo-remote'); bc.onmessage = e => onBus(e.data); } catch (e) { /* noop */ }
  window.addEventListener('storage', e => { if (e.key === 'miimo-remote-bus' && e.newValue) { try { onBus(JSON.parse(e.newValue)); } catch (err) { /* noop */ } } });
  bus({ type: 'ping' });
  // 재렌더는 연결 상태가 바뀔 때만 (슬라이더 드래그 중 끊김 방지)
  let was = isOnline();
  setInterval(() => {
    bus({ type: 'ping' });
    if (API !== null) fetch(API + '/api/status').then(r => r.json()).then(j => markMonitors(j.monitors)).catch(() => { /* 서버 응답 없음 → 4초 뒤 오프라인 표시 */ });
    const on = isOnline(); if (on !== was) { was = on; render(); }
  }, 1500);
  render();
}
init();
