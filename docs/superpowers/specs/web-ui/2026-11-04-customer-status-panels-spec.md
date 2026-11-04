# Customer status panels and a rule-driven Recommendations panel

**Date:** 2026-11-04
**Status:** Draft. Waiting for Gate A (spec approval).
**Issue:** #11022. Related: #7271 (UniFi per-port traffic), #3303 (fleet findings flag UI).
**Area:** `web-ui`. The work touches `apps/web`, `apps/portal`, `apps/api`, `packages/shared`, and the Go agent
in the network waves.
**Scope:** one screen per customer organization that answers "is this customer OK?". It covers Backups, Email
security, Network traffic, Investigation & response, and a Recommendations list. It has two surfaces: the MSP's
org record page (web) and the customer's portal dashboard. This document decides intent. It contains no plan
and no code.

Evidence labels:
- **verified** means the author re-read the code on `origin/main` at `36f9d9ca53`.
- **reported** means an exploration pass or the design reviewer cited the file:line, and the author did not
  re-read it.
- **inferred** means a conclusion drawn from verified facts, not observed running.

**Design quorum (CLAUDE.md):** the draft went to an independent `codex exec` review (read-only, `xhigh`). It
agreed with the overall shape: one composite read, reuse of existing read models, declarative rules, and email
security as a new provider family. It found six factual errors in the draft and a set of risks the draft missed.
The author re-read the code for each factual claim. Every confirmed correction is folded into the text and
listed in §8. The one disagreement still open is recorded as Decision 8.

---

## 1. Problem

A design-partner MSP said Breeze has the features but the UI is crowded. They said a competitor wins demos with
a few single-screen panels per customer. They asked for five panels:

| Panel | What they want at a glance |
|---|---|
| Backups | last run, next run, size, restore points, failures |
| Email security | blocked phish, spam and malware counts from the connected email-security provider |
| Network traffic | top talkers and bandwidth by site (they get this from UniFi today) |
| Investigation & response | recent detections and what was done about them |
| Recommendations | derived actions: users missing MFA, devices missing updates, network-access non-compliance, "79% of assets monitored" |

Most of this data already exists in Breeze, but it is spread over five areas of the app. Each area has its own
page and its own org filter.

What the two surfaces show today:
- **Org record page Overview tab** (`apps/web/src/components/organizations/record/OrgOverviewTab.tsx`): fleet
  counts, account facts, key dates, critical alerts and recent activity. None of the five panels. *reported*
- **Portal dashboard** (`apps/portal/src/pages/dashboard/index.astro` → `components/portal/DashboardTiles.tsx`):
  a security score, devices protected, patches applied, an optional backup tile, and an "action items" count.
  The action-items count is open fleet findings plus reviewed remediation suggestions
  (`services/portal/actionItemsReadModel.ts:9`). *verified*

### 1.1 What data exists for each panel

**Backups: data-complete today, both native and Cove/Dropsuite.**
- Sources: `backup_jobs`, `backup_snapshots`, `backup_policies` and `backup_configs`
  (`apps/api/src/db/schema/backup.ts`); `backup_provider_devices` (`schema/backupProviders.ts`). *reported*
- Read models: `services/backupHealthReadModel.ts` (`summarizeBackupHealth`, `getProviderCoverageForDevices`).
- Endpoint: `GET /backup/dashboard` (`routes/backup/dashboard.ts`).
- Next-run helper: `getNextRun()` (`routes/backup/helpers.ts:275`). *verified*
- Gaps:
  - Nothing computes "next run" for the whole org. It is computed only per device.
  - The current dashboard aggregation uses a 24 h window, counts every snapshot, and caps overdue devices at 20
    (`routes/backup/dashboard.ts:216, :352`). *reported*
  - Third-party providers report neither a next run nor a restore-point count.

**Investigation & response: data-complete for detections. "What was done" needs a new read model.**
- Detections are already merged at query time in two places. The two merge different populations:
  - `GET /incidents/feed` (`routes/incidents.ts`, `IncidentFeedRow` at `routes/incidents.helpers.ts:142`) merges
    tracked incidents, Huntress, S1 and `edr_detections`. It has no native `security_threats`.
  - The portal's `securityOverview()` (`services/portal/securityReadModel.ts:177`) merges native threats, S1,
    Huntress and EDR. It has no tracked incidents. *verified (exports); reported (legs)*
- Response actions are spread over `edr_actions`, `s1_actions`, `incident_actions`,
  `device_network_isolations` and the native threat status. Isolation rows reference incident actions, so a
  naive union double-counts them. Huntress has no actions table.

**Network traffic: mostly not data-complete.**
- What exists:
  - WAN health from the cloud sync. `unifi_site_mappings.wan_metrics` holds latency, packet loss and uptime
    from `/v1/isp-metrics/5m`. *verified*
  - The `unifi_device_telemetry` and `unifi_clients` tables have `tx/rx_bytes` and uplink-rate columns.
    *verified*
- What does not work:
  - The agent collector does not populate those columns. The UniFi Integration API client list has **no
    per-client throughput**: `Client.TxBytes`/`RxBytes` are tagged `json:"-"`
    (`agent/internal/unifi/client.go:84-110`). The device rates are on a separate `statistics/latest`
    endpoint, and the collector fetches statistics only for Wi-Fi APs. *verified (client.go); reported (AP-only
    fetch)*
  - Both tables are latest-snapshot only. They have unique indexes on `(collector_id, unifi_device_id)` and
    `(collector_id, mac)`. *verified*
  - So **top talkers cannot be built from UniFi data Breeze collects today**, and gateway throughput needs an
    agent change.
- Non-UniFi sites have only `device_metrics.bandwidth*` for managed endpoints. That is bytes per second summed
  across interfaces, not WAN use.
