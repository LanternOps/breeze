# Time Sync W01a API and Web Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Accept Windows time snapshots and expose tenant-isolated, explainable time health in the API, AI tools, device details, and documentation.

**Architecture:** A shared strict snapshot contract feeds a transactional latest-status store and a pure findings resolver. Reads resolve site timezone again so site edits immediately change mismatch findings without rewriting observations. The web and AI tool consume the same device view; later waves add collection, monitoring, history, and enforcement at the existing service boundaries.

**Tech Stack:** TypeScript, Zod 4, Hono, PostgreSQL, Drizzle, React, Astro, Vitest/jsdom, Unicode CLDR.

**Spec:** `docs/superpowers/specs/monitoring/2026-09-28-time-sync-monitoring-design.md`

**Index:** `docs/superpowers/plans/monitoring/2026-09-28-time-sync.md`

## Global Constraints

All constraints in the index's Global constraints and final Contract resolutions R1–R17 sections apply; the resolutions override conflicting draft/spec text.

- PR: W01a; no agent code, commands, policy configuration, monitor kind, streaks, daily table, fleet route, or version bump.
- Snapshot `schemaVersion: 1`; enforcement schema exists, ingest ignores enforcement, view returns `enforcement: null`.
- Migration: `2026-11-09-100000-time-sync-status.sql`.
- Composite FK: `(device_id, org_id) → devices(id, org_id) ON UPDATE CASCADE ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE`.
- Agent body rule: `agent-time-status`, `512 * 1024` bytes; malformed snapshots return `400`; sequence rejection returns `200 { accepted: false, reason: 'stale_sequence' }` (R4). The API body ceiling remains 512 KiB; R5 separately limits collector snapshots to 256 KiB.
- Freshness: `90` minutes; event activity: `24` hours; mark retention: `7` days; recent events: `20`; snapshot events: `100`.
- Reset exception: `collectedAt > stored collected_at + 1 h`, strictly greater; receipt time never grants reset acceptance.
- CLDR: `release-48-2`, recorded as `cldrVersion: "48.2"`; generated data includes every territory.
- English is authoritative; all seven non-English catalogs receive complete translations (R1). Only the identical protocol/product tokens explicitly listed in Task 9 may increase duplicate baselines.
- Branch: the index's feature-lifecycle naming rule using the actual tracked wave issue number (R16); do not use the generic `feat/` convention.
- Run commands from repository root unless a command explicitly changes directory; each shell block starts from root.
- Before each implementation commit, run the applicable Task 11 linters (R17). Existing-file search anchors are quoted verbatim in `text` fences; implementation/replacement TypeScript is Prettier-formatted, including fragments formatted in their enclosing declarations.
- Contract issues at the end record their resolved decisions; there are no remaining implementation decision gates.

## Review Focus

1. **A failure event followed by a success, then the same failure again** (DNS flaps) — event 134 at
   10:00, event 37 at 10:05, event 134 at 10:40: the finding must be active at 10:40 and not at
   10:10. Pinned in W01a `findings.test.ts` (§C.4 rule) with exact timestamps.

3. **An `NtpServer` value an admin typed by hand with odd spacing and flags**
   (`"  time.a.com,0x9   time.b.com,0x8  "`, `"time.a.com,0x1,0x8"`, empty string) — the resolver's
   host parsing must yield `["time.a.com","time.b.com"]` / `["time.a.com"]` / `[]` and never raise
   `ntp_server_unresolvable` for a well-formed host with flags. W01a `ntpServerHosts.test.ts`.

4. **A site whose timezone is `UTC` and a device on `Pacific Standard Time`** — no
   `timezone_mismatch`; the view shows "No expected timezone (site uses the UTC default)". W01a
   `expectedTimezone.test.ts` + view test.

5. **An agent restart that resets `sequence` to a lower number** — ingest must accept the first
   snapshot whose `collectedAt` is more than 1 h newer than the stored `collected_at` even when
   `sequence` went backwards (reset rule), and reject true duplicates. W01a ingest test.

Owned focus-to-task pins: focus 1 → Task 4; focus 3 → Tasks 1 and 4; focus 4 → Tasks 4 and 6; focus 5 → Task 5.

- Concurrent first snapshots for one device → one serialized sequence decision, no older overwrite (Task 5).
- Site edit after ingest → expected provenance and mismatch update together, other findings remain intact (Task 6).
- Cross-org read/write and device removal → RLS denial and no orphaned status rows (Tasks 3, 5, 7, 11).

## File Structure

Every implementation file is listed below; Task 11 changes only the execution checklist in this plan. Existing-file anchors are verified against the planning checkout.

- `packages/shared/src/constants/timeSync.ts` — define binding vocabulary, severities and timing limits.
- `packages/shared/src/constants/index.ts` — export the new contract/schema or mount the new resource alongside hardware.
- `packages/shared/src/validators/timeSync.ts` — validate snapshots/enforcement and parse/validate NTP hosts.
- `packages/shared/src/validators/index.ts` — export the new contract/schema or mount the new resource alongside hardware.
- `packages/shared/src/validators/timeSync.test.ts` — verify timeSync behavior and contracts.
- `packages/shared/src/validators/ntpServerHosts.test.ts` — verify ntpServerHosts behavior and contracts.
- `packages/shared/src/validators/__fixtures__/ntpServers.json` — share valid/invalid host conformance vectors with the future Go collector.
- `packages/shared/scripts/generate-windows-zones.mjs` — transform pinned all-territory CLDR mappings and aliases deterministically.
- `packages/shared/src/data/windowsZones.json` — store generated CLDR 48.2 Windows-zone mappings.
- `packages/shared/src/utils/windowsZones.ts` — expose strict IANA/Windows lookup accessors.
- `packages/shared/src/utils/windowsZones.test.ts` — verify windowsZones behavior and contracts.
- `packages/shared/src/utils/index.ts` — export the new contract/schema or mount the new resource alongside hardware.
- `apps/api/migrations/2026-11-09-100000-time-sync-status.sql` — create latest time status with ownership FKs, forced RLS and indexes.
- `apps/api/src/db/schema/timeSync.ts` — define typed W01a status columns, indexes and health check.
- `apps/api/src/db/schema/index.ts` — export the new contract/schema or mount the new resource alongside hardware.
- `apps/api/src/services/tenantCascade.ts` — register status in alphabetical tenant erasure order.
- `apps/api/src/routes/devices/core.ts` — register status for device cascade and denormalized org moves.
- `apps/api/src/services/orgMergeRegistry.ts` — register the status repoint merge policy.
- `apps/api/src/services/tenantExportPolicyRegistry.ts` — classify every status column, excluding all open JSON containers.
- `apps/api/src/services/deviceDeletion.test.ts` — prove central cascade deletes time status before its device.
- `apps/api/src/services/timeSync/migrations.integration.test.ts` — verify migrations integration behavior and contracts.
- `apps/api/vitest.config.ts` — route real-database time-sync tests to the integration runner.
- `apps/api/vitest.integration.config.ts` — route real-database time-sync tests to the integration runner.
- `apps/api/src/services/timeSync/expectedTimezone.ts` — resolve mapped expected timezone and provenance with warn-once diagnostics.
- `apps/api/src/services/timeSync/findings.ts` — reduce current observations and retained event marks into ordered findings.
- `apps/api/src/services/timeSync/freshness.ts` — apply the strict 90-minute receipt-age boundary.
- `apps/api/src/services/timeSync/expectedTimezone.test.ts` — verify expectedTimezone behavior and contracts.
- `apps/api/src/services/timeSync/findings.test.ts` — verify findings behavior and contracts.
- `apps/api/src/services/timeSync/freshness.test.ts` — verify freshness behavior and contracts.
- `apps/api/src/services/timeSync/testFixtures.ts` — provide typed API snapshot/event test fixtures.
- `apps/api/src/services/timeSync/ingest.ts` — serialize first/update snapshots, enforce sequence rules, and persist bounded evidence.
- `apps/api/src/services/timeSync/ingest.integration.test.ts` — verify ingest integration behavior and contracts.
- `apps/api/src/services/timeSync/view.ts` — project visible device state and refresh expected timezone/mismatch at read time.
- `apps/api/src/services/timeSync/view.test.ts` — verify view behavior and contracts.
- `apps/api/src/routes/agents/timeStatus.ts` — serve authenticated agent snapshot ingestion.
- `apps/api/src/routes/agents/timeStatus.test.ts` — verify timeStatus behavior and contracts.
- `apps/api/src/routes/agents/timeStatus.mounted.test.ts` — verify timeStatus mounted behavior and contracts.
- `apps/api/src/routes/agents/index.ts` — export the new contract/schema or mount the new resource alongside hardware.
- `apps/api/src/routes/devices/timeStatus.ts` — serve authenticated device status reads with device-read/site authorization.
- `apps/api/src/routes/devices/timeStatus.test.ts` — verify timeStatus behavior and contracts.
- `apps/api/src/routes/devices/index.ts` — export the new contract/schema or mount the new resource alongside hardware.
- `apps/api/src/middleware/bodyLimit.ts` — declare and select the exact 512 KiB agent-time-status rule.
- `apps/api/src/middleware/bodyLimit.test.ts` — register route-level body-limit parity and rule sampling.
- `apps/api/src/services/mcpCoverage.ts` — record agent transport exemption and operator read-tool coverage.
- `apps/api/src/services/aiToolsDevice.timeSync.test.ts` — verify aiToolsDevice timeSync behavior and contracts.
- `apps/api/src/services/aiToolsDevice.timeSync.registry.test.ts` — verify aiToolsDevice timeSync registry behavior and contracts.
- `apps/api/src/services/aiGuardrails.ts` — add tier-one time-status parity to the existing hardware read-tool surface.
- `apps/api/src/services/aiTools.ts` — add tier-one time-status parity to the existing hardware read-tool surface.
- `apps/api/src/services/helperToolFilter.ts` — add tier-one time-status parity to the existing hardware read-tool surface.
- `apps/api/src/services/aiAgents/agentToolCatalog.ts` — add tier-one time-status parity to the existing hardware read-tool surface.
- `apps/api/src/services/aiGuardrails.agentPrincipal.contract.test.ts` — verify aiGuardrails agentPrincipal contract behavior and contracts.
- `apps/api/src/services/aiAgentSdkTools.ts` — add tier-one time-status parity to the existing hardware read-tool surface.
- `apps/api/src/services/scriptBuilderTools.ts` — add tier-one time-status parity to the existing hardware read-tool surface.
- `apps/api/src/services/aiAgents/analysisProfile.ts` — add tier-one time-status parity to the existing hardware read-tool surface.
- `apps/api/src/services/aiAgents/designProfile.ts` — add tier-one time-status parity to the existing hardware read-tool surface.
- `apps/api/src/services/aiAgents/patchProfile.ts` — add tier-one time-status parity to the existing hardware read-tool surface.
- `apps/api/src/services/aiAgents/sweepProfile.ts` — add tier-one time-status parity to the existing hardware read-tool surface.
- `apps/api/src/services/aiAgents/verdictProfile.ts` — add tier-one time-status parity to the existing hardware read-tool surface.
- `apps/api/src/services/aiToolSchemas.ts` — add tier-one time-status parity to the existing hardware read-tool surface.
- `apps/api/src/services/mcpGuidance.ts` — add tier-one time-status parity to the existing hardware read-tool surface.
- `apps/web/src/components/ai-risk/tierConfig.ts` — add tier-one time-status parity to the existing hardware read-tool surface.
- `apps/api/src/services/helperToolFilter.test.ts` — verify helperToolFilter behavior and contracts.
- `apps/api/src/services/llm/toolCapture/surfaces.test.ts` — verify surfaces behavior and contracts.
- `apps/api/src/services/aiAgents/runLoop.test.ts` — verify runLoop behavior and contracts.
- `apps/api/src/services/aiToolsDevice.ts` — add tier-one time-status parity to the existing hardware read-tool surface.
- `apps/web/src/components/devices/time/DeviceTimeSection.tsx` — load and render localized time health, provenance, facts and findings.
- `apps/web/src/components/devices/time/TimeEventsList.tsx` — render collapsible escaped event evidence.
- `apps/web/src/components/devices/time/types.ts` — mirror the exact device time view without importing API code.
- `apps/web/src/components/devices/time/timeSyncCopy.ts` — adapt detail and device presentation context into localized hints.
- `apps/web/src/components/devices/time/fixtures.ts` — provide typed web view fixtures.
- `apps/web/src/components/devices/time/DeviceTimeSection.test.tsx` — verify DeviceTimeSection behavior and contracts.
- `apps/web/src/components/devices/time/DeviceTimeSection.integration.test.tsx` — verify DeviceTimeSection integration behavior and contracts.
- `apps/web/src/components/devices/DeviceInfoTab.tsx` — place Time immediately after Operating System.
- `apps/web/src/components/devices/DeviceInfoTab.test.tsx` — isolate parent mutation tests from the new child fetch.
- `apps/web/src/lib/i18n/translationCoverage.test.ts` — adjust exact protocol-token duplicate baselines and verify translations.
- `apps/web/src/locales/de-DE/devices.json` — add the authoritative English Time namespace for this locale.
- `apps/web/src/locales/en/devices.json` — add the authoritative English Time namespace for this locale.
- `apps/web/src/locales/es-419/devices.json` — add the authoritative English Time namespace for this locale.
- `apps/web/src/locales/fr-CA/devices.json` — add the authoritative English Time namespace for this locale.
- `apps/web/src/locales/fr-FR/devices.json` — add the authoritative English Time namespace for this locale.
- `apps/web/src/locales/it-IT/devices.json` — add the authoritative English Time namespace for this locale.
- `apps/web/src/locales/pt-BR/devices.json` — add the authoritative English Time namespace for this locale.
- `apps/web/src/locales/tr-TR/devices.json` — add the authoritative English Time namespace for this locale.
- `apps/docs/src/content/docs/features/time-sync.mdx` — document visibility, findings/fixes, freshness and the UTC-default rule.
- `apps/docs/astro.config.mjs` — add the Time sync documentation sidebar entry.
- `apps/web/src/components/devices/time/timeSyncDocs.test.ts` — check finding documentation and sidebar registration.
- `docs/superpowers/plans/monitoring/2026-09-28-time-sync-w01a-api-web-visibility.md` — record executed verification checkboxes after implementation.

### Task 1: Define the shared snapshot and host contract

**Files:** Create `packages/shared/src/constants/timeSync.ts`, `packages/shared/src/validators/timeSync.ts`, `packages/shared/src/validators/timeSync.test.ts`, `packages/shared/src/validators/ntpServerHosts.test.ts`, `packages/shared/src/validators/__fixtures__/ntpServers.json`; Modify `packages/shared/src/constants/index.ts:177`, `packages/shared/src/validators/index.ts:825`.

**Interfaces:** Consumes Zod 4 (`packages/shared/package.json:36`). Produces all index §A exports, `timeStatusSnapshotSchema`, `TimeStatusSnapshot`, `timeSyncEnforcementResultSchema`, `timeSyncEnforcementReportSchema`, `TimeSyncEnforcementState`, `isValidNtpServerHost(value: string): boolean`, `ntpServerHostSchema: z.ZodString`, `parseNtpServerHosts(raw: string | null): string[]`.

- [ ] Write the failing tests.

`packages/shared/src/validators/ntpServerHosts.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import vectors from './__fixtures__/ntpServers.json';
import {
  isValidNtpServerHost,
  ntpServerHostSchema,
  parseNtpServerHosts,
} from './timeSync';

describe('NTP host contract shared with Go', () => {
  it.each(vectors.valid)('accepts %s', (host) => {
    expect(isValidNtpServerHost(host)).toBe(true);
    expect(ntpServerHostSchema.safeParse(host).success).toBe(true);
  });
  it.each(vectors.invalid)('rejects %s', (host) => {
    expect(isValidNtpServerHost(host)).toBe(false);
    expect(ntpServerHostSchema.safeParse(host).success).toBe(false);
  });
  it.each([
    ['  time.a.com,0x9   time.b.com,0x8  ', ['time.a.com', 'time.b.com']],
    ['time.a.com,0x1,0x8', ['time.a.com']],
    ['', []],
    [null, []],
    ['dc01\tpool.ntp.org,0X9', ['dc01', 'pool.ntp.org']],
    ['bad,flag', ['bad,flag']],
    ['pool.ntp.org;bad', ['pool.ntp.org;bad']],
  ])('parses %s without masking malformed flags', (raw, expected) => {
    expect(parseNtpServerHosts(raw as string | null)).toEqual(expected);
  });
});
```

`packages/shared/src/validators/timeSync.test.ts`:

```ts
import { expect, it } from 'vitest';
import {
  timeStatusSnapshotSchema,
  timeSyncEnforcementReportSchema,
} from './timeSync';
import {
  TIME_SYNC_FINDING_CODES,
  TIME_SYNC_FINDING_SEVERITY,
} from '../constants/timeSync';
const wire = {
  schemaVersion: 1,
  sequence: 0,
  collectedAt: '2026-09-28T10:00:00Z',
  config: {
    type: null,
    ntpServer: null,
    specialPollIntervalSeconds: null,
    policyManaged: false,
    policyManagedValues: [],
    serviceState: 'unknown',
    serviceStartType: 'unknown',
    hostTimeProviderEnabled: null,
  },
  status: {
    method: 'unavailable',
    source: null,
    sourceKind: 'unknown',
    lastSuccessfulSyncAt: null,
    lastSyncError: null,
    stratum: null,
    pollIntervalSeconds: null,
  },
  domain: {
    joinType: 'unknown',
    role: 'unknown',
    domainDns: null,
    forestDns: null,
    pdcName: null,
  },
  timezone: {
    windowsId: null,
    biasMinutes: null,
    dynamicDstDisabled: null,
    autoUpdate: 'unknown',
  },
  events: [],
  enforcement: null,
};
it('accepts unavailable fields as null and sequence zero', () => {
  expect(timeStatusSnapshotSchema.parse(wire)).toEqual(wire);
  expect(Object.keys(TIME_SYNC_FINDING_SEVERITY)).toEqual([
    ...TIME_SYNC_FINDING_CODES,
  ]);
});
it.each([
  { sequence: -1 },
  { sequence: 0.5 },
  { schemaVersion: 2 },
  { extra: true },
  { collectedAt: '2026-09-28T10:00:00' },
  { config: { ...wire.config, extra: true } },
  { config: { ...wire.config, ntpServer: 'x'.repeat(1025) } },
  { config: { ...wire.config, policyManagedValues: Array(21).fill('Type') } },
  { status: { ...wire.status, stratum: 17 } },
  { timezone: { ...wire.timezone, biasMinutes: -1441 } },
  {
    events: Array(101).fill({
      recordId: 1,
      eventId: 134,
      level: 2,
      occurredAt: wire.collectedAt,
      message: '',
      properties: [],
    }),
  },
])('rejects invalid snapshot %j', (patch) => {
  expect(
    timeStatusSnapshotSchema.safeParse({ ...wire, ...patch }).success,
  ).toBe(false);
});
it('bounds events and enforcement and rejects nested unknown keys', () => {
  const event = {
    recordId: 1,
    eventId: 134,
    level: 2,
    occurredAt: wire.collectedAt,
    message: 'm'.repeat(1000),
    properties: Array(10).fill('p'.repeat(500)),
  };
  expect(
    timeStatusSnapshotSchema.safeParse({
      ...wire,
      events: Array(100).fill(event),
    }).success,
  ).toBe(true);
  for (const patch of [
    { message: 'm'.repeat(1001) },
    { properties: Array(11).fill('p') },
    { properties: ['p'.repeat(501)] },
    { level: 6 },
    { recordId: -1 },
    { extra: 1 },
  ]) {
    expect(
      timeStatusSnapshotSchema.safeParse({
        ...wire,
        events: [{ ...event, ...patch }],
      }).success,
    ).toBe(false);
  }
  const result = {
    resultId: '11111111-1111-4111-8111-111111111111',
    fingerprint: 'sha256:abc',
    at: wire.collectedAt,
    outcome: 'skipped',
    reason: 'role_unknown',
    before: { type: null },
    after: { type: 'NT5DS' },
    error: null,
  };
  expect(
    timeSyncEnforcementReportSchema.safeParse({ ntp: result, timezone: null })
      .success,
  ).toBe(true);
  for (const patch of [
    { resultId: 'bad' },
    { reason: 'guessed' },
    { error: 'x'.repeat(513) },
    { before: { nested: {} } },
    { fingerprint: 'x'.repeat(81) },
    { extra: true },
  ]) {
    expect(
      timeSyncEnforcementReportSchema.safeParse({
        ntp: { ...result, ...patch },
        timezone: null,
      }).success,
    ).toBe(false);
  }
});
```

- [ ] Run `cd packages/shared && npx vitest run src/validators/ntpServerHosts.test.ts src/validators/timeSync.test.ts`.
  Expected FAIL: cannot resolve `./timeSync` (and fixture before it is created).

- [ ] Implement `packages/shared/src/constants/timeSync.ts`:

```ts
export const TIME_SYNC_FINDING_CODES = [
  'pdc_no_external_source',
  'source_local_clock',
  'dc_vm_host_sync',
  'ntp_server_unresolvable',
  'ntp_peer_unreachable',
  'domain_source_unavailable',
  'member_not_on_hierarchy',
  'sync_disabled',
  'sync_stale',
  'correction_refused',
  'timezone_mismatch',
  'policy_not_applied', // raised only from W03a on
  'policy_conflict_gpo', // raised only from W03a on
] as const;
export type TimeSyncFindingCode = (typeof TIME_SYNC_FINDING_CODES)[number];

export type TimeSyncFindingSeverity = 'critical' | 'warning' | 'info';
export const TIME_SYNC_FINDING_SEVERITY: Record<
  TimeSyncFindingCode,
  TimeSyncFindingSeverity
> = {
  pdc_no_external_source: 'critical',
  source_local_clock: 'critical',
  dc_vm_host_sync: 'warning',
  ntp_server_unresolvable: 'warning',
  ntp_peer_unreachable: 'warning',
  domain_source_unavailable: 'warning',
  member_not_on_hierarchy: 'warning',
  sync_disabled: 'critical',
  sync_stale: 'warning',
  correction_refused: 'warning',
  timezone_mismatch: 'info',
  policy_not_applied: 'warning',
  policy_conflict_gpo: 'info',
};

export const TIME_SYNC_HEALTH = [
  'healthy',
  'warning',
  'critical',
  'unknown',
] as const;
export type TimeSyncHealth = (typeof TIME_SYNC_HEALTH)[number];

export const TIME_SYNC_TYPES = ['NT5DS', 'NTP', 'NoSync', 'AllSync'] as const;
export const TIME_SYNC_SOURCE_KINDS = [
  'ntp_peer',
  'domain_peer',
  'local_clock',
  'free_running',
  'vm_host',
  'unknown',
] as const;
export const TIME_SYNC_STATUS_METHODS = [
  'provider_api',
  'w32tm_tokens',
  'events',
  'unavailable',
] as const;
export const TIME_SYNC_JOIN_TYPES = [
  'none',
  'workplace',
  'azure_ad',
  'on_prem_ad',
  'hybrid_azure_ad',
  'unknown',
] as const;
export const TIME_SYNC_DOMAIN_ROLES = [
  'workgroup',
  'entra_only',
  'member',
  'dc',
  'pdc_emulator',
  'forest_root_pdc_emulator',
  'unknown',
] as const;
export const TIME_SYNC_SERVICE_STATES = [
  'running',
  'stopped',
  'start_pending',
  'stop_pending',
  'paused',
  'not_installed',
  'unknown',
] as const;
export const TIME_SYNC_SERVICE_START_TYPES = [
  'auto',
  'delayed_auto',
  'manual',
  'trigger_manual',
  'disabled',
  'unknown',
] as const;
export const TIME_SYNC_AUTO_UPDATE = ['on', 'off', 'unknown'] as const;
export type TimeSyncType = (typeof TIME_SYNC_TYPES)[number];
export type TimeSyncSourceKind = (typeof TIME_SYNC_SOURCE_KINDS)[number];
export type TimeSyncStatusMethod = (typeof TIME_SYNC_STATUS_METHODS)[number];
export type TimeSyncJoinType = (typeof TIME_SYNC_JOIN_TYPES)[number];
export type TimeSyncDomainRole = (typeof TIME_SYNC_DOMAIN_ROLES)[number];
export type TimeSyncServiceState = (typeof TIME_SYNC_SERVICE_STATES)[number];
export type TimeSyncServiceStartType =
  (typeof TIME_SYNC_SERVICE_START_TYPES)[number];
export type TimeSyncAutoUpdate = (typeof TIME_SYNC_AUTO_UPDATE)[number];

/** Time-Service event IDs the collector must send and the resolver reads. */
export const TIME_SYNC_FAILURE_EVENT_FINDING: Readonly<
  Record<number, TimeSyncFindingCode>
> = {
  12: 'pdc_no_external_source',
  24: 'ntp_peer_unreachable',
  29: 'ntp_peer_unreachable',
  36: 'sync_stale',
  47: 'ntp_peer_unreachable',
  52: 'correction_refused',
  129: 'domain_source_unavailable',
  134: 'ntp_server_unresolvable',
};
export const TIME_SYNC_SUCCESS_EVENT_IDS = [35, 37] as const;
export const TIME_SYNC_EVENT_ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const TIME_SYNC_SNAPSHOT_INTERVAL_MINUTES = 30;
/** A status older than this is stale (3 × interval). */
export const TIME_SYNC_STALE_AFTER_MS =
  3 * TIME_SYNC_SNAPSHOT_INTERVAL_MINUTES * 60 * 1000;
/** Poll fallback when the device reports none (Windows standalone default: 7 days). */
export const TIME_SYNC_DEFAULT_POLL_SECONDS = 604800;
export const TIME_SYNC_RECENT_EVENTS_MAX = 20;
export const TIME_SYNC_SNAPSHOT_EVENTS_MAX = 100;
/** Sites at these values have no expected timezone (spec D6). */
export const TIME_SYNC_UNSET_SITE_TIMEZONES = ['UTC', 'Etc/UTC'] as const;
```

Implement `packages/shared/src/validators/timeSync.ts` (enforcement definitions precede the snapshot to avoid a temporal-dead-zone failure):

```ts
import { z } from 'zod';
import {
  TIME_SYNC_TYPES,
  TIME_SYNC_SERVICE_STATES,
  TIME_SYNC_SERVICE_START_TYPES,
  TIME_SYNC_STATUS_METHODS,
  TIME_SYNC_SOURCE_KINDS,
  TIME_SYNC_JOIN_TYPES,
  TIME_SYNC_DOMAIN_ROLES,
  TIME_SYNC_AUTO_UPDATE,
  TIME_SYNC_SNAPSHOT_EVENTS_MAX,
} from '../constants/timeSync';

export const timeSyncEnforcementResultSchema = z
  .object({
    resultId: z.string().uuid(),
    fingerprint: z.string().max(80),
    at: z.string().datetime({ offset: true }),
    outcome: z.enum(['ok', 'failed', 'skipped']),
    reason: z.enum([
      'applied',
      'already_compliant',
      'role_unknown',
      'conflict_gpo',
      'readback_mismatch',
      'exec_failed',
      'invalid_settings',
      'auto_timezone_on',
      'no_expected_timezone',
    ]),
    before: z.record(
      z.string(),
      z.union([z.string(), z.number(), z.boolean(), z.null()]),
    ),
    after: z.record(
      z.string(),
      z.union([z.string(), z.number(), z.boolean(), z.null()]),
    ),
    error: z.string().max(512).nullable(),
  })
  .strict();
export const timeSyncEnforcementReportSchema = z
  .object({
    ntp: timeSyncEnforcementResultSchema.nullable(),
    timezone: timeSyncEnforcementResultSchema.nullable(),
  })
  .strict();
export type TimeSyncEnforcementState = z.infer<
  typeof timeSyncEnforcementReportSchema
>;

/** Agent → API snapshot (spec §4.6). camelCase keys; `null` for unknown. */
export const timeStatusSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    sequence: z.number().int().nonnegative(),
    collectedAt: z.string().datetime({ offset: true }),
    config: z
      .object({
        type: z.enum(TIME_SYNC_TYPES).nullable(),
        ntpServer: z.string().max(1024).nullable(),
        specialPollIntervalSeconds: z.number().int().nonnegative().nullable(),
        policyManaged: z.boolean(),
        policyManagedValues: z.array(z.string().max(64)).max(20),
        serviceState: z.enum(TIME_SYNC_SERVICE_STATES),
        serviceStartType: z.enum(TIME_SYNC_SERVICE_START_TYPES),
        hostTimeProviderEnabled: z.boolean().nullable(),
      })
      .strict(),
    status: z
      .object({
        method: z.enum(TIME_SYNC_STATUS_METHODS),
        source: z.string().max(512).nullable(),
        sourceKind: z.enum(TIME_SYNC_SOURCE_KINDS),
        lastSuccessfulSyncAt: z.string().datetime({ offset: true }).nullable(),
        lastSyncError: z.string().max(512).nullable(),
        stratum: z.number().int().min(0).max(16).nullable(),
        pollIntervalSeconds: z.number().int().nonnegative().nullable(),
      })
      .strict(),
    domain: z
      .object({
        joinType: z.enum(TIME_SYNC_JOIN_TYPES),
        role: z.enum(TIME_SYNC_DOMAIN_ROLES),
        domainDns: z.string().max(255).nullable(),
        forestDns: z.string().max(255).nullable(),
        pdcName: z.string().max(255).nullable(),
      })
      .strict(),
    timezone: z
      .object({
        windowsId: z.string().max(128).nullable(),
        biasMinutes: z.number().int().min(-1440).max(1440).nullable(),
        dynamicDstDisabled: z.boolean().nullable(),
        autoUpdate: z.enum(TIME_SYNC_AUTO_UPDATE),
      })
      .strict(),
    events: z
      .array(
        z
          .object({
            recordId: z.number().int().nonnegative(),
            eventId: z.number().int().nonnegative(),
            level: z.number().int().min(0).max(5),
            occurredAt: z.string().datetime({ offset: true }),
            message: z.string().max(1000),
            properties: z.array(z.string().max(500)).max(10),
          })
          .strict(),
      )
      .max(TIME_SYNC_SNAPSHOT_EVENTS_MAX),
    enforcement: timeSyncEnforcementReportSchema.nullable(), // W01a defines the schema (§F.3) so W01b can send `null` and W03b can send values without a validator change
  })
  .strict();
export type TimeStatusSnapshot = z.infer<typeof timeStatusSnapshotSchema>;

export function isValidNtpServerHost(value: string): boolean {
  if (value.length < 1 || value.length > 253 || /[\s,;\/\\]/.test(value))
    return false;
  // Zod's IP validators avoid accepting a colon-plus-port as an IPv6 address.
  if (z.ipv4().safeParse(value).success || z.ipv6().safeParse(value).success)
    return true;
  if (value.includes(':')) return false;
  return value
    .split('.')
    .every(
      (label) =>
        label.length >= 1 &&
        label.length <= 63 &&
        /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label),
    );
}
export const ntpServerHostSchema: z.ZodString = z
  .string()
  .refine(isValidNtpServerHost, {
    message:
      'Use an IPv4 or IPv6 literal or an RFC-1123 hostname without flags or a port',
  });
export function parseNtpServerHosts(raw: string | null): string[] {
  return (raw ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map((host) => host.replace(/(?:,0x[0-9a-f]+)+$/i, ''));
}
```

Create the fixture with the following exact command (the two address vectors are protocol test data required by index §B, not infrastructure):

```bash
python3 - <<'PYFIXTURE'
import json
from pathlib import Path
vectors = {
    "valid": ["a", "123", "time.cloudflare.com", "pool.ntp.org", "10.0.0.1", "2001:db8::1", "dc01", "a.b", "a" * 63 + ".example"],
    "invalid": ["", "a,0x9", "a b", "a;b", "-flag", "a:123", "\"a\"", "a/b", "a" * 254, "..", "a..b", "bad_underscore", "host-", "[2001:db8::1]"],
}
p = Path('packages/shared/src/validators/__fixtures__/ntpServers.json')
p.parent.mkdir(parents=True, exist_ok=True)
p.write_text(json.dumps(vectors, indent=2) + '\n')
PYFIXTURE
```

Barrel anchors and replacements:

- `packages/shared/src/constants/index.ts:177`, replace `export * from './hardwareHealth';` with:

```ts
export * from './hardwareHealth';
export * from './timeSync';
```

- `packages/shared/src/validators/index.ts:825`, replace `export * from './hardwareHealth';` with:

```ts
export * from './hardwareHealth';
export * from './timeSync';
```

The root barrel already exports constants, validators, and utils (`packages/shared/src/index.ts:1–4`); no duplicate root exports.

- [ ] Run `cd packages/shared && npx vitest run src/validators/ntpServerHosts.test.ts src/validators/timeSync.test.ts`; expected PASS for valid/invalid vectors, strictness, and boundaries.
- [ ] Commit:

