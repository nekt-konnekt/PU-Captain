'use strict';
/* PU Captain client: offline-first. Every entry is written to IndexedDB first, then synced to /api/sync. */

// Optional: a coordinator's phone number. If set, an SOS sent with no signal also opens the SMS app pre-filled.
const SOS_SMS_NUMBER = '';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) => (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)));

const S = {
  session: null, online: navigator.onLine, syncing: false,
  voters: [], queue: [], war: null, lastSync: null,
  pvc: null, sent: null, issues: new Set(), filter: 'all',
  step: 'phone', screen: 'loginScreen', warTab: 'map', timers: []
};
const isCap = () => S.session?.user.role === 'captain';

/* ---------- IndexedDB ---------- */
let _db;
const db = () => (_db ||= new Promise((res, rej) => {
  const r = indexedDB.open('pucaptain', 1);
  r.onupgradeneeded = () => {
    const d = r.result;
    d.createObjectStore('queue', { keyPath: 'id' });
    d.createObjectStore('voters', { keyPath: 'id' });
    d.createObjectStore('meta');
  };
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
}));
async function run(store, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode);
    let out;
    const rq = fn(t.objectStore(store));
    if (rq) rq.onsuccess = () => { out = rq.result; };
    t.oncomplete = () => res(out);
    t.onerror = t.onabort = () => rej(t.error);
  });
}
const put = (s, v, k) => run(s, 'readwrite', (o) => (k === undefined ? o.put(v) : o.put(v, k)));
const get = (s, k) => run(s, 'readonly', (o) => o.get(k));
const del = (s, k) => run(s, 'readwrite', (o) => o.delete(k));
const all = (s) => run(s, 'readonly', (o) => o.getAll());

/* ---------- Helpers ---------- */
function toast(msg, type = '') {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast show ' + type;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 3200);
}
function ago(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'Just now';
  if (s < 3600) return Math.floor(s / 60) + ' min ago';
  if (s < 86400) return Math.floor(s / 3600) + ' hr ago';
  return Math.floor(s / 86400) + ' d ago';
}
const sameDay = (iso) => new Date(iso).toDateString() === new Date().toDateString();
function normPhone(p) {
  let d = String(p || '').replace(/\D/g, '');
  if (d.startsWith('234') && d.length === 13) d = '0' + d.slice(3);
  else if (d.length === 10 && !d.startsWith('0')) d = '0' + d;
  return d;
}
const validPhone = (d) => /^0[789][01]\d{8}$/.test(d);
function tokenExp(t) {
  try { return JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).exp; } catch { return 0; }
}
const ERR = {
  bad_phone: 'Enter a valid Nigerian mobile number', bad_request: 'Check the details and try again',
  too_many_requests: 'Too many attempts. Try again later', invalid_code: 'That code is wrong or expired',
  sms_failed: 'Could not send the SMS. Try again', forbidden: 'Your role cannot do that', server_error: 'Server problem. Try again'
};
const errMsg = (e) => (e?.offline ? 'No connection' : ERR[e?.code] || 'Something went wrong');

