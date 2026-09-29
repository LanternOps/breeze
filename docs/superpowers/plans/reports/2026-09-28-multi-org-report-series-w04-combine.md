---
tracking_issue: see the INDEX frontmatter (registered with the feature)
spec: docs/superpowers/specs/reports/2026-09-28-multi-org-report-series-design.md
index: docs/superpowers/plans/reports/2026-09-28-multi-org-report-series-INDEX.md
wave: W04 — Combine (one PR)
blast_radius: medium (rewrites existing rows' shared fields, archives duplicates, repoints deliverable evidence links; no migration)
written_against: main 92764125ed + spec commit e9ac8b6e22 (W02/W03 not yet written — built against the INDEX contract)
---

# Multi-org Report Series W04: Combine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Read [`2026-09-28-multi-org-report-series-INDEX.md`](2026-09-28-multi-org-report-series-INDEX.md) first.** It holds the global constraints and the fixed cross-wave contract. This plan uses those names verbatim.

## Contract concerns

The coordinator accepted these concerns and folded them into the INDEX: its "Error codes", "Recipient delivery gate", "Revision sentinel" and "Route files" sections. Confirm each against the merged W02 code during the Preflight, before starting Task 1.

1. **Error carrier: resolved.** W02 throws `ReportSeriesError(code, status, body?)` from `services/reportSeries/errors.ts`, and every route maps it through `seriesErrorResponse(c, err)`. W04's `CombineError` **extends** `ReportSeriesError`, so there is no parallel error class. The Combine route uses W02's mapper. Its one special case is the existing export+MFA refusal body.
2. **`combineIntoSeries` returns a superset.** The contract return is `{ seriesId }`. W04 returns `{ seriesId, adopted, archived, repointedDeliverableIds }`. The route needs the extra lists for per-org audit events. Because the type is a structural superset, callers typed against the contract still compile.
3. **Additive error codes: now in the INDEX.** W04 adds `combine_group_changed` (409) and `combine_cc_too_many` (400). A 403 reuses the existing `RECIPIENTS_NEED_EXPORT_AND_MFA` body, which W02 has moved to `routes/reports/recipientGate.ts`.
4. **Where the combine routes live.** The two combine routes are in a new module, `routes/reports/seriesCombine.ts` (`seriesCombineRoutes`). `series.ts` mounts it ahead of its own `/:id` routes, so the URL paths are exactly the contract's. Keeping the routes in their own module lets them be unit-tested without mocking all of W02's route file. The cost is one `MCP_COVERAGE` entry (Task 5).
5. **Adoption goes through the reconciler.** Adopted rows are written with `series_revision = 0`. `reconcileSeries` then overwrites their shared fields through its "active child at an old revision" branch (spec §3.3). The series revision starts at 1, so 0 is always "old" under `<`, `<>` or `IS DISTINCT FROM`. The Preflight checks this against W02's code.
6. **`CombineInput` carries one server-derived flag.** That flag is `callerMaySetEmailRecipients`. The route computes it with **W02's** `callerMaySetEmailRecipients(auth)` from `routes/reports/recipientGate.ts`, which checks `reports:export` plus a satisfied MFA session. W04 does not extract or edit that gate, and the flag is never read from the request body.
7. **No shared transaction type.** The INDEX has no transaction type in `types.ts`. `combine.ts` declares `type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]` locally, which is the same idiom as `services/authLifecycle.ts:10`. If W02 exported a transaction type, use W02's instead.

---

**Goal:** Let a partner admin find existing near-identical per-org reports and combine them, in one transaction, into a multi-org series. The combine adopts one row per org in place, so each org keeps its report `id`, runs, evidence links and contact recipients. Surplus duplicates are archived.

**Architecture:** Three pieces.

- **Pure key and plan modules** in `services/reportSeries/`:
  - `combineKey.ts` defines "near-identical" exactly once, as a canonical config form plus a SHA-256 group key.
  - `combinePlan.ts` holds the exclusions, grouping, adoption choice, the CC split and resolution, and the response DTOs.
- **A DB service**, `combine.ts`, containing `findCombineCandidates` and `combineIntoSeries`. It reads org-owned rows of one partner and re-derives the group under `FOR UPDATE`. It then:
  1. creates the series and its targets;
  2. unions duplicate recipients onto the adopted row, repoints deliverable links, archives duplicates, and adopts each row at revision 0;
  3. calls W02's `reconcileSeries` last, which writes the shared fields and creates children for `all` mode.
- **The routes and web UI.** `GET/POST /reports/series/combine*` go through the partner-wide gate. `CombineBanner` and `CombineDialog` are mounted in `ReportsList` under All organizations. Every mutation goes through `runAction`.

**Tech Stack:** Hono, Drizzle and postgres.js; Vitest (unit tests, plus the integration suite against real Postgres as `breeze_app`); React with Testing Library; i18next locale catalogs (8 locales).

**Spec:** `docs/superpowers/specs/reports/2026-09-28-multi-org-report-series-design.md`:

- §3.8 Combine;
- §2 D4, which makes Combine opt-in only;
- §3.2 series restrictions;
- §3.4 authority;
- §5 W04 tests.

**Depends on:** W03 merged, which means W02 is merged too. W04 has **no migration**. Every column it writes was created by W02.

---

## Global Constraints

- **INDEX global constraints apply unchanged.** In particular:
  - **Write gate:** `reports:write` AND `canManagePartnerWidePolicies(auth)` AND `auth.scope === 'partner'`.
  - **Partner id:** `partner_id` always comes from the token.
  - **Archive, never delete.** Runs and evidence survive.
  - **Web:** every web mutation goes through `runAction`. UI state lives in `window.location.hash`. E2E selectors use `data-testid` only.
- **Combine is opt-in (D4).** Nothing in this wave runs automatically. The candidate query is read-only.
- **Existing behaviour is byte-for-byte unchanged for rows that are not combined.** W04 changes no existing route or service behaviour. `core.ts` is not touched: W02 owns the `recipientGate.ts` extraction.
- **Service layer never imports the route layer.** `services/reportSeries/*` must not import `routes/**`, per `routes/reports/schemas.ts:17`. Tests may import both.
- **`partnerOwnedVisibility.scan.test.ts` stays green.** Every `reports` query site in `combine.ts` is allowlisted with a reason, an audience and a pinned site count (Task 4).
- **Test commands:**
  - API unit: `cd apps/api && npx vitest run <path>`. Never use `pnpm … test -- --run`.
  - Shared: `cd packages/shared && npx vitest run <path>`.
  - Web: `cd apps/web && npx vitest run <path>`.
  - Integration: run `pnpm test-stack up` from the worktree root, then `cd apps/api && npx vitest run --config vitest.integration.config.ts <path>`. Run `pnpm test-stack down` when finished.
- **Typecheck:**
  - `NODE_OPTIONS=--max-old-space-size=12288 pnpm exec tsc --build apps/api/tsconfig.tests.json`;
  - `pnpm --filter @breeze/shared typecheck`;
  - `cd apps/web && pnpm exec astro check`.
- **Commits:** commit after every task. Every message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. The PR body carries `Closes #<W04 sub-issue>`.

## Decisions this plan makes (the spec leaves them open)

| Topic | Decision | Why |
|---|---|---|
| Group key | `sha256(JSON.stringify({ v: 1, type, format, schedule, config: canonical }))`, hex. | The key is stable, fits in a URL and carries a version. When the normalization changes, `v` is bumped, so an open dialog gets a 409 instead of combining a different set. |
| Keys ignored in config | `emailRecipients` (it is resolved as CC), `saveTemplate`, `templateName` (the builder's save-as-template toggle), `type` (never a config field). `name` is a column, so it is never in the key. | These are the fields spec §3.8 says to ignore: recipients and name. |
| Schedule part of the key | Uses `normalizeScheduleConfig(cadence, config.schedule)`, a new export from `@breeze/shared` (Task 1):<ul><li>daily keeps `{time}`;</li><li>weekly keeps `{time, day}`;</li><li>monthly keeps `{time, date}`;</li><li>defaults and clamping are identical to `lastOccurrenceKey`.</li></ul> | Two reports that fire at the same moment group together, and nothing else does. A test proves the normalization never changes `lastOccurrenceKey`. |
| Canonical JSON | <ul><li>Object keys are sorted.</li><li>`null` and `undefined` are dropped.</li><li>Arrays of primitives are treated as sets: sorted and de-duplicated. The exception is `columns`, where order is output order.</li><li>`filterConditions[].id` is dropped, because it is a client-generated React key (`buildFilterId()`).</li><li>Per-type zod defaults are applied first, so explicitly setting a default value equals leaving it out.</li></ul> | A near-duplicate made twice in the builder must group. A different column order must not. |
| Exclusions (first match wins) | <ol><li>partner-owned (`org_id` NULL);</li><li>archived;</li><li>already in a series;</li><li>`one_time`;</li><li>`portal_self_service` — this also covers the org's **managed evidence definition**, which is identified by `isManagedEvidenceType(type) AND portal_self_service`, per `routes/reports/helpers.ts:456-466`;</li><li>`source_ai_agent_schedule_id` set (narrative);</li><li>system principal (`execution_scope_principal_kind = 'system'`);</li><li>**site-restricted execution scope**;</li><li>`assertSeriesTypeSupported` throws — this covers `PARTNER_ONLY_DELIVERY_REPORT_TYPES`, `ai_org_narrative` and `ai_fleet_design`;</li><li>config fails its type's schema;</li><li>`assertSeriesConfigOrgAgnostic` throws.</li></ol>The SQL additionally keeps only orgs of the caller's partner that are `status IN ('active','trial') AND deleted_at IS NULL`. | This is spec §3.8's list plus three safety additions. **one_time:** a one-time report is not a delivery, so combining it is meaningless. **Restricted scope:** adopting captures the owner's unrestricted scope, which would silently widen a site-limited report to every site. **Ineligible org:** the reconciler would archive the adopted child immediately. |
| Which row per org is adopted | Ordered by, in turn:<ol><li>referenced by `service_deliverables.auto_evidence_report_id`;</li><li>newest `last_generated_at` (NULLs last);</li><li>newest `created_at`;</li><li>smallest `id`.</li></ol> | The row that is actually live, and whose evidence chain matters, keeps its id. |
| Other rows in the same org | Archived (`archived_at = now()`, `series_id` stays NULL). Their `mode='add'` recipients are copied onto the adopted row with `ON CONFLICT DO NOTHING`. Deliverables that point at them are **repointed** to the adopted row, which is in the same org and has the same type and normalized config. Past `service_deliverable_evidence` rows are not touched. | "Every customer keeps receiving exactly what they receive today" (§3.8). Future auto-evidence stays live instead of being generated from a hidden archived row. |
| Series definition source | The series takes `type`, `format` and `schedule` from the group. Its `config` is the stored config of the adopted row with the newest `updated_at` (ties broken by smallest id), minus the ignored keys. `recipient_rule` is `{primaryContact:false, roles:[]}`. `internal_cc` is shared CC ∪ `include`. `owner_user_id` and `created_by` are the caller. | These are the spec §3.8 defaults. |
| Recipient mode | Existing rows are already `mode='add'`, the W02 column default. A standalone (non-series) report never holds a `remove` row, so no UPDATE is issued. A test pins that every recipient of an adopted row reads `'add'` afterwards. | The brief's "convert to add" is a no-op by construction. Rewriting a hypothetical `remove` to `add` would *add* a recipient, which is worse than leaving it. |
| CC resolution body | `ccResolution: { include: string[]; drop: string[] }`. Each email is compared trimmed and lower-cased. Every email that is on some rows but not all must appear in exactly one of the two lists. Otherwise the answer is 409 `combine_cc_conflict` with `{ shared, unresolved: [{email, reportIds}], unexpected }`. | The resolution is explicit, so nothing is guessed. `unexpected` catches typos and stale dialogs. |
| Recipient gate | The call needs `reports:export` and fresh MFA, via W02's `callerMaySetEmailRecipients` in `routes/reports/recipientGate.ts`, whenever the combine **adds** a delivery: `include` is non-empty, or `targetMode='all'` with a non-empty internal CC. | A combine that only preserves existing deliveries needs `reports:write` and nothing more. |
| Owner authority | `assertSeriesOwnerEligible(caller)`, then `captureChildExecutionScope(caller, org)` for every adopted org. If any org returns `'no_authority'`, the whole combine is refused with 400 `series_owner_ineligible` and `orgIds`. | An opt-in consolidation must never turn a working report into a `blocked_no_authority` one. |
| Concurrency | The caller's `reportIds` are re-read `FOR UPDATE OF reports`, then the group is re-keyed. A different key, a different id set, or a row that is now in a series or archived gives 409 `combine_group_changed`. | Two combines of one group serialize, and the second writes nothing. |

## Review Focus

These are the five inputs most likely to bite a real MSP that no happy-path test exercises. Each one is pinned by a test in the named task.

1. **Builder twins must group; a changed column order must not.** Two reports saved separately with the same settings differ in several harmless ways:
   - `filterConditions[].id`;
   - key order;
   - `Monday` vs `monday`, and `8:00` vs `08:00`;
   - `emailRecipients`, `saveTemplate` and `templateName`;
   - an explicit default such as `windowDays: 30`.

   They must share one key. A different `columns` order, a different filter value or a different fire time must not. *Pinned in Task 2, Step 1.*
2. **A site-restricted report is never adopted.** Adoption captures the owner's unrestricted scope. If a restricted row were adopted, the customer's report would silently start covering every site. *Pinned in Task 3, Step 1 (exclusion table), and in Task 4's integration fixture (`rRestricted` is untouched).*
3. **Org-specific builder filters outside `filters.siteIds`.** A config can name sites or devices through `legacyFilters.deviceIds`, `sites`, or a `filterConditions` row whose `field` is `siteId`. Such a config is excluded. *Pinned in Task 3, Step 1.* The pin tests W02's `assertSeriesConfigOrgAgnostic` through `combineExclusionReason`. If it goes red, extend W02's function with its own test. Do **not** special-case the shape in combine.
4. **A deliverable's auto-evidence report is an archived duplicate.** The deliverable is repointed to the adopted row, and existing `service_deliverable_evidence` rows keep their `report_id` and `report_run_id`. *Pinned in Task 4, Step 1.*
5. **A stale dialog, or a double-click that goes around the confirm latch.** A second `POST` for the same group returns 409 `combine_group_changed` and writes nothing: no second series, no targets, no rows changed. *Pinned in Task 4, Step 1 (service) and Task 6, Step 1 (dialog refreshes).*

---

## File map

| File | Change | Task |
|---|---|---|
| `packages/shared/src/utils/reportSchedule.ts` | + `normalizeScheduleConfig` | 1 |
| `packages/shared/src/utils/reportSchedule.test.ts` | + describe block | 1 |
| `apps/api/src/services/reportSeries/combineKey.ts` | create (pure) | 2 |
| `apps/api/src/services/reportSeries/combineKey.test.ts` | create | 2 |
| `apps/api/src/services/reportSeries/combinePlan.ts` | create (pure) | 3 |
| `apps/api/src/services/reportSeries/combinePlan.test.ts` | create | 3 |
| `apps/api/src/services/reportSeries/combine.ts` | create (DB) | 4 |
| `apps/api/src/routes/reports/partnerOwnedVisibility.scan.test.ts` | + 4 allowlist entries | 4 |
| `apps/api/src/__tests__/integration/reportSeriesCombine.integration.test.ts` | create (service half in Task 4, route half in Task 5) | 4, 5 |
| `apps/api/src/routes/reports/seriesSchemas.ts` | + `combineSeriesSchema` | 5 |
| `apps/api/src/routes/reports/seriesCombine.ts` (+ `.test.ts`) | create | 5 |
| `apps/api/src/routes/reports/series.ts` | mount `seriesCombineRoutes` first | 5 |
| `apps/api/src/services/mcpCoverage.ts` | + `reports/seriesCombine.ts` exemption | 5 |
| `apps/web/src/components/reports/series/types.ts` | + combine types | 6 |
| `apps/web/src/components/reports/series/CombineDialog.tsx` (+ `.test.tsx`) | create | 6 |
| `apps/web/src/components/reports/series/CombineBanner.tsx` (+ `.test.tsx`) | create | 7 |
| `apps/web/src/components/reports/ReportsList.tsx` | mount banner | 7 |
| `apps/web/src/components/reports/ReportsList.combine.test.tsx` | create | 7 |
| `apps/web/src/locales/{en,de-DE,fr-FR,fr-CA,pt-BR,es-419,it-IT,tr-TR}/reports.json` | + `reports.seriesCombine` | 6 |
| `apps/web/src/lib/__tests__/no-silent-mutations.test.ts` | + `CombineDialog.tsx`, count +1 | 6 |

---

## Preflight (before Task 1; no commit)

- [ ] **P1: Rebase and confirm the W02/W03 contract is on the branch**

```bash
git fetch origin main && git rebase origin/main
ls apps/api/src/services/reportSeries/
grep -rn "export async function reconcileSeries\|export async function captureChildExecutionScope\|export async function assertSeriesOwnerEligible\|export function assertSeriesTypeSupported\|export function assertSeriesConfigOrgAgnostic" apps/api/src/services/reportSeries/
grep -n "export const reportSeriesRoutes" apps/api/src/routes/reports/series.ts
grep -n "export class ReportSeriesError\|export function seriesErrorResponse" apps/api/src/services/reportSeries/errors.ts
grep -n "export function callerMaySetEmailRecipients\|export const RECIPIENTS_NEED_EXPORT_AND_MFA" apps/api/src/routes/reports/recipientGate.ts
grep -rn "reportSeriesOrgTargets = pgTable\|reportSeries = pgTable\|seriesRevision\|archivedAt: timestamp" apps/api/src/db/schema/reports*.ts
grep -n "mode:" apps/api/src/db/schema/reports.ts
ls apps/web/src/components/reports/series/
```

Expected output:

- `reportSeries/` holds `authority.ts errors.ts reconcile.ts recipients.ts targets.ts types.ts validation.ts`.
- The grep finds all five function exports and `reportSeriesRoutes`.
- `errors.ts` exports `ReportSeriesError` and `seriesErrorResponse`.
- `routes/reports/recipientGate.ts` (W02) exports `callerMaySetEmailRecipients` and `RECIPIENTS_NEED_EXPORT_AND_MFA`.
- The schema grep finds `reportSeries`, `reportSeriesOrgTargets`, `seriesRevision`, `archivedAt` and the recipient `mode` column.
- `series/types.ts` exists.

If anything is missing, **stop**: W02 or W03 has not landed.

- [ ] **P2: Confirm the W02 shapes that W04 consumes**

```bash
sed -n '1,80p' apps/api/src/services/reportSeries/errors.ts
grep -n "export function callerMaySetEmailRecipients" -A 6 apps/api/src/routes/reports/recipientGate.ts
grep -n "seriesRevision" apps/api/src/services/reportSeries/reconcile.ts
grep -rn "export type Tx\b\|export type SeriesTx" apps/api/src/services/reportSeries/
```

Expected:

- `ReportSeriesError`'s constructor is `(code: string, status: 400 | 403 | 404 | 409, body?: Record<string, unknown>)`.
- `seriesErrorResponse(c, err)` returns a `Response` for a `ReportSeriesError`, using `err.body` when present and `{ error: code }` otherwise. For any other error it returns `null`.
- `callerMaySetEmailRecipients(auth)` takes only the auth context.
- The reconciler and `seriesChildGate` treat `series_revision = 0` as stale. This is the INDEX's revision sentinel.
- No transaction type is exported.

Handle each difference as follows:

- **`seriesErrorResponse` has a different return contract:** adapt only the three `mapped` lines in Task 5's `seriesCombine.ts`.
- **`callerMaySetEmailRecipients` needs `c` or `permissions`:** pass exactly what W02's signature asks for, at the one call site in Task 5. Leave the mocks in Task 5's route test unchanged.
- **W02 exported a transaction type:** use it in place of the local `Tx`.

- [ ] **P3: Baseline counts used later**

```bash
grep -n "expect(absoluteFiles.length).toBe(" apps/web/src/lib/__tests__/no-silent-mutations.test.ts
python3 -c "import json;print(sorted(json.load(open('apps/web/src/locales/en/reports.json'))['reports'].keys()))"
```

Expected:

- The count literal is 199 at plan time. W01–W03 may have raised it, so note the current value N.
- `reports` has no `seriesCombine` key yet.
- Note any wording W03 used for "multi-org" in the `series*` keys, and reuse it in Task 6's copy.

---

### Task 1: `normalizeScheduleConfig` in `@breeze/shared`

**Files:**
- Modify: `packages/shared/src/utils/reportSchedule.ts`. The function goes right after `lastOccurrenceKey`; `DAY_INDEX` and `parseTime` are already in this file.
- Test: `packages/shared/src/utils/reportSchedule.test.ts`

**Interfaces:**
- Produces: `normalizeScheduleConfig(cadence: ScheduleCadence, cfg: ScheduleConfig): ScheduleConfig`, re-exported through `packages/shared/src/utils/index.ts` (`export * from './reportSchedule'`, already present).

- [ ] **Step 1: Write the failing test.** Append to `reportSchedule.test.ts`, and add `normalizeScheduleConfig` to the existing import line.

```ts
describe('normalizeScheduleConfig', () => {
  it('keeps only the keys the cadence reads, in canonical spelling', () => {
    expect(normalizeScheduleConfig('daily', { time: '8:05', day: 'friday', date: '3' })).toEqual({ time: '08:05' });
    expect(normalizeScheduleConfig('weekly', { time: '08:05', day: 'Friday', date: '3' })).toEqual({ time: '08:05', day: 'friday' });
    expect(normalizeScheduleConfig('monthly', { time: '23:59', day: 'friday', date: '07' })).toEqual({ time: '23:59', date: '7' });
  });

  it('applies exactly the defaults and clamps lastOccurrenceKey applies', () => {
    expect(normalizeScheduleConfig('daily', {})).toEqual({ time: '09:00' });
    expect(normalizeScheduleConfig('daily', { time: '25:00' })).toEqual({ time: '09:00' });
    expect(normalizeScheduleConfig('weekly', {})).toEqual({ time: '09:00', day: 'monday' });
    expect(normalizeScheduleConfig('weekly', { day: 'someday' })).toEqual({ time: '09:00', day: 'monday' });
    expect(normalizeScheduleConfig('monthly', { date: '0' })).toEqual({ time: '09:00', date: '1' });
    expect(normalizeScheduleConfig('monthly', { date: '31' })).toEqual({ time: '09:00', date: '31' });
  });

  it('never changes when a report fires', () => {
    const configs = [
      {}, { time: '8:05' }, { time: '25:00' }, { day: 'Sunday' }, { day: 'nope' },
      { date: '31' }, { date: '0' }, { time: '23:59', day: 'saturday', date: '15' },
    ];
    const instants = ['2026-01-31T12:00:00Z', '2026-02-28T23:30:00Z', '2026-03-29T01:30:00Z', '2026-09-28T08:04:00Z'];
    for (const cadence of ['daily', 'weekly', 'monthly'] as const) {
      for (const cfg of configs) {
        for (const iso of instants) {
          for (const tz of ['UTC', 'Europe/Berlin', 'America/Los_Angeles']) {
            expect(lastOccurrenceKey(new Date(iso), cadence, normalizeScheduleConfig(cadence, cfg), tz))
              .toBe(lastOccurrenceKey(new Date(iso), cadence, cfg, tz));
          }
        }
      }
    }
  });
});
```

- [ ] **Step 2: Run it and confirm it fails.**

Run: `cd packages/shared && npx vitest run src/utils/reportSchedule.test.ts`
Expected: FAIL with `normalizeScheduleConfig is not a function` (or a TS import error).

- [ ] **Step 3: Implement.** Add this below `lastOccurrenceKey` in `reportSchedule.ts`:

```ts
/** Weekday names in DAY_INDEX order (sunday = 0), so DAY_NAMES[i] round-trips. */
const DAY_NAMES = Object.keys(DAY_INDEX);

/**
 * The canonical form of a cadence's schedule detail: only the keys that
 * cadence reads, spelled the one way, with EXACTLY the defaults and clamps
 * `lastOccurrenceKey` applies (09:00; monday; day 1; day-of-month clamped to
 * 1..31). Used by the multi-org Combine key (series W04) so two reports group
 * iff they fire at the same moments — `reportSchedule.test.ts` proves the
 * normalization never changes `lastOccurrenceKey`.
 */
export function normalizeScheduleConfig(cadence: ScheduleCadence, cfg: ScheduleConfig): ScheduleConfig {
  const { hh, mm } = parseTime(cfg.time);
  const time = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  if (cadence === 'daily') return { time };
  if (cadence === 'weekly') {
    const index = DAY_INDEX[(cfg.day ?? 'monday').toLowerCase()] ?? 1;
    return { time, day: DAY_NAMES[index] };
  }
  return { time, date: String(Math.max(1, Math.min(31, Number(cfg.date) || 1))) };
}
```

- [ ] **Step 4: Run the tests and typecheck.**

Run: `cd packages/shared && npx vitest run src/utils/reportSchedule.test.ts && pnpm --filter @breeze/shared typecheck`
Expected: PASS; tsc exits 0.

- [ ] **Step 5: Commit.**

```bash
git add packages/shared/src/utils/reportSchedule.ts packages/shared/src/utils/reportSchedule.test.ts
git commit -m "feat(shared): normalizeScheduleConfig for the multi-org Combine key (W04)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The Combine key (`combineKey.ts`)

**Files:**
- Create: `apps/api/src/services/reportSeries/combineKey.ts`
- Test: `apps/api/src/services/reportSeries/combineKey.test.ts`

**Interfaces:**
- Consumes: `normalizeScheduleConfig` (Task 1); `reportTypeDef` (`services/reportRegistry.ts:353`), which imports only zod and has no db dependency.
- Produces:
  - `type CombineCadence = 'daily' | 'weekly' | 'monthly'`, `type CombineFormat = 'csv' | 'pdf' | 'excel'`;
  - `COMBINE_KEY_VERSION = 1`, `COMBINE_IGNORED_CONFIG_KEYS: ReadonlySet<string>`;
  - `normalizeEmail(value: string): string`;
  - `canonicalize(value: unknown, path?: string): unknown`;
  - `normalizeCombineConfig(type: ReportType, cadence: CombineCadence, config: unknown): { canonical: Record<string, unknown>; emailRecipients: string[] } | null`;
  - `combineGroupKey(parts: { type: ReportType; format: CombineFormat; schedule: CombineCadence; canonicalConfig: Record<string, unknown> }): string` (64 hex chars);
  - `seriesConfigFrom(config: Record<string, unknown>): Record<string, unknown>`.

- [ ] **Step 1: Write the failing test.** This test also pins Review Focus #1.

```ts
import { describe, expect, it } from 'vitest';
import type { ReportType } from '@breeze/shared';
import {
  canonicalize,
  combineGroupKey,
  normalizeCombineConfig,
  normalizeEmail,
  seriesConfigFrom,
  type CombineCadence,
  type CombineFormat,
} from './combineKey';

/** What ReportBuilder.tsx:1451-1480 persists for a legacy builder type. */
const builderConfig = {
  builderType: 'template',
  dataSource: 'alerts',
  columns: ['severity', 'title', 'createdAt'],
  filterConditions: [{ id: 'filter-1a2b', logic: 'and', field: 'severity', operator: 'is', value: 'critical' }],
  groupBy: '',
  aggregation: { type: 'count' },
  chartType: 'table',
  schedule: { time: '08:00', day: 'monday', date: '1' },
  exportFormats: ['pdf'],
  emailRecipients: ['cc@msp.test'],
  saveTemplate: false,
};

function keyOf(
  config: unknown,
  type: ReportType = 'alert_summary',
  cadence: CombineCadence = 'weekly',
  format: CombineFormat = 'pdf',
) {
  const normalized = normalizeCombineConfig(type, cadence, config);
  if (!normalized) throw new Error('config did not normalize');
  return combineGroupKey({ type, format, schedule: cadence, canonicalConfig: normalized.canonical });
}

describe('canonicalize', () => {
  it('sorts keys, drops null/undefined, treats primitive arrays as sets except columns', () => {
    expect(canonicalize({ b: 1, a: null, c: undefined, filters: { osTypes: ['macos', 'windows', 'macos'] }, columns: ['z', 'a'] }))
      .toEqual({ b: 1, columns: ['z', 'a'], filters: { osTypes: ['macos', 'windows'] } });
    expect(JSON.stringify(canonicalize({ b: 1, a: 2 }))).toBe('{"a":2,"b":1}');
  });

  it('drops the client-generated id of filterConditions but keeps their order', () => {
    expect(canonicalize({ filterConditions: [{ id: 'x', field: 'b' }, { id: 'y', field: 'a' }] }, ''))
      .toEqual({ filterConditions: [{ field: 'b' }, { field: 'a' }] });
  });
});

describe('Combine group key (Review Focus #1)', () => {
  it('groups builder twins: id, key order, day case, time padding, recipients and template toggles differ', () => {
    const twin = {
      saveTemplate: true,
      templateName: 'My weekly',
      emailRecipients: ['someone-else@msp.test'],
      schedule: { day: 'Monday', time: '8:00' },
      exportFormats: ['pdf'],
      chartType: 'table',
      aggregation: { type: 'count' },
      groupBy: '',
      filterConditions: [{ value: 'critical', operator: 'is', field: 'severity', logic: 'and', id: 'filter-9z8y' }],
      columns: ['severity', 'title', 'createdAt'],
      dataSource: 'alerts',
      builderType: 'template',
      legacyFilters: null,
    };
    expect(keyOf(twin)).toBe(keyOf(builderConfig));
    expect(keyOf(builderConfig)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('treats an explicit per-type default as equal to leaving it out', () => {
    const posture = { schedule: { time: '07:00', day: 'friday' } };
    expect(keyOf({ ...posture, windowDays: 30, includeCis: true }, 'security_compliance_posture'))
      .toBe(keyOf(posture, 'security_compliance_posture'));
  });

  it('separates a different column order, filter value, fire time, cadence, format or type', () => {
    const base = keyOf(builderConfig);
    expect(keyOf({ ...builderConfig, columns: ['title', 'severity', 'createdAt'] })).not.toBe(base);
    expect(keyOf({ ...builderConfig, filterConditions: [{ ...builderConfig.filterConditions[0], value: 'high' }] })).not.toBe(base);
    expect(keyOf({ ...builderConfig, schedule: { time: '09:00', day: 'monday' } })).not.toBe(base);
    expect(keyOf({ ...builderConfig, schedule: { time: '08:00', day: 'tuesday' } })).not.toBe(base);
    expect(keyOf(builderConfig, 'alert_summary', 'daily')).not.toBe(base);
    expect(keyOf(builderConfig, 'alert_summary', 'weekly', 'csv')).not.toBe(base);
    expect(keyOf(builderConfig, 'device_inventory')).not.toBe(base);
  });

  it('ignores the day of a daily report and the date of a weekly one', () => {
    expect(keyOf({ ...builderConfig, schedule: { time: '08:00', day: 'friday' } }, 'alert_summary', 'daily'))
      .toBe(keyOf(builderConfig, 'alert_summary', 'daily'));
    expect(keyOf({ ...builderConfig, schedule: { time: '08:00', day: 'monday', date: '20' } }))
      .toBe(keyOf(builderConfig));
  });
});

describe('normalizeCombineConfig', () => {
  it('normalizes, de-duplicates and sorts emailRecipients', () => {
    // No surrounding whitespace in stored values: the config schema's email
    // regex (reportConfigSchemas.ts) already refuses it.
    expect(normalizeCombineConfig('alert_summary', 'weekly', { emailRecipients: ['B@msp.test', 'b@msp.test', 'a@msp.test'] })?.emailRecipients)
      .toEqual(['a@msp.test', 'b@msp.test']);
    expect(normalizeEmail('  Ops@MSP.test ')).toBe('ops@msp.test');
  });

  it('returns null for a config its type schema rejects, or a non-object', () => {
    expect(normalizeCombineConfig('alert_summary', 'weekly', { schedule: { time: 'nope' } })).toBeNull();
    expect(normalizeCombineConfig('alert_summary', 'weekly', null)).toBeNull();
    expect(normalizeCombineConfig('alert_summary', 'weekly', ['x'])).toBeNull();
  });
});

describe('seriesConfigFrom', () => {
  it('keeps the stored config minus the ignored keys (no defaults added)', () => {
    expect(seriesConfigFrom(builderConfig)).toEqual({
      builderType: 'template', dataSource: 'alerts', columns: ['severity', 'title', 'createdAt'],
      filterConditions: builderConfig.filterConditions, groupBy: '', aggregation: { type: 'count' },
      chartType: 'table', schedule: builderConfig.schedule, exportFormats: ['pdf'],
    });
  });
});
```

- [ ] **Step 2: Run it and confirm it fails.**

Run: `cd apps/api && npx vitest run src/services/reportSeries/combineKey.test.ts`
Expected: FAIL with `Failed to resolve import "./combineKey"`.

- [ ] **Step 3: Implement `combineKey.ts`.**

```ts
/**
 * Multi-org report series W04 (Combine) — what "near-identical" means.
 *
 * Two org-owned definitions are combinable when they would produce the same
 * artifact for their own org at the same moments: same `type`, `format`,
 * `schedule` and NORMALIZED config (spec §3.8). This module is the only
 * definition of that normalization; the candidate list and the combine
 * transaction both key rows through it, so the key a dialog showed is the key
 * the server re-derives under lock.
 *
 * Pure. `reportRegistry` value-imports zod schemas only (see its header), so
 * no db module enters this graph.
 */
import { createHash } from 'node:crypto';
import { normalizeScheduleConfig, type ReportType, type ScheduleConfig } from '@breeze/shared';
import { reportTypeDef } from '../reportRegistry';

export type CombineCadence = 'daily' | 'weekly' | 'monthly';
export type CombineFormat = 'csv' | 'pdf' | 'excel';

/** Bump whenever the normalization changes meaning: a dialog opened against the
 *  old key then gets 409 combine_group_changed instead of combining a
 *  different set of rows than it showed. */
export const COMBINE_KEY_VERSION = 1;

/**
 * Config keys that are NOT part of the key:
 *  - `emailRecipients` — delivery; the shared ones become the series internal
 *    CC and the rest must be resolved by the user (spec §3.8).
 *  - `saveTemplate`, `templateName` — the builder's save-as-template toggle;
 *    they change nothing about the artifact.
 *  - `type` — never a config field (`parseStoredReportConfig` drops it); a
 *    legacy row still carrying one must not split a group.
 * The report `name` is a column, never config, so it is never in the key.
 */
export const COMBINE_IGNORED_CONFIG_KEYS: ReadonlySet<string> = new Set([
  'emailRecipients',
  'saveTemplate',
  'templateName',
  'type',
]);

/** Arrays whose order IS output order (the builder's column order). Every other
 *  array of primitives is a set (os types, severities, statuses, countries). */
const ORDERED_ARRAY_PATHS: ReadonlySet<string> = new Set(['columns']);

/** Arrays whose object elements carry a client-generated React key `id`
 *  (ReportBuilder's `buildFilterId()`): two identical filters saved separately
 *  never share it. Element ORDER is kept — the and/or chain reads in order. */
const CLIENT_ID_ARRAY_PATHS: ReadonlySet<string> = new Set(['filterConditions']);

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function isPrimitive(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/**
 * Stable canonical form: object keys sorted (code-unit order); `null` and
 * `undefined` absent; arrays of primitives de-duplicated and sorted by their
 * JSON text unless listed in ORDERED_ARRAY_PATHS; object elements of
 * CLIENT_ID_ARRAY_PATHS lose `id`. `path` is the dotted key path from the
 * config root (`filters.osTypes`), `[]` marking array elements.
 */
export function canonicalize(value: unknown, path = ''): unknown {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) {
    const items = value
      .map((item) => {
        if (CLIENT_ID_ARRAY_PATHS.has(path) && item !== null && typeof item === 'object' && !Array.isArray(item)) {
          const { id: _clientKey, ...rest } = item as Record<string, unknown>;
          return canonicalize(rest, `${path}[]`);
        }
        return canonicalize(item, `${path}[]`);
      })
      .filter((item) => item !== undefined);
    if (!ORDERED_ARRAY_PATHS.has(path) && items.every(isPrimitive)) {
      return [...new Set(items.map((item) => JSON.stringify(item)))]
        .sort()
        .map((text) => JSON.parse(text) as unknown);
    }
    return items;
  }
  if (typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const child = canonicalize(source[key], path ? `${path}.${key}` : key);
      if (child !== undefined) out[key] = child;
    }
    return out;
  }
  return value;
}

export interface NormalizedCombineConfig {
  canonical: Record<string, unknown>;
  /** Trimmed, lower-cased, de-duplicated, sorted. */
  emailRecipients: string[];
}

/**
 * Parse `config` with its TYPE's own schema (defaults applied, so an explicit
 * default equals an omitted one), drop the ignored keys, replace `schedule`
 * with its canonical cadence form, canonicalize. `null` when the stored config
 * no longer passes its type's schema — such a row is not combinable.
 */
export function normalizeCombineConfig(
  type: ReportType,
  cadence: CombineCadence,
  config: unknown,
): NormalizedCombineConfig | null {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) return null;
  const parsed = reportTypeDef(type).configSchema.safeParse(config);
  if (!parsed.success) return null;
  const withDefaults = parsed.data;

  const keyed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(withDefaults)) {
    if (!COMBINE_IGNORED_CONFIG_KEYS.has(key) && key !== 'schedule') keyed[key] = value;
  }
  const rawSchedule = withDefaults.schedule;
  keyed.schedule = normalizeScheduleConfig(
    cadence,
    rawSchedule !== null && typeof rawSchedule === 'object' ? (rawSchedule as ScheduleConfig) : {},
  );

  const recipients = Array.isArray(withDefaults.emailRecipients)
    ? withDefaults.emailRecipients.filter((r): r is string => typeof r === 'string')
    : [];
  return {
    canonical: canonicalize(keyed) as Record<string, unknown>,
    emailRecipients: [...new Set(recipients.map(normalizeEmail))].filter((r) => r.length > 0).sort(),
  };
}

export function combineGroupKey(parts: {
  type: ReportType;
  format: CombineFormat;
  schedule: CombineCadence;
  canonicalConfig: Record<string, unknown>;
}): string {
  const text = JSON.stringify({
    v: COMBINE_KEY_VERSION,
    type: parts.type,
    format: parts.format,
    schedule: parts.schedule,
    config: parts.canonicalConfig,
  });
  return createHash('sha256').update(text).digest('hex');
}

/** The series definition's `config`: a stored row config (NOT canonical, no
 *  defaults injected — mirrors `parseStoredReportConfig`'s "keys the caller
 *  sent" rule) minus the ignored keys. The internal CC travels in
 *  `report_series.internal_cc`, never in config. */
export function seriesConfigFrom(config: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(config).filter(([key]) => !COMBINE_IGNORED_CONFIG_KEYS.has(key)));
}
```

- [ ] **Step 4: Run the tests.**

Run: `cd apps/api && npx vitest run src/services/reportSeries/combineKey.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit.**

```bash
git add apps/api/src/services/reportSeries/combineKey.ts apps/api/src/services/reportSeries/combineKey.test.ts
git commit -m "feat(reports): Combine group key and config normalization (series W04)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Exclusions, grouping, adoption and CC (`combinePlan.ts`)

**Files:**
- Create: `apps/api/src/services/reportSeries/combinePlan.ts`
- Test: `apps/api/src/services/reportSeries/combinePlan.test.ts`

**Interfaces:**
- Consumes:
  - Task 2's exports;
  - W02 `assertSeriesTypeSupported(type: string): void` and `assertSeriesConfigOrgAgnostic(config: unknown): void` from `./validation`, and `ReportSeriesError` from `./errors`.
- Produces (all exported):
  - `CombineSourceRow`, `EligibleCombineRow`, `KeyedCombineRow`, `CombineExclusion`;
  - `keyCombineRow(row)`, `combineExclusionReason(row): CombineExclusion | null`;
  - `CombineRowGroup`, `groupCombineRows(rows): CombineRowGroup[]`;
  - `PlannedCombineOrg`, `PlannedCombineGroup`, `planGroupAdoption(group, deliverableLinkedReportIds: ReadonlySet<string>): PlannedCombineGroup`;
  - `CcSplit`, `splitCombineCc(group: { rows: readonly KeyedCombineRow[] }): CcSplit`;
  - `CcResolution`, `resolveCombineCc(split: CcSplit, resolution: CcResolution)`;
  - `MAX_INTERNAL_CC = 50`;
  - `class CombineError extends ReportSeriesError`, which narrows `code` to the Combine codes and requires `body`;
  - the DTOs `CombineContactRecipient`, `CombineCandidateRow`, `CombineCandidateOrg`, `CombineCandidateGroup`, and `toCandidateGroup(plan, recipientsByReport, linked)`.

- [ ] **Step 1: Write the failing test.** This pins Review Focus #2 and #3, and the exclusion list from spec §5 W04.

```ts
import { describe, expect, it } from 'vitest';
import { BUSINESS_REPORT_TYPES } from '@breeze/shared';
import { INTERNAL_REPORT_TYPES, PARTNER_ONLY_DELIVERY_REPORT_TYPES } from '../../routes/reports/schemas';
import {
  combineExclusionReason,
  groupCombineRows,
  planGroupAdoption,
  resolveCombineCc,
  splitCombineCc,
  toCandidateGroup,
  type CombineSourceRow,
} from './combinePlan';

const SITE = '5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a5a';
const CONFIG = {
  dataSource: 'alerts',
  columns: ['severity', 'title'],
  schedule: { time: '08:00', day: 'monday' },
  emailRecipients: ['cc@msp.test'],
};

let seq = 0;
function row(over: Partial<CombineSourceRow> = {}): CombineSourceRow {
  seq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    orgId: 'org-a',
    orgName: 'Acme',
    name: 'Weekly alerts',
    type: 'alert_summary',
    format: 'pdf',
    schedule: 'weekly',
    config: CONFIG,
    lastGeneratedAt: null,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    updatedAt: new Date('2026-09-01T00:00:00Z'),
    portalSelfService: false,
    sourceAiAgentScheduleId: null,
    executionScopeKind: 'unrestricted',
    executionScopePrincipalKind: 'user',
    seriesId: null,
    archivedAt: null,
    ...over,
  };
}