- #7271 (per-port rates) is related but does not unblock this panel.

**Email security: no data.**
- Nothing collects email threat counts. The M365 Graph read executor calls no mail-threat endpoint and is
  GET-based (`apps/m365-graph-read-executor/src/microsoft/readActions.ts`, `graphClient.ts`).
- Google Workspace uses `gmail.readonly` only for delegate and settings tools.
- No Mimecast, Proofpoint, Avanan or similar code exists. *reported*

**Recommendations: mostly data-complete.**
- What exists:
  - The declarative `TRUST_CONTROL_CATALOG` (`packages/shared/src/trustCenter/controlCatalog.ts`) and its
    evaluator (`evaluate.ts:106`).
  - Evidence from `loadPostureEvidence()` (`apps/api/src/services/postureEvidence.ts:308`). `mfa_enforced_m365`
    comes from a separate overlay (`services/trustPage/trustOnlyEvidence.ts`). *verified*
  - The existing Security Recommendations page is driven by a **hard-coded** rule function,
    `buildBe9Recommendations` (`routes/security/helpers.ts:1055`). It fires when any device is affected. It
    stores complete/dismiss state as `audit_logs` rows. It has no fix links. *verified (builder); reported
    (status map)*
- Gaps:
  - Nothing computes "% of assets monitored".
  - "Network-access non-compliance" has no definition in Breeze (§3.6).

### 1.2 An adjacent defect

`GET /partner/dashboard` returns hard-coded `alertCount: 0` and `compliance: 100` for every org
(`apps/api/src/routes/partner.ts:233-234, 253-254`). *verified* It is outside this feature. File it as a
separate issue.

---

## 2. Users & scope

**Org record page, `/organizations/:id` (web).**
- Who: MSP technicians and partner admins.
- How the read runs: in partner scope, reading one org. `makeOrgFetch` pins the org, and the `/summary` route
  requires partner or system scope plus `requireOrgRead` (`routes/orgSummary.ts:110`). *reported*
- Site-restricted technicians must see only their sites' numbers.
- In scope: **yes.** This is the primary surface.

**Main dashboard, `/` (web), for an org-scoped user.**
- Who: internal-IT staff, in an org-scope deployment.
- How the read runs: org scope.
- In scope: **Decision 2.** The recommendation is yes, using the same component.

**Portal dashboard.**
- Who: the MSP's customer. A portal user belongs to exactly one org.
- How the read runs: `portalOrgDbAccessContext` (`routes/portal/portalDbContext.ts:10`). It has **no partner
  access.**
- In scope: **yes.** Each panel sits behind a partner-controlled `portal_branding` flag.

**A partner-wide "which customers are red?" rollup.**
- In scope: **no** (§5). The panel `state` field is designed so the account board can roll it up later.

Everything in this spec is **per organization**. v1 adds no rule configuration (Decision 6). The only new
settings are portal visibility flags.

---

## 3. Proposed design

### 3.1 A registry of panel providers behind one composite read

```
GET /orgs/organizations/:id/status-panels?panels=backup,email,network,ir,recs   (web; partner or org scope)
GET /portal/status-panels                                                        (portal auth)
```

The server registry is new, in `apps/api/src/services/customerStatus/`:

```ts
interface StatusPanelProvider<K extends StatusPanelKey> {
  key: K;                                       // 'backup' | 'email' | 'network' | 'ir' | 'recs'
  domain: DisclosureDomain;                     // 'backup' | 'security' | 'edr' | 'email' | 'network' | 'posture'
  staffPermissions: PermissionKey[];            // ALL required; the panel is omitted (not zeroed) if any is missing
  portalFlags: PortalVisibilityFlagKey[] | null; // ALL must be on; null means never in the portal
  sources(orgId, ctx): Promise<SourceStatus[]>; // per-source connection and freshness (§3.2)
  load(orgId, ctx, asOf): Promise<StatusPanelBody<K>>;
  portalProjection?(body): PortalStatusPanelBody<K>;
}
```

How execution works. This was corrected in review: the portal dashboard this was modelled on uses
`Promise.all` inside one transaction, so one SQL error aborts every panel.
- **Each panel runs in its own short `withDbAccessContext` transaction.** Every transaction uses the same
  request auth context.
- Each transaction does a `SET LOCAL statement_timeout` (for example 2 s) so a slow panel is cancelled in
  Postgres, not just abandoned in JavaScript.
- At most 3 panels run concurrently, so one screen cannot take five pool connections.
- A failed or timed-out panel returns `state: 'unavailable'`. The other panels still render.
- No panel escalates to system context.
- Site restriction is passed to every read model. Read models that already take an `OrgAxisLiveSiteScopeV1`
  (for example `loadPostureEvidence`) get it directly. The others gain a `siteIds` filter.
- Responses are cached privately for 60 s with a weak ETag. That caching does not bound server work. Server
  work is bounded by the per-panel budget above and by §3.3.5.

Why one composite read rather than five endpoints: it is one screen. A composite gives one round trip and one
place that evaluates permissions and flags. The account board can later reuse the same registry. Decision 1
records the alternative.

### 3.2 The common panel envelope

```ts
interface StatusPanelEnvelope {
  key: StatusPanelKey;
  state: 'healthy' | 'attention' | 'critical' | 'not_configured' | 'no_data' | 'unavailable';
  headline: { value: string | number | null; unitKey: string };
  sources: SourceStatus[];        // one per contributing source, not one timestamp for the panel
  primaryLink: FixLinkRef | null; // §3.4
}
interface SourceStatus {
  source: string;                 // 'native_backup' | 'cove' | 'dropsuite' | 'unifi:<siteId>' | 'm365' | …
  connection: 'connected' | 'not_connected' | 'consent_missing' | 'not_licensed' | 'sync_failed';
  asOf: string | null;
  stale: boolean;                 // asOf is older than this source's freshness budget
}
```

