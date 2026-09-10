-- Dedicated pam:approve / pam:manage_policy permissions, replacing the
-- generic devices:execute/devices:write grants PAM approve/deny and rule
-- authorship used to ride on (security review wave 7, SR1-13/SR1-14). An
-- ordinary technician holding devices:execute/write for routine device work
-- must not thereby be able to approve elevations or author the rules that
-- decide who gets standing admin automatically.
--
-- Grant predicate: copies 2026-10-08-100600-audit-retention-manage-permission.sql,
-- NOT 2026-09-03-ai-agents-permissions.sql. `r.name = 'Org Admin' AND
-- r.scope = 'organization' AND r.is_system = TRUE`, with NO
-- `partner_id IS NULL` clause: per-partner `is_system` Org Admin clones exist
-- in production (Org Admin roles are seeded per-partner, one row per
-- partner), so a global-template-only grant would reach nobody on upgrade.
-- `is_system = TRUE` is the anti-forgery filter — custom roles created via
-- routes/roles.ts are always `is_system = FALSE`, so this can never grant PAM
-- authority to an attacker-created role merely named "Org Admin".
--
-- Partner Admin already holds the wildcard '*:*' permission, so it needs no
-- explicit row here.
--
-- Idempotent: safe to re-run. permissions.id defaults to gen_random_uuid() at
-- the DB level (0001-baseline.sql), so no id is supplied on insert.
--
-- NOTE: permissions has NO UNIQUE constraint on (resource, action) — only a
-- primary key on id. `ON CONFLICT DO NOTHING` therefore has nothing to
-- conflict against and would silently insert a duplicate on every re-apply.
-- Use an explicit existence check, matching
-- 2026-10-08-100600-audit-retention-manage-permission.sql.
--
-- Every write in this file (permissions/role_permissions seeding AND the
-- pam_rules quarantine below) runs under system scope: on a connection that
-- does not bypass RLS, an UPDATE/INSERT with no scope elected either matches
-- zero rows silently or aborts with 42501 (issue #4518). One `set_config` at
-- the top of the file covers the whole migration — `is_local = true` scopes
-- it to autoMigrate's per-file transaction.
SELECT set_config('breeze.scope', 'system', true);

DO $$
DECLARE
  n integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM permissions WHERE resource = 'pam' AND action = 'approve'
  ) THEN
    INSERT INTO permissions (resource, action, description)
    VALUES ('pam', 'approve', 'Approve or deny PAM elevation requests');
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 THEN
      RAISE WARNING 'seeded pam:approve permission row';
    END IF;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM permissions WHERE resource = 'pam' AND action = 'manage_policy'
  ) THEN
    INSERT INTO permissions (resource, action, description)
    VALUES ('pam', 'manage_policy', 'Create, update, and delete PAM rules, signer groups, and org config');
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 THEN
      RAISE WARNING 'seeded pam:manage_policy permission row';
    END IF;
  END IF;
END $$;

DO $$
DECLARE
  n integer;
  v_approve_id uuid;
  v_manage_policy_id uuid;
BEGIN
  -- Scalar lookups (not JOINs) so this stays correct even if a duplicate
  -- permissions row were ever present — always resolves to exactly one id.
  SELECT id INTO v_approve_id FROM permissions
  WHERE resource = 'pam' AND action = 'approve' ORDER BY id LIMIT 1;

  SELECT id INTO v_manage_policy_id FROM permissions
  WHERE resource = 'pam' AND action = 'manage_policy' ORDER BY id LIMIT 1;

  -- is_system = TRUE is LOAD-BEARING, not cosmetic: custom org roles accept an
  -- arbitrary caller-supplied name (routes/roles.ts POST creates them with
  -- is_system = false), so matching on name alone would grant PAM authority to
  -- any attacker-created role named 'Org Admin'. Only the built-in Org Admin
  -- roles (one per partner, plus the global system-template row) carry
  -- is_system = TRUE. No `partner_id IS NULL` filter — sweep ALL of them.
  INSERT INTO role_permissions (role_id, permission_id)
  SELECT r.id, v_approve_id
  FROM roles r
  WHERE r.name = 'Org Admin'
    AND r.scope = 'organization'
    AND r.is_system = TRUE
    AND v_approve_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM role_permissions rp
      WHERE rp.role_id = r.id AND rp.permission_id = v_approve_id
    );
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING 'granted pam:approve to % existing Org Admin role(s)', n;
  END IF;

  INSERT INTO role_permissions (role_id, permission_id)
  SELECT r.id, v_manage_policy_id
  FROM roles r
  WHERE r.name = 'Org Admin'
    AND r.scope = 'organization'
    AND r.is_system = TRUE
    AND v_manage_policy_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM role_permissions rp
      WHERE rp.role_id = r.id AND rp.permission_id = v_manage_policy_id
    );
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING 'granted pam:manage_policy to % existing Org Admin role(s)', n;
  END IF;
END $$;

-- Legacy auto_approve quarantine (§6B — amends the original plan's
-- `enabled = false` approach). Do NOT disable the rule: pamRuleEngine.ts's
-- evaluatePamRules() skips disabled rules entirely and falls through to a
-- lower-priority rule or the org's default_unmatched_verdict, which can
-- silently turn an intended auto-approve into an auto-deny. Instead, the rule
-- KEEPS MATCHING but every match now waits for a human: its original verdict
-- is preserved in `suspended_verdict` and `verdict` is forced to
-- 'require_approval'. An admin restores it via
-- `PATCH /pam/rules/:id { reapprove: true }` (requires pam:manage_policy +
-- MFA), which is the ONLY path that clears suspended_verdict.
--
-- Idempotent: a rule already migrated has verdict='require_approval', so it
-- no longer matches `WHERE verdict = 'auto_approve'` on re-apply — 0 rows,
-- reported honestly below.
ALTER TABLE pam_rules ADD COLUMN IF NOT EXISTS suspended_verdict pam_rule_verdict;
ALTER TABLE pam_rules ADD COLUMN IF NOT EXISTS reapproved_at timestamptz;
ALTER TABLE pam_rules ADD COLUMN IF NOT EXISTS reapproved_by_user_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pam_rules_reapproved_by_user_id_fkey'
  ) THEN
    ALTER TABLE pam_rules
      ADD CONSTRAINT pam_rules_reapproved_by_user_id_fkey
      FOREIGN KEY (reapproved_by_user_id) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;

-- (breeze.scope is already 'system' from the top of this file — pam_rules is
-- FORCE ROW LEVEL SECURITY (Shape 1, org_id), so this UPDATE would otherwise
-- match ZERO rows silently on a non-superuser/non-BYPASSRLS connection and
-- the RAISE WARNING below would report a truthful-looking "0" that is
-- actually an RLS artifact, not evidence nothing needed quarantining.)
DO $$
DECLARE
  n integer;
BEGIN
  UPDATE pam_rules
  SET suspended_verdict = verdict,
      verdict = 'require_approval',
      updated_at = now()
  WHERE verdict = 'auto_approve' AND enabled;
  GET DIAGNOSTICS n = ROW_COUNT;
  -- Always report, including 0: a 0 here on a fresh install (no pre-existing
  -- auto_approve rules) is expected, not evidence the UPDATE silently no-op'd
  -- under RLS.
  RAISE WARNING 'quarantined % auto_approve pam rules (verdict -> require_approval, suspended_verdict preserved)', n;
END $$;
