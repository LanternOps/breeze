# Breeze ML Operations Runbook

This runbook covers the ML/AI surfaces shipped by the 2026-06 roadmap stack:
alert correlation, RCA, metric rollups, anomalies, remediation suggestions,
device reliability evaluation, ticket triage, and user-risk scoring.

The v0 rule for operators is simple: these systems may create predictions,
groups, labels, and suggestions, but they must not execute remediation without
an explicit user action through the existing approval/script rails.

## Emergency Disable

Use a global kill switch when any ML producer is creating bad output or excess
load:

```bash
ML_FEATURES_DISABLED=true
```

Equivalent global switches are also supported:

```bash
ML_OUTPUTS_DISABLED=true
ML_GLOBAL_KILL_SWITCH=true
```

To disable selected flags without suppressing every ML surface:

```bash
ML_DISABLED_FLAGS=ml.rca.enabled,ml.anomalies.*
```

Per-flag switches are also supported. Examples:

```bash
ML_ALERT_CORRELATION_DISABLED=true
ML_RCA_DISABLED=true
ML_ANOMALIES_DISABLED=true
ML_REMEDIATION_SUGGESTIONS_DISABLED=true
ML_TICKET_TRIAGE_DISABLED=true
ML_USER_RISK_V0_DISABLED=true
```

After changing environment variables, restart the API/worker process that owns
the producer. The flag helpers read env at call time, but existing long-running
jobs may already be in memory.

## Feature Flags

Org and partner settings can override defaults. Supported shapes:

```json
{
  "mlFeatureFlags": {
    "ml.rca.enabled": true
  },
  "ml": {
    "anomalies": {
      "enabled": true,
      "create_alerts": false
    }
  }
}
```

Current flags:

| Flag | Default | Produces |
| --- | --- | --- |
| `ml.alert_correlation.enabled` | internal/dev on, production off | Alert correlation work |
| `ml.rca.enabled` | off | RCA explanations |
| `ml.metric_rollups.enabled` | on | Metric rollup buckets |
| `ml.anomalies.enabled` | off | Metric anomaly rows |
| `ml.anomalies.create_alerts` | off | Alert promotion from anomalies |
| `ml.remediation_suggestions.enabled` | off | Suggested remediation rows |
| `ml.ticket_triage.enabled` | off | Ticket triage suggestions |
| `ml.device_reliability.enabled` | on | Device reliability score computation |
| `ml.user_risk_v0.enabled` | on | Rules-v0 user-risk scoring and signals |
| `ml.user_risk_v1.enabled` | off | Future learned baseline |

## Evaluation Endpoints

Use these before tuning or replacing a heuristic:

```bash
curl -H "Authorization: Bearer <token>" \
  "https://<host>/api/alerts/correlations/evaluation?labelWindowDays=30"

curl -H "Authorization: Bearer <token>" \
  "https://<host>/api/analytics/anomalies/evaluation?range=30d"

curl -H "Authorization: Bearer <token>" \
  "https://<host>/api/reliability/evaluation?orgId=<org-id>"

curl -H "Authorization: Bearer <token>" \
  "https://<host>/api/tickets/triage-evaluation?orgId=<org-id>"

curl -H "Authorization: Bearer <token>" \
  "https://<host>/api/user-risk/evaluation?orgId=<org-id>&days=30"

curl -H "Authorization: Bearer <token>" \
  "https://<host>/api/remediation-suggestions/evaluation?orgId=<org-id>&days=30"
```

Key metrics:

| Surface | Primary metric |
| --- | --- |
| Alert correlation | Group compression fields plus split/merge/dismiss feedback labels |
| RCA | Helpful/not-helpful and usage labels |
| Anomalies | Dismiss/promote/resolve rates |
| Remediation | Accepted, edited, rejected, executed, failed, approval latency |
| Reliability | Precision against failure/replacement labels |
| Ticket triage | Override rate for category/priority/assignee |
| User risk | True-positive rate, training completion, repeat signal rate |

