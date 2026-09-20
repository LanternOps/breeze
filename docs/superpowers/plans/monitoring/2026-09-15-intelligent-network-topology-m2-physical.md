# Intelligent Network Topology M2 — Reliable Physical Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enrich the existing logical map with trustworthy switch, port, and controller attachments while preserving evidence, identities, manual assertions, saved positions, and compatibility.

**Architecture:** Extend M1's normalized collection admission, digest confirmation, ordered source-support materializer, and M0's atomic graph publisher. SNMP and UniFi adapters contribute independently scoped outcomes and typed physical observations; a pure physical projector creates resolved port-pair links or explicitly ambiguous attachments. Physical view and exclusions consume the same scoped graph API and M1 layout/inspector components.

**Tech Stack:** Go/gosnmp, TypeScript/Zod, Hono, Drizzle/PostgreSQL RLS, existing BullMQ/agent transport, React/Cytoscape, M1's bundled ELK worker, Vitest and Playwright.

**Spec:** [Main design](../../specs/monitoring/2026-09-15-intelligent-network-topology-design.md), [Collection §§7–10](../../specs/monitoring/2026-09-15-intelligent-network-topology-collection.md), [Data/API §§1–8](../../specs/monitoring/2026-09-15-intelligent-network-topology-data-contracts.md), [Operations §§12–13](../../specs/monitoring/2026-09-15-intelligent-network-topology-operations.md). Dispatch/dependencies: [feature index](2026-09-15-intelligent-network-topology-INDEX.md).

## Global Constraints

- Requires completed M0 and M1. M1 remains useful without M2; interface-rate/history computation and physical-path incident reasoning belong to M3, AI to M4.
- Retain Astro/React, Cytoscape canvas, Postgres/Drizzle, BullMQ, and the existing agent command transport. No graph database, second ingestion pipeline, additional reconciliation queue, model-based coordinates, or new default controller polling on reads.
- Canonical relationship kinds are `network_member`, `default_route`, `egress_path`, `physical_link`, `attachment`; physical ports use tagged namespaces. Incomplete physical observations remain attachments, never guessed cables.
- Outcomes are `complete|partial|failed|unsupported|not_attempted`; transport `full|unchanged` is separate. Legacy payloads contribute positive observations only and have no authoritative absence semantics.
- Default adjacency budget: 30 seconds per target, four concurrent targets per collector; configurable limits can be lower. FDB limit: 20,000 rows/target/run. Adjacency upload: at most eight 1 MiB chunks. Seal at the earlier of the parent deadline and 10 minutes after first chunk; a sealed partial snapshot is immutable.
- Shared/upstream threshold: more than 16 distinct eligible unicast MACs per normalized port, not VLAN row count. FDB attachments are `inferred/medium`, `directness=unknown`; competing candidates remain `low` alternatives without an automatic selected parent.
- Reuse M1's SHA-256 canonicalization version 1, section digests, admission quotas, daily full revalidation, source epochs, compact confirmations, and second-complete-miss state machine. Two complete misses at least five minutes apart withdraw one source's support; stale automatic relationships archive seven days after last support expires. No new per-poll run/checkpoint rows for unchanged content.
- `TopologyScope = {orgId:string; siteId:string}` always comes from authorized request/producer context. Org RLS and application site authorization are both mandatory. Cross-scope composite FKs are `DEFERRABLE INITIALLY IMMEDIATE`; RLS is enabled and forced in the creating migration.
- Manual assertions, configured groups and pins do not age out with telemetry. Exclusions change a view only; they do not erase evidence, alter incident calculations, or silence alerts.
- API routes/enums remain those in Data/API. Mutations use `runAction`; local state uses hashes. Reads enqueue zero scans, polls, probes, schedules, or model calls.
- Resolve flags from partner/org JSON through M0's resolver. `physical` requires `materialization` and supported M2 capability; no site feature flags. Capture legacy writes across disabled flags and rollback.
- Migration names use `YYYY-MM-DD-HHMMSS-<slug>.sql` after the greatest committed basename on both local HEAD and freshly fetched `origin/main`, compared with JavaScript `localeCompare`. Allocate the actual slot at task execution and recheck after rebases; never edit or rename shipped migrations.
- Run tests with synthetic fixture addresses/identities; Go network I/O is mocked. No production/controller access is required to execute this plan.

## Ownership and dependencies

Existing files listed below were located with `rg --files` against the source baseline. Paths under `services/topology/`, `routes/topology/`, shared topology contracts and `components/topology/` are M0/M1 outputs; read those completed plans and use their actual exports before starting M2. Do not recreate their services under another name.

| Boundary | Responsibility |
| --- | --- |
| Shared `types/topologyPhysical.ts` and M1 `validators/topologyCollection.ts` | New physical row types and extensions to M1's collection validator; public graph and normalized collection types remain M1-owned. |
| Go `discovery/adjacency.go`, `snmppoll/fdb.go`, new focused V2 files | Typed SNMP collection, interface/port mapping, outcomes, bounded envelope construction. Keep legacy DTOs separate. |
| Existing discovery worker/agent WS and UniFi telemetry worker | Authenticate parent/source and adapt into the existing normalized ingest service. |
| `services/topology/collectionTypes.ts`, `collectionIngest.ts` | M1-owned accepted reports, digests, quotas, source epochs, staged runs and confirmations. M2 extends discriminants only. |
| `services/topology/physicalProjector.ts`, `physicalIdentity.ts` | New pure derivation and matching; no database mutation or health inference. |
| `services/topology/projectors.ts`, `reconcile.ts`, `jobs/topologyReconcileWorker.ts` | M1-owned ordered processing and atomic publication of derived graph/support changes. |
| `db/schema/topology.ts`, `topology_view_exclusions` | M0 schema extension; one new M2 table, plus forward constraints only if M1 interfaces need a physical identity field. |
| M0 `services/topology/manual.ts`, new `exclusions.ts` and scoped routes | Manual support and reversible view exclusions; M0 legacy capture/import remains the only migration channel. |
| `components/topology/` | Extend M1 projections, inspectors, lists and layout adapter for ports/parallel edges; retain legacy wrapper. |

**M1 interfaces consumed throughout this plan:**

```ts
// collectionTypes.ts — exported by M1, extended here with physical observations.
type AuthenticatedTopologyProducer = {
  scope: TopologyScope; producerId: string; producerEpoch: string;
  configurationRevision: string; parentJobId?: string; parentCommandId?: string;
};
type NormalizedTopologyReport =
  | {reportKind:'full'; snapshot:NormalizedTopologySnapshot}
  | {reportKind:'unchanged'; confirmation:TopologySourceConfirmation};
// Full snapshot scope includes protocol/context/family, epoch/sequence/digest,
// outcome and typed rows. Confirmation names the same scope and admitted base.
ingestTopologySourceReport(
  producer: AuthenticatedTopologyProducer,
  report: NormalizedTopologyReport,
): Promise<TopologyIngestReceipt>;

// reconciliationTypes.ts / projectors.ts — M1 owns these types and ordering.
projectTopology(input: TopologyProjectionInput): TopologyProjectionDelta;
// M2 registers this additional pure projector in projectTopology:
projectPhysicalTopology(input: TopologyProjectionInput): TopologyProjectionDelta;
// Input supplies pinned ordered source facts, support state, canonical identity
// candidates and interfaces. Delta carries nodes/interfaces/relationships,
// observations/support changes, aliases and bindings using M1's exact fields.

// M0 seam retained by M1 (M1 adds atomic collection/support participants).
publishTopologyBuild(scope, {
  buildFence, inputRevision, nodes, relationships, bindings,
}): Promise<{published:boolean; graphRevision:string}>;
```

M2 must use M1's exported snapshot/projection types, not invent a structurally similar second type. Tests below define new M2 pure helpers explicitly; integration fixtures use the actual M1 transaction harness and exported types. M2's sources and supports become visible only in the same publication transaction as their endpoints and relationship revision.

---

### Task 1: Define versioned physical source contracts and cross-language fixtures

**Files:**
- Create: `packages/shared/src/types/topologyPhysical.ts`.
- Modify (M0/M1 outputs): `packages/shared/src/types/topology.ts`, `packages/shared/src/validators/topologyCollection.ts`, `packages/shared/src/types/index.ts`, `packages/shared/src/validators/index.ts`, `apps/api/src/services/topology/collectionTypes.ts`.
- Create: `packages/shared/src/validators/topologyPhysical.test.ts`.
- Create: `packages/shared/src/fixtures/topology/adjacency-v2.json`, `packages/shared/src/fixtures/topology/unifi-topology-v1.json`.
- Create: `agent/internal/discovery/adjacency_v2.go`, `agent/internal/discovery/adjacency_v2_test.go`.

