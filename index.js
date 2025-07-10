// index.js - AstroApp + Shopify Backend Integration

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

app.post('/', async (req, res) => {
  const { birthDate, birthTime, birthLocation } = req.body;

  try {
    // Step 1: Geocode location
    const geoURL = `https://api.opencagedata.com/geocode/v1/json?q=${encodeURIComponent(birthLocation)}&key=${OPENCAGE_KEY}`;
    const geoResponse = await axios.get(geoURL);
    const geo = geoResponse.data.results[0].geometry;
    const lat = geo.lat;
    const lng = geo.lng;

    // Step 2: Combine date and time
    const birthDateTime = `${birthDate}T${birthTime}:00`;

    // Step 3: Build chart creation payload
    const chartPayload = {
      chart: {
        chartData: {
          chartName: "Customer Chart",
          chartDate: birthDateTime,
          lat,
          lng,
          elev: 1,
          tz: "UTC",
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
        objects: [0, 1, 24] // Sun, Moon, ASC
      }
    };

    const credentials = Buffer.from(`${ASTROAPP_EMAIL}:${ASTROAPP_PASS}`).toString('base64');

    // Step 4: Create chart and get chartID
    const chartResponse = await axios.post('https://astroapp.com/astro/apis/chart', chartPayload, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${credentials}`,
        'Key': ASTROAPP_KEY
      }
    });

    const chartID = chartResponse.data.chartID;

    // Step 5: Request image using chartID
    const imagePayload = {
      chartID,
      imageWidth: 1200,
      imageHeight: 1200,
      imageType: "png"
    };

    const imageResponse = await axios.post('https://astroapp.com/astro/apis/chart/image', imagePayload, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${credentials}`,
        'Key': ASTROAPP_KEY
      }
    });

    const imageUrl = imageResponse.data.imageUrl || 'https://placehold.co/400x400?text=Chart+Unavailable';

    res.json({ success: true, imageUrl });

  } catch (err) {
    console.error("❌ Error creating chart:", err.response?.data || err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
