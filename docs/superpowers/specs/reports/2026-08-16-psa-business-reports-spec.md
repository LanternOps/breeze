# PSA / Business Reports — Design Spec

- **Issue:** #3198 — Business/PSA reporting gap (SLA attainment, technician utilization, AR aging, margin, MRR)
- **Date:** 2026-08-16
- **Status:** Draft for review
- **Related:** #3206 (mobile ticketing/time — same `tickets`/`time_entries` tables), #2713 (quote follow-ups — same `quotes` tables), `docs/superpowers/plans/open/2026-07-01-partner-level-reports-design.md` (partner-scope reports design, unimplemented)

## 1. Problem

The PSA half of Breeze (tickets, time, invoices, contracts, quotes) is fully modeled in Postgres and almost entirely unreported. All seven shipped report types (`reportTypeSchema`, `apps/api/src/routes/reports/schemas.ts`) and the entire `/analytics` metric vocabulary (`apps/web/src/components/analytics/QueryBuilder.tsx:31-61`) are infrastructure-only. The lone business export is a billables CSV buried in Settings (`BillablesExportCard.tsx`). MSP owners cannot answer "are we hitting SLA?", "are my techs utilized?", "who owes me money?", or "what's my MRR?" from inside the product.

The report *engine* is real and reusable: `reports` + `report_runs` tables, builder UI, curated templates, async scheduled runs with email delivery (`reportScheduleWorker.ts`), and a branded PDF renderer (`packages/shared/src/reportPdf/reportPdf.ts`). This spec adds business report types to that engine; it does not build a new subsystem.

### Codebase facts that shape the design (verified 2026-08-16, corrections to the issue body)

1. **Technician utilization is partner-axis, not org-axis.** `time_entries` (`schema/timeTracking.ts:22`) has `partner_id NOT NULL` (the RLS axis) and `org_id` **nullable** (non-ticket/timesheet work has no org). The current generator contract `generateReport(type, orgId, config, authority)` cannot express a utilization report without silently under-counting org-less entries. Utilization inherently wants partner scope — the issue's Phase 1 item 2 actually depends on its Phase 3 item 9.
2. **`reports.org_id` is NOT NULL and there is no `partner_id`** — no partner-owned report exists today. The 2026-07-01 partner-reports design doc already specifies the full migration (org XOR partner, Shape 4 dual-axis RLS, the `report_runs` FK-child policy fix, worker `innerJoin → leftJoin`).
3. **Money is PG `numeric` (strings in JS), not cents** — `numeric(12,2)` on invoice/contract/quote amounts, `numeric(10,2)` on `time_entries.hourly_rate` and `ticket_parts` prices — and `currency_code` lives on `invoices`/`contracts`/`quotes` but **not** on line tables, `time_entries`, or `catalog_items`. Naive `SUM` across mixed currencies is wrong, `hourly_rate` has **no currency at all** (so cross-tech rate aggregation is invalid), and the PDF renderer has zero currency formatting (`formatGenericCell` stringifies raw numerics).
4. **MRR is not "cheap, data exists."** `contract_lines.line_type ∈ {flat, per_device, per_seat, manual}` — per-device/per-seat lines need a live count join; `interval_months` + `billing_timing` need monthly normalization. Real work; correctly Phase 2.
5. **`contracts.unit_price` doesn't exist** — it's on `contract_lines`. `catalog_item_org_pricing` has **no** `cost_basis` (per-customer margin falls back to partner-level `catalog_items.cost_basis`).
6. The PDF renderer has **no section abstraction** — `buildReportPdf` is a 3-branch if/else (posture / exec-summary / generic flat table). The QBR pack (candidate 11) needs a real composition layer, not just currency formatting.
7. The builder UI has its own **separate 5-value type vocabulary** (`devices/alerts/patches/compliance/activity`) with a `reportTypeSurvivesBuilder` shim; curated-template types can be builder-opaque.
8. `tickets` lives in `schema/portal.ts:65` (not `schema/tickets.ts`); all six SLA columns from the issue are confirmed. `tickets.org_id` is NOT NULL — SLA attainment works org-axis today.
9. The closest existing precedent for business aggregation is `listBillables` (`services/timeEntryService.ts`, serving `GET /tickets/export/billables.csv`) — it already solves the partner-axis/org-allowlist problem for `time_entries`.

