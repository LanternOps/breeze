-- contacts + contact_external_links (issue #3258, epic #3249 Phase 3):
--
-- Breeze had no first-class contact. organizations.billing_contact and
-- sites.contact are bare nullable jsonb, so contacts could not be listed,
-- deduped, reported on, or created by any importer — and, because an
-- unshaped jsonb column is classified excludedOpen, the contact PII inside
-- them was silently DROPPED from every tenant export while the structured
-- billing_address_* columns beside them were exported. This table moves that
-- PII into real columns, which the export policy classifies as `included`.
-- Design:
-- docs/superpowers/specs/onboarding-signup/2026-08-09-organization-contacts-design.md
--
-- The legacy jsonb columns are NOT dropped, now or later. Three shipped
-- contracts depend on sites.contact existing under that name:
--   1. breeze_partner_export_sites_update()'s change-detection tuple reads
--      old_row.contact / new_row.contact (2026-07-18-partner-export-org-locks
--      .sql:279-284). Move the data out and a contact-only edit stops bumping
--      sites.partner_export_updated_at — silent divergence in the very
--      machinery built to prevent it.
--   2. partnerSiteContactSchema is a .strict() PUBLIC partner-API DTO
--      (routes/partnerApi/schemas.ts) and export records are content-hashed,
--      so changing the emitted shape re-hashes every site record and forces a
--      full re-sync across all partner consumers.
--   3. organizations.billing_contact is deliberately EXCLUDED from the
--      partner API (negative regression test in partnerApi/organizations
--      .test.ts) while sites.contact is included. One table cannot express
--      that asymmetry; the jsonb columns keep expressing it.
-- They are therefore maintained as a dual-written compatibility projection by
-- services/contacts/compat.ts, which is the ONLY writer of either.
--
-- Tenancy: Shape 1 (direct org_id) on both tables, auto-discovered by the RLS
-- coverage contract test — no allowlist entry, and deliberately NOT in
-- DUAL_AXIS_TENANT_TABLES (that asserts a partner branch these tables do not
-- have). A contact is customer data, not config/policy, so #2135's
-- partner-wide-first default does not apply: the partner-side "person" is a
-- users row, not a contact.
--
-- No json/jsonb/bytea column on either table, deliberately: an open container
-- is classified excludedOpen and would drop the row's most interesting fields
-- straight back out of tenant export — the exact defect this table fixes. Do
-- not add a metadata jsonb later without accepting that cost.
--
-- Cascade contracts (registered in the same PR):
--   - CORE_ORG_CASCADE_DELETE_ORDER (services/tenantCascade.ts)
--   - CORE_TENANT_EXPORT_POLICY (services/tenantExportPolicyRegistry.ts)
--   - No device cascade entry (no device_id), not append-only.
--   - Partner erasure needs no registration: cascadeDeletePartner sweeps
--     information_schema for partner_id columns dynamically, and neither
--     table has one.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS, guarded DO blocks for constraints,
-- CREATE INDEX IF NOT EXISTS, DROP POLICY IF EXISTS before each CREATE
-- POLICY, and backfills keyed on NOT EXISTS so re-running is a no-op.

CREATE TABLE IF NOT EXISTS contacts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL,
  site_id     uuid,
  name        varchar(255),
  email       varchar(320),
  phone       varchar(64),
  mobile      varchar(64),
  title       varchar(255),
  roles       text[] NOT NULL DEFAULT '{}',
  is_primary  boolean NOT NULL DEFAULT false,
  notes       text,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- name is nullable on purpose. A contact identified only by an address is
-- real and already exists in this product: findOrCreateEmailContact creates
-- password-less portal_users rows with a null name from inbound email, and
-- billing blobs of the form {"email": "ap@acme.com"} are common. Requiring a
-- name would force the backfill to fabricate one. The CHECK below is what
-- keeps a wholly empty row unrepresentable.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contacts_identifiable_chk') THEN
    ALTER TABLE contacts
      ADD CONSTRAINT contacts_identifiable_chk
      CHECK (name IS NOT NULL OR email IS NOT NULL OR phone IS NOT NULL OR mobile IS NOT NULL);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contacts_org_fk') THEN
    ALTER TABLE contacts
      ADD CONSTRAINT contacts_org_fk
      FOREIGN KEY (org_id) REFERENCES organizations (id) ON DELETE CASCADE;
  END IF;
END $$;

-- Composite FK against sites_id_org_id_uniq (2026-07-23-partner-export-
-- material-state-hardening.sql:39), so a contact pinned to a site belonging
-- to ANOTHER organization is unrepresentable rather than merely validated.
-- ON DELETE CASCADE rather than SET NULL: a composite SET NULL would null
-- org_id too, which is NOT NULL. Deleting a site therefore deletes the
-- contacts pinned to it, which is the intended reading of "pinned".
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contacts_site_org_fk') THEN
    ALTER TABLE contacts
      ADD CONSTRAINT contacts_site_org_fk
      FOREIGN KEY (site_id, org_id) REFERENCES sites (id, org_id) ON DELETE CASCADE;
  END IF;
END $$;

-- Required by contact_external_links' composite FK below.
CREATE UNIQUE INDEX IF NOT EXISTS contacts_id_org_id_uniq ON contacts (id, org_id);
CREATE INDEX IF NOT EXISTS contacts_org_idx ON contacts (org_id);
CREATE INDEX IF NOT EXISTS contacts_site_idx ON contacts (site_id) WHERE site_id IS NOT NULL;

-- Email is indexed but NOT unique. A shared mailbox (info@, accounts@,
-- helpdesk@) is one address belonging to several real people at one customer,
-- and a unique constraint would make that legitimate shape unimportable.
-- Email is a match HINT at preview time, never an authority; re-import
-- idempotency comes from contact_external_links.
CREATE INDEX IF NOT EXISTS contacts_org_email_idx
  ON contacts (org_id, lower(email)) WHERE email IS NOT NULL;

-- is_primary means "the headline contact for this org (or this site)" — the
-- row the compat projection writes into the legacy jsonb. It is NOT per-role
-- primacy: Pax8 readiness needs a primary admin AND billing AND technical
-- contact simultaneously (services/pax8CompanyReadiness.ts), which belongs in
-- a contact_roles child table when a consumer needs it. Do not widen this
-- flag to mean that.
CREATE UNIQUE INDEX IF NOT EXISTS contacts_org_primary_uniq
  ON contacts (org_id) WHERE is_primary AND site_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS contacts_site_primary_uniq
  ON contacts (site_id) WHERE is_primary AND site_id IS NOT NULL;

ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON contacts;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON contacts;
DROP POLICY IF EXISTS breeze_org_isolation_update ON contacts;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON contacts;

CREATE POLICY breeze_org_isolation_select ON contacts FOR SELECT USING (
  public.breeze_has_org_access(org_id)
);
CREATE POLICY breeze_org_isolation_insert ON contacts FOR INSERT WITH CHECK (
  public.breeze_has_org_access(org_id)
);
CREATE POLICY breeze_org_isolation_update ON contacts FOR UPDATE USING (
  public.breeze_has_org_access(org_id)
) WITH CHECK (
  public.breeze_has_org_access(org_id)
);
CREATE POLICY breeze_org_isolation_delete ON contacts FOR DELETE USING (
  public.breeze_has_org_access(org_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON contacts TO breeze_app;


-- contact_external_links: re-import identity, mirroring
-- organization_external_links. Email cannot serve as the dedupe key (shared
-- mailboxes, phone-only contacts, and email changes are all identity changes
-- the users table already paid for via email_epoch/pending_email), so records
-- with no safe natural key need an explicit source id — exactly what the link
-- pattern exists for.
--
-- The unique index is ORG-scoped, deliberately diverging from
-- organization_external_links' PARTNER-scoped key: a person can legitimately
-- work for two of an MSP's customers, and partner-scoping would force those
-- two relationships to collapse onto one row spanning two tenants. Org
-- scoping yields one contact row per org, each linked to the same source id.
-- Do not "fix" this to match the org table.
CREATE TABLE IF NOT EXISTS contact_external_links (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id  uuid NOT NULL,
  org_id      uuid NOT NULL,
  system      text NOT NULL,
  external_id text NOT NULL,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contact_external_links_contact_org_fk') THEN
    ALTER TABLE contact_external_links
      ADD CONSTRAINT contact_external_links_contact_org_fk
      FOREIGN KEY (contact_id, org_id)
      REFERENCES contacts (id, org_id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS contact_external_links_uniq
  ON contact_external_links (org_id, system, external_id);
CREATE INDEX IF NOT EXISTS contact_external_links_contact_idx
  ON contact_external_links (contact_id);

ALTER TABLE contact_external_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_external_links FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON contact_external_links;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON contact_external_links;
DROP POLICY IF EXISTS breeze_org_isolation_update ON contact_external_links;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON contact_external_links;

CREATE POLICY breeze_org_isolation_select ON contact_external_links FOR SELECT USING (
  public.breeze_has_org_access(org_id)
);
CREATE POLICY breeze_org_isolation_insert ON contact_external_links FOR INSERT WITH CHECK (
  public.breeze_has_org_access(org_id)
);
CREATE POLICY breeze_org_isolation_update ON contact_external_links FOR UPDATE USING (
  public.breeze_has_org_access(org_id)
) WITH CHECK (
  public.breeze_has_org_access(org_id)
);
CREATE POLICY breeze_org_isolation_delete ON contact_external_links FOR DELETE USING (
  public.breeze_has_org_access(org_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON contact_external_links TO breeze_app;


-- portal_users.contact_id: a portal user is a LOGIN attached to a contact,
-- not a second kind of person. Nullable because the link is established by
-- the backfill below and by services/inboundEmail/resolveOrg.ts going
-- forward; ON DELETE SET NULL so deleting a contact never destroys someone's
-- portal login silently.
ALTER TABLE portal_users ADD COLUMN IF NOT EXISTS contact_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'portal_users_contact_fk') THEN
    ALTER TABLE portal_users
      ADD CONSTRAINT portal_users_contact_fk
      FOREIGN KEY (contact_id) REFERENCES contacts (id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS portal_users_contact_idx
  ON portal_users (contact_id) WHERE contact_id IS NOT NULL;


-- ── Backfills ───────────────────────────────────────────────────────────────
-- Every step reports its row count (even 0) so the counts land in Postgres
-- logs and the forensic trail survives. Each is guarded by NOT EXISTS rather
-- than ON CONFLICT, because none of the target indexes covers the natural
-- key being backfilled — re-running must still be a no-op.
--
-- jsonb_typeof(...) = 'object' guards are load-bearing: organizations
-- .billing_contact is validated with z.any() on the org routes, so the column
-- can legally hold a string, a number, or an array.

-- 1. sites.contact → one site-pinned contact per site with a usable blob.
DO $$
DECLARE n integer;
BEGIN
  INSERT INTO contacts (org_id, site_id, name, email, phone, roles, is_primary)
  SELECT s.org_id, s.id,
         NULLIF(btrim(s.contact->>'name'), ''),
         NULLIF(btrim(s.contact->>'email'), ''),
         NULLIF(btrim(s.contact->>'phone'), ''),
         ARRAY['site'], true
  FROM sites s
  WHERE s.contact IS NOT NULL
    AND jsonb_typeof(s.contact) = 'object'
    AND COALESCE(NULLIF(btrim(s.contact->>'name'), ''),
                 NULLIF(btrim(s.contact->>'email'), ''),
                 NULLIF(btrim(s.contact->>'phone'), '')) IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.site_id = s.id AND c.is_primary);
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE WARNING 'backfilled % site contacts', n;
END $$;

-- 2. organizations.billing_contact → one org-level billing contact per org.
DO $$
DECLARE n integer;
BEGIN
  INSERT INTO contacts (org_id, name, email, phone, roles, is_primary)
  SELECT o.id,
         NULLIF(btrim(o.billing_contact->>'name'), ''),
         NULLIF(btrim(o.billing_contact->>'email'), ''),
         NULLIF(btrim(o.billing_contact->>'phone'), ''),
         ARRAY['billing'], true
  FROM organizations o
  WHERE o.billing_contact IS NOT NULL
    AND jsonb_typeof(o.billing_contact) = 'object'
    AND COALESCE(NULLIF(btrim(o.billing_contact->>'name'), ''),
                 NULLIF(btrim(o.billing_contact->>'email'), ''),
                 NULLIF(btrim(o.billing_contact->>'phone'), '')) IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM contacts c WHERE c.org_id = o.id AND c.site_id IS NULL AND c.is_primary
    );
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE WARNING 'backfilled % organization billing contacts', n;
END $$;

-- 3a. portal_users → link to an EXISTING contact where (org_id, lower(email))
--     matches exactly one. Matching only on an unambiguous single hit keeps
--     shared mailboxes from conflating two different people.
DO $$
DECLARE n integer;
BEGIN
  UPDATE portal_users pu
  SET contact_id = m.contact_id
  FROM (
    SELECT c.org_id, lower(c.email) AS email, min(c.id) AS contact_id
    FROM contacts c
    WHERE c.email IS NOT NULL
    GROUP BY c.org_id, lower(c.email)
    HAVING count(*) = 1
  ) m
  WHERE pu.contact_id IS NULL
    AND pu.org_id = m.org_id
    AND lower(pu.email) = m.email;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE WARNING 'linked % portal users to existing contacts', n;
END $$;

-- 3b. portal_users with no match → create the contact and link it. is_primary
--     stays false so this can never collide with the headline contact created
--     in steps 1 and 2.
--
--     Row-wise on purpose. A set-based INSERT ... RETURNING cannot return the
--     SOURCE portal_users.id, so the rows would have to be re-joined on
--     (org_id, lower(email)) — and two portal users sharing an address in one
--     org (legal: portal_users has no unique on email, see
--     inboundEmail/resolveOrg.ts) would then both link to whichever contact
--     the join picked, stranding the other. One-time backfill over a small
--     table; correctness beats set-based here.
DO $$
DECLARE
  n integer := 0;
  r record;
  new_contact_id uuid;
BEGIN
  FOR r IN SELECT id, org_id, name, email FROM portal_users WHERE contact_id IS NULL LOOP
    INSERT INTO contacts (org_id, name, email, roles, is_primary)
    VALUES (r.org_id, NULLIF(btrim(r.name), ''), r.email, ARRAY['portal'], false)
    RETURNING id INTO new_contact_id;

    UPDATE portal_users SET contact_id = new_contact_id WHERE id = r.id;
    n := n + 1;
  END LOOP;
  RAISE WARNING 'created and linked % contacts from portal users', n;
END $$;
