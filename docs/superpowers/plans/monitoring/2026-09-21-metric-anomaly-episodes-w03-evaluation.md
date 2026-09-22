# Metric Anomaly Episodes — W03 Evaluation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `ml_feedback_events` an `anomaly_episode` source type, emit one episode-level feedback
row per human resolve/dismiss, add an `episodes` block to `/analytics/anomalies/evaluation`, exclude
the new `cleared` member status from human-label rate denominators while still surfacing it as its
own count, and document all of it in the ML operations runbook.

**Architecture:** One additive migration (CHECK constraint only, no data written), one additive
shared-validator change, one new feedback emitter (throwing, inside the action transaction — W02's
D-7 rule) wired into W02's episode action service, and additive-only changes to the existing evaluation route and its response shape. No new
tables, no new routes, no RLS shape change (the touched tables already have RLS).

**Tech Stack:** Hono route (`apps/api/src/routes/analytics.ts`), Drizzle (raw `sql` templates for
aggregates), Zod (`packages/shared/src/validators/mlFeedback.ts`), Vitest (unit — Test API / Test
Web; integration — `vitest.integration.config.ts`).

**Spec:** `docs/superpowers/specs/monitoring/2026-09-21-metric-anomaly-episodes-design.md` (§8.3
feedback events, §16 testing, §17 wave split — this is W03, §18 risks — "cleared misread as a human
verdict").
**Index / cross-wave interface contract:**
`docs/superpowers/plans/monitoring/2026-09-21-metric-anomaly-episodes.md`.

## Spec deviations (follow the code, not the prose)

1. **Episode-level event types are new, not reused.** §8.3 says the per-episode feedback row gets
   `sourceType: 'anomaly_episode'` but does not name its `eventType`. Every other `sourceType` in
   `ML_FEEDBACK_EVENT_TYPES` (`packages/shared/src/validators/mlFeedback.ts`) owns a private
   `<source>.<verb>` namespace (`alert.*`, `correlation.*`, `ticket.*`, `anomaly.*`, `rca.*`,
   `suggestion.*`, `device.*`, `user_risk.*`) — reusing `anomaly.dismissed` for a row whose
   `sourceType` is `anomaly_episode` would break that 1:1 convention and make a future
   `GROUP BY eventType` across source types ambiguous. This plan adds `anomaly_episode.dismissed` and
   `anomaly_episode.resolved` (only those two — per D6/§8.1 `promote` and `unsnooze` never close the
   episode, so they never emit an episode-level row). `ML_FEEDBACK_OUTCOMES` already has `dismissed`
   and `resolved`; no new outcome values needed.
2. **"Episodes block" fields are defined here, not in the spec.** §8.3/§16/§18 name the requirement
   ("episode-level block", "median duration", "recurrence share", "human-labelled share") but not
   the exact shape. Defined below (Task 5) as: `total`, `byStatus` (open/resolved/dismissed, the
   three values of the `status` CHECK, §4.1), `byCloseReason` (the five `close_reason` CHECK values),
   `medianDurationSeconds` (median `resolved_at − first_seen_at` over closed episodes, seconds,
   `null` when no episode has closed in-window), `recurrenceShare` (episodes with
   `recurrence_count >= 1` ÷ all episodes in-window), `humanLabelledShare` (episodes with
   `close_reason = 'user'` ÷ **closed** episodes in-window — `cleared`/`expired_*`/`snoozed` closes
   are automatic, not a human label; an open, merely-promoted episode is neither closed nor a
   dismiss/resolve label, so it counts in neither numerator nor denominator here).
3. **Route file line numbers.** The task description cited `apps/api/src/routes/analytics.ts:1150-1300`;
   the evaluation handler in the current tree is `analytics.ts:1090-1334` (route registration at
   1090, handler body 1095-1333). Tasks below cite the current, verified line numbers.
4. **Episode-level row is written like the member rows, and counted apart from them.** §8.3 is
   silent on write semantics. The row is written by W02's throwing `emitMlFeedbackEvents` inside the
   episode action's transaction (W02 deviation D-7), not best-effort — a lost label rolls the action
   back. It is not added to W02's `feedbackInserted` and not to the evaluation's `feedback` block
   (which counts `sourceType = 'anomaly'` only), so `feedback.total` still moves by the member count.

## Global Constraints

- Migration must sort after the newest file on `origin/main` (`git ls-tree --name-only origin/main
  apps/api/migrations/ | sort | tail -1`) — verified at doc-write time (2026-09-22) as
  `2026-10-26-170300-caller-verification-ticket-comment-rls.sql`; `2026-10-27-110000-…` (this plan's
  placeholder, matching the spec §14/§17 W03 slot) sorts after it and after W01's placeholder
  `2026-10-27-100000-metric-anomaly-episodes.sql`. **Re-verify against `origin/main` at execution
  time** (`git fetch origin main && git ls-tree --name-only origin/main apps/api/migrations/ | grep
  '\.sql$' | sort | tail -1`): W01 may have been renamed past its placeholder and other work lands
  daily — rename this file to sort after whatever is newest then, per `CLAUDE.md` → Schema Migration
  Workflow. The pre-push guard (`check-migration-naming.sh --against-ref origin/main`) re-checks.
- Migration is idempotent (`DROP CONSTRAINT IF EXISTS` then re-`ADD CONSTRAINT`), has no inner
  `BEGIN`/`COMMIT`, and writes no rows (no `set_config('breeze.scope', 'system')` needed — do not
  touch `migrationRlsScope.test.ts`'s frozen baseline).
- Every route-response change is **additive only**: new top-level `episodes` key, new `status.cleared`
  key. No existing field is renamed, removed, or reinterpreted. `AnomalyEvaluationResponse` is not
  mirrored anywhere outside `apps/api/src/routes/analytics.ts` (verified: no such type in
  `apps/web/src/lib/api/contracts.ts` or `packages/shared/src/validators/contracts.ts` — grepped, zero
  hits), so there is no second contract file to update.
- This wave depends on W01 (the `cleared` member status on `metric_anomalies.status`, `METRIC_ANOMALY_STATUSES`,
  the `metric_anomaly_episodes` table) and W02 (`services/metricAnomalyEpisodeActions.ts` —
  `applyEpisodeAction`, the `EpisodeAction` type, `emitMlFeedbackEvents`, the integration fixtures in
  `__tests__/integration/metricAnomalyEpisodeFixtures.ts`) being merged to `main` first, per the index's dependency table. Branch from `main` after W02 merges,
  not from this worktree's current `spec/metric-anomaly-episodes` HEAD.
- Rigor: this wave is additive CRUD/analytics plumbing (no new tenancy shape, no new table, one CHECK
  constraint) — implement, typecheck, run the affected unit + integration tests per
  `CLAUDE.md` → "Skill rigor calibration"; one independent review round, no brainstorming/full-plan
  ceremony beyond this document.

---

## Cross-wave names this plan adds

(Already in the index's interface contract table since plan reconciliation — verify them in this wave's PR.)

| Name | Where | Shape |
|---|---|---|
| `emitAnomalyEpisodeFeedback` | `apps/api/src/services/mlFeedbackEmitters.ts` | `(options: { orgId: string; episodeId: string; eventType: 'anomaly_episode.dismissed' \| 'anomaly_episode.resolved'; outcome: 'dismissed' \| 'resolved'; actorUserId?: string \| null; occurredAt: Date; metadata?: Record<string, unknown> }) => Promise<number>` — throwing writer (W02 `emitMlFeedbackEvents`), called inside W02's `resolveEpisode`/`dismissEpisode` transaction |
| `'anomaly_episode.dismissed'`, `'anomaly_episode.resolved'` | `ML_FEEDBACK_EVENT_TYPES` (same file) | the only two episode-level event types |
| `'anomaly_episode'` | `ML_FEEDBACK_SOURCE_TYPES` (`packages/shared/src/validators/mlFeedback.ts`) | new source type |

---

### Task 1: Migration — add `anomaly_episode` to the feedback source-type CHECK

**Files:**
- Create: `apps/api/migrations/2026-10-27-110000-ml-feedback-anomaly-episode-source.sql`
- Test: none new (covered by `apps/api/src/db/autoMigrate.test.ts`, existing, auto-discovers new
  migration files)

**Interfaces:**
- Consumes: `ml_feedback_events_source_type_check` as currently shipped in
  `apps/api/migrations/2026-06-18-ml-feedback-events.sql:17-19` — `CHECK (source_type IN ('alert',
  'ticket', 'device', 'anomaly', 'correlation', 'rca', 'remediation', 'user_risk'))`. Verified this is
  still the live value list: `grep -rl "ml_feedback_events_source_type_check"
  apps/api/migrations/` returns only that one file — nothing has re-created it since.
- Produces: the CHECK now also allows `'anomaly_episode'`, consumed by Task 3/4's emitter.

- [ ] **Step 1: Confirm the migration name still sorts last**

Run:
```bash
git fetch origin main --quiet
git ls-tree --name-only origin/main apps/api/migrations/ | sort | tail -3
```
Expected: `2026-10-27-110000-ml-feedback-anomaly-episode-source.sql` sorts after every listed name. If
W01/W02 have landed migrations dated later, rename this file's prefix to sort after the new newest
entry before continuing (same rule, `CLAUDE.md` → Schema Migration Workflow).

- [ ] **Step 2: Write the migration**

```sql
-- Allow ml_feedback_events to carry an episode-level label row, distinct from the
-- existing per-bucket 'anomaly' source type. See W03 of
-- docs/superpowers/plans/monitoring/2026-09-21-metric-anomaly-episodes.md.
-- No row writes in this file, so no set_config('breeze.scope', 'system') elevation
-- is needed (CLAUDE.md "Any migration that writes rows must elect system scope FIRST"
-- applies only to UPDATE/DELETE/INSERT/MERGE, none of which occur here).

ALTER TABLE ml_feedback_events
  DROP CONSTRAINT IF EXISTS ml_feedback_events_source_type_check;

ALTER TABLE ml_feedback_events
  ADD CONSTRAINT ml_feedback_events_source_type_check
  CHECK (source_type IN (
    'alert', 'ticket', 'device', 'anomaly', 'anomaly_episode', 'correlation', 'rca',
    'remediation', 'user_risk'
  ));
```

- [ ] **Step 3: Apply it twice against a local stack and confirm idempotency**

```bash
pnpm test-stack up
export DATABASE_URL="$(grep -m1 '^DATABASE_URL=' apps/api/.env.test 2>/dev/null || echo postgresql://breeze:breeze@localhost:5432/breeze)"
pnpm --filter @breeze/api db:migrate
pnpm --filter @breeze/api db:migrate
```
Expected: both runs exit 0; the second run logs the file as already applied (no error, no duplicate
constraint error). Leave the stack up for Task 6/7's integration run, or tear down now with
`pnpm test-stack down` and bring it back up later — either is fine.

- [ ] **Step 4: Run drift check and the migration-ordering unit test**

```bash
cd apps/api && npx vitest run src/db/autoMigrate.test.ts
cd /Users/toddhebebrand/.herdr/worktrees/breeze/anomalies-work && pnpm db:check-drift
```
Expected: both pass (drift-check passes trivially — this migration touches no Drizzle-mapped column,
only a CHECK constraint not represented in the schema file).

- [ ] **Step 5: Commit**

```bash
git add apps/api/migrations/2026-10-27-110000-ml-feedback-anomaly-episode-source.sql
git commit -m "$(cat <<'EOF'
feat(ml-feedback): allow anomaly_episode source type

W03 of the metric anomaly episodes feature needs one feedback row per
human resolve/dismiss on an episode, distinct from the existing
per-bucket 'anomaly' rows. Idempotent CHECK re-creation, no data writes.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Shared validator — `anomaly_episode` source type + event types

**Files:**
- Modify: `packages/shared/src/validators/mlFeedback.ts:5-13` (`ML_FEEDBACK_SOURCE_TYPES`),
  `:15-49` (`ML_FEEDBACK_EVENT_TYPES`)
- Test: `packages/shared/src/validators/mlFeedback.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `ML_FEEDBACK_SOURCE_TYPES` includes `'anomaly_episode'`; `ML_FEEDBACK_EVENT_TYPES`
  includes `'anomaly_episode.dismissed'` and `'anomaly_episode.resolved'`; `mlFeedbackEventSchema`
  accepts both. Consumed by Task 3's emitter and Task 1's migration (which must allow the same string
  at the DB layer — already done).

- [ ] **Step 1: Write the failing tests**

Append to `packages/shared/src/validators/mlFeedback.test.ts` (inside the existing
`describe('mlFeedbackEventSchema', ...)` block, following the pattern of the existing "accepts
anomaly lifecycle feedback events" test at line ~38):

```ts
  it('accepts anomaly_episode dismissed feedback events', () => {
    const parsed = mlFeedbackEventSchema.parse({
      ...validEvent,
      sourceType: 'anomaly_episode',
      sourceId: '00000000-0000-4000-8000-000000000099',
      eventType: 'anomaly_episode.dismissed',
      outcome: 'dismissed',
      dedupeKey: 'episode:00000000-0000-4000-8000-000000000099',
    });
    expect(parsed.sourceType).toBe('anomaly_episode');
    expect(parsed.eventType).toBe('anomaly_episode.dismissed');
  });

  it('accepts anomaly_episode resolved feedback events', () => {
    const parsed = mlFeedbackEventSchema.parse({
      ...validEvent,
      sourceType: 'anomaly_episode',
      sourceId: '00000000-0000-4000-8000-000000000099',
      eventType: 'anomaly_episode.resolved',
      outcome: 'resolved',
      dedupeKey: 'episode:00000000-0000-4000-8000-000000000099',
    });
    expect(parsed.outcome).toBe('resolved');
  });

  it('rejects anomaly_episode.promoted (episodes never emit a promote-level feedback row)', () => {
    expect(() =>
      mlFeedbackEventSchema.parse({
        ...validEvent,
        sourceType: 'anomaly_episode',
        eventType: 'anomaly_episode.promoted',
        outcome: 'promoted',
      }),
    ).toThrow();
  });
```

- [ ] **Step 2: Run the tests and verify they fail**

```bash
cd packages/shared && npx vitest run src/validators/mlFeedback.test.ts
```
Expected: FAIL — `'anomaly_episode'` / `'anomaly_episode.dismissed'` / `'anomaly_episode.resolved'`
are not in the enum, so `.parse()` throws `ZodError` on the first two (assertion failure), and the
third test passes vacuously (already throws) — note that in the diff so the reviewer isn't confused
by one green test in a red step.

- [ ] **Step 3: Add the enum values**

In `packages/shared/src/validators/mlFeedback.ts`, `ML_FEEDBACK_SOURCE_TYPES`:

```ts
export const ML_FEEDBACK_SOURCE_TYPES = [
  'alert',
  'ticket',
  'device',
  'anomaly',
  'anomaly_episode',
  'correlation',
  'rca',
  'remediation',
  'user_risk',
] as const;
```

In `ML_FEEDBACK_EVENT_TYPES`, immediately after the existing `'anomaly.resolved',` line:

```ts
  'anomaly.dismissed',
  'anomaly.promoted',
  'anomaly.resolved',
  'anomaly_episode.dismissed',
  'anomaly_episode.resolved',
```

- [ ] **Step 4: Run the tests and verify they pass**

```bash
cd packages/shared && npx vitest run src/validators/mlFeedback.test.ts
```
Expected: PASS, all three new tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/validators/mlFeedback.ts packages/shared/src/validators/mlFeedback.test.ts
git commit -m "$(cat <<'EOF'
feat(shared): add anomaly_episode feedback source and event types

Matches the ml_feedback_events_source_type_check CHECK constraint added
in the companion migration. Only dismissed/resolved — promote and
unsnooze never close an episode, so they never emit an episode-level
feedback row.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `emitAnomalyEpisodeFeedback` emitter

**Files:**
- Modify: `apps/api/src/services/mlFeedbackEmitters.ts` (append after W02's
  `emitAnomalyEpisodeMemberFeedback`)
- Test: `apps/api/src/services/mlFeedbackEmitters.test.ts`

**Interfaces:**
- Consumes: W02's `emitMlFeedbackEvents(inputs, database?) → Promise<{ inserted: number }>`
  (`services/mlFeedback.ts` — the **throwing** batch writer; W02 already imports it into
  `mlFeedbackEmitters.ts` and already mocks it in `mlFeedbackEmitters.test.ts`), `actorUserIdOrNull`
  (private helper, same file).
- Produces: `emitAnomalyEpisodeFeedback(options) → Promise<number>` (rows inserted, 0 on a dedupe
  replay) — used by Task 4.

**Write semantics follow W02's D-7, not the best-effort emitters.** The episode-level row is a
human label exactly like the per-member rows W02 writes beside it, and it is written from the same
place (W02's `applyEpisodeAction`, inside the request transaction). So it uses the same throwing
writer: if the row cannot be written the whole action rolls back with a 500, never a silently
missing label. It does **not** use `emitFeedbackBestEffort`.

- [ ] **Step 1: Write the failing test**

Add to `apps/api/src/services/mlFeedbackEmitters.test.ts` (add `emitAnomalyEpisodeFeedback` to
the existing import from `./mlFeedbackEmitters`; `emitMlFeedbackEvents` is the hoisted mock W02
added next to `emitMlFeedbackEvent`):

```ts
describe('emitAnomalyEpisodeFeedback (W03)', () => {
  const EPISODE = '99999999-9999-4999-8999-999999999999';
  const lastBatch = () => emitMlFeedbackEvents.mock.calls.at(-1)![0] as Array<Record<string, any>>;

  beforeEach(() => {
    emitMlFeedbackEvents.mockReset();
    emitMlFeedbackEvents.mockResolvedValue({ inserted: 1 });
  });

  it('writes one anomaly_episode row keyed by the episode, with the episode dedupeKey', async () => {
    const inserted = await emitAnomalyEpisodeFeedback({
      orgId: 'org-1',
      episodeId: EPISODE,
      eventType: 'anomaly_episode.dismissed',
      outcome: 'dismissed',
      actorUserId: VALID_UUID,
      occurredAt: new Date('2026-09-22T00:00:00.000Z'),
      metadata: { memberCount: 17 },
    });

    expect(inserted).toBe(1);
    expect(lastBatch()).toHaveLength(1);
    expect(lastBatch()[0]).toMatchObject({
      orgId: 'org-1',
      sourceType: 'anomaly_episode',
      sourceId: EPISODE,
      eventType: 'anomaly_episode.dismissed',
      dedupeKey: `episode:${EPISODE}`,
      outcome: 'dismissed',
      actorUserId: VALID_UUID,
      metadata: { memberCount: 17, episodeId: EPISODE },
    });
  });

  it('normalizes a non-uuid actor to null', async () => {
    await emitAnomalyEpisodeFeedback({
      orgId: 'org-1', episodeId: EPISODE, eventType: 'anomaly_episode.resolved', outcome: 'resolved',
      actorUserId: 'system', occurredAt: new Date(),
    });
    expect(lastBatch()[0]!.actorUserId).toBeNull();
  });

  it('propagates a write failure (W02 D-7: labels are never best-effort)', async () => {
    emitMlFeedbackEvents.mockRejectedValue(new Error('db down'));
    await expect(emitAnomalyEpisodeFeedback({
      orgId: 'org-1', episodeId: EPISODE, eventType: 'anomaly_episode.resolved', outcome: 'resolved',
      occurredAt: new Date(),
    })).rejects.toThrow('db down');
  });
});
```

- [ ] **Step 2: Run and verify it fails**

```bash
cd apps/api && npx vitest run src/services/mlFeedbackEmitters.test.ts
```
Expected: FAIL — `emitAnomalyEpisodeFeedback` is not exported.

- [ ] **Step 3: Implement**

Append to `apps/api/src/services/mlFeedbackEmitters.ts`, after `emitAnomalyEpisodeMemberFeedback`:

```ts
/**
 * W03 (spec §8.3): the ONE episode-level label row per human resolve/dismiss,
 * beside W02's per-member `anomaly` rows. Same write rule as those (W02 D-7):
 * throwing writer, called inside the episode action's request transaction, so
 * a lost label rolls the action back. Only resolve/dismiss emit it — promote
 * and unsnooze never close an episode.
 */
export async function emitAnomalyEpisodeFeedback(options: {
  orgId: string;
  episodeId: string;
  eventType: 'anomaly_episode.dismissed' | 'anomaly_episode.resolved';
  outcome: 'dismissed' | 'resolved';
  actorUserId?: string | null;
  occurredAt: Date;
  metadata?: Record<string, unknown>;
}): Promise<number> {
  const { inserted } = await emitMlFeedbackEvents([{
    orgId: options.orgId,
    sourceType: 'anomaly_episode' as const,
    sourceId: options.episodeId,
    eventType: options.eventType,
    dedupeKey: `episode:${options.episodeId}`,
    outcome: options.outcome,
    actorUserId: actorUserIdOrNull(options.actorUserId),
    metadata: { ...(options.metadata ?? {}), episodeId: options.episodeId },
    occurredAt: options.occurredAt,
  }]);
  return inserted;
}
```

- [ ] **Step 4: Run and verify it passes**

```bash
cd apps/api && npx vitest run src/services/mlFeedbackEmitters.test.ts
```
Expected: PASS (W02's suites in this file included).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/mlFeedbackEmitters.ts apps/api/src/services/mlFeedbackEmitters.test.ts
git commit -m "$(cat <<'MSG'
feat(ml-feedback): add emitAnomalyEpisodeFeedback emitter

One episode-level ml_feedback_events row per human resolve/dismiss,
dedupeKey episode:<id> like W02's per-member rows. Throwing writer, same
rule as the member rows (W02 D-7): a lost label rolls the action back.
MSG
)"
```

---

### Task 4: Wire the emitter into `applyEpisodeAction`

**Files:**
- Modify: `apps/api/src/services/metricAnomalyEpisodeActions.ts` (W02 — `resolveEpisode` and
  `dismissEpisode`; branch from `main` after W02 merges)
- Modify: `apps/api/src/services/metricAnomalyEpisodeActions.test.ts` (W02's unit file — mock
  export only)
- Test: `apps/api/src/__tests__/integration/metricAnomalyEpisodeActions.integration.test.ts` (W02's
  integration file — append a `describe`)

**Interfaces:**
- Consumes (W02, exact names): `applyEpisodeAction(input: ApplyEpisodeActionInput):
  Promise<ApplyEpisodeActionResult>` where `ApplyEpisodeActionInput = { orgId; deviceId; episodeId;
  action; note?; resolveAlert?; actorUserId: string; now? }`; its private helpers
  `resolveEpisode(episode, input, now)` / `dismissEpisode(episode, input, now)`, each of which
  computes `members` (the rows `cascadeOpenMembers` moved) and `feedbackInserted` via
  `labelMembers(...)`, all on the ambient request transaction after `lockEpisode`'s `FOR UPDATE`.
  W02 integration fixtures `seedTenant`, `insertEpisodeDevice`, `seedEpisode` and that file's local
  `act(...)` / `episodeFeedback(...)` helpers. `emitAnomalyEpisodeFeedback` (Task 3).
- Produces: nothing new for later tasks.

Per spec §8.1/§8.3: `resolve` and `dismiss` are the only actions that close an episode (`promote`
keeps it open per D6; `unsnooze` only clears `snoozed_until`). W02 already writes one `anomaly` row
per cascaded member for them; this task adds exactly one `anomaly_episode` row **in the same
transaction**, right after `labelMembers`. `ApplyEpisodeActionResult.feedbackInserted` keeps W02's
meaning (member rows only) so W02's assertions (`feedbackInserted: 17`, `labelledMembers`) are
unchanged; the evaluation endpoint's `feedback` block counts `sourceType = 'anomaly'` only
(`routes/analytics.ts:1192`), so its `feedback.total` still moves by the member count.

- [ ] **Step 1: Write the failing integration test**

Append to `apps/api/src/__tests__/integration/metricAnomalyEpisodeActions.integration.test.ts`:

```ts
describe('episode-level feedback row (W03, spec §8.3)', () => {
  async function episodeLevelFeedback(episodeId: string) {
    return getTestDb().select().from(mlFeedbackEvents).where(and(
      eq(mlFeedbackEvents.sourceType, 'anomaly_episode'),
      eq(mlFeedbackEvents.sourceId, episodeId),
    ));
  }

  it.each([
    ['dismiss', 'anomaly_episode.dismissed', 'dismissed'],
    ['resolve', 'anomaly_episode.resolved', 'resolved'],
  ] as const)('%s writes exactly one %s row beside the per-member rows', async (action, eventType, outcome) => {
    const { org, site, user } = await seedTenant();
    const deviceId = await insertEpisodeDevice(org.id, site.id);
    const ep = await seedEpisode({ orgId: org.id, deviceId, memberCount: 3, start: new Date(Date.now() - 2 * HOUR) });

    const result = await act({ orgId: org.id, deviceId, episodeId: ep.episodeId, action, actorUserId: user.id });

    expect(result).toMatchObject({ status: 'ok', feedbackInserted: 3 });
    const rows = await episodeLevelFeedback(ep.episodeId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ eventType, outcome, actorUserId: user.id, dedupeKey: `episode:${ep.episodeId}` });
    expect((rows[0]!.metadata as Record<string, unknown>).memberCount).toBe(3);
    expect(await episodeFeedback(ep.episodeId)).toHaveLength(3); // per-member `anomaly` rows unchanged
  });

  it('promote and unsnooze write no episode-level row', async () => {
    const { org, site, user } = await seedTenant();
    const deviceId = await insertEpisodeDevice(org.id, site.id);
    const open = await seedEpisode({ orgId: org.id, deviceId, memberCount: 2, start: new Date(Date.now() - HOUR) });
    const snoozed = await seedEpisode({
      orgId: org.id, deviceId, memberCount: 1, start: new Date(Date.now() - 6 * HOUR), status: 'dismissed',
      closeReason: 'user', snoozedUntil: new Date(Date.now() + DAY), memberStatus: 'dismissed',
      metricName: 'cpu_percent', metricFamily: 'cpu',
    });

    await act({ orgId: org.id, deviceId, episodeId: open.episodeId, action: 'promote', actorUserId: user.id });
    await act({ orgId: org.id, deviceId, episodeId: snoozed.episodeId, action: 'unsnooze', actorUserId: user.id });

    expect(await episodeLevelFeedback(open.episodeId)).toHaveLength(0);
    expect(await episodeLevelFeedback(snoozed.episodeId)).toHaveLength(0);
  });
});
```

(`and`, `eq`, `mlFeedbackEvents`, `getTestDb`, `HOUR`, `DAY`, `act`, `episodeFeedback` and the
fixtures are already imported/defined at the top of W02's file.)

- [ ] **Step 2: Run and verify it fails**

```bash
pnpm test-stack up
pnpm --filter @breeze/api test:integration src/__tests__/integration/metricAnomalyEpisodeActions.integration.test.ts
```
Expected: FAIL — `episodeLevelFeedback` returns `[]` for dismiss/resolve (expected length 1). The
promote/unsnooze case passes already; note that in the PR so the reviewer is not surprised by one
green test in a red step.

- [ ] **Step 3: Implement**

In `apps/api/src/services/metricAnomalyEpisodeActions.ts`, change the emitter import to
`import { emitAlertStateFeedback, emitAnomalyEpisodeFeedback, emitAnomalyEpisodeMemberFeedback } from './mlFeedbackEmitters';`.

In `resolveEpisode`, directly after
`const feedbackInserted = await labelMembers(episode, 'resolved', members, input, now);`:

```ts
  // W03 (spec §8.3): one episode-level label, same transaction, same throwing
  // writer as the member rows (W02 D-7).
  await emitAnomalyEpisodeFeedback({
    orgId: episode.orgId,
    episodeId: episode.id,
    eventType: 'anomaly_episode.resolved',
    outcome: 'resolved',
    actorUserId: input.actorUserId,
    occurredAt: now,
    metadata: { route: 'devices.anomalyEpisodes.action', note: input.note, memberCount: members.length },
  });
```

In `dismissEpisode`, directly after
`const feedbackInserted = await labelMembers(episode, 'dismissed', members, input, now);`:

```ts
  await emitAnomalyEpisodeFeedback({
    orgId: episode.orgId,
    episodeId: episode.id,
    eventType: 'anomaly_episode.dismissed',
    outcome: 'dismissed',
    actorUserId: input.actorUserId,
    occurredAt: now,
    metadata: { route: 'devices.anomalyEpisodes.action', note: input.note, memberCount: members.length },
  });
```

`promoteEpisode` and `unsnoozeEpisode` get no call. Do not add the new row to `feedbackInserted`.

In `apps/api/src/services/metricAnomalyEpisodeActions.test.ts`, extend W02's emitter mock so the
module still resolves every export:

```ts
vi.mock('./mlFeedbackEmitters', () => ({
  emitAlertStateFeedback: vi.fn(),
  emitAnomalyEpisodeMemberFeedback: vi.fn(),
  emitAnomalyEpisodeFeedback: vi.fn(),
}));
```

- [ ] **Step 4: Run and verify it passes**

```bash
cd apps/api && npx vitest run src/services/metricAnomalyEpisodeActions.test.ts
pnpm --filter @breeze/api test:integration src/__tests__/integration/metricAnomalyEpisodeActions.integration.test.ts src/__tests__/integration/metricAnomalyEpisodeRoutes.integration.test.ts
```
Expected: PASS, including every W02 test in both files (member counts, `feedback.total` +17 in
`metricAnomalyEpisodeRoutes`, which counts `anomaly` rows only).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/metricAnomalyEpisodeActions.ts apps/api/src/services/metricAnomalyEpisodeActions.test.ts apps/api/src/__tests__/integration/metricAnomalyEpisodeActions.integration.test.ts
git commit -m "$(cat <<'MSG'
feat(anomaly-episodes): emit episode-level feedback on resolve/dismiss

One anomaly_episode.{resolved,dismissed} row per human episode action,
inside the action transaction beside the per-member anomaly.* rows.
Promote and unsnooze emit none.
MSG
)"
```

---

### Task 5: Evaluation endpoint — `cleared` exclusion + `episodes` block

**Files:**
- Modify: `apps/api/src/routes/analytics.ts:291-296` (query schema — no change needed, confirms
  scope), `:310-355` (`zeroAnomalyEvaluationResponse`/`zeroV1ShadowEvaluation`), `:1090-1334`
  (the evaluation handler)
- Test: `apps/api/src/routes/analytics.test.ts:504-636` (main describe block),
  `apps/api/src/routes/analytics.test.ts:1101-1156` (site-scope describe block)

**Interfaces:**
- Consumes: `metricAnomalyEpisodes` Drizzle table (W01, `apps/api/src/db/schema/metricAnomalyEpisodes.ts`,
  columns per spec §4.1: `orgId`, `deviceId`, `status`, `closeReason`, `firstSeenAt`, `resolvedAt`,
  `recurrenceCount`), `and`, `eq`, `gte`, `inArray`, `sql` (already imported in this file).
- Produces: response shape below — additive only.

- [ ] **Step 1: Write the failing unit tests**

First, in `apps/api/src/routes/analytics.test.ts`, add `metricAnomalyEpisodes`-shaped mock rows and
update the existing evaluation tests. Replace the body of the first test (lines 505-531) with:

```ts
    it('returns anomaly status rates and lifecycle feedback counts', async () => {
      mockSelectOnce([
        { status: 'open', count: 4 },
        { status: 'dismissed', count: 3 },
        { status: 'promoted', count: 2 },
        { status: 'resolved', count: 1 },
        { status: 'cleared', count: 5 },
      ]);
      mockSelectOnce([
        { eventType: 'anomaly.dismissed', count: 2 },
        { eventType: 'anomaly.promoted', count: 1 },
        { eventType: 'anomaly.resolved', count: 1 },
      ]);
      mockSelectOnce([
        { status: 'open', closeReason: null, count: 3 },
        { status: 'resolved', closeReason: 'cleared', count: 2 },
        { status: 'dismissed', closeReason: 'user', count: 1 },
      ]);
      mockSelectOnce([
        { total: 6, recurring: 2, closedTotal: 3, humanClosed: 1, medianDurationSeconds: 900 },
      ]);

      const res = await app.request('/analytics/anomalies/evaluation?range=30d', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      // cleared is excluded from the human-label denominator (total) and rates,
      // but still reported as its own count.
      expect(body.total).toBe(10);
      expect(body.status).toEqual({ open: 4, dismissed: 3, promoted: 2, resolved: 1, cleared: 5 });
      expect(body.rates).toEqual({ dismissRate: 0.3, promoteRate: 0.2, resolveRate: 0.1 });
      expect(body.feedback).toEqual({ total: 4, dismissed: 2, promoted: 1, resolved: 1 });
      expect(body.window.range).toBe('30d');
      expect(body.orgId).toBe(ORG_ID);
      expect(body.episodes).toEqual({
        total: 6,
        byStatus: { open: 3, resolved: 2, dismissed: 1 },
        byCloseReason: { cleared: 2, expired_offline: 0, expired_no_data: 0, user: 1, snoozed: 0 },
        medianDurationSeconds: 900,
        recurrenceShare: 2 / 6,
        humanLabelledShare: 1 / 3,
      });
    });
```

Update the "returns zero rates when no anomalies match" test (lines 533-547):

```ts
    it('returns zero rates when no anomalies match', async () => {
      mockSelectOnce([]);
      mockSelectOnce([]);
      mockSelectOnce([]);
      mockSelectOnce([{ total: 0, recurring: 0, closedTotal: 0, humanClosed: 0, medianDurationSeconds: null }]);

      const res = await app.request('/analytics/anomalies/evaluation?range=7d', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' }
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.total).toBe(0);
      expect(body.rates).toEqual({ dismissRate: 0, promoteRate: 0, resolveRate: 0 });
      expect(body.feedback.total).toBe(0);
      expect(body.episodes).toEqual({
        total: 0,
        byStatus: { open: 0, resolved: 0, dismissed: 0 },
        byCloseReason: { cleared: 0, expired_offline: 0, expired_no_data: 0, user: 0, snoozed: 0 },
        medianDurationSeconds: null,
        recurrenceShare: 0,
        humanLabelledShare: 0,
      });
    });
```

Update "includes v1 shadow comparison only when requested" (lines 549-583): insert two mocks after
the existing 2 base mocks and before the 3 v1-candidate mocks, and bump the call-count assertion:

```ts
      mockSelectOnce([
        { status: 'open', count: 4 },
        { status: 'dismissed', count: 1 },
      ]);
      mockSelectOnce([
        { eventType: 'anomaly.dismissed', count: 1 },
      ]);
      mockSelectOnce([]); // episode group rows
      mockSelectOnce([{ total: 0, recurring: 0, closedTotal: 0, humanClosed: 0, medianDurationSeconds: null }]); // episode agg
      mockSelectOnce([{ totalCandidates: 6 }]);
      mockSelectOnce([{ overlapWithV0: 3 }]);
      mockSelectOnce([
        { eventType: 'anomaly.dismissed', count: 2 },
        { eventType: 'anomaly.promoted', count: 1 },
      ]);
```
...and change `expect(vi.mocked(db.select)).toHaveBeenCalledTimes(5);` to `toHaveBeenCalledTimes(7)`.

Update "omits v1 shadow and issues no candidate queries by default" (lines 585-605): insert the same
two episode mocks after the existing 2, and change `toHaveBeenCalledTimes(2)` to `toHaveBeenCalledTimes(4)`.

Update "reports an all-zero v1 shadow block when there are no candidates" (lines 607-635): insert the
same two episode mocks (positions 3-4, before the 3 v1-candidate mocks) — no call-count assertion
exists in this test, so no further change needed there.

Second, in the site-scope describe block (lines 1101-1156): update "narrows org-wide anomaly
evaluation to in-scope devices for a site-restricted caller" (lines 1116-1139) — insert two episode
mocks after the existing "feedback counts" mock:

```ts
        mockSelectOnce(ORG_DEVICE_ROWS); // device resolution
        mockSelectOnce([
          { status: 'open', count: 1 },
          { status: 'dismissed', count: 1 },
        ]); // anomaly status counts
        mockSelectOnce([
          { eventType: 'anomaly.dismissed', count: 1 },
        ]); // feedback counts
        mockSelectOnce([]); // episode group rows
        mockSelectOnce([{ total: 0, recurring: 0, closedTotal: 0, humanClosed: 0, medianDurationSeconds: null }]); // episode agg
```
...and change `toHaveBeenCalledTimes(3)` to `toHaveBeenCalledTimes(5)`.

Update "short-circuits anomaly evaluation when a site-restricted caller has no in-scope devices"
(lines 1141-1155) — this path returns `zeroAnomalyEvaluationResponse` before any anomaly/episode
query runs, so the call count (`1`, device resolution only) is unchanged; only the body assertion
needs the new keys:

```ts
        expect(body.status).toEqual({ open: 0, dismissed: 0, promoted: 0, resolved: 0, cleared: 0 });
        expect(body.episodes).toEqual({
          total: 0,
          byStatus: { open: 0, resolved: 0, dismissed: 0 },
          byCloseReason: { cleared: 0, expired_offline: 0, expired_no_data: 0, user: 0, snoozed: 0 },
          medianDurationSeconds: null,
          recurrenceShare: 0,
          humanLabelledShare: 0,
        });
```

- [ ] **Step 2: Run and verify the tests fail**

```bash
cd apps/api && npx vitest run src/routes/analytics.test.ts
```
Expected: FAIL — `body.status.cleared` is `undefined`, `body.episodes` is `undefined`, and the
call-count assertions are off by the two new (as-yet-unissued) episode queries.

- [ ] **Step 3: Implement**

In `apps/api/src/routes/analytics.ts`, add `metricAnomalyEpisodes` to the schema import at the top of
the file (alongside the existing `metricAnomalies`, `mlFeedbackEvents`, `metricAnomalyCandidates`
imports — find and extend that import statement).

Replace `zeroAnomalyEvaluationResponse` (lines 310-348) with:

```ts
function zeroAnomalyEvaluationResponse(options: {
  since: Date;
  until: Date;
  range: string;
  orgId?: string;
  deviceId?: string;
  includeV1?: boolean;
}) {
  return {
    window: {
      range: options.range,
      since: options.since.toISOString(),
      until: options.until.toISOString(),
    },
    orgId: options.orgId,
    deviceId: options.deviceId,
    total: 0,
    status: {
      open: 0,
      dismissed: 0,
      promoted: 0,
      resolved: 0,
      cleared: 0,
    },
    rates: {
      dismissRate: 0,
      promoteRate: 0,
      resolveRate: 0,
    },
    feedback: {
      total: 0,
      dismissed: 0,
      promoted: 0,
      resolved: 0,
    },
    episodes: zeroEpisodeEvaluation(),
    ...(options.includeV1 ? {
      v1Shadow: zeroV1ShadowEvaluation(0),
    } : {}),
  };
}

function zeroEpisodeEvaluation() {
  return {
    total: 0,
    byStatus: { open: 0, resolved: 0, dismissed: 0 },
    byCloseReason: { cleared: 0, expired_offline: 0, expired_no_data: 0, user: 0, snoozed: 0 },
    medianDurationSeconds: null as number | null,
    recurrenceShare: 0,
    humanLabelledShare: 0,
  };
}
```

In the handler (currently lines 1090-1334), change the `status` accumulator (lines 1200-1206) to:

```ts
    const status = { open: 0, dismissed: 0, promoted: 0, resolved: 0, cleared: 0 };
    for (const row of statusRows) {
      const key = String(row.status);
      if (key === 'open' || key === 'dismissed' || key === 'promoted' || key === 'resolved' || key === 'cleared') {
        status[key] = Number(row.count) || 0;
      }
    }

    // cleared members are automatic (auto-resolve, spec D5/D7), never a human
    // label — excluded from `total` and therefore from every rate denominator
    // below, but still surfaced as its own count in `status.cleared`.
    const total = status.open + status.dismissed + status.promoted + status.resolved;
```

Immediately after the `feedback.total = ...` line (currently line 1216), add the episode block, always
computed (not gated by `includeV1`):

```ts
    const episodeOrgCondition =
      query.orgId
        ? eq(metricAnomalyEpisodes.orgId, query.orgId)
        : typeof auth?.orgCondition === 'function'
          ? auth.orgCondition(metricAnomalyEpisodes.orgId)
          : auth?.orgId
            ? eq(metricAnomalyEpisodes.orgId, auth.orgId)
            : undefined;

    const episodeConditions: SQL[] = [
      gte(metricAnomalyEpisodes.firstSeenAt, since),
      ...(episodeOrgCondition ? [episodeOrgCondition] : []),
      ...(query.deviceId ? [eq(metricAnomalyEpisodes.deviceId, query.deviceId)] : []),
      ...(allowedDeviceIds !== null && !query.deviceId && allowedDeviceIds.length > 0
        ? [inArray(metricAnomalyEpisodes.deviceId, allowedDeviceIds)]
        : []),
    ];

    const episodeGroupRows = await db
      .select({
        status: metricAnomalyEpisodes.status,
        closeReason: metricAnomalyEpisodes.closeReason,
        count: sql<number>`count(*)`,
      })
      .from(metricAnomalyEpisodes)
      .where(and(...episodeConditions))
      .groupBy(metricAnomalyEpisodes.status, metricAnomalyEpisodes.closeReason);

    const [episodeAggRow] = await db
      .select({
        total: sql<number>`count(*)`,
        recurring: sql<number>`count(*) filter (where ${metricAnomalyEpisodes.recurrenceCount} >= 1)`,
        closedTotal: sql<number>`count(*) filter (where ${metricAnomalyEpisodes.resolvedAt} is not null)`,
        humanClosed: sql<number>`count(*) filter (where ${metricAnomalyEpisodes.closeReason} = 'user')`,
        medianDurationSeconds: sql<number | null>`percentile_cont(0.5) within group (order by extract(epoch from (${metricAnomalyEpisodes.resolvedAt} - ${metricAnomalyEpisodes.firstSeenAt}))) filter (where ${metricAnomalyEpisodes.resolvedAt} is not null)`,
      })
      .from(metricAnomalyEpisodes)
      .where(and(...episodeConditions));

    const episodeByStatus = { open: 0, resolved: 0, dismissed: 0 };
    const episodeByCloseReason = { cleared: 0, expired_offline: 0, expired_no_data: 0, user: 0, snoozed: 0 };
    for (const row of episodeGroupRows) {
      const statusKey = String(row.status);
      if (statusKey === 'open' || statusKey === 'resolved' || statusKey === 'dismissed') {
        episodeByStatus[statusKey] += Number(row.count) || 0;
      }
      const reasonKey = row.closeReason ? String(row.closeReason) : null;
      if (reasonKey && reasonKey in episodeByCloseReason) {
        episodeByCloseReason[reasonKey as keyof typeof episodeByCloseReason] += Number(row.count) || 0;
      }
    }

    const episodeTotal = Number(episodeAggRow?.total) || 0;
    const episodeRecurring = Number(episodeAggRow?.recurring) || 0;
    const episodeClosedTotal = Number(episodeAggRow?.closedTotal) || 0;
    const episodeHumanClosed = Number(episodeAggRow?.humanClosed) || 0;
    const episodeMedianDurationSeconds =
      episodeAggRow?.medianDurationSeconds == null ? null : Math.round(Number(episodeAggRow.medianDurationSeconds));

    const episodes = {
      total: episodeTotal,
      byStatus: episodeByStatus,
      byCloseReason: episodeByCloseReason,
      medianDurationSeconds: episodeMedianDurationSeconds,
      recurrenceShare: episodeTotal > 0 ? episodeRecurring / episodeTotal : 0,
      humanLabelledShare: episodeClosedTotal > 0 ? episodeHumanClosed / episodeClosedTotal : 0,
    };
```

Finally, in the response `c.json({...})` (currently lines 1315-1332), add `episodes,` after `feedback,`:

```ts
      feedback,
      episodes,
      ...(v1Shadow ? { v1Shadow } : {}),
```

- [ ] **Step 4: Run and verify the tests pass**

```bash
cd apps/api && npx vitest run src/routes/analytics.test.ts
```
Expected: PASS, full file (this file also covers unrelated `/analytics/*` routes — a full-file green
run confirms nothing else in the route file was disturbed by the shared import/edit).

- [ ] **Step 5: Typecheck**

```bash
cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p .; echo exit=$?
```
Expected: `exit=0`. (Run untailed/unpiped per the pipe-to-tail OOM trap — check the printed exit code,
not just "looks done".)

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/analytics.ts apps/api/src/routes/analytics.test.ts
git commit -m "$(cat <<'EOF'
feat(analytics): episode block + cleared exclusion in anomaly evaluation

/analytics/anomalies/evaluation now reports status.cleared as its own
count (excluded from total and therefore from every rate denominator,
since auto-resolve is not a human label) and an additive `episodes`
block: counts by status/close_reason, median close duration, recurrence
share, and human-labelled share. Response stays backward compatible —
additive keys only.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Runbook — "Anomaly episodes" section

**Files:**
- Modify: `docs/runbooks/ml-operations.md` (insert a new `## Anomaly Episodes` section after the
  existing `## Evaluation Endpoints` section, currently ending at line ~116, before `## V1 Promotion
  Baselines` at line 117)

**Interfaces:**
- Consumes: nothing (documentation only).
- Produces: nothing consumed by other tasks.

- [ ] **Step 1: Write the section**

Insert into `docs/runbooks/ml-operations.md` immediately before the `## V1 Promotion Baselines`
heading:

```markdown
## Anomaly Episodes

The anomaly pipeline has three grouping grains — don't confuse them:

| Grain | Table | Purpose |
| --- | --- | --- |
| Per-bucket row | `metric_anomalies` | one row per device × metric × anomaly type × 5-min bucket; the raw evidence |
| Dispatch outbox | `metric_anomaly_incidents` | AI-pilot dispatch queue, same per-bucket grain, gains `episode_id` + `suppressed_by_episode` so only one incident per episode is actually published |
| Lifecycle | `metric_anomaly_episodes` | one row per contiguous run of anomalous buckets for a (device, episode key); what the tech-facing panel shows |

### Lifecycle

`open → resolved` (human, or automatic `cleared`/`expired_offline`/`expired_no_data`) or
`open → dismissed` (human, or an already-snoozed successor). Closed episodes are never reopened; new
activity after a close starts a new episode with `recurrence_count` = episodes with the same
(device, episode key) closed in the prior 7 days.

Member `metric_anomalies` rows cascade to the episode's new status **only while still `open`** — a
promoted member keeps its `promoted` status regardless of what the episode does next. Auto-resolve
(`cleared`) sets open members to a `cleared` status that is distinct from a human `resolved`.

### Constants (defined in `apps/api/src/services/metricAnomalyEpisodeKeys.ts`, re-exported from `metricAnomalyEpisodes.ts`; override with env `METRIC_ANOMALY_EPISODE_<NAME>`, e.g. `METRIC_ANOMALY_EPISODE_GAP_MINUTES`, positive integers only)

| Constant | Default | Meaning |
| --- | --- | --- |
| `EPISODE_GAP_MINUTES` | 30 | max gap between anomalous buckets before the episode closes |
| `EPISODE_CLEAN_BUCKETS` | 6 | clean 5-min rollup buckets required (per member metric) to auto-resolve |
| `EPISODE_EXPIRE_HOURS` | 24 | no clean data for this long → expired instead of resolved |
| `EPISODE_RECURRENCE_DAYS` | 7 | lookback window for `recurrence_count` |
| `EPISODE_SNOOZE_DAYS` | 7 | how long a user dismiss silences the episode key on that device |
| `EPISODE_ASSEMBLY_LOOKBACK_HOURS` | 24 | how far back the assembly scan looks for unassigned `metric_anomalies` rows |

### Close reasons

| `close_reason` | Meaning | Human label? |
| --- | --- | --- |
| `cleared` | auto-resolved — 6+ clean rollup buckets after the last anomalous bucket | no |
| `expired_offline` | auto-resolved after 24h with no clean data because the device itself is offline | no |
| `expired_no_data` | auto-resolved after 24h with no clean data while the device is still checking in (series stopped: sampling disabled, agent downgrade, metric removed) | no |
| `user` | a human clicked Resolve or Dismiss | yes |
| `snoozed` | a new episode opened for a key a human dismissed within the last `EPISODE_SNOOZE_DAYS`; created already-dismissed | no (the label was on the *original* dismiss, not this successor) |

Assembly can close an episode too: when a new burst for the same (device, key) starts more than
`EPISODE_GAP_MINUTES` after an open episode ended, the old one is superseded and closed — `cleared`
if every member metric had ≥ `EPISODE_CLEAN_BUCKETS` clean buckets in between, else
`expired_no_data`. Backfill history older than the current episode is created already closed with
the same rule. Both flow to the same close handler as auto-resolve (linked alert auto-resolved).

Auto-resolve runs **even when `ml.anomalies.enabled` is off** — turning off detection must not
freeze open episodes forever. The 10-minute `scan-orgs` job also picks up orgs that have no live
device left but still own an open episode, so those close too.

### Snooze

Dismiss = dismiss-and-snooze: `snoozed_until = now() + EPISODE_SNOOZE_DAYS` on that (device, episode
key). A new episode opened for a still-snoozed key is created already-dismissed
(`close_reason: 'snoozed'`) — auditable, silent, no feedback row. `unsnooze` (`PATCH
/devices/:id/anomaly-episodes/:id { action: 'unsnooze' }`) clears `snoozed_until` without changing
status.

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
- `episodes.humanLabelledShare` = episodes closed with `close_reason: 'user'` ÷ all *closed* episodes
  in the window. Low + a high `episodes.byCloseReason.cleared` share means the fleet is mostly
  self-resolving and techs are rarely need to look — that's the target steady state, not a problem.
- The v1-shadow block (`includeV1=true`) is unaffected by episodes — it still compares
  `metric_anomaly_candidates` to `metric_anomalies` at the per-bucket grain, per-member feedback rows
  still join to it exactly as before.
```

- [ ] **Step 2: Verify it renders / lints clean**

```bash
cd apps/docs 2>/dev/null || true
npx markdownlint-cli2 docs/runbooks/ml-operations.md 2>&1 | tail -20 || true
```
This repo has no dedicated markdown-lint gate for `docs/runbooks/**` (only `docs/**`/`apps/docs/**`
astro-check applies to the marketing/docs site, per `CLAUDE.md`'s merge-queue `docs-check`
description) — this step is a sanity read, not a blocking gate. Read the rendered section once
(`cat docs/runbooks/ml-operations.md` around the new heading) to confirm the tables aren't malformed.

- [ ] **Step 3: Commit**

```bash
git add docs/runbooks/ml-operations.md
git commit -m "$(cat <<'EOF'
docs(ml-ops): add Anomaly Episodes runbook section

Three grouping grains, lifecycle, constants, close reasons, snooze, and
how to read the new episodes block in /analytics/anomalies/evaluation.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Integration tests, contract suites, and final verification

**Files:**
- Create: `apps/api/src/__tests__/integration/metricAnomalyEpisodeEvaluation.integration.test.ts`

**Interfaces:**
- Consumes (exact names): W02 fixtures `insertEpisodeDevice`, `seedEpisode`, `insertCleanRollups`
  (`__tests__/integration/metricAnomalyEpisodeFixtures.ts`), W02's `anomaliesRoutes` episode
  endpoints (`routes/devices/anomalies.ts`), `analyticsRoutes` (`routes/analytics.ts`),
  `createIntegrationTestClient` (`__tests__/integration/db-utils.ts`, the same harness W02's
  `metricAnomalyEpisodeRoutes.integration.test.ts` uses), W01's
  `resolveMetricAnomalyEpisodes(orgId, now?)` (runs inside a system DB context).
- Produces: nothing further downstream.

- [ ] **Step 1: Write the failing integration test**

```bash
pnpm test-stack up
```

`apps/api/src/__tests__/integration/metricAnomalyEpisodeEvaluation.integration.test.ts`:

```ts
import './setup';

import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';

const { publishEventMock } = vi.hoisted(() => ({
  publishEventMock: vi.fn<(...args: unknown[]) => Promise<string>>(async () => 'test-event-id'),
}));
vi.mock('../../services/eventBus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/eventBus')>();
  return { ...actual, publishEvent: publishEventMock };
});

import { withSystemDbAccessContext } from '../../db';
import { mlFeedbackEvents } from '../../db/schema';
import { analyticsRoutes } from '../../routes/analytics';
import { anomaliesRoutes } from '../../routes/devices/anomalies';
import { resolveMetricAnomalyEpisodes } from '../../services/metricAnomalyEpisodes';
import { createIntegrationTestClient } from './db-utils';
import { insertCleanRollups, insertEpisodeDevice, seedEpisode } from './metricAnomalyEpisodeFixtures';
import { getTestDb } from './setup';

const HOUR = 3_600_000;
const BUCKET_MS = 300_000;

function buildApp(): Hono {
  const app = new Hono();
  app.route('/api/v1/devices', anomaliesRoutes);
  app.route('/api/v1/analytics', analyticsRoutes);
  return app;
}

type Client = Awaited<ReturnType<typeof createIntegrationTestClient>>;

async function evaluation(client: Client) {
  const res = await client.get('/api/v1/analytics/anomalies/evaluation?range=7d');
  expect(res.status).toBe(200);
  return res.json();
}

describe('anomaly episode evaluation (W03)', () => {
  it('an episode dismiss adds 17 per-member rows to feedback.total and exactly one anomaly_episode row', async () => {
    const client = await createIntegrationTestClient(buildApp());
    const orgId = client.env.organization.id;
    const deviceId = await insertEpisodeDevice(orgId, client.env.site.id);
    const ep = await seedEpisode({ orgId, deviceId, memberCount: 17, start: new Date(Date.now() - 2 * HOUR) });

    const before = await evaluation(client);
    const res = await client.patch(`/api/v1/devices/${deviceId}/anomaly-episodes/${ep.episodeId}`, { action: 'dismiss' });
    expect(res.status).toBe(200);
    const after = await evaluation(client);

    // The evaluation's `feedback` block counts sourceType 'anomaly' only, so the
    // per-member rows (and the v1-shadow overlap, which joins the same rows)
    // move by 17 and the episode-level row does not leak into it.
    expect(after.feedback.total - before.feedback.total).toBe(17);
    expect(after.feedback.dismissed - before.feedback.dismissed).toBe(17);
    expect(after.episodes.byCloseReason.user - before.episodes.byCloseReason.user).toBe(1);
    expect(after.episodes.byStatus.dismissed - before.episodes.byStatus.dismissed).toBe(1);

    const episodeRows = await getTestDb().select().from(mlFeedbackEvents).where(and(
      eq(mlFeedbackEvents.sourceType, 'anomaly_episode'),
      eq(mlFeedbackEvents.sourceId, ep.episodeId),
    ));
    expect(episodeRows).toHaveLength(1);
    expect(episodeRows[0]!.eventType).toBe('anomaly_episode.dismissed');
  });

  it('auto-resolved (cleared) members leave the human-label denominator and never raise dismissRate', async () => {
    const client = await createIntegrationTestClient(buildApp());
    const orgId = client.env.organization.id;
    const deviceId = await insertEpisodeDevice(orgId, client.env.site.id);
    const start = new Date(Math.floor((Date.now() - 3 * HOUR) / BUCKET_MS) * BUCKET_MS);
    const ep = await seedEpisode({ orgId, deviceId, memberCount: 6, start });
    // seedEpisode sets last_seen_at = start + memberCount buckets; 6 clean buckets after it clear the episode (spec §7).
    await insertCleanRollups({ orgId, deviceId, metricName: 'disk_write_bps', from: new Date(start.getTime() + 6 * BUCKET_MS), count: 6 });

    const before = await evaluation(client);
    expect(before.total).toBe(6);
    expect(before.status.open).toBe(6);

    const closed = await withSystemDbAccessContext(() => resolveMetricAnomalyEpisodes(orgId));
    expect(closed.map((c) => c.episodeId)).toEqual([ep.episodeId]);

    const after = await evaluation(client);
    expect(after.status.cleared).toBe(6);
    expect(after.total).toBe(0); // cleared is excluded from `total`, the human-label denominator
    expect(after.rates.dismissRate).toBe(0);
    expect(after.episodes.byCloseReason.cleared).toBe(1);
    expect(after.episodes.humanLabelledShare).toBe(0);
  });
});
```

- [ ] **Step 2: Run it (end-to-end proof + control)**

```bash
pnpm --filter @breeze/api test:integration src/__tests__/integration/metricAnomalyEpisodeEvaluation.integration.test.ts
```
Expected: PASS (2 tests). Tasks 4-5 already implemented the behaviour, so this is an end-to-end
proof, not red-first (same as W02 Task 10). Run this control and record it in the PR: temporarily
delete the `emitAnomalyEpisodeFeedback` call in `dismissEpisode`, re-run, and watch the first test
fail on `episodeRows` length 0; restore it and confirm green.

- [ ] **Step 3: Run the full contract suite sweep required for tenancy/cascade-adjacent changes**

This wave adds no table and no new tenant-scoped column (only a CHECK constraint value and response
JSON shape), so none of the cascade/export/merge registries need a new entry. Still run the full set
per `CLAUDE.md` since W01 (which does add the table) must already be green on this branch's base:

```bash
DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage
cd apps/api && npx vitest run --config vitest.config.rls.ts
cd apps/api && npx vitest run --config vitest.integration.config.ts
```
Expected: all pass. If `rls-coverage` or the RLS session-context suite fail on something unrelated to
this wave's changes, stop and check whether W01's own registrations are actually merged to the branch
base before debugging further here — this wave doesn't touch tenancy at all.

- [ ] **Step 4: Full targeted unit run + typecheck one more time**

```bash
cd apps/api && npx vitest run src/routes/analytics.test.ts src/services/mlFeedbackEmitters.test.ts src/services/metricAnomalyEpisodeActions.test.ts src/db/autoMigrate.test.ts
cd packages/shared && npx vitest run src/validators/mlFeedback.test.ts
cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p .; echo exit=$?
```
Expected: all PASS, `exit=0`.

- [ ] **Step 5: Tear down the stack**

```bash
pnpm test-stack down
```

- [ ] **Step 6: Commit the integration test**

```bash
git add apps/api/src/__tests__/integration/metricAnomalyEpisodeEvaluation.integration.test.ts
git commit -m "$(cat <<'EOF'
test(anomaly-episodes): integration proof for episode feedback + cleared exclusion

Proves feedback.total moves by member-count+1 on a dismiss (17 per-member
anomaly rows + 1 anomaly_episode row) and that auto-resolved cleared
members never raise dismissRate in /analytics/anomalies/evaluation.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 7: PR notes**

Open the PR against `main` (after W02 has merged) with:
- Title: `feat(analytics): anomaly episode evaluation — feedback source type, episodes block, cleared exclusion (W03)`
- Body: `Closes #<W03 sub-issue>` (from `feature-lifecycle` once the parent feature/waves are
  registered — see the index doc's tracking note), summary of the additive response shape, and the
  self-review checklist below.
- Per `CLAUDE.md`'s merge-queue rules: no `--admin`, dispatch `gh workflow run CI --ref
  feature/<parent#>-metric-anomaly-episodes/wave-<sub-issue#>` if this branch is stacked on W02's
  branch rather than directly on `main` (a stacked PR runs no CI on `pull_request`, per the
  tenancy-section stacked-branch note).

---

## Self-review

**1. Spec coverage.**
- §8.3 per-member feedback rows: already W02's job (§17); this plan (Task 4) adds only the
  episode-level row on top, per D7/§8.3's explicit "that needs the constraint re-created ... both land
  in the evaluation wave (W03)".
- §8.3 "`cleared`/`expired_*`/snoozed successors emit no feedback rows": respected — Task 4 only
  wires `resolve`/`dismiss`, never auto-close or the assembly stage.
- §16 unit list "Route schemas: action enum, 409 on closed episode..." — out of scope for W03 (W02
  owns the route/action schema itself); this plan only touches the evaluation route.
- §16 integration list's episode-specific items ("17 consecutive anomalous buckets", "auto-resolve",
  "snooze") are W01/W02's own integration suites; this plan's Task 7 covers only the two evaluation-
  specific proofs explicitly assigned to W03 in the task brief ("proving `feedback.total` and v1-shadow
  overlap still count per-member rows and `cleared` does not raise dismissRate").
- §18 "`cleared` misread as a human verdict" risk: mitigated by Task 5 (excluded from `total`/`rates`,
  reported separately) — matches the mitigation cell verbatim.
- §17 W03 row ("`anomaly_episode` feedback source type (CHECK migration + shared union), episode-level
  block ..., `cleared` excluded ..., runbook section"): all four covered by Tasks 1-2, 5, 5, 6
  respectively.

**2. Placeholder scan.** Every step has real code. Tasks 4 and 7 target W02 code
(`metricAnomalyEpisodeActions.ts` `resolveEpisode`/`dismissEpisode`, `metricAnomalyEpisodeFixtures.ts`)
by its planned names, reconciled against the W02 plan on 2026-09-22; if W02 merged under different
names, follow the index's contract table.

**3. Type consistency.** `emitAnomalyEpisodeFeedback` (Task 3) signature matches its two call sites in
Task 4 (`eventType`/`outcome` pairs: `dismissed`/`dismissed`, `resolved`/`resolved`). `episodes`
response shape (Task 5) is identical between the live handler and `zeroEpisodeEvaluation()`/
`zeroAnomalyEvaluationResponse()`, and identical to every test assertion added in Task 5 and the
runbook's field descriptions in Task 6. `ML_FEEDBACK_SOURCE_TYPES`/`ML_FEEDBACK_EVENT_TYPES` (Task 2)
values match the migration's CHECK list (Task 1) and the emitter's literal `sourceType`/`eventType`
strings (Task 3) exactly: `anomaly_episode`, `anomaly_episode.dismissed`, `anomaly_episode.resolved`.
