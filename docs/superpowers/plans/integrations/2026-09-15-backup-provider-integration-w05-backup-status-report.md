---
tracking_issue: LanternOps/breeze#6008
---
# Backup Provider Integration W05: Backup Status Report — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new `backup_status` report type — an org-scoped, as-of snapshot over both backup sources (Breeze first-party jobs and linked/unlinked provider devices) laid out like Cove's own "Backup & Recovery: All devices" email — to the existing report system: type registration, a data builder over the W03 unified read model, a shared PDF renderer, and web template/options-form/edit-page wiring with real translations in all 8 locales.

**Architecture:** `backup_status` is registered exactly like `hardware_lifecycle` was (the closest existing report type, also a curated, options-form-driven, non-builder report): one Postgres enum value, one Zod config schema, one `ReportType` union member and two `switch` arms in the existing dispatcher (`reportGenerationService.ts`), one data-builder service that pages through `backupHealthReadModel.listBackupHealthRows` (W03) and calls `summarizeBackupHealth` (W03), one shared PDF renderer wired into `reportPdf.ts`'s existing per-type dispatch (the same pattern `hardwareLifecyclePdf.ts` uses via the exported `PdfChrome` type), and one curated web template + options form + edit-page branch, mirroring `HardwareLifecycleOptionsForm.tsx` / `ReportTemplates.tsx`'s lifecycle branch / `ReportEditPage.tsx`'s `isLifecycle` branch file-for-file. CSV/Excel export and PDF export both already dispatch generically off `report.type` + `summary` (`apps/web/src/components/reports/reportExport.ts`, `apps/api/src/services/reportDelivery.ts`, `apps/api/src/services/portal/reportsSelfService.ts`), so no changes are needed there beyond the type/dispatch wiring.

**Tech Stack:** PostgreSQL (one `ALTER TYPE … ADD VALUE` migration), Drizzle ORM, Hono + Zod, jsPDF + jspdf-autotable (shared PDF renderer), Astro + React 19 islands, react-i18next, Vitest (API unit with Drizzle/module mocks; shared-package unit; web unit with Testing Library).

**Spec:** `docs/superpowers/specs/integrations/2026-09-15-backup-provider-integration-cove-design.md` — Decision **D6** ("Reports"), the **Reports** section's "Backup status report (final wave, detachable)" paragraph, and the **Wave outline**'s item 5 ("W05 Backup status report — detachable"). No other spec section describes this wave's surface in detail; the exact report layout, config shape, file names and task breakdown below are this plan's own design, filling that gap, and every such point is marked **DECISION** inline. **Explicitly NOT in scope** (spec's own words, Reports section, last sentence): registering `backup_status` in `MANAGED_EVIDENCE_REGISTRY` / `MANAGED_EVIDENCE_REPORT_TYPES` (`apps/api/src/services/managedEvidenceRegistry.ts`, `packages/shared/src/validators/deliverableTemplates.ts`) — "that registration is a deliverables-track task, not part of this spec." This plan does not touch either file.

**Cross-wave names (from the plan index — consumed, not defined, by this wave):**
- `packages/shared/src/types/backupHealth.ts` / `packages/shared/src/utils/backupHealth.ts` (W01): `EXTERNAL_BACKUP_STATUSES`, `type ExternalBackupStatus`, `type BackupHealth`, `type BackupRecency`, `EXTERNAL_BACKUP_STATUS_SEVERITY`, `type BackupHealthRow`, `type BackupHealthSummary`.
- `packages/shared/src/types/backupHealth.ts` / `packages/shared/src/utils/backupHealth.ts` (W01, added after this plan's first draft): the **status-bucket grouping is now a shared cross-wave contract**, not a local fold — `BACKUP_STATUS_BUCKET_IDS = ['no_backups','completed','completed_with_errors','in_progress','unsuccessful','other'] as const`, `type BackupStatusBucketId`, `BACKUP_STATUS_BUCKET_MEMBERS` (`unsuccessful = failed + over_quota + no_selection + interrupted`; `other = not_started + unknown`), `bucketForBackupStatus(status: ExternalBackupStatus): BackupStatusBucketId`. The W03 web overview (`BackupHealthOverview.tsx`) uses this same mapping for its own status bar, so this report and the overview can never disagree about where a status lands. This plan's first draft (superseded) defined an equivalent local fold in `apps/api/src/services/backupStatusReport.ts` under the DECISION that no shared helper existed yet — it does now, and Task 4 imports it instead.
- `apps/api/src/services/backupHealthReadModel.ts` (W03): `listBackupHealthRows(scope: { orgIds: string[]; siteIds?: string[] }, opts): Promise<{ rows: BackupHealthRow[]; nextCursor: string | null }>`, `summarizeBackupHealth(scope, opts): Promise<BackupHealthSummary>`.
- `backup_provider_device_history` (W01 table; not queried directly by this wave — its rollup reaches this report only through each row's `history28d`, which W03's read model already derives).

## Global Constraints

- No migration slot beyond one enum value: `apps/api/migrations/2026-10-17-120100-backup-status-report-type.sql` (reserved by the plan index — "only if the report-type enum needs a value; otherwise unused"). It DOES need one: `report_type` is a real Postgres `pgEnum` (`apps/api/src/db/schema/reports.ts:22`), not a Zod-only string union. Re-check `ls apps/api/migrations | grep '\.sql$' | sort | tail -1` before committing — as of 2026-09-15 the newest committed migration is `2026-10-17-094100-m365-signin-events.sql`, and W01's own reserved slot `2026-10-17-120000-backup-provider-integration.sql` sorts before `-120100-`; rename upward if main has moved past either by the time you commit.
- The migration is `ALTER TYPE report_type ADD VALUE IF NOT EXISTS 'backup_status';` — enum-add only, in its own file, no DML, so it needs no `SELECT set_config('breeze.scope','system',true)` preamble and must NOT be added to `migrationRlsScope.test.ts`'s frozen baseline (it writes no rows, so it is not an offender in the first place — do not touch that file). No new table, so no RLS, no `CORE_ORG_CASCADE_DELETE_ORDER`, no `CORE_TENANT_EXPORT_POLICY`, no `orgMergeRegistry` entry — `report_runs`/`reports` already carry their own registrations and this wave adds no column to either.
- Idempotent per CLAUDE.md: `ADD VALUE IF NOT EXISTS`. No inner `BEGIN;`/`COMMIT;` (autoMigrate wraps the file in its own transaction).
- Run one test file as `cd apps/api && npx vitest run <path>` (API) or `cd apps/web && npx vitest run <path>` (web) or `cd packages/shared && npx vitest run <path>` (shared) — **never** `pnpm --filter <pkg> test -- --run <path>` (the `--` is forwarded literally into the script's argv and vitest falls back to scanning the whole project in watch mode; confirmed repo-wide, not package-specific).
- This wave adds no table and touches no tenancy/cascade/RLS surface, so the RLS/integration contract suites (`vitest.config.rls.ts`, `vitest.integration.config.ts`) are not required reading for this wave's own correctness — still run the two guard tests named in Task 1 (`autoMigrate.test.ts`, `migrationRlsScope.test.ts`) since every migration must pass them regardless of shape.
- Branch `feature/6008-backup-provider-integration/wave-6013`; PR body contains `Closes #6013`.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Keep files under ~500 lines. `apps/api/src/services/reportGenerationService.ts` is 974 lines already and gets only a ~15-line addition (a `case` arm plus a union member) — do not refactor it in this wave. New files (`backupStatusReport.ts` × 2, `BackupStatusOptionsForm.tsx`) each stay well under 300 lines on their own.
- **`runAction` rule for web mutations:** the report-creation POST already flows through `apps/web/src/lib/runAction.ts` inside `ReportTemplates.tsx`'s existing `handleCreateDirect` — this wave adds a new template that calls that same helper with its own config payload; it does not add a new mutation call site, so no `runActionAllowlist.ts` entry is needed.
- **i18n:** every new key lands in all 8 locales (`en`, `de-DE`, `es-419`, `fr-CA`, `fr-FR`, `it-IT`, `pt-BR`, `tr-TR`) with a **real, natural translation**, never an English copy — `apps/web/src/lib/i18n/localeParity.test.ts` fails on a missing key or a mismatched interpolation/rich-text-tag set, and `apps/web/src/lib/i18n/translationCoverage.test.ts` caps exact-English-duplicate leaves per namespace (`namespaceDuplicateBaselines`). This plan's translations introduce zero new exact-English duplicates (verified word-for-word below against each locale's existing `reports.json` phrasing for `lifecycleOptions`/`postureOptions`), so no baseline bump is expected — Task 11's last step still runs the coverage test and instructs how to bump a baseline with a comment if one is unexpectedly needed, rather than assuming.
- Every `t()` call in new/modified web code must resolve to a literal (statically extractable) key, or be annotated `/* i18n-dynamic */` immediately before a computed key — both patterns are already used throughout `ReportTemplates.tsx` and are followed unchanged here.
- **DECISION (naming):** the PDF renderer's own test file is named `reportPdf.backupStatus.test.ts`, not `backupStatusReport.test.ts` — this mirrors the established sibling-test convention for this exact kind of file (`hardwareLifecyclePdf.ts` is tested only through `reportPdf.hardwareLifecycle.test.ts`, exercising it via the public `buildReportPdf` dispatcher rather than importing the renderer directly; there is no `hardwareLifecyclePdf.test.ts`). CLAUDE.md's "place tests alongside source" is satisfied either way (same directory); this plan follows the more specific, already-established precedent for this file family over a literal reading of "co-located with `backupStatusReport.ts`."

## File structure

| Path | Responsibility |
|---|---|
| `apps/api/migrations/2026-10-17-120100-backup-status-report-type.sql` | `ALTER TYPE report_type ADD VALUE 'backup_status'` |
| `apps/api/src/db/schema/reports.ts` | add `'backup_status'` to `reportTypeEnum` |
| `apps/api/src/routes/reports/schemas.ts` | `reportTypeSchema` + `backupStatusReportConfigSchema`/`Fields`, wired into `reportConfigFields` and `generateReportSchema` |
| `apps/api/src/routes/reports/schemas.config.test.ts` | persistence/generation field-parity test + create/update round-trip tests for the new config keys |
| `packages/shared/src/types/backupStatusReport.ts` (new) | `BackupStatusBucket` (over W01's shared `BackupStatusBucketId`), `BackupRecencyBucket`, `BackupStatusReportOptions`, `BackupStatusReportData` |
| `packages/shared/src/types/index.ts` | barrel export for the new type module |
| `apps/api/src/services/backupStatusReport.ts` (new) | `generateBackupStatusReport` — pages the W03 read model, buckets, sorts unhealthy-first, projects a flat CSV row |
| `apps/api/src/services/backupStatusReport.test.ts` (new) | unit coverage for the builder above |
| `apps/api/src/services/reportGenerationService.ts` | `ReportType` union + one `case` in `dispatchReportGeneration`'s switch + one `case` in `zeroSafeReport`'s switch |
| `apps/api/src/services/reportGenerationService.test.ts` | `REPORT_TYPES` drift-guard array gains `'backup_status'` |
| `packages/shared/src/reportPdf/backupStatusReport.ts` (new) | `renderBackupStatusReport` — bucket bars, device table, 28-day cell strip |
| `packages/shared/src/reportPdf/reportPdf.backupStatus.test.ts` (new) | renders the new type through `buildReportPdf` |
| `packages/shared/src/reportPdf/reportPdf.ts` | `BuildOpts.summary` union, `REPORT_TYPE_LABELS`, one dispatch arm |
| `apps/web/src/components/reports/ReportsList.tsx` | `ReportType` union gains `'backup_status'` |
| `apps/web/src/components/reports/ReportBuilder.tsx` | `legacyToBuilderType` gains a `backup_status` entry |
| `apps/web/src/components/reports/BackupStatusOptionsForm.tsx` (new) | curated options form (mirrors `HardwareLifecycleOptionsForm.tsx`) |
| `apps/web/src/components/reports/BackupStatusOptionsForm.test.tsx` (new) | `backupStatusOptionsFromConfig` unit coverage |
| `apps/web/src/components/reports/ReportTemplates.tsx` | new template card, modal, `handleUseTemplate` branch |
| `apps/web/src/components/reports/ReportTemplates.backupStatus.test.tsx` (new) | create-report flow through the new template |
| `apps/web/src/components/reports/ReportEditPage.tsx` | `isBackupStatus` branch, mirrors `isLifecycle` |
| `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/reports.json` | new keys, real translations in all 8 |

---

### Task 1: `backup_status` report-type enum value

**Files:**
- Create: `apps/api/migrations/2026-10-17-120100-backup-status-report-type.sql`
- Modify: `apps/api/src/db/schema/reports.ts:22-40` (`reportTypeEnum`)

**Interfaces:**
- Consumes: nothing.
- Produces: enum label `report_type = 'backup_status'`; Drizzle `reportTypeEnum.enumValues` includes `'backup_status'`.

- [ ] **Step 1: Write the migration**

```sql
-- Backup Provider Integration W05 (spec
-- docs/superpowers/specs/integrations/2026-09-15-backup-provider-integration-cove-design.md
-- D6 "Reports"; plan docs/superpowers/plans/integrations/
-- 2026-09-15-backup-provider-integration-w05-backup-status-report.md).
--
-- The `backup_status` report type — an org-scoped snapshot over both Breeze
-- first-party backups and connected provider devices, laid out like Cove's
-- "Backup & Recovery: All devices" email.
--
-- Enum add ONLY, in its own file: a label added by ALTER TYPE cannot be used
-- until the transaction that added it commits (precedent:
-- 2026-10-16-170400-report-type-ai-fleet-design.sql,
-- 2026-10-16-180700-report-type-hardware-lifecycle.sql). No DML, so no
-- breeze.scope election and no migrationRlsScope.test.ts baseline entry.
-- Idempotent.

ALTER TYPE report_type ADD VALUE IF NOT EXISTS 'backup_status';
```

- [ ] **Step 2: Add the Drizzle enum value**

In `apps/api/src/db/schema/reports.ts`, the `reportTypeEnum` array currently ends (lines 32-40):

```ts
  // Fleet Designer W01 (#5651): one system-managed definition per org, keyed
  // by type (see reportsAiFleetDesignOrgUniq below) rather than by schedule —
  // manual design runs have no schedule to key on.
  'ai_fleet_design',
  // Hardware Lifecycle report: device replacement plan from purchase +
  // warranty dates (ported from the LanternOps portal PDF).
  'hardware_lifecycle'
]);
```

Replace with:

```ts
  // Fleet Designer W01 (#5651): one system-managed definition per org, keyed
  // by type (see reportsAiFleetDesignOrgUniq below) rather than by schedule —
  // manual design runs have no schedule to key on.
  'ai_fleet_design',
  // Hardware Lifecycle report: device replacement plan from purchase +
  // warranty dates (ported from the LanternOps portal PDF).
  'hardware_lifecycle',
  // Backup Provider Integration W05 (#6013): the Cove-email-style snapshot
  // over both Breeze first-party backups and connected provider devices.
  // See services/backupStatusReport.ts.
  'backup_status'
]);
```

- [ ] **Step 3: Run the naming and migration guards**

Run: `scripts/check-migration-naming.sh --against-ref origin/main && cd apps/api && npx vitest run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts`
Expected: both PASS. The file writes no rows, so `migrationRlsScope.test.ts` does not flag it (nothing to flag — no `UPDATE`/`INSERT`/`DELETE`/`MERGE` statement exists in the file).

- [ ] **Step 4: Apply against the worktree test stack, twice, and verify the label landed**

Run: `pnpm test-stack up` (once for the whole wave — torn down in Task 12), then:
```bash
cd apps/api && DATABASE_URL=$(grep DATABASE_URL .env.test | cut -d= -f2-) pnpm db:migrate
DATABASE_URL=$(grep DATABASE_URL .env.test | cut -d= -f2-) pnpm db:migrate
```
Expected: the first run applies the file; the second is a no-op (the `IF NOT EXISTS` guard). Then:
```bash
docker exec -i $(docker ps --format '{{.Names}}' | grep -m1 postgres) \
  psql -U breeze -d breeze -c \
  "select enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'report_type' order by e.enumsortorder;"
```
Expected: the last row of the result is `backup_status`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/migrations/2026-10-17-120100-backup-status-report-type.sql \
        apps/api/src/db/schema/reports.ts
git commit -m "$(cat <<'EOF'
feat(reports): backup_status report type enum value (W05)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Zod config schema — `backupStatusReportConfigSchema`/`Fields`

**Files:**
- Modify: `apps/api/src/routes/reports/schemas.ts:13-31` (`reportTypeSchema`), `:99-106` (after `hardwareLifecycleConfigFields`), `:149-150` (`reportConfigFields`), `:197-198` (`generateReportSchema`)
- Modify: `apps/api/src/routes/reports/schemas.config.test.ts` (append tests)

**Interfaces:**
- Consumes: nothing new (pure Zod).
- Produces: `backupStatusReportConfigSchema` (with `.default()`s, used by `generateBackupStatusReport`), `backupStatusReportConfigFields` (without defaults, spread into persistence schemas).

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/routes/reports/schemas.config.test.ts` (add the two new names to the existing `import { ... } from './schemas';` block at the top — `backupStatusReportConfigFields, backupStatusReportConfigSchema` — and add these `it` blocks inside the existing `describe('report config schema', ...)`):

```ts
  it('keeps the backup status persistence fields in sync with the generation schema', () => {
    expect(Object.keys(backupStatusReportConfigFields).sort()).toEqual(
      Object.keys(backupStatusReportConfigSchema.shape).sort(),
    );
  });

  it('applies backup status defaults on create and round-trips overrides', () => {
    const defaulted = createReportSchema.parse({
      name: 'Backup status', type: 'backup_status', config: {},
    });
    expect(defaulted.config.includeDevicesWithoutBackup).toBe(true);
    expect(defaulted.config.sources).toEqual(['breeze', 'provider']);

    const overridden = createReportSchema.parse({
      name: 'Backup status', type: 'backup_status',
      config: { includeDevicesWithoutBackup: false, sources: ['provider'] },
    });
    expect(overridden.config.includeDevicesWithoutBackup).toBe(false);
    expect(overridden.config.sources).toEqual(['provider']);
  });

  it('rejects an empty backup status sources array', () => {
    expect(() =>
      createReportSchema.parse({
        name: 'Backup status', type: 'backup_status',
        config: { sources: [] },
      })
    ).toThrow();
  });

  it('rejects an unknown backup status source value', () => {
    expect(() =>
      createReportSchema.parse({
        name: 'Backup status', type: 'backup_status',
        config: { sources: ['carbonite'] },
      })
    ).toThrow();
  });

  it('preserves backup status config on update (was silently stripped before Task 2)', () => {
    const updated = updateReportSchema.parse({
      config: { includeDevicesWithoutBackup: false, sources: ['breeze'], sites: [] },
    });
    expect(updated.config?.includeDevicesWithoutBackup).toBe(false);
    expect(updated.config?.sources).toEqual(['breeze']);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/api && npx vitest run src/routes/reports/schemas.config.test.ts`
Expected: `backupStatusReportConfigFields`/`backupStatusReportConfigSchema` fail to import (`does not provide an export named 'backupStatusReportConfigFields'`), and `type: 'backup_status'` fails `reportTypeSchema`'s enum check inside `createReportSchema`.

- [ ] **Step 3: Add `'backup_status'` to `reportTypeSchema`**

In `apps/api/src/routes/reports/schemas.ts`, the enum currently reads (lines 13-31):

```ts
export const reportTypeSchema = z.enum([
  'device_inventory',
  'software_inventory',
  'alert_summary',
  'compliance',
  'performance',
  'executive_summary',
  'security_compliance_posture',
  // P2-3 (#4190): system-managed. Created only by the AI narrative run's own
  // transaction (`persistNarrativeReport`), never by a human, and never
  // generated on demand (`StoredArtifactOnlyReportError`).
  'ai_org_narrative',
  // Fleet Designer W01 (#5651): system-managed, same shape as
  // `ai_org_narrative` — created only by `persistFleetDesignReport` inside
  // the design run's own transaction.
  'ai_fleet_design',
  // Hardware Lifecycle: device replacement plan from purchase + warranty dates.
  'hardware_lifecycle'
]);
```

Replace with:

```ts
export const reportTypeSchema = z.enum([
  'device_inventory',
  'software_inventory',
  'alert_summary',
  'compliance',
  'performance',
  'executive_summary',
  'security_compliance_posture',
  // P2-3 (#4190): system-managed. Created only by the AI narrative run's own
  // transaction (`persistNarrativeReport`), never by a human, and never
  // generated on demand (`StoredArtifactOnlyReportError`).
  'ai_org_narrative',
  // Fleet Designer W01 (#5651): system-managed, same shape as
  // `ai_org_narrative` — created only by `persistFleetDesignReport` inside
  // the design run's own transaction.
  'ai_fleet_design',
  // Hardware Lifecycle: device replacement plan from purchase + warranty dates.
  'hardware_lifecycle',
  // Backup Provider Integration W05 (#6013): Cove-email-style backup status
  // snapshot over both first-party and provider devices.
  'backup_status'
]);
```

- [ ] **Step 4: Add `backupStatusReportConfigSchema`/`Fields`**

Immediately after `hardwareLifecycleConfigFields` (currently lines 99-105):

```ts
export const hardwareLifecycleConfigFields = {
  sites: z.array(z.string().guid()).optional(),
  replaceAgeYears: z.number().int().min(1).max(15).optional(),
  serverReplaceAgeYears: z.number().int().min(1).max(15).optional(),
  includeManualAssets: z.boolean().optional(),
  includeOtherEquipment: z.boolean().optional(),
};
```

insert:

```ts

/**
 * Config for the Backup status report (Cove email layout, W05). `sites`
 * follows the same whole-report site-scope convention as
 * `hardwareLifecycleConfigSchema`/`securityCompliancePostureConfigSchema` —
 * it feeds `assertRequestedScopeWithinAuthority`'s generic `config.sites`
 * check (`services/reportGenerationService.ts`) for free, with no
 * backup-status-specific code needed there.
 *
 * `includeDevicesWithoutBackup` DEFAULTS TRUE — unlike the web overview's
 * default `onlyWithBackup: true` filter (spec's Unified read model section),
 * this report exists to mirror Cove's "All devices" email and to surface
 * coverage GAPS, so a device with no backup evidence at all is the finding
 * the report is FOR, not noise to hide by default. DECISION (not in spec).
 *
 * `sources` defaults to both and requires at least one — an empty selection
 * would silently produce a report with zero rows and no useful reason why.
 */
export const backupStatusReportConfigSchema = z.object({
  sites: z.array(z.string().guid()).optional().default([]),
  includeDevicesWithoutBackup: z.boolean().optional().default(true),
  sources: z.array(z.enum(['breeze', 'provider'])).min(1).optional().default(['breeze', 'provider']),
});

/** Same keys as `backupStatusReportConfigSchema` without `.default()`s — see
 *  `securityCompliancePostureConfigFields` for why the two lists are
 *  hand-parallel and test-pinned. */
export const backupStatusReportConfigFields = {
  sites: z.array(z.string().guid()).optional(),
  includeDevicesWithoutBackup: z.boolean().optional(),
  sources: z.array(z.enum(['breeze', 'provider'])).min(1).optional(),
};
```

- [ ] **Step 5: Wire the fields into `reportConfigFields` and `generateReportSchema`**

In `reportConfigFields` (currently lines 148-151):

```ts
  ...securityCompliancePostureConfigFields,
  ...hardwareLifecycleConfigFields
};
```

Replace with:

```ts
  ...securityCompliancePostureConfigFields,
  ...hardwareLifecycleConfigFields,
  ...backupStatusReportConfigFields
};
```

In `generateReportSchema`'s inline `config` object (currently lines 196-199):

```ts
    ...securityCompliancePostureConfigFields,
    ...hardwareLifecycleConfigFields
  }).optional().default({}),
```

Replace with:

```ts
    ...securityCompliancePostureConfigFields,
    ...hardwareLifecycleConfigFields,
    ...backupStatusReportConfigFields
  }).optional().default({}),
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd apps/api && npx vitest run src/routes/reports/schemas.config.test.ts`
Expected: all PASS, including the pre-existing posture/lifecycle tests in the same file (unmodified).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/reports/schemas.ts apps/api/src/routes/reports/schemas.config.test.ts
git commit -m "$(cat <<'EOF'
feat(reports): backup status report config schema (W05)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Shared types — `BackupStatusReportData`

**Files:**
- Create: `packages/shared/src/types/backupStatusReport.ts`
- Modify: `packages/shared/src/types/index.ts:847` (barrel export, after `export * from './hardwareLifecycleReport';`)

**Interfaces:**
- Consumes: `packages/shared/src/types/backupHealth.ts` (W01) — `type BackupHealthRow`, `type BackupHealthSummary`, `type BackupRecency`, `type BackupStatusBucketId` (the shared six-bucket grouping — see the plan header's Cross-wave names update).
- Produces (verbatim names, consumed by Tasks 4 and 6): `type BackupStatusBucket`, `type BackupRecencyBucket`, `type BackupStatusReportOptions`, `type BackupStatusReportData`.

This is a pure, declarative type file (no runtime behavior) — per CLAUDE.md's carve-out for declarative files, and matching the precedent that `packages/shared/src/types/hardwareLifecycleReport.ts` has no co-located test of its own (only the API-side generator and the PDF renderer that consume it are tested). Tasks 4 and 6 exercise every field transitively.

- [ ] **Step 1: Write the type file**

Create `packages/shared/src/types/backupStatusReport.ts`:

```ts
/**
 * Backup status report (Cove email layout) — Backup Provider Integration W05.
 * Persisted `report_runs.result.summary` shape for the `backup_status` report
 * type: an org-scoped, as-of snapshot over the unified backup health read
 * model (`apps/api/src/services/backupHealthReadModel.ts`, W03) plus the
 * bucket groupings the Cove "Backup & Recovery: All devices" email shows.
 *
 * Single-sourced like `HardwareLifecycleSummary` / `PostureSummary`: the API
 * produces this with `satisfies`, the shared PDF renderer consumes it, and
 * every field must survive a JSON round-trip through `report_runs.result`.
 */
