-- AI model registry W03 (#7601), Task 12:
--  * `blocked` terminal status: a run whose model is unavailable at dispatch
--    (spec §9.1) or that the model refused (§9.1a). The reason is error_code
--    model_unavailable | model_refused; the refusal category lives in `outcome`.
--  * funding_source: decided from the RESOLVED offering at admission
--    (quorum #4), so compute settlement never re-derives it per org. NULL only
--    on runs admitted before this migration (settled as 'platform', the
--    previous fail-safe). Export policy: `included`.
--  * admitted_offering_id (review finding 6): the offering admission resolved
--    and checked credits for. The run loop re-resolves THIS offering (the
--    bounded fallback keeps connection + funding), so a queued run can never
--    move funding after admission. Provenance id with no FK (like
--    ai_invocations.offering_id): resolveModel re-validates ownership, and an
--    FK to partner-axis partner_ai_models would tie org erasure to a partner
--    table. Export policy: `included`.
-- DDL only (no row writes). Idempotent: the CHECKs are dropped and re-added.
ALTER TABLE ai_agent_runs DROP CONSTRAINT IF EXISTS ai_agent_runs_status_chk;
ALTER TABLE ai_agent_runs ADD CONSTRAINT ai_agent_runs_status_chk CHECK (status IN (
  'queued', 'running', 'awaiting_approval', 'completed', 'failed', 'cancelled', 'expired', 'skipped', 'blocked'
));

ALTER TABLE ai_agent_runs ADD COLUMN IF NOT EXISTS funding_source text NULL;
ALTER TABLE ai_agent_runs ADD COLUMN IF NOT EXISTS admitted_offering_id uuid NULL;

ALTER TABLE ai_agent_runs DROP CONSTRAINT IF EXISTS ai_agent_runs_funding_source_chk;
ALTER TABLE ai_agent_runs ADD CONSTRAINT ai_agent_runs_funding_source_chk
  CHECK (funding_source IS NULL OR funding_source IN ('platform', 'partner_key'));
