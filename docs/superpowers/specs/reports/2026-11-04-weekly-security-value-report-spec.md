# Security Outcomes Report with a Partner-Editable Estimated-Value Model (Design Spec)

- **Issue:** #11021
- **Date:** 2026-11-04, verified against `main` @ `36f9d9ca53`
- **Status:** Draft for review (Gate A). Nothing here is approved.
- **Builds on:** `docs/superpowers/specs/reports/2026-06-29-security-compliance-posture-report.md` (posture report, shipped), `docs/superpowers/specs/reports/2026-09-28-multi-org-report-series-design.md` (series fan-out, shipped), the #5784 service-evidence generators (`threatDetectionReport.ts`, `vulnerabilityManagementReport.ts`, `identityAccessReport.ts`), and `docs/superpowers/specs/reports/2026-10-18-business-reports-phase-2-spec.md` (#6830: report registry conventions, the opt-in `laborCostPerHour` estimate precedent).
- **Scope:** this spec only. The wave plans are written after Gate A.

## 1. Problem

A design-partner MSP asked for a weekly customer-facing report that shows what the security stack did: threats stopped, patches applied, risky sign-ins caught, what is still open. Competing products add a headline "value delivered" figure, derived from industry-average costs per incident.

Breeze already holds most of the signals and most of the delivery machinery:

| Need | `main` @ `36f9d9ca53` | Gap |
|---|---|---|
| Current posture: controls, unprotected devices, open vulns | `security_compliance_posture` (`services/securityComplianceReport.ts` + `…Edr.ts`, `…Products.ts`, `…Vulnerabilities.ts`). Portal-visible (`PORTAL_REPORT_TYPES`, `services/portal/reportsSelfService.ts`). | Point-in-time. It has no "what happened this week" section. |
| Posture score and trend | `listLatestSecurityPosture` / `getSecurityPostureTrend` / `buildRecommendations` (private today) (`services/securityPosture.ts`); history in `security_posture_org_snapshots` (`db/schema/security.ts`) | Not on any customer report as a trend. |
| Events in a window | Threat incidents (`threatDetectionReport.ts`), vulnerability findings (`vulnerabilityManagementReport.ts`), sign-ins (`identityAccessReport.ts`), alerts (`generateAlertSummaryReport`), patches, DNS, backups (§3.2) | Each lives in its own report, mostly monthly managed evidence. No roll-up. |
| Weekly schedule + email + branded PDF | `reports.schedule = 'weekly'`, `jobs/reportScheduleWorker.ts`, `services/reportDelivery.ts` (PDF attached), `report_schedule_recipients` (contacts), partner branding (`services/reportBranding.ts`) | Works today for any type. |
| "Every client, every Monday" | Report series, "All orgs (live)" fan-out with per-org contact recipients (`services/reportSeries/`) | Works for org-scoped, `execution: 'user'`, non-`msp_staff` types (`assertSeriesTypeSupported`, `reportSeries/validation.ts`). This is why the new type is `execution: 'user'`. |
| Customer portal | Portal lists completed runs only for `reports.portal_self_service = true` definitions (`portalRunListPredicate`, `reportsSelfService.ts`) | An MSP-scheduled definition or series child **never** reaches the portal. The email's "View in Breeze" link points at the MSP app's `/reports` (`reportDelivery.ts`), which a customer contact cannot open. |
| Estimated value | No security ROI or cost-avoided concept exists. Two estimate precedents do: the AI agents' partner-weighted "Estimated time saved" (`partners.ai_impact_weights`) and the opt-in `laborCostPerHour` estimate on `client_profitability` (`services/reportConfigSchemas.ts`). Both print nothing when unset. | New. |

So the feature is: **one new report type on the existing engine** (a windowed activity roll-up plus current posture plus an optional value section), **one new setting** (the value model, partner default with org override), and **one delivery gap closed** (scheduled runs published to the portal).

## 2. Users & scope

- **Authors:** MSP staff. Partner scope creates a series ("All orgs, weekly, Monday 08:00"); org scope creates a single-org definition. Same as every org-scoped type.
- **Readers:** the customer. Audience `'any'`: the report is customer-facing by design. It is delivered by email to org contacts and, when published (§3.6), listed in the customer portal.
- **Value model owner:** the partner sets the default; an org override is allowed per field (§3.5). Customers never edit it and never see the settings screen. They see only the frozen snapshot printed on the report.
- **Report scope:** `supportedScopes: ['organization']` (`ORG_ONLY`). One report per org. A partner-owned cross-org aggregate ("all my clients' value this quarter") is out of scope (§5, OD7). Fan-out to many orgs uses the series, which produces one org-owned child per org.
- **Site-restricted authorities and `config.sites`:** supported, same as `security_compliance_posture`. Site scope is pushed into every device-attributed query branch independently, as `threatDetectionReport.ts` does. **The same rules apply to an explicit `config.sites` filter on an unrestricted authority.** A site-filtered report must not count org-wide sources either. Sources with no site dimension (M365 sign-ins, DNS by org, partner-level EDR incidents without a device) are **refused under a restricted authority or a site filter and printed as "not available for a site-limited report"**, never silently dropped or counted org-wide.
- **Permissions:** no new grant. Generation follows the existing `REPORTS_*` route gates. The value-model settings write is gated like flow limits (§3.5).

## 3. Proposed design

### 3.1 New report type `security_outcomes`

Registry entry in `services/reportRegistry.ts`:

```ts
security_outcomes: {
  type: 'security_outcomes', label: 'Security outcomes',
  configSchema: securityOutcomesConfigSchema, supportedScopes: ORG_ONLY,
  execution: 'user', audience: 'any', requiredPermissions: NO_EXTRA_PERMISSIONS, detailRowCap: UNCAPPED,
  generate: async (scope, config, authority) => { /* orgOf + requestAuthority, lazy import */ },
}
```

