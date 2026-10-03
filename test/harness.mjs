/**
 * Task Drop - functional harness
 *
 * Drives the real index.html in headless Chrome against a mock Apps Script,
 * exercising the capture flow, the button map, every transport fallback and the
 * offline queue. No npm dependencies: Node's built-in http plus CDP over the
 * global WebSocket (Node 22+).
 *
 *   node test/harness.mjs
 *
 * Exits non-zero on the first failed assertion.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATIC_PORT = 8111;
const MOCK_PORT = 8787;
const CDP_PORT = 9223;
const EXEC_URL = `http://127.0.0.1:${MOCK_PORT}/exec`;
const SHARED_KEY = 'test-key-abc123';

// ── Mock Apps Script ────────────────────────────────────────────────────────
// mode: 'ok' | 'postdrop' (POST connections killed) | 'badkey' | 'down'
let mode = 'ok';
const rows = [];

function cors(res, extra = {}) {
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    ...extra
  });
}

const mock = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${MOCK_PORT}`);

  if (mode === 'down') { req.socket.destroy(); return; }
  if (mode === 'postdrop' && req.method === 'POST') { req.socket.destroy(); return; }

  // Apps Script serves the real payload from a redirect target. Mirror that so
  // we are genuinely testing redirect: 'follow'.
  if (url.pathname === '/final') {
    cors(res);
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  const finish = (payload) => {
    if (payload.ok) {
      // 302 to the content, exactly like script.google.com -> googleusercontent.
      res.writeHead(302, {
        Location: '/final',
        'Access-Control-Allow-Origin': '*'
      });
      res.end();
    } else {
      cors(res);
      res.end(JSON.stringify(payload));
    }
  };

  const handle = (data) => {
    if (mode === 'badkey' || data.key !== SHARED_KEY) {
      finish({ ok: false, error: 'bad key' });
      return;
    }
    const note = String(data.note || '').trim();
    if (!note) { finish({ ok: false, error: 'empty note' }); return; }
    rows.push({ note, source: data.source, method: req.method, at: Date.now() });
    finish({ ok: true });
  };

  if (req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body) || {}; } catch { parsed = {}; }
      handle(parsed);
    });
    return;
  }

  handle({
    key: url.searchParams.get('key'),
    note: url.searchParams.get('note'),
    source: url.searchParams.get('source')
  });
});

// ── Static file server for the creation ─────────────────────────────────────
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const statics = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0].split('#')[0]).replace(/^\/+/, '') || 'index.html';
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('nope'); return;
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});

// ── CDP plumbing ────────────────────────────────────────────────────────────
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].find((p) => fs.existsSync(p));

let msgId = 0;
function rpc(ws, method, params = {}) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    const onMsg = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== id) return;
      ws.removeEventListener('message', onMsg);
      m.error ? reject(new Error(method + ': ' + m.error.message)) : resolve(m.result);
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evalIn(ws, expr) {
  const r = await rpc(ws, 'Runtime.evaluate', {
    expression: expr, returnByValue: true, awaitPromise: true
  });
  if (r.exceptionDetails) {
    throw new Error('page error: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  }
  return r.result.value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(ws, expr, label, timeout = 6000) {
  const t0 = Date.now();
  for (;;) {
    if (await evalIn(ws, `!!(${expr})`)) return;
    if (Date.now() - t0 > timeout) throw new Error(`timed out waiting for ${label}: ${expr}`);
    await sleep(60);
  }
}

// ── Injected R1 stubs ───────────────────────────────────────────────────────
// Backed by localStorage so the "close and reopen the app" test is honest.
const STUBS = `
window.__td = { spoken: [], voice: [] };
window.CreationVoiceHandler = {
  postMessage: function (m) { window.__td.voice.push(m); }
};
window.PluginMessageHandler = {
  postMessage: function (m) {
    try { window.__td.spoken.push(JSON.parse(m).message); } catch (e) {}
  }
};
function mkStore(prefix) {
  return {
    setItem: function (k, v) { localStorage.setItem(prefix + k, v); return Promise.resolve(); },
    getItem: function (k) { return Promise.resolve(localStorage.getItem(prefix + k)); },
    removeItem: function (k) { localStorage.removeItem(prefix + k); return Promise.resolve(); },
    clear: function () { return Promise.resolve(); }
  };
}
window.creationStorage = { secure: mkStore('__sec_'), plain: mkStore('__pln_') };
window.__fire = function (name) { window.dispatchEvent(new Event(name)); };
window.__screen = function () {
  var el = document.querySelector('.screen.visible');
  return el ? el.id.replace('screen-', '') : null;
};
window.__sel = function () {
  var el = document.querySelector('.act.sel');
  return el ? el.id.replace('act-', '') : null;
};
`;

// ── Assertions ──────────────────────────────────────────────────────────────
let pass = 0;
const fails = [];
function check(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fails.push(label); console.log(`  FAIL  ${label}${detail ? ' -> ' + detail : ''}`); }
}
function eq(label, actual, expected) {
  check(label, JSON.stringify(actual) === JSON.stringify(expected),
    `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

// ── The run ─────────────────────────────────────────────────────────────────
async function main() {
  if (!CHROME) throw new Error('No Chrome or Edge found.');

  await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));
  await new Promise((r) => statics.listen(STATIC_PORT, '127.0.0.1', r));

  const profile = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'td-'));
  const chrome = spawn(CHROME, [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    '--headless=new', '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--disable-extensions', '--window-size=240,282',
    'about:blank'
  ], { stdio: 'ignore' });

  // Wait for the debugger endpoint.
  let wsUrl = null;
  for (let i = 0; i < 100 && !wsUrl; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page');
      if (page) wsUrl = page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    if (!wsUrl) await sleep(150);
  }
  if (!wsUrl) throw new Error('Chrome debugger never came up.');

  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });

  await rpc(ws, 'Runtime.enable');
  await rpc(ws, 'Page.enable');
  await rpc(ws, 'Page.addScriptToEvaluateOnNewDocument', { source: STUBS });

  // A fragment-only navigate does not reload the document, so every open gets a
  // unique query string - otherwise '#cfg=...' would just be appended to the
  // page already on screen and boot() would never run again.
  let nav = 0;
  const open = async (hash = '') => {
    const url = `http://127.0.0.1:${STATIC_PORT}/index.html?n=${++nav}${hash}`;
    await rpc(ws, 'Page.navigate', { url });
    await sleep(500);
    await until(ws, 'window.__screen && window.__screen()', 'first paint');
  };

  // ── 1. First run shows setup ──────────────────────────────────────────────
  console.log('\n[1] First run / setup');
  await open();
  eq('opens on the setup screen', await evalIn(ws, '__screen()'), 'setup');

  const errHttp = await evalIn(ws, `(function(){
    document.getElementById('in-url').value = 'http://nope.example/exec';
    document.getElementById('in-key').value = 'x';
    __fire('sideClick');
    return document.getElementById('setup-err').textContent;
  })()`);
  check('rejects a non-https URL', errHttp.includes('https'), errHttp);

  const errExec = await evalIn(ws, `(function(){
    document.getElementById('in-url').value = 'https://script.google.com/macros/s/AK/dev';
    __fire('sideClick');
    return document.getElementById('setup-err').textContent;
  })()`);
  check('rejects a URL without /exec', errExec.includes('/exec'), errExec);

  await evalIn(ws, `(function(){
    document.getElementById('in-url').value = ${JSON.stringify(EXEC_URL)};
    document.getElementById('in-key').value = ${JSON.stringify(SHARED_KEY)};
    __fire('sideClick');
  })()`);
  await until(ws, `__screen() === 'idle'`, 'idle after save');
  eq('saves and lands on idle', await evalIn(ws, '__screen()'), 'idle');

  // ── 2. Capture flow ───────────────────────────────────────────────────────
  console.log('\n[2] Hold to talk -> review');
  await evalIn(ws, `__fire('longPressStart')`);
  eq('hold shows the listening screen', await evalIn(ws, '__screen()'), 'listen');
  eq('told the voice bridge to start', await evalIn(ws, '__td.voice'), ['start']);

  await evalIn(ws, `__fire('longPressEnd')`);
  eq('release told the bridge to stop', await evalIn(ws, '__td.voice'), ['start', 'stop']);
  eq('still listening until sttEnded', await evalIn(ws, '__screen()'), 'listen');

  await evalIn(ws, `onPluginMessage({ type: 'sttEnded', transcript: 'Buy milk on the way home' })`);
  await until(ws, `__screen() === 'review'`, 'review screen');
  eq('transcript lands in the box', await evalIn(ws, `document.getElementById('note-text').value`),
    'Buy milk on the way home');
  eq('SEND is preselected', await evalIn(ws, '__sel()'), 'send');

  // ── 3. Send over POST ─────────────────────────────────────────────────────
  console.log('\n[3] Send (POST)');
  await evalIn(ws, `__fire('sideClick')`);
  await until(ws, `document.getElementById('result-label').textContent === 'SENT'`, 'SENT');
  eq('shows SENT', await evalIn(ws, `document.getElementById('result-label').textContent`), 'SENT');
  const sub1 = await evalIn(ws, `document.getElementById('result-sub').textContent`);
  check('reports the transport used', sub1.includes('POST'), sub1);
  const foot1 = await evalIn(ws, `document.getElementById('last-method').textContent`);
  check('idle footer remembers the transport', foot1.includes('POST'), foot1);
  const spoke1 = await evalIn(ws, '__td.spoken.join("|")');
  check('R1 was asked to say Sent', spoke1.includes('"Sent"'), spoke1);
  eq('queue is empty', await evalIn(ws, 'JSON.parse(localStorage.getItem("taskdrop_queue")||"[]").length'), 0);
  check('badge hidden', !(await evalIn(ws, `document.getElementById('queue-badge').classList.contains('on')`)));
  eq('sheet got exactly one row', rows.length, 1);
  eq('row content', rows[0] && { note: rows[0].note, source: rows[0].source, method: rows[0].method },
    { note: 'Buy milk on the way home', source: 'R1', method: 'POST' });

  // ── 4. Scroll / button map ────────────────────────────────────────────────
  console.log('\n[4] Scroll and button map');
  await until(ws, `__screen() === 'idle'`, 'back to idle', 4000);
  await evalIn(ws, `(function(){ __fire('longPressStart'); __fire('longPressEnd');
    onPluginMessage({ type: 'sttEnded', transcript: 'Scroll test' }); })()`);
  await until(ws, `__screen() === 'review'`, 'review');
  await evalIn(ws, `__fire('scrollDown')`);
  eq('scroll down -> EDIT', await evalIn(ws, '__sel()'), 'edit');
  await evalIn(ws, `__fire('scrollDown')`);
  eq('scroll down -> DISCARD', await evalIn(ws, '__sel()'), 'discard');
  await evalIn(ws, `__fire('scrollDown')`);
  eq('clamps at DISCARD', await evalIn(ws, '__sel()'), 'discard');
  await evalIn(ws, `(function(){ __fire('scrollUp'); __fire('scrollUp'); })()`);
  eq('scroll up -> back to SEND', await evalIn(ws, '__sel()'), 'send');

  // ── 5. Long press discards, and does not eat the next hold ───────────────
  console.log('\n[5] Long press discards');
  const before = rows.length;
  await evalIn(ws, `__fire('longPressStart')`);
  eq('discard returns to idle', await evalIn(ws, '__screen()'), 'idle');
  await evalIn(ws, `__fire('longPressEnd')`);
  eq('the discard long-press did not start a recording', await evalIn(ws, '__screen()'), 'idle');
  eq('nothing was sent', rows.length, before);

  await evalIn(ws, `__fire('longPressStart')`);
  eq('the next hold still records', await evalIn(ws, '__screen()'), 'listen');
  await evalIn(ws, `(function(){ __fire('longPressEnd');
    onPluginMessage({ type: 'sttEnded', transcript: '' }); })()`);
  await until(ws, `__screen() === 'idle'`, 'idle on empty transcript');
  eq('an empty transcript goes back to idle', await evalIn(ws, '__screen()'), 'idle');

  // ── 6. GET fallback when POST cannot get through ─────────────────────────
  console.log('\n[6] GET fallback');
  mode = 'postdrop';
  await evalIn(ws, `(function(){ __td.spoken = []; __fire('longPressStart'); __fire('longPressEnd');
    onPluginMessage({ type: 'sttEnded', transcript: 'Via the GET fallback' }); })()`);
  await until(ws, `__screen() === 'review'`, 'review');
  await evalIn(ws, `__fire('sideClick')`);
  await until(ws, `document.getElementById('result-label').textContent !== 'SENDING'`, 'a verdict', 12000);
  eq('still reports SENT', await evalIn(ws, `document.getElementById('result-label').textContent`), 'SENT');
  const sub2 = await evalIn(ws, `document.getElementById('result-sub').textContent`);
  check('reports GET as the transport', sub2.includes('GET'), sub2);
  eq('the row arrived over GET', rows[rows.length - 1].method, 'GET');
  eq('and says so', rows[rows.length - 1].note, 'Via the GET fallback');

  // ── 7. A rejected send must stay queued (no blind no-cors) ───────────────
  console.log('\n[7] Server rejects -> stays queued');
  mode = 'badkey';
  const beforeReject = rows.length;
  await until(ws, `__screen() === 'idle'`, 'idle', 4000);
  await evalIn(ws, `(function(){ __td.spoken = []; __fire('longPressStart'); __fire('longPressEnd');
    onPluginMessage({ type: 'sttEnded', transcript: 'Rejected note' }); })()`);
  await until(ws, `__screen() === 'review'`, 'review');
  await evalIn(ws, `__fire('sideClick')`);
  await until(ws, `document.getElementById('result-label').textContent !== 'SENDING'`, 'a verdict', 12000);
  eq('shows QUEUED', await evalIn(ws, `document.getElementById('result-label').textContent`), 'QUEUED');
  const spoke2 = await evalIn(ws, '__td.spoken.join("|")');
  check('R1 says it will retry', spoke2.includes('Saved, will retry'), spoke2);
  eq('NOT written to the sheet', rows.length, beforeReject);
  eq('held in the queue', await evalIn(ws, 'JSON.parse(localStorage.getItem("taskdrop_queue")||"[]").length'), 1);
  const badge1 = await evalIn(ws, `document.getElementById('queue-badge').textContent`);
  check('badge shows the backlog', badge1.startsWith('1'), badge1);

  // ── 8. Offline ────────────────────────────────────────────────────────────
  console.log('\n[8] Offline');
  mode = 'down';
  await until(ws, `__screen() === 'idle'`, 'idle', 4000);
  await evalIn(ws, `(function(){ __fire('longPressStart'); __fire('longPressEnd');
    onPluginMessage({ type: 'sttEnded', transcript: 'Offline note' }); })()`);
  await until(ws, `__screen() === 'review'`, 'review');
  await evalIn(ws, `__fire('sideClick')`);
  await until(ws, `document.getElementById('result-label').textContent !== 'SENDING'`, 'a verdict', 15000);
  eq('queued while offline', await evalIn(ws, `document.getElementById('result-label').textContent`), 'QUEUED');
  eq('two notes waiting', await evalIn(ws, 'JSON.parse(localStorage.getItem("taskdrop_queue")||"[]").length'), 2);

  // ── 9. Queue survives a restart ──────────────────────────────────────────
  console.log('\n[9] Close and reopen with a backlog');
  await open();
  eq('reopens straight to idle (config persisted)', await evalIn(ws, '__screen()'), 'idle');
  eq('backlog still two', await evalIn(ws, 'JSON.parse(localStorage.getItem("taskdrop_queue")||"[]").length'), 2);
  const badge2 = await evalIn(ws, `document.getElementById('queue-badge').textContent`);
  check('badge restored on launch', badge2.startsWith('2'), badge2);

  // ── 10. Back online, the queue drains in order ───────────────────────────
  console.log('\n[10] Back online');
  mode = 'ok';
  const beforeDrain = rows.length;
  await evalIn(ws, `__fire('sideClick')`);
  await until(ws, 'JSON.parse(localStorage.getItem("taskdrop_queue")||"[]").length === 0', 'queue drains', 15000);
  eq('both notes landed', rows.length - beforeDrain, 2);
  eq('in the order they were spoken',
    rows.slice(-2).map((r) => r.note), ['Rejected note', 'Offline note']);
  check('badge cleared',
    !(await evalIn(ws, `document.getElementById('queue-badge').classList.contains('on')`)));

  // ── 11. No duplicates anywhere ───────────────────────────────────────────
  console.log('\n[11] No duplicates');
  const notes = rows.map((r) => r.note);
  eq('every row is unique', notes.length, new Set(notes).size);
  eq('total rows written', rows.length, 4);

  // ── 12. Config over the QR fragment ──────────────────────────────────────
  console.log('\n[12] Config from a scanned QR');
  await evalIn(ws, 'localStorage.clear()');
  const cfgB64 = Buffer.from(JSON.stringify({ u: EXEC_URL, k: SHARED_KEY }), 'utf8')
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
  await open('#cfg=' + cfgB64);
  await until(ws, `__screen() === 'idle'`, 'idle from QR config', 6000);
  eq('skips setup entirely', await evalIn(ws, '__screen()'), 'idle');
  const href = await evalIn(ws, 'location.href');
  check('key is scrubbed from the address bar', !href.includes('cfg='), href);
  check('config reached secure storage',
    !!(await evalIn(ws, 'localStorage.getItem("__sec_taskdrop_cfg")')));
  const roundTrip = await evalIn(ws, `(function(){
    var raw = localStorage.getItem('__sec_taskdrop_cfg');
    if (!raw) return null;
    try { return JSON.parse(decodeURIComponent(escape(atob(raw)))); } catch (e) { return 'decode-failed'; }
  })()`);
  eq('and round-trips correctly', roundTrip, { url: EXEC_URL, key: SHARED_KEY });

  // ── Done ─────────────────────────────────────────────────────────────────
  ws.close();
  chrome.kill();
  mock.close();
  statics.close();

  console.log(`\n${'='.repeat(52)}`);
  console.log(`  ${pass} passed, ${fails.length} failed`);
  if (fails.length) {
    console.log('  Failures:');
    fails.forEach((f) => console.log('    - ' + f));
  }
  console.log('='.repeat(52));
  process.exit(fails.length ? 1 : 0);
}

main().catch((e) => {
  console.error('\nHARNESS ERROR:', e.message);
  process.exit(2);
});
