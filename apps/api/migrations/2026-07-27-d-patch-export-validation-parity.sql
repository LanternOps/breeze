-- Fix forward the patch mirror projection used by desired-configuration export.
-- Breeze parses the entire stored inline document with patchInlineSettingsSchema;
-- any base-field or superRefine failure defaults both JSON-only fields together.

CREATE OR REPLACE FUNCTION public.breeze_partner_export_patch_mirror_projection(mirror jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
DECLARE
  document jsonb;
  app jsonb;
  projected_apps jsonb := '[]'::jsonb;
  seen_app_keys text[] := ARRAY[]::text[];
  canonical_app_key text;
  numeric_value numeric;
  deferral_days integer := 0;
BEGIN
  -- postgres.js decodes both SQL NULL and a JSON null scalar to JavaScript
  -- null; `tryNormalizePatchInlineSettings(settings ?? {})` treats both as {}.
  document := CASE
    WHEN mirror IS NULL OR mirror = 'null'::jsonb THEN '{}'::jsonb
    ELSE mirror
  END;

  IF jsonb_typeof(document) IS DISTINCT FROM 'object' THEN
    RETURN jsonb_build_object('autoApproveDeferralDays', 0, 'apps', '[]'::jsonb);
  END IF;

  IF document ? 'sources' THEN
    IF jsonb_typeof(document->'sources') IS DISTINCT FROM 'array' THEN
      RETURN jsonb_build_object('autoApproveDeferralDays', 0, 'apps', '[]'::jsonb);
    END IF;
    IF jsonb_array_length(document->'sources') = 0 THEN
      RETURN jsonb_build_object('autoApproveDeferralDays', 0, 'apps', '[]'::jsonb);
    END IF;
    IF EXISTS (
        SELECT 1
        FROM jsonb_array_elements(document->'sources') AS entry(value)
        WHERE jsonb_typeof(value) IS DISTINCT FROM 'string'
          OR value#>>'{}' NOT IN (
            'os', 'third_party', 'custom', 'firmware', 'drivers',
            'microsoft', 'apple', 'linux'
          )
      ) THEN
      RETURN jsonb_build_object('autoApproveDeferralDays', 0, 'apps', '[]'::jsonb);
    END IF;

    -- firmware/drivers currently have no provider. The Zod superRefine rejects
    -- a non-empty source selection made up only of those two values.
    IF NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(document->'sources') AS entry(value)
      WHERE value#>>'{}' NOT IN ('firmware', 'drivers')
    ) THEN
      RETURN jsonb_build_object('autoApproveDeferralDays', 0, 'apps', '[]'::jsonb);
    END IF;
  END IF;

  IF document ? 'autoApprove'
    AND jsonb_typeof(document->'autoApprove') IS DISTINCT FROM 'boolean'
  THEN
    RETURN jsonb_build_object('autoApproveDeferralDays', 0, 'apps', '[]'::jsonb);
  END IF;

  IF document ? 'autoApproveSeverities' THEN
    IF jsonb_typeof(document->'autoApproveSeverities') IS DISTINCT FROM 'array' THEN
      RETURN jsonb_build_object('autoApproveDeferralDays', 0, 'apps', '[]'::jsonb);
    END IF;
    IF EXISTS (
        SELECT 1
        FROM jsonb_array_elements(document->'autoApproveSeverities') AS entry(value)
        WHERE jsonb_typeof(value) IS DISTINCT FROM 'string'
          OR value#>>'{}' NOT IN ('critical', 'important', 'moderate', 'low')
      ) THEN
      RETURN jsonb_build_object('autoApproveDeferralDays', 0, 'apps', '[]'::jsonb);
    END IF;
  END IF;

  IF COALESCE(document->>'autoApprove', 'false') = 'true'
    AND COALESCE(jsonb_array_length(document->'autoApproveSeverities'), 0) = 0
  THEN
    RETURN jsonb_build_object('autoApproveDeferralDays', 0, 'apps', '[]'::jsonb);
  END IF;

  IF document ? 'autoApproveDeferralDays' THEN
    IF jsonb_typeof(document->'autoApproveDeferralDays') IS DISTINCT FROM 'number' THEN
      RETURN jsonb_build_object('autoApproveDeferralDays', 0, 'apps', '[]'::jsonb);
    END IF;
    numeric_value := (document->>'autoApproveDeferralDays')::numeric;
    IF numeric_value <> trunc(numeric_value) OR numeric_value NOT BETWEEN 0 AND 60 THEN
      RETURN jsonb_build_object('autoApproveDeferralDays', 0, 'apps', '[]'::jsonb);
    END IF;
    deferral_days := numeric_value::integer;
  END IF;

  IF document ? 'apps' THEN
    IF jsonb_typeof(document->'apps') IS DISTINCT FROM 'array' THEN
      RETURN jsonb_build_object('autoApproveDeferralDays', 0, 'apps', '[]'::jsonb);
    END IF;
    IF jsonb_array_length(document->'apps') > 200 THEN
      RETURN jsonb_build_object('autoApproveDeferralDays', 0, 'apps', '[]'::jsonb);
    END IF;

    FOR app IN SELECT value FROM jsonb_array_elements(document->'apps') AS entry(value)
    LOOP
      IF jsonb_typeof(app) IS DISTINCT FROM 'object'
        OR jsonb_typeof(app->'source') IS DISTINCT FROM 'string'
        OR app->>'source' NOT IN ('third_party', 'custom')
        OR jsonb_typeof(app->'packageId') IS DISTINCT FROM 'string'
        OR length(app->>'packageId') NOT BETWEEN 1 AND 256
        OR jsonb_typeof(app->'action') IS DISTINCT FROM 'string'
        OR app->>'action' NOT IN ('block', 'pin')
      THEN
        RETURN jsonb_build_object('autoApproveDeferralDays', 0, 'apps', '[]'::jsonb);
      END IF;

      IF app ? 'displayName'
        AND (
          jsonb_typeof(app->'displayName') IS DISTINCT FROM 'string'
          OR length(app->>'displayName') > 255
        )
      THEN
        RETURN jsonb_build_object('autoApproveDeferralDays', 0, 'apps', '[]'::jsonb);
      END IF;

      -- pinnedVersion is optional, but when present its own Zod schema applies
      -- to block rules as well as pin rules.
      IF app ? 'pinnedVersion'
        AND (
          jsonb_typeof(app->'pinnedVersion') IS DISTINCT FROM 'string'
          OR length(app->>'pinnedVersion') NOT BETWEEN 1 AND 64
        )
      THEN
        RETURN jsonb_build_object('autoApproveDeferralDays', 0, 'apps', '[]'::jsonb);
      END IF;
      IF app->>'action' = 'pin' AND NOT (app ? 'pinnedVersion') THEN
        RETURN jsonb_build_object('autoApproveDeferralDays', 0, 'apps', '[]'::jsonb);
      END IF;

      -- The evaluator treats custom and third_party as one source bucket, and
      -- the whole-document superRefine lower-cases the package identity.
      canonical_app_key :=
        CASE WHEN app->>'source' = 'custom' THEN 'third_party' ELSE app->>'source' END
        || '|' || lower(app->>'packageId');
      IF canonical_app_key = ANY(seen_app_keys) THEN
        RETURN jsonb_build_object('autoApproveDeferralDays', 0, 'apps', '[]'::jsonb);
      END IF;
      seen_app_keys := array_append(seen_app_keys, canonical_app_key);

      projected_apps := projected_apps || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
        'source', app->>'source',
        'packageId', app->>'packageId',
        'displayName', app->>'displayName',
        'action', app->>'action',
        'pinnedVersion', app->>'pinnedVersion'
      )));
    END LOOP;
  END IF;

  IF document ? 'scheduleFrequency'
    AND (
      jsonb_typeof(document->'scheduleFrequency') IS DISTINCT FROM 'string'
      OR document->>'scheduleFrequency' NOT IN ('daily', 'weekly', 'monthly')
    )
  THEN
    RETURN jsonb_build_object('autoApproveDeferralDays', 0, 'apps', '[]'::jsonb);
  END IF;

  IF document ? 'scheduleTime'
    AND (
      jsonb_typeof(document->'scheduleTime') IS DISTINCT FROM 'string'
      OR document->>'scheduleTime' !~ '^([01][0-9]|2[0-3]):([0-5][0-9])$'
    )
  THEN
    RETURN jsonb_build_object('autoApproveDeferralDays', 0, 'apps', '[]'::jsonb);
  END IF;

  IF document ? 'scheduleDayOfWeek'
    AND (
      jsonb_typeof(document->'scheduleDayOfWeek') IS DISTINCT FROM 'string'
      OR document->>'scheduleDayOfWeek' NOT IN ('mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun')
    )
  THEN
    RETURN jsonb_build_object('autoApproveDeferralDays', 0, 'apps', '[]'::jsonb);
  END IF;

  IF document ? 'scheduleDayOfMonth' THEN
    IF jsonb_typeof(document->'scheduleDayOfMonth') IS DISTINCT FROM 'number' THEN
      RETURN jsonb_build_object('autoApproveDeferralDays', 0, 'apps', '[]'::jsonb);
    END IF;
    numeric_value := (document->>'scheduleDayOfMonth')::numeric;
    IF numeric_value <> trunc(numeric_value) OR numeric_value NOT BETWEEN 1 AND 28 THEN
      RETURN jsonb_build_object('autoApproveDeferralDays', 0, 'apps', '[]'::jsonb);
    END IF;
  END IF;

  IF document ? 'rebootPolicy'
    AND (
      jsonb_typeof(document->'rebootPolicy') IS DISTINCT FROM 'string'
      OR document->>'rebootPolicy' NOT IN ('never', 'if_required', 'always', 'maintenance_window')
    )
  THEN
    RETURN jsonb_build_object('autoApproveDeferralDays', 0, 'apps', '[]'::jsonb);
  END IF;

  IF document ? 'exclusiveWindowsUpdate'
    AND jsonb_typeof(document->'exclusiveWindowsUpdate') IS DISTINCT FROM 'boolean'
  THEN
    RETURN jsonb_build_object('autoApproveDeferralDays', 0, 'apps', '[]'::jsonb);
  END IF;

  RETURN jsonb_build_object(
    'autoApproveDeferralDays', deferral_days,
    'apps', projected_apps
  );
