-- Replay the row-writing DML of five shipped migrations under system scope.
-- Fix-forward for issue #4483; the static guard that stops NEW instances of
-- this class is src/db/migrationRlsScope.test.ts (#4518, PR #4866).
--
-- THE CLASS ------------------------------------------------------------------
-- `public.breeze_current_scope()` defaults to 'none' (deny-default,
-- 0012-tenant-rls-deny-default.sql), and once a table is
-- `FORCE ROW LEVEL SECURITY` its policies bind the table OWNER too — which is
-- the role migrations run as. So a migration that writes rows WITHOUT first
-- electing system scope silently matches ZERO rows on any migration connection
-- that does not bypass RLS: the original file's `RAISE WARNING` prints a
-- truthful-looking 0 and the upgrade moves on. The one-line house fix is
--
--   SELECT set_config('breeze.scope', 'system', true);
--
-- (`is_local = true` scopes it to autoMigrate's per-file transaction). Same
-- shape as 2026-09-30-100000-rls-scoped-backfill-replay.sql, the previous
-- fix-forward in this family, and 2026-09-29-100000-automation-policy-
-- compliance-unique.sql:39.
--
-- THE FIVE FILES REPLAYED HERE ------------------------------------------------
--   1. 2026-09-25-b-cross-site-restore-permission.sql
--        INSERT INTO role_permissions ... SELECT ... FROM roles r
--        `roles` is ENABLE+FORCE (2026-04-11-roles-rls-fix.sql). Under scope
--        'none' the SELECT source returns 0 rows, so backup:cross_site_restore
--        never reaches any Org Admin role. (The `permissions` seed half is
--        fine — `permissions` carries no RLS at all.)
--   2. 2026-09-27-technician-ticket-write-permissions.sql
--        Same shape, three permissions, `Partner Technician`. #4251's fix for
--        EXISTING installs is exactly this grant; seed.ts covers fresh ones.
--   3. 2026-10-06-100101-authenticator-attestation-state.sql
--        Two UPDATEs on `authenticator_devices` (ENABLE+FORCE since
--        2026-06-14-a-authenticator-foundation.sql) that classify pre-#1374
--        rows as `legacy_unattested` / `webauthn_backup_flags`. Unreplayed,
--        legacy mobile keys keep `platform_bound_basis = 'unattested'`, which
--        is a DIFFERENT L4 assurance verdict than the migration intended.
--   4. 2026-10-08-100600-audit-retention-manage-permission.sql
--        INSERT INTO role_permissions ... FROM roles r again — without it,
--        already-deployed orgs have no role holding audit:manage and the
--        retention settings route 403s for everyone including Org Admin.
--   5. 2026-10-08-100700-audit-retention-policies-org-unique.sql
--        DELETE of duplicate audit_retention_policies rows before
--        `ADD CONSTRAINT ... UNIQUE (org_id)`.
-- All five are content-hash immutable (autoMigrate's checksum guard), so they
-- can only ever be repaired forward — never edited. They stay in
-- UNSCOPED_DML_BASELINE for that reason; the baseline records what the shipped
-- BYTES do, and this file records that the EFFECT has been re-applied.
--
-- WHO IS ACTUALLY AFFECTED (stated honestly) ----------------------------------
-- A deployment is only affected if its migration role does not bypass RLS.
-- apps/api/scripts/check-migrations-nonsuperuser.ts records a measured A/B on
-- PG16: with the migrator NOBYPASSRLS the full migration set aborts at
-- 2026-05-22-snmp-multi-vendor-templates.sql with 42501, so any database that
-- ever applied the set from scratch necessarily had SUPERUSER or BYPASSRLS at
-- that moment (DigitalOcean's `doadmin` has BYPASSRLS; that script's comment
-- is this repo's only assertion of it). On such a deployment the five
-- originals DID take effect and every count below prints 0 — which is the
-- point of printing them: a recorded 0 is the evidence that the original ran,
-- not an RLS artifact. A deployment that later moved to a NOBYPASSRLS admin,
-- or was restored into one, gets the repair. Either way this file is a no-op
-- on a database where the originals worked.
--
-- WHY THIS FILE ALSO ADDS ONE POLICY -----------------------------------------
-- `authenticator_devices` is the only table in this set whose policy is
-- ROLE-RESTRICTED: `authenticator_devices_user_scope ... FOR ALL TO breeze_app`
-- (2026-06-14-a-authenticator-foundation.sql). PostgreSQL applies a policy only
-- to a role the current user has the privileges of (`has_privs_of_role`), and
-- nothing in this repo grants breeze_app membership to the migration role. So
-- for a NOBYPASSRLS owner-migrator there is NO applicable policy on that table
-- at all, and the deny-default stands EVEN under `breeze.scope = 'system'`.
--
-- Measured on PG16 (owner NOSUPERUSER NOBYPASSRLS, FORCE RLS, sole policy
-- `TO <other role>`): with scope='system', SELECT returned 0 of 2 rows and
-- UPDATE reported 0; adding one permissive policy with no TO clause restored
-- 2 of 2. The scope line ALONE would therefore reproduce the exact bug this
-- file repairs — a replay that reports 0 and changes nothing.
--
-- The policy added below carries the same predicate breeze_app already holds
-- through the `OR breeze_current_scope() = 'system'` branch of its own policy,
-- so it grants breeze_app nothing new. A PUBLIC policy confers no TABLE
-- privileges: the only roles that can reach `authenticator_devices` at all are
-- its owner (which can already `ALTER TABLE ... NO FORCE` at will) and
-- breeze_app. `breeze_audit_admin` holds SELECT/DELETE on `audit_logs` only
-- (2026-05-25-i-audit-retention-role.sql). Shape mirrors
-- `ai_kill_state_system_only` (2026-09-16-ai-agents-policy-decide-foundations)
-- and every `breeze_org_isolation_*` policy in the tree, none of which carry a
-- TO clause. The `user_id = breeze_current_user_id()` requirement for
-- non-system callers is untouched, and the rls-coverage contract test's
-- Shape-6 assertion (a per-command policy mentioning breeze_current_user_id)
-- still passes on the original policy.
--
-- IF YOUR UPGRADE ALREADY ABORTED AT 2026-10-08-100700 -----------------------
-- That file DELETEs duplicate audit_retention_policies rows and then adds a
-- UNIQUE(org_id) constraint. On a NOBYPASSRLS migrator holding real duplicates
-- the DELETE matches 0 rows and the ADD CONSTRAINT raises 23505, which rolls
-- back that file's transaction and crash-loops the API. autoMigrate applies
-- files in order, so THIS file never runs in that state and cannot rescue it —
-- the operator has to break the tie by hand:
--
--   BEGIN;
--   SELECT set_config('breeze.scope', 'system', true);
--   WITH ranked AS (
--     SELECT id, row_number() OVER (
--       PARTITION BY org_id ORDER BY updated_at DESC, created_at DESC, id) AS rn
--     FROM audit_retention_policies)
--   DELETE FROM audit_retention_policies WHERE id IN (SELECT id FROM ranked WHERE rn > 1);
--   COMMIT;
--
-- then restart the API: 100700 retries, finds no duplicates, and succeeds.
-- The constraint guard in section 5 below covers only the residual case where
-- 100700 committed but the constraint is missing anyway (e.g. dropped by hand
-- during such a repair).
--
-- DECLINED (review, #4926): a scoped dedup PREFLIGHT sorting between 100600
-- and 100700, so that abort could never happen. Rule 3 of
-- scripts/check-migration-naming.sh forbids a new file that does not sort
-- last, and per apps/api/scripts/check-migrations-nonsuperuser.ts a NOBYPASSRLS
-- migrator aborts the whole set at 2026-05-22-snmp-multi-vendor-templates.sql —
-- long before 100700 — so no database can reach 100700 with a migrator blind to
-- the dedup. The operator recipe above stays the fallback.
--
-- IDEMPOTENCY ----------------------------------------------------------------
-- Every statement re-selects the rows its original targeted (narrowed, never
-- widened — see section 3) and is a true no-op once applied: the two UPDATEs
-- filter on `platform_bound_basis = 'unattested'` (already rewritten rows drop
-- out) and on the ORIGINAL migration's own ledger timestamp, the grants
-- are `NOT EXISTS`-guarded, the dedup keeps one row per org so a second pass
-- finds none, and both DDL bits check the catalog first. No inner
-- BEGIN/COMMIT: autoMigrate wraps the whole file in one transaction.

SELECT set_config('breeze.scope', 'system', true);

-- Fail LOUD rather than silently no-op if the elevation did not take (e.g. a
-- future refactor sends this file outside a transaction, or a `@no-transaction`
-- directive gets pasted in and `is_local = true` stops applying).
DO $$
BEGIN
  IF public.breeze_current_scope() <> 'system' THEN
    RAISE EXCEPTION 'rls-scoped replay: breeze.scope is "%" (expected "system") — refusing to run a replay that would report 0 for the wrong reason',
      public.breeze_current_scope();
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 0. authenticator_devices — system-scope policy (rationale in the header)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.authenticator_devices') IS NULL THEN
    RAISE WARNING 'rls-scoped replay: authenticator_devices missing — skipping policy + section 3';
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'authenticator_devices'
      AND policyname = 'authenticator_devices_system_scope'
  ) THEN
    CREATE POLICY authenticator_devices_system_scope ON authenticator_devices
      FOR ALL
      USING     (public.breeze_current_scope() = 'system')
      WITH CHECK (public.breeze_current_scope() = 'system');
    RAISE WARNING 'rls-scoped replay: added authenticator_devices_system_scope (the existing user-scope policy is TO breeze_app only, which excludes the migration role)';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1. Replay 2026-09-25-b-cross-site-restore-permission.sql
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  n integer;
  v_permission_id uuid;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM permissions
    WHERE resource = 'backup' AND action = 'cross_site_restore'
  ) THEN
    INSERT INTO permissions (resource, action, description)
    VALUES ('backup', 'cross_site_restore', 'Restore backup data across sites');
    GET DIAGNOSTICS n = ROW_COUNT;
    RAISE WARNING 'rls-scoped replay: seeded % backup:cross_site_restore permission row(s)', n;
  END IF;

  -- Scalar lookup, not a JOIN — resolves to exactly one id even if legacy data
  -- holds duplicate (resource, action) rows (`permissions` has no unique key).
  SELECT id INTO v_permission_id
  FROM permissions
  WHERE resource = 'backup' AND action = 'cross_site_restore'
  ORDER BY id
  LIMIT 1;

  -- is_system = TRUE is load-bearing: routes/roles.ts lets a partner create a
  -- custom org role with any name, so matching on name alone would hand this
  -- capability to an attacker-created role called 'Org Admin'.
  INSERT INTO role_permissions (role_id, permission_id)
  SELECT r.id, v_permission_id
  FROM roles r
  WHERE r.name = 'Org Admin'
    AND r.scope = 'organization'
    AND r.is_system = TRUE
    AND v_permission_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM role_permissions rp
      WHERE rp.role_id = r.id AND rp.permission_id = v_permission_id
    );
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE WARNING 'rls-scoped replay: granted backup:cross_site_restore to % Org Admin role(s)', n;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Replay 2026-09-27-technician-ticket-write-permissions.sql
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  granted integer;
  total   integer := 0;
  perm    text;
BEGIN
  FOREACH perm IN ARRAY ARRAY['tickets:write', 'time_entries:read', 'time_entries:write']
  LOOP
    INSERT INTO role_permissions (role_id, permission_id)
    SELECT r.id, p.id
    FROM roles r
    JOIN permissions p
      ON p.resource = split_part(perm, ':', 1)
     AND p.action   = split_part(perm, ':', 2)
    WHERE r.is_system = true
      AND r.name = 'Partner Technician'
      AND NOT EXISTS (
        SELECT 1 FROM role_permissions x
        WHERE x.role_id = r.id AND x.permission_id = p.id
      );
    GET DIAGNOSTICS granted = ROW_COUNT;
    total := total + granted;
    RAISE WARNING 'rls-scoped replay: granted % to % Partner Technician role(s)', perm, granted;
  END LOOP;

  RAISE WARNING 'rls-scoped replay: technician ticket-write backfill inserted % role_permission row(s)', total;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Replay 2026-10-06-100101-authenticator-attestation-state.sql
-- ---------------------------------------------------------------------------
-- The cutoff is the ORIGINAL migration's own ledger timestamp
-- (`breeze_migrations.applied_at`), not this file's.
--
-- This is deliberately NOT the identical row set. On its first run the original
-- had no ledger row yet, so ITS cutoff was NULL and it updated every qualifying
-- row visible to it, unbounded in time. The replay always has that timestamp,
-- so it additionally excludes rows with `created_at >= applied_at` — a strictly
-- narrower set.
--
-- Narrower is the safe direction and the only correct one here.
-- `platform_bound_basis = 'unattested'` is not a pre-existing-row marker: since
-- #1374 shipped, every NEW mobile_hw_key registration writes exactly that value
-- on purpose (routes/authenticator.ts). The rows the cutoff excludes are
-- therefore post-#1374 registrations that are honestly unattested; relabelling
-- them `legacy_unattested` would be false and would strip L4 eligibility from
-- keys that never had a legacy basis — and it would corrupt the very forensic
-- counts these WARNINGs exist to produce. Nothing the original meant to
-- classify is lost by the exclusion: every row it could have been aiming at
-- already existed when it ran, so it predates its own `applied_at`.
--
-- A NULL cutoff means the original's ledger row is absent, which cannot happen
-- through autoMigrate (files apply in order and each records itself inside its
-- own transaction). If it somehow does, SKIP: classifying every 'unattested'
-- row would corrupt the forensic counts these WARNINGs exist to produce.
DO $$
DECLARE
  n      integer;
  cutoff timestamptz := NULL;
BEGIN
  IF to_regclass('public.authenticator_devices') IS NULL THEN
    RETURN;
  END IF;

  IF to_regclass('public.breeze_migrations') IS NOT NULL THEN
    SELECT applied_at INTO cutoff
      FROM breeze_migrations
     WHERE filename = '2026-10-06-100101-authenticator-attestation-state.sql';
  END IF;

  IF cutoff IS NULL THEN
    RAISE WARNING 'rls-scoped replay: no ledger row for 2026-10-06-100101-authenticator-attestation-state.sql — skipping the attestation replay rather than reclassifying post-#1374 registrations';
    RETURN;
  END IF;

  UPDATE authenticator_devices
     SET platform_bound_basis = 'legacy_unattested'
   WHERE kind = 'mobile_hw_key'
     AND platform_bound_basis = 'unattested'
     AND created_at < cutoff;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE WARNING 'rls-scoped replay (#1374): classified % pre-existing mobile_hw_key row(s) as legacy_unattested (these lose L4 eligibility)', n;

  -- `is_platform_bound = true` stays in the predicate: the
  -- webauthn_backup_flags basis MEANS `singleDevice && !backedUp`, so labelling
  -- a synced/backed-up passkey with it would simply be false. Such a row keeps
  -- the honest 'unattested' default.
  UPDATE authenticator_devices
     SET platform_bound_basis = 'webauthn_backup_flags'
   WHERE kind = 'webauthn_platform'
     AND platform_bound_basis = 'unattested'
     AND is_platform_bound = true
     AND created_at < cutoff;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE WARNING 'rls-scoped replay (#1374): classified % webauthn_platform row(s) as webauthn_backup_flags (backup-eligibility flags, not hardware attestation)', n;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Replay 2026-10-08-100600-audit-retention-manage-permission.sql
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  n integer;
  v_permission_id uuid;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM permissions WHERE resource = 'audit' AND action = 'manage'
  ) THEN
    INSERT INTO permissions (resource, action, description)
    VALUES ('audit', 'manage', 'Manage the audit log retention policy');
    GET DIAGNOSTICS n = ROW_COUNT;
    RAISE WARNING 'rls-scoped replay: seeded % audit:manage permission row(s)', n;
  END IF;

  SELECT id INTO v_permission_id
  FROM permissions
  WHERE resource = 'audit' AND action = 'manage'
  ORDER BY id
  LIMIT 1;

  INSERT INTO role_permissions (role_id, permission_id)
  SELECT r.id, v_permission_id
  FROM roles r
  WHERE r.name = 'Org Admin'
    AND r.scope = 'organization'
    AND r.is_system = TRUE
    AND v_permission_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM role_permissions rp
      WHERE rp.role_id = r.id AND rp.permission_id = v_permission_id
    );
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE WARNING 'rls-scoped replay: granted audit:manage to % Org Admin role(s)', n;
END $$;

