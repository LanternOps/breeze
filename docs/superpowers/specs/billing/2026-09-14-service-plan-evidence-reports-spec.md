---
title: Evidence reports for service plans
issue: LanternOps/breeze#5784
status: draft
depends_on: LanternOps/breeze#5573
related: LanternOps/breeze#5783, LanternOps/breeze#5751, LanternOps/breeze#5327, LanternOps/breeze#5701
---

# Evidence reports for service plans — design

Status: **draft, for review**. Not approved; no implementation lands with this doc.
Advisor quorum: Fable position formed first, then an independent read-only
`codex exec` (gpt-6-astra, `xhigh`) review. See §10 "Quorum record"; every point
where codex disagreed is recorded on the relevant Open Decision in §8.

Every file path and line reference below was read from a worktree checked out at
`origin/main` = `a02d6cb4c` (2026-09-14).

---

## 1. Problem

`#5573` shipped the mechanism: a `service_deliverables` row may carry
`auto_evidence_report_id`, and the daily sweep
(`apps/api/src/jobs/deliverableWorker.ts:98`, cron `18 5 * * *`) calls
`generateAutoEvidenceForDeliverable` (`apps/api/src/services/deliverableAutoEvidence.ts:51`),
which generates a run of that saved report on the due date, files a
`service_deliverable_evidence` row of `kind='report_run'`, and posts the internal
ticket comment `Report attached, review and resolve`. The occurrence is never
moved — delivery stays the technician's act.

The mechanism is not the constraint. The **report catalog** is. Ten
`report_type` values exist (`apps/api/src/db/schema/reports.ts:22-40`):
`device_inventory`, `software_inventory`, `alert_summary`, `compliance`,
`performance`, `executive_summary`, `security_compliance_posture`,
`ai_org_narrative`, `ai_fleet_design`, `hardware_lifecycle`. The last two throw
`StoredArtifactOnlyReportError` and are additionally refused by auto-evidence.

Against a typical managed-security "Best" plan, that catalog covers
vulnerability management only as one control line inside
`security_compliance_posture`, and patching only loosely via `compliance`. The
recurring items an MSP actually sells — sign-in log review, threat detection
review, Intune management, firewall rule review, VPN/access policy review,
documentation audit, IR tabletop — all resolve to a technician hand-assembling a
PDF and uploading it as a document. The parent spec anticipated exactly this:
§15 of `docs/superpowers/specs/billing/2026-09-10-service-deliverables-portal-design.md`
uses "vulnerability management carries `auto_evidence_report_id` pointing at the
org's vulnerability report definition" as its worked example, and **no such report
type exists**.

Three structural gaps sit behind the catalog gap and this spec has to solve them
too, or the catalog work does not scale past one customer:

- **G1 — a partner-wide template cannot carry auto-evidence.**
  `deliverable_template_items` (`apps/api/src/db/schema/deliverableTemplates.ts:30`)
  is `org_id XOR partner_id` and has no report reference of any kind; it cannot
  have one, because `reports.id` is org-scoped by construction
  (`reports.org_id NOT NULL`) and a partner-wide item has `org_id IS NULL`, so the
  composite FK `(report_id, org_id) → reports(id, org_id)` is unsatisfiable.
  `applyTemplateSet` (`apps/api/src/services/deliverableTemplateService.ts:313`)
  therefore lands every deliverable with `auto_evidence_report_id = NULL`. A
  partner with 40 orgs wires auto-evidence 40 times by hand — via API or MCP only,
  because there is **no web UI for the field at all** (grep for `auto.evidence`
  across `apps/web/src` and `apps/portal/src` returns nothing).
- **G2 — the definition has to already exist in the org.** There is no report
  catalog table and no partner-level report row; `reports` is strictly per-org
  (`apps/api/src/db/schema/reports.ts:58-60`). The nearest thing to a catalog is
  the hardcoded `PORTAL_DEFINITIONS` array
  (`apps/api/src/services/portal/reportsSelfService.ts:28`) upserted per org.
- **G3 — auto-evidence only accepts user-principal definitions.**
  `deliverableAutoEvidence.ts:108-111` refuses a definition whose
  `execution_scope_principal_kind` is `'system'` or `'portal_user'`, and refuses
  when `execution_scope_user_id` is NULL; it then re-resolves that user's live
  authority and intersects scopes. Any provisioning design that mints
  system-principal definitions produces evidence sources the sweep will silently
  refuse.

## 2. Users and scope

**Partner (MSP), primary.** Defines the service plan once as a partner-wide
`deliverable_template_sets` row and applies it to every client org. The partner
is who feels G1: the value of this feature is a template item that says "monthly
threat detection review, evidence = the threat detection report" and produces a
real artifact in all 40 orgs without per-org wiring.

**Organization (customer), secondary and read-only.** Sees the artifact on the
portal service scorecard, gated by `portal_branding.enable_reports` **and** the
definition's `portal_self_service = true`
(`apps/api/src/services/portal/serviceReadModel.ts:112`). Otherwise the
occurrence honestly reads "Delivered (artifact held by the MSP)".

**Technician, the one whose work disappears.** Today: assemble a PDF each period.
After: open the ticket, find the report already attached, read it, resolve.

Out of the partner-wide-first frame: **no new config-ish table is introduced by
this design**, so the `org_id XOR partner_id` default in CLAUDE.md "Partner-Wide
First" binds only through the template-item column added in §5, which inherits
the existing dual-ownership of its parent row. `reports` stays org-only — see
Open Decision 4.

---

## 3. Proposed design — the report types

### 3.0 Ranking, and what stays manual

Ranked by value to a managed-security plan, with the cost that buys it:

| # | Plan item | Verdict | Type | New data? | Consent change? |
|---|---|---|---|---|---|
| 1 | Sign-in log review | **Ship** | `identity_access_review` | **Yes** — new `m365_signin_events` sync domain + table | **No** (`AuditLog.Read.All` already consented) |
| 2 | Threat detection review | **Ship** | `threat_detection_review` | No — `huntress_incidents` | No |
| 3 | Intune management | **Ship** | `endpoint_management_review` | No — `m365_intune_devices`, `m365_posture_rollups`, `m365_license_skus` | No |
| 4 | Vulnerability management | **Ship** | `vulnerability_management` | No — `device_vulnerabilities` + `vulnerabilities` | No |
| 5 | VPN / access policy review | **Fold in** | section of `identity_access_review` | No | No |
| 6 | Documentation audit | **Manual** | — | — | — |
| 7 | Firewall rule review | **Manual** | — | — | — |
| 8 | IR tabletop | **Manual** | — | — | — |

Sign-in review ranks first on value despite being the only one needing new data:
it is the single item every managed-security plan sells, every framework asks
for, and no MSP tool in this price band produces automatically. It ships last in
wave order (§9) precisely because it is the expensive one — the cheap three prove
the pipeline first.

**What stays manual, and why — stated so nobody re-litigates it:**

- **Firewall rule review — no source exists, and a fake one would be worse than
  nothing.** The agent reports exactly one firewall fact:
  `security_status.firewall_enabled` (`apps/api/src/db/schema/security.ts:66`), a
  single boolean collapsed from `Get-NetFirewallProfile` /
  `socketfilterfw --getglobalstate` / `ufw status`
  (`agent/internal/security/status.go:1184`, `:1195`, `:1210`, `:1301`). There is
  no `netsh advfirewall firewall show rule`, no `nft list ruleset`, no
  `pfctl -sr`, and no table matching `firewall|acl|rule_set|running_config`
  anywhere in the schema. SNMP discovery requests three OIDs — `sysDescr`,
  `sysObjectID`, `sysName` (`agent/internal/discovery/snmp.go:97,142`) — plus
  bridge-FDB walks for topology; the UniFi client is the read-only Integration
  API v1 (`agent/internal/unifi/client.go:15`), which does not expose firewall
  rules and which nothing in the repo asks for them from.
  **Shipping a `firewall_review` type backed by an on/off boolean would produce a
  document that looks like a rule review and is not one** — a compliance liability
  dressed as a feature. To make it real, three things would have to exist first:
  (a) an agent collector that captures the host rule set per platform and a table
  to hold it with a change diff; (b) network-device config capture (SSH/`show run`
  or a vendor API) for the perimeter device, which is a much larger feature than
  this one; (c) a normalized rule model so "changes since last period" means
  anything. None is in scope here.
- **VPN / access policy review — no policy source, only client presence.**
  `devices.active_vpns` (`apps/api/src/db/schema/devices.ts:188`) records which
  overlay client is up on a device (`wireguard`, `tailscale`, `netbird`,
  `zerotier`, `openvpn`, `cloudflare-warp`, `generic`) and the collector header
  is explicit that it carries "NO secrets, peer lists, keys, or VPN management"
  (`agent/internal/collectors/vpn.go:13-18`). No IPsec, no site-to-site, no
  policy. The honest half of this deliverable is *conditional access* — and that
  **is** persisted (`m365_ca_policies`, with full `conditions`/`grant_controls`/
  `session_controls`). So it becomes a "Remote and conditional access" section of
  `identity_access_review` rather than a type that promises a VPN policy review it
  cannot deliver.
- **Documentation audit — the corpus exists; the baseline to audit it against
  does not.** `org_documents` (`apps/api/src/db/schema/orgDocuments.ts:18`) is a
  genuinely versioned corpus: a category enum (`baseline`, `runbook`, `policy`,
  `evidence`, `report`, `export`, `other`), `supersedes_document_id` chaining, and
  `organization_key_dates` / `access_reviews` alongside. A report could truthfully
  say "this org's most recent runbook is 14 months old". What is missing is not
  data but **a required-document baseline and review criteria** — the statement of
  which documents this customer's plan requires and what "current" means for each.
  Without that, a document report is a file listing, and the deliverable an MSP
  sells is *"we reviewed the documentation and it is current and correct"*, which
  no query attests to. Define the baseline first (a plausible future feature), and
  in the meantime the honest primitive is a runbook the technician works through —
  **#5783's** territory. This spec adds nothing here.
