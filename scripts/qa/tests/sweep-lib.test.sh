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
mkdir -p "$T/bin"
GH_LOG="$T/gh.log"; export GH_LOG
cat > "$T/bin/gh" <<'GH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$GH_LOG"
case "$*" in
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
  : > "$GH_LOG"; : > "$T/runner.log"
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
publish_outbox >/dev/null 2>&1
check "gate: AWS key in a title is not published" "! grep -q 'marker-akia' '$GH_LOG'"
check "gate: long token in a title is not published" "! grep -q 'marker-token' '$GH_LOG'"
check "gate: literal .env value in a title is not published" "! grep -q 'marker-env' '$GH_LOG'"
check "gate: a key split across title lines is not published once they are joined" "! grep -q 'marker-split' '$GH_LOG'"
check "gate: a key straddling the 200-char title cut is not half-published" "! grep -q 'marker-cut' '$GH_LOG'"
check "gate: a clean title still publishes" "grep -q 'issue create --title \[UI\] marker-clean' '$GH_LOG'"
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

new_run gate-log
QA_COMMENTABLE=" "; IN_SCOPE=" "
outbox 001.json "{\"action\":\"comment\",\"issue\":$(json_str "marker-issue-$FAKE_AKIA"),\"body\":\"clean body\"}"
outbox 002.json "{\"action\":\"pr_result\",\"pr\":$(json_str "marker-pr-$FAKE_AKIA"),\"result\":\"PASS\",\"body\":\"clean body\"}"
outbox 003.json "{\"action\":$(json_str "marker-action-$FAKE_AKIA"),\"body\":\"clean body\"}"
publish_outbox >/dev/null 2>&1
check "gate: rejected issue/pr/action values stay out of the runner log" "! grep -q 'IOSFODNN7EXAMPLE' '$T/runner.log'"

# === F2/F3: kernel-enforced sandbox for the agent's whole process tree ========
if [ -x /usr/bin/sandbox-exec ] && type qa_sandbox_profile >/dev/null 2>&1; then
  new_run sb
  RUN_DIR="$QA_HOME/runs/$RUN_ID"; mkdir -p "$RUN_DIR/outbox"   # real layout: runs live under QA_HOME
  QA_WORKTREE="$QA_HOME/worktree"; QA_SOURCE_REPO="$T/source-repo"
  STACK_ENV_DIR="$QA_HOME/.stack-env"; STATE="$QA_HOME/state.json"; AGENT_TMP="$QA_HOME/.t"
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
  # A throwaway HOME: the rules below are exercised by really attempting the write.
  FAKE_HOME="$T/fakehome"; mkdir -p "$FAKE_HOME/.config/gh" "$FAKE_HOME/.config/git"
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
  PROF="$T/agent.sb"
  check "sandbox: the profile refuses to build without the stack/proxy/broker ports" "! (QA_STACK_PORT='' HOME='$FAKE_HOME' qa_sandbox_profile '$T/noport.sb')"
  HOME="$FAKE_HOME" qa_sandbox_profile "$PROF"
  sbx() { /usr/bin/sandbox-exec -f "$PROF" "$@"; }
  check "F2: parked stack env is unreadable" "! sbx /bin/cat '$STACK_ENV_DIR/.env' >/dev/null 2>&1"
  check "F2: a .env left in the worktree is unreadable (any tool, not just Read)" "! sbx /bin/cat '$QA_WORKTREE/apps/api/.env.local' >/dev/null 2>&1"
  check "F2: recursive grep of the worktree cannot see .env contents" "! sbx /usr/bin/grep -r SECRET '$QA_WORKTREE' 2>/dev/null | grep -q SECRET"
  check "F2: the developer repo's .env is unreadable" "! sbx /bin/cat '$QA_SOURCE_REPO/.env' >/dev/null 2>&1"
  check "F2: redaction list + machine overrides are unreadable" "! sbx /bin/cat '$ENVVALS' >/dev/null 2>&1 && ! sbx /bin/cat '$QA_HOME/env.overrides' >/dev/null 2>&1"
  check "F2: other runs' container logs are unreadable" "! sbx /bin/cat '$QA_HOME/runs/older/container-api.log' >/dev/null 2>&1"
  check "F2: this run's runner log is unreadable" "! sbx /bin/cat '$RUN_DIR/runner.log' >/dev/null 2>&1"
  mkdir -p "$T/unrelated"; echo 'X=1' > "$T/unrelated/.env"
  check "sandbox: the .env rule is scoped (a .env elsewhere stays readable)" "sbx /bin/cat '$T/unrelated/.env' >/dev/null 2>&1"
  check "sandbox: ordinary worktree files stay readable" "[ \"\$(sbx /bin/cat '$QA_WORKTREE/README.md')\" = readme ]"
  check "sandbox: RUN_DIR's parents can be stat'ed (claude --add-dir / Edit rules resolve it)" "sbx /usr/bin/python3 -c 'import os,sys; os.lstat(os.path.dirname(sys.argv[1])); os.path.realpath(sys.argv[1])' '$RUN_DIR'"
  check "sandbox: RUN_DIR stays writable for the report/outbox" "sbx /bin/sh -c 'echo r > \"$RUN_DIR/report.md\"' && [ -s '$RUN_DIR/report.md' ]"
  check "F1: commits.tsv is not writable from inside" "! sbx /bin/sh -c 'echo x >> \"$RUN_DIR/commits.tsv\"' 2>/dev/null"
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
  kill "$HTTP_PID" "$HTTP2_PID" 2>/dev/null
