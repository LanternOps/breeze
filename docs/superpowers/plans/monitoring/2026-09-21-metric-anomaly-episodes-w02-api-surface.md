# Metric Anomaly Episodes W02 — API Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose metric anomaly episodes over HTTP (list / detail / PATCH actions with snooze), keep evaluation labels intact with one feedback row per cascaded member, promote an episode to one alert that carries `context.episodeId`, close that alert when the episode clears or expires, and dispatch the AI-agent pilot once per episode instead of once per bucket.

**Architecture:** Three new API services sit on top of W01's schema and stages: `metricAnomalyEpisodeQueries.ts` (read + serialize), `metricAnomalyEpisodeActions.ts` (locked, transactional human actions), `metricAnomalyEpisodeAlerts.ts` (the close-handler W01 exposes, wired at worker boot). The routes are registered on the existing `anomaliesRoutes` router in `routes/devices/anomalies.ts` and delegate to those services. Dispatch-per-episode is two changes: a link statement that runs inside W01's `episodes` stage transaction, and an amended claim CTE in the incident publisher.

**Tech Stack:** Hono, Drizzle ORM (PostgreSQL), Zod, Vitest (unit + `vitest.integration.config.ts`), BullMQ publisher job, `@breeze/shared` types.

**Spec:** `docs/superpowers/specs/monitoring/2026-09-21-metric-anomaly-episodes-design.md` (§7 alert half, §8, §11, §12, §17 W02). Index and cross-wave contract: `docs/superpowers/plans/monitoring/2026-09-21-metric-anomaly-episodes.md`.

---

## Spec deviations (code wins; each one is also listed in the PR body)

