// index.js — AstroApp + Printful + Shopify Backend (v6)
const express  = require('express');
const axios    = require('axios');
const cors     = require('cors');
const sharp    = require('sharp');
const FormData = require('form-data');
const crypto   = require('crypto');

const app = express();
app.use(cors());

// Store raw body for webhook HMAC verification before express.json() parses it
app.use((req, res, next) => {
  if (req.path === '/webhook-order') {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      req.rawBody = raw;
      try { req.body = JSON.parse(raw); } catch(e) { req.body = {}; }
      next();
    });
  } else {
    express.json()(req, res, next);
  }
});

const PORT = process.env.PORT || 10000;

// === CONFIGURATION ===
const ASTROAPP_KEY     = process.env.ASTROAPP_KEY;
const ASTROAPP_USER    = process.env.ASTROAPP_USER;
const ASTROAPP_PASS    = process.env.ASTROAPP_PASS;
const OPENCAGE_KEY     = process.env.OPENCAGE_KEY;
const TIMEZONEDB_KEY   = process.env.TIMEZONEDB_KEY;
const PRINTFUL_KEY     = process.env.PRINTFUL_KEY;
const PRINTFUL_STORE_ID = process.env.PRINTFUL_STORE_ID || '16293860';
const IMGBB_KEY             = process.env.IMGBB_KEY;
const CLOUDINARY_CLOUD      = process.env.CLOUDINARY_CLOUD;
const CLOUDINARY_KEY        = process.env.CLOUDINARY_KEY;
const CLOUDINARY_SECRET     = process.env.CLOUDINARY_SECRET;
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;
const SHOPIFY_STORE          = process.env.SHOPIFY_STORE || 'zodi-gear.myshopify.com';

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
checkEnv('IMGBB_KEY',              IMGBB_KEY);
checkEnv('SHOPIFY_WEBHOOK_SECRET', SHOPIFY_WEBHOOK_SECRET);

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
// AstroApp tokens expire after 100 uses OR 60 minutes — whichever comes first
let cachedToken   = null;
let tokenExpiry   = 0;
let tokenUseCount = 0;
const TOKEN_MAX_USES = 90; // refresh at 90 uses, safely before the 100 limit

function getCachedToken() {
  if (cachedToken && Date.now() < tokenExpiry - 30000 && tokenUseCount < TOKEN_MAX_USES) {
    tokenUseCount++;
    console.log('[TOKEN] Using cached token (use #' + tokenUseCount + ')');
    return cachedToken;
  }
  if (cachedToken) {
    console.log('[TOKEN] Token invalidated — refreshing');
  }
  cachedToken   = null;
  tokenExpiry   = 0;
  tokenUseCount = 0;
  return null;
}

function cacheToken(jwt) {
  cachedToken   = jwt;
  tokenExpiry   = Date.now() + (55 * 60 * 1000);
  tokenUseCount = 1;
  console.log('[TOKEN] Token cached (fresh)');
}

function isExpiredResponse(data) {
  if (typeof data === 'string' && data.trim().toUpperCase() === 'EXPIRED') return true;
  if (data?.jwt === 'EXPIRED' || data?.token === 'EXPIRED') return true;
  return false;
}

// === ASTROAPP CHART REQUEST ===
async function fetchChart(payload, useBasicAuth) {
  const authHeader = useBasicAuth
    ? encodeBasicAuth(ASTROAPP_USER, ASTROAPP_PASS)
    : 'Bearer ' + cachedToken;

  console.log('[ASTRO] Calling chart API with ' + (useBasicAuth ? 'Basic Auth' : 'Bearer token'));

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

  // Check for EXPIRED token response
  if (isExpiredResponse(response.data)) {
    console.warn('[TOKEN] AstroApp returned EXPIRED — clearing token');
    cachedToken = null; tokenExpiry = 0; tokenUseCount = 0;
    throw new Error('TOKEN_EXPIRED');
  }

  // Cache fresh JWT if returned
  const jwt = response.data?.jwt || response.data?.token;
  if (jwt && jwt !== 'EXPIRED') {
    cacheToken(jwt);
  }

  return response.data;
}