describe('combineExclusionReason — spec §5 W04 exclusion list', () => {
  it.each([
    ['partner_owned', { orgId: null }],
    ['archived', { archivedAt: new Date() }],
    ['in_series', { seriesId: '11111111-1111-4111-8111-111111111111' }],
    ['one_time', { schedule: 'one_time' as const }],
    ['portal_self_service', { portalSelfService: true }],
    // The managed evidence definition is portal_self_service by construction.
    ['portal_self_service', { type: 'threat_detection_review' as const, portalSelfService: true }],
    ['narrative', { sourceAiAgentScheduleId: '22222222-2222-4222-8222-222222222222' }],
    ['system_managed', { executionScopePrincipalKind: 'system' }],
    // Review Focus #2 — adoption would widen a site-limited report to every site.
    ['site_restricted_scope', { executionScopeKind: 'restricted' }],
    ['config_invalid', { config: { schedule: { time: 'nope' } } }],
  ] as const)('%s', (reason, over) => {
    expect(combineExclusionReason(row(over as Partial<CombineSourceRow>))).toBe(reason);
  });

  it('excludes every internal and partner-only-delivery (business) type', () => {
    const types = new Set<string>([...INTERNAL_REPORT_TYPES, ...PARTNER_ONLY_DELIVERY_REPORT_TYPES, ...BUSINESS_REPORT_TYPES]);
    for (const type of types) {
      expect(combineExclusionReason(row({ type: type as CombineSourceRow['type'], config: {} })), type).not.toBeNull();
    }
  });

  // Review Focus #3 — every way a builder config can name a site or device.
  it.each([
    ['filters.siteIds', { filters: { siteIds: [SITE] } }],
    ['filters.deviceIds', { filters: { deviceIds: [SITE] } }],
    ['sites', { sites: [SITE] }],
    ['legacyFilters.deviceIds', { legacyFilters: { deviceIds: [SITE] } }],
    ['filterConditions siteId', { filterConditions: [{ id: 'f1', logic: 'and', field: 'siteId', operator: 'is', value: SITE }] }],
  ])('config_org_specific: %s', (_label, extra) => {
    expect(combineExclusionReason(row({ config: { ...CONFIG, ...extra } }))).toBe('config_org_specific');
  });

  it('accepts an ordinary org-owned weekly report', () => {
    expect(combineExclusionReason(row())).toBeNull();
  });
});

