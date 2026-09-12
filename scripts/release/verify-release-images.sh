#!/usr/bin/env bash

set -euo pipefail
umask 077

usage() {
  echo "usage: $0 --manifest FILE --signature FILE --expected-repository OWNER/REPO --expected-release TAG [--require NAME=REPOSITORY@DIGEST]... [--emit-env FILE]" >&2
  exit 2
}

manifest=""
signature=""
expected_repository=""
expected_release=""
emit_env=""
required=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --manifest) manifest="${2:-}"; shift 2 ;;
    --signature) signature="${2:-}"; shift 2 ;;
    --expected-repository) expected_repository="${2:-}"; shift 2 ;;
    --expected-release) expected_release="${2:-}"; shift 2 ;;
    --require) required+=("${2:-}"); shift 2 ;;
    --emit-env) emit_env="${2:-}"; shift 2 ;;
    *) usage ;;
  esac
done

[[ -f "$manifest" && -f "$signature" && -n "$expected_repository" && -n "$expected_release" ]] || usage
[[ "$(wc -c < "$manifest" | tr -d ' ')" -le 1048576 ]] || { echo "release manifest exceeds 1 MiB" >&2; exit 1; }
openssl_bin="${BREEZE_OPENSSL_BIN:-openssl}"
command -v "$openssl_bin" >/dev/null 2>&1 || { echo "OpenSSL is required for release image verification" >&2; exit 1; }

verify_dir="$(mktemp -d)"
cleanup() { rm -rf "$verify_dir"; }
trap cleanup EXIT

signature_text="$(tr -d '\r\n' < "$signature")"
[[ "$signature_text" =~ ^[A-Za-z0-9+/]+={0,2}$ ]] || { echo "release manifest signature is not base64" >&2; exit 1; }
printf '%s' "$signature_text" | "$openssl_bin" base64 -d -A > "$verify_dir/signature.bin"
[[ "$(wc -c < "$verify_dir/signature.bin" | tr -d ' ')" -eq 64 ]] || { echo "release manifest signature is not Ed25519" >&2; exit 1; }

configured_keys="${RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS:-}"
[[ -n "$configured_keys" ]] || { echo "no release manifest public key is configured" >&2; exit 1; }
signature_valid="false"
IFS=',' read -r -a public_keys <<< "$configured_keys"
for index in "${!public_keys[@]}"; do
  key="${public_keys[$index]//[[:space:]]/}"
  [[ -n "$key" ]] || continue
  if ! printf '%s' "$key" | "$openssl_bin" base64 -d -A > "$verify_dir/key.raw" 2>/dev/null; then
    continue
  fi
  key_bytes="$(wc -c < "$verify_dir/key.raw" | tr -d ' ')"
  if [[ "$key_bytes" -eq 32 ]]; then
    # DER SubjectPublicKeyInfo prefix for a raw 32-byte Ed25519 public key.
    printf '\060\052\060\005\006\003\053\145\160\003\041\000' > "$verify_dir/key.der"
    dd if="$verify_dir/key.raw" of="$verify_dir/key.der" bs=1 seek=12 conv=notrunc status=none
  else
    cp "$verify_dir/key.raw" "$verify_dir/key.der"
  fi
  if "$openssl_bin" pkeyutl -verify -pubin -keyform DER -inkey "$verify_dir/key.der" \
      -rawin -in "$manifest" -sigfile "$verify_dir/signature.bin" >/dev/null 2>&1; then
    signature_valid="true"
    break
  fi
done
[[ "$signature_valid" == "true" ]] || { echo "release manifest signature verification failed" >&2; exit 1; }

# The signed release workflow emits canonical, pretty-printed JSON. Parse only
# that narrow form and fail closed on drift; do not eval or source JSON text.
grep -Fqx '  "schemaVersion": 1,' "$manifest" || { echo "release manifest schemaVersion must be 1" >&2; exit 1; }
manifest_repository="$(sed -n 's/^  "repository": "\([A-Za-z0-9_.-]*\/[A-Za-z0-9_.-]*\)",$/\1/p' "$manifest")"
manifest_repository_lower="$(printf '%s' "$manifest_repository" | tr '[:upper:]' '[:lower:]')"
expected_repository_lower="$(printf '%s' "$expected_repository" | tr '[:upper:]' '[:lower:]')"
[[ -n "$manifest_repository" && "$manifest_repository_lower" == "$expected_repository_lower" ]] || { echo "release manifest repository mismatch" >&2; exit 1; }
grep -Fqx "  \"release\": \"${expected_release}\"," "$manifest" || { echo "release manifest release mismatch" >&2; exit 1; }
[[ "$(grep -Ec '^  "sourceCommit": "[0-9a-f]{40}"$' "$manifest")" -eq 1 ]] || { echo "release manifest sourceCommit is invalid" >&2; exit 1; }