// Main chart fetch — Bearer token first, auto-retry with Basic Auth on failure or expiry
async function getChart(payload) {
  const token = getCachedToken();

  if (token) {
    try {
      return await fetchChart(payload, false);
    } catch (err) {
      console.warn('[ASTRO] Bearer failed (' + err.message + '), retrying with Basic Auth...');
      cachedToken = null; tokenExpiry = 0; tokenUseCount = 0;
    }
  }

  // Basic Auth — always works, also returns fresh token
  try {
    return await fetchChart(payload, true);
  } catch (err) {
    if (err.message === 'TOKEN_EXPIRED') {
      console.warn('[ASTRO] EXPIRED on Basic Auth, retrying once...');
      return await fetchChart(payload, true);
    }
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

// === VARIANT ID LOOKUP MAP ===
const VARIANT_MAP = {
  wheel: {
    womens: {
      S: 4873605214, M: 4873605215, L: 4873605216, XL: 4873605217, '2XL': 4873605218
    },
    unisex: {
      S: 4871492274, M: 4871492277, L: 4871492278, XL: 4871492279,
      '2XL': 4871492280, '3XL': 4871492281, '4XL': 4871492282, '5XL': 4871492283
    }
  },
  trio: {
    womens: {
      S: 4872341918, M: 4872341919, L: 4872341920, XL: 4872341921, '2XL': 4872341922
    },
    unisex: {
      S: 5279671752, M: 5279671753, L: 5279671754, XL: 5279671755,
      '2XL': 5279671757, '3XL': 5279671758, '4XL': 5279671759, '5XL': 5279671760
    }
  }
};

function getVariantId(design, fit, size) {
  const variantId = VARIANT_MAP[design]?.[fit]?.[size];
  return variantId || null;
}

// Create Printful order
app.post('/create-order', async (req, res) => {
  try {
    const {
      designUrl,
      design,       // 'wheel' or 'trio'
      fit,          // 'womens' or 'unisex'
      size,         // 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL'
      customerName,
      customerEmail,
      address1,
      address2,
      city,
      stateCode,
      countryCode,
      zip
    } = req.body;

    if (!designUrl || !design || !fit || !size || !customerName || !customerEmail || !address1 || !city || !countryCode || !zip) {
      return res.status(400).json({ success: false, error: 'Missing required order fields' });
    }

    const variantId = getVariantId(design, fit, size);
    if (!variantId) {
      return res.status(400).json({
        success: false,
        error: `No variant found for design=${design}, fit=${fit}, size=${size}`
      });
    }

    console.log(`[ORDER] Creating order for ${customerName} — ${design}/${fit}/${size} (variant ${variantId})`);

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
      success:   true,
      orderId:   r.data?.result?.id,
      status:    r.data?.result?.status,
      variantId,
      design, fit, size
    });

  } catch (err) {
    console.error('[ORDER] Error:', JSON.stringify(safeError(err)));
    return res.status(500).json({ success: false, error: safeError(err) });
  }
});


