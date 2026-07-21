# ============================================
# Breeze RMM API - Multi-stage Dockerfile
# ============================================

# Stage 1: Base image with pnpm
FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS base
RUN npm install -g pnpm@10.34.5
RUN apk add --no-cache libc6-compat python3 make g++
WORKDIR /app

# Stage 2: Install dependencies
FROM base AS deps
WORKDIR /app

# Copy workspace configuration
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json ./apps/api/
COPY packages/shared/package.json ./packages/shared/
# apps/api depends on these source-only workspace packages (@breeze/extension-api
# re-exports @breeze/extension-sdk); their manifests must be present so pnpm
# creates the workspace symlinks the API's tsup bundle resolves at build time.
COPY packages/extension-api/package.json ./packages/extension-api/
COPY packages/extension-sdk/package.json ./packages/extension-sdk/

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

# Copy source code
COPY apps/api ./apps/api
COPY packages ./packages
COPY tsconfig.json ./

# Build the API
WORKDIR /app/apps/api
RUN pnpm build

# Stage 4: Production runner
FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS runner
WORKDIR /app

# Install wget for healthcheck; remove the bundled npm (and its vendored undici,
# CVE-2026-12151) since the runtime entrypoint is `node`, not npm.
RUN apk add --no-cache wget && \
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

# Copy migration files for auto-migrate on startup
COPY --from=builder --chown=hono:nodejs /app/apps/api/migrations ./apps/api/migrations
# Runtime-extension mount point: deployments deliver extensions as SIGNED
# bundles by mounting extensions.yaml (+ artifacts) here. Created empty and
# owned by the runtime user; without a mount both the reconciler and the
# (deprecated, flag-gated) legacy source loader treat it as a clean no-op.
# Without this ENV the CJS bundle would fall back to a cwd-derived path that
# does not exist in this image's layout, silently ignoring any mount.
RUN mkdir -p /app/extensions && chown hono:nodejs /app/extensions
ENV BREEZE_EXTENSIONS_DIR=/app/extensions
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
