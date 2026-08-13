#!/usr/bin/env bash
#
# Guard: every .ps1 containing non-ASCII bytes MUST start with a UTF-8 BOM.
#
# Windows PowerShell 5.1 (the in-box powershell.exe, still what MSI custom
# actions and most managed endpoints run) decodes a BOM-less .ps1 as
# ANSI/CP1252. An em dash (U+2014, UTF-8 E2 80 94) then decodes to â€" whose
# final byte 0x94 is a CP1252 RIGHT DOUBLE QUOTE — inside any double-quoted
# string that injected quote breaks quote pairing for the rest of the file
# and the script dies at ParseException having executed nothing.
#
# This has now bitten twice: (1) every remotely-executed RMM script on
# Windows (fixed agent-side by prepending a BOM in WriteScriptFile,
# agent/internal/executor/shell.go), and (2) the MSI's RegisterUserHelperTask
# custom action running scripts/install/install-windows.ps1 — the install
# rolled back with 1603 because a comment contained an em dash (2026-08-13).
# The agent-side fix cannot help scripts that ship INSIDE the MSI, hence this
# repo-level guard. See docs/nu/known-issues.md.
#
# Fix a violation with:  printf '\xef\xbb\xbf' | cat - file.ps1 > tmp && mv tmp file.ps1
# (or just save the file as "UTF-8 with BOM" in your editor).
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

fail=0
while IFS= read -r f; do
  # First three bytes EF BB BF = UTF-8 BOM.
  head3="$(head -c 3 "$f" | od -An -tx1 | tr -d ' \n')"
  if [ "$head3" = "efbbbf" ]; then
    continue
  fi
  # BOM-less: only a problem when the file actually contains non-ASCII bytes.
  if LC_ALL=C grep -q $'[\x80-\xff]' "$f"; then
    echo "ERROR: $f contains non-ASCII bytes but has no UTF-8 BOM — PowerShell 5.1 will mis-decode it (see scripts/check-ps1-encoding.sh)" >&2
    fail=1
  fi
done < <(git ls-files '*.ps1')

if [ "$fail" -ne 0 ]; then
  exit 1
fi
echo "check-ps1-encoding: OK"
