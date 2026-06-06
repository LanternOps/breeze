#!/usr/bin/env bash
#
# Breeze RMM — Automated Restore Verification (DR gap #6)
#
# Proves the off-region backup is actually restorable, on a schedule. Pulls the
# latest Postgres dump from the off-region Spaces bucket, restores it into a
# throwaway dockerized Postgres, asserts the data looks sane, then tears the
# scratch DB down. Designed to run weekly via cron and page on failure.
#
# This closes the "no proven backup restore" finding: backup.sh + restore.sh
# already work, but nothing exercised the restore path automatically.
#
# Usage:
#   ./scripts/ops/restore-test.sh
#
# Environment variables (off-region source — same bucket offsite-backup.sh writes):
#   OFFSITE_S3_ENDPOINT       e.g. https://nyc3.digitaloceanspaces.com  (required)
#   OFFSITE_S3_BUCKET         bucket name                               (required)
#   OFFSITE_S3_ACCESS_KEY     Spaces access key                         (required)
#   OFFSITE_S3_SECRET_KEY     Spaces secret key                         (required)
#   OFFSITE_S3_PREFIX         key prefix (default: db)
#   OFFSITE_S3_KEY            dump key to test (default: <prefix>/latest.dump, or
#                             <prefix>/latest.dump.gpg when encryption is enabled)
#   OFFSITE_BACKUP_GPG_PASSPHRASE
#                             if set, the downloaded artifact is gpg-decrypted
#                             before restore (must match offsite-backup.sh)
#
#   RESTORE_TEST_PG_IMAGE     postgres image (default: postgres:16)
#   RESTORE_TEST_MIN_DEVICES  minimum device rows to consider the restore sane
#                             (default: 1)
#   RESTORE_TEST_ALERT_URL    optional webhook (Slack/Alertmanager) POSTed on
#                             failure; if unset, failures only log + exit non-zero
#   RESTORE_TEST_HEARTBEAT_URL optional dead-man's-switch ping URL (e.g. a
#                             healthchecks.io check); pinged on each PASS so a
#                             silently-stopped cron (host down, creds expired,
#                             script removed) — which emits no failure — becomes
#                             the alarm via absence of the ping. Unset = no ping.
#
# Exit codes:
#   0 — restore verified
#   1 — restore ran but verification failed (data missing/short)
#   2 — could not run the test (missing dump, docker, env, etc.)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

OFFSITE_S3_PREFIX="${OFFSITE_S3_PREFIX:-db}"
if [ -n "${OFFSITE_BACKUP_GPG_PASSPHRASE:-}" ]; then
  OFFSITE_S3_KEY="${OFFSITE_S3_KEY:-${OFFSITE_S3_PREFIX}/latest.dump.gpg}"
else
  OFFSITE_S3_KEY="${OFFSITE_S3_KEY:-${OFFSITE_S3_PREFIX}/latest.dump}"
fi
PG_IMAGE="${RESTORE_TEST_PG_IMAGE:-postgres:16}"
MIN_DEVICES="${RESTORE_TEST_MIN_DEVICES:-1}"

CONTAINER="breeze-restore-test-$$"
WORKDIR="$(mktemp -d)"
PG_PASSWORD="restore-test-$$"
PG_PORT="55432"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [restore-test] $*"; }

alert() {
  local msg="$1"
  log "ALERT: ${msg}"
  if [ -n "${RESTORE_TEST_ALERT_URL:-}" ]; then
    curl -fsS -m 10 -X POST -H 'Content-Type: application/json' \
      -d "{\"text\":\"[Breeze restore-test FAILED] ${msg}\"}" \
      "${RESTORE_TEST_ALERT_URL}" >/dev/null 2>&1 || log "WARNING: alert webhook POST failed"
  fi
}

# Dead-man's-switch success ping. A failure-only alert can't distinguish "the
# restore test passed" from "the test never ran" — both are silent. Ping a
# monitor on every PASS so the monitor alerts when the ping goes stale.
heartbeat() {
  if [ -n "${RESTORE_TEST_HEARTBEAT_URL:-}" ]; then
    curl -fsS -m 10 --retry 3 "${RESTORE_TEST_HEARTBEAT_URL}" >/dev/null 2>&1 \
      || log "WARNING: success heartbeat ping failed"
  fi
}

cleanup() {
  docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true
  rm -rf "${WORKDIR}" || true
}
trap cleanup EXIT

fail() { alert "$1"; exit "${2:-1}"; }

