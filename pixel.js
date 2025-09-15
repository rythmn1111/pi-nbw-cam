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

// ---------- State (daily shots) ----------
const STATE_PATH = path.join(__dirname, "state.json");
const DAILY_LIMIT = 10;

function todayLocalISODate() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}
function defaultState() {
  return { date: todayLocalISODate(), shotsRemaining: DAILY_LIMIT };
}
function readState() {
  try {
    const raw = fs.readFileSync(STATE_PATH, "utf8");
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object") throw new Error("Invalid state");
    if (typeof obj.date !== "string" || typeof obj.shotsRemaining !== "number") {
      throw new Error("Invalid schema");
    }
    return obj;
  } catch {
    const s = defaultState();
    writeState(s);
    return s;
  }
}
function writeState(state) {
  const tmp = STATE_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_PATH);
}
function ensureToday(state) {
  const t = todayLocalISODate();
  if (state.date !== t) {
    state.date = t;
    state.shotsRemaining = DAILY_LIMIT;
    writeState(state);
  }
}
function canCapture(state) {
  ensureToday(state);
  return state.shotsRemaining > 0;
}
function decAndPersist(state) {
  state.shotsRemaining = Math.max(0, state.shotsRemaining - 1);
  writeState(state);
}

// Serve frontend; prevent caching for latest.webp
app.use(
  express.static(PUBLIC_DIR, {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith("latest.webp")) res.setHeader("Cache-Control", "no-store");
    },
  })
);

