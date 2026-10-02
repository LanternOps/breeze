import { and, eq, isNull, or, type SQL } from 'drizzle-orm';
import { auditLogs } from '../db/schema';
import type { AuthContext } from '../middleware/auth';

export type AuditReadAuth = Pick<AuthContext, 'scope' | 'partnerId' | 'orgCondition'>;

/**
 * The partner id whose partner-scoped audit rows (`org_id IS NULL AND
 * partner_id = P`, #7696) this caller may read, or null.
 *
 * Gated on `auth.scope === 'partner'`, never on `auth.partnerId` alone: an
 * organization-scope token carries its MSP's partnerId too, but an org user must
 * not see the MSP's partner-level change history. RLS agrees — the
 * `audit_logs_partner_scope_select` policy keys on `breeze_has_partner_access`,
 * which is false for every org-scope session.
 */
export function auditPartnerScopeId(auth: Pick<AuthContext, 'scope' | 'partnerId'>): string | null {
  return auth.scope === 'partner' && auth.partnerId ? auth.partnerId : null;
}

/**
 * App-layer tenancy predicate for every Audit Trail read of `audit_logs`.
 *
 * - system scope: undefined (no filter; RLS lets system read everything).
 * - organization scope: the accessible-org condition only.
 * - partner scope: accessible orgs OR the caller's own partner-scoped rows.
 *
 * Platform-wide NULL-org rows (`partner_id IS NULL`: SSO, mTLS, enrollment,
 * pre-#7696 history) match neither branch for a non-system caller.
 */
export function auditLogReadCondition(auth: AuditReadAuth): SQL | undefined {
  const orgCond = auth.orgCondition(auditLogs.orgId);
  // undefined = unrestricted (system scope); nothing to widen.
  if (!orgCond) return undefined;
  const partnerId = auditPartnerScopeId(auth);
  if (!partnerId) return orgCond;
  return or(orgCond, and(isNull(auditLogs.orgId), eq(auditLogs.partnerId, partnerId)));
}
