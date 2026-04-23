// index.js — AstroApp + Printful + Shopify Backend (v6)
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

// === CONFIGURATION ===
const ASTROAPP_KEY     = process.env.ASTROAPP_KEY;
const ASTROAPP_USER    = process.env.ASTROAPP_USER;
const ASTROAPP_PASS    = process.env.ASTROAPP_PASS;
const OPENCAGE_KEY     = process.env.OPENCAGE_KEY;
const TIMEZONEDB_KEY   = process.env.TIMEZONEDB_KEY;
const PRINTFUL_KEY     = process.env.PRINTFUL_KEY;
const PRINTFUL_STORE_ID = process.env.PRINTFUL_STORE_ID || '16293860';

// === BOOT VALIDATION ===
function checkEnv(name, val) {
  if (!val || String(val).trim() === '') {
    console.error(`[BOOT] ⚠️  Missing env var: ${name}`);
    return false;
  }
  console.log(`[BOOT] ✅ ${name} is set`);
  return true;
}
checkEnv('ASTROAPP_KEY',      ASTROAPP_KEY);
checkEnv('ASTROAPP_USER',     ASTROAPP_USER);
checkEnv('ASTROAPP_PASS',     ASTROAPP_PASS);
checkEnv('OPENCAGE_KEY',      OPENCAGE_KEY);
checkEnv('TIMEZONEDB_KEY',    TIMEZONEDB_KEY);
checkEnv('PRINTFUL_KEY',      PRINTFUL_KEY);
checkEnv('PRINTFUL_STORE_ID', PRINTFUL_STORE_ID);

// === ZODIAC SIGN FROM LONGITUDE ===
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
// AstroApp tokens expire after 100 uses OR 60 minutes
// We cache and reuse, refreshing automatically when expired
let cachedToken = null;
let tokenExpiry  = 0;

function getCachedToken() {
  if (cachedToken && Date.now() < tokenExpiry - 30000) {
    console.log('[TOKEN] Using cached token');
    return cachedToken;
  }
  cachedToken = null;
  tokenExpiry  = 0;
  return null;
}

function cacheToken(jwt) {
  cachedToken = jwt;
  tokenExpiry = Date.now() + (55 * 60 * 1000); // 55 min to stay under 60 min limit
  console.log('[TOKEN] ✅ Token cached');
}

// === ASTROAPP CHART REQUEST ===
// Key insight from AstroApp support:
// - First request: use Basic Auth + real chart payload → returns chart data + JWT token
// - Subsequent requests: use Bearer token + real chart payload
// - There is NO separate token endpoint — the token comes back with the first real request
async function fetchChart(payload, useBasicAuth) {
  const authHeader = useBasicAuth
    ? encodeBasicAuth(ASTROAPP_USER, ASTROAPP_PASS)
    : 'Bearer ' + cachedToken;

  console.log(`[ASTRO] Calling chart API with ${useBasicAuth ? 'Basic Auth' : 'Bearer token'}`);

  const response = await axios.post(
    'https://astroapp.com/astro/apis/chart',
    payload,
    {
      headers: {
        'Authorization': authHeader,
        'Content-Type':  'application/json',
        'Key':           ASTROAPP_KEY
      },
      timeout: 20000
    }
  );

  // Extract and cache JWT from response if present
  const jwt = response.data?.jwt || response.data?.token;
  if (jwt) {
    cacheToken(jwt);
  }

  return response.data;
}

// Main chart fetch with automatic Basic Auth fallback
async function getChart(payload) {
  const token = getCachedToken();

  if (token) {
    // Try with cached Bearer token first
    try {
      return await fetchChart(payload, false);
    } catch (err) {
      const status = err?.response?.status;
      console.warn(`[ASTRO] Bearer token failed (${status}), retrying with Basic Auth...`);
      // Fall through to Basic Auth
    }
  }

  // Use Basic Auth — first call or token expired/failed
  try {
    const data = await fetchChart(payload, true);
    return data;
  } catch (err) {
    console.error('[ASTRO] Basic Auth failed:', JSON.stringify(safeError(err)));
    throw new Error('AstroApp authentication failed: ' + JSON.stringify(safeError(err)));
  }
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

// === PRINTFUL HELPERS ===
function printfulHeaders() {
  return {
    'Authorization': 'Bearer ' + PRINTFUL_KEY,
    'Content-Type':  'application/json',
    'X-PF-Store-Id': PRINTFUL_STORE_ID
  };
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
    hasPrintfulKey:   !!PRINTFUL_KEY,
    tokenCached:      !!cachedToken,
    tokenExpiresInMs: Math.max(0, tokenExpiry - Date.now())
  });
});

