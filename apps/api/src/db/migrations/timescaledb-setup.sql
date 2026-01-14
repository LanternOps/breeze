-- TimescaleDB Setup Migration for Breeze RMM
-- This migration configures TimescaleDB for efficient time-series metrics storage
-- Prerequisites: TimescaleDB extension must be installed on PostgreSQL

-- ============================================================================
-- 1. Enable TimescaleDB Extension
-- ============================================================================
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- ============================================================================
-- 2. Convert time_series_metrics to Hypertable
-- ============================================================================
-- Hypertables automatically partition data by time for better query performance
-- chunk_time_interval of 1 day balances query performance with chunk management
SELECT create_hypertable('time_series_metrics', 'timestamp',
  chunk_time_interval => INTERVAL '1 day',
  if_not_exists => TRUE
);

-- ============================================================================
-- 3. Add Compression Policy
-- ============================================================================
-- Compress data older than 7 days to reduce storage costs
-- Segmenting by device_id and metric_type allows efficient queries on compressed data
ALTER TABLE time_series_metrics SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'device_id,metric_type'
);

SELECT add_compression_policy('time_series_metrics', INTERVAL '7 days', if_not_exists => TRUE);

-- ============================================================================
-- 4. Add Retention Policy
-- ============================================================================
-- Automatically drop raw data older than 90 days
-- Aggregated data in continuous aggregates will be retained longer
SELECT add_retention_policy('time_series_metrics', INTERVAL '90 days', if_not_exists => TRUE);

-- ============================================================================
-- 5. Create Continuous Aggregates for Common Queries
-- ============================================================================

-- Hourly aggregates for recent trend analysis
CREATE MATERIALIZED VIEW IF NOT EXISTS metrics_hourly
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 hour', timestamp) AS bucket,
  device_id,
  metric_type,
  avg(value) AS avg_value,
  max(value) AS max_value,
  min(value) AS min_value,
  count(*) AS sample_count
FROM time_series_metrics
GROUP BY bucket, device_id, metric_type
WITH NO DATA;

-- Daily aggregates for historical reporting
CREATE MATERIALIZED VIEW IF NOT EXISTS metrics_daily
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 day', timestamp) AS bucket,
  device_id,
  metric_type,
  avg(value) AS avg_value,
  max(value) AS max_value,
  min(value) AS min_value,
  count(*) AS sample_count
FROM time_series_metrics
GROUP BY bucket, device_id, metric_type
WITH NO DATA;

-- ============================================================================
-- 6. Add Refresh Policies for Continuous Aggregates
-- ============================================================================

-- Refresh hourly aggregates every hour
-- start_offset: How far back to refresh (3 hours handles late-arriving data)
-- end_offset: Don't refresh the most recent hour (data may still be arriving)
SELECT add_continuous_aggregate_policy('metrics_hourly',
  start_offset => INTERVAL '3 hours',
  end_offset => INTERVAL '1 hour',
  schedule_interval => INTERVAL '1 hour',
  if_not_exists => TRUE
);

-- Refresh daily aggregates once per day
-- start_offset: Refresh last 3 days to catch any corrections
-- end_offset: Don't refresh today (data still arriving)
SELECT add_continuous_aggregate_policy('metrics_daily',
  start_offset => INTERVAL '3 days',
  end_offset => INTERVAL '1 day',
  schedule_interval => INTERVAL '1 day',
  if_not_exists => TRUE
);
