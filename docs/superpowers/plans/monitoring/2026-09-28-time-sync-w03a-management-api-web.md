# Time Sync W03a Management API and Web Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let administrators configure domain-aware time policies, deliver them to Windows devices, inspect enforcement results, and queue individual or fleet time commands.

**Architecture:** Store the inline `time_sync` feature in a typed child of configuration-policy feature links and resolve it through the existing assignment hierarchy. Deliver canonical fingerprinted settings in the final heartbeat response, and extend the existing accepted-snapshot transaction with policy-aware findings and enforcement auditing. Reuse the configuration-policy editor and device command authorization path for all web writes; W03b owns agent execution.

**Tech Stack:** TypeScript, Zod 4, Hono, Drizzle/PostgreSQL RLS, Redis, Astro, React, Vitest.

**Spec:** `docs/superpowers/specs/monitoring/2026-09-28-time-sync-monitoring-design.md`

**Index:** `docs/superpowers/plans/monitoring/2026-09-28-time-sync.md`

## Global Constraints

All constraints in the index's Global constraints and final Contract resolutions R1–R17 apply; the resolutions override earlier text and the spec. R16 requires tracked-wave branches named `feature/<parent#>-<slug>/wave-<subissue#>`. R17 requires prettier-style TypeScript and lint checks before implementation commits; this API/web plan contains no Go code.

- W03a changes API, shared, web and documentation only; no `agent/` files.
- `time_sync` is inline-only and has trust tier `protective`; partner-wide policies are supported.
- Migration: `2026-11-10-120000-time-sync-config-feature.sql`; append the enum label, never reorder existing labels.
- Settings defaults: `enforceNtp: false`, `ntpServers: []`, `pollIntervalMinutes: 60`, `timezone: { expected: 'site', pinnedTimezone: null, autoFix: false }`.
- NTP list: 0–5 entries; enforcement requires at least 1; poll interval: integer 15–1440 minutes.
- Cache: `timesync:settings:device:${deviceId}`, TTL 120 seconds.
- Delivery: `configUpdate.time_sync_settings`; never `mergedConfigUpdate`; use the existing heartbeat system context without another connection.
- No policy sends defaults; resolver failure omits the key.
- Fingerprint: `sha256:` plus lowercase SHA-256 hex of recursively key-sorted JSON without the fingerprint property; preserve array order.
- Expected timezone: policy pin → non-default site timezone → null; no organization or partner fallback.
- Built-in monitors: version 4 → 5; `time_policy_not_applied`, `policy_not_applied`, 2 snapshots, severity `low`; provision unattached.
- Commands: `time_resync`, `time_set_timezone`, `time_apply_policy`; expiry 3,600,000 ms; execution timeout 60,000 ms; trust-gated.
- `device_time_status.enforcement` is `jsonb NOT NULL DEFAULT '{}'` and `excludedOpen` in tenant exports.
- New settings table has no `org_id`; register its parent-chain RLS, not direct-org cascade/export/merge membership.
- All mutations use `runAction`; fleet commands use one `POST /devices/:id/commands` per device and retain each outcome.
- Locale directories: `en`, `de-DE`, `es-419`, `fr-CA`, `fr-FR`, `it-IT`, `pt-BR`, `tr-TR`; real translations in every non-English catalog (R1); no prose exemptions or duplicate-budget increases.

**Checkout prerequisite:** this plan was researched against the actual working tree on 2026-09-28. Its hardware template exists, but the W01a/W02 time-sync artifacts do not. Tasks referencing those artifacts explicitly use the index declarations as their anchors, not invented source line numbers. Before execution, use a base containing W01a and W02 and reconcile those integration anchors. Do not implement either earlier wave inside this PR. The missing-base evidence and other contract issues are listed at the end.

Read-only prerequisite check (run from repository root):

```bash
python3 - <<'PY'
from pathlib import Path
paths = [
 'packages/shared/src/validators/timeSync.ts',
 'packages/shared/src/utils/windowsZones.ts',
 'apps/api/src/db/schema/timeSync.ts',
 'apps/api/src/services/timeSync/ingest.ts',
 'apps/api/src/services/timeSync/view.ts',
 'apps/api/src/services/timeSync/findings.ts',
 'apps/api/src/services/timeSync/expectedTimezone.ts',
 'apps/web/src/components/devices/time/DeviceTimeSection.tsx',
 'apps/web/src/components/devices/time/FleetTimeSyncReport.tsx',
 'apps/docs/src/content/docs/features/time-sync.mdx',
]
missing = [p for p in paths if not Path(p).is_file()]
assert not missing, 'W01a/W02 base required: ' + ', '.join(missing)
PY
```

## Review Focus

The index's five Review focus items explicitly belong to W01a/W01b; it assigns no verbatim item to W03a. Preserve their tests when extending the shared findings and timezone paths.

- Input: no applicable policy versus a resolver exception. Expected: defaults sent versus key omitted, with the resolver inside the existing system context. Tasks 4–5 pin both outcomes.
- Input: org-scoped agent reading its own partner-wide policy, then attempting to mutate it or read another partner. Expected: SELECT allowed only for its own partner, writes and foreign reads denied. Tasks 2 and 4 pin the distinction.
- Input: repeated enforcement result IDs and a fleet selection with different expected zones plus one queue failure. Expected: one audit per new per-kind result and a distinct truthful outcome per device. Tasks 6 and 10 pin these cases.

## File Structure

Paths marked **dependency modification** exist by W01a/W02 contract but are absent in this checkout; their integration anchors need verification on that base.

| File | Responsibility |
|---|---|
| `packages/shared/src/validators/timeSync.ts` | Dependency modification: inline settings and defaults. |
| `packages/shared/src/validators/timeSync.settings.test.ts` | Settings bounds, strictness, pinned-zone validation. |
| `packages/shared/src/validators/index.ts` | Export the new settings symbols beside W01a exports. |
| `packages/shared/src/constants/configFeatureTypes.ts` | Append feature and protective trust tier. |
| `packages/shared/src/constants/configFeatureTypes.test.ts` | Protective-tier regression. |
| `apps/api/src/db/schema/configurationPolicies.ts` | Enum and typed time settings table with CHECKs. |
| `apps/api/src/db/schema/timeSync.ts` | Dependency modification: enforcement column. |
| `apps/api/migrations/2026-11-10-120000-time-sync-config-feature.sql` | Idempotent table, enum, enforcement column and RLS. |
| `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` | Parent-chain table registration. |
| `apps/api/src/services/tenantExportPolicyRegistry.ts` | Classify enforcement as an open container. |
| `apps/api/src/services/timeSync/settings.integration.test.ts` | RLS, SQL constraints, migration replay and partner inheritance. |
| `apps/api/vitest.config.ts` | Exclude new integration suite from unit runs if not already covered by W01a. |
| `apps/api/vitest.integration.config.ts` | Include the time-sync integration glob if not already supplied by W01a. |
| `apps/api/src/services/configurationPolicy.ts` | Normalize, assemble, prevalidate, delete and reject linked policy IDs. |
| `apps/api/src/services/configurationPolicy.timeSync.test.ts` | Normalized CRUD and validation tests. |
| `apps/api/src/routes/configurationPolicies/featureLinks.ts` | POST/PATCH Zod validation. |
| `apps/api/src/routes/configurationPolicies/featureLinks.test.ts` | Route validation regression. |
| `apps/api/src/services/policyBaselineDefaults.ts` | Time-sync baseline with enforcement off. |
| `apps/api/src/services/policyBaselineDefaults.test.ts` | Baseline and feature parity. |
| `apps/api/src/services/aiToolsConfigPolicy.ts` | Inline feature authoring guidance. |
| `apps/api/src/services/aiToolsConfigPolicy.test.ts` | Describe-tool guidance regression. |
| `apps/api/src/services/timeSync/settings.ts` | Hierarchical settings and policy provenance, cached delivery resolution. |
| `apps/api/src/services/timeSync/settings.test.ts` | Assignment eligibility, priority, cache and error behavior. |
| `apps/api/src/services/timeSync/configUpdate.ts` | Canonical payload construction and hashing. |
| `apps/api/src/services/timeSync/configUpdate.test.ts` | Wire contract and hash tests. |
| `apps/api/src/routes/agents/helpers.ts` | Export `buildTimeSyncConfigUpdate`. |
| `apps/api/src/routes/agents/heartbeat.ts` | Resolve once in shared context, attach only to final response. |
| `apps/api/src/routes/agents/heartbeat.test.ts` | Delivery/omission/context regression tests. |
| `apps/api/src/services/timeSync/enforcement.ts` | Pure management findings and transactional enforcement audit. |
| `apps/api/src/services/timeSync/enforcement.test.ts` | Finding truth table, deduplication and audit failures. |
| `apps/api/src/services/timeSync/findings.ts` | Dependency modification: merge management findings before health reduction. |
| `apps/api/src/services/timeSync/ingest.ts` | Dependency modification: policy input, enforcement persistence and audit. |
| `apps/api/src/services/timeSync/fleet.ts` | Policy-aware canonical views before finding/health filtering, count and pagination. |
| `apps/api/src/services/timeSync/fleet.test.ts` | Preserve scope/domain tests; verify pre-page policy filtering and totals. |
| `apps/api/src/services/timeSync/view.ts` | Dependency modification: policy timezone, current findings, enforcement view. |
| `apps/api/src/services/timeSync/expectedTimezone.test.ts` | Dependency modification: pinned UTC and site fallback tests. |
| `apps/api/src/services/timeSync/view.test.ts` | Dependency modification: mock settings for existing read-projection tests and cover a policy pin. |
| `apps/api/src/services/timeSync/management.integration.test.ts` | Accepted ingest, replay, transaction rollback and current view. |
| `apps/api/src/services/monitors/builtInMonitors.ts` | Add version-5 unattached default. |
| `apps/api/src/services/monitors/builtInMonitors.timeSync.test.ts` | Preserve v4 and provision only v5 additions. |
| `apps/api/src/services/monitors/builtInMonitors.test.ts` | Advance total/version expectations while preserving historical defaults. |
| `apps/api/src/__tests__/integration/builtInMonitors.integration.test.ts` | Verify v4-to-v5 upgrade and no implicit assignments. |
| `apps/api/src/services/commandTypes.ts` | Three command constants. |
| `apps/api/src/services/commandOfflinePolicy.ts` | Dedicated fixed one-hour TTL class and registrations. |
| `apps/api/src/services/commandTimeouts.ts` | Dedicated 60-second timeout. |
| `apps/api/src/services/partnerTrust.ts` | Gate all three commands. |
| `apps/api/src/routes/devices/schemas.ts` | Command types and strict payload validation. |
| `apps/api/src/services/timeSync/commands.test.ts` | Command registration, expiry, timeout and validation. |
| `apps/api/src/routes/devices/commands.test.ts` | Permission, MFA/trust, tenant and queue route coverage. |
| `apps/web/src/components/configurationPolicies/featureTabs/TimeSyncTab.tsx` | Policy editor using FeatureTabShell and useFeatureLink. |
| `apps/web/src/components/configurationPolicies/featureTabs/TimeSyncTab.test.tsx` | Defaults, validation, inheritance, failed save. |
| `apps/web/src/components/configurationPolicies/featureTabs/types.ts` | Feature metadata. |
| `apps/web/src/components/configurationPolicies/ConfigPolicyDetailPage.tsx` | Tab import, icon and rendering. |
| `apps/web/src/components/configurationPolicies/featureTabs/useFeatureLink.test.ts` | Time feature mutation feedback regression. |
| `apps/web/src/components/devices/DeviceEffectiveConfigTab.tsx` | Effective config metadata. |
| `apps/web/src/services/deviceActions.ts` | Expose the existing raw command request for runAction. |
| `apps/web/src/components/devices/time/TimeSyncActions.tsx` | Single/fleet command controls and per-device outcomes. |
| `apps/web/src/components/devices/time/TimeSyncActions.test.tsx` | Queue payloads, missing expectation, partial failure, 401. |
| `apps/web/src/components/devices/time/TimeSyncEnforcement.tsx` | Latest per-kind enforcement result display. |
| `apps/web/src/components/devices/time/TimeSyncEnforcement.test.tsx` | Before/after, unknown state and outcome rendering. |
| `apps/web/src/components/devices/time/DeviceTimeSection.tsx` | Dependency modification: actions, policy provenance and enforcement. |
| `apps/web/src/components/devices/time/FleetTimeSyncReport.tsx` | Dependency modification: selected device actions. |
| `apps/web/src/components/devices/time/types.ts` | Dependency modification: exact shared enforcement type. |
| `apps/web/src/lib/i18n/translationCoverage.test.ts` | Run unchanged duplicate guard; Task 9 adds no identical tokens requiring a baseline change. |
| `apps/web/src/locales/en/devices.json` | Authoritative management strings. |
| `apps/web/src/locales/de-DE/devices.json` | Translated management, action and enforcement strings (R1). |
| `apps/web/src/locales/es-419/devices.json` | Translated management, action and enforcement strings (R1). |
| `apps/web/src/locales/fr-CA/devices.json` | Translated management, action and enforcement strings (R1). |
| `apps/web/src/locales/fr-FR/devices.json` | Translated management, action and enforcement strings (R1). |
| `apps/web/src/locales/it-IT/devices.json` | Translated management, action and enforcement strings (R1). |
| `apps/web/src/locales/pt-BR/devices.json` | Translated management, action and enforcement strings (R1). |
| `apps/web/src/locales/tr-TR/devices.json` | Translated management, action and enforcement strings (R1). |
| `apps/docs/src/content/docs/features/time-sync.mdx` | Dependency modification: management documentation. |
| `apps/web/src/components/devices/time/timeSyncManagementDocs.test.ts` | Documentation and copy contract. |

Existing parity tests are run, not gratuitously rewritten: `featureTypeParity.test.ts` and `DeviceEffectiveConfigTab.featureParity.test.ts`. Existing schema barrel already exports configurationPolicies (`apps/api/src/db/schema/index.ts:56`). No new route file, MCP route entry, AI read tool, scheduler, or agent-edition exception is introduced.

### Task 1: Define and validate the inline settings contract

**Files:**
- Modify: `packages/shared/src/validators/timeSync.ts` (index §F.1 dependency anchor; no current source lines).
- Modify: `packages/shared/src/validators/index.ts` (alongside W01a's timeSync export).
- Modify: `packages/shared/src/constants/configFeatureTypes.ts:29,127`.
- Modify: `packages/shared/src/constants/configFeatureTypes.test.ts:49`.
- Create/Test: `packages/shared/src/validators/timeSync.settings.test.ts`.

**Interfaces:** Consumes `ntpServerHostSchema`, `ianaToWindowsZone(iana: string): string | null` from index §§B/C.1. Produces `TIME_SYNC_DEFAULTS`, `timeSyncInlineSettingsSchema`, `TimeSyncInlineSettings` exactly as §F.1.

- [ ] Write the failing test file:

```ts
import { describe, expect, it } from 'vitest';
import { TIME_SYNC_DEFAULTS, timeSyncInlineSettingsSchema } from './timeSync';
import {
  CONFIG_FEATURE_TYPES,
  CONFIG_POLICY_FEATURE_TRUST_TIER,
} from '../constants/configFeatureTypes';

describe('time sync inline settings', () => {
  it('defaults to observation without enforcement', () => {
    expect(timeSyncInlineSettingsSchema.parse({})).toEqual(TIME_SYNC_DEFAULTS);
    expect(CONFIG_FEATURE_TYPES.at(-1)).toBe('time_sync');
    expect(CONFIG_POLICY_FEATURE_TRUST_TIER.time_sync).toBe('protective');
  });
  it.each([15, 60, 1440])('accepts interval %s', (pollIntervalMinutes) => {
    expect(
      timeSyncInlineSettingsSchema.parse({ pollIntervalMinutes })
        .pollIntervalMinutes,
    ).toBe(pollIntervalMinutes);
  });
  it.each([14, 1441, 15.5, '60', null])(
    'rejects interval %s',
    (pollIntervalMinutes) => {
      expect(
        timeSyncInlineSettingsSchema.safeParse({ pollIntervalMinutes }).success,
      ).toBe(false);
    },
  );
  it('requires peers only for NTP enforcement', () => {
    expect(
      timeSyncInlineSettingsSchema.safeParse({ enforceNtp: true }).success,
    ).toBe(false);
    expect(
      timeSyncInlineSettingsSchema.safeParse({
        enforceNtp: true,
        ntpServers: ['pool.ntp.org'],
      }).success,
    ).toBe(true);
    expect(
      timeSyncInlineSettingsSchema.safeParse({
        ntpServers: Array(6).fill('pool.ntp.org'),
      }).success,
    ).toBe(false);
  });
  it.each(['a,0x9', 'a b', 'a;b', '-flag', 'a:123', '"a"', 'a/b', '', 'a..b'])(
    'rejects unsafe peer %s',
    (host) => {
      expect(
        timeSyncInlineSettingsSchema.safeParse({ ntpServers: [host] }).success,
      ).toBe(false);
    },
  );
  it.each(['UTC', 'America/New_York'])(
    'accepts mapped pin %s',
    (pinnedTimezone) => {
      expect(
        timeSyncInlineSettingsSchema.safeParse({
          timezone: { expected: 'pinned', pinnedTimezone },
        }).success,
      ).toBe(true);
    },
  );
  it.each([null, '', 'Unknown/Zone', 'Antarctica/Troll'])(
    'rejects unmapped pin %s',
    (pinnedTimezone) => {
      expect(
        timeSyncInlineSettingsSchema.safeParse({
          timezone: { expected: 'pinned', pinnedTimezone },
        }).success,
      ).toBe(false);
    },
  );
  it('rejects unknown keys and never shares mutable default arrays', () => {
    expect(
      timeSyncInlineSettingsSchema.safeParse({ extra: true }).success,
    ).toBe(false);
    expect(
      timeSyncInlineSettingsSchema.safeParse({ timezone: { extra: true } })
        .success,
    ).toBe(false);
    const first = timeSyncInlineSettingsSchema.parse({});
    first.ntpServers.push('pool.ntp.org');
    expect(timeSyncInlineSettingsSchema.parse({}).ntpServers).toEqual([]);
  });
});
```

- [ ] Run: `cd packages/shared && npx vitest run src/validators/timeSync.settings.test.ts`. Expected FAIL: missing `TIME_SYNC_DEFAULTS` export or feature absent. On the current checkout the earlier prerequisite check fails first; that is not a product regression result.
- [ ] Append the following to the W01a validator, adding `import { ianaToWindowsZone } from '../utils/windowsZones';` to its imports:

```ts
export const TIME_SYNC_DEFAULTS = {
  enforceNtp: false,
  ntpServers: [] as string[],
  pollIntervalMinutes: 60,
  timezone: {
    expected: 'site' as const,
    pinnedTimezone: null as string | null,
    autoFix: false,
  },
};

export const timeSyncInlineSettingsSchema = z
  .object({
    enforceNtp: z.boolean().default(false),
    ntpServers: z.array(ntpServerHostSchema).max(5).default([]),
    pollIntervalMinutes: z.number().int().min(15).max(1440).default(60),
    timezone: z
      .object({
        expected: z.enum(['site', 'pinned']).default('site'),
        pinnedTimezone: z.string().max(64).nullable().default(null),
        autoFix: z.boolean().default(false),
      })
      .strict()
      .default(TIME_SYNC_DEFAULTS.timezone),
  })
  .strict()
  .superRefine((settings, ctx) => {
    if (settings.enforceNtp && settings.ntpServers.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['ntpServers'],
        message:
          'At least one NTP server is required when enforcement is enabled.',
      });
    }
    const pin = settings.timezone.pinnedTimezone;
    if (pin !== null && ianaToWindowsZone(pin) === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['timezone', 'pinnedTimezone'],
        message: 'Choose a timezone with a Windows mapping.',
      });
    } else if (settings.timezone.expected === 'pinned' && pin === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['timezone', 'pinnedTimezone'],
        message: 'A pinned timezone is required.',
      });
    }
  });
export type TimeSyncInlineSettings = z.infer<
  typeof timeSyncInlineSettingsSchema
>;
```

Append the export beside W01a's exports (do not duplicate a wildcard export if it already covers these):

```ts
export {
  TIME_SYNC_DEFAULTS,
  timeSyncInlineSettingsSchema,
  type TimeSyncInlineSettings,
} from './timeSync';
```

Exact constant anchors and replacements: append `'time_sync',` after the final `'hardware_monitoring',` tuple member in `configFeatureTypes.ts`. The final two members are:

```ts
```

Append the protective trust entry after `hardware_monitoring: 'protective',`. The final two entries are:

```ts
  hardware_monitoring: 'protective',
  time_sync: 'protective',
```

In `configFeatureTypes.test.ts:49`, replace the existing protective test tuple with:

```ts
[
  'security',
  'peripheral_control',
  'compliance',
  'vulnerability',
  'event_log',
  'sensitive_data',
  'device_lifecycle',
  'monitors',
  'hardware_monitoring',
  'warranty',
  'time_sync',
] as const;
```

- [ ] Run: `cd packages/shared && npx vitest run src/validators/timeSync.settings.test.ts src/constants/configFeatureTypes.test.ts`. Expected PASS. Run W01a's existing host-fixture test as well; this task deliberately reuses its IPv4/IPv6/hostname parser.
- [ ] Commit:

```bash
git add packages/shared/src/validators/timeSync.ts packages/shared/src/validators/timeSync.settings.test.ts packages/shared/src/validators/index.ts packages/shared/src/constants/configFeatureTypes.ts packages/shared/src/constants/configFeatureTypes.test.ts
git commit -m "feat(time-sync): define inline management settings" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2: Store settings and enforcement with parent-chain isolation

**Files:**
- Modify: `apps/api/src/db/schema/configurationPolicies.ts:59,356`.
- Modify: `apps/api/src/db/schema/timeSync.ts` (index §D dependency anchor).
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts:971`.
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts` (W01a/W02 `device_time_status` entry; absent locally).
- Modify if W01a did not already register the glob: `apps/api/vitest.config.ts:56`, `apps/api/vitest.integration.config.ts:30`.
- Create: `apps/api/migrations/2026-11-10-120000-time-sync-config-feature.sql`.
- Create/Test: `apps/api/src/services/timeSync/settings.integration.test.ts`.

**Interfaces:** Consumes `configPolicyFeatureLinks.id` and `configurationPolicies` ownership. Produces `configPolicyTimeSyncSettings` with typed columns and `deviceTimeStatus.enforcement: TimeSyncEnforcementState | Record<string, never>`. The empty object represents no report; the view converts it to null.

- [ ] Write this failing integration test (existing fixture helpers verified in `hardwareHealth/migrations.integration.test.ts:1–12`; every operation asserting RLS uses the application connection):

```ts
import '../../__tests__/integration/setup';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import {
  createPartner,
  createOrganization,
} from '../../__tests__/integration/db-utils';
import { getTestDb } from '../../__tests__/integration/setup';
import { replayMigration } from '../../__tests__/integration/replayMigration';
import { pgErrorCode } from '../../utils/pgErrors';

async function fixture() {
  const p = (await createPartner())!;
  const q = (await createPartner())!;
  const a = (await createOrganization({ partnerId: p.id }))!;
  const b = (await createOrganization({ partnerId: q.id }))!;
  const own: DbAccessContext = {
    scope: 'organization',
    orgId: a.id,
    accessibleOrgIds: [a.id],
    accessiblePartnerIds: [],
    currentPartnerId: p.id,
  };
  const foreign: DbAccessContext = {
    scope: 'organization',
    orgId: b.id,
    accessibleOrgIds: [b.id],
    accessiblePartnerIds: [],
    currentPartnerId: q.id,
  };
  const owner: DbAccessContext = {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: [a.id],
    accessiblePartnerIds: [p.id],
    currentPartnerId: p.id,
  };
  const [policy] = await getTestDb().execute(sql`
    INSERT INTO configuration_policies(partner_id, name)
    VALUES (${p.id}, ${'Time policy ' + randomUUID()}) RETURNING id`);
  const [link] = await getTestDb().execute(sql`
    INSERT INTO config_policy_feature_links(config_policy_id, feature_type)
    VALUES (${String(policy!.id)}, 'time_sync') RETURNING id`);
  await withDbAccessContext(owner, () =>
    db.execute(sql`
    INSERT INTO config_policy_time_sync_settings(feature_link_id)
    VALUES (${String(link!.id)})`),
  );
  return { own, foreign, owner, linkId: String(link!.id) };
}

it('allows own-partner SELECT without granting org writes', async () => {
  const f = await fixture();
  const read = () =>
    db.execute(
      sql`SELECT * FROM config_policy_time_sync_settings WHERE feature_link_id=${f.linkId}`,
    );
  expect(await withDbAccessContext(f.own, read)).toHaveLength(1);
  expect(await withDbAccessContext(f.foreign, read)).toHaveLength(0);
  expect(
    await withDbAccessContext(f.own, () =>
      db.execute(sql`
    UPDATE config_policy_time_sync_settings SET poll_interval_minutes=120
    WHERE feature_link_id=${f.linkId} RETURNING id`),
    ),
  ).toHaveLength(0);
  expect(
    await withDbAccessContext(f.own, () =>
      db.execute(sql`
    DELETE FROM config_policy_time_sync_settings WHERE feature_link_id=${f.linkId} RETURNING id`),
    ),
  ).toHaveLength(0);
  await expect(
    withDbAccessContext(f.foreign, () =>
      db.execute(sql`
    INSERT INTO config_policy_time_sync_settings(feature_link_id) VALUES (${f.linkId})`),
    ),
  ).rejects.toSatisfy((e: unknown) => pgErrorCode(e) === '42501');
});
it('allows own-org CRUD but rejects sibling-org reads and reparenting', async () => {
  const f = await fixture();
  const sibling = (await createOrganization({
    partnerId: f.own.currentPartnerId!,
  }))!;
  const seed = async (orgId: string) => {
    const [policy] = await getTestDb().execute(
      sql`INSERT INTO configuration_policies(org_id,name) VALUES(${orgId},'Org time policy') RETURNING id`,
    );
    const [link] = await getTestDb().execute(
      sql`INSERT INTO config_policy_feature_links(config_policy_id,feature_type) VALUES(${String(policy!.id)},'time_sync') RETURNING id`,
    );
    return { policyId: String(policy!.id), linkId: String(link!.id) };
  };
  const own = await seed(f.own.orgId!);
  const foreign = await seed(sibling.id);
  const siblingContext: DbAccessContext = {
    ...f.own,
    orgId: sibling.id,
    accessibleOrgIds: [sibling.id],
  };
  await withDbAccessContext(f.own, () =>
    db.execute(
      sql`INSERT INTO config_policy_time_sync_settings(feature_link_id) VALUES(${own.linkId})`,
    ),
  );
  expect(
    await withDbAccessContext(f.own, () =>
      db.execute(
        sql`UPDATE config_policy_time_sync_settings SET poll_interval_minutes=120 WHERE feature_link_id=${own.linkId} RETURNING id`,
      ),
    ),
  ).toHaveLength(1);
  expect(
    await withDbAccessContext(siblingContext, () =>
      db.execute(
        sql`SELECT id FROM config_policy_time_sync_settings WHERE feature_link_id=${own.linkId}`,
      ),
    ),
  ).toHaveLength(0);
  await expect(
    withDbAccessContext(f.own, () =>
      db.execute(
        sql`UPDATE config_policy_time_sync_settings SET feature_link_id=${foreign.linkId} WHERE feature_link_id=${own.linkId}`,
      ),
    ),
  ).rejects.toSatisfy((e: unknown) => pgErrorCode(e) === '42501');
  expect(
    await withDbAccessContext(f.own, () =>
      db.execute(
        sql`DELETE FROM config_policy_time_sync_settings WHERE feature_link_id=${own.linkId} RETURNING id`,
      ),
    ),
  ).toHaveLength(1);
  await withDbAccessContext(f.own, () =>
    db.execute(
      sql`INSERT INTO config_policy_time_sync_settings(feature_link_id) VALUES(${own.linkId})`,
    ),
  );
  await getTestDb().execute(
    sql`DELETE FROM configuration_policies WHERE id=${own.policyId}`,
  );
  expect(
    await getTestDb().execute(
      sql`SELECT id FROM config_policy_time_sync_settings WHERE feature_link_id=${own.linkId}`,
    ),
  ).toHaveLength(0);
});
it('enforces every typed CHECK and permits boundaries', async () => {
  const f = await fixture();
  const bad = [
    sql`poll_interval_minutes=14`,
    sql`poll_interval_minutes=1441`,
    sql`timezone_expected='other'`,
    sql`timezone_expected='pinned', pinned_timezone=NULL`,
    sql`enforce_ntp=true, ntp_servers='{}'::text[]`,
    sql`ntp_servers=ARRAY['a','b','c','d','e','f']::text[]`,
  ];
  for (const assignment of bad) {
    await expect(
      withDbAccessContext(f.owner, () =>
        db.execute(sql`
      UPDATE config_policy_time_sync_settings SET ${assignment} WHERE feature_link_id=${f.linkId}`),
      ),
    ).rejects.toSatisfy((e: unknown) => pgErrorCode(e) === '23514');
  }
  for (const minutes of [15, 1440]) {
    await withDbAccessContext(f.owner, () =>
      db.execute(sql`
      UPDATE config_policy_time_sync_settings SET poll_interval_minutes=${minutes},
      timezone_expected='pinned', pinned_timezone='UTC', enforce_ntp=true,
      ntp_servers=ARRAY['pool.ntp.org'] WHERE feature_link_id=${f.linkId}`),
    );
  }
});
it('is forced, has five policies, and replays without erasing settings', async () => {
  const f = await fixture();
  const rows = await getTestDb().execute(sql`
    SELECT relrowsecurity, relforcerowsecurity FROM pg_class
    WHERE oid=to_regclass('config_policy_time_sync_settings')`);
  expect(rows[0]).toMatchObject({
    relrowsecurity: true,
    relforcerowsecurity: true,
  });
  const policies = await getTestDb().execute(sql`
    SELECT polcmd FROM pg_policy WHERE polrelid=to_regclass('config_policy_time_sync_settings')`);
  expect(policies.map((p) => p.polcmd).sort()).toEqual([
    'a',
    'd',
    'r',
    'r',
    'w',
  ]);
  await replayMigration('2026-11-10-120000-time-sync-config-feature.sql');
  await replayMigration('2026-11-10-120000-time-sync-config-feature.sql');
  expect(
    await withDbAccessContext(f.own, () =>
      db.execute(sql`
    SELECT id FROM config_policy_time_sync_settings WHERE feature_link_id=${f.linkId}`),
    ),
  ).toHaveLength(1);
});
```

- [ ] Start the disposable test stack from root with `pnpm test-stack up`. Run `cd apps/api && npx vitest run --config vitest.integration.config.ts src/services/timeSync/settings.integration.test.ts`. Expected FAIL: enum label/table absent. Keep this stack for final verification, and tear it down in Task 12 even if a check fails.
- [ ] Implement the migration in full:

```sql
ALTER TYPE config_feature_type ADD VALUE IF NOT EXISTS 'time_sync';

CREATE TABLE IF NOT EXISTS config_policy_time_sync_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  feature_link_id uuid NOT NULL UNIQUE REFERENCES config_policy_feature_links(id) ON DELETE CASCADE,
  enforce_ntp boolean NOT NULL DEFAULT false,
  ntp_servers text[] NOT NULL DEFAULT '{}',
  poll_interval_minutes integer NOT NULL DEFAULT 60,
  timezone_expected text NOT NULL DEFAULT 'site',
  pinned_timezone text,
  timezone_auto_fix boolean NOT NULL DEFAULT false,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT config_policy_time_sync_servers_chk CHECK (cardinality(ntp_servers) <= 5),
  CONSTRAINT config_policy_time_sync_poll_chk CHECK (poll_interval_minutes BETWEEN 15 AND 1440),
  CONSTRAINT config_policy_time_sync_expected_chk CHECK (timezone_expected IN ('site', 'pinned')),
  CONSTRAINT config_policy_time_sync_pin_chk CHECK (timezone_expected = 'site' OR pinned_timezone IS NOT NULL),
  CONSTRAINT config_policy_time_sync_enforce_chk CHECK (NOT enforce_ntp OR cardinality(ntp_servers) >= 1)
);
ALTER TABLE config_policy_time_sync_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE config_policy_time_sync_settings FORCE ROW LEVEL SECURITY;
DO $$
DECLARE
  t text := 'config_policy_time_sync_settings';
  predicate text;