| # | Spec says | Code fact (file:line) | This plan does |
|---|---|---|---|
| D-1 | §11: the publisher skips an incident "when another incident with the same `episode_id` already has `agent_run_id IS NOT NULL`" | `agent_run_id` is stamped **after** publish by the subscriber, on the event bus, and only when admission succeeds (`apps/api/src/services/aiAgents/metricAnomalySubscriber.ts:50`, `:132-140`, `:196-212`). One claim pass takes up to 200 rows (`apps/api/src/jobs/metricAnomalyIncidentPublisher.ts:47`), so three incidents of one episode claimed together would all publish. | Suppress when a sibling with the same `episode_id` has `agent_run_id IS NOT NULL` **or** was already published (`dispatched_at IS NOT NULL AND suppressed_by_episode = false`), **and** allow only the earliest-`window_start` incident per episode inside one claim batch (`row_number() OVER (PARTITION BY episode_id …) > 1`). |
| D-2 | §11: "Incidents with `episode_id IS NULL` … dispatch as today" | The `incidents` stage commits in its own transaction before the `episodes` stage starts (`apps/api/src/services/metricAnomalies.ts:1205-1222`, one `runDetectionStage` transaction per stage at `:196-214`), and the publisher polls every 5 s (`metricAnomalyIncidentPublisher.ts:46`). A new incident is visible, unlinked, for the whole time between those two commits, so most new incidents would be published before assembly links them. | The claim CTE skips an unlinked incident until it is `EPISODE_INCIDENT_LINK_GRACE_MINUTES` (15) old. Assembly links incidents seconds after they are created, so this only delays incidents that genuinely never get an episode (lookback misses, a timed-out `episodes` stage). |
| D-3 | §12 / index contract: routes live in a new module `routes/devices/anomalyEpisodes.ts` exported as `anomalyEpisodesRoutes` | Every route module needs an `MCP_COVERAGE` entry (`apps/api/src/__tests__/mcp-coverage.test.ts:195-197`). New `gap` entries are refused because the gap list only shrinks (`:1-6`, `FROZEN_GAPS`), and none of the `McpExemptReason` values (`apps/api/src/services/mcpCoverage.ts:12-40`) describes an operator-facing device read/write surface. The per-row anomaly routes already hold the `devices/anomalies.ts` gap (`mcp-coverage.test.ts:67`, frozen under #6141). | Register the three episode endpoints on the existing `anomaliesRoutes` in `routes/devices/anomalies.ts`. They are part of the same resource family and the same #6141 gap. The handlers are thin; all logic lives in the new services. The index row `anomalyEpisodesRoutes` was replaced at plan reconciliation. |
| D-4 | §8.1: `unsnooze` sets `snoozed_until = NULL` "on this episode" | §6 (W01): a new episode is snoozed when **the most recent dismissed episode** for the key has `snoozed_until > now()`, and snoozed successors copy `snoozed_until`. So clearing only an older episode would leave the snooze in force on its successor. | `unsnooze` clears `snoozed_until` on every `dismissed` episode for the same `(device_id, episode_key)` whose `snoozed_until > now()`. |
| D-5 | §8.1: `promote` runs `promoteMetricAnomalyToAlert` "on the peak member" | `promoteMetricAnomalyToAlert` sets `status = 'promoted'` on the row it is given whatever its current status (`apps/api/src/services/metricAnomalyPromotion.ts:258-266`). It also promotes same-window siblings before our cascade runs (`:284-299`), so those siblings would not be in the cascade's `RETURNING`. | Peak = highest-`score` member whose status is `open` or `promoted`; a member a human already dismissed or resolved through the per-row route is never overwritten. Feedback goes to `open-before ∪ cascaded`, filtered to rows that are `promoted` afterwards. |
| D-6 | §12 / index: `rangeMin`/`rangeMax` = min/max member `observedValue` | The ram and cpu families hold both `_sum` and `_max` members (§4.2). One range over both would mix "one process" values with "all top processes" values in one sentence. | Range is taken over members whose `metric_name = peak_metric_name`. The index row says so. |
| D-7 | §8.3 is silent on write semantics | `emitAnomalyFeedback` is best-effort: it swallows and logs errors (`apps/api/src/services/mlFeedbackEmitters.ts:10-16`, `:64-83`). §18 lists "evaluation labels silently vanish" as a risk. | Episode actions write their member feedback rows through a new batch writer that **throws**, inside the request transaction. If the labels cannot be written, the action rolls back with a 500. |
| D-8 | Spec §7 puts the alert resolve inside auto-resolve | `resolveAlert` publishes on the event bus and reads rule/cooldown tables (`apps/api/src/services/alertService.ts:715-830`). Running it inside the `episode-resolve` stage transaction keeps the org advisory lock and a pooled connection held during Redis round trips. A SQL error inside that transaction would also poison it and roll back the episode closes. | The handler runs **after** the stage transactions commit, outside any DB context. W01 already guarantees this: `detectMetricAnomaliesRange` collects the closes of every completed `episodes` and `episode-resolve` stage and calls `notifyEpisodesClosed(orgId, closed)` once after the stage loop (W01 Task 9); `processDetectOrgRange` holds no DB context. Task 7 Step 1 only verifies it. The handler is crash-safe either way: it re-derives its work from the database (auto-closed episodes in the last 24 h whose linked alert is still `active`) instead of trusting the in-memory list. |
| D-9 | §12 serialization lists `durationSeconds`, `ongoing`, `promoted`, `snoozed` (+ `rangeMin`/`rangeMax` in the index) | Remediation suggestions are keyed `sourceType: 'anomaly'` + `metric_anomalies.id` (`apps/web/src/components/remediation/RemediationSuggestionsPanel.tsx:33-34`, `:133`); an episode id finds nothing and `generate` would reference a non-anomaly id. | The DTO adds `peakAnomalyId` (highest-score member, W01's peak rule) so W04's card can mount the remediation block on a real anomaly id. Added at plan reconciliation. |

---

## Global Constraints

- W01 must be merged to `main` first; this wave branches from `origin/main` after that. Branch: `feature/<parent#>-metric-anomaly-episodes/wave-<W02 sub-issue#>`; PR body carries `Closes #<W02 sub-issue#>`.
- Use the index's cross-wave names exactly: `metricAnomalyEpisodes`, `MetricAnomalyEpisodeRow` (W01, `db/schema/metricAnomalyEpisodes.ts`), `metricAnomalies.episodeId`, `metricAnomalyIncidents.episodeId`, `metricAnomalyIncidents.suppressedByEpisode`, `EPISODE_SNOOZE_DAYS`, `assembleMetricAnomalyEpisodes(range) → Promise<EpisodeCloseResult[]>`, `resolveMetricAnomalyEpisodes(orgId, now?)`, `EpisodeCloseResult`, `EpisodeCloseHandler`, `setEpisodeCloseHandler(fn | null)`, `notifyEpisodesClosed`, `MetricAnomalyStatus` / `METRIC_ANOMALY_STATUSES`, `MetricAnomalyEpisodeStatus`, `EpisodeCloseReason`, `EpisodeAttribution`, `MetricAnomalyEpisodeDto`, `EpisodeAction`, `applyEpisodeAction`.
- **Do not redefine W01's shared types.** `packages/shared/src/types/metricAnomalyEpisodes.ts` (and its test file) exist after W01; W02 appends to both and re-declares nothing W01 exports.
- **No migration, no new table, no new column.** W01 owns all schema, registrations and export-policy entries. If a step here seems to need DDL, stop: it is a W01 gap.
- **`alerts.episode_id` is not ours.** That column is the *monitor breach* episode (#5290; `apps/api/src/db/schema/alerts.ts:144-146`, written by `createAlert`/`createSourcedAlert` in `alertService.ts:170,250,380`). The anomaly episode id goes **only** into `alerts.context.episodeId` (JSON). Never set the column.
- Cascades touch member rows **only `WHERE status = 'open'`** (spec §8.2).
- Feedback: one `ml_feedback_events` row per labelled member, `sourceType: 'anomaly'`, `sourceId = member.id`, `eventType = 'anomaly.<dismissed|resolved|promoted>'`, `dedupeKey = 'episode:<episodeId>'`, `metadata.episodeId`. Automatic closes (`cleared`, `expired_*`) and snoozed successors emit **no** feedback. `sourceType: 'anomaly_episode'` is W03's job; do not add it.
- Actions: `resolve` / `dismiss` / `promote` need `status = 'open'` (else 409). `promote` also needs no linked alert (else 409). `unsnooze` needs `status = 'dismissed' AND snoozed_until > now()` (else 409). `resolveAlert` defaults to `true`.
- Alert auto-resolve on automatic close: only when the alert is `active` and `requires_human = false`. Note text is exactly `Auto-resolved: anomaly episode cleared` (close_reason `cleared`) or `Auto-resolved: anomaly episode expired` (`expired_offline` / `expired_no_data`).
- Authorization mirrors the per-row routes exactly: `requireScope('organization', 'partner', 'system')`; `DEVICES_READ` for GETs, `ALERTS_WRITE` for PATCH; `getDeviceWithOrgAndSiteCheck` → 403 on `SITE_ACCESS_DENIED`, 404 when null (cross-org is 404, never 403).
- DB context: route code runs inside the request's `withDbAccessContext` transaction. Services use the ambient `db` and **never** call `runOutsideDbContext` or open a second context. `resolveAlert` and `promoteMetricAnomalyToAlert` join the ambient transaction, because `withDbAccessContext` returns `fn()` directly when a context is held (`apps/api/src/db/index.ts:673-675`).
- List: `status=open|closed|all` (default `open`), `limit` 1..100 (default 25), `ref` = episode id **or** member anomaly id. A `ref` forces `status=all` and puts the referenced episode first. `closed` = `resolved|dismissed` with `resolved_at ≥ now − 7 d`. Detail returns at most 200 members, ordered by `window_start` ascending.
- UUID validation in Zod uses `z.string().guid()`, as the rest of the repo does (`routes/analytics.ts:292`).
- Run tests with `cd apps/api && npx vitest run <files>`. Never `pnpm --filter … test -- --run`. Integration: `pnpm test-stack up` once, then `pnpm --filter @breeze/api test:integration <file>` (no `--`), and `pnpm test-stack down` at the end.
- Typecheck: `cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p .; echo exit=$?`. Read `exit=`. Never pipe tsc into `tail`, because a heap OOM then reads as green.
- End every commit message with the session's attribution trailer.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `packages/shared/src/types/metricAnomalyEpisodes.ts` | modify (W01 creates) | + `EPISODE_ACTIONS`, `EpisodeAction`, `EPISODE_LIST_STATUSES`, `EpisodeListStatus`, `EPISODE_DETAIL_MEMBER_LIMIT`, `MetricAnomalyEpisodeDto`, `MetricAnomalyEpisodeMemberDto`, `MetricAnomalyEpisodeDetailDto`, `MetricAnomalyEpisodeListResponse` |
| `packages/shared/src/types/metricAnomalyEpisodes.test.ts` | append (W01 creates) | constants + DTO type shape |
| `apps/api/src/services/metricAnomalyEpisodeQueries.ts` | create | serializer, `listDeviceEpisodes`, `getDeviceEpisodeDto`, `getDeviceEpisodeDetail` |
| `apps/api/src/services/metricAnomalyEpisodeQueries.test.ts` | create | serializer unit tests |
| `apps/api/src/services/mlFeedback.ts` | modify | + `emitMlFeedbackEvents` (batch, throwing) |
| `apps/api/src/services/mlFeedbackEmitters.ts` | modify | + `emitAnomalyEpisodeMemberFeedback` |
| `apps/api/src/services/metricAnomalyPromotion.ts` | modify | + `episodeId` option → `context.episodeId` |
| `apps/api/src/services/metricAnomalyEpisodeActions.ts` | create | `decideEpisodeAction` (pure), `applyEpisodeAction` |
| `apps/api/src/services/metricAnomalyEpisodeActions.test.ts` | create | precondition unit tests |
| `apps/api/src/routes/devices/anomalies.ts` | modify | + 3 episode endpoints (and `cleared` in the legacy list enum if W01 left it out) |
| `apps/api/src/routes/devices/anomalies.episodes.test.ts` | create | route unit tests |
| `apps/api/src/services/metricAnomalyEpisodeAlerts.ts` | create | close handler + registration |
| `apps/api/src/services/metricAnomalyEpisodeAlerts.test.ts` | create | handler unit tests |
| `apps/api/src/jobs/metricAnomalies.ts` | modify | register the handler at worker init |
| `apps/api/src/services/metricAnomalyEpisodeIncidents.ts` | create | `linkMetricAnomalyIncidentsToEpisodes`, `assembleEpisodesAndLinkIncidents` (returns W01's supersede closes) |
| `apps/api/src/services/metricAnomalyEpisodeIncidents.test.ts` | create | wrapper-order unit test |
| `apps/api/src/services/metricAnomalies.ts` | modify | `episodes` stage calls the wrapper |
| `apps/api/src/jobs/metricAnomalyIncidentPublisher.ts` | modify | amended claim CTE, grace constant, `suppressed` count |
| `apps/api/src/__tests__/integration/metricAnomalyEpisodeFixtures.ts` | create | shared seed helpers (non-test module, precedent `agentRunLineageFixtures.ts`) |
| `apps/api/src/__tests__/integration/metricAnomalyEpisodeQueries.integration.test.ts` | create | list / detail / ref |
| `apps/api/src/__tests__/integration/metricAnomalyEpisodeActions.integration.test.ts` | create | actions, cascade, feedback, alert |
| `apps/api/src/__tests__/integration/metricAnomalyEpisodeAlerts.integration.test.ts` | create | auto-close resolves alert |
| `apps/api/src/__tests__/integration/metricAnomalyEpisodeIncidents.integration.test.ts` | create | incident link + publisher gate |
| `apps/api/src/__tests__/integration/metricAnomalyEpisodeRoutes.integration.test.ts` | create | HTTP: evaluation `feedback.total`, cross-org 404, ref |
| `docs/superpowers/plans/monitoring/2026-09-21-metric-anomaly-episodes.md` | modify | contract rows (Task 11) |

---

### Task 1: Pre-flight on W01 + shared DTO types

**Files:**
- Modify: `packages/shared/src/types/metricAnomalyEpisodes.ts`
- Test: `packages/shared/src/types/metricAnomalyEpisodes.test.ts` (W01 created it; append)

**Interfaces:**
- Consumes (W01): `MetricAnomalyStatus`, `MetricAnomalyEpisodeStatus`, `EpisodeCloseReason`, `EpisodeAttribution` from the same file.
- Produces:
  - `EPISODE_ACTIONS = ['resolve','dismiss','promote','unsnooze'] as const`; `type EpisodeAction`
  - `EPISODE_LIST_STATUSES = ['open','closed','all'] as const`; `type EpisodeListStatus`
  - `EPISODE_DETAIL_MEMBER_LIMIT = 200`
  - `interface MetricAnomalyEpisodeDto`, `interface MetricAnomalyEpisodeMemberDto`, `interface MetricAnomalyEpisodeDetailDto`, `interface MetricAnomalyEpisodeListResponse` (shapes below)

- [ ] **Step 1: Verify W01 is on main and delivered what this wave consumes**

```bash
git fetch origin main
git checkout -b feature/<parent#>-metric-anomaly-episodes/wave-<W02#> origin/main
rg -n "export const metricAnomalyEpisodes" apps/api/src/db/schema/metricAnomalyEpisodes.ts
rg -n "episodeId|suppressedByEpisode" apps/api/src/db/schema/metricAnomalyIncidents.ts apps/api/src/db/schema/analytics.ts
rg -n "export (const|function|async function|type|interface) (assembleMetricAnomalyEpisodes|resolveMetricAnomalyEpisodes|setEpisodeCloseHandler|notifyEpisodesClosed|EpisodeCloseResult|EpisodeCloseHandler)" apps/api/src/services/metricAnomalyEpisodes.ts
rg -n "export const EPISODE_SNOOZE_DAYS" apps/api/src/services/metricAnomalyEpisodeKeys.ts
rg -n "Promise<EpisodeCloseResult\[\]>" apps/api/src/services/metricAnomalyEpisodes.ts
rg -n "METRIC_ANOMALY_STATUSES|MetricAnomalyEpisodeStatus|EpisodeCloseReason|EpisodeAttribution" packages/shared/src/types/metricAnomalyEpisodes.ts
rg -n "metricAnomalyEpisodes" packages/shared/src/types/index.ts
rg -n "notifyEpisodesClosed" apps/api/src/services/metricAnomalies.ts
rg -n "METRIC_ANOMALY_STATUSES" apps/api/src/routes/devices/anomalies.ts
```

Expected: every `rg` prints at least one hit (`EPISODE_SNOOZE_DAYS` lives in the leaf `metricAnomalyEpisodeKeys.ts` and is re-exported from `metricAnomalyEpisodes.ts` by `export *`). If any of the first seven prints nothing, stop: W01 has not merged, or it merged under different names. Reconcile against the index before continuing. The last command confirms W01 Task 1 already put `cleared` in the legacy list enum (`z.enum([...METRIC_ANOMALY_STATUSES, 'all'])`); only if it prints nothing does Task 6 Step 3b apply.

Also run `get_feature_status` for the parent issue, then `start_wave` for the W02 sub-issue (feature-lifecycle skill).

- [ ] **Step 2: Write the failing test**

Append to `packages/shared/src/types/metricAnomalyEpisodes.test.ts` (W01 created it). **Merge** the imports below into the file's existing `vitest` and `./metricAnomalyEpisodes` import statements (add `expectTypeOf` to the first) rather than adding second import statements for the same modules — a second `import { describe, … } from 'vitest'` is a duplicate-binding error:

```ts
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  EPISODE_ACTIONS,
  EPISODE_DETAIL_MEMBER_LIMIT,
  EPISODE_LIST_STATUSES,
  type EpisodeAction,
  type MetricAnomalyEpisodeDetailDto,
  type MetricAnomalyEpisodeDto,
  type MetricAnomalyEpisodeListResponse,
} from './metricAnomalyEpisodes';

describe('metric anomaly episode API contract (W02)', () => {
  it('exposes exactly the four spec §8.1 actions, in order', () => {
    expect([...EPISODE_ACTIONS]).toEqual(['resolve', 'dismiss', 'promote', 'unsnooze']);
    expectTypeOf<EpisodeAction>().toEqualTypeOf<'resolve' | 'dismiss' | 'promote' | 'unsnooze'>();
  });

  it('exposes the three list filters of spec §12', () => {
    expect([...EPISODE_LIST_STATUSES]).toEqual(['open', 'closed', 'all']);
  });

  it('caps detail members at 200 (spec §12)', () => {
    expect(EPISODE_DETAIL_MEMBER_LIMIT).toBe(200);
  });

  it('DTO carries the derived fields the web card needs', () => {
    expectTypeOf<MetricAnomalyEpisodeDto['durationSeconds']>().toEqualTypeOf<number>();
    expectTypeOf<MetricAnomalyEpisodeDto['ongoing']>().toEqualTypeOf<boolean>();
    expectTypeOf<MetricAnomalyEpisodeDto['promoted']>().toEqualTypeOf<boolean>();
    expectTypeOf<MetricAnomalyEpisodeDto['snoozed']>().toEqualTypeOf<boolean>();
    expectTypeOf<MetricAnomalyEpisodeDto['rangeMin']>().toEqualTypeOf<number | null>();
    expectTypeOf<MetricAnomalyEpisodeDto['rangeMax']>().toEqualTypeOf<number | null>();
    expectTypeOf<MetricAnomalyEpisodeDto['firstSeenAt']>().toEqualTypeOf<string>();
    expectTypeOf<MetricAnomalyEpisodeDto['peakAnomalyId']>().toEqualTypeOf<string | null>();
    expectTypeOf<MetricAnomalyEpisodeDetailDto['membersTruncated']>().toEqualTypeOf<boolean>();
    expectTypeOf<MetricAnomalyEpisodeListResponse['focusedEpisodeId']>().toEqualTypeOf<string | null>();
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `cd packages/shared && npx vitest run src/types/metricAnomalyEpisodes.test.ts`
Expected: FAIL, because `EPISODE_ACTIONS` (and the rest) are not exported.

- [ ] **Step 4: Implement**

Append to `packages/shared/src/types/metricAnomalyEpisodes.ts`:

```ts
// ── W02: episode API surface (spec §8.1, §12) ─────────────────────────────

export const EPISODE_ACTIONS = ['resolve', 'dismiss', 'promote', 'unsnooze'] as const;
export type EpisodeAction = (typeof EPISODE_ACTIONS)[number];

export const EPISODE_LIST_STATUSES = ['open', 'closed', 'all'] as const;
export type EpisodeListStatus = (typeof EPISODE_LIST_STATUSES)[number];

/** Spec §12: the detail endpoint returns at most this many members. */
export const EPISODE_DETAIL_MEMBER_LIMIT = 200;

/**
 * Spec §12 serialization: every §4.1 column in camelCase (timestamps as ISO
 * strings) plus derived fields. `rangeMin`/`rangeMax` are min/max observedValue
 * over members whose metric_name equals `peakMetricName` — the ram/cpu families
 * mix `_sum` and `_max` members and a range across both is meaningless.
 */
export interface MetricAnomalyEpisodeDto {
  id: string;
  orgId: string;
  deviceId: string;
  episodeKey: string;
  sourceTable: string;
  anomalyType: string;
  metricFamily: string;
  metricNames: string[];
  status: MetricAnomalyEpisodeStatus;
  closeReason: EpisodeCloseReason | null;
  firstSeenAt: string;
  lastSeenAt: string;
  bucketCount: number;
  peakValue: number;
  peakMetricName: string;
  peakBaselineValue: number | null;
  peakScore: number;
  peakAt: string;
  recurrenceCount: number;
  attribution: EpisodeAttribution | null;
  linkedAlertId: string | null;
  snoozedUntil: string | null;
  resolvedAt: string | null;
  resolvedByUserId: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
  durationSeconds: number;
  ongoing: boolean;
  promoted: boolean;
  snoozed: boolean;
  rangeMin: number | null;
  rangeMax: number | null;
  /**
   * Highest-score member (score DESC, window_start ASC — W01's peak rule).
   * The web card keys remediation suggestions on it (`sourceType: 'anomaly'`,
   * which is keyed by metric_anomalies.id, never an episode id).
   */
  peakAnomalyId: string | null;
}

export interface MetricAnomalyEpisodeMemberDto {
  id: string;
  metricName: string;
  anomalyType: string;
  status: MetricAnomalyStatus;
  windowStart: string;
  windowEnd: string;
  observedValue: number;
  baselineValue: number | null;
  baselineMax: number | null;
  score: number;
  confidence: number;
  linkedAlertId: string | null;
}

export interface MetricAnomalyEpisodeDetailDto extends MetricAnomalyEpisodeDto {
  members: MetricAnomalyEpisodeMemberDto[];
  /** true when the episode has more than EPISODE_DETAIL_MEMBER_LIMIT members. */
  membersTruncated: boolean;
}

export interface MetricAnomalyEpisodeListResponse {
  data: MetricAnomalyEpisodeDto[];
  /** The episode a `ref` resolved to (always data[0] when non-null). */
  focusedEpisodeId: string | null;
}
```

If Step 1 showed that `packages/shared/src/types/index.ts` does not re-export the file, add `export * from './metricAnomalyEpisodes';` next to the other `export *` lines at the top of that index.

- [ ] **Step 5: Run the test and the shared typecheck**

Run: `cd packages/shared && npx vitest run src/types/metricAnomalyEpisodes.test.ts && npx tsc --noEmit -p .; echo exit=$?`
Expected: PASS, `exit=0`.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/types/metricAnomalyEpisodes.ts packages/shared/src/types/metricAnomalyEpisodes.test.ts packages/shared/src/types/index.ts
git commit -m "feat(shared): metric anomaly episode API DTOs and action constants (W02)"
```

---

### Task 2: Episode read service (serializer, list, detail, `ref`)

**Files:**
- Create: `apps/api/src/services/metricAnomalyEpisodeQueries.ts`
- Create: `apps/api/src/services/metricAnomalyEpisodeQueries.test.ts`
- Create: `apps/api/src/__tests__/integration/metricAnomalyEpisodeFixtures.ts`
- Create: `apps/api/src/__tests__/integration/metricAnomalyEpisodeQueries.integration.test.ts`

**Interfaces:**
- Consumes: Task 1 DTO types; W01 `metricAnomalyEpisodes`, `metricAnomalies.episodeId`.
- Produces:
  - re-export of W01's `type MetricAnomalyEpisodeRow` (from `db/schema`; not redefined)
  - `EPISODE_CLOSED_WINDOW_DAYS = 7`
  - `serializeMetricAnomalyEpisode(row: MetricAnomalyEpisodeRow, range: { min: number; max: number; peakAnomalyId?: string | null } | null | undefined, now: Date): MetricAnomalyEpisodeDto`
  - `serializeMetricAnomalyEpisodeMember(row: typeof metricAnomalies.$inferSelect): MetricAnomalyEpisodeMemberDto`
  - `listDeviceEpisodes(input: { orgId: string; deviceId: string; status: EpisodeListStatus; limit: number; ref?: string; now?: Date }): Promise<MetricAnomalyEpisodeListResponse>`
  - `getDeviceEpisodeDto(input: { orgId: string; deviceId: string; episodeId: string; now?: Date }): Promise<MetricAnomalyEpisodeDto | null>`
  - `getDeviceEpisodeDetail(input: { orgId: string; deviceId: string; episodeId: string; now?: Date }): Promise<MetricAnomalyEpisodeDetailDto | null>`
  - Fixtures (integration): `seedTenant()`, `insertEpisodeDevice(orgId, siteId, lastSeenAt?)`, `seedEpisode(opts)`, `seedAlert(opts)`, `seedIncident(opts)`, `insertCleanRollups(opts)`

- [ ] **Step 1: Write the failing serializer unit test**

`apps/api/src/services/metricAnomalyEpisodeQueries.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ db: {} }));

import {
  serializeMetricAnomalyEpisode,
  serializeMetricAnomalyEpisodeMember,
  type MetricAnomalyEpisodeRow,
} from './metricAnomalyEpisodeQueries';

const NOW = new Date('2026-09-22T00:30:00.000Z');

function row(overrides: Partial<MetricAnomalyEpisodeRow> = {}): MetricAnomalyEpisodeRow {
  return {
    id: '55555555-5555-4555-8555-555555555555',
    orgId: '11111111-1111-4111-8111-111111111111',
    deviceId: '22222222-2222-4222-8222-222222222222',
    episodeKey: 'device_metrics:spike:disk_write',
    sourceTable: 'device_metrics',
    anomalyType: 'spike',
    metricFamily: 'disk_write',
    metricNames: ['disk_write_bps'],
    status: 'open',
    closeReason: null,
    firstSeenAt: new Date('2026-09-21T22:35:00.000Z'),
    lastSeenAt: new Date('2026-09-21T23:55:00.000Z'),
    bucketCount: 17,
    peakValue: 153_000_000,
    peakMetricName: 'disk_write_bps',
    peakBaselineValue: 6_000_000,
    peakScore: 9.1,
    peakAt: new Date('2026-09-21T23:10:00.000Z'),
    recurrenceCount: 0,
    attribution: null,
    linkedAlertId: null,
    snoozedUntil: null,
    resolvedAt: null,
    resolvedByUserId: null,
    note: null,
    createdAt: new Date('2026-09-21T22:40:00.000Z'),
    updatedAt: new Date('2026-09-21T23:56:00.000Z'),
    ...overrides,
  } as MetricAnomalyEpisodeRow;
}

describe('serializeMetricAnomalyEpisode', () => {
  it('maps every column to camelCase ISO output and derives duration/ongoing/promoted/snoozed', () => {
    const dto = serializeMetricAnomalyEpisode(row(), { min: 86_000_000, max: 153_000_000 }, NOW);
    expect(dto).toMatchObject({
      id: '55555555-5555-4555-8555-555555555555',
      episodeKey: 'device_metrics:spike:disk_write',
      metricNames: ['disk_write_bps'],
      status: 'open',
      closeReason: null,
      firstSeenAt: '2026-09-21T22:35:00.000Z',
      lastSeenAt: '2026-09-21T23:55:00.000Z',
      peakAt: '2026-09-21T23:10:00.000Z',
      bucketCount: 17,
      durationSeconds: 4800,
      ongoing: true,
      promoted: false,
      snoozed: false,
      snoozedUntil: null,
      resolvedAt: null,
      rangeMin: 86_000_000,
      rangeMax: 153_000_000,
    });
  });

  it('returns null range fields when no member range is known', () => {
    const dto = serializeMetricAnomalyEpisode(row(), undefined, NOW);
    expect(dto.rangeMin).toBeNull();
    expect(dto.rangeMax).toBeNull();
    expect(dto.peakAnomalyId).toBeNull();
  });

  it('carries the peak member id for remediation lookups', () => {
    const dto = serializeMetricAnomalyEpisode(row(), { min: 1, max: 2, peakAnomalyId: '33333333-3333-4333-8333-333333333333' }, NOW);
    expect(dto.peakAnomalyId).toBe('33333333-3333-4333-8333-333333333333');
  });

  it('marks a dismissed episode with a future snooze as snoozed and not ongoing', () => {
    const dto = serializeMetricAnomalyEpisode(row({
      status: 'dismissed',
      closeReason: 'user',
      resolvedAt: new Date('2026-09-22T00:00:00.000Z'),
      snoozedUntil: new Date('2026-09-29T00:00:00.000Z'),
    }), null, NOW);
    expect(dto.ongoing).toBe(false);
    expect(dto.snoozed).toBe(true);
    expect(dto.snoozedUntil).toBe('2026-09-29T00:00:00.000Z');
  });

  it('an expired snooze is not snoozed', () => {
    const dto = serializeMetricAnomalyEpisode(row({
      status: 'dismissed',
      closeReason: 'user',
      resolvedAt: new Date('2026-09-10T00:00:00.000Z'),
      snoozedUntil: new Date('2026-09-17T00:00:00.000Z'),
    }), null, NOW);
    expect(dto.snoozed).toBe(false);
  });

  it('promoted follows linkedAlertId, independent of status', () => {
    const dto = serializeMetricAnomalyEpisode(row({ linkedAlertId: '44444444-4444-4444-8444-444444444444' }), null, NOW);
    expect(dto.promoted).toBe(true);
    expect(dto.ongoing).toBe(true);
  });

  it('never reports a negative duration', () => {
    const t = new Date('2026-09-21T22:35:00.000Z');
    expect(serializeMetricAnomalyEpisode(row({ firstSeenAt: t, lastSeenAt: t }), null, NOW).durationSeconds).toBe(0);
  });
});

describe('serializeMetricAnomalyEpisodeMember', () => {
  it('serializes the member-table columns', () => {
    const dto = serializeMetricAnomalyEpisodeMember({
      id: '33333333-3333-4333-8333-333333333333',
      metricName: 'disk_write_bps',
      anomalyType: 'spike',
      status: 'open',
      windowStart: new Date('2026-09-21T22:35:00.000Z'),
      windowEnd: new Date('2026-09-21T22:40:00.000Z'),
      observedValue: 86_000_000,
      baselineValue: 5_500_000,
      baselineMax: 11_000_000,
      score: 6.2,
      confidence: 0.82,
      linkedAlertId: null,
    } as never);
    expect(dto).toEqual({
      id: '33333333-3333-4333-8333-333333333333',
      metricName: 'disk_write_bps',
      anomalyType: 'spike',
      status: 'open',
      windowStart: '2026-09-21T22:35:00.000Z',
      windowEnd: '2026-09-21T22:40:00.000Z',
      observedValue: 86_000_000,
      baselineValue: 5_500_000,
      baselineMax: 11_000_000,
      score: 6.2,
      confidence: 0.82,
      linkedAlertId: null,
    });
  });
});
```

- [ ] **Step 2: Write the shared integration fixtures**

`apps/api/src/__tests__/integration/metricAnomalyEpisodeFixtures.ts` (a helper module, not a test; the precedent is `agentRunLineageFixtures.ts`):

```ts
import { alerts, devices, metricAnomalies, metricAnomalyEpisodes, metricAnomalyIncidents, metricRollups } from '../../db/schema';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';
import { getTestDb } from './setup';

export const BUCKET_MS = 300_000;

export async function seedTenant() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const user = await createUser({ partnerId: partner.id, orgId: org.id });
  return { partner, org, site, user };
}

let deviceCounter = 0;
export async function insertEpisodeDevice(orgId: string, siteId: string, lastSeenAt: Date = new Date()): Promise<string> {
  deviceCounter++;
  const [row] = await getTestDb()
    .insert(devices)
    .values({
      orgId,
      siteId,
      agentId: `episode-w02-${Date.now()}-${deviceCounter}`,
      hostname: `episode-w02-${deviceCounter}`,
      displayName: `episode-w02-${deviceCounter}`,
      osType: 'linux',
      osVersion: 'test',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      status: 'online',
      enrolledAt: new Date('2026-06-18T00:00:00.000Z'),
      lastSeenAt,
    })
    .returning({ id: devices.id });
  if (!row) throw new Error('insertEpisodeDevice returned no row');
  return row.id;
}

export interface SeedEpisodeOptions {
  orgId: string;
  deviceId: string;
  memberCount: number;
  /** window_start of the first member; members are 5 minutes apart. */
  start: Date;
  metricName?: string;
  metricFamily?: string;
  anomalyType?: string;
  sourceTable?: 'device_metrics' | 'device_process_samples';
  status?: 'open' | 'resolved' | 'dismissed';
  closeReason?: 'cleared' | 'expired_offline' | 'expired_no_data' | 'user' | 'snoozed' | null;
  resolvedAt?: Date | null;
  snoozedUntil?: Date | null;
  linkedAlertId?: string | null;
  memberStatus?: 'open' | 'promoted' | 'dismissed' | 'resolved' | 'cleared';
}

/** Inserts one episode plus `memberCount` member rows. The last member has the highest score (the peak). */
export async function seedEpisode(o: SeedEpisodeOptions): Promise<{ episodeId: string; memberIds: string[]; peakMemberId: string }> {
  const metricName = o.metricName ?? 'disk_write_bps';
  const metricFamily = o.metricFamily ?? 'disk_write';
  const anomalyType = o.anomalyType ?? 'spike';
  const sourceTable = o.sourceTable ?? 'device_metrics';
  const status = o.status ?? 'open';
  const lastSeenAt = new Date(o.start.getTime() + o.memberCount * BUCKET_MS);
  const peakAt = new Date(o.start.getTime() + (o.memberCount - 1) * BUCKET_MS);
  const [episode] = await getTestDb()
    .insert(metricAnomalyEpisodes)
    .values({
      orgId: o.orgId,
      deviceId: o.deviceId,
      episodeKey: `${sourceTable}:${anomalyType}:${metricFamily}`,
      sourceTable,
      anomalyType,
      metricFamily,
      metricNames: [metricName],
      status,
      closeReason: status === 'open' ? null : (o.closeReason ?? 'user'),
      firstSeenAt: o.start,
      lastSeenAt,
      bucketCount: o.memberCount,
      peakValue: 80 + o.memberCount * 4,
      peakMetricName: metricName,
      peakBaselineValue: 6,
      peakScore: 5 + o.memberCount,
      peakAt,
      linkedAlertId: o.linkedAlertId ?? null,
      snoozedUntil: o.snoozedUntil ?? null,
      resolvedAt: status === 'open' ? null : (o.resolvedAt ?? new Date()),
    })
    .returning({ id: metricAnomalyEpisodes.id });
  if (!episode) throw new Error('seedEpisode returned no episode');

  const memberIds: string[] = [];
  for (let i = 0; i < o.memberCount; i++) {
    const windowStart = new Date(o.start.getTime() + i * BUCKET_MS);
    const [member] = await getTestDb()
      .insert(metricAnomalies)
      .values({
        orgId: o.orgId,
        deviceId: o.deviceId,
        sourceTable,
        metricType: 'system',
        metricName,
        anomalyType,
        status: o.memberStatus ?? 'open',
        windowStart,
        windowEnd: new Date(windowStart.getTime() + BUCKET_MS),
        bucketSeconds: 300,
        observedValue: 84 + i * 4,
        baselineValue: 6,
        baselineMin: 2,
        baselineMax: 11,
        score: 5 + i + 1,
        confidence: 0.8,
        sampleCount: 3,
        linkedAlertId: o.memberStatus === 'promoted' ? (o.linkedAlertId ?? null) : null,
        episodeId: episode.id,
      })
      .returning({ id: metricAnomalies.id });
    if (!member) throw new Error('seedEpisode returned no member');
    memberIds.push(member.id);
  }
  return { episodeId: episode.id, memberIds, peakMemberId: memberIds[memberIds.length - 1]! };
}

export async function seedAlert(o: { orgId: string; deviceId: string; requiresHuman?: boolean; status?: 'active' | 'resolved' }): Promise<string> {
  const [row] = await getTestDb()
    .insert(alerts)
    .values({
      ruleId: null,
      orgId: o.orgId,
      deviceId: o.deviceId,
      status: o.status ?? 'active',
      severity: 'high',
      title: 'Metric anomaly promoted: spike on disk_write_bps',
      message: 'seeded by metricAnomalyEpisodeFixtures',
      context: { source: 'metric_anomaly' },
      requiresHuman: o.requiresHuman ?? false,
      triggeredAt: new Date(),
    })
    .returning({ id: alerts.id });
  if (!row) throw new Error('seedAlert returned no row');
  return row.id;
}

export async function seedIncident(o: {
  orgId: string;
  deviceId: string;
  episodeId: string | null;
  windowStart: Date;
  anomalyType?: string;
  createdAt?: Date;
}): Promise<string> {
  const [row] = await getTestDb()
    .insert(metricAnomalyIncidents)
    .values({
      orgId: o.orgId,
      deviceId: o.deviceId,
      anomalyType: o.anomalyType ?? 'spike',
      bucketSeconds: 300,
      windowStart: o.windowStart,
      firstSeenAt: o.windowStart,
      lastSeenAt: o.windowStart,
      peakScore: '7',
      rowCount: 1,
      metricNames: ['disk_write_bps'],
      episodeId: o.episodeId,
      ...(o.createdAt ? { createdAt: o.createdAt } : {}),
    })
    .returning({ id: metricAnomalyIncidents.id });
  if (!row) throw new Error('seedIncident returned no row');
  return row.id;
}

/** `count` clean 5-min rollup buckets with samples, starting at `from` (spec §7 clean predicate). */
export async function insertCleanRollups(o: {
  orgId: string;
  deviceId: string;
  metricName: string;
  from: Date;
  count: number;
  sourceTable?: 'device_metrics' | 'device_process_samples';
}): Promise<void> {
  for (let i = 0; i < o.count; i++) {
    await getTestDb().insert(metricRollups).values({
      orgId: o.orgId,
      sourceTable: o.sourceTable ?? 'device_metrics',
      deviceId: o.deviceId,
      metricType: 'system',
      metricName: o.metricName,
      bucketStart: new Date(o.from.getTime() + i * BUCKET_MS),
      bucketSeconds: 300,
      avgValue: 6,
      minValue: 6,
      maxValue: 6,
      p95Value: 6,
      sumValue: 6,
      sampleCount: 1,
      gapSeconds: 0,
      metadata: { rollupVersion: 'metric-rollups-v1', source: 'raw' },
    });
  }
}
```

If a column name above does not typecheck against W01's Drizzle schema, W01 has diverged from spec §4.1. Use W01's name and note the difference in the PR.

- [ ] **Step 3: Write the failing integration test for list / detail / ref**

`apps/api/src/__tests__/integration/metricAnomalyEpisodeQueries.integration.test.ts`:

```ts
import './setup';

import { describe, expect, it } from 'vitest';
import { withSystemDbAccessContext } from '../../db';
import { getDeviceEpisodeDetail, listDeviceEpisodes } from '../../services/metricAnomalyEpisodeQueries';
import { insertEpisodeDevice, seedEpisode, seedTenant } from './metricAnomalyEpisodeFixtures';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe('metric anomaly episode queries (W02)', () => {
  it('open filter returns only open episodes, newest last_seen_at first', async () => {
    const { org, site } = await seedTenant();
    const deviceId = await insertEpisodeDevice(org.id, site.id);
    const now = new Date();
    const older = await seedEpisode({ orgId: org.id, deviceId, memberCount: 2, start: new Date(now.getTime() - 5 * HOUR), metricName: 'cpu_percent', metricFamily: 'cpu' });
    const newer = await seedEpisode({ orgId: org.id, deviceId, memberCount: 2, start: new Date(now.getTime() - 1 * HOUR) });
    await seedEpisode({ orgId: org.id, deviceId, memberCount: 1, start: new Date(now.getTime() - 3 * HOUR), status: 'resolved', closeReason: 'cleared', metricName: 'ram_percent', metricFamily: 'ram' });

    const result = await withSystemDbAccessContext(() => listDeviceEpisodes({ orgId: org.id, deviceId, status: 'open', limit: 25 }));

    expect(result.focusedEpisodeId).toBeNull();
    expect(result.data.map((e) => e.id)).toEqual([newer.episodeId, older.episodeId]);
    expect(result.data[0]).toMatchObject({ ongoing: true, bucketCount: 2, rangeMin: 84, rangeMax: 88, peakAnomalyId: newer.peakMemberId });
  });

  it('closed filter returns resolved/dismissed episodes closed in the last 7 days only', async () => {
    const { org, site } = await seedTenant();
    const deviceId = await insertEpisodeDevice(org.id, site.id);
    const now = new Date();
    const recent = await seedEpisode({ orgId: org.id, deviceId, memberCount: 1, start: new Date(now.getTime() - 2 * DAY), status: 'resolved', closeReason: 'cleared', resolvedAt: new Date(now.getTime() - 1 * DAY) });
    await seedEpisode({ orgId: org.id, deviceId, memberCount: 1, start: new Date(now.getTime() - 10 * DAY), status: 'dismissed', closeReason: 'user', resolvedAt: new Date(now.getTime() - 8 * DAY), metricName: 'cpu_percent', metricFamily: 'cpu' });
    await seedEpisode({ orgId: org.id, deviceId, memberCount: 1, start: new Date(now.getTime() - HOUR), metricName: 'ram_percent', metricFamily: 'ram' });

    const result = await withSystemDbAccessContext(() => listDeviceEpisodes({ orgId: org.id, deviceId, status: 'closed', limit: 25 }));

    expect(result.data.map((e) => e.id)).toEqual([recent.episodeId]);
  });

  it('ref by member anomaly id forces status=all and returns the containing episode first', async () => {
    const { org, site } = await seedTenant();
    const deviceId = await insertEpisodeDevice(org.id, site.id);
    const now = new Date();
    const closed = await seedEpisode({ orgId: org.id, deviceId, memberCount: 3, start: new Date(now.getTime() - 3 * DAY), status: 'resolved', closeReason: 'cleared', resolvedAt: new Date(now.getTime() - 2 * DAY) });
    const open = await seedEpisode({ orgId: org.id, deviceId, memberCount: 2, start: new Date(now.getTime() - HOUR), metricName: 'cpu_percent', metricFamily: 'cpu' });

    const result = await withSystemDbAccessContext(() => listDeviceEpisodes({
      orgId: org.id, deviceId, status: 'open', limit: 25, ref: closed.memberIds[1],
    }));

    expect(result.focusedEpisodeId).toBe(closed.episodeId);
    expect(result.data.map((e) => e.id)).toEqual([closed.episodeId, open.episodeId]);
  });

  it('ref by episode id works and an unknown ref leaves focusedEpisodeId null', async () => {
    const { org, site } = await seedTenant();
    const deviceId = await insertEpisodeDevice(org.id, site.id);
    const ep = await seedEpisode({ orgId: org.id, deviceId, memberCount: 1, start: new Date(Date.now() - HOUR) });

    const byId = await withSystemDbAccessContext(() => listDeviceEpisodes({ orgId: org.id, deviceId, status: 'open', limit: 25, ref: ep.episodeId }));
    expect(byId.focusedEpisodeId).toBe(ep.episodeId);

    const unknown = await withSystemDbAccessContext(() => listDeviceEpisodes({
      orgId: org.id, deviceId, status: 'open', limit: 25, ref: '99999999-9999-4999-8999-999999999999',
    }));
    expect(unknown.focusedEpisodeId).toBeNull();
    expect(unknown.data.map((e) => e.id)).toEqual([ep.episodeId]);
  });

  it('a ref on another device never resolves (device-scoped lookup)', async () => {
    const { org, site } = await seedTenant();
    const deviceA = await insertEpisodeDevice(org.id, site.id);
    const deviceB = await insertEpisodeDevice(org.id, site.id);
    const epB = await seedEpisode({ orgId: org.id, deviceId: deviceB, memberCount: 1, start: new Date(Date.now() - HOUR) });

    const result = await withSystemDbAccessContext(() => listDeviceEpisodes({ orgId: org.id, deviceId: deviceA, status: 'all', limit: 25, ref: epB.memberIds[0] }));
    expect(result.focusedEpisodeId).toBeNull();
    expect(result.data).toEqual([]);
  });

  it('detail returns members ordered by window_start, capped at 200 with membersTruncated', async () => {
    const { org, site } = await seedTenant();
    const deviceId = await insertEpisodeDevice(org.id, site.id);
    const ep = await seedEpisode({ orgId: org.id, deviceId, memberCount: 201, start: new Date(Date.now() - 20 * HOUR) });

    const detail = await withSystemDbAccessContext(() => getDeviceEpisodeDetail({ orgId: org.id, deviceId, episodeId: ep.episodeId }));

    expect(detail).not.toBeNull();
    expect(detail!.members).toHaveLength(200);
    expect(detail!.membersTruncated).toBe(true);
    expect(detail!.members[0]!.id).toBe(ep.memberIds[0]);
    expect(detail!.members[199]!.id).toBe(ep.memberIds[199]);
  });

  it('detail for an episode on another device is null', async () => {
    const { org, site } = await seedTenant();
    const deviceA = await insertEpisodeDevice(org.id, site.id);
    const deviceB = await insertEpisodeDevice(org.id, site.id);
    const epB = await seedEpisode({ orgId: org.id, deviceId: deviceB, memberCount: 1, start: new Date(Date.now() - HOUR) });
    expect(await withSystemDbAccessContext(() => getDeviceEpisodeDetail({ orgId: org.id, deviceId: deviceA, episodeId: epB.episodeId }))).toBeNull();
  });
});
```

- [ ] **Step 4: Run both and watch them fail**

```bash
cd apps/api && npx vitest run src/services/metricAnomalyEpisodeQueries.test.ts
cd /Users/…/breeze && pnpm test-stack up
pnpm --filter @breeze/api test:integration src/__tests__/integration/metricAnomalyEpisodeQueries.integration.test.ts
```
Expected: both FAIL, because module `./metricAnomalyEpisodeQueries` cannot be resolved.

- [ ] **Step 5: Implement the service**

`apps/api/src/services/metricAnomalyEpisodeQueries.ts`:

```ts
import { and, asc, desc, eq, gte, inArray, ne, sql } from 'drizzle-orm';
import {
  EPISODE_DETAIL_MEMBER_LIMIT,
  type EpisodeAttribution,
  type EpisodeCloseReason,
  type EpisodeListStatus,
  type MetricAnomalyEpisodeDetailDto,
  type MetricAnomalyEpisodeDto,
  type MetricAnomalyEpisodeListResponse,
  type MetricAnomalyEpisodeMemberDto,
  type MetricAnomalyEpisodeStatus,
  type MetricAnomalyStatus,
} from '@breeze/shared';

import { db } from '../db';
import { metricAnomalies, metricAnomalyEpisodes, type MetricAnomalyEpisodeRow } from '../db/schema';

/**
 * Read side of the episode API (spec §12). Runs on the ambient request
 * context (`withDbAccessContext` opened by authMiddleware) — never opens its
 * own. Every lookup is scoped by (org_id, device_id) so a `ref` or episode id
 * belonging to another device can never be returned.
 */

// W01 owns the row type (db/schema/metricAnomalyEpisodes.ts); re-exported so
// tests can import it from here without a second definition.
export type { MetricAnomalyEpisodeRow };
type MetricAnomalyRow = typeof metricAnomalies.$inferSelect;
type PeakRange = { min: number; max: number; peakAnomalyId?: string | null };

export const EPISODE_CLOSED_WINDOW_DAYS = 7;
const DAY_MS = 86_400_000;

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

export function serializeMetricAnomalyEpisode(
  row: MetricAnomalyEpisodeRow,
  range: PeakRange | null | undefined,
  now: Date,
): MetricAnomalyEpisodeDto {
  return {
    id: row.id,
    orgId: row.orgId,
    deviceId: row.deviceId,
    episodeKey: row.episodeKey,
    sourceTable: row.sourceTable,
    anomalyType: row.anomalyType,
    metricFamily: row.metricFamily,
    metricNames: [...row.metricNames],
    status: row.status as MetricAnomalyEpisodeStatus,
    closeReason: (row.closeReason ?? null) as EpisodeCloseReason | null,
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    bucketCount: row.bucketCount,
    peakValue: row.peakValue,
    peakMetricName: row.peakMetricName,
    peakBaselineValue: row.peakBaselineValue ?? null,
    peakScore: row.peakScore,
    peakAt: row.peakAt.toISOString(),
    recurrenceCount: row.recurrenceCount,
    attribution: (row.attribution ?? null) as EpisodeAttribution | null,
    linkedAlertId: row.linkedAlertId ?? null,
    snoozedUntil: iso(row.snoozedUntil),
    resolvedAt: iso(row.resolvedAt),
    resolvedByUserId: row.resolvedByUserId ?? null,
    note: row.note ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    durationSeconds: Math.max(0, Math.round((row.lastSeenAt.getTime() - row.firstSeenAt.getTime()) / 1000)),
    ongoing: row.status === 'open',
    promoted: row.linkedAlertId != null,
    snoozed: row.snoozedUntil != null && row.snoozedUntil.getTime() > now.getTime(),
    rangeMin: range ? range.min : null,
    rangeMax: range ? range.max : null,
    peakAnomalyId: range?.peakAnomalyId ?? null,
  };
}

export function serializeMetricAnomalyEpisodeMember(row: MetricAnomalyRow): MetricAnomalyEpisodeMemberDto {
  return {
    id: row.id,
    metricName: row.metricName,
    anomalyType: row.anomalyType,
    status: row.status as MetricAnomalyStatus,
    windowStart: row.windowStart.toISOString(),
    windowEnd: row.windowEnd.toISOString(),
    observedValue: row.observedValue,
    baselineValue: row.baselineValue ?? null,
    baselineMax: row.baselineMax ?? null,
    score: row.score,
    confidence: row.confidence,
    linkedAlertId: row.linkedAlertId ?? null,
  };
}

function deviceScope(orgId: string, deviceId: string) {
  return and(eq(metricAnomalyEpisodes.orgId, orgId), eq(metricAnomalyEpisodes.deviceId, deviceId));
}

/**
 * min/max observed value over members whose metric_name equals the
 * episode's peak metric (spec deviation D-6: never mix `_sum` with `_max`).
 * One grouped query for the whole page.
 */
async function loadPeakMetricRanges(orgId: string, rows: MetricAnomalyEpisodeRow[]): Promise<Map<string, PeakRange>> {
  const ranges = new Map<string, PeakRange>();
  if (rows.length === 0) return ranges;
  const result = await db
    .select({
      episodeId: metricAnomalies.episodeId,
      min: sql<number>`min(${metricAnomalies.observedValue})`,
      max: sql<number>`max(${metricAnomalies.observedValue})`,
    })
    .from(metricAnomalies)
    .innerJoin(
      metricAnomalyEpisodes,
      and(
        eq(metricAnomalyEpisodes.id, metricAnomalies.episodeId),
        eq(metricAnomalies.metricName, metricAnomalyEpisodes.peakMetricName),
      ),
    )
    .where(and(
      eq(metricAnomalies.orgId, orgId),
      inArray(metricAnomalies.episodeId, rows.map((r) => r.id)),
    ))
    .groupBy(metricAnomalies.episodeId);
  for (const r of result) {
    if (r.episodeId) ranges.set(r.episodeId, { min: Number(r.min), max: Number(r.max) });
  }

  // Peak member id (W01's peak rule: score DESC, window_start ASC) for the
  // web card's remediation lookup, which is keyed by metric_anomalies.id.
  const peaks = await db
    .selectDistinctOn([metricAnomalies.episodeId], { episodeId: metricAnomalies.episodeId, id: metricAnomalies.id })
    .from(metricAnomalies)
    .where(and(
      eq(metricAnomalies.orgId, orgId),
      inArray(metricAnomalies.episodeId, rows.map((r) => r.id)),
    ))
    .orderBy(metricAnomalies.episodeId, desc(metricAnomalies.score), asc(metricAnomalies.windowStart));
  for (const p of peaks) {
    const range = p.episodeId ? ranges.get(p.episodeId) : undefined;
    if (range) range.peakAnomalyId = p.id;
  }
  return ranges;
}

async function findEpisodeByRef(orgId: string, deviceId: string, ref: string): Promise<MetricAnomalyEpisodeRow | null> {
  const [byId] = await db
    .select()
    .from(metricAnomalyEpisodes)
    .where(and(deviceScope(orgId, deviceId), eq(metricAnomalyEpisodes.id, ref)))
    .limit(1);
  if (byId) return byId;

  const [member] = await db
    .select({ episodeId: metricAnomalies.episodeId })
    .from(metricAnomalies)
    .where(and(
      eq(metricAnomalies.orgId, orgId),
      eq(metricAnomalies.deviceId, deviceId),
      eq(metricAnomalies.id, ref),
    ))
    .limit(1);
  if (!member?.episodeId) return null;

  const [byMember] = await db
    .select()
    .from(metricAnomalyEpisodes)
    .where(and(deviceScope(orgId, deviceId), eq(metricAnomalyEpisodes.id, member.episodeId)))
    .limit(1);
  return byMember ?? null;
}

export async function listDeviceEpisodes(input: {
  orgId: string;
  deviceId: string;
  status: EpisodeListStatus;
  limit: number;
  ref?: string;
  now?: Date;
}): Promise<MetricAnomalyEpisodeListResponse> {
  const now = input.now ?? new Date();
  let status = input.status;
  let focused: MetricAnomalyEpisodeRow | null = null;
  if (input.ref) {
    status = 'all';
    focused = await findEpisodeByRef(input.orgId, input.deviceId, input.ref);
  }

  const conditions = [deviceScope(input.orgId, input.deviceId)];
  if (status === 'open') {
    conditions.push(eq(metricAnomalyEpisodes.status, 'open'));
  } else if (status === 'closed') {
    conditions.push(inArray(metricAnomalyEpisodes.status, ['resolved', 'dismissed']));
    conditions.push(gte(metricAnomalyEpisodes.resolvedAt, new Date(now.getTime() - EPISODE_CLOSED_WINDOW_DAYS * DAY_MS)));
  }
  if (focused) conditions.push(ne(metricAnomalyEpisodes.id, focused.id));

  const remaining = focused ? input.limit - 1 : input.limit;
  const rest = remaining > 0
    ? await db
      .select()
      .from(metricAnomalyEpisodes)
      .where(and(...conditions))
      .orderBy(desc(metricAnomalyEpisodes.lastSeenAt), desc(metricAnomalyEpisodes.id))
      .limit(remaining)
    : [];

  const rows = focused ? [focused, ...rest] : rest;
  const ranges = await loadPeakMetricRanges(input.orgId, rows);
  return {
    data: rows.map((r) => serializeMetricAnomalyEpisode(r, ranges.get(r.id), now)),
    focusedEpisodeId: focused?.id ?? null,
  };
}

async function loadEpisodeRow(orgId: string, deviceId: string, episodeId: string): Promise<MetricAnomalyEpisodeRow | null> {
  const [row] = await db
    .select()
    .from(metricAnomalyEpisodes)
    .where(and(deviceScope(orgId, deviceId), eq(metricAnomalyEpisodes.id, episodeId)))
    .limit(1);
  return row ?? null;
}

export async function getDeviceEpisodeDto(input: {
  orgId: string;
  deviceId: string;
  episodeId: string;
  now?: Date;
}): Promise<MetricAnomalyEpisodeDto | null> {
  const row = await loadEpisodeRow(input.orgId, input.deviceId, input.episodeId);
  if (!row) return null;
  const ranges = await loadPeakMetricRanges(input.orgId, [row]);
  return serializeMetricAnomalyEpisode(row, ranges.get(row.id), input.now ?? new Date());
}

export async function getDeviceEpisodeDetail(input: {
  orgId: string;
  deviceId: string;
  episodeId: string;
  now?: Date;
}): Promise<MetricAnomalyEpisodeDetailDto | null> {
  const row = await loadEpisodeRow(input.orgId, input.deviceId, input.episodeId);
  if (!row) return null;
  const members = await db
    .select()
    .from(metricAnomalies)
    .where(and(eq(metricAnomalies.orgId, input.orgId), eq(metricAnomalies.episodeId, row.id)))
    .orderBy(asc(metricAnomalies.windowStart), asc(metricAnomalies.id))
    .limit(EPISODE_DETAIL_MEMBER_LIMIT + 1);
  const ranges = await loadPeakMetricRanges(input.orgId, [row]);
  return {
    ...serializeMetricAnomalyEpisode(row, ranges.get(row.id), input.now ?? new Date()),
    members: members.slice(0, EPISODE_DETAIL_MEMBER_LIMIT).map(serializeMetricAnomalyEpisodeMember),
    membersTruncated: members.length > EPISODE_DETAIL_MEMBER_LIMIT,
  };
}
```

- [ ] **Step 6: Run both and watch them pass**

```bash
cd apps/api && npx vitest run src/services/metricAnomalyEpisodeQueries.test.ts
pnpm --filter @breeze/api test:integration src/__tests__/integration/metricAnomalyEpisodeQueries.integration.test.ts
```
Expected: PASS (8 unit tests, 7 integration tests).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/metricAnomalyEpisodeQueries.ts apps/api/src/services/metricAnomalyEpisodeQueries.test.ts apps/api/src/__tests__/integration/metricAnomalyEpisodeFixtures.ts apps/api/src/__tests__/integration/metricAnomalyEpisodeQueries.integration.test.ts
git commit -m "feat(api): metric anomaly episode read service — list/detail/ref + serializer (W02)"
```

---

### Task 3: Transactional per-member feedback writer

**Files:**
- Modify: `apps/api/src/services/mlFeedback.ts` (after `emitMlFeedbackEvent`, ~line 75)
- Modify: `apps/api/src/services/mlFeedbackEmitters.ts` (after `emitAnomalyFeedback`, ~line 83)
- Test: `apps/api/src/services/mlFeedback.test.ts`, `apps/api/src/services/mlFeedbackEmitters.test.ts`

**Interfaces:**
- Produces:
  - `emitMlFeedbackEvents(inputs: MlFeedbackEventInput[], database?: Pick<typeof db, 'insert'>): Promise<{ inserted: number }>`. It throws when any event has no `dedupeKey`, inserts in chunks of `ML_FEEDBACK_BATCH_SIZE = 500`, uses `ON CONFLICT DO NOTHING` on the semantic unique index, and **never swallows errors**.
  - `emitAnomalyEpisodeMemberFeedback(options: { orgId: string; episodeId: string; members: ReadonlyArray<{ id: string; metricName: string; anomalyType: string }>; outcome: 'dismissed' | 'promoted' | 'resolved'; actorUserId?: string | null; occurredAt: Date; metadata?: Record<string, unknown> }): Promise<number>`. It returns the number of rows inserted.

Dedupe check (spec §8.3): the semantic unique is `(org_id, source_type, source_id, event_type, dedupe_key)` and the other unique is `(source_type, source_id, event_type, occurred_at)` (`apps/api/src/db/schema/mlFeedback.ts:36-44`). Every member row has a distinct `source_id`, so a 17-member dismiss can never collide with itself on either index. A member labelled earlier through the per-row route has `dedupe_key = 'status:dismissed'`. It is also no longer `open`, so the cascade never selects it.

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/services/mlFeedback.test.ts` (its existing `beforeEach` already wires `insert → values → onConflictDoNothing → returning`). Add `emitMlFeedbackEvents` to the existing import from `'./mlFeedback'`:

```ts
describe('emitMlFeedbackEvents (batch, W02)', () => {
  const member = (i: number) => ({
    orgId: '00000000-0000-4000-8000-000000000001',
    sourceType: 'anomaly' as const,
    sourceId: `00000000-0000-4000-8000-${String(100 + i).padStart(12, '0')}`,
    eventType: 'anomaly.dismissed' as const,
    dedupeKey: 'episode:00000000-0000-4000-8000-000000000099',
    outcome: 'dismissed' as const,
    metadata: { episodeId: '00000000-0000-4000-8000-000000000099' },
    occurredAt: new Date('2026-09-22T00:00:00.000Z'),
  });

  it('inserts every event in one statement against the semantic dedupe target', async () => {
    dbMocks.returningMock.mockResolvedValue([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);

    const result = await emitMlFeedbackEvents([member(1), member(2), member(3)]);

    expect(result).toEqual({ inserted: 3 });
    expect(dbMocks.insertMock).toHaveBeenCalledTimes(1);
    const inserted = dbMocks.valuesMock.mock.calls[0]![0] as Array<Record<string, unknown>>;
    expect(inserted).toHaveLength(3);
    expect(inserted.map((r) => r.sourceId)).toEqual([member(1).sourceId, member(2).sourceId, member(3).sourceId]);
    const conflict = dbMocks.onConflictDoNothingMock.mock.calls[0]![0] as { target: unknown[]; where: unknown };
    expect(conflict.target).toHaveLength(5);
    expect(conflict.where).toBeDefined();
  });

  it('refuses an event without a dedupeKey and writes nothing', async () => {
    const { dedupeKey: _omit, ...noKey } = member(1);
    await expect(emitMlFeedbackEvents([member(2), noKey])).rejects.toThrow(/dedupeKey/);
    expect(dbMocks.insertMock).not.toHaveBeenCalled();
  });

  it('chunks at 500 rows', async () => {
    dbMocks.returningMock.mockResolvedValueOnce(new Array(500).fill({ id: 'x' }));
    dbMocks.returningMock.mockResolvedValueOnce([{ id: 'y' }]);
    const result = await emitMlFeedbackEvents(Array.from({ length: 501 }, (_, i) => member(i)));
    expect(dbMocks.insertMock).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ inserted: 501 });
  });

  it('is a no-op for an empty list', async () => {
    expect(await emitMlFeedbackEvents([])).toEqual({ inserted: 0 });
    expect(dbMocks.insertMock).not.toHaveBeenCalled();
  });

  it('propagates insert failures (never best-effort)', async () => {
    dbMocks.returningMock.mockRejectedValue(new Error('connection lost'));
    await expect(emitMlFeedbackEvents([member(1)])).rejects.toThrow('connection lost');
  });
});
```

In `apps/api/src/services/mlFeedbackEmitters.test.ts`, extend the module mock and add a suite:

```ts
// at the top, next to `const emitMlFeedbackEvent = vi.fn();`
const emitMlFeedbackEvents = vi.fn();

vi.mock('./mlFeedback', () => ({
  emitMlFeedbackEvent: (...args: unknown[]) => emitMlFeedbackEvent(...args),
  emitMlFeedbackEvents: (...args: unknown[]) => emitMlFeedbackEvents(...args),
}));
```

Add `emitAnomalyEpisodeMemberFeedback` to the import list, then:

```ts
describe('emitAnomalyEpisodeMemberFeedback (W02)', () => {
  const EPISODE = '99999999-9999-4999-8999-999999999999';
  beforeEach(() => {
    emitMlFeedbackEvents.mockReset();
    emitMlFeedbackEvents.mockResolvedValue({ inserted: 2 });
  });

  it('writes one anomaly-sourced row per member with the episode dedupe key and metadata', async () => {
    const inserted = await emitAnomalyEpisodeMemberFeedback({
      orgId: 'org-1',
      episodeId: EPISODE,
      members: [
        { id: 'm-1', metricName: 'top_process_ram_mb_max', anomalyType: 'process_runaway' },
        { id: 'm-2', metricName: 'top_process_ram_mb_sum', anomalyType: 'process_runaway' },
      ],
      outcome: 'dismissed',
      actorUserId: VALID_UUID,
      occurredAt: new Date('2026-09-22T00:00:00.000Z'),
      metadata: { route: 'devices.anomalyEpisodes.action' },
    });

    expect(inserted).toBe(2);
    const events = emitMlFeedbackEvents.mock.calls[0]![0] as Array<Record<string, any>>;
    expect(events).toHaveLength(2);
    for (const [i, event] of events.entries()) {
      expect(event).toMatchObject({
        orgId: 'org-1',
        sourceType: 'anomaly',
        sourceId: `m-${i + 1}`,
        eventType: 'anomaly.dismissed',
        outcome: 'dismissed',
        dedupeKey: `episode:${EPISODE}`,
        actorUserId: VALID_UUID,
      });
      expect(event.metadata).toMatchObject({ episodeId: EPISODE, route: 'devices.anomalyEpisodes.action' });
    }
    expect(events[1]!.metadata.metricName).toBe('top_process_ram_mb_sum');
  });

  it('normalizes a non-uuid actor to null', async () => {
    await emitAnomalyEpisodeMemberFeedback({
      orgId: 'org-1', episodeId: EPISODE, members: [{ id: 'm-1', metricName: 'cpu_percent', anomalyType: 'spike' }],
      outcome: 'resolved', actorUserId: 'system', occurredAt: new Date(),
    });
    expect((emitMlFeedbackEvents.mock.calls[0]![0] as Array<Record<string, unknown>>)[0]!.actorUserId).toBeNull();
  });

  it('propagates writer errors instead of swallowing them', async () => {
    emitMlFeedbackEvents.mockRejectedValue(new Error('boom'));
    await expect(emitAnomalyEpisodeMemberFeedback({
      orgId: 'org-1', episodeId: EPISODE, members: [{ id: 'm-1', metricName: 'cpu_percent', anomalyType: 'spike' }],
      outcome: 'promoted', occurredAt: new Date(),
    })).rejects.toThrow('boom');
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/api && npx vitest run src/services/mlFeedback.test.ts src/services/mlFeedbackEmitters.test.ts`
Expected: FAIL. `emitMlFeedbackEvents` / `emitAnomalyEpisodeMemberFeedback` are not exported.

- [ ] **Step 3: Implement**

In `apps/api/src/services/mlFeedback.ts`, after `emitMlFeedbackEvent`:

```ts
export const ML_FEEDBACK_BATCH_SIZE = 500;

/**
 * Batch writer for label rows that must NOT be lost (#metric-anomaly-episodes
 * W02, spec §8.3). Unlike the emitters' best-effort wrapper this throws, so a
 * caller running inside a request transaction rolls back its own state change
 * when the labels cannot be written. Every event must carry a dedupeKey: the
 * batch targets only the semantic unique index, and replays are no-ops.
 */
export async function emitMlFeedbackEvents(
  inputs: MlFeedbackEventInput[],
  database: MlFeedbackWritableDb = db,
): Promise<{ inserted: number }> {
  if (inputs.length === 0) return { inserted: 0 };
  const events = inputs.map((input) => {
    const event = mlFeedbackEventSchema.parse(input);
    if (!event.dedupeKey) {
      throw new Error('emitMlFeedbackEvents requires a dedupeKey on every event');
    }
    assertMlFeedbackMetadataWithinLimit(event.metadata);
    return event;
  });

  let inserted = 0;
  for (let i = 0; i < events.length; i += ML_FEEDBACK_BATCH_SIZE) {
    const chunk = events.slice(i, i + ML_FEEDBACK_BATCH_SIZE);
    const rows = await database
      .insert(mlFeedbackEvents)
      .values(chunk.map((event) => ({
        orgId: event.orgId,
        sourceType: event.sourceType,
        sourceId: event.sourceId,
        eventType: event.eventType,
        dedupeKey: event.dedupeKey ?? null,
        actorUserId: event.actorUserId ?? null,
        outcome: event.outcome,
        confidence: event.confidence ?? null,
        metadata: event.metadata,
        occurredAt: event.occurredAt,
      })))
      .onConflictDoNothing({
        target: [
          mlFeedbackEvents.orgId,
          mlFeedbackEvents.sourceType,
          mlFeedbackEvents.sourceId,
          mlFeedbackEvents.eventType,
          mlFeedbackEvents.dedupeKey,
        ],
        where: sql`${mlFeedbackEvents.dedupeKey} IS NOT NULL`,
      })
      .returning({ id: mlFeedbackEvents.id });
    inserted += rows.length;
  }
  return { inserted };
}
```

In `apps/api/src/services/mlFeedbackEmitters.ts`, change the import to `import { emitMlFeedbackEvent, emitMlFeedbackEvents } from './mlFeedback';` and add after `emitAnomalyFeedback`:

```ts
/**
 * Spec §8.3 — one `anomaly` feedback row per member an episode action
 * cascaded to, so `/analytics/anomalies/evaluation` (joins feedback to
 * metric_anomalies.id) and the v1-shadow overlap keep their labels.
 * NOT best-effort: throws, so the episode action rolls back with it.
 */
export async function emitAnomalyEpisodeMemberFeedback(options: {
  orgId: string;
  episodeId: string;
  members: ReadonlyArray<{ id: string; metricName: string; anomalyType: string }>;
  outcome: 'dismissed' | 'promoted' | 'resolved';
  actorUserId?: string | null;
  occurredAt: Date;
  metadata?: Record<string, unknown>;
}): Promise<number> {
  const actorUserId = actorUserIdOrNull(options.actorUserId);
  const { inserted } = await emitMlFeedbackEvents(options.members.map((member) => ({
    orgId: options.orgId,
    sourceType: 'anomaly' as const,
    sourceId: member.id,
    eventType: `anomaly.${options.outcome}` as const,
    dedupeKey: `episode:${options.episodeId}`,
    outcome: options.outcome,
    actorUserId,
    metadata: {
      ...(options.metadata ?? {}),
      episodeId: options.episodeId,
      metricName: member.metricName,
      anomalyType: member.anomalyType,
    },
    occurredAt: options.occurredAt,
  })));
  return inserted;
}
```

- [ ] **Step 4: Run and watch them pass**

Run: `cd apps/api && npx vitest run src/services/mlFeedback.test.ts src/services/mlFeedbackEmitters.test.ts`
Expected: PASS (the old tests and the 8 new ones).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/mlFeedback.ts apps/api/src/services/mlFeedbackEmitters.ts apps/api/src/services/mlFeedback.test.ts apps/api/src/services/mlFeedbackEmitters.test.ts
git commit -m "feat(api): transactional batch feedback writer for episode member labels (W02)"
```

---

### Task 4: Promotion carries `context.episodeId`

**Files:**
- Modify: `apps/api/src/services/metricAnomalyPromotion.ts:61-67` (options type) and `:225-243` (alert `context`)
- Test: `apps/api/src/services/metricAnomalyPromotion.test.ts`

**Interfaces:**
- Produces: `PromoteMetricAnomalyToAlertOptions.episodeId?: string | null`. When set and a **new** alert is created, `alerts.context.episodeId = episodeId`. The `alerts.episode_id` column is never written. For the reuse paths (`created: false`) the caller stamps the context itself (Task 5).

- [ ] **Step 1: Write the failing tests**

Append inside the existing `describe('metric anomaly promotion service', …)` in `metricAnomalyPromotion.test.ts`:

```ts
  it('writes the anomaly episode id into the new alert context, never the alerts.episode_id column', async () => {
    selectMock.mockReturnValueOnce(chain([anomaly]));
    selectMock.mockReturnValueOnce(chain([])); // dedupe siblings
    selectMock.mockReturnValueOnce(chain([])); // incident agent_run_id lookup
    insertMock.mockReturnValueOnce(chain([{ id: '44444444-4444-4444-8444-444444444444' }]));
    updateMock.mockReturnValueOnce(chain([{ ...anomaly, status: 'promoted', linkedAlertId: '44444444-4444-4444-8444-444444444444' }]));

    await promoteMetricAnomalyToAlert({
      orgId: anomaly.orgId,
      deviceId: anomaly.deviceId,
      anomalyId: anomaly.id,
      actorUserId: 'user-1',
      requireCreateAlertsFlag: false,
      episodeId: '55555555-5555-4555-8555-555555555555',
    });

    const insertedChain = insertMock.mock.results[0]!.value as { values: ReturnType<typeof vi.fn> };
    const values = insertedChain.values.mock.calls[0]![0] as Record<string, unknown>;
    expect(values.context).toMatchObject({
      source: 'metric_anomaly',
      anomalyId: anomaly.id,
      episodeId: '55555555-5555-4555-8555-555555555555',
    });
    // alerts.episode_id is the MONITOR breach episode (#5290) — never ours.
    expect(values).not.toHaveProperty('episodeId');
  });

  it('omits context.episodeId when no episode is given (per-row route unchanged)', async () => {
    selectMock.mockReturnValueOnce(chain([anomaly]));
    selectMock.mockReturnValueOnce(chain([]));
    selectMock.mockReturnValueOnce(chain([]));
    insertMock.mockReturnValueOnce(chain([{ id: '44444444-4444-4444-8444-444444444444' }]));
    updateMock.mockReturnValueOnce(chain([{ ...anomaly, status: 'promoted' }]));

    await promoteMetricAnomalyToAlert({ orgId: anomaly.orgId, deviceId: anomaly.deviceId, anomalyId: anomaly.id });

    const insertedChain = insertMock.mock.results[0]!.value as { values: ReturnType<typeof vi.fn> };
    const values = insertedChain.values.mock.calls[0]![0] as { context: Record<string, unknown> };
    expect(values.context).not.toHaveProperty('episodeId');
  });
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd apps/api && npx vitest run src/services/metricAnomalyPromotion.test.ts`
Expected: the first new test fails, because `context` has no `episodeId`. tsc would also reject the unknown option, but vitest does not typecheck.

- [ ] **Step 3: Implement**

In `PromoteMetricAnomalyToAlertOptions`, add:

```ts
  /**
   * Metric anomaly EPISODE (spec §12, W02) this promotion is for. Written to
   * the new alert's `context.episodeId` only. Never to `alerts.episode_id`:
   * that column is the monitor breach episode (#5290).
   */
  episodeId?: string | null;
```

In the `context: { … }` object of the alert insert, after `agentRunId: incidentAgentRunId,`:

```ts
        ...(options.episodeId ? { episodeId: options.episodeId } : {}),
```

- [ ] **Step 4: Run and watch it pass**

Run: `cd apps/api && npx vitest run src/services/metricAnomalyPromotion.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/metricAnomalyPromotion.ts apps/api/src/services/metricAnomalyPromotion.test.ts
git commit -m "feat(api): anomaly promotion stamps context.episodeId (W02)"
```

---

### Task 5: Episode actions service (`resolve` / `dismiss` / `promote` / `unsnooze`)

**Files:**
- Create: `apps/api/src/services/metricAnomalyEpisodeActions.ts`
- Create: `apps/api/src/services/metricAnomalyEpisodeActions.test.ts`
- Create: `apps/api/src/__tests__/integration/metricAnomalyEpisodeActions.integration.test.ts`

**Interfaces:**
- Consumes: `EPISODE_SNOOZE_DAYS` (W01), `resolveAlert(alertId, note?, resolvedBy?) → Promise<boolean>` (`alertService.ts:715`), `promoteMetricAnomalyToAlert` with `episodeId` (Task 4), `emitAnomalyEpisodeMemberFeedback` (Task 3), `emitAlertStateFeedback` (existing).
- Produces:
  - `type EpisodeActionConflict = 'episode_closed' | 'already_promoted' | 'not_snoozed' | 'no_promotable_member' | 'promotion_disabled'`
  - `EPISODE_ACTION_CONFLICT_MESSAGES: Record<EpisodeActionConflict, string>`
  - `DEFAULT_EPISODE_RESOLVE_NOTE = 'Resolved with its anomaly episode'`
  - `decideEpisodeAction(episode: { status: string; linkedAlertId: string | null; snoozedUntil: Date | null }, action: EpisodeAction, now: Date): { ok: true } | { ok: false; reason: 'episode_closed' | 'already_promoted' | 'not_snoozed' }`
  - `interface ApplyEpisodeActionInput { orgId: string; deviceId: string; episodeId: string; action: EpisodeAction; note?: string; resolveAlert?: boolean; actorUserId: string; now?: Date }`
  - `type ApplyEpisodeActionResult = { status: 'not_found' } | { status: 'conflict'; reason: EpisodeActionConflict; message: string } | { status: 'ok'; episodeId: string; action: EpisodeAction; alertId: string | null; alertResolved: boolean; labelledMemberIds: string[]; feedbackInserted: number }`
  - `applyEpisodeAction(input: ApplyEpisodeActionInput): Promise<ApplyEpisodeActionResult>`. Runs on the ambient context and takes `SELECT … FOR UPDATE` on the episode row first, which serializes two concurrent clicks and a racing auto-resolve stage.

- [ ] **Step 1: Write the failing precondition unit test**

`apps/api/src/services/metricAnomalyEpisodeActions.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ db: {} }));
vi.mock('./alertService', () => ({ resolveAlert: vi.fn() }));
vi.mock('./metricAnomalyPromotion', () => ({ promoteMetricAnomalyToAlert: vi.fn() }));
vi.mock('./mlFeedbackEmitters', () => ({ emitAlertStateFeedback: vi.fn(), emitAnomalyEpisodeMemberFeedback: vi.fn() }));
vi.mock('./metricAnomalyEpisodes', () => ({ EPISODE_SNOOZE_DAYS: 7 }));

import { decideEpisodeAction, EPISODE_ACTION_CONFLICT_MESSAGES } from './metricAnomalyEpisodeActions';

const NOW = new Date('2026-09-22T00:00:00.000Z');
const open = { status: 'open', linkedAlertId: null, snoozedUntil: null };

describe('decideEpisodeAction (spec §8.1)', () => {
  it.each(['resolve', 'dismiss', 'promote'] as const)('%s is allowed on an open episode', (action) => {
    expect(decideEpisodeAction(open, action, NOW)).toEqual({ ok: true });
  });

  it.each([
    ['resolve', 'resolved'], ['dismiss', 'resolved'], ['promote', 'resolved'],
    ['resolve', 'dismissed'], ['dismiss', 'dismissed'], ['promote', 'dismissed'],
  ] as const)('%s on a %s episode is episode_closed', (action, status) => {
    expect(decideEpisodeAction({ ...open, status }, action, NOW)).toEqual({ ok: false, reason: 'episode_closed' });
  });

  it('promote on an already-linked open episode is already_promoted', () => {
    expect(decideEpisodeAction({ ...open, linkedAlertId: 'a-1' }, 'promote', NOW)).toEqual({ ok: false, reason: 'already_promoted' });
  });

  it('resolve on a promoted (linked) open episode is allowed', () => {
    expect(decideEpisodeAction({ ...open, linkedAlertId: 'a-1' }, 'resolve', NOW)).toEqual({ ok: true });
  });

  it('unsnooze requires dismissed + snoozed_until in the future', () => {
    const future = new Date(NOW.getTime() + 60_000);
    const past = new Date(NOW.getTime() - 60_000);
    expect(decideEpisodeAction({ status: 'dismissed', linkedAlertId: null, snoozedUntil: future }, 'unsnooze', NOW)).toEqual({ ok: true });
    expect(decideEpisodeAction({ status: 'dismissed', linkedAlertId: null, snoozedUntil: past }, 'unsnooze', NOW)).toEqual({ ok: false, reason: 'not_snoozed' });
    expect(decideEpisodeAction({ status: 'dismissed', linkedAlertId: null, snoozedUntil: null }, 'unsnooze', NOW)).toEqual({ ok: false, reason: 'not_snoozed' });
    expect(decideEpisodeAction({ ...open, snoozedUntil: future }, 'unsnooze', NOW)).toEqual({ ok: false, reason: 'not_snoozed' });
    expect(decideEpisodeAction({ status: 'resolved', linkedAlertId: null, snoozedUntil: future }, 'unsnooze', NOW)).toEqual({ ok: false, reason: 'not_snoozed' });
  });

  it('every conflict reason has a user-facing message', () => {
    for (const reason of ['episode_closed', 'already_promoted', 'not_snoozed', 'no_promotable_member', 'promotion_disabled'] as const) {
      expect(EPISODE_ACTION_CONFLICT_MESSAGES[reason]).toMatch(/\w/);
    }
  });
});
```

- [ ] **Step 2: Write the failing integration test**

`apps/api/src/__tests__/integration/metricAnomalyEpisodeActions.integration.test.ts`:

```ts
import './setup';

import { describe, expect, it, vi } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';

const { publishEventMock } = vi.hoisted(() => ({
  publishEventMock: vi.fn<(...args: unknown[]) => Promise<string>>(async () => 'test-event-id'),
}));
vi.mock('../../services/eventBus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/eventBus')>();
  return { ...actual, publishEvent: publishEventMock };
});

