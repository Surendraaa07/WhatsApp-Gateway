// WhatsApp Gateway — MULTI ACCOUNT (2-3 numbers, rotation + failover)
// Har message alag number se rotate hota hai → load spread + alag sessions.
// acc1 = existing auth_session (purana 9927 login bachega), acc2/acc3 = naye.

const express = require('express');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const NodeCache = require('node-cache');
const qrcode = require('qrcode');
const pino = require('pino');
const fs = require('fs');

const app = express();
app.use(express.json());

const API_KEY = process.env.API_KEY || 'change-this-secret-key-123';
const PORT = process.env.PORT || 3000;
const SEND_GAP_MS = 5000;               // har message ke beech gap
const NUM_ACCOUNTS = parseInt(process.env.NUM_ACCOUNTS || '3', 10);

// ── QR page password ──
const QR_USER = process.env.QR_USER || 'admin';
const QR_PASS = process.env.QR_PASS || API_KEY;
function qrAuth(req, res, next) {
  const hdr = req.headers.authorization || '';
  const sp = hdr.indexOf(' ');
  const scheme = hdr.slice(0, sp), encoded = hdr.slice(sp + 1);
  if (scheme === 'Basic' && encoded) {
    const dec = Buffer.from(encoded, 'base64').toString();
    const ci = dec.indexOf(':');
    if (dec.slice(0, ci) === QR_USER && dec.slice(ci + 1) === QR_PASS) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="WhatsApp Gateway"');
  return res.status(401).send('Authentication required');
}

// ── accounts setup ──
const accounts = [];
for (let i = 1; i <= NUM_ACCOUNTS; i++) {
  accounts.push({
    id: 'acc' + i,
    folder: i === 1 ? 'auth_session' : ('auth_acc' + i), // acc1 = purana login
    sock: null,
    connected: false,
    qr: null,
    number: '?',
    retryCache: new NodeCache(),
    sentStore: new Map(),
  });
}

let sentCount = 0, failCount = 0;
let _queue = [], _processing = false;
let rrIndex = 0;

function liveAccounts() { return accounts.filter(function (a) { return a.connected; }); }
function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

async function startAccount(acc) {
  const { state, saveCreds } = await useMultiFileAuthState(acc.folder);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['MDR-' + acc.id, 'Chrome', '1.0.0'],
    msgRetryCounterCache: acc.retryCache,
    markOnlineOnConnect: false,
    keepAliveIntervalMs: 30000,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    retryRequestDelayMs: 1000,
    maxMsgRetryCount: 5,
    enableAutoSessionRecreation: true,
    syncFullHistory: false,
    getMessage: async (key) => {
      if (key && key.id && acc.sentStore.has(key.id)) return acc.sentStore.get(key.id);
      return { conversation: '' };
    },
  });
  acc.sock = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.update', (updates) => {
    for (const u of updates) {
      const st = u.update && u.update.status;
      if (st != null) {
        const map = { 1: 'PENDING', 2: 'SENT(1tick)', 3: 'DELIVERED(2tick)', 4: 'READ', 5: 'PLAYED' };
        const who = (u.key && u.key.remoteJid) ? u.key.remoteJid.split('@')[0] : '?';
        console.log('[' + acc.id + '] ACK ' + who + ' -> ' + st + '=' + (map[st] || '?'));
      }
    }
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) { acc.qr = qr; acc.connected = false; }
    if (connection === 'open') {
      acc.connected = true; acc.qr = null;
      acc.number = (sock.user && sock.user.id) ? sock.user.id.split(':')[0].split('@')[0] : '?';
      console.log('[' + acc.id + '] CONNECTED as ' + acc.number);
      try { sock.sendPresenceUpdate('available'); } catch (e) {}
    }
    if (connection === 'close') {
      acc.connected = false;
      const code = lastDisconnect && lastDisconnect.error instanceof Boom
        ? lastDisconnect.error.output.statusCode : null;
      const loggedOut = code === DisconnectReason.loggedOut;
      console.log('[' + acc.id + '] closed. code=' + code + ' reconnect=' + !loggedOut);
      if (!loggedOut) setTimeout(function () { startAccount(acc); }, 3000);
      else console.log('[' + acc.id + '] logged out. Delete folder "' + acc.folder + '" & re-scan.');
    }
  });
}

// start all accounts
accounts.forEach(function (acc) { startAccount(acc); });

