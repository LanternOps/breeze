# Intelligent Network Topology M0 — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a scoped canonical graph foundation and a lossless legacy capture/import path with the new UI disabled.

**Architecture:** Add only M0 graph/layout/outbox tables. Transactional legacy capture precedes restartable backfill; ordered publication uses source revisions, tombstones and `build_fence`. Read/write adapters preserve existing clients while the canonical API establishes later milestones' interfaces.

**Tech Stack:** TypeScript, Zod, Hono, Drizzle/PostgreSQL, BullMQ/Redis, Vitest with real `breeze_app` integration tests.

**Spec:** [Main](../../specs/monitoring/2026-09-15-intelligent-network-topology-design.md), [Data](../../specs/monitoring/2026-09-15-intelligent-network-topology-data-contracts.md), and [plan index](2026-09-15-intelligent-network-topology-INDEX.md). M0 is lifecycle W01. No application implementation has occurred during plan authoring.

## Global constraints

- All index constraints apply. In particular: org RLS plus application site ceilings; current bindings detach for individual site moves; whole-org merges preserve canonical/site IDs; no probes/model calls/layout writes on reads.
- M0 creates `topology_site_state`, `topology_nodes`, `topology_node_bindings`, `topology_relationships`, `topology_layouts`, `topology_node_positions`, `topology_change_outbox`. Interfaces/observations/templates/diagnostics arrive in M1; exclusions in M2; samples in M3. Do not create FKs to unborn tables.
- Existing tables remain `network_topology`, `topology_layout`, `topology_manual_nodes`, `discovered_assets`, `devices`; do not rename or recreate them. `topology:read/write` already exist.
- Capture → consistent backfill → drain → shadow comparison is mandatory. Capture is never switched off by the new UI/materialization flags.
- Allocate each migration after the latest committed/fetched maximum using HHMMSS; no frozen date or letter suffix. The migration path notation below denotes the slot computed at execution, not an unspecified schema decision.
- Tests using the integration runner use a disposable DB. `test:rls-coverage` is the separate read-only catalog runner. All new JSON fields are `excludedOpen` in tenant export policy.

## Files and task order

Create shared `types/topology.ts`, `validators/topology.ts` and their tests. Create API schema `topology.ts`, the `services/topology/` foundation modules, `routes/topology/` hub/resources, `jobs/topologyOutboxWorker.ts`, `scripts/topology-migrate.ts` and dedicated fixtures. Modify shared/schema barrels, `routes/discovery.ts`, lifecycle registries/device movement, API startup and worker registry only where tasks below require it.

Tasks 1–4 establish contracts/security. Task 5 installs capture before Task 7 imports. Tasks 6–9 publish/read/write through those contracts. Task 10 completes lifecycle proof; Task 11 gates deployment/backfill. Integration code can be drafted earlier, but no real backfill is allowed until Tasks 2, 5 and 10 pass.

### Task 1: Canonical types, validation and shared fixture identities

**Files:**

- Create `packages/shared/src/types/topology.ts`, `packages/shared/src/validators/topology.ts`, `packages/shared/src/validators/topology.test.ts`.
- Modify `packages/shared/src/index.ts` and the existing type/validator barrels where exported.
- Create `apps/api/src/__tests__/helpers/topology.ts` for deterministic UUID constants and pure object builders; DB seed functions live in `src/__tests__/integration/topology-fixtures.ts` using existing `db-utils.ts`.

**Interfaces:** Produce `TopologyScope`, `GraphQuery`, `GraphResponse`, `GraphNode`, `GraphRelationship`, `PresentationNode`, `PresentationEdge`, `Position`, `LayoutWriteResult`, `graphQuerySchema`, `layoutPatchSchema`, `layoutWriteResultSchema`, and canonical enum schemas. All revisions/counters crossing JSON are decimal strings. API actor types stay API-local.

- [ ] Add validator tests for every enum, canonical UUID vs presentation ID, unknown keys/version, finite coordinates, graph bounds, revision precision and missing fields. Include this boundary test:

```ts
import { expect, it } from 'vitest';
import { graphQuerySchema, layoutPatchSchema } from './topology';
it('rejects non-canonical layout IDs and non-finite coordinates', () => {
  expect(layoutPatchSchema.safeParse({ expectedRevision: '1', positions: [
    { nodeId: 'presentation:overview:scope:gateway', x: 1, y: 2, pinned: false },
  ] }).success).toBe(false);
  expect(layoutPatchSchema.safeParse({ expectedRevision: '1', positions: [
    { nodeId: '11111111-1111-4111-8111-111111111111', x: Infinity, y: 2, pinned: false },
  ] }).success).toBe(false);
  expect(graphQuerySchema.parse({}).limit).toBe(500);
});
```