-- ---------------------------------------------------------------------------
-- 5. Replay 2026-10-08-100700-audit-retention-policies-org-unique.sql
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  n integer;
BEGIN
  WITH ranked AS (
    SELECT id, row_number() OVER (
      PARTITION BY org_id ORDER BY updated_at DESC, created_at DESC, id
    ) AS rn
    FROM audit_retention_policies
  )
  DELETE FROM audit_retention_policies
  WHERE id IN (SELECT id FROM ranked WHERE rn > 1);
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE WARNING 'rls-scoped replay: removed % duplicate audit_retention_policies row(s) (most recently updated row per org is kept)', n;
END $$;

-- Residual guard only — see "IF YOUR UPGRADE ALREADY ABORTED" in the header.
-- If 100700 committed, this constraint already exists and this is a no-op.
--
-- The existence check is keyed on (conrelid, conname), not conname alone:
-- constraint names are unique per TABLE, not per schema, so a same-named
-- constraint on some other relation would make a bare conname probe skip the
-- work silently.
--
-- Constraints and indexes share one relation-name namespace, so a leftover
-- INDEX called `audit_retention_policies_org_id_key` (a hand-repair that ran
-- `CREATE UNIQUE INDEX` instead of `ADD CONSTRAINT`, which is the natural way
-- to dedup-and-protect without an ACCESS EXCLUSIVE rewrite) makes a bare
-- `ADD CONSTRAINT` fail with 42P07 and abort the upgrade. Promote that index
-- in place instead. If the leftover is NOT the index a `UNIQUE (org_id)`
-- constraint would have built — non-unique, invalid, partial, expression, or
-- on other columns — `USING INDEX` would raise too, so warn and leave it for a
-- human rather than erroring: this is a residual guard, not a load-bearing
-- step, and it must never be the thing that stops an upgrade.
DO $$
DECLARE
  v_table   oid := to_regclass('public.audit_retention_policies');
  v_index   oid;
  v_promote boolean := false;