import { withSystemDbAccessContext } from '../../db';
import { alerts, metricAnomalies, metricAnomalyEpisodes, mlFeedbackEvents } from '../../db/schema';
import { applyEpisodeAction } from '../../services/metricAnomalyEpisodeActions';
import { getTestDb } from './setup';
import { insertEpisodeDevice, seedAlert, seedEpisode, seedTenant } from './metricAnomalyEpisodeFixtures';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function act(input: Parameters<typeof applyEpisodeAction>[0]) {
  return withSystemDbAccessContext(() => applyEpisodeAction(input));
}

async function episodeRow(id: string) {
  const [row] = await getTestDb().select().from(metricAnomalyEpisodes).where(eq(metricAnomalyEpisodes.id, id));
  return row!;
}

async function membersOf(episodeId: string) {
  return getTestDb().select().from(metricAnomalies).where(eq(metricAnomalies.episodeId, episodeId)).orderBy(metricAnomalies.windowStart);
}

async function episodeFeedback(episodeId: string) {
  return getTestDb().select().from(mlFeedbackEvents).where(and(
    eq(mlFeedbackEvents.sourceType, 'anomaly'),
    eq(mlFeedbackEvents.dedupeKey, `episode:${episodeId}`),
  ));
}

describe('applyEpisodeAction (W02, spec §8)', () => {
  it('dismiss over 17 open members: episode dismissed + snoozed 7 d, 17 members dismissed, 17 joinable feedback rows', async () => {
    const { org, site, user } = await seedTenant();
    const deviceId = await insertEpisodeDevice(org.id, site.id);
    const ep = await seedEpisode({ orgId: org.id, deviceId, memberCount: 17, start: new Date(Date.now() - 2 * HOUR) });
    const now = new Date();

    const result = await act({ orgId: org.id, deviceId, episodeId: ep.episodeId, action: 'dismiss', actorUserId: user.id, note: 'backup job', now });

    expect(result).toMatchObject({ status: 'ok', action: 'dismiss', feedbackInserted: 17 });
    const episode = await episodeRow(ep.episodeId);
    expect(episode).toMatchObject({ status: 'dismissed', closeReason: 'user', resolvedByUserId: user.id, note: 'backup job' });
    expect(episode.snoozedUntil!.getTime()).toBe(now.getTime() + 7 * DAY);
    expect((await membersOf(ep.episodeId)).every((m) => m.status === 'dismissed')).toBe(true);

    const feedback = await episodeFeedback(ep.episodeId);
    expect(feedback).toHaveLength(17);
    expect(new Set(feedback.map((f) => f.sourceId))).toEqual(new Set(ep.memberIds));
    expect(feedback.every((f) => f.eventType === 'anomaly.dismissed' && f.actorUserId === user.id)).toBe(true);
    expect(feedback.every((f) => (f.metadata as Record<string, unknown>).episodeId === ep.episodeId)).toBe(true);
  });

  it('cascades only WHERE status = open: a member a human already dismissed keeps its label and gets no new row', async () => {
    const { org, site, user } = await seedTenant();
    const deviceId = await insertEpisodeDevice(org.id, site.id);
    const ep = await seedEpisode({ orgId: org.id, deviceId, memberCount: 5, start: new Date(Date.now() - 2 * HOUR) });
    await getTestDb().update(metricAnomalies).set({ status: 'dismissed' }).where(eq(metricAnomalies.id, ep.memberIds[0]!));

    const result = await act({ orgId: org.id, deviceId, episodeId: ep.episodeId, action: 'resolve', actorUserId: user.id });

    expect(result).toMatchObject({ status: 'ok', feedbackInserted: 4 });
    const members = await membersOf(ep.episodeId);
    expect(members[0]!.status).toBe('dismissed');
    expect(members.slice(1).every((m) => m.status === 'resolved' && m.resolvedAt !== null)).toBe(true);
    expect((await episodeFeedback(ep.episodeId)).map((f) => f.sourceId)).not.toContain(ep.memberIds[0]);
  });

  it('resolve on a promoted episode resolves the linked alert by default, with the user as resolver', async () => {
    const { org, site, user } = await seedTenant();
    const deviceId = await insertEpisodeDevice(org.id, site.id);
    const alertId = await seedAlert({ orgId: org.id, deviceId });
    const ep = await seedEpisode({ orgId: org.id, deviceId, memberCount: 3, start: new Date(Date.now() - HOUR), linkedAlertId: alertId });

    const result = await act({ orgId: org.id, deviceId, episodeId: ep.episodeId, action: 'resolve', actorUserId: user.id, note: 'disk replaced' });

    expect(result).toMatchObject({ status: 'ok', alertId, alertResolved: true });
    const [alert] = await getTestDb().select().from(alerts).where(eq(alerts.id, alertId));
    expect(alert).toMatchObject({ status: 'resolved', resolvedBy: user.id, resolutionNote: 'disk replaced' });
  });

  it('resolve with resolveAlert: false leaves the linked alert for the alert workflow', async () => {
    const { org, site, user } = await seedTenant();
    const deviceId = await insertEpisodeDevice(org.id, site.id);
    const alertId = await seedAlert({ orgId: org.id, deviceId });
    const ep = await seedEpisode({ orgId: org.id, deviceId, memberCount: 2, start: new Date(Date.now() - HOUR), linkedAlertId: alertId });

    const result = await act({ orgId: org.id, deviceId, episodeId: ep.episodeId, action: 'resolve', actorUserId: user.id, resolveAlert: false });

    expect(result).toMatchObject({ status: 'ok', alertResolved: false });
    const [alert] = await getTestDb().select().from(alerts).where(eq(alerts.id, alertId));
    expect(alert!.status).toBe('active');
    expect((await episodeRow(ep.episodeId)).status).toBe('resolved');
  });

  it('promote: one alert with context.episodeId from the peak member; episode stays open; members promoted + linked', async () => {
    const { org, site, user } = await seedTenant();
    const deviceId = await insertEpisodeDevice(org.id, site.id);
    const ep = await seedEpisode({ orgId: org.id, deviceId, memberCount: 3, start: new Date(Date.now() - HOUR) });

    const result = await act({ orgId: org.id, deviceId, episodeId: ep.episodeId, action: 'promote', actorUserId: user.id });

    expect(result).toMatchObject({ status: 'ok', action: 'promote', feedbackInserted: 3 });
    const alertId = (result as { alertId: string }).alertId;
    const [alert] = await getTestDb().select().from(alerts).where(eq(alerts.id, alertId));
    expect(alert!.context).toMatchObject({ source: 'metric_anomaly', anomalyId: ep.peakMemberId, episodeId: ep.episodeId });
    expect(alert!.episodeId).toBeNull(); // monitor-episode column untouched
    expect(await episodeRow(ep.episodeId)).toMatchObject({ status: 'open', linkedAlertId: alertId });
    const members = await membersOf(ep.episodeId);
    expect(members.every((m) => m.status === 'promoted' && m.linkedAlertId === alertId)).toBe(true);
    const feedback = await episodeFeedback(ep.episodeId);
    expect(feedback).toHaveLength(3);
    expect(feedback.every((f) => f.eventType === 'anomaly.promoted')).toBe(true);
  });

  it('promote reusing an alert the peak member already carries stamps context.episodeId onto it', async () => {
    const { org, site, user } = await seedTenant();
    const deviceId = await insertEpisodeDevice(org.id, site.id);
    const existingAlert = await seedAlert({ orgId: org.id, deviceId });
    const ep = await seedEpisode({ orgId: org.id, deviceId, memberCount: 2, start: new Date(Date.now() - HOUR) });
    await getTestDb().update(metricAnomalies).set({ status: 'promoted', linkedAlertId: existingAlert }).where(eq(metricAnomalies.id, ep.peakMemberId));

    const result = await act({ orgId: org.id, deviceId, episodeId: ep.episodeId, action: 'promote', actorUserId: user.id });

    expect(result).toMatchObject({ status: 'ok', alertId: existingAlert, feedbackInserted: 1 });
    const [alert] = await getTestDb().select().from(alerts).where(eq(alerts.id, existingAlert));
    expect(alert!.context).toMatchObject({ source: 'metric_anomaly', episodeId: ep.episodeId });
  });

  it('a second promote is a 409 already_promoted and creates nothing', async () => {
    const { org, site, user } = await seedTenant();
    const deviceId = await insertEpisodeDevice(org.id, site.id);
    const ep = await seedEpisode({ orgId: org.id, deviceId, memberCount: 2, start: new Date(Date.now() - HOUR) });
    await act({ orgId: org.id, deviceId, episodeId: ep.episodeId, action: 'promote', actorUserId: user.id });

    const again = await act({ orgId: org.id, deviceId, episodeId: ep.episodeId, action: 'promote', actorUserId: user.id });

    expect(again).toMatchObject({ status: 'conflict', reason: 'already_promoted' });
    expect(await getTestDb().select().from(alerts).where(eq(alerts.deviceId, deviceId))).toHaveLength(1);
  });

  it('any action but unsnooze on a closed episode is a 409 and writes nothing', async () => {
    const { org, site, user } = await seedTenant();
    const deviceId = await insertEpisodeDevice(org.id, site.id);
    const ep = await seedEpisode({ orgId: org.id, deviceId, memberCount: 2, start: new Date(Date.now() - 3 * HOUR), status: 'resolved', closeReason: 'cleared', memberStatus: 'cleared' });

    for (const action of ['resolve', 'dismiss', 'promote'] as const) {
      expect(await act({ orgId: org.id, deviceId, episodeId: ep.episodeId, action, actorUserId: user.id })).toMatchObject({ status: 'conflict', reason: 'episode_closed' });
    }
    expect(await episodeFeedback(ep.episodeId)).toHaveLength(0);
    expect((await episodeRow(ep.episodeId)).closeReason).toBe('cleared');
  });

  it('unsnooze clears the snooze on every snoozed episode of the same device + key (spec deviation D-4)', async () => {
    const { org, site, user } = await seedTenant();
    const deviceId = await insertEpisodeDevice(org.id, site.id);
    const until = new Date(Date.now() + 5 * DAY);
    const original = await seedEpisode({ orgId: org.id, deviceId, memberCount: 2, start: new Date(Date.now() - 6 * HOUR), status: 'dismissed', closeReason: 'user', snoozedUntil: until, memberStatus: 'dismissed' });
    const successor = await seedEpisode({ orgId: org.id, deviceId, memberCount: 1, start: new Date(Date.now() - HOUR), status: 'dismissed', closeReason: 'snoozed', snoozedUntil: until, memberStatus: 'dismissed' });

    const result = await act({ orgId: org.id, deviceId, episodeId: original.episodeId, action: 'unsnooze', actorUserId: user.id });

    expect(result).toMatchObject({ status: 'ok', action: 'unsnooze', feedbackInserted: 0 });
    expect((await episodeRow(original.episodeId)).snoozedUntil).toBeNull();
    expect((await episodeRow(successor.episodeId)).snoozedUntil).toBeNull();
    expect((await episodeRow(original.episodeId)).status).toBe('dismissed');

    expect(await act({ orgId: org.id, deviceId, episodeId: original.episodeId, action: 'unsnooze', actorUserId: user.id })).toMatchObject({ status: 'conflict', reason: 'not_snoozed' });
  });

  it('an episode id from another device is not_found', async () => {
    const { org, site, user } = await seedTenant();
    const deviceA = await insertEpisodeDevice(org.id, site.id);
    const deviceB = await insertEpisodeDevice(org.id, site.id);
    const ep = await seedEpisode({ orgId: org.id, deviceId: deviceB, memberCount: 1, start: new Date(Date.now() - HOUR) });

    expect(await act({ orgId: org.id, deviceId: deviceA, episodeId: ep.episodeId, action: 'dismiss', actorUserId: user.id })).toEqual({ status: 'not_found' });
    expect((await membersOf(ep.episodeId)).every((m) => m.status === 'open')).toBe(true);
  });

  it('promote refuses an episode whose members were all labelled by the per-row route', async () => {
    const { org, site, user } = await seedTenant();
    const deviceId = await insertEpisodeDevice(org.id, site.id);
    const ep = await seedEpisode({ orgId: org.id, deviceId, memberCount: 2, start: new Date(Date.now() - HOUR) });
    await getTestDb().update(metricAnomalies).set({ status: 'dismissed' }).where(inArray(metricAnomalies.id, ep.memberIds));

    expect(await act({ orgId: org.id, deviceId, episodeId: ep.episodeId, action: 'promote', actorUserId: user.id })).toMatchObject({ status: 'conflict', reason: 'no_promotable_member' });
  });
});
```

- [ ] **Step 3: Run both and watch them fail**

```bash
cd apps/api && npx vitest run src/services/metricAnomalyEpisodeActions.test.ts
pnpm --filter @breeze/api test:integration src/__tests__/integration/metricAnomalyEpisodeActions.integration.test.ts
```
Expected: FAIL. The module `./metricAnomalyEpisodeActions` is not found.

- [ ] **Step 4: Implement**

`apps/api/src/services/metricAnomalyEpisodeActions.ts`:

```ts
import { and, asc, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import type { EpisodeAction } from '@breeze/shared';

import { db } from '../db';
import { alerts, metricAnomalies, metricAnomalyEpisodes } from '../db/schema';
import { resolveAlert } from './alertService';
import { EPISODE_SNOOZE_DAYS } from './metricAnomalyEpisodes';
import { promoteMetricAnomalyToAlert } from './metricAnomalyPromotion';
import { emitAlertStateFeedback, emitAnomalyEpisodeMemberFeedback } from './mlFeedbackEmitters';

/**
 * Human actions on a metric anomaly episode (spec §8). Runs on the AMBIENT
 * request transaction (authMiddleware's withDbAccessContext). Never opens a
 * second context. resolveAlert / promoteMetricAnomalyToAlert join this
 * transaction because a nested withDbAccessContext returns fn() directly.
 *
 * Invariants:
 *  - The episode row is locked (SELECT … FOR UPDATE) before the precondition
 *    check, so two clicks and the auto-resolve stage serialize on it.
 *  - Member cascades touch ONLY status = 'open' rows (§8.2).
 *  - Member feedback is written by a throwing writer, so a lost label rolls
 *    the whole action back (spec deviation D-7).
 *  - The anomaly episode id is written to alerts.context.episodeId only.
 *    alerts.episode_id is the monitor breach episode (#5290).
 */

type EpisodeRow = typeof metricAnomalyEpisodes.$inferSelect;
type LabelledMember = { id: string; metricName: string; anomalyType: string };

export type EpisodeActionConflict =
  | 'episode_closed'
  | 'already_promoted'
  | 'not_snoozed'
  | 'no_promotable_member'
  | 'promotion_disabled';

export const EPISODE_ACTION_CONFLICT_MESSAGES: Record<EpisodeActionConflict, string> = {
  episode_closed: 'This anomaly has already closed',
  already_promoted: 'This anomaly is already linked to an alert',
  not_snoozed: 'This anomaly is not snoozed',
  no_promotable_member: 'This anomaly has no open detection left to promote',
  promotion_disabled: 'Anomaly alert promotion is disabled',
};

export const DEFAULT_EPISODE_RESOLVE_NOTE = 'Resolved with its anomaly episode';
const DAY_MS = 86_400_000;

export function decideEpisodeAction(
  episode: { status: string; linkedAlertId: string | null; snoozedUntil: Date | null },
  action: EpisodeAction,
  now: Date,
): { ok: true } | { ok: false; reason: 'episode_closed' | 'already_promoted' | 'not_snoozed' } {
  if (action === 'unsnooze') {
    return episode.status === 'dismissed'
      && episode.snoozedUntil !== null
      && episode.snoozedUntil.getTime() > now.getTime()
      ? { ok: true }
      : { ok: false, reason: 'not_snoozed' };
  }
  if (episode.status !== 'open') return { ok: false, reason: 'episode_closed' };
  if (action === 'promote' && episode.linkedAlertId) return { ok: false, reason: 'already_promoted' };
  return { ok: true };
}

export interface ApplyEpisodeActionInput {
  orgId: string;
  deviceId: string;
  episodeId: string;
  action: EpisodeAction;
  note?: string;
  /** Only meaningful for `resolve` on a promoted episode. Default true (§8.2). */
  resolveAlert?: boolean;
  actorUserId: string;
  now?: Date;
}

export type ApplyEpisodeActionResult =
  | { status: 'not_found' }
  | { status: 'conflict'; reason: EpisodeActionConflict; message: string }
  | {
      status: 'ok';
      episodeId: string;
      action: EpisodeAction;
      alertId: string | null;
      alertResolved: boolean;
      labelledMemberIds: string[];
      feedbackInserted: number;
    };

function conflict(reason: EpisodeActionConflict): ApplyEpisodeActionResult {
  return { status: 'conflict', reason, message: EPISODE_ACTION_CONFLICT_MESSAGES[reason] };
}

async function lockEpisode(input: ApplyEpisodeActionInput): Promise<EpisodeRow | undefined> {
  const [row] = await db
    .select()
    .from(metricAnomalyEpisodes)
    .where(and(
      eq(metricAnomalyEpisodes.id, input.episodeId),
      eq(metricAnomalyEpisodes.orgId, input.orgId),
      eq(metricAnomalyEpisodes.deviceId, input.deviceId),
    ))
    .limit(1)
    .for('update');
  return row;
}

function episodeWhere(episode: EpisodeRow) {
  return and(eq(metricAnomalyEpisodes.id, episode.id), eq(metricAnomalyEpisodes.orgId, episode.orgId));
}

function memberWhere(episode: EpisodeRow) {
  return and(eq(metricAnomalies.orgId, episode.orgId), eq(metricAnomalies.episodeId, episode.id));
}

async function cascadeOpenMembers(
  episode: EpisodeRow,
  status: 'resolved' | 'dismissed' | 'promoted',
  now: Date,
  linkedAlertId?: string,
): Promise<LabelledMember[]> {
  return db
    .update(metricAnomalies)
    .set({
      status,
      resolvedAt: status === 'resolved' ? now : null,
      updatedAt: now,
      ...(linkedAlertId ? { linkedAlertId } : {}),
    })
    .where(and(memberWhere(episode), eq(metricAnomalies.status, 'open')))
    .returning({ id: metricAnomalies.id, metricName: metricAnomalies.metricName, anomalyType: metricAnomalies.anomalyType });
}

async function labelMembers(
  episode: EpisodeRow,
  outcome: 'dismissed' | 'promoted' | 'resolved',
  members: LabelledMember[],
  input: ApplyEpisodeActionInput,
  now: Date,
  extra: Record<string, unknown> = {},
): Promise<number> {
  if (members.length === 0) return 0;
  return emitAnomalyEpisodeMemberFeedback({
    orgId: episode.orgId,
    episodeId: episode.id,
    members,
    outcome,
    actorUserId: input.actorUserId,
    occurredAt: now,
    metadata: { route: 'devices.anomalyEpisodes.action', note: input.note, ...extra },
  });
}

function ok(
  episode: EpisodeRow,
  input: ApplyEpisodeActionInput,
  fields: { alertId: string | null; alertResolved: boolean; members: LabelledMember[]; feedbackInserted: number },
): ApplyEpisodeActionResult {
  return {
    status: 'ok',
    episodeId: episode.id,
    action: input.action,
    alertId: fields.alertId,
    alertResolved: fields.alertResolved,
    labelledMemberIds: fields.members.map((m) => m.id),
    feedbackInserted: fields.feedbackInserted,
  };
}

async function resolveEpisode(episode: EpisodeRow, input: ApplyEpisodeActionInput, now: Date): Promise<ApplyEpisodeActionResult> {
  await db
    .update(metricAnomalyEpisodes)
    .set({
      status: 'resolved',
      closeReason: 'user',
      resolvedAt: now,
      resolvedByUserId: input.actorUserId,
      note: input.note ?? episode.note,
      updatedAt: now,
    })
    .where(episodeWhere(episode));
  const members = await cascadeOpenMembers(episode, 'resolved', now);
  const feedbackInserted = await labelMembers(episode, 'resolved', members, input, now);

  let alertResolved = false;
  if (input.resolveAlert !== false && episode.linkedAlertId) {
    alertResolved = await resolveAlert(episode.linkedAlertId, input.note ?? DEFAULT_EPISODE_RESOLVE_NOTE, input.actorUserId);
    if (alertResolved) {
      await emitAlertStateFeedback({
        orgId: episode.orgId,
        alertId: episode.linkedAlertId,
        eventType: 'alert.resolved',
        outcome: 'resolved',
        actorUserId: input.actorUserId,
        occurredAt: now,
        metadata: { source: 'devices.anomalyEpisodes', episodeId: episode.id },
      });
    }
  }
  return ok(episode, input, { alertId: episode.linkedAlertId ?? null, alertResolved, members, feedbackInserted });
}

async function dismissEpisode(episode: EpisodeRow, input: ApplyEpisodeActionInput, now: Date): Promise<ApplyEpisodeActionResult> {
  await db
    .update(metricAnomalyEpisodes)
    .set({
      status: 'dismissed',
      closeReason: 'user',
      resolvedAt: now,
      resolvedByUserId: input.actorUserId,
      snoozedUntil: new Date(now.getTime() + EPISODE_SNOOZE_DAYS * DAY_MS),
      note: input.note ?? episode.note,
      updatedAt: now,
    })
    .where(episodeWhere(episode));
  const members = await cascadeOpenMembers(episode, 'dismissed', now);
  const feedbackInserted = await labelMembers(episode, 'dismissed', members, input, now);
  // A linked alert is deliberately left alone: dismissing the signal is not a
  // verdict on an alert a tech may already be working.
  return ok(episode, input, { alertId: episode.linkedAlertId ?? null, alertResolved: false, members, feedbackInserted });
}

async function stampEpisodeOnAlertContext(alertId: string, episode: EpisodeRow): Promise<void> {
  await db
    .update(alerts)
    .set({ context: sql`coalesce(${alerts.context}, '{}'::jsonb) || jsonb_build_object('episodeId', ${episode.id}::text)` })
    .where(and(
      eq(alerts.id, alertId),
      eq(alerts.orgId, episode.orgId),
      sql`NOT (coalesce(${alerts.context}, '{}'::jsonb) ? 'episodeId')`,
    ));
}

async function promoteEpisode(episode: EpisodeRow, input: ApplyEpisodeActionInput, now: Date): Promise<ApplyEpisodeActionResult> {
  // Snapshot BEFORE promotion: the service promotes the peak and its
  // same-window siblings itself, so they would be missing from the cascade's
  // RETURNING (spec deviation D-5).
  const openBefore = await db
    .select({ id: metricAnomalies.id })
    .from(metricAnomalies)
    .where(and(memberWhere(episode), eq(metricAnomalies.status, 'open')));

  // Never overwrite a label a human set through the per-row route.
  const [peak] = await db
    .select({ id: metricAnomalies.id })
    .from(metricAnomalies)
    .where(and(memberWhere(episode), inArray(metricAnomalies.status, ['open', 'promoted'])))
    .orderBy(desc(metricAnomalies.score), asc(metricAnomalies.id))
    .limit(1);
  if (!peak) return conflict('no_promotable_member');

  const promotion = await promoteMetricAnomalyToAlert({
    orgId: episode.orgId,
    deviceId: episode.deviceId,
    anomalyId: peak.id,
    actorUserId: input.actorUserId,
    requireCreateAlertsFlag: false,
    episodeId: episode.id,
  });
  if (promotion.status === 'not_found') return { status: 'not_found' };
  if (promotion.status === 'disabled') return conflict('promotion_disabled');
  if (!promotion.created) await stampEpisodeOnAlertContext(promotion.alertId, episode);

  await db
    .update(metricAnomalyEpisodes)
    .set({ linkedAlertId: promotion.alertId, note: input.note ?? episode.note, updatedAt: now })
    .where(episodeWhere(episode));
  const cascaded = await cascadeOpenMembers(episode, 'promoted', now, promotion.alertId);

  const candidateIds = [...new Set([...openBefore.map((m) => m.id), ...cascaded.map((m) => m.id)])];
  const labelled: LabelledMember[] = candidateIds.length === 0 ? [] : await db
    .select({ id: metricAnomalies.id, metricName: metricAnomalies.metricName, anomalyType: metricAnomalies.anomalyType })
    .from(metricAnomalies)
    .where(and(memberWhere(episode), eq(metricAnomalies.status, 'promoted'), inArray(metricAnomalies.id, candidateIds)));
  const feedbackInserted = await labelMembers(episode, 'promoted', labelled, input, now, {
    linkedAlertId: promotion.alertId,
    createdAlert: promotion.created,
  });
  return ok(episode, input, { alertId: promotion.alertId, alertResolved: false, members: labelled, feedbackInserted });
}

async function unsnoozeEpisode(episode: EpisodeRow, input: ApplyEpisodeActionInput, now: Date): Promise<ApplyEpisodeActionResult> {
  // Spec deviation D-4: assembly consults the MOST RECENT dismissed episode
  // for the key, and snoozed successors copy snoozed_until — so clear them all.
  await db
    .update(metricAnomalyEpisodes)
    .set({ snoozedUntil: null, updatedAt: now })
    .where(and(
      eq(metricAnomalyEpisodes.orgId, episode.orgId),
      eq(metricAnomalyEpisodes.deviceId, episode.deviceId),
      eq(metricAnomalyEpisodes.episodeKey, episode.episodeKey),
      eq(metricAnomalyEpisodes.status, 'dismissed'),
      gt(metricAnomalyEpisodes.snoozedUntil, now),
    ));
  return ok(episode, input, { alertId: episode.linkedAlertId ?? null, alertResolved: false, members: [], feedbackInserted: 0 });
}

export async function applyEpisodeAction(input: ApplyEpisodeActionInput): Promise<ApplyEpisodeActionResult> {
  const now = input.now ?? new Date();
  const episode = await lockEpisode(input);
  if (!episode) return { status: 'not_found' };

  const decision = decideEpisodeAction(episode, input.action, now);
  if (!decision.ok) return conflict(decision.reason);

  switch (input.action) {
    case 'resolve':
      return resolveEpisode(episode, input, now);
    case 'dismiss':
      return dismissEpisode(episode, input, now);
    case 'promote':
      return promoteEpisode(episode, input, now);
    case 'unsnooze':
      return unsnoozeEpisode(episode, input, now);
  }
}
```

- [ ] **Step 5: Run both and watch them pass**

```bash
cd apps/api && npx vitest run src/services/metricAnomalyEpisodeActions.test.ts
pnpm --filter @breeze/api test:integration src/__tests__/integration/metricAnomalyEpisodeActions.integration.test.ts
```
Expected: PASS (14 unit cases from `it.each`, 11 integration tests).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/metricAnomalyEpisodeActions.ts apps/api/src/services/metricAnomalyEpisodeActions.test.ts apps/api/src/__tests__/integration/metricAnomalyEpisodeActions.integration.test.ts
git commit -m "feat(api): episode actions — resolve/dismiss+snooze/promote/unsnooze with per-member labels (W02)"
```

---

### Task 6: Episode routes on `anomaliesRoutes`

**Files:**
- Modify: `apps/api/src/routes/devices/anomalies.ts`
- Create: `apps/api/src/routes/devices/anomalies.episodes.test.ts`
- Modify: `apps/api/src/routes/devices/anomalies.test.ts` (add module mocks only)

**Interfaces:**
- Consumes: Task 2 `listDeviceEpisodes`, `getDeviceEpisodeDetail`, `getDeviceEpisodeDto`; Task 5 `applyEpisodeAction`; Task 1 `EPISODE_ACTIONS`, `EPISODE_LIST_STATUSES`.
- Produces (HTTP; W04 consumes these):
  - `GET /devices/:id/anomaly-episodes?status&limit&ref` → `200 MetricAnomalyEpisodeListResponse`
  - `GET /devices/:id/anomaly-episodes/:episodeId` → `200 { data: MetricAnomalyEpisodeDetailDto }` | 404
  - `PATCH /devices/:id/anomaly-episodes/:episodeId` body `{ action, note?, resolveAlert? }` → `200 { data: MetricAnomalyEpisodeDto, meta: { alertId: string | null; alertResolved: boolean; labelledMembers: number } }` | 400 | 403 | 404 | `409 { error, reason }`

- [ ] **Step 1: Write the failing route test**

`apps/api/src/routes/devices/anomalies.episodes.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const {
  getDeviceWithOrgAndSiteCheckMock,
  listDeviceEpisodesMock,
  getDeviceEpisodeDetailMock,
  getDeviceEpisodeDtoMock,
  applyEpisodeActionMock,
  writeRouteAuditMock,
} = vi.hoisted(() => ({
  getDeviceWithOrgAndSiteCheckMock: vi.fn(),
  listDeviceEpisodesMock: vi.fn(),
  getDeviceEpisodeDetailMock: vi.fn(),
  getDeviceEpisodeDtoMock: vi.fn(),
  applyEpisodeActionMock: vi.fn(),
  writeRouteAuditMock: vi.fn(),
}));

vi.mock('../../db', () => ({ db: { select: vi.fn(), update: vi.fn() } }));
vi.mock('../../db/schema', () => ({ metricAnomalies: {} }));
vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: '77777777-7777-4777-8777-777777777777', email: 'test@example.com' },
      orgId: '11111111-1111-4111-8111-111111111111',
      scope: 'organization',
    });
    return next();
  }),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
}));
vi.mock('../../services/metricAnomalyPromotion', () => ({ promoteMetricAnomalyToAlert: vi.fn() }));
vi.mock('../../services/mlFeedbackEmitters', () => ({ emitAnomalyFeedback: vi.fn() }));
vi.mock('../../services/permissions', () => ({
  PERMISSIONS: {
    ALERTS_WRITE: { resource: 'alerts', action: 'write' },
    DEVICES_READ: { resource: 'devices', action: 'read' },
  },
}));
vi.mock('./helpers', () => ({
  SITE_ACCESS_DENIED: Symbol.for('site-access-denied'),
  getDeviceWithOrgAndSiteCheck: getDeviceWithOrgAndSiteCheckMock,
}));
vi.mock('../../services/metricAnomalyEpisodeQueries', () => ({
  listDeviceEpisodes: listDeviceEpisodesMock,
  getDeviceEpisodeDetail: getDeviceEpisodeDetailMock,
  getDeviceEpisodeDto: getDeviceEpisodeDtoMock,
}));
vi.mock('../../services/metricAnomalyEpisodeActions', () => ({ applyEpisodeAction: applyEpisodeActionMock }));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: writeRouteAuditMock }));

import { anomaliesRoutes } from './anomalies';

const ORG = '11111111-1111-4111-8111-111111111111';
const DEVICE = '22222222-2222-4222-8222-222222222222';
const EPISODE = '55555555-5555-4555-8555-555555555555';
const MEMBER = '33333333-3333-4333-8333-333333333333';
const device = { id: DEVICE, orgId: ORG };
const dto = { id: EPISODE, status: 'dismissed', snoozed: true };

function patch(app: Hono, body: unknown, episodeId = EPISODE) {
  return app.request(`/devices/${DEVICE}/anomaly-episodes/${episodeId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('device anomaly episode routes (W02)', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    getDeviceWithOrgAndSiteCheckMock.mockResolvedValue(device);
    listDeviceEpisodesMock.mockResolvedValue({ data: [dto], focusedEpisodeId: null });
    getDeviceEpisodeDetailMock.mockResolvedValue({ ...dto, members: [], membersTruncated: false });
    getDeviceEpisodeDtoMock.mockResolvedValue(dto);
    applyEpisodeActionMock.mockResolvedValue({
      status: 'ok', episodeId: EPISODE, action: 'dismiss', alertId: null, alertResolved: false,
      labelledMemberIds: [MEMBER], feedbackInserted: 1,
    });
    app = new Hono();
    app.route('/devices', anomaliesRoutes);
  });

  describe('GET /:id/anomaly-episodes', () => {
    it('defaults to status=open, limit=25 and scopes by the device org', async () => {
      const res = await app.request(`/devices/${DEVICE}/anomaly-episodes`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ data: [dto], focusedEpisodeId: null });
      expect(listDeviceEpisodesMock).toHaveBeenCalledWith({ orgId: ORG, deviceId: DEVICE, status: 'open', limit: 25, ref: undefined });
    });

    it('passes status, limit and ref through', async () => {
      const res = await app.request(`/devices/${DEVICE}/anomaly-episodes?status=closed&limit=5&ref=${MEMBER}`);
      expect(res.status).toBe(200);
      expect(listDeviceEpisodesMock).toHaveBeenCalledWith({ orgId: ORG, deviceId: DEVICE, status: 'closed', limit: 5, ref: MEMBER });
    });

    it.each([
      'status=cleared', 'status=bogus', 'limit=0', 'limit=101', 'ref=not-a-uuid',
    ])('rejects %s with 400', async (qs) => {
      const res = await app.request(`/devices/${DEVICE}/anomaly-episodes?${qs}`);
      expect(res.status).toBe(400);
      expect(listDeviceEpisodesMock).not.toHaveBeenCalled();
    });

    it('404s a device outside the caller org (cross-org is never 403)', async () => {
      getDeviceWithOrgAndSiteCheckMock.mockResolvedValue(null);
      const res = await app.request(`/devices/${DEVICE}/anomaly-episodes`);
      expect(res.status).toBe(404);
      expect(listDeviceEpisodesMock).not.toHaveBeenCalled();
    });

    it('403s a site-restricted device', async () => {
      getDeviceWithOrgAndSiteCheckMock.mockResolvedValue(Symbol.for('site-access-denied'));
      const res = await app.request(`/devices/${DEVICE}/anomaly-episodes`);
      expect(res.status).toBe(403);
    });
  });

  describe('GET /:id/anomaly-episodes/:episodeId', () => {
    it('returns the detail DTO', async () => {
      const res = await app.request(`/devices/${DEVICE}/anomaly-episodes/${EPISODE}`);
      expect(res.status).toBe(200);
      expect((await res.json()).data).toMatchObject({ id: EPISODE, members: [], membersTruncated: false });
      expect(getDeviceEpisodeDetailMock).toHaveBeenCalledWith({ orgId: ORG, deviceId: DEVICE, episodeId: EPISODE });
    });

    it('404s an unknown episode', async () => {
      getDeviceEpisodeDetailMock.mockResolvedValue(null);
      expect((await app.request(`/devices/${DEVICE}/anomaly-episodes/${EPISODE}`)).status).toBe(404);
    });

    it('400s a non-uuid episode id', async () => {
      expect((await app.request(`/devices/${DEVICE}/anomaly-episodes/nope`)).status).toBe(400);
      expect(getDeviceEpisodeDetailMock).not.toHaveBeenCalled();
    });
  });

  describe('PATCH /:id/anomaly-episodes/:episodeId', () => {
    it('applies the action with resolveAlert defaulting to true and audits it', async () => {
      const res = await patch(app, { action: 'dismiss', note: '  nightly backup  ' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ data: dto, meta: { alertId: null, alertResolved: false, labelledMembers: 1 } });
      expect(applyEpisodeActionMock).toHaveBeenCalledWith({
        orgId: ORG, deviceId: DEVICE, episodeId: EPISODE, action: 'dismiss', note: 'nightly backup',
        resolveAlert: true, actorUserId: '77777777-7777-4777-8777-777777777777',
      });
      expect(writeRouteAuditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        orgId: ORG, action: 'device.anomaly_episode.dismiss', resourceType: 'metric_anomaly_episode', resourceId: EPISODE,
      }));
    });

    it('passes resolveAlert: false through', async () => {
      await patch(app, { action: 'resolve', resolveAlert: false });
      expect(applyEpisodeActionMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'resolve', resolveAlert: false }));
    });

    it.each([
      [{ action: 'reopen' }], [{}], [{ action: 'dismiss', note: 'x'.repeat(501) }], [{ action: 'resolve', resolveAlert: 'no' }],
    ])('rejects body %j with 400', async (body) => {
      expect((await patch(app, body)).status).toBe(400);
      expect(applyEpisodeActionMock).not.toHaveBeenCalled();
    });

    it('maps conflict to 409 with the reason', async () => {
      applyEpisodeActionMock.mockResolvedValue({ status: 'conflict', reason: 'episode_closed', message: 'This anomaly has already closed' });
      const res = await patch(app, { action: 'resolve' });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'This anomaly has already closed', reason: 'episode_closed' });
      expect(writeRouteAuditMock).not.toHaveBeenCalled();
    });

    it('maps not_found to 404', async () => {
      applyEpisodeActionMock.mockResolvedValue({ status: 'not_found' });
      expect((await patch(app, { action: 'promote' })).status).toBe(404);
    });

    it('404s a cross-org device without touching the service', async () => {
      getDeviceWithOrgAndSiteCheckMock.mockResolvedValue(null);
      expect((await patch(app, { action: 'dismiss' })).status).toBe(404);
      expect(applyEpisodeActionMock).not.toHaveBeenCalled();
    });
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `cd apps/api && npx vitest run src/routes/devices/anomalies.episodes.test.ts`
Expected: FAIL. The episode paths return 404, because no handler exists.