**Interfaces:**
- Consumes: M1 `CollectionOutcome`, `Section<T>`, normalized IP/MAC validators and canonicalization version 1.
- Produces: exported `PortRef`, `TypedId`, `LldpRow`, `CdpRow`, `FdbRow`, `AdjacencyV2`, `adjacencyV2Schema` with the exact Collection §7 field spelling; `UnifiTopologyV1` / `unifiTopologyV1Schema` as the additive typed companion to existing telemetry.
- `UnifiTopologyV1` contains `{version:1,producerEpoch,snapshotId,sequence,capturedAt,captureAgeAtSendMs,expectedIntervalSeconds,resources:[{controllerSiteId,kind,contentDigest,outcome,rowCount,omittedRowCount?,reasonCode?,rows}]}`. `kind=device_list|client_list|device_details|statistics`; each resource is a discriminated typed array. Client rows preserve `clientType:WIRED|WIRELESS|VPN|TELEPORT|unknown`, source-local ID/MAC and upstream ID; unavailable port/SSID/VLAN/signal values are null. This is an internal wire extension, not a new public graph enum.
- Existing `/agents/:id/unifi-telemetry` body gains optional `topologyV1:UnifiTopologyV1`; collector configuration advertises `acceptedUnifiTopologyVersions:[1]` only after the ingest validator is deployed. Without that advertisement, send the legacy upload only. Legacy telemetry never receives complete-absence authority by having a current server reinterpret it.

- [ ] **Step 1: Write contract regression cases and deterministic fixtures.** Fixture values use valid UUIDs, locally administered synthetic MACs, documentation IP ranges, and `2026-09-15T12:00:00Z`. Include complete-empty LLDP, failed CDP, successful Q-BRIDGE-only FDB, partial device details, and a VPN client. Use two Go structs mirroring the discriminated envelope rather than changing the legacy `DeviceAdjacency` shape.

```ts
import fixture from '../fixtures/topology/adjacency-v2.json';
import {adjacencyV2Schema} from './topologyCollection';
it('keeps complete-empty separate from failed and validates tagged ports', () => {
  const full = adjacencyV2Schema.parse(fixture);
  expect(full.reportKind).toBe('full');
  if (full.reportKind !== 'full') throw new Error('fixture must be full');
  expect(full.sections.find(s => s.kind === 'lldp')).toMatchObject({outcome:'complete', rowCount:0, rows:[]});
  expect(full.sections.find(s => s.kind === 'cdp')).toMatchObject({outcome:'failed', reasonCode:'timeout'});
  expect(adjacencyV2Schema.safeParse({...fixture, version:3}).success).toBe(false);
  expect(adjacencyV2Schema.safeParse({...fixture, sequence:'-1'}).success).toBe(false);
});
```

Add tables for zero/20,000/20,001 FDB rows, 255/256 UTF-8 bytes, invalid uint64 decimal strings, VLAN 0/4095, duplicate row keys, ifIndex namespace mismatch on CDP, malformed MAC subtypes, partial count mismatch, 8/9 chunks, oversize byte payload, and full/unchanged field exclusivity. Unknown minor optional properties may be ignored only after body-size checks. Go tests load the same JSON fixtures relative to the repository and round-trip semantic fields.

- [ ] **Step 2: Run the failing tests.** `pnpm --filter @breeze/shared exec vitest run src/validators/topologyPhysical.test.ts`; `cd agent && go test -race ./internal/discovery -run TestAdjacencyV2`. Expect missing V2 exports or rejected required fixture fields.
- [ ] **Step 3: Implement the discriminated contracts and extend normalized observation variants.** Keep `PortRef` explicit:

```ts
type PortRef = {
  namespace:'if_index'|'if_name'|'bridge_port'|'lldp_local'|'controller_port';
  value:string; resolvedInterfaceKey:string|null;
};
type TypedId = {subtype:string; value:string};
type FdbRow = {
  rowKey:string; bridgeContext:string; fdbId:number|null; mac:string;
  bridgePort:number; ifIndex:number|null;
  status:'learned'|'self'|'management'|'invalid'|'other';
  vlans:number[]; vlanMapping:'complete'|'partial'|'unknown'; ifName?:string;
};
```

Copy the normative envelope/LLDP/CDP field definitions from Collection §7, including required nulls and final scope manifest. Validate requested scope rather than allowing client-provided protocol/context strings to establish authority. Normalized physical observation discriminants are `lldp|cdp|fdb|unifi`; method and typed payload are separate from canonical relationship meaning. Exclude timestamps, sequence, LLDP timeMark, parent command/job and chunk shape from semantic digests; include typed IDs, outcomes, omissions and authorized configuration scope.
- [ ] **Step 4: Rerun both commands.** Expect PASS, including Go/API fixture equivalence and outcome changes producing different digests while timeMark-only changes do not.
- [ ] **Step 5: Commit these files.** `git add packages/shared/src/types/topologyPhysical.ts packages/shared/src/types/topology.ts packages/shared/src/validators/topologyCollection.ts packages/shared/src/types/index.ts packages/shared/src/validators/index.ts packages/shared/src/validators/topologyPhysical.test.ts packages/shared/src/fixtures/topology agent/internal/discovery/adjacency_v2.go agent/internal/discovery/adjacency_v2_test.go apps/api/src/services/topology/collectionTypes.ts`; `git commit -m "feat(topology): define physical collection contracts"`.

### Task 2: Repair LLDP/CDP namespace mapping and independent protocol outcomes

**Files:**
- Modify: `agent/internal/discovery/adjacency.go`, `agent/internal/discovery/scanner.go`, `agent/internal/discovery/snmp.go`, `agent/internal/snmppoll/templates.go`.
- Create: `agent/internal/discovery/adjacency_ports.go`, `agent/internal/discovery/adjacency_ports_test.go`, `agent/internal/discovery/adjacency_collection.go`, `agent/internal/discovery/adjacency_collection_test.go`.
- Modify: `agent/internal/discovery/adjacency_test.go`, `agent/internal/snmppoll/walk_test.go` where production walk seams require context/bounds.

**Interfaces:**
- Consumes: Task 1 typed rows and existing `snmppoll.SNMPClient`; M1 canonical interface identity/epoch conventions.
- Produces: `ParseLLDPV2(columns LLDPColumns, inventory []InterfaceIdentity) []LldpRow`, `ParseCDPV2(columns CDPColumns, inventory []InterfaceIdentity) []CdpRow`, `CollectPhysicalSections(ctx context.Context, walker PhysicalWalker, request PhysicalRequest) []PhysicalSection`.
- Define `LLDPColumns` with remote chassis/port subtype/value, remote name/address, local ID/subtype/description PDU slices; `CDPColumns` with device ID, port and address slices. `InterfaceIdentity` holds `Key`, `IfIndex`, `Name`, `Alias`, typed physical address and optional LLDP-local mapping. `PhysicalRequest` declares authorized target/context/requested protocols/deadline; `PhysicalWalker` exposes `Walk(ctx,oid) ([]gosnmp.SnmpPDU,error)` and no credentials in results.

- [ ] **Step 1: Add table-driven parsing/collection tests with injected walks.** The minimal LLDP regression must assert that timeMark and remoteIndex never become the port ID and that two remote entries on one port survive:

```go
func TestParseLLDPV2KeepsPortNamespace(t *testing.T) {
  pdu := func(oid string, v any) gosnmp.SnmpPDU { return gosnmp.SnmpPDU{Name: oid, Type: gosnmp.OctetString, Value: v} }
  cols := LLDPColumns{RemoteChassis: []gosnmp.SnmpPDU{
    pdu(snmppoll.LldpRemChassisIDOID+".400.7.1", []byte{2,0,0,0,0,1}),
    pdu(snmppoll.LldpRemChassisIDOID+".400.7.2", []byte{2,0,0,0,0,2}),
  }}
  got := ParseLLDPV2(cols, nil)
  if len(got) != 2 { t.Fatalf("lost remote tuple: %#v", got) }
  for _, row := range got {
    if row.LocalPort.Namespace != "lldp_local" || row.LocalPort.Value != "7" || row.LocalPort.ResolvedInterfaceKey != nil {
      t.Fatalf("invented interface mapping: %#v", row.LocalPort)
    }
  }
}
```

