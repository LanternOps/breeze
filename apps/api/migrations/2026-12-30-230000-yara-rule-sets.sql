-- #6263 W03a (#6266): YARA rule sets and their rules.
--
-- A rule set is owned by an org XOR a partner (Partner-Wide First, epic
-- #2135), or is THE single read-only built-in pack (is_builtin, both owners
-- NULL; upserted at boot by W03b under system scope, never by a route).
--
-- Agents compile on-device (owner decision 2026-10-13, spec §14). The server
-- never stores bytecode: every successful pre-check snapshots the canonical
-- W02 §C2 source bundle into published_bundle (DECISION W03-a). A failed
-- pre-check bumps current_version, sets stale, and leaves the last good
-- published_* snapshot in place. There is no version history (DECISION
-- W03-b): an agent fetching any version other than published_version gets 409.
--
-- yara_rules carries denormalized org_id/partner_id/is_builtin so rule
-- source (customer IP) rides the org export/erasure path keyed on org_id
-- (DECISION W03-c). Two triggers keep the copy exact: children inherit the
-- parent's owner on every INSERT/UPDATE (a caller cannot lie), and an owner
-- change on the parent (org merge repoint) rewrites its children.
--
-- RLS ships with the tables (tenancy-rls.md step 1), ENABLE + FORCE on both:
--   * <table>_isolation         FOR ALL dual-axis (security_policies shape,
--                               2026-07-01). Built-in rows have both owners
--                               NULL, so only system scope can write them.
--   * <table>_partner_wide_select  SELECT-only own-partner branch
--                               (2026-10-11-000200 template). Separate policy,
--                               never appended to FOR ALL, so org callers can
--                               READ but never UPDATE/DELETE partner-wide rows.
--                               Load-bearing on the agent path: agentAuth sets
--                               current_partner_id = device.partnerId.
--   * <table>_builtin_select    SELECT-only built-in branch (alert_templates
--                               precedent, 2026-04-22).
--
-- security_scans gains the explicit scan outcome (engine + rule_set_errors)
-- so degraded coverage is never presented as a YARA scan.
--
-- Writes no rows, so no `breeze.scope` elevation (migrationRlsScope.test.ts).
-- Idempotent: IF NOT EXISTS / CREATE OR REPLACE / DROP ... IF EXISTS then
-- CREATE. No inner BEGIN/COMMIT — autoMigrate wraps each file.

CREATE TABLE IF NOT EXISTS public.yara_rule_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  partner_id uuid NULL REFERENCES public.partners(id) ON DELETE CASCADE,
  name varchar(255) NOT NULL,
  description text NULL,
  source varchar(50) NOT NULL DEFAULT 'custom',
  is_builtin boolean NOT NULL DEFAULT false,
  enabled boolean NOT NULL DEFAULT true,
  auto_quarantine boolean NOT NULL DEFAULT false,
  current_version integer NOT NULL DEFAULT 0,
  published_version integer NOT NULL DEFAULT 0,
  published_bundle bytea NULL,
  published_sha256 char(64) NULL,
  published_at timestamptz NULL,
  published_engine varchar(64) NULL,
  published_policy integer NULL,
  stale boolean NOT NULL DEFAULT false,
  rule_count integer NOT NULL DEFAULT 0,
  created_by uuid NULL REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT yara_rule_sets_source_chk CHECK (source IN ('builtin', 'custom', 'import')),
  -- Only the built-in row may claim source 'builtin', and it must.
  CONSTRAINT yara_rule_sets_builtin_source_chk CHECK ((source = 'builtin') = is_builtin),
  -- Built-in <=> both owners NULL; otherwise exactly one owner. (Quorum
  -- finding: `is_builtin OR XOR` would let a tenant mint a globally readable
  -- "built-in" by setting the flag on a row it owns.)
  CONSTRAINT yara_rule_sets_one_owner_chk CHECK (
    (is_builtin AND org_id IS NULL AND partner_id IS NULL)
    OR (NOT is_builtin AND ((org_id IS NULL) <> (partner_id IS NULL)))
  ),
  CONSTRAINT yara_rule_sets_versions_chk CHECK (
    current_version >= 0 AND published_version >= 0 AND published_version <= current_version
  ),
  CONSTRAINT yara_rule_sets_published_chk CHECK (
    (published_version = 0 AND published_bundle IS NULL AND published_sha256 IS NULL)
    OR (published_version > 0 AND published_bundle IS NOT NULL AND published_sha256 ~ '^[0-9a-f]{64}$')
  ),
  CONSTRAINT yara_rule_sets_rule_count_chk CHECK (rule_count >= 0)
);
CREATE INDEX IF NOT EXISTS yara_rule_sets_org_idx ON public.yara_rule_sets (org_id);
CREATE INDEX IF NOT EXISTS yara_rule_sets_partner_idx ON public.yara_rule_sets (partner_id);
-- At most one built-in pack.
CREATE UNIQUE INDEX IF NOT EXISTS yara_rule_sets_single_builtin_idx
  ON public.yara_rule_sets ((true)) WHERE is_builtin;

