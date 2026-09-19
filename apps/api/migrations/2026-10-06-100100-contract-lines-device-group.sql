-- #3205 W02: contract lines billed by device group — columns, invariant, FKs.
-- Companion to 2026-10-06-100000-contract-line-type-per-device-group.sql (enum value).

-- Composite-FK target. device_groups has only its PK today; the (id, org_id)
-- pair is what lets a referencing row prove the group is in its own org.
CREATE UNIQUE INDEX IF NOT EXISTS device_groups_id_org_id_uniq ON device_groups (id, org_id);

ALTER TABLE contract_lines ADD COLUMN IF NOT EXISTS device_group_id uuid;
-- Stamped at line creation. Survives group deletion (the FK nulls only the id)
-- so a terminated contract's line still says what it billed.
ALTER TABLE contract_lines ADD COLUMN IF NOT EXISTS device_group_name varchar(255);

-- Exactly: group lines carry a stamped name and no site; every other type
-- carries neither group column. device_group_id may be NULL on a group line
-- only after its group was deleted (see the FK below). The DB twin of
-- contractLineInputSchema (packages/shared/src/validators/contracts.ts).
-- (contract_lines_device_roles_chk already forces device_roles to NULL here.)
ALTER TABLE contract_lines DROP CONSTRAINT IF EXISTS contract_lines_device_group_chk;
ALTER TABLE contract_lines ADD CONSTRAINT contract_lines_device_group_chk CHECK (
  CASE WHEN line_type = 'per_device_group'
    THEN device_group_name IS NOT NULL AND site_id IS NULL
    ELSE device_group_id IS NULL AND device_group_name IS NULL END
);

-- ON DELETE SET NULL (device_group_id), not RESTRICT: lines on cancelled or
-- expired contracts cannot be removed (assertEditable), so RESTRICT would pin a
-- group forever once any terminated contract had billed it. The delete service
-- (services/deviceGroupDelete.ts) refuses while a draft/active/paused contract
-- bills the group; the FK only ever nulls lines of terminated contracts.
-- DEFERRABLE INITIALLY IMMEDIATE: org merge runs SET CONSTRAINTS ALL DEFERRED
-- and re-points parent and child org_id in separate statements
-- (orgLifecycleFoundations.integration.test.ts, "merge contract").
ALTER TABLE contract_lines DROP CONSTRAINT IF EXISTS contract_lines_device_group_org_fk;
ALTER TABLE contract_lines ADD CONSTRAINT contract_lines_device_group_org_fk
  FOREIGN KEY (device_group_id, org_id) REFERENCES device_groups (id, org_id)
  ON DELETE SET NULL (device_group_id) DEFERRABLE INITIALLY IMMEDIATE;

CREATE INDEX IF NOT EXISTS contract_lines_device_group_id_idx
  ON contract_lines (device_group_id) WHERE device_group_id IS NOT NULL;

-- Contract/org chain. The single-column contract FK stays (Drizzle declares
-- it); this composite one proves the line's org_id is its contract's org_id,
-- because generation selects lines by contract_id alone.
-- contract_lines is ENABLE + FORCE ROW LEVEL SECURITY and autoMigrate sets no
-- scope, so without the system scope the preflight below would count 0 rows on
-- managed Postgres (non-superuser admin) and the FK would then abort boot on the
-- rows it never saw. is_local = true scopes it to this file's transaction.
SELECT set_config('breeze.scope', 'system', true);
DO $$ DECLARE n int; BEGIN
  SELECT count(*) INTO n FROM contract_lines cl JOIN contracts c ON c.id = cl.contract_id
    WHERE c.org_id <> cl.org_id;
  IF n > 0 THEN
    RAISE EXCEPTION 'contract_lines: % row(s) carry an org_id that differs from their contract; repair by hand before applying this migration', n;
  END IF;
END $$;
ALTER TABLE contract_lines DROP CONSTRAINT IF EXISTS contract_lines_contract_org_fk;
ALTER TABLE contract_lines ADD CONSTRAINT contract_lines_contract_org_fk
  FOREIGN KEY (contract_id, org_id) REFERENCES contracts (id, org_id)
  ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
