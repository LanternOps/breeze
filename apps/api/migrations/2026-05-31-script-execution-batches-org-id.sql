-- 2026-05-31: Denormalize org_id onto script_execution_batches + direct org RLS.
--
-- Why this is separate from 2026-05-30-fk-child-tables-rls.sql:
-- script_execution_batches reaches its tenant only through `scripts`, whose
-- org_id is NULLABLE (system/built-in scripts have org_id = NULL, is_system =
-- true). A parent-FK join policy would need `s.is_system = true OR
-- breeze_has_org_access(s.org_id)`, but that nested-RLS EXISTS does NOT evaluate
-- the is_system branch correctly under the production driver's extended-protocol
-- (bound-parameter) INSERTs — a tenant running a built-in script on 2+ devices
-- (routes/scripts.ts) would get "new row violates row-level security policy"
-- creating its batch. (Verified: org-script inserts pass, system-script inserts
-- fail, only under bound parameters.)
--
-- Fix: carry the executing org directly on the row. routes/scripts.ts now sets
-- org_id at insert (the org of the targeted devices, which the caller already
-- has ensureOrgAccess to). RLS becomes a direct breeze_has_org_access(org_id) —
-- no subquery, no is_system branch, deterministic under any protocol. A
-- system-script batch now belongs to the org that ran it (so that org can read
-- its own batch) while remaining isolated from other tenants.
--
-- All write paths satisfy the policy: the route INSERT/UPDATE run under the
-- caller's org (breeze_has_org_access(org_id) = TRUE for their own org); the
-- agent WS counter update and the stale-command reaper run wherever the sibling
-- script_executions update already passes (system scope short-circuits TRUE,
-- org/device scope matches the batch's org).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS; backfill only touches NULL org_id rows;
-- DROP POLICY IF EXISTS before CREATE (also removes the interim parent-FK join
-- policies a DB may have applied from an earlier revision of 2026-05-30).
-- autoMigrate wraps each file in a transaction — no inner BEGIN/COMMIT.

ALTER TABLE script_execution_batches
  ADD COLUMN IF NOT EXISTS org_id uuid REFERENCES organizations(id);

CREATE INDEX IF NOT EXISTS script_execution_batches_org_id_idx
  ON script_execution_batches(org_id);

-- Backfill legacy rows from their (org-scoped) parent script. System-script
-- batches (scripts.org_id IS NULL) cannot be attributed retroactively — they
-- keep org_id = NULL and are reachable only under system scope, matching their
-- pre-RLS exposure (there was no tenant read path for them).
UPDATE script_execution_batches b
   SET org_id = s.org_id
  FROM scripts s
 WHERE b.script_id = s.id
   AND b.org_id IS NULL
   AND s.org_id IS NOT NULL;

ALTER TABLE script_execution_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE script_execution_batches FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON script_execution_batches;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON script_execution_batches;
DROP POLICY IF EXISTS breeze_org_isolation_update ON script_execution_batches;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON script_execution_batches;

CREATE POLICY breeze_org_isolation_select ON script_execution_batches
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON script_execution_batches
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON script_execution_batches
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON script_execution_batches
  FOR DELETE USING (public.breeze_has_org_access(org_id));
