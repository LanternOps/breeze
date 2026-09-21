import { expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock('../../db', () => ({ db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => m.rows }) }) }) } }));

import { reachableContact, requesterAuthorized } from './access';
import type { BindingRow, CallerVerificationActor } from './types';

const org = '11111111-1111-4111-8111-111111111111';
const site = '22222222-2222-4222-8222-222222222222';
const actor: CallerVerificationActor = { userId: 'u', partnerId: null, scope: 'organization', accessibleOrgIds: [org], allowedSiteIds: null, displayName: 'T' };
const binding = (id: string, revokedAt: Date | null = null) => ({ id, revokedAt } as BindingRow);

it('reachableContact refuses foreign orgs before any read, then unreachable sites', async () => {
  m.rows = [{ id: 'c', siteId: null }];
  await expect(reachableContact(actor, 'other', 'c')).rejects.toMatchObject({ code: 'not_found' });
  m.rows = [];
  await expect(reachableContact(actor, org, 'c')).rejects.toMatchObject({ code: 'not_found' });
  m.rows = [{ id: 'c', siteId: site }];
  await expect(reachableContact({ ...actor, allowedSiteIds: [] }, org, 'c')).rejects.toMatchObject({ code: 'not_found' });
  await expect(reachableContact({ ...actor, allowedSiteIds: ['zz'] }, org, 'c')).rejects.toMatchObject({ code: 'not_found' });
  expect(await reachableContact({ ...actor, allowedSiteIds: [site] }, org, 'c')).toMatchObject({ id: 'c' });
  m.rows = [{ id: 'c', siteId: null }];
  // Org-level contacts are reachable by every site-restricted member of the org.
  expect(await reachableContact({ ...actor, allowedSiteIds: [] }, org, 'c')).toMatchObject({ id: 'c' });
  // Partner-wide actors (null accessibleOrgIds) are not org-restricted.
  expect(await reachableContact({ ...actor, accessibleOrgIds: null }, 'other', 'c')).toMatchObject({ id: 'c' });
});

it('requesterAuthorized: self-service, any-scope and revoked bindings', () => {
  const a = binding('a');
  const b = binding('b');
  const orgAdmin = { siteId: null, roles: ['admin'] };
  expect(requesterAuthorized('any', null, null, orgAdmin, ['admin'])).toBe(true);
  expect(requesterAuthorized('any', a, b, orgAdmin, ['admin'])).toBe(false);
  expect(requesterAuthorized('reset_password', a, a, orgAdmin, ['admin'])).toBe(true);
  expect(requesterAuthorized('reset_password', a, b, orgAdmin, ['admin'])).toBe(false);
  expect(requesterAuthorized('reset_password', null, a, orgAdmin, ['admin'])).toBe(false);
  expect(requesterAuthorized('disable_user', binding('a', new Date()), a, orgAdmin, ['admin'])).toBe(false);
  expect(requesterAuthorized('disable_user', a, binding('a', new Date()), orgAdmin, ['admin'])).toBe(false);
});

it('requesterAuthorized: only an org-level contact holding an authorizer role may disable another account (D15)', () => {
  const a = binding('a');
  const b = binding('b');
  expect(requesterAuthorized('disable_user', a, b, { siteId: null, roles: ['admin'] }, ['admin'])).toBe(true);
  // Site-level manager: never, even with the role.
  expect(requesterAuthorized('disable_user', a, b, { siteId: site, roles: ['admin'] }, ['admin'])).toBe(false);
  // Org-level contact without an authorizer role: never.
  expect(requesterAuthorized('disable_user', a, b, { siteId: null, roles: ['technical'] }, ['admin'])).toBe(false);
  // Policy with no authorizer roles: nobody may authorize another account.
  expect(requesterAuthorized('disable_user', a, b, { siteId: null, roles: ['admin'] }, [])).toBe(false);
  // reset_password is always self-only.
  expect(requesterAuthorized('reset_password', a, b, { siteId: null, roles: ['admin'] }, ['admin'])).toBe(false);
});
