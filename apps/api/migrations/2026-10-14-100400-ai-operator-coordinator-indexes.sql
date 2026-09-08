-- AI Operator coordinator recovery-scan indexes (#5205 W06, sub-issue #5211).
--
-- Spec §11.1 requires every polled table to have a partial index designed
-- around LEAKPROOF predicates, because the coordinator reads under FORCED row
-- level security as `breeze_app` and only leakproof operators (`texteq`,
-- timestamp comparisons, `IS NULL`) can be promoted to index conditions there.
-- That is exactly why `ai_operator_tasks.state` is `text` + CHECK rather than
-- a `pgEnum`: enum equality is NOT leakproof and would leave one leaky arm
-- that turns the whole scan into a post-policy filter.
--
-- W03 shipped two of the four scan sets' indexes:
--   ai_operator_tasks_wake_idx   (next_wake_at) WHERE state = 'waiting'
--   ai_operator_tasks_lease_idx  (lease_expires_at) WHERE state IN ('running','stopping')
--
-- The remaining two scan sets (spec §6.3's "queued tasks past their admission
-- wake" and "terminal tasks with an unsettled operation") had none. An
-- advisory quorum on 2026-09-08 (Claude + Codex, independently) confirmed both
-- gaps: neither is served by an existing index, because
-- `ai_operator_tasks_org_state_updated_idx` leads with `org_id` and these are
-- cross-org sweeps that have no org to lead with.
--
-- ADDS NO COLUMN, NO CONSTRAINT, NO POLICY. Index-only, so `db:check-drift`
-- stays clean against the Drizzle schema once the matching index declarations
-- land in `db/schema/aiOperatorTasks.ts` (they do, in the same PR).
--
-- No DML, so no `set_config('breeze.scope','system')` elevation is needed —
-- the migration RLS-scope guard (`migrationRlsScope.test.ts`) only requires it
-- of files containing INSERT/UPDATE/DELETE/MERGE.

-- ---------------------------------------------------------------------------
-- Scan set 1: queued tasks past their admission wake.
-- ---------------------------------------------------------------------------
-- The predicate is stated as a bare literal (`state = 'queued'`) rather than
-- through any parameterisable form, because the planner proves a partial
-- index's predicate STATICALLY: an interpolated bind the proof cannot see
-- silently demotes the scan without any error.
CREATE INDEX IF NOT EXISTS ai_operator_tasks_queued_wake_idx
  ON ai_operator_tasks (next_wake_at)
  WHERE state = 'queued';

-- ---------------------------------------------------------------------------
-- Scan set 4: operations that could still produce a real effect.
-- ---------------------------------------------------------------------------
-- Deliberately indexed on the OPERATIONS table, not on tasks. The obvious
-- shape — scan every terminal task and test `EXISTS (SELECT 1 FROM
-- ai_operator_operations …)` — is an unbounded and permanently growing
-- sequential scan: terminal tasks accumulate forever and virtually none of
-- them have anything outstanding. Unsettled operations are instead a small,
-- self-draining set.
--
-- `result_state IN ('pending','unknown')` matches the reconciler's query
-- verbatim. `execution_ref_id IS NOT NULL` is the half that matters
-- semantically as well as for selectivity: an operation with no execution
-- reference produced no external effect that could still land, so it is not
-- "unsettled" in the sense spec §6.3 means — nothing is outstanding to chase.
--
-- Ordered by `updated_at` so the reconciler's `ORDER BY o.updated_at` is
-- satisfied by the index rather than by a sort of the whole matching set.
CREATE INDEX IF NOT EXISTS ai_operator_operations_unsettled_idx
  ON ai_operator_operations (updated_at)
  WHERE result_state IN ('pending', 'unknown') AND execution_ref_id IS NOT NULL;
