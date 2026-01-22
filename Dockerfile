# ---------- 构建 Next.js ----------
FROM node:22-alpine AS frontend-builder
WORKDIR /app/frontend

RUN yarn config set registry https://registry.npmjs.org/ && \
    yarn config set network-timeout 600000 -g

COPY frontend/package*.json ./
COPY frontend/yarn.lock ./
RUN yarn install --frozen-lockfile

COPY frontend .
RUN yarn build

# ---------- 最终镜像 (含 nginx + emby2alist) ----------
FROM node:22-alpine AS runner
WORKDIR /app

# 安装 nginx (alpine 自带 njs 模块)
RUN apk add --no-cache nginx nginx-mod-http-js

# 拷贝 Next.js standalone
COPY --from=frontend-builder /app/frontend/.next/standalone ./frontend
COPY --from=frontend-builder /app/frontend/.next/static ./frontend/.next/static
COPY --from=frontend-builder /app/frontend/public ./frontend/public

# 拷贝 nginx 配置
COPY emby2Alist/nginx/nginx.conf /etc/nginx/nginx.conf
COPY emby2Alist/nginx/conf.d /etc/nginx/conf.d

# 拷贝默认配置
COPY .config /app/.config

# 创建 nginx 缓存目录
RUN mkdir -p /var/cache/nginx/emby/images \
    /var/cache/nginx/emby/subtitles \
    /var/cache/nginx/client_temp \
    /var/log/nginx

# 拷贝启动脚本
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3000 8091

# Next.js 内部监听 8000 端口，nginx 监听 3000 代理过来
ENV PORT=8000
ENV HOSTNAME=0.0.0.0

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "/app/frontend/server.js"]
