#!/usr/bin/env bash
# Post-fix cell chain for WIN-A: F1 dual-job (D1 + system_image loud-fail under Defender, O13),
# integrity (D2), F2 alt-path restore + byte compare (D8, D4), I1 references (D6).
#
#   cells-win.sh   (uses ~/breeze-assurance/win/pre.tsv and C:\assure\src)
set -uo pipefail
cd "$(dirname "$0")/../.."
export LAB_API=${LAB_API:-http://localhost:33933/api/v1} LAB_STATE=${LAB_STATE:-$HOME/breeze-assurance/lab-state.json}
L=scripts/backup-assurance/lab.sh
W=administrator@100.101.28.70
R=$HOME/breeze-assurance/runs/win; mkdir -p "$R"
DEV=$(jq -r .devWin "$LAB_STATE")
wsh() { ssh -o BatchMode=yes -o ConnectTimeout=10 "$W" "$@" 2>/dev/null; }
say() { echo; echo "### $*"; }

say "F1 dual-job run (D1; system_image expected to FAIL LOUD on SECURITY hive under Defender)"
JOBS=$($L run "$DEV"); echo "jobs: $JOBS"
for j in $JOBS; do out=$($L wait-job "$j" 2400); echo "$out" > "$R/postfix-F1-job-$j.json"; echo "$out" | jq -c '{id,status,snapshotId,fileCount,totalFiles,totalSize,transferredSize,referencedFiles,errorCount,errorLog:(.errorLog|tostring|.[:260])}'; done
SNAPID=$($L snapshots "$DEV" | jq -r 'select(.backupType=="file") | .id' | head -1); echo "file snapshot row: $SNAPID"

say "F1 integrity (D2)"
V=$($L verify "$DEV" "$SNAPID" integrity); $L wait-verify "$V" 1800 | tee "$R/postfix-F1-integrity.json" | jq -c '{status,filesVerified,filesFailed,failed:(.details.failedFiles|tostring|.[:300])}'

say "F2 alt-path restore to C:\\assure\\postfix\\F2 (D8) + byte compare"
RID=$($L restore "$SNAPID" '{"targetPath":"C:\\assure\\postfix\\F2"}'); $L wait-restore "$RID" 3600 | tee "$R/postfix-F2-restore.json" | jq -c '{status,restoredFiles,restoredSize,errorSummary,failed:(.resultDetails.failedFiles|tostring|.[:300])}'
echo "top-level dirs under restore root:"; wsh 'powershell -NoProfile -Command "Get-ChildItem C:\assure\postfix\F2 -Directory -Recurse -Depth 1 | Select-Object -ExpandProperty FullName"' | head -6
wsh 'powershell -NoProfile -ExecutionPolicy Bypass -File C:\assure\hash-tree.ps1 -Root C:\assure\postfix\F2\assure\src' > "$R/postfix-post-F2.tsv"; echo "hashed $(grep -c '^F' "$R/postfix-post-F2.tsv") files"
scripts/backup-assurance/compare-hashes.sh "$HOME/breeze-assurance/win/pre.tsv" "$R/postfix-post-F2.tsv" --expect-skipped '^meta/links/|perm-denied' | grep -v '^  names/LLLL' | tee "$R/postfix-F2-compare.txt"

say "I1 unchanged run 2 (D6: expect references)"
JOBS2=$($L run "$DEV"); for j in $JOBS2; do out=$($L wait-job "$j" 2400); echo "$out" > "$R/postfix-I1-job-$j.json"; echo "$out" | jq -c '{id,status,snapshotId,fileCount,totalSize,transferredSize,referencedFiles,referencedSize,errorLog:(.errorLog|tostring|.[:160])}'; done
wsh 'powershell -NoProfile -Command "Get-Content C:\ProgramData\Breeze\logs\backup.log -Tail 300 | Select-String -Pattern \"previous manifest|reference dedupe|matching previous|reg save|incomplete\" | Select-Object -Last 5 | ForEach-Object { $_.Line.Substring(0,[Math]::Min(280,$_.Line.Length)) }"'
echo; echo "### DONE win"
