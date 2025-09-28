// pixel.js (or server.js)
// Run: sudo -E node pixel.js
// Updated for Waveshare 1.44" display with GPIO 13 button
const express = require("express");
const { exec } = require("child_process");
const path = require("path");
const fs = require("fs");
const mime = require("mime-types");

// ====== GPIO (buttons) via pigpio ======
const { Gpio } = require("pigpio");

// ====== Waveshare 1.44" Display (SPI) ======
const { spawn } = require("child_process");
const ST7735SDisplay = require("./display");

process.on("unhandledRejection", (reason) => {
  console.error("UNHANDLED REJECTION:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);
  // Do not exit so the server keeps running; flip to process.exit(1) if you prefer a hard crash.
});

const app = express();
const PORT = process.env.PORT || 3000;

const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const OUTPUT_PATH = path.join(PUBLIC_DIR, "latest.webp");
const IMAGES_DIR = path.join(ROOT_DIR, "images");

// Ensure folders
fs.mkdirSync(PUBLIC_DIR, { recursive: true });
fs.mkdirSync(IMAGES_DIR, { recursive: true });

// ---------- State (daily shots) ----------
const STATE_PATH = path.join(ROOT_DIR, "state.json");
const DAILY_LIMIT = 10;

function todayLocalISODate() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}
function nowStamp() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}_${hh}-${mi}-${ss}`;
}
function defaultState() {
  return { date: todayLocalISODate(), shotsRemaining: DAILY_LIMIT };
}
function readState() {
  try {
    const raw = fs.readFileSync(STATE_PATH, "utf8");
    const obj = JSON.parse(raw);
    if (!obj || typeof obj.date !== "string" || typeof obj.shotsRemaining !== "number") {
      throw new Error("Invalid state");
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

// ---------- Arweave manifest (manual upload only) ----------
const ARW_MANIFEST = path.join(ROOT_DIR, "arweave.json");
function readManifest() {
  try {
    const raw = fs.readFileSync(ARW_MANIFEST, "utf8");
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) throw new Error("bad manifest");
    return arr;
  } catch {
    fs.writeFileSync(ARW_MANIFEST, "[]");
    return [];
  }
}
function writeManifest(arr) {
  const tmp = ARW_MANIFEST + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(arr, null, 2));
  fs.renameSync(tmp, ARW_MANIFEST);
}
function upsertManifestEntry(filename, patch) {
  const m = readManifest();
  const i = m.findIndex(x => x.filename === filename);
  const base = i >= 0 ? m[i] : { filename, status: "none" };
  const next = { ...base, ...patch };
  if (i >= 0) m[i] = next; else m.push(next);
  writeManifest(m);
  return next;
}
function getManifestEntry(filename) {
  return readManifest().find(x => x.filename === filename);
}

// Upload queue (manual only)
const uploadQueue = [];
let isUploading = false;
let turbo = null;
async function ensureTurbo() {
  if (turbo) return turbo;
  const walletPath = path.join(ROOT_DIR, "wallet.json");
  const jwk = JSON.parse(fs.readFileSync(walletPath, "utf-8"));
  const mod = await import("@ardrive/turbo-sdk");
  const { TurboFactory } = mod;
  turbo = await TurboFactory.authenticated({ privateKey: jwk });
  return turbo;
}
function enqueueUpload(filename) {
  if (!filename) return;
  const entry = getManifestEntry(filename);
  if (entry && entry.status === "success") return;
  upsertManifestEntry(filename, { status: "pending", queuedAt: new Date().toISOString() });
  uploadQueue.push(filename);
  process.nextTick(processUploadQueue);
}
async function processUploadQueue() {
  if (isUploading) return;
  isUploading = true;
  try {
    await ensureTurbo();
  } catch (e) {
    console.error("Arweave auth failed:", e);
    isUploading = false;
    return;
  }

  while (uploadQueue.length) {
    const filename = uploadQueue.shift();
    const filePath = path.join(IMAGES_DIR, filename);
    try {
      if (!fs.existsSync(filePath)) {
        const ent = getManifestEntry(filename);
        if (!ent || ent.status !== "success") {
          upsertManifestEntry(filename, { status: "failed", error: "File missing", failedAt: new Date().toISOString() });
        }
        continue;
      }
      const st = fs.statSync(filePath);
      const type = mime.lookup(filePath) || "application/octet-stream";

      const result = await turbo.uploadFile({
        fileStreamFactory: () => fs.createReadStream(filePath),
        fileSizeFactory: () => st.size,
        dataItemOpts: { tags: [{ name: "Content-Type", value: String(type) }] },
      });

      const url = `https://arweave.net/${result.id}`;
      try { fs.unlinkSync(filePath); } catch {}

      upsertManifestEntry(filename, {
        status: "success",
        uploadedAt: new Date().toISOString(),
        txId: result.id,
        url,
        size: st.size,
      });

      broadcast({ type: "uploaded", filename, url, txId: result.id });
      console.log("Arweave:", filename, url);
    } catch (e) {
      console.error("Upload failed:", filename, e?.message || e);
      upsertManifestEntry(filename, {
        status: "failed",
        error: String(e?.message || e),
        failedAt: new Date().toISOString(),
      });
    }
  }
  isUploading = false;
}

