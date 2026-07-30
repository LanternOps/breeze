-- M365 communications-delegated executor — schema prerequisites (design §4.1, §4.2, §5.2).
--
-- Task 4 of the communications-delegated executor. Nothing here is reachable at runtime
-- yet: no route writes these columns and no code reads the new table. It lands first so
-- the consent flow has somewhere to write when it arrives.
--
-- The delegated profile diverges from its certificate-based siblings in one way that
-- drives everything below: a delegated connection has NO credential until the user
-- finishes an interactive sign-in. The shipped constraints were written for profiles
-- where an admin consented up front and the credential existed before the row did.
--
-- Idempotent throughout; safe to re-apply.

-- ---------------------------------------------------------------------------
-- 1. Delegated columns on m365_connections
-- ---------------------------------------------------------------------------

-- The Entra object id (`oid`) of the human who consented, learned from the validated ID
-- token and pinned. §5.2's release-time binding check compares against this: connection id
-- alone is not enough, because reconnect reuses the same row.
ALTER TABLE m365_connections
  ADD COLUMN IF NOT EXISTS delegated_user_object_id UUID;

-- Bumped by every consent promotion. This is what actually detects "the mailbox was
-- reconnected — possibly as a different person — between approval and release". Existing
-- rows default to 0, which is correct: they have never been promoted through the delegated
-- path.
ALTER TABLE m365_connections
  ADD COLUMN IF NOT EXISTS consent_generation INTEGER NOT NULL DEFAULT 0;

-- The scopes Microsoft actually granted, from MSAL's AuthenticationResult.scopes — NOT
-- from parsing an access token, which is not ours to parse (§4.2). The app-only sibling
-- records app-role assignments in `observed_grants`; this is the delegated equivalent.
ALTER TABLE m365_connections
  ADD COLUMN IF NOT EXISTS observed_delegated_scopes JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE m365_connections
  DROP CONSTRAINT IF EXISTS m365_connections_observed_delegated_scopes_check;
ALTER TABLE m365_connections
  ADD CONSTRAINT m365_connections_observed_delegated_scopes_check
  CHECK (jsonb_typeof(observed_delegated_scopes) = 'array');

ALTER TABLE m365_connections
  DROP CONSTRAINT IF EXISTS m365_connections_consent_generation_check;
ALTER TABLE m365_connections
  ADD CONSTRAINT m365_connections_consent_generation_check
  CHECK (consent_generation >= 0);

-- ---------------------------------------------------------------------------
-- 2. Status-aware credential-location constraint (design §4.1)
-- ---------------------------------------------------------------------------
--
-- The shipped constraint demands non-null vault_ref AND credential_version for every
-- non-legacy profile. A delegated connection cannot satisfy that at insert time — there is
-- no credential until the OAuth callback returns — so the `pending-consent` row could not
-- exist, and the consent session had nothing to hang its composite FK from.
--
-- The relaxation is keyed on BOTH auth_mode = 'delegated' AND a non-terminal status, so it
-- cannot be used to park a certificate profile without a credential, and cannot leave a
-- delegated row credential-less once it reaches 'active'. Certificate profiles are
-- excluded a second time by m365_connections_profile_binding_check (foundation migration),
-- which confines auth_mode = 'delegated' to the communications-delegated profile.
--
-- Every existing row satisfies the first branch, so this is a no-op on live data. The
-- count is still reported: a row that needed the new branch would mean a delegated
-- connection already exists in a state the old constraint forbade, which is worth knowing
-- about rather than discovering later.
DO $$
DECLARE
  n BIGINT;
BEGIN
  SELECT count(*) INTO n
  FROM m365_connections
  WHERE profile <> 'legacy-direct'
    AND client_secret IS NULL
    AND (vault_ref IS NULL OR credential_version IS NULL);
  IF n > 0 THEN
    RAISE WARNING 'm365_connections: % row(s) rely on the relaxed credential-location branch', n;
  END IF;
END $$;

