---
tracking_issue: LanternOps/breeze#6854
---
# Hardware & RAID Monitoring — Plan Index

**Spec:** `docs/superpowers/specs/monitoring/2026-09-23-hardware-raid-monitoring-design.md`
(approved 2026-09-23; two Codex `gpt-6-astra` xhigh passes folded in, §16).

One plan document per wave. Each wave is one PR on its own branch
`feature/<parent#>-hardware-monitoring/wave-<sub-issue#>` with `Closes #<sub-issue#>` in the PR
body. State lives on GitHub (feature-lifecycle); the wave issue is the source of truth for status,
never this index.

| Wave | Plan | Depends on | Ships |
|---|---|---|---|
| W01 | [API contract: tables, ingest, events, rollup, retention, GET route, AI tool, config feature](2026-09-23-hardware-monitoring-w01-api-contract.md) | — | ingest live (nothing sends yet); policy tab visible |
| W02a | [Agent core: package, runner, scheduler, breaker, payload, config; storcli/perccli, mdadm, Storage Spaces, Windows disks, smartctl](2026-09-23-hardware-monitoring-w02a-agent-core.md) | W01 | agent release (data flows, no alerts) |
| W02b | [Agent sources: MegaCli, ssacli, arcconf, omreport, zfs, precedence, `tool_dirs`](2026-09-23-hardware-monitoring-w02b-agent-sources.md) | W02a | agent release |
| W03 | [Alerting: `subject_key`, per-subject sweep, `hardware_health` kind + handler, built-ins v3, editor fields](2026-09-23-hardware-monitoring-w03-alerting.md) | W01 | alerts fire once monitors are attached |
| W04 | [Web + docs: Storage & RAID section, device-list column/filter, docs page, e2e](2026-09-23-hardware-monitoring-w04-web-docs.md) | W01, W03 | tech-visible surface |
| W05 | [BMC in-band: `bmc` source, `agent_report` link, linker gates, Management controller card](2026-09-23-hardware-monitoring-w05-bmc-inband.md) | W01, W02a, W04 | agent release |
| W06 | [Lab proof + release note](2026-09-23-hardware-monitoring-w06-lab-proof.md) | all | feature closes |

W02a and W03 run in parallel after W01. W02b stacks on W02a (dispatch CI per branch: `gh workflow
run CI --ref <branch>`). W04 needs W03's kind for the editor fields and W01's GET route. W05 needs
W02a's package and W04's Hardware tab. W06 is the exit gate.

## Migration slots reserved

Newest committed migration on 2026-09-23: `2026-10-26-160100-ai-operator-inline-target-backfill.sql`.
This feature uses `2026-10-27-1000xx`. Every executor re-checks `ls apps/api/migrations | sort |
tail -1` before committing and renames upward if `origin/main` has moved past these names.

| File | Wave | DML? |
|---|---|---|
| `2026-10-27-100000-hardware-health-tables.sql` | W01 | no — 4 enums, 3 tables, composite FKs, RLS, indexes |
| `2026-10-27-100100-hardware-monitoring-config-feature.sql` | W01 | no — `ALTER TYPE config_feature_type ADD VALUE IF NOT EXISTS 'hardware_monitoring'`, `config_policy_hardware_monitoring_settings`, parent-chain RLS |
| `2026-10-27-100200-monitor-kind-hardware-health.sql` | W03 | no — `ALTER TYPE monitor_kind ADD VALUE IF NOT EXISTS 'hardware_health'` only |
| `2026-10-27-100300-alert-subject-key.sql` | W03 | **yes** — `SELECT set_config('breeze.scope','system',true);` first; `subject_key` column + CHECK; dedupe of NULL-subject duplicate open alerts with `RAISE WARNING` count; partial unique index |
| `2026-10-27-100400-discovered-asset-link-source-agent-report.sql` | W05 | no — `ALTER TYPE discovered_asset_link_source ADD VALUE IF NOT EXISTS 'agent_report'` only |

Enum `ADD VALUE` files never write a row using the new label (pattern:
`2026-10-16-181300-monitor-coverage-kinds.sql`). Drizzle enum arrays list labels in database order
(new labels appended). Every file is idempotent and has no inner `BEGIN`/`COMMIT`.

## Global constraints (from the spec; every task inherits these)

- Tenancy: the three `device_hardware_*` tables are shape 5 with a denormalized `org_id`,
  composite FK `(device_id, org_id) → devices(id, org_id)` **`DEFERRABLE INITIALLY IMMEDIATE`**,
  RLS enabled + forced, four `breeze_has_org_access(org_id)` policies. Template:
  `apps/api/migrations/2026-09-28-100000-agent-health-observations.sql` (but `INITIALLY IMMEDIATE`).
- Registrations per new `org_id` table (grep, do not judge): `CORE_ORG_CASCADE_DELETE_ORDER`
  (`services/tenantCascade.ts:230`, alphabetical, `organizations` last),
  `CORE_DEVICE_CASCADE_DELETE_TABLES` (`routes/devices/core.ts:514`),
  `CORE_DEVICE_ORG_DENORMALIZED_TABLES` (`routes/devices/core.ts:285`), `REPOINT_TABLES`
  (`services/orgMergeRegistry.ts:655`), `CORE_TENANT_EXPORT_POLICY`
  (`services/tenantExportPolicyRegistry.ts:41`, every column classified; every jsonb column
  `excludedOpen`). `alerts.subject_key` is a new column on a registered table → its export-policy
  entry gains `subject_key` under `included`.
