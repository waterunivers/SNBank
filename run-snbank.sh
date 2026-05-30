#!/bin/bash
cd "$(dirname "$0")" || exit 1

echo "Starting SNBank..."
sleep 5

node src/index.js
