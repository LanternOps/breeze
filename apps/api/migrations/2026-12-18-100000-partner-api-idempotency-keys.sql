-- Partner API idempotency claims for the tickets write surface
-- (POST /partner-api/tickets, POST /partner-api/tickets/:id/comments).
-- Design: docs/superpowers/specs/api-platform/2026-09-27-partner-api-tickets-design.md §4.
--
-- Same design as partner_enrollment_key_idempotency
-- (2026-10-08-101600-enrollment-keys-scope.sql), generalised with a `route`
-- discriminator and BOUND TO THE TICKET it guards: a (principal, route, key)
-- claim is inserted in the SAME transaction as the resource it protects,
-- carries a fingerprint of {route, ticketId, body} so a reused key with a
-- different body — or the same body against a different ticket — is a 409
-- rather than a silent replay, and is linked to the created resource id so a
-- retry can answer from the claim. `resource_id` is deliberately NOT a
-- foreign key — the route decides which table it names (a ticket, a comment).
-- `ticket_id` IS one: the path ticket for a comment claim, the created ticket
-- for a create claim (set together with resource_id), ON DELETE CASCADE.
--
-- A claim with a null resource_id can never be observed by a later request:
-- it is only visible once the transaction that also linked it has committed.
--
-- Tenancy: shape 1 (org_id), denormalized from the ticket. Because the row has
-- a ticket_id AND a denormalized org_id it is the ticket-linked child case of
-- the cascade contract: CORE_ORG_CASCADE_DELETE_ORDER, orgMergeRegistry
-- (repoint), CORE_TENANT_EXPORT_POLICY, and BOTH org movers
-- (TICKET_ORG_DENORMALIZED_TABLES + CUSTOM_ORG_REWRITE_TABLES, appended last
-- on each axis) so a claim follows its ticket across an org move instead of
-- being erased with the old org while still guarding a live ticket. The
-- composite (org_id, partner_id) -> organizations(id, partner_id) FK is
-- DEFERRABLE INITIALLY IMMEDIATE, as every composite org FK must be
-- (CLAUDE.md, org merge runs SET CONSTRAINTS ALL DEFERRED).
--
-- A claim's org follows its TICKET's org by schema, the same rule as
-- ticket_external_refs (#7490 review): composite (ticket_id, org_id) ->
-- tickets(id, org_id), DEFERRABLE INITIALLY IMMEDIATE, target index
-- tickets_id_org_uq. ticket_id is NULL on a create claim until the create
-- links it; composite FKs are MATCH SIMPLE, so the constraint applies from
-- that link on. Both movers UPDATE tickets.org_id before re-stamping the
-- children, so they name partner_api_idempotency_keys_ticket_org_fk in their
-- SET CONSTRAINTS … DEFERRED statements. The single-column ticket_id FK is
-- kept (redundant, never permissive).
--
-- Retention: a claim only has to outlive the window in which a client may
-- retry. jobs/partnerApiIdempotencyRetention.ts (its own daily job,
-- PARTNER_API_IDEMPOTENCY_RETENTION_DAYS / _ENABLED) deletes rows older than
-- the retention window, scanning created_at.
--
-- Fully idempotent — safe to re-run. Nothing here writes rows.

CREATE TABLE IF NOT EXISTS partner_api_idempotency_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  partner_service_principal_id uuid NOT NULL,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  ticket_id uuid REFERENCES tickets(id) ON DELETE CASCADE,
  route varchar(64) NOT NULL,
  idempotency_key varchar(128) NOT NULL,
  request_fingerprint varchar(64) NOT NULL,
  resource_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT partner_api_idempotency_keys_principal_partner_fk
    FOREIGN KEY (partner_service_principal_id, partner_id)
    REFERENCES partner_service_principals(id, partner_id) ON DELETE CASCADE,
  CONSTRAINT partner_api_idempotency_keys_org_partner_fk
    FOREIGN KEY (org_id, partner_id)
    REFERENCES organizations(id, partner_id) ON DELETE CASCADE
    DEFERRABLE INITIALLY IMMEDIATE
);

DO $$ BEGIN
  ALTER TABLE partner_api_idempotency_keys ADD CONSTRAINT partner_api_idempotency_keys_ticket_org_fk
    FOREIGN KEY (ticket_id, org_id) REFERENCES tickets(id, org_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE UNIQUE INDEX IF NOT EXISTS partner_api_idempotency_keys_principal_route_key_unique
  ON partner_api_idempotency_keys(partner_service_principal_id, route, idempotency_key);

-- The partner-axis FK is otherwise unindexed, which makes the cascade from
-- partners(id) a sequential scan of this table.
CREATE INDEX IF NOT EXISTS partner_api_idempotency_keys_partner_idx
  ON partner_api_idempotency_keys(partner_id);
CREATE INDEX IF NOT EXISTS partner_api_idempotency_keys_org_idx
  ON partner_api_idempotency_keys(org_id);
-- Ticket cascade / org-move rewrite path.
CREATE INDEX IF NOT EXISTS partner_api_idempotency_keys_ticket_idx
  ON partner_api_idempotency_keys(ticket_id);
-- Retention sweep scan path.
CREATE INDEX IF NOT EXISTS partner_api_idempotency_keys_created_at_idx
  ON partner_api_idempotency_keys(created_at);

ALTER TABLE partner_api_idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_api_idempotency_keys FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'partner_api_idempotency_keys' AND policyname = 'partner_api_idempotency_keys_select') THEN
    CREATE POLICY partner_api_idempotency_keys_select ON partner_api_idempotency_keys
      FOR SELECT USING (public.breeze_has_org_access(org_id));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'partner_api_idempotency_keys' AND policyname = 'partner_api_idempotency_keys_insert') THEN
    CREATE POLICY partner_api_idempotency_keys_insert ON partner_api_idempotency_keys
      FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'partner_api_idempotency_keys' AND policyname = 'partner_api_idempotency_keys_update') THEN
    CREATE POLICY partner_api_idempotency_keys_update ON partner_api_idempotency_keys
      FOR UPDATE USING (public.breeze_has_org_access(org_id))
      WITH CHECK (public.breeze_has_org_access(org_id));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'partner_api_idempotency_keys' AND policyname = 'partner_api_idempotency_keys_delete') THEN
    CREATE POLICY partner_api_idempotency_keys_delete ON partner_api_idempotency_keys
      FOR DELETE USING (public.breeze_has_org_access(org_id));
  END IF;
END $$;

-- The API connects as the unprivileged app role; without this grant every
-- claim insert is a 42501 regardless of the policies above.
GRANT SELECT, INSERT, UPDATE, DELETE ON partner_api_idempotency_keys TO breeze_app;
