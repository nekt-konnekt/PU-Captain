import { JSDOM } from 'jsdom';
import { IDBFactory } from 'fake-indexeddb';
import fs from 'node:fs';
import assert from 'node:assert/strict';

const root = new URL('../', import.meta.url).pathname;
const html = fs.readFileSync(root + 'index.html', 'utf8').replace(/<script[^>]*><\/script>/, '');
const js = fs.readFileSync(root + 'app.js', 'utf8');
const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://pu.test/', pretendToBeVisual: true });
const w = dom.window;
w.indexedDB = new IDBFactory();
w.scrollTo = () => {};
w.confirm = () => true;
let online = true;
Object.defineProperty(w.navigator, 'onLine', { get: () => online });
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const token = `${b64({ alg: 'HS256' })}.${b64({ sub: 'u1', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
const server = { voters: [], incidents: [], calls: [] };
w.fetch = async (url, o = {}) => {
  server.calls.push(url);
  if (!online) throw new TypeError('network');
  const body = o.body ? JSON.parse(o.body) : null;
  const res = (s, d) => ({ ok: s < 400, status: s, json: async () => d });
  if (url === '/api/auth/request-otp') return res(200, { ok: true, devCode: '123456' });
  if (url === '/api/auth/verify-otp') return body.code === '123456' ? res(200, { token, user: { id: 'u1', name: 'Test Captain', role: 'captain', pu: 'SYN/1' } }) : res(401, { error: 'invalid_code' });
  if (url === '/api/sync') {
    assert.equal(o.headers.Authorization, 'Bearer ' + token);
    server.voters.push(...body.voters); server.incidents.push(...body.incidents);
    return res(200, { ackedVoters: body.voters.map((v) => v.id), ackedIncidents: body.incidents.map((i) => i.id), rejected: [] });
  }
  if (url.startsWith('/api/voters')) return res(200, { voters: server.voters.map((v) => ({ id: v.id, full_name: v.full_name, phone_last4: v.phone ? v.phone.slice(-4) : null, pvc_status: v.pvc_status, sentiment: v.sentiment, issues: v.issues, client_created_at: v.client_created_at })) });
  return res(404, {});
};
w.eval(js);
const $ = (id) => w.document.getElementById(id);
const click = (el) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clickAct = (act, val) => click(w.document.querySelector(`[data-act="${act}"]${val ? `[data-val="${val}"]` : ''}`));

// login
assert.ok($('loginScreen').classList.contains('active'));
$('loginPhone').value = '0803 456 7890'; clickAct('login'); await sleep(50);
assert.ok(!$('codeGroup').classList.contains('hidden'));
$('loginCode').value = '000000'; clickAct('login'); await sleep(50);
assert.ok($('loginScreen').classList.contains('active'), 'wrong code must not log in');
$('loginCode').value = '123456'; clickAct('login'); await sleep(100);
assert.ok($('dashScreen').classList.contains('active'));
assert.equal($('userName').textContent, 'Test Captain');
assert.ok(!$('bottomNav').classList.contains('hidden'));

// go offline, log a voter with an XSS-ish name
online = false; w.dispatchEvent(new w.Event('offline'));
clickAct('goto'); // first goto
click(w.document.querySelector('[data-act="goto"][data-screen="logScreen"]'));
$('voterName').value = '<img src=x onerror=alert(1)> Ada'; clickAct('pick-pvc', 'has'); clickAct('pick-sent', 'support');
clickAct('pick-issue', 'Jobs');
clickAct('save-voter'); await sleep(50);
assert.ok(!$('successOverlay').classList.contains('active'), 'consent required');
$('consent').checked = true; $('voterPhone').value = '08034567890';
clickAct('save-voter'); await sleep(100);
assert.ok($('successOverlay').classList.contains('active'));
assert.equal($('statLogged').textContent, '1');
assert.equal($('statSync').textContent, '1');
assert.equal(server.voters.length, 0, 'nothing sent while offline');
clickAct('success-close');
click(w.document.querySelector('[data-act="goto"][data-screen="votersScreen"]')); await sleep(50);
assert.ok(!$('votersList').querySelector('img'), 'names must be escaped');
assert.ok($('votersList').textContent.includes('On device'));

// back online: syncs
online = true; w.dispatchEvent(new w.Event('online')); await sleep(300);
assert.equal(server.voters.length, 1);
assert.equal(server.voters[0].phone, '08034567890');
assert.equal($('statSync').textContent, '0');
// idempotent: no resend
const n = server.voters.length; clickAct('sync-now'); await sleep(100); assert.equal(server.voters.length, n);

// SOS offline then online
online = false; w.dispatchEvent(new w.Event('offline'));
w.navigator.geolocation = undefined;
clickAct('sos'); assert.ok($('panicOverlay').classList.contains('active'));
clickAct('sos-send'); await sleep(100);
assert.equal($('statSync').textContent, '1');
online = true; w.dispatchEvent(new w.Event('online')); await sleep(300);
assert.equal(server.incidents.length, 1); assert.equal(server.incidents[0].severity, 'sos');
console.log('smoke test passed');
process.exit(0);
