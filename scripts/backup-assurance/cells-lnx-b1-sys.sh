#!/usr/bin/env bash
# B1-sys: bare-metal recovery of a system_image snapshot end to end, asserting APPLIED
# state on a fresh Linux target — not just job/recovery status (the D15 regression: a
# prior run reported `completed`/`validated: true` with `stateApplied: false` and
# nothing on the target actually changed). Producer: agent/internal/backup/systemstate/
# state_linux.go. Consumer: agent/internal/backup/bmr/{bmr.go,restore_linux.go}.
# Contract: docs/superpowers/plans/backup/2026-09-09-bmr-system-state-contract.md.
#
#   cells-lnx-b1-sys.sh recover <source-ssh-target> <source-device-id> <target-ssh-target> [server-url]
#   cells-lnx-b1-sys.sh tamper  <source-ssh-target> <source-device-id> <target-ssh-target> [server-url]
#
# recover: positive path — seed distinguishable state on SOURCE, back it up
#   (system_image), verify the system-state/ bucket layout (manifest + per-artifact
#   sha256), mint a BMR token, run `breeze-backup bmr-recover` on TARGET, and assert
#   every seeded item was actually applied plus the exclude list held.
# tamper:  negative path — corrupt one system-state artifact object in the bucket after
#   backup, mint a fresh token (tokens are single-use), run recovery again, and assert
#   it does NOT report completed and the failure names a checksum problem.
#
# Assumes: SOURCE already has the Breeze agent enrolled with a backup policy assigned
# that includes a `system_image` selection — same prerequisite every other cell in this
# harness relies on (see cells-unix.sh calling `$L run "$DEV"` directly with no
# profile/policy provisioning of its own). TARGET is a fresh, unenrolled machine
# reachable by plain `ssh <target-ssh-target>` with the `breeze-backup` binary already
# placed at $TARGET_BMR_BINARY (default /usr/local/bin/breeze-backup) — e.g. by copying
# the recovery bundle built via `lab.sh bmr-media` there ahead of time; this script does
# not build or transfer the bundle itself.
#
# server-url defaults to $LAB_API with the trailing /api/v1 stripped. Override it if
# TARGET cannot route to that host — the bootstrap command embeds the API's configured
# public URL, which is not necessarily reachable from a machine that isn't the Mac
# running the lab stack (see the campaign doc's D9b).
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1
export LAB_API=${LAB_API:-http://localhost:33933/api/v1} LAB_STATE=${LAB_STATE:-$HOME/breeze-assurance/lab-state.json}
L=scripts/backup-assurance/lab.sh
S=${LAB_SCRATCH:?set LAB_SCRATCH to the dir holding vmssh/mc helpers}

MODE=${1:?recover|tamper}
SRC_HOST=${2:?source ssh target}
DEV=${3:?source device id}
TGT_HOST=${4:?target ssh target}
SERVER_URL=${5:-${LAB_API%/api/v1}}
BIN=${TARGET_BMR_BINARY:-/usr/local/bin/breeze-backup}

case "$MODE" in
  recover|tamper) ;;
  *) echo "usage: $0 <recover|tamper> <source-ssh-target> <source-device-id> <target-ssh-target> [server-url]" >&2; exit 2 ;;
esac

TS=$(date -u +%Y%m%dT%H%M%SZ)
R="${LAB_SCRATCH_RUNS:-$HOME/breeze-assurance/runs/lnx}/b1-sys-$TS"
mkdir -p "$R"

FAILS=0
pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*"; FAILS=$((FAILS + 1)); }
say() { echo; echo "### $*"; }
assert_eq() { # desc expected actual
  if [ "$3" = "$2" ]; then pass "$1"; else fail "$1 (want '$2' got '$3')"; fi
}

# SC2029: intentional — callers build these command strings with local
# ($MARKER_CONTENT, $TOKEN, ...) interpolation already applied before the string
# crosses to the remote shell, exactly like the rest of this harness (e.g. cells-gc.sh's
# psql calls).
# shellcheck disable=SC2029
src() { ssh "$SRC_HOST" "$1"; }
# shellcheck disable=SC2029
tgt() { ssh "$TGT_HOST" "$1"; }