awk '
  /^  "images": \[$/ { in_images=1; next }
  in_images && /^  \],?$/ { in_images=0; exit }
  in_images && /^    \{$/ { digest=""; name=""; repository=""; next }
  in_images && /^      "digest": "/ { value=$0; sub(/^      "digest": "/, "", value); sub(/",?$/, "", value); digest=value; next }
  in_images && /^      "name": "/ { value=$0; sub(/^      "name": "/, "", value); sub(/",?$/, "", value); name=value; next }
  in_images && /^      "repository": "/ { value=$0; sub(/^      "repository": "/, "", value); sub(/",?$/, "", value); repository=value; next }
  in_images && /^    \},?$/ {
    if (digest == "" || name == "" || repository == "") exit 41
    print name "\t" repository "\t" digest
  }
' "$manifest" > "$verify_dir/images.tsv" || { echo "release manifest images are not canonical" >&2; exit 1; }

expected_names=(api binaries m365-communications-executor m365-graph-actions-executor m365-graph-read-executor portal web)
[[ "$(wc -l < "$verify_dir/images.tsv" | tr -d ' ')" -eq "${#expected_names[@]}" ]] || { echo "signed release image set is incomplete" >&2; exit 1; }
for name in "${expected_names[@]}"; do
  [[ "$(awk -F '\t' -v expected="$name" '$1 == expected { count++ } END { print count+0 }' "$verify_dir/images.tsv")" -eq 1 ]] \
    || { echo "signed release image set is missing or duplicates $name" >&2; exit 1; }
done
while IFS=$'\t' read -r name repository digest; do
  [[ "$name" =~ ^[a-z0-9][a-z0-9-]*$ ]] || { echo "signed image name is invalid" >&2; exit 1; }
  [[ "$repository" =~ ^[a-z0-9][a-z0-9.-]*(:[0-9]{1,5})?/[a-z0-9][a-z0-9._/-]*$ ]] || { echo "signed image repository is invalid" >&2; exit 1; }
  [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "signed image digest is invalid" >&2; exit 1; }
done < "$verify_dir/images.tsv"
[[ "$(cut -f2 "$verify_dir/images.tsv" | sort -u | wc -l | tr -d ' ')" -eq "${#expected_names[@]}" ]] \
  || { echo "signed release image repositories are duplicated" >&2; exit 1; }

for requested in "${required[@]}"; do
  [[ "$requested" =~ ^([a-z0-9][a-z0-9-]*)=([a-z0-9][a-z0-9.-]*(:[0-9]{1,5})?/[a-z0-9][a-z0-9._/-]*)@(sha256:[0-9a-f]{64})$ ]] \
    || { echo "invalid required image tuple" >&2; exit 1; }
  name="${BASH_REMATCH[1]}"
  repository="${BASH_REMATCH[2]}"
  digest="${BASH_REMATCH[4]}"
  awk -F '\t' -v n="$name" -v r="$repository" -v d="$digest" '$1 == n && $2 == r && $3 == d { found=1 } END { exit found ? 0 : 1 }' "$verify_dir/images.tsv" \
    || { echo "configured $name image does not match the signed release manifest" >&2; exit 1; }
done

if [[ -n "$emit_env" ]]; then
  : > "$emit_env"
  for mapping in \
    api:BREEZE_API_IMAGE_REF \
    web:BREEZE_WEB_IMAGE_REF \
    portal:BREEZE_PORTAL_IMAGE_REF \
    binaries:BREEZE_BINARIES_IMAGE_REF; do
    name="${mapping%%:*}"
    variable="${mapping#*:}"
    line="$(awk -F '\t' -v n="$name" '$1 == n { print $2 "@" $3 }' "$verify_dir/images.tsv")"
    [[ -n "$line" ]] || { echo "cannot emit missing image $name" >&2; exit 1; }
    printf '%s=%s\n' "$variable" "$line" >> "$emit_env"
  done
fi

echo "Verified signed release image inventory for ${expected_repository} ${expected_release}"
