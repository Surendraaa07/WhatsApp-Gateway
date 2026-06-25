# WhatsApp Gateway (QR login + REST API)

QR se login, apne number se message bhejo, REST API kisi bhi app me lagao.
Built with Baileys (no browser/Chromium needed).

## ⚠️ Pehle ye samajh lo

- **Netlify pe ye NAHI chalega.** WhatsApp ko ek permanent live connection chahiye.
  Netlify Functions kuch second me band ho jaati hain. Gateway ek **always-on**
  server pe rakho. `mydigitalregister` Netlify pe hi rahega -- woh sirf API call karega.
- **Ban risk:** personal number pe unofficial automation se number ban ho sakta hai.
  10-20 msg/din known customers ko = risk kam. Bulk/marketing mat bhejna.
- **Session folder (`auth_session`) persistent disk pe hona chahiye**, warna har
  restart pe dobara QR scan karna padega. Ye sabse common galti hai.

---

## Setup (local test pehle)

```bash
npm install
# agar baileys version error de: npm install @whiskeysockets/baileys@latest
API_KEY=mera-secret-123 node server.js
```

Browser me `http://localhost:3000` kholo -> QR aayega ->
phone me WhatsApp -> Linked Devices -> Link a Device -> scan.
"Connected & Ready" aate hi taiyaar.

Test send:
```bash
curl -X POST http://localhost:3000/api/send \
  -H "Content-Type: application/json" \
  -H "x-api-key: mera-secret-123" \
  -d '{"number":"9876543210","message":"Test from gateway"}'
```

---

## Hosting kahan kare (always-on chahiye)

### Option A — Sabse FREE jugad: purana Android phone (Termux)
Phone charger pe 24x7 laga ke rakho. Free, session phone me hi save rehta hai.
```bash
pkg update && pkg install nodejs git cloudflared
# files copy karo phone me, fir:
npm install
API_KEY=mera-secret-123 node server.js
# alag terminal me public URL ke liye:
cloudflared tunnel --url http://localhost:3000
```
Cloudflared ek public URL dega -> wahi URL `WA_GATEWAY_URL` me daalo.
(Stable URL chahiye to "named tunnel" set karo -- free hai, thoda extra setup.)

### Option B — Easy, thoda paid: Railway / VPS
- **Railway.app**: repo connect karo, Node auto-detect. Ek **Volume** banao aur
  `auth_session` path pe mount karo (warna session ud jaayega). `API_KEY` env me set.
- **Chhota VPS** (Hostinger VPS / Contabo, ~₹300-500/mo): sabse reliable.
  `pm2 start server.js` se 24x7 chalega.

### ❌ Render free tier
Spin-down + ephemeral disk = har baar QR. Mat use karo (ya paid disk lo).

---

## mydigitalregister me lagana

1. `netlify-function-send-whatsapp.js` ko apne repo me
   `netlify/functions/send-whatsapp.js` ke roop me daalo.
2. Netlify env vars set karo:
   - `WA_GATEWAY_URL` = tera gateway ka URL (no trailing slash)
   - `WA_GATEWAY_KEY` = wahi secret jo gateway me `API_KEY` hai
3. Frontend se call karo (file ke neeche example diya hai):
   ```js
   await fetch('/.netlify/functions/send-whatsapp', {
     method: 'POST',
     headers: { 'Content-Type': 'application/json' },
     body: JSON.stringify({ number: '9876543210', message: 'Aapka token confirm.' })
   });
   ```
   API key browser me kabhi nahi jaayega -- sab function ke andar.

---

## "Tez wala ka msg open nahi ho raha" — quick fix

wa.me / click-to-chat link sahi format me hona chahiye:
```
https://wa.me/919876543210?text=Hello%20ji
```
- Number me country code `91` ho, koi `+`, space ya `-` nahi.
- `text` URL-encoded ho (space = %20).

Is gateway me ye normalize automatic ho raha hai (10-digit number me 91 lag jaata hai).

---

## Endpoints

| Method | Path         | Auth (x-api-key) | Body                  |
|--------|--------------|------------------|-----------------------|
| GET    | `/`          | no               | QR / status page      |
| GET    | `/status`    | no               | `{ connected: bool }` |
| POST   | `/api/send`  | yes              | `{ number, message }` |
