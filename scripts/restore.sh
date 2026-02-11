#!/usr/bin/env bash
#
# Breeze RMM — Restore Script
#
# Usage:
#   ./scripts/restore.sh --db <file>
#   ./scripts/restore.sh --storage <dir>
#   ./scripts/restore.sh --config <file>
#   ./scripts/restore.sh --db <file> --config <file>
#
# Environment variables:
#   DATABASE_URL            PostgreSQL connection string (required for --db)
#   BACKUP_ENCRYPTION_KEY   Passphrase for config decryption (required for --config)
#   S3_ENDPOINT             MinIO/S3 endpoint (required for --storage)
#   S3_BUCKET               Bucket name (default: breeze)
#   S3_ACCESS_KEY           S3 access key (required for --storage)
#   S3_SECRET_KEY           S3 secret key (required for --storage)
#   BACKUP_STORAGE_TOOL     "aws" or "mc" (default: auto-detect)
#   RESTORE_SKIP_CONFIRM    Set to "yes" to skip confirmation prompts
#
# Exit codes:
#   0 — all requested restores succeeded
#   1 — partial failure
#   2 — complete failure

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

S3_BUCKET="${S3_BUCKET:-breeze}"
RESTORE_SKIP_CONFIRM="${RESTORE_SKIP_CONFIRM:-no}"

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

confirm() {
  if [ "$RESTORE_SKIP_CONFIRM" = "yes" ]; then
    return 0
  fi
  echo ""
  echo "WARNING: $1"
  echo ""
  printf "Type 'yes' to continue: "
  read -r answer
  if [ "$answer" != "yes" ]; then
    log "Aborted by user."
    exit 0
  fi
}

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

DB_FILE=""
STORAGE_DIR=""
CONFIG_FILE=""

if [ $# -eq 0 ]; then
  echo "Usage: $0 --db <dump_file> [--storage <backup_dir>] [--config <encrypted_file>]"
  echo "At least one restore target is required."
  exit 2
fi

while [ $# -gt 0 ]; do
  case "$1" in
    --db)
      shift
      DB_FILE="${1:-}"
      if [ -z "$DB_FILE" ]; then die "--db requires a file argument"; fi
      ;;
    --storage)
      shift
      STORAGE_DIR="${1:-}"
      if [ -z "$STORAGE_DIR" ]; then die "--storage requires a directory argument"; fi
      ;;
    --config)
      shift
      CONFIG_FILE="${1:-}"
      if [ -z "$CONFIG_FILE" ]; then die "--config requires a file argument"; fi
      ;;
    -h|--help)
      echo "Usage: $0 --db <dump_file> [--storage <backup_dir>] [--config <encrypted_file>]"
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

if [ -n "$DB_FILE" ]; then
  TASKS_REQUESTED=$((TASKS_REQUESTED + 1))
  if [ ! -f "$DB_FILE" ]; then die "Database backup file not found: $DB_FILE"; fi
  if [ -z "${DATABASE_URL:-}" ]; then die "DATABASE_URL is required for --db restore"; fi
  if ! command -v pg_restore &>/dev/null; then die "pg_restore is not installed or not in PATH"; fi
fi

if [ -n "$STORAGE_DIR" ]; then
  TASKS_REQUESTED=$((TASKS_REQUESTED + 1))
  if [ ! -d "$STORAGE_DIR" ]; then die "Storage backup directory not found: $STORAGE_DIR"; fi
  if [ -z "${S3_ENDPOINT:-}" ]; then die "S3_ENDPOINT is required for --storage restore"; fi

  BACKUP_STORAGE_TOOL="${BACKUP_STORAGE_TOOL:-}"
  if [ -z "$BACKUP_STORAGE_TOOL" ]; then
    if command -v mc &>/dev/null; then
      BACKUP_STORAGE_TOOL="mc"
    elif command -v aws &>/dev/null; then
      BACKUP_STORAGE_TOOL="aws"
    else
      die "Neither 'mc' (MinIO client) nor 'aws' CLI found."
    fi
  fi
fi

if [ -n "$CONFIG_FILE" ]; then
  TASKS_REQUESTED=$((TASKS_REQUESTED + 1))
  if [ ! -f "$CONFIG_FILE" ]; then die "Config backup file not found: $CONFIG_FILE"; fi
  if [ -z "${BACKUP_ENCRYPTION_KEY:-}" ]; then die "BACKUP_ENCRYPTION_KEY is required for --config restore"; fi
  if ! command -v openssl &>/dev/null; then die "openssl is not installed or not in PATH"; fi
fi

if [ "$TASKS_REQUESTED" -eq 0 ]; then
  die "No restore targets specified"
fi

# ---------------------------------------------------------------------------
# Database restore
# ---------------------------------------------------------------------------