Use a fake `PhysicalWalker` recording requested OIDs; return complete-empty LLDP, timeout CDP, and nonempty FDB/interface tables. Assert every requested protocol has an outcome; FDB is attempted despite the others. Add noSuchObject→unsupported, timeout→failed, permission denial, malformed/truncated walk→partial, duplicate name ambiguity, MAC subtype versus six-byte arbitrary ID, CDP ifIndex≠bridge-port and interface remap/reboot cases. Test bounded concurrent targets and context cancellation without network sockets.
- [ ] **Step 2: Run failures.** `cd agent && go test -race ./internal/discovery ./internal/snmppoll -run 'TestParseLLDPV2|TestParseCDPV2|TestCollectPhysical'`. Expect missing new parsers/collector, then pin current parser failures before replacing them.
- [ ] **Step 3: Implement explicit namespace mapping and outcome collection.** Join remote LLDP columns on the full three-part tuple. Parse local portNum separately; fetch local/remote subtype tables. Resolve only an explicit mapping or unique subtype-aware inventory match. Never compare bare numeric values from different namespaces. Reuse the successfully authenticated SNMP session and attempt tables independently:

```go
// Inside the authenticated-target collector; each function reports its own
// outcome. A neighbors-empty result does not rotate credentials or skip FDB.
sections := []PhysicalSection{
  collectLLDPSection(ctx, walker, request),
  collectCDPSection(ctx, walker, request),
  collectFDBSection(ctx, walker, request),
  collectInterfaceSection(ctx, walker, request),
}
return sections
```

Define those four private functions in `adjacency_collection.go` with the same parameters and `PhysicalSection` return. In this task the FDB function maps the current BRIDGE assembler's positive rows to V2 with `fdbId:null`, `vlanMapping:'unknown'`, and partial Q-BRIDGE coverage; Task 3 replaces that bounded adapter with full tuple-based assembly. This keeps this task independently testable without claiming complete VLAN coverage. Independent means failure isolation, not four unbounded simultaneous walks on a shared unsafe session. Use an outer four-target worker pool and per-target 30-second child context. Negative unsupported cache is keyed by target/config/protocol for at most 24 hours; timeout is never cached as unsupported, config changes invalidate it. Keep legacy output as an adapter, while V2 includes successful-empty and failed sections.
- [ ] **Step 4: Rerun the focused command and `cd agent && go test -race ./internal/discovery/... ./internal/snmppoll/...`.** Expect all parser and race tests to pass with no live network I/O added.
- [ ] **Step 5: Commit.** Stage the listed Go source/tests only; `git commit -m "fix(topology): normalize LLDP and CDP port identities"`.

### Task 3: Collect independent BRIDGE/Q-BRIDGE evidence with correct FDB-to-VLAN mapping

**Files:**
- Modify: `agent/internal/snmppoll/fdb.go`, `agent/internal/snmppoll/fdb_test.go`, `agent/internal/discovery/snmp.go`, `agent/internal/discovery/adjacency_collection.go`.
- Create: `agent/internal/snmppoll/fdb_v2.go`, `agent/internal/snmppoll/fdb_v2_test.go`, `agent/internal/snmppoll/testdata/fdb_v2_golden.json`.

**Interfaces:**
- Consumes: Task 2 `PhysicalWalker`; Task 1 `FdbRow` wire meaning.
- Produces: `AssembleFdbV2(input FdbTables) FdbAssembly` in snmppoll. `FdbTables` contains bridge/Q-BRIDGE port/status tables, basePortIfIndex, ifName, `dot1qVlanFdbId`, per-table outcomes and bridge context. `FdbAssembly` returns normalized rows, aggregate section outcome, omitted count, and bounded reason codes. Preserve the existing legacy `AssembleFdbEntries` export through an explicit lossy compatibility projection.

- [ ] **Step 1: Write golden and table-driven tests.** Fixtures contain FDB ID 700 mapped to VLANs 10 and 20; another ID for the same MAC; empty legacy BRIDGE rows but populated Q-BRIDGE; unmapped FDB ID; ifIndex 101 mapping from bridgePort 7; self/invalid/port-zero; and a mapping table that times out. Assert tuple preservation and unknown mapping rather than assuming VLAN=FDB ID:

```go
func TestAssembleFdbV2QBridgeOnly(t *testing.T) {
  body, err := os.ReadFile("testdata/fdb_v2_golden.json")
  if err != nil { t.Fatal(err) }
  var input FdbTables
  if err := json.Unmarshal(body, &input); err != nil { t.Fatal(err) }
  got := AssembleFdbV2(input)
  if len(got.Rows) != 2 { t.Fatalf("lost Q-BRIDGE/duplicate-MAC tuples: %#v", got) }
  if !slices.Equal(got.Rows[0].VLANs, []uint16{10,20}) { t.Fatalf("FDB ID is not VLAN: %#v", got.Rows[0]) }
  if got.Rows[0].FDBID == nil || *got.Rows[0].FDBID != 700 { t.Fatal("lost FDB identity") }
  if got.Rows[0].IfIndex == nil || *got.Rows[0].IfIndex != 101 { t.Fatal("lost bridge mapping") }
}
```

The JSON fixture's first row is deterministically sorted by bridge context/FDB ID/MAC/port so the expected row is unambiguous. Keep status data even for rows the projector later rejects; row truncation must not claim complete absence.
- [ ] **Step 2: Run failure.** `cd agent && go test -race ./internal/snmppoll -run 'TestAssembleFdbV2|TestFdbV2'`. Expect no V2 assembler or collapsed Q-BRIDGE-only rows.
- [ ] **Step 3: Implement tuple-based assembly.** Fetch both FDB families and status/mapping tables independently, using `dot1qVlanFdbId` to build `map[fdbId]set[vlan]`. Never build one global MAC→VLAN map. A mapping failure makes `vlanMapping=unknown|partial` and records coverage; valid MAC/port positives remain usable without VLAN certainty. Bound reads before allocation at 20,000 rows; truncation yields `partial/limit_exceeded`. Preserve `fdbId=null` for legacy BRIDGE-only rows:

```go
type fdbTuple struct { BridgeContext string; FDBID uint32; HasFDBID bool; MAC string; Port uint32 }
// Row identity is fdbTuple. VLAN membership is the complete/partial set
// attached to that tuple, never a substitute for FDB identity.
```

Keep pure assembly free of transport credentials and socket calls. The V2 collector includes FDB even if LLDP/CDP is complete-empty or unsupported; legacy adapter does not invent a scalar VLAN when the V2 set is ambiguous.
- [ ] **Step 4: Rerun focused tests and `cd agent && go test -race ./internal/discovery/... ./internal/snmppoll/...`.** Require complete-empty versus partial mapping tests and stable ordering/digest tests.
- [ ] **Step 5: Commit.** Stage the listed Go files/fixture; `git commit -m "fix(topology): preserve Q-BRIDGE FDB and VLAN identity"`.

### Task 4: Wire authenticated chunked adjacency into M1 admission and ordered publication

**Files:**
- Modify: `agent/internal/heartbeat/handlers_network.go`, `agent/internal/heartbeat/handlers_test.go`, `apps/api/src/routes/agentWs.ts`, `apps/api/src/routes/agentWs.test.ts`, `apps/api/src/jobs/discoveryWorker.ts`.
- Create: `agent/internal/discovery/adjacency_transport.go`, `agent/internal/discovery/adjacency_transport_test.go`, `apps/api/src/services/topology/adjacencyAdapter.ts`, `apps/api/src/services/topology/adjacencyAdapter.test.ts`, `apps/api/src/services/topology/discoveryChunks.ts`, `apps/api/src/services/topology/discoveryChunks.test.ts`.
- Modify (M1): `apps/api/src/services/topology/collectionIngest.ts`, `apps/api/src/services/topology/collectionTypes.ts`, `apps/api/src/services/topology/collectionState.ts` and `apps/api/src/jobs/topologyReconcileWorker.ts` only where adapter registration requires it. Reuse `apps/api/src/services/redis.ts` for bounded pre-admission chunk storage.
- Create: `apps/api/src/__tests__/integration/topologyPhysicalIngest.integration.test.ts`.

