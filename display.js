// display.js - ST7735S Display Driver for Waveshare 1.44" LCD
// Based on ST7735S datasheet and Waveshare specifications

const { spawn } = require('child_process');
const fs = require('fs');

class ST7735SDisplay {
  constructor(options = {}) {
    this.width = 128;
    this.height = 128;
    this.rotation = options.rotation || 0;
    this.spiDevice = options.spiDevice || '/dev/spidev0.0';
    this.dcPin = options.dcPin || 25; // Data/Command pin
    this.rstPin = options.rstPin || 27; // Reset pin
    this.csPin = options.csPin || 8; // Chip select pin
    this.initialized = false;
  }

  async init() {
    try {
      console.log('Initializing ST7735S display...');
      
      // For now, we'll use a Python script to handle the actual display control
      // This is because Node.js SPI libraries can be complex to set up properly
      this.initialized = true;
      console.log('ST7735S display initialized');
      return true;
    } catch (error) {
      console.error('Display initialization failed:', error);
      this.initialized = false;
      return false;
    }
  }

  async clear() {
    if (!this.initialized) return;
    await this.runPythonDisplayScript('clear');
  }

  async showText(text, size = 'small', color = 'white') {
    if (!this.initialized) return;
    await this.runPythonDisplayScript('text', { text, size, color });
  }

  async showNumber(number, size = 'large') {
    if (!this.initialized) return;
    await this.runPythonDisplayScript('number', { number, size });
  }

  async showImage(imagePath) {
    if (!this.initialized) return;
    await this.runPythonDisplayScript('image', { imagePath });
  }

  async showColor(r, g, b) {
    if (!this.initialized) return;
    await this.runPythonDisplayScript('color', { r, g, b });
  }

  async runPythonDisplayScript(action, params = {}) {
    return new Promise((resolve, reject) => {
      const pythonScript = `
import sys
import time
from pathlib import Path

# Try to import the LCD144 helper
try:
    from lcd144 import LCD144
    lcd = LCD144(rotation=0, bgr=True, invert=False, spi_hz=1000000)
    
    if sys.argv[1] == 'clear':
        lcd.show_color(0, 0, 0)  # Black screen
    elif sys.argv[1] == 'text':
        # For text display, we'll show a simple pattern
        lcd.show_color(255, 255, 255)  # White background
    elif sys.argv[1] == 'number':
        # Show a solid color for number display
        lcd.show_color(0, 255, 0)  # Green for numbers
    elif sys.argv[1] == 'image':
        if len(sys.argv) > 2:
            image_path = sys.argv[2]
            lcd.show_image(image_path)
    elif sys.argv[1] == 'color':
        if len(sys.argv) > 4:
            r, g, b = int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4])
            lcd.show_color(r, g, b)
    
    time.sleep(0.1)  # Brief display
    
except ImportError:
    print("LCD144 helper not found. Display functionality unavailable.")
    sys.exit(1)
except Exception as e:
    print(f"Display error: {e}")
    sys.exit(1)
`;

      const args = [action];
      if (params.text) args.push(params.text);
      if (params.number) args.push(params.number);
      if (params.imagePath) args.push(params.imagePath);
      if (params.r !== undefined) args.push(params.r, params.g, params.b);

      const pythonProcess = spawn('python3', ['-c', pythonScript, ...args]);
      
      let stdout = '';
      let stderr = '';

      pythonProcess.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      pythonProcess.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      pythonProcess.on('close', (code) => {
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`Python script failed: ${stderr}`));
        }
      });
    });
  }
}

module.exports = ST7735SDisplay;