MARKER_CONTENT='breeze-bmr-sys-state-assurance-marker'
CRON_LINE='*/7 * * * * /bin/true'
PKG=cowsay

# ---------------------------------------------------------------------------
# 1. Seed distinguishable state on SOURCE
# ---------------------------------------------------------------------------
say "seed: marker file, systemd unit, user crontab, extra package, symlink (SOURCE)"
src "printf '%s\n' '$MARKER_CONTENT' | sudo tee /etc/breeze-assure-marker >/dev/null && sudo chown root:adm /etc/breeze-assure-marker && sudo chmod 0640 /etc/breeze-assure-marker"
src "printf '[Unit]\nDescription=breeze assurance marker unit\n\n[Service]\nType=simple\nExecStart=/bin/true\nRemainAfterExit=yes\n\n[Install]\nWantedBy=multi-user.target\n' | sudo tee /etc/systemd/system/breeze-assure.service >/dev/null && sudo systemctl daemon-reload && sudo systemctl enable breeze-assure.service"
src "id -u assure >/dev/null 2>&1 || sudo useradd -m assure"
src "printf '%s\n' '$CRON_LINE' | sudo crontab -u assure -"
src "sudo apt-get install -y $PKG"
src "sudo ln -sf /etc/hostname /etc/breeze-assure-link"

say "capture pre-backup evidence (SOURCE)"
src "dpkg --get-selections" > "$R/src-dpkg-selections.txt"
src "systemctl list-unit-files --state=enabled" > "$R/src-enabled-units.txt"
src "sudo crontab -u assure -l" > "$R/src-crontab-assure.txt"
src "stat -c '%a %U:%G'  /etc/breeze-assure-marker" > "$R/src-marker-stat.txt"

if grep -q breeze-assure.service "$R/src-enabled-units.txt"; then
  pass "seed: breeze-assure.service enabled on SOURCE"
else
  fail "seed: breeze-assure.service NOT enabled on SOURCE"
fi
if grep -qF "$CRON_LINE" "$R/src-crontab-assure.txt"; then
  pass "seed: assure crontab set on SOURCE"
else
  fail "seed: assure crontab missing on SOURCE"
fi

# ---------------------------------------------------------------------------
# 2. Capture TARGET's pre-recovery baseline for the exclude list
# ---------------------------------------------------------------------------
say "capture TARGET pre-recovery baseline for excluded fields"
tgt "cat /etc/machine-id" > "$R/tgt-pre-machine-id.txt"
tgt "cat /etc/hostname" > "$R/tgt-pre-hostname.txt"
tgt "sudo md5sum /etc/fstab | cut -d' ' -f1" > "$R/tgt-pre-fstab.md5"

# ---------------------------------------------------------------------------
# 3. Drive the system_image backup on SOURCE via the API
# ---------------------------------------------------------------------------
say "run backup on SOURCE, isolate the system_image job"
JOBS_RAW=$($L run "$DEV")
# A manual run creates one job per selection (file + system_image); make sure we see all of
# them even if the run response only echoes the first — pick up every job created since the run.
sleep 3
JOBS_RAW=$( { echo "$JOBS_RAW"; $L api GET "/backup/jobs?deviceId=$DEV&limit=10" | jq -r --arg t "$(date -u -v-2M +%Y-%m-%dT%H:%M:%S 2>/dev/null || date -u -d '-2 min' +%Y-%m-%dT%H:%M:%S)" '(.data // .)[] | select(.createdAt >= $t) | .id'; } | sort -u | tr '\n' ' ')
read -ra JOBS <<< "$JOBS_RAW"
SNAPJOB=""
SNAPLABEL=""
for j in "${JOBS[@]}"; do
  out=$($L wait-job "$j" 1800)
  echo "$out" > "$R/job-$j.json"
  st=$(echo "$out" | jq -r '.status')
  label=$(echo "$out" | jq -r '.snapshotId // empty')
  # The job row carries the JOB type (manual/scheduled), not the backup mode; the
  # snapshot row it produced is what says system_image. Resolve the mode through it.
  ty=""
  for _ in $(seq 1 12); do
    ty=$($L api GET "/backup/snapshots?deviceId=$DEV" | jq -r --arg j "$j" '(.data // .)[] | select(.jobId==$j) | .backupType' | head -1)
    [ -n "$ty" ] && break
    sleep 5
  done
  echo "job $j mode=${ty:-?} status=$st label=${label:-?}"
  if [ "$ty" = system_image ]; then
    SNAPJOB=$j
    SNAPLABEL=$label
  fi