**Interfaces:**
- Consumes: Tasks 1–3 `AdjacencyV2`, M1 `AuthenticatedTopologyProducer`, `ingestTopologySourceReport` and existing snapshot staging/digest state.
- Produces: `authorizeAdjacencyParent(agentDeviceId:string,parentJobId:string,parentCommandId:string):Promise<AuthenticatedTopologyProducer>`; it resolves stored command/job target ranges, configuration revision, deadline and status. `acceptAdjacencyV2(producer,body:AdjacencyV2):Promise<TopologyIngestReceipt[]>` stages/validates chunks and emits one normalized report per authorized section. `adaptLegacyAdjacency(producer,rows:DeviceAdjacency[]):NormalizedTopologyReport[]` emits positive-only unknown-completeness observations.
- `discoveryChunks.ts` exports `stageDiscoveryChunk(producer,body):Promise<{state:'staged'|'ready'|'sealed';snapshotId:string}>` and `sealDiscoverySnapshot(producer,snapshotId,now):Promise<NormalizedTopologyReport[]>`. Redis staging keys include server-authorized scope, parent job/command, epoch and snapshot ID; a seal fence in M1 compact source state commits atomically with normalized report admission, including successful-empty scopes. Limit one unfinished snapshot per parent/source and four staged snapshots/32 MiB total per collector (lower configuration limits apply); excess staging returns 429/Retry-After and never evicts accepted content. A forged sourceKey or new snapshot UUID cannot reset quota ownership. This is pre-admission transport storage, not a second observation pipeline.
- Go `BuildAdjacencyReports(input PhysicalSnapshot, acknowledged *PhysicalBaseline) ([]AdjacencyV2,error)` uses M1 shared digest/baseline/epoch persistence. `PhysicalSnapshot` binds the stored parent command/job, newly allocated sequence and actual capture to Task 2 sections; `PhysicalBaseline` is the server-acknowledged scope/digest/base only.

- [ ] **Step 1: Add transport and real-DB regression tests.** Extend existing command ownership tests before accepting `adjacencyV2`. Pin the cross-language Task 1 fixture; test mismatched agent/job/command, out-of-range source, changed config epoch, cancelled/expired parent, missing manifest, conflicting duplicate chunk, late chunk, row-key collision across chunks, byte/count/hash mismatch, and staged-only read invisibility. In the real M1 fixture create one FDB source and one LLDP source; assert partial LLDP cannot withdraw its old support while complete FDB positives publish.

```ts
// Integration sequence uses the M1 fixture producer/report builders; these
// are real ingest and reconcile calls, never mocks of the publication path.
const first = await acceptAdjacencyV2(producer, fullReport);
const retry = await acceptAdjacencyV2(producer, fullReport);
expect(retry).toEqual(first);
await reconcileTopologySite(producer.scope);
const before = await db.select().from(topologyCollectionRuns);
await acceptAdjacencyV2(producer, unchangedFromActualLaterRead);
expect(await db.select().from(topologyCollectionRuns)).toHaveLength(before.length);
```

Define `fullReport` and `unchangedFromActualLaterRead` in the new test by parsing Task 1 fixture and replacing only the fixture producer's server epoch/snapshot/sequence/capture and recomputed canonical digest; the latter references the ingest receipt's admitted base. Do not reuse an old capture as a new confirmation. Also assert one complete-empty full miss, an identical complete-empty confirmation six minutes later, and a retry produce exactly one compact second-miss transition; independent support remains active.
- [ ] **Step 2: Run failure.** `pnpm --filter @breeze/api exec vitest run src/services/topology/adjacencyAdapter.test.ts src/routes/agentWs.test.ts`; `cd agent && go test -race ./internal/discovery ./internal/heartbeat -run 'TestAdjacencyTransport|TestNetworkDiscoveryResult'`; live DB: `pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/topologyPhysicalIngest.integration.test.ts`. Expect missing adapter/capability handling and old unknown-completeness behavior.
- [ ] **Step 3: Implement tolerant server-first dispatch and adapter wiring.** Add `acceptedAdjacencyVersions:[2]` to authorized capable parent commands; agents send V2 only when advertised. The stored parent authorizes each new unchanged read independently. Stage chunks with bounded Redis hashes/bytes, immutable capture metadata and final manifest; use the existing repair scheduler to seal due assemblies at the earlier parent deadline/ten-minute boundary, and keep the storage TTL beyond that seal boundary so validated positive rows are not deleted before sealing. The server returns a staging receipt, never an accepted baseline, until M1 admission commits. Redis loss before admission returns `full_snapshot_required` and requires complete retransmission; it renews nothing and cannot lose an already admitted report. A durable source/epoch/sequence seal fence in M1 source state rejects late upgrade attempts even when the sealed partial had zero positive rows. Recheck parent authority at seal; expired/cancelled parents cannot produce current support. Adapt sealed scopes to M1 reports. A missing chunk makes only affected scopes partial; validated positives remain usable. Unknown or mismatched bases return `full_snapshot_required`; budget-rejected changes do not renew freshness. Do not acknowledge an envelope-wide baseline when a scope was rejected.

```ts
for (const report of normalizedAuthorizedSections) {
  receipts.push(await ingestTopologySourceReport(producer, report));
}
// No inserts into topology_nodes/topology_relationships here. M1's existing
// dirty revision + ordered worker publishes admitted changes/second misses.
```

`normalizedAuthorizedSections` is the adapter's explicit local result after schema validation, parent scope checks and one-time sealing, not an external helper. Intermediate chunk delivery uses the existing command-result/progress transport without marking its parent complete; complete the existing discovery command/job only after its final result/manifest or deadline handling. Bound the encoded frame, not merely its decoded rows, and preserve hosts/results when a topology section fails. Test final host-result arrival before the last chunk and retries of already completed parent data: accepted identical content is idempotent; new content after the authorized capture deadline cannot create current support. M0's compatibility adapter continues capturing legacy writers; stop legacy negative cleanup from influencing canonical support. The June `apps/api/src/jobs/reconcileTopology.ts` is not a v2 modification target; v2 reconciliation runs only through the M1 `topologyReconcileWorker.ts` and its registered projectors. Legacy `adjacency` missing from a report is never empty-authoritative.
- [ ] **Step 4: Rerun all commands, adding `pnpm --filter @breeze/api exec vitest run src/services/topology/discoveryChunks.test.ts`.** Assert response/graph revisions stay unchanged on stable confirmations, pending changed content cannot freshen older published evidence, and late chunks never upgrade an already sealed partial run. Test Redis loss before admission (no accepted baseline, full resend needed), Redis loss after admission (SQL report remains), simultaneous sealing workers, server restart and deadline with no chunks. Require actual PostgreSQL CAS/retry proof, not query-chain mocks alone.
- [ ] **Step 5: Commit.** Stage the task's listed changed/new files; `git commit -m "feat(topology): admit scoped physical observations through collection pipeline"`.

### Task 5: Bridge UniFi resource outcomes and scoped attachment identities

**Files:**
- Modify: `agent/internal/unifi/client.go`, `agent/internal/unifi/collector.go`, `agent/internal/unifi/client_pagination_test.go`, `agent/internal/unifi/collector_test.go`.
- Create: `agent/internal/unifi/topology.go`, `agent/internal/unifi/topology_test.go`, `agent/internal/unifi/testdata/topology_resources.json`.
- Modify: `apps/api/src/routes/agents/unifiTelemetry.ts`, `apps/api/src/routes/agents/unifiTelemetry.test.ts`, `apps/api/src/services/unifi/unifiTelemetryService.ts`, `apps/api/src/services/unifi/unifiTelemetryService.test.ts`, `apps/api/src/jobs/unifiTelemetryWorker.ts`.
- Create: `apps/api/src/services/topology/unifiAdapter.ts`, `apps/api/src/services/topology/unifiAdapter.test.ts`, `apps/api/src/__tests__/integration/topologyUnifiScope.integration.test.ts`.

**Interfaces:**
- Consumes: Task 1 `UnifiTopologyV1`, M1 `ingestTopologySourceReport`, authenticated collector configuration and existing controller-site mappings.
- Produces: `adaptUnifiTopology(producer,report:UnifiTopologyV1):Promise<TopologyIngestReceipt[]>` and `resolveUnifiSourceScope(collectorId:string,controllerSiteId:string):Promise<TopologyScope|null>`; the latter resolves exactly one integration/controller host/controller site mapping or quarantines.
- Go `ResourceOutcome` carries controller-site/resource kind, outcome/counts/reason and typed rows; extend `Snapshot` with independent outcomes. `CollectDeviceDetails(ctx,siteID,deviceID)` returns typed supported interface/uplink identities plus outcome; statistics remain explicitly `not_attempted` in M2 unless already collected by a supported implementation. Null metrics have capability reasons; no rate/counter interpretation here.

- [ ] **Step 1: Add scoped fixture tests.** Test page one succeeds/page two times out (first-page rows survive as partial), duplicate/looped pages, omitted sites, one site successful/another failed, detail 404 with successful device/client lists, unknown controller site, same controller ID on two controllers/sites, same MAC in two sites and duplicate MACs within one site. Keep client `VPN|TELEPORT` through collector→API→normalized report; absent type plus `isWired=false` remains unknown.

