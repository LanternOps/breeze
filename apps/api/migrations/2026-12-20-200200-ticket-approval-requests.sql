-- #4617 spec §4.3 / §4.5: ticket_approval_requests (Shape 1, direct org_id)
-- and work_types.is_after_hours.
--
-- The columns on the hot tables (tickets budget, time_entries link,
-- ticket_parts hold guard) are in 2026-12-20-200300, which runs outside a
-- transaction so their constraints can be validated without holding an
-- ACCESS EXCLUSIVE lock across a scan.
--
-- No row is written by this file; the scope election is defensive.
SELECT set_config('breeze.scope', 'system', true);

-- §4.5: partner-axis label attribute (work_types has no org_id). A constant
-- default is catalog-only on PG11+, so no rewrite.
ALTER TABLE work_types ADD COLUMN IF NOT EXISTS is_after_hours boolean NOT NULL DEFAULT false;

-- §4.3
CREATE TABLE IF NOT EXISTS ticket_approval_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  ticket_id uuid NOT NULL,
  trigger text NOT NULL CHECK (trigger IN ('budget', 'after_hours')),
  origin text NOT NULL CHECK (origin IN ('auto', 'staff')),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'denied', 'expired', 'cancelled')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  enforcement text NOT NULL CHECK (enforcement IN ('soft', 'hard')),
  requested_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  message text,
  budget_minutes_at_request integer,
  consumed_minutes_at_request integer,
  budget_amount_at_request numeric(12,2),
  consumed_amount_at_request numeric(12,2),
  currency_code char(3),
  requested_extension_minutes integer
    CHECK (requested_extension_minutes IS NULL OR requested_extension_minutes > 0),
  requested_extension_amount numeric(12,2)
    CHECK (requested_extension_amount IS NULL OR requested_extension_amount > 0),
  coverage_starts_at timestamptz,
  coverage_ends_at timestamptz,
  -- Snapshot of the work type whose is_after_hours flag raised the request.
  -- Deliberately no FK: later edits or deletes of the label never rewrite it.
  after_hours_work_type_id uuid,
  approver_emails text[] NOT NULL DEFAULT '{}',
  notify_emails text[] NOT NULL DEFAULT '{}',
  decided_at timestamptz,
  decision_origin text CHECK (decision_origin IN ('customer', 'on_behalf')),
  decided_by_portal_user_id uuid REFERENCES portal_users(id) ON DELETE SET NULL,
  decided_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  signer_name text,
  signer_email text,
  decision_method text CHECK (decision_method IN ('verbal', 'email', 'signed_document', 'other')),
  decision_reference text,
  decision_note text,
  decided_revision integer,
  approved_extension_minutes integer,
  approved_extension_amount numeric(12,2),
  ip_address text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Target of time_entries_approval_request_fk (2026-12-20-200300).
  CONSTRAINT ticket_approval_requests_id_ticket_uq UNIQUE (id, ticket_id),
  CONSTRAINT ticket_approval_requests_coverage_chk CHECK (
    (coverage_starts_at IS NULL) = (coverage_ends_at IS NULL)
    AND (coverage_ends_at IS NULL OR (
      coverage_ends_at > coverage_starts_at
      AND coverage_ends_at - coverage_starts_at <= interval '14 days'))),
  -- decided_by_user_id / decided_by_portal_user_id are deliberately NOT
  -- required: ON DELETE SET NULL may null them later. The service always sets
  -- them; signer_name / signer_email are the durable identity.
  CONSTRAINT ticket_approval_requests_decision_shape_chk CHECK (
    status NOT IN ('approved', 'denied') OR (
      decided_at IS NOT NULL AND decision_origin IS NOT NULL AND decided_revision IS NOT NULL
      AND (decision_origin <> 'on_behalf' OR (
        decision_method IS NOT NULL AND decision_reference IS NOT NULL
        AND length(btrim(decision_reference)) > 0))
      AND (decision_origin <> 'customer' OR signer_email IS NOT NULL)))
);