ALTER TABLE m365_connections DROP CONSTRAINT IF EXISTS m365_connections_credential_location_check;
ALTER TABLE m365_connections ADD CONSTRAINT m365_connections_credential_location_check CHECK (
  (profile = 'legacy-direct' AND client_secret IS NOT NULL AND vault_ref IS NULL)
  OR (profile <> 'legacy-direct' AND client_secret IS NULL AND (
        (vault_ref IS NOT NULL AND credential_version IS NOT NULL)
     OR (auth_mode = 'delegated'
         AND status IN ('pending-consent', 'verifying')
         AND vault_ref IS NULL AND credential_version IS NULL)
  ))
);

-- Lifecycle invariant (design §4.1): the constraint above proves a credential exists, but
-- not that we know WHOSE mailbox it opens. Without this, an application bug can produce an
-- active mailbox connection with no pinned identity, and §5.2's binding check would have
-- nothing to compare against — it would pass vacuously.
DO $$
DECLARE
  n BIGINT;
BEGIN
  SELECT count(*) INTO n
  FROM m365_connections
  WHERE status = 'active'
    AND profile = 'communications-delegated'
    AND (tenant_id IS NULL OR delegated_user_object_id IS NULL);
  IF n > 0 THEN
    RAISE WARNING 'm365_connections: % active communications row(s) lack a pinned identity', n;
  END IF;
END $$;

ALTER TABLE m365_connections DROP CONSTRAINT IF EXISTS m365_connections_delegated_identity_check;
ALTER TABLE m365_connections ADD CONSTRAINT m365_connections_delegated_identity_check CHECK (
  status <> 'active'
  OR profile <> 'communications-delegated'
  OR (tenant_id IS NOT NULL AND delegated_user_object_id IS NOT NULL)
);

-- ---------------------------------------------------------------------------
-- 3. User-axis composite unique index
-- ---------------------------------------------------------------------------
--
-- The org-axis equivalent (…_id_org_profile_attempt_uniq) is what the shipped consent
-- session's composite FK references. The user-axis table below needs its own, because a
-- delegated connection has org_id NULL and a composite FK cannot reference a NULL column
-- usefully — under MATCH SIMPLE a single NULL disables the whole constraint, which would
-- silently turn the FK into no constraint at all.
CREATE UNIQUE INDEX IF NOT EXISTS m365_connections_id_user_profile_attempt_uniq
  ON m365_connections (id, user_id, profile, consent_attempt_id);

