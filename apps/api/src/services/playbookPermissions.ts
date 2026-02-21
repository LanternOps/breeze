import type { AuthContext } from '../middleware/auth';
import { getUserPermissions, hasPermission } from './permissions';

export interface RequiredPermission {
  resource: string;
  action: string;
}

export interface PlaybookPermissionCheckResult {
  allowed: boolean;
  missingPermissions: string[];
  error?: string;
}

function normalizePermission(resource: unknown, action: unknown): RequiredPermission | null {
  if (typeof resource !== 'string' || typeof action !== 'string') return null;

  const normalizedResource = resource.trim();
  const normalizedAction = action.trim();
  if (!normalizedResource || !normalizedAction) return null;

  return {
    resource: normalizedResource,
    action: normalizedAction,
  };
}

export function parsePlaybookRequiredPermissions(value: unknown): RequiredPermission[] {
  if (!Array.isArray(value)) return [];

  const parsed: RequiredPermission[] = [];
  const seen = new Set<string>();

  for (const item of value) {
    let permission: RequiredPermission | null = null;

    if (typeof item === 'string') {
      const parts = item.split(':', 2);
      permission = normalizePermission(parts[0], parts[1]);
    } else if (item && typeof item === 'object') {
      const record = item as Record<string, unknown>;
      permission = normalizePermission(record.resource, record.action);
    }

    if (!permission) {
      console.warn(`[playbookPermissions] Dropping unparseable permission entry:`, JSON.stringify(item));
      continue;
    }

    const key = `${permission.resource}:${permission.action}`;
    if (!seen.has(key)) {
      seen.add(key);
      parsed.push(permission);
    }
  }

  return parsed;
}

export async function checkPlaybookRequiredPermissions(
  requiredPermissions: unknown,
  auth: AuthContext
): Promise<PlaybookPermissionCheckResult> {
  const parsed = parsePlaybookRequiredPermissions(requiredPermissions);
  if (parsed.length === 0) {
    return { allowed: true, missingPermissions: [] };
  }

  if (auth.scope === 'system') {
    return { allowed: true, missingPermissions: [] };
  }

  const userPerms = await getUserPermissions(auth.user.id, {
    partnerId: auth.partnerId || undefined,
    orgId: auth.orgId || undefined,
  });

  if (!userPerms) {
    return {
      allowed: false,
      missingPermissions: parsed.map((p) => `${p.resource}:${p.action}`),
      error: 'No permissions found',
    };
  }

  const missingPermissions = parsed
    .filter((permission) => !hasPermission(userPerms, permission.resource, permission.action))
    .map((permission) => `${permission.resource}:${permission.action}`);

  return {
    allowed: missingPermissions.length === 0,
    missingPermissions,
  };
}
