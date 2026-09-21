# Intelligent Network Topology M3 Operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the evidence-backed topology operational with scheduled diagnostics, trustworthy interface history, bounded routed traces, and cautious incident investigation.

**Architecture:** Build on the M0 scoped graph, M1 durable diagnostic planner/dispatcher and policy records, and M2 canonical physical interfaces/relationships. Normalize supported SNMP/UniFi measurements into partitioned interface samples, assess health deterministically, and reuse existing monitor/alert behavior without duplicating schedules. Traces and impact analysis add evidence without modifying discovered topology or suppressing alerts.

**Tech Stack:** TypeScript, Hono, Drizzle/PostgreSQL, BullMQ/Redis, React/Cytoscape, Go; Vitest, PostgreSQL integration tests, Go race tests, Playwright.

**Spec:** [Operations](../../specs/monitoring/2026-09-15-intelligent-network-topology-operations.md), [Data](../../specs/monitoring/2026-09-15-intelligent-network-topology-data-contracts.md), [Collection](../../specs/monitoring/2026-09-15-intelligent-network-topology-collection.md), [Main](../../specs/monitoring/2026-09-15-intelligent-network-topology-design.md), [Proposal](../../specs/monitoring/2026-09-15-intelligent-network-topology-proposal.md).

## Global Constraints

- Depends on completed M2, therefore M0 and M1. Follow the shared [execution index](2026-09-15-intelligent-network-topology-INDEX.md) for migration naming, release flags, test environment and cross-cutting lifecycle gates.
- Opening, refreshing, selecting, graph/history reads, and layout changes dispatch zero probes, extra polls, schedules, or model calls.
- Shared canonical types/validators stay in `packages/shared/src/types/topology.ts` and `packages/shared/src/validators/topology.ts`. SQL is snake_case; JSON is camelCase; counters/revisions are decimal strings; missing values are null with a reason.
- `TopologyScope={orgId:string,siteId:string}` and `GraphResponse` come from M0 shared types. API-only `TopologyRequestContext` and `requireTopologySiteAccess` come from `services/topology/access.ts`; no handler fabricates an authorized context from caller-supplied org/site fields.
- Health wire values remain `healthy|degraded|failed_check|unknown`; health coverage is `monitored|partial|unmonitored|unsupported|unavailable`, distinct from run coverage `complete|partial|none`. Structural freshness and measurement freshness remain separate.
- Interface identity uses UUID plus `epoch:string`, never ifIndex or a label alone. Source ordering uses `producerEpoch:string` plus decimal-string sequence. Agent/controller payload scope is not authority.
- New tenant tables and columns ship with forced RLS, same-scope FKs `DEFERRABLE INITIALLY IMMEDIATE`, schema export, tenant export classification, cascade order and org-merge disposition in the same PR. All JSON/JSONB/bytea is `excludedOpen` with a reason. Partition children also need forced RLS and direct-child access tests.
- New migrations sort after the newest **committed** migration using `YYYY-MM-DD-HHMMSS-<slug>.sql`; re-read after rebasing. Never edit shipped migrations. No inner transaction blocks; cleanup reports row counts.
- Default port polling 60 seconds, range 30–300, maximum 256 interfaces/collector batch. Raw retention 7 days; 5-minute summaries 30 days; hourly summaries 90 days. Partition before enabling polling.
- History: maximum 1,000 buckets/series, eight series/request, raw range at most 7 days. Unit, epoch, source, coverage and gaps accompany every series.
- Scheduled diagnostics: default 300 seconds, range 60–3,600, ±10% jitter, initially at most two explicitly chosen routing contexts. One origin/context/family; shared run quotas remain 2/agent, 4/site, 20/org. No catch-up bursts.
- Traceroute: default 16/max30 hops, default one/max2 probes/hop, one-second hop timeout, 60-second execution ceiling within the existing 120-second absolute run lifetime.
- All network I/O is outside DB transactions. Use the M1 durable command/outbox/journal path; no extra direct WebSocket transport. Go network tests use injected mocks and `-race`.
- Every web mutation uses `runAction`; navigation/selection state uses hashes. E2E selectors use only `data-testid`.
- No topology-based alert suppression, acknowledgement, closure, downgrade, remediation, AI, or automatic invented physical links in M3.

## File boundaries and prerequisite interfaces

M1 creates `services/topology/{collectionTypes,diagnosticTypes,diagnosticPlanner,diagnosticRuns,diagnosticDispatch,diagnosticResults,diagnosticHealth,originEligibility,settingsResolver,templateApply}.ts`, `jobs/topologyDiagnosticWorker.ts`, `jobs/topologyDiagnosticSweeper.ts`, and `db/schema/{topologyCollections,topologyTemplates,topologyOperations}.ts`. M3 modifies these only at explicit integration seams. M2 supplies normalized `topologyInterfaces` and canonical interface ownership/epochs.

Consumed M1 signatures:

```ts
planTopologyDiagnostic(ctx: TopologyRequestContext, request: CreateTopologyDiagnosticRequest): Promise<TopologyDiagnosticPlan>;
selectTopologyOrigins(ctx: TopologyRequestContext, request: CreateTopologyDiagnosticRequest): Promise<TopologyOriginEligibility[]>;
createTopologyDiagnosticRun(ctx: TopologyRequestContext, request: CreateTopologyDiagnosticRequest, idempotencyKey: string): Promise<TopologyDiagnosticRun>;
getTopologyDiagnosticRun(ctx: TopologyRequestContext, runId: string): Promise<TopologyDiagnosticRun | null>;
dispatchTopologyDiagnosticRun(scope: TopologyScope, runId: string): Promise<void>;
acceptTopologyDiagnosticResult(producer: AuthenticatedTopologyProducer, result: TopologyDiagnosticResult): Promise<{accepted:boolean; historicalOnly:boolean}>;
assessTopologyDiagnostic(plan: TopologyDiagnosticPlan, steps: TopologyDiagnosticStep[]): TopologyHealthSummary;
```

Reuse M1 Task 2's shared `topologySequenceSchema`, API `sequence.ts` comparison and uint64 database boundary vectors for source sequences; do not introduce a second numeric/string adapter. Import `AuthenticatedTopologyProducer` from `collectionTypes.ts`; import diagnostic types from the shared topology contract/M1 re-exports. M1 exposes `gateway_basic`, `dns_basic`, `internet_basic`, `target_connectivity`; M3 adds `trace_route`. M1 policies are persisted disabled with an inert activation intent; an explicit enabled=true request in M1 returns capability_unavailable. M3 requires a fresh activation preview, current authorization and successful re-arm before enabling recurrence; upgrade alone never executes a saved intent.

## Task 1: Define interface measurement transport and precise sample semantics

**Files:**
- Modify: `packages/shared/src/types/topology.ts`, `packages/shared/src/validators/topology.ts`, their existing barrel exports and adjacent tests.
- Create: `apps/api/src/services/topology/interfaceMetricTypes.ts`, `apps/api/src/services/topology/interfaceMetricTypes.test.ts`.
- Create: `agent/internal/snmppoll/interface_metrics.go`, `agent/internal/snmppoll/interface_metrics_test.go` (transport types/validation only in this task).
- Create: `packages/shared/src/validators/fixtures/topology-interface-metrics-v1.json` (shared successful and invalid envelopes).

**Interfaces:**
- Consumes M2 canonical interface UUID/epoch and M1 authenticated source scope.
- Produces shared `TopologyInterfaceSampleV1`, `TopologyInterfaceMetricEnvelopeV1`, `TopologyInterfaceHistoryQuery`, `TopologyInterfaceHistoryResponse`; API alias exports in `interfaceMetricTypes.ts`; Go equivalent payload structs with decimal-string uint64 values.
- Metric series names are `in_bps`, `out_bps`, `in_utilization_pct`, `out_utilization_pct`, `in_errors_per_second`, `out_errors_per_second`, `in_discards_per_second`, `out_discards_per_second`. Source gauges/PoE/status have separate typed fields; no overloaded counter fields.

- [ ] **Step 1: Write failing contract tests.** Include this precision/unknown regression in the shared validator suite, using the fixture for required scope/source fields:

```ts
it('keeps uint64 precision and rejects a fabricated zero for missing counters', () => {
  const sample = { ...fixture.valid.samples[0], inOctets: '18446744073709551615', outOctets: null };
  expect(topologyInterfaceSampleV1Schema.parse(sample).inOctets).toBe('18446744073709551615');
  expect(topologyInterfaceSampleV1Schema.safeParse({ ...sample, inOctets: 18446744073709551615 }).success).toBe(false);
  expect(topologyInterfaceSampleV1Schema.safeParse({ ...sample, counterWidth: 32 }).success).toBe(false);
});
```

Also reject unknown versions, more than 256 samples, negative/overflow counters, nonfinite rates, sampled dates outside accepted envelope bounds, invalid epochs and unknown fields. Parse an absent supported field as null plus an availability reason, not 0. Test the same JSON fixtures from Go.

- [ ] **Step 2: Run to fail.** `pnpm --filter @breeze/shared test --run src/validators/topology.test.ts` and `cd agent && go test -race ./internal/snmppoll -run TestInterfaceMetricContract -count=1`. Expected: missing metric validator/Go contract before implementation.
- [ ] **Step 3: Implement bounded types/validators.** The normalized counter portion is:

```ts
export type TopologyInterfaceSampleV1 = {
  interfaceId: string; interfaceEpoch: string; sampledAt: string;
  sourceId: string; producerEpoch: string; sequence: string;
  counterWidth: 32 | 64 | null;
  inOctets: string | null; outOctets: string | null;
  inErrors: string | null; outErrors: string | null;
  inDiscards: string | null; outDiscards: string | null;
  inPackets: string | null; outPackets: string | null;
  capacityBps: string | null; discontinuityTicks: string | null;
  deviceUptimeTicks: string | null;
  reportedInBps: number | null; reportedOutBps: number | null;
  adminStatus: 'up' | 'down' | 'testing' | 'unknown';
  operStatus: 'up' | 'down' | 'testing' | 'unknown' | 'dormant' | 'not_present' | 'lower_layer_down';
  expectedIntervalSeconds: number;
  unavailableReasons: string[];
};
const uint64Decimal = z.string().regex(/^(0|[1-9][0-9]{0,19})$/)
  .refine(value => BigInt(value) <= 18446744073709551615n);
```

