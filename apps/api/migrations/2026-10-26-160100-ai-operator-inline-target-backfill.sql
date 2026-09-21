-- apps/api/migrations/2026-10-26-160100-ai-operator-inline-target-backfill.sql
--
-- 2026-10-26: migrate the AI Operator thin slice's INLINE target and step to
-- rows (recipe spec §5.5, Operator plan P3-2: "migrate P3-1's inline
-- current_step_key/checkpoint to step rows").
--
-- THE INLINE COLUMNS ARE NOT DROPPED. `ai_operator_tasks.device_id`,
-- `target_label`, `target_detached_at`, `target_detached_reason` and
-- `current_step_key` remain as a READ PROJECTION until P3-5 removes them
-- (recipe spec §5.5). Everything that reads them today keeps working, the
-- detail DTO keeps its `target` object, and the three device detach paths keep
-- writing BOTH the task columns and the new target rows. Dropping them here
-- would turn an additive wave into a breaking one for every reader in the
-- repo and in the web app.
--
-- DML ONLY, and therefore SYSTEM SCOPE FIRST. `breeze_current_scope()`
-- defaults to 'none' and 425 of 442 tables are FORCE ROW LEVEL SECURITY, which
-- binds the table OWNER — the role migrations run as. Without the election
-- below, the INSERTs abort with 42501 on any connection that does not bypass
-- RLS, and an UPDATE would silently match zero rows while RAISE WARNING
-- printed a truthful-looking '0'. `is_local = true` scopes it to autoMigrate's
-- per-file transaction. Enforced by apps/api/src/db/migrationRlsScope.test.ts —
-- and NEVER add this file to that test's frozen 122-offender baseline.
--
-- IDEMPOTENT BY CONSTRUCTION, not by IF NOT EXISTS: every INSERT is a
-- `SELECT … WHERE NOT EXISTS (…)` against the row it would create, so a second
-- run inserts nothing and reports 0. Re-running is a true no-op.
--
-- Row counts are reported with RAISE WARNING even when zero. A backfill that
-- silently touches nothing is indistinguishable from a backfill that silently
-- failed, and this one re-parents tenant data — the count belongs in the
-- Postgres log either way (lesson from 2026-06-10-c).
--
-- SCALE NOTE. `ai_operator_tasks` is behind AI_OPERATOR_TASKS_ENABLED and has
-- at most a handful of rows in every environment today, so these are plain
-- single-statement backfills. If that stops being true before this ships,
-- convert each INSERT to a batched `WHERE ctid IN (… LIMIT 5000)` loop — the
-- statements below are already written as set-based inserts with an anti-join,
-- so the conversion is mechanical.

SELECT set_config('breeze.scope', 'system', true);

-- ---------------------------------------------------------------------------
-- 1. One target row per task that has (or had) a device target
-- ---------------------------------------------------------------------------
--
-- Covers the DETACHED case too: a task whose device_id is already NULL but
-- whose target_detached_at is stamped had a real target, and its frozen
-- `target_label` is the evidence of what it was. Skipping those would lose
-- history. A task with neither a device_id nor a detach stamp never had a
-- target (there is no such row today — every admission sets both — but the
-- predicate says so rather than assuming it).

DO $$
DECLARE
  n integer;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);

  INSERT INTO ai_operator_task_targets (
    org_id, task_id, target_kind, device_id, target_label, target_ordinal,
    state, detached_at, detached_reason, created_at, updated_at
  )
  SELECT
    t.org_id,
    t.id,
    'device',
    t.device_id,
    -- left(…, 255): ai_operator_task_targets_label_len_chk.
    left(COALESCE(t.target_label, 'device ' || COALESCE(t.device_id::text, '(detached)')), 255),
    0,                       -- recipe spec §5.1: ordinal 0, the only target
    CASE
      WHEN t.target_detached_at IS NOT NULL THEN 'detached'
      WHEN t.state IN ('completed', 'partial') THEN 'succeeded'
      WHEN t.state IN ('failed', 'expired', 'cancelled', 'handed_off') THEN 'failed'
      ELSE 'active'
    END,
    t.target_detached_at,
    t.target_detached_reason,
    t.created_at,            -- the target is as old as the task, not as old as this migration
    now()
  FROM ai_operator_tasks t
  WHERE (t.device_id IS NOT NULL OR t.target_detached_at IS NOT NULL)
    AND NOT EXISTS (
      SELECT 1 FROM ai_operator_task_targets x
      WHERE x.task_id = t.id AND x.org_id = t.org_id AND x.target_ordinal = 0
    );

  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE WARNING 'ai_operator_task_targets: backfilled % target row(s) from the inline device target', n;
END $$;

-- ---------------------------------------------------------------------------
-- 2. One step row per task that has a current_step_key
-- ---------------------------------------------------------------------------
--
-- STEP KIND IS DERIVED FROM THE SERVICE-RECOVERY SPINE, not guessed. The only
-- recipe in existence is `service_recovery`, whose ordered step keys are
-- ['investigate', 'execute', 'observe', 'verify', 'document']
-- (services/aiOperator/recipes/serviceRecovery.ts:50-52). Their kinds under
-- recipe spec §6.1's execution table are: investigate = reason,
-- execute = effect, observe = probe, verify = probe, document = document.
-- Any OTHER workflow_key present in the table would be a row this migration
-- cannot classify, so the ELSE arm below records it as 'reason' AND section 3
-- reports the count separately — a silent misclassification is worse than a
-- logged one.
--
-- attempt_ordinal is taken from the task's own `attempt_ordinal`, so the
-- backfilled step carries the identity the coordinator would have given it,
-- and a live task's next `openStep` call does not collide with it.
--
-- `plan_revision` is the task's current `revision`, and `state` mirrors where
-- the task actually is: a live task's current step is running or waiting; a
-- terminal task's current step is settled.

