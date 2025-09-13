// server.js
const express = require("express");
const { exec } = require("child_process");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;

const PUBLIC_DIR = path.join(__dirname, "public");
const OUTPUT_PATH = path.join(PUBLIC_DIR, "latest.jpg");

// serve the frontend
app.use(express.static(PUBLIC_DIR));

// capture route
app.post("/capture", async (_req, res) => {
  try {
    // Ensure output dir exists
    fs.mkdirSync(PUBLIC_DIR, { recursive: true });

    // Take a shot to stdout, pipe to ImageMagick to make grayscale, save to public/latest.jpg
    // -n = no preview, -t 1 ~ minimal delay
    const cmd = `rpicam-still -n -t 1 -o - | convert - -colorspace Gray -auto-level -contrast-stretch 0.5%x0.5% "${OUTPUT_PATH}"`;

    exec(cmd, { timeout: 15000 }, (err, stdout, stderr) => {
      if (err) {
        console.error("Capture error:", err, stderr);
        return res.status(500).json({ ok: false, error: "Capture failed" });
      }
      // Cache-bust the image on the frontend
      const url = `/latest.jpg?ts=${Date.now()}`;
      return res.json({ ok: true, url });
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

app.listen(PORT, () => {
  console.log(`Pi BnW cam listening on http://localhost:${PORT}`);
});