```ts
// Pure identity helper introduced here and used by adapter enrichment.
type ScopedMacCandidate = {id:string; orgId:string; siteId:string; mac:string};
function uniqueSiteMacMatch(scope:TopologyScope, mac:string, rows:ScopedMacCandidate[]):string|null;
it('never binds the first org-wide MAC match', () => {
  const scope = {orgId:'org-a', siteId:'site-a'};
  const mac = '02:00:00:00:00:01';
  expect(uniqueSiteMacMatch(scope, mac, [{id:'foreign',orgId:'org-a',siteId:'site-b',mac}])).toBeNull();
  expect(uniqueSiteMacMatch(scope, mac, [
    {id:'a',...scope,mac}, {id:'b',...scope,mac},
  ])).toBeNull();
});
```

These are pure opaque identity keys; API tests use real UUIDs. Define/export `uniqueSiteMacMatch` from `unifiAdapter.ts`, normalize MAC format with existing `unifiMac.ts`, and return a binding only for exactly one same-scope candidate. Add real DB duplicate/foreign-site fixtures proving queries themselves include site scope, not only the helper.
- [ ] **Step 2: Run failure.** `cd agent && go test -race ./internal/unifi/...`; `pnpm --filter @breeze/api exec vitest run src/services/topology/unifiAdapter.test.ts src/services/unifi/unifiTelemetryService.test.ts src/routes/agents/unifiTelemetry.test.ts`; DB: `pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/topologyUnifiScope.integration.test.ts`.
- [ ] **Step 3: Implement independent resource manifests and source mapping.** Keep current authenticated Integration API and its pagination caps. Refactor paginated results to retain validated earlier pages and their partial outcome; an endpoint 404 applies only to that resource. Fetch supported device-detail port/uplink identity through the documented Integration API detail endpoint using bounded existing poll scheduling; unsupported firmware/detail fields remain unknown. Record separate per-site `device_list`, `client_list`, `device_details`, `statistics` outcomes, even when details/statistics are not attempted. Do not claim statistics coverage from the list endpoint. Preserve typed upstream identity and optional port; use controller-reported fields only after a recorded versioned fixture validates their meaning.

```ts
const scope = await resolveUnifiSourceScope(collector.id, resource.controllerSiteId);
if (!scope) {
  // Store one bounded unmapped coverage reason; emit no topology support.
  continue;
}
// Find upstream in this integration/host/controller-site namespace, then
// match inventory only among this scope's unique canonical MAC candidates.
```

Implement that flow inside `adaptUnifiTopology`; no fallback to `collector.siteId`. Unbound controller endpoints are legitimate canonical endpoints. Enrich existing inventory binding where unambiguous; never create managed devices or override manual inventory type/link suppression. Raw telemetry's existing fields remain backward compatible, but new topology uses normalized typed rows only. Apply server-side M1 digest comparison even if existing collector uploads a full body every poll. Roaming retains client identity; new support appears immediately and the prior association follows source-local withdrawal. Older collectors are positive-only and cannot promote `isWired=false` to wireless.
- [ ] **Step 4: Rerun commands.** Require zero controller/agent polls on graph GET, no per-poll normalized rows on stable reports, partial list confirmations renewing only present clients, and mapping/config changes fencing old producer epochs.
- [ ] **Step 5: Commit.** Stage the task files; `git commit -m "feat(topology): reconcile scoped UniFi attachments and coverage"`.

### Task 6: Project canonical physical links, ambiguous attachments and independent supports

**Files:**
- Create: `apps/api/src/services/topology/physicalIdentity.ts`, `physicalIdentity.test.ts`, `physicalProjector.ts`, `physicalProjector.test.ts`.
- Modify (M1): `apps/api/src/services/topology/projectors.ts`, `reconciliationTypes.ts`, `reconcile.ts` and existing interface identity service only where explicit physical attributes are added.
- Create: `apps/api/src/services/topology/physicalFixtures.ts`, `apps/api/src/__tests__/integration/topologyPhysicalPublication.integration.test.ts`.

**Interfaces:**
- Consumes: M1 `TopologyProjectionInput` with ordered admitted physical observations/support state and published identities; M0 alias/pin/binding merge rules.
- Produces: `projectPhysicalTopology(input:TopologyProjectionInput):TopologyProjectionDelta`; `physicalLinkKey(a:EndpointPort,b:EndpointPort):string` where `EndpointPort={nodeId:string,interfaceId:string}`; `selectFdbParent(candidates:FdbCandidate[]):FdbSelection` where candidate contains source/observation IDs, upstream/client node IDs, normalized interface ID/null, context, eligible MAC set and competing-uplink evidence. Selection is `{selected:FdbCandidate|null,alternatives:FdbCandidate[],reason:string|null}`.
- `physicalFixtures.ts` is test-only: `physicalFixture(name:'reciprocal-parallel'|'ambiguous-fdb'|'lag-cycle'|'identity-enrichment'):TopologyProjectionInput`. It constructs typed snapshots with two switches, three actual port pairs, source support and fixed UUIDs; it performs no database or network work and is imported only by tests.

- [ ] **Step 1: Write invariants before the projector.** Reciprocal LLDP+CDP for pair A1–B1 must create one link with four retained supports, A2–B2 another, and unresolved remote ports candidates only. Fixture includes a three-switch cycle and a LAG parent with two individually selectable member links; no spanning-tree deletion is allowed.

```ts
it('keeps parallel cables distinct and merges reciprocal evidence', () => {
  const a1={nodeId:'A',interfaceId:'A1'}, b1={nodeId:'B',interfaceId:'B1'};
  const a2={nodeId:'A',interfaceId:'A2'}, b2={nodeId:'B',interfaceId:'B2'};
  expect(physicalLinkKey(a1,b1)).toBe(physicalLinkKey(b1,a1));
  expect(physicalLinkKey(a1,b1)).not.toBe(physicalLinkKey(a2,b2));
  const delta = projectPhysicalTopology(physicalFixture('reciprocal-parallel'));
  const links = delta.relationships.filter(r => r.kind === 'physical_link');
  expect(links).toHaveLength(2);
  expect(new Set(links.map(r => r.identityKey)).size).toBe(2);
});
```

Add tests for 16/17 distinct unicast MAC threshold with duplicated VLAN rows; ifIndex/bridge namespace mismatch; invalid/self/multicast/zero-port rejection; single FDB candidate directness unknown; competing candidates low confidence/no selected parent; label/IP-only matches refused; duplicate MAC ambiguity; source-specific empty→partial→empty and independent support; schema/directness/confidence rules; identical facts in reordered input yield identical keys/delta. Match M1's exact exported delta relationship property names rather than duplicate graph types.
- [ ] **Step 2: Run failure.** `pnpm --filter @breeze/api exec vitest run src/services/topology/physicalIdentity.test.ts src/services/topology/physicalProjector.test.ts`; DB: `pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/topologyPhysicalPublication.integration.test.ts`.
- [ ] **Step 3: Implement pure derivation and register it once.** Build a key by sorting resolved `(nodeId,interfaceId)` tuples and serializing with a versioned, unambiguous encoding. Scope is enforced by M1 input and the scoped unique key. Preserve remote ID subtype, bridge context and interface epoch. Name-only or port-unresolved observations remain candidate attachments; every inferred attachment records rule ID/version, support IDs, limitations and rejected alternatives. Match remote chassis/controller identity only within authorized scope and only uniquely. Do not let subnet/gateway/name evidence create physical links.

```ts
export function physicalLinkKey(a:EndpointPort,b:EndpointPort):string {
  const endpoints=[a,b].map(x=>[x.nodeId,x.interfaceId]).sort((x,y)=>
    x[0]!.localeCompare(y[0]!) || x[1]!.localeCompare(y[1]!));
  return JSON.stringify(['physical-link-v1',...endpoints]);
}
```

The graph builder consumes M1's source support transitions; the projector must not maintain a second miss counter. Aggregate support only after ordered publication, withdraw only when all source/manual support is absent, and keep stale active links distinct from fresh healthy status. Identity enrichment adds a binding to the existing node; any justified duplicate merge uses oldest UUID, aliases and one scoped transaction. Conflicting pins stop auto-merge; preserve manual relationships and all view positions. LAG membership is explicit interface parent/member metadata, never a deduplication key or proof of usable redundancy.
- [ ] **Step 4: Rerun unit/real-DB tests.** Assert a stale build fence cannot publish any interfaces/supports/aliases; readers never see new interfaces with an old relationship revision. An ifIndex reuse/new epoch cannot inherit old link/metric identity. Graph health remains `unknown` without M1/M3 measured inputs; physical discovery is not a successful probe.
- [ ] **Step 5: Commit.** Stage the projector/identity/tests and exact M1 registration edits; `git commit -m "feat(topology): materialize canonical physical relationships"`.

