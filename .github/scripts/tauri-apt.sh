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
#   cached CACHE            install from CACHE; exit 3 when it cannot be used and
#                           nothing was touched, exit 1 when the install itself failed
#   ensure CACHE            what rust-check runs: cached, then the network if unusable
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
#
# The Azure mirror, deliberately: hosted runners are in Azure and it serves them
# at 16 MB/s, while the public archive has crawled at KB/s from them (#9847). It
# has had bad days too (#1605); TAURI_APT_MIRROR is the switch for one of those.
# The 26.04 image resolves its mirror through /etc/apt/apt-mirrors.txt, so the
# `azure.archive -> archive` sed this replaced had already stopped changing anything.
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

# Two phases, because they call for different recoveries. Probe failing means this
# image and closure do not fit (an image newer than the seed, or one needing a
# package the closure lacks): nothing has changed, so another route can still work.
# The install failing after the probe passed means dpkg ran and may have left the
# system half configured, which no other route can recover from: stop here, rather
# than spend the step's budget on a path that apt will refuse anyway.
cmd_cached() {
  local cache=$1 sources rc=0
  if ! compgen -G "${cache}/archives/*.deb" >/dev/null || [ ! -d "${cache}/lists" ]; then
    echo "No Tauri apt closure restored."
    return 3
  fi
  if ! cmd_probe "${cache}"; then
    echo "::warning::the cached Tauri apt closure does not fit this runner image; nothing was changed"
    return 3
  fi
  sources=$(mktemp -d)
  write_sources "${sources}"
  apt_options "${sources}" "${cache}/lists" "${cache}/archives"
  as_root env DEBIAN_FRONTEND=noninteractive timeout --kill-after=15s 4m apt-get install -y --no-download \
    --no-install-recommends --no-remove "${APT_OPTS[@]}" "${TAURI_PKGS[@]}" || rc=$?
  rm -rf -- "${sources}"
  if [ "${rc}" != 0 ]; then
    echo "::error::cache closure incomplete: apt-get install exited ${rc} after planning from the cache; reseed with: gh workflow run \"CI cache seed\" --ref main (#9847)"
    return 1
  fi
  echo "Tauri system dependencies installed from cache (no mirror access)."
}

# One attempt, bounded per phase so a stall fails with a real message instead of
# burning the job's budget (#3730). A second attempt could not finish inside the
# step: re-run to land on a fresh runner. Starts from whatever was restored, so
# `apt-get update` fetches deltas and the install fetches only what moved on since
# the seed. Copied out of runner.temp, which the _apt sandbox user may not traverse.
NETWORK_WORK=""
cleanup_network() {
  if [ -n "${NETWORK_WORK}" ]; then as_root rm -rf -- "${NETWORK_WORK}"; fi
}

network_failed() {
  local phase=$1 rc=$2 why="exited ${rc}"
  if [ "${rc}" = 124 ] || [ "${rc}" = 137 ]; then why="hit its phase deadline"; fi
  echo "::error::Failed to install Tauri system dependencies: apt-get ${phase} ${why}; re-run to land on a fresh runner (#9847)."
  return 1
}

cmd_network() {
  local cache=$1 rc=0
  NETWORK_WORK=$(mktemp -d)
  trap cleanup_network EXIT
  new_work_dir "${NETWORK_WORK}"
  if [ -d "${cache}/lists" ]; then
    find "${cache}/lists" -maxdepth 1 -type f -exec cp {} "${NETWORK_WORK}/lists/" \;
  fi
  if [ -d "${cache}/archives" ]; then
    find "${cache}/archives" -maxdepth 1 -name '*.deb' -exec cp {} "${NETWORK_WORK}/archives/" \;
  fi
  apt_options "${NETWORK_WORK}" "${NETWORK_WORK}/lists" "${NETWORK_WORK}/archives"
  as_root timeout --kill-after=30s 2m apt-get update "${APT_OPTS[@]}" || rc=$?
  if [ "${rc}" != 0 ]; then network_failed update "${rc}"; return 1; fi
  as_root env DEBIAN_FRONTEND=noninteractive timeout --kill-after=30s 5m apt-get install -y \
    --no-install-recommends --no-remove "${APT_OPTS[@]}" "${TAURI_PKGS[@]}" || rc=$?
  if [ "${rc}" != 0 ]; then network_failed install "${rc}"; return 1; fi
  echo "Tauri system dependencies installed from the network."
}

cmd_ensure() {
  local cache=$1 rc=0
  cmd_cached "${cache}" || rc=$?
  case "${rc}" in
    0) return 0 ;;
    3) cmd_network "${cache}" ;;
    *) return "${rc}" ;;
  esac
}

main() {
  local cmd=${1:-}
  shift || true
  case "${cmd}" in
    plan) cmd_plan "$@" ;;
    fetch) cmd_fetch "$@" ;;
    probe) cmd_probe "$@" ;;
    cached) cmd_cached "$@" ;;
    ensure) cmd_ensure "$@" ;;
    *)
      echo "Usage: tauri-apt.sh plan WORK | fetch WORK CACHE | probe CACHE | cached CACHE | ensure CACHE" >&2
      exit 2
      ;;
  esac
}

main "$@"