Envelope includes schemaVersion 1, source/epoch/sequence, command/config revision, bounded samples and collection outcome; derive org/site from authenticated stored authority. A single sample contains all interface readings at one time; source-reported rates and cumulative counters stay distinct. Units are fixed by field names. Preserve source collection errors separately from target/port health.
- [ ] **Step 4: Run to pass.** Repeat Step 2, plus `pnpm --filter @breeze/shared typecheck` and `pnpm --filter @breeze/api test:run src/services/topology/interfaceMetricTypes.test.ts`; expected contract tests pass including both absent fields and true measured zeros.
- [ ] **Step 5: Commit.** `git add packages/shared/src/types/topology.ts packages/shared/src/validators/topology.ts packages/shared/src/validators/topology.test.ts packages/shared/src/validators/fixtures/topology-interface-metrics-v1.json apps/api/src/services/topology/interfaceMetricTypes.ts apps/api/src/services/topology/interfaceMetricTypes.test.ts agent/internal/snmppoll/interface_metrics.go agent/internal/snmppoll/interface_metrics_test.go` then `git commit -m "feat(topology): define precise interface measurement contract"`; stage any changed existing barrels explicitly.

## Task 2: Persist partitioned samples with complete tenant lifecycle coverage

**Files:**
- Create: `apps/api/src/db/schema/topologyTelemetry.ts`, `apps/api/src/services/topology/interfaceSamples.ts`, `apps/api/src/services/topology/interfaceSamples.test.ts`.
- Create: the next committed-max-following `apps/api/migrations/YYYY-MM-DD-HHMMSS-topology-interface-samples.sql` (choose the literal filename using the index procedure before editing).
- Modify: `apps/api/src/db/schema/index.ts`, `apps/api/src/services/tenantCascade.ts`, `apps/api/src/services/tenantExportPolicyRegistry.ts`, `apps/api/src/services/orgMergeRegistry.ts`.
- Create: `apps/api/src/__tests__/integration/topologyInterfaceSamples.integration.test.ts`, `apps/api/src/db/migration-topology-interface-samples.test.ts`.
- Modify: `apps/api/src/routes/devices/cascadeDelete.test.ts`, `apps/api/src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts`, `apps/api/src/__tests__/integration/orgMergeRegistry.integration.test.ts` for the new table disposition/behavior.

**Interfaces:**
- Consumes `TopologyInterfaceMetricEnvelopeV1`, `AuthenticatedTopologyProducer` and canonical `topologyInterfaces`.
- Produces `persistTopologyInterfaceSamples(producer, envelope):Promise<{inserted:number;duplicates:number;historicalOnly:number}>`; authorizes before inserting, increments only health revision when current measurement changes, never graph revision.
- SQL export `topologyInterfaceSamples` represents `topology_interface_samples`, partitioned LIST by resolution and RANGE by UTC sample time. No extra unregistered shadow table.

- [ ] **Step 1: Write failing real DB tests.** Use two organizations, two sites in one org, interfaces of both sites and the existing unprivileged DB harness. In addition to duplicate/late-source tests, execute a direct forged insert:

```ts
await expect(inOrgA(() => db.execute(sql`
  INSERT INTO topology_interface_samples
    (org_id,site_id,interface_id,interface_epoch,source_id,producer_epoch,source_sequence,sampled_at,resolution)
  VALUES (${orgA},${siteA},${interfaceFromSiteB},'1',${sourceA},'epoch-a','1',${now},'raw')
`))).rejects.toMatchObject({ code: '23503' });
```

`inOrgA`, fixtures and `db` are declared in this new test using the integration suite's real `withDbAccessContext`/`breeze_app` harness, not mocked auth. Round-trip source_sequence=18446744073709551615 through NUMERIC(20,0)/Drizzle string mapping and JSON unchanged; reject 18446744073709551616 and any JS-number transport coercion. Prove cross-org SELECT/INSERT/UPDATE/DELETE denial on parent **and child partitions**, same-org cross-site API denial later, deferred whole-org merge, device move preserving old samples and source fencing, child-before-parent purge/export erasure, and idempotent migration reapplication.
- [ ] **Step 2: Run to fail.** `pnpm --filter @breeze/api test:integration src/__tests__/integration/topologyInterfaceSamples.integration.test.ts`; expected missing table. The catalog runner is separately `pnpm --filter @breeze/api test:rls-coverage`.
- [ ] **Step 3: Implement schema and persistence.** Include these constraints in the idempotent handwritten migration:

```sql
CREATE TABLE IF NOT EXISTS topology_interface_samples (
  org_id uuid NOT NULL, site_id uuid NOT NULL, interface_id uuid NOT NULL,
  interface_epoch text NOT NULL, source_id uuid NOT NULL, producer_epoch text NOT NULL,
  source_sequence numeric(20,0) NOT NULL CHECK (source_sequence BETWEEN 0 AND 18446744073709551615), sampled_at timestamptz NOT NULL,
  resolution text NOT NULL CHECK (resolution IN ('raw','5m','1h')),
  readings jsonb NOT NULL DEFAULT '{}'::jsonb,
  valid_duration_ms bigint NOT NULL DEFAULT 0,
  sample_count integer NOT NULL DEFAULT 0, gap_duration_ms bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (resolution,sampled_at,org_id,site_id,interface_id,interface_epoch,source_id,producer_epoch),
  FOREIGN KEY (interface_id,org_id,site_id)
    REFERENCES topology_interfaces(id,org_id,site_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  FOREIGN KEY (source_id,org_id,site_id)
    REFERENCES topology_collection_sources(id,org_id,site_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE
) PARTITION BY LIST (resolution);
ALTER TABLE topology_interface_samples ENABLE ROW LEVEL SECURITY;
ALTER TABLE topology_interface_samples FORCE ROW LEVEL SECURITY;
```

Add the four idempotently-created org policies, indexed `(org_id,site_id,interface_id,resolution,sampled_at DESC)` lookup, nonnegative count/duration checks, bounded validated readings and source/epoch validation before insert. Add source-sequence conflict detection: equal identity/time/sequence is a no-op; equal identity/time with different content is rejected, not an overwrite. Retain immutable raw readings; aggregate rows are replaced only by deterministic bucket recomputation under lock.

Create raw/5m/1h partitioned children and bounded daily leaves, each with enabled/forced policies and grants. Verify attachment through `pg_inherits` before trusting an existing same-name child. Restricted SECURITY DEFINER partition functions take only resolution/date, derive identifiers, fix search_path, reject out-of-window dates and PUBLIC execution; grant only the maintenance entry points used by `breeze_app`. This follows `metricRollupMaintenance.ts` privilege precedent; unprivileged runtime cannot issue arbitrary DDL. Set explicit `ON DELETE` behavior and retain graph-owned history during individual inventory moves.

Register the parent once for cascade/merge/export; register statically named partition parents if catalog discovery includes them. Runtime leaves inherit the reviewed parent policy through the repository's partition handling, with behavioral tests against direct leaves. Classify `readings` as `excludedOpen`; classify every scalar and reviewed digest, including new columns. Add no unrestricted table allowlist entry to hide a failure.
- [ ] **Step 4: Run to pass.** Repeat Step 2; run `pnpm --filter @breeze/api test:run src/db/migration-topology-interface-samples.test.ts src/db/autoMigrate.test.ts`, `bash scripts/check-migration-naming.sh`, `pnpm db:check-drift`, then the index's full schema lifecycle suite. Expected: actual cross-tenant denial, correct final-state deferred FKs, no orphan partitions/history and no schema drift.
- [ ] **Step 5: Commit.** Explicitly stage the Task 2 files and the resolved new migration filename; `git commit -m "feat(topology): store partitioned interface measurements with tenant lifecycle coverage"`.

## Task 3: Collect supported SNMP counters and port state without expanding authority

**Files:**
- Modify: `agent/internal/snmppoll/interface_metrics.go`, `agent/internal/snmppoll/interface_metrics_test.go`, `agent/internal/snmppoll/templates.go`, `agent/internal/heartbeat/handlers_network.go`.
- Create: `agent/internal/snmppoll/interface_metrics_fixtures_test.go`, `agent/internal/snmppoll/testdata/interface_metrics_v1.json`.
- Modify: `apps/api/src/jobs/snmpWorker.ts`, `apps/api/src/services/commandResultHandlers.ts`, `apps/api/src/routes/agentWs.ts` at their existing authenticated SNMP-result adapters only.
- Create: `apps/api/src/services/topology/snmpInterfaceMetrics.ts`, `apps/api/src/services/topology/snmpInterfaceMetrics.test.ts`.

**Interfaces:**
- Consumes explicit enabled interface IDs/epochs, source configuration revision and existing authorized SNMP target/credential retrieval. Server-generated poll configuration binds each authorized agent-local ifIndex/controller port key and identity epoch to one canonical interface UUID. The agent echoes only that allowlisted mapping; it cannot choose an arbitrary UUID. The result adapter matches each returned UUID/epoch/source/local port against the stored authorized command mapping before ingestion.
- Produces Go `CollectInterfaceMetrics(ctx context.Context, reader InterfaceMetricReader, request InterfaceMetricRequest) (InterfaceMetricSnapshot,error)`; `InterfaceMetricReader.Get(ctx,oids)` and `Walk(ctx,root,maxRows)` are injected interfaces implemented by the existing SNMP client. Request contains only approved port keys, interval and deadline, never new target/credentials from graph reads.
- API `normalizeSnmpInterfaceMetrics(producer, command, result):TopologyInterfaceMetricEnvelopeV1` validates command ownership, target/config revision, port identity and capability before Task 2 persistence.

- [ ] **Step 1: Write failing table-driven Go tests.** Fixtures cover 64-bit maximum, unsupported HC fallback, auth/timeout vs absent OID, ifIndex reuse, missing speed, admin-down, partial port batch and cancellation. Example:

