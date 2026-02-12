# ============================================
# Breeze RMM API - Multi-stage Dockerfile
# ============================================

# Stage 1: Base image with pnpm
FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
RUN apk add --no-cache libc6-compat python3 make g++
WORKDIR /app

# Stage 2: Install dependencies
FROM base AS deps
WORKDIR /app

# Copy workspace configuration
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/api/package.json ./apps/api/
COPY packages/shared/package.json ./packages/shared/

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
FROM node:20-alpine AS runner
WORKDIR /app

# Install wget for healthcheck and runtime dependencies
RUN apk add --no-cache wget

# Set production environment
ENV NODE_ENV=production
ENV API_PORT=3001

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
