-- Quote acceptance on behalf of a customer (spec 2026-09-21 §6). A tech who
-- closed the deal on the phone, by email or on a signed PO records the
-- acceptance in-app; the existing acceptQuote pipeline converts the quote. The
-- four columns below are what makes that record honest — a dispute reviewer
-- must be able to tell an MSP-recorded acceptance from a customer click, and
-- find the evidence.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + DROP CONSTRAINT IF EXISTS / re-add.
-- No inner BEGIN/COMMIT — autoMigrate wraps this file in one transaction.
--
-- System scope FIRST, before the back-fill UPDATE below: breeze_current_scope()
-- defaults to 'none' and quote_acceptances is FORCE ROW LEVEL SECURITY, which
-- binds the table OWNER — the role migrations run as. Without this the UPDATE
-- matches ZERO rows silently and the RAISE WARNING prints a truthful-looking 0
-- (issue #4518). is_local = true scopes it to autoMigrate's transaction.
SELECT set_config('breeze.scope', 'system', true);

ALTER TABLE quote_acceptances
  ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'customer',
  ADD COLUMN IF NOT EXISTS method varchar(32),
  ADD COLUMN IF NOT EXISTS reference text,
  ADD COLUMN IF NOT EXISTS recorded_by_user_id uuid;

-- ON DELETE SET NULL, not RESTRICT: an org erasure deletes `users`, and a
-- restricting FK here would abort the cascade with 23503 — the exact latent
-- GDPR-erasure failure the cascade contract exists to prevent.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'quote_acceptances_recorded_by_user_id_fkey'
      AND conrelid = 'quote_acceptances'::regclass
  ) THEN
    ALTER TABLE quote_acceptances
      ADD CONSTRAINT quote_acceptances_recorded_by_user_id_fkey
      FOREIGN KEY (recorded_by_user_id) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Back-fill `method` on historical rows. TypedSignatureProvider is the only
-- acceptance provider that has ever run (services/acceptanceProvider.ts), so
-- every existing row was a typed signature. Row count is reported even when it
-- is 0: a silent 0 and an RLS-suppressed 0 look identical otherwise.
DO $$
DECLARE n integer;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);
  UPDATE quote_acceptances SET method = 'typed-signature' WHERE method IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE WARNING 'back-filled method=typed-signature on % quote_acceptances row(s)', n;
END $$;

-- Constraints added AFTER the back-fill so an existing database is already
-- conformant when they are validated.
ALTER TABLE quote_acceptances DROP CONSTRAINT IF EXISTS quote_acceptances_origin_chk;
ALTER TABLE quote_acceptances
  ADD CONSTRAINT quote_acceptances_origin_chk
  CHECK (origin IN ('customer', 'on_behalf'));

-- One-directional: an on-behalf row must carry the reference a reviewer would
-- look for ("PO 4471", "email from J. Doe 2026-09-20 14:02"). A customer row
-- simply has none.
ALTER TABLE quote_acceptances DROP CONSTRAINT IF EXISTS quote_acceptances_reference_chk;
ALTER TABLE quote_acceptances
  ADD CONSTRAINT quote_acceptances_reference_chk
  CHECK (origin = 'customer' OR reference IS NOT NULL);

-- Also one-directional, DELIBERATELY. The spec proposed the equality
--   (origin = 'customer') = (recorded_by_user_id IS NULL)
-- which is incompatible with ON DELETE SET NULL above: deleting the recording
-- tech would null the column on an on_behalf row and abort the delete with
-- 23514. This shape keeps the real invariant that matters — a CUSTOMER row can
-- never name a recorder — while letting an on-behalf row outlive its recorder.
ALTER TABLE quote_acceptances DROP CONSTRAINT IF EXISTS quote_acceptances_recorder_chk;
ALTER TABLE quote_acceptances
  ADD CONSTRAINT quote_acceptances_recorder_chk
  CHECK (origin = 'on_behalf' OR recorded_by_user_id IS NULL);

COMMENT ON COLUMN quote_acceptances.origin IS
  'customer = the customer accepted (portal or public link); on_behalf = an MSP tech recorded their acceptance (spec 2026-09-21).';
COMMENT ON COLUMN quote_acceptances.reference IS
  'Where a dispute reviewer would find the customer''s agreement. Required for origin = on_behalf.';