import type { BackupHealthRow, BackupHealthSummary, BackupRecency, BackupStatusBucketId } from './backupHealth';

/**
 * The six buckets `bucketForBackupStatus` (W01, `./backupHealth`) sorts every
 * `ExternalBackupStatus` into — the same shared mapping the W03 web overview
 * uses for its own status bar, so this report and the overview can never
 * disagree about where a status lands: `no_backups`, `completed`,
 * `completed_with_errors`, `in_progress`, `unsuccessful` (`failed` +
 * `over_quota` + `no_selection` + `interrupted`), `other` (`not_started` +
 * `unknown`). `other` is the catch-all for the two statuses the spec's Web UI
 * section's five named buckets don't mention by name; see
 * `buildStatusBuckets` (Task 4) for why it is rendered only when non-zero,
 * unlike the other five.
 */
export type BackupStatusBucket = {
  key: BackupStatusBucketId;
  count: number;
  /** Percentage of the report's total row count, rounded to one decimal. */
  pct: number;
};

export type BackupRecencyBucket = {
  key: BackupRecency;
  count: number;
  pct: number;
};

export type BackupStatusReportOptions = {
  /** Default true — see `backupStatusReportConfigSchema`
   *  (`apps/api/src/routes/reports/schemas.ts`) for why this report's default
   *  differs from the web overview's `onlyWithBackup: true` default. */
  includeDevicesWithoutBackup: boolean;
  sources: Array<'breeze' | 'provider'>;
};

export type BackupStatusReportData = {
  org: { id: string; name: string };
  /** ISO timestamp the snapshot (rows + summary) was read at. Equal to
   *  `generatedAt` in phase 1 — kept as its own field because a future
   *  cached/scheduled variant may render later than it reads. */
  asOf: string;
  generatedAt: string;
  summary: BackupHealthSummary;
  statusBuckets: BackupStatusBucket[];
  recencyBuckets: BackupRecencyBucket[];
  /** Every row in scope, sorted unhealthy-first (critical, warning, unknown,
   *  healthy; ties broken by `EXTERNAL_BACKUP_STATUS_SEVERITY`, then name —
   *  see `sortUnhealthyFirst` in `apps/api/src/services/backupStatusReport.ts`). */
  rows: BackupHealthRow[];
  options: BackupStatusReportOptions;
};
```

- [ ] **Step 2: Wire the barrel export**

In `packages/shared/src/types/index.ts`, immediately after (currently lines 841-847):

```ts
// ============================================
// Security & Compliance Posture Report
// ============================================

export * from './postureReport';
export * from './executiveSummaryReport';
export * from './hardwareLifecycleReport';
```

insert:

```ts

// ============================================
// Backup Status Report (Backup Provider Integration W05)
// ============================================

