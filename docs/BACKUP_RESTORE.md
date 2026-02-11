# Backup and Restore

This document covers backup and restore procedures for a Breeze RMM deployment.

## What Gets Backed Up

| Component | Script Flag | Tool | Description |
|---|---|---|---|
| Database | `--db` | `pg_dump` / `pg_restore` | All PostgreSQL data: devices, users, orgs, alerts, audit logs, etc. |
| Object storage | `--storage` | `aws s3 sync` or `mc mirror` | Scripts, agent binaries, report exports, attachments in MinIO/S3 |
| Configuration | `--config` | `tar` + `openssl` | `.env`, `.env.production`, `certs/`, `docker/` -- encrypted at rest |

Use `--all` with the backup script to back up all three components at once.

## Prerequisites

Install the following tools on the machine that will run backups:

- **pg_dump / pg_restore** (PostgreSQL client tools, version matching your server)
  ```bash
  # Ubuntu/Debian
  sudo apt-get install postgresql-client-16

  # macOS
  brew install libpq && brew link --force libpq
  ```

- **aws CLI** or **mc** (MinIO Client) -- only needed for `--storage`
  ```bash
  # AWS CLI
  curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o awscliv2.zip
  unzip awscliv2.zip && sudo ./aws/install

  # MinIO Client
  curl -O https://dl.min.io/client/mc/release/linux-amd64/mc
  chmod +x mc && sudo mv mc /usr/local/bin/
  ```

- **openssl** -- only needed for `--config` (typically pre-installed)
  ```bash
  openssl version
  ```

- **psql** -- used by the restore script for verification
  ```bash
  psql --version
  ```

## Environment Variables

Set these before running the scripts, either in your shell or in a dedicated
backup env file (do NOT commit this file to version control):

```bash
# Required for --db
export DATABASE_URL="postgresql://breeze:password@localhost:5432/breeze"

# Required for --config
export BACKUP_ENCRYPTION_KEY="a-strong-passphrase-at-least-32-chars"

# Required for --storage
export S3_ENDPOINT="http://localhost:9000"
export S3_BUCKET="breeze"
export S3_ACCESS_KEY="minioadmin"
export S3_SECRET_KEY="minioadmin"

# Optional overrides
export BACKUP_DIR="/var/backups/breeze"          # default: /var/backups/breeze
export BACKUP_RETENTION_DAYS="30"                # default: 30
export BACKUP_STORAGE_TOOL="mc"                  # default: auto-detect (mc or aws)
```

## Manual Backup

### Full backup (all components)

```bash
./scripts/backup.sh --all
```

### Database only

```bash
./scripts/backup.sh --db
```

### Storage only

```bash
./scripts/backup.sh --storage
```

### Config only

```bash
./scripts/backup.sh --config
```

### Combining flags

```bash
./scripts/backup.sh --db --config
```

### Output

Backups are written to `BACKUP_DIR` (default `/var/backups/breeze`) with
timestamped filenames:

```
/var/backups/breeze/
  db_20260211_020000.dump          # pg_dump custom format, compressed
  storage_20260211_020000/         # mirror of S3 bucket
  config_20260211_020000.tar.gz.enc  # encrypted tarball
```

## Manual Restore

### Database

```bash
./scripts/restore.sh --db /var/backups/breeze/db_20260211_020000.dump
```

The script will:
1. Prompt for confirmation (destructive operation)
2. Run `pg_restore --clean --if-exists` to drop and recreate objects
3. Verify by running `SELECT count(*) FROM devices`

### Object storage

```bash
./scripts/restore.sh --storage /var/backups/breeze/storage_20260211_020000
```

This syncs the backup directory back into the live S3/MinIO bucket.

### Configuration

```bash
./scripts/restore.sh --config /var/backups/breeze/config_20260211_020000.tar.gz.enc
```

The script will:
1. Prompt for confirmation
2. Decrypt using `BACKUP_ENCRYPTION_KEY`
3. Extract `.env`, `certs/`, and `docker/` into the project root
4. Fix file permissions (600 for `.env`, 700/600 for `certs/`)

### Combining restore targets

```bash
./scripts/restore.sh --db /var/backups/breeze/db_20260211_020000.dump \
                      --config /var/backups/breeze/config_20260211_020000.tar.gz.enc
```

### Skipping confirmation prompts

For use in automated recovery scripts:

```bash
RESTORE_SKIP_CONFIRM=yes ./scripts/restore.sh --db /var/backups/breeze/db_20260211_020000.dump
```

## Automated Backups (Cron)

### Setup

1. Create a backup environment file (readable only by the backup user):

   ```bash
   sudo mkdir -p /etc/breeze
   sudo tee /etc/breeze/backup.env > /dev/null <<'EOF'
   DATABASE_URL=postgresql://breeze:password@localhost:5432/breeze
   BACKUP_ENCRYPTION_KEY=your-strong-passphrase-here
   S3_ENDPOINT=http://localhost:9000
   S3_BUCKET=breeze
   S3_ACCESS_KEY=minioadmin
   S3_SECRET_KEY=minioadmin
   BACKUP_DIR=/var/backups/breeze
   BACKUP_RETENTION_DAYS=30
   EOF
   sudo chmod 600 /etc/breeze/backup.env
   ```

