# Hardware & RAID Monitoring — API Contract Implementation Plan
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the tenant-safe hardware-health API, snapshot processing, retention, read tools, and inherited collection settings that later waves consume.
**Architecture:** Shared leaf modules define the wire vocabulary and server-derived health. One transaction locks each device health row, applies accepted observations and transitions, and persists the rollup; existing configuration-policy infrastructure delivers settings through the post-scoped heartbeat block. Operator reads and the AI tool share one view, while the configuration tab uses the existing feature-link save flow.
**Tech Stack:** TypeScript, Zod, Hono, Drizzle, PostgreSQL RLS, BullMQ, Redis, React, Vitest/jsdom.
**Spec:** `docs/superpowers/specs/monitoring/2026-09-23-hardware-raid-monitoring-design.md`.
**Index:** `docs/superpowers/plans/monitoring/2026-09-23-hardware-monitoring.md`.
**Wave:** W01, branch `feature/<parent#>-hardware-monitoring/wave-<sub#>`.
**Depends on:** None.

## Global Constraints

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

The copied registration bullet mentions `alerts.subject_key`; that clause belongs to W03 and changes no W01 file. All commands below start at the repository root. Source anchors are the inspected pre-change lines, so locate their named block after earlier tasks move lines. Each numbered checkbox is a 2–5 minute work unit; run commands to completion and inspect exit codes. Commit only after the task's green check; the three feature parity suites intentionally remain red between Task 4 and Task 15.

## Review Focus

2. Two snapshots for the same device arriving concurrently after an agent restart (sequence reset)
   — ingest must serialize on the health row and apply the 1 h reset rule; W01 ingest test.
   **Pinned by Task 11** with independent PostgreSQL request contexts and a same-sequence reset race.

## File Structure

- Create `packages/shared/src/constants/hardwareHealth.ts`, `packages/shared/src/constants/hardwareHealth.test.ts`: closed vocabulary and health derivation.
- Create `packages/shared/src/validators/hardwareHealth.ts`, `packages/shared/src/validators/hardwareHealth.test.ts`: snapshot and settings schemas.
- Modify `packages/shared/src/constants/index.ts`, `packages/shared/src/constants/configFeatureTypes.ts`, `packages/shared/src/validators/index.ts`: barrel exports and feature acceptance.
- Create `apps/api/src/db/schema/hardwareHealth.ts`: four enums and three tables.
- Modify `apps/api/src/db/schema/index.ts`, `apps/api/src/db/schema/configurationPolicies.ts`: schema export, config enum and settings table.
- Create `apps/api/migrations/2026-10-27-100000-hardware-health-tables.sql`, `apps/api/migrations/2026-10-27-100100-hardware-monitoring-config-feature.sql`: idempotent schema, constraints and RLS.
- Create `apps/api/src/services/hardwareHealth/migrations.integration.test.ts`: live migration, replay, ownership and bounds proofs.
- Modify `apps/api/vitest.config.ts`, `apps/api/vitest.integration.config.ts`: route colocated integration suites to the correct runner.
- Modify `apps/api/src/services/tenantCascade.ts`, `apps/api/src/routes/devices/core.ts`, `apps/api/src/services/orgMergeRegistry.ts`, `apps/api/src/services/tenantExportPolicyRegistry.ts`, `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`: mandatory tenant lifecycle registrations.
- Modify `apps/api/src/services/configurationPolicy.ts`, `apps/api/src/services/policyBaselineDefaults.ts`, `apps/api/src/routes/configurationPolicies/featureLinks.ts`, `apps/api/src/routes/configurationPolicies/featureLinks.test.ts`: normalize and validate hardware settings with an applied baseline.
- Create `apps/api/src/services/configurationPolicy.hardwareHealth.test.ts`: normalized settings round trips.
- Modify `apps/api/src/routes/agents/helpers.ts`, `apps/api/src/routes/agents/heartbeat.ts`, `apps/api/src/routes/agents/heartbeat.test.ts`: hierarchy, cache, provenance and post-scoped delivery.
- Create `apps/api/src/routes/agents/helpers.hardwareHealth.test.ts`: settings resolver and cache regressions.
- Create `apps/api/src/services/hardwareHealth/freshness.ts`, `apps/api/src/services/hardwareHealth/freshness.test.ts`: per-tier freshness windows.
- Create `apps/api/src/services/hardwareHealth/ingest.ts`, `apps/api/src/services/hardwareHealth/ingest.test.ts`, `apps/api/src/services/hardwareHealth/ingest.integration.test.ts`: component reduction and serialized persistence.
- Create `apps/api/src/routes/agents/hardwareHealth.ts`, `apps/api/src/routes/agents/hardwareHealth.test.ts`: bounded main-agent ingest transport.
- Modify `apps/api/src/routes/agents/index.ts`, `apps/api/src/routes/devices/index.ts`, `apps/api/src/services/mcpCoverage.ts`: route mounting and MCP coverage.
- Create `apps/api/src/services/hardwareHealth/view.ts`, `apps/api/src/services/hardwareHealth/view.test.ts`, `apps/api/src/routes/devices/hardwareHealth.ts`, `apps/api/src/routes/devices/hardwareHealth.test.ts`: serialized view and authorized operator read.
- Modify `apps/api/src/services/aiToolsDevice.ts`: tier-1 hardware-health tool.
- Create `apps/api/src/services/aiToolsDevice.hardwareHealth.test.ts`: AI access-before-read test.
- Create `apps/api/src/services/hardwareHealth/retire.ts`, `apps/api/src/services/hardwareHealth/retire.test.ts`, `apps/api/src/jobs/hardwareHealthRetention.ts`, `apps/api/src/jobs/hardwareHealthRetention.test.ts`: W03 retirement seam and bounded daily reaper.
- Modify `apps/api/src/services/workerRegistry.ts`, `apps/api/src/jobs/workerReadinessManifest.ts`, `apps/api/src/jobs/scheduleRegistry.ts`: retention lifecycle, readiness and daily slot.
- Create `apps/web/src/components/configurationPolicies/featureTabs/HardwareMonitoringTab.tsx`, `apps/web/src/components/configurationPolicies/featureTabs/HardwareMonitoringTab.test.tsx`: inherited collection controls.
- Modify `apps/web/src/components/configurationPolicies/featureTabs/types.ts`, `apps/web/src/components/configurationPolicies/featureTabs/useFeatureLink.ts`, `apps/web/src/components/configurationPolicies/featureTabs/useFeatureLink.test.ts`, `apps/web/src/components/configurationPolicies/ConfigPolicyDetailPage.tsx`, `apps/web/src/components/devices/DeviceEffectiveConfigTab.tsx`: feature parity, applied default display and mutation feedback.

### Task 1: Define the complete state-to-health vocabulary

**Files:** Create `packages/shared/src/constants/hardwareHealth.ts`, `hardwareHealth.test.ts`; Modify `packages/shared/src/constants/index.ts:166` (append export).
**Interfaces:** Consumes spec §4.3. Produces `HardwareComponentType`, `HardwareSource`, `HardwareHealth`, `HardwareSourceStatus`, all index §B constants, `deriveHardwareHealth(input): HardwareHealth`, `worstHardwareHealth(values: readonly HardwareHealth[]): HardwareHealth`.

- [ ] **Step 1: Write the failing table and flag tests.**
```ts
// packages/shared/src/constants/hardwareHealth.test.ts
import { expect, it } from 'vitest';
import { HARDWARE_STATES, HARDWARE_STATE_HEALTH, deriveHardwareHealth, worstHardwareHealth,
  type HardwareComponentType } from './hardwareHealth';
it('maps every legal state exactly once', () => {
  for (const type of Object.keys(HARDWARE_STATES) as HardwareComponentType[]) {
    expect(Object.keys(HARDWARE_STATE_HEALTH[type]).sort()).toEqual([...HARDWARE_STATES[type]].sort());
    for (const state of HARDWARE_STATES[type]) expect(deriveHardwareHealth({componentType:type,state,predictiveFailure:false})).toBe(HARDWARE_STATE_HEALTH[type][state]);
  }
});
it.each([
  ['virtual_disk','degraded','critical'], ['physical_disk','degraded','warning'],
  ['virtual_disk','rebuilding','warning'], ['cache_battery','learning','ok'],
  ['collector','backing_off','warning'], ['bmc','unknown','unknown'],
] as const)('%s %s derives %s', (componentType,state,health) => {
  expect(deriveHardwareHealth({componentType,state,predictiveFailure:false})).toBe(health);
});
it('raises flags without lowering failed state', () => {
  const input = {componentType:'physical_disk' as const,state:'online',predictiveFailure:false};
  expect(deriveHardwareHealth({...input,predictiveFailure:true})).toBe('warning');
  expect(deriveHardwareHealth({...input,memberErrors:true})).toBe('warning');
  expect(deriveHardwareHealth({...input,osHealthStatus:'warning'})).toBe('warning');
  expect(deriveHardwareHealth({...input,osHealthStatus:'unhealthy'})).toBe('critical');
  expect(deriveHardwareHealth({...input,smartPassed:false})).toBe('critical');
  expect(deriveHardwareHealth({...input,state:'failed',smartPassed:true,osHealthStatus:'healthy'})).toBe('critical');
  expect(worstHardwareHealth([])).toBe('unknown');
  expect(worstHardwareHealth(['unknown','ok'])).toBe('ok');
  expect(worstHardwareHealth(['critical','warning','ok'])).toBe('critical');
});
```
- [ ] **Step 2: Run red.** `cd packages/shared && npx vitest run src/constants/hardwareHealth.test.ts` — expect `Failed to load url ./hardwareHealth`.
- [ ] **Step 3: Implement the leaf module and export.**
```ts
// packages/shared/src/constants/hardwareHealth.ts
export const HARDWARE_COMPONENT_TYPES = ['controller','virtual_disk','physical_disk','cache_battery','enclosure','bmc','collector'] as const;
export type HardwareComponentType = (typeof HARDWARE_COMPONENT_TYPES)[number];
export const AGENT_REPORTABLE_COMPONENT_TYPES = ['controller','virtual_disk','physical_disk','cache_battery','enclosure','bmc'] as const;
export const HARDWARE_SOURCES = ['storcli','perccli','megacli','ssacli','arcconf','omreport','mdadm','zfs','storage_spaces','windows_physical_disk','smartctl','ipmi','racadm','hponcfg','redfish','snmp'] as const;
export type HardwareSource = (typeof HARDWARE_SOURCES)[number];
export const RAID_TIER_SOURCES = ['storcli','perccli','megacli','ssacli','arcconf','omreport','mdadm','zfs','storage_spaces','ipmi','racadm','hponcfg'] as const;
export const DISK_TIER_SOURCES = ['windows_physical_disk','smartctl'] as const;
export const HARDWARE_HEALTH_LEVELS = ['ok','warning','critical','unknown'] as const;
export type HardwareHealth = (typeof HARDWARE_HEALTH_LEVELS)[number];
export const HARDWARE_HEALTH_RANK: Record<HardwareHealth, number> = {unknown:0,ok:1,warning:2,critical:3};
export const HARDWARE_SOURCE_STATUSES = ['ok','unavailable','superseded','failed','backing_off','disabled'] as const;
export type HardwareSourceStatus = (typeof HARDWARE_SOURCE_STATUSES)[number];
export const HARDWARE_TIERS = ['raid','disk','none','disabled'] as const;
export const HARDWARE_STATES: Record<HardwareComponentType, readonly string[]> = {
  controller:['ok','degraded','failed','unknown'],
  virtual_disk:['optimal','rebuilding','initializing','checking','migrating','degraded','partially_degraded','failed','offline','unknown'],
  physical_disk:['online','hotspare','ready','jbod','unconfigured','rebuilding','copyback','foreign','shielded','predictive_failure','degraded','failed','missing','offline','unknown'],
  cache_battery:['ok','charging','learning','degraded','failed','missing','unknown'],
  enclosure:['ok','degraded','failed','unknown'], bmc:['ok','unknown'], collector:['ok','failed','backing_off'],
};
export const HARDWARE_STATE_HEALTH: Record<HardwareComponentType, Record<string, HardwareHealth>> = {
  controller:{ok:'ok',degraded:'warning',failed:'critical',unknown:'unknown'},
  virtual_disk:{optimal:'ok',rebuilding:'warning',initializing:'warning',checking:'warning',migrating:'warning',degraded:'critical',partially_degraded:'critical',failed:'critical',offline:'critical',unknown:'unknown'},
  physical_disk:{online:'ok',hotspare:'ok',ready:'ok',jbod:'ok',unconfigured:'ok',rebuilding:'warning',copyback:'warning',foreign:'warning',shielded:'warning',predictive_failure:'warning',degraded:'warning',failed:'critical',missing:'critical',offline:'critical',unknown:'unknown'},
  cache_battery:{ok:'ok',charging:'ok',learning:'ok',degraded:'warning',failed:'critical',missing:'critical',unknown:'unknown'},
  enclosure:{ok:'ok',degraded:'warning',failed:'critical',unknown:'unknown'},
  bmc:{ok:'ok',unknown:'unknown'}, collector:{ok:'ok',failed:'warning',backing_off:'warning'},
};
export function worstHardwareHealth(values: readonly HardwareHealth[]): HardwareHealth {
  return values.reduce<HardwareHealth>((a,b) => HARDWARE_HEALTH_RANK[b] > HARDWARE_HEALTH_RANK[a] ? b : a, 'unknown');
}
export function deriveHardwareHealth(input: {
  componentType: HardwareComponentType; state: string; predictiveFailure: boolean;
  memberErrors?: boolean; osHealthStatus?: 'healthy' | 'warning' | 'unhealthy' | null;
  smartPassed?: boolean | null;
}): HardwareHealth {
  return worstHardwareHealth([
    HARDWARE_STATE_HEALTH[input.componentType][input.state] ?? 'unknown',
    input.predictiveFailure || input.memberErrors || input.osHealthStatus === 'warning' ? 'warning' : 'unknown',
    input.osHealthStatus === 'unhealthy' || input.smartPassed === false ? 'critical' : 'unknown',
  ]);
}
// Append to packages/shared/src/constants/index.ts:
export * from './hardwareHealth';
```
- [ ] **Step 4: Run green.** `cd packages/shared && npx vitest run src/constants/hardwareHealth.test.ts` — all tests pass.
- [ ] **Step 5: Commit.**
```bash
git add packages/shared/src/constants/hardwareHealth.ts packages/shared/src/constants/hardwareHealth.test.ts packages/shared/src/constants/index.ts
git commit -m $'feat(hardware): define health vocabulary\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 2: Publish snapshot and inline-settings validators

**Files:** Create `packages/shared/src/validators/hardwareHealth.ts`, `.test.ts`; Modify `packages/shared/src/validators/index.ts:821` (export).
**Interfaces:** Consumes Task 1 constants. Produces all index §B schemas, inferred report types and `HARDWARE_MONITORING_DEFAULTS`.

- [ ] **Step 1: Write the complete boundary tests.**
```ts
// packages/shared/src/validators/hardwareHealth.test.ts
import { expect, it } from 'vitest';
import { hardwareComponentReportSchema as component, hardwareSourceReportSchema as source,
  hardwareHealthSnapshotSchema as snapshot, hardwareMonitoringInlineSettingsSchema as settings,
  HARDWARE_MONITORING_DEFAULTS } from './hardwareHealth';
const disk = {componentKey:'smart:serial',componentType:'physical_disk',source:'smartctl',name:'Disk',state:'online'};
const wire = {snapshotId:'11111111-1111-4111-8111-111111111111',sequence:0,collectedAt:'2026-09-23T00:00:00Z',agentVersion:'1',pollIntervalMinutes:10,diskHealthIntervalMinutes:60,tiersRun:['disk'],sources:[],components:[]};
it('defaults and nullable fields round trip', () => {
  expect(settings.parse({})).toEqual(HARDWARE_MONITORING_DEFAULTS);
  expect(component.parse({...disk,serial:null,smartPassed:null})).toMatchObject({predictiveFailure:false,alertExempt:false,attributes:{},serial:null,smartPassed:null});
  expect(snapshot.parse(wire).sequence).toBe(0);
});
it.each(['ok','unavailable','superseded','failed','backing_off','disabled'])('requires complete only for %s', status => {
  expect(source.safeParse({source:'smartctl',status}).success).toBe(status !== 'ok');
  for (const complete of [false,true]) expect(source.safeParse({source:'smartctl',status,complete}).success).toBe(true);
});
it.each([{componentType:'collector'},{componentKey:''},{componentKey:'x'.repeat(201)},{sizeBytes:-1},{progressPercent:101},{temperatureC:201},{predictiveFailure:1}])('rejects malformed component %j', extra => expect(component.safeParse({...disk,...extra}).success).toBe(false));
it.each([{pollIntervalMinutes:4},{pollIntervalMinutes:61},{diskHealthIntervalMinutes:14},{diskHealthIntervalMinutes:1441},{enabled:'true'}])('rejects settings %j', input => expect(settings.safeParse(input).success).toBe(false));
it('caps arrays and accepts interval endpoints', () => {
  expect(snapshot.safeParse({...wire,components:Array(2001).fill(disk)}).success).toBe(false);
  expect(snapshot.safeParse({...wire,tiersRun:[]}).success).toBe(false);
  expect(snapshot.safeParse({...wire,sources:Array(33).fill({source:'smartctl',status:'failed'})}).success).toBe(false);
  for (const [pollIntervalMinutes,diskHealthIntervalMinutes] of [[5,15],[60,1440]]) expect(settings.safeParse({pollIntervalMinutes,diskHealthIntervalMinutes}).success).toBe(true);
});
```
- [ ] **Step 2: Run red.** `cd packages/shared && npx vitest run src/validators/hardwareHealth.test.ts` — missing module failure.
- [ ] **Step 3: Implement and export the schemas.** Semantic state and UTF-8 attribute-size checks remain in ingest so their error path is a stable 422. The installed Zod 4 requires the explicit string-key argument to `z.record`; this preserves index §B’s exact `Record<string, unknown>` wire type (existing example: `packages/shared/src/validators/catalog.ts:129`).
```ts
// packages/shared/src/validators/hardwareHealth.ts
import { z } from 'zod';
import { AGENT_REPORTABLE_COMPONENT_TYPES, HARDWARE_SOURCES, HARDWARE_SOURCE_STATUSES, HARDWARE_TIERS } from '../constants/hardwareHealth';
export const hardwareComponentReportSchema = z.object({
  componentKey:z.string().min(1).max(200), componentType:z.enum(AGENT_REPORTABLE_COMPONENT_TYPES),
  parentKey:z.string().max(200).nullable().optional(), source:z.enum(HARDWARE_SOURCES), name:z.string().min(1).max(200),
  model:z.string().max(200).nullable().optional(), serial:z.string().max(200).nullable().optional(), firmware:z.string().max(100).nullable().optional(),
  sizeBytes:z.number().int().nonnegative().nullable().optional(), state:z.string().min(1).max(40), stateDetail:z.string().max(200).nullable().optional(),
  progressPercent:z.number().int().min(0).max(100).nullable().optional(), temperatureC:z.number().int().min(-50).max(200).nullable().optional(),
  predictiveFailure:z.boolean().default(false), alertExempt:z.boolean().default(false), memberErrors:z.boolean().optional(),
  osHealthStatus:z.enum(['healthy','warning','unhealthy']).nullable().optional(), smartPassed:z.boolean().nullable().optional(), attributes:z.record(z.string(),z.unknown()).default({}),
});
export const hardwareSourceReportSchema = z.object({
  source:z.enum(HARDWARE_SOURCES),status:z.enum(HARDWARE_SOURCE_STATUSES),complete:z.boolean().optional(),
  toolVersion:z.string().max(100).optional(),path:z.string().max(500).optional(),durationMs:z.number().int().nonnegative().optional(),
  error:z.string().max(500).optional(),retryAt:z.string().datetime().optional(),warnings:z.array(z.string().max(500)).max(50).optional(),
}).refine(value => value.status !== 'ok' || value.complete !== undefined,{path:['complete'],message:'complete is required for ok sources'});
export const hardwareHealthSnapshotSchema = z.object({
  snapshotId:z.string().uuid(),sequence:z.number().int().nonnegative(),collectedAt:z.string().datetime(),agentVersion:z.string().max(50),
  pollIntervalMinutes:z.number().int().min(5).max(60),diskHealthIntervalMinutes:z.number().int().min(15).max(1440),
  tiersRun:z.array(z.enum(HARDWARE_TIERS)).min(1),sources:z.array(hardwareSourceReportSchema).max(32),components:z.array(hardwareComponentReportSchema).max(2000),
});
export type HardwareHealthSnapshot = z.infer<typeof hardwareHealthSnapshotSchema>;
export type HardwareComponentReport = z.infer<typeof hardwareComponentReportSchema>;
export type HardwareSourceReport = z.infer<typeof hardwareSourceReportSchema>;
export const hardwareMonitoringInlineSettingsSchema = z.object({
  enabled:z.boolean().default(true),pollIntervalMinutes:z.number().int().min(5).max(60).default(10),diskHealthIntervalMinutes:z.number().int().min(15).max(1440).default(60),
});
export type HardwareMonitoringInlineSettings = z.infer<typeof hardwareMonitoringInlineSettingsSchema>;
export const HARDWARE_MONITORING_DEFAULTS: HardwareMonitoringInlineSettings = {enabled:true,pollIntervalMinutes:10,diskHealthIntervalMinutes:60};
// Append to packages/shared/src/validators/index.ts:
export * from './hardwareHealth';
```
- [ ] **Step 4: Run green.** `cd packages/shared && npx vitest run src/validators/hardwareHealth.test.ts` — all tests pass.
- [ ] **Step 5: Commit.**
```bash
git add packages/shared/src/validators/hardwareHealth.ts packages/shared/src/validators/hardwareHealth.test.ts packages/shared/src/validators/index.ts
git commit -m $'feat(hardware): publish snapshot validation contract\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 3: Create the hardware tables with composite ownership and forced RLS

