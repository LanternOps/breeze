# ============================================
# Breeze RMM API - Multi-stage Dockerfile
# ============================================

# Stage 1: Base image with pnpm
FROM node:24-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf AS base
RUN npm install -g pnpm@10.34.5
RUN apk add --no-cache libc6-compat python3 make g++
WORKDIR /app

# Stage 2: Install dependencies
FROM base AS deps
WORKDIR /app

# Copy workspace configuration
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY patches ./patches
COPY apps/api/package.json ./apps/api/
COPY packages/shared/package.json ./packages/shared/
# apps/api and the built-in @breeze/ext-workspace extension depend on these
# source-only workspace packages; their manifests must be present so pnpm
# creates the workspace symlinks the API's tsup bundle resolves at build time.
COPY packages/extension-sdk/package.json ./packages/extension-sdk/
COPY packages/extension-web-sdk/package.json ./packages/extension-web-sdk/
COPY packages/extension-testkit/package.json ./packages/extension-testkit/
COPY ee/workspace/package.json ./ee/workspace/

# Install all dependencies
RUN pnpm install --frozen-lockfile --prefer-offline

# Stage 3: Build the application
FROM base AS builder
WORKDIR /app

ARG NODE_ENV=production
ENV NODE_ENV=${NODE_ENV}

# Copy dependencies from deps stage
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=deps /app/packages ./packages
COPY --from=deps /app/ee ./ee

# Copy source code
COPY apps/api ./apps/api
COPY packages ./packages
COPY ee ./ee
COPY tsconfig.json ./

# Build the built-in workspace extension's web bundle. Its server code needs
# no separate build step here -- the API's own tsup build (below) bundles
# @breeze/ext-workspace source directly via noExternal: [/^@breeze\//].
RUN pnpm --filter @breeze/ext-workspace build:web

# Build the API
WORKDIR /app/apps/api
RUN pnpm build

# Stage 4: Production runner
FROM node:24-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf AS runner
WORKDIR /app

# Refresh libcrypto3/libssl3 because the pinned base digest predates the fix for
# CVE-2026-14456; install wget for healthcheck; remove the bundled npm (and its
# vendored undici, CVE-2026-12151) since the runtime entrypoint is `node`, not npm.
RUN apk upgrade --no-cache libcrypto3 libssl3 && \
    apk add --no-cache wget && \
    rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

# Set production environment
ENV NODE_ENV=production
ENV API_PORT=3001
ARG APP_VERSION=0.2.0
ENV APP_VERSION=${APP_VERSION}

# Create non-root user for security
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 hono

# Copy API build output and dependencies while preserving pnpm workspace symlink layout.
# /app/apps/api/node_modules links into /app/node_modules/.pnpm.
COPY --from=builder --chown=hono:nodejs /app/apps/api/dist ./apps/api/dist
COPY --from=builder --chown=hono:nodejs /app/apps/api/package.json ./apps/api/package.json
COPY --from=deps --chown=hono:nodejs /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=deps --chown=hono:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=hono:nodejs /app/packages ./packages

# Built-in extensions: this runner's WORKDIR ends at /app/apps/api (see below),
# and builtinRegistry.ts's CJS-bundle fallback resolves packageDir relative to
# process.cwd() -- so the copy destination must be apps/api/ee, not /app/ee.
COPY --from=builder --chown=hono:nodejs /app/ee ./apps/api/ee

# Copy migration files for auto-migrate on startup
COPY --from=builder --chown=hono:nodejs /app/apps/api/migrations ./apps/api/migrations
# Document theme assets (vendored OFL font files for proposal/quote PDF
# rendering — see apps/api/src/services/documentThemes.ts). FONT_DIR resolves
# from process.cwd(), and this runner's cwd ends at /app/apps/api (WORKDIR
# below), so the destination mirrors the migrations copy above.
COPY --from=builder --chown=hono:nodejs /app/apps/api/assets ./apps/api/assets
# Run the API from its workspace path so module resolution uses apps/api/node_modules first.
WORKDIR /app/apps/api

# Switch to non-root user
USER hono

# Expose API port
EXPOSE 3001

# Health check endpoint
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3001/health || exit 1

# Start the application
CMD ["node", "dist/index.cjs"]
