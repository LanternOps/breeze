-- 2026-04-24: Join table `oauth_client_partner_grants` — proper fix for H2.
--
-- Background: a single DCR `oauth_clients.id` is shared across every Breeze
-- partner (Claude.ai registers once; every tenant that installs the Claude
-- MCP integration reuses that client_id). The previous H2 ship-now patch
-- made `oauth_clients.partner_id` conditional on `isNull(partnerId)` so the
-- FIRST partner to consent wins. That stopped the stomping, but Partner B's
-- `oauth_refresh_tokens` / `oauth_grants` rows existed while
-- `oauth_clients.partner_id` pointed only at Partner A — so Partner B had
-- no row in the connected-apps query (`WHERE oauth_clients.partner_id = B`).
--
-- Proper fix: per-(client, partner) membership lives in its own join table.
-- The consent route INSERTs on-conflict-do-nothing; the connected-apps
-- query JOINs through this table; revocation deletes the join row (without
-- deleting the shared client row, which other partners still rely on).
--
-- `oauth_clients.partner_id` is NOT dropped in this migration. It still
-- works as a coarse "first consenting partner" pointer and is kept around
-- for the transition period (adapter.upsert leaves it NULL on DCR, the
-- consent route no longer touches it). TODO: deprecate after a full
-- release cycle once we've confirmed no code still reads
-- `oauth_clients.partner_id` for authorization.
--
-- Tenancy shape: Partner-axis (Shape #3 per CLAUDE.md). Policy helper is
-- `breeze_has_partner_access(partner_id)` with a system-scope bypass so
-- the adapter can still upsert from system context if we ever need to.
--
-- Backfill: populate existing (client_id, partner_id) pairs from
-- `oauth_clients.partner_id` so currently-connected partners don't lose
-- their connected-apps visibility on deploy. Also backfill from
-- `oauth_refresh_tokens` because Partner B may have active tokens without
-- a matching `oauth_clients.partner_id` row (that was the whole H2 bug).
--
-- Idempotent. Safe to re-run.

BEGIN;

CREATE TABLE IF NOT EXISTS oauth_client_partner_grants (
  client_id          TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  partner_id         UUID NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  first_consented_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_consented_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, partner_id)
);

CREATE INDEX IF NOT EXISTS oauth_client_partner_grants_partner_idx
  ON oauth_client_partner_grants(partner_id);

ALTER TABLE oauth_client_partner_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_client_partner_grants FORCE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY oauth_client_partner_grants_partner_access ON oauth_client_partner_grants
    FOR ALL TO breeze_app
    USING (
      public.breeze_current_scope() = 'system'
      OR public.breeze_has_partner_access(partner_id)
    )
    WITH CHECK (
      public.breeze_current_scope() = 'system'
      OR public.breeze_has_partner_access(partner_id)
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Backfill: every client currently pointed at by either
-- `oauth_clients.partner_id` or by an active row in `oauth_refresh_tokens`
-- should have a corresponding join row. The H2 stomping bug means some
-- (client, partner) pairs only exist in refresh_tokens; UNION covers both.
INSERT INTO oauth_client_partner_grants (client_id, partner_id, first_consented_at, last_consented_at)
  SELECT DISTINCT id, partner_id, now(), now()
  FROM oauth_clients
  WHERE partner_id IS NOT NULL
  UNION
  SELECT DISTINCT client_id, partner_id, now(), now()
  FROM oauth_refresh_tokens
  WHERE partner_id IS NOT NULL
ON CONFLICT DO NOTHING;

COMMIT;