**Files:** Create `apps/api/src/db/schema/hardwareHealth.ts`, `apps/api/migrations/2026-10-27-100000-hardware-health-tables.sql`, `apps/api/src/services/hardwareHealth/migrations.integration.test.ts`; Modify `apps/api/src/db/schema/index.ts:15`, `apps/api/vitest.config.ts:25`, `apps/api/vitest.integration.config.ts:15`. Read-only references: `db/schema/devices.ts:276,300–340`, `db/schema/agentHealth.ts:31–43`, migration `2026-09-28-100000-agent-health-observations.sql:26–33`.
**Interfaces:** Consumes index §A and existing `devices(id, org_id)`. Produces `deviceHardwareComponents`, `deviceHardwareEvents`, `deviceHardwareHealth` and the four exact enum exports. Decision: bigint columns use Drizzle `mode:'number'` for JSON-safe views, matching numeric wire values; event index names are `device_hardware_events_device_occurred_idx` / `device_hardware_events_occurred_idx`.

- [ ] **Step 1: Write the real-database red test and register its runner.**
```ts
// apps/api/src/services/hardwareHealth/migrations.integration.test.ts
import '../../__tests__/integration/setup';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { devices } from '../../db/schema';
import { pgErrorCode } from '../../utils/pgErrors';
import { createPartner, createOrganization, createSite } from '../../__tests__/integration/db-utils';
import { getTestDb } from '../../__tests__/integration/setup';
import { replayMigration } from '../../__tests__/integration/replayMigration';
const tables = ['device_hardware_components','device_hardware_events','device_hardware_health'] as const;
const system: DbAccessContext = {scope:'system',orgId:null,accessibleOrgIds:null,accessiblePartnerIds:null};
async function fixture() {
  const partner = await createPartner();
  const org = await createOrganization({partnerId:partner!.id});
  const other = await createOrganization({partnerId:partner!.id});
  const site = await createSite({orgId:org!.id});
  const [device] = await getTestDb().insert(devices).values({orgId:org!.id,siteId:site!.id,agentId:randomUUID(),hostname:'hardware-fixture',osType:'linux',osVersion:'1',architecture:'x64'}).returning();
  return {org:org!.id,other:other!.id,partner:partner!.id,device:device!.id};
}
function insert(table: typeof tables[number], deviceId:string, orgId:string) {
  if(table === 'device_hardware_components') return db.execute(sql`INSERT INTO device_hardware_components(device_id,org_id,component_key,component_type,source,name,state,first_seen_at,last_seen_at) VALUES(${deviceId},${orgId},'storcli:c0','controller','storcli','Controller','ok',now(),now())`);
  if(table === 'device_hardware_events') return db.execute(sql`INSERT INTO device_hardware_events(device_id,org_id,component_key,component_type,event_type,occurred_at) VALUES(${deviceId},${orgId},'storcli:c0','controller','first_seen',now())`);
  return db.execute(sql`INSERT INTO device_hardware_health(device_id,org_id) VALUES(${deviceId},${orgId})`);
}
it.each(tables)('%s has forced RLS and an immediate deferrable ownership FK', async table => {
  const rows = await getTestDb().execute(sql`SELECT c.relrowsecurity,c.relforcerowsecurity,f.condeferrable,f.condeferred FROM pg_class c JOIN pg_constraint f ON f.conrelid=c.oid WHERE c.oid=to_regclass(${table}) AND f.conname=${table+'_device_org_fkey'}`);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({relrowsecurity:true,relforcerowsecurity:true,condeferrable:true,condeferred:false});
});
it.each(tables)('%s denies forged ownership and cross-org reads', async table => {
  const f = await fixture();
  const other:DbAccessContext = {scope:'organization',orgId:f.other,accessibleOrgIds:[f.other],accessiblePartnerIds:[],currentPartnerId:f.partner};
  await expect(withDbAccessContext(other,()=>insert(table,f.device,f.org))).rejects.toSatisfy((e:unknown)=>pgErrorCode(e)==='42501');
  await expect(withDbAccessContext(system,()=>insert(table,f.device,f.other))).rejects.toSatisfy((e:unknown)=>pgErrorCode(e)==='23503');
  await withDbAccessContext(system,()=>insert(table,f.device,f.org));
  expect(await withDbAccessContext(other,()=>db.execute(sql`SELECT * FROM ${sql.identifier(table)}`))).toHaveLength(0);
});
it('replays the first migration without deleting observations', async () => {
  const f = await fixture();
  await withDbAccessContext(system,()=>insert('device_hardware_health',f.device,f.org));
  await replayMigration('2026-10-27-100000-hardware-health-tables.sql');
  expect(await getTestDb().execute(sql`SELECT * FROM device_hardware_health WHERE device_id=${f.device}`)).toHaveLength(1);
});
```
In `vitest.config.ts`'s `exclude` and `vitest.integration.config.ts`'s `include`, respectively, insert the same literal:
```ts
'src/services/hardwareHealth/**/*.integration.test.ts',
```
- [ ] **Step 2: Run red with the live stack.**
```bash
pnpm test-stack up
cd apps/api && npx vitest run -c vitest.integration.config.ts src/services/hardwareHealth/migrations.integration.test.ts
```
Expect `expected [] to have a length of 1` and SQLSTATE `42P01`, before creating the migration.
- [ ] **Step 3: Implement the complete Drizzle schema.** SQL owns deferrability because Drizzle's FK builder does not expose it.
```ts
// apps/api/src/db/schema/hardwareHealth.ts
import { sql } from 'drizzle-orm';
import { pgEnum,pgTable,uuid,text,bigint,smallint,integer,boolean,jsonb,timestamp,foreignKey,index,uniqueIndex } from 'drizzle-orm/pg-core';
import { devices } from './devices';
import { organizations } from './orgs';
import type { HardwareSourceReport } from '@breeze/shared';
export const hardwareComponentTypeEnum = pgEnum('hardware_component_type',['controller','virtual_disk','physical_disk','cache_battery','enclosure','bmc','collector']);
export const hardwareSourceEnum = pgEnum('hardware_source',['storcli','perccli','megacli','ssacli','arcconf','omreport','mdadm','zfs','storage_spaces','windows_physical_disk','smartctl','ipmi','racadm','hponcfg','redfish','snmp']);
export const hardwareHealthEnum = pgEnum('hardware_health',['ok','warning','critical','unknown']);
export const hardwareEventTypeEnum = pgEnum('hardware_event_type',['first_seen','health_changed','state_changed','disk_replaced','predictive_failure_set','predictive_failure_cleared','stale','removed']);
export const deviceHardwareComponents = pgTable('device_hardware_components',{
  id:uuid('id').primaryKey().defaultRandom(),deviceId:uuid('device_id').notNull(),orgId:uuid('org_id').notNull().references(()=>organizations.id,{onDelete:'cascade'}),
  componentKey:text('component_key').notNull(),componentType:hardwareComponentTypeEnum('component_type').notNull(),parentKey:text('parent_key'),source:hardwareSourceEnum('source').notNull(),name:text('name').notNull(),
  model:text('model'),serial:text('serial'),firmware:text('firmware'),sizeBytes:bigint('size_bytes',{mode:'number'}),health:hardwareHealthEnum('health').notNull().default('unknown'),state:text('state').notNull(),stateDetail:text('state_detail'),
  progressPercent:smallint('progress_percent'),temperatureC:smallint('temperature_c'),predictiveFailure:boolean('predictive_failure').notNull().default(false),alertExempt:boolean('alert_exempt').notNull().default(false),attributes:jsonb('attributes').$type<Record<string,unknown>>().notNull().default({}),
  unhealthyStreak:integer('unhealthy_streak').notNull().default(0),criticalStreak:integer('critical_streak').notNull().default(0),healthyStreak:integer('healthy_streak').notNull().default(0),belowCriticalStreak:integer('below_critical_streak').notNull().default(0),predictiveStreak:integer('predictive_streak').notNull().default(0),
  stale:boolean('stale').notNull().default(false),staleSince:timestamp('stale_since',{withTimezone:true}),firstSeenAt:timestamp('first_seen_at',{withTimezone:true}).notNull(),lastSeenAt:timestamp('last_seen_at',{withTimezone:true}).notNull(),createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),updatedAt:timestamp('updated_at',{withTimezone:true}).notNull().defaultNow(),
},t=>[
  foreignKey({columns:[t.deviceId,t.orgId],foreignColumns:[devices.id,devices.orgId],name:'device_hardware_components_device_org_fkey'}).onUpdate('cascade').onDelete('cascade'),
  uniqueIndex('device_hardware_components_device_key_uidx').on(t.deviceId,t.componentKey),
  index('device_hardware_components_device_type_idx').on(t.deviceId,t.componentType).where(sql`NOT ${t.stale}`),
  index('device_hardware_components_org_health_idx').on(t.orgId,t.health).where(sql`NOT ${t.stale} AND ${t.health} IN ('warning','critical')`),
  index('device_hardware_components_stale_idx').on(t.staleSince).where(sql`${t.stale}`),
]);
export const deviceHardwareEvents = pgTable('device_hardware_events',{
  id:uuid('id').primaryKey().defaultRandom(),deviceId:uuid('device_id').notNull(),orgId:uuid('org_id').notNull().references(()=>organizations.id,{onDelete:'cascade'}),
  componentKey:text('component_key').notNull(),componentType:hardwareComponentTypeEnum('component_type').notNull(),eventType:hardwareEventTypeEnum('event_type').notNull(),fromHealth:hardwareHealthEnum('from_health'),toHealth:hardwareHealthEnum('to_health'),fromState:text('from_state'),toState:text('to_state'),detail:jsonb('detail').$type<Record<string,unknown>>().notNull().default({}),snapshotId:uuid('snapshot_id'),occurredAt:timestamp('occurred_at',{withTimezone:true}).notNull(),createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),
},t=>[
  foreignKey({columns:[t.deviceId,t.orgId],foreignColumns:[devices.id,devices.orgId],name:'device_hardware_events_device_org_fkey'}).onUpdate('cascade').onDelete('cascade'),
  index('device_hardware_events_device_occurred_idx').on(t.deviceId,t.occurredAt.desc()),index('device_hardware_events_occurred_idx').on(t.occurredAt),
]);
export const deviceHardwareHealth = pgTable('device_hardware_health',{
  deviceId:uuid('device_id').primaryKey(),orgId:uuid('org_id').notNull().references(()=>organizations.id,{onDelete:'cascade'}),health:hardwareHealthEnum('health').notNull().default('unknown'),collectorHealth:hardwareHealthEnum('collector_health').notNull().default('ok'),summary:jsonb('summary').$type<{counts?:Record<string,number>;controllerNames?:string[]}>().notNull().default({}),sources:jsonb('sources').$type<HardwareSourceReport[]>().notNull().default([]),
  lastAgentSequence:bigint('last_agent_sequence',{mode:'number'}).notNull().default(0),lastSnapshotId:uuid('last_snapshot_id'),lastCollectedAt:timestamp('last_collected_at',{withTimezone:true}),lastReceivedAt:timestamp('last_received_at',{withTimezone:true}),lastRaidReceivedAt:timestamp('last_raid_received_at',{withTimezone:true}),lastDiskReceivedAt:timestamp('last_disk_received_at',{withTimezone:true}),pollIntervalMinutes:integer('poll_interval_minutes'),diskHealthIntervalMinutes:integer('disk_health_interval_minutes'),tiersRun:text('tiers_run').array().notNull().default([]),agentVersion:text('agent_version'),createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),updatedAt:timestamp('updated_at',{withTimezone:true}).notNull().defaultNow(),
},t=>[
  foreignKey({columns:[t.deviceId,t.orgId],foreignColumns:[devices.id,devices.orgId],name:'device_hardware_health_device_org_fkey'}).onUpdate('cascade').onDelete('cascade'),
  index('device_hardware_health_org_health_idx').on(t.orgId,t.health),
]);
// Append to apps/api/src/db/schema/index.ts:
export * from './hardwareHealth';
```
- [ ] **Step 4: Create the first migration.**
```sql
-- apps/api/migrations/2026-10-27-100000-hardware-health-tables.sql
DO $$ BEGIN CREATE TYPE hardware_component_type AS ENUM ('controller','virtual_disk','physical_disk','cache_battery','enclosure','bmc','collector'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE hardware_source AS ENUM ('storcli','perccli','megacli','ssacli','arcconf','omreport','mdadm','zfs','storage_spaces','windows_physical_disk','smartctl','ipmi','racadm','hponcfg','redfish','snmp'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE hardware_health AS ENUM ('ok','warning','critical','unknown'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE hardware_event_type AS ENUM ('first_seen','health_changed','state_changed','disk_replaced','predictive_failure_set','predictive_failure_cleared','stale','removed'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE IF NOT EXISTS device_hardware_components (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), device_id uuid NOT NULL, org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 component_key text NOT NULL, component_type hardware_component_type NOT NULL, parent_key text, source hardware_source NOT NULL, name text NOT NULL,
 model text, serial text, firmware text, size_bytes bigint, health hardware_health NOT NULL DEFAULT 'unknown', state text NOT NULL, state_detail text,
 progress_percent smallint, temperature_c smallint, predictive_failure boolean NOT NULL DEFAULT false, alert_exempt boolean NOT NULL DEFAULT false, attributes jsonb NOT NULL DEFAULT '{}',
 unhealthy_streak integer NOT NULL DEFAULT 0, critical_streak integer NOT NULL DEFAULT 0, healthy_streak integer NOT NULL DEFAULT 0, below_critical_streak integer NOT NULL DEFAULT 0, predictive_streak integer NOT NULL DEFAULT 0,
 stale boolean NOT NULL DEFAULT false, stale_since timestamptz, first_seen_at timestamptz NOT NULL, last_seen_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS device_hardware_components_device_key_uidx ON device_hardware_components(device_id,component_key);
CREATE INDEX IF NOT EXISTS device_hardware_components_device_type_idx ON device_hardware_components(device_id,component_type) WHERE NOT stale;
CREATE INDEX IF NOT EXISTS device_hardware_components_org_health_idx ON device_hardware_components(org_id,health) WHERE NOT stale AND health IN ('warning','critical');
CREATE INDEX IF NOT EXISTS device_hardware_components_stale_idx ON device_hardware_components(stale_since) WHERE stale;
CREATE TABLE IF NOT EXISTS device_hardware_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), device_id uuid NOT NULL, org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 component_key text NOT NULL, component_type hardware_component_type NOT NULL, event_type hardware_event_type NOT NULL,
 from_health hardware_health, to_health hardware_health, from_state text, to_state text, detail jsonb NOT NULL DEFAULT '{}', snapshot_id uuid,
 occurred_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS device_hardware_events_device_occurred_idx ON device_hardware_events(device_id,occurred_at DESC);
CREATE INDEX IF NOT EXISTS device_hardware_events_occurred_idx ON device_hardware_events(occurred_at);
CREATE TABLE IF NOT EXISTS device_hardware_health (
 device_id uuid PRIMARY KEY, org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 health hardware_health NOT NULL DEFAULT 'unknown', collector_health hardware_health NOT NULL DEFAULT 'ok', summary jsonb NOT NULL DEFAULT '{}', sources jsonb NOT NULL DEFAULT '[]',
 last_agent_sequence bigint NOT NULL DEFAULT 0, last_snapshot_id uuid, last_collected_at timestamptz, last_received_at timestamptz,
 last_raid_received_at timestamptz, last_disk_received_at timestamptz, poll_interval_minutes integer, disk_health_interval_minutes integer,
 tiers_run text[] NOT NULL DEFAULT '{}', agent_version text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS device_hardware_health_org_health_idx ON device_hardware_health(org_id,health);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['device_hardware_components','device_hardware_events','device_hardware_health'] LOOP
  EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I',t,t||'_device_org_fkey');
  EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY(device_id,org_id) REFERENCES devices(id,org_id) ON UPDATE CASCADE ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE',t,t||'_device_org_fkey');
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('DROP POLICY IF EXISTS breeze_org_isolation_select ON %I',t);
  EXECUTE format('DROP POLICY IF EXISTS breeze_org_isolation_insert ON %I',t);
  EXECUTE format('DROP POLICY IF EXISTS breeze_org_isolation_update ON %I',t);
  EXECUTE format('DROP POLICY IF EXISTS breeze_org_isolation_delete ON %I',t);
  EXECUTE format('CREATE POLICY breeze_org_isolation_select ON %I FOR SELECT USING (public.breeze_has_org_access(org_id))',t);
  EXECUTE format('CREATE POLICY breeze_org_isolation_insert ON %I FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id))',t);
  EXECUTE format('CREATE POLICY breeze_org_isolation_update ON %I FOR UPDATE USING (public.breeze_has_org_access(org_id)) WITH CHECK (public.breeze_has_org_access(org_id))',t);
  EXECUTE format('CREATE POLICY breeze_org_isolation_delete ON %I FOR DELETE USING (public.breeze_has_org_access(org_id))',t);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON %I TO breeze_app',t);
 END LOOP;
END $$;
```
- [ ] **Step 5: Run green.** `cd apps/api && npx vitest run -c vitest.integration.config.ts src/services/hardwareHealth/migrations.integration.test.ts` — catalog, replay, cross-tenant 42501 and composite-owner 23503 tests pass.
- [ ] **Step 6: Commit after checking the migration ceiling.** If upstream passed the reserved slot, coordinate an index filename update before renaming; never silently diverge from the contract.
```bash
ls apps/api/migrations | sort | tail -1
git add apps/api/src/db/schema/hardwareHealth.ts apps/api/src/db/schema/index.ts apps/api/migrations/2026-10-27-100000-hardware-health-tables.sql apps/api/src/services/hardwareHealth/migrations.integration.test.ts apps/api/vitest.config.ts apps/api/vitest.integration.config.ts
git commit -m $'feat(hardware): add tenant-owned health tables\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 4: Add the normalized config table and feature vocabulary

**Files:** Modify `packages/shared/src/constants/configFeatureTypes.ts:8`, `packages/shared/src/validators/index.ts:571`, `apps/api/src/db/schema/configurationPolicies.ts:32–57,338`, `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts:920`; Create `apps/api/migrations/2026-10-27-100100-hardware-monitoring-config-feature.sql`; Test `services/hardwareHealth/migrations.integration.test.ts`.
**Interfaces:** Consumes `configPolicyFeatureLinks.id` and parent ownership. Produces `configPolicyHardwareMonitoringSettings`, appended `'hardware_monitoring'`, inherited `ConfigFeatureType` (already re-exported by `services/configFeatureTypes.ts`, not a new union).

- [ ] **Step 1: Append the settings catalog and range tests.** Add the exact parent allowlist entry before running red.
```ts
// rls-coverage.integration.test.ts, PARENT_FK_JOIN_POLICY_TABLES:
['config_policy_hardware_monitoring_settings', ['configuration_policies']],
// Append to migrations.integration.test.ts:
it('protects normalized settings through the policy chain and bounds both intervals', async () => {
  const rows = await getTestDb().execute(sql`SELECT c.relrowsecurity,c.relforcerowsecurity,pg_get_expr(p.polqual,p.polrelid) AS predicate FROM pg_class c JOIN pg_policy p ON p.polrelid=c.oid WHERE c.oid=to_regclass('config_policy_hardware_monitoring_settings') AND p.polcmd='r'`);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({relrowsecurity:true,relforcerowsecurity:true});
  expect(String(rows[0]!.predicate)).toContain('configuration_policies');
  expect(String(rows[0]!.predicate)).toContain('breeze_has_partner_access');
  const checks = await getTestDb().execute(sql`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid=to_regclass('config_policy_hardware_monitoring_settings') AND contype='c'`);
  expect(checks).toHaveLength(2);
  await replayMigration('2026-10-27-100100-hardware-monitoring-config-feature.sql');
});
```
Append these behavioral tests to the same file before creating the settings migration:
```ts
it('isolates settings writes through the full parent chain and enforces intervals',async()=>{
 const f=await fixture();
 const seedLink=async(orgId:string)=>{
  const [policy]=await getTestDb().execute(sql`INSERT INTO configuration_policies(org_id,name) VALUES(${orgId},'Hardware policy') RETURNING id`);
  const [link]=await getTestDb().execute(sql`INSERT INTO config_policy_feature_links(config_policy_id,feature_type) VALUES(${policy!.id},'hardware_monitoring') RETURNING id`);
  return String(link!.id);
 };
 const ownLink=await seedLink(f.org),foreignLink=await seedLink(f.other);
 const own:DbAccessContext={scope:'organization',orgId:f.org,accessibleOrgIds:[f.org],accessiblePartnerIds:[],currentPartnerId:f.partner};
 const other:DbAccessContext={...own,orgId:f.other,accessibleOrgIds:[f.other]};
 await expect(withDbAccessContext(other,()=>db.execute(sql`INSERT INTO config_policy_hardware_monitoring_settings(feature_link_id) VALUES(${ownLink})`))).rejects.toSatisfy((e:unknown)=>pgErrorCode(e)==='42501');
 await withDbAccessContext(own,()=>db.execute(sql`INSERT INTO config_policy_hardware_monitoring_settings(feature_link_id) VALUES(${ownLink})`));
 expect(await withDbAccessContext(other,()=>db.execute(sql`SELECT * FROM config_policy_hardware_monitoring_settings WHERE feature_link_id=${ownLink}`))).toHaveLength(0);
 expect(await withDbAccessContext(other,()=>db.execute(sql`UPDATE config_policy_hardware_monitoring_settings SET enabled=false WHERE feature_link_id=${ownLink} RETURNING id`))).toHaveLength(0);
 expect(await withDbAccessContext(other,()=>db.execute(sql`DELETE FROM config_policy_hardware_monitoring_settings WHERE feature_link_id=${ownLink} RETURNING id`))).toHaveLength(0);
 await expect(withDbAccessContext(own,()=>db.execute(sql`UPDATE config_policy_hardware_monitoring_settings SET feature_link_id=${foreignLink} WHERE feature_link_id=${ownLink}`))).rejects.toSatisfy((e:unknown)=>pgErrorCode(e)==='42501');
 for(const [raid,disk] of [[4,60],[61,60],[10,14],[10,1441]])await expect(withDbAccessContext(own,()=>db.execute(sql`UPDATE config_policy_hardware_monitoring_settings SET poll_interval_minutes=${raid},disk_health_interval_minutes=${disk} WHERE feature_link_id=${ownLink}`))).rejects.toSatisfy((e:unknown)=>pgErrorCode(e)==='23514');
 for(const [raid,disk] of [[5,15],[60,1440]])await withDbAccessContext(own,()=>db.execute(sql`UPDATE config_policy_hardware_monitoring_settings SET poll_interval_minutes=${raid},disk_health_interval_minutes=${disk} WHERE feature_link_id=${ownLink}`));
});
```
- [ ] **Step 2: Run red.** `cd apps/api && npx vitest run -c vitest.integration.config.ts src/services/hardwareHealth/migrations.integration.test.ts` — expected length 1, received 0. `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage` — new parent table missing.
- [ ] **Step 3: Append the label and define the settings table.** Append `'hardware_monitoring'` after `'monitors'` in all three existing arrays (shared constants, `addFeatureLinkSchema.featureType` enum, Drizzle enum); do not add it to org-only or linked-policy lists. Add `check` to the pg-core import in `configurationPolicies.ts`.
```ts
// Exact array entry in each of those three arrays:
'hardware_monitoring', // Inline RAID and disk-health collection settings.
// configurationPolicies.ts after configPolicyEventLogSettings:
export const configPolicyHardwareMonitoringSettings = pgTable('config_policy_hardware_monitoring_settings',{
 id:uuid('id').primaryKey().defaultRandom(),
 featureLinkId:uuid('feature_link_id').notNull().unique().references(()=>configPolicyFeatureLinks.id,{onDelete:'cascade'}),
 enabled:boolean('enabled').notNull().default(true),pollIntervalMinutes:integer('poll_interval_minutes').notNull().default(10),diskHealthIntervalMinutes:integer('disk_health_interval_minutes').notNull().default(60),
 createdAt:timestamp('created_at').notNull().defaultNow(),updatedAt:timestamp('updated_at').notNull().defaultNow(),
},t=>[
 check('config_policy_hardware_monitoring_poll_interval_chk',sql`${t.pollIntervalMinutes} BETWEEN 5 AND 60`),
 check('config_policy_hardware_monitoring_disk_interval_chk',sql`${t.diskHealthIntervalMinutes} BETWEEN 15 AND 1440`),
]);
```
- [ ] **Step 4: Implement the second migration.** This uses the exact event-log parent-chain predicate at `2026-07-26-a-normalized-policy-tenant-integrity.sql:318–332`; heartbeat resolves it in the existing system block. No inserted row uses the new enum label.
```sql
ALTER TYPE config_feature_type ADD VALUE IF NOT EXISTS 'hardware_monitoring';
CREATE TABLE IF NOT EXISTS config_policy_hardware_monitoring_settings (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), feature_link_id uuid NOT NULL UNIQUE REFERENCES config_policy_feature_links(id) ON DELETE CASCADE,
 enabled boolean NOT NULL DEFAULT true, poll_interval_minutes integer NOT NULL DEFAULT 10, disk_health_interval_minutes integer NOT NULL DEFAULT 60,
 created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now(),
 CONSTRAINT config_policy_hardware_monitoring_poll_interval_chk CHECK(poll_interval_minutes BETWEEN 5 AND 60),
 CONSTRAINT config_policy_hardware_monitoring_disk_interval_chk CHECK(disk_health_interval_minutes BETWEEN 15 AND 1440)
);
ALTER TABLE config_policy_hardware_monitoring_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE config_policy_hardware_monitoring_settings FORCE ROW LEVEL SECURITY;
DO $$ DECLARE t text := 'config_policy_hardware_monitoring_settings'; predicate text; BEGIN
 predicate := format('EXISTS (SELECT 1 FROM configuration_policies policy WHERE policy.id = (SELECT link.config_policy_id FROM config_policy_feature_links link WHERE link.id = %I.feature_link_id) AND (breeze_has_org_access(policy.org_id) OR breeze_has_partner_access(policy.partner_id)))',t);
 EXECUTE format('DROP POLICY IF EXISTS breeze_parent_select ON %I',t);
 EXECUTE format('DROP POLICY IF EXISTS breeze_parent_insert ON %I',t);
 EXECUTE format('DROP POLICY IF EXISTS breeze_parent_update ON %I',t);
 EXECUTE format('DROP POLICY IF EXISTS breeze_parent_delete ON %I',t);
 EXECUTE format('CREATE POLICY breeze_parent_select ON %I FOR SELECT USING (%s)',t,predicate);
 EXECUTE format('CREATE POLICY breeze_parent_insert ON %I FOR INSERT WITH CHECK (%s)',t,predicate);
 EXECUTE format('CREATE POLICY breeze_parent_update ON %I FOR UPDATE USING (%s) WITH CHECK (%s)',t,predicate,predicate);
 EXECUTE format('CREATE POLICY breeze_parent_delete ON %I FOR DELETE USING (%s)',t,predicate);
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON config_policy_hardware_monitoring_settings TO breeze_app;
```
- [ ] **Step 5: Run green and capture expected parity red.** Repeat Step 2, expect passes. Then run these existing complete tests unchanged; expect missing `hardware_monitoring` registration/default failures, pinned for Tasks 6 and 15:
```bash
cd apps/api && npx vitest run src/services/policyBaselineDefaults.test.ts
cd apps/web && npx vitest run src/components/configurationPolicies/featureTabs/featureTypeParity.test.ts src/components/devices/DeviceEffectiveConfigTab.featureParity.test.ts
```
- [ ] **Step 6: Commit.**
```bash
git add packages/shared/src/constants/configFeatureTypes.ts packages/shared/src/validators/index.ts apps/api/src/db/schema/configurationPolicies.ts apps/api/src/__tests__/integration/rls-coverage.integration.test.ts apps/api/src/services/hardwareHealth/migrations.integration.test.ts apps/api/migrations/2026-10-27-100100-hardware-monitoring-config-feature.sql
git commit -m $'feat(hardware): add inherited collection settings schema\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 5: Register deletion, device moves, merging and portable exports