These rules come from the posture report (`docs/superpowers/plans/reports/2026-06-29-security-compliance-posture-report.md`):
- **No data is never healthy, and not assessed is never 0 %.**
- `not_configured` means no source is connected. It renders a "Set up" link.
- `no_data` means a source is connected and has not produced data yet. It renders "Waiting for first sync".
- Consent missing, not licensed and sync failed are each named for what they are. None of them is shown as
  "waiting".
- When one source is stale, the panel flags that source. One fresh source cannot hide a stale one.

### 3.3 Panels

#### 3.3.1 Backups: data-complete

The panel separates three questions that today's dashboard blends.

**Clean success.**
- Last successful run: the newest `completed` job, plus provider `last_success_at`.
- `completed_with_errors` counts as degraded, not as a success.

**Restore availability.**
- Restore points: non-expired `backup_snapshots`. Snapshots from `partial` jobs count as real restore points.
- Newest restore point.
- Providers report no restore-point count. That source shows "not reported", never 0.

**Affected devices.**
- Devices with a failed or partial job in the last 7 days.
- Devices overdue against their schedule. This count is **not capped**. The list in the panel is capped.
- Provider devices in a failed status.

**Next run.**
- New helper: `getOrgNextBackupRun(orgId, scope)` returns the earliest `getNextRun(schedule, tz)` across the
  org's devices for native policies. Providers report no next run, and the panel says so.

**Size.**
- Native storage bytes plus provider `used_bytes`. The panel labels which sources contributed.

Reuse:
- Lift the aggregation out of `routes/backup/dashboard.ts` into `services/backupHealthReadModel.ts`, and make
  the route call it.
- The 24 h window and the overdue cap become parameters, so the dashboard keeps its current numbers.

Portal: the projection drops storage-provider names and error text. The panel is gated by the existing
`enableBackups` flag.

#### 3.3.2 Investigation & response: detections exist; actions need a new read model

**Detections.**
- Extract the leg queries into `services/securityEventsReadModel.ts`, with an **explicit population
  parameter**. Both existing callers keep their current populations: the incidents feed includes tracked
  incidents, and the portal overview includes native threats and vulnerability findings.
- The panel's population is tracked incidents ∪ vendor detections ∪ native threats.
- A detection that has been promoted into an incident is counted once, as the incident.
- The open headline counts **all unresolved** detections, whatever their age. The 30-day window applies only to
  "recent activity" and "resolved in period".
- State:
  - `critical` as soon as any open detection is critical or high.
  - Age is a separate escalation shown in the panel ("open 3 days"). It does not gate the state.

**What was done.**
- New read-only `services/responseActionsReadModel.ts`. It normalizes each action to:

```ts
{ at; deviceId | null; action: 'isolate' | 'unisolate' | 'quarantine' | 'kill' | 'remediate' | 'resolve' | 'scan' | …;
  outcome: 'requested' | 'accepted' | 'succeeded' | 'failed' | 'reverted' | 'unknown';
  actor: 'vendor_auto' | 'technician' | 'ai' | 'unknown'; source; causalId }
```

- Rules:
  - When a vendor's "succeeded" only means "accepted", the outcome is `accepted`
    (`services/edrProviders/types.ts:161`). *reported*
  - Isolation rows that reference an `incident_action` are collapsed on `causalId`, so one isolation is counted
    once.
  - A native quarantine without a timestamp or actor is shown with `actor: 'unknown'` and its detection time.
  - A reversal pairs with its original action, and the summary shows the net state.
- **No new table.** Decision 4 covers materializing.

**Permissions.** The panel requires every permission that the incidents feed requires today
(`routes/incidents.ts:294`). It also honours site restriction.

**Portal.**
- The projection shows counts and plain-language outcomes ("1 device isolated, still isolated"). It never shows
  file paths, process names or MITRE ids.
- Flags: `enableSecurity`. The vendor legs also need `enableEdrVisibility`.

#### 3.3.3 Network traffic: WAN health today; throughput and top talkers need new collection

**v1 (no new data).** For each site with a UniFi mapping:
- WAN latency, packet loss and uptime from `wan_metrics`, with `wan_metrics_at`.
- Gateway and device online state.
- No throughput and no top talkers. The client count is shown only where it is complete. The collector reads
  only the first page of the client list (`client.go` comment). *verified*

**v2 (agent change, so high blast radius): gateway throughput.**
- The UniFi collector fetches `statistics/latest` for the **gateway**, not only APs, and reports uplink
  `txRateBps`/`rxRateBps` samples.
- The API stores hourly buckets in a new table:

```
unifi_wan_rate_buckets(
  id, org_id NOT NULL, site_id NOT NULL, collector_id NOT NULL,
  gateway_key text NOT NULL,          -- the controller's gateway device id; never NULL
  bucket_start timestamptz,           -- hour
  samples int, avg_rx_bps bigint, avg_tx_bps bigint, peak_rx_bps bigint, peak_tx_bps bigint,
  UNIQUE (collector_id, gateway_key, bucket_start))
```

- Rates are averaged, so no counter differencing is needed.
- Ingest is an idempotent upsert keyed by `(collector_id, gateway_key, bucket_start)`, and it accumulates
  `samples`. A replayed or retried batch must not double-count. Each sample carries its collector timestamp,
  and the upsert ignores a sample it has already folded in (the plan picks the dedup key).
- Retention is 31 days.

**v3: top talkers. The source is Decision 5.** The Integration API has no per-client throughput. These are the
candidate sources:
- The classic UniFi Network controller statistics endpoints, polled locally by the agent collector. They expose
  per-client byte counters.
- Managed endpoints ranked by `device_metrics` bandwidth. This is labelled as "managed devices, all interfaces"
  and is never called WAN use.
