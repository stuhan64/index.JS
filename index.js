// index.js — Express backend for AstroApp + Printful

const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

// === CONFIG ===
const ASTROAPP_API_KEY = process.env.ASTROAPP_API_KEY || 'p4Y5dCexJEb7Uzeg';
const PRINTFUL_API_KEY = process.env.PRINTFUL_API_KEY || 'mPfVWqduOUCtQfPstyyaG2hsOuKhjqKSzh7NiYt8';

// === 1. Receive birth data from front-end ===
app.post('/generate-chart', async (req, res) => {
  const { name, birthDate, birthTime, birthLocation } = req.body;

  try {
    // === 2. Call AstroApp API ===
    const astroRes = await axios.post('https://api.astroapp.com/api/v1/chart/natal', {
      apiKey: ASTROAPP_API_KEY,
      name,
      birthDate,
      birthTime,
      birthLocation,
      chartFormat: 'png'
    });

    const chartImageUrl = astroRes.data.chartImageUrl;

    // === 3. Download chart image ===
    const imgRes = await axios.get(chartImageUrl, { responseType: 'stream' });
    const imagePath = path.join(__dirname, 'chart.png');
    const writer = fs.createWriteStream(imagePath);
    imgRes.data.pipe(writer);

    writer.on('finish', async () => {
      // === 4. Upload to Printful ===
      const form = new FormData();
      form.append('file', fs.createReadStream(imagePath));

      const uploadRes = await axios.post('https://api.printful.com/files', form, {
        headers: {
          Authorization: `Bearer ${PRINTFUL_API_KEY}`,
          ...form.getHeaders(),
        },
      });

      const printfulFileUrl = uploadRes.data.result.url;

      // === 5. Respond to front-end ===
      res.json({ success: true, imageUrl: printfulFileUrl });
    });

    writer.on('error', () => {
      throw new Error('Failed to write image stream to file');
    });

  } catch (err) {
    console.error('Error generating chart or uploading to Printful:', err);
    res.status(500).json({ error: 'Chart generation failed.' });
  }
});

app.listen(port, () => {
  console.log(`AstroApp backend running on port ${port}`);
});

