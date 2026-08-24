# ========== Stage 1: Install dependencies ==========
FROM node:22-alpine AS deps
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

# ========== Stage 2: Build shared ==========
FROM deps AS shared-builder
COPY packages/shared packages/shared
RUN pnpm --filter @openstrm/shared build

# ========== Stage 3: Build backend ==========
FROM shared-builder AS backend-builder
COPY apps/backend apps/backend
RUN pnpm --filter @openstrm/backend build
# pnpm 的 node_modules 里全是指向根 .pnpm store 的符号链接，直接 COPY 到最终镜像
# 会得到一堆断链（表现为 Cannot find package 'fastify'）。
# pnpm deploy 产出的是自包含的真实依赖树，把 workspace 依赖也一并注入。
RUN pnpm deploy --filter @openstrm/backend --prod /deploy/backend

# ========== Stage 4: Build frontend ==========
FROM shared-builder AS frontend-builder
COPY apps/frontend apps/frontend
RUN pnpm --filter @openstrm/frontend build

# ========== Stage 5: Production image ==========
FROM node:22-alpine AS runner
WORKDIR /app

# 后端：自包含，入口在 backend/dist/
COPY --from=backend-builder /deploy/backend ./backend

# 前端：monorepo 下 Next.js 的 standalone 产物是嵌套的，
# server.js 在 standalone/apps/frontend/ 而不是根部，static 和 public 也要跟着放进去，
# 否则 Next 起不来或者静态资源 404。
COPY --from=frontend-builder /app/apps/frontend/.next/standalone ./frontend
COPY --from=frontend-builder /app/apps/frontend/.next/static ./frontend/apps/frontend/.next/static
COPY --from=frontend-builder /app/apps/frontend/public ./frontend/apps/frontend/public

# Entrypoint
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# 3000 前端 / 4000 API（默认不对外）/ 8091 Emby 代理
EXPOSE 3000 4000 8091

ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