- Defer.

If a cumulative-counter source is chosen, the ingest **must**:
- Keep a per-subject checkpoint, `(collector, subject, last_counter, last_sample_at)`.
- Treat the first sample as a baseline that contributes no delta.
- Treat a lower counter as a reset only when the controller's uptime or session id also changed. Otherwise
  drop the sample.
- Split a delta across hour boundaries in proportion to time.
- Drop samples that arrive out of order.
- Update the checkpoint and the bucket in one transaction.

**Ownership on remap.**
- A collector or site mapping can move between orgs and sites.
- Buckets keep the org and site they were written under. That history stays with the source org.
- New buckets take the new mapping.
- The bucket writer reads the mapping at write time. It never trusts a cached org.

#### 3.3.4 Email security: a new integration family

In v1 the panel shows `not_configured` with a "Connect an email-security provider" link. That fixes the screen
layout now. The data source lands in its own waves.

**A new provider family, `emailSecurityProviders`.**
- It is modelled on `services/edrProviders/registry.ts` (`EdrProviderAdapter` at `types.ts:197`) and
  `services/backupProviders/registry.ts`. The codebase has one registry per integration family and no generic
  connector registry.

```ts
interface EmailSecurityProviderAdapter {
  key: EmailSecurityProviderKey;
  testConnection(creds): Promise<ConnectionCheck>;      // includes licence / consent status
  listTenants(creds): Promise<VendorTenant[]>;          // for tenant → org mapping
  fetchDailyStats(creds, tenant, day): Promise<EmailThreatDailyStats>;
  countingUnit: 'message' | 'recipient';                // declared per adapter; shown in the panel
  categoryOverlap: 'exclusive' | 'overlapping';         // overlapping ⇒ no "total blocked" sum
}
interface EmailThreatDailyStats {   // counts only, never message metadata
  inboundTotal; delivered; blockedPhish; blockedMalware; blockedSpam; blockedImpersonation;
  quarantined; releasedFromQuarantine; userReported;    // each number | null; null = not reported
}
```

**Counts only, by design.**
- Breeze stores no sender, subject or recipient. Storing them would make Breeze a mail-content processor.
- Drill-down links out to the vendor console.
- Adapters must never log raw vendor responses.

**Late corrections.** Vendors revise recent counts, so each sync re-fetches the last 3 days and upserts them.

**The M365 adapter (Defender for Office 365), if chosen (Decision 3).**
- **Reuse the org-bound M365 connection.** Do not add a second credential.
- **Consent.** The adapter needs the `ThreatHunting.Read.All` application permission. The consent upgrade must
  be optional, and it must not interrupt existing reads for a tenant that has not re-consented. That tenant's
  source status is `consent_missing`.
- **Licence.** Counts come from advanced hunting over `EmailEvents`, which needs a Defender for Office 365
  Plan 2 or E5-class licence. A tenant that has only Exchange Online Protection is `not_licensed`. *inferred,
  not checked against a live tenant*
- **Executor change.**
  - Advanced hunting is a POST (`runHuntingQuery`), so the GET-only read executor gets one new action.
  - That action takes **only fixed, server-defined aggregate queries**. It accepts no caller-supplied KQL.
  - It returns count-only output and logs no raw results.

**Sync.** A BullMQ job modelled on `jobs/backupProviderSync.ts`, registered in `jobs/scheduleRegistry.ts`.

**Portal.** A new flag, `portal_branding.enable_email_security`.

#### 3.3.5 Recommendations: declarative rules, materialized hourly

**One concept, one home.** A second recommendations engine next to `/security/recommendations` would produce
two lists that disagree. Instead, the design has five parts.

**1. A declarative catalog, `RECOMMENDATION_RULES`,** in `packages/shared/src/recommendations/rules.ts`. It has
the same discipline as `TRUST_CONTROL_CATALOG`: a versioned constant, pure data, no functions.

```ts
interface RecommendationRule {
  id: RecommendationRuleId;            // BE-9 ids kept: rec-enable-av, rec-patch-compliance, …
  version: number;                     // bump on semantic change ⇒ a new episode (see 4)
  domain: DisclosureDomain;            // drives permission and portal-flag gating of the rule's inputs
  category: 'identity' | 'patching' | 'endpoint' | 'backup' | 'network' | 'monitoring';
  metric: RecommendationMetricId;      // a TelemetryControlId, or an extra metric (§3.6)
  fires: { when: 'affected_gt' | 'below_pct' | 'is_false'; threshold: number };
  severity: { critical?: Threshold; high?: Threshold; default: 'medium' | 'low' };
  requires?: CapabilityKey[];          // unmet ⇒ not_assessed, never fired or clear
  fix: FixLinkKey;                     // §3.4
  titleKey: string; bodyKey: string;   // i18n; the body interpolates {affected} and {eligible}
}
```

**Rule semantics: operational, not trust-page thresholds.** This was corrected in review: BE-9 fires on any
affected device, while a trust control can be "met" at 95 %.
- A recommendation fires when work exists. The default is `affected_gt: 0`.
- Severity scales with the percentage.
- The trust/posture pill keeps its own thresholds.
- The two share **evidence** and the "not assessed" rules (coverage floor, evidence age). They do not share
  pass thresholds, so "Disk encryption: met (96 %)" and "Encrypt 3 devices" can both be true, and the copy
  says so.

**2. One pure evaluator,** `evaluateRecommendations(evidence, rules, asOf)`, in `packages/shared`. For each
rule it returns `{ruleId, version, status: fired | clear | not_assessed, severity, affected, eligible, percent,
evidenceAsOf, affectedDeviceIds?}`.
- Its input is `PostureEvidence` plus the `trustOnlyEvidence` MFA-enforcement overlay plus the extra metrics.

