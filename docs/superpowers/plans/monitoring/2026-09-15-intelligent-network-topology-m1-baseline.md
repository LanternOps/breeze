# Intelligent Network Topology M1 Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a useful, automatically arranged logical network map without managed-switch discovery, with scoped evidence, reusable configuration, existing monitoring overlays, and explicitly requested diagnostics.

**Architecture:** Extend M0's canonical graph through versioned passive agent observations, digest-confirmed freshness, and ordered publication. Partner/org templates compile into site-local configuration; a durable diagnostic service authorizes each origin and bounded destination before using the existing command transport. Cytoscape renders browser-worker ELK placement; reads never probe or persist layout.

**Tech Stack:** Go platform collectors; TypeScript/Zod; Hono; PostgreSQL/Drizzle; BullMQ/Redis; Astro/React/Cytoscape; pinned `elkjs`; Vitest and Playwright.

**Spec:** [Design](../../specs/monitoring/2026-09-15-intelligent-network-topology-design.md), [data/API contracts](../../specs/monitoring/2026-09-15-intelligent-network-topology-data-contracts.md), [collection](../../specs/monitoring/2026-09-15-intelligent-network-topology-collection.md), [operations](../../specs/monitoring/2026-09-15-intelligent-network-topology-operations.md).

## Global Constraints

- Read the [implementation index](2026-09-15-intelligent-network-topology-INDEX.md) and completed M0 first. This plan also depends on the separate monitor executor correction [#5987](https://github.com/LanternOps/breeze/issues/5987); do not reproduce that bug fix here or enable diagnostics before its required behavior is available.
- This document is a plan. Its commands and commits are future execution steps; authoring the plan does not authorize application edits, commits, deployments, or GitHub writes.
- Canonical enums and API spellings come from Data. Organization RLS is enforced and forced; application authorization independently checks site access on reads, writes, dispatch, results, templates, exports, and replay.
- Every new table ships with its migration, RLS, cascade/export/merge registry entries, schema export, and real-DB tests in the creating change. JSON/JSONB/bytea export columns use `excludedOpen` with a reason. Composite org-bearing FKs are `DEFERRABLE INITIALLY IMMEDIATE`.
- M0 owns core state/nodes/bindings/relationships/layouts/positions/outbox. M1 creates interfaces, collection sources/runs/observations/support, templates, runtime target/policy/binding, and diagnostic tables. Add references to these tables in M1's migration; M0 must not refer to unborn M1 tables.
- Flags live in partner/org settings with the approved precedence and kill switch. There are no site feature flags. M1 reports `recurringMonitoring:false`; it stores disabled policy drafts and configuration intent. An explicit `enabled:true` request returns `capability_unavailable`. M3 requires a fresh preview and authority re-arm before activation.
- No external DNS name, public resolver, or HTTPS target is a production default. No GET, map render, selection, refresh, layout preview, or template publication starts probes, an LLM call, a schedule, or a shared-layout save.
- OS routes are logical facts; unknown gateway schematic connectors have `presentation:` IDs and `meaning:'schematic'`. Never create physical links from prefixes, routing, grouping, or ping results.
- Use hash state for navigation; every web mutation, including POST previews, uses `runAction`. Playwright queries use only `data-testid`.
- Windows, Linux, macOS, IPv4, IPv6, multi-interface, VPN, and unknown/partial capability states are required. Unit tests never access a real network; Go tests run with `-race`. `linux.go`/`linux_test.go`, `windows.go`/`windows_test.go` and `darwin.go`/`darwin_test.go` must explicitly start with their `//go:build linux`, `windows`, or `darwin` constraint: these basenames alone do not select GOOS. DNS cgo/no-cgo files/tests use `//go:build darwin && cgo` or `//go:build darwin && !cgo`. Common pure normalization/digest tests run on every OS.
- Reuse M0 `TopologyRequestContext` from `apps/api/src/services/topology/access.ts`, importing real `AuthContext` from `middleware/auth.ts` and `UserPermissions` from `services/permissions.ts`. `TopologyScope` alone is never user authorization.
- Allocate each migration strictly after the newest committed prefix, using `YYYY-MM-DD-HHMMSS-<slug>.sql`; refresh after rebase. Never edit or rename a shipped migration. No inner BEGIN/COMMIT. Cleanup SQL logs affected counts, including zero for suspected isolation failures.

## File and interface map

Existing files below are verified paths. Every path labeled **Create** is new work, including files that another task in this plan creates before a later task modifies them.

| Area | Create | Modify / consume |
| --- | --- | --- |
| Shared contracts | `packages/shared/src/validators/topologyCollection.ts`, `topologyConfiguration.ts`, `topologyDiagnostics.ts`; corresponding sibling tests; `packages/shared/src/testing/topologyFixtures.ts` | M0 `types/topology.ts`, `validators/topology.ts`, types/validator index exports |
| Collection persistence | `apps/api/src/db/schema/topologyCollections.ts`; `services/topology/collectionTypes.ts`, `collectionIngest.ts`, `collectionDigest.ts`, `collectionState.ts` | M0 schema/index, topology publication/outbox; agent heartbeat routes |
| Agent context | `agent/internal/collectors/networkcontext/{types,normalize,digest,linux,windows,darwin,dns_darwin_cgo,dns_darwin_nocgo,scheduler,state}.go` and platform sibling tests | `agent/internal/heartbeat/{heartbeat.go,ip_tracking.go}`; create `network_context.go` |
| Graph materialization | `services/topology/{reconciliationTypes,baselineProjector,projectors,reconcile,collectionRetention}.ts`, `jobs/{topologyReconcileWorker,topologyCollectionRetentionWorker}.ts` | M0 `publish.ts`, `graph.ts`, `tenantLifecycle.ts`, `services/workerRegistry.ts` |
| Lifecycle/monitor scope | `db/schema/topologyOperations.ts`, `services/topology/monitorScope.ts` | `schema/monitors.ts`, `routes/monitors.ts`, `jobs/monitorWorker.ts`, `orgMergeCustomExecutors.ts`, `tenantCascade.ts`, device lifecycle paths |
| Template configuration | `db/schema/topologyTemplates.ts`, `services/topology/{configurationTypes,settingsResolver,templateLibrary,templateApply,siteConfiguration}.ts`, `routes/topology/{templates,templateApplications,targets,policies}.ts`, `jobs/topologyTemplateApplyWorker.ts` | M0 `routes/topology/{index,settings}.ts`; existing governance helpers |
| Diagnostics | `services/topology/{diagnosticTypes,originEligibility,diagnosticPlanner,diagnosticRuns,diagnosticDispatch,diagnosticResults,diagnosticHealth,monitorOverlays}.ts`, `routes/topology/diagnostics.ts`, `jobs/{topologyDiagnosticWorker,topologyDiagnosticSweeper}.ts` | Existing command queue/dispatch/trust/offline/result paths and both agent transports |
| Agent diagnostics | `agent/internal/networkdiagnostic/{types,journal,policy,runner}.go` with tests; `heartbeat/handlers_topology_diagnostic.go` | Existing tools constants, heartbeat handler registry tests, network policy primitives |
| Web | `apps/web/src/components/topology/{TopologyExplorer,TopologyInspector,TopologyList,TopologyDiagnosticsPanel,TopologyConfiguration,TopologyTemplateApply}.tsx`; `useTopologyGraph.ts`, `layout.worker.ts`, `layoutTypes.ts`, `layoutAdapter.ts`, `layoutController.ts`, `layoutPersistence.ts` with sibling tests | DiscoveryPage, DeviceDetails, NetworkDeviceDetailPage, networkDevice/types, web package/lockfile |
| Acceptance | `apps/api/src/__tests__/helpers/topologyM1.ts`, named integration tests below; `scripts/topology/{fixtures,ingest-soak}.ts`; `e2e-tests/pages/TopologyPage.ts`, `e2e-tests/tests/{topology-baseline,topology-worker}.spec.ts` | M0 integration helpers, E2E fixtures/build configuration |

Public M0 seams remain `requireTopologySiteAccess(auth,permissions,siteId,capability):Promise<TopologyRequestContext>`, `getTopologyGraph(ctx,query):Promise<GraphResponse>`, `enqueueTopologyChange(tx,scope,event):Promise<string>`, and `publishTopologyBuild(scope,input):Promise<{published:boolean;graphRevision:string}>`. M1 extends `PublicationInput` with typed staged collections; it does not add an arbitrary transactional callback.

## Execution conventions

Run shell commands from the repository root unless a command specifies `cd agent`. Before new API tests, read two sibling tests and the existing integration setup. Integration tests seed fresh records per test; do not memoize seeds across `integration/setup.ts` truncation.

For each schema task allocate its actual migration filename at execution time. This command prints a path; pass its task-specific slug as the final argument and retain the result in `TOPOLOGY_MIGRATION`:

```bash
git fetch origin main
TOPOLOGY_MIGRATION="$(node --input-type=module - topology-m1-collection <<'JS'
import {execFileSync} from 'node:child_process';
import {basename} from 'node:path';
import {existsSync} from 'node:fs';
const files = ['HEAD','origin/main'].flatMap(ref => execFileSync('git',
  ['ls-tree','-r','--name-only',ref,'--','apps/api/migrations'], {encoding:'utf8'}).trim().split('\n'));
const latest = files.map(file => basename(file)).filter(n => /^\d{4}-.*\.sql$/.test(n))
  .sort((a,b) => a.localeCompare(b)).at(-1);
if (!latest || !/^\d{4}-\d{2}-\d{2}-/.test(latest)) throw Error('Expected date-prefixed committed maximum');
const m = latest.match(/^(\d{4}-\d{2}-\d{2})-(\d{2})(\d{2})(\d{2})-/);
const floor = m ? Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`) + 1000
  : Date.parse(latest.slice(0,10) + 'T00:00:00Z') + 86400000;