- Any migration that writes rows elects system scope first (`migrationRlsScope.test.ts` baseline
  must not grow).
- Agent code ships to customer machines: `go test -race ./...`, fixture-driven parser tests, a
  native Windows run on VM `.55` for W02a/W02b/W05 (cross-compile has missed test bugs before).
- Web: `fetchWithAuth` from `apps/web/src/stores/auth.ts`; no react-query; inline pill idiom
  (`bg-success/15 text-success border-success/30` etc.); `data-testid` on everything e2e touches;
  mutation handlers via `runAction` (only the config tab mutates).
- MCP coverage: every new route file needs an `MCP_COVERAGE` entry (`services/mcpCoverage.ts`);
  agent ingest is `{ exempt: 'agent_transport' }`, operator routes list their tools.
- Config feature parity: adding `'hardware_monitoring'` to `CONFIG_FEATURE_TYPES` fails
  `apps/api/src/services/policyBaselineDefaults.test.ts`,
  `apps/web/src/components/configurationPolicies/featureTabs/featureTypeParity.test.ts` and
  `apps/web/src/components/devices/DeviceEffectiveConfigTab.featureParity.test.ts` until the enum,
  the tab and the Effective Config entry all exist — all in W01.
- Files stay under ~500 lines; new code goes in new files next to the pattern it copies.
- Run the contract suites before every PR that touches tenancy:
  `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage`, the integration
  config (`vitest.integration.config.ts`) for cascade / export / merge, with `pnpm test-stack up`.

## Review focus (spec-implied inputs no single task's tests would otherwise exercise)

1. A controller that reports 60+ drives in one `show all J` (≈ 1 MB JSON) — parser must stream/cap
   without truncating mid-object; W02a storcli test carries a 64-drive fixture.
2. Two snapshots for the same device arriving concurrently after an agent restart (sequence reset)
   — ingest must serialize on the health row and apply the 1 h reset rule; W01 ingest test.
3. A disk that flips `failed → online → failed` across three polls — no alert must fire at
   `consecutiveSnapshots = 2` and no recovery must resolve; W03 handler test.
4. Two physical disks failing in the same sweep on the same device — exactly one automation run,
   two notifications; W03 integration test.
5. A vendor CLI that hangs forever (MegaCli on a dead controller) — cycle budget cancels it, the
   source reports `failed`, other sources still run, and after three cycles the breaker opens;
   W02a scheduler + breaker tests.

---

## Cross-wave contract (defined in W01 unless noted; consumed verbatim by later waves)

### A. Enums and tables — `apps/api/src/db/schema/hardwareHealth.ts` (new file, exported from `schema/index.ts`)

```ts
export const hardwareComponentTypeEnum = pgEnum('hardware_component_type', [
  'controller', 'virtual_disk', 'physical_disk', 'cache_battery', 'enclosure', 'bmc', 'collector',
]);
export const hardwareSourceEnum = pgEnum('hardware_source', [
  'storcli', 'perccli', 'megacli', 'ssacli', 'arcconf', 'omreport', 'mdadm', 'zfs',
  'storage_spaces', 'windows_physical_disk', 'smartctl', 'ipmi', 'racadm', 'hponcfg',
  'redfish', 'snmp',
]);
export const hardwareHealthEnum = pgEnum('hardware_health', ['ok', 'warning', 'critical', 'unknown']);
export const hardwareEventTypeEnum = pgEnum('hardware_event_type', [
  'first_seen', 'health_changed', 'state_changed', 'disk_replaced',
  'predictive_failure_set', 'predictive_failure_cleared', 'stale', 'removed',
]);
```

**`deviceHardwareComponents` → `device_hardware_components`**

| column | type | notes |
|---|---|---|
| `id` | uuid pk default gen_random_uuid() | |
| `device_id` | uuid not null | FK part |
| `org_id` | uuid not null | FK part, RLS |
| `component_key` | text not null | UNIQUE with `device_id`; ≤ 200 chars enforced by zod |
| `component_type` | hardware_component_type not null | |
| `parent_key` | text null | |
| `source` | hardware_source not null | |
| `name` | text not null | |
| `model`, `serial`, `firmware` | text null | |
| `size_bytes` | bigint null | |
| `health` | hardware_health not null default 'unknown' | server-derived |
| `state` | text not null | validated against `HARDWARE_STATES[component_type]` |
| `state_detail` | text null | |
| `progress_percent` | smallint null | 0–100 |
| `temperature_c` | smallint null | |
| `predictive_failure` | boolean not null default false | |
| `alert_exempt` | boolean not null default false | |
| `attributes` | jsonb not null default '{}' | ≤ 8 KB, `excludedOpen` |
| `unhealthy_streak`, `critical_streak`, `healthy_streak`, `below_critical_streak`, `predictive_streak` | integer not null default 0 | §7.2 |
| `stale` | boolean not null default false | |
| `stale_since` | timestamptz null | |
| `first_seen_at`, `last_seen_at` | timestamptz not null | server receipt time |
| `created_at`, `updated_at` | timestamptz not null default now() | |

