---
issue: LanternOps/breeze#5784
wave: W02
spec: docs/superpowers/specs/billing/2026-09-14-service-plan-evidence-reports-spec.md
# tracking_issue: added by register_feature at Stage 4 — do not fill in by hand
---
# Evidence Reports W02: `threat_detection_review` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Huntress-using MSP defines "monthly threat detection review" once as a
partner-wide template item and gets a real, period-correct artifact in every org
it applies to — one that says what it *actually* covers rather than printing a
reassuring zero.

**Architecture:** A new `report_type` enum label plus a pure aggregator over
`huntress_incidents` / `huntress_agents` left-joined to `devices`. Zero new
tables, zero new data, no consent change. The generator follows
`hardwareLifecycleReport.ts`: parse config, preflight, handle restricted scope,
apply the site filter in **every** query branch, and return a tabular body in
`result.rows` with all designed content and comparators in `result.summary`. A
shared summary type in `packages/shared/src/types/` is produced by the API with
`satisfies` and consumed by the PDF renderer and the web preview, so all three
agree.

**Tech Stack:** PostgreSQL + Drizzle, Hono + Zod, Vitest, jsPDF +
jspdf-autotable (`packages/shared/src/reportPdf`), Astro + React islands,
react-i18next.

**Spec:** `docs/superpowers/specs/billing/2026-09-14-service-plan-evidence-reports-spec.md`
§3.2 (contents, coverage disclosure, site scope), §3.1 (the shared contract every
type obeys), §5.3 (the per-type wiring checklist), §6 (portal impact), §9.1 (the
contract tests that fire).

**Plan index:** `docs/superpowers/plans/billing/2026-09-14-service-plan-evidence-reports.md`

**Depends on:** **W01 only**
(`docs/superpowers/plans/billing/2026-09-14-service-plan-evidence-reports-w01-foundation.md`),
whose four cross-wave contracts this wave is the first consumer of.

---

## Global Constraints

- **Persisted data only. No Huntress HTTP call inside a report run.** A run
  triggered by the 05:18 sweep must be deterministic and must not couple artifact
  generation to an external dependency. Freshness is a property the artifact
  *prints*, not something it fetches.
- **Unmeasured ≠ zero.** A report that prints `0 incidents` when Huntress was
  never connected is a lie the customer will act on. When no active
  `huntress_integrations` row exists for the partner, the whole report renders as
  a single data-gap page — **not** an empty incident table. Every section that can
  be unmeasured renders "N/A — no data" with the reason, following `pctOrNull`
  (`apps/api/src/services/securityComplianceReport.ts:48`) and `dataGap`
  (`apps/api/src/services/securityPosture.ts:265`).
- **Completeness cannot be claimed, and the artifact must not claim it.** The
  first Huntress sync fetches 24 hours only (`DEFAULT_LOOKBACK_MS`,
  `apps/api/src/jobs/huntressSync.ts:37`); later runs start at `lastSyncAt − 60s`
  (`huntressSync.ts:821`); the client's pagination has a ceiling with no
  completeness metadata (`apps/api/src/services/huntressClient.ts:517`). So the
  artifact prints the window it **actually** covers — derived from
  `huntress_integrations.last_sync_at` and the earliest `reported_at` held — and
  says so rather than implying "every incident".
- **`details` jsonb is never rendered.** Section 3 shows the normalized
  `recommendation` text Huntress supplies; the raw payload stays out of the
  artifact (it is `excludedOpen` in the export policy for exactly this reason).
- **The window comes from `EvidenceRunContext`, never from `now()`** (W01, OD-11).
  When the context is absent (an ad-hoc staff run) the generator falls back to the
  config's date range and says so in `summary.coverage`.
- **Site scope is applied in every query branch independently.** Incidents link to
  a **nullable** `device_id`; under a restricted authority the report filters by
  `devices.site_id` and **excludes** incidents with a NULL `device_id`
  (unattributable), disclosing the excluded count in the data-gap line rather than
  dropping them silently.
- **`threat_detection_review` stays out of `PORTAL_REPORT_TYPES`** and out of the
  two duplicated portal-user execution allowlists in
  `apps/api/src/services/reportGenerationService.ts` (`:248-254`, `:760-765`).
  OD-10 = A: the customer sees and downloads what the plan produced but cannot
  generate it.
- **`PortalRunDto.type` and the portal `ReportRunList` union must be widened.**
  `portalRunListPredicate` has no type filter, so an unwidened union is a type lie
  the compiler cannot see, because the value comes from the database. This is a
  per-wave task, not a one-off.
- **Rendering is proved on all three paths from the same stored result.** A type
  with no `buildReportPdf` arm silently falls through to `renderGenericReport`
  (`packages/shared/src/reportPdf/reportPdf.ts:2018-2020`) and drops the entire
  designed summary — **no unit test catches that**, so this wave ships an explicit
  server-side PDF test.
- **The eight locale files localize the web UI only.** The PDF renderer is
  English. Do not claim a localized artifact in the PR body.
- Migration filenames must sort after the newest on `origin/main` — re-check at
  the start of this wave, not at plan time.
- Run one API test file as `cd apps/api && npx vitest run <path>`. **Never**
  `pnpm --filter <pkg> test -- --run <path>`.
- Branch `feature/<parent#>-service-plan-evidence-reports/wave-<W02 sub-issue#>`,
  **targeting `main`**. PR body contains `Closes #<W02 sub-issue>`.

---

## File structure

| Path | Responsibility |
|---|---|
| `apps/api/migrations/2026-10-17-091000-report-type-threat-detection-review.sql` | enum add, **alone in the file** |
| `apps/api/src/db/schema/reports.ts` | the enum literal |
| `apps/api/src/services/reportGenerationService.ts` (+ `.test.ts`) | `ReportType` union + both exhaustive switches |
| `apps/api/src/services/managedEvidenceRegistry.ts` (+ `.test.ts`) | the wave's one registry entry |
| `packages/shared/src/validators/deliverableTemplates.ts` | `MANAGED_EVIDENCE_REPORT_TYPES` gains its first member |
| `apps/api/src/routes/reports/schemas.ts` (+ `schemas.config.test.ts`) | `threatDetectionConfigSchema` + `…ConfigFields` |
| `apps/api/src/services/threatDetectionReport.ts` (+ `.test.ts`) | the generator |
| `packages/shared/src/types/threatDetectionReport.ts` | the summary type |
| `packages/shared/src/utils/threatDetection.ts` (+ `.test.ts`) | arithmetic shared by API, PDF and web |
| `packages/shared/src/reportPdf/threatDetectionPdf.ts` | the renderer |
| `packages/shared/src/reportPdf/reportPdf.ts` (+ `reportPdf.threatDetection.test.ts`) | `buildReportPdf` arm + `REPORT_TYPE_LABELS` |
| `packages/shared/src/{types,utils,reportPdf}/index.ts` | barrel exports |
| `apps/api/src/services/portal/reportsSelfService.ts` | `PORTAL_DEFINITIONS` entry |
| `packages/shared/src/types/portalVisibility.ts` | `PortalRunDto.type` widened |
| `apps/portal/src/components/portal/ReportRunList.tsx` (+ `.test.tsx`) | label only, no generate button |
| `apps/web/src/components/reports/*.tsx` | six wiring points |
| `apps/web/src/locales/*/reports.json` | three key blocks × 8 locales |
| `apps/api/src/__tests__/integration/threatDetectionEvidence.integration.test.ts` | sweep → evidence, end to end |

---

### Task 1: Enum migration

**Files:**
- Create: `apps/api/migrations/2026-10-17-091000-report-type-threat-detection-review.sql`

**Interfaces:**
- Produces: the `report_type` label `'threat_detection_review'`.

**Alone in the file, and nothing else in it.** `autoMigrate` wraps each file in one
transaction, and a label added by `ALTER TYPE` cannot be *used* until that
transaction commits. Precedent:
`apps/api/migrations/2026-10-16-180700-report-type-hardware-lifecycle.sql`.

- [ ] **Step 1: Re-check the newest migration on `origin/main`**