```go
func TestInterfaceMetricsPreferHC(t *testing.T) {
  reader := &fakeInterfaceMetricReader{values: map[string]any{
    "1.3.6.1.2.1.31.1.1.1.6.7": uint64(18446744073709551615),
    "1.3.6.1.2.1.31.1.1.1.10.7": uint64(0),
  }}
  got, err := CollectInterfaceMetrics(context.Background(), reader, metricRequestForPort7())
  if err != nil { t.Fatal(err) }
  if got.Samples[0].InOctets == nil || *got.Samples[0].InOctets != "18446744073709551615" { t.Fatalf("precision lost: %#v", got) }
}
```

Define the two local test helpers in this test file: fake reader implements the interface and never opens a socket; `metricRequestForPort7` returns one fixed approved interface with ifIndex 7, explicit epoch, one-minute cadence and bounded context deadline. Add API tests rejecting another source/port/config result.
- [ ] **Step 2: Run to fail.** `cd agent && go test -race ./internal/snmppoll ./internal/heartbeat -run 'TestInterfaceMetrics|TestSNMPInterfaceMetrics' -count=1`; `pnpm --filter @breeze/api test:run src/services/topology/snmpInterfaceMetrics.test.ts`.
- [ ] **Step 3: Implement the allowlisted reads and adapter.** Use IF-MIB HC in/out octets `.31.1.1.1.6`/`.10`, ifHighSpeed `.31.1.1.1.15` in megabits/sec, ifCounterDiscontinuityTime `.31.1.1.1.19`, sysUpTime `.1.3.0`, ifSpeed `.2.2.1.5`, admin/oper `.2.2.1.7`/`.8`, 32-bit octets `.10`/`.16`, errors `.14`/`.20`, discards `.13`/`.19` under `1.3.6.1.2.1`; packet denominator columns only when complete/compatible. Do not classify timeouts as unsupported.

```go
func decimalCounter(value uint64) string { return strconv.FormatUint(value, 10) }
// Convert ifHighSpeed Mbps to bits/sec in uint64 before JSON serialization.
func highSpeedBps(value uint32) string { return strconv.FormatUint(uint64(value)*1000000, 10) }
```

Cap each batch at 256 authorized ports, use existing credentials once/session and existing SNMP timeout/retry bounds. Persist progress cursor for the next authorized bounded batch; absent rows remain unavailable. Fetch interface identity and reboot/discontinuity evidence with the counters; do not match old epoch samples just because names match. Version-gate new payload; legacy SNMP results continue through existing metric path and do not masquerade as normalized port samples. Authenticate both durable and orphan-result adapters through the same validation service.
- [ ] **Step 4: Run to pass.** Repeat Step 2 and `pnpm --filter @breeze/api test:run src/jobs/snmpWorker.orgAuthority.test.ts src/jobs/snmpWorker.dbcontext.test.ts src/services/commandResultHandlers.cancellation.test.ts`. Expected no actual network operations in tests, no regressions to target authorization or DB transaction lifetime.
- [ ] **Step 5: Commit.** Stage Task 3's named Go/API files; `git commit -m "feat(topology): collect authorized SNMP interface state and counters"`.

## Task 4: Add fixture-verified UniFi detail/statistics measurements

**Files:**
- Modify: `agent/internal/unifi/client.go`, `agent/internal/unifi/collector.go`, `agent/internal/unifi/client_test.go`, `agent/internal/unifi/collector_test.go`.
- Create: `agent/internal/unifi/metrics.go`, `agent/internal/unifi/metrics_test.go`, `agent/internal/unifi/testdata/device_detail_metrics.json`, `agent/internal/unifi/testdata/device_statistics_metrics.json`.
- Modify: `apps/api/src/routes/agents/unifiTelemetry.ts`, `apps/api/src/services/unifi/unifiTelemetryService.ts`, `apps/api/src/jobs/unifiTelemetryWorker.ts`.
- Create: `apps/api/src/services/topology/unifiInterfaceMetrics.ts`, `apps/api/src/services/topology/unifiInterfaceMetrics.test.ts`.

**Interfaces:**
- Consumes M2 controller+controller-site source identity, exact site mapping, typed controller port identity and collection manifests.
- Produces Go `PollDeviceMetrics(ctx,deviceID) DeviceMetricsResult` with independent detail/statistics outcomes; API `normalizeUnifiInterfaceMetrics(producer,payload):TopologyInterfaceMetricEnvelopeV1[]` for supported stable interface mappings only.
- A source-reported `txRateBps` or `rxRateBps` maps to `reportedOutBps`/`reportedInBps` only after fixture-confirmed units and direction. It never maps to `txBytes`/`rxBytes` or an octet counter.

- [ ] **Step 1: Write failing fixtures and tests.** Capture sanitized documented supported-controller response shapes as committed fixtures, including supported version/capability metadata. Unit-test rate versus byte separation:

```ts
it('does not manufacture cumulative counters from a controller rate', () => {
  const result = normalizeUnifiInterfaceMetrics(producer, controllerMetricFixture);
  const sample = result[0].samples[0];
  expect(sample.reportedOutBps).toBe(8000);
  expect(sample.outOctets).toBeNull();
});
```

Define `producer` and `controllerMetricFixture` from the same-site authenticated fixture, with literal upstream reported rate 8000 **in fixture-confirmed bps**. Also test 404 detail endpoint, stats timeout after successful identity list, controller-site mismatch, missing port, unsupported firmware, malformed units and partial responses; outcomes cannot withdraw inventory or claim zero load.
- [ ] **Step 2: Run to fail.** `cd agent && go test -race ./internal/unifi -run 'TestDeviceMetrics|TestCollectorMetric' -count=1`; `pnpm --filter @breeze/api test:run src/services/topology/unifiInterfaceMetrics.test.ts`.
- [ ] **Step 3: Implement explicit adapters.** Extend the existing local Network Integration API client with bounded `/sites/{siteId}/devices/{deviceId}` and `/sites/{siteId}/devices/{deviceId}/statistics/latest` GETs. Use the existing authenticated transport, bounded pagination/request context and collector schedule. Request only opted-in interfaces/devices; no fetch from read API or map rendering. Publish separate manifests for list/detail/statistics. Treat 404 as endpoint unsupported, timeout as failure and omitted values as null.

```go
type ControllerRate struct {
  Value float64 `json:"value"`
  Unit string `json:"unit"`
}
func normalizeRate(v ControllerRate) (float64, error) {
  if math.IsNaN(v.Value) || math.IsInf(v.Value, 0) || v.Value < 0 { return 0, errors.New("invalid_rate") }
  switch v.Unit { case "bps": return v.Value, nil; case "bytes_per_second": return v.Value * 8, nil }
  return 0, errors.New("unsupported_rate_unit")
}
```

The adapter supplies `Unit` from its verified version-specific field contract, never guessed from an ambiguous display label. Emit PoE/status only where the detail fixture proves those values; VLAN/signal/wireless overlays remain unavailable unless a separately tested supported source exists. Controller whole-device uplink rate is not attached to an arbitrary port: require the source's explicit port mapping or leave interface telemetry unavailable with `port_not_identified`.
- [ ] **Step 4: Run to pass.** Repeat Step 2 plus `pnpm --filter @breeze/api test:run src/routes/agents/unifiTelemetry.test.ts src/services/unifi/unifiTelemetryService.test.ts`; run `cd agent && go test -race ./internal/unifi/... -count=1`. Expected old list-only agents still work and advertise missing metrics honestly.
- [ ] **Step 5: Commit.** Stage Task 4 files; `git commit -m "feat(topology): ingest supported UniFi port telemetry with explicit units"`.

## Task 5: Calculate rates, rollups, retention and interface continuity correctly

**Files:**
- Create: `apps/api/src/services/topology/interfaceRates.ts`, `apps/api/src/services/topology/interfaceRates.test.ts`, `apps/api/src/services/topology/interfaceRollups.ts`, `apps/api/src/services/topology/interfaceRollups.test.ts`, `apps/api/src/services/topology/interfaceRetention.ts`, `apps/api/src/services/topology/interfaceRetention.test.ts`.
- Create: `apps/api/src/jobs/topologyTelemetryMaintenance.ts`, `apps/api/src/jobs/topologyTelemetryMaintenance.test.ts`.
- Modify: `apps/api/src/services/workerRegistry.ts`, `apps/api/src/jobs/scheduleRegistry.ts`, `apps/api/src/services/topology/interfaceSamples.ts`.
- Create: `apps/api/src/__tests__/integration/topologyTelemetryRetention.integration.test.ts`.

**Interfaces:**
- `calculateInterfaceWindow(previous:TopologyInterfaceSampleV1|null,current:TopologyInterfaceSampleV1):InterfaceWindow` is pure; `InterfaceWindow` contains elapsed/valid duration, nullable directional rates/utilization, invalid reasons and anomalies, never overwrites raw input.
- `rollupTopologyInterfaceBuckets(scope:TopologyScope,through:Date):Promise<{fiveMinute:number;hourly:number}>` recomputes closed buckets idempotently; `maintainTopologyInterfacePartitions(now:Date):Promise<{created:number;dropped:number;deleted:number;incomplete:boolean}>` uses the Task 2 restricted DDL functions and bounded cleanup.
- No graph/AI code owns retention. Maintenance worker has short DB operations and no external I/O in transactions.

- [ ] **Step 1: Write failing arithmetic/continuity tests.** Construct a sample factory in the same file with fixed IDs/epochs, 60-second cadence, 64-bit width, uptime increasing and speed 1,000,000 bps. Required precision regression:

```ts
it('subtracts big integers before converting the delta', () => {
  const a = sample({ sampledAt: '2026-09-15T00:00:00Z', inOctets: '9007199254740993' });
  const b = sample({ sampledAt: '2026-09-15T00:01:00Z', inOctets: '9007199254748493' });
  expect(calculateInterfaceWindow(a,b).inBps).toBe(1000);
});
```