export * from './backupStatusReport';
```

- [ ] **Step 3: Verify it compiles and is reachable from `@breeze/shared`**

Run: `cd packages/shared && npx tsc --noEmit`
Expected: no errors. This also transitively verifies `./backupHealth` (W01) already exports `BackupHealthRow`/`BackupHealthSummary`/`BackupRecency` by the time this task runs (W05 depends on W03, which depends on W01 — both already merged).

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/types/backupStatusReport.ts packages/shared/src/types/index.ts
git commit -m "$(cat <<'EOF'
feat(shared): BackupStatusReportData type (W05)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: API data builder — `generateBackupStatusReport`

**Files:**
- Create: `apps/api/src/services/backupStatusReport.ts`
- Test: `apps/api/src/services/backupStatusReport.test.ts`

**Interfaces:**
- Consumes: `backupStatusReportConfigSchema` (Task 2), `BackupStatusReportData`/`BackupStatusBucket`/`BackupRecencyBucket`/`BackupStatusReportOptions` (Task 3, via `@breeze/shared`), `EXTERNAL_BACKUP_STATUSES`/`EXTERNAL_BACKUP_STATUS_SEVERITY`/`BACKUP_STATUS_BUCKET_IDS`/`bucketForBackupStatus`/`type BackupStatusBucketId`/`type ExternalBackupStatus`/`type BackupHealth`/`type BackupHealthRow`/`type BackupHealthSummary`/`type BackupRecency` (W01, via `@breeze/shared` — `BACKUP_STATUS_BUCKET_IDS`/`bucketForBackupStatus`/`BackupStatusBucketId` are the shared status-bucket contract added after this plan's first draft; see the plan header's Cross-wave names note), `listBackupHealthRows`/`summarizeBackupHealth` (W03, `./backupHealthReadModel`), `assertReportExecutionPreflight`/`type ReportResult` (`./reportGenerationService`, existing — read at `apps/api/src/services/reportGenerationService.ts:71-81` for `ReportResult`, `:255-268` for `assertReportExecutionPreflight`), `type ReportExecutionAuthority` (`./siteScope`, existing — the exact import path `hardwareLifecycleReport.ts:57` already uses), `organizations` table (`../db/schema`, existing), `db` (`../db`, existing).
- Produces (verbatim name, consumed by Task 5): `generateBackupStatusReport(orgId: string, rawConfig: Record<string, unknown>, authority: ReportExecutionAuthority): Promise<ReportResult>`.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/services/backupStatusReport.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Two independent mocks: `db` for the org-name lookup (Drizzle chain, same
// pattern as hardwareLifecycleReport.test.ts), and `./backupHealthReadModel`
// for the W03 read model itself — mocking the read model directly (rather
// than trying to guess its internal query shape) keeps this test correct
// regardless of how W03 implements `listBackupHealthRows`/`summarizeBackupHealth`.
vi.mock('../db', () => ({
  db: { select: vi.fn() },
}));

vi.mock('./backupHealthReadModel', () => ({
  listBackupHealthRows: vi.fn(),
  summarizeBackupHealth: vi.fn(),
}));

import { db } from '../db';
import { listBackupHealthRows, summarizeBackupHealth } from './backupHealthReadModel';
import { generateBackupStatusReport } from './backupStatusReport';
import type { ReportExecutionAuthority } from './siteScope';
import type { ReportResult } from './reportGenerationService';
import type { BackupHealthRow, BackupHealthSummary, BackupStatusReportData } from '@breeze/shared';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const SITE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SITE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function authority(
  kind: 'unrestricted' | 'restricted' = 'unrestricted',
  siteIds: string[] = [],
): ReportExecutionAuthority {
  return {
    principalKind: 'user',
    scope: kind === 'restricted'
      ? { version: 1, kind, orgId: ORG_ID, siteIds }
      : { version: 1, kind, orgId: ORG_ID },
    principalUserId: USER_ID,
    capturedAt: new Date('2026-09-15T12:00:00.000Z'),
    fingerprint: kind === 'restricted' ? 'a'.repeat(64) : 'f'.repeat(64),
  };
}

function queueOrgSelect(rows: unknown[]) {
  vi.mocked(db.select).mockImplementation((() => {
    const chain: Record<string, unknown> = {};
    for (const method of ['from', 'where', 'limit']) chain[method] = () => chain;
    (chain as { then?: unknown }).then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve);
    return chain;
  }) as never);
}

function row(overrides: Partial<BackupHealthRow> = {}): BackupHealthRow {
  return {
    key: 'breeze:d1',
    source: 'breeze',
    providerKey: null,
    providerLabel: null,
    orgId: ORG_ID,
    orgName: 'Acme Legal',
    siteId: null,
    deviceId: 'd1',
    name: 'WKS-1',
    computerName: 'WKS-1',
    osType: 'workstation',
    accountType: 'endpoint',
    status: 'completed',
    health: 'healthy',
    recency: 'under_24h',
    covered: true,
    stale: false,
    lastSuccessAt: '2026-09-15T02:00:00.000Z',
    lastSessionAt: '2026-09-15T02:00:00.000Z',
    selectedBytes: 1000,
    usedBytes: 900,
    errorsCount: 0,
    dataSources: ['files'],
    history28d: [],
    agentOnline: true,
    ...overrides,
  } as BackupHealthRow;
}

function summary(overrides: Partial<BackupHealthSummary> = {}): BackupHealthSummary {
  return {
    endpoints: { total: 1, covered: 1, uncovered: 0 },
    providerOnly: 0,
    m365Accounts: 0,
    byStatus: {
      completed: 1, completed_with_errors: 0, failed: 0, in_progress: 0,
      interrupted: 0, over_quota: 0, no_selection: 0, not_started: 0,
      no_backups: 0, unknown: 0,
    },
    byHealth: { healthy: 1, warning: 0, critical: 0, unknown: 0 },
    byRecency: { under_24h: 1, under_48h: 0, over_48h: 0, never: 0 },
    ...overrides,
  } as BackupHealthSummary;
}

function summaryOf(result: ReportResult): BackupStatusReportData {
  return result.summary as BackupStatusReportData;
}

describe('generateBackupStatusReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('pages through the read model until nextCursor is null and sorts unhealthy first', async () => {
    queueOrgSelect([{ id: ORG_ID, name: 'Acme Legal' }]);
    const healthy = row({ key: 'breeze:d1', name: 'WKS-1', status: 'completed', health: 'healthy', recency: 'under_24h' });
    const critical = row({ key: 'provider:p1', source: 'provider', name: 'SRV-1', status: 'failed', health: 'critical', recency: 'over_48h', covered: false });
    vi.mocked(listBackupHealthRows)
      .mockResolvedValueOnce({ rows: [healthy], nextCursor: 'cursor-1' })
      .mockResolvedValueOnce({ rows: [critical], nextCursor: null });
    vi.mocked(summarizeBackupHealth).mockResolvedValue(summary({ endpoints: { total: 2, covered: 1, uncovered: 1 } }));

    const result = await generateBackupStatusReport(ORG_ID, {}, authority('unrestricted'));

    expect(listBackupHealthRows).toHaveBeenCalledTimes(2);
    expect(vi.mocked(listBackupHealthRows).mock.calls[1]![1]).toMatchObject({ page: { limit: 500, cursor: 'cursor-1' } });
    const data = summaryOf(result);
    expect(data.rows.map((r) => r.key)).toEqual(['provider:p1', 'breeze:d1']);
    expect(data.org).toEqual({ id: ORG_ID, name: 'Acme Legal' });
  });

  it('buckets statuses using the shared bucketForBackupStatus mapping, folding not_started and unknown into "other"', async () => {
    queueOrgSelect([{ id: ORG_ID, name: 'Acme Legal' }]);
    const rows = [
      row({ key: 'a', status: 'not_started' }),
      row({ key: 'b', status: 'no_backups' }),
      row({ key: 'c', status: 'unknown' }),
      row({ key: 'd', status: 'failed' }),
    ];
    vi.mocked(listBackupHealthRows).mockResolvedValueOnce({ rows, nextCursor: null });
    vi.mocked(summarizeBackupHealth).mockResolvedValue(summary());

    const result = await generateBackupStatusReport(ORG_ID, {}, authority('unrestricted'));

    const buckets = summaryOf(result).statusBuckets;
    expect(buckets.find((b) => b.key === 'no_backups')!.count).toBe(1);
    expect(buckets.find((b) => b.key === 'unsuccessful')!.count).toBe(1);
    expect(buckets.find((b) => b.key === 'other')!.count).toBe(2); // not_started + unknown
    expect(buckets.map((b) => b.key)).toEqual(['no_backups', 'completed', 'completed_with_errors', 'in_progress', 'unsuccessful', 'other']);
  });

  it('omits the "other" bucket entirely when its count is zero, unlike the other five buckets which always appear', async () => {
    queueOrgSelect([{ id: ORG_ID, name: 'Acme Legal' }]);
    const rows = [row({ key: 'a', status: 'completed' }), row({ key: 'b', status: 'failed' })];
    vi.mocked(listBackupHealthRows).mockResolvedValueOnce({ rows, nextCursor: null });
    vi.mocked(summarizeBackupHealth).mockResolvedValue(summary());

    const result = await generateBackupStatusReport(ORG_ID, {}, authority('unrestricted'));

    const buckets = summaryOf(result).statusBuckets;
    expect(buckets.map((b) => b.key)).toEqual(['no_backups', 'completed', 'completed_with_errors', 'in_progress', 'unsuccessful']);
    expect(buckets.some((b) => b.key === 'other')).toBe(false);
    // The always-present buckets appear at count 0 too — only "other" is special-cased.
    expect(buckets.find((b) => b.key === 'no_backups')!.count).toBe(0);
  });

  it('computes bucket percentages rounded to one decimal', async () => {
    queueOrgSelect([{ id: ORG_ID, name: 'Acme Legal' }]);
    const rows = [row({ key: 'a', status: 'completed' }), row({ key: 'b', status: 'completed' }), row({ key: 'c', status: 'failed' })];
    vi.mocked(listBackupHealthRows).mockResolvedValueOnce({ rows, nextCursor: null });
    vi.mocked(summarizeBackupHealth).mockResolvedValue(summary());

    const result = await generateBackupStatusReport(ORG_ID, {}, authority('unrestricted'));

    const completed = summaryOf(result).statusBuckets.find((b) => b.key === 'completed')!;
    expect(completed.count).toBe(2);
    expect(completed.pct).toBeCloseTo(66.7, 1);
  });

  it('buckets recency in the spec’s literal display order and counts correctly', async () => {
    queueOrgSelect([{ id: ORG_ID, name: 'Acme Legal' }]);
    const rows = [
      row({ key: 'a', recency: 'never' }),
      row({ key: 'b', recency: 'under_24h' }),
      row({ key: 'c', recency: 'under_48h' }),
      row({ key: 'd', recency: 'over_48h' }),
      row({ key: 'e', recency: 'over_48h' }),
    ];
    vi.mocked(listBackupHealthRows).mockResolvedValueOnce({ rows, nextCursor: null });
    vi.mocked(summarizeBackupHealth).mockResolvedValue(summary());

    const result = await generateBackupStatusReport(ORG_ID, {}, authority('unrestricted'));

    const buckets = summaryOf(result).recencyBuckets;
    expect(buckets.map((b) => b.key)).toEqual(['never', 'under_24h', 'under_48h', 'over_48h']);
    expect(buckets.find((b) => b.key === 'over_48h')!.count).toBe(2);
  });

  it('defaults includeDevicesWithoutBackup to true and passes onlyWithBackup: false to the read model', async () => {
    queueOrgSelect([{ id: ORG_ID, name: 'Acme Legal' }]);
    vi.mocked(listBackupHealthRows).mockResolvedValueOnce({ rows: [], nextCursor: null });
    vi.mocked(summarizeBackupHealth).mockResolvedValue(summary({ endpoints: { total: 0, covered: 0, uncovered: 0 } }));

    await generateBackupStatusReport(ORG_ID, {}, authority('unrestricted'));

    expect(vi.mocked(listBackupHealthRows).mock.calls[0]![1]).toMatchObject({ onlyWithBackup: false, sources: ['breeze', 'provider'] });
  });

  it('includeDevicesWithoutBackup: false sends onlyWithBackup: true, and a narrowed sources list forwards verbatim', async () => {
    queueOrgSelect([{ id: ORG_ID, name: 'Acme Legal' }]);
    vi.mocked(listBackupHealthRows).mockResolvedValueOnce({ rows: [], nextCursor: null });
    vi.mocked(summarizeBackupHealth).mockResolvedValue(summary({ endpoints: { total: 0, covered: 0, uncovered: 0 } }));

    await generateBackupStatusReport(ORG_ID, { includeDevicesWithoutBackup: false, sources: ['provider'] }, authority('unrestricted'));

    expect(vi.mocked(listBackupHealthRows).mock.calls[0]![1]).toMatchObject({ onlyWithBackup: true, sources: ['provider'] });
  });

  it('an empty restrictedScope.siteIds short-circuits without querying the read model or the database', async () => {
    const result = await generateBackupStatusReport(ORG_ID, {}, authority('restricted', []));

    expect(db.select).not.toHaveBeenCalled();
    expect(listBackupHealthRows).not.toHaveBeenCalled();
    expect(summarizeBackupHealth).not.toHaveBeenCalled();
    expect(result.rows).toEqual([]);
    expect(result.rowCount).toBe(0);
    expect(summaryOf(result).org).toEqual({ id: ORG_ID, name: '' });
    expect(summaryOf(result).statusBuckets.every((b) => b.count === 0)).toBe(true);
    // "other" is omitted at count 0 even in the empty-scope shortcut.
    expect(summaryOf(result).statusBuckets.map((b) => b.key)).toEqual(['no_backups', 'completed', 'completed_with_errors', 'in_progress', 'unsuccessful']);
    expect(summaryOf(result).recencyBuckets.every((b) => b.count === 0)).toBe(true);
    expect(summaryOf(result).summary.endpoints).toEqual({ total: 0, covered: 0, uncovered: 0 });
  });

  it('a restricted scope with sites forwards restrictedScope.siteIds to the read model when config.sites is empty', async () => {
    queueOrgSelect([{ id: ORG_ID, name: 'Acme Legal' }]);
    vi.mocked(listBackupHealthRows).mockResolvedValueOnce({ rows: [], nextCursor: null });
    vi.mocked(summarizeBackupHealth).mockResolvedValue(summary({ endpoints: { total: 0, covered: 0, uncovered: 0 } }));

    await generateBackupStatusReport(ORG_ID, {}, authority('restricted', [SITE_A]));

    expect(vi.mocked(listBackupHealthRows).mock.calls[0]![0]).toEqual({ orgIds: [ORG_ID], siteIds: [SITE_A] });
  });

  it('config.sites overrides the authority site restriction when explicitly narrower', async () => {
    queueOrgSelect([{ id: ORG_ID, name: 'Acme Legal' }]);
    vi.mocked(listBackupHealthRows).mockResolvedValueOnce({ rows: [], nextCursor: null });
    vi.mocked(summarizeBackupHealth).mockResolvedValue(summary({ endpoints: { total: 0, covered: 0, uncovered: 0 } }));

    await generateBackupStatusReport(ORG_ID, { sites: [SITE_B] }, authority('restricted', [SITE_A, SITE_B]));

    expect(vi.mocked(listBackupHealthRows).mock.calls[0]![0]).toEqual({ orgIds: [ORG_ID], siteIds: [SITE_B] });
  });

  it('an unrestricted authority with no config.sites omits siteIds entirely', async () => {
    queueOrgSelect([{ id: ORG_ID, name: 'Acme Legal' }]);
    vi.mocked(listBackupHealthRows).mockResolvedValueOnce({ rows: [], nextCursor: null });
    vi.mocked(summarizeBackupHealth).mockResolvedValue(summary({ endpoints: { total: 0, covered: 0, uncovered: 0 } }));

    await generateBackupStatusReport(ORG_ID, {}, authority('unrestricted'));

    expect(vi.mocked(listBackupHealthRows).mock.calls[0]![0]).toEqual({ orgIds: [ORG_ID] });
  });

  it('projects a flat, spreadsheet-safe row for ReportResult.rows — dataSources joined, history28d omitted', async () => {
    queueOrgSelect([{ id: ORG_ID, name: 'Acme Legal' }]);
    const r = row({ key: 'a', dataSources: ['files', 'mssql'], history28d: [{ day: '2026-09-14', status: 'completed' }] });
    vi.mocked(listBackupHealthRows).mockResolvedValueOnce({ rows: [r], nextCursor: null });
    vi.mocked(summarizeBackupHealth).mockResolvedValue(summary());

    const result = await generateBackupStatusReport(ORG_ID, {}, authority('unrestricted'));

    expect(result.rows).toEqual([
      expect.objectContaining({ dataSources: 'files; mssql', device: 'WKS-1' }),
    ]);
    expect(Object.keys(result.rows![0] as object)).not.toContain('history28d');
  });

  it('caps pagination at MAX_ROWS instead of looping forever on a read model that never stops', async () => {
    queueOrgSelect([{ id: ORG_ID, name: 'Acme Legal' }]);
    vi.mocked(listBackupHealthRows).mockImplementation(async () => ({
      rows: [row({ key: `x-${Math.random()}` })],
      nextCursor: 'always-more',
    }));
    vi.mocked(summarizeBackupHealth).mockResolvedValue(summary());

    const result = await generateBackupStatusReport(ORG_ID, {}, authority('unrestricted'));

    expect(summaryOf(result).rows.length).toBeLessThanOrEqual(20_000);
    expect(vi.mocked(listBackupHealthRows).mock.calls.length).toBeLessThan(45); // ceil(20000/500) + 1
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/api && npx vitest run src/services/backupStatusReport.test.ts`
Expected: `Cannot find module './backupStatusReport'` (the file doesn't exist yet).

- [ ] **Step 3: Write the minimal implementation**

Create `apps/api/src/services/backupStatusReport.ts`:

```ts
/**
 * Backup status report (Cove email layout) — Backup Provider Integration W05.
 *
 * Org-scoped, as-of snapshot over BOTH backup sources (Breeze first-party
 * jobs and linked/unlinked provider devices), laid out like Cove's own daily
 * "Backup & Recovery: All devices" email: status buckets, last-successful-
 * backup recency buckets, and a device table ordered unhealthy-first. Built
 * entirely from `backupHealthReadModel.ts` (W03) — this file adds no new
 * queries of its own beyond the org's display name, and derives nothing
 * `deriveBackupHealth` (W01) hasn't already computed onto each row.
 *
 * Managed-evidence registry registration (the deliverables-track hookup that
 * would let this report be scheduled as service-plan evidence) is explicitly
 * OUT of scope for this wave — see the spec's Reports section, last sentence.
 */
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { organizations } from '../db/schema';
import { backupStatusReportConfigSchema } from '../routes/reports/schemas';
import {
  BACKUP_STATUS_BUCKET_IDS,
  bucketForBackupStatus,
  EXTERNAL_BACKUP_STATUSES,
  EXTERNAL_BACKUP_STATUS_SEVERITY,
  type BackupHealth,
  type BackupHealthRow,
  type BackupHealthSummary,
  type BackupRecency,
  type BackupRecencyBucket,
  type BackupStatusBucket,
  type BackupStatusBucketId,
  type BackupStatusReportData,
  type BackupStatusReportOptions,
  type ExternalBackupStatus,
} from '@breeze/shared';
import { listBackupHealthRows, summarizeBackupHealth } from './backupHealthReadModel';
import { assertReportExecutionPreflight, type ReportResult } from './reportGenerationService';
import type { ReportExecutionAuthority } from './siteScope';

/** One page of `listBackupHealthRows` at a time; a full-org snapshot report
 *  reads every row, never just one page for a UI. */
const PAGE_SIZE = 500;
/** Safety valve, not an expected path — an org's device + provider-device
 *  count is bounded well under this in phase 1. Stops a runaway loop rather
 *  than silently truncating without saying so. */
const MAX_ROWS = 20_000;

/**
 * "Unhealthy first" (the spec's Cove-email ordering) — primary by health
 * bucket (critical, then warning, then unknown, then healthy), secondary by
 * the underlying status's severity (`EXTERNAL_BACKUP_STATUS_SEVERITY`,
 * higher = worse, W01), tertiary by name for a stable, readable order.
 */
const HEALTH_SORT_WEIGHT: Record<BackupHealth, number> = {
  critical: 0,
  warning: 1,
  unknown: 2,
  healthy: 3,
};

/** Spec's literal display order ("never / < 24 h / < 48 h / > 48 h") — not
 *  severity-monotonic (a device with NO evidence is arguably worse than one
 *  with 40-hour-old evidence), but this is the order the spec's Web UI
 *  section gives for the sibling bucket bar, and this report mirrors it
 *  verbatim so the two surfaces read the same way. */
const RECENCY_BUCKET_ORDER: BackupRecency[] = ['never', 'under_24h', 'under_48h', 'over_48h'];

const BACKUP_HEALTH_VALUES: BackupHealth[] = ['healthy', 'warning', 'critical', 'unknown'];
const BACKUP_RECENCY_VALUES: BackupRecency[] = ['under_24h', 'under_48h', 'over_48h', 'never'];

function pct(count: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((count / total) * 1000) / 10;
}

/**
 * Status-bucket grouping is a SHARED contract, not a local fold: W01's
 * `bucketForBackupStatus` (`@breeze/shared`) sorts every `ExternalBackupStatus`
 * into one of `BACKUP_STATUS_BUCKET_IDS` — `no_backups`, `completed`,
 * `completed_with_errors`, `in_progress`, `unsuccessful` (`failed` +
 * `over_quota` + `no_selection` + `interrupted`), `other` (`not_started` +
 * `unknown`) — and the W03 web overview uses the exact same mapping for its
 * own status bar, so this report and the overview can never disagree about
 * where a status lands. (This plan's first draft defined an equivalent local
 * fold here under the DECISION that no shared helper existed yet at W05
 * plan-authoring time — it does now, per the coordinator's follow-up, and
 * this file imports it instead of re-deriving it.)
 *
 * `other` is the catch-all for the two statuses the spec's Web UI section's
 * five NAMED buckets don't mention (`not_started`, `unknown`) — this function
 * renders it only when its count is non-zero, the same rule the overview
 * applies, so an org with no `other`-bucketed device never shows an empty,
 * unfamiliar sixth segment next to Cove's own five.
 */
function buildStatusBuckets(rows: BackupHealthRow[]): BackupStatusBucket[] {
  const counts: Record<BackupStatusBucketId, number> = {
    no_backups: 0,
    completed: 0,
    completed_with_errors: 0,
    in_progress: 0,
    unsuccessful: 0,
    other: 0,
  };
  for (const row of rows) counts[bucketForBackupStatus(row.status)] += 1;
  const total = rows.length;
  return BACKUP_STATUS_BUCKET_IDS
    .filter((key) => key !== 'other' || counts[key] > 0)
    .map((key) => ({ key, count: counts[key], pct: pct(counts[key], total) }));
}

function buildRecencyBuckets(rows: BackupHealthRow[]): BackupRecencyBucket[] {
  const counts: Record<BackupRecency, number> = { never: 0, under_24h: 0, under_48h: 0, over_48h: 0 };
  for (const row of rows) counts[row.recency] += 1;
  const total = rows.length;
  return RECENCY_BUCKET_ORDER.map((key) => ({ key, count: counts[key], pct: pct(counts[key], total) }));
}

function sortUnhealthyFirst(rows: BackupHealthRow[]): BackupHealthRow[] {
  return [...rows].sort((a, b) => {
    const healthDiff = HEALTH_SORT_WEIGHT[a.health] - HEALTH_SORT_WEIGHT[b.health];
    if (healthDiff !== 0) return healthDiff;
    const severityDiff = EXTERNAL_BACKUP_STATUS_SEVERITY[b.status] - EXTERNAL_BACKUP_STATUS_SEVERITY[a.status];
    if (severityDiff !== 0) return severityDiff;
    return a.name.localeCompare(b.name);
  });
}

/** Flat, CSV/Excel-safe projection of a `BackupHealthRow` for
 *  `ReportResult.rows` (the generic `extractTable`/`rowsToCsv` export path,
 *  `apps/web/src/components/reports/reportExport.ts`) — distinct from
 *  `summary.rows`, which keeps the FULL row (incl. `history28d`, an array of
 *  objects `Object.keys` would dump as "[object Object]" in a spreadsheet).
 *  `hardwareLifecycleReport.ts` returns the same flat rows both top-level and
 *  nested in `summary.rows` because its row shape has no such fields; here
 *  the two genuinely differ. */
function toCsvRow(row: BackupHealthRow): Record<string, string | number | boolean | null> {
  return {
    device: row.name,
    computerName: row.computerName,
    organization: row.orgName,
    source: row.source,
    provider: row.providerLabel,
    deviceType: row.osType,
    accountType: row.accountType,
    status: row.status,
    health: row.health,
    recency: row.recency,
    covered: row.covered,
    lastSuccessAt: row.lastSuccessAt,
    selectedBytes: row.selectedBytes,
    usedBytes: row.usedBytes,
    errorsCount: row.errorsCount,
    dataSources: row.dataSources.join('; '),
    agentOnline: row.agentOnline,
  };
}

function emptyByStatus(): Record<ExternalBackupStatus, number> {
  const out = {} as Record<ExternalBackupStatus, number>;
  for (const status of EXTERNAL_BACKUP_STATUSES) out[status] = 0;
  return out;
}

function emptySummary(): BackupHealthSummary {
  return {
    endpoints: { total: 0, covered: 0, uncovered: 0 },
    providerOnly: 0,
    m365Accounts: 0,
    byStatus: emptyByStatus(),
    byHealth: Object.fromEntries(BACKUP_HEALTH_VALUES.map((h) => [h, 0])) as Record<BackupHealth, number>,
    byRecency: Object.fromEntries(BACKUP_RECENCY_VALUES.map((r) => [r, 0])) as Record<BackupRecency, number>,
  };
}

function emptyData(orgId: string, generatedAt: string, options: BackupStatusReportOptions): BackupStatusReportData {
  return {
    org: { id: orgId, name: '' },
    asOf: generatedAt,
    generatedAt,
    summary: emptySummary(),
    statusBuckets: buildStatusBuckets([]),
    recencyBuckets: buildRecencyBuckets([]),
    rows: [],
    options,
  };
}

export async function generateBackupStatusReport(
  orgId: string,
  rawConfig: Record<string, unknown>,
  authority: ReportExecutionAuthority,
): Promise<ReportResult> {
  const cfg = backupStatusReportConfigSchema.parse(rawConfig ?? {});
  const generatedAt = new Date().toISOString();
  const options: BackupStatusReportOptions = {
    includeDevicesWithoutBackup: cfg.includeDevicesWithoutBackup,
    sources: cfg.sources,
  };

  assertReportExecutionPreflight(orgId, cfg, authority, 'backup_status');

  const restrictedScope = authority.scope.kind === 'restricted' ? authority.scope : null;
  if (restrictedScope && restrictedScope.siteIds.length === 0) {
    const data = emptyData(orgId, generatedAt, options);
    return { rows: [], rowCount: 0, generatedAt, summary: data };
  }

  const [orgRow] = await db
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  const siteIds = cfg.sites.length > 0 ? cfg.sites : restrictedScope ? restrictedScope.siteIds : undefined;
  const scope = { orgIds: [orgId], ...(siteIds ? { siteIds } : {}) };
  const listOpts = {
    sources: cfg.sources,
    onlyWithBackup: !cfg.includeDevicesWithoutBackup,
  };

  const allRows: BackupHealthRow[] = [];
  let cursor: string | undefined;
  let guard = 0;
  const maxPages = Math.ceil(MAX_ROWS / PAGE_SIZE) + 1;
  for (;;) {
    const page = await listBackupHealthRows(scope, { ...listOpts, page: { limit: PAGE_SIZE, cursor } });
    allRows.push(...page.rows);
    guard += 1;
    if (!page.nextCursor || allRows.length >= MAX_ROWS || guard >= maxPages) break;
    cursor = page.nextCursor;
  }

  const summary = await summarizeBackupHealth(scope, listOpts);
  const rows = sortUnhealthyFirst(allRows);

  const data: BackupStatusReportData = {
    org: { id: orgRow?.id ?? orgId, name: orgRow?.name ?? '' },
    asOf: generatedAt,
    generatedAt,
    summary,
    statusBuckets: buildStatusBuckets(rows),
    recencyBuckets: buildRecencyBuckets(rows),
    rows,
    options,
  };

  const csvRows = rows.map(toCsvRow);
  return { rows: csvRows, rowCount: csvRows.length, generatedAt, summary: data };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/api && npx vitest run src/services/backupStatusReport.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/backupStatusReport.ts apps/api/src/services/backupStatusReport.test.ts
git commit -m "$(cat <<'EOF'
feat(reports): backup status report data builder (W05)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Dispatcher wiring — `reportGenerationService.ts`

**Files:**
- Modify: `apps/api/src/services/reportGenerationService.ts:24-50` (`ReportType` union), `:865-891` (`dispatchReportGeneration` switch), `:928-973` (`zeroSafeReport` switch)
- Modify: `apps/api/src/services/reportGenerationService.test.ts:27-36` (`REPORT_TYPES` drift-guard array)

**Interfaces:**
- Consumes: `generateBackupStatusReport` (Task 4, `./backupStatusReport`).
- Produces: `ReportType` now includes `'backup_status'`; `generateReport('backup_status', …)` and `dispatchReportGeneration` route to `generateBackupStatusReport`; `zeroSafeReport('backup_status', …)` returns the shared empty-rows shape.

- [ ] **Step 1: Write the failing test**

`reportGenerationService.test.ts` already carries a **drift guard** (line 273 area) asserting `[...REPORT_TYPES, ...STORED_ARTIFACT_ONLY_TYPES].sort()` equals `[...reportTypeEnum.enumValues].sort()`. Task 1 added `'backup_status'` to the DB enum; this test now fails until `'backup_status'` is added to the TS-side `REPORT_TYPES` array too (it is generated on demand, not stored-artifact-only, so it belongs in `REPORT_TYPES`, not `STORED_ARTIFACT_ONLY_TYPES`).

In `apps/api/src/services/reportGenerationService.test.ts`, the array currently reads (lines 27-36):

```ts
const REPORT_TYPES: readonly ReportType[] = [
  'device_inventory',
  'software_inventory',
  'alert_summary',
  'compliance',
  'performance',
  'executive_summary',
  'security_compliance_posture',
  'hardware_lifecycle',
];
```

Replace with:

```ts
const REPORT_TYPES: readonly ReportType[] = [
  'device_inventory',
  'software_inventory',
  'alert_summary',
  'compliance',
  'performance',
  'executive_summary',
  'security_compliance_posture',
  'hardware_lifecycle',
  'backup_status',
];
```

This single change also extends every existing `it.each(REPORT_TYPES)(...)` test (restricted-empty zero-safe shape, restricted-site-scope binding, unrestricted generation) to cover `'backup_status'` automatically — no new `it` blocks are needed in this file.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/api && npx vitest run src/services/reportGenerationService.test.ts`
Expected: the drift-guard test (`'the API-local ReportType union covers exactly the DB enum...'`) now PASSES (the array matches the enum again) — but the `it.each(REPORT_TYPES)` tests fail for the new `'backup_status'` case with `Invalid report type: backup_status` (the `dispatchReportGeneration`/`zeroSafeReport` switches don't have a `backup_status` arm yet, so both fall through to their `default: { const exhaustive: never = type; throw … }` branch — a real TypeScript compile error too, since `ReportType` doesn't include `'backup_status'` on the union yet at this point in the task).

- [ ] **Step 3: Add `'backup_status'` to the `ReportType` union**

In `apps/api/src/services/reportGenerationService.ts`, the union currently ends (lines 45-50):

```ts
  // Hardware Lifecycle: generated on demand from devices/manual assets +
  // warranty; see services/hardwareLifecycleReport.ts.
  | 'hardware_lifecycle';
```

Replace with:

```ts
  // Hardware Lifecycle: generated on demand from devices/manual assets +
  // warranty; see services/hardwareLifecycleReport.ts.
  | 'hardware_lifecycle'
  // Backup Provider Integration W05 (#6013): Cove-email-style snapshot over
  // both Breeze first-party backups and connected provider devices,
  // generated on demand; see services/backupStatusReport.ts.
  | 'backup_status';
```

- [ ] **Step 4: Add the dispatch arm**

In `dispatchReportGeneration`'s switch, currently (lines 888-891):

```ts
    case 'hardware_lifecycle': {
      const { generateHardwareLifecycleReport } = await import('./hardwareLifecycleReport');
      return generateHardwareLifecycleReport(orgId, config, requestAuthority());
    }
    default: {
```

Replace with:

```ts
    case 'hardware_lifecycle': {
      const { generateHardwareLifecycleReport } = await import('./hardwareLifecycleReport');
      return generateHardwareLifecycleReport(orgId, config, requestAuthority());
    }
    case 'backup_status': {
      const { generateBackupStatusReport } = await import('./backupStatusReport');
      return generateBackupStatusReport(orgId, config, requestAuthority());
    }
    default: {
```

`backup_status` is deliberately absent from every portal-user allowlist in this file (`assertReportExecutionPreflight`'s `reportType !== 'executive_summary' && ... !== 'hardware_lifecycle'` check, and `dispatchReportGeneration`'s mirror of it) — see Task 5's DECISION below; `requestAuthority()` still applies here exactly as it does for every other non-managed-evidence type (it only refuses a `system` principal, which this type never receives since it is not in `MANAGED_EVIDENCE_REGISTRY`).

- [ ] **Step 5: Add the zero-safe arm**

In `zeroSafeReport`'s switch, currently (lines 954-959):

```ts
    case 'device_inventory':
    case 'software_inventory':
    case 'performance':
    case 'security_compliance_posture':
    case 'hardware_lifecycle':
      return emptyRowsReport();
```

Replace with:

```ts
    case 'device_inventory':
    case 'software_inventory':
    case 'performance':
    case 'security_compliance_posture':
    case 'hardware_lifecycle':
    case 'backup_status':
      return emptyRowsReport();
```

**DECISION:** `backup_status` is NOT added to either portal-user allowlist (`assertReportExecutionPreflight`'s `reportType !== 'executive_summary' && reportType !== 'security_compliance_posture' && reportType !== 'hardware_lifecycle'` check at line ~262, and its twin in `dispatchReportGeneration` at line ~876). The spec's Reports section only describes this as a technician/MSP-facing report (mirroring an MSP's own Cove console email); portal self-service report provisioning (`apps/api/src/services/portal/reportsSelfService.ts`'s `PORTAL_DEFINITIONS`/`PORTAL_REPORT_TYPES`, read at Task 5's research phase — see the plan-index note below) is a fixed three-entry tuple that this wave deliberately does not extend (see the standalone note after this task's steps). Since a `portal_user` authority can only ever be handed a `report.type` that a `reports` row of that type already carries, and no portal-self-service definition of type `backup_status` can ever be created (it is absent from `PORTAL_DEFINITIONS`), the portal-user gate for this type is correctly fail-closed by omission — adding it to the allowlist would be dead code with no reachable caller, and a genuine security regression the day it does become reachable without a matching design decision.

- [ ] **Step 6: Run the full test file to verify it passes**

Run: `cd apps/api && npx vitest run src/services/reportGenerationService.test.ts`
Expected: all PASS, including every `it.each(REPORT_TYPES)` case for `'backup_status'`. The two site-scope-binding tests (`'%s binds the exact restricted site scope and never Site B'`, `'%s preserves unrestricted generation without a site predicate'`) now execute the REAL `generateBackupStatusReport`, which calls `listBackupHealthRows`/`summarizeBackupHealth` from `./backupHealthReadModel` (a real W03 module by the time this task runs) — those functions are NOT mocked by this test file (only `../db` is, via `vi.mock('../db', () => ({ db: { select: vi.fn() } }))`, `db.select` returning `selectChain([])` for every call). **If this fails** because `backupHealthReadModel.ts`'s internal implementation calls a `db.*` method this file's mock doesn't stub (e.g. `db.execute` for a raw-SQL cursor query, rather than `db.select().from()...`), extend the `vi.mock('../db', ...)` object in this file with that method, returning an empty/no-op result in the same resolved shape as the existing `db.select` stub — do not weaken or delete the site-scope assertions to make the failure go away; the fix is a wider mock, not a narrower test.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/reportGenerationService.ts apps/api/src/services/reportGenerationService.test.ts
git commit -m "$(cat <<'EOF'
feat(reports): wire backup_status into the report dispatcher (W05)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

**Note on portal self-service (research, no code change):** `apps/api/src/services/portal/reportsSelfService.ts:148-154` hard-codes `PORTAL_REPORT_TYPES = ['security_compliance_posture', 'executive_summary', 'hardware_lifecycle'] as const` and `PORTAL_DEFINITIONS` (`:28-63`) provisions exactly those three report definitions per org. This IS the "hard-coded type list" the plan brief asked to check for. `backup_status` is deliberately **not** added to either — the spec's Reports section describes this report only as a technician-facing snapshot (mirroring the MSP's own Cove console email), never as customer-portal content, and D5's "Managed cloud backup" portal labelling is a W04 read-model concern (`portalReadModel.backupOverview`), not a report-generation one. Because portal visibility is gated entirely by this fixed tuple (no other code path grants a portal user a `backup_status` report definition), the new type is correctly invisible to the portal through the existing gating alone, with zero new portal code — exactly the outcome the plan brief asked this wave to confirm rather than build.

---

### Task 6: PDF renderer — `renderBackupStatusReport`

**Files:**
- Create: `packages/shared/src/reportPdf/backupStatusReport.ts`
- Test: `packages/shared/src/reportPdf/reportPdf.backupStatus.test.ts`
- Modify: `packages/shared/src/reportPdf/reportPdf.ts:1-19` (imports), `:137-149` (`BuildOpts`), `:165-171` (`REPORT_TYPE_LABELS`), `:1994-2010` (dispatch)

**Interfaces:**
- Consumes: `type PdfChrome` (`./hardwareLifecyclePdf`, existing — exported at `hardwareLifecyclePdf.ts:44-54`), `type BackupStatusReportData` (Task 3, `../types/backupStatusReport`), `type BackupHealthRow`/`type ExternalBackupStatus`/`type BackupRecency`/`type BackupStatusBucketId` (W01, `../types/backupHealth` — `BackupStatusBucketId` is the shared six-bucket grouping added after this plan's first draft; see the plan header's Cross-wave names note).
- Produces (verbatim name, consumed by `reportPdf.ts`'s dispatcher): `renderBackupStatusReport(doc: jsPDF, data: BackupStatusReportData, opts: { generatedAt: string }, chrome: PdfChrome): void`.

- [ ] **Step 1: Write the failing tests**

Create `packages/shared/src/reportPdf/reportPdf.backupStatus.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildReportPdf } from './reportPdf';
import type { BackupHealthRow, BackupStatusReportData } from '../types/backupStatusReport';

const opts = { reportType: 'backup_status', generatedAt: 'Sep 15, 2026', timezone: 'UTC' };

// See reportPdf.test.ts for why this range is remapped: jsPDF's default font
// encodes text as WinAnsi (cp1252), which diverges from plain Latin-1 only in
// the 0x80-0x9F byte range. None of this file's own prose uses a character in
// that range (plain ASCII apostrophes/hyphens throughout), but the helper is
// copied verbatim for consistency with every sibling report PDF test and as a
// safety net against jsPDF's own default punctuation (e.g. an em dash in a
// generated label) landing in that range.
const CP1252_HIGH =
  '€‚ƒ„…†‡' +
  'ˆ‰Š‹ŒŽ' +
  '‘’“”•–—' +
  '˜™š›œžŸ';
const decodeWinAnsi = (s: string): string =>
  s.replace(/[-]/g, (ch) => CP1252_HIGH[ch.charCodeAt(0) - 0x80] ?? ch);

function pdfText(doc: ReturnType<typeof buildReportPdf>): string {
  return ((doc.internal as unknown as { pages: Array<string[] | undefined> }).pages ?? [])
    .filter((p): p is string[] => Array.isArray(p))
    .map((p) => decodeWinAnsi(p.join('\n')))
    .join('\n');
}

function row(partial: Partial<BackupHealthRow> & { key: string; name: string }): BackupHealthRow {
  return {
    source: 'breeze', providerKey: null, providerLabel: null, orgId: 'o1', orgName: 'Acme Legal',
    siteId: null, deviceId: 'd1', computerName: null, osType: 'workstation', accountType: 'endpoint',
    status: 'completed', health: 'healthy', recency: 'under_24h', covered: true, stale: false,
    lastSuccessAt: null, lastSessionAt: null, selectedBytes: null, usedBytes: null, errorsCount: 0,
    dataSources: [], history28d: [], agentOnline: null,
    ...partial,
  } as BackupHealthRow;
}

const data: BackupStatusReportData = {
  org: { id: 'o1', name: 'Liggett & Goodman P.C.' },
  asOf: '2026-09-15T12:00:00.000Z',
  generatedAt: '2026-09-15T12:00:00.000Z',
  summary: {
    endpoints: { total: 3, covered: 1, uncovered: 2 },
    providerOnly: 1,
    m365Accounts: 0,
    byStatus: {
      completed: 1, completed_with_errors: 0, failed: 1, in_progress: 0,
      interrupted: 0, over_quota: 0, no_selection: 0, not_started: 1,
      no_backups: 0, unknown: 0,
    },
    byHealth: { healthy: 1, warning: 0, critical: 1, unknown: 1 },
    byRecency: { under_24h: 1, under_48h: 0, over_48h: 1, never: 1 },
  } as BackupStatusReportData['summary'],
  // Six buckets, `in_progress` (not `in_process`) — the shared W01
  // `BACKUP_STATUS_BUCKET_IDS` order. `other` is present here because the
  // fixture includes a `not_started` row (folded into `other`); Task 4's
  // builder omits this bucket entirely when its count is zero.
  statusBuckets: [
    { key: 'no_backups', count: 0, pct: 0 },
    { key: 'completed', count: 1, pct: 33.3 },
    { key: 'completed_with_errors', count: 0, pct: 0 },
    { key: 'in_progress', count: 0, pct: 0 },
    { key: 'unsuccessful', count: 1, pct: 33.3 },
    { key: 'other', count: 1, pct: 33.4 },
  ],
  recencyBuckets: [
    { key: 'never', count: 1, pct: 33.3 },
    { key: 'under_24h', count: 1, pct: 33.3 },
    { key: 'under_48h', count: 0, pct: 0 },
    { key: 'over_48h', count: 1, pct: 33.4 },
  ],
  rows: [
    row({
      key: 'provider:p1', name: 'LAW-SRV', source: 'provider', providerLabel: 'Cove Data Protection',
      computerName: 'LAW-SRV', osType: 'server', status: 'failed', health: 'critical', recency: 'over_48h',
      covered: false, selectedBytes: 5_000_000_000, usedBytes: 4_800_000_000, errorsCount: 3,
      dataSources: ['files', 'mssql'],
      history28d: [{ day: '2026-09-13', status: 'failed' }, { day: '2026-09-14', status: 'failed' }],
    }),
    row({
      key: 'breeze:d2', name: 'WKS-2', computerName: 'WKS-2', status: 'not_started', health: 'unknown',
      recency: 'never', selectedBytes: null, usedBytes: null,
    }),
    row({
      key: 'breeze:d1', name: 'SAM4', computerName: 'SAM4', status: 'completed', health: 'healthy',
      recency: 'under_24h', selectedBytes: 100_000_000, usedBytes: 90_000_000,
    }),
  ],
  options: { includeDevicesWithoutBackup: true, sources: ['breeze', 'provider'] },
};

describe('backup status report PDF', () => {
  it('renders the title, both bucket bars and the device table', () => {
    const doc = buildReportPdf([], { ...opts, summary: data });
    const text = pdfText(doc);
    expect(text).toContain('Backup Status Report');
    expect(text).toContain('Liggett & Goodman P.C.');
    expect(text).toContain('Status');
    expect(text).toContain('Completed');
    expect(text).toContain('Unsuccessful');
    expect(text).toContain('Other');
    expect(text).toContain('Last successful backup');
    expect(text).toContain('Never');
    expect(text).toContain('Under 24 hours');
    expect(text).toContain('Over 48 hours');
    expect(text).toContain('LAW-SRV');
    expect(text).toContain('SAM4');
    expect(text).toContain('WKS-2');
    expect(text).toContain('Not started');
    expect(text).toContain('Cove Data Protection');
    expect(text).toContain('Breeze');
    expect(text).toContain('Failed');
    expect(text).toContain('Server');
    expect(text).toContain('Workstation');
    expect(text).toContain('BACKUP STATUS');
  });

  it('renders an empty snapshot without throwing', () => {
    const empty: BackupStatusReportData = {
      ...data,
      rows: [],
      statusBuckets: data.statusBuckets.map((b) => ({ ...b, count: 0, pct: 0 })),
      recencyBuckets: data.recencyBuckets.map((b) => ({ ...b, count: 0, pct: 0 })),
    };
    const doc = buildReportPdf([], { ...opts, summary: empty });
    const text = pdfText(doc);
    expect(text).toContain("No devices matched this report's scope and filters.");
  });

  it('paginates a large device list and keeps the chrome on every page', () => {
    const rows = Array.from({ length: 80 }, (_, i) =>
      row({ key: `d${i}`, name: `PC-${i}`, status: 'completed', health: 'healthy' }));
    const doc = buildReportPdf([], { ...opts, summary: { ...data, rows } });
    expect(doc.getNumberOfPages()).toBeGreaterThan(1);
    const text = pdfText(doc);
    expect(text.match(/BACKUP STATUS/g)?.length).toBe(doc.getNumberOfPages());
  });

  it('falls back to the generic table when the snapshot has no rows array', () => {
    const doc = buildReportPdf([{ hostname: 'x' }], {
      ...opts,
      summary: { org: { name: 'Acme' } } as unknown as BackupStatusReportData,
    });
    expect(pdfText(doc)).not.toContain('Backup Status Report');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd packages/shared && npx vitest run src/reportPdf/reportPdf.backupStatus.test.ts`
Expected: fails — `reportPdf.ts` has no `backup_status` dispatch arm yet, so `buildReportPdf` falls into `renderGenericReport`, which never prints "Backup Status Report" or any bucket labels.

- [ ] **Step 3: Write the renderer**

Create `packages/shared/src/reportPdf/backupStatusReport.ts`:

```ts
/**
 * Backup status report PDF — the Cove "Backup & Recovery: All devices" email
 * layout, over both sources (Breeze + provider). Reuses reportPdf.ts's design
 * system through `chrome` (header band, footer, title block, section
 * heading) exactly like `hardwareLifecyclePdf.ts`, and its `PdfChrome` type
 * verbatim — this module never imports reportPdf.ts back.
 */
import type { jsPDF } from 'jspdf';
import autoTable, { type CellHookData } from 'jspdf-autotable';
import type { PdfChrome } from './hardwareLifecyclePdf';
import type { BackupStatusReportData } from '../types/backupStatusReport';
import type {
  BackupHealthRow,
  BackupRecency,
  BackupStatusBucketId,
  ExternalBackupStatus,
} from '../types/backupHealth';

type RGB = [number, number, number];

const fill = (doc: jsPDF, c: RGB) => doc.setFillColor(c[0], c[1], c[2]);
const ink = (doc: jsPDF, c: RGB) => doc.setTextColor(c[0], c[1], c[2]);
const mix = (a: RGB, b: RGB, t: number): RGB => [0, 1, 2].map((i) => Math.round(a[i]! + (b[i]! - a[i]!) * t)) as RGB;

// Six buckets — the shared W01 `BACKUP_STATUS_BUCKET_IDS` grouping (see
// apps/api/src/services/backupStatusReport.ts's `buildStatusBuckets`, which
// this renderer's `data.statusBuckets` input already came from). `other` is
// the catch-all for `not_started`/`unknown` and is simply absent from
// `data.statusBuckets` when its count is zero — `drawBucketBar` below already
// skips any zero-count entry generically, so no extra omission logic is
// needed here, only the label/colour for when it IS present.
const STATUS_BUCKET_LABEL: Record<BackupStatusBucketId, string> = {
  no_backups: 'No backups',
  completed: 'Completed',
  completed_with_errors: 'Completed with errors',
  in_progress: 'In process',
  unsuccessful: 'Unsuccessful',
  other: 'Other',
};

const RECENCY_BUCKET_LABEL: Record<BackupRecency, string> = {
  never: 'Never',
  under_24h: 'Under 24 hours',
  under_48h: 'Under 48 hours',
  over_48h: 'Over 48 hours',
};

function statusBucketColor(C: PdfChrome['C'], key: BackupStatusBucketId): RGB {
  switch (key) {
    case 'no_backups': return C.faint;
    case 'completed': return C.success;
    case 'completed_with_errors': return C.warning;
    case 'in_progress': return C.primary;
    case 'unsuccessful': return C.danger;
    case 'other': return C.muted;
    default: return C.faint;
  }
}

function recencyBucketColor(C: PdfChrome['C'], key: BackupRecency): RGB {
  switch (key) {
    case 'under_24h': return C.success;
    case 'under_48h': return C.warning;
    case 'over_48h': return C.danger;
    case 'never': return C.danger;
    default: return C.faint;
  }
}

/**
 * One horizontal bar per bucket group: label + count on top, a proportional
 * segment strip below — the same visual language as
 * `hardwareLifecyclePdf.ts`'s `drawStatusBar`, generalized over an arbitrary
 * bucket list and colour function since this report draws TWO such bars
 * (status, then recency) rather than one.
 */
function drawBucketBar<K extends string>(
  doc: jsPDF,
  chrome: PdfChrome,
  buckets: { key: K; count: number; pct: number }[],
  label: (key: K) => string,
  color: (key: K) => RGB,
  y: number,
): number {
  const { C, PAGE } = chrome;
  const visible = buckets.filter((b) => b.count > 0);
  const total = buckets.reduce((a, b) => a + b.count, 0);
  const width = PAGE.w - PAGE.mx * 2;
  const labelH = 11;
  const barH = 6;
  const barY = y + labelH + 1.5;
  if (total === 0 || visible.length === 0) {
    fill(doc, C.rule);
    doc.rect(PAGE.mx, barY, width, barH, 'F');
    return barY + barH + 3;
  }
  const gap = 0.6;
  const usable = width - gap * (visible.length - 1);
  const slot = width / visible.length;
  let x = PAGE.mx;
  for (const [i, b] of visible.entries()) {
    const w = usable * (b.count / total);
    const lx = PAGE.mx + slot * i;
    const c = color(b.key);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(18);
    ink(doc, c);
    const num = String(b.count);
    doc.text(num, lx, y + 7);
    const nw = doc.getTextWidth(num);
    doc.setFontSize(8.5);
    ink(doc, C.ink);
    doc.text(`${label(b.key)} (${b.pct}%)`, lx + nw + 2.2, y + 3.4);
    fill(doc, mix(c, C.white, 0.82));
    doc.rect(x, barY, w, barH - 1.1, 'F');
    fill(doc, c);
    doc.rect(x, barY + barH - 1.1, w, 1.1, 'F');
    x += w + gap;
  }
  return barY + barH + 3;
}

/** Per-day colour for the 28-day cell strip: green completed, amber warning
 *  statuses, red critical statuses, grey no observation (`status === null`)
 *  or a status this report treats as neither a pass nor a fail for a SINGLE
 *  day (`in_progress`/`not_started`/`unknown` — a day mid-run or unclassified
 *  is not a health claim the way it is once aggregated into `health` over the
 *  whole row). */
function dayCellColor(C: PdfChrome['C'], status: ExternalBackupStatus | null): RGB {
  if (status === null) return C.rule;
  switch (status) {
    case 'completed': return C.success;
    case 'completed_with_errors':
    case 'interrupted': return C.warning;
    case 'failed':
    case 'over_quota':
    case 'no_selection':
    case 'no_backups': return C.danger;
    default: return C.rule;
  }
}

function drawHistoryCell(doc: jsPDF, chrome: PdfChrome, row: BackupHealthRow, data: CellHookData): void {
  const { C } = chrome;
  const padX = 1;
  const x = data.cell.x + padX;
  const w = data.cell.width - padX * 2;
  const h = data.cell.height - 2.6;
  const y = data.cell.y + 1.3;
  // Right-align a shorter history to "today" so a newly linked device's few
  // observed days still line up with every other row's rightmost cell.
  const days = row.history28d.slice(-28);
  const cellW = w / 28;
  const offset = 28 - days.length;
  for (let i = 0; i < offset; i += 1) {
    fill(doc, C.rule);
    doc.rect(x + i * cellW, y, Math.max(cellW - 0.2, 0.3), h, 'F');
  }
  days.forEach((d, i) => {
    fill(doc, dayCellColor(C, d.status));
    doc.rect(x + (offset + i) * cellW, y, Math.max(cellW - 0.2, 0.3), h, 'F');
  });
}

type Col = { key: string; label: string; w: number; halign: 'left' | 'right' | 'center' };
const COLUMNS: Col[] = [
  { key: 'device', label: 'Device', w: 42, halign: 'left' },
  { key: 'computerName', label: 'Computer name', w: 32, halign: 'left' },
  { key: 'organization', label: 'Organization', w: 32, halign: 'left' },
  { key: 'source', label: 'Source', w: 20, halign: 'left' },
  { key: 'type', label: 'Type', w: 16, halign: 'left' },
  { key: 'dataSources', label: 'Data sources', w: 32, halign: 'left' },
  { key: 'selected', label: 'Selected', w: 18, halign: 'right' },
  { key: 'used', label: 'Used', w: 18, halign: 'right' },
  { key: 'history', label: '28 days', w: 40, halign: 'left' },
  { key: 'status', label: 'Status', w: 24, halign: 'left' },
  { key: 'errors', label: 'Errors', w: 13, halign: 'right' },
];
const STATUS_COL = COLUMNS.findIndex((c) => c.key === 'status');
const HISTORY_COL = COLUMNS.findIndex((c) => c.key === 'history');

const BODY_FONT = 7.5;
const ROW_MIN_H = 8.4;

function formatBytes(n: number | null): string {
  if (n == null) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v >= 10 || i === 0 ? Math.round(v) : Math.round(v * 10) / 10}${units[i]}`;
}

const STATUS_LABEL: Record<ExternalBackupStatus, string> = {
  completed: 'Completed',
  completed_with_errors: 'Completed with errors',
  failed: 'Failed',
  in_progress: 'In process',
  interrupted: 'Interrupted',
  over_quota: 'Over quota',
  no_selection: 'Nothing selected',
  not_started: 'Not started',
  no_backups: 'No backups',
  unknown: 'Unknown',
};

function statusColor(C: PdfChrome['C'], status: ExternalBackupStatus): RGB {
  switch (status) {
    case 'completed': return C.success;
    case 'completed_with_errors':
    case 'interrupted': return C.warning;
    case 'failed':
    case 'over_quota':
    case 'no_selection':
    case 'no_backups': return C.danger;
    default: return C.faint;
  }
}

function cellText(row: BackupHealthRow, key: string): string {
  switch (key) {
    case 'device': return row.name;
    case 'computerName': return row.computerName ?? '-';
    case 'organization': return row.orgName;
    case 'source': return row.source === 'breeze' ? 'Breeze' : (row.providerLabel ?? 'Provider');
    case 'type': return row.osType === 'workstation' ? 'Workstation' : row.osType === 'server' ? 'Server' : 'Unknown';
    case 'dataSources': return row.dataSources.length > 0 ? row.dataSources.join(', ') : '-';
    case 'selected': return formatBytes(row.selectedBytes);
    case 'used': return formatBytes(row.usedBytes);
    case 'errors': return String(row.errorsCount);
    case 'status': return STATUS_LABEL[row.status];
    // Drawn by hand in didDrawCell (a 28-cell colour strip); text stays empty
    // so autoTable never prints a stray label under the drawing.
    case 'history':
    default: return '';
  }
}

function ensureSpace(doc: jsPDF, chrome: PdfChrome, y: number, needed: number): number {
  if (y + needed <= chrome.PAGE.footY - 6) return y;
  doc.addPage();
  chrome.drawHeaderBand(doc);
  chrome.drawFooter(doc);
  return chrome.PAGE.bandH + 10;
}

export type BackupStatusPdfOpts = {
  generatedAt: string;
};

export function renderBackupStatusReport(
  doc: jsPDF,
  data: BackupStatusReportData,
  opts: BackupStatusPdfOpts,
  chrome: PdfChrome,
): void {
  const { C, PAGE } = chrome;
  const rows = Array.isArray(data.rows) ? data.rows : [];

  let y = chrome.drawTitleBlock(
    doc,
    'Backup Status Report',
    data.org?.name ?? '',
    `Prepared ${opts.generatedAt} - ${rows.length} device${rows.length === 1 ? '' : 's'} across both sources`,
    PAGE.bandH + 14,
  );

  // --- Status ------------------------------------------------------------
  y = chrome.drawSectionHeading(doc, 'Status', y + 6);
  y = drawBucketBar(doc, chrome, data.statusBuckets, (k) => STATUS_BUCKET_LABEL[k], (k) => statusBucketColor(C, k), y + 2);

  // --- Last successful backup ----------------------------------------------
  y = chrome.drawSectionHeading(doc, 'Last successful backup', y + 6);
  y = drawBucketBar(doc, chrome, data.recencyBuckets, (k) => RECENCY_BUCKET_LABEL[k], (k) => recencyBucketColor(C, k), y + 2);

  // --- Devices ---------------------------------------------------------------
  if (rows.length === 0) {
    y = chrome.drawSectionHeading(doc, 'Devices', y + 8);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9.5);
    ink(doc, C.muted);
    doc.text("No devices matched this report's scope and filters.", PAGE.mx, y + 4);
    return;
  }

  y = ensureSpace(doc, chrome, y + 8, 20 + ROW_MIN_H * Math.min(3, rows.length));
  y = chrome.drawSectionHeading(doc, 'Devices', y);
  const contentW = PAGE.w - PAGE.mx * 2;
  const scale = contentW / COLUMNS.reduce((a, c) => a + c.w, 0);
  const columnStyles: Record<number, { cellWidth: number; halign: Col['halign'] }> = {};
  COLUMNS.forEach((c, i) => { columnStyles[i] = { cellWidth: c.w * scale, halign: c.halign }; });
  const continuationTop = PAGE.bandH + 16;

  autoTable(doc, {
    startY: y + 1,
    margin: { top: continuationTop, left: PAGE.mx, right: PAGE.mx, bottom: 16 },
    head: [COLUMNS.map((c) => ({ content: c.label, styles: { halign: c.halign } }))],
    body: rows.map((r) => COLUMNS.map((c) => cellText(r, c.key))),
    theme: 'grid',
    rowPageBreak: 'avoid',
    styles: { fontSize: BODY_FONT, cellPadding: { top: 1.2, bottom: 1.2, left: 1.6, right: 1.6 }, minCellHeight: ROW_MIN_H, lineColor: C.rule, lineWidth: 0.1, textColor: C.ink, valign: 'middle' },
    headStyles: { fillColor: C.panel, textColor: C.ink, fontStyle: 'bold', fontSize: 6.8, lineColor: C.rule, lineWidth: 0.1, minCellHeight: 7 },
    alternateRowStyles: { fillColor: C.zebra },
    columnStyles,
    didParseCell: (cell: CellHookData) => {
      if (cell.section !== 'body') return;
      const row = rows[cell.row.index];
      if (!row) return;
      if (cell.column.index === STATUS_COL) {
        cell.cell.styles.textColor = statusColor(C, row.status);
        cell.cell.styles.fontStyle = 'bold';
      }
    },
    didDrawCell: (cell: CellHookData) => {
      if (cell.section !== 'body') return;
      const row = rows[cell.row.index];
      if (!row) return;
      if (cell.column.index === HISTORY_COL) drawHistoryCell(doc, chrome, row, cell);
    },
    didDrawPage: (info) => {
      if (info.pageNumber <= 1) return;
      chrome.drawHeaderBand(doc);
      chrome.drawFooter(doc);
      chrome.drawSectionHeading(doc, 'Devices (continued)', PAGE.bandH + 10);
    },
  });

  const t = (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable;
  const finalY = typeof t?.finalY === 'number' ? t.finalY : y;

  const note = `Figures as of ${data.asOf}. "28 days" reads oldest (left) to most recent (right); grey is a day with no observation.`;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  ink(doc, C.faint);
  const noteY = finalY + 4 <= PAGE.footY - 6 ? finalY + 4 : PAGE.footY - 2.5;
  doc.text(note, PAGE.mx, noteY);
}
```

- [ ] **Step 4: Wire the dispatch arm in `reportPdf.ts`**

In `packages/shared/src/reportPdf/reportPdf.ts`, add to the import block (currently lines 5-6):

```ts
import type { HardwareLifecycleSummary } from '../types/hardwareLifecycleReport';
import { renderHardwareLifecycleReport } from './hardwareLifecyclePdf';
```

insert immediately after:

```ts
import type { BackupStatusReportData } from '../types/backupStatusReport';
import { renderBackupStatusReport } from './backupStatusReport';
```

In `BuildOpts` (currently line 143):

```ts
  summary?: PostureSummary | ExecutiveSummary | OrgNarrativeReportSummary | FleetDesignReportSummary | HardwareLifecycleSummary;
```

Replace with:

```ts
  summary?: PostureSummary | ExecutiveSummary | OrgNarrativeReportSummary | FleetDesignReportSummary | HardwareLifecycleSummary | BackupStatusReportData;
```

In `REPORT_TYPE_LABELS` (currently lines 165-171):

```ts
const REPORT_TYPE_LABELS: Record<string, string> = {
  security_compliance_posture: 'Security & Compliance Posture',
  ai_org_narrative: 'Weekly AI Operations Narrative',
  ai_agent_impact: 'AI Agent Impact',
  ai_fleet_design: 'Fleet Design',
  hardware_lifecycle: 'Hardware Lifecycle',
};
```

Replace with:

```ts
const REPORT_TYPE_LABELS: Record<string, string> = {
  security_compliance_posture: 'Security & Compliance Posture',
  ai_org_narrative: 'Weekly AI Operations Narrative',
  ai_agent_impact: 'AI Agent Impact',
  ai_fleet_design: 'Fleet Design',
  hardware_lifecycle: 'Hardware Lifecycle',
  backup_status: 'Backup Status',
};
```

In `buildReportPdfWithPalette`'s dispatch chain, currently (lines 1994-2010):

```ts
  } else if (
    opts.reportType === 'hardware_lifecycle'
    && opts.summary
    && Array.isArray((opts.summary as HardwareLifecycleSummary).rows)
  ) {
    // Self-contained chrome: the plan table paginates on its own (didDrawPage)
    // and the sections after it add pages as needed.
    drawHeaderBand(doc, opts);
    drawFooter(doc, opts);
    renderHardwareLifecycleReport(
      doc,
      opts.summary as HardwareLifecycleSummary,
      { generatedAt: opts.generatedAt, partnerName: opts.branding?.name ?? null, contactEmail: opts.branding?.contactEmail ?? null, contactName: opts.branding?.contactName ?? null },
      {
        C,
        PAGE,
        drawHeaderBand: (d) => drawHeaderBand(d, opts),
        drawFooter: (d) => drawFooter(d, opts),
        drawTitleBlock,
        drawSectionHeading,
      },
    );
  } else {
```

Replace with:

```ts
  } else if (
    opts.reportType === 'hardware_lifecycle'
    && opts.summary
    && Array.isArray((opts.summary as HardwareLifecycleSummary).rows)
  ) {
    // Self-contained chrome: the plan table paginates on its own (didDrawPage)
    // and the sections after it add pages as needed.
    drawHeaderBand(doc, opts);
    drawFooter(doc, opts);
    renderHardwareLifecycleReport(
      doc,
      opts.summary as HardwareLifecycleSummary,
      { generatedAt: opts.generatedAt, partnerName: opts.branding?.name ?? null, contactEmail: opts.branding?.contactEmail ?? null, contactName: opts.branding?.contactName ?? null },
      {
        C,
        PAGE,
        drawHeaderBand: (d) => drawHeaderBand(d, opts),
        drawFooter: (d) => drawFooter(d, opts),
        drawTitleBlock,
        drawSectionHeading,
      },
    );
  } else if (
    opts.reportType === 'backup_status'
    && opts.summary
    && Array.isArray((opts.summary as BackupStatusReportData).rows)
  ) {
    drawHeaderBand(doc, opts);
    drawFooter(doc, opts);
    renderBackupStatusReport(
      doc,
      opts.summary as BackupStatusReportData,
      { generatedAt: opts.generatedAt },
      {
        C,
        PAGE,
        drawHeaderBand: (d) => drawHeaderBand(d, opts),
        drawFooter: (d) => drawFooter(d, opts),
        drawTitleBlock,
        drawSectionHeading,
      },
    );
  } else {
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd packages/shared && npx vitest run src/reportPdf/reportPdf.backupStatus.test.ts src/reportPdf/reportPdf.test.ts src/reportPdf/reportPdf.hardwareLifecycle.test.ts`
Expected: all PASS — the new file's own tests, plus the two existing PDF test files unaffected (the new `else if` arm is guarded by `opts.reportType === 'backup_status'`, so no other report type's dispatch path changes).

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/reportPdf/backupStatusReport.ts \
        packages/shared/src/reportPdf/reportPdf.backupStatus.test.ts \
        packages/shared/src/reportPdf/reportPdf.ts
git commit -m "$(cat <<'EOF'
feat(reportPdf): backup status report PDF renderer (W05)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Web type plumbing

**Files:**
- Modify: `apps/web/src/components/reports/ReportsList.tsx:32-42` (`ReportType`)
- Modify: `apps/web/src/components/reports/ReportBuilder.tsx:159-185` (`legacyToBuilderType`)

**Interfaces:**
- Consumes: nothing new.
- Produces: `ReportType` (web) includes `'backup_status'`; `legacyToBuilderType` stays exhaustive so `reportTypeSurvivesBuilder('backup_status')` is `false` (this report is delivered only through its own curated template, exactly like `hardware_lifecycle`).

This task is pure type plumbing (a `Record<K, V>` exhaustiveness requirement, enforced by `tsc`, not by a Vitest assertion) — there is no meaningful runtime behavior to red/green here; Task 8/9's tests exercise the result. `cd apps/web && npx tsc --noEmit` is this task's own verification step, matching how `reportTypeSurvivesBuilder` is itself typed to fail loudly (a `never`-shaped `Record`) if a case is missed.

- [ ] **Step 1: Add `'backup_status'` to `ReportType`**

In `apps/web/src/components/reports/ReportsList.tsx`, currently (lines 32-42):

```ts
export type ReportType =
  | 'device_inventory'
  | 'software_inventory'
  | 'alert_summary'
  | 'compliance'
  | 'performance'
  | 'executive_summary'
  | 'security_compliance_posture'
  | 'ai_org_narrative'
  | 'ai_fleet_design'
  | 'hardware_lifecycle';
```

Replace with:

```ts
export type ReportType =
  | 'device_inventory'
  | 'software_inventory'
  | 'alert_summary'
  | 'compliance'
  | 'performance'
  | 'executive_summary'
  | 'security_compliance_posture'
  | 'ai_org_narrative'
  | 'ai_fleet_design'
  | 'hardware_lifecycle'
  | 'backup_status';
```

- [ ] **Step 2: Add the `legacyToBuilderType` entry**

In `apps/web/src/components/reports/ReportBuilder.tsx`, the record currently ends (lines 182-185):

```ts
  // Hardware Lifecycle is delivered via a curated template with its own
  // options form; the builder never offers it. Mapping to the devices source
  // keeps the Record exhaustive and `reportTypeSurvivesBuilder` false.
  hardware_lifecycle: 'devices'
};
```

Replace with:

```ts
  // Hardware Lifecycle is delivered via a curated template with its own
  // options form; the builder never offers it. Mapping to the devices source
  // keeps the Record exhaustive and `reportTypeSurvivesBuilder` false.
  hardware_lifecycle: 'devices',
  // Backup Status Report (W05) — same reasoning as Hardware Lifecycle
  // immediately above: delivered only via its own curated template and
  // options form (BackupStatusOptionsForm.tsx). Mapping to the devices
  // source keeps this Record exhaustive and `reportTypeSurvivesBuilder`
  // false so no code path can reach the freeform builder for this type.
  backup_status: 'devices'
};
```

- [ ] **Step 3: Typecheck**

Run: `cd apps/web && npx tsc --noEmit`
Expected: no errors (in particular, no `Property 'backup_status' is missing in type ... Record<LegacyReportType, BuilderReportType>` error, which is exactly what an omitted entry would produce given `legacyToBuilderType`'s explicit `Record<LegacyReportType, BuilderReportType>` annotation).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/reports/ReportsList.tsx apps/web/src/components/reports/ReportBuilder.tsx
git commit -m "$(cat <<'EOF'
feat(web): backup_status report type plumbing (W05)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Web options form — `BackupStatusOptionsForm.tsx`

**Files:**
- Create: `apps/web/src/components/reports/BackupStatusOptionsForm.tsx`
- Test: `apps/web/src/components/reports/BackupStatusOptionsForm.test.tsx`

**Interfaces:**
- Consumes: `react-i18next` (`useTranslation('reports')`, existing convention).
- Produces (verbatim names, consumed by Tasks 9 and 10): `type BackupStatusOptions = { includeDevicesWithoutBackup: boolean; sources: Array<'breeze' | 'provider'> }`, `DEFAULT_BACKUP_STATUS_OPTIONS`, `backupStatusOptionsFromConfig(config: Record<string, unknown>): BackupStatusOptions`, `BackupStatusOptionsFields({ value, onChange }: { value: BackupStatusOptions; onChange: (v: BackupStatusOptions) => void })`, `BackupStatusOptionsForm({ value, onChange, busy, submitLabel, onSubmit, onCancel })`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/reports/BackupStatusOptionsForm.test.tsx`:

```ts
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BACKUP_STATUS_OPTIONS,
  backupStatusOptionsFromConfig,
} from './BackupStatusOptionsForm';

// backupStatusOptionsFromConfig reads a persisted report `config` back into
// option state for the edit page. The include toggle must be "on unless
// === false" (never fall back to a default the moment a legacy config used a
// non-boolean value), and `sources` must fall back to both sources for
// anything that isn't a genuinely non-empty array of the two known values —
// never silently narrow a stored report's scope because of a corrupted or
// hand-edited config.
describe('backupStatusOptionsFromConfig', () => {
  it('the include toggle is "on unless === false" — any other value, even a falsy one, stays on', () => {
    expect(backupStatusOptionsFromConfig({ includeDevicesWithoutBackup: false }).includeDevicesWithoutBackup).toBe(false);
    expect(backupStatusOptionsFromConfig({ includeDevicesWithoutBackup: true }).includeDevicesWithoutBackup).toBe(true);
    expect(backupStatusOptionsFromConfig({}).includeDevicesWithoutBackup).toBe(true);
    expect(backupStatusOptionsFromConfig({ includeDevicesWithoutBackup: 0 }).includeDevicesWithoutBackup).toBe(true);
    expect(backupStatusOptionsFromConfig({ includeDevicesWithoutBackup: 'no' }).includeDevicesWithoutBackup).toBe(true);
  });

  it('falls back to both sources when the key is absent entirely', () => {
    expect(backupStatusOptionsFromConfig({}).sources).toEqual(DEFAULT_BACKUP_STATUS_OPTIONS.sources);
  });

  it('falls back to both sources for an empty array — an empty selection is never persisted as "no sources"', () => {
    expect(backupStatusOptionsFromConfig({ sources: [] }).sources).toEqual(['breeze', 'provider']);
  });

  it('falls back to both sources when the array contains an unrecognized value', () => {
    expect(backupStatusOptionsFromConfig({ sources: ['breeze', 'carbonite'] }).sources).toEqual(['breeze', 'provider']);
  });

  it('falls back to both sources for a non-array value like the string "breeze"', () => {
    expect(backupStatusOptionsFromConfig({ sources: 'breeze' }).sources).toEqual(['breeze', 'provider']);
  });

  it('keeps a genuinely narrowed, valid single-source selection', () => {
    expect(backupStatusOptionsFromConfig({ sources: ['provider'] }).sources).toEqual(['provider']);
    expect(backupStatusOptionsFromConfig({ sources: ['breeze'] }).sources).toEqual(['breeze']);
  });

  it('keeps a valid two-source selection regardless of order', () => {
    expect(backupStatusOptionsFromConfig({ sources: ['provider', 'breeze'] }).sources).toEqual(['provider', 'breeze']);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web && npx vitest run src/components/reports/BackupStatusOptionsForm.test.tsx`
