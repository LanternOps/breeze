#!/usr/bin/env bash
# notarize-submit.sh — submit an artifact to Apple notarytool and fail closed
# on rejection.
#
# `xcrun notarytool submit … --wait` exits 0 for Accepted, Invalid, AND
# Rejected. Trusting the exit code alone ships rejected artifacts. This helper
# fails on a non-zero exit (after printing notarytool's output), then parses
# the status: line and prints `notarytool log <id>` on anything but Accepted.
# Tests: scripts/release/notarize-submit.test.mjs
#
# Required env: APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID
# Usage: notarize-submit.sh <path-to-artifact>

set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: notarize-submit.sh <path>" >&2
  exit 2
fi

artifact="$1"
if [ ! -s "$artifact" ]; then
  echo "::error::notarize-submit: artifact missing or empty: $artifact" >&2
  exit 1
fi

: "${APPLE_ID:?APPLE_ID is required}"
: "${APPLE_PASSWORD:?APPLE_PASSWORD is required}"
: "${APPLE_TEAM_ID:?APPLE_TEAM_ID is required}"

echo "Submitting $(basename "$artifact") for notarization..."
# Capture both streams so auth/network errors show up regardless of the
# caller's stderr handling. `set -e` is suspended around the capture: a bare
# `var=$(failing-cmd)` aborts the script on the assignment, before the output
# is printed, which hid Apple's error (HTTP 403, agreement expired) behind a
# bare "exit code 1" (#7710). Print the output first, then fail.
set +e
submit_output=$(xcrun notarytool submit "$artifact" \
  --apple-id "$APPLE_ID" \
  --password "$APPLE_PASSWORD" \
  --team-id "$APPLE_TEAM_ID" \
  --wait --timeout 30m 2>&1)
submit_status=$?
set -e
echo "$submit_output"
if [ "$submit_status" -ne 0 ]; then
  echo "::error::notarytool exited ${submit_status} for $(basename "$artifact") (output above)" >&2
  exit 1
fi

# Parsing plain-text submit output; do NOT pass --output-format json without
# updating both extractors below. Empty status falls through to the failure
# branch and exits non-zero — the failure is fail-closed by construction.
submission_id=$(echo "$submit_output" | awk '/^[[:space:]]*id:/ {print $2; exit}')
status=$(echo "$submit_output" | awk '/^[[:space:]]*status:/ {print $2; exit}')

if [ "$status" != "Accepted" ]; then
  echo "::error::Notarization failed for $(basename "$artifact"): status='$status' submission='$submission_id'" >&2
  if [ -n "$submission_id" ]; then
    echo "--- xcrun notarytool log $submission_id ---" >&2
    xcrun notarytool log "$submission_id" \
      --apple-id "$APPLE_ID" \
      --password "$APPLE_PASSWORD" \
      --team-id "$APPLE_TEAM_ID" >&2 || true
  fi
  exit 1
fi

echo "Notarization Accepted: $(basename "$artifact") (submission $submission_id)"
