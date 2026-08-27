# ========== Stage 1: Install dependencies ==========
FROM node:24-alpine AS deps
RUN corepack enable pnpm
# better-sqlite3 是原生模块。musl 的 amd64/arm64 都有官方预编译产物，
# 正常情况下 prebuild-install 直接拉下来用；留着工具链只是为了拉不到时
# 能退回 node-gyp 源码编译而不是硬失败。只在构建阶段，最终镜像不带。
RUN apk add --no-cache python3 make g++
WORKDIR /app
# tsconfig.base.json 必须一起进来：各包的 tsconfig 都 extends 它，缺了 tsc 直接报 TS5083
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY apps/backend/package.json apps/backend/
COPY apps/frontend/package.json apps/frontend/
RUN pnpm install --frozen-lockfile

# ========== Stage 2: Build backend ==========
# shared 是纯类型包，types 直接指向 .ts 源码，不需要单独构建
FROM deps AS backend-builder
COPY packages/shared packages/shared
COPY apps/backend apps/backend
RUN pnpm --filter @openstrm/backend build
# pnpm 的 node_modules 里全是指向根 .pnpm store 的符号链接，直接 COPY 到最终镜像
# 会得到一堆断链（表现为 Cannot find package 'fastify'）。
# pnpm deploy 产出的是自包含的真实依赖树，把 workspace 依赖也一并注入。
RUN pnpm deploy --filter @openstrm/backend --prod /deploy/backend
# 部署产物瘦身。都是运行期用不到的东西：
# - @types/*：纯类型包，被 drizzle-orm 的可选 peer 拖进来的
# - better-sqlite3 的 deps/src/obj：只需要编译好的 .node 二进制
# - .d.ts 和 .map：类型声明和 sourcemap 运行时不会被读
WORKDIR /deploy/backend
RUN rm -rf node_modules/.pnpm/@types+* node_modules/@types && \
    find node_modules/.pnpm -type d \( -path '*better-sqlite3*/deps' \
        -o -path '*better-sqlite3*/src' \
        -o -path '*better-sqlite3*/build/Release/obj*' \
        -o -path '*better-sqlite3*/build/deps' \) -prune -exec rm -rf {} + && \
    find node_modules -name '*.d.ts' -delete && \
    find node_modules -name '*.d.cts' -delete && \
    find node_modules -name '*.d.mts' -delete && \
    find node_modules -name '*.map' -delete && \
    test -f node_modules/better-sqlite3/build/Release/better_sqlite3.node

# ========== Stage 3: Build frontend ==========
# 生产构建是纯静态导出（apps/frontend/out），由后端进程托管，镜像里没有 Next 的服务进程
FROM deps AS frontend-builder
COPY packages/shared packages/shared
COPY apps/frontend apps/frontend
RUN pnpm --filter @openstrm/frontend build

# ========== Stage 4: Production image ==========
FROM node:24-alpine AS runner
WORKDIR /app

# 后端：自包含，入口在 backend/dist/
COPY --from=backend-builder /deploy/backend ./backend

# 前端：静态文件，entrypoint 用 FRONTEND_DIR 指给后端
COPY --from=frontend-builder /app/apps/frontend/out ./frontend

# Entrypoint
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# 3000 管理界面 + API / 8091 Emby 代理
EXPOSE 3000 8091

ENV NODE_ENV=production
# entrypoint 用它决定 API 进程的端口；写成镜像 ENV 是为了让 HEALTHCHECK 也能读到
ENV BACKEND_PORT=3000

# /api/health 不鉴权，只验证进程活着且库能读；代理进程退出时 entrypoint 会让整个容器退出
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${BACKEND_PORT}/api/health" >/dev/null || exit 1

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