- [ ] Run `pnpm --filter @breeze/shared exec vitest run src/validators/topology.test.ts`; confirm failure from missing validators, not a broken test harness.
- [ ] Define the full Data §1/§5 object schemas, deriving TypeScript types from validated shapes or keeping compile-time equality tests. Define `Position` as `{nodeId,x,y,pinned,source,rowRevision}`; public layout patch input is `{expectedRevision,positions}`. Define `LayoutWriteResult = {siteId:string;view:TopologyView;layoutRevision:string;positions:Position[]}` and its strict `layoutWriteResultSchema`; response positions are the accepted batch only, merged by node ID into the client's existing layout rather than replacing positions outside the batch. Strip neither illegal scope fields nor malformed IDs silently. Implement the numeric/revision primitives explicitly:

```ts
const revision = z.string().regex(/^(0|[1-9]\d*)$/);
const coordinate = z.number().finite().min(-1_000_000).max(1_000_000);
export const layoutPatchSchema = z.object({
  expectedRevision: revision,
  positions: z.array(z.object({
    nodeId: z.string().uuid(), x: coordinate, y: coordinate, pinned: z.boolean(),
  }).strict()).max(1000),
}).strict();
```

Define `GraphResponse` with Data §5's schemaVersion/siteId/view/asOf/revision tuple, separate canonical/presentation arrays, layout, counts, coverage, frontier and permission booleans. `GraphNode` carries scoped binding references, kind/role/label/lifecycle/freshness/evidence/health/actions; relationships carry typed endpoints/interfaces/evidence/confidence/lifecycle/health. Presentation edges require null relationship kind, `presentationOnly:true`, schematic or aggregate meaning, and no authority for schematic objects. Enforce the 256 KiB request body cap before parsing layout arrays.

- [ ] Run the focused validator suite and `pnpm --filter @breeze/shared typecheck`; add fixtures with two sites using identical addresses and distinct UUIDs.
- [ ] Commit only the contract/fixture files: `feat(topology): define canonical graph and layout contracts`.

### Task 2: Core schema, RLS and lifecycle/export registrations

**Files:**

- Create `apps/api/src/db/schema/topology.ts`, `apps/api/migrations/<next-ordered-slot>-topology-inventory-fk-targets.sql`, then a strictly later allocated `apps/api/migrations/<next-ordered-slot>-topology-foundation.sql`. The first file creates only supporting indexes; the second creates tables, constraints and RLS atomically.
- Modify `apps/api/src/db/schema/{index,devices,discovery}.ts`, `services/tenantCascade.ts`, `services/tenantExportPolicyRegistry.ts`, `services/orgMergeRegistry.ts`, `routes/devices/core.ts`.
- Create `apps/api/src/__tests__/integration/topology-foundation.integration.test.ts`; extend existing cascade/move/export/merge contract tests where registration requires it.

**Interfaces:** Export Drizzle tables `topologySiteState`, `topologyNodes`, `topologyNodeBindings`, `topologyRelationships`, `topologyLayouts`, `topologyNodePositions`, `topologyChangeOutbox`. Storage fields are exactly Data §3's M0 rows, plus durable legacy source revision/tombstone metadata needed for idempotent imports.

- [ ] Add real-DB tests proving same-scope success, cross-org forge denial, same-org wrong-site binding rejection, XOR inventory binding rejection, unique layout/view, finite coordinates and migration reapplication. Reuse `createPartner/createOrganization/createSite` from `integration/db-utils.ts`; run target SQL through `db` in an explicit org context. A representative forge is:

```ts
await expect(withDbAccessContext(orgContext(tenantA.orgId), () => db.execute(sql`
  INSERT INTO topology_site_state (org_id, site_id)
  VALUES (${tenantB.orgId}::uuid, ${tenantB.siteId}::uuid)
`))).rejects.toMatchObject({ cause: { code: '42501' } });
```

`orgContext(orgId)` is the fixture function returning `{scope:'organization',orgId,accessibleOrgIds:[orgId],accessiblePartnerIds:[],userId:null}`. Seed fixtures through existing test helpers; separately prove the hidden row exists so an empty fixture cannot pass.

- [ ] Run `pnpm --filter @breeze/api test:integration src/__tests__/integration/topology-foundation.integration.test.ts`; confirm missing-table/constraint failure in the disposable stack.
- [ ] Write hand-authored idempotent SQL and matching Drizzle declarations. Scope child FKs through unique `(id,org_id,site_id)` keys, for example:

```sql
ALTER TABLE topology_node_bindings
  DROP CONSTRAINT IF EXISTS topology_binding_node_scope_fk;
ALTER TABLE topology_node_bindings
  ADD CONSTRAINT topology_binding_node_scope_fk
  FOREIGN KEY (node_id, org_id, site_id)
  REFERENCES topology_nodes(id, org_id, site_id)
  ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE topology_node_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE topology_node_bindings FORCE ROW LEVEL SECURITY;
```

