#!/usr/bin/env bash
#
# scan-corpus.sh — clean-corpus false-positive scan of a built YARA pack
# (#6263 W03b). Used by yara-pack.yml (nightly / pack PRs) and by release.yml,
# which refuses to publish a pack that matches a clean system file: the pack
# auto-quarantines on customer machines (spec D7).
#
#   scan-corpus.sh <bundle.json> <corpus-dir> <workers> <min-files-scanned> <max-failed-ratio>
#
# Builds breeze-yarac from agent/cmd/breeze-yarac (the agent's own engine and
# compile policy), scans the corpus, and gates the result with check-scan.mjs:
# any match, a scan error, too few files scanned or too many unscannable files
# fails. Needs Go and Node on PATH.
set -euo pipefail

[ $# -eq 5 ] || { echo "usage: $0 <bundle.json> <corpus-dir> <workers> <min-files-scanned> <max-failed-ratio>" >&2; exit 2; }
bundle="$1" corpus="$2" workers="$3" min_files="$4" max_failed="$5"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$here/../../.." && pwd)"
[ -s "$bundle" ] || { echo "scan-corpus: bundle $bundle is missing or empty" >&2; exit 1; }
[ -d "$corpus" ] || { echo "scan-corpus: corpus $corpus is not a directory" >&2; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
exe="$(go env GOEXE)"
(cd "$repo_root/agent" && CGO_ENABLED=0 go build -trimpath -o "$work/breeze-yarac$exe" ./cmd/breeze-yarac)

status=0
"$work/breeze-yarac$exe" scan --bundle "$bundle" --workers "$workers" --max-file-mb 50 "$corpus" \
  >"$work/scan.jsonl" 2>"$work/scan.err" || status=$?
tail -c 2000 "$work/scan.err" >&2 || true
node "$here/check-scan.mjs" "$work/scan.jsonl" "$status" "$min_files" "$max_failed"
