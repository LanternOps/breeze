-- #9304: contracts auto-created from an accepted quote were stamped with
-- notes = 'Auto-created from accepted quote <quote number>'. Contract notes are
-- copied into the Notes block of every invoice the contract generates, so this
-- internal provenance line printed on customers' recurring invoices.
-- quoteToContract no longer writes it; this clears the rows it already wrote.
--
-- Exact match only: the whole value must be the system string with a single
-- whitespace-free token (a quote number, or the quote UUID fallback). Notes an
-- MSP edited — extra words on the line, extra lines, anything before it — are
-- left alone. Existing invoices (draft or issued) are not touched.
--
-- Idempotent: after one run no row matches, so a re-run updates nothing.
-- contracts carries no partner-export triggers, so no pre-locks are needed.

SELECT set_config('breeze.scope', 'system', true);

DO $$
DECLARE
  n integer;
BEGIN
  UPDATE contracts
     SET notes = NULL,
         updated_at = NOW()
   WHERE notes ~ '^Auto-created from accepted quote \S+$';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING 'cleared auto-created provenance notes on % contracts', n;
  END IF;
END $$;
