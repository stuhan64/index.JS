// index.js — AstroApp + Shopify Backend (v4)
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

// === CONFIGURATION ===
const ASTROAPP_KEY   = process.env.ASTROAPP_KEY;
const ASTROAPP_USER  = process.env.ASTROAPP_USER;  // your AstroApp login email
const ASTROAPP_PASS  = process.env.ASTROAPP_PASS;  // your AstroApp password
const OPENCAGE_KEY   = process.env.OPENCAGE_KEY;
const TIMEZONEDB_KEY = process.env.TIMEZONEDB_KEY;

// === BOOT VALIDATION ===
function checkEnv(name, val) {
  if (!val || String(val).trim() === '') {
    console.error(`[BOOT] ⚠️  Missing env var: ${name}`);
    return false;
  }
  console.log(`[BOOT] ✅ ${name} is set`);
  return true;
}
checkEnv('ASTROAPP_KEY',   ASTROAPP_KEY);
checkEnv('ASTROAPP_USER',  ASTROAPP_USER);
checkEnv('ASTROAPP_PASS',  ASTROAPP_PASS);
checkEnv('OPENCAGE_KEY',   OPENCAGE_KEY);
checkEnv('TIMEZONEDB_KEY', TIMEZONEDB_KEY);

// === ZODIAC SIGN FROM LONGITUDE ===
// AstroApp returns planetary longitude in degrees (0-360)
// Every 30 degrees is one sign, starting at Aries at 0 degrees
const ZODIAC_SIGNS = [
  'aries', 'taurus', 'gemini', 'cancer',
  'leo', 'virgo', 'libra', 'scorpio',
  'sagittarius', 'capricorn', 'aquarius', 'pisces'
];

function signFromLongitude(lng) {
  if (lng == null) return 'unknown';
  const normalized = ((parseFloat(lng) % 360) + 360) % 360;
  const index = Math.floor(normalized / 30);
  return ZODIAC_SIGNS[index] || 'unknown';
}

// === UTILS ===
function encodeBasicAuth(user, pass) {
  return 'Basic ' + Buffer.from(user + ':' + pass).toString('base64');
}

function safeError(err) {
  return err?.response
    ? { status: err.response.status, data: err.response.data }
    : { message: err.message };
}

// === TOKEN CACHE ===
// Tokens expire after 100 uses OR 60 minutes — we refresh every 50 min to be safe
let cachedToken = null;
let tokenExpiry  = 0;

async function fetchAstroToken() {
  try {
    console.log('[TOKEN] Fetching new AstroApp token...');
    const r = await axios.post(
      'https://astroapp.com/astro/apis/chart',
      {},
      {
        headers: {
          'Authorization': encodeBasicAuth(ASTROAPP_USER, ASTROAPP_PASS),
          'Content-Type':  'application/json',
          'Key':           ASTROAPP_KEY
        },
        timeout: 15000
      }
    );

    const jwt = r.data?.jwt || r.data?.token;
    if (!jwt) {
      console.error('[TOKEN] No jwt/token in response. Full response:', JSON.stringify(r.data));
      return null;
    }

    cachedToken = jwt;
    tokenExpiry = Date.now() + (50 * 60 * 1000); // cache for 50 minutes
    console.log('[TOKEN] ✅ Token acquired and cached');
    return jwt;

  } catch (err) {
    console.error('[TOKEN] Error:', JSON.stringify(safeError(err)));
    return null;
  }
}

async function getAstroToken() {
  if (cachedToken && Date.now() < tokenExpiry - 30000) {
    console.log('[TOKEN] Using cached token');
    return cachedToken;
  }
  cachedToken = null;
  tokenExpiry  = 0;
  return await fetchAstroToken();
}

// === GEO / TIMEZONE ===
async function geocodeLocation(location) {
  if (!OPENCAGE_KEY) throw new Error('OPENCAGE_KEY not set');
  const url = `https://api.opencagedata.com/geocode/v1/json?q=${encodeURIComponent(location)}&key=${OPENCAGE_KEY}`;
  const res = await axios.get(url, { timeout: 15000 });
  if (!res.data?.results?.[0]?.geometry) throw new Error('Geocoding failed for: ' + location);
  const { lat, lng } = res.data.results[0].geometry;
  console.log(`[GEO] ${location} -> lat: ${lat}, lng: ${lng}`);
  return { lat, lng };
}

async function getTimeZone(lat, lng) {
  if (!TIMEZONEDB_KEY) throw new Error('TIMEZONEDB_KEY not set');
  const url = `https://api.timezonedb.com/v2.1/get-time-zone?key=${TIMEZONEDB_KEY}&format=json&by=position&lat=${lat}&lng=${lng}`;
  const res = await axios.get(url, { timeout: 15000 });
  if (!res.data?.zoneName) throw new Error('Timezone lookup failed');
  console.log(`[TZ] ${lat},${lng} -> ${res.data.zoneName}`);
  return res.data.zoneName;
}

