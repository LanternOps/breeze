-- #2787 item 4 / #5023 wave 04 — "permanently delete removed devices N days
-- after removal".
--
-- Three things, all idempotent:
--
--  1. `device_lifecycle` config-policy feature type. Pattern B (pure JSONB
--     inline settings, no normalized table), same shape as `pam` /
--     `vulnerability`. Postgres forbids USING a value added by
--     `ALTER TYPE ... ADD VALUE` inside the transaction that added it, and
--     autoMigrate wraps each file in one — nothing below references the new
--     value, so a single file is safe here (unlike
--     2026-10-05-100000-contract-line-type-per-device-role.sql, which had to
--     split).
--
--  2. `devices.decommissioned_at`. NOTHING in the schema recorded WHEN a
--     device was removed: `status` flips to 'decommissioned' and `updated_at`
--     is touched by every unrelated write afterwards. A retention job cannot
--     be built on `updated_at`, so the stamp is new state, not derived.
--
--     The backfill uses `updated_at` deliberately and once: for rows that are
--     ALREADY decommissioned it is the best available approximation of the
--     removal time, and leaving them NULL would exclude every pre-existing
--     removed device from the feature forever (the job treats NULL as
--     "never purge"). Applied uniformly to every decommissioned row
--     regardless of which path removed it, which is why every write path that
--     sets status='decommissioned' also stamps this column from now on.
--
--  3. A partial index for the job's per-org eligibility scan.

ALTER TYPE public.config_feature_type ADD VALUE IF NOT EXISTS 'device_lifecycle';

ALTER TABLE devices ADD COLUMN IF NOT EXISTS decommissioned_at timestamptz;

-- breeze.scope = 'system' is REQUIRED: `devices` is forced-RLS and migrations
-- run as an unprivileged role on managed Postgres, where a context-less UPDATE
-- silently affects 0 rows. CI's superuser masks that, so the elevation must be
-- here rather than discovered in production. The row count is reported so the
-- backfill leaves a forensic trail even when it is 0.
--
-- The CANONICAL top-level `SELECT set_config(...)` form, not the equivalent
-- `SET LOCAL breeze.scope = 'system'` inside the DO block: the commit-time
-- guard (`src/db/migrationRlsScope.ts`) recognises only SELECT/PERFORM
-- set_config, so SET LOCAL elevates at runtime but still reports this file as
-- an unscoped write. Reference shape:
-- 2026-09-30-100000-rls-scoped-backfill-replay.sql.
--
-- `is_local = true` scopes the setting to autoMigrate's per-file transaction.
SELECT set_config('breeze.scope', 'system', true);

DO $$
DECLARE n int;
BEGIN
  UPDATE devices
     SET decommissioned_at = updated_at
   WHERE status = 'decommissioned' AND decommissioned_at IS NULL;

  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING 'backfilled % removed devices with decommissioned_at', n;
  END IF;
END $$;

-- (org_id, decommissioned_at) matches the retention job's access pattern: it
-- walks orgs one at a time and asks for removed devices older than the org's
-- cutoff. The partial predicate keeps the index to the removed population only.
CREATE INDEX IF NOT EXISTS devices_decommissioned_at_idx
  ON devices (org_id, decommissioned_at)
  WHERE status = 'decommissioned';