BEGIN
  IF v_table IS NULL THEN
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = v_table
      AND conname  = 'audit_retention_policies_org_id_key'
  ) THEN
    RETURN;
  END IF;

  SELECT c.oid INTO v_index
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname = 'audit_retention_policies_org_id_key'
    AND c.relkind = 'i';

  IF v_index IS NULL THEN
    ALTER TABLE audit_retention_policies
      ADD CONSTRAINT audit_retention_policies_org_id_key UNIQUE (org_id);
    RAISE WARNING 'rls-scoped replay: added the missing audit_retention_policies_org_id_key UNIQUE constraint';
    RETURN;
  END IF;

  SELECT i.indisunique
     AND i.indisvalid
     AND i.indpred IS NULL
     AND i.indexprs IS NULL
     AND i.indrelid = v_table
     AND i.indnatts = 1
     AND i.indkey[0] = (
           SELECT a.attnum FROM pg_attribute a
           WHERE a.attrelid = v_table AND a.attname = 'org_id' AND NOT a.attisdropped
         )
    INTO v_promote
  FROM pg_index i
  WHERE i.indexrelid = v_index;

  IF COALESCE(v_promote, false) THEN
    ALTER TABLE audit_retention_policies
      ADD CONSTRAINT audit_retention_policies_org_id_key
      UNIQUE USING INDEX audit_retention_policies_org_id_key;
    RAISE WARNING 'rls-scoped replay: promoted the existing unique index audit_retention_policies_org_id_key into the matching UNIQUE constraint';
  ELSE
    RAISE WARNING 'rls-scoped replay: a relation named audit_retention_policies_org_id_key exists but is not a plain valid unique index on (org_id) — leaving it alone; the UNIQUE(org_id) constraint is still MISSING and needs a human';
  END IF;
END $$;
