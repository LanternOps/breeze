#!/usr/bin/env bash
# D18 R5/R6: the two halves of the pin contract.
#   R5 (pin)   while a job is in flight, the snapshot the server chose as its dedupe base survives
#              retention even though the row is expired (outcome "pinned", no retirement row).
#   R6 (lease) a run whose upload outlasts its publish window refuses to publish: the job fails with
#              the lease error and no manifest or snapshot row lands.
#
#   cells-gc-pins.sh [r5|r6]        (default: both)
#
# Needs BACKUP_GC_GRACE_MS=1000 BACKUP_PUBLISH_MARGIN_MS=1000 on the lab API and one completed file
# snapshot. The helper refuses to publish once now + its built-in 1 h margin passes the lease
# (snapshot.go publishMargin), so a lab lease must exceed 1 h: BACKUP_BASE_LEASE_MS=3900000 (5 min
# publish window) for R5 and the ordinary cells, 3660000 (60 s window) for R6. A lease <= 1 h fails
# every job. Do not freeze the helper for longer than a few seconds: the agent reaps a helper that
# stops answering IPC ("backup helper exited unexpectedly"), which is not the lease fence.
set -uo pipefail
cd "$(dirname "$0")/../.."
export LAB_API=${LAB_API:-http://localhost:33933/api/v1} LAB_STATE=${LAB_STATE:-$HOME/breeze-assurance/lab-state.json}
export LAB_API_CONTAINER=${LAB_API_CONTAINER:-breeze-wt-toddhebebrand-backup-assurance-api-1}
export LAB_REDIS_CONTAINER=${LAB_REDIS_CONTAINER:-breeze-wt-toddhebebrand-backup-assurance-redis-1}
PG=${LAB_PG_CONTAINER:-breeze-wt-toddhebebrand-backup-assurance-postgres-1}
L=scripts/backup-assurance/lab.sh
S=${LAB_SCRATCH:?set LAB_SCRATCH to the dir holding vmssh/mc helpers}
DEV=$(jq -r .devLnx "$LAB_STATE")
psql() { docker exec "$PG" psql -U breeze -d breeze -Atc "$1"; }
say() { echo; echo "### $*"; }
FAIL=0

WHICH=${1:-all}

if [ "$WHICH" != r6 ]; then
say "R5 setup: make the next run upload something slow enough to catch in flight (256 MiB of new data)"
$S/vmssh 'head -c 268435456 /dev/urandom > ~/assure/src/sizes/d18-stall.bin' 2>/dev/null

say "dispatch, wait for the server-chosen base, freeze the helper"
JOB=$($L run "$DEV" | head -1); echo "job $JOB"
BASE_LBL=""
for i in $(seq 1 120); do
  read -r st BASE_LBL <<<"$(psql "select status, coalesce(base_snapshot_id,'') from backup_jobs where id='$JOB'" | tr '|' ' ')"
  [ "$st" = running ] && [ -n "$BASE_LBL" ] && break
  sleep 0.5
done
$S/vmssh 'sudo pkill -STOP -x breeze-backup; pgrep -x breeze-backup | xargs -r ps -o pid=,stat=,comm= -p' 2>/dev/null
psql "select id, status, base_snapshot_id, publish_lease_expires_at, now() as now from backup_jobs where id='$JOB'"
[ -n "$BASE_LBL" ] || { echo "FAIL: job never recorded a base_snapshot_id (first run, or a legacy helper?)"; exit 1; }
BASE=$(psql "select id from backup_snapshots where device_id='$DEV' and snapshot_id='$BASE_LBL'")
echo "base: label $BASE_LBL row $BASE"

say "R5: expire the base row, run retention + GC while the job is frozen"
psql "select set_config('breeze.scope','system',false); update backup_snapshots set expires_at = now() - interval '1 hour' where id='$BASE'" >/dev/null
$L gc
for i in $(seq 1 30); do docker logs --since 1m "$LAB_API_CONTAINER" 2>&1 | grep -q 'BackupGC\] Run complete' && break; sleep 2; done
docker logs --since 1m "$LAB_API_CONTAINER" 2>&1 | grep -E 'BackupRetention\]|BackupGC\]' | cut -c1-260
SURVIVED=$(psql "select count(*) from backup_snapshots where id='$BASE'")
RETIRED=$(psql "select count(*) from backup_snapshot_retirements where snapshot_id='$BASE_LBL'")
echo "base row survives: $SURVIVED (expect 1); retirement rows: $RETIRED (expect 0)"
[ "$SURVIVED" -eq 1 ] || { echo "FAIL R5: pinned base row was deleted while its job was in flight"; FAIL=1; }
[ "$RETIRED" -eq 0 ] || { echo "FAIL R5: pinned base was retired"; FAIL=1; }
docker logs --since 1m "$LAB_API_CONTAINER" 2>&1 | grep -qE '[1-9][0-9]* \(pinned\)' || { echo "FAIL R5: retention did not report a pinned skip"; FAIL=1; }
$S/mc stat "lab/breeze-lab/snapshots/$BASE_LBL/manifest.json" >/dev/null 2>&1 || { echo "FAIL R5: base manifest gone from the bucket"; FAIL=1; }

$S/vmssh 'sudo pkill -CONT -x breeze-backup' 2>/dev/null
$L wait-job "$JOB" 900 | jq -c '{id,status,snapshotId,transferredSize,errorLog:(.errorLog|tostring|.[:200])}'
psql "select 'base stays pinned until ' || (publish_lease_expires_at + interval '2 seconds') || '; retire it afterwards with cells-gc.sh $BASE' from backup_jobs where id='$JOB'"
fi

if [ "$WHICH" != r5 ]; then
say "R6 setup: 256 MiB of new data, egress throttled to ${LAB_R6_RATE:-12mbit} so the upload outlasts the publish window"
$S/vmssh 'head -c 268435456 /dev/urandom > ~/assure/src/sizes/d18-lease.bin; IF=$(ip -o route show default | sed -n "s/.* dev \([^ ]*\).*/\1/p" | head -1); sudo tc qdisc replace dev $IF root tbf rate '"${LAB_R6_RATE:-12mbit}"' burst 64kbit latency 400ms; tc qdisc show dev $IF | head -1' 2>/dev/null
JOB=$($L run "$DEV" | head -1); echo "job $JOB"; sleep 3
psql "select id, status, base_snapshot_id, publish_lease_expires_at, now() as now, ceil(extract(epoch from (publish_lease_expires_at - now()))) - ${LAB_HELPER_PUBLISH_MARGIN_S:-3600} as publish_window_s from backup_jobs where id='$JOB'"
$L wait-job "$JOB" 1500 | jq -c '{id,status,snapshotId,totalSize,transferredSize,completedAt,errorLog:(.errorLog|tostring|.[:300])}'
$S/vmssh 'IF=$(ip -o route show default | sed -n "s/.* dev \([^ ]*\).*/\1/p" | head -1); sudo tc qdisc del dev $IF root; rm -f ~/assure/src/sizes/d18-lease.bin' 2>/dev/null
read -r STATUS LBL <<<"$(psql "select status, coalesce(snapshot_id,'') from backup_jobs where id='$JOB'" | tr '|' ' ')"
ERRLOG=$(psql "select error_log from backup_jobs where id='$JOB'")
[ "$STATUS" = failed ] || { echo "FAIL R6: job ended '$STATUS', expected failed"; FAIL=1; }
echo "$ERRLOG" | grep -qiE 'publish[_ ]lease' || { echo "FAIL R6: error_log does not name the publish lease: $ERRLOG"; FAIL=1; }
$S/vmssh "sudo grep -a -i 'lease' /var/log/breeze/backup.log | tail -3 | cut -c1-260" 2>/dev/null
NEWROWS=$(psql "select count(*) from backup_snapshots where job_id='$JOB'")
echo "snapshot rows created by the job: $NEWROWS (expect 0)"
[ "$NEWROWS" -eq 0 ] || { echo "FAIL R6: a snapshot row was published after the lease expired"; FAIL=1; }
N=$($S/mc ls -r "lab/breeze-lab/snapshots/$LBL/" 2>/dev/null | wc -l | tr -d ' ')
if [ -n "$LBL" ] && $S/mc stat "lab/breeze-lab/snapshots/$LBL/manifest.json" >/dev/null 2>&1; then
  echo "FAIL R6: manifest published after the lease expired ($LBL)"; FAIL=1
else echo "no manifest under snapshots/${LBL:-<none>}/ ($N data objects uploaded, left for the orphan sweep)"; fi
[ "$N" -gt 0 ] || { echo "FAIL R6: nothing was uploaded, so the run never reached the publish fence"; FAIL=1; }
fi

$S/vmssh 'rm -f ~/assure/src/sizes/d18-stall.bin' 2>/dev/null
echo; [ "$FAIL" -eq 0 ] && echo "### PASS gc-pins" || echo "### FAIL gc-pins"
exit $FAIL
