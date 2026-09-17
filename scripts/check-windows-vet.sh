#!/usr/bin/env bash
# Vet the Go agent's Windows-tagged files (#3046).
#
# WHY THIS EXISTS
# ---------------
# CI's `go vet ./...` runs on ubuntu-latest, so every file behind
# `//go:build windows` is excluded from the build and is never vetted at all.
# The Windows `go test` job does not close the gap either: `go test` runs only a
# subset of vet (atomic, bool, buildtags, errorsas, ifaceassert, nilfunc,
# printf, stringintconv). `unsafeptr` is not in that subset, so a Windows-only
# vet finding is invisible from both directions.
#
# Cross-compiling fixes that without a Windows runner: vet only needs to
# typecheck and analyse the Windows build, not execute it.
#
# THE TWO PASSES
# --------------
# 1. Everything except `unsafeptr` is an UNCONDITIONAL gate. The Windows build
#    is clean under those analysers today, so any finding is new and must be
#    fixed. No baseline, no escape hatch.
#
# 2. `unsafeptr` is baselined per file. The agent's Windows code is full of COM
#    vtable dispatch (VSS, DXGI, MFT, AMF) where a `uintptr` legitimately holds
#    a COM-allocated address that the Go GC neither moves nor frees. vet cannot
#    distinguish that from a stale Go-heap address, so it reports every such
#    conversion. Those sites need per-call-site adjudication, not a blind
#    PR-blocking gate.
#
# WHY PER-FILE COUNTS AND NOT `file:line:col`
# -------------------------------------------
# A `file:line:col` baseline goes stale on any edit above a finding. Measured:
# a baseline captured on 2026-09-03 had already drifted on three files
# (dxgi_capture_windows.go, mft_encode_windows.go, mft_windows.go) by
# 2026-09-16 with no change to any of the flagged call sites. That produces
# confusing red CI on unrelated PRs, which is how baselines get deleted instead
# of burned down. Per-file counts survive line drift and still catch the thing
# that matters: a NEW unsafe.Pointer conversion appearing in a Windows file.
#
# Trade-off, stated plainly: removing one finding from a file and adding a
# different one in the same file nets to zero and is not caught. Accepted — the
# alternative fails open by being deleted.
#
# USAGE
#   scripts/check-windows-vet.sh            # check (CI + local)
#   scripts/check-windows-vet.sh --update   # regenerate the baseline
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT_DIR="${REPO_ROOT}/agent"
BASELINE="${AGENT_DIR}/vet-windows-unsafeptr-baseline.txt"

export GOOS=windows
export GOARCH=amd64
export CGO_ENABLED=0

cd "${AGENT_DIR}"

# ── Pass 1: every analyser except unsafeptr — unconditional ────────────────
echo "==> go vet (GOOS=windows, unsafeptr excluded) — unconditional gate"
if ! vet_other="$(go vet -unsafeptr=false ./... 2>&1)"; then
  echo "${vet_other}"
  echo
  echo "::error::GOOS=windows 'go vet' found issues in Windows-tagged Go files (analysers other than unsafeptr). These are NOT baselined: fix them. If the failure is a build error, the Windows build is broken."
  exit 1
fi
echo "    clean"

# ── Pass 2: unsafeptr, baselined per file ─────────────────────────────────
echo "==> go vet (GOOS=windows, unsafeptr) — baselined per file"
# vet exits non-zero when it reports findings; pass 1 already proved the build
# itself is sound, so a non-zero exit here only means unsafeptr findings exist.
vet_unsafeptr="$(go vet ./... 2>&1 || true)"

actual="$(
  printf '%s\n' "${vet_unsafeptr}" \
    | grep -F 'possible misuse of unsafe.Pointer' \
    | sed -E 's/^(.*):[0-9]+:[0-9]+: .*$/\1/' \
    | sort \
    | uniq -c \
    | awk '{ printf "%s %s\n", $2, $1 }' \
    | sort
)"

if [[ "${1:-}" == "--update" ]]; then
  {
    echo "# GOOS=windows 'go vet' unsafeptr findings, per file (#3046)."
    echo "# Format: <file> <count>. Regenerate with scripts/check-windows-vet.sh --update"
    echo "#"
    echo "# These are pre-existing, pending per-call-site adjudication. They are"
    echo "# overwhelmingly COM vtable dispatch, where a uintptr holds a"
    echo "# COM-allocated address the Go GC does not own — the known unsafeptr"
    echo "# false-positive class. Do NOT add a line here to silence a NEW finding"
    echo "# in your own code without adjudicating the call site first."
    echo "#"
    echo "# Adjudicated so far: internal/backup/vss/vss_windows.go (all 3 sites,"
    echo "# see the comments there)."
    printf '%s\n' "${actual}"
  } > "${BASELINE}"
  echo "    baseline written to ${BASELINE}"
  exit 0
fi

if [[ ! -f "${BASELINE}" ]]; then
  echo "::error::Missing baseline ${BASELINE}. Regenerate with scripts/check-windows-vet.sh --update"
  exit 1
fi

expected="$(grep -v '^#' "${BASELINE}" | grep -v '^[[:space:]]*$' | sort)"

if [[ "${expected}" != "${actual}" ]]; then
  echo
  diff -u <(printf '%s\n' "${expected}") <(printf '%s\n' "${actual}") \
    --label baseline --label actual || true
  echo
  echo "::error::GOOS=windows unsafeptr findings changed (diff above; format is '<file> <count>'). A file whose count ROSE (or a new file): you added an unsafe.Pointer conversion in Windows-tagged code — fix it, or adjudicate the call site, comment why it is sound, and run scripts/check-windows-vet.sh --update. A count that FELL: you fixed one, thank you — run --update to lock the improvement in."
  exit 1
fi

echo "    matches baseline ($(printf '%s\n' "${expected}" | wc -l | tr -d ' ') files)"
