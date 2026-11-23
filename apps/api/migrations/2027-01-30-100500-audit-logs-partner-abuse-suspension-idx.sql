-- @no-transaction
-- audit_logs: partial index for the partner-trust hard-deny check (#11560).
--
-- loadSuspendedAbuseSet (apps/api/src/services/partnerTrustPromotion.ts) finds
-- every suspended partner's newest `partner.suspended_for_abuse` row. The only
-- index it can use today, (resource_type, resource_id, timestamp DESC), returns
-- every audit row about that partner (~250 each on a busy one) and filters
-- `action` row by row. The set is built by the partner-trust-promote job (at
-- most once a minute) and once per single-partner evaluation (the ip-classify
-- job, the abuse sweep).
--
-- The action is rare (one row per abuse suspension), so the index is a few
-- tens of kB. Local measurement, 300 suspended partners with 250 audit rows
-- each in a 1.6M-row table: the set build went from ~17.9k to ~2.4k shared
-- buffers. texteq and uuid comparisons are leakproof, so these stay index
-- conditions under the RLS security qual as breeze_app (checked locally).
--
-- CREATE INDEX CONCURRENTLY: every agent request inserts into audit_logs.
-- IF NOT EXISTS keeps re-application a no-op (prod may get it by hand first).
-- An interrupted CONCURRENTLY build leaves an INVALID index that IF NOT EXISTS
-- would silently accept, so the DO block fails loudly in that state.
-- Recovery: DROP INDEX CONCURRENTLY audit_logs_partner_abuse_suspension_idx,
-- then let autoMigrate re-run this file.

CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_logs_partner_abuse_suspension_idx
  ON public.audit_logs (resource_id, "timestamp" DESC)
  WHERE resource_type = 'partner' AND action = 'partner.suspended_for_abuse';

DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(c.relname, ', ')
    INTO bad
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
   WHERE i.indrelid = 'public.audit_logs'::regclass
     AND c.relname = 'audit_logs_partner_abuse_suspension_idx'
     AND NOT i.indisvalid;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'audit_logs partner abuse-suspension index build left INVALID index: % — DROP INDEX CONCURRENTLY it and re-apply this migration', bad;
  END IF;
END $$;
