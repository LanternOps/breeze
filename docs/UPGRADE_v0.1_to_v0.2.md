# Upgrade Guide: v0.1 -> v0.2 (No Data Loss)

This runbook upgrades Breeze in-place while preserving PostgreSQL and Redis state.

## Downtime Expectation

- Typical downtime: 2-10 minutes
- Most downtime is migration + container restart time

## 1) Preflight

- Ensure you are on the release branch/tag you want to deploy.
- Confirm DNS and TLS are already working for your domain.
- Confirm `.env.prod` has all required production values.

## 2) Create Backups (Required)

```bash
./scripts/ops/backup.sh ./backups
```

Artifacts created:

- `breeze-db-<timestamp>.sql.gz`
- `breeze-redis-<timestamp>.rdb`
- `breeze-backup-<timestamp>.txt` metadata

Do not proceed without a successful database backup.

## 3) Deploy v0.2

```bash
./scripts/prod/deploy.sh .env.prod
```

The deploy script runs DB migrations before app rollout.

## 4) Post-Upgrade Validation

Run these checks:

```bash
curl -fsS https://<BREEZE_DOMAIN>/health
./scripts/ops/verify-monitoring.sh .env.prod
```

And validate in UI:

- Login works
- Device inventory loads
- Alerts list loads
- New events/heartbeats still appear

## 5) Rollback Procedure

If validation fails:

1. Check out previous release/tag.
2. Restore backup.

```bash
./scripts/ops/restore.sh ./backups/breeze-db-<timestamp>.sql.gz ./backups/breeze-redis-<timestamp>.rdb
```

3. Redeploy previous release.

```bash
./scripts/prod/deploy.sh .env.prod
```

## Safety Notes

- Never edit previously applied SQL migration files; add a new migration instead.
- Always keep at least one verified backup from immediately before upgrade.
