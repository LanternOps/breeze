#!/usr/bin/env bash
# Tauri system dependencies for rust-check (#9847). Shared by ci.yml (restore,
# install) and ci-cache-seed.yml (build the closure), so the two cannot disagree.
#
# Why a closure built on one runner must not depend on that runner's packages:
# `apt-get install --download-only` fetches only what is missing from the machine
# it runs on. A package the seed image already carries never enters the cache, so
# a job on an image with an OLDER copy cannot satisfy an exact pin such as
#   libbrotli-dev depends on libbrotli1 (= 1.2.0-3ubuntu0.1)
# and GitHub serves several image patch levels of one distro at the same time.
#
# So the seed resolves against an EMPTY dpkg status: apt treats nothing as
# installed and the closure is every package the Tauri set needs, down to libc.
# The apt indexes those debs came from are cached with them, so a job can ask apt
# (not dpkg) for a plan offline: apt installs only what that image lacks.
#
#   plan WORK               apt-get update, resolve; prints the closure id
#   fetch WORK CACHE        download the planned closure and publish it to CACHE
#   probe CACHE             does CACHE fit this runner? Offline, changes nothing
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
PACKAGE_LIST="${SCRIPT_DIR}/../tauri-apt-packages.txt"
# Part of the closure id: bump when the on-disk layout of CACHE changes.
CACHE_LAYOUT=1
TAURI_PKGS=($(grep -Ev '^(#|[[:space:]]*$)' "${PACKAGE_LIST}"))

as_root() {
  if [ "$(id -u)" = 0 ]; then "$@"; else sudo "$@"; fi
}

# Fixed sources, independent of the runner image: the Ubuntu archive only, so a
# third-party repository on the image can neither slow nor change the resolution.
# Index file names derive from this URI, so the seed and every job must agree on
# it, which is why it lives here. arm64 exists only for local container tests.
write_sources() {
  local dir=$1 codename mirror
  codename=${TAURI_APT_CODENAME:-$(. /etc/os-release && echo "${VERSION_CODENAME}")}
  case "$(dpkg --print-architecture)" in
    amd64) mirror=http://azure.archive.ubuntu.com/ubuntu ;;
    *) mirror=http://ports.ubuntu.com/ubuntu-ports ;;
  esac
  mirror=${TAURI_APT_MIRROR:-$mirror}
  local key='[signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg]'
  {
    echo "deb ${key} ${mirror} ${codename} main universe"
    echo "deb ${key} ${mirror} ${codename}-updates main universe"
    echo "deb ${key} ${mirror} ${codename}-security main universe"
  } > "${dir}/sources.list"
}

# Sets APT_OPTS: sources file under $1, index lists at $2, .deb archives at $3.
apt_options() {
  local sources=$1 lists=$2 archives=$3
  APT_OPTS=(
    -o "Dir::Etc::sourcelist=${sources}/sources.list"
    -o "Dir::Etc::sourceparts=-"
    -o "Dir::State::lists=${lists}"
    -o "Dir::Cache::archives=${archives}"
    # Our indexes, never a binary cache built from the image's sources.
    -o "Dir::Cache::pkgcache="
    -o "Dir::Cache::srcpkgcache="
    -o "Acquire::Languages=none"
    -o "Acquire::http::Timeout=30"
    -o "Acquire::https::Timeout=30"
    -o "Acquire::Retries=3"
    -o "DPkg::Lock::Timeout=60"
  )
}

new_work_dir() {
  local dir=$1
  mkdir -p "${dir}/lists/partial" "${dir}/archives/partial"
  # apt's sandbox user must be able to traverse it to write partial downloads.
  chmod 755 "${dir}" "${dir}/lists" "${dir}/archives"
  write_sources "${dir}"
}

cmd_plan() {
  local work=$1
  new_work_dir "${work}"
  : > "${work}/empty-status"
  apt_options "${work}" "${work}/lists" "${work}/archives"
  as_root timeout --kill-after=30s 3m apt-get update "${APT_OPTS[@]}" >&2
  apt-get -s install --no-install-recommends --no-remove "${APT_OPTS[@]}" \
    -o "Dir::State::status=${work}/empty-status" "${TAURI_PKGS[@]}" \
    | awk '/^Inst /{print $2, $3}' | LC_ALL=C sort > "${work}/plan.txt"
  if [ ! -s "${work}/plan.txt" ]; then
    echo "::error::apt resolved no packages for the Tauri closure" >&2
    exit 1
  fi
  echo "Resolved a closure of $(wc -l < "${work}/plan.txt" | tr -d ' ') packages." >&2
  { echo "layout=${CACHE_LAYOUT}"; cat "${work}/plan.txt"; } | sha256sum | cut -c1-16
}

cmd_fetch() {
  local work=$1 cache=$2 expected count attempt attempts=3
  apt_options "${work}" "${work}/lists" "${work}/archives"
  expected=$(wc -l < "${work}/plan.txt" | tr -d ' ')
  for attempt in $(seq 1 "${attempts}"); do
    if as_root timeout --kill-after=30s 15m apt-get install -y --download-only --no-install-recommends --no-remove \
      "${APT_OPTS[@]}" -o "Dir::State::status=${work}/empty-status" "${TAURI_PKGS[@]}"; then
      count=$(find "${work}/archives" -maxdepth 1 -name '*.deb' | wc -l | tr -d ' ')
      if [ "${count}" = "${expected}" ]; then
        # Cache keys are immutable, so only ever publish a whole closure. A partial
        # restore of the previous closure may be sitting in CACHE: replace it.
        rm -rf "${cache}"
        mkdir -p "${cache}/archives" "${cache}/lists"
        find "${work}/archives" -maxdepth 1 -name '*.deb' -exec cp {} "${cache}/archives/" \;
        find "${work}/lists" -maxdepth 1 -type f ! -name lock -exec cp {} "${cache}/lists/" \;
        as_root chown -R "$(id -u):$(id -g)" "${cache}"
        echo "Seeded ${count} .deb files."
        return 0
      fi
      echo "::warning::downloaded ${count} of ${expected} planned packages"
    fi
    echo "::warning::apt download failed (attempt ${attempt}/${attempts}); retrying"
    sleep $((attempt * ${TAURI_APT_SEED_BACKOFF:-20}))
  done
  echo "::error::Failed to download the Tauri apt closure after ${attempts} attempts."
  exit 1
}

# Offline, with no effect on the system: a resolver refusal or a missing .deb
# surfaces here, before dpkg has touched anything.
cmd_probe() {
  local cache=$1 sources rc=0
  sources=$(mktemp -d)
  write_sources "${sources}"
  apt_options "${sources}" "${cache}/lists" "${cache}/archives"
  as_root timeout --kill-after=15s 60s apt-get install -y --download-only --no-download \
    --no-install-recommends --no-remove "${APT_OPTS[@]}" "${TAURI_PKGS[@]}" || rc=$?
  rm -rf -- "${sources}"
  return "${rc}"
}

main() {
  local cmd=${1:-}
  shift || true
  case "${cmd}" in
    plan) cmd_plan "$@" ;;
    fetch) cmd_fetch "$@" ;;
    probe) cmd_probe "$@" ;;
    *)
      echo "Usage: tauri-apt.sh plan WORK | fetch WORK CACHE | probe CACHE" >&2
      exit 2
      ;;
  esac
}

main "$@"
