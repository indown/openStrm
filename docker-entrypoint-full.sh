#!/bin/sh
set -e

# 初始化配置目录
if [ ! -d "/app/config" ]; then
    mkdir -p /app/config
fi

# 复制默认配置
for file in /app/.config/*; do
    filename=$(basename "$file")
    if [ ! -f "/app/config/$filename" ]; then
        cp "$file" "/app/config/$filename"
        echo "Created default config: $filename"
    fi
done

# 启动 nginx (后台)
echo "Starting nginx..."
nginx

# 启动 Next.js (前台)
echo "Starting Next.js..."
exec "$@"