### Task 7: Add reversible view exclusions with complete tenant lifecycle coverage

**Files:**
- Modify (M0 schema): `apps/api/src/db/schema/topology.ts`, schema barrel if necessary.
- Create: `apps/api/migrations/<next-ordered-slot>-topology-view-exclusions.sql`, `apps/api/src/db/schema/topologyExclusions.test.ts`, `apps/api/src/__tests__/integration/topologyExclusionsRls.integration.test.ts`. `<next-ordered-slot>` is the execution-derived `YYYY-MM-DD-HHMMSS` filename required by the migration freshness contract, not an unresolved schema decision.
- Modify: `apps/api/src/services/tenantCascade.ts`, `tenantExportPolicyRegistry.ts`, `orgMergeRegistry.ts`; extend M0 topology lifecycle integration fixtures and existing `tenantCascade.integration.test.ts`, `orgMergeRegistry.integration.test.ts`, `tenantExportErasureRoundtrip.integration.test.ts` under `apps/api/src/__tests__/integration/`.

**Interfaces:**
- Consumes: M0 `topology_relationships(id,org_id,site_id)`, same-scope sites and org merge/lifecycle transaction.
- Produces: `topologyViewExclusions` schema with `id,org_id,site_id,relationship_id,view,reason,created_by,revoked_at,created_at,updated_at`; unique active `(org_id,site_id,relationship_id,view)` where `revoked_at IS NULL`; views exactly `overview|physical|logical`.

- [ ] **Step 1: Write schema, RLS and lifecycle tests.** Read existing real-DB topology manual write and RLS fixtures first. Seed with admin fixture helpers, then use a verified unprivileged `breeze_app` connection to assert cross-org SELECT invisibility and INSERT/UPDATE/DELETE denial. Forge a relationship from another site using local org/site values: expect FK rejection even with same-org RLS visibility. Verify `condeferrable=true`, `condeferred=false`, enabled+forced RLS and active uniqueness:

```sql
SELECT conname, condeferrable, condeferred
FROM pg_constraint
WHERE conrelid='topology_view_exclusions'::regclass AND contype='f';
-- Assert every org-bearing FK is deferrable and initially immediate.
SELECT relrowsecurity, relforcerowsecurity
FROM pg_class WHERE oid='topology_view_exclusions'::regclass;
-- Assert both true; do not accept a BYPASSRLS runtime role.
```

Test parent relationship deletion cascades exclusions, whole-org merge preserves UUID/view/reason and final FKs, device/site moves retain original-scope historical exclusions, partner purge deletes them, and portable export includes reviewed scalar columns only.
- [ ] **Step 2: Run failures and select the migration slot.** `pnpm --filter @breeze/api exec vitest run src/db/schema/topologyExclusions.test.ts`; `pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/topologyExclusionsRls.integration.test.ts`. Fetch `origin/main`, inspect top-level committed SQL basenames on HEAD and that fetched ref, sort with JavaScript `localeCompare`, and assign a strictly later `YYYY-MM-DD-HHMMSS` basename with slug `topology-view-exclusions`. Recheck after rebasing. Use the index's allocation procedure; no calendar-date or reserved-slot assumption may bypass it.
- [ ] **Step 3: Implement additive idempotent migration, schema and registrations in this same commit.** Use `CREATE TABLE IF NOT EXISTS`, `DO`/catalog checks for constraints/policies, no inner transaction, and the actual M0 relationship/site constraint names. Core constraint shape:

```sql
FOREIGN KEY (relationship_id, org_id, site_id)
  REFERENCES topology_relationships(id, org_id, site_id)
  ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE
```

Add scoped site FK with the same deferrability. RLS policies use `breeze_has_org_access(org_id)` for both USING and WITH CHECK; direct org shape is auto-discovered. Register table in `CORE_ORG_CASCADE_DELETE_ORDER` and `CORE_TENANT_EXPORT_POLICY`; classify every column. This table has no open-container columns; every new JSON/JSONB/BYTEA field added elsewhere in this milestone is `excludedOpen` with a reason, and suspicious-name digest scalars use reviewed inclusion as needed. Add explicit `orgMergeRegistry` `{kind:'repoint'}` disposition: whole-org merge retains relationship UUIDs and repoints both FK sides with constraints deferred. This is a graph child, not a current inventory binding, so it does not enter device-denormalization lists; the existing M0 binding entries must continue passing their coverage tests. No append-only DELETE revocation is added.
- [ ] **Step 4: Run real DB and complete schema gates.** Use isolated `.env.test` with real Postgres/Redis and a verified `DATABASE_URL_APP` for `breeze_app`; a skipped suite is not a pass. Execute:

```bash
bash scripts/check-migration-naming.sh --staged
bash scripts/check-migration-naming.sh --against-ref origin/main
pnpm --filter @breeze/api exec vitest run src/db/autoMigrate.test.ts src/db/schema/topologyExclusions.test.ts src/routes/devices/cascadeDelete.test.ts src/routes/devices/moveOrg.coverage.test.ts
pnpm --filter @breeze/api test:rls-coverage
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/topologyExclusionsRls.integration.test.ts src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/orgCascadeFkOnDelete.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts src/__tests__/integration/orgLifecycleFoundations.integration.test.ts src/__tests__/integration/orgMergeRegistry.integration.test.ts src/__tests__/integration/orgMergeCustomExecutors.integration.test.ts src/__tests__/integration/tenantCascadePartner.integration.test.ts
pnpm db:check-drift
```

Also run M0's actual topology device/site-move, org-merge and partner-purge behavioral fixtures from the completed M0 plan. Reapply the new migration against the test DB and assert no duplicate policies/constraints/rows. Do not use `vitest.config.rls.ts` for catalog coverage; the dedicated `test:rls-coverage` script uses `vitest.config.rls-coverage.ts`.
- [ ] **Step 5: Commit.** Stage the exact migration/schema/registries/tests, including any export classification edits for Task 1/4/5 normalized fields; `git commit -m "feat(topology): persist scoped reversible view exclusions"`.

### Task 8: Wire manual physical assertions and exclusions through shared scoped mutations

**Files:**
- Modify (M0 outputs): `apps/api/src/routes/topology/index.ts`, `apps/api/src/routes/topology/manual.ts`, `apps/api/src/services/topology/legacyImport.ts`, `apps/api/src/services/topology/legacyCapture.ts` only where compatibility projection changes require it.
- Create: `apps/api/src/routes/topology/exclusions.ts`, `exclusions.test.ts`, `apps/api/src/services/topology/exclusions.ts`, `exclusions.test.ts`.
- Modify (M0): `apps/api/src/services/topology/manual.ts`, `apps/api/src/services/topology/manual.test.ts`; keep manual-node, relationship-support and legacy compatibility ownership in the same existing service.
- Create: `apps/api/src/__tests__/integration/topologyPhysicalManual.integration.test.ts`.
- Modify: `apps/api/src/routes/discovery.manualEdge.test.ts` and M0 legacy backfill/drain tests.

**Interfaces:**
- Consumes: M0 validated request scope, inventory/canonical endpoint resolution, manual source support and transactional outbox; Task 7 exclusions table.
- Produces: `createViewExclusion(ctx:TopologyRequestContext,relationshipId:string,input:{view:'overview'|'physical'|'logical';reason:string})` and `revokeViewExclusion(ctx:TopologyRequestContext,relationshipId:string,exclusionId:string)`; return updated exclusion and graph revision using M0 atomic projection mutation. Extend M0's exact `createTopologyManualRelationship(ctx,input)` and `deleteTopologyManualRelationship(ctx,relationshipId)` exports in `manual.ts` rather than introducing renamed duplicate services. All obtain scope from `ctx.scope` and actor from authenticated context, recheck referenced objects, and do not trust caller-supplied actor/org/site data.
- Public endpoints exactly: `POST /topology/sites/:siteId/manual-relationships`, `DELETE .../manual-relationships/:relationshipId`, `POST .../relationships/:relationshipId/exclusions`, `DELETE .../relationships/:relationshipId/exclusions/:exclusionId`. Read requires `topology:read`+`devices:read`; mutations additionally `topology:write` and site access. Cross-scope object IDs return 404.

