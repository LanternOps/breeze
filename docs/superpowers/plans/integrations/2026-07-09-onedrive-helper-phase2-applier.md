# OneDrive Helper — Phase 2 (Live Spike + Server Write Path + Windows Agent Applier) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the OneDrive Helper actually function end-to-end: validate the `TenantAutoMount` format live (spike gate), build the missing config write path (inline settings → normalized tables), extend the Graph picker with `sharePointIds` + a composite builder + an HTTP route, and ship the Windows agent applier that writes base config + per-user AutoMount keys and reports real mount state.

**Architecture:** The write path follows the established `decomposeInlineSettings` pattern (`monitoring` = two-table template, `backup` = orgId-lookup template). The picker route follows `m365.ts` (`authMiddleware` + `resolveScopedOrgId`). The agent applier follows the `internal/winupdate` package template exactly (pure core + `_windows.go` I/O + `_stub.go` no-op, heartbeat seam file like `patch_source.go`). Delivery/ingest plumbing already exists from Phase 1 (#1679): config arrives under heartbeat `configUpdate.onedrive_helper_settings`; state reports back as `onedriveDeviceState`.

**Tech Stack:** Hono + Drizzle + Zod (API), PostgreSQL forced-RLS (tables already shipped — **no new migrations in this plan**), Vitest, Go 1.25.10 + `golang.org/x/sys v0.46.0` (`windows`, `windows/registry`), Microsoft Graph v1.0.

## Global Constraints

- **Node:** prefix node/pnpm/vitest commands with `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH` (default node 23 breaks pnpm engine-strict).
- **Scope exclusions (deliberate, do not build):** web UI (Phase 3 plan); per-user `graph_group` evaluation — the agent treats `graph_group` libraries as *pending*, never mounts them (Phase 4 closes this via agent UPN reporting + server tagging); unmount/revert of base config (Sub-project B — additive-only enforcement in v1).
- **Ownership (decided 2026-07-09):** `onedrive_helper` stays org-scoped-only (`ORG_SCOPED_ONLY_FEATURE_TYPES` in `packages/shared/src/constants/configFeatureTypes.ts`) — each org has its own M365 tenant, so library mappings cannot be partner-agnostic. The write path must reject partner-wide policies (orgId NULL) exactly like the `backup` case does.
- **No new tables/migrations.** `config_policy_onedrive_settings`, `config_policy_onedrive_libraries`, `onedrive_device_state` shipped in #1679 with RLS. If you think you need a migration, stop and re-read the task.
- **Server wire contract (already shipped, do not change):** heartbeat `configUpdate.onedrive_helper_settings` = `{ base: { silentAccountConfig, filesOnDemand, kfmSilentOptIn, kfmFolders, kfmBlockOptOut, tenantAssociationId, restartOnChange }, libraries: [{ libraryId, displayName, siteUrl, targetingMode, groupId, groupName, hiveScope }] }`. Heartbeat request field `onedriveDeviceState` = `{ signedIn, oneDriveVersion?, filesOnDemandOn, kfmFolderStates, mountedLibraries, entitledLibraries, driftEntries }` (zod already in `apps/api/src/routes/agents/heartbeat.ts`).
- **Go:** table-driven tests, `-race`, no real network/OS calls in tests, `//go:build` tags with a cross-platform no-op stub (the `internal/winupdate` layout). Windows-only files can't run in CI — every agent task includes a `GOOS=windows go build ./...` cross-compile check.
- **Real-DB tests** go in `apps/api/src/__tests__/integration/*.integration.test.ts` (run with `vitest.integration.config.ts`, needs local Postgres). Pure-logic tests alongside source as `*.test.ts`.

---

## File Structure

**Create:**
- `apps/api/src/routes/onedrive.ts` — library-picker route group
- `apps/api/src/routes/onedrive.test.ts` — route tests
- `apps/api/src/__tests__/integration/onedrive-helper-write-path.integration.test.ts` — decompose/replace/cascade against real DB
- `packages/shared/src/validators/onedriveInlineSettings.test.ts` — schema tests
- `agent/internal/onedrivehelper/onedrivehelper.go` — pure core: types, parse, partition, value names
- `agent/internal/onedrivehelper/onedrivehelper_test.go` — pure-core tests
- `agent/internal/onedrivehelper/onedrivehelper_windows.go` — HKLM/HKU registry I/O + state reader
- `agent/internal/onedrivehelper/onedrivehelper_stub.go` — non-Windows no-op
- `agent/internal/heartbeat/onedrive.go` — dispatch seam (mirrors `patch_source.go`)
- `agent/internal/heartbeat/onedrive_test.go` — seam tests

**Modify:**
- `docs/superpowers/spikes/2026-06-19-tenant-automount-library-id.md` — record live verdict
- `packages/shared/src/validators/index.ts` — add `'onedrive_helper'` to `addFeatureLinkSchema` enum (line ~518); add `onedriveLibraryMappingSchema` + `onedriveHelperInlineSettingsSchema`
- `apps/api/src/services/configurationPolicy.ts` — `case 'onedrive_helper'` in `decomposeInlineSettings` (switch at ~line 351) and `deleteNormalizedRows` (~line 634)
- `apps/api/src/routes/configurationPolicies/featureLinks.ts` — per-feature `safeParse` branches in POST (~line 130) and PATCH (~line 292)
- `apps/api/src/services/onedriveGraph.ts` — `sharePointIds` expansion + `buildTenantAutoMountValue`
- `apps/api/src/services/onedriveGraph.test.ts` — extend
- `apps/api/src/routes/index.ts` — mount `onedriveRoutes`
- `agent/internal/heartbeat/heartbeat.go` — `onedrive_helper_settings` branch in `applyConfigUpdate` (~line 1650); `OneDriveDeviceState` field on `HeartbeatPayload` (~line 62); populate near `payload.Battery` (~line 2567); `onedriveMu`/`onedriveState` fields on `Heartbeat` struct

---

## Task 1: Live spike validation — `TenantAutoMount` from Graph IDs (THE GATE)

**This is a hands-on validation task on a real Windows box, not a TDD task.** Desk verdict is CLEAN (see the spike doc); this proves it. Runbook: `docs/superpowers/spikes/2026-06-19-tenant-automount-windows-runbook.md` — follow it verbatim on the Windows test VM. Prereqs: OneDrive **Business** sign-in on a test tenant, FOD on, a library the test user has **never synced**.

**Files:**
- Modify: `docs/superpowers/spikes/2026-06-19-tenant-automount-library-id.md`

- [ ] **Step 1: Run runbook sections 0–2** (ground truth via "Copy library ID"; pull the same library's `sharePointIds` from Graph Explorer). Confirm the four GUIDs match the copied composite (case-insensitive).

- [ ] **Step 2: Run runbook sections 3–5** (build the value purely from Graph fields, write `SpikeTest`, poke `TimerAutoMount`, restart OneDrive, confirm the library appears in **File Explorer** and under `Accounts\Business1\Tenants`).

- [ ] **Step 3: Encoding check (extra — feeds Task 5's builder).** If the test site URL contains `_` or other chars where SharePoint's copied string uses aggressive encoding (e.g. `%5F`) but PowerShell's `EscapeDataString` left them literal: note whether the *less*-encoded value still mounted. Record the verdict as one of: "any standard percent-encoding accepted" or "must byte-match SharePoint's own encoding".

- [ ] **Step 4: Update the spike doc.** Change the status line to `🟢 **CLEAN confirmed (live mount <date>)**` (or record NOT CLEAN + what diverged), and add a short "Live validation results" section: the encoding verdict from Step 3, the observed mount latency after the timer poke, and the exact `Tenants` cache shape you saw (subkey name, value names = local folder paths) — Task 9's mounted-state reader depends on that shape.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/spikes/2026-06-19-tenant-automount-library-id.md
git commit -m "spike(onedrive-helper): live-validate Graph-constructed TenantAutoMount mount"
```

> **If NOT CLEAN:** the only downstream change is Task 5 — `buildTenantAutoMountValue` is dropped and the picker returns discrete fields only (operator pastes the sync-client composite into `libraryId`). Tasks 2–4 and 6–11 are unaffected; the schema already accepts a pasted `libraryId`.

---

## Task 2: Shared validator — `onedriveHelperInlineSettingsSchema` + feature-type enum fix

`addFeatureLinkSchema`'s hand-maintained enum is missing `'onedrive_helper'` — POSTs are rejected by zod before any handler runs. Fix that and add the net-new inline-settings schema.

**Files:**
- Modify: `packages/shared/src/validators/index.ts` (enum at ~line 518; new schemas near `monitoringInlineSettingsSchema`)
- Test: `packages/shared/src/validators/onedriveInlineSettings.test.ts`

**Interfaces:**
- Produces: `onedriveLibraryMappingSchema`, `onedriveHelperInlineSettingsSchema` (exported). Parsed shape: `{ silentAccountConfig: boolean, filesOnDemand: boolean, kfmSilentOptIn: boolean, kfmFolders: ('Desktop'|'Documents'|'Pictures')[], kfmBlockOptOut: boolean, tenantAssociationId?: string|null, restartOnChange: boolean, libraries: Array<{ libraryId, displayName, siteUrl?, siteId?, webId?, listId?, targetingMode, groupId?, groupName?, hiveScope, enabled }> }`. Consumed by Tasks 3 and 4.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/shared/src/validators/onedriveInlineSettings.test.ts
import { describe, it, expect } from 'vitest';
import {
  onedriveHelperInlineSettingsSchema,
  onedriveLibraryMappingSchema,
  addFeatureLinkSchema,
} from './index';

describe('onedriveHelperInlineSettingsSchema', () => {
  it('applies defaults on an empty object', () => {
    const parsed = onedriveHelperInlineSettingsSchema.parse({});
    expect(parsed.silentAccountConfig).toBe(true);
    expect(parsed.filesOnDemand).toBe(true);
    expect(parsed.kfmSilentOptIn).toBe(false);
    expect(parsed.kfmFolders).toEqual(['Desktop', 'Documents', 'Pictures']);
    expect(parsed.restartOnChange).toBe(true);
    expect(parsed.libraries).toEqual([]);
  });

  it('accepts a full valid payload', () => {
    const parsed = onedriveHelperInlineSettingsSchema.parse({
      kfmSilentOptIn: true,
      kfmFolders: ['Documents'],
      tenantAssociationId: '02ad5f9c-3696-477b-8cb3-9ba4e0a9ac9c',
      libraries: [
        { libraryId: 'tenantId=x&siteId={y}&webId={z}&listId={w}&webUrl=u&version=1', displayName: 'Finance', targetingMode: 'graph_group', groupId: 'g-1' },
        { libraryId: 'tenantId=x&siteId={a}&webId={b}&listId={c}&webUrl=u2&version=1', displayName: 'Company', targetingMode: 'everyone' },
      ],
    });
    expect(parsed.libraries).toHaveLength(2);
    expect(parsed.libraries[0]!.hiveScope).toBe('hkcu');
    expect(parsed.libraries[1]!.enabled).toBe(true);
  });

  it('rejects an invalid targetingMode', () => {
    expect(() => onedriveLibraryMappingSchema.parse({
      libraryId: 'x', displayName: 'X', targetingMode: 'nonsense',
    })).toThrow();
  });

  it('rejects graph_group without groupId or groupName', () => {
    const res = onedriveLibraryMappingSchema.safeParse({
      libraryId: 'x', displayName: 'X', targetingMode: 'graph_group',
    });
    expect(res.success).toBe(false);
  });

  it('rejects local_ad_group without groupName', () => {
    const res = onedriveLibraryMappingSchema.safeParse({
      libraryId: 'x', displayName: 'X', targetingMode: 'local_ad_group', groupId: 'sid-only',
    });
    expect(res.success).toBe(false);
  });

  it('rejects more than 100 libraries', () => {
    const libs = Array.from({ length: 101 }, (_, i) => ({
      libraryId: `lib-${i}`, displayName: `L${i}`, targetingMode: 'everyone',
    }));
    expect(onedriveHelperInlineSettingsSchema.safeParse({ libraries: libs }).success).toBe(false);
  });

  it('rejects an out-of-set KFM folder', () => {
    expect(onedriveHelperInlineSettingsSchema.safeParse({ kfmFolders: ['Downloads'] }).success).toBe(false);
  });
});

describe('addFeatureLinkSchema onedrive_helper', () => {
  it('accepts featureType onedrive_helper with inlineSettings', () => {
    const res = addFeatureLinkSchema.safeParse({
      featureType: 'onedrive_helper',
      inlineSettings: { silentAccountConfig: true },
    });
    expect(res.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/shared exec vitest run src/validators/onedriveInlineSettings.test.ts`
Expected: FAIL — `onedriveHelperInlineSettingsSchema` not exported.

- [ ] **Step 3: Implement the schemas**

In `packages/shared/src/validators/index.ts`, next to `monitoringInlineSettingsSchema`:

```typescript
export const onedriveLibraryMappingSchema = z.object({
  libraryId: z.string().min(1).max(1024),
  displayName: z.string().min(1).max(255),
  siteUrl: z.string().max(1024).nullable().optional(),
  siteId: z.string().max(512).nullable().optional(),
  webId: z.string().max(128).nullable().optional(),
  listId: z.string().max(128).nullable().optional(),
  targetingMode: z.enum(['everyone', 'graph_group', 'local_ad_group']).default('everyone'),
  groupId: z.string().max(128).nullable().optional(),
  groupName: z.string().max(255).nullable().optional(),
  hiveScope: z.enum(['hkcu', 'hklm']).default('hkcu'),
  enabled: z.boolean().default(true),
}).superRefine((lib, ctx) => {
  if (lib.targetingMode === 'graph_group' && !lib.groupId && !lib.groupName) {
    ctx.addIssue({ code: 'custom', message: 'graph_group targeting requires groupId or groupName', path: ['groupId'] });
  }
  if (lib.targetingMode === 'local_ad_group' && !lib.groupName) {
    ctx.addIssue({ code: 'custom', message: 'local_ad_group targeting requires groupName (agent resolves by name)', path: ['groupName'] });
  }
});

export const onedriveHelperInlineSettingsSchema = z.object({
  silentAccountConfig: z.boolean().default(true),
  filesOnDemand: z.boolean().default(true),
  kfmSilentOptIn: z.boolean().default(false),
  kfmFolders: z.array(z.enum(['Desktop', 'Documents', 'Pictures'])).default(['Desktop', 'Documents', 'Pictures']),
  kfmBlockOptOut: z.boolean().default(false),
  tenantAssociationId: z.string().max(64).nullable().optional(),
  restartOnChange: z.boolean().default(true),
  libraries: z.array(onedriveLibraryMappingSchema).max(100).default([]),
});
```

And in `addFeatureLinkSchema` (~line 518), add `'onedrive_helper'` to the `featureType` enum (after `'pam'`, before `'vulnerability'`, matching `CONFIG_FEATURE_TYPES` order).

- [ ] **Step 4: Run tests to confirm they pass**

Run: the Step-2 command. Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/validators/index.ts packages/shared/src/validators/onedriveInlineSettings.test.ts
git commit -m "feat(onedrive-helper): inline-settings zod schema + accept onedrive_helper in addFeatureLinkSchema"
```

---

## Task 3: Write path — `decomposeInlineSettings` + `deleteNormalizedRows` cases

The missing link that leaves the feature dark: nothing populates the normalized tables. Add the two `case 'onedrive_helper'` branches, combining the `monitoring` two-table pattern with the `backup` orgId-lookup pattern.

**Files:**
- Modify: `apps/api/src/services/configurationPolicy.ts` (switch in `decomposeInlineSettings` ~line 351; switch in `deleteNormalizedRows` ~line 634; imports)
- Test: `apps/api/src/__tests__/integration/onedrive-helper-write-path.integration.test.ts`

**Interfaces:**
- Consumes: `onedriveHelperInlineSettingsSchema` (Task 2), `configPolicyOnedriveSettings` / `configPolicyOnedriveLibraries` from `../db/schema/onedriveHelper`, existing `addFeatureLink(configPolicyId, featureType, featurePolicyId?, inlineSettings?)` / `updateFeatureLink` / `removeFeatureLink`.
- Produces: `addFeatureLink(policyId, 'onedrive_helper', null, settings)` persists one settings row (+ N library rows, `sortOrder` = array index); `updateFeatureLink` replaces them (delete + re-decompose); `removeFeatureLink` cascades them away. Partner-wide policies throw.

- [ ] **Step 1: Write the failing integration test**

```typescript
// apps/api/src/__tests__/integration/onedrive-helper-write-path.integration.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { organizations } from '../../db/schema/organizations';
import { partners } from '../../db/schema/partners';
import { configurationPolicies, configPolicyFeatureLinks } from '../../db/schema/configurationPolicies';
import { configPolicyOnedriveSettings, configPolicyOnedriveLibraries } from '../../db/schema/onedriveHelper';
import { addFeatureLink, updateFeatureLink, removeFeatureLink } from '../../services/configurationPolicy';

// NOTE: follow the seeding style of onedrive-helper-config-delivery.integration.test.ts
// (same directory) — if it exports a reusable seed helper, use it; otherwise this
// inline seed matches its shape. Adjust column names only if the schema import
// fails to compile (schemas are the source of truth).
async function seedOrgPolicy() {
  return withSystemDbAccessContext(async () => {
    const [partner] = await db.insert(partners).values({ name: 'WP Partner' }).returning();
    const [org] = await db.insert(organizations).values({ name: 'WP Org', partnerId: partner!.id }).returning();
    const [policy] = await db.insert(configurationPolicies).values({
      name: 'OD Policy', orgId: org!.id, status: 'active',
    }).returning();
    return { orgId: org!.id, partnerId: partner!.id, policyId: policy!.id };
  });
}

const SETTINGS = {
  silentAccountConfig: true,
  filesOnDemand: true,
  kfmSilentOptIn: true,
  kfmFolders: ['Documents'],
  kfmBlockOptOut: false,
  tenantAssociationId: '02ad5f9c-3696-477b-8cb3-9ba4e0a9ac9c',
  restartOnChange: true,
  libraries: [
    { libraryId: 'tenantId=t&siteId={s1}&webId={w1}&listId={l1}&webUrl=u1&version=1', displayName: 'Finance', targetingMode: 'graph_group', groupId: 'g-fin' },
    { libraryId: 'tenantId=t&siteId={s2}&webId={w2}&listId={l2}&webUrl=u2&version=1', displayName: 'Company', targetingMode: 'everyone' },
  ],
};

describe('onedrive_helper write path', () => {
  let ctx: Awaited<ReturnType<typeof seedOrgPolicy>>;
  beforeEach(async () => { ctx = await seedOrgPolicy(); });

  it('addFeatureLink decomposes settings + libraries with org_id and sortOrder', async () => {
    const link = await withSystemDbAccessContext(() =>
      addFeatureLink(ctx.policyId, 'onedrive_helper', null, SETTINGS));
    expect(link).not.toBeNull();

    const [settings] = await withSystemDbAccessContext(() => db.select()
      .from(configPolicyOnedriveSettings)
      .where(eq(configPolicyOnedriveSettings.featureLinkId, link!.id)));
    expect(settings).toBeDefined();
    expect(settings!.orgId).toBe(ctx.orgId);
    expect(settings!.kfmSilentOptIn).toBe(true);
    expect(settings!.kfmFolders).toEqual(['Documents']);

    const libs = await withSystemDbAccessContext(() => db.select()
      .from(configPolicyOnedriveLibraries)
      .where(eq(configPolicyOnedriveLibraries.settingsId, settings!.id))
      .orderBy(configPolicyOnedriveLibraries.sortOrder));
    expect(libs).toHaveLength(2);
    expect(libs[0]!.displayName).toBe('Finance');
    expect(libs[0]!.sortOrder).toBe(0);
    expect(libs[1]!.sortOrder).toBe(1);
    expect(libs.every((l) => l.orgId === ctx.orgId)).toBe(true);
  });

  it('updateFeatureLink replaces the normalized rows', async () => {
    const link = await withSystemDbAccessContext(() =>
      addFeatureLink(ctx.policyId, 'onedrive_helper', null, SETTINGS));
    await withSystemDbAccessContext(() => updateFeatureLink(link!.id, ctx.policyId, {
      inlineSettings: { ...SETTINGS, kfmSilentOptIn: false, libraries: [SETTINGS.libraries[1]!] },
    }));
    const [settings] = await withSystemDbAccessContext(() => db.select()
      .from(configPolicyOnedriveSettings)
      .where(eq(configPolicyOnedriveSettings.featureLinkId, link!.id)));
    expect(settings!.kfmSilentOptIn).toBe(false);
    const libs = await withSystemDbAccessContext(() => db.select()
      .from(configPolicyOnedriveLibraries)
      .where(eq(configPolicyOnedriveLibraries.settingsId, settings!.id)));
    expect(libs).toHaveLength(1);
    expect(libs[0]!.displayName).toBe('Company');
  });

  it('removeFeatureLink cascades settings and libraries away', async () => {
    const link = await withSystemDbAccessContext(() =>
      addFeatureLink(ctx.policyId, 'onedrive_helper', null, SETTINGS));
    await withSystemDbAccessContext(() => removeFeatureLink(link!.id, ctx.policyId));
    const rows = await withSystemDbAccessContext(() => db.select()
      .from(configPolicyOnedriveSettings)
      .where(eq(configPolicyOnedriveSettings.featureLinkId, link!.id)));
    expect(rows).toHaveLength(0);
  });

  it('rejects a partner-wide policy', async () => {
    const [pwPolicy] = await withSystemDbAccessContext(() => db.insert(configurationPolicies).values({
      name: 'PW Policy', orgId: null, partnerId: ctx.partnerId, status: 'active',
    }).returning());
    await expect(withSystemDbAccessContext(() =>
      addFeatureLink(pwPolicy!.id, 'onedrive_helper', null, SETTINGS)
    )).rejects.toThrow(/partner-wide/);
  });

  it('rejects invalid inline settings inside the transaction (zod backstop)', async () => {
    await expect(withSystemDbAccessContext(() =>
      addFeatureLink(ctx.policyId, 'onedrive_helper', null, {
        libraries: [{ libraryId: 'x', displayName: 'X', targetingMode: 'nonsense' }],
      })
    )).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" && PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/onedrive-helper-write-path.integration.test.ts`
Expected: FAIL — the first test finds no settings row (decompose falls through to `default:` and writes nothing).

- [ ] **Step 3: Add the decompose case**

In `apps/api/src/services/configurationPolicy.ts`: add to the imports `onedriveHelperInlineSettingsSchema` (from `@breeze/shared/validators`, alongside `monitoringInlineSettingsSchema`) and `configPolicyOnedriveSettings, configPolicyOnedriveLibraries` (from `../db/schema/onedriveHelper`). Then add this case to the `decomposeInlineSettings` switch (before `default:`):

```typescript
    case 'onedrive_helper': {
      const parsed = onedriveHelperInlineSettingsSchema.parse(s);
      // Look up orgId via feature link → policy join (same pattern as 'backup').
      const [policyRow] = await tx
        .select({ orgId: configurationPolicies.orgId })
        .from(configPolicyFeatureLinks)
        .innerJoin(configurationPolicies, eq(configPolicyFeatureLinks.configPolicyId, configurationPolicies.id))
        .where(eq(configPolicyFeatureLinks.id, linkId))
        .limit(1);
      if (!policyRow) throw new Error(`Cannot resolve orgId for feature link ${linkId}`);
      // Library mappings are per-tenant (each org has its own M365 tenant), so
      // onedrive_helper is org-scoped-only (ORG_SCOPED_ONLY_FEATURE_TYPES). The
      // route already 400s partner-wide links; this is the service-level backstop.
      if (!policyRow.orgId) {
        throw new Error('OneDrive Helper settings are not supported on partner-wide configuration policies');
      }
      const [settingsRow] = await tx.insert(configPolicyOnedriveSettings).values({
        featureLinkId: linkId,
        orgId: policyRow.orgId,
        silentAccountConfig: parsed.silentAccountConfig,
        filesOnDemand: parsed.filesOnDemand,
        kfmSilentOptIn: parsed.kfmSilentOptIn,
        kfmFolders: parsed.kfmFolders,
        kfmBlockOptOut: parsed.kfmBlockOptOut,
        tenantAssociationId: parsed.tenantAssociationId ?? null,
        restartOnChange: parsed.restartOnChange,
      }).returning();
      if (settingsRow && parsed.libraries.length > 0) {
        await tx.insert(configPolicyOnedriveLibraries).values(
          parsed.libraries.map((l, idx) => ({
            settingsId: settingsRow.id,
            orgId: policyRow.orgId!,
            libraryId: l.libraryId,
            displayName: l.displayName,
            siteUrl: l.siteUrl ?? null,
            siteId: l.siteId ?? null,
            webId: l.webId ?? null,
            listId: l.listId ?? null,
            targetingMode: l.targetingMode,
            groupId: l.groupId ?? null,
            groupName: l.groupName ?? null,
            hiveScope: l.hiveScope,
            sortOrder: idx,
            enabled: l.enabled,
          }))
        );
      }
      break;
    }
```

- [ ] **Step 4: Add the delete case**

In `deleteNormalizedRows` (same file, switch ~line 634), add (libraries cascade from settings via FK, mirroring the `monitoring` comment style):

```typescript
    case 'onedrive_helper': {
      // Libraries cascade-delete from settings, so just delete settings
      await tx.delete(configPolicyOnedriveSettings).where(eq(configPolicyOnedriveSettings.featureLinkId, linkId));
      break;
    }
```

- [ ] **Step 5: Run the integration test to confirm it passes**

Run: the Step-2 command. Expected: PASS (all 5 cases).

- [ ] **Step 6: Typecheck + run the Phase-1 delivery test (regression: resolver must see rows written via the new path)**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec tsc --noEmit`
Run: `export DATABASE_URL=... && PATH=... pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/__tests__/integration/onedrive-helper-config-delivery.integration.test.ts`
Expected: no type errors; delivery tests still PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/configurationPolicy.ts apps/api/src/__tests__/integration/onedrive-helper-write-path.integration.test.ts
git commit -m "feat(onedrive-helper): decompose inline settings into normalized tables"
```

---

## Task 4: Route validation — `onedrive_helper` branches in featureLinks POST/PATCH

Give callers a 400 (not a transaction 500) on bad settings, matching the `pam` branch pattern.

**Files:**
- Modify: `apps/api/src/routes/configurationPolicies/featureLinks.ts` (POST handler ~line 130 after the `pam` branch; PATCH handler ~line 292)
- Test: `apps/api/src/routes/configurationPolicies/featureLinks.test.ts` (extend)

**Interfaces:**
- Consumes: `onedriveHelperInlineSettingsSchema` from `@breeze/shared/validators` (Task 2).
- Produces: `POST /:id/features` and `PATCH /:id/features/:linkId` validate `onedrive_helper` inlineSettings, normalize `data.inlineSettings` to the parsed (defaults-applied) value, and 400 with `{ error: 'Invalid onedrive_helper settings', details, issues }` on failure.

- [ ] **Step 1: Write the failing tests**

Read the existing `pam`/`backup` test blocks in `featureLinks.test.ts` first and copy their harness (app construction, auth mocking, service mocks) exactly. Add:

```typescript
describe('onedrive_helper inline settings validation', () => {
  it('POST rejects invalid onedrive settings with 400', async () => {
    const res = await app.request(`/${POLICY_ID}/features`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        featureType: 'onedrive_helper',
        inlineSettings: {
          libraries: [{ libraryId: 'x', displayName: 'X', targetingMode: 'graph_group' }], // no groupId/groupName
        },
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Invalid onedrive_helper settings');
  });

  it('POST accepts valid onedrive settings (defaults applied)', async () => {
    const res = await app.request(`/${POLICY_ID}/features`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        featureType: 'onedrive_helper',
        inlineSettings: { libraries: [{ libraryId: 'lib-1', displayName: 'Docs', targetingMode: 'everyone' }] },
      }),
    });
    expect(res.status).toBe(201); // match the existing POST success status in this file
  });

  it('PATCH rejects invalid onedrive settings with 400', async () => {
    const res = await app.request(`/${POLICY_ID}/features/${LINK_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        inlineSettings: { kfmFolders: ['Downloads'] },
      }),
    });
    expect(res.status).toBe(400);
  });
});
```

> The PATCH case needs the mocked existing link to have `featureType: 'onedrive_helper'` — set that in the mock the same way the existing `pam` PATCH test does.

- [ ] **Step 2: Run to confirm they fail**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/routes/configurationPolicies/featureLinks.test.ts`
Expected: the new cases FAIL (invalid settings sail through as generic `inlineSettings`).

