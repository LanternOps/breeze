-- Record the ORIGIN PRINCIPAL of an action intent as a durable fact.
--
-- Why this exists: `action_intents.source` ('chat' | 'mcp_api') has been used
-- as a proxy for "what kind of caller created this", but it is lossy and
-- indirect. AuthContext now carries an explicit principal kind (user_session,
-- client_user, api_key, oauth_grant, agent, helper, system) and `source`
-- cannot represent most of them.
--
-- It matters at RELEASE time. `requested_by_user_id` is written for EVERY
-- intent, including API-key-created ones where it holds the key's CREATOR, and
-- `requesting_api_key_id` is never written by any current code path. So the
-- actor columns cannot distinguish an autonomous caller from a human, and a
-- release-time check that reconstructs the kind is inspecting a derivation
-- rather than a record. Any gate meaning "a person did this" needs the fact
-- itself, recorded once, at creation, immutably.
--
-- Nullable + backfilled to a conservative value: existing rows predate the
-- discriminator and their true origin is unknowable. They are recorded as
-- 'unknown' rather than guessed as 'user_session' — a gate requiring a human
-- must FAIL on an unknown origin, not pass.

-- Added as NOT NULL DEFAULT in a SINGLE statement, deliberately.
--
-- The obvious alternative — add nullable, UPDATE every row, then SET NOT NULL —
-- rewrites the whole table and then rescans it under ACCESS EXCLUSIVE, all
-- inside the one transaction autoMigrate wraps each file in. PostgreSQL 11+
-- stores a non-volatile DEFAULT in the catalog instead of rewriting rows, so
-- this form is O(1) regardless of table size and existing rows read back as
-- 'unknown' without ever being touched. See the batched-backfill guidance in
-- CLAUDE.md for why the rewrite form is avoided on tables that can grow.
ALTER TABLE action_intents
  ADD COLUMN IF NOT EXISTS origin_principal_kind TEXT NOT NULL DEFAULT 'unknown';

ALTER TABLE action_intents
  ADD COLUMN IF NOT EXISTS origin_principal_id TEXT;

-- Report how many rows carry the unrecoverable origin. These can never satisfy
-- a human-required gate, so the count is operationally meaningful; it is a
-- read, not a write, so it costs nothing beyond the scan.
DO $$
DECLARE n INTEGER;
BEGIN
  SELECT count(*) INTO n FROM action_intents WHERE origin_principal_kind = 'unknown';
  IF n > 0 THEN
    RAISE WARNING 'action_intents: % row(s) carry origin_principal_kind=unknown (pre-discriminator)', n;
  END IF;
END $$;

ALTER TABLE action_intents DROP CONSTRAINT IF EXISTS action_intents_origin_principal_kind_chk;
ALTER TABLE action_intents ADD CONSTRAINT action_intents_origin_principal_kind_chk
  CHECK (origin_principal_kind IN (
    'user_session', 'client_user', 'api_key', 'oauth_grant',
    'agent', 'helper', 'system', 'unknown'
  ));

-- The origin is part of the intent's immutable content: an intent whose
-- recorded origin could be edited after approval would defeat the entire
-- point. Extend the existing immutability trigger rather than adding a second
-- one, so there is exactly one place that defines "immutable content".
CREATE OR REPLACE FUNCTION action_intents_block_content_update()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.requested_by_user_id IS DISTINCT FROM OLD.requested_by_user_id
     OR NEW.requesting_api_key_id IS DISTINCT FROM OLD.requesting_api_key_id
     OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.origin_principal_kind IS DISTINCT FROM OLD.origin_principal_kind
     OR NEW.origin_principal_id IS DISTINCT FROM OLD.origin_principal_id
     OR NEW.action_name IS DISTINCT FROM OLD.action_name
     OR NEW.action_version IS DISTINCT FROM OLD.action_version
     OR NEW.arguments IS DISTINCT FROM OLD.arguments
     OR NEW.argument_digest IS DISTINCT FROM OLD.argument_digest
     OR NEW.target_summary IS DISTINCT FROM OLD.target_summary
     OR NEW.impact_summary IS DISTINCT FROM OLD.impact_summary
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.risk_tier IS DISTINCT FROM OLD.risk_tier
     OR NEW.connection_id IS DISTINCT FROM OLD.connection_id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'action_intents content is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
