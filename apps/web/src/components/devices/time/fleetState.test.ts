import { expect, it } from 'vitest';
import { readFleetHash, fleetQuery, INITIAL_FLEET_STATE } from './fleetState';
it('round-trips view, filters and page without query-string UI state', () => {
  const state = readFleetHash(
    'view=domain&health=warning&finding=sync_stale&role=member&orgId=11111111-1111-4111-8111-111111111111&page=2',
  );
  expect(state).toMatchObject({
    view: 'domain',
    health: 'warning',
    finding: 'sync_stale',
    role: 'member',
    page: 2,
  });
  expect(fleetQuery(state, null).get('finding')).toBe('sync_stale');
  expect(fleetQuery(state, null).has('view')).toBe(false);
});
it('rejects invalid vocabularies, inherited keys, UUIDs and pages', () => {
  expect(
    readFleetHash(
      'view=toString&health=bad&finding=bad&role=bad&orgId=bad&siteId=bad&page=-2',
    ),
  ).toEqual(INITIAL_FLEET_STATE);
  expect(readFleetHash('page=1.5').page).toBe(1);
});
it('intersects page filtering with the global organization selection', () => {
  const state = readFleetHash('orgId=11111111-1111-4111-8111-111111111111');
  expect(
    fleetQuery(state, '22222222-2222-4222-8222-222222222222').get('orgId'),
  ).toBe('22222222-2222-4222-8222-222222222222');
});