describe('groupCombineRows', () => {
  it('groups across at least two orgs and ignores excluded rows when counting orgs', () => {
    const a = row({ orgId: 'org-a', orgName: 'Acme' });
    const b = row({ orgId: 'org-b', orgName: 'Bravo', config: { ...CONFIG, emailRecipients: ['CC@msp.test'] } });
    const bPortal = row({ orgId: 'org-c', orgName: 'Charlie', portalSelfService: true });
    const groups = groupCombineRows([a, b, bPortal]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.rows.map((k) => k.row.id).sort()).toEqual([a.id, b.id].sort());
  });

  it('never groups two duplicates inside ONE org', () => {
    expect(groupCombineRows([row({ orgId: 'org-a' }), row({ orgId: 'org-a' })])).toEqual([]);
  });
});

describe('planGroupAdoption', () => {
  it('adopts the deliverable-linked row, then newest run, then newest created, then smallest id', () => {
    const linked = row({ orgId: 'org-a', lastGeneratedAt: null });
    const newer = row({ orgId: 'org-a', lastGeneratedAt: new Date('2026-09-20T00:00:00Z') });
    const older = row({ orgId: 'org-a', lastGeneratedAt: new Date('2026-09-01T00:00:00Z') });
    const bNever = row({ orgId: 'org-b', orgName: 'Bravo', lastGeneratedAt: null, createdAt: new Date('2026-09-02T00:00:00Z') });
    const bNeverOlder = row({ orgId: 'org-b', orgName: 'Bravo', lastGeneratedAt: null, createdAt: new Date('2026-08-01T00:00:00Z') });
    const [group] = groupCombineRows([older, newer, linked, bNeverOlder, bNever]);
    const plan = planGroupAdoption(group!, new Set([linked.id]));
    const acme = plan.orgs.find((o) => o.orgId === 'org-a')!;
    expect(acme.adopt.id).toBe(linked.id);
    expect(acme.archive.map((r) => r.id)).toEqual([newer.id, older.id]);
    expect(plan.orgs.find((o) => o.orgId === 'org-b')!.adopt.id).toBe(bNever.id);

    const unlinked = planGroupAdoption(group!, new Set());
    expect(unlinked.orgs.find((o) => o.orgId === 'org-a')!.adopt.id).toBe(newer.id);
  });

  it('sorts orgs by name, takes the series config from the newest-updated adopted row, suggests the most common name', () => {
    // filterConditions ids are not part of the key but ARE kept in the stored
    // config, so they identify which row the series config was taken from.
    const fc = (id: string) => [{ id, logic: 'and', field: 'severity', operator: 'is', value: 'critical' }];
    const a = row({ orgId: 'org-a', orgName: 'Zulu', name: 'Weekly alerts', config: { ...CONFIG, filterConditions: fc('f-zulu') }, updatedAt: new Date('2026-09-10T00:00:00Z') });
    const b = row({ orgId: 'org-b', orgName: 'Alpha', name: 'Alerts', config: { ...CONFIG, filterConditions: fc('f-alpha') }, updatedAt: new Date('2026-09-11T00:00:00Z') });
    const c = row({ orgId: 'org-c', orgName: 'Mike', name: 'Weekly alerts', config: { ...CONFIG, filterConditions: fc('f-mike') } });
    const [group] = groupCombineRows([a, b, c]);
    const plan = planGroupAdoption(group!, new Set());
    expect(plan.orgs.map((o) => o.orgName)).toEqual(['Alpha', 'Mike', 'Zulu']);
    expect(plan.seriesConfig).toEqual({
      dataSource: 'alerts', columns: ['severity', 'title'], schedule: { time: '08:00', day: 'monday' }, filterConditions: fc('f-alpha'),
    });
    expect(plan.suggestedName).toBe('Weekly alerts');
  });
});

