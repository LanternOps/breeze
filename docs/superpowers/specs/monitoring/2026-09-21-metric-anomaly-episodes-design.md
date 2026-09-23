# Metric anomaly episodes: one card per event, auto-resolve, process attribution

Status: **draft for owner review** (Todd asked for the spec 2026-09-21 after reviewing the
anomalies tab on KIT, US prod).
Advisor quorum: two reviews. (1) Design quorum — Fable position formed; Codex unavailable (usage
limit until 2026-09-26), so the independent review was a fresh-context Opus agent with repo access.
Ten questions put, ten verdicts returned; eight amendments adopted, two positions held on the
evidence. See "Quorum record" (§20). (2) Second quorum on the reconciled plans (Fable,
2026-09-22) — ten questions, amendments A1–A12 adopted after the orchestrator verified the key
claims. See §22.
Tracking: LanternOps/breeze#6650 (waves #6651 W01, #6652 W02, #6653 W03, #6654 W04).
Plan: `docs/superpowers/plans/monitoring/2026-09-21-metric-anomaly-episodes.md` (index, one plan per
wave).
Prior decisions this builds on: `docs/runbooks/ml-operations.md` (v0 rule: ML may create rows and
suggestions but never executes remediation without a human), the ML feature-flag model
(`apps/api/src/services/mlFeatureFlags.ts`, boolean flags, org > partner > default), PR #6538 (the
anomaly toggle UI), and #5283 (each detector stage is its own transaction under a per-org advisory
lock).

## 1. Problem and goal

The anomaly detector (`apps/api/src/services/metricAnomalies.ts`) writes one `metric_anomalies` row
per device × metric × anomaly type × **5-minute bucket**, and nothing ever changes a row's status
except a human clicking Dismiss / Resolve / Promote (`apps/api/src/routes/devices/anomalies.ts`)
or the 365-day retention sweep (`apps/api/src/jobs/mlOutputRetention.ts`). The device panel
(`apps/web/src/components/devices/DeviceAnomaliesPanel.tsx`) lists those rows sorted by confidence
and shows observed value, baseline and a confidence percentage. That is the whole product.

Measured on US prod, partner OliveTech, 12 hours after enabling the flag (2026-09-21 17:00Z →
2026-09-22 04:41Z):

| Measure | Value |
|---|---|
| Rows created | 623 |
| Still `open` | 621 |
| Promoted by a human | 2 |
| Dismissed or resolved | 0 |

On one device (KIT):

- A single disk-write burst from 22:35 to 23:55 produced **17 separate "Disk write spike" cards**
  (one per bucket, 86–153 MB/s against a baseline of 5.5–11 MB/s).
- A `process_runaway` on `top_process_ram_mb_max` **and** `top_process_ram_mb_sum` fired **every hour
  at :30** (00:30, 01:30, 02:30, 03:30, 04:30) — two cards per hour for what is almost certainly one
  scheduled task.
- The 24-hour baseline for disk write **drifted from 5.5 to 11 MB/s during the burst**, because the
  baseline window includes the anomalous buckets. Thresholds inflate mid-burst, so a long burst
  eventually stops being detected and later "recurs".
- The evidence column holds only `{observedValue, baselineValue, baselineMax}`. No process name is
  recorded, although the agent ships the top 8 processes with cpu/ram/disk/net every 180 s
  (`device_process_samples.top_processes`).

Goal: a tech opening the Anomalies tab sees **one card per event**, phrased as a sentence with
duration, magnitude, the processes responsible, and how often it has happened; events that stop
**close themselves** and stay visible as history; the AI-agent pilot gets **one dispatch per event**
instead of one per bucket.

Non-goal: changing what counts as anomalous (thresholds, models). The v1 seasonal model stays in
shadow. One detector change is included (§10, baseline anti-contamination) because without it the
episode lifecycle is wrong; it is scoped to be self-clearing and has a fallback.

## 2. Decisions

| # | Decision |
|---|---|
| D1 | New table `metric_anomaly_episodes`: one row per contiguous run of anomalous buckets for a (device, episode key). `metric_anomalies` rows stay as the per-bucket evidence and gain a nullable `episode_id`. |
| D2 | Episode key = `source_table : anomaly_type : metric_family`. The only families that collapse several metric names are the process cpu and ram `_sum`/`_max` pairs. |
| D3 | **Extend while ongoing; never reopen.** A gap of ≤ 30 min between anomalous buckets extends the episode. After 30 min of clean data the episode closes. New activity after a close opens a **new** episode carrying `recurrence_count` = number of episodes with the same key that closed in the 7 days before its first bucket (episode-relative, so a replay counts correctly). |
| D4 | Assembly and auto-resolve are two new detector stages, each its own transaction and advisory-lock acquisition. Assembly runs after the three detectors and **before** the incidents stage (so each incident is created with its episode); auto-resolve runs last. The resolve stage runs even when `ml.anomalies.enabled` is off — then it closes every open episode as `detection_off`, because rollups nobody evaluated prove nothing. |
| D5 | Auto-resolve requires **observed clean data**: ≥ 6 rollup buckets with samples for every metric in the episode after its last anomalous bucket. With no clean data for 24 h the episode expires, labelled `expired_offline` (device not seen) or `expired_no_data` (device reporting, series absent). |
| D6 | Episode status is `open / resolved / dismissed` plus a `close_reason`. Promotion is a link (`linked_alert_id`), not a status; a promoted episode keeps extending and, when it clears, resolves its alert. |
| D7 | Human actions cascade to member rows **only where the member is still `open`**, and emit one `ml_feedback_events` row per member (existing `sourceType: 'anomaly'`) so `/analytics/anomalies/evaluation` and the v1-shadow overlap keep their labels. Auto-resolve sets members to a new `cleared` status that the evaluation excludes from human-label rates. |
| D8 | **Dismiss = dismiss and snooze this signal on this device for 7 days.** A new episode for a snoozed key is created already-dismissed (`close_reason = 'snoozed'`), so it is auditable but silent. "Stop snoozing" is the only extra action. |
| D9 | Attribution: at episode open and whenever the peak grows, snapshot the top 3 processes for the family's dimension from the nearest `device_process_samples` row (set-based, one LATERAL per stage run). Disk/net dimensions may legitimately be empty; the UI says so. |
| D10 | Baseline anti-contamination: the baseline aggregate excludes buckets that belong to a **currently open** episode of the same key. If that leaves fewer than `MIN_BASELINE_BUCKETS` (12), fall back to the unfiltered baseline and count it. |
| D11 | AI-agent dispatch: `metric_anomaly_incidents` keeps its per-bucket grain (schema and unique key unchanged) but gains `episode_id`, written when the incident is created; the publisher dispatches at most one incident per episode and marks the rest suppressed. |
| D12 | The web panel shows open episodes as sentence cards with an expandable list of member buckets, a "Recently closed" filter for the last 7 days, and hides the v1-shadow and remediation-suggestion blocks when their flags are off. Legacy per-row endpoints stay for alert deep links; the UI no longer offers per-row actions. |