```bash
git add packages/shared/src/constants/timeSync.ts packages/shared/src/constants/index.ts packages/shared/src/validators/timeSync.ts packages/shared/src/validators/index.ts packages/shared/src/validators/timeSync.test.ts packages/shared/src/validators/ntpServerHosts.test.ts packages/shared/src/validators/__fixtures__/ntpServers.json
git commit -m "feat(time-sync): define snapshot and host contracts" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2: Generate the Windows timezone mapping from pinned CLDR

**Files:** Create `packages/shared/scripts/generate-windows-zones.mjs`, `packages/shared/src/data/windowsZones.json`, `packages/shared/src/utils/windowsZones.ts`, `packages/shared/src/utils/windowsZones.test.ts`; Modify `packages/shared/src/utils/index.ts:6`.

**Interfaces:** Consumes CLDR `release-48-2` `common/supplemental/windowsZones.xml` plus `common/bcp47/timezone.xml` aliases; produces `{ cldrVersion, ianaToWindows, windowsIds }`, `ianaToWindowsZone(iana: string): string | null`, `isKnownWindowsZone(windowsId: string): boolean`, `WINDOWS_ZONE_IDS: readonly string[]`.

Pin justification: [Unicode's stable release table](https://cldr.unicode.org/index/downloads) lists 48.2 (2026-03-17); [49 is beta](https://cldr.unicode.org/downloads/cldr-49) as of this plan. Use `release-48-2`, not main or a beta. Download both files to a temporary directory; commit only the derived JSON plus generator/test/accessor source, never the downloaded XML. The generator preserves every mapZone row across all territories, adds only aliases with an existing authoritative mapping, and rejects conflicting aliases.

The actual picker is `apps/web/src/components/settings/SiteForm.tsx:111` → `apps/web/src/components/shared/TimezoneSelect.tsx:92–95` → `packages/shared/src/utils/timezone.ts:93–118`; its fallback list is `:63–82`. The shared function is the coverage source, not a duplicated list.

- [ ] Write `packages/shared/src/utils/windowsZones.test.ts`:

```ts
import { afterEach, expect, it, vi } from 'vitest';
import data from '../data/windowsZones.json';
import {
  ianaToWindowsZone,
  isKnownWindowsZone,
  WINDOWS_ZONE_IDS,
} from './windowsZones';
import { listIanaTimezones } from './timezone';

afterEach(() => vi.restoreAllMocks());
it.each([
  ['America/New_York', 'Eastern Standard Time'],
  ['America/Detroit', 'Eastern Standard Time'],
  ['Europe/London', 'GMT Standard Time'],
  ['Asia/Kolkata', 'India Standard Time'],
  ['UTC', 'UTC'],
  ['Etc/UTC', 'UTC'],
])('maps %s to %s', (iana, windows) => {
  expect(ianaToWindowsZone(iana)).toBe(windows);
  expect(isKnownWindowsZone(windows)).toBe(true);
});
it('preserves a version, unique Windows IDs, and strict unknown handling', () => {
  expect(data.cldrVersion).toBe('48.2');
  expect(new Set(WINDOWS_ZONE_IDS).size).toBe(WINDOWS_ZONE_IDS.length);
  expect(ianaToWindowsZone('Invalid/Zone')).toBeNull();
  expect(ianaToWindowsZone('toString')).toBeNull();
  expect(isKnownWindowsZone('eastern standard time')).toBe(false);
});
it('maps every CLDR-representable timezone offered by the live site picker', () => {
  const missing = listIanaTimezones().filter(
    (zone) => ianaToWindowsZone(zone) === null,
  );
  expect(
    missing,
    'Only the documented unrepresentable IANA zone is unmapped',
  ).toEqual(['Antarctica/Troll']);
});
it('maps the fallback picker when Intl enumeration is unavailable', async () => {
  vi.resetModules();
  vi.spyOn(Intl, 'supportedValuesOf').mockImplementation(() => []);
  const { listIanaTimezones: fallback } = await import('./timezone');
  expect(fallback().filter((zone) => ianaToWindowsZone(zone) === null)).toEqual(
    [],
  );
});
```

- [ ] Run `cd packages/shared && npx vitest run src/utils/windowsZones.test.ts`.
  Expected initial FAIL: cannot resolve `../data/windowsZones.json`.

- [ ] Implement `packages/shared/scripts/generate-windows-zones.mjs`:

```js
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
const [windowsPath, aliasesPath, outputPath] = process.argv.slice(2);
if (!windowsPath || !aliasesPath || !outputPath) {
  throw new Error(
    'Usage: node packages/shared/scripts/generate-windows-zones.mjs windowsZones.xml timezone.xml output.json',
  );
}
const decode = (value) =>
  value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
const attributes = (tag) =>
  Object.fromEntries(
    [...tag.matchAll(/([\w:-]+)="([^"]*)"/g)].map(([, key, value]) => [
      key,
      decode(value),
    ]),
  );
const xml = await readFile(windowsPath, 'utf8');
const aliasXml = await readFile(aliasesPath, 'utf8');
const mapping = new Map();
const set = (iana, windows) => {
  const previous = mapping.get(iana);
  if (previous && previous !== windows)
    throw new Error(`Conflicting Windows mapping: ${iana}`);
  mapping.set(iana, windows);
};
let rows = 0;
for (const match of xml.matchAll(/<mapZone\b[^>]*\/>/g)) {
  const { other, type } = attributes(match[0]);
  if (!other || !type) throw new Error('Malformed mapZone row');
  for (const iana of type.split(/\s+/).filter(Boolean)) set(iana, other);
  rows++;
}
if (rows < 100)
  throw new Error('Input is not the complete CLDR windowsZones.xml');
for (const match of aliasXml.matchAll(/<type\b[^>]*\/>/g)) {
  const { alias, iana } = attributes(match[0]);
  if (!alias) continue;
  const names = [...new Set([...alias.split(/\s+/), ...(iana ? [iana] : [])])];
  const known = new Set(names.map((name) => mapping.get(name)).filter(Boolean));
  if (known.size > 1) throw new Error(`Conflicting timezone aliases: ${alias}`);
  if (known.size === 1) for (const name of names) set(name, [...known][0]);
}
// UTC is a supported API sentinel, not a geographic zone approximation.
set('UTC', 'UTC');
set('Etc/UTC', 'UTC');
const data = {
  cldrVersion: '48.2',
  ianaToWindows: Object.fromEntries(
    [...mapping.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  ),
  windowsIds: [...new Set(mapping.values())].sort(),
};
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(data, null, 2) + '\n');
```

Generate the full JSON (this command is the complete reproducible implementation of the data artifact):

```bash
time_sync_cldr_dir=$(mktemp -d)
curl --fail --location https://raw.githubusercontent.com/unicode-org/cldr/release-48-2/common/supplemental/windowsZones.xml --output "$time_sync_cldr_dir/windowsZones.xml"
curl --fail --location https://raw.githubusercontent.com/unicode-org/cldr/release-48-2/common/bcp47/timezone.xml --output "$time_sync_cldr_dir/timezone.xml"
node packages/shared/scripts/generate-windows-zones.mjs "$time_sync_cldr_dir/windowsZones.xml" "$time_sync_cldr_dir/timezone.xml" packages/shared/src/data/windowsZones.json
node packages/shared/scripts/generate-windows-zones.mjs "$time_sync_cldr_dir/windowsZones.xml" "$time_sync_cldr_dir/timezone.xml" "$time_sync_cldr_dir/repeated.json"
cmp packages/shared/src/data/windowsZones.json "$time_sync_cldr_dir/repeated.json"
```

Implement `packages/shared/src/utils/windowsZones.ts`:

```ts
import data from '../data/windowsZones.json';
const mapping: Readonly<Record<string, string>> = data.ianaToWindows;
export const WINDOWS_ZONE_IDS: readonly string[] = Object.freeze([
  ...data.windowsIds,
]);
const windowsIds = new Set(WINDOWS_ZONE_IDS);
export function ianaToWindowsZone(iana: string): string | null {
  return Object.hasOwn(mapping, iana) ? mapping[iana]! : null;
}
export function isKnownWindowsZone(windowsId: string): boolean {
  return windowsIds.has(windowsId);
}
```

Replace `packages/shared/src/utils/index.ts:6` anchor `export * from './timezone';` with:

```ts
export * from './timezone';
export * from './windowsZones';
```

- [ ] Run `cd packages/shared && npx vitest run src/utils/windowsZones.test.ts`.
  Expected PASS for known mappings, fallback coverage, metadata, strict unknown handling, and the explicit `['Antarctica/Troll']` missing-zone assertion required by R2. Keep Troll unmapped; Task 6 verifies `expectedUnsetReason: 'unmapped'`. Do not invent a Windows mapping or restrict the site picker.

- [ ] After green targeted tests, commit:

```bash
git add packages/shared/scripts/generate-windows-zones.mjs packages/shared/src/data/windowsZones.json packages/shared/src/utils/windowsZones.ts packages/shared/src/utils/windowsZones.test.ts packages/shared/src/utils/index.ts
git commit -m "feat(time-sync): add pinned CLDR timezone mapping" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3: Add the latest-status table and every lifecycle registration

**Files:** Create `apps/api/migrations/2026-11-09-100000-time-sync-status.sql`, `apps/api/src/db/schema/timeSync.ts`, `apps/api/src/services/timeSync/migrations.integration.test.ts`; Modify `apps/api/src/db/schema/index.ts:16`, `apps/api/src/services/tenantCascade.ts:525`, `apps/api/src/routes/devices/core.ts:319,564`, `apps/api/src/services/orgMergeRegistry.ts:850`, `apps/api/src/services/tenantExportPolicyRegistry.ts:307`, `apps/api/src/services/deviceDeletion.test.ts:74`, `apps/api/vitest.config.ts:56`, `apps/api/vitest.integration.config.ts:30`.

**Interfaces:** Produces `deviceTimeStatus`, `typeof deviceTimeStatus.$inferSelect`, and the SQL table specified by §D without `finding_streaks` or `enforcement`. Consumes existing `devices(id, org_id)`, `organizations.id`, `breeze_has_org_access(uuid)`, `tablePolicy`, and the dynamic `getDeviceCascadeDeleteTables()` deletion path (`services/deviceDeletion.ts:18,339–352`). Direct `org_id` RLS is auto-discovered; do not add a redundant join-policy allowlist entry. Existing test helpers are verified at `apps/api/src/__tests__/integration/db-utils.ts:176,216,295` (`createPartner`, `createOrganization`, `createSite`), `setup.ts:61` (`getTestDb`), `replayMigration.ts:85` (`replayMigration`), and `apps/api/src/utils/pgErrors.ts:3` (`pgErrorCode` re-export). `tablePolicy` is defined at `apps/api/src/services/tenantExportPolicyRegistry.ts:17`.

- [ ] Write `apps/api/src/services/timeSync/migrations.integration.test.ts`:

```ts
import '../../__tests__/integration/setup';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { devices } from '../../db/schema';
import { pgErrorCode } from '../../utils/pgErrors';
import {
  createPartner,
  createOrganization,
  createSite,
} from '../../__tests__/integration/db-utils';
import { getTestDb } from '../../__tests__/integration/setup';
import { replayMigration } from '../../__tests__/integration/replayMigration';
const system: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
};
async function fixture() {
  const partner = (await createPartner())!;
  const org = (await createOrganization({ partnerId: partner.id }))!;
  const other = (await createOrganization({ partnerId: partner.id }))!;
  const site = (await createSite({ orgId: org.id }))!;
  const [device] = await getTestDb()
    .insert(devices)
    .values({
      orgId: org.id,
      siteId: site.id,
      agentId: randomUUID(),
      hostname: 'time-fixture',
      osType: 'windows',
      osVersion: '1',
      architecture: 'x64',
      agentVersion: '1.0.0',
    })
    .returning();
  const context: DbAccessContext = {
    scope: 'organization',
    orgId: other.id,
    accessibleOrgIds: [other.id],
    accessiblePartnerIds: [],
    currentPartnerId: partner.id,
  };
  return { org, other, device: device!, context };
}
const insert = (deviceId: string, orgId: string) =>
  db.execute(sql`
  INSERT INTO device_time_status(device_id, org_id, collected_at, received_at)
  VALUES (${deviceId}, ${orgId}, now(), now())`);
it('forces RLS, four policies, three indexes and deferrable immediate ownership', async () => {
  const rows = await getTestDb().execute(sql`
    SELECT c.relrowsecurity, c.relforcerowsecurity, f.condeferrable, f.condeferred
    FROM pg_class c JOIN pg_constraint f ON f.conrelid=c.oid
    WHERE c.oid=to_regclass('device_time_status')
      AND f.conname='device_time_status_device_org_fkey'`);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    relrowsecurity: true,
    relforcerowsecurity: true,
    condeferrable: true,
    condeferred: false,
  });
  const policies = await getTestDb().execute(sql`
    SELECT cmd FROM pg_policies WHERE tablename='device_time_status' ORDER BY cmd`);
  expect(policies.map((p) => p.cmd)).toEqual([
    'DELETE',
    'INSERT',
    'SELECT',
    'UPDATE',
  ]);
  const indexes = await getTestDb().execute(sql`
    SELECT indexname FROM pg_indexes WHERE tablename='device_time_status'`);
  expect(indexes.map((i) => i.indexname)).toEqual(
    expect.arrayContaining([
      'device_time_status_org_health_idx',
      'device_time_status_org_domain_idx',
      'device_time_status_findings_gin',
    ]),
  );
});
it('denies forged ownership and cross-org CRUD under the app role', async () => {
  const f = await fixture();
  const [role] = await withDbAccessContext(f.context, () =>
    db.execute(sql`SELECT current_user AS name`),
  );
  expect(role!.name).toBe('breeze_app');
  await expect(
    withDbAccessContext(f.context, () => insert(f.device.id, f.org.id)),
  ).rejects.toSatisfy((e: unknown) => pgErrorCode(e) === '42501');
  await expect(
    withDbAccessContext(system, () => insert(f.device.id, f.other.id)),
  ).rejects.toSatisfy((e: unknown) => pgErrorCode(e) === '23503');
  await withDbAccessContext(system, () => insert(f.device.id, f.org.id));
  for (const query of [
    sql`SELECT * FROM device_time_status WHERE device_id=${f.device.id}`,
    sql`UPDATE device_time_status SET health='critical' WHERE device_id=${f.device.id} RETURNING *`,
    sql`DELETE FROM device_time_status WHERE device_id=${f.device.id} RETURNING *`,
  ])
    expect(
      await withDbAccessContext(f.context, () => db.execute(query)),
    ).toHaveLength(0);
  await expect(
    withDbAccessContext(system, () =>
      db.execute(sql`
    UPDATE device_time_status SET health='bad' WHERE device_id=${f.device.id}`),
    ),
  ).rejects.toSatisfy((e: unknown) => pgErrorCode(e) === '23514');
});
it('replaying the migration preserves observations and FK properties', async () => {
  const f = await fixture();
  await withDbAccessContext(system, () => insert(f.device.id, f.org.id));
  await replayMigration('2026-11-09-100000-time-sync-status.sql');
  await replayMigration('2026-11-09-100000-time-sync-status.sql');
  expect(
    await getTestDb().execute(sql`
    SELECT * FROM device_time_status WHERE device_id=${f.device.id}`),
  ).toHaveLength(1);
});
```

In `apps/api/src/services/deviceDeletion.test.ts:74`, replace the anchor:

```text
describe('deleteDeviceCascade lock ordering', () => {
```

with:

```ts
describe('deleteDeviceCascade lock ordering', () => {
  it('deletes time status once before the device through the central cascade', async () => {
    const { tx, statements } = captureTx();
    await deleteDeviceCascade(tx, 'device-1');
    const matches = statements.filter((s) => s.includes('device_time_status'));
    expect(matches).toHaveLength(1);
    expect(statements.indexOf(matches[0]!)).toBeLessThan(
      statements.indexOf('__DELETE_DEVICES_ROW__'),
    );
    expect(statements.findIndex((s) => s.includes('FOR UPDATE'))).toBeLessThan(
      statements.indexOf(matches[0]!),
    );
  });
```

- [ ] Run `cd apps/api && npx vitest run src/services/deviceDeletion.test.ts`.
  Expected FAIL: expected time-status deletion count 1, received 0. Register integration discovery below before running the real-DB test; before migration it fails because `device_time_status` is absent.

- [ ] Implement the complete migration:

```sql
CREATE TABLE IF NOT EXISTS device_time_status (
  device_id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  last_sequence bigint NOT NULL DEFAULT 0,
  collected_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  agent_version text,
  health text NOT NULL DEFAULT 'unknown',
  findings text[] NOT NULL DEFAULT '{}',
  finding_details jsonb NOT NULL DEFAULT '{}',
  sync_type text,
  ntp_server text,
  special_poll_interval_seconds integer,
  policy_managed boolean NOT NULL DEFAULT false,
  policy_managed_values text[] NOT NULL DEFAULT '{}',
  service_state text NOT NULL DEFAULT 'unknown',
  service_start_type text NOT NULL DEFAULT 'unknown',
  host_time_provider_enabled boolean,
  status_method text NOT NULL DEFAULT 'unavailable',
  source text,
  source_kind text NOT NULL DEFAULT 'unknown',
  last_successful_sync_at timestamptz,
  last_sync_error text,
  stratum integer,
  poll_interval_seconds integer,
  join_type text NOT NULL DEFAULT 'unknown',
  domain_role text NOT NULL DEFAULT 'unknown',
  domain_dns text,
  forest_dns text,
  pdc_name text,
  timezone_windows_id text,
  timezone_bias_minutes integer,
  timezone_auto_update text NOT NULL DEFAULT 'unknown',
  expected_timezone text,
  expected_timezone_windows_id text,
  expected_timezone_source text,
  event_marks jsonb NOT NULL DEFAULT '{}',
  recent_events jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT device_time_status_health_check CHECK (health IN ('healthy','warning','critical','unknown')),
  CONSTRAINT device_time_status_device_org_fkey FOREIGN KEY (device_id, org_id)
    REFERENCES devices(id, org_id) ON UPDATE CASCADE ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE
);
ALTER TABLE device_time_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_time_status FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
    AND tablename='device_time_status' AND policyname='device_time_status_select') THEN
    CREATE POLICY device_time_status_select ON device_time_status FOR SELECT
      USING (public.breeze_has_org_access(org_id));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
    AND tablename='device_time_status' AND policyname='device_time_status_insert') THEN
    CREATE POLICY device_time_status_insert ON device_time_status FOR INSERT
      WITH CHECK (public.breeze_has_org_access(org_id));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
    AND tablename='device_time_status' AND policyname='device_time_status_update') THEN
    CREATE POLICY device_time_status_update ON device_time_status FOR UPDATE
      USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public'
    AND tablename='device_time_status' AND policyname='device_time_status_delete') THEN
    CREATE POLICY device_time_status_delete ON device_time_status FOR DELETE
      USING (public.breeze_has_org_access(org_id));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS device_time_status_org_health_idx ON device_time_status(org_id, health);
CREATE INDEX IF NOT EXISTS device_time_status_org_domain_idx ON device_time_status(org_id, domain_dns, domain_role);
CREATE INDEX IF NOT EXISTS device_time_status_findings_gin ON device_time_status USING gin(findings);
```

Implement `apps/api/src/db/schema/timeSync.ts`:

```ts
import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  bigint,
  integer,
  boolean,
  jsonb,
  timestamp,
  foreignKey,
  index,
  check,
} from 'drizzle-orm/pg-core';
import { devices } from './devices';
import { organizations } from './orgs';
import type {
  TimeSyncHealth,
  TimeSyncFindingCode,
  TimeStatusSnapshot,
  TimeSyncType,
  TimeSyncServiceState,
  TimeSyncServiceStartType,
  TimeSyncStatusMethod,
  TimeSyncSourceKind,
  TimeSyncJoinType,
  TimeSyncDomainRole,
  TimeSyncAutoUpdate,
} from '@breeze/shared';
export const deviceTimeStatus = pgTable(
  'device_time_status',
  {
    deviceId: uuid('device_id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    lastSequence: bigint('last_sequence', { mode: 'number' })
      .notNull()
      .default(0),
    collectedAt: timestamp('collected_at', { withTimezone: true }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    agentVersion: text('agent_version'),
    health: text('health').$type<TimeSyncHealth>().notNull().default('unknown'),
    findings: text('findings')
      .$type<TimeSyncFindingCode>()
      .array()
      .notNull()
      .default([]),
    findingDetails: jsonb('finding_details')
      .$type<
        Partial<
          Record<TimeSyncFindingCode, Record<string, string | number | null>>
        >
      >()
      .notNull()
      .default({}),
    syncType: text('sync_type').$type<TimeSyncType>(),
    ntpServer: text('ntp_server'),
    specialPollIntervalSeconds: integer('special_poll_interval_seconds'),
    policyManaged: boolean('policy_managed').notNull().default(false),
    policyManagedValues: text('policy_managed_values')
      .array()
      .notNull()
      .default([]),
    serviceState: text('service_state')
      .$type<TimeSyncServiceState>()
      .notNull()
      .default('unknown'),
    serviceStartType: text('service_start_type')
      .$type<TimeSyncServiceStartType>()
      .notNull()
      .default('unknown'),
    hostTimeProviderEnabled: boolean('host_time_provider_enabled'),
    statusMethod: text('status_method')
      .$type<TimeSyncStatusMethod>()
      .notNull()
      .default('unavailable'),
    source: text('source'),
    sourceKind: text('source_kind')
      .$type<TimeSyncSourceKind>()
      .notNull()
      .default('unknown'),
    lastSuccessfulSyncAt: timestamp('last_successful_sync_at', {
      withTimezone: true,
    }),
    lastSyncError: text('last_sync_error'),
    stratum: integer('stratum'),
    pollIntervalSeconds: integer('poll_interval_seconds'),
    joinType: text('join_type')
      .$type<TimeSyncJoinType>()
      .notNull()
      .default('unknown'),
    domainRole: text('domain_role')
      .$type<TimeSyncDomainRole>()
      .notNull()
      .default('unknown'),
    domainDns: text('domain_dns'),
    forestDns: text('forest_dns'),
    pdcName: text('pdc_name'),
    timezoneWindowsId: text('timezone_windows_id'),
    timezoneBiasMinutes: integer('timezone_bias_minutes'),
    timezoneAutoUpdate: text('timezone_auto_update')
      .$type<TimeSyncAutoUpdate>()
      .notNull()
      .default('unknown'),
    expectedTimezone: text('expected_timezone'),
    expectedTimezoneWindowsId: text('expected_timezone_windows_id'),
    expectedTimezoneSource: text('expected_timezone_source'),
    eventMarks: jsonb('event_marks')
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    recentEvents: jsonb('recent_events')
      .$type<Array<Omit<TimeStatusSnapshot['events'][number], 'properties'>>>()
      .notNull()
      .default([]),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.deviceId, t.orgId],
      foreignColumns: [devices.id, devices.orgId],
      name: 'device_time_status_device_org_fkey',
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    check(
      'device_time_status_health_check',
      sql`${t.health} IN ('healthy','warning','critical','unknown')`,
    ),
    index('device_time_status_org_health_idx').on(t.orgId, t.health),
    index('device_time_status_org_domain_idx').on(
      t.orgId,
      t.domainDns,
      t.domainRole,
    ),
    index('device_time_status_findings_gin').using('gin', t.findings),
  ],
);
```

Drizzle has no deferrability builder in the current hardware template; SQL owns `DEFERRABLE INITIALLY IMMEDIATE`, verified above. No inner transaction or data writes occur in this migration.

Apply these exact anchored replacements:

`apps/api/src/db/schema/index.ts:16`, replace:

```text
export * from './hardwareHealth';
```

with:

```ts
export * from './hardwareHealth';
export * from './timeSync';
```

`apps/api/src/services/tenantCascade.ts:525`, replace:

```text
  'device_software_inventory_state',
```

with:

```ts
  'device_software_inventory_state',
  'device_time_status',
```

`apps/api/src/services/orgMergeRegistry.ts:850`, replace:

```text
  "device_software_inventory_state",
```

with:

```ts
  'device_software_inventory_state',
  'device_time_status',
```

`apps/api/src/routes/devices/core.ts:564`, replace:

```text
  'device_hardware_health',
```

with:

```ts
  'device_hardware_health',
  'device_time_status',
```

`apps/api/vitest.config.ts:56`, replace:

```text
      'src/services/hardwareHealth/**/*.integration.test.ts',
```

with:

```ts
      'src/services/hardwareHealth/**/*.integration.test.ts',
      'src/services/timeSync/**/*.integration.test.ts',
```

`apps/api/vitest.integration.config.ts:30`, replace:

```text
      'src/services/hardwareHealth/**/*.integration.test.ts',
```

with:

```ts
      'src/services/hardwareHealth/**/*.integration.test.ts',
      'src/services/timeSync/**/*.integration.test.ts',
```

`apps/api/src/routes/devices/core.ts:319`, replace:

```text
  'device_reliability', 'device_reliability_history', 'device_sessions', 'device_software_inventory_state',
```

with:

```ts
  'device_reliability',
  'device_reliability_history',
  'device_sessions',
  'device_software_inventory_state',
  'device_time_status',
```

`apps/api/src/services/tenantExportPolicyRegistry.ts:307`, replace:

```text
  "device_software_inventory_state": tablePolicy("org_id", {"included":["device_id","org_id","latest_observation_id","latest_accepted_observation_id","visible_observation_id","has_accepted_v2","visible_item_count","updated_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":[]}),
```

with:

```ts
  device_software_inventory_state: tablePolicy('org_id', {
    included: [
      'device_id',
      'org_id',
      'latest_observation_id',
      'latest_accepted_observation_id',
      'visible_observation_id',
      'has_accepted_v2',
      'visible_item_count',
      'updated_at',
    ],
    reviewedIncluded: [],
    excludedSensitive: [],
    excludedOpen: [],
  }),
  device_time_status: tablePolicy('org_id', {
    included: [
      'device_id',
      'org_id',
      'last_sequence',
      'collected_at',
      'received_at',
      'agent_version',
      'health',
      'findings',
      'sync_type',
      'ntp_server',
      'special_poll_interval_seconds',
      'policy_managed',
      'policy_managed_values',
      'service_state',
      'service_start_type',
      'host_time_provider_enabled',
      'status_method',
      'source',
      'source_kind',
      'last_successful_sync_at',
      'last_sync_error',
      'stratum',
      'poll_interval_seconds',
      'join_type',
      'domain_role',
      'domain_dns',
      'forest_dns',
      'pdc_name',
      'timezone_windows_id',
      'timezone_bias_minutes',
      'timezone_auto_update',
      'expected_timezone',
      'expected_timezone_windows_id',
      'expected_timezone_source',
      'created_at',
      'updated_at',
    ],
    reviewedIncluded: [],
    excludedSensitive: [],
    excludedOpen: ['finding_details', 'event_marks', 'recent_events'],
  }),
```

- [ ] Run the targeted cycle (real database required):

```bash
pnpm test-stack up
(cd apps/api && npx vitest run src/services/deviceDeletion.test.ts src/routes/devices/cascadeDelete.test.ts src/routes/devices/moveOrg.coverage.test.ts src/services/orgMerge.test.ts src/db/migrationRlsScope.test.ts)
(cd apps/api && npx vitest run --config vitest.integration.config.ts src/services/timeSync/migrations.integration.test.ts)
pnpm db:check-drift
```

Expected PASS: four forced policies, cross-org CRUD isolation, 23503 wrong owner, 23514 invalid health, idempotent replay, dynamic delete and move/merge registration. Leave stack up for Task 5; Task 11 always tears it down.

- [ ] Commit:

```bash
git add apps/api/migrations/2026-11-09-100000-time-sync-status.sql apps/api/src/db/schema/timeSync.ts apps/api/src/db/schema/index.ts apps/api/src/services/tenantCascade.ts apps/api/src/routes/devices/core.ts apps/api/src/services/orgMergeRegistry.ts apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/services/deviceDeletion.test.ts apps/api/src/services/timeSync/migrations.integration.test.ts apps/api/vitest.config.ts apps/api/vitest.integration.config.ts
git commit -m "feat(time-sync): persist tenant-isolated device status" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 4: Resolve expected timezone, findings, and freshness

**Files:** Create `apps/api/src/services/timeSync/{expectedTimezone,findings,freshness}.ts`, their adjacent `.test.ts` files, and `testFixtures.ts`.

**Interfaces:** Consumes Task 1 constants/`TimeStatusSnapshot` and Task 2 mapping. Produces index §C.2 `ExpectedTimezone`, `ExpectedTimezoneInput`, `resolveExpectedTimezone(input: ExpectedTimezoneInput): ExpectedTimezone | null`; §C.3 `EventMarks`, `TimeSyncFinding`, `TimeFindingsContext`, `TimeFindingsResult`, `resolveTimeFindings(snapshot: TimeStatusSnapshot, ctx: TimeFindingsContext): TimeFindingsResult`; local helper `isTimeStatusStale(receivedAt: Date, now: Date): boolean`. `healthForFindings` is an exported local helper for Task 6, not a new wire field.

- [ ] Create the complete typed test fixture `testFixtures.ts`:

```ts
import type { TimeStatusSnapshot } from '@breeze/shared';
export const NOW = new Date('2026-09-28T10:40:00Z');
export function snapshot(): TimeStatusSnapshot {
  return {
    schemaVersion: 1,
    sequence: 1,
    collectedAt: NOW.toISOString(),
    config: {
      type: 'NTP',
      ntpServer: 'pool.ntp.org,0x9',
      specialPollIntervalSeconds: 3600,
      policyManaged: false,
      policyManagedValues: [],
      serviceState: 'running',
      serviceStartType: 'auto',
      hostTimeProviderEnabled: false,
    },
    status: {
      method: 'provider_api',
      source: 'pool.ntp.org',
      sourceKind: 'ntp_peer',
      lastSuccessfulSyncAt: '2026-09-28T09:00:00Z',
      lastSyncError: null,
      stratum: 3,
      pollIntervalSeconds: 3600,
    },
    domain: {
      joinType: 'none',
      role: 'workgroup',
      domainDns: null,
      forestDns: null,
      pdcName: null,
    },
    timezone: {
      windowsId: 'Pacific Standard Time',
      biasMinutes: 480,
      dynamicDstDisabled: false,
      autoUpdate: 'off',
    },
    events: [],
    enforcement: null,
  };
}
export function event(
  eventId: number,
  occurredAt: string,
  recordId = eventId,
): TimeStatusSnapshot['events'][number] {
  return {
    eventId,
    occurredAt,
    recordId,
    level: 2,
    message: 'Display-only message',
    properties: ['peer.example.com'],
  };
}
```

Write `expectedTimezone.test.ts`:

```ts
import { expect, it, vi } from 'vitest';
import { resolveExpectedTimezone } from './expectedTimezone';
const site = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Main',
  timezone: 'America/Detroit',
};
it('resolves aliases in Windows space and retains site provenance', () => {
  expect(resolveExpectedTimezone({ site })).toEqual({
    iana: 'America/Detroit',
    windowsId: 'Eastern Standard Time',
    source: 'site',
    sourceId: site.id,
    sourceName: 'Main',
  });
});
it.each(['UTC', 'Etc/UTC', null])('treats site %s as unset', (timezone) => {
  expect(resolveExpectedTimezone({ site: { ...site, timezone } })).toBeNull();
});
it('handles no site and warns once for an unmapped zone', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect(resolveExpectedTimezone({ site: null })).toBeNull();
  for (let i = 0; i < 2; i++)
    expect(
      resolveExpectedTimezone({ site: { ...site, timezone: 'Unmapped/Test' } }),
    ).toBeNull();
  expect(warn).toHaveBeenCalledTimes(1);
  warn.mockRestore();
});
it('reserves pinned policy precedence, including pinned UTC, with site fallback', () => {
  const policy = {
    policyId: '22222222-2222-4222-8222-222222222222',
    policyName: 'Regional',
    expected: 'pinned' as const,
    pinnedTimezone: 'UTC',
  };
  expect(resolveExpectedTimezone({ site, policy })).toMatchObject({
    windowsId: 'UTC',
    source: 'policy',
    sourceId: policy.policyId,
  });
  expect(
    resolveExpectedTimezone({
      site,
      policy: { ...policy, pinnedTimezone: null },
    }),
  ).toMatchObject({ source: 'site' });
});
```

Write `freshness.test.ts`:

```ts
import { expect, it } from 'vitest';
import { isTimeStatusStale } from './freshness';
it('is fresh exactly at 90 minutes and stale one millisecond later', () => {
  const received = new Date('2026-09-28T00:00:00Z');
  expect(isTimeStatusStale(received, new Date(+received + 5_400_000))).toBe(
    false,
  );
  expect(isTimeStatusStale(received, new Date(+received + 5_400_001))).toBe(
    true,
  );
});
```

Write `findings.test.ts`:

```ts
import { expect, it } from 'vitest';
import {
  TIME_SYNC_FINDING_CODES,
  type TimeStatusSnapshot,
  type TimeSyncFindingCode,
} from '@breeze/shared';
import { resolveTimeFindings, type TimeFindingsContext } from './findings';
import { resolveExpectedTimezone } from './expectedTimezone';
import { NOW, snapshot, event } from './testFixtures';
const base: TimeFindingsContext = {
  now: NOW,
  expectedTimezone: null,
  previousEventMarks: {},
};
const codes = (s: TimeStatusSnapshot, ctx = base) =>
  resolveTimeFindings(s, ctx).findings.map((f) => f.code);