Indexes: `device_hardware_components_device_key_uidx UNIQUE (device_id, component_key)`;
`device_hardware_components_device_type_idx (device_id, component_type) WHERE NOT stale`;
`device_hardware_components_org_health_idx (org_id, health) WHERE NOT stale AND health IN ('warning','critical')`;
`device_hardware_components_stale_idx (stale_since) WHERE stale`.

**`deviceHardwareEvents` → `device_hardware_events`**: `id`, `device_id`, `org_id`, `component_key
text`, `component_type hardware_component_type`, `event_type hardware_event_type`, `from_health` /
`to_health hardware_health null`, `from_state` / `to_state text null`, `detail jsonb not null default
'{}'` (`excludedOpen`), `snapshot_id uuid null`, `occurred_at timestamptz not null` (agent
`collectedAt`), `created_at`. Index `(device_id, occurred_at desc)`, `(occurred_at)` for the reaper.

**`deviceHardwareHealth` → `device_hardware_health`**: `device_id uuid pk`, `org_id`, `health
hardware_health not null default 'unknown'`, `collector_health hardware_health not null default
'ok'`, `summary jsonb not null default '{}'` (`excludedOpen`), `sources jsonb not null default '[]'`
(`excludedOpen`), `last_agent_sequence bigint not null default 0`, `last_snapshot_id uuid null`,
`last_collected_at timestamptz null`, `last_received_at timestamptz null`, `last_raid_received_at
timestamptz null`, `last_disk_received_at timestamptz null`, `poll_interval_minutes integer null`,
`disk_health_interval_minutes integer null`, `tiers_run text[] not null default '{}'`,
`agent_version text null`, `created_at`, `updated_at`. Index `(org_id, health)`.

**`configPolicyHardwareMonitoringSettings` → `config_policy_hardware_monitoring_settings`** (lives
in `db/schema/configurationPolicies.ts` next to `configPolicyEventLogSettings`): `id uuid pk`,
`feature_link_id uuid not null unique references config_policy_feature_links(id) on delete cascade`,
`enabled boolean not null default true`, `poll_interval_minutes integer not null default 10 CHECK
(between 5 and 60)`, `disk_health_interval_minutes integer not null default 60 CHECK (between 15
and 1440)`, `created_at`, `updated_at`. Parent-chain RLS exactly as
`2026-07-26-a-normalized-policy-tenant-integrity.sql` (~302) does for the event-log table;
`PARENT_FK_JOIN_POLICY_TABLES` entry `['config_policy_hardware_monitoring_settings', ['configuration_policies']]`
in `rls-coverage.integration.test.ts` (~920). No `org_id` → not in the cascade / export / merge lists.

### B. Shared constants, types, validators — `packages/shared/src/`

`constants/hardwareHealth.ts` (new; pure leaf module, exported from the package barrel):

```ts
export const HARDWARE_COMPONENT_TYPES = ['controller','virtual_disk','physical_disk','cache_battery','enclosure','bmc','collector'] as const;
export type HardwareComponentType = (typeof HARDWARE_COMPONENT_TYPES)[number];
export const AGENT_REPORTABLE_COMPONENT_TYPES = ['controller','virtual_disk','physical_disk','cache_battery','enclosure','bmc'] as const; // never 'collector'
export const HARDWARE_SOURCES = ['storcli','perccli','megacli','ssacli','arcconf','omreport','mdadm','zfs','storage_spaces','windows_physical_disk','smartctl','ipmi','racadm','hponcfg','redfish','snmp'] as const;
export type HardwareSource = (typeof HARDWARE_SOURCES)[number];
export const RAID_TIER_SOURCES = ['storcli','perccli','megacli','ssacli','arcconf','omreport','mdadm','zfs','storage_spaces','ipmi','racadm','hponcfg'] as const;
export const DISK_TIER_SOURCES = ['windows_physical_disk','smartctl'] as const;
export const HARDWARE_HEALTH_LEVELS = ['ok','warning','critical','unknown'] as const;
export type HardwareHealth = (typeof HARDWARE_HEALTH_LEVELS)[number];
export const HARDWARE_HEALTH_RANK: Record<HardwareHealth, number> = { unknown: 0, ok: 1, warning: 2, critical: 3 };
export const HARDWARE_SOURCE_STATUSES = ['ok','unavailable','superseded','failed','backing_off','disabled'] as const;
export type HardwareSourceStatus = (typeof HARDWARE_SOURCE_STATUSES)[number];
export const HARDWARE_TIERS = ['raid','disk','none','disabled'] as const;
export const HARDWARE_STATES: Record<HardwareComponentType, readonly string[]> = {
  controller:    ['ok','degraded','failed','unknown'],
  virtual_disk:  ['optimal','rebuilding','initializing','checking','migrating','degraded','partially_degraded','failed','offline','unknown'],
  physical_disk: ['online','hotspare','ready','jbod','unconfigured','rebuilding','copyback','foreign','shielded','predictive_failure','degraded','failed','missing','offline','unknown'],
  cache_battery: ['ok','charging','learning','degraded','failed','missing','unknown'],
  enclosure:     ['ok','degraded','failed','unknown'],
  bmc:           ['ok','unknown'],
  collector:     ['ok','failed','backing_off'],
};
/** Spec §4.3: f(state) only; flags are applied by deriveHardwareHealth(). */
export const HARDWARE_STATE_HEALTH: Record<HardwareComponentType, Record<string, HardwareHealth>> = { /* one entry per state above, exactly the §4.3 table */ };
export function deriveHardwareHealth(input: {
  componentType: HardwareComponentType; state: string; predictiveFailure: boolean;
  memberErrors?: boolean;          // mdadm/zfs member with read/write/cksum > 0
  osHealthStatus?: 'healthy' | 'warning' | 'unhealthy' | null; // Windows HealthStatus
  smartPassed?: boolean | null;    // smartctl smart_status.passed
}): HardwareHealth;                // f(state), then raise-only flags per §4.3; never lowers
export function worstHardwareHealth(values: readonly HardwareHealth[]): HardwareHealth; // by rank; 'unknown' when empty
```