- **IR tabletop — the artifact is the exercise record, not a query.** Same
  reasoning; the technician's evidence is an uploaded document, which
  `service_deliverable_evidence.kind='document'` already handles.
- **Microsoft Defender is unavailable, not deprioritized.** There is no Defender
  for Endpoint / XDR integration in the repo; every `defender` hit is either the
  agent's local Windows Security Center AV-provider enum
  (`apps/api/src/db/schema/security.ts:20`), a `mgmtdetect` file-presence
  signature, or a patch title. No `SecurityIncident.Read.All`,
  `SecurityAlert.Read.All` or `ThreatHunting.Read.All` scope is consented, and no
  `/security/incidents` or `/security/alerts_v2` call exists.

### 3.1 Shared contract every new type obeys

1. **Persisted data only. No Graph or vendor HTTP call inside a report run.**
   A run triggered by the 05:18 sweep must be deterministic and must not couple
   artifact generation to an external dependency or to another tenant's throttle
   budget. Freshness is a *property the artifact prints*, not something it fetches
   (Open Decision 2).
2. **Unmeasured ≠ zero, and coverage is machine-readable.** Every section that can
   be unmeasured renders "N/A — no data" with the reason, following the
   established `pctOrNull` (`apps/api/src/services/securityComplianceReport.ts:48`)
   and `dataGap` (`apps/api/src/services/securityPosture.ts:265`) convention. A
   report that prints `0 incidents` when Huntress was never connected is a lie the
   customer will act on. **A missing-source artifact must never imply the review
   found zero problems.** Coverage goes into `summary` as structured fields
   (window start/end actually covered, per-source status, truncation), not only as
   prose on the cover.

2a. **Freshness is `last_complete_snapshot_at`, never `last_success_at`.**
   `writeCompletion` (`apps/api/src/services/m365Sync/run.ts:373-376`) sets
   `lastSuccessAt` for a `partial` outcome as well as a `success` one, and sets
   `lastCompleteSnapshotAt` only when `persisted.complete`. `loadSyncSummary`
   already documents the rule in as many words — *"`asOf` is
   `last_complete_snapshot_at`, NOT `last_success_at`: a partial run succeeds
   without enumerating the tenant, and its timestamp would claim a freshness the
   data does not have"* (`services/m365Sync/summary.ts:59-62`). Every M365-backed
   report reads freshness the same way, and also surfaces `last_status`,
   `truncated` and `sources`. **Staleness thresholds follow the sync cadence, not
   the reporting period** — a 29-day-old inventory in a monthly report is stale
   even though it is inside the period.
3. **"Changes since last period" must be designed, not inherited.** The existing
   baseline helper does **not** serve this feature as-is, and the spec's first
   draft was wrong about it. Two verified defects:
   - `deliverableAutoEvidence.ts` **never calls `previousBaselineFor`**. Its three
     callers are `reportScheduleWorker.ts:670`, `routes/reports/runs.ts:182` and
     `portal/reportsSelfService.ts:455`; the sweep path
     (`deliverableAutoEvidence.ts:144-163`) calls `generateReport` and writes the
     result straight through. **Every sweep-generated run therefore has
     `previous` undefined** — the exact path this whole feature runs on.
   - Even where it is called, `previousBaselineFor(reportId, scopeFingerprint)`
     (`reportGenerationService.ts:86-104`) keys on **report id and scope
     fingerprint only** — not occurrence, not period, not config. Because §5.1
     gives an org **one shared managed definition per type**, a monthly and a
     quarterly deliverable pointing at the same definition would compare each
     other's runs.

   So the foundation wave owns this: auto-evidence must pass the occurrence's
   immutable period boundaries into generation, and select a *comparable prior
   occurrence's* run rather than "the last completed run" (Open Decision 11).
   Comparators still live in `summary`, never only in `rows`; that part holds.
   This is also what keeps raw-data retention short (Open Decision 3).
4. **Readers follow `securityComplianceReportVulnerabilities.ts`, not
   `sweepEvidence.ts`.** The former is a pure aggregator plus a thin
   `loadOpenVulnerabilityCounts(deviceIds)` wrapper on plain `db` that throws
   rather than silently undercounting on a missing join. The latter
   (`apps/api/src/services/aiAgents/sweepEvidence.ts`) is capped at 25 rows/kind
   and 12 KB, excludes every jsonb/text column by design, and **requires a
   pre-held SYSTEM context** — a tenant-isolation hazard in a request path. Loaders
   may be *modelled* on the sweeps' queries; the module is not reused, which also
   satisfies the issue's "do not couple to #5751".
5. **Site scope is applied in every query branch independently**, per the
   `hardwareLifecycleReport.ts` precedent, and each type declares its restricted-
   scope behaviour (Open Decision 8).
6. **Artifact shape**: tabular body in `result.rows`, designed content and all
   comparators in `result.summary`. PDFs are never persisted —
   `report_runs.result` is jsonb only. Staff download returns JSON and the browser
   renders (`apps/web/src/components/reports/reportExport.ts`); the portal and
   scheduled email render server-side via `buildReportPdf`
   (`packages/shared/src/reportPdf/reportPdf.ts:1921`,
   `apps/api/src/services/portal/reportsSelfService.ts:589`).

### 3.2 `threat_detection_review`

**Source** — persisted, zero new data. `huntress_incidents` and
`huntress_agents` (both `org_id NOT NULL`,
`apps/api/src/db/schema/huntress.ts:79,97`), left-joined to `devices`.
Configuration is partner-scoped (`huntress_integrations.partner_id NOT NULL`),
data is org-scoped — the report reads only the org axis.

**Freshness** — sync every 15 min with a 24 h incremental lookback
(`apps/api/src/jobs/huntressSync.ts:36-37`), plus an HMAC webhook for real time.
The artifact prints `huntress_integrations.last_sync_at` / `last_sync_status`
and, when no active integration exists for the partner, renders the whole report
as a single data-gap page rather than an empty incident table.

**Contents**

1. *Coverage* — Huntress agents vs Breeze devices; agents offline
   (`HUNTRESS_OFFLINE_STATUSES`); Breeze devices with no Huntress agent.
2. *Incident summary for the period* — counts by `severity` and `status`,
   mean and median time-to-resolve from `reported_at` → `resolved_at`.
3. *Incident table* — `reported_at`, hostname, `severity`, `category`, `title`,
   `status`, `resolved_at`, and `recommendation` (the normalized remediation text
   Huntress supplies; the raw payload in `details` jsonb is **not** rendered).
4. *Carried in* — incidents opened before the period and still unresolved.
5. *Changes since last period* — from `previous.summary`.

**What "reviewed" means, stated on the artifact.** The artifact is titled
**generated review evidence**, not "review". It enumerates the incidents Breeze
holds for the period with their status **as observed at generation time**
(persisted in `summary`, so a later status change does not silently rewrite the
evidence); it does not assert a human read it. The review record is the
technician resolving the ticket the sweep commented on — exactly D12's model.

**Completeness cannot be claimed, and the artifact must not claim it.** The
first Huntress sync fetches 24 hours only (`DEFAULT_LOOKBACK_MS`,
`apps/api/src/jobs/huntressSync.ts:37`); subsequent runs start at
`lastSyncAt − 60s` (`huntressSync.ts:821`), and the client's pagination has a
ceiling with no completeness metadata (`services/huntressClient.ts:517`). So for
any period beginning before the integration was connected — or spanning a sync
outage — the report covers less than the period. It therefore prints the window
it **actually** covers, derived from `huntress_integrations.last_sync_at` and the
earliest `reported_at` held, and says so rather than implying "every incident".

**Site scope** — incidents link to `device_id`, which is nullable. Under a
restricted authority the report filters by `devices.site_id` and **excludes**
incidents with a NULL `device_id` (unattributable), disclosing the excluded count
in the data-gap line rather than dropping them silently.

**PDF** — new `packages/shared/src/reportPdf/threatDetectionPdf.ts` +
`REPORT_TYPE_LABELS` entry + a `buildReportPdf` arm; summary type
`packages/shared/src/types/threatDetectionReport.ts`. Branding is inherited
unchanged (`paletteForBranding`, `getReportBranding(orgId)`).

### 3.3 `endpoint_management_review` (Intune)

**Source** — persisted, zero new tables, **no consent change**. Reuses the
`#5327` sync foundation exactly as it shipped: `m365_intune_devices`,
`m365_posture_rollups`, `m365_license_skus` (all in
`apps/api/src/db/schema/m365Sync.ts`, all shape-1 `org_id NOT NULL`), left-joined
to `devices` on `breeze_device_id`. `DeviceManagementManagedDevices.Read.All` is
already in `customer-graph-read` v3.

**This report is the first real consumer of those tables.** Today the only
reader is `loadSyncSummary` (`apps/api/src/services/m365Sync/summary.ts:70`) —
there is no list or detail API for any synced M365 entity.

**Freshness** — `intune_devices` syncs on a 6 h adaptive cadence
(`packages/shared/src/m365/sync.ts:26`). Per §3.1 rule 2a the artifact prints
`last_complete_snapshot_at`, plus `last_status`, `truncated` and `sources`; a
`needs_consent`, `throttled` or unscheduled domain renders a data-gap banner, not
zeros. Staleness is judged against the 6 h cadence, not against the period.

**Contents**

