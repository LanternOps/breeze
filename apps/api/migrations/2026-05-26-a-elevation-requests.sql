-- PAM Track 1: elevation_requests + elevation_audit
-- Direction approved by Todd in Discussion #858 — "cut the migration."
--
-- Two flows on a single table, distinguished by `flow_type`:
--   * uac_intercept      — end-user UAC prompt captured by the agent, requests
--                          temporary admin via Breeze policy
--   * tech_jit_admin     — technician-initiated just-in-time admin grant
--                          against a device they're managing
--
-- Tenancy Shape 1: direct `org_id` column with denormalized `site_id` /
-- `partner_id` lookup columns (mirroring devices.ts and incidents). Policies
-- key on `breeze_has_org_access(org_id)`.
--
-- Lifecycle timestamps are first-class columns (requested_at, approved_at,
-- expired_at, revoked_at) instead of derived from a status-history JSONB
-- (Todd's addition). Makes the alerts/audit queries trivial and keeps the
-- elevation_audit table additive, not authoritative.
--
-- FKs that intentionally use ON DELETE SET NULL:
--   * parent_approval_id → approval_requests(id) — an MCP step-up approval
--     can be the trigger for a uac_intercept elevation. Reaper deletes old
--     approvals; the elevation row remains for audit.
--   * software_policy_match_id → software_policies(id) — records which
--     allowlist rule auto-approved a uac_intercept. Policies get deleted
--     during reorg; the historical match shouldn't disappear.
--   * revoked_by_user_id → users(id) — user-soft-delete sets the FK to
--     NULL but keeps the audit trail intact.
--
-- Fully idempotent — safe to re-run.

-- ============================================================
-- Enums
-- ============================================================
DO $$ BEGIN
  CREATE TYPE elevation_flow_type AS ENUM (
    'uac_intercept',
    'tech_jit_admin'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Distinct from approval_status — adds auto_approved (allowlist hit, no
-- human in the loop) and revoked (explicitly cancelled before expiry).
DO $$ BEGIN
  CREATE TYPE elevation_status AS ENUM (
    'pending',
    'approved',
    'auto_approved',
    'denied',
    'expired',
    'revoked'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- elevation_audit.event_type. Each transition (or evidence event) on a
-- request gets one immutable row; the request's lifecycle timestamps are
-- the rollup, the audit table is the append-only history.
DO $$ BEGIN
  CREATE TYPE elevation_audit_event_type AS ENUM (
    'requested',
    'auto_approved',
    'approved',
    'denied',
    'expired',
    'revoked',
    'session_started',
    'session_ended',
    'command_executed',
    'evidence_attached'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE elevation_audit_actor AS ENUM (
    'end_user',
    'technician',
    'system',
    'policy'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ============================================================
-- Tables
-- ============================================================
CREATE TABLE IF NOT EXISTS elevation_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Tenancy: direct org_id (Shape 1). site_id / partner_id are
  -- denormalized lookup columns for ops/queries — they MUST be kept
  -- consistent with the device's site/org's partner at insert time
  -- (application-layer; same pattern as devices).
  org_id UUID NOT NULL REFERENCES organizations(id),
  site_id UUID REFERENCES sites(id),
  partner_id UUID REFERENCES partners(id),

  -- The device the elevation runs on. Always required — both flows
  -- target a specific endpoint.
  device_id UUID NOT NULL REFERENCES devices(id),

  -- Flow discriminator. Determines which subset of columns is required;
  -- enforced by the elevation_requests_flow_shape_chk constraint below.
  flow_type elevation_flow_type NOT NULL,

  -- Who is the elevation FOR.
  --   uac_intercept:  the end-user that hit the UAC prompt
  --                   (subject_username is the OS account; subject_user_id
  --                   may be NULL because end-users aren't always Breeze users)
  --   tech_jit_admin: the technician requesting the JIT grant
  --                   (subject_user_id MUST be set; subject_username is the
  --                   target OS account they want temporary admin AS)
  subject_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  subject_username VARCHAR(255) NOT NULL,

  -- The reason / action being requested. Free-text from the agent
  -- (uac_intercept: "Install Adobe Acrobat") or technician
  -- (tech_jit_admin: "Reinstall driver per ticket #1234").
  reason TEXT NOT NULL,

  -- What we know about the executable the UAC prompt was for.
  -- NULL on tech_jit_admin (no specific binary is being elevated).
  -- Populated on uac_intercept by the agent.
  target_executable_path TEXT,
  target_executable_hash VARCHAR(64),  -- sha256, lowercase hex; CHECK below
  target_executable_signer VARCHAR(255),
  target_publisher VARCHAR(255),

  status elevation_status NOT NULL DEFAULT 'pending',

  -- Lifecycle (Todd addition — first-class columns, not derived from a JSONB).
  -- requested_at = row creation, always set.
  -- approved_at  = transitioned out of pending (manual or auto). NULL if
  --                denied/expired without approval.
  -- expires_at   = when the grant stops being valid (forward-looking
  --                deadline, set on approval).
  -- expired_at   = when the reaper actually transitioned status=expired
  --                (NULL until that happens, distinct from expires_at).
  -- revoked_at / revoked_by_user_id = explicit cancellation.
  requested_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  approved_at TIMESTAMP WITH TIME ZONE,
  expires_at TIMESTAMP WITH TIME ZONE,
  expired_at TIMESTAMP WITH TIME ZONE,
  revoked_at TIMESTAMP WITH TIME ZONE,
  revoked_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  revoked_reason TEXT,

  -- The human / system that approved or denied. NULL on
  -- auto_approved (no human in the loop) and on pending.
  approved_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  denied_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  denial_reason TEXT,

  -- Cross-references (per spec).
  --
  -- parent_approval_id: when this elevation was kicked off by an MCP
  -- step-up approval row (the approvals.ts Shape-6 table). ON DELETE
  -- SET NULL because the approval reaper purges old rows but the
  -- elevation must remain for audit.
  parent_approval_id UUID REFERENCES approval_requests(id) ON DELETE SET NULL,

  -- software_policy_match_id: when the request matched an
  -- allowlist rule that auto-approved it. Lets the UI link
  -- "auto_approved by policy: <name>" back to the policy detail page.
  -- ON DELETE SET NULL so deleting a policy doesn't lose the audit.
  software_policy_match_id UUID REFERENCES software_policies(id) ON DELETE SET NULL,

  -- Session info, populated by the agent once the elevation is in use.
  -- Nullable because not every approved request is exercised before
  -- it expires.
  session_started_at TIMESTAMP WITH TIME ZONE,
  session_ended_at TIMESTAMP WITH TIME ZONE,
  client_ip inet,
  user_agent TEXT,

  -- Free-form structured metadata. Avoid putting policy-decision data
  -- here that we want to query on — promote to columns instead.
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS elevation_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Denormalized org_id so the RLS policy is a Shape-1 direct check
  -- (no JOIN through elevation_requests). Same denormalization
  -- pattern as incident_evidence / incident_actions.
  org_id UUID NOT NULL REFERENCES organizations(id),

  -- The elevation_requests row this event belongs to.
  -- ON DELETE CASCADE: if the parent is purged for any reason, the
  -- audit trail goes with it (the data has no meaning standalone).
  -- We don't expect parent rows to ever actually be deleted, but the
  -- FK shape matches incident_evidence → incidents.
  elevation_request_id UUID NOT NULL REFERENCES elevation_requests(id) ON DELETE CASCADE,

  event_type elevation_audit_event_type NOT NULL,
  actor elevation_audit_actor NOT NULL,
  -- The user that performed the action, if any. NULL for system /
  -- policy actors. ON DELETE SET NULL so user soft-delete doesn't
  -- break the trail.
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,

  -- Structured event payload (e.g. for command_executed: the command,
  -- exit code, duration; for approved: the approver's reason).
  details JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- When the event happened on the originating system (agent clock for
  -- agent events, server clock for server events). created_at is when
  -- the row hit the DB. They diverge under clock skew or backfill.
  occurred_at TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- ============================================================
-- Constraints
-- ============================================================
-- sha256, lowercase hex, exactly 64 chars (or NULL). Same shape as
-- incident_evidence_hash_sha256_chk.
ALTER TABLE elevation_requests
  DROP CONSTRAINT IF EXISTS elevation_requests_target_hash_sha256_chk;
ALTER TABLE elevation_requests
  ADD CONSTRAINT elevation_requests_target_hash_sha256_chk
  CHECK (target_executable_hash IS NULL OR target_executable_hash ~ '^[0-9a-f]{64}$');

-- Flow shape: enforce required columns by flow_type.
--   tech_jit_admin always has a Breeze-user subject (subject_user_id NOT NULL)
--                  and an explicit expires_at on approval (validated app-side
--                  to avoid blocking inserts in 'pending' state).
--   uac_intercept  may have a NULL subject_user_id (OS-account-only users)
--                  but must have a target_executable_path.
ALTER TABLE elevation_requests
  DROP CONSTRAINT IF EXISTS elevation_requests_flow_shape_chk;
ALTER TABLE elevation_requests
  ADD CONSTRAINT elevation_requests_flow_shape_chk
  CHECK (
    (flow_type = 'tech_jit_admin' AND subject_user_id IS NOT NULL)
    OR
    (flow_type = 'uac_intercept' AND target_executable_path IS NOT NULL)
  );

-- Terminal-state coherence: approved/auto_approved require approved_at;
-- denied requires denial reason fields; revoked requires revoked_at.
-- expired requires expired_at. (status=pending leaves all NULL.)
ALTER TABLE elevation_requests
  DROP CONSTRAINT IF EXISTS elevation_requests_status_timestamps_chk;
ALTER TABLE elevation_requests
  ADD CONSTRAINT elevation_requests_status_timestamps_chk
  CHECK (
    (status = 'pending')
    OR (status IN ('approved', 'auto_approved') AND approved_at IS NOT NULL)
    OR (status = 'denied' AND denied_by_user_id IS NOT NULL)
    OR (status = 'expired' AND expired_at IS NOT NULL)
    OR (status = 'revoked' AND revoked_at IS NOT NULL)
  );

-- ============================================================
-- Indexes
-- ============================================================
-- Per spec: lookups by device, by org, by status, by created_at desc.
CREATE INDEX IF NOT EXISTS elevation_requests_device_id_idx
  ON elevation_requests(device_id);
CREATE INDEX IF NOT EXISTS elevation_requests_org_id_idx
  ON elevation_requests(org_id);
CREATE INDEX IF NOT EXISTS elevation_requests_status_idx
  ON elevation_requests(status);
CREATE INDEX IF NOT EXISTS elevation_requests_created_at_idx
  ON elevation_requests(created_at DESC);

-- Pending-queue hot path (Alerts / "what needs approval"): partial
-- index on org+status restricted to pending. Mirrors the alerts hot
-- index pattern from 2026-05-17-b.
CREATE INDEX IF NOT EXISTS elevation_requests_org_pending_idx
  ON elevation_requests(org_id, requested_at DESC)
  WHERE status = 'pending';

-- Expiry-reaper hot path: pending+approved rows with expires_at set,
-- by expires_at. Cheap full-table scan replacement.
CREATE INDEX IF NOT EXISTS elevation_requests_expires_at_idx
  ON elevation_requests(expires_at)
  WHERE status IN ('approved', 'auto_approved') AND expires_at IS NOT NULL;

-- Cross-reference lookups for the UI ("show the elevations this approval
-- triggered" / "show elevations matched to this policy").
CREATE INDEX IF NOT EXISTS elevation_requests_parent_approval_id_idx
  ON elevation_requests(parent_approval_id)
  WHERE parent_approval_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS elevation_requests_software_policy_match_id_idx
  ON elevation_requests(software_policy_match_id)
  WHERE software_policy_match_id IS NOT NULL;

-- elevation_audit hot paths.
CREATE INDEX IF NOT EXISTS elevation_audit_request_id_occurred_at_idx
  ON elevation_audit(elevation_request_id, occurred_at);
CREATE INDEX IF NOT EXISTS elevation_audit_org_id_idx
  ON elevation_audit(org_id);
CREATE INDEX IF NOT EXISTS elevation_audit_event_type_idx
  ON elevation_audit(event_type);

-- ============================================================
-- updated_at trigger (matches incidents pattern)
-- ============================================================
CREATE OR REPLACE FUNCTION update_elevation_request_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_elevation_requests_updated_at ON elevation_requests;
CREATE TRIGGER trg_elevation_requests_updated_at
  BEFORE UPDATE ON elevation_requests
  FOR EACH ROW
  EXECUTE FUNCTION update_elevation_request_updated_at();

-- ============================================================
-- RLS — elevation_requests
-- ============================================================
ALTER TABLE elevation_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE elevation_requests FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON elevation_requests;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON elevation_requests;
DROP POLICY IF EXISTS breeze_org_isolation_update ON elevation_requests;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON elevation_requests;

CREATE POLICY breeze_org_isolation_select ON elevation_requests
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON elevation_requests
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON elevation_requests
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON elevation_requests
  FOR DELETE USING (public.breeze_has_org_access(org_id));

-- ============================================================
-- RLS — elevation_audit
-- ============================================================
ALTER TABLE elevation_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE elevation_audit FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON elevation_audit;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON elevation_audit;
DROP POLICY IF EXISTS breeze_org_isolation_update ON elevation_audit;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON elevation_audit;

CREATE POLICY breeze_org_isolation_select ON elevation_audit
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON elevation_audit
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
-- Audit is append-only by convention, but we keep the UPDATE / DELETE
-- policies in place so the RLS coverage contract test passes (it requires
-- a policy for each of the four DML commands). The route layer must
-- not expose UPDATE / DELETE handlers — see PAM Track 2 route review.
CREATE POLICY breeze_org_isolation_update ON elevation_audit
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON elevation_audit
  FOR DELETE USING (public.breeze_has_org_access(org_id));
