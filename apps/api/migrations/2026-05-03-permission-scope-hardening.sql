-- Harden API key scopes and custom role permissions against wildcard/unknown escalation.

CREATE OR REPLACE FUNCTION public.breeze_api_key_scopes_supported(scopes jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN jsonb_typeof(scopes) <> 'array' THEN false
    ELSE NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(scopes) AS scope(value)
      WHERE scope.value NOT IN (
        'devices:read',
        'devices:write',
        'devices:execute',
        'scripts:read',
        'scripts:write',
        'scripts:execute',
        'alerts:read',
        'alerts:write',
        'reports:read',
        'reports:write',
        'users:read',
        'ai:read',
        'ai:write',
        'ai:execute',
        'ai:execute_admin'
      )
    )
  END;
$$;

UPDATE api_keys
SET scopes = '[]'::jsonb
WHERE jsonb_typeof(scopes) <> 'array';

UPDATE api_keys
SET scopes = COALESCE(
  (
    SELECT jsonb_agg(DISTINCT scope.value)
    FROM jsonb_array_elements_text(api_keys.scopes) AS scope(value)
    WHERE scope.value IN (
      'devices:read',
      'devices:write',
      'devices:execute',
      'scripts:read',
      'scripts:write',
      'scripts:execute',
      'alerts:read',
      'alerts:write',
      'reports:read',
      'reports:write',
      'users:read',
      'ai:read',
      'ai:write',
      'ai:execute',
      'ai:execute_admin'
    )
  ),
  '[]'::jsonb
)
WHERE NOT public.breeze_api_key_scopes_supported(scopes);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'api_keys_scopes_supported_check'
      AND conrelid = 'public.api_keys'::regclass
  ) THEN
    ALTER TABLE public.api_keys
      ADD CONSTRAINT api_keys_scopes_supported_check
      CHECK (public.breeze_api_key_scopes_supported(scopes)) NOT VALID;
  END IF;
END $$;

ALTER TABLE public.api_keys VALIDATE CONSTRAINT api_keys_scopes_supported_check;

DELETE FROM role_permissions rp
USING roles r, permissions p
WHERE rp.role_id = r.id
  AND rp.permission_id = p.id
  AND r.is_system = false
  AND (p.resource || ':' || p.action) NOT IN (
    'backup:read',
    'backup:write',
    'devices:read',
    'devices:write',
    'devices:delete',
    'devices:execute',
    'scripts:read',
    'scripts:write',
    'scripts:delete',
    'scripts:execute',
    'alerts:read',
    'alerts:write',
    'alerts:acknowledge',
    'users:read',
    'users:write',
    'users:delete',
    'users:invite',
    'organizations:read',
    'organizations:write',
    'organizations:delete',
    'sites:read',
    'sites:write',
    'sites:delete',
    'automations:read',
    'automations:write',
    'automations:delete',
    'remote:access',
    'audit:read',
    'audit:export',
    'reports:read',
    'reports:write',
    'reports:delete',
    'reports:export',
    'billing:manage'
  );