- [ ] **Step 1: Write behavior/security tests.** Build Hono with the normal auth middleware and the actual topology routes. Create observed and manual support for one resolved pair. Deleting manual support preserves the observed relation; exclusion removes it from only the specified projection, keeps inspector/evidence and all alert/support rows unchanged, and revoke restores it without polling. Body validation rejects `presentation:` IDs, foreign interfaces, mismatched interface owners, unsupported relationship meaning, forged observed/high confidence, nonmanual deletion and empty/oversize reasons. Include unauthenticated, read-only, wrong org, denied same-org site, missing object, conflict, transaction rollback and audit cases.

```ts
const hidden = await app.request(`/topology/sites/${siteId}/relationships/${relationshipId}/exclusions`, {
  method:'POST', headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
  body:JSON.stringify({view:'physical',reason:'Port mapping awaiting verification'}),
});
expect(hidden.status).toBe(201);
const {id:exclusionId} = await hidden.json();
const restored = await app.request(`/topology/sites/${siteId}/relationships/${relationshipId}/exclusions/${exclusionId}`, {
  method:'DELETE', headers:{Authorization:`Bearer ${token}`},
});
expect(restored.status).toBe(200);
expect(await getTestDb().select().from(topologyRelationshipSupport)).toEqual(supportBefore);
```

Set `siteId`, relation, auth token and `supportBefore` in the test using M0 real graph seeding plus `setupTestEnvironment`/`getTestDb`; use the M0 actual route response envelope when extracting the ID. The equality compares full support snapshots to prove exclusions have no evidence side effects. Add old-client edit/delete racing backfill, worker restart and delayed-commit capture cases at the common barrier; manual/pin/deletion mismatch count must remain zero.
- [ ] **Step 2: Run failure.** `pnpm --filter @breeze/api exec vitest run src/routes/topology/exclusions.test.ts src/services/topology/exclusions.test.ts src/services/topology/manual.test.ts src/routes/discovery.manualEdge.test.ts`; DB: `pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/topologyPhysicalManual.integration.test.ts`.
- [ ] **Step 3: Implement constrained manual semantics and reversible exclusions.** Derive org/site/actor server-side, validate both endpoints and optional interfaces under that scope, and set evidence `manual/asserted` regardless of client input. A confirmed manual cable needs both endpoints and unique manual connection key; absent port detail must not merge it into a measured exact cable. Deleting manual support never deletes independent observed support. Exclusions are atomic scoped create/revoke with active uniqueness and graph revision change for affected views; evidence remains inspectable. No monitor/alert/source state changes.

```ts
// SQL shape inside the authorized service transaction, with a resolved
// same-scope relationship. Revocation is reversible history, not deletion.
await tx.update(topologyViewExclusions)
  .set({revokedAt:now, updatedAt:now})
  .where(and(eq(topologyViewExclusions.id,exclusionId),
    eq(topologyViewExclusions.relationshipId,relationshipId),
    eq(topologyViewExclusions.orgId,scope.orgId),
    eq(topologyViewExclusions.siteId,scope.siteId)));
```

Use M0's existing capture→snapshot→ordered drain→common-barrier comparison tooling; do not backfill again or bypass capture for new manual relationships. Preserve imported pins; legacy LLDP/CDP/FDB lacking port identities remain positive candidates. Compatible v2 manual changes project back to legacy writes, while v2-only assertions survive rollback and remain exportable. Flag disable stops physical publication without deleting facts or stopping legacy capture. Exclusions do not rewrite canonical traversal/incident input.
- [ ] **Step 4: Rerun commands and M0 barrier/replay tests.** Require no support loss, exact-site checks independent of RLS, and zero undelivered events/manual/pin/deletion mismatches at the comparison barrier.
- [ ] **Step 5: Commit.** Stage only the listed route/service/test edits; `git commit -m "feat(topology): support physical assertions and reversible exclusions"`.

### Task 9: Expose physical coverage, ports and ambiguity in the existing topology UI

**Files:**
- Modify (M1 outputs): `apps/web/src/components/topology/TopologyExplorer.tsx`, `apps/web/src/components/topology/TopologyInspector.tsx`, `apps/web/src/components/topology/TopologyList.tsx`, `apps/web/src/components/topology/layoutAdapter.ts`, `apps/web/src/components/topology/useTopologyGraph.ts`.
- Create: `apps/web/src/components/topology/PhysicalEvidencePanel.tsx`, `PhysicalEvidencePanel.test.tsx`, `PhysicalCoveragePanel.tsx`, `PhysicalCoveragePanel.test.tsx`, `RelationshipExclusionAction.tsx`, `RelationshipExclusionAction.test.tsx`.
- Create: `apps/api/src/services/topology/physicalProjection.ts`, `apps/api/src/services/topology/physicalProjection.test.ts`; register in M0's `apps/api/src/services/topology/graph.ts` without replacing M1's logical projection.
- Modify: M0 scoped graph/relationship/evidence route tests and `apps/web/src/locales/en/discovery.json` plus sibling discovery locale files under `apps/web/src/locales/` used by M1 topology.
- Retain compatibility entry: `apps/web/src/components/discovery/NetworkTopologyMap.tsx`; do not rewrite legacy fCoSE or duplicate M1's ELK worker.

**Interfaces:**
- Consumes: shared `GraphResponse`, `GraphRelationship`, `CoverageReason`, M1 topology selection/hash/API/worker contracts, Task 8 endpoints.
- Produces: `PhysicalEvidencePanel({relationship:GraphRelationship})`, `PhysicalCoveragePanel({coverage:GraphResponse['coverage']})`, `RelationshipExclusionAction({siteId,relationshipId,view,canEdit,onChanged})`; pure `projectPhysicalView(input:PhysicalViewInput):PhysicalViewResult` in `physicalProjection.ts`, where `PhysicalViewInput={nodes:GraphNode[];relationships:GraphRelationship[];excludedRelationshipIds:ReadonlySet<string>}` and `PhysicalViewResult={nodes:GraphNode[];relationships:GraphRelationship[]}`. It filters published physical/attachment entities and preserves canonical IDs/evidence metadata; M0's read service owns authorized totals, exclusions and bounded frontier generation. Do not reuse reconciliation mutation types for a read projection. Existing accessible list and inspector receive equivalent relationship actions. Extend M1 port-aware layout graph mapping; no new persistent coordinate format.

- [ ] **Step 1: Write projection/UI tests.** Assert physical view shows real links plus attachment candidates with explicit directness/alternatives, not schematic/inferred subnet links as cables. Complete-empty, unsupported, timeout, partial chunk/page, missing credentials, unresolved interface and unmapped controller site have different localized reasons. Test read-only user, delayed update/stale evidence, long labels, keyboard list selection, live-region behavior, and exclusions create/revoke through `runAction` including HTTP-200 failure and 401 redirect behavior.

```tsx
render(<PhysicalEvidencePanel relationship={fdbRelationship} />);
expect(screen.getByTestId('topology-relationship-meaning')).toHaveTextContent('Attachment');
expect(screen.getByTestId('topology-directness')).toHaveTextContent('Direct connection not established');
expect(screen.queryByTestId('topology-cable-utilization')).not.toBeInTheDocument();
```

Define `fdbRelationship` as a typed `GraphRelationship` test fixture using an inferred/medium FDB attachment, `directness:'unknown'`, one timestamped source, no metric series and unmonitored health. UI unit tests may use labels as appropriate; all Playwright queries in Task 10 use `data-testid` only.
- [ ] **Step 2: Run failure.** `pnpm --filter @breeze/web exec vitest run src/components/topology/PhysicalEvidencePanel.test.tsx src/components/topology/PhysicalCoveragePanel.test.tsx src/components/topology/RelationshipExclusionAction.test.tsx`; `pnpm --filter @breeze/api exec vitest run src/services/topology/physicalProjection.test.ts`.
- [ ] **Step 3: Implement truthful projection and interactions.** Neutral solid physical links, dashed logical relationships, dotted inferred/schematic meaning; reserve red/amber for measured health. Show both known endpoint ports, source protocol/reporter, collected/last-confirmed times, evidence expiry, distinct confidence/freshness and conflicts. FDB is “Learned through this port,” unresolved port “Port not identified,” shared port “Shared or upstream port.” Wireless controller association and VPN/tunnel association are different labels; unavailable port rates stay unavailable until M3.