- [ ] **Step 3: Implement the endpoints**

In `apps/api/src/routes/devices/anomalies.ts`, extend W01's existing `import { METRIC_ANOMALY_STATUSES } from '@breeze/shared';` line (one import per module) and add the rest:

```ts
import { EPISODE_ACTIONS, EPISODE_LIST_STATUSES, METRIC_ANOMALY_STATUSES } from '@breeze/shared';
import { writeRouteAudit } from '../../services/auditEvents';
import { applyEpisodeAction } from '../../services/metricAnomalyEpisodeActions';
import {
  getDeviceEpisodeDetail,
  getDeviceEpisodeDto,
  listDeviceEpisodes,
} from '../../services/metricAnomalyEpisodeQueries';
```

Then, after the last existing handler, add:

```ts
// ── Metric anomaly EPISODES (spec §8, §12 — W02) ─────────────────────────
// Registered here, not in a new module: the per-row anomaly routes and these
// share one resource family and one MCP_COVERAGE gap (#6141) — see the W02
// plan's spec deviation D-3.

const episodeListQuerySchema = z.object({
  status: z.enum(EPISODE_LIST_STATUSES).optional().default('open'),
  limit: z.coerce.number().int().min(1).max(100).optional().default(25),
  ref: z.string().guid().optional(),
});

const episodeParamSchema = z.object({
  id: z.string(),
  episodeId: z.string().guid(),
});

const episodeActionSchema = z.object({
  action: z.enum(EPISODE_ACTIONS),
  note: z.string().trim().max(500).optional(),
  resolveAlert: z.boolean().optional().default(true),
});

anomaliesRoutes.get(
  '/:id/anomaly-episodes',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  zValidator('query', episodeListQuerySchema),
  async (c) => {
    const auth = c.get('auth');
    const deviceId = c.req.param('id');
    const query = c.req.valid('query');

    const device = await getDeviceWithOrgAndSiteCheck(c, deviceId, auth);
    if (device === SITE_ACCESS_DENIED) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    const result = await listDeviceEpisodes({
      orgId: device.orgId,
      deviceId,
      status: query.status,
      limit: query.limit,
      ref: query.ref,
    });
    return c.json(result);
  }
);

anomaliesRoutes.get(
  '/:id/anomaly-episodes/:episodeId',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.DEVICES_READ.resource, PERMISSIONS.DEVICES_READ.action),
  zValidator('param', episodeParamSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id: deviceId, episodeId } = c.req.valid('param');

    const device = await getDeviceWithOrgAndSiteCheck(c, deviceId, auth);
    if (device === SITE_ACCESS_DENIED) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    const detail = await getDeviceEpisodeDetail({ orgId: device.orgId, deviceId, episodeId });
    if (!detail) {
      return c.json({ error: 'Anomaly episode not found' }, 404);
    }
    return c.json({ data: detail });
  }
);

anomaliesRoutes.patch(
  '/:id/anomaly-episodes/:episodeId',
  requireScope('organization', 'partner', 'system'),
  requirePermission(PERMISSIONS.ALERTS_WRITE.resource, PERMISSIONS.ALERTS_WRITE.action),
  zValidator('param', episodeParamSchema),
  zValidator('json', episodeActionSchema),
  async (c) => {
    const auth = c.get('auth');
    const { id: deviceId, episodeId } = c.req.valid('param');
    const input = c.req.valid('json');

    const device = await getDeviceWithOrgAndSiteCheck(c, deviceId, auth);
    if (device === SITE_ACCESS_DENIED) {
      return c.json({ error: 'Access to this site denied' }, 403);
    }
    if (!device) {
      return c.json({ error: 'Device not found' }, 404);
    }

    const result = await applyEpisodeAction({
      orgId: device.orgId,
      deviceId,
      episodeId,
      action: input.action,
      note: input.note,
      resolveAlert: input.resolveAlert,
      actorUserId: auth.user.id,
    });

    if (result.status === 'not_found') {
      return c.json({ error: 'Anomaly episode not found' }, 404);
    }
    if (result.status === 'conflict') {
      return c.json({ error: result.message, reason: result.reason }, 409);
    }

    writeRouteAudit(c, {
      orgId: device.orgId,
      action: `device.anomaly_episode.${input.action}`,
      resourceType: 'metric_anomaly_episode',
      resourceId: episodeId,
      details: {
        deviceId,
        labelledMembers: result.labelledMemberIds.length,
        alertId: result.alertId,
        alertResolved: result.alertResolved,
        resolveAlert: input.resolveAlert,
      },
    });

    const data = await getDeviceEpisodeDto({ orgId: device.orgId, deviceId, episodeId });
    if (!data) {
      return c.json({ error: 'Anomaly episode not found' }, 404);
    }
    return c.json({
      data,
      meta: {
        alertId: result.alertId,
        alertResolved: result.alertResolved,
        labelledMembers: result.labelledMemberIds.length,
      },
    });
  }
);
```