// ---------- Static + APIs ----------
app.use(
  express.static(PUBLIC_DIR, {
    setHeaders: (res, p) => {
      if (p.endsWith("latest.webp")) res.setHeader("Cache-Control", "no-store");
    },
  })
);
app.use("/images", express.static(IMAGES_DIR, { maxAge: "1d" }));

// Gallery split: local (disk) + archived (arweave)
app.get("/gallery.json", async (_req, res) => {
  try {
    const names = (await fs.promises.readdir(IMAGES_DIR)).filter(n => n.toLowerCase().endsWith(".webp"));
    const locals = await Promise.all(
      names.map(async (name) => {
        const full = path.join(IMAGES_DIR, name);
        const st = await fs.promises.stat(full);
        return {
          name,
          url: `/images/${encodeURIComponent(name)}`,
          mtimeMs: st.mtimeMs,
          size: st.size,
        };
      })
    );
    locals.sort((a, b) => b.mtimeMs - a.mtimeMs);

    const archived = readManifest()
      .filter((m) => m.status === "success" && m.url)
      .map((m) => ({
        name: m.filename,
        url: m.url,
        txId: m.txId,
        uploadedAt: m.uploadedAt || null,
        size: m.size || null,
      }))
      .sort((a, b) => {
        const at = a.uploadedAt ? Date.parse(a.uploadedAt) : 0;
        const bt = b.uploadedAt ? Date.parse(b.uploadedAt) : 0;
        return bt - at;
      });

    res.json({ ok: true, local: locals, archived });
  } catch (e) {
    console.error("gallery.json error:", e);
    res.status(500).json({ ok: false, error: "Failed to read gallery" });
  }
});

// ---------- SSE ----------
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
function broadcast(obj) {
  const payload = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch {}
  }
}
function notifyCaptured(filename = null) {
  broadcast({ type: "captured", ts: Date.now(), filename });
}

// ---------- Capture pipeline (with FIXES) ----------
let isBusy = false;

