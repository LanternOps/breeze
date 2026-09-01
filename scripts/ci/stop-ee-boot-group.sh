#!/usr/bin/env bash
#
# Stop the API process group launched by the "Boot API once to apply built-in
# extension migrations (ee)" step in .github/workflows/ci.yml, and prove it is
# gone before the workspace integration suite runs against the same DB shard.
#
# Extracted from that step's inline `run:` block so its kill/poll branches are
# reachable by a real test (apps/api/src/config/eeBootStopGroup.test.ts). While
# the logic lived inline in YAML the only thing a test could assert was the
# workflow's *text*, which is why the ESRCH-vs-EPERM conflation this script
# fixes (#3471) survived two prior hardening passes on the same step.
#
# Usage: stop-ee-boot-group.sh <pgid> <boot-log-path> <fatal-sentinel-regex>
#
#   exit 0 — the group is gone: signalled and reaped, or it had already exited
#            on its own (benign) after its migrations landed.
#   exit 1 — a genuine failure. The message says which one.
#
# The file is also sourceable (`source stop-ee-boot-group.sh`) so tests can call
# `stop_ee_boot_group` directly with stubbed `kill`/`ps`/`sleep`; sourcing runs
# nothing and does not mutate the caller's shell options.

# Count NON-ZOMBIE members of process group $1.
#
# `kill -0` "succeeds" against a zombie, but a zombie is dead — unreaped only
# because its parent died with it — and cannot touch the DB. The CI step's shell
# cannot reap grandchildren; init does so asynchronously after SIGKILL, so a
# zombie-only group must be treated as gone, not as a survivor (observed live:
# `[node]`/`[esbuild] <defunct>` tripping a naive `kill -0 -- -PGID` assert).
live_in_group() {
  ps -eo pgid=,stat= | awk -v p="$1" '$1 == p && $2 !~ /^Z/' | wc -l
}

stop_ee_boot_group() {
  local pgid="$1" log="$2" fatal="$3"

  # Guarded, like the boot step's two earlier failure branches: under the step's
  # default `bash -e`, an unguarded `kill` on an already-exited group (e.g. the
  # process crashed on its own between logging the built-in load line and this
  # kill) would abort the step on a bare "process not found" with no log
  # content, making a correct migration load look like an unexplained CI
  # failure. Dump the log so it's diagnosable either way — and then decide: an
  # already-dead group that ALSO logged the fatal sentinel is a genuine boot
  # failure that merely happened to log the built-in line first, and must fail
  # the step rather than be waved through.
  local kill_err=''
  if ! kill_err="$(kill -- "-$pgid" 2>&1)"; then
    # `kill` failed. Two causes that must NOT share a branch (#3471):
    #
    #   ESRCH "No such process"        — the group is gone. Benign: the API
    #       exited on its own between logging the built-in load line and this
    #       kill, and its migrations already landed.
    #   EPERM "Operation not permitted" — the group is ALIVE and we may not
    #       signal it. Not benign: a live API keeps writing to this shard's DB
    #       and poisons the workspace integration suite that runs next, which
    #       is the exact flake this teardown exists to prevent.
    #
    # Folding EPERM into the ESRCH branch printed "had already exited" and a
    # `::warning::` claiming "migrations were applied, continuing" — both false
    # for a process that is still running — and then let the step fail 40s
    # later blaming a SIGTERM/SIGKILL that was never successfully delivered.
    # Wherever `ps` cannot enumerate the group (hidepid, a PID namespace, a
    # group owned by another user) that survivor assert sees nothing and the
    # step passes outright with a live API against the DB.
    #
    # Ground truth is the process table, not kill's stderr: strerror() text is
    # locale-dependent, so the errno string is quoted for the human reading the
    # log but never trusted as the sole discriminator. The text match is a
    # second, independent trigger so an EPERM still fails loudly on exactly
    # those hosts where `ps` is blind. The two conditions can only ever agree
    # toward failing — neither can wave a live group through.
    if [ "$(live_in_group "$pgid")" -gt 0 ] || printf '%s' "$kill_err" | grep -qi 'not permitted'; then
      echo "Could not signal API process group $pgid: ${kill_err:-kill failed without an error message}"
      echo "This is NOT the benign already-exited (ESRCH) case — the group is still there and refused the"
      echo "signal, so a live API would keep writing to this step's DB shard and poison the workspace"
      echo "integration suite that runs next. Failing the step."
      ps -eo pid,pgid,stat,cmd | awk -v pgid="$pgid" '$2 == pgid' || true
      cat "$log"
      return 1
    fi

    echo "API process group had already exited after logging the built-in load line — dumping its output:"
    cat "$log"
    if grep -q "$fatal" "$log"; then
      echo "The API logged the built-in load line and then FAILED startup — the schema this step is"
      echo "supposed to guarantee may be incomplete, so the workspace integration suite below would"
      echo "fail confusingly. Failing here instead."
      return 1
    fi
    echo "::warning::API exited on its own after loading built-in extensions (no startup failure logged); migrations were applied, continuing."
  fi

  # Bound the wait for graceful shutdown instead of an unbounded `wait`, which
  # could otherwise eat the whole job ceiling if the process ignores SIGTERM or
  # hangs mid-shutdown. Poll the GROUP, not the leader PID: the leader (pnpm's
  # wrapper) can exit seconds before the node/tsx descendants finish shutting
  # down, and watching only the leader cuts the grace period short (observed on
  # the first live run of this step).
  local _
  for _ in $(seq 1 30); do
    [ "$(live_in_group "$pgid")" -gt 0 ] || break
    sleep 1
  done
  kill -9 -- "-$pgid" 2>/dev/null || true

  # Fail CLOSED on a genuinely surviving process group — but give SIGKILL a
  # moment to land before judging (delivery is async).
  for _ in $(seq 1 10); do
    [ "$(live_in_group "$pgid")" -gt 0 ] || break
    sleep 1
  done
  if [ "$(live_in_group "$pgid")" -gt 0 ]; then
    echo "API process group $pgid survived SIGTERM and SIGKILL. A live API would keep writing to"
    echo "this step's DB shard and poison the workspace integration suite that runs next."
    ps -eo pid,pgid,stat,cmd | awk -v pgid="$pgid" '$2 == pgid' || true
    return 1
  fi
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  set -euo pipefail
  if [ "$#" -ne 3 ]; then
    echo "usage: ${0##*/} <pgid> <boot-log-path> <fatal-sentinel-regex>" >&2
    exit 2
  fi
  stop_ee_boot_group "$@"
fi
