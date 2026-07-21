# Network Topology Redesign — Phase 3 (Cytoscape View + Saved Layout) Implementation Plan

> **For agentic workers:** Execute this plan with the `superpowers:subagent-driven-development` skill — one task per subagent, strict TDD (failing test → run-fails → minimal real impl → run-passes → commit), verify each task's `parent`/`HEAD` after it commits.

**Issue:** #1728 — Network Discovery topology view redesign
**Spec:** `docs/superpowers/specs/monitoring/2026-06-22-network-topology-redesign-design.md` (§12 Phase 3)
**Phase:** 3 of 4. Phases 1–2 (measured LLDP/CDP/FDB edges written into `network_topology` with `method`/`confidence`/`interfaceName`/`vlan`; `GET /discovery/topology` already returns those edge fields) are **assumed implemented**.
**Phase 4** (manual nodes, manual edges, edit mode, `topology:write` enforcement on those write routes) is OUT OF SCOPE here — but this phase **introduces the `topology:write` permission and the `PATCH /discovery/topology/layout` route gated by it**, so the permission and its seeding land now.

## Goal

Replace the hand-rolled D3 SVG `NetworkTopologyMap.tsx` with a Cytoscape.js canvas that consumes **saved node positions** (`preset` layout, never auto-layout-every-render), persists drags via a new batch-upsert layout route, styles edges by measured provenance, and degrades honestly when no adjacency exists. Add the `topology_layout` table (org_id-direct, RLS shape 1) with full tenancy wiring.

## Architecture

```
GET  /discovery/topology   → existing payload + NEW `layout` array (saved x/y/pinned)
PATCH /discovery/topology/layout → batch upsert (x,y,pinned=true), requirePermission('topology:write')
        ↓ request db context (org/site server-derived)
topology_layout (org_id, site_id, node_type, node_id, x, y, pinned, updated_by, updated_at)
   UNIQUE (site_id, node_type, node_id) · RLS shape 1 (breeze_has_org_access(org_id))
        ↓
Web · NetworkTopologyMap.tsx (Cytoscape.js)
   preset layout from `layout`; compound nodes (subnet/switch groups, collapsible);
   edge styling by provenance; drag → PATCH (pinned=true); Auto-arrange seeds only never-placed nodes.
```

## Tech Stack

- **API:** Hono + Drizzle (queries only) + hand-written idempotent SQL migration. Request path wrapped in `withDbAccessContext`; writes on the request `db` (org/site server-derived). RLS enforced by Postgres as `breeze_app`.
- **Web:** Astro + React island. `cytoscape` + `cytoscape-fcose` (Auto-arrange of unplaced nodes). Mutations via `runAction`. Tests: Vitest + jsdom (ResizeObserver stubbed).
- **DB:** PostgreSQL, RLS shape 1 (direct `org_id` column → `breeze_has_org_access(org_id)`).

## Global Constraints

- **Node:** prefix every pnpm/vitest invocation with `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH` (default node 23 breaks engine-strict).
- **Migrations:** hand-written idempotent SQL in `apps/api/migrations/`, named `YYYY-MM-DD-<slug>.sql`, applied in `localeCompare` order. The latest shipped migration is `2026-06-28-pam-signer-groups.sql`, so this plan's migration is named **`2026-06-29-topology-layout.sql`** to sort last. No inner `BEGIN;`/`COMMIT;` (`autoMigrate` wraps each file in a transaction). RLS `ENABLE` + `FORCE` + policies in the **same** migration that creates the table. Run `pnpm db:check-drift` after editing schema.
- **New tenant table (`topology_layout`, org_id-direct RLS shape 1):** RLS enable+force+policies; add to `ORG_CASCADE_DELETE_ORDER` in the correct `localeCompare` slot; partner-purge is covered automatically (org cascade runs first per partner-child org); add cleanup of layout rows in the `discovered_asset` DELETE handler; add a real-DB RLS-forge integration test in `apps/api/src/__tests__/integration/*.integration.test.ts`. **No rls-coverage allowlist edit needed** — org_id-direct tables are auto-discovered; the contract test will assert `FORCE ROW LEVEL SECURITY` automatically.
- **Web mutations** go through `runAction` (`apps/web/src/lib/runAction.ts`). Web tests use Vitest + jsdom; **stub `ResizeObserver` per-test** (Cytoscape reads element dimensions in jsdom).
- **Drizzle for queries only** — never `drizzle-kit generate`/`push`.
- **Permission:** add `TOPOLOGY_WRITE: { resource: 'topology', action: 'write' }` (and a read counterpart for consistency) to `packages/shared/src/constants/permissions.ts`, `DEFAULT_PERMISSIONS` in `apps/api/src/db/seed.ts`, and a migration that inserts the grant + assigns it to roles.