describe('CC split and resolution', () => {
  const a1 = row({ orgId: 'org-a', config: { ...CONFIG, emailRecipients: ['cc@msp.test', 'extra@msp.test'] } });
  const a2 = row({ orgId: 'org-a', config: { ...CONFIG, emailRecipients: ['cc@msp.test'] } });
  const b1 = row({ orgId: 'org-b', orgName: 'Bravo', config: { ...CONFIG, emailRecipients: ['CC@MSP.test'] } });
  const [group] = groupCombineRows([a1, a2, b1]);

  it('treats case as the same address; lists the rest with their reports', () => {
    expect(splitCombineCc(group!)).toEqual({
      shared: ['cc@msp.test'],
      conflicting: [{ email: 'extra@msp.test', reportIds: [a1.id] }],
    });
  });

  it('refuses an unresolved, unknown or doubly-resolved address', () => {
    const split = splitCombineCc(group!);
    expect(resolveCombineCc(split, { include: [], drop: [] })).toEqual({
      ok: false, shared: ['cc@msp.test'], unresolved: [{ email: 'extra@msp.test', reportIds: [a1.id] }], unexpected: [],
    });
    expect(resolveCombineCc(split, { include: ['extra@msp.test', 'typo@msp.test'], drop: [] }))
      .toMatchObject({ ok: false, unexpected: ['typo@msp.test'] });
    expect(resolveCombineCc(split, { include: ['extra@msp.test'], drop: ['EXTRA@msp.test'] }))
      .toMatchObject({ ok: false, unexpected: ['extra@msp.test'] });
  });

  it('include adds to the internal CC; drop removes it', () => {
    const split = splitCombineCc(group!);
    expect(resolveCombineCc(split, { include: [' Extra@MSP.test'], drop: [] }))
      .toEqual({ ok: true, internalCc: ['cc@msp.test', 'extra@msp.test'], addedCc: ['extra@msp.test'] });
    expect(resolveCombineCc(split, { include: [], drop: ['extra@msp.test'] }))
      .toEqual({ ok: true, internalCc: ['cc@msp.test'], addedCc: [] });
  });

  it('shapes the candidate DTO the dialog renders', () => {
    const plan = planGroupAdoption(group!, new Set([a2.id]));
    const dto = toCandidateGroup(
      plan,
      new Map([[a2.id, [{ contactId: 'c-1', name: 'Ann', email: 'ann@acme.test' }]]]),
      new Set([a2.id]),
    );
    expect(dto.orgs[0]!.rows[0]).toMatchObject({ reportId: a2.id, action: 'adopt', deliverableLinked: true });
    expect(dto.orgs[0]!.rows[1]).toMatchObject({ reportId: a1.id, action: 'archive', emailRecipients: ['cc@msp.test', 'extra@msp.test'] });
    expect(dto.orgs[0]!.rows[0]!.contactRecipients).toEqual([{ contactId: 'c-1', name: 'Ann', email: 'ann@acme.test' }]);
    expect(dto.sharedCc).toEqual(['cc@msp.test']);
    expect(dto.groupKey).toBe(plan.groupKey);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails.**

Run: `cd apps/api && npx vitest run src/services/reportSeries/combinePlan.test.ts`
Expected: FAIL with `Failed to resolve import "./combinePlan"`.

- [ ] **Step 3: Implement `combinePlan.ts`.**

```ts
/**
 * Multi-org report series W04 (Combine) — the pure planning half: which rows
 * are combinable, how they group, which row per org is adopted in place, and
 * how the internal CC is resolved (spec §3.8). `combine.ts` supplies the rows
 * and performs the writes; nothing here touches the database.
 */
import type { ReportType } from '@breeze/shared';
import {
  combineGroupKey,
  normalizeCombineConfig,
  normalizeEmail,
  seriesConfigFrom,
  type CombineCadence,
  type CombineFormat,
} from './combineKey';
import { ReportSeriesError } from './errors';
import { assertSeriesConfigOrgAgnostic, assertSeriesTypeSupported } from './validation';

/** One `reports` row as `combine.ts` selects it (org name joined in). */
export interface CombineSourceRow {
  id: string;
  orgId: string | null;
  orgName: string;
  name: string;
  type: ReportType;
  format: CombineFormat;
  schedule: CombineCadence | 'one_time';
  config: unknown;
  lastGeneratedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  portalSelfService: boolean;
  sourceAiAgentScheduleId: string | null;
  executionScopeKind: string | null;
  executionScopePrincipalKind: string | null;
  seriesId: string | null;
  archivedAt: Date | null;
}

export type EligibleCombineRow = CombineSourceRow & { orgId: string; schedule: CombineCadence };

export type CombineExclusion =
  | 'partner_owned'
  | 'archived'
  | 'in_series'
  | 'one_time'
  | 'portal_self_service'
  | 'narrative'
  | 'system_managed'
  | 'site_restricted_scope'
  | 'type_unsupported'
  | 'config_invalid'
  | 'config_org_specific';

export interface KeyedCombineRow {
  row: EligibleCombineRow;
  groupKey: string;
  emailRecipients: string[];
}

/**
 * First matching exclusion wins. The row-level signals come first; the TYPE
 * and CONFIG gates reuse W02's series validators so Combine can never adopt a
 * row into a series that `POST /reports/series` would have refused.
 *  - portal_self_service also covers the org's managed evidence definition
 *    (`isManagedEvidenceType(type) AND portal_self_service`,
 *    routes/reports/helpers.ts isSystemManagedReportDefinition).
 *  - site_restricted_scope: adoption captures the owner's unrestricted scope;
 *    a restricted row would silently start covering every site.
 */
export function keyCombineRow(
  row: CombineSourceRow,
): { ok: true; keyed: KeyedCombineRow } | { ok: false; reason: CombineExclusion } {
  if (row.orgId === null) return { ok: false, reason: 'partner_owned' };
  if (row.archivedAt !== null) return { ok: false, reason: 'archived' };
  if (row.seriesId !== null) return { ok: false, reason: 'in_series' };
  if (row.schedule === 'one_time') return { ok: false, reason: 'one_time' };
  if (row.portalSelfService) return { ok: false, reason: 'portal_self_service' };
  if (row.sourceAiAgentScheduleId !== null) return { ok: false, reason: 'narrative' };
  if (row.executionScopePrincipalKind === 'system') return { ok: false, reason: 'system_managed' };
  if (row.executionScopeKind === 'restricted') return { ok: false, reason: 'site_restricted_scope' };
  try {
    assertSeriesTypeSupported(row.type);
  } catch {
    return { ok: false, reason: 'type_unsupported' };
  }
  const normalized = normalizeCombineConfig(row.type, row.schedule, row.config);
  if (normalized === null) return { ok: false, reason: 'config_invalid' };
  try {
    assertSeriesConfigOrgAgnostic(row.config);
  } catch {
    return { ok: false, reason: 'config_org_specific' };
  }
  const eligible = row as EligibleCombineRow;
  return {
    ok: true,
    keyed: {
      row: eligible,
      groupKey: combineGroupKey({
        type: eligible.type,
        format: eligible.format,
        schedule: eligible.schedule,
        canonicalConfig: normalized.canonical,
      }),
      emailRecipients: normalized.emailRecipients,
    },
  };
}

export function combineExclusionReason(row: CombineSourceRow): CombineExclusion | null {
  const result = keyCombineRow(row);
  return result.ok ? null : result.reason;
}

const compareIds = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export interface CombineRowGroup {
  groupKey: string;
  type: ReportType;
  format: CombineFormat;
  schedule: CombineCadence;
  /** Sorted by report id. */
  rows: KeyedCombineRow[];
}

/** Eligible rows grouped by key; only groups spanning >= 2 distinct orgs. */
export function groupCombineRows(rows: readonly CombineSourceRow[]): CombineRowGroup[] {
  const byKey = new Map<string, KeyedCombineRow[]>();
  for (const candidate of rows) {
    const result = keyCombineRow(candidate);
    if (!result.ok) continue;
    const list = byKey.get(result.keyed.groupKey) ?? [];
    list.push(result.keyed);
    byKey.set(result.keyed.groupKey, list);
  }
  const groups: CombineRowGroup[] = [];
  for (const [groupKey, keyed] of byKey) {
    if (new Set(keyed.map((k) => k.row.orgId)).size < 2) continue;
    keyed.sort((a, b) => compareIds(a.row.id, b.row.id));
    const first = keyed[0]!.row;
    groups.push({ groupKey, type: first.type, format: first.format, schedule: first.schedule, rows: keyed });
  }
  return groups.sort((a, b) => compareIds(a.groupKey, b.groupKey));
}

export interface PlannedCombineOrg {
  orgId: string;
  orgName: string;
  adopt: EligibleCombineRow;
  archive: EligibleCombineRow[];
}

export interface PlannedCombineGroup extends CombineRowGroup {
  /** Sorted by org name (en), then org id. */
  orgs: PlannedCombineOrg[];
  seriesConfig: Record<string, unknown>;
  suggestedName: string;
}

/** Adoption priority: deliverable-linked, newest run (NULL last), newest
 *  created, smallest id. */
function adoptionOrder(linked: ReadonlySet<string>) {
  return (a: EligibleCombineRow, b: EligibleCombineRow): number => {
    const la = linked.has(a.id) ? 0 : 1;
    const lb = linked.has(b.id) ? 0 : 1;
    if (la !== lb) return la - lb;
    const ga = a.lastGeneratedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
    const gb = b.lastGeneratedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
    if (ga !== gb) return gb > ga ? 1 : -1;
    const ca = a.createdAt.getTime();
    const cb = b.createdAt.getTime();
    if (ca !== cb) return cb - ca;
    return compareIds(a.id, b.id);
  };
}

function suggestName(names: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'en'))[0]![0];
}

export function planGroupAdoption(
  group: CombineRowGroup,
  deliverableLinkedReportIds: ReadonlySet<string>,
): PlannedCombineGroup {
  const byOrg = new Map<string, EligibleCombineRow[]>();
  for (const { row } of group.rows) byOrg.set(row.orgId, [...(byOrg.get(row.orgId) ?? []), row]);
  const order = adoptionOrder(deliverableLinkedReportIds);
  const orgs = [...byOrg.entries()]
    .map(([orgId, orgRows]): PlannedCombineOrg => {
      const [adopt, ...archive] = [...orgRows].sort(order);
      return { orgId, orgName: adopt!.orgName, adopt: adopt!, archive };
    })
    .sort((a, b) => a.orgName.localeCompare(b.orgName, 'en') || compareIds(a.orgId, b.orgId));
  const source = orgs
    .map((o) => o.adopt)
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || compareIds(a.id, b.id))[0]!;
  return {
    ...group,
    orgs,
    seriesConfig: seriesConfigFrom(source.config as Record<string, unknown>),
    suggestedName: suggestName(group.rows.map((k) => k.row.name)),
  };
}

export interface CcSplit {
  /** On EVERY row of the group; becomes the series internal CC. Sorted. */
  shared: string[];
  /** On some rows only; must be resolved. Sorted by email; reportIds sorted. */
  conflicting: { email: string; reportIds: string[] }[];
}

export function splitCombineCc(group: { rows: readonly KeyedCombineRow[] }): CcSplit {
  const holders = new Map<string, string[]>();
  for (const { row, emailRecipients } of group.rows) {
    for (const email of emailRecipients) holders.set(email, [...(holders.get(email) ?? []), row.id]);
  }
  const shared: string[] = [];
  const conflicting: CcSplit['conflicting'] = [];
  for (const [email, reportIds] of [...holders.entries()].sort((a, b) => compareIds(a[0], b[0]))) {
    if (reportIds.length === group.rows.length) shared.push(email);
    else conflicting.push({ email, reportIds: [...reportIds].sort(compareIds) });
  }
  return { shared, conflicting };
}

export interface CcResolution {
  include: readonly string[];
  drop: readonly string[];
}

export type CcResolveResult =
  | { ok: true; internalCc: string[]; addedCc: string[] }
  | { ok: false; shared: string[]; unresolved: CcSplit['conflicting']; unexpected: string[] };

/** Every conflicting address must be in exactly one of include/drop, and
 *  nothing else may be named (a typo or a stale dialog). */
export function resolveCombineCc(split: CcSplit, resolution: CcResolution): CcResolveResult {
  const include = new Set(resolution.include.map(normalizeEmail));
  const drop = new Set(resolution.drop.map(normalizeEmail));
  const conflictEmails = new Set(split.conflicting.map((c) => c.email));
  const unexpected = [...new Set([...include, ...drop])]
    .filter((email) => !conflictEmails.has(email) || (include.has(email) && drop.has(email)))
    .sort(compareIds);
  const unresolved = split.conflicting.filter((c) => !include.has(c.email) && !drop.has(c.email));
  if (unresolved.length > 0 || unexpected.length > 0) {
    return { ok: false, shared: split.shared, unresolved, unexpected };
  }
  const addedCc = split.conflicting.filter((c) => include.has(c.email)).map((c) => c.email);
  return { ok: true, internalCc: [...split.shared, ...addedCc].sort(compareIds), addedCc };
}

/** `legacyReportConfigSchema.emailRecipients` caps a config at 50 addresses;
 *  every child receives the internal CC as `config.emailRecipients`. */
export const MAX_INTERNAL_CC = 50;

export type CombineErrorCode =
  | 'combine_group_changed'
  | 'combine_cc_conflict'
  | 'combine_cc_too_many'
  | 'recipients_need_export_and_mfa'
  | 'series_owner_ineligible';

/**
 * A Combine refusal. A subclass of W02's ReportSeriesError, never a parallel
 * class: routes map it through the one `seriesErrorResponse`, which answers
 * `status` with `body` verbatim. It narrows `code` to the Combine codes and
 * makes `body` required, because the dialog reads its fields (`unresolved`,
 * `orgIds`).
 */
export class CombineError extends ReportSeriesError {
  declare readonly code: CombineErrorCode;
  declare readonly body: Record<string, unknown>;

  constructor(code: CombineErrorCode, status: 400 | 403 | 409, body: Record<string, unknown>) {
    super(code, status, body);
    this.name = 'CombineError';
  }
}

export interface CombineContactRecipient {
  contactId: string;
  name: string | null;
  email: string | null;
}

export interface CombineCandidateRow {
  reportId: string;
  name: string;
  lastGeneratedAt: string | null;
  action: 'adopt' | 'archive';
  deliverableLinked: boolean;
  contactRecipients: CombineContactRecipient[];
  emailRecipients: string[];
}

export interface CombineCandidateOrg {
  orgId: string;
  orgName: string;
  rows: CombineCandidateRow[];
}

export interface CombineCandidateGroup {
  groupKey: string;
  type: ReportType;
  format: CombineFormat;
  schedule: CombineCadence;
  suggestedName: string;
  orgs: CombineCandidateOrg[];
  sharedCc: string[];
  conflictingCc: CcSplit['conflicting'];
}

export function toCandidateGroup(
  plan: PlannedCombineGroup,
  recipientsByReport: ReadonlyMap<string, CombineContactRecipient[]>,
  linked: ReadonlySet<string>,
): CombineCandidateGroup {
  const split = splitCombineCc(plan);
  const emails = new Map(plan.rows.map((k) => [k.row.id, k.emailRecipients]));
  const toRow = (row: EligibleCombineRow, action: 'adopt' | 'archive'): CombineCandidateRow => ({
    reportId: row.id,
    name: row.name,
    lastGeneratedAt: row.lastGeneratedAt ? row.lastGeneratedAt.toISOString() : null,
    action,
    deliverableLinked: linked.has(row.id),
    contactRecipients: recipientsByReport.get(row.id) ?? [],
    emailRecipients: emails.get(row.id) ?? [],
  });
  return {
    groupKey: plan.groupKey,
    type: plan.type,
    format: plan.format,
    schedule: plan.schedule,
    suggestedName: plan.suggestedName,
    orgs: plan.orgs.map((o) => ({
      orgId: o.orgId,
      orgName: o.orgName,
      rows: [toRow(o.adopt, 'adopt'), ...o.archive.map((r) => toRow(r, 'archive'))],
    })),
    sharedCc: split.shared,
    conflictingCc: split.conflicting,
  };
}
```

- [ ] **Step 4: Run the tests.**

Run: `cd apps/api && npx vitest run src/services/reportSeries/combinePlan.test.ts`

Expected: PASS.

The two Review Focus #3 rows, `legacyFilters.deviceIds` and `filterConditions siteId`, pin W02's `assertSeriesConfigOrgAgnostic`. If either is red:

1. Extend that function in `validation.ts` to reject:
   - any `siteIds` / `deviceIds` / `groupIds` / `sites` / `siteId` / `deviceId` / `groupId` key that selects something, at any depth;
   - a `filterConditions` element whose `field` is one of `siteId`, `deviceId`, `groupId`.
2. Add the same two cases to W02's `validation.test.ts`.
3. Re-run both files.

Never special-case these shapes in `combinePlan.ts`: the series create route must refuse exactly what Combine refuses.

- [ ] **Step 5: Commit.**

```bash
git add apps/api/src/services/reportSeries/combinePlan.ts apps/api/src/services/reportSeries/combinePlan.test.ts
# plus validation.ts / validation.test.ts if Step 4 required the W02 extension
git commit -m "feat(reports): Combine exclusions, grouping, adoption and CC resolution (series W04)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The DB service (`combine.ts`) on real Postgres

**Files:**
- Create: `apps/api/src/services/reportSeries/combine.ts`
- Modify: `apps/api/src/routes/reports/partnerOwnedVisibility.scan.test.ts`. Add one `AUD_*` constant next to the others (around line 190) and four `SITE_ALLOWLIST` entries.
- Test: `apps/api/src/__tests__/integration/reportSeriesCombine.integration.test.ts` (created in this task)

**Interfaces:**
- Consumes:
  - from Task 3: `groupCombineRows`, `planGroupAdoption`, `splitCombineCc`, `resolveCombineCc`, `toCandidateGroup`, `CombineError`, `MAX_INTERNAL_CC`;
  - from W02: `assertSeriesTypeSupported`, `assertSeriesConfigOrgAgnostic`, `assertSeriesOwnerEligible(userId, partnerId, tx)`, `captureChildExecutionScope(ownerUserId, orgId, tx)` and `reconcileSeries(seriesId, tx)`.
- Produces:
  - `findCombineCandidates(partnerId: string, tx: Tx): Promise<CombineCandidateGroup[]>`;
  - `combineIntoSeries(input: CombineInput, auth: CombineAuth, tx: Tx): Promise<CombineResult>`;
  - `interface CombineInput { groupKey: string; reportIds: string[]; name: string; targetMode: 'selected' | 'all'; ccResolution: CcResolution; callerMaySetEmailRecipients: boolean }`;
  - `type CombineAuth = Pick<AuthContext, 'scope' | 'partnerId' | 'partnerOrgAccess'> & { user: { id: string } }`;
  - `interface CombineResult { seriesId: string; adopted: { reportId: string; orgId: string }[]; archived: { reportId: string; orgId: string }[]; repointedDeliverableIds: string[] }`.

- [ ] **Step 1: Write the failing integration test (service half).** This pins Review Focus #2, #4 and #5, and spec §5 W04: ids and runs kept, recipients preserved, a CC disagreement blocks.

```ts
/**
 * Multi-org report series W04 — Combine on real Postgres, as the forced-RLS
 * breeze_app role (spec §3.8, §5 W04).
 *
 * Service half: findCombineCandidates / combineIntoSeries inside the same
 * partner-scope DB access context authMiddleware opens. Route half (Task 5):
 * the mounted routes with real access tokens.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { db, withDbAccessContext } from '../../db';
import {
  contacts,
  partnerUsers,
  reportRuns,
  reportScheduleRecipients,
  reportSeries,
  reportSeriesOrgTargets,
  reports,
  serviceDeliverableEvidence,
  serviceDeliverableOccurrences,
  serviceDeliverables,
} from '../../db/schema';
import { buildDbAccessContext } from '../../middleware/auth';
import { combineIntoSeries, findCombineCandidates, type CombineInput } from '../../services/reportSeries/combine';
import { siteScopeFingerprint } from '../../services/siteScope';
import {
  assignUserToPartner,
  createOrganization,
  createPartner,
  createRole,
  createSite,
  createUser,
  grantRolePermissions,
} from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(Boolean(process.env.DATABASE_URL));
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const REPORT_PERMISSIONS = [
  { resource: 'reports', action: 'read' },
  { resource: 'reports', action: 'write' },
  { resource: 'reports', action: 'delete' },
  { resource: 'reports', action: 'export' },
];

/** What ReportBuilder persists for a legacy builder type. */
const BASE_CONFIG = {
  builderType: 'template',
  dataSource: 'alerts',
  columns: ['severity', 'title', 'createdAt'],
  filterConditions: [{ id: 'filter-a1', logic: 'and', field: 'severity', operator: 'is', value: 'critical' }],
  schedule: { time: '08:00', day: 'monday' },
  exportFormats: ['pdf'],
};
/** The same report built again elsewhere: new filter id, key order, spelling. */
const TWIN_CONFIG = {
  exportFormats: ['pdf'],
  schedule: { day: 'Monday', time: '8:00' },
  filterConditions: [{ value: 'critical', operator: 'is', field: 'severity', logic: 'and', id: 'filter-zz' }],
  columns: ['severity', 'title', 'createdAt'],
  dataSource: 'alerts',
  builderType: 'template',
};

async function seedFixture() {
  const partner = (await createPartner())!;
  const orgA = (await createOrganization({ partnerId: partner.id, name: 'Acme Dental' }))!;
  const orgB = (await createOrganization({ partnerId: partner.id, name: 'Bravo Law' }))!;
  const orgC = (await createOrganization({ partnerId: partner.id, name: 'Churned Co', status: 'suspended' }))!;
  const orgD = (await createOrganization({ partnerId: partner.id, name: 'Delta Clinic' }))!;
  const role = (await createRole({ scope: 'partner', partnerId: partner.id }))!;
  await grantRolePermissions(role.id, REPORT_PERMISSIONS);
  const admin = (await createUser({ partnerId: partner.id, orgId: null, email: `combine-admin-${randomUUID()}@example.com` }))!;
  await assignUserToPartner(admin.id, partner.id, role.id, 'all');
  const selected = (await createUser({ partnerId: partner.id, orgId: null, email: `combine-selected-${randomUUID()}@example.com` }))!;
  await assignUserToPartner(selected.id, partner.id, role.id, 'selected');
  await getTestDb().update(partnerUsers).set({ orgIds: [orgA.id, orgB.id] }).where(eq(partnerUsers.userId, selected.id));
  const siteB = (await createSite({ orgId: orgB.id }))!;
  return { partner, orgA, orgB, orgC, orgD, admin, selected, roleId: role.id, siteB };
}
type Fixture = Awaited<ReturnType<typeof seedFixture>>;

async function seedReport(orgId: string, userId: string, over: Partial<typeof reports.$inferInsert> = {}): Promise<string> {
  const [row] = await getTestDb().insert(reports).values({
    orgId,
    name: 'Weekly critical alerts',
    type: 'alert_summary',
    schedule: 'weekly',
    format: 'pdf',
    config: BASE_CONFIG,
    createdBy: userId,
    executionScopeVersion: 1,
    executionScopeKind: 'unrestricted',
    executionScopeSiteIds: null,
    executionScopeUserId: userId,
    executionScopePrincipalKind: 'user',
    executionScopeFingerprint: siteScopeFingerprint({ version: 1, kind: 'unrestricted', orgId }),
    executionScopeCapturedAt: new Date('2026-09-01T00:00:00Z'),
    ...over,
  }).returning({ id: reports.id });
  return row!.id;
}

async function seedContact(orgId: string, email: string): Promise<string> {
  const [row] = await getTestDb().insert(contacts).values({ orgId, name: email.split('@')[0]!, email }).returning({ id: contacts.id });
  return row!.id;
}

async function addRecipient(reportId: string, orgId: string, contactId: string): Promise<void> {
  await getTestDb().insert(reportScheduleRecipients).values({ reportId, orgId, contactId });
}

async function seedRun(reportId: string): Promise<string> {
  const [row] = await getTestDb().insert(reportRuns).values({
    reportId, status: 'completed', startedAt: new Date('2026-09-15T08:00:00Z'), completedAt: new Date('2026-09-15T08:01:00Z'),
  }).returning({ id: reportRuns.id });
  return row!.id;
}

async function seedDeliverable(orgId: string, reportId: string, userId: string): Promise<string> {
  const [row] = await getTestDb().insert(serviceDeliverables).values({
    orgId, name: `Monthly alert review ${randomUUID().slice(0, 8)}`, cadence: 'monthly',
    anchorDueDate: '2026-09-30', effectiveFrom: '2026-09-01', autoEvidenceReportId: reportId, ownerUserId: userId,
  }).returning({ id: serviceDeliverables.id });
  return row!.id;
}

async function seedEvidence(orgId: string, deliverableId: string, reportId: string, runId: string): Promise<string> {
  const [occ] = await getTestDb().insert(serviceDeliverableOccurrences).values({
    orgId, deliverableId, nameSnapshot: 'Monthly alert review', periodStart: '2026-09-01', periodEnd: '2026-09-30',
    dueAt: '2026-09-30', originalDueAt: '2026-09-30', status: 'delivered',
  }).returning({ id: serviceDeliverableOccurrences.id });
  const [ev] = await getTestDb().insert(serviceDeliverableEvidence).values({
    orgId, occurrenceId: occ!.id, kind: 'report_run', reportId, reportRunId: runId,
  }).returning({ id: serviceDeliverableEvidence.id });
  return ev!.id;
}

/**
 * Acme Dental (A): rA1 (newest, linked by dA1, contact ann, CC cc+extra, 2 runs,
 * evidence) and rA2 (older duplicate, linked by dA2, contact bob, CC cc, 1 run,
 * evidence). Bravo Law (B): rB1 (twin config, CC upper-case, contact cara, 1 run)
 * plus a portal row, a site-restricted row and a site-filtered row that must
 * never be touched. Churned Co (C, suspended): a matching row. One-time row in A.
 */
async function seedGroup(f: Fixture) {
  const u = f.admin.id;
  const rA1 = await seedReport(f.orgA.id, u, {
    config: { ...BASE_CONFIG, emailRecipients: ['cc@msp.test', 'extra@msp.test'] },
    lastGeneratedAt: new Date('2026-09-20T08:00:00Z'),
  });
  const rA2 = await seedReport(f.orgA.id, u, {
    name: 'Weekly critical alerts (old)',
    config: { ...BASE_CONFIG, emailRecipients: ['cc@msp.test'] },
    lastGeneratedAt: new Date('2026-09-01T08:00:00Z'),
  });
  const rB1 = await seedReport(f.orgB.id, u, { config: { ...TWIN_CONFIG, emailRecipients: ['CC@msp.test'] } });
  const rC1 = await seedReport(f.orgC.id, u);
  const rPortal = await seedReport(f.orgB.id, u, { portalSelfService: true });
  const rRestricted = await seedReport(f.orgB.id, u, {
    executionScopeKind: 'restricted',
    executionScopeSiteIds: [f.siteB.id],
    executionScopeFingerprint: siteScopeFingerprint({ version: 1, kind: 'restricted', orgId: f.orgB.id, siteIds: [f.siteB.id] }),
  });
  const rSites = await seedReport(f.orgA.id, u, { config: { ...BASE_CONFIG, filters: { siteIds: [randomUUID()] } } });
  const rOneTime = await seedReport(f.orgA.id, u, { schedule: 'one_time' });

  const ann = await seedContact(f.orgA.id, 'ann@acme.test');
  const bob = await seedContact(f.orgA.id, 'bob@acme.test');
  const cara = await seedContact(f.orgB.id, 'cara@bravo.test');
  await addRecipient(rA1, f.orgA.id, ann);
  await addRecipient(rA2, f.orgA.id, bob);
  await addRecipient(rB1, f.orgB.id, cara);

  const runA1a = await seedRun(rA1);
  await seedRun(rA1);
  const runA2 = await seedRun(rA2);
  await seedRun(rB1);
  const dA1 = await seedDeliverable(f.orgA.id, rA1, u);
  const dA2 = await seedDeliverable(f.orgA.id, rA2, u);
  const evA1 = await seedEvidence(f.orgA.id, dA1, rA1, runA1a);
  const evA2 = await seedEvidence(f.orgA.id, dA2, rA2, runA2);

  return { rA1, rA2, rB1, rC1, rPortal, rRestricted, rSites, rOneTime, ann, bob, cara, dA1, dA2, evA1, evA2, runA2 };
}

function asAdmin<T>(f: Fixture, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const context = buildDbAccessContext({
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: [f.orgA.id, f.orgB.id, f.orgD.id],
    partnerId: f.partner.id,
    userId: f.admin.id,
  });
  return withDbAccessContext(context, () => db.transaction((tx) => fn(tx)));
}

const adminAuth = (f: Fixture) => ({
  scope: 'partner' as const,
  partnerId: f.partner.id,
  partnerOrgAccess: 'all' as const,
  user: { id: f.admin.id },
});

async function candidatesFor(f: Fixture) {
  return asAdmin(f, (tx) => findCombineCandidates(f.partner.id, tx));
}

async function inputFor(f: Fixture, over: Partial<CombineInput> = {}): Promise<CombineInput> {
  const [group] = await candidatesFor(f);
  return {
    groupKey: group!.groupKey,
    reportIds: group!.orgs.flatMap((o) => o.rows.map((r) => r.reportId)),
    name: 'Weekly critical alerts',
    targetMode: 'selected',
    ccResolution: { include: [], drop: ['extra@msp.test'] },
    callerMaySetEmailRecipients: false,
    ...over,
  };
}

const reportRow = async (id: string) =>
  (await getTestDb().select().from(reports).where(eq(reports.id, id)))[0]!;
const seriesOf = (partnerId: string) =>
  getTestDb().select().from(reportSeries).where(eq(reportSeries.partnerId, partnerId));

describe('Combine service on real Postgres (series W04)', () => {
  runDb('lists exactly one group: twins across A and B, excluded rows absent, CC split', async () => {
    const f = await seedFixture();
    const s = await seedGroup(f);
    const groups = await candidatesFor(f);

    expect(groups).toHaveLength(1);
    const [group] = groups;
    expect(group!.orgs.map((o) => o.orgName)).toEqual(['Acme Dental', 'Bravo Law']);
    expect(group!.orgs[0]!.rows.map((r) => [r.reportId, r.action])).toEqual([[s.rA1, 'adopt'], [s.rA2, 'archive']]);
    expect(group!.orgs[1]!.rows.map((r) => [r.reportId, r.action])).toEqual([[s.rB1, 'adopt']]);
    expect(group!.orgs[0]!.rows[0]).toMatchObject({ deliverableLinked: true });
    expect(group!.orgs[0]!.rows[0]!.contactRecipients.map((c) => c.contactId)).toEqual([s.ann]);
    expect(group!.sharedCc).toEqual(['cc@msp.test']);
    expect(group!.conflictingCc).toEqual([{ email: 'extra@msp.test', reportIds: [s.rA1] }]);
    const listed = group!.orgs.flatMap((o) => o.rows.map((r) => r.reportId));
    for (const excluded of [s.rC1, s.rPortal, s.rRestricted, s.rSites, s.rOneTime]) {
      expect(listed).not.toContain(excluded);
    }
  });

  runDb('combines in place: ids, runs, evidence and recipients survive; duplicate archived; deliverable repointed', async () => {
    const f = await seedFixture();
    const s = await seedGroup(f);
    const runsBefore = await getTestDb().select().from(reportRuns).where(inArray(reportRuns.reportId, [s.rA1, s.rA2, s.rB1]));
    const evidenceBefore = await getTestDb().select().from(serviceDeliverableEvidence).where(inArray(serviceDeliverableEvidence.id, [s.evA1, s.evA2]));

    const result = await asAdmin(f, async (tx) => combineIntoSeries(await inputFor(f), adminAuth(f), tx));

    const [series] = await seriesOf(f.partner.id);
    expect(series).toMatchObject({
      id: result.seriesId, targetMode: 'selected', internalCc: ['cc@msp.test'],
      recipientRule: { primaryContact: false, roles: [] }, ownerUserId: f.admin.id,
      type: 'alert_summary', schedule: 'weekly', format: 'pdf',
    });
    expect((series!.config as Record<string, unknown>).emailRecipients).toBeUndefined();
    const targets = await getTestDb().select().from(reportSeriesOrgTargets).where(eq(reportSeriesOrgTargets.seriesId, result.seriesId));
    expect(targets.map((t) => t.orgId).sort()).toEqual([f.orgA.id, f.orgB.id].sort());

    for (const id of [s.rA1, s.rB1]) {
      const adopted = await reportRow(id);
      expect(adopted).toMatchObject({ seriesId: result.seriesId, seriesRevision: 1, archivedAt: null });
      expect(adopted.executionScopeUserId).toBe(f.admin.id);
      expect(adopted.executionScopeKind).toBe('unrestricted');
      expect((adopted.config as Record<string, unknown>).emailRecipients).toEqual(['cc@msp.test']);
    }
    const archived = await reportRow(s.rA2);
    expect(archived.seriesId).toBeNull();
    expect(archived.archivedAt).not.toBeNull();
    expect(result.adopted.map((a) => a.reportId).sort()).toEqual([s.rA1, s.rB1].sort());
    expect(result.archived).toEqual([{ reportId: s.rA2, orgId: f.orgA.id }]);

    // Runs and evidence untouched, row for row.
    const runsAfter = await getTestDb().select().from(reportRuns).where(inArray(reportRuns.reportId, [s.rA1, s.rA2, s.rB1]));
    expect(runsAfter.map((r) => [r.id, r.reportId]).sort()).toEqual(runsBefore.map((r) => [r.id, r.reportId]).sort());
    const evidenceAfter = await getTestDb().select().from(serviceDeliverableEvidence).where(inArray(serviceDeliverableEvidence.id, [s.evA1, s.evA2]));
    expect(evidenceAfter.map((e) => [e.id, e.reportId, e.reportRunId]).sort())
      .toEqual(evidenceBefore.map((e) => [e.id, e.reportId, e.reportRunId]).sort());

    // Review Focus #4: the archived duplicate's deliverable now feeds from the adopted row.
    const [dA2] = await getTestDb().select().from(serviceDeliverables).where(eq(serviceDeliverables.id, s.dA2));
    expect(dA2!.autoEvidenceReportId).toBe(s.rA1);
    expect(result.repointedDeliverableIds).toEqual([s.dA2]);

    // Recipients: each org keeps its contacts (A gains the archived duplicate's), all 'add'.
    const recipients = await getTestDb().select().from(reportScheduleRecipients)
      .where(inArray(reportScheduleRecipients.reportId, [s.rA1, s.rB1]));
    expect(recipients.filter((r) => r.reportId === s.rA1).map((r) => r.contactId).sort()).toEqual([s.ann, s.bob].sort());
    expect(recipients.filter((r) => r.reportId === s.rB1).map((r) => r.contactId)).toEqual([s.cara]);
    expect(new Set(recipients.map((r) => r.mode))).toEqual(new Set(['add']));

    // Review Focus #2 and the rest of the exclusion list: untouched.
    for (const id of [s.rC1, s.rPortal, s.rRestricted, s.rSites, s.rOneTime]) {
      expect(await reportRow(id)).toMatchObject({ seriesId: null, archivedAt: null });
    }
    // 'selected' mode sends nothing new: no child in Delta Clinic.
    const deltaChildren = await getTestDb().select().from(reports)
      .where(and(eq(reports.orgId, f.orgD.id), isNotNull(reports.seriesId)));
    expect(deltaChildren).toHaveLength(0);
  });

  runDb("'all' mode: no target rows, the new org gets a child with no customer recipients", async () => {
    const f = await seedFixture();
    await seedGroup(f);
    const result = await asAdmin(f, async (tx) => combineIntoSeries(
      await inputFor(f, { targetMode: 'all', ccResolution: { include: ['extra@msp.test'], drop: [] }, callerMaySetEmailRecipients: true }),
      adminAuth(f), tx,
    ));
    const [series] = await seriesOf(f.partner.id);
    expect(series!.internalCc).toEqual(['cc@msp.test', 'extra@msp.test']);
    expect(await getTestDb().select().from(reportSeriesOrgTargets).where(eq(reportSeriesOrgTargets.seriesId, result.seriesId))).toEqual([]);
    const [delta] = await getTestDb().select().from(reports)
      .where(and(eq(reports.orgId, f.orgD.id), eq(reports.seriesId, result.seriesId)));
    expect(delta).toBeDefined();
    expect(await getTestDb().select().from(reportScheduleRecipients).where(eq(reportScheduleRecipients.reportId, delta!.id))).toEqual([]);
    // The suspended org is never targeted.
    expect(await getTestDb().select().from(reports)
      .where(and(eq(reports.orgId, f.orgC.id), eq(reports.seriesId, result.seriesId)))).toEqual([]);
  });

  runDb('an unresolved CC address blocks the combine and writes nothing', async () => {
    const f = await seedFixture();
    const s = await seedGroup(f);
    const input = await inputFor(f, { ccResolution: { include: [], drop: [] } });
    await expect(asAdmin(f, (tx) => combineIntoSeries(input, adminAuth(f), tx))).rejects.toMatchObject({
      code: 'combine_cc_conflict',
      status: 409,
      body: { error: 'combine_cc_conflict', shared: ['cc@msp.test'], unresolved: [{ email: 'extra@msp.test', reportIds: [s.rA1] }], unexpected: [] },
    });
    expect(await seriesOf(f.partner.id)).toEqual([]);
    expect((await reportRow(s.rA1)).seriesId).toBeNull();
  });

  runDb('a combine that adds a delivery needs export + MFA', async () => {
    const f = await seedFixture();
    await seedGroup(f);
    const input = await inputFor(f, { ccResolution: { include: ['extra@msp.test'], drop: [] }, callerMaySetEmailRecipients: false });
    await expect(asAdmin(f, (tx) => combineIntoSeries(input, adminAuth(f), tx)))
      .rejects.toMatchObject({ code: 'recipients_need_export_and_mfa', status: 403 });
    expect(await seriesOf(f.partner.id)).toEqual([]);
  });

  // Review Focus #5.
  runDb('the second combine of the same group gets 409 combine_group_changed and writes nothing', async () => {
    const f = await seedFixture();
    await seedGroup(f);
    const input = await inputFor(f);
    await asAdmin(f, (tx) => combineIntoSeries(input, adminAuth(f), tx));
    await expect(asAdmin(f, (tx) => combineIntoSeries(input, adminAuth(f), tx)))
      .rejects.toMatchObject({ code: 'combine_group_changed', status: 409 });
    expect(await seriesOf(f.partner.id)).toHaveLength(1);
    expect(await candidatesFor(f)).toEqual([]);
  });

  runDb('a selected-access partner user is refused by the service belt', async () => {
    const f = await seedFixture();
    await seedGroup(f);
    const input = await inputFor(f);
    await expect(asAdmin(f, (tx) => combineIntoSeries(input, { ...adminAuth(f), partnerOrgAccess: 'selected' }, tx)))
      .rejects.toThrow(/org access/i);
    expect(await seriesOf(f.partner.id)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails.**

Run: `pnpm test-stack up && cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/reportSeriesCombine.integration.test.ts`
Expected: FAIL with `Failed to resolve import "../../services/reportSeries/combine"`.

- [ ] **Step 3: Implement `combine.ts`.**

```ts
/**
 * Multi-org report series W04 — Combine (spec §3.8, decision D4: opt-in only).
 *
 * `findCombineCandidates` lists groups of near-identical org-owned reports of
 * ONE partner; `combineIntoSeries` turns one group into a series in ONE
 * transaction, adopting a row per org IN PLACE (id, runs, evidence and contact
 * recipients survive) and archiving same-org duplicates.
 *
 * Both functions trust their caller for the partner-wide gate
 * (routes/reports/seriesCombine.ts); combineIntoSeries re-checks it as a belt.
 * Every `reports` read here is org-owned only (isNotNull(reports.orgId)) and
 * joined to organizations of ONE partner; see the allowlist entries in
 * partnerOwnedVisibility.scan.test.ts.
 */
import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import type { db } from '../../db';
import {
  contacts,
  organizations,
  reportScheduleRecipients,
  reportSeries,
  reportSeriesOrgTargets,
  reports,
  serviceDeliverables,
} from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { canManagePartnerWidePolicies, PartnerWideWriteDeniedError } from '../partnerWideAccess';
import { assertSeriesOwnerEligible, captureChildExecutionScope } from './authority';
import {
  CombineError,
  MAX_INTERNAL_CC,
  groupCombineRows,
  planGroupAdoption,
  resolveCombineCc,
  splitCombineCc,
  toCandidateGroup,
  type CcResolution,
  type CombineCandidateGroup,
  type CombineContactRecipient,
  type CombineSourceRow,
  type EligibleCombineRow,
} from './combinePlan';
import { reconcileSeries } from './reconcile';
import { assertSeriesConfigOrgAgnostic, assertSeriesTypeSupported } from './validation';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type ChildScopeColumns = Exclude<Awaited<ReturnType<typeof captureChildExecutionScope>>, 'no_authority'>;

export interface CombineInput {
  groupKey: string;
  /** Every row the dialog showed for the group (adopt + archive). */
  reportIds: string[];
  name: string;
  targetMode: 'selected' | 'all';
  ccResolution: CcResolution;
  /** Server-derived (routes/reports/recipientGate.ts): reports:export AND a
   *  satisfied MFA session. NEVER read from the request body. */
  callerMaySetEmailRecipients: boolean;
}

export type CombineAuth = Pick<AuthContext, 'scope' | 'partnerId' | 'partnerOrgAccess'> & { user: { id: string } };

export interface CombineResult {
  seriesId: string;
  adopted: { reportId: string; orgId: string }[];
  archived: { reportId: string; orgId: string }[];
  repointedDeliverableIds: string[];
}

const COMBINE_ROW_COLUMNS = {
  id: reports.id,
  orgId: reports.orgId,
  orgName: organizations.name,
  name: reports.name,
  type: reports.type,
  format: reports.format,
  schedule: reports.schedule,
  config: reports.config,
  lastGeneratedAt: reports.lastGeneratedAt,
  createdAt: reports.createdAt,
  updatedAt: reports.updatedAt,
  portalSelfService: reports.portalSelfService,
  sourceAiAgentScheduleId: reports.sourceAiAgentScheduleId,
  executionScopeKind: reports.executionScopeKind,
  executionScopePrincipalKind: reports.executionScopePrincipalKind,
  seriesId: reports.seriesId,
  archivedAt: reports.archivedAt,
};

/** Series-eligible orgs only (spec §3.3): a row in any other org would be
 *  archived by the reconciler the moment it was adopted. */
function eligibleOrgCondition() {
  return and(inArray(organizations.status, ['active', 'trial']), isNull(organizations.deletedAt));
}

async function loadCandidateRows(partnerId: string, tx: Tx): Promise<CombineSourceRow[]> {
  return tx
    .select(COMBINE_ROW_COLUMNS)
    .from(reports)
    .innerJoin(organizations, eq(organizations.id, reports.orgId))
    .where(and(
      eq(organizations.partnerId, partnerId),
      eligibleOrgCondition(),
      isNotNull(reports.orgId),
      isNull(reports.seriesId),
      isNull(reports.archivedAt),
    ));
}

/** Re-reads the caller's rows under lock. Deliberately NO series/archived
 *  filter: a row combined meanwhile must come back so it can fail
 *  `keyCombineRow` ('in_series') and turn the call into combine_group_changed. */
async function loadLockedGroupRows(partnerId: string, reportIds: readonly string[], tx: Tx): Promise<CombineSourceRow[]> {
  return tx
    .select(COMBINE_ROW_COLUMNS)
    .from(reports)
    .innerJoin(organizations, eq(organizations.id, reports.orgId))
    .where(and(
      inArray(reports.id, [...reportIds]),
      eq(organizations.partnerId, partnerId),
      eligibleOrgCondition(),
      isNotNull(reports.orgId),
    ))
    .for('update', { of: reports });
}

async function loadDeliverableLinks(reportIds: readonly string[], tx: Tx) {
  if (reportIds.length === 0) return [];
  return tx
    .select({ id: serviceDeliverables.id, orgId: serviceDeliverables.orgId, reportId: serviceDeliverables.autoEvidenceReportId })
    .from(serviceDeliverables)
    .where(inArray(serviceDeliverables.autoEvidenceReportId, [...reportIds]));
}

function linkedReportIds(links: readonly { reportId: string | null }[]): Set<string> {
  return new Set(links.flatMap((l) => (l.reportId ? [l.reportId] : [])));
}

async function loadContactRecipients(reportIds: readonly string[], tx: Tx): Promise<Map<string, CombineContactRecipient[]>> {
  const byReport = new Map<string, CombineContactRecipient[]>();
  if (reportIds.length === 0) return byReport;
  const rows = await tx
    .select({
      reportId: reportScheduleRecipients.reportId,
      contactId: reportScheduleRecipients.contactId,
      name: contacts.name,
      email: contacts.email,
    })
    .from(reportScheduleRecipients)
    .innerJoin(contacts, and(eq(contacts.id, reportScheduleRecipients.contactId), eq(contacts.orgId, reportScheduleRecipients.orgId)))
    .where(and(inArray(reportScheduleRecipients.reportId, [...reportIds]), eq(reportScheduleRecipients.mode, 'add')));
  for (const r of rows) {
    byReport.set(r.reportId, [...(byReport.get(r.reportId) ?? []), { contactId: r.contactId, name: r.name, email: r.email }]);
  }
  for (const list of byReport.values()) list.sort((a, b) => (a.contactId < b.contactId ? -1 : 1));
  return byReport;
}

/**
 * Groups of >= 2 orgs whose rows could be combined. Read-only. The caller must
 * already have passed the partner-wide gate for `partnerId`.
 */
export async function findCombineCandidates(partnerId: string, tx: Tx): Promise<CombineCandidateGroup[]> {
  const groups = groupCombineRows(await loadCandidateRows(partnerId, tx));
  if (groups.length === 0) return [];
  const groupedIds = groups.flatMap((g) => g.rows.map((k) => k.row.id));
  const linked = linkedReportIds(await loadDeliverableLinks(groupedIds, tx));
  const recipients = await loadContactRecipients(groupedIds, tx);
  return groups
    .map((g) => toCandidateGroup(planGroupAdoption(g, linked), recipients, linked))
    .sort((a, b) => b.orgs.length - a.orgs.length
      || a.suggestedName.localeCompare(b.suggestedName, 'en')
      || (a.groupKey < b.groupKey ? -1 : 1));
}

function sameIdSet(a: readonly string[], b: readonly string[]): boolean {
  const sa = new Set(a);
  const sb = new Set(b);
  return sa.size === a.length && sb.size === b.length && sa.size === sb.size && [...sa].every((id) => sb.has(id));
}

const groupChanged = () => new CombineError('combine_group_changed', 409, { error: 'combine_group_changed' });

/** Copies the archived duplicates' contact recipients onto the adopted row, so
 *  the org's customers keep receiving exactly what they receive today. */
async function copyDuplicateRecipients(adoptedId: string, orgId: string, duplicateIds: readonly string[], tx: Tx): Promise<void> {
  const rows = await tx
    .select({ contactId: reportScheduleRecipients.contactId })
    .from(reportScheduleRecipients)
    .where(and(
      inArray(reportScheduleRecipients.reportId, [...duplicateIds]),
      eq(reportScheduleRecipients.orgId, orgId),
      eq(reportScheduleRecipients.mode, 'add'),
    ));
  const contactIds = [...new Set(rows.map((r) => r.contactId))];
  if (contactIds.length === 0) return;
  await tx
    .insert(reportScheduleRecipients)
    .values(contactIds.map((contactId) => ({ reportId: adoptedId, orgId, contactId, mode: 'add' as const })))
    .onConflictDoNothing();
}

/** A deliverable fed by a duplicate now feeds from the adopted row (same org,
 *  same type, same normalized config). Past evidence rows are not touched. */
async function repointDeliverables(adoptedId: string, orgId: string, duplicateIds: readonly string[], tx: Tx): Promise<string[]> {
  const rows = await tx
    .update(serviceDeliverables)
    .set({ autoEvidenceReportId: adoptedId, updatedAt: new Date() })
    .where(and(eq(serviceDeliverables.orgId, orgId), inArray(serviceDeliverables.autoEvidenceReportId, [...duplicateIds])))
    .returning({ id: serviceDeliverables.id });
  return rows.map((r) => r.id);
}

async function archiveCombineExtras(orgId: string, duplicateIds: readonly string[], tx: Tx): Promise<void> {
  const rows = await tx
    .update(reports)
    .set({ archivedAt: new Date(), updatedAt: new Date() })
    .where(and(
      inArray(reports.id, [...duplicateIds]),
      eq(reports.orgId, orgId),
      isNull(reports.seriesId),
      isNull(reports.archivedAt),
    ))
    .returning({ id: reports.id });
  if (rows.length !== duplicateIds.length) throw groupChanged();
}

/**
 * Adopts one row: links it to the series at revision 0 (always older than the
 * series' revision, which starts at 1) and stores the owner's execution scope
 * for this org. `reconcileSeries` then overwrites the shared fields through
 * its stale-child branch — the reconciler stays the ONE writer of a child's
 * shared fields.
 */
async function adoptCombineRow(row: EligibleCombineRow, seriesId: string, scope: ChildScopeColumns, tx: Tx): Promise<void> {
  const rows = await tx
    .update(reports)
    .set({ seriesId, seriesRevision: 0, ...scope, updatedAt: new Date() })
    .where(and(
      eq(reports.id, row.id),
      eq(reports.orgId, row.orgId),
      isNull(reports.seriesId),
      isNull(reports.archivedAt),
    ))
    .returning({ id: reports.id });
  if (rows.length !== 1) throw groupChanged();
}

export async function combineIntoSeries(input: CombineInput, auth: CombineAuth, tx: Tx): Promise<CombineResult> {
  if (auth.scope !== 'partner' || !auth.partnerId || !canManagePartnerWidePolicies(auth)) {
    throw new PartnerWideWriteDeniedError();
  }
  const partnerId = auth.partnerId;

  const locked = await loadLockedGroupRows(partnerId, input.reportIds, tx);
  const group = groupCombineRows(locked).find((g) => g.groupKey === input.groupKey);
  if (!group || !sameIdSet(group.rows.map((k) => k.row.id), input.reportIds)) throw groupChanged();

  assertSeriesTypeSupported(group.type);
  const links = await loadDeliverableLinks(input.reportIds, tx);
  const plan = planGroupAdoption(group, linkedReportIds(links));
  assertSeriesConfigOrgAgnostic(plan.seriesConfig);

  const cc = resolveCombineCc(splitCombineCc(plan), input.ccResolution);
  if (!cc.ok) {
    throw new CombineError('combine_cc_conflict', 409, {
      error: 'combine_cc_conflict', shared: cc.shared, unresolved: cc.unresolved, unexpected: cc.unexpected,
    });
  }
  if (cc.internalCc.length > MAX_INTERNAL_CC) {
    throw new CombineError('combine_cc_too_many', 400, { error: 'combine_cc_too_many', max: MAX_INTERNAL_CC });
  }
  const addsDeliveries = cc.addedCc.length > 0 || (input.targetMode === 'all' && cc.internalCc.length > 0);
  if (addsDeliveries && !input.callerMaySetEmailRecipients) {
    throw new CombineError('recipients_need_export_and_mfa', 403, { error: 'recipients_need_export_and_mfa' });
  }

  await assertSeriesOwnerEligible(auth.user.id, partnerId, tx);
  const scopes = new Map<string, ChildScopeColumns>();
  const blocked: string[] = [];
  for (const org of plan.orgs) {
    const scope = await captureChildExecutionScope(auth.user.id, org.orgId, tx);
    if (scope === 'no_authority') blocked.push(org.orgId);
    else scopes.set(org.orgId, scope);
  }
  if (blocked.length > 0) {
    throw new CombineError('series_owner_ineligible', 400, { error: 'series_owner_ineligible', orgIds: blocked });
  }

  const [series] = await tx
    .insert(reportSeries)
    .values({
      partnerId,
      name: input.name,
      type: plan.type,
      format: plan.format,
      schedule: plan.schedule,
      config: plan.seriesConfig,
      targetMode: input.targetMode,
      recipientRule: { primaryContact: false, roles: [] },
      internalCc: cc.internalCc,
      enabled: true,
      ownerUserId: auth.user.id,
      createdBy: auth.user.id,
    })
    .returning({ id: reportSeries.id });
  const seriesId = series!.id;
  if (input.targetMode === 'selected') {
    await tx.insert(reportSeriesOrgTargets).values(plan.orgs.map((o) => ({ seriesId, orgId: o.orgId })));
  }

  const archived: CombineResult['archived'] = [];
  const repointedDeliverableIds: string[] = [];
  for (const org of plan.orgs) {
    const duplicateIds = org.archive.map((r) => r.id);
    if (duplicateIds.length > 0) {
      await copyDuplicateRecipients(org.adopt.id, org.orgId, duplicateIds, tx);
      repointedDeliverableIds.push(...await repointDeliverables(org.adopt.id, org.orgId, duplicateIds, tx));
      await archiveCombineExtras(org.orgId, duplicateIds, tx);
      archived.push(...duplicateIds.map((reportId) => ({ reportId, orgId: org.orgId })));
    }
    await adoptCombineRow(org.adopt, seriesId, scopes.get(org.orgId)!, tx);
  }

  // Writes every adopted child's shared fields (revision 0 → series.revision),
  // and in 'all' mode creates children for the partner's other eligible orgs.
  await reconcileSeries(seriesId, tx);

  return {
    seriesId,
    adopted: plan.orgs.map((o) => ({ reportId: o.adopt.id, orgId: o.orgId })),
    archived,
    repointedDeliverableIds,
  };
}
```

- [ ] **Step 4: Allowlist the four `reports` query sites.** Edit `partnerOwnedVisibility.scan.test.ts`.
  1. Add this after `const AUD_CALLER_AUTHORIZED = …` (around line 190):

```ts
const AUD_SERIES_COMBINE = 'series W04 Combine: partner scope with org_access=all only (route + service belt canManagePartnerWidePolicies); msp_staff business types are excluded before grouping (assertSeriesTypeSupported refuses PARTNER_ONLY_DELIVERY_REPORT_TYPES)';
```

  2. Add this entry to `SITE_ALLOWLIST`, after the `'src/services/reportRunDelivery.ts'` entry:

```ts
  ['src/services/reportSeries/combine.ts', new Map([
    ['loadCandidateRows', pinned(1, `Combine candidate scan: isNotNull(reports.orgId) joined to organizations of ONE partner (eq(organizations.partnerId, partnerId)); callers are gated on canManagePartnerWidePolicies; ${ORG_PIN}`, AUD_SERIES_COMBINE)],
    ['loadLockedGroupRows', pinned(1, `Combine re-read FOR UPDATE: the caller's report ids AND the same org-owned, one-partner predicate as loadCandidateRows; ${ORG_PIN}`, AUD_SERIES_COMBINE)],
    ['archiveCombineExtras', pinned(1, `Combine archive of same-org duplicates: ids from loadLockedGroupRows AND eq(reports.orgId, orgId); ${ORG_PIN}`, AUD_SERIES_COMBINE)],
    ['adoptCombineRow', pinned(1, `Combine adoption: one row by id AND eq(reports.orgId, row.orgId), locked by loadLockedGroupRows; ${ORG_PIN}`, AUD_SERIES_COMBINE)],
  ])],
```

- [ ] **Step 5: Run the integration suite, the scan and the contract walkers.**

Run:

```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/reportSeriesCombine.integration.test.ts
cd apps/api && npx vitest run src/routes/reports/partnerOwnedVisibility.scan.test.ts src/__tests__/partner-wide-write-coverage.test.ts
```

Expected:

- The integration suite passes (7 tests).
- The scan passes. If it reports a different site count for a `combine.ts` scope, a query was added or removed; recount and fix the pin, and never widen a reason to cover it.
- `partner-wide-write-coverage` passes, because `combine.ts` mentions `canManagePartnerWidePolicies`.

If `seriesRevision: 1` fails in the second test, the reconciler did not treat revision 0 as stale (Preflight P2). Fix it as P2 directs; do not write the shared fields in combine.

- [ ] **Step 6: Commit.**

```bash
git add apps/api/src/services/reportSeries/combine.ts \
  apps/api/src/routes/reports/partnerOwnedVisibility.scan.test.ts \
  apps/api/src/__tests__/integration/reportSeriesCombine.integration.test.ts
git commit -m "feat(reports): combineIntoSeries adopts one row per org in place (series W04)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Routes: `GET /reports/series/combine-candidates` and `POST /reports/series/combine`

**Files:**
- Modify: `apps/api/src/routes/reports/seriesSchemas.ts`. Append `combineSeriesSchema`.
- Create: `apps/api/src/routes/reports/seriesCombine.ts` and `seriesCombine.test.ts`
- Modify: `apps/api/src/routes/reports/series.ts`. Mount `seriesCombineRoutes` before the first route registration.
- Modify: `apps/api/src/services/mcpCoverage.ts`. Add one entry.
- Modify: `apps/api/src/__tests__/integration/reportSeriesCombine.integration.test.ts`. Add the route half.

**Interfaces:**
- Consumes:
  - from Task 4: `findCombineCandidates`, `combineIntoSeries` and `CombineInput`;
  - from W02:
    - `callerMaySetEmailRecipients(auth): boolean` and `RECIPIENTS_NEED_EXPORT_AND_MFA`, from `routes/reports/recipientGate.ts`. W02 extracted them from `core.ts`; W04 does not touch `core.ts`.
    - `ReportSeriesError` and `seriesErrorResponse(c, err)`, from `services/reportSeries/errors.ts`.
- Produces:
  - `combineSeriesSchema` / `CombineSeriesBody`;
  - `seriesCombineRoutes`;
  - responses:
    - `GET` → `{ data: CombineCandidateGroup[] }`;
    - `POST` → 201 with `CombineResult`.

- [ ] **Step 1: Write the failing route test.** W02's recipient gate is mocked here, so this test only checks that the route passes through the gate's result. The gate's own behaviour belongs to W02's `recipientGate.test.ts`. W02's error mapper runs for real.

```ts
// apps/api/src/routes/reports/seriesCombine.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const TX = { marker: 'tx' };
const GROUP_KEY = 'a'.repeat(64);
const R1 = '11111111-1111-4111-8111-111111111111';
const R2 = '22222222-2222-4222-8222-222222222222';

const state = vi.hoisted(() => ({
  auth: undefined as Record<string, unknown> | undefined,
  permissions: { permissions: [] as { resource: string; action: string }[] },
  mayAddRecipients: true,
  findCombineCandidates: vi.fn(),
  combineIntoSeries: vi.fn(),
  writeRouteAudit: vi.fn(),
}));

vi.mock('../../db', () => ({ db: { transaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb(TX)) } }));
vi.mock('../../middleware/auth', () => ({
  authMiddleware: async (c: any, next: () => Promise<void>) => {
    c.set('auth', state.auth);
    c.set('permissions', state.permissions);
    await next();
  },
  requireScope: (...scopes: string[]) => async (c: any, next: () => Promise<void>) =>
    scopes.includes(c.get('auth').scope) ? next() : c.json({ error: 'Insufficient scope' }, 403),
  requirePermission: (resource: string, action: string) => async (c: any, next: () => Promise<void>) =>
    state.permissions.permissions.some((p) => p.resource === resource && p.action === action)
      ? next()
      : c.json({ error: 'Permission denied' }, 403),
}));
vi.mock('../../services/permissions', () => ({
  PERMISSIONS: {
    REPORTS_READ: { resource: 'reports', action: 'read' },
    REPORTS_WRITE: { resource: 'reports', action: 'write' },
    REPORTS_EXPORT: { resource: 'reports', action: 'export' },
  },
}));
vi.mock('./recipientGate', () => ({
  RECIPIENTS_NEED_EXPORT_AND_MFA: {
    error: 'Setting or changing email recipients on a report requires the export permission and an MFA-verified session',
  },
  callerMaySetEmailRecipients: () => state.mayAddRecipients,
}));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: state.writeRouteAudit }));
vi.mock('../../services/reportSeries/combine', () => ({
  findCombineCandidates: state.findCombineCandidates,
  combineIntoSeries: state.combineIntoSeries,
}));

import { CombineError } from '../../services/reportSeries/combinePlan';
import { ReportSeriesError } from '../../services/reportSeries/errors';
import { PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../../services/partnerWideAccess';
import { RECIPIENTS_NEED_EXPORT_AND_MFA } from './recipientGate';
import { seriesCombineRoutes } from './seriesCombine';

const READ = { resource: 'reports', action: 'read' };
const WRITE = { resource: 'reports', action: 'write' };
const body = {
  groupKey: GROUP_KEY, reportIds: [R1, R2], name: 'Weekly alerts', targetMode: 'selected',
  ccResolution: { include: [], drop: ['extra@msp.test'] },
};

function app() {
  const hono = new Hono();
  hono.route('/', seriesCombineRoutes);
  return hono;
}
const post = (payload: unknown) => app().request('/combine', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
});

describe('series Combine routes (W04)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.auth = { scope: 'partner', partnerId: 'partner-1', partnerOrgAccess: 'all', user: { id: 'user-1' }, token: { mfa: true } };
    state.permissions = { permissions: [READ, WRITE] };
    state.mayAddRecipients = true;
    state.findCombineCandidates.mockResolvedValue([{ groupKey: GROUP_KEY }]);
    state.combineIntoSeries.mockResolvedValue({
      seriesId: 'series-1',
      adopted: [{ reportId: R1, orgId: 'org-a' }, { reportId: R2, orgId: 'org-b' }],
      archived: [{ reportId: 'dup-1', orgId: 'org-a' }],
      repointedDeliverableIds: [],
    });
  });

  it("GET /combine-candidates lists the caller's own partner, in a transaction", async () => {
    const res = await app().request('/combine-candidates');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [{ groupKey: GROUP_KEY }] });
    expect(state.findCombineCandidates).toHaveBeenCalledWith('partner-1', TX);
  });

  it('refuses an organization-scope token on both routes', async () => {
    state.auth = { scope: 'organization', orgId: 'org-a', partnerId: 'partner-1', user: { id: 'u' }, token: { mfa: true } };
    expect((await app().request('/combine-candidates')).status).toBe(403);
    expect((await post(body)).status).toBe(403);
    expect(state.findCombineCandidates).not.toHaveBeenCalled();
    expect(state.combineIntoSeries).not.toHaveBeenCalled();
  });

  it("refuses a partner user whose org_access is 'selected'", async () => {
    state.auth = { ...state.auth, partnerOrgAccess: 'selected' };
    const res = await post(body);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE });
    expect((await app().request('/combine-candidates')).status).toBe(403);
    expect(state.combineIntoSeries).not.toHaveBeenCalled();
  });

  it('POST /combine needs reports:write', async () => {
    state.permissions = { permissions: [READ] };
    expect((await post(body)).status).toBe(403);
  });

  it("POST /combine passes W02's gate result (never a body flag) and audits partner + each org", async () => {
    const res = await post({ ...body, callerMaySetEmailRecipients: false }); // stripped by the schema
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ seriesId: 'series-1' });
    expect(state.combineIntoSeries).toHaveBeenCalledWith(
      { ...body, callerMaySetEmailRecipients: true },
      state.auth,
      TX,
    );
    const actions = state.writeRouteAudit.mock.calls.map(([, event]) => [event.action, event.orgId, event.resourceId]);
    expect(actions).toEqual([
      ['report_series.combine', null, 'series-1'],
      ['report.series_adopt', 'org-a', R1],
      ['report.series_adopt', 'org-b', R2],
      ['report.archive', 'org-a', 'dup-1'],
    ]);

    state.mayAddRecipients = false;
    await post(body);
    expect(state.combineIntoSeries.mock.calls[1]![0].callerMaySetEmailRecipients).toBe(false);
  });

  it('maps CombineError and W02 ReportSeriesError through seriesErrorResponse; the recipient gate keeps the core.ts body', async () => {
    const conflict = { error: 'combine_cc_conflict', shared: ['cc@msp.test'], unresolved: [{ email: 'x@msp.test', reportIds: [R1] }], unexpected: [] };
    state.combineIntoSeries.mockRejectedValueOnce(new CombineError('combine_cc_conflict', 409, conflict));
    let res = await post(body);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject(conflict);

    state.combineIntoSeries.mockRejectedValueOnce(new CombineError('recipients_need_export_and_mfa', 403, { error: 'recipients_need_export_and_mfa' }));
    res = await post(body);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(RECIPIENTS_NEED_EXPORT_AND_MFA);

    state.combineIntoSeries.mockRejectedValueOnce(new ReportSeriesError('series_owner_ineligible', 400));
    res = await post(body);
    expect(res.status).toBe(400);
    expect(state.writeRouteAudit).not.toHaveBeenCalled();
  });

  it('lets an unknown error reach the error handler (500), never a silent 200', async () => {
    state.combineIntoSeries.mockRejectedValueOnce(new Error('boom'));
    expect((await post(body)).status).toBe(500);
  });

  it('validates the body before touching the service', async () => {
    expect((await post({ ...body, reportIds: [R1] })).status).toBe(400);
    expect((await post({ ...body, groupKey: 'nope' })).status).toBe(400);
    expect((await post({ ...body, targetMode: 'everyone' })).status).toBe(400);
    expect(state.combineIntoSeries).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails.**

Run: `cd apps/api && npx vitest run src/routes/reports/seriesCombine.test.ts`
Expected: FAIL with `Failed to resolve import "./seriesCombine"`.

- [ ] **Step 3: Add the schema, the routes, the mount and the MCP entry.**
Append to `seriesSchemas.ts`, reusing its existing `z` import:

```ts
/** Same loose shape the builder and legacyReportConfigSchema accept. */
const combineEmailSchema = z.string().trim().regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/).max(254);

/** POST /reports/series/combine (series W04, spec §3.8). */
export const combineSeriesSchema = z.object({
  groupKey: z.string().regex(/^[0-9a-f]{64}$/),
  reportIds: z.array(z.string().guid()).min(2).max(500),
  name: z.string().trim().min(1).max(255),
  targetMode: z.enum(['selected', 'all']).default('selected'),
  ccResolution: z
    .object({
      include: z.array(combineEmailSchema).max(50).default([]),
      drop: z.array(combineEmailSchema).max(500).default([]),
    })
    .default({ include: [], drop: [] }),
});
export type CombineSeriesBody = z.infer<typeof combineSeriesSchema>;
```


Create `seriesCombine.ts`:

```ts
/**
 * Multi-org report series W04 — Combine routes (spec §3.8). Mounted by
 * series.ts BEFORE its `/:id` routes so `combine-candidates` is never read as
 * a series id. Partner scope only; the partner-wide gate applies to the READ
 * too, because the candidate list spans every org of the partner.
 */
import { Hono } from 'hono';
import { db } from '../../db';
import { authMiddleware, requirePermission, requireScope, type AuthContext } from '../../middleware/auth';
import { writeRouteAudit } from '../../services/auditEvents';
import { PERMISSIONS } from '../../services/permissions';
import {
  canManagePartnerWidePolicies,
  PARTNER_WIDE_WRITE_DENIED_MESSAGE,
  PartnerWideWriteDeniedError,
} from '../../services/partnerWideAccess';
import { combineIntoSeries, findCombineCandidates } from '../../services/reportSeries/combine';
import { ReportSeriesError, seriesErrorResponse } from '../../services/reportSeries/errors';
import { zValidator } from '../../lib/validation';
import { callerMaySetEmailRecipients, RECIPIENTS_NEED_EXPORT_AND_MFA } from './recipientGate';
import { combineSeriesSchema } from './seriesSchemas';

export const seriesCombineRoutes = new Hono();

seriesCombineRoutes.use('*', authMiddleware);

function partnerWideDenied(auth: AuthContext): boolean {
  return auth.scope !== 'partner' || !auth.partnerId || !canManagePartnerWidePolicies(auth);
}

seriesCombineRoutes.get(
  '/combine-candidates',
  requireScope('partner'),
  requirePermission(PERMISSIONS.REPORTS_READ.resource, PERMISSIONS.REPORTS_READ.action),
  async (c) => {
    const auth = c.get('auth');
    if (partnerWideDenied(auth)) return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
    const data = await db.transaction((tx) => findCombineCandidates(auth.partnerId!, tx));
    return c.json({ data });
  },
);

seriesCombineRoutes.post(
  '/combine',
  requireScope('partner'),
  requirePermission(PERMISSIONS.REPORTS_WRITE.resource, PERMISSIONS.REPORTS_WRITE.action),
  zValidator('json', combineSeriesSchema),
  async (c) => {
    const auth = c.get('auth');
    if (partnerWideDenied(auth)) return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
    const body = c.req.valid('json');

    let result: Awaited<ReturnType<typeof combineIntoSeries>>;
    try {
      result = await db.transaction((tx) => combineIntoSeries(
        // W02's gate (routes/reports/recipientGate.ts): reports:export + MFA.
        // Server-derived; the body schema cannot carry it.
        { ...body, callerMaySetEmailRecipients: callerMaySetEmailRecipients(auth) },
        auth,
        tx,
      ));
    } catch (err) {
      // The existing export+MFA refusal body, byte for byte (core.ts clients
      // already key on it); every other series/combine error goes through W02's
      // one mapper.
      if (err instanceof ReportSeriesError && err.code === 'recipients_need_export_and_mfa') {
        return c.json(RECIPIENTS_NEED_EXPORT_AND_MFA, 403);
      }
      if (err instanceof PartnerWideWriteDeniedError) {
        return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
      }
      const mapped = seriesErrorResponse(c, err);
      if (mapped) return mapped;
      throw err;
    }

    writeRouteAudit(c, {
      orgId: null,
      action: 'report_series.combine',
      resourceType: 'report_series',
      resourceId: result.seriesId,
      resourceName: body.name,
      details: {
        partnerId: auth.partnerId,
        groupKey: body.groupKey,
        targetMode: body.targetMode,
        adoptedReportIds: result.adopted.map((a) => a.reportId),
        archivedReportIds: result.archived.map((a) => a.reportId),
        repointedDeliverableIds: result.repointedDeliverableIds,
        ccIncluded: body.ccResolution.include.length,
        ccDropped: body.ccResolution.drop.length,
      },
    });
    for (const adopted of result.adopted) {
      writeRouteAudit(c, {
        orgId: adopted.orgId,
        action: 'report.series_adopt',
        resourceType: 'report',
        resourceId: adopted.reportId,
        details: { seriesId: result.seriesId },
      });
    }
    for (const archived of result.archived) {
      writeRouteAudit(c, {
        orgId: archived.orgId,
        action: 'report.archive',
        resourceType: 'report',
        resourceId: archived.reportId,
        details: { seriesId: result.seriesId, reason: 'combine_duplicate' },
      });
    }
    return c.json(result, 201);
  },
);
```

If Preflight P2 found that W02's `seriesErrorResponse` returns something other than `Response | null` (null meaning "not a series error"), adapt only the three `mapped` lines to its actual contract. If W02's mapper already turns `recipients_need_export_and_mfa` into `RECIPIENTS_NEED_EXPORT_AND_MFA`, delete the special case above it.
In `series.ts`:

1. Add `import { seriesCombineRoutes } from './seriesCombine';`.
2. Immediately after `reportSeriesRoutes.use('*', authMiddleware);`, or before the first `reportSeriesRoutes.get|post|patch|put|delete(` if W02 has no such line, add:

```ts
// Series W04: literal /combine-candidates and /combine segments must be
// registered before `/:id`, which would otherwise swallow them.
reportSeriesRoutes.route('/', seriesCombineRoutes);
```

3. Verify the order:

```bash
grep -n "seriesCombineRoutes\|reportSeriesRoutes\.\(get\|post\|patch\|put\|delete\)(" apps/api/src/routes/reports/series.ts | head -3
```

Expected: the `route('/', seriesCombineRoutes)` line number is smaller than every registration.

In `services/mcpCoverage.ts`, add after the `'reports/runs.ts'` entry, keeping alphabetical order with W02's `reports/series.ts` entry:

```ts
  'reports/seriesCombine.ts': { exempt: 'human_only_migration', note: 'Multi-org report series W04 Combine: an opt-in, one-shot consolidation of existing per-org reports that a human reviews in a dialog (candidate groups, CC resolution) before confirming; spec §3.8 gives it no AI tool and D4 forbids automatic consolidation.' },
```

- [ ] **Step 4: Add the route half of the integration suite.** In `reportSeriesCombine.integration.test.ts`, extend the imports:
  - add `import { Hono } from 'hono';`;
  - change the auth import to `import { authMiddleware, buildDbAccessContext } from '../../middleware/auth';`;
  - add `import { reportRoutes } from '../../routes/reports';` and `import { createAccessToken } from '../../services/jwt';`.

  Then append:

```ts
function buildApp(): Hono {
  const app = new Hono();
  app.use('*', authMiddleware);
  app.route('/reports', reportRoutes);
  return app;
}

async function tokenFor(user: { id: string; email: string }, roleId: string, partnerId: string) {
  return createAccessToken({
    sub: user.id, email: user.email, roleId, orgId: null, partnerId, scope: 'partner',
    mfa: true, aep: 1, mep: 1, sid: randomUUID(),
  });
}

describe('Combine routes on real Postgres (series W04)', () => {
  runDb('GET combine-candidates resolves before /:id and lists the group; POST combines it', async () => {
    const f = await seedFixture();
    const s = await seedGroup(f);
    const app = buildApp();
    const auth = { Authorization: `Bearer ${await tokenFor(f.admin, f.roleId, f.partner.id)}` };

    const listed = await app.request('/reports/series/combine-candidates', { headers: auth });
    expect(listed.status).toBe(200);
    const { data } = await listed.json() as { data: { groupKey: string; orgs: { rows: { reportId: string }[] }[] }[] };
    expect(data).toHaveLength(1);

    const res = await app.request('/reports/series/combine', {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        groupKey: data[0]!.groupKey,
        reportIds: data[0]!.orgs.flatMap((o) => o.rows.map((r) => r.reportId)),
        name: 'Weekly critical alerts',
        ccResolution: { include: [], drop: ['extra@msp.test'] },
      }),
    });
    expect(res.status).toBe(201);
    const created = await res.json() as { seriesId: string };
    expect((await reportRow(s.rA1)).seriesId).toBe(created.seriesId);

    const after = await app.request('/reports/series/combine-candidates', { headers: auth });
    expect((await after.json() as { data: unknown[] }).data).toEqual([]);
  });

  runDb("a 'selected' partner user gets 403 on both routes", async () => {
    const f = await seedFixture();
    await seedGroup(f);
    const app = buildApp();
    const auth = { Authorization: `Bearer ${await tokenFor(f.selected, f.roleId, f.partner.id)}` };
    expect((await app.request('/reports/series/combine-candidates', { headers: auth })).status).toBe(403);
    const res = await app.request('/reports/series/combine', {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupKey: 'a'.repeat(64), reportIds: [randomUUID(), randomUUID()], name: 'x' }),
    });
    expect(res.status).toBe(403);
    expect(await seriesOf(f.partner.id)).toEqual([]);
  });
});
```


- [ ] **Step 5: Run the route test, the contract walkers and the integration suite.**

Run:

```bash
cd apps/api && npx vitest run src/routes/reports/seriesCombine.test.ts \
  src/__tests__/mcp-coverage.test.ts src/__tests__/partner-wide-write-coverage.test.ts \
  src/__tests__/routerAuthGate.contract.test.ts src/routes/reports/partnerOwnedVisibility.scan.test.ts
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/reportSeriesCombine.integration.test.ts
```

Expected: every file passes. The integration suite passes 9 tests.

- [ ] **Step 6: Commit.**

```bash
git add apps/api/src/routes/reports/seriesSchemas.ts \
  apps/api/src/routes/reports/seriesCombine.ts apps/api/src/routes/reports/seriesCombine.test.ts \
  apps/api/src/routes/reports/series.ts apps/api/src/services/mcpCoverage.ts \
  apps/api/src/__tests__/integration/reportSeriesCombine.integration.test.ts
git commit -m "feat(reports): GET combine-candidates + POST combine routes (series W04)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: `CombineDialog`, web types and locale strings

**Files:**
- Modify: `apps/web/src/components/reports/series/types.ts` (append)
- Create: `apps/web/src/components/reports/series/CombineDialog.tsx`
- Test: `apps/web/src/components/reports/series/CombineDialog.test.tsx`
- Modify: `apps/web/src/locales/{en,de-DE,fr-FR,fr-CA,pt-BR,es-419,it-IT,tr-TR}/reports.json`
- Modify: `apps/web/src/lib/__tests__/no-silent-mutations.test.ts`

**Interfaces:**
- Consumes:
  - the `GET`/`POST` contracts from Task 5;
  - `runAction`/`ActionError` (`@/lib/runAction`), `fetchWithAuth`, `Dialog` (`../../shared/Dialog`), `formatDateTime`.
- Produces:
  - `default function CombineDialog(props: { open: boolean; groups: CombineCandidateGroup[]; timezone: string; onClose: () => void; onChanged: () => void })`;
  - the types `CombineCandidateGroup`, `CombineCandidateOrg`, `CombineCandidateRow`, `CombineTargetMode`, `CombineRequest`, `CombineCcConflictBody`.

- [ ] **Step 1: Write the failing test.** This pins Review Focus #5 on the web side.

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const fetchWithAuth = vi.fn();
vi.mock('../../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
vi.mock('../../shared/Toast', () => ({ showToast: vi.fn() }));

import CombineDialog from './CombineDialog';
import type { CombineCandidateGroup } from './types';

const group: CombineCandidateGroup = {
  groupKey: 'a'.repeat(64),
  type: 'alert_summary',
  format: 'pdf',
  schedule: 'weekly',
  suggestedName: 'Weekly alerts',
  orgs: [
    {
      orgId: 'org-a', orgName: 'Acme',
      rows: [
        { reportId: 'rep-a1', name: 'Weekly alerts', lastGeneratedAt: '2026-09-20T08:00:00.000Z', action: 'adopt', deliverableLinked: true,
          contactRecipients: [{ contactId: 'c-1', name: 'Ann', email: 'ann@acme.test' }], emailRecipients: ['cc@msp.test', 'extra@msp.test'] },
        { reportId: 'rep-a2', name: 'Weekly alerts (old)', lastGeneratedAt: null, action: 'archive', deliverableLinked: false,
          contactRecipients: [], emailRecipients: ['cc@msp.test'] },
      ],
    },
    {
      orgId: 'org-b', orgName: 'Bravo',
      rows: [{ reportId: 'rep-b1', name: 'Weekly alerts', lastGeneratedAt: null, action: 'adopt', deliverableLinked: false,
        contactRecipients: [], emailRecipients: ['cc@msp.test'] }],
    },
  ],
  sharedCc: ['cc@msp.test'],
  conflictingCc: [{ email: 'extra@msp.test', reportIds: ['rep-a1'] }],
};

function renderDialog(onChanged = vi.fn()) {
  render(<CombineDialog open groups={[group]} timezone="UTC" onClose={vi.fn()} onChanged={onChanged} />);
  return onChanged;
}

const okResponse = (body: unknown, status = 201) =>
  Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });

describe('CombineDialog (series W04)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows each org with the row kept and the duplicate archived; confirm waits for every CC decision', () => {
    renderDialog();
    expect(screen.getByTestId('combine-row-rep-a1')).toHaveAttribute('data-action', 'adopt');
    expect(screen.getByTestId('combine-row-rep-a2')).toHaveAttribute('data-action', 'archive');
    expect(screen.getByTestId('combine-row-rep-a1-deliverable')).toBeInTheDocument();
    expect(screen.getByTestId('combine-cc-shared')).toHaveTextContent('cc@msp.test');
    expect(screen.getByTestId('combine-name')).toHaveValue('Weekly alerts');
    expect(screen.getByTestId('combine-target-selected')).toBeChecked();
    expect(screen.getByTestId('combine-confirm')).toBeDisabled();
    fireEvent.click(screen.getByTestId('combine-cc-drop-extra@msp.test'));
    expect(screen.getByTestId('combine-confirm')).toBeEnabled();
  });

  it('posts exactly the group it showed, with the CC decisions', async () => {
    fetchWithAuth.mockReturnValue(okResponse({ seriesId: 's-1', adopted: [], archived: [], repointedDeliverableIds: [] }));
    const onChanged = renderDialog();
    fireEvent.click(screen.getByTestId('combine-cc-include-extra@msp.test'));
    fireEvent.change(screen.getByTestId('combine-name'), { target: { value: '  Weekly critical alerts ' } });
    fireEvent.click(screen.getByTestId('combine-confirm'));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    const [url, init] = fetchWithAuth.mock.calls[0]!;
    expect(url).toBe('/reports/series/combine');
    expect(init).toMatchObject({ method: 'POST', skipOrgIdInjection: true });
    expect(JSON.parse(init.body)).toEqual({
      groupKey: group.groupKey,
      reportIds: ['rep-a1', 'rep-a2', 'rep-b1'],
      name: 'Weekly critical alerts',
      targetMode: 'selected',
      ccResolution: { include: ['extra@msp.test'], drop: [] },
    });
  });

  it('warns before switching to all organizations', () => {
    renderDialog();
    expect(screen.queryByTestId('combine-target-all-warning')).toBeNull();
    fireEvent.click(screen.getByTestId('combine-target-all'));
    expect(screen.getByTestId('combine-target-all-warning')).toBeInTheDocument();
  });

  it('marks the addresses the server still considers unresolved and stays open', async () => {
    fetchWithAuth.mockReturnValue(okResponse({
      error: 'combine_cc_conflict', shared: ['cc@msp.test'], unresolved: [{ email: 'extra@msp.test', reportIds: ['rep-a1'] }], unexpected: [],
    }, 409));
    const onChanged = renderDialog();
    fireEvent.click(screen.getByTestId('combine-cc-drop-extra@msp.test'));
    fireEvent.click(screen.getByTestId('combine-confirm'));
    await waitFor(() => expect(screen.getByTestId('combine-cc-extra@msp.test')).toHaveAttribute('data-server-unresolved', 'true'));
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('refreshes the parent when the group changed underneath the dialog', async () => {
    fetchWithAuth.mockReturnValue(okResponse({ error: 'combine_group_changed' }, 409));
    const onChanged = renderDialog();
    fireEvent.click(screen.getByTestId('combine-cc-drop-extra@msp.test'));
    fireEvent.click(screen.getByTestId('combine-confirm'));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });
});
```

- [ ] **Step 2: Run it and confirm it fails.**

Run: `cd apps/web && npx vitest run src/components/reports/series/CombineDialog.test.tsx`
Expected: FAIL with `Failed to resolve import "./CombineDialog"`.

- [ ] **Step 3: Append the types to `series/types.ts`.**

```ts
// ── Series W04: Combine (mirrors apps/api/src/services/reportSeries/combinePlan.ts) ──
export type CombineTargetMode = 'selected' | 'all';

export interface CombineCandidateRow {
  reportId: string;
  name: string;
  lastGeneratedAt: string | null;
  action: 'adopt' | 'archive';
  deliverableLinked: boolean;
  contactRecipients: { contactId: string; name: string | null; email: string | null }[];
  emailRecipients: string[];
}

export interface CombineCandidateOrg {
  orgId: string;
  orgName: string;
  rows: CombineCandidateRow[];
}

export interface CombineCandidateGroup {
  groupKey: string;
  type: string;
  format: 'csv' | 'pdf' | 'excel';
  schedule: 'daily' | 'weekly' | 'monthly';
  suggestedName: string;
  orgs: CombineCandidateOrg[];
  sharedCc: string[];
  conflictingCc: { email: string; reportIds: string[] }[];
}

export interface CombineRequest {
  groupKey: string;
  reportIds: string[];
  name: string;
  targetMode: CombineTargetMode;
  ccResolution: { include: string[]; drop: string[] };
}

export interface CombineCcConflictBody {
  error: 'combine_cc_conflict';
  shared: string[];
  unresolved: { email: string; reportIds: string[] }[];
  unexpected: string[];
}
```

- [ ] **Step 4: Create `CombineDialog.tsx`.**

```tsx
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../../stores/auth';
import { ActionError, runAction } from '@/lib/runAction';
import { formatDateTime } from '@/lib/dateTimeFormat';
import { showToast } from '../../shared/Toast';
import { Dialog } from '../../shared/Dialog';
import type { CombineCandidateGroup, CombineCcConflictBody, CombineRequest, CombineTargetMode } from './types';

type CcChoice = 'include' | 'drop';

export interface CombineDialogProps {
  open: boolean;
  groups: CombineCandidateGroup[];
  timezone: string;
  onClose: () => void;
  /** After a successful combine, or when the server says the group changed:
   *  the parent closes the dialog and refetches. */
  onChanged: () => void;
}

/**
 * Series W04 (spec §3.8): combine one group of near-identical per-org reports
 * into a multi-org report. Defaults send nothing new: target = exactly these
 * orgs, recipient rule off, each org keeps its contacts. The user must decide
 * every CC address that is on some rows only.
 */
export default function CombineDialog({ open, groups, timezone, onClose, onChanged }: CombineDialogProps) {
  const { t } = useTranslation(['reports', 'common']);
  const [groupKey, setGroupKey] = useState(groups[0]?.groupKey ?? '');
  const group = groups.find((g) => g.groupKey === groupKey) ?? groups[0];
  const [name, setName] = useState(group?.suggestedName ?? '');
  const [targetMode, setTargetMode] = useState<CombineTargetMode>('selected');
  const [ccChoices, setCcChoices] = useState<Record<string, CcChoice>>({});
  const [serverUnresolved, setServerUnresolved] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const acting = useRef(false);

  useEffect(() => {
    setName(group?.suggestedName ?? '');
    setTargetMode('selected');
    setCcChoices({});
    setServerUnresolved([]);
  }, [group?.groupKey, group?.suggestedName]);

  if (!group) return null;

  const unresolved = group.conflictingCc.filter((c) => !ccChoices[c.email]);
  const canConfirm = !busy && name.trim().length > 0 && unresolved.length === 0;
  const typeLabel = t(/* i18n-dynamic */ `reports.reportsList.reportTypes.${group.type}`);
  const scheduleLabel = t(/* i18n-dynamic */ `reports.reportsList.schedules.${group.schedule}`);

  const confirm = async () => {
    if (!canConfirm || acting.current) return;
    acting.current = true;
    setBusy(true);
    const body: CombineRequest = {
      groupKey: group.groupKey,
      reportIds: group.orgs.flatMap((o) => o.rows.map((r) => r.reportId)),
      name: name.trim(),
      targetMode,
      ccResolution: {
        include: group.conflictingCc.filter((c) => ccChoices[c.email] === 'include').map((c) => c.email),
        drop: group.conflictingCc.filter((c) => ccChoices[c.email] === 'drop').map((c) => c.email),
      },
    };
    try {
      await runAction({
        request: () => fetchWithAuth('/reports/series/combine', {
          method: 'POST',
          body: JSON.stringify(body),
          skipOrgIdInjection: true,
        }),
        errorFallback: t('reports.seriesCombine.failed'),
        successMessage: t('reports.seriesCombine.success', { name: body.name }),
        friendly: (code) => {
          if (code === 'combine_cc_conflict') return t('reports.seriesCombine.ccUnresolved');
          if (code === 'combine_group_changed') return t('reports.seriesCombine.groupChanged');
          return undefined;
        },
      });
      onChanged();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (err instanceof ActionError && err.status === 409) {
        const conflict = err.body as Partial<CombineCcConflictBody> | undefined;
        if (conflict?.error === 'combine_cc_conflict') {
          setServerUnresolved((conflict.unresolved ?? []).map((u) => u.email));
        } else {
          onChanged();
        }
        return;
      }
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: t('reports.seriesCombine.failed') });
    } finally {
      acting.current = false;
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={() => { if (!busy) onClose(); }} title={t('reports.seriesCombine.title')} maxWidth="3xl" className="p-6">
      <div data-testid="combine-dialog" className="space-y-5 text-sm">
        <h2 className="text-lg font-semibold">{t('reports.seriesCombine.title')}</h2>

        {groups.length > 1 && (
          <label className="block space-y-1">
            <span className="font-medium">{t('reports.seriesCombine.groupLabel')}</span>
            <select
              data-testid="combine-group-select"
              value={group.groupKey}
              onChange={(e) => setGroupKey(e.target.value)}
              className="h-9 w-full rounded-md border bg-background px-2"
            >
              {groups.map((g) => (
                <option key={g.groupKey} value={g.groupKey}>{g.suggestedName}</option>
              ))}
            </select>
          </label>
        )}
        <p data-testid="combine-group-summary" className="text-muted-foreground">
          {t('reports.seriesCombine.groupSummary', { type: typeLabel, schedule: scheduleLabel, orgs: group.orgs.length })}
        </p>

        <ul className="max-h-72 space-y-2 overflow-y-auto">
          {group.orgs.map((org) => (
            <li key={org.orgId} data-testid={`combine-org-${org.orgId}`} className="rounded-md border px-3 py-2">
              <div className="font-medium">{org.orgName}</div>
              <ul className="mt-1 space-y-1">
                {org.rows.map((row) => (
                  <li key={row.reportId} data-testid={`combine-row-${row.reportId}`} data-action={row.action} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span>{row.name}</span>
                    <span className={row.action === 'adopt' ? 'text-success' : 'text-muted-foreground'}>
                      {t(/* i18n-dynamic */ `reports.seriesCombine.${row.action}`)}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {row.lastGeneratedAt
                        ? t('reports.seriesCombine.lastRun', { date: formatDateTime(row.lastGeneratedAt, { timeZone: timezone }) })
                        : t('reports.seriesCombine.neverRun')}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {row.contactRecipients.length > 0
                        ? t('reports.seriesCombine.contacts', { list: row.contactRecipients.map((r) => r.name ?? r.email ?? r.contactId).join(', ') })
                        : t('reports.seriesCombine.noContacts')}
                    </span>
                    {row.deliverableLinked && (
                      <span data-testid={`combine-row-${row.reportId}-deliverable`} className="text-xs">
                        {t('reports.seriesCombine.deliverableLinked')}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>

        <label className="block space-y-1">
          <span className="font-medium">{t('reports.seriesCombine.nameLabel')}</span>
          <input
            data-testid="combine-name"
            value={name}
            maxLength={255}
            onChange={(e) => setName(e.target.value)}
            className="h-9 w-full rounded-md border bg-background px-2"
          />
        </label>

        <fieldset className="space-y-1">
          <legend className="font-medium">{t('reports.seriesCombine.targetLegend')}</legend>
          <label className="flex items-center gap-2">
            <input type="radio" name="combine-target" data-testid="combine-target-selected" checked={targetMode === 'selected'} onChange={() => setTargetMode('selected')} />
            {t('reports.seriesCombine.targetSelected')}
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name="combine-target" data-testid="combine-target-all" checked={targetMode === 'all'} onChange={() => setTargetMode('all')} />
            {t('reports.seriesCombine.targetAll')}
          </label>
          {targetMode === 'all' && (
            <p data-testid="combine-target-all-warning" role="status" className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2">
              {t('reports.seriesCombine.targetAllWarning')}
            </p>
          )}
        </fieldset>

        <div className="space-y-2">
          <p data-testid="combine-cc-shared">
            {group.sharedCc.length > 0
              ? t('reports.seriesCombine.ccShared', { list: group.sharedCc.join(', ') })
              : t('reports.seriesCombine.ccNone')}
          </p>
          {group.conflictingCc.length > 0 && (
            <div className="space-y-2">
              <p>{t('reports.seriesCombine.ccConflictHeading')}</p>
              {group.conflictingCc.map((cc) => (
                <div
                  key={cc.email}
                  data-testid={`combine-cc-${cc.email}`}
                  data-server-unresolved={serverUnresolved.includes(cc.email) ? 'true' : 'false'}
                  className={serverUnresolved.includes(cc.email) ? 'rounded-md border border-destructive/60 px-3 py-2' : 'rounded-md border px-3 py-2'}
                >
                  <span className="font-mono text-xs">{cc.email}</span>
                  <div className="mt-1 flex flex-wrap gap-4">
                    <label className="flex items-center gap-2">
                      <input type="radio" name={`combine-cc-${cc.email}`} data-testid={`combine-cc-include-${cc.email}`}
                        checked={ccChoices[cc.email] === 'include'}
                        onChange={() => setCcChoices((prev) => ({ ...prev, [cc.email]: 'include' }))} />
                      {t('reports.seriesCombine.ccInclude')}
                    </label>
                    <label className="flex items-center gap-2">
                      <input type="radio" name={`combine-cc-${cc.email}`} data-testid={`combine-cc-drop-${cc.email}`}
                        checked={ccChoices[cc.email] === 'drop'}
                        onChange={() => setCcChoices((prev) => ({ ...prev, [cc.email]: 'drop' }))} />
                      {t('reports.seriesCombine.ccDrop')}
                    </label>
                  </div>
                </div>
              ))}
              {unresolved.length > 0 && (
                <p data-testid="combine-cc-unresolved" className="text-xs text-muted-foreground">{t('reports.seriesCombine.ccUnresolved')}</p>
              )}
            </div>
          )}
        </div>

        <p data-testid="combine-rule-note" className="text-xs text-muted-foreground">{t('reports.seriesCombine.ruleNote')}</p>

        <div className="flex justify-end gap-2">
          <button type="button" data-testid="combine-cancel" disabled={busy} onClick={onClose} className="h-9 rounded-md border px-4">
            {t('common:actions.cancel')}
          </button>
          <button type="button" data-testid="combine-confirm" disabled={!canConfirm} onClick={() => void confirm()}
            className="h-9 rounded-md bg-primary px-4 font-medium text-primary-foreground disabled:opacity-60">
            {t('reports.seriesCombine.confirm')}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
```

- [ ] **Step 5: Add the locale strings.** Add each block below as a new key `seriesCombine` inside the top-level `reports` object of the matching `apps/web/src/locales/<locale>/reports.json`. If W03 translated "multi-org" differently, align these values with W03's wording (Preflight P3).

`en`:

```json
"seriesCombine": {
  "banner": "Some organizations have near-identical reports that could be combined into one multi-org report. Groups found: {{groups}}",
  "review": "Review",
  "title": "Combine into one multi-org report",
  "groupLabel": "Group",
  "groupSummary": "{{type}} · {{schedule}} · organizations: {{orgs}}",
  "nameLabel": "Multi-org report name",
  "targetLegend": "Organizations covered",
  "targetSelected": "Only these organizations (nothing new is sent)",
  "targetAll": "All organizations, including ones added later",
  "targetAllWarning": "Organizations without a copy today start receiving this report, with only the internal CC until you add customer recipients.",
  "adopt": "Kept and converted",
  "archive": "Duplicate, will be archived",
  "deliverableLinked": "Used as service deliverable evidence",
  "lastRun": "Last run {{date}}",
  "neverRun": "Never run",
  "contacts": "Customer recipients: {{list}}",
  "noContacts": "No customer recipients",
  "ccShared": "Internal CC on every copy: {{list}}",
  "ccNone": "No internal CC",
  "ccConflictHeading": "These CC addresses are only on some of these reports. Choose what happens to each:",
  "ccInclude": "CC every copy",
  "ccDrop": "Stop CC-ing",
  "ccUnresolved": "Choose what happens to every CC address before combining.",
  "ruleNote": "Every customer keeps exactly the recipients they have today. You can add a recipient rule later on the multi-org report.",
  "confirm": "Combine",
  "success": "Combined into “{{name}}”",
  "failed": "Could not combine these reports.",
  "groupChanged": "These reports changed since you opened this dialog. The list has been refreshed."
}
```

`de-DE`:

```json
"seriesCombine": {
  "banner": "Einige Organisationen haben nahezu identische Berichte, die zu einem organisationsübergreifenden Bericht zusammengeführt werden können. Gefundene Gruppen: {{groups}}",
  "review": "Prüfen",
  "title": "Zu einem organisationsübergreifenden Bericht zusammenführen",
  "groupLabel": "Gruppe",
  "groupSummary": "{{type}} · {{schedule}} · Organisationen: {{orgs}}",
  "nameLabel": "Name des organisationsübergreifenden Berichts",
  "targetLegend": "Abgedeckte Organisationen",
  "targetSelected": "Nur diese Organisationen (es wird nichts Neues versendet)",
  "targetAll": "Alle Organisationen, auch später hinzugefügte",
  "targetAllWarning": "Organisationen ohne eigene Kopie erhalten diesen Bericht künftig – nur an die interne CC, bis Sie Kundenempfänger hinzufügen.",
  "adopt": "Wird übernommen und umgewandelt",
  "archive": "Duplikat, wird archiviert",
  "deliverableLinked": "Dient als Nachweis für eine Serviceleistung",
  "lastRun": "Letzter Lauf {{date}}",
  "neverRun": "Noch nie ausgeführt",
  "contacts": "Kundenempfänger: {{list}}",
  "noContacts": "Keine Kundenempfänger",
  "ccShared": "Interne CC auf jeder Kopie: {{list}}",
  "ccNone": "Keine interne CC",
  "ccConflictHeading": "Diese CC-Adressen stehen nur auf einigen dieser Berichte. Legen Sie für jede fest, was geschehen soll:",
  "ccInclude": "Jede Kopie in CC",
  "ccDrop": "Nicht mehr in CC",
  "ccUnresolved": "Legen Sie vor dem Zusammenführen für jede CC-Adresse fest, was geschehen soll.",
  "ruleNote": "Jeder Kunde behält genau die Empfänger, die er heute hat. Eine Empfängerregel können Sie später im organisationsübergreifenden Bericht hinzufügen.",
  "confirm": "Zusammenführen",
  "success": "Zusammengeführt zu „{{name}}“",
  "failed": "Diese Berichte konnten nicht zusammengeführt werden.",
  "groupChanged": "Diese Berichte haben sich seit dem Öffnen des Dialogs geändert. Die Liste wurde aktualisiert."
}
```

`fr-FR`, and `fr-CA` identically:

```json
"seriesCombine": {
  "banner": "Certaines organisations ont des rapports quasi identiques qui peuvent être regroupés en un rapport multi-organisations. Groupes trouvés : {{groups}}",
  "review": "Examiner",
  "title": "Regrouper en un rapport multi-organisations",
  "groupLabel": "Groupe",
  "groupSummary": "{{type}} · {{schedule}} · organisations : {{orgs}}",
  "nameLabel": "Nom du rapport multi-organisations",
  "targetLegend": "Organisations couvertes",
  "targetSelected": "Uniquement ces organisations (aucun nouvel envoi)",
  "targetAll": "Toutes les organisations, y compris celles ajoutées plus tard",
  "targetAllWarning": "Les organisations sans copie aujourd'hui commenceront à recevoir ce rapport, uniquement en copie interne tant que vous n'aurez pas ajouté de destinataires clients.",
  "adopt": "Conservé et converti",
  "archive": "Doublon, sera archivé",
  "deliverableLinked": "Utilisé comme preuve d'une prestation de service",
  "lastRun": "Dernière exécution {{date}}",
  "neverRun": "Jamais exécuté",
  "contacts": "Destinataires clients : {{list}}",
  "noContacts": "Aucun destinataire client",
  "ccShared": "Copie interne sur chaque exemplaire : {{list}}",
  "ccNone": "Aucune copie interne",
  "ccConflictHeading": "Ces adresses en copie ne figurent que sur certains de ces rapports. Choisissez le sort de chacune :",
  "ccInclude": "En copie sur chaque exemplaire",
  "ccDrop": "Retirer de la copie",
  "ccUnresolved": "Choisissez le sort de chaque adresse en copie avant de regrouper.",
  "ruleNote": "Chaque client conserve exactement ses destinataires actuels. Vous pourrez ajouter une règle de destinataires plus tard dans le rapport multi-organisations.",
  "confirm": "Regrouper",
  "success": "Regroupé dans « {{name}} »",
  "failed": "Impossible de regrouper ces rapports.",
  "groupChanged": "Ces rapports ont changé depuis l'ouverture de cette fenêtre. La liste a été actualisée."
}
```

`pt-BR`:

```json
"seriesCombine": {
  "banner": "Algumas organizações têm relatórios quase idênticos que podem ser combinados em um relatório multiorganização. Grupos encontrados: {{groups}}",
  "review": "Revisar",
  "title": "Combinar em um relatório multiorganização",
  "groupLabel": "Grupo",
  "groupSummary": "{{type}} · {{schedule}} · organizações: {{orgs}}",
  "nameLabel": "Nome do relatório multiorganização",
  "targetLegend": "Organizações abrangidas",
  "targetSelected": "Somente estas organizações (nada novo é enviado)",
  "targetAll": "Todas as organizações, inclusive as adicionadas depois",
  "targetAllWarning": "Organizações sem uma cópia hoje passarão a receber este relatório, apenas com a cópia interna até você adicionar destinatários do cliente.",
  "adopt": "Mantido e convertido",
  "archive": "Duplicado, será arquivado",
  "deliverableLinked": "Usado como evidência de uma entrega de serviço",
  "lastRun": "Última execução {{date}}",
  "neverRun": "Nunca executado",
  "contacts": "Destinatários do cliente: {{list}}",
  "noContacts": "Nenhum destinatário do cliente",
  "ccShared": "Cópia interna em todas as cópias: {{list}}",
  "ccNone": "Sem cópia interna",
  "ccConflictHeading": "Estes endereços em cópia aparecem só em alguns destes relatórios. Escolha o que acontece com cada um:",
  "ccInclude": "Copiar em todas",
  "ccDrop": "Deixar de copiar",
  "ccUnresolved": "Escolha o que acontece com cada endereço em cópia antes de combinar.",
  "ruleNote": "Cada cliente mantém exatamente os destinatários que tem hoje. Você pode adicionar uma regra de destinatários depois, no relatório multiorganização.",
  "confirm": "Combinar",
  "success": "Combinado em “{{name}}”",
  "failed": "Não foi possível combinar estes relatórios.",
  "groupChanged": "Estes relatórios mudaram desde que você abriu esta janela. A lista foi atualizada."
}
```

`es-419`:

```json
"seriesCombine": {
  "banner": "Algunas organizaciones tienen informes casi idénticos que se pueden combinar en un informe multiorganización. Grupos encontrados: {{groups}}",
  "review": "Revisar",
  "title": "Combinar en un informe multiorganización",
  "groupLabel": "Grupo",
  "groupSummary": "{{type}} · {{schedule}} · organizaciones: {{orgs}}",
  "nameLabel": "Nombre del informe multiorganización",
  "targetLegend": "Organizaciones incluidas",
  "targetSelected": "Solo estas organizaciones (no se envía nada nuevo)",
  "targetAll": "Todas las organizaciones, incluidas las que se agreguen después",
  "targetAllWarning": "Las organizaciones que hoy no tienen una copia empezarán a recibir este informe, solo con la copia interna hasta que agregues destinatarios del cliente.",
  "adopt": "Se conserva y se convierte",
  "archive": "Duplicado, se archivará",
  "deliverableLinked": "Se usa como evidencia de una entrega de servicio",
  "lastRun": "Última ejecución {{date}}",
  "neverRun": "Nunca se ejecutó",
  "contacts": "Destinatarios del cliente: {{list}}",
  "noContacts": "Sin destinatarios del cliente",
  "ccShared": "Copia interna en cada copia: {{list}}",
  "ccNone": "Sin copia interna",
  "ccConflictHeading": "Estas direcciones en copia solo están en algunos de estos informes. Elige qué pasa con cada una:",
  "ccInclude": "Copiar en todas",
  "ccDrop": "Dejar de copiar",
  "ccUnresolved": "Elige qué pasa con cada dirección en copia antes de combinar.",
  "ruleNote": "Cada cliente conserva exactamente los destinatarios que tiene hoy. Puedes agregar una regla de destinatarios más adelante en el informe multiorganización.",
  "confirm": "Combinar",
  "success": "Combinado en “{{name}}”",
  "failed": "No se pudieron combinar estos informes.",
  "groupChanged": "Estos informes cambiaron desde que abriste esta ventana. La lista se actualizó."
}
```

`it-IT`:

```json
"seriesCombine": {
  "banner": "Alcune organizzazioni hanno report quasi identici che possono essere uniti in un unico report multi-organizzazione. Gruppi trovati: {{groups}}",
  "review": "Esamina",
  "title": "Unisci in un report multi-organizzazione",
  "groupLabel": "Gruppo",
  "groupSummary": "{{type}} · {{schedule}} · organizzazioni: {{orgs}}",
  "nameLabel": "Nome del report multi-organizzazione",
  "targetLegend": "Organizzazioni incluse",
  "targetSelected": "Solo queste organizzazioni (non viene inviato nulla di nuovo)",
  "targetAll": "Tutte le organizzazioni, comprese quelle aggiunte in seguito",
  "targetAllWarning": "Le organizzazioni che oggi non hanno una copia inizieranno a ricevere questo report, solo con la copia interna finché non aggiungi destinatari del cliente.",
  "adopt": "Mantenuto e convertito",
  "archive": "Duplicato, verrà archiviato",
  "deliverableLinked": "Usato come prova di una prestazione di servizio",
  "lastRun": "Ultima esecuzione {{date}}",
  "neverRun": "Mai eseguito",
  "contacts": "Destinatari del cliente: {{list}}",
  "noContacts": "Nessun destinatario del cliente",
  "ccShared": "Copia interna su ogni copia: {{list}}",
  "ccNone": "Nessuna copia interna",
  "ccConflictHeading": "Questi indirizzi in copia sono presenti solo in alcuni di questi report. Scegli cosa fare con ciascuno:",
  "ccInclude": "In copia su tutte",
  "ccDrop": "Togli dalla copia",
  "ccUnresolved": "Scegli cosa fare con ogni indirizzo in copia prima di unire.",
  "ruleNote": "Ogni cliente mantiene esattamente i destinatari che ha oggi. Puoi aggiungere una regola per i destinatari in seguito nel report multi-organizzazione.",
  "confirm": "Unisci",
  "success": "Uniti in “{{name}}”",
  "failed": "Impossibile unire questi report.",
  "groupChanged": "Questi report sono cambiati da quando hai aperto questa finestra. L'elenco è stato aggiornato."
}
```

`tr-TR`:

```json
"seriesCombine": {
  "banner": "Bazı kuruluşların tek bir çok kuruluşlu rapor altında birleştirilebilecek neredeyse aynı raporları var. Bulunan gruplar: {{groups}}",
  "review": "İncele",
  "title": "Tek bir çok kuruluşlu raporda birleştir",
  "groupLabel": "Grup",
  "groupSummary": "{{type}} · {{schedule}} · kuruluşlar: {{orgs}}",
  "nameLabel": "Çok kuruluşlu rapor adı",
  "targetLegend": "Kapsanan kuruluşlar",
  "targetSelected": "Yalnızca bu kuruluşlar (yeni bir şey gönderilmez)",
  "targetAll": "Sonradan eklenenler dahil tüm kuruluşlar",
  "targetAllWarning": "Bugün kopyası olmayan kuruluşlar bu raporu almaya başlar; müşteri alıcıları ekleyene kadar yalnızca dahili bilgi kopyası alıcılarına gönderilir.",
  "adopt": "Korunur ve dönüştürülür",
  "archive": "Yinelenen, arşivlenecek",
  "deliverableLinked": "Hizmet teslimatı kanıtı olarak kullanılıyor",
  "lastRun": "Son çalıştırma {{date}}",
  "neverRun": "Hiç çalıştırılmadı",
  "contacts": "Müşteri alıcıları: {{list}}",
  "noContacts": "Müşteri alıcısı yok",
  "ccShared": "Her kopyadaki dahili bilgi kopyası: {{list}}",
  "ccNone": "Dahili bilgi kopyası yok",
  "ccConflictHeading": "Bu bilgi kopyası adresleri bu raporların yalnızca bazılarında var. Her biri için ne olacağını seçin:",
  "ccInclude": "Her kopyaya ekle",
  "ccDrop": "Bilgi kopyasından çıkar",
  "ccUnresolved": "Birleştirmeden önce her bilgi kopyası adresi için ne olacağını seçin.",
  "ruleNote": "Her müşteri bugün sahip olduğu alıcıları aynen korur. Alıcı kuralını daha sonra çok kuruluşlu raporda ekleyebilirsiniz.",
  "confirm": "Birleştir",
  "success": "“{{name}}” içinde birleştirildi",
  "failed": "Bu raporlar birleştirilemedi.",
  "groupChanged": "Bu raporlar pencereyi açtığınızdan beri değişti. Liste yenilendi."
}
```

- [ ] **Step 6: Guard the dialog's mutation.** In `no-silent-mutations.test.ts`:

1. Add the dialog to `TARGET_GLOBS`, right after the `'src/components/reports/ReportTemplates.tsx',` entry:

```ts
  // Multi-org report series W04 (Combine): the combine POST rewrites and
  // archives existing reports across orgs; a silent failure would read as
  // "combined" while every duplicate keeps sending.
  'src/components/reports/series/CombineDialog.tsx',
```

2. Bump the count literal from N (noted in P3) to N+1, with a comment line in the same style:
   `// Multi-org report series W04 adds reports/series/CombineDialog.tsx: N → N+1.`

- [ ] **Step 7: Run the dialog, i18n and guard tests.**

Run: `cd apps/web && npx vitest run src/components/reports/series/CombineDialog.test.tsx src/lib/i18n src/lib/__tests__/no-silent-mutations.test.ts`
Expected: PASS. `localeParity` requires the same keys in all 8 locales. `translationCoverage` needs every translated value to differ from English, and it does. `keyUsage` finds every static `reports.seriesCombine.*` key. `no-silent-mutations` reports N+1 files.

- [ ] **Step 8: Commit.**

```bash
git add apps/web/src/components/reports/series/types.ts apps/web/src/components/reports/series/CombineDialog.tsx \
  apps/web/src/components/reports/series/CombineDialog.test.tsx apps/web/src/locales/*/reports.json \
  apps/web/src/lib/__tests__/no-silent-mutations.test.ts
git commit -m "feat(web): CombineDialog for multi-org report series (W04)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: `CombineBanner`, mounted in `ReportsList`

**Files:**
- Create: `apps/web/src/components/reports/series/CombineBanner.tsx` and `CombineBanner.test.tsx`
- Modify: `apps/web/src/components/reports/ReportsList.tsx`. Add one import, one derived boolean next to `mergePartnerWide` (around line 163), and one element directly after the `partnerWideIncomplete` paragraph (around line 551).
- Test: `apps/web/src/components/reports/ReportsList.combine.test.tsx`

**Interfaces:**
- Consumes: `CombineDialog` (Task 6); `GET /reports/series/combine-candidates` (Task 5).
- Produces: `default function CombineBanner(props: { timezone: string; onCombined: () => void })`.

- [ ] **Step 1: Write the failing tests.**

```tsx
// apps/web/src/components/reports/series/CombineBanner.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const fetchWithAuth = vi.fn();
vi.mock('../../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
vi.mock('./CombineDialog', () => ({
  default: ({ onChanged }: { onChanged: () => void }) => <button type="button" data-testid="combine-dialog-stub" onClick={onChanged} />,
}));

import CombineBanner from './CombineBanner';

const groups = [{ groupKey: 'a'.repeat(64) }, { groupKey: 'b'.repeat(64) }];
const respond = (data: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ data }) });

describe('CombineBanner (series W04)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders nothing when there is nothing to combine', async () => {
    fetchWithAuth.mockReturnValue(respond([]));
    render(<CombineBanner timezone="UTC" onCombined={vi.fn()} />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalled());
    expect(screen.queryByTestId('reports-combine-banner')).toBeNull();
  });

  it('fetches cross-org (no ambient org injection) and opens the dialog', async () => {
    fetchWithAuth.mockReturnValue(respond(groups));
    render(<CombineBanner timezone="UTC" onCombined={vi.fn()} />);
    expect(await screen.findByTestId('reports-combine-banner')).toBeInTheDocument();
    expect(fetchWithAuth).toHaveBeenCalledWith('/reports/series/combine-candidates', { skipOrgIdInjection: true });
    fireEvent.click(screen.getByTestId('reports-combine-review'));
    expect(screen.getByTestId('combine-dialog-stub')).toBeInTheDocument();
  });

  it('after a combine: refreshes the list and its own candidates, closes the dialog', async () => {
    fetchWithAuth.mockReturnValueOnce(respond(groups)).mockReturnValueOnce(respond([]));
    const onCombined = vi.fn();
    render(<CombineBanner timezone="UTC" onCombined={onCombined} />);
    fireEvent.click(await screen.findByTestId('reports-combine-review'));
    fireEvent.click(screen.getByTestId('combine-dialog-stub'));
    expect(onCombined).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByTestId('reports-combine-banner')).toBeNull());
    expect(fetchWithAuth).toHaveBeenCalledTimes(2);
  });

  it('a failed candidate fetch hides the banner and never throws', async () => {
    fetchWithAuth.mockReturnValue(Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) }));
    render(<CombineBanner timezone="UTC" onCombined={vi.fn()} />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalled());
    expect(screen.queryByTestId('reports-combine-banner')).toBeNull();
  });
});
```

```tsx
// apps/web/src/components/reports/ReportsList.combine.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const fetchWithAuth = vi.fn();
const authUser = vi.hoisted(() => ({ canManagePartnerWide: true as boolean | undefined }));
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a),
  useAuthStore: (selector: (s: { user: { canManagePartnerWide?: boolean } }) => unknown) =>
    selector({ user: { canManagePartnerWide: authUser.canManagePartnerWide } }),
}));
vi.mock('./reportExport', () => ({ exportReport: vi.fn(), downloadBlob: vi.fn(), getBrowserTimezone: () => 'UTC' }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
const claims = vi.hoisted(() => ({ value: undefined as unknown }));
vi.mock('@/lib/authScope', () => ({ useJwtClaims: () => claims.value }));
const org = vi.hoisted(() => ({ currentOrgId: null as string | null }));
vi.mock('../../stores/orgStore', () => ({ useOrgStore: () => ({ currentOrgId: org.currentOrgId }) }));
vi.mock('./series/CombineBanner', () => ({ default: () => <div data-testid="combine-banner-stub" /> }));

import ReportsList from './ReportsList';

const row = {
  id: 'rep-o', name: 'Acme alerts', type: 'alert_summary', schedule: 'weekly', format: 'pdf', config: {},
  orgId: 'org-1', partnerId: null, portalSelfService: false, lastGeneratedAt: null,
  createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
};

function mockList() {
  fetchWithAuth.mockImplementation((url: string) => {
    if (url === '/reports' || url.startsWith('/reports?')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [row] }) });
    if (url.startsWith('/reports/runs?')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [] }) });
    return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
  });
}

