-- Fleet Designer W05 (#5655): `fleetDesignsDelivered` impact counter.
--
-- One more counter column on `ai_agent_impact_daily`, mirroring
-- `narratives_delivered` (2026-09-30-ai-agents-impact.sql): completed
-- `design`-profile runs that produced a Fleet Design report, by finished day.
-- The rollup (`impactRollup.ts`) computes it; the DTO (`impactQuery.ts`) sums
-- it; the Impact PDF lists it. DDL only — no rows are written here, so no
-- `breeze.scope` election is needed. Idempotent: re-applying is a no-op.

ALTER TABLE ai_agent_impact_daily
  ADD COLUMN IF NOT EXISTS fleet_designs_delivered integer NOT NULL DEFAULT 0;

ALTER TABLE ai_agent_impact_daily
  DROP CONSTRAINT IF EXISTS ai_agent_impact_daily_fleet_designs_chk;
ALTER TABLE ai_agent_impact_daily
  ADD CONSTRAINT ai_agent_impact_daily_fleet_designs_chk CHECK (fleet_designs_delivered >= 0);
