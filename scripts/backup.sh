#!/usr/bin/env bash
#
# Breeze RMM — Backup Script
#
# Usage:
#   ./scripts/backup.sh --all
#   ./scripts/backup.sh --db
#   ./scripts/backup.sh --storage
#   ./scripts/backup.sh --config
#   ./scripts/backup.sh --db --config
#
# Environment variables:
#   DATABASE_URL            PostgreSQL connection string (required for --db)
#   BACKUP_DIR              Destination directory (default: /var/backups/breeze)
#   BACKUP_RETENTION_DAYS   Delete backups older than N days (default: 30)
#   BACKUP_ENCRYPTION_KEY   Passphrase for config encryption (required for --config)
#   S3_ENDPOINT             MinIO/S3 endpoint (required for --storage)
#   S3_BUCKET               Bucket name (default: breeze)
#   S3_ACCESS_KEY           S3 access key (required for --storage)
#   S3_SECRET_KEY           S3 secret key (required for --storage)
#   BACKUP_STORAGE_TOOL     "aws" or "mc" (default: auto-detect)
#
# Exit codes:
#   0 — all requested backups succeeded
#   1 — partial failure (some backups succeeded, some failed)
#   2 — complete failure (all requested backups failed)

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

BACKUP_DIR="${BACKUP_DIR:-/var/backups/breeze}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
S3_BUCKET="${S3_BUCKET:-breeze}"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"

# Tracking
TASKS_REQUESTED=0
TASKS_SUCCEEDED=0

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

die() {
  log "FATAL: $*" >&2
  exit 2
}

ensure_dir() {
  if [ ! -d "$1" ]; then
    mkdir -p "$1"
    log "Created directory: $1"
  fi
}

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

DO_DB=false
DO_STORAGE=false
DO_CONFIG=false

if [ $# -eq 0 ]; then
  echo "Usage: $0 [--all | --db] [--storage] [--config]"
  echo "At least one flag is required."
  exit 2
fi

while [ $# -gt 0 ]; do
  case "$1" in
    --all)
      DO_DB=true
      DO_STORAGE=true
      DO_CONFIG=true
      ;;
    --db)       DO_DB=true ;;
    --storage)  DO_STORAGE=true ;;
    --config)   DO_CONFIG=true ;;
    -h|--help)
      echo "Usage: $0 [--all | --db] [--storage] [--config]"
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 2
      ;;
  esac
  shift
done

# ---------------------------------------------------------------------------
# Pre-flight checks
# ---------------------------------------------------------------------------

ensure_dir "${BACKUP_DIR}"

if $DO_DB; then
  TASKS_REQUESTED=$((TASKS_REQUESTED + 1))
  if [ -z "${DATABASE_URL:-}" ]; then
    die "DATABASE_URL is required for --db backups"
  fi
  if ! command -v pg_dump &>/dev/null; then
    die "pg_dump is not installed or not in PATH"
  fi
fi

if $DO_STORAGE; then
  TASKS_REQUESTED=$((TASKS_REQUESTED + 1))
  if [ -z "${S3_ENDPOINT:-}" ]; then
    die "S3_ENDPOINT is required for --storage backups"
  fi
  # Auto-detect storage tool
  BACKUP_STORAGE_TOOL="${BACKUP_STORAGE_TOOL:-}"
  if [ -z "$BACKUP_STORAGE_TOOL" ]; then
    if command -v mc &>/dev/null; then
      BACKUP_STORAGE_TOOL="mc"
    elif command -v aws &>/dev/null; then
      BACKUP_STORAGE_TOOL="aws"
    else
      die "Neither 'mc' (MinIO client) nor 'aws' CLI found. Install one for --storage backups."
    fi
  fi
fi

if $DO_CONFIG; then
  TASKS_REQUESTED=$((TASKS_REQUESTED + 1))
  if [ -z "${BACKUP_ENCRYPTION_KEY:-}" ]; then
    die "BACKUP_ENCRYPTION_KEY is required for --config backups"
  fi
  if ! command -v openssl &>/dev/null; then
    die "openssl is not installed or not in PATH"
  fi
fi

# ---------------------------------------------------------------------------
# Database backup
# ---------------------------------------------------------------------------

backup_database() {
  log "Starting database backup..."
  local dest="${BACKUP_DIR}/db_${TIMESTAMP}.dump"

  if pg_dump "${DATABASE_URL}" -Fc -Z 6 -f "${dest}" 2>&1; then
    local size
    size=$(du -h "${dest}" | cut -f1)
    log "Database backup complete: ${dest} (${size})"
    TASKS_SUCCEEDED=$((TASKS_SUCCEEDED + 1))
  else
    log "ERROR: Database backup failed"
    rm -f "${dest}"
    return 1
  fi
}

# ---------------------------------------------------------------------------
# Object storage backup
# ---------------------------------------------------------------------------