let stamp = Math.max(floor, Math.floor(Date.now()/1000)*1000);
for (;;) {
  const iso = new Date(stamp).toISOString();
  const name = `${iso.slice(0,10)}-${iso.slice(11,19).replaceAll(':','')}-${process.argv[2]}.sql`;
  const path = `apps/api/migrations/${name}`;
  if (name.localeCompare(latest) > 0 && !existsSync(path)) { console.log(path); break; }
  stamp += 1000;
}
JS
)"
```

For the runtime and template schema tasks use the same allocator with slugs `topology-m1-runtime` and `topology-m1-templates`. Recheck the committed maximum immediately before committing. Migrations and their registry/lifecycle tests are one review unit.

## Task 1: Lock collection, configuration, diagnostic types and fixtures

**Files:** Create the three shared validators and sibling `.test.ts` files listed above; create `packages/shared/src/testing/topologyFixtures.ts`, `packages/shared/src/testing/topology-vectors.json`, and `apps/api/src/services/topology/topology.fixtures.ts`. Modify M0 shared topology types and index exports.

**Interfaces:** Export `NetworkContextV1`, `TopologyConfigurationPayload`, `CreateTopologyDiagnosticRequest`, `TopologyDiagnosticPlan`, `TopologyDiagnosticResult`, `TopologyDiagnosticRun`, `TopologyHealthSummary` and their Zod schemas. Export `networkContextFixture():NetworkContextV1` and `diagnosticPlanFixture():TopologyDiagnosticPlan`; use fixed valid UUIDs, documentation-only addresses, and controlled `example.test` fixture targets. API fixture `topologyFixture()` supplies typed scope/otherScope/request context/producer/origin/subject/targets and imports those shared payloads; no fixture contacts a network.

- [ ] **Step 1: Add failing contract tests and checked-in canonical vectors.** Cover all row discriminators/bounds, absent-vs-null, IPv6 zone, credential-bearing target URLs, no raw step override, and defaults that contain zero external targets.

```ts
it('cannot call an unchanged partial report complete or inject a tenant', () => {
  const full = networkContextFixture();
  expect(networkContextV1Schema.safeParse({ ...full, orgId: crypto.randomUUID() }).success).toBe(false);
  expect(topologyConfigurationSchema.parse({}).targets).toEqual({});
  expect(createTopologyDiagnosticSchema.safeParse({
    recipeId: 'internet_basic', recipeVersion: 1, family: 'ipv4',
    subject: { kind: 'node', id: '10000000-0000-4000-8000-000000000001' },
    graphRevision: '1', steps: [{ type: 'shell', command: 'anything' }],
  }).success).toBe(false);
});
```

- [ ] **Step 2: Run and observe missing-schema/validation failures:** `pnpm --filter @breeze/shared exec vitest run src/validators/topologyCollection.test.ts src/validators/topologyConfiguration.test.ts src/validators/topologyDiagnostics.test.ts`.
- [ ] **Step 3: Implement discriminated schemas and fixture constructors.** Use `.strict()` for configuration/diagnostic requests. Passive reports explicitly reject uploaded identity/org/site fields, ignore unknown minor optional fields after byte validation, and return an unsupported-major receipt without failing the enclosing heartbeat. Define full/unchanged report union, decimal uint64 sequence, 512 KiB OS body,128 contexts and independently digested typed sections; per context bound128 interfaces,1,024 addresses,2,048 routes,512 rules,128 resolvers and4,096 neighbors. Validate counts equal array lengths, IP/family/prefix/zone combinations, context manifest completeness and required/optional fields exactly as Collection's row table. Preserve M0 canonical enums. Diagnostic results carry command/run/attempt/plan-digest IDs and actual method; no generic JSON command escape hatch.

```ts
export const topologyCapabilities = {
  passiveContext: true, explicitDiagnostics: true,
  recurringMonitoring: false, physicalEnrichment: false,
} as const;
// Requesting activation is an error, not a successful silent disable.
export function assertM1PolicyActivation(enabled: boolean): void {
  if (enabled) throw new Error('capability_unavailable');
}
```

- [ ] **Step 4: Re-run the exact tests, then `pnpm --filter @breeze/shared typecheck`.** Expect valid vectors to round-trip and every invalid branch to fail explicitly.
- [ ] **Step 5: Commit the listed shared/types/fixture files:** `git commit -m "feat(topology): define baseline collection and diagnostic contracts"` after staging only this task's files.

## Task 2: Add collection persistence with lifecycle registration

**Files:** Create `apps/api/src/db/schema/topologyCollections.ts`, `apps/api/src/__tests__/helpers/topologyM1.ts`, `apps/api/src/__tests__/integration/topologyCollections.integration.test.ts`, `apps/api/src/db/topologyCollections.registry.test.ts`, and allocated `topology-m1-collection.sql`. Modify `db/schema/index.ts`, M0 `db/schema/topology.ts`, `services/{tenantCascade,tenantExportPolicyRegistry,orgMergeRegistry}.ts`, shared `validators/topologyCollection.ts` and its test, and integration lifecycle coverage. Create `apps/api/src/services/topology/sequence.ts` and `sequence.test.ts` for the approved SQL-boundary sequence comparison.

**Interfaces:** Export `topologyInterfaces`, `topologyCollectionSources`, `topologyCollectionRuns`, `topologyObservations`, `topologyRelationshipSupport`. Extend M0 helpers through `seedTopologyM1Fixture()` returning fresh `{scope,otherScope,orgContext,otherOrgContext,producer,nodeId,interfaceId,foreignSiteNodeId}`; use existing `integration/db-utils.ts` seed functions and real DB contexts. It creates no commands or monitors.

- [ ] **Step 1: Add real-DB forge, deletion-order, retention and deferred-merge tests.** Create local/foreign node/interface data under system setup; use the unprivileged application role for the assertion.

```ts
it('rejects support whose interface belongs to another site in the same org', async () => {
  const f = await seedTopologyM1Fixture();
  await expect(withDbAccessContext(f.orgContext, () => db.execute(sql`
    INSERT INTO topology_interfaces (id,org_id,site_id,owner_node_id,interface_key,epoch)
    VALUES (${crypto.randomUUID()},${f.scope.orgId},${f.scope.siteId},
      ${f.foreignSiteNodeId},'adapter-1','1')
  `))).rejects.toMatchObject({ cause: { code: '23503' } });
});
```

- [ ] **Step 2: Run:** `pnpm --filter @breeze/api test:integration src/__tests__/integration/topologyCollections.integration.test.ts`. Expect missing-table or missing-constraint failure; confirm the assertion runs as `breeze_app`, not a bypass role.
- [ ] **Step 3: Implement the schema/migration and all registry additions together.** Source rows hold bounded current typed baseline/digests, accepted/materialized sequences, freshness, quotas, and pending miss metadata; changed runs are immutable; observation pointers may expire while compact support survives. Add M1 interface FKs to M0 relationships only now. Use explicit scoped/owner FKs and deferrable composite tenant constraints.

```sql
ALTER TABLE topology_interfaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE topology_interfaces FORCE ROW LEVEL SECURITY;
-- Guard policy creation through pg_policies in the idempotent migration.
CREATE POLICY breeze_org_isolation ON topology_interfaces
  USING (breeze_has_org_access(org_id))
  WITH CHECK (breeze_has_org_access(org_id));
ALTER TABLE topology_interfaces ADD CONSTRAINT topology_interface_owner_scope_fk
  FOREIGN KEY (owner_node_id,org_id,site_id)
  REFERENCES topology_nodes(id,org_id,site_id)
  DEFERRABLE INITIALLY IMMEDIATE;
