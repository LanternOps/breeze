#!/usr/bin/env bash
# Static assertions on the QEMU command lines run-qemu.sh generates.
#
# Runs in a second with no QEMU, no ISO and no root, so it can gate the
# expensive Recovery media E2E (QEMU) job before it spends ~35 minutes
# building an ISO and emulating a full restore under TCG. It asserts
# properties of the *text* of the boot invocations, which is the only part
# of that job's behaviour that can be checked cheaply and deterministically
# on any machine (the maintainer's macOS laptop included).
#
# Usage: run-qemu_test.sh [path-to-run-qemu.sh]
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
target="${1:-$script_dir/run-qemu.sh}"
test -s "$target" || { echo "run-qemu_test: $target missing or empty" >&2; exit 1; }

fail() { echo "run-qemu_test: FAIL — $1" >&2; exit 1; }

# extract_invocation <first-line-regex> — prints the full backslash-
# continued command that starts at the first line matching the regex.
# Deliberately scoped to ONE invocation: a flag that belongs on boot 1 must
# not be satisfiable by the same flag appearing on boot 0 or boot 2.
extract_invocation() {
  local start_re="$1"
  awk -v re="$start_re" '
    !started && $0 ~ re { started = 1 }
    started { print }
    started && $0 !~ /\\[[:space:]]*$/ { exit }
  ' "$target"
}

boot1="$(extract_invocation '^timeout [0-9]+ .*qemu_bin')"
[ -n "$boot1" ] || fail "could not find the boot-1 qemu invocation (expected a 'timeout <n> \"\$qemu_bin\"' line) in $target"

# Boot 1 is the unattended restore boot, and the only one that can be asked
# to reset rather than power off. It supplies the kernel directly with
# -kernel/-initrd/-append, and QEMU re-applies those on every machine
# reset — so without -no-reboot a guest reset re-enters the live recovery
# environment with breeze.ci=1 still set and runs a SECOND unattended
# recovery, appending an extra "media_booted" to progress.json. That is
# precisely the signature of issue #5890 (whose actual cause was in-guest,
# in internal/recoveryconsole/console.go), so this second, independent
# route to the same symptom is closed off and kept closed here rather than
# left to depend on breeze.after=poweroff staying in the CI cmdline.
case "$boot1" in
  *" -no-reboot"*) ;;
  *) fail "boot 1 (the unattended restore boot) does not pass -no-reboot; a guest reset would re-apply -kernel/-initrd and run a second recovery attempt, appending a spurious 'media_booted' to progress.json (issue #5890)" ;;
esac

# The progress contract itself: run-qemu.sh must keep asserting the exact
# 5-phase sequence. Tolerating extra phases is the one fix this flake must
# never get.
grep -q "^expected='\[\"media_booted\",\"planned\",\"restoring\",\"validated\",\"rebooted\"\]'$" "$target" \
  || fail "the expected progress sequence in $target is not the exact 5-phase contract [\"media_booted\",\"planned\",\"restoring\",\"validated\",\"rebooted\"] — loosening it is not an acceptable fix for a flake"

# D-W09-2 / D-W09-3 (#6491 KIT lab): the fake server must be started with
# the one-shot transport fault pointed at the backslash-keyed systemd unit,
# and the run must assert BOTH that the fault fired and that the object was
# re-requested — otherwise the e2e cannot see a client that refuses a
# backslash key or one that treats a transport error as permanent (which is
# exactly why the QEMU proof passed while the KIT rig failed).
fakeserver_invocation="$(extract_invocation '^"[$]fakeserver_bin" ')"
[ -n "$fakeserver_invocation" ] || fail "could not find the fakeserver invocation in $target"
case "$fakeserver_invocation" in
  *'--fault-transport-once "$fault_key_substring"'*) ;;
  *) fail "the fake server is not started with --fault-transport-once \"\$fault_key_substring\" — the D-W09-3 transport-retry proof would never fire" ;;
esac
grep -q "^fault_key_substring='system-systemd\\\\x2dcryptsetup.slice'$" "$target" \
  || fail "fault_key_substring must be the literal backslash systemd unit name (D-W09-2 seed trait)"
grep -q 'transport fault injected (connection dropped mid-body)' "$target" \
  || fail "run-qemu.sh does not assert that the fake server injected the transport fault"
grep -q 'fault_requests:-0}" -lt 2' "$target" \
  || fail "run-qemu.sh does not assert the faulted object was requested at least twice (transport retry, D-W09-3)"
grep -q '"\$failed_files" != "0"' "$target" \
  || fail "run-qemu.sh does not assert the failed-file count is 0 from the validated result — a retried-then-lost file would still pass"

# --- Behavioural: the validated-result reader (#6491 QEMU red) ------------
#
# The D-W09 review round asserted `result.failedFiles == 0`, but the rebuild
# engine's wire field is `filesFailed` (rebuild.Result, rebuild/types.go) —
# the two names belong to different payloads (bmr.RecoveryResult is the one
# that carries `failedFiles`). Reading the wrong key while defaulting a
# MISSING key to -1 turned a clean rebuild into `failedFiles=-1 (want 0)`.
# The reader is now its own script so it can be exercised against real
# payload shapes, and a count it cannot establish is a distinct, loud
# failure — never a sentinel that reads like a file count.
reader="$script_dir/read-failed-files.py"
test -x "$reader" || fail "read-failed-files.py missing or not executable — run-qemu.sh's result assertion is untestable"

reader_tmp="$(mktemp -d)"
trap 'rm -rf "$reader_tmp"' EXIT

expect_reader_ok() { # <name> <json> <want-count>
  local got
  printf '%s' "$2" > "$reader_tmp/r.json"
  if ! got="$(python3 "$reader" "$reader_tmp/r.json" 2>"$reader_tmp/err")"; then
    fail "reader rejected $1: $(cat "$reader_tmp/err")"
  fi
  [ "$got" = "$3" ] || fail "reader read $1 as '$got', want '$3'"
}
expect_reader_fails() { # <name> <json>
  printf '%s' "$2" > "$reader_tmp/r.json"
  if python3 "$reader" "$reader_tmp/r.json" >/dev/null 2>&1; then
    fail "reader accepted $1 — a count it cannot establish must be a hard failure, not a sentinel"
  fi
}

# The real shape the console posts (abridged from CI run 35675175188).
expect_reader_ok "a clean rebuild result" \
  '{"result":{"snapshotId":"e2e-3","status":"completed","filesRestored":16325,"filesFailed":0},"warnings":[]}' 0
expect_reader_ok "a partial rebuild result" \
  '{"result":{"status":"partial","filesRestored":10,"filesFailed":3}}' 3
# A result that never reports the count at all must not read as a number.
expect_reader_fails "a result with no filesFailed key" '{"result":{"status":"completed","filesRestored":10}}'
expect_reader_fails "a body with no result object" '{"warnings":[]}'
expect_reader_fails "a non-integer count" '{"result":{"filesFailed":"0"}}'
expect_reader_fails "a boolean count" '{"result":{"filesFailed":true}}'
expect_reader_fails "a negative count" '{"result":{"filesFailed":-1}}'
# The old, wrong key alone must never satisfy the assertion.
expect_reader_fails "only the bmr-shaped failedFiles key" '{"result":{"failedFiles":[]}}'

grep -q 'read-failed-files.py' "$target" \
  || fail "run-qemu.sh does not use read-failed-files.py to read the validated result"

echo "run-qemu_test: PASS — boot 1 passes -no-reboot; progress contract is the exact 5-phase sequence; D-W09-2/3 fault + retry assertions present; the validated-result reader reads filesFailed and refuses a count it cannot establish"