## 2. Users & scope

- **Primary user: the MSP owner / service manager at partner scope.** Breeze is MSP-first; the default lens for every business report is *all my clients*, grouped by org (and by technician, where relevant). A per-org SLA report is the drill-down, not the headline.
- **Secondary: org-scoped view** for account managers and (later, explicitly out of scope here) client-facing QBR material.
- **Not in scope:** end-client portal visibility of any business report. Margin, utilization, and AR data are internal to the MSP. New report types default to internal-only; nothing is exposed via the portal.
- **Permissions:** business reports reveal money and HR-adjacent data (per-tech utilization). Generation gates on the underlying read permissions, following the billables-export precedent (`TICKETS_READ` + `TIME_ENTRIES_READ`; invoices/contracts reads for AR/MRR). Partner-owned report create/update/delete additionally follows the partner-reports design: `ownerScope` create-only, partner id always from `auth.partnerId`, gated on `orgAccess === 'all'`.

## 3. Proposed design

### 3.1 Foundation first: land the partner-scope reports migration (prerequisite PR)

Phase 1 starts by implementing the already-written design in `2026-07-01-partner-level-reports-design.md`:

- `reports.org_id` → nullable; add nullable `partner_id`; CHECK `reports_one_owner_chk ((org_id IS NULL) <> (partner_id IS NULL))`; partner index.
- RLS: `reports` moves to Shape 4 dual-axis; **the `report_runs` policies must OR in `breeze_has_partner_access(r.partner_id)` via the `reports` join in the same migration** (otherwise partner-owned runs are invisible and un-insertable — the doc's §2.4 correctness item).
- `ALTER TYPE report_type ADD VALUE` statements ship in their own `-a-` migration file (autoMigrate per-file transaction), schema/RLS in `-b-`.
- Worker: `findDueReports` `innerJoin organizations` → `leftJoin` + `leftJoin partners on reports.partner_id`; branding falls back to `loadReportBrandingForPartner`.
- Routes: `ownerScope: 'organization' | 'partner'` on create only (copy `routes/security/schemas.ts:177` + the create-only comment pattern); update schemas `.omit({ ownerScope: true })`. **The `orgAccess === 'all'` gate applies to every operation on a partner-owned report — list, get, generate, run download, update, delete — not just create** (RLS's `breeze_has_partner_access` alone would let any same-partner user read cross-org financials; the app layer must be stricter here).
- Execution authority: `ReportExecutionAuthority`, the persisted `execution_scope_*` columns, and `decodeSiteScope` all assume a non-null org today, and the schedule worker resolves authority org-first (`reportScheduleWorker.ts:321`) — a partner-owned report would fail preflight before generating. This foundation PR must extend the authority snapshot with a partner variant (partner id + `orgAccess:'all'` requirement, reauthorized live like org authorities), which the 2026-07-01 doc gestures at but does not fully specify. This is the largest unwritten piece of the foundation and gets its own design section in the implementation plan.
- Registrations: `DUAL_AXIS_TENANT_TABLES` in `rls-coverage.integration.test.ts`, a `reportsPartnerRls.integration.test.ts` (cross-partner forge 42501, XOR 23514, org isolation), and `CORE_TENANT_EXPORT_POLICY` classification for the new `partner_id` column (`included` — tenant identifier). `reports` stays in `CORE_ORG_CASCADE_DELETE_ORDER`; partner-owned rows (`org_id NULL`) are untouched by org erasure, which is correct — they aggregate across orgs and belong to the partner. Verify `report_runs` cleanup on partner deletion follows the existing partner-cascade path.

This is justified inside #3198 (rather than deferred as the issue's Phase 3 item 9) because utilization *requires* it (fact 1), and because org-first-then-retrofit is the repo's documented most-expensive mistake (#1724, #2126–#2129; "Partner-Wide First" contract). The fleet posture rollup from the design doc is **not** pulled in — only the schema/RLS/worker/route foundation.

### 3.2 Generator contract: scope-aware, not org-string

The per-type generator signature grows from `(orgId, config, authority)` to a scope object:

```ts
type ReportScope =
  | { kind: 'organization'; orgId: string }
  | { kind: 'partner'; partnerId: string; orgIds: string[] /* resolved accessible orgs, capped */ };

generateReport(type, scope, config, authority)
```

Existing seven generators keep their org-only behavior (partner-owned instances of those types stay unsupported until the fleet-rollup work lands); the new business generators accept both kinds. Partner-scope generators run under system DB context with explicit partner/org predicates (the heartbeat probe-config pattern) because org-scoped RLS contexts cannot see partner-axis rows; every query carries an explicit `partner_id = scope.partnerId` (and org allowlist where the table is org-axis), mirroring the `listBillables` defense-in-depth comment (`routes/tickets/export.ts:23-25`).

No aggregate org cap: the design doc's 100-org cap exists for the posture fan-out (~15 queries/org); business aggregates are single SQL GROUP BYs, and a capped AR or SLA aggregate is simply a wrong number. Aggregates always cover **all** accessible orgs; only stored *detail rows* are capped (§4), with truncation surfaced in the summary. (Codex concurred; this deliberately diverges from the 2026-07-01 doc for the business types.)

### 3.3 The three Phase 1 reports

All three are pure SQL over existing columns — no new instrumentation, no new tables.

**R1 — Ticket SLA attainment** (`ticket_sla_attainment`)
- Source: `tickets` (org-axis; `deleted_at IS NULL`). Window: config `period` (default: last full month).
- Method (Open Decision 2): attainment is **recomputed from timestamps + targets** — response met when `first_response_at − created_at − sla_paused_minutes ≤ response_sla_minutes`, resolution likewise against `resolved_at` — rather than trusting `sla_breached_at`, because the SLA sweep only stamps breaches on tickets still open/unanswered at sweep time, so late-but-eventually-answered tickets can escape stamping (codex finding). `sla_breached_at`/`sla_breach_reason` annotate the breach list; a discrepancy between the two is surfaced as a count, not hidden. Known approximation, stated in the report footer: `sla_paused_minutes` is a lifetime total, so pause time occurring *after* first response slightly flatters response attainment; per-target immutable SLA outcome stamping is the Phase 2 fix if accuracy disputes arise.
- Tickets with NULL SLA targets are excluded from the denominator and counted separately ("no SLA set").
- Group-bys: org (partner scope), priority, technician, category. The technician axis uses `assigned_to`, which is the *current* assignee — labeled "current assignee" in the UI, since reassignment history isn't tracked.
- Summary block: overall response %, resolution %, breach count, worst org/priority — feeds the existing `previousBaselineFor` trend chips for free.

**R2 — Technician time & billability** (`technician_utilization`) — *partner-scope-first; this is the report that motivates §3.1*
- Source: `time_entries` (partner-axis) **left-joined from active partner technicians** (users with time-entry permissions), so zero-time techs appear at 0% instead of vanishing and inflating the team average (codex finding). Optional org drill via nullable `org_id`.
- Headline utilization = logged minutes ÷ capacity minutes per tech, with capacity a config parameter `weeklyCapacityHours` (default 40) prorated by working days in the period — **explicitly labeled approximate** ("assumes uniform 40h capacity; PTO/part-time not modeled"). No per-tech capacity table in Phase 1 (Open Decision 3).
- Billable % = billable minutes ÷ logged minutes. **Billing conversion** (deliberately not called "realization" — no fee-schedule baseline exists to compute financial realization) = approved-and-billed minutes ÷ billable minutes, from `billing_status`/`is_approved`.
- Hourly rates: `hourly_rate` carries no currency, so no cross-tech or partner-level effective-rate aggregate is published; per-tech average recorded rate appears in detail rows only, unlabeled as to currency.
- Org-scoped instances are allowed but the UI labels them "ticket-linked time only" (org-axis view necessarily excludes org-less entries).

**R3 — AR aging / unpaid invoices** (`ar_aging`)
- Source: `invoices` (partner+org NN — works at both scopes) reusing the open-status predicate behind `sqlOpenForOverdue` (`schema/invoices.ts:20-25`; currently file-local — export it rather than duplicating the status list), `balance`, `due_date`, `marked_overdue_at`; `invoice_payments` for last-payment date.
- Standard buckets: current / 1–30 / 31–60 / 61–90 / 90+ days past due, grouped by org and **by `currency_code`** — no FX conversion, one summary row per currency (Open Decision 4).
- Edge semantics (codex): "as-of" is the run timestamp evaluated in the report owner's resolved timezone (`timezoneFor` chain: org → partner → UTC); NULL `due_date` with open balance goes in a dedicated "no due date" bucket, never silently into "current"; any invoice with `balance > 0` in an unexpected status is counted in an "other open balance" line so the bucket totals always reconcile to total AR.
- Detail rows: invoice number, org, issue/due dates, total, paid, balance, days overdue. Bucket aggregates are computed over **all** matching rows before the detail-row cap is applied.

Selection rationale vs the other nine candidates: these three are the issue's own recommendation, cover the three distinct personas (service manager / ops manager / owner-finance), and — with the R1/R2 narrowing above — are computable today with stated approximations (MRR fails the "computable today" bar — fact 4; margin reports depend on `cost_basis` hygiene the product doesn't yet encourage; quote win-rate is lower-frequency; QBR pack and analytics integration need renderer/analytics platform work first). Codex disagreed with this composition — see Open Decision 6.

### 3.4 Renderer: minimal money support, no section system yet

`reportPdf.ts` gains column metadata on the generic path: per-column `format: 'currency' | 'percent' | 'number' | 'minutes'` + `currencyCode`, rendered with `Intl.NumberFormat`, right-aligned. The `BuildOpts.summary` union widens to accept the business summaries (scorecards + metric grid already exist and are reused for the headline numbers). CSV path emits raw numerics. **No multi-section composition layer in this phase** — that is QBR-pack (candidate 11) work and is out of scope.

### 3.5 Registry & UI

- The three new types are added to the `report_type` PG enum, `reportTypeSchema`, and the `ReportType` union, with generators registered in a declarative map (§6).
- Builder: the new types are **builder-opaque** (template-only), exactly like `security_compliance_posture` — three new curated templates in `ReportTemplates.tsx` under a new "Business" template category, each with a small options form (period, group-by, capacity hours) following the `PostureReportOptionsForm.tsx` pattern. The 5-value builder vocabulary is untouched (Open Decision 5).
- Scheduling/email/CSV/PDF delivery: inherited unchanged from the engine.

## 4. Data model & tenancy impact

**New tables: none.** Phase 1 is enum values + the reports dual-ownership migration.

| Change | Contract obligations |
|---|---|
| `reports`: `org_id` → nullable, add `partner_id`, XOR CHECK, Shape 4 dual-axis RLS | `DUAL_AXIS_TENANT_TABLES`; `reportsPartnerRls.integration.test.ts`; new `partner_id` column classified in `CORE_TENANT_EXPORT_POLICY` (`included`); `reports` remains in `CORE_ORG_CASCADE_DELETE_ORDER` (org erasure leaves partner-owned rows — intended) |
| `report_runs`: policies gain the partner branch via the `reports` join | Functional test that a partner-owned scheduled run inserts and reads back (the static FK-child allowlist can't prove this) |
| `report_runs.report_id` FK is `NO ACTION` today (routes delete runs app-side) | Partner-deletion sweeps would hit an FK violation deleting a partner-owned report with runs — change to `ON DELETE CASCADE` (or add an explicit child pre-clear to the partner cascade) in the `-b-` migration (codex finding) |
| `report_type` enum: +3 values in a standalone `-a-` migration | `autoMigrate.test.ts` ordering; never on the closed `2026-08-06` block |
| No changes to `tickets`, `time_entries`, `invoices` | Read-only consumers |

Config-ish note: report *definitions* already are the config table here, and the dual-ownership migration is precisely the Partner-Wide First retrofit. No new config table is introduced (the utilization capacity setting stays a report-config parameter, avoiding a premature `technician_capacity` table — see Open Decision 3).

Result-size note: `report_runs.result` is jsonb in Postgres, and the CSV/download path materializes it fully in memory (it does not stream). Business reports therefore cap **detail rows** per run (default 5,000, per-type in the registry, truncation surfaced in the summary) while summary aggregates are always computed over the full row set in SQL before capping.

## 5. Phase 1 report selection

**R1 SLA attainment, R2 technician utilization, R3 AR aging** — as justified in §3.3. Phase 2 (subsequent issues, not this spec's implementation scope): MRR/renewals (needs per-device/per-seat quantity resolution + monthly normalization), quote win rate, ticket volume/backlog. Phase 3 unchanged from the issue (client profitability, QBR pack, analytics business metrics), except item 9 (partner scope) moves *into* Phase 1 as §3.1.

## 6. Registry design: extend the closed enum, restructure into a declarative map

**Recommendation: keep the closed enum; replace the `switch` with an in-code registry map.** A runtime-pluggable registry (extensions registering report types) is rejected for now: report types leak into a PG enum, zod schema, TS union, i18n labels, template metadata, and the PDF renderer — a plugin seam would have to abstract all six surfaces for zero current consumers (the `ee/` extension has no reporting need). Cost without a customer.

Concretely: a `REPORT_GENERATORS: Record<ReportType, ReportTypeDef>` where `ReportTypeDef = { generate(scope, config, authority); configSchema: ZodType; supportedScopes: ('organization'|'partner')[]; requiredPermissions: Permission[]; detailRowCap: number; pdf?: ColumnFormatMeta }`. Per codex's amendment (adopted): the registry owns each type's **config schema** (replacing the shared loose `generateReportSchema` config object, which would otherwise strip or ignore per-type business options) and its renderer column metadata, so the per-type surface fragments across fewer files. The `ReportType` TS union is derived from one canonical `as const` tuple that also feeds `reportTypeSchema` — collapsing the three-way TS/zod duplication to one source, leaving only the unavoidable second place: the PG enum migration. `generateReport` becomes a lookup + scope/permission check; exhaustiveness is preserved because the record is keyed by the closed union (a missing key is a compile error, same guarantee as the `never` guard).

## 7. Placement: `/reports`

Business reports ship as report types under **`/reports`**, not `/analytics`. Rationale: the reports engine already has scheduling, email delivery, branded PDF, saved templates, and run history — exactly what a monthly SLA/AR report needs. `/analytics` is structurally wrong today: `POST /query` is strictly device-scoped timeseries (`metricColumnMap` maps only `device_metrics` columns; `deviceIds` is mandatory) — money metrics have no device. Teaching analytics a finance-aware, non-timeseries source is the issue's candidate 12 (Phase 3) and stays out of scope. Web nav: a "Business" section in the reports templates gallery; the Settings billables CSV card gets a "See business reports" link but is not removed.

Incidental bug (file separately, not this scope): 12 of 16 QueryBuilder metric options (e.g. "SLA Compliance", "Incident Count") have no `metricColumnMap` entry and silently return the unknown-metric warning.

## 8. Out of scope

- MRR/renewal pipeline, quote win rate, ticket volume trend (Phase 2 issues).
- Client profitability / loaded cost per tech; per-org `cost_basis` (schema gap, fact 5).
- QBR multi-section PDF composition; any `reportPdf` section abstraction beyond column formats.
- Business metrics in `/analytics` QueryBuilder; dashboard presets.
- Fleet posture/patch rollup generators from the partner-reports design doc (only its schema/route/worker foundation lands).
- Portal/client-facing exposure of any business report.
- FX conversion; multi-currency totals are reported per-currency only.
- Mobile surfaces (#3206 owns mobile time entry; reports stay web).

## 9. Open Decisions

1. **Partner-scope migration inside Phase 1 vs org-only Phase 1.**
   - **A — Foundation-first (land the 2026-07-01 reports dual-ownership migration, then the three reports on top):** pro — utilization is honest at partner scope, no org-first retrofit, matches Partner-Wide First; con — Phase 1's first PR is a tenancy migration (high-blast-radius, full contract-test ceremony) before any visible report ships.
   - **B — Org-only now, partner scope later:** pro — first report ships faster; con — utilization silently under-counts org-less time entries (or gets cut), and `reports` gets retrofitted later at higher cost — the exact documented failure mode.
   - **Recommend A** — utilization is the report MSP owners asked for by name, and it cannot be built honestly without partner scope. (Codex: conditionally agrees, contingent on the partner execution-authority design in §3.1 being written before implementation — adopted as a hard prerequisite.)
2. **SLA attainment source of truth: recompute from timestamps vs trust instrumented breach columns.**
   - **A — Recompute attainment from timestamps + targets in report SQL (using `sla_paused_minutes` as recorded), with `sla_breached_at` as annotation:** pro — counts late-but-eventually-answered tickets the periodic sweep never stamps (it only marks breaches on tickets still open/unanswered at sweep time — codex finding); con — lifetime paused-minutes total slightly flatters response attainment for tickets paused after first response, and the SQL can drift from `ticketSla.ts` semantics.
   - **B — Trust `sla_breached_at` as the sole truth:** pro — matches in-app SLA chips exactly; con — systematically under-counts breaches, which for an attainment report shown to owners is the worse error.
   - **C — Defer SLA attainment until per-target immutable SLA outcomes are stamped at response/resolution time (codex's position):** pro — defensible numbers; con — delays the single most-demanded report for an instrumentation project, and A's approximation is small and disclosable.
   - **Recommend A** — ship recomputed attainment with the approximation stated in the report footer, surface the recomputed-vs-stamped discrepancy count, and file per-target outcome stamping as the Phase 2 accuracy fix. (My original draft recommended B; codex's sweep-gap argument overturned it. Codex prefers C; I judge A's disclosed approximation acceptable against C's delay.)
3. **Utilization capacity model: config parameter vs per-technician capacity table.**
   - **A — `weeklyCapacityHours` report-config parameter (default 40), working-day prorated, uniform per tech, report labeled approximate, zero-time techs included:** pro — zero schema, ships now; con — part-timers and PTO skew their individual utilization figure.
   - **B — New `technician_capacity` table (partner-wide dual-ownership per the config-table contract):** pro — correct per-tech; con — a new tenant table + full RLS/cascade/export-policy ceremony for Phase 1, likely also wanted later by scheduling/dispatch features that should shape it.
   - **Recommend A** — defer the table until a second consumer (dispatch/scheduling) defines its real shape. (Codex: acceptable only with the "explicitly approximate + zero-time techs + proration" framing, which §3.3 R2 now mandates — so A as specified is agreed.)
4. **Multi-currency roll-ups: per-currency rows vs single-currency assertion.**
   - **A — Group all money aggregates by `currency_code`, one summary row per currency, no conversion:** pro — always correct, no FX dependency; con — partners billing in 2+ currencies get no single headline number.
   - **B — Assert single currency, error otherwise:** pro — simplest UI; con — hard-fails real EU partners who bill EUR+USD.
   - **Recommend A** — correctness first; an FX-normalized headline is a later enhancement if requested.
5. **Builder exposure of business types: builder-opaque templates vs extending the builder vocabulary.**
   - **A — Template-only (builder-opaque), like `security_compliance_posture`, with small per-type options forms:** pro — no changes to the 5-value builder enum or its dataSource plumbing; con — users can't ad-hoc rearrange columns of business reports.
   - **B — Add `tickets`/`time`/`invoices` data sources to the builder:** pro — flexible; con — the builder's field/filter model is device-tabular and would need money formatting, joins, and group-by semantics it doesn't have.
   - **Recommend A** — the builder retrofit is its own project; curated templates cover the Phase 1 need. (Codex agrees.)
6. **Phase 1 composition: keep SLA + utilization + AR vs codex's alternative (AR + contract renewals + ticket backlog).**
   - **A — SLA attainment + technician time/billability + AR aging (this spec, with the §3.3 narrowing):** pro — matches the demo-driven demand and the issue's own recommendation; covers service, ops, and finance personas; con — two of the three carry disclosed approximations (SLA pause attribution, uniform capacity).
   - **B — AR aging + contract renewal pipeline + ticket volume/backlog (codex):** pro — every number is exact from existing columns, no approximations to defend; con — skips the two reports MSP owners actually asked for by name, and renewals/backlog were nobody's stated pain.
   - **Recommend A** — demand outranks purity when the approximations are honest and footnoted; the narrowed R1/R2 definitions absorb codex's specific objections (sweep-gap recompute, zero-time techs, "billing conversion" naming, no cross-currency rates). This is the one quorum disagreement not fully resolved — flagging for Todd.

## 10. Test & rollout notes

- **Tenancy (full ceremony — this touches RLS):** migration pair `-a-` (enum) / `-b-` (schema+policies), idempotent; `DUAL_AXIS_TENANT_TABLES` registration; `reportsPartnerRls.integration.test.ts` covering cross-partner forge (42501), XOR violation (23514), org-token isolation from partner-owned reports, and a *functional* partner-owned `report_runs` insert+read (the FK-child static check cannot prove the partner branch); export-policy classification test for `reports.partner_id`; manual `breeze_app` psql forge per the CLAUDE.md checklist. Run the RLS + integration suites locally before PR — `pnpm test` does not include them.
- **Generators:** unit tests per generator with Drizzle mocks (breeze-testing skill patterns) for bucket math, SLA denominators (NULL-target exclusion), paused-minutes handling, currency grouping, org-cap truncation; one integration test per generator against real Postgres proving partner-scope fan-out sees rows across ≥2 orgs and respects the org allowlist; walk bound params, don't token-scan where-clauses (vacuous-assertion trap).
- **Worker:** regression test that `findDueReports` still returns org-owned reports and now returns partner-owned ones (the `innerJoin → leftJoin` change); partner branding fallback.
- **Renderer:** snapshot/unit tests for currency/percent/minutes column formatting in both PDF and CSV paths.
- **Rollout:** three PRs — (1) partner-scope foundation migration + routes + worker, (2) generators + registry map + renderer column formats, (3) templates + options forms + web UI. No feature flag needed: new enum values are inert until a report of that type is created; the foundation migration changes no existing behavior for org-owned reports (verified by the existing reports test suite). Release notes flag the new report types for self-hosters; no new env vars.
- **Follow-ups to file:** QueryBuilder dead metric options bug (§7); Phase 2 report issues (MRR, win rate, backlog trend); per-org `cost_basis` schema gap.

## 11. Advisor quorum

Codex (`codex exec`, read-only, xhigh) reviewed the draft on 2026-08-16. Disposition of its findings:

**Adopted into the spec:**
- Registry should own per-type config schema / permissions / column metadata; derive the TS union from one canonical tuple (§6).
- `orgAccess === 'all'` must gate *all* operations on partner-owned reports, not just create; the partner `ReportExecutionAuthority` variant is the largest unwritten foundation piece (§3.1).
- Drop the 100-org aggregate cap for business types; cap detail rows only (§3.2, §4).
- SLA sweep-gap: recompute attainment from timestamps (overturned my original "trust the columns" recommendation — OD2).
- R2 narrowed to "time & billability": include zero-time techs, prorate capacity, rename realization → billing conversion, no cross-tech rate aggregation (currency-less `hourly_rate`) (§3.3).
- AR edge semantics (NULL due_date bucket, unexpected-status reconciliation line, as-of timezone, aggregate-before-cap); `sqlOpenForOverdue` is file-local and must be exported (§3.3).
- `report_runs.report_id` FK is `NO ACTION` → cascade or pre-clear for partner deletion (§4); CSV path is in-memory, not streaming (§4); `numeric(10,2)` on time/parts money (§1.3).

**Disagreement retained, not silently resolved:**
- Phase 1 composition: codex would ship AR + contract renewals + ticket backlog and defer SLA/utilization until better instrumentation. Promoted to **Open Decision 6** with my recommendation to keep the narrowed trio.
- OD2: codex prefers deferring SLA attainment outright (option C); I recommend A (recompute + disclose). Recorded in OD2.