// ── queue: rotation + failover ──
async function _processQueue() {
  if (_processing) return;
  _processing = true;
  while (_queue.length) {
    const job = _queue.shift();
    const live = liveAccounts();
    if (!live.length) {
      failCount++; console.log('FAIL (no account connected) -> ' + job.number);
      if (_queue.length) await delay(SEND_GAP_MS);
      continue;
    }
    let sent = false;
    // rrIndex se shuru, har account try karo jab tak ek success na ho (failover)
    for (let k = 0; k < live.length && !sent; k++) {
      const acc = live[(rrIndex + k) % live.length];
      try {
        const jid = job.number + '@s.whatsapp.net';
        const r = await acc.sock.sendMessage(jid, { text: job.message });
        if (r && r.key && r.key.id) {
          acc.sentStore.set(r.key.id, { conversation: job.message });
          if (acc.sentStore.size > 300) {
            const fk = acc.sentStore.keys().next().value; acc.sentStore.delete(fk);
          }
        }
        sent = true; sentCount++;
        console.log('SENT via ' + acc.id + '(' + acc.number + ') -> ' + job.number + ' | queue:' + _queue.length);
      } catch (e) {
        console.log('FAIL via ' + acc.id + ' -> ' + job.number + ' | ' + e.message + ' (next try)');
      }
    }
    if (!sent) { failCount++; console.log('FAIL (all accounts) -> ' + job.number); }
    rrIndex++; // agla message agle account se shuru
    if (_queue.length) await delay(SEND_GAP_MS);
  }
  _processing = false;
}

// ── home page: saare accounts + QR ──
app.get('/', qrAuth, async (req, res) => {
  let h = '<h1>WhatsApp Gateway — Multi Account</h1>';
  h += '<p style="font-size:15px">Sent: <b>' + sentCount + '</b> | Failed: <b>' + failCount +
       '</b> | Queue: <b>' + _queue.length + '</b> | Connected: <b>' +
       liveAccounts().length + '/' + accounts.length + '</b></p>';
  h += '<p><a href="/" style="display:inline-block;background:#444;color:#fff;padding:8px 18px;border-radius:8px;text-decoration:none">🔄 Refresh</a></p>';
  h += '<form action="/sendtest" method="get" style="margin:14px auto;padding:14px;border:1px dashed #888;border-radius:10px;display:inline-block">' +
       '<b>Test bhejo (delivery check):</b><br>' +
       '<input name="number" placeholder="10-digit number" style="padding:8px;font-size:15px;margin:8px 4px;width:170px" />' +
       '<button type="submit" style="padding:8px 16px;font-size:15px;background:#1a7a40;color:#fff;border:none;border-radius:6px;cursor:pointer">Send Test</button>' +
       '<br><small style="color:#888">Message bhejega + batayega DELIVERED hua ya nahi</small></form>';
  h += '<div style="display:flex;flex-wrap:wrap;gap:18px;justify-content:center;margin-top:16px">';
  for (const acc of accounts) {
    h += '<div style="border:1px solid #bbb;border-radius:12px;padding:16px;min-width:250px">';
    h += '<h3>' + acc.id.toUpperCase() + '</h3>';
    if (acc.connected) {
      h += '<p style="color:green;font-size:16px">✅ Connected<br><b>' + acc.number + '</b></p>';
    } else if (acc.qr) {
      const img = await qrcode.toDataURL(acc.qr);
      h += '<p>Scan to add number:</p><img src="' + img + '" style="width:230px;height:230px"/>';
    } else {
      h += '<p style="color:#999">Starting / waiting...</p>';
    }
    h += '<p><a href="/relogin/' + acc.id + '" onclick="return confirm(\'' + acc.id + ' ka login hatao aur naya QR lao?\')" style="font-size:12px;color:#c00;text-decoration:none">🔁 Re-login (naya QR)</a></p>';
    h += '</div>';
  }
  h += '</div><p style="color:#888;font-size:12px;margin-top:18px">Har 10s me refresh. Jitne number scan karoge utne se rotate hoga.</p>';
  h += '<script>setTimeout(function(){location.reload()},10000)</script>';
  res.send('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>WA Gateway</title></head><body style="font-family:sans-serif;text-align:center;padding:30px">' + h + '</body></html>');
});

// ── status JSON ──
app.get('/status', (req, res) => {
  res.json({
    sent: sentCount, failed: failCount, queue: _queue.length,
    connected: liveAccounts().length, total: accounts.length,
    accounts: accounts.map(function (a) { return { id: a.id, connected: a.connected, number: a.number }; }),
  });
});