1. *Enrolment coverage* — Intune devices vs Breeze devices; Breeze devices with
   no Intune record; Intune records with no `breeze_device_id`.
2. *Compliance breakdown* — `compliance_state` ∈ compliant / noncompliant /
   inGracePeriod / unknown, with the 30-day trend from `m365_posture_rollups`
   (`devices_compliant`, `devices_noncompliant`, `devices_in_grace`,
   `devices_unknown`).
3. *Non-compliant device table* — `device_name`, `operating_system`,
   `os_version`, `user_principal_name`, `owner_type`, `last_intune_sync_at`,
   `compliance_state`, `jail_broken`.
4. *Stale enrolments* — `last_intune_sync_at` older than the configured
   threshold, and `is_stale` rows (present in Breeze, gone from the tenant).
5. *Licence seats* — `m365_license_skus` consumed vs prepaid-enabled per SKU.
6. *Trend* — from `m365_posture_rollups` (a genuine daily time series), **not**
   from entity columns. See the limit below.

**Entity-level "changes since last period" is not available from these tables,
and the spec's first draft was wrong to plan on it.** Two reasons, both verified:

- `m365_intune_devices.last_changed_at` is **not** configuration-change history.
  The domain's `core_hash` projection deliberately includes `lastSyncDateTime`
  (`apps/api/src/services/m365Sync/domains/intuneDevices.ts:57-61`, comment: *"In
  the hash on purpose: an Intune device's last check-in is the single most useful
  freshness fact on the row"*), so the hash — and therefore `last_changed_at` —
  churns on every routine check-in. `first_seen_at` likewise means *first
  observed by Breeze*, not *newly enrolled*.
- Upserts overwrite in place; there is no prior-value record. And the retention
  worker (`apps/api/src/jobs/m365SyncRetentionWorker.ts:35,52`) deletes entities
  stale ≥ 30 days, so the population itself cannot be reconstructed backwards.

Consequence: this report ships **current inventory plus rollup trend**. Anything
device-level and historical ("which three devices fell out of compliance this
month") needs real change records — a `m365_intune_device_changes` table or
period snapshots — which is a separate feature, not a section of this one.

**Not included:** Intune *compliance policy definitions*. They are not persisted
and there is no action for them, even though
`DeviceManagementConfiguration.Read.All` is consented. A follow-up sync domain,
not this spec.

**Site scope** — `m365_intune_devices.breeze_device_id` site-attributes the
linked subset. Under a restricted authority the report covers linked devices in
permitted sites and reports the unlinked population as a **disclosed count only,
never enumerated** — enumerating it would leak devices outside the technician's
sites.

### 3.4 `vulnerability_management`

**Source** — persisted, zero new tables. `device_vulnerabilities`,
`vulnerabilities`, `software_vulnerabilities`, `os_vulnerabilities`,
`vulnerability_sources` (`apps/api/src/db/schema/vulnerabilityManagement.ts`).
This is the most mature data pipeline in the repo: NVD / MSRC / Apple / OSV
ingestion plus CISA KEV (`known_exploited`) and EPSS (`epss_score`) enrichment
from `apps/api/src/services/exploitFeeds.ts:12-13`.

**Relationship to `security_compliance_posture`.** Posture keeps its single
vulnerability *control line*, computed by `loadOpenVulnerabilityCounts`. This
type is the *detail artifact* a vulnerability-management deliverable needs.
Neither replaces the other; the shared loader is extended, not forked.

**Contents**

1. *Feed freshness* — `vulnerability_sources.last_sync_at` per source. A stale
   feed is stated up front; a report that under-counts because MSRC has not
   synced in a week must say so, not print a reassuring number.
2. *Open findings by severity* — with KEV and high-EPSS called out separately,
   because "critical" and "actively exploited" are different arguments to a
   customer.
3. *Top-N remediable* — ranked by `risk_score`, filtered to
   `patch_available = true`, with the affected device count per CVE.
4. *Exceptions* — `status ∈ (accepted, mitigated)` with `accepted_by` and
   `accepted_until`, and **those expiring within the next period**. This section
   is the reason a vCISO buys the deliverable and no existing report has it.
5. *Closed this period* — findings that moved to `patched`.
6. *Changes since last period.*

**Config** — `{ sites: [], severityFloor: 'high', topN: 25, includeAccepted: true }`.
**Site scope** — device-attributed throughout; ordinary `devices.site_id` filter
in every branch.

### 3.5 `identity_access_review` (sign-in review)

**The only type needing new data.** Ranked first on value; shipped last.

#### 3.5.1 Why an on-demand fetch at run time does not work

The interactive read action `m365.signins.list`
(`packages/shared/src/m365/readActions.ts:122`) exists and maps to
`GET /auditLogs/signIns` (`apps/m365-graph-read-executor/src/microsoft/readActions.ts:141`).
It is capped at `sinceHours ≤ 168` (7 days) and `pageSize ≤ 50` over **at most two
pages — 100 rows, no continuation**
(`apps/m365-graph-read-executor/src/microsoft/readActions.ts:18`).
A monthly review needs 30 days; a quarterly one needs 90. Widening
the action would mean pagination, a per-run time budget inside a report
generator, and an external dependency in the sweep's critical path — against
§3.1 rule 1. Rejected (Open Decision 2).

#### 3.5.2 The new sync domain and table

A **seventh** `m365_sync_domain`, `signin_events`, alongside the existing six.
Note this is *not* the existing `signin_activity` domain, which updates exactly
one column — `m365_users.last_successful_sign_in_at`
(`apps/api/src/services/m365Sync/domains/signinActivity.ts:88-91`) — and persists
no events.

**Consent: no change.** `AuditLog.Read.All` is already in `customer-graph-read`
v3 (`packages/shared/src/m365/profiles.ts:107`) and is exactly the scope
`/auditLogs/signIns` requires. **Identity Protection is explicitly out**:
`IdentityRiskyUser.Read.All` / `IdentityRiskEvent.Read.All` are not declared
anywhere, and adding either is a manifest **v4 bump forcing every customer to
re-consent**. The `riskLevelAggregated` / `riskState` fields that Graph returns
*on the signIn resource itself* are available under `AuditLog.Read.All` and are
persisted; the dedicated `identityProtection/riskyUsers` collection is not
fetched.

**Throttle.** The 10-req/min-per-app-across-all-tenants limit that forces
`signin_activity`'s 24 h floor (`packages/shared/src/m365/sync.ts:33-35`,
`apps/m365-graph-read-executor/src/signinLimiter.ts:1-14`) applies to
`/users?$select=signInActivity`. `/auditLogs/signIns` is a different Graph
surface, so the new domain gets its **own** token bucket sized independently
rather than sharing that one — but it is scheduled at the same 24 h default
cadence and, like `signin_activity`, is **excluded from `ON_DEMAND_SYNC_DOMAINS`**
so one technician pressing "Sync now" cannot spend a region's budget.

**Table** `m365_signin_events` — **interactive sign-ins only**, no jsonb:

| column | notes |
|---|---|
| `id` uuid PK | |
| `org_id` uuid **NOT NULL** → `organizations(id) ON DELETE CASCADE` | tenancy shape 1 |
| `tenant_id` uuid **NOT NULL** | tenant provenance, following `m365_secure_score_snapshots`; retained history outlives a disconnect/rebind (`services/m365Sync/lifecycle.ts:84`) and must never be attributed to the tenant that replaced it |
| `graph_id` text NOT NULL | Graph `signIn.id`; `UNIQUE (org_id, graph_id)` makes re-sync idempotent |
| `signed_in_at` timestamptz NOT NULL | Graph `createdDateTime` — **event time**, and the watermark |
| `user_graph_id` text, `user_principal_name` text | stable id kept alongside the UPN, which is renameable |
| `app_id` text | stable app id alongside `app_display_name` |
| `app_display_name` text, `client_app_used` text | legacy-auth detection |
| `ip_address` text, `location_city` text, `location_country` text | |
| `conditional_access_status` text | success / failure / notApplied |
| `status_error_code` integer, `status_failure_reason` text | |
| `risk_level_aggregated` text, `risk_state` text | from the signIn resource, not Identity Protection |
| `is_interactive` boolean | |
| `ingested_at` timestamptz NOT NULL DEFAULT now() | |

Indexes: `UNIQUE (org_id, graph_id)`, `(org_id, signed_in_at DESC)`.

Deliberate shape choices:
- **No `connection_id`.** The entity snapshot tables (`m365_users`,
  `m365_intune_devices`, …) do not carry one either; connection identity lives in
  `m365_sync_state`. This also sidesteps the cascade FK-direction question in
  §4.2.
- **No jsonb.** Keeping the raw Graph payload out means nothing lands in the
  `excludedOpen` export bucket, and it keeps sign-in PII to exactly the fields the
  report renders. Compare `huntress_incidents.details` and
  `m365_ca_policies.conditions`, both `excludedOpen` for precisely this reason.
- **Event time and ingestion time are separate columns** (`signed_in_at` vs
  `ingested_at`), so late-arriving events are detectable rather than silently
  changing a closed period's totals.
- **Delta is an overlapping bounded window, not a bare watermark.** The next
  run's `since` is `MAX(signed_in_at)` for the org **minus an overlap** (Graph
  sign-in records surface with delay), writes are idempotent upserts on
  `(org_id, graph_id)`, and the checkpoint advances **only after pagination for
  the window completes** — a truncated page leaves the watermark where it was and
  returns a continuation. **Inventory-style "unseen means stale" reconciliation
  must not be applied here**: this is an append-only event log, and marking an
  unreturned row stale would corrupt closed periods. `persistSigninActivity`'s
  header already draws this "not an entity domain" distinction for its own
  sibling; this domain is the same in kind and different in shape.
