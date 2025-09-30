# ---------- 构建 Next.js ----------
FROM node:22-alpine AS frontend-builder
WORKDIR /app/frontend

# 设置yarn配置
RUN yarn config set registry https://registry.npmjs.org/ && \
    yarn config set network-timeout 600000 -g

# 安装依赖
COPY frontend/package*.json ./
COPY frontend/yarn.lock ./
RUN yarn install --frozen-lockfile

# 拷贝源码并构建 standalone
COPY frontend .
RUN yarn build

# ---------- 构建最终镜像 ----------
FROM node:22-alpine AS runner
WORKDIR /app

# 拷贝 frontend standalone
COPY --from=frontend-builder /app/frontend/.next/standalone ./frontend
COPY --from=frontend-builder /app/frontend/.next/static ./frontend/.next/static
COPY --from=frontend-builder /app/frontend/public ./frontend/public

# 拷贝启动脚本
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

EXPOSE 3000
CMD ["node", "/app/frontend/server.js"]