// server.js
const express = require("express");
const { exec } = require("child_process");
const path = require("path");
const fs = require("fs");

// ====== GPIO (buttons) via pigpio ======
const { Gpio } = require("pigpio");

// ====== OLED (SSD1306 @ 0x3C) ======
const i2c = require("i2c-bus");
const Oled = require("oled-i2c-bus");
const font = require("oled-font-5x7");

const app = express();
const PORT = process.env.PORT || 3000;

const PUBLIC_DIR = path.join(__dirname, "public");
const OUTPUT_PATH = path.join(PUBLIC_DIR, "latest.webp");

// Serve the frontend (public/index.html, latest.webp, etc.)
// Add no-store just for latest.webp as a safety net (we still cache-bust with ?ts=)
app.use(express.static(PUBLIC_DIR, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith("latest.webp")) {
      res.setHeader("Cache-Control", "no-store");
    }
  }
}));

// ---------- SSE: live updates to clients ----------
const clients = new Set();

app.get("/events", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    "Connection": "keep-alive",
  });
  res.flushHeaders();
  res.write("retry: 2000\n\n"); // optional: reconnection hint
  clients.add(res);
  req.on("close", () => clients.delete(res));
});

function notifyCaptured() {
  const payload = `data: ${JSON.stringify({ type: "captured", ts: Date.now() })}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch {}
  }
}

// ------------- Capture pipeline (shared by route + button) -------------
let isBusy = false;

function safeExec(cmd, opts = {}) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: 15000, ...opts }, (err, stdout, stderr) => {
      if (err) {
        reject({ err, stderr: String(stderr) });
      } else {
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      }
    });
  });
}

async function captureImage() {
  fs.mkdirSync(PUBLIC_DIR, { recursive: true });
  const cmd = `rpicam-still -n -t 1 -o - | convert - -resize '1024x1024>' -colorspace Gray -auto-level -contrast-stretch 0.5%x0.5% -define webp:lossless=false -quality 80 -define webp:method=6 -define webp:target-size=100000 "${OUTPUT_PATH}"`;
  return safeExec(cmd);
}

// ------------- OLED helpers -------------
let oled = null;
let oledBus = null;

function initOled() {
  try {
    oledBus = i2c.openSync(1);
    oled = new Oled(oledBus, { width: 128, height: 64, address: 0x3c });
    oled.clearDisplay();
    oled.turnOnDisplay();
    showStatus("Ready");
    return true;
  } catch (e) {
    console.error("OLED init failed:", e.message || e);
    oled = null;
    return false;
  }
}

function showStatus(text) {
  if (!oled) return;
  oled.clearDisplay();
  oled.setCursor(0, 0);
  oled.writeString(font, 1, text, 1, true);
}

async function showCountdown(seconds = 3) {
  if (!oled) return;
  for (let s = seconds; s >= 1; s--) {
    oled.clearDisplay();
    oled.setCursor(0, 0);
    oled.writeString(font, 1, "Hold steady…", 1, true);

    const big = String(s);
    const size = 3;
    const charW = 5 * size + 1;
    const charH = 7 * size;
    const x = Math.max(0, Math.floor((128 - charW) / 2));
    const y = Math.max(0, Math.floor((64 - charH) / 2));
    oled.setCursor(x, y);
    oled.writeString(font, size, big, 1, true);

    await new Promise((r) => setTimeout(r, 1000));
  }
  oled.clearDisplay();
  oled.setCursor(0, 0);
  oled.writeString(font, 1, "Capturing...", 1, true);
}

function showResult(ok, msg = "") {
  if (!oled) return;
  oled.clearDisplay();
  oled.setCursor(0, 0);
  if (ok) {
    oled.writeString(font, 1, "Saved ✓", 1, true);
  } else {
    oled.writeString(font, 1, "Error", 1, true);
    if (msg) {
      oled.setCursor(0, 16);
      oled.writeString(font, 1, msg.slice(0, 21), 1, true);
    }
  }
}

// ------------- Buttons via ALERT (no ISR interrupts) -------------
let btnA; // GPIO17
let btnB; // GPIO27

function initButtons() {
  try {
    btnA = new Gpio(17, { mode: Gpio.INPUT, pullUpDown: Gpio.PUD_UP });
    btnB = new Gpio(27, { mode: Gpio.INPUT, pullUpDown: Gpio.PUD_UP });

    btnA.glitchFilter(10000); // 10 ms
    btnB.glitchFilter(10000);

    btnA.enableAlert();
    btnB.enableAlert();

    btnA.on("alert", async (level /*0=LOW,1=HIGH*/) => {
      if (level !== 0) return; // pressed -> LOW
      console.log("Button A pressed (GPIO17)");
      if (isBusy) { showStatus("Busy…"); return; }

      isBusy = true;
      try {
        await showCountdown(3);
        await captureImage();
        showResult(true);
        notifyCaptured(); // <-- tell the browser(s) immediately
      } catch (e) {
        console.error("Button capture failed:", e.stderr || e.err || e);
        showResult(false, "Check camera");
      } finally {
        setTimeout(() => { showStatus("Ready"); isBusy = false; }, 1200);
      }
    });

    btnB.on("alert", (level) => {
      if (level !== 0) return;
      console.log("Button B pressed (GPIO27)");
      // Add future action here if needed
    });

    console.log("Buttons ready on GPIO17 (A) and GPIO27 (B) [ALERT mode].");
    return true;
  } catch (e) {
    console.error("Button init failed:", e.message || e);
    return false;
  }
}

// ------------- HTTP route -------------
app.post("/capture", async (_req, res) => {
  if (isBusy) {
    return res.status(409).json({ ok: false, error: "Busy" });
  }

  isBusy = true;
  try {
    await showCountdown(3);
    await captureImage();
    const ts = Date.now();
    const url = `/latest.webp?ts=${ts}`;
    showResult(true);
    notifyCaptured(); // <-- notify web clients too
    setTimeout(() => showStatus("Ready"), 800);
    return res.json({ ok: true, url });
  } catch (e) {
    console.error("Capture error:", e.stderr || e.err || e);
    showResult(false, "Capture failed");
    setTimeout(() => showStatus("Ready"), 1500);
    return res.status(500).json({ ok: false, error: "Capture failed" });
  } finally {
    isBusy = false;
  }
});

// ------------- Startup -------------
const oledOk = initOled();
const buttonsOk = initButtons();

app.listen(PORT, () => {
  console.log(`Pi BnW cam listening on http://localhost:${PORT}`);
  if (!oledOk) console.log("OLED not available; continuing without display.");
  if (!buttonsOk) console.log("Buttons not available; continuing without GPIO.");
});

// ------------- Cleanup -------------
process.on("SIGINT", () => {
  try {
    if (oled) {
      oled.clearDisplay();
      oled.turnOffDisplay();
      if (oledBus) oledBus.closeSync();
    }
  } catch {}
  try { if (btnA?.disableAlert) btnA.disableAlert(); } catch {}
  try { if (btnB?.disableAlert) btnB.disableAlert(); } catch {}
  process.exit(0);
});
