---
tracking_issue: LanternOps/breeze#3198
spec: docs/superpowers/specs/reports/2026-08-16-psa-business-reports-spec.md
wave: W02 — Registry map, three generators, PDF modules (one PR)
blast_radius: high (rewrites the dispatcher and the config schema for all 13 shipped report types; reads money and HR-adjacent data under system DB context at partner scope)
---

# Business Reports W02: Registry Map, Three Generators, PDF Modules — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 13-arm `switch` in `reportGenerationService.ts` with a declarative `REPORT_GENERATORS` registry that owns each type's config schema, supported scopes, required permissions and detail-row cap; then add the three Phase 1 business report types — `ticket_sla_attainment`, `technician_time_billability`, `ar_aging` — as registry entries with real SQL generators, shared summary types, a money-formatting helper and three PDF modules. API + `packages/shared` only: the types exist and generate, but no web template exposes them until W03.

**Architecture:** One PR, internally ordered so each task is independently reviewable: canonical type tuple → scope object → registry (mechanical migration of all 13) → config-schema lookup → shared types + money helper → period resolver → R1 → R2 → R3 → PDF modules → caller wiring. The registry is a plain frozen `Record<ReportType, ReportTypeDef>` keyed by the closed union, so a missing key is a compile error — the same guarantee the `never` default gave. Business generators run partner scope under `runOutsideDbContext(() => withSystemDbAccessContext(...))` with an explicit `partner_id` / org-allowlist predicate in **every** query, because an org-scoped RLS context cannot see partner-axis rows and a partner-wide authority has no org context to open.

**Tech Stack:** Hono + Drizzle + postgres.js, raw `sql` templates with bound params for the three aggregates, zod v4 (`z.discriminatedUnion`), Vitest (unit with Drizzle mocks + integration against real Postgres), jsPDF + jspdf-autotable in `packages/shared/src/reportPdf`.

**Spec:** `docs/superpowers/specs/reports/2026-08-16-psa-business-reports-spec.md` — §3.2 (generator contract / ReportScope), §3.3 (R1/R2/R3 definitions, as amended 2026-09-21), §3.4 (renderer + money helper), §4 (detail-row cap), §6 (registry design and the 2026-09-21 amendment), §10 (test notes).

**Depends on:** **W01 must be merged.** W02 consumes these W01 names verbatim and does not redesign them:

| Name | Where W01 puts it | What W02 does with it |
|---|---|---|
| `SiteScopeV1` kind `'partner_wide'` `{ version: 1; kind: 'partner_wide'; partnerId: string }` | `apps/api/src/services/siteScope.ts` | `reportScopeFromAuthority` branches on it |
| `ReportOwner = { orgId: string; partnerId?: undefined } \| { partnerId: string; orgId?: undefined }` | `siteScope.ts` | the input to `reportScopeFromAuthority` and to the owner-timezone resolver |
| `reportOwnerOf(row: { orgId: string \| null; partnerId: string \| null }): ReportOwner` (throws unless exactly one is set) | `siteScope.ts` | every caller derives the owner from the `reports` row with this, never by hand |
| `getReportWithOwnerCheck(reportId, auth)` (old name `getReportWithOrgCheck` kept as a deprecated alias for one wave) | `apps/api/src/routes/reports/helpers.ts` | `runs.ts` / `recipients.ts` already call it after W01; W02 reads `report.partnerId` off the returned row |
| `assertReportExecutionPreflight(owner: ReportOwner, config, authority, type?)` and its private `assertExecutableAuthority(owner, authority)` — W01 widens both from `orgId: string` to the owner axis (`reportGenerationService.ts:213-260, 284-324`) | `reportGenerationService.ts` | W02 calls it with a `ReportOwner`, never an org id string |
| `reports.partner_id` nullable + `reports.org_id` nullable + `reports_one_owner_chk` | `apps/api/migrations/2026-10-26-100100-reports-partner-ownership.sql` | read-only |
| enum labels `ticket_sla_attainment`, `technician_time_billability`, `ar_aging` | `apps/api/migrations/2026-10-26-100000-report-type-business.sql` | read-only |
| `resolveRequestPartnerReportAuthority(auth, partnerId, action)`, `resolveLivePartnerReportAuthority(userId, partnerId, action)` | `siteScope.ts` | the routes and the worker already call these after W01 |

---

## READ THIS FIRST — three facts that decide whether this wave ships correct numbers

### 1. `sqlOpenForOverdue` is NOT the AR-open predicate. Using it as one would hide most of the AR.

Spec §3.3 R3 says to reuse "the open-status predicate behind `sqlOpenForOverdue`". Verified, that predicate is:

```ts
// apps/api/src/db/schema/invoices.ts:28-30 — file-local today
function sqlOpenForOverdue(t: { status: unknown }): SQL {
  return sql`${t.status} IN ('sent','partially_paid')`;
}
```

It exists to feed the partial index behind the **overdue sweep's candidate set**, and the sweep *flips those rows out of it*:

```ts
// apps/api/src/services/invoiceService.ts:2276-2293
export async function runOverdueSweep(asOf: Date = new Date()): Promise<number> { ...
  inArray(invoices.status, ['sent', 'partially_paid'] as never), lt(invoices.dueDate, today), sql`${invoices.balance} > 0`, ...
  await db.update(invoices).set({ status: 'overdue', markedOverdueAt: asOf, ... })
```

`'overdue'` is a real, reachable value of the `invoice_status` enum (`packages/shared/src/types/billing-enums.ts:8-10`: `draft, sent, partially_paid, overdue, paid, void`) and it is exactly the state every genuinely past-due invoice ends up in. An AR **aging** report built on `IN ('sent','partially_paid')` would therefore omit the 1–30, 31–60, 61–90 and 90+ buckets almost entirely and report the aging of an MSP that always gets paid on time.