**Files:** Modify `apps/api/src/routes/devices/core.ts:302,535`, `services/tenantCascade.ts:477`, `services/orgMergeRegistry.ts:780`, `services/tenantExportPolicyRegistry.ts:41` (all under `apps/api/src`). Test existing `routes/devices/cascadeDelete.test.ts:140`, `moveOrg.coverage.test.ts:112`, `__tests__/integration/tenantCascade.integration.test.ts:55`, `orgMergeRegistry.integration.test.ts:381`, `tenant-export-policy.integration.test.ts:26`, `tenantExportErasureRoundtrip.integration.test.ts`.
**Interfaces:** Consumes Task 3 tables; produces membership in the five index §A registries. Settings are deleted through their feature-link FK and never enter these lists.

- [ ] **Step 1: Run the existing device-delete test red before adding its entries.** `cd apps/api && npx vitest run src/routes/devices/cascadeDelete.test.ts` — each hardware table reports `in NO set`. The schema addition is the red fixture; do not weaken this existing test or its allowlists.
- [ ] **Step 2: Add device cascade membership, then prove device-move red.** Insert the following complete entries after `'device_hardware'` in `CORE_DEVICE_CASCADE_DELETE_TABLES` only:
```ts
'device_hardware_components',
'device_hardware_events',
'device_hardware_health',
```
Run `cd apps/api && npx vitest run src/routes/devices/moveOrg.coverage.test.ts` — `Missing: device_hardware_components, device_hardware_events, device_hardware_health`. The existing test now discovers these through the newly populated managed set.
- [ ] **Step 3: Register device moves and run both contracts green.** Insert after `'device_hardware'` in `CORE_DEVICE_ORG_DENORMALIZED_TABLES`:
```ts
'device_hardware_components',
'device_hardware_events',
'device_hardware_health',
```
`cd apps/api && npx vitest run src/routes/devices/cascadeDelete.test.ts src/routes/devices/moveOrg.coverage.test.ts` — pass.
- [ ] **Step 4: Prove org-cascade red, then add its exact entries.** `cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/tenantCascade.integration.test.ts` — `New org_id-scoped tables ... missing`. Insert after `'device_hardware'` in `CORE_ORG_CASCADE_DELETE_ORDER`:
```ts
'device_hardware_components',
'device_hardware_events',
'device_hardware_health',
```
Repeat the command — pass, including ordering/FK-direction checks.
- [ ] **Step 5: Run merge/export red after the org-cascade set exists.** These are the actual existing test bodies; run them unchanged, with the modules' existing imports and helpers:
```ts
// orgMergeRegistry.integration.test.ts:381
it('every required table has exactly one policy', () => {
  const missing = [...required].filter(t => !policies.has(t));
  expect(missing).toEqual([]);
});
// tenant-export-policy.integration.test.ts:26
it('classifies every live cascade table column exactly', async () => {
  const tables = getOrgCascadeDeleteOrder();
  const issues = findTenantExportPolicyIssues(tables,await readLiveColumns(),getTenantExportPolicyRegistry());
  expect(issues,`Tenant export classifications must exactly match the migration-current schema:\n`+issues.join('\n')).toEqual([]);
});
```
`cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/orgMergeRegistry.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts` — new table policy/classification failures.
- [ ] **Step 6: Implement merge and every export column classification.** After `device_hardware` in `REPOINT_TABLES`:
```ts
'device_hardware_components',
'device_hardware_events',
'device_hardware_health',
```
Add to `CORE_TENANT_EXPORT_POLICY`:
```ts
'device_hardware_components':tablePolicy('org_id',{
 included:['id','device_id','org_id','component_key','component_type','parent_key','source','name','model','serial','firmware','size_bytes','health','state','state_detail','progress_percent','temperature_c','predictive_failure','alert_exempt','unhealthy_streak','critical_streak','healthy_streak','below_critical_streak','predictive_streak','stale','stale_since','first_seen_at','last_seen_at','created_at','updated_at'],
 reviewedIncluded:[],excludedSensitive:[],excludedOpen:['attributes'],
}),
'device_hardware_events':tablePolicy('org_id',{
 included:['id','device_id','org_id','component_key','component_type','event_type','from_health','to_health','from_state','to_state','snapshot_id','occurred_at','created_at'],
 reviewedIncluded:[],excludedSensitive:[],excludedOpen:['detail'],
}),
'device_hardware_health':tablePolicy('org_id',{
 included:['device_id','org_id','health','collector_health','last_agent_sequence','last_snapshot_id','last_collected_at','last_received_at','last_raid_received_at','last_disk_received_at','poll_interval_minutes','disk_health_interval_minutes','tiers_run','agent_version','created_at','updated_at'],
 reviewedIncluded:[],excludedSensitive:[],excludedOpen:['summary','sources'],
}),
```
- [ ] **Step 7: Run the existing complete lifecycle contracts green.**
```bash
cd apps/api && npx vitest run src/services/orgMerge.test.ts src/routes/devices/cascadeDelete.test.ts src/routes/devices/moveOrg.coverage.test.ts
cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/orgMergeRegistry.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts src/__tests__/integration/orgLifecycleFoundations.integration.test.ts
```
Expected: every suite passes; no exclusion lists grow.
- [ ] **Step 8: Commit.**
```bash
git add apps/api/src/routes/devices/core.ts apps/api/src/services/tenantCascade.ts apps/api/src/services/orgMergeRegistry.ts apps/api/src/services/tenantExportPolicyRegistry.ts
git commit -m $'feat(hardware): register tenant lifecycle contracts\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 6: Round-trip normalized inline settings and default policy behavior

**Files:** Modify `apps/api/src/services/configurationPolicy.ts:152–154,747,875,1167,1215,1281,1422,2782,2973`, `services/policyBaselineDefaults.ts:62,103`, `routes/configurationPolicies/featureLinks.ts:320–345,475–583`, `routes/configurationPolicies/featureLinks.test.ts:119`; Create `services/configurationPolicy.hardwareHealth.test.ts`; Modify `services/hardwareHealth/migrations.integration.test.ts` (settings write isolation).
**Interfaces:** Consumes `hardwareMonitoringInlineSettingsSchema` and settings table. Existing signatures: `validateFeaturePolicyExists(featureType: ConfigFeatureType, featurePolicyId: string | undefined | null, owner: {orgId:string|null;partnerId:string|null}): Promise<{valid:boolean;error?:string}>`; `assembleInlineSettings(featureType, linkId, executor: DbExecutor): Promise<unknown|null>`. Produces normalized settings consumed by Task 7.

- [ ] **Step 1: Write a round-trip test through the public service methods.**
```ts
// apps/api/src/services/configurationPolicy.hardwareHealth.test.ts
import { beforeEach,expect,it,vi } from 'vitest';
const m=vi.hoisted(()=>({rows:[] as unknown[][],inserted:[] as any[],deleted:[] as unknown[]}));
vi.mock('../db',()=>{
 const tx:any={};
 function result(rows:unknown[]){const c:any={then:(yes:any,no:any)=>Promise.resolve(rows).then(yes,no)};for(const key of ['from','where','limit','orderBy','returning','for','innerJoin'])c[key]=()=>c;return c;}
 tx.select=()=>result(m.rows.shift()??[]);tx.transaction=(fn:any)=>fn(tx);
 tx.update=()=>({set:()=>result([{id:'11111111-1111-4111-8111-111111111111'}])});
 tx.delete=(table:unknown)=>({where:()=>{m.deleted.push(table);return result([]);}});
 tx.insert=(table:unknown)=>({values:(value:unknown)=>{m.inserted.push({table,value});return result([]);}});
 return {db:tx,runOutsideDbContext:(fn:any)=>fn(),withSystemDbAccessContext:(fn:any)=>fn(),withDbAccessContext:(_ctx:any,fn:any)=>fn()};
});
import { listFeatureLinks,updateFeatureLink,validateFeaturePolicyExists } from './configurationPolicy';
import { configPolicyHardwareMonitoringSettings } from '../db/schema';
const id='11111111-1111-4111-8111-111111111111';
const link={id,configPolicyId:id,featureType:'hardware_monitoring',featurePolicyId:null,inlineSettings:{enabled:true}};
beforeEach(()=>{m.rows=[];m.inserted=[];m.deleted=[];});
it('assembles normalized values rather than the mirror',async()=>{
 m.rows=[[link],[{enabled:false,pollIntervalMinutes:20,diskHealthIntervalMinutes:120}]];
 expect((await listFeatureLinks(id))[0]!.inlineSettings).toEqual({enabled:false,pollIntervalMinutes:20,diskHealthIntervalMinutes:120});
});
it('replaces settings through the normalized table',async()=>{
 m.rows=[[link]];await updateFeatureLink(id,{inlineSettings:{enabled:false,pollIntervalMinutes:20,diskHealthIntervalMinutes:120}},id);
 expect(m.deleted).toContain(configPolicyHardwareMonitoringSettings);
 expect(m.inserted).toContainEqual({table:configPolicyHardwareMonitoringSettings,value:{featureLinkId:id,enabled:false,pollIntervalMinutes:20,diskHealthIntervalMinutes:120}});
});
it('rejects invalid settings before deletion',async()=>{
 m.rows=[[link]];await expect(updateFeatureLink(id,{inlineSettings:{pollIntervalMinutes:1}},id)).rejects.toThrow();expect(m.deleted).toEqual([]);
});
it.each([{orgId:id,partnerId:null},{orgId:null,partnerId:id}])('is inline-only for %j',async owner=>{
 m.rows=[[{id}]];expect((await validateFeaturePolicyExists('hardware_monitoring',id,owner)).valid).toBe(false);
 expect(await validateFeaturePolicyExists('hardware_monitoring',null,owner)).toEqual({valid:true});
});
```
Append within the existing `featureLinks routes` describe in `routes/configurationPolicies/featureLinks.test.ts:119`, which already supplies `app`, MFA, permissions and these mocks:
```ts
it.each(['POST','PATCH'])('validates hardware bounds on %s before mutation',async method=>{
 getConfigPolicyMock.mockResolvedValue({...STUB_POLICY,featureLinks:[{id:LINK_ID,featureType:'hardware_monitoring'}]});
 validateFeaturePolicyExistsMock.mockResolvedValue({valid:true});
 addFeatureLinkMock.mockResolvedValue({id:LINK_ID,featureType:'hardware_monitoring'});
 updateFeatureLinkMock.mockResolvedValue({id:LINK_ID,featureType:'hardware_monitoring'});
 const res=await app.request(`/${POLICY_ID}/features${method==='PATCH'?'/'+LINK_ID:''}`,{method,headers:{'content-type':'application/json'},body:JSON.stringify({...(method==='POST'?{featureType:'hardware_monitoring'}:{}),inlineSettings:{pollIntervalMinutes:1}})});
 expect(res.status).toBe(400);expect(addFeatureLinkMock).not.toHaveBeenCalled();expect(updateFeatureLinkMock).not.toHaveBeenCalled();
});
```
Run `cd apps/api && npx vitest run src/routes/configurationPolicies/featureLinks.test.ts` before and after Step 3; the new tests first receive 201/200, then 400. Existing route auth, MFA, cross-org and missing-link cases must stay green.
- [ ] **Step 2: Run red.** `cd apps/api && npx vitest run src/services/configurationPolicy.hardwareHealth.test.ts src/services/policyBaselineDefaults.test.ts` — missing normalized insert/assembly and baseline metadata failure.
- [ ] **Step 3: Implement the four switch cases and inline-only guard.** Add imports `hardwareMonitoringInlineSettingsSchema` from `@breeze/shared` and `configPolicyHardwareMonitoringSettings` from `../db/schema`. Insert each complete case alongside `event_log` in the indicated switch:
```ts
// decomposeInlineSettings, tx and s already exist (configurationPolicy.ts:875):
case 'hardware_monitoring': {
 const parsed=hardwareMonitoringInlineSettingsSchema.parse(s);
 await tx.insert(configPolicyHardwareMonitoringSettings).values({featureLinkId:linkId,...parsed});
 break;
}
// assertDecomposableInlineSettings (1167):
case 'hardware_monitoring':
 hardwareMonitoringInlineSettingsSchema.parse(settings);
 break;