## 3. Scope and non-goals

In scope: D1–D12, the migration and every cascade/export/merge registration for the new table and
new columns, integration proofs against real Postgres, the device panel rewrite, runbook update.

Out of scope (explicit follow-ups, §19): fleet-level episode list, numeric tuning settings per
partner (the constants are exported module constants with env overrides only), changing the AI
pilot's `anomalyContext` to read episodes, the v1 seasonal model, per-device threshold classes,
remediation-suggestion quality, removing `metric_anomaly_incidents`.

## 4. Episode model (D1, D2)

### 4.1 Table `metric_anomaly_episodes`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | `gen_random_uuid()` |
| `org_id` | uuid NOT NULL FK organizations | denormalised from the device (shape 1) |
| `device_id` | uuid NOT NULL FK devices ON DELETE CASCADE | |
| `episode_key` | varchar(120) NOT NULL | `source_table:anomaly_type:metric_family`, see 4.2 |
| `source_table` | varchar(40) NOT NULL | `device_metrics` \| `device_process_samples` |
| `anomaly_type` | varchar(40) NOT NULL | same domain as `metric_anomalies.anomaly_type` |
| `metric_family` | varchar(40) NOT NULL | see 4.2 |
| `metric_names` | text[] NOT NULL | distinct member metric names, sorted |
| `status` | varchar(20) NOT NULL DEFAULT 'open' | CHECK `open \| resolved \| dismissed` |
| `close_reason` | varchar(30) | NULL while open; CHECK `cleared \| expired_offline \| expired_no_data \| detection_off \| user \| snoozed` (`detection_off` = closed because `ml.anomalies.enabled` was turned off, §7) |
| `first_seen_at` | timestamp NOT NULL | `min(window_start)` of members |
| `last_seen_at` | timestamp NOT NULL | `max(window_end)` of members |
| `bucket_count` | integer NOT NULL | members attached |
| `peak_value` | double precision NOT NULL | member with the highest `score` |
| `peak_metric_name` | varchar(80) NOT NULL | metric of that member (distinguishes `_sum` from `_max`) |
| `peak_baseline_value` | double precision | baseline of that member |
| `peak_score` | double precision NOT NULL | |
| `peak_at` | timestamp NOT NULL | `window_start` of that member |
| `recurrence_count` | integer NOT NULL DEFAULT 0 | episodes with the same (device, key) whose `resolved_at` falls in the 7 days up to this episode's `first_seen_at`; denormalised, no FK |
| `attribution` | jsonb | §9; NULL when no process sample within ±5 min |
| `linked_alert_id` | uuid FK alerts ON DELETE SET NULL | promotion link |
| `snoozed_until` | timestamp | set by a user dismiss; copied onto snoozed successors |
| `resolved_at` | timestamp | set when status leaves `open` |
| `resolved_by_user_id` | uuid FK users ON DELETE SET NULL | NULL for automatic closes |
| `note` | varchar(500) | from the PATCH body |
| `created_at`, `updated_at` | timestamp NOT NULL DEFAULT now() | |

Constraints: `(status = 'open') = (close_reason IS NULL)`; `first_seen_at < last_seen_at`;
`bucket_count >= 1`.

Indexes:

- `metric_anomaly_episodes_open_key_uq` — **partial unique** `(device_id, episode_key) WHERE status = 'open'`.
  Makes attach-or-create an `ON CONFLICT` and is race-proof between the cron and a backfill job.
- `(org_id, status, last_seen_at)` — auto-resolve sweep and the panel's "recently closed" filter.
- `(device_id, episode_key, resolved_at DESC)` — recurrence and snooze lookups.
- `(device_id, status, last_seen_at DESC)` — the device panel list.

`metric_anomalies` gains `episode_id uuid REFERENCES metric_anomaly_episodes(id) ON DELETE SET NULL`
with index `(episode_id)` and a partial index `(org_id, device_id, window_start) WHERE episode_id IS
NULL AND status = 'open'` for the assembly scan. Its status CHECK is re-created to add `cleared`.

`metric_anomaly_incidents` gains `episode_id uuid` **without** an FK (the same choice the table
already made for `agent_run_id`, to keep `topologicalCascadeOrder()` free of cycles; see the header
comment in `apps/api/src/db/schema/metricAnomalyIncidents.ts`), with index `(episode_id)`.

### 4.2 Episode key and metric families

`episodeKeyFor(sourceTable, anomalyType, metricName)` is a pure function with an explicit map,
unit-tested for every metric name the three detectors can emit:

| source_table | metric_name(s) | metric_family | attribution dimension |
|---|---|---|---|
| device_metrics | cpu_percent | cpu | cpu |
| device_metrics | ram_percent | ram | ramMb |
| device_metrics | ram_used_mb | ram_used | ramMb |
| device_metrics | disk_percent | disk | — |
| device_metrics | disk_used_gb | disk_used | — |
| device_metrics | disk_read_bps | disk_read | diskBps |
| device_metrics | disk_write_bps | disk_write | diskBps |
| device_metrics | bandwidth_in_bps | net_in | netBps |
| device_metrics | bandwidth_out_bps | net_out | netBps |
| device_metrics | process_count | process_count | — |
| device_process_samples | top_process_cpu_percent_sum, top_process_cpu_percent_max | process_cpu | cpu |
| device_process_samples | top_process_ram_mb_sum, top_process_ram_mb_max | process_ram | ramMb |
| device_process_samples | top_process_disk_bps_sum | process_disk | diskBps |
| device_process_samples | top_process_net_bps_sum | process_net | netBps |
| device_process_samples | top_process_count | process_count_top | — |

