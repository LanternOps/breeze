# syntax=docker/dockerfile:1

# Build only the isolated executor workspace from the frozen monorepo lockfile.
FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS build
RUN npm install -g pnpm@10.33.4
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.json ./
COPY apps/m365-graph-read-executor/package.json ./apps/m365-graph-read-executor/
COPY packages/shared/package.json ./packages/shared/
RUN pnpm install --frozen-lockfile --filter=@breeze/m365-graph-read-executor...

COPY apps/m365-graph-read-executor/tsconfig.json apps/m365-graph-read-executor/tsup.config.ts ./apps/m365-graph-read-executor/
COPY apps/m365-graph-read-executor/src ./apps/m365-graph-read-executor/src
COPY packages/shared/src ./packages/shared/src
RUN pnpm --filter=@breeze/m365-graph-read-executor build && \
    pnpm --filter=@breeze/m365-graph-read-executor deploy --legacy --prod /deployed

# The runner contains the compiled entrypoint and production dependencies only.
# Credentials, identity tokens, JWKs, and tenant descriptors are injected by the
# identity-capable deployment environment at runtime; none enter this image.
FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV M365_GRAPH_READ_EXECUTOR_AUTOSTART=1

# The runtime needs only Node. Removing bundled package managers avoids carrying
# their unused dependency trees without resolving mutable Alpine packages.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

COPY --from=build --chown=node:node /deployed/node_modules ./node_modules
COPY --from=build --chown=node:node /deployed/dist ./dist
COPY --from=build --chown=node:node /deployed/package.json ./package.json

USER node
EXPOSE 3003
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD ["node", "-e", "fetch(`http://${process.env.M365_GRAPH_READ_EXECUTOR_BIND_HOST}:${process.env.M365_GRAPH_READ_EXECUTOR_PORT}/healthz`).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "dist/index.cjs"]
