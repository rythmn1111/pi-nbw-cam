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
    const fontSize = size === 'large' ? 50 : size === 'medium' ? 30 : 20;
    await this.runPythonDisplayScript('text', { text, size: fontSize, color });
  }

  async showNumber(number, size = 'large') {
    if (!this.initialized) return;
    const fontSize = size === 'large' ? 50 : size === 'medium' ? 30 : 20;
    await this.runPythonDisplayScript('number', { number, size: fontSize, color: 'white' });
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
from PIL import Image, ImageDraw, ImageFont

# Try to import the ST7735 library (like your working Python code)
try:
    from st7735 import ST7735
    
    # LCD config (tuned for Waveshare 1.44") - same as your working code
    DC_PIN, RST_PIN, BL_PIN = 25, 27, 24
    WIDTH, HEIGHT = 128, 128
    OFFSET_LEFT, OFFSET_TOP = 2, 3
    SPI_HZ = 2_000_000
    BGR, INVERT, ROTATION = True, False, 0
    
    disp = ST7735(
        port=0, cs=0, dc=DC_PIN, rst=RST_PIN, backlight=BL_PIN,
        width=WIDTH, height=HEIGHT, rotation=ROTATION,
        bgr=BGR, invert=INVERT, spi_speed_hz=SPI_HZ,
        offset_left=OFFSET_LEFT, offset_top=OFFSET_TOP
    )
    disp.begin()
    
    # Font setup - get size from args
    font_size = 40  # default
    if len(sys.argv) > 3:
        try:
            font_size = int(sys.argv[3])
        except:
            pass
    
    try:
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", font_size)
    except:
        font = ImageFont.load_default()
    
    # Color setup
    def get_color(color_name):
        colors = {
            'white': (255, 255, 255),
            'black': (0, 0, 0),
            'red': (255, 0, 0),
            'green': (0, 255, 0),
            'blue': (0, 0, 255),
            'yellow': (255, 255, 0),
            'cyan': (0, 255, 255),
            'magenta': (255, 0, 255)
        }
        return colors.get(color_name, (255, 255, 255))
    
    if sys.argv[1] == 'clear':
        img = Image.new("RGB", (WIDTH, HEIGHT), (0, 0, 0))
        disp.display(img)
    elif sys.argv[1] == 'text':
        text = sys.argv[2] if len(sys.argv) > 2 else "TEXT"
        color_name = sys.argv[4] if len(sys.argv) > 4 else "white"
        color = get_color(color_name)
        
        img = Image.new("RGB", (WIDTH, HEIGHT), (0, 0, 0))
        draw = ImageDraw.Draw(img)
        
        # Calculate text position
        tw, th = draw.textsize(text, font=font)
        x = (WIDTH - tw) // 2
        y = (HEIGHT - th) // 2
        draw.text((x, y), text, font=font, fill=color)
        
        disp.display(img)
    elif sys.argv[1] == 'number':
        number = sys.argv[2] if len(sys.argv) > 2 else "0"
        color_name = sys.argv[4] if len(sys.argv) > 4 else "white"
        color = get_color(color_name)
        
        img = Image.new("RGB", (WIDTH, HEIGHT), (0, 0, 0))
        draw = ImageDraw.Draw(img)
        
        # Calculate number position
        tw, th = draw.textsize(number, font=font)
        x = (WIDTH - tw) // 2
        y = (HEIGHT - th) // 2
        draw.text((x, y), number, font=font, fill=color)
        
        disp.display(img)
    elif sys.argv[1] == 'image':
        if len(sys.argv) > 2:
            image_path = sys.argv[2]
            img = Image.open(image_path)
            img = img.resize((WIDTH, HEIGHT))
            disp.display(img)
    elif sys.argv[1] == 'color':
        if len(sys.argv) > 4:
            r, g, b = int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4])
            img = Image.new("RGB", (WIDTH, HEIGHT), (r, g, b))
            disp.display(img)
    
    time.sleep(0.1)  # Brief display
    
except ImportError as e:
    print(f"ST7735 library not found: {e}")
    print("Please install: pip3 install st7735")
    sys.exit(1)
except Exception as e:
    print(f"Display error: {e}")
    sys.exit(1)
`;

      const args = [action];
      if (params.text) {
        args.push(params.text);
        if (params.size) args.push(params.size);
        if (params.color) args.push(params.color);
      }
      if (params.number) {
        args.push(params.number);
        if (params.size) args.push(params.size);
        if (params.color) args.push(params.color);
      }
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
