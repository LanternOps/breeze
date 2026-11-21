# Learned Networks and the Network Gate — Plan Index

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (recommended)
> or superpowers:executing-plans to implement a wave plan task by task. Read the spec, this index, and
> then your wave's plan. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A site's network scans and probes run only from an agent that has just proven it is behind
one of the gateways an admin assigned to that site.

**Architecture:** Agents report the gateways they sit behind in the heartbeat; the API learns each
(gateway address, gateway MAC) pair as a network an admin can assign to a site. Assigning marks the site
*gated*: one gate function then decides every scan dispatch, sends a distinct guarded command that
names the allowed gateways, and one verifier checks every result. The agent proves the gateway with a
fresh layer-2 answer, binds every probe to that interface, and cancels on a network change.

**Tech stack:** PostgreSQL + Drizzle (forced RLS), Hono/TypeScript API, BullMQ, Go agent
(Windows/macOS/Linux), Astro + React web.

**Spec:** `docs/superpowers/specs/monitoring/2026-11-20-learned-networks-discovery-gate-design.md`
(approved 2026-11-21, decisions O1 to O7). Section numbers below (§) refer to it.

One plan document per wave. Each wave is one PR on its own branch
`feature/<parent#>-learned-networks/wave-<sub-issue#>` with `Closes #<sub-issue#>` in the PR body. State
lives on GitHub (feature-lifecycle); the wave issue is the source of truth for status, never this index.

| Wave | Plan | Depends on | Ships |
|---|---|---|---|
| W01a | [Schema and tenancy: five tables, new columns, RLS, registrations, org-merge fold, device-move cleanup](2026-11-21-learned-networks-w01a-schema-tenancy.md) | — | schema only, no behavior |
| W01b | [Learning: heartbeat ingest, digest, WAN history, kill switch, last-seen batch, retention](2026-11-21-learned-networks-w01b-learning-ingest.md) | W01a | API learns (nothing sends yet) |
| W02a | [Agent: attachment report in the heartbeat](2026-11-21-learned-networks-w02a-agent-attachment-report.md) | wire contract C1; promoted only after W01b is deployed | agent release, networks start appearing |
| W02b | [Agent spike: a fresh layer-2 answer from the gateway on Windows, macOS and Linux](2026-11-21-learned-networks-w02b-agent-fresh-proof-spike.md) | — (starts day one) | `gatewayproof` package + lab evidence. **Gate.** |
| W02c | [Agent: guarded discovery scan (select, prove, bind, watch, re-prove)](2026-11-21-learned-networks-w02c-agent-guarded-scan.md) | W02a, W02b passed | agent release |
| W03a | [API: the gate, the shared command builder, the attempt record, result verification](2026-11-21-learned-networks-w03a-gate-dispatch-verify.md) | W01b | inert (no site can be gated yet) |
| W03b | [API: saved SNMP credentials follow fingerprints (grants)](2026-11-21-learned-networks-w03b-snmp-grants.md) | W03a | inert |
| W03c | [API: network routes (list, assign, unassign, rename, ignore, merge, stop requiring)](2026-11-21-learned-networks-w03c-network-routes.md) | W03b, **W02c released** | **the switch**: sites can be gated |
| W04 | [Web: Networks tab, profile form, Profiles notice, Jobs and Assets changes](2026-11-21-learned-networks-w04-web.md) | W03c | admin-visible surface |
| W05 | [Docs, release notes and the two-router lab proof](2026-11-21-learned-networks-w05-docs-lab-proof.md) | W04 | discovery gate proven |
| W06a | [Agent: guarded SNMP poll and network checks](2026-11-21-learned-networks-w06a-agent-guarded-probes.md) | W02c | agent release |
| W06b | [API and web: SNMP polling, monitors and the asset probe follow the gate](2026-11-21-learned-networks-w06b-api-other-producers.md) | W03c, **W06a released** | feature closes |

The spec suggested six waves (§14). They are kept as W01 to W06; three are split so that each PR has one
reviewable risk (tenancy, agent-shipped code, the switch).

## Sequencing rules

1. **W02b is a gate.** It must return a fresh layer-2 answer on all three operating systems, with the
   evidence file committed. If one OS cannot do it, stop: W02c and W03c do not start, and the question
   goes back to the owner (§11). Step 2 of §7.2 is never weakened and no OS is dropped quietly.
2. **W03c merges last in the API group and only after an agent release contains W02c.** It is the only
   change that lets a site become gated. W03c also sets the guard's minimum agent version (E7) to that
   release. Before it, the gate, the verifier and the grants are in production but unreachable.
3. **W01b is deployed before agents that send the report are promoted** (§14).
4. W02a and W02b run in parallel with W01. W03a and W02c run in parallel. A stacked PR (base ≠ main)
   runs no CI: `gh workflow run CI --ref <branch>`.

## Migration slot

Newest committed migration on 2026-11-21: `2027-01-28-200000-agent-versions-min-os.sql`. This feature
uses one file, in W01a: **`2027-01-29-100000-learned-networks.sql`**. It writes no rows. Before
committing, re-check with the command in `apps/api/migrations/README.md` ("Rule 3") and rename upward if
`origin/main` has moved past it. No later wave adds a migration; if one turns out to need one, it takes
a new file that sorts after everything on `origin/main` and says so in its PR.

## Global constraints (every task inherits these)

**Product rules from the spec**

- A site that has never been gated behaves exactly as before, through every producer (§5, anti-goal 5).
- Nothing here ever changes a device's site (O6).
- Fail closed: a gated site with no assigned network, no eligible agent, or a learner that is switched
  off does not scan. It never falls back to unrestricted (§5, §8.1).
- The guarantee is "fingerprint match proven fresh on the bound interface". Copy never says "verified
  location" (§3).
- IPv4 default gateways only (§3).
- Limits (§6): 8 attachments per report, 32 WAN addresses per network (oldest dropped), 5,000 learned
  networks per org, 90 days retention for unassigned networks and for device rows.

**Public repository**

- No customer names, no real addresses, hostnames or MACs. Fixtures use only: `192.168.1.0/24` via
  `192.168.1.1`, `10.1.2.0/24` via `10.1.2.100`; MACs `a4:2b:b0:11:22:9c`, `3c:37:86:aa:bb:10`,
  `00:1a:8c:00:00:01`; WAN `203.0.113.20`, `198.51.100.7`; hosts `LAPTOP-JS`, `DESKTOP-01`.
- Plans, commits, PR bodies and issues state what the new code must do. They do not describe how any
  existing behavior falls short.

**Tenancy** (read `docs/agents/tenancy-rls.md` first)

- All five tables are shape 1 (direct `org_id`), RLS enabled and forced, four
  `breeze_has_org_access(org_id)` policies and the `breeze_app` grant in the creating migration. Template:
  `apps/api/migrations/2026-12-25-140000-topology-presence-read-model.sql:92-120`.
- Every reference between these tables, and from `discovery_profiles`, `discovery_jobs` and
  `discovered_assets` to them, is a composite FK including `org_id`, `DEFERRABLE INITIALLY IMMEDIATE`,
  with an explicit `ON DELETE`. Template for `SET NULL (col)`:
  `2026-12-22-130000-discovery-profile-pinned-device.sql`.