**3. Materialized hourly, not computed on read.** This was corrected in review: `loadPostureEvidence` loads every
device-patch row and the CIS history, reduces them in memory, and opens a nested DB context
(`postureEvidence.ts:528, :588`). It is too heavy to run on every page view. *reported*
- The design adds a new **fleet-findings kind**, `posture_recommendation`. Its `semantic_key` is the rule id
  and its `algorithm_version` is the rule version (`schema/fleetFindings.ts`).
- An hourly job evaluates each org and reconciles the results through the existing
  `services/fleetFindings/reconcile.ts`. A firing rule opens or updates a live episode. A clear rule resolves
  it.
- Rules about devices write membership to `fleet_finding_devices`. A site-restricted reader then gets counts for
  only their sites, using a membership join at read time.
- Rules about the whole org (the M365 MFA rules) have no device membership and are not site-filtered.
- The read path only reads the findings tables. **No new table.** `fleet_findings` is already registered for
  cascade, merge and export.
- This kind **must not** be gated by the per-org `fleet.findings.enabled` flag (#3303). The producer runs on its
  own hourly cadence, not in the 10-minute findings cycle.

**4. Lifecycle, made durable.** Today's BE-9 state lives in `audit_logs`. Audit retention can delete that state
(`jobs/auditRetention.ts`). Today's state also has no snooze, and a dismissal would survive a change to the
rule's meaning. *reported* In the new design:
- Dismiss, acknowledge and resolve use the `fleet_findings.status` lifecycle.
- A **new rule version is a new episode**, so an old dismissal does not carry over to a changed rule.
- When a rule clears, the episode is resolved. If it fires again, a new episode opens. This replaces BE-9's
  "completion reopens on newer evidence" behaviour.
- **Snooze** is an addition: `snoozed_until`, as an open decision for the plan, because `fleet_findings` has no
  such column today.
- A one-time migration carries over the BE-9 audit-log statuses that are still live, as dismissed or
  acknowledged episodes at the current rule version.

**5. Re-point the existing consumers, then delete the old builder.**
- `/security/recommendations`, `manage_security_recommendations`
  (`services/aiToolsSecurityRecommendations.ts`) and the org panel all read the materialized findings.
- `buildBe9Recommendations` is deleted once parity tests pass.
- **The portal action-items tile is not re-pointed.** It counts other work (fleet findings and remediation
  suggestions), and that stays.
- The tile's fleet-findings count must **exclude** `posture_recommendation`, so the new kind does not inflate
  it. The portal gets recommendations through the Recommendations panel (§3.5) instead.

**Initial rules.** These include every BE-9 rule.

| Rule | Metric | Fix link |
|---|---|---|
| Users without MFA registered | `mfa_registered_m365` (NULL means unknown, never false) | Decision 8 |
| Admins without MFA | `m365_posture_rollups.admins_without_mfa` | Decision 8 |
| MFA not enforced by Conditional Access | `mfa_enforced_m365` (the trust-only overlay) | Decision 8 |
| Devices missing updates | `os_patch_currency` | `/patches#compliance&status=needs-patches` |
| AV / EDR missing or definitions stale | `endpoint_protection`, `edr_coverage`, `definitions_current` | `/security/antivirus`, the EDR coverage view |
| Disk encryption off | `disk_encryption` | `/security/encryption` |
| Firewall off | `host_firewall` | `/security/firewall` |
| Weak password policy *(BE-9)* | `password_policy` | `/security/password-policy` |
| Excess local admins *(BE-9)* | `least_privilege` | `/security/admin-audit` |
| Active threats *(BE-9)* | open detections (§3.3.2) | the incidents feed |
| Backups failing or unverified | `backups_verified` + §3.3.1 affected devices | `/backup` health view |
| Hardening baseline below target | `hardening_baseline` | the CIS baselines page |
| Devices not checking in | `continuous_monitoring` | `/devices`, offline filter |
| **Assets not monitored** (the "79 % monitored" headline) | new `asset_monitoring_coverage` (§3.6) | `/discovery#assets`, unmanaged filter |
| **Unapproved devices on the network** | new `unapproved_network_assets` (§3.6) | `/discovery#assets`, pending-approval filter |

**Disclosure gating applies to inputs, not just cards.**
- A rule whose `domain` is disabled for the viewer is **excluded from the list and from every total**. For the
  portal, disabled means its portal flag is off. For staff, it means a permission is missing.
- Otherwise a portal with backups hidden would still say "2 backups failing" through Recommendations.
- So staff and portal counts can differ for the same org, and tests assert that.

**Portal copy.**
- Each row shows the rule title and the affected count.
- It shows **no fix links**, because portal users cannot run the workflows.
- It never says "your IT provider has been notified". Nothing sends that notification.

### 3.4 Fix links: a registry, not strings

Every `primaryLink` and every rule `fix` is a `FixLinkKey`. The **web app** resolves it, using a registry that
extends `apps/web/src/components/dashboard/dashboardLinks.ts` (`DASHBOARD_METRICS`, and `metricHref` at :360).
*verified*
- Each href is built with the destination page's own hash encoder (`patchesHash.ts`, `alertsHash.ts`,
  `threatsHash.ts`, …).
- Each link is gated on the Sidebar's visibility rule for its destination.
- The org is handed off the way the dashboard click-through spec decided
  (`2026-10-18-dashboard-clickthrough-and-sites-visibility-spec.md`).
- The API returns keys, never URLs.
- A contract test asserts that every rule `fix` key and every panel link key resolves.

### 3.5 UI surfaces

**Web: the org record page Overview tab.** The goal is one screen, so the panels replace content instead of
being added on top of it.
- A **Status** grid at the top of `OrgOverviewTab.tsx`, with four cards: Backups, Email security, Network, and
  Investigation & response.