const cases: Array<[TimeSyncFindingCode, (s: TimeStatusSnapshot) => void]> = [
  [
    'pdc_no_external_source',
    (s) => {
      s.domain.role = 'forest_root_pdc_emulator';
      s.config.type = 'NT5DS';
    },
  ],
  [
    'source_local_clock',
    (s) => {
      s.status.sourceKind = 'local_clock';
    },
  ],
  [
    'dc_vm_host_sync',
    (s) => {
      s.domain.role = 'dc';
      s.config.type = 'NT5DS';
      s.config.hostTimeProviderEnabled = true;
    },
  ],
  [
    'ntp_server_unresolvable',
    (s) => {
      s.config.ntpServer = 'bad;host';
    },
  ],
  [
    'ntp_peer_unreachable',
    (s) => {
      s.events = [event(47, NOW.toISOString())];
    },
  ],
  [
    'domain_source_unavailable',
    (s) => {
      s.events = [event(129, NOW.toISOString())];
    },
  ],
  [
    'member_not_on_hierarchy',
    (s) => {
      s.domain.role = 'member';
    },
  ],
  [
    'sync_disabled',
    (s) => {
      s.config.type = 'NoSync';
    },
  ],
  [
    'sync_stale',
    (s) => {
      s.status.lastSuccessfulSyncAt = '2026-09-26T00:00:00Z';
    },
  ],
  [
    'correction_refused',
    (s) => {
      s.events = [event(52, NOW.toISOString())];
    },
  ],
];
it.each(cases)(
  'raises %s with one deterministic detail object',
  (code, mutate) => {
    const s = snapshot();
    mutate(s);
    const result = resolveTimeFindings(s, base);
    expect(result.findings.filter((f) => f.code === code)).toHaveLength(1);
    expect(result.findings.find((f) => f.code === code)!.detail).toBeTypeOf(
      'object',
    );
  },
);
it('reactivates a failure after success using the latest mark, independent of event order/message', () => {
  const s = snapshot();
  s.events = [
    event(134, '2026-09-28T10:00:00Z'),
    event(37, '2026-09-28T10:05:00Z'),
  ];
  const cleared = resolveTimeFindings(s, {
    ...base,
    now: new Date('2026-09-28T10:10:00Z'),
  });
  expect(cleared.findings.map((f) => f.code)).not.toContain(
    'ntp_server_unresolvable',
  );
  s.events = [event(134, '2026-09-28T10:40:00Z', 200)];
  const active = resolveTimeFindings(s, {
    ...base,
    previousEventMarks: cleared.eventMarks,
  });
  expect(active.findings.map((f) => f.code)).toContain(
    'ntp_server_unresolvable',
  );
  s.events[0]!.message = 'Nicht aufgelöst';
  expect(
    resolveTimeFindings(s, { ...base, previousEventMarks: cleared.eventMarks }),
  ).toEqual(active);
  s.events = [];
  expect(
    codes(s, { ...base, previousEventMarks: active.eventMarks }),
  ).toContain('ntp_server_unresolvable');
});
it('keeps maximum marks, expires at seven days, and clears at equal success', () => {
  const s = snapshot();
  s.status.lastSuccessfulSyncAt = null;
  s.events = [
    event(134, '2026-09-27T10:40:00Z'),
    event(134, '2026-09-27T10:00:00Z'),
  ];
  const r = resolveTimeFindings(s, {
    ...base,
    previousEventMarks: {
      '12': '2026-09-21T10:39:59Z',
      '52': '2026-09-21T10:40:00Z',
    },
  });
  expect(r.eventMarks['12']).toBeUndefined();
  expect(r.eventMarks['52']).toBeDefined();
  expect(r.findings.map((f) => f.code)).toContain('ntp_server_unresolvable');
  expect(codes(s, { ...base, now: new Date(+NOW + 1) })).not.toContain(
    'ntp_server_unresolvable',
  );
  s.events.push(event(35, '2026-09-27T10:40:00Z'));
  expect(codes(s)).not.toContain('ntp_server_unresolvable');
});
it('does not interpret flags or display text as DNS failure', () => {
  const s = snapshot();
  s.config.ntpServer = '  time.a.com,0x9   time.b.com,0x8  ';
  s.events = [
    { ...event(35, NOW.toISOString()), message: 'DNS failed NTP error' },
  ];
  expect(codes(s)).not.toContain('ntp_server_unresolvable');
  s.config.ntpServer = 'time.a.com,0x1,0x8';
  expect(codes(s)).not.toContain('ntp_server_unresolvable');
  s.config.type = 'NT5DS';
  s.config.ntpServer = 'bad;host';
  expect(codes(s)).not.toContain('ntp_server_unresolvable');
});
it('applies poll fallback, threshold equality and disabled suppression', () => {
  const s = snapshot();
  s.status.pollIntervalSeconds = null;
  s.config.specialPollIntervalSeconds = null;
  s.status.lastSuccessfulSyncAt = new Date(
    +NOW - 21 * 86_400_000,
  ).toISOString();
  expect(codes(s)).not.toContain('sync_stale');
  s.status.lastSuccessfulSyncAt = new Date(
    +NOW - 21 * 86_400_000 - 1,
  ).toISOString();
  expect(codes(s)).toContain('sync_stale');
  s.config.serviceStartType = 'disabled';
  s.events = [event(36, NOW.toISOString())];
  expect(codes(s)).toContain('sync_disabled');
  expect(codes(s)).not.toContain('sync_stale');
  s.config.serviceStartType = 'auto';
  s.status.lastSuccessfulSyncAt = null;
  s.events = [];
  expect(codes(s)).not.toContain('sync_stale');
});
it('limits role/config findings and does not implement W03 enforcement', () => {
  const s = snapshot();
  s.domain.role = 'member';
  s.config.policyManaged = true;
  expect(codes(s)).not.toContain('member_not_on_hierarchy');
  s.domain.role = 'pdc_emulator';
  s.config.type = 'NT5DS';
  s.events = [event(12, NOW.toISOString())];
  expect(codes(s)).not.toContain('pdc_no_external_source');
  const ctx = {
    ...base,
    enforcementSettings: { enforceNtp: true, timezoneAutoFix: true },
  };
  expect(codes(s, ctx)).not.toContain('policy_not_applied');
  expect(codes(s, ctx)).not.toContain('policy_conflict_gpo');
});
it('compares Windows IDs, suppresses auto timezone, respects UTC default and info-only health', () => {
  const s = snapshot();
  const site = {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Main',
    timezone: 'UTC',
  };
  expect(
    codes(s, { ...base, expectedTimezone: resolveExpectedTimezone({ site }) }),
  ).not.toContain('timezone_mismatch');
  const expectedTimezone = resolveExpectedTimezone({
    site: { ...site, timezone: 'America/Detroit' },
  });
  const ctx = { ...base, expectedTimezone };
  s.status.method = 'unavailable';
  expect(resolveTimeFindings(s, ctx)).toMatchObject({
    health: 'healthy',
    findings: [
      {
        code: 'timezone_mismatch',
        detail: {
          actual: 'Pacific Standard Time',
          expected: 'Eastern Standard Time',
          expectedIana: 'America/Detroit',
          expectedSource: 'site',
          expectedSourceName: 'Main',
        },
      },
    ],
  });
  s.timezone.windowsId = 'Eastern Standard Time';
  expect(resolveTimeFindings(s, ctx).health).toBe('unknown');
  s.timezone.windowsId = 'Pacific Standard Time';
  s.timezone.autoUpdate = 'on';
  expect(codes(s, ctx)).not.toContain('timezone_mismatch');
});
it.each([
  [
    12,
    'forest_root_pdc_emulator',
    'pdc_no_external_source',
    { domainDns: null },
  ],
  [24, 'workgroup', 'ntp_peer_unreachable', { source: 'peer.example.com' }],
  [29, 'workgroup', 'ntp_peer_unreachable', { source: 'peer.example.com' }],
  [47, 'workgroup', 'ntp_peer_unreachable', { source: 'peer.example.com' }],
  [129, 'workgroup', 'domain_source_unavailable', { domainDns: null }],
  [134, 'workgroup', 'ntp_server_unresolvable', { host: 'peer.example.com' }],
  [52, 'workgroup', 'correction_refused', { occurredAt: NOW.toISOString() }],
] as const)(
  'maps active event %i with exact details',
  (id, role, code, detail) => {
    const s = snapshot();
    s.domain.role = role;
    s.events = [event(id, NOW.toISOString())];
    expect(resolveTimeFindings(s, base).findings).toContainEqual({
      code,
      detail,
      severity: code === 'pdc_no_external_source' ? 'critical' : 'warning',
    });
    s.status.lastSuccessfulSyncAt = NOW.toISOString();
    expect(codes(s)).not.toContain(code);
  },
);
it.each([
  'workgroup',
  'entra_only',
  'member',
  'dc',
  'pdc_emulator',
  'forest_root_pdc_emulator',
  'unknown',
] as const)('pins hierarchy and VM-provider guards for role %s', (role) => {
  const s = snapshot();
  s.domain.role = role;
  s.status.sourceKind = 'vm_host';
  expect(codes(s).includes('dc_vm_host_sync')).toBe(
    ['dc', 'pdc_emulator', 'forest_root_pdc_emulator'].includes(role),
  );
  expect(codes(s).includes('member_not_on_hierarchy')).toBe(
    ['member', 'dc', 'pdc_emulator'].includes(role),
  );
  s.config.policyManaged = true;
  expect(codes(s)).not.toContain('member_not_on_hierarchy');
  s.config.policyManaged = false;
  s.config.type = 'AllSync';
  expect(codes(s)).not.toContain('member_not_on_hierarchy');
});
it('pins remaining static details, severities and AllSync validation', () => {
  const s = snapshot();
  s.domain.role = 'member';
  s.status.sourceKind = 'local_clock';
  s.config.type = 'AllSync';
  s.config.ntpServer = 'bad;host';
  expect(resolveTimeFindings(s, base).findings).toEqual([
    {
      code: 'source_local_clock',
      severity: 'critical',
      detail: { source: 'pool.ntp.org', sourceKind: 'local_clock' },
    },
    {
      code: 'ntp_server_unresolvable',
      severity: 'warning',
      detail: { host: 'bad;host' },
    },
  ]);
  s.status.sourceKind = 'ntp_peer';
  s.config.type = 'NoSync';
  expect(resolveTimeFindings(s, base).findings).toContainEqual({
    code: 'sync_disabled',
    severity: 'critical',
    detail: { reason: 'no_sync' },
  });
  s.config.type = 'NTP';
  s.config.serviceStartType = 'disabled';
  expect(resolveTimeFindings(s, base).findings).toContainEqual({
    code: 'sync_disabled',
    severity: 'critical',
    detail: { reason: 'service_disabled' },
  });
  s.config.serviceStartType = 'auto';
  s.config.ntpServer = 'pool.ntp.org';
  s.status.lastSuccessfulSyncAt = '2026-09-26T00:00:00Z';
  expect(resolveTimeFindings(s, base).findings).toContainEqual({
    code: 'sync_stale',
    severity: 'warning',
    detail: {
      lastSuccessfulSyncAt: '2026-09-26T00:00:00Z',
      thresholdHours: 24,
    },
  });
  expect(resolveTimeFindings(s, base).findings).toContainEqual({
    code: 'member_not_on_hierarchy',
    severity: 'warning',
    detail: { type: 'NTP' },
  });
  s.domain.role = 'dc';
  s.config.hostTimeProviderEnabled = true;
  expect(resolveTimeFindings(s, base).findings).toContainEqual({
    code: 'dc_vm_host_sync',
    severity: 'warning',
    detail: { role: 'dc' },
  });
});
it('orders codes once and derives worst health', () => {
  const s = snapshot();
  s.config.type = 'NoSync';
  s.status.sourceKind = 'free_running';
  s.events = [event(47, NOW.toISOString()), event(24, NOW.toISOString())];
  const r = resolveTimeFindings(s, base);
  expect(r.health).toBe('critical');
  expect(r.findings.map((f) => f.code)).toEqual(
    TIME_SYNC_FINDING_CODES.filter((c) =>
      ['source_local_clock', 'ntp_peer_unreachable', 'sync_disabled'].includes(
        c,
      ),
    ),
  );
});
```

- [ ] Run `cd apps/api && npx vitest run src/services/timeSync/expectedTimezone.test.ts src/services/timeSync/findings.test.ts src/services/timeSync/freshness.test.ts`; expected FAIL: missing resolver modules.

- [ ] Implement `expectedTimezone.ts`:

```ts
import {
  ianaToWindowsZone,
  TIME_SYNC_UNSET_SITE_TIMEZONES,
} from '@breeze/shared';
export interface ExpectedTimezone {
  iana: string;
  windowsId: string;
  source: 'policy' | 'site';
  sourceId: string;
  sourceName: string | null;
}
export interface ExpectedTimezoneInput {
  site: { id: string; name: string | null; timezone: string | null } | null;
  policy?: {
    policyId: string;
    policyName: string | null;
    expected: 'site' | 'pinned';
    pinnedTimezone: string | null;
  } | null;
}
const warned = new Set<string>();
function mapped(iana: string): string | null {
  const windowsId = ianaToWindowsZone(iana);
  if (!windowsId && !warned.has(iana)) {
    warned.add(iana);
    console.warn('[time-sync] unmapped expected timezone', { iana });
  }
  return windowsId;
}
export function resolveExpectedTimezone(
  input: ExpectedTimezoneInput,
): ExpectedTimezone | null {
  const { policy, site } = input;
  if (policy?.expected === 'pinned' && policy.pinnedTimezone) {
    const windowsId = mapped(policy.pinnedTimezone);
    if (windowsId)
      return {
        iana: policy.pinnedTimezone,
        windowsId,
        source: 'policy',
        sourceId: policy.policyId,
        sourceName: policy.policyName,
      };
  }
  if (
    !site?.timezone ||
    (TIME_SYNC_UNSET_SITE_TIMEZONES as readonly string[]).includes(
      site.timezone,
    )
  )
    return null;
  const windowsId = mapped(site.timezone);
  return windowsId
    ? {
        iana: site.timezone,
        windowsId,
        source: 'site',
        sourceId: site.id,
        sourceName: site.name,
      }
    : null;
}
```

The result is deterministic and DB-free; the warn-once diagnostic is the explicit side effect required by the contract. Contract issue 2 records the conflict with the word “pure”.

Implement `freshness.ts`:

```ts
import { TIME_SYNC_STALE_AFTER_MS } from '@breeze/shared';
export function isTimeStatusStale(receivedAt: Date, now: Date): boolean {
  return now.getTime() - receivedAt.getTime() > TIME_SYNC_STALE_AFTER_MS;
}
```

Implement `findings.ts`:

```ts
import {
  TIME_SYNC_FINDING_CODES,
  TIME_SYNC_FINDING_SEVERITY,
  TIME_SYNC_EVENT_ACTIVE_WINDOW_MS,
  TIME_SYNC_DEFAULT_POLL_SECONDS,
  parseNtpServerHosts,
  isValidNtpServerHost,
  type TimeStatusSnapshot,
  type TimeSyncFindingCode,
  type TimeSyncFindingSeverity,
  type TimeSyncHealth,
  type TimeSyncStatusMethod,
} from '@breeze/shared';
import type { ExpectedTimezone } from './expectedTimezone';
export type EventMarks = Record<string, string>;
export interface TimeSyncFinding {
  code: TimeSyncFindingCode;
  severity: TimeSyncFindingSeverity;
  detail: Record<string, string | number | null>;
}
export interface TimeFindingsContext {
  now: Date;
  expectedTimezone: ExpectedTimezone | null;
  previousEventMarks: EventMarks;
  enforcementSettings?: {
    enforceNtp: boolean;
    timezoneAutoFix: boolean;
  } | null;
}
export interface TimeFindingsResult {
  health: TimeSyncHealth;
  findings: TimeSyncFinding[];
  eventMarks: EventMarks;
}
export function healthForFindings(
  findings: TimeSyncFinding[],
  method: TimeSyncStatusMethod,
): TimeSyncHealth {
  if (findings.some((f) => f.severity === 'critical')) return 'critical';
  if (findings.some((f) => f.severity === 'warning')) return 'warning';
  return method === 'unavailable' && findings.length === 0
    ? 'unknown'
    : 'healthy';
}
export function resolveTimeFindings(
  snapshot: TimeStatusSnapshot,
  ctx: TimeFindingsContext,
): TimeFindingsResult {
  const { config, status, domain, timezone, events } = snapshot;
  const marks: EventMarks = { ...ctx.previousEventMarks };
  const time = (value: string | null | undefined) =>
    value ? Date.parse(value) : -Infinity;
  for (const event of events) {
    const key = String(event.eventId);
    if (time(event.occurredAt) > time(marks[key]))
      marks[key] = event.occurredAt;
  }
  for (const [key, mark] of Object.entries(marks)) {
    if (!Number.isFinite(time(mark)) || +ctx.now - time(mark) > 7 * 86_400_000)
      delete marks[key];
  }
  const success = Math.max(
    time(marks['35']),
    time(marks['37']),
    time(status.lastSuccessfulSyncAt),
  );
  const active = (id: number) =>
    +ctx.now - time(marks[String(id)]) <= TIME_SYNC_EVENT_ACTIVE_WINDOW_MS &&
    time(marks[String(id)]) > success;
  const property = (ids: number[]) =>
    events
      .filter((e) => ids.includes(e.eventId) && active(e.eventId))
      .sort((a, b) => time(b.occurredAt) - time(a.occurredAt))[0]
      ?.properties[0] ?? null;
  const found = new Map<TimeSyncFindingCode, TimeSyncFinding>();
  const add = (
    code: TimeSyncFindingCode,
    detail: TimeSyncFinding['detail'],
  ) => {
    found.set(code, {
      code,
      severity: TIME_SYNC_FINDING_SEVERITY[code],
      detail,
    });
  };
  if (
    domain.role === 'forest_root_pdc_emulator' &&
    (config.type === 'NT5DS' || active(12))
  )
    add('pdc_no_external_source', { domainDns: domain.domainDns });
  if (
    status.sourceKind === 'local_clock' ||
    status.sourceKind === 'free_running'
  )
    add('source_local_clock', {
      source: status.source,
      sourceKind: status.sourceKind,
    });
  if (
    ['dc', 'pdc_emulator', 'forest_root_pdc_emulator'].includes(domain.role) &&
    (config.hostTimeProviderEnabled === true || status.sourceKind === 'vm_host')
  )
    add('dc_vm_host_sync', { role: domain.role });
  const badHost =
    config.type === 'NTP' || config.type === 'AllSync'
      ? parseNtpServerHosts(config.ntpServer).find(
          (host) => !isValidNtpServerHost(host),
        )
      : undefined;
  if (badHost !== undefined || active(134))
    add('ntp_server_unresolvable', { host: badHost ?? property([134]) });
  if ([24, 29, 47].some(active))
    add('ntp_peer_unreachable', {
      source: property([24, 29, 47]) ?? status.source,
    });
  if (active(129))
    add('domain_source_unavailable', { domainDns: domain.domainDns });
  if (
    ['member', 'dc', 'pdc_emulator'].includes(domain.role) &&
    config.type !== 'NT5DS' &&
    config.type !== 'AllSync' &&
    !config.policyManaged
  )
    add('member_not_on_hierarchy', { type: config.type });
  const disabled =
    config.type === 'NoSync' || config.serviceStartType === 'disabled';
  if (disabled)
    add('sync_disabled', {
      reason: config.type === 'NoSync' ? 'no_sync' : 'service_disabled',
    });
  const poll =
    status.pollIntervalSeconds ??
    config.specialPollIntervalSeconds ??
    TIME_SYNC_DEFAULT_POLL_SECONDS;
  const threshold = Math.max(3 * poll * 1000, 86_400_000);
  if (
    !disabled &&
    ((status.lastSuccessfulSyncAt !== null &&
      +ctx.now - time(status.lastSuccessfulSyncAt) > threshold) ||
      active(36))
  )
    add('sync_stale', {
      lastSuccessfulSyncAt: status.lastSuccessfulSyncAt,
      thresholdHours: threshold / 3_600_000,
    });
  if (active(52))
    add('correction_refused', { occurredAt: marks['52'] ?? null });
  const expected = ctx.expectedTimezone;
  if (
    expected &&
    timezone.autoUpdate !== 'on' &&
    timezone.windowsId !== expected.windowsId
  )
    add('timezone_mismatch', {
      actual: timezone.windowsId,
      expected: expected.windowsId,
      expectedIana: expected.iana,
      expectedSource: expected.source,
      expectedSourceName: expected.sourceName,
    });
  const findings = TIME_SYNC_FINDING_CODES.flatMap((code) =>
    found.has(code) ? [found.get(code)!] : [],
  );
  return {
    health: healthForFindings(findings, status.method),
    findings,
    eventMarks: marks,
  };
}
```

- [ ] Run `cd apps/api && npx vitest run src/services/timeSync/expectedTimezone.test.ts src/services/timeSync/findings.test.ts src/services/timeSync/freshness.test.ts`; expected PASS, including exact focus 1/3/4 timestamps and UTC behavior.
- [ ] Commit:

```bash
git add apps/api/src/services/timeSync/expectedTimezone.ts apps/api/src/services/timeSync/findings.ts apps/api/src/services/timeSync/freshness.ts apps/api/src/services/timeSync/expectedTimezone.test.ts apps/api/src/services/timeSync/findings.test.ts apps/api/src/services/timeSync/freshness.test.ts apps/api/src/services/timeSync/testFixtures.ts
git commit -m "feat(time-sync): resolve time findings and expected timezone" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 5: Ingest snapshots atomically with reset and concurrency guarantees

**Files:** Create `apps/api/src/services/timeSync/ingest.ts`, `apps/api/src/services/timeSync/ingest.integration.test.ts`.

**Interfaces:** Consumes Tasks 1–4 and `withDbTransaction<T>(fn: () => Promise<T>): Promise<T>` (`apps/api/src/db/index.ts:1033`). Produces exact §C.5 `IngestTimeStatusResult` and `ingestTimeStatusSnapshot(args: { deviceId: string; orgId: string; agentVersion: string | null; snapshot: TimeStatusSnapshot; receivedAt: Date }): Promise<IngestTimeStatusResult>`. Local exported `buildTimeStatusRow` maps a validated snapshot into the typed row for persistence and Task 6 fixtures.

- [ ] Write `ingest.integration.test.ts`:

```ts
import '../../__tests__/integration/setup';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { withDbAccessContext } from '../../db';
import { devices, deviceTimeStatus } from '../../db/schema';
import { getTestDb } from '../../__tests__/integration/setup';
import {
  createPartner,
  createOrganization,
  createSite,
} from '../../__tests__/integration/db-utils';
import { ingestTimeStatusSnapshot } from './ingest';
import { snapshot, event, NOW } from './testFixtures';
async function fixture() {
  const partner = (await createPartner())!;
  const org = (await createOrganization({ partnerId: partner.id }))!;
  const site = (await createSite({
    orgId: org.id,
    timezone: 'America/New_York',
  }))!;
  const [device] = await getTestDb()
    .insert(devices)
    .values({
      orgId: org.id,
      siteId: site.id,
      agentId: randomUUID(),
      hostname: 'time-fixture',
      osType: 'windows',
      osVersion: '1',
      architecture: 'x64',
      agentVersion: '1.0.0',
    })
    .returning();
  const ctx = {
    scope: 'organization' as const,
    orgId: org.id,
    accessibleOrgIds: [org.id],
    currentPartnerId: partner.id,
  };
  const send = (sequence: number, collectedAt: Date, receivedAt = NOW) =>
    withDbAccessContext(ctx, () =>
      ingestTimeStatusSnapshot({
        deviceId: device!.id,
        orgId: org.id,
        agentVersion: '1.0.0',
        snapshot: {
          ...snapshot(),
          sequence,
          collectedAt: collectedAt.toISOString(),
        },
        receivedAt,
      }),
    );
  const row = async () =>
    (
      await getTestDb()
        .select()
        .from(deviceTimeStatus)
        .where(eq(deviceTimeStatus.deviceId, device!.id))
    )[0]!;
  return { partner, org, site, device: device!, ctx, send, row };
}
it('serializes concurrent first snapshots and leaves duplicate state untouched', async () => {
  const f = await fixture();
  const results = await Promise.all([f.send(50, NOW), f.send(50, NOW)]);
  expect(results.filter((r) => r.accepted)).toHaveLength(1);
  expect(results.filter((r) => !r.accepted)).toEqual([
    { accepted: false, reason: 'stale_sequence' },
  ]);
  const first = await f.row();
  expect(first).toMatchObject({
    lastSequence: 50,
    expectedTimezone: 'America/New_York',
    expectedTimezoneWindowsId: 'Eastern Standard Time',
    expectedTimezoneSource: `site:${f.site.id}`,
  });
  expect(await f.send(50, NOW, new Date(+NOW + 10_000))).toEqual({
    accepted: false,
    reason: 'stale_sequence',
  });
  expect(await f.row()).toEqual(first);
});
it('uses collected time, strict one-hour reset boundary, and serializes restart duplicates', async () => {
  const f = await fixture();
  await f.send(50, NOW);
  expect((await f.send(0, NOW, new Date(+NOW + 86_400_000))).accepted).toBe(
    false,
  );
  expect((await f.send(0, new Date(+NOW + 3_600_000))).accepted).toBe(false);
  const reset = new Date(+NOW + 3_600_001);
  const race = await Promise.all([f.send(0, reset), f.send(0, reset)]);
  expect(race.filter((r) => r.accepted)).toHaveLength(1);
  expect(await f.row()).toMatchObject({ lastSequence: 0, collectedAt: reset });
  expect((await f.send(1, reset)).accepted).toBe(true);
});
it('rejects foreign device/org combinations before any status write', async () => {
  const f = await fixture();
  const other = (await createOrganization({ partnerId: f.partner.id }))!;
  const ctx = { ...f.ctx, orgId: other.id, accessibleOrgIds: [other.id] };
  await expect(
    withDbAccessContext(ctx, () =>
      ingestTimeStatusSnapshot({
        deviceId: f.device.id,
        orgId: f.org.id,
        agentVersion: null,
        snapshot: snapshot(),
        receivedAt: NOW,
      }),
    ),
  ).rejects.toThrow('Time status device missing or ownership changed');
  expect(await f.row()).toBeUndefined();
});
it('bounds and deduplicates event display data while persisting marks', async () => {
  const f = await fixture();
  const s = snapshot();
  s.events = Array.from({ length: 25 }, (_, i) =>
    event(134, new Date(+NOW - i * 1000).toISOString(), i),
  );
  const send = () =>
    withDbAccessContext(f.ctx, () =>
      ingestTimeStatusSnapshot({
        deviceId: f.device.id,
        orgId: f.org.id,
        agentVersion: null,
        snapshot: s,
        receivedAt: NOW,
      }),
    );
  await send();
  const first = await f.row();
  expect(first.recentEvents).toHaveLength(20);
  expect(first.recentEvents[0]).not.toHaveProperty('properties');
  expect(first.eventMarks['134']).toBe(NOW.toISOString());
  s.sequence = 2;
  s.events = [event(134, NOW.toISOString(), 0)];
  await send();
  expect((await f.row()).recentEvents).toHaveLength(20);
});
```

- [ ] Run `cd apps/api && npx vitest run --config vitest.integration.config.ts src/services/timeSync/ingest.integration.test.ts`; expected FAIL: missing `./ingest`.

- [ ] Implement `ingest.ts`:

```ts
import { and, eq } from 'drizzle-orm';
import {
  TIME_SYNC_RECENT_EVENTS_MAX,
  type TimeStatusSnapshot,
  type TimeSyncHealth,
} from '@breeze/shared';
import { db, withDbTransaction } from '../../db';
import { deviceTimeStatus, devices, sites } from '../../db/schema';
import {
  resolveExpectedTimezone,
  type ExpectedTimezone,
} from './expectedTimezone';
import { resolveTimeFindings, type TimeFindingsResult } from './findings';
type StatusRow = typeof deviceTimeStatus.$inferSelect;
export interface IngestTimeStatusResult {
  accepted: boolean;
  reason?: 'stale_sequence';
  health?: TimeSyncHealth;
}
type IngestArgs = {
  deviceId: string;
  orgId: string;
  agentVersion: string | null;
  snapshot: TimeStatusSnapshot;
  receivedAt: Date;
};
export function buildTimeStatusRow(
  args: IngestArgs,
  previous: StatusRow | undefined,
  expected: ExpectedTimezone | null,
  resolved: TimeFindingsResult,
): StatusRow {
  const { snapshot: s, receivedAt } = args;
  const events = new Map<number, StatusRow['recentEvents'][number]>();
  for (const e of [...(previous?.recentEvents ?? []), ...s.events]) {
    const existing = events.get(e.recordId);
    if (
      !existing ||
      Date.parse(e.occurredAt) >= Date.parse(existing.occurredAt)
    )
      events.set(e.recordId, {
        recordId: e.recordId,
        eventId: e.eventId,
        level: e.level,
        occurredAt: e.occurredAt,
        message: e.message,
      });
  }
  return {
    deviceId: args.deviceId,
    orgId: args.orgId,
    lastSequence: s.sequence,
    collectedAt: new Date(s.collectedAt),
    receivedAt,
    agentVersion: args.agentVersion,
    health: resolved.health,
    findings: resolved.findings.map((f) => f.code),
    findingDetails: Object.fromEntries(
      resolved.findings.map((f) => [f.code, f.detail]),
    ),
    syncType: s.config.type,
    ntpServer: s.config.ntpServer,
    specialPollIntervalSeconds: s.config.specialPollIntervalSeconds,
    policyManaged: s.config.policyManaged,
    policyManagedValues: s.config.policyManagedValues,
    serviceState: s.config.serviceState,
    serviceStartType: s.config.serviceStartType,
    hostTimeProviderEnabled: s.config.hostTimeProviderEnabled,
    statusMethod: s.status.method,
    source: s.status.source,
    sourceKind: s.status.sourceKind,
    lastSuccessfulSyncAt: s.status.lastSuccessfulSyncAt
      ? new Date(s.status.lastSuccessfulSyncAt)
      : null,
    lastSyncError: s.status.lastSyncError,
    stratum: s.status.stratum,
    pollIntervalSeconds: s.status.pollIntervalSeconds,
    joinType: s.domain.joinType,
    domainRole: s.domain.role,
    domainDns: s.domain.domainDns,
    forestDns: s.domain.forestDns,
    pdcName: s.domain.pdcName,
    timezoneWindowsId: s.timezone.windowsId,
    timezoneBiasMinutes: s.timezone.biasMinutes,
    timezoneAutoUpdate: s.timezone.autoUpdate,
    expectedTimezone: expected?.iana ?? null,
    expectedTimezoneWindowsId: expected?.windowsId ?? null,
    expectedTimezoneSource: expected
      ? `${expected.source}:${expected.sourceId}`
      : null,
    eventMarks: resolved.eventMarks,
    recentEvents: [...events.values()]
      .sort(
        (a, b) =>
          Date.parse(b.occurredAt) - Date.parse(a.occurredAt) ||
          b.recordId - a.recordId,
      )
      .slice(0, TIME_SYNC_RECENT_EVENTS_MAX),
    createdAt: previous?.createdAt ?? receivedAt,
    updatedAt: receivedAt,
  };
}
export async function ingestTimeStatusSnapshot(
  args: IngestArgs,
): Promise<IngestTimeStatusResult> {
  return withDbTransaction(async () => {
    // Parent first: serializes the empty-row case and matches device deletion lock order.
    const [owner] = await db
      .select({ id: devices.id, siteId: devices.siteId })
      .from(devices)
      .where(and(eq(devices.id, args.deviceId), eq(devices.orgId, args.orgId)))
      .for('update');
    if (!owner)
      throw new Error('Time status device missing or ownership changed');
    const [previous] = await db
      .select()
      .from(deviceTimeStatus)
      .where(
        and(
          eq(deviceTimeStatus.deviceId, args.deviceId),
          eq(deviceTimeStatus.orgId, args.orgId),
        ),
      )
      .for('update');
    if (
      previous &&
      args.snapshot.sequence <= previous.lastSequence &&
      Date.parse(args.snapshot.collectedAt) <=
        previous.collectedAt.getTime() + 3_600_000
    )
      return { accepted: false, reason: 'stale_sequence' };
    const [site] = await db
      .select({ id: sites.id, name: sites.name, timezone: sites.timezone })
      .from(sites)
      .where(and(eq(sites.id, owner.siteId), eq(sites.orgId, args.orgId)))
      .limit(1);
    const expected = resolveExpectedTimezone({ site: site ?? null });
    const resolved = resolveTimeFindings(args.snapshot, {
      now: args.receivedAt,
      expectedTimezone: expected,
      previousEventMarks: previous?.eventMarks ?? {},
    });
    const row = buildTimeStatusRow(args, previous, expected, resolved);
    await db
      .insert(deviceTimeStatus)
      .values(row)
      .onConflictDoUpdate({ target: deviceTimeStatus.deviceId, set: row });
    return { accepted: true, health: resolved.health };
  });
}
```

The transaction remains the extension point: W02 adds calls to its own `applyStreaks`/`upsertDaily` helpers after reduction and before return; W03a adds its own `auditEnforcement` helper in the same transaction. Do not add empty implementations or premature columns in W01a.

