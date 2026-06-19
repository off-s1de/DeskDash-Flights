/*
  DeskDash — Flights Proxy (Vercel Serverless Function)
  ══════════════════════════════════════════════════════
  Vercel Dashboard → Project → Settings → Environment Variables → add:
    OPENSKY_CLIENT_ID
    OPENSKY_CLIENT_SECRET

  Endpoint: https://<your-project>.vercel.app/api/flights?lat=13.0219&lon=77.5937&dist=55
*/

const TOKEN_URL = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';

// module-level cache — persists across warm invocations on Vercel
let cachedToken = null;
let tokenExpiresAt = 0;

async function getOpenSkyToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt) {
    return cachedToken;
  }
  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.OPENSKY_CLIENT_ID,
      client_secret: process.env.OPENSKY_CLIENT_SECRET,
    }),
  });
  if (!resp.ok) {
    const errBody = await resp.text().catch(() => '');
    throw new Error(`OpenSky token exchange failed: HTTP ${resp.status} — ${errBody.slice(0,200)}`);
  }
  const data = await resp.json();
  cachedToken = data.access_token;
  tokenExpiresAt = now + (data.expires_in - 120) * 1000; // refresh 2 min early
  return cachedToken;
}

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const lat  = parseFloat(req.query.lat  || '13.0219');
  const lon  = parseFloat(req.query.lon  || '77.5937');
  const dist = parseInt(req.query.dist   || '55'); // nautical miles

  // debug mode: /api/flights?debug=1
  if (req.query.debug) {
    const log = {
      creds_set: !!(process.env.OPENSKY_CLIENT_ID && process.env.OPENSKY_CLIENT_SECRET),
    };

    // sanity check: can we reach the internet at all from this function?
    try {
      const t = Date.now();
      const sanity = await fetch('https://api.github.com');
      log.sanity_check_ms = Date.now() - t;
      log.sanity_check_status = sanity.status;
    } catch (e) {
      log.sanity_check_error = e.message;
      log.sanity_check_cause = e.cause ? String(e.cause) : null;
    }

    try {
      const t0 = Date.now();
      const token = await getOpenSkyToken();
      log.token_ms = Date.now() - t0;
      log.token_acquired = !!token;

      const delta = (dist * 1.852) / 111;
      const oUrl = `https://opensky-network.org/api/states/all?lamin=${lat-delta}&lomin=${lon-delta}&lamax=${lat+delta}&lomax=${lon+delta}`;
      const t1 = Date.now();
      const r = await fetch(oUrl, { headers: { Authorization: `Bearer ${token}` } });
      log.data_ms = Date.now() - t1;
      log.data_status = r.status;
      const raw = await r.json();
      log.states_length = Array.isArray(raw.states) ? raw.states.length : raw.states;
    } catch (e) {
      log.error = e.message;
      log.error_cause = e.cause ? String(e.cause) : null;
      log.error_code  = e.cause && e.cause.code ? e.cause.code : null;
      log.error_stack = e.stack ? e.stack.split('\n').slice(0,4) : null;
    }
    res.status(200).json(log);
    return;
  }

  try {
    const token = await getOpenSkyToken();
    const delta = (dist * 1.852) / 111; // nm → degrees (rough)
    const oUrl = `https://opensky-network.org/api/states/all?lamin=${lat-delta}&lomin=${lon-delta}&lamax=${lat+delta}&lomax=${lon+delta}`;

    const resp = await fetch(oUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!resp.ok) {
      throw new Error(`OpenSky HTTP ${resp.status}`);
    }

    const data = await resp.json();
    const states = Array.isArray(data.states) ? data.states : [];

    const aircraft = states
      .filter(s => s && s[1] && s[1].trim() !== '')
      .map(s => ({
        callsign:  s[1].trim(),
        reg:       null,
        origin:    null,
        dest:      null,
        alt_ft:    s[7]  ? Math.round(s[7] * 3.28084) : null,  // m → ft
        speed_kts: s[9]  ? Math.round(s[9] * 1.94384) : null,  // m/s → kts
        heading:   s[10] ? Math.round(s[10])           : null,  // true track °
        on_ground: s[8]  || false,
        lat:       s[6],
        lon:       s[5],
        type:      null,
      }))
      .filter(a => a.lat != null && a.lon != null);

    res.status(200).json({ aircraft, source: 'opensky', count: aircraft.length });

  } catch (e) {
    res.status(200).json({ aircraft: [], error: e.message, source: 'none' });
  }
}