## Anomaly Episodes

The anomaly pipeline has three grouping grains — don't confuse them:

| Grain | Table | Purpose |
| --- | --- | --- |
| Per-bucket row | `metric_anomalies` | one row per device × metric × anomaly type × 5-min bucket; the raw evidence |
| Dispatch outbox | `metric_anomaly_incidents` | AI-pilot dispatch queue, same per-bucket grain, gains `episode_id` (set when the incident is created — assembly runs first) + `suppressed_by_episode` so only one incident per episode is actually published |
| Lifecycle | `metric_anomaly_episodes` | one row per contiguous run of anomalous buckets for a (device, episode key); what the tech-facing panel shows |

### Lifecycle

`open → resolved` (human, or automatic `cleared`/`expired_offline`/`expired_no_data`/`detection_off`)
or `open → dismissed` (human, or an already-snoozed successor). Closed episodes are never reopened;
new activity after a close starts a new episode with `recurrence_count` = episodes with the same
(device, episode key) that closed in the 7 days **before this episode's first bucket** — relative to
the episode, not to "now", so a backfill replay gets the count it would have had live.

Member `metric_anomalies` rows cascade to the episode's new status **only while still `open`** — a
promoted member keeps its `promoted` status regardless of what the episode does next. Auto-resolve
(`cleared`) sets open members to a `cleared` status that is distinct from a human `resolved`.

### Constants (defined in `apps/api/src/services/metricAnomalyEpisodeKeys.ts`, re-exported from `metricAnomalyEpisodes.ts`; override with env `METRIC_ANOMALY_EPISODE_<NAME>`, e.g. `METRIC_ANOMALY_EPISODE_GAP_MINUTES`, positive integers only)

| Constant | Default | Meaning |
| --- | --- | --- |
| `EPISODE_GAP_MINUTES` | 30 | max gap between anomalous buckets inside one episode; auto-resolve only looks at an episode once a detection run has covered the bucket `last_seen_at + gap` |
| `EPISODE_CLEAN_BUCKETS` | 6 | clean 5-min rollup buckets required (per member metric) to auto-resolve |
| `EPISODE_EXPIRE_HOURS` | 24 | no clean data for this long → expired instead of resolved |
| `EPISODE_RECURRENCE_DAYS` | 7 | window before an episode's first bucket for `recurrence_count` |
| `EPISODE_SNOOZE_DAYS` | 7 | how long a user dismiss silences the episode key on that device |
| `EPISODE_ASSEMBLY_LOOKBACK_HOURS` | 24 | how far back the assembly scan looks for unassigned `metric_anomalies` rows |
| `EPISODE_MIN_BUCKETS` | 2 | distinct buckets a new episode needs (persistence gate). A shorter island stays unassigned while another bucket could still join it, then its rows close `cleared` with no episode and no incident. Buckets that join an existing episode are never gated |

### Detection gates (2026-09-26 tuning)

Tuned against 25 h of US prod data (≈60 devices): 245 episodes, 72% of them a single 5-minute
bucket, mostly Defender, Windows Update, indexers and backup agents that the device runs on a
schedule. Two gates, together about −87% episodes:

- **Persistence**: `EPISODE_MIN_BUCKETS` above.
- **Novelty**: upward detectors (spike, network_egress, process_runaway, including the
  process-sample series) require the bucket to exceed the highest bucket of its own 24 h baseline
  (`baseline_max`, open-episode buckets excluded). A level the device already reached yesterday is
  routine. Growth and drop detectors are not novelty-gated.

