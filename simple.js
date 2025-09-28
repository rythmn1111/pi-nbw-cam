// simple.js - Minimal camera capture with button + web frontend
const { Gpio } = require("pigpio");
const { exec } = require("child_process");
const path = require("path");
const express = require("express");
const fs = require("fs");

// Web server setup
const app = express();
const PORT = 3000;
const IMAGES_DIR = path.join(__dirname, "images");

// Ensure images directory exists
fs.mkdirSync(IMAGES_DIR, { recursive: true });

// Serve static files
app.use(express.static(IMAGES_DIR));
app.use(express.static(path.join(__dirname, "public")));

// Button setup
const BUTTON_GPIO = 13;
let btn = null;
let latestImage = null;

// Simple capture function
function captureImage() {
  console.log("Button pressed - capturing image...");
  
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `capture_${timestamp}.jpg`;
  const filepath = path.join(IMAGES_DIR, filename);
  
  const cmd = `rpicam-still -o "${filepath}"`;
  
  exec(cmd, (error, stdout, stderr) => {
    if (error) {
      console.error("Capture failed:", error);
      return;
    }
    
    console.log("Image captured:", filename);
    console.log("File saved to:", filepath);
    
    // Update latest image
    latestImage = filename;
    
    // Also copy to public as latest.jpg for easy viewing
    const latestPath = path.join(__dirname, "public", "latest.jpg");
    fs.copyFileSync(filepath, latestPath);
    console.log("Latest image updated:", latestPath);
  });
}

// API endpoint to get latest image
app.get("/latest", (req, res) => {
  if (latestImage) {
    res.json({ 
      success: true, 
      filename: latestImage,
      url: `/images/${latestImage}`,
      latestUrl: "/latest.jpg"
    });
  } else {
    res.json({ success: false, message: "No images captured yet" });
  }
});

// API endpoint to get all images
app.get("/gallery", (req, res) => {
  try {
    const files = fs.readdirSync(IMAGES_DIR)
      .filter(file => file.endsWith('.jpg'))
      .map(file => ({
        filename: file,
        url: `/images/${file}`,
        mtime: fs.statSync(path.join(IMAGES_DIR, file)).mtime
      }))
      .sort((a, b) => b.mtime - a.mtime);
    
    res.json({ success: true, images: files });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// Initialize button
function initButton() {
  try {
    btn = new Gpio(BUTTON_GPIO, { mode: Gpio.INPUT, pullUpDown: Gpio.PUD_UP });
    btn.glitchFilter(10000);
    btn.enableAlert();

    btn.on("alert", (level) => {
      if (level !== 0) return; // falling edge = press (active-low)
      captureImage();
    });

    console.log(`Button ready on GPIO ${BUTTON_GPIO}`);
    return true;
  } catch (e) {
    console.error("Button init failed:", e.message);
    return false;
  }
}

// Startup
console.log("Simple camera capture with web frontend starting...");
const buttonOk = initButton();

if (buttonOk) {
  // Start web server
  app.listen(PORT, () => {
    console.log(`Web server running on http://localhost:${PORT}`);
    console.log("Press the button to capture an image!");
    console.log("View images at:");
    console.log(`  - Latest: http://localhost:${PORT}/latest.jpg`);
    console.log(`  - Gallery: http://localhost:${PORT}/gallery`);
    console.log("Press Ctrl+C to exit");
  });
} else {
  console.log("Failed to initialize button");
  process.exit(1);
}

// Cleanup on exit
process.on("SIGINT", () => {
  try { 
    if (btn?.disableAlert) btn.disableAlert(); 
  } catch {}
  console.log("\nBye.");
  process.exit(0);
});