else
  skip "Seatbelt cases (needs macOS sandbox-exec and qa_sandbox_profile)"
  type qa_sandbox_profile >/dev/null 2>&1 || bad "qa_sandbox_profile is defined"
fi

# === egress proxy: the sandbox's only way off the machine ======================
PX_LOG="$T/egress.log"; PX_PORT_FILE="$T/egress.port"
/usr/bin/env python3 "$QA_DIR/egress-proxy.py" --allow api.github.com,.anthropic.com --port-file "$PX_PORT_FILE" --log "$PX_LOG" &
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
check "proxy: denials are logged" "grep -q 'DENY example.com:443' '$PX_LOG'"
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
check "proxy: a crafted target is still recorded as one DENY line" "[ \"\$(grep -c 'DENY forge' '$PX_LOG')\" = 1 ]"

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
check "audit: the runner's proxy logs to the protected path" "[ -n '$WIRED_LOG' ] && grep -q 'DENY example.com:443' '$WIRED_LOG'"
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
check "broker: gh api is refused" "refused api repos/octo/private/contents/README.md"
check "broker: write verbs are refused" "refused issue comment 1 --body hi && refused pr merge 1 && refused issue create --title x --body y"
check "broker: --jq is refused (gh's jq can read the broker's environment)" "refused issue list --jq '\$ENV'"
check "broker: --template is refused" "refused pr view 1 --template '{{.}}'"
check "broker: --web is refused" "refused pr view 1 --web"
check "broker: --hostname is refused" "refused issue list --hostname ghe.example"
check "broker: a second positional is refused" "refused pr view 1 2"
check "broker: an unknown flag is refused" "refused issue list --foo bar"
check "broker: --limit is bounded" "refused issue list --limit 100000"
check "broker: control characters are refused" "refused issue list --search \"\$(printf 'a\nb')\""
check "broker: a bare search term still works" "qgh issue list --search 'devices page 500' --state open | grep -qxF '[devices page 500]'"
check "broker: refusals are audit-logged" "grep -q '^[0-9:Z]* DENY .*octo/private' '$GHB_LOG'"
check "broker: allowed calls are audit-logged with the pinned repo" "grep -q 'ALLOW issue list .*--repo LanternOps/breeze' '$GHB_LOG'"
check "broker: qa-gh without QA_GH_PORT fails closed" "! env -u QA_GH_PORT '$QA_DIR/qa-gh' issue list >/dev/null 2>&1"
kill "$GHB_PID" 2>/dev/null

