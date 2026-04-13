#!/bin/sh
set -e

CONFIG_DIR="/app/config"
DEFAULT_DIR="/app/.config"
SETTINGS_FILE="$CONFIG_DIR/settings.json"

mkdir -p "$CONFIG_DIR"

# Initialize config files from defaults
for file in .config.json .account.json .tasks.json .settings.json; do
  TARGET_FILE="$CONFIG_DIR/$(echo $file | sed 's/^\.//')"
  DEFAULT_FILE="$DEFAULT_DIR/$file"

  if [ ! -f "$TARGET_FILE" ]; then
    if [ -f "$DEFAULT_FILE" ]; then
      echo "Creating $TARGET_FILE from default"
      cp "$DEFAULT_FILE" "$TARGET_FILE"
    else
      echo "Warning: default file $DEFAULT_FILE not found, creating empty JSON"
      echo '{}' > "$TARGET_FILE"
    fi
  else
    echo "$TARGET_FILE already exists, skipping"
  fi
done

# Generate internalToken if not present
INTERNAL_TOKEN=$(node -e "
const fs = require('fs');
const settingsFile = '$SETTINGS_FILE';
let settings = {};
try {
  settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
} catch (e) {}

if (!settings.internalToken) {
  const crypto = require('crypto');
  settings.internalToken = crypto.randomBytes(24).toString('base64url');
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2), 'utf-8');
  console.error('Generated new internalToken');
}
console.log(settings.internalToken);
")

export ALIST_API_TOKEN="$INTERNAL_TOKEN"
export CONFIG_DIR="$CONFIG_DIR"
export DATA_DIR="/app/data"
export LOGS_DIR="/app/logs"
echo "Internal API token configured"

# Start Fastify backend (API :4000 + Emby proxy :8091) in background
echo "Starting backend..."
node /app/backend/index.js &

# Start Next.js frontend (:3000)
echo "Starting frontend..."
PORT=3000 exec node /app/frontend/server.js
