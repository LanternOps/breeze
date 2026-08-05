-- Quick Support — one-time code ad-hoc remote sessions.
-- Spec: docs/superpowers/specs/2026-07-06-one-off-support-session-design.md
-- Plan: docs/superpowers/plans/2026-07-06-quick-support-phase1.md
--
-- A tech generates a short one-time code; the end user runs a downloaded client
-- (the Go agent in `support` mode) that enrolls an EPHEMERAL device into a
-- hidden per-partner 'quick_support' org. The existing remote-desktop stack
-- (remote_sessions, WebRTC broker, consent, viewer, audit) is then reused
-- unchanged. Everything self-destructs at session end.
--
-- support_sessions is RLS Shape 1 (direct org_id) — auto-discovered by
-- rls-coverage.integration.test.ts, so it needs no allowlist entry. It DOES
-- need registering in the cascade/export lists (done in the same PR):
--   - CORE_ORG_CASCADE_DELETE_ORDER   (services/tenantCascade.ts)
--   - DEVICE_DETACH_DEVICE_ID_TABLES  (routes/devices/core.ts — device_id is
--     ON DELETE SET NULL, so the row survives device deletion like tickets)
--   - CORE_TENANT_EXPORT_POLICY       (services/tenantExportPolicyRegistry.ts)
--
-- Idempotent: ADD COLUMN / CREATE TABLE / CREATE INDEX IF NOT EXISTS, guarded
-- type creation, DROP POLICY IF EXISTS then CREATE. Re-applying is a no-op.
-- No inner BEGIN/COMMIT — autoMigrate wraps each file in one transaction.

-- ============================================
-- Step 1: new org type for the hidden per-partner Quick Support org
-- ============================================
-- PG12+ allows ADD VALUE inside a transaction, but the new value cannot be
-- USED in the same transaction (55P04 "unsafe use of new value") — and
-- autoMigrate wraps each file in ONE transaction. That is why the partial
-- index on `type = 'quick_support'` lives in the -b- file. Nothing in THIS
-- file may reference the new value.
ALTER TYPE org_type ADD VALUE IF NOT EXISTS 'quick_support';

-- ============================================
-- Step 2: ephemeral device marker
-- ============================================
-- Ephemeral devices are excluded from partner license counts, device
-- listings, billing rollups and alert evaluation, and are purged by the
-- reaper 6h after their session ends.
ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS is_ephemeral BOOLEAN NOT NULL DEFAULT FALSE;

-- ============================================
-- Step 3: support_sessions
-- ============================================
DO $$
BEGIN
  CREATE TYPE support_session_status AS ENUM ('pending','claimed','ready','ended','expired');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS support_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- the partner's hidden Quick Support org (never a real customer org)
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- SHA-256 hex of the one-time code; plaintext is shown once at creation
  -- and never stored.
  code_hash VARCHAR(64) NOT NULL UNIQUE,
  code_expires_at TIMESTAMPTZ NOT NULL,
  status support_session_status NOT NULL DEFAULT 'pending',
  -- hard cap so no session can outlive the day even if nothing else fires
  hard_expires_at TIMESTAMPTZ NOT NULL,
  -- SET NULL (not CASCADE): the session row is the audit trail and must
  -- survive the ephemeral device being purged.
  device_id UUID REFERENCES devices(id) ON DELETE SET NULL,
  -- reporting only — carries no tenancy effect whatsoever
  attributed_org_id UUID REFERENCES organizations(id) ON DELETE SET NULL,
  attribution_label TEXT,
  claimed_at TIMESTAMPTZ,
  claimed_from_ip TEXT,
  ended_at TIMESTAMPTZ,
  ended_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_support_sessions_reaper
  ON support_sessions(status, hard_expires_at);
CREATE INDEX IF NOT EXISTS idx_support_sessions_device
  ON support_sessions(device_id);

-- ============================================
-- Step 4: link the redeemed child enrollment key back to its session
-- ============================================
ALTER TABLE enrollment_keys
  ADD COLUMN IF NOT EXISTS support_session_id UUID
    REFERENCES support_sessions(id) ON DELETE CASCADE;

-- ============================================
-- Step 5: RLS — Shape 1 (direct org_id)
-- ============================================
-- breeze_has_org_access() already short-circuits to TRUE under system scope
-- (0008-tenant-rls.sql), which is what lets the public redeem path and the
-- reaper write through withSystemDbAccessContext.
ALTER TABLE support_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_sessions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON support_sessions;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON support_sessions;
DROP POLICY IF EXISTS breeze_org_isolation_update ON support_sessions;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON support_sessions;

CREATE POLICY breeze_org_isolation_select ON support_sessions
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON support_sessions
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON support_sessions
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON support_sessions
  FOR DELETE USING (public.breeze_has_org_access(org_id));
