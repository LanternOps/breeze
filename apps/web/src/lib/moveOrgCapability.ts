import { useJwtClaims } from './authScope';
import { usePermissions } from './permissions';

/**
 * UX-only gate for the "Move to Organization" device action. Mirrors the
 * route chain of POST /devices/:id/move-org — requireScope('partner','system')
 * + devices:write + organizations:write — so org-scoped users and
 * under-privileged technicians are not offered an action the server will 403.
 * Never an authorization decision: the server re-checks everything, and also
 * requires an interactive session plus a fresh step-up grant (W01).
 *
 * `unresolved` claims read as false so the entry does not flash then vanish on
 * a cold load (#4010).
 */
export function useCanMoveDeviceOrg(): boolean {
  const jwt = useJwtClaims();
  const { can } = usePermissions();
  if (jwt.status !== 'resolved') return false;
  const scope = jwt.claims.scope;
  if (scope !== 'partner' && scope !== 'system') return false;
  return can('devices', 'write') && can('organizations', 'write');
}
