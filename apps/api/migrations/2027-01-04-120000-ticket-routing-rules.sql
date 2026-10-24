-- #8883 W5 (#9785): ticket routing rules.
-- Spec: docs/superpowers/specs/ticketing/2026-10-18-ticketing-merge-sla-calendars-routing-spec.md §5.1, §8.1.
-- Plan: docs/superpowers/plans/ticketing/2026-10-22-ticketing-merge-sla-calendars-routing.md Task 5.1.
--
-- Tenancy shape: ticket_routing_rules is a CONFIG table (an MSP writes one
-- set of rules and every org inherits them), so it follows "Partner-Wide
-- First": org_id XOR partner_id (ticket_routing_rules_one_owner_chk), ONE
-- dual-axis FOR ALL policy, and two SEPARATE SELECT-only read branches — the
-- partner-wide branch keyed on breeze_current_partner_id() and the org-member
-- branch for organization sessions, whose JWT carries no partner id (same
-- three policies as 2027-01-03-160000-business-calendars.sql, section 7). The
-- read branches are never appended to the FOR ALL policy, so an org token can
-- READ a partner-wide rule but its UPDATE/DELETE matches 0 rows.
--
-- ticket_routing_rule_org_links is an FK child of the rule: its org_id is the
-- ALLOWLISTED org (data), not the tenancy axis. RLS joins through the parent
-- (template 2026-07-11-ticket-form-org-links.sql), plus a SELECT-only branch
-- that admits a caller's OWN org's link of a rule it can read, so the create
-- path can apply a partner-wide rule's allowlist under an org context without
-- disclosing which sibling orgs a rule names.
--
-- Fail closed: whether a partner-wide rule is limited to listed orgs is the
-- explicit org_scoped flag, never "has link rows". Otherwise deleting the only
-- listed org (its link cascades away) would silently widen the rule to every
-- org of the partner. An org_scoped rule with no links matches nothing.
--
-- References (Gate B4): an org-owned rule has partner_id NULL, so a composite
-- (category_id, partner_id) FK cannot bind it. Category / status FKs are plain
-- ON DELETE RESTRICT (a deleted category must never widen a rule into a
-- catch-all), and a constraint trigger resolves the rule's partner (its own,
-- or its org's) and refuses a category, status or assignee of another
-- partner. "At least one action" is a service validation, not a CHECK
-- (Gate B13): set_assignee_user_id is ON DELETE SET NULL, and deleting a user
-- whose rule only assigns must succeed and leave a visible no-action rule.
--
-- No org-axis unique on name or (org_id, position): org merge repoints
-- org-owned rules, and a collision would 23505. Ordering is (position, id),
-- which is deterministic without uniqueness.
--
-- No jsonb anywhere: every column is export-policy `included`.
--
-- tickets.routing_rule_id is NOT here: hot-table DDL on tickets lives in its
-- own -- @no-transaction file (2027-01-04-120100).
--
-- Idempotent (IF NOT EXISTS / DO $$ pg_constraint guards / DROP … IF EXISTS
-- + CREATE). No inner BEGIN/COMMIT. No row is written, so no system-scope
-- election is needed.

-- ============================================
-- 1. ticket_statuses (id, partner_id) key
-- ============================================
-- Mirrors ticket_categories_id_partner_id_key (2026-06-10-c). Constraint only.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ticket_statuses_id_partner_id_key') THEN
    ALTER TABLE ticket_statuses ADD CONSTRAINT ticket_statuses_id_partner_id_key UNIQUE (id, partner_id);
  END IF;
END $$;

