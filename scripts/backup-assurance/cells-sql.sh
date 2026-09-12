#!/usr/bin/env bash
# SQL Server cells on the Windows rig (phase 2): on-demand full backup of AssureDB, restore to a new
# database name, verify row count + CHECKSUM_AGG match the source, then a differential after inserting
# rows and RESTORE VERIFYONLY through the API.
#
#   LAB_WIN_SSH=user@host cells-sql.sh
# Expects lab-state.json with devWin, and sqlcmd on the rig at the SQL 2025 Express path.
set -uo pipefail
cd "$(dirname "$0")/../.."
export LAB_API=${LAB_API:-http://localhost:33940/api/v1} LAB_STATE=${LAB_STATE:-$HOME/breeze-assurance/lab-state.json}
L=scripts/backup-assurance/lab.sh
W=${LAB_WIN_SSH:?set LAB_WIN_SSH=user@host for the Windows rig}
R=$HOME/breeze-assurance/phase2; mkdir -p "$R"
DEV=$(jq -r .devWin "$LAB_STATE")
SQLCMD='C:\Program Files\Microsoft SQL Server\Client SDK\ODBC\180\Tools\Binn\SQLCMD.EXE'
wsh() { ssh -o BatchMode=yes -o ConnectTimeout=10 "$W" "$@" 2>/dev/null; }
sql() { wsh "& '$SQLCMD' -S 'localhost\\SQLEXPRESS' -E -C -h -1 -W -Q \"SET NOCOUNT ON; $1\""; }
say() { echo; echo "### $*"; }
jobid() { jq -r '.data.backupJobId // .backupJobId // .jobId // .data.jobId // .id // .data.id // empty'; }

say "S1 full backup of AssureDB (on-demand)"
RESP=$($L api POST /backup/mssql/backup "$(jq -cn --arg d "$DEV" '{deviceId:$d,instance:"SQLEXPRESS",database:"AssureDB",backupType:"full"}')"); echo "$RESP" | head -c 300; echo
J=$(echo "$RESP" | jobid); [ -n "$J" ] || { echo "no job id"; exit 1; }
$L wait-job "$J" 1800 | tee "$R/sql-S1-job.json" | jq -c '{id,status,backupType,snapshotId,fileCount,totalSize,transferredSize,errorLog:(.errorLog|tostring|.[:300])}'
SNAP=$($L snapshots "$DEV" | jq -r 'select(.backupType!="file") | .id' | head -1); echo "sql snapshot row: $SNAP"

say "S2 restore to AssureDB_restored (WITH RECOVERY)"
RESP=$($L api POST /backup/mssql/restore "$(jq -cn --arg d "$DEV" --arg s "$SNAP" '{deviceId:$d,snapshotId:$s,targetDatabase:"AssureDB_restored",noRecovery:false}')"); echo "$RESP" | head -c 300; echo
RJ=$(echo "$RESP" | jobid); [ -n "$RJ" ] && $L wait-restore "$RJ" 1800 | tee "$R/sql-S2-restore.json" | jq -c '{status,errorSummary,restoredFiles}'
say "S2 verify data: source vs restored"
sql "SELECT 'src', COUNT(*), CHECKSUM_AGG(CHECKSUM(Id, Payload, Blob)) FROM AssureDB.dbo.Items; SELECT 'restored', COUNT(*), CHECKSUM_AGG(CHECKSUM(Id, Payload, Blob)) FROM AssureDB_restored.dbo.Items;" | tee "$R/sql-S2-compare.txt"

say "S3 differential after inserting 500 rows, then RESTORE VERIFYONLY via API"
sql "INSERT INTO AssureDB.dbo.Items (Payload, Blob) SELECT CONCAT('diff-', n), CRYPT_GEN_RANDOM(64) FROM (SELECT TOP (500) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) n FROM sys.all_objects) t; SELECT COUNT(*) FROM AssureDB.dbo.Items;"
RESP=$($L api POST /backup/mssql/backup "$(jq -cn --arg d "$DEV" '{deviceId:$d,instance:"SQLEXPRESS",database:"AssureDB",backupType:"differential"}')"); J2=$(echo "$RESP" | jobid); echo "diff job $J2"
[ -n "$J2" ] && $L wait-job "$J2" 1800 | tee "$R/sql-S3-job.json" | jq -c '{id,status,backupType,snapshotId,totalSize,errorLog:(.errorLog|tostring|.[:300])}'
SNAP2=$($L snapshots "$DEV" | jq -r 'select(.backupType!="file") | .id' | head -1); echo "diff snapshot row: $SNAP2"
$L api POST "/backup/mssql/verify/$SNAP2" '{}' | tee "$R/sql-S3-verify.json" | head -c 400; echo
echo; echo "### DONE sql"
