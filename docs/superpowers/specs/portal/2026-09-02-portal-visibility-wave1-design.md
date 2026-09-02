# Customer Portal Visibility — Wave 1 Design

**Date:** 2026-09-02
**Status:** Approved for planning (advisor quorum: Fable + Codex `xhigh`; the two disagreements — toggle defaults and sync vs. queued generation — were decided by the user, see §2).
**Roadmap item:** LanternOps/breeze#4562
**Audit that produced this scope:** `internal/olivetech/audit.html` (private) — 36 customer-facing "you'll see" claims checked against `apps/portal` and the reports engine: 4 shipped, 16 surface-only, 7 partial, 9 missing.

## 1. Problem & goal

An MSP's customer-facing promise is "log in and see it": security status, work completed, backup verification, patching, support responsiveness, self-serve compliance PDFs. The Breeze customer portal (`apps/portal`) is a billing-and-tickets portal today — the post-login landing page is Proposals, and none of those categories has a customer surface. Yet the data already exists server-side and org-scoped: org security score history (`security_posture_org_snapshots`), per-device protection (`security_status`, `s1_agents`, `huntress_agents`), threats from three sources, `device_patches`, backup jobs/verifications/readiness/SLA events, ticket SLA columns, `time_entries` linked to `invoice_lines`, and the reports engine with a shared PDF renderer.

Wave 1 surfaces that data to portal users. **No new collectors.** Every number on every new page traces to a table that exists today.

Trust hazards found by the audit ship first (W01), independent of the rest: report template cards that emit the wrong data under a trustworthy name, and two web components that render hardcoded mock compliance data.

## 2. Decisions taken (user-approved 2026-09-02)

