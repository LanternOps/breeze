#!/usr/bin/env bash
# shellcheck disable=SC2034  # the sourced lib reads these globals
# Tests for the scheduled QA sweep's trusted side (scripts/qa/sweep-lib.sh and
# scripts/qa/egress-proxy.py). Treats the agent as hostile: everything it can
# write is fed back in and must be rejected unless it matches what the runner
# fixed before the agent started.
#
#   bash scripts/qa/tests/sweep-lib.test.sh
#
# The Seatbelt cases need macOS (sandbox-exec) and are skipped elsewhere.
# QA_TEST_NETWORK=1 adds one live CONNECT through the proxy to api.github.com.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd -P)"
QA_DIR="$(cd "$HERE/.." && pwd -P)"
T="$(mktemp -d "${TMPDIR:-/tmp}/qa-lib-test.XXXXXX")"; T="$(cd "$T" && pwd -P)"
trap 'rm -rf "$T"; [ -n "${PROXY_PID:-}" ] && kill "$PROXY_PID" 2>/dev/null' EXIT

PASS=0; FAIL=0; SKIP=0
ok()   { PASS=$((PASS+1)); echo "ok   - $1"; }
bad()  { FAIL=$((FAIL+1)); echo "FAIL - $1"; }
skip() { SKIP=$((SKIP+1)); echo "skip - $1"; }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }   # check <name> <shell-condition>

# --- fake gh: logs argv, answers the few reads the publisher makes ------------
REAL_GH="$(command -v gh 2>/dev/null || true)"   # for the opt-in live render check only
mkdir -p "$T/bin"
GH_LOG="$T/gh.log"; export GH_LOG
cat > "$T/bin/gh" <<'GH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$GH_LOG"
prev=""; for a in "$@"; do [ "$prev" = --body-file ] && cat "$a" >> "$GH_LOG.bodies"; prev="$a"; done
case "$*" in
  *"issue list"*"--limit 3000"*) printf '555\t[UI] Devices page 500s\n556\t[QA] ledger\nnot-a-number\tjunk\n' ;;
  *"issue view"*"--json labels,state"*) echo "qa-sweep" ;;   # every issue "looks" open + qa-sweep live
  *"issue list"*"--label qa-sweep"*"--json number"*) printf '555\n556\n' ;;
esac
exit 0
GH
chmod +x "$T/bin/gh"
export PATH="$T/bin:$PATH"

log() { echo "[log] $*" >> "$T/runner.log"; }
# shellcheck source=../sweep-lib.sh
. "$QA_DIR/sweep-lib.sh"

new_run() {   # fresh RUN_DIR + publisher state for one scenario
  RUN_DIR="$T/run-$1"; mkdir -p "$RUN_DIR/outbox"
  QA_HOME="$T/home-$1"; mkdir -p "$QA_HOME"
  QA_REPO="LanternOps/breeze"; NEW_SHA="0123456789abcdef"; RUN_ID="test-$1"
  ENVVALS="$T/envvals-$1"; : > "$ENVVALS"; MAX_NEW_ISSUES=10
  : > "$GH_LOG"; : > "$GH_LOG.bodies"; : > "$T/runner.log"
}
outbox() { printf '%s' "$2" > "$RUN_DIR/outbox/$1"; }

# === F1: PR scope is fixed before the agent runs ==============================
new_run scope
printf 'aaa\t2026-11-17\tfeat: real thing (#100)\n' > "$RUN_DIR/commits.tsv"
IN_SCOPE=" 100 "
# the agent appends a line to the on-disk scope file after IN_SCOPE was captured
printf 'bbb\t2026-11-17\tinjected (#999)\n' >> "$RUN_DIR/commits.tsv"
outbox 001-a.json '{"action":"pr_result","pr":100,"result":"PASS","body":"checked the page"}'
outbox 002-b.json '{"action":"pr_result","pr":999,"result":"PASS","body":"checked the page"}'
QA_COMMENTABLE=" "
publish_outbox >/dev/null 2>&1
check "F1: in-scope PR is annotated" "grep -q '^-R LanternOps/breeze pr comment 100 ' '$GH_LOG'"
check "F1: PR added to commits.tsv by the agent is NOT annotated" "! grep -q 'pr comment 999\|pr edit 999' '$GH_LOG'"

# === F4: comment targets are bare numbers from the pre-run snapshot ===========
new_run comment
IN_SCOPE=" "
snapshot_commentable_issues
check "F4: snapshot holds the open qa-sweep issues at run start" "[ \"\$QA_COMMENTABLE\" = ' 555 556 ' ]"
outbox 001-url.json '{"action":"comment","issue":"https://github.com/attacker/repo/issues/1","body":"hello there"}'
outbox 002-new.json '{"action":"comment","issue":777,"body":"hello there"}'
outbox 003-ok.json '{"action":"comment","issue":555,"body":"Verified fixed on main"}'
publish_outbox >/dev/null 2>&1
check "F4: fully qualified issue URL is rejected" "! grep -q 'attacker' '$GH_LOG'"
check "F4: issue not in the pre-run snapshot is rejected even if it is open+qa-sweep now" "! grep -q 'issue comment 777' '$GH_LOG'"
check "F4: snapshot issue gets the comment, pinned to the runner's repo" "grep -q '^-R LanternOps/breeze issue comment 555 ' '$GH_LOG'"

# The agent's dedupe list is computed by the runner, so it needs no search.
new_run open-issues
snapshot_open_issues
check "dedupe: the runner snapshots open issues for the agent" "[ \"\$(cat '$RUN_DIR/open-issues.tsv')\" = \"\$(printf '555\t[UI] Devices page 500s\n556\t[QA] ledger')\" ]"
check "dedupe: the snapshot is read-only" "[ ! -w '$RUN_DIR/open-issues.tsv' ] || [ \"\$(id -u)\" = 0 ]"
check "dedupe: the snapshot is fetched with the runner's gh, pinned, with no search text" "grep -q '^-R LanternOps/breeze issue list --state open --limit 3000' '$GH_LOG' && ! grep -q 'limit 3000.*--search' '$GH_LOG'"

new_run comment-empty
QA_COMMENTABLE=""   # snapshot failed -> fail closed
outbox 001.json '{"action":"comment","issue":555,"body":"Verified fixed on main"}'
publish_outbox >/dev/null 2>&1
check "F4: no snapshot = no comments (fail closed)" "! grep -q 'issue comment' '$GH_LOG'"

# === outbox file handling ======================================================
new_run files
QA_COMMENTABLE=" "; IN_SCOPE=" "
outbox 'a b.json' '{"action":"create","title":"[UI] spaced name file","body":"body text"}'
outbox 'x;y.json' '{"action":"create","title":"[UI] semicolon name","body":"body text"}'
ln -s "$T/envvals-files" "$RUN_DIR/outbox/link.json"
outbox 001-good.json '{"action":"create","title":"[UI] Devices page 500s","body":"body text"}'
publish_outbox >/dev/null 2>&1
check "outbox: unsafe file names are rejected" "! grep -q 'spaced name\|semicolon name' '$GH_LOG' && grep -q 'REJECT.*unsafe name' '$T/runner.log'"
check "outbox: symlinks are rejected" "grep -q 'REJECT link.json: not a regular file' '$T/runner.log'"
check "outbox: well-formed entry still publishes" "grep -q 'issue create --title \[UI\] Devices page 500s' '$GH_LOG'"
check "outbox: publisher works on a runner-owned copy, not RUN_DIR" "[ -z \"\$(ls \"\$RUN_DIR\"/outbox/*.body.md 2>/dev/null)\" ] && [ -n \"\${PUBLISH_DIR:-}\" ] && [ -f \"\$PUBLISH_DIR/001-good.json\" ]"

# === Strix r8: the runner never follows a link the agent planted in RUN_DIR ===
# RUN_DIR is agent-writable; anything in it may be a symlink, a FIFO or swapped
# after a check. The runner reads it without following links and never writes it.
new_run links
QA_COMMENTABLE=" "; IN_SCOPE=" "
mkdir -p "$T/elsewhere"
printf '{"action":"create","title":"[UI] marker-elsewhere via a dir link","body":"x"}' > "$T/elsewhere/001.json"
printf 'marker-ledger-link\n' > "$T/elsewhere/ledger.md"
rm -rf "$RUN_DIR/outbox"; ln -s "$T/elsewhere" "$RUN_DIR/outbox"; ln -s "$T/elsewhere/ledger.md" "$RUN_DIR/ledger.md"
publish_outbox >/dev/null 2>&1
check "links: an outbox that is a symlink to another directory publishes nothing" "! grep -q 'marker-elsewhere' '$GH_LOG' && grep -q 'REJECT outbox: not a directory' '$T/runner.log'"
check "links: a symlinked ledger is not published" "! grep -q 'marker-ledger-link' '$GH_LOG.bodies' && ! grep -q 'issue edit\|QA sweep ledger' '$GH_LOG'"
new_run fifo
QA_COMMENTABLE=" "; IN_SCOPE=" "
mkfifo "$RUN_DIR/outbox/001-fifo.json"; mkdir "$RUN_DIR/outbox/002-dir.json"
outbox 003-ok.json '{"action":"create","title":"[UI] marker-fifo-ok next to a fifo","body":"body text"}'
mkfifo "$RUN_DIR/ledger.md"
( publish_outbox >/dev/null 2>&1 ) & PUBPID=$!
for _ in $(seq 1 100); do kill -0 "$PUBPID" 2>/dev/null || break; sleep 0.1; done
if kill -0 "$PUBPID" 2>/dev/null; then kill "$PUBPID" 2>/dev/null; bad "links: a FIFO in the outbox or at ledger.md cannot hang the publisher"
else ok "links: a FIFO in the outbox or at ledger.md cannot hang the publisher"; fi
check "links: FIFO and directory entries are rejected, the regular entry publishes" "grep -q 'REJECT 001-fifo.json: not a regular file' '$T/runner.log' && grep -q 'REJECT 002-dir.json: not a regular file' '$T/runner.log' && grep -q 'marker-fifo-ok' '$GH_LOG'"
new_run hardlink
QA_COMMENTABLE=" "; IN_SCOPE=" "
printf '{"action":"create","title":"[UI] marker-hardlink entry","body":"x"}' > "$T/hl-src.json"
ln "$T/hl-src.json" "$RUN_DIR/outbox/001-hl.json"
printf 'marker-hardlink-ledger\n' > "$T/hl-ledger.md"; ln "$T/hl-ledger.md" "$RUN_DIR/ledger.md"
publish_outbox >/dev/null 2>&1
check "links: a hard-linked outbox entry or ledger is not published (a second name for a file elsewhere)" "! grep -q 'marker-hardlink' '$GH_LOG' '$GH_LOG.bodies' && grep -q 'REJECT 001-hl.json: not a regular file' '$T/runner.log'"
new_run report
printf 'RESULT: marker-outside-report\n' > "$T/outside-report.md"; ln -s "$T/outside-report.md" "$RUN_DIR/report.md"
check "report: a report.md symlink does not count as a finished report" "! agent_report_present"
check "report: the summary is never read through a report.md symlink" "[ -z \"\$(agent_report_summary)\" ]"
rm -f "$RUN_DIR/report.md"; mkdir "$RUN_DIR/report.md"
check "report: a directory named report.md is not a report" "! agent_report_present"
rmdir "$RUN_DIR/report.md"; printf 'intro\nRESULT: 3 PASS 1 FAIL\nRESULT: second\n' > "$RUN_DIR/report.md"
check "report: control: a regular report.md is present and gives its first RESULT line" "agent_report_present && [ \"\$(agent_report_summary)\" = 'RESULT: 3 PASS 1 FAIL' ]"
ln -s "$T/no-such-target" "$RUN_DIR/transcript-hosted.jsonl"; : > "$RUN_DIR/claude-hosted.err"
check "runner: a dangling symlink or an existing file is not a fresh runner path" "! runner_fresh_path '$RUN_DIR/transcript-hosted.jsonl' && ! runner_fresh_path '$RUN_DIR/claude-hosted.err' && runner_fresh_path '$RUN_DIR/transcript-new.jsonl'"
# Static: once the first agent starts, the runner writes nothing into RUN_DIR and
# reads report.md only through the no-follow reader.
after_agent() { awk '/^run_agent "\$PROMPT"/{f=1} f' "$QA_DIR/scheduled-ui-sweep.sh"; }
no_rundir_writes() {
  [ -n "$(after_agent)" ] || return 1
  ! after_agent | grep -vE '^[[:space:]]*#' | grep -E '(>>?|tee( -a)?|cp|mv|ln -s[fn]*)[[:space:]]+[^|]*"\$(RUN_DIR|HOSTED_PRS_FILE|DRIFT|FP_FILE)[/"]' | grep -vE 'ln -sfn "\$RUN_DIR" "\$QA_HOME/latest"'
}
check "runner: no write or append into RUN_DIR once an agent has started" "no_rundir_writes"
check "runner: report.md is never opened by name after the agent ran" "! after_agent | grep -F '\$RUN_DIR/report.md'"
check "runner: transcripts are created only at fresh paths, never clobbered" "grep -q 'runner_fresh_path \"\$tr\"' '$QA_DIR/scheduled-ui-sweep.sh' && grep -q 'set -C; exec gtimeout' '$QA_DIR/scheduled-ui-sweep.sh'"

