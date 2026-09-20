import type { AuthContext } from '../middleware/auth';
import { hasPermission, type UserPermissions } from './permissions';

/** Only an identified human actor can override billing. API keys also cover
 * service principals whose user.id is merely the key creator's audit identity. */
export function canManageTimeEntryBilling(
  auth: Pick<AuthContext, 'principal' | 'user'>,
  permissions: UserPermissions | null | undefined,
): boolean {
  if (auth.principal?.kind !== 'user_session' && auth.principal?.kind !== 'oauth_grant') return false;
  return auth.user.isPlatformAdmin || (permissions ? hasPermission(permissions, 'time_entries', 'manage_billing') : false);
}