CREATE TABLE IF NOT EXISTS public.yara_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_set_id uuid NOT NULL REFERENCES public.yara_rule_sets(id) ON DELETE CASCADE,
  org_id uuid NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  partner_id uuid NULL REFERENCES public.partners(id) ON DELETE CASCADE,
  is_builtin boolean NOT NULL DEFAULT false,
  name varchar(128) NOT NULL,
  source text NOT NULL,
  severity public.threat_severity NOT NULL DEFAULT 'high',
  tags text[] NOT NULL DEFAULT '{}',
  meta jsonb NULL,
  enabled boolean NOT NULL DEFAULT true,
  compile_error text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT yara_rules_name_chk CHECK (name ~ '^[A-Za-z_][A-Za-z0-9_]{0,127}$'),
  CONSTRAINT yara_rules_source_len_chk CHECK (octet_length(source) <= 65536),
  CONSTRAINT yara_rules_one_owner_chk CHECK (
    (is_builtin AND org_id IS NULL AND partner_id IS NULL)
    OR (NOT is_builtin AND ((org_id IS NULL) <> (partner_id IS NULL)))
  ),
  CONSTRAINT yara_rules_set_name_uniq UNIQUE (rule_set_id, name)
);
CREATE INDEX IF NOT EXISTS yara_rules_org_idx ON public.yara_rules (org_id);
CREATE INDEX IF NOT EXISTS yara_rules_partner_idx ON public.yara_rules (partner_id);

-- DECISION W03-c: a child's owner columns always equal its parent's. The
-- parent SELECT runs under the caller's RLS (SECURITY INVOKER), so a caller
-- who cannot see the parent gets 23503 — no writing children under someone
-- else's set. A caller who can only READ the parent (org user vs a
-- partner-wide set) gets the parent's owner copied in, which the FOR ALL
-- WITH CHECK then rejects with 42501.
CREATE OR REPLACE FUNCTION public.yara_rules_inherit_owner() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  p record;
BEGIN
  SELECT org_id, partner_id, is_builtin INTO p
    FROM public.yara_rule_sets WHERE id = NEW.rule_set_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'yara_rules.rule_set_id % not visible or missing', NEW.rule_set_id
      USING ERRCODE = '23503';
  END IF;
  NEW.org_id := p.org_id;
  NEW.partner_id := p.partner_id;
  NEW.is_builtin := p.is_builtin;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS yara_rules_inherit_owner_trg ON public.yara_rules;
CREATE TRIGGER yara_rules_inherit_owner_trg
  BEFORE INSERT OR UPDATE ON public.yara_rules
  FOR EACH ROW EXECUTE FUNCTION public.yara_rules_inherit_owner();

-- Org merge repoints yara_rule_sets.org_id; keep the children in step.
CREATE OR REPLACE FUNCTION public.yara_rule_sets_propagate_owner() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.partner_id IS DISTINCT FROM OLD.partner_id
     OR NEW.is_builtin IS DISTINCT FROM OLD.is_builtin THEN
    UPDATE public.yara_rules
       SET org_id = NEW.org_id, partner_id = NEW.partner_id, is_builtin = NEW.is_builtin
     WHERE rule_set_id = NEW.id;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS yara_rule_sets_propagate_owner_trg ON public.yara_rule_sets;
CREATE TRIGGER yara_rule_sets_propagate_owner_trg
  AFTER UPDATE OF org_id, partner_id, is_builtin ON public.yara_rule_sets
  FOR EACH ROW EXECUTE FUNCTION public.yara_rule_sets_propagate_owner();

ALTER TABLE public.yara_rule_sets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.yara_rule_sets FORCE ROW LEVEL SECURITY;
ALTER TABLE public.yara_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.yara_rules FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS yara_rule_sets_isolation ON public.yara_rule_sets;
CREATE POLICY yara_rule_sets_isolation
  ON public.yara_rule_sets
  USING (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  )
  WITH CHECK (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  );

DROP POLICY IF EXISTS yara_rule_sets_partner_wide_select ON public.yara_rule_sets;
CREATE POLICY yara_rule_sets_partner_wide_select
  ON public.yara_rule_sets
  FOR SELECT
  USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id());

DROP POLICY IF EXISTS yara_rule_sets_builtin_select ON public.yara_rule_sets;
CREATE POLICY yara_rule_sets_builtin_select
  ON public.yara_rule_sets
  FOR SELECT
  USING (is_builtin);

DROP POLICY IF EXISTS yara_rules_isolation ON public.yara_rules;
CREATE POLICY yara_rules_isolation
  ON public.yara_rules
  USING (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  )
  WITH CHECK (
    public.breeze_current_scope() = 'system'
    OR (org_id IS NOT NULL AND public.breeze_has_org_access(org_id))
    OR (partner_id IS NOT NULL AND public.breeze_has_partner_access(partner_id))
  );

DROP POLICY IF EXISTS yara_rules_partner_wide_select ON public.yara_rules;
CREATE POLICY yara_rules_partner_wide_select
  ON public.yara_rules
  FOR SELECT
  USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id());

DROP POLICY IF EXISTS yara_rules_builtin_select ON public.yara_rules;
CREATE POLICY yara_rules_builtin_select
  ON public.yara_rules
  FOR SELECT
  USING (is_builtin);

-- Scan outcome (quorum finding: degraded coverage must be explicit).
--   engine          'yara' | 'legacy' (NULL on rows written before W03)
--   rule_set_errors [{ id, version?, code, detail? }] — dispatch-time resolver
--                   errors plus agent-reported fetch/compile failures (W02 C3)
ALTER TABLE public.security_scans ADD COLUMN IF NOT EXISTS engine varchar(16) NULL;
ALTER TABLE public.security_scans ADD COLUMN IF NOT EXISTS rule_set_errors jsonb NULL;
