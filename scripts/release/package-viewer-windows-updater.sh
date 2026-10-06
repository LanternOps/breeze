#!/usr/bin/env bash
# package-viewer-windows-updater.sh — wrap the signed viewer MSI in the zip
# that latest.json points Windows viewers at, and fail closed if any entry is
# compressed.
#
# The entry MUST be stored (zip -0). tauri-plugin-updater builds its Windows
# extractor on the `zip` crate with default-features = false, which leaves out
# the Deflate decoder. A deflated bundle downloads and passes its signature
# check, then fails to unpack with "unsupported Zip archive: Compression method
# not supported". The installed viewer stays on its old version and retries
# every launch (#7681; the v0.110.0, v0.119.0 and v0.120.0 bundles were
# checked and all deflated).
#
# Usage: package-viewer-windows-updater.sh <signed.msi> <out.zip>

set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: package-viewer-windows-updater.sh <signed.msi> <out.zip>" >&2
  exit 2
fi

msi="$1"
out="$2"

if [ ! -s "$msi" ]; then
  echo "::error::Signed MSI missing or empty at $msi" >&2
  exit 1
fi

rm -f "$out"
# -0 store only (see header), -j no directory prefix (the updater looks for the
# .msi at the archive root), -X no extra file attributes.
zip -0 -j -X "$out" "$msi"

# Verify the archive we are about to sign, not the flags we passed: a
# compressing zip here produces a release that every Windows viewer downloads
# and then cannot install.
entries="$(zipinfo -1 "$out")"
if [ "$entries" != "$(basename "$msi")" ]; then
  echo "::error::$out must contain exactly $(basename "$msi"), found: $entries" >&2
  exit 1
fi
methods="$(zipinfo -v "$out" | sed -n 's/^ *compression method: *//p')"
if [ "$methods" != "none (stored)" ]; then
  echo "::error::$out entry is not stored (compression method: $methods)." \
    "tauri-plugin-updater on Windows cannot decompress it (#7681)." >&2
  exit 1
fi

echo "Packed $(basename "$msi") into $out (stored, $(wc -c <"$out" | tr -d ' ') bytes)"
