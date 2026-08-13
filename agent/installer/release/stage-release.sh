#!/usr/bin/env bash
# Build every agent-family binary, write a signed release-artifact-manifest, and
# lay the whole set out ready to copy into the server's binaries volume.
#
#   ./stage-release.sh                 # -> agent/dist/release/
#   VERSION=0.105.0 ./stage-release.sh
#
# WHY THIS EXISTS
# ---------------
# The server (BINARY_SOURCE=local) scans AGENT_BINARY_DIR and registers whatever
# it finds as the fleet's upgrade target. Ship nothing and it keeps serving the
# stock upstream binaries — which segfault on Apple Silicon M-series during Go
# package init (go-m1cpu). A privileged agent then "upgrades" itself into a
# crash loop on its first heartbeat.
#
# Staging a manifest SIGNED WITH OUR KEY at the binaries volume root makes the
# server register those assets against the key embedded in our agent
# (internal/updater/updater.go: embeddedManifestPublicKeys) instead of
# re-signing with a per-deployment key. That is the whole trust chain.
#
# FILENAMES ARE PROTOCOL, NOT BRANDING
# ------------------------------------
# apps/api/src/services/binarySync.ts parseBinaryFilename() matches
# ^breeze-{component}-{os}-{arch}[.exe]$ exactly. These names never reach a
# customer — they live inside a Docker volume — but rename them and the server
# silently discovers zero binaries and falls back to upstream.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="$(cd "$HERE/../.." && pwd)"
REPO_DIR="$(cd "$AGENT_DIR/.." && pwd)"

# Must match BREEZE_VERSION / APP_VERSION on the server. binarySync treats a
# VERSION file that disagrees with BREEZE_VERSION as a "stale binaries volume"
# and falls back to pulling from GitHub — which is exactly the upstream binary
# we are here to stop serving.
VERSION="${VERSION:-0.104.0}"
REPOSITORY="${REPOSITORY:-bloomingbrands/breeze}"
KEY="${SIGNING_KEY:-$HOME/.nu-agent-signing/nu-release-manifest.ed25519.key}"
OUT="${OUT:-$AGENT_DIR/dist/release}"

# Default to what the server actually serves today. `backup` is a real scanned
# component but has never been staged here, and registering it would start
# handing the fleet a component it has never had — a separate decision from
# fixing the update trust chain. Override to include it: COMPONENTS="agent watchdog backup"
read -r -a COMPONENTS <<< "${COMPONENTS:-agent watchdog}"
# os:arch pairs. Windows arm64 is included even though upstream never shipped
# it — Windows 11 on ARM otherwise runs the amd64 build under emulation.
TARGETS=(darwin:arm64 darwin:amd64 linux:arm64 linux:amd64 windows:amd64 windows:arm64)

[[ -f "$KEY" ]] || { echo "signing key not found: $KEY" >&2; exit 1; }

rm -rf "$OUT"; mkdir -p "$OUT"
cd "$AGENT_DIR"

echo "==> building $((${#COMPONENTS[@]} * ${#TARGETS[@]})) binaries (v$VERSION, CGO off)"
for c in "${COMPONENTS[@]}"; do
  for t in "${TARGETS[@]}"; do
    os="${t%%:*}"; arch="${t##*:}"
    ext=""; [[ "$os" == "windows" ]] && ext=".exe"
    CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" \
      go build -ldflags "-X main.version=$VERSION" \
      -o "$OUT/breeze-$c-$os-$arch$ext" "./cmd/nu-$c"
  done
done

# The server reads this to decide what version it is serving.
printf '%s\n' "$VERSION" > "$OUT/VERSION"

echo "==> writing release-artifact-manifest.json"
SOURCE_COMMIT="$(git -C "$REPO_DIR" rev-parse 'HEAD^{commit}' 2>/dev/null || echo unknown)" \
VERSION="$VERSION" REPOSITORY="$REPOSITORY" OUT="$OUT" python3 <<'PY'
import hashlib, json, os
from pathlib import Path

out = Path(os.environ["OUT"])
# Same classification the upstream release workflow applies. The API does not
# enforce platformTrust (binarySync calls the verifier without
# expectedPlatformTrust), but keeping the shape identical means a future
# verifier that DOES enforce it will not reject our manifest wholesale.
# Must mirror requiredPlatformTrustFor() in
# apps/api/src/services/releaseAssetTrust.ts. The field declares what the
# PLATFORM requires for that artifact shape — it is not an assertion that we
# signed it. assertDistributableReleaseAsset() fails closed on a mismatch, and
# a mismatched asset silently drops out of the official-manifest path into
# per-deployment re-signing (it still gets served, just off a different key).
#
# Do not copy the upstream release workflow's "none" for windows agent-family
# assets: that path is only reachable for breeze-agent.msi under the explicit
# self-host relaxation, and .exe assets have no such carve-out.
def platform_trust(name: str) -> str:
    if name.endswith(".exe") or name.endswith(".msi"):
        return "windows-authenticode-required"
    if "-darwin-" in name:
        return "macos-developer-id-notarization-required"
    return "release-workflow-produced"

assets = []
for p in sorted(out.iterdir(), key=lambda i: i.name):
    if not p.is_file() or p.name in {"VERSION"}:
        continue
    assets.append({
        "name": p.name,
        "sha256": hashlib.sha256(p.read_bytes()).hexdigest(),
        "size": p.stat().st_size,
        "platformTrust": platform_trust(p.name),
        "edition": "self-host",
    })

manifest = {
    "schemaVersion": 1,
    "repository": os.environ["REPOSITORY"],
    "release": "v" + os.environ["VERSION"],
    "sourceCommit": os.environ["SOURCE_COMMIT"],
    "assets": assets,
}
# Byte-for-byte the upstream serialization. The signature covers these exact
# bytes, so indent/sort/trailing-newline are all load-bearing.
(out / "release-artifact-manifest.json").write_text(
    json.dumps(manifest, indent=2, sort_keys=True) + "\n"
)
print(f"   {len(assets)} assets")
PY

echo "==> signing manifest, then verifying before it can reach the server"
# node:crypto, not openssl: macOS ships LibreSSL, whose pkeyutl has no -rawin
# and so cannot do Ed25519 at all. node is also the exact verifier the API uses
# (selfhost-signing-template/scripts/verify-manifest.mjs), so a signature that
# passes here passes there.
KEY="$KEY" OUT="$OUT" node --input-type=module <<'JS'
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const out = process.env.OUT;
const keyPath = process.env.KEY;
const manifestPath = join(out, 'release-artifact-manifest.json');
const sigPath = join(out, 'release-artifact-manifest.json.ed25519');

const manifest = readFileSync(manifestPath);
const priv = createPrivateKey(readFileSync(keyPath, 'utf8'));
// Ed25519 signs the message directly — algorithm MUST be null, not a digest name.
const sig = sign(null, manifest, priv);
if (sig.length !== 64) throw new Error(`expected 64-byte signature, got ${sig.length}`);
writeFileSync(sigPath, sig.toString('base64'));

const pub = createPublicKey(readFileSync(keyPath.replace(/\.key$/, '.pub'), 'utf8'));
if (!verify(null, manifest, pub, Buffer.from(readFileSync(sigPath, 'utf8'), 'base64'))) {
  throw new Error('signature verification FAILED against the public key');
}
// The raw 32-byte form is what the server env var wants.
const raw = pub.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
console.log('   signature verifies');
console.log('   RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS=' + raw);
JS

echo
echo "staged in $OUT"
ls -la "$OUT" | sed 's/^/  /'