// Token test — now tests with a real minimal chart request
app.get('/token-test', async (_req, res) => {
  try {
    // Use a known good test payload from AstroApp docs
    const testPayload = {
      chart: {
        chartData: {
          chartName:     "Token Test",
          chartDate:     "1974-03-27T08:45:00",
          elevation:     0,
          lat:           50.9333,
          lng:           6.95,
          tz:            "Europe/Berlin",
          zodiacID:      100,
          houseSystemID: 1,
          coordSys:      "G",
          version:       1
        }
      },
      calcRequestProps: { needImage: "N", needAspects: "N" },
      params: { objects: [0] }
    };

    const data = await getChart(testPayload);
    res.json({
      ok:          true,
      tokenCached: !!cachedToken,
      hasObjects:  !!(data?.objects?.length),
      tokenExpiresInMs: Math.max(0, tokenExpiry - Date.now())
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Printful variant lookup — uses sync endpoint for Shopify-connected stores
app.get('/printful-variants', async (_req, res) => {
  try {
    const r = await axios.get(
      'https://api.printful.com/sync/products',
      { headers: printfulHeaders() }
    );
    const products = r.data?.result || [];
    const summary = await Promise.all(products.map(async p => {
      const detail = await axios.get(
        'https://api.printful.com/sync/products/' + p.id,
        { headers: printfulHeaders() }
      );
      const variants = (detail.data?.result?.sync_variants || []).map(v => ({
        id:       v.id,
        name:     v.name,
        size:     v.product?.size,
        color:    v.product?.color,
        price:    v.retail_price,
        currency: v.currency
      }));
      return { id: p.id, name: p.name, variants };
    }));
    res.json({ ok: true, products: summary });
  } catch (err) {
    console.error('[PRINTFUL] Error:', JSON.stringify(safeError(err)));
    res.status(500).json({ ok: false, error: safeError(err) });
  }
});

// Main chart generation endpoint
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

    const payload = {
      chart: {
        chartData: {
          chartName:     "Customer Chart",
          chartDate:     dateTime,
          elevation:     0,
          lat, lng, tz,
          zodiacID:      100,
          houseSystemID: 1,
          coordSys:      "G",
          version:       1
        }
      },
      calcRequestProps: { needImage: "Y", needAspects: "N" },
      params: { objects: [0, 1, 24] }
    };

    const data = await getChart(payload);

    const imageUrl = data.chartData?.imgPath || null;
    const objects  = data.objects || [];

    const sunObj    = objects.find(p => p.id === 0);
    const moonObj   = objects.find(p => p.id === 1);
    const risingObj = objects.find(p => p.id === 24);

    const sunSign    = signFromLongitude(sunObj?.lng);
    const moonSign   = signFromLongitude(moonObj?.lng);
    const risingSign = signFromLongitude(risingObj?.lng);

    console.log(`[CHART] Image: ${imageUrl}`);
    console.log(`[CHART] Sun: ${sunSign} | Moon: ${moonSign} | Rising: ${risingSign}`);

    return res.json({
      success: true,
      imageUrl,
      sun:     sunSign,
      moon:    moonSign,
      rising:  risingSign,
      lat, lng, tz
    });

  } catch (err) {
    console.error('[MAIN] Error:', JSON.stringify(safeError(err)));
    return res.status(500).json({ success: false, error: err.message || 'unknown_error' });
  }
});

// Create Printful order
app.post('/create-order', async (req, res) => {
  try {
    const {
      designUrl,
      variantId,
      customerName,
      customerEmail,
      address1,
      address2,
      city,
      stateCode,
      countryCode,
      zip
    } = req.body;

    if (!designUrl || !variantId || !customerName || !customerEmail || !address1 || !city || !countryCode || !zip) {
      return res.status(400).json({ success: false, error: 'Missing required order fields' });
    }

    console.log(`[ORDER] Creating order for ${customerName}, variant ${variantId}`);

    const orderPayload = {
      recipient: {
        name:         customerName,
        email:        customerEmail,
        address1,
        address2:     address2 || '',
        city,
        state_code:   stateCode || '',
        country_code: countryCode,
        zip
      },
      items: [
        {
          variant_id: variantId,
          quantity:   1,
          files: [{ type: 'front', url: designUrl }]
        }
      ]
    };

    const r = await axios.post(
      'https://api.printful.com/orders',
      orderPayload,
      { headers: printfulHeaders() }
    );

    console.log(`[ORDER] ✅ Created: ${r.data?.result?.id}`);
    return res.json({
      success: true,
      orderId: r.data?.result?.id,
      status:  r.data?.result?.status
    });

  } catch (err) {
    console.error('[ORDER] Error:', JSON.stringify(safeError(err)));
    return res.status(500).json({ success: false, error: safeError(err) });
  }
});

app.listen(PORT, () => {
  console.log(`[BOOT] Server running on port ${PORT}`);
});