backup_storage() {
  log "Starting object storage backup..."
  local dest="${BACKUP_DIR}/storage_${TIMESTAMP}"
  ensure_dir "${dest}"

  local rc=0

  if [ "$BACKUP_STORAGE_TOOL" = "mc" ]; then
    # Configure MinIO client alias
    if ! mc alias set breeze-backup "${S3_ENDPOINT}" "${S3_ACCESS_KEY}" "${S3_SECRET_KEY}" --api S3v4 2>&1; then
      log "ERROR: Failed to configure MinIO client alias. Check S3_ENDPOINT, S3_ACCESS_KEY, and S3_SECRET_KEY."
      return 1
    fi
    if mc mirror "breeze-backup/${S3_BUCKET}" "${dest}/" 2>&1; then
      rc=0
    else
      rc=1
    fi
  elif [ "$BACKUP_STORAGE_TOOL" = "aws" ]; then
    export AWS_ACCESS_KEY_ID="${S3_ACCESS_KEY}"
    export AWS_SECRET_ACCESS_KEY="${S3_SECRET_KEY}"
    if aws s3 sync "s3://${S3_BUCKET}" "${dest}/" --endpoint-url "${S3_ENDPOINT}" 2>&1; then
      rc=0
    else
      rc=1
    fi
  fi

  if [ $rc -eq 0 ]; then
    local count
    count=$(find "${dest}" -type f 2>/dev/null | wc -l | tr -d ' ')
    log "Object storage backup complete: ${dest} (${count} files)"
    TASKS_SUCCEEDED=$((TASKS_SUCCEEDED + 1))
  else
    log "ERROR: Object storage backup failed"
    return 1
  fi
}

# ---------------------------------------------------------------------------
# Config backup (encrypted)
# ---------------------------------------------------------------------------

backup_config() {
  log "Starting config backup..."
  local tarball="/tmp/breeze_config_${TIMESTAMP}.tar.gz"
  local dest="${BACKUP_DIR}/config_${TIMESTAMP}.tar.gz.enc"

  # Determine project root (parent of scripts/)
  local project_root
  project_root="$(cd "$(dirname "$0")/.." && pwd)"

  # Collect config files to back up
  local files_to_tar=()

  if [ -f "${project_root}/.env" ]; then
    files_to_tar+=(".env")
  fi
  if [ -f "${project_root}/.env.production" ]; then
    files_to_tar+=(".env.production")
  fi
  if [ -d "${project_root}/certs" ]; then
    files_to_tar+=("certs")
  fi
  if [ -d "${project_root}/docker" ]; then
    files_to_tar+=("docker")
  fi

  if [ ${#files_to_tar[@]} -eq 0 ]; then
    log "WARNING: No config files found to back up"
    return 1
  fi

  # Create tarball
  if ! tar -czf "${tarball}" -C "${project_root}" "${files_to_tar[@]}" 2>&1; then
    log "ERROR: Failed to create config tarball"
    rm -f "${tarball}"
    return 1
  fi

  # Encrypt with AES-256-CBC using PBKDF2 key derivation
  if openssl enc -aes-256-cbc -salt -pbkdf2 -iter 100000 \
       -in "${tarball}" -out "${dest}" \
       -pass env:BACKUP_ENCRYPTION_KEY 2>&1; then
    rm -f "${tarball}"
    local size
    size=$(du -h "${dest}" | cut -f1)
    log "Config backup complete: ${dest} (${size})"
    TASKS_SUCCEEDED=$((TASKS_SUCCEEDED + 1))
  else
    log "ERROR: Config encryption failed"
    rm -f "${tarball}" "${dest}"
    return 1
  fi
}

# ---------------------------------------------------------------------------
# Retention cleanup
# ---------------------------------------------------------------------------

cleanup_old_backups() {
  log "Cleaning up backups older than ${BACKUP_RETENTION_DAYS} days..."
  local count
  count=$(find "${BACKUP_DIR}" -maxdepth 1 -type f -mtime "+${BACKUP_RETENTION_DAYS}" | wc -l | tr -d ' ')

  if [ "$count" -gt 0 ]; then
    find "${BACKUP_DIR}" -maxdepth 1 -type f -mtime "+${BACKUP_RETENTION_DAYS}" -delete
    log "Deleted ${count} old backup file(s)"
  fi

  # Also clean up old storage backup directories
  count=$(find "${BACKUP_DIR}" -maxdepth 1 -type d -name "storage_*" -mtime "+${BACKUP_RETENTION_DAYS}" | wc -l | tr -d ' ')
  if [ "$count" -gt 0 ]; then
    find "${BACKUP_DIR}" -maxdepth 1 -type d -name "storage_*" -mtime "+${BACKUP_RETENTION_DAYS}" -exec rm -rf {} +
    log "Deleted ${count} old storage backup directories"
  fi

  log "Retention cleanup complete"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

log "=== Breeze RMM Backup Started ==="
log "Backup directory: ${BACKUP_DIR}"
log "Retention: ${BACKUP_RETENTION_DAYS} days"

if $DO_DB; then
  if ! backup_database; then
    log "ERROR: backup_database returned non-zero exit status"
  fi
fi

if $DO_STORAGE; then
  if ! backup_storage; then
    log "ERROR: backup_storage returned non-zero exit status"
  fi
fi

if $DO_CONFIG; then
  if ! backup_config; then
    log "ERROR: backup_config returned non-zero exit status"
  fi
fi

# Always run retention cleanup
cleanup_old_backups

# ---------------------------------------------------------------------------
# Summary and exit code
# ---------------------------------------------------------------------------

log "=== Backup Summary ==="
log "Tasks requested: ${TASKS_REQUESTED}"
log "Tasks succeeded: ${TASKS_SUCCEEDED}"

if [ "${TASKS_SUCCEEDED}" -eq "${TASKS_REQUESTED}" ]; then
  log "Result: ALL SUCCEEDED"
  exit 0
elif [ "${TASKS_SUCCEEDED}" -gt 0 ]; then
  log "Result: PARTIAL FAILURE"
  exit 1
else
  log "Result: COMPLETE FAILURE"
  exit 2
fi
