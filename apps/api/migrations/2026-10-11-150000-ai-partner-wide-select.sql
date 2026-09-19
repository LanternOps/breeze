-- Partner-wide READ branch on the AI config tables (#4942, #4943, #4945).
--
-- Follow-up group of epic #4673. Design, rationale and scope behaviour are all
-- inherited verbatim from the template this file copies:
-- 2026-10-05-110000-config-policy-partner-wide-select.sql — read its header
-- before changing anything here.
--
-- SHORT VERSION
-- A partner-wide row on these tables is `org_id NULL, partner_id = P`. An
-- ORG-scoped session could not see it: `breeze_has_org_access(NULL)` is false,
-- and `breeze_has_partner_access(P)` is false because org scope carries an empty
-- `accessible_partner_ids` (that GUC governs partner-axis WRITES; an org token
-- never holds it). Readers therefore escalated through the #1105 pattern,
-- `runOutsideDbContext(() => withSystemDbAccessContext(...))`, which acquires a
-- SECOND pooled connection while the request's own transaction still holds the
-- first (a hang at concurrency >= pool size, not just contention) and bypasses
-- RLS entirely, so every escalated query has to self-tenant or it becomes a
-- cross-tenant hole (#2417 shipped exactly that class in an adjacent path).
--
-- The fix is a SELECT-only own-partner branch keyed on
-- `public.breeze_current_partner_id()` — the caller's OWN partner, read from the
-- `breeze.current_partner_id` GUC that `buildDbAccessContext` populates for
-- EVERY scope including org tokens. No extra connection, no RLS bypass, and
-- writes are untouched.
--
-- WHY A SEPARATE POLICY PER TABLE, NEVER AN EDIT TO THE EXISTING ONE
-- Each table below already carries a dual-axis policy: a single `FOR ALL`
-- `ai_agents_isolation` / `ai_agent_schedules_isolation`, and the per-command
-- `breeze_dual_axis_*` split on client_ai_prompt_templates. Appending
-- `OR (org_id IS NULL AND partner_id = ...)` to a FOR ALL `USING` would ALSO
-- widen UPDATE/DELETE row targeting to partner-wide rows — an org admin could
-- then delete their MSP's shared agent or prompt template. Postgres never
-- consults FOR SELECT policies when computing UPDATE/DELETE target rows, so a
-- separate permissive FOR SELECT policy ORs into reads and nothing else. The
-- existing policies are left byte-identical; this file only CREATEs new names.
--
-- All three tables carry `org_id` and `partner_id` directly on the row with an
-- XOR CHECK (ai_agents_one_owner_chk, ai_agent_schedules_one_owner_chk,
-- client_ai_prompt_templates_scope_check), so all three take the direct-column
-- form — no EXISTS-join to a parent is needed.
--
-- SCOPE BEHAVIOUR
--   org scope     — GUC set to the token's own partner: branch fires for that
--                   partner's partner-wide rows only.
--   partner scope — already covered by `breeze_has_partner_access`; the branch
--                   is redundant but harmless (permissive policies OR).
--   system scope  — already short-circuited by every existing policy.
--   agent scope   — WIDENED, deliberately. `middleware/agentAuth.ts` sets
--                   `currentPartnerId: device.partnerId` (#4673 W02, agentAuth.ts
--                   :959), so a device token's `breeze_current_partner_id()` is
--                   its org's owning MSP and this branch DOES fire for it. A
--                   device can therefore now SELECT its own partner's
--                   partner-wide `ai_agents` (including `instructions`,
--                   `tool_allowlist`, `recipients`), `ai_agent_schedules` and
--                   `client_ai_prompt_templates` rows. This is the same widening
--                   every other Wave-1 branch already took (config-policy chain,
--                   catalog, cis_baselines, tenant_variables) and the same one
--                   the sibling follow-ups #4998–#5000 accepted. It is SELECT
--                   only: `accessiblePartnerIds` stays `[]` on the agent path, so
--                   `breeze_has_partner_access` is still false and no agent
--                   UPDATE/DELETE can target a partner-wide row. Verified by
--                   grep at authoring time: NO route under `routes/agents/`,
--                   `routes/agentWs.ts`, `routes/helper/`, `src/extensions/` or
--                   `ee/` reads any of these three tables today, so nothing
--                   currently ships those columns to a device — the widening is
--                   latent read reach, not a new response payload.
--                   A FOREIGN partner's rows stay invisible: the predicate uses
--                   `=`, not `IS NOT DISTINCT FROM`, so a NULL GUC (any caller
--                   that sets none) never matches partner-wide rows either.
--
-- Idempotent: DROP POLICY IF EXISTS then CREATE, so re-applying is a no-op.
-- No inner BEGIN/COMMIT — autoMigrate wraps each file in a transaction.
-- Writes no rows, so it needs no `breeze.scope` elevation (#4518).
--
-- Rollback: a new migration issuing the three matching
-- `DROP POLICY IF EXISTS <table>_partner_wide_select` statements. The policies
-- are purely additive, so dropping them restores exact pre-migration behaviour.

-- #4942
DROP POLICY IF EXISTS ai_agents_partner_wide_select ON public.ai_agents;
CREATE POLICY ai_agents_partner_wide_select
  ON public.ai_agents
  FOR SELECT
  USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id());

-- #4943
DROP POLICY IF EXISTS ai_agent_schedules_partner_wide_select ON public.ai_agent_schedules;
CREATE POLICY ai_agent_schedules_partner_wide_select
  ON public.ai_agent_schedules
  FOR SELECT
  USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id());

-- #4945
DROP POLICY IF EXISTS client_ai_prompt_templates_partner_wide_select ON public.client_ai_prompt_templates;
CREATE POLICY client_ai_prompt_templates_partner_wide_select
  ON public.client_ai_prompt_templates
  FOR SELECT
  USING (org_id IS NULL AND partner_id = public.breeze_current_partner_id());