- [ ] **Step 3: Add the POST branch** (after the existing `pam` branch, ~line 152; import `onedriveHelperInlineSettingsSchema` from `@breeze/shared/validators` at the top):

```typescript
    if (data.featureType === 'onedrive_helper' && data.inlineSettings) {
      const parsed = onedriveHelperInlineSettingsSchema.safeParse(data.inlineSettings);
      if (!parsed.success) {
        return c.json(
          { error: 'Invalid onedrive_helper settings', details: parsed.error.flatten(), issues: parsed.error.issues },
          400
        );
      }
      data.inlineSettings = parsed.data;
    }
```

- [ ] **Step 4: Add the same branch to PATCH** (~line 292, inside the `if (data.inlineSettings)` block, keyed on `existing.featureType === 'onedrive_helper'` — copy exactly how the `pam` PATCH branch keys on the existing link's featureType).

- [ ] **Step 5: Run to confirm they pass**

Run: the Step-2 command. Expected: PASS (whole file).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/configurationPolicies/featureLinks.ts apps/api/src/routes/configurationPolicies/featureLinks.test.ts
git commit -m "feat(onedrive-helper): validate onedrive_helper inline settings in feature-link routes"
```

---

## Task 5: Graph — `sharePointIds` expansion + `buildTenantAutoMountValue`

The spike's construction formula, productionized. One Graph call per site now yields every composite field.

**Files:**
- Modify: `apps/api/src/services/onedriveGraph.ts`
- Test: `apps/api/src/services/onedriveGraph.test.ts` (extend)

**Interfaces:**
- Produces: `buildTenantAutoMountValue(ids: { tenantId: string; siteId: string; webId: string; listId: string; siteUrl: string }): string` (pure, exported). `listSharePointLibraries(orgId)` success `data.libraries[]` entries gain `tenantId`, `webId`, `spSiteId` (the bare site-collection GUID from sharePointIds — the existing `siteId` key keeps the Graph composite id) and `autoMountValue` (empty string when any GUID is missing). Consumed by Task 6's route (and Phase 3 UI).

- [ ] **Step 1: Write the failing tests**

Add to `onedriveGraph.test.ts` (keep the existing `vi.mock('./m365DirectGraph', ...)` harness):

```typescript
import { buildTenantAutoMountValue } from './onedriveGraph';

describe('buildTenantAutoMountValue', () => {
  it('matches the known-good real-world composite shape', () => {
    const val = buildTenantAutoMountValue({
      tenantId: '02ad5f9c-3696-477b-8cb3-9ba4e0a9ac9c',
      siteId: '87a9f4b2-757b-4663-b19e-d58398f0f1e4',
      webId: 'd1135130-a5e3-41d2-a8f1-a547508eaf04',
      listId: '265BA069-9F1C-4065-83AC-B7C7A0CE4C28',
      siteUrl: 'https://wvdcloud901026.sharepoint.com/sites/Office_Templates',
    });
    expect(val).toBe(
      'tenantId=02ad5f9c-3696-477b-8cb3-9ba4e0a9ac9c'
      + '&siteId={87a9f4b2-757b-4663-b19e-d58398f0f1e4}'
      + '&webId={d1135130-a5e3-41d2-a8f1-a547508eaf04}'
      + '&listId={265BA069-9F1C-4065-83AC-B7C7A0CE4C28}'
      + '&webUrl=https%3A%2F%2Fwvdcloud901026.sharepoint.com%2Fsites%2FOffice%5FTemplates'
      + '&version=1'
    );
  });

  it('strips pre-braced GUIDs before re-bracing', () => {
    const val = buildTenantAutoMountValue({
      tenantId: 't', siteId: '{s}', webId: '{w}', listId: '{l}', siteUrl: 'https://x',
    });
    expect(val).toContain('siteId={s}');
    expect(val).not.toContain('{{');
  });
});

describe('listSharePointLibraries sharePointIds expansion', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns sharePointIds-derived fields + a prebuilt autoMountValue', async () => {
    (graphFetch as any)
      .mockResolvedValueOnce({ kind: 'ok', data: { value: [
        { id: 'host,scid,webid', displayName: 'Marketing', webUrl: 'https://c.sharepoint.com/sites/mktg' },
      ] } })
      .mockResolvedValueOnce({ kind: 'ok', data: { value: [
        {
          id: 'drive-1', name: 'Documents',
          list: {
            id: 'list-1',
            sharePointIds: {
              tenantId: 'tid', siteId: 'sid-guid', webId: 'wid-guid', listId: 'list-1',
              siteUrl: 'https://c.sharepoint.com/sites/mktg',
            },
          },
        },
      ] } });

    const res = await listSharePointLibraries('org-1');
    expect(res.kind).toBe('ok');
    const lib = (res as any).data.libraries[0];
    expect(lib).toMatchObject({
      siteName: 'Marketing', driveId: 'drive-1', listId: 'list-1',
      tenantId: 'tid', webId: 'wid-guid', spSiteId: 'sid-guid',
    });
    expect(lib.autoMountValue).toContain('tenantId=tid');
    expect(lib.autoMountValue).toContain('siteId={sid-guid}');
    // the drives call must request the expansion
    const drivesPath = (graphFetch as any).mock.calls[1][2] as string;
    expect(drivesPath).toContain('$expand=list(');
    expect(drivesPath).toContain('sharePointIds');
  });

  it('returns an empty autoMountValue when sharePointIds is missing', async () => {
    (graphFetch as any)
      .mockResolvedValueOnce({ kind: 'ok', data: { value: [
        { id: 'host,scid,webid', displayName: 'M', webUrl: 'https://c.sharepoint.com/sites/m' },
      ] } })
      .mockResolvedValueOnce({ kind: 'ok', data: { value: [
        { id: 'drive-1', name: 'Documents', list: { id: 'list-1' } },
      ] } });
    const res = await listSharePointLibraries('org-1');
    const lib = (res as any).data.libraries[0];
    expect(lib.autoMountValue).toBe('');
    expect(lib.tenantId).toBe('');
  });
});
```

- [ ] **Step 2: Run to confirm they fail**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/services/onedriveGraph.test.ts`
Expected: FAIL — `buildTenantAutoMountValue` not exported; libraries lack the new fields.