// deleteNormalizedRows (1215):
case 'hardware_monitoring':
 await tx.delete(configPolicyHardwareMonitoringSettings).where(eq(configPolicyHardwareMonitoringSettings.featureLinkId,linkId));
 break;
// assembleInlineSettings (1422):
case 'hardware_monitoring': {
 const [row]=await executor.select().from(configPolicyHardwareMonitoringSettings).where(eq(configPolicyHardwareMonitoringSettings.featureLinkId,linkId)).limit(1);
 return row ? {enabled:row.enabled,pollIntervalMinutes:row.pollIntervalMinutes,diskHealthIntervalMinutes:row.diskHealthIntervalMinutes} : null;
}
// Additional OR term in validateFeaturePolicyExists (2975):
featureType === 'hardware_monitoring' ||
```
The API request validator must return its usual 400 rather than letting the service's ZodError become 500. Import the shared schema into `routes/configurationPolicies/featureLinks.ts`; insert before its POST and PATCH service calls:
```ts
// POST, alongside event_log validation:
if(data.featureType==='hardware_monitoring' && data.inlineSettings){
 const parsed=hardwareMonitoringInlineSettingsSchema.safeParse(data.inlineSettings);
 if(!parsed.success)return c.json(zodValidationErrorBody('Invalid hardware monitoring settings',parsed.error),400);
 data.inlineSettings=parsed.data;
}
// PATCH, alongside event_log validation:
if(existingLink.featureType==='hardware_monitoring' && data.inlineSettings){
 const parsed=hardwareMonitoringInlineSettingsSchema.safeParse(data.inlineSettings);
 if(!parsed.success)return c.json(zodValidationErrorBody('Invalid hardware monitoring settings',parsed.error),400);
 data.inlineSettings=parsed.data;
}
```
- [ ] **Step 4: Implement the applied default.** Import `HARDWARE_MONITORING_DEFAULTS` from `@breeze/shared` into `policyBaselineDefaults.ts`. Replace the `NOT_ENFORCED` type and add the branch before its lookup:
```ts
// Existing map body remains intact; replace its type annotation:
Record<Exclude<ConfigFeatureType,'remote_access'|'pam'|'hardware_monitoring'>,{label:string;behavior:string}>
// Inside getPolicyBaselineDefaults().map, before const meta:
if(ft==='hardware_monitoring')return {
 featureType:ft,label:'Hardware Monitoring',applied:true,inlineSettings:{...HARDWARE_MONITORING_DEFAULTS},
 behavior:'Hardware collection is ON by default: RAID every 10 minutes and disk health every 60 minutes.',
};
```
- [ ] **Step 5: Run green.** `cd apps/api && npx vitest run src/services/configurationPolicy.hardwareHealth.test.ts src/services/policyBaselineDefaults.test.ts` — pass. Existing TypeScript alias supplies the widened `ConfigFeatureType`; do not invent another union.
- [ ] **Step 6: Commit.**
```bash
git add apps/api/src/services/configurationPolicy.ts apps/api/src/services/configurationPolicy.hardwareHealth.test.ts apps/api/src/services/policyBaselineDefaults.ts apps/api/src/routes/configurationPolicies/featureLinks.ts apps/api/src/routes/configurationPolicies/featureLinks.test.ts
git commit -m $'feat(hardware): normalize policy collection settings\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 7: Resolve hierarchy settings and deliver them after the heartbeat request context

**Files:** Modify `apps/api/src/routes/agents/helpers.ts:1850–2014`, `heartbeat.ts:2039–2150`, `heartbeat.test.ts:179,3298`; Create `helpers.hardwareHealth.test.ts`.
**Interfaces:** Consumes Task 6 settings; existing `LEVEL_PRIORITY`, `policyOwnershipCondition`, `buildRoleOsFilterConditions`, `matchesRoleOsFilter`. Produces the three exact index §E functions, `resolveDeviceHardwareMonitoringPolicy(deviceId:string):Promise<{enabled:boolean;source:'default'|'policy';policyName?:string}>` for Task 13, and `HARDWARE_MONITORING_CACHE_TTL_SECONDS = 120`; wire key `policyConfigUpdate.hardware_monitoring_settings`.

- [ ] **Step 1: Write hierarchy/cache tests and add heartbeat regression cases.**
```ts
// apps/api/src/routes/agents/helpers.hardwareHealth.test.ts
import { beforeEach,expect,it,vi } from 'vitest';
const m=vi.hoisted(()=>({rows:[] as any[][],get:vi.fn(),set:vi.fn(),execute:vi.fn(),context:undefined as any}));
vi.mock('../../db',()=>{
 const query=()=>{const rows=m.rows.shift()??[];const q:any={then:(a:any,b:any)=>Promise.resolve(rows).then(a,b)};for(const k of ['from','where','limit','innerJoin'])q[k]=()=>q;return q;};
 return {db:{select:query,execute:m.execute},getCurrentDbAccessContext:()=>m.context,runOutsideDbContext:(f:any)=>f(),withSystemDbAccessContext:(f:any)=>f(),withDbAccessContext:(_c:any,f:any)=>f()};
});
vi.mock('../../services/redis',()=>({getRedis:()=>({get:m.get,set:m.set})}));
vi.mock('../../services/eventBus',()=>({publishEvent:vi.fn()}));
vi.mock('../../services/commandQueue',()=>({queueCommandForExecution:vi.fn()}));
vi.mock('../../services/cisHardening',()=>({parseCisCollectorOutput:vi.fn()}));
vi.mock('../../services/sentry',()=>({captureException:vi.fn()}));
vi.mock('../../services/cloudflareMtls',()=>({CloudflareMtlsService:vi.fn()}));
vi.mock('../../services/softwarePolicyService',()=>({recordSoftwarePolicyAudit:vi.fn()}));
vi.mock('../../services/filesystemAnalysis',()=>({getFilesystemScanState:vi.fn(),mergeFilesystemAnalysisPayload:vi.fn(),parseFilesystemAnalysisStdout:vi.fn(),readCheckpointPendingDirectories:vi.fn(),readHotDirectories:vi.fn(),saveFilesystemSnapshot:vi.fn(),upsertFilesystemScanState:vi.fn()}));
vi.mock('../metrics',()=>({recordSoftwareRemediationDecision:vi.fn(),recordSensitiveDataFinding:vi.fn(),recordSensitiveDataRemediationDecision:vi.fn()}));
vi.mock('../../jobs/softwareComplianceWorker',()=>({scheduleSoftwareComplianceCheck:vi.fn()}));
vi.mock('./policyProbeSafety',()=>({isAllowedPolicyConfigProbe:vi.fn(()=>true)}));

import { buildHardwareMonitoringConfigUpdate,resolveDeviceHardwareMonitoringSettings,resolveDeviceHardwareMonitoringPolicy } from './helpers';
const id='11111111-1111-4111-8111-111111111111';
const device={orgId:id,siteId:id,deviceRole:'server',osType:'linux'};
beforeEach(()=>{m.context=undefined;m.execute.mockReset().mockResolvedValue([]);m.rows=[];m.get.mockReset().mockResolvedValue(null);m.set.mockReset().mockResolvedValue('OK');});
it('sends defaults when a link is removed and caches for 120 seconds',async()=>{
 m.rows=[[device],[{partnerId:id}],[],[]];
 expect(await buildHardwareMonitoringConfigUpdate(id)).toEqual({enabled:true,poll_interval_minutes:10,disk_health_interval_minutes:60});
 expect(m.set).toHaveBeenCalledWith(`hwmon:settings:device:${id}`,JSON.stringify({enabled:true,pollIntervalMinutes:10,diskHealthIntervalMinutes:60}),'EX',120);
});
it('device assignment wins over partner and smaller priority wins ties',async()=>{
 const base={roleFilter:null,osFilter:null,enabled:false,pollIntervalMinutes:20,diskHealthIntervalMinutes:120};
 m.rows=[[device],[{partnerId:id}],[],[{...base,level:'partner',assignmentPriority:0},{...base,level:'device',assignmentPriority:5},{...base,level:'device',assignmentPriority:1,enabled:true}]];
 expect((await resolveDeviceHardwareMonitoringSettings(id)).enabled).toBe(true);
});
it.each([{roleFilter:['workstation'],osFilter:null},{roleFilter:null,osFilter:['windows']}])('ignores an ineligible nearest assignment %j',async filters=>{
 const base={enabled:false,pollIntervalMinutes:20,diskHealthIntervalMinutes:120,assignmentPriority:0,policyName:'Fleet Hardware',roleFilter:null,osFilter:null};
 m.rows=[[device],[{partnerId:id}],[],[{...base,level:'device',enabled:true,...filters},{...base,level:'partner'}]];
 expect(await resolveDeviceHardwareMonitoringPolicy(id)).toEqual({enabled:false,source:'policy',policyName:'Fleet Hardware'});
});
it('uses and restores verified partner visibility on the same transaction',async()=>{
 m.context={scope:'organization',orgId:id,accessibleOrgIds:[id],accessiblePartnerIds:[]};
 m.rows=[[device],[{partnerId:id}],[],[]];
 expect(await resolveDeviceHardwareMonitoringPolicy(id)).toEqual({enabled:true,source:'default'});
 expect(m.execute).toHaveBeenCalledTimes(2);
 expect(JSON.stringify(m.execute.mock.calls[0])).toContain(id);
 expect(JSON.stringify(m.execute.mock.calls[1])).not.toContain(id);
});
it('validates cached data and propagates resolver errors instead of resetting config',async()=>{
 m.get.mockResolvedValue(JSON.stringify({enabled:false,pollIntervalMinutes:30,diskHealthIntervalMinutes:180}));
 expect(await buildHardwareMonitoringConfigUpdate(id)).toEqual({enabled:false,poll_interval_minutes:30,disk_health_interval_minutes:180});
 m.get.mockResolvedValue('{');m.rows=[[device],[{partnerId:id}],[],[{level:'device',assignmentPriority:0,roleFilter:null,osFilter:null,pollIntervalMinutes:1}]];
 await expect(buildHardwareMonitoringConfigUpdate(id)).rejects.toThrow();
});
```
Add to the existing `heartbeat.test.ts` helpers mock:
```ts
buildHardwareMonitoringConfigUpdate: vi.fn(),
```
Append these full tests inside its existing heartbeat describe, where `buildApp` and `minimalHeartbeatBody` already exist:
```ts
it('delivers hardware settings from the post-scoped policy block',async()=>{
 const {buildHardwareMonitoringConfigUpdate}=await import('./helpers');
 vi.mocked(buildHardwareMonitoringConfigUpdate).mockResolvedValueOnce({enabled:false,poll_interval_minutes:20,disk_health_interval_minutes:120});
 const res=await buildApp().request('/agents/device-1/heartbeat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(minimalHeartbeatBody)});
 expect(res.status).toBe(200);expect((await res.json()).configUpdate.hardware_monitoring_settings).toEqual({enabled:false,poll_interval_minutes:20,disk_health_interval_minutes:120});
});
it('omits hardware settings when its resolver fails',async()=>{
 const {buildHardwareMonitoringConfigUpdate}=await import('./helpers');
 vi.mocked(buildHardwareMonitoringConfigUpdate).mockRejectedValueOnce(new Error('resolver unavailable'));
 const res=await buildApp().request('/agents/device-1/heartbeat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(minimalHeartbeatBody)});
 expect(res.status).toBe(200);expect((await res.json()).configUpdate??{}).not.toHaveProperty('hardware_monitoring_settings');
});
```
- [ ] **Step 2: Run red.** `cd apps/api && npx vitest run src/routes/agents/helpers.hardwareHealth.test.ts src/routes/agents/heartbeat.test.ts` — resolver export missing / expected hardware block absent.
- [ ] **Step 3: Implement the hierarchy resolver.** Add the imports below to the existing helper import lists; append after `buildEventLogConfigUpdate`. The shared internal resolver also returns provenance for Task 13. Existing `withDevicePartnerPolicyVisibility` (`services/configPolicyOwnership.ts:124–162`) temporarily widens only the partner derived from the visible device’s org, on the same transaction, then restores it. Run this query sequentially with other reads; never fabricate an AuthContext or open a nested system context.
```ts
// Merge into helpers.ts imports (policyOwnershipCondition already imported at line 66):
import { HARDWARE_MONITORING_DEFAULTS,hardwareMonitoringInlineSettingsSchema,type HardwareMonitoringInlineSettings } from '@breeze/shared';
import { configPolicyHardwareMonitoringSettings } from '../../db/schema';
import { withDevicePartnerPolicyVisibility } from '../../services/configPolicyOwnership';
type HardwareMonitoringPolicyView={enabled:boolean;source:'default'|'policy';policyName?:string};
async function resolveHardwareMonitoring(deviceId:string):Promise<{settings:HardwareMonitoringInlineSettings;policy:HardwareMonitoringPolicyView}>{
 const fallback={settings:{...HARDWARE_MONITORING_DEFAULTS},policy:{enabled:HARDWARE_MONITORING_DEFAULTS.enabled,source:'default' as const}};
 const [device]=await db.select({orgId:devices.orgId,siteId:devices.siteId,deviceRole:devices.deviceRole,osType:devices.osType}).from(devices).where(eq(devices.id,deviceId)).limit(1);
 if(!device)return fallback;
 const [org]=await db.select({partnerId:organizations.partnerId}).from(organizations).where(eq(organizations.id,device.orgId)).limit(1);
 const groups=await db.select({groupId:deviceGroupMemberships.groupId}).from(deviceGroupMemberships).where(eq(deviceGroupMemberships.deviceId,deviceId));
 const targets=[and(eq(configPolicyAssignments.level,'device'),eq(configPolicyAssignments.targetId,deviceId)),and(eq(configPolicyAssignments.level,'site'),eq(configPolicyAssignments.targetId,device.siteId)),and(eq(configPolicyAssignments.level,'organization'),eq(configPolicyAssignments.targetId,device.orgId))];
 if(groups.length)targets.push(and(eq(configPolicyAssignments.level,'device_group'),inArray(configPolicyAssignments.targetId,groups.map(r=>r.groupId))));
 if(org?.partnerId)targets.push(and(eq(configPolicyAssignments.level,'partner'),eq(configPolicyAssignments.targetId,org.partnerId)));
 const rows=await withDevicePartnerPolicyVisibility(db,org?.partnerId??null,async executor=>await executor.select({policyName:configurationPolicies.name,level:configPolicyAssignments.level,assignmentPriority:configPolicyAssignments.priority,roleFilter:configPolicyAssignments.roleFilter,osFilter:configPolicyAssignments.osFilter,enabled:configPolicyHardwareMonitoringSettings.enabled,pollIntervalMinutes:configPolicyHardwareMonitoringSettings.pollIntervalMinutes,diskHealthIntervalMinutes:configPolicyHardwareMonitoringSettings.diskHealthIntervalMinutes})
 .from(configPolicyAssignments).innerJoin(configurationPolicies,eq(configPolicyAssignments.configPolicyId,configurationPolicies.id))
 .innerJoin(configPolicyEffectiveFeatureLinks,and(eq(configPolicyEffectiveFeatureLinks.configPolicyId,configurationPolicies.id),eq(configPolicyEffectiveFeatureLinks.featureType,'hardware_monitoring')))
 .innerJoin(configPolicyHardwareMonitoringSettings,eq(configPolicyHardwareMonitoringSettings.featureLinkId,configPolicyEffectiveFeatureLinks.id))
 .where(and(eq(configurationPolicies.status,'active'),policyOwnershipCondition({orgId:device.orgId,partnerId:org?.partnerId??null}),or(...targets),...buildRoleOsFilterConditions({deviceRole:device.deviceRole,osType:device.osType}))));
 const eligible=rows.filter(r=>matchesRoleOsFilter(r,{deviceRole:device.deviceRole,osType:device.osType}));
 eligible.sort((a,b)=>(LEVEL_PRIORITY[b.level]??0)-(LEVEL_PRIORITY[a.level]??0)||a.assignmentPriority-b.assignmentPriority);
 const winner=eligible[0];
 return winner?{settings:hardwareMonitoringInlineSettingsSchema.parse(winner),policy:{enabled:winner.enabled,source:'policy',policyName:winner.policyName}}:fallback;
}
export async function resolveDeviceHardwareMonitoringSettings(deviceId:string):Promise<HardwareMonitoringInlineSettings>{
 return (await resolveHardwareMonitoring(deviceId)).settings;
}
export async function resolveDeviceHardwareMonitoringPolicy(deviceId:string):Promise<HardwareMonitoringPolicyView>{
 return (await resolveHardwareMonitoring(deviceId)).policy;
}
export const HARDWARE_MONITORING_CACHE_TTL_SECONDS=120;
export async function getDeviceHardwareMonitoringSettings(deviceId:string):Promise<HardwareMonitoringInlineSettings>{
 const redis=getRedis(),cacheKey=`hwmon:settings:device:${deviceId}`;
 if(redis)try{const cached=await redis.get(cacheKey);if(cached)return hardwareMonitoringInlineSettingsSchema.parse(JSON.parse(cached));}catch(error){console.warn('[hardware-health] settings cache read failed',error);}
 const settings=await resolveDeviceHardwareMonitoringSettings(deviceId);
 if(redis)try{await redis.set(cacheKey,JSON.stringify(settings),'EX',HARDWARE_MONITORING_CACHE_TTL_SECONDS);}catch(error){console.warn('[hardware-health] settings cache write failed',error);}
 return settings;
}
export async function buildHardwareMonitoringConfigUpdate(deviceId:string):Promise<{enabled:boolean;poll_interval_minutes:number;disk_health_interval_minutes:number}>{
 const s=await getDeviceHardwareMonitoringSettings(deviceId);
 return {enabled:s.enabled,poll_interval_minutes:s.pollIntervalMinutes,disk_health_interval_minutes:s.diskHealthIntervalMinutes};
}
```
- [ ] **Step 4: Wire the existing heartbeat block without opening another DB context.** Import `buildHardwareMonitoringConfigUpdate` from `./helpers`; insert the following exact fragments at the corresponding anchors:
```ts
// PolicyConfigUpdates type, 2040:
hardwareMonitoringSettings: Awaited<ReturnType<typeof buildHardwareMonitoringConfigUpdate>> | null;
// policyConfigs initializer, 2047:
hardwareMonitoringSettings: null,
// Inside the existing withSystemDbAccessContext callback, 2055:
let hardwareMonitoringSettings: Awaited<ReturnType<typeof buildHardwareMonitoringConfigUpdate>> | null = null;
// Immediately after the event-log try/catch, 2070:
try {
 hardwareMonitoringSettings=await buildHardwareMonitoringConfigUpdate(scoped.deviceId);
} catch(err) {
 console.error(`[agents] failed to build hardware monitoring config update for ${agentId}:`,err);
 captureException(err);
}
// Replace callback return at 2120:
return {eventLogSettings,monitoringSettings,pamSettings,patchSourceSettings,warrantySettings,hardwareMonitoringSettings};
// Replace destructure at 2129:
const {eventLogSettings,monitoringSettings,pamSettings,patchSourceSettings,warrantySettings,hardwareMonitoringSettings}=policyConfigs;
// Alongside event_log_settings, 2133:
if(hardwareMonitoringSettings)policyConfigUpdate.hardware_monitoring_settings=hardwareMonitoringSettings;
```
- [ ] **Step 5: Run green.** Repeat Step 2; both settings delivery and omission tests pass. Existing heartbeat context-failure test must remain green; no hardware policy read belongs in `mergedConfigUpdate` around line 1702.
- [ ] **Step 6: Commit.**
```bash
git add apps/api/src/routes/agents/helpers.ts apps/api/src/routes/agents/helpers.hardwareHealth.test.ts apps/api/src/routes/agents/heartbeat.ts apps/api/src/routes/agents/heartbeat.test.ts
git commit -m $'feat(hardware): deliver inherited collection settings\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 8: Define per-component freshness windows

**Files:** Create `apps/api/src/services/hardwareHealth/freshness.ts`, `.test.ts`.
**Interfaces:** Consumes `HardwareSource`, `DISK_TIER_SOURCES`. Produces exact index §D `isComponentFresh(c, health, now): boolean`.

- [ ] **Step 1: Write boundary tests for every source.**
```ts
import { expect,it } from 'vitest';
import { HARDWARE_SOURCES,DISK_TIER_SOURCES } from '@breeze/shared';
import { isComponentFresh } from './freshness';
it.each(HARDWARE_SOURCES)('%s expires strictly after three tier intervals',source=>{
 const disk=(DISK_TIER_SOURCES as readonly string[]).includes(source);
 const lastSeenAt=new Date('2026-09-23T00:00:00Z');
 for(const settings of [{pollIntervalMinutes:null,diskHealthIntervalMinutes:null},{pollIntervalMinutes:5,diskHealthIntervalMinutes:15}]){
  const window=(disk?(settings.diskHealthIntervalMinutes??60):(settings.pollIntervalMinutes??10))*3*60_000;
  expect(isComponentFresh({source,lastSeenAt},settings,new Date(+lastSeenAt+window))).toBe(true);
  expect(isComponentFresh({source,lastSeenAt},settings,new Date(+lastSeenAt+window+1))).toBe(false);
 }
});
```
- [ ] **Step 2: Run red.** `cd apps/api && npx vitest run src/services/hardwareHealth/freshness.test.ts` — missing module.
- [ ] **Step 3: Implement the helper.** Reserved `redfish`/`snmp` sources use the RAID fallback until their follow-on specifies a cadence.
```ts
import { DISK_TIER_SOURCES,type HardwareSource } from '@breeze/shared';
export function isComponentFresh(c:{source:HardwareSource;lastSeenAt:Date},health:{pollIntervalMinutes:number|null;diskHealthIntervalMinutes:number|null},now:Date):boolean{
 const disk=(DISK_TIER_SOURCES as readonly string[]).includes(c.source);
 const interval=disk?(health.diskHealthIntervalMinutes??60):(health.pollIntervalMinutes??10);
 return now.getTime()-c.lastSeenAt.getTime()<=3*interval*60_000;
}
```
- [ ] **Step 4: Run green.** Repeat Step 2 — every source's boundary passes.
- [ ] **Step 5: Commit.**
```bash
git add apps/api/src/services/hardwareHealth/freshness.ts apps/api/src/services/hardwareHealth/freshness.test.ts
git commit -m $'feat(hardware): calculate tier freshness windows\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 9: Derive component transitions and all five streaks

