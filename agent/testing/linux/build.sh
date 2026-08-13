#!/usr/bin/env bash
# Stage the agent binaries and build the Linux test image.
#
# Builds for the DOCKER host architecture, not the Mac's — on Apple Silicon that
# is arm64 (Docker Desktop's Linux VM is native). Pass an arch to override:
#
#   ./build.sh          # match the Docker host
#   ./build.sh amd64    # test the Intel build (runs under emulation, slower)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="$(cd "$HERE/../.." && pwd)"
VERSION="${VERSION:-0.104.0}"

ARCH="${1:-$(docker version --format '{{.Server.Arch}}')}"
case "$ARCH" in
  arm64|amd64) ;;
  *) echo "usage: $0 [arm64|amd64]" >&2; exit 2 ;;
esac

echo "==> building nu-agent + nu-watchdog (linux/$ARCH, CGO off)"
cd "$AGENT_DIR"
mkdir -p "$HERE/stage"
for b in nu-agent nu-watchdog; do
  CGO_ENABLED=0 GOOS=linux GOARCH="$ARCH" \
    go build -ldflags "-X main.version=$VERSION" \
    -o "$HERE/stage/$b-linux-$ARCH" "./cmd/$b"
done
ls -la "$HERE/stage"

echo "==> docker build (linux/$ARCH)"
cd "$HERE"
docker build --platform "linux/$ARCH" -t nu-agent-linux-test:latest .

echo
echo "next:"
echo "  docker compose up -d"
echo "  docker compose exec linux-endpoint nu-enroll"
