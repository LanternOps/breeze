/**
 * Sensitivity gate for stored event-log rows (`device_event_logs`).
 *
 * `category: 'security'` rows carry the same class of credential-adjacent,
 * high-signal content (failed-logon account names, process command lines,
 * PowerShell/Sysmon activity forwarded by the agent's collector under that
 * category) as the live Security/PowerShell/Sysmon channel reads gated by
 * `requireDevicesExecute` in `routes/systemTools/helpers.ts`. Any reader of
 * this table — REST list/search/aggregate/trend routes or an AI tool — must
 * apply the same rule: `devices:read` is enough for ordinary
 * hardware/application/system rows, but `devices:execute` is required to see
 * `category: 'security'` rows.
 */
import type { AuthContext } from '../middleware/auth';
import { getUserPermissions, hasPermission, PERMISSIONS } from './permissions';

export const SENSITIVE_EVENT_LOG_CATEGORY = 'security' as const;

export function isSensitiveEventLogCategory(category: string): boolean {
  return category === SENSITIVE_EVENT_LOG_CATEGORY;
}

/** Thrown when a caller without `devices:execute` asks only for the sensitive category. */
export class SensitiveEventLogAccessError extends Error {
  constructor(message = 'devices:execute is required to read Security-category event logs') {
    super(message);
    this.name = 'SensitiveEventLogAccessError';
  }
}

/**
 * Resolves whether the caller may read `category: 'security'` rows.
 * Mirrors `requireDevicesExecute` (routes/systemTools/helpers.ts) but takes
 * only an `AuthContext`, so it works from services with no Hono `Context`
 * (log search/aggregation/trends, AI tools).
 */
export async function canReadSensitiveEventLogCategory(
  auth: Pick<AuthContext, 'user' | 'orgId' | 'partnerId' | 'scope'>
): Promise<boolean> {
  const userPerms = await getUserPermissions(auth.user.id, {
    partnerId: auth.partnerId || undefined,
    orgId: auth.orgId || undefined,
    scope: auth.scope,
  });
  if (!userPerms) return false;
  return hasPermission(userPerms, PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action);
}

/**
 * Given a caller-requested category filter (or none) and whether the caller
 * may see the sensitive category, returns the category list to actually
 * query. `undefined` means "no category restriction beyond the sensitivity
 * gate" (sensitive rows still excluded when the caller can't read them).
 * Throws when the caller explicitly asked only for the sensitive category
 * without the permission to read it — there is nothing else to return.
 */
export function resolveVisibleCategories<C extends string>(
  requested: C[] | undefined,
  canReadSensitive: boolean
): C[] | undefined {
  if (canReadSensitive) return requested;

  if (requested && requested.length > 0) {
    const visible = requested.filter((category) => !isSensitiveEventLogCategory(category));
    if (visible.length === 0) {
      throw new SensitiveEventLogAccessError();
    }
    return visible;
  }

  return requested;
}
