-- Endpoint live chat (#8743, W03 of #8740; refs #8292).
--
-- endpoint_conversations          shape 5: device-scoped, denormalized org_id,
--                                 direct breeze_has_org_access(org_id) policy.
--                                 One technician-opened chat with the person at
--                                 one device. org_id NOT NULL (Partner-Wide
--                                 First N/A): a conversation always belongs to
--                                 exactly one device in exactly one org, and is
--                                 operational history, not config.
-- endpoint_conversation_messages  shape 5: same. Hot agent-write table (end-user
--                                 replies arrive on the agent route).
--
-- Tenant consistency: RLS proves only that the caller may write the stated
-- org_id. The composite FKs below prove the referenced device and conversation
-- belong to that same org.
--
-- FK timing: all composite tenant FKs are DEFERRABLE INITIALLY DEFERRED, like
-- endpoint_message_receipts / device_group_memberships: on a device org move
-- breeze_cascade_device_org_id() restamps both tables in separate statements in
-- catalog order, so the (conversation_id, org_id) pair is consistent only at
-- COMMIT. A forged row still fails, at COMMIT. DEFERRABLE also lets org merge
-- (SET CONSTRAINTS ALL DEFERRED) repoint parent and child separately.
--
-- Device move: history follows the device (both tables have device_id + org_id,
-- so breeze_device_child_orgid_tables() discovers them); moveDeviceOrgInTransaction
-- closes any opening/open conversation first (close_reason 'device_moved'), so a
-- destination-org technician never inherits a live chat.
--
-- No ticket binding (plan N3): there is deliberately no ticket_id column.
-- Not append-only at the DB level: retention nulls bodies and deletes old rows.
--
-- Writes no rows. Idempotent. No inner BEGIN/COMMIT.

CREATE TABLE IF NOT EXISTS public.endpoint_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  device_id uuid NOT NULL,
  channel text NOT NULL DEFAULT 'endpoint_helper',
  status text NOT NULL,
  allow_user_reply boolean NOT NULL,
  opened_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  open_command_id uuid,
  target_username text,
  win_session_id integer,
  error_code text,
  close_reason text,
  closed_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE public.endpoint_conversations
    ADD CONSTRAINT endpoint_conversations_id_org_id_key UNIQUE (id, org_id);
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;

ALTER TABLE public.endpoint_conversations DROP CONSTRAINT IF EXISTS endpoint_conversations_status_chk;
ALTER TABLE public.endpoint_conversations
  ADD CONSTRAINT endpoint_conversations_status_chk
  CHECK (status IN ('opening', 'open', 'closed', 'expired', 'failed'));

ALTER TABLE public.endpoint_conversations DROP CONSTRAINT IF EXISTS endpoint_conversations_channel_chk;
ALTER TABLE public.endpoint_conversations
  ADD CONSTRAINT endpoint_conversations_channel_chk CHECK (channel IN ('endpoint_helper'));

ALTER TABLE public.endpoint_conversations DROP CONSTRAINT IF EXISTS endpoint_conversations_close_reason_chk;
ALTER TABLE public.endpoint_conversations
  ADD CONSTRAINT endpoint_conversations_close_reason_chk
  CHECK (close_reason IS NULL OR close_reason IN ('technician', 'idle', 'device_moved', 'agent'));

ALTER TABLE public.endpoint_conversations DROP CONSTRAINT IF EXISTS endpoint_conversations_device_org_fk;
ALTER TABLE public.endpoint_conversations
  ADD CONSTRAINT endpoint_conversations_device_org_fk
  FOREIGN KEY (device_id, org_id)
  REFERENCES public.devices (id, org_id)
  ON DELETE CASCADE
  DEFERRABLE INITIALLY DEFERRED;

-- One live chat per device: a second open is refused instead of stacking
-- windows on the user's screen.
CREATE UNIQUE INDEX IF NOT EXISTS endpoint_conversations_device_active_uq
  ON public.endpoint_conversations (device_id) WHERE status IN ('opening', 'open');
CREATE INDEX IF NOT EXISTS endpoint_conversations_device_created_idx
  ON public.endpoint_conversations (device_id, created_at);
CREATE INDEX IF NOT EXISTS endpoint_conversations_org_created_idx
  ON public.endpoint_conversations (org_id, created_at);
CREATE INDEX IF NOT EXISTS endpoint_conversations_live_activity_idx
  ON public.endpoint_conversations (last_activity_at) WHERE status IN ('opening', 'open');
CREATE INDEX IF NOT EXISTS endpoint_conversations_open_command_idx
  ON public.endpoint_conversations (open_command_id);

CREATE TABLE IF NOT EXISTS public.endpoint_conversation_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL,
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  device_id uuid NOT NULL,
  direction text NOT NULL,
  body text,
  body_length integer NOT NULL,
  body_purged_at timestamptz,
  -- to_user: the technician client's message id; from_user: the helper's
  -- per-reply nonce. Unique per conversation: a retry never duplicates and
  -- two identical replies never collapse.
  client_nonce uuid NOT NULL,
  sender_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  -- from_user only: the agent-attested OS session (username, sid, winSessionId).
  sender_session jsonb,
  command_id uuid,
  error_code text,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.endpoint_conversation_messages DROP CONSTRAINT IF EXISTS endpoint_conversation_messages_direction_chk;
ALTER TABLE public.endpoint_conversation_messages
  ADD CONSTRAINT endpoint_conversation_messages_direction_chk CHECK (direction IN ('to_user', 'from_user'));

ALTER TABLE public.endpoint_conversation_messages DROP CONSTRAINT IF EXISTS endpoint_conversation_messages_purge_chk;
ALTER TABLE public.endpoint_conversation_messages
  ADD CONSTRAINT endpoint_conversation_messages_purge_chk
  CHECK (body IS NOT NULL OR body_purged_at IS NOT NULL);

-- A technician message never carries an OS session; a user reply never
-- carries a technician.
ALTER TABLE public.endpoint_conversation_messages DROP CONSTRAINT IF EXISTS endpoint_conversation_messages_sender_chk;
ALTER TABLE public.endpoint_conversation_messages
  ADD CONSTRAINT endpoint_conversation_messages_sender_chk
  CHECK (
    (direction = 'to_user' AND sender_session IS NULL)
    OR (direction = 'from_user' AND sender_user_id IS NULL)
  );

ALTER TABLE public.endpoint_conversation_messages DROP CONSTRAINT IF EXISTS endpoint_conversation_messages_conversation_org_fk;
ALTER TABLE public.endpoint_conversation_messages
  ADD CONSTRAINT endpoint_conversation_messages_conversation_org_fk
  FOREIGN KEY (conversation_id, org_id)
  REFERENCES public.endpoint_conversations (id, org_id)
  ON DELETE CASCADE
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE public.endpoint_conversation_messages DROP CONSTRAINT IF EXISTS endpoint_conversation_messages_device_org_fk;
ALTER TABLE public.endpoint_conversation_messages
  ADD CONSTRAINT endpoint_conversation_messages_device_org_fk
  FOREIGN KEY (device_id, org_id)
  REFERENCES public.devices (id, org_id)
  ON DELETE CASCADE
  DEFERRABLE INITIALLY DEFERRED;

CREATE UNIQUE INDEX IF NOT EXISTS endpoint_conversation_messages_nonce_uq
  ON public.endpoint_conversation_messages (conversation_id, client_nonce);
CREATE INDEX IF NOT EXISTS endpoint_conversation_messages_conversation_created_idx
  ON public.endpoint_conversation_messages (conversation_id, created_at);
CREATE INDEX IF NOT EXISTS endpoint_conversation_messages_device_created_idx
  ON public.endpoint_conversation_messages (device_id, created_at);
CREATE INDEX IF NOT EXISTS endpoint_conversation_messages_org_created_idx
  ON public.endpoint_conversation_messages (org_id, created_at);
CREATE INDEX IF NOT EXISTS endpoint_conversation_messages_command_idx
  ON public.endpoint_conversation_messages (command_id);
CREATE INDEX IF NOT EXISTS endpoint_conversation_messages_created_unpurged_idx
  ON public.endpoint_conversation_messages (created_at) WHERE body_purged_at IS NULL;

-- RLS: enabled + forced + four policies per table, in this same migration.
ALTER TABLE public.endpoint_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.endpoint_conversations FORCE ROW LEVEL SECURITY;
ALTER TABLE public.endpoint_conversation_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.endpoint_conversation_messages FORCE ROW LEVEL SECURITY;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['endpoint_conversations', 'endpoint_conversation_messages'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS breeze_org_isolation_select ON public.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS breeze_org_isolation_insert ON public.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS breeze_org_isolation_update ON public.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS breeze_org_isolation_delete ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY breeze_org_isolation_select ON public.%I FOR SELECT USING (public.breeze_has_org_access(org_id))', t);
    EXECUTE format(
      'CREATE POLICY breeze_org_isolation_insert ON public.%I FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id))', t);
    EXECUTE format(
      'CREATE POLICY breeze_org_isolation_update ON public.%I FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id))', t);
    EXECUTE format(
      'CREATE POLICY breeze_org_isolation_delete ON public.%I FOR DELETE USING (public.breeze_has_org_access(org_id))', t);
  END LOOP;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'breeze_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.endpoint_conversations TO breeze_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.endpoint_conversation_messages TO breeze_app;
  END IF;
END $$;