done

if [ -n "$SNAPJOB" ] && [ "$(jq -r .status "$R/job-$SNAPJOB.json")" = completed ]; then
  pass "backup: system_image job $SNAPJOB completed (label $SNAPLABEL)"
else
  fail "backup: no completed system_image job found among: $JOBS_RAW"
fi
if [ -z "$SNAPLABEL" ]; then
  echo "cannot continue without a snapshot label" >&2
  exit 1
fi

SNAPROW=$($L api GET "/backup/snapshots?deviceId=$DEV" | jq -r --arg j "$SNAPJOB" '(.data // .)[] | select(.jobId==$j) | .id' | head -1)
if [ -n "$SNAPROW" ]; then
  pass "backup: snapshot row id resolved ($SNAPROW)"
else
  fail "backup: could not resolve snapshot row id"
  exit 1
fi

# ---------------------------------------------------------------------------
# 4. Assert the system-state/ object layout in the bucket
# ---------------------------------------------------------------------------
say "verify system-state/ bucket layout for snapshot $SNAPLABEL"
BUCKET="lab/breeze-lab/snapshots/$SNAPLABEL"

if "$S"/mc stat "$BUCKET/manifest.json" > "$R/mc-stat-manifest.txt" 2>&1; then
  pass "layout: $BUCKET/manifest.json exists"
else
  fail "layout: $BUCKET/manifest.json MISSING"
fi

if "$S"/mc cat "$BUCKET/system-state/manifest.json" > "$R/state-manifest.json" 2> "$R/mc-cat-state-manifest.err"; then
  pass "layout: $BUCKET/system-state/manifest.json exists"
else
  fail "layout: $BUCKET/system-state/manifest.json MISSING"
fi

if [ -s "$R/state-manifest.json" ]; then
  ARTCOUNT=$(jq '.artifacts | length' "$R/state-manifest.json")
  echo "manifest lists $ARTCOUNT artifacts"
  : > "$R/artifact-check.log"
  jq -c '.artifacts[]' "$R/state-manifest.json" | while IFS= read -r art; do
    apath=$(echo "$art" | jq -r '.path')
    acsum=$(echo "$art" | jq -r '.checksum // empty')
    alink=$(echo "$art" | jq -r '.linkTarget // empty')
    okey="$BUCKET/system-state/$apath"
    # Symlinks are carried in the manifest (linkTarget) and never uploaded as objects.
    if [ -n "$alink" ]; then
      echo "OK(symlink) $apath -> $alink" >> "$R/artifact-check.log"
      continue
    fi
    if ! "$S"/mc stat "$okey" > /dev/null 2>&1; then
      echo "FAIL missing $okey" >> "$R/artifact-check.log"
      continue
    fi
    if [ -n "$acsum" ]; then
      got=$("$S"/mc cat "$okey" | sha256sum | cut -d' ' -f1)
      if [ "$got" != "$acsum" ]; then
        echo "FAIL checksum $apath want=$acsum got=$got" >> "$R/artifact-check.log"
      else
        echo "OK $apath" >> "$R/artifact-check.log"
      fi
    else
      echo "OK(no-checksum) $apath" >> "$R/artifact-check.log"
    fi
  done
  BAD=$(grep -c '^FAIL' "$R/artifact-check.log")
  if [ "$BAD" -eq 0 ]; then
    pass "layout: all $ARTCOUNT artifacts present with matching checksum"
  else
    fail "layout: $BAD/$ARTCOUNT artifacts missing or checksum-mismatched (see $R/artifact-check.log)"
  fi
else
  fail "layout: system-state manifest empty/unreadable, cannot check artifacts"
fi

