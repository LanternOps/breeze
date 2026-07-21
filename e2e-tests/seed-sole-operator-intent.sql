-- E2E fixture: a sole-operator, intent-backed Tier-3 approval.
--
-- Reproduces exactly the DB state createActionIntent's sole-operator branch
-- produces (services/actionIntents/intentService.ts): one action_intents row in
-- pending_approval, plus ONE approval_requests row fanned out to the REQUESTER
-- themselves, carrying the intent's argument digest. That is the only shape in
-- which the web card offers an inline self-approve, and the only shape that
-- trips the decide handler's assurance-level >= 3 self-approve gate
-- (routes/approvals.ts).
--
-- Constructing it directly (rather than driving a live AI chat turn) keeps the
-- test hermetic: no LLM key, no online agent, no 5-minute chat expiry race. The
-- fan-out logic that produces this state is separately proven against real
-- Postgres by intentFanout.integration.test.ts; what this fixture exists to
-- exercise is the part nothing else covers — a real browser WebAuthn assertion
-- clearing the server's L3 gate.
--
-- Emits one row: the approval_requests id to decide.

DO $$
DECLARE
  v_user_id  uuid;
  v_org_id   uuid;
  v_partner  uuid;
  v_intent   uuid;
  v_approval uuid;
  v_digest   char(64) := repeat('a', 64);
BEGIN
  SELECT id INTO v_user_id FROM users WHERE email = 'admin@breeze.local';
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'seed: admin@breeze.local not found — is the stack seeded?';
  END IF;

  SELECT o.id, o.partner_id INTO v_org_id, v_partner
  FROM organizations o
  JOIN organization_users ou ON ou.org_id = o.id
  WHERE ou.user_id = v_user_id
  LIMIT 1;

  IF v_org_id IS NULL THEN
    SELECT id, partner_id INTO v_org_id, v_partner FROM organizations LIMIT 1;
  END IF;
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'seed: no organization found';
  END IF;

  INSERT INTO action_intents (
    org_id, partner_id, requested_by_user_id, source, requesting_client_label,
    action_name, arguments, argument_digest, target_summary, impact_summary,
    reason, risk_tier, idempotency_key, correlation_id, status, expires_at
  ) VALUES (
    v_org_id, v_partner, v_user_id, 'chat', 'Breeze AI',
    'file_operations',
    '{"action":"read","deviceId":"e2e-device","path":"/etc/hostname"}'::jsonb,
    v_digest,
    'Read /etc/hostname on e2e-device',
    'Reads file contents as root/LocalSystem',
    'E2E: inline sole-operator self-approve',
    3,
    'e2e-sole-op-' || gen_random_uuid()::text,
    gen_random_uuid(),
    'pending_approval',
    now() + interval '30 minutes'   -- generous vs the real 5m chat TTL: this
                                    -- test is about the gate, not the reaper
  ) RETURNING id INTO v_intent;

  -- The sole-operator fan-out: ONE row, owned by the requester, digest-bound.
  INSERT INTO approval_requests (
    user_id, requesting_client_label, action_label, action_tool_name,
    action_arguments, risk_tier, risk_summary, status, expires_at,
    intent_id, bound_argument_digest, is_recursive
  ) VALUES (
    v_user_id, 'Breeze AI',
    'Read /etc/hostname on e2e-device', 'file_operations',
    '{"action":"read","deviceId":"e2e-device","path":"/etc/hostname"}'::jsonb,
    'high', 'Reads file contents as root/LocalSystem', 'pending',
    now() + interval '30 minutes',
    v_intent, v_digest, false
  ) RETURNING id INTO v_approval;

  RAISE NOTICE 'APPROVAL_ID=%', v_approval;
  RAISE NOTICE 'INTENT_ID=%', v_intent;
END $$;

-- RAISE NOTICE goes to stderr, which callers using execFileSync don't capture.
-- Re-emit the id on stdout so the spec can parse it from the command's output.
SELECT 'APPROVAL_ID=' || ar.id
FROM approval_requests ar
JOIN action_intents ai ON ai.id = ar.intent_id
WHERE ai.idempotency_key LIKE 'e2e-sole-op-%'
  AND ar.status = 'pending'
ORDER BY ar.created_at DESC
LIMIT 1;