Expected: `Cannot find module './BackupStatusOptionsForm'` (the file doesn't exist yet).

- [ ] **Step 3: Write the component**

Create `apps/web/src/components/reports/BackupStatusOptionsForm.tsx`:

```tsx
import { useTranslation } from 'react-i18next';

export type BackupStatusOptions = {
  includeDevicesWithoutBackup: boolean;
  sources: Array<'breeze' | 'provider'>;
};

export const DEFAULT_BACKUP_STATUS_OPTIONS: BackupStatusOptions = {
  includeDevicesWithoutBackup: true,
  sources: ['breeze', 'provider'],
};

const KNOWN_SOURCES = new Set(['breeze', 'provider']);

function isValidSourcesArray(value: unknown): value is Array<'breeze' | 'provider'> {
  return Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'string' && KNOWN_SOURCES.has(v));
}

/** Read the persisted config back into option state (edit page). */
export function backupStatusOptionsFromConfig(config: Record<string, unknown>): BackupStatusOptions {
  return {
    includeDevicesWithoutBackup: config.includeDevicesWithoutBackup !== false,
    sources: isValidSourcesArray(config.sources) ? config.sources : DEFAULT_BACKUP_STATUS_OPTIONS.sources,
  };
}

type FieldProps = {
  value: BackupStatusOptions;
  onChange: (value: BackupStatusOptions) => void;
};

type Props = FieldProps & {
  busy?: boolean;
  submitLabel: string;
  onSubmit: () => void;
  onCancel: () => void;
};

function toggleSource(current: Array<'breeze' | 'provider'>, source: 'breeze' | 'provider'): Array<'breeze' | 'provider'> {
  const has = current.includes(source);
  // Never allow the last remaining source to be unchecked — an empty
  // selection would silently produce a zero-row report with no visible
  // reason why (the API schema also rejects it with .min(1), but the form
  // should never let the user reach that 400 in the first place).
  if (has && current.length === 1) return current;
  return has ? current.filter((s) => s !== source) : [...current, source];
}

/**
 * The backup-status-only options on their own, for composing alongside
 * another form's submit controls (the edit page pairs them with
 * ReportBuilder) — mirrors `HardwareLifecycleOptionsFields`.
 */
export function BackupStatusOptionsFields({ value, onChange }: FieldProps) {
  const { t } = useTranslation('reports');

  return (
    <div className="space-y-4">
      <label className="flex items-start gap-3 rounded-md border p-4">
        <input
          data-testid="backup-status-include-without-backup"
          type="checkbox"
          checked={value.includeDevicesWithoutBackup}
          onChange={(event) => onChange({ ...value, includeDevicesWithoutBackup: event.target.checked })}
          className="mt-1 h-4 w-4"
        />
        <span>
          <span className="block text-sm font-medium">{t('reports.backupStatusOptions.includeDevicesWithoutBackup')}</span>
          <span className="block text-xs text-muted-foreground">{t('reports.backupStatusOptions.includeDevicesWithoutBackupHelp')}</span>
        </span>
      </label>

      <div className="rounded-md border p-4">
        <span className="block text-sm font-medium">{t('reports.backupStatusOptions.sources')}</span>
        <span className="mt-1 block text-xs text-muted-foreground">{t('reports.backupStatusOptions.sourcesHelp')}</span>
        <div className="mt-3 space-y-2">
          <label className="flex items-center gap-3">
            <input
              data-testid="backup-status-source-breeze"
              type="checkbox"
              checked={value.sources.includes('breeze')}
              onChange={() => onChange({ ...value, sources: toggleSource(value.sources, 'breeze') })}
              className="h-4 w-4"
            />
            <span className="text-sm">{t('reports.backupStatusOptions.sourceBreeze')}</span>
          </label>
          <label className="flex items-center gap-3">
            <input
              data-testid="backup-status-source-provider"
              type="checkbox"
              checked={value.sources.includes('provider')}
              onChange={() => onChange({ ...value, sources: toggleSource(value.sources, 'provider') })}
              className="h-4 w-4"
            />
            <span className="text-sm">{t('reports.backupStatusOptions.sourceProvider')}</span>
          </label>
        </div>
      </div>
    </div>
  );
}

export function BackupStatusOptionsForm({
  value,
  onChange,
  busy = false,
  submitLabel,
  onSubmit,
  onCancel,
}: Props) {
  const { t } = useTranslation('reports');

  return (
    <div className="space-y-5">
      <BackupStatusOptionsFields value={value} onChange={onChange} />
      <div className="flex justify-end gap-2">
        <button type="button" className="rounded-md border px-4 py-2 text-sm" onClick={onCancel}>
          {t('reports.backupStatusOptions.cancel')}
        </button>
        <button
          type="button"
          data-testid="backup-status-create-report"
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
          disabled={busy}
          onClick={onSubmit}
        >
          {submitLabel}
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Add the placeholder `en` i18n keys so the test can run**

`backupStatusOptionsFromConfig` itself has no `t()` calls (pure logic), so `BackupStatusOptionsForm.test.tsx` passes without any locale file changes — but add the keys to `en/reports.json` now anyway so Task 9's component test (which DOES render `BackupStatusOptionsFields`) has real strings to assert against instead of raw keys. In `apps/web/src/locales/en/reports.json`, inside the `reports` object, add a new top-level member `backupStatusOptions` (sibling to `lifecycleOptions`/`postureOptions`):

```json
"backupStatusOptions": {
  "cancel": "Cancel",
  "createReport": "Create report",
  "includeDevicesWithoutBackup": "Include devices without any backup",
  "includeDevicesWithoutBackupHelp": "Off, the report only lists devices with some backup evidence, like the provider's own summary email.",
  "sources": "Backup sources",
  "sourcesHelp": "Choose which backup sources to include in the report.",
  "sourceBreeze": "Breeze backup",
  "sourceProvider": "Connected backup providers"
}
```

Also add, inside `reports.reportTemplates.reportTypes`, next to `"hardware_lifecycle": "Hardware Lifecycle"`:

```json
"backup_status": "Backup Status",
```

and inside `reports.reportTemplates.templates`, next to the `hardware_lifecycle` entry:

```json
"backup_status": {
  "name": "Backup Status Report",
  "description": "Every device's backup status across Breeze and connected backup providers, in one snapshot: coverage buckets, last successful backup, and a 28-day history per device."
}
```

The other 7 locales are done in Task 11 — `en` must exist now for `localeParity.test.ts` (the reference locale) and Task 9's component test to read real strings.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/web && npx vitest run src/components/reports/BackupStatusOptionsForm.test.tsx`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/reports/BackupStatusOptionsForm.tsx \
        apps/web/src/components/reports/BackupStatusOptionsForm.test.tsx \
        apps/web/src/locales/en/reports.json
git commit -m "$(cat <<'EOF'
feat(web): backup status report options form (W05)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Template registration — `ReportTemplates.tsx`

**Files:**
- Modify: `apps/web/src/components/reports/ReportTemplates.tsx:1-20` (imports), `:62-75` (`reportTypeValues`), `:80-169` (`defaultTemplates`), `:312-324` (state), `:393-416` (`handleUseTemplate`), `:585-631` (modals)
- Test: `apps/web/src/components/reports/ReportTemplates.backupStatus.test.tsx` (new)

**Interfaces:**
- Consumes: `BackupStatusOptionsForm`, `DEFAULT_BACKUP_STATUS_OPTIONS`, `type BackupStatusOptions` (Task 8).
- Produces: a "Backup Status Report" card in the templates grid, creating a `type: 'backup_status'` report directly (bypassing `ReportBuilder`, exactly like the `hardware_lifecycle`/`security_compliance_posture` branches) via the existing `handleCreateDirect`/`runAction` path.

- [ ] **Step 1: Write the failing test**

Create `apps/web/src/components/reports/ReportTemplates.backupStatus.test.tsx` (mirrors `ReportTemplates.hardwareLifecycle.test.tsx` file-for-file):

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));