- [ ] Run `cd apps/api && npx vitest run --config vitest.integration.config.ts src/services/timeSync/ingest.integration.test.ts`; expected PASS with exactly one accepted concurrent first/reset snapshot and unchanged row after rejection.
- [ ] Commit:

```bash
git add apps/api/src/services/timeSync/ingest.ts apps/api/src/services/timeSync/ingest.integration.test.ts
git commit -m "feat(time-sync): ingest sequenced snapshots atomically" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 6: Project the device view and re-resolve expected timezone

**Files:** Create `apps/api/src/services/timeSync/view.ts`, `apps/api/src/services/timeSync/view.test.ts`.

**Interfaces:** Consumes Task 3 typed rows and Task 4 resolvers. Produces index §C.6 `DeviceTimeStatusView` verbatim and `getDeviceTimeStatusView(deviceId: string): Promise<DeviceTimeStatusView | null>`; null means no visible device, never “not reported”.

- [ ] Write `view.test.ts`:

```ts
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ rows: [] as unknown[][] }));
vi.mock('../../db', () => ({
  db: {
    select: () => {
      const rows = m.rows.shift() ?? [];
      const q: any = {
        then: (yes: any, no: any) => Promise.resolve(rows).then(yes, no),
      };
      for (const method of ['from', 'where', 'limit']) q[method] = () => q;
      return q;
    },
  },
  withDbTransaction: (fn: () => Promise<unknown>) => fn(),
}));
import { getDeviceTimeStatusView } from './view';
import { buildTimeStatusRow } from './ingest';
import { resolveTimeFindings } from './findings';
import { NOW, snapshot } from './testFixtures';
const deviceId = '11111111-1111-4111-8111-111111111111';
const orgId = '22222222-2222-4222-8222-222222222222';
const site = {
  id: '33333333-3333-4333-8333-333333333333',
  name: 'Main',
  timezone: 'UTC',
};
const device = { id: deviceId, orgId, siteId: site.id, osType: 'windows' };
function row() {
  const s = snapshot();
  s.status.sourceKind = 'local_clock';
  return buildTimeStatusRow(
    { deviceId, orgId, agentVersion: null, snapshot: s, receivedAt: NOW },
    undefined,
    null,
    resolveTimeFindings(s, {
      now: NOW,
      expectedTimezone: null,
      previousEventMarks: {},
    }),
  );
}
beforeEach(() => {
  m.rows = [];
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());
it('returns null for absent/RLS-hidden device', async () => {
  m.rows = [[]];
  expect(await getDeviceTimeStatusView(deviceId)).toBeNull();
});
it.each([
  ['windows', 'not_reported'],
  ['linux', 'unsupported_os'],
  ['macos', 'unsupported_os'],
])('distinguishes %s without a report', async (osType, state) => {
  m.rows = [[{ ...device, osType }], []];
  expect(await getDeviceTimeStatusView(deviceId)).toMatchObject({
    state,
    health: 'unknown',
    stale: false,
    findings: [],
    recentEvents: [],
    config: null,
    status: null,
    domain: null,
    timezone: null,
    enforcement: null,
  });
});
it('uses the UTC-default explanation and preserves non-timezone findings', async () => {
  m.rows = [[device], [row()], [site]];
  const view = await getDeviceTimeStatusView(deviceId);
  expect(view!.timezone).toMatchObject({
    expected: null,
    expectedUnsetReason: 'site_utc_default',
  });
  expect(view!.findings.map((f) => f.code)).toEqual(['source_local_clock']);
  expect(view!.config!.ntpServerHosts).toEqual(['pool.ntp.org']);
  expect(view!.receivedAt).toBe(NOW.toISOString());
});
it('recomputes mismatch on site edits in both directions without mutating the stored row', async () => {
  const stored = row();
  m.rows = [[device], [stored], [{ ...site, timezone: 'America/Detroit' }]];
  const mismatch = await getDeviceTimeStatusView(deviceId);
  expect(mismatch!.timezone!.expected).toMatchObject({
    source: 'site',
    sourceName: 'Main',
    iana: 'America/Detroit',
  });
  expect(mismatch!.findings.map((f) => f.code)).toEqual([
    'source_local_clock',
    'timezone_mismatch',
  ]);
  stored.findings.push('timezone_mismatch');
  stored.findingDetails.timezone_mismatch = { expected: 'old' };
  m.rows = [[device], [stored], [{ ...site, timezone: 'America/Los_Angeles' }]];
  expect(
    (await getDeviceTimeStatusView(deviceId))!.findings.map((f) => f.code),
  ).toEqual(['source_local_clock']);
  expect(stored.findings).toContain('timezone_mismatch');
});
it.each([
  [[], 'no_site'],
  [[{ ...site, timezone: 'Antarctica/Troll' }], 'unmapped'],
] as const)('explains missing mapping %s', async (sites, reason) => {
  m.rows = [[device], [row()], [...sites]];
  expect(
    (await getDeviceTimeStatusView(deviceId))!.timezone!.expectedUnsetReason,
  ).toBe(reason);
});
it('marks received time stale only after the exact boundary', async () => {
  vi.setSystemTime(new Date(+NOW + 5_400_000));
  m.rows = [[device], [row()], [site]];
  expect((await getDeviceTimeStatusView(deviceId))!.stale).toBe(false);
  vi.setSystemTime(new Date(+NOW + 5_400_001));
  m.rows = [[device], [row()], [site]];
  expect((await getDeviceTimeStatusView(deviceId))!.stale).toBe(true);
});
```

- [ ] Run `cd apps/api && npx vitest run src/services/timeSync/view.test.ts`; expected FAIL: missing `./view`.

- [ ] Implement `view.ts`:

```ts
import { and, eq } from 'drizzle-orm';
import {
  TIME_SYNC_FINDING_CODES,
  TIME_SYNC_FINDING_SEVERITY,
  TIME_SYNC_UNSET_SITE_TIMEZONES,
  parseNtpServerHosts,
  type TimeSyncHealth,
  type TimeSyncType,
  type TimeSyncServiceState,
  type TimeSyncServiceStartType,
  type TimeSyncStatusMethod,
  type TimeSyncSourceKind,
  type TimeSyncJoinType,
  type TimeSyncDomainRole,
  type TimeSyncAutoUpdate,
  type TimeSyncEnforcementState,
} from '@breeze/shared';
import { db } from '../../db';
import { deviceTimeStatus, devices, sites } from '../../db/schema';
import {
  resolveExpectedTimezone,
  type ExpectedTimezone,
} from './expectedTimezone';
import { healthForFindings, type TimeSyncFinding } from './findings';
import { isTimeStatusStale } from './freshness';
export interface DeviceTimeStatusView {
  deviceId: string;
  state: 'reported' | 'not_reported' | 'unsupported_os';
  stale: boolean;
  receivedAt: string | null;
  collectedAt: string | null;
  health: TimeSyncHealth;
  findings: TimeSyncFinding[];
  config: {
    syncType: TimeSyncType | null;
    ntpServer: string | null;
    ntpServerHosts: string[];
    specialPollIntervalSeconds: number | null;
    policyManaged: boolean;
    policyManagedValues: string[];
    serviceState: TimeSyncServiceState;
    serviceStartType: TimeSyncServiceStartType;
    hostTimeProviderEnabled: boolean | null;
  } | null;
  status: {
    method: TimeSyncStatusMethod;
    source: string | null;
    sourceKind: TimeSyncSourceKind;
    lastSuccessfulSyncAt: string | null;
    lastSyncError: string | null;
    stratum: number | null;
    pollIntervalSeconds: number | null;
  } | null;
  domain: {
    joinType: TimeSyncJoinType;
    role: TimeSyncDomainRole;
    domainDns: string | null;
    forestDns: string | null;
    pdcName: string | null;
  } | null;
  timezone: {
    windowsId: string | null;
    biasMinutes: number | null;
    autoUpdate: TimeSyncAutoUpdate;
    expected: ExpectedTimezone | null;
    expectedUnsetReason: 'site_utc_default' | 'no_site' | 'unmapped' | null;
  } | null;
  recentEvents: Array<{
    recordId: number;
    eventId: number;
    level: number;
    occurredAt: string;
    message: string;
  }>;
  enforcement: TimeSyncEnforcementState | null;
}
export async function getDeviceTimeStatusView(
  deviceId: string,
): Promise<DeviceTimeStatusView | null> {
  const [device] = await db
    .select({
      id: devices.id,
      orgId: devices.orgId,
      siteId: devices.siteId,
      osType: devices.osType,
    })
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);
  if (!device) return null;
  const [row] = await db
    .select()
    .from(deviceTimeStatus)
    .where(
      and(
        eq(deviceTimeStatus.deviceId, deviceId),
        eq(deviceTimeStatus.orgId, device.orgId),
      ),
    )
    .limit(1);
  if (!row)
    return {
      deviceId,
      state: device.osType === 'windows' ? 'not_reported' : 'unsupported_os',
      stale: false,
      receivedAt: null,
      collectedAt: null,
      health: 'unknown',
      findings: [],
      config: null,
      status: null,
      domain: null,
      timezone: null,
      recentEvents: [],
      enforcement: null,
    };
  const [site] = await db
    .select({ id: sites.id, name: sites.name, timezone: sites.timezone })
    .from(sites)
    .where(and(eq(sites.id, device.siteId), eq(sites.orgId, device.orgId)))
    .limit(1);
  const expected = resolveExpectedTimezone({ site: site ?? null });
  const findings: TimeSyncFinding[] = TIME_SYNC_FINDING_CODES.filter(
    (code) => code !== 'timezone_mismatch' && row.findings.includes(code),
  ).map((code) => ({
    code,
    severity: TIME_SYNC_FINDING_SEVERITY[code],
    detail: row.findingDetails[code] ?? {},
  }));
  if (
    expected &&
    row.timezoneAutoUpdate !== 'on' &&
    row.timezoneWindowsId !== expected.windowsId
  )
    findings.push({
      code: 'timezone_mismatch',
      severity: 'info',
      detail: {
        actual: row.timezoneWindowsId,
        expected: expected.windowsId,
        expectedIana: expected.iana,
        expectedSource: expected.source,
        expectedSourceName: expected.sourceName,
      },
    });
  findings.sort(
    (a, b) =>
      TIME_SYNC_FINDING_CODES.indexOf(a.code) -
      TIME_SYNC_FINDING_CODES.indexOf(b.code),
  );
  return {
    deviceId,
    state: 'reported',
    stale: isTimeStatusStale(row.receivedAt, new Date()),
    receivedAt: row.receivedAt.toISOString(),
    collectedAt: row.collectedAt.toISOString(),
    health: healthForFindings(findings, row.statusMethod),
    findings,
    config: {
      syncType: row.syncType,
      ntpServer: row.ntpServer,
      ntpServerHosts: parseNtpServerHosts(row.ntpServer),
      specialPollIntervalSeconds: row.specialPollIntervalSeconds,
      policyManaged: row.policyManaged,
      policyManagedValues: row.policyManagedValues,
      serviceState: row.serviceState,
      serviceStartType: row.serviceStartType,
      hostTimeProviderEnabled: row.hostTimeProviderEnabled,
    },
    status: {
      method: row.statusMethod,
      source: row.source,
      sourceKind: row.sourceKind,
      lastSuccessfulSyncAt: row.lastSuccessfulSyncAt?.toISOString() ?? null,
      lastSyncError: row.lastSyncError,
      stratum: row.stratum,
      pollIntervalSeconds: row.pollIntervalSeconds,
    },
    domain: {
      joinType: row.joinType,
      role: row.domainRole,
      domainDns: row.domainDns,
      forestDns: row.forestDns,
      pdcName: row.pdcName,
    },
    timezone: {
      windowsId: row.timezoneWindowsId,
      biasMinutes: row.timezoneBiasMinutes,
      autoUpdate: row.timezoneAutoUpdate,
      expected,
      expectedUnsetReason: expected
        ? null
        : !site
          ? 'no_site'
          : (TIME_SYNC_UNSET_SITE_TIMEZONES as readonly string[]).includes(
                site.timezone,
              )
            ? 'site_utc_default'
            : 'unmapped',
    },
    recentEvents: row.recentEvents,
    enforcement: null,
  };
}
```

Only timezone findings are re-derived at read time. Event and sync findings stay the latest accepted observation, while `stale` separately communicates its age.

- [ ] Run `cd apps/api && npx vitest run src/services/timeSync/view.test.ts`; expected PASS for empty states, UTC provenance, both site-edit directions, stale boundary, and hidden device.
- [ ] Commit:

```bash
git add apps/api/src/services/timeSync/view.ts apps/api/src/services/timeSync/view.test.ts
git commit -m "feat(time-sync): expose current device time view" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 7: Mount authenticated routes, limits, and MCP coverage

**Files:** Create `apps/api/src/routes/agents/timeStatus.ts`, `timeStatus.test.ts`, `timeStatus.mounted.test.ts`; Create `apps/api/src/routes/devices/timeStatus.ts`, `timeStatus.test.ts`; Modify `apps/api/src/routes/agents/index.ts:18,86`, `apps/api/src/routes/devices/index.ts:17,162`, `apps/api/src/middleware/bodyLimit.ts:36,200`, `apps/api/src/middleware/bodyLimit.test.ts:250,360`, `apps/api/src/services/mcpCoverage.ts:186,348`.

**Interfaces:** Consumes `requireAgentRole` (`middleware/requireAgentRole.ts:15`), `AgentAuthContext` (`middleware/agentAuth.ts:26`), `zValidator` (`lib/validation.ts:150`, default 400), Task 5 ingest and Task 6 view. Produces `timeStatusRoutes` in each route module; agent `PUT /api/v1/agents/:id/time-status` → `200 { accepted: boolean, health?: TimeSyncHealth, reason?: 'stale_sequence' }` (R4); operator `GET /api/v1/devices/:id/time-status` → `DeviceTimeStatusView`, or 404 hidden/missing device. GET uses the exact scope/permission/site-check chain at `routes/devices/hardwareHealth.ts:8–12`. Existing functions are defined at `middleware/auth.ts:594,917,968` (`authMiddleware`, `requireScope`, `requirePermission`) and `routes/devices/helpers.ts:174,191` (`SITE_ACCESS_DENIED`, `getDeviceWithOrgAndSiteCheck`).

- [ ] Write `apps/api/src/routes/agents/timeStatus.test.ts`:

```ts
import { beforeEach, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
const m = vi.hoisted(() => ({ ingest: vi.fn(), rows: [] as unknown[] }));
vi.mock('../../db', () => ({
  db: {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => m.rows }) }),
    }),
  },
}));
vi.mock('../../services/timeSync/ingest', () => ({
  ingestTimeStatusSnapshot: m.ingest,
}));
import { timeStatusRoutes } from './timeStatus';
import { snapshot } from '../../services/timeSync/testFixtures';
const deviceId = '11111111-1111-4111-8111-111111111111';
const orgId = '22222222-2222-4222-8222-222222222222';
function request(body: unknown = snapshot(), role = 'agent', path = 'agent-1') {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (role === 'missing') return c.json({ error: 'Unauthorized' }, 401);
    c.set('agent', { role, deviceId, orgId, agentId: 'agent-1' } as any);
    await next();
  });
  app.route('/', timeStatusRoutes);
  return app.request(`/${path}/time-status`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
beforeEach(() => {
  m.rows = [{ id: deviceId, orgId, agentVersion: '1.0.0' }];
  m.ingest.mockReset().mockResolvedValue({ accepted: true, health: 'healthy' });
});
it('uses authenticated IDs and stored agent version', async () => {
  const response = await request();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ accepted: true, health: 'healthy' });
  expect(m.ingest).toHaveBeenCalledWith({
    deviceId,
    orgId,
    agentVersion: '1.0.0',
    snapshot: snapshot(),
    receivedAt: expect.any(Date),
  });
});
it.each([
  ['missing', 401],
  ['watchdog', 403],
  ['helper', 403],
])('rejects %s credentials', async (role, status) => {
  expect((await request(snapshot(), role as string)).status).toBe(status);
  expect(m.ingest).not.toHaveBeenCalled();
});
it('rejects a different agent path before ingestion', async () => {
  expect((await request(snapshot(), 'agent', 'agent-2')).status).toBe(403);
  expect(m.ingest).not.toHaveBeenCalled();
});
it('returns 400 for invalid schema, 404 for hidden device, 500 for service failure', async () => {
  expect((await request({ ...snapshot(), sequence: -1 })).status).toBe(400);
  m.rows = [];
  expect((await request()).status).toBe(404);
  m.rows = [{ id: deviceId, orgId }];
  m.ingest.mockRejectedValue(new Error('database'));
  expect((await request()).status).toBe(500);
});
it('returns the stale-sequence reason so the sender may commit the rejected snapshot', async () => {
  m.ingest.mockResolvedValue({ accepted: false, reason: 'stale_sequence' });
  const response = await request();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    accepted: false,
    reason: 'stale_sequence',
  });
});
it('caps standalone route bodies at 512 KiB', async () => {
  expect(
    (await request({ ...snapshot(), padding: 'x'.repeat(512 * 1024) })).status,
  ).toBe(413);
  expect(m.ingest).not.toHaveBeenCalled();
});
```

Write `apps/api/src/routes/devices/timeStatus.test.ts`:

```ts
import { beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({
  device: vi.fn(),
  view: vi.fn(),
  denied: Symbol('denied'),
  status: 0,
  permissionDenied: false,
}));
vi.mock('../../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    if (m.status === 401) return c.json({ error: 'Unauthorized' }, 401);
    c.set('auth', {});
    return next();
  },
  requireScope: () => async (c: any, next: any) =>
    m.status === 403 ? c.json({ error: 'Forbidden' }, 403) : next(),
  requirePermission: () => async (c: any, next: any) =>
    m.permissionDenied ? c.json({ error: 'Forbidden' }, 403) : next(),
}));
vi.mock('./helpers', () => ({
  getDeviceWithOrgAndSiteCheck: m.device,
  SITE_ACCESS_DENIED: m.denied,
}));
vi.mock('../../services/timeSync/view', () => ({
  getDeviceTimeStatusView: m.view,
}));
import { timeStatusRoutes } from './timeStatus';
const id = '11111111-1111-4111-8111-111111111111';
const request = () => timeStatusRoutes.request(`/${id}/time-status`);
beforeEach(() => {
  m.status = 0;
  m.permissionDenied = false;
  m.device.mockReset().mockResolvedValue({ id });
  m.view.mockReset().mockResolvedValue({ deviceId: id, state: 'not_reported' });
});
it('returns the view including an ordinary not-reported state as 200', async () => {
  const response = await request();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    deviceId: id,
    state: 'not_reported',
  });
});
it.each([401, 403])('rejects unauthorized scope %s', async (status) => {
  m.status = status;
  expect((await request()).status).toBe(status);
  expect(m.view).not.toHaveBeenCalled();
});
it('checks DEVICES_READ before lookup', async () => {
  m.permissionDenied = true;
  expect((await request()).status).toBe(403);
  expect(m.device).not.toHaveBeenCalled();
  expect(m.view).not.toHaveBeenCalled();
});
it.each([
  [null, 404],
  [m.denied, 403],
])('blocks org/site-inaccessible device %s', async (value, status) => {
  m.device.mockResolvedValue(value);
  expect((await request()).status).toBe(status);
  expect(m.view).not.toHaveBeenCalled();
});
it('handles a device disappearing between authorization and read', async () => {
  m.view.mockResolvedValue(null);
  expect((await request()).status).toBe(404);
});
it('surfaces service errors', async () => {
  m.view.mockRejectedValue(new Error('database'));
  expect((await request()).status).toBe(500);
});
```

Write `apps/api/src/routes/agents/timeStatus.mounted.test.ts` (real router and global gate; sibling route modules isolated):

```ts
import { beforeEach, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
const m = vi.hoisted(() => ({ ingest: vi.fn(), auth: vi.fn() }));
vi.mock('../../db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => [{ agentVersion: '1.0.0' }] }),
      }),
    }),
  },
}));
vi.mock('../../services/timeSync/ingest', () => ({
  ingestTimeStatusSnapshot: m.ingest,
}));
vi.mock('../../middleware/agentAuth', () => ({
  agentAuthMiddleware: async (c: any, next: any) => {
    m.auth(c.req.param('id'));
    c.set('agent', {
      role: 'agent',
      agentId: 'agent-1',
      deviceId: '11111111-1111-4111-8111-111111111111',
      orgId: '22222222-2222-4222-8222-222222222222',
    });
    return next();
  },
}));
vi.mock('./download', async () => ({
  downloadRoutes: new (await import('hono')).Hono(),
}));
vi.mock('./enrollment', async () => ({
  enrollmentRoutes: new (await import('hono')).Hono(),
}));
vi.mock('./heartbeat', async () => ({
  heartbeatRoutes: new (await import('hono')).Hono(),
}));
vi.mock('./uninstallIntent', async () => ({
  uninstallIntentRoutes: new (await import('hono')).Hono(),
}));
vi.mock('./commands', async () => ({
  commandsRoutes: new (await import('hono')).Hono(),
}));
vi.mock('./pamObservations', async () => ({
  pamObservationRoutes: new (await import('hono')).Hono(),
}));
vi.mock('./pamReconciliation', async () => ({
  pamReconciliationRoutes: new (await import('hono')).Hono(),
}));
vi.mock('./security', async () => ({
  agentSecurityRoutes: new (await import('hono')).Hono(),
}));
vi.mock('./recoveryKeys', async () => ({
  agentRecoveryKeysRoutes: new (await import('hono')).Hono(),
}));
vi.mock('./inventory', async () => ({
  inventoryRoutes: new (await import('hono')).Hono(),
}));
vi.mock('./state', async () => ({
  stateRoutes: new (await import('hono')).Hono(),
}));
vi.mock('./sessions', async () => ({
  sessionsRoutes: new (await import('hono')).Hono(),
}));
vi.mock('./patches', async () => ({
  patchesRoutes: new (await import('hono')).Hono(),
}));
vi.mock('./connections', async () => ({
  connectionsRoutes: new (await import('hono')).Hono(),
}));
vi.mock('./eventlogs', async () => ({
  eventLogsRoutes: new (await import('hono')).Hono(),
}));
vi.mock('./hardwareHealth', async () => ({
  hardwareHealthRoutes: new (await import('hono')).Hono(),
}));
vi.mock('./logs', async () => ({
  logsRoutes: new (await import('hono')).Hono(),
}));
vi.mock('./mtls', async () => ({
  mtlsRoutes: new (await import('hono')).Hono(),
}));
vi.mock('./bootPerformance', async () => ({
  bootPerformanceRoutes: new (await import('hono')).Hono(),
}));
vi.mock('./reliability', async () => ({
  reliabilityRoutes: new (await import('hono')).Hono(),
}));
vi.mock('./changes', async () => ({
  changesRoutes: new (await import('hono')).Hono(),
}));
vi.mock('./peripherals', async () => ({
  peripheralRoutes: new (await import('hono')).Hono(),
}));
vi.mock('./token', async () => ({
  tokenRoutes: new (await import('hono')).Hono(),
}));
vi.mock('./elevationRequests', async () => ({
  elevationRequestsRoutes: new (await import('hono')).Hono(),
}));
vi.mock('./processSample', async () => ({
  processSampleRoutes: new (await import('hono')).Hono(),
}));
vi.mock('./unifiTelemetry', async () => ({
  unifiTelemetryRoutes: new (await import('hono')).Hono(),
}));
vi.mock('./topologyAdjacency', async () => ({
  topologyAdjacencyRoutes: new (await import('hono')).Hono(),
}));
vi.mock('./wingetBootstrap', async () => ({
  wingetBootstrapRoutes: new (await import('hono')).Hono(),
}));
vi.mock('./storageSessions', async () => ({
  agentStorageSessionRoutes: new (await import('hono')).Hono(),
}));
import { agentRoutes } from './index';
import { createGlobalBodyLimitMiddleware } from '../../middleware/bodyLimitGate';
import { snapshot } from '../../services/timeSync/testFixtures';
const app = new Hono();
app.use(
  '*',
  createGlobalBodyLimitMiddleware({ warn: () => {}, capture: () => {} }),
);
app.route('/api/v1/agents', agentRoutes);
beforeEach(() => {
  m.auth.mockClear();
  m.ingest.mockReset().mockResolvedValue({ accepted: true, health: 'healthy' });
});
function request(body: string, contentLength: boolean) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (contentLength)
    headers['content-length'] = String(Buffer.byteLength(body));
  return app.request('/api/v1/agents/agent-1/time-status', {
    method: 'PUT',
    headers,
    body,
  });
}
it.each([false, true])(
  'accepts exactly 512 KiB and rejects one byte over; Content-Length %s',
  async (length) => {
    const raw = JSON.stringify(snapshot());
    const exact = raw + ' '.repeat(512 * 1024 - Buffer.byteLength(raw));
    const accepted = await request(exact, length);
    expect(accepted.status).toBe(200);
    expect(m.auth).toHaveBeenCalledWith('agent-1');
    expect(m.ingest).toHaveBeenCalledOnce();
    m.auth.mockClear();
    m.ingest.mockClear();
    expect((await request(exact + ' ', length)).status).toBe(413);
    expect(m.auth).not.toHaveBeenCalled();
    expect(m.ingest).not.toHaveBeenCalled();
  },
);
```

- [ ] Run `cd apps/api && npx vitest run src/routes/agents/timeStatus.test.ts src/routes/agents/timeStatus.mounted.test.ts src/routes/devices/timeStatus.test.ts src/middleware/bodyLimit.test.ts`.
  Expected FAIL: missing time route exports; the mounted route must fail as 404 before mounting, even if standalone handlers pass.

- [ ] Implement `apps/api/src/routes/agents/timeStatus.ts`:

```ts
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { and, eq } from 'drizzle-orm';
import { timeStatusSnapshotSchema } from '@breeze/shared';
import { db } from '../../db';
import { devices } from '../../db/schema';
import { zValidator } from '../../lib/validation';
import { requireAgentRole } from '../../middleware/requireAgentRole';
import { ingestTimeStatusSnapshot } from '../../services/timeSync/ingest';
export const timeStatusRoutes = new Hono();
timeStatusRoutes.use('*', requireAgentRole);
timeStatusRoutes.put(
  '/:id/time-status',
  bodyLimit({
    maxSize: 512 * 1024,
    onError: (c) => c.json({ error: 'Request body too large' }, 413),
  }),
  zValidator('json', timeStatusSnapshotSchema),
  async (c) => {
    const agent = c.get('agent');
    if (c.req.param('id') !== agent.agentId)
      return c.json({ error: 'Agent identity mismatch' }, 403);
    const [device] = await db
      .select({ agentVersion: devices.agentVersion })
      .from(devices)
      .where(
        and(eq(devices.id, agent.deviceId), eq(devices.orgId, agent.orgId)),
      )
      .limit(1);
    if (!device) return c.json({ error: 'Device not found' }, 404);
    const result = await ingestTimeStatusSnapshot({
      deviceId: agent.deviceId,
      orgId: agent.orgId,
      agentVersion: device.agentVersion ?? null,
      snapshot: c.req.valid('json'),
      receivedAt: new Date(),
    });
    return c.json({
      accepted: result.accepted,
      ...(result.health ? { health: result.health } : {}),
      ...(result.reason ? { reason: result.reason } : {}),
    });
  },
);
```

Implement `apps/api/src/routes/devices/timeStatus.ts`:

```ts
import { Hono } from 'hono';
import {
  authMiddleware,
  requireScope,
  requirePermission,
} from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { getDeviceWithOrgAndSiteCheck, SITE_ACCESS_DENIED } from './helpers';
import { getDeviceTimeStatusView } from '../../services/timeSync/view';
export const timeStatusRoutes = new Hono();
timeStatusRoutes.use('*', authMiddleware);
timeStatusRoutes.get(
  '/:id/time-status',
  requireScope('organization', 'partner', 'system'),
  requirePermission(
    PERMISSIONS.DEVICES_READ.resource,
    PERMISSIONS.DEVICES_READ.action,
  ),
  async (c) => {
    const id = c.req.param('id')!;
    const device = await getDeviceWithOrgAndSiteCheck(c, id, c.get('auth'));
    if (device === SITE_ACCESS_DENIED)
      return c.json({ error: 'Access to this site denied' }, 403);
    if (!device) return c.json({ error: 'Device not found' }, 404);
    const view = await getDeviceTimeStatusView(id);
    return view ? c.json(view) : c.json({ error: 'Device not found' }, 404);
  },
);
```

Apply the following exact current anchors:

`apps/api/src/routes/agents/index.ts:18`, replace:

```text
import { hardwareHealthRoutes } from './hardwareHealth';
```

with:

```ts
import { hardwareHealthRoutes } from './hardwareHealth';
import { timeStatusRoutes } from './timeStatus';
```

`apps/api/src/routes/agents/index.ts:86`, replace:

```text
agentRoutes.route('/', hardwareHealthRoutes);
```

with:

```ts
agentRoutes.route('/', hardwareHealthRoutes);
agentRoutes.route('/', timeStatusRoutes);
```

`apps/api/src/routes/devices/index.ts:17`, replace:

```text
import { hardwareHealthRoutes } from './hardwareHealth';
```

with:

```ts
import { hardwareHealthRoutes } from './hardwareHealth';
import { timeStatusRoutes } from './timeStatus';
```

`apps/api/src/routes/devices/index.ts:162`, replace:

```text
deviceRoutes.route('/', hardwareHealthRoutes);
```

with:

```ts
deviceRoutes.route('/', hardwareHealthRoutes);
deviceRoutes.route('/', timeStatusRoutes);
```

`apps/api/src/middleware/bodyLimit.ts:36`, replace:

```text
  | 'agent-hardware-health'
```

with:

```ts
  | 'agent-hardware-health'
  | 'agent-time-status'
```

`apps/api/src/services/mcpCoverage.ts:186`, replace:

```text
  'agents/hardwareHealth.ts': { exempt: 'agent_transport' },
```

with:

```ts
  'agents/hardwareHealth.ts': { exempt: 'agent_transport' },
  'agents/timeStatus.ts': { exempt: 'agent_transport' },
```

`apps/api/src/services/mcpCoverage.ts:348`, replace:

```text
  'devices/hardwareHealth.ts': { tools: ['get_device_hardware_health'] },
```

with:

```ts
  'devices/hardwareHealth.ts': { tools: ['get_device_hardware_health'] },
  'devices/timeStatus.ts': { tools: ['get_device_time_status'] },
```

`apps/api/src/middleware/bodyLimit.ts:200–202`, replace:

```text
  if (path.match(/^\/api\/v1\/agents\/[^/]+\/hardware-health$/)) {
    return { rule: 'agent-hardware-health', maxSize: 2 * 1024 * 1024, error: 'Request body too large' };
  }
```

with:

```ts
  if (path.match(/^\/api\/v1\/agents\/[^/]+\/hardware-health$/)) {
    return {
      rule: 'agent-hardware-health',
      maxSize: 2 * 1024 * 1024,
      error: 'Request body too large',
    };
  }
  if (path.match(/^\/api\/v1\/agents\/[^/]+\/time-status$/)) {
    return {
      rule: 'agent-time-status',
      maxSize: 512 * 1024,
      error: 'Request body too large',
    };
  }
```

`apps/api/src/middleware/bodyLimit.test.ts:250`, replace:

```text
      'agent-hardware-health': '/api/v1/agents/agent-1/hardware-health',
```

with:

```ts
      'agent-hardware-health': '/api/v1/agents/agent-1/hardware-health',
      'agent-time-status': '/api/v1/agents/agent-1/time-status',
```

`apps/api/src/middleware/bodyLimit.test.ts:360–364`, replace:

```text
  'agents/hardwareHealth.ts': {
    paths: ['/api/v1/agents/agent-1/hardware-health'],
    globalMaxSize: 2 * MB,
    note: 'carved out — 2MB hardware/RAID snapshot ingest (#6856); route and gate agree at 2MB.',
  },
```

with:

```ts
  'agents/hardwareHealth.ts': {
    paths: ['/api/v1/agents/agent-1/hardware-health'],
    globalMaxSize: 2 * MB,
    note: 'carved out — 2MB hardware/RAID snapshot ingest (#6856); route and gate agree at 2MB.',
  },
  'agents/timeStatus.ts': {
    paths: ['/api/v1/agents/agent-1/time-status'],
    globalMaxSize: 512 * 1024,
    note: 'Time status route and global gate both enforce 512 KiB.',
  },
```

- [ ] Run `cd apps/api && npx vitest run src/routes/agents/timeStatus.test.ts src/routes/agents/timeStatus.mounted.test.ts src/routes/devices/timeStatus.test.ts src/middleware/bodyLimit.test.ts`; expected PASS for body boundaries both with and without Content-Length, authentication, tenant/site denial, malformed input, and response shapes.
- [ ] Commit:

```bash
git add apps/api/src/routes/agents/timeStatus.ts apps/api/src/routes/agents/timeStatus.test.ts apps/api/src/routes/agents/timeStatus.mounted.test.ts apps/api/src/routes/agents/index.ts apps/api/src/routes/devices/timeStatus.ts apps/api/src/routes/devices/timeStatus.test.ts apps/api/src/routes/devices/index.ts apps/api/src/middleware/bodyLimit.ts apps/api/src/middleware/bodyLimit.test.ts apps/api/src/services/mcpCoverage.ts
git commit -m "feat(time-sync): mount authenticated device and agent routes" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 8: Register the tier-one device read tool across every surface

**Files:** Create `apps/api/src/services/aiToolsDevice.timeSync.test.ts`, `apps/api/src/services/aiToolsDevice.timeSync.registry.test.ts`; Modify:

- `apps/api/src/services/aiGuardrails.ts:831` — time-status parity with the hardware read-tool registration.
- `apps/api/src/services/aiTools.ts:516` — time-status parity with the hardware read-tool registration.
- `apps/api/src/services/helperToolFilter.ts:24` — time-status parity with the hardware read-tool registration.
- `apps/api/src/services/aiAgents/agentToolCatalog.ts:310` — time-status parity with the hardware read-tool registration.
- `apps/api/src/services/aiGuardrails.agentPrincipal.contract.test.ts:208` — time-status parity with the hardware read-tool registration.
- `apps/api/src/services/aiAgentSdkTools.ts:177,1570` — time-status parity with the hardware read-tool registration.
- `apps/api/src/services/scriptBuilderTools.ts:46,312` — time-status parity with the hardware read-tool registration.
- `apps/api/src/services/aiAgents/analysisProfile.ts:31` — time-status parity with the hardware read-tool registration.
- `apps/api/src/services/aiAgents/designProfile.ts:24` — time-status parity with the hardware read-tool registration.
- `apps/api/src/services/aiAgents/patchProfile.ts:28` — time-status parity with the hardware read-tool registration.
- `apps/api/src/services/aiAgents/sweepProfile.ts:36` — time-status parity with the hardware read-tool registration.
- `apps/api/src/services/aiAgents/verdictProfile.ts:23` — time-status parity with the hardware read-tool registration.
- `apps/api/src/services/aiToolSchemas.ts:217` — time-status parity with the hardware read-tool registration.
- `apps/api/src/services/mcpGuidance.ts:56,59` — time-status parity with the hardware read-tool registration.
- `apps/web/src/components/ai-risk/tierConfig.ts:66,484` — time-status parity with the hardware read-tool registration.
- `apps/api/src/services/helperToolFilter.test.ts:36,32` — time-status parity with the hardware read-tool registration.
- `apps/api/src/services/llm/toolCapture/surfaces.test.ts:16,20` — time-status parity with the hardware read-tool registration.
- `apps/api/src/services/aiAgents/runLoop.test.ts:2750,2771` — time-status parity with the hardware read-tool registration.
- `apps/api/src/services/aiToolsDevice.ts:32,370` — time-status parity with the hardware read-tool registration.

**Interfaces:** Consumes `registerDeviceTools` (`apps/api/src/services/aiToolsDevice.ts:136`), `verifyDeviceAccess` (`apps/api/src/services/aiTools.ts:196`), Task 6 view. Produces tool `get_device_time_status`, tier `1`, domain `devices`, input `{ deviceId: uuid }`, permission `devices.read`, `deviceArgs: ['deviceId']`, helper scoping `'deviceId'`. No mutation or approval surface is added.

- [ ] Write `aiToolsDevice.timeSync.test.ts`:

```ts
import { expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ access: vi.fn(), view: vi.fn() }));
vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    execute: vi.fn(),
  },
  runOutsideDbContext: (fn: any) => fn(),
  withSystemDbAccessContext: (fn: any) => fn(),
  withDbAccessContext: (_ctx: any, fn: any) => fn(),
}));
vi.mock('./brainDeviceContext', () => ({
  getActiveDeviceContext: vi.fn(),
  getAllDeviceContext: vi.fn(),
  createDeviceContext: vi.fn(),
  resolveDeviceContext: vi.fn(),
}));
vi.mock('./aiTools', () => ({ verifyDeviceAccess: m.access }));
vi.mock('./timeSync/view', () => ({ getDeviceTimeStatusView: m.view }));
import { registerDeviceTools } from './aiToolsDevice';
import type { AiTool } from './aiTools';
it('authorizes first and returns precisely the shared view', async () => {
  const tools = new Map<string, AiTool>();
  registerDeviceTools(tools);
  const tool = tools.get('get_device_time_status')!;
  expect(tool).toMatchObject({
    tier: 1,
    domain: 'devices',
    deviceArgs: ['deviceId'],
  });
  m.access.mockResolvedValue({ error: 'Device not found or access denied' });
  expect(
    JSON.parse(await tool.handler({ deviceId: 'id' }, {} as any)),
  ).toHaveProperty('error');
  expect(m.view).not.toHaveBeenCalled();
  m.access.mockResolvedValue({ device: { id: 'id' } });
  const view = { deviceId: 'id', state: 'not_reported', enforcement: null };
  m.view.mockResolvedValue(view);
  expect(JSON.parse(await tool.handler({ deviceId: 'id' }, {} as any))).toEqual(
    view,
  );
  expect(m.view).toHaveBeenCalledWith('id');
  m.view.mockRejectedValue(new Error('database'));
  await expect(tool.handler({ deviceId: 'id' }, {} as any)).rejects.toThrow(
    'database',
  );
});
```

Write `aiToolsDevice.timeSync.registry.test.ts`:

```ts
import { expect, it } from 'vitest';
import {
  aiTools,
  HELPER_TOOL_SCOPING,
  applyHelperDeviceScope,
} from './aiTools';
import { toolInputSchemas } from './aiToolSchemas';
import { TOOL_PERMISSIONS, checkGuardrails } from './aiGuardrails';
import { TOOL_TIERS, buildBreezeSdkTools } from './aiAgentSdkTools';
import {
  SCRIPT_BUILDER_TOOL_TIERS,
  buildScriptBuilderTools,
} from './scriptBuilderTools';
import { getHelperAllowedTools } from './helperToolFilter';
import { TOOL_CAPABILITY } from './aiAgents/agentToolCatalog';
import { ANALYSIS_TOOL_ALLOWLIST } from './aiAgents/analysisProfile';
import { SWEEP_TOOL_ALLOWLIST } from './aiAgents/sweepProfile';
import { VERDICT_TOOL_ALLOWLIST } from './aiAgents/verdictProfile';
import { DESIGN_TOOL_ALLOWLIST } from './aiAgents/designProfile';
import { PATCH_TOOL_ALLOWLIST } from './aiAgents/patchProfile';
import { MCP_PROMPTS } from './mcpGuidance';
const name = 'get_device_time_status';
const deviceId = '11111111-1111-4111-8111-111111111111';
it('registers schema, read permission and tier without legacy-gap exemptions', () => {
  expect(aiTools.get(name)).toMatchObject({
    tier: 1,
    domain: 'devices',
    deviceArgs: ['deviceId'],
  });
  expect(TOOL_TIERS[name]).toBe(1);
  expect(checkGuardrails(name, { deviceId }).tier).toBe(1);
  expect(TOOL_PERMISSIONS[name]).toEqual({
    resource: 'devices',
    action: 'read',
  });
  const schema = toolInputSchemas[name]!;
  expect(schema.safeParse({ deviceId }).success).toBe(true);
  for (const input of [{}, { deviceId: 'invalid' }])
    expect(schema.safeParse(input).success).toBe(false);
});
it('declares callable chat and script-builder tools with matching inputs', () => {
  const auth = () => {
    throw new Error('declaration inspection must not execute handlers');
  };
  for (const tools of [
    buildBreezeSdkTools(auth),
    buildScriptBuilderTools(auth),
  ]) {
    const tool = tools.find((t) => t.name === name);
    expect(tool).toBeDefined();
    expect(typeof tool!.handler).toBe('function');
    expect(Object.keys(tool!.inputSchema).sort()).toEqual(['deviceId']);
  }
  expect(SCRIPT_BUILDER_TOOL_TIERS[name]).toBe(1);
});
it('pins Helper reads to its own device and exposes the tool in every device-read profile', () => {
  expect(getHelperAllowedTools('basic')).toContain(name);
  expect(HELPER_TOOL_SCOPING[name]).toBe('deviceId');
  expect(applyHelperDeviceScope(name, { deviceId }, 'helper-device')).toEqual(
    applyHelperDeviceScope('get_device_details', { deviceId }, 'helper-device'),
  );
  for (const list of [
    ANALYSIS_TOOL_ALLOWLIST,
    SWEEP_TOOL_ALLOWLIST,
    VERDICT_TOOL_ALLOWLIST,
    DESIGN_TOOL_ALLOWLIST,
    PATCH_TOOL_ALLOWLIST,
  ])
    expect(list).toContain(name);
  expect(TOOL_CAPABILITY[name]).toBe(TOOL_CAPABILITY.get_device_details);
  expect(
    MCP_PROMPTS.find((p) => p.name === 'breeze-device-investigate')!
      .referencedTools,
  ).toContain(name);
});
```

- [ ] Run `cd apps/api && npx vitest run src/services/aiToolsDevice.timeSync.test.ts src/services/aiToolsDevice.timeSync.registry.test.ts`; expected FAIL: tool not registered.

- [ ] Apply these exact replacements; this inventory was checked with `rg -n get_device_hardware_health apps/api/src apps/web/src/components/ai-risk/tierConfig.ts` and the W01 hardware commit. Existing hardware-specific behavior tests remain hardware-specific.

`apps/api/src/services/aiGuardrails.ts:831`, replace:

```text
  get_device_hardware_health: { resource: 'devices', action: 'read' },
```

with:

```ts
  get_device_hardware_health: { resource: 'devices', action: 'read' },
  get_device_time_status: { resource: 'devices', action: 'read' },
```

`apps/api/src/services/aiTools.ts:516`, replace:

```text
  get_device_hardware_health: 'deviceId',
```

with:

```ts
  get_device_hardware_health: 'deviceId',
  get_device_time_status: 'deviceId',
```

`apps/api/src/services/helperToolFilter.ts:24`, replace:

```text
  'get_device_hardware_health',
```

with:

```ts
  'get_device_hardware_health',
  'get_device_time_status',
```

`apps/api/src/services/aiAgents/agentToolCatalog.ts:310`, replace:

```text
  get_device_hardware_health: 'automations_reports',
```

with:

```ts
  get_device_hardware_health: 'automations_reports',
  get_device_time_status: 'automations_reports',
```

`apps/api/src/services/aiGuardrails.agentPrincipal.contract.test.ts:208`, replace:

```text
  'get_device_hardware_health',
```

with:

```ts
  'get_device_hardware_health',
  'get_device_time_status',
```

`apps/api/src/services/aiAgentSdkTools.ts:177`, replace:

```text
  get_device_hardware_health: 1,
```

with:

```ts
  get_device_hardware_health: 1,
  get_device_time_status: 1,
```

`apps/api/src/services/scriptBuilderTools.ts:46`, replace:

```text
  get_device_hardware_health: 1,
```

with:

```ts
  get_device_hardware_health: 1,
  get_device_time_status: 1,
```

`apps/api/src/services/aiAgents/analysisProfile.ts:31`, replace:

```text
  'query_devices', 'get_device_details', 'get_device_hardware_health', 'analyze_metrics', 'analyze_fleet_metrics',
```

with:

```ts
  'query_devices',
  'get_device_details',
  'get_device_hardware_health',
  'get_device_time_status',
  'analyze_metrics',
  'analyze_fleet_metrics',
```

`apps/api/src/services/aiAgents/designProfile.ts:24`, replace:

```text
  'get_device_details', 'get_device_hardware_health', 'get_device_context', 'search_logs',
```

with:

```ts
  'get_device_details',
  'get_device_hardware_health',
  'get_device_time_status',
  'get_device_context',
  'search_logs',
```

`apps/api/src/services/aiAgents/patchProfile.ts:28`, replace:

```text
  'get_device_hardware_health',
```

with:

```ts
  'get_device_hardware_health',
  'get_device_time_status',
```

`apps/api/src/services/aiAgents/sweepProfile.ts:36`, replace:

```text
  'get_device_details', 'get_device_hardware_health', 'get_service_monitoring_status', 'get_device_vulnerabilities', 'analyze_metrics',
```

with:

```ts
  'get_device_details',
  'get_device_hardware_health',
  'get_device_time_status',
  'get_service_monitoring_status',
  'get_device_vulnerabilities',
  'analyze_metrics',
```

`apps/api/src/services/aiAgents/verdictProfile.ts:23`, replace:

```text
  'manage_alerts:list', 'manage_alerts:get', 'get_device_details', 'get_device_hardware_health', 'analyze_metrics', 'query_monitors',
```

with:

```ts
  'manage_alerts:list',
  'manage_alerts:get',
  'get_device_details',
  'get_device_hardware_health',
  'get_device_time_status',
  'analyze_metrics',
  'query_monitors',
```

`apps/api/src/services/aiToolSchemas.ts:217`, replace:

```text
  get_device_hardware_health: z.object({
    deviceId: uuid,
    includeEvents: z.boolean().optional(),
    includeReliability: z.boolean().optional(),
  }),
```

with:

```ts
  get_device_hardware_health: z.object({
    deviceId: uuid,
    includeEvents: z.boolean().optional(),
    includeReliability: z.boolean().optional(),
  }),
  get_device_time_status: z.object({ deviceId: uuid }),
```

`apps/api/src/services/aiAgentSdkTools.ts:1570`, replace:

```text
    tool(
      'get_device_hardware_health',
      registryDescription('get_device_hardware_health'),
      { deviceId: uuid, includeEvents: z.boolean().optional(), includeReliability: z.boolean().optional() },
      makeHandler('get_device_hardware_health', getAuth, onPreToolUse, onPostToolUse)
    ),
```

with:

```ts
    tool(
      'get_device_hardware_health',
      registryDescription('get_device_hardware_health'),
      {
        deviceId: uuid,
        includeEvents: z.boolean().optional(),
        includeReliability: z.boolean().optional(),
      },
      makeHandler(
        'get_device_hardware_health',
        getAuth,
        onPreToolUse,
        onPostToolUse,
      ),
    ),

    tool(
      'get_device_time_status',
      registryDescription('get_device_time_status'),
      { deviceId: uuid },
      makeHandler('get_device_time_status', getAuth, onPreToolUse, onPostToolUse),
    ),
```

`apps/api/src/services/scriptBuilderTools.ts:312`, replace:

```text
    tool(
      'get_device_hardware_health',
      'Get current hardware health, components, collectors and optional recent events.',
      { deviceId: uuid, includeEvents: z.boolean().optional(), includeReliability: z.boolean().optional() },
      makeExistingHandler('get_device_hardware_health', getAuth, onPreToolUse, onPostToolUse)
    ),
```

with:

```ts
    tool(
      'get_device_hardware_health',
      'Get current hardware health, components, collectors and optional recent events.',
      {
        deviceId: uuid,
        includeEvents: z.boolean().optional(),
        includeReliability: z.boolean().optional(),
      },
      makeExistingHandler(
        'get_device_hardware_health',
        getAuth,
        onPreToolUse,
        onPostToolUse,
      ),
    ),

    tool(
      'get_device_time_status',
      'Get Windows time health, expected timezone, findings and recent events.',
      { deviceId: uuid },
      makeExistingHandler(
        'get_device_time_status',
        getAuth,
        onPreToolUse,
        onPostToolUse,
      ),
    ),
```

`apps/api/src/services/mcpGuidance.ts:56`, replace:

```text
    referencedTools: ['resolve_device_context', 'query_devices', 'get_device_details', 'get_device_hardware_health', 'analyze_metrics', 'search_agent_logs', 'get_device_vulnerabilities'],
```

with:

```ts
    referencedTools: [
      'resolve_device_context',
      'query_devices',
      'get_device_details',
      'get_device_hardware_health',
      'get_device_time_status',
      'analyze_metrics',
      'search_agent_logs',
      'get_device_vulnerabilities',
    ],
```

`apps/api/src/services/mcpGuidance.ts:59`, replace:

```text
2. Pull get_device_details, get_device_hardware_health, analyze_metrics, and recent logs via search_agent_logs. If the reliability score is in question, call get_device_hardware_health with includeReliability=true and cite its drivers/hardwareOffenders30d — never guess a cause the tool output doesn't support.
```

with:

```text
2. Pull get_device_details, get_device_hardware_health, get_device_time_status, analyze_metrics, and recent logs via search_agent_logs. If the reliability score is in question, call get_device_hardware_health with includeReliability=true and cite its drivers/hardwareOffenders30d — never guess a cause the tool output doesn't support.
```

`apps/web/src/components/ai-risk/tierConfig.ts:66`, replace:

```text
      { name: 'get_device_hardware_health', description: 'Get RAID, disk and hardware collector health', category: 'Devices & Hardware' },
```

with:

```ts
      {
        name: 'get_device_hardware_health',
        description: 'Get RAID, disk and hardware collector health',
        category: 'Devices & Hardware',
      },
      {
        name: 'get_device_time_status',
        description: 'Get Windows time sync health and expected timezone',
        category: 'Devices & Hardware',
      },
```

`apps/web/src/components/ai-risk/tierConfig.ts:484`, replace:

```text
  get_device_hardware_health: 'devices.read',
```

with:

```ts
  get_device_hardware_health: 'devices.read',
  get_device_time_status: 'devices.read',
```

`apps/api/src/services/helperToolFilter.test.ts:36`, replace:

```text
        'get_device_hardware_health',
```

with:

```ts
        'get_device_hardware_health',
        'get_device_time_status',