`validators/hardwareHealth.ts` (new):

```ts
export const hardwareComponentReportSchema = z.object({
  componentKey: z.string().min(1).max(200),
  componentType: z.enum(AGENT_REPORTABLE_COMPONENT_TYPES),
  parentKey: z.string().max(200).nullable().optional(),
  source: z.enum(HARDWARE_SOURCES),
  name: z.string().min(1).max(200),
  model: z.string().max(200).nullable().optional(),
  serial: z.string().max(200).nullable().optional(),
  firmware: z.string().max(100).nullable().optional(),
  sizeBytes: z.number().int().nonnegative().nullable().optional(),
  state: z.string().min(1).max(40),            // cross-checked against HARDWARE_STATES in ingest → 422
  stateDetail: z.string().max(200).nullable().optional(),
  progressPercent: z.number().int().min(0).max(100).nullable().optional(),
  temperatureC: z.number().int().min(-50).max(200).nullable().optional(),
  predictiveFailure: z.boolean().default(false),
  alertExempt: z.boolean().default(false),
  memberErrors: z.boolean().optional(),
  osHealthStatus: z.enum(['healthy','warning','unhealthy']).nullable().optional(),
  smartPassed: z.boolean().nullable().optional(),
  attributes: z.record(z.unknown()).default({}),  // ≤ 8 KB serialized → 422
});
export const hardwareSourceReportSchema = z.object({
  source: z.enum(HARDWARE_SOURCES),
  status: z.enum(HARDWARE_SOURCE_STATUSES),
  complete: z.boolean().optional(),               // required when status === 'ok' (refine)
  toolVersion: z.string().max(100).optional(),
  path: z.string().max(500).optional(),
  durationMs: z.number().int().nonnegative().optional(),
  error: z.string().max(500).optional(),
  retryAt: z.string().datetime().optional(),
  warnings: z.array(z.string().max(500)).max(50).optional(),
});
export const hardwareHealthSnapshotSchema = z.object({
  snapshotId: z.string().uuid(),
  sequence: z.number().int().nonnegative(),
  collectedAt: z.string().datetime(),
  agentVersion: z.string().max(50),
  pollIntervalMinutes: z.number().int().min(5).max(60),
  diskHealthIntervalMinutes: z.number().int().min(15).max(1440),
  tiersRun: z.array(z.enum(HARDWARE_TIERS)).min(1),
  sources: z.array(hardwareSourceReportSchema).max(32),
  components: z.array(hardwareComponentReportSchema).max(2000),
});
export type HardwareHealthSnapshot = z.infer<typeof hardwareHealthSnapshotSchema>;
export type HardwareComponentReport = z.infer<typeof hardwareComponentReportSchema>;
export type HardwareSourceReport = z.infer<typeof hardwareSourceReportSchema>;

export const hardwareMonitoringInlineSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  pollIntervalMinutes: z.number().int().min(5).max(60).default(10),
  diskHealthIntervalMinutes: z.number().int().min(15).max(1440).default(60),
});
export type HardwareMonitoringInlineSettings = z.infer<typeof hardwareMonitoringInlineSettingsSchema>;
export const HARDWARE_MONITORING_DEFAULTS: HardwareMonitoringInlineSettings = { enabled: true, pollIntervalMinutes: 10, diskHealthIntervalMinutes: 60 };
```

`validators/monitors.ts` (W03): `'hardware_health'` appended to `MONITOR_KINDS` (NOT to
`SERVER_EVALUATED_MONITOR_KINDS`), and in `leafConditionSchemas`:

```ts
hardware_health: z.object({
  componentTypes: z.array(z.enum(['controller','virtual_disk','physical_disk','cache_battery','enclosure','collector'])).min(1),
  minHealth: z.enum(['warning','critical']),
  includePredictiveFailure: z.boolean().default(true),
  consecutiveSnapshots: z.number().int().min(1).max(10).default(2),
}),
```

`constants/configFeatureTypes.ts` (W01): `'hardware_monitoring'` appended to `CONFIG_FEATURE_TYPES`
with a comment; not in `ORG_SCOPED_ONLY_FEATURE_TYPES`.

### C. Agent wire contract

