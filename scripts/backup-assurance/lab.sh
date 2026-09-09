#!/usr/bin/env bash
# Backup-assurance API driver: drives device backups through the real Breeze API
# exactly as the web UI does (curl + jq). Source it or call subcommands.
#
#   export LAB_API=http://localhost:33933/api/v1 LAB_EMAIL=admin@breeze.local LAB_PASSWORD='BreezeAdmin123!'
#   lab.sh login                              # caches token + orgId in $LAB_STATE (default ~/.breeze-lab.json)
#   lab.sh ids                                # partner / org / site ids
#   lab.sh devices                            # id  hostname  os  status
#   lab.sh enroll-key [site-id]               # prints a fresh enrollment key (plaintext, once)
#   lab.sh config-s3 <name> <endpoint> <bucket> <accessKey> <secretKey> [region]
#   lab.sh config-local <name> <path>
#   lab.sh profile <name> '<selections-json>'  # e.g. '{"file":{"enabled":true,"paths":["/x"]}}'
#   lab.sh policy <name> <profile-id> <config-id> ['<retention-json>']   # creates policy + backup link
#   lab.sh assign <policy-id> <device-id>
#   lab.sh run <device-id>                    # prints job ids (one per selection)
#   lab.sh wait-job <job-id> [timeout-s]      # polls to a terminal status, prints the job JSON
#   lab.sh job <job-id> | jobs <device-id>
#   lab.sh snapshots <device-id> | snapshot <id> | browse <snapshot-id>
#   lab.sh restore <snapshot-id> ['<extra-json>']   # extra: {"targetPath":..,"deviceId":..,"restoreType":"selective","selectedPaths":[..]}
#   lab.sh wait-restore <restore-id> [timeout-s]
#   lab.sh verify <device-id> <snapshot-id> <integrity|test_restore>
#   lab.sh wait-verify <verification-id> [timeout-s]
#   lab.sh cancel-job <job-id> | cancel-restore <restore-id>
#   lab.sh bmr-token <snapshot-id> [hours]    # prints {id, token, bootstrap}
#   lab.sh bmr-media <token-id> <platform> <arch> ; bmr-media-wait <media-id> ; bmr-media-download <media-id> <out>
#   lab.sh gc                                 # enqueues cleanup-expired-snapshots on the backup queue (needs $LAB_REDIS_CONTAINER)
#   lab.sh api <METHOD> <path> [json]         # raw call with auth + orgId
set -euo pipefail
LAB_API=${LAB_API:-http://localhost:33933/api/v1}
LAB_EMAIL=${LAB_EMAIL:-admin@breeze.local}
LAB_PASSWORD=${LAB_PASSWORD:-BreezeAdmin123!}
LAB_STATE=${LAB_STATE:-$HOME/.breeze-lab.json}

state_get() { [ -f "$LAB_STATE" ] && jq -r ".$1 // empty" "$LAB_STATE" || true; }
state_set() { local tmp; tmp=$(mktemp); { [ -f "$LAB_STATE" ] && cat "$LAB_STATE" || echo '{}'; } | jq --arg k "$1" --arg v "$2" '.[$k]=$v' > "$tmp"; mv "$tmp" "$LAB_STATE"; }

login() {
  local resp tok
  resp=$(curl -sS -X POST "$LAB_API/auth/login" -H 'content-type: application/json' \
    -d "$(jq -cn --arg e "$LAB_EMAIL" --arg p "$LAB_PASSWORD" '{email:$e,password:$p}')")
  tok=$(echo "$resp" | jq -r '.tokens.accessToken // empty')
  [ -n "$tok" ] || { echo "login failed: $resp" >&2; return 1; }
  state_set token "$tok"
  local org
  org=$(curl -sS "$LAB_API/orgs" -H "authorization: Bearer $tok" | jq -r '(.data // .)[] | select(.slug=="default-organization" or .name=="Default Organization") | .id' | head -1)
  [ -n "$org" ] || org=$(curl -sS "$LAB_API/orgs" -H "authorization: Bearer $tok" | jq -r '(.data // .)[0].id')
  state_set orgId "$org"
  echo "logged in; orgId=$org"
}

tok() { local t; t=$(state_get token); [ -n "$t" ] || { login >&2; t=$(state_get token); }; echo "$t"; }
org() { local o; o=$(state_get orgId); [ -n "$o" ] || { login >&2; o=$(state_get orgId); }; echo "$o"; }

# api METHOD path [json] — path relative to LAB_API, orgId appended automatically.
api() {
  local m=$1 p=$2 body=${3:-}
  local sep='?'; [[ "$p" == *\?* ]] && sep='&'
  local url="$LAB_API$p${sep}orgId=$(org)"
  local out code
  if [ -n "$body" ]; then
    out=$(curl -sS -w '\n%{http_code}' -X "$m" "$url" -H "authorization: Bearer $(tok)" -H 'content-type: application/json' -d "$body")
  else
    out=$(curl -sS -w '\n%{http_code}' -X "$m" "$url" -H "authorization: Bearer $(tok)")
  fi
  code=${out##*$'\n'}; out=${out%$'\n'*}
  if [ "$code" = 401 ]; then login >&2; api "$m" "$p" "$body"; return; fi
  if [ "${code:0:1}" != 2 ]; then echo "HTTP $code $m $p: $out" >&2; echo "$out"; return 22; fi
  echo "$out"
}

ids() {
  local o; o=$(org)
  api GET /orgs | jq -c "(.data // .)[] | select(.id==\"$o\") | {orgId:.id, name, partnerId}"
  api GET "/orgs/sites?organizationId=$o" | jq -c '(.data // .)[] | {siteId:.id, name}'
}
devices() { api GET "/devices?limit=100" | jq -r '(.data // .)[] | [.id, .hostname, .osType, .status, (.agentVersion // "-")] | @tsv'; }
enroll_key() {
  local site=${1:-}; [ -n "$site" ] || site=$(api GET "/orgs/sites?organizationId=$(org)" | jq -r '(.data // .)[0].id')
  api POST /enrollment-keys "$(jq -cn --arg o "$(org)" --arg s "$site" '{orgId:$o,siteId:$s,name:("lab-"+(now|tostring)),maxUsage:20,ttlMinutes:1440}')" | jq -r '.key'
}
config_s3() {
  local name=$1 endpoint=$2 bucket=$3 ak=$4 sk=$5 region=${6:-us-east-1}
  api POST /backup/configs "$(jq -cn --arg n "$name" --arg e "$endpoint" --arg b "$bucket" --arg a "$ak" --arg s "$sk" --arg r "$region" \
    '{name:$n,provider:"s3",enabled:true,encryption:false,details:{endpoint:$e,bucket:$b,region:$r,accessKey:$a,secretKey:$s}}')" | jq -r '.id'
}
config_local() { api POST /backup/configs "$(jq -cn --arg n "$1" --arg p "$2" '{name:$n,provider:"local",enabled:true,details:{path:$p}}')" | jq -r '.id'; }
profile() {
  api POST /backup/profiles "$(jq -cn --arg n "$1" --arg o "$(org)" --argjson sel "$2" '{name:$n,description:"backup-assurance",ownerScope:"organization",orgId:$o,isActive:true,selections:$sel}')" | jq -r '.data.id // .id'
}
policy() {
  local name=$1 profile=$2 config=$3 retention=${4:-'{"preset":"custom","retentionDays":14,"maxVersions":50,"keepDaily":7,"keepWeekly":4,"keepMonthly":3}'}
  local pid
  pid=$(api POST /configuration-policies "$(jq -cn --arg n "$name" --arg o "$(org)" '{name:$n,description:"backup-assurance",status:"active",orgId:$o,ownerScope:"organization"}')" | jq -r '.id')
  api POST "/configuration-policies/$pid/features" "$(jq -cn --arg p "$profile" --arg c "$config" --argjson r "$retention" \
    '{featureType:"backup",featurePolicyId:$p,inlineSettings:{destinationConfigId:$c,schedule:{frequency:"daily",time:"02:00",timezone:"UTC"},retention:$r}}')" > /dev/null
  echo "$pid"
}
assign() { api POST "/configuration-policies/$1/assignments" "$(jq -cn --arg d "$2" '{level:"device",targetId:$d,priority:0}')" | jq -c '{id, level, targetId}'; }
run() { api POST "/backup/jobs/run/$1" | jq -r '.jobs[]?.id // .id'; }
job() { api GET "/backup/jobs/$1"; }
jobs() { api GET "/backup/jobs?deviceId=$1" | jq -c '(.data // .)[] | {id, type, status, snapshotId, fileCount, totalSize, transferredSize, referencedFiles, errorCount, errorLog, createdAt, completedAt}'; }
wait_job() {
  local id=$1 timeout=${2:-1800} start=$SECONDS j st
  while :; do
    j=$(job "$id"); st=$(echo "$j" | jq -r .status)
    case "$st" in completed|failed|cancelled|partial) echo "$j"; return 0 ;; esac
    [ $((SECONDS - start)) -lt "$timeout" ] || { echo "$j"; echo "TIMEOUT waiting for job $id (status $st)" >&2; return 1; }
    sleep 3
  done
}
snapshots() { api GET "/backup/snapshots?deviceId=$1" | jq -c '(.data // .)[] | {id, backupType, sizeBytes, fileCount, createdAt, expiresAt, location}'; }
snapshot() { api GET "/backup/snapshots/$1"; }
browse() { api GET "/backup/snapshots/$1/browse"; }
restore() { api POST /backup/restore "$(jq -cn --arg s "$1" --argjson x "${2:-{\}}" '{snapshotId:$s,restoreType:"full"} + $x')" | jq -r '.data.id // .id'; }
restore_get() { api GET "/backup/restore/$1" | jq '.data // .'; }
wait_restore() {
  local id=$1 timeout=${2:-1800} start=$SECONDS r st
  while :; do
    r=$(restore_get "$id"); st=$(echo "$r" | jq -r .status)
    case "$st" in completed|failed|cancelled|partial) echo "$r"; return 0 ;; esac
    [ $((SECONDS - start)) -lt "$timeout" ] || { echo "$r"; echo "TIMEOUT waiting for restore $id (status $st)" >&2; return 1; }
    sleep 3
  done
}
verify() { api POST /backup/verify "$(jq -cn --arg d "$1" --arg s "$2" --arg t "${3:-integrity}" '{deviceId:$d,snapshotId:$s,verificationType:$t}')" | jq -r '.data.verification.id // .data.id // .id'; }
verify_get() { api GET "/backup/verifications?limit=200" | jq --arg id "$1" '(.data // .)[] | select(.id==$id)'; }
wait_verify() {
  local id=$1 timeout=${2:-1800} start=$SECONDS v st
  while :; do
    v=$(verify_get "$id"); st=$(echo "$v" | jq -r .status)
    case "$st" in passed|failed|partial) echo "$v"; return 0 ;; esac
    [ $((SECONDS - start)) -lt "$timeout" ] || { echo "$v"; echo "TIMEOUT waiting for verification $id (status $st)" >&2; return 1; }
    sleep 3
  done
}
cancel_job() { api POST "/backup/jobs/$1/cancel" | jq -c '{id, status, warning}'; }
cancel_restore() { api POST "/backup/restore/$1/cancel" | jq -c '.data // .'; }
bmr_token() { api POST /backup/bmr/tokens "$(jq -cn --arg s "$1" --argjson h "${2:-24}" '{snapshotId:$s,restoreType:"bare_metal",expiresInHours:$h}')"; }
bmr_media() { api POST /backup/bmr/media "$(jq -cn --arg t "$1" --arg p "$2" --arg a "$3" '{tokenId:$t,platform:$p,architecture:$a}')" | jq -r '.id'; }
bmr_media_wait() {
  local id=$1 timeout=${2:-600} start=$SECONDS m st
  while :; do
    m=$(api GET "/backup/bmr/media/$id"); st=$(echo "$m" | jq -r .status)
    case "$st" in ready|ready_signed|legacy_unsigned|failed|expired) echo "$m"; return 0 ;; esac
    [ $((SECONDS - start)) -lt "$timeout" ] || { echo "$m"; echo "TIMEOUT media $id ($st)" >&2; return 1; }
    sleep 3
  done
}
bmr_media_download() { curl -sS -L -o "$2" "$LAB_API/backup/bmr/media/$1/download?orgId=$(org)" -H "authorization: Bearer $(tok)"; ls -la "$2"; }
gc() {
  local c=${LAB_REDIS_CONTAINER:?set LAB_REDIS_CONTAINER}
  # BullMQ job on queue "backup", name "cleanup-expired-snapshots" (backupWorker.ts). Use the API's own
  # Node runtime so the payload shape is exactly what the worker validates.
  docker exec "${LAB_API_CONTAINER:?set LAB_API_CONTAINER}" node -e '
    const {Queue}=require("bullmq");
    const q=new Queue("backup",{connection:{host:process.env.REDIS_HOST||"redis",port:Number(process.env.REDIS_PORT||6379)}});
    q.add("cleanup-expired-snapshots",{type:"cleanup-expired-snapshots",meta:{actorType:"system",actorId:null,source:"backup-assurance"}}).then(j=>{console.log("enqueued",j.id);return q.close()}).catch(e=>{console.error(e);process.exit(1)});'
}

