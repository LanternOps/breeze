-- 2026-10-13-100200: whole-device patch_job_results summary rows carry a NULL
-- patch_id instead of a nil-UUID sentinel (#5128 W3 CI fix).
--
-- patch_job_results.patch_id has always been `uuid NOT NULL REFERENCES
-- patches(id)`, but three writers record a WHOLE-DEVICE summary row that is not
-- about any particular patch — markDeviceSkipped, markDeviceDispatchFailed and
-- the finalizer's no-approved-set fallback — and all three wrote the nil UUID
-- '00000000-0000-0000-0000-000000000000'. No `patches` row has that id, so
-- every one of those inserts raised 23503 against a real database. The nil-UUID
-- sentinel had simply never met Postgres: the unit suite mocks Drizzle, and the
-- integration suites never drove a patch job through an offline/skip device
-- until the #5128 W3 suite did.
--
-- Fix: NULL is the honest value — the row has no patch. The FK stays in force
-- for every real patch id (SQL FKs ignore NULL), so this only widens the
-- column's domain by the one value that means "not a patch". Sibling columns
-- (device_patches.patch_id, patch_rollbacks.patch_id, patch_approvals.patch_id)
-- are untouched: those rows are always about a specific patch.
--
-- Backwards compatible in both directions: existing rows keep their values, and
-- nothing reads patch_id with a NOT NULL assumption (the two sentinel
-- comparisons in patchJobFinalizer.ts become non-null filters in the same PR).
-- No org_id on this table, so no cascade / export-policy registration applies.
--
-- DDL only: no UPDATE/DELETE/INSERT, so no breeze.scope elevation is required.
-- DROP NOT NULL is a no-op when already dropped, so re-applying is idempotent.

ALTER TABLE patch_job_results
  ALTER COLUMN patch_id DROP NOT NULL;
