-- Caller verification (anti-vishing) W01: evidence tables.
-- Spec: docs/superpowers/specs/security-auth/2026-09-18-caller-verification-design.md
-- Plan: docs/superpowers/plans/security-auth/2026-09-19-caller-verification-w01-backend-core.md
--
-- Three shape-1 (direct org_id) tenant tables. Every composite FK carrying
-- org_id is DEFERRABLE INITIALLY IMMEDIATE so org merge can re-point parent
-- and child org_id in separate statements. Reference columns on
-- caller_verifications use column-specific ON DELETE SET NULL so erasing a
-- binding or destination never nulls the ownership columns.
--
-- No device_id / ticket_id columns: workstation_device_ref, ticket_ref and
-- consumed_intent_ref are FK-less snapshots by design.

DO $$ BEGIN CREATE TYPE caller_verification_method AS ENUM
 ('workstation','sms','email','callback_attestation','administrative_stepup');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE caller_verification_status AS ENUM
 ('pending','verified','rejected_by_user','wrong_choice','expired','undeliverable','cancelled','revoked');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE caller_verification_action_scope AS ENUM ('reset_password','disable_user','any');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE caller_verification_binding_source AS ENUM ('directory_sync','technician_attested','observed_login');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE caller_verification_destination_kind AS ENUM ('email','mobile');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE caller_verification_destination_source AS ENUM
 ('technician','import','inbound_email','ai_tool','portal_self_service');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS caller_verification_subject_bindings (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 org_id uuid NOT NULL REFERENCES organizations(id),
 contact_id uuid NOT NULL,
 entra_tenant_id varchar(64),
 entra_oid varchar(64),
 upn_snapshot varchar(320),
 os_principal varchar(255),
 os_username varchar(255),
 source caller_verification_binding_source NOT NULL,
 established_at timestamptz NOT NULL DEFAULT now(),
 attested_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
 attested_at timestamptz,
 revoked_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT cv_bindings_contact_org_fk FOREIGN KEY(contact_id,org_id) REFERENCES contacts(id,org_id)
  ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
 CONSTRAINT cv_bindings_entra_pair_chk CHECK ((entra_tenant_id IS NULL) = (entra_oid IS NULL)),
 CONSTRAINT cv_bindings_identity_chk CHECK (entra_oid IS NOT NULL OR os_principal IS NOT NULL),
 CONSTRAINT cv_bindings_id_org_uq UNIQUE(id,org_id),
 CONSTRAINT cv_bindings_id_contact_org_uq UNIQUE(id,contact_id,org_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS cv_bindings_entra_active_uq
 ON caller_verification_subject_bindings(org_id,entra_tenant_id,entra_oid) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS cv_bindings_os_active_uq
 ON caller_verification_subject_bindings(org_id,os_principal) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS cv_bindings_contact_idx
 ON caller_verification_subject_bindings(org_id,contact_id);

CREATE TABLE IF NOT EXISTS caller_verification_destinations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 org_id uuid NOT NULL REFERENCES organizations(id),
 contact_id uuid NOT NULL,
 kind caller_verification_destination_kind NOT NULL,
 value_hash char(64) NOT NULL,
 value_redacted varchar(64) NOT NULL,
 set_at timestamptz NOT NULL DEFAULT now(),
 superseded_at timestamptz,
 set_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
 source caller_verification_destination_source NOT NULL,
 attested_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
 attested_at timestamptz,
 CONSTRAINT cv_destinations_contact_org_fk FOREIGN KEY(contact_id,org_id) REFERENCES contacts(id,org_id)
  ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
 CONSTRAINT cv_destinations_id_org_uq UNIQUE(id,org_id),
 CONSTRAINT cv_destinations_id_contact_org_uq UNIQUE(id,contact_id,org_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS cv_destinations_current_uq ON caller_verification_destinations(contact_id,kind)
 WHERE superseded_at IS NULL;

CREATE TABLE IF NOT EXISTS caller_verifications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 org_id uuid NOT NULL REFERENCES organizations(id),
 contact_id uuid NOT NULL,
 requester_binding_id uuid,
 target_binding_id uuid,
 target_entra_tenant_id varchar(64),
 target_entra_oid varchar(64),
 initiated_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 technician_label varchar(255) NOT NULL,
 action_scope caller_verification_action_scope NOT NULL,
 target_label varchar(320),
 method caller_verification_method NOT NULL,
 reason text,
 stepup_session_id text,
 stepup_auth_epoch integer,
 stepup_mfa_epoch integer,
 stepup_verified_at timestamptz,
 status caller_verification_status NOT NULL DEFAULT 'pending',
 tier smallint NOT NULL CONSTRAINT cv_tier_chk CHECK(tier BETWEEN 0 AND 3),
 tier_reason varchar(64) NOT NULL,
 match_value char(2) NOT NULL,
 decoy_values char(2)[] NOT NULL,
 reverse_code char(4) NOT NULL,
 challenge_token_hash char(64),
 destination_id uuid,
 destination_redacted varchar(64),
 workstation_device_ref uuid,
 device_hostname varchar(255),
 os_username varchar(255),
 os_principal_observed varchar(255),
 agent_command_id uuid REFERENCES device_commands(id) ON DELETE SET NULL,
 ticket_ref uuid,
 ticket_number varchar(32),
 attempt_no smallint NOT NULL CONSTRAINT cv_attempt_chk CHECK(attempt_no > 0),
 expires_at timestamptz NOT NULL,
 decided_at timestamptz,
 decided_from_ip inet,
 consumed_intent_ref uuid,
 consumed_at timestamptz,
 attestation_note text,
 fence_override_until timestamptz,
 delivery_published_at timestamptz,
 rejection_notified_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT cv_contact_org_fk FOREIGN KEY(contact_id,org_id) REFERENCES contacts(id,org_id)
  ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
 CONSTRAINT cv_requester_fk FOREIGN KEY(requester_binding_id,contact_id,org_id)
  REFERENCES caller_verification_subject_bindings(id,contact_id,org_id)
  ON DELETE SET NULL (requester_binding_id) DEFERRABLE INITIALLY IMMEDIATE,
 CONSTRAINT cv_target_fk FOREIGN KEY(target_binding_id,org_id) REFERENCES caller_verification_subject_bindings(id,org_id)
  ON DELETE SET NULL (target_binding_id) DEFERRABLE INITIALLY IMMEDIATE,
 CONSTRAINT cv_destination_fk FOREIGN KEY(destination_id,contact_id,org_id)
  REFERENCES caller_verification_destinations(id,contact_id,org_id)
  ON DELETE SET NULL (destination_id) DEFERRABLE INITIALLY IMMEDIATE,
 CONSTRAINT cv_id_org_uq UNIQUE(id,org_id),
 CONSTRAINT cv_id_contact_org_uq UNIQUE(id,contact_id,org_id),
 CONSTRAINT cv_choices_chk CHECK (match_value ~ '^[0-9]{2}$' AND cardinality(decoy_values)=2 AND array_position(decoy_values,NULL) IS NULL
  AND decoy_values[1] ~ '^[0-9]{2}$' AND decoy_values[2] ~ '^[0-9]{2}$'
  AND match_value <> ALL(decoy_values) AND decoy_values[1] <> decoy_values[2] AND reverse_code ~ '^[0-9]{4}$'),
 CONSTRAINT cv_admin_chk CHECK(method <> 'administrative_stepup' OR
  (action_scope='disable_user' AND reason IS NOT NULL AND length(btrim(reason)) >= 20 AND stepup_session_id IS NOT NULL
   AND stepup_auth_epoch IS NOT NULL AND stepup_mfa_epoch IS NOT NULL AND stepup_verified_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS cv_contact_history_idx ON caller_verifications(org_id,contact_id,created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS cv_token_uq ON caller_verifications(challenge_token_hash) WHERE challenge_token_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS cv_command_uq ON caller_verifications(agent_command_id) WHERE agent_command_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS cv_gate_idx ON caller_verifications(contact_id,status,consumed_at)
 WHERE status='verified' AND consumed_at IS NULL;
CREATE INDEX IF NOT EXISTS cv_target_idx ON caller_verifications(org_id,target_binding_id,created_at DESC);
CREATE INDEX IF NOT EXISTS cv_requester_binding_idx ON caller_verifications(requester_binding_id) WHERE requester_binding_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS cv_destination_idx ON caller_verifications(destination_id) WHERE destination_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS cv_initiated_by_idx ON caller_verifications(initiated_by_user_id);

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['caller_verification_subject_bindings','caller_verification_destinations','caller_verifications'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('DROP POLICY IF EXISTS breeze_org_isolation ON %I',t);
  EXECUTE format('CREATE POLICY breeze_org_isolation ON %I FOR ALL USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id))',t);
 END LOOP;
END $$;
