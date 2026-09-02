-- #3205: contract lines billed by device role — column, invariant, site ownership.
-- Companion to 2026-10-05-100000-contract-line-type-per-device-role.sql (enum value).

ALTER TABLE contract_lines ADD COLUMN IF NOT EXISTS device_roles text[];

-- Role lines carry a non-empty, one-dimensional, null-free array of known
-- BILLABLE roles ('unknown' is a classification gap, never a rate); every other
-- line type carries NULL — not an empty array. This is the DB twin of
-- contractLineInputSchema (packages/shared/src/validators/contracts.ts).
-- Widen the list here when BILLABLE_DEVICE_ROLES grows.
ALTER TABLE contract_lines DROP CONSTRAINT IF EXISTS contract_lines_device_roles_chk;
ALTER TABLE contract_lines ADD CONSTRAINT contract_lines_device_roles_chk CHECK (
  CASE WHEN line_type = 'per_device_role' THEN
    device_roles IS NOT NULL
    AND cardinality(device_roles) > 0
    AND array_ndims(device_roles) = 1
    AND array_position(device_roles, NULL) IS NULL
    AND device_roles <@ ARRAY['workstation','server','printer','router','switch',
                              'firewall','access_point','phone','iot','camera','nas']::text[]
  ELSE device_roles IS NULL END
);

-- Site ownership. contract_lines_site_fkey (2026-06-15-d) referenced sites(id)
-- alone, so a site from ANOTHER org was accepted and the device count silently
-- returned zero. Clear any such rows (count logged — forensic trail), then
-- replace the FK with a composite one against sites_id_org_id_uniq (2026-07-23).
-- ON DELETE SET NULL (site_id): the column list (PG 15+) nulls only site_id; a
-- bare SET NULL would also null org_id, which is NOT NULL.
-- contract_lines is ENABLE + FORCE ROW LEVEL SECURITY (2026-06-15-d), so the
-- policies apply to the table OWNER too, and breeze_current_scope() deny-defaults
-- to 'none' (0012 supersedes 0008). autoMigrate sets no scope. On managed
-- Postgres (DigitalOcean/RDS) the admin role is NOT a superuser: without this the
-- UPDATE below is a silent 0-row no-op, the RAISE WARNING never fires, and the
-- composite FK (RI checks bypass RLS) then aborts on the surviving cross-org rows
-- and refuses the API's boot. is_local = true scopes it to autoMigrate's per-file
-- transaction. Same one-liner as 2026-09-29-100000-automation-policy-compliance-unique.sql.
SELECT set_config('breeze.scope', 'system', true);
DO $$ DECLARE n int; BEGIN
  UPDATE contract_lines cl SET site_id = NULL
    FROM sites s WHERE cl.site_id = s.id AND s.org_id <> cl.org_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN RAISE WARNING 'cleaned % contract_lines rows whose site belonged to another org', n; END IF;
END $$;
ALTER TABLE contract_lines DROP CONSTRAINT IF EXISTS contract_lines_site_fkey;
ALTER TABLE contract_lines DROP CONSTRAINT IF EXISTS contract_lines_site_org_fk;
-- DEFERRABLE INITIALLY IMMEDIATE: org merge runs SET CONSTRAINTS ALL DEFERRED
-- and re-points parent and child org_id in separate statements, so every
-- composite FK that references an org_id column must be deferrable. Enforced by
-- orgLifecycleFoundations.integration.test.ts ("merge contract").
ALTER TABLE contract_lines ADD CONSTRAINT contract_lines_site_org_fk
  FOREIGN KEY (site_id, org_id) REFERENCES sites (id, org_id) ON DELETE SET NULL (site_id)
  DEFERRABLE INITIALLY IMMEDIATE;
