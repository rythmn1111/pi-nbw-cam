#!/usr/bin/env python3
"""
Persistent display server for ST7735S display
Communicates with Node.js via stdin/stdout to eliminate subprocess lag
"""

import sys
import json
import time
from PIL import Image, ImageDraw, ImageFont

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
    
    # Font setup
    try:
        font_large = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 50)
        font_medium = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 30)
        font_small = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 20)
    except:
        font_large = ImageFont.load_default()
        font_medium = ImageFont.load_default()
        font_small = ImageFont.load_default()
    
    # Color mapping
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
    
    def clear_display():
        img = Image.new("RGB", (WIDTH, HEIGHT), (0, 0, 0))
        disp.display(img)
    
    def show_text(text, size='medium', color='white'):
        font = font_large if size == 'large' else font_medium if size == 'medium' else font_small
        color_rgb = get_color(color)
        
        img = Image.new("RGB", (WIDTH, HEIGHT), (0, 0, 0))
        draw = ImageDraw.Draw(img)
        
        # Calculate text position
        tw, th = draw.textsize(text, font=font)
        x = (WIDTH - tw) // 2
        y = (HEIGHT - th) // 2
        draw.text((x, y), text, font=font, fill=color_rgb)
        
        disp.display(img)
    
    def show_number(number, size='large', color='white'):
        show_text(str(number), size, color)
    
    def show_color(r, g, b):
        img = Image.new("RGB", (WIDTH, HEIGHT), (r, g, b))
        disp.display(img)
    
    def show_image(image_path):
        try:
            img = Image.open(image_path)
            img = img.resize((WIDTH, HEIGHT))
            disp.display(img)
        except Exception as e:
            print(f"Error loading image: {e}", file=sys.stderr)
    
    # Main server loop
    print("Display server ready", flush=True)
    
    while True:
        try:
            line = sys.stdin.readline()
            if not line:
                break
                
            command = json.loads(line.strip())
            action = command.get('action')
            
            if action == 'clear':
                clear_display()
            elif action == 'text':
                show_text(command.get('text', ''), command.get('size', 'medium'), command.get('color', 'white'))
            elif action == 'number':
                show_number(command.get('number', 0), command.get('size', 'large'), command.get('color', 'white'))
            elif action == 'color':
                show_color(command.get('r', 0), command.get('g', 0), command.get('b', 0))
            elif action == 'image':
                show_image(command.get('imagePath', ''))
            
            # Send acknowledgment
            print(json.dumps({"status": "ok"}), flush=True)
            
        except json.JSONDecodeError:
            print(json.dumps({"status": "error", "message": "Invalid JSON"}), flush=True)
        except Exception as e:
            print(json.dumps({"status": "error", "message": str(e)}), flush=True)

except ImportError as e:
    print(f"ST7735 library not found: {e}", file=sys.stderr)
    print("Please install: pip3 install st7735", file=sys.stderr)
    sys.exit(1)
except Exception as e:
    print(f"Display server error: {e}", file=sys.stderr)
    sys.exit(1)
