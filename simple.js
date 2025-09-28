// simple.js - Minimal camera capture with button
const { Gpio } = require("pigpio");
const { exec } = require("child_process");
const path = require("path");

// Button setup
const BUTTON_GPIO = 13;
let btn = null;

// Simple capture function
function captureImage() {
  console.log("Button pressed - capturing image...");
  
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `capture_${timestamp}.jpg`;
  const filepath = path.join(__dirname, filename);
  
  const cmd = `rpicam-still -o "${filepath}"`;
  
  exec(cmd, (error, stdout, stderr) => {
    if (error) {
      console.error("Capture failed:", error);
      return;
    }
    
    console.log("Image captured:", filename);
    console.log("File saved to:", filepath);
  });
}

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
console.log("Simple camera capture starting...");
const buttonOk = initButton();

if (buttonOk) {
  console.log("Press the button to capture an image!");
  console.log("Press Ctrl+C to exit");
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
