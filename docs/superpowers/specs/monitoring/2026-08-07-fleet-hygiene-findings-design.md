# Fleet Hygiene — Findings Feed + Aggregate Remediation (v1 Design)

- **Date:** 2026-08-07
- **Status:** Approved design
- **Branch:** `ToddHebebrand/Fleet-aggregate-remediation`
- **Author:** Todd Hebebrand (design dialogue with Fable; storage architecture confirmed by Codex advisor quorum)

## 1. Product intent

Move Breeze's flagship monitoring workflow from reactive alert-catching to proactive fleet hygiene: surface systemic defects org- and partner-wide (anomalies, cross-device error patterns, chronic low-reliability devices), and remediate them **in aggregate from one place** instead of device by device. Alerts remain; this is the sweep that keeps the fleet clean between alerts.

v1 is a **deterministic findings feed with human-driven bulk remediation**. AI assists (reads the feed, aggregates fleet metrics) but does not generate or execute fixes.

## 2. Scope

**In v1:**

1. Materialized `fleet_findings` produced from three shipped sources: metric anomalies, log correlations, reliability scores.
2. Partner-wide findings feed on the evolved `/fleet` page, with finding lifecycle (open → acknowledged/dismissed/resolved).
3. "Remediate across N devices": fix picker (script or command preset) fanning out through the **existing** per-device command/deployment chokepoints — approval, site-scope, MFA, and audit rails preserved. A durable remediation-run ledger links finding → execution → per-device outcome.
4. Two read-only AI tools: `get_fleet_findings`, `analyze_fleet_metrics`.

**Explicitly out of scope (v2+):**

- Multi-device remediation *suggestions*. The shipped `remediation_suggestions.targetDeviceIds` array is NOT the path: its approval/execution endpoints require exactly one target (`routes/remediationSuggestions.ts` single-target checks) and the array has no per-member FK or same-org guarantee. Multi-device suggestions need an endpoint redesign; deferred.
- BE-10 peer-group / fleet-pattern anomaly detectors (would feed this same findings table).
- Patch-compliance findings (overlaps existing patch views).
- Cross-tenant intelligence (per ML roadmap: intra-tenant only until a dedicated privacy architecture exists).
- Vulnerability findings (already served by the fleet vuln triage UI).

## 3. Architecture decision: materialized findings

**Decision:** materialize findings (Option A) with deterministic semantic keys borrowed from the hybrid option. Confirmed independently by Codex (xhigh, read-only) — both advisors converged.

- Virtual/computed feeds were rejected: partner-wide aggregation on every page view, unstable hash identity when device sets change, and no natural home for dismiss/resolve state or remediation-run linkage.
- Repo precedent: `log_correlations` is already a materialized cross-device grouping with lifecycle (`active/resolved/ignored`, `affectedDevices`).

## 4. Schema (4 new tables, all tenancy shape 1: direct `org_id`)