Run:
```bash
git fetch origin main --quiet
git ls-tree --name-only origin/main apps/api/migrations/ | sort | tail -3
```
Expected: W01's `2026-10-17-0903…` or later. If main gained something later than
`2026-10-17-0910…`, rename this file upward before writing it.

- [ ] **Step 2: Write the migration**

```sql
-- Threat Detection Review report: the report type (#5784 W02). Enum add ONLY,
-- in its own file: a label added by ALTER TYPE cannot be used until the
-- transaction that added it commits, and autoMigrate wraps each file in one
-- transaction (precedent: 2026-10-16-180700-report-type-hardware-lifecycle.sql).
-- No rows are written, so no breeze.scope election is required. Idempotent.
ALTER TYPE report_type ADD VALUE IF NOT EXISTS 'threat_detection_review';
```

- [ ] **Step 3: Run the guards and apply twice**

Run:
```bash
scripts/check-migration-naming.sh --against-ref origin/main
cd apps/api && npx vitest run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts
pnpm test-stack up
DATABASE_URL=$(grep DATABASE_URL .env.test | cut -d= -f2-) pnpm db:migrate
DATABASE_URL=$(grep DATABASE_URL .env.test | cut -d= -f2-) pnpm db:migrate
```
Expected: guards PASS; the second migrate run is a clean no-op. **Never** add this
file to `migrationRlsScope.test.ts`'s frozen baseline — it writes no rows.

- [ ] **Step 4: Commit**

```bash
git add apps/api/migrations/2026-10-17-091000-report-type-threat-detection-review.sql
git commit -m "feat(reports): threat_detection_review report type enum label (#5784 W02)"
```

---

### Task 2: Type plumbing — enum literal, union, both exhaustive switches, registry entry

**Files:**
- Modify: `apps/api/src/db/schema/reports.ts` (the `pgEnum('report_type', [...])` at `:22-40`)
- Modify: `apps/api/src/services/reportGenerationService.ts` (`ReportType` at `:19-45`; the dispatch switch; `zeroSafeReport` at `:808-854`)
- Modify: `apps/api/src/services/reportGenerationService.test.ts` (`REPORT_TYPES` at `:27-36`)
- Modify: `apps/api/src/services/managedEvidenceRegistry.ts` (+ `.test.ts`)
- Modify: `packages/shared/src/validators/deliverableTemplates.ts`

**Interfaces:**
- Consumes: W01's `MANAGED_EVIDENCE_REGISTRY`, `ManagedEvidenceEntry`.
- Produces: `ReportType` gains `'threat_detection_review'`;
  `MANAGED_EVIDENCE_REGISTRY.threat_detection_review`;
  `MANAGED_EVIDENCE_REPORT_TYPES` gains its first member.

