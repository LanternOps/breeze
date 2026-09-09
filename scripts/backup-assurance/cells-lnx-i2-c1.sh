#!/usr/bin/env bash
# Linux: mutate the corpus (modify + delete + add), cancel the resulting upload mid-way (C1),
# let the next run resume/complete (run 3), then prove: restore of run 3 reflects the mutation
# (I2: deleted file absent, new file present, modified bytes) and restore of run 1 still matches
# the original corpus (I3).
set -uo pipefail
cd "$(dirname "$0")/../.."
export LAB_API=${LAB_API:-http://localhost:33933/api/v1} LAB_STATE=${LAB_STATE:-$HOME/breeze-assurance/lab-state.json}
L=scripts/backup-assurance/lab.sh
S=${LAB_SCRATCH:?set LAB_SCRATCH to the dir holding vmssh/mc helpers}
R=$HOME/breeze-assurance/runs/lnx; mkdir -p "$R"
DEV=$(jq -r .devLnx "$LAB_STATE")
rsh() { $S/vmssh "$@" 2>/dev/null; }
say() { echo; echo "### $*"; }

say "mutate corpus: append 30 MiB to sizes/100MiB.bin, rewrite content/random.bin, delete content/crlf.txt, add content/new-after-run2.txt"
rsh 'cd ~/assure/src && head -c 31457280 /dev/urandom >> sizes/100MiB.bin && head -c 65536 /dev/urandom > content/random.bin && rm -f content/crlf.txt && printf "added after run 2\n" > content/new-after-run2.txt && ~/assure/hash-tree.sh ~/assure/src > ~/assure/pre2.tsv && grep -c "^F" ~/assure/pre2.tsv'

say "C1: run, cancel once >20 MB uploaded"
JOBS=$($L run "$DEV"); FJ=""
for i in $(seq 1 150); do for j in $JOBS; do read -r st ts <<<"$($L job "$j" | jq -r '[.status, (.transferredSize // 0)] | @tsv')"; if [ "$st" = running ] && [ "${ts:-0}" -gt 20000000 ]; then FJ=$j; break 2; fi; done; sleep 1; done
if [ -z "$FJ" ]; then echo "never saw >20 MB in flight"; for j in $JOBS; do $L wait-job "$j" 2400 | jq -c '{id,status,transferredSize,referencedFiles}'; done; else
  echo "cancelling $FJ at $($L job "$FJ" | jq -c '{transferredSize,snapshotId}')"; $L cancel-job "$FJ"; sleep 12
  $L job "$FJ" | tee "$R/postfix-C1-job.json" | jq -c '{status,snapshotId,transferredSize,totalSize,errorLog:(.errorLog|tostring|.[:160])}'
  LBL=$(jq -r '.snapshotId // empty' "$R/postfix-C1-job.json"); [ -n "$LBL" ] && echo "manifest published? $($S/mc ls lab/breeze-lab/snapshots/$LBL/ 2>/dev/null | grep -c manifest.json) objects: $($S/mc ls -r lab/breeze-lab/snapshots/$LBL/ 2>/dev/null | wc -l)"
  rsh "sudo ls -la /var/lib/breeze/backup-journal/ | tail -2; sudo grep -a -i -E 'stop|cancel|abort' /var/log/breeze/backup.log | grep -v progress | tail -4 | cut -c1-240"
  for j in $JOBS; do [ "$j" != "$FJ" ] && $L wait-job "$j" 900 > /dev/null; done
fi

say "run 3 (resume expected)"
JOBS3=$($L run "$DEV"); for j in $JOBS3; do $L wait-job "$j" 2400 | tee "$R/postfix-run3-job-$j.json" | jq -c '{id,status,snapshotId,fileCount,totalSize,transferredSize,referencedFiles,referencedSize,errorLog:(.errorLog|tostring|.[:160])}'; done
rsh "sudo grep -a -i -E 'resum|using previous manifest' /var/log/breeze/backup.log | grep -v progress | tail -3 | cut -c1-260"
SNAP3=$($L snapshots "$DEV" | jq -r 'select(.backupType=="file") | .id' | head -1)
SNAP1=$(jq -r .snapLnx1 "$LAB_STATE")
echo "run3 row $SNAP3 ; run1 row $SNAP1"

say "I2: restore run 3 → must match pre2 (deleted absent, added present, modified bytes)"
RID=$($L restore "$SNAP3" '{"targetPath":"/home/ubuntu/assure/postfix/I2"}'); $L wait-restore "$RID" 2400 | tee "$R/postfix-I2-restore.json" | jq -c '{status,restoredFiles,restoredSize,errorSummary,failed:(.resultDetails.failedFiles|tostring|.[:200])}'
rsh 'ROOT=/home/ubuntu/assure/postfix/I2/home/ubuntu/assure/src; sudo ~/assure/hash-tree.sh "$ROOT" > ~/assure/post-I2.tsv; ~/assure/compare-hashes.sh ~/assure/pre2.tsv ~/assure/post-I2.tsv --expect-skipped "^meta/links/" | grep -v "^  \(many/\|names/LLLL\)"; echo "crlf present? $( [ -e $ROOT/content/crlf.txt ] && echo YES-BUG || echo no )"; echo "new file present? $( [ -e $ROOT/content/new-after-run2.txt ] && echo yes || echo NO-BUG )"' | tee "$R/postfix-I2-compare.txt"

say "I3: restore run 1 → must still match the ORIGINAL pre.tsv"
RID=$($L restore "$SNAP1" '{"targetPath":"/home/ubuntu/assure/postfix/I3"}'); $L wait-restore "$RID" 2400 | tee "$R/postfix-I3-restore.json" | jq -c '{status,restoredFiles,restoredSize,errorSummary,failed:(.resultDetails.failedFiles|tostring|.[:200])}'
rsh 'ROOT=/home/ubuntu/assure/postfix/I3/home/ubuntu/assure/src; sudo ~/assure/hash-tree.sh "$ROOT" > ~/assure/post-I3.tsv; ~/assure/compare-hashes.sh ~/assure/pre.tsv ~/assure/post-I3.tsv --expect-skipped "^meta/links/" | grep -v "^  \(many/\|names/LLLL\)" | head -20' | tee "$R/postfix-I3-compare.txt"
echo; echo "### DONE lnx I2/C1/I3"
