#!/usr/bin/env bash
#
# build-pack.sh — build the Breeze built-in YARA pack (#6263 W03b).
#
#   build-pack.sh [--out DIR] [--yarac PATH] [<forge-tag>]
#   build-pack.sh --check-lock [--base-lock FILE]  # pack.lock vs. inputs (and vs. main's lock); no download
#   build-pack.sh --print-inputs-hash   # the value pack.lock's inputs_sha256 must hold
#
# Downloads the YARA Forge "core" release pinned in forge.sha256 (tag AND
# sha256; a <forge-tag> argument must equal the pin), verifies it before use,
# builds breeze-yarac from agent/cmd/breeze-yarac (the agent's own compiler and
# compile policy) unless --yarac is given, and runs filter.go. Writes:
#
#   DIR/breeze-yara-builtin.json          the W02 §C2 bundle (release asset)
#   DIR/breeze-yara-builtin.json.sha256   "<sha256>  breeze-yara-builtin.json"
#   DIR/breeze-yara-builtin-report.json   every rule kept/dropped + licence texts (release asset)
#
# Version lock: the pack's `version` (pack.lock) is the integer the API's boot
# upsert compares — a newer version replaces the built-in rule set, an equal or
# older one is ignored. So the version MUST change whenever the pack's inputs
# do. inputs_sha256 hashes every input: this directory's files, the yarac
# compile policy (agent/internal/yarascan/yarac/yarac.go — breeze-yarac
# validate decides which rules survive) and the YARA-X engine pin (only the
# yaraxwasm/wazero lines of agent/go.mod and go.sum, so unrelated agent
# dependency bumps do not force a pack bump). A mismatch fails the build and
# --check-lock (run by CI) until `version` is bumped and the hash updated.
# With --base-lock (CI passes main's pack.lock) the version may never go
# backwards, and changed inputs need a strictly higher version.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$here/../../.." && pwd)"

FORGE_REPO_URL="https://github.com/YARAHQ/yara-forge/releases/download"
FORGE_ASSET="yara-forge-rules-core.zip"
FORGE_CORE_MEMBER="packages/core/yara-rules-core.yar"
MAX_ZIP_BYTES=$((64 * 1024 * 1024))
MAX_CORE_BYTES=$((256 * 1024 * 1024))
# Every file whose content changes the pack. pack.lock is not one of them.
INPUT_FILES=(build-pack.sh denylist.txt filter.go forge.sha256 go.mod LICENSES.allow)
# Inputs outside this directory, relative to the repo root.
EXTERNAL_INPUT_FILES=(agent/internal/yarascan/yarac/yarac.go)
ENGINE_PIN_RE='github\.com/(niallnsec/yaraxwasm|tetratelabs/wazero) '

die() { echo "build-pack: $*" >&2; exit 1; }

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

inputs_hash() {
  local tmp
  tmp="$(mktemp)"
  for f in "${INPUT_FILES[@]}"; do
    [ -f "$here/$f" ] || die "missing input $f"
    printf '%s\0' "$f" >>"$tmp"
    cat "$here/$f" >>"$tmp"
    printf '\0' >>"$tmp"
  done
  for f in "${EXTERNAL_INPUT_FILES[@]}"; do
    [ -f "$repo_root/$f" ] || die "missing input $f"
    printf '%s\0' "$f" >>"$tmp"
    cat "$repo_root/$f" >>"$tmp"
    printf '\0' >>"$tmp"
  done
  local pins
  pins="$(grep -hE "$ENGINE_PIN_RE" "$repo_root/agent/go.mod" "$repo_root/agent/go.sum" | sed -E 's/^[[:space:]]+//' | LC_ALL=C sort)"
  [ -n "$pins" ] || die "no yaraxwasm pin found in agent/go.mod / go.sum"
  printf 'engine-pins\0%s\0' "$pins" >>"$tmp"
  sha256_of "$tmp"
  rm -f "$tmp"
}

lock_value() {
  local key="$1" file="${2:-$here/pack.lock}" v
  v="$(sed -nE "s/^${key}=([^[:space:]]+)[[:space:]]*$/\1/p" "$file")"
  [ -n "$v" ] || die "$file has no ${key}= line"
  [ "$(printf '%s\n' "$v" | wc -l | tr -d ' ')" = 1 ] || die "$file has more than one ${key}= line"
  printf '%s' "$v"
}

check_lock() {
  local version want got
  version="$(lock_value version)"
  [[ "$version" =~ ^[1-9][0-9]{0,8}$ ]] || die "pack.lock version must be a positive integer (got '$version')"
  want="$(lock_value inputs_sha256)"
  got="$(inputs_hash)"
  if [ "$want" != "$got" ]; then
    cat >&2 <<EOF
build-pack: the built-in YARA pack inputs changed but pack.lock did not.
  pack.lock inputs_sha256: $want
  actual inputs hash:      $got
Bump 'version' in scripts/security/yara-pack/pack.lock (the API only replaces
the built-in rule set with a NEWER version) and set inputs_sha256=$got
EOF
    exit 1
  fi
  if [ -n "$base_lock" ]; then
    [ -f "$base_lock" ] || die "base lock $base_lock does not exist"
    local base_version base_inputs
    base_version="$(lock_value version "$base_lock")"
    base_inputs="$(lock_value inputs_sha256 "$base_lock")"
    [[ "$base_version" =~ ^[1-9][0-9]{0,8}$ ]] || die "base lock version must be a positive integer (got '$base_version')"
    if [ "$version" -lt "$base_version" ]; then
      die "pack.lock version $version is lower than the base's $base_version: the version must never go backwards (the API would ignore this pack everywhere)"
    fi
    if [ "$got" != "$base_inputs" ] && [ "$version" -le "$base_version" ]; then
      die "pack inputs changed since the base but pack.lock version is still $version: bump it above $base_version"
    fi
  fi
  printf '%s' "$version"
}