**Inventory FK decision:** add `devices_id_org_id_site_id_uniq` on `devices(id,org_id,site_id)` in M0; retain the existing `devices_id_org_id_uniq`. The device binding FK is `(device_id,org_id,site_id) → devices(id,org_id,site_id)`, `ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE`; the existing lifecycle hook deletes current bindings before inventory deletion. The BEFORE move trigger detaches existing bindings for lifecycle preservation; it does not replace site equality enforcement on inserts/updates. Also create `discovered_assets_id_org_id_site_id_uniq` and `topology_manual_nodes_id_org_id_site_id_uniq` before their matching binding FKs, using the same explicit `ON DELETE NO ACTION` and deferral contract. Reuse the existing `sites_id_org_id_uniq` for site ownership.

These inventory tables already receive writes. Follow the shipped `2026-10-08-101100-billing-evidence-fk-targets.sql` and `autoMigrate.ts` no-transaction path: the earlier index-only migration starts with `-- @no-transaction` and runs the following statements individually, outside an enclosing transaction:

```sql
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS devices_id_org_id_site_id_uniq
  ON public.devices (id, org_id, site_id);
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS discovered_assets_id_org_id_site_id_uniq
  ON public.discovered_assets (id, org_id, site_id);
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS topology_manual_nodes_id_org_id_site_id_uniq
  ON public.topology_manual_nodes (id, org_id, site_id);
```

Declare all three keys in Drizzle. End the index-only migration with an idempotent catalog assertion (`DO $$ ... $$`) verifying each index is unique, valid, ready, nonpartial and covers exactly the intended columns, before the runner records the file as applied. Repeat that prerequisite check before the later foundation migration adds FKs; `IF NOT EXISTS` alone cannot certify an interrupted concurrent build. Add a failure/retry fixture: an invalid same-name index must block the FK migration. Recovery removes only the verified invalid index with standalone `DROP INDEX CONCURRENTLY`, then reruns the index migration and validity checks; never drop a valid index or mark a failed file applied. Measure index-build duration and concurrent heartbeat/device-write latency on the disposable fleet fixture and include that evidence in the schema PR. No unbounded plain index build on `devices` and no runner rewrite are part of this task.

Use idempotent `pg_policies` guards for SELECT/INSERT/UPDATE/DELETE policies with `breeze_has_org_access(org_id)`. Add scoped FKs for sites, devices, discovered assets and legacy manual nodes; exactly one binding reference is non-null. M0 relationships omit interface/support FKs until M1 creates those tables. Manual provenance and legacy reference/revision metadata remain typed bounded attributes. Add `legacy_source_revision` and `deleted_at` to position tombstones; reads omit deleted positions but a replay cannot resurrect an older save. Retain source revision fences on archived manual nodes/relationships. These are migration bookkeeping, not new public enums.

Register all seven tables in `CORE_ORG_CASCADE_DELETE_ORDER`, export every column, and give each an explicit merge disposition. Bindings enter both device lists and `DEVICE_SITE_DENORMALIZED_TABLES`; Task 10 proves pre-detachment. JSON attributes/settings/outbox payloads are `excludedOpen`; reviewed non-secret digest fields use `reviewedIncluded` where required. No unscoped allowlist exemption.

- [ ] Run the focused DB test, dedicated RLS catalog runner, index's complete lifecycle/export gate, migration ordering/reapplication and drift checks. Confirm policy behavior as `breeze_app`, not just a superuser seed connection.
- [ ] Commit schema, migration and registrations together: `feat(topology): add scoped graph foundation and lifecycle contracts`.

### Task 3: One authorization boundary for routes and services

**Files:** Create `apps/api/src/services/topology/access.ts`, `access.test.ts`; create `routes/topology/index.ts`, `access.test.ts`; modify `apps/api/src/index.ts` to mount `/topology`.

**Interfaces:** `TopologyCapability = 'read'|'write'|'execute'|'configure'`; `TopologyRequestContext` as index defines. `requireTopologySiteAccess(auth,permissions,siteId,capability): Promise<TopologyRequestContext>` resolves the site under request RLS, checks org access, intersects auth/permission site ceilings, and checks the permission matrix. `TopologyError` carries stable code/status without inaccessible object details.

- [ ] Test unauthorized, no role, wrong org, an allowed org with a forbidden site, empty site allowlist, unrestricted valid caller, and mixed-scope references. Verify a supplied `orgId` cannot choose authority. Use existing auth mocks from `discovery.topologyRead.test.ts` and `topology-layout-site-scope.integration.test.ts` as patterns.
- [ ] Run `pnpm --filter @breeze/api exec vitest run src/services/topology/access.test.ts src/routes/topology/access.test.ts`; confirm denial cases fail until the common gate exists.
- [ ] Implement current scope/permission checks using existing `siteAccessCheck`, `canAccessSite` and `hasPermission`; preserve their undefined/empty semantics. This pure helper tests the minimum permission requirements independently of DB lookup:

```ts
export function topologyPermissionPairs(capability: TopologyCapability) {
  const read = [['topology', 'read'], ['devices', 'read']];
  switch (capability) {
    case 'read': return read;
    case 'write': return [...read, ['topology', 'write']];
    case 'execute': return [...read, ['topology', 'execute'], ['devices', 'execute']];
    case 'configure': return [...read, ['topology', 'write'], ['devices', 'write'], ['devices', 'execute']];
  }
}
```

Keep MFA and per-origin execution checks in the action path too; this helper is not an execution capability. Mount authenticated topology subrouters; resolve unknown/out-of-scope objects as 404 and missing operation permission as 403. Do not grant `topology:execute` yet; M1 owns the new permission migration. M0 tests the execute matrix as a pure unit contract using a constructed permission set and verifies real missing-grant denial; no M0 seeded role or endpoint gains execution capability. M1 adds the permission and the positive real-DB execute-authority tests together.

- [ ] Run unit cases plus same-org site-denial API integration; prove DB org access alone does not grant API site access.
- [ ] Commit `feat(topology): centralize graph scope and permission checks`.

### Task 4: Partner/org flags and passive capability settings

**Files:** Create `apps/api/src/services/topology/flags.ts`, `flags.test.ts`, `routes/topology/settings.ts`, `settings.test.ts`; modify `apps/api/src/config/env.ts` for an optional default-off deployment kill switch and `schema/index.ts` only if exports need adjustment.

**Interfaces:** `TopologyFlags` has materialization/ui/physical/interfaceHealth/diagnostics/ai booleans. `resolveTopologyFlags({partnerSettings,orgSettings,globallyDisabled})` is pure. `loadTopologyFlags(ctx)` follows `mlFeatureFlags.ts`'s request-scoped org read then partner-axis visibility pattern. `getTopologyCapabilities(flags,siteGraphReady,agentCapabilities)` exposes effective feature availability and reason codes.

- [ ] Test defaults, partner true/org false, wrong types, global kill switch, inaccessible org, UI-on/materialization-off and pre-first-build preparing state.
- [ ] Run `pnpm --filter @breeze/api exec vitest run src/services/topology/flags.test.ts src/routes/topology/settings.test.ts`; confirm absent behavior fails.
- [ ] Implement strict boolean overrides, no arbitrary truthiness or site flags. The core resolver decision is:

```ts
const effectiveUi = flags.ui && flags.materialization && siteGraphReady;
const uiReason = !flags.materialization ? 'materialization_disabled'
  : !siteGraphReady ? 'topology_preparing' : !flags.ui ? 'ui_disabled' : null;
```

The GET settings response includes resolved flags, capability reasons and current settings revision; it creates no site row or job. Pre-M1 collection/diagnostic capabilities remain unavailable. The deployment flag is optional and generic; add no internal hostnames or required production environment variable. Legacy capture is outside this resolver's dispatch gates.

- [ ] Verify settings reads create zero outbox rows/commands and do not bypass tenant RLS. Run the focused tests.
- [ ] Commit `feat(topology): resolve rollout flags from partner and org settings`.

### Task 5: Transactional legacy capture before import

**Files:** Create `apps/api/src/services/topology/legacyCapture.ts`, `legacyCapture.test.ts`, `apps/api/migrations/<next-ordered-slot>-topology-legacy-capture.sql`; modify legacy mutation paths in `routes/discovery.ts`; create `src/__tests__/integration/topology-capture.integration.test.ts`.

**Interfaces:** `TopologyTransaction` derives from `db.transaction`'s callback type. `enqueueTopologyChange(tx,scope,event): Promise<string>` returns a per-site captured revision. `LegacyTopologyEvent` is a discriminated union of node/relationship/layout upsert/delete and binding-change events, carrying legacy table/ID, old/new scoped identity, bounded data and idempotency key. SQL trigger capture and TypeScript capture obey one serialization protocol.

- [ ] Write concurrent-transaction tests: rolled-back writer creates no event; committed manual/layout edits create exactly one effective event; deletion carries a tombstone; site move records both old removal and new scope; v2 mirror writes cannot loop. Add a delayed commit where ID allocation precedes the snapshot barrier but commit follows it.
- [ ] Run `pnpm --filter @breeze/api test:integration src/__tests__/integration/topology-capture.integration.test.ts`; expect the lost-event case to fail initially.
- [ ] Install the database capture backstop in the migration, covering old application versions and direct SQL on `topology_manual_nodes`, `topology_layout`, and manual rows of `network_topology`. Capture relevant device/asset identity/site/link/type/label changes; ignore heartbeat counters and unchanged inventory updates. Lock/increment the site's capture revision in the same transaction before inserting its event. The serialized core is:

```sql
INSERT INTO topology_site_state (org_id, site_id)
VALUES (event_org_id, event_site_id) ON CONFLICT DO NOTHING;
UPDATE topology_site_state
SET dirty_revision = dirty_revision + 1
WHERE org_id = event_org_id AND site_id = event_site_id
RETURNING dirty_revision INTO captured_revision;
```

Define `event_org_id`, `event_site_id`, `captured_revision` as PL/pgSQL trigger locals sourced from OLD/NEW validated rows, not session-supplied tenant values. Cross-site events acquire site locks in sorted UUID order. Normalize event payload/version and bound row size. The mutation and capture must fail together; never swallow outbox failure. SQL triggers are the sole capture owner for legacy table and inventory mutations: remove any route-side duplicate enqueue for those writes. The TypeScript helper calls the same SQL serialization/enqueue function only for v2-only facts or intents that do not modify a trigger-covered source row. A compatibility mirror is captured once by its legacy trigger; its consumer recognizes the already-applied canonical value and advances only the consumed checkpoint. Persist event idempotency/source revisions for delivery retries, never use a security GUC to suppress capture. Test captured event count as well as final graph equality. Mirrored v2 events consume as idempotent matches rather than emitting another canonical write loop.

- [ ] Exercise capture with materialization/UI flags off and a legacy client payload, plus retry/replay and delete-vs-save races. Confirm no uncaptured legacy writer remains before allowing import.
- [ ] Commit `feat(topology): capture legacy changes transactionally before backfill`.

### Task 6: Scoped identity and atomic fenced publication

**Files:** Create `services/topology/identity.ts`, `identity.test.ts`, `publish.ts`, `publish.test.ts`, and `src/__tests__/integration/topology-publication.integration.test.ts`.

**Interfaces:** `canonicalIdentityKey(scope,kind,sourceKey)` uses canonical scoped material, never bare IP/name. `PublicationInput = {buildFence:string;inputRevision:string;nodes:NodePublication[];relationships:RelationshipPublication[];bindings:BindingPublication[]}`; row types are scoped Drizzle insert projections with server-owned fields. `publishTopologyBuild(scope,input)` returns `{published,graphRevision}`. M1 extends the typed transaction payload, not the transaction ownership.

- [ ] Test stable identity through label/IP change, distinct reused prefixes across sites, preserving accepted managed/discovered links, alias rejection across scope, and older worker rejection after a newer build. Add concurrent DB readers proving no half-published endpoints/edges.
- [ ] Run focused identity/publish units and `test:integration src/__tests__/integration/topology-publication.integration.test.ts`; fail the stale-worker case before implementing CAS.
- [ ] Implement scope-validated staged writes and publish under a locked site state row. Use decimal strings at JSON boundaries and bigint internally. The guard must be equivalent to:

```ts
const published = await tx.execute(sql`
  UPDATE topology_site_state
  SET materialized_input_revision = ${input.inputRevision}::bigint,
      graph_revision = graph_revision + CASE WHEN ${structuralChanged} THEN 1 ELSE 0 END
  WHERE org_id = ${scope.orgId}::uuid AND site_id = ${scope.siteId}::uuid
    AND build_fence = ${input.buildFence}::bigint
    AND materialized_input_revision < ${input.inputRevision}::bigint
  RETURNING graph_revision
`);
```

`structuralChanged` is computed inside the locked transaction by comparing validated staged structural fields with the current canonical rows; it is not a caller-supplied flag. Exclude layout, health, freshness timestamps and consumed outbox checkpoints from that comparison. An accepted no-change publication still advances `materialized_input_revision` and returns `published:true` with the existing graph revision. A stale/equal input returns `published:false`. Bind every parameter with Drizzle SQL, never string interpolation. Perform the guard and all canonical writes in one transaction; zero updated rows means roll back the staged graph and return `published:false`. Preserve a dirty revision newer than the snapshot, scheduling another build after commit. Legacy observations with unknown provenance remain unverified; no automatic `physical_link` promotion. Alias merges retain oldest canonical ID/manual facts/pins and stop on scope/pin conflicts.

- [ ] Run stale fence, equal-input idempotency, newer-dirty-input, transaction rollback and cross-scope forgery fixtures. Verify a health/layout update does not increment structural revision. Specifically, save a layout through an old client, drain its captured mirror, and assert that layout revision increments while graph revision is unchanged and the materialized input checkpoint advances. Replay the same event and require all three revisions to remain unchanged.
- [ ] Commit `feat(topology): publish canonical graphs with scoped revision fencing`.

### Task 7: Restartable backfill, ordered drain and shadow comparison

**Files:** Create `services/topology/legacyImport.ts`, `legacyProjection.ts`, their tests, `jobs/topologyOutboxWorker.ts`, `apps/api/scripts/topology-migrate.ts`, and integration `topology-legacy-import.integration.test.ts`; modify `services/workerRegistry.ts` for lifecycle/startup/shutdown.