- **Per-run cap + continuation.** A new
  `M365_SYNC_MAX_ITEMS_SIGNIN_EVENTS` (default 25 000, matching
  `_USERS`/`_DEVICES`) with the existing AES-256-GCM continuation mechanism
  already built for `signin_activity`.

**Retention: 120 days** (Open Decision 3), purged by the existing
`m365SyncRetentionWorker`. Rationale: monthly and quarterly deliverables both get
a full prior period for comparison, and longer-horizon trend does **not** need raw
rows because `previous.summary` carries the aggregates forward (§3.1 rule 3).

**Consent is necessary but not sufficient — three limits the artifact must print:**
- **Graph sign-in download requires Entra ID P1/P2.** `AuditLog.Read.All` grants
  permission; the tenant's licence grants the data. The existing `unlicensed`
  handling on the `signin_activity` domain (`signinActivity.ts:12-14, 60`) is
  reused: a complete, zero-update success that pushes the interval to max — and
  the report renders a data-gap page, not an empty table.
- **Risk fields can come back `hidden` without P2.** `risk_level_aggregated` /
  `risk_state` are then stored as the sentinel Graph returns, and the report
  renders that section as unmeasured rather than as "no risk detected".
- **Graph retains sign-in logs ~30 days (P1/P2).** Breeze accumulates forward
  from first sync only, so the first monthly report after enabling is partial.
  The artifact prints the window it **actually** covers plus any gap where a sync
  outage exceeded Graph's own retention — those events are unrecoverable.
- **The supported event class is defined up front: interactive sign-ins.**
  Non-interactive sign-ins, service-principal sign-ins and managed-identity
  sign-ins are out of the first cut. The artifact says "interactive sign-ins",
  never "all sign-ins".

#### 3.5.3 Contents

1. *Identity inventory* — enabled / disabled users, admins, MFA registration from
   `m365_users.mfa_registered`. NULL means **unknown**, never "not registered"
   (`m365_posture_rollups` carries `users_mfa_unknown` and `admins_mfa_unknown`
   for exactly this reason).
2. *Dormant accounts* — enabled users whose `last_successful_sign_in_at` is older
   than `dormantDays` (default 45) or NULL.
3. *Sign-in activity for the period* — total interactive sign-ins, distinct users,
   failures grouped by `status_error_code`, sign-ins from countries outside the
   configured home set, legacy-auth usage by `client_app_used`, and
   `conditional_access_status = 'failure'` counts.
4. *Admin sign-in detail* — every interactive sign-in by a user with
   `m365_users.is_admin = true`. This is the section an auditor reads first.
5. *Conditional access posture* — `m365_ca_policies` by `state`
   (enabled / enabledForReportingButNotEnforced / disabled), policies whose
   `last_changed_at` falls in the period (a CA change nobody announced is the
   finding), and `is_stale` policies (deleted in the tenant).
6. *Remote access* — devices with an active VPN client by provider from
   `devices.active_vpns`, labelled as **client presence, not policy**.
7. *Changes since last period.*

**Config** — `{ dormantDays: 45, homeCountries: [], adminDetail: true }`.
**Site scope** — M365 identity data has no site dimension, so a restricted
authority would silently receive an org-wide identity view. That is a scope
escalation. This type therefore takes the `zeroSafeReport` empty-but-shaped
result under `scope.kind === 'restricted'`, with a data-gap line saying the report
is org-wide and the requester's access is site-limited (Open Decision 8).

---

## 4. Tenancy and data-model impact

### 4.1 New table — `m365_signin_events` (W05 only)

**Shape 1, direct `org_id`.** RLS enabled **and forced**, with the single
`FOR ALL` policy the sibling M365 tables already use, in the same migration that
creates the table — copying the template from
`apps/api/migrations/2026-10-16-170200-m365-tenant-sync-foundation.sql:329-345`:

```sql
ALTER TABLE public.m365_signin_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.m365_signin_events FORCE ROW LEVEL SECURITY;
CREATE POLICY m365_signin_events_org_access ON public.m365_signin_events
  FOR ALL USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON public.m365_signin_events TO breeze_app;
```

`breeze_has_org_access` short-circuits TRUE under `breeze_current_scope() =
'system'`, so the cross-org sync worker needs no second policy — same as the six
existing domains. The migration writes no rows, so no `breeze.scope` elevation is
required; if a backfill is ever added, `SELECT set_config('breeze.scope',
'system', true);` must precede the first write.

There is no partner axis and no partner-wide read branch: this is tenant
telemetry, not config policy, so `DUAL_AXIS_TENANT_TABLES` and the
partner-wide SELECT branch do not apply.

### 4.2 Registration lists — the step that gets missed

| List | Entry | Enforced by |
|---|---|---|
| `CORE_ORG_CASCADE_DELETE_ORDER` (`services/tenantCascade.ts`) | `m365_signin_events`, alphabetically **between `m365_secure_score_snapshots` and `m365_sync_state`** (`se` < `si` < `sy`) | `tenantCascade.integration.test.ts` (**Integration Tests**) |
| `CORE_TENANT_EXPORT_POLICY` (`services/tenantExportPolicyRegistry.ts`) | new `m365_signin_events` entry, **every column `included`** — no jsonb, no bytea, no credential material, so nothing lands in `excludedOpen` or `excludedSensitive` | `tenant-export-policy.integration.test.ts` + `tenantExportErasureRoundtrip.integration.test.ts` (**Integration Tests**) |
| device cascade lists | **not applicable** — no `device_id` column | — |
| `AUDIT_ADMIN_REQUIRED_TABLES` | **not applicable** — not append-only, DELETE is granted (retention purges it) | — |
| **org-merge registry** (`services/orgMergeRegistry.ts`) | **every cascade table needs a classification** — this is the registration list that is neither RLS nor cascade and is the one most often missed. `m365_signin_events` is a resolve-phase snapshot: add it alongside the five existing M365 tables in `orgMergeCustomExecutors.ts:444` | org-merge contract test (**Integration Tests**) |

**FK direction is why there is no `connection_id`.** `m365_sync_state` gets away
with `(connection_id, org_id) → m365_connections(id, org_id)` despite sorting
*after* its parent alphabetically only because that FK is `ON DELETE CASCADE`.
Omitting the column removes the question entirely. If a later wave adds it, it
must be `ON DELETE CASCADE` **and** `DEFERRABLE INITIALLY IMMEDIATE` — the org
merge runs `SET CONSTRAINTS ALL DEFERRED` and a non-deferrable composite org FK
aborts it with 23503.

### 4.3 Column additions — the export-policy trap

CLAUDE.md: *"The export-policy row is the only one that fires on a new column,
not just a new table."* Both tables touched here are already registered in
`CORE_ORG_CASCADE_DELETE_ORDER` (`tenantCascade.ts:427` and `:636`), so **both
column additions break `tenant-export-policy.integration.test.ts` until
classified**:

| Table | New column | Bucket | Why |
|---|---|---|---|
| `deliverable_template_items` | `auto_evidence_report_type report_type` NULL | `included` | an enum label, not a secret; add to the `included` array at `tenantExportPolicyRegistry.ts:206` |
| `reports` | *(none — see Open Decision 4)* | — | the design deliberately adds no column to `reports` |

Neither suite runs in **Test API**; both need a live database. A unit-green PR
will redden Integration Tests. Run them locally before opening the PR.

### 4.4 New enum values

Two enums grow, and each `ALTER TYPE … ADD VALUE` **must sit alone in its own
migration file** — a label added by `ALTER TYPE` cannot be used until the adding
transaction commits, and `autoMigrate` wraps each file in one transaction. The
precedent is explicit in
`apps/api/migrations/2026-10-16-180700-report-type-hardware-lifecycle.sql`:

```sql
ALTER TYPE report_type ADD VALUE IF NOT EXISTS 'hardware_lifecycle';
```

- `report_type` — four new labels, one per wave (see §9): a wave that slips must
  not leave a shipped, unusable label behind, and enum labels cannot be dropped.
- `m365_sync_domain` — one new label, `signin_events` (W05), in its own file
  ahead of the table migration that uses it.

### 4.5 Consent scope changes

**None.** Every Graph read this design needs is already granted by
`customer-graph-read` manifest **v3** (`packages/shared/src/m365/profiles.ts:105-119`):
`AuditLog.Read.All` for `/auditLogs/signIns`,
`DeviceManagementManagedDevices.Read.All` for Intune, `Policy.Read.All` for
conditional access, `User.Read.All` + `RoleManagement.Read.Directory` for the
identity inventory. That is a deliberate design constraint, not luck: v3 was
consented in one bump on 2026-09-08 specifically so the posture program would not
need a second re-consent, and this spec stays inside it.

**What would break that, and is therefore out of scope:** Identity Protection
risky users/events, Defender for Endpoint/XDR incidents, and Exchange or
mailbox-level configuration evidence. Each is a manifest **v4** bump requiring
every existing customer to re-consent. (`#5656` shipped a non-interrupting
upgrade flow, so the cost is real but not catastrophic — it is still not worth
spending on a first cut.)

### 4.6 Migration filenames

The newest migration on `origin/main` is
`2026-10-16-181500-portal-lifecycle-flag.sql`. Repo filenames run **ahead of real
time** — `apps/api/migrations/README.md` "Rule 3" documents a compounding ratchet
in which 169 of 466 dated migrations are named ahead of the day they landed, so
a file named for today would replay *before* main's newest. Compare against the
files, never the calendar; and re-check at the start of each wave, because
`origin/main` may have moved and the pre-push hook re-runs
`check-migration-naming.sh --against-ref origin/main`.

