---
tracking_issue: LanternOps/breeze#5995
---

# Intelligent Network Topology Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Read the linked specification and this index before executing a milestone.

**Goal:** Give every known network a useful automatically arranged logical map, enrich it with measured physical links, and make the map useful for authorized diagnostics, monitoring and AI investigation.

**Architecture:** Add a site-scoped canonical graph alongside the legacy topology. Passive endpoint context and optional discovery feed ordered, fenced materialization; shared templates compile into site-local runtime configuration. Cytoscape renders projections, a browser ELK worker arranges them, and existing command/monitor/AI infrastructure supplies operational actions.

**Tech Stack:** Astro/React, Cytoscape, new pinned `elkjs`, Hono/TypeScript/Zod, Drizzle/PostgreSQL, BullMQ/Redis, cross-platform Go agents, Vitest and Playwright.

**Spec:** [Approved design](../../specs/monitoring/2026-09-15-intelligent-network-topology-design.md), [data/API contracts](../../specs/monitoring/2026-09-15-intelligent-network-topology-data-contracts.md), [collection](../../specs/monitoring/2026-09-15-intelligent-network-topology-collection.md), [operations/AI](../../specs/monitoring/2026-09-15-intelligent-network-topology-operations.md). The 2026-09-15 audit disposition and completed Fable/Codex advisor quorum are in design §13.

## Global constraints

- This package is the replacement implementation plan. The June 2026 topology design, four phase plans and index remain historical and non-dispatchable. Do not rerun their shipped migrations or recreate their existing permissions/tables.
- Organization/partner isolation uses enabled and forced RLS. User-specific site access is application-layer only; there is no `breeze_has_site_access`. Composite FKs enforce scope consistency, not a site's reader permissions.
- Runtime graph/run/layout data belongs to one org/site. Reusable template/version rows use partner XOR org ownership. `devices.site_id` is NOT NULL.
- Use `withDbAccessContext` in requests. Background work uses `runOutsideDbContext` then `withSystemDbAccessContext`, with explicit org/site predicates and current authority validation. An opaque scope object alone is never authorization.
- Every org-bearing table enters `CORE_ORG_CASCADE_DELETE_ORDER`, `CORE_TENANT_EXPORT_POLICY` and `orgMergeRegistry`; device bindings also enter `CORE_DEVICE_CASCADE_DELETE_TABLES`, `CORE_DEVICE_ORG_DENORMALIZED_TABLES` and `DEVICE_SITE_DENORMALIZED_TABLES`. Any new column on an existing registered table also requires export classification. All JSON/JSONB/bytea columns are `excludedOpen`.
- Tenant composite FKs are `DEFERRABLE INITIALLY IMMEDIATE`. XOR template tables also enter `DUAL_AXIS_TENANT_TABLES` and `XOR_OWNERSHIP_DUAL_AXIS_TABLES`, with own-partner SELECT-only policy and real second-axis forge tests. Published-content guards exclude owner columns; no merge GUC bypass.
- An individual inventory site move detaches current bindings before generic denormalization, retaining old canonical history. Whole-org merge preserves site/canonical IDs and repoints all graph ownership. M0 adds explicit prepare/finalize hooks inside the existing merge transaction to fence workers and recompute scoped identity keys; a generic registry repoint is insufficient. Same-IP asset collisions never reparent topology-bound monitors to another site: detach, disable, retain source-site history, require rebind.
- Flags live only in partner/org `settings.topologyFeatureFlags`: defaults → partner → org → deployment kill switch. `ui && materialization && siteGraphReady` gates the new UI; no site feature flags. Legacy capture continues independently of rollout flags.
- Canonical kinds are `network_member`, `default_route`, `egress_path`, `physical_link`, `attachment`; `build_fence` is the publication fence. Schematic objects use `presentation:` IDs and `meaning:'schematic'`, with no canonical relationship or diagnostic authority.
- `discovered_assets.typeSource = 'manual'` overrides remain sticky. Topology role inference does not rewrite inventory type.
- Reads never dispatch probes/scans/model queries, create schedules, or save layouts. All mutations use `runAction` in the web app. Only `topology:execute` is a new permission; existing `topology:read/write` are reused.
- Passive collection defaults to five minutes ±10% jitter. New actual reads with unchanged digests renew compact freshness without appended run/observation rows. Preserve the qualifying second-complete-miss transition. Failed/partial absence never removes support.
- Structural freshness expires after `max(3 × expectedInterval, 15 minutes)`; two complete misses at least five minutes apart withdraw source support. Collection's source/epoch/digest and quota rules are mandatory.
- No built-in public DNS or Internet probe target. Gateway checks use reported local context; configured DNS/Internet recipes without targets return `target_not_configured` with zero external dispatch.
- The layout controller/browser worker owns measurement and ELK. Explicit Apply/Save persists coordinates; first render does not. Existing CSP `worker-src 'self' blob:` must remain sufficient. No server ELK job.
- Prefer existing web tokens and components; hash navigation, accessible node/link lists, reduced motion, light/dark, 200% zoom and 390px viewport are required. E2E selectors use `data-testid` only.
- Go tests use `-race` and mocked network/OS seams. Real-DB tests use a disposable integration database and exercise unprivileged `breeze_app`; API unit-green is insufficient.