# ---------------------------------------------------------------------------
# 5. Mint a BMR token for the snapshot
# ---------------------------------------------------------------------------
say "mint BMR token for snapshot row $SNAPROW"
TOKRESP=$($L bmr-token "$SNAPROW" 4)
echo "$TOKRESP" > "$R/bmr-token.json"
TOKEN=$(echo "$TOKRESP" | jq -r '.token // empty')
if [ -n "$TOKEN" ]; then
  pass "token: minted"
else
  fail "token: mint failed: $TOKRESP"
  exit 1
fi

# ---------------------------------------------------------------------------
# 6. tamper mode only: corrupt one system-state artifact object
# ---------------------------------------------------------------------------
if [ "$MODE" = tamper ]; then
  say "tamper: corrupt one system-state artifact object"
  # Pick a real, non-empty, checksummed artifact (not a symlink, not a 0-byte file whose
  # "corruption" would be indistinguishable), and prove the object actually changed size —
  # an mc wrapper without stdin passthrough silently writes nothing with `mc pipe`.
  TAMPER_PATH=$(jq -r '[.artifacts[] | select((.linkTarget // "") == "" and (.checksum // "") != "" and (.sizeBytes // 0) > 0)][0].path // empty' "$R/state-manifest.json")
  TAMPER_SIZE=$(jq -r --arg p "$TAMPER_PATH" '.artifacts[] | select(.path==$p) | .sizeBytes' "$R/state-manifest.json")
  if [ -z "$TAMPER_PATH" ]; then
    echo "no artifact available to tamper" >&2
    exit 1
  fi
  mkdir -p /tmp/mcout; printf 'garbage-%s-%s\n' "$(date +%s)" "$RANDOM$RANDOM" > /tmp/mcout/tamper.bin
  "$S"/mc cp /out/tamper.bin "$BUCKET/system-state/$TAMPER_PATH" > /dev/null
  NEWSIZE=$("$S"/mc stat --json "$BUCKET/system-state/$TAMPER_PATH" 2>/dev/null | jq -r '.size // empty' | head -1)
  echo "tampered object: $BUCKET/system-state/$TAMPER_PATH (manifest size $TAMPER_SIZE, now $NEWSIZE)" | tee "$R/tamper-target.txt"
  if [ -z "$NEWSIZE" ] || [ "$NEWSIZE" = "$TAMPER_SIZE" ]; then
    echo "tamper did not change the object — aborting so the negative case is not vacuous" >&2
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# 7. Run bmr-recover on TARGET
# ---------------------------------------------------------------------------
say "run bmr-recover on TARGET ($TGT_HOST) against $SERVER_URL"
if tgt "test -x $BIN"; then
  pass "recover: $BIN present on TARGET"
else
  fail "recover: $BIN not present/executable on TARGET — copy the recovery bundle there first (see plan doc §4)"
fi

RECOVER_OUT=$(tgt "sudo $BIN bmr-recover --token '$TOKEN' --server '$SERVER_URL'" 2>&1)
echo "$RECOVER_OUT" > "$R/recover-cli-output.txt"
echo "$RECOVER_OUT" | sed -n '/^{/,/^}/p' > "$R/recover-result.json"

# ---------------------------------------------------------------------------
# 8. Wait for the server-side restore job row to reach a terminal status
# ---------------------------------------------------------------------------
say "wait for the server-side restore job to reach a terminal status"
RID=""
for _ in $(seq 1 60); do
  RJSON=$($L api GET "/backup/restore?deviceId=$DEV&snapshotId=$SNAPROW&limit=1")
  RID=$(echo "$RJSON" | jq -r '.data[0].id // empty')
  [ -n "$RID" ] && break
  sleep 5
done

if [ -z "$RID" ]; then
  fail "recover: no restore_jobs row found for device $DEV / snapshot $SNAPROW"
  ROW="{}"
else
  ROW=$($L wait-restore "$RID" 1800)
  echo "$ROW" > "$R/restore-row.json"
fi

RSTATUS=$(echo "$ROW" | jq -r '.status // empty')
RSTATE=$(echo "$ROW" | jq -r '.resultDetails.stateApplied // false')
RERR=$(echo "$ROW" | jq -r '.resultDetails.error // empty')
echo "restore row $RID: status=$RSTATUS stateApplied=$RSTATE error=$RERR"

