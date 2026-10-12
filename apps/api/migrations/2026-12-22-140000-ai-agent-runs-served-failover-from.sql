-- #7787: the failover SOURCE of an agent run that served on a backup.
--
-- An agent run admitted while its primary offering was cooling is admitted
-- straight onto the healthy fallback (resolveModel's cooldown walk). Admission
-- now stamps that provenance on the run's served_* columns, and the run loop
-- copies it onto the ledger row (ai_invocations.failover_from_offering_id /
-- failover_hop / failover_cause) exactly as chat does. served_* had no column
-- for the source offering, so the ledger's failover_from_offering_id could not
-- be reproduced; this adds it.
--
-- Provenance id, no FK (W02/W09 precedent: admitted_offering_id and
-- served_offering_id carry none). Nullable and independent of
-- ai_agent_runs_served_chk: NULL when the run never failed over, and NULL is
-- also what the ledger accepts when the source is unknown.
--
-- Existing table: its RLS policies are unchanged (no new table, no new
-- org-scoped shape).

ALTER TABLE public.ai_agent_runs ADD COLUMN IF NOT EXISTS served_failover_from_offering_id uuid;
