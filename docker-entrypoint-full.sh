#!/bin/sh
set -e

CONFIG_DIR="/app/config"
DEFAULT_DIR="/app/.config"

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

# 启动 nginx
echo "Starting nginx..."
nginx

# 启动主进程
exec "$@"
