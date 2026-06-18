# ============================================
# Breeze RMM Customer Portal - Multi-stage Dockerfile
# ============================================
# Astro SSR (node standalone) app served under a base path (default /portal) behind
# the main domain's reverse proxy. See docker/Caddyfile.prod for the carve-out.

# Stage 1: Base image with pnpm
FROM node:24-alpine@sha256:fb71d01345f11b708a3553c66e7c74074f2d506400ea81973343d915cb64eef0 AS base
RUN npm install -g pnpm@10.33.4
RUN apk add --no-cache libc6-compat
WORKDIR /app

# Stage 2: Install dependencies
FROM base AS deps
WORKDIR /app

# Copy workspace configuration + portal manifest (portal has no workspace deps)
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/portal/package.json ./apps/portal/

# Install all dependencies
RUN pnpm install --frozen-lockfile --prefer-offline

# Stage 3: Build the application
FROM base AS builder
WORKDIR /app

ARG NODE_ENV=production
# Base path the portal is served under. Baked at build time (Astro `base`).
ARG PORTAL_BASE_PATH=/portal
# PUBLIC_API_URL is intentionally empty: the browser calls the API same-origin
# (/api/v1/...), which the reverse proxy routes to the API service. Server-side
# rendering uses INTERNAL_API_URL at runtime (see docker-compose.yml).
ARG PUBLIC_API_URL=
ENV NODE_ENV=${NODE_ENV}
ENV PORTAL_BASE_PATH=${PORTAL_BASE_PATH}
ENV PUBLIC_API_URL=${PUBLIC_API_URL}

# Copy dependencies from deps stage
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/portal/node_modules ./apps/portal/node_modules

# Copy source code
COPY apps/portal ./apps/portal
COPY tsconfig.json ./

# Build the Astro application
WORKDIR /app/apps/portal
RUN pnpm build

# Stage 4: Production runner
FROM node:24-alpine@sha256:fb71d01345f11b708a3553c66e7c74074f2d506400ea81973343d915cb64eef0 AS runner
WORKDIR /app

# Install wget for healthcheck
RUN apk add --no-cache wget

# Default base path used by the healthcheck (overridable at runtime).
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4322
ENV PORTAL_BASE_PATH=/portal

# Create non-root user for security
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 astro

# Copy built application and dependencies while preserving pnpm workspace symlink layout.
COPY --from=builder --chown=astro:nodejs /app/apps/portal/dist ./apps/portal/dist
COPY --from=builder --chown=astro:nodejs /app/apps/portal/package.json ./apps/portal/package.json
COPY --from=deps --chown=astro:nodejs /app/apps/portal/node_modules ./apps/portal/node_modules
COPY --from=deps --chown=astro:nodejs /app/node_modules ./node_modules

# Run the portal app from its workspace path so module resolution uses
# apps/portal/node_modules first.
WORKDIR /app/apps/portal

# Switch to non-root user
USER astro

# Expose portal port
EXPOSE 4322

# Health check — hits the login page under the configured base path.
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider "http://localhost:4322${PORTAL_BASE_PATH}/login" || exit 1

# Start the Astro SSR server
CMD ["node", "dist/server/entry.mjs"]