# The runner's wiring: GitHub is reachable only through the broker.
check "wiring: GitHub is not on the egress allowlist" "! printf '%s' \"\$QA_EGRESS_ALLOW\" | grep -qi github"
ALLOW_BLOCK="$(awk '/^ALLOWED_TOOLS=\(/{f=1} f{print} f&&/^\)/{exit}' "$QA_DIR/scheduled-ui-sweep.sh")"
check "wiring: the agent's only Bash allow rule is qa-gh" "[ \"\$(printf '%s\n' \"\$ALLOW_BLOCK\" | grep -o '\"Bash(' | wc -l | tr -d ' ')\" = 1 ] && printf '%s' \"\$ALLOW_BLOCK\" | grep -qF '\"Bash(\$SCRIPT_DIR/qa-gh:*)\"'"
check "wiring: plain gh is explicitly denied to the agent" "grep -qF '\"Bash(gh:*)\"' '$QA_DIR/scheduled-ui-sweep.sh'"
check "wiring: the installer ships the broker and its client" "grep -q 'gh-broker.py' '$QA_DIR/install-schedule.sh' && grep -q '/qa-gh\"' '$QA_DIR/install-schedule.sh'"

# === outbox provenance: nothing that names another repository, no mentions ====
new_run refs
QA_COMMENTABLE=" 555 "; IN_SCOPE=" 100 "
outbox 001.json '{"action":"create","title":"[UI] marker-r1 leak","body":"copied from https://github.com/octo/private/blob/main/README.md"}'
outbox 002.json '{"action":"create","title":"[UI] marker-r2 leak","body":"see octo/private#12 for context"}'
outbox 003.json '{"action":"create","title":"[UI] marker-r3 leak","body":"fixed in octo/private@0123456789abcdef"}'
outbox 004.json '{"action":"create","title":"[UI] marker-r4 leak","body":"raw: https://raw.githubusercontent.com/octo/private/main/x"}'
outbox 005.json '{"action":"create","title":"[UI] marker-r5 leak","body":"api: api.github.com/repos/Octo/Private/contents"}'
outbox 006.json '{"action":"create","title":"[UI] marker-r6 ping","body":"cc @someone please look."}'
outbox 007.json '{"action":"create","title":"[UI] marker-r7 ping","body":"cc @LanternOps/core"}'
outbox 008.json '{"action":"create","title":"[UI] marker-r8 octo/private#3","body":"clean"}'
outbox 009.json '{"action":"comment","issue":555,"body":"marker-r9 see https://github.com/octo/private/issues/1"}'
outbox 010.json '{"action":"pr_result","pr":100,"result":"PASS","body":"marker-r10 cf. octo/private#9"}'
outbox 020.json '{"action":"create","title":"[UI] marker-ok1 own refs","body":"Regressed by #100; see https://github.com/LanternOps/breeze/issues/555 and lanternops/breeze#7, LanternOps/breeze@0123456789abcdef."}'
outbox 021.json '{"action":"create","title":"[UI] marker-ok2 code","body":"Mail admin@example.com; package `@playwright/mcp` and\n```\n@media (max-width: 600px) { }\nsee octo/private#1\n```\n@types/node too"}'
publish_outbox >/dev/null 2>&1
for n in 1 2 3 4 5 6 7 8; do
  check "refs: entry $n (another repo / mention) is not published" "! grep -q 'marker-r$n ' '$GH_LOG'"
