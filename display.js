// display.js - ST7735S Display Driver for Waveshare 1.44" LCD
// Uses persistent Python server to eliminate subprocess lag

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
    this.serverProcess = null;
  }

  async init() {
    try {
      console.log('Initializing ST7735S display...');
      
      // Start persistent Python display server
      this.serverProcess = spawn('python3', [__dirname + '/display_server.py'], {
        stdio: ['pipe', 'pipe', 'pipe']
      });
      
      // Wait for server to be ready
      await new Promise((resolve, reject) => {
        this.serverProcess.stdout.on('data', (data) => {
          if (data.toString().includes('Display server ready')) {
            resolve();
          }
        });
        
        this.serverProcess.stderr.on('data', (data) => {
          reject(new Error(data.toString()));
        });
        
        this.serverProcess.on('error', (error) => {
          reject(error);
        });
        
        // Timeout after 5 seconds
        setTimeout(() => reject(new Error('Display server startup timeout')), 5000);
      });
      
      this.initialized = true;
      console.log('ST7735S display initialized');
      return true;
    } catch (error) {
      console.error('Display initialization failed:', error);
      this.initialized = false;
      if (this.serverProcess) {
        this.serverProcess.kill();
        this.serverProcess = null;
      }
      return false;
    }
  }

  async clear() {
    if (!this.initialized || !this.serverProcess) return;
    await this.sendCommand({ action: 'clear' });
  }

  async showText(text, size = 'small', color = 'white') {
    if (!this.initialized || !this.serverProcess) return;
    await this.sendCommand({ action: 'text', text, size, color });
  }

  async showNumber(number, size = 'large') {
    if (!this.initialized || !this.serverProcess) return;
    await this.sendCommand({ action: 'number', number, size, color: 'white' });
  }

  async showImage(imagePath) {
    if (!this.initialized || !this.serverProcess) return;
    await this.sendCommand({ action: 'image', imagePath });
  }

  async showColor(r, g, b) {
    if (!this.initialized || !this.serverProcess) return;
    await this.sendCommand({ action: 'color', r, g, b });
  }

  async sendCommand(command) {
    return new Promise((resolve, reject) => {
      if (!this.serverProcess) {
        reject(new Error('Display server not running'));
        return;
      }

      const timeout = setTimeout(() => {
        reject(new Error('Display command timeout'));
      }, 1000);

      const onData = (data) => {
        try {
          const response = JSON.parse(data.toString());
          clearTimeout(timeout);
          this.serverProcess.stdout.removeListener('data', onData);
          if (response.status === 'ok') {
            resolve(response);
          } else {
            reject(new Error(response.message || 'Display command failed'));
          }
        } catch (e) {
          // Ignore non-JSON output
        }
      };

      this.serverProcess.stdout.on('data', onData);
      this.serverProcess.stdin.write(JSON.stringify(command) + '\n');
    });
  }

  async cleanup() {
    if (this.serverProcess) {
      this.serverProcess.kill();
      this.serverProcess = null;
    }
    this.initialized = false;
  }
}

module.exports = ST7735SDisplay;