Proposed, using the preferred `YYYY-MM-DD-HHMMSS-<slug>.sql` form (the time
component orders same-day files natively, so no `-a-`/`-b-` infix is needed):

| Wave | Filename | Contents |
|---|---|---|
| W01 | `2026-10-17-090100-deliverable-template-auto-evidence-type.sql` | `ADD COLUMN IF NOT EXISTS auto_evidence_report_type report_type` |
| W02 | `2026-10-17-091000-report-type-threat-detection-review.sql` | enum add only |
| W03 | `2026-10-17-092000-report-type-endpoint-management-review.sql` | enum add only |
| W04 | `2026-10-17-093000-report-type-vulnerability-management.sql` | enum add only |
| W05 | `2026-10-17-094000-m365-sync-domain-signin-events.sql` | `ALTER TYPE m365_sync_domain ADD VALUE` only |
| W05 | `2026-10-17-094100-m365-signin-events.sql` | table + indexes + RLS |
| W06 | `2026-10-17-095000-report-type-identity-access-review.sql` | enum add only |

All idempotent (`ADD VALUE IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`,
`pg_policies` existence checks), no inner `BEGIN;`/`COMMIT;`.

---

## 5. API and provisioning

### 5.1 How a partner gets the new types on every org

**Reuse the portal-self-service definition as the managed definition. Add no
column to `reports`.**

The key observation: `serviceReadModel.ts:112` **already requires**
`reports.portal_self_service = true` for report-run evidence to appear in the
customer portal at all — otherwise the occurrence degrades to "Delivered (artifact
held by the MSP)". So an evidence definition that is worth having must be
`portal_self_service` anyway, and the existing partial unique index
`reports_portal_self_service_org_type_uniq (org_id, type) WHERE portal_self_service`
(`apps/api/src/db/schema/reports.ts:99`) is already exactly the
"one managed definition per org, keyed by type" registry this feature needs. A
`system_definition_key` column would duplicate it (Open Decision 4).

Concretely:

1. **Add the four types to `PORTAL_DEFINITIONS`**
   (`apps/api/src/services/portal/reportsSelfService.ts:28`) with default configs.
   The existing insert already mints a **user-principal, unrestricted** authority
   (`principalKind: 'user'`, `principalUserId: args.createdBy`, `:71-93`), which
   is precisely what auto-evidence's G3 gate requires — no widening of that gate.
2. **Make provisioning find-or-create and callable outside the flag flip.**
   Today `provisionPortalReportDefinitions` fires only from `onPortalFlagsChanged`
   when `enable_reports` is turned on (`services/portal/portalFlags.ts:41`).
   Extract `resolveManagedEvidenceDefinition(orgId, type, createdBy, tx)` over the
   same insert, so the template apply can provision on demand for an org whose
   portal reports are off. Provisioning a row exposes nothing by itself — the
   portal gate is `enable_reports`, checked separately (but see §6 and OD-12 for
   what turning that on actually reveals). Three behaviours the design must pin
   down, because the existing helper does **not** define them:
   - **Provisioning is insert-if-absent, not an updating upsert.**
     `.onConflictDoNothing({ target: [orgId, type], where: portal_self_service })`
     (`services/portal/reportsSelfService.ts:102`) means an already-present
     definition keeps whatever config and owner it has — a later change to the
     catalog's default config does **not** propagate, and provisioning repairs
     neither a bad config nor a departed owner. Config versioning (or an explicit
     `--repair` mode on the reprovision script) is a required design decision, not
     an implementation detail.
   - **Adoption/collision.** An org may already have a hand-made
     `portal_self_service` definition of a newly added type. The design must say
     whether it is adopted as the managed definition (and its config left alone)
     or whether the managed one is a distinct row — the partial unique index
     forbids the latter, so adoption is the only option and it must be deliberate.
   - **Executor threading.** `resolveManagedEvidenceDefinition` must take the
     **actual transaction executor** and use it; the ambient `db` handle does not
     join a nested transaction, a hazard documented in this very subsystem at
     `services/serviceDeliverableService.ts:52`.
3. **Wire the reprovision script into `package.json`, and widen who it targets.**
   `apps/api/scripts/reprovision-portal-report-definitions.ts` is idempotent and
   dry-run by default, but is **not referenced by `package.json`, CI, any
   Dockerfile or any entrypoint** — it is hand-run, so every org that enabled
   reports before a type existed silently lacks that definition. Add
   `"reports:reprovision-portal-definitions"` to `apps/api/package.json` and a
   step to the release runbook for any release that adds a type. Its org selector
   must also grow: today it lists orgs with `portal_branding.enable_reports = true`,
   but an org using an evidence template needs the definition **whether or not**
   portal reports are on.
4. **Backfill existing deliverables.** Provisioning definitions connects nothing
   on its own: `service_deliverables` rows created before this feature keep
   `auto_evidence_report_id = NULL` forever. The foundation wave needs an explicit,
   opt-in linkage backfill (match an existing deliverable to a template item, or a
   partner-triggered "link evidence reports" action), not a silent mass update —
   auto-attaching an artifact to a customer-visible obligation is not something to
   do behind the MSP's back.

### 5.2 Partner-wide template linkage (fixes G1)

Add one nullable column to `deliverable_template_items`:

```sql
ALTER TABLE deliverable_template_items
  ADD COLUMN IF NOT EXISTS auto_evidence_report_type report_type;
```

A **type**, not an id — that is the whole point. A partner-wide item has
`org_id IS NULL` and can never name a `reports.id`; naming a type is
org-independent and resolves per target org.

`applyTemplateSet` (`deliverableTemplateService.ts:377-406`) resolves it **inside
its existing all-or-nothing transaction**, on the same `tx` handle as
`createDeliverable`: for each item with a non-null `auto_evidence_report_type`,
call `resolveManagedEvidenceDefinition(orgId, type, createdBy, tx)` and pass the
resulting id as `autoEvidenceReportId`. Apply-time resolution over sweep-time is
Open Decision 6.

Surface changes that go with it:
- `packages/shared/src/validators/deliverableTemplates.ts` —
  `templateItemFieldTypes` grows from eight fields to nine.
- `apps/api/src/routes/deliverableTemplates.ts` — pass-through.
- **Web UI, which does not exist today.** Add an "Evidence report" picker to the
  template-item form *and* to the deliverable form
  (`service_deliverables.auto_evidence_report_id` has never had one; it is
  API/MCP-only). Without this the feature is unusable by a human.
- `apps/api/src/services/aiToolsDeliverables.ts` — the template item schema.

No new REST routes are needed for the report types themselves: they ride
`POST /reports`, `POST /reports/:id/generate` and
`GET /api/reports/runs/:id/download` unchanged.

### 5.3 Per-type wiring checklist (the hardware-lifecycle precedent, #5701)

Adding one type touches, in order:

1. `apps/api/migrations/…-report-type-<slug>.sql` — enum add, alone in the file.
2. `apps/api/src/db/schema/reports.ts:22` — the enum literal.
3. `apps/api/src/services/reportGenerationService.ts:19` — the `ReportType`
   union (pinned against the pg enum by `reportGenerationService.test.ts`).
4. `reportGenerationService.ts` — **both** exhaustive switches: the
   `generateReport` dispatch (~`:774`, `await import(...)` for a heavy generator,
   which also avoids the module cycle back to `assertReportExecutionPreflight`)
   and the `zeroSafeReport` arm (~`:808`). Both have a `never` default, so a
   missed one is a typecheck failure, not a runtime bug.
5. `apps/api/src/routes/reports/schemas.ts` — `reportTypeSchema`, plus a
   `…ConfigSchema` (with defaults) **and** a parallel `…ConfigFields` (without),
   spread into `reportConfigFields` and `generateReportSchema.config`; kept in
   sync by `schemas.config.test.ts`.
6. `apps/api/src/services/<type>Report.ts` — the generator, signature
   `(orgId, rawConfig, authority) => Promise<ReportResult>`, which parses its
   config, calls `assertReportExecutionPreflight`, handles restricted-zero-site
   scope, and applies the site filter in **every** query branch.
7. `packages/shared` — summary type in `src/types/`, any shared arithmetic in
   `src/utils/` (so API, PDF and web preview agree), renderer module in
   `src/reportPdf/`, a `REPORT_TYPE_LABELS` entry and a `buildReportPdf` arm.
8. `apps/web` — `ReportsList.tsx` union, `ReportBuilder.tsx`'s **exhaustive**
   `Record<LegacyReportType, BuilderReportType>` (breaks the build until mapped),
   `ReportTemplates.tsx` card + `handleUseTemplate` branch, `ReportEditPage.tsx`
   options form, `ReportPreview.tsx` branch, `reportExport.ts`.
9. `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/reports.json`
   — three key blocks per locale. Real translations, not English copies; the
   locale coverage test enforces it.
10. `PORTAL_DEFINITIONS` (§5.1) and a reprovision run.
11. `PortalRunDto.type` and `apps/portal/.../ReportRunList.tsx` — label only
    (§6); the portal run list has no type filter, so an unwidened union is a
    silent type lie.

---

## 6. Portal impact

- **Evidence visibility is unchanged in mechanism.** A sweep-generated run
  becomes visible on the service scorecard only when
  `portal_branding.enable_reports` is on **and** the definition is
  `portal_self_service` — both satisfied by §5.1. Otherwise the occurrence reads
  "Delivered (artifact held by the MSP)", which is the correct, honest state.