// FIX #1: reject with Error, not plain object
function safeExec(cmd, opts = {}) {
  return new Promise((resolve, reject) => {
    console.log('Executing:', cmd);
    exec(cmd, { timeout: 30000, ...opts }, (err, stdout, stderr) => {
      if (err) {
        console.error('Command failed:', err.message);
        console.error('Stderr:', stderr);
        const e = new Error(String(stderr || err.message || "exec failed"));
        e.stderr = String(stderr || "");
        e.cause = err;
        return reject(e);
      }
      console.log('Command completed successfully');
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

async function captureImage() {
  // Try multiple capture methods
  const tempFile = path.join(ROOT_DIR, 'temp_capture.jpg');
  
  console.log('Starting camera capture...');
  
  // Use rpicam-still (we know this works on your Pi)
  try {
    console.log('Using rpicam-still...');
    const cmd = `rpicam-still -o "${tempFile}"`;
    await safeExec(cmd);
    
    if (fs.existsSync(tempFile)) {
      console.log('rpicam-still succeeded');
    } else {
      throw new Error('rpicam-still failed - no file created');
    }
  } catch (e) {
    console.log('rpicam-still failed:', e.message);
    throw new Error('Camera capture failed: ' + e.message);
  }
  
  console.log('Processing image...');
  // Convert to WebP with simpler processing
  const convertCmd = `convert "${tempFile}" -resize '1024x1024>' -colorspace Gray -quality 80 "${OUTPUT_PATH}"`;
  await safeExec(convertCmd);
  
  // Clean up temp file
  try { fs.unlinkSync(tempFile); } catch {}
  
  const name = `${nowStamp()}.webp`;
  fs.copyFileSync(OUTPUT_PATH, path.join(IMAGES_DIR, name));
  console.log('Image saved:', name);
  return name;
}

// ---------- Waveshare 1.44" Display Functions ----------
let display = null;
let displayReady = false;

async function initDisplay() {
  try {
    // Initialize ST7735S display driver
    display = new ST7735SDisplay({
      rotation: 0,
      spiDevice: '/dev/spidev0.0'
    });
    
    const success = await display.init();
    if (success) {
      console.log("Waveshare 1.44\" display initialized");
      displayReady = true;
      return true;
    } else {
      displayReady = false;
      return false;
    }
  } catch (e) {
    console.error("Display init failed:", e.message || e);
    displayReady = false;
    return false;
  }
}

async function showStatus(text) {
  console.log(`Display: ${text}`);
  if (!displayReady || !display) return;
  
  try {
    await display.showText(text, 'small', 'white');
  } catch (e) {
    console.log(`Display: ${text}`);
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function showRemainingBig(n) {
  console.log(`Display: Shots left: ${n}`);
  if (!displayReady || !display) return;
  
  try {
    await display.showNumber(n, 'large');
  } catch (e) {
    console.log(`Display: Shots left: ${n}`);
  }
}

async function showActiveCountdown(seconds = 3) {
  console.log(`Display: Countdown starting...`);
  if (!displayReady || !display) {
    await sleep(seconds * 1000);
    return;
  }
  
  for (let s = seconds; s >= 1; s--) {
    console.log(`Display: ${s}`);
    try {
      await display.showNumber(s, 'large');
    } catch (e) {
      console.log(`Display: ${s}`);
    }
    await sleep(1000);
  }
}

async function showResult(ok, msg = "") {
  if (ok) {
    console.log("Display: Saved ✓");
    if (displayReady && display) {
      try {
        await display.showText("SAVED ✓", 'large', 'green');
      } catch (e) {
        console.log("Display: Saved ✓");
      }
    }
  } else {
    console.log(`Display: Error - ${msg}`);
    if (displayReady && display) {
      try {
        await display.showText("ERROR", 'large', 'red');
      } catch (e) {
        console.log(`Display: Error - ${msg}`);
      }
    }
  }
}

// Full capture UI flow (NO auto-upload) with FIX #2 (self-catching capture promise)
async function runCaptureWithUI(state) {
  // Start capture immediately, but PREVENT unhandled rejection:
  let capError = null;
  const capPromise = captureImage().catch((e) => {
    capError = e;   // store error so it won't crash as unhandled
    return null;    // make the promise resolve -> prevents unhandled rejection
  });

  // Show countdown while capture runs
  await showActiveCountdown(3);

  // Processing splash - show until capture actually completes
  await showStatus("Processing...");
  
  // Wait for capture to actually complete (with timeout)
  const filename = await Promise.race([
    capPromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Capture timeout after 30 seconds')), 30000))
  ]);
  
  if (capError) {
    // If there was an error, show error message
    await showResult(false, "Capture error");
    throw capError;
  }

  // Now show saved after capture actually completed
  await showResult(true);
  
  // Reset busy state after showing saved (so user can take another photo)
  isBusy = false;

  // Decrement quota & UI
  decAndPersist(state);
  notifyCaptured(filename);

  setTimeout(async () => {
    const fresh = readState(); ensureToday(fresh);
    await showRemainingBig(fresh.shotsRemaining);
  }, 800);

  return filename;
}

// ------------- Button via ALERT (GPIO 13) -------------
const BUTTON_GPIO = 13; // Waveshare 1.44" display button pin
let btn = null;

function initButtons() {
  try {
    btn = new Gpio(BUTTON_GPIO, { mode: Gpio.INPUT, pullUpDown: Gpio.PUD_UP });
    btn.glitchFilter(10000);
    btn.enableAlert();

    btn.on("alert", async (level) => {
      if (level !== 0) return;     // falling edge = press (active-low)
      if (isBusy) { 
        showStatus("Busy…"); 
        return; 
      }
      
      const state = readState(); 
      ensureToday(state);
      
      if (!canCapture(state)) { 
        await showStatus("Limit reached"); 
        setTimeout(async () => await showRemainingBig(state.shotsRemaining), 1500); 
        return; 
      }
      
      isBusy = true;
      try {
        console.log("Button PRESSED → capturing...");
        await runCaptureWithUI(state);
      } catch (e) {
        console.error("Button capture failed:", e?.stderr || e);
        await showResult(false, "Check camera");
        setTimeout(async () => await showRemainingBig(readState().shotsRemaining), 1500);
        isBusy = false; // Reset busy state on error
      }
      // Note: isBusy is reset inside runCaptureWithUI after showing "Saved ✓"
    });

    console.log(`Button ready on GPIO ${BUTTON_GPIO} [ALERT mode].`);
    return true;
  } catch (e) {
    console.error("Button init failed:", e.message || e);
    return false;
  }
}

// ------------- HTTP routes -------------
app.post("/capture", async (_req, res) => {
  if (isBusy) return res.status(409).json({ ok: false, error: "Busy" });
  const state = readState(); ensureToday(state);
  if (!canCapture(state)) {
    await showStatus("Limit reached"); 
    setTimeout(async () => await showRemainingBig(state.shotsRemaining), 1500);
    return res.status(403).json({ ok: false, error: "Daily limit reached" });
  }
  isBusy = true;
  try {
    const filename = await runCaptureWithUI(state);
    return res.json({ ok: true, url: `/latest.webp?ts=${Date.now()}`, saved: `/images/${encodeURIComponent(filename)}` });
  } catch (e) {
    console.error("Capture error:", e?.stderr || e);
    await showResult(false, "Capture failed");
    setTimeout(async () => await showRemainingBig(readState().shotsRemaining), 1500);
    return res.status(500).json({ ok: false, error: "Capture failed" });
  } finally {
    isBusy = false;
  }
});

// Manual upload ALL local images (each success deletes local file)
app.post("/upload-all", async (_req, res) => {
  try {
    const names = (await fs.promises.readdir(IMAGES_DIR)).filter(n => n.toLowerCase().endsWith(".webp"));
    names.forEach(n => enqueueUpload(n));
    res.json({ ok: true, queued: names.length });
  } catch (e) {
    console.error("/upload-all error:", e);
    res.status(500).json({ ok: false, error: "Failed to queue uploads" });
  }
});

// Optional: retry a specific filename
app.post("/upload/:filename", async (req, res) => {
  try {
    const filename = decodeURIComponent(req.params.filename);
    const full = path.join(IMAGES_DIR, filename);
    if (!fs.existsSync(full)) return res.status(404).json({ ok: false, error: "File not found" });
    enqueueUpload(filename);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: "Failed to queue file" });
  }
});

// ------------- Startup -------------
async function startApp() {
  const bootState = readState(); 
  ensureToday(bootState);
  
  const displayOk = await initDisplay();
  await showRemainingBig(bootState.shotsRemaining);
  const buttonsOk = initButtons();

  app.listen(PORT, () => {
    console.log(`Pi BnW cam listening on http://localhost:${PORT}`);
    if (!displayOk) console.log("Waveshare 1.44\" display not available; continuing without display.");
    if (!buttonsOk) console.log("Button not available; continuing without GPIO.");
  });
}

startApp().catch(console.error);

// ------------- Cleanup -------------
process.on("SIGINT", async () => {
  try { 
    if (btn?.disableAlert) btn.disableAlert(); 
    if (display?.cleanup) await display.cleanup();
  } catch {}
  console.log("\nBye.");
  process.exit(0);
});
