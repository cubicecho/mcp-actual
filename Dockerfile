# syntax=docker/dockerfile:1

# ── Stage 1: build ────────────────────────────────────────────────────────────
# Full node image (matches engines >=22.18). @actual-app/api pulls in
# better-sqlite3, a native module — the toolchain is needed whenever a prebuilt
# binary is unavailable for this Node ABI, so install it here rather than
# discovering the failure at image-build time on a new Node release.
FROM node:26-slim AS builder

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Manifests first so the dependency layer caches independently of source changes.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Drop devDependencies in place; the compiled native modules under
# node_modules survive and are copied into the runtime image below.
RUN npm prune --omit=dev

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
# No compiler needed: node_modules (including the built better-sqlite3 binding)
# comes from the builder, which shares this base image and architecture.
FROM node:26-slim

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./

ENV NODE_ENV=production
# The Actual API caches the downloaded budget (a SQLite file) here — mount a
# volume so it survives restarts instead of re-downloading every boot.
ENV DATA_DIR=/data

RUN mkdir -p /data

VOLUME /data

EXPOSE 3000

# /api/status is unauthenticated and answers 200 once the HTTP server is up.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e 'fetch("http://localhost:" + (process.env.PORT || 3000) + "/api/status").then((r) => process.exit(r.status < 500 ? 0 : 1)).catch(() => process.exit(1))'

CMD ["node", "dist/index.js"]