Only the cpu and ram pairs collapse. `source_table` is part of the key because `network_egress`
is emitted for `bandwidth_out_bps` (device metrics) and for `top_process_net_bps_sum` (process
samples), and `process_runaway` for `process_count` and for the top-process pairs; those are
different series and must not merge. An unknown metric name maps to `metric_family = metric_name`
so the detector can grow without breaking assembly.

### 4.3 Why episode ≠ incident

`metric_anomaly_incidents` already groups rows, on `(device, anomaly_type, bucket_seconds,
window_start)` — one row per **bucket** with `metric_name` excluded. It is the AI pilot's dispatch
outbox, not a lifecycle. This spec does not change its grain (D11); it adds `episode_id` so the
publisher can dispatch once per episode. The schema header of the new table must say this, and say
that the agent's incident count and the tech's episode count differ by design.

## 5. Extend or repeat (D3)

The owner's question: when a device is still misbehaving, extend the first episode or start new
ones?

**Extend while it is ongoing, close after 30 minutes of clean data, then start a new episode linked
by count. Never reopen a closed episode.**

- Extending is what carries duration and peak, the two facts a tech reads first.
- A closed episode may carry a human label (dismissed, resolved, promoted). Reopening it would
  silently overwrite that verdict and confuse the evaluation endpoint.
- Recurrence is itself diagnostic. KIT's hourly `:30` process anomaly reads as "5 episodes, hourly,
  each about 5 minutes" — which points at a scheduled task. As one ever-extending episode it would
  be a 5-hour window that was clean 90 % of the time.
- The gap tolerance and the close threshold are the same constant so a burst that dips for one or
  two buckets is not split. The detector's own overlap is one bucket and its cron is 10 minutes, so
  anything shorter than 30 minutes would split bursts on scheduling jitter alone.

Constants (exported from `apps/api/src/services/metricAnomalyEpisodes.ts`, env-overridable, each
with a unit test that the default is what this spec says):

| Constant | Default | Meaning |
|---|---|---|
| `EPISODE_GAP_MINUTES` | 30 | max gap between anomalous buckets inside one episode |
| `EPISODE_CLEAN_BUCKETS` | 6 | clean 5-min buckets (per metric) required to auto-resolve |
| `EPISODE_EXPIRE_HOURS` | 24 | no clean data for this long → expired |
| `EPISODE_RECURRENCE_DAYS` | 7 | window for `recurrence_count` |
| `EPISODE_SNOOZE_DAYS` | 7 | how long a user dismiss silences the key on that device |
| `EPISODE_ASSEMBLY_LOOKBACK_HOURS` | 24 | how far back the assembly scan looks for unassigned rows |

Close is decided by "no new anomalous bucket", **not** by "value is back inside the baseline". The
baseline is the contaminated quantity §10 fixes, and for a pegged device it converges on the
anomaly, so "back inside baseline" would close episodes on still-broken devices.

## 6. Assembly stage (D4)

A new stage `episodes` in `detectMetricAnomaliesRange`, after the three detectors and **before**
`incidents`, its own `withSystemDbAccessContext` transaction and its own
`pg_try_advisory_xact_lock` acquisition. Running first means `upsertMetricAnomalyIncidents` finds
every fresh row already assigned and writes the incident's `episode_id` at insert (§11). Stage order:
`baseline, growth-trend, process-runaway, episodes, incidents, episode-resolve`.

Input: `metric_anomalies` rows for the org with `episode_id IS NULL AND status = 'open' AND
window_start >= now() − EPISODE_ASSEMBLY_LOOKBACK_HOURS`, ordered by `(device_id, window_start)`.

For each row, compute `episode_key`. Then, in one set-based statement per org:

1. **Attach** to the open episode with the same `(device_id, episode_key)` when
   `episode.first_seen_at − EPISODE_GAP_MINUTES ≤ row.window_start ≤ episode.last_seen_at +
   EPISODE_GAP_MINUTES`. The lower bound exists because `enqueueMetricAnomalyBackfill` replays
   arbitrary history through the same stages; without it a months-old orphan would attach to
   today's episode and rewrite `first_seen_at`. Attaching updates `first_seen_at`/`last_seen_at`
   (min/max), `bucket_count`, `metric_names` (∪), and the peak fields when `row.score >
   peak_score`.
