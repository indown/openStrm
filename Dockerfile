# ========== Stage 1: Install dependencies ==========
FROM node:22-alpine AS deps
RUN corepack enable pnpm
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
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

# ========== Stage 4: Build frontend ==========
FROM shared-builder AS frontend-builder
COPY apps/frontend apps/frontend
RUN pnpm --filter @openstrm/frontend build

# ========== Stage 5: Production image ==========
FROM node:22-alpine AS runner
WORKDIR /app

# Copy backend build + dependencies
COPY --from=backend-builder /app/apps/backend/dist ./backend
COPY --from=backend-builder /app/apps/backend/node_modules ./backend/node_modules
COPY --from=shared-builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=shared-builder /app/packages/shared/package.json ./packages/shared/

# Copy frontend standalone output
COPY --from=frontend-builder /app/apps/frontend/.next/standalone ./frontend
COPY --from=frontend-builder /app/apps/frontend/.next/static ./frontend/.next/static
COPY --from=frontend-builder /app/apps/frontend/public ./frontend/public

# Copy default config
COPY .config /app/.config

# Entrypoint
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# API + Emby proxy
EXPOSE 3000 4000 8091

ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
