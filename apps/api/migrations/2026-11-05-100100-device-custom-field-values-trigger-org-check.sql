-- 2026-11-05-100100-device-custom-field-values-trigger-org-check.sql
--
-- Coherence check: the BEFORE ROW trigger on device_custom_field_values now
-- checks that the row's DEVICE belongs to the row's org, in addition to the
-- existing check that the row's DEFINITION belongs to its org/partner. The
-- composite FK (device_id, org_id) -> devices(id, org_id) is DEFERRABLE
-- INITIALLY DEFERRED (deliberately, so the org-move re-home path below can
-- point a value at the target org before the device row itself has flipped),
-- so it is only evaluated at COMMIT, and only against rows still present then.
-- A row inserted and deleted within one transaction is never evaluated by it,
-- although the INSERT's other effects (the device updated_at bump and the
-- UPDATE triggers it fires, in system scope) have already happened.
--
-- The trigger therefore checks EXISTS(devices WHERE id = NEW.device_id AND
-- org_id = NEW.org_id) itself. Like the definition check beside it, a BEFORE
-- ROW trigger runs before any constraint, deferred or not, so every row
-- written is checked regardless of what happens to it later in the
-- transaction.
--
-- THE RE-HOME EXCEPTION IS KEYED ON THE EXECUTING ROLE, NOT A SESSION SETTING.
-- breeze_rehome_device_custom_field_values() deliberately writes org_id =
-- TARGET org onto a value row before the device row has moved (that ordering
-- is what lets the composite device FK stay correctly DEFERRED rather than
-- forcing a fragile same-statement dance with the devices UPDATE) — at the
-- moment its UPDATE runs, NEW.device_id's row in `devices` still shows the
-- SOURCE org, so a bare EXISTS check would reject the very re-home the
-- deferred FK was designed to allow. A session GUC cannot mark that
-- exception: every `breeze_app` session can set any custom GUC on itself
-- with `set_config(..., true)`, so the value would carry no information about
-- which code path issued the write.
--
-- Instead: breeze_rehome_device_custom_field_values() is SECURITY DEFINER,
-- and the coherence trigger is now SECURITY INVOKER (not SECURITY DEFINER —
-- that is the load-bearing change). Postgres genuinely changes `current_user`
-- to a SECURITY DEFINER function's owner for the duration of its execution,
-- including for statements that function issues and any trigger those
-- statements fire, as long as that trigger does not itself re-elevate via its
-- own SECURITY DEFINER (which would reset `current_user` back to the
-- trigger's own owner and erase the distinction — the reason this trigger's
-- own SECURITY DEFINER had to be dropped, not just the rehome function's
-- flagged). `breeze_app` holds EXECUTE on the rehome function (see the GRANT
-- below) but cannot `SET ROLE` to its owner, so that `current_user` value is
-- only ever present while the rehome function itself is executing.
-- The coherence trigger derives "that owner role" from the rehome function's
-- actual `pg_proc.proowner` at check time rather than a hardcoded role name,
-- since the owning role's name is environment-specific (the migration-runner
-- identity, not a fixed application role).
--
-- The definition-coherence read below (custom_field_definitions, cross-axis)
-- still needs the app-level `breeze.scope = 'system'` GUC elevation to see a
-- partner-wide definition under RLS — that is a session-local application GUC
-- consumed by the `breeze_has_org_access`/`breeze_has_partner_access` policy
-- functions, unrelated to the Postgres-level SECURITY DEFINER/current_user
-- question above, and untouched by this change.
--
-- Both functions are CREATE OR REPLACE; DDL only, no rows written, no
-- breeze.scope election needed at the top level. Idempotent.

CREATE OR REPLACE FUNCTION public.breeze_device_custom_field_value_coherent()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  _prev_scope text := current_setting('breeze.scope', true);
  def_org uuid;
  def_partner uuid;
  def_key varchar(100);
  row_partner uuid;
  merging_ok boolean := false;
  rehome_owner name;
