-- 2026-07-09: Linked device profiles for multi-boot systems (#2138).
--
-- A physical machine that dual/multi-boots runs one Breeze agent per OS, so it
-- surfaces as several device records — only one can be online at a time. This
-- adds a NON-destructive link: two or more device records grouped as boot
-- profiles of one physical machine. Each device record stays fully separate
-- (inventory, software, scripts, command history, audit, telemetry all
-- preserved); the group is a UI/monitoring overlay, not a merge.
--
-- Model: a `device_link_groups` parent row (Shape 1, direct org_id) plus a
-- nullable `devices.link_group_id` FK. Membership IS the column on devices —
-- one group per device — so there is no membership child table to cascade and
-- no denormalized org_id to keep in sync on move-org. All members of a group
-- share the group's org, enforced STRUCTURALLY by the composite FK
-- devices(link_group_id, org_id) -> device_link_groups(id, org_id): a device's
-- org must equal its group's org, so every member of a group is same-org. This
-- is the CRITICAL tenant-isolation invariant for the feature.
--
-- Tenancy: device_link_groups carries a direct org_id with the four standard
-- breeze_has_org_access policies, so the rls-coverage contract test
-- auto-discovers it — no allowlist entry needed. tenantCascade adds it to the
-- org-erasure sweep (the topo-sort deletes `devices` first since devices
-- references the group).
--
-- Idempotent: CREATE TABLE/INDEX/COLUMN IF NOT EXISTS, DO-guarded constraint,
-- DROP POLICY IF EXISTS before each CREATE. autoMigrate wraps the file in one
-- transaction — no inner BEGIN/COMMIT.

CREATE TABLE IF NOT EXISTS device_link_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  -- What the link MEANS. 'multiboot' (v1): members are peer boot profiles of
  -- one physical machine. Reserved future value: 'vm_host' (VM guests nested
  -- under their host server) — schema accommodation only, not built yet. A
  -- future kind with asymmetric members adds a member-role column on devices;
  -- multiboot members are all peers so none exists today.
  kind varchar(32) NOT NULL DEFAULT 'multiboot',
  -- Optional operator label for the physical machine (e.g. "Todd's ThinkPad").
  -- NULL is fine; the UI shows a generic "Linked boot profiles" heading.
  name varchar(255),
  created_by uuid REFERENCES users(id),
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

-- Idempotent for DBs that applied a pre-kind build of this migration.
ALTER TABLE device_link_groups ADD COLUMN IF NOT EXISTS kind varchar(32) NOT NULL DEFAULT 'multiboot';

CREATE INDEX IF NOT EXISTS device_link_groups_org_id_idx ON device_link_groups(org_id);

-- Composite unique so `devices` can carry a (link_group_id, org_id) FK that pins
-- every member to the group's org. `id` is already unique (PK); this just
-- exposes (id, org_id) as a valid FK target.
CREATE UNIQUE INDEX IF NOT EXISTS device_link_groups_id_org_id_uniq
  ON device_link_groups(id, org_id);

-- Membership column on devices. NULL => unlinked (the default for every device).
ALTER TABLE devices ADD COLUMN IF NOT EXISTS link_group_id uuid;

CREATE INDEX IF NOT EXISTS devices_link_group_id_idx ON devices(link_group_id);

-- Composite FK: a linked device's org must equal its group's org (same-org
-- invariant). MATCH SIMPLE (the default) means the FK is NOT enforced while
-- link_group_id is NULL, so unlinked devices are entirely unaffected. No
-- ON DELETE action: group deletion nulls its members in application code before
-- deleting the row, keeping this portable across Postgres versions (no reliance
-- on column-list ON DELETE SET NULL, which is PG15+).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'devices_link_group_id_org_id_fkey'
  ) THEN
    ALTER TABLE devices
      ADD CONSTRAINT devices_link_group_id_org_id_fkey
      FOREIGN KEY (link_group_id, org_id)
      REFERENCES device_link_groups(id, org_id);
  END IF;
END $$;

-- RLS: direct org_id (Shape 1) — standard org isolation.
ALTER TABLE device_link_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_link_groups FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON device_link_groups;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON device_link_groups;
DROP POLICY IF EXISTS breeze_org_isolation_update ON device_link_groups;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON device_link_groups;

CREATE POLICY breeze_org_isolation_select ON device_link_groups FOR SELECT USING (
  public.breeze_has_org_access(org_id)
);
CREATE POLICY breeze_org_isolation_insert ON device_link_groups FOR INSERT WITH CHECK (
  public.breeze_has_org_access(org_id)
);
CREATE POLICY breeze_org_isolation_update ON device_link_groups FOR UPDATE USING (
  public.breeze_has_org_access(org_id)
) WITH CHECK (
  public.breeze_has_org_access(org_id)
);
CREATE POLICY breeze_org_isolation_delete ON device_link_groups FOR DELETE USING (
  public.breeze_has_org_access(org_id)
);
