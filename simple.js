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
app.use('/images', express.static(IMAGES_DIR));
app.use(express.static(path.join(__dirname, "public")));

// Serve latest.webp directly
app.get("/latest.webp", (req, res) => {
  const latestPath = path.join(__dirname, "public", "latest.webp");
  if (fs.existsSync(latestPath)) {
    res.sendFile(latestPath);
  } else {
    res.status(404).send("No latest image available");
  }
});

// Button setup
const BUTTON_GPIO = 13;
let btn = null;
let latestImage = null;

// Simple capture function
function captureImage() {
  console.log("Button pressed - capturing image...");
  
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const tempFile = path.join(__dirname, `temp_${timestamp}.jpg`);
  const filename = `capture_${timestamp}.webp`;
  const filepath = path.join(IMAGES_DIR, filename);
  
  const cmd = `rpicam-still -o "${tempFile}"`;
  
  exec(cmd, (error, stdout, stderr) => {
    if (error) {
      console.error("Capture failed:", error);
      return;
    }
    
    console.log("Raw image captured, processing...");
    
    // Convert to WebP, black & white, under 100KB
    const convertCmd = `convert "${tempFile}" -resize '1024x1024>' -colorspace Gray -auto-level -contrast-stretch 0.5%x0.5% -define webp:lossless=false -quality 80 -define webp:method=6 -define webp:target-size=100000 "${filepath}"`;
    
    exec(convertCmd, (convertError, convertStdout, convertStderr) => {
      // Clean up temp file
      try { fs.unlinkSync(tempFile); } catch {}
      
      if (convertError) {
        console.error("Convert failed:", convertError);
        return;
      }
      
      console.log("Image processed:", filename);
      console.log("File saved to:", filepath);
      
      // Update latest image
      latestImage = filename;
      console.log("Latest image set to:", latestImage);
      
      // Also copy to public as latest.webp for easy viewing
      const latestPath = path.join(__dirname, "public", "latest.webp");
      fs.copyFileSync(filepath, latestPath);
      console.log("Latest image updated:", latestPath);
      console.log("File exists:", fs.existsSync(latestPath));
    });
  });
}

// API endpoint to get latest image
app.get("/latest", (req, res) => {
  if (latestImage) {
    res.json({ 
      success: true, 
      filename: latestImage,
      url: `/images/${latestImage}`,
      latestUrl: "/latest.webp"
    });
  } else {
    res.json({ success: false, message: "No images captured yet" });
  }
});

// API endpoint to get all images
app.get("/gallery", (req, res) => {
  try {
    const files = fs.readdirSync(IMAGES_DIR)
      .filter(file => file.endsWith('.webp'))
      .map(file => {
        const filepath = path.join(IMAGES_DIR, file);
        const stats = fs.statSync(filepath);
        const imageData = {
          filename: file,
          url: `/images/${file}`,
          mtime: stats.mtime,
          size: stats.size
        };
        console.log('Gallery image:', imageData);
        return imageData;
      })
      .sort((a, b) => b.mtime - a.mtime);
    
    console.log('Gallery API returning', files.length, 'images');
    res.json({ success: true, images: files });
  } catch (error) {
    console.error('Gallery API error:', error);
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
    console.log(`  - Web Interface: http://localhost:${PORT}`);
    console.log(`  - Latest: http://localhost:${PORT}/latest.webp`);
    console.log(`  - Gallery API: http://localhost:${PORT}/gallery`);
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