// ---------- SSE: live updates ----------
const clients = new Set();
app.get("/events", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    "Connection": "keep-alive",
  });
  res.flushHeaders();
  res.write("retry: 2000\n\n");
  clients.add(res);
  req.on("close", () => clients.delete(res));
});
function notifyCaptured() {
  const payload = `data: ${JSON.stringify({ type: "captured", ts: Date.now() })}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch {}
  }
}

// ------------- Capture pipeline -------------
let isBusy = false;

function safeExec(cmd, opts = {}) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: 15000, ...opts }, (err, stdout, stderr) => {
      if (err) reject({ err, stderr: String(stderr) });
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

async function captureImage() {
  fs.mkdirSync(PUBLIC_DIR, { recursive: true });
  const cmd = `rpicam-still -n -t 1 -o - | convert - -resize '1024x1024>' -colorspace Gray -auto-level -contrast-stretch 0.5%x0.5% -define webp:lossless=false -quality 80 -define webp:method=6 -define webp:target-size=100000 "${OUTPUT_PATH}"`;
  return safeExec(cmd);
}

// ------------- OLED helpers + Twinkle animation -------------
let oled = null;
let oledBus = null;

let uiMode = "idle"; // 'idle' | 'countdown' | 'processing' | 'saved' | 'error'

// Twinkle state
let twinkleTimer = null;
let twinkleEnabled = false;
let stars = [];
const FPS = 5;                 // gentle, low CPU
const STAR_COUNT = 10;         // total stars across both boxes
const MOVE_EVERY_MS = 3000;    // refresh a few stars every ~3s
let lastMoveAt = 0;

// Two safe animation boxes: top-right & bottom-left (avoid big number area)
const BOXES = [
  // top-right 24x16
  { x0: 104, y0: 0, x1: 127, y1: 15 },
  // bottom-left 28x16
  { x0: 0, y0: 48, x1: 27, y1: 63 },
];

function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

function randomPointInBox(b) {
  return { x: randInt(b.x0, b.x1), y: randInt(b.y0, b.y1) };
}

function seedStars() {
  stars = [];
  for (let i = 0; i < STAR_COUNT; i++) {
    const box = BOXES[i % BOXES.length];
    const p = randomPointInBox(box);
    stars.push({
      x: p.x,
      y: p.y,
      on: Math.random() < 0.5,
    });
  }
}

function initOled() {
  try {
    oledBus = i2c.openSync(1);
    oled = new Oled(oledBus, { width: 128, height: 64, address: 0x3c });
    oled.clearDisplay();
    oled.turnOnDisplay();
    return true;
  } catch (e) {
    console.error("OLED init failed:", e.message || e);
    oled = null;
    return false;
  }
}

function showStatus(text) {
  if (!oled) return;
  stopTwinkle();
  oled.clearDisplay();
  oled.setCursor(0, 0);
  oled.writeString(font, 1, text, 1, true);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function showRemainingBig(n) {
  if (!oled) return;
  stopTwinkle(); // draw static UI first
  oled.clearDisplay();
  oled.setCursor(0, 0);
  oled.writeString(font, 1, "Shots left", 1, true);

  const s = String(n);
  const size = 3;
  const charW = 5 * size + 1;
  const charH = 7 * size;
  const totalW = charW * s.length;
  const x = Math.max(0, Math.floor((128 - totalW) / 2));
  const y = Math.max(0, Math.floor((64 - charH) / 2));
  oled.setCursor(x, y);
  oled.writeString(font, size, s, 1, true);

  startTwinkle(); // resume idle animation
}

// Countdown during active capture
async function showActiveCountdown(seconds = 3) {
  if (!oled) { await sleep(seconds * 1000); return; }
  stopTwinkle();
  uiMode = "countdown";
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
    await sleep(1000);
  }
}

function showResult(ok, msg = "") {
  if (!oled) return;
  stopTwinkle();
  uiMode = ok ? "saved" : "error";
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

// Twinkle control
function startTwinkle() {
  if (!oled || twinkleEnabled) return;
  twinkleEnabled = true;
  uiMode = "idle";
  seedStars();
  lastMoveAt = Date.now();

  if (twinkleTimer) clearInterval(twinkleTimer);
  twinkleTimer = setInterval(() => {
    if (!twinkleEnabled || !oled) return;

    // Flip some stars on/off
    const toDraw = [];
    for (const star of stars) {
      // erase previous state
      toDraw.push([star.x, star.y, 0]);

      // 50% chance to toggle each frame (soft flicker)
      if (Math.random() < 0.5) star.on = !star.on;

      // draw new state
      if (star.on) toDraw.push([star.x, star.y, 1]);
    }

    // Occasionally move a couple of stars to fresh spots
    const now = Date.now();
    if (now - lastMoveAt > MOVE_EVERY_MS) {
      lastMoveAt = now;
      const moves = Math.max(1, Math.round(STAR_COUNT * 0.2)); // ~20% relocate
      for (let i = 0; i < moves; i++) {
        const idx = randInt(0, stars.length - 1);
        const box = BOXES[idx % BOXES.length];
        const p = randomPointInBox(box);
        // erase old pixel (already in toDraw as 0), set new coords, ensure visible next frame
        stars[idx].x = p.x;
        stars[idx].y = p.y;
        stars[idx].on = true;
        toDraw.push([p.x, p.y, 1]);
      }
    }

    try { oled.drawPixel(toDraw); } catch {}
    try { oled.update(); } catch {}
  }, 1000 / FPS);
}

function stopTwinkle() {
  twinkleEnabled = false;
  if (twinkleTimer) {
    clearInterval(twinkleTimer);
    twinkleTimer = null;
  }
  if (oled && stars && stars.length) {
    // Clear any lit stars
    const erase = stars.map(s => [s.x, s.y, 0]);
    try { oled.drawPixel(erase); oled.update(); } catch {}
  }
}

// Runs the whole UX: start capture now, show 3-2-1 during capture,
// then "Processing..." 10s, then "Saved ✓", update remaining + resume twinkle
async function runCaptureWithUI(state) {
  const capPromise = captureImage();

  await showActiveCountdown(3);

  showStatus("Processing...");
  uiMode = "processing";
  await sleep(10000);

  await capPromise;

  decAndPersist(state);

  showResult(true);
  notifyCaptured();
  setTimeout(() => {
    const fresh = readState();
    ensureToday(fresh);
    showRemainingBig(fresh.shotsRemaining); // restarts twinkle
  }, 800);
}

// ------------- Buttons via ALERT (no ISR interrupts) -------------
let btnA; // GPIO17
let btnB; // GPIO27

function initButtons() {
  try {
    btnA = new Gpio(17, { mode: Gpio.INPUT, pullUpDown: Gpio.PUD_UP });
    btnB = new Gpio(27, { mode: Gpio.INPUT, pullUpDown: Gpio.PUD_UP });

    btnA.glitchFilter(10000);
    btnB.glitchFilter(10000);

    btnA.enableAlert();
    btnB.enableAlert();

    btnA.on("alert", async (level) => {
      if (level !== 0) return; // pressed -> LOW
      if (isBusy) { showStatus("Busy…"); return; }

      const state = readState();
      ensureToday(state);

      if (!canCapture(state)) {
        showStatus("Limit reached");
        setTimeout(() => showRemainingBig(state.shotsRemaining), 1500);
        return;
      }

      isBusy = true;
      try {
        await runCaptureWithUI(state);
      } catch (e) {
        console.error("Button capture failed:", e.stderr || e.err || e);
        showResult(false, "Check camera");
        setTimeout(() => showRemainingBig(readState().shotsRemaining), 1500);
      } finally {
        isBusy = false;
      }
    });

    btnB.on("alert", (level) => {
      if (level !== 0) return;
      // Reserved for future feature
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
  if (isBusy) return res.status(409).json({ ok: false, error: "Busy" });

  const state = readState();
  ensureToday(state);

  if (!canCapture(state)) {
    showStatus("Limit reached");
    setTimeout(() => showRemainingBig(state.shotsRemaining), 1500);
    return res.status(403).json({ ok: false, error: "Daily limit reached" });
  }

  isBusy = true;
  try {
    await runCaptureWithUI(state);
    const ts = Date.now();
    return res.json({ ok: true, url: `/latest.webp?ts=${ts}` });
  } catch (e) {
    console.error("Capture error:", e.stderr || e.err || e);
    showResult(false, "Capture failed");
    setTimeout(() => showRemainingBig(readState().shotsRemaining), 1500);
    return res.status(500).json({ ok: false, error: "Capture failed" });
  } finally {
    isBusy = false;
  }
});

// ------------- Startup -------------
const oledOk = initOled();
const bootState = readState();
ensureToday(bootState);
showRemainingBig(bootState.shotsRemaining); // draws big count + starts twinkle
const buttonsOk = initButtons();

app.listen(PORT, () => {
  console.log(`Pi BnW cam listening on http://localhost:${PORT}`);
  if (!oledOk) console.log("OLED not available; continuing without display.");
  if (!buttonsOk) console.log("Buttons not available; continuing without GPIO.");
});

// ------------- Cleanup -------------
process.on("SIGINT", () => {
  try {
    stopTwinkle();
    if (oled) {
      oled.clearDisplay();
      oled.turnOffDisplay();
      if (oledBus) oledBus.closeSync();
    }
  } catch {}
  try {
    if (btnA?.disableAlert) btnA.disableAlert();
    if (btnB?.disableAlert) btnB.disableAlert();
  } catch {}
  process.exit(0);
});