Table cases: first sample, duplicate/out-of-order time, epoch/source/origin change, uptime rollback, discontinuity change, 64-bit decrease, unique feasible 32-bit wrap, unknown capacity/multiple possible wraps, gaps >3 cadence, changed speed (rate valid/utilization null), implausible capacity, independent duplex, incomplete LAG membership, and asynchronous endpoint counter differences. Retention test seeds 8/31/91-day rows and live rows in distinct tenants; rerun maintenance proves stable buckets, precise cutoffs and no lost current support/history pointers.
- [ ] **Step 2: Run to fail.** `pnpm --filter @breeze/api test:run src/services/topology/interfaceRates.test.ts src/services/topology/interfaceRollups.test.ts src/services/topology/interfaceRetention.test.ts`; `pnpm --filter @breeze/api test:integration src/__tests__/integration/topologyTelemetryRetention.integration.test.ts`.
- [ ] **Step 3: Implement window math then rollups/retention.** The wrapped delta must have exactly one possible value under speed/time bound:

```ts
const modulus = 1n << BigInt(current.counterWidth!);
const delta = curr >= prev ? curr - prev : modulus - prev + curr;
const maxDelta = capacityBps * elapsedMs / 8000n;
const unique32BitWindow = delta <= maxDelta && delta + modulus > maxDelta;
const bps = Number(delta * 8000n) / Number(elapsedMs);
```

Perform identity/source/discontinuity/uptime/time/gap checks first. Decreasing 64-bit counters always invalidate. For 32-bit windows with unknown capacity or possible multiple wraps, return null `ambiguous_wrap`; do not apply the modular result blindly even when the observed counter increased. Capacity changes invalidate utilization only. Preserve valid zero deltas as zero, distinguish missing evidence null, and flag implausible values without clamping to 100%. Derive errors/discards from compatible windows; no percentages without matching packet denominators.

For rollups aggregate min/max, duration-weighted mean, valid duration/sample count and gap duration separately per source/interface epoch/direction. Split windows at bucket boundaries by duration; do not bridge gaps or source switches. LAG computation uses a reliable parent OR complete synchronized active-member sum; never both. Observed state changes are counts with cadence/coverage, not an assertion of every flap.

Create daily partitions ahead before ingress; avoid an unbounded default partition. Use a finite retained late-sample window; out-of-retention samples become rejection/historical metadata, not arbitrary old partition creation. Roll raw→5m before raw deletion; 5m→1h before 5m deletion. Closed buckets recalculate idempotently with a bounded late-arrival watermark; retention refuses to discard an unrolled window and emits backlog. Drop fully expired daily leaves, bounded-delete boundary-day rows, report counts including zero. Read/expire detailed diagnostic and collection rows through M1 retention, preserve compact current support and `detailsExpired` links. Register maintenance enable/shutdown and observability with existing worker/schedule registries.
- [ ] **Step 4: Run to pass.** Repeat Step 2 and `pnpm --filter @breeze/api test:run src/jobs/topologyTelemetryMaintenance.test.ts`; validate parent and direct-child RLS after runtime partition creation. Expected raw7d/5m30d/hourly90d bounds and deterministic reruns.
- [ ] **Step 5: Commit.** Stage Task 5 files; `git commit -m "feat(topology): derive counter-safe rates and retain bounded port history"`.

## Task 6: Serve scoped bounded history and current health without probing

**Files:**
- Create: `apps/api/src/services/topology/interfaceHistory.ts`, `apps/api/src/services/topology/interfaceHistory.test.ts`, `apps/api/src/routes/topology/history.ts`, `apps/api/src/routes/topology/history.test.ts`.
- Modify: `apps/api/src/routes/topology/index.ts`, M1 `apps/api/src/services/topology/diagnosticHealth.ts` and its adjacent tests; M0 `apps/api/src/services/topology/graph.ts` at health projection only.
- Create: `apps/api/src/__tests__/integration/topologyInterfaceHistoryScope.integration.test.ts`.

**Interfaces:**
- `getTopologyInterfaceHistory(ctx:TopologyRequestContext,interfaceId:string,query:TopologyInterfaceHistoryQuery):Promise<TopologyInterfaceHistoryResponse>`.
- `getTopologyLinkHealth(ctx:TopologyRequestContext,relationshipId:string):Promise<TopologyLinkHealth>` reuses M1 monitor/run summaries and joins only permitted Task 2 interfaces, with endpoint side, units and epoch. Extend the existing M1 health projection; do not add a second health truth store or a competing evaluator. Return canonical `health.status` and `health.coverage`, preserving M0 `GraphResponse` and `Position.source`/`rowRevision` unchanged.
- Existing canonical endpoints `GET /topology/sites/:siteId/interfaces/:interfaceId/history` and `GET .../health`; do not revive deprecated `/snmp/metrics` routes.

- [ ] **Step 1: Write failing query/route tests.** Declare command-queue/SNMP/UniFi poll mocks as spies and assert zero calls for all reads:

```ts
it('rejects a ninth series before querying and never polls', async () => {
  const response = await app.request(`/topology/sites/${siteA}/interfaces/${interfaceA}/history?series=${Array(9).fill('in_bps').join(',')}&start=2026-09-01T00:00:00Z&end=2026-09-02T00:00:00Z`);
  expect(response.status).toBe(400);
  expect(pollSpy).not.toHaveBeenCalled();
  expect(dispatchSpy).not.toHaveBeenCalled();
});
```

Also test duplicate series rejected, raw >7 days, >90-day request rejected, invalid start/end, 1,000-bucket cap, same-org wrong-site 404, wrong-org 404, missing permission403, filtered counts, expiration/epoch boundary, one-sided data, unmonitored/stale and stopped policy. Real DB tests forge an otherwise valid interface in another site.
- [ ] **Step 2: Run to fail.** `pnpm --filter @breeze/api test:run src/services/topology/interfaceHistory.test.ts src/routes/topology/history.test.ts`; `pnpm --filter @breeze/api test:integration src/__tests__/integration/topologyInterfaceHistoryScope.integration.test.ts`.
- [ ] **Step 3: Implement validated server-selected bucketing and health joins.** Explicit raw requests over seven days fail; `auto` chooses the finest retained resolution satisfying range and bucket cap. Do not invent raw values from rollups.

```ts
const bucketSeconds = Math.max(baseResolutionSeconds, Math.ceil((endMs-startMs)/1000/1000/baseResolutionSeconds)*baseResolutionSeconds);
return { interfaceId, interval: {start,end,bucketSeconds}, resolution,
  series, epochs, coverage, gaps, asOf: now.toISOString() };
```

Define response fields in the shared contract with `series:[{name,unit,sourceId,interfaceEpoch,points:[{at,value,min,max,validDurationMs,sampleCount,gapDurationMs,reasons}]}]`; `epochs` is a bounded list of represented identity/source epochs. Read only scoped rows after verifying the interface and graph binding under existing metric/device read permissions. Explicit field projection prevents raw credentials/configuration from escaping. Sparse buckets retain null/gap semantics. Set private/no-store for evidence/history and permission-scoped ETags only for health. Increment health revision on freshness expiry as well as new results, independently of graph/layout revisions. Return server `freshUntil` and expected cadence; future agent timestamps cannot extend health.

Health derives from actual required check dimensions: max(3×scheduled cadence,60s), five minutes for isolated on-demand. Disabled policy becomes unmonitored immediately. Fresh port `operStatus=down` remains explicit port evidence; unknown admin status does not imply unexpected fault. Never color an inferred membership edge as a failed cable. One endpoint's rate is one view, not summed with its neighbor.
- [ ] **Step 4: Run to pass.** Repeat Step 2 plus existing M1 diagnostic-health and M0 graph-read tests. Expected all reads remain side-effect free and a permitted graph without metric read permission returns no hidden metric counts.
- [ ] **Step 5: Commit.** Stage Task 6 files; `git commit -m "feat(topology): expose scoped port history and honest measurement freshness"`.

## Task 7: Arm and schedule site policies with fair bounded recurrence

**Files:**
- Create: `apps/api/src/services/topology/monitoringAuthority.ts`, `apps/api/src/services/topology/monitoringAuthority.test.ts`, `apps/api/src/services/topology/monitoringScheduler.ts`, `apps/api/src/services/topology/monitoringScheduler.test.ts`, `apps/api/src/services/topology/monitorReuse.ts`, `apps/api/src/services/topology/monitorReuse.test.ts`.
- Create: `apps/api/src/jobs/topologyMonitoringWorker.ts`, `apps/api/src/jobs/topologyMonitoringWorker.test.ts`.
- Create: `apps/api/src/services/topology/telemetryConfiguration.ts`, `apps/api/src/services/topology/telemetryConfiguration.test.ts`, `apps/api/src/services/topology/telemetryDispatch.ts`, `apps/api/src/services/topology/telemetryDispatch.test.ts`, `apps/api/src/routes/topology/telemetrySettings.ts`, `apps/api/src/routes/topology/telemetrySettings.test.ts`, `apps/api/src/__tests__/integration/topologyTelemetryActivation.integration.test.ts`.
- Modify: shared `packages/shared/src/validators/topologyConfiguration.ts` and its tests, M1 `apps/api/src/services/topology/siteConfiguration.ts`, `apps/api/src/jobs/snmpWorker.ts`, `apps/api/src/services/unifi/unifiCollectorService.ts`, `apps/api/src/routes/agents/unifiTelemetry.ts`, `agent/internal/unifi/collector.go` and M1 topology route hub at the explicit telemetry activation/configuration seams.
- Modify: M1 `apps/api/src/services/topology/{diagnosticRuns,diagnosticDispatch,settingsResolver,templateApply}.ts`, `apps/api/src/db/schema/topologyOperations.ts`, `apps/api/src/routes/topology/settings.ts`, `apps/api/src/services/workerRegistry.ts`, `apps/api/src/jobs/scheduleRegistry.ts`.
- Create: `apps/api/src/services/topology/monitoringState.ts`, `apps/api/src/services/topology/monitoringState.test.ts`, `apps/api/src/__tests__/integration/topologyMonitoringAuthority.integration.test.ts` and the next forward `...-topology-monitoring-occurrence-state.sql` migration. This fixed Task7 migration owns all recurrence storage: the run occurrence columns and policy `alert_state`/`alert_state_revision` defined below; Task8 creates no schema. Modify `apps/api/src/services/tenantExportPolicyRegistry.ts` to classify every added scalar and mark `alert_state` JSONB `excludedOpen` with reason "bounded runtime origin/alert continuity state" in this same task.