**Files:** Create `apps/api/src/services/hardwareHealth/ingest.ts`, `ingest.test.ts`.
**Interfaces:** Consumes Task 1 derivation and Task 3 inferred rows. Produces local exported test seams `ComponentRow`, `ComponentInput`, `componentChange(previous,report,device,snapshot,receivedAt)`; Task 11 supplies the public ingest function. These are new symbols defined here, not existing repository functions.

- [ ] **Step 1: Write transition tests.**
```ts
// apps/api/src/services/hardwareHealth/ingest.test.ts
import { expect,it,vi } from 'vitest';
vi.mock('../../db',()=>({db:{transaction:vi.fn()}}));
import { hardwareHealthSnapshotSchema,HARDWARE_SOURCE_STATUSES } from '@breeze/shared';
import { componentChange,type ComponentInput } from './ingest';
const device={id:'11111111-1111-4111-8111-111111111111',orgId:'22222222-2222-4222-8222-222222222222'};
const now=new Date('2026-09-23T12:00:00Z');
const snapshot=hardwareHealthSnapshotSchema.parse({snapshotId:'33333333-3333-4333-8333-333333333333',sequence:1,collectedAt:'2020-01-01T00:00:00Z',agentVersion:'1',pollIntervalMinutes:10,diskHealthIntervalMinutes:60,tiersRun:['raid'],sources:[],components:[]});
const disk={componentKey:'storcli:c0:e1:s1',componentType:'physical_disk',source:'storcli',name:'Slot 1',state:'online',serial:'old',predictiveFailure:false,alertExempt:false,attributes:{}} satisfies ComponentInput;
it('first observation initializes streaks and timestamps',()=>{
 const {row,events}=componentChange(undefined,disk,device,snapshot,now);
 expect(row).toMatchObject({health:'ok',healthyStreak:1,belowCriticalStreak:1,criticalStreak:0,unhealthyStreak:0,predictiveStreak:0,lastSeenAt:now,firstSeenAt:now});
 expect(events.map(e=>e.eventType)).toEqual(['first_seen']);expect(events[0]!.occurredAt).toEqual(new Date(snapshot.collectedAt));
});
it('emits independent state, health, serial and predictive transitions once',()=>{
 const old=componentChange(undefined,disk,device,snapshot,now).row;
 const changed=componentChange(old,{...disk,state:'failed',serial:'new',model:'Replacement',predictiveFailure:true},device,snapshot,now);
 expect(changed.events.map(e=>e.eventType)).toEqual(['health_changed','state_changed','disk_replaced','predictive_failure_set']);
 expect(changed.events[2]!.detail).toMatchObject({oldSerial:'old',newSerial:'new',model:'Replacement'});
 expect(changed.row).toMatchObject({unhealthyStreak:1,criticalStreak:1,healthyStreak:0,belowCriticalStreak:0,predictiveStreak:1});
 expect(componentChange(changed.row,{...disk,state:'failed',serial:'new',predictiveFailure:true},device,snapshot,now).events).toEqual([]);
 expect(componentChange(changed.row,disk,device,snapshot,now).events.map(e=>e.eventType)).toContain('predictive_failure_cleared');
});
it('unknown freezes every counter; warning never builds a critical streak',()=>{
 let row=componentChange(undefined,{...disk,state:'degraded',predictiveFailure:true},device,snapshot,now).row;
 row=componentChange(row,{...disk,state:'degraded',predictiveFailure:true},device,snapshot,now).row;
 expect(row).toMatchObject({unhealthyStreak:2,criticalStreak:0,healthyStreak:0,belowCriticalStreak:2,predictiveStreak:2});
 const unknown=componentChange(row,{...disk,state:'unknown'},device,snapshot,now).row;
 for(const k of ['unhealthyStreak','criticalStreak','healthyStreak','belowCriticalStreak','predictiveStreak'] as const)expect(unknown[k]).toBe(row[k]);
 const healthy=componentChange(unknown,disk,device,snapshot,now).row;
 expect(healthy).toMatchObject({unhealthyStreak:0,criticalStreak:0,healthyStreak:1,belowCriticalStreak:3,predictiveStreak:0});
});
it('does not invent replacement from blank serial and clears staleness on observation',()=>{
 const old=componentChange(undefined,{...disk,serial:' '},device,snapshot,now).row;
 expect(componentChange({...old,stale:true,staleSince:now},disk,device,snapshot,now)).toMatchObject({row:{stale:false,staleSince:null},events:[]});
});
```
- [ ] **Step 2: Run red.** `cd apps/api && npx vitest run src/services/hardwareHealth/ingest.test.ts` — missing module.
- [ ] **Step 3: Implement complete component reduction.** Streaks are per reported accepted observation, not per sweep or absent component. Unknown freezes the counters exactly as §7.2 requires; stale reappearance retains first-seen identity.
```ts
// apps/api/src/services/hardwareHealth/ingest.ts
import { randomUUID } from 'node:crypto';
import { deriveHardwareHealth,HARDWARE_STATES,worstHardwareHealth,type HardwareComponentType,type HardwareComponentReport,type HardwareHealthSnapshot,type HardwareHealth } from '@breeze/shared';
import { deviceHardwareComponents,deviceHardwareEvents,deviceHardwareHealth } from '../../db/schema';
export type ComponentRow=typeof deviceHardwareComponents.$inferSelect;
type EventRow=typeof deviceHardwareEvents.$inferInsert;
export type ComponentInput=Omit<HardwareComponentReport,'componentType'> & {componentType:HardwareComponentType};
export function componentChange(previous:ComponentRow|undefined,report:ComponentInput,device:{id:string;orgId:string},snapshot:HardwareHealthSnapshot,receivedAt:Date):{row:ComponentRow;events:EventRow[]}{
 const health=deriveHardwareHealth(report);
 const count=(key:'unhealthyStreak'|'criticalStreak'|'healthyStreak'|'belowCriticalStreak'|'predictiveStreak',matches:boolean)=>health==='unknown'?(previous?.[key]??0):matches?(previous?.[key]??0)+1:0;
 const row:ComponentRow={
  id:previous?.id??randomUUID(),deviceId:device.id,orgId:device.orgId,componentKey:report.componentKey,componentType:report.componentType,parentKey:report.parentKey??null,source:report.source,name:report.name,model:report.model??null,serial:report.serial??null,firmware:report.firmware??null,sizeBytes:report.sizeBytes??null,
  health,state:report.state,stateDetail:report.stateDetail??null,progressPercent:report.progressPercent??null,temperatureC:report.temperatureC??null,predictiveFailure:report.predictiveFailure,alertExempt:report.alertExempt,attributes:report.attributes,
  unhealthyStreak:count('unhealthyStreak',health==='warning'||health==='critical'),criticalStreak:count('criticalStreak',health==='critical'),healthyStreak:count('healthyStreak',health==='ok'),belowCriticalStreak:count('belowCriticalStreak',health==='ok'||health==='warning'),predictiveStreak:count('predictiveStreak',report.predictiveFailure),
  stale:false,staleSince:null,firstSeenAt:previous?.firstSeenAt??receivedAt,lastSeenAt:receivedAt,createdAt:previous?.createdAt??receivedAt,updatedAt:receivedAt,
 };
 const events:EventRow[]=[];
 const emit=(eventType:EventRow['eventType'],detail:Record<string,unknown>={})=>events.push({deviceId:device.id,orgId:device.orgId,componentKey:row.componentKey,componentType:row.componentType,eventType,fromHealth:previous?.health??null,toHealth:row.health,fromState:previous?.state??null,toState:row.state,detail,snapshotId:snapshot.snapshotId,occurredAt:new Date(snapshot.collectedAt),createdAt:receivedAt});
 if(!previous)emit('first_seen');
 else{
  if(previous.health!==health)emit('health_changed');
  if(previous.state!==row.state)emit('state_changed');
  if(row.componentType==='physical_disk'&&previous.serial?.trim()&&row.serial?.trim()&&previous.serial!==row.serial)emit('disk_replaced',{oldSerial:previous.serial,newSerial:row.serial,model:row.model});
  if(previous.predictiveFailure!==row.predictiveFailure)emit(row.predictiveFailure?'predictive_failure_set':'predictive_failure_cleared');
 }
 return {row,events};
}
```
- [ ] **Step 4: Run green.** Repeat Step 2 — transition and streak cases pass.
- [ ] **Step 5: Commit.**
```bash
git add apps/api/src/services/hardwareHealth/ingest.ts apps/api/src/services/hardwareHealth/ingest.test.ts
git commit -m $'feat(hardware): derive component events and streaks\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 10: Apply completeness, collector lifecycle and rollup rules

**Files:** Modify `apps/api/src/services/hardwareHealth/ingest.ts`, `ingest.test.ts` (created in Task 9).
**Interfaces:** Consumes `componentChange`. Produces `reduceSnapshot(previous,device,snapshot,receivedAt)` with `{rows,upserts,deletedKeys,events,health,collectorHealth,summary}` and `InvalidHardwareSnapshotError.path`; Task 11 persists it atomically.

- [ ] **Step 1: Append the exhaustive source matrix and semantic-validation tests.** Add `reduceSnapshot` and `InvalidHardwareSnapshotError` to the existing ingest test import.
```ts
it.each(HARDWARE_SOURCE_STATUSES.flatMap(status=>[undefined,false,true].map(complete=>({status,complete}))))('source matrix $status / $complete',({status,complete})=>{
 const old=componentChange(undefined,disk,device,snapshot,now).row;
 const wire={...snapshot,sources:[{source:'storcli' as const,status,complete}],components:[]};
 const result=reduceSnapshot([old],device,wire,now);
 const row=result.rows.find(r=>r.componentKey===disk.componentKey)!;
 expect(row.stale).toBe(status==='ok'&&complete===true);
 expect(row.lastSeenAt).toEqual(old.lastSeenAt);
 expect(result.events.filter(e=>e.eventType==='stale')).toHaveLength(status==='ok'&&complete===true?1:0);
});
it('upserts partial ok results but leaves unreported rows byte-identical',()=>{
 const old=componentChange(undefined,disk,device,snapshot,now).row;
 const wire={...snapshot,sources:[{source:'storcli' as const,status:'ok' as const,complete:false}],components:[{...disk,componentKey:'storcli:c0:e1:s2',state:'failed'}]};
 const result=reduceSnapshot([old],device,wire,new Date(+now+1));
 expect(result.rows.find(r=>r.componentKey===old.componentKey)).toEqual(old);
 expect(result.rows.find(r=>r.componentKey.endsWith('s2'))!.criticalStreak).toBe(1);
 expect(result.health).toBe('critical');
});
it.each(HARDWARE_SOURCE_STATUSES)('only ok source %s may change reported component state',status=>{
 const old=componentChange(undefined,disk,device,snapshot,now).row;
 const result=reduceSnapshot([old],device,{...snapshot,sources:[{source:'storcli',status,complete:false}],components:[{...disk,state:'failed'}]},new Date(+now+1));
 const row=result.rows.find(r=>r.componentKey===old.componentKey)!;
 expect(row.state).toBe(status==='ok'?'failed':'online');expect(row.lastSeenAt).toEqual(status==='ok'?new Date(+now+1):now);
});
it.each(['unavailable','superseded','disabled'] as const)('%s removes only the collector row',status=>{
 const old=componentChange(undefined,disk,device,snapshot,now).row;
 const collector=componentChange(undefined,{...disk,componentKey:'collector:storcli',componentType:'collector',state:'failed'},device,snapshot,now).row;
 const r=reduceSnapshot([old,collector],device,{...snapshot,sources:[{source:'storcli',status}]},now);
 expect(r.rows).toEqual([old]);expect(r.deletedKeys).toEqual(['collector:storcli']);
});
it('stale event and stale_since happen once and only for the reporting source',()=>{
 const old=componentChange(undefined,disk,device,snapshot,now).row;
 const smart=componentChange(undefined,{...disk,componentKey:'smart:1',source:'smartctl'},device,snapshot,now).row;
 const wire={...snapshot,sources:[{source:'storcli' as const,status:'ok' as const,complete:true}]};
 const first=reduceSnapshot([old,smart],device,wire,now);
 const second=reduceSnapshot(first.rows,device,wire,new Date(+now+1));
 expect(second.events).toEqual([]);expect(second.rows.find(r=>r.componentKey===old.componentKey)!.staleSince).toEqual(now);
 expect(second.rows.find(r=>r.source==='smartctl')!.stale).toBe(false);
});
it('collector failure, recovery and disappearance follow source status',()=>{
 const run=(rows:ReturnType<typeof reduceSnapshot>['rows'],status:'failed'|'backing_off'|'ok'|'disabled')=>reduceSnapshot(rows,device,{...snapshot,sources:[{source:'storcli',status,complete:status==='ok',error:'timeout'}]},now);
 let r=run([],'failed');expect(r.collectorHealth).toBe('warning');expect(r.health).toBe('unknown');
 r=run(r.rows,'backing_off');expect(r.rows[0]).toMatchObject({componentKey:'collector:storcli',unhealthyStreak:2,stateDetail:'timeout'});
 r=run(r.rows,'ok');expect(r.rows[0]).toMatchObject({health:'ok',healthyStreak:1,unhealthyStreak:0,stale:false});
 r=run(r.rows,'disabled');expect(r.rows).toEqual([]);expect(r.deletedKeys).toEqual(['collector:storcli']);expect(r.collectorHealth).toBe('ok');
});
it('rollup excludes stale, collector and bmc, but keeps alert-exempt display rows',()=>{
 const rows=[componentChange(undefined,{...disk,alertExempt:true},device,snapshot,now).row,componentChange(undefined,{...disk,componentKey:'bmc:ipmi',componentType:'bmc',source:'ipmi',state:'unknown'},device,snapshot,now).row];
 const result=reduceSnapshot(rows,device,snapshot,now);expect(result.health).toBe('ok');expect(result.summary.counts['physical_disk:ok']).toBe(1);
});
it('rejects invalid state, oversized UTF-8 attributes and duplicate identities',()=>{
 for(const c of [{...disk,state:'optimal'},{...disk,attributes:{x:'é'.repeat(4096)}}])expect(()=>reduceSnapshot([],device,{...snapshot,components:[c]},now)).toThrow(InvalidHardwareSnapshotError);
 expect(()=>reduceSnapshot([],device,{...snapshot,components:[disk,disk]},now)).toThrow('components.1.componentKey');
 expect(()=>reduceSnapshot([],device,{...snapshot,sources:[{source:'storcli',status:'failed'},{source:'storcli',status:'ok',complete:true}]},now)).toThrow('sources.1.source');
});
```
- [ ] **Step 2: Run red.** `cd apps/api && npx vitest run src/services/hardwareHealth/ingest.test.ts` — `reduceSnapshot is not a function`.
- [ ] **Step 3: Implement semantic validation and reduction.** Decision: duplicate component/source identities return 422; `collector:` is reserved to server synthesis. Missing/non-ok sources cannot update components. Rollup `summary` is `{counts: {'componentType:health': number}, controllerNames: string[]}`; only non-stale rows count, with storage rollup exclusions applied to counts too.
```ts
// Append to ingest.ts:
export class InvalidHardwareSnapshotError extends Error{
 constructor(public readonly path:string){super(`invalid_snapshot: ${path}`);this.name='InvalidHardwareSnapshotError';}
}
export function reduceSnapshot(previous:ComponentRow[],device:{id:string;orgId:string},snapshot:HardwareHealthSnapshot,receivedAt:Date){
 const sourceNames=new Set<string>();
 snapshot.sources.forEach((s,i)=>{if(sourceNames.has(s.source))throw new InvalidHardwareSnapshotError(`sources.${i}.source`);sourceNames.add(s.source);});
 const keys=new Set<string>();
 snapshot.components.forEach((c,i)=>{
  if(keys.has(c.componentKey)||c.componentKey.startsWith('collector:'))throw new InvalidHardwareSnapshotError(`components.${i}.componentKey`);
  keys.add(c.componentKey);
  if(!HARDWARE_STATES[c.componentType].includes(c.state))throw new InvalidHardwareSnapshotError(`components.${i}.state`);
  if(Buffer.byteLength(JSON.stringify(c.attributes),'utf8')>8192)throw new InvalidHardwareSnapshotError(`components.${i}.attributes`);
 });
 const rows=new Map(previous.map(r=>[r.componentKey,r]));
 const upserts=new Map<string,ComponentRow>(),events:EventRow[]=[],deletedKeys:string[]=[];
 const apply=(report:ComponentInput)=>{
  const change=componentChange(rows.get(report.componentKey),report,device,snapshot,receivedAt);
  rows.set(report.componentKey,change.row);upserts.set(report.componentKey,change.row);events.push(...change.events);
 };
 for(const source of snapshot.sources){
  if(source.status==='ok'){
   const reports=snapshot.components.filter(c=>c.source===source.source);
   for(const report of reports)apply(report);
   if(source.complete===true){
    const seen=new Set(reports.map(r=>r.componentKey));
    for(const old of rows.values()){
     if(old.source!==source.source||old.componentType==='collector'||old.stale||seen.has(old.componentKey))continue;
     const row={...old,stale:true,staleSince:receivedAt,updatedAt:receivedAt};
     rows.set(row.componentKey,row);upserts.set(row.componentKey,row);
     events.push({deviceId:device.id,orgId:device.orgId,componentKey:row.componentKey,componentType:row.componentType,eventType:'stale',fromHealth:row.health,toHealth:row.health,fromState:row.state,toState:row.state,detail:{},snapshotId:snapshot.snapshotId,occurredAt:new Date(snapshot.collectedAt),createdAt:receivedAt});
    }
   }
  }
  const collectorKey=`collector:${source.source}`;
  if(source.status==='ok'||source.status==='failed'||source.status==='backing_off'){
   apply({componentKey:collectorKey,componentType:'collector',source:source.source,name:source.source,state:source.status,stateDetail:source.error??null,predictiveFailure:false,alertExempt:false,attributes:{}});
  }else if(rows.delete(collectorKey)){deletedKeys.push(collectorKey);upserts.delete(collectorKey);}
 }
 const live=[...rows.values()].filter(r=>!r.stale);
 const hardware=live.filter(r=>r.componentType!=='collector'&&r.componentType!=='bmc');
 const collectors=live.filter(r=>r.componentType==='collector');
 const counts:Record<string,number>={};for(const c of hardware){const k=`${c.componentType}:${c.health}`;counts[k]=(counts[k]??0)+1;}
 return {rows:[...rows.values()],upserts:[...upserts.values()],deletedKeys,events,
  health:worstHardwareHealth(hardware.map(r=>r.health)),collectorHealth:collectors.length?worstHardwareHealth(collectors.map(r=>r.health)):'ok' as HardwareHealth,
  summary:{counts,controllerNames:hardware.filter(r=>r.componentType==='controller').map(r=>r.name)},
 };
}
```
- [ ] **Step 4: Run green.** Repeat Step 2 — all 18 matrix cases and collector/stale/rollup tests pass. `ok` with absent complete is rejected at the schema boundary; the matrix verifies the reducer remains non-destructive if called with that structural input internally.
- [ ] **Step 5: Commit.**
```bash
git add apps/api/src/services/hardwareHealth/ingest.ts apps/api/src/services/hardwareHealth/ingest.test.ts
git commit -m $'feat(hardware): reduce complete snapshots and collectors\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 11: Persist accepted snapshots under one device-health lock

