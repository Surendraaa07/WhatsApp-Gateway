// WhatsApp Gateway - QR login + REST API
// Baileys based (no browser needed). Runs on any always-on Node server.
// NOT for Netlify -- needs a persistent process.

const express = require('express');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode');
const pino = require('pino');

const app = express();
app.use(express.json());

// ---- CONFIG (set these as environment variables in production) ----
const API_KEY = process.env.API_KEY || 'change-this-secret-key-123';
const PORT = process.env.PORT || 3000;
// IMPORTANT: the "auth_session" folder MUST sit on a persistent disk,
// warna har restart pe dobara QR scan karna padega.
const AUTH_FOLDER = process.env.AUTH_FOLDER || 'auth_session';

let sock;
let currentQR = null;
let isConnected = false;

async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['MyDigitalRegister', 'Chrome', '1.0.0'],
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      currentQR = qr;
      isConnected = false;
    }

    if (connection === 'open') {
      isConnected = true;
      currentQR = null;
      console.log('WhatsApp connected and ready.');
    }

    if (connection === 'close') {
      isConnected = false;
      const code =
        lastDisconnect?.error instanceof Boom
          ? lastDisconnect.error.output.statusCode
          : null;
      const loggedOut = code === DisconnectReason.loggedOut;
      console.log('Connection closed. code=' + code + ' reconnect=' + !loggedOut);
      if (!loggedOut) {
        setTimeout(startWhatsApp, 3000); // auto-reconnect
      } else {
        console.log('Logged out. Delete the ' + AUTH_FOLDER + ' folder and re-scan QR.');
      }
    }
  });
}

startWhatsApp();

// ---- QR / status web page ----
app.get('/', async (req, res) => {
  if (isConnected) {
    return res.send(page('<h2>✅ WhatsApp Connected & Ready</h2>'));
  }
  if (currentQR) {
    const img = await qrcode.toDataURL(currentQR);
    return res.send(
      page(
        '<h2>Scan with WhatsApp</h2>' +
          '<p>WhatsApp → Linked Devices → Link a Device</p>' +
          '<img src="' + img + '" style="width:300px;height:300px"/>' +
          '<p><small>Page har 10s me refresh hoga</small></p>' +
          '<script>setTimeout(function(){location.reload()},10000)</script>'
      )
    );
  }
  return res.send(
    page(
      '<h2>Starting...</h2><p>Thodi der me refresh hoga</p>' +
        '<script>setTimeout(function(){location.reload()},3000)</script>'
    )
  );
});

function page(inner) {
  return (
    '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>WhatsApp Gateway</title></head>' +
    '<body style="font-family:sans-serif;text-align:center;padding:40px">' +
    inner +
    '</body></html>'
  );
}

// ---- Status (JSON) ----
app.get('/status', (req, res) => {
  res.json({ connected: isConnected });
});

// ---- Send message ----
// POST /api/send  header: x-api-key   body: { number, message }
app.post('/api/send', async (req, res) => {
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

  // Normalize: digits only, add 91 for 10-digit Indian numbers
  number = String(number).replace(/[^0-9]/g, '');
  if (number.length === 10) number = '91' + number;

  const jid = number + '@s.whatsapp.net';

  try {
    // Optional: verify the number exists on WhatsApp
    const [check] = await sock.onWhatsApp(jid).catch(() => [null]);
    if (check && check.exists === false) {
      return res.status(404).json({ success: false, error: 'Number not on WhatsApp', to: number });
    }
    await sock.sendMessage(jid, { text: message });
    return res.json({ success: true, to: number });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

app.listen(PORT, () => console.log('Gateway running on port ' + PORT));
