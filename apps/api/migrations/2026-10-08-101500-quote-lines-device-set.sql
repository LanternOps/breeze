-- #3205 wave 5 / #4654: device-set descriptors on recurring quote lines.
-- Spec: docs/superpowers/specs/billing/2026-09-03-device-set-quote-lines-design.md
--
-- No enum file is needed. contract_line_type gained per_device_group in wave 2's
-- 2026-10-06-100000 and contract_overage_mode was created by wave 4's
-- 2026-10-07-100000; both are committed before this file runs, and this file
-- only REFERENCES them. (The wave 1/2 two-file split exists only because
-- ALTER TYPE ... ADD VALUE cannot have its new value USED in the same
-- transaction.)

-- Deliberately the CONTRACT enums, not quote-local twins: one vocabulary means
-- quoteToContract maps 1:1 and a future line type cannot be spelled two ways.
ALTER TABLE quote_lines ADD COLUMN IF NOT EXISTS contract_line_type contract_line_type;
ALTER TABLE quote_lines ADD COLUMN IF NOT EXISTS device_roles text[];
ALTER TABLE quote_lines ADD COLUMN IF NOT EXISTS device_group_id uuid;
-- Stamped at write. Survives group deletion (the FK nulls only the id) so an
-- accepted quote still says what it priced, the customer document needs no
-- join, and a NULL id beside a non-NULL stamp is the unambiguous
-- "the thing you priced was deleted" signal that blocks acceptance.
ALTER TABLE quote_lines ADD COLUMN IF NOT EXISTS device_group_name varchar(255);
ALTER TABLE quote_lines ADD COLUMN IF NOT EXISTS site_id uuid;
-- Same reasoning as device_group_name, and load-bearing for a second reason:
-- without it, site_id IS NULL cannot be told apart from "never had a site", and
-- acceptance would build an ORG-WIDE contract line from a site-scoped quote.
ALTER TABLE quote_lines ADD COLUMN IF NOT EXISTS site_name varchar(255);
ALTER TABLE quote_lines ADD COLUMN IF NOT EXISTS included_quantity numeric(12,2);
ALTER TABLE quote_lines ADD COLUMN IF NOT EXISTS overage_mode contract_overage_mode;
ALTER TABLE quote_lines ADD COLUMN IF NOT EXISTS overage_unit_price numeric(12,2);

-- The DB twin of quoteLineDeviceSetIssues. Every conjunct is NULL-SAFE: a CHECK
-- passes on TRUE *or NULL*, so each side of every `=` is a non-null boolean and
-- the CASE is total.
ALTER TABLE quote_lines DROP CONSTRAINT IF EXISTS quote_lines_device_set_chk;
ALTER TABLE quote_lines ADD CONSTRAINT quote_lines_device_set_chk CHECK (
  CASE WHEN contract_line_type IS NULL THEN
    device_roles IS NULL AND device_group_id IS NULL AND device_group_name IS NULL
    AND site_id IS NULL AND site_name IS NULL
    AND included_quantity IS NULL AND overage_mode IS NULL AND overage_unit_price IS NULL
  ELSE
    -- Only the four auto-quantity types; 'flat' and 'manual' have no device set.
    contract_line_type IN ('per_device', 'per_device_role', 'per_device_group', 'per_seat')
    -- A one-time charge has no "each period" for a live count to mean anything,
    -- and a bundle child's quantity belongs to its parent.
    AND recurrence <> 'one_time'
    AND parent_line_id IS NULL
    -- Roles: two-way, non-empty, 1-D, no NULL element, closed vocabulary.
    -- Mirrors contract_lines_device_roles_chk (2026-10-05-100100).
    AND ((device_roles IS NOT NULL) = (contract_line_type = 'per_device_role'))
    AND (device_roles IS NULL OR (
          array_ndims(device_roles) = 1
      AND cardinality(device_roles) > 0
      AND array_position(device_roles, NULL) IS NULL
      AND device_roles <@ ARRAY['workstation','server','printer','router','switch',
                                'firewall','access_point','phone','iot','camera','nas']::text[]
    ))
    -- Group: the stamp is required on a group line and forbidden elsewhere; the
    -- id may be NULL on a group line only after the group was deleted (FK below).
    AND ((device_group_name IS NOT NULL) = (contract_line_type = 'per_device_group'))
    AND (device_group_id IS NULL OR contract_line_type = 'per_device_group')
    -- Site: only on per_device / per_device_role (a group is already a device
    -- set, and site-bound groups exist for the site case — wave 2 decision 6).
    -- A stamped id always carries a stamped name; a name may outlive its id.
    AND (site_id IS NULL OR contract_line_type IN ('per_device', 'per_device_role'))
    AND (site_name IS NULL OR contract_line_type IN ('per_device', 'per_device_role'))
    AND (site_id IS NULL OR site_name IS NOT NULL)
    -- Allowance: the same five conjuncts as contract_lines_allowance_chk.
    AND ((included_quantity IS NULL) = (overage_mode IS NULL))
    AND (included_quantity IS NULL OR included_quantity > 0)
    AND (included_quantity IS NULL OR included_quantity = floor(included_quantity))
    AND ((overage_unit_price IS NOT NULL) = (overage_mode IS NOT DISTINCT FROM 'bill'))
    AND (overage_unit_price IS NULL OR overage_unit_price >= 0)
  END
);