# --- preflight ---
for var in OFFSITE_S3_ENDPOINT OFFSITE_S3_BUCKET OFFSITE_S3_ACCESS_KEY OFFSITE_S3_SECRET_KEY; do
  [ -n "${!var:-}" ] || fail "${var} is required" 2
done
command -v docker >/dev/null 2>&1 || fail "docker is required" 2
command -v aws >/dev/null 2>&1 || fail "aws CLI is required" 2

# --- 1) pull the latest off-region dump ---
export AWS_ACCESS_KEY_ID="${OFFSITE_S3_ACCESS_KEY}"
export AWS_SECRET_ACCESS_KEY="${OFFSITE_S3_SECRET_KEY}"
DUMP_FILE="${WORKDIR}/latest.dump"
log "Fetching s3://${OFFSITE_S3_BUCKET}/${OFFSITE_S3_KEY}"
if ! aws --endpoint-url "${OFFSITE_S3_ENDPOINT}" s3 cp \
     "s3://${OFFSITE_S3_BUCKET}/${OFFSITE_S3_KEY}" "${DUMP_FILE}" --only-show-errors; then
  fail "could not download dump ${OFFSITE_S3_KEY} from off-region bucket" 2
fi
dump_size="$(du -h "${DUMP_FILE}" | cut -f1)"
log "Downloaded dump (${dump_size})"

# Guard against a truncated/empty object passing as a "backup".
dump_bytes="$(wc -c < "${DUMP_FILE}" | tr -d ' ')"
[ "${dump_bytes}" -gt 1024 ] || fail "downloaded dump is suspiciously small (${dump_bytes} bytes)" 1

# Decrypt if the artifact is gpg-encrypted (must match offsite-backup.sh).
if [ -n "${OFFSITE_BACKUP_GPG_PASSPHRASE:-}" ]; then
  command -v gpg >/dev/null 2>&1 || fail "gpg required to decrypt backup" 2
  log "Decrypting dump"
  DEC_FILE="${WORKDIR}/latest.decrypted.dump"
  if ! printf '%s' "${OFFSITE_BACKUP_GPG_PASSPHRASE}" \
       | gpg --batch --yes --no-symkey-cache --passphrase-fd 0 \
             --decrypt --output "${DEC_FILE}" "${DUMP_FILE}"; then
    fail "gpg decryption failed (wrong passphrase?)" 1
  fi
  DUMP_FILE="${DEC_FILE}"
fi

# --- 2) spin up scratch postgres ---
log "Starting scratch ${PG_IMAGE} (container ${CONTAINER})"
docker run -d --name "${CONTAINER}" \
  -e POSTGRES_PASSWORD="${PG_PASSWORD}" \
  -e POSTGRES_DB=breeze \
  -p "127.0.0.1:${PG_PORT}:5432" \
  "${PG_IMAGE}" >/dev/null || fail "failed to start scratch postgres" 2

SCRATCH_URL="postgresql://postgres:${PG_PASSWORD}@127.0.0.1:${PG_PORT}/breeze"

log "Waiting for scratch postgres to accept connections..."
ready=false
for _ in $(seq 1 30); do
  if docker exec "${CONTAINER}" pg_isready -U postgres -d breeze >/dev/null 2>&1; then
    ready=true; break
  fi
  sleep 1
done
$ready || fail "scratch postgres never became ready" 2

# --- 3) restore via the existing, tested restore.sh ---
# restore.sh runs pg_restore + a device-count sanity check; we point it at the
# scratch DB and auto-confirm. pg_restore/psql must be present on the host.
log "Restoring dump into scratch DB via restore.sh"
if ! DATABASE_URL="${SCRATCH_URL}" RESTORE_SKIP_CONFIRM=yes \
     "${REPO_ROOT}/scripts/restore.sh" --db "${DUMP_FILE}"; then
  fail "restore.sh failed against scratch DB — backup is NOT restorable" 1
fi

# --- 4) independent assertion (don't just trust restore.sh's own check) ---
device_count="$(docker exec -e PGPASSWORD="${PG_PASSWORD}" "${CONTAINER}" \
  psql -U postgres -d breeze -t -A -c 'SELECT count(*) FROM devices;' 2>/dev/null | tr -d '[:space:]' || echo ERR)"

case "${device_count}" in
  ''|*[!0-9]*) fail "post-restore device count query failed (got '${device_count}')" 1 ;;
esac
if [ "${device_count}" -lt "${MIN_DEVICES}" ]; then
  fail "restored DB has ${device_count} devices (< ${MIN_DEVICES} expected) — possible empty/partial backup" 1
fi

log "SUCCESS: restore verified — ${device_count} devices, dump ${dump_size}"
heartbeat
exit 0