- Registrations are grep work, not judgment: `CORE_ORG_CASCADE_DELETE_ORDER`
  (`services/tenantCascade.ts:262`), `orgMergeRegistry.ts` (`SPECIAL` `:134`, `REPOINT_TABLES` `:851`),
  `CORE_TENANT_EXPORT_POLICY` (`services/tenantExportPolicyRegistry.ts:51`, every column classified,
  every jsonb `excludedOpen`), and for `learned_network_devices` the device lists
  (`services/deviceCascadeTables.ts:138`, `routes/devices/core.ts:237` and `:405`,
  `services/deviceInstallBoundary/classification.ts:101`).
- The cascade, merge and export-policy suites fail only under Integration Tests. Run them locally
  (`pnpm test-stack up`, then `pnpm --filter @breeze/api test:integration <file>`), and tear the stack
  down.
- A catch around a query wraps the query in `withDbTransaction` with the catch outside. Never start
  `withDbTransaction` beside siblings in a `Promise.all`.
- Agent-path writes to `devices` go through `updateOwnDeviceRow`
  (`__tests__/agentOwnDeviceRowUpdates.contract.test.ts`).

**Migrations** (read `apps/api/migrations/README.md` first): idempotent, no inner `BEGIN`/`COMMIT`,
never edit a shipped file, then `pnpm db:migrate && pnpm db:check-drift`.

**API contracts that new files trip**

- A new file under `routes/` needs an `MCP_COVERAGE` entry (`services/mcpCoverage.ts:238`). The network
  routes are `{ exempt: 'internal_plumbing', note }`: AI and MCP tools for networks are a non-goal (§3).
- A new `jobs/` or `services/` file that reads `devices` or filters ephemeral devices is listed in
  `__tests__/parkedFanoutModules.ts` or the lists in `__tests__/parkedFanout.contract.test.ts`.
- A new worker goes in `WORKER_REGISTRY` (`services/workerRegistry.ts:103`), `EXPECTED_WORKER_NAMES`
  (`services/workerRegistry.test.ts:30`) and a free cron slot in `JOB_SCHEDULES`
  (`jobs/scheduleRegistry.ts:78`).
- Every write route has a permission gate (`writeRoutePermissionGate.contract.test.ts`) and site
  restriction (`pnpm -F @breeze/api test:site-scope-coverage`).
- Editing `services/aiToolsNetwork.ts`: re-run `aiTools.userOwnedRelease.contract.test.ts`,
  `aiTools.deviceWaitContext.contract.test.ts` and `middleware/automationPrincipal.contract.test.ts`.
- New integration tests live under `apps/api/src/__tests__/integration/` and must be picked up by
  `vitest.integration.config.ts` (`pnpm --filter @breeze/api test:integration-suite-coverage`).
- Scoped test runs: `cd apps/api && npx vitest run <path>`. Never `pnpm --filter <pkg> test -- --run`.

**Agent** (ships to customer machines: TDD, review, `go test -race ./...`)

- Do not depend on the network-context manager being enabled, and never use its cached snapshot (§7).
- Linux and Windows release builds use `CGO_ENABLED=0`; macOS uses 1 and CI compiles macOS both ways.
  New code builds and passes without cgo on all three.
- A new `wire.CommandErrorCode` is added to `agent/internal/wire/errorcodes.go` and to
  `AGENT_COMMAND_ERROR_CODES` (`apps/api/src/routes/agents/schemas.ts:677`) in the same PR; a Go test
  pins the two lists together.
- A new command type is added to `allCommandTypes` (`agent/internal/heartbeat/handlers_test.go:15`).
- Windows CI runs an explicit package list (`.github/workflows/ci.yml`, job `test-agent-windows`). Every
  new agent package is added to it, and each agent wave ends with a native run on the Windows lab VM.

**Web**

- New locale keys go in all eight locales (`en`, `de-DE`, `es-419`, `fr-CA`, `fr-FR`, `it-IT`, `pt-BR`,
  `tr-TR`), translated: `translationCoverage.test.ts` caps values left identical to English.
- Write `cond ? t('a') : t('b')`, never `t(cond ? 'a' : 'b')`.
- Mutations go through `runAction`; every new component file with a mutation is added to
  `TARGET_GLOBS` in `apps/web/src/lib/__tests__/no-silent-mutations.test.ts`.
- A new API field is dead until the web mapper reads it. The mappers are listed in the code map.
- Tab state stays in `window.location.hash`. E2E selectors are `data-testid` only.

## Review focus

Inputs the spec implies and no single wave would otherwise test. Each is pinned by a named test in the
wave that owns the code.

1. **A server whose address sits on a virtual switch with a physical uplink** (a Hyper-V host with an
   external switch, a Linux host with a bridge). It is the ideal always-on scan agent and its default
   route is on a "virtual" interface. Expected: it reports the attachment; only NAT-only switches are
   left out. W02a: `TestCurrent_BridgedUplinkIsReported`, `TestCurrent_NatSwitchIsSkipped`.
2. **A quiet machine whose gateway entry has dropped out of the neighbour cache** (`gatewayMac: null`
   in a complete report). Expected: its existing membership on that interface, address and gateway is
   kept and confirmed; no network is created; eligibility does not flap. W01b:
   `null gateway MAC keeps the current membership`.
3. **Two default routes at once** (Ethernet and Wi-Fi, or an office LAN under a full-tunnel VPN).
   Expected: one attachment per LAN route; the WAN address is recorded only for the primary one; the
   guard selects the attachment that matches an expected gateway even when it is not primary, and
   nothing leaves the other interface. W02a: `TestCurrent_TwoDefaultRoutes`; W02c:
   `TestBegin_SelectsNonPrimaryMatch`.
4. **A site is assigned a network while none of its agents can run a guarded scan.** Expected: the
   assign confirmation states how many of the site's online agents are on the network and how many need
   updating, before the admin commits. W03c: `assign preview counts eligible and outdated agents`.
5. **A device whose clock is wrong.** `capturedAt` outside the bound must not silently make a device
   invisible. Expected: the report is ignored with a counted reason, and the device's ineligibility
   reason reads as "not on this network" with the last confirmation time. W01b:
   `capturedAt outside the bound is ignored and counted`.

## Plan calls beyond the spec

Decisions the spec left open or that recon forced. Each is reversible by editing this index before the
wave starts.

1. **Twelve PRs** instead of six waves (table above).
2. **The learner is wired to the REST heartbeat only.** §8.1 says "both heartbeat parsers". The
   WebSocket heartbeat message carries no device row, no ephemeral flag and no client address, and no
   shipped agent sends it. W01b pins with a test that the WebSocket heartbeat schema does not accept
   `networkAttachmentsV1`.
3. **`discovery_jobs.cross_network_asset_updates integer NULL`** is added to hold the count in §8.4,
   which had no column.
4. **The gated invariant is enforced in the database** as well as in code: deferred constraint
   triggers refuse an assigned network on a site that is not gated, and refuse clearing the flag while
   a network is assigned (A6).
