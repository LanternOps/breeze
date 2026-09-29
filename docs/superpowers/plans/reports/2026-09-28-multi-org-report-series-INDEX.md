---
tracking_issue: LanternOps/breeze#7438
spec: docs/superpowers/specs/reports/2026-09-28-multi-org-report-series-design.md
---

# Multi-org Report Series: Implementation Plan (Index)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Read the spec and this index before executing a wave. Each wave has its own plan file below.

**Goal:**
- Make every saved report and run show which org it covers.
- Let an MSP define one report that produces a separate, org-delivered copy for every targeted org ("One per organization").
- Let the MSP consolidate existing near-duplicates into such a definition.

**Architecture:** Four waves, four PRs.

- **W01** is independent. It adds org visibility (`orgName`, the Covers column, the Org column on runs) and fixes New Report/Templates under All organizations. It also makes zero-recipient deliveries visible (`report_runs.delivery_status`, `recipient_count`).
- **W02** adds the partner-axis `report_series` parent and the org-axis `report_series_org_targets`. The parent materializes ordinary org-owned child `reports` rows through a reconciler, which runs transactionally on series writes and in a repair sweep on the 5-minute `check-schedules` tick. W02 also adds:
  - a worker gate;
  - per-org owner authority;
  - rule-based recipients with per-org add/remove overrides;
  - `series_managed` refusals on child writers.
- **W03** is the series UI.
- **W04** is the opt-in Combine.

