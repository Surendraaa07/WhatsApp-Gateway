// WhatsApp Gateway - QR login + REST API + 5s queue + counters
// Reliability fixes: getMessage store, msgRetryCounter cache, keepalive, presence.

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
const AUTH_FOLDER = process.env.AUTH_FOLDER || 'auth_session';
const SEND_GAP_MS = 5000; // har message ke beech 5 second (anti-ban)

// â”€â”€ QR/home page protection: browser me kholne par password â”€â”€
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

let sock;
let currentQR = null;
let isConnected = false;

let sentCount = 0;
let failCount = 0;

// â”€â”€ reliability caches â”€â”€
const msgRetryCounterCache = new NodeCache();      // message retry counts
const sentMsgStore = new Map();                    // getMessage ke liye bheje hue messages

// â”€â”€ Message queue: 5s gap â”€â”€
let _queue = [];
let _processing = false;

async function _processQueue() {
  if (_processing) return;
  _processing = true;
  while (_queue.length) {
    const job = _queue.shift();
    try {
      if (!isConnected) throw new Error('not connected');
      const jid = job.number + '@s.whatsapp.net';
      const [chk] = await sock.onWhatsApp(jid).catch(() => [null]);
      if (chk && chk.exists === false) {
        failCount++;
        console.log('SKIP (not on WhatsApp): ' + job.number);
      } else {
        const sent = await sock.sendMessage(jid, { text: job.message });
        // store for retry/getMessage
        if (sent && sent.key && sent.key.id) {
          sentMsgStore.set(sent.key.id, { conversation: job.message });
          if (sentMsgStore.size > 300) { // purane saaf karo
            const firstKey = sentMsgStore.keys().next().value;
            sentMsgStore.delete(firstKey);
          }
        }
        sentCount++;
        console.log('SENT -> ' + job.number + ' | queue left: ' + _queue.length);
      }
    } catch (e) {
      failCount++;
      console.log('FAIL -> ' + job.number + ' | ' + e.message);
    }
    if (_queue.length) await new Promise(function (r) { setTimeout(r, SEND_GAP_MS); });
  }
  _processing = false;
}

async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['MyDigitalRegister', 'Chrome', '1.0.0'],
    // â”€â”€ reliability settings (search-recommended) â”€â”€
    msgRetryCounterCache,
    markOnlineOnConnect: false,        // phone par notification aate rahein
    keepAliveIntervalMs: 30000,        // connection zinda rakho
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    retryRequestDelayMs: 1000,
    maxMsgRetryCount: 5,
    syncFullHistory: false,
    getMessage: async (key) => {       // retry/re-send ke liye zaroori
      if (key && key.id && sentMsgStore.has(key.id)) return sentMsgStore.get(key.id);
      return { conversation: '' };
    },
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) { currentQR = qr; isConnected = false; }
    if (connection === 'open') {
      isConnected = true; currentQR = null;
      console.log('WhatsApp connected and ready.');
      // online presence bhejo taaki messages flow karein
      try { sock.sendPresenceUpdate('available'); } catch (e) {}
    }
    if (connection === 'close') {
      isConnected = false;
      const code = lastDisconnect && lastDisconnect.error instanceof Boom
        ? lastDisconnect.error.output.statusCode : null;
      const loggedOut = code === DisconnectReason.loggedOut;
      console.log('Connection closed. code=' + code + ' reconnect=' + !loggedOut);
      if (!loggedOut) setTimeout(startWhatsApp, 3000);
      else console.log('Logged out. Delete the ' + AUTH_FOLDER + ' folder and re-scan QR.');
    }
  });
}

startWhatsApp();

// â”€â”€ Home / QR / status page â”€â”€
app.get('/', qrAuth, async (req, res) => {
  const stats = '<p style="color:#444;font-size:15px">ðŸ“¤ Sent: <b>' + sentCount +
    '</b> &nbsp;|&nbsp; âŒ Failed: <b>' + failCount +
    '</b> &nbsp;|&nbsp; â³ Queue: <b>' + _queue.length + '</b></p>';
  if (isConnected) {
    return res.send(page('<h2>âœ… WhatsApp Connected & Ready</h2>' + stats +
      '<script>setTimeout(function(){location.reload()},15000)</script>'));
  }
  if (currentQR) {
    const img = await qrcode.toDataURL(currentQR);
    return res.send(page(
      '<h2>Scan with WhatsApp</h2>' +
      '<p>WhatsApp â†’ Linked Devices â†’ Link a Device</p>' +
      '<img src="' + img + '" style="width:300px;height:300px"/>' +
      '<p><small>Page har 10s me refresh hoga</small></p>' +
      '<script>setTimeout(function(){location.reload()},10000)</script>'
    ));
  }
  return res.send(page('<h2>Starting...</h2><p>Thodi der me refresh hoga</p>' +
    '<script>setTimeout(function(){location.reload()},3000)</script>'));
});

function page(inner) {
  return '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>WhatsApp Gateway</title></head>' +
    '<body style="font-family:sans-serif;text-align:center;padding:40px">' + inner + '</body></html>';
}

// â”€â”€ Status (JSON) â”€â”€
app.get('/status', (req, res) => {
  res.json({ connected: isConnected, sent: sentCount, failed: failCount, queue: _queue.length });
});

// â”€â”€ Send (5s-gap queue me jaata hai) â”€â”€
app.post('/api/send', (req, res) => {
  if (req.headers['x-api-key'] !== API_KEY) {
    return res.status(401).json({ success: false, error: 'Invalid API key' });
  }
  if (!isConnected) {
    return res.status(503).json({ success: false, error: 'WhatsApp not connected' });
  }
  let { number, message } = req.body || {};
  if (!number || !message) {
    return res.status(400).json({ success: false, error: 'number and message required' });
  }
  number = String(number).replace(/[^0-9]/g, '');
  if (number.length === 10) number = '91' + number;

  _queue.push({ number: number, message: message });
  _processQueue();

  return res.json({ success: true, to: number, queued: true, position: _queue.length });
});

app.listen(PORT, () => console.log('Gateway running on port ' + PORT));