2. Create a wrapper script:

   ```bash
   sudo tee /usr/local/bin/breeze-backup > /dev/null <<'SCRIPT'
   #!/usr/bin/env bash
   set -euo pipefail
   source /etc/breeze/backup.env
   export DATABASE_URL BACKUP_ENCRYPTION_KEY S3_ENDPOINT S3_BUCKET S3_ACCESS_KEY S3_SECRET_KEY BACKUP_DIR BACKUP_RETENTION_DAYS

   LOG_FILE="/var/log/breeze/backup-$(date +%Y%m%d).log"
   mkdir -p /var/log/breeze

   /opt/breeze/scripts/backup.sh --all >> "$LOG_FILE" 2>&1
   EXIT_CODE=$?

   if [ $EXIT_CODE -ne 0 ]; then
     echo "Breeze backup failed with exit code $EXIT_CODE. See $LOG_FILE" | \
       mail -s "ALERT: Breeze backup failure" ops@yourcompany.com 2>/dev/null || true
   fi

   exit $EXIT_CODE
   SCRIPT
   sudo chmod 700 /usr/local/bin/breeze-backup
   ```

3. Add the cron job (daily at 2:00 AM):

   ```bash
   sudo crontab -e
   ```
   ```
   0 2 * * * /usr/local/bin/breeze-backup
   ```

### Verifying the cron job

```bash
# Check cron is running
systemctl status cron

# Check recent backup logs
ls -lt /var/log/breeze/ | head -5
tail -20 /var/log/breeze/backup-$(date +%Y%m%d).log

# Check backup files exist and are recent
ls -lth /var/backups/breeze/ | head -10
```

## Monitoring Backup Success

### Exit codes

| Code | Meaning |
|------|---------|
| 0 | All requested backup/restore tasks succeeded |
| 1 | Partial failure (some tasks succeeded, others failed) |
| 2 | Complete failure (all tasks failed, or a fatal pre-flight error) |

### Log format

All output is timestamped and goes to stdout. Redirect to a file for persistent
logging:

```bash
./scripts/backup.sh --all 2>&1 | tee -a /var/log/breeze/backup.log
```

### Integration with monitoring

**Prometheus pushgateway:**
```bash
# After backup completes, push a metric
cat <<EOF | curl --data-binary @- http://localhost:9091/metrics/job/breeze_backup
breeze_backup_last_success_timestamp $(date +%s)
breeze_backup_last_exit_code $?
EOF
```

**Healthcheck endpoint:**
```bash
# If using a dead-man's switch (e.g., Healthchecks.io):
curl -fsS -m 10 --retry 5 https://hc-ping.com/your-uuid-here/$?
```

**Simple file-based check:**
```bash
# The backup script always logs a summary. Check for "ALL SUCCEEDED":
if grep -q "ALL SUCCEEDED" /var/log/breeze/backup-$(date +%Y%m%d).log; then
  echo "Backup OK"
else
  echo "Backup FAILED — check logs"
fi
```

## Testing Restore Procedures

It is recommended to test the restore procedure at least once per month.

### Recommended monthly test

1. **Provision a test environment** (separate VM or Docker stack):
   ```bash
   docker compose -f docker-compose.test.yml up -d
   ```

2. **Copy the latest backup files** to the test machine.

3. **Run the restore:**
   ```bash
   RESTORE_SKIP_CONFIRM=yes \
   DATABASE_URL=postgresql://breeze:breeze@localhost:5433/breeze \
   BACKUP_ENCRYPTION_KEY=your-key \
     ./scripts/restore.sh --db /path/to/latest/db_*.dump \
                           --config /path/to/latest/config_*.tar.gz.enc
   ```

4. **Verify the application works:**
   ```bash
   # Check device count matches production
   psql "$DATABASE_URL" -c "SELECT count(*) FROM devices;"

   # Check critical tables
   psql "$DATABASE_URL" -c "SELECT count(*) FROM users;"
   psql "$DATABASE_URL" -c "SELECT count(*) FROM organizations;"

   # Start the API and verify endpoints respond
   curl -s http://localhost:3001/health | jq .
   ```

5. **Document the test** -- record the date, backup file used, and result.

6. **Tear down the test environment:**
   ```bash
   docker compose -f docker-compose.test.yml down -v
   ```

### Checklist

- [ ] Database restore completes without errors
- [ ] Device count matches expected value
- [ ] User accounts and roles are intact
- [ ] .env file is restored with correct values
- [ ] TLS certificates are restored and valid
- [ ] API health endpoint returns 200
- [ ] Login works with a known test account