**Resolution (spec ambiguity #1, resolved here):** export `sqlOpenForOverdue` as the spec asks — so the sweep's status list keeps one home — and add, in the same file and the same PR, `sqlOpenAr`, the AR-open set, with `sqlOpenForOverdue` re-expressed in terms of it. R3 uses `sqlOpenAr`. Task 9 writes both and pins them against each other.

### 2. A partner-scope generator cannot use the ambient request context, and it must not escalate lazily either.

`time_entries` is partner-axis RLS; `tickets` and `invoices` are org-axis. A `partner_wide` authority carries no org, so `withDbAccessContext` for the request has `orgId: null` and an org-axis policy sees nothing. CLAUDE.md's sanctioned pattern for a genuine cross-org worker read is `runOutsideDbContext(() => withSystemDbAccessContext(...))`, and that is what the three business generators use at **partner scope only** — with the compensating control spelled out by `listBillables` (`apps/api/src/services/timeEntryService.ts:1525-1531`): every query carries the tenancy predicate in its own `WHERE`, because RLS is switched off inside a system context.

Concretely, **every** query in Tasks 10–12 carries one of these, and a reviewer should reject any that does not:

| Table | Axis | Predicate that MUST appear |
|---|---|---|
| `tickets` | org (NOT NULL) | `t.org_id = ANY(${orgIds})` (partner) / `t.org_id = ${orgId}` (org) |
| `time_entries` | partner (`org_id` nullable) | `te.partner_id = ${partnerId}` **and** `(te.org_id IS NULL OR te.org_id = ANY(${orgIds}))` |
| `invoices` | org + partner (both NOT NULL) | `i.partner_id = ${partnerId} AND i.org_id = ANY(${orgIds})` |
| `partner_users` / `users` / `roles` | partner | `pu.partner_id = ${partnerId}` |

Org scope does **not** open a system context at all: it runs in the caller's ambient request context and lets RLS do its job, with the org predicate present anyway for defense in depth.

### 3. The registry migration is all-or-nothing, and the module cycle is real.

Spec §6 (2026-09-21 amendment): "Migration of the existing thirteen `switch` arms into the map is **mechanical and complete in W02** — a half-migrated dispatcher (map for three, switch for ten) is worse than either."

The trap: `reportGenerationService.ts:389-810` *defines* six of the generators (`generateDeviceInventoryReport`, `generateSoftwareInventoryReport`, `generateAlertSummaryReport`, `generateComplianceReport`, `generatePerformanceReport`, `generateExecutiveSummaryReport`) and would also *import* the registry. A registry whose module body eagerly imports those six back is a runtime import cycle around a top-level `Object.freeze({...})` initializer — a TDZ `ReferenceError` at module load in the worst ordering, and a silently `undefined` entry in the best.

**Resolution (design decision, recorded):** every registry entry's `generate` is an async thunk that `await import`s its generator. The seven types that already used `await import` keep that exact shape; the six in-file ones gain one (`await import('./reportGenerationService')` — the module is already resident, since the dispatcher lives there, so this is a map lookup, not a second parse). The registry's module body then imports only types, `PERMISSIONS`, and the error classes — and the cycle is gone by construction rather than by import ordering luck.

The error classes move to a new `apps/api/src/services/reportErrors.ts` **and are re-exported verbatim** from `reportGenerationService.ts`, so every existing import site and every `instanceof StoredArtifactOnlyReportError` check keeps working against the same class identity.

---

## Global Constraints

- **One PR.** A half-migrated dispatcher is worse than either end state (spec §6).
- **No migration in this wave.** The three `report_type` enum labels ship in W01's `apps/api/migrations/2026-10-26-100000-report-type-business.sql`; the ownership columns in `2026-10-26-100100-reports-partner-ownership.sql`. **W02 adds no file to `apps/api/migrations/`.** If you find yourself writing one, you are doing W01's job or inventing a table the spec says does not exist ("New tables: none", §4).
- **Report type ids are fixed and spelled exactly:** `ticket_sla_attainment`, `technician_time_billability`, `ar_aging`. Labels: "Ticket SLA attainment", "Technician time & billability", "AR aging". (Spec §3.3 calls R2 `technician_utilization` in one heading; the id is `technician_time_billability`, matching the spec's own "time & billability" framing and the amended R2 body.)
- **Money is numeric strings.** PG `numeric` arrives as a JS string. Never `Number()` a money value before it reaches the formatter, and **never sum across currencies** (Open Decision 4 = A): every money aggregate is `GROUP BY currency_code` and every summary money field is an array of `{ currencyCode, amount }`.
- **Partner scope runs under `runOutsideDbContext(() => withSystemDbAccessContext(...))` with explicit predicates** — see "READ THIS FIRST" §2. Org scope runs in the ambient request context.
- **Aggregates before caps.** Bucket and group aggregates are computed in SQL over the full matching set; only stored *detail rows* are capped (5,000 for the three business types), with `truncated: true` and `detailRowsAvailable` in the summary (§3.2, §4).
- **Detail-row cap for the 13 existing types is `Number.POSITIVE_INFINITY`** — documented as unchanged behaviour, not a new limit.
- **`execution: 'managed_evidence'` keys must equal `MANAGED_EVIDENCE_REGISTRY`'s keys** and its two hand-parallel twins: `MANAGED_EVIDENCE_REPORT_TYPES` (`packages/shared/src/validators/deliverableTemplates.ts:23-32`) and `PORTAL_DEFINITIONS` (`apps/api/src/services/portal/reportsSelfService.ts:28`). The three business types are `execution: 'user'` and appear in **none** of them (§3.5).
- **Test commands:** `cd apps/api && npx vitest run <explicit path>`. **Never** `pnpm --filter <pkg> test -- --run <path>` (the `--` is forwarded into argv and vitest swallows `--run`, running all 1,470 files in watch mode). **Never** a trailing-slash directory filter. Integration: `pnpm test-stack up` → `cd apps/api && npx vitest run --config vitest.integration.config.ts <path>` → `pnpm test-stack down` when finished (nothing reaps it for you).
- **No `apps/web` changes in this wave** beyond the one-line `ReportType` union widening in Task 1 that keeps the web typecheck green. Templates, options forms and locales are W03.
- **Every new exported symbol is used by a test in the same task.** A registry entry nobody parses and a summary type nobody builds are the two ways this wave ships dead code.

---

## File structure

| Path | Responsibility |
|---|---|
| `packages/shared/src/reportTypes.ts` | **New.** The canonical `REPORT_TYPES` tuple + `ReportType`. One source for zod, the API union and the web union. |
| `packages/shared/src/types/businessReports.ts` | **New.** `TicketSlaSummary`, `TechnicianTimeSummary`, `ArAgingSummary` + row types + the three `empty*Summary()` factories. |
| `packages/shared/src/reportPdf/moneyFormat.ts` (+ `.test.ts`) | **New.** `formatMoney`, `formatPercent`, `formatMinutes`. `Intl`-based, no jsPDF import. |
| `packages/shared/src/reportPdf/ticketSlaPdf.ts`, `technicianTimePdf.ts`, `arAgingPdf.ts` | **New.** One renderer each, `identityAccessPdf.ts`'s exact shape (declared `PdfChrome`, never imports `reportPdf.ts`). |
| `packages/shared/src/reportPdf/reportPdf.ts` | Three new chain arms (after the `identity_access_review` arm at `:2126-2164`); `BuildOpts.summary` union widens by three. |
| `packages/shared/src/reportPdf/index.ts` | Three `export {}` + three `export type {}` lines. |
| `apps/api/src/services/reportErrors.ts` | **New.** `StoredArtifactOnlyReportError`, `UnexecutableReportScopeError` (moved), `UnsupportedReportScopeError` (new). |
| `apps/api/src/services/reportScope.ts` (+ `.test.ts`) | **New.** `ReportScope`, `organizationScope`, `reportScopeFromAuthority`, `reportOwnerOfScope`. |
| `apps/api/src/services/reportRegistry.ts` (+ `.test.ts`) | **New.** `ReportTypeDef`, `REPORT_GENERATORS`, `reportTypeDef()`. The registry owns config schema, scopes, permissions, cap, execution kind. |
| `apps/api/src/services/reportGenerationService.ts` | `dispatchReportGeneration` becomes a lookup; the 13-arm switch is deleted; `zeroSafeReport` gains three arms; errors re-exported from `reportErrors.ts`. |
| `apps/api/src/services/businessReports/period.ts` (+ `.test.ts`) | **New.** `resolveReportPeriod`, `resolveReportOwnerTimezone`, `workingDaysBetween`. |
| `apps/api/src/services/businessReports/ticketSlaReport.ts` (+ `.test.ts`) | **New.** R1. |
| `apps/api/src/services/businessReports/technicianTimeReport.ts` (+ `.test.ts`) | **New.** R2. |
| `apps/api/src/services/businessReports/arAgingReport.ts` (+ `.test.ts`) | **New.** R3. |
| `apps/api/src/db/schema/invoices.ts` | `sqlOpenForOverdue` exported; `sqlOpenAr` added. |
| `apps/api/src/routes/reports/schemas.ts` | `reportTypeSchema` derived from the tuple; `reportConfigSchema` becomes a `type`-discriminated lookup; `PARTNER_ONLY_DELIVERY_REPORT_TYPES`. |
| `apps/api/src/routes/reports/generate.ts`, `runs.ts`, `recipients.ts` | `ReportScope` from the owner axis; per-type permission gate; recipient refusal. |
| `apps/api/src/jobs/reportScheduleWorker.ts`, `apps/api/src/services/portal/reportsSelfService.ts`, `apps/api/src/services/deliverableAutoEvidence.ts` | The remaining `generateReport` call sites, updated to pass a scope. |
| `apps/api/src/__tests__/integration/businessReportsPartnerScope.integration.test.ts` | **New.** Partner fan-out across ≥2 orgs + org isolation, one case per generator. |

---

### Task 1: One canonical `REPORT_TYPES` tuple

Today the same 13 strings are written out by hand in four places: `reportTypeSchema` (`apps/api/src/routes/reports/schemas.ts:13-46`), the `ReportType` TS union (`apps/api/src/services/reportGenerationService.ts:33-79`), the Drizzle `reportTypeEnum` (`apps/api/src/db/schema/reports.ts:22`), and the web union (`apps/web/src/components/reports/ReportsList.tsx:35`). Spec §6 collapses the first, second and fourth onto one tuple in `packages/shared`; the Drizzle enum stays hand-listed and is pinned to the tuple by the equality assertion that already exists at `reportGenerationService.test.ts:371-372`.

**Files:**
- Create: `packages/shared/src/reportTypes.ts`
- Create: `packages/shared/src/reportTypes.test.ts`
- Modify: `packages/shared/src/index.ts` (add one `export *` line)
- Modify: `apps/api/src/routes/reports/schemas.ts:13-46`
- Modify: `apps/api/src/services/reportGenerationService.ts:33-79`
- Modify: `apps/web/src/components/reports/ReportsList.tsx:35-62`
- Modify: `apps/api/src/services/reportGenerationService.test.ts:34-46` (the pinned list gains three entries)

**Interfaces:**
- Consumes: nothing.
- Produces: `REPORT_TYPES` (readonly tuple, 16 entries, **existing 13 in current enum order first**, then the three business ids), `ReportType = (typeof REPORT_TYPES)[number]`, `BUSINESS_REPORT_TYPES`, `isReportType(value: string): value is ReportType`. Every later task imports `ReportType` from `@breeze/shared`.

**No migration.** The three enum labels already exist in the database after W01's `2026-10-26-100000-report-type-business.sql`. W02 creates no file under `apps/api/migrations/`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/shared/src/reportTypes.test.ts
import { describe, expect, it } from 'vitest';
import { BUSINESS_REPORT_TYPES, REPORT_TYPES, isReportType } from './reportTypes';

describe('REPORT_TYPES', () => {
  it('lists the 13 shipped types first, in report_type enum order, then the three business types', () => {
    expect([...REPORT_TYPES]).toEqual([
      'device_inventory', 'software_inventory', 'alert_summary', 'compliance',
      'performance', 'executive_summary', 'security_compliance_posture',
      'ai_org_narrative', 'ai_fleet_design', 'hardware_lifecycle',
      'threat_detection_review', 'endpoint_management_review',
      'vulnerability_management', 'identity_access_review',
      'ticket_sla_attainment', 'technician_time_billability', 'ar_aging',
    ]);
  });

  it('has no duplicates', () => {
    expect(new Set(REPORT_TYPES).size).toBe(REPORT_TYPES.length);
  });

  it('BUSINESS_REPORT_TYPES is exactly the three #3198 types and all are in REPORT_TYPES', () => {
    expect([...BUSINESS_REPORT_TYPES]).toEqual([
      'ticket_sla_attainment', 'technician_time_billability', 'ar_aging',
    ]);
    for (const t of BUSINESS_REPORT_TYPES) expect(REPORT_TYPES).toContain(t);
  });

  it('isReportType narrows only known values', () => {
    expect(isReportType('ar_aging')).toBe(true);
    expect(isReportType('ar_ageing')).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd packages/shared && npx vitest run src/reportTypes.test.ts`
Expected: FAIL — `Failed to resolve import "./reportTypes"`.

- [ ] **Step 3: Write the tuple**

```ts
// packages/shared/src/reportTypes.ts
/**
 * THE canonical list of report types (#3198 spec §6). `reportTypeSchema`
 * (apps/api/src/routes/reports/schemas.ts), the API `ReportType` union
 * (services/reportGenerationService.ts) and the web union
 * (apps/web/src/components/reports/ReportsList.tsx) all derive from this tuple.
 *
 * The ONE place that still hand-lists the values is the Drizzle pgEnum
 * `reportTypeEnum` (apps/api/src/db/schema/reports.ts) — a pgEnum's value order
 * is a shipped database fact, so it cannot be spread from a tuple that a later
 * author might reorder. `reportGenerationService.test.ts` asserts the two agree.
 *
 * ORDER IS LOAD-BEARING: the first fourteen entries are in `report_type` enum
 * order. Append new types at the end; never reorder.
 */
export const REPORT_TYPES = [
  'device_inventory',
  'software_inventory',
  'alert_summary',
  'compliance',
  'performance',
  'executive_summary',
  'security_compliance_posture',
  // System-managed stored artifacts (#4190, #5651): present in the union so
  // every exhaustive switch must say what happens to them.
  'ai_org_narrative',
  'ai_fleet_design',
  'hardware_lifecycle',
  // Service-plan evidence (#5784 W02/W03/W04/W06).
  'threat_detection_review',
  'endpoint_management_review',
  'vulnerability_management',
  'identity_access_review',
  // #3198 Phase 1 business reports. Never portal-visible, never managed
  // evidence; the only types whose supportedScopes include 'partner'.
  'ticket_sla_attainment',
  'technician_time_billability',
  'ar_aging',
] as const satisfies readonly string[];

export type ReportType = (typeof REPORT_TYPES)[number];

/** The #3198 Phase 1 trio. Used by the registry's scope table and by W03's
 *  "Business" template grouping. */
export const BUSINESS_REPORT_TYPES = [
  'ticket_sla_attainment',
  'technician_time_billability',
  'ar_aging',
] as const satisfies readonly ReportType[];

export type BusinessReportType = (typeof BUSINESS_REPORT_TYPES)[number];

const REPORT_TYPE_SET: ReadonlySet<string> = new Set(REPORT_TYPES);

export function isReportType(value: string): value is ReportType {
  return REPORT_TYPE_SET.has(value);
}
```

- [ ] **Step 4: Export it from the shared barrel**

```ts
// packages/shared/src/index.ts — append after the existing `export * from './m365';`
export * from './reportTypes';
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd packages/shared && npx vitest run src/reportTypes.test.ts src/browserSafeBarrel.test.ts`
Expected: PASS, 2 files. (`browserSafeBarrel.test.ts` guards the barrel against Node-only imports — `reportTypes.ts` has none, so it must stay green.)

- [ ] **Step 6: Derive `reportTypeSchema` from the tuple**

```ts
// apps/api/src/routes/reports/schemas.ts — replace lines 13-46 wholesale
import { REPORT_TYPES } from '@breeze/shared';

/**
 * Every value of the `report_type` pgEnum, INCLUDING the internal ones. Reads
 * need the full union: `GET /reports?type=ai_org_narrative` is a legitimate
 * filter, and `GET /reports/:id` returns the stored row's type verbatim.
 *
 * Derived from the canonical tuple (#3198 spec §6) rather than hand-listed —
 * the three-way TS/zod/web duplication is collapsed to one source. The two
 * WRITE schemas below still narrow it; see `internalReportType`.
 */
export const reportTypeSchema = z.enum(REPORT_TYPES);
```

- [ ] **Step 7: Derive the API `ReportType` union from the tuple**

```ts
// apps/api/src/services/reportGenerationService.ts — replace lines 33-79 wholesale.
// The long per-type comments that lived on the union members move to
// packages/shared/src/reportTypes.ts (they are already there, abridged).
import type { ReportType } from '@breeze/shared';
export type { ReportType };
```

Keep the `export type { ReportType }` re-export: `managedEvidenceRegistry.ts:1`, `reportGenerationService.test.ts:24` and several route files import `ReportType` from this module, and rewriting those imports is churn this task does not need.

- [ ] **Step 8: Widen the web union (one line, no behaviour change)**

```ts
// apps/web/src/components/reports/ReportsList.tsx — replace the hand-written
// union at :35-62 with the derived one. The per-type comments there are about
// LABELS (getReportTypeLabel does a dynamic i18n lookup), not about the values,
// so nothing is lost. W03 adds the three labels to the eight locale files.
import type { ReportType } from '@breeze/shared';
export type { ReportType };
```

- [ ] **Step 9: Extend the enum-parity list in the existing service test**

```ts
// apps/api/src/services/reportGenerationService.test.ts:34-46 — append to REPORT_TYPES
  'identity_access_review',
  // #3198 W02. Generated on demand under a user authority at either scope.
  'ticket_sla_attainment',
  'technician_time_billability',
  'ar_aging',
];
```

- [ ] **Step 10: Run the affected suites**

```bash
cd packages/shared && npx vitest run src/reportTypes.test.ts src/browserSafeBarrel.test.ts
cd apps/api && npx vitest run src/services/reportGenerationService.test.ts src/routes/reports/schemas.config.test.ts src/routes/reports/schemas.security.test.ts
cd apps/web && npx vitest run src/components/reports/reportTypeSurvivesBuilder.test.ts
```

Expected: all PASS. `reportGenerationService.test.ts` is the one that proves the tuple and the pgEnum agree (`:371-372`); it is red until Step 9 lands and green after, **because W01 already added the three labels to `reportTypeEnum`**. If it is still red on "expected 17 to equal 14", W01 is not merged — stop and rebase.

- [ ] **Step 11: Typecheck the three packages**

```bash
pnpm --filter @breeze/shared typecheck && pnpm --filter @breeze/api typecheck && pnpm --filter @breeze/web typecheck
```

Expected: clean. A failure here is almost always a `switch (type)` somewhere that is now non-exhaustive — that is the point; fix it by adding the three cases, not by widening to `default`.

- [ ] **Step 12: Commit**

```bash
git add packages/shared/src/reportTypes.ts packages/shared/src/reportTypes.test.ts packages/shared/src/index.ts \
  apps/api/src/routes/reports/schemas.ts apps/api/src/services/reportGenerationService.ts \
  apps/api/src/services/reportGenerationService.test.ts apps/web/src/components/reports/ReportsList.tsx
git commit -m "refactor(reports): one canonical REPORT_TYPES tuple feeding zod, API and web unions (#3198 W02)"
```

---

### Task 2: `ReportScope` — the generator's tenancy input

Spec §3.2: the generator contract grows from an org id string to a scope object, and the partner variant carries the **live** accessible-org list resolved from the authority, never from the stored definition row. "Because the authority already required `org_access = 'all'`, that list is exactly the caller's accessible set — no per-org allowlist intersection is needed, and none is attempted (a partial list would be a wrong aggregate)."

**Files:**
- Create: `apps/api/src/services/reportScope.ts`
- Create: `apps/api/src/services/reportScope.test.ts`

**Interfaces:**
- Consumes: `ReportOwner`, `reportOwnerOf`, `ReportGenerationAuthority`, `SiteScopeV1` from `./siteScope` (W01); `runOutsideDbContext`, `withSystemDbAccessContext`, `db` from `../db`; `organizations` from `../db/schema`.
- Produces:
```ts
export type ReportScope =
  | { kind: 'organization'; orgId: string }
  | { kind: 'partner'; partnerId: string; orgIds: string[] };
export function organizationScope(orgId: string): ReportScope;
export function reportOwnerOfScope(scope: ReportScope): ReportOwner;
export async function reportScopeFromAuthority(
  owner: ReportOwner, authority: ReportGenerationAuthority,
): Promise<ReportScope>;
export class ReportScopeMismatchError extends Error {}
```

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/reportScope.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { systemCtxSpy } = vi.hoisted(() => ({ systemCtxSpy: vi.fn() }));
vi.mock('../db', () => ({
  db: { select: vi.fn() },
  runOutsideDbContext: <T,>(fn: () => T): T => fn(),
  withSystemDbAccessContext: <T,>(fn: () => Promise<T>): Promise<T> => { systemCtxSpy(); return fn(); },
}));

import { db } from '../db';
import {
  ReportScopeMismatchError, organizationScope, reportOwnerOfScope, reportScopeFromAuthority,
} from './reportScope';
import type { ReportGenerationAuthority } from './siteScope';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const PARTNER = '44444444-4444-4444-8444-444444444444';
const USER = '33333333-3333-4333-8333-333333333333';

function queueOrgRows(rows: Array<{ id: string }>) {
  vi.mocked(db.select).mockImplementation((() => {
    const chain: Record<string, unknown> = {};
    for (const m of ['from', 'where', 'orderBy']) chain[m] = () => chain;
    (chain as { then?: unknown }).then = (r: (v: unknown) => unknown) => Promise.resolve(rows).then(r);
    return chain;
  }) as never);
}

const orgAuthority: ReportGenerationAuthority = {
  principalKind: 'user',
  scope: { version: 1, kind: 'unrestricted', orgId: ORG_A },
  principalUserId: USER,
  capturedAt: new Date('2026-09-21T00:00:00.000Z'),
  fingerprint: 'f'.repeat(64),
};

const partnerAuthority: ReportGenerationAuthority = {
  principalKind: 'user',
  scope: { version: 1, kind: 'partner_wide', partnerId: PARTNER },
  principalUserId: USER,
  capturedAt: new Date('2026-09-21T00:00:00.000Z'),
  fingerprint: 'a'.repeat(64),
};

describe('reportScopeFromAuthority', () => {
  beforeEach(() => { vi.clearAllMocks(); systemCtxSpy.mockClear(); });

  it('an org owner with an org authority yields an organization scope and opens NO system context', async () => {
    const scope = await reportScopeFromAuthority({ orgId: ORG_A }, orgAuthority);
    expect(scope).toEqual({ kind: 'organization', orgId: ORG_A });
    expect(systemCtxSpy).not.toHaveBeenCalled();
  });

  it('a partner owner resolves the live org list under a system context', async () => {
    queueOrgRows([{ id: ORG_A }, { id: ORG_B }]);
    const scope = await reportScopeFromAuthority({ partnerId: PARTNER }, partnerAuthority);
    expect(scope).toEqual({ kind: 'partner', partnerId: PARTNER, orgIds: [ORG_A, ORG_B] });
    expect(systemCtxSpy).toHaveBeenCalledOnce();
  });

  it('a partner with zero organizations yields an empty, NOT a null, org list', async () => {
    queueOrgRows([]);
    await expect(reportScopeFromAuthority({ partnerId: PARTNER }, partnerAuthority))
      .resolves.toEqual({ kind: 'partner', partnerId: PARTNER, orgIds: [] });
  });

  it('refuses an owner/authority axis mismatch rather than inventing a scope', async () => {
    await expect(reportScopeFromAuthority({ partnerId: PARTNER }, orgAuthority))
      .rejects.toBeInstanceOf(ReportScopeMismatchError);
    await expect(reportScopeFromAuthority({ orgId: ORG_A }, partnerAuthority))
      .rejects.toBeInstanceOf(ReportScopeMismatchError);
  });

  it('refuses an org authority whose orgId is not the owner org', async () => {
    await expect(reportScopeFromAuthority({ orgId: ORG_B }, orgAuthority))
      .rejects.toBeInstanceOf(ReportScopeMismatchError);
  });

  it('refuses a partner authority for another partner', async () => {
    await expect(reportScopeFromAuthority({ partnerId: ORG_A }, partnerAuthority))
      .rejects.toBeInstanceOf(ReportScopeMismatchError);
  });

  it('round-trips owner -> scope -> owner', () => {
    expect(reportOwnerOfScope(organizationScope(ORG_A))).toEqual({ orgId: ORG_A });
    expect(reportOwnerOfScope({ kind: 'partner', partnerId: PARTNER, orgIds: [] }))
      .toEqual({ partnerId: PARTNER });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/services/reportScope.test.ts`
Expected: FAIL — `Failed to resolve import "./reportScope"`.

- [ ] **Step 3: Write the module**

```ts
// apps/api/src/services/reportScope.ts
import { asc, eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { organizations } from '../db/schema';
import type { ReportGenerationAuthority, ReportOwner } from './siteScope';

/**
 * The tenancy input a report generator receives (#3198 spec §3.2). It replaces
 * the bare `orgId: string` the generators took before W02.
 *
 * `orgIds` on the partner variant is resolved LIVE at generation time from
 * `organizations.partner_id`, never read from the stored definition. Persisting
 * it would freeze the report at creation-time membership: a customer onboarded
 * last week would silently vanish from this month's AR aging (§3.1a).
 *
 * There is deliberately NO org cap. The design doc's 100-org cap exists for the
 * posture fan-out (~15 queries per org); business aggregates are single GROUP BY
 * queries, and a capped AR or SLA aggregate is simply a wrong number (§3.2).
 */
export type ReportScope =
  | { kind: 'organization'; orgId: string }
  | { kind: 'partner'; partnerId: string; orgIds: string[] };

/**
 * Raised when the owner axis of a `reports` row and the axis of the authority
 * resolved for it disagree. Callers map it to 403 (not 400): the request is
 * well-formed and the row exists, but no authority was produced for the axis it
 * is stored on, which is an access outcome.
 */
export class ReportScopeMismatchError extends Error {
  readonly code = 'report_scope_mismatch';
  constructor(message: string) {
    super(message);
    this.name = 'ReportScopeMismatchError';
  }
}

/** Sugar for the many org-scope call sites; there is no partner equivalent on
 *  purpose — a partner scope must come from `reportScopeFromAuthority`, which is
 *  the only place that resolves the org list. */
export function organizationScope(orgId: string): ReportScope {
  return { kind: 'organization', orgId };
}

/** The owner axis a scope came from. `assertReportExecutionPreflight` takes a
 *  `ReportOwner` after W01, so this is how a generator hands its scope back to
 *  the preflight without reconstructing the row. */
export function reportOwnerOfScope(scope: ReportScope): ReportOwner {
  return scope.kind === 'organization' ? { orgId: scope.orgId } : { partnerId: scope.partnerId };
}

/**
 * Derive the generator's scope from the report's owner axis and the authority
 * already resolved for it. The authority is the source of truth for WHICH
 * tenant, so a mismatch between the two is refused rather than silently
 * preferring one — that refusal is what stops a partner-owned row from being
 * generated under an org authority that happens to be lying around.
 */
export async function reportScopeFromAuthority(
  owner: ReportOwner,
  authority: ReportGenerationAuthority,
): Promise<ReportScope> {
  const scope = authority.scope;

  if (owner.partnerId !== undefined) {
    if (scope.kind !== 'partner_wide') {
      throw new ReportScopeMismatchError(
        `Partner-owned report requires a partner_wide authority, got ${scope.kind}`,
      );
    }
    if (scope.partnerId !== owner.partnerId) {
      throw new ReportScopeMismatchError('Report execution authority partner mismatch');
    }
    // System context: `organizations` is partner-axis via
    // breeze_has_partner_access, and this runs on the worker path too, where
    // there is no request context at all. runOutsideDbContext first, per
    // CLAUDE.md, because a request-path caller is already inside one.
    const rows = await runOutsideDbContext(() =>
      withSystemDbAccessContext(() =>
        db
          .select({ id: organizations.id })
          .from(organizations)
          .where(eq(organizations.partnerId, scope.partnerId))
          .orderBy(asc(organizations.id)),
      ),
    );
    return { kind: 'partner', partnerId: scope.partnerId, orgIds: rows.map((r) => r.id) };
  }

  if (scope.kind === 'partner_wide') {
    throw new ReportScopeMismatchError(
      'Org-owned report cannot be generated under a partner_wide authority',
    );
  }
  if (scope.orgId !== owner.orgId) {
    throw new ReportScopeMismatchError('Report execution authority organization mismatch');
  }
  return { kind: 'organization', orgId: owner.orgId };
}
```

**Why `orderBy(asc(organizations.id))`:** the org list appears in the stored `result.summary.scope.orgIds` and in integration assertions. An unordered `SELECT` makes both flaky.

**Why no suspended/archived filter:** `reportScopeFromAuthority` deliberately returns *every* organization of the partner, not `auth.accessibleOrgIds` — which excludes suspended and archived orgs even for `orgAccess: 'all'` (`apps/api/src/middleware/auth.ts:410-420`). A suspended customer still owes money and still had tickets last month; dropping them would make the AR total disagree with the invoices list. The authority has already required `org_access = 'all'` (§3.1a), so this is not a widening of what the caller may see.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/api && npx vitest run src/services/reportScope.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/reportScope.ts apps/api/src/services/reportScope.test.ts
git commit -m "feat(reports): ReportScope derived from the execution authority, never the stored row (#3198 W02)"
```

---

### Task 3: `REPORT_GENERATORS` — all 13 arms migrated, mechanically and completely

This is the task a reviewer should read most carefully, because it is a behaviour-preserving rewrite of the one function every report in the product goes through. The rule: **nothing about the 13 existing types changes except where the code lives.** Same generator, same `await import` laziness, same `authority` vs `requestAuthority()` argument, same errors.

**Files:**
- Create: `apps/api/src/services/reportErrors.ts`
- Create: `apps/api/src/services/reportRegistry.ts`
- Create: `apps/api/src/services/reportRegistry.test.ts`
- Modify: `apps/api/src/services/reportGenerationService.ts` (delete the switch at `:858-961`; re-export the two error classes; rewrite `dispatchReportGeneration`)

**Interfaces:**
- Consumes: `ReportType` (Task 1), `ReportScope` / `reportOwnerOfScope` (Task 2), `ReportGenerationAuthority` from `./siteScope`, `EvidenceRunContext` / `ReportResult` (type-only) from `./reportGenerationService`, `PERMISSIONS` from `./permissions`.
- Produces:
```ts
export interface ReportTypeDef<C = unknown> {
  type: ReportType;
  label: string;
  configSchema: z.ZodType<C>;
  supportedScopes: readonly ('organization' | 'partner')[];
  execution: 'user' | 'managed_evidence';
  requiredPermissions: readonly Permission[];
  detailRowCap: number;
  generate(scope: ReportScope, config: C, authority: ReportGenerationAuthority,
           evidence?: EvidenceRunContext): Promise<ReportResult>;
}
export const REPORT_GENERATORS: Readonly<Record<ReportType, ReportTypeDef>>;
export function reportTypeDef(type: ReportType): ReportTypeDef;
export class UnsupportedReportScopeError extends Error;   // re-exported from reportErrors.ts
```

#### The exact arm-to-entry mapping — all 13

Read this table against `reportGenerationService.ts:900-940` before writing a line. `orgOf(scope)` is the registry-local helper defined in Step 4; `requestAuthority(authority, type)` is the existing narrowing at `:891-899`, moved into `reportErrors.ts`-adjacent registry scope unchanged.

| # | Type | Existing arm (line) | Registry `generate` body | `execution` | `supportedScopes` |
|---|---|---|---|---|---|
| 1 | `device_inventory` | `:901-902` — `generateDeviceInventoryReport(orgId, config, authority)` (note: **`authority`**, not `requestAuthority()`) | `const { generateDeviceInventoryReport } = await import('./reportGenerationService'); return generateDeviceInventoryReport(orgOf(scope), config, authority);` | `user` | `['organization']` |
| 2 | `software_inventory` | `:903-904` — `requestAuthority()` | same shape, `generateSoftwareInventoryReport(orgOf(scope), config, requestAuthority(authority, 'software_inventory'))` | `user` | `['organization']` |
| 3 | `alert_summary` | `:905-906` — `requestAuthority()` | `generateAlertSummaryReport(orgOf(scope), config, requestAuthority(authority, 'alert_summary'))` | `user` | `['organization']` |
| 4 | `compliance` | `:907-908` — `requestAuthority()` | `generateComplianceReport(orgOf(scope), config, requestAuthority(authority, 'compliance'))` | `user` | `['organization']` |
| 5 | `performance` | `:909-910` — `requestAuthority()` | `generatePerformanceReport(orgOf(scope), config, requestAuthority(authority, 'performance'))` | `user` | `['organization']` |
| 6 | `executive_summary` | `:911-912` — `requestAuthority()` | `generateExecutiveSummaryReport(orgOf(scope), config, requestAuthority(authority, 'executive_summary'))` | `user` | `['organization']` |
| 7 | `security_compliance_posture` | `:913-916` — **already `await import('./securityComplianceReport')`** | keep that import verbatim; `generateSecurityCompliancePostureReport(orgOf(scope), config, requestAuthority(authority, 'security_compliance_posture'))` | `user` | `['organization']` |
| 8 | `ai_org_narrative` | `:918-919` — `throw new StoredArtifactOnlyReportError(type)` | `async () => { throw new StoredArtifactOnlyReportError('ai_org_narrative'); }` | `user` | `['organization']` |
| 9 | `ai_fleet_design` | `:920-922` — `throw new StoredArtifactOnlyReportError(type)` | `async () => { throw new StoredArtifactOnlyReportError('ai_fleet_design'); }` | `user` | `['organization']` |
| 10 | `hardware_lifecycle` | `:923-926` — `await import('./hardwareLifecycleReport')`, `requestAuthority()` | keep the import; `generateHardwareLifecycleReport(orgOf(scope), config, requestAuthority(authority, 'hardware_lifecycle'))` | `user` | `['organization']` |
| 11 | `threat_detection_review` | `:931-934` — `await import('./threatDetectionReport')`, **`authority` as-is**, `evidence` passed | `generateThreatDetectionReport(orgOf(scope), config, authority, evidence)` | `managed_evidence` | `['organization']` |
| 12 | `endpoint_management_review` | `:935-940` — `await import('./endpointManagementReport')`, `authority` as-is, `evidence` | `generateEndpointManagementReport(orgOf(scope), config, authority, evidence)` | `managed_evidence` | `['organization']` |
| 13 | `vulnerability_management` | `:943-946` — `await import('./vulnerabilityManagementReport')`, `authority` as-is, `evidence` | `generateVulnerabilityManagementReport(orgOf(scope), config, authority, evidence)` | `managed_evidence` | `['organization']` |
| 14 | `identity_access_review` | `:951-954` — `await import('./identityAccessReport')`, `authority` as-is, `evidence` | `generateIdentityAccessReport(orgOf(scope), config, authority, evidence)` | `managed_evidence` | `['organization']` |

(Fourteen rows: the "13 arms" of spec §0 counts the two stored-artifact throws as one shape. Every key of `ReportType` must appear, including the three business types, which Tasks 10–12 add with `supportedScopes: ['organization', 'partner']` and `execution: 'user'`.)

**`requiredPermissions` for all 14 existing entries is `[]`.** The route-level `requirePermission(PERMISSIONS.REPORTS_EXPORT…)` / `REPORTS_WRITE` middleware that guards them today is unchanged and stays where it is. The field exists for the business types (spec §2 gates them on the underlying reads) and for the registry test; adding a non-empty list to an existing type here would be a silent permission change and is out of scope.

**`detailRowCap` for all 14 existing entries is `Number.POSITIVE_INFINITY`** — documented unchanged behaviour, not a new limit.

- [ ] **Step 1: Write the failing registry test**

```ts
// apps/api/src/services/reportRegistry.test.ts
import { describe, expect, it } from 'vitest';
import { REPORT_TYPES, BUSINESS_REPORT_TYPES } from '@breeze/shared';
import { MANAGED_EVIDENCE_REPORT_TYPES } from '@breeze/shared';
import { REPORT_GENERATORS, reportTypeDef } from './reportRegistry';
import { MANAGED_EVIDENCE_REGISTRY } from './managedEvidenceRegistry';
import { PORTAL_DEFINITIONS_FOR_TEST } from './portal/reportsSelfService';

describe('REPORT_GENERATORS', () => {
  it('has exactly one entry per REPORT_TYPES value, keyed by its own type', () => {
    expect(Object.keys(REPORT_GENERATORS).sort()).toEqual([...REPORT_TYPES].sort());
    for (const [key, def] of Object.entries(REPORT_GENERATORS)) expect(def.type).toBe(key);
  });

  it('every entry declares at least one supported scope, and only known scopes', () => {
    for (const def of Object.values(REPORT_GENERATORS)) {
      expect(def.supportedScopes.length).toBeGreaterThan(0);
      for (const s of def.supportedScopes) expect(['organization', 'partner']).toContain(s);
    }
  });

  it('only the three #3198 business types support partner scope', () => {
    const partnerCapable = Object.values(REPORT_GENERATORS)
      .filter((d) => d.supportedScopes.includes('partner'))
      .map((d) => d.type)
      .sort();
    expect(partnerCapable).toEqual([...BUSINESS_REPORT_TYPES].sort());
  });

  // Spec §6 (2026-09-21): the registry COMPOSES with the evidence registry
  // rather than becoming a fourth hand-parallel list. This is the assertion
  // that keeps `execution` honest against all three existing twins.
  it("execution:'managed_evidence' keys equal MANAGED_EVIDENCE_REGISTRY and both its twins", () => {
    const fromRegistry = Object.values(REPORT_GENERATORS)
      .filter((d) => d.execution === 'managed_evidence').map((d) => d.type).sort();
    expect(fromRegistry).toEqual([...Object.keys(MANAGED_EVIDENCE_REGISTRY)].sort());
    expect(fromRegistry).toEqual([...MANAGED_EVIDENCE_REPORT_TYPES].sort());
    const portalManaged = PORTAL_DEFINITIONS_FOR_TEST
      .map((d) => d.type)
      .filter((t): t is string => fromRegistry.includes(t))
      .sort();
    expect(portalManaged).toEqual(fromRegistry);
  });

  it('business types are NOT managed evidence and NOT portal definitions', () => {
    for (const t of BUSINESS_REPORT_TYPES) {
      expect(REPORT_GENERATORS[t].execution).toBe('user');
      expect(Object.keys(MANAGED_EVIDENCE_REGISTRY)).not.toContain(t);
      expect(PORTAL_DEFINITIONS_FOR_TEST.map((d) => d.type)).not.toContain(t);
    }
  });

  it('every existing type keeps an uncapped detail-row budget', () => {
    for (const def of Object.values(REPORT_GENERATORS)) {
      const expected = BUSINESS_REPORT_TYPES.includes(def.type as never)
        ? 5000 : Number.POSITIVE_INFINITY;
      expect(def.detailRowCap).toBe(expected);
    }
  });

  it('reportTypeDef throws a named error for an unknown type rather than returning undefined', () => {
    expect(() => reportTypeDef('not_a_type' as never)).toThrow(/not a known report type/);
  });
});
```

Note `PORTAL_DEFINITIONS_FOR_TEST` is already exported (`apps/api/src/services/portal/reportsSelfService.ts:135`). The portal list also contains three *self-service* types (`executive_summary`, `security_compliance_posture`, `hardware_lifecycle`) that are not managed evidence, which is why the assertion filters to the managed set rather than comparing the whole array.

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/services/reportRegistry.test.ts`
Expected: FAIL — `Failed to resolve import "./reportRegistry"`.

- [ ] **Step 3: Move the error classes to their own module (kills the import cycle)**

```ts
// apps/api/src/services/reportErrors.ts
/**
 * Report generation errors live here, not in reportGenerationService.ts, so
 * that reportRegistry.ts can throw them without importing the service back —
 * the service imports the registry, and a value-level cycle around the
 * registry's top-level Object.freeze() initializer is a TDZ ReferenceError at
 * module load, not a style nit.
 *
 * reportGenerationService.ts RE-EXPORTS StoredArtifactOnlyReportError and
 * UnexecutableReportScopeError verbatim, so every existing import site and
 * every `instanceof` check keeps working against the same class identity.
 */
export class StoredArtifactOnlyReportError extends Error {
  readonly code = 'stored_artifact_only';
  constructor(type: string) {
    super(`Report type ${type} is a stored artifact and cannot be generated`);
    this.name = 'StoredArtifactOnlyReportError';
  }
}

export class UnexecutableReportScopeError extends Error {
  constructor(message = 'Report execution authority is not executable') {
    super(message);
    this.name = 'UnexecutableReportScopeError';
  }
}

/**
 * The requested ReportScope kind is not one this report type supports
 * (#3198 spec §6). Routes map it to 400 `{ error: 'unsupported_report_scope' }`
 * — a 400, not a 403: the caller's access is fine, the *combination* of type and
 * owner axis is what has no meaning. W01 already raises this for partner-owned
 * rows of existing types; W02 moves the decision into the registry.
 */
export class UnsupportedReportScopeError extends Error {
  readonly code = 'unsupported_report_scope';
  constructor(type: string, scopeKind: string) {
    super(`Report type ${type} does not support ${scopeKind} scope`);
    this.name = 'UnsupportedReportScopeError';
  }
}
```

Then in `reportGenerationService.ts`, delete the two class declarations (`:91-98` and `:206-211`) and put this near the top of the file:

```ts
export {
  StoredArtifactOnlyReportError,
  UnexecutableReportScopeError,
} from './reportErrors';
import {
  StoredArtifactOnlyReportError,
  UnexecutableReportScopeError,
  UnsupportedReportScopeError,
} from './reportErrors';
```

(Both the `export … from` and the `import` are needed: the re-export does not bring the names into this module's own scope, and the file throws both classes in ~15 places.)

- [ ] **Step 4: Write the registry**

```ts
// apps/api/src/services/reportRegistry.ts
import type { z } from 'zod';
import type { ReportType } from '@breeze/shared';
import type { Permission } from './permissions';
import type { ReportScope } from './reportScope';
import type { ReportExecutionAuthority, ReportGenerationAuthority } from './siteScope';
// TYPE-ONLY, and it must stay type-only: a value import of
// reportGenerationService here reinstates the cycle this module was split to
// avoid. Every generator is reached through `await import` inside a thunk.
import type { EvidenceRunContext, ReportResult } from './reportGenerationService';
import { StoredArtifactOnlyReportError, UnexecutableReportScopeError } from './reportErrors';
import {
  endpointManagementConfigSchema, hardwareLifecycleConfigSchema,
  identityAccessConfigSchema, legacyReportConfigSchema,
  securityCompliancePostureConfigSchema, storedArtifactConfigSchema,
  threatDetectionConfigSchema, vulnerabilityManagementConfigSchema,
} from './reportConfigSchemas';

export interface ReportTypeDef<C = unknown> {
  /** Identical to the key. The registry has no second naming space. */
  readonly type: ReportType;
  /** English display name. i18n for the web list lives in the locale files
   *  (`reports.reportsList.reportTypes.<type>`); this is for logs and PDFs. */
  readonly label: string;
  /** The type's OWN config schema (spec §6). Replaces the shared loose object
   *  that used to spread six per-type field sets into one. */
  readonly configSchema: z.ZodType<C>;
  readonly supportedScopes: readonly ('organization' | 'partner')[];
  /** 'managed_evidence' means MANAGED_EVIDENCE_REGISTRY authorizes a system
   *  principal for this type. The registry test pins the two sets equal. */
  readonly execution: 'user' | 'managed_evidence';
  /** Checked in the ROUTE layer (the registry has no request context); listed
   *  here so one place says what a type reads. Empty for every pre-#3198 type —
   *  their route middleware is unchanged. */
  readonly requiredPermissions: readonly Permission[];
  /** Max DETAIL rows stored in `report_runs.result.rows`. Aggregates are always
   *  computed over the full set first (§4). POSITIVE_INFINITY = unchanged. */
  readonly detailRowCap: number;
  generate(
    scope: ReportScope,
    config: C,
    authority: ReportGenerationAuthority,
    evidence?: EvidenceRunContext,
  ): Promise<ReportResult>;
}

/** Every pre-#3198 generator takes an org id. Reaching one with a partner scope
 *  is a programming error, not a user error: `dispatchReportGeneration` has
 *  already refused it via `supportedScopes`. */
function orgOf(scope: ReportScope): string {
  if (scope.kind !== 'organization') {
    throw new UnexecutableReportScopeError(
      `This report type requires an organization scope, got ${scope.kind}`,
    );
  }
  return scope.orgId;
}

/**
 * The generators below predate #5784 and take the request-path authority only.
 * A system authority can only reach a `managed_evidence` entry, and every such
 * entry passes `authority` through untouched — so this narrowing is unreachable
 * in practice and a loud refusal if a later wave marks a type managed_evidence
 * without giving it an entry that accepts one. Moved verbatim from
 * `reportGenerationService.ts:891-899`.
 */
function requestAuthority(
  authority: ReportGenerationAuthority,
  type: ReportType,
): ReportExecutionAuthority {
  if (authority.principalKind === 'system') {
    throw new UnexecutableReportScopeError(
      `${type} has no managed evidence generator and cannot run under system authority`,
    );
  }
  return authority;
}

const ORG_ONLY = ['organization'] as const;
const NO_EXTRA_PERMISSIONS: readonly Permission[] = [];
const UNCAPPED = Number.POSITIVE_INFINITY;

export const REPORT_GENERATORS = Object.freeze({
  device_inventory: {
    type: 'device_inventory', label: 'Device inventory',
    configSchema: legacyReportConfigSchema, supportedScopes: ORG_ONLY,
    execution: 'user', requiredPermissions: NO_EXTRA_PERMISSIONS, detailRowCap: UNCAPPED,
    // Takes `authority` (not requestAuthority()) — matching the arm this
    // replaced at reportGenerationService.ts:901-902 exactly.
    generate: async (scope, config, authority) => {
      const { generateDeviceInventoryReport } = await import('./reportGenerationService');
      return generateDeviceInventoryReport(orgOf(scope), config as Record<string, unknown>, authority);
    },
  },
  software_inventory: {
    type: 'software_inventory', label: 'Software inventory',
    configSchema: legacyReportConfigSchema, supportedScopes: ORG_ONLY,
    execution: 'user', requiredPermissions: NO_EXTRA_PERMISSIONS, detailRowCap: UNCAPPED,
    generate: async (scope, config, authority) => {
      const { generateSoftwareInventoryReport } = await import('./reportGenerationService');
      return generateSoftwareInventoryReport(
        orgOf(scope), config as Record<string, unknown>,
        requestAuthority(authority, 'software_inventory'));
    },
  },
  alert_summary: {
    type: 'alert_summary', label: 'Alert summary',
    configSchema: legacyReportConfigSchema, supportedScopes: ORG_ONLY,
    execution: 'user', requiredPermissions: NO_EXTRA_PERMISSIONS, detailRowCap: UNCAPPED,
    generate: async (scope, config, authority) => {
      const { generateAlertSummaryReport } = await import('./reportGenerationService');
      return generateAlertSummaryReport(
        orgOf(scope), config as Record<string, unknown>,
        requestAuthority(authority, 'alert_summary'));
    },
  },
  compliance: {
    type: 'compliance', label: 'Compliance',
    configSchema: legacyReportConfigSchema, supportedScopes: ORG_ONLY,
    execution: 'user', requiredPermissions: NO_EXTRA_PERMISSIONS, detailRowCap: UNCAPPED,
    generate: async (scope, config, authority) => {
      const { generateComplianceReport } = await import('./reportGenerationService');
      return generateComplianceReport(
        orgOf(scope), config as Record<string, unknown>,
        requestAuthority(authority, 'compliance'));
    },
  },
  performance: {
    type: 'performance', label: 'Performance',
    configSchema: legacyReportConfigSchema, supportedScopes: ORG_ONLY,
    execution: 'user', requiredPermissions: NO_EXTRA_PERMISSIONS, detailRowCap: UNCAPPED,
    generate: async (scope, config, authority) => {
      const { generatePerformanceReport } = await import('./reportGenerationService');
      return generatePerformanceReport(
        orgOf(scope), config as Record<string, unknown>,
        requestAuthority(authority, 'performance'));
    },
  },
  executive_summary: {
    type: 'executive_summary', label: 'Executive summary',
    configSchema: legacyReportConfigSchema, supportedScopes: ORG_ONLY,
    execution: 'user', requiredPermissions: NO_EXTRA_PERMISSIONS, detailRowCap: UNCAPPED,
    generate: async (scope, config, authority) => {
      const { generateExecutiveSummaryReport } = await import('./reportGenerationService');
      return generateExecutiveSummaryReport(
        orgOf(scope), config as Record<string, unknown>,
        requestAuthority(authority, 'executive_summary'));
    },
  },
  security_compliance_posture: {
    type: 'security_compliance_posture', label: 'Security & compliance posture',
    configSchema: securityCompliancePostureConfigSchema, supportedScopes: ORG_ONLY,
    execution: 'user', requiredPermissions: NO_EXTRA_PERMISSIONS, detailRowCap: UNCAPPED,
    generate: async (scope, config, authority) => {
      const { generateSecurityCompliancePostureReport } = await import('./securityComplianceReport');
      return generateSecurityCompliancePostureReport(
        orgOf(scope), config as Record<string, unknown>,
        requestAuthority(authority, 'security_compliance_posture'));
    },
  },
  // P2-3 (#4190) — stored, never generated. The `report_runs` row is written
  // once inside the agent run's own transaction (persistNarrativeReport).
  ai_org_narrative: {
    type: 'ai_org_narrative', label: 'AI organization narrative',
    configSchema: storedArtifactConfigSchema, supportedScopes: ORG_ONLY,
    execution: 'user', requiredPermissions: NO_EXTRA_PERMISSIONS, detailRowCap: UNCAPPED,
    generate: async () => { throw new StoredArtifactOnlyReportError('ai_org_narrative'); },
  },
  // Fleet Designer W01 (#5651) — stored, never generated, same as above.
  ai_fleet_design: {
    type: 'ai_fleet_design', label: 'AI fleet design',
    configSchema: storedArtifactConfigSchema, supportedScopes: ORG_ONLY,
    execution: 'user', requiredPermissions: NO_EXTRA_PERMISSIONS, detailRowCap: UNCAPPED,
    generate: async () => { throw new StoredArtifactOnlyReportError('ai_fleet_design'); },
  },
  hardware_lifecycle: {
    type: 'hardware_lifecycle', label: 'Hardware lifecycle',
    configSchema: hardwareLifecycleConfigSchema, supportedScopes: ORG_ONLY,
    execution: 'user', requiredPermissions: NO_EXTRA_PERMISSIONS, detailRowCap: UNCAPPED,
    generate: async (scope, config, authority) => {
      const { generateHardwareLifecycleReport } = await import('./hardwareLifecycleReport');
      return generateHardwareLifecycleReport(
        orgOf(scope), config as Record<string, unknown>,
        requestAuthority(authority, 'hardware_lifecycle'));
    },
  },
  // #5784 W02/W03/W04/W06 — managed evidence. `authority` is passed AS-IS
  // (never requestAuthority()): a system authority legitimately reaches these.
  threat_detection_review: {
    type: 'threat_detection_review', label: 'Threat detection review',
    configSchema: threatDetectionConfigSchema, supportedScopes: ORG_ONLY,
    execution: 'managed_evidence', requiredPermissions: NO_EXTRA_PERMISSIONS, detailRowCap: UNCAPPED,
    generate: async (scope, config, authority, evidence) => {
      const { generateThreatDetectionReport } = await import('./threatDetectionReport');
      return generateThreatDetectionReport(
        orgOf(scope), config as Record<string, unknown>, authority, evidence);
    },
  },
  endpoint_management_review: {
    type: 'endpoint_management_review', label: 'Endpoint management review',
    configSchema: endpointManagementConfigSchema, supportedScopes: ORG_ONLY,
    execution: 'managed_evidence', requiredPermissions: NO_EXTRA_PERMISSIONS, detailRowCap: UNCAPPED,
    generate: async (scope, config, authority, evidence) => {
      const { generateEndpointManagementReport } = await import('./endpointManagementReport');
      return generateEndpointManagementReport(
        orgOf(scope), config as Record<string, unknown>, authority, evidence);
    },
  },
  vulnerability_management: {
    type: 'vulnerability_management', label: 'Vulnerability management',
    configSchema: vulnerabilityManagementConfigSchema, supportedScopes: ORG_ONLY,
    execution: 'managed_evidence', requiredPermissions: NO_EXTRA_PERMISSIONS, detailRowCap: UNCAPPED,
    generate: async (scope, config, authority, evidence) => {
      const { generateVulnerabilityManagementReport } = await import('./vulnerabilityManagementReport');
      return generateVulnerabilityManagementReport(
        orgOf(scope), config as Record<string, unknown>, authority, evidence);
    },
  },
  identity_access_review: {
    type: 'identity_access_review', label: 'Identity & access review',
    configSchema: identityAccessConfigSchema, supportedScopes: ORG_ONLY,
    execution: 'managed_evidence', requiredPermissions: NO_EXTRA_PERMISSIONS, detailRowCap: UNCAPPED,
    generate: async (scope, config, authority, evidence) => {
      const { generateIdentityAccessReport } = await import('./identityAccessReport');
      return generateIdentityAccessReport(
        orgOf(scope), config as Record<string, unknown>, authority, evidence);
    },
  },
  // #3198 W02 business types are appended by Tasks 10, 11 and 12. Until then
  // this object is missing three keys of `ReportType` and `tsc` says so — which
  // is the point: a missing key is a compile error, exactly the guarantee the
  // `never` default in the old switch gave.
} as const satisfies Readonly<Record<string, ReportTypeDef>>) as Readonly<Record<ReportType, ReportTypeDef>>;

export function reportTypeDef(type: ReportType): ReportTypeDef {
  const def = (REPORT_GENERATORS as Readonly<Record<string, ReportTypeDef | undefined>>)[type];
  if (!def) throw new Error(`${String(type)} is not a known report type`);
  return def;
}
```

**Working around the three-missing-keys window:** Steps 4–7 leave `REPORT_GENERATORS` incomplete until Task 10 adds the first business entry. To keep the tree compiling between tasks, add the three business keys **now** as temporary entries whose `generate` throws `new Error('not implemented until #3198 W02 task 10/11/12')`, with `configSchema: legacyReportConfigSchema` and the final `supportedScopes` / `execution` / `detailRowCap: 5000` values. Tasks 10–12 replace the body and the schema; the registry test's scope/execution/cap assertions are green from this task onward. **Do not** ship the PR with a throwing placeholder — Task 13's final check greps for the string.

- [ ] **Step 5: Rewrite `dispatchReportGeneration`**

Replace `reportGenerationService.ts:858-961` (the JSDoc, the signature, the guards and the whole switch) with:

```ts
/**
 * ONE dispatcher for both execution paths. The 13-arm switch this replaced is
 * now `REPORT_GENERATORS` (#3198 spec §6); exhaustiveness is preserved because
 * the record is keyed by the closed `ReportType` union — a missing key is a
 * compile error, the same guarantee the `never` default gave.
 *
 * GATE ORDER IS LOAD-BEARING. `supportedScopes` is checked immediately after
 * the system-authority refusal and BEFORE `assertReportExecutionPreflight`:
 * the preflight's `assertExecutableAuthority` compares the authority's owner
 * axis against the report's, so a partner scope against an org-only type would
 * die there as an "organization mismatch" — a 403/500 shape — instead of the
 * 400 `unsupported_report_scope` the route is written to translate.
 */
async function dispatchReportGeneration(
  type: ReportType,
  scope: ReportScope,
  config: Record<string, unknown>,
  authority: ReportGenerationAuthority,
  evidence?: EvidenceRunContext,
): Promise<ReportResult> {
  const def = reportTypeDef(type);

  if (authority?.principalKind === 'system' && def.execution !== 'managed_evidence') {
    throw new UnexecutableReportScopeError(
      `${type} is not a managed evidence type and cannot run under system authority`,
    );
  }

  // BEFORE the preflight — see the gate-order note above.
  if (!def.supportedScopes.includes(scope.kind)) {
    throw new UnsupportedReportScopeError(type, scope.kind);
  }

  const owner = reportOwnerOfScope(scope);
  assertReportExecutionPreflight(owner, config, authority, type);

  if (
    authority.principalKind === 'portal_user'
    && type !== 'executive_summary'
    && type !== 'security_compliance_posture'
    && type !== 'hardware_lifecycle'
  ) {
    throw new UnexecutableReportScopeError(
      `Portal-user authority cannot generate report type ${type}`,
    );
  }
  if (authority.scope.kind === 'restricted' && authority.scope.siteIds.length === 0) {
    return zeroSafeReport(type, authority.scope.orgId);
  }

  return def.generate(scope, config, authority, evidence);
}

/** Dispatch to the matching report generator by type (request path).
 *
 *  BREAKING within the repo (spec §3.2): the second parameter widens from
 *  `orgId: string` to `ReportScope`. Org-scope call sites read
 *  `generateReport(type, organizationScope(orgId), config, authority)`. */
export async function generateReport(
  type: ReportType,
  scope: ReportScope,
  config: Record<string, unknown>,
  authority: ReportExecutionAuthority,
): Promise<ReportResult> {
  return dispatchReportGeneration(type, scope, config, authority);
}

/**
 * The managed-evidence execution path (#5784, OD-5 = B). UNCHANGED signature:
 * managed evidence is org-owned by construction (a service deliverable belongs
 * to one customer), so it keeps taking an org id and builds the scope itself.
 */
export async function generateManagedEvidenceReport(
  type: ManagedEvidenceType,
  orgId: string,
  config: Record<string, unknown>,
  evidence: EvidenceRunContext | undefined,
): Promise<ReportResult> {
  if (!isManagedEvidenceType(type)) {
    throw new UnexecutableReportScopeError(`${type} is not a managed evidence type`);
  }
  return dispatchReportGeneration(
    type, organizationScope(orgId), config, systemReportAuthorityFor(orgId), evidence,
  );
}
```

Add at the top of the file: `import { REPORT_GENERATORS, reportTypeDef } from './reportRegistry';` and `import { organizationScope, reportOwnerOfScope, type ReportScope } from './reportScope';`. `REPORT_GENERATORS` itself is not referenced by name in the dispatcher — import only `reportTypeDef` and drop the unused name rather than adding an eslint suppression.

- [ ] **Step 6: Add the three `zeroSafeReport` arms**

`zeroSafeReport` (`:991-1085`) is keyed by `ReportType` with a `never` default, so it does not compile until the three business types have arms. The three business reports have **no site dimension at all** — tickets, time entries and invoices are not site-scoped — so a site-restricted authority is a refusal-shaped empty, exactly like `identity_access_review`'s OD-8 = A, not a filtered view. Insert before the `default:`:

```ts
    // #3198 W02. Tickets, time entries and invoices carry no site axis, so a
    // site-restricted authority queried NOTHING. Each empty*Summary() prints
    // that sentence on the artifact rather than a reassuring zero — a zero here
    // would read as "you had no overdue invoices", which is a lie.
    case 'ticket_sla_attainment':
      return { rows: [], rowCount: 0, summary: emptyTicketSlaSummary(SITE_RESTRICTED_NOTE) as unknown as Record<string, unknown> };
    case 'technician_time_billability':
      return { rows: [], rowCount: 0, summary: emptyTechnicianTimeSummary(SITE_RESTRICTED_NOTE) as unknown as Record<string, unknown> };
    case 'ar_aging':
      return { rows: [], rowCount: 0, summary: emptyArAgingSummary(SITE_RESTRICTED_NOTE) as unknown as Record<string, unknown> };
```

with, near the top of the file:

```ts
const SITE_RESTRICTED_NOTE =
  'This report ran under a site-restricted authority. Tickets, time entries and '
  + 'invoices have no site dimension, so nothing was queried — the figures below '
  + 'are not measured, and they are not zero.';
```

The three factories arrive in Task 5; until then this step does not compile. **Do Step 6 after Task 5** if you are executing strictly in order — or stub the three arms with `return emptyRowsReport();` and fix them in Task 5, whose own test asserts the summary is present. The ordering note exists because `emptyRowsReport()` returns **no summary at all**, and `buildReportPdf`'s arms are guarded on the summary being present, so the artifact would silently fall through to `renderGenericReport` and print "No data available for the selected filters" — the exact failure `endpoint_management_review`'s comment at `:1031-1039` documents.

- [ ] **Step 7: Run the registry test and the full service suite**

```bash
cd apps/api && npx vitest run src/services/reportRegistry.test.ts src/services/reportGenerationService.test.ts \
  src/services/managedEvidenceRegistry.test.ts src/services/portal/reportsSelfService.test.ts
```

Expected: PASS. `reportGenerationService.test.ts` is the behaviour-preservation proof for this task — it exercises every arm's dispatch, the stored-artifact throws and the system-authority refusal. **If any of its assertions need editing beyond the `generateReport(type, organizationScope(ORG_ID), …)` call shape, the migration was not mechanical — stop and re-read the mapping table.**

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/services/reportErrors.ts apps/api/src/services/reportRegistry.ts \
  apps/api/src/services/reportRegistry.test.ts apps/api/src/services/reportGenerationService.ts \
  apps/api/src/services/reportGenerationService.test.ts
git commit -m "refactor(reports): REPORT_GENERATORS registry replaces the 13-arm dispatch switch (#3198 W02)"
```

---

### Task 4: Per-type config schemas, and a `type`-discriminated `reportConfigSchema` that strips nothing

`reportConfigSchema` is `z.looseObject(reportConfigFields)` today (`apps/api/src/routes/reports/schemas.ts:235-270`), spreading six per-type field sets plus the shared builder keys into **one** object. Two consequences the registry must preserve:

1. **It is LOOSE.** The builder round-trips presentation metadata through `config` (`builderType`, `dataSource`, `filterConditions`, `aggregation`, `chartType`, `exportFormats`, `templateName`, …) and none of it is declared. A strict per-type schema would silently drop every one of those keys on the next `PUT /reports/:id`, which replaces `config` wholesale (`ReportBuilder.tsx:104-109` documents exactly this hazard). **Every per-type schema in the registry is therefore `z.looseObject(...)`**, and Step 1's fixture test is what proves it.
2. **Cross-type keys are currently accepted everywhere.** `windowDays` parses on a `device_inventory` config today because the sets are spread into one object. Under a loose discriminated lookup it still parses — as an undeclared passthrough key rather than a validated one. Values that used to be *rejected* (e.g. `windowDays: 9999`, above the posture schema's `.max(365)`) become *accepted-and-ignored* on the wrong type. That is a deliberate loosening in the strip-nothing direction and is asserted explicitly, so nobody later "tightens" it back into a data-loss bug.

**Files:**
- Create: `apps/api/src/services/reportConfigSchemas.ts`
- Create: `apps/api/src/routes/reports/schemas.configParity.test.ts`
- Modify: `apps/api/src/routes/reports/schemas.ts` (`:57-215` move out; `:235-270` and `:296-320` rewritten)
- Modify: `apps/api/src/routes/reports/schemas.config.test.ts` (the hand-parallel `*ConfigFields` pins are replaced by the parity test; delete the assertions that reference deleted symbols, keep the rest)

**Interfaces:**
- Consumes: Task 1's `REPORT_TYPES`.
- Produces: `legacyReportConfigSchema`, `storedArtifactConfigSchema`, `securityCompliancePostureConfigSchema`, `hardwareLifecycleConfigSchema`, `threatDetectionConfigSchema`, `endpointManagementConfigSchema`, `vulnerabilityManagementConfigSchema`, `identityAccessConfigSchema` — all `z.ZodType<Record<string, unknown>>`, all loose. Task 3's registry imports them. `reportConfigSchema` in `schemas.ts` keeps its name and its place in `createReportSchema` / `updateReportSchema`.

**Why the schemas move to `services/`:** `reportRegistry.ts` (a service) needs them, and `routes/reports/schemas.ts` already imports *from* services (`reportGenerationService.ts:29-31` documents the existing back-reference it works around). Putting them in a service module makes the dependency point one way.

- [ ] **Step 1: Write the failing compatibility test — old parse vs new parse, per type, on real stored shapes**

```ts
// apps/api/src/routes/reports/schemas.configParity.test.ts
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { REPORT_TYPES } from '@breeze/shared';
import { reportConfigSchema } from './schemas';

/**
 * The shape `reportConfigSchema` had BEFORE the registry split: one loose
 * object over every declared key. Frozen here as a test-only fixture so the
 * discriminated lookup can be compared against what actually shipped.
 */
const LEGACY_LOOSE = z.looseObject({
  dateRange: z.object({ start: z.string().optional(), end: z.string().optional(),
    preset: z.enum(['last_7_days', 'last_30_days', 'last_90_days', 'custom']).optional() }).optional(),
  filters: z.object({ siteIds: z.array(z.string().guid()).optional(),
    deviceIds: z.array(z.string().guid()).optional(),
    osTypes: z.array(z.enum(['windows', 'macos', 'linux'])).optional(),
    status: z.array(z.string()).optional(), severity: z.array(z.string()).optional() }).optional(),
  columns: z.array(z.string()).optional(), groupBy: z.string().optional(),
  sortBy: z.string().optional(), sortOrder: z.enum(['asc', 'desc']).optional(),
  schedule: z.object({ time: z.string().optional(), day: z.string().optional(),
    date: z.coerce.string().optional() }).optional(),
  emailRecipients: z.array(z.string().max(254)).max(50).optional(),
  sites: z.array(z.string().guid()).optional(), windowDays: z.number().int().optional(),
  minPasswordLength: z.number().int().optional(), maxLocalAdmins: z.number().int().optional(),
  maxAvDefinitionsAgeDays: z.number().int().optional(), maxSecurityStatusAgeDays: z.number().int().optional(),
  includeCis: z.boolean().optional(), backupRequired: z.boolean().optional(),
  replaceAgeYears: z.number().int().optional(), serverReplaceAgeYears: z.number().int().optional(),
  includeManualAssets: z.boolean().optional(), includeOtherEquipment: z.boolean().optional(),
  includeCarriedIn: z.boolean().optional(), topIncidents: z.number().int().optional(),
  staleEnrolmentDays: z.number().int().optional(), trendDays: z.number().int().optional(),
  includeLicences: z.boolean().optional(),
  severityFloor: z.enum(['critical', 'high', 'medium', 'low']).optional(),
  topN: z.number().int().optional(), includeAccepted: z.boolean().optional(),
  dormantDays: z.number().int().optional(), homeCountries: z.array(z.string()).optional(),
  adminDetail: z.boolean().optional(),
});

/** Presentation metadata the builder round-trips through `config`. NONE of it
 *  is declared by any schema; all of it must survive. */
const BUILDER_METADATA = {
  builderType: 'devices', dataSource: { devices: true }, filterConditions: [],
  aggregation: 'count', chartType: 'bar', exportFormats: ['csv'], templateName: 'My template',
} as const;

/** One realistic stored config per type — the shapes that are actually in
 *  `reports.config` on production rows today. */
const FIXTURES: Record<string, Record<string, unknown>> = {
  device_inventory: { ...BUILDER_METADATA, columns: ['hostname'], sortBy: 'hostname', sortOrder: 'asc',
    filters: { siteIds: [], osTypes: ['windows'] }, schedule: { time: '07:00', day: 'monday' },
    emailRecipients: ['ops@example.com'] },
  software_inventory: { ...BUILDER_METADATA, dateRange: { preset: 'last_30_days' } },
  alert_summary: { ...BUILDER_METADATA, dateRange: { preset: 'last_7_days' }, groupBy: 'severity' },
  compliance: { ...BUILDER_METADATA },
  performance: { ...BUILDER_METADATA, dateRange: { start: '2026-08-01', end: '2026-08-31' } },
  executive_summary: { dateRange: { preset: 'last_30_days' }, filters: { siteIds: [] } },
  security_compliance_posture: { dateRange: { preset: 'last_30_days' }, sites: [], windowDays: 30,
    minPasswordLength: 8, maxLocalAdmins: 2, maxAvDefinitionsAgeDays: 7, maxSecurityStatusAgeDays: 30,
    includeCis: true, backupRequired: true },
  ai_org_narrative: { sourceAiAgentScheduleId: 'x' },
  ai_fleet_design: {},
  hardware_lifecycle: { sites: [], replaceAgeYears: 4, serverReplaceAgeYears: 5,
    includeManualAssets: true, includeOtherEquipment: true },
  threat_detection_review: { sites: [], includeCarriedIn: true, topIncidents: 100 },
  endpoint_management_review: { sites: [], staleEnrolmentDays: 14, trendDays: 30, includeLicences: true },
  vulnerability_management: { sites: [], severityFloor: 'high', topN: 25, includeAccepted: true },
  identity_access_review: { dormantDays: 45, homeCountries: ['US'], adminDetail: true },
  ticket_sla_attainment: { period: { kind: 'last_full_month' }, groupBy: 'organization', includeNoSla: true },
  technician_time_billability: { period: { kind: 'last_30_days' }, groupBy: 'technician', weeklyCapacityHours: 40 },
  ar_aging: { groupBy: 'organization', includePaidInPeriod: false },
};

describe('reportConfigSchema — discriminated lookup keeps the loose contract', () => {
  it('has a fixture for every report type', () => {
    expect(Object.keys(FIXTURES).sort()).toEqual([...REPORT_TYPES].sort());
  });

  for (const type of REPORT_TYPES) {
    it(`${type}: parses, and drops no key the old loose schema kept`, () => {
      const fixture = FIXTURES[type]!;
      const before = LEGACY_LOOSE.parse(fixture);
      const after = reportConfigSchema.parse({ ...fixture, type });
      for (const key of Object.keys(before)) {
        expect(after, `${type}.${key} was dropped`).toHaveProperty(key);
        expect(after[key as keyof typeof after]).toEqual(before[key as keyof typeof before]);
      }
    });

    it(`${type}: keeps undeclared builder metadata`, () => {
      const after = reportConfigSchema.parse({ ...FIXTURES[type]!, ...BUILDER_METADATA, type });
      for (const key of Object.keys(BUILDER_METADATA)) expect(after).toHaveProperty(key);
    });
  }

  it('a config with no `type` discriminator still parses (legacy rows and PATCHes)', () => {
    const after = reportConfigSchema.parse({ ...BUILDER_METADATA, columns: ['hostname'] });
    expect(after).toHaveProperty('builderType');
    expect(after).toHaveProperty('columns');
  });

  it('applies the OWNING type\'s validation — a bad posture windowDays is rejected on posture', () => {
    expect(() => reportConfigSchema.parse({ type: 'security_compliance_posture', windowDays: 9999 })).toThrow();
  });

  it('DELIBERATE LOOSENING: a foreign key is passed through, not validated, on another type', () => {
    // Before the split this threw (one spread object validated every key).
    // Now it is an undeclared passthrough key. Recorded so nobody "fixes" it
    // into a strict schema and silently deletes builder metadata.
    const after = reportConfigSchema.parse({ type: 'device_inventory', windowDays: 9999 });
    expect(after).toMatchObject({ windowDays: 9999 });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/routes/reports/schemas.configParity.test.ts`
Expected: FAIL — the three business fixtures have no matching type yet, and `reportConfigSchema.parse({..., type})` currently ignores `type` entirely so the "owning type's validation" case does not throw. Both failures are real and go away in Steps 3–4.

- [ ] **Step 3: Move the per-type schemas into `services/reportConfigSchemas.ts`**

Cut `securityCompliancePostureConfigSchema` (`schemas.ts:59-77`), `hardwareLifecycleConfigSchema` (`:103-109`), `threatDetectionConfigSchema` (`:129-133`), `endpointManagementConfigSchema` (`:151-156`), `vulnerabilityManagementConfigSchema` (`:176-181`) and `identityAccessConfigSchema` (`:202-206`) into the new file **with their comments intact**, change each `z.object(` to `z.looseObject(`, and **delete the six `*ConfigFields` companions** (`:86-95`, `:114-120`, `:138-142`, `:161-166`, `:186-191`, `:211-215`). Those existed only because the spread needed default-free twins; a per-type schema does not, and `schemas.config.test.ts`'s hand-parallel pin goes with them.

Add in the same file:

```ts
/** The pre-#3198 shared keys. Every type that has no per-type schema of its own
 *  (the six original builder-driven types) uses this. Loose, because the builder
 *  round-trips undeclared presentation metadata through `config`. */
export const legacyReportConfigSchema = z.looseObject({
  dateRange: z.object({ start: z.string().optional(), end: z.string().optional(),
    preset: z.enum(['last_7_days', 'last_30_days', 'last_90_days', 'custom']).optional() }).optional(),
  filters: z.object({ siteIds: z.array(z.string().guid()).optional(),
    deviceIds: z.array(z.string().guid()).optional(),
    osTypes: z.array(z.enum(['windows', 'macos', 'linux'])).optional(),
    status: z.array(z.string()).optional(), severity: z.array(z.string()).optional() }).optional(),
  columns: z.array(z.string()).optional(), groupBy: z.string().optional(),
  sortBy: z.string().optional(), sortOrder: z.enum(['asc', 'desc']).optional(),
  schedule: reportScheduleDetailSchema.optional(),
  emailRecipients: z.array(z.string().regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/).max(254)).max(50).optional(),
});

/** ai_org_narrative / ai_fleet_design: system-written configs nobody validates
 *  on the way in, because nobody submits one. Loose and empty. */
export const storedArtifactConfigSchema = z.looseObject({});
```

Every per-type schema is `legacyReportConfigSchema.extend({ ...its own keys })` so the shared builder keys (`schedule`, `emailRecipients`, `dateRange`) keep validating on every type — they do today, via the spread, and dropping them would 400 a scheduled posture report on save.

- [ ] **Step 4: Rebuild `reportConfigSchema` as a discriminated lookup**

```ts
// apps/api/src/routes/reports/schemas.ts — replaces :235-270
import { REPORT_GENERATORS } from '../../services/reportRegistry';
import { legacyReportConfigSchema } from '../../services/reportConfigSchemas';

/**
 * Per-type config validation (#3198 spec §6). `type` is a DISCRIMINATOR that is
 * read and passed through, not a config field: create/update send it alongside
 * `config`, and the route copies it in before parsing.
 *
 * NOT a z.discriminatedUnion: that would require `type` on every config object,
 * and a PATCH body or a legacy stored row may not carry one. This is a manual
 * lookup with the legacy shared schema as the fallback — same acceptance
 * behaviour as the old single loose object for every one of the 13 existing
 * types, proven by schemas.configParity.test.ts.
 *
 * EVERY branch is loose. A strict branch would silently strip the builder's
 * presentation metadata on the next PUT, which replaces `config` wholesale.
 */
export const reportConfigSchema: z.ZodType<Record<string, unknown>> = z
  .looseObject({ type: z.string().optional() })
  .transform((value, ctx) => {
    const { type } = value as { type?: string };
    const def = type ? (REPORT_GENERATORS as Record<string, { configSchema: z.ZodType } | undefined>)[type] : undefined;
    const schema = def?.configSchema ?? legacyReportConfigSchema;
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) ctx.addIssue(issue);
      return z.NEVER;
    }
    return parsed.data as Record<string, unknown>;
  });
```

The `type` key is accepted (loose) and survives into the parsed object; `createReportSchema` already carries `type` as a sibling field, and the route copies it into the config before parsing (Task 11). A stored config that carries a stale `type` is harmless — it selects that type's schema, which is what it was written with.

- [ ] **Step 5: Give `generateReportSchema` the same treatment**

`generateReportSchema` (`:296-320`) re-declares the six spreads inside a **strict** `z.object`. Replace its `config` with the same lookup, discriminated on the schema's own sibling `type`:

```ts
export const generateReportSchema = z.object({
  type: reportTypeSchema.refine(notInternalReportType, INTERNAL_REPORT_TYPE_MESSAGE),
  config: z.looseObject({}).optional().default({}),
  format: z.enum(['csv', 'pdf', 'excel']).default('csv'),
  orgId: z.string().guid().optional(),
  // #3198 W02: partner-owned ad-hoc generation. W01 added the same field to
  // createReportSchema; the update schema `.omit({ ownerScope: true })`s it.
  ownerScope: z.enum(['organization', 'partner']).default('organization'),
}).transform((body, ctx) => {
  const schema = REPORT_GENERATORS[body.type].configSchema;
  const parsed = schema.safeParse(body.config);
  if (!parsed.success) { for (const i of parsed.error.issues) ctx.addIssue(i); return z.NEVER; }
  return { ...body, config: parsed.data as Record<string, unknown> };
});
```

Here the discriminator is unambiguous (`body.type` is required and already narrowed), so no fallback branch is needed.

- [ ] **Step 6: Prune `schemas.config.test.ts`**

Delete only the assertions that name the six removed `*ConfigFields` constants. Everything else in that file (defaults, bounds, the `looseObject` passthrough cases) stays and must still pass — it is the second half of the behaviour-preservation proof.

- [ ] **Step 7: Run every schema suite**

```bash
cd apps/api && npx vitest run src/routes/reports/schemas.configParity.test.ts \
  src/routes/reports/schemas.config.test.ts src/routes/reports/schemas.security.test.ts \
  src/services/reportRegistry.test.ts
```

Expected: PASS, 4 files. `schemas.security.test.ts` is the one that proves the internal-type write refusal survived the rewrite.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/services/reportConfigSchemas.ts apps/api/src/routes/reports/schemas.ts \
  apps/api/src/routes/reports/schemas.config.test.ts apps/api/src/routes/reports/schemas.configParity.test.ts \
  apps/api/src/services/reportRegistry.ts
git commit -m "refactor(reports): per-type config schemas owned by the registry, loose in every branch (#3198 W02)"
```

---

### Task 5: Shared summary types + `moneyFormat.ts`

Spec §3.4: the one genuinely new renderer capability is money/percent/minute formatting, shared by the three PDF modules and (in W03) by `reportExport.ts`. The summary types are the contract between the generators (Tasks 7–9), the renderers (Task 10) and W03's web components.

**Files:**
- Create: `packages/shared/src/types/businessReports.ts`
- Create: `packages/shared/src/reportPdf/moneyFormat.ts` (+ `.test.ts`)
- Modify: `packages/shared/src/types/index.ts` (one `export *` line)
- Modify: `packages/shared/src/reportPdf/index.ts` (export the three money helpers)

**Interfaces produced:**

```ts
/** Money is ALWAYS a per-currency array. There is no single-currency field
 *  anywhere in these types, by construction (Open Decision 4 = A). */
export type CurrencyAmountRow = { currencyCode: string; amount: string };

export type ReportPeriodMeta = { kind: string; start: string; end: string; label: string; timeZone: string };
export type ReportScopeMeta =
  | { kind: 'organization'; orgId: string; orgName: string | null }
  | { kind: 'partner'; partnerId: string; orgCount: number };
export type DetailRowMeta = { cap: number; stored: number; available: number; truncated: boolean };

export type TicketSlaGroupRow = {
  groupKey: string; groupLabel: string;
  ticketsTotal: number; noSlaTickets: number;
  responseEligible: number; responseMet: number; responseAttainment: number | null;
  resolutionEligible: number; resolutionMet: number; resolutionAttainment: number | null;
  breaches: number;
};
export type TicketSlaDetailRow = {
  ticketId: string; ticketNumber: string | null; internalNumber: string | null;
  orgId: string; orgName: string | null; subject: string;
  priority: string; category: string | null; assignedToName: string | null;
  createdAt: string; firstResponseAt: string | null; resolvedAt: string | null;
  responseSlaMinutes: number | null; resolutionSlaMinutes: number | null;
  slaPausedMinutes: number; responseOutcome: SlaOutcome; resolutionOutcome: SlaOutcome;
  stampedBreachAt: string | null; stampedBreachReason: string | null;
};
export type SlaOutcome = 'met' | 'missed' | 'pending' | 'no_target';
export type TicketSlaSummary = {
  generatedAt: string; period: ReportPeriodMeta; scope: ReportScopeMeta;
  groupBy: 'organization' | 'priority' | 'technician' | 'category';
  overall: Omit<TicketSlaGroupRow, 'groupKey' | 'groupLabel'>;
  groups: TicketSlaGroupRow[];
  worstGroupLabel: string | null;
  /** Recomputed-vs-stamped disagreement, surfaced not hidden (OD-2 = A). */
  stampDiscrepancy: { recomputedBreachNotStamped: number; stampedNotRecomputedBreach: number };
  detail: DetailRowMeta; notes: string[]; rows: TicketSlaDetailRow[];
};

export type TechnicianTimeGroupRow = {
  groupKey: string; groupLabel: string;
  loggedMinutes: number; capacityMinutes: number | null; utilization: number | null;
  billableMinutes: number; includedMinutes: number; nonBillableMinutes: number;
  billablePercent: number | null;
  billedMinutes: number; billingConversion: number | null;
  billableValue: CurrencyAmountRow[];
  averageRate: CurrencyAmountRow[];
};
export type TechnicianTimeSummary = {
  generatedAt: string; period: ReportPeriodMeta; scope: ReportScopeMeta;
  groupBy: 'technician' | 'organization' | 'work_type';
  weeklyCapacityHours: number; workingDays: number;
  overall: Omit<TechnicianTimeGroupRow, 'groupKey' | 'groupLabel'>;
  groups: TechnicianTimeGroupRow[];
  zeroTimeTechnicians: number;
  detail: DetailRowMeta; notes: string[]; rows: TechnicianTimeDetailRow[];
};
export type TechnicianTimeDetailRow = {
  entryId: string; startedAt: string; userId: string; userName: string | null;
  orgId: string | null; orgName: string | null; workTypeName: string | null;
  durationMinutes: number | null; billableMinutes: number | null;
  coverage: 'billable' | 'included' | 'non_billable';
  billingStatus: string; isApproved: boolean;
  hourlyRate: string | null; currencyCode: string | null;
};

export type ArAgingBucket = 'current' | 'd1_30' | 'd31_60' | 'd61_90' | 'd90_plus' | 'no_due_date';
export type ArAgingGroupRow = {
  groupKey: string; groupLabel: string; currencyCode: string;
  buckets: Record<ArAgingBucket, string>;   // numeric strings, never numbers
  openTotal: string; invoiceCount: number;
};
export type ArAgingDetailRow = {
  invoiceId: string; invoiceNumber: string | null; orgId: string; orgName: string | null;
  currencyCode: string; status: string; issueDate: string | null; dueDate: string | null;
  total: string; amountPaid: string; balance: string;
  daysOverdue: number | null; bucket: ArAgingBucket; lastPaymentAt: string | null;
};
export type ArAgingSummary = {
  generatedAt: string; asOf: string; timeZone: string; scope: ReportScopeMeta;
  groupBy: 'organization' | 'currency';
  byCurrency: ArAgingGroupRow[];           // one per currency, groupKey = currency
  groups: ArAgingGroupRow[];               // per groupBy axis, per currency
  /** Reconciliation line: balance > 0 in a status the AR-open set does not
   *  admit (draft / paid / void). Bucket totals + this = total open balance. */
  otherOpenBalance: CurrencyAmountRow[];
  detail: DetailRowMeta; notes: string[]; rows: ArAgingDetailRow[];
};

export function emptyTicketSlaSummary(note: string): TicketSlaSummary;
export function emptyTechnicianTimeSummary(note: string): TechnicianTimeSummary;
export function emptyArAgingSummary(note: string): ArAgingSummary;
```

Every `empty*Summary(note)` returns zeroed counts, empty arrays, `detail: { cap: 5000, stored: 0, available: 0, truncated: false }`, `notes: [note]`, and — critically — **`utilization`, `*Attainment`, `billingConversion` as `null`, never `0`**: the renderers print `N/A` for null and a real figure for `0`, and the two are different claims (`identityAccessPdf.ts:65-84` is the precedent).

- [ ] **Step 1: Write the failing money-format test**

```ts
// packages/shared/src/reportPdf/moneyFormat.test.ts
import { describe, expect, it } from 'vitest';
import { formatMinutes, formatMoney, formatPercent } from './moneyFormat';

describe('formatMoney', () => {
  it('formats a numeric STRING without going through a float', () => {
    expect(formatMoney('1234567.89', 'USD', 'en-US')).toBe('$1,234,567.89');
  });
  it('formats zero-decimal currencies with no minor unit', () => {
    expect(formatMoney('1234', 'JPY', 'en-US')).toBe('¥1,234');
  });
  it('is locale-aware', () => {
    // NBSP / narrow NBSP vary by ICU build — compare on the digits and symbol.
    expect(formatMoney('1234.5', 'EUR', 'de-DE')).toMatch(/1\.234,50\s?€/);
  });
  it('an unknown or empty currency code degrades to the bare number, never throws', () => {
    expect(formatMoney('10.00', '', 'en-US')).toBe('10.00');
    expect(formatMoney('10.00', 'XXQ', 'en-US')).toBe('10.00');
  });
  it('null / undefined / non-numeric render as the N/A sentinel', () => {
    expect(formatMoney(null, 'USD')).toBe('N/A');
    expect(formatMoney('not a number', 'USD')).toBe('N/A');
  });
});

describe('formatPercent', () => {
  it('renders a 0..1 ratio as a percentage with one digit by default', () => {
    expect(formatPercent(0.9376, undefined, 'en-US')).toBe('93.8%');
  });
  it('0 is a measured zero and 1 is a measured one', () => {
    expect(formatPercent(0, 0, 'en-US')).toBe('0%');
    expect(formatPercent(1, 0, 'en-US')).toBe('100%');
  });
  it('null is N/A, NOT 0% — an unmeasured attainment is not a failed one', () => {
    expect(formatPercent(null)).toBe('N/A');
  });
});

describe('formatMinutes', () => {
  it('renders hours and minutes', () => {
    expect(formatMinutes(0)).toBe('0h 00m');
    expect(formatMinutes(90)).toBe('1h 30m');
    expect(formatMinutes(2475)).toBe('41h 15m');
  });
  it('null is N/A', () => { expect(formatMinutes(null)).toBe('N/A'); });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd packages/shared && npx vitest run src/reportPdf/moneyFormat.test.ts`
Expected: FAIL — `Failed to resolve import "./moneyFormat"`.

- [ ] **Step 3: Write `moneyFormat.ts`**

```ts
// packages/shared/src/reportPdf/moneyFormat.ts
/**
 * The only currency/percent/minute formatting in the PDF layer (#3198 spec
 * §3.4). `formatGenericCell` in reportPdf.ts is untouched — it still stringifies
 * raw numerics for the generic table path.
 *
 * NO jsPDF import: W03's `reportExport.ts` uses `formatMoney` for XLSX display
 * cells, and the web bundle must not pull jsPDF in for a number.
 *
 * MONEY IS A STRING. PG numeric arrives as a string and every caller passes it
 * through untouched. `Number()` happens exactly once, here, at the formatting
 * boundary — never in an aggregate.
 */
const NA = 'N/A';

export function formatMoney(
  value: string | number | null | undefined,
  currencyCode: string,
  locale = 'en-US',
): string {
  if (value === null || value === undefined) return NA;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return NA;
  const code = (currencyCode ?? '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) return String(value);
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency: code }).format(n);
  } catch {
    // Intl throws RangeError on a well-formed-but-unknown code in some ICU
    // builds. A bare number is wrong-looking; a crashed PDF is worse.
    return String(value);
  }
}

/** `ratio` is 0..1. NULL means NOT MEASURED and renders N/A — never 0%. */
export function formatPercent(
  ratio: number | null | undefined, digits = 1, locale = 'en-US',
): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return NA;
  return new Intl.NumberFormat(locale, {
    style: 'percent', minimumFractionDigits: digits, maximumFractionDigits: digits,
  }).format(ratio);
}

export function formatMinutes(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return NA;
  const total = Math.round(minutes);
  const sign = total < 0 ? '-' : '';
  const abs = Math.abs(total);
  return `${sign}${Math.floor(abs / 60)}h ${String(abs % 60).padStart(2, '0')}m`;
}
```

- [ ] **Step 4: Write `packages/shared/src/types/businessReports.ts`** with the types listed under **Interfaces produced** above and the three `empty*Summary` factories. Add `export * from './businessReports';` to `packages/shared/src/types/index.ts`, and to `packages/shared/src/reportPdf/index.ts`:

```ts
export { formatMinutes, formatMoney, formatPercent } from './moneyFormat';
```

- [ ] **Step 5: Write the summary-type test**

```ts
// packages/shared/src/types/businessReports.test.ts
import { describe, expect, it } from 'vitest';
import { emptyArAgingSummary, emptyTechnicianTimeSummary, emptyTicketSlaSummary } from './businessReports';

const NOTE = 'nothing was queried';

describe('empty business summaries', () => {
  it('carry the note and NEVER report an unmeasured ratio as zero', () => {
    const sla = emptyTicketSlaSummary(NOTE);
    expect(sla.notes).toContain(NOTE);
    expect(sla.overall.responseAttainment).toBeNull();
    expect(sla.overall.resolutionAttainment).toBeNull();
    expect(sla.groups).toEqual([]);

    const time = emptyTechnicianTimeSummary(NOTE);
    expect(time.overall.utilization).toBeNull();
    expect(time.overall.billingConversion).toBeNull();
    expect(time.overall.billableValue).toEqual([]);

    const ar = emptyArAgingSummary(NOTE);
    expect(ar.byCurrency).toEqual([]);
    expect(ar.otherOpenBalance).toEqual([]);
  });

  it('report an untruncated, zero-row detail block', () => {
    for (const s of [emptyTicketSlaSummary(NOTE), emptyTechnicianTimeSummary(NOTE), emptyArAgingSummary(NOTE)]) {
      expect(s.detail).toMatchObject({ cap: 5000, stored: 0, available: 0, truncated: false });
      expect(s.rows).toEqual([]);
    }
  });
});
```

- [ ] **Step 6: Run and commit**

```bash
cd packages/shared && npx vitest run src/reportPdf/moneyFormat.test.ts src/types/businessReports.test.ts src/browserSafeBarrel.test.ts
cd .. && pnpm --filter @breeze/shared typecheck
git add packages/shared/src/types/businessReports.ts packages/shared/src/types/businessReports.test.ts \
  packages/shared/src/types/index.ts packages/shared/src/reportPdf/moneyFormat.ts \
  packages/shared/src/reportPdf/moneyFormat.test.ts packages/shared/src/reportPdf/index.ts
git commit -m "feat(shared): business report summary types + Intl money/percent/minutes formatting (#3198 W02)"
```

Then return to **Task 3 Step 6** and replace the stubbed `zeroSafeReport` arms with the real `empty*Summary(SITE_RESTRICTED_NOTE)` calls; `cd apps/api && npx vitest run src/services/reportGenerationService.test.ts` must stay green.

---

### Task 6: `businessReports/period.ts` — timezone-aware period resolution

All three reports evaluate their window in the **report owner's** resolved timezone (org → partner → UTC), not the server's (§3.3 R1 and R3). `resolveOrgTimezone` (`apps/api/src/services/portal/timezone.ts:41`) covers the org axis; the partner axis needs its own two-line lookup over the same `resolveTimezoneFromRows` helper.

**Files:** Create `apps/api/src/services/businessReports/period.ts` + `period.test.ts`.

**Interfaces produced:**
```ts
export type ReportPeriodKind = 'last_full_month' | 'last_30_days' | 'last_quarter' | 'custom';
export type ReportPeriodInput = { kind: ReportPeriodKind; start?: string; end?: string };
export type ResolvedReportPeriod = { start: Date; end: Date; label: string; timeZone: string; kind: ReportPeriodKind };
/** [start, end) — end is EXCLUSIVE everywhere. */
export function resolveReportPeriod(input: ReportPeriodInput | undefined, timeZone: string, now: Date): ResolvedReportPeriod;
export function workingDaysBetween(start: Date, end: Date, timeZone: string): number;
export async function resolveReportOwnerTimezone(owner: ReportOwner): Promise<string>;
export const periodSchema: z.ZodType<ReportPeriodInput>;   // re-exported by the three config schemas
```

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/businessReports/period.test.ts
import { describe, expect, it } from 'vitest';
import { resolveReportPeriod, workingDaysBetween } from './period';

const NOW = new Date('2026-09-21T13:45:00.000Z');   // a Monday

describe('resolveReportPeriod', () => {
  it('last_full_month is the previous calendar month in the given zone, end-exclusive', () => {
    const p = resolveReportPeriod({ kind: 'last_full_month' }, 'America/Chicago', NOW);
    expect(p.start.toISOString()).toBe('2026-08-01T05:00:00.000Z'); // Aug 1 00:00 CDT
    expect(p.end.toISOString()).toBe('2026-09-01T05:00:00.000Z');   // Sep 1 00:00 CDT
    expect(p.label).toBe('August 2026');
  });

  it('the SAME instant in a different zone gives a different window', () => {
    const p = resolveReportPeriod({ kind: 'last_full_month' }, 'Australia/Sydney', NOW);
    expect(p.start.toISOString()).toBe('2026-07-31T14:00:00.000Z'); // Aug 1 00:00 AEST
  });

  it('last_30_days ends at the start of today in the zone and spans 30 days', () => {
    const p = resolveReportPeriod({ kind: 'last_30_days' }, 'UTC', NOW);
    expect(p.end.toISOString()).toBe('2026-09-21T00:00:00.000Z');
    expect(p.start.toISOString()).toBe('2026-08-22T00:00:00.000Z');
    expect(p.label).toBe('Last 30 days');
  });

  it('last_quarter is the previous CALENDAR quarter', () => {
    const p = resolveReportPeriod({ kind: 'last_quarter' }, 'UTC', NOW);
    expect(p.start.toISOString()).toBe('2026-04-01T00:00:00.000Z');
    expect(p.end.toISOString()).toBe('2026-07-01T00:00:00.000Z');
    expect(p.label).toBe('Q2 2026');
  });

  it('custom takes the given dates in the zone, end-exclusive at the NEXT midnight', () => {
    const p = resolveReportPeriod({ kind: 'custom', start: '2026-03-01', end: '2026-03-15' }, 'UTC', NOW);
    expect(p.start.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    expect(p.end.toISOString()).toBe('2026-03-16T00:00:00.000Z');
    expect(p.label).toBe('2026-03-01 to 2026-03-15');
  });

  it('custom with a missing or inverted range falls back to last_full_month rather than querying everything', () => {
    expect(resolveReportPeriod({ kind: 'custom' }, 'UTC', NOW).kind).toBe('last_full_month');
    expect(resolveReportPeriod({ kind: 'custom', start: '2026-03-15', end: '2026-03-01' }, 'UTC', NOW).kind)
      .toBe('last_full_month');
  });

  it('an absent config period defaults to last_full_month (spec §3.3 R1)', () => {
    expect(resolveReportPeriod(undefined, 'UTC', NOW).kind).toBe('last_full_month');
  });

  it('an unknown timezone degrades to UTC instead of throwing mid-generation', () => {
    expect(resolveReportPeriod({ kind: 'last_30_days' }, 'Mars/Olympus', NOW).timeZone).toBe('UTC');
  });
});

describe('workingDaysBetween', () => {
  it('counts Mon-Fri in the zone over a half-open range', () => {
    // 2026-08-01 .. 2026-09-01 exclusive: August 2026 has 21 weekdays.
    expect(workingDaysBetween(new Date('2026-08-01T00:00:00Z'), new Date('2026-09-01T00:00:00Z'), 'UTC')).toBe(21);
  });
  it('a single weekend day is zero', () => {
    expect(workingDaysBetween(new Date('2026-09-19T00:00:00Z'), new Date('2026-09-21T00:00:00Z'), 'UTC')).toBe(0);
  });
  it('never returns a negative count', () => {
    expect(workingDaysBetween(new Date('2026-09-21T00:00:00Z'), new Date('2026-09-01T00:00:00Z'), 'UTC')).toBe(0);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/services/businessReports/period.test.ts`
Expected: FAIL — `Failed to resolve import "./period"`.

- [ ] **Step 3: Implement**

Implementation notes that decide whether the test passes:

- Convert between wall-clock and instants with `Intl.DateTimeFormat(timeZone, { timeZoneName: 'longOffset' })` (or a `formatToParts`-based `zonedMidnightUtc(y, m, d, tz)` helper) — **not** by adding a fixed offset, which breaks across a DST boundary. Write `zonedMidnightUtc` once and build every boundary from it.
- Validate the zone with a `try { new Intl.DateTimeFormat('en-US', { timeZone }) } catch { return 'UTC' }` guard at the top; `canonicalizeTimezone` from `@breeze/shared` is the existing helper and is preferred if it already returns null for an unknown zone.
- `label`: `last_full_month` → `"<Month> <Year>"`; `last_quarter` → `"Q<n> <Year>"`; `last_30_days` → `"Last 30 days"`; `custom` → `"<start> to <end>"` (the inclusive dates the user typed).
- `workingDaysBetween` iterates days from `start` to `end` exclusive, formatting each day's weekday **in the zone** (`Intl.DateTimeFormat(tz, { weekday: 'short' })`), counting Mon–Fri. Public holidays are not modelled — that is part of the "explicitly approximate" framing spec §3.3 R2 mandates and is printed on the artifact.

```ts
// apps/api/src/services/businessReports/period.ts — the owner timezone half
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { partners } from '../../db/schema';
import { resolveOrgTimezone, resolveTimezoneFromRows } from '../portal/timezone';
import type { ReportOwner } from '../siteScope';

export const periodSchema = z.object({
  kind: z.enum(['last_full_month', 'last_30_days', 'last_quarter', 'custom']),
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

/** org -> partner -> UTC for an org owner; partner -> UTC for a partner owner.
 *  Same chain and same helper as the schedule worker's `timezoneFor`. */
export async function resolveReportOwnerTimezone(owner: ReportOwner): Promise<string> {
  if (owner.orgId !== undefined) return resolveOrgTimezone(owner.orgId);
  const rows = await runOutsideDbContext(() =>
    withSystemDbAccessContext(() =>
      db.select({ timezone: partners.timezone, settings: partners.settings })
        .from(partners).where(eq(partners.id, owner.partnerId)).limit(1)));
  return resolveTimezoneFromRows(null, rows[0]?.timezone ?? null, rows[0]?.settings);
}
```

`resolveOrgTimezone` "deliberately does not open a system context itself" (`timezone.ts:37-40`), and for the org path the caller is already inside the request context — correct. The partner path has no such context on the worker, hence the explicit wrapper.

- [ ] **Step 4: Run to green, then commit**

```bash
cd apps/api && npx vitest run src/services/businessReports/period.test.ts
git add apps/api/src/services/businessReports/period.ts apps/api/src/services/businessReports/period.test.ts
git commit -m "feat(reports): timezone-aware report period resolution for business reports (#3198 W02)"
```

---

### Task 7: R1 — `ticket_sla_attainment`

Spec §3.3 R1. Attainment is **recomputed from timestamps + targets** (Open Decision 2 = A), because the sweep only stamps breaches on tickets still open/unanswered at sweep time (`apps/api/src/jobs/ticketSlaWorker.ts:70-99` — `WHERE status IN ('new','open') AND first_response_at IS NULL …`), so a late-but-eventually-answered ticket never gets a `sla_breached_at`. The stamped columns annotate, and the disagreement between the two is published as a count.

**Files:** Create `apps/api/src/services/businessReports/ticketSlaReport.ts` + `ticketSlaReport.test.ts`; modify `apps/api/src/services/reportRegistry.ts` (replace the placeholder entry).

**Interfaces produced:**
```ts
export const ticketSlaConfigSchema: z.ZodType<TicketSlaConfig>;   // loose
export type TicketSlaConfig = {
  period?: ReportPeriodInput;
  groupBy?: 'organization' | 'priority' | 'technician' | 'category';
  includeNoSla?: boolean;
};
export async function generateTicketSlaAttainmentReport(
  scope: ReportScope, config: TicketSlaConfig, authority: ReportGenerationAuthority,
): Promise<ReportResult>;
```

Config defaults (brief contract): `groupBy` defaults to `'organization'` at partner scope and `'priority'` at org scope — so the schema leaves it **optional with no `.default()`** and the generator applies the scope-dependent default. `includeNoSla` defaults `true`.

#### The SQL

Three statements, all bound-parameterised, all carrying the org predicate. `${scopePredicate}` is `sql\`t.org_id = ANY(${orgIds})\`` at partner scope and `sql\`t.org_id = ${orgId}\`` at org scope — **built once, interpolated into all three**, so a reviewer checks one place.

```sql
-- Shared CTE, repeated in each statement (PG has no cross-statement CTEs).
WITH scoped AS (
  SELECT
    t.id, t.org_id, t.priority, t.category, t.assigned_to, t.subject,
    t.ticket_number, t.internal_number, t.created_at,
    t.first_response_at, t.resolved_at,
    t.response_sla_minutes, t.resolution_sla_minutes,
    COALESCE(t.sla_paused_minutes, 0) AS paused,
    t.sla_breached_at, t.sla_breach_reason
  FROM tickets t
  WHERE t.deleted_at IS NULL
    -- #5573 §4.8: the sweep excludes planned work, so the recompute must too,
    -- or this report counts breaches the product never tracked.
    AND t.work_kind = 'support'
    AND t.created_at >= $start AND t.created_at < $end
    AND <scopePredicate>
),
outcomes AS (
  SELECT s.*,
    -- Deadline mirrors ticketSlaWorker.ts:83-84 exactly:
    --   created_at + (target + paused) * interval '1 minute'
    CASE
      WHEN s.response_sla_minutes IS NULL THEN 'no_target'
      WHEN s.first_response_at IS NOT NULL
       AND s.first_response_at <= s.created_at + (s.response_sla_minutes + s.paused) * interval '1 minute'
        THEN 'met'
      WHEN s.first_response_at IS NOT NULL THEN 'missed'
      WHEN now() > s.created_at + (s.response_sla_minutes + s.paused) * interval '1 minute' THEN 'missed'
      ELSE 'pending'
    END AS response_outcome,
    CASE
      WHEN s.resolution_sla_minutes IS NULL THEN 'no_target'
      WHEN s.resolved_at IS NOT NULL
       AND s.resolved_at <= s.created_at + (s.resolution_sla_minutes + s.paused) * interval '1 minute'
        THEN 'met'
      WHEN s.resolved_at IS NOT NULL THEN 'missed'
      WHEN now() > s.created_at + (s.resolution_sla_minutes + s.paused) * interval '1 minute' THEN 'missed'
      ELSE 'pending'
    END AS resolution_outcome
  FROM scoped s
)
```

**Statement 1 — grouped aggregate** (`<groupExpr>` / `<groupLabelExpr>` from the table below):

```sql
SELECT
  <groupExpr>::text AS group_key, <groupLabelExpr> AS group_label,
  COUNT(*)::int AS tickets_total,
  COUNT(*) FILTER (WHERE o.response_outcome = 'no_target'
                     AND o.resolution_outcome = 'no_target')::int AS no_sla_tickets,
  COUNT(*) FILTER (WHERE o.response_outcome IN ('met','missed'))::int AS response_eligible,
  COUNT(*) FILTER (WHERE o.response_outcome = 'met')::int          AS response_met,
  COUNT(*) FILTER (WHERE o.resolution_outcome IN ('met','missed'))::int AS resolution_eligible,
  COUNT(*) FILTER (WHERE o.resolution_outcome = 'met')::int        AS resolution_met,
  COUNT(*) FILTER (WHERE o.response_outcome = 'missed'
                      OR o.resolution_outcome = 'missed')::int     AS breaches
FROM outcomes o
LEFT JOIN organizations org ON org.id = o.org_id
LEFT JOIN users u ON u.id = o.assigned_to
GROUP BY 1, 2
ORDER BY 1
```

| `groupBy` | `<groupExpr>` | `<groupLabelExpr>` |
|---|---|---|
| `organization` | `o.org_id` | `COALESCE(org.name, 'Unknown organization')` |
| `priority` | `o.priority` | `o.priority::text` |
| `technician` | `COALESCE(o.assigned_to::text, 'unassigned')` | `COALESCE(u.name, 'Unassigned')` |
| `category` | `COALESCE(o.category, 'uncategorised')` | `COALESCE(o.category, 'Uncategorised')` |

**Denominator rule (spec §3.3 R1):** `no_target` is excluded from `*_eligible` and counted separately as `no_sla_tickets`; `pending` is excluded too (a target that has not come due yet is not an outcome). Attainment is `met / eligible`, or **`null` when `eligible = 0`** — never `0`, never `1`.

**`assigned_to` is the CURRENT assignee**, not the assignee at response time (reassignment history is not tracked). Every technician group row's label carries the suffix ` (current assignee)` — added in TS, not SQL, so the group key stays a clean uuid.

**Statement 2 — the overall block and the stamp discrepancy**, the same `outcomes` CTE with no `GROUP BY`, plus:

```sql
  COUNT(*) FILTER (WHERE (o.response_outcome = 'missed' OR o.resolution_outcome = 'missed')
                     AND o.sla_breached_at IS NULL)::int AS recomputed_breach_not_stamped,
  COUNT(*) FILTER (WHERE o.sla_breached_at IS NOT NULL
                     AND o.response_outcome <> 'missed'
                     AND o.resolution_outcome <> 'missed')::int AS stamped_not_recomputed_breach
```

**Statement 3 — detail rows**, `SELECT … FROM outcomes o LEFT JOIN organizations … LEFT JOIN users … ORDER BY o.created_at DESC LIMIT ${cap + 1}`. Fetching `cap + 1` is how `truncated` is known without a second `COUNT`; store the first `cap` and set `available` from statement 2's `tickets_total`.

**`includeNoSla` is a DETAIL-ROW filter only.** When false it adds `WHERE NOT (o.response_outcome = 'no_target' AND o.resolution_outcome = 'no_target')` to statement 3 and to nothing else. The `no_sla_tickets` count stays in every group row either way — it is the honest denominator disclosure, and a display toggle must never move an aggregate.

#### Footer notes (printed on the artifact, spec §3.3 R1)

```ts
const NOTES = [
  'Attainment is recomputed from ticket timestamps and the SLA targets stored on each ticket, not from the sla_breached_at stamp: the SLA sweep only marks tickets that are still open and unanswered when it runs, so a late-but-eventually-answered ticket is never stamped.',
  'sla_paused_minutes is a lifetime total, so pause time that occurred after first response slightly flatters response attainment.',
  'Tickets with no SLA target are excluded from the attainment denominators and counted separately.',
  'Planned work (work_kind other than support) carries a due date, not an SLA, and is excluded.',
  'The technician axis uses the ticket\'s CURRENT assignee; reassignment history is not tracked.',
];
```

- [ ] **Step 1: Write the failing unit test**

Mock style: `apps/api/src/services/identityAccessReport.test.ts:1-54`, adapted for `db.execute` (these generators use raw `sql` templates, not the select builder).

```ts
// apps/api/src/services/businessReports/ticketSlaReport.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../db', () => ({
  db: { execute: vi.fn() },
  runOutsideDbContext: <T,>(fn: () => T): T => fn(),
  withSystemDbAccessContext: <T,>(fn: () => Promise<T>): Promise<T> => fn(),
}));
vi.mock('../portal/timezone', () => ({
  resolveOrgTimezone: vi.fn(async () => 'UTC'),
  resolveTimezoneFromRows: vi.fn(() => 'UTC'),
}));

import type { TicketSlaSummary } from '@breeze/shared';
import { db } from '../../db';
import { generateTicketSlaAttainmentReport } from './ticketSlaReport';
import type { ReportGenerationAuthority } from '../siteScope';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const PARTNER = '44444444-4444-4444-8444-444444444444';
const USER = '33333333-3333-4333-8333-333333333333';

/** Resolve db.execute calls in order AND capture the bound parameters of each
 *  statement, so assertions can walk the params instead of token-scanning the
 *  WHERE clause (the vacuous-assertion trap, spec §10). */
const calls: Array<{ sql: string; params: unknown[] }> = [];
function queueExecute(...resultSets: unknown[][]) {
  const queue = [...resultSets];
  vi.mocked(db.execute).mockImplementation((async (q: unknown) => {
    const built = q as { queryChunks?: unknown[]; toString?: () => string };
    calls.push({ sql: String(built), params: (q as { params?: unknown[] }).params ?? [] });
    return queue.shift() ?? [];
  }) as never);
}

const partnerAuthority: ReportGenerationAuthority = {
  principalKind: 'user', principalUserId: USER,
  scope: { version: 1, kind: 'partner_wide', partnerId: PARTNER },
  capturedAt: new Date('2026-09-21T00:00:00Z'), fingerprint: 'a'.repeat(64),
};
const orgAuthority: ReportGenerationAuthority = {
  principalKind: 'user', principalUserId: USER,
  scope: { version: 1, kind: 'unrestricted', orgId: ORG_A },
  capturedAt: new Date('2026-09-21T00:00:00Z'), fingerprint: 'f'.repeat(64),
};

const GROUP_ROWS = [
  { group_key: ORG_A, group_label: 'Acme', tickets_total: 12, no_sla_tickets: 2,
    response_eligible: 10, response_met: 9, resolution_eligible: 8, resolution_met: 6, breaches: 3 },
  { group_key: ORG_B, group_label: 'Globex', tickets_total: 4, no_sla_tickets: 4,
    response_eligible: 0, response_met: 0, resolution_eligible: 0, resolution_met: 0, breaches: 0 },
];
const OVERALL = [{ tickets_total: 16, no_sla_tickets: 6, response_eligible: 10, response_met: 9,
  resolution_eligible: 8, resolution_met: 6, breaches: 3,
  recomputed_breach_not_stamped: 2, stamped_not_recomputed_breach: 1 }];

const summaryOf = (r: { summary?: unknown }) => r.summary as TicketSlaSummary;

describe('generateTicketSlaAttainmentReport', () => {
  beforeEach(() => { vi.clearAllMocks(); calls.length = 0; });

  it('computes attainment as met/eligible and leaves a zero-denominator group NULL', async () => {
    queueExecute(GROUP_ROWS, OVERALL, []);
    const s = summaryOf(await generateTicketSlaAttainmentReport(
      { kind: 'partner', partnerId: PARTNER, orgIds: [ORG_A, ORG_B] },
      { period: { kind: 'last_full_month' } }, partnerAuthority));
    expect(s.groups[0]!.responseAttainment).toBeCloseTo(0.9, 6);
    expect(s.groups[0]!.resolutionAttainment).toBeCloseTo(0.75, 6);
    // Globex had only no-SLA tickets: NOT MEASURED, not 0% and not 100%.
    expect(s.groups[1]!.responseAttainment).toBeNull();
    expect(s.groups[1]!.resolutionAttainment).toBeNull();
    expect(s.overall.responseAttainment).toBeCloseTo(0.9, 6);
  });

  it('publishes the recomputed-vs-stamped discrepancy rather than hiding it', async () => {
    queueExecute(GROUP_ROWS, OVERALL, []);
    const s = summaryOf(await generateTicketSlaAttainmentReport(
      { kind: 'partner', partnerId: PARTNER, orgIds: [ORG_A] }, {}, partnerAuthority));
    expect(s.stampDiscrepancy).toEqual({ recomputedBreachNotStamped: 2, stampedNotRecomputedBreach: 1 });
  });

  it('names the worst group by response attainment among MEASURED groups only', async () => {
    queueExecute(GROUP_ROWS, OVERALL, []);
    const s = summaryOf(await generateTicketSlaAttainmentReport(
      { kind: 'partner', partnerId: PARTNER, orgIds: [ORG_A, ORG_B] }, {}, partnerAuthority));
    expect(s.worstGroupLabel).toBe('Acme');   // Globex is unmeasured, not worst
  });

  it('binds the org allowlist as a parameter at partner scope', async () => {
    queueExecute([], [{ ...OVERALL[0], tickets_total: 0 }], []);
    await generateTicketSlaAttainmentReport(
      { kind: 'partner', partnerId: PARTNER, orgIds: [ORG_A, ORG_B] }, {}, partnerAuthority);
    for (const call of calls) {
      expect(call.params).toEqual(expect.arrayContaining([expect.arrayContaining([ORG_A, ORG_B])]));
    }
  });

  it('binds a single org id at org scope and never the partner id', async () => {
    queueExecute([], [{ ...OVERALL[0], tickets_total: 0 }], []);
    await generateTicketSlaAttainmentReport({ kind: 'organization', orgId: ORG_A }, {}, orgAuthority);
    for (const call of calls) {
      expect(call.params).toEqual(expect.arrayContaining([ORG_A]));
      expect(call.params).not.toEqual(expect.arrayContaining([PARTNER]));
    }
  });

  it('defaults groupBy to organization at partner scope and priority at org scope', async () => {
    queueExecute([], [{ ...OVERALL[0], tickets_total: 0 }], []);
    expect(summaryOf(await generateTicketSlaAttainmentReport(
      { kind: 'partner', partnerId: PARTNER, orgIds: [ORG_A] }, {}, partnerAuthority)).groupBy)
      .toBe('organization');
    queueExecute([], [{ ...OVERALL[0], tickets_total: 0 }], []);
    expect(summaryOf(await generateTicketSlaAttainmentReport(
      { kind: 'organization', orgId: ORG_A }, {}, orgAuthority)).groupBy).toBe('priority');
  });

  it('caps detail rows at 5000 and reports the truncation with the FULL available count', async () => {
    const detail = Array.from({ length: 5001 }, (_, i) => ({
      id: `t${i}`, ticket_number: `T-${i}`, internal_number: null, org_id: ORG_A, org_name: 'Acme',
      subject: 's', priority: 'high', category: null, assigned_to_name: null,
      created_at: new Date('2026-08-02T00:00:00Z'), first_response_at: null, resolved_at: null,
      response_sla_minutes: 60, resolution_sla_minutes: 240, paused: 0,
      response_outcome: 'missed', resolution_outcome: 'missed',
      sla_breached_at: null, sla_breach_reason: null,
    }));
    queueExecute(GROUP_ROWS, [{ ...OVERALL[0], tickets_total: 9000 }], detail);
    const result = await generateTicketSlaAttainmentReport(
      { kind: 'partner', partnerId: PARTNER, orgIds: [ORG_A] }, {}, partnerAuthority);
    const s = summaryOf(result);
    expect(result.rows).toHaveLength(5000);
    expect(s.detail).toEqual({ cap: 5000, stored: 5000, available: 9000, truncated: true });
    // The AGGREGATE is over all 9000, not the stored 5000 (§3.2).
    expect(s.overall.ticketsTotal).toBe(9000);
  });

  it('prints the approximation notes the spec requires', async () => {
    queueExecute([], [{ ...OVERALL[0], tickets_total: 0 }], []);
    const s = summaryOf(await generateTicketSlaAttainmentReport(
      { kind: 'organization', orgId: ORG_A }, {}, orgAuthority));
    expect(s.notes.join(' ')).toMatch(/sla_paused_minutes is a lifetime total/);
    expect(s.notes.join(' ')).toMatch(/recomputed from ticket timestamps/);
    expect(s.notes.join(' ')).toMatch(/current assignee/i);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/services/businessReports/ticketSlaReport.test.ts`
Expected: FAIL — `Failed to resolve import "./ticketSlaReport"`.

- [ ] **Step 3: Implement the generator**

Skeleton (the SQL above goes inside `groupedQuery` / `overallQuery` / `detailQuery`):

```ts
// apps/api/src/services/businessReports/ticketSlaReport.ts
import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { TicketSlaSummary, TicketSlaGroupRow, TicketSlaDetailRow } from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import type { ReportResult } from '../reportGenerationService';
import type { ReportScope } from '../reportScope';
import { reportOwnerOfScope } from '../reportScope';
import type { ReportGenerationAuthority } from '../siteScope';
import { periodSchema, resolveReportOwnerTimezone, resolveReportPeriod } from './period';

export const DETAIL_ROW_CAP = 5000;

export const ticketSlaConfigSchema = z.looseObject({
  period: periodSchema.optional(),
  // No .default(): the default depends on the scope and is applied in the
  // generator (organization at partner scope, priority at org scope).
  groupBy: z.enum(['organization', 'priority', 'technician', 'category']).optional(),
  includeNoSla: z.boolean().optional().default(true),
});
export type TicketSlaConfig = z.infer<typeof ticketSlaConfigSchema>;

/** The ONE place the tenancy predicate is built. Every statement interpolates
 *  this; a query that builds its own is a review rejection (see READ THIS
 *  FIRST §2 — partner scope runs with RLS switched off). */
function scopePredicate(scope: ReportScope): SQL {
  return scope.kind === 'partner'
    ? sql`t.org_id = ANY(${scope.orgIds}::uuid[])`
    : sql`t.org_id = ${scope.orgId}`;
}

/** Partner scope needs a system context (tickets are org-axis and a
 *  partner_wide authority has no org context); org scope must NOT open one —
 *  it runs under the caller's RLS, with the org predicate for defence in depth. */
async function runScoped<T>(scope: ReportScope, fn: () => Promise<T>): Promise<T> {
  return scope.kind === 'partner'
    ? runOutsideDbContext(() => withSystemDbAccessContext(fn))
    : fn();
}

export async function generateTicketSlaAttainmentReport(
  scope: ReportScope,
  config: TicketSlaConfig,
  _authority: ReportGenerationAuthority,
): Promise<ReportResult> {
  const timeZone = await resolveReportOwnerTimezone(reportOwnerOfScope(scope));
  const period = resolveReportPeriod(config.period, timeZone, new Date());
  const groupBy = config.groupBy ?? (scope.kind === 'partner' ? 'organization' : 'priority');
  // … three db.execute calls inside ONE runScoped(), then assemble the summary.
}
```

**Both aggregate statements and the detail statement go inside a single `runScoped`** — three separate system-context blocks would take three pooled connections for one report.

`ratio(met, eligible)` is a local helper returning `eligible > 0 ? met / eligible : null`. Use it everywhere; never inline `met/eligible`, which yields `NaN` and serialises to `null` in JSON anyway — silently, and only sometimes.

- [ ] **Step 4: Register the type**

Replace the placeholder in `reportRegistry.ts`:

```ts
  ticket_sla_attainment: {
    type: 'ticket_sla_attainment', label: 'Ticket SLA attainment',
    configSchema: ticketSlaConfigSchema,
    supportedScopes: ['organization', 'partner'] as const,
    execution: 'user',
    requiredPermissions: [PERMISSIONS.TICKETS_READ],
    detailRowCap: 5000,
    generate: async (scope, config, authority) => {
      const { generateTicketSlaAttainmentReport } = await import('./businessReports/ticketSlaReport');
      return generateTicketSlaAttainmentReport(scope, config as never, authority);
    },
  },
```

`PERMISSIONS.TICKETS_READ` is `{ resource: 'tickets', action: 'read' }` (`packages/shared/src/constants/permissions.ts:60`).

- [ ] **Step 5: Run the unit suite green**

Run: `cd apps/api && npx vitest run src/services/businessReports/ticketSlaReport.test.ts src/services/reportRegistry.test.ts`
Expected: PASS.

- [ ] **Step 6: Write the integration case — partner fan-out across two orgs, and org isolation**

Add to `apps/api/src/__tests__/integration/businessReportsPartnerScope.integration.test.ts` (created here, extended by Tasks 8 and 9):

```ts
import './setup';
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { createOrganization, createPartner, createUser } from './db-utils';
import { generateTicketSlaAttainmentReport } from '../../services/businessReports/ticketSlaReport';
import type { TicketSlaSummary } from '@breeze/shared';
import type { ReportGenerationAuthority } from '../../services/siteScope';

async function seedTicket(orgId: string, partnerId: string, o: {
  createdAt: string; firstResponseAt: string | null; responseSla: number | null;
  workKind?: string; deletedAt?: string | null;
}) {
  const id = randomUUID();
  await withSystemDbAccessContext(() => db.execute(sql`
    INSERT INTO tickets (id, org_id, partner_id, ticket_number, subject, status, priority,
      work_kind, created_at, first_response_at, response_sla_minutes, sla_paused_minutes, deleted_at)
    VALUES (${id}, ${orgId}, ${partnerId}, ${'T-' + id.slice(0, 8)}, 'seeded', 'open', 'high',
      ${o.workKind ?? 'support'}, ${o.createdAt}, ${o.firstResponseAt}, ${o.responseSla}, 0, ${o.deletedAt ?? null})`));
  return id;
}

describe('ticket_sla_attainment — partner scope', () => {
  it('aggregates across EVERY org of the partner, and excludes deleted and planned tickets', async () => {
    const partner = await createPartner({});
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    const other = await createPartner({});
    const orgC = await createOrganization({ partnerId: other.id });

    // In period (August 2026), one met per org, one missed in A.
    await seedTicket(orgA.id, partner.id, { createdAt: '2026-08-02T00:00:00Z', firstResponseAt: '2026-08-02T00:30:00Z', responseSla: 60 });
    await seedTicket(orgA.id, partner.id, { createdAt: '2026-08-03T00:00:00Z', firstResponseAt: '2026-08-03T05:00:00Z', responseSla: 60 });
    await seedTicket(orgB.id, partner.id, { createdAt: '2026-08-04T00:00:00Z', firstResponseAt: '2026-08-04T00:10:00Z', responseSla: 60 });
    // Must NOT be counted:
    await seedTicket(orgA.id, partner.id, { createdAt: '2026-08-05T00:00:00Z', firstResponseAt: '2026-08-05T09:00:00Z', responseSla: 60, workKind: 'planned' });
    await seedTicket(orgA.id, partner.id, { createdAt: '2026-08-06T00:00:00Z', firstResponseAt: '2026-08-06T09:00:00Z', responseSla: 60, deletedAt: '2026-08-07T00:00:00Z' });
    await seedTicket(orgC.id, other.id, { createdAt: '2026-08-08T00:00:00Z', firstResponseAt: '2026-08-08T09:00:00Z', responseSla: 60 });

    const user = await createUser({ partnerId: partner.id });
    const authority: ReportGenerationAuthority = {
      principalKind: 'user', principalUserId: user.id,
      scope: { version: 1, kind: 'partner_wide', partnerId: partner.id },
      capturedAt: new Date(), fingerprint: 'a'.repeat(64),
    };

    const result = await generateTicketSlaAttainmentReport(
      { kind: 'partner', partnerId: partner.id, orgIds: [orgA.id, orgB.id] },
      { period: { kind: 'custom', start: '2026-08-01', end: '2026-08-31' }, groupBy: 'organization' },
      authority,
    );
    const s = result.summary as TicketSlaSummary;
    expect(s.overall.ticketsTotal).toBe(3);          // not 4, not 5, not 6
    expect(s.overall.responseEligible).toBe(3);
    expect(s.overall.responseMet).toBe(2);
    expect(s.groups.map((g) => g.groupKey).sort()).toEqual([orgA.id, orgB.id].sort());
    // The other partner's org is absent from every group.
    expect(s.groups.some((g) => g.groupKey === orgC.id)).toBe(false);
  });

  it('org scope sees only its own org, under the caller\'s own RLS context', async () => {
    const partner = await createPartner({});
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    await seedTicket(orgA.id, partner.id, { createdAt: '2026-08-02T00:00:00Z', firstResponseAt: '2026-08-02T00:30:00Z', responseSla: 60 });
    await seedTicket(orgB.id, partner.id, { createdAt: '2026-08-03T00:00:00Z', firstResponseAt: '2026-08-03T00:30:00Z', responseSla: 60 });
    const user = await createUser({ partnerId: partner.id, orgId: orgA.id });

    const s = await withDbAccessContext(
      { scope: 'organization', orgId: orgA.id, accessibleOrgIds: [orgA.id], accessiblePartnerIds: [], userId: user.id },
      async () => (await generateTicketSlaAttainmentReport(
        { kind: 'organization', orgId: orgA.id },
        { period: { kind: 'custom', start: '2026-08-01', end: '2026-08-31' } },
        { principalKind: 'user', principalUserId: user.id,
          scope: { version: 1, kind: 'unrestricted', orgId: orgA.id },
          capturedAt: new Date(), fingerprint: 'f'.repeat(64) },
      )).summary as TicketSlaSummary);

    expect(s.overall.ticketsTotal).toBe(1);
  });
});
```

- [ ] **Step 7: Run the integration case**

```bash
pnpm test-stack up
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/businessReportsPartnerScope.integration.test.ts
```
Expected: PASS, 2 tests. Leave the stack up — Tasks 8 and 9 add to this file. (`pnpm test-stack down` when the wave is finished.)

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/services/businessReports/ticketSlaReport.ts \
  apps/api/src/services/businessReports/ticketSlaReport.test.ts \
  apps/api/src/services/reportRegistry.ts \
  apps/api/src/__tests__/integration/businessReportsPartnerScope.integration.test.ts
git commit -m "feat(reports): R1 ticket_sla_attainment, attainment recomputed from timestamps (#3198 W02)"
```

---

### Task 8: R2 — `technician_time_billability`

Spec §3.3 R2 as amended 2026-09-21. This is the report that motivates partner scope: `time_entries.partner_id` is `NOT NULL` and `org_id` is **nullable** (`apps/api/src/db/schema/timeTracking.ts:26, 40`), so an org-axis view structurally cannot see non-ticket work.

**Files:** Create `apps/api/src/services/businessReports/technicianTimeReport.ts` + `.test.ts`; modify `reportRegistry.ts`; extend the integration file.

**Interfaces produced:**
```ts
export const technicianTimeConfigSchema: z.ZodType<TechnicianTimeConfig>;   // loose
export type TechnicianTimeConfig = {
  period?: ReportPeriodInput;
  groupBy?: 'technician' | 'organization' | 'work_type';   // default 'technician'
  weeklyCapacityHours?: number;                            // 1..80, default 40
};
export async function generateTechnicianTimeBillabilityReport(
  scope: ReportScope, config: TechnicianTimeConfig, authority: ReportGenerationAuthority,
): Promise<ReportResult>;
```

#### The five semantics that make this report honest

| Figure | Column | Why not the other one |
|---|---|---|
| **Utilization** = logged ÷ capacity | `duration_minutes` | Time actually worked. `billable_minutes` is post-minimum/post-rounding and would inflate utilization with billing artefacts (§3.3 R2 "Minutes semantics"). |
| **Billable %** = billable ÷ logged | `duration_minutes`, split by `coverage` | Same reason. |
| **Billing conversion** = billed ÷ billable | `billable_minutes` | Reconciles to what invoices will carry (billing profiles W03). Deliberately **not** called "realization" — no fee-schedule baseline exists. |
| **Billability split** | `COALESCE(coverage, CASE WHEN is_billable THEN 'billable' ELSE 'non_billable' END)` | `coverage` is NULL on rows stamped before the #4628 W02 cut-over; `is_billable` is the documented fallback. This is what adds the **included-minutes** column #4628 §5 owes this report. |
| **Billable value** | `billable_minutes / 60 × hourly_rate`, `GROUP BY currency_code` | `time_entries.currency_code` exists and is CHECK-enforced whenever a rate is set, so per-currency aggregates are valid. **Never** summed across currencies (OD-4 = A). |

#### Zero-time technicians (the codex finding the spec adopted)

The left join starts from the partner's technicians, not from the entries, so a tech who logged nothing appears at 0% instead of vanishing and inflating the team average. "Technicians" = active users with a partner membership whose role grants `time_entries:read` — the same role-grant shape `roleGrantsReportAction` uses (`apps/api/src/services/siteScope.ts:865-895`), including the `'*'` wildcard rows that make Partner Admin work:

```sql
WITH techs AS (
  SELECT DISTINCT u.id AS user_id, u.name AS user_name
  FROM partner_users pu
  JOIN users u  ON u.id = pu.user_id AND u.status = 'active'
  JOIN roles r  ON r.id = pu.role_id
  JOIN role_permissions rp ON rp.role_id = pu.role_id
  JOIN permissions p ON p.id = rp.permission_id
  WHERE pu.partner_id = $partnerId
    AND r.scope = 'partner'
    AND (r.is_system OR r.partner_id = $partnerId)
    -- '*' rows must survive, or Partner Admin's wildcard grant is invisible.
    AND p.resource IN ('time_entries', '*')
    AND p.action   IN ('read', '*')
)
```

At **org scope** there is no partner axis to enumerate from, so `techs` is instead the distinct set of `user_id`s appearing in the org's own entries, and the summary's `notes` carries the label spec §3.3 R2 mandates: *"Organization-scoped: ticket-linked time only. Time entries with no organization are not included, and technicians who logged none of this organization's time do not appear."*

#### The entries CTE and the aggregate

```sql
entries AS (
  SELECT te.id, te.user_id, te.org_id, te.work_type_id, te.started_at,
         te.duration_minutes, te.billable_minutes, te.hourly_rate, te.currency_code,
         te.billing_status, te.is_approved,
         COALESCE(te.coverage, CASE WHEN te.is_billable THEN 'billable' ELSE 'non_billable' END) AS eff_coverage
  FROM time_entries te
  WHERE te.partner_id = $partnerId              -- partner axis, ALWAYS present
    AND (te.org_id IS NULL OR te.org_id = ANY($orgIds))   -- org allowlist; mirrors orgAxisSql
    AND te.ended_at IS NOT NULL                 -- a running timer has no duration yet
    AND te.started_at >= $start AND te.started_at < $end
)
```

Org scope replaces both tenancy lines with `te.org_id = $orgId` (which also drops the org-less entries — that is the documented limitation, not a bug).

```sql
SELECT <groupExpr>::text AS group_key, <groupLabelExpr> AS group_label,
  COALESCE(SUM(e.duration_minutes), 0)::int AS logged_minutes,
  COALESCE(SUM(e.duration_minutes) FILTER (WHERE e.eff_coverage = 'billable'), 0)::int    AS billable_minutes,
  COALESCE(SUM(e.duration_minutes) FILTER (WHERE e.eff_coverage = 'included'), 0)::int    AS included_minutes,
  COALESCE(SUM(e.duration_minutes) FILTER (WHERE e.eff_coverage = 'non_billable'), 0)::int AS non_billable_minutes,
  COALESCE(SUM(COALESCE(e.billable_minutes, e.duration_minutes))
           FILTER (WHERE e.eff_coverage = 'billable'), 0)::int                            AS billable_quantity_minutes,
  COALESCE(SUM(COALESCE(e.billable_minutes, e.duration_minutes))
           FILTER (WHERE e.eff_coverage = 'billable'
                     AND e.is_approved AND e.billing_status IN ('billed', 'contract')), 0)::int AS billed_minutes
FROM techs t LEFT JOIN entries e ON e.user_id = t.user_id
LEFT JOIN organizations org ON org.id = e.org_id
LEFT JOIN work_types wt ON wt.id = e.work_type_id
GROUP BY 1, 2 ORDER BY 1
```

| `groupBy` | `<groupExpr>` | `<groupLabelExpr>` |
|---|---|---|
| `technician` | `t.user_id` | `COALESCE(t.user_name, 'Unknown user')` |
| `organization` | `COALESCE(e.org_id::text, 'no_organization')` | `COALESCE(org.name, 'No organization')` |
| `work_type` | `COALESCE(e.work_type_id::text, 'unassigned')` | `COALESCE(wt.name, 'Unassigned')` |

**The `technician` group-by is the only one that keeps the `techs` LEFT JOIN shape** — grouping by org or work type over a left join produces one all-NULL row per zero-time tech. For those two axes the query starts `FROM entries e` and `zeroTimeTechnicians` is reported from a separate one-line `COUNT` over `techs` minus the techs present in `entries`. Getting this wrong is the difference between "No organization: 0h" and a phantom row per idle technician.

**Billing conversion denominator** is `billable_quantity_minutes` (billable rows' billed quantity), not `billable_minutes` (their actual duration) — both numerator and denominator are post-rounding, so the ratio reconciles to the invoice.

**Per-currency money**, its own statement so the group aggregate stays one row per group:

```sql
SELECT <groupExpr>::text AS group_key, e.currency_code,
  COALESCE(SUM(ROUND(ROUND(COALESCE(e.billable_minutes, e.duration_minutes)::numeric / 60, 2)
    * e.hourly_rate, <minorUnitScale>)), 0)::numeric(12,2) AS billable_value,
  ROUND(AVG(e.hourly_rate), 2)::numeric(12,2) AS average_rate
FROM entries e … WHERE e.eff_coverage = 'billable' AND e.hourly_rate IS NOT NULL
  AND e.currency_code IS NOT NULL
GROUP BY 1, 2 ORDER BY 1, 2
```

The rounding shape — hours to 2 dp first, then one `ROUND` per row at the currency's minor unit, then `SUM` — is copied verbatim from `getTicketBillingSummary` (`apps/api/src/services/timeEntryService.ts:1444`), so this report and the ticket billing panel cannot disagree. `<minorUnitScale>` is that file's `minorUnitScaleSql(timeEntries.currencyCode)` (`:435-439`); **export it** from `timeEntryService.ts` rather than copying the zero-decimal list, which is exactly the duplication the spec called out for `sqlOpenForOverdue`.

#### Capacity

```ts
const weeklyCapacityHours = config.weeklyCapacityHours ?? 40;
const workingDays = workingDaysBetween(period.start, period.end, timeZone);
const capacityMinutes = Math.round(workingDays * (weeklyCapacityHours / 5) * 60);
```

Capacity applies to the **technician** axis only. For `organization` and `work_type` group-bys `capacityMinutes` and `utilization` are `null` on every group row — a work type has no capacity, and printing one would be an invented denominator.

Mandatory notes: `"Utilization assumes a uniform ${weeklyCapacityHours}h week prorated over ${workingDays} working days; PTO, part-time schedules and public holidays are not modelled."`, `"Billing conversion is approved-and-billed minutes over billable minutes. It is not financial realization — no fee-schedule baseline exists to compute one."`, and the org-scope label above when applicable.

- [ ] **Step 1: Write the failing unit test** — same mock harness as Task 7 Step 1 (`db.execute` queue + captured params). Cases, each one assertion-tight:
  1. a tech with 2,400 logged minutes against a 21-working-day, 40h week (`21 × 8 × 60 = 10,080`) reports `utilization ≈ 0.2381`;
  2. **a zero-time technician appears with `loggedMinutes: 0` and `utilization: 0`** (a measured zero — they were in scope and logged nothing) while `billablePercent` and `billingConversion` are `null` (no denominator);
  3. `coverage` NULL + `is_billable = true` counts as billable, and NULL + `is_billable = false` counts as non-billable (the fallback);
  4. `included` minutes are their own column and are **not** in `billableMinutes`;
  5. billable value is one row per currency and `TechnicianTimeGroupRow.billableValue` never collapses two currencies into one entry;
  6. `groupBy: 'work_type'` produces `utilization: null` and `capacityMinutes: null` on every row, and a NULL `work_type_id` lands in the `unassigned` group;
  7. partner scope binds `partnerId` **and** the org array in every statement; org scope binds `orgId` and never `partnerId`;
  8. detail cap 5,000 with `available` from a full `COUNT`.

- [ ] **Step 2: Run it and watch it fail** — `cd apps/api && npx vitest run src/services/businessReports/technicianTimeReport.test.ts` → `Failed to resolve import "./technicianTimeReport"`.

- [ ] **Step 3: Implement**, reusing Task 7's `runScoped` shape (copy it into this file — two four-line helpers in two files beats a shared util nobody can find; the CLAUDE.md file-size guidance explicitly allows local duplication of small helpers).

- [ ] **Step 4: Register**

```ts
  technician_time_billability: {
    type: 'technician_time_billability', label: 'Technician time & billability',
    configSchema: technicianTimeConfigSchema,
    supportedScopes: ['organization', 'partner'] as const,
    execution: 'user',
    requiredPermissions: [PERMISSIONS.TIME_ENTRIES_READ, PERMISSIONS.TICKETS_READ],
    detailRowCap: 5000,
    generate: async (scope, config, authority) => {
      const { generateTechnicianTimeBillabilityReport } = await import('./businessReports/technicianTimeReport');
      return generateTechnicianTimeBillabilityReport(scope, config as never, authority);
    },
  },
```

Both permissions, matching the billables-export precedent that reads the same two tables (`apps/api/src/routes/tickets/export.ts:17-18`).

- [ ] **Step 5: Run green** — `cd apps/api && npx vitest run src/services/businessReports/technicianTimeReport.test.ts src/services/reportRegistry.test.ts`.

- [ ] **Step 6: Extend the integration file** with one `describe('technician_time_billability — partner scope')` proving the three things a mock cannot:
  1. an entry with `org_id IS NULL` **is** counted at partner scope (seed one; the partner total must include it) and is **absent** at org scope — this is the whole reason the wave exists;
  2. a technician of the partner with no entries in the period appears as a group row with `loggedMinutes: 0`;
  3. another partner's entries never appear, even though the generator ran with RLS off.

```ts
await withSystemDbAccessContext(() => db.execute(sql`
  INSERT INTO time_entries (partner_id, org_id, user_id, started_at, ended_at,
    duration_minutes, billable_minutes, is_billable, coverage, hourly_rate, currency_code,
    billing_status, is_approved)
  VALUES (${partner.id}, NULL, ${tech.id}, '2026-08-04T09:00:00Z', '2026-08-04T11:00:00Z',
    120, 120, true, 'billable', '150.00', 'USD', 'billed', true)`));
```

- [ ] **Step 7: Run the integration file** (stack already up) and **commit**

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/businessReportsPartnerScope.integration.test.ts
git add apps/api/src/services/businessReports/technicianTimeReport.ts \
  apps/api/src/services/businessReports/technicianTimeReport.test.ts \
  apps/api/src/services/timeEntryService.ts apps/api/src/services/reportRegistry.ts \
  apps/api/src/__tests__/integration/businessReportsPartnerScope.integration.test.ts
git commit -m "feat(reports): R2 technician_time_billability with zero-time techs and per-currency value (#3198 W02)"
```

---

### Task 9: R3 — `ar_aging`

Spec §3.3 R3. **Read "READ THIS FIRST" §1 before writing a line of this task** — the open-status predicate the spec names is not the AR-open set.

**Files:** Modify `apps/api/src/db/schema/invoices.ts` (export `sqlOpenForOverdue`, add `sqlOpenAr`); create `apps/api/src/services/businessReports/arAgingReport.ts` + `.test.ts` and `apps/api/src/db/schema/invoices.arPredicates.test.ts`; modify `reportRegistry.ts`; extend the integration file.

**Interfaces produced:**
```ts
// apps/api/src/db/schema/invoices.ts
export function sqlOpenForOverdue(t: { status: unknown }): SQL;   // was file-local
export function sqlOpenAr(t: { status: unknown }): SQL;
export const AR_OPEN_STATUSES: readonly InvoiceStatus[];          // ['sent','partially_paid','overdue']
// apps/api/src/services/businessReports/arAgingReport.ts
export const arAgingConfigSchema: z.ZodType<ArAgingConfig>;       // loose
export type ArAgingConfig = { asOf?: string; groupBy?: 'organization' | 'currency'; includePaidInPeriod?: boolean };
export async function generateArAgingReport(
  scope: ReportScope, config: ArAgingConfig, authority: ReportGenerationAuthority,
): Promise<ReportResult>;
```

- [ ] **Step 1: Write the failing predicate test**

```ts
// apps/api/src/db/schema/invoices.arPredicates.test.ts
import { describe, expect, it } from 'vitest';
import { INVOICE_STATUSES } from '@breeze/shared';
import { AR_OPEN_STATUSES } from './invoices';

describe('AR open statuses', () => {
  it('is exactly sent, partially_paid and overdue', () => {
    expect([...AR_OPEN_STATUSES]).toEqual(['sent', 'partially_paid', 'overdue']);
  });

  /** The reason this file exists. runOverdueSweep (invoiceService.ts:2276)
   *  FLIPS sent/partially_paid to 'overdue', so an AR aging report built on
   *  sqlOpenForOverdue's status list would omit almost every past-due invoice —
   *  the exact rows the report is for. */
  it('includes overdue, which the sweep-candidate predicate deliberately does not', () => {
    expect(AR_OPEN_STATUSES).toContain('overdue');
  });

  it('every AR-open status is a real invoice_status value', () => {
    for (const s of AR_OPEN_STATUSES) expect(INVOICE_STATUSES).toContain(s);
  });
});
```

- [ ] **Step 2: Run it and watch it fail** — `cd apps/api && npx vitest run src/db/schema/invoices.arPredicates.test.ts` → `AR_OPEN_STATUSES is not exported`.

- [ ] **Step 3: Export both predicates**

```ts
// apps/api/src/db/schema/invoices.ts — replace the file-local sqlOpenForOverdue at :28-30
/** Statuses an unpaid invoice can legitimately sit in. `overdue` is here and is
 *  the reason this constant is not `sqlOpenForOverdue`'s list: runOverdueSweep
 *  flips sent/partially_paid INTO 'overdue', so the sweep's candidate set and
 *  the AR-open set are deliberately different. #3198 R3 uses this one. */
export const AR_OPEN_STATUSES = ['sent', 'partially_paid', 'overdue'] as const;

/** Every invoice with a live receivable. */
export function sqlOpenAr(t: { status: unknown }): SQL {
  return sql`${t.status} IN ('sent','partially_paid','overdue')`;
}

/** Candidates for the daily overdue sweep: AR-open MINUS already-overdue.
 *  Exported for #3198 R3's reconciliation line, which needs the same status
 *  vocabulary rather than a third copy of it. */
export function sqlOpenForOverdue(t: { status: unknown }): SQL {
  return sql`${t.status} IN ('sent','partially_paid')`;
}
```

- [ ] **Step 4: Write the failing generator test** (same harness). Cases:
  1. **bucket boundaries**: `daysOverdue` 0 → `current`; 1 and 30 → `d1_30`; 31 and 60 → `d31_60`; 61 and 90 → `d61_90`; 91 → `d90_plus`;
  2. a NULL `due_date` with `balance > 0` lands in `no_due_date` and **never** in `current`;
  3. two currencies produce two `byCurrency` rows and no combined total anywhere in the summary;
  4. an invoice with `balance > 0` in `draft` / `paid` / `void` appears in `otherOpenBalance` and in **no** bucket, and `sum(buckets) + otherOpenBalance === total open balance` per currency;
  5. `asOf` is evaluated in the owner timezone — the same invoice is `current` in `Pacific/Auckland` and `d1_30` in `Pacific/Honolulu` for an as-of instant that straddles the date line;
  6. **aggregate-before-cap**: 6,000 matching invoices store 5,000 detail rows but the bucket totals reflect all 6,000;
  7. `lastPaymentAt` is the max `invoice_payments.received_at` for the invoice, `null` when there are none;
  8. partner scope binds `partnerId` **and** the org array; org scope binds `orgId`.

- [ ] **Step 5: Implement**

As-of: `const asOfDate = config.asOf ?? <today in the owner timezone>` — a `YYYY-MM-DD` **date**, not a timestamp, because `invoices.due_date` is a PG `date` (`schema/invoices.ts:49`) and `date - date` is an integer number of days with no timezone left to get wrong. The timezone decides *which* date "today" is; after that the arithmetic is date-to-date.

```sql
WITH scoped AS (
  SELECT i.id, i.org_id, i.invoice_number, i.currency_code, i.status,
         i.issue_date, i.due_date, i.total, i.amount_paid, i.balance,
         CASE WHEN i.due_date IS NULL THEN NULL
              ELSE ($asOf::date - i.due_date)::int END AS days_overdue
  FROM invoices i
  WHERE i.partner_id = $partnerId            -- partner scope; org scope drops this line
    AND i.org_id = ANY($orgIds)              -- org scope: i.org_id = $orgId
    AND i.balance > 0
),
bucketed AS (
  SELECT s.*, CASE
    WHEN s.due_date IS NULL                                 THEN 'no_due_date'
    WHEN s.days_overdue <= 0                                THEN 'current'
    WHEN s.days_overdue BETWEEN 1  AND 30                   THEN 'd1_30'
    WHEN s.days_overdue BETWEEN 31 AND 60                   THEN 'd31_60'
    WHEN s.days_overdue BETWEEN 61 AND 90                   THEN 'd61_90'
    ELSE 'd90_plus' END AS bucket
  FROM scoped s WHERE s.status IN ('sent','partially_paid','overdue')
)
SELECT <groupExpr>::text AS group_key, <groupLabelExpr> AS group_label, b.currency_code,
  COALESCE(SUM(b.balance) FILTER (WHERE b.bucket = 'current'),     0)::numeric(14,2) AS current,
  COALESCE(SUM(b.balance) FILTER (WHERE b.bucket = 'd1_30'),       0)::numeric(14,2) AS d1_30,
  COALESCE(SUM(b.balance) FILTER (WHERE b.bucket = 'd31_60'),      0)::numeric(14,2) AS d31_60,
  COALESCE(SUM(b.balance) FILTER (WHERE b.bucket = 'd61_90'),      0)::numeric(14,2) AS d61_90,
  COALESCE(SUM(b.balance) FILTER (WHERE b.bucket = 'd90_plus'),    0)::numeric(14,2) AS d90_plus,
  COALESCE(SUM(b.balance) FILTER (WHERE b.bucket = 'no_due_date'), 0)::numeric(14,2) AS no_due_date,
  COALESCE(SUM(b.balance), 0)::numeric(14,2) AS open_total,
  COUNT(*)::int AS invoice_count
FROM bucketed b LEFT JOIN organizations org ON org.id = b.org_id
GROUP BY 1, 2, 3 ORDER BY 1, 3
```

`<groupExpr>` is `b.org_id` (label `COALESCE(org.name,'Unknown organization')`) for `organization` and `b.currency_code` (label `b.currency_code`) for `currency`. `byCurrency` is the same query grouped on `currency_code` alone — run it as a second statement rather than re-bucketing in TS, so the per-currency headline is a SQL fact.

Reconciliation line, third statement over the same `scoped` CTE:

```sql
SELECT s.currency_code, COALESCE(SUM(s.balance), 0)::numeric(14,2) AS amount
FROM scoped s WHERE s.status NOT IN ('sent','partially_paid','overdue')
GROUP BY 1 ORDER BY 1
```

Every `numeric` comes back a **string**; carry it as a string into `ArAgingGroupRow.buckets` and `CurrencyAmountRow.amount` and never `Number()` it. `numeric(14,2)` rather than `(12,2)`: a partner-wide AR sum can exceed a single invoice's `numeric(12,2)` domain.

Detail rows, fourth statement, `LIMIT ${cap + 1}`, ordered `ORDER BY b.days_overdue DESC NULLS FIRST, b.balance DESC`, with the last payment via a lateral:

```sql
LEFT JOIN LATERAL (
  SELECT MAX(p.received_at) AS last_payment_at
  FROM invoice_payments p WHERE p.invoice_id = b.id
) lp ON true
```

`invoice_payments` carries its own `org_id` (`schema/invoices.ts:198`) and is org-axis RLS, but it is reached only through an already-scoped invoice id, so no extra predicate is needed — say so in a comment so a reviewer does not have to re-derive it.

`includePaidInPeriod` (default `false`) adds a fifth, purely informational statement counting invoices that **reached** `paid` since the period start, reported as `notes` text. It never changes a bucket.

Mandatory notes: `"As of ${asOfDate} in ${timeZone}."`, `"Invoices with no due date are reported in their own bucket and are never counted as current."`, `"Totals are reported per currency; no FX conversion is applied."`, and — when `otherOpenBalance` is non-empty — `"One or more invoices carry an open balance in a status outside the AR-open set (draft, paid or void). They are listed as other open balance so the buckets reconcile to total AR."`

- [ ] **Step 6: Register**

```ts
  ar_aging: {
    type: 'ar_aging', label: 'AR aging',
    configSchema: arAgingConfigSchema,
    supportedScopes: ['organization', 'partner'] as const,
    execution: 'user',
    requiredPermissions: [PERMISSIONS.INVOICES_READ],
    detailRowCap: 5000,
    generate: async (scope, config, authority) => {
      const { generateArAgingReport } = await import('./businessReports/arAgingReport');
      return generateArAgingReport(scope, config as never, authority);
    },
  },
```

`PERMISSIONS.INVOICES_READ` is `{ resource: 'invoices', action: 'read' }` (`packages/shared/src/constants/permissions.ts:74`).

- [ ] **Step 7: Run unit + registry green, then extend the integration file**

One `describe('ar_aging — partner scope')` proving: an `overdue`-status invoice **is** counted (the trap from §1); two orgs of the partner both appear; another partner's invoice does not; and a `draft` invoice with a residual balance lands in `otherOpenBalance` with the buckets still reconciling.

- [ ] **Step 8: Run everything for this task and commit**

```bash
cd apps/api && npx vitest run src/db/schema/invoices.arPredicates.test.ts \
  src/services/businessReports/arAgingReport.test.ts src/services/reportRegistry.test.ts \
  src/services/invoiceService.test.ts
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/businessReportsPartnerScope.integration.test.ts
git add apps/api/src/db/schema/invoices.ts apps/api/src/db/schema/invoices.arPredicates.test.ts \
  apps/api/src/services/businessReports/arAgingReport.ts \
  apps/api/src/services/businessReports/arAgingReport.test.ts \
  apps/api/src/services/reportRegistry.ts \
  apps/api/src/__tests__/integration/businessReportsPartnerScope.integration.test.ts
git commit -m "feat(reports): R3 ar_aging with the real AR-open set, per-currency buckets and a reconciliation line (#3198 W02)"
```

`invoiceService.test.ts` is in the list because Step 3 changed a symbol that file's module imports; it must stay green to prove the sweep predicate is untouched.

---

### Task 10: Three PDF modules and three chain arms

Spec §3.4: per-type modules on the existing primitive kit; **no** section-composition layer (that is QBR-pack work and is out of scope). `formatGenericCell` is untouched.

**Files:** Create `packages/shared/src/reportPdf/{ticketSlaPdf,technicianTimePdf,arAgingPdf}.ts` and `reportPdf.{ticketSla,technicianTime,arAging}.test.ts`; modify `reportPdf.ts` (`BuildOpts.summary` at `:155`, the chain after `:2164`) and `reportPdf/index.ts`.

**Module contract — copy `identityAccessPdf.ts` exactly:**

```ts
import type { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import type { TicketSlaSummary } from '../types/businessReports';
import { formatMinutes, formatMoney, formatPercent } from './moneyFormat';

type RGB = [number, number, number];

/** The pieces of reportPdf.ts's design system this renderer needs. DECLARED,
 *  not imported — importing reportPdf.ts from here is a module cycle. Same
 *  shape as identityAccessPdf.ts:43-53. */
export type PdfChrome = {
  C: { ink: RGB; primary: RGB; success: RGB; danger: RGB; warning: RGB;
       muted: RGB; faint: RGB; rule: RGB; zebra: RGB; panel: RGB; white: RGB };
  PAGE: { w: number; h: number; mx: number; bandH: number; footY: number };
  drawHeaderBand: (doc: jsPDF) => void;
  drawFooter: (doc: jsPDF) => void;
  drawTitleBlock: (doc: jsPDF, title: string, subtitle: string, meta: string, top: number) => number;
  drawSectionHeading: (doc: jsPDF, text: string, y: number) => number;
};

export type TicketSlaPdfOpts = {
  generatedAt: string; partnerName: string | null;
  contactEmail?: string | null; contactName?: string | null;
  previous?: { generatedAt?: string | null; summary?: unknown };
};

export function renderTicketSlaReport(
  doc: jsPDF, summary: TicketSlaSummary, opts: TicketSlaPdfOpts, chrome: PdfChrome,
): void { /* … */ }
```

**Export names follow the shipped convention, not the brief's shorthand.** Every module in this directory exports `render<Type>Report` (`renderIdentityAccessReport` `identityAccessPdf.ts:161`, `renderThreatDetectionReport`, `renderEndpointManagementReport`, `renderVulnerabilityManagementReport`, `renderHardwareLifecycleReport`) and the signature is `(doc, summary, opts, chrome)`. The three new ones are `renderTicketSlaReport`, `renderTechnicianTimeReport`, `renderArAgingReport`. See the ambiguity note at the end of this plan.

**Page content, per module:**

| Module | Title block | Sections |
|---|---|---|
| `ticketSlaPdf.ts` | "Ticket SLA attainment" / scope label / `"${period.label} · ${timeZone} · Prepared ${generatedAt}"` | **What this measures** (the five `notes`, verbatim, `C.muted`) → **Headline** tiles: response attainment `formatPercent`, resolution attainment, breaches, tickets with no SLA → **By ${groupBy}** `autoTable` (group, tickets, response %, resolution %, breaches, no SLA) → **Recompute vs stamped** one-line prose with both discrepancy counts → **Breached tickets** `autoTable` from `rows` |
| `technicianTimePdf.ts` | "Technician time & billability" | **How these numbers are built** (`notes`) → tiles: utilization, billable %, billing conversion, zero-time technicians → **By ${groupBy}** table (`formatMinutes` for every minute column) → **Billable value** table, **one row per currency**, `formatMoney` → **Entries** detail table |
| `arAgingPdf.ts` | "AR aging" / `"As of ${asOf} (${timeZone})"` | **Basis** (`notes`) → **Per currency** table (the six buckets + open total), one row per currency → **By ${groupBy}** table → **Other open balance** line, rendered **only when non-empty**, with the reconciliation sentence → **Open invoices** detail table |

**Three rules every module obeys** (the identityAccessPdf precedent, `:9-27`):
1. A `null` ratio prints `N/A` via `formatPercent(null)`, never `0%`. An unmeasured attainment and a 0% attainment are different claims.
2. Money is printed only through `formatMoney(amount, row.currencyCode)` and **never** totalled across rows in the renderer. If a template needs a grand total it does not exist, because the generator did not compute one.
3. `summary.notes` is printed verbatim at the top, before any number. The approximations are the price of shipping these reports (OD-2, OD-3); a PDF that hides them is the failure mode the spec argued its way out of.

**Truncation is printed, not implied:** when `summary.detail.truncated`, the detail table's section heading carries `" (showing ${detail.stored} of ${detail.available})"`. `identityAccessPdf.ts:68-70` caps its own table at 500 rows on top of the generator's cap; do the same here with a module-local `DETAIL_TABLE_MAX = 500` and fold both numbers into that one sentence.

- [ ] **Step 1: Write the three failing renderer tests**

Copy `packages/shared/src/reportPdf/reportPdf.identityAccess.test.ts` wholesale (its `extractText` + `decodeWinAnsi` helpers at `:9-22` are what make jsPDF byte assertions work) and change the fixture. Per type:

```ts
// packages/shared/src/reportPdf/reportPdf.ticketSla.test.ts (shape)
describe('buildReportPdf: ticket_sla_attainment', () => {
  it('routes to the SLA renderer, not renderGenericReport', () => {
    const spy = vi.spyOn(slaPdf, 'renderTicketSlaReport');
    buildReportPdf([], { ...opts, summary: SUMMARY });
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  it('a summary-less result falls through to the generic renderer rather than throwing', () => {
    expect(() => buildReportPdf([], opts)).not.toThrow();
  });

  it('prints the approximation notes verbatim', () => {
    const text = extractText(buildReportPdf([], { ...opts, summary: SUMMARY }));
    expect(text).toContain('lifetime total');
  });

  it('prints N/A, never 0%, for an unmeasured group', () => {
    const s = { ...SUMMARY, groups: [{ ...SUMMARY.groups[0]!, responseEligible: 0, responseMet: 0, responseAttainment: null }] };
    const text = extractText(buildReportPdf([], { ...opts, summary: s }));
    expect(text).toContain('N/A');
  });

  it('discloses truncation with both numbers', () => {
    const s = { ...SUMMARY, detail: { cap: 5000, stored: 5000, available: 9000, truncated: true } };
    expect(extractText(buildReportPdf([], { ...opts, summary: s }))).toMatch(/5000 of 9000/);
  });
});
```

The AR test adds: **two currencies produce two rows and no third, combined figure** — assert the text contains both formatted totals and that neither appears summed. The technician test adds: a group with `capacityMinutes: null` prints `N/A` for utilization.

- [ ] **Step 2: Run the three and watch them fail** — `cd packages/shared && npx vitest run src/reportPdf/reportPdf.ticketSla.test.ts src/reportPdf/reportPdf.technicianTime.test.ts src/reportPdf/reportPdf.arAging.test.ts`. Expected: FAIL on the missing modules.

- [ ] **Step 3: Write the three modules.**

- [ ] **Step 4: Widen `BuildOpts.summary` and add the three chain arms**

```ts
// packages/shared/src/reportPdf/reportPdf.ts:155 — append three members
  summary?: PostureSummary | ExecutiveSummary | OrgNarrativeReportSummary | FleetDesignReportSummary
    | HardwareLifecycleSummary | ThreatDetectionSummary | EndpointManagementSummary
    | VulnerabilityManagementSummary | IdentityAccessSummary
    | TicketSlaSummary | TechnicianTimeSummary | ArAgingSummary;
```

Each arm goes after the `identity_access_review` arm (`:2126-2164`), before the final `else`:

```ts
  } else if (
    opts.reportType === 'ticket_sla_attainment'
    && opts.summary
    // `!= null` FIRST: typeof null === 'object', so a summary carrying an
    // explicit `period: null` must not enter the arm and render a period label
    // it does not have. Same guard shape as the W02/W06 arms above.
    && (opts.summary as TicketSlaSummary).period != null
    && typeof (opts.summary as TicketSlaSummary).period === 'object'
  ) {
    // Self-contained chrome: the group and detail tables paginate on their own.
    // A type with NO arm here silently falls through to renderGenericReport,
    // which prints the rows as a flat table and DROPS the whole designed
    // summary — including the approximation notes that keep this report honest.
    drawHeaderBand(doc, opts);
    drawFooter(doc, opts);
    ticketSlaPdf.renderTicketSlaReport(
      doc, opts.summary as TicketSlaSummary,
      { generatedAt: opts.generatedAt, partnerName: opts.branding?.name ?? null,
        contactEmail: opts.branding?.contactEmail ?? null,
        contactName: opts.branding?.contactName ?? null, previous: opts.previous },
      { C, PAGE, drawHeaderBand: (d) => drawHeaderBand(d, opts),
        drawFooter: (d) => drawFooter(d, opts), drawTitleBlock, drawSectionHeading },
    );
  }
```

The `technician_time_billability` arm guards on `(summary as TechnicianTimeSummary).period != null`; the `ar_aging` arm on `typeof (summary as ArAgingSummary).asOf === 'string'` (AR has no period object — it has an as-of date).

Import the three modules with the **namespace** form used for the spied-on renderers (`import * as ticketSlaPdf from './ticketSlaPdf';`, matching `identityAccessPdf` / `threatDetectionPdf` at the top of `reportPdf.ts`): `vi.spyOn(mod, 'fn')` cannot intercept a direct named import.

- [ ] **Step 5: Export from the barrel**

```ts
// packages/shared/src/reportPdf/index.ts
export { renderTicketSlaReport } from './ticketSlaPdf';
export type { TicketSlaPdfOpts } from './ticketSlaPdf';
export { renderTechnicianTimeReport } from './technicianTimePdf';
export type { TechnicianTimePdfOpts } from './technicianTimePdf';
export { renderArAgingReport } from './arAgingPdf';
export type { ArAgingPdfOpts } from './arAgingPdf';
```

- [ ] **Step 6: Run the whole reportPdf suite** — `cd packages/shared && npx vitest run src/reportPdf/`. Expected: every file PASS, including the pre-existing `reportPdf.test.ts` (which asserts generic-path behaviour that must not have moved).

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/reportPdf/
git commit -m "feat(reports): PDF renderers for the three business report types (#3198 W02)"
```

---

### Task 11: Caller wiring — scope, permissions, and the recipient refusal

Six call sites pass an org id to `generateReport` today. All six move to a `ReportScope`, and the two request-path routes gain the per-type permission gate spec §2 requires.

**Files:** Modify `apps/api/src/routes/reports/generate.ts`, `runs.ts`, `recipients.ts`, `schemas.ts`; `apps/api/src/jobs/reportScheduleWorker.ts:567`; `apps/api/src/services/portal/reportsSelfService.ts:589`; `apps/api/src/services/deliverableAutoEvidence.ts:326`. Create `apps/api/src/routes/reports/generate.businessScope.test.ts`.

- [ ] **Step 1: Write the failing route test**

```ts
// apps/api/src/routes/reports/generate.businessScope.test.ts — cases, not full code
// 1. partner scope + ownerScope:'partner' + ar_aging  -> 200, and generateReport
//    was called with { kind:'partner', partnerId, orgIds:[...] }
// 2. partner scope + ownerScope:'partner' + device_inventory -> 400 { error: 'unsupported_report_scope' }
// 3. org scope + ar_aging -> 200 with { kind:'organization', orgId }
// 4. a caller WITHOUT invoices:read + ar_aging -> 403, and generateReport not called
// 5. a caller WITHOUT time_entries:read + technician_time_billability -> 403
// 6. ownerScope:'partner' from an ORGANIZATION-scope token -> 403 (never reaches the authority)
// 7. ownerScope:'partner' when resolveRequestPartnerReportAuthority denies
//    ('partner_access_not_all') -> 403
```

Case 2 is the gate-order proof: it must be a **400 `unsupported_report_scope`**, not a 403 or a 500. If it comes back 500 with "organization mismatch", the `supportedScopes` check was placed after `assertReportExecutionPreflight` — go back to Task 3 Step 5.

- [ ] **Step 2: Run it and watch it fail** — `cd apps/api && npx vitest run src/routes/reports/generate.businessScope.test.ts`.

- [ ] **Step 3: Rewrite the `generate.ts` scope branch**

The existing org resolution (`generate.ts:30-53`) stays for `ownerScope: 'organization'`. The partner branch is carved out **ahead** of the "orgId is required when partner has multiple organizations" 400 at `:44` — spec §3.1 is explicit that the check must not fire first.

```ts
const data = c.req.valid('json');
const auth = c.get('auth');
let scope: ReportScope;
let owner: ReportOwner;

if (data.ownerScope === 'partner') {
  // BEFORE the multi-org 400 below: a partner-wide report is precisely the
  // request that legitimately omits orgId (spec §3.1, core.ts:409-415).
  if (auth.scope !== 'partner' || !auth.partnerId) {
    return c.json({ error: 'Partner context required' }, 403);
  }
  const partnerResult = await resolveRequestPartnerReportAuthority(auth, auth.partnerId, 'read');
  if (!partnerResult.ok) return c.json({ error: 'Access to report scope denied' }, 403);
  owner = { partnerId: auth.partnerId };
  scope = await reportScopeFromAuthority(owner, partnerResult.authority);
  authority = partnerResult.authority;
} else {
  /* …existing org resolution, unchanged… */
  owner = { orgId: orgId! };
  scope = organizationScope(orgId!);
}
```

Then the per-type permission gate, immediately before the `generateReport` call:

```ts
// Spec §2: business reports reveal money and HR-adjacent data, so generation
// gates on the UNDERLYING read permissions, following the billables-export
// precedent (routes/tickets/export.ts:17-18). The route middleware's
// reports:export grant is necessary but not sufficient.
const perms = c.get('permissions') as UserPermissions | undefined;
for (const required of REPORT_GENERATORS[data.type].requiredPermissions) {
  if (!perms || !hasPermission(perms, required.resource, required.action)) {
    return c.json({ error: 'Insufficient permissions' }, 403);
  }
}
```

`c.get('permissions')` is populated by `authMiddleware` (`middleware/auth.ts:919`) and re-read by `requirePermission` (`:1004`), both of which already run on this route.

And the error mapping in the existing `catch` (`generate.ts:74-86`) gains one arm:

```ts
      if (error instanceof UnsupportedReportScopeError) {
        return c.json({ error: 'unsupported_report_scope', type: data.type }, 400);
      }
      if (error instanceof ReportScopeMismatchError) {
        return c.json({ error: 'Access to report scope denied' }, 403);
      }
```

- [ ] **Step 4: Do the same in `runs.ts`**

`POST /reports/:id/generate` (`runs.ts:66-183`) already fetches the row. After W01 it uses `getReportWithOwnerCheck`; W02 derives the axis from the row rather than assuming `report.orgId`:

```ts
const owner = reportOwnerOf(report);              // W01: throws unless exactly one is set
const liveResult = owner.partnerId !== undefined
  ? await resolveRequestPartnerReportAuthority(auth, owner.partnerId, 'read')
  : await resolveRequestReportAuthority(auth, owner.orgId, 'read');
// …existing decodeSiteScope / intersectSiteScopes / persistedSiteScopeValues path,
// with decodeSiteScope(row, owner) taking the OWNER after W01…
const scope = await reportScopeFromAuthority(owner, executionAuthority);
const result = await generateReport(report.type, scope, config, executionAuthority);
```

Apply the same `requiredPermissions` gate and the same two catch arms. `writeRouteAudit`'s `orgId` becomes `owner.orgId ?? null` — a partner-owned run has no org to attribute and must not borrow one.

- [ ] **Step 5: Update the three non-route call sites (mechanical)**

| File:line | Change |
|---|---|
| `apps/api/src/jobs/reportScheduleWorker.ts:567` | `generateReport(report.type, await reportScopeFromAuthority(reportOwnerOf(report), executionAuthority), config, executionAuthority)`. W01 already branches this function on the owner axis; this is the one line that still passes `report.orgId`. Its `resolveOrgTimezone(report.orgId)` at `:599` becomes `resolveReportOwnerTimezone(owner)`. |
| `apps/api/src/services/portal/reportsSelfService.ts:589` | `generateReport(definition.type, organizationScope(args.orgId), effectiveConfig, authority)`. Portal definitions are org-owned by construction; nothing else changes. |
| `apps/api/src/services/deliverableAutoEvidence.ts:326` | `generateReport(definition.type, organizationScope(definition.orgId), config, authority)`. The `generateManagedEvidenceReport` call at `:292` is **unchanged** — that signature still takes an org id. |

- [ ] **Step 6: Refuse contact recipients on the three business types**

```ts
// apps/api/src/routes/reports/schemas.ts — beside INTERNAL_REPORT_TYPES at :49
/**
 * Types whose scheduled delivery goes only to `config.emailRecipients`, never to
 * a `report_schedule_recipients` contact row (spec §3.5). Two reasons, both
 * structural: these reports are internal to the MSP and are never portal-visible
 * (§2 "Not in scope"), and a PARTNER-owned definition cannot hold a contact
 * recipient at all — `report_schedule_recipients (report_id, org_id) →
 * reports(id, org_id)` is an org-only composite FK (§3.1a).
 *
 * Sibling of INTERNAL_REPORT_TYPES, and deliberately a SECOND set: an internal
 * type is one a human may not create; these are creatable, they just cannot
 * carry a contact.
 */
export const PARTNER_ONLY_DELIVERY_REPORT_TYPES: ReadonlySet<string> =
  new Set(BUSINESS_REPORT_TYPES);
```

```ts
// apps/api/src/routes/reports/recipients.ts — extend systemManagedRefusal at :41-46
function recipientRefusal(report: { type?: string | null; partnerId?: string | null }) {
  const type = report.type ?? '';
  if (INTERNAL_REPORT_TYPES.has(type)) return { error: 'report_type_system_managed' as const, type };
  if (PARTNER_ONLY_DELIVERY_REPORT_TYPES.has(type)) {
    return { error: 'report_type_partner_only_delivery' as const, type };
  }
  // W01 already refuses partner-OWNED definitions of any type here with
  // `partner_owned_report`; this arm is about the TYPE, and fires for an
  // org-owned business report too.
  return null;
}
```

Both writers (`:105` and `:169`) already `return c.json(refusal, 409)` — only the helper changes. Add two cases to `recipients.test.ts`: `ar_aging` → 409 `report_type_partner_only_delivery`; `executive_summary` → still 200.

- [ ] **Step 7: Run every touched suite**

```bash
cd apps/api && npx vitest run src/routes/reports src/jobs/reportScheduleWorker.test.ts \
  src/services/portal/reportsSelfService.test.ts src/services/deliverableAutoEvidence.test.ts \
  src/services/reportGenerationService.test.ts src/services/reportRegistry.test.ts
```

Note the bare `src/routes/reports` filter (no trailing slash) — vitest's path filter is a plain substring match, and `src/routes/reports/` would silently skip nothing here but would elsewhere; check the reported file count is ≥ 10.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/routes/reports apps/api/src/jobs/reportScheduleWorker.ts \
  apps/api/src/services/portal/reportsSelfService.ts apps/api/src/services/deliverableAutoEvidence.ts
git commit -m "feat(reports): route and worker wiring for scoped generation, per-type permission gates, recipient refusal (#3198 W02)"
```

---

### Task 12: Final verification and the PR

- [ ] **Step 1: No placeholder survived**

```bash
grep -rn "not implemented until" apps/api/src/services/reportRegistry.ts
```
Expected: **no output.** Task 3 Step 4 seeded three throwing placeholders so the tree compiled between tasks; Tasks 7, 8 and 9 replaced them. A hit here means a business type would 500 on first use.

```bash
grep -rn "TODO\|FIXME\|TBD" apps/api/src/services/businessReports packages/shared/src/reportPdf/ticketSlaPdf.ts \
  packages/shared/src/reportPdf/technicianTimePdf.ts packages/shared/src/reportPdf/arAgingPdf.ts
```
Expected: no output.

- [ ] **Step 2: No migration was added**

```bash
git diff --name-only origin/main...HEAD -- apps/api/migrations/
```
Expected: **no output.** W02 adds no migration (Global Constraints). If W01 is in the same branch stack its two files will show — in that case confirm the only entries are `2026-10-26-100000-report-type-business.sql` and `2026-10-26-100100-reports-partner-ownership.sql` and that neither was edited by this wave (`git log --oneline -- apps/api/migrations/`).

- [ ] **Step 3: Every partner-scope query carries its tenancy predicate**

```bash
grep -n "partner_id = \|org_id = ANY\|org_id = \${" apps/api/src/services/businessReports/*.ts
```
Read every hit against the table in "READ THIS FIRST" §2. Then:

```bash
grep -n "withSystemDbAccessContext" apps/api/src/services/businessReports/*.ts
```
Expected: exactly one `runScoped` helper per generator file (three hits plus the `period.ts` partner-timezone lookup), and **no** system context opened for an organization scope.

- [ ] **Step 4: Typecheck all three packages**

```bash
pnpm --filter @breeze/shared typecheck && pnpm --filter @breeze/api typecheck && pnpm --filter @breeze/web typecheck
```

- [ ] **Step 5: Unit suites**

```bash
cd packages/shared && npx vitest run
cd ../../apps/api && npx vitest run
cd ../web && npx vitest run
```

All green. `apps/api`'s full run is the behaviour-preservation proof for the dispatcher rewrite — nothing outside `routes/reports`, `services/report*` and `services/businessReports` should have needed an edit.

- [ ] **Step 6: Integration suites**

```bash
pnpm test-stack up
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/businessReportsPartnerScope.integration.test.ts \
  src/__tests__/integration/identityAccessEvidence.integration.test.ts \
  src/__tests__/integration/threatDetectionEvidence.integration.test.ts \
  src/__tests__/integration/endpointManagementEvidence.integration.test.ts \
  src/__tests__/integration/vulnerabilityManagementEvidence.integration.test.ts \
  src/__tests__/integration/managedEvidenceFoundations.integration.test.ts \
  src/__tests__/integration/portalReportSelfService.integration.test.ts \
  src/__tests__/integration/report-site-scope.integration.test.ts \
  src/__tests__/integration/reportRunProvenance.integration.test.ts
```

The four evidence suites plus `managedEvidenceFoundations` are the end-to-end proof that the `managed_evidence` execution path survived the registry migration; `report-site-scope` and `reportRunProvenance` prove the authority/fingerprint plumbing did.

- [ ] **Step 7: RLS coverage contract** (W02 adds no table, but the dispatcher touches tenancy)

```bash
DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage
```

Expected: PASS with no allowlist edit. **If this demands a new entry, W02 created a table or a policy it should not have** — stop and re-read the Global Constraints.

- [ ] **Step 8: Tear the stack down**

```bash
pnpm test-stack down
docker compose ls -a --format json | jq -r '.[] | select(.ConfigFiles|test("breeze")) | "\(.Name)\t\(.Status)"'
```
Nothing of this session's should remain.

- [ ] **Step 9: Open the PR**

```bash
gh pr create --base main --title "feat(reports): registry map, three business generators, PDF modules (#3198 W02)" --body-file -
```

PR body checklist — every box must be ticked with evidence, not intention:

```markdown
## W02 — registry map + the three Phase 1 business reports

Spec: `docs/superpowers/specs/reports/2026-08-16-psa-business-reports-spec.md` §3.2–§3.4, §6
Plan: `docs/superpowers/plans/reports/2026-09-21-business-reports-w02-registry-generators.md`
Depends on: W01 (merged) — `partner_wide` authority, `reports.partner_id`, `ReportOwner`.

Closes #<W02 wave sub-issue>

### What changed
- `REPORT_GENERATORS` replaces the 13-arm dispatch switch. **All** types migrated; no half-state.
- Three new report types generate at organization **and** partner scope.
- One canonical `REPORT_TYPES` tuple feeds zod, the API union and the web union.
- Per-type config schemas move into the registry; `reportConfigSchema` is a discriminated lookup.
- Three PDF modules + `moneyFormat.ts`. `formatGenericCell` untouched.

### Behaviour preservation (the risky half)
- [ ] `reportGenerationService.test.ts` passes with **no** assertion edits beyond the `generateReport(type, organizationScope(orgId), …)` call shape.
- [ ] `schemas.configParity.test.ts` proves no config key is dropped for any of the 13 existing types, including undeclared builder metadata.
- [ ] All four `*Evidence.integration.test.ts` suites + `managedEvidenceFoundations` pass — the system execution path is unchanged.
- [ ] `execution: 'managed_evidence'` keys equal `MANAGED_EVIDENCE_REGISTRY` and both hand-parallel twins (registry test).

### Correctness decisions a reviewer should check
- [ ] **AR open ≠ sweep-candidate open.** `sqlOpenAr` includes `'overdue'`; `sqlOpenForOverdue` deliberately does not. `invoices.arPredicates.test.ts` pins both.
- [ ] Every partner-scope query carries `partner_id` and/or the org allowlist in its own `WHERE` (system context = no RLS).
- [ ] No money is summed across currencies anywhere; every money field is a per-currency array.
- [ ] Aggregates are computed over the full set; only detail rows are capped at 5,000, and truncation is printed on the artifact.
- [ ] Unmeasured ratios are `null` → `N/A`, never `0`.
- [ ] `supportedScopes` is checked **before** `assertReportExecutionPreflight`, so an org-only type under a partner scope is a 400 `unsupported_report_scope`, not a 500.

### Tenancy
- [ ] **No migration in this wave.** `git diff --name-only origin/main...HEAD -- apps/api/migrations/` is empty.
- [ ] No new table, so no cascade / export-policy / RLS-allowlist registration is owed.
- [ ] `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage` passes with no allowlist edit.

### Not in this wave
Web templates, options forms, the "Business" grouping, `reportExport.ts` numerics, 8 locales, `apps/docs`, release notes — all W03. The three types exist and generate, but nothing in the UI offers them yet.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

---

## Self-review

**Spec coverage.** §3.2 generator contract → Task 2 + Task 3. §3.3 R1 → Task 7 (recompute, `work_kind='support'`, `deleted_at IS NULL`, NULL-target exclusion, discrepancy count, four group-bys, current-assignee label, summary block). §3.3 R2 → Task 8 (zero-time techs, `duration_minutes` vs `billable_minutes`, `coverage` with `is_billable` fallback, work-type axis, per-currency value, capacity proration, org-scope label). §3.3 R3 → Task 9 (AR-open set, buckets, per-currency, NULL due-date bucket, reconciliation line, as-of in the owner timezone, aggregate-before-cap, last payment). §3.4 → Tasks 5 + 10. §4 detail cap → Tasks 5, 7, 8, 9, 10. §6 registry → Tasks 1, 3, 4. §2 permissions → Task 11. §3.5 recipient refusal and "never portal-visible" → Task 11 + the registry test. §10 test notes (Drizzle-mock unit tests, one integration per generator, walk bound params) → Tasks 7–9.

**Out of scope by design, and where it lands:** every `apps/web` surface, the 8 locale files, `reportExport.ts`, `apps/docs`, release notes (W03); the enum and ownership migrations, the `partner_wide` authority, the worker's owner branch, the RLS suites (W01).

**Type consistency.** `ReportScope` / `organizationScope` / `reportOwnerOfScope` (Task 2) are used verbatim in Tasks 3, 7, 8, 9, 11. `ReportTypeDef` fields declared in Task 3 are the ones Tasks 7–9 populate and Task 11 reads (`requiredPermissions`). `empty*Summary` (Task 5) is what Task 3 Step 6's `zeroSafeReport` arms call. `render<Type>Report(doc, summary, opts, chrome)` (Task 10) matches the shipped convention, and the chain arms call exactly those names. `TicketSlaSummary` / `TechnicianTimeSummary` / `ArAgingSummary` field names are identical in Task 5 (declaration), Tasks 7–9 (construction) and Task 10 (rendering).

**Ordering dependency to respect:** Task 3 Step 6 (the `zeroSafeReport` arms) needs Task 5's factories. Execute Task 5 first, or stub as Step 6 says and return to it — the step states both.

## Spec ambiguities resolved in this plan

| # | Ambiguity | Resolution |
|---|---|---|
| 1 | §3.3 R3 says to reuse "the open-status predicate behind `sqlOpenForOverdue`", but that predicate excludes `'overdue'` — the status every past-due invoice is flipped into by `runOverdueSweep`. | Export `sqlOpenForOverdue` as the spec asks **and** add `sqlOpenAr` = `('sent','partially_paid','overdue')`. R3 uses `sqlOpenAr`. Pinned by `invoices.arPredicates.test.ts`. Without this the report shows an MSP with almost no aged AR. |
| 2 | §3.2 shows `generateReport(type, scope, config, authority)`; the wave brief also says "public signatures preserved". | `generateReport`'s second parameter **widens** to `ReportScope` (the spec's own contract, and the point of the wave); `generateManagedEvidenceReport` is byte-identical, since managed evidence is org-owned by construction. `organizationScope(orgId)` keeps the six call sites readable. |
| 3 | The brief names the PDF exports `render<Type>Pdf(doc, opts, kit)`; every shipped module in the directory exports `render<Type>Report(doc, summary, opts, chrome)`. | Follow the shipped convention: `renderTicketSlaReport`, `renderTechnicianTimeReport`, `renderArAgingReport`, four parameters. The brief's own "following `identityAccessPdf.ts`'s signature exactly" is the controlling clause. |
| 4 | §3.3 R1 gives `groupBy` a scope-dependent default ('organization' at partner scope, 'priority' at org scope), which a zod `.default()` cannot express. | The schema leaves `groupBy` optional with **no** default; the generator applies the scope-dependent one and publishes the resolved value in `summary.groupBy`. Pinned by a unit test in both directions. |
| 5 | §3.3 R2 group-bys other than `technician` have no meaningful capacity denominator, but the spec only says utilization is "per tech". | `capacityMinutes` and `utilization` are `null` on every row of the `organization` and `work_type` axes. Inventing a per-work-type capacity would be a fabricated denominator. The `techs` LEFT JOIN shape is also dropped for those two axes (it would emit one all-NULL row per idle tech), with `zeroTimeTechnicians` reported from its own count. |
| 6 | The spec does not say what a **site-restricted** authority gets for these types. `zeroSafeReport`'s `never` default forces an answer. | Refusal-shaped empty, like `identity_access_review` (OD-8 = A): tickets, time entries and invoices carry no site axis, so nothing was queried. The summary says so in `notes`; the figures are `null`, not `0`. |
| 7 | §6 wants the registry to own per-type config schemas, but today's `reportConfigSchema` is a **loose** object the builder round-trips presentation metadata through. A strict discriminated union would silently strip it on the next `PUT`. | Every registry `configSchema` is `z.looseObject`, and `reportConfigSchema` is a manual lookup (not `z.discriminatedUnion`, which would require `type` on every config object including legacy rows and PATCH bodies). `schemas.configParity.test.ts` parses a real stored-shape fixture per type and asserts nothing is dropped. The one deliberate loosening — a foreign per-type key is now passed through rather than validated — is asserted explicitly so nobody "tightens" it back into data loss. |
| 8 | Where the `supportedScopes` gate sits relative to the existing preflight is unstated. | Immediately after the system-authority refusal and **before** `assertReportExecutionPreflight`, whose `assertExecutableAuthority` compares owner axes and would turn an org-only-type-under-partner-scope into an "organization mismatch" 500 instead of the 400 the route translates. Task 11's route test case 2 is the proof. |