---

### Task 1 — `topology_layout` schema + migration (table + RLS shape 1)

**Files**
- `apps/api/src/db/schema/discovery.ts` (add `doublePrecision` import; add `topologyLayout` table)
- `apps/api/migrations/2026-06-29-topology-layout.sql` (new)
- `apps/api/src/db/schema/discovery.test.ts` (new or extend — schema-shape assertion)

**Interfaces**
- **Produces (Drizzle):**
  ```ts
  export const topologyLayout = pgTable('topology_layout', {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => organizations.id),
    siteId: uuid('site_id').notNull().references(() => sites.id),
    nodeType: varchar('node_type', { length: 32 }).notNull(), // 'discovered_asset' | 'manual_node'
    nodeId: uuid('node_id').notNull(),
    x: doublePrecision('x').notNull(),
    y: doublePrecision('y').notNull(),
    pinned: boolean('pinned').notNull().default(false),
    updatedBy: uuid('updated_by').references(() => users.id),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  }, (table) => ({
    siteNodeUnique: uniqueIndex('topology_layout_site_node_unique')
      .on(table.siteId, table.nodeType, table.nodeId),
  }));
  ```
  (LOCKED CONTRACT: `UNIQUE (site_id, node_type, node_id)`.)

**Steps**
- [ ] Add a failing schema-shape test in `apps/api/src/db/schema/discovery.test.ts`:
  ```ts
  import { describe, it, expect } from 'vitest';
  import { getTableConfig } from 'drizzle-orm/pg-core';
  import { topologyLayout } from './discovery';

  describe('topology_layout schema', () => {
    it('has the locked columns and unique index', () => {
      const cfg = getTableConfig(topologyLayout);
      const cols = cfg.columns.map((c) => c.name).sort();
      expect(cols).toEqual(
        ['id', 'node_id', 'node_type', 'org_id', 'pinned', 'site_id', 'updated_at', 'updated_by', 'x', 'y'].sort(),
      );
      const uniq = cfg.indexes.find((i) => i.config.name === 'topology_layout_site_node_unique');
      expect(uniq?.config.columns.map((c: any) => (c as any).name)).toEqual(['site_id', 'node_type', 'node_id']);
    });
  });
  ```