2. **Otherwise open** a new episode. `recurrence_count` = count of episodes with the same
   `(device_id, episode_key)` whose `resolved_at ∈ [first_seen_at − EPISODE_RECURRENCE_DAYS,
   first_seen_at]` — relative to the new episode, not to `now()`. (The upper bound is inclusive
   because an episode closed by assembly is stamped `resolved_at` = its successor's start.) If the
   most recent dismissed episode for that key has `snoozed_until > now()`, the new episode is created
   with `status = 'dismissed'`, `close_reason = 'snoozed'`, `resolved_at = now()`, the same
   `snoozed_until`, and its members are set to `dismissed` (§8.3). Insert uses `ON CONFLICT` on the
   partial unique index; on conflict, re-run the attach.
3. Set `episode_id` on the member rows.

Only the newest island of a key can become a snoozed successor; an older island in the same batch
(a backfill orphan, an earlier burst) is created as closed history even while a snooze is live.

**Concurrency with a human action.** The planner reads without locks, and a user can dismiss or
unsnooze an episode between that read and the writes. The writes therefore lock the anchor
episodes `FOR UPDATE` and only attach to, or recompute, an existing episode that is still `open` or
a live snoozed successor (`status = 'dismissed' AND close_reason = 'snoozed' AND snoozed_until >
now`). Rows planned onto an episode that fails the check stay unassigned and become a snoozed
successor or a new episode on the next tick; a dismissed episode never gains open members.

Backfill jobs (explicit `from`/`to`) run assembly (the predicates, including `recurrence_count`, are
episode-relative, so replay is safe) but **skip auto-resolve** (it is `now()`-relative).

First deployment: rows older than the lookback that are still `open` are never assembled. The new
panel does not show them; they age out with retention. No migration-time backfill of `episode_id`.

## 7. Auto-resolve stage (D5)

Stage `episode-resolve`, last. It runs from the scan job **regardless of `ml.anomalies.enabled`** —
turning detection off must not freeze open episodes. The scan job therefore calls the resolve stage
outside the flag gate (the flag gate stays around the three detectors, assembly and incidents).

**Detection off.** With the flag off no detector evaluates the rollups, so rollups that look clean
prove nothing. The stage then closes every `open` episode of the org with `status = 'resolved'`,
`close_reason = 'detection_off'`, `resolved_at = now()`, members still `open` → `cleared`, no
feedback rows, and **no** linked-alert resolve (nothing observed the device recover). The panel
shows "closed: detection turned off".

**Detection on.** For every `open` episode of the org with `last_seen_at + EPISODE_GAP_MINUTES + 5
min ≤ to`, where `to` is the detection run's range end — a bucket starting at `last_seen_at + gap`
would still attach, so it must have had its detection pass before "no new bucket" means anything
(`now()` is not enough when detection lags):

- `clean(metric)` = number of `metric_rollups` rows with `source_table = episode.source_table`,
  `device_id`, `metric_name = metric`, `bucket_seconds = 300`, `bucket_start ≥
  episode.last_seen_at`, `sample_count > 0`. (Any anomalous bucket after `last_seen_at` would have
  attached and moved `last_seen_at`, so every such rollup row is clean by construction.)
- **Resolve** with `close_reason = 'cleared'` when `min over metric_names of clean(metric) ≥
  EPISODE_CLEAN_BUCKETS`.
- **Expire** (still `now()`-relative) when not cleared and `last_seen_at < now() − EPISODE_EXPIRE_HOURS`:
  `expired_offline` if `devices.last_seen_at IS NULL OR devices.last_seen_at < now() −
  EPISODE_EXPIRE_HOURS`, else `expired_no_data` (the device is checking in but this series stopped —
  process sampling disabled, agent downgrade, metric removed).
- Either close sets `resolved_at = now()`, leaves `resolved_by_user_id` NULL, and sets member rows
  `WHERE status = 'open'` to `cleared` (D7). Members that were promoted stay `promoted`.
- If `linked_alert_id` is set and the alert is `active` and not `requiresHuman`, call
  `resolveAlert(alertId, 'Auto-resolved: anomaly episode cleared')` (or `... expired`). Today
  `checkAutoResolve` returns false for every `ruleId: null` alert (`alertService.ts:455-457`), so
  promoted anomaly alerts never close; this is the only auto-resolve path they get.

Both new stages are whole-org sweeps under the same 90 s `statement_timeout` as the detectors. A
timeout is a logged skip today; the two new stages additionally increment a counter
(`metric_anomaly_episode_stage_skipped_total{stage}`) so a silently never-clearing fleet is visible.

## 8. Human actions and label integrity (D6, D7, D8)

### 8.1 Actions

`PATCH /devices/:deviceId/anomaly-episodes/:episodeId` with `{ action, note?, resolveAlert? }`
(`resolveAlert` defaults to `true` and only matters for `resolve` or `dismiss` on a promoted episode,
§8.2):

| action | precondition | effect |
|---|---|---|
| `resolve` | status open | status resolved, close_reason user, resolved_at/by; members open → resolved; linked alert resolved when `resolveAlert` is true |
| `dismiss` | status open | status dismissed, close_reason user, `snoozed_until = now() + EPISODE_SNOOZE_DAYS`; members open → dismissed; linked alert resolved when `resolveAlert` is true (note `Resolved: anomaly episode dismissed` unless the user wrote one) |
| `promote` | status open, no linked alert | `promoteMetricAnomalyToAlert` on the peak member (its sibling collapse still applies), `linked_alert_id` set, members open → promoted; the alert's `context` gains `episodeId`; episode stays open |
| `unsnooze` | status dismissed and `snoozed_until > now()` | `snoozed_until = NULL` on this episode; no status change |

Actions on a closed episode other than `unsnooze` return 409. The same permission checks as the
existing per-row route apply.

### 8.2 Cascade rule

Cascades touch member rows **only `WHERE status = 'open'`**. A member already `promoted` keeps that
label whatever the episode does; a human `resolve` **or `dismiss`** over a promoted episode is
therefore "episode closed, alert stays for the alert workflow" only when the caller passes
`resolveAlert: false`; the default resolves the linked alert with the user's note. (A tech who
silences a signal is done with it; keeping its alert open by default would leave an orphan.)

### 8.3 Feedback events

Per-member: one `ml_feedback_events` row per cascaded member with the existing `sourceType:
'anomaly'`, `sourceId = member.id`, `eventType = anomaly.<dismissed|resolved|promoted>`, `dedupeKey =
'episode:<episodeId>'`, `metadata.episodeId`. This keeps `/analytics/anomalies/evaluation` (which
joins feedback to `metric_anomalies.id`) and the v1-shadow overlap (which joins to
`metric_anomaly_candidates` on the exact bucket) fully attributable.

Per-episode: one row with a **new** `sourceType: 'anomaly_episode'`, `sourceId = episodeId`. That
needs the `ml_feedback_events_source_type_check` constraint re-created and
`ML_FEEDBACK_SOURCE_TYPES` in `packages/shared/src/validators/mlFeedback.ts` extended; both land in
the evaluation wave (W03), and until then the route emits member rows only.

Automatic closes (`cleared`, `expired_*`, `detection_off`) and snoozed successors emit **no** feedback rows: they are
not human labels. `cleared` is excluded from the human-label denominators in the evaluation
endpoint in W03; before W03 it appears as its own status bucket, which the endpoint already tolerates
(`GROUP BY status`).

### 8.4 Legacy per-row route

`GET/PATCH /devices/:id/anomalies/*` stay (alert deep links reference anomaly ids; the AI pilot's
`anomalyContext` reads rows). The status enum in the query schema, serializer and web type gains
`cleared`. A per-row PATCH does not touch the episode; the web UI stops offering per-row actions.

## 9. Attribution (D9)

At episode open, and on every attach that raises `peak_score`, the assembly statement joins one
`device_process_samples` row per affected episode via `LEFT JOIN LATERAL (… WHERE device_id = e.device_id
AND timestamp BETWEEN bucket_start − 5 min AND bucket_start + 10 min ORDER BY abs(timestamp −
bucket_midpoint) LIMIT 1)`. From `top_processes` it takes the top 3 by the family's dimension
(§4.2) and writes:

```json
{
  "opened": { "sampledAt": "…", "dimension": "ramMb", "processes": [{ "name": "chrome.exe", "pid": 4120, "value": 1932.5 }, …] },
  "peak":   { "sampledAt": "…", "dimension": "ramMb", "processes": [ … ] }
}
```