**Interfaces:** `importLegacyTopologySite(scope,{batchSize,resumeToken})`, `drainTopologyOutbox(scope,{throughRevision})`, `compareLegacyTopology(scope,{throughRevision})`; CLI subcommands `capture-status`, `backfill`, `drain`, `compare`, `status` require explicit org/site or an audited authorized batch selection. `LegacyParityReport` returns barrier revision and imported/skipped/conflicted/manual/pin/tombstone counts, with safe opaque mismatch IDs.

- [ ] Seed manual nodes/edges/layouts, inferred legacy links, a linked agent/asset, duplicate IPs across sites and a late writer. Tests crash between batches and deliveries, retry them, and demand identical canonical IDs/positions/pins with no resurrected deletion.
- [ ] Run `pnpm --filter @breeze/api test:integration src/__tests__/integration/topology-legacy-import.integration.test.ts`; expect missing import/drain behavior to fail.
- [ ] Implement the barrier using capture's per-site serialization and a consistent snapshot, then restartable upserts keyed by legacy table/ID. Persist source revisions on canonical records and deleted position/node/relationship tombstones. A basic replay decision is:

```ts
export function shouldApplyLegacyRevision(stored: string, incoming: string): boolean {
  return BigInt(incoming) > BigInt(stored);
}
```

Test equal/older/newer revisions; source IDs are not commit watermarks. Fold events in captured revision order; mark delivered only after the canonical transaction commits. Preserve explicit pins and conservatively pin imported legacy drag positions without reliable intent. Quarantine ambiguous/mismatched references with counted reasons. Use actual `linkedDeviceId` acceptance, never name/IP matching. A deletion cannot disappear from the fence merely because delivered outbox retention expired.

Expose the CLI as `pnpm --filter @breeze/api exec tsx scripts/topology-migrate.ts <subcommand> --org <uuid> --site <uuid>` with JSON reports and nonzero exit on incomplete capture, unresolved barrier or parity mismatch. Workers use the existing registry and explicit system context, coalesce by site, retry idempotently, preserve undelivered events and alert on aged backlog. No automatic backfill on GET/startup.

- [ ] Run capture/import/publication suites together. Compare only after draining to the same barrier, requiring zero unexplained manual/pin/deletion mismatches. Prove Redis downtime preserves accepted events and repair scheduling resumes consumption.
- [ ] Commit `feat(topology): import and compare legacy graphs without losing edits`.

### Task 8: Passive graph, search, evidence and expansion API

**Files:** Create `services/topology/graph.ts`, `graph.test.ts`, `routes/topology/graphs.ts`, `graphs.test.ts`, integration `topology-graph-scope.integration.test.ts`; extend the route hub from Task 3.

**Interfaces:** `getTopologyGraph(ctx,GraphQuery): Promise<GraphResponse>`; scoped node/relationship/evidence readers; bounded cursor/frontier encoding keyed by actor permission version/site/view/filter/graph revision. Tokens carry expiry and use existing signing primitives; never use a plain client-supplied group ID as authority.

- [ ] Write route fixtures for API §5 reads, filtered counts, malformed UUIDs, stale cursors, inaccessible evidence and expansions, and side effects. Assert zero command/scan/model/outbox calls for every GET. An exact graph test includes:

```ts
expect(body.counts.visibleNodes).toBe(body.nodes.length);
expect(body.counts.omittedNodes).toBe(body.counts.totalNodes - body.counts.visibleNodes);
expect(body.presentation.edges.every((edge: PresentationEdge) =>
  edge.presentationOnly && edge.relationshipKind === null)).toBe(true);
expect(commandDispatch).not.toHaveBeenCalled();
```

`commandDispatch` is the test's `vi.fn()` mock of existing command transport, not a production dependency of the reader. Seed graph rows explicitly; do not generate empty arrays that make these assertions vacuous.

- [ ] Run `pnpm --filter @breeze/api exec vitest run src/services/topology/graph.test.ts src/routes/topology/graphs.test.ts`; confirm unimplemented reads fail.
- [ ] Implement read-only queries with explicit org/site filters; projections respect node/edge bounds, one pinned revision and typed counts/frontiers. Default 500 nodes/1,000 edges, maximum 1,000/2,000 visible. A changed cursor returns 409 `graph_revision_changed`. Queries never synthesize persisted rows. Before M1, health and source evidence are unknown/unmonitored or legacy summaries; before physical discovery, physical view may be empty. Include private permission-scoped ETags; diagnostics/evidence details use no-store as specified.

```ts
const rows = await db.select().from(topologyNodes).where(and(
  eq(topologyNodes.orgId, ctx.scope.orgId),
  eq(topologyNodes.siteId, ctx.scope.siteId),
  eq(topologyNodes.lifecycle, 'active'),
)).limit(query.limit + 1);
```

