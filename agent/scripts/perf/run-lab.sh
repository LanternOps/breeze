#!/usr/bin/env bash
# run-lab.sh: measure a breeze-agent build on one lab VM. Usage and rules: README.md.
set -euo pipefail

usage() {
  echo "usage: $0 --vm <name> --agent <breeze-agent.exe> --workload idle|scan|desktop|transfer --runs <n> --out <dir> [--snapshot <name>] [--seconds <n>]" >&2
  exit 2
}
vm='' snapshot='' agent='' workload='' runs='' out='' seconds=''
while [ $# -gt 0 ]; do
  [ $# -ge 2 ] || usage
  case $1 in
    --vm) vm=$2 ;; --snapshot) snapshot=$2 ;; --agent) agent=$2 ;; --workload) workload=$2 ;;
    --runs) runs=$2 ;; --out) out=$2 ;; --seconds) seconds=$2 ;; *) usage ;;
  esac
  shift 2
done
if [ -z "$vm" ] || [ ! -f "$agent" ] || [ -z "$runs" ] || [ -z "$out" ]; then usage; fi
case $workload in
  idle) seconds=${seconds:-1800} ;;
  scan) seconds=${seconds:-600} ;;
  desktop) echo "workload desktop is not automated: it needs a WebRTC viewer session" >&2; exit 2 ;;
  transfer) echo "workload transfer is not automated: no API command moves 500 MB to the agent (file upload caps at 4 MB)" >&2; exit 2 ;;
  *) usage ;;
esac
: "${BREEZE_STACK_URL:?}" "${BREEZE_ADMIN_EMAIL:?}" "${BREEZE_ADMIN_PASSWORD:?}" "${BREEZE_PG_CONTAINER:?}"