describe('ReportsList Combine banner mount (series W04)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    claims.value = { status: 'resolved', claims: { scope: 'partner', orgId: null, partnerId: 'p-1' } };
    org.currentOrgId = null;
    authUser.canManagePartnerWide = true;
    mockList();
  });

  it('shows the banner to a full-access partner user under All organizations', async () => {
    render(<ReportsList />);
    await screen.findByTestId('report-row-rep-o');
    expect(screen.getByTestId('combine-banner-stub')).toBeInTheDocument();
  });

  it('hides it when one organization is focused', async () => {
    org.currentOrgId = 'org-1';
    render(<ReportsList />);
    await screen.findByTestId('report-row-rep-o');
    expect(screen.queryByTestId('combine-banner-stub')).toBeNull();
  });

  it('hides it from a partner user without partner-wide access', async () => {
    authUser.canManagePartnerWide = false;
    render(<ReportsList />);
    await screen.findByTestId('report-row-rep-o');
    expect(screen.queryByTestId('combine-banner-stub')).toBeNull();
  });

  it('hides it from an organization-scope user', async () => {
    claims.value = { status: 'resolved', claims: { scope: 'organization', orgId: 'org-1', partnerId: 'p-1' } };
    render(<ReportsList />);
    await screen.findByTestId('report-row-rep-o');
    expect(screen.queryByTestId('combine-banner-stub')).toBeNull();
  });
});
```

- [ ] **Step 2: Run them and confirm they fail.**

Run: `cd apps/web && npx vitest run src/components/reports/series/CombineBanner.test.tsx src/components/reports/ReportsList.combine.test.tsx`
Expected: FAIL. `CombineBanner.test.tsx` cannot resolve `./CombineBanner`. `ReportsList.combine.test.tsx` fails on `combine-banner-stub` not being found.

- [ ] **Step 3: Create `CombineBanner.tsx` and mount it.**

```tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../../stores/auth';
import CombineDialog from './CombineDialog';
import type { CombineCandidateGroup } from './types';