vi.mock('../../stores/orgStore', () => ({ useOrgStore: () => ({ currentOrgId: 'org-1' }) }));

const navigateTo = vi.fn();
vi.mock('@/lib/navigation', () => ({ navigateTo: (...a: unknown[]) => navigateTo(...a) }));

const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (...a: unknown[]) => showToast(...a) }));

import ReportTemplates from './ReportTemplates';

function mockTemplatesFetch(onPost: (init?: { method?: string }) => Promise<unknown>) {
  fetchWithAuth.mockImplementation((url: string, init?: { method?: string }) => {
    if (url === '/reports/templates') {
      return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
    }
    if (url === '/reports' && init?.method === 'POST') {
      return onPost(init);
    }
    return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
  });
}

function postCallBody() {
  const call = fetchWithAuth.mock.calls.find(
    ([url, init]) => url === '/reports' && (init as { method?: string } | undefined)?.method === 'POST'
  );
  return call ? JSON.parse((call[1] as { body: string }).body) : undefined;
}

async function clickUseTemplate(name: string) {
  const heading = await screen.findByText(name);
  const card = heading.closest('div.group') as HTMLElement;
  expect(card).toBeTruthy();
  await userEvent.setup().click(within(card).getByRole('button', { name: /use template/i }));
  return card;
}