## Five milestones and tracking

The user approved the corrected specification and requested planning/registration on 2026-09-15. The plans are implementation instructions, not evidence any wave has shipped. GitHub `get_feature_status` is authoritative for execution status; the parent reference belongs in this file's frontmatter, not per-wave issue numbers in prose.

| Lifecycle key | Milestone and plan | Hard prerequisites | Deployable result |
| --- | --- | --- | --- |
| W01 | [M0 — Foundation](2026-09-15-intelligent-network-topology-m0-foundation.md) | Approved specification/quorum | Additive core schema, authorization, passive API, capture-before-backfill, drain/shadow tooling; default UI unchanged. |
| W02 | [M1 — Baseline](2026-09-15-intelligent-network-topology-m1-baseline.md) | W01; [monitor bug #5987](https://github.com/LanternOps/breeze/issues/5987) merged and verified | Useful logical map, endpoint collection/digest suppression, templates/bulk application, browser layout, explicit diagnostics; zero management protocols required. |
| W03 | [M2 — Physical enrichment](2026-09-15-intelligent-network-topology-m2-physical.md) ([amendments](2026-09-25-intelligent-network-topology-m2-amendments.md), [verification record](2026-09-15-intelligent-network-topology-m2-verification.md)) | W02 | Correct LLDP/CDP/FDB/UniFi evidence and physical/attachment projections with manual/exclusion support. |
| W04 | [M3 — Operations](2026-09-15-intelligent-network-topology-m3-operations.md) | W03 | Attributed interface history, authorized recurring checks, operational health, traces and cautious incident evidence. |
| W05 | [M4 — AI](2026-09-15-intelligent-network-topology-m4-ai.md) | W04 | Scoped cited explanations and approved bounded diagnostics through existing AI policy. |

`register_feature` created these five wave records under [feature #5995](https://github.com/LanternOps/breeze/issues/5995) on 2026-09-15. At registration, all waves were open and implementation had not started; consult the feature lifecycle for current execution status. The tool's `next_wave` is ordering, not proof that external blockers or release gates passed. Record W02's #5987 dependency explicitly in GitHub. No wave starts merely because registration completed. Planning review and registration do not deploy or turn on production flags.

A milestone can contain several reviewed commits or PRs, but its wave remains open until every required task and gate is complete. If a wave spans multiple PRs, use `Refs` with explicit remaining scope on intermediate PRs and `Closes` on the final completing PR. Do not mark partial work done. Do not add a sixth feature wave for #5987: it is an existing independent defect.

## File and ownership map

| Owner | New code domains | Existing integration seams |
| --- | --- | --- |
| M0 | Shared topology types/validators; API `schema/topology.ts`, `routes/topology/{index,graphs,manual,layouts,settings}.ts`, `services/topology/{access,flags,graph,identity,legacyCapture,legacyImport,legacyProjection,publish,tenantLifecycle}.ts`, outbox worker and migration CLI | `routes/discovery.ts`, `routes/devices/core.ts`, schema/index, lifecycle/export registries, API index/job startup, existing org/partner settings loader pattern |
| M1 | `schema/topologyCollections.ts`, `topologyTemplates.ts`, `topologyOperations.ts`; source ingestion/reconciliation; template and diagnostic services/routes/jobs; Go `internal/collectors/networkcontext/`; web `components/topology/` | Agent heartbeat/config/command transport; monitor site/executor integration; Discovery and both device-detail tab registries; web CSP/bundling; shared barrels |
| M2 | Physical protocol adapters/projector, exclusions schema/service, physical view | Existing discovery, SNMP FDB, UniFi collector/telemetry and M1 ingestion/materializer |
| M3 | Interface sample storage/rollups/history, scheduler/re-arm, trace and incident evidence | M1 diagnostic service, existing monitors/alerts, SNMP/UniFi collectors, topology inspectors |
| M4 | Topology AI tools, evidence bundles/approval/cache and UI integration | Existing AI registry/policy/streaming, M1 diagnostic service and M3 history/incident evidence |

Shared integration files cannot be edited concurrently across milestone branches. Within M1, OS collectors may be developed separately against one frozen payload contract; only their designated integration task edits heartbeat/transport. M2's SNMP and UniFi adapters can be developed independently after the normalized report contract is fixed; the projector/publication task serializes integration. M3/M4 wait for their registered predecessors rather than dispatching speculative parallel migrations.

## Cross-milestone contracts

Shared exports in `packages/shared/src/types/topology.ts` and validators in `packages/shared/src/validators/topology.ts` own API names. Database/API-only authority stays outside shared/browser bundles.

```ts
export type TopologyScope = { orgId: string; siteId: string };
export type GraphQuery = {
  view: 'overview' | 'physical' | 'logical';
  focusNodeId?: string;
  hops: 0 | 1 | 2;
  includeHealth: boolean;
  limit: number;
};
// GraphResponse and GraphNode/GraphRelationship/PresentationNode/PresentationEdge
// have the complete fields in Data §5; M0's validator task defines and tests them.
```

API-local `services/topology/access.ts` defines `TopologyRequestContext = { auth: AuthContext; permissions: UserPermissions; scope: TopologyScope }`, importing `AuthContext` from `middleware/auth.ts` and `UserPermissions` from `services/permissions.ts`. `requireTopologySiteAccess(auth, permissions, siteId, capability)` resolves the site/org and current permission/site ceilings, returning that context or a typed 403/404. Services recheck references under its scope; jobs rebuild current authority rather than deserialize an old request context.

M0's `graph.ts` exports `getTopologyGraph(ctx, query): Promise<GraphResponse>`; `publish.ts` exports `PublicationInput` and `publishTopologyBuild(scope, input): Promise<{ published: boolean; graphRevision: string }>` with `buildFence`, `inputRevision`, scoped nodes/relationships/bindings and atomic CAS. An accepted input always advances the consumed checkpoint; graph revision advances only when the publisher finds changed structural fields under its site lock. Layout/health/freshness-only replay never changes graph revision. M1 extends this typed input with staged interfaces/observations/support/alias changes in the same publication transaction; it does not inject arbitrary callbacks or create a second publisher.

M1's `collectionTypes.ts` defines `AuthenticatedTopologyProducer` and `NormalizedTopologyReport`. `collectionIngest.ts` exports `ingestTopologySourceReport`; `reconciliationTypes.ts` defines `TopologyProjectionInput/Delta`; `projectors.ts` exports `projectTopology`. M2 adds a pure `projectPhysicalTopology` adapter to that registry. Producers submit validated source reports; only the publication transaction writes canonical relationships/support.

M1 owns `planTopologyDiagnostic`, `createTopologyDiagnosticRun`, `dispatchTopologyDiagnosticRun`, `acceptTopologyDiagnosticResult` and `assessTopologyDiagnostic`, plus diagnostic worker/sweeper. M3 extends these with trace recipes and scheduled authority. M4 calls the same services through approved AI actions. No second command transport, diagnostic planner or health truth source is permitted.

M1 stores target/template/policy configuration with recurring activation unavailable until M3. The API must expose that capability and reject explicit activation with `capability_unavailable`, rather than acknowledge a non-running schedule. Any saved activation intent is inert; M3 requires fresh preview, current authorization and re-arm.

## Migration allocation and lifecycle gate

Choose migration filenames when each schema task starts, after fetching the target branch. Compare the greatest committed basename on both HEAD and fetched `origin/main` using JavaScript `localeCompare`, the runner's comparator. Use a strictly later `YYYY-MM-DD-HHMMSS-<slug>.sql`; dependent files use increasing HHMMSS slots. Re-check after rebasing. Do not reserve a stale date/slot in this plan or edit a shipped migration. At specification baseline the maximum was `2026-10-15-160010-backup-snapshots-layout-manifest.sql`, ahead of the plan date.

```bash
git fetch origin main
bash scripts/check-migration-naming.sh --staged
bash scripts/check-migration-naming.sh --against-ref origin/main
pnpm --filter @breeze/api exec vitest run src/db/autoMigrate.test.ts
pnpm db:check-drift
```

Each schema task includes its creating migration, Drizzle definition, same-PR RLS/lifecycle/export registrations and functional fixtures. M0 does not create dormant M1–M4 tables or reference them via impossible FKs. Later migrations add their columns/constraints only after creating their referenced tables. Naming a test in a plan is not a passing test result.

| Schema tranche | Owner and required disposition |
| --- | --- |
| Site state, nodes/current bindings, relationships, shared layouts/positions, change outbox | M0; org-direct RLS, all applicable device/site registrations, individual move + whole-org merge, compatibility tombstones/capture. |
| Interfaces, collection source/run/observation/support | M1; scoped source/epoch/digest indexes, compact current state independent of 30-day evidence retention, partition/admission bounds. |
| Template library/version/site bindings | M1; XOR policies/allowlists, site ceilings, deferred owner consistency, content-only immutability, SET NULL purge/re-arm contract. |
| Targets/policies/bindings, diagnostics/steps, monitor `site_id` | M1; export changes on `network_monitors`, pre-constraint asset-collision executor correction, same-site execution and retained history. |
| View exclusions | M2; same-scope relationship references; exclusion affects presentation, never underlying observations or alert suppression. |
| Interface samples/rollups | M3; partitioned retention, reset-aware metrics, all applicable lifecycle/export registrations. |
| AI | M4 reuses graph/diagnostic/audit/AI storage; no new topology tenancy shape. Any unavoidable new table requires an explicit spec amendment and advisor review before implementation. |

Run these gates against the disposable integration stack for each affected schema tranche:

```bash
pnpm --filter @breeze/api exec vitest run src/routes/devices/cascadeDelete.test.ts src/routes/devices/moveOrg.coverage.test.ts
pnpm --filter @breeze/api test:rls-coverage
pnpm --filter @breeze/api test:integration src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/orgCascadeFkOnDelete.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts src/__tests__/integration/orgLifecycleFoundations.integration.test.ts src/__tests__/integration/orgMergeRegistry.integration.test.ts src/__tests__/integration/orgMergeCustomExecutors.integration.test.ts
```

`test:rls-coverage` is the dedicated read-only catalog runner. `test:rls` selects only the session-context suite; it cannot substitute. The general integration runner installs truncating fixture hooks, so use only the disposable test database. New behavioral integration fixtures belong under `src/__tests__/integration/` or must be explicitly added to its include list and suite-coverage test. Use real `breeze_app` forge tests, not superuser-only inserts that bypass RLS.

## Capture, rollout and rollback checkpoints

1. Schema/lifecycle tests pass; migrations are additive/replayable. Deploy capture-capable writers or the database capture backstop before starting any import.
2. Capture every legacy manual/layout mutation transactionally, including deletions. Preserve capture independently of feature flags. Establish the import snapshot/barrier using the same per-site serialization; do not use `MAX(outbox.id)` as a commit watermark.
3. Import restartable site batches with source revision/tombstone fences; drain captured events; compare at a common barrier. Zero unexplained manual/pin/deletion differences is mandatory before UI pilot.
4. M1's zero-management fixture, worker/CSP/browser tests and 24-hour `I10K` soak pass. Only then enable a pilot organization; retain a seven-day observation window before broader rollout.
5. Immediately stop the implicated feature for any confirmed scope leak, lost edit/pin, wrong executor or unsupported physical/healthy assertion. Performance rollback: API p95 >1s or error rate >1% for two five-minute windows with ≥100 requests/window; reconcile p99 >60s for ten minutes; DB CPU or pool >80% for fifteen minutes; oldest queue item >60s for ten minutes; browser p95 interactive >4s or fallback >1% of ≥100 layouts.
6. Disable affected UI/producer/dispatch flags; preserve schema, new data and v2-only work. Continue legacy capture. Cancel safe queued diagnostics, audit in-flight outcomes, then drain and recompare before re-enable. Never drop undelivered edits to clear an alert.

The exact `G10K`, `V200`, `V500`, `V1000`, `I10K` fixtures, reference CPU/memory/browser throttling, sample counts and limits are normative in design §9. M1 owns their generator and baseline report; M2–M4 rerun impacted scenarios. No timing reported during planning is a benchmark measurement.

## Requirement coverage

| Spec requirements | Owning implementation and acceptance proof |
| --- | --- |
| T01–T04: useful, honest baseline | M1 Tasks 3–8, 20, 24: native context, atomic baseline projection and `baseline-no-management`; M2 Tasks 1–8: attributed physical enrichment. |
| T05: stable automatic layout | M0 Tasks 5–9: lossless revisioned positions; M1 Tasks 22–24: measured ELK worker, pins, explicit save/conflicts and production CSP/browser test. |
| T06–T07: identity and evidence | M0 Tasks 6–7: scoped identity/import; M1 Tasks 7–8: source digest/freshness/support; M2 physical identity, independent support and exclusion tests. |
| T08–T09: useful, cautious operational checks | M1 Tasks 14–19, 24: authorized durable diagnostics and monitor overlays; M3 Tasks 1–10: attributed telemetry, recurrence, trace and impact. |
| T10: passive reads | M0 Tasks 4, 8; M1 Tasks 20, 24; M3 Task 6; M4 Tasks 1, 5–6: zero-dispatch assertions on graph, history, selection and refresh. |
| T11: tenant/site isolation and lifecycle | Every schema tranche's real-DB gates; M0 Tasks 2–3, 10; M1 Tasks 2, 9–15, 18, 25; M2–M4 scoped read/write, moved-resource, authority and revocation tests. |
| T12: compatibility and controlled rollout | M0 Tasks 5–7, 9, 11; M1 Tasks 6, 15, 25: capture before import, delayed-commit fixture, ordered drain, old-agent tolerance and flag rollback. |
| T13–T14: scale and accessibility | M0 Task 8: bounded graph/search; M1 Tasks 20, 22–25: list parity, focus/zoom, production worker and exact fleet/visual performance fixtures. |
| T15: scoped cited AI | M4 Tasks 1–6: sanitized bounded evidence, approval pinning, validated output publication, live/replay/history revocation and deterministic fallback. |

## Verification and handoff

For each task, the plan specifies a failing behavior test, a focused implementation, passing evidence and a reviewable commit. Use colocated unit tests, standard integration helpers and `data-testid` E2E fixtures. Follow changed behavior with affected compatibility tests; do not rerun unrelated full suites repeatedly without a new concern.

Every implementation PR targets `main`, or explicitly dispatches `gh workflow run CI --ref <branch>` while stacked because branch-target filters otherwise omit CI. Required API/web/agent jobs and all relevant live-DB integration shards must pass; successful smoke-only checks are not sufficient. Review migration allocations again after merge/rebase.

Before dispatch: call `get_feature_status`; confirm the wave and external prerequisites, then use the registered feature branch naming and `start_wave`. Do not claim implementation began based on this document's existence. Production enablement/deployment is a separate execution action with the specified measured gates.

Planning verification: all 63 tasks were reviewed for file ownership, shared interfaces, specification coverage and executable acceptance gates. Targeted independent review findings were resolved for publication revisions, organization-merge fixups, uint64 storage, telemetry activation and AI output publication. Markdown links/anchors/tables/fences, task structure and whitespace checks passed. These are documentation checks; no application tests, migrations, feature enablement or deployment ran during planning.
