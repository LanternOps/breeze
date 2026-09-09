#!/usr/bin/env bash
# R1/R4: expire the oldest post-fix Linux snapshots, run the server GC once, and prove that
# (R1) every object still referenced by a newer manifest survives and the newest snapshot
# restores byte-exact, while (R4) objects no newer manifest references are reclaimed.
#
#   cells-gc.sh <expire-snapshot-row-id> [<more ids>...]
#
# Needs BACKUP_GC_GRACE_MS lowered on the lab API (default 48 h) or nothing is deleted.
set -uo pipefail
cd "$(dirname "$0")/../.."
export LAB_API=${LAB_API:-http://localhost:33933/api/v1} LAB_STATE=${LAB_STATE:-$HOME/breeze-assurance/lab-state.json}
export LAB_API_CONTAINER=${LAB_API_CONTAINER:-breeze-wt-toddhebebrand-backup-assurance-api-1}
export LAB_REDIS_CONTAINER=${LAB_REDIS_CONTAINER:-breeze-wt-toddhebebrand-backup-assurance-redis-1}
PG=${LAB_PG_CONTAINER:-breeze-wt-toddhebebrand-backup-assurance-postgres-1}
L=scripts/backup-assurance/lab.sh
S=/private/tmp/claude-501/-Users-toddhebebrand--herdr-worktrees-breeze-droplet-volume-add/73ed31ce-eb66-4900-b078-0b5b8ce77bd7/scratchpad
R=$HOME/breeze-assurance/runs/lnx; mkdir -p "$R"
DEV=$(jq -r .devLnx "$LAB_STATE")
psql() { docker exec "$PG" psql -U breeze -d breeze -Atc "$1"; }
say() { echo; echo "### $*"; }

IDS=$(printf "'%s'," "$@"); IDS=${IDS%,}
say "before: rows + object counts"
psql "select id, snapshot_id, file_count, expires_at from backup_snapshots where id in ($IDS)"
LABELS=$(psql "select snapshot_id from backup_snapshots where id in ($IDS)")
TOTAL_BEFORE=$($S/mc ls -r lab/breeze-lab/snapshots/ 2>/dev/null | wc -l | tr -d ' '); echo "objects in bucket: $TOTAL_BEFORE"
for lbl in $LABELS; do echo "$lbl: $($S/mc ls -r lab/breeze-lab/snapshots/$lbl/ 2>/dev/null | wc -l | tr -d ' ') objects"; done

say "expire the rows (system scope)"
psql "select set_config('breeze.scope','system',false); update backup_snapshots set expires_at = now() - interval '1 hour' where id in ($IDS); select count(*) from backup_snapshots where id in ($IDS) and expires_at < now()"

say "run GC"
$L gc; sleep 90
docker logs --since 3m "$LAB_API_CONTAINER" 2>&1 | grep -i -E 'cleanup|retention|sweep|deleted|unreferenced|expired' | grep -v -i debug | head -12 | cut -c1-240

say "after: rows + objects"
psql "select id, snapshot_id, file_count, expires_at from backup_snapshots where id in ($IDS)" || true
TOTAL_AFTER=$($S/mc ls -r lab/breeze-lab/snapshots/ 2>/dev/null | wc -l | tr -d ' '); echo "objects in bucket: $TOTAL_BEFORE -> $TOTAL_AFTER"
for lbl in $LABELS; do echo "$lbl: $($S/mc ls -r lab/breeze-lab/snapshots/$lbl/ 2>/dev/null | wc -l | tr -d ' ') objects"; done

say "R1: newest file snapshot must still restore byte-exact (its references point into the expired prefixes)"
SNAP=$($L snapshots "$DEV" | jq -r 'select(.backupType=="file") | .id' | head -1); echo "newest row $SNAP"
RID=$($L restore "$SNAP" '{"targetPath":"/home/ubuntu/assure/postfix/R1"}'); $L wait-restore "$RID" 2400 | tee "$R/postfix-R1-restore.json" | jq -c '{status,restoredFiles,restoredSize,errorSummary,failed:(.resultDetails.failedFiles|tostring|.[:200])}'
$S/vmssh 'ROOT=/home/ubuntu/assure/postfix/R1/home/ubuntu/assure/src; sudo ~/assure/hash-tree.sh ~/assure/src > ~/assure/pre3.tsv; sudo ~/assure/hash-tree.sh "$ROOT" > ~/assure/post-R1.tsv; ~/assure/compare-hashes.sh ~/assure/pre3.tsv ~/assure/post-R1.tsv --expect-skipped "^meta/links/" | grep -v "^  \(many/\|names/LLLL\)" | head -16' 2>/dev/null | tee "$R/postfix-R1-compare.txt"
echo; echo "### DONE gc"