done
check "refs: a comment naming another repo is not published" "! grep -q 'issue comment 555' '$GH_LOG'"
check "refs: a pr_result naming another repo is not published" "! grep -q 'pr comment 100' '$GH_LOG'"
check "refs: references to this repo (URL, #N, OWNER/REPO#N, @sha) publish" "grep -q 'marker-ok1' '$GH_LOG'"
check "refs: emails, npm scopes and code blocks are not mistaken for mentions/refs" "grep -q 'marker-ok2' '$GH_LOG'"
check "refs: rejections name the file, not the text" "grep -q 'REJECT 001.json: body references another repository' '$T/runner.log' && ! grep -q 'octo' '$T/runner.log'"
new_run refs-ledger
QA_COMMENTABLE=" "; IN_SCOPE=" "
printf 'ledger row, see github.com/octo/private\n' > "$RUN_DIR/ledger.md"
publish_outbox >/dev/null 2>&1
check "refs: a ledger naming another repo is not published" "! grep -q 'issue edit\|QA sweep ledger' '$GH_LOG'"

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
  stop_egress_proxy; stop_gh_broker; kill "$H3" 2>/dev/null
else
  skip "end-to-end sandbox self-check (set QA_TEST_NETWORK=1, macOS)"
fi

# === agent + MCP launch wiring ================================================
if type build_agent_cmd >/dev/null 2>&1; then
  new_run cmd
  AGENT_PROFILE="$T/agent.sb"; EGRESS_PORT=4321; GH_BROKER_PORT=9876; AGENT_TMP="$QA_HOME/.t"
  build_agent_cmd claude -p hi
  joined="${AGENT_CMD[*]}"
  check "launch: agent runs under sandbox-exec with the generated profile" "[ \"\${AGENT_CMD[0]}\" = /usr/bin/sandbox-exec ] && [ \"\${AGENT_CMD[1]}\" = -f ] && [ \"\${AGENT_CMD[2]}\" = '$AGENT_PROFILE' ]"
  check "launch: proxy env points at the loopback egress proxy" "case \"\$joined\" in *HTTPS_PROXY=http://127.0.0.1:4321*) true;; *) false;; esac"
  check "launch: ssh-agent socket is not inherited" "case \"\$joined\" in *'-u SSH_AUTH_SOCK'*) true;; *) false;; esac"
  check "launch: agent gets its own TMPDIR" "case \"\$joined\" in *\"TMPDIR=\$QA_HOME/.t\"*) true;; *) false;; esac"
  check "launch: the agent gets the broker port, and no GitHub token from the runner's env" "case \"\$joined\" in *'QA_GH_PORT=9876'*'-u GH_TOKEN'*|*'-u GH_TOKEN'*'QA_GH_PORT=9876'*) true;; *) false;; esac"
  check "launch: the agent command follows the wrapper" "[ \"\${AGENT_CMD[\${#AGENT_CMD[@]}-3]}\" = claude ]"
else
  bad "build_agent_cmd is defined"
fi
if type build_mcp_config >/dev/null 2>&1; then
  new_run mcp
  build_mcp_config "http://localhost:55001" "$QA_DIR/qa-mcp.json" "$RUN_DIR/mcp.json"
  check "launch: MCP server resolves its package offline (no registry egress)" "jq -r '.mcpServers.playwright.args[1]' '$RUN_DIR/mcp.json' | grep -q 'npm_config_offline=true'"
  check "launch: Chrome runs without its own renderer sandbox (it cannot nest in Seatbelt)" "jq -e '.mcpServers.playwright.args | index(\"--no-sandbox\")' '$RUN_DIR/mcp.json' >/dev/null"
  check "launch: MCP keeps --allowed-origins as navigation hygiene" "jq -e '.mcpServers.playwright.args | index(\"--allowed-origins\")' '$RUN_DIR/mcp.json' >/dev/null"
  check "launch: MCP cwd is RUN_DIR/browser" "jq -e --arg d '$RUN_DIR/browser' '.mcpServers.playwright.args | index(\$d)' '$RUN_DIR/mcp.json' >/dev/null"
else
  bad "build_mcp_config is defined"
fi

echo
echo "pass=$PASS fail=$FAIL skip=$SKIP"
[ "$FAIL" = 0 ]
