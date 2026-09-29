import {
  TIME_SYNC_HEALTH,
  TIME_SYNC_FINDING_CODES,
  TIME_SYNC_DOMAIN_ROLES,
} from '@breeze/shared';
export interface FleetState {
  view: 'list' | 'domain';
  health: string;
  finding: string;
  role: string;
  orgId: string;
  siteId: string;
  page: number;
}
export const INITIAL_FLEET_STATE: FleetState = {
  view: 'list',
  health: '',
  finding: '',
  role: '',
  orgId: '',
  siteId: '',
  page: 1,
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function readFleetHash(raw: string): FleetState {
  const p = new URLSearchParams(raw),
    pick = (key: string, values: readonly string[]) =>
      values.includes(p.get(key) ?? '') ? p.get(key)! : '';
  const page = Number(p.get('page') ?? 1);
  return {
    view: p.get('view') === 'domain' ? 'domain' : 'list',
    health: pick('health', TIME_SYNC_HEALTH),
    finding: pick('finding', TIME_SYNC_FINDING_CODES),
    role: pick('role', TIME_SYNC_DOMAIN_ROLES),
    orgId: uuid.test(p.get('orgId') ?? '') ? p.get('orgId')! : '',
    siteId: uuid.test(p.get('siteId') ?? '') ? p.get('siteId')! : '',
    page: Number.isSafeInteger(page) && page >= 1 ? page : 1,
  };
}
export function fleetQuery(
  state: FleetState,
  currentOrgId: string | null,
): URLSearchParams {
  const params = new URLSearchParams({ page: String(state.page), limit: '50' });
  for (const key of ['health', 'finding', 'role', 'siteId'] as const)
    if (state[key]) params.set(key, state[key]);
  const org = currentOrgId || state.orgId;
  if (org) params.set('orgId', org);
  return params;
}
