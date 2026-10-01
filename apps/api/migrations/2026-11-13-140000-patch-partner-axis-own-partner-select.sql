-- 2026-11-13-140000-patch-partner-axis-own-partner-select.sql
-- Issue #7647. Sorts after the newest committed migration
-- (2026-11-13-100100-ai-platform-models-seed.sql).
--
-- patch_policies (update rings) and patch_approvals are PARTNER-AXIS tables
-- (RLS shape 3, 2026-06-27-a/-b): every command is gated by
-- breeze_has_partner_access(partner_id). An ORGANIZATION-scope context carries
-- accessible_partner_ids = [], so it reads ZERO rows of its own MSP's rings and
-- approvals. The device Patches tab (GET /devices/:id/patches) needs both to
-- compute the ring-aware approval verdict, so it escaped to a system context —
-- runOutsideDbContext + withSystemDbAccessContext — which checks out a SECOND
-- pooled connection while the request transaction still holds the first: the
-- hold-and-wait shape behind the 09-22 pool deadlock.
--
-- Fix: an ADDITIVE, SELECT-only permissive policy on each table:
--   partner_id = public.breeze_current_partner_id()
-- breeze_current_partner_id() reads the breeze.current_partner_id GUC = the
-- caller's OWN partner (set by every auth path that has one; NULL for the
-- portal and system contexts). Same read-only own-partner idea as
-- 2026-06-13-catalog-partner-read-branch.sql. These tables have no org_id —
-- every row is partner-wide config (a ring, or a partner-wide / ring-scoped
-- manual approval) that already governs the org's devices — so there is no
-- `org_id IS NULL` qualifier to add: an org session sees its own MSP's rows,
-- never another partner's.
--
-- Writes are NOT widened. Postgres applies a FOR SELECT policy only to reads
-- (and to the read half of UPDATE/DELETE row targeting, which additionally
-- requires the command's own USING policy). The existing
-- breeze_partner_isolation_{insert,update,delete} policies are untouched, so
-- an org session still cannot insert, update, or delete a ring or approval.
--
-- Idempotent: DROP POLICY IF EXISTS then CREATE. Writes no rows, so no
-- breeze.scope election is needed. No inner BEGIN/COMMIT.

DROP POLICY IF EXISTS breeze_own_partner_select ON public.patch_policies;
CREATE POLICY breeze_own_partner_select ON public.patch_policies
  FOR SELECT
  USING (partner_id = public.breeze_current_partner_id());

DROP POLICY IF EXISTS breeze_own_partner_select ON public.patch_approvals;
CREATE POLICY breeze_own_partner_select ON public.patch_approvals
  FOR SELECT
  USING (partner_id = public.breeze_current_partner_id());