| # | Decision | Choice |
|---|---|---|
| 1 | New portal toggles default | **Off** for every existing org, fail closed. Bulk-enable affordance in the MSP org settings editor. |
| 2 | Ticket scope on the dashboard and usage panel | **Org-wide aggregates** (counts, minutes; no titles of other users' tickets). The ticket *list* stays scoped to the current portal user until portal roles exist (a later wave). |
| 3 | Portal report generation | **Synchronous in-request**, like the existing MSP `POST /reports/:id/generate`; rate-limited. No new queue. |
| 4 | Which runs a customer sees | **Only runs of the canonical portal definitions** (§8.2). MSP-internal runs of the same type are never auto-published. |
| 5 | Charts | **Inline SVG** (sparkline, weekly bars). No charting dependency added to `apps/portal`. |

Also decided: score bands for customer displays are the PDF's (`packages/shared/src/reportPdf/reportPdf.ts`): STRONG ≥ 80, GOOD ≥ 60, FAIR ≥ 40, AT RISK < 40. Threat counts are labelled "endpoint threat events" with a per-source breakdown; no cross-provider dedup is claimed.

## 3. Scope

**In:** W01 trust hazards; portal read-model foundation + RLS proof; five feature toggles + nav/API gating (fixing the existing Devices nav/API mismatch); dashboard; security page; backups page; devices enrichment + CSV export; support usage + ticket SLA fields + invoice line ticket numbers; report self-service (list, generate, download) + contact-bound scheduled recipients; MSP-side settings and report-builder changes.

**Out (later waves per #4562):** activity feed, action-items page, QBR pack, digest email, onboarding tracker, M365 depth, portal roles/SSO, ticket attachments/CSAT, contact↔device assignment, any third-party backup evidence (spec `docs/superpowers/specs/reports/2026-07-14-posture-backup-evidence-design.md` stays parked).

## 4. Tenancy contract

### 4.1 What the portal session can read today

`portalAuthMiddleware` (`apps/api/src/routes/portal/auth.ts`) wraps every authenticated handler in `withDbAccessContext({ scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null, currentPartnerId: null })`. `breeze_has_org_access(x)` (`apps/api/migrations/0008-tenant-rls.sql`) is therefore exactly "x = the session org". `breeze_current_user_id()` is NULL; `breeze_has_partner_access` never passes.

| Wave 1 read | RLS shape | Portal session |
|---|---|---|
| `organizations`, `portal_branding`, `devices`, `device_warranty`, `tickets`, `fleet_findings`, `remediation_suggestions`, `security_status`, `security_posture_org_snapshots`, `security_threats`, `device_patches`, `s1_agents`, `s1_threats`, `huntress_agents`, `huntress_incidents`, `device_vulnerabilities`, `backup_configs`, `backup_jobs`, `backup_verifications`, `recovery_readiness`, `backup_sla_configs`, `backup_sla_events`, `reports`, `contacts`, `invoices`, `invoice_lines` | direct `org_id` (shape 1) or id-keyed (shape 2) | passes for own org |
| `report_runs` | parent-FK join to `reports.org_id` (`2026-06-13-b-fk-child-rls-backstop.sql`) | passes for own org |
| `patches` | global catalog, no tenant RLS | readable (severity only, no tenant data) |
| `time_entries` | **partner-axis** (shape 3), `org_id` nullable and denormalised | **fails** |
| `vulnerabilities` | global catalog, **system-only** policy | **fails** (the org's `device_vulnerabilities` rows pass) |

### 4.2 Rules

1. Ordinary Wave 1 reads run **inside the ambient org-scoped transaction**. No manual context calls. `breeze_has_org_access` is **not** widened.
2. Exactly two read-only aggregators exit the request context (`runOutsideDbContext` → `withSystemDbAccessContext`), both in `apps/api/src/services/portal/`:
   - `supportUsageForOrg(orgId, month, tz)` — filters `time_entries.org_id = orgId` **and** joins `tickets` on `time_entries.ticket_id` with `tickets.org_id = orgId`; returns grouped minutes and per-ticket buckets only. Never technician ids, notes, descriptions, or hourly rates.
   - `vulnerabilitySeverityForFindings(vulnIds)` — takes the vulnerability ids already selected from the org's `device_vulnerabilities` rows and returns `{id, severity, isKev}` from the catalog. Mirrors `securityComplianceReportVulnerabilities.ts`.
   Both take a **server-derived** org id (from the session), never request input.
3. Every new portal endpoint has a unit test asserting the compiled SQL contains the org predicate (see `vacuous_drizzle_where_clause_assertions` lesson), and W02 adds `apps/api/src/__tests__/integration/portalVisibilityRls.integration.test.ts` proving, against real Postgres under a forged portal context for org A, that org B's `security_status`, `security_posture_org_snapshots`, `backup_verifications`, `report_runs`, and `time_entries`-derived usage are invisible, and that `supportUsageForOrg(A)` returns zero minutes from B's entries.

## 5. Feature gating

Five new boolean columns on `portal_branding`, all `NOT NULL DEFAULT false`:

`enable_dashboard`, `enable_security`, `enable_backups`, `enable_reports`, `enable_support_usage`

- **API:** one middleware per prefix, created with a fail-closed variant of `createPortalFeatureGate` (`routes/portal/featureFlags.ts` — the existing helper fails open; new gates must return 403 when the branding row is missing or the flag is false). Mounts in `routes/portal/index.ts`: `/dashboard/*`, `/security/*`, `/backups/*`, `/reports/*`, `/tickets/usage` (support usage lives under tickets but carries its own gate; register the route before `/tickets/:id`).
- **Frontend:** `GET /portal/branding` returns the five flags; `buildPortalNavItems` (`apps/portal/src/lib/navItems.ts`) reads all of them **and** `enableSelfService` for Devices (the existing mismatch: the API 403s `/devices/*` when self-service is off but the nav still shows Devices — fixed here).
- **Nav order when enabled:** Dashboard first; then the existing order (Proposals, Invoices, Support, Devices); then Security, Backups, Reports; then Equipment, Profile.
- **Landing:** `/` and post-login redirect to `/dashboard` when `enable_dashboard`, otherwise `/quotes` (unchanged).
- **MSP side:** `apps/web/src/components/settings/OrgPortalSettingsEditor.tsx` gains the five toggles under a "Visibility" group with an "Enable all visibility" action. Enabling `enable_reports` provisions the canonical report definitions (§8.2) under the acting staff user.
- `portal_branding` is an org-cascade table: the five columns get `included` entries in `CORE_TENANT_EXPORT_POLICY`.

## 6. API surface

All under `/api/v1/portal`, all behind `portalAuthMiddleware` + the prefix gate. Responses use `private` ETag + `Cache-Control: private, max-age=30` (mirror `routes/portal/devices.ts`). Every aggregate carries `asOf` and, per section, a `dataStatus: 'ok' | 'no_data' | 'not_configured' | 'stale'`; the API returns `null` + status, never a fabricated zero.

| Endpoint | Purpose |
|---|---|
| `GET /dashboard` | One call for the landing page. Runs the tile queries in parallel inside the org transaction. |
| `GET /security/overview?days=30` | Score history (daily), weekly threat detected/resolved counts (8 weeks) by source, open vulnerability counts by severity + KEV count, freshness. |
| `GET /security/devices?page&limit` | Per-device protection table. |
| `GET /backups/overview` | Protected/unprotected device counts, last passed verification, last test restore, open RPO/RTO breaches, mean readiness. |
| `GET /backups/devices?page&limit` | Per-device backup table. |
| `GET /devices` (existing) | Add the enrichment columns (§7.6). |
| `GET /devices/export.csv` | Same projection, streamed CSV, filename `<org-slug>-devices-<YYYY-MM-DD>.csv`. |
| `GET /tickets` and `GET /tickets/:id` (existing) | Add `sla` object (§7.5). |
| `GET /tickets/usage?month=YYYY-MM` | Month-to-date support usage (§7.5). Defaults to the current month in the org timezone. |
| `GET /invoices/:id` (existing) | Customer line DTO gains `ticketNumber: string | null`. |
| `GET /reports/runs?page&limit` | Completed runs of the org's canonical portal definitions, newest first. |
| `POST /reports/generate` `{ type }` | Synchronous run of the canonical definition for `type ∈ {security_compliance_posture, executive_summary}`. |
| `GET /reports/runs/:id/pdf`, `GET /reports/runs/:id/csv` | Server-rendered artefacts (§8.3). |

Org timezone for "this month" and "today": org → partner → UTC, the same resolution `apps/api/src/jobs/reportScheduleWorker.ts` uses. Expose it in every month-scoped response so the UI can label it.

## 7. Read-model definitions (the contract)

Services live in `apps/api/src/services/portal/` as pure `(orgId, opts)` functions returning typed DTOs; routes are thin.

### 7.1 Dashboard tiles

| Tile | Definition | Source |
|---|---|---|
| Security score | Latest `security_posture_org_snapshots` row: `overall_score`, band (§2), `captured_at`; `delta30d` = score minus the row nearest 30 days earlier (`getSecurityPostureTrend`). `stale` if `captured_at` > 24 h old (the cron is hourly). | `securityPosture.ts` |
| Devices protected | `{protected, unprotected, unknown, total}` using the posture report's normalisation, extracted into a shared helper: protected = managed by an S1/Huntress agent row **or** native AV present with `real_time_protection = true`; unknown when `security_status` is missing or older than the report's staleness threshold (`securityComplianceReport.ts` ~L427 — the plan pins the exact number). | `security_status`, `s1_agents`, `huntress_agents` |
| Patches applied this month | `count(device_patches)` where `status = 'installed'` and `installed_at` within the current month (org tz), joined to `devices.org_id`. Secondary: devices with ≥1 outstanding critical patch (`OUTSTANDING_DEVICE_PATCH_STATUSES` × `patches.severity = 'critical'`). | `device_patches`, `patches` |
| Last backup verified | Latest `backup_verifications` with `status = 'passed'` → `completed_at`, `verification_type`; plus `{configured, total}` device counts (devices with an active `backup_configs` row). `not_configured` when the org has no backup configs. | `backup_verifications`, `backup_configs` |
| Support | Open tickets = `tickets.org_id = org` with status ∈ {new, open, pending, on_hold} (org-wide, decision 2). Avg first response = mean of `first_response_at − created_at` over tickets created this month with a first response; `sampleSize` included. | `tickets` |
| Action items | Count of `fleet_findings` with status ∈ {open, acknowledged} plus `remediation_suggestions` with status `suggested`; `topIssues` = the latest snapshot's `top_issues` (max 3). Tile is count-only in Wave 1; the page is a later wave. | `fleet_findings`, `remediation_suggestions`, snapshot |
| Awaiting you | Proposals awaiting review + invoices with balance due (the existing list footers) so the landing page keeps the billing call-to-action. | existing portal queries |

### 7.2 Security page

- **Score history:** daily points for `days` (30 default, max 90) from `getSecurityPostureTrend({orgId, days})`; rendered as an inline SVG sparkline with the current band.
- **Per-device table:** device name, protection state (as 7.1), AV product name(s) (`security_status.av_products` via `prettySecurityProvider`), real-time protection, definitions age (days since `definitions_date`), disk encryption (`encryption_status`), firewall (`firewall_enabled`), pending critical patches (count), observed at. Sorted unprotected first.
- **Threat events:** 8 weekly buckets. Detected = `security_threats.detected_at`, `s1_threats.detected_at`, `huntress_incidents.reported_at` in the bucket; resolved = the corresponding `resolved_at`. Per-source counts kept; label "endpoint threat events". No email/DNS threats (not in scope; the site copy for those is a separate concern).
- **Vulnerabilities:** open `device_vulnerabilities` (status `open`) for the org, grouped by catalog severity via the §4.2 aggregator; KEV count; `lastDetectedAt`.

### 7.3 Backups page

Per device (all enrolled devices, so "not configured" is visible): last restore point = max `backup_jobs.completed_at` with status ∈ {completed, partial} (partial flagged degraded); last test restore = latest `backup_verifications` with `verification_type = 'test_restore'` (status, `completed_at`, `restore_time_seconds`); open breaches = `backup_sla_events` with `resolved_at IS NULL` (type); readiness = `recovery_readiness.readiness_score`, `estimated_rto_minutes`, `estimated_rpo_minutes`. Overview = counts over the same rows plus the 7.1 tile fields. Reuse `getBackupHealthSummary(orgId)` (`routes/backup/readinessCalculator.ts`) where its fields match.

### 7.4 Reports tab

See §8.

### 7.5 Support usage and ticket SLA

- **Ticket `sla` object** (list + detail, only for tickets the user can already see): `firstResponseMinutes` (`first_response_at − created_at`), `resolutionMinutes` (`resolved_at − created_at − sla_paused_minutes`), `responseTargetMinutes`, `resolutionTargetMinutes`, and `status ∈ {breached, at_risk, paused, on_track, met, not_configured}` computed with the same rules as the MSP list (`routes/tickets/tickets.ts` ~L68: at-risk at 80 % of target; paused when `sla_paused_at` is set; targets via `services/ticketSla.ts`).
- **Usage panel** (`GET /tickets/usage`): month, timezone, totals in minutes and hours for four buckets, and per-ticket rows. Entry selection: `time_entries.org_id = org`, `ticket_id` not null, joined ticket in the org, `is_billable = true`, `billing_status ≠ 'no_charge'`. Buckets: `billed` (`billing_status = 'billed'`), `toBeBilled` (`not_billed` and `is_approved`), `coveredByContract` (`contract`), `pendingReview` (`is_approved = false`). Per-ticket row: `ticketNumber`, minutes per bucket, and `title` **only when the current portal user submitted the ticket** (decision 2); otherwise `title: null`.
- **Invoice lines:** `toCustomerInvoiceLine` (`services/invoiceService.ts`) gains `ticketNumber` by left-joining `tickets` on `invoice_lines.ticket_id` with the org predicate. No `source_type`/`source_id` leaves the DTO.

### 7.6 Devices enrichment + CSV

Columns added to the portal device projection: `lastPatchAt` (max `installed_at`), `protection` (7.1 state), `encryption`, `lastBackupAt` (7.3 last restore point), `warrantyEndsAt` (`device_warranty.warranty_end_date`). CSV export streams the same rows; header names are the UI labels.

## 8. Report self-service

### 8.1 What exists

`report_runs` stores a JSONB `result` snapshot, never PDF bytes. The MSP web app renders PDFs client-side with `buildReportPdf` (`packages/shared/src/reportPdf`); the schedule worker renders the same function in Node and emails the bytes. `reports.org_id` is NOT NULL; `reports.created_by` references a staff user. `report_runs` carries an execution-scope snapshot (`execution_scope_principal_kind: 'user' | 'system'`, `execution_scope_user_id`, …) written from `ReportExecutionAuthority` (`services/siteScope.ts`).

### 8.2 Canonical portal definitions

- New column `reports.portal_self_service boolean NOT NULL DEFAULT false`, partial unique index on `(org_id, type) WHERE portal_self_service`. Export policy: `included`.
- Provisioned when the MSP enables `enable_reports` for the org (§5): one `executive_summary` and one `security_compliance_posture` definition, `name = 'Customer portal — <label>'`, `schedule = 'one_time'`, fixed customer-safe config (`dateRange.preset = 'last_30_days'`, no site filter, posture config defaults), `created_by` = the acting staff user. Idempotent (re-enabling reuses existing rows). The builder shows them read-only with a "Visible in customer portal" badge; they cannot be deleted while the flag is on.
- The portal lists and downloads **only** runs whose parent report has `portal_self_service = true` (decision 4).

### 8.3 Generation and download

- `POST /portal/reports/generate {type}`: 404 if the canonical definition is missing (flag on but never provisioned — the settings editor heals this), 429 with `Retry-After` when over **5 runs per org per hour** or when a run for that type is already `running` (state in the existing `PORTAL_STATE_BACKEND` store next to the auth rate limiter). Otherwise calls `generateReport` synchronously (decision 3) with a **`portal_user` execution authority**: `ReportExecutionAuthority` gains `principalKind: 'portal_user'` with `scope: { kind: 'unrestricted', orgId }` and no staff user id. Response is the completed (or failed) run.
- Run provenance: `report_runs.requested_by_kind text` (`'user' | 'system' | 'portal_user'`, NULL for legacy rows), `requested_by_user_id uuid` (FK `users` ON DELETE SET NULL), `requested_by_portal_user_id uuid` (FK `portal_users` ON DELETE SET NULL), with a CHECK that the id column matching `requested_by_kind` is set and the other is NULL. MSP and scheduled paths populate the first two; the portal path the third. `execution_scope_principal_kind` accepts `'portal_user'`.
- `GET /portal/reports/runs/:id/pdf`: loads the run under the org transaction (RLS via parent join), renders with `buildReportPdf` server-side (same code path as the worker; same branding via `reportBranding.ts`), streams `application/pdf` with `Content-Disposition: attachment`. `GET …/csv` uses the existing `rowsToCsv`. A render failure returns 500 with a generic message and logs the run id.

### 8.4 Scheduled recipients bound to contacts

- New table `report_schedule_recipients` (shape 1): `id uuid PK`, `report_id uuid NOT NULL`, `org_id uuid NOT NULL`, `contact_id uuid NOT NULL`, `created_at`. Composite FKs `(contact_id, org_id) → contacts(id, org_id) ON DELETE CASCADE` (the unique `(id, org_id)` on contacts exists) and `(report_id, org_id) → reports(id, org_id) ON DELETE CASCADE` (add `reports_id_org_id_uniq` if absent). Unique `(report_id, contact_id)`. RLS enabled + forced, one policy per command `breeze_has_org_access(org_id)` OR system, `GRANT SELECT, INSERT, UPDATE, DELETE TO breeze_app`, all in the same idempotent migration.
- Registration in the same PR: `CORE_ORG_CASCADE_DELETE_ORDER` (position by `localeCompare`, before `reports`; verify FK direction: it references `reports` and `contacts`, so it must be deleted before both), `CORE_TENANT_EXPORT_POLICY` (every column `included`). Shape 1 needs no RLS allowlist entry; no `device_id`, so no device-cascade lists. Org-only ownership is justified: this is per-customer delivery data, not a reusable policy (Partner-Wide First exception, documented in the migration header).
- Worker: recipients = contact emails from the table (skip and log contacts with NULL email) ∪ legacy `config.emailRecipients`, de-duplicated case-insensitively. **No automatic backfill** of legacy addresses. The builder shows a contact multi-select (org contacts with an email) and the legacy list with a per-address "convert to contact" action that the MSP triggers manually.
- The 50-address cap applies to the union.

## 9. Portal UI

Pages follow the existing pattern: Astro page SSR-fetches via `portalApi` + `buildServerApiConfig`, redirects on 401, renders a React component that takes data as props. New pages: `pages/dashboard/index.astro`, `pages/security/index.astro`, `pages/backups/index.astro`, `pages/reports/index.astro`; new components under `components/portal/` (`DashboardTiles.tsx`, `SecurityOverview.tsx`, `SecurityDeviceTable.tsx`, `BackupOverview.tsx`, `BackupDeviceTable.tsx`, `ReportRunList.tsx`, `SupportUsagePanel.tsx`, `Sparkline.tsx`, `WeeklyBars.tsx`). Every tile, table and action carries a `data-testid` (`portal-dashboard-tile-security`, `portal-reports-generate-posture`, …). Empty and `not_configured` states are honest copy ("No backup is configured for this device"), never blank. Timestamps show the org timezone label. No i18n exists in `apps/portal`; strings stay English like the rest of the portal.

## 10. MSP-side changes

- **W01 trust hazards:** `apps/web/src/components/reports/ReportTemplates.tsx` — remove the "SLA Compliance", "Patch Compliance", "Technician Activity" and "Billing/Usage" cards (they alias to `compliance` / `device_inventory` / `software_inventory`); the remaining cards must name their real type. `apps/web/src/components/audit/ComplianceReport.tsx` and `apps/web/src/components/software/SoftwareComplianceReport.tsx` render literal in-file arrays: delete them and any page/route that mounts them, or replace the arrays with real queries if a route depends on them (the plan decides per component after checking mounts).
- Org portal settings editor: five toggles + bulk enable (§5); provisioning of canonical reports on enabling `enable_reports`.
- Report builder: "Visible in customer portal" badge on canonical definitions; contact recipients (§8.4).

## 11. Testing

- **Unit (Vitest, Drizzle mocks per `breeze-testing`):** every `services/portal/*` function asserts the compiled SQL carries the org predicate; DTO shape tests; SLA status matrix (breached / at risk / paused / met / not configured); usage bucket matrix over `billing_status × is_approved`; band thresholds; nav builder with each flag combination including `enableSelfService=false` hides Devices.
- **Integration (real Postgres):** `portalVisibilityRls.integration.test.ts` (§4.2 rule 3); `rls-coverage` auto-discovers `report_schedule_recipients`; `tenantCascade`, `tenant-export-policy`, `tenantExportErasureRoundtrip` cover the new table and columns; a report self-service test proves a portal-initiated run stores `requested_by_kind = 'portal_user'` and that org B cannot fetch org A's run PDF.
- **E2E (Playwright, `data-testid` only):** new `e2e-tests/tests/portal-visibility.spec.ts`: enable flags for the seeded org, log in as a portal user, assert dashboard tiles render with the seeded values, generate a posture report and download the PDF, assert Devices disappears from nav when self-service is off.

## 12. Wave split (one PR each)

| Wave | Content | Migration |
|---|---|---|
| W01 | Trust hazards: template cards, mock compliance components | none |
| W02 | Portal read-model foundation: `services/portal/` scaffolding, the two system-context aggregators, protection normaliser extracted from the posture report, RLS integration test, query indexes (`device_patches(installed_at)`, threat timestamp indexes, `backup_verifications(org_id, completed_at)`, `time_entries(org_id, started_at)`) | indexes only |
| W03 | Flags and shell: five `portal_branding` columns + export policy, fail-closed gates, mounts, nav builder (incl. Devices fix), landing redirect, settings editor toggles + bulk enable | columns |
| W04 | Dashboard API + page | none |
| W05 | Security overview/devices API + page | none |
| W06 | Backups overview/devices API + page | none |
| W07 | Devices enrichment + CSV export | none |
| W08 | Ticket `sla`, support usage API + panel, invoice line `ticketNumber` | none |
| W09 | Reports foundation: `reports.portal_self_service`, run provenance columns, `portal_user` authority, `report_schedule_recipients` + worker union + builder recipients UI + canonical provisioning on flag enable | columns + new table |
| W10 | Portal reports API (list, generate, pdf, csv) + Reports tab + "Visible in customer portal" badge + e2e | none |

Dependencies: W02 → W03 → {W04, W05, W06, W07, W08} in any order; W09 → W10. W01 is independent. Migration filenames must sort after the newest committed migration at PR time (as of 2026-09-02 that is `2026-09-27-technician-ticket-write-permissions.sql`, i.e. names must be `2026-09-28-…` or later; never the `2026-08-06` block).

## 13. Non-goals and known limits

- Threat events are endpoint-only; email security, phishing simulation, dark web and document access logs have no data in Breeze (audit W4).
- Backups reflect Breeze-managed backup configs only; MSPs using third-party backup should leave `enable_backups` off (why decision 1 defaults off).
- "Business impact" is not computed in Wave 1.
- Portal users still see only their own tickets in the list; org-wide aggregates are counts and minutes only.
- The action-items tile links nowhere until the roadmap page wave ships.