out_dir="$repo_root/dist/yara-pack"
yarac=""
tag_arg=""
base_lock=""
mode=build
while [ $# -gt 0 ]; do
  case "$1" in
    --check-lock) mode=check; shift ;;
    --base-lock) [ $# -ge 2 ] || die "--base-lock needs a file"; base_lock="$2"; shift 2 ;;
    --print-inputs-hash) inputs_hash; exit 0 ;;
    --out) [ $# -ge 2 ] || die "--out needs a directory"; out_dir="$2"; shift 2 ;;
    --yarac) [ $# -ge 2 ] || die "--yarac needs a path"; yarac="$2"; shift 2 ;;
    -*) die "unknown option $1" ;;
    *) [ -z "$tag_arg" ] || die "only one <forge-tag> argument"; tag_arg="$1"; shift ;;
  esac
done

if [ "$mode" = check ]; then
  v="$(check_lock)"
  echo "pack.lock ok: version $v${base_lock:+ (vs. base lock)}"
  exit 0
fi
pack_version="$(check_lock)"

pin_line="$(grep -vE '^[[:space:]]*(#|$)' "$here/forge.sha256")"
[ "$(printf '%s\n' "$pin_line" | wc -l | tr -d ' ')" = 1 ] || die "forge.sha256 must hold exactly one pin line"
pin_sha="$(printf '%s' "$pin_line" | awk '{print $1}')"
pin_path="$(printf '%s' "$pin_line" | awk '{print $2}')"
[[ "$pin_sha" =~ ^[0-9a-f]{64}$ ]] || die "forge.sha256: malformed sha256"
[[ "$pin_path" =~ ^([0-9]{8})/${FORGE_ASSET//./\\.}$ ]] || die "forge.sha256: path must be <YYYYMMDD tag>/$FORGE_ASSET"
pin_tag="${BASH_REMATCH[1]}"
if [ -n "$tag_arg" ] && [ "$tag_arg" != "$pin_tag" ]; then
  die "requested Forge tag $tag_arg is not the pinned tag $pin_tag (change forge.sha256 to move the pin)"
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
# Downloads and anything extracted from them live in their own directory;
# the tools we build and run live in another.
mkdir -p "$work/download" "$work/bin"

echo "build-pack: fetching YARA Forge $pin_tag/$FORGE_ASSET" >&2
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
  --retry 3 --retry-delay 5 --max-filesize "$MAX_ZIP_BYTES" \
  --output "$work/download/$FORGE_ASSET" "$FORGE_REPO_URL/$pin_tag/$FORGE_ASSET"
got_sha="$(sha256_of "$work/download/$FORGE_ASSET")"
[ "$got_sha" = "$pin_sha" ] || die "YARA Forge $pin_tag sha256 mismatch: pinned $pin_sha, downloaded $got_sha — refusing to build"

# -p streams one named member to stdout: no paths from the archive are created.
unzip -p "$work/download/$FORGE_ASSET" "$FORGE_CORE_MEMBER" >"$work/download/core.yar" \
  || die "$FORGE_CORE_MEMBER not found in $FORGE_ASSET"
core_bytes="$(wc -c <"$work/download/core.yar" | tr -d ' ')"
[ "$core_bytes" -gt 0 ] && [ "$core_bytes" -le "$MAX_CORE_BYTES" ] || die "$FORGE_CORE_MEMBER is $core_bytes bytes"

if [ -z "$yarac" ]; then
  echo "build-pack: building breeze-yarac from agent/cmd/breeze-yarac" >&2
  (cd "$repo_root/agent" && CGO_ENABLED=0 go build -trimpath -o "$work/bin/breeze-yarac" ./cmd/breeze-yarac)
  yarac="$work/bin/breeze-yarac"
fi
[ -x "$yarac" ] || die "breeze-yarac at $yarac is not executable"
(cd "$here" && CGO_ENABLED=0 go build -trimpath -o "$work/bin/yara-pack-filter" .)

mkdir -p "$out_dir"
bundle="$out_dir/breeze-yara-builtin.json"
report="$out_dir/breeze-yara-builtin-report.json"
"$work/bin/yara-pack-filter" \
  -forge "$work/download/core.yar" \
  -forge-tag "$pin_tag" \
  -forge-sha256 "$pin_sha" \
  -licenses "$here/LICENSES.allow" \
  -denylist "$here/denylist.txt" \
  -yarac "$yarac" \
  -version "$pack_version" \
  -out-bundle "$bundle" \
  -out-report "$report"

bundle_sha="$(sha256_of "$bundle")"
grep -q "\"bundleSha256\": \"$bundle_sha\"" "$report" || die "report bundleSha256 does not match the written bundle"
printf '%s  %s\n' "$bundle_sha" "breeze-yara-builtin.json" >"$bundle.sha256"
echo "build-pack: wrote $bundle (pack v$pack_version, sha256 $bundle_sha)" >&2
