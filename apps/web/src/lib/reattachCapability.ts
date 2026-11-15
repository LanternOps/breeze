import { useJwtClaims } from './authScope';
import { usePermissions } from './permissions';

/**
 * UX-only gate for the reattach action (#8318 §8). Mirrors the route chain of
 * POST /devices/:id/reattach — requireScope('partner') + devices:write +
 * devices:delete — so organization users and technicians without those
 * permissions are not offered an action the server will refuse. Never an
 * authorization decision: the server checks the §8 access rule, the
 * interactive session, MFA and the step-up, and confirm checks again.
 *
 * `unresolved` claims read as false, as useCanMoveDeviceOrg does (#4010).
 */
export function useCanReattachDevice(): boolean {
  const jwt = useJwtClaims();
  const { can } = usePermissions();
  if (jwt.status !== 'resolved') return false;
  if (jwt.claims.scope !== 'partner') return false;
  return can('devices', 'write') && can('devices', 'delete');
}
