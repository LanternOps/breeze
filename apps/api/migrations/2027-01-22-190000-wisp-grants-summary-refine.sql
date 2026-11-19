-- #10390: per-grant opt-in for the model-written session summary. Off by default:
-- the deterministic digest is the summary. When on, each session close makes one
-- model call, charged to the grant's daily budget through its ai_invocations
-- source_ref (services/wisp/budget.ts spentUnderGrant).
--
-- Spend, not authority, so it follows budget_cents_per_day: no revision pin, and
-- wisp_grants_update_guard needs no rule (it lists what a partner admin may NOT
-- change). No new index: the daily read filters ai_invocations by the grant's
-- partner's orgs and created_at, which ai_invocations_org_created_idx serves.
--
-- Writes no rows; elects system scope first anyway, per the migrations README.
SELECT set_config('breeze.scope', 'system', true);

ALTER TABLE wisp_grants ADD COLUMN IF NOT EXISTS summary_refine boolean NOT NULL DEFAULT false;