```

Register each new table in org cascade and org merge with explicit disposition; classify every new export column, with bounded JSON still `excludedOpen`. Extend device/site move fencing and retain original-scope history. Managed device sites are non-null; do not invent a null-site managed backfill. Add triggers only with allowed-column classification in `orgMergeRegistry.integration.test.ts`.

**Review risk: new uint64 storage pattern.** This repository has no existing uint64-as-NUMERIC sequence precedent; do not treat a schema declaration or one maximum-value fixture as sufficient evidence. Every producer/source sequence column (accepted/materialized/confirmed and observation/support/source snapshots) uses PostgreSQL `NUMERIC(20,0)` with CHECK `sequence >= 0 AND sequence <= 18446744073709551615`, mapped as decimal strings, never JavaScript Number or signed bigint. Server-owned graph/revision counters remain bigint. Add a real-DB roundtrip of `18446744073709551615` plus rejection of the next integer and a negative value; exercise ordering against `9223372036854775808` to catch accidental signed coercion.

Export `topologySequenceSchema` from shared `validators/topologyCollection.ts` (canonical unsigned decimal string, no exponent/sign/leading zero except "0", maximum uint64). API `services/topology/sequence.ts` imports that schema and exports `compareTopologySequences(a,b)` using BigInt comparison only; the exported/wire value remains a string. Use the same primitive in M1 admission/high-water code and M3 sample validation. Drizzle declares `numeric({precision:20,scale:0})` in its string-returning mode; no `mapWith(Number)`, `parseInt`, lexical comparison or cast to signed bigint. SQL orders and compares the numeric column directly and binds validated decimal strings as numeric.

The schema PR's review checklist must show real PostgreSQL/driver/Drizzle round-trips at `0`, `9`, `10`, `9007199254740991`, `9007199254740992`, `9223372036854775807`, `9223372036854775808`, `18446744073709551615`; numeric ORDER BY and high-water CAS yield that order, duplicates/lower values cannot advance, and equal concurrent claims have one winner. API validation rejects decimals/exponents, negative/out-of-range values and noncanonical strings before SQL: `NUMERIC(20,0)` rounds fractional SQL inputs before a range CHECK, so the CHECK alone does not enforce wire spelling/integrality. Direct database tests enforce range and exact post-storage values without falsely expecting that CHECK to reject fractional pre-coercion inputs. Inspect the producer/source/epoch+sequence index and parameterized query plan on the defined I10K fixture (10,000 sources and 864,000 changed-run rows, its 28,800/day mixed-load budget ×30 days) for accidental text casts; record the chosen adapter and review results. M3 must reuse the approved mapping and boundary vectors rather than establish another pattern.
- [ ] **Step 4: Run the task integration test, `pnpm --filter @breeze/api test:rls-coverage`, `pnpm --filter @breeze/api exec vitest run src/db/topologyCollections.registry.test.ts src/services/topology/sequence.test.ts src/db/autoMigrate.test.ts`, `bash scripts/check-migration-naming.sh`, and `pnpm db:check-drift`.** Also run `pnpm --filter @breeze/shared exec vitest run src/validators/topologyCollection.test.ts` and the lifecycle suite bundle in Task 25 for this creating change, not only at milestone end.
- [ ] **Step 5: Stage the allocated migration plus listed schema/registry/tests; commit:** `git commit -m "feat(topology): persist scoped collection evidence and support"`.

## Task 3: Collect Linux interfaces, routes, rules and resolver context

**Files:** Create `agent/internal/collectors/networkcontext/{types.go,normalize.go,normalize_test.go,linux.go,linux_test.go,testdata/linux-dual-stack.json}`. Read existing `collectors/network.go`, `collectors/vpn_linux.go`, and `collectors/command_limits.go`; preserve their legacy APIs. Platform implementation/tests have explicit build tags as required above; common pure normalization tests are untagged.

**Interfaces:** `Collect(ctx context.Context, reader Reader) (Snapshot,error)`; `Reader` exposes `Interfaces`, `Routes`, `Rules`, `Resolvers`, `Neighbors`, and context enumeration returning typed rows plus explicit outcome. `LookupRoute(ctx, request RouteLookupRequest) (RouteSelection,error)` uses actual source/destination/family. `Snapshot` matches Task 1 vectors and separates context/family completeness.

- [ ] **Step 1: Add table-driven fake-netlink tests for IPv6 scoped gateways, policy tables, two equal-cost defaults, incomplete dumps and resolver fallback.** Tests inject readers; no socket opens.

```go
func TestLinuxScopedNextHopsDoNotMerge(t *testing.T) {
    got := NormalizeRoutes([]RouteRow{
        {ContextKey: "ns0/table254", Family: "ipv6", NextHops: []NextHop{{InterfaceKey: "if2", Address: "fe80::1", Zone: "if2"}}},
        {ContextKey: "ns0/table254", Family: "ipv6", NextHops: []NextHop{{InterfaceKey: "if3", Address: "fe80::1", Zone: "if3"}}},
    })
    if len(got) != 2 { t.Fatalf("scoped gateways collapsed: %#v", got) }
}
```

- [ ] **Step 2: Run:** `cd agent && go test -race ./internal/collectors/networkcontext/...`; expect the new collector/normalizer to be absent or the scope test to fail.
- [ ] **Step 3: Implement native NETLINK_ROUTE reads in the agent's current namespace only.** Preserve tables/VRFs/policy selectors; never reduce selection to lowest metric. Read systemd-resolved D-Bus, then NetworkManager, then bounded resolv.conf fallback with partial split-DNS coverage. Read neighbor cache passively. Represent complete empty separately from timeout/unsupported; validate all size limits and preserve inactive interfaces for evidence.

```go
func ScopeKey(namespace, table, iface, family string) string {
    return strings.Join([]string{namespace, table, iface, family}, "|")
}
// A dump failure cannot become an authoritative empty snapshot.
func FailedSection(kind, scope string, err error) Section {
    return Section{Kind: kind, ContextKey: scope, Outcome: "failed", ReasonCode: classifyReadError(err)}
}
```

Define `classifyReadError(error) string` alongside the collector with fixed timeout/permission/unsupported/malformed codes and tests; never upload raw command output.
- [ ] **Step 4: Run the same race suite on Linux; test nil rows, malformed netlink lengths, cancellation, cache-only neighbor reads and absence of external calls.** Build the agent on Linux using its normal build command; no new network dependency is required.
- [ ] **Step 5: Stage the new package files and commit:** `git commit -m "feat(agent): collect Linux logical network context"`.

## Task 4: Add Windows native network context

**Files:** Create `agent/internal/collectors/networkcontext/windows.go`, `windows_test.go`, `testdata/windows-compartments.json`; modify common types only for a platform-neutral missing field.

**Interfaces:** Implement Task 3 `Reader` through injected IP Helper adapters. `GetAdaptersAddresses`, `GetIpForwardTable2`, and `GetBestRoute2` supply addresses/routes/actual selection; current compartment is explicit. Adapter GUID identity survives changing OS interface indexes.

- [ ] **Step 1: Write Windows-tagged table-driven tests for GUID-preserving index change, multiple families/gateways, absent DNS, and denied compartment access.**

```go
func TestWindowsAdapterIdentityIgnoresIndexReuse(t *testing.T) {
    first := InterfaceIdentity(Adapter{GUID: "adapter-a", Index: 7})
    moved := InterfaceIdentity(Adapter{GUID: "adapter-a", Index: 12})
    replacement := InterfaceIdentity(Adapter{GUID: "adapter-b", Index: 7})
    if first != moved || first == replacement { t.Fatal("adapter identity used ifIndex") }
}
```

- [ ] **Step 2: On the Windows runner run:** `go test -race ./internal/collectors/networkcontext/...` from `agent`; expect absent adapter implementation.
- [ ] **Step 3: Implement bounded buffer/retry handling and the injected Windows reader.** Preserve native source/route metrics without inventing a winner, indicate unsupported external compartments, and return explicit missing capability instead of parsed localized `route print` output.

```go
func InterfaceIdentity(a Adapter) string { return "windows-guid:" + strings.ToLower(a.GUID) }
```

Define `Adapter` with native GUID/index, family/address/prefix and resolver fields; the actual reader populates those fields through native APIs rather than names.
- [ ] **Step 4: Re-run native Windows race tests and `go build ./...` on Windows.** From a non-Windows checkout, `GOOS=windows GOARCH=amd64 go test -c ./internal/collectors/networkcontext -o /tmp/topology-networkcontext-windows.test.exe` verifies compilation only and does not replace the native run.
- [ ] **Step 5: Commit the Windows implementation/tests:** `git commit -m "feat(agent): collect Windows route and adapter context"`.

## Task 5: Add macOS route and scoped DNS collection

**Files:** Create `agent/internal/collectors/networkcontext/{darwin.go,darwin_test.go,dns_darwin_cgo.go,dns_darwin_nocgo.go,dns_darwin_nocgo_test.go,testdata/darwin-scoped-dns.txt}`.

**Interfaces:** Implement Task 3 reader through `x/net/route` and SystemConfiguration; no-cgo `ReadScopedDNS(ctx, runner) (ResolverSection,error)` parses fixed `scutil --dns` output through the existing bounded command pattern.

- [ ] **Step 1: Add fixtures for interface-scoped IPv6 routes, split DNS, VPN domains, malformed/truncated scutil output and no-cgo fallback.**

```go
func TestIncompleteScopedDNSNeverBecomesEmptyComplete(t *testing.T) {
    got := ParseScopedDNS([]byte("resolver #1\n  nameserver[0] : 127.0.0.1\n  if_index :"))
    if got.Outcome != "partial" { t.Fatalf("outcome=%s", got.Outcome) }
    if !got.Rows[0].IsLocalStub { t.Fatal("local stub became remote device") }
}
```

- [ ] **Step 2: On macOS run:** `cd agent && go test -race ./internal/collectors/networkcontext/...`; expect absent parser/reader failures.
- [ ] **Step 3: Implement native RIB parsing and DNS adapters.** Parse zone IDs and scoped routing rather than choosing the first default. Use fixed argument arrays with three-second/1 MiB subprocess limits; incomplete resolver scope remains partial.

```go
output, err := runner.Output(ctx, "/usr/sbin/scutil", "--dns")
if err != nil { return ResolverSection{Outcome: "failed", ReasonCode: "resolver_read_failed"}, err }
return ParseScopedDNS(output), nil
```

- [ ] **Step 4: Run native race tests and `CGO_ENABLED=0 go test ./internal/collectors/networkcontext/...` on macOS; also run `CGO_ENABLED=0 go build ./...`.** Race instrumentation requires cgo, so the no-cgo build is a separate supported-path check.
- [ ] **Step 5: Commit:** `git commit -m "feat(agent): collect macOS scoped routes and DNS"`.

## Task 6: Negotiate, schedule and persist passive reports

**Files:** Create `agent/internal/collectors/networkcontext/{digest.go,digest_test.go,scheduler.go,scheduler_test.go,state.go,state_test.go}`, `agent/internal/heartbeat/{network_context.go,network_context_test.go}`. Modify `heartbeat.go`, `ip_tracking.go`, API `routes/agents/{schemas,helpers,heartbeat}.ts`; create `routes/agents/networkContext.test.ts`.

**Interfaces:** `BuildReport(snapshot Snapshot,state ProducerState) (Report,error)`, `AcceptReport(receipt Receipt) error`, persisted epoch/counter and base digest. API configuration advertises `acceptedNetworkContextVersions:[1]` only with resolved materialization capability. `normalizeNetworkContext(producer,payload):NormalizedTopologyReport[]` is implemented in Task 7.

- [ ] **Step 1: Add shared-vector digest tests plus fake-clock scheduling and heartbeat tolerance tests.**

```ts
it('drops invalid optional topology telemetry without rejecting a healthy heartbeat', () => {
  const parsed = heartbeatSchema.parse({ metrics: { cpuPercent: 1, ramPercent: 20,
    ramUsedMb: 512, diskPercent: 30, diskUsedGb: 20 },
    networkContextV1: { version: 999, sequence: '-1' } });
  expect(parsed.metrics.cpuPercent).toBe(1);
  expect(parsed.networkContextV1).toBeUndefined();
});
```

- [ ] **Step 2: Run:** `pnpm --filter @breeze/api exec vitest run src/routes/agents/networkContext.test.ts`; `cd agent && go test -race ./internal/collectors/networkcontext/... ./internal/heartbeat/...`.
- [ ] **Step 3: Implement five-minute ±10% jitter, startup collection, ten-second event debounce, one extra collection/minute, and one in-flight read.** Persist sequence before starting a read; restart resumes it, state loss requests a new server epoch. `unchanged` requires an actual new read and acknowledged digest, not a resend. Daily full revalidation uses the same digest. Preserve legacy inventory/IP-history fields; populate a legacy gateway only when family/interface next-hop selection is unambiguous.

```go
if !config.AcceptsNetworkContext(1) { return nil }
sequence, err := state.AllocateSequence() // durable before collection
if err != nil { return err }
snapshot, err := networkcontext.Collect(ctx, reader)
if err != nil { snapshot.RecordCollectionError(err) }
report, err := networkcontext.BuildReport(snapshot, state.WithSequence(sequence))
if err != nil { return err }
return heartbeat.AttachNetworkContext(report)
```

Define those small interfaces in `state.go`/`network_context.go`; collect with the two-second normal and ten-second cancellation budget. Namespace/context enumeration and missing sections keep explicit outcomes. The API derives producer/org/site/configuration from authentication, never uploaded IDs. Invalid optional telemetry produces a typed per-report acknowledgement/reason for the agent and aggregate validation metrics; dropping it from accepted heartbeat data does not silently acknowledge its digest.
- [ ] **Step 4: Re-run tests on Linux and native Windows/macOS race jobs.** Assert unchanged content ignores timestamps/set ordering; changed completeness/context/missing rows changes digest; old servers receive no new field; no probe function is called.
- [ ] **Step 5: Commit:** `git commit -m "feat(topology): negotiate passive context reports and digest confirmations"`.

## Task 7: Admit changed evidence and compact unchanged confirmations

**Files:** Create `apps/api/src/services/topology/{collectionTypes,collectionDigest,collectionState,collectionIngest}.ts` and sibling tests; create `apps/api/src/__tests__/integration/topologyDigestIngest.integration.test.ts`; modify agent heartbeat integration from Task 6.

**Interfaces:** `AuthenticatedTopologyProducer={scope:TopologyScope;producerId:string;producerEpoch:string;configurationRevision:string;parentJobId?:string;parentCommandId?:string}`. `NormalizedTopologyReport={reportKind:'full';snapshot:NormalizedTopologySnapshot}|{reportKind:'unchanged';confirmation:TopologySourceConfirmation}`. Snapshot has source key `{protocol,contextKey,addressFamily}`, epoch/sequence/capture time/age/cadence/outcome/digest/manifest and typed observations. Confirmation references the exact accepted snapshot/digest with a new sequence/capture. Export `ingestTopologySourceReport(producer,report):Promise<TopologyIngestReceipt>` and `normalizeNetworkContext(producer,payload):NormalizedTopologyReport[]`.

- [ ] **Step 1: Write a real-DB test that measures row/revision deltas across new actual unchanged reads and a suppressed second empty collection.**

```ts
it('renews evidence without growing run history, but preserves the second miss', async () => {
  const f = await seedTopologyM1Fixture();
  await ingestTopologySourceReport(f.producer, f.fullRouteReport);
  const before = await f.readTopologyCounts();
  await ingestTopologySourceReport(f.producer, f.confirmRoute({ sequence: '2', elapsedMs: 300_000 }));
  expect(await f.readTopologyCounts()).toMatchObject({ runs: before.runs,
    observations: before.observations, dirtyRevision: before.dirtyRevision });
  await ingestTopologySourceReport(f.producer, f.emptyRouteReport({ sequence: '3' }));
  await ingestTopologySourceReport(f.producer, f.confirmEmpty({ sequence: '4', elapsedMs: 300_000 }));
  expect(await f.pendingMissTransitions()).toHaveLength(1);
});
```

Extend `topologyM1.ts` with the exact typed report builders and direct count/select helpers used here; freeze a fake clock and assert accepted timestamps instead of wall-clock sleep. Task 8 additionally asserts published graph revision stability after these confirmations.
- [ ] **Step 2: Run:** `pnpm --filter @breeze/api test:integration src/__tests__/integration/topologyDigestIngest.integration.test.ts`; expected failure is absent ingestion/compact state, not a skipped DB test.
- [ ] **Step 3: Implement scoped canonical digest validation, monotonic admission, compact confirmation and quota handling.**

```ts
if (report.reportKind === 'unchanged') {
  assertExactAcceptedBase(source, report.confirmation);
  await advanceConfirmationCAS(tx, source, report.confirmation);
  const miss = qualifyingSecondMiss(source, report.confirmation);
  if (miss) await enqueueTopologyChange(tx, producer.scope, miss);
  return unchangedReceipt(source, report.confirmation);
}
// Full unchanged revalidation takes the same path after recomputing its digest.
```

Define the three pure helpers and CAS helper in `collectionState.ts`; their tests cover epoch/config fencing, matching partial positive keys only, retries, missing facts, two complete misses ≥5 minutes apart, unknown-age spool, and source independence. Persist admitted changed snapshots plus accepted watermark/dirty revision atomically; no canonical graph writes. Ordinary unchanged confirmations append no runs/observations/outbox events and never advance graph revision. Admit six changed snapshots/hour with burst two,48/day and8 MiB/day per authorized producer across sections/epochs; org ceilings250,000/day and16 GiB/day. A once-only ≤128-scope initial bootstrap bypasses producer snapshot count only and shares byte/org ceilings. Epoch churn cannot reset quotas. Rejected changed content cannot renew freshness; coalesced unaccepted content invalidates its pending absence generation. Retain current normalized state beyond30-day evidence retention; aggregate metrics instead of per-tick successful audit rows.
- [ ] **Step 4: Run the integration test and `pnpm --filter @breeze/api exec vitest run src/services/topology/collectionDigest.test.ts src/services/topology/collectionState.test.ts src/routes/agents/networkContext.test.ts`.** Verify stale/foreign baselines cannot renew a published source, and noisy neighbor updates do not block valid independent route confirmations.
- [ ] **Step 5: Commit:** `git commit -m "feat(topology): bound collection history with scoped digest ingestion"`.

## Task 8: Materialize the useful logical baseline atomically

**Files:** Create `apps/api/src/services/topology/{reconciliationTypes,baselineProjector,projectors,reconcile,collectionRetention}.ts` and sibling tests; `apps/api/src/jobs/{topologyReconcileWorker,topologyCollectionRetentionWorker}.ts`; `apps/api/src/__tests__/integration/topologyBaselinePublication.integration.test.ts`. Modify M0 `services/topology/{publish,graph,tenantLifecycle}.ts`, `services/workerRegistry.ts` and closure tests.

**Interfaces:** `TopologyProjectionInput` contains ordered admitted snapshots/miss transitions, published identity/interface candidates, current per-source support, scope and pinned input revision. `TopologyProjectionDelta` contains nodes/relationships/bindings plus interface, observation and support mutations. `projectBaselineTopology(input):TopologyProjectionDelta`; `projectTopology(input)` registers baseline now and M2 physical projection later. `reconcileTopologySite(scope):Promise<{published:boolean;graphRevision:string}>` extends typed M0 `PublicationInput` with those staged mutations in one publication transaction.

- [ ] **Step 1: Add pure golden graphs and a fenced-publication integration test.**

```ts
it('shows a no-management network without inventing physical links', () => {
  const delta = projectBaselineTopology(topologyFixture().projectionInput);
  expect(delta.relationships.map(r => r.kind)).toEqual(expect.arrayContaining(['network_member','default_route']));
  expect(delta.relationships.some(r => r.kind === 'physical_link')).toBe(false);
  expect(delta.relationships.filter(r => r.kind === 'default_route')
    .every(r => r.sourceNodeId === topologyFixture().originNodeId)).toBe(true);
});
```

- [ ] **Step 2: Run:** `pnpm --filter @breeze/api exec vitest run src/services/topology/baselineProjector.test.ts`; `pnpm --filter @breeze/api test:integration src/__tests__/integration/topologyBaselinePublication.integration.test.ts`.
- [ ] **Step 3: Implement deterministic identity/context grouping and ordered publication.** Keep observer-local routing context; prefix/profile grouping is separately inferred. Gateway keys include family/context/zone; the Internet destination starts unknown/unmonitored. Missing gateways create presentation projections only. Preserve all alternative routes and manual/inventory bindings; unique supported gateway enrichment keeps canonical ID/positions.

```ts
const input = await loadPinnedProjectionInput(scope);
const delta = projectTopology(input);
return publishTopologyBuild(scope, {
  buildFence: input.buildFence, inputRevision: input.inputRevision,
  nodes: delta.nodes, relationships: delta.relationships, bindings: delta.bindings,
  stagedCollections: { interfaces: delta.interfaces, observations: delta.observations,
    support: delta.support, consumedEvents: input.eventIds },
});
```

Define `loadPinnedProjectionInput` in `reconcile.ts`; fold every accepted ordered event, including compact second misses. Concurrent ingest leaves another build due; obsolete build fences fail CAS. M0 publisher compares actual structural fields under its state lock: accepted no-change builds consume input revisions without incrementing graph revision. Graph reads never materialize, update rows, or mix staged and published objects. Workers run outside request DB context and are registered with placement verified by the closure test.

Create `expireTopologyEvidence(scope,now):Promise<{archived:number;deletedDetails:number}>` in `collectionRetention.ts` and schedule a bounded hourly retention sweep. Freshness is `effectiveCaptureAt + max(3*expectedCadence,15minutes)` using authorized cadence bounded1minute–24hours. Effective capture is the earlier of valid producer time and receipt minus monotonic capture age; unavailable spool age or producer time >5minutes ahead gives unknown freshness and requests a new snapshot. GET computes time-based stale state without writes even if the aging worker lags. Queue one ordered expiration transition per support generation, archive only7days afterfresh expiry, and remove30-day raw runs/observations in bounded batches after nulling optional historical-detail pointers. Keep compact current source baselines/support and unconsumed miss transitions beyond that retention; no periodic checkpoint run rows. Extend M0 `prepareTopologyOrgMerge(loser,survivor)`/`finalizeTopologyOrgMerge(loser,survivor,siteIds)` to fence source epochs and diagnostics, preserving the existing hook transaction/order and outbox event identities.
- [ ] **Step 4: Re-run tests plus `pnpm --filter @breeze/api exec vitest run src/services/workerRegistry.test.ts src/services/workerEntrypointClosure.contract.test.ts`.** Cover no-agent, empty configured network, no default route, failed route read, dual stack/VPN, reused ranges/sites, independent observers, canceled epoch and publication races.
- [ ] **Step 5: Commit:** `git commit -m "feat(topology): publish logical network baselines from ordered evidence"`.

## Task 9: Persist runtime configuration and diagnostics; fix monitor scope lifecycle

**Files:** Create `apps/api/src/db/schema/topologyOperations.ts`, `apps/api/src/services/topology/monitorScope.ts`, `apps/api/src/__tests__/integration/topologyMonitorScope.integration.test.ts` and allocated `topology-m1-runtime.sql`. Modify `db/schema/{index,monitors}.ts`, `routes/monitors.ts`, `jobs/monitorWorker.ts`, `services/{orgMergeCustomExecutors,tenantCascade,tenantExportPolicyRegistry,orgMergeRegistry}.ts`, `routes/devices/core.ts`, their lifecycle tests and `orgMergeCustomExecutors.integration.test.ts`.

**Interfaces:** Export `topologyProbeTargets`, `topologyMonitoringPolicies`, `topologyPolicyTargets`, `topologyMonitorBindings`, `topologyDiagnosticRuns`, `topologyDiagnosticSteps`. `detachTopologyMonitorAuthority(tx,scope,assetId,reason):Promise<void>` disables affected execution, clears live bindings and fences queued work without deleting historical results. Runtime tables have their complete Data §3 fields, including immutable plan snapshots, idempotency/body hash and scoped composite FKs; no future M3 telemetry table.

- [ ] **Step 1: Extend the existing same-IP/different-site merge integration fixture.** Add preserved canonical/manual/layout/history rows and a queued command; assert the deleted source asset does not donate its monitor to the surviving other-site asset.

```ts
expect(await f.monitorAfterMerge()).toMatchObject({
  orgId: f.targetOrgId, siteId: f.sourceSiteId, assetId: null, isActive: false,
});
expect(await f.liveMonitorBindings()).toEqual([]);
expect(await f.sourceNodeAfterMerge()).toMatchObject({ id: f.sourceNodeId, siteId: f.sourceSiteId });
expect(await f.acceptLateSourceResult()).toMatchObject({ historicalOnly: true });
```

Extend that fixture with these typed queries and result submission; independently test an ordinary individual asset move and a whole-org merge that preserves non-colliding bindings.
- [ ] **Step 2: Run:** `pnpm --filter @breeze/api test:integration src/__tests__/integration/topologyMonitorScope.integration.test.ts src/__tests__/integration/orgMergeCustomExecutors.integration.test.ts`; expect current asset reparent behavior to fail.
- [ ] **Step 3: Add nullable monitor site, backfill only asset-backed known sites and implement lifecycle detachment before adding its constraints.** Assetless legacy monitors remain null-site/ineligible. New topology virtual-target monitors require an explicit authorized site. Log mismatch/cleanup counts, including zero; unresolved records disable and require assignment. Add the six runtime tables with forced org RLS and all export/cascade/merge registrations now.

```ts
await detachTopologyMonitorAuthority(tx, sourceScope, sourceAsset.id, 'asset_merge_collision');
await tx.update(networkMonitors).set({ assetId: null, isActive: false })
  .where(and(eq(networkMonitors.orgId, sourceScope.orgId), eq(networkMonitors.assetId, sourceAsset.id)));
