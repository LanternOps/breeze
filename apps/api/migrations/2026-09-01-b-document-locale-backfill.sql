-- Multi-currency wave 5 follow-up (#3777 post-merge review, finding 1): legacy
-- legal documents were never snapshotted. 2026-08-31-a-document-locale.sql
-- added `document_locale` with NO backfill, so every invoice/quote issued
-- before that migration kept rendering with the partner's MUTABLE live
-- language — and an accepted quote's contract hash (computed under the
-- pre-#3777 English fallback) could disagree with what the customer saw.
--
-- ONE-TIME counted backfill, in this order:
--   1. quote_acceptances.render_locale — the locale the acceptance hash and the
--      executed contract PDF were actually computed with. For a legacy row that
--      is EXACTLY the quote's document_locale as it stood before step 3 ran
--      (stamped at send by #3777, or NULL → the 'en' fallback in force). Must
--      run BEFORE the quotes backfill so a legacy acceptance is never
--      re-attributed to the partner's current language.
--   2./3. invoices / quotes: non-draft rows with a NULL snapshot take the
--      owning partner's language setting, resolved exactly like
--      resolvePartnerDocumentLocale (supported list, else 'en'). Drafts stay
--      NULL and stamp at their own issue/send.
-- Idempotent: every UPDATE is gated on IS NULL, so a re-run is a counted no-op.

ALTER TABLE quote_acceptances ADD COLUMN IF NOT EXISTS render_locale varchar(16);

DO $$
DECLARE n integer;
BEGIN
  -- 1) Acceptance render locale (BEFORE the quotes backfill — see header).
  UPDATE quote_acceptances a
  SET render_locale = COALESCE(q.document_locale, 'en')
  FROM quotes q
  WHERE q.id = a.quote_id AND a.render_locale IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING 'document-locale: stamped render_locale on % legacy quote_acceptances', n; END IF;

  -- 2) Issued invoices.
  UPDATE invoices i
  SET document_locale = CASE
    WHEN p.settings->>'language' IN ('en','pt-BR','es-419','fr-FR','fr-CA','de-DE','it-IT','tr-TR')
      THEN p.settings->>'language'
    ELSE 'en'
  END
  FROM partners p
  WHERE p.id = i.partner_id AND i.document_locale IS NULL AND i.status <> 'draft';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING 'document-locale: backfilled document_locale on % non-draft invoices from partner language', n; END IF;

  -- 3) Sent (non-draft) quotes.
  UPDATE quotes q
  SET document_locale = CASE
    WHEN p.settings->>'language' IN ('en','pt-BR','es-419','fr-FR','fr-CA','de-DE','it-IT','tr-TR')
      THEN p.settings->>'language'
    ELSE 'en'
  END
  FROM partners p
  WHERE p.id = q.partner_id AND q.document_locale IS NULL AND q.status <> 'draft';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING 'document-locale: backfilled document_locale on % non-draft quotes from partner language', n; END IF;
END $$;
