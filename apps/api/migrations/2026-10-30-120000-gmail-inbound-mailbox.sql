-- Native Gmail (Google Workspace) inbound mailbox connector — schema foundation.
--
-- Adds a provider discriminator + Gmail-specific identity/cursor columns to
-- ticket_mailbox_connections, which until now modelled ONLY Microsoft 365
-- mailboxes (tenant_id + a composite FK to ticket_mailbox_tenant_ownerships +
-- a CHECK that a 'connected' row must carry a Microsoft tenant).
--
-- Design notes (see plan): tenant_id stays Microsoft-ONLY — we do NOT overload it
-- for Google. A Google connection resolves its domain-wide-delegation
-- service-account credentials via the owning org's google_workspace_connections
-- row (org_id). google_account_sub holds the mailbox's immutable Google account
-- `sub` (from OpenID UserInfo via DWD at connect) — the per-mailbox dedup namespace
-- and the same-account proof on reconnect. history_id is the Gmail incremental
-- cursor (a STRING — never numeric).
--
-- Safe on existing data: Microsoft 365 mailbox rows already exist in production.
-- They take provider 'm365' from the column default and leave the new Gmail
-- columns NULL, so every constraint below validates against them. Idempotent
-- (guards on catalog).

-- 1. Columns (additive, idempotent). provider defaults 'm365' to match the
--    inbound pipeline's provider vocabulary (NormalizedInboundEmail.provider),
--    so the mailbox-generation lock compares message vs connection provider by
--    direct equality — no error-prone 'microsoft'<->'m365' mapping. Any
--    pre-existing row is correctly classified without a separate backfill.
ALTER TABLE ticket_mailbox_connections
  ADD COLUMN IF NOT EXISTS provider varchar(20) NOT NULL DEFAULT 'm365',
  ADD COLUMN IF NOT EXISTS history_id text,
  ADD COLUMN IF NOT EXISTS google_account_sub varchar(255),
  ADD COLUMN IF NOT EXISTS org_id uuid,
  -- Gmail eligibility floor: the connect-time instant. Recovery after an expired
  -- history cursor enumerates the inbox but only ingests mail at/after this floor,
  -- so a re-seed can never import mail that predates the connection as new tickets.
  ADD COLUMN IF NOT EXISTS eligible_after timestamptz;

-- 2. provider is a closed set. Named CHECK, guarded so re-runs are no-ops.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'ticket_mailbox_connections_provider_check'
      AND conrelid = 'ticket_mailbox_connections'::regclass
  ) THEN
    ALTER TABLE ticket_mailbox_connections
      ADD CONSTRAINT ticket_mailbox_connections_provider_check
      CHECK (provider IN ('m365', 'gmail'));
  END IF;
END $$;

-- 3. COMPOSITE FK (org_id, partner_id) -> organizations(id, partner_id). This is
--    the tenant-isolation invariant: a Gmail connection's credential-owning org
--    MUST belong to the SAME partner as the connection, so the poll worker can
--    never load one partner's DWD credential for another partner's mailbox. A
--    single-column org_id FK would not catch a mismatched partner. MATCH SIMPLE
--    (default) means the FK is not enforced when org_id IS NULL, so Microsoft
--    rows (org_id NULL, partner-scoped) are unaffected. References the existing
--    unique constraint organizations(id, partner_id). ON DELETE CASCADE: a
--    deleted org takes its Gmail mailbox connection with it.
--
--    DEFERRABLE INITIALLY IMMEDIATE: org merge does SET CONSTRAINTS ALL DEFERRED
--    and repoints parent and child org_id in separate statements (#6592); a
--    non-deferrable composite org_id FK would abort the merge with 23503.
--
--    Converges rather than only adding: a database that ran a pre-release draft of
--    this schema may carry a single-column org_id FK or a non-deferrable composite
--    one. Drop the former; replace the latter; add the FK if missing; otherwise
--    leave it alone.
ALTER TABLE ticket_mailbox_connections
  DROP CONSTRAINT IF EXISTS ticket_mailbox_connections_org_fk;

DO $$
DECLARE
  is_deferrable boolean;
BEGIN
  SELECT condeferrable INTO is_deferrable
  FROM pg_constraint
  WHERE conname = 'ticket_mailbox_connections_org_partner_fk'
    AND conrelid = 'ticket_mailbox_connections'::regclass;

  IF is_deferrable IS FALSE THEN
    ALTER TABLE ticket_mailbox_connections
      DROP CONSTRAINT ticket_mailbox_connections_org_partner_fk;
  END IF;

  IF is_deferrable IS NULL OR is_deferrable IS FALSE THEN
    ALTER TABLE ticket_mailbox_connections
      ADD CONSTRAINT ticket_mailbox_connections_org_partner_fk
      FOREIGN KEY (org_id, partner_id) REFERENCES organizations(id, partner_id)
      ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
END $$;

-- 4. Make the "connected requires a verified identity" invariant provider-specific.
--    Old: status <> 'connected' OR tenant_id IS NOT NULL  (Microsoft-only)
--    New: a connected Microsoft row needs a tenant; a connected Gmail row needs a
--         verified Google account sub. Drop-and-recreate under the SAME name.
ALTER TABLE ticket_mailbox_connections
  DROP CONSTRAINT IF EXISTS ticket_mailbox_connections_connected_requires_verified_tenant;

ALTER TABLE ticket_mailbox_connections
  ADD CONSTRAINT ticket_mailbox_connections_connected_requires_verified_tenant
  CHECK (
    status <> 'connected'
    OR (provider = 'm365' AND tenant_id IS NOT NULL)
    OR (provider = 'gmail' AND google_account_sub IS NOT NULL AND org_id IS NOT NULL)
  );

-- 5. Provider fields are mutually exclusive. A Microsoft row never carries the
--    Gmail identity/cursor columns; a Gmail row never carries a Microsoft tenant.
--    Without this, a mixed row (e.g. a connected Gmail row with a stray tenant_id)
--    would silently FAIL the provider-scoped mailbox-generation lock
--    (tenant_id IS NOT DISTINCT FROM <the Gmail generation's null tenant>) and the
--    job would be dropped with no ticket. Pre-existing Microsoft rows satisfy this:
--    the four Gmail columns are new and NULL for them. Drop-and-recreate for
--    idempotency.
ALTER TABLE ticket_mailbox_connections
  DROP CONSTRAINT IF EXISTS ticket_mailbox_connections_provider_fields_consistent;

ALTER TABLE ticket_mailbox_connections
  ADD CONSTRAINT ticket_mailbox_connections_provider_fields_consistent
  CHECK (
    (provider = 'm365'
       AND org_id IS NULL AND google_account_sub IS NULL
       AND history_id IS NULL AND eligible_after IS NULL)
    OR
    (provider = 'gmail' AND tenant_id IS NULL)
  );

-- The ticket_mailbox permissions now gate Gmail mailboxes too; say so in the
-- role editor instead of describing them as Microsoft 365 only. Row writes
-- need system scope, or on a non-bypass connection they match zero rows.
SELECT set_config('breeze.scope', 'system', true);

UPDATE permissions
SET description = 'View Microsoft 365 and Google Workspace ticket mailbox connection status'
WHERE resource = 'ticket_mailbox' AND action = 'read';

UPDATE permissions
SET description = 'Connect, verify, retest, and disconnect Microsoft 365 and Google Workspace ticket mailboxes'
WHERE resource = 'ticket_mailbox' AND action = 'admin';