5. **The per-site lock is a transaction-scoped advisory lock** keyed by site id (E1): shared for
   dispatch and profile saves, exclusive for assignment changes. Row locks on `sites` would join the
   lock order of other subsystems.
6. **A null gateway MAC neither creates nor clears a membership** (review focus 2).
7. **`capturedAt` must be within 10 minutes of server time, either way.**
8. **The agent reserves sequence numbers in blocks of 1,024**, so it writes its state file about once
   a day, not once a heartbeat.
9. **`expectedNetwork` carries at most 64 gateways**, the ones the chosen agent is currently behind
   first.
10. **The guard's minimum agent version starts at `999.0.0`** (nothing qualifies) and W03c sets the real
    release.
11. **W06 uses a distinct `_guarded` command type per command** (C5), and **short probes may reuse a
    gateway proof for up to 60 seconds** while the interface has seen no link, address or route change.
    Discovery scans never reuse a proof. Without this a monitor checked every 30 seconds would re-prove
    the gateway twice a minute.
12. **Outside O7:** `snmp_devices` rows with no asset have no site and are not gated; the topology
    interface poll is not covered. Both are follow-ups, filed when W06b lands.

---

## Cross-wave contract

Names below are fixed. A wave that needs to change one changes this index in the same PR.

### A. Schema (W01a) — `apps/api/src/db/schema/learnedNetworks.ts` (new, exported from `schema/index.ts`)

| Drizzle export | Table | Columns beyond `id`, `org_id` |
|---|---|---|
| `learnedNetworks` | `learned_networks` | `site_id` uuid null; `name` varchar(255) null; `prefix` cidr null; `ignored_at`; `assigned_by` uuid null → users (set null); `assigned_at`; `first_seen_at`; `last_seen_at`; `created_at`; `updated_at` |
| `learnedNetworkGateways` | `learned_network_gateways` | `network_id`; `gateway_address` inet not null; `gateway_mac` macaddr not null; `first_seen_at`; `last_seen_at`; `created_at` |
| `learnedNetworkDevices` | `learned_network_devices` | `device_id`; `gateway_id`; `interface_name` varchar(128) not null; `local_address` inet not null; `is_primary` bool; `is_current` bool; `first_seen_at`; `last_seen_at` |
| `learnedNetworkWanAddresses` | `learned_network_wan_addresses` | `network_id`; `address` inet not null; `first_seen_at`; `last_seen_at` |
| `discoveryProfileSnmpGrants` | `discovery_profile_snmp_grants` | `profile_id`; `gateway_id`; `granted_by` uuid null → users (set null); `granted_at` |

- **A1. Uniques:** `(id, org_id)` on `learned_networks` and `learned_network_gateways` (and on
  `discovery_profiles` if absent); `learned_network_gateways (org_id, gateway_mac, gateway_address)`;
  `learned_network_devices (device_id, gateway_id)`; `learned_network_wan_addresses (network_id,
  address)`; `discovery_profile_snmp_grants (profile_id, gateway_id)`.
- **A2. Composite FKs** (all `DEFERRABLE INITIALLY IMMEDIATE`):

  | From | To | On delete |
  |---|---|---|
  | `learned_networks (site_id, org_id)` | `sites (id, org_id)` | `SET NULL (site_id)` |
  | `learned_network_gateways (network_id, org_id)` | `learned_networks` | `CASCADE` |
  | `learned_network_devices (device_id, org_id)` | `devices` | `CASCADE` |
  | `learned_network_devices (gateway_id, org_id)` | `learned_network_gateways` | `CASCADE` |
  | `learned_network_wan_addresses (network_id, org_id)` | `learned_networks` | `CASCADE` |
  | `discovery_profile_snmp_grants (profile_id, org_id)` | `discovery_profiles` | `CASCADE` |
  | `discovery_profile_snmp_grants (gateway_id, org_id)` | `learned_network_gateways` | `CASCADE` |
  | `discovery_profiles (network_id, org_id)` | `learned_networks` | `NO ACTION` (blocks; never set null) |
  | `discovery_jobs (network_id, org_id)` | `learned_networks` | `SET NULL (network_id)` |
  | `discovered_assets (last_network_id, org_id)` | `learned_networks` | `SET NULL (last_network_id)` |

- **A3. Checks:** `learned_networks`: not both `site_id` and `ignored_at` set. Gateways and device
  rows: IPv4 host addresses only. `discovery_profiles.snmp_grant_mode in ('unrestricted','bound')`.
  `discovery_jobs.network_dispatch` at most 16 KiB as text.
- **A4. New columns:** `sites.discovery_network_required boolean not null default false`;
  `devices.network_attachment_epoch varchar(16)`, `devices.network_attachment_sequence bigint`,
  `devices.network_attachment_digest varchar(64)`, `devices.network_attachments_confirmed_at
  timestamptz`; `discovery_profiles.network_id uuid`, `discovery_profiles.snmp_grant_mode varchar(16)
  not null default 'unrestricted'`; `discovery_jobs.network_id uuid`, `discovery_jobs.network_dispatch
  jsonb`, `discovery_jobs.cross_network_asset_updates integer`; `discovered_assets.last_network_id uuid`.
- **A5. Device org move:** `learned_network_devices` rows are deleted and the four
  `devices.network_attachment*` columns are cleared, before any restamp could point a row at a
  source-org gateway. Precedent: `breeze_topology_presence_device_moved` in the presence migration.
- **A6. Gated invariant triggers** (constraint triggers, deferrable, initially immediate):
  `learned_networks` insert or update of `site_id` to a site whose `discovery_network_required` is
  false raises; `sites` update of `discovery_network_required` to false while a network is assigned to
  it raises.
