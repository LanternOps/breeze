-- Workload host inventory W06 (#8195, image currency #3813, spec §10).
--
-- 1. monitor_kind gains `container_image_currency`: a server-evaluated subject
--    monitor (one subject per image repository:tag on a device) that reads the
--    upstream_* columns W05 writes on device_workloads.
-- 2. device_workloads.behind_since: when the row's upstream_status first became
--    `behind` for the current local image. The monitor's age threshold is
--    measured from it. Written by the image-currency pass; ingest clears it
--    whenever it resets upstream_status to `pending` (image changed).
--
-- ALTER TYPE ... ADD VALUE runs inside the transaction autoMigrate wraps each
-- file in; Postgres 12+ allows that as long as the new value is not consumed in
-- the same transaction, and nothing below uses it. One file is therefore enough.
-- Precedent: 2026-11-10-110100-monitor-kind-time-sync.sql.
--
-- Idempotent; writes no rows (no breeze.scope preamble needed).

ALTER TYPE monitor_kind ADD VALUE IF NOT EXISTS 'container_image_currency';

ALTER TABLE public.device_workloads
  ADD COLUMN IF NOT EXISTS behind_since timestamp;