// Preserve each monitor's original site_id; do not assign survivor.id here.
```

The helper captures current monitor IDs before detachment, disables dependent policies, removes current bindings, invalidates source epochs and dispatch authority, then allows inventory deletion. Individual move hooks run before generic denormalization; extend M0 `services/topology/tenantLifecycle.ts` prepare/finalize org-merge hooks, preserving their ordered transaction, deferred final-state FKs, identity rekeying, build fences, pins/history and pending outbox IDs/source revisions. Register every trigger's allowed update columns. Actual monitor selection/dispatch must consume non-null same-site origin eligibility after #5987.
- [ ] **Step 4: Re-run the two integration tests, `pnpm --filter @breeze/api test:rls-coverage`, `pnpm db:check-drift`, and Task 25's lifecycle bundle in this creating change.** Verify direct same-org/different-site FK forgery fails while application read tests enforce site visibility.
- [ ] **Step 5: Stage this task's migration/schema/lifecycle/tests and commit:** `git commit -m "feat(topology): scope runtime monitoring and preserve merge history"`.

## Task 10: Add reusable template ownership and deferred constraints

**Files:** Create `apps/api/src/db/schema/topologyTemplates.ts`, `apps/api/src/__tests__/integration/topologyTemplateTenancy.integration.test.ts`, `topologyTemplateLifecycle.integration.test.ts` beside it and allocated `topology-m1-templates.sql`. Modify schema exports, `services/{tenantCascade,tenantExportPolicyRegistry,orgMergeRegistry,orgMergeCustomExecutors}.ts`, `__tests__/integration/rls-coverage.integration.test.ts` and lifecycle tests.

**Interfaces:** Export `topologyConfigTemplates`, `topologyConfigTemplateVersions`, `topologySiteTemplateBindings`. Only templates/versions have nullable XOR org/partner ownership and no site. Binding has one row per org/site and nullable pinned partner/org version references; all runtime provenance references added here are same-owner validated.

**Explicit playbook exception:** As Data §3 specifies, defer partner-wide playbook step 4 (configuration-policy feature linkage): do not add a `PARTNER_LINKABLE_FEATURE_TYPES` value or change `validateFeaturePolicyExists`/`FEATURE_TABLE_MAP` for topology. The explicit topology library and reviewed bulk-application flow own adoption; configuration-policy linkage needs a separately specified and tested integration.

- [ ] **Step 1: Add real-DB org/partner axis, own-partner SELECT-only, deferred ownership and erasure tests.** Seed fresh owners using the established `contractTemplatesPartnerRls.integration.test.ts` pattern.

```ts
it('allows final-state same-partner owner movement but rejects a foreign partner layer', async () => {
  const f = await seedTopologyTemplateFixture();
  await expect(f.bindForeignPartnerVersion()).rejects.toMatchObject({ cause: { code: '23514' } });
  await f.mergeOrganizationsWithConstraintsDeferred();
  expect(await f.publishedVersion()).toMatchObject({
    id: f.versionId, orgId: f.targetOrgId, contentDigest: f.originalDigest,
  });
});
```

Create `seedTopologyTemplateFixture` in `__tests__/helpers/topologyM1.ts` with explicit org/partner contexts and merge-service calls, not privileged writes masquerading as authorization.
- [ ] **Step 2: Run:** `pnpm --filter @breeze/api test:integration src/__tests__/integration/topologyTemplateTenancy.integration.test.ts src/__tests__/integration/topologyTemplateLifecycle.integration.test.ts`.
- [ ] **Step 3: Implement XOR checks, enabled/forced policies, owner-scoped unique keys and deferred constraint triggers.** The owner-match triggers on versions, bindings, parent owner and `organizations.partner_id` changes re-read surviving final rows at commit; lock org→template→binding in UUID order. Published immutability covers content/digest/schema/resolver/defaults only, allowing coordinated org owner movement. No blanket UPDATE revoke or privileged GUC bypass.

```sql
CHECK ((org_id IS NOT NULL)::int + (partner_id IS NOT NULL)::int = 1)
-- Separate SELECT-only policy, in addition to the normal dual-axis policy:
CREATE POLICY topology_template_own_partner_read ON topology_config_templates FOR SELECT
  USING (org_id IS NULL AND partner_id = breeze_current_partner_id());
```

Mirror that SELECT policy on versions. Add both tables to `DUAL_AXIS_TENANT_TABLES` and `XOR_OWNERSHIP_DUAL_AXIS_TABLES`. Binding layer FK uses SET NULL; version→template CASCADE. Purge disables/fences surviving runtime references before clearing provenance/digest; direct SET NULL also makes dispatch fail closed. Same-partner merge preserves published content/IDs and suffixes colliding stable keys with source UUID; cross-partner transfer refuses live former-partner references until explicit detach/rebind. Archive and revoke are distinct lifecycle states. Register JSON as `excludedOpen`, all scalar columns and trigger allowed sets; partner purge erases orgs first and then partner-owned rows.
- [ ] **Step 4: Run the two integration tests, RLS coverage, drift/migration guards, and Task 25 lifecycle bundle.** Include concurrent bind/transfer, historical provenance survival, purge of one owner with unrelated template survival, and binding SET NULL without inherited activation.
- [ ] **Step 5: Commit:** `git commit -m "feat(topology): add scoped reusable configuration templates"`.

## Task 11: Resolve pinned configuration and expose the template library

**Files:** Create `apps/api/src/services/topology/{configurationTypes,settingsResolver,templateLibrary}.ts` and sibling tests; `routes/topology/templates.ts`, `templates.test.ts`; modify M0 route hub. Add fixture payloads to the Task 1 shared testing module.

**Interfaces:** `resolveTopologySettings(input:TopologySettingsLayers):ResolvedTopologySettings` is pure and returns settings/digest/field provenance/validation effects. `listEligibleTopologyVersions(ctx:TopologyRequestContext):Promise<TopologyTemplateVersion[]>` exposes only published own-org/own-partner choices. Library CRUD derives ownership from auth and existing governance helpers; it never trusts uploaded partner IDs.

- [ ] **Step 1: Test whole-object replacement, false, tombstones, invalid references and site-reader selection without library administration.**

```ts
it('replaces named targets rather than inheriting hidden fields', () => {
  const layers = configurationLayersFixture();
  layers.partner.targets.api = { kind: 'https', hostname: 'old.example.test', path: '/health' };
  layers.organization.targets.api = { kind: 'tcp', hostname: 'new.example.test', port: 443 };
  const resolved = resolveTopologySettings(layers);
  expect(resolved.settings.targets.api).toEqual(layers.organization.targets.api);
  expect(resolved.settings.targets.api).not.toHaveProperty('path');
});
```

`configurationLayersFixture` returns validated layers with pinned defaults/schema/resolver versions and empty maps; add it to Task 1 fixture module.
- [ ] **Step 2: Run:** `pnpm --filter @breeze/api exec vitest run src/services/topology/settingsResolver.test.ts src/services/topology/templateLibrary.test.ts src/routes/topology/templates.test.ts`.
- [ ] **Step 3: Implement defaults→partner→org→site field-by-field resolution.** Allowlisted scalars inherit only on absence; arrays replace; named objects replace; tombstones remove; null rejects unless schema explicitly permits unset. Canonicalize effective settings and hash with pinned resolver/schema/default versions.

```ts
for (const layer of layers) {
  for (const [key, entry] of Object.entries(layer.targets ?? {})) {
    if (entry.kind === 'tombstone') delete targets[key];
    else targets[key] = structuredClone(entry);
  }
}
```

After replacement validate all policy target keys. Limit 64 targets/policies, 256 KiB and 64-character keys; reject concrete inventory/scope IDs and credentials. Library routes implement Data §5 paths, revision CAS, pagination100/max200 and immutable publish. Org administration uses `canMutateOrgWideGovernance`; partner administration uses `canManagePartnerWidePolicies`; eligible-site selection requires graph read but never leaks drafts. Publishing writes version/audit only, zero bindings/commands.
- [ ] **Step 4: Re-run those tests and shared configuration validator tests.** Cover every HTTP method's unauthorized/wrong-org/site-ceiling/validation/not-found/conflict path and archived/revoked adoption behavior.
- [ ] **Step 5: Commit:** `git commit -m "feat(topology): resolve pinned templates with explicit inheritance"`.

## Task 12: Preview and apply configuration across authorized sites

**Files:** Create `apps/api/src/services/topology/templateApply.ts`, `templateApply.test.ts`, `routes/topology/templateApplications.ts`, its sibling test, `jobs/topologyTemplateApplyWorker.ts`, and `__tests__/integration/topologyTemplateApply.integration.test.ts`. Modify route hub/worker registry; use existing audited job/task persistence plus M0 outbox, not a new unregistered operations table.

**Interfaces:** `previewTopologyTemplateApplication(auth,permissions,request):Promise<TopologyTemplatePreview>`; `applyTopologyTemplatePreview(auth,permissions,token,idempotencyKey):Promise<TopologyTemplateApplication>`; `applyTopologyTemplateSite(ctx,approvedSiteEffect):Promise<TopologyTemplateSiteOutcome>`. `TopologyTemplatePreview` includes opaque token, expiry and typed per-site effects/errors, not an execution grant.

- [ ] **Step 1: Test a 200-site apply where one site changes and another becomes unauthorized before execution.**

```ts
const preview = await f.previewSites(200);
await f.editSiteOverride(preview.sites[3].siteId);
await f.revokeSiteAccess(preview.sites[7].siteId);
const op = await f.applyAndDrain(preview.token, 'apply-200');
expect(op.successful).toHaveLength(198);
expect(op.conflicted.map(x => x.code).sort()).toEqual(['permission_changed','revision_conflict']);
await f.retryAndDrain(op.id);
expect(await f.siteCommitCount()).toBe(198);
expect(await f.commandCount()).toBe(0);
```

Extend the integration fixture with fresh 200-site setup and explicit worker drain; status assertions are made under a requester still allowed to inspect those two sites, while separate revoked-reader tests require redaction of IDs/errors/counts.
- [ ] **Step 2: Run:** `pnpm --filter @breeze/api test:integration src/__tests__/integration/topologyTemplateApply.integration.test.ts`; `pnpm --filter @breeze/api exec vitest run src/services/topology/templateApply.test.ts src/routes/topology/templateApplications.test.ts`.
- [ ] **Step 3: Implement ≤500 explicit sites, ten-minute preview binding and durable per-site outcomes.** Digest includes requester/permission version, every layer/default/resolver version, overrides, revisions and activation effects. Commit each site's binding+targets+policies+provenance+revision+dispatch fencing+outbox outcome atomically; successful site intents are never replayed. Audit each conflict/commit; retain operation intents/outcomes at least30 days.

```ts
if (current.bindingRevision !== effect.expectedBindingRevision)
  return { siteId: ctx.scope.siteId, state: 'conflict', code: 'revision_conflict' };