# === every agent-written field bound for GitHub passes the secret gate ========
# Built by concatenation so this file never holds a credential-shaped literal.
FAKE_AKIA="AKIA""IOSFODNN7EXAMPLE"
FAKE_TOKEN="aB3dE6gH9jK2mN5pQ8sT""1vW4yZ7bC0eF3hI6kL9nO2"
FILLER="$(printf 'x%.0s' $(seq 1 190))"
json_str() { jq -n --arg v "$1" '$v'; }
new_run gate
QA_COMMENTABLE=" 555 "; IN_SCOPE=" 100 "
printf 'literal-env-value-123\n' > "$ENVVALS"
outbox 001-akia.json "{\"action\":\"create\",\"title\":$(json_str "[UI] marker-akia $FAKE_AKIA"),\"body\":\"clean body\"}"
outbox 002-token.json "{\"action\":\"create\",\"title\":$(json_str "[UI] marker-token $FAKE_TOKEN"),\"body\":\"clean body\"}"
outbox 003-env.json "{\"action\":\"create\",\"title\":$(json_str "[UI] marker-env literal-env-value-123"),\"body\":\"clean body\"}"
outbox 004-split.json "{\"action\":\"create\",\"title\":$(json_str "[UI] marker-split AKIA
IOSFODNN7EXAMPLE"),\"body\":\"clean body\"}"
outbox 005-cut.json "{\"action\":\"create\",\"title\":$(json_str "[UI] marker-cut $FILLER $FAKE_AKIA"),\"body\":\"clean body\"}"
outbox 006-clean.json '{"action":"create","title":"[UI] marker-clean Devices page 500s","body":"clean body"}'
# A character the title cleaner deletes must not hide a key from the gate.
outbox 007-joined.json "{\"action\":\"create\",\"title\":$(json_str "[UI] marker-joined AKIA@IOSFODNN7EXAMPLE"),\"body\":\"clean body\"}"
outbox 008-joined-tok.json "{\"action\":\"create\",\"title\":$(json_str "[UI] marker-joinedtok ${FAKE_TOKEN:0:20}#${FAKE_TOKEN:20}"),\"body\":\"clean body\"}"
publish_outbox >/dev/null 2>&1
check "gate: AWS key in a title is not published" "! grep -q 'marker-akia' '$GH_LOG'"
check "gate: long token in a title is not published" "! grep -q 'marker-token' '$GH_LOG'"
check "gate: literal .env value in a title is not published" "! grep -q 'marker-env' '$GH_LOG'"
check "gate: a key split across title lines is not published once they are joined" "! grep -q 'marker-split' '$GH_LOG'"
check "gate: a key straddling the 200-char title cut is not half-published" "! grep -q 'marker-cut' '$GH_LOG'"
check "gate: a clean title still publishes" "grep -q 'issue create --title \[UI\] marker-clean' '$GH_LOG'"
check "gate: a key split by a character the title cleaner drops is not published" "! grep -q 'marker-joined ' '$GH_LOG' && ! grep -q 'IOSFODNN7EXAMPLE' '$GH_LOG'"
check "gate: a token split by a dropped character is not published" "! grep -q 'marker-joinedtok' '$GH_LOG'"
check "gate: rejected titles stay out of the runner log" "! grep -q 'marker-' '$T/runner.log' && ! grep -q 'IOSFODNN7EXAMPLE' '$T/runner.log'"
check "gate: each rejected title is recorded by file name" "[ \"\$(grep -c 'REJECT 00[1-5]-.*secret-like title' '$T/runner.log')\" = 5 ]"

new_run gate-fields
QA_COMMENTABLE=" 555 "; IN_SCOPE=" 100 "
outbox 001-create.json "{\"action\":\"create\",\"title\":\"[UI] marker-body-create\",\"body\":$(json_str "see $FAKE_AKIA")}"
outbox 002-comment.json "{\"action\":\"comment\",\"issue\":555,\"body\":$(json_str "see $FAKE_AKIA")}"
outbox 003-pr.json "{\"action\":\"pr_result\",\"pr\":100,\"result\":\"PASS\",\"body\":$(json_str "see $FAKE_AKIA")}"
printf 'ledger with %s\n' "$FAKE_AKIA" > "$RUN_DIR/ledger.md"
publish_outbox >/dev/null 2>&1
check "gate: secret in a create body is not published" "! grep -q 'marker-body-create' '$GH_LOG'"
check "gate: secret in a comment body is not published" "! grep -q 'issue comment 555' '$GH_LOG'"
check "gate: secret in a pr_result body is not published" "! grep -q 'pr comment 100' '$GH_LOG'"
check "gate: secret in the ledger is not published" "! grep -q 'issue edit\|QA sweep ledger' '$GH_LOG'"

new_run gate-ledger
QA_COMMENTABLE=" "; IN_SCOPE=" "
printf 'clean ledger\n' > "$RUN_DIR/ledger.md"
publish_outbox >/dev/null 2>&1
check "gate: a clean ledger still publishes" "grep -q 'issue edit' '$GH_LOG'"

new_run gate-binary
printf 'tok \000 %s\n' "$FAKE_TOKEN" > "$T/nul.md"
printf 'tok \377 %s\n' "$FAKE_TOKEN" > "$T/badutf.md"
printf 'plain text body\n' > "$T/plain.md"
check "gate: a NUL byte cannot hide a token from the gate" "! body_ok '$T/nul.md'"
check "gate: invalid UTF-8 cannot hide a token from the gate" "! body_ok '$T/badutf.md'"
check "gate: plain text passes" "body_ok '$T/plain.md'"

# === Strix r7: the secret gate fails CLOSED ===================================
# The gate passes a body only on a positive "clean" verdict. A check that errors,
# is killed, or is cut short by SIGPIPE under pipefail rejects the body.
new_run gate-closed
# Log-sized: ~38 KB of token-shaped lines (fills a pipe). The old `| grep -q`
# consumer exited at its first hit and SIGPIPEd the greps above it, so under
# pipefail a body full of tokens was reported clean some of the time.
for i in $(seq 1 700); do printf 'line %04d %s\n' "$i" "$FAKE_TOKEN"; done > "$T/logsized-token.md"
LOWER="$(printf 'abcdefghij%.0s' 1 2 3 4 5)"   # 50 chars, no upper/digit: not token-like
for i in $(seq 1 700); do printf 'line %04d %s\n' "$i" "$LOWER"; done > "$T/logsized-clean.md"
leaks=0; for _ in $(seq 1 60); do body_ok "$T/logsized-token.md" && leaks=$((leaks+1)); done
check "gate: a log-sized body full of tokens is rejected every time under pipefail (60/60)" "[ $leaks = 0 ]"
check "gate: control: a log-sized body with no token passes" "body_ok '$T/logsized-clean.md'"
check "gate: a 40-hex SHA and a long hyphenated slug are not tokens" "printf 'sha 0123456789abcdef0123456789abcdef01234567 and fix-the-devices-page-crash-when-the-filter-is-empty-12\n' > '$T/sha.md' && body_ok '$T/sha.md'"
# A broken or killed checker is a rejection, never a pass.
mkdir -p "$T/grep-err" "$T/grep-killed"
printf '#!/bin/sh\nexit 2\n' > "$T/grep-err/grep"; printf '#!/bin/sh\nkill -PIPE $$\n' > "$T/grep-killed/grep"
chmod +x "$T/grep-err/grep" "$T/grep-killed/grep"
check "gate: grep failing (exit 2) rejects the body" "! ( PATH='$T/grep-err':\"\$PATH\"; body_ok '$T/plain.md' )"
check "gate: grep killed by a signal rejects the body" "! ( PATH='$T/grep-killed':\"\$PATH\"; body_ok '$T/plain.md' )"
printf 'literal-env-value-123\n' > "$ENVVALS"; chmod 000 "$ENVVALS"
check "gate: an unreadable .env value list rejects the body" "[ \"\$(id -u)\" = 0 ] || ! body_ok '$T/plain.md'"
chmod 600 "$ENVVALS"; rm -f "$ENVVALS"
check "gate: a missing .env value list rejects the body" "! body_ok '$T/plain.md'"
: > "$ENVVALS"
check "gate: an empty .env value list (no .env files) still passes clean text" "body_ok '$T/plain.md'"
check "gate: a token scanner that crashes rejects the body" "! ( _body_scan() { return 137; }; body_ok '$T/plain.md' )"
check "gate: a token scanner that exits 0 without a verdict rejects the body" "! ( _body_scan() { :; }; body_ok '$T/plain.md' )"
# Size is bounded before anything scans it.
head -c 60000 /dev/zero | tr '\0' 'a' > "$T/at-limit.md"; head -c 60001 /dev/zero | tr '\0' 'a' > "$T/over-limit.md"
check "gate: a body at the size limit passes" "body_ok '$T/at-limit.md'"
check "gate: a body one byte over the limit is rejected" "! body_ok '$T/over-limit.md'"
check "gate: an oversize body never reaches the scanner" "! ( _body_scan() { echo scanned > '$T/scanned'; echo clean; }; body_ok '$T/over-limit.md' ) && [ ! -e '$T/scanned' ]"
check "gate: a directory or missing path is rejected" "! body_ok '$T' && ! body_ok '$T/no-such-file'"

new_run gate-log
QA_COMMENTABLE=" "; IN_SCOPE=" "
outbox 001.json "{\"action\":\"comment\",\"issue\":$(json_str "marker-issue-$FAKE_AKIA"),\"body\":\"clean body\"}"
outbox 002.json "{\"action\":\"pr_result\",\"pr\":$(json_str "marker-pr-$FAKE_AKIA"),\"result\":\"PASS\",\"body\":\"clean body\"}"
outbox 003.json "{\"action\":$(json_str "marker-action-$FAKE_AKIA"),\"body\":\"clean body\"}"
publish_outbox >/dev/null 2>&1
check "gate: rejected issue/pr/action values stay out of the runner log" "! grep -q 'IOSFODNN7EXAMPLE' '$T/runner.log'"

# === Strix r6: the [QA] title namespace belongs to the runner =================
# The runner files "[QA] Dev stack fails to boot on main" / "[QA] Environment
# change ..." itself, dedupes them by exact title, and the release checklist
# reads them as ship/block gates. The agent may only mint "[UI] " titles.
new_run reserved
QA_COMMENTABLE=" "; IN_SCOPE=" "
outbox 001.json '{"action":"create","title":"[QA] Dev stack fails to boot on main","body":"spoofed blocker"}'
outbox 002.json '{"action":"create","title":"[QA] Environment change on main needs upgrade notes","body":"spoofed"}'
outbox 003.json '{"action":"create","title":"[QA] marker-qa-other finding","body":"any QA title"}'
outbox 004.json '{"action":"create","title":"[qa] marker-qa-lower finding","body":"case variant"}'
outbox 005.json '{"action":"create","title":"  [QA] marker-qa-space finding","body":"leading space"}'
outbox 006.json '{"action":"create","title":"［QA］ marker-qa-wide finding","body":"fullwidth brackets"}'
outbox 007.json '{"action":"create","title":"QA sweep ledger","body":"ledger squat"}'
outbox 008.json '{"action":"create","title":"[UI] marker-ui-ok Devices page 500s","body":"real finding"}'
publish_outbox >/dev/null 2>&1
check "reserved: no agent entry creates a [QA]-prefixed issue" "! grep -qi 'issue create --title [^A-Za-z]*qa' '$GH_LOG'"
check "reserved: case/space/fullwidth variants are not published" "! grep -q 'marker-qa-' '$GH_LOG'"
check "reserved: the runner's ledger title cannot be squatted" "! grep -q 'issue create --title QA sweep ledger' '$GH_LOG'"
check "reserved: a [UI] finding still publishes" "grep -q 'issue create --title \[UI\] marker-ui-ok' '$GH_LOG'"
check "reserved: each refused title is logged by file name" "[ \"\$(grep -c 'REJECT 00[1-7]\.json' '$T/runner.log')\" = 7 ]"

