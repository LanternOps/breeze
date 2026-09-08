-- E2E fixture: the pending Tier-3 approval an AI Operator service-recovery
-- task waits on, attached to a task that the BROWSER really created
-- (#5205 W08, #5246).
--
-- Why this is seeded rather than driven: reaching this state for real needs a
-- live LLM (the investigate run must propose the restart and call
-- createActionIntent) and a BullMQ coordinator tick. The e2e stack has
-- neither — `tests/script-cancel.spec.ts` records the same constraint for
-- device commands: "There is no fake/live agent in the e2e stack". The
-- coordinator's own transition into this state is proven against real
-- Postgres by aiOperatorServiceRecoveryE2E.integration.test.ts; what this
-- fixture exists for is the half nothing else covers — that the approval a
-- delegated task is waiting on is still decidable by a human in a BROWSER
-- SESSION THAT DID NOT CREATE IT, after the creating session is gone
-- (spec §7.1, "authority across time"; acceptance scenario 3).
--
-- The task itself is NOT seeded. It must already exist, created through the
-- real admission route by the real button, and is passed in as :task_id.
--
-- Mirrors advanceInvestigate's `awaiting_approval` branch
-- (services/aiOperator/taskCoordinator.ts): the task yields to a wait keyed on
-- the intent, with the step advanced to `execute`.
--
-- Idempotent-ish: reruns append a new intent/approval pair for the task, which
-- is fine — each run passes a freshly delegated task id.
--
-- Emits APPROVAL_ID / INTENT_ID on stdout for the spec to parse.

\set ON_ERROR_STOP on

SELECT set_config('breeze.scope', 'system', true);

-- psql does NOT substitute :variables inside a dollar-quoted body (its lexer
-- treats $$...$$ as a quoted literal), so the task id is handed to the block
-- through a GUC instead of interpolated into it.
SELECT set_config('e2e.task_id', :'task_id', false);

DO $$
DECLARE
  v_task_id  uuid := current_setting('e2e.task_id')::uuid;
  v_org_id   uuid;
  v_partner  uuid;
  v_user_id  uuid;
  v_service  text;
  v_device   uuid;
  v_intent   uuid;
  v_approval uuid;
  v_digest   char(64) := repeat('b', 64);
BEGIN
  SELECT t.org_id, t.requester_user_id, t.device_id
    INTO v_org_id, v_user_id, v_device
    FROM ai_operator_tasks t
   WHERE t.id = v_task_id;

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'seed: ai_operator_tasks row % not found — did the delegate action really create it?', v_task_id;
  END IF;

  SELECT partner_id INTO v_partner FROM organizations WHERE id = v_org_id;

  -- Drop what earlier runs of this spec left behind. Two identical pending
  -- approvals in one org CLUSTER into a single grouped card in the inbox,
  -- which renders `approval-group-approve-<key>` instead of the per-row
  -- `approval-approve-<id>` the spec clicks — so a rerun would fail on a
  -- selector that is missing for a reason unrelated to what is under test.
  DELETE FROM approval_requests ar
   USING action_intents ai
   WHERE ar.intent_id = ai.id
     AND ai.idempotency_key LIKE 'e2e-operator-task-%';
  DELETE FROM action_intents WHERE idempotency_key LIKE 'e2e-operator-task-%';

  -- The service name the browser typed, recovered from the task objective so
  -- the seeded approval describes the SAME action the task was admitted for
  -- rather than an unrelated one.
  SELECT COALESCE(NULLIF(t.checkpoint #>> '{recipeInput,serviceName}', ''), 'Spooler')
    INTO v_service
    FROM ai_operator_tasks t WHERE t.id = v_task_id;

  INSERT INTO action_intents (
    org_id, partner_id, requested_by_user_id, source, requesting_client_label,
    action_name, arguments, argument_digest, target_summary, impact_summary,
    reason, risk_tier, idempotency_key, correlation_id, status, expires_at,
    approval_scope, task_id, task_step_key, operation_key
  ) VALUES (
    v_org_id, v_partner, v_user_id, 'chat', 'Breeze AI Operator',
    'manage_services',
    jsonb_build_object('action', 'restart', 'deviceId', v_device, 'serviceName', v_service),
    v_digest,
    'Restart ' || v_service,
    'Restarts a service on the target device',
    'E2E: AI Operator service recovery',
    3,
    'e2e-operator-task-' || gen_random_uuid()::text,
    gen_random_uuid(),
    'pending_approval',
    now() + interval '30 minutes',
    -- Sole-operator shape: the row is fanned out to the requester, and
    -- isIntentRowLiveAuthorized's supervised branch authorizes exactly them.
    -- The column defaults to 'four_eyes', under which the requester is not an
    -- authorized decider and the row never reaches their inbox at all.
    'supervised',
    v_task_id,
    -- action_intents_task_link_chk: task_id, task_step_key and operation_key
    -- are all-or-nothing.
    'execute',
    'restart_service'
  ) RETURNING id INTO v_intent;

  INSERT INTO approval_requests (
    user_id, requesting_client_label, action_label, action_tool_name,
    action_arguments, risk_tier, risk_summary, status, expires_at,
    intent_id, bound_argument_digest, is_recursive
  ) VALUES (
    v_user_id, 'Breeze AI Operator',
    'Restart ' || v_service, 'manage_services',
    jsonb_build_object('action', 'restart', 'deviceId', v_device, 'serviceName', v_service),
    'high', 'Restarts a service on the target device', 'pending',
    now() + interval '30 minutes',
    v_intent, v_digest, false
  ) RETURNING id INTO v_approval;

  -- Park the task exactly where the coordinator parks it while an approval is
  -- outstanding, so the task detail page under test shows the real waiting
  -- shape and not a queued one.
  UPDATE ai_operator_tasks
     SET state = 'waiting',
         phase = 'execute',
         current_step_key = 'execute',
         wait_reason = 'approval',
         wait_dependency_kind = 'intent',
         wait_dependency_id = v_intent,
         next_wake_at = now() + interval '1 hour'
   WHERE id = v_task_id;

  RAISE NOTICE 'APPROVAL_ID=%', v_approval;
  RAISE NOTICE 'INTENT_ID=%', v_intent;
END $$;

-- RAISE NOTICE goes to stderr, which execFileSync callers don't capture.
-- Re-emit on stdout.
SELECT 'APPROVAL_ID=' || ar.id || ' INTENT_ID=' || ai.id
  FROM approval_requests ar
  JOIN action_intents ai ON ai.id = ar.intent_id
 WHERE ai.task_id = :'task_id'
 ORDER BY ar.created_at DESC
 LIMIT 1;