`opened` is written once; `peak` is overwritten on each new peak. Families with no dimension
(`disk`, `disk_used`, `process_count*`) store `null`. `diskBps`/`netBps` are `omitempty` on the
agent side, so a disk or net episode may have a sample with an empty list; the UI renders "Process
detail not available for this metric" rather than an empty list. The snapshot is taken at detection
time, so it outlives the 7-day sample retention.

`attribution` is jsonb and therefore `excludedOpen` in the tenant export policy: it is visible in
the UI but absent from the GDPR export. State this in the PR.

## 10. Baseline anti-contamination (D10)

In the baseline CTE of the three detectors (`detectBaselineDeviations`, `detectGrowthTrends` does
not use a baseline and is unchanged, `detectProcessSampleRunaways`), exclude a bucket when a
`metric_anomalies` row exists for the same `(device_id, source_table, metric_name, window_start)`
whose `episode_id` points at an episode with `status = 'open'`. Buckets of closed episodes rejoin
the baseline, so a device that legitimately steps up (more RAM in use forever) re-baselines within
24 h of its episode closing.

Dismissing an episode lets the baseline absorb the behaviour: snoozed successors are dismissed, so
their buckets are not excluded from the baseline, and the key usually stops firing even after the
snooze ends. There is no permanent suppression; "mute until changed" for recurring scheduled-task
anomalies is a follow-up (§19).

Fallback: when the filtered baseline has fewer than `MIN_BASELINE_BUCKETS` (12) rows, use the
unfiltered baseline for that device+metric and increment
`metric_anomaly_baseline_fallback_total`. Without the fallback a long burst would remove most of
the 24 h window and detection would stop silently — the failure this change exists to prevent,
reached from the other side.

Index: the anti-join filters `metric_anomalies` on `(device_id, metric_name, window_start)` and
needs `episode_id`; `metric_anomalies_key_uq` has `anomaly_type` between `metric_name` and
`window_start`, so add `metric_anomalies_device_metric_window_idx (device_id, metric_name,
window_start) WHERE episode_id IS NOT NULL`.

Proof required (W01 integration test): a synthetic 6-hour burst at 4× baseline on one metric still
produces an anomalous bucket at hour 5, and the assembled episode spans the full 6 hours.

## 11. AI-agent dispatch per episode (D11)

`upsertMetricAnomalyIncidents` keeps its grouping. Because the `episodes` stage runs first (§6), it
writes `metric_anomaly_incidents.episode_id` when it creates the incident: among the incident's
member anomalies (same device, anomaly_type, bucket_seconds, window_start), the episode of the
member with the highest `score` — `(array_agg(ma.episode_id ORDER BY ma.score DESC NULLS
LAST))[1]`. On conflict it keeps a known link, `episode_id = COALESCE(EXCLUDED.episode_id,
metric_anomaly_incidents.episode_id)`, so a later tick fills a link a timed-out `episodes` stage left
NULL and never unlinks one. There is no separate link statement and no publisher grace window.

The publisher's claim CTE adds: skip an incident when another incident with the same `episode_id`
already has `agent_run_id IS NOT NULL`; the skipped row is marked `dispatched_at = now()`,
`dispatch_attempts = dispatch_attempts + 1`, `suppressed_by_episode = true` (new boolean column,
default false), and is never published. Retention already prunes dispatched rows after 14 days, so a
still-open episode older than 14 days gets one fresh dispatch — acceptable. Incidents with
`episode_id IS NULL` (the `episodes` stage timed out that tick, or rows outside the lookback)
dispatch as today.

## 12. API surface

| Method | Path | Notes |
|---|---|---|
| GET | `/devices/:id/anomaly-episodes?status=open\|closed\|all&limit=1..100&ref=<uuid>` | default `open`, limit 25. `closed` = resolved or dismissed with `resolved_at ≥ now() − 7 d`. `ref` matches either an episode id or a member anomaly id (alert deep links) and forces `status=all`, returning that episode first. |
| GET | `/devices/:id/anomaly-episodes/:episodeId` | episode + `members[]` (≤ 200, by `window_start`) |
| PATCH | `/devices/:id/anomaly-episodes/:episodeId` | §8.1 |
| GET/PATCH | `/devices/:id/anomalies…` | unchanged, plus `cleared` in the enum |

Episode serialization: every column of §4.1 in camelCase plus `durationSeconds` (`last_seen_at −
first_seen_at`), `ongoing` (`status === 'open'`), `promoted` (`linked_alert_id !== null`),
`snoozed` (`snoozed_until > now`), `rangeMin`/`rangeMax` and `peakAnomalyId` (§21), and
`deviceLastSeenAt` (the device's `last_seen_at`, joined from `devices`, for the `expired_offline`
chip).

Alerts created by promotion carry `context.episodeId`; `alertMlContext.ts` links to
`#anomalies/<episodeId>` when present and falls back to `#anomalies/<anomalyId>`. The panel passes
whichever id it gets as `ref`.

## 13. Web: device panel (D12)

`DeviceAnomaliesPanel` is rewritten against the episode endpoints. Layout, top to bottom:

1. Header: "Anomalies" + filter pills **Open** (default) · **Recently closed** · **All**; refresh.
2. Episode cards, newest `last_seen_at` first. A card is:
   - Line 1 (bold sentence, per family):
     - spike / network_egress / process_runaway: "**Disk write** has been 86–153 MB/s for **1 h 20 m**, normally 6 MB/s."
     - `_max` family peak: "**One process** reached 2.3 GB RAM, normally 0.6 GB." / `_sum`: "**Top processes together** used 6.5 GB RAM, normally 3.2 GB."
     - drop: "**CPU** dropped to 3 % for 25 m, normally 41 %."
     - memory_growth / disk_growth: "**RAM used** grew from 3.1 GB to 6.4 GB over 45 m."
     The range is `min..max` of member observed values; a single bucket prints one value.
   - Line 2: "Top by RAM at peak: chrome.exe 1.9 GB · MsMpEng.exe 0.4 GB · Teams.exe 0.3 GB" or
     "Process detail not available for this metric."
   - Line 3, chips: `Ongoing since 22:35` / `22:35 – 23:55 · cleared` / `expired: device not seen since …`
     (from `deviceLastSeenAt`) / `expired: no data for this metric` / `closed: detection turned off` /
     `Dismissed · snoozed until 28 Sep` ; `3rd time in 7 days` when
     `recurrence_count ≥ 1`; `Alert` link when promoted; `17 detections` toggle.
   - Actions (open only): **Dismiss for 7 days** · **Resolve** · **Promote to alert** (or **Open alert**).
     Dismissed-and-snoozed cards show **Stop snoozing**.
   - Expanded: member table (window, observed, baseline, score) from the detail endpoint, fetched on
     first expand.
   - Focused episode (from `ref`) gets the existing ring highlight.
