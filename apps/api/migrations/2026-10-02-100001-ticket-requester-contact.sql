-- tickets.requester_contact_id: the canonical PERSON on a ticket (#3258 W03)
--
-- Inbound email used to mint a password-less `portal_users` row per unknown
-- sender purely so the ticket had *something* to attribute to. Those rows are
-- not logins, they duplicate the person that `contacts` already models, and
-- they made "who filed this?" answerable only through an auth table. From this
-- migration forward the requester is a `contacts` row and `submitted_by` means
-- exactly one thing: the OPTIONAL portal LOGIN that filed it.
--
-- Shape: the FK is COMPOSITE against `contacts_id_org_id_uniq` (id, org_id),
-- so a cross-org requester is unrepresentable rather than merely validated —
-- the same construction `contacts_site_org_fk` uses for its site pin. Two
-- non-obvious clauses:
--   * `ON DELETE SET NULL (requester_contact_id)` — the COLUMN LIST form
--     (PG 15+). A bare composite SET NULL would also null `org_id`, which is
--     NOT NULL, so deleting a contact would fail instead of unlinking.
--   * `DEFERRABLE INITIALLY IMMEDIATE` — required of every composite FK on an
--     org-cascade table by orgLifecycleFoundations.integration.test.ts; org
--     merge re-tenants rows inside one transaction and needs to defer.
--
-- Registration (CLAUDE.md cascade table): `tickets` is already in
-- CORE_ORG_CASCADE_DELETE_ORDER and CORE_TENANT_EXPORT_POLICY. The export
-- policy row is the one that fires on a NEW COLUMN, not just a new table —
-- `requester_contact_id` is classified `included` (a tenant identifier
-- pointing at the org's own contact row) in tenantExportPolicyRegistry.ts.

-- `tickets` is ENABLE + FORCE ROW LEVEL SECURITY and `breeze_current_scope()`
-- defaults to 'none' (deny), so the backfill UPDATE below would match ZERO rows
-- on managed Postgres where the migration role is not a superuser — a silent
-- no-op that reports a truthful-looking "backfilled 0". `is_local = true`
-- scopes this to autoMigrate's per-file transaction.
-- See 2026-09-30-100000-rls-scoped-backfill-replay.sql for the full write-up.
SELECT set_config('breeze.scope', 'system', true);

ALTER TABLE tickets ADD COLUMN IF NOT EXISTS requester_contact_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tickets_requester_contact_org_fk'
  ) THEN
    ALTER TABLE tickets
      ADD CONSTRAINT tickets_requester_contact_org_fk
      FOREIGN KEY (requester_contact_id, org_id)
      REFERENCES contacts (id, org_id)
      ON DELETE SET NULL (requester_contact_id)
      DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
END $$;

-- Partial: the vast majority of historic tickets have no contact link, and the
-- only query shape is "tickets for THIS contact" (portal ownership by contact).
CREATE INDEX IF NOT EXISTS tickets_requester_contact_idx
  ON tickets (requester_contact_id)
  WHERE requester_contact_id IS NOT NULL;

-- Backfill: every ticket whose portal login is already linked to a contact
-- (2026-08-19-contacts.sql backfilled portal_users.contact_id exhaustively)
-- gets the canonical person it should have had. The `pu.org_id = t.org_id`
-- predicate is redundant with the FK but keeps the statement itself
-- cross-tenant-safe if it is ever replayed by hand.
DO $$
DECLARE
  n bigint;
BEGIN
  UPDATE tickets t
     SET requester_contact_id = pu.contact_id
    FROM portal_users pu
   WHERE t.submitted_by = pu.id
     AND pu.org_id = t.org_id
     AND pu.contact_id IS NOT NULL
     AND t.requester_contact_id IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING 'backfilled % tickets.requester_contact_id from portal_users.contact_id', n;
  END IF;
END $$;
