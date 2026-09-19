#!/usr/bin/env bash
# Hyper-V restore-only cell: restore an existing hyperv snapshot as a new VM and boot it.
#   LAB_HV_SSH=user@host VM=<new vm name> SNAP=<snapshot row id> cells-hyperv-restore.sh
set -uo pipefail
cd "$(dirname "$0")/../.."
export LAB_API=${LAB_API:-http://localhost:33940/api/v1} LAB_STATE=${LAB_STATE:-$HOME/breeze-assurance/lab-state.json}
L=scripts/backup-assurance/lab.sh
H=${LAB_HV_SSH:?}; VM=${VM:?}; SNAP=${SNAP:?}
R=$HOME/breeze-assurance/phase2; mkdir -p "$R"
DEV=$(jq -r .devKit "$LAB_STATE")
hsh() { ssh -o BatchMode=yes -o ConnectTimeout=10 "$H" "powershell -NoProfile -Command \"$1\"" 2>/dev/null; }
jobid() { jq -r '.data.restoreJobId // .restoreJobId // .data.backupJobId // .jobId // .data.jobId // .id // .data.id // empty'; }
echo "### H2 restore snapshot $SNAP as $VM"
RESP=$($L api POST /backup/hyperv/restore "$(jq -cn --arg d "$DEV" --arg s "$SNAP" --arg v "$VM" '{deviceId:$d,snapshotId:$s,vmName:$v,generateNewId:true}')"); echo "$RESP" | head -c 400; echo
RJ=$(echo "$RESP" | jobid); [ -n "$RJ" ] && $L wait-restore "$RJ" 5400 | tee "$R/hv-H2-restore.json" | jq -c '{status,errorSummary,restoredFiles,restoredSize}'
echo "### H2 verify: VM exists, starts, heartbeats"
hsh "\$v = Get-VM '$VM' -ErrorAction SilentlyContinue; if (-not \$v) { 'VM NOT FOUND' } else { Start-VM \$v; Start-Sleep 120; \$v = Get-VM '$VM'; \"state=\$(\$v.State) hb=\$((Get-VMIntegrationService \$v -Name Heartbeat).PrimaryStatusDescription) ips=\$((Get-VMNetworkAdapter \$v | Select-Object -ExpandProperty IPAddresses) -join ',') vhd=\$((Get-VMHardDiskDrive \$v | Select-Object -First 1).Path)\" }" | tee "$R/hv-H2-verify.txt"
echo "### DONE hyperv-restore"