3. Empty states: "No open anomalies — recent metrics are within baseline." with a "Show recently
   closed" link when any exist.
   - Freshness: while any open episode is shown and the tab is visible (`document.visibilityState`),
     the list re-fetches every 60 s without a loading flash; the timer stops when the tab is hidden,
     when no open episode is shown, and on unmount.
   - Unresolved `ref`: when a deep link's `ref` resolves to no episode (`focusedEpisodeId: null` — a
     detection older than episode grouping), the panel fetches the legacy `GET
     /devices/:id/anomalies?status=all` list and shows that one row read-only with "This detection
     predates episode grouping".
4. Remediation suggestions render **inside** an open card only when `ml.remediation_suggestions.enabled`
   is on; otherwise nothing (today it renders a disabled button).
5. The v1-shadow comparison renders only when `ml.anomalies.v1_shadow.enabled` is on; otherwise
   nothing (today it renders a "disabled" placeholder block).
6. Compact mode (Performance tab): open episodes only, max 3, sentence + chips, no actions.

All mutations go through `runAction`. Copy lives in `apps/web/src/locales/en/devices.json` under
`deviceAnomaliesPanel.*`; the sentence templates take `{metric}`, `{range}`, `{duration}`,
`{baseline}` and use the existing `formatMetricValue` rules.

## 14. Data changes and tenancy contract

Migration `apps/api/migrations/2026-10-28-100000-metric-anomaly-episodes.sql` (must sort after the
newest file on `origin/main`, currently `2026-10-27-120000-partner-notify-on-behalf-acceptance.sql` (checked 2026-09-22); re-check at push time — the pre-push
guard does). Idempotent throughout. Contents:

1. `CREATE TABLE IF NOT EXISTS metric_anomaly_episodes …` with the CHECKs of §4.1.
2. `ALTER TABLE metric_anomaly_episodes ENABLE ROW LEVEL SECURITY; … FORCE ROW LEVEL SECURITY;` and
   the four `breeze_org_isolation_*` policies on `public.breeze_has_org_access(org_id)`, exactly as
   `2026-06-18-z-metric-anomalies.sql` does.
3. Indexes of §4.1.
4. `ALTER TABLE metric_anomalies ADD COLUMN IF NOT EXISTS episode_id …`; drop and re-create
   `metric_anomalies_status_check` to include `cleared`; the two indexes of §4.1/§10.
5. `ALTER TABLE metric_anomaly_incidents ADD COLUMN IF NOT EXISTS episode_id uuid`, `… ADD COLUMN IF
   NOT EXISTS suppressed_by_episode boolean NOT NULL DEFAULT false`; index on `episode_id`.
6. No row writes, so no `set_config('breeze.scope','system')` is needed; the migration RLS-scope
   test's baseline must not be touched. Inline `CREATE INDEX` (no `CONCURRENTLY`): `metric_anomalies`
   holds tens of thousands of rows per busy partner, not millions.

Tenancy shape: **1** (direct `org_id`, auto-discovered by `rls-coverage`). Registrations, all in W01 (PR W01a):

| Registry | Entry |
|---|---|
| `CORE_ORG_CASCADE_DELETE_ORDER` (`services/tenantCascade.ts`) | `metric_anomaly_episodes`, alphabetical (sorts after `metric_anomalies`, before `metric_anomaly_incidents`); the only FK into it from an org table is `metric_anomalies.episode_id ON DELETE SET NULL`, and `metric_anomalies` sorts first anyway |
| `CORE_DEVICE_CASCADE_DELETE_TABLES` and `CORE_DEVICE_ORG_DENORMALIZED_TABLES` (`routes/devices/core.ts`) | `metric_anomaly_episodes` |
| `orgMergeRegistry.ts` | `metric_anomaly_episodes: repoint` |
| `CORE_TENANT_EXPORT_POLICY` (`services/tenantExportPolicyRegistry.ts`) | new table: every column `included` except `attribution` → `excludedOpen`; **existing entries amended**: `metric_anomalies.episode_id` → included, `metric_anomaly_incidents.episode_id` and `suppressed_by_episode` → included |
| `mlOutputRetention.ts` | delete `metric_anomaly_episodes WHERE last_seen_at < cutoff` after the `metric_anomalies` pass, same 365-day default |
| Drizzle schema | `apps/api/src/db/schema/metricAnomalyEpisodes.ts`, exported from `schema/index.ts`; `pnpm db:check-drift` clean |

Verification as `breeze_app` (step 6 of the tenancy workflow): a forged cross-tenant insert into
`metric_anomaly_episodes` fails with `new row violates row-level security policy`; recorded in the
W01 PR.

## 15. Error handling and observability

- Stage timeouts: skipped with a warning and the counter of §7.
- Attach conflict (two writers, one key): `ON CONFLICT` on the partial unique index, then re-attach;
  never a 23505 escaping the stage.
- `promote` when `promoteMetricAnomalyToAlert` reports `disabled` or `not_found`: 409 / 404 with
  the service's message; the episode is untouched.
- Attribution lookup finds no sample: `attribution` stays NULL; not an error.
- Baseline fallback: counter only; no log line per device (a fleet-wide burst would flood).
- Web: `runAction` surfaces every mutation outcome; `ActionError` 401 defers to the auth redirect.

## 16. Testing

Unit (`apps/api`, `apps/web`, Test API / Test Web jobs):

- `episodeKeyFor` covers every metric name in §4.2 and the unknown-name fallback.
- Attach predicate: inside gap, just outside gap (31 min → new episode), before `first_seen_at −
  gap` (backfill orphan → new episode).
- Sentence formatter: one case per family and per anomaly type, single-bucket range, empty
  attribution, `_sum` vs `_max` wording.
- Route schemas: action enum, 409 on closed episode, `ref` resolution for both id kinds.
- Panel: open / recently closed / all filters, each chip state, actions call `runAction`, hidden
  blocks when flags are off, compact mode cap.