```

`apps/api/src/services/helperToolFilter.test.ts:32`, replace:

```text
  it('basic set contains the 9 read-only device-scoped tools', () => {
```

with:

```ts
  it('basic set contains the 10 read-only device-scoped tools', () => {
```

`apps/api/src/services/llm/toolCapture/surfaces.test.ts:16`, replace:

```text
  it('helper levels are permission allowlists over the full server (basic = 9 tools)', () => {
```

with:

```ts
  it('helper levels are permission allowlists over the full server (basic = 10 tools)', () => {
```

`apps/api/src/services/llm/toolCapture/surfaces.test.ts:20`, replace:

```text
    expect(CAPTURE_SURFACES['helper-basic'].allowedTools).toHaveLength(9);
```

with:

```ts
    expect(CAPTURE_SURFACES['helper-basic'].allowedTools).toHaveLength(10);
```

`apps/api/src/services/aiAgents/runLoop.test.ts:2750`, replace:

```text
      'mcp__breeze__get_device_hardware_health',
```

with:

```ts
      'mcp__breeze__get_device_hardware_health',
      'mcp__breeze__get_device_time_status',
```

`apps/api/src/services/aiAgents/runLoop.test.ts:2771`, replace:

```text
      new Set(['manage_alerts', 'get_device_details', 'get_device_hardware_health', 'analyze_metrics', 'query_monitors']),
```

with:

```ts
      new Set([
        'manage_alerts',
        'get_device_details',
        'get_device_hardware_health',
        'get_device_time_status',
        'analyze_metrics',
        'query_monitors',
      ]),
```

`apps/api/src/services/aiToolsDevice.ts:32`, replace:

```text
import { getDeviceHardwareHealthView } from './hardwareHealth/view';
```

with:

```ts
import { getDeviceHardwareHealthView } from './hardwareHealth/view';
import { getDeviceTimeStatusView } from './timeSync/view';
```

`apps/api/src/services/aiToolsDevice.ts:370`, replace:

```text
  // ============================================
  // get_device_context - Tier 1 (auto-execute)
  // ============================================
```

with:

```ts
  registerTool({
    tier: 1,
    domain: 'devices',
    deviceArgs: ['deviceId'],
    searchHint:
      'Windows time synchronization, timezone, NTP source and time findings',
    definition: {
      name: 'get_device_time_status',
      description:
        'Get current Windows time synchronization, expected timezone provenance, findings and recent time events.',
      input_schema: {
        type: 'object' as const,
        properties: {
          deviceId: { type: 'string', description: 'The device UUID' },
        },
        required: ['deviceId'],
      },
    },
    handler: async (input, auth) => {
      const deviceId = input.deviceId as string;
      const access = await verifyDeviceAccess(deviceId, auth);
      if ('error' in access) return JSON.stringify({ error: access.error });
      return JSON.stringify(await getDeviceTimeStatusView(deviceId));
    },
  });

  // ============================================
  // get_device_context - Tier 1 (auto-execute)
  // ============================================
```

- [ ] Run:

```bash
(cd apps/api && npx vitest run src/services/aiToolsDevice.timeSync.test.ts src/services/aiToolsDevice.timeSync.registry.test.ts src/services/helperToolFilter.test.ts src/services/llm/toolCapture/surfaces.test.ts src/services/aiGuardrails.agentPrincipal.contract.test.ts src/services/aiAgents/runLoop.test.ts src/__tests__/mcp-coverage.test.ts)
```

Expected PASS: callable SDK/script-builder declarations, every read profile, permission/scoping, basic helper count 10, and MCP route inventory. No registered tool requires hardware's optional event/reliability flags.

- [ ] Commit:

```bash
git add apps/api/src/services/aiToolsDevice.timeSync.test.ts apps/api/src/services/aiToolsDevice.timeSync.registry.test.ts apps/api/src/services/aiGuardrails.ts apps/api/src/services/aiTools.ts apps/api/src/services/helperToolFilter.ts apps/api/src/services/aiAgents/agentToolCatalog.ts apps/api/src/services/aiGuardrails.agentPrincipal.contract.test.ts apps/api/src/services/aiAgentSdkTools.ts apps/api/src/services/scriptBuilderTools.ts apps/api/src/services/aiAgents/analysisProfile.ts apps/api/src/services/aiAgents/designProfile.ts apps/api/src/services/aiAgents/patchProfile.ts apps/api/src/services/aiAgents/sweepProfile.ts apps/api/src/services/aiAgents/verdictProfile.ts apps/api/src/services/aiToolSchemas.ts apps/api/src/services/mcpGuidance.ts apps/web/src/components/ai-risk/tierConfig.ts apps/api/src/services/helperToolFilter.test.ts apps/api/src/services/llm/toolCapture/surfaces.test.ts apps/api/src/services/aiAgents/runLoop.test.ts apps/api/src/services/aiToolsDevice.ts
git commit -m "feat(time-sync): expose device status to AI read tools" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 9: Render the read-only Time section with localized evidence and fixes

**Files:** Create `apps/web/src/components/devices/time/{DeviceTimeSection,TimeEventsList}.tsx`, `types.ts`, `timeSyncCopy.ts`, `fixtures.ts`, `DeviceTimeSection.test.tsx`, `DeviceTimeSection.integration.test.tsx`; Modify `apps/web/src/components/devices/DeviceInfoTab.tsx:42,896`, `apps/web/src/components/devices/DeviceInfoTab.test.tsx:18`, all eight `apps/web/src/locales/{de-DE,en,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/devices.json:1`, `apps/web/src/lib/i18n/translationCoverage.test.ts` (R1 token-only baseline increments).

**Interfaces:** Consumes exact §C.6 view JSON through `fetchWithAuth` (`apps/web/src/stores/auth.ts:1335`), React i18next `useTranslation('devices')`, `formatLastSeen` (`apps/web/src/lib/formatTime.ts:64`). Produces `DeviceTimeSection({ deviceId, deviceName? }: { deviceId: string; deviceName?: string })`, `TimeEventsList({ events }: { events: DeviceTimeStatusView['recentEvents'] })`, `findingCopy(t, finding, deviceName, expected)` with explicit placeholder adaptation. These read-only components do not need `runAction`. No server state is inferred from the browser clock.

- [ ] Write `fixtures.ts` and the tests before implementation:

```ts
// apps/web/src/components/devices/time/fixtures.ts
import type { DeviceTimeStatusView } from './types';
export function view(
  patch: Partial<DeviceTimeStatusView> = {},
): DeviceTimeStatusView {
  return {
    deviceId: '11111111-1111-4111-8111-111111111111',
    state: 'reported',
    stale: false,
    collectedAt: '2026-09-28T10:00:00Z',
    receivedAt: '2026-09-28T10:01:00Z',
    health: 'healthy',
    findings: [],
    config: {
      syncType: 'NTP',
      ntpServer: 'pool.ntp.org,0x9',
      ntpServerHosts: ['pool.ntp.org'],
      specialPollIntervalSeconds: 3600,
      policyManaged: false,
      policyManagedValues: [],
      serviceState: 'running',
      serviceStartType: 'auto',
      hostTimeProviderEnabled: false,
    },
    status: {
      method: 'provider_api',
      source: 'pool.ntp.org',
      sourceKind: 'ntp_peer',
      lastSuccessfulSyncAt: '2026-09-28T09:59:00Z',
      lastSyncError: null,
      stratum: 3,
      pollIntervalSeconds: 3600,
    },
    domain: {
      joinType: 'none',
      role: 'workgroup',
      domainDns: null,
      forestDns: null,
      pdcName: null,
    },
    timezone: {
      windowsId: 'Pacific Standard Time',
      biasMinutes: 480,
      autoUpdate: 'off',
      expected: null,
      expectedUnsetReason: 'site_utc_default',
    },
    recentEvents: [
      {
        recordId: 9,
        eventId: 134,
        level: 2,
        occurredAt: '2026-09-28T09:00:00Z',
        message: '<script>untrusted display text</script>',
      },
    ],
    enforcement: null,
    ...patch,
  };
}
```

`DeviceTimeSection.test.tsx`:

```tsx
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { fetchWithAuth } from '../../../stores/auth';
import DeviceTimeSection from './DeviceTimeSection';
import { view } from './fixtures';
import { findingCopy } from './timeSyncCopy';
import en from '../../../locales/en/devices.json';
vi.mock('../../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
beforeEach(() => vi.mocked(fetchWithAuth).mockReset());
it.each([
  [
    'not_reported',
    'No time data yet — this needs an agent update that includes time sync',
  ],
  ['unsupported_os', 'Not supported on this OS yet'],
] as const)('renders %s as an ordinary empty state', async (state, message) => {
  vi.mocked(fetchWithAuth).mockResolvedValue(
    response(
      view({ state, config: null, status: null, domain: null, timezone: null }),
    ),
  );
  render(<DeviceTimeSection deviceId="one" />);
  expect(await screen.findByTestId('time-empty')).toHaveTextContent(message);
  expect(screen.queryByTestId('time-health')).not.toBeInTheDocument();
});
it('renders reported details, UTC default, stale evidence and escaped event messages', async () => {
  vi.mocked(fetchWithAuth).mockResolvedValue(
    response(view({ stale: true, health: 'warning' })),
  );
  const { container } = render(<DeviceTimeSection deviceId="one" />);
  expect(await screen.findByTestId('time-stale')).toHaveTextContent('Stale');
  expect(screen.getByTestId('time-health')).toHaveTextContent('Warning');
  expect(screen.getByTestId('time-expected')).toHaveTextContent(
    'No expected timezone (site uses the UTC default)',
  );
  expect(screen.getByTestId('time-facts')).toHaveTextContent('pool.ntp.org');
  fireEvent.click(screen.getByTestId('time-events-toggle'));
  expect(screen.getByTestId('time-event-9')).toHaveTextContent(
    '<script>untrusted display text</script>',
  );
  expect(container.querySelector('script')).toBeNull();
});
it.each(['no_site', 'unmapped'] as const)(
  'explains expected timezone %s',
  async (reason) => {
    const v = view();
    v.timezone!.expectedUnsetReason = reason;
    vi.mocked(fetchWithAuth).mockResolvedValue(response(v));
    render(<DeviceTimeSection deviceId="one" />);
    expect(await screen.findByTestId('time-expected')).toHaveTextContent(
      en.timeSync.unset[reason],
    );
  },
);
it('uses parent expected provenance when finding detail lacks it and resolves device placeholders', async () => {
  const v = view();
  v.timezone!.expected = {
    iana: 'America/Detroit',
    windowsId: 'Eastern Standard Time',
    source: 'site',
    sourceId: 'site',
    sourceName: 'Main',
  };
  v.timezone!.expectedUnsetReason = null;
  v.findings = [
    {
      code: 'timezone_mismatch',
      severity: 'info',
      detail: {
        actual: 'Pacific Standard Time',
        expected: 'Eastern Standard Time',
      },
    },
  ];
  vi.mocked(fetchWithAuth).mockResolvedValue(response(v));
  render(<DeviceTimeSection deviceId="one" deviceName="Device A" />);
  expect(await screen.findByTestId('time-expected')).toHaveTextContent('Main');
  expect(
    screen.getByTestId('time-finding-timezone_mismatch'),
  ).toHaveTextContent(
    'Timezone is Pacific Standard Time, expected Eastern Standard Time (from Main).',
  );
  const t = (key: string) =>
    key === 'devices:timeSync.unknown'
      ? 'Unknown'
      : key.endsWith('.hint')
        ? en.timeSync.findings.pdc_no_external_source.hint
        : en.timeSync.findings.pdc_no_external_source.label;
  expect(
    findingCopy(
      t,
      {
        code: 'pdc_no_external_source',
        severity: 'critical',
        detail: { domainDns: null },
      },
      'Device A',
      null,
    ).hint,
  ).toContain('Set NTP servers on Device A');
});
it.each(['site', 'policy'] as const)(
  'uses the translated %s source when the parent name is absent',
  async (source) => {
    const v = view();
    v.timezone!.expected = {
      iana: 'America/Detroit',
      windowsId: 'Eastern Standard Time',
      source,
      sourceId: 'source-id',
      sourceName: null,
    };
    v.findings = [
      {
        code: 'timezone_mismatch',
        severity: 'info',
        detail: {
          actual: 'Pacific Standard Time',
          expected: 'Eastern Standard Time',
          expectedSource: 'site',
          expectedSourceName: 'Old name',
        },
      },
    ];
    vi.mocked(fetchWithAuth).mockResolvedValue(response(v));
    render(<DeviceTimeSection deviceId="one" />);
    expect(
      await screen.findByTestId('time-finding-timezone_mismatch'),
    ).toHaveTextContent(`(from ${en.timeSync[source]}).`);
    expect(
      screen.getByTestId('time-finding-timezone_mismatch'),
    ).not.toHaveTextContent('Old name');
  },
);
it('shows Group Policy management and pinned-policy provenance without implying writes', async () => {
  const v = view();
  v.config!.policyManaged = true;
  v.timezone!.expected = {
    iana: 'UTC',
    windowsId: 'UTC',
    source: 'policy',
    sourceId: 'policy',
    sourceName: 'Servers',
  };
  v.status!.source = null;
  vi.mocked(fetchWithAuth).mockResolvedValue(response(v));
  render(<DeviceTimeSection deviceId="one" />);
  expect(await screen.findByTestId('time-gpo')).toHaveTextContent(
    'Managed by Group Policy',
  );
  expect(screen.getByTestId('time-expected')).toHaveTextContent(
    'overrides the site timezone',
  );
  expect(screen.getByTestId('time-facts')).toHaveTextContent('Unknown');
});
it('shows loading, surfaces failure and retries', async () => {
  vi.mocked(fetchWithAuth)
    .mockRejectedValueOnce(new Error('network'))
    .mockResolvedValueOnce(response(view()));
  render(<DeviceTimeSection deviceId="one" />);
  expect(screen.getByTestId('time-loading')).toBeInTheDocument();
  fireEvent.click(await screen.findByTestId('time-retry'));
  expect(await screen.findByTestId('time-health')).toHaveTextContent('Healthy');
});
it('ignores a late old-device response and aborts on unmount', async () => {
  let resolveOld!: (response: Response) => void;
  vi.mocked(fetchWithAuth)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    )
    .mockResolvedValueOnce(response(view({ health: 'critical' })));
  const rendered = render(<DeviceTimeSection deviceId="old" />);
  rendered.rerender(<DeviceTimeSection deviceId="new" />);
  await waitFor(() =>
    expect(screen.getByTestId('time-health')).toHaveTextContent('Critical'),
  );
  await act(async () => {
    resolveOld(response(view()));
  });
  expect(screen.getByTestId('time-health')).toHaveTextContent('Critical');
  rendered.unmount();
  const signal = vi.mocked(fetchWithAuth).mock.calls[1]![1]!
    .signal as AbortSignal;
  expect(signal.aborted).toBe(true);
});
```

`DeviceTimeSection.integration.test.tsx` (jsdom composition test, not a database integration suite):

```tsx
import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import DeviceInfoTab from '../DeviceInfoTab';
import { fetchWithAuth } from '../../../stores/auth';
import { view } from './fixtures';
vi.mock('../../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
it('places Time between Operating System and Hardware Summary', async () => {
  vi.mocked(fetchWithAuth).mockImplementation(async (input) => {
    const path = String(input);
    const body = path.endsWith('/time-status')
      ? view()
      : path === '/custom-fields'
        ? { data: [] }
        : {
            hostname: 'device-fixture',
            displayName: null,
            osType: 'windows',
            osVersion: '11',
            tags: [],
            status: 'online',
          };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  render(<DeviceInfoTab deviceId="11111111-1111-4111-8111-111111111111" />);
  const section = await screen.findByTestId('time-section');
  const os = screen.getByText('Operating System');
  const hardware = screen.getByText('Hardware Summary');
  expect(
    os.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(
    section.compareDocumentPosition(hardware) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});
```

- [ ] Run `cd apps/web && npx vitest run src/components/devices/time/DeviceTimeSection.test.tsx src/components/devices/time/DeviceTimeSection.integration.test.tsx`; expected FAIL: missing Time component/types/copy and locale namespace.

- [ ] Implement `types.ts`:

```ts
import type {
  TimeSyncHealth,
  TimeSyncType,
  TimeSyncServiceState,
  TimeSyncServiceStartType,
  TimeSyncStatusMethod,
  TimeSyncSourceKind,
  TimeSyncJoinType,
  TimeSyncDomainRole,
  TimeSyncAutoUpdate,
  TimeSyncEnforcementState,
  TimeSyncFindingCode,
  TimeSyncFindingSeverity,
} from '@breeze/shared';
export interface ExpectedTimezone {
  iana: string;
  windowsId: string;
  source: 'policy' | 'site';
  sourceId: string;
  sourceName: string | null;
}
export interface TimeSyncFinding {
  code: TimeSyncFindingCode;
  severity: TimeSyncFindingSeverity;
  detail: Record<string, string | number | null>;
}
export interface DeviceTimeStatusView {
  deviceId: string;
  state: 'reported' | 'not_reported' | 'unsupported_os';
  stale: boolean;
  receivedAt: string | null;
  collectedAt: string | null;
  health: TimeSyncHealth;
  findings: TimeSyncFinding[];
  config: {
    syncType: TimeSyncType | null;
    ntpServer: string | null;
    ntpServerHosts: string[];
    specialPollIntervalSeconds: number | null;
    policyManaged: boolean;
    policyManagedValues: string[];
    serviceState: TimeSyncServiceState;
    serviceStartType: TimeSyncServiceStartType;
    hostTimeProviderEnabled: boolean | null;
  } | null;
  status: {
    method: TimeSyncStatusMethod;
    source: string | null;
    sourceKind: TimeSyncSourceKind;
    lastSuccessfulSyncAt: string | null;
    lastSyncError: string | null;
    stratum: number | null;
    pollIntervalSeconds: number | null;
  } | null;
  domain: {
    joinType: TimeSyncJoinType;
    role: TimeSyncDomainRole;
    domainDns: string | null;
    forestDns: string | null;
    pdcName: string | null;
  } | null;
  timezone: {
    windowsId: string | null;
    biasMinutes: number | null;
    autoUpdate: TimeSyncAutoUpdate;
    expected: ExpectedTimezone | null;
    expectedUnsetReason: 'site_utc_default' | 'no_site' | 'unmapped' | null;
  } | null;
  recentEvents: Array<{
    recordId: number;
    eventId: number;
    level: number;
    occurredAt: string;
    message: string;
  }>;
  enforcement: TimeSyncEnforcementState | null;
}
```

Implement `timeSyncCopy.ts`:

```ts
import type { ExpectedTimezone, TimeSyncFinding } from './types';
type Translate = (key: string) => string;
export function findingCopy(
  t: Translate,
  finding: TimeSyncFinding,
  deviceName: string,
  expected: ExpectedTimezone | null,
): { label: string; hint: string } {
  const detail = {
    ...finding.detail,
    device: deviceName,
    'site or policy':
      expected?.sourceName ??
      (expected
        ? t(/* i18n-dynamic */ `devices:timeSync.${expected.source}`)
        : t('devices:timeSync.unknown')),
  };
  const template = t(
    /* i18n-dynamic */ `devices:timeSync.findings.${finding.code}.hint`,
  );
  return {
    label: t(
      /* i18n-dynamic */ `devices:timeSync.findings.${finding.code}.label`,
    ),
    hint: template.replace(/\{([^}]+)\}/g, (_match, key: string) => {
      const value = (
        detail as Record<string, string | number | null | undefined>
      )[key];
      return value === null || value === undefined
        ? t('devices:timeSync.unknown')
        : String(value);
    }),
  };
}
```

Implement `TimeEventsList.tsx`:

```tsx
import { useTranslation } from 'react-i18next';
import { formatLastSeen } from '@/lib/formatTime';
import type { DeviceTimeStatusView } from './types';
export default function TimeEventsList({
  events,
}: {
  events: DeviceTimeStatusView['recentEvents'];
}) {
  const { t } = useTranslation('devices');
  return (
    <details data-testid="time-events" className="rounded-md border p-3">
      <summary
        data-testid="time-events-toggle"
        className="cursor-pointer font-medium"
      >
        {t('timeSync.events', { count: events.length })}
      </summary>
      {events.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">
          {t('timeSync.noEvents')}
        </p>
      ) : (
        <ol className="mt-3 space-y-3">
          {events.map((event) => (
            <li
              key={event.recordId}
              data-testid={`time-event-${event.recordId}`}
              className="text-sm"
            >
              <div className="text-muted-foreground">
                {t('timeSync.eventHeading', {
                  id: event.eventId,
                  level: event.level,
                })}
                {' · '}
                <time dateTime={event.occurredAt} title={event.occurredAt}>
                  {formatLastSeen(event.occurredAt)}
                </time>
              </div>
              <p className="whitespace-pre-wrap break-words">
                {event.message || t('timeSync.noMessage')}
              </p>
            </li>
          ))}
        </ol>
      )}
    </details>
  );
}
```

Implement `DeviceTimeSection.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../../stores/auth';
import { formatLastSeen } from '@/lib/formatTime';
import type { DeviceTimeStatusView } from './types';
import { findingCopy } from './timeSyncCopy';
import TimeEventsList from './TimeEventsList';
type Load =
  | { state: 'loading' | 'error' }
  | { state: 'ready'; view: DeviceTimeStatusView };
const colors = {
  healthy: 'bg-success/15 text-success border-success/30',
  warning: 'bg-warning/15 text-warning border-warning/30',
  critical: 'bg-destructive/15 text-destructive border-destructive/30',
  unknown: 'bg-muted text-muted-foreground border-border',
};
export default function DeviceTimeSection({
  deviceId,
  deviceName,
}: {
  deviceId: string;
  deviceName?: string;
}) {
  const { t } = useTranslation('devices');
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoad({ state: 'loading' });
    void (async () => {
      try {
        const response = await fetchWithAuth(
          `/devices/${deviceId}/time-status`,
          { signal: controller.signal },
        );
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const view: DeviceTimeStatusView = await response.json();
        if (active) setLoad({ state: 'ready', view });
      } catch {
        if (active) setLoad({ state: 'error' });
      }
    })();
    return () => {
      active = false;
      controller.abort();
    };
  }, [deviceId, attempt]);
  const data = load.state === 'ready' ? load.view : null;
  const reported = data?.state === 'reported';
  const unknown = t('timeSync.unknown');
  const value = (v: string | number | null | undefined) =>
    v === null || v === undefined || v === '' ? unknown : String(v);
  const yesNo = (v: boolean | null | undefined) =>
    v == null ? unknown : v ? t('timeSync.yes') : t('timeSync.no');
  const enumValue = (v: string | null | undefined) =>
    v ? t(/* i18n-dynamic */ `timeSync.values.${v}`) : unknown;
  const date = (v: string | null | undefined) =>
    v ? formatLastSeen(v) : unknown;
  const facts: Array<[string, string]> = data
    ? [
        ['source', value(data.status?.source)],
        ['sourceKind', enumValue(data.status?.sourceKind)],
        ['lastSync', date(data.status?.lastSuccessfulSyncAt)],
        ['method', enumValue(data.status?.method)],
        ['lastError', value(data.status?.lastSyncError)],
        ['stratum', value(data.status?.stratum)],
        ['poll', value(data.status?.pollIntervalSeconds)],
        ['syncType', enumValue(data.config?.syncType)],
        ['ntpServer', value(data.config?.ntpServer)],
        ['hosts', value(data.config?.ntpServerHosts.join(', '))],
        ['specialPoll', value(data.config?.specialPollIntervalSeconds)],
        ['serviceState', enumValue(data.config?.serviceState)],
        ['serviceStartType', enumValue(data.config?.serviceStartType)],
        ['policyManaged', yesNo(data.config?.policyManaged)],
        [
          'policyManagedValues',
          value(data.config?.policyManagedValues.join(', ')),
        ],
        ['hostProvider', yesNo(data.config?.hostTimeProviderEnabled)],
        ['joinType', enumValue(data.domain?.joinType)],
        ['role', enumValue(data.domain?.role)],
        ['domain', value(data.domain?.domainDns)],
        ['forest', value(data.domain?.forestDns)],
        ['pdc', value(data.domain?.pdcName)],
        ['windowsId', value(data.timezone?.windowsId)],
        ['bias', value(data.timezone?.biasMinutes)],
        ['autoUpdate', enumValue(data.timezone?.autoUpdate)],
      ]
    : [];
  const expected = data?.timezone?.expected;
  return (
    <section
      data-testid="time-section"
      className="rounded-lg border bg-card p-4 shadow-xs sm:p-6 space-y-4"
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">{t('timeSync.title')}</h3>
        {reported && data && (
          <span
            data-testid="time-health"
            className={`rounded-full border px-2 py-0.5 text-xs ${colors[data.health]}`}
          >
            {t(/* i18n-dynamic */ `timeSync.health.${data.health}`)}
          </span>
        )}
      </header>
      {load.state === 'loading' && (
        <p role="status" data-testid="time-loading">
          {t('timeSync.loading')}
        </p>
      )}
      {load.state === 'error' && (
        <div role="alert">
          <p>{t('timeSync.error')}</p>
          <button
            type="button"
            data-testid="time-retry"
            onClick={() => setAttempt((n) => n + 1)}
            className="mt-2 underline"
          >
            {t('timeSync.retry')}
          </button>
        </div>
      )}
      {data && !reported && (
        <p data-testid="time-empty" className="text-sm text-muted-foreground">
          {t(/* i18n-dynamic */ `timeSync.states.${data.state}`)}
        </p>
      )}
      {reported && data && (
        <>
          {data.config?.policyManaged && (
            <span
              data-testid="time-gpo"
              className="inline-flex rounded-full border border-border bg-muted px-2 py-0.5 text-xs"
            >
              {t('timeSync.managedBadge')}
            </span>
          )}
          <p className="text-xs text-muted-foreground">
            {t('timeSync.received', { at: date(data.receivedAt) })}
            {' · '}
            {t('timeSync.collected', { at: date(data.collectedAt) })}
          </p>
          {data.stale && (
            <p
              data-testid="time-stale"
              className="rounded-md border border-warning/30 bg-warning/15 p-2 text-sm text-warning"
            >
              {t('timeSync.stale')}
            </p>
          )}
          <p data-testid="time-expected" className="text-sm">
            {expected
              ? t(
                  /* i18n-dynamic */ expected.source === 'policy'
                    ? 'timeSync.expectedPolicy'
                    : 'timeSync.expected',
                  {
                    windows: expected.windowsId,
                    iana: expected.iana,
                    source: t(/* i18n-dynamic */ `timeSync.${expected.source}`),
                    name: expected.sourceName ?? expected.sourceId,
                  },
                )
              : t(
                  /* i18n-dynamic */ `timeSync.unset.${data.timezone?.expectedUnsetReason ?? 'unmapped'}`,
                )}
          </p>
          {data.findings.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t('timeSync.noFindings')}
            </p>
          ) : (
            <ul className="space-y-2">
              {data.findings.map((finding) => {
                const copy = findingCopy(
                  t,
                  finding,
                  deviceName ?? deviceId,
                  expected ?? null,
                );
                return (
                  <li
                    key={finding.code}
                    data-testid={`time-finding-${finding.code}`}
                    className="rounded-md border p-3"
                  >
                    <p className="font-medium">
                      {copy.label}{' '}
                      <span className="text-xs text-muted-foreground">
                        {t(
                          /* i18n-dynamic */ `timeSync.severity.${finding.severity}`,
                        )}
                      </span>
                    </p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {copy.hint}
                    </p>
                  </li>
                );
              })}
            </ul>
          )}
          <dl
            data-testid="time-facts"
            className="grid gap-x-6 gap-y-3 sm:grid-cols-2 xl:grid-cols-3"
          >
            {facts.map(([key, content]) => (
              <div key={key} className="min-w-0">
                <dt className="text-xs text-muted-foreground">
                  {t(/* i18n-dynamic */ `timeSync.fields.${key}`)}
                </dt>
                <dd className="break-words text-sm">{content}</dd>
              </div>
            ))}
          </dl>
          <TimeEventsList events={data.recentEvents} />
        </>
      )}
    </section>
  );
}
```

Replace the import anchor at `apps/web/src/components/devices/DeviceInfoTab.tsx:42`:

```text
import { formatDeviceDetailOsVersion } from "./osDisplay";
```

with:

```ts
import { formatDeviceDetailOsVersion } from './osDisplay';
import DeviceTimeSection from './time/DeviceTimeSection';
```

At `DeviceInfoTab.tsx:896–899`, replace this exact boundary:

```text
      </Section>

      <Section
        title={t("deviceInfoTab.hardwareSummary")}
```

with:

```tsx
      </Section>

      <DeviceTimeSection
        deviceId={deviceId}
        deviceName={info?.displayName ?? info?.hostname ?? deviceId}
      />

      <Section
        title={t("deviceInfoTab.hardwareSummary")}
```

At `apps/web/src/components/devices/DeviceInfoTab.test.tsx:18`, replace the exact anchor:

```text
const fetchWithAuthMock = vi.mocked(fetchWithAuth);
```

with:

```tsx
vi.mock('./time/DeviceTimeSection', () => ({ default: () => null }));
const fetchWithAuthMock = vi.mocked(fetchWithAuth);
```

The parent mutation tests deliberately mock the child so an unrelated default 404 does not create a second `role="alert"`; the new composition test exercises the real child separately.

- [ ] Insert the complete locale-specific `timeSync` member below into each `devices.json`. English hint values reproduce spec §5.2 verbatim. Every non-English value is translated; retain single-braced finding placeholders used by `findingCopy` and double-braced i18next placeholders exactly. Only `timeSync.fields.pdc` intentionally remains identical: `PDC` is the Windows Active Directory role acronym. R1 permits its one-key namespace baseline increase for each translated locale.

```json
{
  "en": {
    "timeSync": {
      "title": "Time",
      "loading": "Loading time status…",
      "error": "Could not load time status.",
      "retry": "Retry",
      "unknown": "Unknown",
      "yes": "Yes",
      "no": "No",
      "site": "Site",
      "policy": "Policy",
      "states": {
        "not_reported": "No time data yet — this needs an agent update that includes time sync",
        "unsupported_os": "Not supported on this OS yet"
      },
      "health": {
        "healthy": "Healthy",
        "warning": "Warning",
        "critical": "Critical",
        "unknown": "Unknown"
      },
      "severity": {
        "critical": "Critical",
        "warning": "Warning",
        "info": "Information"
      },
      "received": "Received {{at}}",
      "collected": "Collected {{at}}",
      "stale": "Stale — the latest time report was received more than 90 minutes ago.",
      "expected": "Expected: {{windows}} ({{iana}}), from {{source}}: {{name}}",
      "expectedPolicy": "Expected: {{windows}} ({{iana}}), from policy {{name}} — overrides the site timezone",
      "managedBadge": "Managed by Group Policy",
      "unset": {
        "site_utc_default": "No expected timezone (site uses the UTC default)",
        "no_site": "No expected timezone (no site is assigned)",
        "unmapped": "No expected timezone (the site timezone has no Windows mapping)"
      },
      "noFindings": "No time findings in this report.",
      "events": "Recent time events ({{count}})",
      "noEvents": "No recent time events.",
      "eventHeading": "Event {{id}} · Level {{level}}",
      "noMessage": "No event message.",
      "fields": {
        "source": "Time source",
        "sourceKind": "Source kind",
        "lastSync": "Last successful sync",
        "method": "Collection method",
        "lastError": "Last sync error",
        "stratum": "Stratum",
        "poll": "Effective poll interval (seconds)",
        "syncType": "Synchronization type",
        "ntpServer": "NTP server configuration",
        "hosts": "Parsed NTP hosts",
        "specialPoll": "Special poll interval (seconds)",
        "serviceState": "Windows Time service",
        "serviceStartType": "Service startup",
        "policyManaged": "Managed by Group Policy",
        "policyManagedValues": "Group Policy values",
        "hostProvider": "VM host time provider enabled",
        "joinType": "Join type",
        "role": "Domain role",
        "domain": "Domain",
        "forest": "Forest",
        "pdc": "PDC",
        "windowsId": "Current Windows timezone",
        "bias": "Bias (minutes)",
        "autoUpdate": "Automatic timezone"
      },
      "values": {
        "NT5DS": "Domain hierarchy (NT5DS)",
        "NTP": "NTP peers",
        "NoSync": "No synchronization",
        "AllSync": "All sources",
        "ntp_peer": "NTP peer",
        "domain_peer": "Domain peer",
        "local_clock": "Local clock",
        "free_running": "Free-running clock",
        "vm_host": "VM host",
        "unknown": "Unknown",
        "provider_api": "Windows provider API",
        "w32tm_tokens": "Windows time status tokens",
        "events": "Time-Service events",
        "unavailable": "Unavailable",
        "none": "Not joined",
        "workplace": "Workplace registered",
        "azure_ad": "Microsoft Entra joined",
        "on_prem_ad": "Active Directory joined",
        "hybrid_azure_ad": "Hybrid Entra joined",
        "workgroup": "Workgroup",
        "entra_only": "Entra only",
        "member": "Domain member",
        "dc": "Domain controller",
        "pdc_emulator": "PDC emulator",
        "forest_root_pdc_emulator": "Forest root PDC emulator",
        "running": "Running",
        "stopped": "Stopped",
        "start_pending": "Starting",
        "stop_pending": "Stopping",
        "paused": "Paused",
        "not_installed": "Not installed",
        "auto": "Automatic",
        "delayed_auto": "Automatic (delayed)",
        "manual": "Manual",
        "trigger_manual": "Manual (trigger start)",
        "disabled": "Disabled",
        "on": "On",
        "off": "Off"
      },
      "findings": {
        "pdc_no_external_source": {
          "label": "Forest root PDC has no external source",
          "hint": "Set NTP servers on {device} — it is the forest root PDC and every domain member follows it."
        },
        "source_local_clock": {
          "label": "Using the local clock",
          "hint": "Syncing from its own clock. Configure an NTP source (or, if domain-joined, check its DC)."
        },
        "dc_vm_host_sync": {
          "label": "DC is syncing with the VM host",
          "hint": "Disable the VM host time provider on this DC."
        },
        "ntp_server_unresolvable": {
          "label": "NTP server name is invalid or unresolved",
          "hint": "NTP server {host} does not resolve or is not a valid name — fix it or DNS."
        },
        "ntp_peer_unreachable": {
          "label": "NTP peer is unreachable",
          "hint": "No response from {source} — check UDP 123 outbound."
        },
        "domain_source_unavailable": {
          "label": "Domain time source unavailable",
          "hint": "Cannot find a domain time source — check DC reachability."
        },
        "member_not_on_hierarchy": {
          "label": "Not using the domain hierarchy",
          "hint": "Domain-joined but not using the domain hierarchy."
        },
        "sync_disabled": {
          "label": "Time synchronization is disabled",
          "hint": "Windows Time is disabled."
        },
        "sync_stale": {
          "label": "No recent successful synchronization",
          "hint": "No successful sync since {lastSuccessfulSyncAt}."
        },
        "correction_refused": {
          "label": "Time correction was refused",
          "hint": "The clock is too far off for Windows to correct itself; resync or fix manually."
        },
        "timezone_mismatch": {
          "label": "Timezone differs from expected",
          "hint": "Timezone is {actual}, expected {expected} (from {site or policy})."
        },
        "policy_not_applied": {
          "label": "Time policy was not applied",
          "hint": "Time policy could not be applied: {error}."
        },
        "policy_conflict_gpo": {
          "label": "Group Policy controls time settings",
          "hint": "W32Time is managed by Group Policy; Breeze is not changing it."
        }
      }
    }
  },
  "de-DE": {
    "timeSync": {
      "title": "Zeit",
      "loading": "Zeitstatus wird geladen…",
      "error": "Zeitstatus konnte nicht geladen werden.",
      "retry": "Erneut versuchen",
      "unknown": "Unbekannt",
      "yes": "Ja",
      "no": "Nein",
      "site": "Standort",
      "policy": "Richtlinie",
      "states": {
        "not_reported": "Noch keine Zeitdaten — dafür ist ein Agent-Update mit Zeitsynchronisierung erforderlich",
        "unsupported_os": "Auf diesem Betriebssystem noch nicht unterstützt"
      },
      "health": {
        "healthy": "Fehlerfrei",
        "warning": "Warnung",
        "critical": "Kritisch",
        "unknown": "Unbekannt"
      },
      "severity": {
        "critical": "Kritisch",
        "warning": "Warnung",
        "info": "Hinweis"
      },
      "received": "Empfangen: {{at}}",
      "collected": "Erfasst: {{at}}",
      "stale": "Veraltet — der letzte Zeitbericht wurde vor mehr als 90 Minuten empfangen.",
      "expected": "Erwartet: {{windows}} ({{iana}}), aus {{source}}: {{name}}",
      "expectedPolicy": "Erwartet: {{windows}} ({{iana}}), aus Richtlinie {{name}} — überschreibt die Zeitzone des Standorts",
      "managedBadge": "Durch Gruppenrichtlinie verwaltet",
      "unset": {
        "site_utc_default": "Keine erwartete Zeitzone (Standort verwendet den UTC-Standard)",
        "no_site": "Keine erwartete Zeitzone (kein Standort zugewiesen)",
        "unmapped": "Keine erwartete Zeitzone (für die Zeitzone des Standorts gibt es keine Windows-Zuordnung)"
      },
      "noFindings": "Keine Zeitbefunde in diesem Bericht.",
      "events": "Aktuelle Zeitereignisse ({{count}})",
      "noEvents": "Keine aktuellen Zeitereignisse.",
      "eventHeading": "Ereignis {{id}} · Stufe {{level}}",
      "noMessage": "Keine Ereignismeldung.",
      "fields": {
        "source": "Zeitquelle",
        "sourceKind": "Art der Quelle",
        "lastSync": "Letzte erfolgreiche Synchronisierung",
        "method": "Erfassungsmethode",
        "lastError": "Letzter Synchronisierungsfehler",
        "stratum": "NTP-Ebene",
        "poll": "Tatsächliches Abfrageintervall (Sekunden)",
        "syncType": "Synchronisierungstyp",
        "ntpServer": "NTP-Serverkonfiguration",
        "hosts": "Ermittelte NTP-Hosts",
        "specialPoll": "Spezielles Abfrageintervall (Sekunden)",
        "serviceState": "Windows-Zeitdienst",
        "serviceStartType": "Dienststart",
        "policyManaged": "Durch Gruppenrichtlinie verwaltet",
        "policyManagedValues": "Gruppenrichtlinienwerte",
        "hostProvider": "Zeitanbieter des VM-Hosts aktiviert",
        "joinType": "Beitrittstyp",
        "role": "Domänenrolle",
        "domain": "Domäne",
        "forest": "Gesamtstruktur",
        "pdc": "PDC",
        "windowsId": "Aktuelle Windows-Zeitzone",
        "bias": "Zeitversatz (Minuten)",
        "autoUpdate": "Automatische Zeitzone"
      },
      "values": {
        "NT5DS": "Domänenhierarchie (NT5DS)",
        "NTP": "NTP-Gegenstellen",
        "NoSync": "Keine Synchronisierung",
        "AllSync": "Alle Quellen",
        "ntp_peer": "NTP-Gegenstelle",
        "domain_peer": "Domänengegenstelle",
        "local_clock": "Lokale Uhr",
        "free_running": "Freilaufende Uhr",
        "vm_host": "VM-Host",
        "unknown": "Unbekannt",
        "provider_api": "Windows-Anbieter-API",
        "w32tm_tokens": "Windows-Zeitstatustoken",
        "events": "Time-Service-Ereignisse",
        "unavailable": "Nicht verfügbar",
        "none": "Nicht beigetreten",
        "workplace": "Am Arbeitsplatz registriert",
        "azure_ad": "Microsoft Entra beigetreten",
        "on_prem_ad": "Active Directory beigetreten",
        "hybrid_azure_ad": "Hybrider Entra-Beitritt",
        "workgroup": "Arbeitsgruppe",
        "entra_only": "Nur Entra",
        "member": "Domänenmitglied",
        "dc": "Domänencontroller",
        "pdc_emulator": "PDC-Emulator",
        "forest_root_pdc_emulator": "PDC-Emulator der Gesamtstruktur-Stammdomäne",
        "running": "Wird ausgeführt",
        "stopped": "Beendet",
        "start_pending": "Wird gestartet",
        "stop_pending": "Wird beendet",
        "paused": "Angehalten",
        "not_installed": "Nicht installiert",
        "auto": "Automatisch",
        "delayed_auto": "Automatisch (verzögert)",
        "manual": "Manuell",
        "trigger_manual": "Manuell (Triggerstart)",
        "disabled": "Deaktiviert",
        "on": "Ein",
        "off": "Aus"
      },
      "findings": {
        "pdc_no_external_source": {
          "label": "Der PDC der Gesamtstruktur-Stammdomäne hat keine externe Quelle",
          "hint": "Legen Sie NTP-Server auf {device} fest — das Gerät ist der PDC der Gesamtstruktur-Stammdomäne, dem alle Domänenmitglieder folgen."
        },
        "source_local_clock": {
          "label": "Lokale Uhr wird verwendet",
          "hint": "Synchronisiert mit der eigenen Uhr. Konfigurieren Sie eine NTP-Quelle (oder prüfen Sie bei Domänenbeitritt den Domänencontroller)."
        },
        "dc_vm_host_sync": {
          "label": "Domänencontroller synchronisiert mit dem VM-Host",
          "hint": "Deaktivieren Sie auf diesem Domänencontroller den Zeitanbieter des VM-Hosts."
        },
        "ntp_server_unresolvable": {
          "label": "NTP-Servername ist ungültig oder nicht auflösbar",
          "hint": "NTP-Server {host} kann nicht aufgelöst werden oder hat keinen gültigen Namen — korrigieren Sie den Namen oder DNS."
        },
        "ntp_peer_unreachable": {
          "label": "NTP-Gegenstelle ist nicht erreichbar",
          "hint": "Keine Antwort von {source} — prüfen Sie ausgehendes UDP auf Port 123."
        },
        "domain_source_unavailable": {
          "label": "Domänenzeitquelle nicht verfügbar",
          "hint": "Keine Domänenzeitquelle gefunden — prüfen Sie die Erreichbarkeit des Domänencontrollers."
        },
        "member_not_on_hierarchy": {
          "label": "Domänenhierarchie wird nicht verwendet",
          "hint": "Der Domäne beigetreten, verwendet jedoch nicht die Domänenhierarchie."
        },
        "sync_disabled": {
          "label": "Zeitsynchronisierung ist deaktiviert",
          "hint": "Der Windows-Zeitdienst ist deaktiviert."
        },
        "sync_stale": {
          "label": "Keine aktuelle erfolgreiche Synchronisierung",
          "hint": "Keine erfolgreiche Synchronisierung seit {lastSuccessfulSyncAt}."
        },
        "correction_refused": {
          "label": "Zeitkorrektur wurde abgelehnt",
          "hint": "Die Uhr weicht zu stark ab, als dass Windows sie selbst korrigieren könnte; synchronisieren Sie erneut oder korrigieren Sie sie manuell."
        },
        "timezone_mismatch": {
          "label": "Zeitzone weicht von der erwarteten Zeitzone ab",
          "hint": "Die Zeitzone ist {actual}, erwartet wird {expected} (aus {site or policy})."
        },
        "policy_not_applied": {
          "label": "Zeitrichtlinie wurde nicht angewendet",
          "hint": "Zeitrichtlinie konnte nicht angewendet werden: {error}."
        },
        "policy_conflict_gpo": {
          "label": "Gruppenrichtlinie steuert die Zeiteinstellungen",
          "hint": "W32Time wird durch Gruppenrichtlinie verwaltet; Breeze ändert die Einstellungen nicht."
        }
      }
    }
  },
  "es-419": {
    "timeSync": {
      "title": "Hora",
      "loading": "Cargando el estado de la hora…",
      "error": "No se pudo cargar el estado de la hora.",
      "retry": "Reintentar",
      "unknown": "Desconocido",
      "yes": "Sí",
      "no": "Negativo",
      "site": "Sitio",
      "policy": "Política",
      "states": {
        "not_reported": "Aún no hay datos de hora — se necesita una actualización del agente que incluya sincronización horaria",
        "unsupported_os": "Aún no se admite en este sistema operativo"
      },
      "health": {
        "healthy": "Correcto",
        "warning": "Advertencia",
        "critical": "Crítico",
        "unknown": "Desconocido"
      },
      "severity": {
        "critical": "Crítico",
        "warning": "Advertencia",
        "info": "Información"
      },
      "received": "Recibido: {{at}}",
      "collected": "Recopilado: {{at}}",
      "stale": "Desactualizado — el último informe de hora se recibió hace más de 90 minutos.",
      "expected": "Se espera: {{windows}} ({{iana}}), según {{source}}: {{name}}",
      "expectedPolicy": "Se espera: {{windows}} ({{iana}}), según la política {{name}} — reemplaza la zona horaria del sitio",
      "managedBadge": "Administrado por una directiva de grupo",
      "unset": {
        "site_utc_default": "Sin zona horaria esperada (el sitio usa UTC de forma predeterminada)",
        "no_site": "Sin zona horaria esperada (no hay ningún sitio asignado)",
        "unmapped": "Sin zona horaria esperada (la zona horaria del sitio no tiene correspondencia en Windows)"
      },
      "noFindings": "No hay hallazgos de hora en este informe.",
      "events": "Eventos de hora recientes ({{count}})",
      "noEvents": "No hay eventos de hora recientes.",
      "eventHeading": "Evento {{id}} · Nivel {{level}}",
      "noMessage": "No hay mensaje del evento.",
      "fields": {
        "source": "Origen de la hora",
        "sourceKind": "Tipo de origen",
        "lastSync": "Última sincronización correcta",
        "method": "Método de recopilación",
        "lastError": "Último error de sincronización",
        "stratum": "Nivel NTP",
        "poll": "Intervalo de consulta efectivo (segundos)",
        "syncType": "Tipo de sincronización",
        "ntpServer": "Configuración del servidor NTP",
        "hosts": "Hosts NTP identificados",
        "specialPoll": "Intervalo de consulta especial (segundos)",
        "serviceState": "Servicio de hora de Windows",
        "serviceStartType": "Inicio del servicio",
        "policyManaged": "Administrado por una directiva de grupo",
        "policyManagedValues": "Valores de la directiva de grupo",
        "hostProvider": "Proveedor de hora del host de la VM habilitado",
        "joinType": "Tipo de unión",
        "role": "Rol en el dominio",
        "domain": "Dominio",
        "forest": "Bosque",
        "pdc": "PDC",
        "windowsId": "Zona horaria actual de Windows",
        "bias": "Desfase (minutos)",
        "autoUpdate": "Zona horaria automática"
      },
      "values": {
        "NT5DS": "Jerarquía del dominio (NT5DS)",
        "NTP": "Pares NTP",
        "NoSync": "Sin sincronización",
        "AllSync": "Todos los orígenes",
        "ntp_peer": "Par NTP",
        "domain_peer": "Par del dominio",
        "local_clock": "Reloj local",
        "free_running": "Reloj de funcionamiento libre",
        "vm_host": "Host de la VM",
        "unknown": "Desconocido",
        "provider_api": "API del proveedor de Windows",
        "w32tm_tokens": "Tokens del estado de hora de Windows",
        "events": "Eventos de Time-Service",
        "unavailable": "No disponible",
        "none": "Sin unión",
        "workplace": "Registrado en el área de trabajo",
        "azure_ad": "Unido a Microsoft Entra",
        "on_prem_ad": "Unido a Active Directory",
        "hybrid_azure_ad": "Unión híbrida a Entra",
        "workgroup": "Grupo de trabajo",
        "entra_only": "Solo Entra",
        "member": "Miembro del dominio",
        "dc": "Controlador de dominio",
        "pdc_emulator": "Emulador de PDC",
        "forest_root_pdc_emulator": "Emulador de PDC de la raíz del bosque",
        "running": "En ejecución",
        "stopped": "Detenido",
        "start_pending": "Iniciando",
        "stop_pending": "Deteniendo",
        "paused": "En pausa",
        "not_installed": "No instalado",
        "auto": "Automático",
        "delayed_auto": "Automático (inicio retrasado)",
        "manual": "Modo manual",
        "trigger_manual": "Manual (inicio por desencadenador)",
        "disabled": "Deshabilitado",
        "on": "Activado",
        "off": "Desactivado"
      },
      "findings": {
        "pdc_no_external_source": {
          "label": "El PDC raíz del bosque no tiene un origen externo",
          "hint": "Configura servidores NTP en {device} — es el PDC raíz del bosque y todos los miembros del dominio lo siguen."
        },
        "source_local_clock": {
          "label": "Se está usando el reloj local",
          "hint": "Se sincroniza con su propio reloj. Configura un origen NTP (o, si está unido a un dominio, revisa su controlador de dominio)."
        },
        "dc_vm_host_sync": {
          "label": "El controlador de dominio se sincroniza con el host de la VM",
          "hint": "Deshabilita el proveedor de hora del host de la VM en este controlador de dominio."
        },
        "ntp_server_unresolvable": {
          "label": "El nombre del servidor NTP no es válido o no se resuelve",
          "hint": "El servidor NTP {host} no se resuelve o no tiene un nombre válido — corrige el nombre o DNS."
        },
        "ntp_peer_unreachable": {
          "label": "No se puede acceder al par NTP",
          "hint": "No hay respuesta de {source} — revisa el tráfico UDP saliente en el puerto 123."
        },
        "domain_source_unavailable": {
          "label": "El origen de hora del dominio no está disponible",
          "hint": "No se encuentra un origen de hora del dominio — revisa la conectividad con el controlador de dominio."
        },
        "member_not_on_hierarchy": {
          "label": "No se está usando la jerarquía del dominio",
          "hint": "Está unido al dominio, pero no usa su jerarquía."
        },
        "sync_disabled": {
          "label": "La sincronización horaria está deshabilitada",
          "hint": "El servicio de hora de Windows está deshabilitado."
        },
        "sync_stale": {
          "label": "No hay sincronizaciones correctas recientes",
          "hint": "No hay sincronizaciones correctas desde {lastSuccessfulSyncAt}."
        },
        "correction_refused": {
          "label": "Se rechazó la corrección de hora",
          "hint": "El desfase del reloj es demasiado grande para que Windows lo corrija; vuelve a sincronizarlo o corrígelo manualmente."
        },
        "timezone_mismatch": {
          "label": "La zona horaria difiere de la esperada",
          "hint": "La zona horaria es {actual}; se esperaba {expected} (según {site or policy})."
        },
        "policy_not_applied": {
          "label": "No se aplicó la política de hora",
          "hint": "No se pudo aplicar la política de hora: {error}."
        },
        "policy_conflict_gpo": {
          "label": "Una directiva de grupo controla la configuración de hora",
          "hint": "Una directiva de grupo administra W32Time; Breeze no modifica su configuración."
        }
      }
    }
  },
  "fr-CA": {
    "timeSync": {
      "title": "Heure",
      "loading": "Chargement de l’état de l’heure…",
      "error": "Impossible de charger l’état de l’heure.",
      "retry": "Réessayer",
      "unknown": "Inconnu",
      "yes": "Oui",
      "no": "Non",
      "site": "Site client",
      "policy": "Stratégie",
      "states": {
        "not_reported": "Aucune donnée horaire pour le moment — une mise à jour de l’agent incluant la synchronisation de l’heure est nécessaire",
        "unsupported_os": "Pas encore pris en charge sur ce système d’exploitation"
      },
      "health": {
        "healthy": "Bon état",
        "warning": "Avertissement",
        "critical": "Critique",
        "unknown": "Inconnu"
      },
      "severity": {
        "critical": "Critique",
        "warning": "Avertissement",
        "info": "Informations"
      },
      "received": "Reçu : {{at}}",
      "collected": "Recueilli : {{at}}",
      "stale": "Obsolète — le dernier rapport horaire a été reçu il y a plus de 90 minutes.",
      "expected": "Attendu : {{windows}} ({{iana}}), selon {{source}} : {{name}}",
      "expectedPolicy": "Attendu : {{windows}} ({{iana}}), selon la stratégie {{name}} — remplace le fuseau horaire du site",
      "managedBadge": "Géré par une stratégie de groupe",
      "unset": {
        "site_utc_default": "Aucun fuseau horaire attendu (le site utilise UTC par défaut)",
        "no_site": "Aucun fuseau horaire attendu (aucun site n’est attribué)",
        "unmapped": "Aucun fuseau horaire attendu (le fuseau du site n’a pas de correspondance Windows)"
      },
      "noFindings": "Aucun constat horaire dans ce rapport.",
      "events": "Événements horaires récents ({{count}})",
      "noEvents": "Aucun événement horaire récent.",
      "eventHeading": "Événement {{id}} · Niveau {{level}}",
      "noMessage": "Aucun message d’événement.",
      "fields": {
        "source": "Source de l’heure",
        "sourceKind": "Type de source",
        "lastSync": "Dernière synchronisation réussie",
        "method": "Méthode de collecte",
        "lastError": "Dernière erreur de synchronisation",
        "stratum": "Niveau NTP",
        "poll": "Intervalle d’interrogation effectif (secondes)",
        "syncType": "Type de synchronisation",
        "ntpServer": "Configuration du serveur NTP",
        "hosts": "Hôtes NTP identifiés",
        "specialPoll": "Intervalle d’interrogation spécial (secondes)",
        "serviceState": "Service de temps Windows",
        "serviceStartType": "Démarrage du service",
        "policyManaged": "Géré par une stratégie de groupe",
        "policyManagedValues": "Valeurs de la stratégie de groupe",
        "hostProvider": "Fournisseur de temps de l’hôte de la machine virtuelle activé",
        "joinType": "Type de jonction",
        "role": "Rôle dans le domaine",
        "domain": "Domaine",
        "forest": "Forêt",
        "pdc": "PDC",
        "windowsId": "Fuseau horaire Windows actuel",
        "bias": "Décalage (minutes)",
        "autoUpdate": "Fuseau horaire automatique"
      },
      "values": {
        "NT5DS": "Hiérarchie du domaine (NT5DS)",
        "NTP": "Pairs NTP",
        "NoSync": "Aucune synchronisation",
        "AllSync": "Toutes les sources",
        "ntp_peer": "Pair NTP",
        "domain_peer": "Pair du domaine",
        "local_clock": "Horloge locale",
        "free_running": "Horloge autonome",
        "vm_host": "Hôte de la machine virtuelle",
        "unknown": "Inconnu",
        "provider_api": "API du fournisseur Windows",
        "w32tm_tokens": "Jetons d’état de l’heure Windows",
        "events": "Événements Time-Service",
        "unavailable": "Indisponible",
        "none": "Non joint",
        "workplace": "Inscrit à l’espace de travail",
        "azure_ad": "Joint à Microsoft Entra",
        "on_prem_ad": "Joint à Active Directory",
        "hybrid_azure_ad": "Jonction hybride à Entra",
        "workgroup": "Groupe de travail",
        "entra_only": "Entra uniquement",
        "member": "Membre du domaine",
        "dc": "Contrôleur de domaine",
        "pdc_emulator": "Émulateur PDC",
        "forest_root_pdc_emulator": "Émulateur PDC du domaine racine de la forêt",
        "running": "En cours d’exécution",
        "stopped": "Arrêté",
        "start_pending": "Démarrage en cours",
        "stop_pending": "Arrêt en cours",
        "paused": "En pause",
        "not_installed": "Non installé",
        "auto": "Automatique",
        "delayed_auto": "Automatique (différé)",
        "manual": "Manuel",
        "trigger_manual": "Manuel (démarrage déclenché)",
        "disabled": "Désactivé",
        "on": "Activé",
        "off": "Désactivé"
      },
      "findings": {
        "pdc_no_external_source": {
          "label": "Le PDC racine de la forêt n’a pas de source externe",
          "hint": "Configurez des serveurs NTP sur {device} — il s’agit du PDC racine de la forêt et tous les membres du domaine le suivent."
        },
        "source_local_clock": {
          "label": "Utilisation de l’horloge locale",
          "hint": "Se synchronise sur sa propre horloge. Configurez une source NTP (ou vérifiez son contrôleur de domaine s’il est joint à un domaine)."
        },
        "dc_vm_host_sync": {
          "label": "Le contrôleur de domaine se synchronise avec l’hôte de la machine virtuelle",
          "hint": "Désactivez le fournisseur de temps de l’hôte de la machine virtuelle sur ce contrôleur de domaine."
        },
        "ntp_server_unresolvable": {
          "label": "Le nom du serveur NTP est invalide ou non résolu",
          "hint": "Le serveur NTP {host} ne peut pas être résolu ou son nom est invalide — corrigez le nom ou le DNS."
        },
        "ntp_peer_unreachable": {
          "label": "Le pair NTP est injoignable",
          "hint": "Aucune réponse de {source} — vérifiez le trafic UDP sortant sur le port 123."
        },
        "domain_source_unavailable": {
          "label": "La source de temps du domaine est indisponible",
          "hint": "Impossible de trouver une source de temps du domaine — vérifiez l’accessibilité du contrôleur de domaine."
        },
        "member_not_on_hierarchy": {
          "label": "La hiérarchie du domaine n’est pas utilisée",
          "hint": "Joint au domaine, mais n’utilise pas sa hiérarchie."
        },
        "sync_disabled": {
          "label": "La synchronisation de l’heure est désactivée",
          "hint": "Le service de temps Windows est désactivé."
        },
        "sync_stale": {
          "label": "Aucune synchronisation réussie récemment",
          "hint": "Aucune synchronisation réussie depuis {lastSuccessfulSyncAt}."
        },
        "correction_refused": {
          "label": "La correction de l’heure a été refusée",
          "hint": "Le décalage de l’horloge est trop important pour que Windows le corrige automatiquement ; resynchronisez-la ou corrigez-la manuellement."
        },
        "timezone_mismatch": {
          "label": "Le fuseau horaire diffère de celui attendu",
          "hint": "Le fuseau horaire est {actual}, mais {expected} est attendu (selon {site or policy})."
        },
        "policy_not_applied": {
          "label": "La stratégie horaire n’a pas été appliquée",
          "hint": "Impossible d’appliquer la stratégie horaire : {error}."
        },
        "policy_conflict_gpo": {
          "label": "Une stratégie de groupe contrôle les paramètres horaires",
          "hint": "W32Time est géré par une stratégie de groupe ; Breeze ne modifie pas ses paramètres."
        }
      }
    }
  },
  "fr-FR": {
    "timeSync": {
      "title": "Heure",
      "loading": "Chargement de l’état de l’heure…",
      "error": "Impossible de charger l’état de l’heure.",
      "retry": "Réessayer",
      "unknown": "Inconnu",
      "yes": "Oui",
      "no": "Non",
      "site": "Site client",
      "policy": "Stratégie",
      "states": {
        "not_reported": "Aucune donnée horaire pour le moment — une mise à jour de l’agent incluant la synchronisation de l’heure est nécessaire",
        "unsupported_os": "Pas encore pris en charge sur ce système d’exploitation"
      },
      "health": {
        "healthy": "Bon état",
        "warning": "Avertissement",
        "critical": "Critique",
        "unknown": "Inconnu"
      },
      "severity": {
        "critical": "Critique",
        "warning": "Avertissement",
        "info": "Informations"
      },
      "received": "Reçu : {{at}}",
      "collected": "Collecté : {{at}}",
      "stale": "Obsolète — le dernier rapport horaire a été reçu il y a plus de 90 minutes.",
      "expected": "Attendu : {{windows}} ({{iana}}), selon {{source}} : {{name}}",
      "expectedPolicy": "Attendu : {{windows}} ({{iana}}), selon la stratégie {{name}} — remplace le fuseau horaire du site",
      "managedBadge": "Géré par une stratégie de groupe",
      "unset": {
        "site_utc_default": "Aucun fuseau horaire attendu (le site utilise UTC par défaut)",
        "no_site": "Aucun fuseau horaire attendu (aucun site n’est attribué)",
        "unmapped": "Aucun fuseau horaire attendu (le fuseau du site n’a pas de correspondance Windows)"
      },
      "noFindings": "Aucun constat horaire dans ce rapport.",
      "events": "Événements horaires récents ({{count}})",
      "noEvents": "Aucun événement horaire récent.",
      "eventHeading": "Événement {{id}} · Niveau {{level}}",
      "noMessage": "Aucun message d’événement.",
      "fields": {
        "source": "Source de l’heure",
        "sourceKind": "Type de source",
        "lastSync": "Dernière synchronisation réussie",
        "method": "Méthode de collecte",
        "lastError": "Dernière erreur de synchronisation",
        "stratum": "Niveau NTP",
        "poll": "Intervalle d’interrogation effectif (secondes)",
        "syncType": "Type de synchronisation",
        "ntpServer": "Configuration du serveur NTP",
        "hosts": "Hôtes NTP identifiés",
        "specialPoll": "Intervalle d’interrogation spécial (secondes)",
        "serviceState": "Service de temps Windows",
        "serviceStartType": "Démarrage du service",
        "policyManaged": "Géré par une stratégie de groupe",
        "policyManagedValues": "Valeurs de la stratégie de groupe",
        "hostProvider": "Fournisseur de temps de l’hôte de la machine virtuelle activé",
        "joinType": "Type de jonction",
        "role": "Rôle dans le domaine",
        "domain": "Domaine",
        "forest": "Forêt",
        "pdc": "PDC",
        "windowsId": "Fuseau horaire Windows actuel",
        "bias": "Décalage (minutes)",
        "autoUpdate": "Fuseau horaire automatique"
      },
      "values": {
        "NT5DS": "Hiérarchie du domaine (NT5DS)",
        "NTP": "Pairs NTP",
        "NoSync": "Aucune synchronisation",
        "AllSync": "Toutes les sources",
        "ntp_peer": "Pair NTP",
        "domain_peer": "Pair du domaine",
        "local_clock": "Horloge locale",
        "free_running": "Horloge autonome",
        "vm_host": "Hôte de la machine virtuelle",
        "unknown": "Inconnu",
        "provider_api": "API du fournisseur Windows",
        "w32tm_tokens": "Jetons d’état de l’heure Windows",
        "events": "Événements Time-Service",
        "unavailable": "Indisponible",
        "none": "Non joint",
        "workplace": "Inscrit à l’espace de travail",
        "azure_ad": "Joint à Microsoft Entra",
        "on_prem_ad": "Joint à Active Directory",
        "hybrid_azure_ad": "Jonction hybride à Entra",
        "workgroup": "Groupe de travail",
        "entra_only": "Entra uniquement",
        "member": "Membre du domaine",
        "dc": "Contrôleur de domaine",
        "pdc_emulator": "Émulateur PDC",
        "forest_root_pdc_emulator": "Émulateur PDC du domaine racine de la forêt",
        "running": "En cours d’exécution",
        "stopped": "Arrêté",
        "start_pending": "Démarrage en cours",
        "stop_pending": "Arrêt en cours",
        "paused": "En pause",
        "not_installed": "Non installé",
        "auto": "Automatique",
        "delayed_auto": "Automatique (différé)",
        "manual": "Manuel",
        "trigger_manual": "Manuel (démarrage déclenché)",
        "disabled": "Désactivé",
        "on": "Activé",
        "off": "Désactivé"
      },
      "findings": {
        "pdc_no_external_source": {
          "label": "Le PDC racine de la forêt n’a pas de source externe",
          "hint": "Configurez des serveurs NTP sur {device} — il s’agit du PDC racine de la forêt et tous les membres du domaine le suivent."
        },
        "source_local_clock": {
          "label": "Utilisation de l’horloge locale",
          "hint": "Se synchronise sur sa propre horloge. Configurez une source NTP (ou vérifiez son contrôleur de domaine s’il est joint à un domaine)."
        },
        "dc_vm_host_sync": {
          "label": "Le contrôleur de domaine se synchronise avec l’hôte de la machine virtuelle",
          "hint": "Désactivez le fournisseur de temps de l’hôte de la machine virtuelle sur ce contrôleur de domaine."
        },
        "ntp_server_unresolvable": {
          "label": "Le nom du serveur NTP est invalide ou non résolu",
          "hint": "Le serveur NTP {host} ne peut pas être résolu ou son nom est invalide — corrigez le nom ou le DNS."
        },
        "ntp_peer_unreachable": {
          "label": "Le pair NTP est injoignable",
          "hint": "Aucune réponse de {source} — vérifiez le trafic UDP sortant sur le port 123."
        },
        "domain_source_unavailable": {
          "label": "La source de temps du domaine est indisponible",
          "hint": "Impossible de trouver une source de temps du domaine — vérifiez l’accessibilité du contrôleur de domaine."
        },
        "member_not_on_hierarchy": {
          "label": "La hiérarchie du domaine n’est pas utilisée",
          "hint": "Joint au domaine, mais n’utilise pas sa hiérarchie."
        },
        "sync_disabled": {
          "label": "La synchronisation de l’heure est désactivée",
          "hint": "Le service de temps Windows est désactivé."
        },
        "sync_stale": {
          "label": "Aucune synchronisation réussie récemment",
          "hint": "Aucune synchronisation réussie depuis {lastSuccessfulSyncAt}."
        },
        "correction_refused": {
          "label": "La correction de l’heure a été refusée",
          "hint": "Le décalage de l’horloge est trop important pour que Windows le corrige automatiquement ; resynchronisez-la ou corrigez-la manuellement."
        },
        "timezone_mismatch": {
          "label": "Le fuseau horaire diffère de celui attendu",
          "hint": "Le fuseau horaire est {actual}, mais {expected} est attendu (selon {site or policy})."
        },
        "policy_not_applied": {
          "label": "La stratégie horaire n’a pas été appliquée",
          "hint": "Impossible d’appliquer la stratégie horaire : {error}."
        },
        "policy_conflict_gpo": {
          "label": "Une stratégie de groupe contrôle les paramètres horaires",
          "hint": "W32Time est géré par une stratégie de groupe ; Breeze ne modifie pas ses paramètres."
        }
      }
    }
  },
  "it-IT": {
    "timeSync": {
      "title": "Ora",
      "loading": "Caricamento dello stato dell’ora…",
      "error": "Impossibile caricare lo stato dell’ora.",
      "retry": "Riprova",
      "unknown": "Sconosciuto",
      "yes": "Sì",
      "no": "Negativo",
      "site": "Sede",
      "policy": "Criterio",
      "states": {
        "not_reported": "Nessun dato sull’ora disponibile — è necessario un aggiornamento dell’agente che includa la sincronizzazione dell’ora",
        "unsupported_os": "Non ancora supportato su questo sistema operativo"
      },
      "health": {
        "healthy": "Regolare",
        "warning": "Avviso",
        "critical": "Critico",
        "unknown": "Sconosciuto"
      },
      "severity": {
        "critical": "Critico",
        "warning": "Avviso",
        "info": "Informazioni"
      },
      "received": "Ricevuto: {{at}}",
      "collected": "Raccolto: {{at}}",
      "stale": "Obsoleto — l’ultimo rapporto sull’ora è stato ricevuto più di 90 minuti fa.",
      "expected": "Previsto: {{windows}} ({{iana}}), da {{source}}: {{name}}",
      "expectedPolicy": "Previsto: {{windows}} ({{iana}}), dal criterio {{name}} — sostituisce il fuso orario della sede",
      "managedBadge": "Gestito da Criteri di gruppo",
      "unset": {
        "site_utc_default": "Nessun fuso orario previsto (la sede usa UTC come predefinito)",
        "no_site": "Nessun fuso orario previsto (nessuna sede assegnata)",
        "unmapped": "Nessun fuso orario previsto (il fuso orario della sede non ha una corrispondenza Windows)"
      },
      "noFindings": "Nessun rilievo sull’ora in questo rapporto.",
      "events": "Eventi recenti relativi all’ora ({{count}})",
      "noEvents": "Nessun evento recente relativo all’ora.",
      "eventHeading": "Evento {{id}} · Livello {{level}}",
      "noMessage": "Nessun messaggio dell’evento.",
      "fields": {
        "source": "Origine dell’ora",
        "sourceKind": "Tipo di origine",
        "lastSync": "Ultima sincronizzazione riuscita",
        "method": "Metodo di raccolta",
        "lastError": "Ultimo errore di sincronizzazione",
        "stratum": "Livello NTP",
        "poll": "Intervallo di polling effettivo (secondi)",
        "syncType": "Tipo di sincronizzazione",
        "ntpServer": "Configurazione del server NTP",
        "hosts": "Host NTP individuati",
        "specialPoll": "Intervallo di polling speciale (secondi)",
        "serviceState": "Servizio Ora di Windows",
        "serviceStartType": "Avvio del servizio",
        "policyManaged": "Gestito da Criteri di gruppo",
        "policyManagedValues": "Valori di Criteri di gruppo",
        "hostProvider": "Provider dell’ora dell’host VM abilitato",
        "joinType": "Tipo di aggiunta",
        "role": "Ruolo nel dominio",
        "domain": "Dominio",
        "forest": "Foresta",
        "pdc": "PDC",
        "windowsId": "Fuso orario Windows attuale",
        "bias": "Scostamento (minuti)",
        "autoUpdate": "Fuso orario automatico"
      },
      "values": {
        "NT5DS": "Gerarchia del dominio (NT5DS)",
        "NTP": "Peer di NTP",
        "NoSync": "Nessuna sincronizzazione",
        "AllSync": "Tutte le origini",
        "ntp_peer": "Peer di NTP",
        "domain_peer": "Peer del dominio",
        "local_clock": "Orologio locale",
        "free_running": "Orologio autonomo",
        "vm_host": "Host della VM",
        "unknown": "Sconosciuto",
        "provider_api": "API del provider Windows",
        "w32tm_tokens": "Token di stato dell’ora di Windows",
        "events": "Eventi Time-Service",
        "unavailable": "Non disponibile",
        "none": "Non aggiunto",
        "workplace": "Registrato nell’area di lavoro",
        "azure_ad": "Aggiunto a Microsoft Entra",
        "on_prem_ad": "Aggiunto ad Active Directory",
        "hybrid_azure_ad": "Aggiunta ibrida a Entra",
        "workgroup": "Gruppo di lavoro",
        "entra_only": "Solo Entra",
        "member": "Membro del dominio",
        "dc": "Controller di dominio",
        "pdc_emulator": "Emulatore PDC",
        "forest_root_pdc_emulator": "Emulatore PDC della radice della foresta",
        "running": "In esecuzione",
        "stopped": "Arrestato",
        "start_pending": "Avvio in corso",
        "stop_pending": "Arresto in corso",
        "paused": "In pausa",
        "not_installed": "Non installato",
        "auto": "Automatico",
        "delayed_auto": "Automatico (ritardato)",
        "manual": "Manuale",
        "trigger_manual": "Manuale (avvio su trigger)",
        "disabled": "Disabilitato",
        "on": "Attivato",
        "off": "Disattivato"
      },
      "findings": {
        "pdc_no_external_source": {
          "label": "Il PDC radice della foresta non ha un’origine esterna",
          "hint": "Imposta i server NTP su {device} — è il PDC radice della foresta e tutti i membri del dominio lo seguono."
        },
        "source_local_clock": {
          "label": "Utilizzo dell’orologio locale",
          "hint": "Si sincronizza con il proprio orologio. Configura un’origine NTP (oppure, se aggiunto a un dominio, controlla il suo controller di dominio)."
        },
        "dc_vm_host_sync": {
          "label": "Il controller di dominio si sincronizza con l’host della VM",
          "hint": "Disabilita il provider dell’ora dell’host VM su questo controller di dominio."
        },
        "ntp_server_unresolvable": {
          "label": "Il nome del server NTP non è valido o non viene risolto",
          "hint": "Il server NTP {host} non viene risolto o il nome non è valido — correggi il nome o il DNS."
        },
        "ntp_peer_unreachable": {
          "label": "Il peer NTP non è raggiungibile",
          "hint": "Nessuna risposta da {source} — controlla il traffico UDP in uscita sulla porta 123."
        },
        "domain_source_unavailable": {
          "label": "Origine dell’ora del dominio non disponibile",
          "hint": "Impossibile trovare un’origine dell’ora del dominio — verifica la raggiungibilità del controller di dominio."
        },
        "member_not_on_hierarchy": {
          "label": "La gerarchia del dominio non è utilizzata",
          "hint": "Aggiunto al dominio, ma non utilizza la gerarchia del dominio."
        },
        "sync_disabled": {
          "label": "La sincronizzazione dell’ora è disabilitata",
          "hint": "Il servizio Ora di Windows è disabilitato."
        },
        "sync_stale": {
          "label": "Nessuna sincronizzazione recente riuscita",
          "hint": "Nessuna sincronizzazione riuscita dal {lastSuccessfulSyncAt}."
        },
        "correction_refused": {
          "label": "La correzione dell’ora è stata rifiutata",
          "hint": "Lo scostamento dell’orologio è eccessivo perché Windows lo corregga automaticamente; risincronizza o correggi manualmente."
        },
        "timezone_mismatch": {
          "label": "Il fuso orario è diverso da quello previsto",
          "hint": "Il fuso orario è {actual}, ma è previsto {expected} (da {site or policy})."
        },
        "policy_not_applied": {
          "label": "Il criterio relativo all’ora non è stato applicato",
          "hint": "Impossibile applicare il criterio relativo all’ora: {error}."
        },
        "policy_conflict_gpo": {
          "label": "Criteri di gruppo controlla le impostazioni dell’ora",
          "hint": "W32Time è gestito da Criteri di gruppo; Breeze non ne modifica le impostazioni."
        }
      }
    }
  },
  "pt-BR": {
    "timeSync": {
      "title": "Hora",
      "loading": "Carregando o status de hora…",
      "error": "Não foi possível carregar o status de hora.",
      "retry": "Tentar novamente",
      "unknown": "Desconhecido",
      "yes": "Sim",
      "no": "Não",
      "site": "Local",
      "policy": "Política",
      "states": {
        "not_reported": "Ainda não há dados de hora — é necessária uma atualização do agente que inclua sincronização de hora",
        "unsupported_os": "Ainda não há suporte neste sistema operacional"
      },
      "health": {
        "healthy": "Saudável",
        "warning": "Aviso",
        "critical": "Crítico",
        "unknown": "Desconhecido"
      },
      "severity": {
        "critical": "Crítico",
        "warning": "Aviso",
        "info": "Informações"
      },
      "received": "Recebido: {{at}}",
      "collected": "Coletado: {{at}}",
      "stale": "Desatualizado — o último relatório de hora foi recebido há mais de 90 minutos.",
      "expected": "Esperado: {{windows}} ({{iana}}), de {{source}}: {{name}}",
      "expectedPolicy": "Esperado: {{windows}} ({{iana}}), da política {{name}} — substitui o fuso horário do local",
      "managedBadge": "Gerenciado pela Política de Grupo",
      "unset": {
        "site_utc_default": "Nenhum fuso horário esperado (o local usa UTC como padrão)",
        "no_site": "Nenhum fuso horário esperado (nenhum local atribuído)",
        "unmapped": "Nenhum fuso horário esperado (o fuso horário do local não tem correspondência no Windows)"
      },
      "noFindings": "Nenhuma ocorrência relacionada à hora neste relatório.",
      "events": "Eventos de hora recentes ({{count}})",
      "noEvents": "Nenhum evento de hora recente.",
      "eventHeading": "Evento {{id}} · Nível {{level}}",
      "noMessage": "Nenhuma mensagem do evento.",
      "fields": {
        "source": "Fonte de hora",
        "sourceKind": "Tipo de fonte",
        "lastSync": "Última sincronização bem-sucedida",
        "method": "Método de coleta",
        "lastError": "Último erro de sincronização",
        "stratum": "Nível NTP",
        "poll": "Intervalo de consulta efetivo (segundos)",
        "syncType": "Tipo de sincronização",
        "ntpServer": "Configuração do servidor NTP",
        "hosts": "Hosts NTP identificados",
        "specialPoll": "Intervalo de consulta especial (segundos)",
        "serviceState": "Serviço de Hora do Windows",
        "serviceStartType": "Inicialização do serviço",
        "policyManaged": "Gerenciado pela Política de Grupo",
        "policyManagedValues": "Valores da Política de Grupo",
        "hostProvider": "Provedor de hora do host da VM habilitado",
        "joinType": "Tipo de ingresso",
        "role": "Função no domínio",
        "domain": "Domínio",
        "forest": "Floresta",
        "pdc": "PDC",
        "windowsId": "Fuso horário atual do Windows",
        "bias": "Desvio (minutos)",
        "autoUpdate": "Fuso horário automático"
      },
      "values": {
        "NT5DS": "Hierarquia do domínio (NT5DS)",
        "NTP": "Pares NTP",
        "NoSync": "Sem sincronização",
        "AllSync": "Todas as fontes",
        "ntp_peer": "Par NTP",
        "domain_peer": "Par do domínio",
        "local_clock": "Relógio local",
        "free_running": "Relógio independente",
        "vm_host": "Host da VM",
        "unknown": "Desconhecido",
        "provider_api": "API do provedor do Windows",
        "w32tm_tokens": "Tokens de status de hora do Windows",
        "events": "Eventos do Time-Service",
        "unavailable": "Indisponível",
        "none": "Sem ingresso",
        "workplace": "Registrado no local de trabalho",
        "azure_ad": "Ingressado no Microsoft Entra",
        "on_prem_ad": "Ingressado no Active Directory",
        "hybrid_azure_ad": "Ingresso híbrido no Entra",
        "workgroup": "Grupo de trabalho",
        "entra_only": "Somente Entra",
        "member": "Membro do domínio",
        "dc": "Controlador de domínio",
        "pdc_emulator": "Emulador de PDC",
        "forest_root_pdc_emulator": "Emulador de PDC da raiz da floresta",
        "running": "Em execução",
        "stopped": "Parado",
        "start_pending": "Iniciando",
        "stop_pending": "Parando",
        "paused": "Pausado",
        "not_installed": "Não instalado",
        "auto": "Automático",
        "delayed_auto": "Automático (atrasado)",
        "manual": "Modo manual",
        "trigger_manual": "Manual (início por gatilho)",
        "disabled": "Desabilitado",
        "on": "Ativado",
        "off": "Desativado"
      },
      "findings": {
        "pdc_no_external_source": {
          "label": "O PDC raiz da floresta não tem fonte externa",
          "hint": "Configure servidores NTP em {device} — ele é o PDC raiz da floresta e todos os membros do domínio o seguem."
        },
        "source_local_clock": {
          "label": "Usando o relógio local",
          "hint": "Está sincronizando com o próprio relógio. Configure uma fonte NTP (ou, se ingressado em um domínio, verifique o controlador de domínio)."
        },
        "dc_vm_host_sync": {
          "label": "O controlador de domínio está sincronizando com o host da VM",
          "hint": "Desabilite o provedor de hora do host da VM neste controlador de domínio."
        },
        "ntp_server_unresolvable": {
          "label": "O nome do servidor NTP é inválido ou não pode ser resolvido",
          "hint": "O servidor NTP {host} não pode ser resolvido ou o nome é inválido — corrija o nome ou o DNS."
        },
        "ntp_peer_unreachable": {
          "label": "O par NTP está inacessível",
          "hint": "Nenhuma resposta de {source} — verifique o tráfego UDP de saída na porta 123."
        },
        "domain_source_unavailable": {
          "label": "Fonte de hora do domínio indisponível",
          "hint": "Não foi possível encontrar uma fonte de hora do domínio — verifique a conectividade com o controlador de domínio."
        },
        "member_not_on_hierarchy": {
          "label": "Não está usando a hierarquia do domínio",
          "hint": "Ingressado no domínio, mas não está usando a hierarquia do domínio."
        },
        "sync_disabled": {
          "label": "A sincronização de hora está desabilitada",
          "hint": "O serviço de Hora do Windows está desabilitado."
        },
        "sync_stale": {
          "label": "Nenhuma sincronização bem-sucedida recente",
          "hint": "Nenhuma sincronização bem-sucedida desde {lastSuccessfulSyncAt}."
        },
        "correction_refused": {
          "label": "A correção de hora foi recusada",
          "hint": "O desvio do relógio é grande demais para o Windows corrigir automaticamente; sincronize novamente ou corrija manualmente."
        },
        "timezone_mismatch": {
          "label": "O fuso horário é diferente do esperado",
          "hint": "O fuso horário é {actual}; o esperado é {expected} (de {site or policy})."
        },
        "policy_not_applied": {
          "label": "A política de hora não foi aplicada",
          "hint": "Não foi possível aplicar a política de hora: {error}."
        },
        "policy_conflict_gpo": {
          "label": "A Política de Grupo controla as configurações de hora",
          "hint": "O W32Time é gerenciado pela Política de Grupo; o Breeze não altera suas configurações."
        }
      }
    }
  },
  "tr-TR": {
    "timeSync": {
      "title": "Saat",
      "loading": "Saat durumu yükleniyor…",
      "error": "Saat durumu yüklenemedi.",
      "retry": "Yeniden dene",
      "unknown": "Bilinmiyor",
      "yes": "Evet",
      "no": "Hayır",
      "site": "Konum",
      "policy": "İlke",
      "states": {
        "not_reported": "Henüz saat verisi yok — saat eşitlemeyi içeren bir aracı güncellemesi gerekiyor",
        "unsupported_os": "Bu işletim sisteminde henüz desteklenmiyor"
      },
      "health": {
        "healthy": "Sağlıklı",
        "warning": "Uyarı",
        "critical": "Kritik",
        "unknown": "Bilinmiyor"
      },
      "severity": {
        "critical": "Kritik",
        "warning": "Uyarı",
        "info": "Bilgi"
      },
      "received": "Alınma: {{at}}",
      "collected": "Toplanma: {{at}}",
      "stale": "Güncel değil — son saat raporu 90 dakikadan uzun süre önce alındı.",
      "expected": "Beklenen: {{windows}} ({{iana}}), kaynak {{source}}: {{name}}",
      "expectedPolicy": "Beklenen: {{windows}} ({{iana}}), {{name}} ilkesinden — konumun saat dilimini geçersiz kılar",
      "managedBadge": "Grup İlkesi tarafından yönetiliyor",
      "unset": {
        "site_utc_default": "Beklenen saat dilimi yok (konum varsayılan UTC saat dilimini kullanıyor)",
        "no_site": "Beklenen saat dilimi yok (atanmış konum yok)",
        "unmapped": "Beklenen saat dilimi yok (konumun saat diliminin Windows eşlemesi yok)"
      },
      "noFindings": "Bu raporda saatle ilgili bulgu yok.",
      "events": "Son saat olayları ({{count}})",
      "noEvents": "Yakın zamanda saat olayı yok.",
      "eventHeading": "Olay {{id}} · Düzey {{level}}",
      "noMessage": "Olay iletisi yok.",
      "fields": {
        "source": "Saat kaynağı",
        "sourceKind": "Kaynak türü",
        "lastSync": "Son başarılı eşitleme",
        "method": "Toplama yöntemi",
        "lastError": "Son eşitleme hatası",
        "stratum": "NTP düzeyi",
        "poll": "Etkin sorgulama aralığı (saniye)",
        "syncType": "Eşitleme türü",
        "ntpServer": "NTP sunucusu yapılandırması",
        "hosts": "Ayrıştırılan NTP ana bilgisayarları",
        "specialPoll": "Özel sorgulama aralığı (saniye)",
        "serviceState": "Windows Zamanı hizmeti",
        "serviceStartType": "Hizmetin başlatılması",
        "policyManaged": "Grup İlkesi tarafından yönetiliyor",
        "policyManagedValues": "Grup İlkesi değerleri",
        "hostProvider": "VM ana bilgisayarı zaman sağlayıcısı etkin",
        "joinType": "Katılım türü",
        "role": "Etki alanı rolü",
        "domain": "Etki alanı",
        "forest": "Orman",
        "pdc": "PDC",
        "windowsId": "Geçerli Windows saat dilimi",
        "bias": "Sapma (dakika)",
        "autoUpdate": "Otomatik saat dilimi"
      },
      "values": {
        "NT5DS": "Etki alanı hiyerarşisi (NT5DS)",
        "NTP": "NTP eşleri",
        "NoSync": "Eşitleme yok",
        "AllSync": "Tüm kaynaklar",
        "ntp_peer": "NTP eşi",
        "domain_peer": "Etki alanı eşi",
        "local_clock": "Yerel saat",
        "free_running": "Bağımsız çalışan saat",
        "vm_host": "VM ana bilgisayarı",
        "unknown": "Bilinmiyor",
        "provider_api": "Windows sağlayıcı API’si",
        "w32tm_tokens": "Windows saat durumu belirteçleri",
        "events": "Time-Service olayları",
        "unavailable": "Kullanılamıyor",
        "none": "Katılmamış",
        "workplace": "İş yeri kaydı yapılmış",
        "azure_ad": "Microsoft Entra’ya katılmış",
        "on_prem_ad": "Active Directory’ye katılmış",
        "hybrid_azure_ad": "Entra’ya hibrit katılmış",
        "workgroup": "Çalışma grubu",
        "entra_only": "Yalnızca Entra",
        "member": "Etki alanı üyesi",
        "dc": "Etki alanı denetleyicisi",
        "pdc_emulator": "PDC öykünücüsü",
        "forest_root_pdc_emulator": "Orman kökü PDC öykünücüsü",
        "running": "Çalışıyor",
        "stopped": "Durduruldu",
        "start_pending": "Başlatılıyor",
        "stop_pending": "Durduruluyor",
        "paused": "Duraklatıldı",
        "not_installed": "Yüklü değil",
        "auto": "Otomatik",
        "delayed_auto": "Otomatik (gecikmeli)",
        "manual": "El ile",
        "trigger_manual": "El ile (tetikleyiciyle başlatma)",
        "disabled": "Devre dışı",
        "on": "Açık",
        "off": "Kapalı"
      },
      "findings": {
        "pdc_no_external_source": {
          "label": "Orman kökü PDC’sinin dış kaynağı yok",
          "hint": "{device} üzerinde NTP sunucularını ayarlayın — bu cihaz orman kökü PDC’sidir ve tüm etki alanı üyeleri onu izler."
        },
        "source_local_clock": {
          "label": "Yerel saat kullanılıyor",
          "hint": "Kendi saatiyle eşitleniyor. Bir NTP kaynağı yapılandırın (veya etki alanına katılmışsa etki alanı denetleyicisini kontrol edin)."
        },
        "dc_vm_host_sync": {
          "label": "Etki alanı denetleyicisi VM ana bilgisayarıyla eşitleniyor",
          "hint": "Bu etki alanı denetleyicisinde VM ana bilgisayarı zaman sağlayıcısını devre dışı bırakın."
        },
        "ntp_server_unresolvable": {
          "label": "NTP sunucusu adı geçersiz veya çözümlenemiyor",
          "hint": "NTP sunucusu {host} çözümlenemiyor veya adı geçersiz — adı ya da DNS’i düzeltin."
        },
        "ntp_peer_unreachable": {
          "label": "NTP eşine ulaşılamıyor",
          "hint": "{source} yanıt vermiyor — 123 numaralı bağlantı noktasındaki giden UDP trafiğini kontrol edin."
        },
        "domain_source_unavailable": {
          "label": "Etki alanı saat kaynağı kullanılamıyor",
          "hint": "Etki alanı saat kaynağı bulunamıyor — etki alanı denetleyicisinin erişilebilirliğini kontrol edin."
        },
        "member_not_on_hierarchy": {
          "label": "Etki alanı hiyerarşisi kullanılmıyor",
          "hint": "Etki alanına katılmış ancak etki alanı hiyerarşisini kullanmıyor."
        },
        "sync_disabled": {
          "label": "Saat eşitleme devre dışı",
          "hint": "Windows Zamanı hizmeti devre dışı."
        },
        "sync_stale": {
          "label": "Yakın zamanda başarılı eşitleme yok",
          "hint": "{lastSuccessfulSyncAt} tarihinden beri başarılı eşitleme yok."
        },
        "correction_refused": {
          "label": "Saat düzeltmesi reddedildi",
          "hint": "Saat sapması Windows’un kendiliğinden düzeltemeyeceği kadar büyük; yeniden eşitleyin veya el ile düzeltin."
        },
        "timezone_mismatch": {
          "label": "Saat dilimi beklenenden farklı",
          "hint": "Saat dilimi {actual}, beklenen {expected} ({site or policy} kaynağından)."
        },
        "policy_not_applied": {
          "label": "Saat ilkesi uygulanmadı",
          "hint": "Saat ilkesi uygulanamadı: {error}."
        },
        "policy_conflict_gpo": {
          "label": "Grup İlkesi saat ayarlarını denetliyor",
          "hint": "W32Time, Grup İlkesi tarafından yönetiliyor; Breeze ayarları değiştirmiyor."
        }
      }
    }
  }
}
```

- [ ] Run the exact insertion command below. It validates all 120 leaves, placeholder parity, and the precise duplicate allowance before writing. It preserves unrelated locale bytes and existing baseline comments, and adds the required R1 comment beside each `devices.json` baseline. The seven baselines increase by exactly one: de-DE 166→167, es-419 128→129, fr-CA 157→158, fr-FR 157→158, it-IT 146→147, pt-BR 177→178, tr-TR 90→91.

```bash
python3 - <<'PYLOCALES'
import json
import re
from pathlib import Path

plan_path = Path(
    'docs/superpowers/plans/monitoring/'
    '2026-09-28-time-sync-w01a-api-web-visibility.md'
)
plan = plan_path.read_text()
blocks = [block.split('```', 1)[0] for block in plan.split('```json\n')[1:]]
payloads = next(
    json.loads(block)
    for block in blocks
    if block.startswith('{\n  "en": {\n    "timeSync":')
)
locales = ['de-DE', 'en', 'es-419', 'fr-CA', 'fr-FR', 'it-IT', 'pt-BR', 'tr-TR']
assert set(payloads) == set(locales)
baselines = {
    'de-DE': 166,
    'es-419': 128,
    'fr-CA': 157,
    'fr-FR': 157,
    'it-IT': 146,
    'pt-BR': 177,
    'tr-TR': 90,
}
allowed_duplicates = {'timeSync.fields.pdc'}
placeholder_pattern = re.compile(r'\{\{[^{}]+\}\}|\{[^{}]+\}')

def flatten(obj, prefix=''):
    values = {}
    for key, value in obj.items():
        full_key = f'{prefix}.{key}' if prefix else key
        if isinstance(value, dict):
            values.update(flatten(value, full_key))
        else:
            assert isinstance(value, str) and value.strip(), full_key
            values[full_key] = value
    return values

english = flatten(payloads['en'])
assert len(english) == 120
writes = []
for locale in locales:
    member = payloads[locale]
    assert set(member) == {'timeSync'}, locale
    translated = flatten(member)
    assert translated.keys() == english.keys(), locale
    for key, value in translated.items():
        assert sorted(placeholder_pattern.findall(value)) == sorted(
            placeholder_pattern.findall(english[key])
        ), (locale, key)
    if locale != 'en':
        duplicates = {
            key for key, value in translated.items() if value == english[key]
        }
        assert duplicates == allowed_duplicates, (locale, duplicates)
        assert translated['timeSync.fields.pdc'] == 'PDC'
    path = Path('apps/web/src/locales') / locale / 'devices.json'
    text = path.read_text()
    assert text.startswith('{\n  "aiActivity": {'), path
    assert 'timeSync' not in json.loads(text), path
    insertion = json.dumps(member, ensure_ascii=False, indent=2)[2:-2]
    replacement = '{\n' + insertion + ',\n' + text[2:]
    assert json.loads(replacement)['timeSync'] == member['timeSync']
    writes.append((path, replacement))

coverage_path = Path('apps/web/src/lib/i18n/translationCoverage.test.ts')
coverage = coverage_path.read_text()
for locale, baseline in baselines.items():
    locale_pattern = re.compile(
        rf"(^  '{re.escape(locale)}': \{{\n)(.*?)(^  \}},)",
        re.MULTILINE | re.DOTALL,
    )
    matches = list(locale_pattern.finditer(coverage))
    assert len(matches) == 1, locale
    match = matches[0]
    body = match.group(2)
    baseline_pattern = re.compile(
        r"^(    'devices\.json': )(\d+)(,.*)$", re.MULTILINE
    )
    entries = list(baseline_pattern.finditer(body))
    assert len(entries) == 1, locale
    entry = entries[0]
    assert int(entry.group(2)) == baseline, (locale, entry.group(2))
    comment = (
        '    // +1: timeSync.fields.pdc — PDC is the locale-invariant '
        'Windows Active Directory role acronym.\n'
    )
    assert comment not in body, locale
    changed = (
        body[:entry.start()]
        + comment
        + entry.group(1)
        + str(baseline + 1)
        + entry.group(3)
        + body[entry.end():]
    )
    coverage = coverage[:match.start(2)] + changed + coverage[match.end(2):]
writes.append((coverage_path, coverage))
for path, replacement in writes:
    path.write_text(replacement)
print('Inserted 120 timeSync leaves in all eight catalogs; each translated baseline increased by one for PDC.')
PYLOCALES
```

- [ ] Run `cd apps/web && npx vitest run src/components/devices/time/DeviceTimeSection.test.tsx src/components/devices/time/DeviceTimeSection.integration.test.tsx src/components/devices/DeviceInfoTab.test.tsx src/lib/i18n/keyUsage.test.ts src/lib/i18n/translationCoverage.test.ts`; expected PASS for reporting states, stale evidence, errors/retry, escaped events, provenance, null values, race cleanup, and placement. Verify no `timeSync.*` keys appear as rendered text.
- [ ] Commit:

```bash
git add apps/web/src/components/devices/time/DeviceTimeSection.tsx apps/web/src/components/devices/time/TimeEventsList.tsx apps/web/src/components/devices/time/types.ts apps/web/src/components/devices/time/timeSyncCopy.ts apps/web/src/components/devices/time/fixtures.ts apps/web/src/components/devices/time/DeviceTimeSection.test.tsx apps/web/src/components/devices/time/DeviceTimeSection.integration.test.tsx apps/web/src/components/devices/DeviceInfoTab.tsx apps/web/src/components/devices/DeviceInfoTab.test.tsx apps/web/src/locales/de-DE/devices.json apps/web/src/locales/en/devices.json apps/web/src/locales/es-419/devices.json apps/web/src/locales/fr-CA/devices.json apps/web/src/locales/fr-FR/devices.json apps/web/src/locales/it-IT/devices.json apps/web/src/locales/pt-BR/devices.json apps/web/src/locales/tr-TR/devices.json apps/web/src/lib/i18n/translationCoverage.test.ts
git commit -m "feat(time-sync): show device time health and fixes" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 10: Document visibility and register the documentation page

**Files:** Create `apps/docs/src/content/docs/features/time-sync.mdx`, `apps/web/src/components/devices/time/timeSyncDocs.test.ts`; Modify `apps/docs/astro.config.mjs:130`.

**Interfaces:** Consumes W01a finding codes and timezone/freshness rules. Produces Starlight slug `features/time-sync`, with no promise of unshipped collection, alerts, fleet reports, or policy actions.

- [ ] Write `apps/web/src/components/devices/time/timeSyncDocs.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { TIME_SYNC_FINDING_CODES } from '@breeze/shared';
const docs = new URL(
  '../../../../../docs/src/content/docs/features/time-sync.mdx',
  import.meta.url,
);
const sidebar = new URL(
  '../../../../../docs/astro.config.mjs',
  import.meta.url,
);
it('documents every visibility finding, the UTC rule and sidebar entry', () => {
  const text = readFileSync(docs, 'utf8');
  for (const code of TIME_SYNC_FINDING_CODES.filter(
    (c) => !c.startsWith('policy_'),
  ))
    expect(text).toContain(code);
  expect(text).toContain('UTC');
  expect(text).toContain('Etc/UTC');
  expect(text).toContain('90 minutes');
  expect(text).toContain('agent update');
  expect(readFileSync(sidebar, 'utf8')).toContain(
    "{ slug: 'features/time-sync' }",
  );
});
```

- [ ] Run `cd apps/web && npx vitest run src/components/devices/time/timeSyncDocs.test.ts`; expected FAIL: ENOENT for the new document.

- [ ] Implement `apps/docs/src/content/docs/features/time-sync.mdx`:

```mdx
---
title: Time synchronization
description: Inspect Windows time sources, synchronization health, timezone expectations, and recent time events.
---

The **Time** section in a device's Info tab shows the latest Windows time report. It appears after Operating System.

This visibility release accepts reports but requires an agent update that includes time sync before data appears. Until then, Windows devices show “No time data yet — this needs an agent update that includes time sync”. Other operating systems show “Not supported on this OS yet”.

## What Breeze checks

A report includes the Windows Time service state and startup mode, synchronization type, configured NTP peers, whether Group Policy manages those settings, and whether a VM host time provider is enabled. It also includes the reported source, collection method, last successful synchronization, last error, stratum and poll interval.

Domain information identifies workgroup, Entra-only, member, domain-controller and PDC roles. Timezone information includes the current Windows timezone, bias, automatic timezone state and the expected timezone with its source. Unknown values remain Unknown; they are not guessed from translated command output.

Recent Time-Service events are display evidence. Breeze evaluates event IDs and structured values, not the translated message. A failure stays active for up to 24 hours unless a later successful synchronization clears it. A later recurrence becomes active again.

## Freshness and health

Reports are expected every 30 minutes once a supporting agent is installed. A report received more than **90 minutes** ago is marked Stale. Its stored observations remain visible so you can inspect what was last reported; stale does not mean a new failure has been observed.

Critical findings take precedence over warnings. Information findings, including a timezone mismatch, do not make time synchronization unhealthy. If synchronization status is unavailable and there are no findings, health is Unknown.

## Findings and fixes

| Finding | Meaning and suggested fix |
| --- | --- |
| `pdc_no_external_source` | A forest-root PDC is following the domain hierarchy or reports that it has no external source. Configure external NTP servers on that PDC; the domain follows it. |
| `source_local_clock` | Windows is using its local or free-running clock. Configure an NTP source, or check the domain controller if this is a domain member. |
| `dc_vm_host_sync` | A domain controller has a VM host time provider enabled or is using the host as its source. Disable VM host time synchronization on that DC. |
| `ntp_server_unresolvable` | Windows reported a name-resolution failure or an NTP peer name has invalid syntax. Correct the configured peer or DNS. W32Time flag suffixes such as `,0x9` are recognized and are not treated as part of the name. |
| `ntp_peer_unreachable` | A time peer did not respond. Check peer reachability and outbound UDP port 123. |
| `domain_source_unavailable` | Windows cannot locate a domain time source. Check domain-controller reachability. |
| `member_not_on_hierarchy` | A domain member or non-root DC is not using NT5DS or AllSync and the setting is not controlled by Group Policy. Restore domain-hierarchy synchronization. |
| `sync_disabled` | Synchronization type is NoSync or the Windows Time service is disabled. Enable Windows Time and select a suitable source. |
| `sync_stale` | The last successful synchronization exceeds the greater of three poll intervals or 24 hours, or Windows reports stale synchronization. Check the source and synchronize again. If no interval is reported, the fallback poll interval is seven days. |
| `correction_refused` | Windows refused a time correction. Correct the large clock difference manually or resynchronize using the appropriate Windows administration tools. |
| `timezone_mismatch` | The device's Windows timezone differs from its expected timezone and automatic timezone is not on. Review the site timezone and the device timezone. This is information, not a synchronization-health warning. |

A disabled service suppresses the separate stale-sync finding. Group Policy management suppresses the domain-hierarchy recommendation; this page does not change Group Policy or device configuration.

## Expected timezone and the UTC default

This release derives the expected timezone from the device's site. Site values **UTC** and **Etc/UTC** are treated as an unset default, so they do not produce a timezone mismatch—even when the device uses Pacific Standard Time. The section explains “No expected timezone (site uses the UTC default)”. This prevents an untouched site default from flagging an entire fleet.

Comparison uses Windows timezone IDs. For example, America/New_York and America/Detroit both map to Eastern Standard Time. Site changes are reflected the next time the device view is read. If there is no site or the site's IANA timezone has no Windows mapping, Breeze explains why no expected timezone is available. It does not invent a mapping. In particular, Antarctica/Troll has no CLDR Windows mapping.

Review the displayed source and site name before correcting the device. Automatic timezone being on suppresses a mismatch finding. This visibility release does not apply time policies or offer time-changing commands.
```

At `apps/docs/astro.config.mjs:130`, replace:

```text
                { slug: 'features/hardware-monitoring' },
```

with:

```js
                { slug: 'features/hardware-monitoring' },
                { slug: 'features/time-sync' },
```

- [ ] Run `cd apps/web && npx vitest run src/components/devices/time/timeSyncDocs.test.ts`; expected PASS for all 11 visibility codes, freshness, UTC-default explanation, and sidebar linkage.
- [ ] Commit:

```bash
git add apps/docs/src/content/docs/features/time-sync.mdx apps/docs/astro.config.mjs apps/web/src/components/devices/time/timeSyncDocs.test.ts
git commit -m "docs(time-sync): explain device visibility and findings" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 11: Verify tenancy contracts, migration order, and all three typechecks

**Files:** Test existing `apps/api/src/__tests__/integration/{rls-coverage,tenantCascade,tenant-export-policy,tenantExportErasureRoundtrip,orgMergeRegistry,orgLifecycleFoundations}.integration.test.ts`; Test `apps/api/src/routes/devices/{cascadeDelete,moveOrg.coverage}.test.ts`; Test feature files from Tasks 1–10. Modify this plan's checkboxes only after the corresponding checks pass; no new production files belong to this verification task.

**Interfaces:** Consumes the complete W01a implementation and the existing contract runners. Produces verified RLS coverage, ownership-FK deferrability, cascade/move/merge/export coverage, current migration ordering, and API/shared/web type consistency. This final verification task reruns existing failing-test/implementation cycles from Tasks 1–10; it adds no artificial failing test or duplicate implementation.

- [ ] Run Task 2's mapping test with the exact R2 `['Antarctica/Troll']` exception and Task 6's `unmapped` view test. Contract issues 1–4 are resolved below; no further mapping decision is required.
- [ ] Run the existing targeted unit regressions (no full unit suites):

```bash
(cd packages/shared && npx vitest run src/validators/timeSync.test.ts src/validators/ntpServerHosts.test.ts src/utils/windowsZones.test.ts)
(cd apps/api && npx vitest run src/services/timeSync/expectedTimezone.test.ts src/services/timeSync/findings.test.ts src/services/timeSync/freshness.test.ts src/services/timeSync/view.test.ts src/routes/agents/timeStatus.test.ts src/routes/agents/timeStatus.mounted.test.ts src/routes/devices/timeStatus.test.ts src/middleware/bodyLimit.test.ts)
(cd apps/api && npx vitest run src/routes/devices/cascadeDelete.test.ts src/routes/devices/moveOrg.coverage.test.ts src/services/deviceDeletion.test.ts src/services/orgMerge.test.ts src/db/migrationRlsScope.test.ts src/db/autoMigrate.test.ts)
(cd apps/api && npx vitest run src/services/aiToolsDevice.timeSync.test.ts src/services/aiToolsDevice.timeSync.registry.test.ts src/services/helperToolFilter.test.ts src/services/llm/toolCapture/surfaces.test.ts src/services/aiGuardrails.agentPrincipal.contract.test.ts src/services/aiAgents/runLoop.test.ts src/__tests__/mcp-coverage.test.ts)
(cd apps/web && npx vitest run src/components/devices/time/DeviceTimeSection.test.tsx src/components/devices/time/DeviceTimeSection.integration.test.tsx src/components/devices/time/timeSyncDocs.test.ts src/components/devices/DeviceInfoTab.test.tsx src/lib/i18n/keyUsage.test.ts src/lib/i18n/translationCoverage.test.ts)
```

Expected PASS with the binding R1–R17 resolutions applied. Before the corresponding implementations the exact failures are pinned in Tasks 1–10; a missing module, omitted registration, wrong scope, stale reset boundary, or untranslated key is a failure, not a reason to weaken an assertion.

- [ ] Run every index-mandated tenancy contract against the private worktree stack. Run the teardown even when a command fails; the shell trap covers that cleanup. The RLS coverage suite has its own runner and is not selected through the integration config.

```bash
(
  set -e
  trap 'pnpm test-stack down' EXIT
  pnpm test-stack up
  DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage
  (cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/tenantCascade.integration.test.ts)
  (cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/tenant-export-policy.integration.test.ts)
  (cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts)
  (cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/orgMergeRegistry.integration.test.ts)
  (cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/orgLifecycleFoundations.integration.test.ts)
  (cd apps/api && npx vitest run --config vitest.integration.config.ts src/services/timeSync/migrations.integration.test.ts src/services/timeSync/ingest.integration.test.ts)
  pnpm db:check-drift
)
```

Expected PASS: `device_time_status` is covered by forced RLS and every tenant lifecycle list; wrong-tenant insert fails with SQLSTATE 42501; wrong composite owner fails with 23503; foreign reads/updates/deletes affect zero rows; the FK is deferrable but initially immediate; export open JSON columns remain excluded; initial/reset races accept exactly one snapshot.

- [ ] Run the exact current CI typechecks (`.github/workflows/ci.yml:374,380,383–384`):

```bash
pnpm exec tsc --build apps/api/tsconfig.tests.json
pnpm --filter @breeze/shared typecheck
(cd apps/web && pnpm exec astro check)
```

Expected PASS for API source and tests, shared source and tests, and web Astro/React. Do not replace the API build-mode command with the old source-only checker.

- [ ] Run the R17 linters before committing (also run the applicable commands before each earlier task's implementation commit):

```bash
pnpm --filter @breeze/api lint
pnpm --filter @breeze/web lint
(cd packages/shared && pnpm exec eslint src/constants/timeSync.ts src/constants/index.ts src/validators/timeSync.ts src/validators/timeSync.test.ts src/validators/ntpServerHosts.test.ts src/validators/index.ts src/utils/windowsZones.ts src/utils/windowsZones.test.ts src/utils/index.ts)
```

Expected PASS. W01a creates no Go code, so `gofmt -l` is not applicable in this wave.

- [ ] Inspect the migration ceiling and diff before committing final evidence:

```bash
ls apps/api/migrations | grep -E '^[0-9]{4}-.*\.sql$' | sort | tail -1
bash scripts/check-migration-naming.sh --against-ref origin/main
git diff --check
rg -n 'device_time_status' apps/api/src/services/tenantCascade.ts apps/api/src/routes/devices/core.ts apps/api/src/services/orgMergeRegistry.ts apps/api/src/services/tenantExportPolicyRegistry.ts
rg -n 'get_device_time_status' apps/api/src/services apps/web/src/components/ai-risk/tierConfig.ts
```

Expected: the reserved migration still sorts after committed migrations; all registration hits in Tasks 3 and 8 exist. If the ceiling moved, the index explicitly permits renaming upward before shipping; update the migration replay reference and this plan's commands together, and record that contract adjustment. Never rename a shipped migration.

- [ ] Mark completed checkboxes in this document only after actual execution; preserve any verification failures and the R2 mapping exception in the implementation PR. This planning pass has not run implementation tests. Commit the completed execution record:

```bash
git add docs/superpowers/plans/monitoring/2026-09-28-time-sync-w01a-api-web-visibility.md
git commit -m "docs(time-sync): record W01a verification" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## Self-Review

| Owned spec requirement | Implementation and test tasks |
| --- | --- |
| §1–3 visibility-only Windows scope and no-data state | Tasks 6, 7, 9, 10 |
| §4.1–4.6 shared snapshot vocabulary, nulls, caps, event fields, strict validation | Task 1; agent collection remains W01b |
| §5.1 transactional snapshot acceptance, duplicate rejection and reset exception | Task 5; Task 7 preserves the R4 stale-sequence reason for sender commit |
| §5.2 all eleven W01a findings, ordered/deduplicated details and worst health | Task 4; display/fix copy in Task 9; reference in Task 10 |
| §5.3 failure/success recurrence, 24-hour activity and seven-day marks | Task 4; persisted marks in Task 5 |
| §5.4 CLDR all-territory mapping, aliases, UTC default, Windows-ID comparison, provenance | Tasks 2, 4, 6, 9; R2 explicit Troll exception and unmapped view coverage |
| §5.5 90-minute receipt freshness | Tasks 4, 6, 9, 10 |
| §6.1 latest-status columns, indexes, ownership FKs and forced RLS | Task 3 |
| §6.2 idempotent reserved migration and current ceiling | Tasks 3, 11 |
| §6.3 org/device cascade, denormalized move, merge and every export column | Tasks 3, 11; dynamic deviceDeletion path explicitly tested |
| §8.1 host grammar needed by later policy/agent waves, without settings schema | Task 1 |
| §8.5/index §F.3 forward-compatible enforcement report schemas only | Task 1; W01a view null in Task 6 |
| §10 device Info Time section after Operating System, states, fields, GPO badge, events, provenance | Task 9; R3 hint provenance comes from the parent view, with absent/stale detail tests |
| R1 complete translations and exact protocol-token duplicate baselines | Task 9; translation coverage in Tasks 9 and 11 |
| R16 tracked-wave branch and R17 formatted examples/lint checks | Global constraints; Task 11 |
| §11 device AI tool, all registry/profile/helper/SDK surfaces and MCP entries | Tasks 7, 8 |
| §11 docs visibility, findings/fixes, UTC rule, sidebar | Task 10 |
| §12 focused tests and tenancy contracts, API/shared/web typechecks | Tests in every implementation task; Task 11 final verification |
| W01a exclusions: §5.6 daily, §7 alerts, §8 settings/enforcement, §9 commands, fleet UI, agent/lab work | No production implementation for these later-wave responsibilities |

**Template coverage audit:** `git show --stat` was read for all four cited commits. `ddfcd2a044` supplies schema/tenancy/ingest/view/routes/body-limit/MCP/AI registration patterns; its settings, heartbeat, retention workers and configuration UI are later-wave scope. `8d79246f47` is agent work and introduces no W01a site. `b9b294e759` supplies the colocated integration-test discovery precedent; its alert/streak/monitor code is excluded. `57c10e0c4f` supplies locale/components/docs/sidebar patterns; fleet columns/filters and related page objects belong to W02. Its old `agents.test.ts` change asserts hardware settings in heartbeat and its `ai-tools.mdx` row documents the hardware configuration feature, so neither has a time-sync equivalent until W03a.

**Placeholder scan:** No unfinished-code markers, omitted function bodies, or “copy a similar implementation” steps remain. Spread operators are real code; generated fixture/mapping/locale commands are complete artifact implementations. Task 2 uses the approved explicit R2 exception with no obsolete decision gate. Locale payloads and interpolation keys are verified in memory; R4 response and R3 parent-view provenance are covered by executable regression examples. No implementation test suites were run during plan authoring.

**Authoring verification (contract repair):** All 11 task numbers are retained. All 50 existing-code search anchors remain byte-for-byte intact and are distinguished from formatted replacement code. Prettier checks passed for 49 complete TS/TSX/JS blocks; 38 replacement fragments were formatted in context. There are no Go blocks. The locale insertion command was executed against an in-memory filesystem: 120 keys per catalog, identical interpolation placeholders, unchanged authoritative English, only `PDC` duplicated, seven exact `+1` baseline changes, and unrelated catalog bytes preserved. The embedded R3 hint helper passed five runtime cases for parent provenance, translated fallbacks, and device name. `git diff --check` passed for this plan. Full implementation test suites remain unexecuted because this is a document-only repair.

**Type-consistency check:** Constants preserve index §A literals and severity order. Validators preserve §B and §F.3 field names, nullability and strictness; Zod 4 preserves `ZodString` through refinement (`packages/shared/package.json:36`). The generator uses the binding `packages/shared/scripts/generate-windows-zones.mjs` path, all territories and the pinned `cldrVersion`. Services preserve §C signatures; the API and web `DeviceTimeStatusView` interfaces have the same fields and shared enum types. `stale` remains a boolean beside the three-state discriminant. SQL/Drizzle/export policy contain only W01a §D columns. `enforcement` is parsed but never persisted or acted on in this wave and is always null in the view. Route status codes and bodies follow §E with the R4 `stale_sequence` reason; hardware's 422/409 behavior is not used. No monitor or built-in version changes occur.

**Review Focus coverage:** Focus 1 exact 10:00/10:05/10:10/10:40 recurrence is in Task 4; focus 3 whitespace and repeated W32Time flags are in Tasks 1 and 4; focus 4 UTC plus Pacific Standard Time is in Tasks 4 and 6 and its copy in Task 9; focus 5 lower sequence after strictly more than one hour is tested against real PostgreSQL in Task 5. Additional first-write races, changed-site projection, and cross-org/deletion coverage are pinned in Tasks 3, 5, 6 and 7. Focus 2 German collection output and all lab proofs are W01b responsibilities.

## Contract issues

1. **RESOLVED — Every picker timezone cannot map to a Windows zone (R2).** CLDR 48.2 has no Windows mapping or mapped alias for `Antarctica/Troll`. Task 2 asserts exactly `['Antarctica/Troll']` is unmapped, and Task 6 retains `expectedUnsetReason: 'unmapped'` view coverage. All CLDR-representable picker zones map; neither a fabricated mapping nor a picker restriction is permitted. Asia/Kolkata and UTC use authoritative aliases/sentinel handling.

2. **RESOLVED — “Pure” expected-timezone resolver versus warn-once side effect.** The index §C.2 clarification and Task 4 describe `expectedTimezone.ts` as deterministic and DB-free with a warn-once diagnostic, preserving the signature. Task 4 tests that diagnostic; the findings resolver remains fully pure.

3. **RESOLVED — Fix-hint placeholders cannot all come from finding detail (R3).** Task 9 passes the device display name and parent `timezone.expected` to `findingCopy`. `{device}` falls back to the device ID; `{site or policy}` uses `expected.sourceName`, then the translated `expected.source`, or translated unknown when absent. Tests cover absent/stale detail provenance and unnamed site/policy sources. Cross-wave detail shapes remain unchanged.

4. **RESOLVED — Device-deletion registration is indirect.** The index Global constraints clarification and Task 3 register `device_time_status` in the central core cascade list consumed by `getDeviceCascadeDeleteTables()` and test the dynamic deletion path. No duplicate DELETE or unrelated retirement hook is added.

5. **RESOLVED — English locale duplication (R1).** Task 9 contains full translations for every new key in all seven non-English catalogs, exact token-only duplicate baseline increments with explanatory comments, and translation-coverage verification. No prose exemptions are introduced.

6. **RESOLVED — Rejected-snapshot sender commit response (R4).** Task 7 returns `result.reason` when present and tests `200 { accepted: false, reason: 'stale_sequence' }`. W01b and W03b senders may commit only after the qualified 2xx response defined by R4; W01a does not implement collection or cursor persistence.

7. **RESOLVED — Migration ceiling includes directories.** Task 11 uses the index's SQL-filename-filtered command before sorting, so `preflight/` and `optional/` cannot mask the newest migration.

**Remaining open issues:** None. R5's event-selection/budget implementation and R6–R10 belong to W01b; R11–R13 belong to W02; R14–R15 belong to management waves. W01a keeps their wire contracts compatible, including the distinct 512 KiB API body ceiling and 256 KiB sender budget. R16 is inherited explicitly above; R17 applies to all implementation examples and final lint verification (there are no Go blocks in W01a).
