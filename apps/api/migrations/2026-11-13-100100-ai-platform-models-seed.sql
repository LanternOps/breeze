-- AI model registry W01 (#7599): seed ai_platform_models from the constants
-- W00 (#7593) shipped: aiCostTracker.ts MODEL_PRICING (prices) and
-- aiOfferableModels.ts OFFERABLE_AI_MODELS (platform_offered). A fresh
-- self-host therefore prices and offers exactly what it did before W01,
-- even if discovery never runs (no key, or a gateway ANTHROPIC_BASE_URL).
--
-- capabilities: a stand-in Models API tree per model, so thinking/effort
-- derivation works before the first sync. The first successful sync
-- replaces it with the real tree (last_seen_at stays NULL until then).
-- cache_read = MODEL_PRICING.cacheReadPerMillion, or input x 0.1;
-- cache_write = input x 1.25 (aiCostTracker CACHE_*_INPUT_MULTIPLIER).
-- option_support per spec §7: 'updates' on Fable 5.1 / Opus 5.5 / Sonnet 5.5,
-- 'fast' on Opus 5.5 and Opus 4.8. inferenceGeo stays [] until the W01 spike
-- (findings D3) confirms values. option_rates stays NULL: the operator
-- enters fast-mode rates; nothing is billed at a guessed rate (§15 #3, #7).
-- operator_notified_at = now(): seeded ids are not "new models" to alert on.
--
-- WRITES ROWS: system scope is elected first (FORCE RLS is irrelevant to this
-- table, but the repo rule and migrationRlsScope.test.ts apply to every
-- writing migration). Idempotent: ON CONFLICT (model_id) DO NOTHING never
-- overwrites operator edits. The inserted count is reported.
DO $$
DECLARE
  caps_adaptive_full jsonb := '{"thinking":{"supported":true,"types":{"adaptive":{"supported":true},"enabled":{"supported":false}}},"effort":{"supported":true,"low":{"supported":true},"medium":{"supported":true},"high":{"supported":true},"xhigh":{"supported":true},"max":{"supported":true}},"image_input":{"supported":true}}';
  caps_adaptive_no_xhigh jsonb := '{"thinking":{"supported":true,"types":{"adaptive":{"supported":true},"enabled":{"supported":true}}},"effort":{"supported":true,"low":{"supported":true},"medium":{"supported":true},"high":{"supported":true},"xhigh":{"supported":false},"max":{"supported":true}},"image_input":{"supported":true}}';
  caps_budget_only jsonb := '{"thinking":{"supported":true,"types":{"adaptive":{"supported":false},"enabled":{"supported":true}}},"effort":{"supported":false,"low":{"supported":false},"medium":{"supported":false},"high":{"supported":false},"xhigh":{"supported":false},"max":{"supported":false}},"image_input":{"supported":true}}';
  support_updates jsonb := '{"effort":["low","medium","high","xhigh","max"],"thinkingDisplay":["omitted","summarized","updates"],"speed":["standard"],"inferenceGeo":[]}';
  support_updates_fast jsonb := '{"effort":["low","medium","high","xhigh","max"],"thinkingDisplay":["omitted","summarized","updates"],"speed":["standard","fast"],"inferenceGeo":[]}';
  support_full_fast jsonb := '{"effort":["low","medium","high","xhigh","max"],"thinkingDisplay":["omitted","summarized"],"speed":["standard","fast"],"inferenceGeo":[]}';
  support_full jsonb := '{"effort":["low","medium","high","xhigh","max"],"thinkingDisplay":["omitted","summarized"],"speed":["standard"],"inferenceGeo":[]}';
  support_no_xhigh jsonb := '{"effort":["low","medium","high","max"],"thinkingDisplay":["omitted","summarized"],"speed":["standard"],"inferenceGeo":[]}';
  support_budget jsonb := '{"effort":[],"thinkingDisplay":["omitted","summarized"],"speed":["standard"],"inferenceGeo":[]}';
  n integer;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);

  INSERT INTO ai_platform_models (
    provider, model_id, display_name, max_input_tokens, max_output_tokens, capabilities,
    input_cents_per_m, output_cents_per_m, cache_read_cents_per_m, cache_write_cents_per_m,
    option_support, prompt_profile, platform_offered, is_platform_default, lifecycle, operator_notified_at
  ) VALUES
    ('anthropic', 'claude-sonnet-5-5', 'Claude Sonnet 5.5', 1000000, 128000, caps_adaptive_full, 200, 1000, 20, 250, support_updates, 'claude-standard', true, true, 'available', now()),
    ('anthropic', 'claude-opus-5-5', 'Claude Opus 5.5', 1000000, 128000, caps_adaptive_full, 400, 2000, 20, 500, support_updates_fast, 'claude-frontier', true, false, 'available', now()),
    ('anthropic', 'claude-fable-5-1', 'Claude Fable 5.1', 1000000, 128000, caps_adaptive_full, 1000, 5000, 25, 1250, support_updates, 'claude-frontier', true, false, 'available', now()),
    ('anthropic', 'claude-opus-4-8', 'Claude Opus 4.8', 1000000, 128000, caps_adaptive_full, 500, 2500, 50, 625, support_full_fast, 'claude-standard', true, false, 'available', now()),
    ('anthropic', 'claude-sonnet-4-6', 'Claude Sonnet 4.6', 1000000, 128000, caps_adaptive_no_xhigh, 300, 1500, 30, 375, support_no_xhigh, 'claude-standard', true, false, 'available', now()),
    ('anthropic', 'claude-haiku-4-5', 'Claude Haiku 4.5', 200000, 64000, caps_budget_only, 100, 500, 10, 125, support_budget, 'claude-small', true, false, 'available', now()),
    ('anthropic', 'claude-haiku-4-5-20251001', 'Claude Haiku 4.5 (2025-10-01)', 200000, 64000, caps_budget_only, 100, 500, 10, 125, support_budget, 'claude-small', false, false, 'available', now()),
    ('anthropic', 'claude-fable-5', 'Claude Fable 5', 1000000, 128000, caps_adaptive_full, 1000, 5000, 100, 1250, support_full, 'claude-frontier', true, false, 'available', now()),
    ('anthropic', 'claude-sonnet-4-5', 'Claude Sonnet 4.5', 200000, 64000, caps_budget_only, 300, 1500, 30, 375, support_budget, 'claude-standard', false, false, 'available', now()),
    ('anthropic', 'claude-sonnet-4-5-20250929', 'Claude Sonnet 4.5 (2025-09-29)', 200000, 64000, caps_budget_only, 300, 1500, 30, 375, support_budget, 'claude-standard', false, false, 'available', now())
  ON CONFLICT (model_id) DO NOTHING;

  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'ai_platform_models: seeded % platform model row(s)', n;
END $$;