- [ ] **Step 3: Implement**

In `onedriveGraph.ts`, add the builder and encoding helper:

```typescript
/** Percent-encode a site URL for the TenantAutoMount composite. SharePoint's own
 * "Copy library ID" encodes aggressively (`_` → `%5F`), beyond encodeURIComponent's
 * unreserved set — match it byte-for-byte so our values are indistinguishable from
 * sync-client-produced ones. (Live spike 2026-06-19 doc records what OneDrive accepts.) */
function encodeWebUrl(url: string): string {
  // encodeURIComponent, plus the chars SharePoint's encoder escapes that
  // encodeURIComponent leaves literal (`_` → %5F in the ground-truth sample).
  // Dots/hyphens stay literal — the real-world value keeps them unencoded.
  return encodeURIComponent(url).replace(/[!'()*_]/g, (c) =>
    '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
}

const stripBraces = (g: string) => g.replace(/^\{|\}$/g, '');

export function buildTenantAutoMountValue(ids: {
  tenantId: string; siteId: string; webId: string; listId: string; siteUrl: string;
}): string {
  return `tenantId=${stripBraces(ids.tenantId)}`
    + `&siteId={${stripBraces(ids.siteId)}}`
    + `&webId={${stripBraces(ids.webId)}}`
    + `&listId={${stripBraces(ids.listId)}}`
    + `&webUrl=${encodeWebUrl(ids.siteUrl)}`
    + `&version=1`;
}
```