Partner-owned `reports` rows keep meaning a combined cross-org aggregate (#3198). W02 must not repurpose them.

**Tech Stack:** Hono + Drizzle + postgres.js, hand-written idempotent SQL, BullMQ, Astro + React islands, Vitest (unit, RLS-coverage, integration), and the tenancy contract in `CLAUDE.md`.

**Spec:** `docs/superpowers/specs/reports/2026-09-28-multi-org-report-series-design.md`, approved 2026-09-28. The design has a two-round Fable + Codex quorum. The second round ran against main `92764125ed`.

## Global constraints

- **Every spec decision stands** (spec §2, D1–D6). Do not reopen them in a PR.
- **`report_series` is partner-only.** It has `partner_id NOT NULL` and shape 3. It goes in `PARTNER_TENANT_TABLES` and in no other allowlist. The PR states the D6 exception to Partner-Wide-First.
- **Partner-owned `reports` rows (`org_id NULL`) are untouched.** They are never a series parent. They never get `series_id`, and the CHECK `series_id IS NULL OR org_id IS NOT NULL` enforces this.
- **Series schedules are recurring only** (`daily | weekly | monthly`). `one_time` is rejected by the series zod schema with a standard 400. The UI never defaults silently: a template whose schedule is one-time requires an explicit schedule choice in series mode.
- **Series types:** reject `PARTNER_ONLY_DELIVERY_REPORT_TYPES`, system-managed types (narrative / `source_ai_agent_schedule_id`, `ai_fleet_design`, managed evidence) and `portalSelfService`, with 400 `series_type_unsupported`. A config naming sites, devices or groups is rejected with 400 `series_config_org_specific`.
- **Write gate for every series mutation:** `reports:write` AND `canManagePartnerWidePolicies(auth)` AND `auth.scope === 'partner'`. `partner_id` always comes from the token.
- **Children:** a child is org-owned, and at most one active child exists per `(org_id, series_id)`. Only recipient add/remove and Detach may mutate a child's shared fields outside the reconciler. Every other writer answers 409 `series_managed`.
- **Archive, never delete, on exclusion, org ineligibility and series delete.** Runs and evidence survive. Eligible orgs are `status IN ('active','trial') AND deleted_at IS NULL`.
- **Never run a child with substitute or system authority.** If the owner can't reach the org, the child is `blocked_no_authority`.
- **Existing behaviour is byte-for-byte unchanged** for non-series rows. The one exception is W01's `delivery_status`/`recipient_count` write and the new list fields.
- **Tenancy registration is mechanical.** `grep` each new table and column against:
  - `CORE_ORG_CASCADE_DELETE_ORDER`;
  - `orgMergeRegistry.ts` / `orgMergeCustomExecutors.ts`;
  - `CORE_TENANT_EXPORT_POLICY`;
  - `rls-coverage.integration.test.ts`.

  Composite or org-referencing constraint triggers are `DEFERRABLE INITIALLY IMMEDIATE`.
- **Migration naming:**
  - Filenames use `YYYY-MM-DD-HHMMSS-<slug>.sql`.
  - At plan time the newest shipped file is `2026-11-08-160000-…`, so W01 uses `2026-11-09-100000-…` and W02 uses `2026-11-09-110000-…` onward. **Re-check `ls apps/api/migrations | sort | tail -1` at commit time and bump if main moved past.**
  - Migrations are idempotent, with no `BEGIN`/`COMMIT`.
  - Any row write elects `breeze.scope = 'system'` first. W01 and W02 migrations write no rows.
- **Web:**
  - Every mutation goes through `runAction`.
  - UI state lives in `window.location.hash`, not query params.
  - E2E selectors use `data-testid` only.
  - New strings go in the i18n locale files, following the existing reports namespace pattern.
- **Tests:**
  - API unit: `cd apps/api && npx vitest run <path>`. Never `pnpm … test -- --run`.
  - Web: `cd apps/web && npx vitest run <path>`.
  - Tenancy (W01 migration, W02): `pnpm test-stack up`, then:
    - `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage`;
    - the integration suites named in each plan;
    - the **full** API unit run for `orgMerge.test.ts`.

    Run `pnpm test-stack down` afterwards.
- **Rebase before starting a wave** (`git fetch origin main && git rebase origin/main`). The design was nearly built on a 474-commit-stale tree once.

## Cross-wave contract (names are fixed; a mismatch is a plan bug)

**DB (snake) → Drizzle (camel)**

| Table | Columns |
|---|---|
| `report_series` (`reportSeries`) | `id`, `partner_id`, `name`, `type` (reportTypeEnum), `format` (reportFormatEnum), `schedule` (reportScheduleEnum), `config` jsonb, `target_mode` text `'all'\|'selected'`, `recipient_rule` jsonb `{primaryContact: boolean, roles: string[]}`, `internal_cc` text[], `revision` int, `enabled` bool, `owner_user_id`, `created_by`, `created_at`, `updated_at` |
| `report_series_org_targets` (`reportSeriesOrgTargets`) | `id`, `series_id`, `org_id`, `created_at`; unique `(series_id, org_id)` |
| `reports` + | `series_id` (`seriesId`), `series_revision` (`seriesRevision`), `archived_at` (`archivedAt`) |
| `report_schedule_recipients` + | `mode` text `'add'\|'remove'` default `'add'` |
| `report_runs` + (W01) | `delivery_status` (`deliveryStatus`) text, `recipient_count` (`recipientCount`) int |

**Types (API `apps/api/src/services/reportSeries/types.ts`; the web mirrors them in `apps/web/src/components/reports/series/types.ts`)**

```ts
export type ReportDeliveryStatus = 'sent' | 'partial' | 'no_recipients' | 'failed' | 'not_scheduled';
// W01: declared in db/schema/reports.ts (REPORT_DELIVERY_STATUSES), re-exported from services/reportDelivery.ts;
// web copy lives in components/reports/DeliveryStatusChip.tsx and series/types.ts re-exports it.
// 'partial' = sent, but at least one configured recipient was dropped (invalid/missing email or over the cap).
// recipient_count: non-series report = contacts ∪ config.emailRecipients (no CC concept);
// series child = customer set only (rule ∪ adds − removes), internal_cc excluded.
export type SeriesTargetMode = 'all' | 'selected';
export interface SeriesRecipientRule { primaryContact: boolean; roles: string[] }
export type SeriesOrgState = 'active' | 'excluded' | 'ineligible' | 'blocked_no_authority' | 'blocked_no_recipients';
export interface SeriesOrgStatus {
  orgId: string; orgName: string; state: SeriesOrgState; childReportId: string | null;
  lastRun: { status: string; deliveryStatus: ReportDeliveryStatus | null; recipientCount: number | null; completedAt: string | null } | null;
}
export interface ReconcileResult { created: number; updated: number; archived: number; unarchived: number; blocked: string[] /* orgIds */ }
export type SeriesGateDecision = 'run' | 'skip_disabled' | 'skip_untargeted' | 'skip_archived' | 'blocked_no_authority';
```

**API services (W02; `apps/api/src/services/reportSeries/`)**

- `targets.ts`: `resolveSeriesTargetOrgIds(series: ReportSeriesRow, tx): Promise<string[]>`, which returns eligible orgs only.
- `reconcile.ts`:
  - `reconcileSeries(seriesId: string, tx): Promise<ReconcileResult>`
  - `reconcileAllSeries(): Promise<void>`, the sweep; it runs under system context.
  - `seriesChildGate(report: { id: string; orgId: string; seriesId: string; seriesRevision: number | null; archivedAt: Date | null }): Promise<SeriesGateDecision>`
- `authority.ts`:
  - `assertSeriesOwnerEligible(userId: string, partnerId: string, tx): Promise<void>`
  - `captureChildExecutionScope(ownerUserId: string, orgId: string, tx): Promise<ExecutionScopeColumns | 'no_authority'>`
- `recipients.ts`: `resolveSeriesChildRecipients(args: { reportId: string; orgId: string; rule: SeriesRecipientRule; internalCc: string[] }): Promise<{ customer: string[]; cc: string[] }>`
- `validation.ts`:
  - `assertSeriesTypeSupported(type: string): void`, which throws `series_type_unsupported`.
  - `assertSeriesConfigOrgAgnostic(config: unknown): void`, which throws `series_config_org_specific`.
- `combine.ts` (W04):
  - `findCombineCandidates(partnerId: string, tx): Promise<CombineCandidateGroup[]>`
  - `combineIntoSeries(input: CombineInput, auth, tx): Promise<{ seriesId: string }>`

**Routes:** `apps/api/src/routes/reports/series.ts` exports `reportSeriesRoutes` and is mounted at `/reports/series` in `routes/reports/index.ts` **before** `/:id` routes. Its schemas live in `routes/reports/seriesSchemas.ts`.

| Route | Wave |
|---|---|
| `POST /reports/series` | W02 |
| `GET /reports/series` | W02 |
| `GET /reports/series/:id` (returns `{ series, targets: string[], orgs: SeriesOrgStatus[] }`) | W02 |
| `PATCH /reports/series/:id` | W02 |
| `PUT /reports/series/:id/targets` (`{ targetMode, orgIds }`) | W02 |
| `POST /reports/series/:id/transfer-owner` (`{ ownerUserId }`) | W02 |
| `DELETE /reports/series/:id` | W02 |
| `GET /reports/series/:id/recipients/preview` (returns `{ totalCustomerRecipients, orgCount, orgsWithoutCustomerRecipient: {orgId, orgName}[] }`) | W02 |
| `POST /reports/series/recipients/preview` (unsaved form: body `{ targetMode, orgIds, recipientRule }`) | W02 |
| `POST /reports/:id/detach` (on `core.ts`) | W02 |
| `GET /reports/series/combine-candidates` | W04 |
| `POST /reports/series/combine` | W04 |

**Existing endpoint additions**

- `GET /reports` rows gain the following fields and filters:
  - `orgName: string | null` and `lastDeliveryStatus: ReportDeliveryStatus | null`, the latest scheduled run's delivery status (W01);
  - `seriesId`, `seriesName`, `archivedAt` (W02);
  - the query `?series=only|exclude` and `?includeArchived=true` (W02).
- `GET /reports/runs` rows gain:
  - `orgId`, `orgName` (W01);
  - `seriesId`, `seriesName` (W02);
  - `deliveryStatus`, `recipientCount` (W01).

**Error codes:**
- W02: `series_type_unsupported` (400), `series_config_org_specific` (400), `series_managed` (409), `series_owner_ineligible` (400), `series_not_found` (404).
- W04: `combine_cc_conflict` (409), `combine_group_changed` (409), `combine_cc_too_many` (400).
- Existing: `recipients_need_export_and_mfa` (403).

The services throw `ReportSeriesError` (W02, `services/reportSeries/errors.ts`):

```ts
export class ReportSeriesError extends Error {
  constructor(readonly code: string, readonly status: 400 | 403 | 404 | 409, readonly body?: Record<string, unknown>) { super(code); }
}
```

Routes map it through one function, `seriesErrorResponse(c, err)`. W04 may subclass it or reuse it.

**Recipient delivery gate (W02 extracts it; W04 consumes it).**
- Today, `routes/reports/core.ts` holds `RECIPIENTS_NEED_EXPORT_AND_MFA` and `recipientExportGateFails`: adding an email delivery requires `reports:export` plus a satisfied MFA session.
- **W02 Task:** move them to `routes/reports/recipientGate.ts`, exporting `callerMaySetEmailRecipients(auth): boolean` and `RECIPIENTS_NEED_EXPORT_AND_MFA`. `core.ts` re-imports them with no behaviour change.
- The gate applies to every series write that **adds** a delivery: create with a non-empty `internal_cc` or an enabled recipient rule; a PATCH that widens `internal_cc` or the rule; a targets change that adds orgs while a rule or CC is active; a child recipient `add`.
- The gate is server-derived and never read from a request body.

**Revision sentinel:** `reports.series_revision = 0` means "adopted/created, never reconciled". Since `report_series.revision` starts at 1, `seriesChildGate` and `reconcileSeries` treat 0 as stale. The reconciler is the only writer of a child's shared fields; Combine adopts at 0 and then calls `reconcileSeries` in the same transaction.

**Route files:** the combine routes live in `routes/reports/seriesCombine.ts`, mounted by `series.ts` ahead of `/:id`. Every new route file gets its `MCP_COVERAGE` entry.

**Web components** (`apps/web/src/components/reports/`)

- W01:
  - `CoversCell.tsx`, which renders the three kinds: org name; `All organizations · Combined`; series `All orgs · N` / `N orgs` · `One per organization`. The series kind renders from W02 fields once they exist.
  - `OrgPickerField.tsx`.
- W03 (`series/`):
  - `CoversControl.tsx`, which has three modes: `'org' | 'series' | 'combined'`;
  - `SeriesTargetingFields.tsx`, `SeriesRecipientsSection.tsx`, `SeriesDrilldown.tsx`, `SeriesChildLockBanner.tsx`, `types.ts`.
- W04: `series/CombineBanner.tsx` and `series/CombineDialog.tsx`.

## Four waves and tracking

| Lifecycle key | Wave and plan | Hard prerequisites | Deployable result |
|---|---|---|---|
| W01 (#7439) | [Org visibility + delivery status](2026-09-28-multi-org-report-series-w01-org-visibility.md) | Approved spec | Covers/Org columns, org picker (fixes the 400), `delivery_status`/`recipient_count` recorded, "no recipients" warning. There is no series yet. |
| W02 (#7440) | [Series backend](2026-09-28-multi-org-report-series-w02-series-backend.md) | W01 merged (uses `delivery_status`) | Tables, RLS, cascade/merge/export registration, reconciler + sweep + worker gate, authority, recipients, series routes, child refusals. API-complete; no UI. |
| W03 (#7441) | [Series UI](2026-09-28-multi-org-report-series-w03-series-ui.md) | W02 merged | Series mode in Covers control, recipient preview, grouped list + drill-down, locked child view, Exclude/Detach/Transfer owner. The feature is visible. |
| W04 (#7442) | [Combine](2026-09-28-multi-org-report-series-w04-combine.md) | W03 merged | Candidates, banner, dialog, and in-place adoption preserving recipients as `add` overrides. |

A wave stays open until every task and gate in its plan is done. Intermediate PRs use `Refs #<wave>`, and the completing PR uses `Closes #<wave>`. `get_feature_status` is authoritative for status.