// === UPLOAD DESIGN — composites trio signs and uploads to imgbb ===
// Returns a real hosted URL that Printful can fetch for printing
app.post('/upload-design', async (req, res) => {
  try {
    const { sun, moon, rising, type } = req.body;

    if (!sun || !moon || !rising || !type) {
      return res.status(400).json({ success: false, error: 'Missing sun, moon, rising, or type' });
    }

    if (!IMGBB_KEY) {
      return res.status(500).json({ success: false, error: 'IMGBB_KEY not configured' });
    }

    const CDN = 'https://cdn.shopify.com/s/files/1/0936/4534/0969/files/';

    if (type === 'trio') {
      console.log(`[UPLOAD] Compositing trio: rising=${rising}, sun=${sun}, moon=${moon}`);

      // Download all three sign images
      const [risingBuf, sunBuf, moonBuf] = await Promise.all([
        axios.get(CDN + 'rising.' + rising + '.png', { responseType: 'arraybuffer' }).then(r => Buffer.from(r.data)),
        axios.get(CDN + 'sun.'    + sun    + '.png', { responseType: 'arraybuffer' }).then(r => Buffer.from(r.data)),
        axios.get(CDN + 'moon.'   + moon   + '.png', { responseType: 'arraybuffer' }).then(r => Buffer.from(r.data))
      ]);

      // Size constants - Sun dominant, Rising/Moon at 43%
      // 2400px wide for high quality DTG print (300 DPI at 8 inches)
      const sunSize    = 900;
      const smallSize  = 390;
      const lineW      = sunSize;
      const lineH      = 6;
      const gap        = 36;
      const canvasW    = sunSize + 80;
      const canvasH    = smallSize + gap + lineH + gap + sunSize + gap + lineH + gap + smallSize + 40;

      // Resize images — keep transparent backgrounds for proper compositing
      const [risingResized, sunResized, moonResized] = await Promise.all([
        sharp(risingBuf).resize(smallSize, smallSize, { fit: 'contain', background: { r:255,g:255,b:255,alpha:0 } }).png().toBuffer(),
        sharp(sunBuf).resize(sunSize, sunSize, { fit: 'contain', background: { r:255,g:255,b:255,alpha:0 } }).png().toBuffer(),
        sharp(moonBuf).resize(smallSize, smallSize, { fit: 'contain', background: { r:255,g:255,b:255,alpha:0 } }).png().toBuffer()
      ]);

      // Create divider line (dark gray, semi-transparent)
      const lineBuf = await sharp({
        create: { width: lineW, height: lineH, channels: 4,
                  background: { r: 60, g: 60, b: 60, alpha: 180 } }
      }).png().toBuffer();

      // Calculate vertical positions
      const cx       = Math.floor((canvasW - sunSize) / 2);
      const rLeft    = Math.floor((canvasW - smallSize) / 2);
      let y = 10;

      const risingTop = y;                              y += smallSize + gap;
      const line1Top  = y;                              y += lineH    + gap;
      const sunTop    = y;                              y += sunSize  + gap;
      const line2Top  = y;                              y += lineH    + gap;
      const moonTop   = y;

      // Composite onto WHITE background (required for DTG printing)
      const composite = await sharp({
        create: { width: canvasW, height: canvasH, channels: 3,
                  background: { r: 255, g: 255, b: 255 } }
      })
      .composite([
        { input: risingResized, top: risingTop, left: rLeft },
        { input: lineBuf,       top: line1Top,  left: Math.floor((canvasW - lineW) / 2) },
        { input: sunResized,    top: sunTop,    left: cx },
        { input: lineBuf,       top: line2Top,  left: Math.floor((canvasW - lineW) / 2) },
        { input: moonResized,   top: moonTop,   left: rLeft }
      ])
      .png()
      .toBuffer();

      // Upload to Cloudinary
      if (!CLOUDINARY_CLOUD || !CLOUDINARY_KEY || !CLOUDINARY_SECRET) {
        throw new Error('Cloudinary credentials not configured');
      }

      // Use Cloudinary's unsigned upload preset to avoid signature issues
      // Create an unsigned upload preset in Cloudinary dashboard first
      const base64Image = composite.toString('base64');

      const form = new FormData();
      form.append('file',           'data:image/png;base64,' + base64Image);
      form.append('upload_preset',  'zodigear_unsigned');
      form.append('folder',         'zodigear');

      const uploadRes = await axios.post(
        'https://api.cloudinary.com/v1_1/' + CLOUDINARY_CLOUD + '/image/upload',
        form,
        { headers: form.getHeaders(), timeout: 30000 }
      );

      const url = uploadRes.data?.secure_url;
      if (!url) throw new Error('Cloudinary upload failed: ' + JSON.stringify(uploadRes.data));

      console.log('[UPLOAD] Trio uploaded to Cloudinary:', url);
      return res.json({ success: true, url, type: 'trio' });

    } else if (type === 'wheel') {
      // Wheel: download from AstroApp and re-upload to Cloudinary
      // AstroApp URLs are temporary and may not be accessible by Printful
      const { imageUrl } = req.body;
      if (!imageUrl) {
        return res.status(400).json({ success: false, error: 'Missing imageUrl for wheel upload' });
      }

      console.log('[UPLOAD] Re-hosting wheel image from AstroApp to Cloudinary...');

      const imgRes = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 20000 });
      const imgBuf = Buffer.from(imgRes.data);

      const form = new FormData();
      form.append('file',          'data:image/png;base64,' + imgBuf.toString('base64'));
      form.append('upload_preset', 'zodigear_unsigned');
      form.append('folder',        'zodigear');

      const uploadRes = await axios.post(
        'https://api.cloudinary.com/v1_1/' + CLOUDINARY_CLOUD + '/image/upload',
        form,
        { headers: form.getHeaders(), timeout: 30000 }
      );

      const url = uploadRes.data?.secure_url;
      if (!url) throw new Error('Cloudinary wheel upload failed: ' + JSON.stringify(uploadRes.data));

      console.log('[UPLOAD] Wheel uploaded to Cloudinary:', url);
      return res.json({ success: true, url, type: 'wheel' });

    } else {
      return res.status(400).json({ success: false, error: 'Unknown design type: ' + type });
    }

  } catch (err) {
    console.error('[UPLOAD] Error:', JSON.stringify(safeError(err)));
    return res.status(500).json({ success: false, error: err.message });
  }
});


// === SHOPIFY WEBHOOK — order created/paid ===
// Shopify sends order data here when payment is confirmed
// We read the custom design URL from line item properties and submit to Printful

// Webhook needs raw body for HMAC verification — must be registered BEFORE express.json()
// We handle this by reading raw body manually

// Track recently processed orders to prevent duplicate webhook processing
const processedOrders = new Set();