assertEffectCapabilities(ctx, effect);
if (effect.enableRecurring) throw capabilityUnavailable('recurringMonitoring');
```

Define `assertEffectCapabilities` and typed `capabilityUnavailable` in this service; validate passive grants versus stronger monitoring/target grants for every affected field. Do not silently discard unauthorized effects or enabled policies. Saved `activationIntent` is configuration only. Worker resolves fresh requester permissions and revalidates provenance; no re-use of stale request context. M3 consumes `applyTopologyTemplateSite` effects to request fresh preview/re-arm after its capability becomes available.
- [ ] **Step 4: Re-run tests plus worker closure tests.** Cover expired token, changed template revision, cross-partner IDs, idempotency body conflict, partial failure/retry, removal revealing inherited targets, local overrides preserved, and revocation during apply.
- [ ] **Step 5: Commit:** `git commit -m "feat(topology): apply template changes with per-site revision checks"`.

## Task 13: Edit explicit targets, disabled policy drafts and site overrides

**Files:** Create `apps/api/src/services/topology/siteConfiguration.ts`, its test, `routes/topology/{targets,policies}.ts` and sibling tests; modify M0 `routes/topology/settings.ts` and route hub; create `__tests__/integration/topologySiteConfiguration.integration.test.ts`.

**Interfaces:** `updateTopologySiteConfiguration(ctx,change,expectedRevision):Promise<ResolvedTopologySettings>` compiles explicit overrides and runtime rows together. `upsertTopologyProbeTarget(ctx,input):Promise<TopologyProbeTarget>`; `upsertTopologyMonitoringPolicy(ctx,input):Promise<TopologyMonitoringPolicy>` consume this transaction. Target and policy revisions are never writable by clients.

- [ ] **Step 1: Add a test that preserves a direct target edit across the next template apply and rejects activation in M1.**

```ts
await expect(upsertTopologyMonitoringPolicy(f.executeContext, {
  ...f.policyDraft, enabled: true,
})).rejects.toMatchObject({ code: 'capability_unavailable' });
await upsertTopologyProbeTarget(f.executeContext, f.editedTarget);
expect((await f.binding()).overrides.targets[f.editedTarget.key]).toEqual(f.editedTarget.definition);
expect(await f.bindingRevision()).toBe(f.initialBindingRevision + 1n);
```

- [ ] **Step 2: Run:** `pnpm --filter @breeze/api exec vitest run src/services/topology/siteConfiguration.test.ts src/routes/topology/targets.test.ts src/routes/topology/policies.test.ts`; `pnpm --filter @breeze/api test:integration src/__tests__/integration/topologySiteConfiguration.integration.test.ts`.
- [ ] **Step 3: Implement revisioned CRUD with explicit target IDs, no credentials and no default external destinations.** Template/direct edits share one compiler and update site overrides/binding/settings revisions within the same transaction. Target deletion tombstones referenced rows; edits disable/fence affected queued plans; removing a binding leaves reused monitors running. Policy drafts are disabled and may record non-authoritative activation intent.

```ts
assertM1PolicyActivation(input.enabled ?? false);
const next = resolveTopologySettings({ ...layers, site: nextOverrides });
await persistCompiledConfiguration(tx, ctx, next, expectedRevision);
```

Define `persistCompiledConfiguration` privately in `siteConfiguration.ts`; it writes same-scope target/policy links with provenance, revision CAS and an audited topology change. Explicit configured DNS/HTTPS targets must satisfy Operations URL/address/family/redirect/proxy policy. All reads and writes use applicable permission matrix and site access; target configuration requires current MFA and execution grant even while policy drafts remain disabled.
- [ ] **Step 4: Re-run tests; assert configured-target edits, disable, read pagination and cross-site references, plus `enabled:true` returns a non-200 stable capability error and zero schedule/command rows.**
- [ ] **Step 5: Commit:** `git commit -m "feat(topology): configure explicit diagnostic targets and policy drafts"`.

## Task 14: Select eligible origins and compile bounded diagnostic plans

**Files:** Create `apps/api/src/services/topology/{diagnosticTypes,originEligibility,diagnosticPlanner}.ts` and sibling tests; extend Task 1 shared diagnostic types/vectors and API fixture.

**Interfaces:** `selectTopologyOrigins(ctx:TopologyRequestContext,request:CreateTopologyDiagnosticRequest):Promise<TopologyOriginEligibility[]>`; `planTopologyDiagnostic(ctx,request):Promise<TopologyDiagnosticPlan>`. Plans contain recipe/version, exact subject/origin/context/family, relevant revisions, steps, limits/deadlines, target snapshots and a canonical digest. Expose canonical interface `{id,epoch,ownerNodeId}` and source `{id,producerEpoch,sequence}`; epochs and uint64 sequences are strings.

- [ ] **Step 1: Add tests for a same-site roaming agent with incompatible context, a forbidden otherwise-online origin, and unconfigured outbound targets.**

```ts
it('does not manufacture external checks for an unconfigured site', async () => {
  const f = topologyFixture();
  f.repository.targets = [];
  const plan = await planTopologyDiagnostic(f.context, f.internetRequest);
  expect(plan.blockedReason).toBe('target_not_configured');
  expect(plan.steps.filter(s => s.networkSideEffect)).toHaveLength(0);
  expect(f.repository.commands).toHaveLength(0);
});
```

The fixture injects a typed repository with graph/source/target/eligible-agent reads; never inject privileged scope-only authorization.
- [ ] **Step 2: Run:** `pnpm --filter @breeze/api exec vitest run src/services/topology/originEligibility.test.ts src/services/topology/diagnosticPlanner.test.ts`.
- [ ] **Step 3: Implement fixed `gateway_basic`, `dns_basic`, `internet_basic`, and `target_connectivity` recipes.** Resolve current permissions/trust/enrollment/non-ephemeral/capability and exact org/site/context; rank explicit origin, original reporter, configured origin, then fresh eligible alternatives. No cross-site fallback. Gateway needs observed next-hop/interface evidence; a schematic object is ineligible. One family per run. A harmless label/layout revision does not invalidate the plan, but changed context/identity/target/permission does.

```ts
if (request.recipeId === 'internet_basic' && targets.length === 0)
  return blockedPlan(request, 'target_not_configured');
