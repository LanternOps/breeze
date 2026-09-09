#!/usr/bin/env bash
# Post-fix cell chain for a Unix rig (Linux VM or Mac rig): F1 dual-job, integrity, F2 alt-path
# byte compare, F4b selective, I1 incremental references, C1 cancel+resume (Linux only).
#
#   cells-unix.sh <lnx|mac> <corpus-root-on-rig> <restore-root-on-rig> [--no-c1]
#
# Rig access: lnx → $S/vmssh (QEMU VM 1), mac → local shell. Results land in
# ~/breeze-assurance/runs/<rig>/postfix-*.json|txt.
set -uo pipefail
RIG=${1:?lnx|mac}; SRC=${2:?corpus root}; RROOT=${3:?restore root}; NOC1=${4:-}
cd "$(dirname "$0")/../.."
export LAB_API=${LAB_API:-http://localhost:33933/api/v1} LAB_STATE=${LAB_STATE:-$HOME/breeze-assurance/lab-state.json}
L=scripts/backup-assurance/lab.sh
S=${LAB_SCRATCH:?set LAB_SCRATCH to the dir holding vmssh/mc helpers}
R=$HOME/breeze-assurance/runs/$RIG; mkdir -p "$R"
case $RIG in
  lnx) DEV=$(jq -r .devLnx "$LAB_STATE"); rsh() { $S/vmssh "$@" 2>/dev/null; }; PRE=/home/ubuntu/assure/pre.tsv; HT=/home/ubuntu/assure/hash-tree.sh; CMP=/home/ubuntu/assure/compare-hashes.sh; SUDO=sudo ;;
  mac) DEV=$(jq -r .devMac "$LAB_STATE"); rsh() { bash -c "$*"; }; PRE=$HOME/breeze-assurance/mac/pre.tsv; HT=$PWD/scripts/backup-assurance/hash-tree.sh; CMP=$PWD/scripts/backup-assurance/compare-hashes.sh; SUDO= ;;
esac
say() { echo; echo "### $*"; }

say "F1 dual-job run (D1)"
JOBS=$($L run "$DEV"); echo "jobs: $JOBS"
FILEJOB=""; FILESNAP=""
for j in $JOBS; do
  out=$($L wait-job "$j" 2400); echo "$out" > "$R/postfix-F1-job-$j.json"
  echo "$out" | jq -c '{id,status,snapshotId,fileCount,totalFiles,totalSize,transferredSize,referencedFiles,errorCount,errorLog:(.errorLog|tostring|.[:200])}'
  if [ "$(echo "$out" | jq -r '.fileCount // 0')" -gt 1000 ]; then FILEJOB=$j; FILESNAP=$(echo "$out" | jq -r .snapshotId); fi
done
SNAPID=$($L snapshots "$DEV" | jq -r "select(.backupType==\"file\") | .id" | head -1)
echo "file snapshot row: $SNAPID (label $FILESNAP)"

say "F1 integrity (D2)"
V=$($L verify "$DEV" "$SNAPID" integrity); $L wait-verify "$V" 1200 | tee "$R/postfix-F1-integrity.json" | jq -c '{status,filesVerified,filesFailed,failed:(.details.failedFiles|tostring|.[:300])}'

say "F2 alt-path restore + byte compare (D2, D4)"
RID=$($L restore "$SNAPID" "{\"targetPath\":\"$RROOT/F2\"}"); $L wait-restore "$RID" 2400 | tee "$R/postfix-F2-restore.json" | jq -c '{status,restoredFiles,restoredSize,errorSummary,failed:(.resultDetails.failedFiles|tostring|.[:300])}'
rsh "$SUDO $HT $RROOT/F2$SRC > $RROOT/post-F2.tsv; $CMP $PRE $RROOT/post-F2.tsv --expect-skipped '^meta/links/'" | grep -v '^  names/LLLL' | tee "$R/postfix-F2-compare.txt"

say "F4b selective restore: pick.txt + unicode + 1MiB (D5)"
RID=$($L restore "$SNAPID" "{\"restoreType\":\"selective\",\"targetPath\":\"$RROOT/F4\",\"selectedPaths\":[\"$SRC/content/prefix/pick.txt\",\"$SRC/names/café/naïve résumé.txt\",\"$SRC/sizes/1MiB.bin\"]}"); $L wait-restore "$RID" 900 | tee "$R/postfix-F4-restore.json" | jq -c '{status,restoredFiles,restoredSize,errorSummary}'
rsh "cd $RROOT/F4 && find . -type f | sed 's#^\./##' | sort" | tee "$R/postfix-F4-tree.txt"

say "I1 unchanged run 2 (D6: expect references)"
JOBS2=$($L run "$DEV"); for j in $JOBS2; do out=$($L wait-job "$j" 2400); echo "$out" > "$R/postfix-I1-job-$j.json"; echo "$out" | jq -c '{id,status,snapshotId,fileCount,totalSize,transferredSize,referencedFiles,referencedSize,errorLog:(.errorLog|tostring|.[:160])}'; done
SNAP2=$($L snapshots "$DEV" | jq -r 'select(.backupType=="file") | .id' | head -1)
LBL2=$($L snapshot "$SNAP2" | jq -r '.label // .location // empty'); echo "run-2 snapshot row $SNAP2"
rsh "$SUDO grep -a -E 'using previous manifest|no reference dedupe|no matching previous' /var/log/breeze/backup.log 2>/dev/null | tail -2 | cut -c1-300" 2>/dev/null || true

if [ "$NOC1" != "--no-c1" ]; then
  say "C1 cancel mid-upload (>20 MB) then resume"
  JOBS3=$($L run "$DEV"); FJ=""
  for i in $(seq 1 120); do for j in $JOBS3; do read -r st ts <<<"$($L job "$j" | jq -r '[.status, (.transferredSize // 0)] | @tsv')"; if [ "$st" = running ] && [ "${ts:-0}" -gt 20000000 ]; then FJ=$j; break 2; fi; done; sleep 2; done
  if [ -n "$FJ" ]; then
    echo "cancelling $FJ at $($L job "$FJ" | jq -c '{transferredSize,snapshotId}')"; $L cancel-job "$FJ"; sleep 12
    $L job "$FJ" | tee "$R/postfix-C1-job.json" | jq -c '{status,snapshotId,transferredSize,totalSize,errorLog:(.errorLog|tostring|.[:160])}'
    LBL=$(jq -r .snapshotId "$R/postfix-C1-job.json"); echo "manifest published? $($S/mc ls lab/breeze-lab/snapshots/$LBL/ 2>/dev/null | grep -c manifest.json) objects: $($S/mc ls -r lab/breeze-lab/snapshots/$LBL/ 2>/dev/null | wc -l)"
    for j in $JOBS3; do [ "$j" != "$FJ" ] && $L wait-job "$j" 900 > /dev/null; done
    JOBS4=$($L run "$DEV"); for j in $JOBS4; do $L wait-job "$j" 2400 | tee "$R/postfix-C1b-job-$j.json" | jq -c '{id,status,snapshotId,fileCount,transferredSize,referencedFiles}'; done
    rsh "$SUDO grep -a -i 'resum' /var/log/breeze/backup.log 2>/dev/null | grep -v progress | tail -2 | cut -c1-260" || true
  else
    echo "C1: never observed >20 MB in flight (run too fast or references) — skipped"
  fi
fi
echo; echo "### DONE $RIG"