**Interfaces:**
- `armTopologyMonitoringPolicy(ctx:TopologyRequestContext,policyId:string,expectedRevision:string):Promise<{enabled:boolean;blockedReason:string|null}>` uses existing authority-user permissions/MFA epoch lookup patterns in `networkBaselineAuthority.ts`; it does not reuse the subnet-only fingerprint unchanged.
- `resolveTopologyPolicyAuthority(scope:TopologyScope,policyId:string):Promise<{allowed:true;ctx:TopologyRequestContext;authorityDigest:string}|{allowed:false;reason:string}>` reloads the live owning principal and verifies the recorded effect/permissions/MFA generation. `ctx` is validated by the same access service, not cast from arbitrary JSON.
- Extend `createTopologyDiagnosticRun` with an optional fourth parameter `TopologyScheduledOccurrence={policyId:string;policyRevision:string;contextKey:string;family:'ipv4'|'ipv6';scheduledFor:string;authorityDigest:string}`. Existing three-argument callers remain unchanged. Store normalized occurrence fields on run rows; unique scoped policy/context/family/scheduledFor prevents duplicate occurrence across replicas.
- `dispatchDueTopologyPolicies(now:Date):Promise<{accepted:number;skipped:number}>`; `findEquivalentTopologyMonitor(ctx,plan):Promise<{monitorId:string}|null>` compares exact site/destination/protocol/context/origin-selection policy.
- `previewTopologyTelemetryConfiguration(ctx:TopologyRequestContext,input:TopologyTelemetrySelection):Promise<TopologyTelemetryPreview>` returns a ten-minute actor/scope/settings-revision/effect-bound preview token with supported-source mappings and volume/quota results. `armTopologyTelemetryConfiguration(ctx,input,expectedSettingsRevision,previewToken):Promise<ResolvedTopologySettings>` writes the site settings override only after fresh execute/configure/MFA and recurring authority checks. `buildTopologyTelemetryBatches(scope:TopologyScope,sourceId:string,now:Date):Promise<TopologyTelemetryBatch[]>` produces server-owned approved local-port→canonical mappings for the existing SNMP/UniFi scheduling/config paths.
- `monitoringState.ts` exports strict `topologyPolicyAlertStateSchema`, `TopologyPolicyAlertState`, `TopologyAlertStreak` and `TopologyMonitoringEvent`; these are API-internal runtime state, not a second health authority. `commitTopologyOccurrence(scope,policyId,expectedStateRevision,occurrence):Promise<{committed:boolean}>` atomically claims one context/family slot and writes either its run+dispatch intent or a collection-gap outbox event.

- [ ] **Step 1: Write failing authority/scheduler tests.** Fake time/queue and two sites with different eligible origins. Pin 300-second interval, default ±10% jitter, two contexts and one family. Assert deterministic one occurrence:

```ts
it('does not replay missed intervals after downtime', async () => {
  await seedPolicy({ nextScheduledAt: '2026-09-15T00:00:00Z', intervalSeconds: 300 });
  await dispatchDueTopologyPolicies(new Date('2026-09-15T03:00:00Z'));
  expect(createRunSpy).toHaveBeenCalledTimes(1);
  expect(queuedOccurrences).toHaveLength(1);
});
```

Define `seedPolicy`, `createRunSpy` and captured occurrences in this test's database/queue fixture. Add a real DB concurrent claim test with two contexts and both families: four unique occurrence rows/state entries survive, two replicas claiming the same slot create exactly one run OR one gap, never both; different context keys do not overwrite each other. Assert a fifth unconfigured key, duplicate context/family pair, malformed runtime JSON, >256 entries and >256KiB are rejected. Test that assessment-only `alert_state_revision` changes do not invalidate policy authority/config revision. Add revoked owner/site permission/MFA epoch, target/version/context/interval drift, disabled target, moved/ephemeral/offline/roaming origin, stale route binding, same occurrence race, wrong-site fallback, Redis unavailable, quota skip, fair alternating sites, reuse exact match and near-match refusal. M1 template apply to 200 sites must leave each unsuccessful re-arm disabled with per-site reason; publication alone never arms anything.
- [ ] **Step 2: Run to fail.** `pnpm --filter @breeze/api test:run src/services/topology/monitoringAuthority.test.ts src/services/topology/monitoringScheduler.test.ts src/services/topology/monitorReuse.test.ts src/jobs/topologyMonitoringWorker.test.ts`; `pnpm --filter @breeze/api test:integration src/__tests__/integration/topologyMonitoringAuthority.integration.test.ts`.
- [ ] **Step 3: Implement re-arm, occurrence CAS and fair dispatch.** Fingerprint the normalized executable effect, excluding moving scheduler timestamps:

```ts
const effect = { scope, policyId, policyRevision, recipeId, recipeVersion,
  subjects, contexts, families, originPolicy, targetVersions, templateVersions,
  intervalSeconds, jitterPercent:10, limits, alertSettings };
const authorityDigest = createHash('sha256').update(canonicalizeArguments(effect)).digest('hex');
```

The fixed Task7 migration adds nullable `policy_id uuid`, `policy_revision bigint`, `scheduled_context_key text`, `scheduled_family text`, `scheduled_for timestamptz`, `occurrence_key text`, and `continuity_key text` to `topology_diagnostic_runs`. Add a CHECK that these are either all null for on-demand or all present for scheduled runs, family `ipv4|ipv6`, context ≤255 bytes, and keys 64 lowercase hex characters. Add same-scope `(policy_id,org_id,site_id)` FK to `topology_monitoring_policies(id,org_id,site_id) ON DELETE RESTRICT DEFERRABLE INITIALLY IMMEDIATE`, and a partial unique index `(org_id,site_id,policy_id,scheduled_context_key,scheduled_family,scheduled_for) WHERE policy_id IS NOT NULL`. The occurrence key is SHA256(canonical scope/policy/context/family/UTC scheduled slot); authority revision is stored separately and cannot create a second run for the same slot.

On `topology_monitoring_policies`, add `alert_state jsonb NOT NULL DEFAULT '{"schemaVersion":1,"entries":[]}'::jsonb` and `alert_state_revision bigint NOT NULL DEFAULT 0 CHECK (alert_state_revision>=0)`. `alert_state` is bounded runtime state, not policy configuration. Its exact validated shape is:

```ts
type TopologyAlertStreak = {
  contextKey:string; family:'ipv4'|'ipv6'; policyRevision:string;
  lastClaimedScheduledFor:string|null; lastClaimedOccurrenceKey:string|null;
  lastAppliedScheduledFor:string|null; lastAppliedOccurrenceKey:string|null;
  continuityKey:string|null; originDeviceId:string|null; originAgentId:string|null;
  consecutiveFailures:number; consecutiveSuccesses:number;
  activeAlertId:string|null; lastNotifiedAt:string|null;
};
type TopologyPolicyAlertState = {schemaVersion:1;entries:TopologyAlertStreak[]};
```

Each strict entry has exactly one configured `(contextKey,family)` pair; reject duplicate/unconfigured pairs. Initially enable at most two contexts (four family entries). Additional contexts require explicit selection, refreshed volume preview and authority; enforce at most128 selected observed contexts (the M1 context ceiling), two families,256 entries and256KiB serialized JSON. Validate all UUIDs/UTC times/decimal revisions/hex digests and nonnegative safe-integer streak counters. DB CHECKs enforce object/version/array/count/size; a bounded validation function in this migration also rejects duplicate pair keys, malformed entry values and unknown fields on direct writes. Configuration membership is checked by the application in the same locked policy transaction. Origin/alert IDs are immutable event references/snapshots, not a substitute for resource authorization.

`alert_state_revision` is the CAS revision for claims and assessments; it is independent of policy configuration `revision`, settings revision, authority digest and graph revision. Lock one policy row `FOR UPDATE` in a short transaction, parse state, update only the selected pair and `UPDATE ... WHERE alert_state_revision=expected RETURNING ...` with revision+1. Zero rows means reload/recompute, never replace other context entries with a stale snapshot. Configuration edits/re-arm preserve existing active alert references for unchanged pairs but reset counters/continuity and pin the new policy revision; removed pairs stop executing without closing historical alerts. A context's continuity key hashes policy ID/revision, context/family and chosen origin device/agent/context identity. A fresh origin receives a new series; no pre/post-origin streak mixing.

For each new slot, advance `lastClaimedScheduledFor` and its occurrence key atomically with either a durable run+outbox intent or an existing `topology_change_outbox` `monitoring_gap` event. The outbox idempotency key uses the same occurrence key. A replica whose slot is ≤last claimed skips; it cannot turn an already accepted run into a budget-gap event. Slots skipped during downtime collapse into one bounded gap with missed-count/time-range, never one row/probe per missed interval. Scheduling gap payload contains policy/config revision/context/family/scheduledFor/occurrence key/reason; Task8 consumes it through the same ordered assessment function as completed runs. Outbox delivery is idempotent and preserves the existing retention rules. No new occurrence or streak table is introduced.

Import `canonicalizeArguments` from `@breeze/shared/canonicalize`; do not use object insertion-order JSON. Apply `topology:write`, `devices:write`, `devices:execute`, graph/site/resource access and existing MFA to activation; store authority owner, permission/MFA epochs and pinned effective template/target revisions. Re-evaluate before each enqueue **and immediately before dispatch**. Any material change disables runtime policy, invalidates queued intent and requires a new successful arm. Existing policies/monitors keep their configured behavior.

Scheduler scans only due enabled authorized policies, uses a DB claim/CAS plus unique occurrence insert, and enqueues outbox intents after transaction commit. Round-robin site batches with a separate scheduled queue share the M1 active-run quota semaphore with on-demand runs. Jitter is derived reproducibly from policy/context/family/slot hash in [−0.1,+0.1], not fresh random on every retry. Deadlines are min(existing 120s lifetime,next interval); no offline catch-up. A missed/budget-blocked slot emits a bounded collection-gap event, advances next time to a future slot and does not generate a failed check. Do not create one policy/device merely because the graph has many devices.