Integration (`vitest.integration.config.ts`, Integration Tests job, real Postgres):

- 17 consecutive anomalous buckets → exactly one open episode, `bucket_count = 17`, peak fields
  correct, `metric_names` merged for the ram pair.
- Two bursts 31 minutes apart → two episodes, second has `recurrence_count = 1`.
- Auto-resolve: 6 clean rollup buckets on every member metric → `cleared`, members `cleared`,
  promoted member untouched, linked alert resolved; 5 clean buckets → still open; series absent
  with device reporting → `expired_no_data` at 24 h; device `last_seen_at` stale → `expired_offline`.
- With `ml.anomalies.enabled = false` the resolve stage still runs and closes open episodes as
  `detection_off` even when clean rollups exist; with it on, eligibility waits for the range end to
  pass `last_seen_at + gap + 5 min`.
- A user dismiss that commits between the planner read and the attach wins: the dismissed episode
  gains no open members, and the rows become a snoozed successor next tick.
- `recurrence_count` of a replayed burst counts only episodes that closed before its first bucket.
- An incident is created already carrying its episode's id.
- Snooze: dismiss, then a new anomalous bucket 10 minutes later → successor created dismissed/snoozed,
  members dismissed, no feedback rows.
- Anti-contamination: 6-hour synthetic burst still detected at hour 5; fallback counter increments
  when the filtered baseline is short.
- Feedback: an episode dismiss over 17 members yields 17 joinable `anomaly` rows and the evaluation
  endpoint's `feedback.total` moves by 17.
- Publisher: 3 incidents on one episode → one published, two `suppressed_by_episode`; an unlinked
  incident dispatches at once.
- Dismiss (like resolve) of a promoted episode resolves its linked alert unless `resolveAlert:
  false`; a `detection_off` close never does.
- Contract suites: `tenantCascade`, `tenant-export-policy`, `tenantExportErasureRoundtrip`,
  `orgMergeRegistry`, `rls-coverage`, `cascadeDelete`, `moveOrg.coverage`, `autoMigrate`.

## 17. Wave split (one PR each)

| Wave | Content | Depends on |
|---|---|---|
| W01 API core (three PRs, one wave issue) | **W01a**: migration, Drizzle schema, shared types, `cleared` status, all registrations of §14, retention, `episodeKeyFor` + constants. **W01b**: assembly stage, auto-resolve stage (flag-independent, `detection_off`), attribution LATERAL, incident `episode_id` at insert, integration proofs. **W01c**: anti-contamination + fallback | — (W01b and W01c each depend on W01a only) |
| W02 API surface | episode routes (list/detail/PATCH), promotion via episode + `context.episodeId`, alert auto-resolve on clear/expire, snooze/unsnooze, publisher gate, per-member feedback rows, `cleared` in legacy enums | W01a + W01b |
| W03 Evaluation | `anomaly_episode` feedback source type (CHECK migration + shared union), episode-level block in `/analytics/anomalies/evaluation`, `cleared` excluded from human-label rates, runbook section | W02 |
| W04 Web | panel rewrite, i18n, `alertMlContext` episode link, hide flag-off blocks, compact mode, tests | W02 (W03 optional) |

W03 is deliberately separate so an Integration Tests failure in the evaluation math is attributable
to it alone.

## 18. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Disabling the flag strands open episodes | The resolve stage runs outside the flag gate (D4) and closes them as `detection_off`, never as a fake `cleared`; integration test proves it |
| Backfill replay corrupts episodes | Lower bound on attach; auto-resolve skipped for explicit-window jobs; `recurrence_count` episode-relative |
| A human dismiss races the assembly tick | Anchors locked `FOR UPDATE`; attach/recompute only on a still-open or live-snoozed episode; integration test |
| Anti-contamination silences detection on long bursts | Fallback to unfiltered baseline under 12 buckets; hour-5 proof |
| Evaluation labels silently vanish | Per-member feedback rows with `dedupeKey episode:<id>`; test asserts `feedback.total` moves |
| `cleared` misread as a human verdict | Excluded from human-label rates in W03; before W03 it is its own bucket, never merged into `resolved` |
| Whole-org sweeps time out at fleet scale | Set-based statements, the indexes of §4.1, 24 h lookback bound, skip counter |
| New column on `metric_anomalies` / `metric_anomaly_incidents` reds Integration Tests | Export-policy entries amended in W01 (the "fires on a new column" rule) |
| Three grouping grains confuse readers | Schema header + runbook state that incidents are the dispatch outbox and episodes the lifecycle |
| Migration name sorts behind `origin/main` | Named `2026-10-28-…`; pre-push guard re-checks |

## 19. Follow-ups (not in this spec)

- Fleet-level episode list (`GET /orgs/:id/anomaly-episodes`) and a "Recurring on N devices" view.
- AI pilot: `anomalyContext` reads the episode (duration, attribution, recurrence) instead of the
  bucket; incident grain moves to the episode; `metric_anomaly_incidents` retired.
- Numeric tuning per partner (`ml.anomalies.gap_minutes` etc.) — needs a numeric resolver path in
  `mlFeatureFlags.ts`; today all flags are boolean.
- Per-device-class floors (server vs workstation), or promotion of the v1 seasonal model.
- Remediation-suggestion quality (keyword match today) and its settings toggle.
- "View in metrics" deep link from a card into the Performance chart at the episode's window.
- Permanent suppression ("mute until changed") for recurring scheduled-task anomalies: a dismiss
  only snoozes for 7 days, and a scheduled task that still fires afterwards needs another dismiss.

## 20. Quorum record

Fable position: §2 as first drafted (episode table, extend-then-repeat, cascade to members, single
episode feedback row, auto-resolve in the flag-gated range function, `recurrence_of` self-FK,
anti-contamination excluding every non-dismissed anomalous bucket). Independent review: Opus,
fresh context, repo access, ten questions, adversarial brief.