/* ---------- API ---------- */
async function api(path, { method = 'GET', body, auth = true } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (auth && S.session) headers.Authorization = 'Bearer ' + S.session.token;
  let r;
  try {
    r = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch {
    setOnline(false);
    throw { offline: true };
  }
  setOnline(true);
  let data = null;
  try { data = await r.json(); } catch { /* empty body */ }
  if (r.status === 401 && auth) sessionExpired();
  if (!r.ok) throw { status: r.status, code: data?.error };
  return data;
}

/* ---------- Status ---------- */
function setOnline(v) {
  if (S.online === v) return;
  S.online = v;
  renderStatus();
  if (v) syncNow();
}
function renderStatus() {
  const pending = S.queue.filter((q) => q.status === 'pending').length;
  $('statusDot').className = 'status-dot ' + (S.syncing ? 'syncing' : S.online ? 'online' : 'offline');
  $('statusText').textContent = S.syncing ? 'Syncing…' : S.online ? 'Online' : 'Offline • saved on device';
  $('syncCount').textContent = pending + ' pending';
  const b = $('syncBadge');
  b.textContent = pending;
  b.classList.toggle('hidden', !pending || !isCap());
  const d = new Date();
  $('clock').textContent = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

/* ---------- Data loading ---------- */
async function loadLocal() {
  const uid = S.session.user.id;
  S.queue = (await all('queue')).filter((q) => q.owner === uid).sort((a, b) => a.created.localeCompare(b.created));
  if (isCap()) S.voters = (await all('voters')).filter((v) => v.owner === uid).sort((a, b) => b.ts.localeCompare(a.ts));
  const ls = await get('meta', 'lastSync:' + uid);
  S.lastSync = ls || null;
}
async function refreshVoters() {
  if (!S.session || !navigator.onLine) return;
  try {
    const r = await api('/api/voters?limit=200');
    const list = r.voters.map((v) => ({ id: v.id, name: v.full_name, last4: v.phone_last4, pvc: v.pvc_status, sent: v.sentiment, issues: v.issues || [], ts: v.client_created_at, synced: true }));
    if (isCap()) {
      const uid = S.session.user.id;
      const ids = new Set(list.map((v) => v.id));
      for (const e of await all('voters')) if (e.owner === uid && e.synced && !ids.has(e.id)) await del('voters', e.id);
      for (const v of list) await put('voters', { ...v, owner: uid });
      await loadLocal();
    } else {
      S.voters = list;
    }
    renderAll();
  } catch { /* offline or error: keep what we have */ }
}
async function loadWar() {
  if (isCap() || !S.session) return;
  const key = 'war:' + S.session.user.id;
  if (navigator.onLine) {
    try {
      const data = await api('/api/warroom');
      S.war = { data, at: new Date().toISOString() };
      await put('meta', S.war, key);
    } catch { /* fall through to cache */ }
  }
  if (!S.war) S.war = (await get('meta', key)) || null;
  renderAll();
}

/* ---------- Rendering ---------- */
function renderAll() {
  renderStatus();
  renderDash();
  if (S.screen === 'votersScreen') renderVoters();
  if (S.screen === 'syncScreen') renderSync();
  if (S.screen === 'warScreen') renderWar();
}
function setText(id, v) { $(id).textContent = v; }

function renderDash() {
  if (!S.session) return;
  const u = S.session.user;
  const h = new Date().getHours();
  setText('greeting', (h < 12 ? 'Good morning,' : h < 17 ? 'Good afternoon,' : 'Good evening,'));
  setText('userName', u.name);
  $('userMeta').innerHTML = isCap() ? `<span>📍 PU ${esc(u.pu || '—')}</span>` : `<span>${esc(u.role === 'admin' ? 'Admin' : 'Coordinator')}</span>`;
  const feed = $('activityFeed');
  if (isCap()) {
    const logged = S.voters.length;
    const has = S.voters.filter((v) => v.pvc === 'has').length;
    const failed = S.queue.filter((q) => q.status === 'failed').length;
    setText('statLogged', logged); setText('statLoggedSub', `${S.voters.filter((v) => sameDay(v.ts)).length} today`);
    setText('statPVC', has); setText('statPVCSub', logged ? Math.round((has / logged) * 100) + '% of logged' : '');
    setText('statPending', logged - has); setText('statPendingSub', logged - has ? 'Needs follow-up' : '');
    setText('stat4Icon', '📡'); setText('stat4Label', 'Pending Sync');
    setText('statSync', S.queue.length); setText('stat4Sub', failed ? failed + ' failed' : S.queue.length ? 'In queue' : 'Up to date');
    setText('activityTitle', 'Recent Activity');
    const rows = S.voters.slice(0, 5);
    feed.innerHTML = rows.length ? rows.map((v) => `<div class="activity-item"><div class="activity-dot ${v.synced ? 'blue' : 'yellow'}"></div><div class="activity-content"><div class="activity-text"><strong>${esc(v.name)}</strong> — ${esc(pvcLabel(v.pvc))}, ${esc(v.sent)}</div><div class="activity-time">${ago(v.ts)} • ${v.synced ? 'Synced' : 'Saved on device'}</div></div></div>`).join('') : '<div class="empty">No voters logged yet.<br>Tap “Log Voter” to start.</div>';
  } else {
    const t = S.war?.data.totals;
    setText('statLogged', t?.logged ?? '—'); setText('statLoggedSub', '');
    setText('statPVC', t?.has_pvc ?? '—'); setText('statPVCSub', t ? t.pvcRate + '% PVC rate' : '');
    setText('statPending', t?.no_pvc ?? '—'); setText('statPendingSub', '');
    setText('stat4Icon', '🚨'); setText('stat4Label', 'Open Incidents');
    setText('statSync', S.war ? S.war.data.openIncidents.length : '—'); setText('stat4Sub', '');
    setText('activityTitle', 'Open Incidents');
    const rows = S.war?.data.openIncidents.slice(0, 5) || [];
    feed.innerHTML = rows.length ? rows.map((i) => `<div class="activity-item"><div class="activity-dot red"></div><div class="activity-content"><div class="activity-text"><strong>PU ${esc(i.pu_code)}</strong> — ${esc(i.type)} (${esc(i.severity)})</div><div class="activity-time">${ago(i.created_at)}</div></div></div>`).join('') : '<div class="empty">No open incidents.</div>';
  }
}
const pvcLabel = (p) => ({ has: 'Has PVC', no: 'No PVC', registered: 'Registered', lost: 'Lost/Damaged' }[p] || p);

function filteredVoters() {
  const f = S.filter;
  return S.voters.filter((v) => f === 'all' || (f === 'pvc' && v.pvc === 'has') || (f === 'nopvc' && v.pvc !== 'has') || (f === 'support' && v.sent === 'support') || (f === 'undecided' && v.sent === 'undecided'));
}
function renderVoters() {
  setText('chipAll', `All (${S.voters.length})`);
  document.querySelectorAll('#filterBar .filter-chip').forEach((c) => c.classList.toggle('active', c.dataset.val === S.filter));
  const list = filteredVoters();
  $('votersList').innerHTML = list.length ? list.map((v) => {
    const initials = v.name.split(/\s+/).map((n) => n[0]).join('').slice(0, 2).toUpperCase();
    const color = v.sent === 'support' ? 'green' : v.sent === 'oppose' ? 'red' : 'yellow';
    const badge = v.pvc === 'has' ? '<span class="voter-badge badge-pvc">✅ PVC</span>' : v.pvc === 'no' ? '<span class="voter-badge badge-nopvc">❌ No PVC</span>' : `<span class="voter-badge badge-pending">⏳ ${esc(pvcLabel(v.pvc))}</span>`;
    const emoji = v.sent === 'support' ? '💚' : v.sent === 'oppose' ? '💔' : '🤔';
    return `<div class="voter-card"><div class="voter-avatar ${color}">${esc(initials)}</div><div class="voter-info"><div class="voter-name">${esc(v.name)} ${emoji}</div><div class="voter-meta">${badge}${v.last4 ? `<span>📞 ••••${esc(v.last4)}</span>` : ''}<span>🕐 ${ago(v.ts)}</span><span>${v.synced ? '☁️ Synced' : '💾 On device'}</span></div>${v.issues?.length ? `<div class="tag-row">${v.issues.map((t) => `<span>${esc(t)}</span>`).join('')}</div>` : ''}</div>${isCap() ? `<button class="mini-btn" data-act="erase" data-id="${esc(v.id)}">Remove</button>` : ''}</div>`;
  }).join('') : `<div class="empty">${S.voters.length ? 'No voters match this filter.' : isCap() ? 'No voters yet.' : navigator.onLine ? 'No voters in your area yet.' : 'Connect to the internet to load voters.'}</div>`;
}

function renderSync() {
  const pending = S.queue.filter((q) => q.status === 'pending').length;
  $('syncHeader').classList.toggle('syncing', S.syncing);
  setText('syncStatusText', S.syncing ? 'Syncing…' : pending ? `${pending} item${pending > 1 ? 's' : ''} pending` : 'All synced');
  setText('syncSub', S.lastSync ? 'Last sync: ' + new Date(S.lastSync).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Not synced yet');
  $('syncQueue').innerHTML = S.queue.length ? S.queue.map((q) => `<div class="queue-item"><div class="queue-icon">${q.kind === 'voter' ? '📝' : '🆘'}</div><div class="queue-info"><div class="queue-title">${q.kind === 'voter' ? 'Voter: ' + esc(q.payload.full_name) : 'SOS alert'}</div><div class="queue-meta">${ago(q.created)}${q.status === 'failed' ? ' • rejected: ' + esc(q.error) : ''}</div></div>${q.status === 'failed' ? `<button class="mini-btn" data-act="discard" data-id="${esc(q.id)}">Discard</button>` : '<div class="queue-status pending">Pending</div>'}</div>`).join('') : '<div class="empty">Nothing waiting. Everything is synced.</div>';
}

const SEV = { sos: ['🚨', 'var(--red-bg)'], high: ['🚨', 'var(--red-bg)'], medium: ['⚠️', 'var(--yellow-bg)'], low: ['📊', 'var(--blue-bg)'] };
function renderWar() {
  const w = S.war?.data;
  if (!w) { $('mapGrid').innerHTML = ''; $('warAlerts').innerHTML = ''; $('warUpdated').textContent = navigator.onLine ? 'Loading…' : 'Connect once to load the War Room.'; return; }
  const lgas = [...new Set(w.units.map((u) => u.lga).filter(Boolean))];
  setText('warScope', lgas.length === 1 ? lgas[0] : lgas.length + ' LGAs');
  setText('warUnits', w.units.length + ' PUs');
  $('mapGrid').innerHTML = w.units.length ? w.units.map((u) => `<div class="map-cell ${esc(u.status)}" title="${esc(u.code)}: ${u.logged} logged"></div>`).join('') : '<div class="empty" style="grid-column:1/-1">No polling units in your scope.</div>';
  $('warAlerts').innerHTML = w.openIncidents.length ? w.openIncidents.map((i) => { const [ic, bg] = SEV[i.severity] || SEV.low; return `<div class="alert-card"><div class="alert-icon" style="background:${bg}">${ic}</div><div class="alert-content"><div class="alert-title">${esc(i.type.replace('_', ' '))} — PU ${esc(i.pu_code)}</div><div class="alert-desc">${esc(i.description || 'No details')}</div><div class="alert-time">${ago(i.created_at)} • ${esc(i.lga || '')}</div></div><button class="mini-btn" data-act="resolve" data-id="${esc(i.id)}">Resolve</button></div>`; }).join('') : '<div class="empty">No open incidents. 🎉</div>';
  const t = w.totals;
  setText('wLogged', t.logged); setText('wPvc', t.pvcRate + '%'); setText('wSupport', t.supportRate + '%'); setText('wInc', w.openIncidents.length);
  $('issueBars').innerHTML = w.topIssues.length ? w.topIssues.map((i) => { const pct = t.logged ? Math.round((i.n / t.logged) * 100) : 0; return `<div class="bar-row"><span>${esc(i.issue)}</span><strong>${pct}%</strong></div><div class="bar"><div style="width:${pct}%"></div></div>`; }).join('') : '<div class="empty">No issues recorded yet.</div>';
  setText('warUpdated', 'Updated ' + ago(S.war.at) + (navigator.onLine ? '' : ' (offline copy)'));
}

/* ---------- Navigation ---------- */
function showScreen(id) {
  S.screen = id;
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
  document.querySelectorAll('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.screen === id));
  window.scrollTo(0, 0);
  if (id === 'votersScreen') { renderVoters(); refreshVoters(); }
  if (id === 'syncScreen') renderSync();
  if (id === 'warScreen') { renderWar(); loadWar(); }
}
function applyRole() {
  document.querySelectorAll('[data-role="cap"]').forEach((e) => e.classList.toggle('hidden', !isCap()));
  document.querySelectorAll('[data-role="lead"]').forEach((e) => e.classList.toggle('hidden', isCap()));
}

/* ---------- Auth ---------- */
function setBusy(b) { $('loginBtn').disabled = b; }
async function doLogin() {
  const phone = normPhone($('loginPhone').value);
  if (!validPhone(phone)) return toast(ERR.bad_phone, 'error');
  if (!navigator.onLine) return toast('You need a connection to sign in', 'error');
  setBusy(true);
  try {
    if (S.step === 'phone') {
      const r = await api('/api/auth/request-otp', { method: 'POST', body: { phone }, auth: false });
      S.step = 'code';
      $('codeGroup').classList.remove('hidden');
      $('loginBtn').textContent = 'Verify & enter';
      setText('loginNote', 'Enter the 6-digit code we sent by SMS.');
      $('loginCode').focus();
      if (r.devCode) toast('Dev code: ' + r.devCode, 'success');
    } else {
      const code = $('loginCode').value.trim();
      if (!/^\d{6}$/.test(code)) return toast('Enter the 6-digit code', 'error');
      const r = await api('/api/auth/verify-otp', { method: 'POST', body: { phone, code }, auth: false });
      S.session = { token: r.token, user: r.user, exp: tokenExp(r.token) };
      localStorage.setItem('pu_session', JSON.stringify(S.session));
      $('loginCode').value = '';
      await enterApp();
    }
  } catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(false); }
}
function resetLogin() {
  S.step = 'phone';
  $('codeGroup').classList.add('hidden');
  $('loginBtn').textContent = 'Send code';
  setText('loginNote', 'Only registered captains and coordinators can sign in.');
}
function sessionExpired() {
  if (!S.session) return;
  stopTimers();
  S.session = null;
  localStorage.removeItem('pu_session');
  $('bottomNav').classList.add('hidden');
  resetLogin();
  showScreen('loginScreen');
  toast('Session expired. Sign in again; your saved entries are kept.', 'error');
}
function logout() {
  const pending = S.queue.length;
  if (pending && !confirm(`${pending} entr${pending > 1 ? 'ies are' : 'y is'} not synced yet. They stay on this device and sync after you sign in again. Sign out?`)) return;
  stopTimers();
  S.session = null; S.voters = []; S.queue = []; S.war = null;
  localStorage.removeItem('pu_session');
  $('bottomNav').classList.add('hidden');
  resetLogin();
  showScreen('loginScreen');
}
async function enterApp() {
  applyRole();
  $('bottomNav').classList.remove('hidden');
  await loadLocal();
  showScreen('dashScreen');
  renderAll();
  startTimers();
  syncNow();
  refreshVoters();
  loadWar();
}
function startTimers() {
  stopTimers();
  S.timers.push(setInterval(renderStatus, 30000), setInterval(() => syncNow(), 30000));
}
function stopTimers() { S.timers.forEach(clearInterval); S.timers = []; }

/* ---------- Logging voters ---------- */
function clearForm() {
  $('voterName').value = ''; $('voterPhone').value = ''; $('consent').checked = false;
  S.pvc = null; S.sent = null; S.issues.clear();
  document.querySelectorAll('.pvc-option,.sentiment-option,.issue-tag').forEach((e) => e.classList.remove('selected'));
}
async function saveVoter() {
  const name = $('voterName').value.replace(/\s+/g, ' ').trim();
  const rawPhone = $('voterPhone').value.trim();
  const phone = rawPhone ? normPhone(rawPhone) : '';
  if (name.length < 2) return toast('Enter the voter name', 'error');
  if (!S.pvc) return toast('Select PVC status', 'error');
  if (phone && !validPhone(phone)) return toast('Phone number looks wrong', 'error');
  if (!$('consent').checked) return toast('Confirm the voter agreed', 'error');
  const id = uuid(), now = new Date().toISOString(), uid = S.session.user.id;
  const payload = { id, full_name: name, phone: phone || undefined, pvc_status: S.pvc, sentiment: S.sent || 'undecided', issues: [...S.issues], consent_given: true, consent_at: now, client_created_at: now };
  await put('queue', { id, kind: 'voter', owner: uid, payload, created: now, status: 'pending' });
  await put('voters', { id, owner: uid, name, last4: phone ? phone.slice(-4) : null, pvc: S.pvc, sent: payload.sentiment, issues: payload.issues, ts: now, synced: false });
  clearForm();
  await loadLocal();
  renderAll();
  setText('successDesc', navigator.onLine ? 'Saved. Syncing now.' : 'Saved on this device. It will sync when you have signal.');
  $('successOverlay').classList.add('active');
  syncNow();
}
async function erase(id) {
  if (!confirm('Remove this voter record?')) return;
  if (S.queue.find((q) => q.id === id)) {
    await del('queue', id); await del('voters', id);
  } else {
    if (!navigator.onLine) return toast('Connect to remove synced records', 'error');
    try { await api('/api/voters?id=' + encodeURIComponent(id), { method: 'DELETE' }); await del('voters', id); } catch (e) { return toast(errMsg(e), 'error'); }
  }
  await loadLocal(); renderAll(); toast('Removed', 'success');
}

/* ---------- Sync ---------- */
async function syncNow(manual = false) {
  if (S.syncing || !S.session || !isCap()) return;
  if (!navigator.onLine) { if (manual) toast('No network. Entries stay on this device.', 'error'); return; }
  await loadLocal();
  const items = S.queue.filter((q) => q.status === 'pending');
  if (!items.length) { if (manual) toast('Nothing to sync', 'success'); return; }
  S.syncing = true; renderAll();
  let ok = true;
  try {
    for (let i = 0; i < items.length; i += 50) {
      const batch = items.slice(i, i + 50);
      const r = await api('/api/sync', { method: 'POST', body: { voters: batch.filter((q) => q.kind === 'voter').map((q) => q.payload), incidents: batch.filter((q) => q.kind === 'incident').map((q) => q.payload) } });
      const acked = new Set([...r.ackedVoters, ...r.ackedIncidents]);
      for (const q of batch) {
        if (!acked.has(q.id)) continue;
        await del('queue', q.id);
        if (q.kind === 'voter') { const v = await get('voters', q.id); if (v) await put('voters', { ...v, synced: true }); }
      }
      for (const rej of r.rejected) {
        const q = batch.find((x) => x.id === rej.id);
        if (q) await put('queue', { ...q, status: 'failed', error: rej.error });
      }
    }
    S.lastSync = new Date().toISOString();
    await put('meta', S.lastSync, 'lastSync:' + S.session.user.id);
  } catch (e) {
    ok = false;
    if (manual) toast(errMsg(e), 'error');
  } finally {
    S.syncing = false;
    await loadLocal();
    renderAll();
  }
  if (ok && manual) toast('Synced ✓', 'success');
  if ('serviceWorker' in navigator && !ok) navigator.serviceWorker.ready.then((r) => r.sync?.register('pu-sync')).catch(() => {});
}

/* ---------- SOS ---------- */
function getPos() {
  return new Promise((res) => {
    if (!navigator.geolocation) return res(null);
    navigator.geolocation.getCurrentPosition((p) => res({ lat: p.coords.latitude, lng: p.coords.longitude }), () => res(null), { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 });
  });
}
async function sendSOS() {
  $('panicOverlay').classList.remove('active');
  toast('Getting your location…');
  const pos = await getPos();
  const id = uuid(), now = new Date().toISOString();
  const payload = { id, type: 'other', severity: 'sos', description: 'SOS alert from polling unit captain', lat: pos?.lat ?? null, lng: pos?.lng ?? null, client_created_at: now };
  await put('queue', { id, kind: 'incident', owner: S.session.user.id, payload, created: now, status: 'pending' });
  await loadLocal(); renderAll();
  if (navigator.onLine) {
    await syncNow();
    toast(S.queue.some((q) => q.id === id) ? 'SOS saved. Will send as soon as the network allows.' : '🚨 SOS sent to your coordinators', S.queue.some((q) => q.id === id) ? 'error' : 'success');
  } else {
    toast('No signal: SOS is saved and will send when you reconnect.', 'error');
  }
  if (!navigator.onLine && SOS_SMS_NUMBER) {
    const where = pos ? ` Location: ${pos.lat.toFixed(5)},${pos.lng.toFixed(5)}` : '';
    window.location.href = `sms:${SOS_SMS_NUMBER}?body=${encodeURIComponent('SOS from PU ' + (S.session.user.pu || '') + '.' + where)}`;
  }
}

/* ---------- Events ---------- */
const actions = {
  login: () => doLogin(),
  logout: () => logout(),
  goto: (el) => showScreen(el.dataset.screen),
  nav: (el) => showScreen(el.dataset.screen),
  'pick-pvc': (el) => { S.pvc = el.dataset.val; document.querySelectorAll('.pvc-option').forEach((o) => o.classList.toggle('selected', o === el)); },
  'pick-sent': (el) => { S.sent = el.dataset.val; document.querySelectorAll('.sentiment-option').forEach((o) => o.classList.toggle('selected', o === el)); },
  'pick-issue': (el) => { const v = el.dataset.val; if (S.issues.has(v)) S.issues.delete(v); else S.issues.add(v); el.classList.toggle('selected', S.issues.has(v)); },
  'save-voter': () => saveVoter(),
  'success-close': () => { $('successOverlay').classList.remove('active'); showScreen('dashScreen'); },
  filter: (el) => { S.filter = el.dataset.val; renderVoters(); },
  erase: (el) => erase(el.dataset.id),
  'sync-now': () => syncNow(true),
  discard: async (el) => { await del('queue', el.dataset.id); await del('voters', el.dataset.id); await loadLocal(); renderAll(); },
  sos: () => {
    $('panicDesc').textContent = 'This sends an SOS with your GPS location to your coordinators. With no signal it is saved and sent the moment you reconnect.' + (SOS_SMS_NUMBER ? ' Your messaging app will also open so you can text it.' : '');
    $('panicOverlay').classList.add('active');
  },
  'sos-send': () => sendSOS(),
  'sos-cancel': () => $('panicOverlay').classList.remove('active'),
  'war-tab': (el) => {
    S.warTab = el.dataset.val;
    document.querySelectorAll('#warTabs .war-tab').forEach((t) => t.classList.toggle('active', t === el));
    $('warMap').classList.toggle('hidden', S.warTab !== 'map');
    $('warAlerts').classList.toggle('hidden', S.warTab !== 'alerts');
    $('warStats').classList.toggle('hidden', S.warTab !== 'stats');
  },
  resolve: async (el) => {
    try { await api('/api/incidents', { method: 'PATCH', body: { id: el.dataset.id } }); toast('Marked resolved', 'success'); loadWar(); } catch (e) { toast(errMsg(e), 'error'); }
  }
};
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (el && actions[el.dataset.act]) actions[el.dataset.act](el);
});
$('loginPhone').addEventListener('input', () => { if (S.step === 'code') resetLogin(); });
['loginPhone', 'loginCode'].forEach((id) => $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); }));
window.addEventListener('online', () => setOnline(true));
window.addEventListener('offline', () => setOnline(false));
document.addEventListener('visibilitychange', () => { if (!document.hidden) { renderStatus(); syncNow(); } });

/* ---------- Boot ---------- */
(async function boot() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
    navigator.serviceWorker.addEventListener('message', (e) => { if (e.data?.type === 'sync') syncNow(); });
  }
  renderStatus();
  try {
    const s = JSON.parse(localStorage.getItem('pu_session') || 'null');
    if (s && s.exp * 1000 > Date.now()) { S.session = s; await enterApp(); }
  } catch { localStorage.removeItem('pu_session'); }
})();
