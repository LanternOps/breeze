#!/usr/bin/env bash
#
# Breeze RMM — Off-Region Backup
#
# Runs the local backup (scripts/backup.sh) then pushes the resulting Postgres
# dump (and optionally the encrypted config bundle) to an off-region,
# S3-compatible bucket — on DigitalOcean, a Spaces bucket created in a DIFFERENT
# region than the droplet. That foreign-region copy is what survives a full
# region/droplet loss; the local BACKUP_DIR copy does not.
#
# Recommended bucket setup (one-time, in the DO control panel or via s3api):
#   - Create the Spaces bucket in a region other than your droplet's region.
#   - Enable Bucket Versioning so a corrupt/encrypted dump can't clobber good
#     history, and a lifecycle rule to expire noncurrent versions after N days.
#
# Usage:
#   ./scripts/ops/offsite-backup.sh            # db dump -> offsite
#   ./scripts/ops/offsite-backup.sh --config   # also push encrypted config bundle
#
# Environment variables:
#   DATABASE_URL              Postgres connection string (passed to backup.sh)
#   BACKUP_DIR                Local backup dir (default: /var/backups/breeze)
#   BACKUP_ENCRYPTION_KEY     Required only with --config
#
#   OFFSITE_S3_ENDPOINT       Off-region Spaces endpoint, e.g.
#                             https://nyc3.digitaloceanspaces.com   (required)
#   OFFSITE_S3_BUCKET         Off-region bucket name                 (required)
#   OFFSITE_S3_ACCESS_KEY     Spaces access key                      (required)
#   OFFSITE_S3_SECRET_KEY     Spaces secret key                      (required)
#   OFFSITE_S3_PREFIX         Key prefix in the bucket (default: db)
#   OFFSITE_BACKUP_GPG_PASSPHRASE
#                             If set, the dump is gpg-encrypted (AES256) before
#                             upload and stored as <name>.gpg / latest.dump.gpg.
#                             Strongly recommended — the dump contains all tenant
#                             data in the clear (app-layer field encryption only
#                             covers designated secret columns). KEEP THIS
#                             PASSPHRASE IN AN OFFLINE VAULT TOO — losing it makes
#                             every off-region backup unrecoverable.
#
# Exit codes:
#   0 — backup created and uploaded
#   1 — backup created but upload failed
#   2 — backup step failed (nothing to upload)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/breeze}"
OFFSITE_S3_PREFIX="${OFFSITE_S3_PREFIX:-db}"
PUSH_CONFIG=false

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [offsite] $*"; }
die() { log "FATAL: $*" >&2; exit "${2:-2}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --config) PUSH_CONFIG=true ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
  shift
done

for var in OFFSITE_S3_ENDPOINT OFFSITE_S3_BUCKET OFFSITE_S3_ACCESS_KEY OFFSITE_S3_SECRET_KEY; do
  if [ -z "${!var:-}" ]; then die "${var} is required"; fi
done
command -v aws >/dev/null 2>&1 || die "aws CLI is required (install awscli)"

# 1) Produce the local backups via the existing, tested script.
backup_flags=(--db)
$PUSH_CONFIG && backup_flags+=(--config)
log "Running local backup: backup.sh ${backup_flags[*]}"
if ! "${REPO_ROOT}/scripts/backup.sh" "${backup_flags[@]}"; then
  # backup.sh exit 1 = partial; still try to upload whatever db dump exists.
  log "WARNING: backup.sh reported a non-zero exit; will upload any dump produced"
fi

# 2) Find the newest dump just written.
latest_dump="$(find "${BACKUP_DIR}" -maxdepth 1 -name 'db_*.dump' -type f -print0 \
  | xargs -0 ls -t 2>/dev/null | head -1 || true)"
[ -n "${latest_dump}" ] || die "No db_*.dump found in ${BACKUP_DIR} to upload"

# 2b) Encrypt the dump before it leaves the host. App-layer field encryption only
#     covers designated secret columns; the dump still contains all tenant PII and
#     operational data in the clear, so we gpg the whole artifact (defense in depth).
upload_dump="${latest_dump}"
upload_suffix=""
if [ -n "${OFFSITE_BACKUP_GPG_PASSPHRASE:-}" ]; then
  command -v gpg >/dev/null 2>&1 || die "gpg required when OFFSITE_BACKUP_GPG_PASSPHRASE is set"
  log "Encrypting dump with gpg (AES256)"
  if printf '%s' "${OFFSITE_BACKUP_GPG_PASSPHRASE}" \
       | gpg --batch --yes --no-symkey-cache --passphrase-fd 0 \
             --cipher-algo AES256 --symmetric \
             --output "${latest_dump}.gpg" "${latest_dump}"; then
    upload_dump="${latest_dump}.gpg"
    upload_suffix=".gpg"
  else
    rm -f "${latest_dump}.gpg"
    die "gpg encryption failed"
  fi
else
  log "WARNING: OFFSITE_BACKUP_GPG_PASSPHRASE not set — uploading an UNENCRYPTED dump"
fi

export AWS_ACCESS_KEY_ID="${OFFSITE_S3_ACCESS_KEY}"
export AWS_SECRET_ACCESS_KEY="${OFFSITE_S3_SECRET_KEY}"
s3() { aws --endpoint-url "${OFFSITE_S3_ENDPOINT}" s3 "$@"; }

upload() {
  local src="$1" key="$2"
  log "Uploading $(basename "${src}") -> s3://${OFFSITE_S3_BUCKET}/${key}"
  s3 cp "${src}" "s3://${OFFSITE_S3_BUCKET}/${key}" --only-show-errors
}

rc=0
dump_key="${OFFSITE_S3_PREFIX}/$(basename "${upload_dump}")"
upload "${upload_dump}" "${dump_key}" || rc=1
# A stable pointer to the most recent dump so the restore test doesn't have to
# list+sort the bucket. Versioning keeps prior 'latest.dump' contents.
upload "${upload_dump}" "${OFFSITE_S3_PREFIX}/latest.dump${upload_suffix}" || rc=1

if $PUSH_CONFIG; then
  latest_cfg="$(find "${BACKUP_DIR}" -maxdepth 1 -name 'config_*.tar.gz.enc' -type f -print0 \
    | xargs -0 ls -t 2>/dev/null | head -1 || true)"
  if [ -n "${latest_cfg}" ]; then
    upload "${latest_cfg}" "config/$(basename "${latest_cfg}")" || rc=1
  else
    log "WARNING: --config requested but no config bundle found to upload"
    rc=1
  fi
fi

# Drop the local encrypted copy; the plaintext db_*.dump stays for local
# retention/restore and is pruned by backup.sh's retention sweep.
[ -n "${upload_suffix}" ] && rm -f "${latest_dump}.gpg"

if [ $rc -eq 0 ]; then
  log "Off-region backup complete"
  exit 0
fi
log "ERROR: one or more uploads failed"
exit 1
