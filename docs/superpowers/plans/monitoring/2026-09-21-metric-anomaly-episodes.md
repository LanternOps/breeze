---
tracking_issue: (to be set by register_feature)
---
# Metric Anomaly Episodes — Plan Index

**Spec:** `docs/superpowers/specs/monitoring/2026-09-21-metric-anomaly-episodes-design.md`
(owner asked for plans 2026-09-22; spec sections are cited as §N below and in every wave plan).

One plan document per wave. Each wave is one PR on its own branch
`feature/<parent#>-metric-anomaly-episodes/wave-<sub-issue#>` with `Closes #<sub-issue#>` in the
PR body. State lives on GitHub (feature-lifecycle); the wave issue is the source of truth for
status, never this index.

| Wave | Plan | Depends on |
|---|---|---|
| W01 | [API core: schema, migration, assembly, auto-resolve, attribution, anti-contamination, registrations](2026-09-21-metric-anomaly-episodes-w01-api-core.md) | — |
| W02 | [API surface: episode routes, actions + snooze, promotion, alert auto-resolve, per-member feedback, dispatch per episode](2026-09-21-metric-anomaly-episodes-w02-api-surface.md) | W01 merged |
| W03 | [Evaluation: `anomaly_episode` feedback source, episode block in evaluation, `cleared` excluded from label rates, runbook](2026-09-21-metric-anomaly-episodes-w03-evaluation.md) | W02 merged |
| W04 | [Web: device panel rewrite, sentence cards, filters, alert deep link, i18n](2026-09-21-metric-anomaly-episodes-w04-web.md) | W02 merged (W03 optional) |

## Cross-wave interface contract

Every wave plan uses exactly these names. A wave that needs a name not listed here adds it to
this table in the same PR. Reconciled across all four plans on 2026-09-22: the owning wave's plan is
the source of truth for its rows, and later waves conform. Paths are relative to the repo root;
`services/…`, `routes/…`, `jobs/…` are under `apps/api/src/`.