# === Strix r6: an agent-written .pr never reaches runner bookkeeping ===========
# A malformed .pr used to land in .pr-keep before validation (shadowing the real
# verdict for that PR) and was then spliced unquoted into a jq argv.
new_run prkeep
QA_COMMENTABLE=" "; IN_SCOPE=" 101 102 "
outbox 001-real.json '{"action":"pr_result","pr":101,"result":"PASS","body":"checked the page"}'
outbox 002-evil.json '{"action":"pr_result","pr":"101 --from-file","result":"FAIL","body":"shadow"}'
outbox 003-dash.json '{"action":"pr_result","pr":"-101","result":"FAIL","body":"shadow"}'
outbox 004-lead0.json '{"action":"pr_result","pr":"0101","result":"FAIL","body":"shadow"}'
outbox 005-real.json '{"action":"pr_result","pr":102,"result":"PASS","body":"checked the page"}'
outbox 006-secret.json "{\"action\":\"pr_result\",\"pr\":102,\"result\":\"FAIL\",\"body\":$(json_str "see $FAKE_AKIA")}"
touch -t 202611170100 "$RUN_DIR/outbox/001-real.json"
touch -t 202611170200 "$RUN_DIR/outbox/002-evil.json" "$RUN_DIR/outbox/003-dash.json" "$RUN_DIR/outbox/004-lead0.json"
touch -t 202611170100 "$RUN_DIR/outbox/005-real.json"
touch -t 202611170200 "$RUN_DIR/outbox/006-secret.json"
publish_outbox >/dev/null 2>&1
check "pr-keep: a malformed newer .pr does not supersede the real verdict" "grep -q '^-R LanternOps/breeze pr comment 101 ' '$GH_LOG' && ! grep -q 'SKIP 001-real.json' '$T/runner.log'"
check "pr-keep: malformed .pr values are rejected as bad pr" "[ \"\$(grep -c 'REJECT 00[234]-.*bad pr' '$T/runner.log')\" = 3 ]"
check "pr-keep: the keep file holds only runner paths" "! grep -q -- '--from-file\|^-' '$PUBLISH_DIR/.pr-keep'"
check "pr-keep: the published verdict is what the runner reports" "[ \"\$(hosted_verdict 101)\" = PASS ]"
check "pr-keep: a verdict whose body was refused is not conclusive" "[ -z \"\$(hosted_verdict 102)\" ]"
check "pr-keep: a PR with no verdict reports none" "[ -z \"\$(hosted_verdict 103)\" ]"

