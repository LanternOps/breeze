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
# The seed adds its own image's plan to that, because a job's plan can reach past
# the Tauri set: upgrading libbrotli1 for libbrotli-dev also upgrades the
# preinstalled `brotli`, pinned to the same version. An image OLDER than the seed's
# can still need one of those. That is `cached` exiting 3 and naming the package,
# and `ensure` then fetching just that delta, not a failure.
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
TAURI_PKGS=($(grep -Ev '^(#|[[:space:]]*$)' "${PACKAGE_LIST}" || true))
if [ "${#TAURI_PKGS[@]}" = 0 ]; then
  echo "::error::no packages in ${PACKAGE_LIST}" >&2
  exit 1
fi

temp_dir() {
  mktemp -d "${TMPDIR:-/tmp}/tauri-apt.XXXXXX"
}

as_root() {
  if [ "$(id -u)" = 0 ]; then "$@"; else sudo "$@"; fi
}

# Fixed sources, independent of the runner image: one mirror of the Ubuntu archive,
# so a third-party repository on the image can neither slow nor change the resolution.
# Index file names derive from this URI, so the seed and every job must agree on
# it, which is why it lives here. arm64 exists only for local container tests.
#
# The Azure mirror is what these jobs were already using: the 26.04 image resolves
# its mirror through /etc/apt/apt-mirrors.txt, so the `azure.archive -> archive` sed
# this replaced had stopped changing anything. Speed varies by runner: the same 210
# MB closure came at ~70 kB/s after a burst on one (run 41925110607) and 22 MB/s on
# the next (run 41929601931), which is why a job must not depend on downloading the
# closure. TAURI_APT_MIRROR is the switch for a day it misbehaves (#1605).
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

# `file size SHA256:hash` per package apt would fetch, nothing downloaded.
list_uris() {
  apt-get install -y --print-uris --no-install-recommends --no-remove "${APT_OPTS[@]}" \
    -o "Acquire::ForceHash=SHA256" "$@" "${TAURI_PKGS[@]}" | awk "/^'/{print \$2, \$3, \$4}"
}

cmd_plan() {
  local work=$1
  new_work_dir "${work}"
  : > "${work}/empty-status"
  apt_options "${work}" "${work}/lists" "${work}/archives"
  # Without --error-on=any a suite that fails to fetch is a warning, and the closure
  # would resolve against what is left and be saved under an immutable key.
  as_root timeout --kill-after=30s 3m apt-get update --error-on=any "${APT_OPTS[@]}" >&2
  { list_uris -o "Dir::State::status=${work}/empty-status"; list_uris; } \
    | LC_ALL=C sort -u > "${work}/plan.txt"
  if [ ! -s "${work}/plan.txt" ]; then
    echo "::error::apt resolved no packages for the Tauri closure" >&2
    exit 1
  fi
  echo "Resolved a closure of $(wc -l < "${work}/plan.txt" | tr -d ' ') packages." >&2
  { echo "layout=${CACHE_LAYOUT}"; cat "${work}/plan.txt"; } | sha256sum | cut -c1-16
}

# apt accepts a file already in its archives directory on size alone, so a reused
# .deb is only as good as this check: the hash comes from the signed indexes.
deb_matches() {
  local file=$1 hash=$2
  [ -f "${file}" ] && [ "${hash%%:*}" = SHA256 ] \
    && [ "$(sha256sum "${file}" | cut -d' ' -f1)" = "${hash#*:}" ]
}

# Keys are immutable, so only ever publish a whole, verified closure. A partial
# restore of the previous closure may be sitting in CACHE: replace it.
publish_closure() {
  local work=$1 cache=$2 name hash file
  rm -rf "${cache}"
  mkdir -p "${cache}/archives" "${cache}/lists"
  while read -r name _ hash; do
    if ! deb_matches "${work}/archives/${name}" "${hash}" || ! cp "${work}/archives/${name}" "${cache}/archives/"; then
      echo "::warning::${name} is missing or does not match its index hash"
      rm -rf "${cache}"
      return 1
    fi
  done < "${work}/plan.txt"
  for file in "${work}"/lists/*; do
    if [ -f "${file}" ] && [ "${file##*/}" != lock ]; then
      cp "${file}" "${cache}/lists/" || { rm -rf "${cache}"; return 1; }
    fi
  done
  as_root chown -R "$(id -u):$(id -g)" "${cache}"
}

