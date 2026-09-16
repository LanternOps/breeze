---
tracking_issue: LanternOps/breeze#6008
---
# Backup Provider Integration W04: Portal + Reports — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the unified backup-health read model (W03) into the customer portal's Backups page/tile and into the two reports (posture, org narrative) so a device protected only by Cove Data Protection shows as protected everywhere Breeze already shows first-party backups.

**Architecture:** `apps/api/src/services/portal/backupReadModel.ts` (`backupTile`, `backupOverview`, `backupDevicesPage`) is rewritten to fold provider rows in via W03's `listBackupHealthRows`/`summarizeBackupHealth`, while verification/test-restore/SLA-breach/readiness stay on their existing first-party queries. Two portal React components (`BackupOverview.tsx`, `BackupDeviceTable.tsx`) render the new fields using the portal's existing "Guest Ledger" primitives (`StatusMark`, ledger rows) — no new UI primitives, no i18n (the portal has none — see Task 1 DECISION). `securityComplianceReport.ts` adds one new query plus `SecurityProductEvidence` pushes so provider connections flow through the *existing* `buildSecurityProductInventory` product-inventory path exactly like Huntress/SentinelOne/DNS do today; `reportPdf.ts` widens `buildPostureBackupMetric` from a single Yes/No into a list of every `backup`-category product and makes the per-device coverage note category-aware. `narrativeContext.ts` adds a ninth, device-health-shaped loader (`loadBackupProviders`) alongside the existing eight, and `runnerPrompt.ts` renders it under the existing "## Backups" heading.

**Tech Stack:** Hono (TypeScript) API routes/services, Drizzle ORM + raw `drizzle-orm` `sql` templates, Astro + React 19 islands (customer portal only — no react-i18next here), Vitest (API: `db.select`-chain mocks and compiled-SQL assertions; portal: jsdom + Testing Library), `jsPDF` report renderer in `packages/shared`.

**Spec:** `docs/superpowers/specs/integrations/2026-09-15-backup-provider-integration-cove-design.md` — this wave ships the **Client portal** section in full and the **Reports** section's posture-report and org-narrative-bullets parts only (the "Backup status report" is W05, out of scope here). Where this plan is more specific than the spec, the plan wins and every such point is marked **DECISION** inline.

**Cross-wave names (from the plan index — do not rename):** consumed verbatim from W01/W03 (assumed to exist exactly as the plan index states; their plans are being written in parallel and are not read here):
- `apps/api/src/services/backupHealthReadModel.ts`: `listBackupHealthRows(scope: { orgIds: string[]; siteIds?: string[] }, opts: BackupHealthListOptions): Promise<{ rows: BackupHealthRow[]; nextCursor: string | null }>`, `summarizeBackupHealth(scope, opts): Promise<BackupHealthSummary>`, `getProviderCoverageForDevices(orgId, deviceIds: string[]): Promise<Map<string, { covered: boolean; health: BackupHealth }>>`.
- `@breeze/shared`: `deriveBackupHealth`, `type BackupHealth = 'healthy'|'warning'|'critical'|'unknown'`, `type BackupRecency`, `type ExternalBackupStatus`, `type BackupHealthRow` (`key`, `source: 'breeze'|'provider'`, `providerKey`, `providerLabel`, `deviceId`, `name`, `status`, `health`, `recency`, `covered`, `stale`, `lastSuccessAt`, …), `type BackupHealthSummary` (`{ endpoints: { total, covered, uncovered }, providerOnly, m365Accounts, byStatus, byHealth, byRecency }`), `type PostureProduct`, `type PostureProductCategory`.
- `apps/api/src/services/backupProviders/registry.ts`: `getBackupProvider(key: string): BackupProviderAdapter` (throws on an unknown key — never called speculatively in this plan).
- Defined by **this** wave and consumed nowhere else: `packages/shared/src/types/portalVisibility.ts` `BackupDeviceRow`/`BackupOverviewDto` additions (the plan index's exact field set, §"Portal DTO additions").

---

## Global Constraints

- **Migration:** none. This wave adds zero columns/tables and touches zero RLS policy. State this explicitly in the PR body: "No schema change in this wave; `tenant-export-policy` and `rls-coverage` contract suites are untouched."
- **Branch:** `feature/6008-backup-provider-integration/wave-6012`. **PR body:** `Closes #6012`. Stacked on W03's branch per the plan index (`W04 (#6012) depends on W03`) — dispatch CI per branch before enqueueing: `gh workflow run CI --ref feature/6008-backup-provider-integration/wave-6012` (stacked branches get no `pull_request` CI run).
- **Commits:** every commit message ends with:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  ```
- **Test commands (never insert `--` before a passthrough flag):**
  - API: `cd apps/api && npx vitest run <path>` (its `test` script is bare `vitest`, so `pnpm --filter @breeze/api test --run <path>` also works but the `npx vitest run` form is used throughout this plan to sidestep the `--` trap entirely).
  - Portal: `cd apps/portal && npx vitest run <path>` (its `test` script is already `vitest run`, so `pnpm --filter @breeze/portal test <path>` also works, but `npx vitest run` is used uniformly below).
  - Shared: `cd packages/shared && npx vitest run <path>`.
  - Typecheck: no root typecheck script — CI runs it via turbo. Locally, `cd apps/api && pnpm exec tsc --noEmit` / `cd apps/portal && pnpm exec astro check` / `cd packages/shared && pnpm exec tsc --noEmit` after each task.
  - This wave touches no tenancy/cascade code, so `pnpm test-stack up` / the RLS/integration suites are **not required** before this PR — run them only if a later fixup in this wave ever touches a migration (it should not).
- **DECISION — the customer portal (`apps/portal`) has no i18n system.** Verified: `find apps/portal -iname '*locale*' -o -iname '*i18n*'` returns nothing, and `grep -rn "react-i18next|useTranslation" apps/portal/src/components/portal/*.tsx` returns nothing. Every string in `BackupOverview.tsx`/`BackupDeviceTable.tsx`/`DashboardTiles.tsx` today is a literal English string (e.g. `BackupOverview.tsx:23-26`, `apps/portal/src/components/portal/ui.tsx`). This **contradicts** the wave brief's instruction to "add i18n key `backups.managedCloudBackup` in the portal locales, list every locale" — there is no such directory and no key mechanism to add it to. CLAUDE.md's i18n-real-translations rule is a rule about `apps/web` (which has `apps/web/src/locales/*`); it does not apply to `apps/portal`. The generic label "Managed cloud backup" (D5) is therefore a plain literal string, written once, exactly like every other string on this page — see Task 3.
- **`runAction` rule:** N/A to this wave — every file this wave touches is read-only (GET endpoints, report generation, narrative context). No new POST/PUT/PATCH/DELETE handler is added anywhere in W04.
- **File size:** every file touched stays under ~500 lines after this wave's edits (`backupReadModel.ts` grows from 304 to ~360 lines; `securityComplianceReport.ts` from 610 to ~650; `narrativeContext.ts` from 1211 to ~1260 — all comfortably under the guideline).
- **Never edit a shipped migration / no migration exists to edit** — moot this wave.

---

## File structure

| Path | Change | Responsibility |
|---|---|---|
| `packages/shared/src/types/portalVisibility.ts` | modify | `BackupDeviceRow` += `source`/`providerLabel`/`status`/`health`/`lastSuccessAt`; `BackupOverviewDto` += `byHealth`/`externalProviders` |
| `apps/api/src/services/portal/backupReadModel.ts` | modify | `backupTile` provider-aware coverage gated on `enableBackups`; `backupOverview` += `byHealth`/`externalProviders`; `backupDevicesPage` merges unified rows + provider-only rows |
| `apps/api/src/services/portal/backupReadModel.test.ts` | modify | new mocks for `listBackupHealthRows`/`summarizeBackupHealth`; updated + new cases |
| `apps/portal/src/components/portal/BackupOverview.tsx` | modify | "Backup health" and "Third-party backup" ledger rows |
| `apps/portal/src/components/portal/BackupOverview.test.tsx` | modify | fixtures + row-count/label assertions updated; 2 new tests |
| `apps/portal/src/components/portal/BackupDeviceTable.tsx` | modify | Source + Health columns; `—` for readiness/test-restore/breach on external rows |
| `apps/portal/src/components/portal/BackupDeviceTable.test.tsx` | modify | fixtures + header/phone-label assertions updated; 2 new tests |
| `apps/api/src/services/securityComplianceReport.ts` | modify | one new query (`backup_provider_devices`, linked rows); provider `SecurityProductEvidence` pushes; `backupConfigured` widened |
| `apps/api/src/services/securityComplianceReport.test.ts` | modify | `mockGeneratorQueries` renumbered (new slot #10); 2 new tests |
| `packages/shared/src/reportPdf/reportPdf.ts` | modify | `buildPostureBackupMetric` lists every backup product; `drawPostureProductRow` wording is category-aware |
| `packages/shared/src/reportPdf/reportPdf.test.ts` | modify | 2 new `buildPostureBackupMetric` tests; 1 new `drawPostureProductRow` wording test |
| `apps/api/src/services/aiAgents/narrativeContext.ts` | modify | `RawBackupProviderInputs`/`NarrativeContext['backupProviders']`; `loadBackupProviders`; assembler wiring incl. byte-ceiling trim |
| `apps/api/src/services/aiAgents/narrativeContext.test.ts` | modify | cascade/never-throws lists gain `'backupProviders'`; new `loadBackupProviders` describe block |
| `apps/api/src/services/aiAgents/runnerPrompt.ts` | modify | render the provider block under the existing `## Backups` heading |
| `apps/api/src/services/aiAgents/runnerPrompt.test.ts` | modify | `narrativeContext()` fixture gains `backupProviders`; 4 new assertions |

Not touched this wave (read, not written): `apps/api/src/routes/portal/backups.ts`, `apps/api/src/routes/portal/index.ts`, `apps/portal/src/pages/backups/index.astro`, `apps/portal/src/lib/api.ts`, `apps/portal/src/lib/visibilityGate.ts`, `apps/portal/src/lib/navItems.ts`, `apps/portal/src/lib/protectedPaths.ts`, `apps/api/src/services/portal/dashboard.ts`, `apps/api/src/services/portal/dashboard.test.ts`, `apps/api/src/services/portal/portalFlags.ts`, `apps/api/src/services/securityComplianceReportProducts.ts`, `packages/shared/src/types/postureReport.ts`, `packages/shared/src/types/orgNarrativeReport.ts` — see each task's "Why no change" note.

---

### Task 1: Shared portal DTOs

**Files:**
- Modify: `packages/shared/src/types/portalVisibility.ts:166-206` (verified by reading the file: `BackupDeviceRow` at line 166, `BackupOverviewDto` at line 183, `BackupDevicesDto` at line 202)

**Interfaces:**
Produces (consumed by Tasks 2-4):
```ts
export type BackupDeviceRow = {
  id: string;
  name: string;
  configured: boolean;
  lastRestorePointAt: string | null;
  lastRestorePointDegraded: boolean;
  lastTestRestore: { status: string; completedAt: string | null; restoreTimeSeconds: number | null } | null;
  openBreaches: string[];
  readinessScore: number | null;
  estimatedRtoMinutes: number | null;
  estimatedRpoMinutes: number | null;
  source: 'breeze' | 'external';
  providerLabel: string | null;
  status: ExternalBackupStatus;
  health: BackupHealth;
  lastSuccessAt: string | null;
};
export type BackupOverviewDto = {
  /* …unchanged existing fields… */
  byHealth: Record<BackupHealth, number>;
  externalProviders: string[];
};
```

**DECISION:** the plan index says "additive; make the new `BackupDeviceRow` fields required in the type but tolerate absence in the portal renderer for one release if any test fixture lacks them." The five new fields are therefore **non-optional** here (a producer that forgets one is a compile error), while `BackupDeviceTable.tsx` (Task 4) reads them defensively (`device.health ?? 'unknown'`) so a stale cached payload or an as-yet-unmigrated test fixture degrades to "Unknown" rather than throwing.

- [ ] **Step 1: Write the failing test**

```ts
// packages/shared/src/types/__tests__/portalVisibility.backupProvider.test.ts
import { describe, expect, it } from 'vitest';
import type { BackupDeviceRow, BackupOverviewDto } from '../portalVisibility';

