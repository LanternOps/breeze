-- Command claim: read the device org's partner trust state on the claim
-- transaction's own connection.
--
-- `partitionClaimable` (services/commandClaimEligibility.ts) re-checks partner
-- trust for every queued command while the heartbeat holds its claim
-- transaction. The check used `partnerTrust.repo` readers, each of which runs
-- in a fresh system context — i.e. borrows a SECOND pooled connection while the
-- claim's connection is still held, once per command. With concurrent claims
-- >= pool size every connection is held by a claim waiting for a connection
-- only a peer can release, and postgres-js has no acquire timeout (the #1105
-- double-hold shape).
--
-- The agent's org-scoped context cannot read `partners` directly
-- (`breeze_has_partner_access` is false for it, by design), so this narrow,
-- read-only resolver returns just the two facts the gate needs: the org's
-- partner id and that partner's trust state. Same pattern as
-- breeze_command_requester_is_active (2026-11-05-101500).
--
-- CONTRACT — one row, always:
--   * (partner_id, trust_state) of `target_org_id` when the CALLER's own
--     context has org access to it (breeze_has_org_access, evaluated BEFORE
--     elevation, so it reads the caller's GUCs);
--   * trust_state is NULL when the org's partner row does not exist;
--   * (NULL, NULL) when the caller has no access or the org does not exist.
--     The caller treats a NULL partner as unresolved and fails closed.
--
-- WHY THE IN-BODY save/elevate/restore of `breeze.scope`: `organizations` and
-- `partners` are FORCE ROW LEVEL SECURITY, which binds the function owner too,
-- so SECURITY DEFINER alone is ownership-dependent. A function-attribute
-- `SET "breeze.scope"` is superuser-only (migrationGucAttributes.test.ts), so
-- the sanctioned pattern is the in-body one. The body has exactly one RETURN,
-- immediately preceded by the restore, and no early return; an error aborts the
-- (sub)transaction, which rolls the is_local GUC back with no code running.
-- The elevated region is one SELECT — no writes, no dynamic SQL.
--
-- EXECUTE is revoked from PUBLIC and granted only to breeze_app.
--
-- Idempotent (CREATE OR REPLACE; REVOKE/GRANT are repeatable). Writes no rows,
-- so no migration-level system-scope elevation is needed. No inner BEGIN/COMMIT.

CREATE OR REPLACE FUNCTION public.breeze_org_partner_trust_state(
  target_org_id uuid,
  OUT partner_id uuid,
  OUT trust_state text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  _prev_scope text := current_setting('breeze.scope', true);
  _caller_has_access boolean;
BEGIN
  partner_id := NULL;
  trust_state := NULL;

  -- Evaluated in the CALLER's scope, before elevating.
  _caller_has_access := target_org_id IS NOT NULL
    AND COALESCE(public.breeze_has_org_access(target_org_id), false);

  PERFORM set_config('breeze.scope', 'system', true);

  IF _caller_has_access THEN
    SELECT o.partner_id, p.trust_state::text
      INTO partner_id, trust_state
      FROM public.organizations o
      LEFT JOIN public.partners p ON p.id = o.partner_id
     WHERE o.id = target_org_id;
  END IF;

  PERFORM set_config('breeze.scope', COALESCE(_prev_scope, ''), true);
  RETURN;
END;
$$;

COMMENT ON FUNCTION public.breeze_org_partner_trust_state(uuid) IS
  'Claim-time trust gate: the partner id and partner trust state of target_org_id, iff the caller has org access to it; (NULL, NULL) otherwise. Lets the command claim evaluate partner trust on its own connection instead of opening a second pooled connection per command.';

REVOKE ALL ON FUNCTION public.breeze_org_partner_trust_state(uuid) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'breeze_app') THEN
    GRANT EXECUTE ON FUNCTION public.breeze_org_partner_trust_state(uuid) TO breeze_app;
  END IF;
END $$;
