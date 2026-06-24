# Device Instability Shadow Model — Execution Addendum

**Status:** Execution-ready addendum (resolves open decisions + pins contracts)
**Date:** 2026-06-23
**Owner:** Todd
**Extends (does NOT replace):** `internal/specs/2026-06-19-ml-device-instability-shadow-plan.md`
**Related:** `internal/specs/2026-06-18-ml-roadmap-execution-plan.md`, reliability v0 fix PR #1851

## Why this document exists

The 2026-06-19 shadow plan is already ~90% a spec — table, signals, scoring v0,
learning period, worker, evaluation, UI, Phase A–E sequence, test plan, promotion
criteria. It is **not yet executable** for three reasons, which this addendum
closes:

1. Its four **Open Decisions** were unresolved.
2. Its assumed input contracts ("where available") were not validated against the
   current schema. One assumption is **false** (online/offline flap history does
   not exist) and changes v0 scope.
3. It predates the reliability v0 fix (#1851). The "reliability as input" signal
   should read the corrected availability-based score, not the boot-snapshot one.

Read the 2026-06-19 plan first. This document only records the deltas. Where the
two conflict, **this addendum wins**.

## Hard dependency on #1851

The model consumes `device_reliability` as a feature (plan §5). Until #1851
(uptime from observed availability) is merged, that feature is the broken
boot-snapshot uptime — a routine reboot reads as ~5% uptime. **Do not start the
scorer (Phase B) until #1851 is merged**, or the shadow model trains/evaluates on
a signal we already know is wrong. Phases A (contracts) and the migration may
proceed in parallel.

## Resolved open decisions

### #2 — Canonical online/offline flapping source → **does not exist; resolve by adding a prospective ledger; flapping deferred out of v0**

The plan's connectivity signal (plan §3: "offline/online flaps in last 24h") is
**not natively queryable**. The `devices` table carries only current
`status` and `last_seen_at` (`apps/api/src/db/schema/devices.ts:66`); there is no
`device_status_history`. `offlineDetector` (`apps/api/src/jobs/offlineDetector.ts`)
derives offline by threshold but does not record the transition.

Resolution:

- **v0 connectivity signal uses only what exists today**, computed from
  `last_seen_at`: *time since last seen* and *missed expected check-ins* (gaps in
  reliability/heartbeat reporting vs the device's normal cadence). No flap count
  in v0.
- **Add a lightweight `device_status_changes` ledger** (org_id, device_id,
  from_status, to_status, changed_at), written **prospectively** by
  `offlineDetector` when it flips a device's status. No backfill. Once it has ≥24h
  of data, the flap-count feature activates as an additive signal in a later
  iteration — it is **not** a blocker for v0.
- This keeps v0 shippable now and makes flapping a clean, additive follow-up.

### #3 — Event-log rare-event / burst baseline granularity → **per-device/source/eventId, with org-wide (source,eventId) fallback**

Validated feasible. `device_event_logs`
(`apps/api/src/db/schema/eventLogs.ts:26`) has `device_id, org_id, timestamp,
level, category, source, event_id, message, details`, with a dedup index on
`(device_id, source, event_id)` (line 45) — that triple is the natural baseline
grain.

Resolution: compute burst/rare-event baselines **per (device, source, event_id)**;
for devices with too little history (learning period), fall back to an **org-wide
(source, event_id)** daily-median baseline. This directly supports the plan's
`event_log_burst` evidence shape.

### #1 — UI scope (product call) → **device-details preview AND a minimal internal/admin org-wide list**

Recommended (override if you disagree): ship both. During a shadow/internal bake
with zero labels, the org-wide list is what makes the model *useful to look at* —
it answers "which devices would this flag fleet-wide?" The device-detail panel
alone can't surface that. Keep the list minimal (risk level, top signal, last
seen, candidate time; filters: risk, signal family, site) and clearly marked
shadow/preview. Both stay behind the flag and never enter the alert inbox.

### #4 — Merge into `device_reliability` vs separate forecast layer (product call) → **separate layer for now; revisit at Phase E**

Recommended (override if you disagree): keep `device_instability_candidates` a
distinct "instability forecast" layer, exactly as the plan's non-goals state ("do
not replace the existing `device_reliability` score in this phase"). Merging is a
one-way door; decide it at Phase E (Bake & Decision) once the precision proxy is
known. Designing for separation now costs nothing and keeps the phase reversible.

## Validated input contracts

| Signal | Source (file:line) | Status | v0 use |
|---|---|---|---|
| Event-log crashes/bursts/rare events | `device_event_logs` (`eventLogs.ts:26`) | YES | per-device/source/eventId baseline + org-wide fallback (#3) |
| Metric anomalies | `metric_anomalies` (`analytics.ts:65`), `metric_anomaly_candidates` (`analytics.ts:106`) | YES | open/high-confidence counts 24h/7d per device |
| Patch/update failures | `patch_job_results` (`patches.ts:235`) — `status='failed'`, `error_message`, `completed_at` | YES | failed installs 7d, reboot-required-not-completed |
| Reliability score + degradation | `device_reliability` (`reliability.ts:59`), `device_reliability_history` (`reliability.ts:42`) | YES (degradation via history query) | latest score + recent slope — **post-#1851** |
| Connectivity | `devices.status` / `last_seen_at` (`devices.ts:66`) | PARTIAL | time-since-last-seen, missed check-ins; **flaps deferred (#2)** |

## Plumbing checklist (exact registration points)

The new `device_instability_candidates` table is a **Shape #1 direct-`org_id`**
tenant table.

- **Migration:** `CREATE TABLE IF NOT EXISTS`, RLS enabled + forced, policies
  `breeze_has_org_access(org_id)`, FK `device_id → devices(id) ON DELETE CASCADE`,
  unique key per plan (`org_id, device_id, model_version, window_end,
  predicted_horizon_hours`). Idempotent per CLAUDE.md migration rules.
- **RLS coverage:** Shape #1 is **auto-discovered** by
  `rls-coverage.integration.test.ts` — no allowlist entry needed; the contract
  test enforces the policies exist. (Run it locally against a real DB; verify a
  cross-tenant insert fails as `breeze_app`.)
- **Org cascade:** add `'device_instability_candidates'` to
  `ORG_CASCADE_DELETE_ORDER` in `apps/api/src/services/tenantCascade.ts` in
  `localeCompare` order (CLAUDE.md cascade-ordering rule). Only the Integration
  Tests job catches a miss.
- **Device cascade:** the `ON DELETE CASCADE` FK is the device-cascade mechanism
  (same pattern as `device_reliability`); confirm device-delete in `core.ts` does
  not need an explicit list entry for cascade-FK children.
- **Feature flag:** add `'ml.device_instability.shadow.enabled'` to
  `ML_FEATURE_FLAGS` and return `false` from `defaultMlFeatureFlagValue()` in
  `apps/api/src/services/mlFeatureFlags.ts`. Worker checks it before any write.
- **Worker:** new `apps/api/src/jobs/deviceInstabilityShadowWorker.ts` mirroring
  `reliabilityWorker.ts` (lazy queue getter, init/shutdown exports); register in
  the workers array in `apps/api/src/index.ts` next to
  `initializeReliabilityWorker`. Queue `device-instability-shadow`; stable job IDs
  and `withSystemDbAccessContext` per the plan's worker contract.
- **Status-change ledger (for #2):** separate small migration for
  `device_status_changes` + write hook in `offlineDetector.ts`. Independent of the
  v0 critical path; can land before or after.

## v0 signal scope (first build)

Available **now**, ship in Phase B v0: event-log bursts/rare events, metric
anomalies, patch failures, reliability score + degradation. **Deferred:** flap
count (waits on the `device_status_changes` ledger accumulating data) — v0 still
uses time-since-last-seen / missed check-ins for connectivity so the signal family
is represented.

## Retention (close the C4 gap for these tables)

- `device_instability_candidates`: model output → 180–365d (enough to evaluate),
  per roadmap C4. Add a bounded-batch cleanup worker.
- `device_status_changes`: 30–90d is plenty for 24h/7d flap features.
- **Pre-existing gap:** `device_reliability_history` has no retention policy
  (validation finding). Not introduced here, but worth a separate ticket — the
  degradation feature reads it and it grows unbounded at 10k+ agents.

## Phase mapping (unchanged from the plan, with deltas)

Follow the plan's Phase A–E. Deltas:

- **Phase A** (contracts): also add the feature flag default and the (optional)
  `device_status_changes` migration. RLS Shape #1 needs no allowlist entry.
- **Phase B** (scorer v0): gated on #1851. Implement the v0 signal scope above;
  flapping extractor stubbed until the ledger has data.
- **Phase C** (evaluation): unchanged — the existing reliability evaluation harness
  (`computeReliabilityEvaluationSummary`, `ml_feedback_events`) is the template.
- **Phase D** (preview UI): build both surfaces per resolved Decision #1.
- **Phase E** (bake & decide): includes the merge-vs-separate call (Decision #4)
  and the flap-signal activation review.

## What stays exactly as written in the 2026-06-19 plan

Table columns, score bands, weight groups, learning-period policy
(`learning`/`ready`/`insufficient_data`, 7/14-day baselines, 72h grace),
evaluation metrics and response shape, worker contract, test plan, and promotion
criteria are unchanged. This addendum does not restate them.
