import type { Context, Next } from 'hono';
import { ERROR_CODES } from '@breeze/shared';
import type { AuthContext } from './auth';
import { hasPermission, type UserPermissions } from '../services/permissions';
import { canManagePartnerWidePolicies } from '../services/partnerWideAccess';

const partnerGlobalDeniedMessage = 'Full partner organization access is required to manage partner-wide ticket configuration';

/**
 * Governance gate for customer sender-domain mapping and its ownership
 * verification (portal registration W5, #11382, D9): the ticket-config admin
 * check, shared by `/ticket-config/inbound-domains` and
 * `/organizations/:id/customer-domains`.
 *
 * Runs after a permission middleware (which populates c.get('permissions')) so
 * a non-admin gets a clear admin-403 rather than a generic permission-denied
 * message. Full-partner capability is checked first so wildcard/platform-admin
 * status cannot bypass selected/none organization access.
 */
export const requireCustomerDomainGovernance = async (c: Context, next: Next) => {
  const auth = c.get('auth') as AuthContext;
  if (!canManagePartnerWidePolicies(auth)) {
    return c.json({ error: partnerGlobalDeniedMessage, code: ERROR_CODES.ACCESS_DENIED }, 403);
  }
  const perms = c.get('permissions') as UserPermissions | undefined;
  const isAdmin = auth.user.isPlatformAdmin || (perms ? hasPermission(perms, '*', '*') : false);
  if (!isAdmin) return c.json({ error: 'Managing ticket configuration requires an admin role', code: ERROR_CODES.ACCESS_DENIED }, 403);
  return next();
};
