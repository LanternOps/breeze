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