app.post('/webhook-order', async (req, res) => {
  try {
    // Verify Shopify HMAC signature
    const hmacHeader = req.headers['x-shopify-hmac-sha256'];
    if (SHOPIFY_WEBHOOK_SECRET && hmacHeader) {
      const hash = crypto
        .createHmac('sha256', SHOPIFY_WEBHOOK_SECRET)
        .update(req.rawBody || '')
        .digest('base64');
      if (hash !== hmacHeader) {
        console.warn('[WEBHOOK] HMAC verification failed');
        return res.status(401).json({ error: 'Unauthorized' });
      }
    }

    const order = req.body;

    // Deduplicate
    const orderKey = String(order.id);
    if (processedOrders.has(orderKey)) {
      console.log('[WEBHOOK] Duplicate for order ' + order.order_number + ' — skipping');
      return res.status(200).json({ received: true, duplicate: true });
    }
    processedOrders.add(orderKey);
    setTimeout(() => processedOrders.delete(orderKey), 600000);

    console.log('[WEBHOOK] Order received: #' + order.order_number + ' (' + order.id + ')');

    // Build ORDERED array of designs — preserves order to match Printful items positionally
    // We cannot use variant_id as key because multiple items can have the same variant
    const itemDesigns = [];
    for (const item of order.line_items || []) {
      const props = {};
      for (const p of item.properties || []) { props[p.name] = p.value; }
      if (props['Custom Design URL']) {
        itemDesigns.push({
          variantId:  String(item.variant_id),
          designUrl:  props['Custom Design URL'],
          designType: props['Design Type'],
          sunSign:    props['Sun Sign'],
          moonSign:   props['Moon Sign'],
          risingSign: props['Rising Sign'],
          title:      item.title
        });
        console.log('[WEBHOOK] Item: ' + item.title + ' | variant=' + item.variant_id + ' | design=' + props['Design Type'] + ' | sun=' + props['Sun Sign'] + '/' + props['Moon Sign'] + '/' + props['Rising Sign']);
      }
    }

    if (itemDesigns.length === 0) {
      console.log('[WEBHOOK] No custom designs in order — skipping');
      return res.status(200).json({ received: true });
    }

    // Wait 30s for Printful to create draft order
    console.log('[WEBHOOK] Waiting 30s for Printful to create draft order...');
    await new Promise(resolve => setTimeout(resolve, 30000));

    // Find Printful order by external_id
    let pfOrderId = null;
    let pfItems   = [];

    try {
      const r = await axios.get(
        'https://api.printful.com/orders?external_id=' + order.id,
        { headers: printfulHeaders() }
      );
      const results = r.data?.result || [];
      if (results.length > 0) {
        pfOrderId = results[0].id;
        // Get full order details including items
        const detail = await axios.get(
          'https://api.printful.com/orders/' + pfOrderId,
          { headers: printfulHeaders() }
        );
        pfItems = detail.data?.result?.items || results[0].items || [];
        console.log('[WEBHOOK] Found Printful order ' + pfOrderId + ' with ' + pfItems.length + ' items');
      }
    } catch (e) {
      console.warn('[WEBHOOK] Search failed:', e.message);
    }

    // Try recent orders if not found
    if (!pfOrderId) {
      try {
        const r = await axios.get(
          'https://api.printful.com/orders?limit=20',
          { headers: printfulHeaders() }
        );
        const match = (r.data?.result || []).find(o =>
          String(o.external_id) === String(order.id) ||
          o.external_id === order.name
        );
        if (match) {
          pfOrderId = match.id;
          const detail = await axios.get(
            'https://api.printful.com/orders/' + pfOrderId,
            { headers: printfulHeaders() }
          );
          pfItems = detail.data?.result?.items || match.items || [];
          console.log('[WEBHOOK] Found in recent: ' + pfOrderId + ' with ' + pfItems.length + ' items');
        }
      } catch (e) {
        console.warn('[WEBHOOK] Recent search failed:', e.message);
      }
    }

    if (!pfOrderId) {
      console.warn('[WEBHOOK] Could not find Printful order for Shopify order ' + order.id);
      for (const [vid, d] of Object.entries(itemDesigns)) {
        console.warn('[WEBHOOK] Manual update needed — variant=' + vid + ' url=' + d.designUrl);
      }
      return res.status(200).json({ received: true });
    }

    // Match Printful items to designs positionally
    // Sort both arrays by variant ID to align them, then match by position
    // This handles duplicate variants (two people ordering same size)
    console.log('[WEBHOOK] Matching ' + pfItems.length + ' Printful items to ' + itemDesigns.length + ' designs...');

    // Sort Printful items by their sync_variant_id for consistent ordering
    const sortedPfItems = [...pfItems].sort((a, b) => {
      const va = a.sync_variant_id || a.variant_id || 0;
      const vb = b.sync_variant_id || b.variant_id || 0;
      return String(va).localeCompare(String(vb));
    });

    // Sort Shopify designs by Printful variant ID for same ordering
    const sortedDesigns = [...itemDesigns].sort((a, b) => {
      const va = shopifyToPrintfulVariant(a.variantId) || 0;
      const vb = shopifyToPrintfulVariant(b.variantId) || 0;
      return String(va).localeCompare(String(vb));
    });

    const updatedItems = sortedPfItems.map((pfItem, index) => {
      const design = sortedDesigns[index] || sortedDesigns[0];
      console.log('[WEBHOOK] Matched Printful item ' + pfItem.id + ' -> ' + design.designType + ' (' + design.sunSign + '/' + design.moonSign + '/' + design.risingSign + ')');
      return { id: pfItem.id, files: [{ type: 'front', url: design.designUrl }] };
    });

    // Update all items in one PUT call
    try {
      const updateRes = await axios.put(
        'https://api.printful.com/orders/' + pfOrderId,
        { items: updatedItems },
        { headers: printfulHeaders() }
      );

      if (updateRes.data?.result) {
        console.log('[WEBHOOK] All print files updated on order ' + pfOrderId);

        // Auto-confirm
        try {
          await axios.post(
            'https://api.printful.com/orders/' + pfOrderId + '/confirm',
            {},
            { headers: printfulHeaders() }
          );
          console.log('[WEBHOOK] Order ' + pfOrderId + ' confirmed for fulfillment');
        } catch (ce) {
          console.warn('[WEBHOOK] Auto-confirm failed (manual confirm needed):', ce.response?.data?.result || ce.message);
        }
      } else {
        console.warn('[WEBHOOK] Unexpected update response:', JSON.stringify(updateRes.data));
      }
    } catch (ue) {
      console.error('[WEBHOOK] Update failed:', JSON.stringify(safeError(ue)));
      for (const d of itemDesigns) {
        console.error('[WEBHOOK] Manual update URL:', d.designUrl);
      }
    }

    return res.status(200).json({ received: true });

  } catch (err) {
    console.error('[WEBHOOK] Error:', err.message);
    return res.status(200).json({ received: true, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`[BOOT] Server running on port ${PORT}`);
});  if (lng == null) return 'unknown';
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
// AstroApp tokens expire after 100 uses OR 60 minutes — whichever comes first
let cachedToken   = null;
let tokenExpiry   = 0;
let tokenUseCount = 0;
const TOKEN_MAX_USES = 90; // refresh at 90 uses, safely before the 100 limit

function getCachedToken() {
  if (cachedToken && Date.now() < tokenExpiry - 30000 && tokenUseCount < TOKEN_MAX_USES) {
    tokenUseCount++;
    console.log('[TOKEN] Using cached token (use #' + tokenUseCount + ')');
    return cachedToken;
  }
  if (cachedToken) {
    console.log('[TOKEN] Token invalidated — refreshing');
  }
  cachedToken   = null;
  tokenExpiry   = 0;
  tokenUseCount = 0;
  return null;
}

function cacheToken(jwt) {
  cachedToken   = jwt;
  tokenExpiry   = Date.now() + (55 * 60 * 1000);
  tokenUseCount = 1;
  console.log('[TOKEN] Token cached (fresh)');
}

function isExpiredResponse(data) {
  if (typeof data === 'string' && data.trim().toUpperCase() === 'EXPIRED') return true;
  if (data?.jwt === 'EXPIRED' || data?.token === 'EXPIRED') return true;
  return false;
}

// === ASTROAPP CHART REQUEST ===
async function fetchChart(payload, useBasicAuth) {
  const authHeader = useBasicAuth
    ? encodeBasicAuth(ASTROAPP_USER, ASTROAPP_PASS)
    : 'Bearer ' + cachedToken;

  console.log('[ASTRO] Calling chart API with ' + (useBasicAuth ? 'Basic Auth' : 'Bearer token'));

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

  // Check for EXPIRED token response
  if (isExpiredResponse(response.data)) {
    console.warn('[TOKEN] AstroApp returned EXPIRED — clearing token');
    cachedToken = null; tokenExpiry = 0; tokenUseCount = 0;
    throw new Error('TOKEN_EXPIRED');
  }

  // Cache fresh JWT if returned
  const jwt = response.data?.jwt || response.data?.token;
  if (jwt && jwt !== 'EXPIRED') {
    cacheToken(jwt);
  }

  return response.data;
}

// Main chart fetch — Bearer token first, auto-retry with Basic Auth on failure or expiry
async function getChart(payload) {
  const token = getCachedToken();

  if (token) {
    try {
      return await fetchChart(payload, false);
    } catch (err) {
      console.warn('[ASTRO] Bearer failed (' + err.message + '), retrying with Basic Auth...');
      cachedToken = null; tokenExpiry = 0; tokenUseCount = 0;
    }
  }

  // Basic Auth — always works, also returns fresh token
  try {
    return await fetchChart(payload, true);
  } catch (err) {
    if (err.message === 'TOKEN_EXPIRED') {
      console.warn('[ASTRO] EXPIRED on Basic Auth, retrying once...');
      return await fetchChart(payload, true);
    }
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

// === VARIANT ID LOOKUP MAP ===
const VARIANT_MAP = {
  wheel: {
    womens: {
      S: 4873605214, M: 4873605215, L: 4873605216, XL: 4873605217, '2XL': 4873605218
    },
    unisex: {
      S: 4871492274, M: 4871492277, L: 4871492278, XL: 4871492279,
      '2XL': 4871492280, '3XL': 4871492281, '4XL': 4871492282, '5XL': 4871492283
    }
  },
  trio: {
    womens: {
      S: 4872341918, M: 4872341919, L: 4872341920, XL: 4872341921, '2XL': 4872341922
    },
    unisex: {
      S: 5279671752, M: 5279671753, L: 5279671754, XL: 5279671755,
      '2XL': 5279671757, '3XL': 5279671758, '4XL': 5279671759, '5XL': 5279671760
    }
  }
};

function getVariantId(design, fit, size) {
  const variantId = VARIANT_MAP[design]?.[fit]?.[size];
  return variantId || null;
}

// Create Printful order
app.post('/create-order', async (req, res) => {
  try {
    const {
      designUrl,
      design,       // 'wheel' or 'trio'
      fit,          // 'womens' or 'unisex'
      size,         // 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL'
      customerName,
      customerEmail,
      address1,
      address2,
      city,
      stateCode,
      countryCode,
      zip
    } = req.body;

    if (!designUrl || !design || !fit || !size || !customerName || !customerEmail || !address1 || !city || !countryCode || !zip) {
      return res.status(400).json({ success: false, error: 'Missing required order fields' });
    }

    const variantId = getVariantId(design, fit, size);
    if (!variantId) {
      return res.status(400).json({
        success: false,
        error: `No variant found for design=${design}, fit=${fit}, size=${size}`
      });
    }

    console.log(`[ORDER] Creating order for ${customerName} — ${design}/${fit}/${size} (variant ${variantId})`);

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
      success:   true,
      orderId:   r.data?.result?.id,
      status:    r.data?.result?.status,
      variantId,
      design, fit, size
    });

  } catch (err) {
    console.error('[ORDER] Error:', JSON.stringify(safeError(err)));
    return res.status(500).json({ success: false, error: safeError(err) });
  }
});


// === UPLOAD DESIGN — composites trio signs and uploads to imgbb ===
// Returns a real hosted URL that Printful can fetch for printing
app.post('/upload-design', async (req, res) => {
  try {
    const { sun, moon, rising, type } = req.body;

    if (!sun || !moon || !rising || !type) {
      return res.status(400).json({ success: false, error: 'Missing sun, moon, rising, or type' });
    }

    if (!IMGBB_KEY) {
      return res.status(500).json({ success: false, error: 'IMGBB_KEY not configured' });
    }

    const CDN = 'https://cdn.shopify.com/s/files/1/0936/4534/0969/files/';

    if (type === 'trio') {
      console.log(`[UPLOAD] Compositing trio: rising=${rising}, sun=${sun}, moon=${moon}`);

      // Download all three sign images
      const [risingBuf, sunBuf, moonBuf] = await Promise.all([
        axios.get(CDN + 'rising.' + rising + '.png', { responseType: 'arraybuffer' }).then(r => Buffer.from(r.data)),
        axios.get(CDN + 'sun.'    + sun    + '.png', { responseType: 'arraybuffer' }).then(r => Buffer.from(r.data)),
        axios.get(CDN + 'moon.'   + moon   + '.png', { responseType: 'arraybuffer' }).then(r => Buffer.from(r.data))
      ]);

      // Size constants - Sun dominant, Rising/Moon at 43%
      // 2400px wide for high quality DTG print (300 DPI at 8 inches)
      const sunSize    = 900;
      const smallSize  = 390;
      const lineW      = sunSize;
      const lineH      = 6;
      const gap        = 36;
      const canvasW    = sunSize + 80;
      const canvasH    = smallSize + gap + lineH + gap + sunSize + gap + lineH + gap + smallSize + 40;

      // Resize images — keep transparent backgrounds for proper compositing
      const [risingResized, sunResized, moonResized] = await Promise.all([
        sharp(risingBuf).resize(smallSize, smallSize, { fit: 'contain', background: { r:255,g:255,b:255,alpha:0 } }).png().toBuffer(),
        sharp(sunBuf).resize(sunSize, sunSize, { fit: 'contain', background: { r:255,g:255,b:255,alpha:0 } }).png().toBuffer(),
        sharp(moonBuf).resize(smallSize, smallSize, { fit: 'contain', background: { r:255,g:255,b:255,alpha:0 } }).png().toBuffer()
      ]);

      // Create divider line (dark gray, semi-transparent)
      const lineBuf = await sharp({
        create: { width: lineW, height: lineH, channels: 4,
                  background: { r: 60, g: 60, b: 60, alpha: 180 } }
      }).png().toBuffer();

      // Calculate vertical positions
      const cx       = Math.floor((canvasW - sunSize) / 2);
      const rLeft    = Math.floor((canvasW - smallSize) / 2);
      let y = 10;

      const risingTop = y;                              y += smallSize + gap;
      const line1Top  = y;                              y += lineH    + gap;
      const sunTop    = y;                              y += sunSize  + gap;
      const line2Top  = y;                              y += lineH    + gap;
      const moonTop   = y;

      // Composite onto WHITE background (required for DTG printing)
      const composite = await sharp({
        create: { width: canvasW, height: canvasH, channels: 3,
                  background: { r: 255, g: 255, b: 255 } }
      })
      .composite([
        { input: risingResized, top: risingTop, left: rLeft },
        { input: lineBuf,       top: line1Top,  left: Math.floor((canvasW - lineW) / 2) },
        { input: sunResized,    top: sunTop,    left: cx },
        { input: lineBuf,       top: line2Top,  left: Math.floor((canvasW - lineW) / 2) },
        { input: moonResized,   top: moonTop,   left: rLeft }
      ])
      .png()
      .toBuffer();

      // Upload to Cloudinary
      if (!CLOUDINARY_CLOUD || !CLOUDINARY_KEY || !CLOUDINARY_SECRET) {
        throw new Error('Cloudinary credentials not configured');
      }

      // Use Cloudinary's unsigned upload preset to avoid signature issues
      // Create an unsigned upload preset in Cloudinary dashboard first
      const base64Image = composite.toString('base64');

      const form = new FormData();
      form.append('file',           'data:image/png;base64,' + base64Image);
      form.append('upload_preset',  'zodigear_unsigned');
      form.append('folder',         'zodigear');

      const uploadRes = await axios.post(
        'https://api.cloudinary.com/v1_1/' + CLOUDINARY_CLOUD + '/image/upload',
        form,
        { headers: form.getHeaders(), timeout: 30000 }
      );

      const url = uploadRes.data?.secure_url;
      if (!url) throw new Error('Cloudinary upload failed: ' + JSON.stringify(uploadRes.data));

      console.log('[UPLOAD] Trio uploaded to Cloudinary:', url);
      return res.json({ success: true, url, type: 'trio' });

    } else {
      // For wheel, just return the AstroApp URL — it's already a real URL
      return res.json({ success: false, error: 'Wheel URLs come directly from AstroApp — no upload needed' });
    }

  } catch (err) {
    console.error('[UPLOAD] Error:', JSON.stringify(safeError(err)));
    return res.status(500).json({ success: false, error: err.message });
  }
});


// === SHOPIFY WEBHOOK — order created/paid ===
// Shopify sends order data here when payment is confirmed
// We read the custom design URL from line item properties and submit to Printful

// Webhook needs raw body for HMAC verification — must be registered BEFORE express.json()
// We handle this by reading raw body manually

// Track recently processed orders to prevent duplicate webhook processing
const processedOrders = new Set();

app.post('/webhook-order', async (req, res) => {
  try {
    // Verify Shopify HMAC signature
    const hmacHeader = req.headers['x-shopify-hmac-sha256'];
    if (SHOPIFY_WEBHOOK_SECRET && hmacHeader) {
      const hash = crypto
        .createHmac('sha256', SHOPIFY_WEBHOOK_SECRET)
        .update(req.rawBody || '')
        .digest('base64');
      if (hash !== hmacHeader) {
        console.warn('[WEBHOOK] HMAC verification failed');
        return res.status(401).json({ error: 'Unauthorized' });
      }
    }

    const order = req.body;

    // Deduplicate
    const orderKey = String(order.id);
    if (processedOrders.has(orderKey)) {
      console.log('[WEBHOOK] Duplicate for order ' + order.order_number + ' — skipping');
      return res.status(200).json({ received: true, duplicate: true });
    }
    processedOrders.add(orderKey);
    setTimeout(() => processedOrders.delete(orderKey), 600000);

    console.log('[WEBHOOK] Order received: #' + order.order_number + ' (' + order.id + ')');

    // Build map: shopify_variant_id -> { designUrl, title, ... }
    const itemDesigns = {};
    for (const item of order.line_items || []) {
      const props = {};
      for (const p of item.properties || []) { props[p.name] = p.value; }
      if (props['Custom Design URL']) {
        itemDesigns[String(item.variant_id)] = {
          designUrl:  props['Custom Design URL'],
          designType: props['Design Type'],
          sunSign:    props['Sun Sign'],
          moonSign:   props['Moon Sign'],
          risingSign: props['Rising Sign'],
          title:      item.title
        };
        console.log('[WEBHOOK] Item: ' + item.title + ' | variant=' + item.variant_id + ' | design=' + props['Design Type'] + ' | url=' + props['Custom Design URL'].substring(0, 60) + '...');
      }
    }

    if (Object.keys(itemDesigns).length === 0) {
      console.log('[WEBHOOK] No custom designs in order — skipping');
      return res.status(200).json({ received: true });
    }

    // Wait 30s for Printful to create draft order
    console.log('[WEBHOOK] Waiting 30s for Printful to create draft order...');
    await new Promise(resolve => setTimeout(resolve, 30000));

    // Find Printful order by external_id
    let pfOrderId = null;
    let pfItems   = [];

    try {
      const r = await axios.get(
        'https://api.printful.com/orders?external_id=' + order.id,
        { headers: printfulHeaders() }
      );
      const results = r.data?.result || [];
      if (results.length > 0) {
        pfOrderId = results[0].id;
        // Get full order details including items
        const detail = await axios.get(
          'https://api.printful.com/orders/' + pfOrderId,
          { headers: printfulHeaders() }
        );
        pfItems = detail.data?.result?.items || results[0].items || [];
        console.log('[WEBHOOK] Found Printful order ' + pfOrderId + ' with ' + pfItems.length + ' items');
      }
    } catch (e) {
      console.warn('[WEBHOOK] Search failed:', e.message);
    }

    // Try recent orders if not found
    if (!pfOrderId) {
      try {
        const r = await axios.get(
          'https://api.printful.com/orders?limit=20',
          { headers: printfulHeaders() }
        );
        const match = (r.data?.result || []).find(o =>
          String(o.external_id) === String(order.id) ||
          o.external_id === order.name
        );
        if (match) {
          pfOrderId = match.id;
          const detail = await axios.get(
            'https://api.printful.com/orders/' + pfOrderId,
            { headers: printfulHeaders() }
          );
          pfItems = detail.data?.result?.items || match.items || [];
          console.log('[WEBHOOK] Found in recent: ' + pfOrderId + ' with ' + pfItems.length + ' items');
        }
      } catch (e) {
        console.warn('[WEBHOOK] Recent search failed:', e.message);
      }
    }

    if (!pfOrderId) {
      console.warn('[WEBHOOK] Could not find Printful order for Shopify order ' + order.id);
      for (const [vid, d] of Object.entries(itemDesigns)) {
        console.warn('[WEBHOOK] Manual update needed — variant=' + vid + ' url=' + d.designUrl);
      }
      return res.status(200).json({ received: true });
    }

    // Match each Printful item to its correct design by variant ID
    console.log('[WEBHOOK] Matching ' + pfItems.length + ' Printful items to ' + Object.keys(itemDesigns).length + ' designs...');

    const updatedItems = pfItems.map(pfItem => {
      const pfVariantId = pfItem.sync_variant_id || pfItem.variant_id;
      let designUrl = Object.values(itemDesigns)[0].designUrl; // fallback

      // Find matching design by looking up Shopify variant via our map
      for (const [shopifyVid, data] of Object.entries(itemDesigns)) {
        const pv = shopifyToPrintfulVariant(shopifyVid);
        if (pv && (String(pfVariantId) === String(pv))) {
          designUrl = data.designUrl;
          console.log('[WEBHOOK] Matched item ' + pfItem.id + ' (' + data.title + ') -> ' + data.designType);
          break;
        }
      }

      return { id: pfItem.id, files: [{ type: 'front', url: designUrl }] };
    });

    // Update all items in one PUT call
    try {
      const updateRes = await axios.put(
        'https://api.printful.com/orders/' + pfOrderId,
        { items: updatedItems },
        { headers: printfulHeaders() }
      );

      if (updateRes.data?.result) {
        console.log('[WEBHOOK] All print files updated on order ' + pfOrderId);

        // Auto-confirm
        try {
          await axios.post(
            'https://api.printful.com/orders/' + pfOrderId + '/confirm',
            {},
            { headers: printfulHeaders() }
          );
          console.log('[WEBHOOK] Order ' + pfOrderId + ' confirmed for fulfillment');
        } catch (ce) {
          console.warn('[WEBHOOK] Auto-confirm failed (manual confirm needed):', ce.response?.data?.result || ce.message);
        }
      } else {
        console.warn('[WEBHOOK] Unexpected update response:', JSON.stringify(updateRes.data));
      }
    } catch (ue) {
      console.error('[WEBHOOK] Update failed:', JSON.stringify(safeError(ue)));
      for (const [, d] of Object.entries(itemDesigns)) {
        console.error('[WEBHOOK] Manual update URL:', d.designUrl);
      }
    }

    return res.status(200).json({ received: true });

  } catch (err) {
    console.error('[WEBHOOK] Error:', err.message);
    return res.status(200).json({ received: true, error: err.message });
  }
});
// === SHOPIFY -> PRINTFUL VARIANT MAP ===
function shopifyToPrintfulVariant(shopifyVariantId) {
  const id = String(shopifyVariantId);
  const map = {
    // Unisex classic tee Sun, Moon, Rising
    "53045317239081": 5279671752,
    "53045317271849": 5279671753,
    "53045317304617": 5279671754,
    "53045317337385": 5279671755,
    "53045317370153": 5279671757,
    "53045317402921": 5279671758,
    "53045317435689": 5279671759,
    "53045317468457": 5279671760,
    // Women's basic softstyle Sun, Moon, Rising
    "50585098912041": 4872341918,
    "50585098944809": 4872341919,
    "50585098977577": 4872341920,
    "50585099010345": 4872341921,
    "50585099043113": 4872341922,
    // Unisex MeShirt - Zodiac Wheel
    "50580903526697": 4871492274,
    "50580903559465": 4871492277,
    "50580903592233": 4871492278,
    "50580903625001": 4871492279,
    "50580903657769": 4871492280,
    "50580903690537": 4871492281,
    "50580903723305": 4871492282,
    "50580903756073": 4871492283,
    // Women's basic softstyle - Zodiac Wheel
    "50591044763945": 4873605214,
    "50591044796713": 4873605215,
    "50591044829481": 4873605216,
    "50591044862249": 4873605217,
    "50591044895017": 4873605218
  };
  return map[id] || null;
}

app.listen(PORT, () => {
  console.log(`[BOOT] Server running on port ${PORT}`);
});