- **Setting `portal_self_service` publishes more than the delivered evidence, and
  that is a product decision, not a plumbing one.** `portalRunListPredicate`
  (`services/portal/reportsSelfService.ts:267-277`) returns **every completed run
  of every portal-self-service definition** for the org. So the moment a managed
  evidence definition is provisioned as `portal_self_service` in an org with
  `enable_reports` on, the customer can see and download that run **immediately at
  05:18 on the due day — before the technician has reviewed it or resolved the
  ticket**. For a security artifact that is a real hazard: the customer may read a
  finding before the MSP has an answer for it. **Managed identity, portal
  publication, and self-service generation must be three separate choices**, not
  one flag (OD-12).
- **Download works without any type allowlist.** `portalRunPredicate`
  (`apps/api/src/services/portal/reportsSelfService.ts:254-265`) filters on
  `reports.org_id`, `portal_self_service = true` and `status='completed'` — **not**
  on report type, and **not** on `requested_by_kind`. So a `system`-requested
  sweep run downloads through `/api/v1/portal/reports/runs/:id/pdf` on the same
  terms as any other.
- **The four types are deliberately NOT added to `PORTAL_REPORT_TYPES`** or to the
  two duplicated portal-user allowlist literals in `reportGenerationService.ts`
  (`:248`, `:760`). Consequence: the customer can *see and download* the artifact
  the MSP's plan produced, but cannot *generate* these reports on demand. That
  keeps the portal's compute surface unchanged and keeps the deliverable the
  MSP's product rather than a self-serve button (Open Decision 10).
- **Server-side PDF rendering must work for each new renderer.** The portal path
  calls `buildReportPdf` inside the API process (`renderRunPdf`,
  `reportsSelfService.ts:589`), unlike the staff path which renders in the
  browser. Each renderer therefore ships with a server-side test, not only a web
  one.
- **The runs WILL appear in the portal's own report list, and that forces two
  changes.** Verified: `portalRunListPredicate`
  (`apps/api/src/services/portal/reportsSelfService.ts:267-277`) filters on
  `reports.org_id`, `portal_self_service = true` and `status='completed'` — **no
  type filter**, exactly like `portalRunPredicate`. Its `toDto`
  (`reportsSelfService.ts:279`) declares the row's `type` as `PortalReportType`
  (the three-value `PORTAL_REPORT_TYPES` union), so a sweep-generated run of a new
  type flows through as a value outside the declared union — a type lie the
  compiler cannot see, because the value comes from the database. Therefore each
  wave that adds a portal-provisioned type **must** widen
  `PortalRunDto.type` (`packages/shared/src/types/portalVisibility.ts:246-252`)
  and the type union + label map in
  `apps/portal/src/components/portal/ReportRunList.tsx:17,24` — **label only, no
  generate button**, since the type stays out of `PORTAL_REPORT_TYPES` (which
  gates only `apps/api/src/routes/portal/schemas.ts:183`, the generate request
  schema). This is a per-wave task, not a one-off.

---

## 7. Out of scope

- Firewall rule review, VPN policy review, documentation audit, IR tabletop as
  report types (§3.0).
- Microsoft Defender for Endpoint / XDR, Identity Protection risky users, and
  anything else requiring a `customer-graph-read` **v4** manifest bump.
- Intune **compliance policy definitions** as a sync domain (only managed devices
  are persisted today).
- The unified audit log. `AuditLogsQuery.Read.All` is consented in v3 but has no
  action and no tool; a configuration-change audit report would be a separate
  feature.
- Partner-level cross-org roll-up reports. That is
  `docs/superpowers/plans/open/2026-07-01-partner-level-reports-design.md`
  (dual-owner `reports`, org XOR partner), and it is **orthogonal**: evidence is
  inherently per-customer, so per-org definitions are the right shape here.
- The ticket-checklist primitive and internal instructions on template items —
  **#5783**. This spec deliberately routes the manual remainder (documentation
  audit, IR tabletop, firewall review) there rather than faking an artifact.