describe('ReportTemplates — Backup Status card', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates a backup_status report directly with the default options', async () => {
    mockTemplatesFetch(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ data: { id: 'rep-1' } }) }));
    render(<ReportTemplates />);

    await clickUseTemplate('Backup Status Report');
    await userEvent.setup().click(screen.getByTestId('backup-status-create-report'));

    await waitFor(() => {
      expect(fetchWithAuth).toHaveBeenCalledWith('/reports', expect.objectContaining({ method: 'POST' }));
    });
    expect(postCallBody()).toMatchObject({
      type: 'backup_status',
      orgId: 'org-1',
      schedule: 'one_time',
      format: 'pdf',
      config: { includeDevicesWithoutBackup: true, sources: ['breeze', 'provider'] },
    });
    // Never the downgrading builder.
    expect(screen.queryByLabelText(/Report name/i)).not.toBeInTheDocument();
    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith('/reports'));
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it('posts the edited toggle and source selection', async () => {
    mockTemplatesFetch(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ data: { id: 'rep-1' } }) }));
    render(<ReportTemplates />);
    const user = userEvent.setup();

    await clickUseTemplate('Backup Status Report');
    await user.click(screen.getByTestId('backup-status-include-without-backup'));
    await user.click(screen.getByTestId('backup-status-source-breeze'));
    await user.click(screen.getByTestId('backup-status-create-report'));

    await waitFor(() => expect(postCallBody()).toBeDefined());
    expect(postCallBody().config).toMatchObject({
      includeDevicesWithoutBackup: false,
      sources: ['provider'],
    });
  });

  it('surfaces a failure and does not navigate when the create POST fails', async () => {
    mockTemplatesFetch(() => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: 'boom' }) }));
    render(<ReportTemplates />);

    await clickUseTemplate('Backup Status Report');
    await userEvent.setup().click(screen.getByTestId('backup-status-create-report'));

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    expect(navigateTo).not.toHaveBeenCalledWith('/reports');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web && npx vitest run src/components/reports/ReportTemplates.backupStatus.test.tsx`
Expected: `findByText('Backup Status Report')` times out — no such card exists yet.

- [ ] **Step 3: Add the import, icon, `reportTypeValues` entry and template card**

In `apps/web/src/components/reports/ReportTemplates.tsx`, add to the icon import (currently lines 2-12):

```ts
import {
  Activity,
  BarChart3,
  Bell,
  CalendarClock,
  FileText,
  Loader2,
  Plus,
  ShieldCheck,
  X
} from 'lucide-react';
```

Replace with (adding `HardDriveDownload` — already a verified-real icon in this repo, used in `apps/web/src/components/backup/BackupDashboard.tsx`, `apps/web/src/components/alerts/AlertsPage.tsx`, and others):

```ts
import {
  Activity,
  BarChart3,
  Bell,
  CalendarClock,
  FileText,
  HardDriveDownload,
  Loader2,
  Plus,
  ShieldCheck,
  X
} from 'lucide-react';
```

Add to the `HardwareLifecycleOptionsForm` import block (currently lines 16-20):

```ts
import {
  DEFAULT_HARDWARE_LIFECYCLE_OPTIONS,
  HardwareLifecycleOptionsForm,
  type HardwareLifecycleOptions,
} from './HardwareLifecycleOptionsForm';
```

insert immediately after:

```ts
import {
  DEFAULT_BACKUP_STATUS_OPTIONS,
  BackupStatusOptionsForm,
  type BackupStatusOptions,
} from './BackupStatusOptionsForm';
```

In `reportTypeValues` (currently lines 62-75):

```ts
const reportTypeValues: TemplateReportType[] = [
  'device_inventory',
  'software_inventory',
  'alert_summary',
  'compliance',
  'performance',
  'executive_summary',
  'security_compliance_posture',
  'hardware_lifecycle',
  'devices',
  'alerts',
  'patches',
  'activity'
];
```

Replace with:

```ts
const reportTypeValues: TemplateReportType[] = [
  'device_inventory',
  'software_inventory',
  'alert_summary',
  'compliance',
  'performance',
  'executive_summary',
  'security_compliance_posture',
  'hardware_lifecycle',
  'backup_status',
  'devices',
  'alerts',
  'patches',
  'activity'
];
```

In `defaultTemplates`, immediately after the `hardware_lifecycle` entry (currently lines 99-116):

```ts
  {
    id: 'hardware_lifecycle',
    name: 'Hardware Lifecycle Report',
    description:
      'Customer-ready device replacement plan: age, warranty, replace-by dates and OS support status, with a staged recommendation.',
    defaults: {
      name: 'Hardware Lifecycle Report',
      type: 'hardware_lifecycle',
      dateRange: { preset: 'last_30_days' },
      schedule: 'monthly',
      format: 'pdf'
    },
    icon: CalendarClock,
    tone: {
      iconBg: 'bg-emerald-500/15',
      iconColor: 'text-emerald-600'
    }
  },
```

insert:

```ts
  {
    id: 'backup_status',
    name: 'Backup Status Report',
    description:
      "Every device's backup status across Breeze and connected backup providers, in one snapshot: coverage buckets, last successful backup, and a 28-day history per device.",
    defaults: {
      name: 'Backup Status Report',
      type: 'backup_status',
      dateRange: { preset: 'last_30_days' },
      schedule: 'one_time',
      format: 'pdf'
    },
    icon: HardDriveDownload,
    tone: {
      iconBg: 'bg-sky-500/15',
      iconColor: 'text-sky-600'
    }
  },
```

`schedule: 'one_time'` (not `'monthly'` like hardware lifecycle) is a **DECISION**: the spec's own Cove-email precedent is a *daily* status summary, and the report's whole purpose is an as-of snapshot mirroring that cadence far more than a monthly device-replacement plan does — but this wave does not add a "daily" option to the schedule enum's UI defaults elsewhere, so the curated template defaults to `one_time` (the safest, most conservative default already used for several other templates in this file, e.g. none of the five existing curated cards defaults to `daily`) and leaves cadence entirely to the user via the existing `ReportBuilder`... except this report never reaches `ReportBuilder` (see `reportTypeSurvivesBuilder`, Task 7). A user who wants a recurring cadence edits the created report afterward from `/reports` (`ReportEditPage.tsx`, Task 10), exactly like a `hardware_lifecycle` report's cadence is changed today.

- [ ] **Step 4: Add component state and the `handleUseTemplate` branch**

In `ReportTemplates`'s state block, currently (lines 315-324):

```ts
  const [templates, setTemplates] = useState<ReportTemplate[]>(defaultTemplates);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [activeTemplate, setActiveTemplate] = useState<ReportTemplate | null>(null);
  const [postureTemplate, setPostureTemplate] = useState<ReportTemplate | null>(null);
  const [backupRequired, setBackupRequired] = useState(false);
  const [lifecycleTemplate, setLifecycleTemplate] = useState<ReportTemplate | null>(null);
  const [lifecycleOptions, setLifecycleOptions] = useState<HardwareLifecycleOptions>(DEFAULT_HARDWARE_LIFECYCLE_OPTIONS);
  const [builderOpen, setBuilderOpen] = useState(false);
  const [creatingId, setCreatingId] = useState<string | null>(null);
```

Replace with:

```ts
  const [templates, setTemplates] = useState<ReportTemplate[]>(defaultTemplates);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [activeTemplate, setActiveTemplate] = useState<ReportTemplate | null>(null);
  const [postureTemplate, setPostureTemplate] = useState<ReportTemplate | null>(null);
  const [backupRequired, setBackupRequired] = useState(false);
  const [lifecycleTemplate, setLifecycleTemplate] = useState<ReportTemplate | null>(null);
  const [lifecycleOptions, setLifecycleOptions] = useState<HardwareLifecycleOptions>(DEFAULT_HARDWARE_LIFECYCLE_OPTIONS);
  const [backupStatusTemplate, setBackupStatusTemplate] = useState<ReportTemplate | null>(null);
  const [backupStatusOptions, setBackupStatusOptions] = useState<BackupStatusOptions>(DEFAULT_BACKUP_STATUS_OPTIONS);
  const [builderOpen, setBuilderOpen] = useState(false);
  const [creatingId, setCreatingId] = useState<string | null>(null);
```

In `handleUseTemplate`, currently (lines 393-416):

```ts
  const handleUseTemplate = useCallback(
    (template: ReportTemplate) => {
      // Curated templates whose report type the builder can't represent (it
      // would silently downgrade them) are created directly; everything the
      // builder round-trips losslessly goes through the builder for tailoring.
      const type = template.defaults.type;
      if (type === 'security_compliance_posture') {
        setBackupRequired(false);
        setPostureTemplate(template);
        return;
      }
      if (type === 'hardware_lifecycle') {
        setLifecycleOptions(DEFAULT_HARDWARE_LIFECYCLE_OPTIONS);
        setLifecycleTemplate(template);
        return;
      }
      if (type && !reportTypeSurvivesBuilder(type)) {
        void handleCreateDirect(template);
        return;
      }
      handleOpenBuilder(template);
    },
    [handleCreateDirect, handleOpenBuilder]
  );
```

Replace with:

```ts
  const handleUseTemplate = useCallback(
    (template: ReportTemplate) => {
      // Curated templates whose report type the builder can't represent (it
      // would silently downgrade them) are created directly; everything the
      // builder round-trips losslessly goes through the builder for tailoring.
      const type = template.defaults.type;
      if (type === 'security_compliance_posture') {
        setBackupRequired(false);
        setPostureTemplate(template);
        return;
      }
      if (type === 'hardware_lifecycle') {
        setLifecycleOptions(DEFAULT_HARDWARE_LIFECYCLE_OPTIONS);
        setLifecycleTemplate(template);
        return;
      }
      if (type === 'backup_status') {
        setBackupStatusOptions(DEFAULT_BACKUP_STATUS_OPTIONS);
        setBackupStatusTemplate(template);
        return;
      }
      if (type && !reportTypeSurvivesBuilder(type)) {
        void handleCreateDirect(template);
        return;
      }
      handleOpenBuilder(template);
    },
    [handleCreateDirect, handleOpenBuilder]
  );
```

- [ ] **Step 5: Add the modal**

Immediately after the `lifecycleTemplate` modal block, currently ending (lines 606-607):

```tsx
      {lifecycleTemplate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-lg rounded-lg border bg-card p-6 shadow-lg">
            <h2 className="text-lg font-semibold">
              {t('reports.reportTemplates.useTemplateTitle', {
                name: getTemplateDisplayName(lifecycleTemplate),
              })}
            </h2>
            <div className="mt-5">
              <HardwareLifecycleOptionsForm
                value={lifecycleOptions}
                onChange={setLifecycleOptions}
                busy={creatingId === lifecycleTemplate.id}
                submitLabel={t('reports.lifecycleOptions.createReport')}
                onCancel={() => setLifecycleTemplate(null)}
                onSubmit={() => {
                  void handleCreateDirect(lifecycleTemplate, { ...lifecycleOptions });
                }}
              />
            </div>
          </div>
        </div>
      )}
```

insert:

```tsx

      {backupStatusTemplate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-lg rounded-lg border bg-card p-6 shadow-lg">
            <h2 className="text-lg font-semibold">
              {t('reports.reportTemplates.useTemplateTitle', {
                name: getTemplateDisplayName(backupStatusTemplate),
              })}
            </h2>
            <div className="mt-5">
              <BackupStatusOptionsForm
                value={backupStatusOptions}
                onChange={setBackupStatusOptions}
                busy={creatingId === backupStatusTemplate.id}
                submitLabel={t('reports.backupStatusOptions.createReport')}
                onCancel={() => setBackupStatusTemplate(null)}
                onSubmit={() => {
                  void handleCreateDirect(backupStatusTemplate, { ...backupStatusOptions });
                }}
              />
            </div>
          </div>
        </div>
      )}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd apps/web && npx vitest run src/components/reports/ReportTemplates.backupStatus.test.tsx src/components/reports/ReportTemplates.hardwareLifecycle.test.tsx src/components/reports/ReportTemplates.posture.test.tsx`
Expected: all PASS — the new file's tests, and the two pre-existing curated-template test files unaffected.

- [ ] **Step 7: Typecheck and commit**

Run: `cd apps/web && npx tsc --noEmit`
Expected: no errors.

```bash
git add apps/web/src/components/reports/ReportTemplates.tsx \
        apps/web/src/components/reports/ReportTemplates.backupStatus.test.tsx
git commit -m "$(cat <<'EOF'
feat(web): backup status report curated template card (W05)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Edit page — `ReportEditPage.tsx`

**Files:**
- Modify: `apps/web/src/components/reports/ReportEditPage.tsx` (whole file, 170 lines — read in full above)

**Interfaces:**
- Consumes: `BackupStatusOptionsFields`, `backupStatusOptionsFromConfig`, `DEFAULT_BACKUP_STATUS_OPTIONS`, `type BackupStatusOptions` (Task 8).
- Produces: editing a `backup_status` report shows the same two option fields as the create-template modal, mirroring the `isLifecycle` branch exactly.

