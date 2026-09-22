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
this table in the same PR.

| Name | Where | Defined in | Shape |
|---|---|---|---|
| `metricAnomalyEpisodes` | `apps/api/src/db/schema/metricAnomalyEpisodes.ts` (re-exported from `schema/index.ts`) | W01 | Drizzle table, columns per spec §4.1, camelCase |
| `metricAnomalies.episodeId` | `apps/api/src/db/schema/analytics.ts` | W01 | `uuid('episode_id')` nullable |
| `metricAnomalyIncidents.episodeId`, `.suppressedByEpisode` | `apps/api/src/db/schema/metricAnomalyIncidents.ts` | W01 (columns), W02 (used) | `uuid`, `boolean notNull default false` |
| `EPISODE_GAP_MINUTES` … `EPISODE_ASSEMBLY_LOOKBACK_HOURS` | `apps/api/src/services/metricAnomalyEpisodes.ts` | W01 | exported `number` constants, spec §5 table |
| `episodeKeyFor(sourceTable: string, anomalyType: string, metricName: string)` | same file | W01 | `→ { episodeKey: string; metricFamily: string; attributionDimension: 'cpu' \| 'ramMb' \| 'diskBps' \| 'netBps' \| null }` |
| `assembleMetricAnomalyEpisodes(range: MetricAnomalyRange)` | same file | W01 | `→ Promise<void>`; runs as detector stage `'episodes'` |
| `resolveMetricAnomalyEpisodes(orgId: string, now?: Date)` | same file | W01 | `→ Promise<EpisodeCloseResult[]>`; runs as stage `'episode-resolve'` |
| `EpisodeCloseResult` | same file | W01 | `{ episodeId: string; deviceId: string; linkedAlertId: string \| null; closeReason: 'cleared' \| 'expired_offline' \| 'expired_no_data' }` |
| `onEpisodesClosed` hook | same file | W01 declares (no-op default), W02 wires | `setEpisodeCloseHandler(fn: (orgId: string, closed: EpisodeCloseResult[]) => Promise<void>)` |
| `MetricAnomalyRange.trigger` | `apps/api/src/services/metricAnomalies.ts` | W01 | `'scan' \| 'backfill'`, default `'scan'`; `enqueueMetricAnomalyBackfill` sets `'backfill'`, which skips `episode-resolve` |
| `MetricAnomalyStatus` | `packages/shared/src/types/metricAnomalyEpisodes.ts` | W01 | `'open' \| 'dismissed' \| 'promoted' \| 'resolved' \| 'cleared'` |
| `MetricAnomalyEpisodeStatus`, `EpisodeCloseReason` | same file | W01 | `'open' \| 'resolved' \| 'dismissed'`; `'cleared' \| 'expired_offline' \| 'expired_no_data' \| 'user' \| 'snoozed'` |
| `EpisodeAttribution` | same file | W01 | `{ opened?: AttributionSnapshot; peak?: AttributionSnapshot }`, `AttributionSnapshot = { sampledAt: string; dimension: 'cpu'\|'ramMb'\|'diskBps'\|'netBps'; processes: Array<{ name: string; pid: number; value: number }> }` |
| `MetricAnomalyEpisodeDto` | same file | W02 | spec §12 serialization: §4.1 columns camelCase (ISO strings for timestamps) + `durationSeconds`, `ongoing`, `promoted`, `snoozed`, `rangeMin`, `rangeMax` (min/max member `observedValue`, used by the card sentence) |
| `EpisodeAction` | same file | W02 | `'resolve' \| 'dismiss' \| 'promote' \| 'unsnooze'` |
| `anomalyEpisodesRoutes` | `apps/api/src/routes/devices/anomalyEpisodes.ts`, mounted in `routes/devices/index.ts` | W02 | `GET /:id/anomaly-episodes`, `GET /:id/anomaly-episodes/:episodeId`, `PATCH /:id/anomaly-episodes/:episodeId` |
| `applyEpisodeAction(...)` | `apps/api/src/services/metricAnomalyEpisodeActions.ts` | W02 | see W02 plan |
| `formatEpisodeSentence(episode, t)` | `apps/web/src/components/devices/anomalyEpisodeSentence.ts` | W04 | `→ { headline: string; attributionLine: string }` |

## Execution notes that apply to every wave

- **Migration names** are chosen at execution time against `origin/main`, never from a stale
  worktree: `git ls-tree --name-only origin/main apps/api/migrations/ | sort | tail -1`, then pick
  a `YYYY-MM-DD-HHMMSS-` prefix that sorts after it. The plans use `2026-10-27-100000` (W01) and
  `2026-10-27-110000` (W03) as placeholders for that rule; rename if main has moved past them.
- **Contract suites need a live DB** (`pnpm test-stack up`; `pnpm test-stack down` when done).
  W01 and W03 must run the integration + `test:rls-coverage` suites locally before opening the PR.
- **Codex was at its usage limit** when this was written (until 2026-09-26); drivers are Claude
  subagents. Review per CLAUDE.md: one independent round; W01 is tenancy/migration so it gets a
  Sonnet or Opus reviewer.
