-- #8184 W02 (#8186): move per-app block/pin rules from configuration-policy
-- patch links (config_policy_feature_links.inline_settings->'apps') onto
-- Update Rings (patch_policies.app_rules, added by 2026-12-17-110000).
--
-- Preserves every policy's effective rules:
--   A. a ring-less link with rules gets its own new ring, named
--      '<policy> — app rules', with auto_approve '{}' (approves nothing) and
--      every other column at its default; the link is relinked to it.
--   B. a ring whose rule-carrying linkers all share one set gets that set.
--   C. a ring shared by linkers with different sets keeps the set of its
--      rule-less linkers if it has any, else the most common set (tie: the
--      set holding the smallest link id). Every other set gets a clone of the
--      ring (all columns copied, name '<ring> — <policy>'), the ring's
--      ring-scoped patch_approvals are copied to the clone, and that set's
--      links are relinked to it.
--   D. a link that points at an invalid ring reference (missing, not a ring,
--      or another partner's ring) is skipped and counted; at read time such a
--      policy now fails closed (ring_reference_invalid).
--
-- The rule list is normalised exactly as the runtime salvage does
-- (normalizeStoredInlineSettingsWithSalvage in services/configPolicyPatching.ts):
-- an entry failing any policyAppRuleSchema check is dropped whole, the FIRST
-- valid entry wins per canonical key (third_party/custom are one bucket,
-- packageId lowercased), and only the first 200 unique valid entries are kept.
-- String lengths are measured in UTF-16 code units, as zod measures them.
-- Keys fold ASCII letters only: PostgreSQL's lower() follows the database
-- locale while JS toLowerCase() does not (e.g. 'İ' and 'i' fold together
-- under a libc en_US locale but not in JS), so a non-ASCII package id cannot
-- be de-duplicated or grouped with certainty. The migration aborts, naming
-- the link, if any rule it would move has one.
--
-- Policy-level auto-approve is NOT converted into rings: the evaluator has not
-- consulted it since 2026-08, so creating an enabled ring from it would start
-- auto-approving patches that are approved manually today. The count of
-- ring-less links with it switched on is reported only.
--
-- The policy-side inline `apps` key is left in place; the W04 contract
-- migration strips it.
--
-- Idempotent without marker keys: links whose resolved ring already carries
-- exactly their normalised rules are dropped from the work set before any
-- write, so a re-run finds nothing to do. A ring that already carries
-- DIFFERENT non-empty rules aborts the migration: nothing wrote ring rules
-- before this release, so that state means a partial or out-of-order apply
-- that must be looked at, and skipping it would silently drop that policy's
-- rules at cutover.
--
-- Every write reports its row count, even when 0, as
-- 'ring_app_rules_backfill <metric>=<n>'.
--
-- patch_policies is partner-axis (no org_id, no device_id): no org cascade /
-- merge / export registration applies to it.
--
-- autoMigrate wraps this file in a transaction — no BEGIN/COMMIT here. Writes
-- under FORCE RLS need the system scope elected first.
SELECT set_config('breeze.scope', 'system', true);

-- Length as zod's .min()/.max() measures it: UTF-16 code units, so a
-- character outside the BMP counts twice.
CREATE OR REPLACE FUNCTION pg_temp.breeze_ring_app_rules_utf16_len(s text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT length(s) + length(regexp_replace(s, '[^\U00010000-\U0010FFFF]', '', 'g'))
$fn$;

-- The salvage normaliser. Returns the kept entries (source, packageId,
-- displayName, action, pinnedVersion — unknown keys stripped, as zod strips
-- them) sorted by canonical key. Anything that is not an array yields [].
-- The canonical key's packageId part: ASCII-only lowercasing, independent of
-- the database locale.
CREATE OR REPLACE FUNCTION pg_temp.breeze_ring_app_rules_fold(s text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT translate(s, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')
$fn$;

CREATE OR REPLACE FUNCTION pg_temp.breeze_ring_app_rules_normalize(raw jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $fn$
  WITH entries AS (
    SELECT e.ord, e.v, 'third_party|' || pg_temp.breeze_ring_app_rules_fold(e.v->>'packageId') AS k
    FROM jsonb_array_elements(
           CASE WHEN jsonb_typeof(raw) = 'array' THEN raw ELSE '[]'::jsonb END
         ) WITH ORDINALITY AS e(v, ord)
    WHERE jsonb_typeof(e.v) = 'object'
      AND jsonb_typeof(e.v->'source') = 'string'
      AND e.v->>'source' IN ('third_party', 'custom')
      AND jsonb_typeof(e.v->'packageId') = 'string'
      AND pg_temp.breeze_ring_app_rules_utf16_len(e.v->>'packageId') BETWEEN 1 AND 256
      AND jsonb_typeof(e.v->'action') = 'string'
      AND e.v->>'action' IN ('block', 'pin')
      AND (NOT (e.v ? 'displayName')
           OR (jsonb_typeof(e.v->'displayName') = 'string'
               AND pg_temp.breeze_ring_app_rules_utf16_len(e.v->>'displayName') <= 255))
      AND (NOT (e.v ? 'pinnedVersion')
           OR (jsonb_typeof(e.v->'pinnedVersion') = 'string'
               AND pg_temp.breeze_ring_app_rules_utf16_len(e.v->>'pinnedVersion') BETWEEN 1 AND 64))
      AND (e.v->>'action' = 'block' OR e.v ? 'pinnedVersion')
  ), first_per_key AS (
    -- The first valid entry wins per canonical key (salvage: seenAppKeys).
    SELECT DISTINCT ON (k) k, ord, v FROM entries ORDER BY k, ord
  ), capped AS (
    -- The first 200 unique valid entries in document order.
    SELECT k, v FROM first_per_key ORDER BY ord LIMIT 200
  )
  SELECT COALESCE(
    jsonb_agg(
      jsonb_strip_nulls(jsonb_build_object(
        'source', v->>'source',
        'packageId', v->>'packageId',
        'displayName', v->>'displayName',
        'action', v->>'action',
        'pinnedVersion', v->>'pinnedVersion'
      ))
      ORDER BY k
    ),
    '[]'::jsonb
  )
  FROM capped
$fn$;

-- The enforced meaning of a rule list, for equality: [canonical key, action,
-- pinned version for pins], sorted. Display names and a block's stray version
-- do not change what is enforced.
CREATE OR REPLACE FUNCTION pg_temp.breeze_ring_app_rules_key(raw jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_array(
        'third_party|' || pg_temp.breeze_ring_app_rules_fold(r->>'packageId'),
        r->>'action',
        CASE WHEN r->>'action' = 'pin' THEN r->>'pinnedVersion' END
      )
      ORDER BY 'third_party|' || pg_temp.breeze_ring_app_rules_fold(r->>'packageId')
    ),
    '[]'::jsonb
  )
  FROM jsonb_array_elements(pg_temp.breeze_ring_app_rules_normalize(raw)) AS r
$fn$;

DO $$
DECLARE
  n bigint;
  total bigint;
  total_links bigint;
  g record;
  new_ring uuid;
  bad_ring uuid;
  bad_link uuid;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);

  -- Every authored patch link, with its normalised rules and whether its ring
  -- reference resolves exactly as resolvePatchPolicyReference does: a 'ring'
  -- row owned by the policy's partner (the policy's own partner_id, else its
  -- org's partner).
  DROP TABLE IF EXISTS pg_temp.breeze_ring_app_rules_all_links;
  CREATE TEMP TABLE breeze_ring_app_rules_all_links ON COMMIT DROP AS
  SELECT l.id AS link_id,
         cp.name AS policy_name,
         COALESCE(cp.partner_id, o.partner_id) AS partner_id,
         l.feature_policy_id AS ring_ref,
         pg_temp.breeze_ring_app_rules_normalize(l.inline_settings->'apps') AS apps,
         pg_temp.breeze_ring_app_rules_key(l.inline_settings->'apps') AS apps_key,
         (p.id IS NOT NULL) AS ring_valid
  FROM config_policy_feature_links l
  JOIN configuration_policies cp ON cp.id = l.config_policy_id
  LEFT JOIN organizations o ON o.id = cp.org_id
  LEFT JOIN patch_policies p
    ON p.id = l.feature_policy_id
   AND p.kind = 'ring'
   AND p.partner_id = COALESCE(cp.partner_id, o.partner_id)
  WHERE l.feature_type = 'patch';

  -- ---- Step 0: the work set -------------------------------------------------
  SELECT count(*) INTO n FROM pg_temp.breeze_ring_app_rules_all_links
  WHERE apps <> '[]'::jsonb AND partner_id IS NULL;
  RAISE WARNING 'ring_app_rules_backfill links_skipped_no_partner=%', n;

  SELECT count(*) INTO n FROM pg_temp.breeze_ring_app_rules_all_links
  WHERE apps <> '[]'::jsonb AND partner_id IS NOT NULL AND ring_ref IS NOT NULL AND NOT ring_valid;
  RAISE WARNING 'ring_app_rules_backfill links_skipped_invalid_ring_reference=%', n;

  DROP TABLE IF EXISTS pg_temp.breeze_ring_app_rules_work;
  CREATE TEMP TABLE breeze_ring_app_rules_work ON COMMIT DROP AS
  SELECT * FROM pg_temp.breeze_ring_app_rules_all_links
  WHERE apps <> '[]'::jsonb
    AND partner_id IS NOT NULL
    AND (ring_ref IS NULL OR ring_valid);

  -- A non-ASCII package id: the runtime's JS key and this file's key could
  -- disagree on which rules are duplicates (see the header). Stop, loudly.
  SELECT w.link_id INTO bad_link
  FROM pg_temp.breeze_ring_app_rules_work w
  CROSS JOIN LATERAL jsonb_array_elements(w.apps) AS r
  WHERE octet_length(r->>'packageId') <> length(r->>'packageId')
  ORDER BY w.link_id
  LIMIT 1;
  IF bad_link IS NOT NULL THEN
    RAISE EXCEPTION 'ring_app_rules_backfill: configuration policy feature link % has an application rule with a non-ASCII package id; edit that rule and re-run (refusing to guess how it de-duplicates)', bad_link;
  END IF;

  -- Idempotency filter: a link whose ring already enforces exactly its rules
  -- needs nothing.
  DELETE FROM pg_temp.breeze_ring_app_rules_work w
  USING patch_policies p
  WHERE w.ring_valid
    AND p.id = w.ring_ref
    AND pg_temp.breeze_ring_app_rules_key(p.app_rules) = w.apps_key;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE WARNING 'ring_app_rules_backfill links_already_carried_by_ring=%', n;

  SELECT w.ring_ref INTO bad_ring
  FROM pg_temp.breeze_ring_app_rules_work w
  JOIN patch_policies p ON p.id = w.ring_ref
  WHERE w.ring_valid AND p.app_rules <> '[]'::jsonb
  ORDER BY w.ring_ref
  LIMIT 1;
  IF bad_ring IS NOT NULL THEN
    RAISE EXCEPTION 'ring_app_rules_backfill: update ring % already carries application rules that differ from a linked policy''s; refusing to continue (a skip would drop that policy''s rules)', bad_ring;
  END IF;

  -- ---- Step 1: case A — ring-less links get their own ring ----------------------
  total := 0;
  total_links := 0;
  FOR g IN
    SELECT * FROM pg_temp.breeze_ring_app_rules_work WHERE ring_ref IS NULL ORDER BY link_id
  LOOP
    INSERT INTO patch_policies (partner_id, kind, name, auto_approve, app_rules)
    VALUES (g.partner_id, 'ring', left(g.policy_name || ' — app rules', 255), '{}'::jsonb, g.apps)
    RETURNING id INTO new_ring;
    total := total + 1;

    UPDATE config_policy_feature_links
       SET feature_policy_id = new_ring, updated_at = now()
     WHERE id = g.link_id;
    GET DIAGNOSTICS n = ROW_COUNT;
    total_links := total_links + n;
  END LOOP;
  RAISE WARNING 'ring_app_rules_backfill rings_created_for_ringless_links=%', total;
  RAISE WARNING 'ring_app_rules_backfill ringless_links_relinked=%', total_links;

  -- ---- Step 2: cases B/C — rings referenced by remaining links ------------------
  -- Group EVERY valid linker of each such ring by its rule set (a linker with
  -- no rules, or only invalid ones, carries '[]'). Invalid-reference links are
  -- excluded: they never resolve to this ring.
  DROP TABLE IF EXISTS pg_temp.breeze_ring_app_rules_groups;
  CREATE TEMP TABLE breeze_ring_app_rules_groups ON COMMIT DROP AS
  SELECT a.ring_ref AS ring_id,
         a.apps_key,
         (array_agg(a.apps ORDER BY a.link_id))[1] AS apps,
         count(*) AS linkers,
         min(a.link_id::text) AS min_link,
         (array_agg(a.policy_name ORDER BY a.link_id))[1] AS policy_name,
         array_agg(a.link_id ORDER BY a.link_id) AS link_ids
  FROM pg_temp.breeze_ring_app_rules_all_links a
  WHERE a.ring_valid
    AND a.ring_ref IN (
      SELECT DISTINCT ring_ref FROM pg_temp.breeze_ring_app_rules_work WHERE ring_ref IS NOT NULL
    )
  GROUP BY a.ring_ref, a.apps_key;

  -- The set each ring keeps: its rule-less linkers' (so they are unaffected),
  -- else the most common set, tie broken by the smallest link id.
  DROP TABLE IF EXISTS pg_temp.breeze_ring_app_rules_keep;
  CREATE TEMP TABLE breeze_ring_app_rules_keep ON COMMIT DROP AS
  SELECT DISTINCT ON (ring_id) ring_id, apps_key, apps
  FROM pg_temp.breeze_ring_app_rules_groups
  ORDER BY ring_id, (apps_key = '[]'::jsonb) DESC, linkers DESC, min_link ASC;

  UPDATE patch_policies p
     SET app_rules = k.apps, updated_at = now()
    FROM pg_temp.breeze_ring_app_rules_keep k
   WHERE p.id = k.ring_id
     AND k.apps_key <> '[]'::jsonb
     AND p.app_rules = '[]'::jsonb;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE WARNING 'ring_app_rules_backfill shared_rings_rules_set=%', n;

  -- ---- Step 3: case C — a clone per other set ------------------------------------
  total := 0;
  total_links := 0;
  DECLARE
    approvals_copied bigint := 0;
  BEGIN
    FOR g IN
      SELECT gr.*
      FROM pg_temp.breeze_ring_app_rules_groups gr
      JOIN pg_temp.breeze_ring_app_rules_keep k ON k.ring_id = gr.ring_id
      WHERE gr.apps_key <> k.apps_key
      ORDER BY gr.ring_id, gr.min_link
    LOOP
      -- Every column of patch_policies except id, name, app_rules and the
      -- timestamps, named explicitly. The clone is named after the policy of
      -- the group's first link (uuid order — collation-independent).
      INSERT INTO patch_policies (
        partner_id, kind, name, description, enabled, targets, auto_approve,
        schedule, reboot_policy, rollback_on_failure, pre_install_script_id,
        post_install_script_id, notify_on_complete, ring_order, deferral_days,
        deadline_days, grace_period_hours, categories, exclude_categories,
        category_rules, app_rules, created_by
      )
      SELECT partner_id, kind, left(name || ' — ' || g.policy_name, 255), description, enabled,
             targets, auto_approve, schedule, reboot_policy, rollback_on_failure,
             pre_install_script_id, post_install_script_id, notify_on_complete, ring_order,
             deferral_days, deadline_days, grace_period_hours, categories, exclude_categories,
             category_rules, g.apps, created_by
      FROM patch_policies
      WHERE id = g.ring_id
      RETURNING id INTO new_ring;
      total := total + 1;

      -- The source ring's ring-scoped approvals keep applying to the policies
      -- that move to the clone. Partner-wide (ring_id NULL) approvals already
      -- apply under every ring. The unique index is an expression index, so
      -- the conflict target is left implicit.
      INSERT INTO patch_approvals (
        partner_id, patch_id, policy_id, ring_id, status, approved_by,
        approved_at, defer_until, notes
      )
      SELECT partner_id, patch_id, policy_id, new_ring, status, approved_by,
             approved_at, defer_until, notes
      FROM patch_approvals
      WHERE ring_id = g.ring_id
      ON CONFLICT DO NOTHING;
      GET DIAGNOSTICS n = ROW_COUNT;
      approvals_copied := approvals_copied + n;

      UPDATE config_policy_feature_links
         SET feature_policy_id = new_ring, updated_at = now()
       WHERE id = ANY (g.link_ids);
      GET DIAGNOSTICS n = ROW_COUNT;
      total_links := total_links + n;
    END LOOP;
    RAISE WARNING 'ring_app_rules_backfill clone_rings_created=%', total;
    RAISE WARNING 'ring_app_rules_backfill clone_approvals_copied=%', approvals_copied;
    RAISE WARNING 'ring_app_rules_backfill clone_links_relinked=%', total_links;
  END;

  -- ---- Step 4: report ring-less links with policy auto-approve switched on -------
  -- Informational only (release notes): they are not converted.
  SELECT count(*) INTO n
  FROM config_policy_feature_links l
  LEFT JOIN config_policy_patch_settings s ON s.feature_link_id = l.id
  WHERE l.feature_type = 'patch'
    AND l.feature_policy_id IS NULL
    AND (s.auto_approve IS TRUE OR l.inline_settings->'autoApprove' = 'true'::jsonb);
  RAISE WARNING 'ring_app_rules_backfill ringless_links_with_policy_auto_approve=%', n;
END $$;