- [ ] **Step 3b: Legacy `cleared` (W01 owns it — normally a no-op).** W01 Task 1 Steps 5-7 already changed `anomaliesQuerySchema.status` to `z.enum([...METRIC_ANOMALY_STATUSES, 'all'])` and added the `accepts status=cleared on the legacy list route` test to `anomalies.test.ts`. Only if Task 1 Step 1's last `rg -n "METRIC_ANOMALY_STATUSES" apps/api/src/routes/devices/anomalies.ts` printed nothing, apply exactly W01 Task 1 Steps 5-7 here (same code, same test). The per-row PATCH enum stays `dismissed | promoted | resolved`: `cleared` is machine-only.

- [ ] **Step 4: Keep the existing per-row test isolated from the new imports**

In `apps/api/src/routes/devices/anomalies.test.ts`, add next to the other `vi.mock` calls:

```ts
vi.mock('../../services/metricAnomalyEpisodeQueries', () => ({
  listDeviceEpisodes: vi.fn(),
  getDeviceEpisodeDetail: vi.fn(),
  getDeviceEpisodeDto: vi.fn(),
}));
vi.mock('../../services/metricAnomalyEpisodeActions', () => ({ applyEpisodeAction: vi.fn() }));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
```

- [ ] **Step 5: Run the route tests and the static route contracts**