BEGIN
  predicate := format('EXISTS (SELECT 1 FROM configuration_policies policy WHERE policy.id = (SELECT link.config_policy_id FROM config_policy_feature_links link WHERE link.id = %I.feature_link_id) AND (breeze_has_org_access(policy.org_id) OR breeze_has_partner_access(policy.partner_id)))', t);
  EXECUTE format('DROP POLICY IF EXISTS breeze_parent_select ON %I', t);
  EXECUTE format('DROP POLICY IF EXISTS breeze_parent_insert ON %I', t);
  EXECUTE format('DROP POLICY IF EXISTS breeze_parent_update ON %I', t);
  EXECUTE format('DROP POLICY IF EXISTS breeze_parent_delete ON %I', t);
  EXECUTE format('CREATE POLICY breeze_parent_select ON %I FOR SELECT USING (%s)', t, predicate);
  EXECUTE format('CREATE POLICY breeze_parent_insert ON %I FOR INSERT WITH CHECK (%s)', t, predicate);
  EXECUTE format('CREATE POLICY breeze_parent_update ON %I FOR UPDATE USING (%s) WITH CHECK (%s)', t, predicate, predicate);
  EXECUTE format('CREATE POLICY breeze_parent_delete ON %I FOR DELETE USING (%s)', t, predicate);
END $$;
DROP POLICY IF EXISTS config_policy_time_sync_settings_partner_wide_select ON config_policy_time_sync_settings;
CREATE POLICY config_policy_time_sync_settings_partner_wide_select
ON config_policy_time_sync_settings FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM configuration_policies cp
    WHERE cp.id = (
      SELECT fl.config_policy_id FROM config_policy_feature_links fl
      WHERE fl.id = config_policy_time_sync_settings.feature_link_id
    )
    AND cp.org_id IS NULL
    AND cp.partner_id = public.breeze_current_partner_id()
  )
);
GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON config_policy_time_sync_settings TO breeze_app;
ALTER TABLE device_time_status ADD COLUMN IF NOT EXISTS enforcement jsonb NOT NULL DEFAULT '{}';
```

No data writes use the new enum value in this migration. The two-hop scalar subquery follows the parent-chain coverage suite's expected form, including the additive SELECT-only policy.

Append `'time_sync',` immediately after existing `'hardware_monitoring',` at `configurationPolicies.ts:59`. Append this complete declaration after the hardware table's closing `]);` at line 356 (existing imports already include `check`, `sql`, `text`, `integer`, `boolean`):

```ts
export const configPolicyTimeSyncSettings = pgTable(
  'config_policy_time_sync_settings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    featureLinkId: uuid('feature_link_id')
      .notNull()
      .unique()
      .references(() => configPolicyFeatureLinks.id, { onDelete: 'cascade' }),
    enforceNtp: boolean('enforce_ntp').notNull().default(false),
    ntpServers: text('ntp_servers').array().notNull().default([]),
    pollIntervalMinutes: integer('poll_interval_minutes').notNull().default(60),
    timezoneExpected: text('timezone_expected')
      .$type<'site' | 'pinned'>()
      .notNull()
      .default('site'),
    pinnedTimezone: text('pinned_timezone'),
    timezoneAutoFix: boolean('timezone_auto_fix').notNull().default(false),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => [
    check(
      'config_policy_time_sync_servers_chk',
      sql`cardinality(${t.ntpServers}) <= 5`,
    ),
    check(
      'config_policy_time_sync_poll_chk',
      sql`${t.pollIntervalMinutes} BETWEEN 15 AND 1440`,
    ),
    check(
      'config_policy_time_sync_expected_chk',
      sql`${t.timezoneExpected} IN ('site', 'pinned')`,
    ),
    check(
      'config_policy_time_sync_pin_chk',
      sql`${t.timezoneExpected} = 'site' OR ${t.pinnedTimezone} IS NOT NULL`,
    ),
    check(
      'config_policy_time_sync_enforce_chk',
      sql`NOT ${t.enforceNtp} OR cardinality(${t.ntpServers}) >= 1`,
    ),
  ],
);
```

In the dependency `schema/timeSync.ts` import `type TimeSyncEnforcementState` from `@breeze/shared`, and add this property to `deviceTimeStatus` adjacent to the §D `findingStreaks` column:

```ts
  enforcement: jsonb('enforcement')
    .$type<TimeSyncEnforcementState | Record<string, never>>()
    .notNull()
    .default({}),
```

At `rls-coverage.integration.test.ts:971`, preserve the existing entry and append:

```ts
  ['config_policy_hardware_monitoring_settings', ['configuration_policies']],
  ['config_policy_time_sync_settings', ['configuration_policies']],
```

In the W02 `device_time_status` export-policy entry, replace only the `excludedOpen` property with this complete property (contract §D):

```ts
  excludedOpen: [
    'finding_details',
    'event_marks',
    'recent_events',
    'finding_streaks',
    'enforcement',
  ],
```

Retain all other column classifications. Do not register the settings child in direct-org cascade/merge/export lists. If missing from W01a, append `'src/services/timeSync/**/*.integration.test.ts',` to both the unit exclude array next to the hardware integration glob (`vitest.config.ts:56`) and integration include array (`vitest.integration.config.ts:30`).

- [ ] Run the integration command again after applying migrations through the test-stack's normal migration setup. Expected PASS, including the `42501` forged insertion and `23514` constraints. Run `cd apps/api && npx vitest run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts`. Expected PASS. Final contract-suite execution is Task 12.
- [ ] Commit:

```bash
git add apps/api/migrations/2026-11-10-120000-time-sync-config-feature.sql apps/api/src/db/schema/configurationPolicies.ts apps/api/src/db/schema/timeSync.ts apps/api/src/__tests__/integration/rls-coverage.integration.test.ts apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/services/timeSync/settings.integration.test.ts apps/api/vitest.config.ts apps/api/vitest.integration.config.ts
git commit -m "feat(time-sync): persist isolated management settings" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3: Normalize feature writes, validate routes, and describe defaults

**Files:**
- Modify: `apps/api/src/services/configurationPolicy.ts:15,55,863–870,1130–1132,1175–1177,1343–1356,2964`.
- Modify: `apps/api/src/routes/configurationPolicies/featureLinks.ts:10,326–335,560–569`.
- Modify: `apps/api/src/services/policyBaselineDefaults.ts:17,63,111`.
- Modify: `apps/api/src/services/aiToolsConfigPolicy.ts:246`.
- Create/Test: `apps/api/src/services/configurationPolicy.timeSync.test.ts`.
- Modify/Test: `apps/api/src/routes/configurationPolicies/featureLinks.test.ts:194`, `apps/api/src/services/policyBaselineDefaults.test.ts`, `apps/api/src/services/aiToolsConfigPolicy.test.ts:1321`.

**Interfaces:** Consumes Task 1 schema and Task 2 table. Existing `listFeatureLinks`, `updateFeatureLink`, `validateFeaturePolicyExists` remain unchanged public interfaces; normalized rows assemble to `TimeSyncInlineSettings`, not the JSON mirror.

- [ ] Write the failing service test in full:

```ts
import { beforeEach, expect, it, vi } from 'vitest';
import { TIME_SYNC_DEFAULTS } from '@breeze/shared';
const m = vi.hoisted(() => ({
  rows: [] as unknown[][],
  inserted: [] as any[],
  deleted: [] as unknown[],
}));
vi.mock('../db', () => {
  const tx: any = {};
  function result(rows: unknown[]) {
    const c: any = {
      then: (yes: any, no: any) => Promise.resolve(rows).then(yes, no),
    };
    for (const key of [
      'from',
      'where',
      'limit',
      'orderBy',
      'returning',
      'for',
      'innerJoin',
    ])
      c[key] = () => c;
    return c;
  }
  tx.select = () => result(m.rows.shift() ?? []);
  tx.transaction = (fn: any) => fn(tx);
  tx.update = () => ({
    set: () => result([{ id: '11111111-1111-4111-8111-111111111111' }]),
  });
  tx.delete = (table: unknown) => ({
    where: () => {
      m.deleted.push(table);
      return result([]);
    },
  });
  tx.insert = (table: unknown) => ({
    values: (value: unknown) => {
      m.inserted.push({ table, value });
      return result([]);
    },
  });
  return {
    db: tx,
    runOutsideDbContext: (f: any) => f(),
    withSystemDbAccessContext: (f: any) => f(),
    withDbAccessContext: (_c: any, f: any) => f(),
  };
});
import {
  listFeatureLinks,
  updateFeatureLink,
  validateFeaturePolicyExists,
} from './configurationPolicy';
import { configPolicyTimeSyncSettings } from '../db/schema';
const id = '11111111-1111-4111-8111-111111111111';
const settings = {
  enforceNtp: true,
  ntpServers: ['pool.ntp.org'],
  pollIntervalMinutes: 120,
  timezone: {
    expected: 'pinned' as const,
    pinnedTimezone: 'UTC',
    autoFix: true,
  },
};
const flat = {
  enforceNtp: true,
  ntpServers: ['pool.ntp.org'],
  pollIntervalMinutes: 120,
  timezoneExpected: 'pinned',
  pinnedTimezone: 'UTC',
  timezoneAutoFix: true,
};
const link = {
  id,
  configPolicyId: id,
  featureType: 'time_sync',
  featurePolicyId: null,
  inlineSettings: TIME_SYNC_DEFAULTS,
};
beforeEach(() => {
  m.rows = [];
  m.inserted = [];
  m.deleted = [];
});
it('reads typed columns instead of the stale mirror', async () => {
  m.rows = [[link], [flat]];
  expect((await listFeatureLinks(id))[0]!.inlineSettings).toEqual(settings);
});
it('replaces the flat row and keeps nested timezone on the API', async () => {
  m.rows = [[link]];
  await updateFeatureLink(id, { inlineSettings: settings }, id);
  expect(m.deleted).toContain(configPolicyTimeSyncSettings);
  expect(m.inserted).toContainEqual({
    table: configPolicyTimeSyncSettings,
    value: { featureLinkId: id, ...flat },
  });
});
it('rejects invalid enforcement before deleting existing settings', async () => {
  m.rows = [[link]];
  await expect(
    updateFeatureLink(id, { inlineSettings: { enforceNtp: true } }, id),
  ).rejects.toThrow();
  expect(m.deleted).toEqual([]);
});
it.each([
  { orgId: id, partnerId: null },
  { orgId: null, partnerId: id },
])('is inline-only for %j', async (owner) => {
  expect(await validateFeaturePolicyExists('time_sync', null, owner)).toEqual({
    valid: true,
  });
  expect(
    (await validateFeaturePolicyExists('time_sync', id, owner)).valid,
  ).toBe(false);
});
```

Append this test beside the existing hardware route case at `featureLinks.test.ts:194` (its `app`, stubs and mock names are verified there):

```ts
it.each(['POST', 'PATCH'])(
  'validates time settings on %s before mutation',
  async (method) => {
    getConfigPolicyMock.mockResolvedValue({
      ...STUB_POLICY,
      featureLinks: [{ id: LINK_ID, featureType: 'time_sync' }],
    });
    validateFeaturePolicyExistsMock.mockResolvedValue({ valid: true });
    const res = await app.request(
      `/${POLICY_ID}/features${method === 'PATCH' ? '/' + LINK_ID : ''}`,
      {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...(method === 'POST' ? { featureType: 'time_sync' } : {}),
          inlineSettings: { enforceNtp: true },
        }),
      },
    );
    expect(res.status).toBe(400);
    expect(addFeatureLinkMock).not.toHaveBeenCalled();
    expect(updateFeatureLinkMock).not.toHaveBeenCalled();
  },
);
```

Append to baseline tests (add `TIME_SYNC_DEFAULTS` to shared imports):

```ts
it('shows disabled time management as the baseline without sharing mutable defaults', () => {
  const first = getPolicyBaselineDefaults().find(
    (x) => x.featureType === 'time_sync',
  )!;
  expect(first).toMatchObject({
    applied: false,
    inlineSettings: TIME_SYNC_DEFAULTS,
  });
  (first.inlineSettings!.ntpServers as string[]).push('pool.ntp.org');
  expect(
    getPolicyBaselineDefaults().find((x) => x.featureType === 'time_sync')!
      .inlineSettings,
  ).toEqual(TIME_SYNC_DEFAULTS);
});
```

Append beside `aiToolsConfigPolicy.test.ts:1321`:

```ts
it('describes time management defaults and precedence without reading a policy', async () => {
  vi.clearAllMocks();
  const out = JSON.parse(
    await tool().handler(
      { action: 'describe', featureType: 'time_sync' },
      {} as never,
    ),
  );
  expect(out).toMatchObject({ featureType: 'time_sync', linkOnly: false });
  for (const text of [
    'enforceNtp: false',
    'pollIntervalMinutes: 60',
    '15..1440',
    'overrides the site timezone',
    'GPO',
  ]) {
    expect(out.inlineSettings).toContain(text);
  }
  expect(db.select).not.toHaveBeenCalled();
  expect(getConfigPolicy).not.toHaveBeenCalled();
});
```

- [ ] Run: `cd apps/api && npx vitest run src/services/configurationPolicy.timeSync.test.ts src/routes/configurationPolicies/featureLinks.test.ts src/services/policyBaselineDefaults.test.ts src/services/aiToolsConfigPolicy.test.ts`. Expected FAIL: missing normalized time settings/default/guidance, or invalid writes reach the mock mutation.
- [ ] Add `configPolicyTimeSyncSettings` to the schema import (`configurationPolicy.ts:15`) and `timeSyncInlineSettingsSchema` to the shared import (`:55`). Each insertion below keeps the quoted existing hardware branch and adds the new time branch immediately after it:

```ts
  // Existing decompose anchor :863–870:
  case 'hardware_monitoring': {
    const parsed = hardwareMonitoringInlineSettingsSchema.parse(s);
    await tx.insert(configPolicyHardwareMonitoringSettings).values({
      featureLinkId: linkId,
      ...parsed,
    });
    break;
  }
  // Append:
  case 'time_sync': {
    const parsed = timeSyncInlineSettingsSchema.parse(s);
    await tx.insert(configPolicyTimeSyncSettings).values({
      featureLinkId: linkId,
      enforceNtp: parsed.enforceNtp,
      ntpServers: parsed.ntpServers,
      pollIntervalMinutes: parsed.pollIntervalMinutes,
      timezoneExpected: parsed.timezone.expected,
      pinnedTimezone: parsed.timezone.pinnedTimezone,
      timezoneAutoFix: parsed.timezone.autoFix,
    });
    break;
  }

  // Existing prevalidation :1130–1132:
  case 'hardware_monitoring':
    hardwareMonitoringInlineSettingsSchema.parse(settings);
    break;
  // Append:
  case 'time_sync':
    timeSyncInlineSettingsSchema.parse(settings);
    break;

  // Existing delete :1175–1177:
  case 'hardware_monitoring':
    await tx
      .delete(configPolicyHardwareMonitoringSettings)
      .where(eq(configPolicyHardwareMonitoringSettings.featureLinkId, linkId));
    break;
  // Append:
  case 'time_sync':
    await tx
      .delete(configPolicyTimeSyncSettings)
      .where(eq(configPolicyTimeSyncSettings.featureLinkId, linkId));
    break;
```

After the existing assemble hardware branch at `:1343–1356` (ends with `: null;` then `}`), append:

```ts
  case 'time_sync': {
    const [row] = await executor
      .select()
      .from(configPolicyTimeSyncSettings)
      .where(eq(configPolicyTimeSyncSettings.featureLinkId, linkId))
      .limit(1);
    return row
      ? timeSyncInlineSettingsSchema.parse({
          enforceNtp: row.enforceNtp,
          ntpServers: row.ntpServers,
          pollIntervalMinutes: row.pollIntervalMinutes,
          timezone: {
            expected: row.timezoneExpected,
            pinnedTimezone: row.pinnedTimezone,
            autoFix: row.timezoneAutoFix,
          },
        })
      : null;
  }
```

Replace the exact inline-only anchor at `:2964`:

```ts
featureType === 'hardware_monitoring' ||
```

with:

```ts
featureType === 'hardware_monitoring' || featureType === 'time_sync' ||
```

`PARTNER_LINKABLE_FEATURE_TYPES` at `configurationPolicy.ts:2727` is for standalone linked resources. This feature must remain out of that set and out of `ORG_SCOPED_ONLY_FEATURE_TYPES`; the inline branch supports both ownership forms.

Add `timeSyncInlineSettingsSchema` to `featureLinks.ts:10` imports. After the existing POST hardware validation block `:326–335`, append:

```ts
if (data.featureType === 'time_sync' && data.inlineSettings) {
  const parsed = timeSyncInlineSettingsSchema.safeParse(data.inlineSettings);
  if (!parsed.success) {
    return c.json(
      zodValidationErrorBody('Invalid time sync settings', parsed.error),
      400,
    );
  }
  data.inlineSettings = parsed.data;
}
```

Inside the PATCH `inlineSettings` branch, after the hardware validation at `:560–569`, append:

```ts
if (existingLink.featureType === 'time_sync') {
  const parsed = timeSyncInlineSettingsSchema.safeParse(data.inlineSettings);
  if (!parsed.success) {
    return c.json(
      zodValidationErrorBody('Invalid time sync settings', parsed.error),
      400,
    );
  }
  data.inlineSettings = parsed.data;
}
```

At `policyBaselineDefaults.ts:17` import `TIME_SYNC_DEFAULTS`. At `:63` replace the exclusion type:

```ts
Exclude<ConfigFeatureType, 'remote_access' | 'pam' | 'hardware_monitoring'>;
```

with:

```ts
Exclude<
  ConfigFeatureType,
  'remote_access' | 'pam' | 'hardware_monitoring' | 'time_sync'
>;
```

Before `const meta = NOT_ENFORCED[ft];` at `:111`, insert:

```ts
if (ft === 'time_sync') {
  return {
    featureType: ft,
    label: 'Time Sync',
    applied: false,
    inlineSettings: {
      ...TIME_SYNC_DEFAULTS,
      ntpServers: [],
      timezone: { ...TIME_SYNC_DEFAULTS.timezone },
    },
    behavior:
      'NTP enforcement and timezone auto-fix are OFF by default; expected timezone follows the site.',
  };
}
```

`applied: false` describes enforcement; observation is independently always on. This matches the Effective Config tab's existing off-by-default handling and avoids borrowing hardware's always-on exception.

At `aiToolsConfigPolicy.ts:246`, after the existing `hardware_monitoring:` guidance entry, append:

```ts
  time_sync: `{ enforceNtp: false, ntpServers: [], pollIntervalMinutes: 60, timezone: { expected: 'site', pinnedTimezone: null, autoFix: false } } — inline-only domain-aware Windows time settings. Up to 5 NTP hosts, no flags or ports; at least one host when enforceNtp is true. pollIntervalMinutes is an integer in 15..1440. A pinned IANA timezone must have a Windows mapping and overrides the site timezone. Workgroup, Entra-only and forest-root PDC devices use manual peers; members, DCs and other PDCs use the domain hierarchy. Unknown roles are skipped. GPO wins. autoFix defaults to false.`,
```

- [ ] Repeat the four-file test command. Expected PASS. The existing feature-type parity test in `policyBaselineDefaults.test.ts` must now cover `time_sync`.
- [ ] Commit:

```bash
git add apps/api/src/services/configurationPolicy.ts apps/api/src/services/configurationPolicy.timeSync.test.ts apps/api/src/routes/configurationPolicies/featureLinks.ts apps/api/src/routes/configurationPolicies/featureLinks.test.ts apps/api/src/services/policyBaselineDefaults.ts apps/api/src/services/policyBaselineDefaults.test.ts apps/api/src/services/aiToolsConfigPolicy.ts apps/api/src/services/aiToolsConfigPolicy.test.ts
git commit -m "feat(time-sync): wire normalized configuration policy feature" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 4: Resolve settings and expected-timezone policy provenance

**Files:** Create `apps/api/src/services/timeSync/settings.ts`; Create/Test `settings.test.ts` in the same directory; extend Task 2 `settings.integration.test.ts`.

**Interfaces:** Consumes `policyOwnershipCondition(owner: ConfigPolicyOwner): SQL` (`configPolicyOwnership.ts:64`), `matchesRoleOsFilter` and `buildRoleOsFilterConditions` (`featureConfigResolver.ts:152,173`), the effective feature-link view, and Task 1 settings. Produces the following W03a-local return type (the index binds the function names but does not specify their return signature):

```ts
export interface ResolvedTimeSyncSettings {
  orgId: string;
  settings: TimeSyncInlineSettings;
  policy: ExpectedTimezoneInput['policy'];
}
export async function resolveDeviceTimeSyncSettings(
  deviceId: string,
): Promise<ResolvedTimeSyncSettings>;
export async function getDeviceTimeSyncSettings(
  deviceId: string,
): Promise<ResolvedTimeSyncSettings>;
```

`policy` always carries the winning policy ID/name, even when timezone follows the site. Ingest/view use the uncached resolver; delivery uses the 120-second cache. The cached reader checks device visibility before reading Redis, and rejects entries belonging to the device's previous org after an org move.

- [ ] Write the failing test:

```ts
import { beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({
  rows: [] as any[][],
  get: vi.fn(),
  set: vi.fn(),
}));
vi.mock('../../db', () => ({
  db: {
    select: () => {
      const rows = m.rows.shift() ?? [];
      const q: any = {
        then: (yes: any, no: any) => Promise.resolve(rows).then(yes, no),
      };
      for (const key of ['from', 'where', 'limit', 'innerJoin'])
        q[key] = () => q;
      return q;
    },
  },
}));
vi.mock('../redis', () => ({ getRedis: () => ({ get: m.get, set: m.set }) }));
const visibility = vi.hoisted(() => ({ calls: [] as Array<string | null> }));
vi.mock('../configPolicyOwnership', async (orig) => ({
  ...(await orig<typeof import('../configPolicyOwnership')>()),
  withDevicePartnerPolicyVisibility: vi.fn(
    async (executor: any, partnerId: string | null, fn: any) => {
      visibility.calls.push(partnerId);
      return fn(executor);
    },
  ),
}));
import {
  resolveDeviceTimeSyncSettings,
  getDeviceTimeSyncSettings,
} from './settings';
import { TIME_SYNC_DEFAULTS } from '@breeze/shared';
const id = '11111111-1111-4111-8111-111111111111';
const device = {
  orgId: id,
  siteId: id,
  osType: 'windows',
  deviceRole: 'server',
};
const base = {
  policyId: id,
  policyName: 'Time policy',
  roleFilter: null,
  osFilter: null,
  enforceNtp: true,
  ntpServers: ['pool.ntp.org'],
  pollIntervalMinutes: 60,
  timezoneExpected: 'pinned',
  pinnedTimezone: 'UTC',
  timezoneAutoFix: true,
  assignmentPriority: 0,
  assignmentCreatedAt: new Date('2026-01-01T00:00:00Z'),
};
beforeEach(() => {
  m.rows = [];
  visibility.calls = [];
  m.get.mockReset().mockResolvedValue(null);
  m.set.mockReset().mockResolvedValue('OK');
});
it('resolves defaults when no policy exists', async () => {
  m.rows = [[device], [{ partnerId: id }], [], []];
  expect(await resolveDeviceTimeSyncSettings(id)).toEqual({
    orgId: id,
    settings: TIME_SYNC_DEFAULTS,
    policy: null,
  });
});
it('widens policy visibility to the device partner so partner-wide policies resolve for org-scoped callers', async () => {
  const partnerId = '22222222-2222-4222-8222-222222222222';
  m.rows = [[device], [{ partnerId }], [], [{ ...base, level: 'partner' }]];
  const result = await resolveDeviceTimeSyncSettings(id);
  expect(visibility.calls).toEqual([partnerId]);
  expect(result.settings.enforceNtp).toBe(true);
});
it('breaks equal level and priority ties by assignment creation time, not policy id', async () => {
  const older = { ...base, policyId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', level: 'org', pollIntervalMinutes: 30, assignmentCreatedAt: new Date('2026-01-01T00:00:00Z') };
  const newer = { ...base, policyId: '00000000-0000-4000-8000-000000000000', level: 'org', pollIntervalMinutes: 45, assignmentCreatedAt: new Date('2026-02-01T00:00:00Z') };
  m.rows = [[device], [{ partnerId: id }], [], [newer, older]];
  const result = await resolveDeviceTimeSyncSettings(id);
  expect(result.settings.pollIntervalMinutes).toBe(30);
});
it('chooses closest eligible assignment, then smallest priority', async () => {
  m.rows = [
    [device],
    [{ partnerId: id }],
    [],
    [
      { ...base, level: 'partner' },
      {
        ...base,
        level: 'device',
        assignmentPriority: 2,
        pollIntervalMinutes: 120,
      },
      {
        ...base,
        level: 'device',
        assignmentPriority: 1,
        pollIntervalMinutes: 90,
      },
      { ...base, level: 'device', assignmentPriority: 0, osFilter: ['linux'] },
    ],
  ];
  const result = await resolveDeviceTimeSyncSettings(id);
  expect(result.settings.pollIntervalMinutes).toBe(90);
  expect(result.policy).toEqual({
    policyId: id,
    policyName: 'Time policy',
    expected: 'pinned',
    pinnedTimezone: 'UTC',
  });
});
it('caches validated settings for 120 seconds', async () => {
  m.rows = [[device], [device], [{ partnerId: id }], [], []];
  await getDeviceTimeSyncSettings(id);
  expect(m.set).toHaveBeenCalledWith(
    `timesync:settings:device:${id}`,
    JSON.stringify({ orgId: id, settings: TIME_SYNC_DEFAULTS, policy: null }),
    'EX',
    120,
  );
});
it('checks visibility before using cached policy data', async () => {
  m.rows = [[]];
  await expect(getDeviceTimeSyncSettings(id)).rejects.toThrow(
    'Time sync device not visible',
  );
  expect(m.get).not.toHaveBeenCalled();
});
it('ignores malformed cached data but propagates a bad stored policy', async () => {
  m.get.mockResolvedValue('{');
  m.rows = [
    [device],
    [device],
    [{ partnerId: id }],
    [],
    [{ ...base, level: 'device', pollIntervalMinutes: 1 }],
  ];
  await expect(getDeviceTimeSyncSettings(id)).rejects.toThrow();
  expect(m.set).not.toHaveBeenCalled();
});
it('does not return cached settings from a previous org', async () => {
  m.get.mockResolvedValue(
    JSON.stringify({
      orgId: '22222222-2222-4222-8222-222222222222',
      settings: TIME_SYNC_DEFAULTS,
      policy: null,
    }),
  );
  m.rows = [
    [device],
    [device],
    [{ partnerId: id }],
    [],
    [{ ...base, level: 'partner' }],
  ];
  expect((await getDeviceTimeSyncSettings(id)).settings.enforceNtp).toBe(true);
});
```

- [ ] Run: `cd apps/api && npx vitest run src/services/timeSync/settings.test.ts`. Expected FAIL: cannot resolve `./settings`.
- [ ] Implement `settings.ts` in full:

```ts
import { and, eq, inArray, or } from 'drizzle-orm';
import { z } from 'zod';
import {
  timeSyncInlineSettingsSchema,
  type TimeSyncInlineSettings,
} from '@breeze/shared';
import { db } from '../../db';
import {
  configPolicyAssignments,
  configPolicyEffectiveFeatureLinks,
  configPolicyTimeSyncSettings,
  configurationPolicies,
  devices,
  deviceGroupMemberships,
  organizations,
} from '../../db/schema';
import {
  policyOwnershipCondition,
  withDevicePartnerPolicyVisibility,
} from '../configPolicyOwnership';
import {
  buildRoleOsFilterConditions,
  matchesRoleOsFilter,
} from '../featureConfigResolver';
import { getRedis } from '../redis';
import type { ExpectedTimezoneInput } from './expectedTimezone';

export interface ResolvedTimeSyncSettings {
  orgId: string;
  settings: TimeSyncInlineSettings;
  policy: ExpectedTimezoneInput['policy'];
}
const levelPriority: Record<string, number> = {
  partner: 1,
  organization: 2,
  site: 3,
  device_group: 4,
  device: 5,
};
const cacheSchema = z
  .object({
    orgId: z.string().uuid(),
    settings: timeSyncInlineSettingsSchema,
    policy: z
      .object({
        policyId: z.string().uuid(),
        policyName: z.string().nullable(),
        expected: z.enum(['site', 'pinned']),
        pinnedTimezone: z.string().nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();

export async function resolveDeviceTimeSyncSettings(
  deviceId: string,
): Promise<ResolvedTimeSyncSettings> {
  const [device] = await db
    .select({
      orgId: devices.orgId,
      siteId: devices.siteId,
      deviceRole: devices.deviceRole,
      osType: devices.osType,
    })
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);
  if (!device) throw new Error('Time sync device not visible');
  const [org] = await db
    .select({ partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, device.orgId))
    .limit(1);
  const groups = await db
    .select({ groupId: deviceGroupMemberships.groupId })
    .from(deviceGroupMemberships)
    .where(eq(deviceGroupMemberships.deviceId, deviceId));
  const targets = [
    and(
      eq(configPolicyAssignments.level, 'device'),
      eq(configPolicyAssignments.targetId, deviceId),
    ),
    and(
      eq(configPolicyAssignments.level, 'organization'),
      eq(configPolicyAssignments.targetId, device.orgId),
    ),
  ];
  if (device.siteId)
    targets.push(
      and(
        eq(configPolicyAssignments.level, 'site'),
        eq(configPolicyAssignments.targetId, device.siteId),
      ),
    );
  if (org?.partnerId)
    targets.push(
      and(
        eq(configPolicyAssignments.level, 'partner'),
        eq(configPolicyAssignments.targetId, org.partnerId),
      ),
    );
  if (groups.length)
    targets.push(
      and(
        eq(configPolicyAssignments.level, 'device_group'),
        inArray(
          configPolicyAssignments.targetId,
          groups.map((g) => g.groupId),
        ),
      ),
    );
  // Same visibility rule as the hardware-monitoring resolver (routes/agents/helpers.ts):
  // an org-scoped caller (device view, agent ingest) cannot see partner-wide policy rows
  // without widening to the device's own partner. partnerId comes from the org row read
  // above under the caller's RLS context, never from input.
  const rows = await withDevicePartnerPolicyVisibility(
    db,
    org?.partnerId ?? null,
    (executor) =>
      executor
          .select({
            policyId: configurationPolicies.id,
            policyName: configurationPolicies.name,
            level: configPolicyAssignments.level,
            assignmentPriority: configPolicyAssignments.priority,
            assignmentCreatedAt: configPolicyAssignments.createdAt,
            roleFilter: configPolicyAssignments.roleFilter,
            osFilter: configPolicyAssignments.osFilter,
            enforceNtp: configPolicyTimeSyncSettings.enforceNtp,
            ntpServers: configPolicyTimeSyncSettings.ntpServers,
            pollIntervalMinutes: configPolicyTimeSyncSettings.pollIntervalMinutes,
            timezoneExpected: configPolicyTimeSyncSettings.timezoneExpected,
            pinnedTimezone: configPolicyTimeSyncSettings.pinnedTimezone,
            timezoneAutoFix: configPolicyTimeSyncSettings.timezoneAutoFix,
          })
          .from(configPolicyAssignments)
          .innerJoin(
            configurationPolicies,
            eq(configPolicyAssignments.configPolicyId, configurationPolicies.id),
          )
          .innerJoin(
            configPolicyEffectiveFeatureLinks,
            and(
              eq(
                configPolicyEffectiveFeatureLinks.configPolicyId,
                configurationPolicies.id,
              ),
              eq(configPolicyEffectiveFeatureLinks.featureType, 'time_sync'),
            ),
          )
          .innerJoin(
            configPolicyTimeSyncSettings,
            eq(
              configPolicyTimeSyncSettings.featureLinkId,
              configPolicyEffectiveFeatureLinks.id,
            ),
          )
          .where(
            and(
              eq(configurationPolicies.status, 'active'),
              policyOwnershipCondition({
                orgId: device.orgId,
                partnerId: org?.partnerId ?? null,
              }),
              or(...targets),
              ...buildRoleOsFilterConditions({
                deviceRole: device.deviceRole,
                osType: device.osType,
              }),
            ),
    ,
  );
  const eligible = rows.filter((row) => matchesRoleOsFilter(row, device));
  eligible.sort(
    (a, b) =>
      (levelPriority[b.level] ?? 0) - (levelPriority[a.level] ?? 0) ||
      a.assignmentPriority - b.assignmentPriority ||
      // Same tie-break as resolveEffectiveConfig (services/configurationPolicy.ts ~2554).
      a.assignmentCreatedAt.getTime() - b.assignmentCreatedAt.getTime(),
  );
  const winner = eligible[0];
  if (!winner)
    return {
      orgId: device.orgId,
      settings: timeSyncInlineSettingsSchema.parse({}),
      policy: null,
    };
  const settings = timeSyncInlineSettingsSchema.parse({
    enforceNtp: winner.enforceNtp,
    ntpServers: winner.ntpServers,
    pollIntervalMinutes: winner.pollIntervalMinutes,
    timezone: {
      expected: winner.timezoneExpected,
      pinnedTimezone: winner.pinnedTimezone,
      autoFix: winner.timezoneAutoFix,
    },
  });
  return {
    orgId: device.orgId,
    settings,
    policy: {
      policyId: winner.policyId,
      policyName: winner.policyName,
      expected: settings.timezone.expected,
      pinnedTimezone: settings.timezone.pinnedTimezone,
    },
  };
}

export async function getDeviceTimeSyncSettings(
  deviceId: string,
): Promise<ResolvedTimeSyncSettings> {
  const [device] = await db
    .select({ orgId: devices.orgId })
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);
  if (!device) throw new Error('Time sync device not visible');
  const redis = getRedis();
  const key = `timesync:settings:device:${deviceId}`;
  if (redis) {
    try {
      const raw = await redis.get(key);
      if (raw) {
        const cached = cacheSchema.parse(JSON.parse(raw));
        if (cached.orgId === device.orgId) return cached;
      }
    } catch (error) {
      console.warn('[time-sync] settings cache read failed', error);
    }
  }
  const resolved = await resolveDeviceTimeSyncSettings(deviceId);
  if (redis) {
    try {
      await redis.set(key, JSON.stringify(resolved), 'EX', 120);
    } catch (error) {
      console.warn('[time-sync] settings cache write failed', error);
    }
  }
  return resolved;
}
```

This deliberately uses normal parent-chain SELECT visibility, not the older hardware helper's visibility widening. See `configPolicyOwnership.ts:18–36`: own-partner configuration reads no longer need a second system transaction.

Extend the integration fixture to return its policy ID and org ID by changing its final return to:

```ts
return {
  own,
  foreign,
  owner,
  linkId: String(link!.id),
  policyId: String(policy!.id),
  orgId: a.id,
};
```

Append this test, importing `createSite`, `devices` and `resolveDeviceTimeSyncSettings` at the top of that test file:

```ts
it('resolves a partner assignment through an org agent context without escalation', async () => {
  const f = await fixture();
  const site = (await createSite({ orgId: f.orgId }))!;
  const [device] = await getTestDb()
    .insert(devices)
    .values({
      orgId: f.orgId,
      siteId: site.id,
      agentId: randomUUID(),
      hostname: 'time-fixture',
      osType: 'windows',
      osVersion: '1',
      architecture: 'x64',
    })
    .returning();
  await getTestDb().execute(sql`
    INSERT INTO config_policy_assignments(config_policy_id, level, target_id)
    VALUES (${f.policyId}, 'partner', ${f.own.currentPartnerId})`);
  const own = await withDbAccessContext(f.own, () =>
    resolveDeviceTimeSyncSettings(device!.id),
  );
  expect(own.policy?.policyId).toBe(f.policyId);
  await expect(
    withDbAccessContext(f.foreign, () =>
      resolveDeviceTimeSyncSettings(device!.id),
    ),
  ).rejects.toThrow('Time sync device not visible');
});
```

- [ ] Run the settings unit and integration commands. Expected PASS, own-partner defaults resolve in the agent's ordinary org context, foreign device resolution fails before any cache access.
- [ ] Commit:

```bash
git add apps/api/src/services/timeSync/settings.ts apps/api/src/services/timeSync/settings.test.ts apps/api/src/services/timeSync/settings.integration.test.ts
git commit -m "feat(time-sync): resolve inherited settings and policy provenance" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 5: Deliver canonical settings in the final heartbeat response

**Files:** Create `apps/api/src/services/timeSync/configUpdate.ts` and `configUpdate.test.ts`; Modify `apps/api/src/routes/agents/helpers.ts:68,2209`, `heartbeat.ts:37,2273,2281,2290,2304,2358,2367,2374`, `heartbeat.test.ts:180,3754`.

**Interfaces:** Consumes cached settings and `resolveExpectedTimezone(input: ExpectedTimezoneInput): ExpectedTimezone | null`. Produces `buildTimeSyncConfigUpdate(deviceId: string): Promise<TimeSyncConfigUpdate>` in `routes/agents/helpers.ts`; payload property names and fingerprint are index §F.2 verbatim.

- [ ] Write `configUpdate.test.ts`:

```ts
import { createHash } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ settings: vi.fn(), site: null as any }));
vi.mock('./settings', () => ({ getDeviceTimeSyncSettings: m.settings }));
vi.mock('../../db', () => ({
  db: {
    select: () => {
      const q: any = {
        then: (yes: any, no: any) =>
          Promise.resolve(m.site ? [m.site] : []).then(yes, no),
      };
      for (const k of ['from', 'innerJoin', 'where', 'limit']) q[k] = () => q;
      return q;
    },
  },
}));
import {
  buildResolvedTimeSyncConfigUpdate,
  canonicalTimeSyncJson,
} from './configUpdate';
import { TIME_SYNC_DEFAULTS } from '@breeze/shared';
const id = '11111111-1111-4111-8111-111111111111';
beforeEach(() => {
  m.settings.mockReset().mockResolvedValue({
    orgId: id,
    settings: TIME_SYNC_DEFAULTS,
    policy: null,
  });
  m.site = { id, name: 'Site', timezone: 'America/New_York' };
});
it('sends defaults and derives a site zone', async () => {
  const value = await buildResolvedTimeSyncConfigUpdate(id);
  const canonical =
    '{"enforce_ntp":false,"ntp_servers":[],"poll_interval_minutes":60,"timezone":{"auto_fix":false,"expected_windows_id":"Eastern Standard Time"}}';
  expect(value).toEqual({
    enforce_ntp: false,
    ntp_servers: [],
    poll_interval_minutes: 60,
    timezone: { expected_windows_id: 'Eastern Standard Time', auto_fix: false },
    fingerprint: `sha256:${createHash('sha256').update(canonical).digest('hex')}`,
  });
});
it('sorts nested keys without sorting server preference order', () => {
  expect(canonicalTimeSyncJson({ b: { z: 2, a: 1 }, a: ['b', 'a'] })).toBe(
    '{"a":["b","a"],"b":{"a":1,"z":2}}',
  );
});
it('pinned UTC overrides the site and changes the fingerprint', async () => {
  const site = await buildResolvedTimeSyncConfigUpdate(id);
  m.settings.mockResolvedValue({
    orgId: id,
    settings: TIME_SYNC_DEFAULTS,
    policy: {
      policyId: id,
      policyName: 'UTC servers',
      expected: 'pinned',
      pinnedTimezone: 'UTC',
    },
  });
  const pinned = await buildResolvedTimeSyncConfigUpdate(id);
  expect(pinned.timezone.expected_windows_id).toBe('UTC');
  expect(pinned.fingerprint).not.toBe(site.fingerprint);
});
it('returns null expectation for UTC-default site and never hides resolver errors', async () => {
  m.site.timezone = 'UTC';
  expect(
    (await buildResolvedTimeSyncConfigUpdate(id)).timezone.expected_windows_id,
  ).toBeNull();
  m.settings.mockRejectedValue(new Error('policy read failed'));
  await expect(buildResolvedTimeSyncConfigUpdate(id)).rejects.toThrow(
    'policy read failed',
  );
});
```

Add `buildTimeSyncConfigUpdate: vi.fn(),` after `buildHardwareMonitoringConfigUpdate: vi.fn(),` at `heartbeat.test.ts:180`. Beside existing hardware delivery tests at `:3754`, append:

```ts
it('delivers time settings after releasing org scope inside the shared system context', async () => {
  const { buildTimeSyncConfigUpdate } = await import('./helpers');
  const payload = {
    enforce_ntp: false,
    ntp_servers: [],
    poll_interval_minutes: 60,
    timezone: { expected_windows_id: null, auto_fix: false },
    fingerprint: 'sha256:test',
  };
  vi.mocked(buildTimeSyncConfigUpdate).mockImplementationOnce(async () => {
    expect(callOrder).toContain('dbContext:released');
    expect(callOrder.lastIndexOf('systemCtx:enter')).toBeGreaterThan(
      callOrder.lastIndexOf('systemCtx:exit'),
    );
    return payload;
  });
  const res = await buildApp().request('/agents/device-1/heartbeat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(minimalHeartbeatBody),
  });
  expect(res.status).toBe(200);
  expect((await res.json()).configUpdate.time_sync_settings).toEqual(payload);
  expect(buildTimeSyncConfigUpdate).toHaveBeenCalledTimes(1);
});
it('omits time settings on resolver failure while preserving the heartbeat', async () => {
  const { buildTimeSyncConfigUpdate } = await import('./helpers');
  vi.mocked(buildTimeSyncConfigUpdate).mockRejectedValueOnce(
    new Error('policy read failed'),
  );
  const res = await buildApp().request('/agents/device-1/heartbeat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(minimalHeartbeatBody),
  });
  expect(res.status).toBe(200);
  expect((await res.json()).configUpdate ?? {}).not.toHaveProperty(
    'time_sync_settings',
  );
});
```

- [ ] Run: `cd apps/api && npx vitest run src/services/timeSync/configUpdate.test.ts src/routes/agents/heartbeat.test.ts`. Expected FAIL: missing builder and no time-sync delivery.
- [ ] Implement `configUpdate.ts`:

```ts
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { devices, sites } from '../../db/schema';
import { getDeviceTimeSyncSettings } from './settings';
import { resolveExpectedTimezone } from './expectedTimezone';
export interface TimeSyncConfigUpdate {
  enforce_ntp: boolean;
  ntp_servers: string[];
  poll_interval_minutes: number;
  timezone: { expected_windows_id: string | null; auto_fix: boolean };
  fingerprint: string;
}
type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export function canonicalTimeSyncJson(value: JsonValue): string {
  if (Array.isArray(value))
    return `[${value.map(canonicalTimeSyncJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalTimeSyncJson(value[key]!)}`,
      )
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
export async function buildResolvedTimeSyncConfigUpdate(
  deviceId: string,
): Promise<TimeSyncConfigUpdate> {
  const resolved = await getDeviceTimeSyncSettings(deviceId);
  const [site] = await db
    .select({ id: sites.id, name: sites.name, timezone: sites.timezone })
    .from(devices)
    .innerJoin(sites, eq(devices.siteId, sites.id))
    .where(eq(devices.id, deviceId))
    .limit(1);
  const expected = resolveExpectedTimezone({
    site: site ?? null,
    policy: resolved.policy,
  });
  const body = {
    enforce_ntp: resolved.settings.enforceNtp,
    ntp_servers: resolved.settings.ntpServers,
    poll_interval_minutes: resolved.settings.pollIntervalMinutes,
    timezone: {
      expected_windows_id: expected?.windowsId ?? null,
      auto_fix: resolved.settings.timezone.autoFix,
    },
  };
  return {
    ...body,
    fingerprint: `sha256:${createHash('sha256').update(canonicalTimeSyncJson(body)).digest('hex')}`,
  };
}
```

At `helpers.ts:68`, add:

```ts
import {
  buildResolvedTimeSyncConfigUpdate,
  type TimeSyncConfigUpdate,
} from '../../services/timeSync/configUpdate';
```

After the existing `buildHardwareMonitoringConfigUpdate` closing brace at `helpers.ts:2209`, insert:

```ts
export async function buildTimeSyncConfigUpdate(
  deviceId: string,
): Promise<TimeSyncConfigUpdate> {
  return buildResolvedTimeSyncConfigUpdate(deviceId);
}
```

Heartbeat replacements are deliberately local to the existing shared system-context block. Add `buildTimeSyncConfigUpdate` beside `buildHardwareMonitoringConfigUpdate` in the helpers import. After the `hardwareMonitoringSettings` type member in `policyConfigs`' result type, insert:

```ts
  timeSyncSettings: Awaited<
    ReturnType<typeof buildTimeSyncConfigUpdate>
  > | null;
```

In the initial object, append after `hardwareMonitoringSettings: null,`:

```ts
  timeSyncSettings: null,
```

After the hardware resolver's local declaration, insert:

```ts
let timeSyncSettings: Awaited<
  ReturnType<typeof buildTimeSyncConfigUpdate>
> | null = null;
```

After the existing hardware resolver try/catch at `heartbeat.ts:2303–2308`, insert:

```ts
try {
  timeSyncSettings = await buildTimeSyncConfigUpdate(scoped.deviceId);
} catch (err) {
  console.error(
    `[agents] failed to build time sync config update for ${agentId}:`,
    err,
  );
  captureException(err);
}
```

Replace the exact return at `:2358` and destructuring at `:2367`:

```ts
return {
  eventLogSettings,
  monitoringSettings,
  pamSettings,
  patchSourceSettings,
  warrantySettings,
  hardwareMonitoringSettings,
  timeSyncSettings,
};
```

```ts
const {
  eventLogSettings,
  monitoringSettings,
  pamSettings,
  patchSourceSettings,
  warrantySettings,
  hardwareMonitoringSettings,
  timeSyncSettings,
} = policyConfigs;
```

After the hardware `policyConfigUpdate` branch `:2373–2375`, insert:

```ts
if (timeSyncSettings) {
  policyConfigUpdate.time_sync_settings = timeSyncSettings;
}
```

The final existing spread `...policyConfigUpdate` at `:2400` delivers it. Do not touch the earlier `mergedConfigUpdate` at `:1905`, open a connection in the helper, or add another `withSystemDbAccessContext`. Existing outer setup/commit-failure handling leaves the initialized null values intact.

- [ ] Repeat the test command; expected PASS. Also run `rg -n 'time_sync_settings|buildTimeSyncConfigUpdate|withSystemDbAccessContext' apps/api/src/routes/agents/heartbeat.ts` and confirm the new call appears only in the existing shared context, after the org context's release.
- [ ] Commit:

```bash
git add apps/api/src/services/timeSync/configUpdate.ts apps/api/src/services/timeSync/configUpdate.test.ts apps/api/src/routes/agents/helpers.ts apps/api/src/routes/agents/heartbeat.ts apps/api/src/routes/agents/heartbeat.test.ts
git commit -m "feat(time-sync): deliver canonical policy settings in heartbeat" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 6: Extend findings, accepted ingest, audit, and the current view

**Files:** Create `apps/api/src/services/timeSync/enforcement.ts`, `enforcement.test.ts`, `management.integration.test.ts`; dependency modifications `findings.ts`, `ingest.ts`, `view.ts`, `view.test.ts`, `fleet.ts`, `fleet.test.ts`, `expectedTimezone.test.ts` (index §§C.2–C.6/F.3; no current line anchors).

**Interfaces:** Consumes `TimeSyncEnforcementState`, `TimeStatusSnapshot`, `TimeFindingsContext.enforcementSettings` and `ResolvedTimeSyncSettings`. Produces `managementFindings(report, policyManagedValues, settings): TimeSyncFinding[]`, `auditEnforcement(args): Promise<void>` and `readEnforcement(value: unknown): TimeSyncEnforcementState | null`. Public ingest/view signatures stay index §§C.5/C.6 verbatim.

**Audit writer evidence and choice:** `writeAuditEventAsync` at `services/auditEvents.ts:62,80,102` derives the system actor and delegates to `createAuditLogAsync`; `services/auditService.ts:70–101,127–134` commits on a separate system connection and swallows failure into a retry queue. Calling that writer inside ingest cannot make the observation and audit atomic. Use the existing transactional system-actor insertion pattern at `services/topology/publish.ts:358`: `await tx.insert(auditLogs).values({ actorType: 'system', ... })`. The new helper below is called on ingest's ambient transaction, with the row lock held; failure rolls back both status and audit. It imports the existing sanitizer and system actor ID, not the separate-connection writer. The database audit seal trigger still handles checksum chaining (`db/schema/audit.ts:39–43`).

- [ ] Write `enforcement.test.ts`:

```ts
import { beforeEach, expect, it, vi } from 'vitest';
import type { TimeSyncEnforcementState } from '@breeze/shared';
const m = vi.hoisted(() => ({ insert: vi.fn(), existing: [] as unknown[] }));
vi.mock('../../db', () => ({
  db: {
    select: () => {
      const q: any = {
        then: (yes: any) => Promise.resolve(m.existing).then(yes),
      };
      for (const k of ['from', 'where', 'limit']) q[k] = () => q;
      return q;
    },
    insert: () => ({ values: m.insert }),
  },
}));
import {
  managementFindings,
  auditEnforcement,
  readEnforcement,
} from './enforcement';
const id = '11111111-1111-4111-8111-111111111111';
const result = {
  resultId: id,
  fingerprint: 'sha256:test',
  at: '2026-09-28T12:00:00Z',
  outcome: 'failed' as const,
  reason: 'exec_failed' as const,
  before: { type: 'NoSync' },
  after: { type: 'NTP' },
  error: 'exit 1',
};
const on = { enforceNtp: true, timezoneAutoFix: true };
beforeEach(() => {
  m.insert.mockReset().mockResolvedValue(undefined);
  m.existing = [];
});
it.each([
  ['failed', 'exec_failed', 'policy_not_applied'],
  ['failed', 'readback_mismatch', 'policy_not_applied'],
  ['skipped', 'role_unknown', 'policy_not_applied'],
  ['skipped', 'conflict_gpo', 'policy_conflict_gpo'],
  ['ok', 'applied', null],
  ['ok', 'already_compliant', null],
] as const)('maps NTP %s/%s', (outcome, reason, code) => {
  const report = { ntp: { ...result, outcome, reason }, timezone: null };
  expect(managementFindings(report, ['Type'], on).map((f) => f.code)).toEqual(
    code ? [code] : [],
  );
});
it('suppresses stale failures after enforcement is disabled', () => {
  expect(
    managementFindings({ ntp: result, timezone: result }, [], {
      enforceNtp: false,
      timezoneAutoFix: false,
    }),
  ).toEqual([]);
});
it('emits the failure code once when both kinds fail, preferring NTP detail', () => {
  const findings = managementFindings(
    { ntp: result, timezone: result },
    [],
    on,
  );
  expect(findings).toHaveLength(1);
  expect(findings[0]).toMatchObject({
    code: 'policy_not_applied',
    detail: { kind: 'ntp', reason: 'exec_failed', error: 'exit 1' },
  });
});
it('timezone skipped outcomes never imply failed enforcement', () => {
  const report = {
    ntp: null,
    timezone: {
      ...result,
      outcome: 'skipped' as const,
      reason: 'auto_timezone_on' as const,
    },
  };
  expect(managementFindings(report, [], on)).toEqual([]);
});
it('writes one system device audit for each changed kind', async () => {
  await auditEnforcement({
    deviceId: id,
    orgId: id,
    previous: null,
    report: { ntp: result, timezone: null },
  });
  expect(m.insert).toHaveBeenCalledWith(
    expect.objectContaining({
      actorType: 'system',
      action: 'time_sync.enforced',
      resourceType: 'device',
      resourceId: id,
      orgId: id,
      details: expect.objectContaining({
        kind: 'ntp',
        resultId: id,
        before: result.before,
        after: result.after,
      }),
    }),
  );
});
it('does not audit a repeated latest result or an already audited older result', async () => {
  const report: TimeSyncEnforcementState = { ntp: result, timezone: null };
  await auditEnforcement({ deviceId: id, orgId: id, previous: report, report });
  expect(m.insert).not.toHaveBeenCalled();
  m.existing = [{ id }];
  await auditEnforcement({ deviceId: id, orgId: id, previous: null, report });
  expect(m.insert).not.toHaveBeenCalled();
});
it('propagates an audit write failure so ingest cannot advance past it', async () => {
  m.insert.mockRejectedValue(new Error('audit unavailable'));
  await expect(
    auditEnforcement({
      deviceId: id,
      orgId: id,
      previous: null,
      report: { ntp: result, timezone: null },
    }),
  ).rejects.toThrow('audit unavailable');
});
it('treats migrated empty objects and null as no report', () => {
  expect(readEnforcement({})).toBeNull();
  expect(readEnforcement(null)).toBeNull();
  expect(readEnforcement({ ntp: result, timezone: null })).toEqual({
    ntp: result,
    timezone: null,
  });
});
```

Append these complete cases to dependency `expectedTimezone.test.ts` using its existing imports:

```ts
it('allows pinned UTC even though site UTC is unset', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  expect(
    resolveExpectedTimezone({
      site: { id, name: 'Site', timezone: 'America/New_York' },
      policy: {
        policyId: id,
        policyName: 'UTC servers',
        expected: 'pinned',
        pinnedTimezone: 'UTC',
      },
    }),
  ).toEqual({
    iana: 'UTC',
    windowsId: 'UTC',
    source: 'policy',
    sourceId: id,
    sourceName: 'UTC servers',
  });
});
it('keeps a site-following policy on the site path', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const site = { id, name: 'Site', timezone: 'America/New_York' };
  expect(
    resolveExpectedTimezone({
      site,
      policy: {
        policyId: id,
        policyName: 'Site followers',
        expected: 'site',
        pinnedTimezone: null,
      },
    }),
  ).toEqual(resolveExpectedTimezone({ site }));
});
```

- [ ] Run: `cd apps/api && npx vitest run src/services/timeSync/enforcement.test.ts src/services/timeSync/expectedTimezone.test.ts`. Expected FAIL: missing enforcement helper; pinned policy behavior fails only if W01a omitted its contracted optional input.
- [ ] Implement `enforcement.ts`:

```ts
import { and, eq, sql } from 'drizzle-orm';
import {
  TIME_SYNC_FINDING_SEVERITY,
  timeSyncEnforcementReportSchema,
  type TimeSyncEnforcementState,
} from '@breeze/shared';
import { db } from '../../db';
import { auditLogs } from '../../db/schema';
import { ANONYMOUS_ACTOR_ID } from '../auditEvents';
import { sanitizeAuditPayload } from '../auditPayloadSanitizer';
import type { TimeFindingsContext, TimeSyncFinding } from './findings';

export function readEnforcement(
  value: unknown,
): TimeSyncEnforcementState | null {
  const parsed = timeSyncEnforcementReportSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
export function managementFindings(
  report: TimeSyncEnforcementState | null,
  policyManagedValues: string[],
  settings: TimeFindingsContext['enforcementSettings'],
): TimeSyncFinding[] {
  if (!report || !settings) return [];
  const findings: TimeSyncFinding[] = [];
  const ntp = report.ntp;
  const timezone = report.timezone;
  const ntpFailed =
    settings.enforceNtp &&
    ntp &&
    (ntp.outcome === 'failed' ||
      (ntp.outcome === 'skipped' && ntp.reason === 'role_unknown'));
  const timezoneFailed =
    settings.timezoneAutoFix && timezone?.outcome === 'failed';
  const failed = ntpFailed ? ntp : timezoneFailed ? timezone : null;
  if (failed)
    findings.push({
      code: 'policy_not_applied',
      severity: TIME_SYNC_FINDING_SEVERITY.policy_not_applied,
      detail: {
        kind: ntpFailed ? 'ntp' : 'timezone',
        reason: failed.reason,
        error: failed.error,
      },
    });
  if (settings.enforceNtp && ntp?.reason === 'conflict_gpo') {
    findings.push({
      code: 'policy_conflict_gpo',
      severity: TIME_SYNC_FINDING_SEVERITY.policy_conflict_gpo,
      detail: { values: policyManagedValues.join(',') },
    });
  }
  return findings;
}

/** Called only inside accepted ingest, while its per-device status lock is held. */
export async function auditEnforcement(args: {
  deviceId: string;
  orgId: string;
  previous: TimeSyncEnforcementState | null;
  report: TimeSyncEnforcementState | null;
}): Promise<void> {
  for (const kind of ['ntp', 'timezone'] as const) {
    const result = args.report?.[kind];
    if (!result || result.resultId === args.previous?.[kind]?.resultId)
      continue;
    const [alreadyAudited] = await db
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.orgId, args.orgId),
          eq(auditLogs.resourceId, args.deviceId),
          eq(auditLogs.action, 'time_sync.enforced'),
          sql`${auditLogs.details}->>'kind' = ${kind}`,
          sql`${auditLogs.details}->>'resultId' = ${result.resultId}`,
        ),
      )
      .limit(1);
    if (alreadyAudited) continue;
    await db.insert(auditLogs).values({
      orgId: args.orgId,
      actorType: 'system',
      actorId: ANONYMOUS_ACTOR_ID,
      action: 'time_sync.enforced',
      resourceType: 'device',
      resourceId: args.deviceId,
      initiatedBy: 'agent',
      result: result.outcome === 'failed' ? 'failure' : 'success',
      details: sanitizeAuditPayload({ kind, ...result }) as Record<
        string,
        unknown
      >,
    });
  }
}
```

The index requires at-most-one finding per code. If both kinds fail, the NTP detail wins deterministically; both full reports remain visible. Result IDs are deduplicated under the ingest lock, including history replay while the audit record remains retained. No claim is made that deduplication survives independent audit-retention deletion plus an agent replaying an old ID; the index only prescribes comparison with the stored latest report.

Dependency integration anchors below use the current corrected W01a Task 4 findings, Task 5 `buildTimeStatusRow`/ingest and Task 6 view, plus W02 Task 3 streak/daily extension. Names and types from those earlier tasks are authoritative. Confirm the merged base before executing; plans are not evidence of a merge.

1. In `findings.ts`, import `managementFindings` from `./enforcement`. Its context already has the contracted optional settings member. Replace this projected anchor:

```ts
const findings = TIME_SYNC_FINDING_CODES.flatMap((code) =>
  found.has(code) ? [found.get(code)!] : [],
);
```

with:

```ts
for (const finding of managementFindings(
  snapshot.enforcement,
  snapshot.config.policyManagedValues,
  ctx.enforcementSettings,
)) {
  found.set(finding.code, finding);
}
const findings = TIME_SYNC_FINDING_CODES.flatMap((code) =>
  found.has(code) ? [found.get(code)!] : [],
);
```

The existing final `healthForFindings(findings, status.method)` then sees management failures, while its map guarantees one ordered entry per code.

2. In `ingest.ts`, import:

```ts
import { resolveDeviceTimeSyncSettings } from './settings';
import { auditEnforcement, readEnforcement } from './enforcement';
```

Replace the projected expected/findings block:

```ts
const expected = resolveExpectedTimezone({ site: site ?? null });
const resolved = resolveTimeFindings(args.snapshot, {
  now: args.receivedAt,
  expectedTimezone: expected,
  previousEventMarks: previous?.eventMarks ?? {},
});
```

with:

```ts
const resolvedTimeSettings = await resolveDeviceTimeSyncSettings(args.deviceId);
const expected = resolveExpectedTimezone({
  site: site ?? null,
  policy: resolvedTimeSettings.policy,
});
const effectiveEnforcement =
  args.snapshot.enforcement ?? readEnforcement(previous?.enforcement);
const effectiveArgs = {
  ...args,
  snapshot: { ...args.snapshot, enforcement: effectiveEnforcement },
};
const resolved = resolveTimeFindings(effectiveArgs.snapshot, {
  now: args.receivedAt,
  expectedTimezone: expected,
  previousEventMarks: previous?.eventMarks ?? {},
  enforcementSettings: {
    enforceNtp: resolvedTimeSettings.settings.enforceNtp,
    timezoneAutoFix: resolvedTimeSettings.settings.timezone.autoFix,
  },
});
```

The W01a projection's `buildTimeStatusRow` returns a complete `StatusRow`, so adding the new required column also requires adding it to that builder. Replace the projected row-builder anchor `eventMarks: resolved.eventMarks,` with:

```ts
  eventMarks: resolved.eventMarks,
  enforcement: s.enforcement ?? {},
```

Replace `const row = buildTimeStatusRow(args, previous, expected, resolved);` with `const row = buildTimeStatusRow(effectiveArgs, previous, expected, resolved);`. Compute the effective report once after stale rejection and pass that same snapshot to findings and the row builder; a null report retains the previous report and cannot advance a false recovery streak. Direct row-builder fixtures still use their supplied snapshot; there is no second fallback inside the builder.

That row is used by both `.values(row)` and `.onConflictDoUpdate({ target: deviceTimeStatus.deviceId, set: row })`; no separate insert/update mapping is left incomplete. Preserve W02's `findingStreaks` property and `upsertDaily` call. Immediately before the existing `return { accepted: true, health: resolved.health };`, after the daily write, insert:

```ts
await auditEnforcement({
  deviceId: args.deviceId,
  orgId: args.orgId,
  previous: readEnforcement(previous?.enforcement),
  report: effectiveEnforcement,
});
```

W01a's projected parent-device `FOR UPDATE` precedes the status-row lock, serializes the first-ever snapshot and matches device deletion lock order. Keep it. The stale-sequence return remains before policy resolution, streaks, daily writes and audit.

3. In `view.ts`, add:

```ts
import { resolveDeviceTimeSyncSettings } from './settings';
import { managementFindings, readEnforcement } from './enforcement';
```

Replace this projected block:

```ts
const expected = resolveExpectedTimezone({ site: site ?? null });
const findings: TimeSyncFinding[] = TIME_SYNC_FINDING_CODES.filter(
  (code) => code !== 'timezone_mismatch' && row.findings.includes(code),
).map((code) => ({
  code,
  severity: TIME_SYNC_FINDING_SEVERITY[code],
  detail: row.findingDetails[code] ?? {},
}));
```

with:

```ts
const resolvedTimeSettings = await resolveDeviceTimeSyncSettings(deviceId);
const expected = resolveExpectedTimezone({
  site: site ?? null,
  policy: resolvedTimeSettings.policy,
});
const enforcement = readEnforcement(row.enforcement);
const findings: TimeSyncFinding[] = TIME_SYNC_FINDING_CODES.filter(
  (code) =>
    code !== 'timezone_mismatch' &&
    code !== 'policy_not_applied' &&
    code !== 'policy_conflict_gpo' &&
    row.findings.includes(code),
).map((code) => ({
  code,
  severity: TIME_SYNC_FINDING_SEVERITY[code],
  detail: row.findingDetails[code] ?? {},
}));
findings.push(
  ...managementFindings(enforcement, row.policyManagedValues, {
    enforceNtp: resolvedTimeSettings.settings.enforceNtp,
    timezoneAutoFix: resolvedTimeSettings.settings.timezone.autoFix,
  }),
);
```

Keep the following timezone-mismatch recomputation, final sort and `healthForFindings` unchanged. Replace only the reported return's `enforcement: null,` (following `recentEvents: row.recentEvents,`) with:

```ts
  enforcement,
```

Keep the unreported/unsupported branch's `enforcement: null`. Its existing `expectedUnsetReason` ternary already clears the unset reason for a winning pin. The policy pin is resolved on every view request; no cached settings are used there.

The existing dependency `view.test.ts` mocks the device/status/site query sequence. Add this hoisted settings mock beside its existing DB mock so adding the policy read does not silently consume fixture rows intended for another query. The real resolver remains covered by Tasks 4 and 6 integration tests:

```ts
vi.mock('./settings', () => ({
  resolveDeviceTimeSyncSettings: vi.fn(async () => ({
    orgId: '11111111-1111-4111-8111-111111111111',
    settings: {
      enforceNtp: false,
      ntpServers: [],
      pollIntervalMinutes: 60,
      timezone: { expected: 'site', pinnedTimezone: null, autoFix: false },
    },
    policy: null,
  })),
}));
```

The W01a projection's row fixture calls its exported `buildTimeStatusRow`; the new enforcement property is therefore populated automatically by the Task 6 row-builder edit, rather than adding an incomplete cast to the tests.

4. Replace W02's `fleet.ts` with this complete implementation. The SQL candidate scope continues to intersect org/site/device authorization and static filters. Every candidate is hydrated through the same uncached, policy-aware `getDeviceTimeStatusView` used for device display; only then are finding/health filters, totals and page selection applied. The display DTO is the very view used to select that row. Domain context remains independent of display filters, but never independent of authorization. Remove the obsolete exported `fleetFindingCodes`/`fleetHealth` SQL expressions; W02 has no production consumers outside this module. Both AI list results and current/history CSV population use `listFleetTimeStatus` and inherit these semantics without new entry points.

```ts
import { z } from 'zod';
import { and, asc, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import {
  TIME_SYNC_DOMAIN_ROLES,
  TIME_SYNC_FINDING_CODES,
  TIME_SYNC_HEALTH,
} from '@breeze/shared';
import { db } from '../../db';
import {
  devices,
  organizations,
  sites,
  deviceTimeStatus,
} from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { deviceScopeCondition, siteScopeCondition } from '../aiToolsSiteScope';
import { getDeviceTimeStatusView, type DeviceTimeStatusView } from './view';
export const fleetTimeFiltersSchema = z
  .object({
    health: z.enum(TIME_SYNC_HEALTH).optional(),
    finding: z.enum(TIME_SYNC_FINDING_CODES).optional(),
    role: z.enum(TIME_SYNC_DOMAIN_ROLES).optional(),
    orgId: z.string().uuid().optional(),
    siteId: z.string().uuid().optional(),
    deviceId: z.string().uuid().optional(),
    domain: z.string().min(1).max(255).optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();
export type FleetTimeFilters = z.input<typeof fleetTimeFiltersSchema>;
export interface FleetTimeRow {
  deviceId: string;
  hostname: string;
  orgId: string;
  orgName: string;
  siteId: string | null;
  siteName: string | null;
  view: DeviceTimeStatusView;
}
export interface FleetTimeDomain {
  orgId: string;
  domainDns: string;
  pdcEnrolled: boolean;
  pdcExpected: boolean;
  pdc: FleetTimeRow | null;
}
export interface FleetTimeResult {
  data: FleetTimeRow[];
  total: number;
  page: number;
  limit: number;
  domains: FleetTimeDomain[];
}
export class FleetTimeForbidden extends Error {
  constructor() {
    super('Access to this organization denied');
  }
}
const t = deviceTimeStatus;
const projection = {
  deviceId: devices.id,
  hostname: devices.hostname,
  orgId: devices.orgId,
  orgName: organizations.name,
  siteId: devices.siteId,
  siteName: sites.name,
};
const pdcRank = sql<number>`CASE WHEN ${t.domainRole}='forest_root_pdc_emulator' THEN 0 WHEN ${t.domainRole}='pdc_emulator' THEN 1 ELSE 2 END`;
// Policy-dependent findings and health are evaluated from the canonical device view.
// SQL limits only authorization and policy-independent candidate selection.
export function fleetScope(
  filters: FleetTimeFilters,
  auth: AuthContext,
  displayFilters = true,
): SQL | undefined {
  if (filters.orgId && !auth.canAccessOrg(filters.orgId))
    throw new FleetTimeForbidden();
  return and(
    auth.orgCondition(devices.orgId),
    siteScopeCondition(auth, devices.siteId),
    deviceScopeCondition(auth, devices.id),
    eq(devices.osType, 'windows'),
    eq(devices.isEphemeral, false),
    filters.orgId ? eq(devices.orgId, filters.orgId) : undefined,
    filters.deviceId ? eq(devices.id, filters.deviceId) : undefined,
    displayFilters && filters.siteId
      ? eq(devices.siteId, filters.siteId)
      : undefined,
    displayFilters && filters.role ? eq(t.domainRole, filters.role) : undefined,
    displayFilters && filters.domain
      ? eq(t.domainDns, filters.domain)
      : undefined,
  );
}
export function fleetRowsQuery() {
  return db
    .select(projection)
    .from(devices)
    .innerJoin(organizations, eq(organizations.id, devices.orgId))
    .leftJoin(sites, eq(sites.id, devices.siteId))
    .leftJoin(t, eq(t.deviceId, devices.id));
}
async function hydrate(
  rows: Array<Omit<FleetTimeRow, 'view'>>,
): Promise<FleetTimeRow[]> {
  const result: FleetTimeRow[] = [];
  for (const row of rows) {
    const view = await getDeviceTimeStatusView(row.deviceId);
    if (view) result.push({ ...row, view });
  }
  return result;
}
export async function listFleetTimeStatus(
  filters: FleetTimeFilters,
  auth: AuthContext,
): Promise<FleetTimeResult> {
  const q = fleetTimeFiltersSchema.parse(filters),
    where = fleetScope(q, auth);
  const data: FleetTimeRow[] = [];
  let total = 0;
  const start = (q.page - 1) * q.limit;
  const batchSize = 200;
  for (let offset = 0; ; offset += batchSize) {
    const candidates = await fleetRowsQuery()
      .where(where)
      .orderBy(
        asc(devices.orgId),
        asc(t.domainDns),
        pdcRank,
        asc(devices.hostname),
        asc(devices.id),
      )
      .limit(batchSize)
      .offset(offset);
    for (const row of await hydrate(candidates)) {
      if (q.health && row.view.health !== q.health) continue;
      if (
        q.finding &&
        !row.view.findings.some((finding) => finding.code === q.finding)
      )
        continue;
      if (total >= start && data.length < q.limit) data.push(row);
      total += 1;
    }
    if (candidates.length < batchSize) break;
  }
  const domains: FleetTimeDomain[] = [];
  const keys = [
    ...new Map(
      data
        .filter((r) => r.view.domain?.domainDns)
        .map((r) => [
          `${r.orgId}:${r.view.domain!.domainDns}`,
          { orgId: r.orgId, domainDns: r.view.domain!.domainDns! },
        ]),
    ).values(),
  ];
  if (keys.length) {
    const domainRows = await db
      .select({
        orgId: devices.orgId,
        domainDns: t.domainDns,
        pdcExpected: sql<boolean>`bool_or(${t.pdcName} IS NOT NULL)`,
        pdcId: sql<
          string | null
        >`(array_agg(${devices.id} ORDER BY ${pdcRank},${devices.id}) FILTER (WHERE ${t.domainRole} IN ('forest_root_pdc_emulator','pdc_emulator')))[1]`,
      })
      .from(devices)
      .innerJoin(t, eq(t.deviceId, devices.id))
      .where(
        and(
          fleetScope(q, auth, false),
          or(
            ...keys.map((k) =>
              and(eq(devices.orgId, k.orgId), eq(t.domainDns, k.domainDns)),
            ),
          ),
        ),
      )
      .groupBy(devices.orgId, t.domainDns);
    const ids = domainRows.flatMap((r) => (r.pdcId ? [r.pdcId] : []));
    const pdcs = ids.length
      ? await hydrate(
          await fleetRowsQuery().where(
            and(fleetScope(q, auth, false), inArray(devices.id, ids)),
          ),
        )
      : [];
    for (const row of domainRows) {
      const pdc = pdcs.find((p) => p.deviceId === row.pdcId) ?? null;
      domains.push({
        orgId: row.orgId,
        domainDns: row.domainDns!,
        pdcExpected: row.pdcExpected,
        pdcEnrolled: pdc !== null,
        pdc,
      });
    }
  }
  return { data, total, page: q.page, limit: q.limit, domains };
}
```

This uses bounded 200-row candidate batches and retains only the requested page. Exact live totals require resolving every statically eligible candidate; reads are sequential on the ambient request connection (no system-context escalation or parallel pool acquisition). This is an O(visible candidates) read path, including each export page. Keep this cost explicit; any later batching optimization must reuse the same policy resolver and preserve these parity tests. Do not restore a site-only SQL prefilter as an optimization.

- [ ] Modify the existing `fleet.test.ts` rather than appending incompatible SQL-count fixtures. Retain its auth/schema cases, but update its query fixtures and add canonical-view filtering cases as follows. The full replacement keeps domain grouping, off-page PDC, missing PDC and empty-fleet coverage:

```ts
import { beforeEach, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { AuthContext } from '../../middleware/auth';
const m = vi.hoisted(() => ({
  select: vi.fn(),
  view: vi.fn(),
  queue: [] as unknown[][],
}));
vi.mock('../../db', () => ({ db: { select: m.select } }));
vi.mock('./view', () => ({ getDeviceTimeStatusView: m.view }));
import {
  fleetScope,
  fleetTimeFiltersSchema,
  listFleetTimeStatus,
  FleetTimeForbidden,
} from './fleet';
const org = '11111111-1111-4111-8111-111111111111',
  site = '22222222-2222-4222-8222-222222222222';
const device = '33333333-3333-4333-8333-333333333333',
  pdc = '44444444-4444-4444-8444-444444444444';
function auth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    scope: 'organization',
    orgId: org,
    accessibleOrgIds: [org],
    orgCondition: (column) => eq(column, org),
    canAccessOrg: (id) => id === org,
    ...overrides,
  } as AuthContext;
}
const header = (id: string) => ({
  deviceId: id,
  hostname: id === pdc ? 'PDC' : 'Member',
  orgId: org,
  orgName: 'Customer',
  siteId: site,
  siteName: 'Main',
});
const view = (id: string) => ({
  deviceId: id,
  state: 'reported',
  stale: false,
  receivedAt: '2026-09-28T12:00:00Z',
  collectedAt: '2026-09-28T12:00:00Z',
  health: 'healthy',
  findings: [],
  config: null,
  status: null,
  domain: {
    joinType: 'on_prem_ad',
    role: id === pdc ? 'pdc_emulator' : 'member',
    domainDns: 'example.com',
    forestDns: 'example.com',
    pdcName: 'PDC',
  },
  timezone: null,
  recentEvents: [],
  enforcement: null,
});
beforeEach(() => {
  m.queue = [];
  m.select.mockReset();
  m.view.mockReset().mockImplementation(async (id: string) => view(id));
  m.select.mockImplementation(() => {
    const rows = m.queue.shift() ?? [];
    const chain: any = {
      then: (resolve: (value: unknown) => unknown) =>
        Promise.resolve(rows).then(resolve),
    };
    for (const key of [
      'from',
      'innerJoin',
      'leftJoin',
      'where',
      'orderBy',
      'limit',
      'offset',
      'groupBy',
    ])
      chain[key] = vi.fn(() => chain);
    return chain;
  });
});
it('intersects organization, site, device and explicit filters', () => {
  const query = new PgDialect().sqlToQuery(
    fleetScope(
      { siteId: site, deviceId: device },
      auth({ allowedSiteIds: [site], allowedDeviceIds: [device] }),
    )!,
  );
  expect(query.params).toContain(org);
  expect(query.params.filter((p) => p === site)).toHaveLength(2);
  expect(query.params.filter((p) => p === device)).toHaveLength(2);
  expect(query.sql).toContain('"devices"."org_id"');
  expect(
    new PgDialect().sqlToQuery(fleetScope({}, auth({ allowedSiteIds: [] }))!)
      .sql,
  ).toContain('false');
  expect(
    new PgDialect().sqlToQuery(fleetScope({}, auth({ allowedDeviceIds: [] }))!)
      .sql,
  ).toContain('false');
  expect(() => fleetScope({ orgId: pdc }, auth())).toThrow(FleetTimeForbidden);
});
it('validates vocabulary and bounded pages', () => {
  for (const q of [
    { health: 'bad' },
    { finding: 'invented' },
    { role: 'administrator' },
    { page: 0 },
    { limit: 101 },
    { orgId: 'invalid' },
  ])
    expect(fleetTimeFiltersSchema.safeParse(q).success).toBe(false);
  expect(fleetTimeFiltersSchema.parse({})).toMatchObject({
    page: 1,
    limit: 50,
  });
});
it('finds a PDC beyond the filtered page', async () => {
  m.view.mockImplementation(async (id: string) => ({
    ...view(id),
    findings: [{ code: 'sync_stale', severity: 'warning', detail: {} }],
  }));
  m.queue.push(
    [header(site), header(device)],
    [{ orgId: org, domainDns: 'example.com', pdcExpected: true, pdcId: pdc }],
    [header(pdc)],
  );
  expect(
    await listFleetTimeStatus(
      { finding: 'sync_stale', role: 'member', page: 2, limit: 1 },
      auth(),
    ),
  ).toMatchObject({
    total: 2,
    page: 2,
    limit: 1,
    data: [{ deviceId: device }],
    domains: [
      {
        orgId: org,
        domainDns: 'example.com',
        pdcExpected: true,
        pdcEnrolled: true,
        pdc: { deviceId: pdc },
      },
    ],
  });
  const query = new PgDialect().sqlToQuery(
    m.select.mock.results[1]!.value.where.mock.calls[0][0],
  );
  expect(query.params).toContain(org);
  expect(query.params).not.toContain('sync_stale');
  expect(query.params).not.toContain('member');
  expect(m.view.mock.calls).toEqual([[site], [device], [pdc]]);
});
it('keeps equal DNS names in different organizations separate', async () => {
  const other = pdc;
  m.queue.push(
    [header(device), { ...header(site), orgId: other }],
    [
      { orgId: org, domainDns: 'example.com', pdcExpected: true, pdcId: null },
      {
        orgId: other,
        domainDns: 'example.com',
        pdcExpected: true,
        pdcId: null,
      },
    ],
  );
  const result = await listFleetTimeStatus(
    {},
    auth({
      scope: 'partner',
      orgCondition: () => undefined,
      canAccessOrg: () => true,
    }),
  );
  expect(result.domains.map((d) => d.orgId)).toEqual([org, other]);
});
it('reports an expected missing PDC without inventing a device', async () => {
  m.queue.push(
    [header(device)],
    [{ orgId: org, domainDns: 'example.com', pdcExpected: true, pdcId: null }],
  );
  expect((await listFleetTimeStatus({}, auth())).domains).toEqual([
    {
      orgId: org,
      domainDns: 'example.com',
      pdcExpected: true,
      pdcEnrolled: false,
      pdc: null,
    },
  ]);
});
it('filters and counts canonical policy findings before selecting a page', async () => {
  m.queue.push([header(site), header(device), header(pdc)]);
  m.view.mockImplementation(async (id: string) => ({
    ...view(id),
    domain: null,
    health: id === site ? 'healthy' : 'warning',
    findings:
      id === site
        ? []
        : [{ code: 'policy_not_applied', severity: 'warning', detail: {} }],
  }));
  const result = await listFleetTimeStatus(
    { finding: 'policy_not_applied', health: 'warning', page: 2, limit: 1 },
    auth(),
  );
  expect(result.total).toBe(2);
  expect(result.data.map((row) => row.deviceId)).toEqual([pdc]);
  expect(m.view.mock.calls).toEqual([[site], [device], [pdc]]);
  const query = new PgDialect().sqlToQuery(
    m.select.mock.results[0]!.value.where.mock.calls[0][0],
  );
  expect(query.params).not.toContain('policy_not_applied');
  expect(query.params).not.toContain('warning');
});
it('re-reads changed policy findings on every fleet request', async () => {
  for (const findings of [
    [{ code: 'timezone_mismatch', severity: 'info', detail: {} }],
    [],
    [{ code: 'policy_not_applied', severity: 'warning', detail: {} }],
    [],
  ]) {
    m.queue.push([header(device)]);
    m.view.mockResolvedValue({ ...view(device), domain: null, findings });
    const result = await listFleetTimeStatus(
      {
        finding:
          findings[0]?.code === 'policy_not_applied'
            ? 'policy_not_applied'
            : 'timezone_mismatch',
      },
      auth(),
    );
    expect(result.total).toBe(findings.length);
    expect(result.data).toHaveLength(findings.length);
  }
});
it('returns an empty report with no visible devices', async () => {
  m.queue.push([]);
  expect(await listFleetTimeStatus({}, auth({ allowedSiteIds: [] }))).toEqual({
    data: [],
    total: 0,
    page: 1,
    limit: 50,
    domains: [],
  });
  expect(m.view).not.toHaveBeenCalled();
});
```

- [ ] Create the following real-DB management regression test. It uses only named contract services and existing fixture helpers, without dependence on private W01a test factories:

```ts
import '../../__tests__/integration/setup';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { AuthContext } from '../../middleware/auth';
import { listFleetTimeStatus } from './fleet';
import { exportCurrentTimeCsv, exportHistoryTimeCsv } from './exports';
import {
  db,
  withDbAccessContext,
  withDbTransaction,
  type DbAccessContext,
} from '../../db';
import { devices, deviceTimeStatus } from '../../db/schema';
import {
  createPartner,
  createOrganization,
  createSite,
} from '../../__tests__/integration/db-utils';
import { getTestDb } from '../../__tests__/integration/setup';
import { timeStatusSnapshotSchema } from '@breeze/shared';
import { ingestTimeStatusSnapshot } from './ingest';
import { getDeviceTimeStatusView } from './view';

it('accepts reports, audits once, rolls back atomically, and re-resolves policy timezone', async () => {
  const partner = (await createPartner())!;
  const org = (await createOrganization({ partnerId: partner.id }))!;
  const site = (await createSite({ orgId: org.id }))!;
  await getTestDb().execute(
    sql`UPDATE sites SET timezone='America/Chicago' WHERE id=${site.id}`,
  );
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
    })
    .returning();
  const ctx: DbAccessContext = {
    scope: 'organization',
    orgId: org.id,
    accessibleOrgIds: [org.id],
    accessiblePartnerIds: [],
    currentPartnerId: partner.id,
  };
  const [policy] = await getTestDb().execute(
    sql`INSERT INTO configuration_policies(org_id,name) VALUES(${org.id},'Time policy') RETURNING id`,
  );
  const [link] = await getTestDb().execute(
    sql`INSERT INTO config_policy_feature_links(config_policy_id,feature_type) VALUES(${String(policy!.id)},'time_sync') RETURNING id`,
  );
  await getTestDb()
    .execute(sql`INSERT INTO config_policy_time_sync_settings(feature_link_id,enforce_ntp,ntp_servers,timezone_expected,pinned_timezone)
    VALUES(${String(link!.id)},true,ARRAY['pool.ntp.org'],'pinned','UTC')`);
  await getTestDb().execute(
    sql`INSERT INTO config_policy_assignments(config_policy_id,level,target_id) VALUES(${String(policy!.id)},'device',${device!.id})`,
  );
  const report = {
    resultId: randomUUID(),
    fingerprint: 'sha256:test',
    at: '2026-09-28T12:00:00Z',
    outcome: 'failed',
    reason: 'readback_mismatch',
    before: { type: 'NoSync' },
    after: { type: 'NoSync' },
    error: 'readback failed',
  };
  const snapshot = timeStatusSnapshotSchema.parse({
    schemaVersion: 1,
    sequence: 1,
    collectedAt: '2026-09-28T12:00:00Z',
    config: {
      type: 'NTP',
      ntpServer: 'pool.ntp.org',
      specialPollIntervalSeconds: 3600,
      policyManaged: false,
      policyManagedValues: [],
      serviceState: 'running',
      serviceStartType: 'auto',
      hostTimeProviderEnabled: null,
    },
    status: {
      method: 'events',
      source: 'pool.ntp.org',
      sourceKind: 'ntp_peer',
      lastSuccessfulSyncAt: '2026-09-28T12:00:00Z',
      lastSyncError: null,
      stratum: null,
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
      windowsId: 'Eastern Standard Time',
      biasMinutes: 300,
      dynamicDstDisabled: false,
      autoUpdate: 'off',
    },
    events: [],
    enforcement: { ntp: report, timezone: null },
  });
  const ingest = (sequence: number) =>
    ingestTimeStatusSnapshot({
      deviceId: device!.id,
      orgId: org.id,
      agentVersion: null,
      snapshot: { ...snapshot, sequence },
      receivedAt: new Date('2026-09-28T12:00:00Z'),
    });
  await withDbAccessContext(ctx, () => ingest(1));
  await Promise.all([
    withDbAccessContext(ctx, () => ingest(2)),
    withDbAccessContext(ctx, () => ingest(3)),
  ]);
  const audits = () =>
    db.execute(
      sql`SELECT * FROM audit_logs WHERE resource_id=${device!.id} AND action='time_sync.enforced'`,
    );
  expect(await withDbAccessContext(ctx, audits)).toHaveLength(1);
  expect((await withDbAccessContext(ctx, () => ingest(1))).accepted).toBe(
    false,
  );
  await expect(
    withDbAccessContext(ctx, () =>
      withDbTransaction(async () => {
        await ingestTimeStatusSnapshot({
          deviceId: device!.id,
          orgId: org.id,
          agentVersion: null,
          snapshot: {
            ...snapshot,
            sequence: 4,
            enforcement: {
              ntp: { ...snapshot.enforcement!.ntp!, resultId: randomUUID() },
              timezone: null,
            },
          },
          receivedAt: new Date('2026-09-28T12:01:00Z'),
        });
        throw new Error('rollback proof');
      }),
    ),
  ).rejects.toThrow('rollback proof');
  expect(await withDbAccessContext(ctx, audits)).toHaveLength(1);
  const [stored] = await withDbAccessContext(ctx, () =>
    db
      .select()
      .from(deviceTimeStatus)
      .where(eq(deviceTimeStatus.deviceId, device!.id)),
  );
  expect(Number(stored!.lastSequence)).toBe(3);
  // A null report retains the last failed result for storage AND ingest reduction.
  await withDbAccessContext(ctx, () =>
    ingestTimeStatusSnapshot({
      deviceId: device!.id,
      orgId: org.id,
      agentVersion: null,
      snapshot: { ...snapshot, sequence: 4, enforcement: null },
      receivedAt: new Date('2026-09-28T12:02:00Z'),
    }),
  );
  const [retained] = await withDbAccessContext(ctx, () =>
    db
      .select()
      .from(deviceTimeStatus)
      .where(eq(deviceTimeStatus.deviceId, device!.id)),
  );
  expect(retained!.enforcement).toEqual(stored!.enforcement);
  expect(retained!.findings).toContain('policy_not_applied');
  expect(retained!.findingStreaks.policy_not_applied).toEqual({
    present: stored!.findingStreaks.policy_not_applied!.present + 1,
    absent: 0,
  });
  expect(await withDbAccessContext(ctx, audits)).toHaveLength(1);
  const view = await withDbAccessContext(ctx, () =>
    getDeviceTimeStatusView(device!.id),
  );
  expect(view!.enforcement?.ntp?.resultId).toBe(report.resultId);
  expect(view!.timezone?.expected).toMatchObject({
    source: 'policy',
    windowsId: 'UTC',
  });
  expect(view!.findings.map((f) => f.code)).toContain('policy_not_applied');
  const auth = {
    scope: 'organization',
    orgId: org.id,
    accessibleOrgIds: [org.id],
    orgCondition: (column) => eq(column, org.id),
    canAccessOrg: (id: string) => id === org.id,
  } as AuthContext;
  const assertParity = async (mismatch: boolean, failure: boolean) =>
    withDbAccessContext(ctx, async () => {
      const current = (await getDeviceTimeStatusView(device!.id))!;
      const fleet = await listFleetTimeStatus({ deviceId: device!.id }, auth);
      expect(fleet.total).toBe(1);
      expect(fleet.data[0]!.view).toEqual(current);
      for (const [finding, present] of [
        ['timezone_mismatch', mismatch],
        ['policy_not_applied', failure],
      ] as const) {
        const filters = { deviceId: device!.id, finding, limit: 1 };
        const filtered = await listFleetTimeStatus(filters, auth);
        expect(filtered.total).toBe(present ? 1 : 0);
        expect(filtered.data.map((row) => row.deviceId)).toEqual(
          present ? [device!.id] : [],
        );
        const second = await listFleetTimeStatus({ ...filters, page: 2 }, auth);
        expect(second.total).toBe(filtered.total);
        expect(second.data).toEqual([]);
        let currentCsv = '';
        for await (const chunk of exportCurrentTimeCsv(filters, auth))
          currentCsv += chunk;
        expect(currentCsv.includes(device!.id)).toBe(present);
        const day = new Date().toISOString().slice(0, 10);
        let historyCsv = '';
        for await (const chunk of exportHistoryTimeCsv(
          filters,
          { from: day, to: day },
          auth,
        ))
          historyCsv += chunk;
        expect(historyCsv.includes(device!.id)).toBe(present);
      }
      expect(
        (
          await listFleetTimeStatus(
            { deviceId: device!.id, health: current.health },
            auth,
          )
        ).total,
      ).toBe(1);
    });
  await assertParity(true, true); // UTC pin beats the Central site; retained failure stays active.
  await getTestDb().execute(
    sql`UPDATE config_policy_time_sync_settings SET pinned_timezone='America/New_York' WHERE feature_link_id=${String(link!.id)}`,
  );
  await assertParity(false, true); // Pin change takes effect without another snapshot or cache expiry.
  await getTestDb().execute(
    sql`UPDATE config_policy_time_sync_settings SET enforce_ntp=false WHERE feature_link_id=${String(link!.id)}`,
  );
  await assertParity(false, false); // Stored failure must disappear from live views AND filter/count paths.
  const disabled = await withDbAccessContext(ctx, () =>
    getDeviceTimeStatusView(device!.id),
  );
  expect(disabled!.enforcement?.ntp?.resultId).toBe(report.resultId);
  await getTestDb().execute(
    sql`DELETE FROM config_policy_assignments WHERE config_policy_id=${String(policy!.id)}`,
  );
  await assertParity(true, false); // Removing policy restores the Central site expectation immediately.
  const removed = await withDbAccessContext(ctx, () =>
    getDeviceTimeStatusView(device!.id),
  );
  expect(removed!.timezone?.expected).toMatchObject({
    source: 'site',
    windowsId: 'Central Standard Time',
  });
});
```

- [ ] Run `cd apps/api && npx vitest run src/services/timeSync/enforcement.test.ts src/services/timeSync/expectedTimezone.test.ts src/services/timeSync/findings.test.ts` and `cd apps/api && npx vitest run --config vitest.integration.config.ts src/services/timeSync/management.integration.test.ts`. Expected PASS, including unchanged W01a event-activity review cases and W02 streak/daily behavior. Run `cd apps/api && npx vitest run src/services/timeSync/view.test.ts src/services/timeSync/fleet.test.ts src/services/timeSync/exports.test.ts` and `cd apps/api && npx vitest run --config vitest.integration.config.ts src/services/timeSync/ingest.integration.test.ts src/services/timeSync/ingest.w02.integration.test.ts src/services/timeSync/fleet.integration.test.ts`; these filenames are confirmed in the sibling projections. Expected PASS; do not substitute a full-suite run. Run `cd apps/api && npx vitest run src/services/aiToolsDevice.timeSyncFleet.test.ts src/services/aiToolsDevice.timeSyncFleet.registry.test.ts`; the corrected W02 names keep W01a device-tool coverage intact and assert that the AI tool delegates filtering to this fleet service.
- [ ] Commit:

```bash
git add apps/api/src/services/timeSync/fleet.ts apps/api/src/services/timeSync/fleet.test.ts apps/api/src/services/timeSync/enforcement.ts apps/api/src/services/timeSync/enforcement.test.ts apps/api/src/services/timeSync/findings.ts apps/api/src/services/timeSync/ingest.ts apps/api/src/services/timeSync/view.ts apps/api/src/services/timeSync/view.test.ts apps/api/src/services/timeSync/expectedTimezone.test.ts apps/api/src/services/timeSync/management.integration.test.ts
git commit -m "feat(time-sync): persist and audit enforcement results" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 7: Provision the version-5 management monitor

**Files:** Modify `apps/api/src/services/monitors/builtInMonitors.ts:40,50–68,176` (post-W02 values differ; preserve all v4 entries); Modify/Test `builtInMonitors.timeSync.test.ts` in the same directory (created by W02; preserve its exact v4 expectations); Modify/Test `builtInMonitors.test.ts:12–41` and `apps/api/src/__tests__/integration/builtInMonitors.integration.test.ts:145,179–198,248` (W02 updates these anchors first).

**Interfaces:** Consumes W02 `time_sync` monitor-kind condition `{ findings: TimeSyncFindingCode[]; consecutiveSnapshots: number }`. Produces exactly one additional `BuiltInMonitorDefault` with `sinceVersion: 5`; keeps `defaultsToProvision(storedVersion: number | null)` at `builtInMonitors.ts:184` unchanged.

- [ ] Replace the existing W02 `builtInMonitors.timeSync.test.ts` with this complete superset. Keep one import block; retain exact v4 assertions against `sinceVersion === 4`, and add v5/current-version cases:

```ts
import { expect, it } from 'vitest';
import {
  BUILT_IN_MONITOR_DEFAULTS,
  BUILT_IN_MONITORS_VERSION,
  defaultsToProvision,
} from './builtInMonitors';
import { getMonitorKindSpec } from './kinds';
it('adds exactly the three approved v4 defaults using their original version gate', () => {
  expect(BUILT_IN_MONITORS_VERSION).toBe(5);
  expect(
    BUILT_IN_MONITOR_DEFAULTS.filter((d) => d.sinceVersion === 4).map((d) => [
      d.key,
      d.name,
      d.condition,
      d.severity,
      d.sinceVersion,
    ]),
  ).toEqual([
    [
      'time_source_problem',
      'Time source problem',
      {
        findings: [
          'pdc_no_external_source',
          'source_local_clock',
          'dc_vm_host_sync',
          'ntp_server_unresolvable',
          'ntp_peer_unreachable',
          'domain_source_unavailable',
          'member_not_on_hierarchy',
          'correction_refused',
        ],
        consecutiveSnapshots: 2,
      },
      'high',
      4,
    ],
    [
      'time_sync_stale',
      'Time sync stale or disabled',
      { findings: ['sync_stale', 'sync_disabled'], consecutiveSnapshots: 2 },
      'medium',
      4,
    ],
    [
      'timezone_mismatch',
      'Timezone mismatch',
      { findings: ['timezone_mismatch'], consecutiveSnapshots: 2 },
      'low',
      4,
    ],
  ]);
  expect(defaultsToProvision(5)).toEqual([]);
});
it('adds only the management monitor to a v4 partner and never resurrects a deleted v5 default', () => {
  expect(BUILT_IN_MONITORS_VERSION).toBe(5);
  expect(defaultsToProvision(4)).toEqual([
    {
      key: 'time_policy_not_applied',
      name: 'Time policy not applied',
      description:
        'Alerts after two snapshots reporting failed time-policy enforcement.',
      kind: 'time_sync',
      condition: { findings: ['policy_not_applied'], consecutiveSnapshots: 2 },
      severity: 'low',
      cooldownMinutes: 60,
      sinceVersion: 5,
    },
  ]);
  expect(defaultsToProvision(5)).toEqual([]);
});
it('preserves the v4 time defaults and validates every condition', () => {
  expect(
    BUILT_IN_MONITOR_DEFAULTS.filter((x) => x.sinceVersion === 4).map(
      (x) => x.key,
    ),
  ).toEqual(['time_source_problem', 'time_sync_stale', 'timezone_mismatch']);
  expect(
    BUILT_IN_MONITOR_DEFAULTS.filter((x) => x.sinceVersion < 4),
  ).toHaveLength(8);
  for (const monitor of BUILT_IN_MONITOR_DEFAULTS) {
    expect(
      getMonitorKindSpec(monitor.kind).conditionSchema.safeParse(
        monitor.condition,
      ).success,
    ).toBe(true);
  }
});
```

Append this additional failing test to the existing real-DB built-ins suite; its fixture helpers and imports are already present at `:15–34,107–198`:

```ts
it('upgrades v4 with only the time-policy monitor and leaves deleted defaults deleted', async () => {
  const partner = await newPartner();
  await withDbAccessContext(SYSTEM_CTX, () =>
    ensureBuiltInMonitorsForPartner(partner.id),
  );
  await withDbAccessContext(SYSTEM_CTX, async () => {
    await db
      .delete(monitorDefinitions)
      .where(
        and(
          eq(monitorDefinitions.partnerId, partner.id),
          inArray(monitorDefinitions.builtinKey, [
            'time_policy_not_applied',
            'cpu_high',
          ]),
        ),
      );
    await db
      .update(partners)
      .set({
        settings: sql`jsonb_set(${partners.settings}, '{builtInMonitors,version}', '4'::jsonb)`,
      })
      .where(eq(partners.id, partner.id));
  });
  const upgraded = await withDbAccessContext(SYSTEM_CTX, () =>
    ensureBuiltInMonitorsForPartner(partner.id),
  );
  expect(upgraded.monitorIds).toHaveLength(1);
  const rows = await builtInsFor(partner.id);
  expect(rows.some((row) => row.builtinKey === 'cpu_high')).toBe(false);
  expect(
    rows.filter((row) => row.builtinKey === 'time_policy_not_applied'),
  ).toHaveLength(1);
  expect(await marker(partner.id)).toMatchObject({ version: 5 });
  expect(
    await withDbAccessContext(SYSTEM_CTX, () =>
      db
        .select()
        .from(configurationPolicies)
        .where(eq(configurationPolicies.partnerId, partner.id)),
    ),
  ).toEqual([]);
});
```

- [ ] Run: `cd apps/api && npx vitest run src/services/monitors/builtInMonitors.timeSync.test.ts`. Expected FAIL: version is 4 and no v5 default, on the correct merged base. The researched checkout still says 3 at line 40; do not skip W02 by changing 3 directly to 5.
- [ ] Replace the post-W02 anchor `export const BUILT_IN_MONITORS_VERSION = 4;` with:

```ts
export const BUILT_IN_MONITORS_VERSION = 5;
```

Add `'time_policy_not_applied'` to the `BuiltInMonitorDefault.key` union, retaining W02's three keys. Append this entry to `BUILT_IN_MONITOR_DEFAULTS` before its closing `];` (current pre-W02 array closes at `:177`):

```ts
  {
    key: 'time_policy_not_applied',
    name: 'Time policy not applied',
    description:
      'Alerts after two snapshots reporting failed time-policy enforcement.',
    kind: 'time_sync',
    condition: { findings: ['policy_not_applied'], consecutiveSnapshots: 2 },
    severity: 'low',
    cooldownMinutes: 60,
    sinceVersion: 5,
  },
```

Cooldown 60 minutes follows existing built-in defaults; it is not a new wire-contract field. W02 owns widening the condition union to the time-sync kind. Provisioning code at `:235` already validates conditions and leaves monitors unattached; no policy link is created here.

- [ ] In `builtInMonitors.test.ts`, replace only the first `describe` (W02 titles it `version 4 time and historical hardware defaults`) with this complete block. Retain the existing imports and every `buildCompiledTemplate category via alertCategory` test below it. This avoids whitespace-sensitive replacement scripts while preserving exact v3 settings and all historical gates:

```ts
describe('version 5 time and historical hardware defaults', () => {
  const keys = [
    'raid_array_degraded',
    'physical_disk_failed',
    'cache_battery_problem',
    'hardware_collector_failing',
  ];

  const timeKeys = [
    'time_source_problem',
    'time_sync_stale',
    'timezone_mismatch',
    'time_policy_not_applied',
  ];

  it('has twelve valid defaults with preserved version gates', () => {
    expect(BUILT_IN_MONITORS_VERSION).toBe(5);
    expect(BUILT_IN_MONITOR_DEFAULTS).toHaveLength(12);
    expect(defaultsToProvision(2).map((d) => d.key)).toEqual([
      ...keys,
      ...timeKeys,
    ]);
    for (const d of BUILT_IN_MONITOR_DEFAULTS) {
      expect(
        getMonitorKindSpec(d.kind).conditionSchema.safeParse(d.condition)
          .success,
      ).toBe(true);
    }
  });

  it('preserves historical version gates', () => {
    expect(defaultsToProvision(null)).toHaveLength(12);
    expect(defaultsToProvision(1).map((d) => d.key)).toEqual([
      'patch_compliance_low',
      ...keys,
      ...timeKeys,
    ]);
    expect(defaultsToProvision(3).map((d) => d.key)).toEqual(timeKeys);
    expect(defaultsToProvision(4).map((d) => d.key)).toEqual([
      'time_policy_not_applied',
    ]);
    expect(defaultsToProvision(5)).toEqual([]);
    expect(
      BUILT_IN_MONITOR_DEFAULTS.filter((d) => d.sinceVersion === 1).map(
        (d) => d.key,
      ),
    ).toEqual(['cpu_high', 'memory_high', 'disk_full']);
    expect(
      BUILT_IN_MONITOR_DEFAULTS.find((d) => d.key === 'patch_compliance_low')
        ?.condition,
    ).toEqual({
      operator: 'lt',
      value: 80,
    });
  });

  it('matches the four approved settings exactly', () => {
    expect(
      defaultsToProvision(2)
        .filter((d) => d.sinceVersion === 3)
        .map((d) => [
          d.key,
          d.name,
          d.condition,
          d.severity,
          d.cooldownMinutes,
          d.sinceVersion,
        ]),
    ).toEqual([
      [
        'raid_array_degraded',
        'RAID array degraded or failed',
        {
          componentTypes: ['virtual_disk', 'controller'],
          minHealth: 'critical',
          includePredictiveFailure: false,
          consecutiveSnapshots: 2,
        },
        'critical',
        60,
        3,
      ],
      [
        'physical_disk_failed',
        'Physical disk failed or predicted to fail',
        {
          componentTypes: ['physical_disk'],
          minHealth: 'critical',
          includePredictiveFailure: true,
          consecutiveSnapshots: 2,
        },
        'high',
        60,
        3,
      ],
      [
        'cache_battery_problem',
        'Controller cache battery problem',
        {
          componentTypes: ['cache_battery'],
          minHealth: 'warning',
          includePredictiveFailure: false,
          consecutiveSnapshots: 3,
        },
        'medium',
        240,
        3,
      ],
      [
        'hardware_collector_failing',
        'Hardware monitoring tool failing',
        {
          componentTypes: ['collector'],
          minHealth: 'warning',
          includePredictiveFailure: false,
          consecutiveSnapshots: 3,
        },
        'low',
        1440,
        3,
      ],
    ]);
  });
});
```

- [ ] In `apps/api/src/__tests__/integration/builtInMonitors.integration.test.ts`, replace the inherited version-2 and version-3 upgrade tests by title with the two complete tests below. Both start by seeding the current version, then remove **all** post-fixture-version defaults, including the management default, before lowering the marker. Retain all existing imports, fixture helpers, ownership tests and the new v4 upgrade test above. Change current-version marker assertions elsewhere in the file from `version: 4` to `version: 5` (including compact `{version:4}` forms), but keep deliberate fixture markers 2, 3 and 4 unchanged. Update the old comment above the v2 test to say it adds eight later defaults and advances to version 5.

```ts
it('upgrades version 2 without restoring deleted defaults or overwriting edits', async () => {
  const partner = await newPartner();
  await withDbAccessContext(SYSTEM_CTX, () =>
    ensureBuiltInMonitorsForPartner(partner.id),
  );
  const hardwareKeys = [
    'raid_array_degraded',
    'physical_disk_failed',
    'cache_battery_problem',
    'hardware_collector_failing',
  ];
  const timeKeys = [
    'time_source_problem',
    'time_sync_stale',
    'timezone_mismatch',
    'time_policy_not_applied',
  ];
  await withDbAccessContext(SYSTEM_CTX, async () => {
    await db
      .delete(monitorDefinitions)
      .where(
        and(
          eq(monitorDefinitions.partnerId, partner.id),
          inArray(monitorDefinitions.builtinKey, [
            ...hardwareKeys,
            ...timeKeys,
            'cpu_high',
          ]),
        ),
      );
    await db
      .update(monitorDefinitions)
      .set({ enabled: false, cooldownMinutes: 321 })
      .where(
        and(
          eq(monitorDefinitions.partnerId, partner.id),
          eq(monitorDefinitions.builtinKey, 'memory_high'),
        ),
      );
    await db
      .update(partners)
      .set({
        settings: sql`jsonb_build_object('builtInMonitors', jsonb_build_object(
        'version', 2, 'provisionedAt', '2026-01-01T00:00:00.000Z'))`,
      })
      .where(eq(partners.id, partner.id));
  });
  const before = await builtInsFor(partner.id);
  const result = await withDbAccessContext(SYSTEM_CTX, () =>
    ensureBuiltInMonitorsForPartner(partner.id),
  );
  expect(result.monitorIds).toHaveLength(8);
  const after = await builtInsFor(partner.id);
  expect(
    after.filter((row) => hardwareKeys.includes(row.builtinKey!)),
  ).toHaveLength(4);
  expect(
    after.filter((row) => timeKeys.includes(row.builtinKey!)),
  ).toHaveLength(4);
  expect(after.some((row) => row.builtinKey === 'cpu_high')).toBe(false);
  for (const row of before)
    expect(after.find((next) => next.id === row.id)).toEqual(row);
  expect(await marker(partner.id)).toMatchObject({
    version: 5,
    provisionedAt: '2026-01-01T00:00:00.000Z',
  });
  expect(
    await withDbAccessContext(SYSTEM_CTX, () =>
      ensureBuiltInMonitorsForPartner(partner.id),
    ),
  ).toEqual({ provisioned: false, monitorIds: [] });
});

it('upgrades version 3 once without restoring deleted defaults or overwriting edits', async () => {
  const partner = await newPartner();
  await withDbAccessContext(SYSTEM_CTX, () =>
    ensureBuiltInMonitorsForPartner(partner.id),
  );
  const timeKeys = [
    'time_source_problem',
    'time_sync_stale',
    'timezone_mismatch',
    'time_policy_not_applied',
  ];
  await withDbAccessContext(SYSTEM_CTX, async () => {
    await db
      .delete(monitorDefinitions)
      .where(
        and(
          eq(monitorDefinitions.partnerId, partner.id),
          inArray(monitorDefinitions.builtinKey, [
            ...timeKeys,
            'physical_disk_failed',
          ]),
        ),
      );
    await db
      .update(monitorDefinitions)
      .set({ enabled: false, cooldownMinutes: 321 })
      .where(
        and(
          eq(monitorDefinitions.partnerId, partner.id),
          eq(monitorDefinitions.builtinKey, 'raid_array_degraded'),
        ),
      );
    await db
      .update(partners)
      .set({
        settings: sql`jsonb_build_object('builtInMonitors',jsonb_build_object('version',3,'provisionedAt','2026-01-01T00:00:00.000Z'))`,
      })
      .where(eq(partners.id, partner.id));
  });
  const before = await builtInsFor(partner.id);
  const result = await withDbAccessContext(SYSTEM_CTX, () =>
    ensureBuiltInMonitorsForPartner(partner.id),
  );
  expect(result.monitorIds).toHaveLength(4);
  const after = await builtInsFor(partner.id);
  expect(after.filter((r) => timeKeys.includes(r.builtinKey!))).toHaveLength(4);
  expect(after.some((r) => r.builtinKey === 'physical_disk_failed')).toBe(
    false,
  );
  for (const row of before)
    expect(after.find((r) => r.id === row.id)).toEqual(row);
  expect(await marker(partner.id)).toMatchObject({
    version: 5,
    provisionedAt: '2026-01-01T00:00:00.000Z',
  });
  expect(
    await withDbAccessContext(SYSTEM_CTX, () =>
      ensureBuiltInMonitorsForPartner(partner.id),
    ),
  ).toEqual({ provisioned: false, monitorIds: [] });
});
```

Run: `cd apps/api && npx vitest run src/services/monitors/builtInMonitors.timeSync.test.ts src/services/monitors/builtInMonitors.test.ts`. Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/builtInMonitors.integration.test.ts`. Expected PASS; the old version-2 upgrade still preserves edited/deleted rows and now adds the eight post-v2 defaults. The inherited v3 test adds four time defaults and both inherited markers advance to 5; the explicit v4 test adds only one. All fixtures preserve edited/deleted historical rows and the original provisionedAt.

- [ ] Commit:

```bash
git add apps/api/src/services/monitors/builtInMonitors.ts apps/api/src/services/monitors/builtInMonitors.timeSync.test.ts apps/api/src/services/monitors/builtInMonitors.test.ts apps/api/src/__tests__/integration/builtInMonitors.integration.test.ts
git commit -m "feat(time-sync): add unattached management monitor v5" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 8: Register commands and enforce their payload and delivery contracts

**Files:** Modify `apps/api/src/services/commandTypes.ts:140–142`, `commandOfflinePolicy.ts:12,53,302–323`, `commandTimeouts.ts:207`, `partnerTrust.ts:174`, `apps/api/src/routes/devices/schemas.ts:280–286`; Create/Test `apps/api/src/services/timeSync/commands.test.ts`; Modify/Test `apps/api/src/routes/devices/commands.test.ts:227`.

**Interfaces:** Consumes `isKnownWindowsZone(windowsId: string): boolean` (index §C.1). Produces command constants `TIME_RESYNC`, `TIME_SET_TIMEZONE`, `TIME_APPLY_POLICY`, schema-validated payloads, `defaultOfflinePolicy(type) = { kind: 'queue', deliverWithinMs: 3_600_000 }`, and `getCommandTimeoutMs(type) = 60_000`.

Registration sweep evidence: `collect_boot_performance` appears at commandTypes:141, offlinePolicy:125, timeouts:68, partnerTrust:72. `bootMetrics.ts:123` and `aiToolsPerformance.ts:909` are command producers, not allowlists; do not invent equivalent AI tools. `aiRemoteToolsPolicy.contract.test.ts:136` is a tool-exemption test, not this route's registration. `agentEditionCompat.ts:144–147` lists only binary-update commands, so time commands do not belong there. Shared `validators/index.ts:414–420` validates command **results** and has no command-type enum. Agent constants/handlers/privilege lists belong to W03b. The generic single-device schema needs explicit registration even though it does not contain `collect_boot_performance`.

- [ ] Write the failing `commands.test.ts`:

```ts
import { afterEach, expect, it, vi } from 'vitest';
import { CommandTypes } from '../commandTypes';
import {
  defaultOfflinePolicy,
  deliverByFor,
  EXPLICITLY_CLASSIFIED_COMMAND_TYPES,
} from '../commandOfflinePolicy';
import { getCommandTimeoutMs } from '../commandTimeouts';
import { GATED_COMMAND_TYPES } from '../partnerTrust';
import { createCommandSchema } from '../../routes/devices/schemas';
const commands = [
  ['TIME_RESYNC', 'time_resync'],
  ['TIME_SET_TIMEZONE', 'time_set_timezone'],
  ['TIME_APPLY_POLICY', 'time_apply_policy'],
] as const;
afterEach(() => vi.unstubAllEnvs());
it.each(commands)(
  '%s has a fixed hour to deliver and a minute to execute',
  (key, type) => {
    expect((CommandTypes as Record<string, string>)[key]).toBe(type);
    expect(GATED_COMMAND_TYPES).toContain(type);
    expect(EXPLICITLY_CLASSIFIED_COMMAND_TYPES.has(type)).toBe(true);
    vi.stubEnv('DEVICE_COMMAND_QUEUE_SHORT_TTL_HOURS', '24');
    const policy = defaultOfflinePolicy(type);
    expect(policy).toEqual({ kind: 'queue', deliverWithinMs: 3_600_000 });
    expect(
      deliverByFor(policy, new Date('2026-09-28T12:00:00Z'))?.toISOString(),
    ).toBe('2026-09-28T13:00:00.000Z');
    expect(getCommandTimeoutMs(type)).toBe(60_000);
  },
);
it.each(['time_resync', 'time_apply_policy'])(
  '%s accepts only empty payloads',
  (type) => {
    expect(createCommandSchema.safeParse({ type }).success).toBe(true);
    expect(createCommandSchema.safeParse({ type, payload: {} }).success).toBe(
      true,
    );
    for (const payload of [{ command: 'anything' }, [], 'anything', null])
      expect(createCommandSchema.safeParse({ type, payload }).success).toBe(
        false,
      );
  },
);
it('accepts a known Windows ID', () => {
  expect(
    createCommandSchema.safeParse({
      type: 'time_set_timezone',
      payload: { windowsId: 'Eastern Standard Time' },
    }).success,
  ).toBe(true);
});
it.each([
  undefined,
  {},
  { windowsId: 'America/New_York' },
  { windowsId: 'Unknown Standard Time' },
  { windowsId: 'UTC /s invalid' },
  { windowsId: 'UTC', extra: true },
  { windowsId: 42 },
])('rejects timezone payload %#', (payload) => {
  expect(
    createCommandSchema.safeParse({ type: 'time_set_timezone', payload })
      .success,
  ).toBe(false);
});
it('preserves other command payloads', () => {
  expect(
    createCommandSchema.parse({ type: 'reboot', payload: { delay: 30 } }),
  ).toEqual({ type: 'reboot', payload: { delay: 30 } });
});
```

Append to the existing outer `describe` in `routes/devices/commands.test.ts`, after its setup ending at `:227`:

```ts
describe('time management command admission', () => {
  const deviceId = '11111111-1111-4111-8111-111111111111';
  const cases = [
    ['time_resync', {}],
    ['time_set_timezone', { windowsId: 'Eastern Standard Time' }],
    ['time_apply_policy', {}],
  ] as const;
  const request = (type: string, payload: unknown) =>
    app.request(`/devices/${deviceId}/commands`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer token',
      },
      body: JSON.stringify({ type, payload }),
    });
  it.each(cases)(
    'queues %s only through the execute gate and dispatcher',
    async (type, payload) => {
      vi.mocked(getDeviceWithOrgCheck).mockResolvedValueOnce({
        id: deviceId,
        orgId: 'org-123',
        status: 'online',
      } as never);
      expect((await request(type, payload)).status).toBe(201);
      expect(assertDeviceExecuteAllowedMock).toHaveBeenCalledWith(
        deviceId,
        type,
        'user-123',
      );
      expect(dispatchDeviceCommandMock).toHaveBeenCalledWith({
        deviceId,
        type,
        payload,
        userId: 'user-123',
      });
      const { writeRouteAudit } = await import('../../services/auditEvents');
      expect(writeRouteAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'device.command.queue',
          resourceType: 'device_command',
        }),
      );
    },
  );
  it.each(cases)(
    'denies a foreign-org device for %s',
    async (type, payload) => {
      vi.mocked(getDeviceWithOrgCheck).mockResolvedValueOnce(null as never);
      expect((await request(type, payload)).status).toBe(404);
      expect(dispatchDeviceCommandMock).not.toHaveBeenCalled();
    },
  );
  it.each(cases)('requires MFA for %s', async (type, payload) => {
    authState.mfa = false;
    expect((await request(type, payload)).status).toBe(403);
    expect(dispatchDeviceCommandMock).not.toHaveBeenCalled();
  });
  it.each(cases)('propagates a trust denial for %s', async (type, payload) => {
    vi.mocked(getDeviceWithOrgCheck).mockResolvedValueOnce({
      id: deviceId,
      orgId: 'org-123',
      status: 'online',
    } as never);
    assertDeviceExecuteAllowedMock.mockRejectedValueOnce(
      new TrustDeniedError(
        'TRUST_RESTRICTED',
        'Partner access is restricted.',
        deviceId,
        type,
      ),
    );
    expect((await request(type, payload)).status).toBe(403);
    expect(dispatchDeviceCommandMock).not.toHaveBeenCalled();
  });
  it('rejects malformed timezone before device lookup', async () => {
    expect(
      (await request('time_set_timezone', { windowsId: 'unknown' })).status,
    ).toBe(400);
    expect(getDeviceWithOrgCheck).not.toHaveBeenCalled();
    expect(dispatchDeviceCommandMock).not.toHaveBeenCalled();
  });
});
```

The existing route tests' auth fixture uses fixed string actor/org values; no new Zod UUID input is fed those strings. The new device parameter is a real UUID. Existing `beforeEach` resets `authState.mfa` at `:196`.

- [ ] Run: `cd apps/api && npx vitest run src/services/timeSync/commands.test.ts src/routes/devices/commands.test.ts`. Expected FAIL: unknown time type or absent command constant.
- [ ] Add after existing `COLLECT_BOOT_PERFORMANCE: 'collect_boot_performance',` at `commandTypes.ts:141`:

```ts
  TIME_RESYNC: 'time_resync',
  TIME_SET_TIMEZONE: 'time_set_timezone',
  TIME_APPLY_POLICY: 'time_apply_policy',
```

At `partnerTrust.ts:174–175`, replace:

```ts
  'terminal_start',
  'tunnel_data',
```

with:

```ts
  'terminal_start',
  'time_apply_policy',
  'time_resync',
  'time_set_timezone',
  'tunnel_data',
```

At `commandOfflinePolicy.ts:12`, replace the `DeliveryTtlClass` declaration with:

```ts
export type DeliveryTtlClass =
  'live' | 'live_only' | 'standard' | 'short' | 'power_state' | 'time_sync';
```

After `switch (cls) {` at `:53`, add:

```ts
  case 'time_sync':
    return HOUR_MS;
```

Before `const registry` at `:302`, add:

```ts
const TIME_SYNC: readonly string[] = [
  C.TIME_RESYNC,
  C.TIME_SET_TIMEZONE,
  C.TIME_APPLY_POLICY,
];
```

After the existing registry-population loops at `:309`, add:

```ts
for (const type of TIME_SYNC) registry[type] = 'time_sync';
```

Replace the explicit-classification Set construction at `:323` with:

```ts
  new Set<string>([
    ...LIVE,
    ...LIVE_ONLY,
    ...BACKUP_AND_RESTORE,
    ...SHORT,
    ...POWER_STATE_TTL_TYPES,
    ...STANDARD_REVIEWED,
    ...TIME_SYNC,
  ]),
```

Before `if (commandType === CommandTypes.SCRIPT) {` at `commandTimeouts.ts:207`, insert:

```ts
if (
  commandType === CommandTypes.TIME_RESYNC ||
  commandType === CommandTypes.TIME_SET_TIMEZONE ||
  commandType === CommandTypes.TIME_APPLY_POLICY
)
  return 60_000;
```

The existing `SHORT` delivery class is 24 hours (`commandOfflinePolicy.ts:67–68`) and the short timeout is 5 minutes (`commandTimeouts.ts:219`); neither is the contract value.

Import `isKnownWindowsZone` from `@breeze/shared` in `routes/devices/schemas.ts`. Replace the entire existing `createCommandSchema` declaration at `:280–286` (its enum ends `'wake', 'refresh_inventory'`, followed by `payload: z.any().optional()`) with:

```ts
const timeTimezonePayloadSchema = z
  .object({
    windowsId: z
      .string()
      .refine(isKnownWindowsZone, 'Unknown Windows timezone'),
  })
  .strict();
const emptyTimePayloadSchema = z.object({}).strict();
export const createCommandSchema = z
  .object({
    type: z.enum([
      'script',
      'reboot',
      'reboot_safe_mode',
      'shutdown',
      'update',
      'collect_evidence',
      'execute_containment',
      'wake',
      'refresh_inventory',
      'time_resync',
      'time_set_timezone',
      'time_apply_policy',
    ]),
    payload: z.any().optional(),
  })
  .superRefine((value, ctx) => {
    const schema =
      value.type === 'time_set_timezone'
        ? timeTimezonePayloadSchema
        : value.type === 'time_resync' || value.type === 'time_apply_policy'
          ? emptyTimePayloadSchema
          : null;
    if (!schema) return;
    const parsed = schema.safeParse(
      value.payload === undefined ? {} : value.payload,
    );
    if (!parsed.success)
      for (const issue of parsed.error.issues) {
        ctx.addIssue({
          code: 'custom',
          path: ['payload', ...issue.path],
          message: issue.message,
        });
      }
  });
```

Zod 4 preserves `.shape` on refined objects, needed by the existing offline-policy schema coverage test. Do not broaden `bulkCommandSchema`; each web target takes its own validated payload through the single-device route. `commands.ts:459–465` already runs scope, `DEVICES_EXECUTE` and MFA; `:475–480` checks tenant/site; `:488–501` gates trust; `:561–566` dispatches; `:586–597` audits `device.command.queue`. No route bypass is introduced.

- [ ] Repeat the two-file test command. Run `cd apps/api && npx vitest run src/services/commandOfflinePolicy.test.ts src/services/commandTimeouts.test.ts`. Expected PASS, including explicit classification coverage and all existing command timeouts.
- [ ] Commit:

```bash
git add apps/api/src/services/commandTypes.ts apps/api/src/services/commandOfflinePolicy.ts apps/api/src/services/commandTimeouts.ts apps/api/src/services/partnerTrust.ts apps/api/src/routes/devices/schemas.ts apps/api/src/services/timeSync/commands.test.ts apps/api/src/routes/devices/commands.test.ts
git commit -m "feat(time-sync): register gated time management commands" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 9: Add the inheritable policy tab and Effective Config metadata

**Files:** Create `apps/web/src/components/configurationPolicies/featureTabs/TimeSyncTab.tsx`, `TimeSyncTab.test.tsx`; Modify `featureTabs/types.ts:87`, `ConfigPolicyDetailPage.tsx:63,127,476`, `apps/web/src/components/devices/DeviceEffectiveConfigTab.tsx:133`; Modify/Test `featureTabs/useFeatureLink.test.ts:19`; Modify all eight `apps/web/src/locales/<locale>/devices.json` files; run `apps/web/src/lib/i18n/translationCoverage.test.ts` unchanged.

**Interfaces:** Consumes `FeatureTabProps` (`featureTabs/types.ts:39`), `useFeatureLink(policyId)` (`useFeatureLink.ts:15`, already uses `runAction` at `:39–45`), `TimezoneSelect` (`components/shared/TimezoneSelect.tsx:29–39,77`) and shared settings. Produces inline saves `{ featureType: 'time_sync', featurePolicyId: null, inlineSettings: TimeSyncInlineSettings }` through existing policy permissions.

- [ ] Write `TimeSyncTab.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import '@/lib/i18n';
const m = vi.hoisted(() => ({
  save: vi.fn(),
  remove: vi.fn(),
  changed: vi.fn(),
}));
vi.mock('./useFeatureLink', () => ({
  useFeatureLink: () => ({
    save: m.save,
    remove: m.remove,
    saving: false,
    error: undefined,
    clearError: vi.fn(),
  }),
}));
import TimeSyncTab from './TimeSyncTab';
const props = {
  policyId: 'policy',
  existingLink: undefined,
  linkedPolicyId: null,
  onLinkChanged: m.changed,
};
beforeEach(() => {
  vi.clearAllMocks();
  m.save.mockResolvedValue({
    id: 'link',
    featureType: 'time_sync',
    featurePolicyId: null,
    inlineSettings: {},
  });
});
it('starts off and saves typed settings only after a valid peer is entered', async () => {
  render(<TimeSyncTab {...props} />);
  expect(
    (screen.getByTestId('time-sync-enforce-ntp') as HTMLInputElement).checked,
  ).toBe(false);
  fireEvent.click(screen.getByTestId('time-sync-enforce-ntp'));
  expect(
    (screen.getByRole('button', { name: /^save$/i }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.change(screen.getByTestId('time-sync-servers'), {
    target: { value: 'pool.ntp.org' },
  });
  fireEvent.change(screen.getByTestId('time-sync-interval'), {
    target: { value: '120' },
  });
  fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
  await waitFor(() =>
    expect(m.save).toHaveBeenCalledWith(null, {
      featureType: 'time_sync',
      featurePolicyId: null,
      inlineSettings: {
        enforceNtp: true,
        ntpServers: ['pool.ntp.org'],
        pollIntervalMinutes: 120,
        timezone: { expected: 'site', pinnedTimezone: null, autoFix: false },
      },
    }),
  );
});
it.each(['a,0x9', 'a b', 'a;b', '-flag', 'a:123', '"a"'])(
  'keeps invalid peer %s visible and disables save',
  (value) => {
    render(<TimeSyncTab {...props} />);
    fireEvent.change(screen.getByTestId('time-sync-servers'), {
      target: { value },
    });
    expect(
      (screen.getByTestId('time-sync-servers') as HTMLTextAreaElement).value,
    ).toBe(value);
    expect(
      (screen.getByRole('button', { name: /^save$/i }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  },
);
it('requires a mapped pin and explains that it overrides the site', () => {
  render(<TimeSyncTab {...props} />);
  fireEvent.change(screen.getByTestId('time-sync-expected'), {
    target: { value: 'pinned' },
  });
  expect(
    screen.getByText('The pinned timezone overrides the site timezone.'),
  ).toBeTruthy();
  expect(
    (screen.getByRole('button', { name: /^save$/i }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});
it('inherits without editing the parent, then creates a local override', async () => {
  const parent = {
    id: 'parent-link',
    featureType: 'time_sync' as const,
    featurePolicyId: null,
    inlineSettings: {
      enforceNtp: true,
      ntpServers: ['pool.ntp.org'],
      pollIntervalMinutes: 60,
      timezone: { expected: 'pinned', pinnedTimezone: 'UTC', autoFix: true },
    },
  };
  render(
    <TimeSyncTab {...props} parentLink={parent} linkedPolicyId="parent" />,
  );
  expect(
    screen.getByTestId('time-sync-enforce-ntp').closest('fieldset')!.disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: /override/i }));
  await waitFor(() =>
    expect(m.save).toHaveBeenCalledWith(
      null,
      expect.objectContaining({ inlineSettings: parent.inlineSettings }),
    ),
  );
});
it('does not report a saved link after failure', async () => {
  m.save.mockResolvedValue(null);
  render(<TimeSyncTab {...props} />);
  fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
  await waitFor(() => expect(m.save).toHaveBeenCalled());
  expect(m.changed).not.toHaveBeenCalled();
});
it('retains invalid interval text instead of clamping it', () => {
  render(<TimeSyncTab {...props} />);
  fireEvent.change(screen.getByTestId('time-sync-interval'), {
    target: { value: '14' },
  });
  expect(
    (screen.getByTestId('time-sync-interval') as HTMLInputElement).value,
  ).toBe('14');
  expect(
    (screen.getByRole('button', { name: /^save$/i }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});
```

Append inside `useFeatureLink.test.ts`'s `describe('feature Save action feedback', ...)` at `:19`:

```ts
it.each([null, LINK])(
  'saves time_sync through runAction for link %s',
  async (existingId) => {
    vi.clearAllMocks();
    const timePayload = {
      featureType: 'time_sync' as const,
      featurePolicyId: null,
      inlineSettings: {
        enforceNtp: false,
        ntpServers: [],
        pollIntervalMinutes: 60,
        timezone: { expected: 'site', pinnedTimezone: null, autoFix: false },
      },
    };
    const row = { id: LINK, ...timePayload };
    vi.mocked(fetchWithAuth).mockResolvedValue(
      new Response(JSON.stringify(row), { status: 200 }),
    );
    const { result } = renderHook(() => useFeatureLink(POLICY));
    await act(async () => {
      expect(await result.current.save(existingId, timePayload)).toEqual(row);
    });
    expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success' }),
    );
  },
);
```

- [ ] Run: `cd apps/web && npx vitest run src/components/configurationPolicies/featureTabs/TimeSyncTab.test.tsx src/components/configurationPolicies/featureTabs/featureTypeParity.test.ts src/components/devices/DeviceEffectiveConfigTab.featureParity.test.ts`. Expected FAIL: missing tab and metadata entries.
- [ ] Add all 51 management, action, and enforcement strings below to each of the eight catalogs. Run this exact command from the repository root during implementation. Every non-English value is translated; interpolation tokens are preserved and existing W01a/W02 keys are recursively retained (R1).

```bash
python3 - <<'PY'
import json
import re
from pathlib import Path

english = {
  'management': {
    'title': 'Time sync',
    'description': 'Domain-aware Windows time policy and timezone settings',
    'domainRule': 'Workgroup, Entra-only devices and the forest-root PDC use the configured NTP servers. Domain members, domain controllers and other PDC emulators use the domain hierarchy. Unknown roles are skipped.',
    'gpoWins': 'Group Policy takes precedence. Breeze does not change W32Time settings managed by Group Policy.',
    'enforceNtp': 'Enforce time synchronization',
    'ntpServers': 'NTP servers — one hostname or IP address per line, up to 5',
    'pollInterval': 'Poll interval (minutes, 15–1440)',
    'expectedTimezone': 'Expected timezone',
    'site': 'Follow site timezone',
    'pinned': 'Pin a timezone',
    'pinnedZone': 'Pinned timezone',
    'pinOverrides': 'The pinned timezone overrides the site timezone.',
    'autoFix': 'Automatically correct the timezone',
    'invalidServers': 'Use at most 5 valid NTP hosts, with no flags or ports. Enforcement needs at least one host.',
    'invalidInterval': 'Enter a whole number from 15 to 1440.',
    'invalidZone': 'Choose a timezone with a Windows mapping.',
    'policySource': 'From policy {{name}} — overrides the site timezone',
    'unnamedPolicy': 'Unnamed policy',
  },
  'actions': {
    'resync': 'Resync', 'setTimezone': 'Set timezone to expected',
    'applyPolicy': 'Apply time policy now', 'bulkResync': 'Resync selected devices',
    'bulkSetTimezone': 'Set selected devices to their expected timezone',
    'queued': 'Time command queued', 'failed': 'Could not queue time command',
    'awaiting': 'Queued — awaiting execution',
    'offline': 'Queued offline — expires after 1 hour',
    'delivered': 'Delivered — awaiting execution',
    'noExpected': 'Skipped — no expected timezone',
    'select': 'Select device', 'outcomes': 'Command outcomes',
    'checking': 'Checking current expected timezone',
  },
  'enforcement': {
    'title': 'Latest time policy result', 'none': 'No enforcement result reported yet',
    'ntp': 'Time synchronization', 'timezone': 'Timezone',
    'ok': 'Applied or already compliant', 'failed': 'Failed', 'skipped': 'Skipped',
    'before': 'Before', 'after': 'After', 'reportedAt': 'Reported at',
    'applied': 'Applied', 'already_compliant': 'Already compliant',
    'role_unknown': 'Skipped because the domain role is unknown',
    'conflict_gpo': 'Skipped because Group Policy takes precedence',
    'readback_mismatch': 'Read-back did not match the requested policy',
    'exec_failed': 'The Windows command failed', 'invalid_settings': 'Settings were invalid',
    'auto_timezone_on': 'Windows automatic timezone is enabled',
    'no_expected_timezone': 'No expected timezone is configured',
  },
}

translations = {
    'de-DE': {
        'management': {
            'title': 'Zeitsynchronisierung',
            'description': 'Windows-Zeitrichtlinie und Zeitzoneneinstellungen mit Berücksichtigung der Domäne',
            'domainRule': 'Arbeitsgruppen, reine Entra-Geräte und der PDC der Gesamtstruktur-Stammdomäne verwenden die konfigurierten NTP-Server. Domänenmitglieder, Domänencontroller und andere PDC-Emulatoren verwenden die Domänenhierarchie. Unbekannte Rollen werden übersprungen.',
            'gpoWins': 'Gruppenrichtlinien haben Vorrang. Breeze ändert keine W32Time-Einstellungen, die durch Gruppenrichtlinien verwaltet werden.',
            'enforceNtp': 'Zeitsynchronisierung erzwingen',
            'ntpServers': 'NTP-Server — ein Hostname oder eine IP-Adresse pro Zeile, höchstens 5',
            'pollInterval': 'Abfrageintervall (Minuten, 15–1440)',
            'expectedTimezone': 'Erwartete Zeitzone',
            'site': 'Zeitzone des Standorts übernehmen',
            'pinned': 'Eine Zeitzone festlegen',
            'pinnedZone': 'Festgelegte Zeitzone',
            'pinOverrides': 'Die festgelegte Zeitzone hat Vorrang vor der Zeitzone des Standorts.',
            'autoFix': 'Zeitzone automatisch korrigieren',
            'invalidServers': 'Verwenden Sie höchstens 5 gültige NTP-Hosts ohne Optionen oder Ports. Zum Erzwingen ist mindestens ein Host erforderlich.',
            'invalidInterval': 'Geben Sie eine ganze Zahl zwischen 15 und 1440 ein.',
            'invalidZone': 'Wählen Sie eine Zeitzone mit Windows-Zuordnung.',
            'policySource': 'Aus Richtlinie {{name}} — hat Vorrang vor der Zeitzone des Standorts',
            'unnamedPolicy': 'Unbenannte Richtlinie',
        },
        'actions': {
            'resync': 'Erneut synchronisieren',
            'setTimezone': 'Erwartete Zeitzone einstellen',
            'applyPolicy': 'Zeitrichtlinie jetzt anwenden',
            'bulkResync': 'Ausgewählte Geräte erneut synchronisieren',
            'bulkSetTimezone': 'Ausgewählte Geräte auf ihre erwartete Zeitzone einstellen',
            'queued': 'Zeitbefehl eingereiht',
            'failed': 'Zeitbefehl konnte nicht eingereiht werden',
            'awaiting': 'Eingereiht — wartet auf Ausführung',
            'offline': 'Offline eingereiht — läuft nach 1 Stunde ab',
            'delivered': 'Zugestellt — wartet auf Ausführung',
            'noExpected': 'Übersprungen — keine erwartete Zeitzone',
            'select': 'Gerät auswählen',
            'outcomes': 'Befehlsergebnisse',
            'checking': 'Aktuell erwartete Zeitzone wird geprüft',
        },
        'enforcement': {
            'title': 'Letztes Ergebnis der Zeitrichtlinie',
            'none': 'Noch kein Durchsetzungsergebnis gemeldet',
            'ntp': 'Zeitsynchronisierung',
            'timezone': 'Zeitzone',
            'ok': 'Angewendet oder bereits konform',
            'failed': 'Fehlgeschlagen',
            'skipped': 'Übersprungen',
            'before': 'Vorher',
            'after': 'Nachher',
            'reportedAt': 'Gemeldet am',
            'applied': 'Angewendet',
            'already_compliant': 'Bereits konform',
            'role_unknown': 'Übersprungen, da die Domänenrolle unbekannt ist',
            'conflict_gpo': 'Übersprungen, da Gruppenrichtlinien Vorrang haben',
            'readback_mismatch': 'Die zurückgelesenen Werte entsprechen nicht der angeforderten Richtlinie',
            'exec_failed': 'Der Windows-Befehl ist fehlgeschlagen',
            'invalid_settings': 'Die Einstellungen waren ungültig',
            'auto_timezone_on': 'Die automatische Zeitzoneneinstellung von Windows ist aktiviert',
            'no_expected_timezone': 'Es ist keine erwartete Zeitzone konfiguriert',
        },
    },
    'es-419': {
        'management': {
            'title': 'Sincronización de hora',
            'description': 'Política de hora de Windows según el dominio y configuración de zona horaria',
            'domainRule': 'Los grupos de trabajo, los dispositivos que solo usan Entra y el PDC del dominio raíz del bosque usan los servidores NTP configurados. Los miembros del dominio, los controladores de dominio y los demás emuladores de PDC usan la jerarquía del dominio. Se omiten los roles desconocidos.',
            'gpoWins': 'La directiva de grupo tiene prioridad. Breeze no cambia la configuración de W32Time administrada por la directiva de grupo.',
            'enforceNtp': 'Exigir la sincronización de hora',
            'ntpServers': 'Servidores NTP — un nombre de host o una dirección IP por línea, hasta 5',
            'pollInterval': 'Intervalo de consulta (minutos, 15–1440)',
            'expectedTimezone': 'Zona horaria esperada',
            'site': 'Usar la zona horaria del sitio',
            'pinned': 'Fijar una zona horaria',
            'pinnedZone': 'Zona horaria fijada',
            'pinOverrides': 'La zona horaria fijada tiene prioridad sobre la zona horaria del sitio.',
            'autoFix': 'Corregir automáticamente la zona horaria',
            'invalidServers': 'Usa hasta 5 hosts NTP válidos, sin parámetros ni puertos. Para exigir la sincronización se necesita al menos un host.',
            'invalidInterval': 'Ingresa un número entero entre 15 y 1440.',
            'invalidZone': 'Elige una zona horaria con una equivalencia de Windows.',
            'policySource': 'De la política {{name}} — tiene prioridad sobre la zona horaria del sitio',
            'unnamedPolicy': 'Política sin nombre',
        },
        'actions': {
            'resync': 'Volver a sincronizar',
            'setTimezone': 'Establecer la zona horaria esperada',
            'applyPolicy': 'Aplicar la política de hora ahora',
            'bulkResync': 'Volver a sincronizar los dispositivos seleccionados',
            'bulkSetTimezone': 'Establecer la zona horaria esperada en los dispositivos seleccionados',
            'queued': 'Comando de hora en cola',
            'failed': 'No se pudo poner el comando de hora en cola',
            'awaiting': 'En cola — pendiente de ejecución',
            'offline': 'En cola sin conexión — vence después de 1 hora',
            'delivered': 'Entregado — pendiente de ejecución',
            'noExpected': 'Omitido — no hay zona horaria esperada',
            'select': 'Seleccionar dispositivo',
            'outcomes': 'Resultados de los comandos',
            'checking': 'Verificando la zona horaria esperada actual',
        },
        'enforcement': {
            'title': 'Último resultado de la política de hora',
            'none': 'Aún no se ha informado un resultado de aplicación',
            'ntp': 'Sincronización de hora',
            'timezone': 'Zona horaria',
            'ok': 'Aplicada o ya cumple',
            'failed': 'Falló',
            'skipped': 'Omitido',
            'before': 'Antes',
            'after': 'Después',
            'reportedAt': 'Fecha del informe',
            'applied': 'Aplicada',
            'already_compliant': 'Ya cumple',
            'role_unknown': 'Se omitió porque se desconoce el rol del dominio',
            'conflict_gpo': 'Se omitió porque la directiva de grupo tiene prioridad',
            'readback_mismatch': 'La lectura de verificación no coincidió con la política solicitada',
            'exec_failed': 'El comando de Windows falló',
            'invalid_settings': 'La configuración no era válida',
            'auto_timezone_on': 'La zona horaria automática de Windows está habilitada',
            'no_expected_timezone': 'No hay una zona horaria esperada configurada',
        },
    },
    'fr-CA': {
        'management': {
            'title': 'Synchronisation de l’heure',
            'description': 'Stratégie d’heure Windows tenant compte du domaine et paramètres de fuseau horaire',
            'domainRule': 'Les groupes de travail, les appareils utilisant uniquement Entra et le PDC du domaine racine de la forêt utilisent les serveurs NTP configurés. Les membres du domaine, les contrôleurs de domaine et les autres émulateurs PDC utilisent la hiérarchie du domaine. Les rôles inconnus sont ignorés.',
            'gpoWins': 'La stratégie de groupe est prioritaire. Breeze ne modifie pas les paramètres W32Time gérés par la stratégie de groupe.',
            'enforceNtp': 'Imposer la synchronisation de l’heure',
            'ntpServers': 'Serveurs NTP — un nom d’hôte ou une adresse IP par ligne, jusqu’à 5',
            'pollInterval': 'Intervalle d’interrogation (minutes, 15–1440)',
            'expectedTimezone': 'Fuseau horaire attendu',
            'site': 'Utiliser le fuseau horaire du site',
            'pinned': 'Fixer un fuseau horaire',
            'pinnedZone': 'Fuseau horaire fixé',
            'pinOverrides': 'Le fuseau horaire fixé remplace celui du site.',
            'autoFix': 'Corriger automatiquement le fuseau horaire',
            'invalidServers': 'Utilisez au plus 5 hôtes NTP valides, sans options ni ports. L’application exige au moins un hôte.',
            'invalidInterval': 'Entrez un nombre entier de 15 à 1440.',
            'invalidZone': 'Choisissez un fuseau horaire ayant une correspondance Windows.',
            'policySource': 'De la stratégie {{name}} — remplace le fuseau horaire du site',
            'unnamedPolicy': 'Stratégie sans nom',
        },
        'actions': {
            'resync': 'Resynchroniser',
            'setTimezone': 'Définir le fuseau horaire attendu',
            'applyPolicy': 'Appliquer la stratégie d’heure maintenant',
            'bulkResync': 'Resynchroniser les appareils sélectionnés',
            'bulkSetTimezone': 'Définir le fuseau horaire attendu de chaque appareil sélectionné',
            'queued': 'Commande d’heure mise en file d’attente',
            'failed': 'Impossible de mettre la commande d’heure en file d’attente',
            'awaiting': 'En file d’attente — en attente d’exécution',
            'offline': 'En file d’attente hors ligne — expire après 1 heure',
            'delivered': 'Transmise — en attente d’exécution',
            'noExpected': 'Ignorée — aucun fuseau horaire attendu',
            'select': 'Sélectionner l’appareil',
            'outcomes': 'Résultats des commandes',
            'checking': 'Vérification du fuseau horaire attendu actuel',
        },
        'enforcement': {
            'title': 'Dernier résultat de la stratégie d’heure',
            'none': 'Aucun résultat d’application signalé pour le moment',
            'ntp': 'Synchronisation de l’heure',
            'timezone': 'Fuseau horaire',
            'ok': 'Appliquée ou déjà conforme',
            'failed': 'Échec',
            'skipped': 'Ignorée',
            'before': 'Avant',
            'after': 'Après',
            'reportedAt': 'Signalé le',
            'applied': 'Appliquée',
            'already_compliant': 'Déjà conforme',
            'role_unknown': 'Ignorée, car le rôle du domaine est inconnu',
            'conflict_gpo': 'Ignorée, car la stratégie de groupe est prioritaire',
            'readback_mismatch': 'La lecture de vérification ne correspondait pas à la stratégie demandée',
            'exec_failed': 'La commande Windows a échoué',
            'invalid_settings': 'Les paramètres étaient invalides',
            'auto_timezone_on': 'Le fuseau horaire automatique de Windows est activé',
            'no_expected_timezone': 'Aucun fuseau horaire attendu n’est configuré',
        },
    },
    'fr-FR': {
        'management': {
            'title': 'Synchronisation de l’heure',
            'description': 'Stratégie d’heure Windows tenant compte du domaine et paramètres de fuseau horaire',
            'domainRule': 'Les groupes de travail, les appareils utilisant uniquement Entra et le PDC du domaine racine de la forêt utilisent les serveurs NTP configurés. Les membres du domaine, les contrôleurs de domaine et les autres émulateurs PDC utilisent la hiérarchie du domaine. Les rôles inconnus sont ignorés.',
            'gpoWins': 'La stratégie de groupe est prioritaire. Breeze ne modifie pas les paramètres W32Time gérés par la stratégie de groupe.',
            'enforceNtp': 'Imposer la synchronisation de l’heure',
            'ntpServers': 'Serveurs NTP — un nom d’hôte ou une adresse IP par ligne, jusqu’à 5',
            'pollInterval': 'Intervalle d’interrogation (minutes, 15–1440)',
            'expectedTimezone': 'Fuseau horaire attendu',
            'site': 'Utiliser le fuseau horaire du site',
            'pinned': 'Fixer un fuseau horaire',
            'pinnedZone': 'Fuseau horaire fixé',
            'pinOverrides': 'Le fuseau horaire fixé remplace celui du site.',
            'autoFix': 'Corriger automatiquement le fuseau horaire',
            'invalidServers': 'Utilisez au maximum 5 hôtes NTP valides, sans options ni ports. L’application nécessite au moins un hôte.',
            'invalidInterval': 'Saisissez un nombre entier compris entre 15 et 1440.',
            'invalidZone': 'Choisissez un fuseau horaire disposant d’une correspondance Windows.',
            'policySource': 'De la stratégie {{name}} — remplace le fuseau horaire du site',
            'unnamedPolicy': 'Stratégie sans nom',
        },
        'actions': {
            'resync': 'Resynchroniser',
            'setTimezone': 'Définir le fuseau horaire attendu',
            'applyPolicy': 'Appliquer la stratégie d’heure maintenant',
            'bulkResync': 'Resynchroniser les appareils sélectionnés',
            'bulkSetTimezone': 'Définir le fuseau horaire attendu de chaque appareil sélectionné',
            'queued': 'Commande d’heure mise en file d’attente',
            'failed': 'Impossible de mettre la commande d’heure en file d’attente',
            'awaiting': 'En file d’attente — en attente d’exécution',
            'offline': 'En file d’attente hors ligne — expire après 1 heure',
            'delivered': 'Transmise — en attente d’exécution',
            'noExpected': 'Ignorée — aucun fuseau horaire attendu',
            'select': 'Sélectionner l’appareil',
            'outcomes': 'Résultats des commandes',
            'checking': 'Vérification du fuseau horaire attendu actuel',
        },
        'enforcement': {
            'title': 'Dernier résultat de la stratégie d’heure',
            'none': 'Aucun résultat d’application signalé pour le moment',
            'ntp': 'Synchronisation de l’heure',
            'timezone': 'Fuseau horaire',
            'ok': 'Appliquée ou déjà conforme',
            'failed': 'Échec',
            'skipped': 'Ignorée',
            'before': 'Avant',
            'after': 'Après',
            'reportedAt': 'Signalé le',
            'applied': 'Appliquée',
            'already_compliant': 'Déjà conforme',
            'role_unknown': 'Ignorée, car le rôle du domaine est inconnu',
            'conflict_gpo': 'Ignorée, car la stratégie de groupe est prioritaire',
            'readback_mismatch': 'La lecture de vérification ne correspondait pas à la stratégie demandée',
            'exec_failed': 'La commande Windows a échoué',
            'invalid_settings': 'Les paramètres étaient invalides',
            'auto_timezone_on': 'Le fuseau horaire automatique de Windows est activé',
            'no_expected_timezone': 'Aucun fuseau horaire attendu n’est configuré',
        },
    },
    'it-IT': {
        'management': {
            'title': 'Sincronizzazione dell’ora',
            'description': 'Criteri orari di Windows basati sul dominio e impostazioni del fuso orario',
            'domainRule': 'I gruppi di lavoro, i dispositivi che usano solo Entra e il PDC del dominio radice della foresta usano i server NTP configurati. I membri del dominio, i controller di dominio e gli altri emulatori PDC usano la gerarchia del dominio. I ruoli sconosciuti vengono ignorati.',
            'gpoWins': 'I Criteri di gruppo hanno la precedenza. Breeze non modifica le impostazioni W32Time gestite dai Criteri di gruppo.',
            'enforceNtp': 'Imponi la sincronizzazione dell’ora',
            'ntpServers': 'Server NTP — un nome host o un indirizzo IP per riga, fino a 5',
            'pollInterval': 'Intervallo di interrogazione (minuti, 15–1440)',
            'expectedTimezone': 'Fuso orario previsto',
            'site': 'Usa il fuso orario del sito',
            'pinned': 'Imposta un fuso orario fisso',
            'pinnedZone': 'Fuso orario fisso',
            'pinOverrides': 'Il fuso orario fisso ha la precedenza sul fuso orario del sito.',
            'autoFix': 'Correggi automaticamente il fuso orario',
            'invalidServers': 'Usa al massimo 5 host NTP validi, senza opzioni o porte. Per imporre la sincronizzazione è necessario almeno un host.',
            'invalidInterval': 'Inserisci un numero intero compreso tra 15 e 1440.',
            'invalidZone': 'Scegli un fuso orario con una corrispondenza Windows.',
            'policySource': 'Dal criterio {{name}} — ha la precedenza sul fuso orario del sito',
            'unnamedPolicy': 'Criterio senza nome',
        },
        'actions': {
            'resync': 'Sincronizza di nuovo',
            'setTimezone': 'Imposta il fuso orario previsto',
            'applyPolicy': 'Applica ora il criterio orario',
            'bulkResync': 'Sincronizza di nuovo i dispositivi selezionati',
            'bulkSetTimezone': 'Imposta il fuso orario previsto su ciascun dispositivo selezionato',
            'queued': 'Comando orario in coda',
            'failed': 'Impossibile mettere in coda il comando orario',
            'awaiting': 'In coda — in attesa di esecuzione',
            'offline': 'In coda offline — scade dopo 1 ora',
            'delivered': 'Consegnato — in attesa di esecuzione',
            'noExpected': 'Ignorato — nessun fuso orario previsto',
            'select': 'Seleziona dispositivo',
            'outcomes': 'Esiti dei comandi',
            'checking': 'Verifica del fuso orario attualmente previsto',
        },
        'enforcement': {
            'title': 'Ultimo risultato del criterio orario',
            'none': 'Nessun risultato di applicazione ancora segnalato',
            'ntp': 'Sincronizzazione dell’ora',
            'timezone': 'Fuso orario',
            'ok': 'Applicato o già conforme',
            'failed': 'Non riuscito',
            'skipped': 'Ignorato',
            'before': 'Prima',
            'after': 'Dopo',
            'reportedAt': 'Segnalato il',
            'applied': 'Applicato',
            'already_compliant': 'Già conforme',
            'role_unknown': 'Ignorato perché il ruolo nel dominio è sconosciuto',
            'conflict_gpo': 'Ignorato perché i Criteri di gruppo hanno la precedenza',
            'readback_mismatch': 'La lettura di verifica non corrispondeva al criterio richiesto',
            'exec_failed': 'Il comando Windows non è riuscito',
            'invalid_settings': 'Le impostazioni non erano valide',
            'auto_timezone_on': 'Il fuso orario automatico di Windows è abilitato',
            'no_expected_timezone': 'Nessun fuso orario previsto è configurato',
        },
    },
    'pt-BR': {
        'management': {
            'title': 'Sincronização de horário',
            'description': 'Política de horário do Windows baseada no domínio e configurações de fuso horário',
            'domainRule': 'Grupos de trabalho, dispositivos que usam apenas o Entra e o PDC do domínio raiz da floresta usam os servidores NTP configurados. Membros do domínio, controladores de domínio e outros emuladores PDC usam a hierarquia do domínio. Funções desconhecidas são ignoradas.',
            'gpoWins': 'A Política de Grupo tem precedência. O Breeze não altera as configurações do W32Time gerenciadas pela Política de Grupo.',
            'enforceNtp': 'Exigir a sincronização de horário',
            'ntpServers': 'Servidores NTP — um nome de host ou endereço IP por linha, até 5',
            'pollInterval': 'Intervalo de consulta (minutos, 15–1440)',
            'expectedTimezone': 'Fuso horário esperado',
            'site': 'Usar o fuso horário do local',
            'pinned': 'Fixar um fuso horário',
            'pinnedZone': 'Fuso horário fixado',
            'pinOverrides': 'O fuso horário fixado tem precedência sobre o fuso horário do local.',
            'autoFix': 'Corrigir automaticamente o fuso horário',
            'invalidServers': 'Use no máximo 5 hosts NTP válidos, sem opções ou portas. Para exigir a sincronização, é necessário pelo menos um host.',
            'invalidInterval': 'Insira um número inteiro de 15 a 1440.',
            'invalidZone': 'Escolha um fuso horário com correspondência no Windows.',
            'policySource': 'Da política {{name}} — tem precedência sobre o fuso horário do local',
            'unnamedPolicy': 'Política sem nome',
        },
        'actions': {
            'resync': 'Sincronizar novamente',
            'setTimezone': 'Definir o fuso horário esperado',
            'applyPolicy': 'Aplicar a política de horário agora',
            'bulkResync': 'Sincronizar novamente os dispositivos selecionados',
            'bulkSetTimezone': 'Definir o fuso horário esperado em cada dispositivo selecionado',
            'queued': 'Comando de horário colocado na fila',
            'failed': 'Não foi possível colocar o comando de horário na fila',
            'awaiting': 'Na fila — aguardando execução',
            'offline': 'Na fila sem conexão — expira após 1 hora',
            'delivered': 'Entregue — aguardando execução',
            'noExpected': 'Ignorado — nenhum fuso horário esperado',
            'select': 'Selecionar dispositivo',
            'outcomes': 'Resultados dos comandos',
            'checking': 'Verificando o fuso horário esperado atual',
        },
        'enforcement': {
            'title': 'Último resultado da política de horário',
            'none': 'Nenhum resultado de aplicação informado ainda',
            'ntp': 'Sincronização de horário',
            'timezone': 'Fuso horário',
            'ok': 'Aplicada ou já em conformidade',
            'failed': 'Falhou',
            'skipped': 'Ignorada',
            'before': 'Antes',
            'after': 'Depois',
            'reportedAt': 'Informado em',
            'applied': 'Aplicada',
            'already_compliant': 'Já em conformidade',
            'role_unknown': 'Ignorada porque a função no domínio é desconhecida',
            'conflict_gpo': 'Ignorada porque a Política de Grupo tem precedência',
            'readback_mismatch': 'A leitura de verificação não correspondeu à política solicitada',
            'exec_failed': 'O comando do Windows falhou',
            'invalid_settings': 'As configurações eram inválidas',
            'auto_timezone_on': 'O fuso horário automático do Windows está habilitado',
            'no_expected_timezone': 'Nenhum fuso horário esperado está configurado',
        },
    },
    'tr-TR': {
        'management': {
            'title': 'Saat eşitleme',
            'description': 'Etki alanını dikkate alan Windows saat ilkesi ve saat dilimi ayarları',
            'domainRule': 'Çalışma grupları, yalnızca Entra kullanan cihazlar ve orman kök etki alanının PDC’si yapılandırılmış NTP sunucularını kullanır. Etki alanı üyeleri, etki alanı denetleyicileri ve diğer PDC öykünücüleri etki alanı hiyerarşisini kullanır. Bilinmeyen roller atlanır.',
            'gpoWins': 'Grup İlkesi önceliklidir. Breeze, Grup İlkesi tarafından yönetilen W32Time ayarlarını değiştirmez.',
            'enforceNtp': 'Saat eşitlemesini zorunlu kıl',
            'ntpServers': 'NTP sunucuları — her satıra bir ana bilgisayar adı veya IP adresi, en fazla 5',
            'pollInterval': 'Sorgulama aralığı (dakika, 15–1440)',
            'expectedTimezone': 'Beklenen saat dilimi',
            'site': 'Sitenin saat dilimini kullan',
            'pinned': 'Bir saat dilimini sabitle',
            'pinnedZone': 'Sabitlenmiş saat dilimi',
            'pinOverrides': 'Sabitlenmiş saat dilimi, sitenin saat diliminden önceliklidir.',
            'autoFix': 'Saat dilimini otomatik düzelt',
            'invalidServers': 'Bayrak veya bağlantı noktası içermeyen en fazla 5 geçerli NTP ana bilgisayarı kullanın. Zorunlu uygulama için en az bir ana bilgisayar gerekir.',
            'invalidInterval': '15 ile 1440 arasında bir tam sayı girin.',
            'invalidZone': 'Windows eşlemesi olan bir saat dilimi seçin.',
            'policySource': '{{name}} ilkesinden — sitenin saat diliminden önceliklidir',
            'unnamedPolicy': 'Adsız ilke',
        },
        'actions': {
            'resync': 'Yeniden eşitle',
            'setTimezone': 'Beklenen saat dilimini ayarla',
            'applyPolicy': 'Saat ilkesini şimdi uygula',
            'bulkResync': 'Seçili cihazları yeniden eşitle',
            'bulkSetTimezone': 'Seçili cihazların beklenen saat dilimlerini ayarla',
            'queued': 'Saat komutu kuyruğa alındı',
            'failed': 'Saat komutu kuyruğa alınamadı',
            'awaiting': 'Kuyrukta — yürütülmeyi bekliyor',
            'offline': 'Çevrimdışıyken kuyruğa alındı — 1 saat sonra süresi dolar',
            'delivered': 'İletildi — yürütülmeyi bekliyor',
            'noExpected': 'Atlandı — beklenen saat dilimi yok',
            'select': 'Cihaz seç',
            'outcomes': 'Komut sonuçları',
            'checking': 'Geçerli beklenen saat dilimi denetleniyor',
        },
        'enforcement': {
            'title': 'En son saat ilkesi sonucu',
            'none': 'Henüz bir uygulama sonucu bildirilmedi',
            'ntp': 'Saat eşitleme',
            'timezone': 'Saat dilimi',
            'ok': 'Uygulandı veya zaten uyumlu',
            'failed': 'Başarısız',
            'skipped': 'Atlandı',
            'before': 'Önce',
            'after': 'Sonra',
            'reportedAt': 'Bildirilme zamanı',
            'applied': 'Uygulandı',
            'already_compliant': 'Zaten uyumlu',
            'role_unknown': 'Etki alanı rolü bilinmediği için atlandı',
            'conflict_gpo': 'Grup İlkesi öncelikli olduğu için atlandı',
            'readback_mismatch': 'Geri okuma, istenen ilkeyle eşleşmedi',
            'exec_failed': 'Windows komutu başarısız oldu',
            'invalid_settings': 'Ayarlar geçersizdi',
            'auto_timezone_on': 'Windows otomatik saat dilimi etkin',
            'no_expected_timezone': 'Beklenen bir saat dilimi yapılandırılmamış',
        },
    },
}

def flatten(value, prefix=''):
    result = {}
    for key, child in value.items():
        name = f'{prefix}.{key}' if prefix else key
        if isinstance(child, dict):
            result.update(flatten(child, name))
        else:
            assert isinstance(child, str) and child, name
            result[name] = child
    return result


def merge(target, source):
    for key, value in source.items():
        if isinstance(value, dict):
            existing = target.setdefault(key, {})
            assert isinstance(existing, dict), key
            merge(existing, value)
        else:
            target[key] = value


assert set(translations) == {
    'de-DE', 'es-419', 'fr-CA', 'fr-FR', 'it-IT', 'pt-BR', 'tr-TR',
}
english_keys = flatten(english)
assert len(english_keys) == 51
payloads = {'en': english, **translations}
for locale, payload in payloads.items():
    translated = flatten(payload)
    assert translated.keys() == english_keys.keys(), locale
    for key, value in translated.items():
        assert sorted(re.findall(r'\{\{[^{}]+\}\}', value)) == sorted(
            re.findall(r'\{\{[^{}]+\}\}', english_keys[key])
        ), (locale, key)
        if locale != 'en':
            assert value != english_keys[key], (locale, key)

# Validate every locale before writing any catalog; preserve existing W01a/W02 keys.
updates = []
for locale, payload in payloads.items():
    path = Path('apps/web/src/locales') / locale / 'devices.json'
    data = json.loads(path.read_text())
    time_sync = data.setdefault('timeSync', {})
    before = flatten(time_sync)
    merge(time_sync, payload)
    after = flatten(time_sync)
    for key, value in before.items():
        if key not in english_keys:
            assert after[key] == value, (locale, key)
    updates.append((path, json.dumps(data, ensure_ascii=False, indent=2) + '\n'))
for path, content in updates:
    path.write_text(content)
PY
```

No value in this payload is an identical protocol/product token. Leave `apps/web/src/lib/i18n/translationCoverage.test.ts` unchanged: this task adds no duplicate allowance, exemption set, exemption logic, exemption test, or namespace-baseline increase. W01a’s existing token-only baseline adjustments remain intact.

- [ ] Run `cd apps/web && npx vitest run src/lib/i18n/translationCoverage.test.ts src/lib/i18n/localeParity.test.ts src/lib/i18n/keyUsage.test.ts`; expected PASS with all 51 keys translated in each non-English catalog.

Implement `TimeSyncTab.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { Clock } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  TIME_SYNC_DEFAULTS,
  timeSyncInlineSettingsSchema,
} from '@breeze/shared';
import { type FeatureTabProps } from './types';
import { useFeatureLink } from './useFeatureLink';
import FeatureTabShell from './FeatureTabShell';
import TimezoneSelect from '../../shared/TimezoneSelect';
import '@/lib/i18n';
function readSettings(value: unknown) {
  const parsed = timeSyncInlineSettingsSchema.safeParse(
    value ?? TIME_SYNC_DEFAULTS,
  );
  return parsed.success ? parsed.data : timeSyncInlineSettingsSchema.parse({});
}
export default function TimeSyncTab({
  policyId,
  existingLink,
  parentLink,
  linkedPolicyId,
  onLinkChanged,
}: FeatureTabProps) {
  const { t } = useTranslation('devices');
  const { save, remove, saving, error, clearError } = useFeatureLink(policyId);
  const initial = readSettings((existingLink ?? parentLink)?.inlineSettings);
  const [enforceNtp, setEnforceNtp] = useState(initial.enforceNtp);
  const [servers, setServers] = useState(initial.ntpServers.join('\n'));
  const [interval, setInterval] = useState(String(initial.pollIntervalMinutes));
  const [expected, setExpected] = useState<'site' | 'pinned'>(
    initial.timezone.expected,
  );
  const [pin, setPin] = useState(initial.timezone.pinnedTimezone ?? '');
  const [autoFix, setAutoFix] = useState(initial.timezone.autoFix);
  useEffect(() => {
    const next = readSettings((existingLink ?? parentLink)?.inlineSettings);
    setEnforceNtp(next.enforceNtp);
    setServers(next.ntpServers.join('\n'));
    setInterval(String(next.pollIntervalMinutes));
    setExpected(next.timezone.expected);
    setPin(next.timezone.pinnedTimezone ?? '');
    setAutoFix(next.timezone.autoFix);
  }, [existingLink, parentLink]);
  const parsed = timeSyncInlineSettingsSchema.safeParse({
    enforceNtp,
    ntpServers: servers
      .split('\n')
      .map((value) => value.trim())
      .filter(Boolean),
    pollIntervalMinutes: interval === '' ? NaN : Number(interval),
    timezone: { expected, pinnedTimezone: pin || null, autoFix },
  });
  const inherited = !!parentLink && !existingLink;
  const persist = async (id: string | null) => {
    if (!parsed.success) return;
    clearError();
    const result = await save(id, {
      featureType: 'time_sync',
      featurePolicyId: null,
      inlineSettings: { ...parsed.data },
    });
    if (result) onLinkChanged(result, 'time_sync');
  };
  const discard = async () => {
    if (existingLink && (await remove(existingLink.id)))
      onLinkChanged(null, 'time_sync');
  };
  const errors = parsed.success
    ? []
    : [
        ...new Set(
          parsed.error.issues.map((issue) =>
            issue.path[0] === 'ntpServers'
              ? t('timeSync.management.invalidServers')
              : issue.path[0] === 'pollIntervalMinutes'
                ? t('timeSync.management.invalidInterval')
                : t('timeSync.management.invalidZone'),
          ),
        ),
      ];
  return (
    <FeatureTabShell
      title={t('timeSync.management.title')}
      description={t('timeSync.management.description')}
      icon={<Clock className="h-5 w-5" />}
      isConfigured={!!existingLink || inherited}
      saving={saving}
      saveDisabled={!parsed.success}
      error={error}
      onSave={() => void persist(existingLink?.id ?? null)}
      onRemove={existingLink && !linkedPolicyId ? discard : undefined}
      isInherited={inherited}
      onOverride={inherited ? () => void persist(null) : undefined}
      onRevert={
        !inherited && !!linkedPolicyId && !!existingLink ? discard : undefined
      }
    >
      <p className="mb-4 text-sm text-muted-foreground">
        {t('timeSync.management.domainRule')}
      </p>
      <p className="mb-4 text-sm text-muted-foreground">
        {t('timeSync.management.gpoWins')}
      </p>
      <fieldset disabled={inherited || saving} className="space-y-4">
        <label className="flex items-center gap-2">
          <input
            data-testid="time-sync-enforce-ntp"
            type="checkbox"
            role="switch"
            checked={enforceNtp}
            onChange={(e) => setEnforceNtp(e.target.checked)}
          />
          {t('timeSync.management.enforceNtp')}
        </label>
        <label className="block text-sm">
          {t('timeSync.management.ntpServers')}
          <textarea
            data-testid="time-sync-servers"
            value={servers}
            onChange={(e) => setServers(e.target.value)}
            className="mt-2 block w-full rounded-md border bg-background p-3"
          />
        </label>
        <label className="block text-sm">
          {t('timeSync.management.pollInterval')}
          <input
            data-testid="time-sync-interval"
            type="number"
            min={15}
            max={1440}
            step={1}
            value={interval}
            onChange={(e) => setInterval(e.target.value)}
            className="mt-2 block h-10 w-full rounded-md border bg-background px-3"
          />
        </label>
        <label className="block text-sm">
          {t('timeSync.management.expectedTimezone')}
          <select
            data-testid="time-sync-expected"
            value={expected}
            onChange={(e) => setExpected(e.target.value as 'site' | 'pinned')}
            className="mt-2 block h-10 w-full rounded-md border bg-background px-3"
          >
            <option value="site">{t('timeSync.management.site')}</option>
            <option value="pinned">{t('timeSync.management.pinned')}</option>
          </select>
        </label>
        {expected === 'pinned' && (
          <>
            <TimezoneSelect
              value={pin}
              onChange={setPin}
              label={t('timeSync.management.pinnedZone')}
              testId="time-sync-pinned-zone"
            />
            <p className="text-sm text-muted-foreground">
              {t('timeSync.management.pinOverrides')}
            </p>
          </>
        )}
        <label className="flex items-center gap-2">
          <input
            data-testid="time-sync-auto-fix"
            type="checkbox"
            role="switch"
            checked={autoFix}
            onChange={(e) => setAutoFix(e.target.checked)}
          />
          {t('timeSync.management.autoFix')}
        </label>
        {errors.length > 0 && (
          <ul role="alert" className="text-sm text-destructive">
            {errors.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        )}
      </fieldset>
    </FeatureTabShell>
  );
}
```

`TimezoneSelect` has no `disabled` prop; the inherited fieldset supplies it. The NTP textarea splits only newlines, so embedded spaces/flags remain invalid. Save happens through the existing page-shell Save action, never mixed autosave.

At `featureTabs/types.ts:1`, add the named export import (the module has no default export):

```ts
import { i18n } from '@/lib/i18n';
```

After the hardware metadata at `:87`, append:

```ts
  time_sync: {
    get label() {
      return i18n.t('devices:timeSync.management.title');
    },
    fetchUrl: null,
    get description() {
      return i18n.t('devices:timeSync.management.description');
    },
  },
```

At `ConfigPolicyDetailPage.tsx:63` preserve the hardware import and append:

```ts
import TimeSyncTab from './featureTabs/TimeSyncTab';
```

Add `Clock,` to its lucide import at `:2–26`. Replace the exact icon anchor `hardware_monitoring: <HardDrive className="h-4 w-4" />,` at `:127` with itself followed by `time_sync: <Clock className="h-4 w-4" />,`. After the exact existing render case at `:476`, append:

```tsx
  case 'time_sync':
    return <TimeSyncTab {...props} />;
```

At `DeviceEffectiveConfigTab.tsx:2`, import `Clock` from the existing lucide import, and import `{ i18n }` from `../../lib/i18n` beside its existing initialization import at `:29`. Append after hardware metadata at `:133`:

```ts
  time_sync: {
    get label() {
      return i18n.t('devices:timeSync.management.title');
    },
    Icon: Clock,
  },
```

Keep the existing derived feature-type arrays and hash tab behavior. Do not add `time_sync` to hardware's always-applied default exceptions; Task 3 marks time enforcement off when unassigned.

- [ ] Repeat the three-file command, plus `cd apps/web && npx vitest run src/components/configurationPolicies/featureTabs/useFeatureLink.test.ts`. Expected PASS for both parity suites, validated saves and inherited controls.
- [ ] Commit:

```bash
git add apps/web/src/components/configurationPolicies/featureTabs/TimeSyncTab.tsx apps/web/src/components/configurationPolicies/featureTabs/TimeSyncTab.test.tsx apps/web/src/components/configurationPolicies/featureTabs/types.ts apps/web/src/components/configurationPolicies/ConfigPolicyDetailPage.tsx apps/web/src/components/configurationPolicies/featureTabs/useFeatureLink.test.ts apps/web/src/components/devices/DeviceEffectiveConfigTab.tsx apps/web/src/locales/en/devices.json apps/web/src/locales/de-DE/devices.json apps/web/src/locales/es-419/devices.json apps/web/src/locales/fr-CA/devices.json apps/web/src/locales/fr-FR/devices.json apps/web/src/locales/it-IT/devices.json apps/web/src/locales/pt-BR/devices.json apps/web/src/locales/tr-TR/devices.json
git commit -m "feat(time-sync): add inheritable time policy editor" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 10: Queue individual and fleet commands with per-device outcomes

**Files:** Modify `apps/web/src/services/deviceActions.ts:86–103`; Create `apps/web/src/components/devices/time/TimeSyncActions.tsx`, `TimeSyncActions.test.tsx`; dependency modifications `DeviceTimeSection.tsx`, `FleetTimeSyncReport.tsx` (index §I, no current lines).

**Interfaces:** Existing `sendDeviceCommand(deviceId: string, type: string, payload?: Record<string, unknown>): Promise<CommandResult>` parses HTTP responses (`deviceActions.ts:86–103`). Expose its underlying request as `requestDeviceCommand(deviceId: string, type: string, payload?: Record<string, unknown>): Promise<Response>` for `runAction` (`lib/runAction.ts:24,84`). New component consumes `{ targets: Array<{ deviceId: string; name: string }>; bulk?: boolean }`; bulk selection is local to the current page, and each set-timezone action reads the latest server-resolved device view first.

- [ ] Write `TimeSyncActions.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import '@/lib/i18n';
vi.mock('@/stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../../shared/Toast', () => ({ showToast: vi.fn() }));
import { fetchWithAuth } from '@/stores/auth';
import { navigateTo } from '@/lib/navigation';
import { showToast } from '../../shared/Toast';
import TimeSyncActions from './TimeSyncActions';
const targets = [
  { deviceId: 'a', name: 'Device A' },
  { deviceId: 'b', name: 'Device B' },
];
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });
beforeEach(() => {
  vi.clearAllMocks();
});
it('queues resync and apply through the single-device command route', async () => {
  vi.mocked(fetchWithAuth).mockImplementation(async () =>
    response({ command: { id: 'cmd', delivery: 'delivered' } }, 201),
  );
  render(<TimeSyncActions targets={[targets[0]!]} />);
  fireEvent.click(screen.getByTestId('time-sync-resync'));
  await waitFor(() =>
    expect(screen.getByTestId('time-sync-outcome-a').textContent).toContain(
      'Delivered — awaiting execution',
    ),
  );
  expect(fetchWithAuth).toHaveBeenLastCalledWith(
    '/devices/a/commands',
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ type: 'time_resync', payload: {} }),
    }),
  );
  fireEvent.click(screen.getByTestId('time-sync-apply-policy'));
  await waitFor(() =>
    expect(fetchWithAuth).toHaveBeenLastCalledWith(
      '/devices/a/commands',
      expect.objectContaining({
        body: JSON.stringify({ type: 'time_apply_policy', payload: {} }),
      }),
    ),
  );
});
it('resolves a separate expected zone for each selected device and keeps partial failures', async () => {
  vi.mocked(fetchWithAuth).mockImplementation(async (url, options) => {
    if (!options?.method)
      return response({
        timezone: {
          expected: {
            windowsId: url.includes('/a/') ? 'UTC' : 'Eastern Standard Time',
          },
        },
      });
    return url.includes('/a/')
      ? response({ command: { id: 'cmd', delivery: 'queued_offline' } }, 201)
      : response({ error: 'Denied' }, 403);
  });
  render(<TimeSyncActions targets={targets} bulk />);
  fireEvent.click(screen.getByTestId('time-sync-select-a'));
  fireEvent.click(screen.getByTestId('time-sync-select-b'));
  fireEvent.click(screen.getByTestId('time-sync-set-timezone'));
  await waitFor(() =>
    expect(screen.getByTestId('time-sync-outcome-b').textContent).toContain(
      'Denied',
    ),
  );
  expect(screen.getByTestId('time-sync-outcome-a').textContent).toContain(
    'expires after 1 hour',
  );
  const posts = vi
    .mocked(fetchWithAuth)
    .mock.calls.filter(([, init]) => init?.method === 'POST');
  expect(
    posts.map(([url, init]) => [url, JSON.parse(String(init!.body))]),
  ).toEqual([
    [
      '/devices/a/commands',
      { type: 'time_set_timezone', payload: { windowsId: 'UTC' } },
    ],
    [
      '/devices/b/commands',
      {
        type: 'time_set_timezone',
        payload: { windowsId: 'Eastern Standard Time' },
      },
    ],
  ]);
});
it('shows a skipped row when the server has no expected zone', async () => {
  vi.mocked(fetchWithAuth).mockImplementation(async () =>
    response({ timezone: { expected: null } }),
  );
  render(<TimeSyncActions targets={[targets[0]!]} />);
  fireEvent.click(screen.getByTestId('time-sync-set-timezone'));
  await waitFor(() =>
    expect(screen.getByTestId('time-sync-outcome-a').textContent).toContain(
      'Skipped — no expected timezone',
    ),
  );
  expect(fetchWithAuth).toHaveBeenCalledTimes(1);
});
it('surfaces an HTTP-200 failed body without calling it queued', async () => {
  vi.mocked(fetchWithAuth).mockImplementation(async () =>
    response({ success: false, error: 'Rejected' }),
  );
  render(<TimeSyncActions targets={[targets[0]!]} />);
  fireEvent.click(screen.getByTestId('time-sync-resync'));
  await waitFor(() =>
    expect(screen.getByTestId('time-sync-outcome-a').textContent).toContain(
      'Rejected',
    ),
  );
  expect(showToast).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'error' }),
  );
  expect(showToast).not.toHaveBeenCalledWith(
    expect.objectContaining({ type: 'success' }),
  );
});
it('redirects on 401 and stops sending commands', async () => {
  vi.mocked(fetchWithAuth).mockImplementation(async () => response({}, 401));
  render(<TimeSyncActions targets={targets} bulk />);
  fireEvent.click(screen.getByTestId('time-sync-select-a'));
  fireEvent.click(screen.getByTestId('time-sync-select-b'));
  fireEvent.click(screen.getByTestId('time-sync-resync'));
  await waitFor(() =>
    expect(navigateTo).toHaveBeenCalledWith('/login', { replace: true }),
  );
  expect(fetchWithAuth).toHaveBeenCalledTimes(1);
  expect(showToast).not.toHaveBeenCalled();
});
```

- [ ] Run: `cd apps/web && npx vitest run src/components/devices/time/TimeSyncActions.test.tsx`. Expected FAIL: missing component.
- [ ] Replace `sendDeviceCommand` at `deviceActions.ts:86–103` with the following two complete functions. The original request anchor is `const body = payload ? { type, payload } : { type };` and the interpolated command URL; keep its error behavior for existing callers:

```ts
export function requestDeviceCommand(
  deviceId: string,
  type: string,
  payload?: Record<string, unknown>,
): Promise<Response> {
  const body = payload ? { type, payload } : { type };
  return fetchWithAuth(`/devices/${deviceId}/commands`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}
export async function sendDeviceCommand(
  deviceId: string,
  type: string,
  payload?: Record<string, unknown>,
): Promise<CommandResult> {
  const response = await requestDeviceCommand(deviceId, type, payload);
  if (!response.ok)
    throw new Error(
      await getErrorMessage(response, 'Failed to send device command'),
    );
  const data = await response.json();
  return data.command ?? data.data ?? data;
}
```

Implement `TimeSyncActions.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isKnownWindowsZone } from '@breeze/shared';
import { fetchWithAuth } from '@/stores/auth';
import { navigateTo } from '@/lib/navigation';
import { ActionError, runAction } from '@/lib/runAction';
import { extractApiError } from '@/lib/apiError';
import {
  requestDeviceCommand,
  type CommandResult,
} from '../../../services/deviceActions';
import { showToast } from '../../shared/Toast';
import '@/lib/i18n';
export interface TimeSyncTarget {
  deviceId: string;
  name: string;
}
type TimeCommand = 'time_resync' | 'time_set_timezone' | 'time_apply_policy';
type Outcome = {
  deviceId: string;
  name: string;
  message: string;
  failed: boolean;
};
export default function TimeSyncActions({
  targets,
  bulk = false,
}: {
  targets: TimeSyncTarget[];
  bulk?: boolean;
}) {
  const { t } = useTranslation('devices');
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  const targetIds = targets.map((target) => target.deviceId).join(',');
  useEffect(() => {
    setSelected((ids) => ids.filter((id) => targetIds.split(',').includes(id)));
  }, [targetIds]);
  const chosen = bulk
    ? targets.filter((target) => selected.includes(target.deviceId))
    : targets;
  const queue = async (type: TimeCommand) => {
    if (busy || chosen.length === 0) return;
    const work = [...chosen];
    setBusy(true);
    setOutcomes([]);
    try {
      for (const target of work) {
        try {
          let payload: Record<string, unknown> = {};
          if (type === 'time_set_timezone') {
            const res = await fetchWithAuth(
              `/devices/${target.deviceId}/time-status`,
            );
            if (res.status === 401) {
              void navigateTo('/login', { replace: true });
              return;
            }
            const body = await res.json();
            if (!res.ok)
              throw new Error(
                extractApiError(body, t('timeSync.actions.failed')),
              );
            const view = body.data ?? body;
            const windowsId = view.timezone?.expected?.windowsId;
            if (
              typeof windowsId !== 'string' ||
              !isKnownWindowsZone(windowsId)
            ) {
              setOutcomes((rows) => [
                ...rows,
                {
                  ...target,
                  message: t('timeSync.actions.noExpected'),
                  failed: false,
                },
              ]);
              continue;
            }
            payload = { windowsId };
          }
          const command = await runAction<CommandResult>({
            request: () => requestDeviceCommand(target.deviceId, type, payload),
            errorFallback: t('timeSync.actions.failed'),
            successMessage: t('timeSync.actions.queued'),
            onUnauthorized: () => {
              void navigateTo('/login', { replace: true });
            },
            parseSuccess: (value) => {
              const body = value as {
                command?: CommandResult;
                data?: CommandResult;
              };
              return body.command ?? body.data ?? (value as CommandResult);
            },
          });
          const message =
            command.delivery === 'queued_offline'
              ? t('timeSync.actions.offline')
              : command.delivery === 'delivered'
                ? t('timeSync.actions.delivered')
                : t('timeSync.actions.awaiting');
          setOutcomes((rows) => [
            ...rows,
            { ...target, message, failed: false },
          ]);
        } catch (error) {
          if (error instanceof ActionError && error.status === 401) return;
          const message =
            error instanceof Error
              ? error.message
              : t('timeSync.actions.failed');
          if (!(error instanceof ActionError))
            showToast({ type: 'error', message });
          setOutcomes((rows) => [
            ...rows,
            { ...target, message, failed: true },
          ]);
        }
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3" data-testid="time-sync-actions">
      {bulk && (
        <fieldset
          disabled={busy}
          className="max-h-48 overflow-auto rounded-md border p-3"
        >
          <legend className="text-sm">{t('timeSync.actions.select')}</legend>
          {targets.map((target) => (
            <label key={target.deviceId} className="flex items-center gap-2">
              <input
                type="checkbox"
                data-testid={`time-sync-select-${target.deviceId}`}
                checked={selected.includes(target.deviceId)}
                onChange={(event) =>
                  setSelected((ids) =>
                    event.target.checked
                      ? [...ids, target.deviceId]
                      : ids.filter((id) => id !== target.deviceId),
                  )
                }
              />
              {target.name}
            </label>
          ))}
        </fieldset>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          data-testid="time-sync-resync"
          disabled={busy || chosen.length === 0}
          onClick={() => void queue('time_resync')}
          className="rounded-md border px-3 py-2 text-sm disabled:opacity-50"
        >
          {t(bulk ? 'timeSync.actions.bulkResync' : 'timeSync.actions.resync')}
        </button>
        <button
          type="button"
          data-testid="time-sync-set-timezone"
          disabled={busy || chosen.length === 0}
          onClick={() => void queue('time_set_timezone')}
          className="rounded-md border px-3 py-2 text-sm disabled:opacity-50"
        >
          {t(
            bulk
              ? 'timeSync.actions.bulkSetTimezone'
              : 'timeSync.actions.setTimezone',
          )}
        </button>
        {!bulk && (
          <button
            type="button"
            data-testid="time-sync-apply-policy"
            disabled={busy || chosen.length === 0}
            onClick={() => void queue('time_apply_policy')}
            className="rounded-md border px-3 py-2 text-sm disabled:opacity-50"
          >
            {t('timeSync.actions.applyPolicy')}
          </button>
        )}
      </div>
      <ul
        aria-live="polite"
        aria-label={t('timeSync.actions.outcomes')}
        className="space-y-1"
      >
        {outcomes.map((outcome) => (
          <li
            key={outcome.deviceId}
            data-testid={`time-sync-outcome-${outcome.deviceId}`}
            className={outcome.failed ? 'text-sm text-destructive' : 'text-sm'}
          >
            {outcome.name}: {outcome.message}
          </li>
        ))}
      </ul>
    </div>
  );
}
```

The single-device action uses the server's latest expected zone, not a client conversion or stale policy edit. Commands are sequential per selection to limit pressure and stop cleanly on auth expiry. Failed targets do not cancel later targets. A new click resets outcomes; there is no automatic replay/retry of a time mutation.

Dependency parent integrations use the concrete sibling plan projections available during authoring, and still require verification against the actual merged files (Contract issue 1).

In `DeviceTimeSection.tsx`, import `TimeSyncActions` from `./TimeSyncActions`. The current W01a Task 9 reported-branch anchor is:

```tsx
    <TimeEventsList events={data.recentEvents} />
```

Replace it with:

```tsx
    <TimeSyncActions
      targets={[{ deviceId: data.deviceId, name: deviceName ?? deviceId }]}
    />
    <TimeEventsList events={data.recentEvents} />
```

In `FleetTimeSyncReport.tsx`, import `TimeSyncActions` from `./TimeSyncActions`. The W02 projection defines `result: FleetTimeResult | null`, and `FleetTimeRow` carries `deviceId`, `hostname` and `view` (W02 fleet service and component tasks). Immediately after this success-branch anchor from W02's `FleetTimeSyncReport.tsx` (the parenthesized
expression, then the fragment on the next line):

```tsx
      {!loading && !error && result && (
        <>
```

insert, as the first child inside that fragment:

```tsx
    <TimeSyncActions
      bulk
      targets={result.data
        .filter((row) => row.view.state === 'reported')
        .map((row) => ({ deviceId: row.deviceId, name: row.hostname }))}
    />
```

This selects current-page device rows, not domain aggregate rows. The selection drops IDs filtered off that page and does not include unreported/unsupported devices. The fleet's filter/view URL remains its existing hash state. No `?tab=` or new route is added.

- [ ] Repeat the action test command; expected PASS. Run `cd apps/web && npx vitest run src/services/deviceActions.test.ts src/lib/__tests__/no-silent-mutations.test.ts`. Expected PASS; the extracted request remains a typed service-layer helper, while all new UI writes go through `runAction`.
- [ ] Commit:

```bash
git add apps/web/src/services/deviceActions.ts apps/web/src/components/devices/time/TimeSyncActions.tsx apps/web/src/components/devices/time/TimeSyncActions.test.tsx apps/web/src/components/devices/time/DeviceTimeSection.tsx apps/web/src/components/devices/time/FleetTimeSyncReport.tsx
git commit -m "feat(time-sync): add device and fleet management actions" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 11: Display enforcement results and policy timezone provenance

**Files:** Create `apps/web/src/components/devices/time/TimeSyncEnforcement.tsx`, `TimeSyncEnforcement.test.tsx`; dependency modifications `DeviceTimeSection.tsx`, `types.ts` (index §§C.6/I).

**Interfaces:** Consumes `TimeSyncEnforcementState | null` from §F.3, exactly shared with the API. Produces a read-only result display, never another settings editor.

- [ ] Write `TimeSyncEnforcement.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import '@/lib/i18n';
import TimeSyncEnforcement from './TimeSyncEnforcement';
it('shows no result without implying successful enforcement', () => {
  render(<TimeSyncEnforcement report={null} />);
  expect(screen.getByText('No enforcement result reported yet')).toBeTruthy();
});
it('renders outcome, reason, before, after, time and error for each kind', () => {
  render(
    <TimeSyncEnforcement
      report={{
        ntp: {
          resultId: '11111111-1111-4111-8111-111111111111',
          fingerprint: 'sha256:test',
          at: '2026-09-28T12:00:00Z',
          outcome: 'failed',
          reason: 'readback_mismatch',
          before: { type: 'NoSync' },
          after: { type: 'NTP' },
          error: 'readback failed',
        },
        timezone: null,
      }}
    />,
  );
  expect(screen.getByTestId('time-sync-enforcement-ntp').textContent).toContain(
    'Read-back did not match',
  );
  expect(screen.getByText('readback failed')).toBeTruthy();
  expect(screen.getByTestId('time-sync-before-ntp').textContent).toContain(
    'NoSync',
  );
  expect(screen.getByTestId('time-sync-after-ntp').textContent).toContain(
    'NTP',
  );
  expect(
    screen.getByTestId('time-sync-enforcement-at-ntp').getAttribute('datetime'),
  ).toBe('2026-09-28T12:00:00Z');
});
it('shows Group Policy conflict as skipped', () => {
  render(
    <TimeSyncEnforcement
      report={{
        ntp: {
          resultId: '11111111-1111-4111-8111-111111111111',
          fingerprint: 'sha256:test',
          at: '2026-09-28T12:00:00Z',
          outcome: 'skipped',
          reason: 'conflict_gpo',
          before: {},
          after: {},
          error: null,
        },
        timezone: null,
      }}
    />,
  );
  expect(
    screen.getByText('Skipped because Group Policy takes precedence'),
  ).toBeTruthy();
});
```

- [ ] Run: `cd apps/web && npx vitest run src/components/devices/time/TimeSyncEnforcement.test.tsx`. Expected FAIL: missing component.
- [ ] Implement `TimeSyncEnforcement.tsx`:

```tsx
import { useTranslation } from 'react-i18next';
import type { TimeSyncEnforcementState } from '@breeze/shared';
import '@/lib/i18n';
export default function TimeSyncEnforcement({
  report,
}: {
  report: TimeSyncEnforcementState | null;
}) {
  const { t } = useTranslation('devices');
  const outcomes = {
    ok: t('timeSync.enforcement.ok'),
    failed: t('timeSync.enforcement.failed'),
    skipped: t('timeSync.enforcement.skipped'),
  };
  const reasons = {
    applied: t('timeSync.enforcement.applied'),
    already_compliant: t('timeSync.enforcement.already_compliant'),
    role_unknown: t('timeSync.enforcement.role_unknown'),
    conflict_gpo: t('timeSync.enforcement.conflict_gpo'),
    readback_mismatch: t('timeSync.enforcement.readback_mismatch'),
    exec_failed: t('timeSync.enforcement.exec_failed'),
    invalid_settings: t('timeSync.enforcement.invalid_settings'),
    auto_timezone_on: t('timeSync.enforcement.auto_timezone_on'),
    no_expected_timezone: t('timeSync.enforcement.no_expected_timezone'),
  };
  if (!report?.ntp && !report?.timezone)
    return (
      <p className="text-sm text-muted-foreground">
        {t('timeSync.enforcement.none')}
      </p>
    );
  return (
    <section aria-label={t('timeSync.enforcement.title')} className="space-y-3">
      <h4 className="font-medium">{t('timeSync.enforcement.title')}</h4>
      {(['ntp', 'timezone'] as const).map((kind) => {
        const result = report?.[kind];
        if (!result) return null;
        const color =
          result.outcome === 'failed'
            ? 'bg-destructive/15 text-destructive border-destructive/30'
            : result.outcome === 'skipped'
              ? 'bg-warning/15 text-warning border-warning/30'
              : 'bg-success/15 text-success border-success/30';
        return (
          <article
            key={kind}
            data-testid={`time-sync-enforcement-${kind}`}
            className="rounded-md border p-3"
          >
            <div className="flex flex-wrap items-center gap-2">
              <h5>
                {kind === 'ntp'
                  ? t('timeSync.enforcement.ntp')
                  : t('timeSync.enforcement.timezone')}
              </h5>
              <span
                className={`rounded-full border px-2 py-0.5 text-xs ${color}`}
              >
                {outcomes[result.outcome]}
              </span>
            </div>
            <p className="text-sm">{reasons[result.reason]}</p>
            <p className="text-sm text-muted-foreground">
              {t('timeSync.enforcement.reportedAt')}:{' '}
              <time
                data-testid={`time-sync-enforcement-at-${kind}`}
                dateTime={result.at}
              >
                {new Date(result.at).toLocaleString()}
              </time>
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <h6 className="text-sm font-medium">
                  {t('timeSync.enforcement.before')}
                </h6>
                <pre
                  data-testid={`time-sync-before-${kind}`}
                  className="overflow-auto whitespace-pre-wrap break-words text-xs"
                >
                  {JSON.stringify(result.before, null, 2)}
                </pre>
              </div>
              <div>
                <h6 className="text-sm font-medium">
                  {t('timeSync.enforcement.after')}
                </h6>
                <pre
                  data-testid={`time-sync-after-${kind}`}
                  className="overflow-auto whitespace-pre-wrap break-words text-xs"
                >
                  {JSON.stringify(result.after, null, 2)}
                </pre>
              </div>
            </div>
            {result.error && (
              <p className="break-words text-sm text-destructive">
                {result.error}
              </p>
            )}
          </article>
        );
      })}
    </section>
  );
}
```

In dependency `types.ts`, verify the W01a `enforcement` field matches the following exact shared type; replace a narrower field if the merged implementation differs:

```ts
  enforcement: import('@breeze/shared').TimeSyncEnforcementState | null;
```

This imports the exact report shape; do not invent a simplified `status` string or make result IDs optional. In `DeviceTimeSection.tsx`, import `TimeSyncEnforcement` and add it beside Task 10 actions in the reported branch:

```tsx
    <TimeSyncEnforcement report={data.enforcement} />
```

The current W01a `DeviceTimeSection.tsx` already renders exactly one provenance paragraph and supplies the parent view to `findingCopy` (R3). Preserve this complete block unchanged; its `timeSync.expectedPolicy` translations already say the policy overrides the site timezone. Do not insert a second policy-source paragraph from an older projection:

```tsx
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
```

Keep W01a's `findingCopy(t, finding, deviceName ?? deviceId, expected ?? null)` call, site provenance and UTC-default/unmapped copy. The historical enforcement result time remains visible even if the overall status is stale or enforcement was later disabled.

- [ ] Repeat the component test; expected PASS. Run `cd apps/web && npx vitest run src/components/devices/time/DeviceTimeSection.test.tsx src/components/devices/time/DeviceTimeSection.integration.test.tsx src/components/devices/time/FleetTimeSyncReport.test.tsx` (filenames confirmed in the sibling W01a/W02 projections). Expected PASS; unsupported/unreported branches retain their existing empty states.
- [ ] Commit:

```bash
git add apps/web/src/components/devices/time/TimeSyncEnforcement.tsx apps/web/src/components/devices/time/TimeSyncEnforcement.test.tsx apps/web/src/components/devices/time/DeviceTimeSection.tsx apps/web/src/components/devices/time/types.ts
git commit -m "feat(time-sync): show enforcement evidence and timezone provenance" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 12: Document management, record settings ownership, and verify contracts

**Files:** Modify dependency `apps/docs/src/content/docs/features/time-sync.mdx` (append management section after W02 evidence documentation; no current source line); Create/Test `apps/web/src/components/devices/time/timeSyncManagementDocs.test.ts`.

**Interfaces:** Consumes the completed settings, command and result interfaces from Tasks 1–11. Produces customer documentation and a concrete PR-description settings statement. Verification consumes the existing tenancy suites, including parent-chain RLS coverage.

- [ ] Write the failing documentation/copy test:

```ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
const read = (path: string) =>
  readFileSync(resolve(process.cwd(), path), 'utf8');
it('documents management without claiming queue acceptance is enforcement', () => {
  const docs = read('../docs/src/content/docs/features/time-sync.mdx');
  for (const phrase of [
    'Configuration Policies',
    'overrides the site timezone',
    'Group Policy',
    'forest-root PDC',
    'Entra-only',
    'domain hierarchy',
    'one hour',
    'does not restore',
    'agent update',
    'Queued is not applied',
  ])
    expect(docs).toContain(phrase);
});
it('ships the same management, action and result keys in all eight locales', () => {
  const english = JSON.parse(read('src/locales/en/devices.json')).timeSync;
  for (const locale of [
    'de-DE',
    'es-419',
    'fr-CA',
    'fr-FR',
    'it-IT',
    'pt-BR',
    'tr-TR',
  ]) {
    const copy = JSON.parse(
      read(`src/locales/${locale}/devices.json`),
    ).timeSync;
    for (const section of ['management', 'actions', 'enforcement'])
      expect(Object.keys(copy[section]).sort()).toEqual(
        Object.keys(english[section]).sort(),
      );
  }
  expect(english.management.pinOverrides).toBe(
    'The pinned timezone overrides the site timezone.',
  );
  expect(english.management.policySource).toContain(
    'overrides the site timezone',
  );
  expect(english.actions.offline).toContain('1 hour');
});
```

- [ ] Run: `cd apps/web && npx vitest run src/components/devices/time/timeSyncManagementDocs.test.ts`. Expected FAIL: management documentation is absent on W02's visibility/evidence page.
- [ ] Append this full MDX section to `time-sync.mdx`:

```mdx
## Manage Windows time settings

Open **Configuration Policies → Time sync**. A policy can belong to one
organization or be shared across all organizations in a partner. Assignment
inheritance chooses the effective policy for each device. Use the policy tab's
Save button to save changes; an inherited tab can be overridden or reverted.

Time synchronization enforcement and automatic timezone correction start off.
Collection and findings continue independently of enforcement.

### Domain-aware NTP enforcement

Enable **Enforce time synchronization**, enter up to five NTP hosts, and choose
an integer poll interval from 15 to 1440 minutes. Enter one host per line,
without ports, command flags or W32Time peer flags. Breeze adds the necessary
peer flags on the device.

Workgroup devices, Entra-only devices and the forest-root PDC use the policy's
NTP servers. Domain members, domain controllers and other PDC emulators use
the domain hierarchy. A device with an unknown domain role is skipped.

**Group Policy takes precedence.** Breeze does not change W32Time settings
managed by Group Policy. A reported conflict is informational; correct the
owning Group Policy if a different policy should apply.

### Expected timezone

The default is **Follow site timezone**. A site still using the UTC default
has no expected timezone, so it does not generate a timezone mismatch.
There is no organization or partner timezone fallback.

Use **Pin a timezone** for a device that should use a different zone, such as
a server intentionally running in UTC. The pinned timezone overrides the site timezone. The device's Time section
names the policy providing that pin.

**Automatically correct the timezone** is an explicit opt-in. It uses the
expected zone, and skips correction when Windows automatic timezone is on.
An unknown or unmapped expected zone is never guessed.

### Run a time action

In a Windows device's **Info → Time** section:

- **Resync** starts W32Time if necessary and requests resynchronization.
- **Set timezone to expected** uses the current server-resolved expected zone.
  Devices with no expected zone are shown as skipped.
- **Apply time policy now** asks the agent to reconcile immediately, bypassing
  its normal rate limit. The agent still checks domain role and Group Policy.

The fleet **Reporting → Time sync** page can resync selected devices or set each
selected device to its own expected timezone. The outcome list keeps a
separate result for every selected device, including skipped and failed ones.
Offline commands expire after one hour. A delivered command has up to
60 seconds to execute.

**Queued is not applied.** Queue acceptance means the API accepted the command,
not that Windows changed. The latest enforcement result shows the observed
outcome, its time, the reason, and before/after values. Each new result is
recorded in the device audit trail. Wait for an updated observation to confirm
the requested state.

Management requires the agent update that includes time-sync reconciliation
and handlers. The management API and policy editor can ship before that agent
update; older agents do not apply these settings or execute the new actions.

### Removing enforcement

Disabling enforcement or removing the policy stops future reconciliation once
the updated settings reach the device. It does not restore the previous Windows
configuration. Settings delivery can use a cache for up to 120 seconds; the
agent applies changes on its next reconciliation. A temporary resolver failure
leaves the agent's previous settings in place until a successful delivery.

Normal reconciliation is limited to one apply per hour for an unchanged
settings fingerprint; failures back off up to 24 hours. A changed fingerprint
resets that limit. The immediate policy action bypasses the timer, not the
Group Policy or domain-role guards.

### Alert on enforcement failures

The built-in **Time policy not applied** monitor reports the
`policy_not_applied` finding after two accepted snapshots. Its default severity
is low. Like other built-in monitors it is provisioned without an assignment;
attach it to a configuration policy to enable alert evaluation. GPO conflicts
remain separately visible as `policy_conflict_gpo`.

Evidence remains observed synchronization reported by the agent. These controls
do not measure clock offset against Breeze and do not set the clock directly.
```

The literal sentence containing “overrides the site timezone” is kept on one line for copy verification and operator clarity.

- [ ] Run the documentation test again; expected PASS. Run `pnpm --filter @breeze/docs check` and `pnpm --filter @breeze/docs build`; expected no errors and the existing time-sync route still generated.
- [ ] Put the following **exact statement** in the implementation PR description, as required by `CLAUDE.md:165–168` and spec §8.1 (`:471–477`):

> Home: Configuration Policies → Time sync tab. Level: partner-wide or org policy through normal policy inheritance. Resolver: `resolveDeviceTimeSyncSettings`. NTP configuration is configured in 0 places before and 1 after. The expected timezone is configured in 1 place before (site) and 2 after (site, and policy `pinned`). This is a stated exception: the pin exists for devices that should not follow their site (UTC servers), and both the policy tab and the device Time section say "overrides the site timezone" wherever it applies. No removal plan: the two are different concepts (where a site is vs. what a device should run).

PR description also states: API/web only; W03b owns elevated agent handlers and lab L6–L8; no claim of a completed Windows lab run; commands can queue before supporting agents are released. Per the locale README, include:

```text
pt-BR strings are machine-drafted pending native review
es-419, fr-FR, fr-CA, de-DE, it-IT, and tr-TR strings are machine-drafted pending native review
```

All seven non-English catalogs contain actual translations, including `tr-TR`; machine-drafted translations are not represented as native-reviewed.

- [ ] Execute final tenancy verification against the test stack started in Task 2. Each command starts at repository root unless it has an explicit subshell. The subshell keeps later paths deterministic. Do not run these commands while merely writing this plan.

```bash
pnpm test-stack up
DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage
(cd apps/api && npx vitest run --config vitest.integration.config.ts src/services/timeSync/settings.integration.test.ts)
(cd apps/api && npx vitest run --config vitest.integration.config.ts src/services/timeSync/management.integration.test.ts)
(cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/tenantCascade.integration.test.ts)
(cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/tenant-export-policy.integration.test.ts)
(cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts)
(cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/orgMergeRegistry.integration.test.ts)
(cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/orgLifecycleFoundations.integration.test.ts)
(cd apps/api && npx vitest run src/routes/devices/moveOrg.coverage.test.ts src/routes/devices/cascadeDelete.test.ts)
pnpm db:check-drift
(cd packages/shared && npx tsc --noEmit)
(cd apps/api && npx tsc --noEmit)
(cd apps/web && npx tsc --noEmit)
pnpm test-stack down
```

Expected PASS for every command: forced parent-chain RLS includes the new settings table; export classification includes `enforcement`; existing org merge and device cascade contracts remain intact; all three TypeScript packages typecheck. If any command fails, preserve the failure evidence, repair the owned cause, rerun the affected check and always tear down the stack. Integration setup applies migrations before its tests; it must connect as `breeze_app` for application assertions, not treat superuser-only successes as RLS proof. No Go command is necessary because W03a changes no agent code.

- [ ] Before committing, verify migration ordering with `ls apps/api/migrations | grep -E '^[0-9]{4}-.*\.sql$' | sort | tail -1` (the corrected index command). Run `scripts/check-migration-naming.sh --against-ref origin/main`. If the slot must move, report the contract change and update every migration-path reference together; never rename a shipped migration silently. Run `pnpm --filter @breeze/api lint` and `pnpm --filter @breeze/web lint` before committing (R17).

- [ ] Commit documentation and its regression test:

```bash
git add apps/docs/src/content/docs/features/time-sync.mdx apps/web/src/components/devices/time/timeSyncManagementDocs.test.ts
git commit -m "docs(time-sync): explain management and verify delivery contracts" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## Self-Review

### 1. Owned requirements mapped to implementation

| Spec/index requirement owned by W03a | Tasks |
|---|---|
| Spec D6 and §8.1 expected timezone pin, mapped zone, site-default behavior | 1, 4, 5, 6, 9, 11 |
| Spec D7/D8/D9 management policy, domain/GPO copy; agent execution deferred | 3, 9, 12 |
| Spec D10 protective trust tier and policy write controls | 1, 2, 3 |
| Spec §8.1 typed table, checks, enum, inline-only config plumbing | 1, 2, 3 |
| Spec §8.1 rule-9 PR-description statement | 12 |
| Spec §8.2 hierarchy, defaults, 120-second cache, final heartbeat delivery | 4, 5 |
| Index §F.2 recursively canonical fingerprint and wire fields | 5 |
| Spec §5.2 policy findings and index §F.3 exact truth table | 6 |
| Spec §8.3 report storage and §8.5 system audit per new result | 2, 6 |
| Index §C.2 policy input at ingest, device/fleet views and delivery | 4, 5, 6 |
| Policy filtering/count/page parity across fleet, AI and current/history CSV population | 6 |
| Null-report retention drives findings, streaks, storage and view consistently | 6 |
| Index §C.6 enforcement in the device view | 6, 11 |
| Spec §7.3 / index §G built-in v5; exact v4 defaults; v2/v3/v4 upgrades and v5 no-op | 7 |
| R1 seven translated catalogs; unchanged duplicate ceilings and token interpolation | 9, 12 |
| R2 unmapped pins; R3 existing parent-supplied hints; R13 navigation; R16 branches; R17 formatting | 1, 11, 12; global constraints |
| Spec §9 / index §F.4 command registrations, expiry, timeout, payload validation | 8 |
| Spec §9 existing DEVICES_EXECUTE/MFA/trust/tenant/audit path | 8, 10 |
| Spec §10 policy tab, effective-config metadata and inheritance | 9 |
| Spec §10 single-device actions and fleet per-device results | 10 |
| Spec §10 GPO precedence, pin provenance and enforcement evidence | 9, 11 |
| Spec §11 management documentation, locales | 9, 12 |
| Spec §12 SQL constraints/RLS/tenancy tests and typed signatures | 2, 4, 6, 12 |
| Index Global constraints: excludedOpen enforcement classification | 2, 12 |
| Index Global constraints: no agent changes, no new MCP routes/tools | All |

Applicable hardware-template sites were traced from `git show --stat ddfcd2a044`, `8d79246f47`, `b9b294e759`, and `57c10e0c4f`. Config sites, helper/heartbeat, RLS registration, baseline/AI authoring guidance, tab/types/Effective Config, hook tests, locales and docs are covered. Hardware ingest route mounting, AI read-tool registries, lifecycle table registrations, monitor kind registration, workers and agent collectors belong to the prerequisite waves or W03b; this PR adds none of those resources. The existing schema wildcard export makes a duplicate barrel edit unnecessary.

### 2. Placeholder scan

Revision checks: all 12 task numbers retained; code fences balanced; embedded Python parses; locale command verified against in-memory catalogs for 51 keys × seven translations, token parity, no English duplicates and preservation of earlier keys; TS/TSX blocks formatted with Prettier, with partial replacements formatted in their enclosing syntax. All 12 tasks contain Files, Interfaces, a failing/passing test cycle and an exact commit command. The plan contains full new-file implementations, tests, SQL and local replacement blocks. Contract-dependency integration anchors are explicitly distinguished from verified current code. Current source line numbers cannot be supplied for files absent from the checkout; that limitation is recorded as Contract issue 1 rather than concealed with fabricated anchors.

Verification performed while authoring is limited to reads, registration searches, Prettier parsing/formatting of all 98 TS/TSX blocks (partial replacements in enclosing syntax), Python AST checks, an in-memory execution of the locale command, fence/task checks and `git diff --check` for this document. No application tests, test stacks, migrations, git staging or commits were run while writing the plan.

### 3. Type consistency against the binding index

- Shared defaults/schema/type are exactly §F.1; existing host schema and Windows accessors are consumed from §§B/C.1.
- Expected-timezone `policy` is exactly `ExpectedTimezoneInput['policy']`; the internal settings return envelope is explicitly defined in Task 4 because §F.2 does not bind its return type.
- `buildTimeSyncConfigUpdate` is exported from `routes/agents/helpers.ts`; the local construction module introduces no wire rename.
- `enforce_ntp`, `ntp_servers`, `poll_interval_minutes`, `timezone.expected_windows_id`, `timezone.auto_fix`, `fingerprint` match §F.2.
- Enforcement remains `{ ntp, timezone }`, both nullable, with the exact shared result schema; persisted `{}` is decoded to view `null`.
- `TimeFindingsContext.enforcementSettings` and detail `{ kind, reason, error }` / `{ values }` match §§C.3/F.3. Both failure kinds produce one ordered finding code. Current W01a supplies concrete map/row/view anchors. The effective report is computed once for findings and storage; fleet selection consumes the resulting canonical view before counting or pagination. They remain unmerged prerequisites.
- Command payloads match §F.4; no bulk payload or arbitrary timezone string bypass is added.
- Migration name, enum append order, parent table path, protective tier, cache key/TTL and built-in version match the index.
- No new server service depends on a Go handler before W03b; the document describes that rollout limit.

### 4. Review Focus coverage

| Input | Observable assertion | Task |
|---|---|---|
| No policy / failed resolver | Default wire settings / absent key, 200 heartbeat, shared system context | 4–5 |
| Org agent reading own partner-wide settings | SELECT succeeds; foreign reads empty; org writes denied; resolver needs no scope escalation | 2, 4 |
| Same enforcement result repeated or followed by null | One audit row; retained finding increments present streak, never recovery; view matches storage; rollback leaves no audit | 6 |
| Policy pin change/removal or disabled enforcement without new ingest | Device and fleet match; filtered totals/pages and current/history CSV population match; AI shares the fleet service | 6 |
| Mixed-zone fleet with one denied command | One correctly zoned POST per selected device, independent queued/failed outcomes | 10 |

The five index-owned W01a/W01b review cases remain prerequisite regressions. Task 6 reruns the existing findings suite without rewriting its event-activity semantics.

## Contract issues

1. **OPEN — implementation base absent.** This checkout still lacks the implemented W01a/W02 time-sync modules and has built-in version 3. Execute W03a only after W01a and W02 are merged, then run the prerequisite check and verify integration anchors. This plan now uses the CURRENT corrected W01a/W01b text and W02 producer names/types; it does not implement those waves or claim they are merged. This execution prerequisite cannot be fixed by editing this one plan.
2. **RESOLVED — device component path.** The current spec and index agree on `apps/web/src/components/devices/time/DeviceTimeSection.tsx`; Tasks 10–11 use that location and preserve the corrected W01a provenance/hint presentation (R3).
3. **RESOLVED — migration ceiling command.** Task 12 uses only the index's SQL-filename-filtered command, so `preflight` cannot mask the latest migration. The reserved unshipped slot remains subject to the same execution-time ordering check.
4. **RESOLVED — locale duplicate ceilings (R1).** Task 9 supplies every actual translation in de-DE, es-419, fr-CA, fr-FR, it-IT, pt-BR and tr-TR, preserves interpolation and earlier keys, and removes the English-copy exemptions. None of these new values is an identical protocol/product token, so no namespace baseline changes are needed. Any future legitimate token-only increase must be exactly counted and annotated `// +N: <key> — <reason>`; prose never qualifies.
5. **RESOLVED — fleet/device divergence.** Task 6 uses the same uncached effective policy and management-finding rules before filtering, counting and pagination; it tests pin changes/removal and enforcement disablement across device/fleet/CSV population. AI uses this same fleet service. Exact totals now require a bounded-memory scan of visible candidates; the read cost is explicitly documented.
6. **RESOLVED — null report recovery mismatch.** Task 6 computes one effective enforcement report, passes it to findings and the row builder, and verifies failed → null parity across stored findings, streaks, audit and view.
7. **RESOLVED — inherited built-in tests.** Task 7 modifies W02's test, retains exact `sinceVersion === 4` coverage, advances current/no-op assertions to 5, removes the management monitor when reconstructing both old fixtures, and asserts eight v2 additions/four v3 additions/four time defaults with marker 5. Full test replacements remove dependence on the broken integration `timeKeys` anchor.
8. **RESOLVED — i18n export.** Task 9 imports named `{ i18n }` from `@/lib/i18n`.
9. **RESOLVED — remaining resolution ownership.** R2's unmapped pin is tested; R3's corrected parent-view hint/provenance rendering is retained; R11's unknown/stale alert behavior and R12's ingest-order daily/streak updates remain W02 regressions; R13's docs navigation is Reporting; R16's branch rule and R17's formatting/lint gate are explicit. R4–R10 and R14–R15 are collector/agent contracts owned by corrected W01b/W03b; W03a preserves their wire shapes and does not introduce collection, cursor, service-state, event-budget, or writer behavior.
