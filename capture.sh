#!/bin/bash
# Simple camera capture script
OUTPUT_FILE="$1"

# Try rpicam-still with timeout
timeout 10 rpicam-still -o "$OUTPUT_FILE" 2>&1

# Check if file was created
if [ -f "$OUTPUT_FILE" ]; then
    echo "SUCCESS: File created"
    exit 0
else
    echo "ERROR: No file created"
    exit 1
fi