**`PUT /api/v1/agents/:agentId/hardware-health`** — `routes/agents/hardwareHealth.ts`
(`hardwareHealthRoutes`, mounted `agentRoutes.route('/', hardwareHealthRoutes)` in
`routes/agents/index.ts`; `hardwareHealthRoutes.use('*', requireAgentRole)`; `bodyLimit` 2 MB;
`zValidator('json', hardwareHealthSnapshotSchema)`; device resolved by `agentId` exactly as
`inventory.ts:35-50`). Body = `HardwareHealthSnapshot` (§B). Responses: `200 { accepted: true,
events: n }`, `409 { error: 'stale_snapshot' }`, `413`, `422 { error: 'invalid_snapshot', path }`.
`MCP_COVERAGE`: `'agents/hardwareHealth.ts': { exempt: 'agent_transport' }`.

**Heartbeat config key** (W01 server side, W02a agent side): `policyConfigUpdate.hardware_monitoring_settings`
= `{ enabled: boolean, poll_interval_minutes: number, disk_health_interval_minutes: number }`
(snake_case inside, like `event_log_settings`). The agent accepts `hardware_monitoring_settings`
or `hardwareMonitoringSettings` and snake/camel inner keys (`applyEventLogConfig` pattern,
`heartbeat.go:3093`).

**Go types** — `agent/internal/collectors/hwhealth/types.go` (W02a); JSON tags are the camelCase
names from §B exactly:

```go
type Kind string          // "storcli", "perccli", … (values of HARDWARE_SOURCES)
type Tier string          // "raid" | "disk"
type ComponentType string // "controller" | "virtual_disk" | "physical_disk" | "cache_battery" | "enclosure" | "bmc"
type SourceStatus string  // "ok" | "unavailable" | "superseded" | "failed" | "backing_off" | "disabled"

type Component struct {
    ComponentKey      string            `json:"componentKey"`
    ComponentType     ComponentType     `json:"componentType"`
    ParentKey         *string           `json:"parentKey,omitempty"`
    Source            Kind              `json:"source"`
    Name              string            `json:"name"`
    Model             *string           `json:"model,omitempty"`
    Serial            *string           `json:"serial,omitempty"`
    Firmware          *string           `json:"firmware,omitempty"`
    SizeBytes         *int64            `json:"sizeBytes,omitempty"`
    State             string            `json:"state"`
    StateDetail       *string           `json:"stateDetail,omitempty"`
    ProgressPercent   *int              `json:"progressPercent,omitempty"`
    TemperatureC      *int              `json:"temperatureC,omitempty"`
    PredictiveFailure bool              `json:"predictiveFailure"`
    AlertExempt       bool              `json:"alertExempt"`
    MemberErrors      *bool             `json:"memberErrors,omitempty"`
    OSHealthStatus    *string           `json:"osHealthStatus,omitempty"` // "healthy"|"warning"|"unhealthy"
    SmartPassed       *bool             `json:"smartPassed,omitempty"`
    Attributes        map[string]any    `json:"attributes"`
}
type SourceReport struct {
    Source      Kind         `json:"source"`
    Status      SourceStatus `json:"status"`
    Complete    *bool        `json:"complete,omitempty"`
    ToolVersion string       `json:"toolVersion,omitempty"`
    Path        string       `json:"path,omitempty"`
    DurationMs  int64        `json:"durationMs,omitempty"`
    Error       string       `json:"error,omitempty"`
    RetryAt     *time.Time   `json:"retryAt,omitempty"`
    Warnings    []string     `json:"warnings,omitempty"`
}
type Snapshot struct {
    SnapshotID                string         `json:"snapshotId"`
    Sequence                  uint64         `json:"sequence"`
    CollectedAt               time.Time      `json:"collectedAt"`
    AgentVersion              string         `json:"agentVersion"`
    PollIntervalMinutes       int            `json:"pollIntervalMinutes"`
    DiskHealthIntervalMinutes int            `json:"diskHealthIntervalMinutes"`
    TiersRun                  []string       `json:"tiersRun"`
    Sources                   []SourceReport `json:"sources"`
    Components                []Component    `json:"components"`
}
type Config struct { Enabled bool; PollInterval time.Duration; DiskHealthInterval time.Duration }
```

### D. Ingest and read services — `apps/api/src/services/hardwareHealth/` (W01)

```ts
// ingest.ts
export type IngestResult = { accepted: true; events: number; health: HardwareHealth } | { accepted: false; reason: 'stale_snapshot' };
export async function ingestHardwareHealthSnapshot(input: {
  device: { id: string; orgId: string };
  snapshot: HardwareHealthSnapshot;
  writer: 'agent' | 'server';
  receivedAt: Date;
}): Promise<IngestResult>;
// One transaction: SELECT … FOR UPDATE on device_hardware_health (insert-if-missing first), §7.1
// ordering, §7.2 upsert + events + streaks, §7.3 stale-marking, §7.4 collector rows, §7.5 rollup.

// view.ts
export interface HardwareHealthView {
  health: HardwareHealth; collectorHealth: HardwareHealth;
  lastReceivedAt: string | null; lastCollectedAt: string | null;
  pollIntervalMinutes: number | null; diskHealthIntervalMinutes: number | null;
  tiersRun: string[]; agentVersion: string | null;
  sources: HardwareSourceReport[];
  components: HardwareComponentView[];   // every column of device_hardware_components in camelCase + `fresh: boolean` (§7.3 window)
  events: HardwareEventView[];           // latest 50, newest first
  policy: { enabled: boolean; source: 'default' | 'policy'; policyName?: string } | null;
}
export async function getDeviceHardwareHealthView(deviceId: string, opts?: { eventLimit?: number }): Promise<HardwareHealthView | null>; // null when no health row
// freshness.ts
export function isComponentFresh(c: { source: HardwareSource; lastSeenAt: Date }, health: { pollIntervalMinutes: number | null; diskHealthIntervalMinutes: number | null }, now: Date): boolean; // 3 × tier interval, fallback 30/180 min
// retire.ts (used by the reaper and device delete)
export async function resolveAlertsForRemovedComponents(deviceId: string, componentKeys: string[]): Promise<number>; // W03 fills the body; W01 ships it as a no-op that returns 0
```