# === F2/F3: kernel-enforced sandbox for the agent's whole process tree ========
if [ -x /usr/bin/sandbox-exec ] && type qa_sandbox_profile >/dev/null 2>&1; then
  new_run sb
  # Real layout: QA_HOME is ~/.breeze-qa and runs live under it. HOME is a
  # throwaway; the rules below are exercised by really attempting each access.
  FAKE_HOME="$T/fakehome"; QA_HOME="$FAKE_HOME/.breeze-qa"; mkdir -p "$QA_HOME"
  RUN_DIR="$QA_HOME/runs/$RUN_ID"; mkdir -p "$RUN_DIR/outbox"
  QA_WORKTREE="$QA_HOME/worktree"; QA_SOURCE_REPO="$T/source-repo"
  STACK_ENV_DIR="$QA_HOME/.stack-env"; STATE="$QA_HOME/state.json"; AGENT_TMP="$(cd "$(mktemp -d /tmp/qa-at.XXXXXX)" && pwd -P)"   # short: unix socket paths are capped at 104 bytes
  AGENT_CLAUDE_DIR="$QA_HOME/.claude-agent"
  mkdir -p "$AGENT_TMP"
  mkdir -p "$QA_WORKTREE/apps/api" "$QA_SOURCE_REPO" "$STACK_ENV_DIR" "$QA_HOME/runs/older" "$QA_HOME/bin" "$RUN_DIR/.claude"
  echo 'SESSION_SECRET=parked' > "$STACK_ENV_DIR/.env"
  echo 'JWT_SECRET=nested' > "$QA_WORKTREE/apps/api/.env.local"
  echo 'POSTGRES_PASSWORD=dev' > "$QA_SOURCE_REPO/.env"
  echo 'supersecretvalue' > "$ENVVALS"
  echo 'OPENAI_API_KEY=x' > "$QA_HOME/env.overrides"
  echo 'container log line' > "$QA_HOME/runs/older/container-api.log"
  echo 'runner log' > "$RUN_DIR/runner.log"
  echo 'readme' > "$QA_WORKTREE/README.md"
  echo '{}' > "$STATE"
  printf 'aaa\t2026\tx (#1)\n' > "$RUN_DIR/commits.tsv"
  mkdir -p "$FAKE_HOME/.config/gh" "$FAKE_HOME/.config/git"
  echo '[user]' > "$FAKE_HOME/.gitconfig"; echo '[user]' > "$FAKE_HOME/.config/git/config"
  echo 'https://u:p@example.invalid' > "$FAKE_HOME/.git-credentials"
  echo 'github.com:' > "$FAKE_HOME/.config/gh/hosts.yml"; echo 'version: 1' > "$FAKE_HOME/.config/gh/config.yml"
  git init -q "$QA_SOURCE_REPO"
  AUDIT="$(egress_log_path)"; mkdir -p "$(dirname "$AUDIT")"; echo 'ALLOW api.github.com:443' > "$AUDIT"
  echo 'err' > "$RUN_DIR/claude.err"; echo '{}' > "$RUN_DIR/transcript.jsonl"
  mkdir -p "$FAKE_HOME/.aws" && echo '[default]' > "$FAKE_HOME/.aws/credentials"
  mkdir -p "$FAKE_HOME/Library/Application Support/Google/Chrome/Default" && echo c > "$FAKE_HOME/Library/Application Support/Google/Chrome/Default/Cookies"
  # The "stack": a loopback HTTP server the profile allows; a second listener it does not.
  /usr/bin/python3 -m http.server 0 --bind 127.0.0.1 --directory "$QA_WORKTREE" > "$T/http.log" 2>&1 &
  HTTP_PID=$!
  /usr/bin/python3 -m http.server 0 --bind 127.0.0.1 --directory "$QA_WORKTREE" > "$T/http2.log" 2>&1 &
  HTTP2_PID=$!; sleep 1
  lport() { lsof -nP -a -p "$1" -iTCP -sTCP:LISTEN 2>/dev/null | awk 'NR==2{n=split($9,a,":");print a[n]}'; }
  HTTP_PORT="$(lport "$HTTP_PID")"; HTTP2_PORT="$(lport "$HTTP2_PID")"
  QA_STACK_PORT="$HTTP_PORT"; EGRESS_PORT=1; GH_BROKER_PORT=2
  # Per-user stores the agent must not read (Strix r8): reads under the home
  # directory are an allow-list, not a list of known stores.
  mkdir -p "$FAKE_HOME/.claude/projects/-Users-dev-repo" "$FAKE_HOME/.claude/todos" "$FAKE_HOME/.ssh" \
    "$FAKE_HOME/.config/someapp" "$FAKE_HOME/.claude-auth/acct" "$FAKE_HOME/dev/repo/apps/api" \
    "$FAKE_HOME/Library/Keychains/55508251-BFB9-5056-BD1A-F6ADBAACF3A5" "$FAKE_HOME/Library/Caches/ms-playwright/chromium-1" \
    "$FAKE_HOME/Library/Fonts" "$FAKE_HOME/.local/share/claude/versions" "$FAKE_HOME/.toolbin"
  echo '{"type":"user","message":"transcript"}' > "$FAKE_HOME/.claude/projects/-Users-dev-repo/s1.jsonl"
  echo '- memory' > "$FAKE_HOME/.claude/projects/-Users-dev-repo/MEMORY.md"
  echo '{"env":{}}' > "$FAKE_HOME/.claude/settings.json"; echo '{}' > "$FAKE_HOME/.claude/history.jsonl"
  echo '[]' > "$FAKE_HOME/.claude/todos/t.json"
  echo '{"oauthAccount":{}}' > "$FAKE_HOME/.claude.json"
  echo '{"claudeAiOauth":{}}' > "$FAKE_HOME/.claude-auth/acct/.credentials.json"
  echo 'PRIVATE KEY' > "$FAKE_HOME/.ssh/id_ed25519"
  echo ': 1:0;export TOKEN=x' > "$FAKE_HOME/.zsh_history"; echo 'history' > "$FAKE_HOME/.bash_history"
  echo 'export GITHUB_TOKEN=x' > "$FAKE_HOME/.zshrc"; echo 'export X=1' > "$FAKE_HOME/.bash_profile"
  echo 'token = x' > "$FAKE_HOME/.config/someapp/config.toml"
  echo '//registry.npmjs.org/:_authToken=x' > "$FAKE_HOME/.npmrc"
  echo 'machine x login y' > "$FAKE_HOME/.netrc"
  echo 'DATABASE_URL=postgres://dev' > "$FAKE_HOME/dev/repo/.env"; echo 'K=v' > "$FAKE_HOME/dev/repo/apps/api/.env.local"
  echo 'readme' > "$FAKE_HOME/dev/repo/README.md"
  echo db > "$FAKE_HOME/Library/Keychains/login.keychain-db"; echo meta > "$FAKE_HOME/Library/Keychains/metadata.keychain-db"
  echo kc > "$FAKE_HOME/Library/Keychains/55508251-BFB9-5056-BD1A-F6ADBAACF3A5/keychain-2.db"
  echo bin > "$FAKE_HOME/Library/Caches/ms-playwright/chromium-1/chrome"; echo font > "$FAKE_HOME/Library/Fonts/f.ttf"
  echo '{}' > "$QA_HOME/launchd.out.log"
  # A per-user claude install (~/.local/share/claude/versions/<v>, linked from a PATH dir).
  printf '#!/bin/sh\necho tool-ok\n' > "$FAKE_HOME/.local/share/claude/versions/9.9.9"; chmod +x "$FAKE_HOME/.local/share/claude/versions/9.9.9"
  ln -sf "$FAKE_HOME/.local/share/claude/versions/9.9.9" "$FAKE_HOME/.toolbin/claude"
  echo 'export SECRET=1' > "$FAKE_HOME/.toolbin/other-script"
  echo 'other version' > "$FAKE_HOME/.local/share/claude/versions/other-file"
  # A standalone node dropped into a shared bin dir (~/.local/bin/node): its
  # neighbours and the dir's parent (~/.local) are not the toolchain.
  mkdir -p "$FAKE_HOME/.local/bin" "$FAKE_HOME/.local/share/otherapp"
  printf '#!/bin/sh\necho node-ok\n' > "$FAKE_HOME/.local/bin/node"; chmod +x "$FAKE_HOME/.local/bin/node"
  echo 'token=x' > "$FAKE_HOME/.local/bin/deploy-secret.sh"; echo 'data' > "$FAKE_HOME/.local/share/otherapp/db"
  PROF="$T/agent.sb"
  check "sandbox: the profile refuses to build without the stack/proxy/broker ports" "! (QA_STACK_PORT='' HOME='$FAKE_HOME' qa_sandbox_profile '$T/noport.sb')"
  HOME="$FAKE_HOME" PATH="$FAKE_HOME/.toolbin:$FAKE_HOME/.local/bin:$PATH" qa_sandbox_profile "$PROF"
  sbx() { /usr/bin/sandbox-exec -f "$PROF" "$@"; }
  check "F2: parked stack env is unreadable" "! sbx /bin/cat '$STACK_ENV_DIR/.env' >/dev/null 2>&1"
  check "F2: a .env left in the worktree is unreadable (any tool, not just Read)" "! sbx /bin/cat '$QA_WORKTREE/apps/api/.env.local' >/dev/null 2>&1"
  check "F2: recursive grep of the worktree cannot see .env contents" "! sbx /usr/bin/grep -r SECRET '$QA_WORKTREE' 2>/dev/null | grep -q SECRET"
  check "F2: the developer repo's .env is unreadable" "! sbx /bin/cat '$QA_SOURCE_REPO/.env' >/dev/null 2>&1"
  check "F2: redaction list + machine overrides are unreadable" "! sbx /bin/cat '$ENVVALS' >/dev/null 2>&1 && ! sbx /bin/cat '$QA_HOME/env.overrides' >/dev/null 2>&1"
  check "F2: other runs' container logs are unreadable" "! sbx /bin/cat '$QA_HOME/runs/older/container-api.log' >/dev/null 2>&1"
  check "F2: this run's runner log is unreadable" "! sbx /bin/cat '$RUN_DIR/runner.log' >/dev/null 2>&1"
  mkdir -p "$RUN_DIR/unrelated"; echo 'X=1' > "$RUN_DIR/unrelated/.env"
  check "sandbox: the .env rule is scoped (a .env elsewhere stays readable)" "sbx /bin/cat '$RUN_DIR/unrelated/.env' >/dev/null 2>&1"
  check "sandbox: ordinary worktree files stay readable" "[ \"\$(sbx /bin/cat '$QA_WORKTREE/README.md')\" = readme ]"
  # === Strix r8: reads under the home directory are an allow-list ===
  unread() {  # unread <path...>: each is readable outside (control) and unreadable inside
    local p c
    for p in "$@"; do
      c=/bin/cat; [ -d "$p" ] && c=/bin/ls
      "$c" "$p" >/dev/null 2>&1 || { echo "control failed: $p"; return 1; }
      if sbx "$c" "$p" >/dev/null 2>&1; then echo "readable inside: $p"; return 1; fi
    done
  }
  echo canary > "$FAKE_HOME/.qa-unlisted-file"
  check "read: a file in the home directory that no rule names is unreadable (default deny)" "unread '$FAKE_HOME/.qa-unlisted-file' '$FAKE_HOME'"
  check "read: ~/.claude transcripts, memory, settings, history and todos are unreadable" "unread '$FAKE_HOME/.claude' '$FAKE_HOME/.claude/projects' '$FAKE_HOME/.claude/projects/-Users-dev-repo/s1.jsonl' '$FAKE_HOME/.claude/projects/-Users-dev-repo/MEMORY.md' '$FAKE_HOME/.claude/settings.json' '$FAKE_HOME/.claude/history.jsonl' '$FAKE_HOME/.claude/todos/t.json'"
  check "read: ~/.claude.json is unreadable" "unread '$FAKE_HOME/.claude.json'"
  check "read: claude.ai login profiles (~/.claude-auth) are unreadable" "unread '$FAKE_HOME/.claude-auth' '$FAKE_HOME/.claude-auth/acct/.credentials.json'"
  check "read: ~/.ssh is unreadable" "unread '$FAKE_HOME/.ssh' '$FAKE_HOME/.ssh/id_ed25519'"
  check "read: shell history and rc files are unreadable" "unread '$FAKE_HOME/.zsh_history' '$FAKE_HOME/.bash_history' '$FAKE_HOME/.zshrc' '$FAKE_HOME/.bash_profile'"
  check "read: ~/.config is unreadable (any app, not only gh/git)" "unread '$FAKE_HOME/.config' '$FAKE_HOME/.config/someapp/config.toml'"
  check "read: ~/.npmrc and ~/.netrc are unreadable" "unread '$FAKE_HOME/.npmrc' '$FAKE_HOME/.netrc'"
  check "read: a developer checkout under the home directory and its .env files are unreadable" "unread '$FAKE_HOME/dev/repo' '$FAKE_HOME/dev/repo/README.md' '$FAKE_HOME/dev/repo/.env' '$FAKE_HOME/dev/repo/apps/api/.env.local'"
  check "read: keychain files other than the login db are unreadable" "unread '$FAKE_HOME/Library/Keychains' '$FAKE_HOME/Library/Keychains/metadata.keychain-db' '$FAKE_HOME/Library/Keychains/55508251-BFB9-5056-BD1A-F6ADBAACF3A5/keychain-2.db'"
  check "read: runner state and launchd logs in QA_HOME are unreadable" "unread '$STATE' '$QA_HOME/launchd.out.log' '$QA_HOME'"
  check "read: the developer repo (QA_SOURCE_REPO) is unreadable, wherever it lives" "echo readme > '$QA_SOURCE_REPO/README.md' && unread '$QA_SOURCE_REPO/README.md' '$QA_SOURCE_REPO/.git/config'"
  check "read: other files in a PATH dir under the home directory are unreadable" "unread '$FAKE_HOME/.toolbin/other-script'"
  check "read: only the resolved tool file is allowed, not its directory (other versions, siblings)" "unread '$FAKE_HOME/.local/share/claude/versions/other-file' '$FAKE_HOME/.local/share/claude/versions'"
  check "read: a node in a shared bin dir runs, but its neighbours and ~/.local stay unreadable" "[ \"\$(sbx '$FAKE_HOME/.local/bin/node')\" = node-ok ] && unread '$FAKE_HOME/.local/bin/deploy-secret.sh' '$FAKE_HOME/.local/share/otherapp/db'"
  # Outside the home directory: per-user temp/cache dirs and /tmp hold other
  # programs' scratch files (other sessions' notes, caches).
  UTMP="$(getconf DARWIN_USER_TEMP_DIR 2>/dev/null)"; UCACHE="$(getconf DARWIN_USER_CACHE_DIR 2>/dev/null)"
  echo canary > "$T/.qa-utemp-canary"; echo canary > "${UCACHE}qa-ucache-canary.$$"; echo canary > "/private/tmp/qa-tmp-canary.$$"
  check "read: the per-user temp dir, cache dir and /tmp are unreadable" "unread '$T/.qa-utemp-canary' '${UCACHE}qa-ucache-canary.$$' '/private/tmp/qa-tmp-canary.$$' '${UTMP%/}'"
  rm -f "$T/.qa-utemp-canary" "${UCACHE}qa-ucache-canary.$$" "/private/tmp/qa-tmp-canary.$$"
  check "read: a hard link of an unreadable file cannot be made in RUN_DIR" "! sbx /bin/ln '$FAKE_HOME/.qa-unlisted-file' '$RUN_DIR/hl.json' 2>/dev/null && [ ! -e '$RUN_DIR/hl.json' ]"
  # What the run needs stays readable.
  check "read: the login keychain db stays readable (claude.ai token refresh)" "[ \"\$(sbx /bin/cat '$FAKE_HOME/Library/Keychains/login.keychain-db')\" = db ]"
  : > "$FAKE_HOME/Library/Keychains/.flC23220F1"; echo x > "$FAKE_HOME/Library/Keychains/.flother"
  check "read: the keychain's empty .fl<hex> lock files stay readable (Security.framework locks with them)" "sbx /bin/cat '$FAKE_HOME/Library/Keychains/.flC23220F1' && unread '$FAKE_HOME/Library/Keychains/.flother'"
  check "read: a per-user claude install under the home directory still runs" "[ \"\$(sbx '$FAKE_HOME/.toolbin/claude')\" = tool-ok ]"
  check "read: Playwright's browser cache and user fonts stay readable" "[ \"\$(sbx /bin/cat '$FAKE_HOME/Library/Caches/ms-playwright/chromium-1/chrome')\" = bin ] && sbx /bin/cat '$FAKE_HOME/Library/Fonts/f.ttf' >/dev/null"
  mkdir -p "$QA_HOME/mcp/node_modules/x" "$AGENT_CLAUDE_DIR"; echo mcp > "$QA_HOME/mcp/node_modules/x/i.js"; echo cfg > "$AGENT_CLAUDE_DIR/c.json"
  echo tmp > "$AGENT_TMP/t"; echo report > "$RUN_DIR/report.md"
  check "read: RUN_DIR, the agent TMPDIR, its claude config dir and the MCP install stay readable" "[ \"\$(sbx /bin/cat '$RUN_DIR/report.md' '$AGENT_TMP/t' '$AGENT_CLAUDE_DIR/c.json' '$QA_HOME/mcp/node_modules/x/i.js' | tr '\n' ' ')\" = 'report tmp cfg mcp ' ] && sbx /bin/ls '$RUN_DIR' >/dev/null"
  check "read: the runner's own scripts (qa-gh) stay readable" "sbx /bin/cat '$QA_DIR/qa-gh' >/dev/null"
  rm -f "$RUN_DIR/report.md"
  check "sandbox: RUN_DIR's parents can be stat'ed (claude --add-dir / Edit rules resolve it)" "sbx /usr/bin/python3 -c 'import os,sys; os.lstat(os.path.dirname(sys.argv[1])); os.path.realpath(sys.argv[1])' '$RUN_DIR'"
  check "sandbox: RUN_DIR stays writable for the report/outbox" "sbx /bin/sh -c 'echo r > \"$RUN_DIR/report.md\"' && [ -s '$RUN_DIR/report.md' ]"
  check "F1: commits.tsv is not writable from inside" "! sbx /bin/sh -c 'echo x >> \"$RUN_DIR/commits.tsv\"' 2>/dev/null"
  check "dedupe: open-issues.tsv cannot be planted or rewritten from inside" "! sbx /bin/sh -c 'echo x > \"$RUN_DIR/open-issues.tsv\"' 2>/dev/null"
  check "F5: RUN_DIR/.claude is not writable from inside" "! sbx /bin/sh -c 'mkdir -p \"$RUN_DIR/.claude/skills/x\"' 2>/dev/null"
  check "F5: no CLAUDE.md can be planted in RUN_DIR" "! sbx /bin/sh -c 'echo x > \"$RUN_DIR/CLAUDE.md\"' 2>/dev/null"
  check "sandbox: worktree is read-only" "! sbx /bin/sh -c 'echo x > \"$QA_WORKTREE/planted\"' 2>/dev/null"
  check "sandbox: runner state and bin are read-only" "! sbx /bin/sh -c 'echo x > \"$STATE\"' 2>/dev/null && ! sbx /bin/sh -c 'echo x > \"$QA_HOME/bin/x\"' 2>/dev/null"
  # The egress audit trail lives outside everything the agent can write.
  case "$AUDIT" in "$RUN_DIR"/*|"") bad "audit: egress log is outside RUN_DIR" ;; *) ok "audit: egress log is outside RUN_DIR" ;; esac
  check "audit: the agent cannot append to the egress log" "! sbx /bin/sh -c 'echo forged >> \"$AUDIT\"' 2>/dev/null"
  check "audit: the agent cannot truncate the egress log" "! sbx /bin/sh -c ': > \"$AUDIT\"' 2>/dev/null"
  check "audit: the agent cannot delete the egress log" "! sbx /bin/rm -f '$AUDIT' 2>/dev/null && [ -f '$AUDIT' ]"
  check "audit: the agent cannot read the egress log" "! sbx /bin/cat '$AUDIT' >/dev/null 2>&1"
  check "audit: the log is intact after every attempt" "[ \"\$(cat '$AUDIT')\" = 'ALLOW api.github.com:443' ]"
  # Seatbelt matches the path at access time, so a renamed ancestor would slip out of every rule.
  renamed() { if sbx /bin/mv "$1" "$1.moved" 2>/dev/null; then /bin/mv "$1.moved" "$1"; return 0; fi; return 1; }
  check "audit: the audit directory cannot be renamed away" "! renamed '$QA_HOME/.audit'"
  check "audit: QA_HOME cannot be renamed to escape the path rules" "! renamed '$QA_HOME'"
  check "audit: QA_HOME's parent cannot be renamed to escape the path rules" "! renamed '$(dirname "$QA_HOME")'"
  check "audit: the runs directory cannot be renamed" "! renamed '$QA_HOME/runs'"
  check "audit: RUN_DIR cannot be renamed" "! renamed '$RUN_DIR'"
  check "audit: ~/.config cannot be renamed to escape the gh and git rules" "! renamed '$FAKE_HOME/.config'"
  check "sandbox: RUN_DIR still accepts new files with its ancestors locked" "sbx /bin/sh -c 'echo r > \"$RUN_DIR/after-rules.md\"' && [ -s '$RUN_DIR/after-rules.md' ]"
  # Runner-written records in RUN_DIR are not the agent's to alter.
  check "logs: runner.log is not writable from inside" "! sbx /bin/sh -c 'echo x >> \"$RUN_DIR/runner.log\"' 2>/dev/null"
  check "logs: claude.err is not writable from inside" "! sbx /bin/sh -c 'echo x >> \"$RUN_DIR/claude.err\"' 2>/dev/null"
  check "logs: the transcript is not writable from inside" "! sbx /bin/sh -c 'echo x >> \"$RUN_DIR/transcript.jsonl\"' 2>/dev/null"
  check "logs: no new top-level .log can be planted in RUN_DIR" "! sbx /bin/sh -c 'echo x > \"$RUN_DIR/egress.log\"' 2>/dev/null"
  sbx /bin/sh -c 'echo out; echo err >&2' > "$RUN_DIR/transcript-fd.jsonl" 2> "$RUN_DIR/claude-fd.err"
  check "logs: the runner's redirected stdout/stderr still reach the transcript" "[ \"\$(cat '$RUN_DIR/transcript-fd.jsonl')\" = out ] && [ \"\$(cat '$RUN_DIR/claude-fd.err')\" = err ]"
  mkdir -p "$RUN_DIR/browser"
  check "logs: the browser's own logs under RUN_DIR/browser stay writable" "sbx /bin/sh -c 'echo x > \"$RUN_DIR/browser/console.log\"'"
  # Developer checkout and git/GitHub config: nothing the next unsandboxed run would trust.
  check "dev: the developer checkout's git config is read-only" "! sbx /bin/sh -c 'echo x >> \"$QA_SOURCE_REPO/.git/config\"' 2>/dev/null"
  check "dev: no git hook can be planted in the developer checkout" "! sbx /bin/sh -c 'echo x > \"$QA_SOURCE_REPO/.git/hooks/pre-commit\"' 2>/dev/null"
  check "dev: the developer checkout's files are read-only" "! sbx /bin/sh -c 'echo x > \"$QA_SOURCE_REPO/planted\"' 2>/dev/null"
  check "dev: ~/.gitconfig is read-only" "! sbx /bin/sh -c 'echo x >> \"$FAKE_HOME/.gitconfig\"' 2>/dev/null"
  check "dev: ~/.config/git is read-only" "! sbx /bin/sh -c 'echo x >> \"$FAKE_HOME/.config/git/config\"' 2>/dev/null"
  check "dev: ~/.git-credentials is unreadable and read-only" "! sbx /bin/cat '$FAKE_HOME/.git-credentials' >/dev/null 2>&1 && ! sbx /bin/sh -c 'echo x >> \"$FAKE_HOME/.git-credentials\"' 2>/dev/null"
  check "gh: the token store cannot be rewritten" "! sbx /bin/sh -c 'echo x >> \"$FAKE_HOME/.config/gh/hosts.yml\"' 2>/dev/null"
  check "gh: its token store and config are unreadable (GitHub only via the broker)" "! sbx /bin/cat '$FAKE_HOME/.config/gh/hosts.yml' >/dev/null 2>&1 && ! sbx /bin/cat '$FAKE_HOME/.config/gh/config.yml' >/dev/null 2>&1"
  check "creds: ~/.aws is unreadable" "! sbx /bin/cat '$FAKE_HOME/.aws/credentials' >/dev/null 2>&1"
  check "creds: the developer's real Chrome profile is unreadable" "! sbx /bin/cat '$FAKE_HOME/Library/Application Support/Google/Chrome/Default/Cookies' >/dev/null 2>&1"
  rm -f "$QA_DIR/.qa-planted"
  check "lib: the runner's own scripts (qa-gh, broker, lib) are read-only" "! sbx /bin/sh -c 'echo x > \"$QA_DIR/.qa-planted\"' 2>/dev/null && ! sbx /bin/sh -c 'echo x >> \"$QA_DIR/qa-gh\"' 2>/dev/null"
  rm -f "$QA_DIR/.qa-planted"
  # Strix r7: writes are an allow-list (RUN_DIR, the agent TMPDIR, the agent's own
  # throwaway claude config dir), not a deny-list under (allow default). Anything
  # the profile does not name -- a PATH directory, a dotfile, a cache the next
  # unsandboxed run executes from -- is read-only.
  mkdir -p "$FAKE_HOME/.local/bin" "$FAKE_HOME/.claude/projects/p/memory" "$FAKE_HOME/.npm/_npx/abc" \
    "$FAKE_HOME/Library/Caches/ms-playwright/chromium-1" "$AGENT_CLAUDE_DIR"
  echo '{}' > "$FAKE_HOME/.claude.json"
  planted() { sbx /bin/sh -c 'echo x >> "$1"' _ "$1" 2>/dev/null; }
  check "write: a PATH directory (~/.local/bin) is read-only (no planted claude/gh)" "! planted '$FAKE_HOME/.local/bin/claude' && ! planted '$FAKE_HOME/.local/bin/gh' && [ ! -e '$FAKE_HOME/.local/bin/claude' ]"
  check "write: the home directory itself is read-only" "! planted '$FAKE_HOME/.qa-planted' && ! planted '$FAKE_HOME/.npmrc'"
  check "write: ~/.claude.json (mcpServers, hooks) is read-only" "! planted '$FAKE_HOME/.claude.json' && ! planted '$FAKE_HOME/.claude.json.tmp'"
  check "write: the developer's claude config dir is read-only (memory, handoff, settings)" "! planted '$FAKE_HOME/.claude/projects/p/memory/MEMORY.md' && ! planted '$FAKE_HOME/.claude/planted.json'"
  check "write: npx's package cache is read-only (the cached MCP server)" "! planted '$FAKE_HOME/.npm/_npx/abc/planted.js'"
  check "write: Playwright's browser cache is read-only (the Chromium binary)" "! planted '$FAKE_HOME/Library/Caches/ms-playwright/chromium-1/planted'"
  mkdir -p "$FAKE_HOME/Library/Caches/ms-playwright/b"
  check "write: Playwright's shared browser registry is read-only (descriptors other clients trust)" "! planted '$FAKE_HOME/Library/Caches/ms-playwright/b/browser@planted'"
  check "write: an arbitrary path outside the allow-list is read-only" "! planted '$T/outside-planted' && ! planted '/private/tmp/qa-planted-$$' && [ ! -e '/private/tmp/qa-planted-$$' ]"
  if [ -d /opt/homebrew/bin ] && [ -w /opt/homebrew/bin ]; then
    check "write: /opt/homebrew/bin (gh, node) is read-only" "! planted '/opt/homebrew/bin/.qa-planted-$$' && [ ! -e '/opt/homebrew/bin/.qa-planted-$$' ]"
  else skip "write: /opt/homebrew/bin (not writable by this user)"; fi
  rm -f "/opt/homebrew/bin/.qa-planted-$$" "/private/tmp/qa-planted-$$" 2>/dev/null
  mkdir -p "$QA_HOME/mcp/node_modules/@playwright/mcp"; echo '// cli' > "$QA_HOME/mcp/node_modules/@playwright/mcp/cli.js"
  check "write: the runner's pinned MCP install is read-only" "! planted '$QA_HOME/mcp/node_modules/@playwright/mcp/cli.js' && [ \"\$(cat '$QA_HOME/mcp/node_modules/@playwright/mcp/cli.js')\" = '// cli' ]"
  # A claude.ai token refresh saves through the login keychain, which writes a
  # login.keychain-db.sb-* temp file and renames it over login.keychain-db from
  # inside the calling process. Losing that write loses a rotated refresh token.
  mkdir -p "$FAKE_HOME/Library/Keychains"; echo db > "$FAKE_HOME/Library/Keychains/login.keychain-db"
  echo meta > "$FAKE_HOME/Library/Keychains/metadata.keychain-db"
  check "write: the login keychain can be saved (temp file + rename), as a token refresh needs" "sbx /bin/sh -c 'echo new > \"\$1.sb-c97cfa2e-AbC123\" && /bin/mv \"\$1.sb-c97cfa2e-AbC123\" \"\$1\"' _ '$FAKE_HOME/Library/Keychains/login.keychain-db' && [ \"\$(cat '$FAKE_HOME/Library/Keychains/login.keychain-db')\" = new ]"
  check "write: nothing else in ~/Library/Keychains is writable" "! planted '$FAKE_HOME/Library/Keychains/metadata.keychain-db' && ! planted '$FAKE_HOME/Library/Keychains/planted.keychain-db' && ! planted '$FAKE_HOME/Library/Keychains/login.keychain-db.evil'"
  check "write: the agent TMPDIR stays writable" "planted '$AGENT_TMP/scratch'"
  check "write: the agent's own claude config dir stays writable" "planted '$AGENT_CLAUDE_DIR/.claude.json'"
  check "write: /dev/null stays writable" "sbx /bin/sh -c 'echo x > /dev/null'"
  # Chrome puts its ProcessSingleton lock in the per-user temp dir whatever
  # TMPDIR says; only its own com.google.Chrome.* / org.chromium.Chromium.* dirs
  # there are writable, not the shared directory other apps use.
  DTMP="$(getconf DARWIN_USER_TEMP_DIR 2>/dev/null)"; DTMP="${DTMP%/}"
  if [ -n "$DTMP" ] && [ -d "$DTMP" ]; then
    check "write: Chrome's own temp dir under the per-user temp dir is writable" "sbx /bin/sh -c 'mkdir \"\$1\" && echo x > \"\$1/SingletonLock\"' _ '$DTMP/com.google.Chrome.qa$$' && [ -s '$DTMP/com.google.Chrome.qa$$/SingletonLock' ]"
    check "write: the rest of the per-user temp dir is read-only" "! planted '$DTMP/qa-planted-$$' && ! sbx /bin/mkdir '$DTMP/com.google.Chrome' 2>/dev/null"
    rm -rf "$DTMP/com.google.Chrome.qa$$" "$DTMP/qa-planted-$$"
  else skip "write: per-user temp dir (getconf DARWIN_USER_TEMP_DIR unavailable)"; fi
  # A developer checkout that is itself a linked worktree keeps its config in the main repo.
  LINK_MAIN="$T/link-main"; git init -q "$LINK_MAIN"
  git -C "$LINK_MAIN" -c user.name=qa -c user.email=qa@example.invalid -c commit.gpgsign=false commit -q --allow-empty -m init
  git -C "$LINK_MAIN" worktree add -q "$T/link-wt" 2>/dev/null
  LINK_PROF="$T/agent-link.sb"
  QA_SOURCE_REPO="$T/link-wt" HOME="$FAKE_HOME" qa_sandbox_profile "$LINK_PROF"
  check "dev: a linked-worktree checkout's shared git config is read-only" "! /usr/bin/sandbox-exec -f '$LINK_PROF' /bin/sh -c 'echo x >> \"$LINK_MAIN/.git/config\"' 2>/dev/null"
  # unix sockets: allowed only under the agent's own TMPDIR (Playwright <-> Chromium)
  usock() {  # usock <path>: listen on a unix socket at <path> in the background
    /usr/bin/python3 -c 'import socket,sys,time; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1]); s.listen(1); time.sleep(20)' "$1" &
  }
  uconn() { sbx /usr/bin/python3 -c 'import socket,sys; socket.socket(socket.AF_UNIX).connect(sys.argv[1])' "$1" 2>/dev/null; }
  OUT_SOCK_DIR="$(mktemp -d /tmp/qa-us.XXXXXX)"
  usock "$AGENT_TMP/in.sock"; US1=$!; usock "$OUT_SOCK_DIR/out.sock"; US2=$!; sleep 0.5
  check "sandbox: unix socket under the agent TMPDIR connects (Playwright -> Chromium)" "uconn '$AGENT_TMP/in.sock'"
  check "sandbox: unix sockets elsewhere are refused (docker.sock, ssh-agent, ...)" "! uconn '$OUT_SOCK_DIR/out.sock'"
  kill "$US1" "$US2" 2>/dev/null; rm -rf "$OUT_SOCK_DIR"
  check "F3: direct outbound TCP to the internet is blocked (by IP)" "! sbx /usr/bin/curl --noproxy '*' -s -m 5 -o /dev/null https://1.1.1.1 2>/dev/null"
  check "F3: DNS resolution is blocked (no DNS exfil)" "! sbx /usr/bin/python3 -c 'import socket; socket.gethostbyname(\"qa-sandbox-test.example.org\")' 2>/dev/null"
  check "sandbox: loopback (the QA stack) is reachable" "[ \"\$(sbx /usr/bin/curl --noproxy '*' -s -m 5 http://localhost:$HTTP_PORT/README.md)\" = readme ]"
  check "sandbox: the stack port is reachable as 127.0.0.1 too" "[ \"\$(sbx /usr/bin/curl --noproxy '*' -s -m 5 http://127.0.0.1:$HTTP_PORT/README.md)\" = readme ]"
  check "sandbox: control: the second loopback listener answers outside the sandbox" "[ \"\$(/usr/bin/curl --noproxy '*' -s -m 5 http://127.0.0.1:$HTTP2_PORT/README.md)\" = readme ]"
  check "sandbox: any other loopback service on this Mac is unreachable" "! sbx /usr/bin/curl --noproxy '*' -s -m 5 -o /dev/null http://127.0.0.1:$HTTP2_PORT/README.md 2>/dev/null"
  kill "$HTTP_PID" "$HTTP2_PID" 2>/dev/null; rm -rf "$AGENT_TMP"
else
  skip "Seatbelt cases (needs macOS sandbox-exec and qa_sandbox_profile)"
  type qa_sandbox_profile >/dev/null 2>&1 || bad "qa_sandbox_profile is defined"
fi

# === egress proxy: the sandbox's only way off the machine ======================
PX_LOG="$T/egress.log"; PX_PORT_FILE="$T/egress.port"
# The allowlist is exact names only: a suffix entry would bring matching back.
/usr/bin/python3 "$QA_DIR/egress-proxy.py" --allow .anthropic.com --port-file "$T/sfx.port" --log "$T/sfx.log" >/dev/null 2>&1 &
SFX_PID=$!; sleep 1.5
check "proxy: a suffix ('.domain') allowlist entry is refused at startup" "[ ! -s '$T/sfx.port' ] && ! kill -0 $SFX_PID 2>/dev/null"
kill "$SFX_PID" 2>/dev/null
/usr/bin/python3 "$QA_DIR/egress-proxy.py" --allow 'api.anthropic.com,1.2.3.4' --port-file "$T/ip.port" --log "$T/ip.log" >/dev/null 2>&1 &
IPA_PID=$!; sleep 1.5
check "proxy: an IP-literal allowlist entry is refused at startup" "[ ! -s '$T/ip.port' ] && ! kill -0 $IPA_PID 2>/dev/null"
kill "$IPA_PID" 2>/dev/null
/usr/bin/env python3 "$QA_DIR/egress-proxy.py" --allow api.github.com,api.anthropic.com --port-file "$PX_PORT_FILE" --log "$PX_LOG" &
PROXY_PID=$!
for _ in $(seq 1 30); do [ -s "$PX_PORT_FILE" ] && break; sleep 0.1; done
PX="http://127.0.0.1:$(cat "$PX_PORT_FILE" 2>/dev/null)"
connect_code() {  # connect_code <host:port> -> HTTP status of a raw CONNECT
  /usr/bin/python3 - "$(cat "$PX_PORT_FILE")" "$1" <<'PY'
import socket, sys
s = socket.create_connection(("127.0.0.1", int(sys.argv[1])), timeout=10)
s.sendall(("CONNECT %s HTTP/1.1\r\nHost: %s\r\n\r\n" % (sys.argv[2], sys.argv[2])).encode())
print(s.recv(200).split(b" ")[1].decode())
PY
}
check "proxy: unlisted host is refused" "[ \"\$(connect_code example.com:443)\" = 403 ]"
check "proxy: IP literal is refused" "[ \"\$(connect_code 140.82.112.6:443)\" = 403 ]"
check "proxy: allowlisted host on a non-443 port is refused" "[ \"\$(connect_code api.github.com:80)\" = 403 ]"
check "proxy: look-alike suffix is refused" "[ \"\$(connect_code evilanthropic.com:443)\" = 403 ]"
check "proxy: plain HTTP (non-CONNECT) is refused" "[ \"\$(curl -s -o /dev/null -w '%{http_code}' --proxy '$PX' http://example.com/)\" = 403 ]"
check "proxy: denials are logged" "grep -q 'DENY CONNECT example.com:443 ' '$PX_LOG'"
raw_connect() {  # raw_connect <request-target>: send one CONNECT with an arbitrary target
  /usr/bin/python3 - "$(cat "$PX_PORT_FILE")" "$1" <<'PY'
import socket, sys
s = socket.create_connection(("127.0.0.1", int(sys.argv[1])), timeout=10)
s.sendall(("CONNECT %s HTTP/1.1\r\n\r\n" % sys.argv[2].replace("\\n", "\n").replace("\\t", "\t")).encode())
s.recv(200)
PY
}
raw_connect 'forge\n12:00:00Z\tALLOW\tforged.example:443'
check "proxy: a crafted target cannot forge an audit line" "! grep -q '^12:00:00Z' '$PX_LOG'"
check "proxy: a crafted target is still recorded as one DENY line" "[ \"\$(grep -c 'DENY .*forge' '$PX_LOG')\" = 1 ]"
raw_status() {  # raw_status <authority, python escapes allowed> -> HTTP status of a raw CONNECT
  /usr/bin/python3 -I - "$(cat "$PX_PORT_FILE")" "$1" <<'PY'
import codecs, socket, sys
target = codecs.decode(sys.argv[2], "unicode_escape").encode("latin-1")
s = socket.create_connection(("127.0.0.1", int(sys.argv[1])), timeout=20)
s.sendall(b"CONNECT " + target + b" HTTP/1.1\r\n\r\n")
print(s.recv(200).split(b" ")[1].decode())
PY
}
# Every authority below is refused before any name lookup: only an exact,
# plain [a-z0-9.-] hostname on the list ever reaches getaddrinfo().
for a in 'example.com\x00.anthropic.com:443' 'api.anthropic.com\x00:443' 'api.anthropic.com.:443' \
         'API.anthropic.com\x00x:443' 'api%2eanthropic.com:443' 'api.anthropic.com\t:443' 'api_anthropic.com:443' \
         'sub.api.anthropic.com:443' 'console.anthropic.com:443' 'api.anthropic.com:0443' 'api.anthropic.com:443:443' \
         '0x7f.1:443' '2130706433:443' '127.0.0.1:443' '[::1]:443' 'xn--api.anthropic.com\xe9:443' 'api..anthropic.com:443'; do
  check "proxy: refuses authority '$a'" "[ \"\$(raw_status '$a')\" = 403 ]"
done
check "proxy: a NUL-bearing authority is logged as DENY, never ALLOW" "! grep -q 'ALLOW example.com' '$PX_LOG' && grep -q 'DENY .*example.com' '$PX_LOG'"
# The decision and the dial are pure functions; exercise them without a network.
px_py() { /usr/bin/python3 -I - "$QA_DIR/egress-proxy.py" "$@" <<'PY'
import importlib.util, socket, sys
spec = importlib.util.spec_from_file_location("px", sys.argv[1]); px = importlib.util.module_from_spec(spec); spec.loader.exec_module(px)
allow = px.parse_allowlist("api.anthropic.com,platform.claude.com")
case = sys.argv[2]
if case == "decide-ok":
    assert px.connect_target(b"CONNECT API.Anthropic.COM:443 HTTP/1.1", allow) == "api.anthropic.com"
    assert px.connect_target(b"CONNECT platform.claude.com:443 HTTP/1.0", allow) == "platform.claude.com"
elif case == "decide-no":
    for line in (b"CONNECT example.com\x00.api.anthropic.com:443 HTTP/1.1", b"CONNECT api.anthropic.com:443 HTTP/1.1 ",
                 b"CONNECT  api.anthropic.com:443 HTTP/1.1", b"GET api.anthropic.com:443 HTTP/1.1",
                 b"CONNECT api.anthropic.com:443 HTTP/2", b"CONNECT claude.com:443 HTTP/1.1"):
        assert px.connect_target(line, allow) is None, line
elif case == "dial-public-only":
    seen = []
    def fake(host, port, *a, **k):
        seen.append(host)
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", port)),
                (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.0.0.5", port)),
                (socket.AF_INET6, socket.SOCK_STREAM, 6, "", ("::1", port, 0, 0))]
    try:
        px.dial("api.anthropic.com", resolver=fake)
        raise SystemExit("dialled a non-public address")
    except OSError:
        pass
    assert seen == ["api.anthropic.com"], seen   # the exact validated name, nothing else
elif case == "dial-validates":
    def fake(*a, **k):
        raise SystemExit("resolved an unvalidated name")
    for bad in ("example.com\x00.api.anthropic.com", "api.anthropic.com.", "1.2.3.4"):
        try:
            px.dial(bad, resolver=fake); raise SystemExit("dialled " + repr(bad))
        except OSError:
            pass
PY
}
check "proxy: an exact allowlisted name is accepted, case-insensitively" "px_py decide-ok"
check "proxy: the request line must match the CONNECT grammar byte for byte" "px_py decide-no"
check "proxy: it dials only public addresses resolved for the validated name" "px_py dial-public-only"
check "proxy: dial() refuses a name that is not a plain hostname before resolving it" "px_py dial-validates"
check "wiring: the default egress allowlist is exact hostnames (no '.suffix' entries)" "! printf '%s' \"\$QA_EGRESS_ALLOW\" | tr ',' '\n' | grep -q '^\.'"

# The runner's wiring: the proxy really logs to the protected path, not RUN_DIR.
new_run wiring
start_egress_proxy
WIRED_LOG="$(egress_log_path)"
if [ -n "$EGRESS_PORT" ]; then
  /usr/bin/python3 - "$EGRESS_PORT" <<'PY'
import socket, sys
s = socket.create_connection(("127.0.0.1", int(sys.argv[1])), timeout=10)
s.sendall(b"CONNECT example.com:443 HTTP/1.1\r\n\r\n")
s.recv(200)
PY
fi
stop_egress_proxy
check "audit: the runner's proxy logs to the protected path" "[ -n '$WIRED_LOG' ] && grep -q 'DENY CONNECT example.com:443 ' '$WIRED_LOG'"
check "audit: the runner's proxy writes no log into RUN_DIR" "[ ! -e '$RUN_DIR/egress.log' ]"
check "audit: the tool rules also deny Edit on the run's logs" "grep -qF 'Edit(/\$RUN_DIR/*.log)' '$QA_DIR/scheduled-ui-sweep.sh' && grep -qF 'Edit(/\$RUN_DIR/*.err)' '$QA_DIR/scheduled-ui-sweep.sh' && grep -qF 'Edit(/\$RUN_DIR/transcript*)' '$QA_DIR/scheduled-ui-sweep.sh'"

if [ "${QA_TEST_NETWORK:-0}" = 1 ]; then
  check "proxy: allowlisted host tunnels" "curl -s -m 15 -o /dev/null --proxy '$PX' https://api.github.com/zen"
else
  skip "proxy live CONNECT (set QA_TEST_NETWORK=1)"
fi

# === gh broker: the agent's only GitHub reader, pinned to QA_REPO ============
# A fake gh that prints the argv it was given, one per line.
mkdir -p "$T/ghb"
cat > "$T/ghb/gh" <<'GH'
#!/bin/sh
for a in "$@"; do printf '[%s]\n' "$a"; done
GH
chmod +x "$T/ghb/gh"
GHB_PORT_FILE="$T/ghb.port"; GHB_LOG="$T/ghb.log"
/usr/bin/python3 "$QA_DIR/gh-broker.py" --repo LanternOps/breeze --gh "$T/ghb/gh" --port-file "$GHB_PORT_FILE" --log "$GHB_LOG" &
GHB_PID=$!
for _ in $(seq 1 30); do [ -s "$GHB_PORT_FILE" ] && break; sleep 0.1; done
qgh() { QA_GH_PORT="$(cat "$GHB_PORT_FILE")" "$QA_DIR/qa-gh" "$@" 2>&1; }
refused() { case "$(qgh "$@")" in *"qa-gh: refused"*) return 0 ;; *) return 1 ;; esac; }
out="$(qgh issue list --label qa-sweep --state open --json number,title)"
check "broker: an allowed read runs" "printf '%s' \"\$out\" | grep -qxF '[list]'"
check "broker: every call is pinned to the runner's repo" "printf '%s' \"\$out\" | tr '\n' ' ' | grep -qF '[--repo] [LanternOps/breeze]'"
out="$(qgh pr diff 11533 --name-only)"
check "broker: pr diff by bare number runs, pinned" "printf '%s' \"\$out\" | tr '\n' ' ' | grep -qF '[pr] [diff] [11533] [--name-only] [--repo] [LanternOps/breeze]'"
check "broker: -R other/repo is refused" "refused issue list -R octo/private"
check "broker: --repo other/repo is refused" "refused pr view 1 --repo octo/private"
check "broker: --repo=other/repo is refused" "refused pr view 1 --repo=octo/private"
check "broker: an issue URL of another repo is refused" "refused issue view https://github.com/octo/private/issues/1"
check "broker: OWNER/REPO#N is refused" "refused issue view octo/private#1"
check "broker: a branch name for pr view is refused" "refused pr view octo:main"
check "broker: a repo: search qualifier is refused (GitHub ORs repeated scopes)" "refused issue list --search 'repo:octo/private secret'"
check "broker: an org: search qualifier is refused" "refused pr list -S 'is:open org:octo'"
check "broker: a negated/parenthesised scope qualifier is refused" "refused issue list --search 'x (user:octo)'"
# No free-text query reaches gh at all: search text shares one query string
# with gh's own repo: qualifier, so it is removed, not screened.
check "broker: --search is gone, even a plain term" "refused issue list --search 'devices page 500'"
check "broker: a boolean search cannot widen the pin" "refused pr list -S 'is:open OR is:open' && refused issue list --search=is:open\ OR\ is:closed"
check "broker: --author is gone (a search qualifier in pr list)" "refused issue list --author octo && refused pr list -A octo"
check "broker: --base is gone (a search qualifier in pr list)" "refused pr list --base main && refused pr list -B main"
check "broker: labels come from a fixed list" "refused issue list --label bug && refused pr list -l 'qa-sweep repo:octo/private'"
check "broker: an allowlisted label works" "qgh issue list --label qa-sweep --state open | tr '\n' ' ' | grep -qF '[--label] [qa-sweep]'"
check "broker: --json takes known field names only" "refused issue list --json number,notAField && refused pr view 1 --json 'title,body '"
check "broker: --json with known fields works" "qgh pr view 7 --json number,title,files | grep -qxF '[number,title,files]'"
check "broker: issue state is typed per command (no 'merged' issues)" "refused issue list --state merged && qgh pr list --state merged | grep -qxF '[merged]'"
check "broker: gh api is refused" "refused api repos/octo/private/contents/README.md"
check "broker: write verbs are refused" "refused issue comment 1 --body hi && refused pr merge 1 && refused issue create --title x --body y"
check "broker: --jq is refused (gh's jq can read the broker's environment)" "refused issue list --jq '\$ENV'"
check "broker: --template is refused" "refused pr view 1 --template '{{.}}'"
check "broker: --web is refused" "refused pr view 1 --web"
check "broker: --hostname is refused" "refused issue list --hostname ghe.example"
check "broker: a second positional is refused" "refused pr view 1 2"
check "broker: an unknown flag is refused" "refused issue list --foo bar"
check "broker: --limit is bounded" "refused issue list --limit 100000"
check "broker: control characters are refused" "refused issue list --label \"\$(printf 'qa-sweep\nb')\""
check "broker: refusals are audit-logged" "grep -q '^[0-9:Z]* DENY .*octo/private' '$GHB_LOG'"
check "broker: allowed calls are audit-logged with the pinned repo" "grep -q 'ALLOW issue list .*--repo LanternOps/breeze' '$GHB_LOG'"
check "broker: qa-gh without QA_GH_PORT fails closed" "! env -u QA_GH_PORT '$QA_DIR/qa-gh' issue list >/dev/null 2>&1"
kill "$GHB_PID" 2>/dev/null

# The runner's wiring: GitHub is reachable only through the broker.
check "wiring: GitHub is not on the egress allowlist" "! printf '%s' \"\$QA_EGRESS_ALLOW\" | grep -qi github"
ALLOW_BLOCK="$(awk '/^ALLOWED_TOOLS=\(/{f=1} f{print} f&&/^\)/{exit}' "$QA_DIR/scheduled-ui-sweep.sh")"
check "wiring: the agent's only Bash allow rule is qa-gh" "[ \"\$(printf '%s\n' \"\$ALLOW_BLOCK\" | grep -o '\"Bash(' | wc -l | tr -d ' ')\" = 1 ] && printf '%s' \"\$ALLOW_BLOCK\" | grep -qF '\"Bash(\$SCRIPT_DIR/qa-gh:*)\"'"
check "wiring: plain gh is explicitly denied to the agent" "grep -qF '\"Bash(gh:*)\"' '$QA_DIR/scheduled-ui-sweep.sh'"
check "wiring: the runner snapshots open issues before the agent and denies Edit on it" "grep -q '^snapshot_open_issues' '$QA_DIR/scheduled-ui-sweep.sh' && grep -qF 'Edit(/\$RUN_DIR/open-issues.tsv)' '$QA_DIR/scheduled-ui-sweep.sh'"
check "wiring: the skill's scheduled mode no longer tells the agent to search" "! awk '/^## Scheduled mode/{f=1} /^## Logging format/{f=0} f' '$QA_DIR/../../.claude/skills/ui-qa-sweep/SKILL.md' | grep -q -- 'list[^.]*--search'"
check "wiring: the installer ships the broker and its client" "grep -q 'gh-broker.py' '$QA_DIR/install-schedule.sh' && grep -q '/qa-gh\"' '$QA_DIR/install-schedule.sh'"

# === outbox: agent text is published as inert plain text ======================
# Capability removed, not parsed: every agent-written body goes out inside a
# fenced code block it cannot close (the fence is longer than any backtick run
# in the text). GitHub renders no link, autolink, mention, reference, entity or
# HTML inside a code block, so how a URL or host is spelled no longer matters.
# The only live references are #N numbers the runner lists outside the fence.
Z=$'\xe2\x80\x8d'
f_is() {  # f_is <name> <input> <expected>
  local got
  printf '%s' "$2" > "$T/fence.md"
  fence_text "$T/fence.md" || { bad "fence: $1 (helper failed)"; return; }
  got="$(cat "$T/fence.md"; printf x)"; got="${got%x}"
  if [ "$got" = "$3" ]; then ok "fence: $1"; else bad "fence: $1 (got: $got)"; fi
}
QA_REPO="LanternOps/breeze"
f_is "plain text is fenced"        'Devices page returns 500.'  $'```text\nDevices page returns 500.\n```\n'
f_is "a mention is fenced (and its @ defused as a second layer)" 'hi @octocat' $'```text\nhi @'"$Z"$'octocat\n```\n'
f_is "encoded GitHub host stays inside the fence, scheme defanged" 'https://github%2ecom/evil/private' $'```text\nhttps[:]//github%2ecom/evil/private\n```\n'
f_is "every scheme and www. host is defanged (no exceptions)" 'see http://localhost:3000/x, WWW.evil.com, ftp://h, https://github.com/LanternOps/breeze/issues/1' \
  $'```text\nsee http[:]//localhost:3000/x, WWW[.]evil.com, ftp[:]//h, https[:]//github.com/LanternOps/breeze/issues/1\n```\n'
f_is "a triple-backtick run cannot close a longer fence" $'a\n```\n@x' $'````text\na\n```\n@'"$Z"$'x\n````\n'
f_is "the fence outgrows the longest run anywhere" 'x `````` y' $'```````text\nx `````` y\n```````\n'
f_is "own-repo #N are listed by the runner outside the fence" $'Regressed by #100 (#101), see #100.\nC# 12, issue # 4, octo/private#9' \
  $'```text\nRegressed by #100 (#101), see #100.\nC# 12, issue # 4, octo/private#9\n```\n\nRelated: #100 #101\n'
check "fence: an unreadable file fails closed" "! fence_text '$T/does-not-exist.md'"
printf 'a\377b `` @x' > "$T/fence.md"
check "fence: invalid UTF-8 is handled byte-wise" "fence_text '$T/fence.md' && [ \"\$(head -1 '$T/fence.md')\" = '\`\`\`text' ]"

# Titles are plain text with the reference/markup characters removed.
t_is() { local got; got="$(safe_title "$2")"; if [ "$got" = "$3" ]; then ok "title: $1"; else bad "title: $1 (got: $got)"; fi; }
t_is "mention, ref, entity, HTML and code characters are dropped" '[UI] cc @octo octo/private#3 &#64;x <b>`y`\' '[UI] cc octo octo/private3 64;x by'
t_is "a scheme separator is defanged" '[QA] see https://evil.example/x' '[QA] see https[:]//evil.example/x'
t_is "non-ASCII and control characters are dropped" $'[UI] caf\xc3\xa9 \xe2\x80\x8bok\tz' '[UI] caf ok z'
t_is "an ordinary title is untouched" '[UI] Devices page 500s on save (Settings/Users), 2 rows' '[UI] Devices page 500s on save (Settings/Users), 2 rows'

new_run fenced
QA_COMMENTABLE=" 555 "; IN_SCOPE=" 100 "
outbox 001.json '{"action":"create","title":"[UI] marker-n1 cc @title-user","body":"cc @body-user see https://github%2ecom/evil/private and [x](/octo/private)"}'
outbox 002.json "{\"action\":\"comment\",\"issue\":555,\"body\":$(json_str 'ping.@comment-user and &#64;entity-user, octo/private#1')}"
outbox 003.json '{"action":"pr_result","pr":100,"result":"PASS","body":"x-@pr-user, regressed by #77"}'
printf 'ledger row for @ledger-user\n' > "$RUN_DIR/ledger.md"
publish_outbox >/dev/null 2>&1
check "outbox: links, mentions and cross-repo text no longer block a report" "grep -q 'marker-n1' '$GH_LOG' && grep -q 'issue comment 555' '$GH_LOG' && grep -q 'pr comment 100' '$GH_LOG' && grep -q 'issue edit\|QA sweep ledger' '$GH_LOG'"
check "outbox: the title reaches gh without the @" "grep -qF 'issue create --title [UI] marker-n1 cc title-user ' '$GH_LOG'"
check "outbox: every published body carries its agent text inside a fence" "[ \"\$(grep -c '^\`\`\`text\$' '$GH_LOG.bodies')\" = 4 ]"
for u in body comment pr ledger; do
  check "outbox: the $u text sits inside the fence" "awk '/^\`\`\`text\$/{f=1;next} /^\`\`\`\$/{f=0} !f && /$u-user/{bad=1} END{exit bad}' '$GH_LOG.bodies' && grep -q '$u-user' '$GH_LOG.bodies'"
done
check "outbox: the PR header is the only runner text above the fence" "grep -q '^### Scheduled UI QA: PASS' '$GH_LOG.bodies'"
check "outbox: the runner lists #77 outside the fence" "grep -qx 'Related: #77' '$GH_LOG.bodies'"
new_run fence-fail
QA_COMMENTABLE=" "; IN_SCOPE=" "
outbox 001.json '{"action":"create","title":"[UI] marker-ff1 report","body":"plain"}'
printf 'ledger row\n' > "$RUN_DIR/ledger.md"
( fence_text() { return 1; }; publish_outbox >/dev/null 2>&1 )
check "outbox: nothing publishes if fencing fails" "! grep -q 'issue create\|issue edit' '$GH_LOG'"
new_run title-empty
QA_COMMENTABLE=" "; IN_SCOPE=" "
outbox 001.json '{"action":"create","title":"[UI] @@@@@@##","body":"plain"}'
publish_outbox >/dev/null 2>&1
check "outbox: a title that is empty once cleaned is rejected" "! grep -q 'issue create' '$GH_LOG' && grep -q 'REJECT 001.json' '$T/runner.log'"

# Live proof against GitHub's own renderer (gfm mode, repo context = mentions
# and references are processed exactly as in an issue). Opt-in: needs gh auth.
if [ "${QA_TEST_GITHUB:-0}" = 1 ]; then
  render_dead() {  # render_dead <payload>: fenced payload renders with no link and no mention
    local html
    printf '%s' "$1" > "$T/live.md"; fence_text "$T/live.md" || return 1
    # Strip the runner's own Related line: it is meant to link.
    sed -i.bak '/^Related: /d' "$T/live.md"
    html="$(jq -Rs '{text: ., mode: "gfm", context: "LanternOps/breeze"}' < "$T/live.md" | "$REAL_GH" api markdown --input - 2>/dev/null)" || return 1
    case "$html" in *"<a "*|*"user-mention"*|*"issue-link"*|*"<img"*) return 1 ;; esac
    case "$html" in *"<pre"*) return 0 ;; *) return 1 ;; esac
  }
  for p in 'hi @octocat' 'https://github%2ecom/evil/private' 'https://git%68ub.com/x/y' '[x](/octo/private)' \
           '<a href="/octo/private">x</a>' 'www.evil.com' '<https://evil.com>' 'mail a@b.com' 'see octo/private#12' \
           '&#64;octocat' $'[x]: //evil.com\n[x]' $'```\n@octocat\n```' $'   ```\n@octocat' $'~~~\n@octocat' \
           $'````\r@octocat' $'```   \n@octocat' $'\t```\n@octocat' $'</pre>@octocat' $'x\n```\n\n- @octocat' '#123 :smile:'; do
    check "live: GitHub renders the fenced payload with no link or mention: $(printf '%q' "$p")" "render_dead \"\$p\""
  done
  # Control: the probe can fail. Unfenced, the same text renders live.
  render_raw() { jq -Rns --arg t "$1" '{text: $t, mode: "gfm", context: "LanternOps/breeze"}' | "$REAL_GH" api markdown --input - 2>/dev/null; }
  check "live: control: an unfenced mention renders as a mention" "render_raw 'hi @octocat' | grep -q 'user-mention'"
  check "live: control: an unfenced relative link renders as a link" "render_raw '[x](/octo/private)' | grep -q '<a '"
  check "live: control: the runner's Related line stays a live reference" "printf 'see #1\n' > '$T/rel.md' && fence_text '$T/rel.md' && jq -Rs '{text: ., mode: \"gfm\", context: \"LanternOps/breeze\"}' < '$T/rel.md' | \"\$REAL_GH\" api markdown --input - | grep -q 'issue-link'"
else
  skip "live GitHub render of fenced payloads (set QA_TEST_GITHUB=1)"
fi

# === QA stack egress: internal-only network (needs Docker) ====================
if [ "${QA_TEST_DOCKER:-0}" = 1 ] && docker info >/dev/null 2>&1; then
  DP="qa-iso-test-$$"; DNET="$DP-ext"
  docker network create "$DNET" >/dev/null
  dctr() {  # dctr <service> <image> [cmd...]: a container labelled as part of compose project $DP
    local svc="$1" img="$2"; shift 2
    docker run -d --name "$DP-$svc" --network "$DNET" --network-alias "$svc" \
      --label "com.docker.compose.project=$DP" --label "com.docker.compose.service=$svc" "$img" "$@" >/dev/null
  }
  dctr api node:24-alpine node -e 'require("http").createServer((q,r)=>r.end("api-ok")).listen(3001)'
  dctr caddy nginx:alpine
  docker run -d --name "$DP-caddy2" --network "$DNET" -p 127.0.0.1:0:80 nginx:alpine >/dev/null   # unrelated container: untouched
  sleep 2
  new_run docker
  check "stack: control: before isolation the probe sees the internet" "! stack_isolation_check '$DP' api caddy"
  check "stack: control: the check names what it found" "grep -q 'api-resolves-external-dns\|api-reaches-internet' '$T/runner.log'"
  isolate_stack "$DP" caddy
  check "stack: isolation passes its own check" "stack_isolation_check '$DP' api caddy"
  check "stack: api is only on the internal network" "[ \"\$(docker inspect -f '{{range \$k,\$v := .NetworkSettings.Networks}}{{\$k}} {{end}}' $DP-api)\" = '$DP-qa-noegress ' ]"
  check "stack: the edge keeps reaching api by service name" "docker exec $DP-caddy wget -qO- -T 5 http://api:3001 | grep -q api-ok"
  check "stack: api cannot reach the internet" "! docker exec $DP-api node -e 'const s=require(\"net\").connect(443,\"1.1.1.1\");s.on(\"connect\",()=>process.exit(0));s.on(\"error\",()=>process.exit(1));setTimeout(()=>process.exit(1),5000)'"
  check "stack: isolation is idempotent (hosted-phase re-run)" "isolate_stack '$DP' caddy && stack_isolation_check '$DP' api caddy"
  check "stack: other projects' containers are untouched" "docker inspect -f '{{range \$k,\$v := .NetworkSettings.Networks}}{{\$k}} {{end}}' $DP-caddy2 | grep -qx '$DNET '"
  # a recreated service comes back on the project network: the check must catch it
  docker network connect "$DNET" "$DP-api"
  check "stack: a service back on an egress network fails the check" "! stack_isolation_check '$DP' api caddy"
  docker rm -f "$DP-api" "$DP-caddy" "$DP-caddy2" >/dev/null 2>&1
  remove_stack_net; docker network rm "$DNET" >/dev/null 2>&1
  check "stack: the internal network is removed at teardown" "! docker network inspect '$DP-qa-noegress' >/dev/null 2>&1"
else
  skip "QA stack network isolation (set QA_TEST_DOCKER=1 with Docker running)"
fi

# === end-to-end sandbox self-check (real proxy, broker, sandbox) ==============
if [ "${QA_TEST_NETWORK:-0}" = 1 ] && [ -x /usr/bin/sandbox-exec ]; then
  new_run selfcheck
  RUN_DIR="$QA_HOME/runs/$RUN_ID"; mkdir -p "$RUN_DIR"
  QA_WORKTREE="$QA_HOME/worktree"; QA_SOURCE_REPO="$T/source-repo"; mkdir -p "$QA_WORKTREE"
  STACK_ENV_DIR="$QA_HOME/.stack-env"; STATE="$QA_HOME/state.json"; AGENT_TMP="$QA_HOME/.t"
  mkdir -p "$STACK_ENV_DIR" "$AGENT_TMP"; echo '{}' > "$STATE"; echo 'v' > "$ENVVALS"
  AGENT_CLAUDE_DIR="$QA_HOME/.claude-agent"; mkdir -p "$AGENT_CLAUDE_DIR"
  printf 'x\n' > "$RUN_DIR/commits.tsv"; echo readme > "$QA_WORKTREE/README.md"
  /usr/bin/python3 -m http.server 0 --bind 127.0.0.1 --directory "$QA_WORKTREE" > "$T/http3.log" 2>&1 &
  H3=$!; sleep 1; QA_STACK_PORT="$(lsof -nP -a -p "$H3" -iTCP -sTCP:LISTEN 2>/dev/null | awk 'NR==2{n=split($9,a,":");print a[n]}')"
  QA_GH_BIN="$T/ghb/gh" start_gh_broker && start_egress_proxy
  AGENT_PROFILE="$T/selfcheck.sb"
  qa_sandbox_profile "$AGENT_PROFILE"
  check "selfcheck: the real sandbox + proxy + broker pass the runner's self-check" "sandbox_selfcheck"
  grep 'selfcheck' "$T/runner.log" | tail -1
  # A profile that lets the agent reach any loopback port must fail it.
  sed 's/(remote ip "localhost:[0-9]*")/(remote ip "localhost:*")/' "$AGENT_PROFILE" > "$T/loose.sb"; AGENT_PROFILE="$T/loose.sb"
  check "selfcheck: a loopback-wide profile is caught" "! sandbox_selfcheck && grep -q 'other-loopback-port-open' '$T/runner.log'"
  # A profile whose writes are a deny-list again (no default deny) must fail it:
  # every writable PATH directory and the home directory are probed.
  sed '/^(deny file-write\*)$/d' "$T/selfcheck.sb" > "$T/denylist.sb"; AGENT_PROFILE="$T/denylist.sb"; : > "$T/runner.log"
  check "selfcheck: control: the deny-list profile really lost its default deny" "! grep -qx '(deny file-write\*)' '$T/denylist.sb' && grep -qx '(deny file-write\*)' '$T/selfcheck.sb'"
  check "selfcheck: a deny-list write profile is caught (PATH dir + home writable)" "! sandbox_selfcheck && grep -q 'path-dir-writable' '$T/runner.log' && grep -q 'home-writable' '$T/runner.log'"
  # Strix r8: a profile that names stores but has no default read deny under the
  # home directory (the round-7 shape) must fail it.
  RHOME="$(cd "$HOME" && pwd -P)"
  sed "s|^(deny file-read-data (subpath \"$RHOME\") |(deny file-read-data |" "$T/selfcheck.sb" > "$T/readlist.sb"; AGENT_PROFILE="$T/readlist.sb"; : > "$T/runner.log"
  check "selfcheck: control: the read-list profile really lost its home default deny" "grep -q '^(deny file-read-data (subpath \"$RHOME\") ' '$T/selfcheck.sb' && ! grep -q '^(deny file-read-data (subpath \"$RHOME\") ' '$T/readlist.sb'"
  check "selfcheck: a profile without the home read default-deny is caught" "! sandbox_selfcheck && grep -q 'home-readable' '$T/runner.log' && grep -q 'home-store-readable' '$T/runner.log'"
  grep -o 'readable from inside:.*' "$T/runner.log" | cut -c1-300
  check "selfcheck: its probes leave nothing behind" "[ -z \"\$(ls -a \"\$HOME\" | grep -F .qa-sandbox-)\" ] && [ -z \"\$(ls -a '$T/bin' | grep -F .qa-sandbox-probe)\" ]"
  stop_egress_proxy; stop_gh_broker; kill "$H3" 2>/dev/null
else
  skip "end-to-end sandbox self-check (set QA_TEST_NETWORK=1, macOS)"
fi

# === the real login keychain accepts a save from inside the sandbox ===========
# Opt-in: adds a dummy generic-password item to the developer's login keychain
# from inside the profile, then deletes it from outside.
if [ "${QA_TEST_KEYCHAIN:-0}" = 1 ] && [ -x /usr/bin/sandbox-exec ] && [ -n "${AGENT_PROFILE:-}" ] && [ -f "$T/selfcheck.sb" ]; then
  KSVC="breeze-qa-sandbox-probe-$$"
  /usr/bin/sandbox-exec -f "$T/selfcheck.sb" /usr/bin/security add-generic-password -s "$KSVC" -a probe -w dummy-not-a-secret -U >/dev/null 2>&1
  check "keychain: a sandboxed process can save to the login keychain (token refresh)" "/usr/bin/security find-generic-password -s '$KSVC' -a probe >/dev/null 2>&1"
  /usr/bin/security delete-generic-password -s "$KSVC" -a probe >/dev/null 2>&1
  check "keychain: the probe item is removed" "! /usr/bin/security find-generic-password -s '$KSVC' -a probe >/dev/null 2>&1"
else
  skip "login keychain save from inside the sandbox (set QA_TEST_KEYCHAIN=1 with QA_TEST_NETWORK=1, macOS)"
fi

# === agent + MCP launch wiring ================================================
if type build_agent_cmd >/dev/null 2>&1; then
  new_run cmd
  AGENT_PROFILE="$T/agent.sb"; EGRESS_PORT=4321; GH_BROKER_PORT=9876; AGENT_TMP="$QA_HOME/.t"; AGENT_CLAUDE_DIR="$QA_HOME/.claude-agent"
  build_agent_cmd claude -p hi
  joined="${AGENT_CMD[*]}"
  check "launch: agent runs under sandbox-exec with the generated profile" "[ \"\${AGENT_CMD[0]}\" = /usr/bin/sandbox-exec ] && [ \"\${AGENT_CMD[1]}\" = -f ] && [ \"\${AGENT_CMD[2]}\" = '$AGENT_PROFILE' ]"
  check "launch: proxy env points at the loopback egress proxy" "case \"\$joined\" in *HTTPS_PROXY=http://127.0.0.1:4321*) true;; *) false;; esac"
  check "launch: ssh-agent socket is not inherited" "case \"\$joined\" in *'-u SSH_AUTH_SOCK'*) true;; *) false;; esac"
  check "launch: agent gets its own TMPDIR" "case \"\$joined\" in *\"TMPDIR=\$QA_HOME/.t\"*) true;; *) false;; esac"
  check "launch: agent gets a throwaway claude config dir, not ~/.claude" "case \"\$joined\" in *\"CLAUDE_CONFIG_DIR=\$QA_HOME/.claude-agent \"*) true;; *) false;; esac"
  check "launch: claude's own temp files stay in the agent TMPDIR (not /tmp/claude-UID)" "case \"\$joined\" in *\"CLAUDE_CODE_TMPDIR=\$QA_HOME/.t \"*) true;; *) false;; esac"
  check "launch: zsh heredoc temp files stay in the agent TMPDIR" "case \"\$joined\" in *\"TMPPREFIX=\$QA_HOME/.t/zsh \"*) true;; *) false;; esac"
  check "launch: Playwright's browser registry is the agent's own, not ~/Library/Caches/ms-playwright/b" "case \"\$joined\" in *\"PWTEST_SERVER_REGISTRY=\$QA_HOME/.t/pw-registry \"*) true;; *) false;; esac"
  check "launch: the agent gets the broker port, and no GitHub token from the runner's env" "case \"\$joined\" in *'QA_GH_PORT=9876'*'-u GH_TOKEN'*|*'-u GH_TOKEN'*'QA_GH_PORT=9876'*) true;; *) false;; esac"
  check "launch: the agent command follows the wrapper" "[ \"\${AGENT_CMD[\${#AGENT_CMD[@]}-3]}\" = claude ]"
else
  bad "build_agent_cmd is defined"
fi
if type build_mcp_config >/dev/null 2>&1; then
  new_run mcp
  build_mcp_config "http://localhost:55001" "$QA_DIR/qa-mcp.json" "$RUN_DIR/mcp.json"
  # Strix r7: npm/npx need a writable cache, and a writable ~/.npm/_npx is a planted
  # package. The runner installs the pinned server; the sandbox only runs node on it.
  check "launch: no npm or npx runs inside the sandbox" "! jq -r '.mcpServers.playwright | [.command] + .args | .[]' '$RUN_DIR/mcp.json' | grep -qE '(^|/)(npx|npm)$|^-y$|^@playwright/mcp@'"
  check "launch: MCP server is node on the runner's pinned install" "jq -e --arg c '$(mcp_cli_path)' '.mcpServers.playwright.args | index(\$c)' '$RUN_DIR/mcp.json' >/dev/null && [ \"\$(jq -r '.mcpServers.playwright.args[2]' '$RUN_DIR/mcp.json')\" = \"\$(command -v node)\" ]"
  check "launch: the pinned install lives under QA_HOME, outside every writable root" "case '$(mcp_cli_path)' in '$QA_HOME'/mcp/*) true;; *) false;; esac"
  # prewarm_mcp: a fake npm records its argv and installs whatever version it is told.
  mkdir -p "$T/npmbin"
  cat > "$T/npmbin/npm" <<'NPM'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$NPM_LOG"
[ "${FAKE_NPM_FAIL:-0}" = 1 ] && exit 1
prefix=""; prev=""; for a in "$@"; do [ "$prev" = --prefix ] && prefix="$a"; prev="$a"; done
mkdir -p "$prefix/node_modules/@playwright/mcp"; echo '// cli' > "$prefix/node_modules/@playwright/mcp/cli.js"
printf '{"name":"@playwright/mcp","version":"%s"}\n' "${FAKE_NPM_VERSION:-0.0.84}" > "$prefix/node_modules/@playwright/mcp/package.json"
NPM
  chmod +x "$T/npmbin/npm"; export NPM_LOG="$T/npm.log"; : > "$NPM_LOG"
  check "prewarm: installs the pinned package into the runner's own prefix" "PATH='$T/npmbin':\"\$PATH\" prewarm_mcp '$QA_DIR/qa-mcp.json' && [ -f '$(mcp_cli_path)' ] && grep -q -- '--prefix $QA_HOME/mcp' '$NPM_LOG' && grep -q '@playwright/mcp@0.0.84' '$NPM_LOG'"
  check "prewarm: package install scripts do not run" "grep -q -- '--ignore-scripts' '$NPM_LOG'"
  check "prewarm: a failed refresh keeps a verified install" "FAKE_NPM_FAIL=1 PATH='$T/npmbin':\"\$PATH\" prewarm_mcp '$QA_DIR/qa-mcp.json'"
  check "prewarm: an install of any other version is refused" "! FAKE_NPM_VERSION=9.9.9 PATH='$T/npmbin':\"\$PATH\" prewarm_mcp '$QA_DIR/qa-mcp.json'"
  rm -rf "$QA_HOME/mcp"
  check "prewarm: no install at all fails closed" "! FAKE_NPM_FAIL=1 PATH='$T/npmbin':\"\$PATH\" prewarm_mcp '$QA_DIR/qa-mcp.json'"
  check "launch: Chrome runs without its own renderer sandbox (it cannot nest in Seatbelt)" "jq -e '.mcpServers.playwright.args | index(\"--no-sandbox\")' '$RUN_DIR/mcp.json' >/dev/null"
  check "launch: MCP keeps --allowed-origins as navigation hygiene" "jq -e '.mcpServers.playwright.args | index(\"--allowed-origins\")' '$RUN_DIR/mcp.json' >/dev/null"
  check "launch: MCP cwd is RUN_DIR/browser" "jq -e --arg d '$RUN_DIR/browser' '.mcpServers.playwright.args | index(\$d)' '$RUN_DIR/mcp.json' >/dev/null"
else
  bad "build_mcp_config is defined"
fi

echo
echo "pass=$PASS fail=$FAIL skip=$SKIP"
[ "$FAIL" = 0 ]
