-- #3597 — the 'Enable email-to-ticket' switch becomes an ENFORCED gate.
--
-- Until now `settings.ticketing.inbound.enabled` was display-only: the settings card
-- persisted and re-rendered it, but nothing in the ingestion pipeline read it, so mail
-- was ticketed regardless. Two consequences for existing data:
--
--   1. The card read the flag back as `enabled: false` when absent, and it replaces the
--      whole `ticketing.inbound` sub-object on EVERY save. So any partner who ever
--      touched an unrelated inbound setting (triage org, autoresponder, unknown-sender
--      mode) had `enabled: false` written for them — while their mail kept flowing.
--   2. A stored `false` therefore is NOT evidence that the partner wanted the feature
--      off. Observed inbound mail IS evidence that they rely on it.
--
-- So: repair an explicit `false` to `true` for partners who have actually received
-- inbound mail. Partners with no `enabled` key are untouched — the runtime default is
-- permissive (see PartnerInboundPolicy.enabled), which preserves today's behavior.
-- Partners with an explicit `false` and no observed mail are also untouched: nothing
-- breaks for them, and if the false was deliberate we honor it.
--
-- Anyone who genuinely wants inbound off can now switch it off and have it take effect.
--
-- A blanket "set every existing partner to true" was considered and rejected: with the
-- runtime default already permissive, the only rows that matter are the explicit
-- `false`s, and a regression requires mail to actually be flowing. The observed-mail
-- condition therefore covers every partner who can regress while leaving a deliberate
-- `false` on a partner with no inbound mail alone.
--
-- Re-run note: this is a one-shot repair, not a converger. It is safely idempotent
-- immediately after release (no row matches `= 'false'` once repaired), but it is NOT
-- safe to replay months later — by then a partner may have deliberately switched the
-- feature off AND have `ticket_email_inbound` rows, and a replay would re-enable them.
-- `breeze_migrations` keys on filename and applies each file once, which is the
-- guarantee being relied on here. Do not copy this file forward under a new name.

DO $$
DECLARE
  repaired integer;
BEGIN
  WITH updated AS (
    UPDATE partners p
       SET settings = jsonb_set(
             COALESCE(p.settings, '{}'::jsonb),
             '{ticketing,inbound,enabled}',
             'true'::jsonb,
             true
           )
     WHERE p.settings -> 'ticketing' -> 'inbound' -> 'enabled' = 'false'::jsonb
       AND EXISTS (
             SELECT 1 FROM ticket_email_inbound t WHERE t.partner_id = p.id
           )
    RETURNING 1
  )
  SELECT count(*) INTO repaired FROM updated;

  IF repaired > 0 THEN
    RAISE WARNING 'backfilled ticketing.inbound.enabled=true for % partner(s) with observed inbound mail (#3597)', repaired;
  END IF;
END $$;