/**
 * Series W04 (spec §3.8): "N groups of near-identical reports could be
 * combined." A suggestion surface only — a failed candidate fetch hides the
 * banner and never touches the list. Cross-org by definition, so the ambient
 * org injection is skipped.
 */
export default function CombineBanner({ timezone, onCombined }: { timezone: string; onCombined: () => void }) {
  const { t } = useTranslation('reports');
  const [groups, setGroups] = useState<CombineCandidateGroup[]>([]);
  const [open, setOpen] = useState(false);
  const generation = useRef(0);

  const load = useCallback(async () => {
    const current = ++generation.current;
    try {
      const response = await fetchWithAuth('/reports/series/combine-candidates', { skipOrgIdInjection: true });
      if (!response?.ok) throw new Error(`combine candidates: HTTP ${response?.status}`);
      const payload = (await response.json()) as { data?: CombineCandidateGroup[] };
      if (current === generation.current) setGroups(Array.isArray(payload.data) ? payload.data : []);
    } catch (err) {
      console.warn('Failed to load combine candidates:', err);
      if (current === generation.current) setGroups([]);
    }
  }, []);

  useEffect(() => {
    void load();
    return () => { generation.current++; };
  }, [load]);

  if (groups.length === 0) return null;

  return (
    <div data-testid="reports-combine-banner" className="flex flex-wrap items-center justify-between gap-4 rounded-md border border-primary/30 bg-primary/5 px-4 py-3 text-sm">
      <span>{t('reports.seriesCombine.banner', { groups: groups.length })}</span>
      <button type="button" data-testid="reports-combine-review" onClick={() => setOpen(true)} className="rounded-md border px-3 py-1.5 font-medium hover:bg-muted">
        {t('reports.seriesCombine.review')}
      </button>
      {open && (
        <CombineDialog
          open
          groups={groups}
          timezone={timezone}
          onClose={() => setOpen(false)}
          onChanged={() => {
            setOpen(false);
            onCombined();
            void load();
          }}
        />
      )}
    </div>
  );
}
```

In `ReportsList.tsx`:

1. Add `import CombineBanner from './series/CombineBanner';` beside the other local imports.
2. Directly after the `mergePartnerWide` declaration, add:

```tsx
  // Series W04: Combine spans every org of the partner, so it is offered only
  // under All organizations, and only to users who may administer
  // partner-wide state (the server gates regardless).
  const showCombineBanner =
    jwtClaims.status === 'resolved' &&
    jwtClaims.claims.scope === 'partner' &&
    canManagePartnerWide &&
    !currentOrgId;
