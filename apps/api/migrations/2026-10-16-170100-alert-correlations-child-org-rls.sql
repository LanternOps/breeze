-- 2026-10-16: alert_correlations RLS must check BOTH endpoints' org, not just
-- the parent's (#5607, surfaced during review of #5540 / SEC-049).
--
-- Root cause: 2026-05-30-fk-child-tables-rls.sql installed the canonical
-- parent-FK join shape on alert_correlations, joining `alerts` on
-- parent_alert_id only:
--
--   EXISTS (SELECT 1 FROM alerts al
--            WHERE al.id = alert_correlations.parent_alert_id
--              AND public.breeze_has_org_access(al.org_id))
--
-- alert_correlations has TWO not-null FKs to `alerts` (parent_alert_id and
-- child_alert_id), so the single-parent shape is a half predicate: a row whose
-- parent belongs to org A and whose child belongs to org B is readable — and
-- insertable — under an org-A token. The child alert's id, correlation type,
-- confidence and metadata leak across the tenant boundary.
--
-- Nothing is known to write such a row today: the correlation worker only ever
-- links alerts it fetched for one org, and #5540 added
-- filterCorrelationsToVisibleAlerts at the app layer on every legacy route.
-- Both of those are app-layer mitigations, and CLAUDE.md's tenancy invariant is
-- explicit that there is no app-layer-only fallback — the database must enforce
-- it. This migration closes the DB-side half.
--
-- Fix: AND the same EXISTS on child_alert_id in every slot Postgres evaluates
-- (SELECT/DELETE: USING; INSERT: WITH CHECK; UPDATE: both). The system-scope
-- arm is unchanged and needs no extra branch: breeze_has_org_access
-- short-circuits TRUE under withSystemDbAccessContext, so both conjuncts pass
-- for background writers exactly as they did before.
--
-- Safety (why this cannot break an existing write): every edge the product
-- creates has both endpoints in the same org, so wherever the old parent-only
-- predicate passed, the new child conjunct passes too. The only rows this
-- newly excludes are cross-org edges, which are precisely the bug. Both FK
-- columns are NOT NULL (apps/api/src/db/schema/alerts.ts), so neither conjunct
-- can go NULL and fail-open/fail-closed on three-valued logic.
--
-- Never edit a shipped migration: 2026-05-30-fk-child-tables-rls.sql is
-- content-hash immutable, so this replaces its four alert_correlations
-- policies forward.
--
-- Idempotent: DROP POLICY IF EXISTS before each CREATE; ENABLE/FORCE are
-- no-ops when already set. Re-running converges to the same state.
-- autoMigrate wraps each migration file in a transaction — no inner
-- BEGIN/COMMIT.

ALTER TABLE alert_correlations ENABLE ROW LEVEL SECURITY;
ALTER TABLE alert_correlations FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON alert_correlations;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON alert_correlations;
DROP POLICY IF EXISTS breeze_org_isolation_update ON alert_correlations;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON alert_correlations;

CREATE POLICY breeze_org_isolation_select ON alert_correlations FOR SELECT USING (
  EXISTS (SELECT 1 FROM alerts parent_al WHERE parent_al.id = alert_correlations.parent_alert_id AND public.breeze_has_org_access(parent_al.org_id))
  AND EXISTS (SELECT 1 FROM alerts child_al WHERE child_al.id = alert_correlations.child_alert_id AND public.breeze_has_org_access(child_al.org_id))
);

CREATE POLICY breeze_org_isolation_insert ON alert_correlations FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM alerts parent_al WHERE parent_al.id = alert_correlations.parent_alert_id AND public.breeze_has_org_access(parent_al.org_id))
  AND EXISTS (SELECT 1 FROM alerts child_al WHERE child_al.id = alert_correlations.child_alert_id AND public.breeze_has_org_access(child_al.org_id))
);

CREATE POLICY breeze_org_isolation_update ON alert_correlations FOR UPDATE USING (
  EXISTS (SELECT 1 FROM alerts parent_al WHERE parent_al.id = alert_correlations.parent_alert_id AND public.breeze_has_org_access(parent_al.org_id))
  AND EXISTS (SELECT 1 FROM alerts child_al WHERE child_al.id = alert_correlations.child_alert_id AND public.breeze_has_org_access(child_al.org_id))
) WITH CHECK (
  EXISTS (SELECT 1 FROM alerts parent_al WHERE parent_al.id = alert_correlations.parent_alert_id AND public.breeze_has_org_access(parent_al.org_id))
  AND EXISTS (SELECT 1 FROM alerts child_al WHERE child_al.id = alert_correlations.child_alert_id AND public.breeze_has_org_access(child_al.org_id))
);

CREATE POLICY breeze_org_isolation_delete ON alert_correlations FOR DELETE USING (
  EXISTS (SELECT 1 FROM alerts parent_al WHERE parent_al.id = alert_correlations.parent_alert_id AND public.breeze_has_org_access(parent_al.org_id))
  AND EXISTS (SELECT 1 FROM alerts child_al WHERE child_al.id = alert_correlations.child_alert_id AND public.breeze_has_org_access(child_al.org_id))
);