```ts
await runAction({
  request: () => fetchWithAuth(
    `/topology/sites/${siteId}/relationships/${relationshipId}/exclusions`,
    {method:'POST',headers:{'Content-Type':'application/json'},
     body:JSON.stringify({view,reason})}),
  errorFallback:t('topology.exclusionFailed'),
  successMessage:t('topology.relationshipHidden'),
});
```

Place the request in M1's shared API action hook, preserving its `ActionError` handling (`401` returns to let auth redirect; other ActionErrors are already toasted; non-ActionErrors receive an error toast). Do not add a second raw fetch wrapper if M1 already owns one. Coverage setup actions are permission-gated; refresh only reads. Add ports/parallel edge IDs to M1 worker input; cycles remain in the view. Preserve all saved/pinned positions, selection and viewport on enrichment; place only new nodes with existing 32px bounds spacing, 96px layers and 48px groups. Unplaced readers get local layout; only explicit editor Apply saves. Physical empty view offers “View network overview.” Hash view/edge selection survives back/forward, site change rejects stale selection, and exclusions are reversible from the connection list.
- [ ] **Step 4: Rerun commands plus M1 real layout-engine tests and `pnpm --filter @breeze/web exec vitest run src/lib/__tests__/no-silent-mutations.test.ts`.** Verify graph GET/refresh causes zero writes/probes/model calls; hidden relationships remain accessible through authorized evidence/list inspection with exclusion state.
- [ ] **Step 5: Commit.** Stage the task's UI/API projection/localization tests/files; `git commit -m "feat(topology): show physical evidence and coverage"`.

### Task 10: Prove end-to-end enrichment, compatibility and rollback gates

**Files:**
- Create: `e2e-tests/tests/topology-physical.spec.ts`, extending M1 `e2e-tests/pages/TopologyPage.ts`.
- Create: `apps/api/src/__tests__/integration/topologyPhysicalVertical.integration.test.ts`.
- Extend M1 `apps/api/src/__tests__/helpers/topologyM1.ts`, `scripts/topology/fixtures.ts`, `scripts/topology/ingest-soak.ts` fixture/seed and benchmark entry points; record results in `docs/superpowers/plans/monitoring/2026-09-15-intelligent-network-topology-m2-verification.md` when actually run.
- Update feature implementation status/acceptance references in the feature index; do not change spec promises to match a failed implementation.

**Interfaces:**
- Consumes: Task 1 wire fixtures → existing authenticated ingest → M1 ordered materializer → scoped graph API → production-built M1 worker/UI; M0 rollout flags/capture/barrier tools.
- Produces: executable `physical-enrichment` acceptance fixture and measured release report with commit/build/agent/capability versions, tests, screenshots, graph/coverage counts and gate status. No new runtime service.

- [ ] **Step 1: Write the vertical regression before enabling physical by default.** Start with the M1 no-management graph and saved pinned endpoint positions, ingest SNMP and controller fixtures through real adapters, publish, then inspect via graph routes. Expect baseline logical facts retained, reciprocal links combined, parallel ports distinct, FDB-only attachments available, VPN not drawn as radio/copper, and ambiguity visible. One protocol timeout must not erase another source's support. Complete-empty twice six minutes apart withdraws only that source; repeated unchanged rows create no extra runs/revisions. Advance the real fixture clock, not sleeps. Inject a worker crash between admission and publish and retry without lost transitions.

```ts
// Playwright: M1 seed exposes known test node IDs and stable data-testids.
await page.getByTestId('topology-view-select').selectOption('physical');
await page.getByTestId('topology-relationship-row-parallel-a').click();
await expect(page.getByTestId('topology-source-port')).toHaveText('port-1');
await expect(page.getByTestId('topology-target-port')).toHaveText('port-24');
await page.getByTestId('topology-relationship-row-fdb-only').click();
await expect(page.getByTestId('topology-directness')).toHaveText('Direct connection not established');
```

The seed assigns those test IDs to fixture relationships in `TopologyPage` mappings; do not use labels/CSS selectors to locate DOM elements. Add explicit checks for no request to discovery/diagnostic/AI mutation paths on opening/refetching/selection; layout result retains pinned coordinates byte-for-byte. Use the actual production worker, CSP and font measurements; mock controller/SNMP external transport, not graph routes or layout engine. Light/dark, 390px width, 200% zoom, long translated labels and keyboard-only list/actions get screenshots/assertions.
- [ ] **Step 2: Run the failing new acceptance suites.** `pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/topologyPhysicalVertical.integration.test.ts`; `pnpm --filter @breeze/e2e-tests exec playwright test tests/topology-physical.spec.ts`. Expect missing fixture/projection assertions until the seams are wired.
- [ ] **Step 3: Complete only demonstrated seam gaps and the release fixture.** Add deterministic fixture variants `fdb-only`, `qbridge-shared-fdb`, `reciprocal-parallel`, `partial-controller-page`, `source-remap`, `manual-pinned-import`, and `legacy-agent-positive-only` to M1's existing seed entry. Exercise physical flag disable/re-enable with capture continuing and zero dropped manual/pin/deletion edits after drain. Retain v2-only manual facts in rollback; do not downgrade schema. Benchmark rich physical data at M1's required 10,000-node scale with bounded 1,000-node/2,000-edge visible projection and accurate omitted counts. Record database writes/rows for repeated unchanged SNMP/controller collections and compare with M1's stable digest baseline.

```ts
// Release gate invariant evaluated from the actual fixture report.
expect(report.manualParityMismatches).toBe(0);
expect(report.pinParityMismatches).toBe(0);
expect(report.deletionParityMismatches).toBe(0);
expect(report.undeliveredAtComparisonBarrier).toBe(0);
expect(report.unchangedCollectionRunInserts).toBe(0);
expect(report.readTriggeredCommands).toBe(0);
```

`report` is generated by the new vertical integration test from real SQL counts and M0 capture/drain receipts, with these six scalar fields explicitly written to its test result; it is not a fabricated benchmark result or stubbed expected-value helper. Reuse M0 parity logic to produce mismatch counts.
- [ ] **Step 4: Run the completed focused and regression gates.**

```bash
pnpm --filter @breeze/shared exec vitest run src/validators/topologyPhysical.test.ts
pnpm --filter @breeze/api exec vitest run src/services/topology src/routes/topology src/routes/agentWs.test.ts src/routes/agents/unifiTelemetry.test.ts src/services/unifi/unifiTelemetryService.test.ts
pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/topologyPhysicalIngest.integration.test.ts src/__tests__/integration/topologyUnifiScope.integration.test.ts src/__tests__/integration/topologyPhysicalPublication.integration.test.ts src/__tests__/integration/topologyExclusionsRls.integration.test.ts src/__tests__/integration/topologyPhysicalManual.integration.test.ts src/__tests__/integration/topologyPhysicalVertical.integration.test.ts
pnpm --filter @breeze/web exec vitest run src/components/topology src/lib/__tests__/no-silent-mutations.test.ts
pnpm --filter @breeze/e2e-tests exec playwright test tests/topology-physical.spec.ts
```

Run Go separately from repository root: `cd agent && go test -race ./internal/discovery/... ./internal/snmppoll/... ./internal/unifi/... ./internal/heartbeat/...`. Run Task 7 schema/lifecycle gates after the final migration changes, and the M1 no-management E2E suite to prove physical enrichment did not become a baseline prerequisite. Required project CI jobs remain `test-api`, `test-web`, `test-agent`; real DB release gates must execute rather than be skipped. Production enablement waits for Main §11's seven-day pilot and measured performance gates; unit tests cannot claim those have passed.
- [ ] **Step 5: Commit acceptance artifacts and measured results only.** Stage the test/page/fixture files and actual verification report; `git commit -m "test(topology): verify physical enrichment and compatibility"`.

## Completion and self-review checklist

- [ ] Tasks 1–5 implement Collection §§7–8 protocol/chunk/pagination/identity limits while reusing M1 §§4/9 digest/ordering state; legacy has no absence authority.
- [ ] Task 6 preserves multiple sources, ambiguous candidates, cycles, parallel links and LAG member identity; no health or cable facts are inferred from layout.
- [ ] Task 7 passes every Data/API §3 lifecycle registry and real-DB gate, including deferred same-scope FKs, export classification and merge/purge.
- [ ] Task 8 retains M0 capture-before-snapshot and ordered drain barriers, manual support and all pins; exclusions do not mutate evidence or alert policy.
- [ ] Tasks 9–10 verify passive reads, visual/keyboard/list parity, actual worker layout, bounded large-site projection and physical flag rollback without deleting data.
- [ ] No application code, migration execution, production query, feature enablement or commit is implied by writing this plan. Implementation results are reported only after the listed commands and release gates actually run.
