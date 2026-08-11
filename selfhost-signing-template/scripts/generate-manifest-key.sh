#!/usr/bin/env bash
# generate-manifest-key.sh — one-shot Ed25519 release-manifest keypair for
# breeze-selfhost-signing. Mirrors the official keygen procedure
# (openssl genpkey ed25519 -> SPKI DER -> raw 32-byte suffix, base64).
#
# Only the PRIVATE key is ever stored (as the GitHub Actions secret
# RELEASE_MANIFEST_ED25519_PRIVATE_KEY). The workflow derives the public key
# from it on every run and prints your instance env block in the run summary,
# so nothing here needs committing. Run locally; nothing is uploaded.
set -euo pipefail

command -v openssl >/dev/null 2>&1 || { echo "openssl is required" >&2; exit 1; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

openssl genpkey -algorithm ed25519 -out "$tmp/release-manifest.key" 2>/dev/null
raw_b64="$(openssl pkey -in "$tmp/release-manifest.key" -pubout -outform DER | tail -c 32 | base64)"

cat <<EOF

==========================================================================
1) GitHub secret — in YOUR copy of this repo:
   Settings -> Secrets and variables -> Actions -> New repository secret
   Name : RELEASE_MANIFEST_ED25519_PRIVATE_KEY
   Value: exactly the PEM below, including the BEGIN/END lines
==========================================================================
$(cat "$tmp/release-manifest.key")

==========================================================================
2) Your Breeze instance .env — add or replace:
==========================================================================
RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS=${raw_b64}

==========================================================================
3) Your docker-compose.yml — the api service must MAP the variable
   (a value in .env alone never reaches the container):
==========================================================================
  api:
    environment:
      RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS: \${RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS}

The private key above exists only in a temp dir that is deleted when this
script exits — copy it into the GitHub secret NOW. Never commit it. If you
lose it, rerun this script and update both the secret and your .env
(during rotation you can trust both keys at once:
RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS=oldkey,newkey).
EOF
