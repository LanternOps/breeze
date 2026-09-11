-- Fix-forward for the v0.111.0 US outage (2026-09-09 13:38-13:52 UTC, ~14 min
-- of API crash-loop). Refs #5239.
--
-- WHAT BROKE. `2026-10-14-100100-discovered-assets-manual-source.sql` backfills
-- `discovered_assets.source` with two set-based UPDATEs in one transaction:
--
--     UPDATE ... SET source = 'unifi' WHERE source IS NULL AND <unifi linkage>
--     UPDATE ... SET source = 'scan'  WHERE source IS NULL
--
-- `discovered_assets` carries the statement trigger
-- `breeze_partner_export_material_update` -> `breeze_partner_export_site_child_update`
-- (2026-07-20-partner-export-reconstruction-material-state.sql, hardened in
-- 2026-07-23-partner-export-material-state-hardening.sql). That function
-- unconditionally takes `breeze_partner_export_lock_orgs_exclusive(org_ids)`
-- over EVERY org appearing in the statement's transition tables, which in turn
-- takes `breeze_partner_export_lock_partners_shared()` over those orgs'
-- partners.
--
-- The lock hierarchy (2026-07-18-partner-export-org-locks.sql, current bodies
-- in 2026-07-22-partner-export-lock-upgrade-hardening.sql and
-- 2026-07-22-z-partner-export-lock-key-collision-hardening.sql) is
-- transaction-scoped and monotonic: partners before orgs, each axis in
-- ascending UUID order, tracked in `breeze.partner_export_*` GUCs that
-- `set_config(..., is_local => true)` keeps alive for the WHOLE migration
-- transaction. Two statements therefore share one lock ledger:
--
--   * statement 1 locks the orgs/partners of the UniFi subset and leaves
--     `breeze.partner_export_org_lock_held = '1'` plus an org/partner high
--     water mark;
--   * statement 2 covers a DIFFERENT, larger set. Its first new partner trips
--       P0001 partner export lock hierarchy violation: new partner lock
--       requested after organization lock
--     and, once the partners happen to be pre-held, its first org below the
--     high water mark trips
--       P0001 partner export organization locks must be acquired in ascending
--       UUID order
--
-- The whole file rolls back, autoMigrate retries on the next boot, and the API
-- never comes up. US prod had 207 `discovered_assets` rows spread over several
-- partners; EU had 0, and CI's test database has zero or single-tenant rows —
-- which is exactly why no gate caught it.
--
-- THE FIX. Acquire the locks ONCE, up front, over the union of every partner
-- and org that the backfill will touch, in ascending order. Both lock helpers
-- skip an axis value this transaction already holds
-- (`IF org_id = ANY(held_orgs) THEN CONTINUE`), so every later per-statement
-- request from the trigger degrades to a no-op instead of a hierarchy or
-- ordering violation. This is the exact SQL that was run by hand to unwedge US
-- prod on 2026-09-09.
--
-- WHY THIS FILE SORTS *BEFORE* AN ALREADY-COMMITTED MIGRATION. Normally a new
-- migration must sort strictly last (rule 3 of scripts/check-migration-naming.sh).
-- It cannot here: 100100 is the file that crash-loops, so anything sorting
-- after it never runs on an affected database. Shipped migrations are
-- content-hash immutable, so 100100 cannot be edited either. 100050 therefore
-- wedges in immediately ahead of it and is fully self-sufficient — it creates
-- the enum and both columns itself, so a fresh database replaying
-- 100000 -> 100050 -> 100100 is correct and 100100 degrades to a no-op. The
-- pre-commit hook's rule 3 was overridden deliberately for this file; CI's
-- whole-directory pass does not enforce rule 3 and stays green.
--
-- IDEMPOTENCE ON AN ALREADY-REPAIRED DATABASE (hosted US). The enum and both
-- columns already exist (guarded), `source` is already NOT NULL so
-- `WHERE source IS NULL` selects nothing, and both lock helpers are handed
-- empty arrays. `breeze_partner_export_lock_orgs_exclusive(ARRAY[]::uuid[])`
-- resolves 0 orgs against a 0-length request, so its unknown-organization
-- guard does not fire, and neither FOREACH body executes. Every statement in
-- this file is a no-op there.

DO $$ BEGIN
  CREATE TYPE public.discovered_asset_source AS ENUM ('scan', 'unifi', 'manual');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE public.discovered_assets
  ADD COLUMN IF NOT EXISTS source public.discovered_asset_source;
ALTER TABLE public.discovered_assets
  ADD COLUMN IF NOT EXISTS url text;

-- REQUIRED before the first read of a forced-RLS table AND before the first
-- UPDATE: `breeze_current_scope()` defaults to 'none', so on a connection that
-- does not bypass RLS the org/partner discovery SELECTs below would return zero
-- rows (pre-locking nothing, reproducing the outage) and the UPDATEs would
-- match zero rows silently. The CANONICAL top-level `SELECT set_config(...)`
-- form, not `SET LOCAL` — src/db/migrationRlsScope.ts recognises only
-- SELECT/PERFORM set_config. `is_local = true` scopes it to autoMigrate's
-- per-file transaction, which is also the transaction the advisory locks and
-- the `breeze.partner_export_*` lock ledger live in.
SELECT set_config('breeze.scope', 'system', true);

-- Partners first (shared), then orgs (exclusive) — the hierarchy the guards
-- enforce. Ascending order on both axes. Empty arrays are a no-op.
SELECT public.breeze_partner_export_lock_partners_shared(ARRAY(
  SELECT DISTINCT o.partner_id
    FROM public.discovered_assets d
    JOIN public.organizations o ON o.id = d.org_id
   WHERE d.source IS NULL
     AND o.partner_id IS NOT NULL
   ORDER BY 1
));

SELECT public.breeze_partner_export_lock_orgs_exclusive(ARRAY(
  SELECT DISTINCT d.org_id
    FROM public.discovered_assets d
   WHERE d.source IS NULL
     AND d.org_id IS NOT NULL
   ORDER BY 1
));

-- The same two backfills 100100 performs, so that by the time 100100 replays
-- its own copies they match zero rows. Row counts are reported for the same
-- forensic reason 100100 reports them.
DO $$
DECLARE n integer;
BEGIN
  UPDATE public.discovered_assets a
     SET source = 'unifi'
   WHERE a.source IS NULL
     AND (a.detected_type_source = 'unifi_controller'
          OR EXISTS (SELECT 1 FROM public.unifi_devices u
                      WHERE u.discovered_asset_id = a.id));
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING 'backfilled % discovered_assets rows to source=unifi', n; END IF;
END $$;

DO $$
DECLARE n integer;
BEGIN
  UPDATE public.discovered_assets SET source = 'scan' WHERE source IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING 'backfilled % discovered_assets rows to source=scan', n; END IF;
END $$;