// ── send (rotation me jaata hai) ──
app.post('/api/send', (req, res) => {
  if (req.headers['x-api-key'] !== API_KEY) {
    return res.status(401).json({ success: false, error: 'Invalid API key' });
  }
  if (!liveAccounts().length) {
    return res.status(503).json({ success: false, error: 'No WhatsApp account connected' });
  }
  let { number, message } = req.body || {};
  if (!number || !message) {
    return res.status(400).json({ success: false, error: 'number and message required' });
  }
  number = String(number).replace(/[^0-9]/g, '');
  if (number.length === 10) number = '91' + number;

  _queue.push({ number: number, message: message });
  _processQueue();

  return res.json({ success: true, to: number, queued: true });
});

// ── result page helper ──
function resultPage(msg) {
  return '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Result</title></head><body style="font-family:sans-serif;text-align:center;padding:40px">' +
    '<div style="font-size:18px;line-height:1.6;max-width:520px;margin:0 auto">' + msg + '</div>' +
    '<p style="margin-top:24px"><a href="/" style="background:#444;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none">← Wapas</a></p>' +
    '</body></html>';
}

// ── ACK ka wait (delivery confirm hone tak, max timeout) ──
function waitForAck(acc, msgId, timeoutMs) {
  return new Promise(function (resolve) {
    var best = 1, done = false;
    function handler(updates) {
      for (var i = 0; i < updates.length; i++) {
        var u = updates[i];
        if (u.key && u.key.id === msgId && u.update && u.update.status != null) {
          if (u.update.status > best) best = u.update.status;
          if (u.update.status >= 3 && !done) { done = true; acc.sock.ev.off('messages.update', handler); resolve(best); }
        }
      }
    }
    acc.sock.ev.on('messages.update', handler);
    setTimeout(function () { if (!done) { done = true; acc.sock.ev.off('messages.update', handler); resolve(best); } }, timeoutMs);
  });
}

// ── Web se test bhejo + delivery status batao ──
app.get('/sendtest', qrAuth, async (req, res) => {
  var number = String(req.query.number || '').replace(/[^0-9]/g, '');
  if (number.length === 10) number = '91' + number;
  if (!number) return res.send(resultPage('❌ Number nahi diya.'));
  var live = liveAccounts();
  if (!live.length) return res.send(resultPage('❌ Koi account connected nahi.'));
  var acc = live[rrIndex % live.length]; rrIndex++;
  var jid = number + '@s.whatsapp.net';
  var r;
  try {
    r = await acc.sock.sendMessage(jid, { text: '✅ Gateway test — ' + new Date().toLocaleString('hi-IN') });
  } catch (e) { return res.send(resultPage('❌ Send error: ' + e.message + '<br>via ' + acc.id)); }
  var msgId = r && r.key && r.key.id;
  if (!msgId) return res.send(resultPage('❌ Send fail (no message id) via ' + acc.id));
  acc.sentStore.set(msgId, { conversation: 'test' });
  var status = await waitForAck(acc, msgId, 12000);
  var v;
  if (status >= 3) {
    v = '✅ <b style="color:green">DELIVERED!</b> (2 tick)<br>Message <b>' + number + '</b> tak pahunch gaya.<br><br>Bheja via: <b>' + acc.id + ' (' + acc.number + ')</b>';
  } else if (status === 2) {
    v = '⚠️ <b style="color:#c60">SENT par DELIVER NAHI hua</b> (sirf 1 tick — 12s wait kiya)<br>Message <b>' + number + '</b> tak nahi pahuncha.<br><br>Iska matlab: encryption/recipient session issue (ya recipient ka phone abhi offline).<br>Bheja via: <b>' + acc.id + ' (' + acc.number + ')</b>';
  } else {
    v = '❌ <b style="color:#c00">Koi delivery confirm nahi mili</b> (status ' + status + ')<br>via ' + acc.id + ' (' + acc.number + ')';
  }
  res.send(resultPage(v));
});

// ── Account re-login: auth hatao, naya QR lao ──
app.get('/relogin/:id', qrAuth, async (req, res) => {
  var acc = accounts.find(function (a) { return a.id === req.params.id; });
  if (!acc) return res.send(resultPage('❌ Account nahi mila.'));
  try {
    if (acc.sock) { try { acc.sock.end(); } catch (e) {} }
    acc.connected = false; acc.qr = null; acc.number = '?';
    try { fs.rmSync(acc.folder, { recursive: true, force: true }); } catch (e) {}
    setTimeout(function () { startAccount(acc); }, 1500);
    res.send(resultPage('🔁 ' + acc.id + ' reset ho gaya.<br>Kuch second me naya QR aayega — page par wapas jaa ke scan karo.'));
  } catch (e) { res.send(resultPage('❌ Error: ' + e.message)); }
});

app.listen(PORT, function () {
  console.log('Multi-account Gateway on port ' + PORT + ' | accounts: ' + NUM_ACCOUNTS);
});