// === ROUTES ===

// Health check
app.get('/health', (_req, res) => {
  res.json({
    ok:               true,
    hasAstroAppKey:   !!ASTROAPP_KEY,
    hasAstroUser:     !!ASTROAPP_USER,
    hasAstroPass:     !!ASTROAPP_PASS,
    hasOpenCage:      !!OPENCAGE_KEY,
    hasTimeZoneDB:    !!TIMEZONEDB_KEY,
    tokenCached:      !!cachedToken,
    tokenExpiresInMs: Math.max(0, tokenExpiry - Date.now())
  });
});

// Token test
app.get('/token-test', async (_req, res) => {
  const jwt = await getAstroToken();
  if (!jwt) {
    return res.status(500).json({
      ok:     false,
      reason: 'token_fetch_failed — check ASTROAPP_USER, ASTROAPP_PASS, ASTROAPP_KEY in Render env vars'
    });
  }
  res.json({
    ok:               true,
    tokenCached:      !!cachedToken,
    tokenExpiresInMs: Math.max(0, tokenExpiry - Date.now())
  });
});

// Main endpoint — called by Shopify frontend
app.post('/', async (req, res) => {
  try {
    const {
      birthDate,
      birthTime,
      birthLocation,
      lat: inLat,
      lng: inLng,
      tz:  inTz
    } = req.body;

    if (!birthDate || !birthTime) {
      return res.status(400).json({ success: false, error: 'birthDate and birthTime are required' });
    }

    const dateTime = `${birthDate}T${birthTime}:00`;
    console.log(`[MAIN] Request: ${dateTime} @ ${birthLocation || `${inLat},${inLng}`}`);

    // Geocode if lat/lng not passed directly
    let lat = inLat, lng = inLng, tz = inTz;

    if ((lat == null || lng == null) && birthLocation) {
      const pos = await geocodeLocation(birthLocation);
      lat = pos.lat;
      lng = pos.lng;
    }
    if (!tz) {
      if (lat == null || lng == null) throw new Error('No location or lat/lng provided');
      tz = await getTimeZone(lat, lng);
    }

    const jwt = await getAstroToken();
    if (!jwt) throw new Error('Missing AstroApp token — check credentials in Render env vars');

    const payload = {
      chart: {
        chartData: {
          chartName:     "Customer Chart",
          chartDate:     dateTime,
          elevation:     0,
          lat,
          lng,
          tz,
          zodiacID:      100,
          houseSystemID: 1,
          coordSys:      "G",
          version:       1
        }
      },
      calcRequestProps: {
        needImage:   "Y",
        needAspects: "N"
      },
      params: {
        objects: [0, 1, 24]  // Sun=0, Moon=1, Ascendant=24
      }
    };

    const astroRes = await axios.post(
      'https://astroapp.com/astro/apis/chart',
      payload,
      {
        headers: {
          'Authorization': `Bearer ${jwt}`,
          'Content-Type':  'application/json',
          'Key':           ASTROAPP_KEY
        },
        timeout: 20000
      }
    );

    const data = astroRes.data || {};
    console.log('[CHART] Raw response keys:', Object.keys(data));
    console.log('[CHART] chartData:', JSON.stringify(data.chartData));
    console.log('[CHART] objects:', JSON.stringify(data.objects));

    // Image URL is at data.chartData.imgPath
    const imageUrl = data.chartData?.imgPath || null;

    // Signs calculated from longitude degrees, not sign names
    const objects = data.objects || [];

    const sunObj    = objects.find(p => p.id === 0);
    const moonObj   = objects.find(p => p.id === 1);
    const risingObj = objects.find(p => p.id === 24);

    const sunSign    = signFromLongitude(sunObj?.lng);
    const moonSign   = signFromLongitude(moonObj?.lng);
    const risingSign = signFromLongitude(risingObj?.lng);

    console.log(`[CHART] Image: ${imageUrl}`);
    console.log(`[CHART] Sun: ${sunSign} (${sunObj?.lng}) | Moon: ${moonSign} (${moonObj?.lng}) | Rising: ${risingSign} (${risingObj?.lng})`);

    return res.json({
      success:  true,
      imageUrl,
      sun:      sunSign,
      moon:     moonSign,
      rising:   risingSign,
      lat, lng, tz
    });

  } catch (err) {
    console.error('[MAIN] Error:', JSON.stringify(safeError(err)));
    return res.status(500).json({ success: false, error: err.message || 'unknown_error' });
  }
});

app.listen(PORT, () => {
  console.log(`[BOOT] Server running on port ${PORT}`);
});
