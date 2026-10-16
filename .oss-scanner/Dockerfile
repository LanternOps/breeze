# Build image for Anthropic's OSS Scanner (https://red.anthropic.com/oss-scanner/).
# Enrolment lives at anthropics/oss-scanner:projects/breeze/project.yaml, which points here.
#
# Contract: the scanner builds this file with the repository checkout as the build context
# (it strips our .dockerignore first, so agent/ and friends are present), with network access.
# After the build the image is moved to a network with no Internet access and an agent audits
# /src offline, so everything the build or the tests need is fetched here.
#
# This is NOT a release image. Release images are apps/api/Dockerfile and apps/web/Dockerfile.
# Base is Debian so the scanner's tooling layer (gdb, strace, valgrind, ...) can install via apt.

FROM node:22-bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    CI=true \
    HUSKY=0 \
    GOTOOLCHAIN=local \
    PATH=/usr/local/go/bin:/root/go/bin:$PATH

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates git python3 build-essential pkg-config curl xz-utils \
    && rm -rf /var/lib/apt/lists/*

# pnpm version must match packageManager in package.json.
RUN npm install -g pnpm@10.34.5

# scanner contract: the checkout lives inside the image, at /src
COPY . /src
WORKDIR /src

# Go toolchain for agent/, at exactly the version agent/go.mod requires.
RUN set -e; ver="$(sed -n 's/^go \([0-9.]*\).*/\1/p' agent/go.mod)"; arch="$(dpkg --print-architecture)" \
    && curl -fsSL "https://go.dev/dl/go${ver}.linux-${arch}.tar.gz" -o /tmp/go.tgz \
    && tar -C /usr/local -xzf /tmp/go.tgz && rm /tmp/go.tgz \
    && go version

# --- JavaScript/TypeScript workspace (API, web, portal, shared packages, ee/ extensions) ---
# Same as CI: one frozen install for the whole workspace.
RUN pnpm install --frozen-lockfile

# Build what the hosted and self-hosted product actually ships from this tree.
RUN pnpm --filter @breeze/api build \
    && pnpm --filter @breeze/ext-workspace build:web
# The web dashboard and customer portal are static Astro builds; a failure here should not
# abort the scan of the server code, so it only warns.
RUN pnpm --filter @breeze/web build || echo "WARNING: web build failed"
RUN pnpm --filter @breeze/portal build || echo "WARNING: portal build failed"

# --- Go agent (agent/): the component that runs on managed endpoints ---
RUN cd agent && go mod download && CGO_ENABLED=0 go build ./... && CGO_ENABLED=0 go vet ./... \
    && CGO_ENABLED=0 go build -o bin/breeze-agent ./cmd/breeze-agent

# --- Cheap tests, so a broken image is noticed. Failures warn rather than abort. ---
# The API's full vitest suite is large (8 CI shards) and its RLS/integration contract suites
# need Postgres + Redis (see docker-compose.test.yml); .oss-scanner/threat_model.md says how to
# run them. Here we run the shared package tests and the Go unit tests only.
RUN pnpm --filter @breeze/shared exec vitest run || echo "WARNING: shared tests reported failures"
RUN cd agent && (CGO_ENABLED=0 timeout 900 go test ./... || echo "WARNING: go test reported failures")
