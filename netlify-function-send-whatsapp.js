// Place this in mydigitalregister at: netlify/functions/send-whatsapp.js
// Your frontend calls /.netlify/functions/send-whatsapp -- the gateway URL
// and API key stay server-side (never exposed to the browser).
//
// Set these in Netlify -> Site settings -> Environment variables:
//   WA_GATEWAY_URL  = https://your-gateway-host.com   (no trailing slash)
//   WA_GATEWAY_KEY  = same secret you set as API_KEY on the gateway

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ success: false, error: 'Method not allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: JSON.stringify({ success: false, error: 'Invalid JSON' }) };
  }

  const { number, message } = body;
  if (!number || !message) {
    return { statusCode: 400, body: JSON.stringify({ success: false, error: 'number and message required' }) };
  }

  try {
    const r = await fetch(process.env.WA_GATEWAY_URL + '/api/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.WA_GATEWAY_KEY,
      },
      body: JSON.stringify({ number, message }),
    });
    const data = await r.json();
    return { statusCode: r.status, body: JSON.stringify(data) };
  } catch (e) {
    return { statusCode: 502, body: JSON.stringify({ success: false, error: 'Gateway unreachable: ' + e.message }) };
  }
};

/* ---- Frontend usage in mydigitalregister (browser JS) ----

async function sendWhatsApp(number, message) {
  const res = await fetch('/.netlify/functions/send-whatsapp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ number, message })
  });
  return res.json();
}

// Example:
// const out = await sendWhatsApp('9876543210', 'Aapka token confirm ho gaya. - Koshyari Communication');
// console.log(out); // { success: true, to: '919876543210' }

------------------------------------------------------------- */
