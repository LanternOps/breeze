# ============================================
# Breeze RMM Web Frontend - Multi-stage Dockerfile
# ============================================

# Stage 1: Base image with pnpm
FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
RUN apk add --no-cache libc6-compat
WORKDIR /app

# Stage 2: Install dependencies
FROM base AS deps
WORKDIR /app

# Copy workspace configuration
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/web/package.json ./apps/web/
COPY packages/shared/package.json ./packages/shared/ 2>/dev/null || mkdir -p ./packages/shared

# Install all dependencies
RUN pnpm install --frozen-lockfile --prefer-offline

# Stage 3: Build the application
FROM base AS builder
WORKDIR /app

ARG NODE_ENV=production
ARG PUBLIC_API_URL=http://localhost:3001
ENV NODE_ENV=${NODE_ENV}
ENV PUBLIC_API_URL=${PUBLIC_API_URL}

# Copy dependencies from deps stage
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules 2>/dev/null || true
COPY --from=deps /app/packages ./packages 2>/dev/null || true

# Copy source code
COPY apps/web ./apps/web
COPY packages ./packages 2>/dev/null || true
COPY tsconfig.json ./

# Build the Astro application
WORKDIR /app/apps/web
RUN pnpm build

# Stage 4: Production runner
FROM node:20-alpine AS runner
WORKDIR /app

# Install wget for healthcheck
RUN apk add --no-cache wget

# Set production environment
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4321

# Create non-root user for security
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 astro

# Copy built application (Astro SSR output)
COPY --from=builder --chown=astro:nodejs /app/apps/web/dist ./dist
COPY --from=builder --chown=astro:nodejs /app/apps/web/package.json ./

# Copy node_modules for SSR runtime
COPY --from=deps --chown=astro:nodejs /app/apps/web/node_modules ./node_modules 2>/dev/null || true
COPY --from=deps --chown=astro:nodejs /app/node_modules ./node_modules

# Switch to non-root user
USER astro

# Expose web port
EXPOSE 4321

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:4321/ || exit 1

# Start the Astro SSR server
CMD ["node", "./dist/server/entry.mjs"]
