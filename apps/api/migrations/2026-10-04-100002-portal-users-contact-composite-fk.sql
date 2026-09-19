-- portal_users.contact_id: same-org composite FK (#3258 follow-up to W03)
--
-- 2026-08-19-contacts.sql gave `portal_users` a `contact_id` with a PLAIN
-- single-column FK (`portal_users_contact_fk` -> contacts(id)). Nothing in the
-- schema forced the LOGIN and the CONTACT behind it into the same
-- organization, so a cross-org link was representable at the DB level even
-- though every writer happened to be org-bounded. After W03
-- (2026-10-04-100000-ticket-requester-contact.sql) this is the LAST plain FK
-- into `contacts`: `tickets.requester_contact_id` and `contacts.site_id` are
-- both composite already.
--
-- That gap was not theoretical. W03 derives a ticket's requester from the
-- filer's login (`readPortalUserContactLink` in services/ticketService.ts), so
-- one drifted `portal_users` row would have proposed a cross-org
-- `tickets.requester_contact_id` — which the composite FK there rejects as a
-- raw 23503. W03's own backfill had to carry an `EXISTS (SELECT 1 FROM
-- contacts c WHERE c.id = pu.contact_id AND c.org_id = t.org_id)` guard purely
-- to stop such a row aborting the whole migration file. This migration removes
-- the drift at the source instead of defending against it downstream.
--
-- Shape (copied from `tickets_requester_contact_org_fk`, which copied
-- `contacts_site_org_fk`): the FK is COMPOSITE against
-- `contacts_id_org_id_uniq (id, org_id)`, so a cross-org login/contact pair is
-- unrepresentable rather than merely validated. Two non-obvious clauses:
--   * `ON DELETE SET NULL (contact_id)` — the COLUMN LIST form (PG 15+). A
--     bare composite SET NULL would also null `org_id`, which is NOT NULL, so
--     deleting a contact would fail instead of unlinking the login.
--     Preserving "deleting a contact never destroys someone's portal login" is
--     the whole reason the original FK was ON DELETE SET NULL, and the path
--     that exercises it is the INTERACTIVE one: `deleteContact` on a contact
--     that some login is bound to.
--
--     It is NOT org erasure. `cascadeDeleteOrg` orders its DELETEs with
--     `topologicalCascadeOrder()`, whose pg_constraint read counts every FK
--     edge regardless of `confdeltype` — so this very constraint makes
--     `portal_users` a CHILD of `contacts` and it is deleted FIRST. The
--     referential action never fires during an erasure. (Which is also why
--     adding this FK cannot reorder an erasure into an FK violation: it moves
--     `portal_users` earlier, never later.)
--   * `DEFERRABLE INITIALLY IMMEDIATE` — required of every composite FK whose
--     referenced side includes an `org_id` column by
--     orgLifecycleFoundations.integration.test.ts. Org merge runs
--     `SET CONSTRAINTS ALL DEFERRED` and re-points `portal_users` and
--     `contacts` in separate statements of one transaction (both are in the
--     merge registry: `portal_users` is a plain repoint, `contacts` a custom
--     repoint), so a non-deferrable constraint here would abort the merge
--     mid-walk.
--
-- Registration (CLAUDE.md cascade table): NOTHING to add. No new table and no
-- new column — `portal_users` is already in CORE_ORG_CASCADE_DELETE_ORDER and
-- its `contact_id` is already classified `included` in CORE_TENANT_EXPORT_POLICY
-- (tenantExportPolicyRegistry.ts). The export-policy list is the one that fires
-- on a new COLUMN, and this migration adds none.

-- `portal_users` is ENABLE + FORCE ROW LEVEL SECURITY and
-- `breeze_current_scope()` defaults to 'none' (deny), so the cleanup UPDATE
-- below would match ZERO rows on managed Postgres where the migration role is
-- not a superuser — a silent no-op reporting a truthful-looking "cleaned 0".
-- `is_local = true` scopes this to autoMigrate's per-file transaction.
-- See 2026-09-30-100000-rls-scoped-backfill-replay.sql for the full write-up.
SELECT set_config('breeze.scope', 'system', true);

-- Cleanup BEFORE the constraint: any pre-existing drifted row would make the
-- ADD CONSTRAINT below fail its initial validation and abort the whole file on
-- every database that has the drift, with no way to skip it. Nulling the link
-- is the recoverable direction (a technician can re-invite; the login itself
-- and its ticket history are untouched), and it is exactly what
-- `ON DELETE SET NULL (contact_id)` would have done had the contact been
-- deleted instead of moved.
--
-- The count is reported UNCONDITIONALLY. A non-zero count is evidence that a
-- login was pointing at a person in another tenant — potentially a
-- tenant-isolation incident — and the forensic trail has to survive even when
-- the number is 0, because a suppressed 0 is indistinguishable from the RLS
-- no-op the `breeze.scope` note above describes.
DO $$
DECLARE
  n bigint;
BEGIN
  UPDATE portal_users pu
     SET contact_id = NULL
    FROM contacts c
   WHERE c.id = pu.contact_id
     AND c.org_id <> pu.org_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE WARNING 'cleaned % cross-org portal_users.contact_id link(s)', n;
END $$;

-- Drop the superseded single-column FK, by SHAPE rather than by name.
--
-- On a database migrated from this repo the name is the one
-- 2026-08-19-contacts.sql declared explicitly (`portal_users_contact_fk`), but
-- a developer database built with `drizzle-kit push` carries the generated
-- alias `portal_users_contact_id_contacts_id_fk` instead, and a hand-repaired
-- one could carry anything. Matching on "single-column FK from portal_users to
-- contacts" converges all of them, and cannot touch the composite added below
-- (cardinality 2) or the org_id FK (a different `confrelid`).
--
-- Leaving one behind would not re-open the cross-org hole — Postgres evaluates
-- FK constraints conjunctively, so a surviving single-column FK is redundant
-- rather than permissive — but it WOULD leave two SET NULL actions racing on
-- one column and a second, unnecessary lock on `contacts`. The suite asserts
-- exactly one FK from portal_users to contacts survives.
DO $$
DECLARE
  fk record;
BEGIN
  FOR fk IN
    SELECT conname
      FROM pg_constraint
     WHERE contype = 'f'
       AND conrelid = 'portal_users'::regclass
       AND confrelid = 'contacts'::regclass
       AND cardinality(conkey) = 1
  LOOP
    EXECUTE format('ALTER TABLE portal_users DROP CONSTRAINT %I', fk.conname);
    RAISE WARNING 'dropped superseded single-column FK portal_users.% -> contacts', fk.conname;
  END LOOP;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'portal_users_contact_org_fk'
       AND conrelid = 'portal_users'::regclass
  ) THEN
    ALTER TABLE portal_users
      ADD CONSTRAINT portal_users_contact_org_fk
      FOREIGN KEY (contact_id, org_id)
      REFERENCES contacts (id, org_id)
      ON DELETE SET NULL (contact_id)
      DEFERRABLE INITIALLY IMMEDIATE;
  END IF;
END $$;

-- The partial index from 2026-08-19-contacts.sql stays: dropping the plain FK
-- does not drop it (it was created separately), and the composite FK's own
-- index requirement is on the REFERENCED side (contacts_id_org_id_uniq), not
-- here. Re-stated with IF NOT EXISTS so a database that somehow lost it is
-- repaired rather than left without the index behind "tickets for this
-- contact's login".
CREATE INDEX IF NOT EXISTS portal_users_contact_idx
  ON portal_users (contact_id) WHERE contact_id IS NOT NULL;
