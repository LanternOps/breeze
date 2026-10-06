-- Diagnostic access grants: administrator-approved, READ-ONLY file listing and
-- reading on one device, including paths the default AI path restriction
-- refuses (e.g. C:\Users\<user>\AppData application logs).
--
-- Lifecycle: pending_approval -> active | denied | expired; active -> revoked |
-- expired. A request is created by the `request_diagnostic_access` tool (chat
-- or MCP) and fanned out as approval_requests rows (diagnostic_access_grant_id
-- link, same first-wins pattern as PAM elevations); an eligible administrator
-- decides it through the ordinary approvals surfaces. The grant only ever
-- authorizes the exact principal that requested it (see beneficiary_* below).
--
-- Tenancy Shape 1: direct org_id; policies key on breeze_has_org_access.
-- Stores scope and provenance only — never file contents or secrets.
--
-- Fully idempotent — safe to re-run.

DO $$ BEGIN
  CREATE TYPE diagnostic_access_grant_status AS ENUM (
    'pending_approval', 'active', 'denied', 'revoked', 'expired'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS diagnostic_access_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id),
  device_id UUID NOT NULL REFERENCES devices(id),

  status diagnostic_access_grant_status NOT NULL DEFAULT 'pending_approval',

  -- Requester and beneficiary. The grant only ever authorizes the exact
  -- principal that asked: a chat user session (beneficiary_kind 'user',
  -- beneficiary_id = the user), an MCP API key ('api_key', the key id) or an
  -- MCP OAuth grant ('oauth_grant', the grant id). requested_by_user_id is the
  -- human behind it (for an API key, the key's creator) and is shown to the
  -- approver.
  requested_by_user_id UUID NOT NULL REFERENCES users(id),
  beneficiary_kind VARCHAR(16) NOT NULL,
  beneficiary_id UUID NOT NULL,
  source VARCHAR(32) NOT NULL,
  requested_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  -- Pending requests lapse if nobody decides them.
  request_expires_at TIMESTAMP WITH TIME ZONE NOT NULL,

  -- What is being asked for. scopes: [{ "path": "<as requested>", "recursive": bool }].
  purpose TEXT NOT NULL,
  operations TEXT[] NOT NULL,
  scopes JSONB NOT NULL,
  sensitive_classes TEXT[] NOT NULL DEFAULT '{}',
  duration_minutes INTEGER NOT NULL,

  -- Decision.
  approved_by_user_id UUID REFERENCES users(id),
  approved_at TIMESTAMP WITH TIME ZONE,
  expires_at TIMESTAMP WITH TIME ZONE,
  denied_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  denied_at TIMESTAMP WITH TIME ZONE,
  denial_reason TEXT,
  decided_assurance_level SMALLINT,
  decided_via VARCHAR(32),

  revoked_at TIMESTAMP WITH TIME ZONE,
  revoked_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  revoke_reason TEXT,

  last_used_at TIMESTAMP WITH TIME ZONE,
  use_count INTEGER NOT NULL DEFAULT 0,

  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

ALTER TABLE diagnostic_access_grants DROP CONSTRAINT IF EXISTS diagnostic_access_grants_operations_chk;
ALTER TABLE diagnostic_access_grants ADD CONSTRAINT diagnostic_access_grants_operations_chk
  CHECK (
    cardinality(operations) BETWEEN 1 AND 2
    AND operations <@ ARRAY['list', 'read']::TEXT[]
  );

ALTER TABLE diagnostic_access_grants DROP CONSTRAINT IF EXISTS diagnostic_access_grants_classes_chk;
ALTER TABLE diagnostic_access_grants ADD CONSTRAINT diagnostic_access_grants_classes_chk
  CHECK (
    sensitive_classes <@ ARRAY['credential_store', 'browser_secrets', 'private_keys', 'session_tokens']::TEXT[]
  );

ALTER TABLE diagnostic_access_grants DROP CONSTRAINT IF EXISTS diagnostic_access_grants_scopes_chk;
ALTER TABLE diagnostic_access_grants ADD CONSTRAINT diagnostic_access_grants_scopes_chk
  CHECK (jsonb_typeof(scopes) = 'array' AND jsonb_array_length(scopes) BETWEEN 1 AND 20);

ALTER TABLE diagnostic_access_grants DROP CONSTRAINT IF EXISTS diagnostic_access_grants_beneficiary_chk;
ALTER TABLE diagnostic_access_grants ADD CONSTRAINT diagnostic_access_grants_beneficiary_chk
  CHECK (
    beneficiary_kind IN ('user', 'api_key', 'oauth_grant')
    AND (beneficiary_kind <> 'user' OR beneficiary_id = requested_by_user_id)
  );

ALTER TABLE diagnostic_access_grants DROP CONSTRAINT IF EXISTS diagnostic_access_grants_duration_chk;
ALTER TABLE diagnostic_access_grants ADD CONSTRAINT diagnostic_access_grants_duration_chk
  CHECK (duration_minutes BETWEEN 5 AND 1440);

-- An active/revoked/expired-after-approval grant carries a complete approval;
-- expires_at never exceeds the requested duration.
ALTER TABLE diagnostic_access_grants DROP CONSTRAINT IF EXISTS diagnostic_access_grants_approval_chk;
ALTER TABLE diagnostic_access_grants ADD CONSTRAINT diagnostic_access_grants_approval_chk
  CHECK (
    (approved_at IS NULL) = (approved_by_user_id IS NULL)
    AND (approved_at IS NULL) = (expires_at IS NULL)
    AND (approved_at IS NULL OR expires_at <= approved_at + make_interval(mins => duration_minutes))
    AND (status <> 'active' OR approved_at IS NOT NULL)
    AND (status <> 'denied' OR (denied_at IS NOT NULL AND approved_at IS NULL))
  );

ALTER TABLE diagnostic_access_grants DROP CONSTRAINT IF EXISTS diagnostic_access_grants_revoked_chk;
ALTER TABLE diagnostic_access_grants ADD CONSTRAINT diagnostic_access_grants_revoked_chk
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL));