if (!origins.some(o => o.eligible)) throw diagnosticConflict('no_eligible_collector');
assertPlanBudget(steps, { maxSteps: 12, concurrentSteps: 2 });
```

Define these pure constructors/checks in `diagnosticPlanner.ts`. Gateway sends three ICMP packets with one-second timeout and no silent TCP fallback. DNS uses only the configured known-answer name, at most two applicable resolvers and one retry each. Internet allows two explicit endpoints and at most nine DAG steps: one context, four DNS, four combined TCP/TLS/HTTP checks with separate subresults. No extra resolver/endpoint fallback. Typed current-origin local DNS stub is the sole loopback exception; IPv6 next hop requires matching zone/interface. Ambiguous split DNS or unsupported forced context blocks explicitly.
- [ ] **Step 4: Re-run tests and shared diagnostic validators.** Exercise IPv4/IPv6 independently, ECMP, multi-interface/VPN, missing/expired routes, target changes, wrong-site subject/origin, malformed public targets and exact step/packet/timeout/address budgets.
- [ ] **Step 5: Commit:** `git commit -m "feat(topology): compile authorized connectivity diagnostic plans"`.

## Task 15: Register diagnostic commands across authorization and transports

**Files:** Modify `apps/api/src/services/{commandTypes,commandOfflinePolicy,commandClaimEligibility,commandDispatch,commandResultAcceptance,agentCommandResultValidation,partnerTrust.commands,partnerTrust,sensitiveCommandPayload,commandTimeouts}.ts`, `routes/{agentWs,agents/commands,agents/schemas}.ts`, their existing tests; create `__tests__/integration/topologyCommandAuthority.integration.test.ts`. Modify `agent/internal/remote/tools/types.go` and shared command/capability schemas where those existing services import them.

**Interfaces:** New command literal `network_diagnostic` carries supported schema version, run/attempt/command IDs, normalized plan/digest, accepted origin/context, permitted destinations and absolute expiry. `TopologyDiagnosticCommand` is the shared validated wire type. Existing command transport remains the authenticated boundary; a digest is not authorization.

- [ ] **Step 1: Add HTTP-poll and WebSocket tests for the same revoked/moved/expired command and a forged result from another agent.**

```ts
it.each(['http','websocket'] as const)('rejects stale diagnostic authority on %s', async transport => {
  const f = await seedTopologyCommandFixture();
  await f.moveOriginToOtherSite();
  expect(await f.claimThrough(transport)).toMatchObject({ delivered: false, reason: 'scope_changed' });
  expect(await f.resultFromOtherAgent()).toMatchObject({ accepted: false });
});
```

Add `seedTopologyCommandFixture` to the M1 helper using persisted diagnostic/command rows and actual route transport adapters; use Task 14 planner snapshots.
- [ ] **Step 2: Run:** `pnpm --filter @breeze/api test:integration src/__tests__/integration/topologyCommandAuthority.integration.test.ts`; `pnpm --filter @breeze/api exec vitest run src/services/commandOfflinePolicy.test.ts src/services/commandClaimEligibility.test.ts src/services/commandResultAcceptance.test.ts src/routes/agents/commands.test.ts`.
- [ ] **Step 3: Register the command in every closed registry and enforce no-offline semantics.** Admit only `topology:execute` AND `devices:execute`, graph/origin/target reads, applicable trust/MFA and scoped run linkage. Poll claim and WS dispatch revalidate deadline/current origin/site/context/configuration/authority immediately before delivery. Result acceptance checks authenticated agent ownership and pinned IDs/digest before calling Task 18's typed result seam; existing monitor result handlers must not swallow this command.

```ts
if (command.type === CommandTypes.NETWORK_DIAGNOSTIC) {
  const payload = topologyDiagnosticCommandSchema.parse(command.payload);
  if (Date.now() >= Date.parse(payload.absoluteExpiresAt)) return deny('expired');
  return validateTopologyCommandAuthority(command, payload);
}
```

Create `validateTopologyCommandAuthority(command,payload)` in `services/topology/diagnosticDispatch.ts` with a read-only implementation in this task, then expand it in Task 18. It resolves the scoped parent run and current producer authority, never only payload org/site IDs. Unknown/missing run fails closed. Classification refuses offline persistence-as-future-execution, constrains redaction/payload/result bounds and preserves run/command audit IDs. Do not add a bypass direct socket sender.
- [ ] **Step 4: Re-run integration/registry tests and `pnpm --filter @breeze/api exec tsc --noEmit`; verify existing monitor and unrelated command behavior remains intact.** Accepted-but-delayed commands expire rather than obtaining a new timeout on reconnect.
- [ ] **Step 5: Commit:** `git commit -m "feat(topology): authorize diagnostic commands on every transport"`.

## Task 16: Journal diagnostic command and step starts durably

**Files:** Create `agent/internal/networkdiagnostic/{types.go,journal.go,journal_test.go}` and JSON wire fixtures sourced from Task 1 vectors. Read existing agent persistence/atomic-write conventions before choosing the journal storage helper; use the configured agent data directory, never cwd or temp storage for production state.

**Interfaces:** `OpenJournal(path string, clock Clock) (*Journal,error)`; `Accept(command Command) (Acceptance,error)`; `StartStep(key StepKey) (bool,error)`; `FinishStep(key StepKey,result StepResult) error`; `Recover() ([]StepResult,error)`. Key is `(runId,attemptId,stepId)`; `Acceptance` returns saved results or active state for duplicate deliveries.

- [ ] **Step 1: Write table-driven crash and concurrent duplicate-start tests.**

```go
func TestCrashAfterIntentDoesNotReprobe(t *testing.T) {
    path := filepath.Join(t.TempDir(), "journal")
    j := openTestJournal(t, path)
    if started, err := j.StartStep(testStepKey()); err != nil || !started { t.Fatal(started, err) }
    j.Close()
    reopened := openTestJournal(t, path)
    recovered, err := reopened.Recover()
    if err != nil || recovered[0].Reason != "outcome_indeterminate" { t.Fatal(recovered, err) }
    if started, _ := reopened.StartStep(testStepKey()); started { t.Fatal("duplicated network side effect") }
}
```

Define `Close`, `openTestJournal` and `testStepKey` in the same package; the fixture first accepts the parent command before the illustrated step start.
- [ ] **Step 2: Run:** `cd agent && go test -race ./internal/networkdiagnostic/...`; expect journal symbols to be absent.
- [ ] **Step 3: Implement crash-safe durable acceptance/start intent before any network call.** Atomic replacement plus fsync of file/directory, or the repository's equivalent durable storage helper, must complete before returning `started=true`; protect in-process duplicates with a mutex and journal uniqueness. Persist terminal results and return them on retry. Recover intent-without-result as `execution_error/outcome_indeterminate`; never rerun.

```go
if _, exists := j.entries[key]; exists { return false, nil }
if len(j.entries) >= 10000 { return false, ErrJournalFull }
if err := j.persistIntent(key); err != nil { return false, err }
return true, nil
```

Define `persistIntent` as the private durable write path and test write/fsync/rename failures. Retain entries until command expiry+24h; expire only eligible entries before enforcing the10,000 cap. Refuse when full, corrupt, or unwritable. A command-level error cannot silently run unjournaled probes.
- [ ] **Step 4: Re-run the race suite with simultaneous duplicate accepts/starts, corrupted/truncated disk data, clock rollback, full journal and cleanup boundaries; native Windows/macOS filesystem tests run too.**
- [ ] **Step 5: Commit:** `git commit -m "feat(agent): journal topology diagnostic starts before probing"`.

## Task 17: Execute bounded agent diagnostics with route attribution

**Files:** Create `agent/internal/networkdiagnostic/{policy.go,policy_test.go,runner.go,runner_test.go}`, `agent/internal/heartbeat/{handlers_topology_diagnostic.go,handlers_topology_diagnostic_test.go}`; modify `heartbeat/handlers_test.go` registry expectations. Reuse Task 3 native route lookup and existing low-level probe primitives only where their actual-method behavior meets this contract.

**Interfaces:** `Run(ctx context.Context,command Command,journal *Journal,io ProbeIO) Result`; injected `ProbeIO` exposes route lookup, context-bound DNS, ICMP, literal-IP TCP and TLS/HTTP, with fake implementations in tests. `ValidateDestination(target Target,address netip.Addr,context RouteSelection) error` validates every resolved address and redirect independently.

- [ ] **Step 1: Add a DNS-rebinding test proving validated addresses are pinned and no second implicit DNS resolution occurs.**

```go
func TestHTTPPinsValidatedAddress(t *testing.T) {
    io := newFakeProbeIO()
    io.DNSAnswers = []netip.Addr{netip.MustParseAddr("192.0.2.20")}
    result := Run(context.Background(), httpsTestCommand(), openTestJournal(t, t.TempDir()), io)
    if io.ResolveCalls != 1 || io.Dialed[0] != "192.0.2.20:443" { t.Fatal(io) }
    if io.TLSServerName != "status.example.test" { t.Fatal("lost TLS hostname verification") }
    if result.Steps[0].ActualMethod == "icmp" { t.Fatal("incorrect measurement method") }
}
```

Define these test fixtures in `runner_test.go`; the fake journal fixture accepts the command and the fake IO records all external-call attempts.
- [ ] **Step 2: Run:** `cd agent && go test -race ./internal/networkdiagnostic/... ./internal/heartbeat/...`.
- [ ] **Step 3: Validate payload/digest/version/deadline, then journal and execute its bounded DAG with at most two active network steps.** Bind family/interface/local source/context when supported; otherwise return `unsupported_context`. Immediately re-read route attribution before each probe. Record actual method, destination, origin, source/interface/next hop, proxy, timings and `observed|requested_unverified|unknown` attribution. Respect 12 steps, 5 ICMP packets/step, 2s ICMP timeout, 1,024-byte payload, 4 target addresses total/run in its one family (2 per endpoint), 2 resolver addresses, 8 KiB details/step and 128 KiB/run.

```go
if err := ValidateDestination(target, ip, route); err != nil { return blockedStep(err) }
started, err := journal.StartStep(step.Key())
if err != nil || !started { return journalResult(step.Key(), err) }
result := io.CheckHTTPS(ctx, ip, target.Port, target.Hostname, target.Path, limits)
return persistStepResult(journal, step.Key(), result)
```

Implement the three result helpers locally with typed states. Block loopback/metadata/multicast/unspecified/broadcast destinations; allow only a freshly reported origin-bound DNS stub exception and correctly scoped link-local next hop. Pin approved DNS addresses, retain TLS hostname verification, disable redirects by default; configured redirects max2 each repeats validation. GET/HEAD only,5s request,64KiB response cap, no cookies/credentials/body persistence. ICMP unsupported/timeout is never an implicit TCP success. Cancel stops contexts/child processes; expiry uses remaining absolute budget. Register handler through existing heartbeat registry for both transports.
- [ ] **Step 4: Re-run race tests on all three OS runners; cover metadata/loopback and mixed DNS answers, redirect rebinding, proxy opt-in, TLS failure versus TCP success, DNS split context, link-local zones, mid-run route change, budget exhaustion, duplicate delivery, expiry and cancellation.** No test makes real network calls.
- [ ] **Step 5: Commit:** `git commit -m "feat(agent): run bounded topology diagnostics with attributed results"`.

## Task 18: Persist, dispatch, cancel and reconcile diagnostic runs

**Files:** Create `apps/api/src/services/topology/{diagnosticRuns,diagnosticResults}.ts` and sibling tests; extend Task 15 `diagnosticDispatch.ts` and create its test; create `routes/topology/diagnostics.ts`, its test, `jobs/{topologyDiagnosticWorker,topologyDiagnosticSweeper}.ts`, `__tests__/integration/topologyDiagnosticLifecycle.integration.test.ts`; modify route hub, worker registry and M0 outbox routing.

**Interfaces:** `createTopologyDiagnosticRun(ctx,request,idempotencyKey):Promise<TopologyDiagnosticRun>`; `getTopologyDiagnosticRun(ctx,runId):Promise<TopologyDiagnosticRun|null>`; `dispatchTopologyDiagnosticRun(scope:TopologyScope,runId:string):Promise<void>`; `acceptTopologyDiagnosticResult(producer:AuthenticatedTopologyProducer,result:TopologyDiagnosticResult):Promise<{accepted:boolean;historicalOnly:boolean}>`; `cancelTopologyDiagnosticRun(ctx,runId):Promise<TopologyDiagnosticRun>`. M3 can extend create with an optional fourth scheduled-authority argument while preserving this three-argument API.

- [ ] **Step 1: Write a real-DB accepted-run crash/retry test, cancellation race and expired result test.**

```ts
const run = await createTopologyDiagnosticRun(f.context, f.request, 'bounded-run');
await f.crashWorkerAfterCommandInsert(run.id);
await dispatchTopologyDiagnosticRun(f.scope, run.id);
expect(await f.commandsForRun(run.id)).toHaveLength(1);
await cancelTopologyDiagnosticRun(f.context, run.id);
await f.expireRun(run.id);
expect(await acceptTopologyDiagnosticResult(f.producer, f.lateResult(run.id)))
  .toMatchObject({ accepted: true, historicalOnly: true });
expect((await getTopologyDiagnosticRun(f.context, run.id))?.state).toBe('expired');
```

Implement those fixture seams around injectable dispatch/crash barriers and fake clock, with transaction commits at each crash point.
- [ ] **Step 2: Run:** `pnpm --filter @breeze/api test:integration src/__tests__/integration/topologyDiagnosticLifecycle.integration.test.ts`; `pnpm --filter @breeze/api exec vitest run src/routes/topology/diagnostics.test.ts src/services/topology/diagnosticRuns.test.ts src/services/topology/diagnosticDispatch.test.ts src/services/topology/diagnosticResults.test.ts`.
- [ ] **Step 3: Accept normalized plan/run/step placeholders and durable outbox intent in one transaction, then dispatch outside it.** Reuse `insertQueuedCommandInTransaction` with deterministic command/run/attempt identities; worker network delivery follows commit. Workers call `runOutsideDbContext` before bounded `withSystemDbAccessContext`; scope narrows trusted job work but current requester/subject/origin authority is reloaded before enqueue and dispatch. A failed infrastructure precondition returns503 without accepting work.

```ts
return db.transaction(async tx => {
  const run = await insertAcceptedRun(tx, ctx, plan, idempotencyKey);
  await enqueueTopologyChange(tx, ctx.scope, {
    kind: 'diagnostic_dispatch', aggregateId: run.id, idempotencyKey: `diagnostic:${run.id}`,
  });
  return run;
});
```

Define `insertAcceptedRun` privately with unique scoped org/user/site/endpoint idempotency+bodyhash24h; duplicate requests revalidate access and return existing run, changed body409. Quotas2/agent4/site20/org concurrent and starts10/user/min30/site/min120/org/min share current budget primitives;429 includes Retry-After. Queued30s,execution90s,absolute120s. CAS run states queued/running→completed|failed|cancelled|expired; connectivity failure is completed with failed-check assessment, orchestration failure is failed. Results deduplicate run/attempt/step and cannot overwrite terminal/newer health; retain late evidence flagged historical. Cancellation first persists request, blocks undispatched work, then sends best-effort cancellation; UI remains stop-requested until ack, deadline yields expired/cancellation_unconfirmed. Sweeper repairs orphan intents/deadlines; reconnect never reactivates expired work.
- [ ] **Step 4: Re-run tests and command/worker closure suites.** Test request replay after access revocation, dispatch after origin move/template revocation, two workers, terminal races, unauthorized result IDs, truncated payload rejection, quota release on every terminal path and process crash before/after outbox/command acknowledgement.
- [ ] **Step 5: Commit:** `git commit -m "feat(topology): persist and dispatch durable diagnostic runs"`.

## Task 19: Reuse monitor results and calculate scoped health

**Files:** Create `apps/api/src/services/topology/{diagnosticHealth,monitorOverlays}.ts` and sibling tests; create `__tests__/integration/topologyMonitorOverlays.integration.test.ts`; modify M0 graph read projection and Task 18 result publication. No new recurring scheduler is created.

**Interfaces:** Pure `assessTopologyDiagnostic(plan:TopologyDiagnosticPlan,steps:TopologyDiagnosticStep[]):TopologyHealthSummary`; `readTopologyMonitorOverlays(ctx,subjects):Promise<TopologyMonitorOverlay[]>`. `TopologyHealthSummary` uses canonical `{status:'healthy'|'degraded'|'failed_check'|'unknown',coverage:'monitored'|'partial'|'unmonitored'|'unsupported'|'unavailable',reasons,evidenceRefs}` as graph `health`; diagnostic runs separately persist `assessment=summary.status` and derive run coverage `complete|partial|none` from the fixed plan's attempted/required steps. Overlay provenance identifies monitor/run/result, exact origin/context/family/destination and freshness. Existing monitor schedules/targets/alert rules remain unchanged.

- [ ] **Step 1: Test partial dual-family success, stale data, unsupported ICMP and exact-monitor equivalence.**

```ts
const result = assessTopologyDiagnostic(f.plan, [
  f.step({ protocol: 'tcp', state: 'succeeded', family: 'ipv4' }),
  f.step({ protocol: 'tls', state: 'failed_check', family: 'ipv4' }),
]);
expect(result).toMatchObject({ status: 'degraded', coverage: 'monitored' });
expect(result.reasons).toContain('tls_check_failed');
expect(assessTopologyDiagnostic(f.plan, f.staleSteps).status).toBe('unknown');
```

- [ ] **Step 2: Run:** `pnpm --filter @breeze/api exec vitest run src/services/topology/diagnosticHealth.test.ts src/services/topology/monitorOverlays.test.ts`; `pnpm --filter @breeze/api test:integration src/__tests__/integration/topologyMonitorOverlays.integration.test.ts`.
- [ ] **Step 3: Implement deterministic assessment with source IDs and exact scope.** Current required successes→healthy; mixed outcomes→degraded; required actual failed probes→failed_check; missing/stale/unsupported evidence→unknown. Preserve previous stale assessment separately. No ICMP response is not router-down; no traffic history is not zero traffic; one successful endpoint is not whole-Internet health.

```ts
const usable = steps.filter(s => s.freshness === 'fresh' && !s.historicalOnly);
if (required.some(id => !usable.some(s => s.stepId === id)))
  return { status: 'unknown', coverage: usable.length ? 'partial' : 'unavailable',
    reasons: ['missing_required_evidence'], evidenceRefs: usable.map(s => s.id) };