Port-telemetry opt-in has its own concrete site-only configuration, separate from diagnostic recipe policies. Store it in the existing `topology_site_state` effective settings JSON under `interfaceTelemetry`; direct edits also write the explicit site override layer through M1 `updateTopologySiteConfiguration` in the same revisioned transaction. Portable template definitions may set disabled cadence/typed selection defaults but never contain local source/interface IDs or arm execution. Extend the existing `TopologySettingsLayers` site-override schema and `resolveTopologySettings` compiler, not an independent settings writer: partner/org defaults resolve first, explicit site-owned selections and cadence overrides retain their provenance, and `templateApply` preserves local IDs while revalidating their materialized authority. A changed inherited cadence/source selector invalidates the existing telemetry preview/arm and disables affected work until fresh site authorization; a template application cannot silently overwrite selections or turn collection on. Only the compiled runtime `topology_site_state` settings contains resolved IDs/authority; reusable versions remain portable. Exact shape:

```ts
type TopologyTelemetrySelection = {
  enabled:boolean; intervalSeconds:number;
  interfaces:Array<{sourceId:string;interfaceId:string;interfaceEpoch:string}>;
};
type TopologyInterfaceTelemetrySettings = TopologyTelemetrySelection & {
  schemaVersion:1; revision:string;
  authority:{userId:string;permissionsEpoch:number;mfaEpoch:number;effectDigest:string;armedAt:string}|null;
  blockedReason:string|null;
};
```

Validate interval30–300/default60, unique source/interface/epoch tuples, max4,096 explicitly selected ports/site and256KiB within the existing settings bound. This site selection quota is separate from the 256-port transport batch cap. The server intersects selections with fresh same-site interface/source ownership, collector capability and configured SNMP target or mapped controller authority. Never accept an ifIndex/controller port/target IP from the caller; resolve those from the authorized current interface observation and freeze the resulting mapping in the preview/effect digest. Identity epoch/config revision/credential-reference revision changes disable affected execution with a reason until a fresh preview/re-arm; raw credentials never enter settings. Disable immediately fences queued metric polls, clears active authority and preserves samples; it does not disable unrelated legacy SNMP/UniFi collection. Settings already have excludedOpen export treatment; maintain that classification for this runtime JSON.

Add `POST /topology/sites/:siteId/interface-telemetry/preview` in `telemetrySettings.ts` as a bounded read-only-effect preview (no poll/write), then activate through existing `PATCH /topology/sites/:siteId/settings` with `{expectedRevision,interfaceTelemetry,telemetryPreviewToken}` and existing configure/execute/MFA checks. Preview lists exact supported sources/ports/epochs, collector, cadence, series count and `enabledPorts × 86400 / interval × storedSeriesCount`; quota failure refuses activation. A GET/settings read never arms, previews do not grant authority, and an old inert draft cannot auto-enable on upgrade. The source settings digest/settings revision includes material telemetry configuration but excludes scheduler cursor updates.

`telemetryDispatch.ts` bridges actual collection: the existing SNMP scheduler calls `buildTopologyTelemetryBatches` for due enabled SNMP sources and adds its approved mapping to the existing authorized `snmp_poll` command; the existing UniFi agent collector-config response receives the same bounded `interfaceTelemetryV1` selection/interval/digest for that enrolled collector and mapped controller site. The local UniFi loop fetches detail/statistics only for this enabled selection/cadence. Before each new batch, re-resolve live standing authority/source config, bound collector/source/site, current interface epochs, feature flag and quota; no fallback to another site. Reuse current scheduled source polling when equivalent, otherwise enqueue bounded metric-only work under the same authorized source, never expand template OIDs or discovery subnets silently.

For each batch, persist an existing topology outbox intent containing command/config revision, effect digest, expiry and the approved source/local-port/canonical-interface/epoch mapping before dispatch. Agent config fetch/command delivery carries that immutable server-issued mapping; result ingestion verifies it against the stored intent and authenticated producer. Source-local ifIndex7 cannot return interface8's UUID. Batch completion/cursor is server-owned; resume selected ports in at most256-port batches without re-reading all4,096 in one payload. Revalidate disable/drift before every remaining batch; duplicate results are idempotent. Metric results cannot modify interface identity; epoch mismatch yields historical-only/rejected data and a re-arm reason.

Add integration tests `topologyTelemetryActivation.integration.test.ts`: preview alone sends0 commands; valid explicit PATCH yields one authorized SNMP batch and a mapped UniFi metric config; interval/capability/quota/foreign interface/forged local-port inputs fail; two batches resume within budget; disable/revocation/epoch drift cancels the next batch; unknown controller site and mismatched result mapping never persist samples. Unit tests inject both SNMP enqueue and UniFi config transport, with zero real network calls. Run `pnpm --filter @breeze/api test:run src/services/topology/telemetryConfiguration.test.ts src/services/topology/telemetryDispatch.test.ts src/routes/topology/telemetrySettings.test.ts` then `pnpm --filter @breeze/api test:integration src/__tests__/integration/topologyTelemetryActivation.integration.test.ts` in the Step2 FAIL and Step4 PASS cycle.

At most two contexts are enabled initially; extra context selection is explicit and previewed. Port configuration preview enforces 30–300s cadence, 256-port batches and `ports * 86400 / interval * storedSeriesCount` against org quota before saving. Compatible existing monitor binding supplies the overlay without new runs or altered target/interval/alert rules; null-site legacy monitors are ineligible. Removing a binding leaves an external monitor intact. Preferred collector loss permits a new eligible same-site origin only on a later occurrence; increment continuity identity and record origin-change event. Never switch the collector of a running attempt.
- [ ] **Step 4: Run to pass.** Repeat Step 2, M1 template/policy integration suite and `pnpm --filter @breeze/api test:run src/services/networkBaselineAuthority.arming.test.ts src/jobs/monitorWorker.test.ts`; run schema checks/catalog/lifecycle suites for the new run columns. Expected no privilege escalation from activationIntent, no hidden monitor edits or duplicated schedules.
- [ ] **Step 5: Commit.** Stage Task 7 files, export registry changes and the resolved new migration; `git commit -m "feat(topology): schedule policies with renewed authority and bounded fair dispatch"`.

## Task 8: Track scheduled health streaks and reuse source alerts

**Files:**
- Create: `apps/api/src/services/topology/monitoringAssessment.ts`, `apps/api/src/services/topology/monitoringAssessment.test.ts`, `apps/api/src/services/topology/monitoringAlerts.ts`, `apps/api/src/services/topology/monitoringAlerts.test.ts`.
- Modify: M1 `apps/api/src/services/topology/diagnosticResults.ts`, `apps/api/src/services/topology/diagnosticHealth.ts`; Task 7 `monitoringScheduler.ts`.
- Modify: Task7 `apps/api/src/services/topology/monitoringState.ts` and its test to apply ordered assessment CAS. Read the fixed Task7 `alert_state`/`alert_state_revision` schema; no optional migration or new state table in Task8.
- Create: `apps/api/src/__tests__/integration/topologyMonitoringAlerts.integration.test.ts`.

**Interfaces:**
- `advanceTopologyAlertStreak(previous:TopologyAlertStreak,event:TopologyMonitoringEvent):TopologyAlertDecision` pure. `TopologyAlertStreak` is exactly the Task7 type, keyed by context/family. `TopologyMonitoringEvent` has policyId/policyRevision/contextKey/family/scheduledFor/occurrenceKey/continuityKey, nullable sourceId/runId/origin snapshots, canonical coverage/assessment/freshness, kind `scheduled_result|scheduled_gap|on_demand_result`, reason and receivedAt. Event ordering uses server scheduledFor and occurrenceKey, never arrival/agent wall time.
- `applyTopologyMonitoringAssessment(scope:TopologyScope,event:TopologyMonitoringEvent):Promise<void>` resolves the stored run or gap event, verifies matching authority/occurrence and idempotently updates only its context/family streak state/health revision and reuses existing alert service/maintenance notification paths. An existing monitor alert stays the original alert ID.

- [ ] **Step 1: Write failing state-machine tests.** Test exact threshold, recovery, gap and origin boundaries:

```ts
it('breaks failure streak on a collection gap', () => {
  const old = { ...emptyStreak, continuityKey:'origin-a/context-a/ipv4', consecutiveFailures:2 };
  const next = advanceTopologyAlertStreak(old, { ...gapEvent, continuityKey:old.continuityKey });
  expect(next.streak.consecutiveFailures).toBe(0);
  expect(next.action).toBe('none');
});
```

Declare complete `emptyStreak`/`gapEvent` literals in the fixture using the exact Task7 fields. Add explicit table-driven ordering regressions:

```ts
it.each(['scheduled_gap','scheduled_result'] as const)('ignores older %s without breaking the current streak',kind=>{
  const previous = {...emptyStreak,policyRevision:'4',consecutiveFailures:2,
    lastAppliedScheduledFor:'2026-09-15T00:10:00Z',lastAppliedOccurrenceKey:'a'.repeat(64)};
  const event = {...gapEvent,kind,policyRevision:'4',scheduledFor:'2026-09-15T00:05:00Z',occurrenceKey:'b'.repeat(64)};
  expect(advanceTopologyAlertStreak(previous,event)).toEqual({streak:previous,action:'none'});
});
```

