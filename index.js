// index.js - AstroApp + Shopify Backend Integration (Improved with logging, time zone, etc.)

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

// === Endpoint to receive birth data from Shopify ===
app.post('/', async (req, res) => {
  const { birthDate, birthTime, birthLocation } = req.body;

  try {
    console.log("📥 Incoming request:", { birthDate, birthTime, birthLocation });

    // Step 1: Geocode location
    const geoURL = `https://api.opencagedata.com/geocode/v1/json?q=${encodeURIComponent(birthLocation)}&key=${OPENCAGE_KEY}`;
    const geoResponse = await axios.get(geoURL);
    const geoData = geoResponse.data.results[0];

    const lat = geoData.geometry.lat;
    const lng = geoData.geometry.lng;
    const timezone = geoData.annotations?.timezone?.name || "UTC";

    console.log("📍 Geolocation:", { lat, lng, timezone });

    // Step 2: Combine date and time (assumes user sent proper ISO-like strings)
    const birthDateTime = `${birthDate}T${birthTime}:00`;
    console.log("🕒 Birth DateTime:", birthDateTime);

    // Step 3: Build chart request payload
    const chartPayload = {
      chart: {
        chartData: {
          chartName: "Customer Chart",
          chartDate: birthDateTime,
          lat,
          lng,
          elev: 1,
          tz: timezone,
          zodiacID: 100,
          houseSystemID: 1,
          coordSys: "G",
          version: 1
        }
      },
      calcRequestProps: {
        needImage: "Y",
        needAspects: "N",
        needHousePlacements: "Y"
      },
      params: {
        objects: [0, 1, 24] // Sun, Moon, ASC
      }
    };

    const credentials = Buffer.from(`${ASTROAPP_EMAIL}:${ASTROAPP_PASS}`).toString('base64');

    // Step 4: Call AstroApp API
    const chartResponse = await axios.post('https://astroapp.com/astro/apis/chart', chartPayload, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${credentials}`,
        'Key': ASTROAPP_KEY
      }
    });

    // Step 5: Log and extract image URL
    console.log("📦 AstroApp response:", JSON.stringify(chartResponse.data, null, 2));

    const imageUrl = chartResponse.data?.chartData?.imgPath;

    if (!imageUrl) {
      console.error("⚠️ No image URL returned from AstroApp response:", chartResponse.data);
      throw new Error("No chart image returned from AstroApp");
    }

    res.json({ success: true, imageUrl });

  } catch (err) {
    console.error("❌ Error creating chart:", err.response?.data || err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