-- ---------------------------------------------------------------------------
-- 4. m365_user_consent_sessions (design §4.2)
-- ---------------------------------------------------------------------------
--
-- A separate table rather than a nullable org_id on the shipped one. m365_consent_sessions
-- has org_id NOT NULL and a composite FK into the org-axis unique index, so it structurally
-- cannot hold a user-owned row. A unified table with per-axis composite FKs would also
-- work; this is the smaller change and it keeps the two axes' constraints independent.
--
-- No tenant_hint_hash column at all, and that absence is the point: a first delegated
-- sign-in happens at /common and Breeze learns `tid` only from the ID token that comes
-- back. There is nothing to hash before authorization.
CREATE TABLE IF NOT EXISTS m365_user_consent_sessions (
  id UUID CONSTRAINT m365_user_consent_sessions_pkey PRIMARY KEY DEFAULT gen_random_uuid(),
  state_hash CHAR(64) NOT NULL,
  phase VARCHAR(24) NOT NULL,
  connection_id UUID NOT NULL,
  user_id UUID NOT NULL,
  profile VARCHAR(64) NOT NULL,
  consent_attempt_id UUID NOT NULL,
  nonce TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE m365_user_consent_sessions
  DROP CONSTRAINT IF EXISTS m365_user_consent_sessions_user_id_fkey;
ALTER TABLE m365_user_consent_sessions
  ADD CONSTRAINT m365_user_consent_sessions_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

-- All four columns are NOT NULL, which matters: under MATCH SIMPLE a composite FK with any
-- NULL column is not enforced at all.
--
-- ⚠️ ON DELETE CASCADE does NOT cover UPDATE, and there is deliberately no ON UPDATE
-- CASCADE (matching the shipped org-axis FK). Rotating consent_attempt_id on the parent
-- therefore RAISES an FK violation rather than cascading — verified against a real
-- database, not assumed. The delegated consent flow (task 14) must delete this attempt's
-- session rows BEFORE rotating the attempt id, inside the same locked transaction, exactly
-- as the org-axis flow does (connectionService.ts:392-397 and :727-731 call
-- deleteConsentSessionsForAttemptInTransaction first). The blocking behaviour is the safer
-- default: it turns a missed cleanup into a loud failure instead of silently orphaning a
-- live code_verifier.
ALTER TABLE m365_user_consent_sessions
  DROP CONSTRAINT IF EXISTS m365_user_consent_sessions_connection_identity_fkey;
ALTER TABLE m365_user_consent_sessions
  ADD CONSTRAINT m365_user_consent_sessions_connection_identity_fkey
  FOREIGN KEY (connection_id, user_id, profile, consent_attempt_id)
  REFERENCES m365_connections (id, user_id, profile, consent_attempt_id)
  ON DELETE CASCADE;

ALTER TABLE m365_user_consent_sessions
  DROP CONSTRAINT IF EXISTS m365_user_consent_sessions_profile_check;
ALTER TABLE m365_user_consent_sessions
  ADD CONSTRAINT m365_user_consent_sessions_profile_check
  CHECK (profile = 'communications-delegated');

-- One phase, and it is not one of the shipped two. `identity_verification` requires a GUID
-- tenantHint that a first delegated sign-in does not have (design §4.2).
ALTER TABLE m365_user_consent_sessions
  DROP CONSTRAINT IF EXISTS m365_user_consent_sessions_phase_check;
ALTER TABLE m365_user_consent_sessions
  ADD CONSTRAINT m365_user_consent_sessions_phase_check
  CHECK (phase = 'delegated_consent');

DROP INDEX IF EXISTS m365_user_consent_sessions_state_hash_uniq;
CREATE UNIQUE INDEX m365_user_consent_sessions_state_hash_uniq
  ON m365_user_consent_sessions (state_hash);
CREATE INDEX IF NOT EXISTS m365_user_consent_sessions_expires_at_idx
  ON m365_user_consent_sessions (expires_at);
CREATE INDEX IF NOT EXISTS m365_user_consent_sessions_connection_attempt_idx
  ON m365_user_consent_sessions (connection_id, consent_attempt_id);

-- System-scoped, matching the shipped consent-session table. These rows hold a PKCE code
-- verifier and a nonce — live material for completing someone's sign-in — and no tenant
-- user has any reason to read them. Deliberately NOT user-axis readable: the owning user's
-- own session is still not something their session token should be able to select.
ALTER TABLE m365_user_consent_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE m365_user_consent_sessions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_m365_user_consent_session_select ON m365_user_consent_sessions;
DROP POLICY IF EXISTS breeze_m365_user_consent_session_insert ON m365_user_consent_sessions;
DROP POLICY IF EXISTS breeze_m365_user_consent_session_update ON m365_user_consent_sessions;
DROP POLICY IF EXISTS breeze_m365_user_consent_session_delete ON m365_user_consent_sessions;

CREATE POLICY breeze_m365_user_consent_session_select ON m365_user_consent_sessions
  FOR SELECT USING (public.breeze_current_scope() = 'system');
CREATE POLICY breeze_m365_user_consent_session_insert ON m365_user_consent_sessions
  FOR INSERT WITH CHECK (public.breeze_current_scope() = 'system');
CREATE POLICY breeze_m365_user_consent_session_update ON m365_user_consent_sessions
  FOR UPDATE USING (public.breeze_current_scope() = 'system')
  WITH CHECK (public.breeze_current_scope() = 'system');
CREATE POLICY breeze_m365_user_consent_session_delete ON m365_user_consent_sessions
  FOR DELETE USING (public.breeze_current_scope() = 'system');

-- ensureAppRole sets ALTER DEFAULT PRIVILEGES for breeze_app, so this is belt-and-braces —
-- but default privileges only apply to tables created by the role that set them, and this
-- is cheaper than discovering the mismatch as a permission-denied in production.
GRANT SELECT, INSERT, UPDATE, DELETE ON m365_user_consent_sessions TO breeze_app;