All rows are **org-owned** (the device's org). Partner-wide reads use the standard partner-scope path over `accessibleOrgIds` — no dual-ownership: findings are derived data, not config, so the partner-wide-first rule for config tables does not apply.

### 4.1 `fleet_findings`

| Column | Notes |
|---|---|
| `id` uuid PK | |
| `org_id` uuid NOT NULL → organizations | |
| `kind` text | `metric_anomaly_pattern` \| `log_correlation` \| `reliability_offenders` |
| `semantic_key` text | deterministic grouping identity (see §5 per-kind definitions) |
| `algorithm_version` integer | bump to re-key without colliding with old episodes |
| `status` | `open` \| `acknowledged` \| `dismissed` \| `resolved` |
| `severity` | `info` \| `warning` \| `error` \| `critical` |
| `title`, `summary` | human strings rendered in feed |
| `evidence` jsonb | **bounded** roll-up (sample refs, per-metric stats); export bucket `excludedOpen` |
| `device_count` integer | denormalized member count |
| `revision` bigint | bumped on membership/evidence change; runs snapshot it |
| `first_seen_at`, `last_seen_at`, `last_reconciled_at` | |
| `acknowledged_at/by`, `dismissed_at/by`, `resolved_at`, `resolution_reason` | lifecycle audit |

Constraints/indexes:
- `UNIQUE (id, org_id)` — enables same-org composite FKs from children.
- **Partial unique** `(org_id, kind, semantic_key, algorithm_version) WHERE resolved_at IS NULL` — one live episode per problem; recurrence after resolution opens a new episode.
- Feed index `(org_id, status, severity, last_seen_at DESC)`.

### 4.2 `fleet_finding_devices` (current membership — reconciled, prunable)

`(finding_id, device_id)` PK, `org_id`, source ref (`source_kind`, `source_row_id`), `member_evidence` jsonb (excludedOpen), `first_seen_at`/`last_seen_at`. **Single-column FK** `finding_id → fleet_findings(id)` `ON DELETE CASCADE` — deliberately NOT a same-org composite FK: membership keeps the standard `device_id` column name, so the device-move trigger (§4.4) rewrites this table's `org_id` on a cross-org move, and a composite `(finding_id, org_id)` FK would break mid-move. The transient mismatch (member re-tenanted, finding still in the old org) is resolved by the next reconcile pass, which prunes the member.

**Reconciliation MUST delete members that cease qualifying.** The existing alert-group upsert pattern only inserts/updates — copying it verbatim would strand stale devices.

### 4.3 `fleet_remediation_runs`

`id`, `org_id`, `finding_id` (+`finding_revision` snapshot), `action_kind` (`script` \| `command`), action reference + **immutable parameter snapshot** jsonb (excludedOpen), `status` (`queued/running/partial/succeeded/failed/cancelled`), `target_count`/`succeeded_count`/`failed_count`/`skipped_count`, `created_by`, timestamps. Composite FK to findings. **No reverse `fleet_findings.current_run_id`** — an FK cycle breaks tenant erasure ordering.

### 4.4 `fleet_remediation_run_targets`

`(run_id, target_device_uuid)` PK, `org_id`, **snapshot identity** (device uuid + hostname/site captured at dispatch), per-target `status`, link to the underlying execution row (`device_command_id` — v1 dispatches exclusively via the command chokepoint; scripts run as `execute_script` commands, so there is no deployment linkage), bounded error/result summary, timestamps.

**Why snapshot, not a live `device_id` FK column:** the migration `2026-05-18-device-child-orgid-cascade.sql` installs a trigger that rewrites `org_id` on every table with uuid columns literally named `device_id` + `org_id` when a device moves orgs. Rewriting a historical run target's org would break the same-org composite FK to its run. The column is therefore named `target_device_uuid` (no FK, exempt from the trigger), preserving the historical record; the run row records the org it executed under, forever.

### 4.5 Registration checklist (same PR as the migration)

- RLS: enable + force + policies in the creating migration. Shape 1 is auto-discovered by `rls-coverage.integration.test.ts` — no allowlist entry.
- `CORE_ORG_CASCADE_DELETE_ORDER` (`services/tenantCascade.ts`): all four tables, alphabetical. FK-direction check: `fleet_finding_devices` and `fleet_remediation_runs` sort before `fleet_findings` ✓, but `fleet_remediation_run_targets` sorts *after* `fleet_remediation_runs`, which it references — therefore the targets→runs FK is declared `ON DELETE CASCADE` so alphabetical order remains valid; `tenantCascade.integration.test.ts` asserts this.
- `fleet_finding_devices` HAS a live `device_id` + denormalized `org_id` → register in `CORE_DEVICE_CASCADE_DELETE_TABLES` **and** `CORE_DEVICE_ORG_DENORMALIZED_TABLES` (`routes/devices/core.ts`). `fleet_remediation_run_targets` joins neither list (`target_device_uuid` snapshot, trigger-exempt).
- `CORE_TENANT_EXPORT_POLICY`: every column classified; all jsonb → `excludedOpen`.
- Verify as `breeze_app` with a forged cross-tenant insert.

## 5. Finding producers (BullMQ)

One repeatable scan job fans out per-org grouping jobs (mirror the `metricRollups` scan-orgs pattern; worker concurrency 2). Gated by a per-org feature flag `fleet.findings.enabled` (default on; plain org-settings flag — the producers are deterministic grouping, not ML, so they do not ride `mlFeatureFlags`, but the underlying anomaly/reliability sources remain governed by their own ML flags).

Per-kind grouping + `semantic_key`:

1. **`metric_anomaly_pattern`** — open `metric_anomalies` grouped by `(metric_name, anomaly_type)` within an org, minimum 2 devices. Key: `metric:<metric_name>:<anomaly_type>`. Severity from max anomaly score. Evidence: per-device observed/baseline stats (bounded to N=20 samples).
2. **`log_correlation`** — active `log_correlations` rows adopted 1:1. Key: `logcorr:<rule_id>`. Severity mapped from the rule's severity. Membership from `affectedDevices`.
3. **`reliability_offenders`** — one rolling finding per org: devices with reliability score below threshold (default < 50, band-aligned). Key: `reliability:offenders`. Severity by worst band present.

Reconciliation on every pass: upsert episode by semantic key; sync membership (insert new, prune non-qualifying, bump `revision` and `last_seen_at` on change); auto-resolve (`resolution_reason = 'source_cleared'`) when membership drops below the kind's minimum or all source rows resolve. Dismissed findings stay dismissed while the episode lives; a *new* episode (post-resolution recurrence) reopens visibly.

Rules: exclude Quick Support / ephemeral devices (match anomaly/reliability workers). Producers run under `withSystemDbAccessContext` (after `runOutsideDbContext` if ever invoked from a request path) and never hold a DB transaction across Redis/queue work.

## 6. API (`routes/fleet/findings.ts`, mounted under `/fleet`)

| Route | Behavior |
|---|---|
| `GET /fleet/findings` | Partner-wide list across `accessibleOrgIds`; filters: org, kind, severity, status; sort by severity/last_seen. **Site scoping is app-layer**: RLS covers orgs only, so member counts/previews must filter by `allowedSiteIds` before returning. |
| `GET /fleet/findings/:id` | Detail + membership page (site-filtered). |
| `PATCH /fleet/findings/:id` | Lifecycle: acknowledge / dismiss (+notes) / reopen. Audit-logged. |
| `POST /fleet/findings/:id/remediate` | Body: action (scriptId + params, or command preset), optional device subset. Creates run + immutable target snapshots. |
| `GET /fleet/findings/:id/runs`, `GET /fleet/remediation-runs/:runId` | Run progress with per-target status. |

Dispatch semantics for `remediate`:
- **Re-validate every target under the caller's live access at dispatch time** (org + site scope + device not decommissioned). Finding membership is *not* mutation authority.
- Fan out through the existing per-device chokepoints (`queueCommandForExecution` / script execution path) so approval, MFA, PAM, and audit all apply unchanged. No new execution path.
- Chunk per-org, ≤500 devices per batch (existing bulk cap), asynchronously via a BullMQ dispatch job; the run ledger is the single durable record.
- Per-target outcomes update from command/deployment completion (reuse the same completion signals the bulk-commands UI polls); run status derives from target counts (`partial` when mixed).

## 7. Web (`/fleet` page evolution)

`FleetOrchestrationPage.tsx` becomes the hygiene cockpit:

- **Findings feed** front and center: severity icon, kind badge, title, org badge, "N devices", age, status. Filters (org/kind/severity/status) + tab-style status toggle. Existing stat cards demoted to a compact summary strip above the feed. Partial endpoint failure stays honest (existing `failedEndpoints` pattern).
- **Detail drawer**: summary, evidence, member device list (links to device pages), lifecycle actions, run history.
- **Fix picker modal**: choose action — script from the script library (with param form) or command preset (restart service, clear temp/disk cleanup, reboot, etc.) → review target list (deselect devices) → confirm → live run progress with per-device outcomes and bounded failure summaries (reuse bulk-action progress patterns from `DevicesPage`).
- All mutations wrapped in `runAction`; selected finding via `window.location.hash`.
- "Ask AI" on a finding opens the AI sidebar seeded with the finding context (tools below make this real).

## 8. AI tools (read-only, Tier-1)

1. **`get_fleet_findings`** (`aiToolsFleet.ts`) — query the feed (filters mirror the API; same app-layer site scoping). Lets chat answer "what's unhealthy across my fleet right now?"
2. **`analyze_fleet_metrics`** (`aiToolsPerformance.ts`) — org/fleet-scoped aggregation over `metric_rollups` via the existing `(org_id, bucket_seconds, bucket_start)` index: top-N devices by CPU/mem/disk, fleet percentiles, growth outliers. Closes the "AI can only analyze one device's metrics" gap.

No AI execution changes in v1 (`run_script`'s 10-device cap untouched).

## 9. Error handling

- Producers: per-org job isolation (one org failing doesn't stop the scan); idempotent upserts keyed on semantic key; bounded evidence so a pathological org can't bloat rows.
- Dispatch: target re-validation failures mark targets `skipped` with reason (never silently dropped); command queue failures mark `failed`; run completes `partial` rather than hanging.
- Feed: per-source degradation surfaces as a banner (consistent with existing fleet page).

## 10. Testing

- **Unit:** each grouper (grouping, severity mapping, semantic keys), reconciliation (prune, auto-resolve, dismissed-stays-dismissed, episode reopen), dispatch chunking + re-validation, both AI tools (Drizzle mock pattern per `breeze-testing`).
- **Contract (Integration Tests job — run locally before PR):** RLS coverage auto-discovers the four tables; `tenantCascade.integration.test.ts` for cascade order incl. the runs/targets FK-direction check; export-policy suites for every new column.
- **Integration:** one end-to-end proving (a) partner token sees findings across two orgs, org token sees only its own, (b) site-scoped token gets filtered membership, (c) a remediation run dispatches through the real command chokepoint against Postgres.
- **Web:** feed rendering incl. partial-failure, lifecycle actions, fix-picker flow (jsdom); `no-silent-mutations` compliance.

## 11. Rollout

Single stacked-PR sequence on this branch (remember: stacked PRs get no CI — dispatch `gh workflow run CI --ref <branch>` per branch): (1) schema + migration + registrations, (2) producers + reconciliation, (3) API routes, (4) web feed + fix picker, (5) AI tools. Feature flag `fleet.findings.enabled` allows disabling producers per-org if a fleet generates noise.
