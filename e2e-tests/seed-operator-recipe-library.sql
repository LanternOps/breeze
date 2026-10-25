-- E2E fixture for the Operator Recipe Library spec (W06 R1b, #6171).
--
-- Seeds ONLY what readiness and the read views need, with generic placeholder
-- values (no real tenant, account, domain or credential):
--
--  1. The partner-wide `helpdesk` AI agent `identity_offboarding` runs under
--     (RECIPE_AGENT_KINDS). Same shape and idempotency as
--     seed-operator-agent.sql's triage baseline.
--  2. A Google Workspace connection row with status 'active' for the fixtures
--     org, so the recipe is not `unavailable` (readiness only reads the row's
--     status). Its key is a placeholder that decrypts to nothing: no provider
--     call can succeed with it, which is why the spec does not submit.
--  3. One contact to offboard ("E2E Departing Person").
--  4. One `identity_offboarding` task waiting on plan approval, with its step
--     rows, a pending plan approval and two frozen effect rows — read back
--     through the real GET /ai/operator/tasks/:id by the task-page test. Its
--     wake is a week out, so no coordinator tick touches it during a run.
--
-- The org is the one seed-fixtures.sql uses: the oldest organization that has
-- a site. Idempotent: every insert is keyed on a fixed placeholder id or a
-- unique index and skips on conflict.
--
-- Emits ORG_ID / CONTACT_ID / TASK_ID on stdout for the spec to parse.

\set ON_ERROR_STOP on

SELECT set_config('breeze.scope', 'system', true);

INSERT INTO ai_agents (org_id, partner_id, kind, name, enabled, mode, tool_allowlist, created_by)
SELECT
  NULL,
  p.partner_id,
  'helpdesk',
  'Helpdesk',
  true,
  'shadow',
  '["google_set_vacation", "google_set_forwarding", "google_suspend_user"]'::jsonb,
  u.id
FROM (SELECT DISTINCT partner_id FROM organizations WHERE partner_id IS NOT NULL) p
CROSS JOIN LATERAL (SELECT id FROM users ORDER BY created_at LIMIT 1) u
ON CONFLICT (partner_id, kind) WHERE org_id IS NULL AND disabled_at IS NULL DO UPDATE SET enabled = true;

DO $$
DECLARE
  v_org_id   uuid;
  v_user_id  uuid;
  v_agent_id uuid;
  v_contact  uuid := '0ff0b0a0-0000-4000-8000-0000000000c1';
  v_task     uuid := '0ff0b0a0-0000-4000-8000-0000000000a1';
  v_target   uuid := '0ff0b0a0-0000-4000-8000-0000000000b1';
  v_approval uuid := '0ff0b0a0-0000-4000-8000-0000000000d1';
  v_digest   char(64) := repeat('c', 64);
BEGIN
  SELECT o.id INTO v_org_id
    FROM organizations o
   WHERE EXISTS (SELECT 1 FROM sites s WHERE s.org_id = o.id)
   ORDER BY o.created_at
   LIMIT 1;
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'seed: no organization with a site — run the base seed first';
  END IF;
  SELECT id INTO v_user_id FROM users ORDER BY created_at LIMIT 1;
  SELECT a.id INTO v_agent_id
    FROM ai_agents a JOIN organizations o ON o.partner_id = a.partner_id
   WHERE o.id = v_org_id AND a.kind = 'helpdesk' AND a.org_id IS NULL AND a.disabled_at IS NULL
   LIMIT 1;

  INSERT INTO google_workspace_connections (org_id, customer_domain, admin_email, service_account_email, service_account_key, status, created_by)
  VALUES (v_org_id, 'example.com', 'admin@example.com', 'svc@example.iam.gserviceaccount.com', 'e2e-placeholder-not-a-key', 'active', v_user_id)
  ON CONFLICT (org_id) DO NOTHING;

  INSERT INTO contacts (id, org_id, name, email)
  VALUES (v_contact, v_org_id, 'E2E Departing Person', 'e2e-departing@example.com')
  ON CONFLICT DO NOTHING;

  INSERT INTO ai_operator_tasks (
    id, org_id, agent_id, agent_kind, agent_name, workflow_key, workflow_version, origin_kind,
    requester_user_id, objective, state, phase, wait_reason, current_step_key, revision, next_wake_at, deadline_at
  ) VALUES (
    v_task, v_org_id, v_agent_id, 'helpdesk', 'Helpdesk', 'identity_offboarding', 1, 'manual',
    v_user_id, 'Offboard E2E Departing Person', 'waiting', 'plan', 'approval', 'effects', 1,
    now() + interval '7 days', now() + interval '8 days'
  ) ON CONFLICT (id) DO NOTHING;

  INSERT INTO ai_operator_task_targets (id, org_id, task_id, target_kind, contact_id, target_label, target_ordinal, state)
  VALUES (v_target, v_org_id, v_task, 'contact', v_contact, 'E2E Departing Person', 0, 'active')
  ON CONFLICT DO NOTHING;

  INSERT INTO ai_operator_task_steps (org_id, task_id, step_key, step_kind, attempt_ordinal, state, plan_revision, started_at, settled_at)
  VALUES
    (v_org_id, v_task, 'intake', 'reason', 0, 'succeeded', 1, now() - interval '3 hours', now() - interval '170 minutes'),
    (v_org_id, v_task, 'confirm_identity', 'human_work', 0, 'succeeded', 1, now() - interval '160 minutes', now() - interval '150 minutes'),
    (v_org_id, v_task, 'discover', 'probe', 0, 'succeeded', 1, now() - interval '140 minutes', now() - interval '130 minutes'),
    (v_org_id, v_task, 'review', 'reason', 0, 'succeeded', 1, now() - interval '120 minutes', now() - interval '110 minutes'),
    (v_org_id, v_task, 'effects', 'effect', 0, 'waiting', 1, now() - interval '100 minutes', NULL)
  ON CONFLICT DO NOTHING;

  INSERT INTO ai_operator_plan_approvals (id, org_id, task_id, step_key, plan_revision, effect_set_digest, effect_count, state)
  VALUES (v_approval, v_org_id, v_task, 'effects', 1, v_digest, 2, 'pending')
  ON CONFLICT DO NOTHING;

  INSERT INTO ai_operator_plan_approval_effects (
    org_id, approval_id, task_id, plan_revision, ordinal, tool_name, provider, target_id, account_external_id,
    argument_digest, target_label, principal_label, rendering, idempotency_class
  ) VALUES
    (v_org_id, v_approval, v_task, 1, 0, 'google_set_vacation', 'google', v_target, 'e2e-account-1', v_digest,
     'E2E Departing Person', 'e2e-departing@example.com', 'Set the Gmail auto-reply for e2e-departing@example.com', 'idempotent_by_probe'),
    (v_org_id, v_approval, v_task, 1, 1, 'google_suspend_user', 'google', v_target, 'e2e-account-1', v_digest,
     'E2E Departing Person', 'e2e-departing@example.com', 'Suspend e2e-departing@example.com', 'idempotent')
  ON CONFLICT DO NOTHING;

  RAISE NOTICE 'seeded recipe library fixture for org %', v_org_id;
END $$;

SELECT 'ORG_ID=' || o.id FROM organizations o
 WHERE EXISTS (SELECT 1 FROM sites s WHERE s.org_id = o.id)
 ORDER BY o.created_at LIMIT 1;
SELECT 'CONTACT_ID=0ff0b0a0-0000-4000-8000-0000000000c1';
SELECT 'TASK_ID=0ff0b0a0-0000-4000-8000-0000000000a1';