- Each card shows:
  - a state pill
  - a headline number
  - at most four supporting facts
  - per-source "as of"
  - one primary link
- **Recommendations** spans the full width below the cards:
  - It shows the **top 5** fired rules by severity, each with its affected count and a "Fix" button.
  - Below them is "Show all (N)" and a collapsed "N passing · M not assessed" line.
- The existing **fleet-stats block is removed.** The panels and the page header supersede it.
- **Critical alerts and recent activity** move below the fold, collapsed by default.
- Account facts and key dates move to a compact side column.
- Hash state: Overview stays `#overview`. An expanded panel or the full recommendations list uses
  `#overview/<panelKey>`.
- Cards are fixed. The unused `DashboardCustomizer.tsx` and `/analytics/dashboards` system is not revived.
- Decision 2 chooses between this placement and a new tab.

**Portal: the dashboard.**
- The same panels appear as tiles in `DashboardTiles.tsx`, using the portal projections.
- The existing `backup` tile is **replaced** by the Backups panel, not duplicated.
- The API enforces each tile's gates in `PORTAL_SECTION_GATES` (`routes/portal/featureFlags.ts:256`). The page
  enforces them in `lib/visibilityGate.ts`.

| Panel | Portal flags (all must be on) | New? |
|---|---|---|
| Backups | `enableBackups` | existing |
| Investigation & response | `enableSecurity` (+ `enableEdrVisibility` for vendor legs) | existing |
| Network | Decision 7 | — |
| Email security | `enableEmailSecurity` | **new** |
| Recommendations | `enableRecommendations` | **new**. There is no existing action-items flag to reuse. |

**Portal preview.** The MSP's preview (`GET /orgs/organizations/:id/portal-preview`) does **not** pick up the
new tiles automatically. Its runners and allowlist (`services/portal/portalPreview.ts:94`) must be extended in
the same wave. *reported*

**i18n.** All new copy goes into all 8 locales.

### 3.6 New metrics and capability keys

**`asset_monitoring_coverage`** = monitored ÷ eligible.
- Eligible assets: non-dismissed `discovered_assets` seen within the last 30 days.
- Monitored assets: `linked_device_id IS NOT NULL`, or the asset is the target of an active network monitor or
  SNMP device.
- An org that has never run a discovery scan is `not_assessed`, never 100 %.
- Decision 9 decides the exact definition.

**`unapproved_network_assets`**: non-dismissed assets seen within the last 7 days whose `approval_status` is
pending or unapproved.
- This is the author's reading of "network-access non-compliance". Breeze has no NAC or 802.1X data.
  *inferred.* Confirm it with the design partner, or drop the rule.

**Capability keys:** `m365_connected`, `discovery_run`, `unifi_connected`, `edr_connected`,
`backup_configured`, `email_security_connected`. This was corrected in review: `edr_tenants` has a
**partner-only** SELECT policy and carries installer secrets. The portal context and org-scope tokens cannot,
and must not, read it.
- Each capability check reads only **org-scoped, credential-free** tables: `edr_endpoints`/`edr_detections`,
  `unifi_site_mappings`, `m365_*` sync state, `email_security_daily_stats`, and an org-scoped
  `email_security_sync_status` row.
- No check may widen access to tenant or connection rows.

### 3.7 AI tools

`manage_security_recommendations` is re-pointed (§3.3.5). There is no new AI tool in v1. A follow-up
`get_customer_status` tool would return the panel envelopes. It would need TOOL_TIERS and Wisp subject
classification.

---

## 4. Tenancy & data-model impact

**No new table** is needed for the panel registry, the response-actions union, or the recommendations, which
reuse `fleet_findings` and `fleet_finding_devices`. Reads run in the caller's DB context, one transaction per
panel (§3.1).

**New `fleet_findings` kind, `posture_recommendation` (W2).**
- Tenancy: existing tables, shape 1.
- Registration: none new. Add the kind to `FleetFindingKind` and the producer registry.
- If the plan adds `snoozed_until`, that is a column on an org-cascade table, so it needs a
  `CORE_TENANT_EXPORT_POLICY` classification (`included`).

