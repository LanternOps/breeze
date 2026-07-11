CREATE TABLE IF NOT EXISTS ticket_mailbox_tenant_ownerships (
  tenant_id uuid PRIMARY KEY,
  partner_id uuid NOT NULL REFERENCES partners(id),
  verified_by uuid REFERENCES users(id),
  verified_microsoft_oid uuid NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ticket_mailbox_tenant_ownerships_tenant_partner_unique UNIQUE (tenant_id, partner_id)
);

ALTER TABLE ticket_mailbox_connections
  ADD COLUMN IF NOT EXISTS consent_attempt_id uuid;

DO $$
DECLARE affected bigint;
BEGIN
  UPDATE ticket_mailbox_connections
  SET consent_attempt_id = gen_random_uuid()
  WHERE consent_attempt_id IS NULL;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected > 0 THEN
    RAISE WARNING 'ticket mailbox hardening assigned state generations to % connection(s)', affected;
  END IF;
END $$;

ALTER TABLE ticket_mailbox_connections
  ALTER COLUMN consent_attempt_id SET DEFAULT gen_random_uuid(),
  ALTER COLUMN consent_attempt_id SET NOT NULL;

DROP INDEX IF EXISTS ticket_mailbox_connections_id_partner_attempt_idx;

CREATE TABLE IF NOT EXISTS ticket_mailbox_consent_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  state text NOT NULL UNIQUE,
  phase varchar(24) NOT NULL
    CONSTRAINT ticket_mailbox_consent_sessions_phase_check
    CHECK (phase IN ('admin_consent', 'identity_verification')),
  partner_id uuid NOT NULL REFERENCES partners(id),
  connection_id uuid NOT NULL,
  consent_attempt_id uuid NOT NULL,
  user_id uuid REFERENCES users(id),
  tenant_hint_hash text,
  nonce text,
  code_verifier text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ticket_mailbox_consent_sessions_connection_partner_fk
    FOREIGN KEY (connection_id, partner_id)
    REFERENCES ticket_mailbox_connections(id, partner_id) ON DELETE CASCADE
);

ALTER TABLE ticket_mailbox_consent_sessions
  ADD COLUMN IF NOT EXISTS consent_attempt_id uuid;

DO $$
DECLARE affected bigint;
BEGIN
  UPDATE ticket_mailbox_consent_sessions AS sessions
  SET consent_attempt_id = connections.consent_attempt_id
  FROM ticket_mailbox_connections AS connections
  WHERE sessions.connection_id = connections.id
    AND sessions.partner_id = connections.partner_id
    AND sessions.consent_attempt_id IS NULL;
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected > 0 THEN
    RAISE WARNING 'ticket mailbox hardening assigned state generations to % consent session(s)', affected;
  END IF;
END $$;

ALTER TABLE ticket_mailbox_consent_sessions
  ALTER COLUMN consent_attempt_id SET NOT NULL;

ALTER TABLE ticket_mailbox_consent_sessions
  DROP CONSTRAINT IF EXISTS ticket_mailbox_consent_sessions_connection_partner_fk;
ALTER TABLE ticket_mailbox_consent_sessions
  ADD CONSTRAINT ticket_mailbox_consent_sessions_connection_partner_fk
  FOREIGN KEY (connection_id, partner_id)
  REFERENCES ticket_mailbox_connections(id, partner_id)
  ON DELETE CASCADE;

DO $$
DECLARE affected bigint;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'ticket_mailbox_connections'
      AND column_name = 'tenant_id'
      AND data_type = 'text'
  ) THEN
    UPDATE ticket_mailbox_connections
    SET status = 'reauth_required', tenant_id = NULL, delta_link = NULL,
        last_error = NULL, updated_at = now()
    WHERE status <> 'disabled' OR tenant_id IS NOT NULL OR delta_link IS NOT NULL;
    GET DIAGNOSTICS affected = ROW_COUNT;
    RAISE WARNING 'ticket mailbox hardening marked % legacy connection(s) reauth_required and cleared tenant/cursor state', affected;

    ALTER TABLE ticket_mailbox_connections
      ALTER COLUMN tenant_id TYPE uuid USING tenant_id::uuid;
  END IF;
END $$;

ALTER TABLE ticket_mailbox_connections
  DROP CONSTRAINT IF EXISTS ticket_mailbox_connections_tenant_partner_fk;
ALTER TABLE ticket_mailbox_connections
  ADD CONSTRAINT ticket_mailbox_connections_tenant_partner_fk
  FOREIGN KEY (tenant_id, partner_id)
  REFERENCES ticket_mailbox_tenant_ownerships(tenant_id, partner_id);

ALTER TABLE ticket_mailbox_connections
  DROP CONSTRAINT IF EXISTS ticket_mailbox_connections_connected_requires_verified_tenant;
ALTER TABLE ticket_mailbox_connections
  ADD CONSTRAINT ticket_mailbox_connections_connected_requires_verified_tenant
  CHECK (status <> 'connected' OR tenant_id IS NOT NULL);

ALTER TABLE ticket_mailbox_tenant_ownerships ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_mailbox_tenant_ownerships FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_partner_isolation_select ON ticket_mailbox_tenant_ownerships;
DROP POLICY IF EXISTS breeze_partner_isolation_insert ON ticket_mailbox_tenant_ownerships;
DROP POLICY IF EXISTS breeze_partner_isolation_update ON ticket_mailbox_tenant_ownerships;
DROP POLICY IF EXISTS breeze_partner_isolation_delete ON ticket_mailbox_tenant_ownerships;
CREATE POLICY breeze_partner_isolation_select ON ticket_mailbox_tenant_ownerships
  FOR SELECT USING (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_insert ON ticket_mailbox_tenant_ownerships
  FOR INSERT WITH CHECK (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_update ON ticket_mailbox_tenant_ownerships
  FOR UPDATE USING (public.breeze_has_partner_access(partner_id))
  WITH CHECK (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_delete ON ticket_mailbox_tenant_ownerships
  FOR DELETE USING (public.breeze_has_partner_access(partner_id));

ALTER TABLE ticket_mailbox_consent_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_mailbox_consent_sessions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_partner_isolation_select ON ticket_mailbox_consent_sessions;
DROP POLICY IF EXISTS breeze_partner_isolation_insert ON ticket_mailbox_consent_sessions;
DROP POLICY IF EXISTS breeze_partner_isolation_update ON ticket_mailbox_consent_sessions;
DROP POLICY IF EXISTS breeze_partner_isolation_delete ON ticket_mailbox_consent_sessions;
CREATE POLICY breeze_partner_isolation_select ON ticket_mailbox_consent_sessions
  FOR SELECT USING (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_insert ON ticket_mailbox_consent_sessions
  FOR INSERT WITH CHECK (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_update ON ticket_mailbox_consent_sessions
  FOR UPDATE USING (public.breeze_has_partner_access(partner_id))
  WITH CHECK (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_delete ON ticket_mailbox_consent_sessions
  FOR DELETE USING (public.breeze_has_partner_access(partner_id));