- AI sweeps (**#5751**). Loaders are *modelled on* nothing from it; no module is
  imported, and `sweepEvidence.ts` is explicitly rejected as a reader (§3.1).
- Entity-level historical change records for Intune (a
  `m365_intune_device_changes` table or period snapshots). §3.3 explains why the
  current tables cannot supply them; adding them is its own feature.
- A daily sign-in aggregate tier alongside the raw events (OD-3 option C) — worth
  adding only if production volume or an annual-detail requirement demands it.

---

## 8. Open Decisions

> **Gate A resolution — 2026-09-14 (Todd: "as recommended").** OD-1 … OD-12 are
> approved as recommended, explicitly including **OD-5 = B** (dedicated managed-
> evidence execution path on `SystemReportExecutionAuthority`, bound by the closed
> server-owned registry) and **OD-12 = A** (evidence becomes customer-visible on
> *delivery*, never on generation). OD-7: firewall/VPN review stays out of scope.
> **OD-11 day-boundary sub-question** was not recommended either way; the
> conservative default is taken pending Todd's overrule: generation stays on the
> due day (#5573 semantics unchanged) and **the artifact states its coverage
> window explicitly** ("covers <period_start> to <generated_at UTC>"); moving
> generation to period close (option C) is not adopted. Status: `spec-approved`
> → Stage 3 (plan).


### OD-1 — How many report types, and which?

- **A — four types** (`threat_detection_review`, `endpoint_management_review`,
  `vulnerability_management`, `identity_access_review`): pro — each maps to a
  line item an MSP already sells and to a distinct data source; con — four PDF
  renderers, four config schemas, 4 × 8 locale blocks.
- **B — one generic `service_evidence` type** with a config selecting sections:
  pro — one renderer, one migration; con — one config schema that must express
  four unrelated shapes, one `previous.summary` comparator space shared across
  incompatible sections, and the portal shows one indistinguishable name for
  every deliverable.
- **C — two types** (a security one and an identity one): pro — halves the
  wiring; con — the Intune and Huntress sections have different freshness
  sources and different data-gap states, so a merged artifact hides which half
  is stale.

**Recommend A.** The per-type wiring is mechanical and typecheck-enforced
(§5.3); the shared-config coupling in B is the kind that is expensive forever.

### OD-2 — Persisted data only, or a fetch at run time?

- **A — persisted only** (recommended): pro — runs are deterministic, fast, and
  independent of Graph availability and of another tenant's throttle budget;
  freshness is printed, not fetched; con — the artifact is only as fresh as the
  last sync (6 h Intune, 24 h sign-in, 15 min Huntress).
- **B — fetch inside the run**: pro — always current; con — puts an external
  dependency in the 05:18 sweep's path, and for sign-ins is *impossible* anyway
  (`m365.signins.list` caps at 7 days / 50 rows / one page).

**Recommend A**, and print a "data as of" line plus a staleness banner when the
domain's `last_success_at` predates the period.

### OD-3 — Sign-in data: raw events or aggregates? What retention?

- **A — raw `m365_signin_events`, interactive only, 120-day retention**
  (recommended): pro — the admin-sign-in detail table and the failure/country/
  legacy-auth breakdowns all need row-level data, and an auditor asks for the
  rows; `previous.summary` supplies longer-horizon trend without longer retention;
  con — a 200-seat tenant may accumulate 1–4 k interactive sign-ins/day, so ~150–
  500 k rows per org at steady state.
- **B — daily aggregate rollup only** (per-org counters + bounded top-N): pro —
  two orders of magnitude smaller, trivially retainable for years; con — the
  admin-detail section becomes impossible, "which account, from where" cannot be
  answered, and every future question needs a new counter and a backfill that
  cannot be done (Graph keeps only 30 days).
- **C — both tiers**: pro — annual reviews work; con — two tables, two retention
  policies, and annual sign-in review is not a plan item.

**Recommend A.** B optimizes storage at the cost of the exact detail the
deliverable exists to provide. If volume proves to be a problem in production,
adding B later over retained A data is easy; recovering A from B is impossible.

### OD-4 — Managed-definition registry: reuse `portal_self_service`, or add a `system_definition_key` column to `reports`?

- **A — reuse `reports_portal_self_service_org_type_uniq`** (recommended): pro —
  zero schema change on `reports`, zero new export-policy classification, and it
  is *already mandatory* because `serviceReadModel.ts:112` requires
  `portal_self_service = true` for the evidence to be visible at all; con — it
  overloads one flag with two meanings (portal-visible, and Breeze-managed).
- **B — new nullable `reports.system_definition_key varchar(64)`** with a partial
  unique index: pro — an explicit, self-documenting registry that also subsumes
  the ad-hoc `reports_ai_fleet_design_org_uniq`; con — a column on `reports`
  breaks `CORE_TENANT_EXPORT_POLICY` until classified, a third per-org uniqueness
  mechanism, and it does not remove the `portal_self_service` requirement anyway.

**Recommend A.** B buys tidiness and pays with a migration, a registration-list
change and a redundant index. (This reverses my own first draft, which proposed B
before I traced the portal visibility gate.)

### OD-5 — Auto-evidence owner fragility (G3)

`deliverableAutoEvidence.ts:113-134` re-resolves the definition owner's **live**
authority every night. If that user leaves or loses org access, every
auto-evidence deliverable pointing at their definition degrades to
`scope_unverifiable` — a `console.warn`, no alert, and the occurrence eventually
flips to `missed`.

- **A — keep the user-principal model, fix observability only**: when
  auto-evidence refuses for any reason other than `not_due` / `already_attached`,
  post an internal ticket comment naming the reason. Pro — no security-gate
  change; con — the deliverable still silently stops producing evidence until
  someone re-saves the definition.
- **B — a dedicated managed-evidence execution entry point** taking the existing
  `SystemReportExecutionAuthority`, leaving the ordinary user path untouched
  (**recommended**): pro — an org-owned recurring obligation stops depending on
  one employee's continued access, which is the actual product requirement;
  con — new authorization surface that must be got right.
- **C — `service_deliverables.auto_evidence_owner_user_id`**: pro — the
  deliverable names the owner; con — a third owner concept that **relocates the
  failure rather than removing it**; the named employee can leave too.

**Recommend B — this reverses my first position, on codex's argument and
evidence.** Two things settled it.

First, "just relax the gate" is not even implementable as I originally framed it:
`ReportExecutionAuthority` (`services/siteScope.ts:79`) is a union of the user and
portal-user authorities with **no system arm** —
`SystemReportExecutionAuthority` is a separate, deliberately non-assignable type —
and `assertExecutableAuthority` (`reportGenerationService.ts:192`) rejects
anything else. So B is not "loosen a boolean"; it is "add a second, explicitly
typed execution path", which is the safer shape anyway.

Second, the product argument is decisive: a contractual monthly obligation that
stops producing evidence because a technician changed jobs is a defect, not a
safety feature.

**B's authorization is not "the key is non-null".** It requires all of:
a **closed, server-owned registry** binding key → type → config (a partner cannot
mint one); a scope validated as org-wide `unrestricted`, never a restricted
fingerprint stamped on an org-wide result; immutable system provenance on the
definition; and an explicit authorization to enable org-wide evidence for an org.
One specific trap to avoid: `applyTemplateSet` is guarded by **contracts**
permissions (`routes/deliverableTemplates.ts:32`), not report authority — so
this design must not turn contracts-write into a route for publishing unrestricted
security data. Ordinary edit/delete/reauthorize protection for system definitions
must be preserved (`routes/reports/helpers.ts:172`, which today decides
"system-managed" by *type* and must become definition-based, since these types
will have both user and system definitions).

**A's observability fix is still required, independently of B.** Refusals today
only `console.warn` (`deliverableAutoEvidence.ts:73`); the occurrence stays open
and is retried on later sweeps, becoming `missed` only after grace — so there is a
window in which a visible failure state would let someone fix it. B removes one
refusal cause; it does not make the others visible.

### OD-6 — Resolve the template's report type at apply time or at sweep time?

- **A — apply time**, inside `applyTemplateSet`'s existing transaction
  (recommended): pro — the resulting `service_deliverables` row is fully
  concrete, the existing composite FK and `validateReferences` keep working
  unchanged, and a provisioning failure surfaces at apply with a 4xx the
  technician sees; con — an org that gains the definition later needs a re-apply.
- **B — sweep time**, storing the type on `service_deliverables` and resolving
  nightly: pro — self-healing; con — a second nullable auto-evidence column with
  an XOR check, resolution failures become 05:18 `console.warn`s (the exact
  silence OD-5 is trying to remove), and the composite FK stops being the
  guarantee it is today.

**Recommend A.**

### OD-7 — Firewall / VPN: scope out, or ship a narrow version?

- **A — scope out entirely** (recommended): §3.0 gives the evidence. Say in the
  spec what would have to exist.
- **B — ship a "host firewall and endpoint protection state" report** from
  `security_status.firewall_enabled` + CIS 9.1.1 / 3.4.1 results: pro — real data,
  really per-device; con — a customer receiving a document titled anything near
  "firewall review" will read it as a rule review. Naming cannot fix that.
- **C — fold the boolean into `endpoint_management_review`**: pro — honest, and
  it is genuinely endpoint posture; con — mixes Intune (M365) and agent data with
  different freshness in one section.

**Recommend A**, and revisit B under an unambiguous name (e.g. "Endpoint
protection state") only if a customer asks.

### OD-8 — Restricted site scope against org-wide identity data

- **A — per-type declaration** (recommended): `identity_access_review` returns the
  `zeroSafeReport` empty-but-shaped result under a restricted authority, because
  M365 identity has no site dimension and serving it would be a scope escalation.
  `endpoint_management_review` serves the site-attributable subset (linked via
  `breeze_device_id`) and discloses the unlinked population as a **count only**.
  `threat_detection_review` and `vulnerability_management` filter on
  `devices.site_id` normally.
- **B — refuse to create a restricted-scope definition of these types** at all:
  pro — fails loudly at create instead of quietly at run; con — the scope comes
  from the *user's* restriction, not from config, so the same definition is valid
  for one technician and not another; the existing model has no way to express
  that.

**Recommend A** — it matches the existing `zeroSafeReport` contract rather than
inventing a new refusal.

### OD-9 — Wave order: where does the foundation go?

- **A — foundation first, before any report type** (**recommended**): one wave
  carrying managed-definition ownership (OD-5 B), the template linkage, period
  semantics (OD-11) and visible failure handling. Then Huntress → Intune →
  vulnerability → sign-in ingestion → identity.
  Pro — every report type is partner-usable and period-correct the day it lands;
  con — one wave with no customer-visible output.
- **B — first report type, then foundation** (my first position): pro — proves
  the pipeline immediately; con — the first type is built against an ownership and
  baseline model that the next wave changes, so it is rework by construction.
- **C — foundation after all four types**: con — waves 1–4 ship something a
  40-org partner wires by hand 40 times, which is how a feature gets judged before
  it is finished.

**Recommend A — reversed from my first position, on codex's argument.** It became
correct once OD-5 flipped to B and OD-11 surfaced: both change what a report
definition *is* and how a generator is invoked, so building a report type first
means building it twice. Note also that W01 was never quite "zero data work" — the
Huntress coverage disclosure (§3.2) is real work even with no new table.

### OD-10 — Should customers be able to generate these reports themselves?

- **A — no** (recommended): provision the definitions as `portal_self_service`
  (required for evidence visibility) but leave the four types out of
  `PORTAL_REPORT_TYPES` and out of the portal-user execution allowlists. The
  customer sees and downloads what the plan produced.
- **B — yes**: pro — self-serve; con — the deliverable stops being the MSP's
  product, portal compute grows, and it means touching the two duplicated
  allowlist literals in `reportGenerationService.ts` plus the portal UI unions.

**Recommend A**, revisitable per type later — it is additive.

### OD-11 — Period boundaries and the prior-period baseline

Surfaced by codex and verified. Auto-evidence selects only the occurrence's id,
ticket and due date (`deliverableAutoEvidence.ts:54-61`), passes the definition's
saved config through unchanged, and **never calls `previousBaselineFor`**; that
helper in turn keys only on `(report_id, execution_scope_fingerprint)`
(`reportGenerationService.ts:86-104`). Two consequences: a sweep-generated run has
no `previous` at all, and once §5.1 gives an org one shared definition per type,
a monthly and a quarterly deliverable on that definition would compare each
other's runs. Separately, an occurrence's period **includes** the due day
(`services/recurrence.ts:29`) but generation runs at 05:18 **on** that day, so the
period has not closed and the sources have not caught up.

- **A — pass occurrence period boundaries into generation, and select the prior
  comparable occurrence's run** (recommended): the deliverable's own period is the
  only correct window, and the prior *occurrence* is the only correct baseline.
  Pro — correct for shared definitions and for mixed cadences on one definition;
  con — extends `generateReport`'s inputs and needs a baseline selector keyed on
  deliverable + cadence, not just report id.
- **B — one definition per deliverable instead of per type**: pro — makes
  `previousBaselineFor` correct as-is; con — throws away the whole per-type
  managed-definition design and reintroduces per-org, per-deliverable wiring.
- **C — generate on period close (the day after `period_end`) rather than on the
  due day**: cleaner data, but it changes #5573's shipped due-date semantics and
  the artifact would arrive after the ticket opened.

**Recommend A for the baseline**, and **surface the day-boundary question to Todd
rather than deciding it here**: either the artifact states that it covers the
period up to 05:18 on the due day, or generation moves to period close. It is a
product call about what the customer is promised, not a technical one.

### OD-12 — When does the customer see the artifact?

- **A — publish on delivery, not on generation** (recommended): decouple portal
  visibility from `portal_self_service` alone, so a managed evidence run becomes
  customer-visible when the occurrence is **delivered**, not at 05:18 when it is
  generated. Pro — the technician reviews the security artifact before the
  customer reads it, which is the workflow #5573 describes; con — needs a
  publication gate `portalRunListPredicate` does not have today.
- **B — publish on generation** (today's behaviour if nothing changes): pro — no
  work; con — a customer can read an unreviewed finding before the MSP has an
  answer, and `portalRunListPredicate` exposes **every** completed run of the
  definition, not only the delivered one.
- **C — do not set `portal_self_service` on evidence definitions**: con — then
  `serviceReadModel.ts:112` suppresses the evidence entirely and every occurrence
  reads "artifact held by the MSP", which defeats the feature.

**Recommend A.** This is the second decision (with OD-5) that I would not ship
without Todd's explicit answer, because it is about what the customer is shown and
when.

---

## 9. Waves

Each wave is independently shippable and independently valuable. Smallest first.
**Re-check the newest migration on `origin/main` at the start of every wave** —
§4.6.

| Wave | Scope | Value on its own | New data |
|---|---|---|---|
| **W01 — foundation** | Managed evidence definitions (§5.1) with the OD-5 B execution path and its closed registry; `deliverable_template_items.auto_evidence_report_type` + export-policy classification; `applyTemplateSet` apply-time resolution on the real `tx`; OD-11 period boundaries and prior-occurrence baseline; visible refusal state (internal ticket comment + a queryable status); OD-12 publication gate; reprovision script wired into `package.json` with a widened org selector; opt-in linkage backfill; **the auto-evidence web pickers, which have never existed** | No new artifact, but every later wave lands partner-usable, period-correct and reviewable on arrival — and the one existing auto-evidence user stops depending on a single employee's account | none |
| **W02** | `threat_detection_review` end to end: enum migration, generator + coverage disclosure (§3.2), config schema, summary type, PDF renderer, web wiring, 8 locales, `PORTAL_DEFINITIONS`, `PortalRunDto` widening, one integration test proving the sweep generates it and files evidence | First real artifact; a Huntress-using MSP gets a monthly deliverable in every org at once | none |
| **W03** | `endpoint_management_review` | First real consumer of the `#5327` M365 sync tables | none |
| **W04** | `vulnerability_management` | The parent spec's own worked example finally exists | none |
| **W05** | `signin_events` sync domain: enum add, `m365_signin_events` table + RLS + all four registration lists, executor action + projection allowlist, persister with overlapping-window delta, cadence bounds, own token bucket, retention purge | No customer artifact yet, but the data starts accumulating — and because Graph keeps only ~30 days it can **only** accumulate forward, so starting early is worth a wave of its own | **yes** |
| **W06** | `identity_access_review` on top of W05 | The highest-value deliverable in the plan | none |

W03–W06 are inert unless `M365_TENANT_SYNC_ENABLED` is on
(`apps/api/src/config/env.ts:226`, default `false`). That is worth stating in each
wave's rollout note, and worth confirming per region before W06 ships.

## 9.1 Test and rollout notes

**Contract tests that will fire on a type addition** — all of these are how the
work gets caught, so run them, do not reason about them:

- **Test API (unit):** `reportGenerationService.test.ts` (the `ReportType` union
  vs the pg enum), `schemas.config.test.ts` (`…ConfigSchema` / `…ConfigFields`
  parity), `reportTypeSurvivesBuilder.test.ts`, the locale coverage test,
  `autoMigrate.test.ts` (ordering + that every replay path resolves),
  `migrationRlsScope.test.ts`, `composeBindMounts.test.ts` (unaffected but cheap).
  Typecheck alone catches the two exhaustive switches and `ReportBuilder.tsx`'s
  exhaustive `Record`.
- **Test API, W05 only:** `packages/shared/src/m365/sync.test.ts` asserts
  `M365_SYNC_DOMAINS` "names exactly the **six** persisted domains" — becomes
  seven; `apps/api/src/services/m365Sync/run.test.ts` asserts
  `Object.keys(DOMAIN_PERSISTERS).sort()` equals `M365_SYNC_DOMAINS.sort()` and
  that `M365_SYNC_IMPLEMENTED_DOMAINS` matches.
- **Integration Tests (live DB — a unit-green PR still reddens here):**
  `rls-coverage.integration.test.ts`, `tenantCascade.integration.test.ts`,
  `tenant-export-policy.integration.test.ts`,
  `tenantExportErasureRoundtrip.integration.test.ts`,
  `orgLifecycleFoundations.integration.test.ts`.
- **New integration tests, W01 and W02:** drive `runDeliverableSweep` against real
  Postgres and assert a `service_deliverable_evidence` row of `kind='report_run'`
  appears with a completed run of the new type, **for an org the template was
  applied to, never wired by hand**. W01 additionally covers: the managed
  definition surviving owner departure (the case OD-5 exists for), a refusal
  producing a visible state rather than a `console.warn`, the org-merge collision
  path when two orgs each hold a managed definition of the same type, and a
  period-boundary case proving a monthly and a quarterly deliverable on one shared
  definition do not compare each other's runs (OD-11).
- **Rendering is tested on all three paths from the same stored result** —
  staff/browser (`reportExport.ts`), portal/server (`renderRunPdf`) and scheduled
  email. A type with no `buildReportPdf` arm silently falls through to
  `renderGenericReport` and drops the whole designed summary, which no unit test
  catches. Note too that the eight locale files localize the **web UI only** — the
  PDF renderer is English, so a locale addition is not a localized artifact.
- **RLS forge, W05:** as `breeze_app`, attempt a cross-tenant insert into
  `m365_signin_events` and confirm `new row violates row-level security policy`.

**Rollout**

- No new feature flag. A report type is inert until a definition exists; the
  definitions are provisioned by §5.1.
- Every release that adds a type must run
  `pnpm --filter @breeze/api reports:reprovision-portal-definitions --apply`
  (dry-run first). Without it, orgs that enabled portal reports earlier lack the
  new definition and the portal generate path 404s forever.
- W05 accumulates data forward only — enable it at least one full deliverable
  period before W06's first artifact is promised to a customer.
- No agent change, no droplet env var, no consent change (§4.5). Deploy is a
  normal image roll.

---

## 10. Quorum record

**Fable position** formed first from a direct read of the report pipeline, the
deliverables subsystem, the M365 sync foundation, the Huntress and vulnerability
schemas, the Go agent's firewall and VPN collectors, and the migration guard
rules. The material corrections that position went through before Codex saw it:

- The initial draft proposed a new `reports.system_definition_key` column. Tracing
  `serviceReadModel.ts:112` showed `portal_self_service = true` is *already*
  required for evidence to be visible, making the existing partial unique index
  the registry — OD-4 reversed to A.
- The initial draft assumed a Breeze-provisioned definition could be
  system-principal. `deliverableAutoEvidence.ts:108-111` refuses exactly that;
  the whole provisioning design changed, and OD-5 exists because of it.
- The initial draft treated sign-in review as possibly an on-demand fetch. The
  168-hour / 50-row / single-page cap on `m365.signins.list` closed that.

**Codex** (`gpt-6-astra`, `model_reasoning_effort="xhigh"`, `-s read-only`) was
given the issue text, all eleven established facts, the ten draft decisions and
the file list, and asked for AGREE / DISAGREE / REFINE with file:line evidence.
It returned one AGREE, seven REFINEs and two DISAGREEs. **Every claim it made that
changed a decision was re-read against the source before being accepted**; the
three load-bearing ones are quoted with line numbers in the body above.

**Where codex disagreed, and how it resolved:**

| Draft decision | Codex | Outcome |
|---|---|---|
| **OD-5** — auto-evidence owner fragility. I recommended keeping the user-principal model and fixing observability. | **DISAGREE.** An org-owned recurring obligation must not depend on one employee's access; and "relax the gate" is not implementable as framed — `SystemReportExecutionAuthority` is deliberately outside `ReportExecutionAuthority` (`siteScope.ts:79`) and `reportGenerationService.ts:192` rejects it. Use a dedicated managed-evidence entry point with a closed server-owned registry. | **Codex, on the merits.** Recommendation flipped to B. Its warning that `applyTemplateSet` is guarded by *contracts* permissions (`routes/deliverableTemplates.ts:32`) — so this must not make contracts-write a route to publishing security data — is now a stated constraint. My observability fix is kept as a required companion, since B removes one refusal cause and not the rest. |
| **OD-9** — wave order. I put the foundation at W02, after the first report type. | **DISAGREE.** Foundation first, then Huntress → Intune → vuln → sign-in ingestion → identity. | **Codex.** Once OD-5 flipped and OD-11 surfaced, both change what a definition is and how a generator is called, so a type built first is built twice. |
| **§3.3 Intune "changes since last period" from `last_changed_at`.** | **DISAGREE.** The `core_hash` projection includes `lastSyncDateTime` *on purpose* (`domains/intuneDevices.ts:57-61`), so `last_changed_at` churns on every check-in; upserts overwrite; 30-day stale deletion prevents reconstruction. | **Codex — verified verbatim.** The section now ships current inventory + rollup trend and states why entity-level history needs real change records. |
| **§3.1 freshness from `last_success_at`.** | **DISAGREE.** `lastSuccessAt` advances on `partial` too (`run.ts:373-376`); `summary.ts:59-62` already documents using `last_complete_snapshot_at`. | **Codex — verified verbatim.** New rule 2a. |
| **§3.1 "changes since last period comes from `previous`".** | Raised as a missed contract: auto-evidence never calls `previousBaselineFor`, and that helper keys only on report id + fingerprint. | **Codex — verified.** This was a real defect in my draft; it produced **OD-11** and moved period semantics into the foundation wave. |
| **§6 portal publication.** | Raised: `portal_self_service` exposes *all* completed runs via `portalRunListPredicate`, not just delivered evidence. | **Codex — verified.** Produced **OD-12**; the customer seeing an unreviewed security finding at 05:18 is a product hazard, not a detail. |
| **F6** — I said `m365.signins.list` is one page of 50. | Two pages, up to 100 rows. | **Codex.** Corrected; the conclusion (unusable for a 30-day review) is unchanged. |
| **F3** — I called provisioning an upsert. | Insert-if-absent; repairs neither config nor ownership (`reportsSelfService.ts:102`). | **Codex.** Now an explicit §5.1 constraint with config-versioning and adoption as named design tasks. |
| **D1** — I justified dropping documentation audit as "nothing to audit against". | The corpus exists (`orgDocuments.ts:18`); what is missing is a required-document baseline and review criteria. | **Codex.** Wording corrected — a more accurate reason, same verdict. |
| **D5, D3, D8, org-merge registry, executor threading, PDF localization, definition-based system-managed UI.** | Various REFINEs. | **Accepted in full**; each is now a stated constraint. |
| **OD-4** (managed registry) and **OD-7** (firewall) | AGREE / REFINE-toward-agreement. | No change. |

**Where I did not follow codex:** it suggested retaining daily sign-in aggregates
alongside raw events. Deferred rather than rejected — the aggregate tier buys
long-horizon trend, which OD-11's prior-occurrence baseline already supplies from
`summary`, so it would be a second table earning nothing in the first cut. Noted
in OD-3 option C as the thing to add if volume or an annual review demands it.

**Two decisions need Todd's answer before implementation, not just approval of
the doc:** OD-5 (system-principal execution for managed evidence — a new
authorization surface) and OD-12 (whether the customer sees an artifact at
generation or at delivery). OD-11's day-boundary half is a product call too.