**Files:** Modify `apps/api/src/services/hardwareHealth/ingest.ts`, `.test.ts`; Create `ingest.integration.test.ts` (runner registration already in Task 3).
**Interfaces:** Produces exact index §D `IngestResult` and `ingestHardwareHealthSnapshot(input): Promise<IngestResult>`. Consumes `reduceSnapshot`; caller supplies authenticated `{id,orgId}` and server `receivedAt`. Decision: a first-ever sequence 0 is accepted when `lastReceivedAt` is null; the reset window is strictly greater than 1 hour. Server writers preserve the agent sequence/receipt/config envelope; the future server poller owns its independent ordering column.

- [ ] **Step 1: Append unit ordering cases and write the real concurrency test.**
```ts
// Add acceptsAgentSequence to the existing ingest.test.ts import and append:
it.each([
 [null,0,0,true],[now,10,11,true],[now,10,10,false],[now,10,0,false],
 [new Date(+now-3_600_000),10,0,false],[new Date(+now-3_600_001),10,0,true],
] as const)('sequence reset boundary %j %s %s', (lastReceivedAt,lastAgentSequence,sequence,accepted)=>{
 expect(acceptsAgentSequence({lastReceivedAt,lastAgentSequence},sequence,now)).toBe(accepted);
});
```
```ts
// apps/api/src/services/hardwareHealth/ingest.integration.test.ts
import '../../__tests__/integration/setup';
import { randomUUID } from 'node:crypto';
import { expect,it } from 'vitest';
import { eq } from 'drizzle-orm';
import { withDbAccessContext } from '../../db';
import { devices,deviceHardwareHealth,deviceHardwareComponents,deviceHardwareEvents } from '../../db/schema';
import { getTestDb } from '../../__tests__/integration/setup';
import { createPartner,createOrganization,createSite } from '../../__tests__/integration/db-utils';
import { hardwareHealthSnapshotSchema } from '@breeze/shared';
import { ingestHardwareHealthSnapshot } from './ingest';
it('serializes two same-sequence restart snapshots and rejects without writes',async()=>{
 const partner=await createPartner(),org=await createOrganization({partnerId:partner!.id}),site=await createSite({orgId:org!.id});
 const [device]=await getTestDb().insert(devices).values({orgId:org!.id,siteId:site!.id,agentId:randomUUID(),hostname:'raid',osType:'linux',osVersion:'1',architecture:'x64'}).returning();
 const ctx={scope:'organization' as const,orgId:org!.id,accessibleOrgIds:[org!.id],currentPartnerId:partner!.id};
 const first=new Date('2026-09-23T12:00:00Z');
 const snapshot=hardwareHealthSnapshotSchema.parse({snapshotId:randomUUID(),sequence:50,collectedAt:'2099-01-01T00:00:00Z',agentVersion:'1',pollIntervalMinutes:10,diskHealthIntervalMinutes:60,tiersRun:['raid'],sources:[{source:'storcli',status:'ok',complete:true}],components:[{componentKey:'storcli:c0',componentType:'controller',source:'storcli',name:'Controller',state:'failed'}]});
 const send=(sequence:number,receivedAt:Date,writer:'agent'|'server'='agent')=>withDbAccessContext(ctx,()=>ingestHardwareHealthSnapshot({device:device!,snapshot:{...snapshot,snapshotId:randomUUID(),sequence},writer,receivedAt}));
 await send(50,first);
 expect(await send(0,new Date(+first+3_600_000))).toEqual({accepted:false,reason:'stale_snapshot'});
 const race=await Promise.all([send(0,new Date(+first+3_600_001)),send(0,new Date(+first+3_600_001))]);
 expect(race.filter(r=>r.accepted)).toHaveLength(1);
 const [health]=await getTestDb().select().from(deviceHardwareHealth).where(eq(deviceHardwareHealth.deviceId,device!.id));
 expect(health).toMatchObject({lastAgentSequence:0,lastReceivedAt:new Date(+first+3_600_001)});
 const rows=await getTestDb().select().from(deviceHardwareComponents).where(eq(deviceHardwareComponents.deviceId,device!.id));
 expect(rows.find(r=>r.componentKey==='storcli:c0')!.criticalStreak).toBe(2);
 expect(await getTestDb().select().from(deviceHardwareEvents).where(eq(deviceHardwareEvents.deviceId,device!.id))).toHaveLength(2);
 await send(999,new Date(+first+7_200_000),'server');
 const [after]=await getTestDb().select().from(deviceHardwareHealth).where(eq(deviceHardwareHealth.deviceId,device!.id));
 expect(after!.lastAgentSequence).toBe(0);expect(after!.lastReceivedAt).toEqual(health!.lastReceivedAt);
 await expect(withDbAccessContext(ctx,()=>ingestHardwareHealthSnapshot({device:device!,snapshot:{...snapshot,sequence:1,components:[{...snapshot.components[0]!,state:'illegal'}]},writer:'agent',receivedAt:new Date(+first+7_200_001)}))).rejects.toThrow('components.0.state');
 const [unchanged]=await getTestDb().select().from(deviceHardwareHealth).where(eq(deviceHardwareHealth.deviceId,device!.id));
 expect(unchanged!.lastAgentSequence).toBe(0);
});
```
- [ ] **Step 2: Run red.**
```bash
cd apps/api && npx vitest run src/services/hardwareHealth/ingest.test.ts
cd apps/api && npx vitest run -c vitest.integration.config.ts src/services/hardwareHealth/ingest.integration.test.ts
```
Expect missing `acceptsAgentSequence` / `ingestHardwareHealthSnapshot` exports.
- [ ] **Step 3: Implement the transaction.** Add these imports and append the functions. Parent key-share follows the existing agent-health ownership pattern and prevents concurrent device move/delete from invalidating the authenticated org between lookup and insert.
```ts
import { and,eq,inArray } from 'drizzle-orm';
import { db } from '../../db';
import { devices } from '../../db/schema';
export type IngestResult={accepted:true;events:number;health:HardwareHealth}|{accepted:false;reason:'stale_snapshot'};
export function acceptsAgentSequence(health:{lastReceivedAt:Date|null;lastAgentSequence:number},sequence:number,receivedAt:Date):boolean{
 return health.lastReceivedAt===null||sequence>health.lastAgentSequence||receivedAt.getTime()-health.lastReceivedAt.getTime()>3_600_000;
}
export async function ingestHardwareHealthSnapshot(input:{device:{id:string;orgId:string};snapshot:HardwareHealthSnapshot;writer:'agent'|'server';receivedAt:Date}):Promise<IngestResult>{
 const {device,snapshot,receivedAt,writer}=input;
 return db.transaction(async tx=>{
  const [owner]=await tx.select({id:devices.id}).from(devices).where(and(eq(devices.id,device.id),eq(devices.orgId,device.orgId))).for('key share');
  if(!owner)throw new Error('Hardware device missing or ownership changed');
  await tx.insert(deviceHardwareHealth).values({deviceId:device.id,orgId:device.orgId}).onConflictDoNothing({target:deviceHardwareHealth.deviceId});
  const [health]=await tx.select().from(deviceHardwareHealth).where(and(eq(deviceHardwareHealth.deviceId,device.id),eq(deviceHardwareHealth.orgId,device.orgId))).for('update');
  if(!health)throw new Error('Hardware health ownership mismatch');
  if(writer==='agent'&&!acceptsAgentSequence(health,snapshot.sequence,receivedAt))return {accepted:false,reason:'stale_snapshot'};
  const previous=await tx.select().from(deviceHardwareComponents).where(eq(deviceHardwareComponents.deviceId,device.id));
  const change=reduceSnapshot(previous,device,snapshot,receivedAt);
  for(const row of change.upserts){
   const {id,createdAt,firstSeenAt,...update}=row;
   await tx.insert(deviceHardwareComponents).values(row).onConflictDoUpdate({target:[deviceHardwareComponents.deviceId,deviceHardwareComponents.componentKey],set:update});
  }
  if(change.deletedKeys.length)await tx.delete(deviceHardwareComponents).where(and(eq(deviceHardwareComponents.deviceId,device.id),inArray(deviceHardwareComponents.componentKey,change.deletedKeys)));
  for(let i=0;i<change.events.length;i+=500)await tx.insert(deviceHardwareEvents).values(change.events.slice(i,i+500));
  await tx.update(deviceHardwareHealth).set({health:change.health,collectorHealth:change.collectorHealth,summary:change.summary,updatedAt:receivedAt,
   ...(writer==='agent'?{sources:snapshot.sources,lastAgentSequence:snapshot.sequence,lastSnapshotId:snapshot.snapshotId,lastCollectedAt:new Date(snapshot.collectedAt),lastReceivedAt:receivedAt,lastRaidReceivedAt:snapshot.tiersRun.includes('raid')?receivedAt:health.lastRaidReceivedAt,lastDiskReceivedAt:snapshot.tiersRun.includes('disk')?receivedAt:health.lastDiskReceivedAt,pollIntervalMinutes:snapshot.pollIntervalMinutes,diskHealthIntervalMinutes:snapshot.diskHealthIntervalMinutes,tiersRun:snapshot.tiersRun,agentVersion:snapshot.agentVersion}:{}),
  }).where(eq(deviceHardwareHealth.deviceId,device.id));
  return {accepted:true,events:change.events.length,health:change.health};
 });
}
```
- [ ] **Step 4: Run green.** Repeat Step 2 — same-sequence race accepts exactly one reset, counters advance twice total, event count does not grow for rejected snapshots, server writer preserves agent metadata.
- [ ] **Step 5: Commit.**
```bash
git add apps/api/src/services/hardwareHealth/ingest.ts apps/api/src/services/hardwareHealth/ingest.test.ts apps/api/src/services/hardwareHealth/ingest.integration.test.ts
git commit -m $'feat(hardware): serialize snapshot ingestion and resets\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 12: Expose bounded, main-agent-only snapshot ingest

**Files:** Create `apps/api/src/routes/agents/hardwareHealth.ts`, `.test.ts`; Modify `routes/agents/index.ts:12,76`, `services/mcpCoverage.ts:70`.
**Interfaces:** Consumes `ingestHardwareHealthSnapshot` and `InvalidHardwareSnapshotError`; produces `hardwareHealthRoutes` and PUT `/api/v1/agents/:agentId/hardware-health`. The internal route parameter is `:id`, because `agentAuthMiddleware` at `middleware/agentAuth.ts:565–566` reads that name; the external URL is identical to index §C.

- [ ] **Step 1: Write transport tests using the real role guard and validator.**
```ts
// apps/api/src/routes/agents/hardwareHealth.test.ts
import { beforeEach,expect,it,vi } from 'vitest';
import { Hono } from 'hono';
const m=vi.hoisted(()=>({ingest:vi.fn(),rows:[] as any[]}));
vi.mock('../../db',()=>({db:{select:()=>({from:()=>({where:()=>({limit:async()=>m.rows})})})}}));
vi.mock('../../services/hardwareHealth/ingest',()=>({ingestHardwareHealthSnapshot:m.ingest,InvalidHardwareSnapshotError:class extends Error{constructor(public path:string){super(path);}}}));
import { hardwareHealthRoutes } from './hardwareHealth';
import { InvalidHardwareSnapshotError } from '../../services/hardwareHealth/ingest';
const wire={snapshotId:'33333333-3333-4333-8333-333333333333',sequence:1,collectedAt:'2026-09-23T00:00:00Z',agentVersion:'1',pollIntervalMinutes:10,diskHealthIntervalMinutes:60,tiersRun:['raid'],sources:[],components:[]};
function request(body:unknown=wire,role='agent'){
 const app=new Hono();app.use('*',async(c,next)=>{if(role==='missing')return c.json({error:'Unauthorized'},401);c.set('agent',{role} as any);await next();});app.route('/',hardwareHealthRoutes);
 return app.request('/agent-1/hardware-health',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
}
beforeEach(()=>{m.rows=[{id:'11111111-1111-4111-8111-111111111111',orgId:'22222222-2222-4222-8222-222222222222'}];m.ingest.mockReset().mockResolvedValue({accepted:true,events:2,health:'critical'});});
it('returns only accepted and events and uses authenticated device ownership',async()=>{
 const res=await request();expect(res.status).toBe(200);expect(await res.json()).toEqual({accepted:true,events:2});expect(m.ingest).toHaveBeenCalledWith(expect.objectContaining({device:m.rows[0],writer:'agent',receivedAt:expect.any(Date)}));
});
it.each([['missing',401],['watchdog',403],['helper',403]] as const)('rejects %s credentials',async(role,status)=>{expect((await request(wire,role)).status).toBe(status);expect(m.ingest).not.toHaveBeenCalled();});
it('returns 404 for absent or RLS-hidden device',async()=>{m.rows=[];expect((await request()).status).toBe(404);expect(m.ingest).not.toHaveBeenCalled();});
it('rejects stale sequence as 409',async()=>{m.ingest.mockResolvedValue({accepted:false,reason:'stale_snapshot'});const res=await request();expect(res.status).toBe(409);expect(await res.json()).toEqual({error:'stale_snapshot'});});
it('caps bytes at 2 MiB before database writes',async()=>{expect((await request({...wire,agentVersion:'x'.repeat(2*1024*1024)})).status).toBe(413);expect(m.ingest).not.toHaveBeenCalled();});
it('returns precise 422 paths for structural and semantic failures',async()=>{
 let res=await request({...wire,sequence:-1});expect(res.status).toBe(422);expect(await res.json()).toEqual({error:'invalid_snapshot',path:'sequence'});
 m.ingest.mockRejectedValue(new InvalidHardwareSnapshotError('components.0.attributes'));res=await request();expect(res.status).toBe(422);expect(await res.json()).toEqual({error:'invalid_snapshot',path:'components.0.attributes'});
});
it('does not disguise database errors as invalid snapshots',async()=>{m.ingest.mockRejectedValue(new Error('DB unavailable'));expect((await request()).status).toBe(500);});
```
- [ ] **Step 2: Run red.** `cd apps/api && npx vitest run src/routes/agents/hardwareHealth.test.ts` — missing route module.
- [ ] **Step 3: Implement the full route, mount and MCP exemption.**
```ts
// apps/api/src/routes/agents/hardwareHealth.ts
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { eq } from 'drizzle-orm';
import { hardwareHealthSnapshotSchema } from '@breeze/shared';
import { db } from '../../db';
import { devices } from '../../db/schema';
import { zValidator } from '../../lib/validation';
import { requireAgentRole } from '../../middleware/requireAgentRole';
import { ingestHardwareHealthSnapshot,InvalidHardwareSnapshotError } from '../../services/hardwareHealth/ingest';
export const hardwareHealthRoutes=new Hono();
hardwareHealthRoutes.use('*',requireAgentRole);
hardwareHealthRoutes.put('/:id/hardware-health',bodyLimit({maxSize:2*1024*1024,onError:c=>c.json({error:'Request body too large'},413)}),zValidator('json',hardwareHealthSnapshotSchema,(result,c)=>{
 if(!result.success){const path=result.error.issues[0]?.path.map(String).join('.')??'';console.warn('[hardware-health] invalid_snapshot',{path});return c.json({error:'invalid_snapshot',path},422);}
}),async c=>{
 const agentId=c.req.param('id');
 const [device]=await db.select().from(devices).where(eq(devices.agentId,agentId)).limit(1);
 if(!device)return c.json({error:'Device not found'},404);
 try{
  const result=await ingestHardwareHealthSnapshot({device,snapshot:c.req.valid('json'),writer:'agent',receivedAt:new Date()});
  return result.accepted?c.json({accepted:true,events:result.events}):c.json({error:result.reason},409);
 }catch(error){
  if(error instanceof InvalidHardwareSnapshotError){console.warn('[hardware-health] invalid_snapshot',{path:error.path});return c.json({error:'invalid_snapshot',path:error.path},422);}
  throw error;
 }
});
// routes/agents/index.ts import and mount:
import { hardwareHealthRoutes } from './hardwareHealth';
agentRoutes.route('/',hardwareHealthRoutes);
// services/mcpCoverage.ts entry:
'agents/hardwareHealth.ts':{exempt:'agent_transport'},
```
- [ ] **Step 4: Run green.** `cd apps/api && npx vitest run src/routes/agents/hardwareHealth.test.ts src/__tests__/mcp-coverage.test.ts` — transport and coverage pass. Parent auth remains ahead of the new mounted route; do not add an auth skip.
- [ ] **Step 5: Commit.**
```bash
git add apps/api/src/routes/agents/hardwareHealth.ts apps/api/src/routes/agents/hardwareHealth.test.ts apps/api/src/routes/agents/index.ts apps/api/src/services/mcpCoverage.ts
git commit -m $'feat(hardware): accept authenticated hardware snapshots\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 13: Share the hardware view between authorized GET and AI reads

**Files:** Create `apps/api/src/services/hardwareHealth/view.ts`, `.test.ts`, `apps/api/src/routes/devices/hardwareHealth.ts`, `.test.ts`, `apps/api/src/services/aiToolsDevice.hardwareHealth.test.ts`; Modify `routes/devices/index.ts:7,146`, `services/aiToolsDevice.ts:196–248`, `services/mcpCoverage.ts:218`.
**Interfaces:** Produces `HardwareComponentView`, `HardwareEventView`, exact index §D `HardwareHealthView` and `getDeviceHardwareHealthView(deviceId:string,opts?:{eventLimit?:number}):Promise<HardwareHealthView|null>`. Consumes `isComponentFresh`; existing authorization signatures are `getDeviceWithOrgAndSiteCheck(c:Context,deviceId:string,auth:Pick<AuthContext,'scope'|'orgId'|'accessibleOrgIds'|'canAccessOrg'>)` and `verifyDeviceAccess(deviceId:string,auth:AuthContext,requireOnline=false)` (`aiTools.ts:166`). All dates in the wire view are ISO strings, nullable dates stay null, and event limit clamps to 0–50.

- [ ] **Step 1: Write view shape/freshness tests.**
```ts
// apps/api/src/services/hardwareHealth/view.test.ts
import { beforeEach,expect,it,vi } from 'vitest';
const m=vi.hoisted(()=>({rows:[] as any[][],policy:vi.fn()}));
vi.mock('../../db',()=>({db:{select:()=>{const rows=m.rows.shift()??[];const q:any={then:(a:any,b:any)=>Promise.resolve(rows).then(a,b)};for(const k of ['from','where','limit','orderBy'])q[k]=()=>q;return q;}}}));
vi.mock('../../routes/agents/helpers',()=>({resolveDeviceHardwareMonitoringPolicy:m.policy}));
import { getDeviceHardwareHealthView } from './view';
beforeEach(()=>{m.rows=[];m.policy.mockReset().mockResolvedValue({enabled:true,source:'default'});});
it('returns null before any snapshot and does not resolve policy',async()=>{m.rows=[[]];expect(await getDeviceHardwareHealthView('device')).toBeNull();expect(m.policy).not.toHaveBeenCalled();});
it('serializes all row dates and marks old disk observations unfresh',async()=>{
 const date=new Date('2000-01-01T00:00:00Z');
 m.rows=[[{health:'ok',collectorHealth:'ok',lastReceivedAt:date,lastCollectedAt:null,pollIntervalMinutes:10,diskHealthIntervalMinutes:60,tiersRun:['disk'],agentVersion:'1',sources:[]}],[{id:'component',source:'smartctl',lastSeenAt:date,firstSeenAt:date,createdAt:date,updatedAt:date,staleSince:null,sizeBytes:100}],[{id:'event',occurredAt:date,createdAt:date}]];
 const view=await getDeviceHardwareHealthView('device');expect(view!.components[0]).toMatchObject({fresh:false,sizeBytes:100,lastSeenAt:date.toISOString(),staleSince:null});expect(view!.events[0]!.occurredAt).toBe(date.toISOString());expect(view!.lastCollectedAt).toBeNull();
});
it('omits events on request and reports unavailable policy as null',async()=>{
 m.rows=[[{health:'unknown',collectorHealth:'ok',lastReceivedAt:null,lastCollectedAt:null,pollIntervalMinutes:null,diskHealthIntervalMinutes:null,tiersRun:[],agentVersion:null,sources:[]}],[]];m.policy.mockRejectedValue(new Error('policy read unavailable'));
 const view=await getDeviceHardwareHealthView('device',{eventLimit:0});expect(view!.events).toEqual([]);expect(view!.policy).toBeNull();
});
```
- [ ] **Step 2: Run red.** `cd apps/api && npx vitest run src/services/hardwareHealth/view.test.ts` — missing module. Task 7 already defines the policy metadata resolver, sharing the settings hierarchy query.
- [ ] **Step 3: Implement the complete read view.**
```ts
// apps/api/src/services/hardwareHealth/view.ts
import { desc,eq } from 'drizzle-orm';
import type { HardwareHealth,HardwareSourceReport } from '@breeze/shared';
import { db } from '../../db';
import { deviceHardwareComponents,deviceHardwareEvents,deviceHardwareHealth } from '../../db/schema';
import { resolveDeviceHardwareMonitoringPolicy } from '../../routes/agents/helpers';
import { isComponentFresh } from './freshness';
type JsonDates<T>={[K in keyof T]:T[K] extends Date?string:T[K] extends Date|null?string|null:T[K]};
export type HardwareComponentView=JsonDates<typeof deviceHardwareComponents.$inferSelect>&{fresh:boolean};
export type HardwareEventView=JsonDates<typeof deviceHardwareEvents.$inferSelect>;
export interface HardwareHealthView{
 health:HardwareHealth;collectorHealth:HardwareHealth;lastReceivedAt:string|null;lastCollectedAt:string|null;
 pollIntervalMinutes:number|null;diskHealthIntervalMinutes:number|null;tiersRun:string[];agentVersion:string|null;
 sources:HardwareSourceReport[];components:HardwareComponentView[];events:HardwareEventView[];
 policy:{enabled:boolean;source:'default'|'policy';policyName?:string}|null;
}
export async function getDeviceHardwareHealthView(deviceId:string,opts?:{eventLimit?:number}):Promise<HardwareHealthView|null>{
 const [health]=await db.select().from(deviceHardwareHealth).where(eq(deviceHardwareHealth.deviceId,deviceId)).limit(1);
 if(!health)return null;
 const rows=await db.select().from(deviceHardwareComponents).where(eq(deviceHardwareComponents.deviceId,deviceId)).orderBy(deviceHardwareComponents.componentKey);
 const limit=Math.max(0,Math.min(50,Math.floor(opts?.eventLimit??50)));
 const events=limit?await db.select().from(deviceHardwareEvents).where(eq(deviceHardwareEvents.deviceId,deviceId)).orderBy(desc(deviceHardwareEvents.occurredAt),desc(deviceHardwareEvents.createdAt),desc(deviceHardwareEvents.id)).limit(limit):[];
 let policy:HardwareHealthView['policy']=null;
 try{policy=await resolveDeviceHardwareMonitoringPolicy(deviceId);}catch(error){console.warn('[hardware-health] policy view unavailable',error);}
 const now=new Date();
 return {health:health.health,collectorHealth:health.collectorHealth,lastReceivedAt:health.lastReceivedAt?.toISOString()??null,lastCollectedAt:health.lastCollectedAt?.toISOString()??null,pollIntervalMinutes:health.pollIntervalMinutes,diskHealthIntervalMinutes:health.diskHealthIntervalMinutes,tiersRun:health.tiersRun,agentVersion:health.agentVersion,sources:health.sources,
  components:rows.map(row=>({...row,firstSeenAt:row.firstSeenAt.toISOString(),lastSeenAt:row.lastSeenAt.toISOString(),createdAt:row.createdAt.toISOString(),updatedAt:row.updatedAt.toISOString(),staleSince:row.staleSince?.toISOString()??null,fresh:isComponentFresh(row,health,now)})),
  events:events.map(row=>({...row,occurredAt:row.occurredAt.toISOString(),createdAt:row.createdAt.toISOString()})),policy,
 };
}
```
- [ ] **Step 4: Write operator route authorization tests.**
```ts
// apps/api/src/routes/devices/hardwareHealth.test.ts
import { beforeEach,expect,it,vi } from 'vitest';
const m=vi.hoisted(()=>({device:vi.fn(),view:vi.fn(),denied:Symbol('denied'),status:0,permissionDenied:false}));
vi.mock('../../middleware/auth',()=>({authMiddleware:async(c:any,next:any)=>{if(m.status===401)return c.json({error:'Unauthorized'},401);c.set('auth',{});return next();},requireScope:()=>async(c:any,next:any)=>m.status===403?c.json({error:'Forbidden'},403):next(),requirePermission:()=>async(c:any,next:any)=>m.permissionDenied?c.json({error:'Forbidden'},403):next()}));
vi.mock('./helpers',()=>({getDeviceWithOrgAndSiteCheck:m.device,SITE_ACCESS_DENIED:m.denied}));
vi.mock('../../services/hardwareHealth/view',()=>({getDeviceHardwareHealthView:m.view}));
import { hardwareHealthRoutes } from './hardwareHealth';
beforeEach(()=>{m.status=0;m.permissionDenied=false;m.device.mockReset().mockResolvedValue({id:'11111111-1111-4111-8111-111111111111'});m.view.mockReset().mockResolvedValue({health:'ok'});});
const request=()=>hardwareHealthRoutes.request('/11111111-1111-4111-8111-111111111111/hardware-health');
it('returns the shared view',async()=>{const res=await request();expect(res.status).toBe(200);expect(await res.json()).toEqual({health:'ok'});});
it.each([401,403])('stops forbidden caller %s before reading',async status=>{m.status=status;expect((await request()).status).toBe(status);expect(m.view).not.toHaveBeenCalled();});
it.each([[null,404],[m.denied,403]])('stops missing/cross-org/site result %s',async(value,status)=>{m.device.mockResolvedValue(value);expect((await request()).status).toBe(status);expect(m.view).not.toHaveBeenCalled();});
it('checks DEVICES_READ before lookup',async()=>{m.permissionDenied=true;expect((await request()).status).toBe(403);expect(m.device).not.toHaveBeenCalled();expect(m.view).not.toHaveBeenCalled();});
it('distinguishes absent hardware data',async()=>{m.view.mockResolvedValue(null);const res=await request();expect(res.status).toBe(404);expect(await res.json()).toEqual({error:'no_hardware_health'});});
it('surfaces backend failure',async()=>{m.view.mockRejectedValue(new Error('database'));expect((await request()).status).toBe(500);});
```
Run `cd apps/api && npx vitest run src/routes/devices/hardwareHealth.test.ts` — missing route module.
- [ ] **Step 5: Implement GET, mount and MCP entry.**
```ts
// apps/api/src/routes/devices/hardwareHealth.ts
import { Hono } from 'hono';
import { authMiddleware,requireScope,requirePermission } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { getDeviceWithOrgAndSiteCheck,SITE_ACCESS_DENIED } from './helpers';
import { getDeviceHardwareHealthView } from '../../services/hardwareHealth/view';
export const hardwareHealthRoutes=new Hono();
hardwareHealthRoutes.use('*',authMiddleware);
hardwareHealthRoutes.get('/:id/hardware-health',requireScope('organization','partner','system'),requirePermission(PERMISSIONS.DEVICES_READ.resource,PERMISSIONS.DEVICES_READ.action),async c=>{
 const deviceId=c.req.param('id');const device=await getDeviceWithOrgAndSiteCheck(c,deviceId,c.get('auth'));
 if(device===SITE_ACCESS_DENIED)return c.json({error:'Access to this site denied'},403);
 if(!device)return c.json({error:'Device not found'},404);
 const view=await getDeviceHardwareHealthView(deviceId);
 return view?c.json(view):c.json({error:'no_hardware_health'},404);
});
// routes/devices/index.ts:
import { hardwareHealthRoutes } from './hardwareHealth';
deviceRoutes.route('/',hardwareHealthRoutes);
// services/mcpCoverage.ts:
'devices/hardwareHealth.ts':{tools:['get_device_hardware_health']},
```
- [ ] **Step 6: Write the AI registration and access-order test.**
```ts
// apps/api/src/services/aiToolsDevice.hardwareHealth.test.ts
import { expect,it,vi } from 'vitest';
const m=vi.hoisted(()=>({access:vi.fn(),view:vi.fn()}));
vi.mock('../db',()=>({db:{select:vi.fn(),insert:vi.fn(),update:vi.fn(),delete:vi.fn(),execute:vi.fn()},runOutsideDbContext:(fn:any)=>fn(),withSystemDbAccessContext:(fn:any)=>fn(),withDbAccessContext:(_ctx:any,fn:any)=>fn()}));
vi.mock('./brainDeviceContext',()=>({getActiveDeviceContext:vi.fn(),getAllDeviceContext:vi.fn(),createDeviceContext:vi.fn(),resolveDeviceContext:vi.fn()}));
vi.mock('./aiTools',()=>({verifyDeviceAccess:m.access}));
vi.mock('./hardwareHealth/view',()=>({getDeviceHardwareHealthView:m.view}));
import { registerDeviceTools } from './aiToolsDevice';
import type { AiTool } from './aiTools';
it('checks access before the shared view and caps optional events',async()=>{
 const tools=new Map<string,AiTool>();registerDeviceTools(tools);const tool=tools.get('get_device_hardware_health');expect(tool).toMatchObject({tier:1,domain:'devices',deviceArgs:['deviceId']});
 m.access.mockResolvedValue({error:'Device not found or access denied'});m.view.mockClear();
 expect(JSON.parse(await tool!.handler({deviceId:'id'},{} as any))).toHaveProperty('error');expect(m.view).not.toHaveBeenCalled();
 m.access.mockResolvedValue({device:{id:'id'}});m.view.mockResolvedValue({health:'ok'});
 await tool!.handler({deviceId:'id',includeEvents:true},{} as any);expect(m.view).toHaveBeenLastCalledWith('id',{eventLimit:50});
 await tool!.handler({deviceId:'id'},{} as any);expect(m.view).toHaveBeenLastCalledWith('id',{eventLimit:0});
});
```
Run `cd apps/api && npx vitest run src/services/aiToolsDevice.hardwareHealth.test.ts` — expected registered tool, received undefined.
- [ ] **Step 7: Add the AI tool registration inside `registerDeviceTools`.** Import `getDeviceHardwareHealthView` from `./hardwareHealth/view` and add this complete registration after `get_device_details`:
```ts
registerTool({tier:1,domain:'devices',deviceArgs:['deviceId'],searchHint:'RAID arrays, physical disks, cache batteries and hardware collector health',
 definition:{name:'get_device_hardware_health',description:'Get current hardware health, components, collectors and optional recent events.',input_schema:{type:'object' as const,properties:{deviceId:{type:'string',description:'The device UUID'},includeEvents:{type:'boolean',default:false}},required:['deviceId']}},
 handler:async(input,auth)=>{
  const deviceId=input.deviceId as string;const access=await verifyDeviceAccess(deviceId,auth);
  if('error' in access)return JSON.stringify({error:access.error});
  const view=await getDeviceHardwareHealthView(deviceId,{eventLimit:input.includeEvents===true?50:0});
  return JSON.stringify(view??{error:'no_hardware_health'});
 },
});
```
- [ ] **Step 8: Run all read-surface checks green.**
```bash
cd apps/api && npx vitest run src/services/hardwareHealth/view.test.ts src/routes/devices/hardwareHealth.test.ts src/services/aiToolsDevice.hardwareHealth.test.ts src/services/aiToolsDevice.siteScope.test.ts src/__tests__/mcp-coverage.test.ts
```
Expected: pass; missing/foreign-org/forbidden-site checks short-circuit reads.
- [ ] **Step 9: Commit.**
```bash
git add apps/api/src/services/hardwareHealth/view.ts apps/api/src/services/hardwareHealth/view.test.ts apps/api/src/routes/devices/hardwareHealth.ts apps/api/src/routes/devices/hardwareHealth.test.ts apps/api/src/routes/devices/index.ts apps/api/src/services/aiToolsDevice.ts apps/api/src/services/aiToolsDevice.hardwareHealth.test.ts apps/api/src/services/mcpCoverage.ts apps/api/src/routes/agents/helpers.ts
git commit -m $'feat(hardware): expose authorized health views and AI tool\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 14: Retire stale components and schedule bounded daily retention

**Files:** Create `apps/api/src/services/hardwareHealth/retire.ts`, `.test.ts`, `apps/api/src/jobs/hardwareHealthRetention.ts`, `.test.ts`; Modify `apps/api/src/services/workerRegistry.ts:390–397`, `apps/api/src/jobs/scheduleRegistry.ts:104`, `apps/api/src/jobs/workerReadinessManifest.ts:82`.
**Interfaces:** Produces exact `resolveAlertsForRemovedComponents(deviceId:string,componentKeys:string[]):Promise<number>` returning 0 in W01; W03 implements alert resolution in the ambient transaction. Consumes `pruneInCtidBatches(options:{table:string;where:SQL;batchSize:number;maxBatches:number;label:string}):Promise<BatchedPruneResult>` (`retentionBatch.ts:149`). New job exports `runHardwareHealthRetention`, `initializeHardwareHealthRetention`, `shutdownHardwareHealthRetention`.

- [ ] **Step 1: Write the no-op seam and worker red tests.**
```ts
// services/hardwareHealth/retire.test.ts
import { expect,it } from 'vitest';
import { resolveAlertsForRemovedComponents } from './retire';
it.each([{keys:[]},{keys:['storcli:c0:e1:s1']}])('W01 retirement is a no-op for $keys',async({keys})=>{
 expect(await resolveAlertsForRemovedComponents('11111111-1111-4111-8111-111111111111',keys)).toBe(0);
});
```
```ts
// jobs/hardwareHealthRetention.test.ts
import { beforeEach,expect,it,vi } from 'vitest';
const m=vi.hoisted(()=>({rows:[] as any[][],order:[] as string[],prune:vi.fn(),retire:vi.fn(),add:vi.fn(),close:vi.fn()}));
vi.mock('../db',()=>{
 const select=()=>{const rows=m.rows.shift()??[];const q:any={then:(a:any,b:any)=>Promise.resolve(rows).then(a,b)};for(const k of ['from','where','orderBy','limit','for'])q[k]=()=>q;return q;};
 return {db:{select,insert:()=>({values:async()=>{m.order.push('events');}}),delete:()=>({where:async()=>{m.order.push('delete');}})},runOutsideDbContext:(fn:any)=>fn(),withSystemDbAccessContext:(fn:any)=>fn()};
});
vi.mock('./retentionBatch',()=>({pruneInCtidBatches:m.prune}));
vi.mock('../services/hardwareHealth/retire',()=>({resolveAlertsForRemovedComponents:m.retire}));
vi.mock('../services/redis',()=>({getBullMQConnection:()=>({})}));
vi.mock('./workerObservability',()=>({attachWorkerObservability:vi.fn()}));
vi.mock('bullmq',()=>({Queue:class{add=m.add;close=m.close;getRepeatableJobs=async()=>[];removeRepeatableByKey=vi.fn();},Worker:class{close=m.close;on=vi.fn();}}));
import { runHardwareHealthRetention,initializeHardwareHealthRetention,shutdownHardwareHealthRetention } from './hardwareHealthRetention';
beforeEach(()=>{m.rows=[];m.order=[];m.prune.mockReset().mockResolvedValue({deleted:3,batches:1});m.retire.mockReset().mockImplementation(async()=>{m.order.push('resolve');return 0;});m.add.mockReset();});
it('prunes events in ctid batches and resolves before removal',async()=>{
 m.rows=[[{deviceId:'device'}],[{id:'device'}],[{deviceId:'device'}],[{id:'row',deviceId:'device',orgId:'org',componentKey:'storcli:c0',componentType:'controller',health:'ok',state:'ok'}],[]];
 const result=await runHardwareHealthRetention(new Date('2026-09-23T00:00:00Z'));
 expect(result.components).toBe(1);expect(m.order).toEqual(['resolve','events','delete']);expect(m.prune).toHaveBeenCalledWith(expect.objectContaining({table:'device_hardware_events',batchSize:10000,maxBatches:100}));
});
it('does not remove rows or emit events if retirement fails',async()=>{
 m.rows=[[{deviceId:'device'}],[{id:'device'}],[{deviceId:'device'}],[{id:'row',componentKey:'slot'}]];m.retire.mockRejectedValue(new Error('alert resolution failed'));
 await expect(runHardwareHealthRetention()).rejects.toThrow('alert resolution failed');expect(m.order).toEqual([]);
});
it('leaves a component revived before the locked recheck untouched',async()=>{
 m.rows=[[{deviceId:'device'}],[{id:'device'}],[{deviceId:'device'}],[],[]];
 expect((await runHardwareHealthRetention()).components).toBe(0);expect(m.retire).not.toHaveBeenCalled();expect(m.order).toEqual([]);
});
it('registers a daily cron and closes resources',async()=>{
 await initializeHardwareHealthRetention();expect(m.add).toHaveBeenCalledWith('cleanup',{},expect.objectContaining({repeat:{pattern:'8 7 * * *'}}));await shutdownHardwareHealthRetention();expect(m.close).toHaveBeenCalledTimes(2);
});
```
- [ ] **Step 2: Run red.** `cd apps/api && npx vitest run src/services/hardwareHealth/retire.test.ts src/jobs/hardwareHealthRetention.test.ts` — missing modules.
- [ ] **Step 3: Implement the W03 seam and retention worker.** Decision: events prune in existing ctid batches; components retire in bounded transactions sharing ingest's device→health→component lock order. Recheck stale eligibility after locking; a concurrent revival cannot be deleted. Never call `pruneInCtidBatches` inside component retirement because that helper escapes the ambient transaction.
```ts
// services/hardwareHealth/retire.ts
export async function resolveAlertsForRemovedComponents(_deviceId:string,_componentKeys:string[]):Promise<number>{return 0;}
```
```ts
// jobs/hardwareHealthRetention.ts
import { Queue,Worker } from 'bullmq';
import { and,eq,inArray,lt,sql } from 'drizzle-orm';
import { db,runOutsideDbContext,withSystemDbAccessContext } from '../db';
import { devices,deviceHardwareComponents,deviceHardwareEvents,deviceHardwareHealth } from '../db/schema';
import { getBullMQConnection } from '../services/redis';
import { resolveAlertsForRemovedComponents } from '../services/hardwareHealth/retire';
import { pruneInCtidBatches } from './retentionBatch';
import { jobSchedule } from './scheduleRegistry';
import { attachWorkerObservability } from './workerObservability';
const QUEUE_NAME='hardware-health-retention';
const scoped=<T>(label:string,fn:()=>Promise<T>)=>runOutsideDbContext(()=>withSystemDbAccessContext(fn,label));
export async function runHardwareHealthRetention(now=new Date()){
 const events=await pruneInCtidBatches({table:'device_hardware_events',where:sql`occurred_at < ${new Date(+now-180*86_400_000).toISOString()}::timestamptz`,batchSize:10000,maxBatches:100,label:'hardwareHealthRetention.events'});
 const cutoff=new Date(+now-7*86_400_000);let components=0;
 for(let batch=0;batch<100;batch++){
  const [candidate]=await scoped('hardwareHealthRetention.candidate',()=>db.select({deviceId:deviceHardwareComponents.deviceId}).from(deviceHardwareComponents).where(and(eq(deviceHardwareComponents.stale,true),lt(deviceHardwareComponents.staleSince,cutoff))).orderBy(deviceHardwareComponents.staleSince).limit(1));
  if(!candidate)break;
  components+=await scoped('hardwareHealthRetention.components',async()=>{
   const [device]=await db.select({id:devices.id}).from(devices).where(eq(devices.id,candidate.deviceId)).for('key share');if(!device)return 0;
   await db.select().from(deviceHardwareHealth).where(eq(deviceHardwareHealth.deviceId,device.id)).for('update');
   const rows=await db.select().from(deviceHardwareComponents).where(and(eq(deviceHardwareComponents.deviceId,device.id),eq(deviceHardwareComponents.stale,true),lt(deviceHardwareComponents.staleSince,cutoff))).orderBy(deviceHardwareComponents.staleSince,deviceHardwareComponents.id).limit(250).for('update');
   if(!rows.length)return 0;
   await resolveAlertsForRemovedComponents(device.id,rows.map(r=>r.componentKey));
   await db.insert(deviceHardwareEvents).values(rows.map(r=>({deviceId:r.deviceId,orgId:r.orgId,componentKey:r.componentKey,componentType:r.componentType,eventType:'removed' as const,fromHealth:r.health,fromState:r.state,toHealth:null,toState:null,detail:{},snapshotId:null,occurredAt:now,createdAt:now})));
   await db.delete(deviceHardwareComponents).where(inArray(deviceHardwareComponents.id,rows.map(r=>r.id)));
   return rows.length;
  });
 }
 return {events,components};
}
let queue:Queue|null=null,worker:Worker|null=null;
export async function initializeHardwareHealthRetention():Promise<void>{
 queue=new Queue(QUEUE_NAME,{connection:getBullMQConnection()});
 worker=new Worker(QUEUE_NAME,()=>runHardwareHealthRetention(),{connection:getBullMQConnection(),concurrency:1});
 attachWorkerObservability(worker,'hardwareHealthRetention');
 worker.on('error',error=>console.error('[hardware-health] retention worker failed',error));
 for(const job of await queue.getRepeatableJobs())await queue.removeRepeatableByKey(job.key);
 await queue.add('cleanup',{}, {repeat:{pattern:jobSchedule('hardware-health-retention')},removeOnComplete:{count:5},removeOnFail:{count:10}});
}
export async function shutdownHardwareHealthRetention():Promise<void>{
 if(worker){await worker.close();worker=null;}if(queue){await queue.close();queue=null;}
}
```
- [ ] **Step 4: Register the schedule, worker and readiness consumer.**
```ts
// jobs/scheduleRegistry.ts JOB_SCHEDULES after event-log-retention:
'hardware-health-retention':'8 7 * * *',
// services/workerRegistry.ts after eventLogRetention entry:
{
 name:'hardwareHealthRetention',placement:'socket-owner',
 load:async()=>{const m=await import('../jobs/hardwareHealthRetention');return {init:m.initializeHardwareHealthRetention,shutdown:m.shutdownHardwareHealthRetention};},
},
// jobs/workerReadinessManifest.ts after consumers('eventLogRetention'):
consumers('hardwareHealthRetention'),
```
- [ ] **Step 5: Run green.**
```bash
cd apps/api && npx vitest run src/services/hardwareHealth/retire.test.ts src/jobs/hardwareHealthRetention.test.ts src/jobs/scheduleRegistry.contract.test.ts src/jobs/workerReadinessManifest.test.ts
```
Expected: seam returns zero, retirement orders resolve→event→delete, schedule has no collision, readiness registry remains exhaustive.
- [ ] **Step 6: Commit.**
```bash
git add apps/api/src/services/hardwareHealth/retire.ts apps/api/src/services/hardwareHealth/retire.test.ts apps/api/src/jobs/hardwareHealthRetention.ts apps/api/src/jobs/hardwareHealthRetention.test.ts apps/api/src/services/workerRegistry.ts apps/api/src/jobs/scheduleRegistry.ts apps/api/src/jobs/workerReadinessManifest.ts
git commit -m $'feat(hardware): retain events and retire stale components\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

### Task 15: Add inherited collection controls and close feature parity

**Files:** Create `apps/web/src/components/configurationPolicies/featureTabs/HardwareMonitoringTab.tsx`, `.test.tsx`; Modify `featureTabs/types.ts:55`, `featureTabs/useFeatureLink.ts:57–79`, `featureTabs/useFeatureLink.test.ts:16`, `ConfigPolicyDetailPage.tsx:56,114,439`, `apps/web/src/components/devices/DeviceEffectiveConfigTab.tsx:116,143,250,292–297`. Test existing `featureTabs/featureTypeParity.test.ts`, `devices/DeviceEffectiveConfigTab.featureParity.test.ts` and `lib/__tests__/no-silent-mutations.test.ts`.
**Interfaces:** Consumes `FeatureTabProps`, `FeatureTabShell`, `useFeatureLink(policyId)` returning `{save,remove,saving,error,clearError}`; `save(existingLinkId:string|null,payload):Promise<FeatureLink|null>`, `remove(linkId:string):Promise<boolean>`. Produces the `hardware_monitoring` tab and Effective Config entry; mutation feedback remains centralized in `runAction`.

- [ ] **Step 1: Write the jsdom interaction tests.**
```tsx
// HardwareMonitoringTab.test.tsx
import { fireEvent,render,screen,waitFor } from '@testing-library/react';
import { beforeEach,expect,it,vi } from 'vitest';
const m=vi.hoisted(()=>({save:vi.fn(),remove:vi.fn(),changed:vi.fn()}));
vi.mock('./useFeatureLink',()=>({useFeatureLink:()=>({save:m.save,remove:m.remove,saving:false,error:undefined,clearError:vi.fn()})}));
import HardwareMonitoringTab from './HardwareMonitoringTab';
beforeEach(()=>{vi.clearAllMocks();m.save.mockResolvedValue({id:'link',featureType:'hardware_monitoring',featurePolicyId:null,inlineSettings:{}});});
it('renders defaults and saves disabled collection with custom intervals',async()=>{
 render(<HardwareMonitoringTab policyId="policy" existingLink={undefined} linkedPolicyId={null} onLinkChanged={m.changed}/>);
 expect((screen.getByTestId('hardware-monitoring-enabled') as HTMLInputElement).checked).toBe(true);
 fireEvent.click(screen.getByTestId('hardware-monitoring-enabled'));
 fireEvent.change(screen.getByTestId('hardware-monitoring-raid-interval'),{target:{value:'20'}});
 fireEvent.change(screen.getByTestId('hardware-monitoring-disk-interval'),{target:{value:'120'}});
 fireEvent.click(screen.getByRole('button',{name:/^save$/i}));
 await waitFor(()=>expect(m.save).toHaveBeenCalledWith(null,{featureType:'hardware_monitoring',featurePolicyId:null,inlineSettings:{enabled:false,pollIntervalMinutes:20,diskHealthIntervalMinutes:120}}));
 expect(m.changed).toHaveBeenCalled();
});
it('disables invalid settings and does not clamp partially typed values',()=>{
 render(<HardwareMonitoringTab policyId="policy" existingLink={undefined} linkedPolicyId={null} onLinkChanged={m.changed}/>);
 fireEvent.change(screen.getByTestId('hardware-monitoring-raid-interval'),{target:{value:'1'}});
 expect((screen.getByRole('button',{name:/^save$/i}) as HTMLButtonElement).disabled).toBe(true);
 expect((screen.getByTestId('hardware-monitoring-raid-interval') as HTMLInputElement).value).toBe('1');
});
it('shows inherited values and creates an override without editing the parent',async()=>{
 const parent={id:'parent-link',featureType:'hardware_monitoring' as const,featurePolicyId:null,inlineSettings:{enabled:false,pollIntervalMinutes:30,diskHealthIntervalMinutes:180}};
 render(<HardwareMonitoringTab policyId="policy" existingLink={undefined} parentLink={parent} linkedPolicyId="parent" onLinkChanged={m.changed}/>);
 expect(screen.getByTestId('hardware-monitoring-enabled').closest('fieldset')!.disabled).toBe(true);
 fireEvent.click(screen.getByRole('button',{name:/override/i}));
 await waitFor(()=>expect(m.save).toHaveBeenCalledWith(null,expect.objectContaining({inlineSettings:parent.inlineSettings})));
});
it('does not notify the parent when save fails',async()=>{
 m.save.mockResolvedValue(null);render(<HardwareMonitoringTab policyId="policy" existingLink={undefined} linkedPolicyId={null} onLinkChanged={m.changed}/>);
 fireEvent.click(screen.getByRole('button',{name:/^save$/i}));await waitFor(()=>expect(m.save).toHaveBeenCalled());expect(m.changed).not.toHaveBeenCalled();
});
```
- [ ] **Step 2: Run red and recheck the existing parity failures.**
```bash
cd apps/web && npx vitest run src/components/configurationPolicies/featureTabs/HardwareMonitoringTab.test.tsx src/components/configurationPolicies/featureTabs/useFeatureLink.test.ts src/components/configurationPolicies/featureTabs/featureTypeParity.test.ts src/components/devices/DeviceEffectiveConfigTab.featureParity.test.ts
```
Expected: missing component and hardware metadata parity failures.
- [ ] **Step 3: Implement the complete tab.** Decision: retain typed numeric text while editing and disable Save on invalid bounds, rather than forcing an intermediate `1` to become `5` while typing `10`.
```tsx
import { useEffect,useState } from 'react';
import { HardDrive } from 'lucide-react';
import { HARDWARE_MONITORING_DEFAULTS,hardwareMonitoringInlineSettingsSchema } from '@breeze/shared';
import { FEATURE_META,type FeatureTabProps } from './types';
import { useFeatureLink } from './useFeatureLink';
import FeatureTabShell from './FeatureTabShell';
export default function HardwareMonitoringTab({policyId,existingLink,parentLink,linkedPolicyId,onLinkChanged}:FeatureTabProps){
 const {save,remove,saving,error,clearError}=useFeatureLink(policyId);
 const read=()=>hardwareMonitoringInlineSettingsSchema.parse((existingLink??parentLink)?.inlineSettings??HARDWARE_MONITORING_DEFAULTS);
 const initial=read();const [enabled,setEnabled]=useState(initial.enabled),[raid,setRaid]=useState(String(initial.pollIntervalMinutes)),[disk,setDisk]=useState(String(initial.diskHealthIntervalMinutes));
 useEffect(()=>{const next=hardwareMonitoringInlineSettingsSchema.parse((existingLink??parentLink)?.inlineSettings??HARDWARE_MONITORING_DEFAULTS);setEnabled(next.enabled);setRaid(String(next.pollIntervalMinutes));setDisk(String(next.diskHealthIntervalMinutes));},[existingLink,parentLink]);
 const parsed=hardwareMonitoringInlineSettingsSchema.safeParse({enabled,pollIntervalMinutes:raid===''?NaN:Number(raid),diskHealthIntervalMinutes:disk===''?NaN:Number(disk)});
 const inherited=!!parentLink&&!existingLink;
 const persist=async(id:string|null)=>{if(!parsed.success)return;clearError();const result=await save(id,{featureType:'hardware_monitoring',featurePolicyId:null,inlineSettings:{...parsed.data}});if(result)onLinkChanged(result,'hardware_monitoring');};
 const discard=async()=>{if(existingLink&&await remove(existingLink.id))onLinkChanged(null,'hardware_monitoring');};
 const meta=FEATURE_META.hardware_monitoring;
 return <FeatureTabShell title={meta.label} description={meta.description} icon={<HardDrive className="h-5 w-5"/>} isConfigured={!!existingLink||inherited} saving={saving} saveDisabled={!parsed.success} error={error} onSave={()=>void persist(existingLink?.id??null)} onRemove={existingLink&&!linkedPolicyId?discard:undefined} isInherited={inherited} onOverride={inherited?()=>void persist(null):undefined} onRevert={!inherited&&!!linkedPolicyId&&!!existingLink?discard:undefined}>
  <p className="mb-4 text-sm text-muted-foreground">Probes installed RAID tools and disk health sources. Collection is enabled by default. Attach hardware monitors separately to receive alerts.</p>
  <fieldset disabled={inherited||saving} className="space-y-4">
   <label htmlFor="hardware-enabled" className="flex items-center gap-2"><input id="hardware-enabled" data-testid="hardware-monitoring-enabled" role="switch" type="checkbox" checked={enabled} onChange={e=>setEnabled(e.target.checked)}/>Enable hardware collection</label>
   <label htmlFor="hardware-raid-interval" className="block text-sm">RAID interval (minutes, 5–60)<input id="hardware-raid-interval" data-testid="hardware-monitoring-raid-interval" type="number" min={5} max={60} step={1} value={raid} onChange={e=>setRaid(e.target.value)} className="mt-2 block h-10 w-full rounded-md border bg-background px-3"/></label>
   <label htmlFor="hardware-disk-interval" className="block text-sm">Disk health interval (minutes, 15–1440)<input id="hardware-disk-interval" data-testid="hardware-monitoring-disk-interval" type="number" min={15} max={1440} step={1} value={disk} onChange={e=>setDisk(e.target.value)} className="mt-2 block h-10 w-full rounded-md border bg-background px-3"/></label>
  </fieldset>
 </FeatureTabShell>;
}
```
- [ ] **Step 4: Wire all three UI registries and show applied defaults truthfully.**
```tsx
// featureTabs/types.ts FEATURE_META:
hardware_monitoring:{label:'Hardware Monitoring',fetchUrl:null,description:'RAID and disk health collection intervals'},
// ConfigPolicyDetailPage.tsx, import + featureTabIcons + renderFeatureTab case:
import HardwareMonitoringTab from './featureTabs/HardwareMonitoringTab';
hardware_monitoring:<HardDrive className="h-4 w-4"/>,
case 'hardware_monitoring': return <HardwareMonitoringTab {...props}/>;
// DeviceEffectiveConfigTab.tsx FEATURE_META (HardDrive already imported):
hardware_monitoring:{label:'Hardware Monitoring',Icon:HardDrive},
// Replace hasRealFeatures expression at 250:
const hasRealFeatures=data?Object.values(data.features).some(f=>f.sourceLevel!=='default'||f.featureType==='hardware_monitoring'):false;
// Replace enforcedTypes and baselineTypes at 292–297:
const enforcedTypes=configuredTypes.filter(ft=>features[ft]!.sourceLevel!=='default'||ft==='hardware_monitoring');
const baselineTypes=configuredTypes.filter(ft=>features[ft]!.sourceLevel==='default'&&ft!=='hardware_monitoring');
```
`ALL_FEATURE_TYPES` at line 143 already derives from the metadata keys; the new metadata entry updates it. Replace the adjacent inaccurate comments with: `// Hardware collection is applied even when its source is Breeze Defaults.`
Before changing the hook, append these complete red tests to existing `featureTabs/useFeatureLink.test.ts:16` (its imports and `POLICY`/`LINK` fixtures already exist):
```ts
it.each([200,403])('remove surfaces failed body at HTTP %s',async status=>{
 vi.clearAllMocks();vi.mocked(fetchWithAuth).mockResolvedValue(new Response(JSON.stringify({success:false,error:'Denied'}),{status}));
 const {result}=renderHook(()=>useFeatureLink(POLICY));await act(async()=>{expect(await result.current.remove(LINK)).toBe(false);});
 expect(showToast).toHaveBeenCalledWith(expect.objectContaining({type:'error'}));expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({type:'success'}));
});
it('remove confirms success and redirects on unauthorized',async()=>{
 vi.clearAllMocks();vi.mocked(fetchWithAuth).mockResolvedValue(new Response('{}',{status:200}));
 const {result}=renderHook(()=>useFeatureLink(POLICY));await act(async()=>{expect(await result.current.remove(LINK)).toBe(true);});
 expect(showToast).toHaveBeenCalledWith(expect.objectContaining({type:'success'}));
 vi.clearAllMocks();vi.mocked(fetchWithAuth).mockResolvedValue(new Response('{}',{status:401}));
 await act(async()=>{expect(await result.current.remove(LINK)).toBe(false);});expect(navigateTo).toHaveBeenCalledWith('/login',{replace:true});expect(showToast).not.toHaveBeenCalled();
});
```
Run `cd apps/web && npx vitest run src/components/configurationPolicies/featureTabs/useFeatureLink.test.ts` — expect HTTP-200 failure body to incorrectly return true and missing toast assertions before the replacement below.
- [ ] **Step 5: Route feature removal through the existing mutation feedback helper.** Replace the entire `remove` callback in `useFeatureLink.ts:57–79`; remove the unused `extractApiError` import. Save already uses `runAction` at lines 39–44.
```ts
const remove=useCallback(async(linkId:string):Promise<boolean>=>{
 setSaving(true);setError(undefined);
 try{
  await runAction<void>({request:()=>fetchWithAuth(`/configuration-policies/${policyId}/features/${linkId}`,{method:'DELETE'}),errorFallback:'Failed to remove feature link',successMessage:'Feature removed',onUnauthorized:()=>void navigateTo('/login',{replace:true})});
  return true;
 }catch(err){
  if(err instanceof ActionError&&err.status===401)return false;
  setError(err instanceof Error?err.message:'An error occurred');return false;
 }finally{setSaving(false);}
},[policyId]);
```
- [ ] **Step 6: Run green.**
```bash
cd apps/web && npx vitest run src/components/configurationPolicies/featureTabs/HardwareMonitoringTab.test.tsx src/components/configurationPolicies/featureTabs/useFeatureLink.test.ts src/components/configurationPolicies/featureTabs/featureTypeParity.test.ts src/components/devices/DeviceEffectiveConfigTab.featureParity.test.ts src/lib/__tests__/no-silent-mutations.test.ts
cd apps/api && npx vitest run src/services/policyBaselineDefaults.test.ts
```
Expected: all three parity suites now pass; controls save the exact schema fields.
- [ ] **Step 7: Run the final contract gate and inspect exit codes.**
```bash
cd apps/api && npx vitest run src/services/hardwareHealth/ingest.test.ts src/services/hardwareHealth/freshness.test.ts src/services/hardwareHealth/view.test.ts src/services/hardwareHealth/retire.test.ts src/services/configurationPolicy.hardwareHealth.test.ts src/routes/agents/helpers.hardwareHealth.test.ts src/routes/agents/heartbeat.test.ts src/routes/agents/hardwareHealth.test.ts src/routes/devices/hardwareHealth.test.ts src/jobs/hardwareHealthRetention.test.ts src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts src/__tests__/mcp-coverage.test.ts
cd apps/api && npx vitest run -c vitest.integration.config.ts src/services/hardwareHealth/migrations.integration.test.ts src/services/hardwareHealth/ingest.integration.test.ts src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/orgMergeRegistry.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts src/__tests__/integration/orgLifecycleFoundations.integration.test.ts
DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage
NODE_OPTIONS=--max-old-space-size=12288 pnpm --filter @breeze/api exec tsc --noEmit
pnpm db:check-drift
pnpm test-stack down
```
Expected: all checks exit 0. No agent files change in W01, so Go race/vet checks belong to W02a. Preserve failure logs and fix within this wave; never pipe typecheck to `tail`.
- [ ] **Step 8: Commit.**
```bash
git add apps/web/src/components/configurationPolicies/featureTabs/HardwareMonitoringTab.tsx apps/web/src/components/configurationPolicies/featureTabs/HardwareMonitoringTab.test.tsx apps/web/src/components/configurationPolicies/featureTabs/types.ts apps/web/src/components/configurationPolicies/featureTabs/useFeatureLink.ts apps/web/src/components/configurationPolicies/featureTabs/useFeatureLink.test.ts apps/web/src/components/configurationPolicies/ConfigPolicyDetailPage.tsx apps/web/src/components/devices/DeviceEffectiveConfigTab.tsx
git commit -m $'feat(hardware): add inherited collection policy controls\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'
```

## Self-review

- §4.3 / index §B: all normalized states and raise-only flags are defined and tested; `collector` cannot arrive as an agent component.
- §7.1–7.5: Tasks 8–12 pin freshness, five streaks, partial completeness, collector lifecycle, atomic ordering, receipt-clock reset and rollups.
- §8.1–8.4: Tasks 3–5 and 14 cover composite immediate deferrable ownership, forced RLS, all lifecycle registrations, jsonb export exclusions and retention.
- §10: Tasks 4, 6, 7 and 15 ship inline settings, applied defaults, hierarchy/cache/heartbeat delivery and the parity-required policy tab.
- §11.3: Task 13 shares authorized GET and tier-1 AI reads, with both route files registered for MCP coverage.
- W02a/W02b own Go collection, fixtures and agent configuration application; W03 owns monitor kind, subject alerts, built-ins and the retirement seam body.
- W04 owns storage cards, list projection/filter, docs and e2e; W05 owns BMC linking; W06 owns lab proof and the release note.
- Index §A/§C override spec shorthand: reserved migration filenames and `hardware_monitoring_settings` are exact; internal `:id` retains existing agent-auth compatibility.
- Index §B’s one-argument `z.record` is expressed with Zod 4’s required string-key argument; the schema name and inferred wire type are unchanged.
- Index §D leaves summary encoding and view serialization open: this plan fixes typed counts/controller names, ISO dates, numeric disk sizes, bounded event reads and an independent server-writer envelope.