Also replay an equal-slot duplicate gap and equal-slot duplicate completion after a later success, and assert state revision/notification count unchanged. A newer gap must reset both streaks exactly once; a late completion for an already applied gap cannot restore failures. Test ipv4 and ipv6/context-A and context-B interleaving without contamination, two concurrent CAS updates preserving both entries, a stale policy-revision event ignored, and a late old-origin failure after a new-origin occurrence ignored. Cover three complete fresh scheduled failed occurrences→one alert, two successes→recovery, 5-minute notification cooldown, duplicate/out-of-order run, on-demand result, mixed DNS/TLS/TCP outcomes, one external destination partial coverage, maintenance, collector failure, origin switch, policy disabled, legacy monitor alert and late expired run.
- [ ] **Step 2: Run to fail.** `pnpm --filter @breeze/api test:run src/services/topology/monitoringAssessment.test.ts src/services/topology/monitoringAlerts.test.ts`; `pnpm --filter @breeze/api test:integration src/__tests__/integration/topologyMonitoringAlerts.integration.test.ts`.
- [ ] **Step 3: Implement deterministic streak and evidence updates.** Core gating:

```ts
if (event.kind === 'on_demand_result') return {streak:previous,action:'none'};
if (event.policyRevision !== previous.policyRevision) return {streak:previous,action:'none'};
if (previous.lastAppliedScheduledFor !== null
    && Date.parse(event.scheduledFor) <= Date.parse(previous.lastAppliedScheduledFor)) {
  return {streak:previous,action:'none'}; // duplicate/older result or gap never resets a newer streak
}
const next = {...previous,lastAppliedScheduledFor:event.scheduledFor,
  lastAppliedOccurrenceKey:event.occurrenceKey,continuityKey:event.continuityKey};
const base = event.continuityKey === previous.continuityKey ? next
  : {...next,consecutiveFailures:0,consecutiveSuccesses:0};
const advances = event.kind === 'scheduled_result' && event.coverage === 'complete'
  && event.freshness === 'fresh';
if (!advances) return {streak:{...base,consecutiveFailures:0,consecutiveSuccesses:0},action:'none'};
const consecutiveFailures = event.assessment === 'failed_check' ? base.consecutiveFailures+1 : 0;
const consecutiveSuccesses = event.assessment === 'healthy' ? base.consecutiveSuccesses+1 : 0;
const action = consecutiveFailures>=3 && !base.activeAlertId ? 'open'
  : consecutiveSuccesses>=2 && base.activeAlertId ? 'recover' : 'none';
return {streak:{...base,consecutiveFailures,consecutiveSuccesses},action};
```

Origin changes establish a fresh continuity key; unsupported/gaps/stale break both streaks. An on-demand event is ignored without mutating the scheduled streak unless the policy explicitly permits it. Failed target checks differ from orchestration execution errors. Gateway ICMP timeout never cancels successful outbound health; DNS, TLS and HTTP retain distinct evidence. Explicit disabled admin state is an expected-state reason rather than a synthesized outage. Counts include unknown/unmonitored; do not average a group green. Preserve existing monitor rule semantics and use monitor binding/source alert ID to avoid a duplicate topology alert. Apply the Task7 policy-row lock/CAS and ordering guard before any streak or alert side effect. Set lastApplied slot/key for a new gap and for every new terminal scheduled assessment, including unknown/unsupported; old/equal slots and old policy revisions are true no-ops. A first complete measurement in a new continuity starts its own success/failure streak at1 after discarding old counters; unknown/gap starts at0. In the same short transaction commit the state and unique source-alert transition/outbox event; use occurrence key in event deduplication so a crash/redelivery cannot notify twice. An event for another pair updates that pair independently; no arrival-order global counter. Maintenance suppresses notifications through existing mechanism while preserving measurement/coverage history.
- [ ] **Step 4: Run to pass.** Repeat Step2 plus existing monitor-alert worker tests and the Task7 real DB schema/lifecycle suite; this task uses the already-created policy state columns without a new migration. Expected an unavailable collector produces coverage information, never “Site down.”
- [ ] **Step 5: Commit.** Stage Task8 service/test files; `git commit -m "feat(topology): assess recurring checks and reuse alert evidence"`.

## Task 9: Add bounded routed tracing to the durable diagnostic executor

**Files:**
- Modify: shared topology diagnostic types/validators and M1 `apps/api/src/services/topology/diagnosticPlanner.ts`, `diagnosticHealth.ts`, their tests.
- Create: `agent/internal/networkdiagnostic/traceroute.go`, `agent/internal/networkdiagnostic/traceroute_test.go`, `agent/internal/networkdiagnostic/traceroute_unix.go`, `agent/internal/networkdiagnostic/traceroute_windows.go`.
- Modify: M1 `agent/internal/networkdiagnostic/types.go`, `policy.go`, `runner.go`, `journal.go` and their adjacent tests. Add trace capability through the existing heartbeat capability registry modified by M1; keep the single `network_diagnostic` handler.
- Create: `apps/api/src/services/topology/tracerouteResults.ts`, `apps/api/src/services/topology/tracerouteResults.test.ts`.

**Interfaces:**
- Extend `recipeId` with `trace_route` version1 and a typed `trace` step in the existing bounded diagnostic plan.
- Go `RunTrace(ctx context.Context, plan TracePlan, transport TraceTransport) TraceResult`; `TraceTransport.Probe(ctx,ttl,attempt,destination,sourceBinding) (TraceReply,error)` is injectable. Supported native IPv4/IPv6 ICMP/UDP implementations advertise capability; unsupported OS/privileges return an explicit result, never a shell fallback. Use explicit `//go:build !windows` on `traceroute_unix.go` and `//go:build windows` on `traceroute_windows.go`; the `_unix` filename alone is not a build constraint.
- Shared `TopologyTraceHop={ttl:number,attempt:number,address:string|null,rttMs:number|null,outcome:'reply'|'timeout'|'unreachable'|'unsupported',attributionQuality:'observed'|'requested_unverified'|'unknown'}`; result includes requested/actual method, actual origin/source/interface/context/destination, per-hop alternatives and truncation.

- [ ] **Step 1: Write failing bounded/cancellation tests.** Use a fake transport recording TTL and attempts; no real socket or external command. Example:

```go
func TestTraceRetainsTimeoutGap(t *testing.T) {
  fake := newFakeTraceTransport(map[int]TraceReply{1:{Address:"192.0.2.1"},3:{Address:"192.0.2.3"}})
  got := RunTrace(context.Background(), tracePlan(3,1), fake)
  if len(got.Hops)!=3 || got.Hops[1].Outcome!="timeout" { t.Fatalf("lost gap: %#v",got) }
  if len(fake.Calls)!=3 { t.Fatalf("unexpected fanout: %d",len(fake.Calls)) }
}
```

Define `newFakeTraceTransport` and `tracePlan` in this test file with TEST-NET literals and explicit deadlines. Cover 31-hop rejection, >2 probes rejection, total lifetime, cancellation before/after step journal start, duplicate delivery, local source/interface restrictions, IPv6 zone, route switch, ECMP alternatives, DNS rebinding and mismatched result digest. Assert no topology node or relationship is inserted for a responding hop.
- [ ] **Step 2: Run to fail.** `cd agent && go test -race ./internal/networkdiagnostic/... -run 'TestTrace|TestDiagnosticTrace' -count=1`; `pnpm --filter @breeze/api test:run src/services/topology/tracerouteResults.test.ts src/services/topology/diagnosticPlanner.test.ts`.
- [ ] **Step 3: Implement bounded native probes through existing journal.** Apply max30 hops, max2 probes, 1-second timeout and `min(60s,remaining absolute lifetime)`. Reuse the M1 approved target resolution/pinning, address exclusions, explicit source bindings, route attribution and at-most-once step intent journal. Probe each TTL only while context/deadline remains valid; stop after destination confirmation. At TTL hops preserve independent responders, gaps and method/time. Return `unsupported` where raw/UDP response support is absent; no arbitrary program/arguments or increased privilege request. Sanitize to 8KiB step/128KiB run bounds; mark truncation. Result validation uses origin/attempt/command/digest from the existing M1 ingress.

```go
for ttl:=1; ttl<=plan.MaxHops && ctx.Err()==nil; ttl++ {
  for attempt:=1; attempt<=plan.ProbesPerHop && ctx.Err()==nil; attempt++ {
    hopCtx,cancel := context.WithTimeout(ctx,time.Second)
    reply,err := transport.Probe(hopCtx,ttl,attempt,plan.Destination,plan.SourceBinding)
    cancel()
    result.Append(ttl,attempt,reply,err)
  }
}
```

`Append` is implemented on `TraceResult` in this task to normalize reply/timeout/unsupported and enforce the remaining byte budget; it does not hide missing hops. UI copy must distinguish “Observed routed path” from “Topology relationship path.” Asterisks never imply a failed cable.
- [ ] **Step 4: Run to pass.** Repeat Step 2, full diagnostics race suite and M1 lifecycle cancellation/replay tests. Compile platform files in each supported CI OS job; do not claim Windows support based only on a Linux unit run.
- [ ] **Step 5: Commit.** Stage Task 9 files; `git commit -m "feat(topology): add bounded trace evidence to durable diagnostics"`.

## Task 10: Compute cautious incident impact and evidence history

**Files:**
- Create: `apps/api/src/services/topology/impact.ts`, `apps/api/src/services/topology/impact.test.ts`, `apps/api/src/services/topology/changes.ts`, `apps/api/src/services/topology/changes.test.ts`, `apps/api/src/routes/topology/investigation.ts`, `apps/api/src/routes/topology/investigation.test.ts`.
- Modify: `apps/api/src/routes/topology/index.ts`, `apps/api/src/services/alertCorrelationRca.ts`, `apps/api/src/jobs/alertCorrelation.ts` only to attach read-only explanatory topology evidence; do not change alert state transitions.
- Create: `apps/api/src/__tests__/integration/topologyImpactScope.integration.test.ts`.
- Modify: shared topology types/validators to add the response contracts and bounded query schemas.

**Interfaces:**
- `getTopologyImpact(ctx:TopologyRequestContext,subject:{kind:'node'|'relationship';id:string},query:{graphRevision:string;windowMinutes:number}):Promise<TopologyImpactResponse>`; window defaults5/range1–30, traversal max10,000 nodes/20,000 relationships and2 seconds.
- `getRecentTopologyChanges(ctx:TopologyRequestContext,query:{since:string;until:string;limit:number;cursor?:string}):Promise<TopologyChangePage>`; maximum24h/window, default50/max200 rows, permission/revision-bound cursors.
- Add read-only endpoint extensions `GET /topology/sites/:siteId/impact` and `GET /topology/sites/:siteId/changes`; these additive operation-specific routes use canonical site prefix and are not a second graph API. `TopologyImpactResponse` has measuredFailures, potentiallyAffected, alternatives, assumptions, graphRevision, window, coverage `complete|partial`, reasons and cited evidence IDs.

