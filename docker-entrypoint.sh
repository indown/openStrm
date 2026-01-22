#!/bin/sh
set -e

CONFIG_DIR="/app/config"
DEFAULT_DIR="/app/.config"
SETTINGS_FILE="$CONFIG_DIR/settings.json"
NGINX_MOUNT_CONFIG="/etc/nginx/conf.d/config/constant-mount.js"

mkdir -p "$CONFIG_DIR"

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

# ========== 自动生成/读取 internalToken ==========
INTERNAL_TOKEN=$(node -e "
const fs = require('fs');
const settingsFile = '$SETTINGS_FILE';
let settings = {};
try {
  settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
} catch (e) {}

if (!settings.internalToken) {
  // 生成 32 位随机字符串
  const crypto = require('crypto');
  settings.internalToken = crypto.randomBytes(24).toString('base64url');
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2), 'utf-8');
  console.error('Generated new internalToken');
}
console.log(settings.internalToken);
")

export ALIST_API_TOKEN="$INTERNAL_TOKEN"
echo "Internal API token configured"

# 替换 nginx 配置中的默认 token
if [ -f "$NGINX_MOUNT_CONFIG" ]; then
  sed -i "s/openstrm-internal-token/$INTERNAL_TOKEN/g" "$NGINX_MOUNT_CONFIG"
  echo "Nginx config token updated"
fi

# 启动 nginx
echo "Starting nginx..."
nginx

# 启动主进程
exec "$@"