describe('BackupDeviceRow / BackupOverviewDto — W04 provider fields', () => {
  it('BackupDeviceRow accepts an external provider row', () => {
    const row: BackupDeviceRow = {
      id: 'provider:11111111-1111-4111-8111-111111111111',
      name: 'FILE01',
      configured: true,
      lastRestorePointAt: '2026-09-14T03:00:00Z',
      lastRestorePointDegraded: false,
      lastTestRestore: null,
      openBreaches: [],
      readinessScore: null,
      estimatedRtoMinutes: null,
      estimatedRpoMinutes: null,
      source: 'external',
      providerLabel: 'Cove Data Protection',
      status: 'completed',
      health: 'healthy',
      lastSuccessAt: '2026-09-14T03:00:00Z',
    };
    expect(row.source).toBe('external');
  });

  it('BackupOverviewDto carries byHealth and externalProviders', () => {
    const dto: Pick<BackupOverviewDto, 'byHealth' | 'externalProviders'> = {
      byHealth: { healthy: 4, warning: 1, critical: 0, unknown: 0 },
      externalProviders: ['Cove Data Protection'],
    };
    expect(dto.byHealth.healthy).toBe(4);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd packages/shared && npx vitest run src/types/__tests__/portalVisibility.backupProvider.test.ts
```
Expected: TypeScript compile error — `Property 'source' is missing in type` (and `byHealth`/`externalProviders` unknown on `BackupOverviewDto`) — vitest reports it as a failed transform, not a runtime assertion failure.

- [ ] **Step 3: Implement**

```ts
// packages/shared/src/types/portalVisibility.ts
// add near the top, alongside the existing single import
import type { BackupHealth, ExternalBackupStatus } from './backupHealth'; // W01 (plan index)
```

```ts
// packages/shared/src/types/portalVisibility.ts:166-181 — replace the existing interface
export interface BackupDeviceRow {
  id: string;
  name: string;
  configured: boolean;
  lastRestorePointAt: string | null;
  lastRestorePointDegraded: boolean;
  lastTestRestore: {
    status: string;
    completedAt: string | null;
    restoreTimeSeconds: number | null;
  } | null;
  openBreaches: string[];
  readinessScore: number | null;
  estimatedRtoMinutes: number | null;
  estimatedRpoMinutes: number | null;
  /** W04 (#6012): 'breeze' for a first-party-backed-up device (a provider may
   *  ALSO be linked — see `providerLabel`); 'external' only for a provider row
   *  with no linked Breeze device (`id` is then `provider:<row id>`). */
  source: 'breeze' | 'external';
  /** Set whenever a linked or unlinked provider row contributes to this row,
   *  regardless of `source` — the adapter label or the generic "Managed cloud
   *  backup" string per the connection's `show_provider_name_in_portal` flag
   *  (D5), already resolved server-side (backupReadModel.ts). */
  providerLabel: string | null;
  status: ExternalBackupStatus;
  health: BackupHealth;
  lastSuccessAt: string | null;
}
```

```ts
// packages/shared/src/types/portalVisibility.ts:183-201 — replace the existing interface
export interface BackupOverviewDto {
  dataStatus: TileStatus;
  asOf: string;
  protected: number | null;
  unprotected: number | null;
  total: number | null;
  lastPassedVerification: {
    completedAt: string;
    verificationType: string;
  } | null;
  lastTestRestoreAt: string | null;
  openRpoBreaches: number | null;
  openRtoBreaches: number | null;
  meanReadinessScore: number | null;
  lastTestRestoreStatus: string | null;
  readinessScoredDevices: number | null;
  readinessTotalDevices: number | null;
  /** W04 (#6012): device counts by derived health, across BOTH sources —
   *  `deriveBackupHealth`'s four buckets, always present (zero-filled). */
  byHealth: Record<BackupHealth, number>;
  /** W04 (#6012): distinct provider labels contributing to this org's backup
   *  picture (D5-resolved — "Cove Data Protection" or "Managed cloud backup"),
   *  sorted. Empty when no connection has a linked or unlinked row here. */
  externalProviders: string[];
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd packages/shared && npx vitest run src/types/__tests__/portalVisibility.backupProvider.test.ts
cd packages/shared && npx tsc --noEmit
```
Expected: 2 tests pass; `tsc --noEmit` clean (this will only be fully green once W01's `types/backupHealth.ts` exists — if run before W01 merges, the import resolves to a missing-module error, which is expected and documented in the PR as "depends on W01/W03 landing first").

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types/portalVisibility.ts packages/shared/src/types/__tests__/portalVisibility.backupProvider.test.ts
git commit -m "$(cat <<'EOF'
feat(portal): add provider fields to BackupDeviceRow/BackupOverviewDto

W04 Task 1. Additive per the plan index: source/providerLabel/status/health/
lastSuccessAt on BackupDeviceRow, byHealth/externalProviders on
BackupOverviewDto — required in the type, defensively read by the renderer.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Portal read model — `backupReadModel.ts`

**Files:**
- Modify: `apps/api/src/services/portal/backupReadModel.ts` (full file, 304 lines today — `backupTile` at line 10, `backupOverview` at line 84, `backupDevicesPage` at line 174)
- Modify: `apps/api/src/services/portal/backupReadModel.test.ts` (354 lines today)

**Interfaces:**
Consumes: `listBackupHealthRows`, `summarizeBackupHealth` (plan index, `apps/api/src/services/backupHealthReadModel.ts`, W03); `portalBranding` table (`apps/api/src/db/schema/portal.ts:40`, column `enableBackups`, verified); existing `backupConfigs`/`backupJobs`/`backupVerifications`/`devices`/`recoveryReadiness`/`RESTORABLE_BACKUP_JOB_STATUSES` schema exports (unchanged).
Produces: `backupTile(orgId, now): Promise<BackupTileDto>` (unchanged signature — consumed by `dashboard.ts:62`, itself unchanged this wave), `backupOverview(orgId, args): Promise<BackupOverviewDto>`, `backupDevicesPage(orgId, args): Promise<BackupDevicesDto>` (both unchanged signatures — consumed by `routes/portal/backups.ts:46,58`, itself unchanged this wave).

**Why no change to `dashboard.ts` or `routes/portal/backups.ts`:** `dashboard.ts:62` already calls `backupTile(orgId, args.now)` unconditionally; the enable_backups gate this task adds lives *inside* `backupTile` (queries `portalBranding` itself, mirroring `serviceReadModel.ts:497-506`'s `serviceTile` pattern), so the call site needs no edit. `routes/portal/backups.ts:44-64` already forwards to `backupOverview`/`backupDevicesPage` with no shape assumptions beyond the DTOs — unaffected.

**DECISION (pagination):** the unified read model (`listBackupHealthRows`) is cursor-paginated; the portal's existing `BackupDevicesDto.pagination` contract is offset/page/total (unchanged this wave — no producer/consumer edits outside this file). The two schemes cannot be reconciled without either restructuring the DTO (out of scope — not in the plan index's additive field list) or accepting an approximation. This plan keeps the **existing SQL-level `.limit()/.offset()` for Breeze device rows exactly as it is today** (zero pagination-behavior change for the dominant case) and appends provider-only (unlinked) rows **to page 1 only**, capped at 200. `pagination.total` is `breezeTotal + externalOnlyCount`, so "Showing N of M" stays honest even though external rows only physically appear on page 1. The sole caller (`apps/portal/src/pages/backups/index.astro:19`) always requests `{ page: 1, limit: 100 }`, so this is not a behavior regression in practice; a genuine multi-page cross-source merge is flagged here as a follow-up if the portal ever ships incremental loading.

**DECISION (status/health when a device has both sources):** a Breeze device that is also provider-linked yields entries for BOTH `source: 'breeze'` and `source: 'provider'` in `listBackupHealthRows`' output (spec, Unified read model section). The portal shows **one row per Breeze device** (plan index recommendation): `status`/`health` come from the `source: 'breeze'` entry when one exists (Breeze's own product is authoritative for the headline state), `lastSuccessAt` is the max of both (a fresher provider success still moves the "last backup" date), and `providerLabel` is populated from the `source: 'provider'` entry whenever one is linked — regardless of which entry supplied `status`/`health`. `source` on the merged portal row is always `'breeze'` in this case; `'external'` is reserved for provider rows with no linked Breeze device.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/services/portal/backupReadModel.test.ts
// REPLACE THE WHOLE FILE with the version below.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const state = vi.hoisted(() => ({
  rows: [] as unknown[][],
  wheres: [] as unknown[],
  joins: [] as unknown[],
  orderBys: [] as unknown[],
  selections: [] as unknown[],
}));

vi.mock('../../db', () => ({
  db: {
    select: vi.fn((selection: unknown) => {
      state.selections.push(selection);
      const chain: Record<string, unknown> = {};
      for (const method of ['from', 'innerJoin', 'leftJoin', 'where', 'orderBy', 'limit', 'offset']) {
        chain[method] = vi.fn((arg: unknown, on?: unknown) => {
          if ((method === 'innerJoin' || method === 'leftJoin') && on) state.joins.push(on);
          if (method === 'where') state.wheres.push(arg);
          if (method === 'orderBy') state.orderBys.push(arg);
          return chain;
        });
      }
      chain.then = (resolve: (rows: unknown[]) => unknown) =>
        Promise.resolve(state.rows.shift() ?? []).then(resolve);
      return chain;
    }),
  },
}));

// W04: the unified read model is a SEPARATE service module, mocked
// independently of the `db.select` chain above so its call order never
// interleaves with the raw-SQL-shaped `state.rows` queue.
const health = vi.hoisted(() => ({
  listBackupHealthRows: vi.fn(),
  summarizeBackupHealth: vi.fn(),
}));
vi.mock('../backupHealthReadModel', () => health);

import { backupTile } from './backupReadModel';

const ORG_ID = '11111111-1111-4111-8111-111111111111';

/** Default: enable_backups is on (query #5) and the unified model has no
 *  provider rows — matches "an org with no Cove connection sees the exact
 *  behavior it saw before this wave." */
function seedBranding(enableBackups = true) {
  state.rows.push([{ enableBackups }]);
}

beforeEach(() => {
  state.rows.length = 0;
  state.wheres.length = 0;
  state.joins.length = 0;
  state.orderBys.length = 0;
  state.selections.length = 0;
  health.listBackupHealthRows.mockReset().mockResolvedValue({ rows: [], nextCursor: null });
  health.summarizeBackupHealth.mockReset().mockResolvedValue({
    endpoints: { total: 0, covered: 0, uncovered: 0 },
    providerOnly: 0,
    m365Accounts: 0,
    byStatus: {},
    byHealth: { healthy: 0, warning: 0, critical: 0, unknown: 0 },
    byRecency: {},
  });
});

describe('backupTile', () => {
  it('returns latest passed verification and configured-device counts when enable_backups is off', async () => {
    state.rows.push(
      [{ total: 10 }],
      [{ id: 'active-config' }],
      [{ configured: 7 }],
      [{
        completedAt: new Date('2026-09-02T09:00:00Z'),
        verificationType: 'test_restore',
      }],
    );
    seedBranding(false);

    const now = new Date('2026-09-02T12:00:00Z');
    await expect(backupTile(ORG_ID, now)).resolves.toEqual({
      status: 'ok',
      completedAt: '2026-09-02T09:00:00.000Z',
      verificationType: 'test_restore',
      configured: 7,
      total: 10,
      asOf: now.toISOString(),
    });
    expect(health.summarizeBackupHealth).not.toHaveBeenCalled();

    for (const where of state.wheres) {
      const query = new PgDialect().sqlToQuery(where as SQL);
      expect(query.params).toContain(ORG_ID);
    }
  });

  it('returns no_data when an active config exists but no job or verification has run', async () => {
    state.rows.push([{ total: 10 }], [{ id: 'active-config' }], [{ configured: 0 }], []);
    seedBranding(false);
    const now = new Date('2026-09-02T12:00:00Z');
    await expect(backupTile(ORG_ID, now)).resolves.toMatchObject({
      status: 'no_data',
      completedAt: null,
      configured: 0,
      total: 10,
      asOf: now.toISOString(),
    });
  });

  it('returns not_configured only when there is no active config AND no provider coverage', async () => {
    state.rows.push([{ total: 10 }], [], [{ configured: 0 }], []);
    seedBranding(false);
    await expect(
      backupTile(ORG_ID, new Date('2026-09-02T12:00:00Z')),
    ).resolves.toMatchObject({
      status: 'not_configured',
      completedAt: null,
      configured: 0,
      total: 10,
    });
  });

  it('widens configured/total to provider coverage when enable_backups is on', async () => {
    state.rows.push([{ total: 10 }], [{ id: 'active-config' }], [{ configured: 3 }], [
      { completedAt: new Date('2026-09-02T09:00:00Z'), verificationType: 'test_restore' },
    ]);
    seedBranding(true);
    health.summarizeBackupHealth.mockResolvedValue({
      endpoints: { total: 10, covered: 6, uncovered: 4 },
      providerOnly: 1,
      m365Accounts: 0,
      byStatus: {},
      byHealth: { healthy: 6, warning: 0, critical: 4, unknown: 0 },
      byRecency: {},
    });

    const now = new Date('2026-09-02T12:00:00Z');
    await expect(backupTile(ORG_ID, now)).resolves.toMatchObject({
      status: 'ok',
      configured: 6, // NOT the first-party-only 3
      total: 10,
    });
    expect(health.summarizeBackupHealth).toHaveBeenCalledWith({ orgIds: [ORG_ID] }, {});
  });

  it('treats provider-only coverage as configured even with no first-party active config', async () => {
    state.rows.push([{ total: 4 }], [], [{ configured: 0 }], []);
    seedBranding(true);
    health.summarizeBackupHealth.mockResolvedValue({
      endpoints: { total: 4, covered: 2, uncovered: 2 },
      providerOnly: 0,
      m365Accounts: 0,
      byStatus: {},
      byHealth: { healthy: 2, warning: 0, critical: 2, unknown: 0 },
      byRecency: {},
    });

    await expect(
      backupTile(ORG_ID, new Date('2026-09-02T12:00:00Z')),
    ).resolves.toMatchObject({ status: 'no_data', configured: 2, total: 4 });
  });

  it('does not claim a passed verification just because a provider covers devices (completedAt stays first-party)', async () => {
    state.rows.push([{ total: 4 }], [{ id: 'active-config' }], [{ configured: 0 }], []); // no verification row
    seedBranding(true);
    health.summarizeBackupHealth.mockResolvedValue({
      endpoints: { total: 4, covered: 4, uncovered: 0 },
      providerOnly: 0,
      m365Accounts: 0,
      byStatus: {},
      byHealth: { healthy: 4, warning: 0, critical: 0, unknown: 0 },
      byRecency: {},
    });

    await expect(
      backupTile(ORG_ID, new Date('2026-09-02T12:00:00Z')),
    ).resolves.toMatchObject({ completedAt: null, verificationType: null, status: 'no_data' });
  });
});
```

```ts
// apps/api/src/services/portal/backupReadModel.test.ts (continued — same file)
import { backupDevicesPage, backupOverview } from './backupReadModel';
import type { BackupHealthRow } from '@breeze/shared';

const breezeRow = (over: Partial<BackupHealthRow> = {}): BackupHealthRow => ({
  key: 'breeze:d-1',
  source: 'breeze',
  providerKey: null,
  providerLabel: null,
  orgId: ORG_ID,
  orgName: 'Acme',
  siteId: null,
  deviceId: 'd-1',
  name: 'Laptop',
  computerName: 'Laptop',
  osType: 'workstation',
  accountType: 'endpoint',
  status: 'completed',
  health: 'healthy',
  recency: 'under_24h',
  covered: true,
  stale: false,
  lastSuccessAt: '2026-09-02T02:00:00.000Z',
  lastSessionAt: '2026-09-02T02:00:00.000Z',
  selectedBytes: null,
  usedBytes: null,
  errorsCount: 0,
  dataSources: [],
  history28d: [],
  agentOnline: true,
  ...over,
} as BackupHealthRow);

describe('backupOverview', () => {
  it('returns overview verification, restore, breach, readiness, byHealth and externalProviders', async () => {
    // backupTile's own 5 selects, then restoreRows/breachRows/readinessRows.
    state.rows.push(
      [{ total: 3 }],
      [{ id: 'active-config' }],
      [{ configured: 2 }],
      [{ completedAt: new Date('2026-09-02T09:00:00Z'), verificationType: 'integrity' }],
      [{ enableBackups: true }],
      [{ completedAt: new Date('2026-09-01T09:00:00Z'), status: 'failed' }],
      [{ eventType: 'rpo_breach' }, { eventType: 'rto_breach' }, { eventType: 'missed_backup' }],
      [{ readinessCount: 2, totalDevices: 3, meanReadinessScore: 83 }],
    );
    health.summarizeBackupHealth.mockResolvedValue({
      endpoints: { total: 3, covered: 2, uncovered: 1 },
      providerOnly: 0,
      m365Accounts: 0,
      byStatus: {},
      byHealth: { healthy: 2, warning: 0, critical: 1, unknown: 0 },
      byRecency: {},
    });
    health.listBackupHealthRows.mockResolvedValue({
      rows: [
        breezeRow({ source: 'provider', providerLabel: 'Cove Data Protection', deviceId: 'd-1' }),
        breezeRow({ key: 'provider:row-2', source: 'provider', providerLabel: 'Cove Data Protection', deviceId: null }),
      ],
      nextCursor: null,
    });

    await expect(backupOverview(ORG_ID, {
      timezone: 'America/Denver',
      now: new Date('2026-09-02T12:00:00Z'),
    })).resolves.toEqual({
      asOf: '2026-09-02T12:00:00.000Z',
      dataStatus: 'ok',
      protected: 2,
      unprotected: 1,
      total: 3,
      lastPassedVerification: { completedAt: '2026-09-02T09:00:00.000Z', verificationType: 'integrity' },
      lastTestRestoreAt: '2026-09-01T09:00:00.000Z',
      lastTestRestoreStatus: 'failed',
      openRpoBreaches: 2,
      openRtoBreaches: 1,
      meanReadinessScore: 83,
      readinessScoredDevices: 2,
      readinessTotalDevices: 3,
      byHealth: { healthy: 2, warning: 0, critical: 1, unknown: 0 },
      externalProviders: ['Cove Data Protection'],
    });
    expect(health.listBackupHealthRows).toHaveBeenCalledWith(
      { orgIds: [ORG_ID] },
      { sources: ['provider'], page: { limit: 200, cursor: null } },
    );
  });

  it('de-dupes and sorts externalProviders, and reports none when no provider row has a label', async () => {
    state.rows.push(
      [{ total: 1 }], [], [{ configured: 0 }], [], [{ enableBackups: true }], [], [], [],
    );
    health.summarizeBackupHealth.mockResolvedValue({
      endpoints: { total: 1, covered: 0, uncovered: 1 },
      providerOnly: 0, m365Accounts: 0, byStatus: {},
      byHealth: { healthy: 0, warning: 0, critical: 1, unknown: 0 }, byRecency: {},
    });
    health.listBackupHealthRows.mockResolvedValue({
      rows: [
        breezeRow({ source: 'provider', providerLabel: 'Managed cloud backup', deviceId: 'd-1' }),
        breezeRow({ key: 'provider:row-3', source: 'provider', providerLabel: 'Managed cloud backup', deviceId: null }),
        breezeRow({ key: 'provider:row-4', source: 'provider', providerLabel: null, deviceId: null }),
      ],
      nextCursor: null,
    });

    const overview = await backupOverview(ORG_ID, { timezone: 'UTC', now: new Date('2026-09-02T12:00:00Z') });
    expect(overview.externalProviders).toEqual(['Managed cloud backup']);
  });
});

describe('backupDevicesPage', () => {
  it('merges the unified row for a breeze device: status/health/lastSuccessAt and providerLabel from the linked provider row', async () => {
    state.rows.push(
      [{ count: 1 }],
      [{
        id: 'd-1', hostname: 'file01', displayName: null, configured: true,
        testRestoreStatus: 'passed', testRestoreAt: '2026-09-01T09:00:00.000Z', restoreTimeSeconds: 120,
        openBreaches: [], readinessScore: 92, estimatedRtoMinutes: 30, estimatedRpoMinutes: 60,
      }],
    );
    health.listBackupHealthRows.mockResolvedValue({
      rows: [
        breezeRow({ deviceId: 'd-1', status: 'completed_with_errors', health: 'warning', lastSuccessAt: '2026-09-01T00:00:00.000Z' }),
        breezeRow({
          key: 'x', source: 'provider', deviceId: 'd-1', providerLabel: 'Cove Data Protection',
          status: 'completed', health: 'healthy', lastSuccessAt: '2026-09-02T03:00:00.000Z',
        }),
      ],
      nextCursor: null,
    });

    const page = await backupDevicesPage(ORG_ID, { page: 1, limit: 25, timezone: 'UTC', now: new Date('2026-09-02T12:00:00Z') });
    expect(page.data).toEqual([{
      id: 'd-1',
      name: 'file01',
      configured: true,
      lastRestorePointAt: '2026-09-02T03:00:00.000Z', // MAX across sources
      lastRestorePointDegraded: true, // breeze status wins: completed_with_errors
      lastTestRestore: { status: 'passed', completedAt: '2026-09-01T09:00:00.000Z', restoreTimeSeconds: 120 },
      openBreaches: [], readinessScore: 92, estimatedRtoMinutes: 30, estimatedRpoMinutes: 60,
      source: 'breeze',
      providerLabel: 'Cove Data Protection',
      status: 'completed_with_errors',
      health: 'warning',
      lastSuccessAt: '2026-09-02T03:00:00.000Z',
    }]);
    expect(page.pagination).toEqual({ page: 1, limit: 25, total: 1 });
  });

  it('appends provider-only (unlinked) rows to page 1, marked source: external with — semantics upstream', async () => {
    state.rows.push([{ count: 1 }], [{
      id: 'd-1', hostname: 'laptop', displayName: null, configured: true,
      testRestoreStatus: null, testRestoreAt: null, restoreTimeSeconds: null,
      openBreaches: [], readinessScore: null, estimatedRtoMinutes: null, estimatedRpoMinutes: null,
    }]);
    health.listBackupHealthRows.mockResolvedValue({
      rows: [
        breezeRow({ deviceId: 'd-1' }),
        breezeRow({
          key: 'provider:row-9', source: 'provider', deviceId: null, name: 'BACKUP-SVR',
          providerLabel: 'Cove Data Protection', status: 'failed', health: 'critical',
          lastSuccessAt: '2026-08-30T00:00:00.000Z',
        }),
      ],
      nextCursor: null,
    });

    const page = await backupDevicesPage(ORG_ID, { page: 1, limit: 25, timezone: 'UTC', now: new Date('2026-09-02T12:00:00Z') });
    expect(page.data).toHaveLength(2);
    const external = page.data.find((d) => d.id === 'provider:row-9');
    expect(external).toMatchObject({
      name: 'BACKUP-SVR', configured: true, source: 'external',
      providerLabel: 'Cove Data Protection', status: 'failed', health: 'critical',
      lastRestorePointAt: '2026-08-30T00:00:00.000Z',
      lastTestRestore: null, openBreaches: [], readinessScore: null,
    });
    expect(page.pagination.total).toBe(2); // 1 breeze device + 1 external-only row
  });

  it('does not duplicate external-only rows onto page 2', async () => {
    state.rows.push([{ count: 1 }], [{
      id: 'd-1', hostname: 'laptop', displayName: null, configured: false,
      testRestoreStatus: null, testRestoreAt: null, restoreTimeSeconds: null,
      openBreaches: [], readinessScore: null, estimatedRtoMinutes: null, estimatedRpoMinutes: null,
    }]);
    health.listBackupHealthRows.mockResolvedValue({
      rows: [breezeRow({ key: 'provider:row-9', source: 'provider', deviceId: null, name: 'BACKUP-SVR' })],
      nextCursor: null,
    });

    const page = await backupDevicesPage(ORG_ID, { page: 2, limit: 25, timezone: 'UTC', now: new Date('2026-09-02T12:00:00Z') });
    expect(page.data.find((d) => d.id === 'provider:row-9')).toBeUndefined();
  });

  it('serializes raw-SQL timestamps that postgres-js returns as strings (regression #4562)', async () => {
    state.rows.push([{ count: 1 }], [{
      id: 'd-1', hostname: 'Laptop', displayName: null, configured: true,
      testRestoreStatus: 'passed', testRestoreAt: '2026-09-01T09:00:00.000Z', restoreTimeSeconds: 120,
      openBreaches: [], readinessScore: null, estimatedRtoMinutes: null, estimatedRpoMinutes: null,
    }]);
    health.listBackupHealthRows.mockResolvedValue({ rows: [breezeRow({ deviceId: 'd-1' })], nextCursor: null });

    const page = await backupDevicesPage(ORG_ID, { page: 1, limit: 25, timezone: 'America/Denver', now: new Date('2026-09-02T12:00:00Z') });
    expect(page.data[0]).toMatchObject({
      lastRestorePointAt: '2026-09-02T02:00:00.000Z',
      lastTestRestore: { status: 'passed', completedAt: '2026-09-01T09:00:00.000Z', restoreTimeSeconds: 120 },
    });
  });

  it('reports every enrolled device — a device with no unified row falls back to no_backups/unknown', async () => {
    state.rows.push([{ count: 1 }], [{
      id: 'd-2', hostname: 'Old-PC', displayName: null, configured: false,
      testRestoreStatus: null, testRestoreAt: null, restoreTimeSeconds: null,
      openBreaches: [], readinessScore: null, estimatedRtoMinutes: null, estimatedRpoMinutes: null,
    }]);
    health.listBackupHealthRows.mockResolvedValue({ rows: [], nextCursor: null });

    const page = await backupDevicesPage(ORG_ID, { page: 1, limit: 25, timezone: 'UTC', now: new Date('2026-09-02T12:00:00Z') });
    expect(page.data[0]).toMatchObject({
      id: 'd-2', configured: false, status: 'no_backups', health: 'unknown',
      lastRestorePointAt: null, providerLabel: null, source: 'breeze',
    });
  });

  it('reports ok when an out-of-range page is empty but the org has devices', async () => {
    state.rows.push([{ count: 2 }], []);
    health.listBackupHealthRows.mockResolvedValue({ rows: [], nextCursor: null });

    await expect(backupDevicesPage(ORG_ID, {
      page: 2, limit: 25, timezone: 'America/Denver', now: new Date('2026-09-02T12:00:00Z'),
    })).resolves.toMatchObject({ dataStatus: 'ok', data: [], pagination: { page: 2, limit: 25, total: 2 } });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/api && npx vitest run src/services/portal/backupReadModel.test.ts
```
Expected: `Cannot find module '../backupHealthReadModel'` (until W03 lands) or, once W03 exists, assertion failures against the current `backupTile`/`backupOverview`/`backupDevicesPage` (missing `byHealth`/`externalProviders`, wrong `configured`/`total` math, TypeError on `providerLabel` undefined).

- [ ] **Step 3: Implement**

```ts
// apps/api/src/services/portal/backupReadModel.ts — REPLACE THE WHOLE FILE
import { and, asc, countDistinct, desc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../../db';
import {
  backupConfigs,
  backupJobs,
  backupSlaEvents,
  backupVerifications,
  devices,
  portalBranding,
  recoveryReadiness,
  RESTORABLE_BACKUP_JOB_STATUSES,
} from '../../db/schema';
import { listBackupHealthRows, summarizeBackupHealth } from '../backupHealthReadModel';
import type {
  BackupDeviceRow,
  BackupDevicesDto,
  BackupHealthRow,
  BackupOverviewDto,
} from '@breeze/shared';
import { sqlTimestamp } from './sqlTimestamp';

/**
 * W04 (#6012): the dashboard tile is called for EVERY org unconditionally
 * (`portal/dashboard.ts:62`), so provider coverage folds in only when THIS
 * org has turned portal Backups on — otherwise an MSP that never enabled the
 * page would see its dashboard tile silently change shape. `completedAt`/
 * `verificationType` stay first-party-only: Cove has no verification-event
 * concept in phase 1, and claiming a "passed verification" off a provider
 * success would be a fabricated fact on an insurance-adjacent surface.
 */
export async function backupTile(orgId: string, now: Date) {
  const [totalRows, activeConfigRows, configuredRows, latestRows, brandingRows] = await Promise.all([
    db
      .select({ total: countDistinct(devices.id) })
      .from(devices)
      .where(and(eq(devices.orgId, orgId), eq(devices.isEphemeral, false))),
    db
      .select({ id: backupConfigs.id })
      .from(backupConfigs)
      .where(and(eq(backupConfigs.orgId, orgId), eq(backupConfigs.isActive, true)))
      .limit(1),
    db
      .select({ configured: countDistinct(backupJobs.deviceId) })
      .from(backupJobs)
      .innerJoin(
        backupConfigs,
        and(
          eq(backupJobs.configId, backupConfigs.id),
          eq(backupConfigs.orgId, orgId),
          eq(backupConfigs.isActive, true),
        ),
      )
      .where(eq(backupJobs.orgId, orgId)),
    db
      .select({
        completedAt: backupVerifications.completedAt,
        verificationType: backupVerifications.verificationType,
      })
      .from(backupVerifications)
      .where(and(eq(backupVerifications.orgId, orgId), eq(backupVerifications.status, 'passed')))
      .orderBy(desc(backupVerifications.completedAt))
      .limit(1),
    db
      .select({ enableBackups: portalBranding.enableBackups })
      .from(portalBranding)
      .where(eq(portalBranding.orgId, orgId))
      .limit(1),
  ]);

  const total = Number(totalRows[0]?.total ?? 0);
  const hasActiveConfig = activeConfigRows.length > 0;
  const firstPartyConfigured = Number(configuredRows[0]?.configured ?? 0);
  const latest = latestRows[0];
  const includeProviders = brandingRows[0]?.enableBackups === true;

  let configured = firstPartyConfigured;
  let coverageTotal = total;
  let hasProviderCoverage = false;
  if (includeProviders) {
    const summary = await summarizeBackupHealth({ orgIds: [orgId] }, {});
    configured = summary.endpoints.covered;
    coverageTotal = summary.endpoints.total;
    hasProviderCoverage = summary.endpoints.covered > 0 || summary.providerOnly > 0;
  }

  return {
    status:
      !hasActiveConfig && !hasProviderCoverage
        ? ('not_configured' as const)
        : latest
          ? ('ok' as const)
          : ('no_data' as const),
    completedAt: latest?.completedAt?.toISOString() ?? null,
    verificationType: latest?.verificationType ?? null,
    configured,
    total: coverageTotal,
    asOf: now.toISOString(),
  };
}

export async function backupOverview(
  orgId: string,
  args: { timezone: string; now: Date },
): Promise<BackupOverviewDto> {
  const [tile, restoreRows, breachRows, readinessRows, healthSummary, providerRowsPage] = await Promise.all([
    backupTile(orgId, args.now),
    db
      .select({ completedAt: backupVerifications.completedAt, status: backupVerifications.status })
      .from(backupVerifications)
      .where(and(eq(backupVerifications.orgId, orgId), eq(backupVerifications.verificationType, 'test_restore')))
      .orderBy(sql`${backupVerifications.completedAt} desc nulls last`)
      .limit(1),
    db
      .select({ eventType: backupSlaEvents.eventType })
      .from(backupSlaEvents)
      .where(and(eq(backupSlaEvents.orgId, orgId), isNull(backupSlaEvents.resolvedAt))),
    // Do not call getBackupHealthSummary here; it exits to a system DB context.
    db
      .select({
        readinessCount: sql<number>`count(${recoveryReadiness.readinessScore})::int`,
        totalDevices: sql<number>`count(${devices.id})::int`,
        meanReadinessScore: sql<number | null>`avg(${recoveryReadiness.readinessScore})::float`,
      })
      .from(devices)
      .leftJoin(recoveryReadiness, and(eq(recoveryReadiness.deviceId, devices.id), eq(recoveryReadiness.orgId, orgId)))
      .where(and(eq(devices.orgId, orgId), eq(devices.isEphemeral, false))),
    // W04: byHealth across both sources — run unconditionally (this route is
    // already gated on enable_backups at the router, routes/portal/index.ts:53).
    summarizeBackupHealth({ orgIds: [orgId] }, {}),
    listBackupHealthRows({ orgIds: [orgId] }, { sources: ['provider'], page: { limit: 200, cursor: null } }),
  ]);

  const RPO_EVENT_TYPES = new Set(['rpo_breach', 'missed_backup']);
  const RTO_EVENT_TYPES = new Set(['rto_breach']);
  const countBreach = (family: 'rpo' | 'rto') =>
    breachRows.filter((row) => (family === 'rpo' ? RPO_EVENT_TYPES : RTO_EVENT_TYPES).has(row.eventType)).length;
  const openRpoBreaches = countBreach('rpo');
  const openRtoBreaches = countBreach('rto');
  const readiness = readinessRows[0];
  const readinessScoredDevices = readiness ? Number(readiness.readinessCount ?? 0) : null;
  const readinessTotalDevices = readiness ? Number(readiness.totalDevices ?? 0) : null;

  const externalProviders = [
    ...new Set(
      providerRowsPage.rows
        .map((row) => row.providerLabel)
        .filter((label): label is string => label !== null),
    ),
  ].sort();

  return {
    asOf: args.now.toISOString(),
    dataStatus: tile.status,
    protected: tile.configured,
    unprotected: tile.total == null || tile.configured == null ? null : tile.total - tile.configured,
    total: tile.total,
    lastPassedVerification:
      tile.completedAt && tile.verificationType
        ? { completedAt: tile.completedAt, verificationType: tile.verificationType }
        : null,
    lastTestRestoreAt: restoreRows[0]?.completedAt?.toISOString() ?? null,
    lastTestRestoreStatus: restoreRows[0]?.status ?? null,
    openRpoBreaches: openRpoBreaches > 0 || tile.status === 'ok' ? openRpoBreaches : null,
    openRtoBreaches: openRtoBreaches > 0 || tile.status === 'ok' ? openRtoBreaches : null,
    meanReadinessScore:
      readinessScoredDevices != null && readinessScoredDevices > 0 && readiness?.meanReadinessScore != null
        ? Number(readiness.meanReadinessScore)
        : null,
    readinessScoredDevices,
    readinessTotalDevices,
    byHealth: healthSummary.byHealth,
    externalProviders,
  };
}

/** ISO-8601 strings compare lexicographically in chronological order. */
function maxIso(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

export async function backupDevicesPage(
  orgId: string,
  args: { page: number; limit: number; timezone: string; now: Date },
): Promise<BackupDevicesDto> {
  const offset = (args.page - 1) * args.limit;
  const restorableStatuses = sql.join(
    RESTORABLE_BACKUP_JOB_STATUSES.map((status) => sql`${status}`),
    sql`, `,
  );
  const [countRows, rows, health] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(devices)
      .where(and(eq(devices.orgId, orgId), eq(devices.isEphemeral, false))),
    db
      .select({
        id: devices.id,
        hostname: devices.hostname,
        displayName: devices.displayName,
        configured: sql<boolean>`
          exists (
            select 1
            from backup_jobs bj
            join backup_configs bc
              on bc.id = bj.config_id
             and bc.org_id = ${orgId}
             and bc.is_active = true
            where bj.org_id = ${orgId}
              and bj.device_id = ${devices.id}
          )
        `,
        testRestoreStatus: sql<string | null>`(
          select bv.status
          from backup_verifications bv
          where bv.org_id = ${orgId}
            and bv.device_id = ${devices.id}
            and bv.verification_type = 'test_restore'
          order by bv.completed_at desc nulls last
          limit 1
        )`,
        testRestoreAt: sql<Date | string | null>`(
          select max(bv.completed_at)
          from backup_verifications bv
          where bv.org_id = ${orgId}
            and bv.device_id = ${devices.id}
            and bv.verification_type = 'test_restore'
        )`,
        restoreTimeSeconds: sql<number | null>`(
          select bv.restore_time_seconds
          from backup_verifications bv
          where bv.org_id = ${orgId}
            and bv.device_id = ${devices.id}
            and bv.verification_type = 'test_restore'
          order by bv.completed_at desc nulls last
          limit 1
        )`,
        openBreaches: sql<string[]>`
          coalesce((
            select array_agg(distinct bse.event_type)
            from backup_sla_events bse
            where bse.org_id = ${orgId}
              and bse.device_id = ${devices.id}
              and bse.resolved_at is null
          ), array[]::text[])
        `,
        readinessScore: recoveryReadiness.readinessScore,
        estimatedRtoMinutes: recoveryReadiness.estimatedRtoMinutes,
        estimatedRpoMinutes: recoveryReadiness.estimatedRpoMinutes,
      })
      // `lastBackupAt`/`lastBackupStatus` (raw backup_jobs subqueries) are
      // REMOVED here — the unified model below is now the single source for
      // status/health/lastSuccessAt on every row, breeze or provider (W04
      // Task 2 DECISION: avoids two disagreeing "last backup" computations).
      .from(devices)
      .leftJoin(recoveryReadiness, and(eq(recoveryReadiness.deviceId, devices.id), eq(recoveryReadiness.orgId, orgId)))
      .where(and(eq(devices.orgId, orgId), eq(devices.isEphemeral, false)))
      .orderBy(asc(devices.hostname), asc(devices.id))
      .limit(args.limit)
      .offset(offset),
    // Generous, unpaginated fetch of the WHOLE org's unified rows (both
    // sources) — an org-scoped device count, not partner-wide. See Task 2
    // DECISION on why this does not try to match the SQL query's own
    // offset/limit.
    listBackupHealthRows({ orgIds: [orgId] }, { page: { limit: 1000, cursor: null } }),
  ]);

  const healthByDeviceId = new Map<string, BackupHealthRow[]>();
  for (const row of health.rows) {
    if (!row.deviceId) continue;
    const list = healthByDeviceId.get(row.deviceId) ?? [];
    list.push(row);
    healthByDeviceId.set(row.deviceId, list);
  }

  const data: BackupDeviceRow[] = rows.map((row) => {
    const matches = healthByDeviceId.get(row.id) ?? [];
    const breezeMatch = matches.find((m) => m.source === 'breeze') ?? null;
    const providerMatch = matches.find((m) => m.source === 'provider') ?? null;
    const status = breezeMatch?.status ?? providerMatch?.status ?? 'no_backups';
    const rowHealth = breezeMatch?.health ?? providerMatch?.health ?? 'unknown';
    const lastSuccessAt = maxIso(breezeMatch?.lastSuccessAt ?? null, providerMatch?.lastSuccessAt ?? null);
    return {
      id: row.id,
      name: row.displayName ?? row.hostname,
      configured: row.configured,
      lastRestorePointAt: lastSuccessAt,
      lastRestorePointDegraded: status === 'completed_with_errors',
      lastTestRestore: row.testRestoreStatus
        ? {
            status: row.testRestoreStatus,
            completedAt: sqlTimestamp(row.testRestoreAt)?.toISOString() ?? null,
            restoreTimeSeconds: row.restoreTimeSeconds,
          }
        : null,
      openBreaches: row.openBreaches,
      readinessScore: row.readinessScore,
      estimatedRtoMinutes: row.estimatedRtoMinutes,
      estimatedRpoMinutes: row.estimatedRpoMinutes,
      source: 'breeze',
      providerLabel: providerMatch?.providerLabel ?? null,
      status,
      health: rowHealth,
      lastSuccessAt,
    };
  });

  const externalOnly: BackupDeviceRow[] =
    args.page === 1
      ? health.rows
          .filter((row) => row.source === 'provider' && row.deviceId === null)
          .slice(0, 200)
          .map((row) => ({
            id: row.key,
            name: row.name,
            configured: true,
            lastRestorePointAt: row.lastSuccessAt,
            lastRestorePointDegraded: row.status === 'completed_with_errors',
            lastTestRestore: null,
            openBreaches: [],
            readinessScore: null,
            estimatedRtoMinutes: null,
            estimatedRpoMinutes: null,
            source: 'external',
            providerLabel: row.providerLabel,
            status: row.status,
            health: row.health,
            lastSuccessAt: row.lastSuccessAt,
          }))
      : [];

  const total = Number(countRows[0]?.count ?? 0) + externalOnly.length;

  return {
    dataStatus: total === 0 ? 'no_data' : 'ok',
    asOf: args.now.toISOString(),
    data: [...data, ...externalOnly],
    pagination: { page: args.page, limit: args.limit, total },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/api && npx vitest run src/services/portal/backupReadModel.test.ts
```
Expected: all `backupTile`/`backupOverview`/`backupDevicesPage` tests pass.

```bash
cd apps/api && npx vitest run src/services/portal/dashboard.test.ts
```
Expected: unaffected — `dashboard.test.ts` mocks `backupTile` as a black box (`vi.mock('./backupReadModel', ...)`), so this file's internals are invisible to it.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/portal/backupReadModel.ts apps/api/src/services/portal/backupReadModel.test.ts
git commit -m "$(cat <<'EOF'
feat(portal): fold provider backup coverage into backupTile/Overview/DevicesPage

W04 Task 2. backupTile widens configured/total to provider coverage only when
enable_backups is on (dashboard.ts is unchanged — the gate lives here).
backupOverview adds byHealth/externalProviders from the unified read model.
backupDevicesPage merges each breeze device's unified rows (breeze status is
authoritative, lastSuccessAt is max'd across sources) and appends unlinked
provider rows to page 1 as source:'external' rows.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Portal component — `BackupOverview.tsx`

**Files:**
- Modify: `apps/portal/src/components/portal/BackupOverview.tsx` (201 lines today)
- Modify: `apps/portal/src/components/portal/BackupOverview.test.tsx` (222 lines today)

**Interfaces:**
Consumes: `BackupOverviewDto` (Task 1), `StatusMark`/`MarkTone`/`PageHeader` (`apps/portal/src/components/portal/ui.tsx:34-104`, unchanged), `BackupHealth` (`@breeze/shared`).
Produces: two new ledger rows (`data-testid="portal-backup-overview-health"`, `data-testid="portal-backup-overview-providers"`), no prop changes (same `{ overview, timezone, hasBackupActivity }` signature — `apps/portal/src/pages/backups/index.astro` needs no edit).

- [ ] **Step 1: Write the failing test**

```tsx
// apps/portal/src/components/portal/BackupOverview.test.tsx
// REPLACE THE WHOLE FILE with the version below (adds byHealth/externalProviders
// to both fixtures, updates the ledger-row-count test, adds 2 new tests).
// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { BackupOverviewDto } from '@breeze/shared';
import { BackupOverview } from './BackupOverview';

const configuredOverview: BackupOverviewDto = {
  asOf: '2026-09-02T12:00:00Z',
  dataStatus: 'ok',
  protected: 3,
  unprotected: 1,
  total: 4,
  lastPassedVerification: { completedAt: '2026-09-01T09:30:00Z', verificationType: 'automated' },
  lastTestRestoreAt: '2026-08-30T14:15:00Z',
  lastTestRestoreStatus: 'failed',
  openRpoBreaches: 2,
  openRtoBreaches: 1,
  meanReadinessScore: 76,
  readinessScoredDevices: 3,
  readinessTotalDevices: 4,
  byHealth: { healthy: 3, warning: 0, critical: 1, unknown: 0 },
  externalProviders: ['Cove Data Protection'],
};

const emptyOverview: BackupOverviewDto = {
  ...configuredOverview,
  dataStatus: 'no_data',
  protected: 0,
  unprotected: 0,
  total: 4,
  lastPassedVerification: null,
  lastTestRestoreAt: null,
  lastTestRestoreStatus: null,
  openRpoBreaches: null,
  openRtoBreaches: null,
  meanReadinessScore: null,
  readinessScoredDevices: null,
  readinessTotalDevices: null,
  byHealth: { healthy: 0, warning: 0, critical: 0, unknown: 0 },
  externalProviders: [],
};

describe('BackupOverview', () => {
  it('renders configured backup health and breach counts in the reader’s words', () => {
    render(<BackupOverview overview={configuredOverview} hasBackupActivity />);
    const overview = screen.getByTestId('portal-backup-overview');
    expect(overview.textContent).toContain('3 of 4');
    expect(screen.getByTestId('portal-backup-overview-last-verification').textContent).toContain('Sep 1, 2026');
    expect(screen.getByTestId('portal-backup-overview-last-verification').textContent).not.toContain('2026-09-01T09:30:00Z');
    expect(screen.getByTestId('portal-backup-overview-last-test-restore').textContent).toContain('Aug 30, 2026');
    expect(screen.getByTestId('portal-backup-overview-as-of').textContent).toContain('Sep 2, 2026');
    expect(screen.getByTestId('portal-backup-overview-readiness').textContent).toContain('76');
    expect(screen.getByTestId('portal-backup-overview-rpo-breaches').textContent).toContain('2');
    expect(screen.getByTestId('portal-backup-overview-rto-breaches').textContent).toContain('1');
    expect(overview.textContent).toContain('Backups behind schedule');
    expect(overview.textContent).toContain('Restores slower than promised');
    expect(overview.textContent).toContain('Recovery readiness');
    expect(overview.textContent).toContain('Last restore test');
    expect(overview.textContent).not.toContain('RPO');
    expect(overview.textContent).not.toContain('RTO');
    expect(overview.textContent).not.toContain('Mean readiness');
  });

  it('gives the last restore test a tone and a plain word', () => {
    render(<BackupOverview overview={configuredOverview} hasBackupActivity />);
    const tile = screen.getByTestId('portal-backup-overview-last-test-restore');
    expect(tile.textContent).toContain('Failed');
    expect(tile.textContent).not.toContain('failed —');
    expect(tile.querySelector('.text-destructive-on-tint')).not.toBeNull();
  });

  it('never contradicts a ledger that holds backups', () => {
    render(
      <BackupOverview
        overview={{ ...configuredOverview, dataStatus: 'no_data', lastPassedVerification: null }}
        hasBackupActivity
      />,
    );
    expect(screen.queryByTestId('portal-backup-overview-status')).toBeNull();
    expect(screen.getByTestId('portal-backup-overview-last-verification').textContent).toContain('No verification has run yet.');
  });

  it('bands the page only when nothing has been backed up', () => {
    render(<BackupOverview overview={emptyOverview} />);
    const band = screen.getByTestId('portal-backup-overview-status');
    expect(band.textContent).toContain('No backup data is available yet.');
    expect(band.querySelector('.uppercase')).toBeNull();
    expect(band.className).not.toContain('uppercase');
  });

  it('distinguishes not-configured and stale states', () => {
    const { rerender } = render(<BackupOverview overview={{ ...emptyOverview, dataStatus: 'not_configured' }} />);
    expect(screen.getByTestId('portal-backup-overview-status').textContent).toContain('Backups are not configured');
    rerender(<BackupOverview overview={{ ...configuredOverview, dataStatus: 'stale' }} hasBackupActivity />);
    const stale = screen.getByTestId('portal-backup-overview-status');
    expect(stale.textContent).toContain('Backup data may be out of date');
    expect(stale.innerHTML).not.toContain('text-warning-on-tint');
    expect(stale.querySelector('.text-muted-foreground')).not.toBeNull();
  });

  it('stamps every time in the org’s own zone and names it', () => {
    render(<BackupOverview overview={configuredOverview} timezone="America/Denver" hasBackupActivity />);
    expect(screen.getByTestId('portal-backup-overview-as-of').textContent).toContain('Sep 2, 2026, 06:00 AM MDT');
    expect(screen.getByTestId('portal-backup-overview-last-verification').textContent).toContain('Sep 1, 2026, 03:30 AM MDT');
    expect(screen.getByTestId('portal-backup-overview-last-test-restore').textContent).toContain('Aug 30, 2026, 08:15 AM MDT');
  });

  it('keeps dead-end values out of the money face', () => {
    render(<BackupOverview overview={{ ...emptyOverview, dataStatus: 'not_configured', protected: null, total: null }} />);
    expect(screen.getByTestId('portal-backup-overview-protected').textContent).toContain('Not available');
    const deadEnds = screen.getAllByText('Not available');
    expect(deadEnds.length).toBeGreaterThanOrEqual(3);
    for (const el of deadEnds) {
      expect(el.className).not.toMatch(/font-display|text-2xl|text-figures/);
      expect(el.closest('.text-figures')).toBeNull();
      expect(el.closest('.font-display')).toBeNull();
    }
  });

  it('rules the summary as a hairline ledger, never a boxed grid', () => {
    render(<BackupOverview overview={configuredOverview} hasBackupActivity />);
    const ledger = screen.getByTestId('portal-backup-overview-summary');
    expect(ledger.tagName).toBe('DL');
    expect(ledger.className).toContain('divide-y');
    expect(ledger.className).not.toMatch(/rounded|grid|bg-|overflow-hidden/);
    expect(ledger.className).not.toMatch(/(^|\s)border(\s|$)/);

    // W04: 6 original rows + Backup health + Third-party backup = 8.
    const rows = Array.from(ledger.children);
    expect(rows).toHaveLength(8);
    for (const row of rows) {
      expect(row.querySelector('dt')).not.toBeNull();
      expect(row.querySelector('dd')).not.toBeNull();
      expect(row.className).not.toMatch(/rounded|bg-/);
      expect(row.className).not.toMatch(/(^|\s)border(\s|$)/);
    }

    for (const label of [
      'Protected devices', 'Backup health', 'Last verification', 'Last restore test',
      'Recovery readiness', 'Backups behind schedule', 'Restores slower than promised',
      'Third-party backup',
    ]) {
      expect(screen.getByText(label).tagName).toBe('DT');
    }
  });

  it('keeps the serif money face on real figures only', () => {
    render(<BackupOverview overview={configuredOverview} hasBackupActivity />);
    expect(screen.getByTestId('portal-backup-overview-protected').querySelector('.font-display')?.textContent).toBe('3 of 4');
    expect(screen.getByTestId('portal-backup-overview-readiness').querySelector('.font-display')?.textContent).toBe('76');
    expect(screen.getByTestId('portal-backup-overview-last-verification').querySelector('.font-display')).toBeNull();
    const secondary = screen.getByText(/Average across/);
    expect(secondary.className).toContain('text-xs');
    expect(secondary.className).not.toMatch(/font-display|text-figures/);
  });

  it('shows the health breakdown as toned marks, one per non-zero bucket', () => {
    render(<BackupOverview overview={configuredOverview} hasBackupActivity />);
    const row = screen.getByTestId('portal-backup-overview-health');
    expect(row.textContent).toContain('3 Healthy');
    expect(row.textContent).toContain('1 Critical');
    expect(row.textContent).not.toContain('Warning'); // zero bucket omitted
    expect(row.querySelector('.text-success-on-tint')).not.toBeNull();
    expect(row.querySelector('.text-destructive-on-tint')).not.toBeNull();
  });

  it('says "No devices assessed" when every health bucket is zero', () => {
    render(<BackupOverview overview={{ ...configuredOverview, byHealth: { healthy: 0, warning: 0, critical: 0, unknown: 0 } }} hasBackupActivity />);
    expect(screen.getByTestId('portal-backup-overview-health').textContent).toContain('No devices assessed');
  });

  it('lists third-party providers by label, or says none are connected', () => {
    render(<BackupOverview overview={configuredOverview} hasBackupActivity />);
    expect(screen.getByTestId('portal-backup-overview-providers').textContent).toContain('Cove Data Protection');

    render(<BackupOverview overview={{ ...configuredOverview, externalProviders: [] }} hasBackupActivity />);
    expect(screen.getAllByTestId('portal-backup-overview-providers').at(-1)!.textContent).toContain('None connected');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/portal && npx vitest run src/components/portal/BackupOverview.test.tsx
```
Expected: `expect(rows).toHaveLength(8)` fails with `6`; `getByTestId('portal-backup-overview-health')` / `-providers` throw "Unable to find an element".

- [ ] **Step 3: Implement**

```tsx
// apps/portal/src/components/portal/BackupOverview.tsx — targeted edits
```

```tsx
// after the existing imports (line 4)
import type { BackupHealth } from '@breeze/shared';
```

```tsx
// after the STATUS_COPY block (originally lines 21-26)
/** Health tone/label — shared with BackupDeviceTable.tsx's Health column so
 *  one bucket never wears two faces on the page. */
export const HEALTH_TONE: Record<BackupHealth, MarkTone> = {
  healthy: 'success',
  warning: 'warning',
  critical: 'destructive',
  unknown: 'neutral',
};
export const HEALTH_LABEL: Record<BackupHealth, string> = {
  healthy: 'Healthy',
  warning: 'Warning',
  critical: 'Critical',
  unknown: 'Unknown',
};
const HEALTH_ORDER: readonly BackupHealth[] = ['healthy', 'warning', 'critical', 'unknown'];
```

```tsx
// insert a new LedgerRow right after "Protected devices" (originally lines 141-143)
        <LedgerRow testId="portal-backup-overview-health" label="Backup health">
          {HEALTH_ORDER.every((h) => overview.byHealth[h] === 0) ? (
            <span className={QUIET}>No devices assessed</span>
          ) : (
            <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
              {HEALTH_ORDER.filter((h) => overview.byHealth[h] > 0).map((h) => (
                <StatusMark key={h} tone={HEALTH_TONE[h]}>
                  {overview.byHealth[h]} {HEALTH_LABEL[h]}
                </StatusMark>
              ))}
            </div>
          )}
        </LedgerRow>
```

```tsx
// insert a new LedgerRow as the LAST row of the <dl>, right after
// "Restores slower than promised" (originally lines 181-186, before the
// closing </dl>)
        <LedgerRow testId="portal-backup-overview-providers" label="Third-party backup">
          {overview.externalProviders.length > 0 ? (
            <span className={WHEN}>{overview.externalProviders.join(', ')}</span>
          ) : (
            <span className={QUIET}>None connected</span>
          )}
        </LedgerRow>
```

```tsx
// the PageHeader import line needs MarkTone too (originally line 4)
import { PageHeader, StatusMark, type MarkTone } from './ui';
```
(`MarkTone` is already imported at line 4 today — this line is unchanged; listed here only so the diff is unambiguous about where `HEALTH_TONE`'s type comes from.)

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/portal && npx vitest run src/components/portal/BackupOverview.test.tsx
cd apps/portal && pnpm exec astro check
```
Expected: 13 tests pass; astro check clean.

- [ ] **Step 5: Commit**

```bash
git add apps/portal/src/components/portal/BackupOverview.tsx apps/portal/src/components/portal/BackupOverview.test.tsx
git commit -m "$(cat <<'EOF'
feat(portal): render backup health breakdown and third-party providers

W04 Task 3. Two new ledger rows on the Backups overview page, in the
existing Guest Ledger style (StatusMark dots, no boxes, no i18n — the portal
has none, see Global Constraints).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Portal component — `BackupDeviceTable.tsx`

**Files:**
- Modify: `apps/portal/src/components/portal/BackupDeviceTable.tsx` (169 lines today)
- Modify: `apps/portal/src/components/portal/BackupDeviceTable.test.tsx` (200 lines today)

**Interfaces:**
Consumes: `BackupDeviceRow` (Task 1), `HEALTH_TONE`/`HEALTH_LABEL` (Task 3, exported from `./BackupOverview`, joining the existing `humanizeStatus`/`testRestoreMark` cross-import at line 5).

- [ ] **Step 1: Write the failing test**

```tsx
// apps/portal/src/components/portal/BackupDeviceTable.test.tsx
// REPLACE THE WHOLE FILE with the version below.
// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { BackupDeviceRow } from '@breeze/shared';
import { BackupDeviceTable } from './BackupDeviceTable';

const configuredDevice: BackupDeviceRow = {
  id: 'd-1',
  name: 'File Server',
  configured: true,
  lastRestorePointAt: '2026-09-02T10:00:00Z',
  lastRestorePointDegraded: false,
  lastTestRestore: { status: 'passed', completedAt: '2026-09-01T08:00:00Z', restoreTimeSeconds: 180 },
  openBreaches: [],
  readinessScore: 92,
  estimatedRtoMinutes: 30,
  estimatedRpoMinutes: 60,
  source: 'breeze',
  providerLabel: null,
  status: 'completed',
  health: 'healthy',
  lastSuccessAt: '2026-09-02T10:00:00Z',
};

const externalDevice: BackupDeviceRow = {
  id: 'provider:row-9',
  name: 'BACKUP-SVR',
  configured: true,
  lastRestorePointAt: '2026-08-30T00:00:00Z',
  lastRestorePointDegraded: false,
  lastTestRestore: null,
  openBreaches: [],
  readinessScore: null,
  estimatedRtoMinutes: null,
  estimatedRpoMinutes: null,
  source: 'external',
  providerLabel: 'Cove Data Protection',
  status: 'failed',
  health: 'critical',
  lastSuccessAt: '2026-08-30T00:00:00Z',
};

describe('BackupDeviceTable', () => {
  it('renders configured device backup details under plain-language headers', () => {
    render(<BackupDeviceTable devices={[configuredDevice]} total={125} />);
    expect(
      Array.from(screen.getByTestId('portal-backup-device-table').querySelectorAll('th')).map((th) => th.textContent?.trim()),
    ).toEqual(['Device', 'Source', 'Health', 'Last backup', 'Last restore test', 'Needs attention', 'Recovery readiness']);

    const row = screen.getByTestId('portal-backup-device-d-1');
    expect(row.textContent).toContain('File Server');
    expect(row.textContent).toContain('Sep 2, 2026');
    expect(row.textContent).not.toContain('2026-09-02T10:00:00Z');
    expect(row.textContent).toContain('None');
    expect(row.textContent).toContain('92');
    expect(row.textContent).toContain('Breeze');
    expect(row.textContent).toContain('Healthy');
  });

  it('totals the ledger at its foot, in the register’s small caps', () => {
    render(<BackupDeviceTable devices={[configuredDevice]} total={125} />);
    const foot = screen.getByTestId('portal-backup-device-count');
    expect(foot.textContent).toContain('Showing 1 of 125 devices');
    const table = screen.getByTestId('portal-backup-device-table');
    expect(table.compareDocumentPosition(foot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(foot.className).toContain('border-t');
    expect(foot.className).toContain('uppercase');
    expect(foot.className).toContain('tracking-[0.08em]');
    expect(screen.getByRole('heading', { name: 'Device backup readiness' }).className).toContain('text-lg');
  });

  it('reads label over value on a phone card, not one muted run-on', () => {
    render(<BackupDeviceTable devices={[configuredDevice]} />);
    const labels = Array.from(screen.getByTestId('portal-backup-device-d-1').querySelectorAll('.sm\\:hidden'));
    expect(labels.map((el) => el.textContent)).toEqual([
      'Source', 'Health', 'Last backup', 'Last restore test', 'Needs attention', 'Recovery readiness',
    ]);
    for (const label of labels) {
      expect(label.className).toContain('block');
      expect(label.className).toContain('text-xs');
      expect(label.className).toContain('font-semibold');
      expect(label.className).toContain('uppercase');
      expect(label.className).toContain('tracking-[0.08em]');
      expect(label.className).toContain('text-muted-foreground');
    }
  });

  it('stamps device times in the org’s own zone and names it', () => {
    render(<BackupDeviceTable devices={[configuredDevice]} timezone="America/Denver" />);
    const row = screen.getByTestId('portal-backup-device-d-1');
    expect(row.textContent).toContain('Sep 2, 2026, 04:00 AM MDT');
    expect(row.textContent).toContain('Sep 1, 2026, 02:00 AM MDT');
  });

  it('says what the customer should do instead of printing the backend error', () => {
    render(<BackupDeviceTable devices={[]} error="ECONNREFUSED 10.0.0.4:5432" />);
    const notice = screen.getByRole('alert');
    expect(notice.textContent).toBe("We couldn't load your backup devices just now. Your IT team can help.");
    expect(notice.textContent).not.toContain('ECONNREFUSED');
  });

  it('maps the restore-test status to a tone and a plain word', () => {
    render(
      <BackupDeviceTable
        devices={[
          configuredDevice,
          { ...configuredDevice, id: 'd-2', lastTestRestore: { status: 'failed', completedAt: '2026-09-01T08:00:00Z', restoreTimeSeconds: null } },
          { ...configuredDevice, id: 'd-3', lastTestRestore: { status: 'in_progress', completedAt: null, restoreTimeSeconds: null } },
        ]}
      />,
    );
    const passed = screen.getByTestId('portal-backup-device-d-1');
    expect(passed.textContent).toContain('Passed');
    expect(passed.textContent).not.toContain('passed —');
    expect(passed.querySelector('.text-success-on-tint')).not.toBeNull();
    const failed = screen.getByTestId('portal-backup-device-d-2');
    expect(failed.textContent).toContain('Failed');
    expect(failed.querySelector('.text-destructive-on-tint')).not.toBeNull();
    const other = screen.getByTestId('portal-backup-device-d-3');
    expect(other.textContent).toContain('In progress');
  });

  it('marks degraded restore points and names open breaches without acronyms', () => {
    render(
      <BackupDeviceTable
        devices={[{ ...configuredDevice, id: 'd-2', lastRestorePointDegraded: true, openBreaches: ['rpo_breach', 'rto_breach', 'missed_backup'] }]}
      />,
    );
    const row = screen.getByTestId('portal-backup-device-d-2');
    expect(row.textContent).toContain('Sep 2, 2026');
    expect(row.textContent).toContain('(degraded)');
    expect(row.textContent).toContain('Backup behind schedule');
    expect(row.textContent).toContain('Restore slower than promised');
    expect(row.textContent).toContain('Backup missed');
    expect(row.textContent).not.toContain('rpo_breach');
    expect(row.textContent).not.toContain('rto_breach');
  });

  it('shows a not-configured device instead of a blank row', () => {
    render(
      <BackupDeviceTable
        devices={[{
          id: 'd-3', name: 'Laptop', configured: false, lastRestorePointAt: null, lastRestorePointDegraded: false,
          lastTestRestore: null, openBreaches: [], readinessScore: null, estimatedRtoMinutes: null, estimatedRpoMinutes: null,
          source: 'breeze', providerLabel: null, status: 'no_backups', health: 'critical', lastSuccessAt: null,
        }]}
      />,
    );
    expect(screen.getByTestId('portal-backup-device-d-3').textContent).toContain('No backup has run for this device yet');
    // Source/Health still render — they are not part of the collapsed message.
    expect(screen.getByTestId('portal-backup-device-d-3').textContent).toContain('Breeze');
    expect(screen.getByTestId('portal-backup-device-d-3').textContent).toContain('Critical');
  });

  it('renders an honest empty state', () => {
    render(<BackupDeviceTable devices={[]} />);
    expect(screen.getByTestId('portal-backup-device-empty').textContent).toContain('No backup devices are available');
  });

  it('renders an external (unlinked provider) row with its label and — for first-party-only columns', () => {
    render(<BackupDeviceTable devices={[externalDevice]} />);
    const row = screen.getByTestId('portal-backup-device-provider:row-9');
    expect(row.textContent).toContain('BACKUP-SVR');
    expect(row.textContent).toContain('Cove Data Protection');
    expect(row.textContent).toContain('Critical');
    expect(row.textContent).toContain('Aug 30, 2026'); // real "last backup" date, not —
    // readiness/test-restore/breach columns read — for an external row.
    const cells = Array.from(row.querySelectorAll('td'));
    const dashCells = cells.filter((c) => c.textContent?.trim() === '—');
    expect(dashCells).toHaveLength(3);
  });

  it('tolerates a fixture missing the new fields for one release (Task 1 DECISION)', () => {
    const legacyShaped = { ...configuredDevice } as BackupDeviceRow;
    // @ts-expect-error simulating a stale payload/fixture
    delete legacyShaped.health;
    render(<BackupDeviceTable devices={[legacyShaped]} />);
    expect(screen.getByTestId('portal-backup-device-d-1').textContent).toContain('Unknown');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/portal && npx vitest run src/components/portal/BackupDeviceTable.test.tsx
```
Expected: header assertion fails (`['Device','Last backup',…]` vs expected 7 headers); `getByTestId('portal-backup-device-provider:row-9')` throws.

- [ ] **Step 3: Implement**

```tsx
// apps/portal/src/components/portal/BackupDeviceTable.tsx — REPLACE THE WHOLE FILE
import { HardDrive } from 'lucide-react';
import type { BackupDeviceRow, BackupHealth } from '@breeze/shared';
import { cn, formatDateTime } from '@/lib/utils';
import { CELL, EmptyState, ErrorNotice, ROW, StatusMark, TH } from './ui';
import { HEALTH_LABEL, HEALTH_TONE, humanizeStatus, testRestoreMark } from './BackupOverview';

const BREACH_LABELS: Record<string, string> = {
  rpo_breach: 'Backup behind schedule',
  missed_backup: 'Backup missed',
  rto_breach: 'Restore slower than promised',
};

function breachLabel(eventType: string): string {
  return BREACH_LABELS[eventType.trim().toLowerCase()] ?? humanizeStatus(eventType);
}

const PHONE_LABEL =
  'mb-0.5 block text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground sm:hidden';

/** The reader never sees "—" as a raw dash with no context: it stands in for
 *  a column that is not a first-party concept for a provider-only row. */
const NOT_TRACKED = '—';

export function BackupDeviceTable({
  devices,
  total,
  timezone = 'UTC',
  error,
}: {
  devices: BackupDeviceRow[];
  total?: number;
  timezone?: string;
  error?: string | null;
}) {
  if (error) {
    return (
      <div data-testid="portal-backup-device-error">
        <ErrorNotice>We couldn&apos;t load your backup devices just now. Your IT team can help.</ErrorNotice>
      </div>
    );
  }

  if (devices.length === 0) {
    return (
      <EmptyState
        data-testid="portal-backup-device-empty"
        icon={<HardDrive className="h-10 w-10" strokeWidth={1.5} />}
        title="No backup devices are available"
      >
        <p className="mt-1 text-sm text-muted-foreground">Your IT team has not linked any devices to backup data yet.</p>
      </EmptyState>
    );
  }

  return (
    <div className="mt-10 overflow-x-auto">
      <h2 className="mb-4 font-display text-lg font-semibold text-foreground">Device backup readiness</h2>
      <table className="block w-full sm:table sm:min-w-[56rem]" data-testid="portal-backup-device-table">
        <thead className="hidden border-b border-border sm:table-header-group">
          <tr>
            <th scope="col" className={cn(TH, 'text-left')}>Device</th>
            <th scope="col" className={cn(TH, 'text-left')}>Source</th>
            <th scope="col" className={cn(TH, 'text-left')}>Health</th>
            <th scope="col" className={cn(TH, 'text-left')}>Last backup</th>
            <th scope="col" className={cn(TH, 'text-left')}>Last restore test</th>
            <th scope="col" className={cn(TH, 'text-left')}>Needs attention</th>
            <th scope="col" className={cn(TH, 'text-left')}>Recovery readiness</th>
          </tr>
        </thead>
        <tbody className="block divide-y divide-border/70 sm:table-row-group">
          {devices.map((device) => {
            const isExternal = device.source === 'external';
            // Task 1 DECISION: tolerate a fixture/older payload missing the
            // new required fields for one release.
            const health: BackupHealth = device.health ?? 'unknown';
            const restoreTest = device.lastTestRestore ? testRestoreMark(device.lastTestRestore.status) : null;
            return (
              <tr key={device.id} className={ROW} data-testid={`portal-backup-device-${device.id}`}>
                <td className={cn(CELL, 'order-1 grow font-semibold text-foreground')}>{device.name}</td>
                <td className={cn(CELL, 'order-2 text-sm text-foreground')}>
                  <span className={PHONE_LABEL}>Source</span>
                  {isExternal ? (device.providerLabel ?? 'Third-party') : 'Breeze'}
                </td>
                <td className={cn(CELL, 'order-3 text-sm text-foreground')}>
                  <span className={PHONE_LABEL}>Health</span>
                  <StatusMark tone={HEALTH_TONE[health]}>{HEALTH_LABEL[health]}</StatusMark>
                </td>
                {!device.configured ? (
                  <td className={cn(CELL, 'order-4 w-full text-sm text-muted-foreground')} colSpan={4}>
                    No backup has run for this device yet
                  </td>
                ) : (
                  <>
                    <td className={cn(CELL, 'order-4 text-sm text-foreground')}>
                      <span className={PHONE_LABEL}>Last backup</span>
                      {device.lastRestorePointAt ? formatDateTime(device.lastRestorePointAt, timezone, true) : 'No backup has run yet'}
                      {device.lastRestorePointDegraded ? ' (degraded)' : ''}
                    </td>
                    <td className={cn(CELL, 'order-5 text-sm text-foreground')}>
                      <span className={PHONE_LABEL}>Last restore test</span>
                      {isExternal ? (
                        NOT_TRACKED
                      ) : device.lastTestRestore && restoreTest ? (
                        <span className="inline-flex flex-wrap items-baseline gap-x-2">
                          <StatusMark tone={restoreTest.tone}>{restoreTest.label}</StatusMark>
                          <span>
                            {device.lastTestRestore.completedAt
                              ? formatDateTime(device.lastTestRestore.completedAt, timezone, true)
                              : 'Time not available'}
                          </span>
                        </span>
                      ) : (
                        'No restore test has run yet'
                      )}
                    </td>
                    <td className={cn(CELL, 'order-6 text-sm text-foreground')}>
                      <span className={PHONE_LABEL}>Needs attention</span>
                      {isExternal ? NOT_TRACKED : device.openBreaches.map(breachLabel).join(', ') || 'None'}
                    </td>
                    <td className={cn(CELL, 'order-7 text-sm text-foreground')}>
                      <span className={PHONE_LABEL}>Recovery readiness</span>
                      {isExternal ? NOT_TRACKED : (device.readinessScore ?? 'Not available')}
                    </td>
                  </>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
      {total !== undefined && (
        <div
          className="border-t border-border px-4 pt-3.5 text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground sm:min-w-[56rem]"
          data-testid="portal-backup-device-count"
        >
          Showing {devices.length} of {total} devices
        </div>
      )}
    </div>
  );
}

export default BackupDeviceTable;
```

`BackupOverview.tsx` gains a matching export:

```tsx
// apps/portal/src/components/portal/BackupOverview.tsx — HEALTH_TONE/HEALTH_LABEL
// were already added in Task 3 as `export const`; no further change here.
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/portal && npx vitest run src/components/portal/BackupDeviceTable.test.tsx
cd apps/portal && npx vitest run src/components/portal/BackupOverview.test.tsx
cd apps/portal && pnpm exec astro check
```
Expected: both suites green; no import cycle (BackupDeviceTable imports FROM BackupOverview, not the reverse).

- [ ] **Step 5: Commit**

```bash
git add apps/portal/src/components/portal/BackupDeviceTable.tsx apps/portal/src/components/portal/BackupDeviceTable.test.tsx
git commit -m "$(cat <<'EOF'
feat(portal): add Source/Health columns and external-row — semantics

W04 Task 4. Source badge (Breeze / provider label), health dot, and — for
readiness/test-restore/needs-attention on unlinked provider rows, which
otherwise have no first-party evidence for those columns.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Posture report — provider product evidence

**Files:**
- Modify: `apps/api/src/services/securityComplianceReport.ts:1-38` (imports), `:280-358` (`orgWideEvidence`), `:527-561` (`productEvidence`), `:586-594` (`backupConfigured`)
- Modify: `apps/api/src/services/securityComplianceReport.test.ts` (809 lines today — `mockGeneratorQueries` header comment `:53-61`, `seq` array `:62-87`, `noPartner` splice `:93`, two positional overrides `:383`, `:416`)

**Interfaces:**
Consumes: `getProviderCoverageForDevices(orgId, deviceIds)` (`apps/api/src/services/backupHealthReadModel.ts`, W03), `getBackupProvider(key)` (`apps/api/src/services/backupProviders/registry.ts`, W01), `backupProviderDevices` Drizzle table (`apps/api/src/db/schema/backupProviders.ts`, W01 — columns `orgId`, `provider`, `breezeDeviceId` per the plan index's Data model section), `buildSecurityProductInventory`/`SecurityProductEvidence` (`./securityComplianceReportProducts.ts` — **unchanged this task**, `category: 'backup'` already exists at `securityComplianceReportProducts.ts:34`).

**Why no change to `securityComplianceReportProducts.ts`:** its merge algorithm already supports exactly the "denominator push + numerator push" shape this task needs (verified by re-reading `buildSecurityProductInventory`, lines 70-115: `deviceIds` union-accumulates across pushes sharing a product key regardless of `active`, `activeDeviceIds` accumulates only from pushes where `item.active && item.deviceIds`). No new parameter or branch is needed there.

**DECISION (why a raw `backup_provider_devices` query, not just `getProviderCoverageForDevices`):** `getProviderCoverageForDevices`'s return type (`Map<string, { covered, health }>`, plan index) carries no provider identity, so it cannot answer "which vendor is this." One new `db.select` against `backup_provider_devices` (org-axis RLS, safe under this route's ambient org-scoped context — unlike `backup_provider_connections`, which is partner-axis and would return nothing here per CLAUDE.md's dual-axis RLS rule) supplies `provider`/`breezeDeviceId` per linked row; `getProviderCoverageForDevices` supplies the covered/health verdict per device.

**DECISION (evidence push shape — verified against `buildSecurityProductInventory`'s merge code, lines 70-96):** three pushes per provider label achieve the exact `deviceCoverage`/`activeDeviceCoverage` split without the numerator push accidentally inflating the denominator's `activeDeviceIds`:
1. `{ active: true, deviceIds: undefined }` — sets the merged `active` flag unconditionally (a linked connection counts as "in use" regardless of today's per-device health), touching neither `deviceIds` nor `activeDeviceIds` (both derive from `item.deviceIds`, which is absent here).
2. `{ active: false, deviceIds: linkedIds }` — the denominator (every device this provider has linked in this org); `active: false` on THIS push keeps it out of `activeDeviceIds`.
3. `{ active: true, deviceIds: coveredIds }` (only when `coveredIds.length > 0`) — the numerator (D4 "covered": fresh, successful evidence).

**DECISION (label):** the report always uses the adapter's real label (e.g. "Cove Data Protection"), never gated by the connection's `show_provider_name_in_portal` (D5) flag. D5 is scoped to the customer PORTAL; this report is generated for/by the MSP as an audit artifact and hiding vendor identity here would remove information the tech needs. `lastSyncStatus` is `null` (the org-scoped context cannot read the partner-axis `backup_provider_connections.last_sync_status`, and no denormalized equivalent exists on the device rows — consistent with the existing Huntress/SentinelOne pushes at lines 529-544, which also pass `lastSyncStatus: null`).

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/services/securityComplianceReport.test.ts
// Add near the top, alongside the existing vi.mock calls (after line 8):
const backupProviderMocks = vi.hoisted(() => ({
  getProviderCoverageForDevices: vi.fn(),
}));
vi.mock('./backupHealthReadModel', () => backupProviderMocks);
vi.mock('./backupProviders/registry', () => ({
  getBackupProvider: (key: string) => {
    const known: Record<string, { key: string; label: string }> = {
      cove: { key: 'cove', label: 'Cove Data Protection' },
    };
    return known[key] ?? { key, label: key };
  },
}));
```

```ts
// Update the header comment (originally lines 53-61) and the `seq` literal
// (originally lines 62-87) and the noPartner splice (originally line 93) —
// see Step 3 for the exact replacement (test file mirrors the implementation
// file's query order 1:1, so both are shown together there).
```

```ts
// New tests — insert after the existing "carries the backup requirement
// without changing posture score" test (originally lines 311-322):
it('adds a linked backup-provider connection as a backup product with device/coverage counts (W04 #6012)', async () => {
  backupProviderMocks.getProviderCoverageForDevices.mockResolvedValue(new Map([
    ['dev-1', { covered: true, health: 'healthy' }],
    ['dev-2', { covered: false, health: 'critical' }],
  ]));
  mockGeneratorQueries({
    10: [
      { provider: 'cove', breezeDeviceId: 'dev-1' },
      { provider: 'cove', breezeDeviceId: 'dev-2' },
    ],
  });

  const summary = (await generateSecurityCompliancePostureReport(ORG, {})).summary as any;
  const cove = summary.securityProducts.find((p: any) => p.product === 'Cove Data Protection');
  expect(cove).toMatchObject({ category: 'backup', active: true, deviceCoverage: 2, activeDeviceCoverage: 1 });
  expect(backupProviderMocks.getProviderCoverageForDevices).toHaveBeenCalledWith(ORG, ['dev-1', 'dev-2', 'dev-3']);
  expect(summary.controls.backupConfigured).toBe(true);
});

it('excludes an unlinked provider row from the coverage count entirely, and does not claim backupConfigured on its own', async () => {
  backupProviderMocks.getProviderCoverageForDevices.mockResolvedValue(new Map());
  mockGeneratorQueries({
    8: [], // no first-party backup config
    9: [], // no c2c
    10: [{ provider: 'cove', breezeDeviceId: null }],
  });

  const summary = (await generateSecurityCompliancePostureReport(ORG, {})).summary as any;
  expect(summary.securityProducts.some((p: any) => p.category === 'backup')).toBe(false);
  expect(summary.controls.backupConfigured).toBe(false);
  expect(backupProviderMocks.getProviderCoverageForDevices).not.toHaveBeenCalled();
});

it('marks backupConfigured true from provider coverage alone (no first-party config, no c2c)', async () => {
  backupProviderMocks.getProviderCoverageForDevices.mockResolvedValue(new Map([
    ['dev-1', { covered: true, health: 'healthy' }],
  ]));
  mockGeneratorQueries({
    8: [], 9: [],
    10: [{ provider: 'cove', breezeDeviceId: 'dev-1' }],
  });

  const summary = (await generateSecurityCompliancePostureReport(ORG, {})).summary as any;
  expect(summary.controls.backupConfigured).toBe(true);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/api && npx vitest run src/services/securityComplianceReport.test.ts
```
Expected: `Cannot find module './backupHealthReadModel'` / `'./backupProviders/registry'` until W01/W03 land; once they exist, `find(...)` returns `undefined` (`cove` product absent) and query-order assertions on the two positional-override tests (`{18: …}`, `{17: …}`) misfire because `mockGeneratorQueries`'s `seq` still has only 16 slots.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/services/securityComplianceReport.ts:1-24 — imports
import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import { db } from '../db';
import {
  authenticatorPolicies,
  backupConfigs,
  backupProviderDevices,
  c2cConnections,
  devicePatches,
  devices,
  dnsFilterIntegrations,
  elevationRequests,
  googleWorkspaceConnections,
  huntressAgents,
  cisBaselineResults,
  m365Connections,
  organizations,
  OUTSTANDING_DEVICE_PATCH_STATUSES,
  pamOrgConfig,
  pamRules,
  patches,
  s1Agents,
  securityPostureOrgSnapshots,
  securityStatus,
  sites
} from '../db/schema';
import { securityCompliancePostureConfigSchema } from '../routes/reports/schemas';
import type { PostureSummary } from '@breeze/shared';
import {
  assertReportExecutionPreflight,
  type ReportResult,
} from './reportGenerationService';
import type { ReportExecutionAuthority } from './siteScope';
import {
  buildSecurityProductInventory,
  categoryForEndpointProvider,
  prettySecurityProvider,
  type SecurityProductEvidence
} from './securityComplianceReportProducts';
import { loadOpenVulnerabilityCounts } from './securityComplianceReportVulnerabilities';
import { classifyDeviceProtection } from './portal/protection';
import { getProviderCoverageForDevices } from './backupHealthReadModel';
import { getBackupProvider } from './backupProviders/registry';
```
(only `isNotNull` is new in the `drizzle-orm` import; `backupProviderDevices` is new in the schema import; the two `getProviderCoverageForDevices`/`getBackupProvider` lines are new.)

```ts
// apps/api/src/services/securityComplianceReport.ts:52-61 — replace the
// header comment above mockGeneratorQueries-equivalent block (this is the
// FUNCTION's own doc comment describing its query order; the identical text
// also appears, and must be kept identical, in the test file's
// mockGeneratorQueries comment — see the test-side edit below)
```
No such comment exists in the implementation file itself (it lives only in the test file) — skip; the real edit is inside `orgWideEvidence`:

```ts
// apps/api/src/services/securityComplianceReport.ts:283-358 — the
// orgWideEvidence IIFE. Insert the new query right after the `c2c` query
// (originally lines 295-299) and before the `m365` query (originally line
// 300), and add `providerDevices` to the returned object (originally line
// 345) and to the `else` branch's defaults (originally lines 347-358).
      const [c2c] = await db
        .select({ status: c2cConnections.status, provider: c2cConnections.provider })
        .from(c2cConnections)
        .where(and(eq(c2cConnections.orgId, orgId), eq(c2cConnections.status, 'active')))
        .limit(1);
      // W04 (#6012): every LINKED provider device row in this org — RLS
      // shape 1 (org-axis), safe to read under this route's ambient
      // org-scoped context, unlike backup_provider_connections (partner-axis,
      // which this org-scoped context cannot read at all — CLAUDE.md's
      // dual-axis RLS rule). Unlinked rows are excluded: they have no Breeze
      // device to attribute coverage to.
      const providerDevices = await db
        .select({ provider: backupProviderDevices.provider, breezeDeviceId: backupProviderDevices.breezeDeviceId })
        .from(backupProviderDevices)
        .where(and(eq(backupProviderDevices.orgId, orgId), isNotNull(backupProviderDevices.breezeDeviceId)));
      const [m365] = await db
        .select({ status: m365Connections.status })
        .from(m365Connections)
        .where(and(eq(m365Connections.orgId, orgId), eq(m365Connections.status, 'active')))
        .limit(1);
```

```ts
// return { dns, backup, c2c, m365, google, pamCfg, pamRuleRows, elevationRows, mfaStepUpEnforced, postureRow };
// becomes:
      return { dns, backup, c2c, providerDevices, m365, google, pamCfg, pamRuleRows, elevationRows, mfaStepUpEnforced, postureRow };
    })()
    : {
      dns: undefined,
      backup: undefined,
      c2c: undefined,
      providerDevices: [] as Array<{ provider: string; breezeDeviceId: string | null }>,
      m365: undefined,
      google: undefined,
      pamCfg: undefined,
      pamRuleRows: [],
      elevationRows: [],
      mfaStepUpEnforced: false,
      postureRow: undefined,
    };
  const {
    dns,
    backup,
    c2c,
    providerDevices,
    m365,
    google,
    pamCfg,
    pamRuleRows,
    elevationRows,
    mfaStepUpEnforced,
    postureRow,
  } = orgWideEvidence;
```

```ts
// apps/api/src/services/securityComplianceReport.ts — after the existing
// `if (c2c) productEvidence.push(...)` line (originally line 558), before
// `if (m365) productEvidence.push(...)`:
  const providerGroups = new Map<string, string[]>(); // provider key -> linked breeze device ids
  for (const row of providerDevices) {
    if (!row.breezeDeviceId) continue;
    const list = providerGroups.get(row.provider) ?? [];
    list.push(row.breezeDeviceId);
    providerGroups.set(row.provider, list);
  }
  let coveredProviderRows = 0;
  if (providerGroups.size > 0) {
    const coverage = await getProviderCoverageForDevices(orgId, deviceIds);
    for (const [providerKey, linkedIds] of providerGroups) {
      const label = getBackupProvider(providerKey).label;
      const coveredIds = linkedIds.filter((id) => coverage.get(id)?.covered === true);
      coveredProviderRows += coveredIds.length;
      // Sets `active: true` unconditionally, touching neither deviceIds nor
      // activeDeviceIds — see Task 5 DECISION above.
      productEvidence.push({ product: label, category: 'backup', active: true, lastSyncStatus: null });
      productEvidence.push({ product: label, category: 'backup', active: false, lastSyncStatus: null, deviceIds: linkedIds });
      if (coveredIds.length > 0) {
        productEvidence.push({ product: label, category: 'backup', active: true, lastSyncStatus: null, deviceIds: coveredIds });
      }
    }
  }
```

```ts
// apps/api/src/services/securityComplianceReport.ts:590 — widen
// backupConfigured (originally `backupConfigured: Boolean(backup || c2c),`)
          backupConfigured: Boolean(backup || c2c || coveredProviderRows > 0),
```

Now the test file (`securityComplianceReport.test.ts`). Both the header comment and `mockGeneratorQueries` (lines 53-100) are replaced:

```ts
// apps/api/src/services/securityComplianceReport.test.ts:53-100 — replace
/**
 * The generator issues selects in this fixed order:
 *  1 organizations   2 devices   3 security_status   4 s1_agents
 *  5 huntress_agents   6 device_patches+severity   7 dns_filter
 *  8 backup_configs   9 c2c_connections   10 backup_provider_devices (linked rows)
 * 11 m365   12 google   13 pam_org_config   14 pam_rules   15 elevation_requests
 * 16 authenticator_policies (only if org has partnerId)   17 latest org posture snapshot
 * 18 cis_baseline_results (only if includeCis)   19 device_patches scanned-set (any status)
 */
function mockGeneratorQueries(over: Partial<Record<number, any[]>> = {}, opts: { noPartner?: boolean } = {}) {
  const seq: any[][] = [
    /* 1 organizations */      [{ id: ORG, name: 'Acme Co', partnerId: opts.noPartner ? null : 'p1' }],
    /* 2 devices */            [
      { id: 'dev-1', hostname: 'pc-1', osType: 'windows', siteName: 'HQ' },
      { id: 'dev-2', hostname: 'pc-2', osType: 'macos', siteName: 'HQ' },
      { id: 'dev-3', hostname: 'pc-3', osType: 'windows', siteName: 'Remote' }
    ],
    /* 3 security_status */    [
      { deviceId: 'dev-1', provider: 'windows_defender', realTimeProtection: true, definitionsDate: new Date(), encryptionStatus: 'encrypted', firewallEnabled: true, passwordPolicySummary: { minLength: 12, lockoutThreshold: 5 }, localAdminSummary: { adminCount: 1 } },
      { deviceId: 'dev-2', provider: 'other', realTimeProtection: false, definitionsDate: null, encryptionStatus: 'unencrypted', firewallEnabled: false, passwordPolicySummary: { minLength: 4 }, localAdminSummary: { adminCount: 5 } }
    ],
    /* 4 s1_agents */          [],
    /* 5 huntress_agents */    [{ deviceId: 'dev-1' }],
    /* 6 device_patches */     [{ deviceId: 'dev-2', severity: 'critical' }],
    /* 7 dns_filter */         [{ isActive: true, provider: 'umbrella', lastSyncStatus: 'success' }],
    /* 8 backup_configs */     [{ isActive: true, provider: 's3', encryption: true }],
    /* 9 c2c */                [],
    /* 10 backup_provider_devices */ [],
    /* 11 m365 */              [{ status: 'active' }],
    /* 12 google */            [],
    /* 13 pam_org_config */    [{ uacInterceptionEnabled: true }],
    /* 14 pam_rules */         [{ id: 'r1' }, { id: 'r2' }],
    /* 15 elevation_requests*/ [{ approvedAt: new Date(), deniedByUserId: null }, { approvedAt: null, deniedByUserId: 'u1' }],
    /* 16 authenticator */     [{ requireEnrollment: true, enforceFrom: new Date(Date.now() - 86400000) }],
    /* 17 posture snapshot */  [{ overallScore: 82 }]
  ];
  for (const [i, rows] of Object.entries(over)) {
    if (rows) seq[Number(i) - 1] = rows;
  }
  // No-partner orgs skip the authenticator_policies query (#16), so drop that
  // slot to keep the remaining queries aligned with the generator's actual
  // call order.
  if (opts.noPartner) seq.splice(15, 1);
  const m = vi.mocked(db.select);
  m.mockReset();
  for (let i = 0; i < seq.length; i++) m.mockReturnValueOnce(selectChain(seq[i] ?? []));
  m.mockReturnValue(selectChain([]));
}
```

```ts
// line 383 (originally `mockGeneratorQueries({ 18: […] });`) — patch-scanned
// set moved from position 18 to position 19:
    mockGeneratorQueries({ 19: [{ deviceId: 'dev-1' }, { deviceId: 'dev-2' }] });
```

```ts
// line 416 (originally `mockGeneratorQueries({ 17: […] });`) — CIS moved
// from position 17 to position 18:
    mockGeneratorQueries({ 18: [{ deviceId: 'dev-1', passedChecks: 90, totalChecks: 100 }] });
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/api && npx vitest run src/services/securityComplianceReport.test.ts
cd apps/api && pnpm exec tsc --noEmit
```
Expected: all existing tests still pass at their (renumbered) positions, plus the 3 new tests from Step 1.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/securityComplianceReport.ts apps/api/src/services/securityComplianceReport.test.ts
git commit -m "$(cat <<'EOF'
feat(reports): flow backup-provider connections through the posture product inventory

W04 Task 5. New query #10 (linked backup_provider_devices rows, org-axis
RLS-safe); getProviderCoverageForDevices splits deviceCoverage/
activeDeviceCoverage; backupConfigured widens to include provider coverage.
mockGeneratorQueries renumbered (queries #10-19 shift by one).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Posture report rendering — `reportPdf.ts`

**Files:**
- Modify: `packages/shared/src/reportPdf/reportPdf.ts:597-609` (`buildPostureBackupMetric`), `:687` (call site), `:1611-1618` (`drawPostureProductRow`)
- Modify: `packages/shared/src/reportPdf/reportPdf.test.ts:57-85` (unchanged — new tests appended), `:94-152` region (new test appended nearby)

**Interfaces:**
Consumes: `PostureProduct[]` (existing type, `packages/shared/src/types/postureReport.ts:24-39`, unchanged this task).
Produces: `buildPostureBackupMetric(controls: PostureControls, products?: PostureProduct[]): Metric` — **backward-compatible**: the existing two `it.each` blocks (lines 57-85) call it with one argument and must keep passing unmodified (the test file explicitly labels them "keeps legacy backup configured=…" — a signal this function must stay callable the old way).

- [ ] **Step 1: Write the failing tests**

```ts
// packages/shared/src/reportPdf/reportPdf.test.ts
// Append inside `describe('buildPostureBackupMetric', ...)` (after the
// existing two it.each blocks, originally ending at line 85):
  it('lists every backup-category product instead of Yes/No when products are supplied', () => {
    expect(buildPostureBackupMetric(
      { backupRequired: true, backupConfigured: true },
      [
        { product: 'Breeze Backup', category: 'backup', active: true },
        { product: 'Cove Data Protection', category: 'backup', active: true },
        { product: 'Defender', category: 'antivirus', active: true },
      ],
    )).toEqual({
      label: 'Backup',
      value: 'Breeze Backup, Cove Data Protection',
      status: 'good',
    });
  });

  it('reads warn when only some backup products are active, bad when none are', () => {
    expect(buildPostureBackupMetric(
      { backupRequired: true, backupConfigured: true },
      [
        { product: 'Breeze Backup', category: 'backup', active: true },
        { product: 'Cove Data Protection', category: 'backup', active: false },
      ],
    ).status).toBe('warn');

    expect(buildPostureBackupMetric(
      { backupRequired: true, backupConfigured: false },
      [{ product: 'Cove Data Protection', category: 'backup', active: false }],
    ).status).toBe('bad');
  });

  it('falls back to the legacy Yes/No metric when no backup-category product is present', () => {
    expect(buildPostureBackupMetric(
      { backupRequired: true, backupConfigured: true },
      [{ product: 'Defender', category: 'antivirus', active: true }],
    )).toEqual({ label: 'Backup', value: 'Yes', status: 'good' });
  });
```

```ts
// Append a new test inside `describe('buildReportPdf in Node (no DOM)', ...)`,
// near the existing "spells out the RTP-on subset" test (originally lines
// 120-135):
  it('describes a backup product\'s active subset as a successful backup, not real-time protection', () => {
    const summary: PostureSummary = {
      ...postureSummary,
      securityProducts: [
        { product: 'Cove Data Protection', category: 'backup', active: true, deviceCoverage: 10, activeDeviceCoverage: 6 },
      ],
    };
    const doc = buildReportPdf(postureRows, { ...opts, reportType: 'security_compliance_posture', summary });
    const text = pdfCommandText(doc);
    expect(text).toContain('6 with a successful backup in the period');
    expect(text).not.toContain('real-time protection');
  });
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd packages/shared && npx vitest run src/reportPdf/reportPdf.test.ts
```
Expected: TS error (`buildPostureBackupMetric` called with 2 args against a 1-arg signature) until Step 3; the wording test fails with `expected text to contain '6 with a successful backup in the period'` (actual text has "6 with real-time protection on").

- [ ] **Step 3: Implement**

```ts
// packages/shared/src/reportPdf/reportPdf.ts:597-609 — replace
export function buildPostureBackupMetric(
  controls: PostureControls,
  products: PostureProduct[] = [],
) {
  const backupProducts = products.filter((p) => p.category === 'backup');
  if (backupProducts.length > 0) {
    const allActive = backupProducts.every((p) => p.active);
    const anyActive = backupProducts.some((p) => p.active);
    return {
      label: 'Backup',
      value: backupProducts.map((p) => p.product).join(', '),
      status: allActive ? 'good' : anyActive ? 'warn' : 'bad',
    } satisfies Metric;
  }
  const backupRequired = controls.backupRequired !== false;
  const backupValue = backupRequired
    ? `${yesNo(controls.backupConfigured)}${controls.backupConfigured && controls.backupEncrypted ? ' (encrypted)' : ''}`
    : controls.backupConfigured
      ? 'Optional; configured'
      : 'Not required';
  return {
    label: 'Backup',
    value: backupValue,
    status: backupRequired ? boolStatus(controls.backupConfigured) : 'neutral',
  } satisfies Metric;
}
```

```ts
// packages/shared/src/reportPdf/reportPdf.ts:687 — call site
  const backupMetric = buildPostureBackupMetric(c, summary.securityProducts ?? []);
```

```ts
// packages/shared/src/reportPdf/reportPdf.ts:1611-1618 — replace
  const activeCount = product.activeDeviceCoverage;
  // "Installed on N" reads as "protecting N". When only a subset of those
  // devices are actually protecting — native AV with RTP on, or a backup
  // product with a successful backup in the window — spell that out so one
  // active device can't imply full-fleet coverage (issue #2517; category-aware
  // wording added W04 #6012, since "real-time protection" is nonsensical for
  // a backup product).
  const activeNoteLabel = product.category === 'backup'
    ? 'with a successful backup in the period'
    : 'with real-time protection on';
  const rtpNote =
    product.deviceCoverage != null && activeCount != null && activeCount < product.deviceCoverage
      ? `, ${activeCount} ${activeNoteLabel}`
      : '';
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd packages/shared && npx vitest run src/reportPdf/reportPdf.test.ts
cd packages/shared && npx tsc --noEmit
```
Expected: all `buildPostureBackupMetric` tests (legacy + new) and the new wording test pass; every other `reportPdf.test.ts` test (RTP-note, continuation pages, etc.) unaffected since `product.category !== 'backup'` for those fixtures.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/reportPdf/reportPdf.ts packages/shared/src/reportPdf/reportPdf.test.ts
git commit -m "$(cat <<'EOF'
feat(reportPdf): list every backup product, and word its coverage note by category

W04 Task 6. buildPostureBackupMetric takes an optional PostureProduct[] and
lists every backup-category product (with a good/warn/bad status by how many
are active) instead of a single Yes/No; falls back to the legacy metric when
no backup product is present. drawPostureProductRow's active-subset note now
reads "with a successful backup in the period" for backup products instead of
the nonsensical "with real-time protection on".

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Org narrative — `narrativeContext.ts` provider block

**Files:**
- Modify: `apps/api/src/services/aiAgents/narrativeContext.ts:88-96` (import), `:234-244` (type, adjacent to `backups`), `:327-333` (`RawBackupInputs`, add sibling type), `:344-354` (`RawNarrativeInputs`), `:527-537` (assembler, adjacent to `backups`), `:552-577` (byte-ceiling trim), `:1068-1093` (loaders — new sibling `loadBackupProviders`), `:1180-1199` (`loadNarrativeContext`)
- Modify: `apps/api/src/services/aiAgents/narrativeContext.test.ts` (`:665,672` cascade lists, `:736-739` never-throws list, new `describe('loadBackupProviders', …)` block)

**Interfaces:**
Consumes: raw SQL against `backup_provider_devices`/`backup_provider_connections` via the module's own `query<T>(sql\`…\`)` helper (`:638-646`, unchanged) — **not** Drizzle, matching this file's established convention (module header comment, `:606-611`: "several need `FILTER (WHERE …)` … which the builder cannot express"). `deriveBackupHealth` (`@breeze/shared`, W01).
Produces: `RawBackupProviderInputs`, `NarrativeContext['backupProviders']` (both new), `loadBackupProviders(orgId): Promise<RawBackupProviderInputs>` (new, package-private — not exported, matching `loadBackups`/`loadFleet`).

**DECISION — a new top-level block, not folded into `backups`:** the existing `NarrativeContext['backups']` (`:234-244`) is shaped entirely around **job outcomes** (`ok`/`failed`/`partial`/`terminal`/`successRatePct`) — a concept providers do not have (Cove has no per-session narrative-context equivalent in phase 1; the ledger is observed daily health, not job events). The spec's own instruction is explicit: "described as device health, never as job counts." Adding fields here that are health-shaped, not count-shaped, to the SAME interface as `ok`/`failed`/`partial` would make it trivial for a future reader (or the model) to conflate a "critical" health bucket with a "failed" job count. A sibling block keeps the shapes structurally distinct.

**DECISION — no windowing:** unlike `loadBackups` (the WEEK's terminal outcomes), this loader reports **current** per-device health (mirroring `loadFleet`'s current-state `total`/`online`/`offline`, which also ignore the week window except for `enrolled7d`). `loadBackupProviders` therefore takes only `orgId`, no `Window`.

**DECISION — "unlinked" means unlinked-within-this-org, not partner-wide unmapped customers:** the spec's "unmapped counts" bullet is ambiguous between (a) provider customers under this org's partner that have never been mapped to ANY Breeze org, and (b) provider devices already mapped to THIS org whose auto/manual device-match never resolved. This is an ORG narrative (per-org, org-scoped even though the loader runs under system context) — (a) is a partner-wide fact that doesn't belong to one org's weekly report and would require reading `backup_provider_customers` for connections this org's partner owns but that may cover a dozen OTHER orgs too. (b) is squarely about this org's own devices and is what `backup_provider_devices.breeze_device_id IS NULL` (scoped `WHERE org_id = $orgId`) answers directly. This plan implements (b) and names the field `unlinkedDevices`.

**DECISION — "last sync age":** computed as the OLDEST `last_sync_at` among the connections that have at least one device row in this org (`MIN`, not `MAX`) — a staleness signal should surface the WORST case, matching the unified read model's own `stale` derivation philosophy (spec, Normalized status and health section: "read model … forces `covered = false` … when … `last_sync_at` older than 2 × `sync_interval_minutes`").

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/services/aiAgents/narrativeContext.test.ts
// Line 665 (inside "reports every block downstream of an aborted transaction"):
    expect(ctx.unavailable).toEqual(expect.arrayContaining(['tickets', 'patching', 'backups', 'backupProviders', 'fleet']));
```

```ts
// Line 672 (same test, immediately below):
    expect(reportedFailures().map((entry) => entry.loader))
      .toEqual(['tickets', 'patching', 'backups', 'backupProviders', 'fleet']);
```

```ts
// Lines 736-739 (inside "never throws, even when every single statement fails"):
    expect(ctx.unavailable).toEqual(expect.arrayContaining([
      'alerts.suppressedInWindow', 'fleet.onlineOfflineDelta',
      'org', 'alerts', 'sweeps', 'fixes', 'tickets', 'patching', 'backups', 'backupProviders', 'fleet',
    ]));
```

```ts
// New describe block — insert after the existing backups-related tests
// (near the original line 718, right before "survives a failed header
// loader…"):
describe('loadBackupProviders (W04 #6012)', () => {
  const DEVICE_ROW = (over: Partial<Record<string, unknown>> = {}) => ({
    status: 'completed', last_success_at: '2026-08-29T00:00:00.000Z', errors_count: 0,
    name: 'FILE01', breeze_device_id: 'd-1', ...over,
  });

  it('tallies devices by derived health and lists critical devices by name', async () => {
    rowsFor.push({
      match: 'FROM backup_provider_devices',
      rows: [
        DEVICE_ROW({ name: 'FILE01', status: 'completed', last_success_at: '2026-08-29T11:00:00.000Z' }),
        DEVICE_ROW({ name: 'BACKUP-SVR', status: 'failed', last_success_at: null, breeze_device_id: null }),
        DEVICE_ROW({ name: 'OLD-PC', status: 'no_backups', last_success_at: null, breeze_device_id: 'd-3' }),
      ],
    });
    vi.setSystemTime(new Date('2026-08-29T12:00:00.000Z'));
    const ctx = await loadNarrativeContext(ORG);

    expect(ctx.backupProviders.available).toBe(true);
    expect(ctx.backupProviders.devicesByHealth.healthy).toBe(1);
    expect(ctx.backupProviders.devicesByHealth.critical).toBe(2);
    expect(ctx.backupProviders.criticalDevices.map((d) => d.name).sort()).toEqual(['BACKUP-SVR', 'OLD-PC']);
    // One of the three rows has no breeze_device_id.
    expect(ctx.backupProviders.unlinkedDevices).toBe(1);
  });

  it('caps critical devices at NARRATIVE_TOP_N and flags truncation', async () => {
    rowsFor.push({
      match: 'FROM backup_provider_devices',
      rows: Array.from({ length: NARRATIVE_TOP_N + 1 }, (_, i) =>
        DEVICE_ROW({ name: `CRIT-${i}`, status: 'failed', last_success_at: null })),
    });
    const ctx = await loadNarrativeContext(ORG);
    expect(ctx.backupProviders.criticalDevices).toHaveLength(NARRATIVE_TOP_N);
    expect(ctx.backupProviders.criticalDevicesTruncated).toBe(true);
  });

  it('reports the oldest relevant connection sync as an age in minutes', async () => {
    vi.setSystemTime(new Date('2026-08-29T12:00:00.000Z'));
    rowsFor.push(
      { match: 'FROM backup_provider_devices', rows: [DEVICE_ROW()] },
      { match: 'FROM backup_provider_connections', rows: [{ oldest_sync: '2026-08-29T10:30:00.000Z' }] },
    );
    const ctx = await loadNarrativeContext(ORG);
    expect(ctx.backupProviders.lastSyncAgeMinutes).toBe(90);
  });

  it('reports null sync age and zeroed health when the org has no provider devices', async () => {
    const ctx = await loadNarrativeContext(ORG);
    expect(ctx.backupProviders.available).toBe(true);
    expect(ctx.backupProviders.devicesByHealth).toEqual({ healthy: 0, warning: 0, critical: 0, unknown: 0 });
    expect(ctx.backupProviders.criticalDevices).toEqual([]);
    expect(ctx.backupProviders.unlinkedDevices).toBe(0);
    expect(ctx.backupProviders.lastSyncAgeMinutes).toBeNull();
  });

  it('logs and reports a loader rejection rather than swallowing it', async () => {
    failOn = ['FROM backup_provider_devices'];
    await loadNarrativeContext(ORG);
    const reported = reportedFailures();
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({ orgId: ORG, loader: 'backupProviders' });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/api && npx vitest run src/services/aiAgents/narrativeContext.test.ts
```
Expected: `ctx.backupProviders` is `undefined` (`TypeError: Cannot read properties of undefined`); the three updated array-literal assertions mismatch (missing `'backupProviders'`).

- [ ] **Step 3: Implement**

```ts
// apps/api/src/services/aiAgents/narrativeContext.ts:88-96 — imports
import {
  AI_ALERT_VERDICT_CLASSIFICATIONS,
  AI_SWEEP_KINDS,
  AI_SWEEP_SEVERITIES,
  deriveBackupHealth,
  type AgentRunVerdict,
  type AiAlertVerdictClassification,
  type AiSweepKind,
  type AiSweepSeverity,
  type BackupHealth,
  type ExternalBackupStatus,
} from '@breeze/shared';
```

```ts
// apps/api/src/services/aiAgents/narrativeContext.ts — NarrativeContext
// interface, insert right after the existing `backups: { … };` block
// (originally lines 234-244):
  /**
   * Third-party backup-provider devices (Cove et al.) — DEVICE HEALTH, never
   * job counts (`backups` above is job outcomes and must not be conflated
   * with this). See narrativeContext.ts header DECISION, W04 #6012.
   */
  backupProviders: {
    available: boolean;
    devicesByHealth: Record<BackupHealth, number>;
    /** Up to `NARRATIVE_TOP_N + 1`, unordered beyond "critical first". */
    criticalDevices: Array<{ name: string }>;
    criticalDevicesTruncated: boolean;
    /** Provider devices in this org with no linked Breeze device. */
    unlinkedDevices: number;
    /** Minutes since the OLDEST relevant connection's last sync — a
     *  staleness signal, null when the org has no provider devices. */
    lastSyncAgeMinutes: number | null;
  };
```

```ts
// apps/api/src/services/aiAgents/narrativeContext.ts — sibling to
// RawBackupInputs (originally lines 325-332):
export interface RawBackupProviderInputs {
  devicesByHealth: Record<BackupHealth, number>;
  criticalDevices: Array<{ name: string }>;
  unlinkedDevices: number;
  lastSyncAgeMinutes: number | null;
}
```

```ts
// apps/api/src/services/aiAgents/narrativeContext.ts:344-354 —
// RawNarrativeInputs, insert after `backups`:
export interface RawNarrativeInputs {
  period: { start: string; end: string };
  org: RawOrgHeader | null;
  alerts: RawAlertInputs | null;
  sweeps: RawSweepInputs | null;
  fixes: RawFixInputs | null;
  tickets: RawTicketInputs | null;
  patching: RawPatchingInputs | null;
  backups: RawBackupInputs | null;
  backupProviders: RawBackupProviderInputs | null;
  fleet: RawFleetInputs | null;
}
```

```ts
// apps/api/src/services/aiAgents/narrativeContext.ts — assembler, insert
// right after the existing `backups` block (originally lines 527-537),
// before `if (!raw.fleet) missing('fleet');`:
  if (!raw.backupProviders) missing('backupProviders');
  const criticalDevicesAll = (raw.backupProviders?.criticalDevices ?? [])
    .map((row) => ({ name: sanitizeName(row.name) }));
  const backupProviders: NarrativeContext['backupProviders'] = {
    available: raw.backupProviders !== null,
    devicesByHealth: raw.backupProviders?.devicesByHealth ?? { healthy: 0, warning: 0, critical: 0, unknown: 0 },
    criticalDevices: criticalDevicesAll.slice(0, NARRATIVE_TOP_N),
    criticalDevicesTruncated: criticalDevicesAll.length > NARRATIVE_TOP_N,
    unlinkedDevices: raw.backupProviders?.unlinkedDevices ?? 0,
    lastSyncAgeMinutes: raw.backupProviders?.lastSyncAgeMinutes ?? null,
  };
```

```ts
// apps/api/src/services/aiAgents/narrativeContext.ts:552 — ctx object
// literal, add backupProviders between backups and fleet:
  const ctx: NarrativeContext = {
    org, period: raw.period, alerts, sweeps, fixes, tickets, patching, backups, backupProviders, fleet,
    unavailable, truncated: false,
  };
```

```ts
// apps/api/src/services/aiAgents/narrativeContext.ts:563-577 — byte-ceiling
// trim loop. The newest, least central list trims FIRST (before ticket
// categories):
  while (Buffer.byteLength(JSON.stringify(ctx), 'utf8') > limit) {
    if (ctx.backupProviders.criticalDevices.length > 0) {
      ctx.backupProviders.criticalDevices = ctx.backupProviders.criticalDevices.slice(0, -1);
      ctx.backupProviders.criticalDevicesTruncated = true;
    } else if (ctx.tickets.byCategory.length > 0) {
      ctx.tickets.byCategory = ctx.tickets.byCategory.slice(0, -1);
      ctx.tickets.byCategoryTruncated = true;
    } else if (ctx.alerts.topRules.length > 0) {
      ctx.alerts.topRules = ctx.alerts.topRules.slice(0, -1);
      ctx.alerts.topRulesTruncated = true;
    } else {
      ctx.truncated = true;
      break;
    }
    ctx.truncated = true;
  }
```

```ts
// apps/api/src/services/aiAgents/narrativeContext.ts — new loader, placed
// as a sibling right after loadBackups (originally lines 1068-1093), before
// the loadFleet doc comment:
/**
 * Third-party backup providers: CURRENT per-device health (not windowed —
 * see this module's header DECISION for why this differs from loadBackups).
 * `errors_count`/`last_success_at`/`status` feed the SAME `deriveBackupHealth`
 * pure function the unified read model uses, so a device here and the same
 * device on the /backup overview never disagree about its bucket.
 */
async function loadBackupProviders(orgId: string): Promise<RawBackupProviderInputs> {
  const rows = await query<{
    status: string; last_success_at: Date | string | null; errors_count: number | string | null;
    name: string; breeze_device_id: string | null;
  }>(sql`
    SELECT bpd.status, bpd.last_success_at, bpd.errors_count,
           coalesce(bpd.computer_name, bpd.vendor_device_name) AS name,
           bpd.breeze_device_id
    FROM backup_provider_devices bpd
    WHERE bpd.org_id = ${orgId}
  `);

  const devicesByHealth: Record<BackupHealth, number> = { healthy: 0, warning: 0, critical: 0, unknown: 0 };
  const criticalDevices: Array<{ name: string }> = [];
  let unlinkedDevices = 0;
  for (const row of rows) {
    const { health } = deriveBackupHealth({
      status: row.status as ExternalBackupStatus,
      lastSuccessAt: row.last_success_at,
      errorsCount: count(row.errors_count),
    });
    devicesByHealth[health] += 1;
    if (health === 'critical') criticalDevices.push({ name: row.name });
    if (!row.breeze_device_id) unlinkedDevices += 1;
  }

  const [syncRow] = await query<{ oldest_sync: Date | string | null }>(sql`
    SELECT min(bpc.last_sync_at) AS oldest_sync
    FROM backup_provider_connections bpc
    WHERE bpc.id IN (
      SELECT DISTINCT connection_id FROM backup_provider_devices WHERE org_id = ${orgId}
    )
  `);
  const oldestSync = syncRow?.oldest_sync ? new Date(syncRow.oldest_sync) : null;
  const lastSyncAgeMinutes = oldestSync
    ? Math.max(0, Math.round((Date.now() - oldestSync.getTime()) / 60000))
    : null;

  return {
    devicesByHealth,
    // Read N+1 — see this module's header on observable truncation.
    criticalDevices: criticalDevices.slice(0, TOP_N_FETCH_LIMIT),
    unlinkedDevices,
    lastSyncAgeMinutes,
  };
}
```

```ts
// apps/api/src/services/aiAgents/narrativeContext.ts:1195 — loadNarrativeContext,
// insert the new loader call between backups and fleet, and thread it into
// the assembler call:
  const backups = await settled(orgId, 'backups', () => loadBackups(orgId, window));
  const backupProviders = await settled(orgId, 'backupProviders', () => loadBackupProviders(orgId));
  const fleet = await settled(orgId, 'fleet', () => loadFleet(orgId, window));

  return assembleNarrativeContext({
    period: { start: zonedIso(start, timezone), end: zonedIso(end, timezone) },
    org: header, alerts, sweeps, fixes, tickets, patching, backups, backupProviders, fleet,
  });
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/api && npx vitest run src/services/aiAgents/narrativeContext.test.ts
cd apps/api && pnpm exec tsc --noEmit
```
Expected: all tests pass, including the new `loadBackupProviders` describe block and the three updated cascade/never-throws assertions.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/aiAgents/narrativeContext.ts apps/api/src/services/aiAgents/narrativeContext.test.ts
git commit -m "$(cat <<'EOF'
feat(ai-agents): add a device-health backup-provider block to the org narrative

W04 Task 7. New loadBackupProviders loader (current-state, unwindowed, raw
SQL against backup_provider_devices/backup_provider_connections) feeds a
NEW sibling block to `backups` — devicesByHealth, criticalDevices,
unlinkedDevices, lastSyncAgeMinutes — deliberately never shaped like a job
count. Trims first under the whole-context byte ceiling.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Org narrative rendering — `runnerPrompt.ts`

**Files:**
- Modify: `apps/api/src/services/aiAgents/runnerPrompt.ts:983-994` (append after the existing `## Backups` block)
- Modify: `apps/api/src/services/aiAgents/runnerPrompt.test.ts:728-788` (`narrativeContext()` fixture), append new assertions near `:897-899`

**Interfaces:**
Consumes: `NarrativeContext['backupProviders']` (Task 7), `narrativeLine`/`narrativeHistogram`/`measuredKey`/`sanitizeSweepText` (all existing, unchanged — `runnerPrompt.ts:810-836`).

**Why the same `## Backups` heading, not a new section:** the spec's architecture diagram names the destination `narrativeContext.loadBackups → org narrative "Backups" section` (singular) — the provider block is additional content inside the SAME heading, not a new `NARRATIVE_SECTION_KEYS` entry (which would also require a new guidance line and a `submit_narrative` schema enum value — out of scope, not requested by the spec).

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/aiAgents/runnerPrompt.test.ts:776-778 — the
// narrativeContext() fixture gains a sibling block (backward compatible:
// every existing caller either uses the full fixture or spreads it via
// `...narrativeContext()`):
    backups: {
      available: true, ok: 40, failed: 3, partial: 1, terminal: 44, successRatePct: 90.9, devicesFailed: 2,
    },
    backupProviders: {
      available: true,
      devicesByHealth: { healthy: 8, warning: 1, critical: 2, unknown: 0 },
      criticalDevices: [{ name: 'BACKUP-SVR' }, { name: 'OLD-FILESERVER' }],
      criticalDevicesTruncated: false,
      unlinkedDevices: 1,
      lastSyncAgeMinutes: 42,
    },
```

```ts
// New tests — append near the existing backups assertions (originally
// lines 897-899, inside whichever `it(...)` builds `narrativeCtx(narrativeContext())`
// and asserts on `text`):
  it('renders the third-party backup-provider block under the Backups heading, as device health not job counts', () => {
    const text = buildNarrativeTaskPrompt(narrativeCtx());
    expect(text).toContain('## Backups');
    expect(text).toContain('devices healthy: 8');
    expect(text).toContain('devices critical: 2');
    expect(text).toContain('BACKUP-SVR');
    expect(text).toContain('OLD-FILESERVER');
    expect(text).toContain('third-party devices not linked to a Breeze device: 1');
    expect(text).toContain('minutes since the oldest relevant provider sync: 42');
    // Never phrased as a job outcome — the whole point of the separate block.
    expect(text).not.toMatch(/backup-provider jobs/);
  });

  it('reports the provider block as not measured when its loader failed, without leaking undefined', () => {
    const unmeasured = narrativeContext();
    unmeasured.backupProviders = {
      available: false, devicesByHealth: { healthy: 0, warning: 0, critical: 0, unknown: 0 },
      criticalDevices: [], criticalDevicesTruncated: false, unlinkedDevices: 0, lastSyncAgeMinutes: null,
    };
    unmeasured.unavailable = [...unmeasured.unavailable, 'backupProviders'];

    const text = buildNarrativeTaskPrompt(narrativeCtx(unmeasured));
    expect(text).toContain('third-party devices not linked to a Breeze device: (not measured)');
    expect(text).not.toMatch(/undefined/);
    expect(text).not.toMatch(/: null/);
  });

  it('truncates the critical-devices list honestly', () => {
    const trimmed = narrativeContext();
    trimmed.backupProviders = {
      ...trimmed.backupProviders,
      criticalDevices: [{ name: 'A' }],
      criticalDevicesTruncated: true,
    };
    const text = buildNarrativeTaskPrompt(narrativeCtx(trimmed));
    expect(text).toMatch(/left out/i);
  });
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd apps/api && npx vitest run src/services/aiAgents/runnerPrompt.test.ts
```
Expected: TS error (missing `backupProviders` on the `NarrativeContext` literal) until Task 7 lands; once it exists, `expect(text).toContain('devices healthy: 8')` fails — the string is not in the prompt yet.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/services/aiAgents/runnerPrompt.ts — insert right after the
// existing `## Backups` block (originally ending at line 994, right before
// `const fleet = c?.fleet;`):
  const backupProviders = c?.backupProviders;
  const backupProvidersMeasured = Boolean(backupProviders?.available);
  lines.push('');
  lines.push('third-party backup providers (device health, not job counts):');
  lines.push(...narrativeHistogram(
    'devices',
    backupProviders?.devicesByHealth ?? { healthy: 0, warning: 0, critical: 0, unknown: 0 },
    backupProvidersMeasured,
  ));
  if (backupProvidersMeasured && (backupProviders?.criticalDevices.length ?? 0) > 0) {
    lines.push('critical third-party backup devices:');
    for (const device of backupProviders!.criticalDevices) {
      lines.push(sanitizeSweepText(device.name));
    }
    if (backupProviders!.criticalDevicesTruncated) {
      lines.push('(smaller items were left out to keep this bounded)');
    }
  }
  lines.push(narrativeLine(
    'third-party devices not linked to a Breeze device',
    backupProviders?.unlinkedDevices ?? null,
    backupProvidersMeasured,
  ));
  lines.push(narrativeLine(
    'minutes since the oldest relevant provider sync',
    backupProviders?.lastSyncAgeMinutes ?? null,
    backupProvidersMeasured,
  ));
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/api && npx vitest run src/services/aiAgents/runnerPrompt.test.ts
cd apps/api && pnpm exec tsc --noEmit
```
Expected: all `buildNarrativeTaskPrompt` tests pass, including the 3 new ones and test (l) ("no undefined/null leaks") which now also covers the new block via the fixture spread.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/aiAgents/runnerPrompt.ts apps/api/src/services/aiAgents/runnerPrompt.test.ts
git commit -m "$(cat <<'EOF'
feat(ai-agents): render the backup-provider device-health block in the narrative prompt

W04 Task 8. Appends under the existing "## Backups" heading (same section as
job outcomes, per spec architecture) — a closed-enum health histogram,
critical device names (sanitized, capped, honestly truncated), unlinked
count, and provider sync staleness. "(not measured)" when the loader failed.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

## Self-review

### 1. Spec coverage

| Spec requirement (Client portal + Reports posture/narrative sections) | Task |
|---|---|
| `backupOverview(orgId)`/`backupDevicesPage(orgId)` consume `listBackupHealthRows` for coverage/per-device pieces | Task 2 |
| Verification/test-restore/SLA-breach/readiness fields keep their existing queries | Task 2 (unchanged code paths, verified against original file) |
| `BackupDeviceRow`/`BackupOverviewDto` additive DTO fields (spec "Client portal" section) | Task 1 |
| Provider rows use `id = provider:<row id>` when unlinked | Task 2 (`id: row.key`, matches spec's own `key` format) |
| `providerLabel` = "Managed cloud backup" unless `portal_show_provider_name` (D5) | Handled entirely inside W03's `BackupHealthRow.providerLabel` — this wave only relays it; documented in Task 2's per-row merge DECISION |
| Dashboard tile (`backupTile`) called unconditionally; provider data enters only when `enable_backups` is on | Task 2 |
| Posture report: provider products through `buildSecurityProductInventory` path; `deviceCoverage`/`activeDeviceCoverage` via `getProviderCoverageForDevices` | Task 5 |
| `backupConfigured = Boolean(backup \|\| c2c \|\| coveredProviderRows > 0)` | Task 5 |
| `buildPostureBackupMetric` lists every backup-category product | Task 6 |
| Product-inventory wording "with real-time protection on" → category-aware | Task 6 |
| Org narrative: provider block — devices by health, critical devices by name, unmapped/unlinked counts, last sync age — described as device health, never job counts | Task 7, rendered in Task 8 |
| No schema change this wave; export-policy/rls-coverage untouched | Global Constraints (explicit statement) |

### 2. Placeholder scan

No "TBD"/"TODO"/"implement later"/"similar to Task N" anywhere above — every step shows real, complete code. The one place a step says "(unchanged)" is always accompanied by either the exact original line range already read from the repo or the full surrounding code block, never a bare promise.

### 3. Type consistency

`BackupDeviceRow`/`BackupOverviewDto` (Task 1) are consumed identically by Task 2 (producer), Task 3/4 (portal renderers) and nowhere redefined. `ExternalBackupStatus`/`BackupHealth`/`deriveBackupHealth` are imported from `@breeze/shared` in every task that needs them (Tasks 1, 2, 5, 7) with the exact names from the plan index's "Cross-wave names" section — never locally re-declared.

## DECISIONs (collected)

1. **Task 1** — new `BackupDeviceRow` fields are required in the type; the renderer (Task 4) reads them defensively for one release.
2. **Global Constraints** — `apps/portal` has no i18n system at all (verified by search); the wave brief's instruction to add an i18n key there does not apply — "Managed cloud backup" is a plain literal string, as every other portal string already is.
3. **Task 2** — `backupTile` widens `configured`/`total` to provider coverage only when `enable_backups` is on (queried inside the function, mirroring `serviceReadModel.ts`'s `serviceTile` pattern); `completedAt`/`verificationType` stay strictly first-party since Cove has no verification-event concept in phase 1.
4. **Task 2** — a Breeze device that is both first-party-backed-up and provider-linked yields one merged portal row: breeze `status`/`health` win when present, `lastSuccessAt` is the max across sources, `providerLabel` is set whenever a provider is linked regardless of which source's status won.
5. **Task 2** — `backupDevicesPage` keeps its existing offset/limit SQL for Breeze rows unchanged and appends unlinked provider rows to page 1 only (capped at 200), rather than rebuilding cross-source cursor pagination — the sole caller always requests page 1.
6. **Task 3/4** — health tone/label mapping and the "Backup health"/"Third-party backup" ledger rows follow the existing `StatusMark`/ledger-row primitives; no new UI primitive introduced.
7. **Task 5** — a new `db.select` against `backup_provider_devices` (org-axis, RLS-safe under this route's context) supplies provider identity; `getProviderCoverageForDevices` supplies per-device coverage — `backup_provider_connections` (partner-axis) is deliberately never queried from this org-scoped context.
8. **Task 5** — three-push evidence shape into `buildSecurityProductInventory` (force-active / denominator / numerator) verified line-by-line against the existing merge algorithm rather than assumed.
9. **Task 5** — the posture report always shows the real adapter label (never gated by `show_provider_name_in_portal`/D5, which is portal-only); `lastSyncStatus` is `null` for provider evidence (unreachable partner-axis data from this context, consistent with existing Huntress/SentinelOne pushes).
10. **Task 6** — `buildPostureBackupMetric` gains an optional second parameter (backward compatible with the two existing "legacy" tests) rather than a breaking signature change.
11. **Task 7** — the provider block is a NEW sibling to `backups` in `NarrativeContext`, not folded into it, specifically so its health-shaped fields can never be confused with job counts.
12. **Task 7** — "unlinked" = provider devices in THIS org with no linked Breeze device (not partner-wide unmapped customers, which don't belong to a single org's weekly report).
13. **Task 7** — "last sync age" uses the OLDEST (`MIN`) relevant connection's `last_sync_at`, surfacing worst-case staleness.
14. **Task 8** — rendered under the existing `## Backups` heading (matches the spec's architecture diagram), not a new `NARRATIVE_SECTION_KEYS` entry.

## Spec requirements not mapped to a task

None found within this wave's scope (Client portal in full; Reports — posture report and org narrative bullets only).

## Repo facts that contradict the spec/plan index/brief

- The wave brief instructs adding a real-translated i18n key to "the portal locales." `apps/portal` has **no i18n system** — no locale directory, no `react-i18next`/`useTranslation` usage anywhere under `apps/portal/src/components/portal/`. Every string in `BackupOverview.tsx`, `BackupDeviceTable.tsx`, and `ui.tsx` is literal English. See Global Constraints DECISION.
