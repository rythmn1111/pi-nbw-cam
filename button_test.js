// Minimal button test using pigpio on Raspberry Pi
// GPIO17 (Pin 11) and GPIO27 (Pin 13) with pull-ups, falling edge = pressed

const { Gpio } = require("pigpio");

const BUTTONS = [
  { name: "BTN1", gpio: 17 },
  { name: "BTN2", gpio: 27 },
];

const instances = [];

function now() {
  const d = new Date();
  return d.toISOString();
}

function setupButton({ name, gpio }) {
  const btn = new Gpio(gpio, {
    mode: Gpio.INPUT,
    pullUpDown: Gpio.PUD_UP,
  });
  // Debounce/glitch filter: 100 ms
  if (typeof btn.glitchFilter === "function") {
    btn.glitchFilter(100000);
  }
  if (typeof btn.enableAlert === "function") {
    btn.enableAlert();
  }

  // Log initial level
  const level = btn.digitalRead();
  console.log(`[${now()}] ${name}@GPIO${gpio} initial level=${level} (0=LOW,1=HIGH)`);

  // Alert on both edges; pressed is level=0 with pull-up wiring
  btn.on("alert", (level, tick) => {
    const state = level === 0 ? "PRESSED" : "RELEASED";
    console.log(`[${now()}] ${name}@GPIO${gpio} ${state} (level=${level}, tick=${tick})`);
  });

  instances.push(btn);
}

function main() {
  console.log(`Starting button_test.js (requires sudo). Press Ctrl+C to exit.`);
  BUTTONS.forEach(setupButton);
}

process.on("SIGINT", () => {
  try {
    for (const btn of instances) {
      if (typeof btn.disableAlert === "function") btn.disableAlert();
    }
  } catch {}
  console.log("\nExiting button_test.js");
  process.exit(0);
});

main();


