-- #9347: contract notes become internal-only.
--
-- Until now generateDueInvoice printed BOTH contract free-text fields on every
-- invoice it generated: [notes, terms], empty values dropped, joined by a blank
-- line. From this release it prints only `terms` (the "Invoice note"), so
-- `notes` can hold internal remarks that never reach a customer.
--
-- To keep every invoice printing exactly what it printed before, this copies
-- each non-empty `notes` onto the front of `terms`, in the same order and with
-- the same separator the generator used:
--   terms empty  -> terms = notes
--   otherwise    -> terms = notes || E'\n\n' || terms
-- `notes` is left as it is; it stays as the internal copy. Invoices that
-- already exist (draft or issued) are not touched.
--
-- Idempotent: the done-marker is the comment this file sets on
-- contracts.notes. When the comment already matches, the copy is skipped, so a
-- re-run updates 0 rows. A text-prefix guard cannot be exact here: a contract
-- whose terms already started with its notes would be skipped on the first run
-- and its invoice would lose text.
-- contracts carries no partner-export triggers, so no pre-locks are needed.

SELECT set_config('breeze.scope', 'system', true);

DO $$
DECLARE
  marker constant text :=
    'Internal-only contract notes (#9347): never printed on invoices. '
    'The text generated invoices print is contracts.terms (Invoice note).';
  n integer;
BEGIN
  IF col_description('public.contracts'::regclass,
       (SELECT attnum FROM pg_attribute
         WHERE attrelid = 'public.contracts'::regclass AND attname = 'notes'))
     IS NOT DISTINCT FROM marker THEN
    RETURN;
  END IF;

  UPDATE contracts
     SET terms = CASE
                   WHEN terms IS NULL OR terms = '' THEN notes
                   ELSE notes || E'\n\n' || terms
                 END,
         updated_at = NOW()
   WHERE notes IS NOT NULL
     AND notes <> '';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING 'copied contract notes into the invoice note on % contracts', n;
  END IF;

  EXECUTE format('COMMENT ON COLUMN public.contracts.notes IS %L', marker);
END $$;