cmd=${1:-}; shift || true
case "$cmd" in
  login) login ;;
  ids) ids ;;
  devices) devices ;;
  enroll-key) enroll_key "$@" ;;
  config-s3) config_s3 "$@" ;;
  config-local) config_local "$@" ;;
  profile) profile "$@" ;;
  policy) policy "$@" ;;
  assign) assign "$@" ;;
  run) run "$@" ;;
  job) job "$@" ;;
  jobs) jobs "$@" ;;
  wait-job) wait_job "$@" ;;
  snapshots) snapshots "$@" ;;
  snapshot) snapshot "$@" ;;
  browse) browse "$@" ;;
  restore) restore "$@" ;;
  restore-get) restore_get "$@" ;;
  wait-restore) wait_restore "$@" ;;
  verify) verify "$@" ;;
  verify-get) verify_get "$@" ;;
  wait-verify) wait_verify "$@" ;;
  cancel-job) cancel_job "$@" ;;
  cancel-restore) cancel_restore "$@" ;;
  bmr-token) bmr_token "$@" ;;
  bmr-media) bmr_media "$@" ;;
  bmr-media-wait) bmr_media_wait "$@" ;;
  bmr-media-download) bmr_media_download "$@" ;;
  gc) gc ;;
  api) api "$@" ;;
  *) sed -n '2,30p' "$0"; exit 2 ;;
esac
