-- Dedicated agreements:send permission (#9075 W2a; spec
-- docs/superpowers/specs/billing/2026-10-15-standalone-agreement-signing-spec.md
-- §7 OD7 B). Sending an agreement for signature, copying its signing link,
-- voiding it, reminding, and recording a client's signature obtained elsewhere
-- are a different blast radius from authoring templates: quotes separate
-- quotes:send / quotes:accept from quotes:write for the same reason.
--
-- THE GUARD FLIPS IN THE SAME PR. routes/contracts/agreementRequests.ts moves
-- POST /record-signed from agreements:write to agreements:send with NO
-- transitional `write OR send` check, so the back-fill below is the ONLY thing
-- between an upgrade and a 403 on record-signed for every role that can use it
-- today. It has to be exhaustive.
--
-- Same shape and reasoning as 2026-10-16-190000-agreements-permission.sql
-- (read its header): this grants NO new authority. It re-issues, under a new
-- name, a capability a role already holds (agreements:write gated
-- record-signed until now), so it matches on the EXISTING GRANT, never on the
-- role's name, and sweeps system role templates, per-partner is_system clones
-- AND custom (is_system = FALSE) roles alike. A custom role cannot be forged
-- into extra privilege here, because the predicate IS the privilege it already
-- has. Mapping is action-for-action: agreements:write -> agreements:send.
-- agreements:read alone confers nothing.
--
-- WILDCARDS NEED NO BACK-FILL: grant matching is per-axis
-- (services/permissionMatching.ts), so a '*:*' row (the seeded Partner Admin)
-- already satisfies agreements:send. A resource-wildcard ('agreements','*')
-- row does not exist in DEFAULT_PERMISSIONS and routes/roles.ts rejects any
-- wildcard on a custom role; the defensive source below covers one anyway and
-- reports loudly if it ever fires.
--
-- Idempotent: safe to re-run. `permissions` has NO unique (resource, action)
-- constraint, so the row insert uses an explicit existence check (never ON
-- CONFLICT), and the back-fill matches EVERY agreements:write row rather than
-- one id — a role linked to a duplicate row must not be missed.
-- `role_permissions` is PK (role_id, permission_id), so the grant uses
-- SELECT DISTINCT + NOT EXISTS.
--
-- Every write in this file runs under system scope (issue #4518): one
-- set_config at the top covers the whole file — is_local = true scopes it to
-- autoMigrate's per-file transaction.
SELECT set_config('breeze.scope', 'system', true);

-- ============================================
-- 1. The permission row
-- ============================================
-- The description MUST stay byte-identical to DEFAULT_PERMISSIONS in
-- apps/api/src/db/seed.ts (seed.test.ts asserts it): a fresh install seeds
-- from there, an upgrade from here.
DO $$
DECLARE
  n integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM permissions WHERE resource = 'agreements' AND action = 'send'
  ) THEN
    INSERT INTO permissions (resource, action, description)
    VALUES ('agreements', 'send', 'Send agreements for signature, copy signing links, void requests, and record agreements signed elsewhere');
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 THEN
      RAISE WARNING 'seeded agreements:send permission row';
    END IF;
  END IF;
END $$;

-- ============================================
-- 2. No-regression back-fill: agreements:write -> agreements:send
-- ============================================
DO $$
DECLARE
  n integer;
  v_send_id uuid;
BEGIN
  -- The ONE send row every grant points at (section 1 guarantees it exists;
  -- ORDER BY id makes a hypothetical duplicate resolve deterministically).
  SELECT id INTO v_send_id FROM permissions
  WHERE resource = 'agreements' AND action = 'send' ORDER BY id LIMIT 1;

  -- Defensive: a resource-wildcard row. Expected absent on every real database.
  IF EXISTS (SELECT 1 FROM permissions WHERE resource = 'agreements' AND action = '*') THEN
    RAISE WARNING 'unexpected agreements:* wildcard permission row present — including it in the agreements:send back-fill';
  END IF;

  INSERT INTO role_permissions (role_id, permission_id)
  SELECT DISTINCT rp.role_id, v_send_id
  FROM role_permissions rp
  WHERE rp.permission_id IN (
      SELECT p.id FROM permissions p
      WHERE p.resource = 'agreements' AND p.action IN ('write', '*')
    )
    AND v_send_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM role_permissions existing
      WHERE existing.role_id = rp.role_id AND existing.permission_id = v_send_id
    );
  GET DIAGNOSTICS n = ROW_COUNT;
  -- Always report, including 0: a 0 on a fresh install is expected, not
  -- evidence the INSERT silently no-op'd under RLS.
  RAISE WARNING 'granted agreements:send to % role(s) holding agreements:write', n;
END $$;

-- ============================================
-- 3. Re-run of the W1b evidence back-fill (#8865 W1b "rolling-deploy evidence
--    gap"): a quote accept handled by an API instance still on the pre-W1b
--    image after 2026-12-31-210000-agreement-requests.sql ran filed a
--    contract_documents row with NULL evidence. Copied VERBATIM from section 5
--    of that migration — idempotent (`cd.signed_at IS NULL`) and it only fills
--    NULL evidence from a still-resolvable quote_acceptances row; request-
--    sourced rows have quote_acceptance_id NULL and are never touched.
-- ============================================
-- 5. Back-fill the evidence snapshot from quote_acceptances for every row whose
--    acceptance still resolves. A row whose quote_acceptance_id is already NULL
--    (quote deleted earlier) keeps NULL evidence — nothing is invented.
--    `cd.signed_at IS NULL` makes a replay a no-op. quote_acceptances.signed_at
--    is a naive UTC timestamp; AT TIME ZONE 'UTC' makes it the matching
--    timestamptz.
-- ---------------------------------------------------------------------------
DO $$
DECLARE n integer;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);
  UPDATE contract_documents cd
     SET signer_name = qa.signer_name,
         signer_email = qa.signer_email,
         signed_at = qa.signed_at AT TIME ZONE 'UTC',
         signer_ip = qa.ip_address,
         signer_user_agent = qa.user_agent,
         acceptance_origin = qa.origin,
         acceptance_method = qa.method,
         acceptance_reference = qa.reference,
         recorded_by_user_id = qa.recorded_by_user_id,
         content_sha256 = qa.quote_sha256,
         content_hash_version = qa.hash_version,
         -- Effective locale the hash was computed with: NULL on a pre-#3777
         -- acceptance means 'en' (quoteAcceptanceVerify.acceptanceRenderLocale).
         acceptance_render_locale = COALESCE(qa.render_locale, 'en')
    FROM quote_acceptances qa
   WHERE cd.quote_acceptance_id = qa.id
     AND cd.signed_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN
    RAISE WARNING 'backfilled signer evidence onto % contract_documents rows', n;
  END IF;
END $$;