> ⚠️ Check the Task-1 spike doc's encoding verdict before finalizing `encodeWebUrl`. If the live run recorded "any standard percent-encoding accepted", simplify to plain `encodeURIComponent` and fix the first unit test's expected `%5F`/`%2E` bytes accordingly. If the sample real-world value in the spike doc conflicts with the regex above (e.g. it does NOT encode `.` or `-` inside the URL path), match the spike doc — it is ground truth. Encoding only ever applies to the `webUrl` segment.

Then in `listSharePointLibraries`, change the drives fetch to:

```typescript
    const drives = await graphFetch(
      token,
      'GET',
      `/sites/${encodeSiteId(siteId)}/drives?$select=id,name&$expand=list($select=id,sharePointIds)`,
    );
```

and extend the per-drive mapping (replace the existing `libraries.push({...})` body):

```typescript
      const sp = (d.list?.sharePointIds ?? {}) as Record<string, unknown>;
      const spStr = (k: string) => (typeof sp[k] === 'string' ? (sp[k] as string) : '');
      const tenantId = spStr('tenantId');
      const spSiteId = spStr('siteId');
      const webId = spStr('webId');
      const spListId = spStr('listId') || (typeof d.list?.id === 'string' ? d.list.id : '');
      const spSiteUrl = spStr('siteUrl') || (typeof site.webUrl === 'string' ? site.webUrl : '');
      const complete = Boolean(tenantId && spSiteId && webId && spListId && spSiteUrl);
      libraries.push({
        siteId,
        siteName: typeof site.displayName === 'string' ? site.displayName : '',
        siteUrl: typeof site.webUrl === 'string' ? site.webUrl : '',
        driveId,
        listId: spListId,
        libraryName: typeof d.name === 'string' ? d.name : '',
        tenantId,
        webId,
        spSiteId,
        autoMountValue: complete
          ? buildTenantAutoMountValue({ tenantId, siteId: spSiteId, webId, listId: spListId, siteUrl: spSiteUrl })
          : '',
      });
```

- [ ] **Step 4: Run to confirm they pass** (plus the pre-existing tests in the file — the first mock's drives response changes shape only in the new test, but re-run the whole file).

Run: the Step-2 command. Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/onedriveGraph.ts apps/api/src/services/onedriveGraph.test.ts
git commit -m "feat(onedrive-helper): sharePointIds expansion + TenantAutoMount composite builder"
```

---

## Task 6: Library-picker route — `GET /onedrive/libraries`

Expose the picker to the (Phase 3) UI. Follows `m365.ts`: `authMiddleware`, `requirePermission`, `resolveScopedOrgId`.

**Files:**
- Create: `apps/api/src/routes/onedrive.ts`
- Modify: `apps/api/src/routes/index.ts` (mount)
- Test: `apps/api/src/routes/onedrive.test.ts`

**Interfaces:**
- Consumes: `listSharePointLibraries(orgId)` (Task 5 shape), `hasDirectM365Connection(orgId)` from `m365DirectGraph.ts`, `resolveScopedOrgId(auth, requestedOrgId)` from `./c2c/helpers`.
- Produces: `GET /onedrive/libraries?orgId=<uuid>` → 200 `{ libraries: [...], skippedSites: [...] }` | 400 no resolvable org | 409 no M365 connection | 502 Graph error. Mounted at `/onedrive`.

- [ ] **Step 1: Write the failing tests**

Before writing, open `apps/api/src/routes/m365.ts` and one of its test files (or another route test in `apps/api/src/routes/`) and copy the exact middleware-mocking harness used there (how `authMiddleware` is mocked to inject `c.set('auth', ...)`). Then:

```typescript
// apps/api/src/routes/onedrive.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../services/onedriveGraph', () => ({
  listSharePointLibraries: vi.fn(),
}));
vi.mock('../services/m365DirectGraph', () => ({
  hasDirectM365Connection: vi.fn(),
}));
// Mock the auth middlewares the same way m365.ts tests do — inject an
// org-scoped auth context with canAccessOrg allowing ORG_A only.
// (Copy that harness verbatim; the assertions below are what matter.)

import { listSharePointLibraries } from '../services/onedriveGraph';
import { hasDirectM365Connection } from '../services/m365DirectGraph';
import { onedriveRoutes } from './onedrive';

const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';