-- Composite tenancy FK. DEFERRABLE INITIALLY IMMEDIATE: org merge runs SET
-- CONSTRAINTS ALL DEFERRED, and both org movers name it in their SET
-- CONSTRAINTS ... DEFERRED statements (ticketService.moveTicketOrg,
-- deviceOrgMove/moveDeviceOrgInTransaction.ts).
ALTER TABLE ticket_approval_requests DROP CONSTRAINT IF EXISTS ticket_approval_requests_ticket_org_fk;
ALTER TABLE ticket_approval_requests ADD CONSTRAINT ticket_approval_requests_ticket_org_fk
  FOREIGN KEY (ticket_id, org_id) REFERENCES tickets(id, org_id)
  ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;

-- At most one open request per trigger per ticket.
CREATE UNIQUE INDEX IF NOT EXISTS ticket_approval_requests_one_pending_uq
  ON ticket_approval_requests (ticket_id, trigger) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS ticket_approval_requests_sweep_idx
  ON ticket_approval_requests (status, expires_at);
CREATE INDEX IF NOT EXISTS ticket_approval_requests_org_status_idx
  ON ticket_approval_requests (org_id, status);

-- A decided (terminal) row is immutable except org_id (org move / merge),
-- updated_at, and the three *_user_id columns going to NULL (FK SET NULL).
-- Rows stay deletable, so tenant erasure needs no AUDIT_ADMIN_REQUIRED_TABLES
-- entry.
CREATE OR REPLACE FUNCTION ticket_approval_requests_decided_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  exempt text[] := ARRAY['org_id', 'updated_at', 'requested_by_user_id',
                         'decided_by_user_id', 'decided_by_portal_user_id'];
BEGIN
  IF OLD.status IN ('approved', 'denied', 'expired', 'cancelled') THEN
    IF (to_jsonb(NEW) - exempt) IS DISTINCT FROM (to_jsonb(OLD) - exempt)
       OR (NEW.requested_by_user_id IS NOT NULL
           AND NEW.requested_by_user_id IS DISTINCT FROM OLD.requested_by_user_id)
       OR (NEW.decided_by_user_id IS NOT NULL
           AND NEW.decided_by_user_id IS DISTINCT FROM OLD.decided_by_user_id)
       OR (NEW.decided_by_portal_user_id IS NOT NULL
           AND NEW.decided_by_portal_user_id IS DISTINCT FROM OLD.decided_by_portal_user_id) THEN
      RAISE EXCEPTION 'decided approval request is immutable' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS ticket_approval_requests_decided_immutable ON ticket_approval_requests;
CREATE TRIGGER ticket_approval_requests_decided_immutable
  BEFORE UPDATE ON ticket_approval_requests
  FOR EACH ROW EXECUTE FUNCTION ticket_approval_requests_decided_immutable();

-- Shape 1 RLS, per-command (same text as 2026-12-04-101300-ticket-external-refs.sql).
ALTER TABLE ticket_approval_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_approval_requests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS breeze_org_isolation_select ON ticket_approval_requests;
CREATE POLICY breeze_org_isolation_select ON ticket_approval_requests
  FOR SELECT USING (public.breeze_has_org_access(org_id));
DROP POLICY IF EXISTS breeze_org_isolation_insert ON ticket_approval_requests;
CREATE POLICY breeze_org_isolation_insert ON ticket_approval_requests
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
DROP POLICY IF EXISTS breeze_org_isolation_update ON ticket_approval_requests;
CREATE POLICY breeze_org_isolation_update ON ticket_approval_requests
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
DROP POLICY IF EXISTS breeze_org_isolation_delete ON ticket_approval_requests;
CREATE POLICY breeze_org_isolation_delete ON ticket_approval_requests
  FOR DELETE USING (public.breeze_has_org_access(org_id));
GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON ticket_approval_requests TO breeze_app;