```

3. Inside `{activeTab === 'reports' && (<> … )}`, directly after the `partnerWideIncomplete` `<p>` block, add:

```tsx
          {showCombineBanner && <CombineBanner timezone={effectiveTimezone} onCombined={fetchReports} />}
```

- [ ] **Step 4: Run the new tests and every existing `ReportsList` suite.**

Run: `cd apps/web && npx vitest run src/components/reports`
Expected: PASS for the whole directory.

Existing suites render under partner scope with no focused org. They now also request `/reports/series/combine-candidates`, which their mocks answer with `ok: false`, so the banner stays hidden. If one of them asserts an exact `fetchWithAuth` call count, update that assertion to filter calls by URL. Never remove the banner's fetch to satisfy it.

- [ ] **Step 5: Commit.**

```bash
git add apps/web/src/components/reports/series/CombineBanner.tsx apps/web/src/components/reports/series/CombineBanner.test.tsx \
  apps/web/src/components/reports/ReportsList.tsx apps/web/src/components/reports/ReportsList.combine.test.tsx
git commit -m "feat(web): Combine banner on Saved Reports under All organizations (series W04)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Full verification and PR

**Files:** none. Update only the files a failure here points to.

- [ ] **Step 1: Typecheck all three packages.**

```bash
NODE_OPTIONS=--max-old-space-size=12288 pnpm exec tsc --build apps/api/tsconfig.tests.json
pnpm --filter @breeze/shared typecheck
cd apps/web && pnpm exec astro check
```