| Q | Verdict | Resolution |
|---|---|---|
| Q1 extend-vs-repeat, 30 min | AMEND | adopted: lower bound on attach (backfill); close by "no new bucket", not baseline re-entry; named constants |
| Q2 episode key | AMEND | adopted: `source_table` in the key; only cpu/ram pairs collapse; §4.3 states episode ≠ incident |
| Q3 status model | AGREE + correction | adopted: cascades only `WHERE status = 'open'` |
| Q4 auto-resolve | DISAGREE | adopted in full: `source_table` + `bucket_seconds` in the clean predicate; ALL metric names; `expired_offline` vs `expired_no_data`; resolve outside the flag gate |
| Q5 feedback cascade | DISAGREE | adopted: per-member `anomaly` rows keep evaluation joinable; auto-resolve → `cleared`, not `resolved`; `anomaly_episode` needs CHECK + shared union (W03) |
| Q6 attribution | AGREE + amend | adopted: LATERAL set-based; empty disk/net handled; `excludedOpen` stated |
| Q7 anti-contamination | AGREE on wave, DISAGREE on predicate | adopted: exclude only open-episode buckets; fallback under 12; covering index; hour-5 proof |
| Q8 performance | DISAGREE | adopted: own stages after `incidents`; partial unique index; 24 h scan bound; skip counter |
| Q9 CLAUDE.md | 3 findings | adopted: export-policy amendment for the new columns; migration named against `origin/main`; no `CONCURRENTLY` |
| Q10 cuts / missing | mixed | adopted: drop `recurrence_of` FK (count only); one dispatch per episode (D11); dismiss = snooze (D8); close reason shown in UI. **Held:** keep `peak_metric_name`/`peak_baseline_value` (the card sentence needs them without a second query); keep the "Recently closed" filter (the owner asked for history explicitly) |

## 21. Plan-time amendments

Accepted when the four wave plans were reconciled (2026-09-22); the per-wave list is in the plan
index under "Accepted deviations from the spec". Assembly can close episodes itself: a new burst more
than `EPISODE_GAP_MINUTES` after an open episode supersedes and closes it (`cleared` with enough
clean buckets in between, else `expired_no_data`), and `assembleMetricAnomalyEpisodes` returns those
closes so they reach the same close handler as auto-resolve. A snoozed successor is itself extended
by later buckets instead of spawning one dismissed episode per tick, and `bucket_count` counts
distinct buckets. The close handler (linked-alert auto-resolve) runs once per detection run, after
the stage transactions commit and outside any DB context. The incident publisher gates on a sibling
already published or dispatched and allows one incident per episode per claim. (A publisher grace
window for unlinked incidents, added at reconciliation, was withdrawn by the second quorum: incidents
are now created already linked, §11.) The episode routes live on the
existing `anomaliesRoutes` (`routes/devices/anomalies.ts`), not a new module. Per-member feedback
rows are written inside the action transaction by a throwing writer, so a lost label rolls the
action back; the episode-level `anomaly_episode` row (W03) follows the same rule and is emitted only
for resolve and dismiss (`anomaly_episode.resolved|dismissed`). The web panel keeps its Open /
Recently closed / All filter in component state, not the URL hash. The `scan-orgs` fan-out also
includes orgs that still own an open episode, so an org whose devices were all decommissioned still
gets `episode-resolve`. The episode DTO adds `peakAnomalyId` so remediation suggestions key on a real
anomaly id.

## 22. Second quorum (Fable, 2026-09-22)

A second fresh-context review (Fable, repo access, adversarial brief, ten questions) was run against
the reconciled plans. The orchestrator re-verified its key claims against code before adopting
(the attach step had no episode-status guard; `origin/main`'s newest migration already sorted after
both placeholder names). Every amendment below is applied to this spec, the plan index and the four
wave plans.

| Q | Topic | Verdict | Resolution |
|---|---|---|---|
| Q1 | Product shape and close boundary | AGREE model, AMEND boundary | A4: resolve eligibility bounded by the run's detection end (`last_seen_at + gap + 5 min ≤ to`) so the boundary bucket is evaluated before close; expiry stays now-relative (§7). A12: "mute until changed" follow-up for recurring scheduled tasks (§19) |
| Q2 | W01 assembly correctness | AMEND | A1: attach/recompute only onto an episode still `open` or a live snoozed successor, live anchors locked `FOR UPDATE`; race integration test (§6). A2: `recurrence_count` episode-relative (§6). A3: non-head backfill island under a live snooze is `historical`. Overlapping ticks, backfill vs scan, late and out-of-order buckets: AGREE, safe under the per-org lock |
| Q3 | W01 auto-resolve | AMEND | A5: with detection off, open episodes close as `detection_off` (new close reason; no feedback; no alert resolve), never `cleared` (§7). Clean predicate, offline/no-data split, flag-independent resolve, scan-orgs ∪ open-episode orgs: AGREE |
| Q4 | Anti-contamination + fallback | AGREE | Cannot silence detection (worst case = today) and cannot hold an episode open beyond ~24.5 h. A12: "dismiss lets the baseline absorb the behaviour" documented (§10, runbook) |
| Q5 | Tenancy / migration | AGREE, two traps | A10: migrations renamed `2026-10-28-100000-…` / `2026-10-28-110000-…` (hardcoded test path fixed); execution-time re-check kept. Stale `alertService.ts` line reference fixed to `:455-457` |
| Q6 | W02 publisher, feedback, close handler, routes | AMEND publisher | A6: `episodes` runs before `incidents`; incidents carry `episode_id` at insert (`COALESCE` on conflict); link statement, wrapper and 15-minute grace deleted (§11). D-7 throwing per-member writer, D-8 post-commit handler, D-3 routes on `anomaliesRoutes`: AGREE |
| Q7 | W03 evaluation | AGREE | `cleared` (and other automatic closes) excluded from human-label rates; note that open member rows stay in the member-level denominator. New `anomaly_episode.*` event types kept |
| Q8 | W04 states | AMEND | A9: 60 s visible-tab poll; read-only legacy fallback when `ref` matches no episode; `deviceLastSeenAt` on the DTO for the offline chip (§12, §13) |
| Q9 | Owner decisions | (a) AMEND (b) drop (c) AMEND | (a) A7: dismissing a promoted episode resolves its alert by default (§8.1, §8.2). (b) grace removed by A6. (c) A8: `humanLabelledShare` counts `user` closes and promotions, excludes `snoozed` from the denominator |
| Q10 | Wave split | AMEND | A11: W01 split into three PRs under #6651 — W01a schema/migration/registrations, W01b assembly/resolve/wiring, W01c anti-contamination (§17) |

Plan-time decision beyond the review: a `detection_off` close never auto-resolves a linked alert
(detection did not observe recovery); the alert stays for the alert workflow.
