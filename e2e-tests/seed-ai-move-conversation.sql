-- E2E fixture for tests/ai-move-conversation.spec.ts (#9840 W5).
--
-- Seeds, for admin@breeze.local (partner-scoped, Default Partner):
--   * ORG_2 — a second organization under the same partner ("E2E Move Org"),
--     so the org chip (Gate B #13) and the other-org deep link (plan T17
--     Step 3 (b)) have something to show. Fixed id, idempotent.
--   * SESSION_A / SESSION_B — two `general` chats in the Default Organization;
--   * SESSION_C — a `general` chat bound to the seeded macOS fixture device
--     (seed-fixtures.sql), for the generic "Device" chip;
--   * SESSION_T — a `topology` investigation on the Default Site (side panel
--     only, D4: never a row in the workspace picker);
--   * SESSION_S / SESSION_M — a `script_builder` and an `mcp` session, which
--     must render in neither list;
--   * SESSION_O — a `general` chat in ORG_2.
-- Every session has a user row and an assistant row. last_activity_at is
-- staggered so the list order is deterministic (A newest).
--
-- Constructed directly: a real turn needs a live model, which the wt-stack has
-- not got (AI keys blanked). Sessions get fresh ids and a fresh tag each run;
-- titles carry the tag so a re-run never collides with a previous run's rows.
-- Run with -v ON_ERROR_STOP=1. Ids are emitted on stdout as KEY=<uuid>.
--
-- Two transactions (one per DO block, each electing system scope inside the
-- block, since set_config(..., true) is transaction-local): the partner-export
-- triggers want the organization written in its own transaction before rows
-- under it (same split as seed-sites-reachability.sql).

-- 1. The second organization.
DO $$
DECLARE
  v_partner  uuid;
  v_currency text;
  v_org_2    uuid := 'e2e98400-0000-4000-8000-000000000002';
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);
  SELECT u.partner_id, o.currency_code INTO v_partner, v_currency
    FROM users u JOIN organizations o ON o.partner_id = u.partner_id AND o.name = 'Default Organization'
   WHERE u.email = 'admin@breeze.local' LIMIT 1;
  IF v_partner IS NULL THEN
    RAISE EXCEPTION 'seed: admin@breeze.local / Default Organization not found — is the stack seeded?';
  END IF;
  INSERT INTO organizations (id, partner_id, name, slug, status, currency_code)
  VALUES (v_org_2, v_partner, 'E2E Move Org', 'e2e-move-org', 'active', v_currency)
  ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, status = 'active';
END $$;

-- 2. The sessions and their messages.
DO $$
DECLARE
  v_user    uuid;
  v_partner uuid;
  v_org_1   uuid;
  v_site_1  uuid;
  v_org_2   uuid := 'e2e98400-0000-4000-8000-000000000002';
  v_device  uuid := '42fc7de0-48f5-48f2-846b-6dd95924baf9';
  v_tag     text := substr(gen_random_uuid()::text, 1, 8);
  v_a uuid := gen_random_uuid();
  v_b uuid := gen_random_uuid();
  v_c uuid := gen_random_uuid();
  v_t uuid := gen_random_uuid();
  v_s uuid := gen_random_uuid();
  v_m uuid := gen_random_uuid();
  v_o uuid := gen_random_uuid();
  r   record;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);
  SELECT id, partner_id INTO v_user, v_partner FROM users WHERE email = 'admin@breeze.local';
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'seed: admin@breeze.local not found — is the stack seeded?';
  END IF;
  SELECT id INTO v_org_1 FROM organizations WHERE partner_id = v_partner AND name = 'Default Organization' LIMIT 1;
  SELECT id INTO v_site_1 FROM sites WHERE org_id = v_org_1 ORDER BY created_at LIMIT 1;
  IF v_org_1 IS NULL OR v_site_1 IS NULL THEN
    RAISE EXCEPTION 'seed: Default Organization or its site not found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM devices WHERE id = v_device AND org_id = v_org_1) THEN
    RAISE EXCEPTION 'seed: fixture device % not found in the Default Organization — run seed-fixtures.sql', v_device;
  END IF;

  FOR r IN
    SELECT * FROM (VALUES
      (v_a, v_org_1, 'general',        'E2E move A ' || v_tag,          NULL::uuid, NULL::uuid, 1),
      (v_b, v_org_1, 'general',        'E2E move B ' || v_tag,          NULL::uuid, NULL::uuid, 2),
      (v_c, v_org_1, 'general',        'E2E move device ' || v_tag,     v_device,   NULL::uuid, 3),
      (v_o, v_org_2, 'general',        'E2E move other-org ' || v_tag,  NULL::uuid, NULL::uuid, 4),
      (v_t, v_org_1, 'topology',       'E2E move topology ' || v_tag,   NULL::uuid, v_site_1,   5),
      (v_s, v_org_1, 'script_builder', 'E2E move script ' || v_tag,     NULL::uuid, NULL::uuid, 6),
      (v_m, v_org_1, 'mcp',            'E2E move mcp ' || v_tag,        NULL::uuid, NULL::uuid, 7)
    ) AS v(id, org_id, type, title, device_id, site_id, age)
  LOOP
    INSERT INTO ai_sessions (id, org_id, user_id, device_id, status, type, title, model, topology_site_id,
                             last_activity_at, created_at, updated_at)
    VALUES (r.id, r.org_id, v_user, r.device_id, 'active', r.type, r.title, 'e2e-mock-model', r.site_id,
            NOW() - make_interval(mins => r.age), NOW() - make_interval(mins => r.age + 10),
            NOW() - make_interval(mins => r.age));
    INSERT INTO ai_messages (session_id, role, content, created_at) VALUES
      (r.id, 'user', 'E2E question for ' || r.title, NOW() - make_interval(mins => r.age + 9)),
      (r.id, 'assistant', 'E2E answer for ' || r.title, NOW() - make_interval(mins => r.age + 8));
  END LOOP;

  -- Emitted on stdout below (RAISE NOTICE goes to stderr).
  CREATE TEMP TABLE e2e_move_out (k text, v text);
  INSERT INTO e2e_move_out VALUES
    ('ORG_2', v_org_2::text), ('TAG', v_tag),
    ('SESSION_A', v_a::text), ('SESSION_B', v_b::text), ('SESSION_C', v_c::text),
    ('SESSION_O', v_o::text), ('SESSION_T', v_t::text), ('SESSION_S', v_s::text),
    ('SESSION_M', v_m::text);
END $$;

SELECT k || '=' || v FROM e2e_move_out;
