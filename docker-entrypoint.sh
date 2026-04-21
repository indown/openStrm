#!/bin/sh
set -e

export CONFIG_DIR="/app/config"
export DATA_DIR="/app/data"
export LOGS_DIR="/app/logs"
mkdir -p "$CONFIG_DIR" "$DATA_DIR" "$LOGS_DIR"

echo "Starting backend..."
node /app/backend/index.js &

echo "Starting frontend..."
PORT=3000 exec node /app/frontend/server.js