- [ ] Run-fails: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/db/schema/discovery.test.ts` → expected: import error / `topologyLayout` undefined.
- [ ] Add `doublePrecision` to the `drizzle-orm/pg-core` import list at the top of `apps/api/src/db/schema/discovery.ts` (currently imports `pgTable, uuid, varchar, text, timestamp, boolean, jsonb, pgEnum, integer, inet, real, uniqueIndex, index`). Append the `topologyLayout` table definition above (it can live next to `networkTopology` around line 240+). `users` is already imported in this file.
- [ ] Run-passes: same vitest command → green.
- [ ] Write `apps/api/migrations/2026-06-29-topology-layout.sql` (idempotent; no inner BEGIN/COMMIT; RLS shape 1 — direct `org_id`):
  ```sql
  -- topology_layout: saved Cytoscape node positions (Phase 3, issue #1728).
  -- org_id-direct (RLS shape 1): enable+force+policies in this migration.

  CREATE TABLE IF NOT EXISTS topology_layout (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL REFERENCES organizations(id),
    site_id UUID NOT NULL REFERENCES sites(id),
    node_type TEXT NOT NULL,
    node_id UUID NOT NULL,
    x DOUBLE PRECISION NOT NULL,
    y DOUBLE PRECISION NOT NULL,
    pinned BOOLEAN NOT NULL DEFAULT FALSE,
    updated_by UUID REFERENCES users(id),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  -- node_type guard (idempotent drop-then-add)
  DO $$ BEGIN
    ALTER TABLE topology_layout DROP CONSTRAINT IF EXISTS chk_topology_layout_node_type;
    ALTER TABLE topology_layout ADD CONSTRAINT chk_topology_layout_node_type
      CHECK (node_type IN ('discovered_asset','manual_node'));
  END $$;

  -- upsert key (LOCKED: site_id, node_type, node_id)
  CREATE UNIQUE INDEX IF NOT EXISTS topology_layout_site_node_unique
    ON topology_layout (site_id, node_type, node_id);

  -- RLS shape 1: direct org_id → breeze_has_org_access(org_id)
  ALTER TABLE topology_layout ENABLE ROW LEVEL SECURITY;
  ALTER TABLE topology_layout FORCE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS breeze_org_isolation_select ON topology_layout;
  DROP POLICY IF EXISTS breeze_org_isolation_insert ON topology_layout;
  DROP POLICY IF EXISTS breeze_org_isolation_update ON topology_layout;
  DROP POLICY IF EXISTS breeze_org_isolation_delete ON topology_layout;
  CREATE POLICY breeze_org_isolation_select ON topology_layout FOR SELECT
    USING (public.breeze_has_org_access(org_id));
  CREATE POLICY breeze_org_isolation_insert ON topology_layout FOR INSERT
    WITH CHECK (public.breeze_has_org_access(org_id));
  CREATE POLICY breeze_org_isolation_update ON topology_layout FOR UPDATE
    USING (public.breeze_has_org_access(org_id))
    WITH CHECK (public.breeze_has_org_access(org_id));
  CREATE POLICY breeze_org_isolation_delete ON topology_layout FOR DELETE
    USING (public.breeze_has_org_access(org_id));
  ```
- [ ] Run-passes (drift): `export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"; PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm db:check-drift` → no drift between schema and migrations.
- [ ] Commit: `feat(topology): add topology_layout table + RLS (Phase 3, #1728)`.

---

### Task 2 — Tenancy wiring: cascade + asset-delete cleanup

**Files**
- `apps/api/src/services/tenantCascade.ts` (`ORG_CASCADE_DELETE_ORDER`)
- `apps/api/src/routes/discovery.ts` (DELETE `/assets/:id` handler, ~lines 1196–1211)

**Interfaces** — none new; extends existing delete paths.

**Steps**
- [ ] Add a failing test asserting cascade-list membership in `apps/api/src/services/tenantCascade.test.ts` (or the existing cascade unit test file):
  ```ts
  import { ORG_CASCADE_DELETE_ORDER } from './tenantCascade';
  it('includes topology_layout in localeCompare order', () => {
    expect(ORG_CASCADE_DELETE_ORDER).toContain('topology_layout');
    const sorted = [...ORG_CASCADE_DELETE_ORDER].sort((a, b) => a.localeCompare(b));
    // organizations is intentionally last; ignore it for the order check
    const withoutOrgs = ORG_CASCADE_DELETE_ORDER.filter((t) => t !== 'organizations');
    const sortedWithoutOrgs = sorted.filter((t) => t !== 'organizations');
    expect(withoutOrgs).toEqual(sortedWithoutOrgs);
  });
  ```
- [ ] Run-fails: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/services/tenantCascade.test.ts` → expected: `toContain('topology_layout')` fails.
- [ ] Insert `'topology_layout'` into `ORG_CASCADE_DELETE_ORDER` (a frozen string array) at the correct `localeCompare` slot. `'topology_layout'` sorts after `'time_entries'`/`'tickets'`-family entries and before `'update_rings'`/`'users'`-family entries — place it immediately before the first entry that `localeCompare`-sorts after it (e.g. before `'topology_manual_nodes'` if a Phase-4 placeholder is already present, otherwise alphabetically among the `t…` block). Verify with the round-trip sort test above (do NOT eyeball — see MEMORY: prefix-extension siblings sort non-adjacently).
- [ ] Run-passes: same vitest command → green.
- [ ] **Partner-purge:** No code change required — `cascadeDeletePartner` deletes each child org via `cascadeDeleteOrg` first (which walks `ORG_CASCADE_DELETE_ORDER`), so `topology_layout` is purged automatically once it's in the org-cascade list. Add a one-line comment-confirmation only; no test (covered by the integration cascade test in Task 3).
- [ ] **Asset-delete cleanup:** In `apps/api/src/routes/discovery.ts`, the DELETE `/assets/:id` handler runs a `db.transaction(async (tx) => { ... })` that deletes `snmpMetrics`, `snmpAlertThresholds`, `snmpDevices`, `networkMonitors`, then `discoveredAssets`. Add a failing route test (or extend the discovery route test) asserting layout rows for that asset are deleted, then add **before** the final `discoveredAssets` delete:
  ```ts
  await tx.delete(topologyLayout).where(
    and(
      eq(topologyLayout.orgId, existing.orgId),
      eq(topologyLayout.nodeType, 'discovered_asset'),
      eq(topologyLayout.nodeId, assetId),
    ),
  );
  ```
  Import `topologyLayout` from `../db/schema` in the route file.
- [ ] Run-passes: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/routes/discovery.test.ts` → green.
- [ ] Commit: `feat(topology): cascade + asset-delete cleanup for topology_layout (#1728)`.

---

### Task 3 — RLS-forge integration test (real DB)

**Files**
- `apps/api/src/__tests__/integration/topology-layout-rls.integration.test.ts` (new)

**Interfaces** — none; verifies RLS as `breeze_app`.

**Steps**
- [ ] Write the integration test (real-DB, runs under `breeze_app` per the integration config that injects `../../.env.test`). Re-seed fixtures per `it` (never memoize — TRUNCATE CASCADE wipes module-scope fixtures); include a system-scope existence probe so a vacuous BYPASSRLS pass is impossible:
  ```ts
  import { describe, it, expect, beforeEach } from 'vitest';
  import { sql } from 'drizzle-orm';
  import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
  // seed helpers: createOrg/createSite/etc. per the integration test convention

  describe('topology_layout RLS (breeze_app forge)', () => {
    let orgA: string, siteA: string, orgB: string;
    beforeEach(async () => {
      // seed two orgs + one site each via withSystemDbAccessContext; capture ids
    });

    it('denies cross-tenant INSERT (forge org B row from org A context)', async () => {
      await expect(
        withDbAccessContext(orgAContext, async () => {
          await db.execute(sql`
            INSERT INTO topology_layout (org_id, site_id, node_type, node_id, x, y, pinned)
            VALUES (${orgB}::uuid, ${siteA}::uuid, 'discovered_asset', gen_random_uuid(), 1, 1, true)
          `);
        }),
      ).rejects.toThrow(/row-level security/);
    });

    it('allows same-tenant INSERT + SELECT, and org B cannot read org A rows', async () => {
      // INSERT under orgAContext (org_id=orgA) succeeds
      // SELECT under orgBContext returns 0 rows
      // system-scope SELECT confirms the row physically exists (non-vacuous)
    });
  });
  ```
  Model the context builders / seed helpers on a sibling test such as `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` and other `*-rls.integration.test.ts` files.
- [ ] Run-fails first iteration (write the assertion before confirming the policy name) — then Run-passes:
  `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/topology-layout-rls.integration.test.ts` → cross-tenant insert rejected with `new row violates row-level security policy`; same-tenant insert/select passes; org B read empty; system probe non-empty.
- [ ] Also confirm the auto-discovery contract is green: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/rls-coverage.integration.test.ts` and `…/tenantCascade.integration.test.ts` → both pass (topology_layout auto-discovered with FORCE RLS + present in cascade order).
- [ ] Commit: `test(topology): RLS forge + cascade integration coverage for topology_layout (#1728)`.

---

### Task 4 — `topology:write` permission (shared registry + seed + migration)

**Files**
- `packages/shared/src/constants/permissions.ts`
- `apps/api/src/db/seed.ts` (`DEFAULT_PERMISSIONS`)
- `apps/api/migrations/2026-06-29-b-topology-write-permission.sql` (new; `-b-` infix so it sorts after the table migration it depends on referencing `roles`/`permissions`)

**Interfaces**
- **Produces:** `PERMISSION_GRANTS.TOPOLOGY_READ = { resource: 'topology', action: 'read' }` and `PERMISSION_GRANTS.TOPOLOGY_WRITE = { resource: 'topology', action: 'write' }`.

**Steps**
- [ ] Add a failing test in `packages/shared/src/constants/permissions.test.ts` (or create it):
  ```ts
  import { PERMISSION_GRANTS } from './permissions';
  it('exposes topology grants', () => {
    expect(PERMISSION_GRANTS.TOPOLOGY_WRITE).toEqual({ resource: 'topology', action: 'write' });
    expect(PERMISSION_GRANTS.TOPOLOGY_READ).toEqual({ resource: 'topology', action: 'read' });
  });
  ```
- [ ] Run-fails: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/shared exec vitest run src/constants/permissions.test.ts` → undefined grants.
- [ ] Add to `PERMISSION_GRANTS` in `packages/shared/src/constants/permissions.ts` (after the Devices block):
  ```ts
    // Network topology (discovery topology view + saved layout — #1728)
    TOPOLOGY_READ: { resource: 'topology', action: 'read' },
    TOPOLOGY_WRITE: { resource: 'topology', action: 'write' },
  ```
- [ ] Run-passes (shared typecheck — `@breeze/shared` has no build, use typecheck/vitest): same vitest command → green; also `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/shared typecheck`.
- [ ] Add the two grants to `DEFAULT_PERMISSIONS` in `apps/api/src/db/seed.ts`:
  ```ts
    { resource: 'topology', action: 'read', description: 'View network topology and saved layout' },
    { resource: 'topology', action: 'write', description: 'Persist topology node layout (drag-to-save)' },
  ```
- [ ] Write `apps/api/migrations/2026-06-29-b-topology-write-permission.sql` (idempotent insert of grants + role assignment; pattern lifted from `2026-05-02-report-permissions.sql`):
  ```sql
  -- topology:read / topology:write grants + role assignment (#1728)
  DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM permissions WHERE resource='topology' AND action='read') THEN
      INSERT INTO permissions (resource, action, description)
      VALUES ('topology','read','View network topology and saved layout');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM permissions WHERE resource='topology' AND action='write') THEN
      INSERT INTO permissions (resource, action, description)
      VALUES ('topology','write','Persist topology node layout (drag-to-save)');
    END IF;
  END $$;

  DO $$
  DECLARE
    role_name text;
    perm_key text;
    v_permission_id uuid;
    v_role_id uuid;
    role_permissions_map jsonb := '{
      "Partner Admin": ["topology:read","topology:write"],
      "Partner Technician": ["topology:read"],
      "Org Admin": ["topology:read","topology:write"],
      "Org Technician": ["topology:read","topology:write"],
      "Org Viewer": ["topology:read"]
    }'::jsonb;
  BEGIN
    FOR role_name IN SELECT jsonb_object_keys(role_permissions_map) LOOP
      SELECT id INTO v_role_id FROM roles WHERE name = role_name LIMIT 1;
      IF v_role_id IS NULL THEN CONTINUE; END IF;
      FOR perm_key IN SELECT jsonb_array_elements_text(role_permissions_map -> role_name) LOOP
        SELECT id INTO v_permission_id FROM permissions
          WHERE resource = split_part(perm_key,':',1) AND action = split_part(perm_key,':',2) LIMIT 1;
        IF v_permission_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM role_permissions
          WHERE role_id = v_role_id AND permission_id = v_permission_id
        ) THEN
          INSERT INTO role_permissions (role_id, permission_id) VALUES (v_role_id, v_permission_id);
        END IF;
      END LOOP;
    END LOOP;
  END $$;
  ```
  (Confirm the exact role names against `seed.ts`/an existing permission migration before committing — use whatever role names that repo's seed uses; the map keys must match `roles.name` verbatim or the insert silently CONTINUEs.)
- [ ] Run-passes (drift): `export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"; PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm db:check-drift` → clean (no schema change, only data migration — drift unaffected).
- [ ] Commit: `feat(rbac): add topology:read/topology:write permission (#1728)`.