```bash
cd apps/api && npx vitest run src/routes/devices/anomalies.episodes.test.ts src/routes/devices/anomalies.test.ts src/__tests__/mcp-coverage.test.ts
pnpm --filter @breeze/api test:site-scope-coverage
```
Expected: all PASS. `mcp-coverage` stays green because no new route module was added. `site-scope-coverage` passes because every handler calls `getDeviceWithOrgAndSiteCheck`.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/devices/anomalies.ts apps/api/src/routes/devices/anomalies.episodes.test.ts apps/api/src/routes/devices/anomalies.test.ts
git commit -m "feat(api): device anomaly episode routes — list/detail/PATCH actions (W02)"
```

---

### Task 7: Alert auto-resolve on automatic close (spec §7, alert half)

**Files:**
- Create: `apps/api/src/services/metricAnomalyEpisodeAlerts.ts`
- Create: `apps/api/src/services/metricAnomalyEpisodeAlerts.test.ts`
- Create: `apps/api/src/__tests__/integration/metricAnomalyEpisodeAlerts.integration.test.ts`
- Modify: `apps/api/src/jobs/metricAnomalies.ts:246` (`initializeMetricAnomaliesWorker`)
- Modify: `apps/api/src/jobs/metricAnomalies.test.ts`

**Interfaces:**
- Consumes: W01 `setEpisodeCloseHandler(fn: EpisodeCloseHandler | null)` where `EpisodeCloseHandler = (orgId: string, closed: EpisodeCloseResult[]) => Promise<void>`, invoked by W01's `notifyEpisodesClosed` (which already catches, logs and Sentry-captures a handler error); `EpisodeCloseResult`; `resolveAlert` (`alertService.ts:715`).
- Produces:
  - `AUTO_CLOSE_REASONS = ['cleared', 'expired_offline', 'expired_no_data'] as const`
  - `EPISODE_ALERT_CATCHUP_HOURS = 24`
  - `autoResolveNoteFor(closeReason: string | null): string`
  - `resolveAlertsForAutoClosedEpisodes(orgId: string, now?: Date): Promise<number>`. Returns the number of alerts resolved.
  - `handleEpisodesClosed(orgId: string, closed: EpisodeCloseResult[]): Promise<void>`. Never throws; logs and captures instead.
  - `registerEpisodeCloseAlertHandler(): void`

**DB-context decision.** The handler opens its work with `withSystemDbAccessContext` and never calls `runOutsideDbContext`. Called outside any context, it opens one short system transaction for itself. Called inside one, it joins, which means no second pooled connection is ever taken (CLAUDE.md #1105/#2417). The correct call site is **after** the stage transactions commit, because of the reasons in spec deviation D-8. W01 already calls it there; Step 1 verifies that. The handler does not trust the list it is given. It re-selects "auto-closed in the last 24 h, linked alert still `active`, `requires_human = false`". A crash between the episode close and the alert resolve is therefore repaired on the next close in that org, and a second invocation is a no-op because `resolveAlert` is a CAS.

- [ ] **Step 1: Verify W01's invocation site (no code change expected)**

```bash
rg -n "notifyEpisodesClosed|pending.closed|closed.push" apps/api/src/services/metricAnomalies.ts
rg -n "export async function notifyEpisodesClosed|export function setEpisodeCloseHandler" apps/api/src/services/metricAnomalyEpisodes.ts
```

Read every hit. W01 Task 9 ships this shape in `detectMetricAnomaliesRange`, and it is what this task relies on:

```ts
  for (const [stage, run] of orderedStages) {
    pending.closed = [];
    const result = await runDetectionStage(stage, options.orgId, run);
    stages.push(result);
    if (result.outcome === 'completed') closed.push(...pending.closed);
    …
  }
  … // optional v1-shadow stage
  // After every stage transaction has committed, outside any DB context.
  await notifyEpisodesClosed(options.orgId, closed);
```

Check three things: (1) `closed` collects from BOTH the `episodes` stage (supersedes — Task 8 keeps that value flowing through the wrapper) and the `episode-resolve` stage; (2) only `completed` stages contribute (a timed-out or locked stage rolled back); (3) `notifyEpisodesClosed` is called once, after the loop, not inside a stage closure, and `processDetectOrgRange` (`jobs/metricAnomalies.ts`) holds no DB context. If W01 merged a different shape, restore this one inside W01's function and re-run `cd apps/api && npx vitest run src/services/metricAnomalies.test.ts` (W01's `hands every auto-closed episode to the close handler once, after the stages` test pins it).

- [ ] **Step 2: Write the failing unit test**

`apps/api/src/services/metricAnomalyEpisodeAlerts.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { withSystemDbAccessContextMock, setEpisodeCloseHandlerMock, captureExceptionMock, resolveAlertMock } = vi.hoisted(() => ({
  withSystemDbAccessContextMock: vi.fn(),
  setEpisodeCloseHandlerMock: vi.fn(),
  captureExceptionMock: vi.fn(),
  resolveAlertMock: vi.fn(),
}));

vi.mock('../db', () => ({ db: {}, withSystemDbAccessContext: withSystemDbAccessContextMock }));
vi.mock('./alertService', () => ({ resolveAlert: resolveAlertMock }));
vi.mock('./metricAnomalyEpisodes', () => ({ setEpisodeCloseHandler: setEpisodeCloseHandlerMock }));
vi.mock('./sentry', () => ({ captureException: captureExceptionMock }));

import {
  autoResolveNoteFor,
  handleEpisodesClosed,
  registerEpisodeCloseAlertHandler,
} from './metricAnomalyEpisodeAlerts';

describe('metricAnomalyEpisodeAlerts', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uses the exact spec §7 notes', () => {
    expect(autoResolveNoteFor('cleared')).toBe('Auto-resolved: anomaly episode cleared');
    expect(autoResolveNoteFor('expired_offline')).toBe('Auto-resolved: anomaly episode expired');
    expect(autoResolveNoteFor('expired_no_data')).toBe('Auto-resolved: anomaly episode expired');
  });

  it('registers handleEpisodesClosed as the W01 close hook', () => {
    registerEpisodeCloseAlertHandler();
    expect(setEpisodeCloseHandlerMock).toHaveBeenCalledWith(handleEpisodesClosed);
  });

  it('never throws out of the hook: logs and captures instead', async () => {
    withSystemDbAccessContextMock.mockRejectedValue(new Error('db down'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(handleEpisodesClosed('org-1', [])).resolves.toBeUndefined();
    expect(captureExceptionMock).toHaveBeenCalledWith(expect.objectContaining({ message: 'db down' }));
    errorSpy.mockRestore();
  });
});
```

In `apps/api/src/jobs/metricAnomalies.test.ts`, add a hoisted `registerEpisodeCloseAlertHandlerMock` (put it in that file's existing `vi.hoisted` block, or add `const { registerEpisodeCloseAlertHandlerMock } = vi.hoisted(() => ({ registerEpisodeCloseAlertHandlerMock: vi.fn() }));`) and the mock:

```ts
vi.mock('../services/metricAnomalyEpisodeAlerts', () => ({
  registerEpisodeCloseAlertHandler: registerEpisodeCloseAlertHandlerMock,
}));
```

Then add inside the describe that already calls `initializeMetricAnomaliesWorker()` (around line 168):

```ts
  it('wires the episode close → alert auto-resolve handler at worker init', async () => {
    await initializeMetricAnomaliesWorker();
    expect(registerEpisodeCloseAlertHandlerMock).toHaveBeenCalledTimes(1);
  });
```

Copy that describe's existing `beforeEach` setup for Queue/Worker mocks. The new case reuses it unchanged.

- [ ] **Step 3: Write the failing integration test**

`apps/api/src/__tests__/integration/metricAnomalyEpisodeAlerts.integration.test.ts`:

```ts
import './setup';

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

const { publishEventMock } = vi.hoisted(() => ({
  publishEventMock: vi.fn<(...args: unknown[]) => Promise<string>>(async () => 'test-event-id'),
}));
vi.mock('../../services/eventBus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/eventBus')>();
  return { ...actual, publishEvent: publishEventMock };
});

import { alerts, metricAnomalyEpisodes } from '../../db/schema';
import { detectMetricAnomaliesRange } from '../../services/metricAnomalies';
import {
  registerEpisodeCloseAlertHandler,
  resolveAlertsForAutoClosedEpisodes,
} from '../../services/metricAnomalyEpisodeAlerts';
import { getTestDb } from './setup';
import { insertCleanRollups, insertEpisodeDevice, seedAlert, seedEpisode, seedTenant } from './metricAnomalyEpisodeFixtures';

const HOUR = 3_600_000;

async function alertRow(id: string) {
  const [row] = await getTestDb().select().from(alerts).where(eq(alerts.id, id));
  return row!;
}

describe('episode close → linked alert auto-resolve (W02, spec §7)', () => {
  beforeAll(() => {
    registerEpisodeCloseAlertHandler();
  });

  it('a promoted episode that clears through the resolve stage resolves its active alert', async () => {
    const { org, site } = await seedTenant();
    const deviceId = await insertEpisodeDevice(org.id, site.id);
    const alertId = await seedAlert({ orgId: org.id, deviceId });
    const start = new Date(Date.now() - 3 * HOUR);
    const ep = await seedEpisode({ orgId: org.id, deviceId, memberCount: 3, start, linkedAlertId: alertId, memberStatus: 'promoted' });
    const lastSeen = new Date(start.getTime() + 3 * 300_000);
    await insertCleanRollups({ orgId: org.id, deviceId, metricName: 'disk_write_bps', from: lastSeen, count: 6 });

    // ml.anomalies.enabled is OFF for this org — the resolve stage runs anyway (spec D4).
    await detectMetricAnomaliesRange({ orgId: org.id, from: new Date(Date.now() - HOUR), to: new Date() });

    const [episode] = await getTestDb().select().from(metricAnomalyEpisodes).where(eq(metricAnomalyEpisodes.id, ep.episodeId));
    expect(episode).toMatchObject({ status: 'resolved', closeReason: 'cleared' });
    expect(await alertRow(alertId)).toMatchObject({ status: 'resolved', resolutionNote: 'Auto-resolved: anomaly episode cleared', resolvedBy: null });
  });

  it('a requires-human alert is never auto-resolved', async () => {
    const { org, site } = await seedTenant();
    const deviceId = await insertEpisodeDevice(org.id, site.id);
    const alertId = await seedAlert({ orgId: org.id, deviceId, requiresHuman: true });
    const start = new Date(Date.now() - 3 * HOUR);
    await seedEpisode({ orgId: org.id, deviceId, memberCount: 2, start, linkedAlertId: alertId, memberStatus: 'promoted' });
    await insertCleanRollups({ orgId: org.id, deviceId, metricName: 'disk_write_bps', from: new Date(start.getTime() + 2 * 300_000), count: 6 });

    await detectMetricAnomaliesRange({ orgId: org.id, from: new Date(Date.now() - HOUR), to: new Date() });

    expect((await alertRow(alertId)).status).toBe('active');
  });

  it('catch-up: resolves alerts of episodes auto-closed in the last 24 h only, never user-closed ones', async () => {
    const { org, site } = await seedTenant();
    const deviceId = await insertEpisodeDevice(org.id, site.id);
    const expiredAlert = await seedAlert({ orgId: org.id, deviceId });
    const staleAlert = await seedAlert({ orgId: org.id, deviceId });
    const userAlert = await seedAlert({ orgId: org.id, deviceId });
    await seedEpisode({ orgId: org.id, deviceId, memberCount: 1, start: new Date(Date.now() - 30 * HOUR), status: 'resolved', closeReason: 'expired_no_data', resolvedAt: new Date(Date.now() - HOUR), linkedAlertId: expiredAlert, metricName: 'cpu_percent', metricFamily: 'cpu' });
    await seedEpisode({ orgId: org.id, deviceId, memberCount: 1, start: new Date(Date.now() - 80 * HOUR), status: 'resolved', closeReason: 'cleared', resolvedAt: new Date(Date.now() - 48 * HOUR), linkedAlertId: staleAlert, metricName: 'ram_percent', metricFamily: 'ram' });
    await seedEpisode({ orgId: org.id, deviceId, memberCount: 1, start: new Date(Date.now() - 5 * HOUR), status: 'resolved', closeReason: 'user', resolvedAt: new Date(Date.now() - HOUR), linkedAlertId: userAlert });

    expect(await resolveAlertsForAutoClosedEpisodes(org.id)).toBe(1);

    expect(await alertRow(expiredAlert)).toMatchObject({ status: 'resolved', resolutionNote: 'Auto-resolved: anomaly episode expired' });
    expect((await alertRow(staleAlert)).status).toBe('active');
    expect((await alertRow(userAlert)).status).toBe('active');

    // Idempotent: a second pass resolves nothing.
    expect(await resolveAlertsForAutoClosedEpisodes(org.id)).toBe(0);
  });
});
```

- [ ] **Step 4: Run and watch them fail**

```bash
cd apps/api && npx vitest run src/services/metricAnomalyEpisodeAlerts.test.ts src/jobs/metricAnomalies.test.ts
pnpm --filter @breeze/api test:integration src/__tests__/integration/metricAnomalyEpisodeAlerts.integration.test.ts
```
Expected: FAIL. The module is missing, and the init test sees 0 calls.

- [ ] **Step 5: Implement**

`apps/api/src/services/metricAnomalyEpisodeAlerts.ts`:

```ts
import { and, eq, gte, inArray, ne } from 'drizzle-orm';

import { db, withSystemDbAccessContext } from '../db';
import { alerts, metricAnomalyEpisodes } from '../db/schema';
import { resolveAlert } from './alertService';
import { setEpisodeCloseHandler, type EpisodeCloseResult } from './metricAnomalyEpisodes';
import { captureException } from './sentry';

/**
 * Spec §7 alert half: when an episode closes automatically (cleared /
 * expired_*), resolve its linked alert if that alert is still `active` and
 * not `requires_human`. Promoted anomaly alerts have ruleId NULL, so
 * checkAutoResolve never closes them (alertService.ts:436-458); this is their
 * only automatic path.
 *
 * Crash-safe by construction: the work set is re-derived from the database
 * (auto-closed within EPISODE_ALERT_CATCHUP_HOURS, alert still active), not
 * from the in-memory list, and resolveAlert is a CAS — so a lost invocation is
 * repaired by the next one and a repeated one is a no-op.
 *
 * DB context: withSystemDbAccessContext only — opens a short transaction
 * when called outside a context (the intended call site: after the
 * episode-resolve stage commits) and joins one otherwise. Never
 * runOutsideDbContext, so it can never take a second pooled connection.
 */

export const AUTO_CLOSE_REASONS = ['cleared', 'expired_offline', 'expired_no_data'] as const;
export const EPISODE_ALERT_CATCHUP_HOURS = 24;
const MAX_ALERTS_PER_PASS = 200;

export function autoResolveNoteFor(closeReason: string | null): string {
  return closeReason === 'cleared'
    ? 'Auto-resolved: anomaly episode cleared'
    : 'Auto-resolved: anomaly episode expired';
}