restore_database() {
  log "Preparing database restore from: ${DB_FILE}"

  confirm "This will DROP and recreate database objects. All current data will be replaced."

  log "Starting database restore..."

  local exit_code=0
  pg_restore --clean --if-exists -d "${DATABASE_URL}" "${DB_FILE}" 2>&1 || exit_code=$?

  if [ $exit_code -eq 0 ]; then
    log "pg_restore completed successfully"
  elif [ $exit_code -eq 1 ]; then
    # Exit code 1 = non-fatal warnings only (e.g., "role does not exist")
    log "WARNING: pg_restore completed with non-fatal warnings"
  else
    log "ERROR: pg_restore failed with exit code ${exit_code}"
    return 1
  fi

  # Verification: count devices as a sanity check
  log "Verifying restore..."
  local count
  count=$(psql "${DATABASE_URL}" -t -A -c "SELECT count(*) FROM devices;" 2>/dev/null || echo "ERROR")

  if [ "$count" = "ERROR" ]; then
    log "ERROR: Verification query failed. The database may be in a bad state."
    return 1
  fi

  log "Verification passed: ${count} devices in database"
  TASKS_SUCCEEDED=$((TASKS_SUCCEEDED + 1))
}

# ---------------------------------------------------------------------------
# Object storage restore
# ---------------------------------------------------------------------------

restore_storage() {
  log "Preparing object storage restore from: ${STORAGE_DIR}"

  local file_count
  file_count=$(find "${STORAGE_DIR}" -type f 2>/dev/null | wc -l | tr -d ' ')
  confirm "This will sync ${file_count} files to the live ${S3_BUCKET} bucket, potentially overwriting existing objects."

  log "Starting object storage restore..."

  local rc=0

  if [ "$BACKUP_STORAGE_TOOL" = "mc" ]; then
    if ! mc alias set breeze-restore "${S3_ENDPOINT}" "${S3_ACCESS_KEY}" "${S3_SECRET_KEY}" --api S3v4 2>&1; then
      log "ERROR: Failed to configure MinIO client alias. Check S3_ENDPOINT, S3_ACCESS_KEY, and S3_SECRET_KEY."
      return 1
    fi
    if mc mirror "${STORAGE_DIR}/" "breeze-restore/${S3_BUCKET}" 2>&1; then
      rc=0
    else
      rc=1
    fi
  elif [ "$BACKUP_STORAGE_TOOL" = "aws" ]; then
    export AWS_ACCESS_KEY_ID="${S3_ACCESS_KEY}"
    export AWS_SECRET_ACCESS_KEY="${S3_SECRET_KEY}"
    if aws s3 sync "${STORAGE_DIR}/" "s3://${S3_BUCKET}" --endpoint-url "${S3_ENDPOINT}" 2>&1; then
      rc=0
    else
      rc=1
    fi
  fi

  if [ $rc -eq 0 ]; then
    log "Object storage restore complete"
    TASKS_SUCCEEDED=$((TASKS_SUCCEEDED + 1))
  else
    log "ERROR: Object storage restore failed"
    return 1
  fi
}

# ---------------------------------------------------------------------------
# Config restore (decrypt + extract)
# ---------------------------------------------------------------------------

restore_config() {
  log "Preparing config restore from: ${CONFIG_FILE}"

  # Determine project root
  local project_root
  project_root="$(cd "$(dirname "$0")/.." && pwd)"

  confirm "This will overwrite .env and certs in ${project_root}."

  log "Decrypting config backup..."
  local tarball="/tmp/breeze_config_restore_$$.tar.gz"

  if ! openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 \
       -in "${CONFIG_FILE}" -out "${tarball}" \
       -pass env:BACKUP_ENCRYPTION_KEY 2>&1; then
    log "ERROR: Decryption failed. Check BACKUP_ENCRYPTION_KEY."
    rm -f "${tarball}"
    return 1
  fi

  log "Extracting config files..."
  if tar -xzf "${tarball}" -C "${project_root}" 2>&1; then
    rm -f "${tarball}"
    log "Config restore complete"
    TASKS_SUCCEEDED=$((TASKS_SUCCEEDED + 1))
  else
    log "ERROR: Extraction failed"
    rm -f "${tarball}"
    return 1
  fi

  # Fix permissions on sensitive files
  if [ -f "${project_root}/.env" ]; then
    chmod 600 "${project_root}/.env"
    log "Set .env permissions to 600"
  fi
  if [ -d "${project_root}/certs" ]; then
    chmod 700 "${project_root}/certs"
    find "${project_root}/certs" -type f -exec chmod 600 {} +
    log "Set certs directory permissions to 700/600"
  fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

log "=== Breeze RMM Restore Started ==="

if [ -n "$DB_FILE" ]; then
  if ! restore_database; then
    log "ERROR: restore_database returned non-zero exit status"
  fi
fi

if [ -n "$STORAGE_DIR" ]; then
  if ! restore_storage; then
    log "ERROR: restore_storage returned non-zero exit status"
  fi
fi

if [ -n "$CONFIG_FILE" ]; then
  if ! restore_config; then
    log "ERROR: restore_config returned non-zero exit status"
  fi
fi

# ---------------------------------------------------------------------------
# Summary and exit code
# ---------------------------------------------------------------------------

log "=== Restore Summary ==="
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