-- The device must belong to the grant's organization. Deferred so the
-- device-move trigger can restamp org_id on both rows in one transaction.
DO $$ BEGIN
  ALTER TABLE diagnostic_access_grants
    ADD CONSTRAINT diagnostic_access_grants_device_org_fk
    FOREIGN KEY (device_id, org_id) REFERENCES devices(id, org_id)
    DEFERRABLE INITIALLY DEFERRED;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_diagnostic_access_grants_device_active
  ON diagnostic_access_grants (device_id, expires_at)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_diagnostic_access_grants_beneficiary
  ON diagnostic_access_grants (device_id, beneficiary_kind, beneficiary_id)
  WHERE status IN ('pending_approval', 'active');
CREATE INDEX IF NOT EXISTS idx_diagnostic_access_grants_org
  ON diagnostic_access_grants (org_id, created_at DESC);

ALTER TABLE diagnostic_access_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE diagnostic_access_grants FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON diagnostic_access_grants;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON diagnostic_access_grants;
DROP POLICY IF EXISTS breeze_org_isolation_update ON diagnostic_access_grants;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON diagnostic_access_grants;

CREATE POLICY breeze_org_isolation_select ON diagnostic_access_grants
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON diagnostic_access_grants
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON diagnostic_access_grants
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON diagnostic_access_grants
  FOR DELETE USING (public.breeze_has_org_access(org_id));

-- A grant speaks for the organization that approved it. Any change of its
-- org_id -- breeze_cascade_device_org_id() restamping it after a device moves,
-- an org merge repoint, or a direct repair -- kills it in the same statement:
-- an active grant becomes revoked, a pending request expired. The move route
-- and the merge executor do this first with a named actor; this trigger is the
-- backstop for every other writer.
CREATE OR REPLACE FUNCTION public.diagnostic_access_grants_fence_org_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  _prev_scope text;
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id THEN
    IF NEW.status = 'active' THEN
      NEW.status := 'revoked';
      NEW.revoked_at := COALESCE(NEW.revoked_at, NOW());
      NEW.revoke_reason := COALESCE(NEW.revoke_reason, 'organization changed');
    ELSIF NEW.status = 'pending_approval' THEN
      NEW.status := 'expired';
      -- Its approval cards cannot activate it any more; do not leave them
      -- pending. Cross-user update: elevate, then restore before RETURN.
      _prev_scope := current_setting('breeze.scope', true);
      PERFORM set_config('breeze.scope', 'system', true);
      UPDATE approval_requests
         SET status = 'expired'
       WHERE diagnostic_access_grant_id = NEW.id
         AND status = 'pending';
      PERFORM set_config('breeze.scope', COALESCE(_prev_scope, ''), true);
    END IF;
    NEW.updated_at := NOW();
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS diagnostic_access_grants_fence_org_change ON diagnostic_access_grants;
CREATE TRIGGER diagnostic_access_grants_fence_org_change
  BEFORE UPDATE OF org_id ON diagnostic_access_grants
  FOR EACH ROW EXECUTE FUNCTION public.diagnostic_access_grants_fence_org_change();

-- Approval fan-out link (same shape as elevation_request_id): one grant request
-- fans out to N approver rows; the first decision wins and the rest expire.
ALTER TABLE approval_requests
  ADD COLUMN IF NOT EXISTS diagnostic_access_grant_id UUID
    REFERENCES diagnostic_access_grants(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS approval_requests_diagnostic_access_grant_id_idx
  ON approval_requests (diagnostic_access_grant_id);

-- A deleted grant (device or tenant deletion) must not leave its pending
-- approval rows behind: ON DELETE SET NULL above would turn each into an
-- unlinked, still-approvable row that authorizes nothing. Expire them first;
-- decided rows keep their history with the link nulled. Elevated to the
-- system scope for the cross-user update (approval_requests is user-scoped
-- RLS) and restored before RETURN.
CREATE OR REPLACE FUNCTION public.diagnostic_access_grants_expire_pending_approvals()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  _prev_scope text := current_setting('breeze.scope', true);
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);
  UPDATE approval_requests
     SET status = 'expired'
   WHERE diagnostic_access_grant_id = OLD.id
     AND status = 'pending';
  PERFORM set_config('breeze.scope', COALESCE(_prev_scope, ''), true);
  RETURN OLD;
END $$;

DROP TRIGGER IF EXISTS diagnostic_access_grants_expire_pending_approvals ON diagnostic_access_grants;
CREATE TRIGGER diagnostic_access_grants_expire_pending_approvals
  BEFORE DELETE ON diagnostic_access_grants
  FOR EACH ROW EXECUTE FUNCTION public.diagnostic_access_grants_expire_pending_approvals();

ALTER TABLE approval_requests DROP CONSTRAINT IF EXISTS approval_requests_one_source_chk;
ALTER TABLE approval_requests ADD CONSTRAINT approval_requests_one_source_chk
  CHECK (
    (execution_id IS NOT NULL)::int
    + (elevation_request_id IS NOT NULL)::int
    + (intent_id IS NOT NULL)::int
    + (diagnostic_access_grant_id IS NOT NULL)::int <= 1
  );