---

### Task 5 — Extend `GET /discovery/topology` with `layout` array

**Files**
- `apps/api/src/routes/discovery.ts` (topology GET handler, ~lines 1229–1292)
- `apps/api/src/routes/discovery.test.ts`

**Interfaces**
- **Consumes:** existing `topologyQuerySchema = z.object({ orgId: z.string().guid().optional() })`; `resolveOrgId(auth, query.orgId)`.
- **Produces (LOCKED CONTRACT — payload gains):**
  ```ts
  layout: {
    nodeType: 'discovered_asset' | 'manual_node';
    nodeId: string;
    x: number;
    y: number;
    pinned: boolean;
  }[]
  ```

**Steps**
- [ ] Add a failing route test in `apps/api/src/routes/discovery.test.ts` asserting the GET response includes a `layout` array mapped from `topology_layout` rows (mock the `db.select().from(topologyLayout)` chain in the Drizzle mock; assert `body.layout[0]` shape = `{ nodeType, nodeId, x, y, pinned }`).
- [ ] Run-fails: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/routes/discovery.test.ts` → expected: `layout` undefined.
- [ ] In the GET `/topology` handler, after fetching `assets`/`edges`/`subnets`, fetch saved positions (org-scoped, mirroring the existing `edges` query):
  ```ts
  const layoutRows = orgResult.orgId
    ? await db.select().from(topologyLayout).where(eq(topologyLayout.orgId, orgResult.orgId))
    : await db.select().from(topologyLayout);
  ```
  and add to the `c.json({...})` payload:
  ```ts
  layout: layoutRows.map((l) => ({
    nodeType: l.nodeType as 'discovered_asset' | 'manual_node',
    nodeId: l.nodeId,
    x: l.x,
    y: l.y,
    pinned: l.pinned,
  })),
  ```
  Import `topologyLayout` from `../db/schema`.
- [ ] Run-passes: same vitest command → green.
- [ ] Commit: `feat(topology): GET /discovery/topology returns saved layout (#1728)`.

---

### Task 6 — `PATCH /discovery/topology/layout` (batch upsert, drag-to-save)

**Files**
- `apps/api/src/routes/discovery.ts` (new route + new `requireTopologyWrite` gate + `layoutPatchSchema`)
- `apps/api/src/routes/discovery.test.ts`

**Interfaces**
- **Consumes (LOCKED CONTRACT — request body):**
  ```ts
  layoutPatchSchema = z.object({
    siteId: z.string().guid(),
    orgId: z.string().guid().optional(),
    positions: z.array(z.object({
      nodeType: z.enum(['discovered_asset', 'manual_node']),
      nodeId: z.string().guid(),
      x: z.number().finite(),
      y: z.number().finite(),
    })).min(1).max(2000),
  });
  ```
  > Note: the LOCKED body contract is `{ positions: [...] }`. `siteId` is required to scope the upsert and is server-validated against the caller's site access; `orgId` is server-derived via `resolveOrgId` (optional, defaulted from auth). The plan adds `siteId` to the body because layout rows are unique per `(site_id, node_type, node_id)` and the site is not otherwise derivable from a bare position list.
- **Produces:** `200 { upserted: number }`. Each upsert sets `pinned = true`, `updatedBy = auth.user.id`, `updatedAt = now()`.
- **Gate:** `requirePermission('topology', 'write')` (i.e. `requirePermission(PERMISSIONS.TOPOLOGY_WRITE.resource, PERMISSIONS.TOPOLOGY_WRITE.action)`), plus `requireScope('organization','partner','system')`, plus site-access check via `canAccessSite(perms, siteId)`.

**Steps**
- [ ] Add a failing route test asserting: (a) without `topology:write` permission → 403; (b) with permission, valid body → 200, and the upsert is keyed on `(site_id, node_type, node_id)` with `pinned=true` and `updated_by=auth.user.id`; (c) a `siteId` the caller can't access → 403.
- [ ] Run-fails: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/routes/discovery.test.ts` → route 404 / not found.
- [ ] Add the gate near the other `requireDiscovery*` consts:
  ```ts
  const requireTopologyWrite = requirePermission(
    PERMISSIONS.TOPOLOGY_WRITE.resource,
    PERMISSIONS.TOPOLOGY_WRITE.action,
  );
  ```
- [ ] Add `layoutPatchSchema` near `topologyQuerySchema`, then register the route after the GET `/topology` route:
  ```ts
  discoveryRoutes.patch(
    '/topology/layout',
    requireScope('organization', 'partner', 'system'),
    requireTopologyWrite,
    zValidator('json', layoutPatchSchema),
    async (c) => {
      const auth = c.get('auth');
      const body = c.req.valid('json');
      const perms = c.get('permissions');
      const orgResult = resolveOrgId(auth, body.orgId, true);
      if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);
      if (perms?.allowedSiteIds && !canAccessSite(perms, body.siteId)) {
        return c.json({ error: 'Access to this site denied' }, 403);
      }
      // request db context (org/site server-derived); writes on the request `db`
      let upserted = 0;
      await db.transaction(async (tx) => {
        for (const p of body.positions) {
          await tx
            .insert(topologyLayout)
            .values({
              orgId: orgResult.orgId!,
              siteId: body.siteId,
              nodeType: p.nodeType,
              nodeId: p.nodeId,
              x: p.x,
              y: p.y,
              pinned: true,
              updatedBy: auth.user.id,
            })
            .onConflictDoUpdate({
              target: [topologyLayout.siteId, topologyLayout.nodeType, topologyLayout.nodeId],
              set: { x: p.x, y: p.y, pinned: true, updatedBy: auth.user.id, updatedAt: new Date() },
            });
          upserted += 1;
        }
      });
      return c.json({ upserted });
    },
  );
  ```
  > The handler runs on the request path: the surrounding middleware already establishes `withDbAccessContext`, so writes on the request `db`/`tx` are RLS-scoped to the caller (org/site server-derived). Do NOT use a bare/system pool here (avoids the silent 0-row-write class).
- [ ] Run-passes: same vitest command → green.
- [ ] Commit: `feat(topology): PATCH /discovery/topology/layout drag-to-save (#1728)`.

---

### Task 7 — Add Cytoscape dependencies to web

**Files**
- `apps/web/package.json`
- `pnpm-lock.yaml` (regenerated by install)

**Interfaces** — none.

**Steps**
- [ ] Add to `apps/web/package.json` `dependencies` (caret pinning matches the repo's `d3`/`recharts` style; pin to the latest 3.x / 2.x at implementation time):
  ```json
  "cytoscape": "^3.30.0",
  "cytoscape-fcose": "^2.2.0",
  ```
  And to `devDependencies`:
  ```json
  "@types/cytoscape": "^3.21.0",
  ```
- [ ] Install: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm install` (updates the root lockfile; verify no `ERR_PNPM_BROKEN_LOCKFILE`).
- [ ] Run-passes (sanity import resolves): `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/web exec vitest run` (existing suite still green; no behavior change yet).
- [ ] Commit: `chore(web): add cytoscape + cytoscape-fcose deps (#1728)`.

---

### Task 8 — Rewrite `NetworkTopologyMap.tsx` onto Cytoscape.js

**Files**
- `apps/web/src/components/discovery/NetworkTopologyMap.tsx` (REWRITE)
- `apps/web/src/components/discovery/NetworkTopologyMap.test.tsx` (extend existing)

**Interfaces**
- **Props (UNCHANGED contract — `DiscoveryPage.tsx` passes only `onNodeClick`):**
  ```ts
  type NetworkTopologyMapProps = {
    height?: number;                       // default 560
    onNodeClick?: (nodeId: string) => void;
  };
  ```
- **Consumes:** `GET /discovery/topology` → `{ nodes, edges, subnets, layout }`. Edge fields available: `method` (`'lldp'|'cdp'|'fdb'|'manual'`), `confidence` (`'high'|'medium'|'asserted'`), `interfaceName`, `vlan` (Phase 1–2). `layout[]` (Task 5).
- **Produces:** Cytoscape canvas; on node drag-free → `runAction` PATCH to `/discovery/topology/layout` with `{ siteId, positions:[{nodeType:'discovered_asset', nodeId, x, y}] }`.

**Steps**
- [ ] Extend the existing `NetworkTopologyMap.test.tsx` with **failing** assertions (keep its `vi.mock('../../stores/auth', () => ({ fetchWithAuth }))` pattern; add a per-test ResizeObserver stub in `beforeEach`):
  ```ts
  beforeEach(() => {
    vi.clearAllMocks();
    if (!window.ResizeObserver) {
      window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as any;
    }
  });
  ```
  New assertions: (a) renders a `data-testid="topology-cytoscape"` mount container; (b) keeps the honest degraded note `data-testid="topology-adjacency-note"` when `edges` is empty; (c) renders an "Auto-arrange" button `data-testid="topology-auto-arrange"`; (d) when the response carries a `layout` row, the component initializes Cytoscape with a `preset` layout (assert via a spy on the cytoscape factory mock — see note below). Mock `cytoscape` itself:
  ```ts
  vi.mock('cytoscape', () => {
    const cy = { on: vi.fn(), nodes: vi.fn(() => ({ length: 0, positions: vi.fn() })), layout: vi.fn(() => ({ run: vi.fn() })), destroy: vi.fn(), add: vi.fn(), elements: vi.fn(() => ({ remove: vi.fn() })), fit: vi.fn() };
    const factory: any = vi.fn(() => cy);
    factory.use = vi.fn();
    return { default: factory };
  });
  vi.mock('cytoscape-fcose', () => ({ default: vi.fn() }));
  ```
- [ ] Run-fails: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/web exec vitest run src/components/discovery/NetworkTopologyMap.test.tsx` → fails (no cytoscape mount, no auto-arrange button).
- [ ] Rewrite `NetworkTopologyMap.tsx`. Real implementation requirements (no placeholders):
  - Keep imports of `fetchWithAuth` and `runAction` (`import { runAction } from '@/lib/runAction'` or relative). Remove `d3`.
  - `import cytoscape from 'cytoscape'; import fcose from 'cytoscape-fcose'; cytoscape.use(fcose);` (register once at module scope, guarded).
  - Fetch `/discovery/topology`; keep `nodes`/`edges`/`subnets` mapping; additionally read `data.layout` into a `Map<string, {x,y,pinned}>` keyed by `nodeId`.
  - Build Cytoscape elements: each node → `{ data: { id, label, type, status }, position: layout.get(id) ?? undefined }`. Compound parents for subnet/switch groups: synthesize parent nodes (`{ data: { id: 'group:'+subnet, label: subnet } }`) and set child `data.parent`. Infra nodes (`router/switch/firewall/access_point`) styled as hubs (larger, distinct shape).
  - **Edge styling by provenance** (Cytoscape stylesheet selectors keyed on `data(method)`/`data(confidence)`):
    - `lldp`/`cdp` (high) → solid blue (`line-color: #2563eb`, `line-style: solid`).
    - `fdb` (medium) → solid green (`line-color: #16a34a`, `line-style: solid`).
    - `manual` (asserted) → dashed orange (`line-color: #f97316`, `line-style: dashed`). (Manual edges won't appear until Phase 4 but the style ships now.)
  - **Layout:** initialize with `{ name: 'preset' }` (consume saved positions). Do NOT run an auto-layout on every render. Only nodes with no saved position need seeding.
  - **Drag persistence:** `cy.on('dragfree', 'node', (evt) => { ... })` → collect the dragged node's `{ id, position }`, then:
    ```ts
    await runAction({
      request: () => fetchWithAuth('/discovery/topology/layout', {
        method: 'PATCH',
        body: JSON.stringify({ siteId, positions: [{ nodeType: 'discovered_asset', nodeId: id, x, y }] }),
      }),
      errorFallback: 'Failed to save node position',
      onUnauthorized: () => { /* let auth redirect handle it */ },
    });
    ```
    (`siteId` must be available to the component — see Task 9; if a single site is in scope, derive it from the topology payload / discovery context.)
  - **Auto-arrange button:** runs `fcose` (or `dagre`) **only over never-placed nodes** — lock pinned/positioned nodes first (`cy.nodes().filter(n => placed.has(n.id())).lock()`), run the layout on the remainder, then `unlock()`. Do not disturb pinned positions.
  - **Honest degraded state retained:** keep `data-testid="topology-adjacency-note"` with the existing copy when `edges.length === 0`; still render a useful subnet-grouped layout.
  - **Guard the Cytoscape import / malformed layout rows** so a bad `layout` row can't crash the canvas (skip non-finite x/y).
  - `useEffect` cleanup calls `cy.destroy()`.
- [ ] Run-passes: same vitest command → green.
- [ ] Commit: `feat(topology): rewrite NetworkTopologyMap on Cytoscape.js (#1728)`.

---

### Task 9 — Wire `siteId` into the layout PATCH from the view

**Files**
- `apps/web/src/components/discovery/NetworkTopologyMap.tsx`
- `apps/web/src/components/discovery/DiscoveryPage.tsx` (only if a `siteId` prop must be threaded through)

**Interfaces**
- The PATCH body requires `siteId`. The topology GET payload is org-scoped and may span sites; layout rows are unique per `(site_id, node_type, node_id)`. Resolve the site per node: include each node's `siteId` in the GET `/discovery/topology` node payload (extend the node mapping in the route to add `siteId: a.siteId`) so the component sends the dragged node's own `siteId`.

**Steps**
- [ ] Add a failing API route test asserting `body.nodes[0].siteId` is present in the GET topology response.
- [ ] Run-fails: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/routes/discovery.test.ts`.
- [ ] In the GET `/topology` handler node mapping, add `siteId: a.siteId` to each node object.
- [ ] Run-passes: same command → green.
- [ ] In `NetworkTopologyMap.tsx`, store each node's `siteId` and send the dragged node's `siteId` in the PATCH `positions` payload (one PATCH per drag carries a single node, so a single `siteId` is correct). Update the Task-8 web test mock data to include `siteId` per node and assert the PATCH body carries it.
- [ ] Run-passes (web): `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/web exec vitest run src/components/discovery/NetworkTopologyMap.test.tsx` → green.
- [ ] Commit: `feat(topology): thread siteId through topology payload + layout save (#1728)`.

---

### Task 10 — Final verification sweep

**Steps**
- [ ] API unit: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/routes/discovery.test.ts src/services/tenantCascade.test.ts src/db/schema/discovery.test.ts` → green.
- [ ] API integration (real DB): `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/topology-layout-rls.integration.test.ts src/__tests__/integration/rls-coverage.integration.test.ts src/__tests__/integration/tenantCascade.integration.test.ts` → green (RLS forge denies cross-tenant; auto-discovery + cascade contracts pass).
- [ ] Shared: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/shared exec vitest run src/constants/permissions.test.ts && pnpm --filter @breeze/shared typecheck`.
- [ ] Web: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/web exec vitest run src/components/discovery/NetworkTopologyMap.test.tsx`.
- [ ] Drift: `export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"; PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm db:check-drift` → clean.
- [ ] Typecheck (catch `.astro` + TS): `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api typecheck && pnpm --filter @breeze/web typecheck`.
- [ ] Manual forge (per CLAUDE.md): `docker exec -it breeze-postgres psql -U breeze_app -d breeze` → attempt a cross-tenant `INSERT INTO topology_layout (...)` → must fail with `new row violates row-level security policy`.
- [ ] Manual UI smoke: in the Discovery → Topology tab, drag a node, reload, confirm the position persists (pinned). Confirm "Auto-arrange" only moves never-placed nodes. Confirm the honest degraded note still shows when no measured edges exist.

---

## Out of scope (Phase 4)

`topology_manual_nodes`, manual edges, edit-mode palette/drag-to-connect, and `requirePermission('topology:write')` on those manual write routes. (`topology:write` itself ships in this phase for the layout route.)
