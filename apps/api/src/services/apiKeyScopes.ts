import { hasPermission, PERMISSIONS, type Permission, type UserPermissions } from './permissions';

export const API_KEY_SCOPE_POLICIES = {
  'devices:read': [PERMISSIONS.DEVICES_READ],
  'devices:write': [PERMISSIONS.DEVICES_WRITE],
  'devices:execute': [PERMISSIONS.DEVICES_EXECUTE],
  'scripts:read': [PERMISSIONS.SCRIPTS_READ],
  'scripts:write': [PERMISSIONS.SCRIPTS_WRITE],
  'scripts:execute': [PERMISSIONS.SCRIPTS_EXECUTE],
  'alerts:read': [PERMISSIONS.ALERTS_READ],
  'alerts:write': [PERMISSIONS.ALERTS_WRITE],
  'reports:read': [PERMISSIONS.REPORTS_READ],
  'reports:write': [PERMISSIONS.REPORTS_WRITE],
  'users:read': [PERMISSIONS.USERS_READ],
  // MCP/AI scopes are coarse transport gates. Per-tool RBAC still runs at
  // execution time, but creators must hold a baseline matching permission set.
  'ai:read': [
    PERMISSIONS.DEVICES_READ,
    PERMISSIONS.ALERTS_READ,
    PERMISSIONS.SCRIPTS_READ,
    PERMISSIONS.AUTOMATIONS_READ,
  ],
  'ai:write': [
    PERMISSIONS.DEVICES_WRITE,
    PERMISSIONS.ALERTS_WRITE,
    PERMISSIONS.SCRIPTS_WRITE,
    PERMISSIONS.AUTOMATIONS_WRITE,
  ],
  'ai:execute': [
    PERMISSIONS.DEVICES_EXECUTE,
    PERMISSIONS.SCRIPTS_EXECUTE,
  ],
  'ai:execute_admin': [PERMISSIONS.ADMIN_ALL],
} as const satisfies Record<string, readonly Permission[]>;

export type ApiKeyScope = keyof typeof API_KEY_SCOPE_POLICIES;

export const SUPPORTED_API_KEY_SCOPES = Object.freeze(
  Object.keys(API_KEY_SCOPE_POLICIES) as ApiKeyScope[],
);

const SUPPORTED_SCOPE_SET = new Set<string>(SUPPORTED_API_KEY_SCOPES);

export type ApiKeyScopeValidationResult =
  | { ok: true; scopes: ApiKeyScope[] }
  | { ok: false; status: 400 | 403; error: string; details?: Record<string, unknown> };

export function validateSupportedApiKeyScopes(requestedScopes: string[]): ApiKeyScopeValidationResult {
  const scopes = Array.from(new Set(requestedScopes));

  for (const scope of scopes) {
    if (scope === '*') {
      return {
        ok: false,
        status: 400,
        error: 'Wildcard API key scopes are not supported',
      };
    }

    if (!SUPPORTED_SCOPE_SET.has(scope)) {
      return {
        ok: false,
        status: 400,
        error: `Unsupported API key scope: ${scope}`,
        details: { supportedScopes: SUPPORTED_API_KEY_SCOPES },
      };
    }
  }

  return { ok: true, scopes: scopes as ApiKeyScope[] };
}

export function validateApiKeyScopeDelegation(
  requestedScopes: string[],
  creatorPermissions: UserPermissions | undefined,
): ApiKeyScopeValidationResult {
  const supportedScopes = validateSupportedApiKeyScopes(requestedScopes);
  if (!supportedScopes.ok) {
    return supportedScopes;
  }

  if (!creatorPermissions) {
    return {
      ok: false,
      status: 403,
      error: 'Unable to verify API key scope delegation permissions',
    };
  }

  for (const scope of supportedScopes.scopes) {
    const requiredPermissions = API_KEY_SCOPE_POLICIES[scope as ApiKeyScope];
    for (const permission of requiredPermissions) {
      if (!hasPermission(creatorPermissions, permission.resource, permission.action)) {
        return {
          ok: false,
          status: 403,
          error: `Cannot delegate API key scope "${scope}" without ${permission.resource}.${permission.action}`,
          details: {
            scope,
            requiredPermission: permission,
          },
        };
      }
    }
  }

  return supportedScopes;
}