END;
$$;

-- Preserve the previous canonical materializer so this narrow fix can wrap
-- only patch output without duplicating every other feature's SQL projection.
DO $$
BEGIN
  IF to_regprocedure(
    'public.breeze_partner_export_policy_settings_pre_patch(uuid,text,jsonb)'
  ) IS NULL THEN
    ALTER FUNCTION public.breeze_partner_export_effective_policy_settings(uuid, text, jsonb)
      RENAME TO breeze_partner_export_policy_settings_pre_patch;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.breeze_partner_export_effective_policy_settings(
  link_id uuid,
  feature_type text,
  mirror jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $$
DECLARE result jsonb;
BEGIN
  result := public.breeze_partner_export_policy_settings_pre_patch(
    link_id,
    feature_type,
    mirror
  );
  IF feature_type = 'patch' AND result IS NOT NULL THEN
    result := (result - 'autoApproveDeferralDays' - 'apps')
      || public.breeze_partner_export_patch_mirror_projection(mirror);
  END IF;
  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.breeze_partner_export_patch_mirror_projection(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.breeze_partner_export_policy_settings_pre_patch(uuid, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.breeze_partner_export_effective_policy_settings(uuid, text, jsonb) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'breeze_app') THEN
    GRANT EXECUTE ON FUNCTION public.breeze_partner_export_patch_mirror_projection(jsonb) TO breeze_app;
    GRANT EXECUTE ON FUNCTION public.breeze_partner_export_policy_settings_pre_patch(uuid, text, jsonb) TO breeze_app;
    GRANT EXECUTE ON FUNCTION public.breeze_partner_export_effective_policy_settings(uuid, text, jsonb) TO breeze_app;
  END IF;
END
$$;