V=(virsh -c qemu:///system)
port=53317 # the libvirt bridge port the VM may reach on the host
dir='C:\breeze-perf'
data=${PERF_LAB_DATA_DIR:-'C:\ProgramData\Breeze'} # test-only override, to exercise the backup on a scratch tree
backup="$data.perf-backup"
bridge=$("${V[@]}" net-dumpxml default | sed -n "s/.*<ip address='\([^']*\)'.*/\1/p" | head -1)
[ -n "$bridge" ] || { echo "no libvirt bridge address: is the default network defined?" >&2; exit 1; }
stack_port=$(sed -E 's#^[a-z]+://[^:/]+:([0-9]+).*#\1#' <<<"$BREEZE_STACK_URL")
others=$("${V[@]}" list --name --state-running | grep -vx -e "$vm" -e '' || true)
[ -z "$others" ] || { echo "shut these VMs off first, one VM at a time: $others" >&2; exit 1; }
mkdir -p "$out"
stat -c %s "$agent" >"$out/binary-size.txt"

ga() { "${V[@]}" qemu-agent-command "$vm" "$1"; }
# gx_start <script>: start PowerShell in the VM, print the guest pid.
gx_start() {
  ga "$(jq -nc --arg c "\$ErrorActionPreference='Stop'; \$ProgressPreference='SilentlyContinue'; $1" \
    '{execute:"guest-exec",arguments:{path:"powershell.exe",arg:["-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-Command",$c],"capture-output":true}}')" | jq -r .return.pid
}
# gx_wait <pid> <seconds>: print its stdout and stderr, return its exit code.
gx_wait() {
  local st
  for _ in $(seq "$2"); do
    st=$(ga "{\"execute\":\"guest-exec-status\",\"arguments\":{\"pid\":$1}}")
    if [ "$(jq -r .return.exited <<<"$st")" = true ]; then
      jq -r '.return["out-data"] // empty' <<<"$st" | base64 -d | tr -d '\r'
      jq -r '.return["err-data"] // empty' <<<"$st" | base64 -d >&2
      return "$(jq -r .return.exitcode <<<"$st")"
    fi
    sleep 1
  done
  echo "guest pid $1 still running after $2 s" >&2
  return 1
}
gx() { gx_wait "$(gx_start "$1")" "${2:-120}"; }
sql() { docker exec "$BREEZE_PG_CONTAINER" psql -U breeze -d breeze -tAc "$1"; }
api() { curl -fsS -X "$1" -H "Authorization: Bearer $token" -H 'Content-Type: application/json' "$BREEZE_STACK_URL/api/v1$2" "${@:3}"; }
hash_state() { gx "Get-ChildItem -LiteralPath '$1' -Recurse -File | ForEach-Object { \$_.FullName.Substring(${#1} + 1) + ' ' + (Get-FileHash -LiteralPath \$_.FullName -Algorithm SHA256).Hash } | Sort-Object"; }
robocopy_mirror() { gx "robocopy '$1' '$2' /MIR /COPYALL /DCOPY:DAT /R:2 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null; if (\$LASTEXITCODE -ge 8) { throw \"robocopy exit \$LASTEXITCODE\" }; exit 0"; }

srv='' relay='' backed_up='' services=''
stop_pid() { if [ -n "$1" ]; then kill "$1" 2>/dev/null || true; wait "$1" 2>/dev/null || true; fi; }
# The relay runs in its own process group, so killing the group also stops its forked connection children.
stop_group() { if [ -n "$1" ]; then kill -- -"$1" 2>/dev/null || true; wait "$1" 2>/dev/null || true; fi; }
vm_off() {
  [ "$("${V[@]}" domstate "$vm")" = running ] || return 0
  "${V[@]}" shutdown "$vm" >/dev/null || true
  for _ in $(seq 180); do [ "$("${V[@]}" domstate "$vm")" = running ] || return 0; sleep 1; done
  "${V[@]}" destroy "$vm" >/dev/null
}
# restore <run dir>: put C:\ProgramData\Breeze back exactly as it was.
restore() {
  gx "Get-Process breeze* -ErrorAction SilentlyContinue | Stop-Process -Force; Start-Sleep 2" || true
  robocopy_mirror "$backup" "$data" || return 1
  hash_state "$data" >"$1/state-after.txt" || return 1
  diff -q "$1/state-before.txt" "$1/state-after.txt" >/dev/null || { echo "restore mismatch: $1/state-*.txt" >&2; return 1; }
  backed_up=''
  gx "Remove-Item -Recurse -Force -LiteralPath '$backup'" || echo "warning: could not remove $backup" >&2
}
start_services() {
  if [ -n "$services" ]; then gx "Start-Service $services; Get-Service $services | ForEach-Object { \$_.Name + ' ' + \$_.Status }" >"$run_dir/services-after.txt"; services=''; fi
}
cleanup() {
  set +e
  stop_pid "$srv"; stop_group "$relay"
  if [ -n "${files:-}" ]; then rm -rf "$files"; fi
  if [ -n "$backed_up" ] && ! restore "$run_dir"; then
    echo "!!! RESTORE FAILED: $data may not match the backup. The services ($services) stay stopped." >&2
    echo "!!! Recover by hand in the VM: robocopy '$backup' '$data' /MIR /COPYALL /DCOPY:DAT, compare the hashes with $run_dir/state-before.txt, then Start-Service $services" >&2
    services=''
  fi
  start_services
  if [ -z "$snapshot" ] && [ "$("${V[@]}" domstate "$vm")" = running ]; then gx "Remove-Item -Recurse -Force -LiteralPath '$dir' -ErrorAction SilentlyContinue"; fi
  vm_off
}
trap cleanup EXIT

# login: set $token. The first call only sets the auth-binding cookie; the second returns tokens.
# Access tokens last 15 minutes, so every run logs in again.
login() {
  local jar t=''
  jar=$(mktemp)
  for _ in 1 2; do
    t=$(curl -sS -b "$jar" -c "$jar" -H 'Content-Type: application/json' "$BREEZE_STACK_URL/api/v1/auth/login" \
      -d "$(jq -nc --arg e "$BREEZE_ADMIN_EMAIL" --arg p "$BREEZE_ADMIN_PASSWORD" '{email:$e,password:$p}')" | jq -r '.tokens.accessToken // empty')
    [ -z "$t" ] || break
  done
  rm -f "$jar"
  [ -n "$t" ] || { echo "login to $BREEZE_STACK_URL failed" >&2; return 1; }
  token=$t
}
files=$(mktemp -d)
cp "$agent" "$files/breeze-agent.exe"
cp "$(dirname "$0")/sample-process.ps1" "$files/"
secret_arg=''
if [ -n "${BREEZE_ENROLLMENT_SECRET:-}" ]; then secret_arg="--enrollment-secret '$BREEZE_ENROLLMENT_SECRET'"; fi
agent_sha=$(sha256sum "$agent" | cut -d' ' -f1)

for run in $(seq "$runs"); do
  run_dir="$out/run-$run"
  mkdir -p "$run_dir"
  echo "run $run/$runs: $workload for $seconds s" >&2
  login
  echo "run $run: logged in" >&2
  site=$(api GET /orgs/sites | jq -c '.data[0]')
  if [ -n "$snapshot" ]; then "${V[@]}" snapshot-revert "$vm" "$snapshot"; fi
  [ "$("${V[@]}" domstate "$vm")" = running ] || "${V[@]}" start "$vm" >/dev/null
  for _ in $(seq 300); do ga '{"execute":"guest-ping"}' >/dev/null 2>&1 && break; sleep 1; done
  ga '{"execute":"guest-ping"}' >/dev/null

  if [ -z "$snapshot" ]; then
    gx "if (Test-Path -LiteralPath '$backup') { throw 'a backup from an earlier run exists at $backup; restore it by hand first' }"
    # Let boot-time starts settle, then stop the watchdog first so it cannot restart the agent.
    services=$(gx "for (\$i = 0; \$i -lt 60 -and (Get-Service *breeze* | Where-Object Status -like '*Pending'); \$i++) { Start-Sleep 2 }
      (Get-Service *breeze* | Where-Object Status -eq Running | Sort-Object { \$_.Name -notlike '*Watchdog*' }).Name -join ','" 180)
    [ -z "$services" ] || gx "foreach (\$n in '$services'.Split(',')) {
        for (\$i = 0; (Get-Service \$n).Status -ne 'Stopped'; \$i++) {
          if (\$i -ge 30) { throw \"\$n did not stop\" }
          try { Stop-Service -Force \$n } catch { }; Start-Sleep 2 } }" 180
    gx "Get-Process breeze* -ErrorAction SilentlyContinue | Stop-Process -Force; Start-Sleep 2"
    hash_state "$data" >"$run_dir/state-before.txt"
    # Only a complete, verified backup may ever be mirrored back over the live data.
    if robocopy_mirror "$data" "$backup" && hash_state "$backup" >"$run_dir/state-backup.txt" &&
      diff -q "$run_dir/state-before.txt" "$run_dir/state-backup.txt" >/dev/null; then
      backed_up=1
    else
      echo "backup of $data failed or does not match; removing it and restarting the services without a restore" >&2
      gx "Remove-Item -Recurse -Force -LiteralPath '$backup' -ErrorAction SilentlyContinue" || true
      exit 1
    fi
  fi

  python3 -I -m http.server "$port" --bind "$bridge" --directory "$files" >/dev/null 2>&1 &
  srv=$!
  for _ in $(seq 30); do curl -fs -o /dev/null "http://$bridge:$port/" && break; sleep 0.5; done
  vm_sha=$(gx "New-Item -ItemType Directory -Force '$dir' | Out-Null
    foreach (\$f in 'breeze-agent.exe','sample-process.ps1') { Invoke-WebRequest -UseBasicParsing http://$bridge:$port/\$f -OutFile $dir\\\$f }
    (Get-FileHash $dir\\breeze-agent.exe -Algorithm SHA256).Hash.ToLower()" 300)
  stop_pid "$srv"; srv=''
  [ "$vm_sha" = "$agent_sha" ] || { echo "agent copy hash mismatch" >&2; exit 1; }

  setsid socat "TCP-LISTEN:$port,bind=$bridge,fork,reuseaddr" "TCP:127.0.0.1:$stack_port" &
  relay=$!
  for _ in $(seq 30); do [ -z "$(ss -Hltn "src $bridge:$port")" ] || break; sleep 0.5; done
  [ -n "$(ss -Hltn "src $bridge:$port")" ] || { echo "relay on $bridge:$port never listened" >&2; exit 1; }
  key=$(api POST /enrollment-keys -d "$(jq -nc --argjson s "$site" '{orgId:$s.orgId,siteId:$s.id,name:"perf-lab",maxUsage:1,ttlMinutes:60}')" | jq -r .key)
  gx "\$env:BREEZE_AGENT_ENROLLMENT_KEY='$key'
    & $dir\\breeze-agent.exe enroll --config $dir\\agent.yaml --server http://$bridge:$port $secret_arg --quiet; exit \$LASTEXITCODE" >"$run_dir/enroll.txt"
  # WMI starts the agent outside this guest-exec, so guest-exec does not wait on the agent's inherited pipes.
  gx "\$r = Invoke-CimMethod Win32_Process -MethodName Create -Arguments @{ CommandLine = '$dir\\breeze-agent.exe start --config $dir\\agent.yaml' }; if (\$r.ReturnValue) { throw \"Win32_Process.Create returned \$(\$r.ReturnValue)\" }" >/dev/null
  agent_id=$(gx "(Select-String -LiteralPath $dir\\agent.yaml -Pattern '^agent_id:\s*(\S+)').Matches[0].Groups[1].Value.Trim('\"')")
  device=$(sql "select id from devices where agent_id = '$agent_id'")

  sampler=$(gx_start "& $dir\\sample-process.ps1 -Path $dir\\breeze-agent.exe -Seconds $seconds -Out $dir\\sample.csv")
  if [ "$workload" = scan ]; then
    api POST "/devices/$device/commands" -d '{"type":"refresh_inventory"}' >/dev/null
    api POST /patches/scan -d "{\"deviceIds\":[\"$device\"]}" >/dev/null
  fi
  gx_wait "$sampler" $((seconds + 120))
  gx "Get-Content $dir\\sample.csv" >"$run_dir/sample.csv"
  sql "select custom_metrics->'agentRuntime' from device_metrics where device_id = '$device' and custom_metrics ? 'agentRuntime' order by timestamp desc limit 1" >"$run_dir/agent-runtime.json"
  jq -r .goroutines "$run_dir/agent-runtime.json" >"$run_dir/goroutines.txt"
  sql "select type, status from device_commands where device_id = '$device' order by created_at" >"$run_dir/commands.txt"
  stop_group "$relay"; relay=''

  gx "Get-Process breeze* -ErrorAction SilentlyContinue | Stop-Process -Force; Start-Sleep 2"
  if [ -n "$backed_up" ]; then restore "$run_dir"; fi
  start_services
  gx "Remove-Item -Recurse -Force -LiteralPath '$dir'"
  vm_off
  echo "run $run: $(($(wc -l <"$run_dir/sample.csv") - 1)) samples, $(cat "$run_dir/goroutines.txt") goroutines" >&2
done
