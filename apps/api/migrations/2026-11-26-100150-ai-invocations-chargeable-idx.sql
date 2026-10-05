-- @no-transaction
-- AI chargeback W10 (#7608): the monthly close scans an org's chargeable,
-- authoritative, not-yet-claimed rows by created_at. Partial, so it stays tiny
-- (zero rows until an MSP turns AI billing on). CONCURRENTLY so the build does
-- not take a SHARE lock on the ledger that settlement inserts into on every
-- AI turn (autoMigrate's @no-transaction lane, precedent 2026-05-17-a).
CREATE INDEX CONCURRENTLY IF NOT EXISTS ai_invocations_chargeable_idx
  ON public.ai_invocations (org_id, created_at)
  WHERE chargeable AND ledger_mode = 'authoritative';
