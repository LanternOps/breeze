#!/usr/bin/env bash
# Hyper-V cells (phase 2): on a Hyper-V host enrolled in the lab, discover VMs, back up ONE small VM
# on demand, restore it as a new VM (generateNewId), boot it and confirm the guest heartbeat.
#
#   LAB_HV_SSH=user@host VM=<vm name> cells-hyperv.sh
# Expects lab-state.json with devKit (the host's device id) and the host reachable over SSH (PowerShell).
set -uo pipefail
cd "$(dirname "$0")/../.."
export LAB_API=${LAB_API:-http://localhost:33940/api/v1} LAB_STATE=${LAB_STATE:-$HOME/breeze-assurance/lab-state.json}
L=scripts/backup-assurance/lab.sh
H=${LAB_HV_SSH:?set LAB_HV_SSH=user@host for the Hyper-V host}
VM=${VM:?set VM=<name of the VM to back up>}
R=$HOME/breeze-assurance/phase2; mkdir -p "$R"
DEV=$(jq -r .devKit "$LAB_STATE")
hsh() { ssh -o BatchMode=yes -o ConnectTimeout=10 "$H" "powershell -NoProfile -Command \"$1\"" 2>/dev/null; }
say() { echo; echo "### $*"; }
jobid() { jq -r '.jobId // .id // .data.jobId // .data.id // empty'; }

say "H0 discover VMs on the host"
$L api POST "/backup/hyperv/discover/$DEV" '{}' | head -c 400; echo; sleep 30
$L api GET "/backup/hyperv/vms?deviceId=$DEV" | tee "$R/hv-vms.json" | jq -c '(.data // .)[] | {name,state,generation,vhdCount:(.disks|length? // null)}' 2>/dev/null | head -8

say "H1 on-demand backup of $VM (application-consistent export)"
RESP=$($L api POST /backup/hyperv/backup "$(jq -cn --arg d "$DEV" --arg v "$VM" '{deviceId:$d,vmName:$v,consistencyType:"application"}')"); echo "$RESP" | head -c 300; echo
J=$(echo "$RESP" | jobid); [ -n "$J" ] || { echo "no job id"; exit 1; }
$L wait-job "$J" 5400 | tee "$R/hv-H1-job.json" | jq -c '{id,status,backupType,snapshotId,fileCount,totalSize,transferredSize,errorLog:(.errorLog|tostring|.[:300])}'
SNAP=$($L snapshots "$DEV" | jq -r 'select(.backupType!="file") | .id' | head -1); echo "hyperv snapshot row: $SNAP"

say "H2 restore as a new VM ${VM}-restored"
RESP=$($L api POST /backup/hyperv/restore "$(jq -cn --arg d "$DEV" --arg s "$SNAP" --arg v "${VM}-restored" '{deviceId:$d,snapshotId:$s,vmName:$v,generateNewId:true}')"); echo "$RESP" | head -c 300; echo
RJ=$(echo "$RESP" | jobid); [ -n "$RJ" ] && $L wait-restore "$RJ" 5400 | tee "$R/hv-H2-restore.json" | jq -c '{status,errorSummary,restoredFiles,restoredSize}'
say "H2 verify: VM exists, starts, heartbeats"
hsh "\$v = Get-VM '${VM}-restored' -ErrorAction SilentlyContinue; if (-not \$v) { 'VM NOT FOUND' } else { Start-VM \$v; Start-Sleep 90; \$v = Get-VM '${VM}-restored'; \"state=\$(\$v.State) hb=\$((Get-VMIntegrationService \$v -Name Heartbeat).PrimaryStatusDescription) vhd=\$((Get-VMHardDiskDrive \$v | Select-Object -First 1).Path)\" }" | tee "$R/hv-H2-verify.txt"
echo; echo "### DONE hyperv"
