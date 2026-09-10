#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: $0 <pkg-path> <asset-name> <expected-installer-identity> <expected-team-id>" >&2
  exit 2
}

[ "$#" -eq 4 ] || usage

pkg_path="$1"
asset_name="$2"
expected_identity="$3"
expected_team_id="$4"
pkgutil_bin="${PKGUTIL_BIN:-pkgutil}"

[ -f "$pkg_path" ] || {
  echo "package not found: $pkg_path" >&2
  exit 1
}

case "$asset_name$expected_identity$expected_team_id" in
  *$'\t'*|*$'\n'*|*$'\r'*)
    echo "attestation fields must not contain tabs or newlines" >&2
    exit 1
    ;;
esac

if [[ ! "$expected_team_id" =~ ^[A-Z0-9]{10}$ ]]; then
  echo "expected Apple team ID must be 10 uppercase alphanumeric characters" >&2
  exit 1
fi
identity_prefix="Developer ID Installer: "
identity_suffix=" ($expected_team_id)"
if [[ "$expected_identity" != "$identity_prefix"*"$identity_suffix" ]] \
  || [ "$expected_identity" = "$identity_prefix$identity_suffix" ]; then
  echo "expected installer identity is not bound to expected team ID $expected_team_id" >&2
  exit 1
fi

if ! signature_output="$("$pkgutil_bin" --check-signature "$pkg_path" 2>&1)"; then
  echo "$signature_output" >&2
  echo "pkgutil rejected package signature: $pkg_path" >&2
  exit 1
fi

leaf_identity="$(printf '%s\n' "$signature_output" | sed -nE 's/^[[:space:]]*1\.[[:space:]]+(.+)$/\1/p' | head -n 1)"
if [ -z "$leaf_identity" ]; then
  echo "$signature_output" >&2
  echo "pkgutil output did not contain a leaf signing identity: $pkg_path" >&2
  exit 1
fi
if [ "$leaf_identity" != "$expected_identity" ]; then
  echo "unexpected package signing identity: $leaf_identity" >&2
  echo "expected package signing identity: $expected_identity" >&2
  exit 1
fi

leaf_team_id="$(printf '%s\n' "$leaf_identity" | sed -nE 's/^.*\(([A-Z0-9]{10})\)$/\1/p')"
if [ "$leaf_team_id" != "$expected_team_id" ]; then
  echo "unexpected package signing team ID: ${leaf_team_id:-<missing>}" >&2
  echo "expected package signing team ID: $expected_team_id" >&2
  exit 1
fi

printf '%s\t%s\t%s\t%s\n' \
  "$asset_name" \
  "macos-developer-id-notarization-required" \
  "$leaf_identity" \
  "$leaf_team_id"