**Typecheck does most of the work here.** Both switches end in a `never` default
(`reportGenerationService.ts`'s dispatch and `zeroSafeReport`), so a missed arm is
a typecheck failure rather than a runtime bug. The drift guard at
`reportGenerationService.test.ts:269-275` pins the hand-written union against
`reportTypeEnum.enumValues` and fails if only one of the two is edited.

- [ ] **Step 1: Run the drift guard to watch it fail**

Add `'threat_detection_review'` to the `pgEnum` in `apps/api/src/db/schema/reports.ts`
**only**, then run:
`cd apps/api && npx vitest run src/services/reportGenerationService.test.ts`
Expected: FAIL on *"the API-local ReportType union covers exactly the DB enum"* —
proof the guard is live before you satisfy it.

- [ ] **Step 2: Add the union member and both switch arms**

In `reportGenerationService.ts`, append to the `ReportType` union:

```ts
  // #5784 W02. Service-plan evidence: Huntress incidents for the occurrence's
  // period, with an explicit coverage window. Generated on demand and by the
  // managed-evidence system path; see services/threatDetectionReport.ts.
  | 'threat_detection_review'
```

In the dispatch switch, next to the `hardware_lifecycle` arm:

```ts
    case 'threat_detection_review': {
      const { generateThreatDetectionReport } = await import('./threatDetectionReport');
      return generateThreatDetectionReport(orgId, config, authority, evidence);
    }
```

The `await import(...)` is deliberate: it keeps a heavy generator out of the hot
path and avoids the module cycle back to `assertReportExecutionPreflight`.

In `zeroSafeReport`, add `threat_detection_review` to the `emptyRowsReport()`
group alongside `hardware_lifecycle`. It is **not** a stored-artifact-only type:
a restricted authority with zero sites gets an empty-but-shaped result, not a
throw.

In `reportGenerationService.test.ts`, add `'threat_detection_review'` to the
hand-maintained `REPORT_TYPES` array at `:27-36` (**not** to
`STORED_ARTIFACT_ONLY_TYPES`).

- [ ] **Step 3: Add the registry entry**

In `apps/api/src/services/managedEvidenceRegistry.ts`, replace the
`// W02 adds …` comment with:

```ts
  threat_detection_review: {
    type: 'threat_detection_review',
    definitionName: `${MANAGED_EVIDENCE_DEFINITION_NAME_PREFIX}Threat detection review`,
    defaultConfig: { sites: [], includeCarriedIn: true },
  },
```

`MANAGED_EVIDENCE_DEFINITION_NAME_PREFIX` is declared later in the same module —
move the constant above the registry object so it is in scope, or inline the
string. Prefer moving it; one definition of the prefix.

In `packages/shared/src/validators/deliverableTemplates.ts`, replace W01's
placeholder `z.string().nullable().optional()` + always-failing `.refine` with the
real enum, now that the tuple is non-empty:

```ts
/**
 * Managed evidence report types (#5784). Hand-parallel to
 * `MANAGED_EVIDENCE_REGISTRY` in apps/api and pinned to it by
 * `managedEvidenceRegistry.test.ts` — the validator cannot import from apps/api.
 */
export const MANAGED_EVIDENCE_REPORT_TYPES = ['threat_detection_review'] as const;
```

and in `templateItemFieldTypes`:

```ts
  autoEvidenceReportType: z.enum(MANAGED_EVIDENCE_REPORT_TYPES).nullable().optional(),
```

- [ ] **Step 4: Remove W01's `as never` casts**

W01's Task 6 route test and Task 11 validator tests used
`'threat_detection_review' as never` because the label did not exist yet.
`grep -rn "threat_detection_review' as never" apps/api packages/shared` and remove
every cast — the literal is now a real member of both the pg enum and the
validator tuple.

- [ ] **Step 5: Run the guards to verify they pass**

Run:
```bash
cd apps/api && npx vitest run src/services/reportGenerationService.test.ts src/services/managedEvidenceRegistry.test.ts
npx tsc --noEmit -p tsconfig.json
cd ../../packages/shared && npx vitest run src/validators/deliverableTemplates.test.ts
```
Expected: PASS. The typecheck should now complain about nothing — if it complains
about a missing switch arm somewhere unexpected, **that is the `never` default
doing its job**; add the arm rather than casting.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/db/schema/reports.ts apps/api/src/services/reportGenerationService.ts apps/api/src/services/reportGenerationService.test.ts apps/api/src/services/managedEvidenceRegistry.ts apps/api/src/services/managedEvidenceRegistry.test.ts packages/shared/src/validators/deliverableTemplates.ts
git commit -m "feat(reports): wire threat_detection_review into the type system and managed registry (#5784 W02)"
```

---

### Task 3: Config schema and its test-pinned parallel field list

**Files:**
- Modify: `apps/api/src/routes/reports/schemas.ts`
- Modify: `apps/api/src/routes/reports/schemas.config.test.ts`

**Interfaces:**
- Produces: `threatDetectionConfigSchema` (with `.default()`s, used at generation
  time) and `threatDetectionConfigFields` (without, used for persistence), spread
  into `reportConfigFields` and `generateReportSchema.config`.

**Two parallel objects, and a test that pins them.** The repo keeps a
`…ConfigSchema` **and** a `…ConfigFields` for each curated type, because the
persistence schema must not apply defaults that would silently rewrite a saved
config. `schemas.config.test.ts:91-101` asserts
`Object.keys(fields).sort()` equals `Object.keys(schema.shape).sort()`; a key
added to one and not the other fails there.

- [ ] **Step 1: Write the failing parity test**

Append to `apps/api/src/routes/reports/schemas.config.test.ts`:

```ts
it('keeps the threat detection persistence fields in sync with the generation schema', () => {
  expect(Object.keys(threatDetectionConfigFields).sort()).toEqual(
    Object.keys(threatDetectionConfigSchema.shape).sort(),
  );
});

it('defaults a threat detection config', () => {
  expect(threatDetectionConfigSchema.parse({})).toEqual({
    sites: [], includeCarriedIn: true, topIncidents: 100,
  });
});

it('rejects an out-of-range topIncidents', () => {
  expect(() => threatDetectionConfigSchema.parse({ topIncidents: 0 })).toThrow();
  expect(() => threatDetectionConfigSchema.parse({ topIncidents: 1001 })).toThrow();
});
```

Add the two imports at the top of the file next to the existing
`hardwareLifecycleConfigFields` / `hardwareLifecycleConfigSchema` imports.

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/routes/reports/schemas.config.test.ts`
Expected: FAIL — the two exports do not exist.

- [ ] **Step 3: Add the schema, the fields and the enum literal**

In `apps/api/src/routes/reports/schemas.ts`, add `'threat_detection_review'` to
`reportTypeSchema` (`:13-31`) with a one-line comment, then after the
`hardwareLifecycle` pair (`:82-105`):

```ts
/**
 * Config for the Threat Detection Review report (#5784 W02). `topIncidents`
 * caps the incident table so one noisy month cannot produce a 400-page PDF; the
 * artifact states the cap and the number withheld rather than truncating
 * silently. `includeCarriedIn` controls the "opened before the period and still
 * unresolved" section.
 */
export const threatDetectionConfigSchema = z.object({
  sites: z.array(z.string().guid()).optional().default([]),
  includeCarriedIn: z.boolean().optional().default(true),
  topIncidents: z.number().int().min(1).max(1000).optional().default(100),
});

/** Same keys as `threatDetectionConfigSchema` without `.default()`s — see
 *  `securityCompliancePostureConfigFields` for why the two are hand-parallel
 *  and test-pinned (schemas.config.test.ts). */
export const threatDetectionConfigFields = {
  sites: z.array(z.string().guid()).optional(),
  includeCarriedIn: z.boolean().optional(),
  topIncidents: z.number().int().min(1).max(1000).optional(),
};
```

Spread `...threatDetectionConfigFields` into **both** `reportConfigFields`
(`:125-151`, next to `...hardwareLifecycleConfigFields`) **and**
`generateReportSchema.config` (`:182-202`, same place).

- [ ] **Step 4: Run to verify it passes, then commit**

Run: `cd apps/api && npx vitest run src/routes/reports/schemas.config.test.ts`
Expected: PASS.

```bash
git add apps/api/src/routes/reports/schemas.ts apps/api/src/routes/reports/schemas.config.test.ts
git commit -m "feat(reports): threat_detection_review config schema and parallel field list (#5784 W02)"
```

---

### Task 4: The shared summary type and arithmetic

**Files:**
- Create: `packages/shared/src/types/threatDetectionReport.ts`
- Create: `packages/shared/src/utils/threatDetection.ts` (+ `.test.ts`)
- Modify: `packages/shared/src/types/index.ts`, `packages/shared/src/utils/index.ts`

**Interfaces:**
- Produces: `ThreatDetectionSummary`, `ThreatIncidentRow`, `ThreatCoverage`,
  `SEVERITY_ORDER`, `resolutionStats(rows)`, `countBy(rows, key)`,
  `coverageGapLine(coverage)`.
- Consumed by: the API generator (Task 5, with `satisfies`), the PDF renderer
  (Task 6) and the web preview (Task 8) — all three must agree, which is the
  reason the arithmetic lives here and not in any one of them.

- [ ] **Step 1: Write the summary type**

```ts
// packages/shared/src/types/threatDetectionReport.ts
/**
 * Canonical shape of the Threat Detection Review report's `summary` snapshot
 * (#5784 W02). Single-sourced: the API produces it with `satisfies`, the shared
 * PDF renderer and the web preview consume it, and it is persisted in
 * report_runs.result — so EVERY field is optional and a legacy snapshot must
 * still render. Mirrors hardwareLifecycleReport.ts.
 *
 * Nulls are load-bearing. `incidentsOpened: null` means UNMEASURED (no active
 * Huntress integration, or the period predates the first sync), never zero. A
 * report that prints "0 incidents" when Huntress was never connected is a lie
 * the customer will act on.
 */

/** Per-source availability, printed on the cover and machine-readable. */
export type ThreatSourceStatus = 'ok' | 'not_connected' | 'never_synced' | 'stale';

/**
 * The window the artifact ACTUALLY covers, which is not always the period.
 * Huntress's first sync fetches 24 hours only and later runs resume from
 * `lastSyncAt - 60s`, so a period that begins before the integration was
 * connected — or spans a sync outage — is covered in part.
 */
export type ThreatCoverage = {
  /** Occurrence period (ISO dates), or the config date range for an ad-hoc run. */
  periodStart?: string;
  periodEnd?: string;
  /** What the data actually spans. `coveredFrom > periodStart` means a gap. */
  coveredFrom?: string | null;
  coveredTo?: string | null;
  /** Generation ran at this instant. On a due-day run it PRECEDES periodEnd. */
  generatedAt?: string;
  sourceStatus?: ThreatSourceStatus;
  /** `huntress_integrations.last_sync_at` / `last_sync_status`. */
  lastSyncAt?: string | null;
  lastSyncStatus?: string | null;
  /** Incidents excluded because device_id is NULL under a restricted authority. */
  unattributableExcluded?: number;
  /** Incidents beyond `topIncidents`, disclosed rather than silently dropped. */
  withheld?: number;
  /** One human sentence naming every gap above. Rendered verbatim. */
  note?: string;
};

export type ThreatIncidentRow = {
  id: string;
  reportedAt: string;
  hostname: string | null;
  severity: string | null;
  category: string | null;
  title: string | null;
  status: string | null;
  resolvedAt: string | null;
  /** Huntress's normalized remediation text. The raw `details` jsonb is NEVER
   *  rendered — it is excludedOpen in the export policy for the same reason. */
  recommendation: string | null;
  /** True when this incident opened before periodStart and is still unresolved. */
  carriedIn?: boolean;
};

export type ThreatDetectionSummary = {
  orgId?: string;
  orgName?: string | null;
  generatedAt?: string;
  coverage?: ThreatCoverage;
  /** null = unmeasured. */
  agentCoverage?: {
    huntressAgents: number | null;
    breezeDevices: number | null;
    agentsOffline: number | null;
    devicesWithoutAgent: number | null;
  };
  incidents?: {
    opened: number | null;
    resolved: number | null;
    bySeverity: Record<string, number> | null;
    byStatus: Record<string, number> | null;
    meanResolveHours: number | null;
    medianResolveHours: number | null;
    carriedIn: number | null;
  };
  rows?: ThreatIncidentRow[];
  /** Short sentences the renderer prints verbatim. */
  dataGaps?: string[];
};
```

- [ ] **Step 2: Write the failing utils test**

```ts
// packages/shared/src/utils/threatDetection.test.ts
import { describe, it, expect } from 'vitest';
import { resolutionStats, countBy, coverageGapLine } from './threatDetection';

describe('resolutionStats', () => {
  it('returns nulls for an empty set — unmeasured, not zero', () => {
    expect(resolutionStats([])).toEqual({ meanResolveHours: null, medianResolveHours: null });
  });

  it('ignores unresolved incidents rather than counting them as instant', () => {
    const stats = resolutionStats([
      { reportedAt: '2026-09-01T00:00:00Z', resolvedAt: '2026-09-01T02:00:00Z' },
      { reportedAt: '2026-09-02T00:00:00Z', resolvedAt: null },
    ] as never);
    expect(stats.meanResolveHours).toBe(2);
  });

  it('takes the middle value for an odd count and the mean of the middle two for even', () => {
    const odd = resolutionStats([[0, 1], [0, 3], [0, 11]].map(hoursRow) as never);
    expect(odd.medianResolveHours).toBe(3);
    const even = resolutionStats([[0, 1], [0, 3], [0, 5], [0, 11]].map(hoursRow) as never);
    expect(even.medianResolveHours).toBe(4);
  });
});

describe('coverageGapLine', () => {
  it('is empty when the covered window equals the period and nothing was withheld', () => {
    expect(coverageGapLine({ periodStart: '2026-09-01', periodEnd: '2026-09-30', coveredFrom: '2026-09-01', coveredTo: '2026-09-30', sourceStatus: 'ok' })).toBe('');
  });

  it('names the shortfall when coverage starts after the period', () => {
    const line = coverageGapLine({ periodStart: '2026-09-01', periodEnd: '2026-09-30', coveredFrom: '2026-09-14', sourceStatus: 'ok' });
    expect(line).toMatch(/2026-09-14/);
    expect(line).toMatch(/does not cover/i);
  });

  it('says the source is unmeasured, never that there were no incidents', () => {
    const line = coverageGapLine({ sourceStatus: 'not_connected' });
    expect(line).toMatch(/not connected/i);
    expect(line).not.toMatch(/\bno incidents\b/i);
  });
});

function hoursRow([from, to]: number[]) {
  return { reportedAt: new Date(from * 3600_000).toISOString(), resolvedAt: new Date(to * 3600_000).toISOString() };
}
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd packages/shared && npx vitest run src/utils/threatDetection.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Write the utils**

Implement `resolutionStats`, `countBy`, `coverageGapLine` and `SEVERITY_ORDER`
(`['critical','high','medium','low','info']`) in
`packages/shared/src/utils/threatDetection.ts`. `resolutionStats` returns
`{ meanResolveHours: null, medianResolveHours: null }` for zero resolved
incidents — **never** `0`. `coverageGapLine` returns `''` only when the source is
`ok` **and** the covered window spans the period **and** nothing was withheld or
excluded; otherwise it names each shortfall in one sentence.

Export both modules from `packages/shared/src/types/index.ts` and
`packages/shared/src/utils/index.ts` next to the `hardwareLifecycle` lines.

- [ ] **Step 5: Run to verify it passes, then commit**

Run: `cd packages/shared && npx vitest run src/utils/threatDetection.test.ts && npx tsc --noEmit`
Expected: PASS, clean.

```bash
git add packages/shared/src/types/threatDetectionReport.ts packages/shared/src/types/index.ts packages/shared/src/utils/threatDetection.ts packages/shared/src/utils/threatDetection.test.ts packages/shared/src/utils/index.ts
git commit -m "feat(shared): threat detection report summary type and shared arithmetic (#5784 W02)"
```

---

### Task 5: The generator

**Files:**
- Create: `apps/api/src/services/threatDetectionReport.ts`
- Create: `apps/api/src/services/threatDetectionReport.test.ts`

**Interfaces:**
- Consumes: `threatDetectionConfigSchema` (Task 3); `ThreatDetectionSummary`,
  `resolutionStats`, `countBy`, `coverageGapLine` (Task 4);
  `assertReportExecutionPreflight`, `type ReportGenerationAuthority`,
  `type EvidenceRunContext`, `type ReportResult` (W01 Task 4);
  `huntressIncidents`, `huntressAgents`, `huntressIntegrations`
  (`apps/api/src/db/schema/huntress.ts`), `devices`, `organizations`.
- Produces:
  `generateThreatDetectionReport(orgId, rawConfig, authority, evidence?): Promise<ReportResult>`.

**Reader discipline (spec §3.1 rule 4).** Model the loaders on
`apps/api/src/services/securityComplianceReportVulnerabilities.ts` — a pure
aggregator plus a thin loader on plain `db` that **throws** rather than silently
undercounting on a missing join. Do **not** reuse
`apps/api/src/services/aiAgents/sweepEvidence.ts`: it caps at 25 rows/kind and
12 KB, excludes every jsonb/text column by design, and **requires a pre-held
SYSTEM context** — a tenant-isolation hazard in a request path. No module from
`#5751` is imported.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/services/threatDetectionReport.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
// Mock ../db with the chainable shape this repo already uses — copy it from
// apps/api/src/services/hardwareLifecycleReport.test.ts rather than inventing one.

const AUTH_UNRESTRICTED = {
  principalKind: 'user' as const,
  principalUserId: 'u1',
  scope: { version: 1 as const, kind: 'unrestricted' as const, orgId: ORG },
  capturedAt: new Date(),
  fingerprint: 'fp',
};

describe('generateThreatDetectionReport', () => {
  beforeEach(() => { /* reset the mock rows */ });

  it('renders a whole-report data gap when no active Huntress integration exists', async () => {
    integrationRows.length = 0;
    const res = await generateThreatDetectionReport(ORG, {}, AUTH_UNRESTRICTED);
    const s = res.summary as ThreatDetectionSummary;
    expect(s.coverage?.sourceStatus).toBe('not_connected');
    // The load-bearing assertion: unmeasured, NOT zero.
    expect(s.incidents?.opened).toBeNull();
    expect(res.rows).toEqual([]);
    expect(s.dataGaps?.join(' ')).toMatch(/not connected/i);
  });

  it('uses the occurrence period, not now(), when an evidence context is given', async () => {
    const res = await generateThreatDetectionReport(ORG, {}, AUTH_UNRESTRICTED, {
      periodStart: '2026-09-01', periodEnd: '2026-09-30',
      generatedAt: '2026-09-30T05:18:00Z', deliverableId: 'd1',
    });
    const s = res.summary as ThreatDetectionSummary;
    expect(s.coverage?.periodStart).toBe('2026-09-01');
    expect(s.coverage?.periodEnd).toBe('2026-09-30');
    // Generation is on the DUE DAY, so it precedes the period end. The artifact
    // must say so rather than implying the whole period was observed.
    expect(s.coverage?.generatedAt).toBe('2026-09-30T05:18:00Z');
    expect(s.coverage?.note).toBeTruthy();
  });

  it('states the actual coverage window when the integration synced mid-period', async () => {
    integrationRows.push({ lastSyncAt: new Date('2026-09-30T05:00:00Z'), lastSyncStatus: 'ok' });
    earliestReportedAt = '2026-09-14T00:00:00Z';
    const res = await generateThreatDetectionReport(ORG, {}, AUTH_UNRESTRICTED, PERIOD_SEP);
    const s = res.summary as ThreatDetectionSummary;
    expect(s.coverage?.coveredFrom).toBe('2026-09-14T00:00:00Z');
    expect(s.dataGaps?.join(' ')).toMatch(/does not cover/i);
  });

  it('excludes unattributable incidents under a restricted authority and discloses the count', async () => {
    const restricted = { ...AUTH_UNRESTRICTED, scope: { version: 1 as const, kind: 'restricted' as const, orgId: ORG, siteIds: ['s1'] } };
    incidentRows.push({ id: 'i1', deviceId: null }, { id: 'i2', deviceId: 'dev1', siteId: 's1' });
    const res = await generateThreatDetectionReport(ORG, {}, restricted, undefined);
    expect((res.rows as ThreatIncidentRow[]).map((r) => r.id)).toEqual(['i2']);
    expect((res.summary as ThreatDetectionSummary).coverage?.unattributableExcluded).toBe(1);
  });

  it('returns an empty-but-shaped result for a restricted authority with zero sites', async () => {
    const zero = { ...AUTH_UNRESTRICTED, scope: { version: 1 as const, kind: 'restricted' as const, orgId: ORG, siteIds: [] } };
    const res = await generateThreatDetectionReport(ORG, {}, zero);
    expect(res.rows).toEqual([]);
    expect(res.rowCount).toBe(0);
    expect(res.summary).toBeTruthy();
  });

  it('never renders the raw details jsonb', async () => {
    incidentRows.push({ id: 'i1', deviceId: 'dev1', details: { secret: 'do-not-render' }, recommendation: 'Isolate the host' });
    const res = await generateThreatDetectionReport(ORG, {}, AUTH_UNRESTRICTED);
    expect(JSON.stringify(res)).not.toMatch(/do-not-render/);
    expect((res.rows as ThreatIncidentRow[])[0].recommendation).toBe('Isolate the host');
  });

  it('caps the incident table at topIncidents and discloses the number withheld', async () => {
    for (let i = 0; i < 150; i += 1) incidentRows.push({ id: `i${i}`, deviceId: 'dev1' });
    const res = await generateThreatDetectionReport(ORG, { topIncidents: 100 }, AUTH_UNRESTRICTED);
    expect(res.rows).toHaveLength(100);
    expect((res.summary as ThreatDetectionSummary).coverage?.withheld).toBe(50);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && npx vitest run src/services/threatDetectionReport.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the generator**

Structure, following `hardwareLifecycleReport.ts:131-163` exactly:

```ts
export async function generateThreatDetectionReport(
  orgId: string,
  rawConfig: Record<string, unknown>,
  authority: ReportGenerationAuthority,
  evidence?: EvidenceRunContext,
): Promise<ReportResult> {
  const cfg = threatDetectionConfigSchema.parse(rawConfig ?? {});
  const generatedAt = evidence?.generatedAt ?? new Date().toISOString();

  assertReportExecutionPreflight(orgId, cfg, authority, 'threat_detection_review');

  const restrictedScope = authority.scope.kind === 'restricted' ? authority.scope : null;
  if (restrictedScope && restrictedScope.siteIds.length === 0) {
    return { rows: [], rowCount: 0, generatedAt, summary: emptySummary(orgId, generatedAt, evidence) };
  }

  // 1. Source availability FIRST. An org whose partner has no active Huntress
  //    integration gets a single data-gap page, never an empty incident table.
  //    huntress_integrations is PARTNER-scoped (partner_id NOT NULL); the
  //    incident and agent data is ORG-scoped. Read the org axis for data and the
  //    partner axis only for freshness.
  // 2. Period window: evidence?.periodStart/periodEnd, else the config date range.
  // 3. Agent coverage: huntress_agents vs devices; HUNTRESS_OFFLINE_STATUSES;
  //    devices with no Huntress agent.
  // 4. Incidents opened in the window; counts by severity and status;
  //    resolutionStats over reported_at -> resolved_at.
  // 5. Carried in: opened before periodStart AND still unresolved (cfg.includeCarriedIn).
  // 6. Rows, capped at cfg.topIncidents, `withheld` disclosed.
  // 7. coverage.coveredFrom = MIN(reported_at) held for the org; coveredTo =
  //    huntress_integrations.last_sync_at. note = coverageGapLine(coverage).
}
```

**The site filter goes in EVERY query branch independently** — the agent-coverage
query, the incident-count query, the carried-in query and the row query each push
their own `inArray(devices.siteId, …)` conditions, once for `cfg.sites` and once
for `restrictedScope.siteIds`. Do not compute a device-id list once and reuse it:
that is how a branch silently loses its filter when someone edits one query later.

Under a restricted authority, incidents with `device_id IS NULL` are
**unattributable** and excluded; count them and put the count in
`coverage.unattributableExcluded`. Under an unrestricted authority they are
included.

Return `summary` typed with `satisfies ThreatDetectionSummary` so a field renamed
in `packages/shared` breaks the build here rather than silently emptying a PDF
section.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/api && npx vitest run src/services/threatDetectionReport.test.ts && npx tsc --noEmit -p tsconfig.json`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/threatDetectionReport.ts apps/api/src/services/threatDetectionReport.test.ts
git commit -m "feat(reports): threat detection review generator with explicit coverage disclosure (#5784 W02)"
```

---

### Task 6: The PDF renderer and its `buildReportPdf` arm

**Files:**
- Create: `packages/shared/src/reportPdf/threatDetectionPdf.ts`
- Create: `packages/shared/src/reportPdf/reportPdf.threatDetection.test.ts`
- Modify: `packages/shared/src/reportPdf/reportPdf.ts`, `packages/shared/src/reportPdf/index.ts`

**Interfaces:**
- Consumes: `ThreatDetectionSummary` (Task 4); `PdfChrome` (the chrome contract
  `hardwareLifecyclePdf.ts` declares — copy its shape, do not import reportPdf.ts
  back or you create a cycle).
- Produces: `renderThreatDetectionReport(doc, summary, opts, chrome)`;
  `REPORT_TYPE_LABELS.threat_detection_review`; a `buildReportPdf` arm.

**The silent failure this task exists to prevent.** `buildReportPdf`'s final
`else` (`packages/shared/src/reportPdf/reportPdf.ts:2018-2020`) falls through to
`renderGenericReport`, which prints the rows as a plain table and **drops the
entire designed summary**. A type with no arm therefore produces a
plausible-looking, wrong PDF, and **no unit test catches it** unless one is written
for the arm specifically. Both the portal (server-side `renderRunPdf`) and the
scheduled email go through this path.

- [ ] **Step 1: Write the failing renderer test**

```ts
// packages/shared/src/reportPdf/reportPdf.threatDetection.test.ts
import { describe, it, expect, vi } from 'vitest';
import { buildReportPdf } from './reportPdf';
import * as threat from './threatDetectionPdf';

const SUMMARY = { /* a minimal ThreatDetectionSummary with rows: [] */ };

describe('buildReportPdf: threat_detection_review', () => {
  it('routes to the threat detection renderer, not renderGenericReport', () => {
    const spy = vi.spyOn(threat, 'renderThreatDetectionReport');
    buildReportPdf([], { reportType: 'threat_detection_review', generatedAt: 'x', timezone: 'UTC', summary: SUMMARY });
    expect(spy).toHaveBeenCalledOnce();
  });

  it('prints the coverage window on the cover, verbatim from summary.coverage.note', () => {
    const doc = buildReportPdf([], { reportType: 'threat_detection_review', generatedAt: 'x', timezone: 'UTC',
      summary: { ...SUMMARY, coverage: { note: 'Covers 2026-09-14 to 2026-09-30; the period began before Huntress was connected.' } } });
    const text = doc.getTextContent?.() ?? extractText(doc);
    expect(text).toMatch(/began before Huntress was connected/);
  });

  it('renders an unmeasured section as N/A, never as zero', () => {
    const doc = buildReportPdf([], { reportType: 'threat_detection_review', generatedAt: 'x', timezone: 'UTC',
      summary: { ...SUMMARY, incidents: { opened: null, resolved: null, bySeverity: null, byStatus: null, meanResolveHours: null, medianResolveHours: null, carriedIn: null } } });
    const text = extractText(doc);
    expect(text).toMatch(/N\/A/);
    expect(text).not.toMatch(/\b0 incidents\b/);
  });

  it('falls through to the generic renderer when the summary is absent', () => {
    const spy = vi.spyOn(threat, 'renderThreatDetectionReport');
    buildReportPdf([{ a: 1 }], { reportType: 'threat_detection_review', generatedAt: 'x', timezone: 'UTC' });
    expect(spy).not.toHaveBeenCalled();
  });
});
```

Copy `extractText` (or whatever text-extraction helper) from
`packages/shared/src/reportPdf/reportPdf.hardwareLifecycle.test.ts` — do not
invent a second one.

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/shared && npx vitest run src/reportPdf/reportPdf.threatDetection.test.ts`
Expected: FAIL — `./threatDetectionPdf` does not exist.

- [ ] **Step 3: Write the renderer**

Model it on `packages/shared/src/reportPdf/hardwareLifecyclePdf.ts`: a module
doc-comment naming the reader, a `PdfChrome` parameter carrying
`{ C, PAGE, drawHeaderBand, drawFooter, drawTitleBlock, drawSectionHeading }`, and
**no import back into `reportPdf.ts`**. Sections, in order: cover + coverage note;
agent coverage; incident summary; the incident table (autoTable, paginating via
`didDrawPage`); carried-in; changes since last period from `opts.previous`.

Every unmeasured value prints `N/A` with its reason. Every colour is paired with a
word — the reader is the customer's office manager, not a technician.

- [ ] **Step 4: Add the arm and the label**

In `reportPdf.ts`, add to `REPORT_TYPE_LABELS` (`:165-171`):

```ts
  threat_detection_review: 'Threat Detection Review',
```

and an arm immediately before the final `else`, following the
`hardware_lifecycle` shape (`:1996-2017`) — guard on the summary being present
and shaped, draw the header band and footer, then delegate:

```ts
  } else if (
    opts.reportType === 'threat_detection_review'
    && opts.summary
    && typeof (opts.summary as ThreatDetectionSummary).coverage === 'object'
  ) {
    drawHeaderBand(doc, opts);
    drawFooter(doc, opts);
    renderThreatDetectionReport(
      doc,
      opts.summary as ThreatDetectionSummary,
      { generatedAt: opts.generatedAt, partnerName: opts.branding?.name ?? null, contactEmail: opts.branding?.contactEmail ?? null, contactName: opts.branding?.contactName ?? null, previous: opts.previous },
      { C, PAGE, drawHeaderBand: (d) => drawHeaderBand(d, opts), drawFooter: (d) => drawFooter(d, opts), drawTitleBlock, drawSectionHeading },
    );
  } else if (
```

Widen `BuildOpts['summary']` to include `ThreatDetectionSummary` and export the
renderer from `packages/shared/src/reportPdf/index.ts`.

- [ ] **Step 5: Run to verify it passes, then commit**

Run: `cd packages/shared && npx vitest run src/reportPdf/ && npx tsc --noEmit`
Expected: PASS (check the reported file count includes both the new suite and the
existing `reportPdf.*` suites), clean.

```bash
git add packages/shared/src/reportPdf/threatDetectionPdf.ts packages/shared/src/reportPdf/reportPdf.threatDetection.test.ts packages/shared/src/reportPdf/reportPdf.ts packages/shared/src/reportPdf/index.ts
git commit -m "feat(shared): threat detection review PDF renderer and buildReportPdf arm (#5784 W02)"
```

---

### Task 7: Portal provisioning and the two portal unions

**Files:**
- Modify: `apps/api/src/services/portal/reportsSelfService.ts` (+ `.test.ts`)
- Modify: `packages/shared/src/types/portalVisibility.ts`
- Modify: `apps/portal/src/components/portal/ReportRunList.tsx` (+ `.test.tsx`)

**Interfaces:**
- Consumes: `MANAGED_EVIDENCE_REGISTRY.threat_detection_review` (Task 2).
- Produces: a `PORTAL_DEFINITIONS` entry; `PortalRunDto.type` gains the literal;
  the portal component's `ReportType` union and `GENERATING_COPY` map gain it.

**The type lie the compiler cannot see.** `portalRunListPredicate`
(`reportsSelfService.ts:267-277`) filters on org, `portal_self_service` and
`status` — **no type filter**. Its `toDto` (`:279-301`) declares the row's `type`
as `PortalReportType`, the three-value `PORTAL_REPORT_TYPES` union. So a
sweep-generated run of a new type flows through as a value outside the declared
union, and TypeScript cannot catch it because the value comes from the database.
Three things must be widened together: `toDto`'s parameter type,
`PortalRunDto.type`, and the portal component's own union.

**Label only, no generate button.** The type stays out of `PORTAL_REPORT_TYPES`
(which gates `apps/api/src/routes/portal/schemas.ts:183`, the generate request
schema) per OD-10 = A.

- [ ] **Step 1: Write the failing tests**

In `reportsSelfService.test.ts`:

```ts
it('provisions a threat detection definition for an org enabling portal reports', async () => {
  await provisionPortalReportDefinitions({ orgId: ORG, createdBy: USER });
  expect(inserted.map((r) => r.type)).toContain('threat_detection_review');
  expect(inserted.find((r) => r.type === 'threat_detection_review')?.portalSelfService).toBe(true);
});

it('keeps threat_detection_review OUT of the portal generate allowlist', () => {
  expect(PORTAL_REPORT_TYPES).not.toContain('threat_detection_review');
});
```

In `ReportRunList.test.tsx`:

```tsx
it('labels a threat detection run without offering a generate button', () => {
  render(<ReportRunList runs={[{ id: 'r1', type: 'threat_detection_review', status: 'completed', /* … */ }]} />);
  expect(screen.getByText(/threat detection/i)).toBeInTheDocument();
  expect(screen.queryByTestId('portal-generate-threat_detection_review')).toBeNull();
});
```

- [ ] **Step 2: Run to verify they fail**

Run:
```bash
cd apps/api && npx vitest run src/services/portal/reportsSelfService.test.ts
cd ../portal && npx vitest run src/components/portal/ReportRunList.test.tsx
```
Expected: both FAIL.

- [ ] **Step 3: Add the `PORTAL_DEFINITIONS` entry**

In `reportsSelfService.ts`, append to `PORTAL_DEFINITIONS` (`:28-63`), sourcing
name and config from the registry so there is one definition of each:

```ts
  {
    type: 'threat_detection_review',
    name: 'Service evidence — Threat detection review',
    config: { sites: [], includeCarriedIn: true, topIncidents: 100 },
  },
```

Keep the literal config here rather than importing the registry: this array is
`as const` and feeds a Drizzle insert; a divergence between it and
`MANAGED_EVIDENCE_REGISTRY.threat_detection_review.defaultConfig` is caught by a
new assertion in `managedEvidenceRegistry.test.ts`:

```ts
it('PORTAL_DEFINITIONS carries every managed evidence type with the registry config', async () => {
  const { PORTAL_DEFINITIONS_FOR_TEST } = await import('./portal/reportsSelfService');
  for (const [type, entry] of Object.entries(MANAGED_EVIDENCE_REGISTRY)) {
    const def = PORTAL_DEFINITIONS_FOR_TEST.find((d) => d.type === type);
    expect(def, `${type} missing from PORTAL_DEFINITIONS`).toBeTruthy();
    expect(def!.name).toBe(entry.definitionName);
    expect(def!.config).toEqual(entry.defaultConfig);
  }
});
```

Export `PORTAL_DEFINITIONS` (as `PORTAL_DEFINITIONS_FOR_TEST` or plainly) to make
that assertion possible.

- [ ] **Step 4: Widen the three unions**

- `packages/shared/src/types/portalVisibility.ts:246-259` — add
  `| 'threat_detection_review'` to `PortalRunDto.type`.
- `apps/api/src/services/portal/reportsSelfService.ts:279-301` — `toDto`'s `type`
  parameter is `PortalReportType`; widen it to
  `PortalReportType | 'threat_detection_review'` (or better, to
  `PortalRunDto['type']`, which is the value it actually returns — prefer that,
  it removes the next wave's edit).
- `apps/portal/src/components/portal/ReportRunList.tsx:16-27` — add the literal to
  the `ReportType` union **and** a `GENERATING_COPY` entry:
  `threat_detection_review: 'Generating your threat detection review…'`. The map
  is a total `Record<ReportType, string>`, so a missed entry is a typecheck
  failure.

Do **not** add the type to `PORTAL_REPORT_TYPES` (`:131-137`) or to the two
allowlist literals in `reportGenerationService.ts`.

- [ ] **Step 5: Run to verify they pass, then commit**

Run:
```bash
cd apps/api && npx vitest run src/services/portal/ src/services/managedEvidenceRegistry.test.ts
cd ../portal && npx vitest run && pnpm --filter @breeze/portal typecheck
cd ../../packages/shared && npx tsc --noEmit
```
Expected: all PASS.

```bash
git add apps/api/src/services/portal/reportsSelfService.ts apps/api/src/services/portal/reportsSelfService.test.ts apps/api/src/services/managedEvidenceRegistry.test.ts packages/shared/src/types/portalVisibility.ts apps/portal/src/components/portal/ReportRunList.tsx apps/portal/src/components/portal/ReportRunList.test.tsx
git commit -m "feat(portal): provision and label threat detection review runs, no self-serve generate (#5784 W02)"
```

---

### Task 8: Web wiring — six points plus the options form

**Files:**
- Modify: `apps/web/src/components/reports/ReportsList.tsx`, `ReportBuilder.tsx`,
  `ReportTemplates.tsx`, `ReportEditPage.tsx`, `ReportPreview.tsx`,
  `reportTypeSurvivesBuilder.test.ts`
- Create: `apps/web/src/components/reports/ThreatDetectionOptionsForm.tsx` (+ `.test.tsx`)
- Create: `apps/web/src/components/reports/ReportTemplates.threatDetection.test.tsx`

**Interfaces:**
- Produces: `DEFAULT_THREAT_DETECTION_OPTIONS`,
  `ThreatDetectionOptionsFields`, `threatDetectionOptionsFromConfig`,
  `type ThreatDetectionOptions` — the same four exports
  `HardwareLifecycleOptionsForm.tsx` provides, so `ReportEditPage.tsx` wires
  identically.

**`ReportBuilder.tsx` breaks the build until mapped.** Its
`Record<LegacyReportType, BuilderReportType>` (`:160-184`) is exhaustive.
`threat_detection_review` is a curated type with its own options form and is
**not** representable by the freeform builder, so it maps to `'alerts'` (the
closest data source) and `reportTypeSurvivesBuilder` must return **false** for it.

- [ ] **Step 1: Write the failing tests**

In `reportTypeSurvivesBuilder.test.ts`, add:

```ts
// Curated type with its own options form — the builder must not claim to author it.
expect(reportTypeSurvivesBuilder('threat_detection_review')).toBe(false);
```

In a new `ReportTemplates.threatDetection.test.tsx`, mirror
`ReportTemplates.hardwareLifecycle.test.tsx`: clicking the card opens the options
form rather than the builder, and creating sends the curated config.

In `ThreatDetectionOptionsForm.test.tsx`, mirror
`HardwareLifecycleOptionsForm.test.tsx`: every field renders, is bound, and
`threatDetectionOptionsFromConfig` round-trips a saved config.

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/web && npx vitest run src/components/reports/`
Expected: FAIL.

- [ ] **Step 3: Wire the six points**

1. `ReportsList.tsx:36-42` — add `| 'threat_detection_review'` to the `ReportType`
   union. There is **no** hardcoded label map: `getReportTypeLabel` (`:225`) does a
   dynamic i18n lookup on `reports.reportsList.reportTypes.<type>`, so the label
   comes from Task 9's locale keys.
2. `ReportBuilder.tsx:160-184` — add `threat_detection_review: 'alerts',` with a
   comment saying it is curated and the builder never offers it.
3. `ReportTemplates.tsx` — add `'threat_detection_review'` to `reportTypeValues`
   (`:62-74`); add a template card (`:99-114` shape) with an icon and tone; add a
   `handleUseTemplate` branch (`:377-398`) that sets the options state and opens
   the options form, exactly as the `hardware_lifecycle` branch does.
4. `ReportEditPage.tsx` — import the four options-form exports, add
   `const isThreatDetection = report.type === 'threat_detection_review';` and a
   render branch beside `isLifecycle` (`:144-146`).
5. `ReportPreview.tsx` — add a branch beside the `hardware_lifecycle` one
   (`:257-298`) rendering coverage + incident tiles, and add
   `threat_detection_review` to the `data.type !== 'hardware_lifecycle'` guard on
   the generic summary grid so the generic cards do not also render.
6. `reportExport.ts` — **no branch needed**: `exportReport` uses `reportType` only
   for the filename and hands it opaquely to `buildReportPdf`. Widen its `summary`
   union to include `ThreatDetectionSummary` so the staff/browser path passes the
   designed summary through to Task 6's arm rather than dropping it.

- [ ] **Step 4: Write the options form**

`ThreatDetectionOptionsForm.tsx`, modelled on `HardwareLifecycleOptionsForm.tsx`:
a site multi-select, an `includeCarriedIn` checkbox and a `topIncidents` number
input, each with a help line, all i18n'd, all `data-testid`'d.

- [ ] **Step 5: Run to verify they pass**

Run: `cd apps/web && npx vitest run src/components/reports/ && pnpm --filter @breeze/web typecheck`
Expected: PASS, clean. If typecheck complains about `ReportBuilder.tsx`'s
`Record`, that is the exhaustiveness guard — add the mapping, do not cast.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/reports
git commit -m "feat(web): threat detection review report wiring and options form (#5784 W02)"
```

---

### Task 9: Locale keys in all eight locales

**Files:**
- Modify: `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/reports.json`

**Interfaces:**
- Produces: the three `reportTypes` entries plus the template and options blocks.

**The name string is duplicated in three separate maps** — this is the repo's
existing shape, not a mistake to fix here. Per locale:

- `reports.reportPreview.reportTypes.threat_detection_review`
- `reports.reportsList.reportTypes.threat_detection_review`
- `reports.reportTemplates.reportTypes.threat_detection_review`
- `reports.reportTemplates.templates.threat_detection_review` — `{ name, description }`
- `reports.threatDetectionOptions.*` — the options-form field labels and help text
- `reports.reportPreview.threatDetection.*` — the preview tile labels

- [ ] **Step 1: Add the keys to `en` first, then translate**

Write **real translations** in the other seven, not English copies.
`apps/web/src/lib/i18n/translationCoverage.test.ts` fails a locale when more than
20% of its flattened keys equal the English value verbatim, **and** enforces a
per-namespace exact-duplicate baseline (`'reports.json'` already carries one).
English copies push a namespace over its baseline and go red.

- [ ] **Step 2: Run both locale guards**

Run:
```bash
cd apps/web && npx vitest run src/lib/i18n/translationCoverage.test.ts src/lib/i18n/localeParity.test.ts src/components/reports/reportsPtBR.test.ts
```
Expected: PASS. `localeParity` checks key existence and interpolation-token
parity; `translationCoverage` is the one that catches English copies.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/locales
git commit -m "feat(web): threat detection review locale keys in eight locales (#5784 W02)"
```

---

### Task 10: Integration test — the sweep produces the artifact

**Files:**
- Create: `apps/api/src/__tests__/integration/threatDetectionEvidence.integration.test.ts`
- Modify: `apps/api/src/__tests__/integration/managedEvidenceFoundations.integration.test.ts`

**Placement matters.** An integration test outside
`apps/api/src/__tests__/integration/` is picked up by **no** config and runs
**zero** tests while reporting success.

- [ ] **Step 1: Remove W01's `skipIf` guard**

W01's integration Case 1 was written with
`describe.skipIf(Object.keys(MANAGED_EVIDENCE_REGISTRY).length === 0)` because no
managed type existed. Delete the guard — the case is now live and is this wave's
primary proof.

- [ ] **Step 2: Write the wave's own suite**

- [ ] **Case 1 — partner-wide template → artifact in two orgs, never wired by
  hand.** Seed a partner with a Huntress integration and two orgs with incidents.
  Create a partner-wide template set with one monthly item carrying
  `autoEvidenceReportType: 'threat_detection_review'`. Apply it to **both** orgs
  through `applyTemplateSet`. Run `runDeliverableSweep` with `asOf` on the due
  date. Assert each org has a `service_deliverable_evidence` row of
  `kind='report_run'` pointing at a `completed` run of type
  `threat_detection_review`, and that the two runs are different rows against
  **different** report definitions (one per org).

- [ ] **Case 2 — no Huntress integration produces a data-gap artifact, not
  zeros.** A third org whose partner has no active integration. Assert a run is
  still produced, `result.summary.incidents.opened` is **null**, and
  `result.summary.dataGaps` is non-empty. **This is the assertion that stops the
  feature from shipping a lie**; if it reads `0`, stop.

- [ ] **Case 3 — the coverage window is the occurrence period.** Assert
  `result.summary.coverage.periodStart` / `.periodEnd` equal the occurrence's
  `period_start` / `period_end` from the database, and that
  `coverage.generatedAt` precedes `periodEnd` (generation is on the due day).

- [ ] **Case 4 — OD-12 end to end.** Immediately after the sweep, assert the run
  is **absent** from the portal run list and that `renderRunPdf` refuses it.
  Deliver the occurrence, then assert the same run is listed, downloadable, and
  that `renderRunPdf` produces a non-empty buffer **whose text contains the
  coverage note** — proving the server-side path reaches Task 6's arm and not
  `renderGenericReport`.

- [ ] **Step 3: Run the suite**

Run:
```bash
pnpm test-stack up
cd apps/api && DATABASE_URL=$(grep DATABASE_URL .env.test | cut -d= -f2-) \
  npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/threatDetectionEvidence.integration.test.ts \
  src/__tests__/integration/managedEvidenceFoundations.integration.test.ts
```
Expected: green with a **non-zero reported test count** for both suites.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/__tests__/integration
git commit -m "test(reports): threat detection evidence produced by the sweep, end to end (#5784 W02)"
```

---

### Task 11: Wave verification and PR

- [ ] **Step 1: Unit suites** — `cd apps/api && npx vitest run`;
  `cd packages/shared && npx vitest run`; `cd apps/web && npx vitest run`;
  `cd apps/portal && npx vitest run` → all green.

- [ ] **Step 2: Typecheck and lint** —
  `pnpm --filter @breeze/web typecheck`, `pnpm --filter @breeze/portal typecheck`,
  `cd apps/api && npx tsc --noEmit -p tsconfig.json`, `pnpm lint` at the root →
  all clean.

- [ ] **Step 3: Contract suites on a live database** (test stack up):

```bash
cd apps/api && DATABASE_URL=$(grep DATABASE_URL .env.test | cut -d= -f2-) \
  npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/rls-coverage.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts \
  src/__tests__/integration/orgLifecycleFoundations.integration.test.ts \
  src/__tests__/integration/portalReportSelfService.integration.test.ts \
  src/__tests__/integration/threatDetectionEvidence.integration.test.ts \
  src/__tests__/integration/managedEvidenceFoundations.integration.test.ts
```
→ green, each with a non-zero test count. **`pnpm test` does not run these.** This
wave adds no table and no column, so cascade/RLS/export-policy should be
unchanged — if any of them moves, something unintended was added.

- [ ] **Step 4: Prove all three render paths from one stored result**

On the test stack, take the `report_runs.result` produced by Task 10 Case 1 and:
(a) render it through `renderRunPdf` (portal/server) — already asserted in
Case 4; (b) render it through `apps/web`'s `exportReport` in a component test;
(c) confirm the scheduled-email path uses `buildReportPdf` with the same opts.
A type with no arm silently degrades on (a) and (c) while (b) looks fine.

- [ ] **Step 5: Manual smoke** (`pnpm wt-stack up`)

As a partner admin: create a partner-wide template set with a "Monthly threat
detection review" item, set its Evidence report to **Threat detection review**,
apply it to an org, and confirm the deliverable shows the link. Open Reports →
Templates and confirm the Threat Detection Review card opens the options form, not
the builder. Create one, run it, and confirm the preview and the downloaded PDF
both show the coverage line. As a portal user with `enable_reports` on, confirm
the run is **not** visible until the occurrence is delivered, and that there is no
generate button for it afterwards.

- [ ] **Step 6: Tear down**

```bash
pnpm test-stack down && pnpm wt-stack down
docker compose ls -a --format json | jq -r '.[] | select(.ConfigFiles|test("breeze")) | "\(.Name)\t\(.Status)"'
```

- [ ] **Step 7: PR**

Against **`main`**, `Closes #<W02 sub-issue>`, linking the spec and the plan index,
with sections:

- **What the artifact claims, and what it does not** — it is titled *generated
  review evidence*, not "review"; it enumerates the incidents Breeze holds for the
  period with status as observed at generation time; it does not assert a human
  read it. The review record is the technician resolving the ticket.
- **Coverage honesty** — the data-gap page for an unconnected integration, the
  actual-window disclosure, the unattributable-incident exclusion under restricted
  scope, and the `withheld` count.
- **Portal** — label only, no generate button; the type is deliberately out of
  `PORTAL_REPORT_TYPES` and both allowlist literals; OD-12 gates visibility on
  delivery.
- **Rollout** — no feature flag, no env var, no consent change, no agent change.
  **This release must run
  `pnpm --filter @breeze/api reports:reprovision-portal-definitions` (dry run
  first, then `--apply`)**, or orgs that enabled portal reports earlier will lack
  the new definition and their deliverables will never produce evidence. Add the
  step to the release runbook entry.
- **Localization caveat** — the eight locale files localize the web UI only; the
  PDF renderer is English.

Run `/pr-review-toolkit:review-pr`; act only on confirmed, consequential findings.
Enqueue with `gh pr merge <N>` on green — **never `--admin`**. The PR targets
`main`, so CI (including the blocking `integration-test` job) already ran; do not
hand-dispatch.

---

## Self-review

**Spec coverage.** §3.2 source and org/partner axis split → Task 5 Step 3; §3.2
freshness + whole-report data gap → Tasks 4, 5, 6 and integration Case 2; §3.2
contents 1–5 → Task 5 Step 3 and Task 6 Step 3; "what reviewed means" → the PR
body and the artifact title in Task 6; "completeness cannot be claimed" →
`ThreatCoverage`, `coverageGapLine`, integration Case 3; §3.2 site scope incl. the
NULL `device_id` exclusion → Task 5 Steps 1 and 3; §3.2 PDF module + label +
summary type → Tasks 4 and 6. §3.1 rules 1, 2, 3, 4, 5, 6 → Global Constraints and
Tasks 4, 5, 6. §5.3 steps 1–11 → Tasks 1, 2, 3, 5, 4, 6, 8, 9, 7 respectively
(step 10's reprovision run is in the PR's rollout section, which is where it can
actually happen). §6 portal impact incl. the `PortalRunDto` type lie → Task 7.
§9.1 contract tests → Tasks 2, 3, 9 and 11 Step 3; new integration tests → Task
10; all-three-render-paths → Task 11 Step 4. OD-10 = A → Task 7 Step 4, stated
twice.

**Placeholders.** Four places deliberately instruct a lookup rather than guessing,
each naming the file to copy from: the chainable db-mock dialect (Task 5 Step 1 →
`hardwareLifecycleReport.test.ts`), the PDF text-extraction helper (Task 6 Step 1 →
`reportPdf.hardwareLifecycle.test.ts`), the options-form shape (Task 8 Step 4 →
`HardwareLifecycleOptionsForm.tsx`) and the template-card tone/icon (Task 8
Step 3 → `ReportTemplates.tsx:99-114`). Task 5 Step 3's numbered comment block is
the generator's structure, with each section's source table and filter named; it
is a specification of the queries, not a TODO.

**Type consistency.** `ThreatDetectionSummary`, `ThreatIncidentRow`,
`ThreatCoverage`, `ThreatSourceStatus`, `resolutionStats`, `countBy`,
`coverageGapLine`, `SEVERITY_ORDER`, `threatDetectionConfigSchema`,
`threatDetectionConfigFields`, `generateThreatDetectionReport`,
`renderThreatDetectionReport`, `DEFAULT_THREAT_DETECTION_OPTIONS`,
`ThreatDetectionOptionsFields`, `threatDetectionOptionsFromConfig` and
`ThreatDetectionOptions` are spelled identically in every task that mentions them.
The enum literal `'threat_detection_review'` is identical in the migration, the
pg enum, the `ReportType` union, both switches, `reportTypeSchema`, the registry
key, `MANAGED_EVIDENCE_REPORT_TYPES`, `PORTAL_DEFINITIONS`, `PortalRunDto`, the
portal component union, `REPORT_TYPE_LABELS`, all six web wiring points and all
24 locale keys. `EvidenceRunContext`'s four fields match W01's definition exactly.

**Cross-wave contracts consumed, not re-implemented.** The registry (W01 Task 3) —
this wave adds one entry. The publication gate (W01 Task 10) — this wave only
*asserts* it in integration Case 4. The period/baseline contract (W01 Tasks 4, 7,
8) — this wave's generator *reads* `EvidenceRunContext` and `opts.previous`; it
never derives a window from `now()` and never calls `previousBaselineFor`. The
template column (W01 Tasks 1, 2, 11) — this wave is the first to put a real value
in it.