- `REPORT_TYPES` gains `security_outcomes` at the end (`packages/shared/src/reportTypes.ts`); one enum-only migration, `ALTER TYPE report_type ADD VALUE IF NOT EXISTS 'security_outcomes'`.
- Generator: `services/securityOutcomes/securityOutcomesReport.ts` as a thin orchestrator, plus one module per section (`posture.ts`, `activity.ts`, `openRisks.ts`, `value.ts`). This follows the `securityComplianceReport*.ts` split and keeps each file under ~500 lines.
- `execution: 'user'`, not `managed_evidence`. This is a scheduled customer report, not a service-plan deliverable, and series fan-out refuses managed-evidence types. Turning it into managed evidence needs a weekly deliverable cadence, which `deliverable_cadence` does not have (`db/schema/serviceDeliverables.ts`). Not needed for v1.
- Name rationale: the type is cadence-agnostic (weekly is the default, monthly works), and it is distinct from `security_compliance_posture`, which answers questionnaires. OD1 covers merging instead.

**Config schema** (`services/reportConfigSchemas.ts`, a `looseObject` per the registry rule):

| Key | Default | Meaning |
|---|---|---|
| `sites` | `[]` | Site filter. Same semantics as the posture report. |
| `dateRange` | `{ preset: 'last_7_days' }` | On-demand window. Scheduled runs override it (below). |
| `sections` | all on | `posture`, `activity`, `actions`, `openRisks`, `recommendations`, `estimatedValue`. |
| `includeEstimatedValue` | `false` | Shorthand for the value section. Off by default: a partner opts in per definition **and** must have an enabled value model (§3.5). |
| `trendWeeks` | `8` | Posture trend length. |
| `topOpenRisks` | `10` | Cap on each open-risk list. The full count is always printed. |

**Window.** A scheduled run covers `[previous scheduled occurrence, this occurrence)` in the report's timezone, so consecutive weekly reports tile with no gap and no overlap. An on-demand run uses `dateRange`. The window is printed on the cover.

The occurrence helpers (`lastOccurrenceKey`, `packages/shared/src/utils/reportSchedule.ts`) return wall-clock keys, not UTC bounds, and the worker passes config through unchanged. W1 therefore adds three things:

- a shared `occurrenceWindow(cadence, scheduleConfig, timezone, occurrenceKey)` that converts the key pair into UTC instants;
- a rule for DST gaps and overlaps: a nonexistent local time moves forward, and an ambiguous local time takes its first instance;
- a worker change that freezes `{ occurrenceKey, timezone, start, end }` on the `report_runs` row before generation, so a retry recomputes nothing.

A missed occurrence (worker down) still produces one run per occurrence, each with its own window. A schedule edit starts the next window at the edit's first new occurrence. The gap between the old and new schedule is printed once as a note, never silently merged.

### 3.2 Data sources

Every category is a read over rows Breeze already stores. **No new collection.** Paths are under `apps/api/src/`.