There is no `ReportEditPage.hardwareLifecycle.test.tsx` or `ReportEditPage.backupStatus.test.tsx` in this codebase today — only `ReportEditPage.posture.test.tsx` exists (posture is the one curated type with a dedicated edit-page test; lifecycle's edit-page wiring has none). This task follows that same precedent: wire the branch (mirroring `isLifecycle` exactly, itself untested at the edit-page level) without adding a new edit-page test file. Task 9's create-flow test plus Task 8's `backupStatusOptionsFromConfig` unit test already cover every piece of logic this task reuses; the edit page itself has zero new logic (it composes `backupStatusOptionsFromConfig` and `BackupStatusOptionsFields`, both already tested).

- [ ] **Step 1: Add the imports**

In `apps/web/src/components/reports/ReportEditPage.tsx`, currently (lines 9-14):

```ts
import {
  DEFAULT_HARDWARE_LIFECYCLE_OPTIONS,
  HardwareLifecycleOptionsFields,
  hardwareLifecycleOptionsFromConfig,
  type HardwareLifecycleOptions,
} from './HardwareLifecycleOptionsForm';
```

insert immediately after:

```ts
import {
  DEFAULT_BACKUP_STATUS_OPTIONS,
  BackupStatusOptionsFields,
  backupStatusOptionsFromConfig,
  type BackupStatusOptions,
} from './BackupStatusOptionsForm';
```

- [ ] **Step 2: Add state**

Currently (line 31):

```ts
  const [lifecycleOptions, setLifecycleOptions] = useState<HardwareLifecycleOptions>(DEFAULT_HARDWARE_LIFECYCLE_OPTIONS);
```

insert immediately after:

```ts
  const [backupStatusOptions, setBackupStatusOptions] = useState<BackupStatusOptions>(DEFAULT_BACKUP_STATUS_OPTIONS);
```

- [ ] **Step 3: Populate state on fetch**

Currently, in `fetchReport` (lines 43-45):

```ts
      const config = data.config as Record<string, unknown>;
      setBackupRequired(config.backupRequired !== false);
      setLifecycleOptions(hardwareLifecycleOptionsFromConfig(config));
```

Replace with:

```ts
      const config = data.config as Record<string, unknown>;
      setBackupRequired(config.backupRequired !== false);
      setLifecycleOptions(hardwareLifecycleOptionsFromConfig(config));
      setBackupStatusOptions(backupStatusOptionsFromConfig(config));
```

- [ ] **Step 4: Add the `isBackupStatus` branch**

Currently (lines 104-106):

```ts
  const isPosture = report.type === 'security_compliance_posture';
  const isLifecycle = report.type === 'hardware_lifecycle';
```

Replace with:

```ts
  const isPosture = report.type === 'security_compliance_posture';
  const isLifecycle = report.type === 'hardware_lifecycle';
  const isBackupStatus = report.type === 'backup_status';
```

Currently, the section-render block (lines 148-152):

```tsx
      {isLifecycle && (
        <div className="rounded-lg border bg-card p-6 shadow-xs">
          <HardwareLifecycleOptionsFields value={lifecycleOptions} onChange={setLifecycleOptions} />
        </div>
      )}
```

insert immediately after:

```tsx

      {isBackupStatus && (
        <div className="rounded-lg border bg-card p-6 shadow-xs">
          <BackupStatusOptionsFields value={backupStatusOptions} onChange={setBackupStatusOptions} />
        </div>
      )}
```

- [ ] **Step 5: Wire `baseConfig`**

Currently (lines 158-164):

```tsx
        baseConfig={
          isPosture
            ? { ...config, backupRequired }
            : isLifecycle
              ? { ...config, ...lifecycleOptions }
              : config
        }
```

Replace with:

```tsx
        baseConfig={
          isPosture
            ? { ...config, backupRequired }
            : isLifecycle
              ? { ...config, ...lifecycleOptions }
              : isBackupStatus
                ? { ...config, ...backupStatusOptions }
                : config
        }
```

- [ ] **Step 6: Typecheck and commit**

Run: `cd apps/web && npx tsc --noEmit`
Expected: no errors.

```bash
git add apps/web/src/components/reports/ReportEditPage.tsx
git commit -m "$(cat <<'EOF'
feat(web): edit backup status report options (W05)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: i18n — all 8 locales

**Files:**
- Modify: `apps/web/src/locales/{de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/reports.json` (`en` already done in Task 8/9)

**Interfaces:**
- Consumes: nothing.
- Produces: every locale carries the identical key set Task 8/9 added to `en`, each with a real, natural translation.

- [ ] **Step 1: Freeze the English key set**

From `apps/web/src/locales/en/reports.json` (after Tasks 8-9), the new/changed subtree is:

- `reports.backupStatusOptions.{cancel, createReport, includeDevicesWithoutBackup, includeDevicesWithoutBackupHelp, sources, sourcesHelp, sourceBreeze, sourceProvider}` (8 keys)
- `reports.reportTemplates.reportTypes.backup_status` (1 key)
- `reports.reportTemplates.templates.backup_status.{name, description}` (2 keys)

11 keys total, in every one of the other 7 locale files.

- [ ] **Step 2: Add the translations**

**`de-DE/reports.json`** — add to `reports.backupStatusOptions`:

```json
"backupStatusOptions": {
  "cancel": "Abbrechen",
  "createReport": "Bericht erstellen",
  "includeDevicesWithoutBackup": "Geräte ohne Sicherung einbeziehen",
  "includeDevicesWithoutBackupHelp": "Ausgeschaltet listet der Bericht nur Geräte mit vorhandenem Sicherungsnachweis auf, wie die eigene Übersichts-E-Mail des Anbieters.",
  "sources": "Sicherungsquellen",
  "sourcesHelp": "Wählen Sie, welche Sicherungsquellen im Bericht enthalten sein sollen.",
  "sourceBreeze": "Breeze-Sicherung",
  "sourceProvider": "Verbundene Backup-Anbieter"
}
```

`reports.reportTemplates.reportTypes`:

```json
"backup_status": "Sicherungsstatus",
```

`reports.reportTemplates.templates`:

```json
"backup_status": {
  "name": "Sicherungsstatusbericht",
  "description": "Sicherungsstatus jedes Geräts über Breeze und verbundene Backup-Anbieter hinweg in einer Momentaufnahme: Abdeckungsgruppen, letzte erfolgreiche Sicherung und eine 28-Tage-Historie pro Gerät."
}
```

**`es-419/reports.json`** — `reports.backupStatusOptions`:

```json
"backupStatusOptions": {
  "cancel": "Cancelar",
  "createReport": "Crear informe",
  "includeDevicesWithoutBackup": "Incluir equipos sin ningún respaldo",
  "includeDevicesWithoutBackupHelp": "Si está desactivado, el informe solo lista equipos con alguna evidencia de respaldo, como el correo resumen propio del proveedor.",
  "sources": "Fuentes de respaldo",
  "sourcesHelp": "Elija qué fuentes de respaldo incluir en el informe.",
  "sourceBreeze": "Respaldo de Breeze",
  "sourceProvider": "Proveedores de respaldo conectados"
}
```

`reports.reportTemplates.reportTypes`:

```json
"backup_status": "Estado de respaldo",
```

`reports.reportTemplates.templates`:

```json
"backup_status": {
  "name": "Informe de estado de respaldo",
  "description": "Estado de respaldo de cada equipo en Breeze y los proveedores de respaldo conectados, en una sola instantánea: categorías de cobertura, último respaldo exitoso y un historial de 28 días por equipo."
}
```

**`fr-FR/reports.json`** and **`fr-CA/reports.json`** (identical text in both, matching this namespace's existing precedent — `lifecycleOptions`/`templates.hardware_lifecycle` are word-for-word identical between the two French locales today) — `reports.backupStatusOptions`:

```json
"backupStatusOptions": {
  "cancel": "Annuler",
  "createReport": "Créer le rapport",
  "includeDevicesWithoutBackup": "Inclure les appareils sans aucune sauvegarde",
  "includeDevicesWithoutBackupHelp": "Désactivé, le rapport ne liste que les appareils disposant d’une preuve de sauvegarde, comme l’e-mail récapitulatif du fournisseur.",
  "sources": "Sources de sauvegarde",
  "sourcesHelp": "Choisissez les sources de sauvegarde à inclure dans le rapport.",
  "sourceBreeze": "Sauvegarde Breeze",
  "sourceProvider": "Fournisseurs de sauvegarde connectés"
}
```

`reports.reportTemplates.reportTypes`:

```json
"backup_status": "État des sauvegardes",
```

`reports.reportTemplates.templates`:

```json
"backup_status": {
  "name": "Rapport d’état des sauvegardes",
  "description": "État de sauvegarde de chaque appareil sur Breeze et les fournisseurs de sauvegarde connectés, en un instantané : catégories de couverture, dernière sauvegarde réussie et historique de 28 jours par appareil."
}
```

**`it-IT/reports.json`** — `reports.backupStatusOptions`:

```json
"backupStatusOptions": {
  "cancel": "Annulla",
  "createReport": "Crea report",
  "includeDevicesWithoutBackup": "Includi dispositivi senza alcun backup",
  "includeDevicesWithoutBackupHelp": "Se disattivato, il report elenca solo i dispositivi con qualche prova di backup, come l’email di riepilogo del provider.",
  "sources": "Origini dei backup",
  "sourcesHelp": "Scegli quali origini di backup includere nel report.",
  "sourceBreeze": "Backup Breeze",
  "sourceProvider": "Provider di backup collegati"
}
```

`reports.reportTemplates.reportTypes`:

```json
"backup_status": "Stato dei backup",
```

`reports.reportTemplates.templates`:

```json
"backup_status": {
  "name": "Report sullo stato dei backup",
  "description": "Stato di backup di ogni dispositivo su Breeze e sui provider di backup collegati, in un’unica istantanea: categorie di copertura, ultimo backup riuscito e cronologia di 28 giorni per dispositivo."
}
```

**`pt-BR/reports.json`** — `reports.backupStatusOptions`:

```json
"backupStatusOptions": {
  "cancel": "Cancelar",
  "createReport": "Criar relatório",
  "includeDevicesWithoutBackup": "Incluir dispositivos sem nenhum backup",
  "includeDevicesWithoutBackupHelp": "Desativado, o relatório lista apenas dispositivos com alguma evidência de backup, como o próprio e-mail-resumo do provedor.",
  "sources": "Fontes de backup",
  "sourcesHelp": "Escolha quais fontes de backup incluir no relatório.",
  "sourceBreeze": "Backup do Breeze",
  "sourceProvider": "Provedores de backup conectados"
}
```

`reports.reportTemplates.reportTypes`:

```json
"backup_status": "Status do backup",
```

`reports.reportTemplates.templates`:

```json
"backup_status": {
  "name": "Relatório de status de backup",
  "description": "Status de backup de cada dispositivo no Breeze e nos provedores de backup conectados, em um único instantâneo: categorias de cobertura, último backup bem-sucedido e um histórico de 28 dias por dispositivo."
}
```

**`tr-TR/reports.json`** — `reports.backupStatusOptions`:

```json
"backupStatusOptions": {
  "cancel": "İptal",
  "createReport": "Rapor oluştur",
  "includeDevicesWithoutBackup": "Hiç yedeklemesi olmayan cihazları dahil et",
  "includeDevicesWithoutBackupHelp": "Kapalıyken rapor yalnızca sağlayıcının kendi özet e-postasında olduğu gibi bir miktar yedekleme kanıtı olan cihazları listeler.",
  "sources": "Yedekleme kaynakları",
  "sourcesHelp": "Rapora hangi yedekleme kaynaklarının dahil edileceğini seçin.",
  "sourceBreeze": "Breeze yedeklemesi",
  "sourceProvider": "Bağlı yedekleme sağlayıcıları"
}
```

`reports.reportTemplates.reportTypes`:

```json
"backup_status": "Yedekleme Durumu",
```

`reports.reportTemplates.templates`:

```json
"backup_status": {
  "name": "Yedekleme Durumu Raporu",
  "description": "Breeze ve bağlı yedekleme sağlayıcıları genelinde her cihazın yedekleme durumu tek bir anlık görüntüde: kapsam kategorileri, son başarılı yedekleme ve cihaz başına 28 günlük geçmiş."
}
```

Insert each locale's three blocks at the same structural position as `en`'s (Task 8 Step 4 / Task 9 Step 3): `backupStatusOptions` as a new top-level member of `reports` sibling to `lifecycleOptions`; `reportTypes.backup_status` and `templates.backup_status` inside `reports.reportTemplates`, immediately after the existing `hardware_lifecycle` entries in each.

- [ ] **Step 3: Run the i18n guards**

Run: `cd apps/web && npx vitest run src/lib/i18n`
Expected: `localeParity.test.ts` PASSES for all 8 locales — every namespace/key set matches `en` exactly, every interpolation token set matches (none of the new strings interpolate anything, so this is trivially satisfied), every rich-text tag multiset matches (none use `<Trans>` markup), no HTML entities, no bare route/filesystem-path values. `translationCoverage.test.ts` should also PASS without any `namespaceDuplicateBaselines['reports.json']` change — every new translated leaf differs from its English counterpart (verified by hand above; "Breeze" is the only English word that recurs verbatim in several translations, and it is in `protectedNames`, so it is expected to recur, not counted as an untranslated duplicate).

**If `translationCoverage.test.ts` unexpectedly fails** for a locale (e.g. a translation this plan chose happens to collide with a technical loanword pattern already at its cap), the fix is to bump that locale's `'reports.json'` entry in `namespaceDuplicateBaselines` (`apps/web/src/lib/i18n/translationCoverage.test.ts`) by exactly the number of new duplicates, with an inline comment naming the key and why the duplicate is legitimate (matching every existing entry's style) — never delete or loosen the assertion itself, and never swap a real translation for an English one just to dodge the cap.

- [ ] **Step 4: Full locale-parity re-run and typecheck**

Run: `cd apps/web && npx vitest run src/lib/i18n && npx tsc --noEmit`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/locales/de-DE/reports.json \
        apps/web/src/locales/es-419/reports.json \
        apps/web/src/locales/fr-CA/reports.json \
        apps/web/src/locales/fr-FR/reports.json \
        apps/web/src/locales/it-IT/reports.json \
        apps/web/src/locales/pt-BR/reports.json \
        apps/web/src/locales/tr-TR/reports.json
git commit -m "$(cat <<'EOF'
i18n(web): backup status report strings in all 8 locales (W05)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: Full verification sweep and PR

**Files:** none (verification only).

- [ ] **Step 1: Full targeted test sweep**

Run each of the following and confirm PASS:

```bash
cd apps/api && npx vitest run \
  src/db/schema/reports.test.ts \
  src/db/autoMigrate.test.ts \
  src/db/migrationRlsScope.test.ts \
  src/routes/reports/schemas.config.test.ts \
  src/services/backupStatusReport.test.ts \
  src/services/reportGenerationService.test.ts \
  src/services/hardwareLifecycleReport.test.ts \
  src/services/securityComplianceReport.test.ts

cd packages/shared && npx vitest run \
  src/reportPdf/reportPdf.test.ts \
  src/reportPdf/reportPdf.hardwareLifecycle.test.ts \
  src/reportPdf/reportPdf.backupStatus.test.ts

cd apps/web && npx vitest run \
  src/components/reports/BackupStatusOptionsForm.test.tsx \
  src/components/reports/ReportTemplates.backupStatus.test.tsx \
  src/components/reports/ReportTemplates.hardwareLifecycle.test.tsx \
  src/components/reports/ReportTemplates.posture.test.tsx \
  src/lib/i18n
```

- [ ] **Step 2: Repo-wide typecheck**

Run: `cd apps/api && npx tsc --noEmit && cd ../../packages/shared && npx tsc --noEmit && cd ../../apps/web && npx tsc --noEmit`
Expected: no errors in any of the three packages.

- [ ] **Step 3: `pnpm db:check-drift` and tear down the test stack**

```bash
cd apps/api && DATABASE_URL=$(grep DATABASE_URL .env.test | cut -d= -f2-) pnpm db:check-drift
```
Expected: no drift reported.

```bash
pnpm test-stack down
```

- [ ] **Step 4: Lint**

Run: `pnpm lint`
Expected: no new violations in any file this plan touched.

- [ ] **Step 5: Open the PR**

```bash
git push -u origin feature/6008-backup-provider-integration/wave-6013
gh pr create --title "feat(reports): backup status report (W05)" --body "$(cat <<'EOF'
## Summary
- New `backup_status` report type — an org-scoped, as-of snapshot over both Breeze first-party backups and connected provider devices, laid out like Cove's "Backup & Recovery: All devices" email: status buckets, last-successful-backup recency buckets, and a device table sorted unhealthy-first with a 28-day history strip per row.
- Built entirely on the W03 unified read model (`listBackupHealthRows`/`summarizeBackupHealth`) — no new queries beyond the org's display name.
- Curated web template + options form (include-devices-without-backup toggle, per-source checkboxes), mirroring the existing Hardware Lifecycle Report template.
- Real translations in all 8 locales.
- **Not in scope** (per spec): managed-evidence registry registration — a deliverables-track follow-up, not part of this spec.

Closes #6013

## Test plan
- [ ] `cd apps/api && npx vitest run src/services/backupStatusReport.test.ts src/services/reportGenerationService.test.ts src/routes/reports/schemas.config.test.ts` green
- [ ] `cd packages/shared && npx vitest run src/reportPdf` green
- [ ] `cd apps/web && npx vitest run src/components/reports src/lib/i18n` green
- [ ] `pnpm db:check-drift` clean
- [ ] Manual: create a Backup Status Report from `/reports`, generate a PDF, confirm bucket bars and device table render against a wt-stack with W01-W03 seeded provider data
EOF
)"
```

Dispatch CI on this branch before enqueueing — stacked branches get no `pull_request` run: `gh workflow run CI --ref feature/6008-backup-provider-integration/wave-6013`.

The plan's final task ends here, at an open, reviewed PR — do not merge.

## Self-review

### 1. Spec coverage

| Spec requirement (W05 scope) | Task |
|---|---|
| New report type `backup_status`, registered in the existing report dispatcher | Tasks 1, 2, 5 |
| Org-scoped, as-of snapshot | Task 4 (`generateBackupStatusReport`'s `orgId` parameter, `asOf`/`generatedAt` fields) |
| Plus the 28-day ledger | Task 4 (each row's `history28d`, sourced from the W03 read model), Task 6 (`drawHistoryCell`) |
| (1) Status buckets with count + percentage bars | Task 4 (`buildStatusBuckets`, now over the shared W01 `BACKUP_STATUS_BUCKET_IDS`/`bucketForBackupStatus`, six buckets with `other` rendered only when non-zero), Task 6 (`drawBucketBar` "Status" section, `STATUS_BUCKET_LABEL` incl. "Other") |
| (2) Last successful backup buckets (never/<24h/<48h/>48h) | Task 4 (`buildRecencyBuckets`), Task 6 (`drawBucketBar` "Last successful backup" section) |
| Status-bucket grouping agrees with the W03 web overview (coordinator follow-up, 2026-09-16) | Task 3 (`BackupStatusBucket.key: BackupStatusBucketId`, imported not redefined), Task 4 (imports `bucketForBackupStatus`/`BACKUP_STATUS_BUCKET_IDS` from `@breeze/shared` instead of the plan's original local fold), Task 6 (`STATUS_BUCKET_LABEL`/`statusBucketColor` cover all six ids) |
| (3) Device table with the named columns, over both sources | Task 6 (`COLUMNS`: device, computer name, organization, source, device type, active data sources, selected size, used storage, 28-day bar, status, errors) |
| Honouring the Cove email's ordering (unhealthy first) | Task 4 (`sortUnhealthyFirst`) |
| Managed-evidence registry registration explicitly NOT in scope | Stated in the plan header; no task touches `managedEvidenceRegistry.ts` or `deliverableTemplates.ts` |
| Discovery: report-type declaration | Task 1 (confirmed real Postgres `pgEnum`, not Zod-only) |
| Discovery: data build + dispatch | Task 5 (`dispatchReportGeneration`/`zeroSafeReport`, both real switch statements, confirmed by reading `reportGenerationService.ts` in full) |
| Discovery: PDF rendering, `buildPostureBackupMetric` | Read (Task 6's design); confirmed this function is a W04 concern (posture report), untouched by W05 |
| Discovery: existing table+bar renderer to copy | `hardwareLifecyclePdf.ts`'s `PdfChrome`/`drawStatusBar`/autoTable pattern, reused in Task 6 |
| Discovery: web report-type offering | Task 7 (`ReportsList.tsx`, `ReportBuilder.tsx`), Task 9 (`ReportTemplates.tsx`), Task 10 (`ReportEditPage.tsx`), Task 8 (`PostureReportOptionsForm.tsx` pattern mirrored via `HardwareLifecycleOptionsForm.tsx`) |
| Discovery: report-type-enum migration slot usage | Task 1 (used — `report_type` is a real DB enum) |
| Discovery: portal report list | Task 5's standalone note (`reportsSelfService.ts:148-154` hard-coded tuple; deliberately not extended) |

### 2. Placeholder scan

No "TBD", "TODO", "implement later", "add appropriate error handling", "add validation", "write tests for the above", or "similar to Task N" appears anywhere above. Every code step shows complete code; every test file is a complete, runnable Vitest file, not a stub.

### 3. Type consistency

- `BackupStatusReportData`, `BackupStatusBucket`, `BackupRecencyBucket`, `BackupStatusReportOptions` (Task 3) are used with identical field names and types in Task 4 (API builder), Task 6 (PDF renderer), and the test fixtures of both. `BackupStatusBucket.key` types as W01's shared `BackupStatusBucketId` (`'no_backups' | 'completed' | 'completed_with_errors' | 'in_progress' | 'unsuccessful' | 'other'`) rather than a plan-local key type — Task 3 imports it from `../backupHealth` instead of declaring its own, so Task 4's `buildStatusBuckets` and Task 6's `STATUS_BUCKET_LABEL`/`statusBucketColor` are structurally forced to stay exhaustive over the same six values the W03 overview uses.
- `generateBackupStatusReport(orgId: string, rawConfig: Record<string, unknown>, authority: ReportExecutionAuthority): Promise<ReportResult>` (Task 4) matches the signature `dispatchReportGeneration` calls it with in Task 5, matching every sibling generator (`generateHardwareLifecycleReport`, `generateSecurityCompliancePostureReport`).
- `renderBackupStatusReport(doc: jsPDF, data: BackupStatusReportData, opts: BackupStatusPdfOpts, chrome: PdfChrome): void` (Task 6) matches the call in `reportPdf.ts`'s dispatch arm, and `PdfChrome` is imported (not redefined) from `hardwareLifecyclePdf.ts`, so the two renderers can never drift on the chrome contract.
- `BackupStatusOptions`/`DEFAULT_BACKUP_STATUS_OPTIONS`/`backupStatusOptionsFromConfig`/`BackupStatusOptionsFields`/`BackupStatusOptionsForm` (Task 8) are consumed identically in Task 9 (create flow) and Task 10 (edit flow) — same import names, same prop shapes as the `HardwareLifecycleOptionsForm` pattern they mirror.
- `backupStatusReportConfigSchema`/`backupStatusReportConfigFields` (Task 2) field names (`sites`, `includeDevicesWithoutBackup`, `sources`) match exactly the config keys `generateBackupStatusReport` reads (Task 4), the keys `BackupStatusOptionsForm` posts (Task 8/9), and the keys `backupStatusOptionsFromConfig` reads back (Task 8/10) — verified by the round-trip tests in Tasks 2, 4, 8 and 9.
