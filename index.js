// index.js - AstroApp + Shopify Backend Integration (v2)

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const dotenv = require('dotenv');
dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

const ASTROAPP_EMAIL = process.env.ASTROAPP_EMAIL;
const ASTROAPP_PASS = process.env.ASTROAPP_PASS;
const ASTROAPP_KEY = process.env.ASTROAPP_KEY;
const OPENCAGE_KEY = process.env.OPENCAGE_KEY;

// --- Helper: zodiac sign from longitude ---
const ZODIAC_SIGNS = [
  'Aries',
  'Taurus',
  'Gemini',
  'Cancer',
  'Leo',
  'Virgo',
  'Libra',
  'Scorpio',
  'Sagittarius',
  'Capricorn',
  'Aquarius',
  'Pisces'
];

function getSignFromLongitude(lng) {
  if (typeof lng !== 'number' || Number.isNaN(lng)) return null;

  // Normalize to 0–360 just in case
  let normalized = lng % 360;
  if (normalized < 0) normalized += 360;

  const index = Math.floor(normalized / 30);
  return ZODIAC_SIGNS[index] || null;
}

// === Endpoint to receive birth data from Shopify ===
app.post('/', async (req, res) => {
  const { birthDate, birthTime, birthLocation } = req.body || {};

  if (!birthDate || !birthTime || !birthLocation) {
    return res.status(400).json({
      success: false,
      error: 'Missing required fields: birthDate, birthTime, birthLocation'
    });
  }

  try {
    // Step 1: Geocode location
    const geoURL = `https://api.opencagedata.com/geocode/v1/json?q=${encodeURIComponent(
      birthLocation
    )}&key=${OPENCAGE_KEY}`;

    const geoResponse = await axios.get(geoURL);
    const firstResult = geoResponse.data.results?.[0];

    if (!firstResult || !firstResult.geometry) {
      return res.status(400).json({
        success: false,
        error: 'Unable to geocode location. Please check the birth location.'
      });
    }

    const { lat, lng } = firstResult.geometry;

    // Step 2: Combine date and time
    const birthDateTime = `${birthDate}T${birthTime}:00`;

    // Step 3: Build chart request payload
    const chartPayload = {
      chart: {
        chartData: {
          chartName: 'Customer Chart',
          chartDate: birthDateTime,
          lat,
          lng,
          elev: 1,
          tz: 'UTC', // You can upgrade this later using time zone from OpenCage if desired
          zodiacID: 100,
          houseSystemID: 1,
          coordSys: 'G',
          version: 1
        }
      },
      calcRequestProps: {
        needImage: 'Y',
        needAspects: 'N'
      },
      params: {
        // 0 = Sun, 1 = Moon, 24 = Ascendant (per AstroApp docs / object IDs)
        objects: [0, 1, 24]
      }
    };

    // Basic auth credentials (if your account still uses this scheme)
    const credentials = Buffer.from(
      `${ASTROAPP_EMAIL}:${ASTROAPP_PASS}`
    ).toString('base64');

    // Step 4: Call AstroApp API
    const chartResponse = await axios.post(
      'https://astroapp.com/astro/apis/chart',
      chartPayload,
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Basic ${credentials}`,
          Key: ASTROAPP_KEY
        }
      }
    );

    const data = chartResponse.data || {};

    // Step 5: Chart image URL
    const imageUrl =
      data.imageUrl || 'https://placehold.co/400x400?text=Chart+Created';

    // Step 6: Extract Sun / Moon / Ascendant longitudes and convert to signs
    const objects = data.chart?.objects || data.objects || [];

    const findObj = (id) => objects.find((o) => o.id === id);

    const sunObj = findObj(0);
    const moonObj = findObj(1);
    const ascObj = findObj(24);

    const sunSign = sunObj ? getSignFromLongitude(sunObj.lng) : null;
    const moonSign = moonObj ? getSignFromLongitude(moonObj.lng) : null;
    const risingSign = ascObj ? getSignFromLongitude(ascObj.lng) : null;

    return res.json({
      success: true,
      imageUrl,
      sunSign,
      moonSign,
      risingSign
    });
  } catch (err) {
    // Log as much as possible without leaking secrets
    console.error(
      '❌ Error creating chart:',
      err.response?.data || err.message || err
    );

    const status = err.response?.status || 500;

    return res.status(status).json({
      success: false,
      error:
        err.response?.data?.message ||
        err.response?.data ||
        err.message ||
        'Unknown error from AstroApp'
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