| Category (metric keys) | Source | Event or state | Window rule | Caveats the report prints |
|---|---|---|---|---|
| **Posture score + trend** | Latest score via `listLatestSecurityPosture` / `getSecurityPostureCounts`; trend via `getSecurityPostureTrend` (all in `services/securityPosture.ts`). The trend already takes a site allowlist (`listSiteScopedTrendRuns`). | Snapshots are append-only, written hourly (`jobs/securityPostureWorker.ts`) | Score = latest snapshot at or before window end. Trend = the last point of each week for `trendWeeks` weeks. | The score is the most recent hourly snapshot, not a live recompute, and its timestamp is printed. There is no snapshot retention job, which is fine for an 8-week trend. `buildRecommendations` is module-private today, so W1 exports it. |
| **EDR/MDR threats** (`edr_threat_detected`, `edr_threat_remediated`) | `huntress_incidents` (`db/schema/huntress.ts`), `s1_threats` (`db/schema/sentinelOne.ts`), `edr_detections` (GravityZone, Emsisoft; `db/schema/edrProviders.ts`) | Event rows with `detected_at`/`reported_at` and `resolved_at` | Detected: created in window. Remediated: `resolved_at` in window and status in the source's resolved set (`HUNTRESS_RESOLVED_STATUSES`; S1 `resolved`; EDR `mitigated`/`resolved`). `false_positive` and `dismissed` are excluded from remediated. | Partner integrations resolve to the org through their mappings, and unmapped sites are never attributed. **S1:** `normalizeThreatStatus` (`jobs/s1Sync.ts`) maps resolved, mitigated, clean and closed to `resolved`, but a `killed` threat stays `active`, so S1 remediation is an undercount and the note says so. **Emsisoft:** one vendor incident fans out to one detection row per involved device, and a closed incident's time can be the vendor's last-detection time rather than a remediation time (`services/edrProviders/emsisoft/normalize.ts`). The report counts per affected device and discloses the Emsisoft timing basis. Reuses the source-status and coverage logic of `threatDetectionReport.ts`, which reads Huntress and EDR today but **not `s1_threats`**. W1 adds S1 as a third branch. |
| **Native AV** (`av_threat_neutralized`) | `security_threats` (`db/schema/security.ts`) | Event rows | `detected_at` in window and current status `quarantined` or `removed` | A quarantine **clears** `resolved_at` (`routes/agents/helpers.ts`), and there is no quarantine timestamp, so the count is "found this window and neutralized since". It is not "neutralized this window". Rows come only from **Breeze-initiated scans**, not from Defender's real-time detections, and the label says "found by Breeze scans". **Dedup with EDR:** valued only on devices with no healthy managed-EDR link during the window; on EDR devices it is shown, not valued. `security_status.threat_count` is a gauge and is **not** used. |
| **Email threats** (the issue's "phish blocked") | **None.** No email-security integration exists. | — | — | There is no metric key (OD8). The methodology appendix lists "Email security: not covered". DNS `phishing`-category blocks are counted under DNS, never relabelled as email. |
| **DNS threats** (`dns_threat_blocked`) | `dns_event_aggregations` (daily, **delta rows that must be SUMmed**, `jobs/dnsSyncJob.ts`); `dns_security_events` for top domains (`db/schema/dnsSecurity.ts`) | Event / daily aggregate | `blocked` in window, category in `DNS_THREAT_CATEGORIES` only (content-policy blocks are not threats) | `dns_filter_integrations` is org-scoped. Aggregates are keyed by **UTC date**, so the DNS window snaps to whole UTC days covering the report window, and the snapped bounds are printed. Weeks still tile, because the snapping is deterministic. Device attribution is optional, so DNS is refused under site restriction unless every counted row has a `device_id` in scope. Retention is 90 days by default. |
| **Patches applied** (`critical_patch_applied`, `important_patch_applied`) | `patch_job_results` joined to `patch_jobs.org_id` and `patches` (`db/schema/patches.ts`) | Event row per job × device × patch | `status = 'completed'` and `completed_at` in window. Severity comes from `EFFECTIVE_PATCH_SEVERITY_SQL` (`services/patchSeverityOverlay.ts`), which needs the `device_patches` row joined on the same device and patch and scoped to the org. Its levels are `critical` / `important` / …, not `high`. Counted as **distinct (device, patch)**, so a patch retried by several jobs counts once. | This counts what **Breeze deployed**, which is the outcome an MSP is claiming credit for. A second, labelled line "installed outside Breeze jobs" may count `device_patches.installed_at` in window (agent-reported date, nullable). It is never valued. `patch_compliance_snapshots` has no writer and is not used. |
| **Vulnerabilities remediated** (`critical_vuln_remediated`) | `device_vulnerabilities` + `vulnerabilities` (`db/schema/vulnerabilityManagement.ts`), via `securityComplianceReportVulnerabilities.ts` | **State row, overwritten** | `resolved_at` in window, status `patched`/`mitigated`, severity critical **or** `known_exploited`. **Dedup with patches:** see OD12. | A finding that reopens clears `resolved_at` (`services/vulnerabilityCorrelation.ts`), so a past week's count can shrink on re-run. The frozen run snapshot is the record. The note says counts reflect the state at generation. `accepted` is never counted as remediated. |
| **Risky sign-ins** (`risky_signin_blocked`, `risky_signin_detected`) | `m365_signin_events` (`db/schema/m365Sync.ts`), the same source as `identityAccessReport.ts` | Append-only events | Detected: `risk_level_aggregated` in (medium, high) in window. Blocked: those with `conditional_access_status = 'failure'` only. A non-zero `status_error_code` means a failed sign-in (`identityAccessReport.ts`), not a proven security block, so it is never counted as blocked. | Without Entra ID P2, risk fields come back `hidden`. The category then prints "Not measured — risk data requires Entra ID P2" rather than 0. M365 has no site dimension, so it is refused under site restriction. Google Workspace has no sign-in data and prints "Not measured". `user_risk_scores` rates **Breeze users** (technicians), not customer staff, and is **not** used. |
| **Security alerts resolved** (`security_alert_resolved`) | `alerts` (`db/schema/alerts.ts`) | Event row with `triggered_at`, `resolved_at` | `resolved_at` in window, security-classified, **and `resolution_reason` in (`condition_cleared`, `manual`)**. `expired`, `source_retired` and NULL (legacy) are shown but never valued (`ALERT_RESOLUTION_REASONS`, `packages/shared/src/constants/fixMemory.ts`). Alerts whose source is already priced (`edr_provider`, `dns_threat_%`) are excluded from the valued count. | There is **no category column**. "Classified security alerts" = `context->>'source'` in (`edr_provider`, `security_agent_coverage`), or `config_item_name LIKE 'dns_threat_%'`, or the rule's `alert_templates.category = 'security'`. The classifier is one shared, **versioned** function with a test per arm, and the version is frozen on the run. An alert whose rule or template was since deleted falls through to its `context` arms only. OD9 covers adding a real column. |
| **Backups** (shown, never valued) | `backup_jobs`, `c2c_backup_jobs`, `backup_provider_device_history`, via `services/backupHealthReadModel.ts` | Event / daily | Succeeded/failed in window | Context, not a security outcome. |
| **Open risks** | `securityComplianceReport.ts` (unprotected devices), `…Vulnerabilities.ts` (open KEV/critical), `device_patches` `status='pending'` by severity (`missing` is a stale marker, not pending), unresolved EDR incidents | Current state at generation | — | Reuses the posture report's merge rules exactly, so the two reports never disagree on "unprotected". |
| **Recommendations** | `buildRecommendations` (`services/securityPosture.ts`) plus one item per non-empty open-risk list | — | — | Posture-factor recommendations are generic today ("Improve X"). v1 ranks them with open-risk items first, because those name devices. |

**Value precedent:** the closest existing estimate is the AI agents' "Estimated time saved" (`partners.ai_impact_weights`, `packages/shared/src/types/aiAgentImpact.ts`, `services/aiAgents/impactWeights.ts`). It prices a closed set of counters with partner-editable weights and leaves funnel counters unpriced on purpose. The `client_profitability` `laborCostPerHour` estimate is the second precedent: opt-in, absent by default, and labelled as an estimate. This spec copies that shape (closed registry, priced vs unpriced) and changes two things: the model can be overridden per org, and it is **frozen on each run** instead of re-pricing history at read time. A customer document must not change after delivery (settings rule 6).

### 3.3 Report shape

```ts
type SecurityOutcomesSummary = {
  org: { id: string; name: string };
  window: { start: string; end: string; timezone: string; basis: 'schedule' | 'date_range' };
  posture: {
    score: number | null;                 // latest snapshot at or before window end, for the scope
    scoreCapturedAt: string | null;
    factors: Record<SecurityFactorKey, number | null>;
    trend: Array<{ weekStart: string; score: number | null }>; // getSecurityPostureTrend (site-aware), null = no snapshot that week
  };
  activity: Array<OutcomeCategory>;       // one per category in §3.2, fixed order
  actions: Array<OutcomeCategory & { provenance: 'breeze_initiated' | 'observed' }>;
  // 'breeze_initiated' only where the row proves Breeze acted: patch_job_results, s1_actions / edr_actions
  // completed, security_threats quarantine/remove commands, manual vuln mitigation. Everything else is
  // 'observed' ("resolved this period") and the PDF never says the MSP did it.
  openRisks: {
    unprotectedDevices: { count: number; rows: DeviceRef[] };
    criticalPatchesPending: { count: number | null; rows: DeviceRef[] };
    kevVulnsOpen: { count: number | null; rows: VulnRef[] };
    unresolvedIncidents: { count: number | null; rows: IncidentRef[] };
    // … each list capped at topOpenRisks, count is the full count
  };
  recommendations: Array<{ id: string; title: string; priority: 'critical' | 'high' | 'medium' | 'low'; summary: string; source: 'posture' | 'open_risk' }>;
  estimatedValue: EstimatedValueSection | null; // null when not included
  sources: Array<{ key: string; label: string; status: 'connected' | 'stale' | 'not_connected' | 'not_available_for_scope'; lastSyncAt: string | null; coveredFrom: string | null }>;
  notes: string[];                        // every disclosed approximation, printed
  methodologyVersion: string;             // counting rules + alert classifier version, frozen
};

type OutcomeCategory = {
  key: OutcomeMetricKey;                  // closed registry, shared with the value model (§3.4)
  label: string;
  count: number | null;                   // null = unmeasured, NEVER 0
  breakdown?: Record<string, number>;     // e.g. by severity
  source: string;                         // which source key produced it
};
```

`rows` (the CSV/XLSX body) is the union of the open-risk detail rows with a `section` column, so the tabular export works, like the posture report's per-device body.

**Three honesty rules, inherited from `threatDetectionReport.ts` and the posture spec, and pinned by tests:**

1. **Unmeasured is not zero.** A category whose source is not connected, never synced, or out of scope prints "Not measured", carries `count: null`, and contributes nothing to the value total.
2. **Completeness is never claimed.** When a source's earliest held row is later than the window start, or its last sync is earlier than the window end, the category prints a coverage line (`coverageGapLine`, shared).
3. **Outcomes, not detections, are valued.** The value model may only price outcome metrics: blocked, quarantined, remediated, applied, resolved. A raw detection count is shown but never multiplied (§3.4).

### 3.4 Estimated value: the model

**Closed metric registry, partner-editable unit values.** `OUTCOME_METRICS` in `packages/shared/src/securityOutcomes/metrics.ts` defines every countable outcome: key, label, the counting rule (in words, printed in the methodology appendix), and `valuable: boolean`. Partners edit **unit values only**. They cannot write formulas, add metrics, or price a non-`valuable` metric. A new metric is a code change, because each one needs a counting rule that can be defended.

Registry (counting rules in §3.2):

| Key | Counted as | Valuable |
|---|---|---|
| `edr_threat_remediated` | An EDR/MDR incident or detection that reached a resolved/mitigated state inside the window. False positives and dismissals are excluded. | yes |
| `edr_threat_detected` | An EDR/MDR detection created inside the window | no (shown only) |
| `av_threat_neutralized` | A native-AV threat found by a Breeze scan in the window and since quarantined or removed. Valued only on devices without managed EDR. | yes |
| `dns_threat_blocked` | A DNS-filter block in a `DNS_THREAT_CATEGORIES` category | yes |
| `critical_patch_applied` / `important_patch_applied` | A distinct (device, patch) whose Breeze patch job result `completed` inside the window, by effective severity | yes |
| `critical_vuln_remediated` | A critical or KEV finding moved to `patched`/`mitigated` inside the window | yes |
| `risky_signin_detected` | A medium- or high-risk M365 sign-in | no (shown only) |
| `risky_signin_blocked` | A risky sign-in that conditional access blocked (`conditional_access_status = 'failure'`) | yes |
| `security_alert_resolved` | A classified security alert resolved by `condition_cleared` or `manual`, whose source is not already priced | yes |
| `backup_job_succeeded` | A backup run that completed | no (context) |

**Double counting.** One real-world event can appear in two sources. The rules:

- **Alert vs source.** `security_alert_resolved` excludes alerts whose source is already priced (`edr_provider`, `dns_threat_%`).
- **Native AV vs EDR.** Native AV is valued only on devices without managed EDR.
- **Patch retries.** Patches count as distinct (device, patch).
- **Multi-device incidents.** These count per affected device. Printed as "per device".
- **Patch vs vulnerability.** OD12.

The methodology appendix prints every rule.

**Calculation.** `value = Σ (count × unitValue)` over valuable metrics with `count !== null` and a configured `unitValue`. The PDF prints the arithmetic as a table: metric · count · unit value · subtotal · source. "Estimated value" appears **only** above that table, never as a bare number on the cover. OD3 covers a cover headline.

**Money.** Unit values are stored as decimal strings in the model's single `currency` (ISO 4217) and validated to the currency's minor unit. Arithmetic is exact (integer minor units) and formatting goes through `packages/shared/src/reportPdf/moneyFormat.ts`. There is no FX, same as the business reports.

**Disclaimer.** Always printed under the table. It is two parts: a fixed, brand-neutral sentence that cannot be removed ("Estimated value is illustrative. It multiplies counted outcomes by unit values set by your service provider. It is not a measured loss avoided, an insurance figure, or a guarantee."), plus optional partner text (max 1,000 chars). The fixed sentence is translated in every locale.

**Snapshot (settings rule 6).** The generator resolves the model once and freezes **everything that prints** into the run:

- the counts;
- `estimatedValue.model = { currency, lines: [{ key, unitValue, source: 'partner' | 'organization' }] }`;
- the computed subtotals and total;
- the full printed disclaimer (the fixed sentence in the run's locale plus the partner text);
- `methodologyVersion`;
- `resolvedAt`, `partnerUpdatedAt` and `orgUpdatedAt`.

Re-rendering a PDF from a stored run uses only the frozen values, never a recount or a re-price. A later partner edit, a reopened vulnerability or a classifier change therefore never alters a delivered report. Freezing only the rates would not be enough, because counts over state rows (vulnerabilities) drift.

**No shipped dollar figures.** Breeze ships the registry with every `unitValue` blank. The section is unavailable until a partner enters values. The settings screen can show a "how to choose a unit value" help panel with neutral guidance (use your own incident-response rates, or a published study you cite in the disclaimer text), but no numbers. OD2 covers shipping reference defaults.

### 3.5 Value model as a setting (partner default → org override)

Following `docs/agents/settings.md` and the closest precedent: flow limits (`routes/flowLimits.ts`, `components/settings/FlowLimitsSettings.tsx`). There, one page holds both levels, partner/org is chosen with a selector, and every write is a path-level `jsonb_set` on `settings.<block>`.

- **Storage:** `partners.settings.securityValueModel` (default) and `organizations.settings.securityValueModel` (override). No new table. OD4 covers the alternative.
  ```ts
  type SecurityValueModelSettings = {
    enabled?: boolean;                 // blank = inherit
    currency?: string;                 // blank = inherit
    unitValues?: Partial<Record<ValuableMetricKey, string | null>>; // per key; absent = inherit, null = "do not value this metric"
    unitValuesCurrency?: string;       // stamped by the write route: the currency unitValues were entered in
    disclaimerText?: string | null;
  };
  ```
- **Resolver (rule 5):** `resolveSecurityValueModel(partnerSettings, orgSettings)` in `packages/shared/src/securityOutcomes/valueModel.ts`, plus a loader `services/securityValueModel.ts` that copies `aiApprovalTimeout.ts`: the org row read under the caller's RLS, the partner row through `readWithPartnerAxisVisibility` pinned to that org's `partner_id`. The org wins, field by field. One resolver is used by the settings screen ("resolves to…"), the generator and the preview.
- **Three states per line:** absent = inherit, `null` = "do not value this metric here", or a positive decimal string. `"0"` is refused (`value_model_zero_unit_value`), because zero is not a meaningful price and would print a $0 line that reads like a measurement.
- **Currency rule:** every stored `unitValues` block carries the currency it was entered in (`unitValuesCurrency`, set by the write route, never by the client). The resolver uses a line only when that currency equals the **resolved** currency. Two cases follow:
  - The org overrides `currency`: inherited partner lines in the old currency drop out.
  - The partner later changes its currency: org-entered lines denominated in the old one drop out. They never silently acquire the new denomination.

  Dropped lines show inline on the screen ("entered in USD, model is now MXN, re-enter"). The write route refuses an org currency override that leaves zero valuable lines (`value_model_currency_without_values`).
- **Write gates:** the partner default needs `REPORTS_WRITE` + MFA + `canManagePartnerWidePolicies(auth)`. The org override needs `REPORTS_WRITE` + MFA on that org. Both are partner-staff only: an org-scope (customer) token gets 403, because the customer must not set the value their provider claims to deliver.
- **Subtree ownership:** the generic wholesale settings writers must not bypass or erase the block. The org PATCH in `routes/orgs.ts` already keeps `settings.flows` with `keepOwnedSettingsSubtree(..., 'flows')`. W2 adds `'securityValueModel'` there and in the equivalent partner-settings writer, with a test per writer, so `orgs:write` alone can neither set nor wipe the model.
- **Routes:** `GET/PUT /api/v1/reports/value-model[?orgId=]` in `routes/reports/valueModel.ts`, returning `{ stored, resolved, sources }` like `FlowLimitsViewDto`. Schemas live in `packages/shared/src/validators/securityValueModel.ts`.
- **UI home:** a new Settings entry "Security value model" at `/settings/security-value-model` (group `data`, partner and org scope), registered in `apps/web/src/lib/settingsCatalog.ts` (enforced by `settingsPageRegistry.test.ts`). A form screen, so it uses page Save (rule 7). Every field shows the inherited value and its source when blank (rule 4). A live "example: last week for <org>" preview reuses the generator's value module.
- **Rule 9 count:** the concept "estimated value of security outcomes" is configured in **0** places before and **1** after (one screen, two levels). The per-definition `includeEstimatedValue` toggle is report presentation, like the posture report's section toggles, and not a second home for the model.

### 3.6 Delivery: email, portal, branding

- **Email + PDF:** unchanged path. `reportScheduleWorker.ts` → `emailReportRun` (`reportDelivery.ts`) attaches the branded PDF. Contacts come from `report_schedule_recipients`, or from the series recipient rule for fan-out.
- **Portal (new), at two levels:**
  - **Definition:** `reports.publish_to_portal boolean NOT NULL DEFAULT false`, plus the same column on `report_series`. It is part of the series revision fields, so the reconciler re-stamps children. It is included in `combineGroupKey` (`services/reportSeries/combineKey.ts`), so combining definitions cannot silently change what a customer sees. Detach keeps the value.
  - **Run (the authority):** `report_runs.portal_published_at timestamptz NULL`. The worker stamps it at completion of a **scheduled** run when its definition is published at that moment. A manual "Generate now" run is never auto-published; it gets an explicit per-run "Publish to portal" action. Turning publication on does **not** publish historical runs.
  - **Withdrawal:** a per-run "Withdraw from portal" clears the stamp. Turning the definition flag off asks whether to also withdraw its published runs, defaulting to yes. Archiving a definition stops new runs but leaves already-published runs visible until withdrawn. That is stated in the archive dialog.
  - **Portal predicates:** `portalRunListPredicate` / `portalRunPredicate` widen from `portal_self_service = true` to `(portal_self_service OR report_runs.portal_published_at IS NOT NULL)`. `customerAudienceOnly()` (audience and type-permission), `lifecycleExclusion()` and `deliveredEvidenceOnly()` stay as they are, so an `msp_staff` type can never be listed. The write routes also refuse publishing an `msp_staff` or managed-evidence type (`report_type_not_customer_visible`). The flag is type-agnostic, so the MSP can publish existing customer types (posture, executive summary) too. Portal list gating stays behind `portal_branding.enable_reports`.
  - **Authorization:** publishing is a disclosure to the customer, like adding email recipients. Setting either flag, or publishing a run, needs `REPORTS_EXPORT` + a fresh MFA session (`callerMaySetEmailRecipients`, `routes/reports/recipientGate.ts`), not just `REPORTS_WRITE`. OD5 covers alternatives.
- **Email link:** when the run is published, the email links to the portal run, `${portalBase()}/reports?run=<id>` (`services/portalUrl.ts` supplies only the base, so W3 adds the run deep link). The portal's own login gates that link, and the email carries no token. Unpublished runs keep today's link.
- **EDR visibility:** portal *self-service* runs honour `portal_branding.enable_edr_visibility` through `edrReportEvidenceAllowed` (`services/portal/edrVisibility.ts`). A published MSP-side run is generated under the MSP authority, so the gate does not apply. The definition form warns when publishing a report whose EDR evidence the org has not enabled in the portal, and says that turning `enable_edr_visibility` off later does not retract published runs. OD6 covers enforcing instead.
- **Branding:** `loadReportBrandingForOrg` (partner name, logo, colours) on the PDF, unchanged.
- **PDF:** `packages/shared/src/reportPdf/securityOutcomesPdf.ts` on the primitive kit, added as an arm in `buildReportPdfWithPalette`. Page order: cover (score, trend sparkline, window, headline counts), activity, actions taken, open risks, recommendations, estimated value (when included), methodology and sources, disclaimer. The cover shows the `previous` baseline chip (`previousBaselineFor`).
- **Web:** a "Security" template card plus `SecurityOutcomesOptionsForm.tsx` (sections, trend weeks, value toggle that links to the settings page when no model is enabled, publish-to-portal switch), following `PostureReportOptionsForm.tsx`. New strings go in all locale files (`localeParity.test.ts`), with `data-testid` on new controls. Saves go through the existing `runAction` path.
- **Portal UI:** no new page. Published runs appear in the existing `ReportRunList` (`apps/portal/src/components/portal/ReportRunList.tsx`) with a download button.

### 3.7 AI / MCP

None in v1. `generate_report`'s enum (`services/aiToolsFleet.ts`) stays as it is, the same parity choice Phase 2 made. An AI-written weekly narrative paragraph is a natural follow-up on the `ai_org_narrative` machinery (`reportNarrativeDelivery.ts`). It is out of scope (§5).

## 4. Tenancy & data-model impact

| Change | Shape / contract | Registrations |
|---|---|---|
| `report_type` += `security_outcomes` | Enum-only migration, idempotent, no row writes, so no `breeze.scope` election is needed. Named after the newest committed migration at commit time. Drizzle `reportTypeEnum` + `REPORT_TYPES` equality test. | none |
| `reports.publish_to_portal boolean NOT NULL DEFAULT false` | Column on an existing org-cascade table (`reports` is dual-owner org XOR partner). A CHECK makes it false whenever `org_id IS NULL`, because a partner aggregate has no portal. | **`CORE_TENANT_EXPORT_POLICY` (`services/tenantExportPolicyRegistry.ts`): add `publish_to_portal` to `reports.included`.** Fails only under Integration Tests. |
| `report_runs.portal_published_at timestamptz NULL` (+ partial index on `(report_id) WHERE portal_published_at IS NOT NULL`) | Column on an existing org-cascade table. Org merge and move repoint the row as today; the column follows the row. | **`CORE_TENANT_EXPORT_POLICY`: add to `report_runs.included`.** |
| `report_series.publish_to_portal boolean NOT NULL DEFAULT false` | Partner-only table (shape 3, `partner_id NOT NULL`, no `org_id`) | No export entry (no `org_id`). The reconciler copies it to children, and a series revision bump re-stamps children. |
| `partners.settings.securityValueModel`, `organizations.settings.securityValueModel` | Keys inside existing jsonb blobs. `organizations.settings` is already `excludedOpen`. | None. Note: neither the org override nor the frozen per-run model is in a tenant export, because `organizations.settings` and `report_runs.result` are both `excludedOpen`. This is existing behaviour for every report and is accepted here. |
| Read-only consumers of every §3.2 source | Each query carries an explicit `org_id` predicate (RLS is the backstop). Partner-scoped EDR resolves through its org mapping, exactly as the posture and threat-detection reports do. | none |

No new table, so there is no `rls-coverage` allowlist entry, no `CORE_ORG_CASCADE_DELETE_ORDER` or `orgMergeRegistry` entry, and no worker manifest entry (no new job: scheduled runs already flow through `reportScheduleWorker`). Partner-Wide First is satisfied by the settings shape: the partner default is the primary level.

## 5. Out of scope

- A partner-owned cross-org aggregate ("value delivered across all clients"). OD7.
- New collection: no new agent telemetry and no new integration. Categories without a source print "Not measured" (§3.2).
- An email-security integration. If none exists, it is a separate feature, filed as its own issue.
- AI narrative paragraph, portal interactive dashboard, mobile.
- FX conversion of value figures.
- Benchmarking an org against other orgs or partners.
- Making the type a managed-evidence deliverable (needs a weekly `deliverable_cadence`).

## 6. Open Decisions

1. **A new type, or a section on `security_compliance_posture`?**
   - **A: New type `security_outcomes`.** Pro: a different question ("what happened this week" vs "what is true now"), a different cadence, and a different config surface. The posture report's questionnaire semantics stay untouched. Con: two security reports in the gallery, which need clear names.
   - **B: Add a windowed "activity" section and the value block to the posture report.** Pro: one security report. Con: the posture report is already portal self-service with a fixed config (`PORTAL_DEFINITIONS`), so its output would change for every customer at once, and it gets heavier.
   - **Recommend A.** It reuses the posture report's open-risk modules, so the two can never disagree on "unprotected".
2. **Does Breeze ship default unit values?**
   - **A: No numbers. The section stays unavailable until the partner enters values.** Pro: Breeze never asserts a dollar figure in a customer document; values are regional (the requesting design-partner MSP is outside the US) and currency-specific. Con: more setup friction, and the demo is less impressive.
   - **B: Ship reference defaults with cited public studies.** Pro: works out of the box. Con: Breeze then owns numbers that age, may be mis-cited, and carry no currency logic. A partner who never looked at them ships them to customers.
   - **C: No defaults, plus an explicit "load example values" action that fills the form with clearly labelled examples the partner must save.** Pro: low friction without silent defaults. Con: the example numbers still need a source, and maintaining them.
   - **Recommend A.**
3. **Is the value total on the cover?**
   - **A: Only inside the value section, beside the per-line arithmetic and the disclaimer.** Pro: the number is never read without its basis. Con: less punchy than competitors' headline figure.
   - **B: A cover headline labelled "Estimated value", linking to the section.** Pro: matches what the requester saw. Con: the cover is what gets forwarded and screenshotted.
   - **Recommend A** for v1. B is a one-line config flag later if partners ask for it.
4. **Where is the value model stored?**
   - **A: `partners.settings.securityValueModel` + `organizations.settings.securityValueModel` jsonb keys, written with path-level `jsonb_set`** (the flow-limits precedent). Pro: no migration, no new tenancy shape. Con: the org override is not in a tenant export (the blob is `excludedOpen`), and there is no per-row audit history.
   - **B: A dual-axis table `security_value_models` (org XOR partner, the Partner-Wide First shape).** Pro: first-class rows, `updated_by`, easy history. Con: a full tenancy migration (RLS, SELECT branch, cascade, merge, export) for one small object per level.
   - **C: Dedicated jsonb columns** (`partners.security_value_model`, `organizations.security_value_model`), like `partners.ai_impact_weights`. Pro: a typed home, separate from the general blob. Con: a migration plus an export classification on `organizations`, and it is still `excludedOpen`.
   - **Recommend A.** Revisit B if value models need versioning or more than one model per partner.
5. **How do scheduled runs reach the customer portal?**
   - **A: A definition flag (`reports` / `report_series.publish_to_portal`) plus a run-level stamp (`report_runs.portal_published_at`) that the portal predicate reads** (§3.6). Only scheduled runs completed while the definition is published are stamped. Manual runs are published one at a time, there is explicit withdrawal, and the export + MFA gate applies. Pro: closes the gap for every customer type, history is never exposed retroactively, and the audience/lifecycle/delivered-evidence fences are unchanged. Con: it changes a customer data-boundary predicate and adds columns on two org-cascade tables.
   - **A′ (the first draft): a definition flag only, with the predicate `(portal_self_service OR publish_to_portal)`.** **Codex disagreed:** flipping the flag would publish every historical completed run of the definition, manual runs included, with no withdrawal path. Verified in `portalRunListPredicate`. A was adopted to answer that. Todd should confirm the run-level model, since it is a boundary decision.
   - **B: Provision the type as a portal self-service definition and let the MSP put a schedule on it.** Pro: no new column. Con: one definition per org/type (`reports_portal_self_service_org_type_uniq`) collides with series children, and self-service definitions are customer-generatable.
   - **C: Email only in v1.** Pro: smallest change. Con: misses the issue's portal ask, and the email link still points at an app the customer cannot open.
   - **Recommend A, as its own wave (W3).** Codex agrees with the run-level form.
6. **Do published MSP-side runs honour `enable_edr_visibility`?**
   - **A: No. Warn in the form when publishing with EDR evidence while the org's flag is off.** Pro: the MSP chose to publish, and the flag today governs portal *self-service* runs (`edrReportEvidenceAllowed`). Con: the MSP's portal setting and the report can disagree.
   - **B: Yes. Strip EDR sections from a published run when the flag is off.** Pro: one rule for "what the customer sees about EDR". Con: the emailed PDF and the portal copy then differ, or the email loses data too.
   - **Recommend A.**
7. **Partner-level cross-org aggregate in v1?**
   - **A: No.** The series covers "every client weekly". An MSP-internal "value across all clients" view is a separate `msp_staff` type later.
   - **B: Yes, `supportedScopes: ORG_OR_PARTNER`.** Con: denominators and the value total mix currencies and orgs.
   - **Recommend A.**
8. **Email security (the issue's "phish blocked").**
   - **A: No email metric key until an email-security integration exists. File that integration as its own issue.** DNS `phishing` blocks are counted under DNS. Pro: no dead keys in the model or the settings screen. Con: the report cannot show the competitor's headline phish count.
   - **B: Ship a latent `email_threat_blocked` key that always prints "Not measured".** Pro: the model is stable when the integration lands. Con: a permanently empty row every week.
   - **Recommend A** (codex agrees). The issue's "phish blocked" headline therefore cannot ship until an email-security integration exists. File that integration as a separate roadmap item.
9. **How are alerts classified as security?**
   - **A: A derived classifier** (`context->>'source'`, `config_item_name LIKE 'dns_threat_%'`, `alert_templates.category`) in one shared function with a test per arm. Pro: no schema change on a hot table. Con: a new security alert source must remember to match an arm.
   - **B: Add `alerts.category`, stamped at creation.** Pro: exact and indexable. Con: a column on a hot org-cascade table (export policy classification), every creation site has to be swept, and history stays unclassified.
   - **Recommend A.** File B as a follow-up if a second consumer appears.
10. **What window does a scheduled run cover?**
    - **A: `[previous occurrence, this occurrence)` in the report timezone.** Pro: weeks tile exactly, so no event is counted twice or missed. Con: a late run (worker down) still covers the scheduled interval, not "the last 7 days".
    - **B: The rolling `dateRange` preset at generation time.** Pro: same as other reports. Con: jitter in run time produces overlaps and gaps between consecutive weekly reports.
    - **Recommend A.**
11. **Org override granularity.**
    - **A: Per field (blank = inherit), as settings rule 4 describes.** An org currency override discards inherited unit values. Pro: the rule-4 control. Con: the currency rule is subtle and must be explained in the UI.
    - **B: Whole model: "use partner model" or "custom model".** Pro: simple. Con: it breaks rule 4, and partner edits stop reaching an org that changed one line.
    - **Recommend A.**
12. **Patch and vulnerability overlap.** A Breeze-deployed critical patch can also auto-resolve a critical CVE finding (`vulnerabilityCorrelation.ts` sets `resolved_at` on patch). Pricing both counts one action twice.
    - **A: Price both and disclose the overlap.** Pro: simple. Con: inflates the total in exactly the case competitors are criticised for.
    - **B: Value `critical_vuln_remediated` only for `mitigated` (manual or compensating) resolutions and for KEV findings.** Show `patched` resolutions as "closed by patching" without pricing them. Pro: no overlap, and KEV closure is a distinct, defensible outcome. Con: an MSP that patches well sees a smaller vulnerability line.
    - **C: Exclude a `patched` resolution only when a counted Breeze patch job on the same device in the window maps to that CVE.** Pro: precise. Con: depends on a stored patch→CVE link. Not checked: whether correlation persists which patch closed which finding.
    - **Recommend B for v1**, and C if W1 confirms that the link is stored.
13. **Which "actions taken" may the report attribute to the MSP?**
    - **A: Only rows with Breeze provenance** (`patch_job_results`, completed `s1_actions` / `edr_actions`, `security_threats` quarantine/remove commands, manual vulnerability mitigation) appear as "Actions taken by your provider". Everything else is "Resolved this period". Pro: no claim without proof. Con: vendor-side MDR work (a Huntress analyst closing an incident) is not credited to the MSP.
    - **B: Credit every resolution in the window to the MSP.** Con: claims work the vendor or the end user did.
    - **Recommend A** (raised by codex, adopted).

## 7. Test & rollout notes

**Waves (sketch):**

| Wave | Content | Blast radius |
|---|---|---|
| W1: Generator + PDF + web | Enum migration; registry entry; config schema; section modules over existing sources; PDF module; options form; template card; locales; docs. Value section omitted. | Low to medium (read-only, enum migration) |
| W2: Value model | Shared registry + resolver + validators; `routes/reports/valueModel.ts`; settings page + catalog entry; value section in generator/PDF; snapshot on the run. | Medium (settings write path, partner-wide gate) |
| W3: Portal publishing | `reports.publish_to_portal` + `report_series.publish_to_portal` + `report_runs.portal_published_at` migration; export-policy classification; worker stamp; publish/withdraw routes behind the export+MFA gate; portal predicates; series revision, reconciler, combine-key and detach handling; portal deep link in the email; form switch. | **Medium-high**: changes the portal visibility predicate, which is a customer data boundary. Gets full review. |

W1 and W2 can run in parallel apart from the shared `REPORT_TYPES` / locale files. W3 is independent of W2, and the series reconciler change is the subtle part.

**Tests:**
- Generator: Drizzle-mock unit tests per section. Each honesty rule gets a test: an unconnected source → `null` and no value; a partial window → coverage note; detections never valued; site-restricted **and `config.sites`** → no-site sources refused with a note, and per-branch site predicates asserted on bound parameters rather than SQL text. Dedup rules each get a test: patch retries counted once, native AV not valued on EDR devices, priced-source alerts excluded, and `expired` / `source_retired` alerts not valued. S1 `killed` is not counted as remediated. DNS UTC-day snapping. Window freezing across a retry and a DST transition.
- Value: exact minor-unit arithmetic; org-wins-per-field; the three line states (inherit / null / value) and the `"0"` refusal; an org currency override drops inherited lines; a partner currency change drops stale org lines; re-rendering uses the frozen snapshot (counts, values, disclaimer); a blank model hides the section even when `includeEstimatedValue` is true; `keepOwnedSettingsSubtree` on both wholesale writers.
- Settings route: partner write refused without `canManagePartnerWidePolicies`; org-scope token gets 403; MFA required; `settingsPageRegistry.test.ts`; `localeParity`.
- Portal: an integration test against real Postgres, run as `breeze_app` under a portal context, proves:
  - a published scheduled run is listed;
  - a manual run and runs from before publication are not;
  - withdrawal removes the run;
  - another org's published run is invisible;
  - an `msp_staff` type is never listed, even with the stamp forced in SQL.

  `reportsSelfService.test.ts` predicate tests are updated. Series tests cover revision re-stamp, combine-key separation and detach.
- RLS: the value-model loader and every cross-table join in the generator (partner-mapped EDR, `patch_job_results` → `patch_jobs`, DNS) get at least one real-Postgres test under an org context with a second org's rows present. Mocks cannot prove isolation.
- Export policy: `tenant-export-policy.integration.test.ts` for the new `reports` column.
- E2E: one Playwright smoke test (create from template → generate → PDF downloads), using `data-testid` only.

**CI traps:**
- The export-policy and portal integration suites run only under **Integration Tests**, never `pnpm test`. A W3 PR that is green in Test API can still go red on main.
- Stacked wave PRs (base ≠ main) get no CI. Dispatch with `gh workflow run CI --ref <branch>`.
- Parallel W1/W3 migrations: rename to sort after the newest committed migration before merge, or a merged newer migration poisons the queue.
- `REPORT_GENERATORS` / the registry is `satisfies Record<ReportType, …>`: the enum value and the generator land in the same wave.

**Rollout:** no feature flag. A new enum value is inert until a definition exists. The value section is invisible until a partner enables a model. `publish_to_portal` defaults to false. No new env vars. Release notes call out the new type, the settings page, and portal publishing for self-hosters.

## 8. Advisor quorum

My (Opus) position was written first: every numbered position in this draft before review. One independent read-only opinion was then taken: `codex exec`, gpt-6-astra, `xhigh`, `--sandbox read-only`, run 2026-11-04 against this branch (`main` @ `36f9d9ca53`). Codex was given the draft and twelve numbered positions to challenge, and asked to verify them against code.

**Agreed independently:**

- the new type with its scope, audience and execution (OD1);
- no shipped dollar values (OD2);
- no cover headline (OD3);
- settings-blob storage (OD4);
- no EDR-visibility enforcement on MSP-published runs (OD6);
- no partner aggregate (OD7);
- no email metric (OD8);
- the derived alert classifier (OD9);
- the occurrence window (OD10);
- per-field override (OD11);
- freezing the model on the run.

**Disagreement:** OD5 as first drafted, a definition-only flag that would retroactively publish every historical and manual run. Recorded in OD5. The spec now carries codex's run-level alternative, pending Todd's confirmation.

**Adopted from codex. Each was verified in code before adoption:**

- `report_runs.result` is `excludedOpen`, so the frozen model is not exported (§4 corrected).
- There is no `computeSecurityPosture`. `buildRecommendations` is private, and the trend is already site-aware (§3.2).
- A native-AV quarantine clears `resolved_at` (`routes/agents/helpers.ts`), so the AV rule was rewritten.
- S1 `killed` stays `active` (`jobs/s1Sync.ts`), so S1 remediation is a disclosed undercount.
- Emsisoft fans out per device, and its close time can be the last-detection time.
- Patch severity is `critical` / `important`, through `EFFECTIVE_PATCH_SEVERITY_SQL` with a scoped `device_patches` join.
- DNS aggregates are UTC-dated, so the window snaps.
- Non-zero sign-in error codes are failures, not blocks.
- Alert `resolution_reason` includes `expired` and `source_retired`, which are not valued.
- Publication needs the export + MFA gate (`recipientGate.ts`). The series revision, combine-key and detach behaviour is specified.
- The settings subtree is protected from wholesale writers (`keepOwnedSettingsSubtree`, `routes/orgs.ts`).
- Inherit, unpriced and zero are distinct line states. A partner currency change cannot re-denominate org values.
- Deduplication rules: patch retries, AV vs EDR, multi-device incidents, priced alert sources. OD12 covers patch vs vulnerability.
- Actor provenance for "actions taken" (OD13).
- Window freezing across retries, DST and schedule edits.
- `config.sites` gets the same no-site refusals as a restricted authority.
- Real-Postgres RLS tests for the loader and the cross-table joins.
- The series eligibility rule (`assertSeriesTypeSupported`) and the `laborCostPerHour` precedent.