export async function resolveAlertsForAutoClosedEpisodes(orgId: string, now: Date = new Date()): Promise<number> {
  return withSystemDbAccessContext(async () => {
    const since = new Date(now.getTime() - EPISODE_ALERT_CATCHUP_HOURS * 3_600_000);
    const rows = await db
      .select({ alertId: alerts.id, closeReason: metricAnomalyEpisodes.closeReason })
      .from(metricAnomalyEpisodes)
      .innerJoin(alerts, and(
        eq(alerts.id, metricAnomalyEpisodes.linkedAlertId),
        eq(alerts.orgId, metricAnomalyEpisodes.orgId),
      ))
      .where(and(
        eq(metricAnomalyEpisodes.orgId, orgId),
        ne(metricAnomalyEpisodes.status, 'open'),
        inArray(metricAnomalyEpisodes.closeReason, [...AUTO_CLOSE_REASONS]),
        gte(metricAnomalyEpisodes.resolvedAt, since),
        eq(alerts.status, 'active'),
        eq(alerts.requiresHuman, false),
      ))
      .limit(MAX_ALERTS_PER_PASS);

    let resolved = 0;
    const seen = new Set<string>();
    for (const row of rows) {
      if (seen.has(row.alertId)) continue;
      seen.add(row.alertId);
      if (await resolveAlert(row.alertId, autoResolveNoteFor(row.closeReason))) resolved += 1;
    }
    return resolved;
  }, 'metricAnomalyEpisodes.closeAlerts');
}

export async function handleEpisodesClosed(orgId: string, _closed: EpisodeCloseResult[]): Promise<void> {
  try {
    await resolveAlertsForAutoClosedEpisodes(orgId);
  } catch (error) {
    console.error(`[MetricAnomalyEpisodes] org=${orgId} failed to auto-resolve linked alerts:`, error);
    captureException(error instanceof Error ? error : new Error(String(error)));
  }
}

export function registerEpisodeCloseAlertHandler(): void {
  setEpisodeCloseHandler(handleEpisodesClosed);
}
```

In `apps/api/src/jobs/metricAnomalies.ts`, add `import { registerEpisodeCloseAlertHandler } from '../services/metricAnomalyEpisodeAlerts';` and make the first line of `initializeMetricAnomaliesWorker`:

```ts
  // W02: the resolve stage runs in this worker; wire its close hook before
  // the first job can run.
  registerEpisodeCloseAlertHandler();
```

- [ ] **Step 6: Run and watch them pass**

```bash
cd apps/api && npx vitest run src/services/metricAnomalyEpisodeAlerts.test.ts src/jobs/metricAnomalies.test.ts src/services/metricAnomalies.test.ts
pnpm --filter @breeze/api test:integration src/__tests__/integration/metricAnomalyEpisodeAlerts.integration.test.ts
```
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/metricAnomalyEpisodeAlerts.ts apps/api/src/services/metricAnomalyEpisodeAlerts.test.ts apps/api/src/jobs/metricAnomalies.ts apps/api/src/jobs/metricAnomalies.test.ts apps/api/src/__tests__/integration/metricAnomalyEpisodeAlerts.integration.test.ts
git commit -m "feat(api): auto-resolve a promoted anomaly alert when its episode clears or expires (W02)"
```

(Add `services/metricAnomalies.ts` only if Step 1 had to restore W01's call-site shape.)

---

### Task 8: Link incidents to episodes inside the `episodes` stage

**Decision (spec §11):** the link statement is a **W02 addition that runs inside W01's `episodes` stage transaction**, directly after assembly, through the wrapper `assembleEpisodesAndLinkIncidents`. It lives in its own W02 file so that W01's assembly body stays untouched. Running in the same transaction means incidents are linked in the same commit that creates their episodes. With D-2's grace window, the publisher never sees a freshly linked incident half-done.

**Files:**
- Create: `apps/api/src/services/metricAnomalyEpisodeIncidents.ts`
- Create: `apps/api/src/services/metricAnomalyEpisodeIncidents.test.ts`
- Modify: `apps/api/src/services/metricAnomalies.ts` (the `['episodes', …]` entry W01 added to `orderedStages`)
- Modify: `apps/api/src/services/metricAnomalies.test.ts`
- Create: `apps/api/src/__tests__/integration/metricAnomalyEpisodeIncidents.integration.test.ts` (Task 9 appends to it)

**Interfaces:**
- Consumes: W01 `assembleMetricAnomalyEpisodes(range: MetricAnomalyRange): Promise<EpisodeCloseResult[]>` (the open episodes it superseded and closed, W01 deviation 8), `EpisodeCloseResult`.
- Produces:
  - `linkMetricAnomalyIncidentsToEpisodes(orgId: string): Promise<number>`. Sets `metric_anomaly_incidents.episode_id` for incidents still `dispatched_at IS NULL`, choosing the episode of the member with the highest `score`, and returns the number of rows changed.
  - `assembleEpisodesAndLinkIncidents(range: MetricAnomalyRange): Promise<EpisodeCloseResult[]>`. Runs assembly, then the link, and **returns assembly's supersede closes unchanged** so W01's stage loop still hands them to `notifyEpisodesClosed` — a promoted episode that is superseded must reach the Task 7 alert handler exactly like one that auto-resolves.

- [ ] **Step 1: Write the failing unit tests**

`apps/api/src/services/metricAnomalyEpisodeIncidents.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { executeMock, assembleMock } = vi.hoisted(() => ({ executeMock: vi.fn(), assembleMock: vi.fn() }));

vi.mock('../db', () => ({ db: { execute: executeMock } }));
vi.mock('./metricAnomalyEpisodes', () => ({ assembleMetricAnomalyEpisodes: assembleMock }));

import { assembleEpisodesAndLinkIncidents } from './metricAnomalyEpisodeIncidents';

const range = { orgId: '11111111-1111-4111-8111-111111111111', from: new Date('2026-09-21T00:00:00Z'), to: new Date('2026-09-21T01:00:00Z') };
const superseded = [{ episodeId: 'ep-1', deviceId: 'dev-1', linkedAlertId: 'alert-1', closeReason: 'cleared' as const }];

describe('assembleEpisodesAndLinkIncidents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executeMock.mockResolvedValue([]);
    assembleMock.mockResolvedValue([]);
  });

  it('assembles first, then links incidents for the same org, and returns the supersede closes', async () => {
    const order: string[] = [];
    assembleMock.mockImplementation(async () => { order.push('assemble'); return superseded; });
    executeMock.mockImplementation(async () => { order.push('link'); return []; });

    const closed = await assembleEpisodesAndLinkIncidents(range);

    expect(closed).toEqual(superseded);
    expect(order).toEqual(['assemble', 'link']);
    expect(assembleMock).toHaveBeenCalledWith(range);
    const linkSql = JSON.stringify(executeMock.mock.calls[0]);
    expect(linkSql).toContain('UPDATE metric_anomaly_incidents');
    expect(linkSql).toContain('dispatched_at IS NULL');
    expect(linkSql).toContain('ma.score DESC');
    expect(linkSql).toContain(range.orgId);
  });

  it('does not link when assembly fails (the stage rolls back as one unit)', async () => {
    assembleMock.mockRejectedValue(Object.assign(new Error('timeout'), { code: '57014' }));
    await expect(assembleEpisodesAndLinkIncidents(range)).rejects.toThrow('timeout');
    expect(executeMock).not.toHaveBeenCalled();
  });
});
```

In `apps/api/src/services/metricAnomalies.test.ts`, W01 already hoists `assembleMock` and mocks `./metricAnomalyEpisodes` with `assembleMetricAnomalyEpisodes: assembleMock` (W01 Task 9 Step 1). The stage now calls the wrapper instead, so point the wrapper's mock at **the same `assembleMock`** — every W01 episode-stage assertion (`runs assembly after incidents, with the normalised range`, the backfill cases, `hands every auto-closed episode to the close handler once, after the stages` with `assembleMock.mockResolvedValue([superseded])`, the timeout counter) then keeps testing "the `episodes` stage entry" without edits:

```ts
vi.mock('./metricAnomalyEpisodeIncidents', () => ({
  // The `episodes` stage entry (W02 §11). Reuses W01's assembleMock so W01's
  // stage-loop assertions keep meaning "what the episodes stage ran/returned".
  assembleEpisodesAndLinkIncidents: assembleMock,
}));
```

and, in W01's existing `vi.mock('./metricAnomalyEpisodes', …)` factory, replace `assembleMetricAnomalyEpisodes: assembleMock,` with

```ts
  // The stage must go through the W02 wrapper; calling assembly directly
  // would skip the incident link.
  assembleMetricAnomalyEpisodes: vi.fn(async () => {
    throw new Error('episodes stage must call assembleEpisodesAndLinkIncidents (W02)');
  }),
```

That makes the red real: until the stage entry changes, every `episodes` stage in this file throws instead of reaching `assembleMock`.

Then add inside `describe('episode stages (metric anomaly episodes W01)', …)`:

```ts
  it('the episodes stage runs the assemble+link wrapper once and forwards its closes (W02 §11)', async () => {
    const superseded = { episodeId: 'ep-9', deviceId: 'dev-9', linkedAlertId: 'alert-9', closeReason: 'expired_no_data' as const };
    assembleMock.mockResolvedValue([superseded]);
    const result = await detectMetricAnomaliesRange({ orgId, ...range });
    expect(assembleMock).toHaveBeenCalledTimes(1);
    expect(assembleMock).toHaveBeenCalledWith(expect.objectContaining({ orgId }));
    expect(result.stages.find((s) => s.stage === 'episodes')?.outcome).toBe('completed');
    expect(notifyMock).toHaveBeenCalledWith(orgId, [superseded]);
  });
```

- [ ] **Step 2: Write the failing integration test (link semantics)**

`apps/api/src/__tests__/integration/metricAnomalyEpisodeIncidents.integration.test.ts`:

```ts
import './setup';

import { describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

const { publishEventMock } = vi.hoisted(() => ({
  publishEventMock: vi.fn<(...args: unknown[]) => Promise<string>>(async () => 'test-event-id'),
}));
vi.mock('../../services/eventBus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/eventBus')>();
  return { ...actual, publishEvent: publishEventMock };
});

import { withSystemDbAccessContext } from '../../db';
import { metricAnomalies, metricAnomalyIncidents } from '../../db/schema';
import { linkMetricAnomalyIncidentsToEpisodes } from '../../services/metricAnomalyEpisodeIncidents';
import { getTestDb } from './setup';
import { insertEpisodeDevice, seedEpisode, seedIncident, seedTenant } from './metricAnomalyEpisodeFixtures';

const HOUR = 3_600_000;

async function incidentRow(id: string) {
  const [row] = await getTestDb().select().from(metricAnomalyIncidents).where(eq(metricAnomalyIncidents.id, id));
  return row!;
}

describe('incident → episode link (W02 §11)', () => {
  it('links an undispatched incident to the episode of its highest-score member', async () => {
    const { org, site } = await seedTenant();
    const deviceId = await insertEpisodeDevice(org.id, site.id);
    const start = new Date(Math.floor((Date.now() - 2 * HOUR) / 300_000) * 300_000);
    // Two episodes (different families) with a member in the SAME bucket; the ram one scores higher.
    const cpu = await seedEpisode({ orgId: org.id, deviceId, memberCount: 1, start, metricName: 'cpu_percent', metricFamily: 'cpu' });
    const ram = await seedEpisode({ orgId: org.id, deviceId, memberCount: 1, start, metricName: 'ram_percent', metricFamily: 'ram' });
    await getTestDb().update(metricAnomalies).set({ score: 3 }).where(eq(metricAnomalies.id, cpu.memberIds[0]!));
    await getTestDb().update(metricAnomalies).set({ score: 9 }).where(eq(metricAnomalies.id, ram.memberIds[0]!));
    const incidentId = await seedIncident({ orgId: org.id, deviceId, episodeId: null, windowStart: start });

    const changed = await withSystemDbAccessContext(() => linkMetricAnomalyIncidentsToEpisodes(org.id));

    expect(changed).toBe(1);
    expect((await incidentRow(incidentId)).episodeId).toBe(ram.episodeId);
    // Re-running is a no-op.
    expect(await withSystemDbAccessContext(() => linkMetricAnomalyIncidentsToEpisodes(org.id))).toBe(0);
  });

  it('never touches an already-dispatched incident, and leaves an incident whose members are unassembled NULL', async () => {
    const { org, site } = await seedTenant();
    const deviceId = await insertEpisodeDevice(org.id, site.id);
    const start = new Date(Math.floor((Date.now() - 2 * HOUR) / 300_000) * 300_000);
    const ep = await seedEpisode({ orgId: org.id, deviceId, memberCount: 2, start });
    const dispatched = await seedIncident({ orgId: org.id, deviceId, episodeId: null, windowStart: start });
    await getTestDb().update(metricAnomalyIncidents).set({ dispatchedAt: new Date() }).where(eq(metricAnomalyIncidents.id, dispatched));
    await getTestDb().update(metricAnomalies).set({ episodeId: null }).where(eq(metricAnomalies.id, ep.memberIds[1]!));
    const orphan = await seedIncident({ orgId: org.id, deviceId, episodeId: null, windowStart: new Date(start.getTime() + 300_000) });

    await withSystemDbAccessContext(() => linkMetricAnomalyIncidentsToEpisodes(org.id));

    expect((await incidentRow(dispatched)).episodeId).toBeNull();
    expect((await incidentRow(orphan)).episodeId).toBeNull();
  });
});
```

- [ ] **Step 3: Run and watch them fail**

```bash
cd apps/api && npx vitest run src/services/metricAnomalyEpisodeIncidents.test.ts src/services/metricAnomalies.test.ts
pnpm --filter @breeze/api test:integration src/__tests__/integration/metricAnomalyEpisodeIncidents.integration.test.ts
```
Expected: FAIL. The module is missing, and the stage never calls the wrapper.

- [ ] **Step 4: Implement**

`apps/api/src/services/metricAnomalyEpisodeIncidents.ts`:

```ts
import { sql } from 'drizzle-orm';

import { db } from '../db';
import { assembleMetricAnomalyEpisodes, type EpisodeCloseResult } from './metricAnomalyEpisodes';
import type { MetricAnomalyRange } from './metricAnomalies';

/**
 * Spec §11 (W02): metric_anomaly_incidents keeps its per-bucket grain but is
 * pointed at an episode so the publisher can dispatch once per episode. Runs
 * INSIDE the `episodes` stage transaction, right after assembly, so an
 * incident and its episode become visible in the same commit.
 *
 * Choice among members of one incident (same device, anomaly_type,
 * bucket_seconds, window_start): the episode of the highest-score member;
 * ties break on member id for determinism. Incident window_start is
 * timestamptz, metric_anomalies.window_start is timestamp — the join uses the
 * same `AT TIME ZONE 'UTC'` conversion as upsertMetricAnomalyIncidents.
 */
function extractRows<T>(result: unknown): T[] {
  const rows = (result as { rows?: T[] }).rows ?? (result as T[]);
  return Array.isArray(rows) ? rows : [];
}

export async function linkMetricAnomalyIncidentsToEpisodes(orgId: string): Promise<number> {
  const result = await db.execute<{ id: string }>(sql`
    UPDATE metric_anomaly_incidents AS i
    SET episode_id = pick.episode_id
    FROM (
      SELECT DISTINCT ON (inc.id) inc.id AS incident_id, ma.episode_id
      FROM metric_anomaly_incidents inc
      JOIN metric_anomalies ma
        ON ma.org_id = inc.org_id
       AND ma.device_id = inc.device_id
       AND ma.anomaly_type = inc.anomaly_type
       AND ma.bucket_seconds = inc.bucket_seconds
       AND (ma.window_start AT TIME ZONE 'UTC') = inc.window_start
      WHERE inc.org_id = ${orgId}
        AND inc.dispatched_at IS NULL
        AND ma.episode_id IS NOT NULL
      ORDER BY inc.id, ma.score DESC, ma.id
    ) AS pick
    WHERE i.id = pick.incident_id
      AND i.episode_id IS DISTINCT FROM pick.episode_id
    RETURNING i.id
  `);
  return extractRows<{ id: string }>(result).length;
}

/**
 * The `episodes` stage entry. Returns assembly's supersede closes unchanged:
 * W01's stage loop hands them to notifyEpisodesClosed after commit, so a
 * superseded PROMOTED episode reaches the alert handler (Task 7).
 */
export async function assembleEpisodesAndLinkIncidents(range: MetricAnomalyRange): Promise<EpisodeCloseResult[]> {
  const superseded = await assembleMetricAnomalyEpisodes(range);
  await linkMetricAnomalyIncidentsToEpisodes(range.orgId);
  return superseded;
}
```

In `apps/api/src/services/metricAnomalies.ts`, import `assembleEpisodesAndLinkIncidents` from `./metricAnomalyEpisodeIncidents` and change W01's stage entry from

```ts
      ['episodes', async () => {
        pending.closed = await assembleMetricAnomalyEpisodes(range);
      }],
```

to

```ts
      // W02 §11: link incidents to their episodes in the SAME stage
      // transaction; the supersede closes still flow to notifyEpisodesClosed.
      ['episodes', async () => {
        pending.closed = await assembleEpisodesAndLinkIncidents(range);
      }],
```

Remove `assembleMetricAnomalyEpisodes` from that file's `./metricAnomalyEpisodes` import (keep `notifyEpisodesClosed`, `resolveMetricAnomalyEpisodes`, `type EpisodeCloseResult`). There is no import cycle: `metricAnomalyEpisodeIncidents.ts` imports only a type from `./metricAnomalies`.

- [ ] **Step 5: Run and watch them pass**

```bash
cd apps/api && npx vitest run src/services/metricAnomalyEpisodeIncidents.test.ts src/services/metricAnomalies.test.ts
pnpm --filter @breeze/api test:integration src/__tests__/integration/metricAnomalyEpisodeIncidents.integration.test.ts src/__tests__/integration/metricAnomalies.integration.test.ts
```
Expected: PASS. The existing detector integration suite still passes.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/metricAnomalyEpisodeIncidents.ts apps/api/src/services/metricAnomalyEpisodeIncidents.test.ts apps/api/src/services/metricAnomalies.ts apps/api/src/services/metricAnomalies.test.ts apps/api/src/__tests__/integration/metricAnomalyEpisodeIncidents.integration.test.ts
git commit -m "feat(api): link anomaly incidents to episodes in the episodes stage (W02)"
```

---

### Task 9: Publisher dispatches at most once per episode

**Files:**
- Modify: `apps/api/src/jobs/metricAnomalyIncidentPublisher.ts` (constants block ~line 46, `ClaimedIncidentRow`, `PublishIncidentsResult`, `scanAndClaimIncidentRows` claim statement ~lines 140-157, `publishPendingIncidents`, worker log line)
- Modify: `apps/api/src/jobs/metricAnomalyIncidentPublisher.test.ts`
- Modify: `apps/api/src/__tests__/integration/metricAnomalyEpisodeIncidents.integration.test.ts` (append)

**Interfaces:**
- Produces:
  - `EPISODE_INCIDENT_LINK_GRACE_MINUTES = 15` (exported from the publisher)
  - `PublishIncidentsResult = { published: number; skipped: number; suppressed: number }`
  - Claim semantics (spec §11 + deviations D-1/D-2): an incident is claimable when `dispatched_at IS NULL`, `dispatch_attempts <= 5`, and (`episode_id IS NOT NULL` or `created_at < now() - 15 min`). A claimed incident is **suppressed**, meaning `dispatched_at = now()` and `suppressed_by_episode = true` and it is never published, when it has an `episode_id` **and** either (a) it is not the earliest-`window_start` incident of that episode in this batch, or (b) another incident of the same episode already has `agent_run_id IS NOT NULL` or was already published (`dispatched_at IS NOT NULL AND suppressed_by_episode = false`).

- [ ] **Step 1: Write the failing unit tests**

In `apps/api/src/jobs/metricAnomalyIncidentPublisher.test.ts`:

1. Every existing `expect(result).toEqual({ published: X, skipped: Y })` / `expect(second).toEqual({ … })` gains `suppressed: 0`. The four sites are the publish test, the stuck-row test, the empty-claim test's `second`, and the publishEvent-rejects test.
2. `claimedRow()` gains `suppressed_by_episode: false` in its defaults and override type.
3. Add:

```ts
  it('never publishes a row the claim marked suppressed_by_episode, and counts it', async () => {
    executeMock.mockResolvedValueOnce({ rows: [] }); // stuck scan
    executeMock.mockResolvedValueOnce({
      rows: [
        claimedRow({ id: 'incident-a' }),
        claimedRow({ id: 'incident-b', suppressed_by_episode: true }),
        claimedRow({ id: 'incident-c', suppressed_by_episode: true }),
      ],
    });
    const chain = makeUpdateChain();
    updateMock.mockReturnValue({ set: chain.set });

    const result = await publishPendingIncidents();

    expect(result).toEqual({ published: 1, skipped: 0, suppressed: 2 });
    expect(publishEventMock).toHaveBeenCalledTimes(1);
    expect(publishEventMock).toHaveBeenCalledWith(
      'anomaly.incident_opened', 'org-1', { incidentId: 'incident-a', deviceId: 'device-1' }, 'metric-anomaly-incident-publisher',
    );
    expect(updateMock).toHaveBeenCalledTimes(1); // mark-dispatched for incident-a only
  });

  it('a claim of only suppressed rows publishes nothing and marks nothing', async () => {
    executeMock.mockResolvedValueOnce({ rows: [] });
    executeMock.mockResolvedValueOnce({ rows: [claimedRow({ id: 'incident-z', suppressed_by_episode: true })] });

    const result = await publishPendingIncidents();

    expect(result).toEqual({ published: 0, skipped: 0, suppressed: 1 });
    expect(publishEventMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });
```

4. Add this suite next to the existing source-level `describe` blocks:

```ts
describe('metricAnomalyIncidentPublisher — one dispatch per episode (W02, source-level)', () => {
  const src = () => fs.readFileSync(path.join(__dirname, 'metricAnomalyIncidentPublisher.ts'), 'utf8');

  it('suppresses all but the earliest incident of an episode within one claim batch', () => {
    expect(src()).toContain('PARTITION BY d.episode_id ORDER BY d.window_start, d.id');
  });

  it('suppresses when a sibling was already published or already has an agent run', () => {
    expect(src()).toContain('s.agent_run_id IS NOT NULL');
    expect(src()).toContain('s.dispatched_at IS NOT NULL AND s.suppressed_by_episode = false');
  });

  it('marks suppressed rows dispatched in the claim itself so they are never re-claimed', () => {
    expect(src()).toContain('dispatched_at = CASE WHEN decided.suppress THEN now() ELSE i.dispatched_at END');
    expect(src()).toContain('suppressed_by_episode = decided.suppress');
  });

  it('defers unlinked incidents for the grace window instead of racing assembly', () => {
    expect(src()).toContain('make_interval(mins => ${EPISODE_INCIDENT_LINK_GRACE_MINUTES}::int)');
  });
});
```

The existing guards still hold: exactly two `WHERE ${metricAnomalyIncidents.dispatchedAt} IS NULL` and exactly two `ORDER BY ${…}, ${…}`. The new SQL uses raw aliased column names, so it adds neither pattern.

- [ ] **Step 2: Append the failing integration tests**

Add to `metricAnomalyEpisodeIncidents.integration.test.ts`. First extend the import from `drizzle-orm` to `{ and, eq, sql }`. Add `import { publishPendingIncidents } from '../../jobs/metricAnomalyIncidentPublisher';`, then:

```ts
describe('publisher: one dispatch per episode (W02 §11)', () => {
  async function incidentsOf(episodeId: string) {
    return getTestDb().select().from(metricAnomalyIncidents).where(eq(metricAnomalyIncidents.episodeId, episodeId)).orderBy(metricAnomalyIncidents.windowStart);
  }

  it('3 incidents of one episode → 1 published (the earliest), 2 suppressed_by_episode', async () => {
    publishEventMock.mockClear();
    const { org, site } = await seedTenant();
    const deviceId = await insertEpisodeDevice(org.id, site.id);
    const start = new Date(Math.floor((Date.now() - 2 * HOUR) / 300_000) * 300_000);
    const ep = await seedEpisode({ orgId: org.id, deviceId, memberCount: 3, start });
    const ids = [];
    for (let i = 0; i < 3; i++) {
      ids.push(await seedIncident({ orgId: org.id, deviceId, episodeId: ep.episodeId, windowStart: new Date(start.getTime() + i * 300_000) }));
    }

    const result = await publishPendingIncidents();

    expect(result).toEqual({ published: 1, skipped: 0, suppressed: 2 });
    expect(publishEventMock).toHaveBeenCalledTimes(1);
    expect(publishEventMock.mock.calls[0]![2]).toEqual({ incidentId: ids[0], deviceId });
    const rows = await incidentsOf(ep.episodeId);
    expect(rows.map((r) => [r.suppressedByEpisode, r.dispatchedAt !== null, r.dispatchAttempts])).toEqual([
      [false, true, 1], [true, true, 1], [true, true, 1],
    ]);
  });

  it('a later incident of an already-dispatched episode is suppressed on the next pass', async () => {
    publishEventMock.mockClear();
    const { org, site } = await seedTenant();
    const deviceId = await insertEpisodeDevice(org.id, site.id);
    const start = new Date(Math.floor((Date.now() - 2 * HOUR) / 300_000) * 300_000);
    const ep = await seedEpisode({ orgId: org.id, deviceId, memberCount: 2, start });
    await seedIncident({ orgId: org.id, deviceId, episodeId: ep.episodeId, windowStart: start });
    expect(await publishPendingIncidents()).toMatchObject({ published: 1, suppressed: 0 });

    await seedIncident({ orgId: org.id, deviceId, episodeId: ep.episodeId, windowStart: new Date(start.getTime() + 300_000) });
    expect(await publishPendingIncidents()).toEqual({ published: 0, skipped: 0, suppressed: 1 });
    expect(publishEventMock).toHaveBeenCalledTimes(1);
  });

  it('different episodes each get their own dispatch', async () => {
    publishEventMock.mockClear();
    const { org, site } = await seedTenant();
    const deviceId = await insertEpisodeDevice(org.id, site.id);
    const start = new Date(Math.floor((Date.now() - 2 * HOUR) / 300_000) * 300_000);
    const a = await seedEpisode({ orgId: org.id, deviceId, memberCount: 1, start, metricName: 'cpu_percent', metricFamily: 'cpu' });
    const b = await seedEpisode({ orgId: org.id, deviceId, memberCount: 1, start, metricName: 'ram_percent', metricFamily: 'ram', anomalyType: 'drop' });
    await seedIncident({ orgId: org.id, deviceId, episodeId: a.episodeId, windowStart: start });
    await seedIncident({ orgId: org.id, deviceId, episodeId: b.episodeId, windowStart: start, anomalyType: 'drop' });

    expect(await publishPendingIncidents()).toEqual({ published: 2, skipped: 0, suppressed: 0 });
  });

  it('an unlinked incident waits out the 15-minute grace window, then dispatches as before', async () => {
    publishEventMock.mockClear();
    const { org, site } = await seedTenant();
    const deviceId = await insertEpisodeDevice(org.id, site.id);
    const incidentId = await seedIncident({ orgId: org.id, deviceId, episodeId: null, windowStart: new Date(Date.now() - HOUR) });

    expect(await publishPendingIncidents()).toEqual({ published: 0, skipped: 0, suppressed: 0 });
    expect((await getTestDb().select().from(metricAnomalyIncidents).where(eq(metricAnomalyIncidents.id, incidentId)))[0]!.dispatchAttempts).toBe(0);

    await getTestDb().update(metricAnomalyIncidents).set({ createdAt: sql`now() - interval '16 minutes'` }).where(eq(metricAnomalyIncidents.id, incidentId));
    expect(await publishPendingIncidents()).toEqual({ published: 1, skipped: 0, suppressed: 0 });
  });
});
```

- [ ] **Step 3: Run and watch them fail**

```bash
cd apps/api && npx vitest run src/jobs/metricAnomalyIncidentPublisher.test.ts
pnpm --filter @breeze/api test:integration src/__tests__/integration/metricAnomalyEpisodeIncidents.integration.test.ts
```
Expected: FAIL. The result has no `suppressed`, the source strings are absent, and in integration all three incidents publish.

- [ ] **Step 4: Implement**

In `metricAnomalyIncidentPublisher.ts`:

After `export const MAX_PUBLISH_ATTEMPTS = 5;`:

```ts
/**
 * W02 (spec deviation D-2): an incident with no episode yet is held back this
 * long so the `episodes` stage — which commits after the `incidents` stage —
 * can link it first. Only incidents that never get an episode (lookback miss,
 * timed-out stage) pay this delay.
 */
export const EPISODE_INCIDENT_LINK_GRACE_MINUTES = 15;
```

`ClaimedIncidentRow` gains `suppressed_by_episode: boolean;`. `PublishIncidentsResult` gains `suppressed: number;`.

Replace the claim statement in `scanAndClaimIncidentRows` with:

```ts
  // Atomically claim live rows, bump dispatch_attempts, and decide one
  // dispatch per episode (spec §11 + W02 deviations D-1/D-2). A suppressed row
  // is marked dispatched here, in the claim, so it is never claimed again and
  // never published.
  const claimed = await db.execute<ClaimedIncidentRow>(sql`
    WITH due AS (
      SELECT id, episode_id, window_start
      FROM ${metricAnomalyIncidents}
      WHERE ${metricAnomalyIncidents.dispatchedAt} IS NULL
        AND ${metricAnomalyIncidents.dispatchAttempts} <= ${MAX_PUBLISH_ATTEMPTS}
        AND (
          episode_id IS NOT NULL
          OR created_at < now() - make_interval(mins => ${EPISODE_INCIDENT_LINK_GRACE_MINUTES}::int)
        )
      ORDER BY ${metricAnomalyIncidents.orgId}, ${metricAnomalyIncidents.id}
      LIMIT ${MAX_PUBLISH_PER_RUN}
      FOR UPDATE SKIP LOCKED
    ),
    decided AS (
      SELECT
        d.id,
        (
          d.episode_id IS NOT NULL
          AND (
            row_number() OVER (PARTITION BY d.episode_id ORDER BY d.window_start, d.id) > 1
            OR EXISTS (
              SELECT 1
              FROM metric_anomaly_incidents s
              WHERE s.episode_id = d.episode_id
                AND s.id <> d.id
                AND (
                  s.agent_run_id IS NOT NULL
                  OR (s.dispatched_at IS NOT NULL AND s.suppressed_by_episode = false)
                )
            )
          )
        ) AS suppress
      FROM due d
    )
    UPDATE ${metricAnomalyIncidents} AS i
    SET dispatch_attempts = i.dispatch_attempts + 1,
        dispatched_at = CASE WHEN decided.suppress THEN now() ELSE i.dispatched_at END,
        suppressed_by_episode = decided.suppress
    FROM decided
    WHERE i.id = decided.id
    RETURNING i.id, i.org_id, i.device_id, i.dispatch_attempts, i.suppressed_by_episode;
  `);
```

Rewrite the body of `publishPendingIncidents` after the claim:

```ts
  const { stuckRows, claimedRows } = await runWithSystemDbAccess(scanAndClaimIncidentRows);

  if (claimedRows.length === 0) {
    return { published: 0, skipped: stuckRows.length, suppressed: 0 };
  }

  const toPublish = claimedRows.filter((row) => !row.suppressed_by_episode);
  const suppressed = claimedRows.length - toPublish.length;
  if (toPublish.length === 0) {
    return { published: 0, skipped: stuckRows.length, suppressed };
  }

  const publishedIds = await runOutsideDbContext(() => publishClaimedRows(toPublish));

  if (publishedIds.length > 0) {
    await runWithSystemDbAccess(() => markIncidentRowsDispatched(publishedIds));
  }

  if (claimedRows.length === MAX_PUBLISH_PER_RUN) {
    console.warn(
      `[MetricAnomalyIncidentPublisher] Hit ${MAX_PUBLISH_PER_RUN}-item cap — backlog may be growing`,
    );
  }

  return { published: publishedIds.length, skipped: stuckRows.length, suppressed };
```

In `createWorker`, change the result handling to:

```ts
        const { published, skipped, suppressed } = await publishPendingIncidents();
        if (published > 0 || skipped > 0 || suppressed > 0) {
          console.log(
            `[MetricAnomalyIncidentPublisher] Published ${published} incident(s), ${suppressed} suppressed by episode, ${skipped} stuck`,
          );
        }
        return { published, skipped, suppressed };
```

Search for other callers: `rg -n "publishPendingIncidents" apps/api/src --glob '!*.test.ts'`. Any caller that destructures the result keeps working, because the change only adds a field.

- [ ] **Step 5: Run and watch them pass**

```bash
cd apps/api && npx vitest run src/jobs/metricAnomalyIncidentPublisher.test.ts
pnpm --filter @breeze/api test:integration src/__tests__/integration/metricAnomalyEpisodeIncidents.integration.test.ts src/__tests__/integration/metricAnomalySubscriberAdmission.integration.test.ts
```
Expected: PASS. The subscriber admission suite is unaffected.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/jobs/metricAnomalyIncidentPublisher.ts apps/api/src/jobs/metricAnomalyIncidentPublisher.test.ts apps/api/src/__tests__/integration/metricAnomalyEpisodeIncidents.integration.test.ts
git commit -m "feat(api): anomaly incident publisher dispatches once per episode (W02)"
```

---

### Task 10: HTTP-level proofs: evaluation labels, cross-org, `ref`

**Files:**
- Create: `apps/api/src/__tests__/integration/metricAnomalyEpisodeRoutes.integration.test.ts`

**Interfaces:**
- Consumes: `anomaliesRoutes` (Task 6), `analyticsRoutes` (`routes/analytics.ts:27`), `createIntegrationTestClient` (`__tests__/integration/db-utils.ts:560`, org-scope wildcard role), fixtures.

- [ ] **Step 1: Write the test**

```ts
import './setup';

import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { publishEventMock } = vi.hoisted(() => ({
  publishEventMock: vi.fn<(...args: unknown[]) => Promise<string>>(async () => 'test-event-id'),
}));
vi.mock('../../services/eventBus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/eventBus')>();
  return { ...actual, publishEvent: publishEventMock };
});

import { analyticsRoutes } from '../../routes/analytics';
import { anomaliesRoutes } from '../../routes/devices/anomalies';
import { createIntegrationTestClient } from './db-utils';
import { insertEpisodeDevice, seedEpisode, seedTenant } from './metricAnomalyEpisodeFixtures';

const HOUR = 3_600_000;

function buildApp(): Hono {
  const app = new Hono();
  app.route('/api/v1/devices', anomaliesRoutes);
  app.route('/api/v1/analytics', analyticsRoutes);
  return app;
}

async function feedbackTotals(client: Awaited<ReturnType<typeof createIntegrationTestClient>>) {
  const res = await client.get('/api/v1/analytics/anomalies/evaluation?range=7d');
  expect(res.status).toBe(200);
  return (await res.json()).feedback as { total: number; dismissed: number };
}

describe('anomaly episode routes over HTTP (W02)', () => {
  it('dismissing a 17-bucket episode moves /analytics/anomalies/evaluation feedback.total by 17', async () => {
    const client = await createIntegrationTestClient(buildApp());
    const orgId = client.env.organization.id;
    const deviceId = await insertEpisodeDevice(orgId, client.env.site.id);
    const ep = await seedEpisode({ orgId, deviceId, memberCount: 17, start: new Date(Date.now() - 2 * HOUR) });

    const before = await feedbackTotals(client);
    const res = await client.patch(`/api/v1/devices/${deviceId}/anomaly-episodes/${ep.episodeId}`, { action: 'dismiss' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toMatchObject({ id: ep.episodeId, status: 'dismissed', closeReason: 'user', snoozed: true, ongoing: false });
    expect(body.meta).toEqual({ alertId: null, alertResolved: false, labelledMembers: 17 });

    const after = await feedbackTotals(client);
    expect(after.total - before.total).toBe(17);
    expect(after.dismissed - before.dismissed).toBe(17);

    // A second dismiss is a 409, and labels do not double-count.
    const again = await client.patch(`/api/v1/devices/${deviceId}/anomaly-episodes/${ep.episodeId}`, { action: 'dismiss' });
    expect(again.status).toBe(409);
    expect((await again.json()).reason).toBe('episode_closed');
    expect((await feedbackTotals(client)).total).toBe(after.total);
  });

  it('ref=<member anomaly id> returns the containing episode first, even when closed', async () => {
    const client = await createIntegrationTestClient(buildApp());
    const orgId = client.env.organization.id;
    const deviceId = await insertEpisodeDevice(orgId, client.env.site.id);
    const closed = await seedEpisode({ orgId, deviceId, memberCount: 2, start: new Date(Date.now() - 30 * HOUR), status: 'resolved', closeReason: 'cleared', resolvedAt: new Date(Date.now() - 20 * HOUR) });
    await seedEpisode({ orgId, deviceId, memberCount: 1, start: new Date(Date.now() - HOUR), metricName: 'cpu_percent', metricFamily: 'cpu' });

    const res = await client.get(`/api/v1/devices/${deviceId}/anomaly-episodes?ref=${closed.memberIds[0]}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.focusedEpisodeId).toBe(closed.episodeId);
    expect(body.data[0].id).toBe(closed.episodeId);
    expect(body.data).toHaveLength(2);

    const detail = await client.get(`/api/v1/devices/${deviceId}/anomaly-episodes/${closed.episodeId}`);
    expect(detail.status).toBe(200);
    expect((await detail.json()).data.members).toHaveLength(2);
  });

  it('a device in another org is 404 for list, detail and PATCH — and nothing changes', async () => {
    const client = await createIntegrationTestClient(buildApp());
    const other = await seedTenant();
    const foreignDevice = await insertEpisodeDevice(other.org.id, other.site.id);
    const foreign = await seedEpisode({ orgId: other.org.id, deviceId: foreignDevice, memberCount: 2, start: new Date(Date.now() - HOUR) });

    expect((await client.get(`/api/v1/devices/${foreignDevice}/anomaly-episodes`)).status).toBe(404);
    expect((await client.get(`/api/v1/devices/${foreignDevice}/anomaly-episodes/${foreign.episodeId}`)).status).toBe(404);
    expect((await client.patch(`/api/v1/devices/${foreignDevice}/anomaly-episodes/${foreign.episodeId}`, { action: 'dismiss' })).status).toBe(404);

    // Own device, foreign episode id → the service's (org, device) scope makes it 404 too.
    const ownDevice = await insertEpisodeDevice(client.env.organization.id, client.env.site.id);
    expect((await client.patch(`/api/v1/devices/${ownDevice}/anomaly-episodes/${foreign.episodeId}`, { action: 'dismiss' })).status).toBe(404);
  });

  it('promote over HTTP returns the linked alert and keeps the episode open', async () => {
    const client = await createIntegrationTestClient(buildApp());
    const orgId = client.env.organization.id;
    const deviceId = await insertEpisodeDevice(orgId, client.env.site.id);
    const ep = await seedEpisode({ orgId, deviceId, memberCount: 3, start: new Date(Date.now() - HOUR) });

    const res = await client.patch(`/api/v1/devices/${deviceId}/anomaly-episodes/${ep.episodeId}`, { action: 'promote', note: 'escalating' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toMatchObject({ status: 'open', ongoing: true, promoted: true });
    expect(body.meta.alertId).toBe(body.data.linkedAlertId);
    expect(body.meta.labelledMembers).toBe(3);
  });
});
```

- [ ] **Step 2: Run it**

Run: `pnpm --filter @breeze/api test:integration src/__tests__/integration/metricAnomalyEpisodeRoutes.integration.test.ts`
Expected: PASS, because Tasks 2–6 already implemented the behaviour. This task adds end-to-end proof at the HTTP layer. It is not red-first, because no production code changes here. To confirm the assertions can fail, run this control: temporarily change `labelMembers` in `metricAnomalyEpisodeActions.ts` to `return 0` before the emit, rerun, and watch the first test fail on `after.total - before.total` (0 ≠ 17). Revert, rerun, and confirm green. Record the control in the PR body.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/__tests__/integration/metricAnomalyEpisodeRoutes.integration.test.ts
git commit -m "test(api): HTTP proofs for anomaly episodes — evaluation labels, cross-org 404, ref (W02)"
```