`GET /api/v1/devices/:id/hardware-health` — `routes/devices/hardwareHealth.ts`
(`hardwareHealthRoutes`, `requireScope('organization','partner','system')`,
`requirePermission(PERMISSIONS.DEVICES_READ…)`, `getDeviceWithOrgAndSiteCheck`, returns
`HardwareHealthView` or `404 { error: 'no_hardware_health' }`); mounted in `routes/devices/index.ts`.
`MCP_COVERAGE`: `'devices/hardwareHealth.ts': { tools: ['get_device_hardware_health'] }`.

AI tool `get_device_hardware_health` in `services/aiToolsDevice.ts` (tier 1, `domain: 'devices'`,
`deviceArgs: ['deviceId']`, input `{ deviceId, includeEvents?: boolean }`) → same view.

Retention: `jobs/hardwareHealthRetention.ts` (queue `'hardware-health-retention'`, daily via
`jobSchedule`, `pruneInCtidBatches` from `jobs/retentionBatch.ts`): events older than 180 days;
components `stale_since < now() - 7 days` — collect their `component_key`s per device, call
`resolveAlertsForRemovedComponents`, write `removed` events, then delete. Registered in
`services/workerRegistry.ts` next to `eventLogRetention`.

### E. Config feature `hardware_monitoring` (W01)

- Drizzle `configFeatureTypeEnum` + `CONFIG_FEATURE_TYPES` + `ConfigFeatureType` union in
  `services/configurationPolicy.ts`.
- `decomposeInlineSettings` (~875), `assertDecomposableInlineSettings` (~1167),
  `deleteNormalizedRows` (~1215), `assembleInlineSettings` (~1422): a `case 'hardware_monitoring':`
  mirroring `event_log`, using `hardwareMonitoringInlineSettingsSchema`. `validateFeaturePolicyExists`
  (~2973): add to the inline-only branch.
- `routes/agents/helpers.ts`: `resolveDeviceHardwareMonitoringSettings(deviceId): Promise<HardwareMonitoringInlineSettings>`
  (hierarchy walk copied from `resolveDeviceEventLogSettings` ~1858, defaults when no link),
  `HARDWARE_MONITORING_CACHE_TTL_SECONDS = 120`, `getDeviceHardwareMonitoringSettings(deviceId)`
  (Redis key `hwmon:settings:device:${deviceId}`), `buildHardwareMonitoringConfigUpdate(deviceId): Promise<{ enabled: boolean; poll_interval_minutes: number; disk_health_interval_minutes: number }>`.
- `routes/agents/heartbeat.ts`: `PolicyConfigUpdates` gains `hardwareMonitoringSettings`; built
  inside the post-scoped `withSystemDbAccessContext` block (~2054–2121, next to
  `buildEventLogConfigUpdate` at ~2066); assigned as `policyConfigUpdate.hardware_monitoring_settings`
  next to ~2133. Resolver failure → key omitted (existing try/catch shape).
- Web: `featureTabs/HardwareMonitoringTab.tsx` (`FeatureTabShell` + `useFeatureLink`; switch +
  two number inputs), `FEATURE_META.hardware_monitoring = { label: 'Hardware Monitoring', … }`
  (`featureTabs/types.ts`), `featureTabIcons` + `renderFeatureTab` in `ConfigPolicyDetailPage.tsx`,
  `FEATURE_META` + `ALL_FEATURE_TYPES` in `devices/DeviceEffectiveConfigTab.tsx`.

### F. Alerting (W03)

- `alerts.subject_key text null CHECK (subject_key <> '')`; partial unique index
  `alerts_open_rule_device_subject_uidx ON alerts (rule_id, device_id, COALESCE(subject_key, ''))
  WHERE rule_id IS NOT NULL AND status IN ('active','acknowledged','suppressed')`; Drizzle column
  `subjectKey: text('subject_key')` on `alerts` in `db/schema/alerts.ts`; export policy `included`.
- `services/alertConditions/types.ts`:
  ```ts
  export type SubjectStatus = 'breaching' | 'recovered' | 'unknown';
  export interface SubjectEvidence { subjectKey: string; status: SubjectStatus; description: string; actualValue?: number; context?: Record<string, unknown> }
  export interface ConditionResult { passed: boolean; description: string; actualValue?: number; dataAvailable?: boolean; subjects?: SubjectEvidence[] }
  export interface HardwareHealthCondition { type: 'hardware_health'; componentTypes: HardwareHealthComponentFilter[]; minHealth: 'warning' | 'critical'; includePredictiveFailure: boolean; consecutiveSnapshots: number }
  // EvaluationResult gains `subjects?: SubjectEvidence[]` (set only when the root is a single leaf)
  ```