describe('GET /onedrive/libraries', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns libraries for an accessible org', async () => {
    (hasDirectM365Connection as any).mockResolvedValue(true);
    (listSharePointLibraries as any).mockResolvedValue({
      kind: 'ok',
      data: { libraries: [{ libraryName: 'Documents', autoMountValue: 'tenantId=t&…' }], skippedSites: [] },
    });
    const res = await onedriveRoutes.request(`/libraries?orgId=${ORG_A}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.libraries).toHaveLength(1);
    expect(listSharePointLibraries).toHaveBeenCalledWith(ORG_A);
  });

  it('rejects an org the caller cannot access (cross-tenant)', async () => {
    const res = await onedriveRoutes.request(`/libraries?orgId=${ORG_B}`);
    expect(res.status).toBe(400); // resolveScopedOrgId returns null → orgId required error
    expect(listSharePointLibraries).not.toHaveBeenCalled();
  });

  it('409s when the org has no M365 connection', async () => {
    (hasDirectM365Connection as any).mockResolvedValue(false);
    const res = await onedriveRoutes.request(`/libraries?orgId=${ORG_A}`);
    expect(res.status).toBe(409);
  });

  it('502s on a Graph error', async () => {
    (hasDirectM365Connection as any).mockResolvedValue(true);
    (listSharePointLibraries as any).mockResolvedValue({ kind: 'error', code: 'graph_error', message: 'boom' });
    const res = await onedriveRoutes.request(`/libraries?orgId=${ORG_A}`);
    expect(res.status).toBe(502);
  });
});
```

- [ ] **Step 2: Run to confirm they fail**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/routes/onedrive.test.ts`
Expected: FAIL — module `./onedrive` does not exist.

- [ ] **Step 3: Implement the route**

```typescript
// apps/api/src/routes/onedrive.ts
// Copy the exact import paths for authMiddleware / requirePermission /
// requireScope / PERMISSIONS from apps/api/src/routes/m365.ts.
import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth';
import { requirePermission, requireScope } from '../middleware/rbac';
import { PERMISSIONS } from '../services/permissions';
import { resolveScopedOrgId } from './c2c/helpers';
import { hasDirectM365Connection } from '../services/m365DirectGraph';
import { listSharePointLibraries } from '../services/onedriveGraph';

export const onedriveRoutes = new Hono();

const requireDevicesRead = requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action);

onedriveRoutes.use('*', authMiddleware);

// Library picker for the onedrive_helper policy editor: browse the org's
// SharePoint document libraries with a prebuilt TenantAutoMount composite each.
onedriveRoutes.get(
  '/libraries',
  requireScope('organization', 'partner', 'system'),
  requireDevicesRead,
  async (c) => {
    const auth = c.get('auth');
    const orgId = resolveScopedOrgId(auth, c.req.query('orgId'));
    if (!orgId) return c.json({ error: 'orgId is required for this scope' }, 400);

    if (!(await hasDirectM365Connection(orgId))) {
      return c.json({ error: 'This organization has no Microsoft 365 connection. Connect M365 first.' }, 409);
    }

    const res = await listSharePointLibraries(orgId);
    if (res.kind === 'error') {
      return c.json({ error: res.message, code: res.code }, 502);
    }
    return c.json(res.data);
  }
);
```

> If the import paths above don't match this repo (they were copied from `m365.ts`'s pattern, verify against the actual file), fix the imports — the handler body is the contract.

- [ ] **Step 4: Mount it**

In `apps/api/src/routes/index.ts`, next to where `m365Routes` is mounted, add:

```typescript
import { onedriveRoutes } from './onedrive';
// …
app.route('/onedrive', onedriveRoutes);
```

(Do NOT mount at the root — `use('*')` on a root-mounted router leaks auth middleware onto sibling routes.)

- [ ] **Step 5: Run to confirm tests pass + typecheck**

Run: the Step-2 command, then `PATH=... pnpm --filter @breeze/api exec tsc --noEmit`
Expected: PASS; no type errors.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/onedrive.ts apps/api/src/routes/onedrive.test.ts apps/api/src/routes/index.ts
git commit -m "feat(onedrive-helper): GET /onedrive/libraries picker route"
```

---

## Task 7: Agent pure core — `internal/onedrivehelper` types + partition + value names

Cross-platform logic, fully unit-tested on any OS (the `winupdate.go` split rationale).

**Files:**
- Create: `agent/internal/onedrivehelper/onedrivehelper.go`
- Test: `agent/internal/onedrivehelper/onedrivehelper_test.go`

**Interfaces:**
- Produces (consumed by Tasks 8–10):
  - `type Config struct { Base BaseConfig; Libraries []LibraryRule }` with JSON tags matching the server wire contract (Global Constraints).
  - `type DeviceState struct` with JSON tags matching the heartbeat zod schema: `signedIn`, `oneDriveVersion`, `filesOnDemandOn`, `kfmFolderStates`, `mountedLibraries`, `entitledLibraries`, `driftEntries`.
  - `func ParseConfig(raw any) (Config, bool)` — json round-trip like `monitoring.ParseMonitorConfig`.
  - `func PartitionLibraries(rules []LibraryRule, isLocalGroupMember func(groupName string) bool) (apply, pending []LibraryRule)`.
  - `func ValueName(libraryID string) string` — deterministic registry value name.
  - `func TenantIDFromComposite(libraryID string) string` — KFM tenant-id fallback.

- [ ] **Step 1: Write the failing tests**

```go
// agent/internal/onedrivehelper/onedrivehelper_test.go
package onedrivehelper

import (
	"strings"
	"testing"
)

func TestParseConfig(t *testing.T) {
	tests := []struct {
		name string
		raw  any
		ok   bool
		libs int
	}{
		{
			name: "valid full payload",
			raw: map[string]any{
				"base": map[string]any{
					"silentAccountConfig": true, "filesOnDemand": true,
					"kfmSilentOptIn": true, "kfmFolders": []any{"Documents"},
					"kfmBlockOptOut": false, "tenantAssociationId": "tid-1", "restartOnChange": true,
				},
				"libraries": []any{
					map[string]any{"libraryId": "lib-1", "displayName": "Docs", "targetingMode": "everyone", "hiveScope": "hkcu"},
				},
			},
			ok: true, libs: 1,
		},
		{name: "null tenantAssociationId tolerated", raw: map[string]any{"base": map[string]any{"tenantAssociationId": nil}, "libraries": []any{}}, ok: true, libs: 0},
		{name: "not an object", raw: "nope", ok: false},
		{name: "nil", raw: nil, ok: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg, ok := ParseConfig(tt.raw)
			if ok != tt.ok {
				t.Fatalf("ok = %v, want %v", ok, tt.ok)
			}
			if ok && len(cfg.Libraries) != tt.libs {
				t.Fatalf("libraries = %d, want %d", len(cfg.Libraries), tt.libs)
			}
		})
	}
}

func TestPartitionLibraries(t *testing.T) {
	member := func(name string) bool { return name == "Finance-Users" }
	rules := []LibraryRule{
		{LibraryID: "l-every", TargetingMode: "everyone"},
		{LibraryID: "l-local-yes", TargetingMode: "local_ad_group", GroupName: "Finance-Users"},
		{LibraryID: "l-local-no", TargetingMode: "local_ad_group", GroupName: "HR-Users"},
		{LibraryID: "l-local-noname", TargetingMode: "local_ad_group"},
		{LibraryID: "l-graph", TargetingMode: "graph_group", GroupID: "g-1"},
		{LibraryID: "l-unknown", TargetingMode: "future_mode"},
	}
	apply, pending := PartitionLibraries(rules, member)

	wantApply := []string{"l-every", "l-local-yes"}
	if len(apply) != len(wantApply) {
		t.Fatalf("apply = %d rules, want %d", len(apply), len(wantApply))
	}
	for i, id := range wantApply {
		if apply[i].LibraryID != id {
			t.Errorf("apply[%d] = %s, want %s", i, apply[i].LibraryID, id)
		}
	}
	// graph_group is pending (Phase 4 evaluates it); unknown modes are pending
	// (fail closed — never mount something we can't evaluate).
	wantPending := map[string]bool{"l-graph": true, "l-unknown": true}
	for _, r := range pending {
		if !wantPending[r.LibraryID] {
			t.Errorf("unexpected pending rule %s", r.LibraryID)
		}
	}
	if len(pending) != len(wantPending) {
		t.Fatalf("pending = %d rules, want %d", len(pending), len(wantPending))
	}
	// local_ad_group misses (no-match, no groupName) are neither applied nor
	// pending: the user is simply not entitled.
	for _, r := range apply {
		if r.LibraryID == "l-local-no" || r.LibraryID == "l-local-noname" {
			t.Errorf("%s must not be applied", r.LibraryID)
		}
	}
}

func TestValueName(t *testing.T) {
	a := ValueName("tenantId=t&siteId={s}&…")
	b := ValueName("tenantId=t&siteId={s}&…")
	c := ValueName("different")
	if a != b {
		t.Error("ValueName must be deterministic")
	}
	if a == c {
		t.Error("distinct libraries must get distinct names")
	}
	if !strings.HasPrefix(a, "Breeze-") {
		t.Errorf("name %q must be Breeze-prefixed (ownership marker)", a)
	}
	if len(a) > 40 {
		t.Errorf("name %q too long for a registry value name", a)
	}
}

func TestTenantIDFromComposite(t *testing.T) {
	tests := []struct{ in, want string }{
		{"tenantId=02ad5f9c-3696-477b-8cb3-9ba4e0a9ac9c&siteId={x}&version=1", "02ad5f9c-3696-477b-8cb3-9ba4e0a9ac9c"},
		{"siteId={x}&tenantId=abc&version=1", "abc"},
		{"no-tenant-here", ""},
		{"", ""},
	}
	for _, tt := range tests {
		if got := TenantIDFromComposite(tt.in); got != tt.want {
			t.Errorf("TenantIDFromComposite(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}
```

- [ ] **Step 2: Run to confirm they fail**

Run: `cd agent && go test -race ./internal/onedrivehelper/...`
Expected: FAIL — package does not exist / undefined symbols.

- [ ] **Step 3: Implement the pure core**

```go
// The platform-independent types and decision logic live here so they can be
// unit-tested on any OS; the registry I/O is in onedrivehelper_windows.go, with
// a no-op stub for other platforms in onedrivehelper_stub.go.
// (Same layout rationale as internal/winupdate.)
package onedrivehelper

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
)

// BaseConfig mirrors the server's onedrive_helper_settings.base object
// (apps/api/src/routes/agents/helpers.ts OnedriveConfigUpdate).
type BaseConfig struct {
	SilentAccountConfig bool     `json:"silentAccountConfig"`
	FilesOnDemand       bool     `json:"filesOnDemand"`
	KfmSilentOptIn      bool     `json:"kfmSilentOptIn"`
	KfmFolders          []string `json:"kfmFolders"`
	KfmBlockOptOut      bool     `json:"kfmBlockOptOut"`
	TenantAssociationID string   `json:"tenantAssociationId"`
	RestartOnChange     bool     `json:"restartOnChange"`
}

// LibraryRule mirrors one entry of onedrive_helper_settings.libraries.
type LibraryRule struct {
	LibraryID     string `json:"libraryId"`
	DisplayName   string `json:"displayName"`
	SiteURL       string `json:"siteUrl"`
	TargetingMode string `json:"targetingMode"`
	GroupID       string `json:"groupId"`
	GroupName     string `json:"groupName"`
	HiveScope     string `json:"hiveScope"`
}

type Config struct {
	Base      BaseConfig    `json:"base"`
	Libraries []LibraryRule `json:"libraries"`
}

// DriftEntry records an applied library that OneDrive did not actually mount
// (e.g. the user previously "stopped sync" — AutoMount will not re-mount it).
type DriftEntry struct {
	LibraryID   string `json:"libraryId"`
	DisplayName string `json:"displayName"`
	Reason      string `json:"reason"`
}

// DeviceState is reported in the heartbeat payload as onedriveDeviceState and
// must match the zod schema in apps/api/src/routes/agents/heartbeat.ts.
type DeviceState struct {
	SignedIn         bool              `json:"signedIn"`
	OneDriveVersion  string            `json:"oneDriveVersion,omitempty"`
	FilesOnDemandOn  bool              `json:"filesOnDemandOn"`
	KfmFolderStates  map[string]string `json:"kfmFolderStates"`
	MountedLibraries []string          `json:"mountedLibraries"`
	EntitledLibraries []string         `json:"entitledLibraries"`
	DriftEntries     []DriftEntry      `json:"driftEntries"`
}

// ParseConfig converts the untyped heartbeat configUpdate value into a Config
// via a JSON round-trip (same pattern as monitoring.ParseMonitorConfig).
// nulls from the wire (e.g. tenantAssociationId) become Go zero values.
func ParseConfig(raw any) (Config, bool) {
	var cfg Config
	if raw == nil {
		return cfg, false
	}
	if _, isObj := raw.(map[string]any); !isObj {
		return cfg, false
	}
	data, err := json.Marshal(raw)
	if err != nil {
		return cfg, false
	}
	if err := json.Unmarshal(data, &cfg); err != nil {
		return cfg, false
	}
	return cfg, true
}

// PartitionLibraries splits delivered rules into (apply, pending):
//   - everyone            → apply
//   - local_ad_group      → apply iff the user is a member of GroupName;
//                           a miss (or empty GroupName) is simply not entitled.
//   - graph_group         → pending (server-side evaluation lands in Phase 4;
//                           NEVER mount an unevaluated graph_group library)
//   - anything unknown    → pending (fail closed)
func PartitionLibraries(rules []LibraryRule, isLocalGroupMember func(groupName string) bool) (apply, pending []LibraryRule) {
	for _, r := range rules {
		switch r.TargetingMode {
		case "everyone":
			apply = append(apply, r)
		case "local_ad_group":
			if r.GroupName != "" && isLocalGroupMember != nil && isLocalGroupMember(r.GroupName) {
				apply = append(apply, r)
			}
		default: // graph_group + future modes
			pending = append(pending, r)
		}
	}
	return apply, pending
}

// ValueName derives the deterministic TenantAutoMount registry value name for a
// library. The name is cosmetic to OneDrive (it uses the library's own title),
// but the Breeze- prefix marks ownership and determinism makes writes idempotent.
func ValueName(libraryID string) string {
	sum := sha256.Sum256([]byte(libraryID))
	return "Breeze-" + hex.EncodeToString(sum[:6])
}

// TenantIDFromComposite extracts the tenantId=… field from an AutoMount
// composite; used as the KFMSilentOptIn tenant fallback when the policy has no
// explicit tenantAssociationId.
func TenantIDFromComposite(libraryID string) string {
	for _, part := range strings.Split(libraryID, "&") {
		if v, ok := strings.CutPrefix(part, "tenantId="); ok {
			return v
		}
	}
	return ""
}
```

- [ ] **Step 4: Run to confirm they pass**

Run: `cd agent && go test -race ./internal/onedrivehelper/...`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/onedrivehelper/onedrivehelper.go agent/internal/onedrivehelper/onedrivehelper_test.go
git commit -m "feat(onedrive-helper): agent pure core — config types, partition, value names"
```

---

## Task 8: Agent Windows applier — HKLM base config + per-SID AutoMount + stub

The registry I/O. Composed from the `winupdate_windows.go` write-with-readback pattern, `policy_state_registry_windows.go`'s `registry.USERS` root, and `spawn_process_windows.go`'s `WTSQueryUserToken` recipe. **No CI test can run this** — verification is a Windows cross-compile here and the live VM run in Task 11.

**Files:**
- Create: `agent/internal/onedrivehelper/onedrivehelper_windows.go`
- Create: `agent/internal/onedrivehelper/onedrivehelper_stub.go`

**Interfaces:**
- Produces: `func Apply(cfg Config) (*DeviceState, error)` — on Windows: writes base config + per-user AutoMount, reads state (Task 9 fills in the full reader; this task returns a minimal state), restarts OneDrive best-effort. On other platforms (stub): returns `(nil, nil)`.
- Consumes: `PartitionLibraries`, `ValueName`, `TenantIDFromComposite` (Task 7); `sessionbroker.SpawnProcessInSessionWithArgs(binaryPath string, args []string, sessionID uint32) error`.

- [ ] **Step 1: Write the stub (and its trivial test)**

```go
// agent/internal/onedrivehelper/onedrivehelper_stub.go
//go:build !windows

package onedrivehelper

// Apply is a no-op on non-Windows platforms: OneDrive provisioning has no
// meaning on macOS/Linux, so the agent reports nothing (nil state → the
// heartbeat omits onedriveDeviceState entirely).
func Apply(cfg Config) (*DeviceState, error) {
	return nil, nil
}
```

Append to `onedrivehelper_test.go`:

```go
//go:build !windows check is not needed here — this test file has no build tag,
//and on Windows dev boxes the windows Apply also satisfies the signature.
func TestApplySignature(t *testing.T) {
	// Compile-time check that Apply exists with the cross-platform signature.
	var _ func(Config) (*DeviceState, error) = Apply
}
```

- [ ] **Step 2: Run to confirm the stub compiles + tests pass on this platform**

Run: `cd agent && go test -race ./internal/onedrivehelper/...`
Expected: PASS.

- [ ] **Step 3: Implement the Windows applier**

```go
// agent/internal/onedrivehelper/onedrivehelper_windows.go
//go:build windows

package onedrivehelper

import (
	"fmt"
	"os"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"

	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

const (
	policyKeyPath    = `SOFTWARE\Policies\Microsoft\OneDrive`
	autoMountSubKey  = policyKeyPath + `\TenantAutoMount`
	accountKeySubfix = `SOFTWARE\Microsoft\OneDrive\Accounts\Business1`
	sentinelValue    = "BreezeOneDriveManaged"
)

// userSession is one active interactive session resolved to a SID + group set.
type userSession struct {
	sessionID uint32
	sid       string
	groupSIDs map[string]bool // uppercase SID strings from the user token
}

// Apply enforces base config in HKLM and per-user TenantAutoMount values in
// HKU\<SID>, then reads back device state. Additive-only: toggles turned off
// stop being enforced but are not scrubbed (unmount/revert is Sub-project B).
func Apply(cfg Config) (*DeviceState, error) {
	baseChanged, baseErr := applyBaseConfig(cfg)

	sessions := activeUserSessions()
	anyUserChanged := false
	var entitled []string
	var applied []LibraryRule
	for _, s := range sessions {
		isMember := func(groupName string) bool { return isTokenGroupMember(s, groupName) }
		apply, _ := PartitionLibraries(cfg.Libraries, isMember)
		changed, err := applyUserAutoMount(s.sid, apply)
		if err != nil {
			// One broken user hive must not stop the others.
			continue
		}
		if changed {
			anyUserChanged = true
			pokeAutoMountTimer(s.sid)
		}
		for _, r := range apply {
			if !containsString(entitled, r.LibraryID) {
				entitled = append(entitled, r.LibraryID)
				applied = append(applied, r)
			}
		}
	}

	state := readDeviceState(sessions, entitled, applied) // full reader lands in Task 9

	if (baseChanged || anyUserChanged) && cfg.Base.RestartOnChange {
		restartOneDrive(sessions)
	}
	return state, baseErr
}

func containsString(xs []string, x string) bool {
	for _, v := range xs {
		if v == x {
			return true
		}
	}
	return false
}

// applyBaseConfig writes the HKLM OneDrive policy values. Returns whether
// anything changed. Write-then-readback-verify per the winupdate pattern.
func applyBaseConfig(cfg Config) (bool, error) {
	k, _, err := registry.CreateKey(registry.LOCAL_MACHINE, policyKeyPath, registry.SET_VALUE|registry.QUERY_VALUE)
	if err != nil {
		return false, fmt.Errorf("open/create OneDrive policy key: %w", err)
	}
	defer k.Close()

	changed := false
	setDword := func(name string, want uint32) error {
		if got, _, e := k.GetIntegerValue(name); e == nil && uint32(got) == want {
			return nil // already correct
		}
		if e := k.SetDWordValue(name, want); e != nil {
			return fmt.Errorf("set %s: %w", name, e)
		}
		if got, _, e := k.GetIntegerValue(name); e != nil || uint32(got) != want {
			return fmt.Errorf("verify %s read-back: got %d (err %v)", name, got, e)
		}
		changed = true
		return nil
	}

	var firstErr error
	keep := func(e error) {
		if e != nil && firstErr == nil {
			firstErr = e
		}
	}

	// Ownership sentinel so a future revert can distinguish Breeze-written
	// enforcement from admin GPOs (winupdate pattern).
	keep(setDword(sentinelValue, 1))

	if cfg.Base.SilentAccountConfig {
		keep(setDword("SilentAccountConfig", 1))
	}
	if cfg.Base.FilesOnDemand {
		keep(setDword("FilesOnDemandEnabled", 1))
	}
	if cfg.Base.KfmSilentOptIn {
		tenantID := cfg.Base.TenantAssociationID
		if tenantID == "" && len(cfg.Libraries) > 0 {
			tenantID = TenantIDFromComposite(cfg.Libraries[0].LibraryID)
		}
		if tenantID != "" {
			if got, _, e := k.GetStringValue("KFMSilentOptIn"); e != nil || got != tenantID {
				if e := k.SetStringValue("KFMSilentOptIn", tenantID); e != nil {
					keep(fmt.Errorf("set KFMSilentOptIn: %w", e))
				} else {
					changed = true
				}
			}
			// Per-folder opt-in selection (OneDrive 23.002+). 1 = include.
			folderSet := map[string]bool{}
			for _, f := range cfg.Base.KfmFolders {
				folderSet[f] = true
			}
			keep(setDword("KFMSilentOptInDesktop", boolToDword(folderSet["Desktop"])))
			keep(setDword("KFMSilentOptInDocuments", boolToDword(folderSet["Documents"])))
			keep(setDword("KFMSilentOptInPictures", boolToDword(folderSet["Pictures"])))
			if cfg.Base.KfmBlockOptOut {
				keep(setDword("KFMBlockOptOut", 1))
			}
		}
		// No tenant id resolvable → KFM silently skipped; surfaced via
		// kfmFolderStates="unknown" in the state reader rather than an error.
	}
	return changed, firstErr
}

func boolToDword(b bool) uint32 {
	if b {
		return 1
	}
	return 0
}

// applyUserAutoMount writes one TenantAutoMount value per applied rule under
// HKU\<SID>. Idempotent: skips values already correct. Additive-only: values
// for rules no longer delivered are left in place (v1 — see spec).
func applyUserAutoMount(sid string, rules []LibraryRule) (bool, error) {
	if len(rules) == 0 {
		return false, nil
	}
	path := sid + `\` + autoMountSubKey
	k, _, err := registry.CreateKey(registry.USERS, path, registry.SET_VALUE|registry.QUERY_VALUE)
	if err != nil {
		return false, fmt.Errorf("open/create HKU automount key for %s: %w", sid, err)
	}
	defer k.Close()

	changed := false
	for _, r := range rules {
		name := ValueName(r.LibraryID)
		if got, _, e := k.GetStringValue(name); e == nil && got == r.LibraryID {
			continue
		}
		if e := k.SetStringValue(name, r.LibraryID); e != nil {
			return changed, fmt.Errorf("set automount %s: %w", name, e)
		}
		changed = true
	}
	return changed, nil
}

// pokeAutoMountTimer forces OneDrive to process AutoMount promptly (it
// otherwise runs on an up-to-8h timer). Only possible when the user has a
// Business1 account key (i.e. is signed in); missing key is fine — OneDrive
// will process on sign-in.
func pokeAutoMountTimer(sid string) {
	k, err := registry.OpenKey(registry.USERS, sid+`\`+accountKeySubfix, registry.SET_VALUE)
	if err != nil {
		return
	}
	defer k.Close()
	_ = k.SetQWordValue("TimerAutoMount", 1)
}

// activeUserSessions enumerates active WTS sessions and resolves each to a SID
// + token group set (WTSQueryUserToken → GetTokenUser/GetTokenGroups — same
// recipe as sessionbroker/spawn_process_windows.go and userhelper/sid_windows.go).
func activeUserSessions() []userSession {
	var pInfo *windows.WTS_SESSION_INFO
	var count uint32
	if err := windows.WTSEnumerateSessions(0, 0, 1, &pInfo, &count); err != nil {
		return nil
	}
	defer windows.WTSFreeMemory(uintptr(unsafe.Pointer(pInfo)))

	infos := unsafe.Slice(pInfo, count)
	var out []userSession
	for _, info := range infos {
		if info.State != windows.WTSActive {
			continue
		}
		var tok windows.Token
		if err := windows.WTSQueryUserToken(info.SessionID, &tok); err != nil {
			continue // no user token (e.g. services session)
		}
		s := userSession{sessionID: info.SessionID, groupSIDs: map[string]bool{}}
		if tu, err := tok.GetTokenUser(); err == nil {
			s.sid = tu.User.Sid.String()
		}
		if tg, err := tok.GetTokenGroups(); err == nil {
			for _, g := range tg.AllGroups() {
				s.groupSIDs[strings.ToUpper(g.Sid.String())] = true
			}
		}
		tok.Close()
		if s.sid != "" {
			out = append(out, s)
		}
	}
	return out
}

// isTokenGroupMember resolves a local/domain group name to a SID and checks the
// session token's group list. Unresolvable names are treated as non-member
// (fail closed).
func isTokenGroupMember(s userSession, groupName string) bool {
	sid, _, _, err := windows.LookupSID("", groupName)
	if err != nil {
		return false
	}
	return s.groupSIDs[strings.ToUpper(sid.String())]
}

// restartOneDrive best-effort kills + relaunches OneDrive in each session so
// policy/AutoMount changes take effect promptly. Errors are ignored: OneDrive
// also picks changes up on its own schedule.
func restartOneDrive(sessions []userSession) {
	machineExe := `C:\Program Files\Microsoft OneDrive\OneDrive.exe`
	for _, s := range sessions {
		_ = sessionbroker.SpawnProcessInSessionWithArgs(
			`C:\Windows\System32\taskkill.exe`, []string{"/f", "/im", "OneDrive.exe"}, s.sessionID)
		if _, err := os.Stat(machineExe); err == nil {
			_ = sessionbroker.SpawnProcessInSessionWithArgs(machineExe, []string{"/background"}, s.sessionID)
		} else {
			// Per-user install path; %LOCALAPPDATA% expands in the user's env
			// block inside the spawn's cmd wrapper.
			_ = sessionbroker.SpawnProcessInSessionWithArgs(
				`%LOCALAPPDATA%\Microsoft\OneDrive\OneDrive.exe`, []string{"/background"}, s.sessionID)
		}
	}
}

// readDeviceState — minimal placeholder until Task 9 replaces it with the full
// registry-backed reader. Reports entitlement only.
func readDeviceState(sessions []userSession, entitled []string, applied []LibraryRule) *DeviceState {
	return &DeviceState{
		KfmFolderStates:   map[string]string{},
		MountedLibraries:  []string{},
		EntitledLibraries: entitled,
		DriftEntries:      []DriftEntry{},
	}
}
```

> **Check before finalizing:** `windows.WTS_SESSION_INFO`, `windows.WTSActive`, `windows.WTSEnumerateSessions`, `windows.WTSFreeMemory` — confirm exact names/signatures against `agent/internal/sessionbroker/detector_windows.go` (it already does this enumeration; mirror its exact calls, including how it slices the returned buffer). If the sessionbroker file uses different x/sys spellings, copy those.

- [ ] **Step 4: Cross-compile for Windows + re-run platform tests**

Run: `cd agent && GOOS=windows GOARCH=amd64 go build ./... && go test -race ./internal/onedrivehelper/...`
Expected: clean Windows build; local tests PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/onedrivehelper/onedrivehelper_windows.go agent/internal/onedrivehelper/onedrivehelper_stub.go agent/internal/onedrivehelper/onedrivehelper_test.go
git commit -m "feat(onedrive-helper): Windows applier — HKLM base config + per-SID TenantAutoMount"
```

---

## Task 9: Agent state reader — signed-in / FOD / KFM / mounted / drift

Replace Task 8's placeholder `readDeviceState` with the real registry-backed reader, and unit-test the pure drift computation.

**Files:**
- Modify: `agent/internal/onedrivehelper/onedrivehelper_windows.go` (replace `readDeviceState`)
- Modify: `agent/internal/onedrivehelper/onedrivehelper.go` (add pure `ComputeDrift` + `FolderRedirectionState`)
- Test: extend `agent/internal/onedrivehelper/onedrivehelper_test.go`

**Interfaces:**
- Produces (pure, in `onedrivehelper.go`): `func ComputeDrift(applied []LibraryRule, mountedPaths []string) []DriftEntry`; `func FolderRedirectionState(rawShellFolderValue string) string` (returns `"redirected"` / `"not_redirected"` / `"unknown"`).
- The Windows `readDeviceState` fills every `DeviceState` field from the registry.

- [ ] **Step 1: Write the failing pure-logic tests**

```go
func TestComputeDrift(t *testing.T) {
	applied := []LibraryRule{
		{LibraryID: "l-1", DisplayName: "Finance Docs"},
		{LibraryID: "l-2", DisplayName: "Company"},
	}
	tests := []struct {
		name    string
		mounted []string
		want    []string // drifted library ids
	}{
		{
			name:    "all mounted",
			mounted: []string{`C:\Users\bob\Contoso\Contoso - Finance Docs`, `C:\Users\bob\Contoso\Contoso - Company`},
			want:    nil,
		},
		{
			name:    "one missing",
			mounted: []string{`C:\Users\bob\Contoso\Contoso - Company`},
			want:    []string{"l-1"},
		},
		{
			name:    "case-insensitive match",
			mounted: []string{`c:\users\bob\contoso\contoso - FINANCE DOCS`, `c:\x\contoso - company`},
			want:    nil,
		},
		{name: "nothing mounted", mounted: nil, want: []string{"l-1", "l-2"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ComputeDrift(applied, tt.mounted)
			var ids []string
			for _, d := range got {
				ids = append(ids, d.LibraryID)
				if d.Reason != "not_mounted" {
					t.Errorf("reason = %q, want not_mounted", d.Reason)
				}
			}
			if len(ids) != len(tt.want) {
				t.Fatalf("drift ids = %v, want %v", ids, tt.want)
			}
			for i := range ids {
				if ids[i] != tt.want[i] {
					t.Errorf("drift[%d] = %s, want %s", i, ids[i], tt.want[i])
				}
			}
		})
	}
}

func TestFolderRedirectionState(t *testing.T) {
	tests := []struct{ raw, want string }{
		{`C:\Users\bob\OneDrive - Contoso\Documents`, "redirected"},
		{`%USERPROFILE%\Documents`, "not_redirected"},
		{`D:\Docs`, "not_redirected"},
		{"", "unknown"},
	}
	for _, tt := range tests {
		if got := FolderRedirectionState(tt.raw); got != tt.want {
			t.Errorf("FolderRedirectionState(%q) = %q, want %q", tt.raw, got, tt.want)
		}
	}
}
```

- [ ] **Step 2: Run to confirm they fail**

Run: `cd agent && go test -race ./internal/onedrivehelper/...`
Expected: FAIL — undefined `ComputeDrift`, `FolderRedirectionState`.

- [ ] **Step 3: Implement the pure functions** (append to `onedrivehelper.go`):

```go
// ComputeDrift flags applied libraries whose display name matches no mounted
// local folder path. OneDrive's tenant cache stores mounted scopes as local
// folder paths of the form "<Org> - <LibraryName>", so a case-insensitive
// substring match on the display name is the practical detection (validated
// against the live-spike cache shape, see the 2026-06-19 spike doc). A rule
// the user previously stop-synced will never re-mount — that is exactly the
// drift this surfaces (spec: report, don't rewrite forever).
func ComputeDrift(applied []LibraryRule, mountedPaths []string) []DriftEntry {
	var out []DriftEntry
	for _, r := range applied {
		if r.DisplayName == "" {
			continue
		}
		needle := strings.ToLower(r.DisplayName)
		found := false
		for _, p := range mountedPaths {
			if strings.Contains(strings.ToLower(p), needle) {
				found = true
				break
			}
		}
		if !found {
			out = append(out, DriftEntry{LibraryID: r.LibraryID, DisplayName: r.DisplayName, Reason: "not_mounted"})
		}
	}
	return out
}

// FolderRedirectionState classifies a raw "User Shell Folders" value: KFM
// rewrites the shell folder to an absolute path inside the OneDrive root, so
// containing "onedrive" ⇒ redirected; an env-var/local path ⇒ not; empty ⇒ unknown.
func FolderRedirectionState(rawShellFolderValue string) string {
	if rawShellFolderValue == "" {
		return "unknown"
	}
	if strings.Contains(strings.ToLower(rawShellFolderValue), "onedrive") {
		return "redirected"
	}
	return "not_redirected"
}
```

- [ ] **Step 4: Run pure tests to confirm they pass**

Run: `cd agent && go test -race ./internal/onedrivehelper/...`
Expected: PASS.

- [ ] **Step 5: Replace the Windows `readDeviceState`**

In `onedrivehelper_windows.go`, replace the Task-8 placeholder:

```go
// shellFolderValues maps the KFM folder names we manage to their
// "User Shell Folders" registry value names.
var shellFolderValues = map[string]string{
	"Desktop":   "Desktop",
	"Documents": "Personal",
	"Pictures":  "My Pictures",
}

// readDeviceState reads OneDrive state across the active sessions. Flattening
// rule (device-level row, per-user reality): signedIn/version/KFM come from the
// first signed-in session; mounted libraries are the union of all sessions.
func readDeviceState(sessions []userSession, entitled []string, applied []LibraryRule) *DeviceState {
	state := &DeviceState{
		KfmFolderStates:   map[string]string{},
		MountedLibraries:  []string{},
		EntitledLibraries: entitled,
		DriftEntries:      []DriftEntry{},
	}

	// FOD reflects the policy we enforce (HKLM read-back).
	if k, err := registry.OpenKey(registry.LOCAL_MACHINE, policyKeyPath, registry.QUERY_VALUE); err == nil {
		if v, _, e := k.GetIntegerValue("FilesOnDemandEnabled"); e == nil && v == 1 {
			state.FilesOnDemandOn = true
		}
		k.Close()
	}

	primaryFound := false
	for _, s := range sessions {
		acct, err := registry.OpenKey(registry.USERS, s.sid+`\`+accountKeySubfix, registry.QUERY_VALUE)
		if err != nil {
			continue // this user isn't signed in to OneDrive Business
		}
		state.SignedIn = true
		if !primaryFound {
			primaryFound = true
			if v, _, e := acct.GetStringValue("OneDriveVersion"); e == nil {
				state.OneDriveVersion = v
			} else if k2, e2 := registry.OpenKey(registry.USERS, s.sid+`\SOFTWARE\Microsoft\OneDrive`, registry.QUERY_VALUE); e2 == nil {
				if v2, _, e3 := k2.GetStringValue("Version"); e3 == nil {
					state.OneDriveVersion = v2
				}
				k2.Close()
			}
			// KFM redirection per managed folder, from User Shell Folders.
			if usf, e := registry.OpenKey(registry.USERS,
				s.sid+`\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders`,
				registry.QUERY_VALUE); e == nil {
				for folder, valueName := range shellFolderValues {
					raw, _, re := usf.GetStringValue(valueName)
					if re != nil {
						state.KfmFolderStates[folder] = "unknown"
						continue
					}
					state.KfmFolderStates[folder] = FolderRedirectionState(raw)
				}
				usf.Close()
			}
		}
		acct.Close()

		// Mounted scopes: Tenants\<TenantName> value names are local folder paths.
		if tenants, e := registry.OpenKey(registry.USERS, s.sid+`\`+accountKeySubfix+`\Tenants`, registry.ENUMERATE_SUB_KEYS); e == nil {
			if subs, se := tenants.ReadSubKeyNames(-1); se == nil {
				for _, sub := range subs {
					if tk, te := registry.OpenKey(registry.USERS, s.sid+`\`+accountKeySubfix+`\Tenants\`+sub, registry.QUERY_VALUE); te == nil {
						if names, ne := tk.ReadValueNames(-1); ne == nil {
							for _, n := range names {
								if !containsString(state.MountedLibraries, n) {
									state.MountedLibraries = append(state.MountedLibraries, n)
								}
							}
						}
						tk.Close()
					}
				}
			}
			tenants.Close()
		}
	}

	state.DriftEntries = ComputeDrift(applied, state.MountedLibraries)
	return state
}
```

(Remove the `errors` import if now unused.)

- [ ] **Step 6: Cross-compile + full agent test suite**

Run: `cd agent && GOOS=windows GOARCH=amd64 go build ./... && go test -race ./...`
Expected: clean build; all PASS.

- [ ] **Step 7: Commit**

```bash
git add agent/internal/onedrivehelper/
git commit -m "feat(onedrive-helper): device-state reader — signed-in/FOD/KFM/mounted/drift"
```

---

## Task 10: Heartbeat wiring — dispatch seam + reported state

The thin seam connecting Phase-1 server plumbing to the new package, mirroring `patch_source.go`.

**Files:**
- Create: `agent/internal/heartbeat/onedrive.go`
- Modify: `agent/internal/heartbeat/heartbeat.go` — struct fields, `applyConfigUpdate` branch (~line 1650, after the `patch_source_settings` branch), `HeartbeatPayload` field (~line 62), payload population (near `payload.Battery`, ~line 2567)
- Test: `agent/internal/heartbeat/onedrive_test.go`

**Interfaces:**
- Consumes: `onedrivehelper.ParseConfig`, `onedrivehelper.Apply`, `onedrivehelper.Config`, `onedrivehelper.DeviceState` (Tasks 7–9).
- Produces: heartbeat responses containing `configUpdate.onedrive_helper_settings` (or camelCase `onedriveHelperSettings`) trigger `Apply`; the resulting state is sent as `onedriveDeviceState` on subsequent heartbeats.

- [ ] **Step 1: Write the failing seam test**

Open `agent/internal/heartbeat/patch_source.go` and its test file first; mirror exactly how that test constructs/obtains a `*Heartbeat` and overrides the seam var. Then:

```go
// agent/internal/heartbeat/onedrive_test.go
package heartbeat

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/onedrivehelper"
)

func TestApplyConfigUpdateOneDrive(t *testing.T) {
	tests := []struct {
		name       string
		update     map[string]any
		wantCalled bool
		wantLibs   int
	}{
		{
			name: "snake_case key dispatches",
			update: map[string]any{"onedrive_helper_settings": map[string]any{
				"base":      map[string]any{"silentAccountConfig": true, "restartOnChange": true},
				"libraries": []any{map[string]any{"libraryId": "l-1", "displayName": "D", "targetingMode": "everyone"}},
			}},
			wantCalled: true, wantLibs: 1,
		},
		{
			name: "camelCase key dispatches",
			update: map[string]any{"onedriveHelperSettings": map[string]any{
				"base": map[string]any{}, "libraries": []any{},
			}},
			wantCalled: true, wantLibs: 0,
		},
		{name: "absent key does not dispatch", update: map[string]any{"monitoring_settings": map[string]any{}}, wantCalled: false},
		{name: "invalid payload does not dispatch", update: map[string]any{"onedrive_helper_settings": "garbage"}, wantCalled: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			called := false
			var gotCfg onedrivehelper.Config
			orig := applyOneDrive
			applyOneDrive = func(cfg onedrivehelper.Config) (*onedrivehelper.DeviceState, error) {
				called = true
				gotCfg = cfg
				return &onedrivehelper.DeviceState{SignedIn: true}, nil
			}
			defer func() { applyOneDrive = orig }()

			h := &Heartbeat{} // mirror how patch_source's test constructs this
			h.applyConfigUpdate(tt.update)

			if called != tt.wantCalled {
				t.Fatalf("applyOneDrive called = %v, want %v", called, tt.wantCalled)
			}
			if called && len(gotCfg.Libraries) != tt.wantLibs {
				t.Errorf("libraries = %d, want %d", len(gotCfg.Libraries), tt.wantLibs)
			}
			if called {
				h.onedriveMu.Lock()
				if h.onedriveState == nil || !h.onedriveState.SignedIn {
					t.Error("state not captured on Heartbeat")
				}
				h.onedriveMu.Unlock()
			}
		})
	}
}
```

- [ ] **Step 2: Run to confirm it fails**

Run: `cd agent && go test -race ./internal/heartbeat/ -run TestApplyConfigUpdateOneDrive`
Expected: FAIL — undefined `applyOneDrive` / `onedriveMu` / no dispatch.

- [ ] **Step 3: Implement the seam file**

```go
// agent/internal/heartbeat/onedrive.go
package heartbeat

import (
	"github.com/breeze-rmm/agent/internal/onedrivehelper"
)
// ^ plus the same log import used by patch_source.go — copy its import block.

// applyOneDrive is the seam to the (Windows-only) OneDrive helper. A package
// var so tests can capture the parsed config on any platform (same pattern as
// applyWinUpdate in patch_source.go).
var applyOneDrive = onedrivehelper.Apply

// applyOneDriveHelperConfig parses and applies onedrive_helper_settings from
// the heartbeat configUpdate, capturing the resulting device state for the
// next outgoing heartbeat. Additive/idempotent: safe to run every heartbeat.
func (h *Heartbeat) applyOneDriveHelperConfig(raw any) {
	cfg, ok := onedrivehelper.ParseConfig(raw)
	if !ok {
		log.Warn("ignoring invalid onedrive_helper_settings payload: not an object")
		return
	}
	state, err := applyOneDrive(cfg)
	if err != nil {
		log.Warn("onedrive helper apply", "error", err.Error())
	}
	if state != nil {
		h.onedriveMu.Lock()
		h.onedriveState = state
		h.onedriveMu.Unlock()
	}
}
```

- [ ] **Step 4: Wire the Heartbeat struct, dispatcher, and payload**

In `heartbeat.go`:

(a) Struct fields (next to the `monitor *monitoring.Monitor` field, ~line 238):

```go
	// OneDrive helper state captured on config apply, reported next heartbeat.
	onedriveMu    sync.Mutex
	onedriveState *onedrivehelper.DeviceState
```

(b) `applyConfigUpdate` branch (after the `patch_source_settings` branch, ~line 1680):

```go
	// Apply onedrive_helper_settings if present (Phase 2). No-op on non-Windows.
	odRaw, hasOD := update["onedrive_helper_settings"]
	if !hasOD {
		odRaw, hasOD = update["onedriveHelperSettings"]
	}
	if hasOD {
		h.applyOneDriveHelperConfig(odRaw)
	}
```

(c) `HeartbeatPayload` field (~line 62, next to `Battery`):

```go
	OneDriveDeviceState *onedrivehelper.DeviceState `json:"onedriveDeviceState,omitempty"`
```

(d) Payload population (near `payload.Battery = …`, ~line 2567):

```go
	// OneDrive helper state (Phase 2). Nil until a config has been applied on a
	// Windows box — omitempty then drops the field entirely.
	h.onedriveMu.Lock()
	payload.OneDriveDeviceState = h.onedriveState
	h.onedriveMu.Unlock()
```

Add the `onedrivehelper` import to `heartbeat.go`.

- [ ] **Step 5: Run tests + cross-compile**

Run: `cd agent && go test -race ./internal/heartbeat/ -run TestApplyConfigUpdateOneDrive && go test -race ./... && GOOS=windows GOARCH=amd64 go build ./...`
Expected: all PASS; clean Windows build.

- [ ] **Step 6: Commit**

```bash
git add agent/internal/heartbeat/onedrive.go agent/internal/heartbeat/onedrive_test.go agent/internal/heartbeat/heartbeat.go
git commit -m "feat(onedrive-helper): heartbeat dispatch seam + onedriveDeviceState reporting"
```

---

## Task 11: End-to-end verification on the Windows VM (manual gate)

No code — prove the pipeline live before calling Phase 2 done. Use the `feature-testing` skill conventions; needs the Windows test VM enrolled against a local/dev stack (see `dev-push` memory notes: kill the watchdog first when pushing a dev agent build).

- [ ] **Step 1: Create the policy via API** (org with an M365 connection; token with `devices:write`):

```bash
# 1. Pick a library via the new picker (grab autoMountValue + display fields):
curl -s "$API/onedrive/libraries?orgId=$ORG_ID" -H "Authorization: Bearer $TOKEN" | jq '.libraries[0]'

# 2. Link onedrive_helper to a config policy assigned to the VM's device/org:
curl -s -X POST "$API/configuration-policies/$POLICY_ID/features" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{
    "featureType": "onedrive_helper",
    "inlineSettings": {
      "silentAccountConfig": true, "filesOnDemand": true,
      "kfmSilentOptIn": false, "restartOnChange": true,
      "libraries": [{
        "libraryId": "<autoMountValue from step 1>",
        "displayName": "<libraryName>", "siteUrl": "<siteUrl>",
        "targetingMode": "everyone"
      }]
    }
  }'
```

- [ ] **Step 2: Verify delivery** — next agent heartbeat response contains `configUpdate.onedrive_helper_settings` with the base + 1 library (check agent diagnostic logs or the API logs).

- [ ] **Step 3: Verify application on the VM** — `HKLM\SOFTWARE\Policies\Microsoft\OneDrive` has `SilentAccountConfig=1`, `FilesOnDemandEnabled=1`, `BreezeOneDriveManaged=1`; `HKU\<SID>\SOFTWARE\Policies\Microsoft\OneDrive\TenantAutoMount` has one `Breeze-…` value; the library mounts in File Explorer (allow a couple of minutes post timer-poke).

- [ ] **Step 4: Verify state ingest** — `onedrive_device_state` row for the device shows `signed_in=true`, the mounted path in `mounted_libraries`, the composite in `entitled_libraries`, and empty `drift_entries`:

```bash
docker exec -it breeze-postgres psql -U breeze -d breeze -c \
  "SELECT signed_in, mounted_libraries, entitled_libraries, drift_entries FROM onedrive_device_state;"
```

- [ ] **Step 5: Verify drift path** — on the VM, stop syncing the library (OneDrive settings → Stop sync), delete the mounted folder, wait for the next apply cycle: `drift_entries` should show `{"reason": "not_mounted", ...}` and OneDrive must NOT be stuck in a remount loop.

- [ ] **Step 6: Record results** in `docs/testing/FEATURE_TEST_LOG.md` per its existing format, then commit any doc updates.

---

## Self-Review (completed during authoring)

**Spec coverage (Sub-project A §§ vs tasks):** §6 spike → Task 1 (live gate; desk work already done). §1 data model → shipped Phase 1; write path that populates it → Tasks 2–4. §2 Graph → Task 5 (sharePointIds per the spike doc's "should be extended" note) + Task 6 (picker HTTP surface); optional `userCanAccessLibrary` pre-check deliberately deferred (spec marks it optional; add when Phase 4 brings per-user context). §3 delivery/ingest → shipped Phase 1; Task 10 closes the agent end. §4 applier → Tasks 7–9 (per-SID HKU writes, FOD-prerequisite base config first, TimerAutoMount poke, real-mount-state + drift instead of key-rewriting, gentle restart, macOS/Linux no-op via stub). §5 web UI → Phase 3 plan (explicitly out of scope). Additive-only/no-unmount → applier never deletes AutoMount values. Per-user graph_group → pending set, fail-closed (Phase 4). Reporting-first → Task 9 + Phase-1 ingest + Task 11 Step 4/5 verify.

**Placeholder scan:** every code step carries real code. Two deliberate look-ups remain and are flagged inline as verification (not deferral): x/sys WTS symbol spellings (Task 8 — mirror `detector_windows.go`) and middleware import paths (Task 6 — copy from `m365.ts`); both name the exact reference file. Task 8's `readDeviceState` placeholder is explicitly replaced by Task 9 in the same PR-stream.

**Type consistency:** `Config`/`BaseConfig`/`LibraryRule`/`DeviceState`/`DriftEntry` JSON tags match the shipped server wire shapes (helpers.ts `OnedriveConfigUpdate`, heartbeat.ts zod). `ParseConfig`/`PartitionLibraries`/`ValueName`/`TenantIDFromComposite`/`ComputeDrift`/`FolderRedirectionState`/`Apply` names consistent across Tasks 7–10. `onedriveHelperInlineSettingsSchema` name consistent across Tasks 2–4. `buildTenantAutoMountValue` field object `{tenantId,siteId,webId,listId,siteUrl}` consistent between Task 5 impl and tests. `applyOneDrive` seam var name consistent between Task 10 code and test.