**New `portal_branding` columns `enable_email_security`, `enable_recommendations` (and Decision 7's flag).**
- Tenancy: an existing org table (`org_id` unique). Its merge policy is `keep-survivor` (`orgMergeRegistry.ts:552`).
  *verified*
- Registration: these are ADD COLUMNs on an org-cascade table, so each needs a `CORE_TENANT_EXPORT_POLICY`
  classification (`included`). Also add them to `PORTAL_VISIBILITY_FLAG_KEYS` (`services/portal/portalFlags.ts:11`),
  `PORTAL_SECTION_GATES`, and the preview allowlist.

**New table `unifi_wan_rate_buckets` (network v2).**
- Tenancy: shape 1, `org_id NOT NULL`. It is data, not config, like `unifi_clients`.
- Registration:
  - RLS in the migration that creates the table.
  - `CORE_ORG_CASCADE_DELETE_ORDER`.
  - `orgMergeRegistry.ts`, in the same policy list as `unifi_clients` and `unifi_device_telemetry`
    (`orgMergeRegistry.ts:1398-1401`). *verified* The unique key includes `collector_id`, so rows cannot collide
    on merge.
  - Export policy: all columns are scalar, so `included`.
- FKs: any composite `(site_id, org_id)` FK is `DEFERRABLE INITIALLY IMMEDIATE`.
- There is no `device_id`, so no device lists apply.
- Remap: history stays with the source org (§3.3.3).

**New table `email_security_connections` (email waves).**
- Tenancy: shape 3, partner-axis (`partner_id NOT NULL`), like `edr_connections`.
- Registration: `PARTNER_TENANT_TABLES`. Credentials are encrypted with the existing secret helper and never
  returned.

**New table `email_security_tenants` (email waves).**
- Tenancy: partner-axis with a nullable `org_id` mapping, like `edr_tenants` (`schema/edrProviders.ts:128`).
- Registration: cascade, merge and export, exactly as `edr_tenants` is registered (`tenantCascade.ts:672-681`).
  *verified (presence)*
- Remap: re-mapping a tenant to another org **does not move existing stats**. History stays with the source
  org, the same as the EDR mapping (`edrProviders/mapping.ts:136`). *reported*

**New table `email_security_daily_stats` (email waves).**
- Tenancy: shape 1, `org_id NOT NULL` plus `partner_id`, like `edr_detections`. Unique on `(tenant_id, day)`.
- Registration: RLS, cascade, merge (`repoint`), and export (`included`). If the plan adds a raw jsonb column,
  it is `excludedOpen`.

**New table `email_security_sync_status` (email waves).**
- Tenancy: shape 1. One row per org per provider, recording `connection` state and last sync. It is
  credential-free.
- Registration: RLS, cascade, merge, export. This table is the portal-safe capability read.

**Why there is no partner-wide config table.** v1 has no rule configuration. If Decision 6 adds per-partner rule
overrides, that table **must** be `org_id` XOR `partner_id` (epic #2135) with the SELECT-only partner read
branch. Its settings home would be Security → Recommendations (partner default → org override).

**Settings Rule 9 counts.**
- Recommendation thresholds: configured in 0 places today (hard-coded), and 0 after v1.
- "Portal shows email security" and "portal shows recommendations": 0 places before, 1 place after each. That
  place is the existing org portal settings screen (`/orgs/organizations/:id/portal-settings`,
  `OrgBrandingEditor.tsx`).

---

## 5. Out of scope

- A partner-wide "all customers" status grid.
- User-arrangeable dashboards.
- Storing email message metadata, or email quarantine release actions.
- DPI or application-level traffic, NetFlow or sFlow, and UniFi per-port rates (#7271).
- NAC or 802.1X enforcement.
- New EDR vendor integrations.
- The `/partner/dashboard` hard-coded counts (§1.2).
- Scheduled or PDF delivery of the screen.

---

## 6. Open Decisions

1. **Composite endpoint, or one endpoint per panel?**
   - (a) One `status-panels` read over a provider registry, with one transaction per panel, a statement timeout,
     and a concurrency cap.
   - (b) Five endpoints, with each card fetching its own data.
   - *Recommend (a).* It gives one place that evaluates permissions and flags, and one round trip. Once panels
     have separate transactions, (b)'s only remaining advantage is HTTP-level caching per panel. *The reviewer
     agreed with (a), provided transactions are isolated per panel, which is now specified.*

2. **Where does the screen live in web?**
   - (a) It replaces the top of the org record Overview tab, and the same component appears on `/` for
     org-scope users.
   - (b) A new "Status" tab.
   - (c) The org record page only.
   - *Recommend (a).* The ask is "one glance per customer". Org-scope deployments never reach
     `/organizations/:id`.

3. **Which email-security adapter comes first?**
   - (a) M365 Defender for Office 365, through advanced hunting. This needs a consent upgrade and an executor
     POST action. EOP-only tenants report nothing.
   - (b) The third-party gateway the design partner uses.
   - (c) Both, in parallel waves.
   - *Recommend (b) first, then (a).* A gateway API gives clean counts for every customer of that MSP. (a)
     carries a consent and executor blast radius across every connected tenant. Prove (a)'s licence gate in a
     lab tenant before committing to it.

4. **Where do recommendations and response actions live?**
   - (a) Recommendations materialized hourly as a `fleet_findings` kind, with response actions computed on read.
   - (b) Both computed on read, with targeted aggregate queries instead of `loadPostureEvidence`.
   - (c) A new `recommendations` table.
   - *Recommend (a).* It reuses the lifecycle, the device membership needed for site restriction, and the
     existing cascade registration. It also fixes the audit-log state store. The cost is up to one hour of
     latency after a fix. A "Re-check now" button on the panel would enqueue that org's evaluation. *The draft
     recommended computing on read; the reviewer showed the cost, and the author changed position.*

5. **Where does "top talkers" come from?**
   - (a) The agent polls the classic UniFi controller statistics locally, using cumulative per-client counters
     with the §3.3.3 checkpoint rules.
   - (b) Managed endpoints ranked by `device_metrics` bandwidth, labelled "managed devices, all interfaces".
   - (c) Defer top talkers. Ship WAN health (v1) and gateway throughput (v2).
   - *Recommend (c) now, and (a) when a design partner provides a lab controller.* (b) answers a different
     question and would be read as WAN use. (a) is agent-shipped code against an unversioned controller API.

6. **Per-partner rule configuration?**
   - (a) None in v1.
   - (b) An override table now.
   - *Recommend (a).* If configuration is added later, it is `org_id` XOR `partner_id`.

7. **Which portal flag gates network traffic?**
   - (a) Reuse `enableNetworkVisibility`.
   - (b) A new `enableNetworkTraffic` flag.
   - *Recommend (b).* The existing flag means "the customer can browse discovered assets". WAN health and
     throughput are a different disclosure.

8. **What do the MFA recommendations link to?** *(Open disagreement.)*
   - (a) `/integrations#m365`.
   - (b) Build an M365 users list page, filterable by MFA state, as a wave of this feature.
   - (c) Link out to the tenant's Entra admin page for the user list, and defer (b).
   - *The author recommends (b).* A recommendation that lands on a connection page does not satisfy "link to the
     fixing workflow", and `m365_users` already has the data.
   - *The reviewer recommends (c).* A list page alone is not remediation. The fix (registering MFA, or a
     Conditional Access policy) happens in Entra.
   - Both agree that (a) is not enough.

9. **What counts as a "monitored asset"?**
   - (a) Linked to an agent only.
   - (b) Linked to an agent, or covered by a network monitor or SNMP device.
   - (c) (b), and also remove asset types an agent cannot run on from the denominator.
   - *Recommend (b).* (c) hides gaps.

---

## 7. Test & rollout notes

**Waves.** This is a sketch; the plan decides.

**W1: registry, envelope, web endpoint, Overview rework, and the Backups and IR panels.** Email and Network
appear as `not_configured`.
- Includes the backup and security-events read-model extractions.
- Read-only. The extractions are refactors of live endpoints, so their numbers must not move.

**W2: recommendations.**
- The `RECOMMENDATION_RULES` catalog and its evaluator.
- The extra metrics.
- The `posture_recommendation` producer and its hourly job.
- The fix-link registry.
- The BE-9 status migration.
- Re-pointing `/security/recommendations` and the AI tool.
- Deleting `buildBe9Recommendations`.
- Risk: a data migration from audit logs into `fleet_findings`.

**W3: portal.** `/portal/status-panels`, the tiles and projections, the new flags, and the preview allowlist.
- Risk: a migration (flag columns).

**W4: network v1 (WAN health).** Read-only.

**W5: network v2.** Gateway `statistics/latest` in the agent collector, `unifi_wan_rate_buckets`, and pruning.
- Risk: **agent code and a new org table.**

**W6: the email-security provider family.** Schema, registry, sync job, connection UI, and the first adapter.
- Risk: **new tables and credentials.**

**W7: the second email adapter (Decision 3) and the MFA fix target (Decision 8).**
- Risk: M365 consent, if (a).

**Acceptance tests:**
- **Isolation:** one panel's SQL error or statement timeout yields `unavailable`, and the other panels still
  return. A test must prove that a failed transaction does not abort its siblings.
- **Authorization:**
  - A site-restricted technician sees only their sites' counts in every panel and in recommendation totals.
  - A missing permission omits the panel.
  - A disabled portal flag removes the panel **and** its domain's recommendations and totals.
- **No data is never healthy:** table tests for every panel covering not connected, consent missing, not
  licensed, sync failed, no data, and stale-one-of-two-sources.
- **Recommendations:**
  - The evaluator is pure, with table tests per rule.
  - A **parity test** shows that the catalog fires every BE-9 rule id that `buildBe9Recommendations` fires on
    the same fixtures.
  - Lifecycle tests: dismiss persists for the live episode, a version bump opens a new episode, and
    clear-then-fire opens a new episode.
  - The migrated BE-9 statuses survive.
  - Every `fix` key resolves.
- **Response actions:** an isolation that references an incident action counts once, an accepted EDR action is
  not shown as succeeded, and a reversal nets out.
- **Ingest:**
  - Replaying the same batch twice leaves the buckets unchanged.
  - Out-of-order samples are dropped.
  - Hour-boundary splitting works, if (5a) is chosen.
  - After a collector org remap, history stays and new rows go to the new org.
- **Email:**
  - A `null` category renders "—".
  - An overlapping-category adapter shows no total.
  - A re-fetched day is upserted, not added to.
  - A tenant remap leaves history with the source org.
- **Web:** `data-testid` on every panel and recommendation row. The dismiss and acknowledge buttons go through
  `runAction`.

**CI traps:**
- The new org tables (W5, W6) and the `portal_branding` flag columns (W3) fail cascade and export-policy checks
  only under **Integration Tests**. `pnpm test` does not run `tenantCascade`, `tenant-export-policy`,
  `orgMergeRegistry` or `rls-coverage` integration suites. Run them locally.
- `orgMerge.test.ts` goes red only in the full unit suite.
- Stacked wave PRs run no CI. Use `gh workflow run CI --ref <branch>`.
- New `apps/api/src/services/*` files must be classified for the parked-fanout and area-gating contract tests.
- Migration names must sort after the newest committed migration (currently `2027-01-20-*`). Any migration that
  writes rows (the BE-9 status carry-over) first does `SELECT set_config('breeze.scope', 'system', true)`.

---

## 8. Quorum record

The reviewer's corrections, each re-checked by the author against `36f9d9ca53`:

1. **UniFi has no per-client throughput, and the collector does not fill the byte columns.**
   *verified* at `agent/internal/unifi/client.go:43-50, 84-110`. The network panel moved from "partial" to "WAN
   health only".
2. **`mfa_enforced_m365` is not in `loadPostureEvidence`.** *verified* at `trustOnlyEvidence.ts:1`.
3. **Portal action items are fleet findings plus suggestions, and have no flag.** *verified* at
   `actionItemsReadModel.ts:9-25`.
4. **The two detection readers merge different populations.** *reported*. Folded in as an explicit population
   parameter.
5. **`edr_tenants` is partner-only on SELECT.** *reported*. Capability checks now read only org-scoped,
   credential-free tables.
6. **Portal preview needs explicit runner and allowlist changes.** *reported*.
7. **The portal precedent uses `Promise.all` in one transaction.** *reported*. The design now uses one
   transaction per panel with a statement timeout.

Risks the reviewer raised that are now designed in:
- `loadPostureEvidence` is too heavy for the read path (Decision 4 changed).
- BE-9 and trust thresholds are different semantics.
- The recommendations lifecycle needs to be durable, and audit retention deletes state.
- Disclosure gating must apply to recommendation inputs.
- Response-action outcome fidelity, and double-counting.
- Counter-diff correctness.
- Ownership on remap.
- M365 consent and a count-only, fixed-query executor action.
- Source-level freshness.
- The one-screen layout: replace content, don't add on top of it.
- Removing the "IT provider notified" copy.

Still disagreed: Decision 8.