DO $$
DECLARE
  n integer;
  unknown_recipes integer;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);

  INSERT INTO ai_operator_task_steps (
    org_id, task_id, step_key, step_kind, target_id, attempt_ordinal,
    state, plan_revision, checkpoint, started_at, settled_at, created_at, updated_at
  )
  SELECT
    t.org_id,
    t.id,
    t.current_step_key,
    CASE
      WHEN t.workflow_key = 'service_recovery' AND t.current_step_key = 'investigate' THEN 'reason'
      WHEN t.workflow_key = 'service_recovery' AND t.current_step_key = 'execute'     THEN 'effect'
      WHEN t.workflow_key = 'service_recovery' AND t.current_step_key = 'observe'     THEN 'probe'
      WHEN t.workflow_key = 'service_recovery' AND t.current_step_key = 'verify'      THEN 'probe'
      WHEN t.workflow_key = 'service_recovery' AND t.current_step_key = 'document'    THEN 'document'
      ELSE 'reason'
    END,
    tgt.id,
    t.attempt_ordinal,
    CASE
      WHEN t.state = 'waiting' THEN 'waiting'
      WHEN t.state IN ('queued', 'running', 'paused', 'stopping') THEN 'running'
      WHEN t.state IN ('completed', 'partial') THEN 'succeeded'
      ELSE 'failed'
    END,
    t.revision,
    -- The task's checkpoint IS this step's checkpoint: the thin slice keeps
    -- exactly one live step, so there is nothing to split.
    t.checkpoint,
    t.created_at,
    CASE WHEN t.state IN ('completed','partial','handed_off','cancelled','failed','expired')
         THEN t.updated_at ELSE NULL END,
    t.created_at,
    now()
  FROM ai_operator_tasks t
  LEFT JOIN ai_operator_task_targets tgt
    ON tgt.task_id = t.id AND tgt.org_id = t.org_id AND tgt.target_ordinal = 0
  WHERE t.current_step_key IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM ai_operator_task_steps s
      WHERE s.org_id = t.org_id
        AND s.task_id = t.id
        AND s.step_key = t.current_step_key
        AND s.attempt_ordinal = t.attempt_ordinal
    );

  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE WARNING 'ai_operator_task_steps: backfilled % step row(s) from ai_operator_tasks.current_step_key', n;

  SELECT count(*) INTO unknown_recipes
  FROM ai_operator_tasks t
  WHERE t.current_step_key IS NOT NULL
    AND t.workflow_key <> 'service_recovery';
  RAISE WARNING 'ai_operator_task_steps: % backfilled step(s) belonged to a workflow_key other than service_recovery and were classified step_kind = reason by the ELSE arm — review if non-zero', unknown_recipes;
END $$;

-- ---------------------------------------------------------------------------
-- 3. One admission event per backfilled task, so no task has an empty timeline
-- ---------------------------------------------------------------------------
--
-- transition_seq 1 for every one of them, and ai_operator_tasks.event_seq is
-- advanced to match IN THE SAME STATEMENT SEQUENCE — otherwise the first
-- runtime appendTaskEvent would allocate 1 again and collide with this row on
-- ai_operator_task_events_task_seq_uq. That collision would be a 23505 inside
-- a request transaction, i.e. a 500 on the first coordinator tick after
-- deploy: the exact failure this section exists to prevent.
--
-- actor_kind = 'system' with a NULL actor_user_id: a backfill has no human
-- actor, and ai_operator_task_events_actor_chk enforces that pairing.

DO $$
DECLARE
  n integer;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);

  INSERT INTO ai_operator_task_events (
    org_id, task_id, transition_seq, event_type, actor_kind, actor_user_id,
    step_key, target_id, detail, created_at
  )
  SELECT
    t.org_id, t.id, 1, 'task_admitted', 'system', NULL,
    t.current_step_key,
    tgt.id,
    'Timeline opened by the wave E2 backfill. Events before this point were not recorded: the task predates ai_operator_task_events.',
    t.created_at
  FROM ai_operator_tasks t
  LEFT JOIN ai_operator_task_targets tgt
    ON tgt.task_id = t.id AND tgt.org_id = t.org_id AND tgt.target_ordinal = 0
  WHERE NOT EXISTS (
    SELECT 1 FROM ai_operator_task_events e WHERE e.task_id = t.id
  );

  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE WARNING 'ai_operator_task_events: opened % task timeline(s) with a backfilled task_admitted event', n;

  UPDATE ai_operator_tasks t
     SET event_seq = GREATEST(t.event_seq, (
           SELECT COALESCE(max(e.transition_seq), 0)
           FROM ai_operator_task_events e
           WHERE e.task_id = t.id
         ))
   WHERE EXISTS (SELECT 1 FROM ai_operator_task_events e WHERE e.task_id = t.id);

  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE WARNING 'ai_operator_tasks: advanced event_seq on % task(s) to match their highest event transition_seq', n;
END $$;
