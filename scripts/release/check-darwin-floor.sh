#!/usr/bin/env bash
# Tripwire: the Go toolchain on PATH must not build darwin binaries whose
# Mach-O minos is higher than the floor declared in agent/platform-floors.json.
# Override the toolchain with GO=/path/to/go.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GO_BIN="${GO:-go}"
FLOORS="$ROOT/agent/platform-floors.json"
FLOOR_RE='^[0-9]{1,3}(\.[0-9]{1,3}){0,2}$'

floor="$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).macos ?? ""))' "$FLOORS")"
if ! [[ "$floor" =~ $FLOOR_RE ]]; then
  echo "check-darwin-floor: $FLOORS has a missing or malformed \"macos\" value: '$floor'" >&2
  exit 2
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cat >"$tmp/main.go" <<'GOSRC'
package main

func main() { println("hello") }
GOSRC
cat >"$tmp/go.mod" <<'GOMOD'
module floorprobe

go 1.21
GOMOD

# Numeric-tuple compare, missing parts = 0. Prints 1 when $1 > $2.
version_gt() {
  node -e '
    const p = (s) => { const a = s.split(".").map(Number); while (a.length < 3) a.push(0); return a; };
    const [a, b] = [p(process.argv[1]), p(process.argv[2])];
    for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) { process.stdout.write(a[i] > b[i] ? "1" : "0"); process.exit(0); } }
    process.stdout.write("0");
  ' "$1" "$2"
}

echo "check-darwin-floor: toolchain $("$GO_BIN" version), declared macOS floor $floor"
fail=0
for arch in arm64 amd64; do
  (cd "$tmp" && CGO_ENABLED=0 GOOS=darwin GOARCH="$arch" GOFLAGS=-mod=mod "$GO_BIN" build -o "hello-$arch" .)
  measured="$(node "$ROOT/scripts/release/macho-min-os.mjs" "$tmp/hello-$arch" | node -e 'const o = JSON.parse(require("fs").readFileSync(0, "utf8")); process.stdout.write(String(Object.values(o)[0] ?? ""))')"
  if ! [[ "$measured" =~ $FLOOR_RE ]]; then
    echo "check-darwin-floor: could not read minos from darwin/$arch build (got '$measured')" >&2
    exit 2
  fi
  echo "check-darwin-floor: darwin/$arch minos $measured"
  if [ "$(version_gt "$measured" "$floor")" = "1" ]; then
    echo "check-darwin-floor: FAIL darwin/$arch toolchain minos $measured > declared floor $floor; bump agent/platform-floors.json in the PR that raises the toolchain; this drops support for older macOS" >&2
    fail=1
  fi
done
exit "$fail"
