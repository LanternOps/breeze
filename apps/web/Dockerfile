# ============================================
# Breeze RMM Web Frontend - Multi-stage Dockerfile
# ============================================

# Stage 1: Base image with pnpm
FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS base
RUN npm install -g pnpm@10.34.5
RUN apk add --no-cache libc6-compat
WORKDIR /app

# Stage 2: Install dependencies
FROM base AS deps
WORKDIR /app

# Copy workspace configuration
#
# EVERY workspace package in apps/web's dependency graph must be listed here.
# Stage 3 copies all of packages/ as SOURCE (see `COPY packages ./packages`), so
# a package missing from this list still gets compiled — but with no node_modules
# of its own, which fails at bundle time with an unresolved bare import rather
# than a missing-package error. CI's `Build Web` job does a full workspace
# install and cannot catch this; only the Docker build has this narrow scope.
# (v0.98.0 shipped without a web image this way: @breeze/extension-web-sdk was
# absent here, so its `zod` never installed and Rolldown failed to resolve it.)
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/web/package.json ./apps/web/
COPY packages/shared/package.json ./packages/shared/
COPY packages/extension-web-sdk/package.json ./packages/extension-web-sdk/

# Install all dependencies
RUN pnpm install --frozen-lockfile --prefer-offline

# Stage 3: Build the application
FROM base AS builder
WORKDIR /app

ARG NODE_ENV=production
ARG PUBLIC_API_URL=
ARG PUBLIC_APP_VERSION=0.1.0
# Build-time UI feature flags (empty → off; see apps/web/src/lib/featureFlags.ts)
ARG PUBLIC_ENABLE_NETWORK_DEVICES_IN_LIST=
ENV NODE_ENV=${NODE_ENV}
ENV PUBLIC_API_URL=${PUBLIC_API_URL}
ENV PUBLIC_APP_VERSION=${PUBLIC_APP_VERSION}
ENV PUBLIC_ENABLE_NETWORK_DEVICES_IN_LIST=${PUBLIC_ENABLE_NETWORK_DEVICES_IN_LIST}

# Copy dependencies from deps stage
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules
COPY --from=deps /app/packages ./packages

# Copy source code
COPY apps/web ./apps/web
COPY packages ./packages
COPY tsconfig.json ./

# Build the Astro application
WORKDIR /app/apps/web
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
ENV HOST=0.0.0.0
ENV PORT=4321

# Create non-root user for security
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 astro

# Copy built application and dependencies while preserving pnpm workspace symlink layout.
# /app/apps/web/node_modules links into /app/node_modules/.pnpm.
COPY --from=builder --chown=astro:nodejs /app/apps/web/dist ./apps/web/dist
COPY --from=builder --chown=astro:nodejs /app/apps/web/package.json ./apps/web/package.json
COPY --from=deps --chown=astro:nodejs /app/apps/web/node_modules ./apps/web/node_modules
COPY --from=deps --chown=astro:nodejs /app/node_modules ./node_modules

# Run the web app from its workspace path so module resolution uses apps/web/node_modules first.
WORKDIR /app/apps/web

# Switch to non-root user
USER astro

# Expose web port
EXPOSE 4321

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:4321/ || exit 1

# Start the Astro SSR server
CMD ["node", "dist/server/entry.mjs"]
