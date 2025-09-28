#!/bin/bash
# Simple camera capture script
OUTPUT_FILE="$1"

# Try rpicam-still with shorter timeout and suppress verbose output
timeout 8 rpicam-still -o "$OUTPUT_FILE" --width 640 --height 480 --timeout 1000 2>/dev/null

# Check if file was created
if [ -f "$OUTPUT_FILE" ]; then
    echo "SUCCESS: File created"
    exit 0
else
    echo "ERROR: No file created"
    exit 1
fi