-- Ownership chain. quote_lines has only single-column FKs today, so nothing
-- proves a line's org_id is its quote's org_id. Preflight first: a mismatch is
-- a tenancy fault with no safe automatic fix.
SELECT set_config('breeze.scope', 'system', true);
DO $$ DECLARE n int; BEGIN
  SELECT count(*) INTO n FROM quote_lines ql JOIN quotes q ON q.id = ql.quote_id
    WHERE q.org_id <> ql.org_id;
  IF n > 0 THEN
    RAISE EXCEPTION 'quote_lines: % row(s) carry an org_id that differs from their quote; repair by hand before applying this migration', n;
  END IF;
END $$;

-- DEFERRABLE is load-bearing, not ceremony: updateQuote's org retarget updates
-- quotes.org_id and quote_lines.org_id in SEPARATE statements, and org merge
-- repoints them separately too. The sibling quote_recipients / quote_orders FKs
-- are non-deferrable only because those tables are empty on a draft.
-- The retarget defers THIS constraint BY NAME (SET CONSTRAINTS
-- quote_lines_quote_org_fk DEFERRED), never ALL, so every other deferrable FK
-- in that transaction still fails at the statement that caused it.
-- The target index quotes_id_org_uq already exists (db/schema/quotes.ts:134).
ALTER TABLE quote_lines DROP CONSTRAINT IF EXISTS quote_lines_quote_org_fk;
ALTER TABLE quote_lines ADD CONSTRAINT quote_lines_quote_org_fk
  FOREIGN KEY (quote_id, org_id) REFERENCES quotes (id, org_id)
  ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;

-- SET NULL on the id only: the stamp survives so an accepted quote still says
-- what it priced. deleteDeviceGroup refuses while a draft/sent/viewed quote
-- names the group, so this fires only for terminal quotes and the delete race.
ALTER TABLE quote_lines DROP CONSTRAINT IF EXISTS quote_lines_device_group_org_fk;
ALTER TABLE quote_lines ADD CONSTRAINT quote_lines_device_group_org_fk
  FOREIGN KEY (device_group_id, org_id) REFERENCES device_groups (id, org_id)
  ON DELETE SET NULL (device_group_id) DEFERRABLE INITIALLY IMMEDIATE;

-- Same shape as wave 1's contract_lines_site_org_fk, against the pre-existing
-- sites_id_org_id_uniq index (db/schema/orgs.ts:219).
ALTER TABLE quote_lines DROP CONSTRAINT IF EXISTS quote_lines_site_org_fk;
ALTER TABLE quote_lines ADD CONSTRAINT quote_lines_site_org_fk
  FOREIGN KEY (site_id, org_id) REFERENCES sites (id, org_id)
  ON DELETE SET NULL (site_id) DEFERRABLE INITIALLY IMMEDIATE;

CREATE INDEX IF NOT EXISTS quote_lines_device_group_id_idx
  ON quote_lines (device_group_id) WHERE device_group_id IS NOT NULL;

-- The acceptance hash is VERSIONED, not migrated. Every existing row is 1 by
-- the default, which is the TRUTH — those acceptances were hashed by the v1
-- algorithm — so no signature already given legal weight is re-hashed or
-- invalidated. acceptQuote writes 2; quoteAcceptanceVerify reads this column
-- and never infers a format from the data it is verifying.
ALTER TABLE quote_acceptances ADD COLUMN IF NOT EXISTS hash_version smallint NOT NULL DEFAULT 1;
