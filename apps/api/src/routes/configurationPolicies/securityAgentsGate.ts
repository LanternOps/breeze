import type { AuthContext } from '../../middleware/auth';
import { hasSatisfiedMfa } from '../../middleware/auth';
import { PERMISSIONS, hasPermission, type UserPermissions } from '../../services/permissions';

/**
 * #6960: enabling a security agent arms installs, so the link write needs the
 * software-deployment grant (devices.execute + MFA), mirroring the HP CMSL gate.
 * Fail closed when permissions were not resolved. Shared by the feature-link
 * routes and by Copy (#12309), which re-runs it for a carried link.
 */
export function mayArmSecurityAgents(auth: AuthContext, perms: UserPermissions | undefined): boolean {
  return !!perms
    && hasPermission(perms, PERMISSIONS.DEVICES_EXECUTE.resource, PERMISSIONS.DEVICES_EXECUTE.action)
    && hasSatisfiedMfa(auth);
}