Expected: all three exit 0.

- [ ] **Step 2: Run the full API, web and shared unit suites.**

```bash
cd apps/api && npx vitest run
cd apps/web && npx vitest run
cd packages/shared && npx vitest run
```

Expected: PASS. The full API run is required, not a touched-file run. It is the only run that exercises `partnerOwnedVisibility.scan`, `mcp-coverage`, `partner-wide-write-coverage` and `routerAuthGate` alongside everything W02 registered.

- [ ] **Step 3: Run the real-DB suites.** The Combine suite plus W02's reconciler and series suites must pass together, because Combine drives the reconciler.

```bash
pnpm test-stack up
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/reportSeriesCombine.integration.test.ts \
  src/__tests__/integration/reportSeries
DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage
pnpm test-stack down
```

Expected:

- All the named suites pass. `src/__tests__/integration/reportSeries` substring-matches W02's `reportSeries*` suites, so check the reported file count includes them.
- `rls-coverage` passes. W04 adds no table, so it must be unchanged.

- [ ] **Step 4: Manually exercise the flow on a worktree stack.** This is optional but recommended, since the change is medium blast radius. Use the `worktree-stack` skill. With a partner admin under All organizations:
  1. Create two identical weekly reports in two orgs.
  2. Confirm the banner appears.
  3. Resolve the CC addresses and combine.
  4. Confirm the list shows one series row (W03) and that the duplicate is gone from the default list.

  Then tear the stack down (`pnpm wt-stack down`).

- [ ] **Step 5: Open the PR.**

```bash
git push -u origin HEAD
gh pr create --title "feat(reports): multi-org report series W04 — Combine" --body "$(cat <<'EOF'
Closes #<W04 sub-issue>

## What
Opt-in Combine (spec §3.8, decision D4). `GET /reports/series/combine-candidates` lists groups of
near-identical org-owned reports (same type/format/schedule + normalized config, ≥2 orgs);
`POST /reports/series/combine` turns one group into a series in ONE transaction:
- adopts one row per org IN PLACE (id, runs, `service_deliverable_evidence` rows, contact recipients kept);
- archives same-org duplicates (their contacts copied onto the adopted row, their deliverable links repointed);
- shared `config.emailRecipients` → series internal CC; the rest must be resolved (`combine_cc_conflict` 409 otherwise);
- target defaults to Chosen orgs = exactly these orgs, recipient rule off — nothing new is sent.
Web: `CombineBanner` + `CombineDialog` on Saved Reports under All organizations (runAction).

## Decisions (see plan "Decisions this plan makes")
Group key = sha256 of canonical JSON (v1); ignored config keys; one_time, site-restricted execution scope and
ineligible orgs excluded; adoption order (deliverable-linked > newest run > newest created > id).

## Contract notes
New error codes `combine_group_changed` (409), `combine_cc_too_many` (400); `combineIntoSeries` returns a superset
of `{ seriesId }`; routes in `routes/reports/seriesCombine.ts` mounted ahead of `/:id` (MCP exemption
`human_only_migration`). `CombineError` extends W02's `ReportSeriesError` (one mapper, `seriesErrorResponse`); the
export+MFA gate is W02's `callerMaySetEmailRecipients` (`routes/reports/recipientGate.ts`).

## Tests
Unit: combineKey, combinePlan, seriesCombine routes, CombineDialog/Banner, ReportsList mount.
Integration (real PG, breeze_app): reportSeriesCombine.integration.test.ts (service + routes).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
gh pr checks --watch
```

Expected: `CI Success` is green, including every Integration Tests shard. Then run one review round (`/pr-review-toolkit:review-pr`) before enqueueing with `gh pr merge <N>`.

---

## Spec coverage (self-review)

| Spec requirement | Task |
|---|---|
| §3.8 Candidate query grouped by `(type, format, schedule, normalized config)`, recipients and name excluded, ≥2 orgs | 2 (key), 3 (grouping), 4 (query) |
| §3.8 Exclusions: portal self-service, narrative, managed evidence, `ai_fleet_design`, business types, site/device/group config | 3 (exclusion table, parity with `INTERNAL_REPORT_TYPES` / `PARTNER_ONLY_DELIVERY_REPORT_TYPES`), 4 (real rows untouched) |
| Brief: archived rows, rows already in a series, partner-owned rows excluded; partner scope with `org_access='all'` | 3, 4 (`loadCandidateRows` filters), 5 (route gate + selected-user 403) |
| §3.8 Banner "N groups…" | 7 |
| §3.8 Dialog: each org's rows with name, last run and recipients; target default Chosen = these orgs, switchable to All; rule off; shared CC → internal CC; others resolved before confirm | 6 |
| §3.8 On confirm, one transaction: create series, adopt one row per org in place (id, runs, evidence kept), archive extra duplicates | 4 |
| Brief: execution scope captured per adopted row via `captureChildExecutionScope`; audit log | 4 (capture), 5 (audit events) |
| §3.8 No undo endpoint (Detach per row) | Nothing is built: Detach is W02's `POST /reports/:id/detach`. |
| §5 W04 tests: exclusion list; contacts preserved as `add`; adopted rows keep id and runs; CC disagreement blocks confirm | 3, 4, 6 |
| INDEX: `findCombineCandidates`, `combineIntoSeries`, `CombineBanner`, `CombineDialog`, routes, `combine_cc_conflict` | 4, 5, 6, 7 |
