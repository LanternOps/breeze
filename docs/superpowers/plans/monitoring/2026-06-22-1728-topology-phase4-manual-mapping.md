# Network Topology Redesign — Phase 4: Manual Mapping & Edit Mode — Implementation Plan

> **For agentic workers:** This plan is designed to be executed with the **superpowers:subagent-driven-development** skill — each `### Task N` is a self-contained, independently-verifiable unit (failing test → run-fails → minimal real-code impl → run-passes → commit). Execute tasks in order; do not batch-commit. Every code step contains REAL code, not placeholders.

**Issue:** #1728 — Network Discovery topology redesign
**Design spec:** `docs/superpowers/specs/monitoring/2026-06-22-network-topology-redesign-design.md` (§9, §10, §11, §12 Phase 4)
**Scope:** Phase 4 only — `topology_manual_nodes` table, manual node/edge CRUD routes, `topology:write` RBAC, Cytoscape edit mode. Phases 1–3 (provenance columns on `network_topology`, `topology_layout`, Cytoscape `preset` view with saved positions, manual dashed-orange edge style, `PATCH /discovery/topology/layout`) are **assumed implemented**.

## Goal

Let a `topology:write`-holding user hand-map unmanaged network gear: create placeholder nodes, draw manual edges between assets/placeholders, and delete them — persisted in tenant-isolated tables, surfaced in `GET /discovery/topology`, and never touched by scan reconciliation. Measured edges remain read-only (provenance-only). All mutations are RBAC-gated, request-context (org/site server-derived), and surfaced via `runAction`.

## Architecture

```
Web · NetworkTopologyMap.tsx (Cytoscape, Phase 3)
  └─ Edit mode (gated by usePermissions().can('topology','write'))
       add-node palette  → POST   /discovery/topology/manual-node
       drag-to-connect   → POST   /discovery/topology/manual-edge
       select manual edge→ DELETE /discovery/topology/manual-edge/:id
       delete node       → DELETE /discovery/topology/manual-node/:id
       (all via runAction; measured edges read-only)
            ↓ fetchWithAuth (Bearer)
API · apps/api/src/routes/discovery.ts
  requirePermission('topology','write') · request `db` · org/site server-derived
       manual-node  → INSERT topology_manual_nodes (RLS shape-1, org_id-direct)
       manual-edge  → INSERT network_topology {method:'manual', confidence:'asserted', created_by}
       DELETE node  → cascade its manual edges (network_topology) + topology_layout row
       GET /topology→ nodes[] += manual nodes {kind:'manual'}; edges[] += manual edges
            ↓
Postgres (RLS org/site scoped)
  topology_manual_nodes (NEW, RLS enable+force+policies, ORG_CASCADE_DELETE_ORDER, partner-purge)
  network_topology (existing RLS; manual edges reuse it; ux index keeps measured+manual distinct)
```

## Tech Stack

- **API:** Hono + Drizzle (queries only) + Zod (`@hono/zod-validator`). Schema `apps/api/src/db/schema/discovery.ts`; routes `apps/api/src/routes/discovery.ts`. Hand-written idempotent SQL migration in `apps/api/migrations/`.
- **RBAC:** `packages/shared/src/constants/permissions.ts` (`PERMISSION_GRANTS`), `apps/api/src/db/seed.ts` (`DEFAULT_PERMISSIONS`, `SYSTEM_ROLES`), `requirePermission(resource, action)` from `apps/api/src/middleware/auth.ts`.
- **Web:** React island `apps/web/src/components/discovery/NetworkTopologyMap.tsx` (Cytoscape, Phase 3); `usePermissions` (`apps/web/src/lib/permissions.ts`); `runAction`/`ActionError`/`handleActionError` (`apps/web/src/lib/runAction.ts`); `fetchWithAuth` (`apps/web/src/stores/auth`).
- **Tests:** Vitest unit (`apps/api/vitest.config.ts`, `apps/web/vitest.config.ts`); Vitest integration real-DB (`apps/api/vitest.integration.config.ts` → `.env.test` :5433 `breeze_app`); contract tests `rls-coverage.integration.test.ts` + `tenantCascade.integration.test.ts`.

## Global Constraints