# ---------------------------------------------------------------------------
# 9. Assertions: completion payload, applied state, and excludes (recover);
#    or the checksum failure (tamper)
# ---------------------------------------------------------------------------
if [ "$MODE" = recover ]; then
  assert_eq "recover: restore job status completed" completed "$RSTATUS"
  assert_eq "recover: stateApplied true" true "$RSTATE"

  say "assert applied state on TARGET"
  GOTMARKER=$(tgt "sudo cat /etc/breeze-assure-marker" 2> /dev/null)
  assert_eq "target: marker content matches" "$MARKER_CONTENT" "$GOTMARKER"

  # Mode/owner fidelity depends on W01 (#5445): the collector stages /etc
  # entries with their real mode/uid/gid/mtime and records them on the
  # manifest artifacts, the consumer (W02) reapplies them into staging, and
  # the restorer (W03) propagates them onto /etc. Before W01+W02 land, staged
  # files are 0600 root and this assertion fails for that reason.
  GOTSTAT=$(tgt "stat -c '%a %U:%G' /etc/breeze-assure-marker" 2> /dev/null)
  assert_eq "target: marker mode/owner is 640 root:adm" "640 root:adm" "$GOTSTAT"

  ENABLED=$(tgt "systemctl is-enabled breeze-assure.service" 2> /dev/null)
  assert_eq "target: breeze-assure.service enabled" enabled "$ENABLED"

  GOTCRON=$(tgt "sudo crontab -u assure -l" 2> /dev/null)
  # `crontab -l` on the target includes the install header comments; the schedule line is the contract.
  if printf '%s\n' "$GOTCRON" | grep -qF -- "$CRON_LINE"; then pass "target: assure crontab contains the source schedule line"; else fail "target: assure crontab missing '$CRON_LINE' (got: $(printf '%s' "$GOTCRON" | tr '\n' '|' | cut -c1-160))"; fi

  if tgt "dpkg -s $PKG > /dev/null 2>&1"; then
    pass "target: package $PKG installed"
  else
    fail "target: package $PKG NOT installed"
  fi

  GOTLINK=$(tgt "readlink /etc/breeze-assure-link" 2> /dev/null)
  assert_eq "target: breeze-assure-link -> /etc/hostname" /etc/hostname "$GOTLINK"

  say "assert excludes held on TARGET"
  POSTMID=$(tgt "cat /etc/machine-id")
  assert_eq "target: /etc/machine-id unchanged" "$(cat "$R/tgt-pre-machine-id.txt")" "$POSTMID"

  POSTHOST=$(tgt "cat /etc/hostname")
  assert_eq "target: /etc/hostname unchanged" "$(cat "$R/tgt-pre-hostname.txt")" "$POSTHOST"

  POSTFSTAB=$(tgt "sudo md5sum /etc/fstab | cut -d' ' -f1")
  assert_eq "target: /etc/fstab unchanged" "$(cat "$R/tgt-pre-fstab.md5")" "$POSTFSTAB"
else
  if [ "$RSTATUS" != completed ]; then
    pass "tamper: restore job status is NOT completed ('$RSTATUS')"
  else
    fail "tamper: restore job status is completed — checksum tamper was not caught"
  fi
  # The server's restore row has no reason column (only status); the helper's own result
  # carries the verification failure in `error` or `warnings`. Assert on that.
  HELPER_REASON=$(jq -r '[.error // empty] + (.warnings // []) | join(" | ")' "$R/recover-result.json" 2>/dev/null)
  if printf '%s' "$RERR $HELPER_REASON" | grep -qiE 'checksum|verification|mismatch'; then
    pass "tamper: failure names a verification/checksum problem ($(printf '%s' "$HELPER_REASON" | grep -oiE '[^|]*(checksum|verification|mismatch)[^|]*' | head -1 | cut -c1-140))"
  else
    fail "tamper: failure reason does not mention checksum/verification (server='$RERR' helper='$(printf '%s' "$HELPER_REASON" | cut -c1-160)')"
  fi
fi

say "DONE b1-sys ($MODE) — evidence in $R"
if [ "$FAILS" -eq 0 ]; then
  exit 0
fi
echo "$FAILS assertion(s) FAILED" >&2
exit 1
