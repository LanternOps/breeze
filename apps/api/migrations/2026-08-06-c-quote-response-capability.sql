-- Wave 3: separate one-time quote response authority from public read access.
--
-- Existing links remain token version zero with no stored response JTI. The
-- first response claims and consumes its signed JTI transactionally. New
-- writers use version one and persist the response JTI when the quote is sent.
-- public_link_revoked_at is deliberately independent from response consumption.
--
-- Idempotent expansion only; autoMigrate supplies the outer transaction.

ALTER TABLE quotes
  ADD COLUMN IF NOT EXISTS public_token_version integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS public_response_jti varchar(128),
  ADD COLUMN IF NOT EXISTS public_response_consumed_at timestamptz,
  ADD COLUMN IF NOT EXISTS public_response_outcome varchar(16),
  ADD COLUMN IF NOT EXISTS public_link_revoked_at timestamptz;

ALTER TABLE quotes
  DROP CONSTRAINT IF EXISTS quotes_public_token_version_chk,
  ADD CONSTRAINT quotes_public_token_version_chk
    CHECK (public_token_version IN (0, 1));

ALTER TABLE quotes
  DROP CONSTRAINT IF EXISTS quotes_public_token_v1_jti_chk,
  ADD CONSTRAINT quotes_public_token_v1_jti_chk
    CHECK (public_token_version <> 1 OR public_response_jti IS NOT NULL);

ALTER TABLE quotes
  DROP CONSTRAINT IF EXISTS quotes_public_response_consumption_chk,
  ADD CONSTRAINT quotes_public_response_consumption_chk
    CHECK (
      (public_response_consumed_at IS NULL AND public_response_outcome IS NULL)
      OR
      (public_response_consumed_at IS NOT NULL AND public_response_outcome IS NOT NULL)
    );

ALTER TABLE quotes
  DROP CONSTRAINT IF EXISTS quotes_public_response_outcome_chk,
  ADD CONSTRAINT quotes_public_response_outcome_chk
    CHECK (
      public_response_outcome IS NULL
      OR public_response_outcome IN ('accepted', 'declined')
    );