| Name | Where | Defined in | Shape |
|---|---|---|---|
| `metricAnomalyEpisodes`, `MetricAnomalyEpisodeRow` | `apps/api/src/db/schema/metricAnomalyEpisodes.ts` (re-exported from `schema/index.ts`) | W01 | Drizzle table, columns per spec §4.1 in camelCase; widths `episode_key varchar(200)`, `metric_family varchar(120)`, `peak_metric_name varchar(120)` (W01 dev. 5); `MetricAnomalyEpisodeRow = $inferSelect` — W02 re-exports it, never redefines it |
| `metricAnomalies.episodeId` | `apps/api/src/db/schema/analytics.ts` | W01 | `uuid('episode_id')` nullable, FK → episodes `ON DELETE SET NULL`; indexes `metric_anomalies_episode_id_idx`, `…_unassigned_open_idx`, `…_device_metric_window_idx` |
| `metricAnomalyIncidents.episodeId`, `.suppressedByEpisode` | `apps/api/src/db/schema/metricAnomalyIncidents.ts` | W01 (columns), W02 (written) | `uuid` (no FK), `boolean notNull default false` |
| migration `2026-10-27-100000-metric-anomaly-episodes.sql` | `apps/api/migrations/` | W01 | placeholder name — re-check against `origin/main` at execution (see execution notes); table + RLS + indexes + new columns + `metric_anomalies_status_check` with `cleared`; writes no rows |
| `METRIC_ANOMALY_STATUSES` / `MetricAnomalyStatus` | `packages/shared/src/types/metricAnomalyEpisodes.ts` (exported from `@breeze/shared`) | W01 | `['open','dismissed','promoted','resolved','cleared'] as const` — `cleared` = closed by episode auto-resolve, never a human label |
| `METRIC_ANOMALY_EPISODE_STATUSES` / `MetricAnomalyEpisodeStatus` | same file | W01 | `['open','resolved','dismissed'] as const` (promotion is a link, not a status) |
| `EPISODE_CLOSE_REASONS` / `EpisodeCloseReason` | same file | W01 | `['cleared','expired_offline','expired_no_data','user','snoozed'] as const` |
| `ATTRIBUTION_DIMENSIONS` / `AttributionDimension`, `AttributionProcess`, `AttributionSnapshot`, `EpisodeAttribution` | same file | W01 | `['cpu','ramMb','diskBps','netBps']`; `{ name; pid; value }`; `{ sampledAt: string; dimension; processes: AttributionProcess[] }`; `{ opened?: AttributionSnapshot; peak?: AttributionSnapshot }` |
| `EPISODE_GAP_MINUTES`, `EPISODE_CLEAN_BUCKETS`, `EPISODE_EXPIRE_HOURS`, `EPISODE_RECURRENCE_DAYS`, `EPISODE_SNOOZE_DAYS`, `EPISODE_ASSEMBLY_LOOKBACK_HOURS`, `EPISODE_BUCKET_SECONDS` | defined in `services/metricAnomalyEpisodeKeys.ts` (leaf), re-exported from `services/metricAnomalyEpisodes.ts` | W01 | `number`; defaults 30 / 6 / 24 / 7 / 7 / 24 / 300; env override `METRIC_ANOMALY_EPISODE_<NAME>` (positive ints; `EPISODE_BUCKET_SECONDS` not overridable) |
| `episodeKeyFor(sourceTable, anomalyType, metricName)`, `EPISODE_METRIC_FAMILIES` | same pair of files | W01 | `→ { episodeKey: string; metricFamily: string; attributionDimension: AttributionDimension \| null }`; unknown metric → `metricFamily = metricName` |
| `assembleMetricAnomalyEpisodes(range: MetricAnomalyRange)` | `services/metricAnomalyEpisodes.ts` | W01 | `→ Promise<EpisodeCloseResult[]>` = the open episodes it **superseded** and closed; runs inside the `episodes` stage's system context |
| `resolveMetricAnomalyEpisodes(orgId: string, now?: Date)` | same file | W01 | `→ Promise<EpisodeCloseResult[]>`; runs as stage `episode-resolve` inside a system context |
| `EpisodeCloseResult`, `EpisodeAutoCloseReason` | same file | W01 | `{ episodeId: string; deviceId: string; linkedAlertId: string \| null; closeReason: EpisodeAutoCloseReason }`, `'cleared' \| 'expired_offline' \| 'expired_no_data'` |
| `EpisodeCloseHandler`, `setEpisodeCloseHandler(fn)`, `notifyEpisodesClosed(orgId, closed)` | same file | W01 declares (no-op default), W02 registers | `(orgId: string, closed: EpisodeCloseResult[]) => Promise<void>`; `setEpisodeCloseHandler(fn: EpisodeCloseHandler \| null)` (`null` restores the no-op); `notifyEpisodesClosed` never throws (logs + Sentry). **Call site:** once per `detectMetricAnomaliesRange`, after the stage loop, with the closes of every *completed* `episodes` and `episode-resolve` stage — after both transactions commit, outside any DB context |
| `MetricAnomalyTrigger`, `MetricAnomalyRange.trigger` | `services/metricAnomalies.ts` | W01 | `'scan' \| 'backfill'`, default `'scan'`; `enqueueMetricAnomalyBackfill` and the CLI set `'backfill'`, which skips `episode-resolve`; job data `DetectOrgRangeJobData.trigger?` |
| `METRIC_ANOMALY_STAGES`, `MetricAnomalyResult.episodesClosed` | same file | W01 | `['baseline','growth-trend','process-runaway','incidents','episodes','episode-resolve','v1-shadow']`; `number`. Flag off → only `episode-resolve` runs, result `{ statements: 0, skipped: true, skippedReason: 'ml-disabled', stages, episodesClosed }` |
| `scan-orgs` org selection (`findAnomalyOrgRows`) | `jobs/metricAnomalies.ts` | W01 | orgs with a live (non-decommissioned, non-ephemeral) device ∪ orgs owning an `open` episode |
| `recordEpisodeStageSkipped(stage)`, `recordBaselineFallback(detector, pairs)` | `services/metricAnomalyEpisodeMetrics.ts` | W01 | counters `metric_anomaly_episode_stage_skipped_total{stage}`, `metric_anomaly_baseline_fallback_total{detector}` |
| legacy list `status=cleared` | `routes/devices/anomalies.ts` (`anomaliesQuerySchema`) | W01 | `z.enum([...METRIC_ANOMALY_STATUSES, 'all'])`; per-row PATCH enum unchanged (`cleared` is machine-only). W02 only verifies |
| episode routes | registered on the existing `anomaliesRoutes` in `routes/devices/anomalies.ts` (no new module; MCP_COVERAGE gap #6141, W02 D-3) | W02 | `GET /devices/:id/anomaly-episodes?status=open\|closed\|all&limit=1..100&ref=<uuid>` → `MetricAnomalyEpisodeListResponse`; `GET /devices/:id/anomaly-episodes/:episodeId` → `{ data: MetricAnomalyEpisodeDetailDto }`; `PATCH /devices/:id/anomaly-episodes/:episodeId` body `{ action: EpisodeAction; note?: string (≤500); resolveAlert?: boolean = true }` → `{ data: MetricAnomalyEpisodeDto; meta: { alertId: string \| null; alertResolved: boolean; labelledMembers: number } }`; errors 400 / 403 (site) / 404 (cross-org, unknown) / `409 { error: string; reason: EpisodeActionConflict }` |
| `EPISODE_ACTIONS` / `EpisodeAction` | `packages/shared/src/types/metricAnomalyEpisodes.ts` | W02 | `['resolve','dismiss','promote','unsnooze'] as const` |
| `EPISODE_LIST_STATUSES` / `EpisodeListStatus`, `EPISODE_DETAIL_MEMBER_LIMIT` | same file | W02 | `['open','closed','all'] as const` (`closed` = resolved/dismissed with `resolved_at ≥ now − 7 d`); `200` |
| `MetricAnomalyEpisodeDto` | same file | W02 | every §4.1 column camelCase (timestamps ISO strings) + `durationSeconds`, `ongoing`, `promoted`, `snoozed`, `rangeMin`/`rangeMax: number \| null` (min/max `observedValue` over members whose `metricName = peakMetricName`, W02 D-6), `peakAnomalyId: string \| null` (highest-score member, for remediation lookups, W02 D-9) |
| `MetricAnomalyEpisodeMemberDto`, `MetricAnomalyEpisodeDetailDto`, `MetricAnomalyEpisodeListResponse` | same file | W02 | member `{ id, metricName, anomalyType, status: MetricAnomalyStatus, windowStart, windowEnd, observedValue, baselineValue, baselineMax, score, confidence, linkedAlertId }`; detail = DTO + `members` (≤ 200, `window_start` asc) + `membersTruncated: boolean`; list `{ data: MetricAnomalyEpisodeDto[]; focusedEpisodeId: string \| null }` — `focusedEpisodeId` is the episode a `ref` (episode id **or** member anomaly id) resolved to, always `data[0]` when non-null |
| `listDeviceEpisodes`, `getDeviceEpisodeDto`, `getDeviceEpisodeDetail`, `serializeMetricAnomalyEpisode`, `EPISODE_CLOSED_WINDOW_DAYS` | `services/metricAnomalyEpisodeQueries.ts` | W02 | read side of §12, scoped by `(org_id, device_id)`; ambient request context |
| `applyEpisodeAction(input)`, `ApplyEpisodeActionInput`, `ApplyEpisodeActionResult`, `EpisodeActionConflict`, `decideEpisodeAction` | `services/metricAnomalyEpisodeActions.ts` | W02 | input `{ orgId; deviceId; episodeId; action; note?; resolveAlert?; actorUserId: string; now? }` → `{ status: 'not_found' } \| { status: 'conflict'; reason; message } \| { status: 'ok'; episodeId; action; alertId; alertResolved; labelledMemberIds; feedbackInserted }` (`feedbackInserted` counts member rows only). Runs on the request transaction; `FOR UPDATE` on the episode first; private `resolveEpisode` / `dismissEpisode` are where W03 adds its row. Conflicts: `episode_closed`, `already_promoted`, `not_snoozed`, `no_promotable_member`, `promotion_disabled` |
| `emitMlFeedbackEvents(inputs, database?)`, `ML_FEEDBACK_BATCH_SIZE` | `services/mlFeedback.ts` | W02 | `→ Promise<{ inserted: number }>`; requires `dedupeKey` on every event; `ON CONFLICT DO NOTHING` on the semantic unique; **throws** (never best-effort) |
| `emitAnomalyEpisodeMemberFeedback(options)` | `services/mlFeedbackEmitters.ts` | W02 | one `sourceType: 'anomaly'` row per labelled member, `eventType: 'anomaly.<outcome>'`, `dedupeKey: 'episode:<episodeId>'`, `metadata.episodeId`; throws; called inside the action transaction (W02 D-7) |
| `PromoteMetricAnomalyToAlertOptions.episodeId` | `services/metricAnomalyPromotion.ts` | W02 | written to `alerts.context.episodeId` only — **never** `alerts.episode_id` (that column is the monitor-breach episode, #5290) |
| `registerEpisodeCloseAlertHandler()`, `handleEpisodesClosed`, `resolveAlertsForAutoClosedEpisodes(orgId, now?)`, `autoResolveNoteFor`, `EPISODE_ALERT_CATCHUP_HOURS` | `services/metricAnomalyEpisodeAlerts.ts` | W02 | registered in `initializeMetricAnomaliesWorker`; re-derives work from the DB (auto-closed ≤ 24 h, alert `active`, not `requires_human`); notes `Auto-resolved: anomaly episode cleared` / `… expired`; opens its own `withSystemDbAccessContext` |
| `assembleEpisodesAndLinkIncidents(range)`, `linkMetricAnomalyIncidentsToEpisodes(orgId)` | `services/metricAnomalyEpisodeIncidents.ts` | W02 | the `episodes` stage entry: `→ Promise<EpisodeCloseResult[]>` — returns assembly's supersede closes unchanged so they reach `notifyEpisodesClosed`; link sets `episode_id` on undispatched incidents (highest-score member's episode) in the same transaction |
| `EPISODE_INCIDENT_LINK_GRACE_MINUTES`, `PublishIncidentsResult.suppressed`, `ClaimedIncidentRow.suppressed_by_episode` | `jobs/metricAnomalyIncidentPublisher.ts` | W02 | `15`; claim publishes at most one incident per episode, marks the rest `suppressed_by_episode` + dispatched; unlinked incidents wait out the grace window |
| episode integration fixtures (`seedTenant`, `insertEpisodeDevice`, `seedEpisode`, `seedAlert`, `seedIncident`, `insertCleanRollups`) | `apps/api/src/__tests__/integration/metricAnomalyEpisodeFixtures.ts` | W02 | helper module (not a test); W03 reuses it |
| migration `2026-10-27-110000-ml-feedback-anomaly-episode-source.sql` | `apps/api/migrations/` | W03 | placeholder — must sort after W01's final name and `origin/main`; re-creates `ml_feedback_events_source_type_check` with `anomaly_episode`; writes no rows |
| `'anomaly_episode'`, `'anomaly_episode.dismissed'`, `'anomaly_episode.resolved'` | `ML_FEEDBACK_SOURCE_TYPES`, `ML_FEEDBACK_EVENT_TYPES` in `packages/shared/src/validators/mlFeedback.ts` | W03 | new source type + the only two episode-level event types (promote/unsnooze never emit one) |
| `emitAnomalyEpisodeFeedback(options)` | `services/mlFeedbackEmitters.ts` | W03 | `{ orgId; episodeId; eventType: 'anomaly_episode.dismissed' \| 'anomaly_episode.resolved'; outcome: 'dismissed' \| 'resolved'; actorUserId?; occurredAt: Date; metadata? } → Promise<number>`; uses W02's throwing `emitMlFeedbackEvents`; called in W02's `resolveEpisode` / `dismissEpisode` right after the member rows, same transaction |
| evaluation response additions | `routes/analytics.ts` `GET /analytics/anomalies/evaluation` | W03 | additive: `status.cleared` (excluded from `total` and every rate), `episodes: { total; byStatus{open,resolved,dismissed}; byCloseReason{cleared,expired_offline,expired_no_data,user,snoozed}; medianDurationSeconds: number \| null; recurrenceShare; humanLabelledShare }`; `feedback` still counts `sourceType = 'anomaly'` only |
| `formatEpisodeSentence(episode, t)`, `EpisodeSentenceInput` | `apps/web/src/components/devices/anomalyEpisodeSentence.ts` | W04 | `→ { headline: string; attributionLine: string }`; input = `Pick<MetricAnomalyEpisodeDto, …>` + attribution (a full DTO is assignable); null range → peak value |
| `AnomalyEpisodeCard` (`onChanged`, `onStale`), `AnomalyEpisodeMembers` | `apps/web/src/components/devices/` | W04 | card consumes W02's DTO and PATCH envelope; 409 → `onStale()` → panel refetch; remediation keyed on `peakAnomalyId`; detections chip = `bucketCount`; members read `{ data: MetricAnomalyEpisodeDetailDto }` |
| `MetricAnomalyAlertContext.episodeId`, `anomalyDeepLinkHash(context)` | `apps/web/src/components/alerts/alertMlContext.ts` | W04 | `#anomalies/<episodeId>` when W02's `context.episodeId` exists, else `#anomalies/<anomalyId>`; the panel passes either as `ref` and rings `focusedEpisodeId` |

## Accepted deviations from the spec

Each plan carries its own deviation table with evidence; all are **accepted** as of plan
reconciliation (2026-09-22). One line each:

**W01**
1. Assembly also closes: an open episode superseded by a new island > gap later is closed (`cleared` with ≥ 6 clean buckets per metric before the new island, else `expired_no_data`); backfill orphans and older islands are created already closed.
2. The gap is measured end-to-start in both directions (lower bound 5 min more lenient than the spec).
3. A live snoozed successor is an attach target, so a burst that continues while snoozed builds one silent episode, not one per tick.
4. `bucket_count` = distinct `window_start`s, not member rows (the ram/cpu pairs write two rows per bucket).
5. Column widths: `metric_family varchar(120)`, `episode_key varchar(200)`, `peak_metric_name varchar(120)`.
6. Growth rows (`memory_growth`, `disk_growth`) are not used for baseline exclusion.
7. Alert resolve on auto-close is W02's handler; W01 ships a no-op.
8. `assembleMetricAnomalyEpisodes` returns `Promise<EpisodeCloseResult[]>` (its supersedes).
9. `scan-orgs` also selects orgs that own an open episode (orgs with no live device still get `episode-resolve`); the flag gate moves inside `detectMetricAnomaliesRange`.
10. Stage order `baseline, growth-trend, process-runaway, incidents, episodes, episode-resolve`, then the optional `v1-shadow`.
11. Flag-off result shape `{ statements: 0, skipped: true, skippedReason: 'ml-disabled', stages: [episode-resolve], episodesClosed }`.
12. Historical episodes created already closed get `resolved_at` = start of the next island (they do not appear under "Recently closed"); snoozed successors keep `resolved_at = now()`.
13. `metric_anomaly_baseline_fallback_total` gains a `detector` label.

**W02**
- D-1 Publisher suppresses on a sibling already published or with an agent run, and allows one incident per episode per claim batch.
- D-2 Unlinked incidents wait `EPISODE_INCIDENT_LINK_GRACE_MINUTES` (15) so assembly can link them first.
- D-3 Episode routes live on the existing `anomaliesRoutes`, not a new `anomalyEpisodesRoutes` module.
- D-4 `unsnooze` clears the snooze on every snoozed episode of the same (device, key).
- D-5 Promote targets the highest-score `open`/`promoted` member; feedback goes to rows that end up `promoted`.
- D-6 `rangeMin`/`rangeMax` are taken over members of the peak metric only.
- D-7 Per-member feedback is written by a throwing batch writer inside the request transaction.
- D-8 The close handler runs after the stage transactions commit, outside any DB context (W01's call site), and re-derives its work from the DB.
- D-9 The DTO adds `peakAnomalyId` so the web card can key remediation suggestions on a real anomaly id.
- Note: `alerts.episode_id` is the monitor-breach episode (#5290); the anomaly episode id goes only into `alerts.context.episodeId`.

**W03**
1. Episode-level rows use new event types `anomaly_episode.dismissed|resolved`; only resolve/dismiss emit one (spec §8.3 said "one row per action"; promote and unsnooze never close an episode).
2. The `episodes` evaluation block's fields are defined by W03 (spec named the need, not the shape).
3. Route line numbers follow the current tree (`analytics.ts:1090-1334`).
4. The episode-level row uses W02's throwing writer inside the action transaction and is counted apart from `feedbackInserted` and the evaluation `feedback` block.

**W04**
1. "N detections" is `bucketCount` (distinct buckets); the member table shows a Metric column because pairs write two rows per bucket.
2. Remediation suggestions key on `peakAnomalyId`, not the episode id.
3. The Open / Recently closed / All filter lives in component state, not the URL hash (`#anomalies/<id>` already carries the focus target).

## Execution notes that apply to every wave

- **Migration names** are chosen at execution time against `origin/main`, never from a stale
  worktree: `git ls-tree --name-only origin/main apps/api/migrations/ | sort | tail -1`, then pick
  a `YYYY-MM-DD-HHMMSS-` prefix that sorts after it. The plans use `2026-10-27-100000` (W01) and
  `2026-10-27-110000` (W03) as placeholders for that rule; rename if main has moved past them. W03's
  file must also sort after W01's *final* name. Both plans carry this re-check as a step; the
  pre-push guard (`check-migration-naming.sh --against-ref origin/main`) enforces it again.
- **Contract suites need a live DB** (`pnpm test-stack up`; `pnpm test-stack down` when done).
  W01 and W03 must run the integration + `test:rls-coverage` suites locally before opening the PR.
- **Codex was at its usage limit** when this was written (until 2026-09-26); drivers are Claude
  subagents. Review per CLAUDE.md: one independent round; W01 is tenancy/migration so it gets a
  Sonnet or Opus reviewer.