-- ============================================
-- 2. ticket_routing_rules
-- ============================================
CREATE TABLE IF NOT EXISTS ticket_routing_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  partner_id uuid REFERENCES partners(id) ON DELETE CASCADE,
  name varchar(100) NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  position integer NOT NULL DEFAULT 0,
  -- Conditions: AND across columns, OR within a list, NULL/empty = any.
  match_sources ticket_source[],
  match_priorities ticket_priority[],
  match_category_id uuid REFERENCES ticket_categories(id) ON DELETE RESTRICT,
  match_subject_keywords text[],
  match_requester_domains text[],
  -- Actions.
  set_assignee_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  set_priority ticket_priority,
  set_category_id uuid REFERENCES ticket_categories(id) ON DELETE RESTRICT,
  set_status_id uuid REFERENCES ticket_statuses(id) ON DELETE RESTRICT,
  add_tags text[],
  -- Partner-wide rules only: true = applies to the orgs in
  -- ticket_routing_rule_org_links and nothing else (none listed = no org).
  org_scoped boolean NOT NULL DEFAULT false,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ticket_routing_rules_one_owner_chk' AND conrelid = 'ticket_routing_rules'::regclass) THEN
    ALTER TABLE ticket_routing_rules ADD CONSTRAINT ticket_routing_rules_one_owner_chk CHECK ((org_id IS NULL) <> (partner_id IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ticket_routing_rules_name_chk' AND conrelid = 'ticket_routing_rules'::regclass) THEN
    ALTER TABLE ticket_routing_rules ADD CONSTRAINT ticket_routing_rules_name_chk CHECK (char_length(btrim(name)) BETWEEN 1 AND 100);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ticket_routing_rules_org_scoped_chk' AND conrelid = 'ticket_routing_rules'::regclass) THEN
    ALTER TABLE ticket_routing_rules ADD CONSTRAINT ticket_routing_rules_org_scoped_chk CHECK (NOT org_scoped OR org_id IS NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ticket_routing_rules_keywords_chk' AND conrelid = 'ticket_routing_rules'::regclass) THEN
    ALTER TABLE ticket_routing_rules ADD CONSTRAINT ticket_routing_rules_keywords_chk CHECK (cardinality(match_subject_keywords) <= 20);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS ticket_routing_rules_org_position_idx
  ON ticket_routing_rules (org_id, position) WHERE org_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ticket_routing_rules_partner_position_idx
  ON ticket_routing_rules (partner_id, position) WHERE org_id IS NULL;
-- The ON DELETE SET NULL / RESTRICT lookups on users, categories and statuses.
CREATE INDEX IF NOT EXISTS ticket_routing_rules_set_assignee_idx
  ON ticket_routing_rules (set_assignee_user_id) WHERE set_assignee_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ticket_routing_rules_match_category_idx
  ON ticket_routing_rules (match_category_id) WHERE match_category_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ticket_routing_rules_set_category_idx
  ON ticket_routing_rules (set_category_id) WHERE set_category_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ticket_routing_rules_set_status_idx
  ON ticket_routing_rules (set_status_id) WHERE set_status_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ticket_routing_rules_created_by_idx
  ON ticket_routing_rules (created_by_user_id) WHERE created_by_user_id IS NOT NULL;

-- ============================================
-- 3. Same-partner reference guard (Gate B4)
-- ============================================
-- CONSTRAINT trigger, DEFERRABLE INITIALLY IMMEDIATE: org merge runs
-- SET CONSTRAINTS ALL DEFERRED, so the guard checks the final state. A
-- referenced row the caller cannot see is reported FK-shaped (23503); a row of
-- another partner is check_violation (23514) with a *_chk constraint name.
CREATE OR REPLACE FUNCTION public.ticket_routing_rules_ref_partner_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  rule_partner_id uuid;
  ref_partner_id uuid;
  ref_id uuid;
BEGIN
  IF NEW.partner_id IS NOT NULL THEN
    rule_partner_id := NEW.partner_id;
  ELSE
    SELECT o.partner_id INTO rule_partner_id FROM public.organizations AS o WHERE o.id = NEW.org_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'insert or update on table "ticket_routing_rules" violates foreign key constraint "ticket_routing_rules_org_id_fkey"'
        USING ERRCODE = '23503', CONSTRAINT = 'ticket_routing_rules_org_id_fkey';
    END IF;
  END IF;

  FOREACH ref_id IN ARRAY ARRAY[NEW.match_category_id, NEW.set_category_id]
  LOOP
    CONTINUE WHEN ref_id IS NULL;
    SELECT c.partner_id INTO ref_partner_id FROM public.ticket_categories AS c WHERE c.id = ref_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'insert or update on table "ticket_routing_rules" references a ticket category that does not exist'
        USING ERRCODE = '23503', CONSTRAINT = 'ticket_routing_rules_ref_partner_chk';
    END IF;
    IF ref_partner_id IS DISTINCT FROM rule_partner_id THEN
      RAISE EXCEPTION 'ticket routing rule references a ticket category of another partner'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'ticket_routing_rules_ref_partner_chk';
    END IF;
  END LOOP;

  IF NEW.set_status_id IS NOT NULL THEN
    SELECT s.partner_id INTO ref_partner_id FROM public.ticket_statuses AS s WHERE s.id = NEW.set_status_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'insert or update on table "ticket_routing_rules" references a ticket status that does not exist'
        USING ERRCODE = '23503', CONSTRAINT = 'ticket_routing_rules_ref_partner_chk';
    END IF;
    IF ref_partner_id IS DISTINCT FROM rule_partner_id THEN
      RAISE EXCEPTION 'ticket routing rule references a ticket status of another partner'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'ticket_routing_rules_ref_partner_chk';
    END IF;
  END IF;

  -- A user with partner_id NULL (a platform/system user) is not refused here;
  -- assignee eligibility is re-checked by the evaluator on every create.
  IF NEW.set_assignee_user_id IS NOT NULL THEN
    SELECT u.partner_id INTO ref_partner_id FROM public.users AS u WHERE u.id = NEW.set_assignee_user_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'insert or update on table "ticket_routing_rules" references a user that does not exist'
        USING ERRCODE = '23503', CONSTRAINT = 'ticket_routing_rules_ref_partner_chk';
    END IF;
    IF ref_partner_id IS NOT NULL AND ref_partner_id IS DISTINCT FROM rule_partner_id THEN
      RAISE EXCEPTION 'ticket routing rule assigns a user of another partner'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'ticket_routing_rules_ref_partner_chk';
    END IF;
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS ticket_routing_rules_ref_partner_guard_trg ON ticket_routing_rules;
CREATE CONSTRAINT TRIGGER ticket_routing_rules_ref_partner_guard_trg
  AFTER INSERT OR UPDATE OF match_category_id, set_category_id, set_status_id, set_assignee_user_id, org_id, partner_id
  ON ticket_routing_rules
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION public.ticket_routing_rules_ref_partner_guard();

-- ============================================
-- 4. ticket_routing_rule_org_links
-- ============================================
-- The allowlist of an org_scoped partner-wide rule (the service refuses links
-- on an org-owned or non-org_scoped rule).
CREATE TABLE IF NOT EXISTS ticket_routing_rule_org_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id uuid NOT NULL REFERENCES ticket_routing_rules(id) ON DELETE CASCADE,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ticket_routing_rule_org_links_rule_org_uq' AND conrelid = 'ticket_routing_rule_org_links'::regclass) THEN
    ALTER TABLE ticket_routing_rule_org_links ADD CONSTRAINT ticket_routing_rule_org_links_rule_org_uq UNIQUE (rule_id, org_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS ticket_routing_rule_org_links_rule_id_idx ON ticket_routing_rule_org_links (rule_id);
CREATE INDEX IF NOT EXISTS ticket_routing_rule_org_links_org_id_idx ON ticket_routing_rule_org_links (org_id);

-- ============================================
-- 5. RLS — ticket_routing_rules
-- ============================================
ALTER TABLE ticket_routing_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_routing_rules FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ticket_routing_rules_isolation ON ticket_routing_rules;
CREATE POLICY ticket_routing_rules_isolation ON ticket_routing_rules
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

-- `=` and not IS NOT DISTINCT FROM: an unset GUC reads NULL and must never match.
DROP POLICY IF EXISTS ticket_routing_rules_partner_wide_select ON ticket_routing_rules;
CREATE POLICY ticket_routing_rules_partner_wide_select ON ticket_routing_rules
  FOR SELECT USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id());

-- Organization sessions carry partnerId = NULL (middleware/auth.ts), so the
-- branch above never matches for an org user; without this, an org user's
-- staff-created ticket would silently see no partner-wide rule. A
-- partner-wide rule is readable by a session with access to an org of THAT
-- partner. The organizations read runs under the caller's own RLS.
DROP POLICY IF EXISTS ticket_routing_rules_org_member_select ON ticket_routing_rules;
CREATE POLICY ticket_routing_rules_org_member_select ON ticket_routing_rules
  FOR SELECT USING (
    org_id IS NULL
    AND EXISTS (
      SELECT 1 FROM public.organizations o
       WHERE o.partner_id = ticket_routing_rules.partner_id
         AND public.breeze_has_org_access(o.id)
    )
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON ticket_routing_rules TO breeze_app;

-- ============================================
-- 6. RLS — ticket_routing_rule_org_links (parent join)
-- ============================================
ALTER TABLE ticket_routing_rule_org_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_routing_rule_org_links FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ticket_routing_rule_org_links_isolation ON ticket_routing_rule_org_links;
CREATE POLICY ticket_routing_rule_org_links_isolation ON ticket_routing_rule_org_links
  USING (
    EXISTS (
      SELECT 1 FROM public.ticket_routing_rules r
       WHERE r.id = ticket_routing_rule_org_links.rule_id
         AND (
           public.breeze_current_scope() = 'system'
           OR (r.org_id IS NOT NULL AND public.breeze_has_org_access(r.org_id))
           OR (r.partner_id IS NOT NULL AND public.breeze_has_partner_access(r.partner_id))
         )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.ticket_routing_rules r
       WHERE r.id = ticket_routing_rule_org_links.rule_id
         AND (
           public.breeze_current_scope() = 'system'
           OR (r.org_id IS NOT NULL AND public.breeze_has_org_access(r.org_id))
           OR (r.partner_id IS NOT NULL AND public.breeze_has_partner_access(r.partner_id))
         )
    )
  );

-- SELECT-only: a caller with access to the LINKED org reads that link, when
-- it can read the parent rule. The subquery runs under the caller's own RLS
-- on ticket_routing_rules, so it inherits the parent's three branches and
-- nothing more. This is the create path's allowlist read under an org-scope or
-- org-session context ("is my org listed?"); it never shows an org which
-- sibling orgs a rule names — org_scoped, not link presence, says whether a
-- list applies.
DROP POLICY IF EXISTS ticket_routing_rule_org_links_parent_visible_select ON ticket_routing_rule_org_links;
CREATE POLICY ticket_routing_rule_org_links_parent_visible_select ON ticket_routing_rule_org_links
  FOR SELECT USING (
    public.breeze_has_org_access(org_id)
    AND EXISTS (
      SELECT 1 FROM public.ticket_routing_rules r
       WHERE r.id = ticket_routing_rule_org_links.rule_id
    )
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON ticket_routing_rule_org_links TO breeze_app;