# A slow runner pays for the whole closure through the mirror's throttle (~50m for
# 210 MB at the worst seen), so attempts resume: apt keeps what it finished. Later
# seeds start from the restored closure and fetch only what the archive changed.
cmd_fetch() {
  local work=$1 cache=$2 expected attempt attempts=3 name hash
  apt_options "${work}" "${work}/lists" "${work}/archives"
  expected=$(wc -l < "${work}/plan.txt" | tr -d ' ')
  if [ -d "${cache}/archives" ]; then
    while read -r name _ hash; do
      if deb_matches "${cache}/archives/${name}" "${hash}"; then cp "${cache}/archives/${name}" "${work}/archives/"; fi
    done < "${work}/plan.txt"
    echo "Reusing $(find "${work}/archives" -maxdepth 1 -name '*.deb' | wc -l | tr -d ' ') of ${expected} debs from the restored closure."
  fi
  for attempt in $(seq 1 "${attempts}"); do
    if as_root timeout --kill-after=30s 20m apt-get install -y --download-only --no-install-recommends --no-remove \
        "${APT_OPTS[@]}" -o "Dir::State::status=${work}/empty-status" "${TAURI_PKGS[@]}" \
      && as_root timeout --kill-after=30s 5m apt-get install -y --download-only --no-install-recommends --no-remove \
        "${APT_OPTS[@]}" "${TAURI_PKGS[@]}" \
      && publish_closure "${work}" "${cache}"; then
      echo "Seeded ${expected} .deb files."
      return 0
    fi
    echo "::warning::apt download failed (attempt ${attempt}/${attempts}); retrying"
    sleep $((attempt * ${TAURI_APT_SEED_BACKOFF:-20}))
  done
  echo "::error::Failed to download the Tauri apt closure after ${attempts} attempts."
  exit 1
}

# Offline, with no effect on the system: a resolver refusal or a missing .deb
# surfaces here, before dpkg has touched anything. It does not read the debs (see
# deb_matches): `fetch` is what proves those. The seed saves CACHE right after this
# as the runner user, so what root and _apt leave behind must not stay in it.
cmd_probe() {
  local cache=$1 sources rc=0
  sources=$(temp_dir)
  write_sources "${sources}"
  apt_options "${sources}" "${cache}/lists" "${cache}/archives"
  as_root timeout --kill-after=15s 60s apt-get install -y --download-only --no-download \
    --no-install-recommends --no-remove "${APT_OPTS[@]}" "${TAURI_PKGS[@]}" || rc=$?
  if [ "${rc}" != 0 ]; then
    PROBE_MISSING=$(list_uris 2>/dev/null | cut -d' ' -f1 | head -10 | tr '\n' ' ' || true)
  fi
  rm -rf -- "${sources}"
  as_root rm -rf -- "${cache}/archives/partial" "${cache}/archives/lock" "${cache}/lists/partial" "${cache}/lists/lock"
  as_root chown -R "$(id -u):$(id -g)" "${cache}"
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
  cmd_probe "${cache}" || rc=$?
  if [ "${rc}" != 0 ]; then
    echo "::warning::the cached Tauri apt closure does not fit this runner image (exit ${rc}, nothing changed; needs: ${PROBE_MISSING:-unresolvable}); trying the network"
    return 3
  fi
  sources=$(temp_dir)
  write_sources "${sources}"
  apt_options "${sources}" "${cache}/lists" "${cache}/archives"
  as_root env DEBIAN_FRONTEND=noninteractive timeout --kill-after=15s 4m apt-get install -y --no-download \
    --no-install-recommends --no-remove "${APT_OPTS[@]}" "${TAURI_PKGS[@]}" || rc=$?
  rm -rf -- "${sources}"
  if [ "${rc}" = 124 ] || [ "${rc}" = 137 ]; then
    echo "::error::apt-get install from the cached closure hit its phase deadline; re-run to land on a fresh runner (#9847)."
    return 1
  fi
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
  local phase=$1 rc=$2 why
  why="exited ${rc}"
  if [ "${rc}" = 124 ] || [ "${rc}" = 137 ]; then why="hit its phase deadline"; fi
  echo "::error::Failed to install Tauri system dependencies: apt-get ${phase} ${why}; re-run to land on a fresh runner (#9847)."
  return 1
}

cmd_network() {
  local cache=$1 rc=0
  NETWORK_WORK=$(temp_dir)
  trap cleanup_network EXIT
  new_work_dir "${NETWORK_WORK}"
  if [ -d "${cache}/lists" ]; then
    find "${cache}/lists" -maxdepth 1 -type f -exec cp {} "${NETWORK_WORK}/lists/" \;
  fi
  if [ -d "${cache}/archives" ]; then
    find "${cache}/archives" -maxdepth 1 -name '*.deb' -exec cp {} "${NETWORK_WORK}/archives/" \;
  fi
  apt_options "${NETWORK_WORK}" "${NETWORK_WORK}/lists" "${NETWORK_WORK}/archives"
  as_root timeout --kill-after=30s 2m apt-get update --error-on=any "${APT_OPTS[@]}" || rc=$?
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