- **Node:** prefix every pnpm/vitest invocation with `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH` (default node 23 breaks pnpm engine-strict). Fresh worktrees need `pnpm install`.
- **Migrations:** hand-written idempotent SQL in `apps/api/migrations/`, named `YYYY-MM-DD-<slug>.sql` (lexicographic/localeCompare order). No inner `BEGIN;`/`COMMIT;` (autoMigrate wraps each file in a transaction). RLS `ENABLE`+`FORCE`+policies in the SAME migration that creates the table. Idempotent: `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `pg_policies` existence checks. Never edit a shipped migration. Run `pnpm db:check-drift` after.
- **New tenant table (`topology_manual_nodes`, RLS shape 1 — direct `org_id`):** enable+force+`breeze_has_org_access(org_id)` policies for SELECT/INSERT/UPDATE/DELETE; add to `ORG_CASCADE_DELETE_ORDER` (localeCompare slot) — auto-discovered by both contract tests, no allowlist needed; partner-purge is automatic (org-axis tables purged via per-org `cascadeDeleteOrg`). Verify by forging a cross-tenant insert as `breeze_app` (must fail `new row violates row-level security policy`).
- **Manual edges** live in the existing `network_topology` table and reuse its RLS — no new policy needed, but inserts MUST run on the request `db` (org/site server-derived), never a bare pool (silent 0-row-write class, MEMORY #1375).
- **Web mutations** go through `runAction`; catch with `handleActionError` (or `if (err instanceof ActionError && err.status === 401) return;`). Web tests use vitest+jsdom; **stub `ResizeObserver`** before rendering; mock `fetchWithAuth` via `vi.mock('../../stores/auth')`.
- **Drizzle** for type-safe queries ONLY (no `drizzle-kit generate`/`push`).
- **Real-DB tests** go in `apps/api/src/__tests__/integration/*.integration.test.ts` (BLOCKING integration job, breeze_app, autoMigrate + TRUNCATE-per-test). Run with `--config vitest.integration.config.ts`.
- Commit after each task with a focused message. Do NOT merge/PR within this plan.

---

### Task 1 — Add `topology:write` to the permission registry

> **CROSS-PHASE NOTE (read first):** The `topology:write` permission is **introduced in Phase 3** (its Task 4), because Phase 3's `PATCH /discovery/topology/layout` route is already gated by it. If Phase 3 has landed, **this task is verify-only**: confirm `PERMISSION_GRANTS.TOPOLOGY_WRITE` and the seeded `('topology','write')` row already exist, ensure `Org Admin` carries the grant, and SKIP the duplicate permission migration entirely (the seed already has it). Only perform the full creation below if Phase 3 has **not** landed (e.g. Phase 4 is being executed standalone). Never ship two migrations that insert the same `('topology','write')` permission row.

**Files**
- `packages/shared/src/constants/permissions.ts` (add grant)
- `apps/api/src/db/seed.ts` (`DEFAULT_PERMISSIONS`, `SYSTEM_ROLES`)
- `apps/api/src/db/seed.test.ts` (assertion already enforces `SYSTEM_ROLES ⊆ DEFAULT_PERMISSIONS`)

**Interfaces**
- **Produces:** `PERMISSION_GRANTS.TOPOLOGY_WRITE = { resource: 'topology', action: 'write' }`; a seeded `permissions` row `('topology','write')`; the grant present on `Org Admin` + `Partner Admin` (wildcard) roles.
- **Consumes (downstream tasks):** `requirePermission('topology', 'write')`; web `can('topology','write')`.

Steps:
- [ ] Add the grant to the registry. In `packages/shared/src/constants/permissions.ts`, after the `TIME_ENTRIES_*` block (line ~64, before `// Users`):
  ```typescript
  // Network topology (manual mapping — issue #1728 Phase 4)
  TOPOLOGY_WRITE: { resource: 'topology', action: 'write' },
  ```
- [ ] Add the seed row + role grant test as the FIRST change in seed.test.ts is unnecessary (the existing test auto-iterates). Instead, write a failing assertion in `apps/api/src/db/seed.test.ts` proving the registry/seed wiring. Append inside the existing top-level `describe`:
  ```typescript
  import { DEFAULT_PERMISSIONS } from './seed';

  describe('topology:write permission (issue #1728)', () => {
    it('topology:write is a seeded permission', () => {
      const keys = DEFAULT_PERMISSIONS.map((p) => `${p.resource}:${p.action}`);
      expect(keys).toContain('topology:write');
    });
  });
  ```
  (If `DEFAULT_PERMISSIONS` is already imported in the file, reuse the existing import.)
- [ ] Run — fails: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/db/seed.test.ts`
  Expected: `expected [ ... ] to contain 'topology:write'` (assertion fails; `topology:write` not yet in `DEFAULT_PERMISSIONS`).
- [ ] Add the seed permission row. In `apps/api/src/db/seed.ts`, in `DEFAULT_PERMISSIONS`, after the `time_entries` entries (before `// Users`):
  ```typescript
  // Network topology (manual mapping)
  { resource: 'topology', action: 'write', description: 'Create and delete manual network-topology nodes and edges' },
  ```
- [ ] Grant it to `Org Admin` (and any partner technician role that should map; Partner Admin already has `*:*`). In `SYSTEM_ROLES`, in the `Org Admin` `permissions` array, add `'topology:write',` after the `sites:*` entries.
- [ ] Run — passes: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/db/seed.test.ts`
  Expected: all green, including the existing `role "Org Admin" grant "topology:write" exists in DEFAULT_PERMISSIONS` case.
- [ ] Typecheck shared + api so the closed-union literal compiles everywhere:
  `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/shared typecheck && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api typecheck`
- [ ] Commit: `feat(rbac): add topology:write permission (#1728 phase 4)`

---

### Task 2 — Migration: create `topology_manual_nodes` with RLS (shape 1)

**Files**
- `apps/api/migrations/2026-06-30-topology-manual-nodes.sql` (new) — **date must sort AFTER Phase 1/3 migrations (`2026-06-29-*`) and all existing migrations; use the real current date at implementation time, then re-run `apps/api/src/db/autoMigrate.test.ts`. Do NOT use `2026-06-22` (it sorts before dependencies).**
- `apps/api/src/db/schema/discovery.ts` (add Drizzle table — queries only)

**Interfaces**
- **Produces:** table `topology_manual_nodes(id uuid pk, org_id uuid NOT NULL → organizations, site_id uuid NOT NULL → sites, label text NOT NULL, role text NOT NULL CHECK in enum, notes text NULL, created_by uuid NULL → users, created_at timestamptz, updated_at timestamptz)` with RLS enable+force + `breeze_has_org_access(org_id)` policies; Drizzle export `topologyManualNodes`.
- **Consumes:** existing `public.breeze_has_org_access(uuid)` (from `0008-tenant-rls.sql`).

Steps:
- [ ] Write the failing drift/migration guard test FIRST — a unit assertion that the Drizzle schema exports the table with the locked columns. Create `apps/api/src/db/schema/discovery.topologyManualNodes.test.ts`:
  ```typescript
  import { describe, it, expect } from 'vitest';
  import { getTableColumns } from 'drizzle-orm';
  import { topologyManualNodes } from './discovery';

  describe('topology_manual_nodes schema (#1728 phase 4)', () => {
    it('exposes the locked columns', () => {
      const cols = Object.keys(getTableColumns(topologyManualNodes)).sort();
      expect(cols).toEqual(
        ['createdAt', 'createdBy', 'id', 'label', 'notes', 'orgId', 'role', 'siteId', 'updatedAt'].sort(),
      );
    });
  });
  ```
- [ ] Run — fails: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/db/schema/discovery.topologyManualNodes.test.ts`
  Expected: `Cannot find name 'topologyManualNodes'` / import resolves to undefined → test errors. (`topologyManualNodes` not yet exported.)
- [ ] Add the Drizzle table to `apps/api/src/db/schema/discovery.ts` (after `networkTopology`, queries only — RLS lives in the migration):
  ```typescript
  export const topologyManualNodes = pgTable('topology_manual_nodes', {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id').notNull().references(() => organizations.id),
    siteId: uuid('site_id').notNull().references(() => sites.id),
    label: text('label').notNull(),
    // 'switch' | 'router' | 'ap' | 'firewall' | 'patch_panel' | 'other' — enforced by a CHECK in the migration
    role: text('role').notNull(),
    notes: text('notes'),
    createdBy: uuid('created_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
  });
  ```
  Confirm `text`, `timestamp`, `users` are imported in this file; add to the existing import block if missing.
- [ ] Run — passes: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/db/schema/discovery.topologyManualNodes.test.ts`
- [ ] Write the migration `apps/api/migrations/2026-06-30-topology-manual-nodes.sql` (rename to the real current date so it sorts last; idempotent; no inner BEGIN/COMMIT; RLS in the same file). Mirror the `network_baselines` idiom (`0019-network-baseline-change-events.sql`):
  ```sql
  -- Phase 4 (#1728): manual topology placeholder nodes. RLS shape 1 (org_id-direct).
  CREATE TABLE IF NOT EXISTS public.topology_manual_nodes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id uuid NOT NULL REFERENCES public.organizations(id),
    site_id uuid NOT NULL REFERENCES public.sites(id),
    label text NOT NULL,
    role text NOT NULL,
    notes text,
    created_by uuid REFERENCES public.users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );

  -- Constrain role to the locked enum set (idempotent re-add).
  DO $$ BEGIN
    ALTER TABLE public.topology_manual_nodes DROP CONSTRAINT IF EXISTS topology_manual_nodes_role_chk;
    ALTER TABLE public.topology_manual_nodes
      ADD CONSTRAINT topology_manual_nodes_role_chk
      CHECK (role IN ('switch','router','ap','firewall','patch_panel','other'));
  END $$;

  CREATE INDEX IF NOT EXISTS topology_manual_nodes_org_site_idx
    ON public.topology_manual_nodes (org_id, site_id);

  -- RLS shape 1: enable + force + breeze_has_org_access policies (same migration).
  ALTER TABLE public.topology_manual_nodes ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.topology_manual_nodes FORCE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS breeze_org_isolation_select ON public.topology_manual_nodes;
  DROP POLICY IF EXISTS breeze_org_isolation_insert ON public.topology_manual_nodes;
  DROP POLICY IF EXISTS breeze_org_isolation_update ON public.topology_manual_nodes;
  DROP POLICY IF EXISTS breeze_org_isolation_delete ON public.topology_manual_nodes;
  CREATE POLICY breeze_org_isolation_select ON public.topology_manual_nodes
    FOR SELECT USING (public.breeze_has_org_access(org_id));
  CREATE POLICY breeze_org_isolation_insert ON public.topology_manual_nodes
    FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
  CREATE POLICY breeze_org_isolation_update ON public.topology_manual_nodes
    FOR UPDATE USING (public.breeze_has_org_access(org_id))
    WITH CHECK (public.breeze_has_org_access(org_id));
  CREATE POLICY breeze_org_isolation_delete ON public.topology_manual_nodes
    FOR DELETE USING (public.breeze_has_org_access(org_id));
  ```
- [ ] Apply locally + drift-check (real DB on `DATABASE_URL`):
  ```
  export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze"
  PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm db:check-drift
  ```
  Expected: no drift (Drizzle table matches migration). If drift, reconcile column types (`text` vs `varchar`, `withTimezone`) until clean.
- [ ] Commit: `feat(db): topology_manual_nodes table + RLS shape 1 (#1728 phase 4)`

---

### Task 3 — Cascade + RLS forge integration tests for `topology_manual_nodes`

**Files**
- `apps/api/src/services/tenantCascade.ts` (insert into `ORG_CASCADE_DELETE_ORDER`)
- `apps/api/src/__tests__/integration/topology-manual-nodes-rls.integration.test.ts` (new RLS forge)
- (contract tests `tenantCascade.integration.test.ts` + `rls-coverage.integration.test.ts` auto-cover; no edit needed)

**Interfaces**
- **Produces:** `'topology_manual_nodes'` present in `ORG_CASCADE_DELETE_ORDER` in localeCompare slot; an integration test asserting cross-tenant `breeze_app` INSERT is RLS-rejected and a same-org INSERT under context succeeds.
- **Consumes:** `withDbAccessContext`, `db`, `topologyManualNodes`, integration `setup.ts` fixtures (`createPartner`, `createOrganization`, `createSite`).

Steps:
- [ ] Add the cascade entry FIRST (the contract test enforces presence + ordering). In `apps/api/src/services/tenantCascade.ts`, `ORG_CASCADE_DELETE_ORDER`, insert between `'time_series_metrics',` (line ~286) and `'tunnel_allowlists',` (line ~287):
  ```typescript
  'topology_manual_nodes',
  ```
  (localeCompare: `time_series_metrics` < `topology_manual_nodes` < `tunnel_allowlists` — `ti` < `to` < `tu`.)
- [ ] Write the RLS forge integration test `apps/api/src/__tests__/integration/topology-manual-nodes-rls.integration.test.ts`, mirroring `automation_runs`/`audit-logs-rls` forge idiom:
  ```typescript
  import { describe, it, expect } from 'vitest';
  import { db, withDbAccessContext } from '../../db';
  import { topologyManualNodes } from '../../db/schema/discovery';
  import { createPartner, createOrganization, createSite } from './setup';

  function orgContext(orgId: string) {
    return {
      scope: 'organization' as const,
      orgId,
      accessibleOrgIds: [orgId],
      accessiblePartnerIds: [],
      userId: null,
    };
  }

  describe('topology_manual_nodes RLS (#1728 phase 4)', () => {
    it('rejects an org-B INSERT into org-A scope (cross-tenant forge)', async () => {
      const partner = await createPartner();
      const orgA = await createOrganization({ partnerId: partner.id });
      const orgB = await createOrganization({ partnerId: partner.id });
      const siteA = await createSite({ orgId: orgA.id });

      let caught: unknown;
      try {
        await withDbAccessContext(orgContext(orgB.id), async () =>
          db.insert(topologyManualNodes).values({
            orgId: orgA.id, // forging another tenant's org
            siteId: siteA.id,
            label: 'rogue-switch',
            role: 'switch',
          }),
        );
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeDefined();
      const c = caught as { cause?: { message?: string }; message?: string } | undefined;
      const msg = c?.cause?.message ?? c?.message ?? '';
      expect(msg).toMatch(
        /new row violates row-level security policy for table "topology_manual_nodes"/,
      );
    });

    it('allows a same-org INSERT under matching context, and isolates SELECT', async () => {
      const partner = await createPartner();
      const orgA = await createOrganization({ partnerId: partner.id });
      const orgB = await createOrganization({ partnerId: partner.id });
      const siteA = await createSite({ orgId: orgA.id });

      const [row] = await withDbAccessContext(orgContext(orgA.id), async () =>
        db.insert(topologyManualNodes).values({
          orgId: orgA.id, siteId: siteA.id, label: 'core-sw', role: 'switch',
        }).returning(),
      );
      expect(row?.id).toBeDefined();

      const asOrgB = await withDbAccessContext(orgContext(orgB.id), async () =>
        db.select().from(topologyManualNodes),
      );
      expect(asOrgB.find((r) => r.id === row!.id)).toBeUndefined();
    });
  });
  ```
  (Adjust the fixture import names/args to match the real `setup.ts` exports — verify `createSite`'s signature; if it requires `siteId`/`name`, pass them.)
- [ ] Run — passes (real DB on :5433). Bring up the test DB if needed (`worktree-stack` or docker-compose.test), then:
  ```
  cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm exec vitest run --config vitest.integration.config.ts src/__tests__/integration/topology-manual-nodes-rls.integration.test.ts
  ```
  Expected: both cases green. (If they SKIP, the run hit dev-DB :5432 — re-run via the integration config so `.env.test` injects the :5433 breeze_app conn.)
- [ ] Run the cascade + RLS contract tests to confirm auto-discovery is satisfied:
  ```
  cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm exec vitest run --config vitest.integration.config.ts src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/rls-coverage.integration.test.ts
  ```
  Expected: green — `topology_manual_nodes` auto-discovered (org_id column), localeCompare-ordered, all four DML policies present.
- [ ] Also run the cascade unit list-contract: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/services/tenantCascade.test.ts`
- [ ] Commit: `test(rls): topology_manual_nodes forge + cascade coverage (#1728 phase 4)`

---

### Task 4 — `POST /discovery/topology/manual-node`

**Files**
- `apps/api/src/routes/discovery.ts` (route + zod schema)
- `apps/api/src/routes/discovery.manualNode.test.ts` (unit, Drizzle-mock)

**Interfaces**
- **Consumes:** `requirePermission('topology', 'write')`; `resolveOrgId(auth, body.orgId, true)`; `canAccessSite(perms, siteId)`; request `db`; `topologyManualNodes`.
- **Produces:** `POST /discovery/topology/manual-node` body `{ orgId?: string; siteId: string; label: string; role: 'switch'|'router'|'ap'|'firewall'|'patch_panel'|'other'; notes?: string }` → `201 { id, orgId, siteId, label, role, notes, createdAt }`. Errors: `403` (no permission / site denied), `404` (site not in org), validation `400`.

Steps:
- [ ] Add the zod schema near the other discovery schemas in `apps/api/src/routes/discovery.ts`:
  ```typescript
  const manualNodeRoleSchema = z.enum(['switch', 'router', 'ap', 'firewall', 'patch_panel', 'other']);
  const createManualNodeSchema = z.object({
    orgId: z.string().uuid().optional(),
    siteId: z.string().uuid(),
    label: z.string().trim().min(1).max(255),
    role: manualNodeRoleSchema,
    notes: z.string().trim().max(2000).optional(),
  });
  ```
- [ ] Write the failing unit test `apps/api/src/routes/discovery.manualNode.test.ts`. Mirror the existing discovery route test harness (mock `db`, mock `requirePermission` to pass-through, supply an `auth` context with org access). Assert: (a) a valid POST inserts with server-derived `orgId`+`createdBy` and returns 201; (b) a `siteId` the caller can't access → 403; (c) bad `role` → 400. (Use the repo's established route-unit mock pattern — `vi.mock('../db', ...)` returning a chainable `insert().values().returning()`; assert the `values()` arg includes `createdBy: auth.user.id` and NOT a body-supplied org.)
- [ ] Run — fails: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/routes/discovery.manualNode.test.ts`
  Expected: 404 from the router (route not mounted) / handler undefined.
- [ ] Implement the route in `apps/api/src/routes/discovery.ts` (place near `GET /topology`):
  ```typescript
  discoveryRoutes.post(
    '/topology/manual-node',
    requireScope('organization', 'partner', 'system'),
    requirePermission('topology', 'write'),
    zValidator('json', createManualNodeSchema),
    async (c) => {
      const auth = c.get('auth');
      const body = c.req.valid('json');
      const orgResult = resolveOrgId(auth, body.orgId, true);
      if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

      // Site must belong to the resolved org (RLS doesn't defend the site axis).
      const [site] = await db
        .select({ id: sites.id })
        .from(sites)
        .where(and(eq(sites.id, body.siteId), eq(sites.orgId, orgResult.orgId!)))
        .limit(1);
      if (!site) return c.json({ error: 'Site not found' }, 404);

      const perms = c.get('permissions') as UserPermissions | undefined;
      if (perms?.allowedSiteIds && !canAccessSite(perms, body.siteId)) {
        return c.json({ error: 'Access to this site denied' }, 403);
      }

      const [node] = await db.insert(topologyManualNodes).values({
        orgId: orgResult.orgId!,
        siteId: body.siteId,
        label: body.label,
        role: body.role,
        notes: body.notes ?? null,
        createdBy: auth.user?.id ?? null,
      }).returning();

      writeRouteAudit(c, {
        orgId: orgResult.orgId,
        action: 'discovery.topology.manual_node.create',
        resourceType: 'topology_manual_node',
        resourceId: node?.id,
        resourceName: node?.label,
      });

      return c.json(node, 201);
    }
  );
  ```
  Confirm `sites`, `topologyManualNodes`, `UserPermissions`, `canAccessSite`, `and`, `eq` are imported in the file; add any missing imports.
- [ ] Run — passes: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/routes/discovery.manualNode.test.ts`
- [ ] Commit: `feat(api): POST /discovery/topology/manual-node (#1728 phase 4)`

---

### Task 5 — `POST /discovery/topology/manual-edge`

**Files**
- `apps/api/src/routes/discovery.ts` (route + zod schema; small endpoint-resolution helper)
- `apps/api/src/routes/discovery.manualEdge.test.ts` (unit)

**Interfaces**
- **Consumes:** `requirePermission('topology', 'write')`; `resolveOrgId`; request `db`; `networkTopology`, `discoveredAssets`, `topologyManualNodes`.
- **Produces:** `POST /discovery/topology/manual-edge` body `{ orgId?; siteId; source: { type: 'discovered_asset'|'manual_node'; id: string }; target: {...} }` → `201` network_topology row `{ id, source, target, sourceType, targetType, method:'manual', confidence:'asserted', connectionType:'manual', createdBy }`. Each endpoint must be an asset-in-site or manual-node-in-site (else `400`/`404`); same org/site server-derived. Honors the `ux_network_topology_provenance(... method)` unique index (a manual + measured edge may coexist).

Steps:
- [ ] Add the zod schema:
  ```typescript
  const manualEdgeEndpointSchema = z.object({
    type: z.enum(['discovered_asset', 'manual_node']),
    id: z.string().uuid(),
  });
  const createManualEdgeSchema = z.object({
    orgId: z.string().uuid().optional(),
    siteId: z.string().uuid(),
    source: manualEdgeEndpointSchema,
    target: manualEdgeEndpointSchema,
  });
  ```
- [ ] Write the failing unit test `apps/api/src/routes/discovery.manualEdge.test.ts`. Assert: (a) both endpoints resolved in the same org/site → 201 with `method:'manual'`, `confidence:'asserted'`, `createdBy=auth.user.id`; (b) an endpoint id not found in the site → 404; (c) a source == target (self-edge) → 400; (d) `requirePermission('topology','write')` is the gate (the route registers it). Mock `db.select` to return the seeded endpoint rows and `db.insert` chainable.
- [ ] Run — fails: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/routes/discovery.manualEdge.test.ts`
  Expected: 404 (route not mounted).
- [ ] Implement an endpoint-existence helper + the route in `apps/api/src/routes/discovery.ts`:
  ```typescript
  // Resolve a manual-edge endpoint to confirm it is an asset/manual-node in (org, site).
  async function manualEdgeEndpointExists(
    endpoint: { type: 'discovered_asset' | 'manual_node'; id: string },
    orgId: string,
    siteId: string,
  ): Promise<boolean> {
    if (endpoint.type === 'discovered_asset') {
      const [r] = await db.select({ id: discoveredAssets.id }).from(discoveredAssets)
        .where(and(
          eq(discoveredAssets.id, endpoint.id),
          eq(discoveredAssets.orgId, orgId),
          eq(discoveredAssets.siteId, siteId),
        )).limit(1);
      return !!r;
    }
    const [r] = await db.select({ id: topologyManualNodes.id }).from(topologyManualNodes)
      .where(and(
        eq(topologyManualNodes.id, endpoint.id),
        eq(topologyManualNodes.orgId, orgId),
        eq(topologyManualNodes.siteId, siteId),
      )).limit(1);
    return !!r;
  }

  discoveryRoutes.post(
    '/topology/manual-edge',
    requireScope('organization', 'partner', 'system'),
    requirePermission('topology', 'write'),
    zValidator('json', createManualEdgeSchema),
    async (c) => {
      const auth = c.get('auth');
      const body = c.req.valid('json');
      const orgResult = resolveOrgId(auth, body.orgId, true);
      if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

      if (body.source.type === body.target.type && body.source.id === body.target.id) {
        return c.json({ error: 'An edge cannot connect a node to itself' }, 400);
      }
      const perms = c.get('permissions') as UserPermissions | undefined;
      if (perms?.allowedSiteIds && !canAccessSite(perms, body.siteId)) {
        return c.json({ error: 'Access to this site denied' }, 403);
      }

      const [srcOk, tgtOk] = await Promise.all([
        manualEdgeEndpointExists(body.source, orgResult.orgId!, body.siteId),
        manualEdgeEndpointExists(body.target, orgResult.orgId!, body.siteId),
      ]);
      if (!srcOk || !tgtOk) return c.json({ error: 'Edge endpoint not found in this site' }, 404);

      const [edge] = await db.insert(networkTopology).values({
        orgId: orgResult.orgId!,
        siteId: body.siteId,
        sourceType: body.source.type,
        sourceId: body.source.id,
        targetType: body.target.type,
        targetId: body.target.id,
        connectionType: 'manual',
        method: 'manual',
        confidence: 'asserted',
        createdBy: auth.user?.id ?? null,
      }).returning();

      writeRouteAudit(c, {
        orgId: orgResult.orgId,
        action: 'discovery.topology.manual_edge.create',
        resourceType: 'topology_manual_edge',
        resourceId: edge?.id,
      });

      return c.json(edge, 201);
    }
  );
  ```
  (`method`, `confidence`, `createdBy`, `firstSeenAt` are Phase 1 columns on `networkTopology` — assumed present. If `firstSeenAt` is `NOT NULL DEFAULT now()`, the insert needs nothing extra.)
- [ ] Run — passes: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/routes/discovery.manualEdge.test.ts`
- [ ] Commit: `feat(api): POST /discovery/topology/manual-edge (#1728 phase 4)`

---

### Task 6 — `DELETE /discovery/topology/manual-edge/:id`

**Files**
- `apps/api/src/routes/discovery.ts`
- `apps/api/src/routes/discovery.manualEdge.test.ts` (extend)

**Interfaces**
- **Consumes:** `requirePermission('topology', 'write')`; request `db`; `networkTopology`.
- **Produces:** `DELETE /discovery/topology/manual-edge/:id` → `200 { success: true }`. ONLY deletes rows where `method = 'manual'` (measured edges are scan-owned, read-only). `404` if no manual edge with that id is visible.

Steps:
- [ ] Add a failing test: deleting a `method='manual'` edge → 200; deleting a `method='fdb'` (measured) edge id → 404 (the `method='manual'` filter yields no row). Append to `discovery.manualEdge.test.ts`.
- [ ] Run — fails (route not mounted).
- [ ] Implement:
  ```typescript
  discoveryRoutes.delete(
    '/topology/manual-edge/:id',
    requireScope('organization', 'partner', 'system'),
    requirePermission('topology', 'write'),
    async (c) => {
      const auth = c.get('auth');
      const id = c.req.param('id')!;
      const orgResult = resolveOrgId(auth, c.req.query('orgId'));
      if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

      const conds = [eq(networkTopology.id, id), eq(networkTopology.method, 'manual')];
      if (orgResult.orgId) conds.push(eq(networkTopology.orgId, orgResult.orgId));

      const [existing] = await db.select({ id: networkTopology.id, orgId: networkTopology.orgId, siteId: networkTopology.siteId })
        .from(networkTopology).where(and(...conds)).limit(1);
      if (!existing) return c.json({ error: 'Manual edge not found' }, 404);

      await db.delete(networkTopology).where(eq(networkTopology.id, existing.id));

      writeRouteAudit(c, {
        orgId: existing.orgId,
        action: 'discovery.topology.manual_edge.delete',
        resourceType: 'topology_manual_edge',
        resourceId: existing.id,
      });
      return c.json({ success: true });
    }
  );
  ```
- [ ] Run — passes.
- [ ] Commit: `feat(api): DELETE /discovery/topology/manual-edge/:id (#1728 phase 4)`

---

### Task 7 — `DELETE /discovery/topology/manual-node/:id` (cascade manual edges + layout row)

**Files**
- `apps/api/src/routes/discovery.ts`
- `apps/api/src/routes/discovery.manualNode.test.ts` (extend)

**Interfaces**
- **Consumes:** `requirePermission('topology', 'write')`; request `db` (transaction); `topologyManualNodes`, `networkTopology`, `topologyLayout` (Phase 3 table).
- **Produces:** `DELETE /discovery/topology/manual-node/:id` → `200 { success: true }`. In ONE transaction: delete the node's `method='manual'` edges in `network_topology` where it is source OR target; delete its `topology_layout` row (`node_type='manual_node', node_id=:id`); delete the node. `404` if node not visible. Does NOT touch measured edges.

Steps:
- [ ] Add a failing test: deleting a node also issues deletes against `network_topology` (manual edges referencing it as source or target) and `topology_layout`, then the node — assert all three deletes fire inside one `db.transaction`, and unknown id → 404.
- [ ] Run — fails (route not mounted).
- [ ] Implement:
  ```typescript
  discoveryRoutes.delete(
    '/topology/manual-node/:id',
    requireScope('organization', 'partner', 'system'),
    requirePermission('topology', 'write'),
    async (c) => {
      const auth = c.get('auth');
      const id = c.req.param('id')!;
      const orgResult = resolveOrgId(auth, c.req.query('orgId'));
      if ('error' in orgResult) return c.json({ error: orgResult.error }, orgResult.status);

      const conds = [eq(topologyManualNodes.id, id)];
      if (orgResult.orgId) conds.push(eq(topologyManualNodes.orgId, orgResult.orgId));
      const [node] = await db.select({ id: topologyManualNodes.id, orgId: topologyManualNodes.orgId, label: topologyManualNodes.label })
        .from(topologyManualNodes).where(and(...conds)).limit(1);
      if (!node) return c.json({ error: 'Manual node not found' }, 404);

      await db.transaction(async (tx) => {
        // Manual edges that reference this placeholder (source OR target). Measured edges never reference a manual_node.
        await tx.delete(networkTopology).where(and(
          eq(networkTopology.method, 'manual'),
          eq(networkTopology.sourceType, 'manual_node'),
          eq(networkTopology.sourceId, node.id),
        ));
        await tx.delete(networkTopology).where(and(
          eq(networkTopology.method, 'manual'),
          eq(networkTopology.targetType, 'manual_node'),
          eq(networkTopology.targetId, node.id),
        ));
        await tx.delete(topologyLayout).where(and(
          eq(topologyLayout.nodeType, 'manual_node'),
          eq(topologyLayout.nodeId, node.id),
        ));
        await tx.delete(topologyManualNodes).where(eq(topologyManualNodes.id, node.id));
      });

      writeRouteAudit(c, {
        orgId: node.orgId,
        action: 'discovery.topology.manual_node.delete',
        resourceType: 'topology_manual_node',
        resourceId: node.id,
        resourceName: node.label,
      });
      return c.json({ success: true });
    }
  );
  ```
  (`topologyLayout` is the Phase 3 export; confirm its column names `nodeType`/`nodeId` match — if Phase 3 used different names, adapt.)
- [ ] Run — passes.
- [ ] Commit: `feat(api): DELETE /discovery/topology/manual-node/:id with cascade (#1728 phase 4)`

---

### Task 8 — Extend `GET /discovery/topology` to include manual nodes + manual edges

**Files**
- `apps/api/src/routes/discovery.ts` (extend the `GET /topology` handler)
- `apps/api/src/routes/discovery.topologyRead.test.ts` (new unit)

**Interfaces**
- **Consumes:** request `db`; `topologyManualNodes`; existing `networkTopology` read.
- **Produces:** `GET /discovery/topology` response — `nodes[]` now also contains `{ id, type: <role>, label, kind: 'manual' }` for each manual node; `edges[]` entries now expose `method`, `confidence`, `createdBy` (manual edges carry `method:'manual'`, `confidence:'asserted'`). Existing measured nodes gain `kind: 'discovered'` for symmetry.

Steps:
- [ ] Write a failing unit test `apps/api/src/routes/discovery.topologyRead.test.ts`: mock `db` so `topologyManualNodes` returns one row and `networkTopology` returns one manual + one fdb edge; assert the response `nodes` includes `{ kind: 'manual', type: 'switch', label: 'core-sw' }` and `edges` includes an entry with `method: 'manual', confidence: 'asserted'` plus the fdb edge with `method: 'fdb'`.
- [ ] Run — fails (manual nodes absent / edge lacks `method`).
- [ ] Extend the handler. After loading `assets` and `edges`, add a manual-nodes query and merge into the response:
  ```typescript
  const manualNodes = orgResult.orgId
    ? await db.select().from(topologyManualNodes).where(eq(topologyManualNodes.orgId, orgResult.orgId))
    : await db.select().from(topologyManualNodes);
  ```
  In the `nodes` array, tag discovered nodes with `kind: 'discovered'` and append manual nodes:
  ```typescript
  const nodes = [
    ...assets.map((a) => ({
      id: a.id,
      type: a.assetType,
      label: a.label ?? a.hostname ?? a.ipAddress ?? a.id,
      status: a.isOnline ? 'online' : 'offline',
      approvalStatus: a.approvalStatus,
      ipAddress: a.ipAddress,
      macAddress: a.macAddress,
      kind: 'discovered' as const,
    })),
    ...manualNodes.map((m) => ({
      id: m.id,
      type: m.role,
      label: m.label,
      kind: 'manual' as const,
    })),
  ];
  ```
  In the `edges` map, surface provenance:
  ```typescript
  edges: edges.map((e) => ({
    id: e.id,
    source: e.sourceId,
    target: e.targetId,
    type: e.connectionType,
    sourceType: e.sourceType,
    targetType: e.targetType,
    method: e.method,
    confidence: e.confidence,
    interfaceName: e.interfaceName,
    vlan: e.vlan,
    createdBy: e.createdBy,
    bandwidth: e.bandwidth,
    latency: e.latency,
    observedAt: e.lastVerifiedAt?.toISOString() ?? null,
  })),
  ```
- [ ] Run — passes.
- [ ] Commit: `feat(api): include manual nodes/edges in GET /discovery/topology (#1728 phase 4)`

---

### Task 9 — Integration test: `topology:write` RBAC 403 + manual write round-trip

**Files**
- `apps/api/src/__tests__/integration/topology-manual-write.integration.test.ts` (new)

**Interfaces**
- **Consumes:** real-DB integration harness; an org user WITHOUT `topology:write`; a user WITH it; the four manual routes; `GET /discovery/topology`.
- **Produces:** a BLOCKING integration test proving (a) an org user lacking `topology:write` gets `403` on `POST /discovery/topology/manual-node`; (b) a user with it creates node+edge, they appear in `GET /topology`, and `DELETE` removes them; (c) cross-partner read of another tenant's manual node returns empty/404.

Steps:
- [ ] Write the integration test. Use the established integration harness to mint two roles (one with `topology:write`, one without) under the same org, obtain request contexts/JWTs the way sibling integration tests do, and exercise the live Hono app (or call the route handlers through the test app fixture). Assert:
  - `POST /discovery/topology/manual-node` as the no-permission user → `403` (`Permission denied`).
  - As the permitted user: create a manual node (201), create a manual edge between that node and a seeded discovered asset (201), `GET /discovery/topology` returns the manual node (`kind:'manual'`) and the manual edge (`method:'manual'`).
  - `DELETE /discovery/topology/manual-node/:id` (200) also removes its manual edge from a follow-up `GET`.
  - A second org's user does NOT see org A's manual node in `GET /topology`.
  Mirror the auth/role-seeding pattern from an existing route-level integration test (find one that seeds `roles`/`role_permissions` and issues an authenticated request).
- [ ] Run — passes (real DB):
  ```
  cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm exec vitest run --config vitest.integration.config.ts src/__tests__/integration/topology-manual-write.integration.test.ts
  ```
  Expected: green; the 403 case is self-verifying (a vacuous BYPASSRLS pass cannot fake a 403 from `requirePermission`).
- [ ] Commit: `test(api): topology:write RBAC 403 + manual write round-trip (#1728 phase 4)`

---

### Task 10 — Web: `topology:write` permission gate + View/Edit toggle scaffold

**Files**
- `apps/web/src/components/discovery/NetworkTopologyMap.tsx` (Phase 3 Cytoscape component)
- `apps/web/src/components/discovery/NetworkTopologyMap.editmode.test.tsx` (new)

**Interfaces**
- **Consumes:** `usePermissions` (`apps/web/src/lib/permissions.ts`) → `can('topology', 'write')`; existing Cytoscape ref + `/discovery/topology` fetch (Phase 3).
- **Produces:** an Edit-mode toggle rendered ONLY when `can('topology','write')` is true (hidden otherwise); an `editMode` state that, when off, leaves the canvas read-only. `data-testid="topology-edit-toggle"`.

Steps:
- [ ] Write the failing web test `NetworkTopologyMap.editmode.test.tsx`. Stub `ResizeObserver` BEFORE importing the component; mock `fetchWithAuth` (`vi.mock('../../stores/auth')`) and `usePermissions` (`vi.mock('../../lib/permissions')`). Cases: (a) when `can` returns `true`, `getByTestId('topology-edit-toggle')` is present; (b) when `can` returns `false`, `queryByTestId('topology-edit-toggle')` is null.
  ```typescript
  class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
  (globalThis as any).ResizeObserver = (globalThis as any).ResizeObserver ?? ResizeObserverStub;

  const canMock = vi.fn();
  vi.mock('../../lib/permissions', () => ({
    usePermissions: () => ({ permissions: [], can: (...a: unknown[]) => canMock(...a) }),
  }));
  const fetchWithAuth = vi.fn();
  vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
  ```
  (Also stub Cytoscape if the component instantiates it at mount and jsdom lacks canvas — mock the `cytoscape` default export to a no-op chainable, matching whatever Phase 3 tests already do.)
- [ ] Run — fails: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/web exec vitest run src/components/discovery/NetworkTopologyMap.editmode.test.tsx`
  Expected: toggle not found.
- [ ] Implement the gate. In `NetworkTopologyMap.tsx`: import `usePermissions`; add `const { can } = usePermissions(); const canEdit = can('topology', 'write');` and `const [editMode, setEditMode] = useState(false);`. Render, only when `canEdit`:
  ```tsx
  {canEdit && (
    <button
      type="button"
      data-testid="topology-edit-toggle"
      onClick={() => setEditMode((v) => !v)}
      className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition hover:opacity-90"
    >
      {editMode ? 'Done editing' : 'Edit map'}
    </button>
  )}
  ```
- [ ] Run — passes.
- [ ] Commit: `feat(web): topology edit-mode toggle gated by topology:write (#1728 phase 4)`

---

### Task 11 — Web: add-node palette → `POST /discovery/topology/manual-node` (runAction)

**Files**
- `apps/web/src/components/discovery/NetworkTopologyMap.tsx`
- `apps/web/src/components/discovery/NetworkTopologyMap.editmode.test.tsx` (extend)

**Interfaces**
- **Consumes:** `runAction`, `handleActionError`, `ActionError` (`apps/web/src/lib/runAction.ts`); `fetchWithAuth`; current `siteId` (component prop or selected-site context — pass through the existing topology fetch scoping).
- **Produces:** an add-node palette (`switch`/`router`/`ap`/`firewall`/`patch_panel`/`other`) visible only in `editMode`; clicking a role POSTs `manual-node` and adds the returned node to the canvas. Surfaced via `runAction` (success toast + error toast). `data-testid="topology-add-node-<role>"`.

Steps:
- [ ] Add a failing test: in edit mode with `can=true`, clicking `getByTestId('topology-add-node-switch')` calls `fetchWithAuth` with `/discovery/topology/manual-node`, method POST, body containing `role:'switch'` and the active `siteId`; on success a node is added (assert via a re-render/cy.add spy) and `runAction`'s success path runs. Mock `fetchWithAuth` to resolve `{ ok: true, json: async () => ({ id: 'n1', role: 'switch', label: 'Switch', kind: 'manual' }) }`.
- [ ] Run — fails (palette absent).
- [ ] Implement the palette + handler:
  ```tsx
  const MANUAL_ROLES = ['switch', 'router', 'ap', 'firewall', 'patch_panel', 'other'] as const;

  async function addManualNode(role: (typeof MANUAL_ROLES)[number]) {
    try {
      const node = await runAction<{ id: string; label: string; role: string }>({
        request: () => fetchWithAuth('/discovery/topology/manual-node', {
          method: 'POST',
          body: JSON.stringify({ siteId: activeSiteId, role, label: roleLabel(role) }),
        }),
        errorFallback: 'Failed to add node',
        successMessage: 'Node added',
      });
      // add node.id to the Cytoscape graph at viewport center (Phase 3 cy ref)
      cyRef.current?.add({ data: { id: node.id, label: node.label, kind: 'manual', role: node.role } });
    } catch (err) {
      handleActionError(err, 'Failed to add node.');
    }
  }
  ```
  Render, inside the `editMode && canEdit` block:
  ```tsx
  {editMode && (
    <div className="flex gap-1" role="group" aria-label="Add node">
      {MANUAL_ROLES.map((r) => (
        <button key={r} type="button" data-testid={`topology-add-node-${r}`}
          onClick={() => void addManualNode(r)}
          className="rounded border px-2 py-1 text-xs">{roleLabel(r)}</button>
      ))}
    </div>
  )}
  ```
  (`activeSiteId`/`roleLabel`/`cyRef` reuse Phase 3 wiring; if the topology view is org-wide with a site selector, source `activeSiteId` from that selector. If no site is selected, disable the palette with a tooltip — manual nodes require a site.)
- [ ] Run — passes.
- [ ] Commit: `feat(web): add-node palette posts manual nodes via runAction (#1728 phase 4)`

---

### Task 12 — Web: drag-to-connect → `POST /discovery/topology/manual-edge` (runAction)

**Files**
- `apps/web/src/components/discovery/NetworkTopologyMap.tsx`
- `apps/web/src/components/discovery/NetworkTopologyMap.editmode.test.tsx` (extend)

**Interfaces**
- **Consumes:** `runAction`/`handleActionError`; `fetchWithAuth`; Cytoscape edge-handles or a two-click connect flow on the Phase 3 `cy` instance; the node `kind`/`role` data set in earlier tasks.
- **Produces:** in edit mode, selecting a source node then a target node POSTs `manual-edge` with `{ siteId, source:{type,id}, target:{type,id} }` (type derived from each node's `kind`: `manual` → `manual_node`, `discovered` → `discovered_asset`); the returned edge is added with the manual dashed-orange style (Phase 3). Self-connect is prevented client-side. `runAction` surfaces success/failure.

Steps:
- [ ] Add a failing test: simulate connecting node `n1` (kind manual) to asset `a1` (kind discovered); assert `fetchWithAuth` called with `/discovery/topology/manual-edge` POST and body `source:{type:'manual_node',id:'n1'}, target:{type:'discovered_asset',id:'a1'}`; on success the edge is added (cy.add spy). Drive the connect via the component's exposed handler (call it directly in the test if the gesture isn't simulable in jsdom — expose a small `connectNodes(sourceId, targetId)` callback used by both the gesture and the test).
- [ ] Run — fails.
- [ ] Implement `connectNodes`:
  ```tsx
  function endpointFor(nodeId: string): { type: 'manual_node' | 'discovered_asset'; id: string } | null {
    const n = cyRef.current?.getElementById(nodeId);
    if (!n || n.empty()) return null;
    return { type: n.data('kind') === 'manual' ? 'manual_node' : 'discovered_asset', id: nodeId };
  }

  async function connectNodes(sourceId: string, targetId: string) {
    if (sourceId === targetId) return;
    const source = endpointFor(sourceId); const target = endpointFor(targetId);
    if (!source || !target) return;
    try {
      const edge = await runAction<{ id: string }>({
        request: () => fetchWithAuth('/discovery/topology/manual-edge', {
          method: 'POST',
          body: JSON.stringify({ siteId: activeSiteId, source, target }),
        }),
        errorFallback: 'Failed to connect nodes',
        successMessage: 'Connection added',
      });
      cyRef.current?.add({ data: { id: edge.id, source: sourceId, target: targetId, method: 'manual', confidence: 'asserted' } });
    } catch (err) {
      handleActionError(err, 'Failed to connect nodes.');
    }
  }
  ```
  Wire it to the edit-mode connect gesture (edge-handles plugin or two-tap select). Manual edges render with the Phase 3 dashed-orange style keyed on `method:'manual'`.
- [ ] Run — passes.
- [ ] Commit: `feat(web): drag-to-connect posts manual edges via runAction (#1728 phase 4)`

---

### Task 13 — Web: select-edge → `DELETE` manual edge; delete node; measured edges read-only

**Files**
- `apps/web/src/components/discovery/NetworkTopologyMap.tsx`
- `apps/web/src/components/discovery/NetworkTopologyMap.editmode.test.tsx` (extend)

**Interfaces**
- **Consumes:** `runAction`/`handleActionError`; `fetchWithAuth`; selected element's `method` (manual vs measured) and `kind`.
- **Produces:** selecting a **manual** edge in edit mode shows a Delete affordance → `DELETE /discovery/topology/manual-edge/:id` (removes from canvas on success); selecting a **measured** edge shows provenance read-only (no delete). Selecting a manual **node** offers delete → `DELETE /discovery/topology/manual-node/:id`. There is NO edit-a-measured-edge path.

Steps:
- [ ] Add failing tests: (a) selecting a manual edge renders `topology-delete-edge`, clicking it calls `fetchWithAuth('/discovery/topology/manual-edge/<id>', { method: 'DELETE' })` and removes the edge on success; (b) selecting a measured edge (`method:'fdb'`) renders provenance text (`getByTestId('topology-edge-provenance')`) and NO `topology-delete-edge` button; (c) selecting a manual node renders `topology-delete-node` → DELETE manual-node.
- [ ] Run — fails.
- [ ] Implement selection-driven inspector:
  ```tsx
  async function deleteManualEdge(id: string) {
    try {
      await runAction({
        request: () => fetchWithAuth(`/discovery/topology/manual-edge/${id}`, { method: 'DELETE' }),
        errorFallback: 'Failed to delete connection',
        successMessage: 'Connection removed',
      });
      cyRef.current?.getElementById(id).remove();
    } catch (err) { handleActionError(err, 'Failed to delete connection.'); }
  }
  async function deleteManualNode(id: string) {
    try {
      await runAction({
        request: () => fetchWithAuth(`/discovery/topology/manual-node/${id}`, { method: 'DELETE' }),
        errorFallback: 'Failed to delete node',
        successMessage: 'Node removed',
      });
      // remove node + its now-orphaned manual edges from the canvas
      const el = cyRef.current?.getElementById(id);
      el?.connectedEdges().remove();
      el?.remove();
    } catch (err) { handleActionError(err, 'Failed to delete node.'); }
  }
  ```
  In the selection inspector panel, branch on the selected element:
  ```tsx
  {selected?.group === 'edges' && selected.method === 'manual' && editMode && (
    <button type="button" data-testid="topology-delete-edge" onClick={() => void deleteManualEdge(selected.id)} className="...">Delete connection</button>
  )}
  {selected?.group === 'edges' && selected.method !== 'manual' && (
    <p data-testid="topology-edge-provenance" className="text-xs text-muted-foreground">
      {selected.method?.toUpperCase()} · {selected.confidence}{selected.interfaceName ? ` · ${selected.interfaceName}` : ''}{selected.vlan ? ` · VLAN ${selected.vlan}` : ''}
    </p>
  )}
  {selected?.group === 'nodes' && selected.kind === 'manual' && editMode && (
    <button type="button" data-testid="topology-delete-node" onClick={() => void deleteManualNode(selected.id)} className="...">Delete node</button>
  )}
  ```
- [ ] Run — passes.
- [ ] Full web suite for the component (regression): `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/web exec vitest run src/components/discovery/`
- [ ] Commit: `feat(web): delete manual edges/nodes; measured edges read-only provenance (#1728 phase 4)`

---

### Task 14 — Full verification sweep

**Files** — none (verification only)

Steps:
- [ ] API typecheck + unit: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api typecheck && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/routes/discovery.manualNode.test.ts src/routes/discovery.manualEdge.test.ts src/routes/discovery.topologyRead.test.ts src/db/seed.test.ts`
- [ ] Web typecheck (incl. `.astro` if any host page changed) + unit: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/web typecheck && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/web exec vitest run src/components/discovery/`
- [ ] Integration (real DB :5433 — the BLOCKING job): `cd apps/api && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm exec vitest run --config vitest.integration.config.ts src/__tests__/integration/topology-manual-nodes-rls.integration.test.ts src/__tests__/integration/topology-manual-write.integration.test.ts src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/rls-coverage.integration.test.ts`
- [ ] Drift clean: `export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm db:check-drift`
- [ ] Manual breeze_app forge sanity (per CLAUDE.md): `docker exec -it breeze-postgres psql -U breeze_app -d breeze` then attempt a cross-tenant `INSERT INTO topology_manual_nodes ...` — must fail `new row violates row-level security policy`.
- [ ] Use **superpowers:requesting-code-review** before any merge decision (user-facing/UI change → HOLD for Todd's UI test per the merge/hold rule).

---

## Notes / risks for the executing agent

1. **Phases 1–3 are a hard dependency.** This plan assumes `network_topology` already carries `method`, `confidence`, `interface_name`, `created_by`, `first_seen_at`, the `ux_network_topology_provenance(org_id, site_id, source_type, source_id, target_type, target_id, method)` unique index, and that `source_type`/`target_type` already accept `'manual_node'`; and that `topology_layout` exists with `node_type`/`node_id` and the Cytoscape `preset` view + manual dashed-orange edge style are in place. **Verified against the live tree (2026-06-22): these do NOT yet exist** (network_topology lacks the provenance columns; NetworkTopologyMap is still D3; no topology_layout). If Phase 4 is started before Phases 1–3 land, STOP and confirm sequencing — Tasks 5–8 and 10–13 will not compile/run against the current schema/component.
2. **`firstSeenAt` on manual-edge insert:** if Phase 1 made `first_seen_at NOT NULL` without a default, set `firstSeenAt: new Date()` in the Task 5 insert.
3. **`topologyLayout` column names** (Task 7) must match Phase 3's actual Drizzle export — adjust `nodeType`/`nodeId` if Phase 3 named them differently.
4. **Site axis is app-layer only** (RLS does not defend it) — every manual route validates site∈org and `canAccessSite`; do not rely on RLS for the `siteId` check.
5. **Never a bare pool** for manual writes — all manual routes use the request `db` (org/site server-derived from auth), avoiding the silent 0-row-write class (MEMORY #1375).
6. **Manual edges are scan-immune** by construction: reconcile (Phases 1–2) filters on the measured method set and never touches `method='manual'`; the unique index keeps a measured + manual edge distinct on the same pair.