```

Reused monitors need equal org/site/destination/protocol/context/origin policy and explicit canonical binding, never IP-only lookup. Filter restricted alerts/monitor details before counts. Health refresh advances health revision only, not structural graph/layout revisions. On-demand runs do not advance scheduled alert streaks. Retain separate evidence confidence/freshness/health; group counts show unknown/unmonitored rather than green aggregate.
- [ ] **Step 4: Re-run tests with denied alert/monitor reads, assetless null-site legacy monitor, moved assets, duplicate compatible bindings and graph GET command-count assertions.**
- [ ] **Step 5: Commit:** `git commit -m "feat(topology): show attributed existing monitor and diagnostic health"`.

## Task 20: Add network/device entry points and a readable graph inspector

**Files:** Create `apps/web/src/components/topology/{TopologyExplorer,TopologyInspector,TopologyList,TopologyDiagnosticsPanel}.tsx`, `useTopologyGraph.ts` and sibling tests. Modify existing `components/discovery/DiscoveryPage.tsx`, `components/devices/{DeviceDetails,NetworkDeviceDetailPage}.tsx`, `components/devices/networkDevice/types.ts` and their tests. Keep the existing legacy map available behind M0's resolved rollout selection.

**Interfaces:** `TopologyExplorer({siteId,focusNodeId?})`; `TopologyInspector({selection,graph,onDiagnose})`; `TopologyDiagnosticsPanel({siteId,subject,onClose})`; `useTopologyGraph(scope,query)` returns typed graph/health/load/error states. `TopologyList` provides the same permitted entities, relationship meanings and actions as the canvas.

- [ ] **Step 1: Add tests that exercise the actual `#topology` network-device tab, device focus entry and read-only no-side-effect behavior.**

```tsx
it('opens the requested topology tab without issuing mutations', async () => {
  window.location.hash = '#topology';
  render(<NetworkDeviceDetailPage {...networkDevicePageFixture()} />);
  expect(await screen.findByTestId('topology-explorer')).toBeVisible();
  expect(requestLog.filter(r => r.method !== 'GET')).toEqual([]);
  expect(screen.getByTestId('topology-health-internet')).toHaveTextContent('Not measured');
});
```

Extend existing network-device test setup with the new graph response; no invented standalone entry path substitutes for testing this current page.
- [ ] **Step 2: Run:** `pnpm --filter @breeze/web exec vitest run src/components/devices/NetworkDeviceDetailPage.test.tsx src/components/devices/DeviceDetails.hashNavigation.test.tsx src/components/topology/TopologyExplorer.test.tsx src/components/topology/TopologyDiagnosticsPanel.test.tsx`.
- [ ] **Step 3: Render canonical/presentation elements distinctly, with role hierarchy, readable labels, useful unknown states and relationship legends.** Add topology to `VALID_TABS`; resolve inventory focus through canonical binding. Hash encodes view/focus/selection; keep pan/zoom local. Show supporting observers for derived gateway overview connectors, alternative gateways, evidence source/freshness/confidence separately, coverage counts and exact diagnostic method. Schematic objects explain missing evidence and offer configuration, never execute.

```tsx
const canDiagnose = subject.presentationOnly !== true && capabilities.explicitDiagnostics && permissions.execute;
return <button data-testid="topology-diagnose" disabled={!canDiagnose}
  onClick={() => setDiagnosticSubject(subject)}>Diagnose</button>;
```

The panel displays accepted normalized plan/origin/family/deadline, sends explicit POST through `runAction`, then GET-polls run status initially every 2 seconds, backing off to 5 seconds and stopping at terminal state; leave/reopen uses the durable run ID. Both families create two budgeted visible runs. Unconfigured DNS/Internet shows target_not_configured; gateway timeout says No ICMP response. Stop uses runAction and renders Stop requested until acknowledgement; Retry is a new user action/new idempotency key. Health refreshes every 15 seconds and structure every 60 seconds, pausing while hidden; update elements without resetting selection/viewport. Respect permission-filtered pagination/frontier counts, loading, empty, offline, no-agent, disabled and denied states.
- [ ] **Step 4: Re-run tests plus `pnpm --filter @breeze/web exec vitest run src/lib/__tests__/no-silent-mutations.test.ts`.** Verify GET polling, tab/hash restoration, no layout persistence/probes on reads, 401 handling via `ActionError`, accessible labels and restricted details/counts absent.
- [ ] **Step 5: Commit:** `git commit -m "feat(topology): add baseline explorer and explicit diagnostic actions"`.

## Task 21: Add template selection and reviewable bulk application UI

**Files:** Create `apps/web/src/components/topology/{TopologyConfiguration,TopologyTemplateApply}.tsx`, `topologyConfigurationApi.ts` and sibling tests; modify `TopologyExplorer.tsx` and existing settings entry components only where a library administration link is needed.

**Interfaces:** `TopologyConfiguration({siteId,capabilities})` shows pinned versions, field provenance, overrides and explicit targets. `TopologyTemplateApply({siteIds,onComplete})` performs preview→review→apply→status with per-site outcomes. API mutation request methods such as `previewResponse(request):Promise<Response>` return Response for `runAction`; its `parseSuccess` uses shared schemas to return typed data. Reads parse template/site/runtime types and never embed execution authority in client data.

- [ ] **Step 1: Test that publishing, selecting a version and previewing cannot apply it, and M1 cannot claim monitoring is enabled.**

```tsx
await user.click(screen.getByTestId('topology-template-preview'));
expect(await screen.findByTestId('topology-template-diff')).toBeVisible();
expect(requestLog.some(r => r.path === '/topology/template-applications')).toBe(false);
expect(screen.getByTestId('topology-enable-recurring')).toBeDisabled();
expect(screen.getByTestId('topology-recurring-capability')).toHaveTextContent('Recurring monitoring is not available');
```

- [ ] **Step 2: Run:** `pnpm --filter @breeze/web exec vitest run src/components/topology/TopologyConfiguration.test.tsx src/components/topology/TopologyTemplateApply.test.tsx`.
- [ ] **Step 3: Implement eligible published-site choices independently of privileged library administration.** Review page lists pinned changes, local overrides, target/recipe volume and per-site errors/conflicts. Expired previews force regeneration; apply disabled when capability/permission validation fails. Maintain successful outcomes across retry and refresh status, redact newly unauthorized sites. All POST preview/publish/apply and direct CRUD mutations use runAction; preserve unsaved edits after revision conflict.

```ts
const preview = await runAction<TopologyTemplatePreview>({
  request: () => topologyConfigurationApi.previewResponse(request),
  errorFallback: 'Unable to preview topology configuration',
  successMessage: 'Configuration preview ready',
  parseSuccess: data => topologyTemplatePreviewSchema.parse(data),
});
setPreview(preview);
```

Add `topologyTemplatePreviewSchema` to shared configuration validators with its bounded per-site outcome union. Targets start empty; collect hostname/port/path/expected response with clear family/context choice. Disabled drafts may retain activation intent visibly, but UI and API say they will not run. Read-only users can inspect eligible published versions but cannot save/apply. Clear override/unbind uses a new review showing inherited fallback.
- [ ] **Step 4: Re-run the two tests and no-silent-mutations guard.** Cover partial200-site outcomes, stale revisions, template revocation, stronger target permissions, forbidden org library management by a site technician, keyboard focus and error announcements.
- [ ] **Step 5: Commit:** `git commit -m "feat(topology): review reusable configuration changes across sites"`.

## Task 22: Arrange visible topology in a real browser ELK worker

**Files:** Create `apps/web/src/components/topology/{layoutTypes,layoutAdapter,layoutController}.ts`, `layout.worker.ts` and sibling unit tests. Modify `TopologyExplorer.tsx`, `apps/web/package.json`, `pnpm-lock.yaml`; inspect `apps/web/{astro.config.mjs,src/middleware.ts,src/lib/csp.ts}` before changing headers. Existing worker-src self/blob coverage must suffice; do not widen script/connect CSP.

