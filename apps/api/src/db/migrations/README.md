# Database Migrations

This directory contains SQL migrations for changes that are not managed by Drizzle's generated migrations.
Date-prefixed files (for example `2026-02-09-*.sql`) are applied automatically by `pnpm db:migrate`
via `src/db/migrations/run.ts`.

## Prerequisites

### TimescaleDB Installation

The `timescaledb-setup.sql` migration requires TimescaleDB to be installed on your PostgreSQL instance.

#### Option 1: Docker (Recommended for Development)

Use the official TimescaleDB Docker image:

```bash
docker run -d --name timescaledb \
  -p 5432:5432 \
  -e POSTGRES_PASSWORD=your_password \
  timescale/timescaledb:latest-pg16
```

#### Option 2: Install on Existing PostgreSQL

Follow the official installation guide for your platform:
https://docs.timescale.com/self-hosted/latest/install/

**macOS (Homebrew):**
```bash
brew install timescaledb
timescaledb-tune
# Restart PostgreSQL after installation
```

**Ubuntu/Debian:**
```bash
# Add TimescaleDB repository
sudo add-apt-repository ppa:timescale/timescaledb-ppa
sudo apt update
sudo apt install timescaledb-2-postgresql-16
sudo timescaledb-tune
sudo systemctl restart postgresql
```

#### Option 3: Managed Services

TimescaleDB is available on:
- [Timescale Cloud](https://www.timescale.com/cloud) (fully managed)
- [AWS RDS](https://aws.amazon.com/rds/) (via custom parameter groups)
- [Azure Database for PostgreSQL](https://azure.microsoft.com/en-us/products/postgresql/)

## Running Migrations

### Using psql (manual)

```bash
# Connect to your database and run the migration
psql -h localhost -U postgres -d breeze -f timescaledb-setup.sql
```

### Using npm script

```bash
pnpm db:migrate
```

`pnpm db:migrate` runs Drizzle migrations first, then applies dated SQL files in this folder.

To run only the manual SQL migration runner:

```bash
pnpm --filter @breeze/api db:migrate:sql
```

## Migration Files

### timescaledb-setup.sql

Sets up TimescaleDB for time-series metrics storage with:

1. **TimescaleDB Extension** - Enables the extension
2. **Hypertable Conversion** - Converts `time_series_metrics` to a hypertable with 1-day chunks
3. **Compression Policy** - Compresses data older than 7 days (segmented by device_id, metric_type)
4. **Retention Policy** - Drops raw data older than 90 days
5. **Continuous Aggregates** - Pre-computed hourly and daily aggregates for fast queries
6. **Refresh Policies** - Automatic refresh schedules for aggregates

#### Storage Estimates

| Data Volume | Raw (7 days) | Compressed (83 days) | Aggregates |
|-------------|--------------|----------------------|------------|
| 1,000 devices | ~2 GB | ~8 GB | ~500 MB |
| 10,000 devices | ~20 GB | ~80 GB | ~5 GB |
| 100,000 devices | ~200 GB | ~800 GB | ~50 GB |

*Estimates assume 1 metric per minute per device with typical RMM metrics.*

## Querying Aggregated Data

After running the migration, use the continuous aggregates for efficient queries:

```sql
-- Get hourly CPU averages for a device (last 24 hours)
SELECT bucket, avg_value, max_value
FROM metrics_hourly
WHERE device_id = 'device-uuid'
  AND metric_type = 'cpu_percent'
  AND bucket > NOW() - INTERVAL '24 hours'
ORDER BY bucket;

-- Get daily metrics summary for reporting
SELECT bucket, avg_value, max_value, min_value, sample_count
FROM metrics_daily
WHERE device_id = 'device-uuid'
  AND metric_type = 'memory_percent'
  AND bucket > NOW() - INTERVAL '30 days'
ORDER BY bucket;
```

## Troubleshooting

### Extension Not Found

If you see `ERROR: could not open extension control file`:
- Ensure TimescaleDB is installed
- Run `timescaledb-tune` and restart PostgreSQL
- Check that `shared_preload_libraries = 'timescaledb'` is in `postgresql.conf`

### Table Already a Hypertable

The migration uses `if_not_exists => TRUE` and is safe to re-run.

### Compression Errors

If compression fails, ensure the table has data and the required columns exist:
```sql
SELECT * FROM time_series_metrics LIMIT 1;
```

## Rollback

To remove TimescaleDB configuration (WARNING: This will delete compressed data):

```sql
-- Remove policies
SELECT remove_retention_policy('time_series_metrics', if_exists => TRUE);
SELECT remove_compression_policy('time_series_metrics', if_exists => TRUE);

-- Drop continuous aggregates
DROP MATERIALIZED VIEW IF EXISTS metrics_daily;
DROP MATERIALIZED VIEW IF EXISTS metrics_hourly;

-- Note: Converting back from hypertable requires recreating the table
```