- [ ] **Step 1: Write failing pure graph and scoped-route tests.** A fixture diamond A→B→D and A→C→D must retain the alternative:

```ts
it('reports an unverified alternative rather than declaring downstream loss', () => {
  const result = analyzeTopologyImpact(diamondFixture, {kind:'relationship',id:edgeAB}, failureEvidence, 5000);
  expect(result.potentiallyAffected.find(x=>x.id===nodeD)?.reasons).toContain('alternative_path_unverified');
  expect(result.measuredFailures.some(x=>x.id===nodeD)).toBe(false);
});
```

Define `analyzeTopologyImpact(graph,effect,evidence,deadlineMs):TopologyImpactResponse` as the pure task helper used by `getTopologyImpact`; graph fixture includes stable UUIDs, explicit context/freshness and no measured D failure. Cover cycles, parallel cables, LAG members, stale/manual/inferred relationships, VPN/multiple gateways, restricted-node traversal/counts, deadline truncation, conflicting successful other-origin evidence, moved subjects and expired detailed observations. Spy on alert mutations and assert zero calls.
- [ ] **Step 2: Run to fail.** `pnpm --filter @breeze/api test:run src/services/topology/impact.test.ts src/services/topology/changes.test.ts src/routes/topology/investigation.test.ts`; `pnpm --filter @breeze/api test:integration src/__tests__/integration/topologyImpactScope.integration.test.ts`.
- [ ] **Step 3: Implement context-aware bounded traversal and timeline reads.** Traverse authorized canonical entities at a pinned graph revision, not the truncated rendered canvas. Filter each resource before traversal/counting; do not route through hidden graph records to expose secret reachability. Separate actual fresh failures from possible dependencies; unknown forwarding/HA state yields `alternative_path_unverified`. A membership edge supports only a possible group, never cable dependence. Cause suggestions require compatible context/time and corroborating measured failures; centrality/high discovery confidence is insufficient.

```ts
if (visitedNodes.size >= 10000 || inspectedEdges >= 20000 || performance.now() >= deadline) {
  return {...result, coverage:'partial', reasons:[...result.reasons,'traversal_limit']};
}
```

Use existing observation/support/change/outbox/run history; persist no new duplicate incident graph. Changes distinguish attachment/route/source changes, origin switches, collection gaps, state transitions and measurement results, with reason/evidence IDs and expired-detail markers. Health freshness does not become structural change. RCA enrichment is optional bounded evidence with original alert IDs; no suppress/close/ack/downgrade/update of downstream alerts. A read request never triggers correlation jobs or measurements.
- [ ] **Step 4: Run to pass.** Repeat Step 2 plus `pnpm --filter @breeze/api test:run src/services/alertCorrelationRca.test.ts src/jobs/alertCorrelation.test.ts`; expected existing alert semantics unchanged and partial traversal visibly partial.
- [ ] **Step 5: Commit.** Stage Task 10 files; `git commit -m "feat(topology): explain possible incident impact with scoped evidence"`.

## Task 11: Deliver operational inspector and release acceptance flows

**Files:**
- Create: `apps/web/src/components/topology/InterfaceHistoryPanel.tsx`, `InterfaceHistoryPanel.test.tsx`, `MonitoringPolicyPanel.tsx`, `MonitoringPolicyPanel.test.tsx`, `InterfaceTelemetrySettings.tsx`, `InterfaceTelemetrySettings.test.tsx`, `TraceResultPanel.tsx`, `TraceResultPanel.test.tsx`, `ImpactPanel.tsx`, `ImpactPanel.test.tsx` in that same directory.
- Modify: M1 `apps/web/src/components/topology/TopologyInspector.tsx`, `TopologyDiagnosticsPanel.tsx`, their adjacent tests, and `apps/web/src/components/topology/useTopologyGraph.ts` at health refresh only.
- Create: `e2e-tests/tests/topology-operations.spec.ts`, `e2e-tests/pages/TopologyOperationsPage.ts`.
- Create: `apps/api/src/services/topology/metrics.ts`, `apps/api/src/services/topology/metrics.test.ts` for the M3 domain metrics; modify `docs/superpowers/plans/monitoring/2026-09-15-intelligent-network-topology-INDEX.md` only via owner-reviewed release-gate update when executing.

**Interfaces:**
- Panels take `{siteId:string,selection:TopologySelection,onSelectEvidence:(id:string)=>void}` from M1 inspector plus typed history/run/impact query results; HTTP hooks return data/state/errors and invoke canonical APIs only.
- Shared selection hashes preserve site/view/node/relationship/run; neither charts nor incremental health response rebuilds Cytoscape or clears pins/pan/selection.
- `data-testid` stable IDs include `topology-history`, `topology-health-freshness`, `topology-monitor-preview`, `topology-monitor-enable`, `topology-trace-start`, `topology-trace-hops`, `topology-impact-measured`, `topology-impact-potential`.

- [ ] **Step 1: Write failing component and E2E tests.** Mock chart API with a valid zero, null gap, speed change and new interface epoch; table displays the same values as chart. Seed deterministic mocked diagnostics for baseline-no-management and rich-switch fixtures. Example E2E uses only test IDs:

```ts
await page.getByTestId('topology-monitor-preview').click();
await expect(page.getByTestId('topology-monitor-volume')).toContainText('per day');
await page.getByTestId('topology-monitor-enable').click();
await expect(page.getByTestId('topology-monitor-status')).toContainText('Enabled');
await expect(page.getByTestId('topology-health-freshness')).toContainText('Not measured');
```

Test revoked authority during activation, 409 target revision change, partial bulk template adoption, collector offline, chart 403, queued/expired/cancelled trace, unsupported OS, stale port, one-sided counters, redundant path, keyboard/table navigation and reduced-motion. Assert opening map/history does not hit diagnostic POST or start telemetry.
- [ ] **Step 2: Run to fail.** `pnpm --filter @breeze/web test --run src/components/topology/InterfaceHistoryPanel.test.tsx src/components/topology/MonitoringPolicyPanel.test.tsx src/components/topology/TraceResultPanel.test.tsx src/components/topology/ImpactPanel.test.tsx`; `cd e2e-tests && pnpm test tests/topology-operations.spec.ts` against the local fixture app.
- [ ] **Step 3: Implement panels and feedback.** Render observed/manual/inferred connection meaning separately from operational color, known ports or “Port not identified,” missing values “Not measured,” expired detail as unavailable. Charts have units, direction relative to the named endpoint, origin/epoch, valid coverage and a readable table. Label flap metric “Observed state changes.” Show graph path versus routed path explicitly; trace timeout gaps and partial results remain visible. The interface telemetry settings panel explicitly selects supported canonical ports, previews the server-returned source/epoch/mapping and sample volume, then activates through the revisioned settings PATCH with its preview token; disabled/unsupported/drifted sources show their reason. Monitoring preview shows destinations/context/family/origin, compatible monitor reuse, interval/volume and per-site re-arm status before an explicit enable.

```tsx
<button data-testid="topology-monitor-enable" onClick={() => runAction({
  successMessage: 'Monitoring policy enabled',
  request: () => fetchWithAuth(`/topology/sites/${siteId}/monitoring-policies/${policyId}`, {
    method:'PATCH', body:JSON.stringify({expectedRevision:policyRevision,enabled:true}),
  }),
  errorFallback:'Could not enable monitoring',
})}>Enable monitoring</button>
```

Import `runAction`/`handleActionError` from `apps/web/src/lib/runAction.ts` and `fetchWithAuth` from the existing auth store. The handler catches via `handleActionError(err,'Could not enable monitoring')`; do not leave a rejected click-handler promise unhandled. Success text comes from the validated returned enabled/blocked state, so an inert draft is never announced as active. Accepted work announces queued status, then terminal outcome; polling starts2s, backs off5s and stops at terminal/unmount. No chart/freshness timer issues probe mutations. Health overlays retain group unknown counts and source monitor links.

Instrument dispatch duration, sweeper/orphan backlog, quota gaps, source switches, valid-sample ratio, port batches/bytes, history buckets, trace method/outcome and rejected/late results. Prometheus labels only recipe/status/platform/resolution; no site IDs, names or IPs. Detailed scoped logs retain sanitized correlation IDs/reasons. Rollback disables new dispatch/collection flags, preserves history and existing monitors, and exposes capability mismatch inline.
- [ ] **Step 4: Run to pass and verify release gates.** Repeat Step 2; run `pnpm --filter @breeze/web test --run src/lib/__tests__/no-silent-mutations.test.ts`, relevant M1 lifecycle/API tests, all M3 integration suites, `pnpm --filter @breeze/api test:rls-coverage`, and Go diagnostics/SNMP/UniFi `-race` suites. Perform browser checks for long labels, readable history gaps, contrast, keyboard equivalent and retained pan/selection. Execute the index's pilot/load/rollback thresholds with feature flags off by default; do not enable production during plan execution without the release step's authorization.
- [ ] **Step 5: Commit.** Stage Task 11 files; `git commit -m "feat(topology): expose port history monitoring traces and incident evidence"`.

## M3 handoff and completion evidence

- M4 consumes `getTopologyLinkHealth`, `getTopologyInterfaceHistory`, `getTopologyImpact`, `getRecentTopologyChanges`, M1 `getTopologyDiagnosticRun` and the unchanged scoped planner/dispatcher. M4 cannot bypass recurrence authority or alter health through explanation text.
- Record supported controller versions, source fields/units, supported OS trace capabilities, test outputs, actual migration filenames and storage-volume fixture results in the execution PR. Database columns alone are not capability proof.
- Complete means all eleven task gates pass, recurrence cannot execute without current authority, unsupported metrics remain null, retention runs under the unprivileged app role, and core diagnostics/monitoring are usable with AI disabled.
