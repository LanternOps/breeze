# syntax=docker/dockerfile:1

# Build only the isolated executor workspace from the frozen monorepo lockfile.
FROM node:24-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf AS build
RUN npm install -g pnpm@10.34.5
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.json ./
COPY patches ./patches
COPY apps/m365-communications-executor/package.json ./apps/m365-communications-executor/
COPY packages/shared/package.json ./packages/shared/
RUN pnpm install --frozen-lockfile --filter=@breeze/m365-communications-executor...

COPY apps/m365-communications-executor/tsconfig.json apps/m365-communications-executor/tsup.config.ts ./apps/m365-communications-executor/
COPY apps/m365-communications-executor/src ./apps/m365-communications-executor/src
COPY packages/shared/src ./packages/shared/src
RUN pnpm --filter=@breeze/m365-communications-executor build && \
    pnpm --filter=@breeze/m365-communications-executor deploy --legacy --prod /deployed

# The runner contains the compiled entrypoint and production dependencies only.
# Credentials, identity tokens, JWKs, and tenant descriptors are injected by the
# identity-capable deployment environment at runtime; none enter this image.
FROM node:24-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV M365_COMMS_EXECUTOR_AUTOSTART=1

# CVE-2026-14456: the pinned base digest predates fixed libcrypto3/libssl3 3.5.8-r0.
# The credential-boundary hardening guard permits only this exact two-package
# upgrade; remove bundled npm/npx because the runtime entrypoint never uses them.
RUN apk upgrade --no-cache libcrypto3 libssl3 && \
    rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

COPY --from=build --chown=node:node /deployed/node_modules ./node_modules
COPY --from=build --chown=node:node /deployed/dist ./dist
COPY --from=build --chown=node:node /deployed/package.json ./package.json

USER node
EXPOSE 3005
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD ["node", "-e", "fetch(`http://${process.env.M365_COMMS_EXECUTOR_BIND_HOST}:${process.env.M365_COMMS_EXECUTOR_PORT}/healthz`).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "dist/index.cjs"]