BEGIN
  -- Elevate for the cross-axis definition read below AND for the device-org
  -- check just after it, so an ordinary caller's own (narrower) RLS context on
  -- `devices` can never make the check pass or fail for the wrong reason —
  -- restored before the single, end-of-body RETURN so 'system' does not persist
  -- into the rest of the caller's transaction. RAISE paths restore via
  -- (sub)transaction rollback. This is an application-level GUC read by the
  -- breeze_has_org_access/breeze_has_partner_access RLS policy functions —
  -- unrelated to, and not a substitute for, the Postgres-level current_user
  -- check below (see this migration's header for why a GUC cannot do that
  -- check's job).
  PERFORM set_config('breeze.scope', 'system', true);

  -- Device-org coherence. See this migration's header: this trigger is
  -- deliberately SECURITY INVOKER, so `current_user` here is the REAL
  -- executing identity — `breeze_app` for an ordinary write, or the owner of
  -- breeze_rehome_device_custom_field_values() while that SECURITY DEFINER
  -- function's own UPDATE is in flight. Looked up by proowner rather than a
  -- hardcoded name so it tracks whichever role actually owns the function in
  -- this environment.
  SELECT r.rolname INTO rehome_owner
    FROM pg_proc p
    JOIN pg_roles r ON r.oid = p.proowner
   WHERE p.oid = 'public.breeze_rehome_device_custom_field_values'::regproc;

  IF NOT EXISTS (
    SELECT 1 FROM public.devices d
     WHERE d.id = NEW.device_id AND d.org_id = NEW.org_id
  ) AND (rehome_owner IS NULL OR current_user <> rehome_owner) THEN
    RAISE EXCEPTION 'device % does not belong to organization %', NEW.device_id, NEW.org_id
      USING ERRCODE = 'P0001',
            CONSTRAINT = 'device_custom_field_values_coherent';
  END IF;

  SELECT f.org_id, f.partner_id, f.field_key
    INTO def_org, def_partner, def_key
    FROM public.custom_field_definitions f
   WHERE f.id = NEW.definition_id;

  IF def_key IS NULL THEN
    RAISE EXCEPTION 'custom field definition % does not exist', NEW.definition_id
      USING ERRCODE = 'P0001',
            CONSTRAINT = 'device_custom_field_values_coherent';
  END IF;

  IF NEW.field_key <> def_key THEN
    RAISE EXCEPTION 'field_key "%" disagrees with its definition ("%")', NEW.field_key, def_key
      USING ERRCODE = 'P0001',
            CONSTRAINT = 'device_custom_field_values_coherent';
  END IF;

  SELECT o.partner_id INTO row_partner
    FROM public.organizations o WHERE o.id = NEW.org_id;

  IF def_org IS NOT NULL THEN
    IF def_org <> NEW.org_id THEN
      -- Merge fence — see the header block above. Deliberately narrow on FOUR
      -- axes at once, so it excuses the merge's own repoint and nothing else:
      --   * UPDATE only — an INSERT can never reach it, so no caller can create
      --     a value under another org's definition;
      --   * the row must be moving OUT of the definition's own org
      --     (OLD.org_id = def_org), which is exactly the merge repoint's shape;
      --   * that org must be actively status='merging'; and
      --   * it must be under the SAME partner as the destination org, so the
      --     fence can never widen into cross-partner leakage.
      -- The loser org keeps status='merging' as a terminal shell after the
      -- merge, which is why the first two conditions carry the weight rather
      -- than the status alone.
      -- The TG_OP guard is an explicit IF, not a conjunct of the query below.
      -- `OLD` is unassigned in an INSERT trigger, and SQL's AND is not
      -- guaranteed to short-circuit left to right; keeping the reference out of
      -- the query entirely means this cannot depend on that.
      IF TG_OP = 'UPDATE' AND OLD.org_id = def_org THEN
        SELECT EXISTS (
          SELECT 1 FROM public.organizations lo
           WHERE lo.id = def_org
             AND lo.status::text = 'merging'
             AND row_partner IS NOT NULL
             AND lo.partner_id = row_partner
        ) INTO merging_ok;
      END IF;
      IF NOT merging_ok THEN
        RAISE EXCEPTION 'custom field definition % belongs to a different organization', NEW.definition_id
          USING ERRCODE = 'P0001',
                CONSTRAINT = 'device_custom_field_values_coherent';
      END IF;
    END IF;
  ELSE
    IF row_partner IS NULL OR def_partner IS NULL OR row_partner <> def_partner THEN
      RAISE EXCEPTION 'custom field definition % belongs to a different partner', NEW.definition_id
        USING ERRCODE = 'P0001',
              CONSTRAINT = 'device_custom_field_values_coherent';
    END IF;
  END IF;

  PERFORM set_config('breeze.scope', COALESCE(_prev_scope, ''), true);
  RETURN NEW;
END;
$$;

-- Body copied VERBATIM from the newest definition,
-- 2026-10-15-120002-authorize-custom-field-value-rehome.sql (verified by
-- grepping every later file in apps/api/migrations for
-- breeze_rehome_device_custom_field_values). SECURITY DEFINER and its
-- REVOKE/GRANT pair below are UNCHANGED from that definition — this function
-- was already the one legitimate, narrowly-granted write path the coherence
-- trigger's device-org check now keys its exception on; nothing about its own
-- authorization needed to change.
CREATE OR REPLACE FUNCTION public.breeze_rehome_device_custom_field_values(
  p_device_id uuid,
  p_target_org_id uuid
)
RETURNS TABLE (rehomed int, dropped int)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  _prev_scope text := NULLIF(current_setting('breeze.scope', true), '');
  source_org_id uuid;
  source_partner_id uuid;
  target_partner_id uuid;
  n_rehomed int := 0;
  n_dropped int := 0;
BEGIN
  -- The definer may own/bypass RLS, so row visibility here is data resolution,
  -- never authorization. The breeze_has_org_access checks below consume the
  -- unchanged caller GUCs and make the authorization decision before elevation.
  SELECT d.org_id, o.partner_id
    INTO source_org_id, source_partner_id
    FROM public.devices d
    JOIN public.organizations o ON o.id = d.org_id
   WHERE d.id = p_device_id;
  SELECT o.partner_id INTO target_partner_id
    FROM public.organizations o WHERE o.id = p_target_org_id;

  IF _prev_scope IS NULL
     OR _prev_scope NOT IN ('system', 'partner', 'organization')
     OR (
       _prev_scope <> 'system'
       AND (
         source_org_id IS NULL
         OR target_partner_id IS NULL
         OR NOT public.breeze_has_org_access(source_org_id)
         OR NOT public.breeze_has_org_access(p_target_org_id)
         OR source_partner_id IS DISTINCT FROM target_partner_id
       )
     ) THEN
    RAISE EXCEPTION 'custom-field value re-home access denied'
      USING ERRCODE = '42501';
  END IF;

  -- Preserve the established system-only no-op contract for missing/same-org
  -- inputs. Normal request callers were rejected above if either object was
  -- missing, avoiding a foreign-object existence oracle.
  IF source_org_id IS NULL OR target_partner_id IS NULL OR source_org_id = p_target_org_id THEN
    rehomed := 0;
    dropped := 0;
    RETURN NEXT;
    RETURN;
  END IF;

  -- Acquire the move's established export locks under caller scope, then
  -- re-resolve every authorization fact. The advisory lock can block; facts
  -- read before it are not safe to use after it returns.
  PERFORM public.breeze_partner_export_lock_orgs_exclusive(
    ARRAY[source_org_id, p_target_org_id]
  );

  source_org_id := NULL;
  source_partner_id := NULL;
  target_partner_id := NULL;
  SELECT d.org_id, o.partner_id
    INTO source_org_id, source_partner_id
    FROM public.devices d
    JOIN public.organizations o ON o.id = d.org_id
   WHERE d.id = p_device_id;
  SELECT o.partner_id INTO target_partner_id
    FROM public.organizations o WHERE o.id = p_target_org_id;

  IF source_org_id IS NULL
     OR target_partner_id IS NULL
     OR (
       _prev_scope <> 'system'
       AND (
         NOT public.breeze_has_org_access(source_org_id)
         OR NOT public.breeze_has_org_access(p_target_org_id)
         OR source_partner_id IS DISTINCT FROM target_partner_id
       )
     ) THEN
    RAISE EXCEPTION 'custom-field value re-home access denied'
      USING ERRCODE = '42501';
  END IF;

  PERFORM set_config('breeze.scope', 'system', true);

  WITH candidate AS (
    SELECT v.id AS value_id, tgt.id AS target_definition_id
      FROM public.device_custom_field_values v
      CROSS JOIN LATERAL (
        SELECT f.id
          FROM public.custom_field_definitions f
         WHERE f.field_key = v.field_key
           AND (f.org_id = p_target_org_id
                OR (f.org_id IS NULL AND f.partner_id = target_partner_id))
         LIMIT 1
      ) tgt
     WHERE v.device_id = p_device_id
       AND v.org_id = source_org_id
       AND tgt.id <> v.definition_id
       AND NOT EXISTS (
         SELECT 1 FROM public.device_custom_field_values occupied
          WHERE occupied.device_id = p_device_id
            AND occupied.definition_id = tgt.id)
  ), moved AS (
    UPDATE public.device_custom_field_values v
       SET definition_id = candidate.target_definition_id,
           org_id = p_target_org_id,
           updated_at = now()
      FROM candidate
     WHERE v.id = candidate.value_id
       AND v.org_id = source_org_id
    RETURNING 1
  )
  SELECT count(*)::int INTO n_rehomed FROM moved;

  WITH gone AS (
    DELETE FROM public.device_custom_field_values v
     WHERE v.device_id = p_device_id
       AND v.org_id = source_org_id
       AND NOT EXISTS (
         SELECT 1 FROM public.custom_field_definitions f
          WHERE f.id = v.definition_id
            AND (f.org_id = p_target_org_id
                 OR (f.org_id IS NULL AND f.partner_id = target_partner_id)))
    RETURNING 1
  )
  SELECT count(*)::int INTO n_dropped FROM gone;

  PERFORM set_config('breeze.scope', _prev_scope, true);
  rehomed := n_rehomed;
  dropped := n_dropped;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.breeze_rehome_device_custom_field_values(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.breeze_rehome_device_custom_field_values(uuid, uuid) TO breeze_app;
