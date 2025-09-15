// server.js
const express = require("express");
const { exec } = require("child_process");
const path = require("path");
const fs = require("fs");
let i2cBus, Oled, Gpio, font5x7;
try {
  i2cBus = require("i2c-bus");
  Oled = require("oled-i2c-bus");
  // Use pigpio for modern Raspberry Pi OS
  Gpio = require("pigpio").Gpio;
  font5x7 = require("oled-font-5x7");
} catch (e) {
  console.warn("OLED/GPIO modules not available. Running without hardware UI.");
}

const app = express();
const PORT = process.env.PORT || 3000;

const PUBLIC_DIR = path.join(__dirname, "public");
const OUTPUT_PATH = path.join(PUBLIC_DIR, "latest.webp");

// ---- OLED + GPIO Setup ----
const DISPLAY_WIDTH = 128;
const DISPLAY_HEIGHT = 64;
const I2C_BUS_NUMBER = 1;
const I2C_ADDRESS = 0x3c; // common SSD1306 address
const BUTTON_GPIO = 17; // Pin 11

let oled = null;
let button = null;
let isBusy = false; // guards countdown/capture sequences

function initializeHardwareUi() {
  try {
    if (!i2cBus || !Oled) return;
    const i2c = i2cBus.openSync(I2C_BUS_NUMBER);
    oled = new Oled(i2c, {
      width: DISPLAY_WIDTH,
      height: DISPLAY_HEIGHT,
      address: I2C_ADDRESS,
    });
    oled.clearDisplay();
    drawCenteredText("Pi BnW Cam", 1, 0);
    drawCenteredText("Ready", 1, 18);
  } catch (e) {
    console.warn("Failed to init OLED:", e.message);
    oled = null;
  }

  try {
    if (!Gpio) return;
    // Configure GPIO17 as input with internal pull-up; use alert for edge detection
    button = new Gpio(BUTTON_GPIO, {
      mode: Gpio.INPUT,
      pullUpDown: Gpio.PUD_UP,
    });
    // Debounce using glitch filter: 100000 microseconds = 100 ms
    if (typeof button.glitchFilter === "function") {
      button.glitchFilter(100000);
    }
    // Enable alerts
    if (typeof button.enableAlert === "function") {
      button.enableAlert();
    }
    button.on("alert", async (level, tick) => {
      // Falling edge (pressed when using pull-up wiring)
      if (level !== 0) return;
      if (isBusy) return;
      isBusy = true;
      try {
        await runCountdownAndCapture();
      } catch (e) {
        console.error(e);
      } finally {
        isBusy = false;
      }
    });
  } catch (e) {
    console.warn("Failed to init GPIO button:", e.message);
    button = null;
  }
}

function drawCenteredText(text, size, y) {
  if (!oled || !font5x7) return;
  const characterWidth = 6; // 5px glyph + 1px spacing
  const characterHeight = 8; // baseline font height
  const scaledWidth = characterWidth * size * text.length;
  const x = Math.max(0, Math.floor((DISPLAY_WIDTH - scaledWidth) / 2));
  const yPos = typeof y === "number" ? y : Math.max(0, Math.floor((DISPLAY_HEIGHT - characterHeight * size) / 2));
  oled.setCursor(x, yPos);
  oled.writeString(font5x7, size, text, 1, false, true);
}

function clearOled() {
  if (!oled) return;
  oled.clearDisplay();
}

async function showCountdown(seconds) {
  if (!oled) return;
  for (let remaining = seconds; remaining >= 1; remaining -= 1) {
    clearOled();
    // Use large scale for big digits; size 4 is large on 128x64
    drawCenteredText(String(remaining), 4);
    await delay(1000);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runCountdownAndCapture() {
  // Show 3..2..1
  await showCountdown(3);
  if (oled) {
    clearOled();
    drawCenteredText("Capturing…", 1);
  }
  try {
    const result = await captureImage();
    if (oled) {
      clearOled();
      drawCenteredText("Saved", 1, 16);
      drawCenteredText(`${Math.round(result.bytes / 1024)} KB`, 2, 30);
    }
  } catch (e) {
    if (oled) {
      clearOled();
      drawCenteredText("Capture", 1, 16);
      drawCenteredText("failed", 1, 30);
    }
    throw e;
  }
}

// serve the frontend
app.use(express.static(PUBLIC_DIR));

// capture route
app.post("/capture", async (_req, res) => {
  try {
    const { url } = await captureImage();
    return res.json({ ok: true, url });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: "Capture failed" });
  }
});

function captureImage() {
  return new Promise((resolve, reject) => {
    try {
      fs.mkdirSync(PUBLIC_DIR, { recursive: true });
    } catch {}

    // Take a shot to stdout, pipe to ImageMagick to make grayscale WEBP under ~100KB, save to public/latest.webp
    // -n = no preview, -t 1 ~ minimal delay
    // Resize long edge to max 1024 to help stay under 100KB, then target WEBP size
    const cmd = `rpicam-still -n -t 1 -o - | convert - -resize '1024x1024>' -colorspace Gray -auto-level -contrast-stretch 0.5%x0.5% -define webp:lossless=false -quality 80 -define webp:method=6 -define webp:target-size=100000 "${OUTPUT_PATH}"`;

    exec(cmd, { timeout: 15000 }, (err, stdout, stderr) => {
      if (err) {
        console.error("Capture error:", err, stderr);
        return reject(err);
      }
      const url = `/latest.webp?ts=${Date.now()}`;
      let bytes = 0;
      try {
        const st = fs.statSync(OUTPUT_PATH);
        bytes = st.size;
      } catch {}
      resolve({ url, bytes });
    });
  });
}

app.listen(PORT, () => {
  console.log(`Pi BnW cam listening on http://localhost:${PORT}`);
  initializeHardwareUi();
});

process.on("SIGINT", () => {
  try {
    if (button && typeof button.disableAlert === "function") button.disableAlert();
  } catch {}
  try {
    if (oled) {
      oled.clearDisplay();
      oled.turnOffDisplay && oled.turnOffDisplay();
    }
  } catch {}
  process.exit(0);
});
