app.post('/', async (req, res) => {
  const { birthDate, birthTime, birthLocation } = req.body;
  const dateTime = `${birthDate}T${birthTime}:00`;

  console.log("📩 Received front-end request:", req.body);

  try {
    const { lat, lng } = await geocodeLocation(birthLocation);
    const tz = await getTimeZone(lat, lng);
    const jwt = await getAstroToken();

    if (!jwt) throw new Error("Missing AstroApp token");

    const payload = {
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
        objects: [0, 1, 24]
      }
    };

    const astroResponse = await axios.post(
      'https://astroapp.com/astro/apis/chart',
      payload,
      {
        headers: {
          'Authorization': `Bearer ${jwt}`,
          'Content-Type': 'application/json',
          'Key': ASTROAPP_KEY
        }
      }
    );

    console.log("🪐 AstroApp response keys:", Object.keys(astroResponse.data));
    console.log("🖼️ Raw AstroApp response:", JSON.stringify(astroResponse.data, null, 2));

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
    console.error("❌ Chart generation error:", err.response?.data || err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});