- `services/alertService.ts`: `CreateAlertParams.subjectKey?: string`; dedupe adds
  `subject_key IS NOT DISTINCT FROM`; insert via `sql` template with the expression `ON CONFLICT …
  DO NOTHING` + `RETURNING id` (no row → `null`, logged as dedupe); `alert.triggered` payload gains
  `subjectKey: string | null` and `responsesOwner: boolean` (true when `subjectKey` is null, or when
  this alert's id became `monitor_episodes.alert_id`); `checkAutoResolve` early-returns when
  `alert.subjectKey`; new `evaluateSubjectAlerts({ rule, template, device, monitor, evidence })`
  in a new file `services/alertSubjects.ts` implementing spec §9.1 steps 1–3 and returning the
  `MonitorObservation` the sweep records; `evaluateDeviceAlertsInMode` calls it when
  `result.subjects` is present and uses its observation instead of `result.triggered`.
- `services/alertCooldown.ts`: `isCooldownActive(ruleId, deviceId, subjectKey?)`, `setCooldown(ruleId,
  deviceId, minutes, subjectKey?)`, `isFlapping(ruleId, deviceId, windowMinutes?, threshold?,
  subjectKey?)`, `recordStateTransition(ruleId, deviceId, state, subjectKey?)`; keys gain
  `:${subjectKey}` when present.
- `services/monitors/episodeService.ts`: `linkEpisodeAlert(episodeId, alertId): Promise<{ owner: boolean }>`
  — sets `alert_id` only when NULL (`UPDATE … WHERE alert_id IS NULL RETURNING`), returns whether this
  alert became the owner.
- `jobs/automationWorker.ts` (~576): skip with `{ skipped: 'subject_alert_not_response_owner' }`
  when `payload.responsesOwner === false`.
- `services/alertConditions/handlers/hardwareHealth.ts` (`hardwareHealthHandler`, type
  `'hardware_health'`, registered in `alertConditions/index.ts` ~34–50), spec §9.3 verbatim.
- `services/monitors/kinds/hardwareHealth.ts` (`hardwareHealthKind`, registered in `kinds/index.ts`),
  `alertCategory: 'hardware'`, templates `'{{componentLabel}} {{stateLabel}} on {{deviceName}}'` /
  `'{{ruleName}}: {{componentLabel}} is {{stateLabel}} ({{stateDetail}})'`.
- `services/monitors/builtInMonitors.ts`: `BUILT_IN_MONITORS_VERSION = 3`; `key` union +
  `'raid_array_degraded' | 'physical_disk_failed' | 'cache_battery_problem' | 'hardware_collector_failing'`;
  `condition: ThresholdDefaultCondition | HardwareHealthDefaultCondition`; `severity` +
  `'low'`; four entries with `sinceVersion: 3` per spec §9.5.
- `retire.ts` (§D) body: resolve open alerts whose `subject_key ∈ componentKeys` for the device
  with note `component no longer reported`.
- Web: `monitorKindFields.ts` `FieldKind` + `'multiselect'`, `KindField.options` reused;
  `MonitorConditionFields.tsx` renders a checkbox group for `multiselect`; `hardware_health` entry +
  `defaultConditionFor` seed `{ componentTypes: ['virtual_disk','physical_disk'], minHealth: 'critical', includePredictiveFailure: true, consecutiveSnapshots: 2 }`;
  i18n label keys under `monitors.fields.hardware_health.*`.

### G. Web surface (W04)

- `apps/web/src/components/devices/hardware/StorageHealthSection.tsx` (+ `ControllerCard.tsx`,
  `ComponentStatePill.tsx`, `SourcesFooter.tsx`, `HardwareEventsList.tsx` in the same folder),
  mounted in `DeviceHardwareInventory.tsx` between the summary grid (~286) and the disk table (~288);
  fetches `/devices/${deviceId}/hardware-health`; `data-testid`s: `hardware-storage-section`,
  `hardware-rollup-pill`, `hardware-controller-card`, `hardware-state-pill`, `hardware-sources-footer`,
  `hardware-events-list`, `hardware-empty-state`.
- `columnVisibility.ts`: `'hardwareHealth'` in `COLUMN_IDS`, label "Hardware", not in
  `DEFAULT_VISIBLE_COLUMNS`; `DeviceList.tsx` `Device.hardwareHealth?: HardwareHealth | null` +
  `hardwareHealthSummary?: Record<string, number> | null`; column render next to `reliability`
  (~2172); filter query param `hardwareHealth=warning|critical|unknown`.
- `routes/devices/core.ts` list handler (~811): `leftJoin(deviceHardwareHealth, eq(devices.id,
  deviceHardwareHealth.deviceId))`, select `hardwareHealth: deviceHardwareHealth.health`,
  `hardwareHealthSummary: deviceHardwareHealth.summary`; `listDevicesSchema` gains
  `hardwareHealth: z.enum(['warning','critical','unknown']).optional()`.
- Docs: `apps/docs/src/content/docs/features/hardware-monitoring.mdx` + sidebar item in the
  "Monitoring & Alerting" group of `apps/docs/astro.config.mjs` (~119–143).
- e2e: `e2e-tests/pages/DeviceHardwarePage.ts` (mirror `NetworkDevicePage.ts` tab pattern) +
  `e2e-tests/tests/device-hardware-health.spec.ts` against seeded rows.

### H. Agent package layout — `agent/internal/collectors/hwhealth/` (W02a, extended by W02b/W05)

| File | Responsibility |
|---|---|
| `types.go` | §C types, `Config`, `Result`, `Availability` |
| `source.go` | `Source` interface (spec §6.1), `Availability{Path, Version string; Available bool}`, `Result{Components []Component; Complete bool; Warnings []string; ToolVersion string}` |
| `runner.go` | `type execResult struct{ Stdout, Stderr []byte; ExitCode int; Truncated bool; Duration time.Duration }`, `func runTool(ctx context.Context, timeout time.Duration, path string, args ...string) (execResult, error)` — 4 MB cap, `WaitDelay`, stdout kept on non-zero exit; `runPowerShell(ctx, timeout, script)` wrapper |
| `detect.go` | `lookupTool(names []string, extraDirs []string) (path string, ok bool)`, well-known dirs per OS (spec §5.3, `detect_windows.go` / `detect_linux.go`), 1 h cache |
| `collector.go` | `type Collector struct`, `func New(opts Options) *Collector` (`Options{DataDir string; ExtraToolDirs []string; Sources []Source; Now func() time.Time}`), `(*Collector).ApplyConfig(Config)`, `(*Collector).Run(ctx, tiers []Tier) (*Snapshot, error)` — single-flight, budget 4 min, fairness rotation, breaker, merge, sequence persistence (`hwhealth_state.json` under `config.GetDataDir()` via `state.Write` idiom), smartctl cache (`hwhealth_smart_cache.json`) |
| `breaker.go` | per-source breaker: 3 failures → 6 h `backing_off`; visible in `SourceReport` |
| `merge.go` | §6.5 rules: smartctl enrichment by unique serial, `windows_physical_disk` drop/`AlertExempt`, Broadcom precedence |
| `keys.go` | §4.2 key builders |
| `storcli.go` (+ `perccli` as `Kind` alias with the same parser), `mdadm_linux.go`, `storagespaces_windows.go`, `winpd_windows.go`, `smartctl.go` | W02a sources |
| `megacli.go`, `ssacli.go`, `arcconf.go`, `omreport.go`, `zfs_linux.go` | W02b sources |
| `bmc.go` (+ `bmc_windows.go` / `bmc_linux.go` for tool names) | W05 |
| `testdata/<source>/*.{json,txt}` | fixtures per §13 |

Heartbeat wiring (`heartbeat.go`): fields `hwhealthCol *hwhealth.Collector`, `hwConfig
hwhealth.Config`, `lastHwRaidRun`, `lastHwDiskRun time.Time`; tick gates next to ~1962 (`dueForRun`
with jitter); `sendHardwareHealth(tiers []hwhealth.Tier)` PUTs via `sendInventoryData("hardware-health",
snapshot, label)` and is wrapped in `inventoryWg.Add(1)/Done()`; `applyConfigUpdate` gains the
`hardware_monitoring_settings` / `hardwareMonitoringSettings` case → `applyHardwareMonitoringConfig(raw any)`
→ `hwhealthCol.ApplyConfig`. Agent config: `Hardware struct { ToolDirs []string \`mapstructure:"tool_dirs" yaml:"tool_dirs"\` } \`mapstructure:"hardware" yaml:"hardware"\`` on `config.Config`.
First run 60 s after start.

### I. BMC in-band (W05)

- Agent `bmc.go`: `Kind` = `ipmi` / `racadm` / `hponcfg` per the tool that answered; one
  `Component{ComponentType: "bmc", ComponentKey: "bmc:"+kind, Name, Firmware, Attributes{ip, mac, vendor}}`;
  runs on the RAID tier but at most once per 24 h (its own `lastRun` in the collector state file).
- `services/discovery/agentReportedBmcLink.ts`: `linkBmcAssetFromAgentReport(tx, { deviceId, orgId,
  siteId, mac, ip }): Promise<'linked' | 'already_linked' | 'suppressed' | 'no_asset' | 'other_site'>`
  — called from `ingestHardwareHealthSnapshot` (§D) for every `bmc` component with `attributes.mac`.
- `discoveredAssetLinkSourceEnum` + `'agent_report'`; gates: `jobs/discoveryWorker.ts` ~1196
  approval branch checks `existing.linkSource !== 'agent_report'`; `services/topology/publish.ts`
  ~195 and `services/topology/aliasClusters.ts` ~63 exclude `linkSource === 'agent_report'`; the
  classification-propagation site (plan locates it in `processResults`) skips `agent_report`.
- Web: `ManagementControllerCard.tsx` in `components/devices/hardware/`, rendered by
  `StorageHealthSection` when a `bmc` component exists.

### J. Lab proof (W06)

Windows VM `.55`: two VHDX disks → Storage Spaces mirror → dev-push agent → attach the four
built-ins to a policy on the lab partner → pull a VHDX → expect `virtual_disk degraded` (critical)
and `physical_disk missing` (high) alerts within 2 polls → reattach → both resolve. Linux
(container with loop devices): `mdadm --create /dev/md0 --level=1 --raid-devices=2` → `--fail` →
degraded alert → `--remove`/`--add` → rebuilding (warning, no critical alert) → optimal → resolved.
Evidence (screenshots + alert ids) goes on the W06 issue; docs mark each vendor source
`fixture-only` until a real capture lands.
