CREATE TABLE IF NOT EXISTS ticket_mailbox_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES partners(id),
  tenant_id text,
  mailbox_address text NOT NULL,
  display_name text,
  status varchar(20) NOT NULL DEFAULT 'pending_consent',
  delta_link text,
  strict_sender_auth boolean NOT NULL DEFAULT false,
  last_polled_at timestamptz,
  last_message_at timestamptz,
  last_error text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ticket_mailbox_connections_partner_mailbox_idx
  ON ticket_mailbox_connections(partner_id, mailbox_address);
CREATE UNIQUE INDEX IF NOT EXISTS ticket_mailbox_connections_id_partner_idx
  ON ticket_mailbox_connections(id, partner_id);

ALTER TABLE ticket_mailbox_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_mailbox_connections FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_partner_isolation_select ON ticket_mailbox_connections;
DROP POLICY IF EXISTS breeze_partner_isolation_insert ON ticket_mailbox_connections;
DROP POLICY IF EXISTS breeze_partner_isolation_update ON ticket_mailbox_connections;
DROP POLICY IF EXISTS breeze_partner_isolation_delete ON ticket_mailbox_connections;
CREATE POLICY breeze_partner_isolation_select ON ticket_mailbox_connections
  FOR SELECT USING (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_insert ON ticket_mailbox_connections
  FOR INSERT WITH CHECK (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_update ON ticket_mailbox_connections
  FOR UPDATE USING (public.breeze_has_partner_access(partner_id))
  WITH CHECK (public.breeze_has_partner_access(partner_id));
CREATE POLICY breeze_partner_isolation_delete ON ticket_mailbox_connections
  FOR DELETE USING (public.breeze_has_partner_access(partner_id));
