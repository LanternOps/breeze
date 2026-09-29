import { hasSatisfiedMfa, type AuthContext } from '../../middleware/auth';
import { hasPermission, PERMISSIONS, type UserPermissions } from '../../services/permissions';

/**
 * A scheduled report with email recipients delivers a rendered export off
 * the platform on a timer, with no per-run confirmation — the same bulk
 * output `reports:export` already gates on the interactive download and
 * generate paths (`runs.ts`, `generate.ts`). Adding recipients needs that
 * permission plus a fresh-MFA session, not just `reports:write`.
 *
 * Moved verbatim from routes/reports/core.ts (multi-org report series W02) so
 * the series routes and the child recipient writer share ONE gate (INDEX
 * "Recipient delivery gate"). The permission set is not on AuthContext —
 * requirePermission stores it on the request context — so it is an argument.
 */
export const RECIPIENTS_NEED_EXPORT_AND_MFA = {
  error:
    'Setting or changing email recipients on a report requires the export permission and an MFA-verified session',
} as const;

export function callerMaySetEmailRecipients(
  auth: Pick<AuthContext, 'token'>,
  permissions: UserPermissions | undefined,
): boolean {
  if (!permissions || !hasPermission(permissions, PERMISSIONS.REPORTS_EXPORT.resource, PERMISSIONS.REPORTS_EXPORT.action)) {
    return false;
  }
  return hasSatisfiedMfa(auth);
}