Use indexed counts and separate bounded relationship queries; do not fetch the whole site then slice. Search escapes user text and uses the same scope. Revalidate frontier ownership and current permissions on every expansion.

- [ ] Run graph API units/integration including two same-org sites and a multi-org partner actor. Verify read traffic does not change graph/layout revisions or last-observed timestamps.
- [ ] Commit `feat(topology): expose passive scoped graph projections`.

### Task 9: Revisioned manual/layout writes and compatibility adapters

**Files:** Create `services/topology/manual.ts`, `layouts.ts`, tests; create `routes/topology/manual.ts`, `layouts.ts`, tests; modify legacy discovery writes to reuse the compatible service layer; create integration `topology-compatible-writes.integration.test.ts`.

**Interfaces:** `saveTopologyLayout(ctx,view,LayoutPatch): Promise<LayoutWriteResult>`; `createTopologyManualNode`, `updateTopologyManualNode`, `deleteTopologyManualNode`, `createTopologyManualRelationship`, `deleteTopologyManualRelationship`. All take validated context, expected revision where mutable, and bounded Data §5 inputs; return accepted canonical identity plus legacy identity when representable.

- [ ] Test two simultaneous editors, stale revision, cross-site node injection, mixed valid/invalid batch atomicity, explicit unpin keeping coordinates, manual edge deletion preserving observed support, and legacy/v2 round trips. Interface references are unavailable until M1 installs interfaces, so M0 rejects requested interface binding explicitly.
- [ ] Run focused manual/layout route tests and compatibility integration; expect stale writers to overwrite until CAS is implemented.
- [ ] Use one transaction to lock/check layout revision, validate all node scopes, write finite positions/pins and increment layout revision once. Core CAS:

```ts
const updated = await tx.execute(sql`
  UPDATE topology_layouts SET revision = revision + 1
  WHERE org_id = ${ctx.scope.orgId}::uuid AND site_id = ${ctx.scope.siteId}::uuid
    AND view = ${view} AND revision = ${input.expectedRevision}::bigint
  RETURNING id, revision
`);
```

On zero rows return 409 without partial position writes. Ordinary dragging/pinning is an explicit client mutation; no server “first layout” job. Manual facts are `manual/asserted`, never observed. Compatible writes mirror to legacy within the captured transaction; v2-only synthetic relationships remain v2 and survive rollback. A v2 mirror's captured echo is idempotent under Task 7. A manual-node delete tombstones dependent manual work and saved position references, with audit and source-revision fences; it cannot delete measured inventory.

- [ ] Run legacy read/write compatibility fixtures plus new routes. Verify layout writes increment only layout revision and explicit manual graph edits increment structural revision. The legacy frontend's existing `runAction` feedback contract remains intact; M1 applies it to the new UI.
- [ ] Commit `feat(topology): preserve manual work across versioned graph writes`.

### Task 10: Device movement, organization merge and erasure proof

**Files:** Modify `routes/devices/core.ts`, `routes/discovery.ts`, `services/orgMerge.ts`, `services/orgMergeRegistry.ts`, `services/tenantCascade.ts`; create `services/topology/tenantLifecycle.ts` and its colocated tests; create a forward lifecycle migration after the foundation/capture migrations; create `topology-lifecycle.integration.test.ts` and extend `orgMergeRegistry.integration.test.ts` trigger classifications.

**Interfaces:** `detachTopologyInventoryBinding(tx,{kind,id,oldScope,newScope|null})` performs current-binding detachment and audit/dirty marking; SQL BEFORE trigger backs up actual site changes/deletion. `prepareTopologyOrgMerge(loserOrgId,survivorOrgId): Promise<{siteIds:string[]}>` and `finalizeTopologyOrgMerge(loserOrgId,survivorOrgId,siteIds): Promise<{rekeyed:number;fenced:number}>` use the merge engine's ambient Phase-B transaction proxy, never open a nested transaction or perform work after commit. M1 extends source/diagnostic fencing in the same lifecycle transaction once those tables exist. No references to missing future tables in M0 SQL.

- [ ] Test individual device/site moves, discovered-asset moves and deletion through both app services and direct SQL; prove bindings are gone before generic org/site denormalization. Test org merge preserving site/canonical IDs, manual work and pins, then org/partner erasure removing exactly the tenant's rows. After merge, read the graph and repeat canonical identity lookup under the survivor: require the original UUIDs, no duplicate nodes, preserved positions and rejection of a pre-merge worker fence.
- [ ] Run `pnpm --filter @breeze/api test:integration src/__tests__/integration/topology-lifecycle.integration.test.ts src/__tests__/integration/orgMergeRegistry.integration.test.ts`; confirm missing lifecycle hooks fail before implementation.
- [ ] Implement BEFORE site-change/delete detachment; retain original canonical history for individual moves. The trigger condition is actual site change, not a blanket block on org updates:

```sql
IF TG_OP = 'DELETE' OR NEW.site_id IS DISTINCT FROM OLD.site_id THEN
  -- Call the scoped detach/audit function for OLD.id and OLD.org_id/OLD.site_id.
  PERFORM breeze_detach_topology_device_binding(OLD.id, OLD.org_id, OLD.site_id);
END IF;
```

Create the called SQL function in the same migration with explicit old-scope deletion, immutable association audit and dirty marking; handle DELETE separately before evaluating NEW fields in final PL/pgSQL. Merged org-only updates retain the same site and rely on deferred final-state FKs. The registry repoints ownership; it cannot rekey derived identities by itself. Wire the two lifecycle helpers into `executeOrgMerge` in `services/orgMerge.ts`: after the existing export/org locks and deferred-constraint setup but before either registry pass, `prepareTopologyOrgMerge` snapshots the loser's site IDs, locks their state rows in sorted UUID order and advances `build_fence`. After both resolve/move passes and existing post-pass fixups, call `finalizeTopologyOrgMerge` on that saved site set, still inside Phase B. Validate survivor ownership, recompute scoped node/relationship identity keys through Task 6's canonical key builder, normalize pending outbox ownership without changing source revisions, and increment graph/settings revisions to invalidate stale cursors and authority. Preserve canonical UUIDs, pins and layouts; let any collision or final-state mismatch roll back the entire merge. Record counts in the merge summary. Test the real `executeOrgMerge` path, not just helper calls. No generic registry entry is credited with these fixups. There is no owner-column immutability trigger or GUC bypass. Existing source/target organization merge locks and registry ordering are reused. M1's monitor site-column task owns correcting the asset-collision executor before adding monitor FKs; M0 must not advertise that later schema as installed.

- [ ] Run every lifecycle/export gate listed in the index plus actual move/merge/purge fixtures. Verify same-partner merge final FKs and zero rows retained under an erased org. Confirm columns added for capture/tombstones are classified in the export registry.
- [ ] Commit `feat(topology): preserve scope through inventory and tenant lifecycle`.

### Task 11: Foundation release proof and operational handoff

**Files:** Add `docs/testing/network-topology-m0.md`; extend capture/import/publication/compatibility test files with the complete rollout sequence and machine-readable parity report assertions. Modify worker registry tests for clean startup/shutdown.

**Interfaces:** Release proof records commit, migration basenames, DB role, test commands, capture installation verification, snapshot barrier, drained revision and parity result. No customer addresses or raw payloads belong in tracked proof fixtures.

- [ ] Add an integration scenario that creates a legacy manual edge and pinned position, starts import, edits/deletes them concurrently, crashes the consumer, restarts, drains and compares. Assert:

```ts
expect(report.pendingThroughBarrier).toBe(0);
expect(report.unexplainedManualDifferences).toEqual([]);
expect(report.unexplainedPinDifferences).toEqual([]);
expect(report.resurrectedTombstones).toEqual([]);
```

These are explicit fields of `LegacyParityReport`, implemented in Task 7; extend that type before using them if its initial version lacked a field. Include a failing fixture with capture deliberately absent, and require CLI refusal before any import writes.

- [ ] Run the full new topology unit/integration subset, existing legacy topology tests, shared validators, migration checks and index lifecycle gates. Expected result is an actual non-vacuous pass; never use `--passWithNoTests`.
- [ ] Record the safe deploy procedure: install schema/hooks and capture first, verify all writer versions/backstop, backfill selected authorized sites, drain, compare, leave UI/diagnostics/AI flags false. Example operational command shape:

```bash
pnpm --filter @breeze/api exec tsx scripts/topology-migrate.ts capture-status --org "$TOPOLOGY_ORG_ID" --site "$TOPOLOGY_SITE_ID"
pnpm --filter @breeze/api exec tsx scripts/topology-migrate.ts backfill --org "$TOPOLOGY_ORG_ID" --site "$TOPOLOGY_SITE_ID"
pnpm --filter @breeze/api exec tsx scripts/topology-migrate.ts drain --org "$TOPOLOGY_ORG_ID" --site "$TOPOLOGY_SITE_ID"
pnpm --filter @breeze/api exec tsx scripts/topology-migrate.ts compare --org "$TOPOLOGY_ORG_ID" --site "$TOPOLOGY_SITE_ID"
```

Those environment variables are explicit operator selections, not stored infrastructure values. The CLI must fail on absent/unauthorized scope. Rollback leaves capture enabled, stops materialization, retains schemas/manual data and permits legacy reads/writes; re-enable only after drain/parity.

- [ ] Review evidence for all task gates and obtain normal PR checks/review. W01 is complete only when capture-before-import, source revision fences, lifecycle and compatibility are proven; no public UI result is claimed for M0.
- [ ] Commit `test(topology): prove foundation migration and rollback parity` and close W01 only with the final completing PR.