---

### Task 11: Verification, contract index, PR

**Files:**
- Modify: `docs/superpowers/plans/monitoring/2026-09-21-metric-anomaly-episodes.md` (contract table)

- [ ] **Step 1: Check the cross-wave contract table** in the index. The W02 rows (episode routes on `anomaliesRoutes`, the four DTOs incl. `peakAnomalyId`, `EPISODE_ACTIONS` / `EPISODE_LIST_STATUSES` / `EPISODE_DETAIL_MEMBER_LIMIT`, `applyEpisodeAction`, the read service, the feedback writers, the alert handler, `assembleEpisodesAndLinkIncidents`, the publisher constants, `PromoteMetricAnomalyToAlertOptions.episodeId`) were written into the index during plan reconciliation (2026-09-22). Compare each row with what this branch actually exports; if the code had to diverge, edit that row in this PR and say so in the PR body. W03 and W04 build against those rows.

- [ ] **Step 2: Typecheck**

```bash
cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p .; echo exit=$?
cd packages/shared && npx tsc --noEmit -p .; echo exit=$?
```
Expected: `exit=0` twice. Read the `exit=` line itself. Do not trust a quiet tail.

- [ ] **Step 3: Touched unit tests + static contracts**

```bash
cd apps/api && npx vitest run \
  src/services/metricAnomalyEpisodeQueries.test.ts \
  src/services/metricAnomalyEpisodeActions.test.ts \
  src/services/metricAnomalyEpisodeAlerts.test.ts \
  src/services/metricAnomalyEpisodeIncidents.test.ts \
  src/services/metricAnomalies.test.ts \
  src/services/metricAnomalyPromotion.test.ts \
  src/services/mlFeedback.test.ts \
  src/services/mlFeedbackEmitters.test.ts \
  src/jobs/metricAnomalies.test.ts \
  src/jobs/metricAnomalyIncidentPublisher.test.ts \
  src/routes/devices/anomalies.test.ts \
  src/routes/devices/anomalies.episodes.test.ts \
  src/__tests__/mcp-coverage.test.ts
cd packages/shared && npx vitest run src/types/metricAnomalyEpisodes.test.ts
pnpm --filter @breeze/api test:site-scope-coverage
pnpm --filter @breeze/api test:integration-suite-coverage
```
Expected: all green. Check that the reported file count equals the number of files listed (13 for the first command).

- [ ] **Step 4: Integration suites for the touched areas**

```bash
pnpm test-stack up
pnpm --filter @breeze/api test:integration \
  src/__tests__/integration/metricAnomalyEpisodeQueries.integration.test.ts \
  src/__tests__/integration/metricAnomalyEpisodeActions.integration.test.ts \
  src/__tests__/integration/metricAnomalyEpisodeAlerts.integration.test.ts \
  src/__tests__/integration/metricAnomalyEpisodeIncidents.integration.test.ts \
  src/__tests__/integration/metricAnomalyEpisodeRoutes.integration.test.ts \
  src/__tests__/integration/metricAnomalies.integration.test.ts \
  src/__tests__/integration/metricAnomalySubscriberAdmission.integration.test.ts
pnpm test-stack down
```
Expected: 7 files, all green. W02 adds no table or column, so the tenancy contract suites (`rls-coverage`, `tenantCascade`, export policy) are not re-run here. They belong to W01, and CI runs them regardless.

- [ ] **Step 5: Commit the index update and open the PR**

```bash
git add docs/superpowers/plans/monitoring/2026-09-21-metric-anomaly-episodes.md
git commit -m "docs(plans): metric anomaly episodes — W02 contract rows (only if Step 1 changed any)"
git push -u origin HEAD
gh pr create --title "feat(api): metric anomaly episodes W02 — routes, actions, alert auto-resolve, dispatch per episode" --body-file <body.md>
```

PR body (`body.md`) must contain:
- `Closes #<W02 sub-issue#>`, and a link to the spec and to this plan.
- **Spec deviations D-1…D-9** from the top of this plan, one line each with the file:line evidence.
- **No schema change.** No migration, no new table or column, no cascade or export-policy change (all W01).
- **`alerts.episode_id` untouched.** The anomaly episode id lives only in `alerts.context.episodeId`, because the column is the monitor breach episode (#5290).
- **Label integrity.** The member feedback writer throws inside the request transaction, so an action whose labels cannot be written returns 500 and rolls back. The Task 10 negative control run is recorded.
- **Dispatch behaviour change for the AI pilot.** At most one `anomaly.incident_opened` per episode. Unlinked incidents wait up to 15 min. The counter reads `suppressed` in the publisher log.
- **Still W03's job.** The `anomaly_episode` feedback source type, and excluding `cleared` from the evaluation rates. Until W03, `cleared` members show only in the evaluation's raw status bucket.
- **Still W04's job.** The panel rewrite and the `alertMlContext` deep link to `#anomalies/<episodeId>`.
- **Dismiss leaves a linked alert alone** (spec silent). Flagged for the owner.
- Review round: one independent review (Sonnet). The PR touches alert state and the AI dispatch path, but no tenancy or schema.

Then `complete_wave` only after the PR merges (feature-lifecycle).

---

## Self-review

**Spec coverage.**
- §8.1 actions and preconditions: Tasks 5 and 6.
- §8.2 cascade `WHERE status='open'`: the Task 5 `cascadeOpenMembers` step, plus its integration test.
- §8.3 per-member feedback with `dedupeKey`/`metadata.episodeId`, and none for automatic closes: Tasks 3 and 5. Task 7 writes no feedback, and Task 10 proves the +17.
- §8.4 `cleared` in legacy enums: W01's, with a guarded fallback in Task 6 Step 3b.
- §7 alert half: Task 7.
- §11 link and publisher gate: Tasks 8 and 9, where the link lives in the W02 wrapper inside W01's stage transaction.
- §12 list/detail/ref/serialization/`context.episodeId`: Tasks 1, 2, 4 and 6.
- §15 promote `disabled`/`not_found` → 409/404: Tasks 5 and 6.
- §16's W02 tests: all present. That covers the 17-member dismiss and the evaluation +17, promote giving `context.episodeId` with the episode open and members promoted, resolve with a default alert resolve, auto-close resolving the alert, publisher 3→1+2, `ref` by anomaly id, cross-org 404, and 409 on a closed episode.

**Placeholder scan.** The branch name and issue numbers are angle-bracketed tokens that `register_feature`/`start_wave` supply at execution time. Task 7 Step 1 names W01's invoker generically because W01 chooses it. The step says exactly what to check and what shape to produce. No TBD/TODO.

**Type consistency.** These names match across Tasks 1–11: `ApplyEpisodeActionResult.labelledMemberIds`, the route's `meta.labelledMembers` (a count), `EpisodeActionConflict`, `EPISODE_ACTION_CONFLICT_MESSAGES`, `serializeMetricAnomalyEpisode(row, range, now)`, `PublishIncidentsResult.suppressed`, `ClaimedIncidentRow.suppressed_by_episode`, `assembleEpisodesAndLinkIncidents(range)` and `resolveAlertsForAutoClosedEpisodes(orgId, now?)`.
