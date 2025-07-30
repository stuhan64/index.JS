const express = require('express');
const axios = require('axios');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// === CONFIGURATION ===
const ASTROAPP_KEY = process.env.ASTROAPP_KEY;
const ASTROAPP_USER = process.env.ASTROAPP_USER;
const ASTROAPP_PASS = process.env.ASTROAPP_PASS;

const OPENCAGE_KEY = process.env.OPENCAGE_KEY;
const TIMEZONEDB_KEY = process.env.TIMEZONEDB_KEY;

// === HELPER FUNCTIONS ===
async function getAstroToken() {
  try {
    const user = 'stuhan64@gmail.com';
    const pass = 'Emstujen64`';
    const apiKey = 'p4Y5dCexJEb7Uzeg';

    const basicAuth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');

    const response = await axios.post(
      'https://astroapp.com/astro/apis/token', // << Use this endpoint for token!
      {},
      {
        headers: {
          'Authorization': basicAuth,
          'Key': apiKey,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log("Token response:", response.data); // Add this temporarily
    return response.data.token;
  } catch (err) {
    console.error("AstroApp token error:", err.response?.data || err.message);
    return null;
  }
}

async function geocodeLocation(location) {
  const geoURL = `https://api.opencagedata.com/geocode/v1/json?q=${encodeURIComponent(location)}&key=${OPENCAGE_KEY}`;
  const res = await axios.get(geoURL);
  const { lat, lng } = res.data.results[0].geometry;
  return { lat, lng };
}

async function getTimeZone(lat, lng) {
  const tzURL = `https://api.timezonedb.com/v2.1/get-time-zone?key=${TIMEZONEDB_KEY}&format=json&by=position&lat=${lat}&lng=${lng}`;
  const res = await axios.get(tzURL);
  return res.data.zoneName;
}

// === MAIN API ROUTE ===
app.post('/', async (req, res) => {
  const { birthDate, birthTime, birthLocation } = req.body;
  const dateTime = `${birthDate}T${birthTime}:00`;

  try {
    const { lat, lng } = await geocodeLocation(birthLocation);
    const tz = await getTimeZone(lat, lng);
    const jwt = await getAstroToken();

    if (!jwt) throw new Error("Missing AstroApp token");

    const astroResponse = await axios.post(
      'https://astroapp.com/astro/apis/chart',
      {
        chart: {
          chartData: {
            chartName: "Customer Chart",
            chartDate: dateTime,
            elevation: 0,
            lat,
            lng,
            tz,
            zodiacID: 100,
            houseSystemID: 1,
            coordSys: "G",
            version: 1
          }
        },
        calcRequestProps: {
          needImage: "Y",
          needAspects: "N"
        },
        params: {
          objects: [0, 1, 24] // Sun, Moon, Asc
        }
      },
      {
        headers: {
          'Authorization': `Bearer ${jwt}`,
          'Content-Type': 'application/json',
          'Key': ASTROAPP_KEY
        }
      }
    );

    const imageUrl = astroResponse.data?.chartImageUrl || 'No image URL returned';
    const points = astroResponse.data?.chartPoints;

    const sunSign = points?.find(p => p.pointID === 0)?.signName || 'unknown';
    const moonSign = points?.find(p => p.pointID === 1)?.signName || 'unknown';
    const risingSign = points?.find(p => p.pointID === 24)?.signName || 'unknown';

    res.json({
      success: true,
      imageUrl,
      sun: sunSign,
      moon: moonSign,
      rising: risingSign
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log('Server running on port', PORT);
});
