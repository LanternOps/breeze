-- #4693 (shipped with #3205 wave 5 / #4654): stamp the site's NAME on a
-- site-scoped contract line.
-- Spec: docs/superpowers/specs/billing/2026-09-03-device-set-quote-lines-design.md
--       section "Contract-line site stamp (#4693)"
--
-- Wave 1's contract_lines_site_org_fk is
--   FOREIGN KEY (site_id, org_id) REFERENCES sites (id, org_id)
--   ON DELETE SET NULL (site_id) DEFERRABLE INITIALLY IMMEDIATE
-- with NO stamped name. So deleting a site turns a per_device line scoped to
-- "Dallas" into an ORG-WIDE line, resolveLineQty bills every device in the org,
-- and nothing distinguishes that state from a line that never had a site.
-- This file adds the column, backfills it from the live sites table, and then
-- makes the strong direction a constraint.

-- ACCEPTED RESIDUAL: a line whose site was deleted BEFORE this migration ran
-- is already site_id NULL and cannot be re-stamped (the name is gone), so it
-- stays site_id NULL + site_name NULL — indistinguishable from a line that was
-- never site-scoped — and keeps billing org-wide. Only rows whose site still
-- exists are protected; the RAISE WARNING below records how many that was.
--
ALTER TABLE contract_lines ADD COLUMN IF NOT EXISTS site_name varchar(255);

-- Backfill from the live sites table. This is not inventing evidence -- it reads
-- the current truth for every line whose site still exists, which is what makes
-- the fix protect CONTRACTS THAT ALREADY EXIST rather than only new ones.
-- Without it the strong CHECK below could not be added at all, and every
-- currently site-scoped line would stay silently widenable forever.
--
-- breeze.scope = system is REQUIRED: contract_lines is forced-RLS and the
-- migration runs as an unprivileged role on managed Postgres, where a
-- context-less UPDATE silently affects 0 rows.
SELECT set_config('breeze.scope', 'system', true);
DO $$ DECLARE n int; BEGIN
  UPDATE contract_lines cl SET site_name = s.name
    FROM sites s WHERE s.id = cl.site_id AND cl.site_name IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING 'stamped % contract_lines.site_name', n;
  END IF;
END $$;

-- After the backfill the only rows with site_id set and no stamp would be ones
-- whose site vanished between the UPDATE and here, inside this transaction --
-- impossible. So the strong direction is enforceable from day one.
--
-- TOTAL over line_type, so no type is left unconstrained. Site-scopable types
-- may carry a site, and a carried site always carries its stamp; every other
-- type carries neither column. (Wave 1's CHECK only ever constrained roles, and
-- wave 2's only forbade a site_id on group lines -- flat, manual and per_seat
-- were never constrained on the site axis at all. This closes that too.)
ALTER TABLE contract_lines DROP CONSTRAINT IF EXISTS contract_lines_site_stamp_chk;
ALTER TABLE contract_lines ADD CONSTRAINT contract_lines_site_stamp_chk CHECK (
  CASE WHEN line_type IN ('per_device', 'per_device_role')
    THEN (site_id IS NULL OR site_name IS NOT NULL)
    ELSE site_id IS NULL AND site_name IS NULL END
);

-- Wave 2 forbids a site_id on a group line; the stamp has to be forbidden there
-- too or an internal writer could park a site_name on one. Redundant with the
-- ELSE arm above and kept anyway: wave 2's constraint is where a reader looks
-- for the group rules, and a wave-2 reader must not conclude a stamp is allowed.
-- DROP + re-ADD is the only way to widen a shipped CHECK (2026-10-06-100100 is
-- content-hash immutable).
ALTER TABLE contract_lines DROP CONSTRAINT IF EXISTS contract_lines_device_group_chk;
ALTER TABLE contract_lines ADD CONSTRAINT contract_lines_device_group_chk CHECK (
  CASE WHEN line_type = 'per_device_group'
    THEN device_group_name IS NOT NULL AND site_id IS NULL AND site_name IS NULL
    ELSE device_group_id IS NULL AND device_group_name IS NULL END
);