- **A7. Org merge** (§6): fold per fingerprint on `(gateway_mac, gateway_address)`; device rows and
  grants move to the survivor's identical fingerprint; a source network whose fingerprints all fold
  into one survivor network is merged into it (profiles, jobs, assets, WAN rows re-pointed; assignment
  carries over only when the survivor's network is unassigned); a source network that would split
  across survivor networks is kept, unassigned, without the folded fingerprints. A source site keeps
  `discovery_network_required`. Mechanism: `custom` policies and executors, as `discovered_assets` does
  (`services/orgMergeCustomExecutors.ts:191-237`).

### B. Shared constants, types and validators — `packages/shared/src/`

**B1. `validators/networkAttachments.ts`** (W01b)

```ts
export const NETWORK_ATTACHMENTS_MAX = 8;
export interface NetworkAttachment {
  interfaceName: string;        // 1..128 chars
  localAddress: string;         // IPv4
  prefixLength: number;         // 0..32
  gatewayAddress: string;       // IPv4
  gatewayMac: string | null;    // lower-case aa:bb:cc:dd:ee:ff
  primary: boolean;
}
export interface NetworkAttachmentsReport {
  epoch: string;                // /^[0-9a-f]{16}$/
  sequence: number;             // non-negative safe integer
  capturedAt: string;           // ISO 8601
  complete: boolean;
  attachments: NetworkAttachment[];
}
export function parseNetworkAttachmentsReport(value: unknown):
  | { accepted: true; report: NetworkAttachmentsReport }
  | { accepted: false; reason: 'invalid_report' };
```

More than 8 attachments: keep the primary first, then by `interfaceName`, cut to 8 and force
`complete: false`. MACs are normalized to lower-case colon form. A parse failure is report-local and
never fails the heartbeat (precedent: `validators/topologyCollection.ts:112`).

**B2. `types/discoveryNetworkGate.ts`** (W03a; W06b extends `GUARDED_COMMAND_TYPES`)

```ts
export const DISCOVERY_GATE_FAILURE_CODES = [
  'profile_moved', 'network_not_assigned', 'credentials_need_reentry', 'no_network_assigned',
  'no_agent_on_network', 'agent_not_eligible', 'network_mismatch', 'network_changed', 'network_unverified',
] as const;
export type DiscoveryGateFailureCode = (typeof DISCOVERY_GATE_FAILURE_CODES)[number];
export type NoAgentReason = 'none_online' | 'none_on_network' | 'agents_need_update';
export type IneligibleReason =
  | 'not_found' | 'other_site' | 'offline' | 'ephemeral' | 'parked' | 'not_on_network' | 'needs_update';
export interface DiscoveryJobError {
  message: string; code?: DiscoveryGateFailureCode; reason?: NoAgentReason | IneligibleReason;
}
export interface ExpectedGateway { networkId: string; gatewayId: string; address: string; mac: string }
export interface ExpectedNetwork { gateways: ExpectedGateway[] }           // 1..64
export interface VerifiedNetwork {
  networkId: string; gatewayId: string; gatewayAddress: string; gatewayMac: string; interfaceName: string;
}
export const EXPECTED_GATEWAYS_MAX = 64;
export const GUARDED_COMMAND_TYPES = { network_discovery: 'network_discovery_guarded' } as const;
export function isSharedVirtualRouterMac(mac: string): boolean; // 00:00:5e:00:01:xx, 00:00:0c:07:ac:xx
export const verifiedNetworkSchema: z.ZodType<VerifiedNetwork>;
```

### C. Wire contract

- **C1. Heartbeat field** `networkAttachmentsV1`: exactly the JSON in §7.1, typed by B1. Always sent
  by an agent that supports it; an empty complete list is valid. The REST schema declares it as
  `z.unknown().optional()` next to `networkContextV1` (`routes/agents/schemas.ts:210`).
- **C2. Guarded scan command:** type `network_discovery_guarded`. Payload is the `network_discovery`
  payload plus `expectedNetwork: ExpectedNetwork`. The `network_discovery` command is unchanged.
- **C3. Guarded result:** the `network_discovery` result plus `verifiedNetwork: VerifiedNetwork`. A
  refusal is `status: "failed"`, `errorCode` `network_mismatch` or `network_changed`, and for a mismatch
  a result body `{"observedGateways":[{"interfaceName","address","mac"|null}]}` (at most 8).
- **C4. Adjacency body:** `POST /api/v1/agents/:id/topology/adjacency` accepts an optional
  `verifiedNetwork` beside `parentJobId` and `report`. The agent sends it on guarded scans only.
- **C5. W06 command types:** `snmp_poll_guarded`, `network_ping_guarded`, `network_tcp_check_guarded`,
  `network_http_check_guarded`, `network_dns_check_guarded`. Each is its base payload plus
  `expectedNetwork`, and its base result plus `verifiedNetwork`.
- **C6. Error codes** (Go and API lists, same PR, W02c): `network_mismatch`, `network_changed`.

### D. Agent packages

**D1. `agent/internal/netattach`** (W02a): live reads through `networkcontext.NewReader`; no manager.

```go
type Attachment struct {
	InterfaceName  string
	InterfaceIndex uint32
	LocalAddress   netip.Addr
	PrefixLength   uint8
	GatewayAddress netip.Addr
	GatewayMAC     net.HardwareAddr // nil when the neighbour cache has no entry
	Primary        bool
}
// Current returns one Attachment per IPv4 default route on an up, reportable interface.
// complete is false when any read failed or the list was cut to MaxAttachments.
func Current(ctx context.Context, serverHost string) (attachments []Attachment, complete bool, err error)
const MaxAttachments = 8

type Report struct { /* JSON exactly as C1 */ }
type State struct{ /* epoch + reserved sequence, file network-attachment-state.json in config.GetDataDir() */ }
func OpenState(path string) (*State, error) // creates a random 16-hex epoch when the file is missing or unreadable
func (s *State) Next() (epoch string, sequence uint64, err error) // monotonic; persists one block of 1024 at a time
func BuildReport(ctx context.Context, st *State, serverHost string, now time.Time) Report
```

Heartbeat wiring: field `NetworkAttachmentsV1 *netattach.Report` with tag
`json:"networkAttachmentsV1,omitempty"` on `HeartbeatPayload`
(`agent/internal/heartbeat/heartbeat.go:98`), set by `h.attachNetworkAttachments(&payload)` beside
`attachLogShipping` (`:5855`). The read is bounded to 3 seconds and never delays or fails a heartbeat.

**D2. `agent/internal/gatewayproof`** (W02b)

```go
// Prove obtains a layer-2 answer from gateway on the named interface during this call.
// An entry that was only cached before the call does not count.
func Prove(ctx context.Context, iface Interface, gateway netip.Addr) (net.HardwareAddr, error)
type Interface struct { Name string; Index uint32; Source netip.Addr }
var ErrNoAnswer = errors.New("gatewayproof: no answer from gateway")
```

One implementation file per OS (`prove_windows.go`, `prove_linux.go`, `prove_darwin.go`), each building
with `CGO_ENABLED=0`. Candidates and the evidence required are in the W02b plan.

**D3. `agent/internal/netbind`** (W02c): the per-OS socket control now in
`agent/internal/networkdiagnostic/bind_{darwin,linux,windows}.go`, moved and exported.

```go
func Control(ifaceIndex uint32, ipv6 bool) func(network, address string, c syscall.RawConn) error
```

**D4. `agent/internal/netguard`** (W02c; W06a adds `Acquire`)

```go
type ExpectedGateway struct { NetworkID, GatewayID string; Address netip.Addr; MAC net.HardwareAddr }
type Binding struct {
	NetworkID, GatewayID string
	GatewayAddress       netip.Addr
	GatewayMAC           net.HardwareAddr
	InterfaceName        string
	InterfaceIndex       uint32
	SourceAddress        netip.Addr
}
func (b Binding) Dialer(timeout time.Duration) *net.Dialer                  // LocalAddr + netbind.Control
func (b Binding) ListenConfig() net.ListenConfig                            // netbind.Control
func (b Binding) Verified() map[string]any                                  // C3 verifiedNetwork

type Session struct{ /* ... */ }
// Begin selects an attachment whose gateway is expected, proves it fresh, and starts watching
// that interface's link, address and default route.
func Begin(ctx context.Context, expected []ExpectedGateway) (*Session, error)
func (s *Session) Context() context.Context // cancelled with ErrNetworkChanged on any watched change
func (s *Session) Binding() Binding
func (s *Session) Reprove(ctx context.Context) error
func (s *Session) Close()

type MismatchError struct{ Observed []ObservedGateway } // -> network_mismatch
var ErrNetworkChanged = errors.New("netguard: network changed") // -> network_changed
```

One process-wide change watcher fans out to sessions (`networkcontext.WatchChanges` is started once;
on Windows each start allocates a callback slot that is never freed).

**D5. `agent/internal/discovery`** (W02c): `ScanConfig` gains `Bind *netguard.Binding` (or an
equivalent local type if the import would cycle), and `Scanner` gains
`ScanContext(ctx context.Context) ([]DiscoveredHost, error)`. With `Bind` set, **every** socket the scan
opens goes through the binding, the scan stops when `ctx` is cancelled, and nothing is returned after a
cancel. `Scan()` stays as the unbound path used by `network_discovery`.

**D6. Handler** (W02c): `tools.CmdNetworkDiscoveryGuarded = "network_discovery_guarded"`, handler
`handleNetworkDiscoveryGuarded` in `agent/internal/heartbeat/handlers_network_guarded.go`. Order:
`Begin` → `ScanContext` → `Reprove` → credentialed pass (`CollectPhysicalFor` with the session context)
→ `Reprove` → post adjacency with `verifiedNetwork` → return C3.

### E. API services — `apps/api/src/services/learnedNetworks/`

**E1. `siteLock.ts`** (W03a)

```ts
// Transaction-scoped advisory locks, taken in ascending site id. Must run inside a transaction.
export async function lockSitesForNetworkGate(
  siteIds: readonly string[], mode: 'shared' | 'exclusive'): Promise<void>;
```

Lock order for every writer (§8.3): site locks (ascending id), then the profile row `FOR UPDATE`.
Dispatch and profile saves take `shared`; assignment, unassignment, merge and "stop requiring" take
`exclusive`.

**E2. `constants.ts`** (W01b; later waves add to it)

```ts
export const NETWORK_ATTACHMENT_FRESHNESS_MS = 10 * 60_000;
export const NETWORK_ATTACHMENT_MAX_CAPTURE_SKEW_MS = 10 * 60_000;
export const LEARNED_NETWORKS_PER_ORG_MAX = 5_000;
export const WAN_ADDRESSES_PER_NETWORK_MAX = 32;
export const UNASSIGNED_NETWORK_RETENTION_DAYS = 90;
export const NETWORK_DEVICE_RETENTION_DAYS = 90;
export const SUGGESTION_WINDOW_DAYS = 14;
export const SUGGESTION_MIN_SITE_DEVICES = 2;
export const CROSS_NETWORK_WINDOW_DAYS = 30;
```

Kill switch: `learnedNetworksIngestEnabled(): boolean` in `config/env.ts`, reading
`LEARNED_NETWORKS_INGEST_ENABLED` (default on) with `envFlag`.

**E3. `ingest.ts`** (W01b)

```ts
export type AttachmentDeviceState = {
  id: string; orgId: string; isEphemeral: boolean;
  networkAttachmentEpoch: string | null; networkAttachmentSequence: number | null;
  networkAttachmentDigest: string | null;
};
export type AttachmentDeviceFields = {
  networkAttachmentEpoch: string; networkAttachmentSequence: number;
  networkAttachmentDigest: string; networkAttachmentsConfirmedAt: Date;
};
export type IngestIgnoreReason =
  | 'disabled' | 'ephemeral' | 'invalid_report' | 'stale_sequence' | 'capture_time_out_of_bounds';
export type IngestPlan =
  | { kind: 'ignore'; reason: IngestIgnoreReason }
  | { kind: 'confirm'; deviceFields: AttachmentDeviceFields }            // digest unchanged: no other write
  | { kind: 'apply'; deviceFields: AttachmentDeviceFields; report: NetworkAttachmentsReport; wanAddress: string | null };

export function attachmentDigest(report: NetworkAttachmentsReport, wanAddress: string | null): string;
// Pure. No database access.
export function planNetworkAttachmentIngest(
  device: AttachmentDeviceState, raw: unknown, wanAddress: string | null, now: Date): IngestPlan;
// Writes the membership change. Caller wraps it in withDbTransaction with the catch outside.
export async function applyNetworkAttachmentChange(
  device: { id: string; orgId: string },
  plan: Extract<IngestPlan, { kind: 'apply' }>, now: Date): Promise<void>;
```

The heartbeat merges `deviceFields` into its existing `deviceUpdates` object
(`routes/agents/heartbeat.ts:1213`) so the write at `:1760` carries them. On a failed `apply` the fields
are **not** merged, so the next heartbeat retries.

**E4. `maintenance.ts`** and `jobs/learnedNetworkMaintenance.ts` (W01b)

```ts
export async function refreshLearnedNetworkLastSeen(now: Date): Promise<{ gateways: number; networks: number; devices: number; wan: number }>;
export async function runLearnedNetworkRetention(now: Date): Promise<{ networksDeleted: number; deviceRowsDeleted: number }>;
```

**E5. `gate.ts`** (W03a)

```ts
export type GateProfile = {
  id: string; orgId: string; siteId: string; networkId: string | null;
  snmpGrantMode: 'unrestricted' | 'bound'; hasSavedSnmpSecrets: boolean;
};
export type GateDecision =
  | { kind: 'fail'; error: DiscoveryJobError }
  | { kind: 'unrestricted' }
  | { kind: 'guarded'; allowed: ExpectedGateway[] };          // every allowed fingerprint, not yet cut to 64
// Rows 1..6 of spec 8.2, in that order. Caller holds the shared site lock.
export async function evaluateDiscoveryGate(input: {
  orgId: string; siteId: string;
  profile: GateProfile | null;                                 // null: the AI tool
  job?: { orgId: string; siteId: string };                     // row 1
}): Promise<GateDecision>;
```

**E6. `eligibility.ts`** (W03a)

```ts
export type EligibleAgent = {
  deviceId: string; agentId: string; hostname: string | null; displayName: string | null;
  gatewayIds: string[];                                        // allowed fingerprints it is behind now
};
export async function loadEligibleGuardedAgents(input: {
  orgId: string; siteId: string; allowedGatewayIds: readonly string[];
  commandType: keyof typeof GUARDED_COMMAND_TYPES; limit?: number;
}): Promise<EligibleAgent[]>;
export async function explainGuardedAgent(input: {
  orgId: string; siteId: string; allowedGatewayIds: readonly string[];
  commandType: keyof typeof GUARDED_COMMAND_TYPES; deviceId?: string; agentId?: string;
}): Promise<{ eligible: true; agent: EligibleAgent } | { eligible: false; reason: IneligibleReason; label: string }>;
export async function explainNoEligibleAgent(input: {
  orgId: string; siteId: string; allowedGatewayIds: readonly string[];
  commandType: keyof typeof GUARDED_COMMAND_TYPES;
}): Promise<NoAgentReason>;
```

Eligible means: assigned to the site, online, not ephemeral, not parked, an `is_current` row for an
allowed fingerprint, `network_attachments_confirmed_at` inside the freshness window, and at or above
the guard version. Attachment is filtered in SQL; version is prefiltered in SQL and decided exactly
with `versionAtLeast`. The same function serves requested, pinned and AI-tool targets.

**E7. Minimum version** (W03a; W03c sets the value) in `services/commandMinVersion.ts`:

```ts
export const GUARDED_DISCOVERY_MIN_AGENT_VERSION = '999.0.0';
// COMMAND_MIN_AGENT_VERSION gains network_discovery_guarded
export function agentSupportsGuardedCommand(
  commandType: keyof typeof GUARDED_COMMAND_TYPES, agentVersion: string | null | undefined): boolean;
```

**E8. `scanCommand.ts`** (W03a): the only place either discovery command type is constructed.

```ts
export function buildDiscoveryScanCommand(input: {
  commandId: string;
  payload: Record<string, unknown>;                            // today's network_discovery payload
  decision: Extract<GateDecision, { kind: 'unrestricted' | 'guarded' }>;
  agentGatewayIds?: readonly string[];                         // ordering hint for the 64 cut
}): AgentCommand;
```

A contract test scans `apps/api/src` and fails when `'network_discovery'` or
`'network_discovery_guarded'` appears as a command `type` outside this file, and when a list that names
one command type omits the other without an entry in an explicit allowlist.

**E9. `attempt.ts`** (W03a)

```ts
export type NetworkDispatchRecord = {
  version: 1; mode: 'unrestricted' | 'guarded'; agentId: string; deviceId: string;
  allowedNetworkIds: string[]; allowedGatewayIds: string[]; decidedAt: string;
};
// One UPDATE: network_dispatch, agent_id, status 'running', started_at, WHERE status = 'scheduled'.
export async function recordDispatchAttempt(jobId: string, record: NetworkDispatchRecord): Promise<boolean>;
```

`processDispatchScan` order becomes: decide and load candidates (shared site lock) → find a connected
candidate → in one transaction take the shared site lock, re-evaluate the gate, and record the attempt
→ send → on a refusal or an unsent command, fail the job with its code. The AI tool has no job row; its
attempt record is the persisted command row, whose payload the server wrote.

**E10. `verify.ts`** (W03a)

```ts
export type VerifyOutcome =
  | { ok: true; networkId: string | null }                     // null: an accepted unrestricted result
  | { ok: false; error: DiscoveryJobError };                   // code 'network_unverified'
export async function verifyDiscoveryResult(input: {
  orgId: string; siteId: string; profileId: string | null;
  attempt: { mode: 'unrestricted' | 'guarded'; allowedGatewayIds: readonly string[] } | null;
  verifiedNetwork: unknown;
}): Promise<VerifyOutcome>;
```

A null attempt (a job dispatched before this shipped) is treated as unrestricted. Callers, all in
W03a: the direct result branch in `routes/agentWs.ts`, `handleDiscoveryResult` in
`services/commandResultHandlers.ts`, `processResults` in `jobs/discoveryWorker.ts` (again, in the
storing transaction), the adjacency admission in `routes/agents/topologyAdjacency.ts`, and the AI tool's
response in `services/aiToolsNetwork.ts`. `ProcessResultsJobData` gains `verifiedNetwork`.

**E11. `snmpGrants.ts`** (W03a reads; W03b writes)

```ts
// W03a
export async function loadUsableGrantGateways(input: {
  orgId: string; profileId: string; siteId: string; networkId: string | null;
}): Promise<ExpectedGateway[]>;
// W03b
export function profileWillHoldSnmpSecrets(next: SnmpSecretState): boolean;
export function isFullSnmpReentry(input: { existing: SnmpSecretState; incoming: SnmpSecretPatch }): boolean;
export async function freshGrantSet(input: { orgId: string; siteId: string; networkId: string | null }):
  Promise<{ mode: 'unrestricted' | 'bound'; gatewayIds: string[] }>;
export async function applySnmpGrantRulesOnSave(input: {
  orgId: string; profileId: string; siteId: string; networkId: string | null;
  fullReentry: boolean; suppliedAnySecret: boolean; willHoldSecrets: boolean; actorUserId: string;
}): Promise<void>;                                             // rule 1 (replace) or rule 4 (shrink)
export async function assertProfileNetworkAssignable(input: {
  orgId: string; siteId: string; networkId: string | null;
}): Promise<void>;                                             // throws a 400-mapped error
// W03b defines, W03c calls on every false -> true transition of the site flag
export async function bindUnrestrictedProfilesOnGating(input: {
  orgId: string; siteId: string; networkId: string; actorUserId: string;
}): Promise<number>;                                           // rule 2
```

**E12. `assignment.ts`, `merge.ts`, `suggestions.ts`, `list.ts`** (W03c)

```ts
export type AssignmentEffects = {
  gatesSite: boolean; profilesPointed: number; profilesFailingClosed: number; siteLosesLastNetwork: boolean;
  agents: { online: number; onNetwork: number; needUpdate: number };
  sharedVirtualRouterMac: boolean;
};
export async function previewAssignment(input: { orgId: string; networkId: string; siteId: string | null }): Promise<AssignmentEffects>;
export async function assignNetwork(input: { orgId: string; networkId: string; siteId: string; actorUserId: string }): Promise<void>;
export async function unassignNetwork(input: { orgId: string; networkId: string; actorUserId: string }): Promise<void>;
export async function stopRequiringNetwork(input: { orgId: string; siteId: string; actorUserId: string }): Promise<void>;
export async function mergeNetworks(input: {
  orgId: string; targetNetworkId: string; sourceNetworkId: string;
  mode: 'additional_gateway' | 'replaces_gateway'; retiredGatewayIds: readonly string[]; actorUserId: string;
}): Promise<void>;
```

### F. Routes (W03c) — `apps/api/src/routes/discoveryNetworks.ts`, mounted at `/discovery`

| Method and path | Permission | Body / notes |
|---|---|---|
| `GET /discovery/networks` | `devices:read` | query `orgId?`; response F1 |
| `PATCH /discovery/networks/:id` | `devices:write` + MFA | `{ name: string \| null }` |
| `POST /discovery/networks/:id/assign` | write + MFA, access to both sites | `{ siteId, confirmed?: boolean }`; without `confirmed`, when effects need it: `409 { code: 'CONFIRMATION_REQUIRED', effects }` |
| `POST /discovery/networks/:id/unassign` | write + MFA | `{ confirmed?: boolean }`, same 409 |
| `POST /discovery/networks/:id/ignore`, `/restore` | write + MFA | — |
| `POST /discovery/networks/:id/merge` | write + MFA | `{ sourceNetworkId, mode, retiredGatewayIds? }`; `replaces_gateway` requires at least one retired id belonging to the target |
| `POST /discovery/sites/:siteId/stop-requiring-network` | write + MFA | `{ confirmed: true }`; 409 while a network is assigned |

Every mutation writes an audit row with `writeRouteAudit`. Site-restricted users see networks assigned
to sites they can access, and unassigned networks on which a device they can access was seen (§8.5).

**F1. List response**

```json
{
  "data": [{
    "id": "uuid", "name": null, "displayName": "192.168.1.0/24 via 192.168.1.1", "prefix": "192.168.1.0/24",
    "state": "needs_review",
    "siteId": null, "siteName": null, "assignedAt": null,
    "gateways": [{ "id": "uuid", "address": "192.168.1.1", "mac": "a4:2b:b0:11:22:9c",
                   "sharedVirtualRouterMac": false, "firstSeenAt": "iso", "lastSeenAt": "iso" }],
    "wanAddresses": [{ "address": "203.0.113.20", "firstSeenAt": "iso", "lastSeenAt": "iso" }],
    "devices": { "recentCount": 5, "currentCount": 3,
                 "bySite": [{ "siteId": "uuid", "siteName": "Main Office", "count": 4 }],
                 "sample": [{ "deviceId": "uuid", "hostname": "LAPTOP-JS" }] },
    "profileCount": 0,
    "suggestion": { "siteId": "uuid", "siteName": "Main Office", "reason": "declared_prefix" },
    "replacementFor": null,
    "firstSeenAt": "iso", "lastSeenAt": "iso"
  }],
  "sites": [{ "siteId": "uuid", "siteName": "Main Office", "networkRequired": true, "assignedNetworkCount": 1 }],
  "limitReached": false
}
```

`state` is `needs_review`, `assigned` or `ignored`. `suggestion.reason` is `declared_prefix` or
`site_devices`. `devices.sample` holds at most 5. A gateway vendor name is shown only if an OUI lookup
already exists in the API or web; this feature does not add an OUI database.

**F2. Read-side fields added in W04** (with the web that consumes them): profiles gain `networkId`,
`snmpGrantMode`, `snmpGrantNetworks: [{ networkId, name }]` and the site's `networkRequired`; jobs gain
`networkId`, `networkName`, `crossNetworkAssetUpdates` and `errors` as `DiscoveryJobError`; assets gain
`seenOnAssignedNetwork: boolean`. Profile create and update accept `networkId` (W03b).

### G. Web (W04) — `apps/web/src/components/discovery/`

- `DISCOVERY_TABS` gains `'networks'` (`DiscoveryPage.tsx:29`); new `LearnedNetworksPanel.tsx` and
  `learnedNetworkTypes.ts` (the F1 mapper).
- `DiscoveryProfileForm.tsx`: a Network select when the chosen site is gated; the scan-agent picker
  marks agents not on an allowed network; a notice names the networks saved credentials are bound to.
- `DiscoveryProfileList.tsx`: the "no assigned network" notice for a site that is not gated (§9).
- `DiscoveryJobList.tsx`: network column, the cross-network count, and one sentence with a next step
  per `DiscoveryGateFailureCode`. `mapJob` (`:94`) keeps `code` and `reason`.
- `DiscoveredAssetList.tsx`: the client-side filter "Not seen on an assigned network".
- Locale namespace `discovery`, groups `learnedNetworks`, `discoveryProfileForm.network`,
  `discoveryJobList.failures`.

### H. Other producers (W06)

| Producer | Selection today | Guarded command | "No eligible agent" on a gated site |
|---|---|---|---|
| SNMP polling | inline in `loadPollDispatchInputs` (`jobs/snmpWorker.ts:363`) | `snmp_poll_guarded` | not checked: reason `no_agent_on_network`, no failure count, status not set to offline |
| Network monitors | `selectNetworkExecutor` (`services/networkExecutorSelection.ts:52`), also used by `POST /monitors/:id/test` | `network_*_guarded` | not checked: `last_status` `unknown`, `last_error` `no_agent_on_network`, no result row, alert rules neither raised nor resolved |
| Asset "Check now" | `selectNetworkExecutor` via `runAssetProbe` (`services/assetProbeRun.ts:42`) | `network_ping_guarded` | `409 NO_AGENT_ON_NETWORK`, nothing written |

- A guarded result carries `verifiedNetwork` and is accepted only if that fingerprint was allowed at
  send time and is still assigned to the site. Otherwise it is discarded as not checked.
- An agent refusal (`network_mismatch`, `network_changed`) is **not checked**, never offline, failed or
  not responding. `normalizeMonitorStatus` must not turn it into `offline`.
- Polling credentials are not granted per fingerprint (§13 item 13).
- `GUARDED_COMMAND_TYPES` and `COMMAND_MIN_AGENT_VERSION` gain the five types;
  `GUARDED_PROBES_MIN_AGENT_VERSION` starts at `999.0.0` and W06b sets it.

---

## Code map

Where the work lands. Line numbers are from `2dc66103b6`; open the file before relying on one.

**API: heartbeat** — `routes/agents/heartbeat.ts`: route `:621`; parked devices return at `:700`; own
row selected for update `:865` (`selectOwnDeviceRowForUpdate`, full row, includes `isEphemeral`); the
watchdog branch returns at `:1201`, so ingest sits after `:1211`; `deviceUpdates` `:1213`; the write
`:1760`; the savepoint-with-catch-outside exemplar `:2453-2463`. Schema `routes/agents/schemas.ts:208`.
Client address: `getTrustedClientIpOrUndefined(c)` (`services/clientIp.ts:359`). WebSocket heartbeat
schema: `routes/agentWs.ts:937`.

**API: discovery dispatch** — `jobs/discoveryWorker.ts`: `loadDispatchScanInputs` `:686`,
`processDispatchScan` `:766`, command built `:837-856`, send `:859`, running write `:879-889`,
`markJobFailed` `:1911`, `processResults` `:1011`, `enqueueDiscoveryResults` `:2011`.
`jobs/discoveryAgentSelection.ts`: `rankDiscoveryAgentCandidates` `:50`,
`loadSiteDiscoveryAgentCandidates` `:77`, `resolvePinnedDiscoveryAgent` `:138`. Every worker producer
(run now, schedules, the lost-dispatch sweep, baseline scans) reaches the send through
`loadDispatchScanInputs`.

**API: AI tool** — `services/aiToolsNetwork.ts:940-980`; it calls `aiExecuteCommand`, which inserts the
`device_commands` row before sending and returns the result to the caller.

**API: results** — `routes/agentWs.ts` discovery branch `:1868-1980`;
`services/commandResultHandlers.ts:120` (`handleDiscoveryResult`, registered `:1323`);
`routes/agents/topologyAdjacency.ts:32-70`; job errors are written at `discoveryWorker.ts:427`, `:1921`,
`:2128`, `agentWs.ts:1920`, `:1956`, `:1970`, `commandResultHandlers.ts:179`, `:200`,
`routes/discovery.ts:1073`.

**API: profiles and secrets** — `routes/discovery.ts`: create `:651` (`createProfileSchema` `:402`),
update `:770` (`updateProfileSchema` `:425`), the retained-secret rejection `:818-843`, list picks
`:624-645`, jobs list `:1103-1246`, assets list `:1372-1491`. `services/snmpSecrets.ts`: mask `:4`,
`isMaskedSnmpSecret` `:22`, merge helpers `:54` and `:90`, `subnetChangeWouldRetainSnmpSecrets` `:196`.
Route helpers: `requireDiscoveryRead/Write/Execute` `:67-78`, `canAccessRecordSite` `:249`,
`authorizeRequestedSite` `:266`, `writeRouteAudit` exemplar `:1091`. Declared ranges:
`services/topology/siteNetworkDeclarations.ts`.

**API: lock precedents** — advisory: `services/discoveryJobCreation.ts:22`. Row lock on a profile-like
row: `jobs/networkBaselineWorker.ts:234`.

**API: workers** — retention exemplar `jobs/agentLogRetention.ts`; flags `config/env.ts:12` (`envFlag`).

**Agent** — registry `internal/heartbeat/handlers.go:18`; unknown type `heartbeat.go:8258`; type
constants `internal/remote/tools/types.go:184`; `handleNetworkDiscovery`
`internal/heartbeat/handlers_network.go:38` (SNMP pass `:66-72`, adjacency post `:81-119`);
`internal/discovery/scanner.go` (`ScanConfig` `:15`, `Scan` `:104-213`); probes `arp.go` (cgo only),
`ping.go:28`, `ports.go:20`, `snmp.go:19`, `adjacency_collection.go:480`, `arpcache.go:21`; SNMP client
`internal/snmppoll/client.go:48-108`; readers `internal/collectors/networkcontext` (`Reader`
`types.go:146`, `LookupRoute` by type assertion as in `internal/networkdiagnostic/native.go:30-37`,
`WatchChanges` per OS, interface kinds `interfacekind.go`); state-file exemplar
`networkcontext/state.go:60-195` and `internal/atomicrename`; error codes
`internal/wire/errorcodes.go:22`; release build matrix `.github/workflows/release.yml:221-247`; monitor
handlers `internal/heartbeat/handlers_monitor.go`; SNMP poll handler `handlers_network.go:353`.

**Web** — `components/discovery/DiscoveryPage.tsx` (tabs `:29`, labels `:393`, hash read `:291`, hash
write `:707`, request body `:531-546`, `formInitialValues` `:458-488`, `mapProfileToDisplay` `:278`);
`DiscoveryProfileForm.tsx`; `DiscoveryProfileList.tsx`; `DiscoveryJobList.tsx` (`mapJob` `:94`, errors
`:135`, columns `:476-527`); `DiscoveredAssetList.tsx` (`mapAsset` `:167`, filters `:268-340`);
locales `apps/web/src/locales/<code>/discovery.json`; tests beside each component, fetch mocked as in
`DiscoveryPage.test.tsx:9-11`. Docs: `apps/docs/src/content/docs/features/discovery.mdx`. Release
notes: `docs/release-notes/next-release-draft.md` (rebase just before enqueueing; it conflicts often).

**Other producers** — `jobs/snmpWorker.ts` (`loadPollDispatchInputs` `:363`, `buildSnmpPollCommand`
`:796`, failure reasons `:66-119`); `jobs/monitorWorker.ts` (`loadCheckMonitorInputs` `:201`,
`recordMonitorCheckResult` `:457`); `services/monitorCommands.ts:15-22`;
`services/networkExecutorSelection.ts`; `services/assetProbeRun.ts`; `routes/monitors.ts:504-589`;
result branches `routes/agentWs.ts:1540-1706`; `services/alertConditions/handlers/networkCheck.ts:47`
(`dataAvailable` is the existing "could not observe" channel).

---

## Traceability

Every proof §14 requires and every credential sequence in §15, with the wave and test that carries it.
Integration test files are under `apps/api/src/__tests__/integration/`.

| # | Requirement | Wave | Test file › name |
|---|---|---|---|
| P1 | Gated site with no eligible agent sends no command | W03a | `discoveryNetworkGate.integration.test.ts` › gated site with no eligible agent sends no command |
| P2 | A refusal arriving right after the send is recorded with its code | W03a | same › refusal that arrives right after the send is recorded with its code |
| P3 | An assignment change racing a dispatch lets nothing through that the new state does not allow | W03c | `learnedNetworkAssignment.integration.test.ts` › assignment change racing a dispatch |
| P4 | Each credential sequence, as "the secrets are not sent" | W03a–c | rows S1 to T7 |
| P5 | An old or unknown-version agent at a site that is not gated still scans, through both producers | W03a | `discoveryNetworkGate.integration.test.ts` › ungated site: worker scan unchanged; › ungated site: AI tool scan unchanged |
| P6 | Cross-tenant forge per table as `breeze_app`; cross-org reference per composite FK | W01a | `learnedNetworksTenancy.integration.test.ts` |
| P7 | Cascade, merge and export-policy contract suites | W01a | existing suites, green |
| P8 | No added write for an unchanged report | W01b | `learnedNetworksIngest.integration.test.ts` › unchanged report adds no write beyond the heartbeat's own |
| P9 | Go tests for select, prove, bind, watch, re-prove per OS | W02b, W02c | `gatewayproof`, `netguard`, `discovery` package tests |
| P10 | Lab run: two networks, one range, two routers | W05 | `evidence/2026-11-21-learned-networks-lab-proof.md` |
| S1 | Un-gate, then assign a different network | W03c | `learnedNetworkAssignment…` › S1 bound profile stays bound across un-gate and re-assign |
| S2 | Credentialed profile created on a gated site with no network, then un-gate | W03c | same › S2 bound with no grants never becomes unrestricted |
| S3 | One new secret supplied, another kept masked | W03b | `discoverySnmpGrants.integration.test.ts` › S3 partial entry grants nothing |
| S4 | Two concurrent saves, one masked and one moving the profile | W03b | same › S4 concurrent saves never pair one save's secrets with another's grants |
| S5 | Secrets re-entered on a profile pointed at a new network | W03b | same › S5 grants come from the profile as saved |
| S6 | An agent behind a newly merged gateway of the same network | W03a, W03c | `discoveryNetworkGate…` › S6 eligibility matches the fingerprint; `learnedNetworkAssignment…` › S6 merged gateway is not granted |
| S7 | A replacement merge after an additional-gateway merge | W03c | same › S7 only named fingerprints are retired |
| S8 | Org merge with one fingerprint under two ids | W01a | `learnedNetworksOrgMerge.integration.test.ts` › S8 grant re-points only to the identical fingerprint |
| S9 | Failure code when the last network is unassigned | W03a | `gate.test.ts` › S9 evaluation order decides the code |
| T1 | Partial rotation while narrowed (rule 4) | W03b | `discoverySnmpGrants…` › T1 partial rotation shrinks grants |
| T2a | Profile pointed at a network that is not its site's | W03b | same › T2a save rejects a network not assigned to the profile's site |
| T2b | Rule 2 restricted to the profile's `network_id` | W03c | `learnedNetworkAssignment…` › T2b gating binds only to the profile's network |
| T3 | "Full re-entry" as its own predicate | W03b | `snmpGrants.test.ts` › T3 full re-entry table |
| T4 | One lock order | W03b, W03c | `discoverySnmpGrants…` › T4 opposing moves do not deadlock; `learnedNetworkAssignment…` › T4 assign against save |
| T5 | Gated site holding an unrestricted credentialed profile (row 3a) | W03a | `gate.test.ts` › T5 row 3a fails closed |
| T6 | Org merge that splits one network across two | W01a | `learnedNetworksOrgMerge…` › T6 split network is kept unassigned |
| T7 | Device behind two gateways of one network | W01a, W01b | `learnedNetworksTenancy…` › T7 two rows per device; `learnedNetworksIngest…` › T7 both memberships current |