**Interfaces:** `LayoutRequest={requestId,graphRevision,layoutRevision,measurementRevision,algorithmVersion,nodes,edges,positions,mode}` with measured bounded boxes; `LayoutResult={...revisionFence,positions,warning?}`. `computeTopologyLayout(request):Promise<LayoutResult>` runs only inside the worker. `TopologyLayoutController` creates/cancels/terminates workers and discards mismatched responses. Pin exact `elkjs@0.12.0` (package registry and [upstream release](https://github.com/kieler/elkjs/releases/tag/0.12.0) verified during review). The same deterministic layout, production bundling and CSP gates below apply to this selected version.

- [ ] **Step 1: Write a deterministic adapter test with cycles, parallel edges, long labels, a saved pin and two new nodes; also test stale result rejection.**

```ts
const first = await computeTopologyLayout(layoutFixture({ mode: 'incremental', seed: 7 }));
const second = await computeTopologyLayout(layoutFixture({ mode: 'incremental', seed: 7 }));
expect(first.positions).toEqual(second.positions);
expect(first.positions.get('pinned-node')).toEqual({ x: 320, y: 180 });
expect(findOverlaps(first.positions, measuredBoxes)).toEqual([]);
expect(controller.accept({ ...first, graphRevision: 'obsolete' })).toBe(false);
```

Create pure `layoutFixture`/`findOverlaps` test helpers beside the adapter tests; test geometry rather than screenshots alone.
- [ ] **Step 2: Run:** `pnpm --filter @breeze/web exec vitest run src/components/topology/layoutAdapter.test.ts src/components/topology/layoutController.test.ts`; expect absent worker/placement adapter.
- [ ] **Step 3: Install the pinned dependency and bundle it inside a module worker:** `pnpm --filter @breeze/web add --save-exact elkjs@0.12.0`. Use measured sizes after fonts settle, stable node/edge sorting, seeded layered options and explicit group hierarchy;32px node gap,96px layer gap,48px group padding. Include all relevant visible relationships, preserving cyclic/parallel identities.

```ts
// Called after client mount, never during SSR.
const worker = new Worker(new URL('./layout.worker.ts', import.meta.url), { type: 'module' });
worker.postMessage(request);
// Inside layout.worker.ts:
const elk = new ELK(); // import ELK from 'elkjs/lib/elk.bundled.js'
const arranged = await elk.layout(toElkGraph(request));
```

Define `toElkGraph` and a deterministic packer in layoutAdapter. Saved positions remain fixed for incremental placement; new/unplaced nodes are laid out in free regions. Explicit Reflow lays out unpinned partitions then packs around occupied pinned rectangles; do not pretend ELK enforces arbitrary fixed constraints. Fence graph/layout/measurement/version/request IDs; terminate obsolete workers on site change/unmount/superseding request. Cap5000 candidate elements and3s; timeout/overflow returns deterministic grid placement for eligible unplaced nodes with a visible warning, retaining pins. Initial placement is local preview only, even for editors; no save request.
- [ ] **Step 4: Re-run tests, `pnpm --filter @breeze/web csp:guard`, and `pnpm --filter @breeze/web build:prod`.** The built-worker runtime and CSP are verified in Task24, not inferred from a mocked unit Worker.
- [ ] **Step 5: Commit:** `git commit -m "feat(topology): arrange visible graphs with a bundled ELK worker"`.

## Task 23: Persist explicit layout edits and complete keyboard access

**Files:** Create `apps/web/src/components/topology/layoutPersistence.ts`, its test and `TopologyExplorer.accessibility.test.tsx`; modify explorer/list/inspector/controller and shared layout validators only if M0 contract coverage reveals a missing branch. Consume M0 PATCH layout endpoint, not a second save route.

**Interfaces:** Web `saveTopologyLayout(scope,view,expectedRevision,positions):Promise<LayoutWriteResult>` consumes M0 shared response `LayoutWriteResult` and `layoutWriteResultSchema`; Returned positions contain only the accepted batch: merge by node ID and preserve saved positions outside it. `TopologyLayoutDraft` distinguishes published positions from local arrange/drag/pin changes. Save payload≤1000 positions/256KiB, finite coordinates±1,000,000; read-only local arrangement has no persistence capability.

- [ ] **Step 1: Test pin retention and conflict behavior without implicit save.**

```tsx
await user.click(screen.getByTestId('topology-arrange'));
expect(requestLog.filter(r => r.method === 'PATCH')).toEqual([]);
await user.click(screen.getByTestId('topology-layout-save'));
expect(await screen.findByTestId('topology-layout-conflict')).toBeVisible();
expect(screen.getByTestId('topology-unsaved-layout')).toBeVisible();
expect(layoutDraft.positions.get(pinnedId)).toEqual(savedPin);
```

Configure fixture server response409 with current layout revision; `layoutDraft` is the controller's injected observable test draft, not DOM internals.
- [ ] **Step 2: Run:** `pnpm --filter @breeze/web exec vitest run src/components/topology/layoutPersistence.test.ts src/components/topology/TopologyExplorer.accessibility.test.tsx`.
- [ ] **Step 3: Implement explicit Save via runAction and revision CAS; resolve conflict by reload/compare, never blind overwrite.** Pan/zoom/filter/selection stay local/hash. Clear actions distinguish local arrange, reflow unpinned, shared save, and selected pin changes. Dirty layout survives health-only refresh; node removal clears selection accessibly and measured-bound changes trigger fenced local preview.

```ts
// Inside saveTopologyLayout, called only by an explicit Save action:
return runAction<LayoutWriteResult>({
  request: () => fetchWithAuth(`/topology/sites/${scope.siteId}/layouts/${view}`, {
    method: 'PATCH', body: JSON.stringify({ expectedRevision, positions }),
  }),
  errorFallback: 'Unable to save topology layout',
  successMessage: 'Topology layout saved',
  parseSuccess: data => layoutWriteResultSchema.parse(data),
});
```

Consume `fetchWithAuth` from `apps/web/src/stores/auth.ts` and M0 shared layout response schema; the UI checks write capability, and API authorization remains authoritative. Provide keyboard traversal via equivalent list/table, list→canvas/inspector focus and inspector return focus, Escape close, explicit diagnostic/expand controls and announcements for loading/errors/layout completion. Preserve existing web tokens/component affordances; root DESIGN.md describes Breeze Mobile and is not a web theme replacement. Use shapes/text/line patterns as well as color; selection styling is distinct from health/status, and unknown is never default green. Honor reduced motion and large text; constrain/wrap or ellipsize labels with a full-text keyboard-accessible tooltip. On narrow screens use an inspector drawer/stack that does not overlap graph controls. List actions call the same scoped handlers as canvas.
- [ ] **Step 4: Re-run tests and no-silent-mutations guard; cover editor/read-only cases, bounds, pins on reflow/fallback, conflict response, keyboard-only diagnoses, contrast/reduced-motion state and hidden-tab polling suspension.**
- [ ] **Step 5: Commit:** `git commit -m "feat(topology): save explicit layout edits with accessible controls"`.

## Task 24: Verify the baseline in a production browser

**Files:** Create `e2e-tests/pages/TopologyPage.ts`, `e2e-tests/tests/{topology-baseline,topology-worker}.spec.ts`, `e2e-tests/helpers/topologyFixture.ts`; modify `e2e-tests/fixtures.ts` only to expose typed page/seed helpers and existing stack setup as needed. Create `apps/api/src/__tests__/integration/topologyBaselineAcceptance.integration.test.ts` for the server side of the same deterministic fixture.

**Interfaces:** Fixture `baseline-no-management` has one enrolled agent/interface/prefix/default route/reported resolvers and two inventory peers, with zero LLDP/SNMP/FDB/controller reports. `TopologyPage` exposes only `data-testid` locators. API fixture inserts through the normalized collection seam, then drains reconciliation; it never seeds fake canonical physical edges.

- [ ] **Step 1: Add the production-browser assertions and instrument unexpected side effects.**

```ts
test('baseline map is useful and passive before explicit Diagnose', async ({ page }) => {
  const f = await seedBaselineTopology();
  const topology = new TopologyPage(page);
  await topology.openNetworkDevice(f.networkDeviceId, '#topology');
  await expect(topology.node(f.gatewayNodeId)).toBeVisible();
  await expect(topology.internetHealth).toHaveText('Not measured');
  expect(await f.effects()).toEqual({ commands: 0, schedules: 0, modelCalls: 0, layoutWrites: 0 });
  await topology.diagnoseGateway();
  await expect(topology.actualMethod).toHaveText('ICMP');
  expect((await f.effects()).commands).toBe(1);
});
```

Implement `seedBaselineTopology` and `f.effects()` in the E2E helper against the existing test fixture setup and scoped server counters; tests do not use production hosts. Seed mocks for controlled agent responses, never real external destinations.
- [ ] **Step 2: Run:** `pnpm --filter @breeze/api test:integration src/__tests__/integration/topologyBaselineAcceptance.integration.test.ts`; `pnpm --filter @breeze/e2e-tests exec playwright test tests/topology-baseline.spec.ts tests/topology-worker.spec.ts --project=chromium` against the disposable test stack, initially expecting missing acceptance behavior.
- [ ] **Step 3: Implement acceptance harness cases and only fix behavior exposed by those tests.** Assert default-route origin is reporting endpoint/interface, peers have membership only, physical-link count0, schematic IDs stay presentation-only, unknown Internet, measured nonoverlap and pins. Gateway timeout stays No ICMP response. With unconfigured targets DNS/Internet produce target_not_configured and zero external calls; then explicitly configure mocked known-answer DNS and two controlled HTTPS targets to assert exact origin/family/DNS/TCP/TLS/HTTP attribution and partial failure.

```ts
page.on('console', msg => { if (msg.type() === 'error') browserErrors.push(msg.text()); });
page.on('worker', worker => workerUrls.push(worker.url()));
await topology.arrange();
expect(workerUrls.some(url => new URL(url).origin === new URL(baseUrl).origin)).toBe(true);
expect(browserErrors.filter(message => /Content Security Policy|worker/i.test(message))).toEqual([]);
```

Run a built production web image/server, not the Vite dev server or mocked Worker. Assert loaded worker executes ELK and positions change from deterministic input, CSP allows the emitted same-origin asset, network logs have no CDN worker/model calls, and no unauthorized POST/PATCH. Cover SSR hydration, worker cancellation on site switch, timeout fallback, stale response ignored, keyboard list equivalence, all three entry points and layout Save409.
- [ ] **Step 4: Run `pnpm --filter @breeze/web build:prod`, start that build using the existing disposable E2E stack descriptor, and rerun the exact API/Playwright commands.** Collect worker URLs/CSP headers/browser errors/artifacts; mock-worker unit success does not satisfy this gate.
- [ ] **Step 5: Commit:** `git commit -m "test(topology): verify passive baseline and production worker behavior"`.

## Task 25: Add fleet fixtures, retention soak and lifecycle release gates

**Files:** Create `scripts/topology/{fixtures,ingest-soak}.ts`, `apps/api/src/__tests__/integration/topologyFleetAcceptance.integration.test.ts`, `apps/web/src/components/topology/layoutFixtures.ts`, `e2e-tests/tests/topology-performance.spec.ts`; modify Task1 shared fixture module and Task24 E2E helper. Store measured run artifacts in the execution's test artifact directory, not production/internal infrastructure details in tracked fixtures.

**Interfaces:** `buildTopologyFixture(name,seed)` exports `G10K`, `V500`, `V200`, `V1000`, `I10K` deterministic datasets with normative seed `topology-v1`. CLI `ingest-soak.ts --fixture I10K --duration-hours 24 --seed topology-v1 --output <artifact-path>` calls authenticated test producer ingestion and observes admitted/confirmed/published transitions; it never contacts enrolled production agents.

- [ ] **Step 1: Add resource-growth assertions that distinguish compact confirmation from changed history.**

```ts
it('retains compact current truth after raw retention without per-tick history', async () => {
  const f = await seedTopologyFleetFixture('I10K', 'topology-v1');
  await f.ingestInitialAndPublish();
  const baseline = await f.rowCounts();
  await f.confirmAll({ rounds: 288, intervalSeconds: 300 });
  expect(await f.rowCounts()).toMatchObject({ runs: baseline.runs, observations: baseline.observations });
  await f.advanceClock({ days: 31 });
  await f.confirmAll({ rounds: 1, intervalSeconds: 300 });
  await f.expireRawEvidence();
  expect(await f.compactCurrentSourceCount()).toBe(10_000);
  expect(await f.sampleCurrentSupport()).toMatchObject({ freshness: 'fresh', lifecycle: 'active' });
  expect((await f.rowCounts()).runs).toBe(0);
});
```

Define the fixture helpers using bulk seeded authorized sources, fake clock for contract tests and real elapsed time for the soak. Add identical-empty second-miss, noisy-neighbor stable-route, quota rejection/coalescing and epoch-reset attack cases.
- [ ] **Step 2: Run:** `pnpm --filter @breeze/api test:integration src/__tests__/integration/topologyFleetAcceptance.integration.test.ts`; `pnpm --filter @breeze/e2e-tests exec playwright test tests/topology-performance.spec.ts --project=chromium`.
- [ ] **Step 3: Implement deterministic fixtures and measurement harnesses with exact budgets.** G10K has 10,000 nodes/20,000 edges: 12,000 membership,4,000 default-route,2,000 attachment,2,000 physical;four sources/relationship,10% stale,100 pins,20% 80-character labels,cycles/parallel edges. M1's read/layout stress fixture can seed M0 canonical test graph objects for future physical kinds without claiming M1 discovers them. Visible projections are V500=500 nodes/1,000 edges, V200=200/350 and V1000=1,000/2,000. I10K is 100 sites×100 agents,one context/source each,five-minute jitter,99% unchanged/1% changed; add a forbidden org with matching address ranges to every API load read. Assert all fixture counts before starting timing.

```ts
const structuralRunsPerDay = sources * (86400 / cadenceSeconds) * changedFraction;
assert.equal(structuralRunsPerDay, 28_800); // I10K mixed load; stable case adds zero after bootstrap.
assert.equal(unchangedRunInserts, 0);
assert.equal(unchangedObservationInserts, 0);
```

Daily full revalidation with identical content adds zero history rows, so stable 10,000 sources add 10,000 initial runs rather than 2.88M/day; no periodic run checkpoints. Compact state and independently counted complete misses survive raw retention. Changed quotas bound abusive/high-churn storage; expired evidence clears optional pointers rather than current support. Test stale archival 7 days after freshness expires and detail retention 30 days.

Run measured performance on reference Linux x86-64/i7-12700, 8 performance cores excluding efficiency cores,16 GiB/SSD, no competing jobs; record CPU/version/power settings. Chromium 1440×900,4× CPU throttle,100ms RTT/10Mbps. Warm 100 API reads then 1,000 at concurrency 20;browser 30 opens/projection;report p50/p95/max and cold runs separately. API p95<500ms;interactive V500≤2s;layout V200≤1s;expanded≤3s. I10K real 24-hour soak accepted-change→publication p95≤10s,p99≤30s,zero lost accepted transitions and zero unchanged history inserts. A faster development machine is not substitute evidence.

- [ ] **Step 4: Run the complete milestone gates on the disposable stack and all native agent runners.**

```bash
pnpm --filter @breeze/api test:integration src/__tests__/integration/topologyFleetAcceptance.integration.test.ts src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/orgCascadeFkOnDelete.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts src/__tests__/integration/orgLifecycleFoundations.integration.test.ts src/__tests__/integration/orgMergeRegistry.integration.test.ts src/__tests__/integration/orgMergeCustomExecutors.integration.test.ts
pnpm --filter @breeze/api test:rls-coverage
pnpm --filter @breeze/api exec vitest run src/routes/devices/cascadeDelete.test.ts src/routes/devices/moveOrg.coverage.test.ts src/db/autoMigrate.test.ts src/services/workerEntrypointClosure.contract.test.ts
pnpm --filter @breeze/api exec tsc --noEmit
pnpm --filter @breeze/shared typecheck
pnpm --filter @breeze/web exec vitest run src/components/topology src/lib/__tests__/no-silent-mutations.test.ts
pnpm --filter @breeze/web build:prod
pnpm --filter @breeze/e2e-tests exec playwright test tests/topology-baseline.spec.ts tests/topology-worker.spec.ts tests/topology-performance.spec.ts --project=chromium
pnpm --filter @breeze/api exec tsx ../../scripts/topology/ingest-soak.ts --fixture I10K --duration-hours 24 --seed topology-v1 --output ../../test-results/topology-soak.json
bash scripts/check-migration-naming.sh --staged
bash scripts/check-migration-naming.sh --against-ref origin/main
pnpm db:check-drift
```

From `agent` run `go test -race ./...` on Linux, Windows and macOS. Also run macOS no-cgo collector tests/build. In each creating-schema PR, run the corresponding lifecycle bundle here rather than postponing it to release. Verify forged cross-org inserts as `breeze_app`, full graph/export/purge/site-ceiling cases, partner template purge, SET NULL invalidation, same-partner merge, asset collision, individual move and rejected late evidence. Read/audit/API/AI-context refreshes must create zero commands, schedules, model calls, history runs or layout saves.
- [ ] **Step 5: Commit fixtures/harness and captured non-sensitive acceptance summary:** `git commit -m "test(topology): gate baseline delivery on fleet and lifecycle behavior"`.

## M1 handoff

M1 is ready for review only when the 25 task deliverables and required native/real-DB/browser gates pass. Record failures as failures; a named check is not a passing result. Export the agreed collection/projector/diagnostic seams to M2–M4, keep recurring activation unavailable, and retain M0 rollout/kill-switch/rollback behavior. Run the index's milestone review and rollout checklist before enabling the resolved partner/org capability; no deployment or feature enablement is performed by this plan document.
