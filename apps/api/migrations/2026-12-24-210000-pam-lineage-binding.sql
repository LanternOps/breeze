-- PAM ownership epochs W3 (#8205, feature #8202): lineage binding.
--
-- `breeze_pam_epoch_binding` replaces the RLS-scoped live-org join that the
-- reconciliation resolver (services/pamReconciliationBinding.ts) used to run
-- inline. Ownership of an actuation is now proven through the device's epoch
-- lineage — `(device_id, actuation.org_id, actuation.device_epoch)` must be a
-- `device_ownership_epochs` row — instead of `actuation.org_id = devices.org_id`
-- (spec docs/superpowers/specs/pam/2026-10-06-pam-ownership-epoch-design.md
-- §6.1, §6.2).
--
-- Dispositions:
--   * an actuation from an EARLIER epoch of this device: `retired` when it is
--     closed (pam_actuation_is_closed) or a retirement marker exists for it,
--     otherwise `unresolved`;
--   * no actuation row any more (the source org was erased) but a retirement
--     marker exists for (device, actuation): `retired`;
--   * current epoch: byte-identical to the previous inline resolver
--     (`bound` / `duplicate` / `stale` / `unresolved`).
-- The caller maps `retired` to `stale` for protocol v1 agents.
--
-- Authority, in two phases:
--   1. Under the CALLER's scope: the live device row must match
--      (id, agent_id) AND the caller's context must have access to the device's
--      live org (explicit breeze_has_org_access — not left to RLS, which a
--      superuser/BYPASSRLS owner would skip). Otherwise every candidate is
--      `unresolved`.
--   2. Elevated to system scope for the classification: the historical epoch's
--      rows belong to another org (hidden by RLS) and pam_ledger_retirements is
--      system-only. The scope is restored before RETURN, same pattern as
--      breeze_device_ownership_epoch_advance (2026-12-17-130000); an error
--      aborts the statement, which rolls the set_config back. A function-level
--      SET "breeze.scope" attribute is not usable (needs superuser in prod).
--
-- The function returns only ordinal, observation_id (echoed from the input),
-- status and command_id — never evidence or org ids — so it adds no read
-- surface. EXECUTE goes to breeze_app only.
--
-- No row writes. Idempotent (CREATE OR REPLACE + REVOKE/GRANT).

SELECT set_config('breeze.scope', 'system', true);

CREATE OR REPLACE FUNCTION public.breeze_pam_epoch_binding(
  p_agent_id text,
  p_device_id uuid,
  p_candidates jsonb
)
RETURNS TABLE(ordinal integer, observation_id uuid, status text, command_id uuid)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  _prev_scope text := current_setting('breeze.scope', true);
  _device_id uuid;
  _device_epoch integer;
BEGIN
  -- Phase 1: the caller's own scope decides whether this device is theirs.
  SELECT d.id, d.ownership_epoch
    INTO _device_id, _device_epoch
    FROM public.devices d
   WHERE d.id = p_device_id
     AND d.agent_id = p_agent_id
     AND public.breeze_has_org_access(d.org_id);

  IF _device_id IS NULL THEN
    RETURN QUERY
      SELECT c.ordinal, c.observation_id::uuid, 'unresolved'::text, NULL::uuid
        FROM jsonb_to_recordset(p_candidates) AS c(
          ordinal integer, observation_id text, actuation_id text, generation integer)
       ORDER BY c.ordinal;
    RETURN;
  END IF;

  -- Phase 2: classify across the device's lineage.
  PERFORM set_config('breeze.scope', 'system', true);

  RETURN QUERY
    WITH candidates AS (
      SELECT c.ordinal,
             c.observation_id::uuid AS observation_id,
             c.actuation_id::uuid AS actuation_id,
             c.generation
        FROM jsonb_to_recordset(p_candidates) AS c(
          ordinal integer, observation_id text, actuation_id text, generation integer)
    ),
    owned_actuations AS MATERIALIZED (
      SELECT candidate.ordinal,
             candidate.observation_id,
             candidate.actuation_id,
             candidate.generation,
             actuation.id AS owned_actuation_id,
             actuation.org_id AS owned_org_id,
             actuation.device_epoch AS owned_device_epoch,
             actuation.generation AS current_generation,
             actuation.desired_state,
             actuation.current_command_id,
             CASE WHEN actuation.id IS NULL THEN false
                  ELSE COALESCE(public.pam_actuation_is_closed(actuation), false)
             END AS actuation_closed,
             EXISTS (
               SELECT 1 FROM public.pam_ledger_retirements marker
                WHERE marker.device_id = _device_id
                  AND marker.actuation_id = candidate.actuation_id
             ) AS retirement_marker
        FROM candidates candidate
        LEFT JOIN public.pam_actuations actuation
          ON actuation.id = candidate.actuation_id
         AND actuation.device_id = _device_id
         AND EXISTS (
           SELECT 1 FROM public.device_ownership_epochs lineage
            WHERE lineage.device_id = _device_id
              AND lineage.org_id = actuation.org_id
              AND lineage.epoch = actuation.device_epoch
         )
    ),
    classified AS (
      SELECT owned.*,
             observation.id AS existing_observation_id,
             command.id AS verified_command_id,
             command.type AS command_type,
             command.target_role AS command_target_role
        FROM owned_actuations owned
        LEFT JOIN public.pam_actuation_results observation
          ON owned.current_generation IS NOT NULL
         AND owned.current_generation = owned.generation
         AND observation.actuation_id = owned.actuation_id
         AND observation.device_id = _device_id
         AND observation.org_id = owned.owned_org_id
         AND observation.generation = owned.generation
         AND observation.observation_id = owned.observation_id
        LEFT JOIN public.device_commands command
          ON command.id = owned.current_command_id
         AND command.device_id = _device_id
    ),
    dispositions AS (
      SELECT classified.ordinal,
             classified.observation_id,
             classified.verified_command_id,
             CASE
               WHEN classified.owned_actuation_id IS NOT NULL
                AND classified.owned_device_epoch < _device_epoch THEN
                 CASE WHEN classified.actuation_closed OR classified.retirement_marker
                      THEN 'retired' ELSE 'unresolved' END
               WHEN classified.owned_actuation_id IS NULL
                AND classified.retirement_marker THEN 'retired'
               WHEN classified.current_generation IS NULL THEN 'unresolved'
               WHEN classified.generation < classified.current_generation THEN 'stale'
               WHEN classified.generation > classified.current_generation THEN 'unresolved'
               WHEN classified.existing_observation_id IS NOT NULL THEN 'duplicate'
               WHEN classified.current_command_id IS NULL
                 OR classified.verified_command_id IS NULL THEN 'unresolved'
               WHEN classified.command_target_role <> 'agent' THEN 'unresolved'
               WHEN classified.desired_state = 'active'
                AND classified.command_type = 'pam_apply_v2' THEN 'bound'
               WHEN classified.desired_state = 'cleanup'
                AND classified.command_type = 'pam_cleanup_v2' THEN 'bound'
               ELSE 'unresolved'
             END AS disposition
        FROM classified
    )
    SELECT dispositions.ordinal,
           dispositions.observation_id,
           dispositions.disposition,
           CASE WHEN dispositions.disposition = 'bound'
                THEN dispositions.verified_command_id
                ELSE NULL::uuid
           END
      FROM dispositions
     ORDER BY dispositions.ordinal;

  PERFORM set_config('breeze.scope', COALESCE(_prev_scope, ''), true);
  RETURN;
END;
$$;

REVOKE ALL ON FUNCTION public.breeze_pam_epoch_binding(text, uuid, jsonb) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'breeze_app') THEN
    GRANT EXECUTE ON FUNCTION public.breeze_pam_epoch_binding(text, uuid, jsonb) TO breeze_app;
  END IF;
END $$;
