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

app.listen(PORT, function () {
  console.log('Multi-account Gateway on port ' + PORT + ' | accounts: ' + NUM_ACCOUNTS);
});