Also: `process_count` needs `+25%` and `+50` processes over baseline (was `+20`); growth scores
are `4 × growth / gate` (the z-score detectors' scale) instead of raw MB/GB/points, so promoted
growth alerts no longer all map to `critical`; `ram_used_mb`/`disk_used_gb` share the `ram`/`disk`
episode family with `ram_percent`/`disk_percent`.

### Close reasons

| `close_reason` | Meaning | Human label? |
| --- | --- | --- |
| `cleared` | auto-resolved — 6+ clean rollup buckets after the last anomalous bucket | no |
| `expired_offline` | auto-resolved after 24h with no clean data because the device itself is offline | no |
| `expired_no_data` | auto-resolved after 24h with no clean data while the device is still checking in (series stopped: sampling disabled, agent downgrade, metric removed) | no |
| `detection_off` | `ml.anomalies.enabled` was turned off for the org: every open episode closes on the next scan, because rollups no detector evaluated cannot prove the device recovered. Members become `cleared`; a linked alert is **not** auto-resolved | no |
| `user` | a human clicked Resolve or Dismiss | yes |
| `snoozed` | a new episode opened for a key a human dismissed within the last `EPISODE_SNOOZE_DAYS`; created already-dismissed | no (the label was on the *original* dismiss, not this successor) |

Assembly can close an episode too: when a new burst for the same (device, key) starts more than
`EPISODE_GAP_MINUTES` after an open episode ended, the old one is superseded and closed — `cleared`
if every member metric had ≥ `EPISODE_CLEAN_BUCKETS` clean buckets in between, else
`expired_no_data`. Backfill history older than the current episode is created already closed with
the same rule. Both flow to the same close handler as auto-resolve (linked alert auto-resolved).

The resolve stage runs **even when `ml.anomalies.enabled` is off** — turning off detection must not
freeze open episodes forever — but then it closes them as `detection_off`, never `cleared`. The
10-minute `scan-orgs` job also picks up orgs that have no live device left but still own an open
episode, so those close too.

### Snooze

Dismiss = dismiss-and-snooze: `snoozed_until = now() + EPISODE_SNOOZE_DAYS` on that (device, episode
key). A new episode opened for a still-snoozed key is created already-dismissed
(`close_reason: 'snoozed'`) — auditable, silent, no feedback row. `unsnooze` (`PATCH
/devices/:id/anomaly-episodes/:id { action: 'unsnooze' }`) clears `snoozed_until` without changing
status. Dismissing (or resolving) a promoted episode also resolves its linked alert unless the
request says `resolveAlert: false`.

**Dismissing an episode lets the baseline absorb the behaviour:** snoozed successors are dismissed,
so their buckets are not excluded from the baseline, and the key usually stops firing even after the
snooze ends. There is no permanent suppression yet: a recurring scheduled task (the hourly `:30`
process spike) that still fires after the snooze needs another dismiss. "Mute until changed" is a
tracked follow-up (spec §19).

### Reading the evaluation endpoint

```bash
curl -H "Authorization: Bearer <token>" \
  "https://<host>/api/analytics/anomalies/evaluation?range=30d"
```

- `status.cleared` is reported separately from `status.{open,dismissed,promoted,resolved}` and is
  **excluded** from `total` and every rate in `rates` — it is an automatic close, not a human label.
  Don't read a rising `status.cleared` as a rising dismiss rate; read it alongside `episodes.byCloseReason.cleared`
  as "detection volume that resolved itself without a human looking at it."
- `episodes.byStatus` / `episodes.byCloseReason` are per-episode counts (contrast with the top-level
  `status`, which is per-*member-row*) — an episode with 17 members counts once here.
- `episodes.medianDurationSeconds` is the median `resolved_at − first_seen_at` over episodes that
  closed in the window; `null` when none have closed yet.
- `episodes.recurrenceShare` = episodes with `recurrence_count >= 1` ÷ all episodes in the window — a
  high share on one device/key points at a scheduled task or a real unfixed problem re-triggering
  detection, not detector noise.
- `episodes.humanLabelledShare` = closed episodes a human labelled — closed with `close_reason: 'user'`
  **or** promoted to an alert (`linked_alert_id` set), however they closed afterwards — ÷ closed
  episodes **except** `snoozed` successors (those echo an earlier dismiss; they are not new episodes
  awaiting a verdict). `cleared` / `expired_*` / `detection_off` closes stay in the denominator — they
  are episodes nobody looked at. Low + a high `episodes.byCloseReason.cleared` share means the fleet is
  mostly self-resolving and techs rarely need to look — that's the target steady state, not a problem.
  Member-level `total` and `rates` still count `open` rows (only `cleared` is excluded there).
- The v1-shadow block (`includeV1=true`) is unaffected by episodes — it still compares
  `metric_anomaly_candidates` to `metric_anomalies` at the per-bucket grain, per-member feedback rows
  still join to it exactly as before.

## V1 Promotion Baselines

Before enabling a learned v1 model, compare it to the active v0 rule/heuristic
over the same org cohort and evaluation window. The v1 candidate must beat the
v0 metric below before rollout:

| Future v1 surface | v0 metric to beat |
| --- | --- |
| Alert correlation | Lower correction rate from `feedback.totalCorrections` while preserving `compressionRatio` |
| RCA | Higher helpful rate from `rcaFeedback.helpful` versus `rcaFeedback.notHelpful` and `rcaFeedback.edited` |
| Anomalies | Lower `rates.dismissRate`; use `rates.promoteRate` and `rates.resolveRate` as guardrails |
| Remediation | Higher `rates.acceptRate` with no worse `rates.failureRate` |
| Reliability | Higher `precision` from `/api/reliability/evaluation` |
| Ticket triage | Lower `overrideRate` from `/api/tickets/triage-evaluation` |
| User risk | Higher `precision` from `/api/user-risk/evaluation` |

## Feedback Labels

Canonical labels live in `ml_feedback_events`. They are append-only and deduped
by source, event type, and occurrence time. Use labels rather than ad hoc
product tables when evaluating output quality.

Useful label families:

| Domain | Labels |
| --- | --- |
| Device reliability | `device.failure_confirmed`, `device.replaced`, `device.false_alarm` |
| Ticket triage | `ticket.category_changed`, `ticket.priority_changed`, `ticket.assignee_changed` |
| User risk | `user_risk.true_positive`, `user_risk.false_positive`, `training.assigned`, `training.completed` |
| Remediation | `suggestion.accepted`, `suggestion.edited`, `suggestion.rejected`, `suggestion.executed`, `suggestion.failed` |
| RCA | `rca.helpful`, `rca.not_helpful`, `rca.edited`, `rca.used_in_ticket` |

## Worker Checks

Confirm workers are active from logs:

```bash
docker compose logs api | grep -E "metric|anomaly|correlation|remediation|userRisk"
```

Expected queue names include:

| Queue | Purpose |
| --- | --- |
| `metric-rollups` | Metric rollup computation |
| `metric-rollup-maintenance` | Rollup partition upkeep and rollup retention |
| `alert-correlation` | Alert grouping and clustering |
| `metric-anomalies` | Anomaly detection |
| `ml-output-retention` | Bounded pruning for metric anomalies and remediation suggestions |
| `reliability-scoring` | Device reliability score computation |
| `user-risk-scoring` | User-risk scoring and signal ingestion |

If a queue is backing up, disable the relevant flag first, then inspect Redis
and worker logs. Do not delete jobs until you know whether the worker writes are
idempotent for that queue.

Remediation suggestions are generated on demand through the remediation
suggestion route/service. They do not currently have a dedicated BullMQ queue.

## Retention

Feedback labels in `ml_feedback_events` are long-lived evaluation assets and
are not pruned by the ML output retention worker. Model output rows are bounded:

| Data | Default | Environment knobs |
| --- | --- | --- |
| `metric_anomalies` | 365 days by `detected_at` | `ML_OUTPUT_RETENTION_DAYS`, `ML_OUTPUT_RETENTION_BATCH_SIZE`, `ML_OUTPUT_RETENTION_MAX_BATCHES` |
| `remediation_suggestions` | 365 days by `created_at` | same as above |
| `metric_rollups` | tier-specific in rollup maintenance | `METRIC_ROLLUP_RETENTION_*` / maintenance settings |
| user-risk score snapshots | compacted after 90 days | `USER_RISK_RETENTION_*` |

The ML output worker deletes in bounded `ctid` batches and reports whether more
rows remain after the configured batch cap. If it repeatedly reports `hasMore`,
increase `ML_OUTPUT_RETENTION_MAX_BATCHES` temporarily or run the queue more
often rather than issuing an unbounded manual `DELETE`.

## Debugging By Surface

Alert correlation:
- Check `/api/alerts/correlations` list/detail responses for the org.
- Confirm new alert writes are not doing inline correlation work.
- Use split/merge/dismiss labels to decide whether grouping rules are too broad.

Metric rollups:
- Verify `metric_rollups` has recent 5-minute buckets for the org/device.
- Hourly and daily buckets must not compute p95 from lower-level p95 values.
- If capacity or anomaly reads look empty, compare raw `device_metrics` windows
  against rollup windows before changing thresholds.

Anomalies:
- Keep `ml.anomalies.create_alerts` off until dismiss/promote rates are acceptable.
- Review anomaly status counts before increasing sensitivity.
- For a bounded manual replay after rollups are present, run:
  `pnpm --filter @breeze/api metric-anomalies:backfill -- --org-id <org-id> --from <iso> --to <iso>`.

Remediation suggestions:
- Suggestions should reference existing scripts/templates where possible.
- Check `/api/remediation-suggestions/evaluation?days=30` before changing match
  rules. Watch accept/edit/reject rates before treating suggestions as useful.
- Approval latency comes from linked elevation requests. If high-risk
  suggestions fail execution, confirm `elevationRequestId` points to an
  approved, same-org, same-device elevation request that has not expired.
- Execution must go through existing script/approval paths. There is no
  separate ML approval bypass.

Device reliability:
- Check `/api/reliability/evaluation` before changing thresholds.
- False alarms should be labeled from the device reliability panel.

Ticket triage:
- Keep `ml.ticket_triage.enabled` off for orgs without clean categories.
- Use override rate as the main signal. High override rate means the suggestion
  rules or category hygiene are not ready for model work.

User risk:
- Check `/api/user-risk/evaluation?days=30`.
- Rules-v0 signal ingestion currently reads script execution batches, remote
  sessions, elevation requests, and Cloudflare Access login countries.
- Generic impossible-travel scoring needs a production GeoIP source; do not
  enable it from IP strings alone.

## Tuning Rules

Tune one surface at a time:

1. Disable alert promotion or execution-producing flags first.
2. Change one threshold or rule group.
3. Run the relevant focused tests.
4. Compare evaluation metrics over the same time window before and after.
5. Re-enable output writes only when false positives and operator overrides are
   acceptable.

## Local Validation

Focused checks used by the roadmap stack:

```bash
/usr/local/bin/corepack pnpm --filter @breeze/api exec tsc --noEmit
/usr/local/bin/corepack pnpm --filter @breeze/web exec tsc --noEmit
/usr/local/bin/corepack pnpm --filter @breeze/api exec vitest run src/services/userRiskSignals.test.ts src/jobs/userRiskJobs.test.ts
/usr/local/bin/corepack pnpm --filter @breeze/web exec vitest run src/lib/__tests__/no-silent-mutations.test.ts
```

Schema drift check:

```bash
DATABASE_URL=postgresql://breeze:breeze@localhost:5432/breeze \
  /usr/local/bin/corepack pnpm --filter @breeze/api db:check-drift
```

If local Postgres reports `role "breeze" does not exist`, the check reached
Postgres but the local DB role setup is incomplete. Fix the local role before
using drift status as evidence.
