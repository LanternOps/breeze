#!/usr/bin/env bash
# download-verified-asset.sh <version> <asset-name> <dest-path> [policy-flag]
# Downloads one official release asset and verifies sha256+size (and the
# intendedUse policy) against the already-verified official manifest.
# Requires: OFFICIAL_MANIFEST_PATH env (set from the verify-official-release
# action's manifest-path output). policy-flag defaults to
# --forbid-signing-input; pass --expect-signing-input for unsigned inputs.
set -euo pipefail

VERSION="$1"
ASSET="$2"
DEST="$3"
POLICY="${4:---forbid-signing-input}"
MANIFEST="${OFFICIAL_MANIFEST_PATH:?OFFICIAL_MANIFEST_PATH not set — run verify-official-release first}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

url="https://github.com/lanternops/breeze/releases/download/v${VERSION}/${ASSET}"
mkdir -p "$(dirname "$DEST")"
curl -fsSL --retry 3 --retry-delay 5 -o "$DEST" "$url"
node "$SCRIPT_DIR/verify-manifest.mjs" check-asset \
  --manifest "$MANIFEST" --name "$ASSET" --file "$DEST" "$POLICY"
