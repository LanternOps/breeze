import { beforeEach, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  rows: [] as unknown[],
  resolved: { level: 'organization', assignments: [] } as {
    level: 'device_group' | 'site' | 'organization';
    assignments: Array<{ contactId: string }>;
  },
}));
vi.mock('../../db', () => ({ db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => m.rows }) }) }) } }));
vi.mock('../contacts/responsibilities', () => ({
  resolveContactResponsibility: vi.fn(async () => m.resolved),
}));

import { reachableContact, requesterAuthorized } from './access';
import type { BindingRow, CallerVerificationActor } from './types';

const org = '11111111-1111-4111-8111-111111111111';
const site = '22222222-2222-4222-8222-222222222222';
const contactId = '33333333-3333-4333-8333-333333333333';
const actor: CallerVerificationActor = { userId: 'u', partnerId: null, scope: 'organization', accessibleOrgIds: [org], allowedSiteIds: null, displayName: 'T' };
const binding = (id: string, revokedAt: Date | null = null) => ({ id, revokedAt } as BindingRow);

beforeEach(() => {
  m.rows = [];
  m.resolved = { level: 'organization', assignments: [] };
});

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

it('requesterAuthorized: self-service, any-scope and revoked bindings', async () => {
  const a = binding('a');
  const b = binding('b');
  expect(await requesterAuthorized('any', null, null, org, contactId, ['admin'])).toBe(true);
  expect(await requesterAuthorized('any', a, b, org, contactId, ['admin'])).toBe(false);
  expect(await requesterAuthorized('reset_password', a, a, org, contactId, ['admin'])).toBe(true);
  expect(await requesterAuthorized('reset_password', a, b, org, contactId, ['admin'])).toBe(false);
  expect(await requesterAuthorized('reset_password', null, a, org, contactId, ['admin'])).toBe(false);
  expect(await requesterAuthorized('disable_user', binding('a', new Date()), a, org, contactId, ['admin'])).toBe(false);
  expect(await requesterAuthorized('disable_user', a, binding('a', new Date()), org, contactId, ['admin'])).toBe(false);
});

it('requesterAuthorized requires explicit Organization-scoped responsibility for cross-subject disable (D15)', async () => {
  const a = binding('a');
  const b = binding('b');

  // Explicit admin @ Organization is authoritative regardless of contacts.site_id affiliation.
  m.resolved = { level: 'organization', assignments: [{ contactId }] };
  expect(await requesterAuthorized('disable_user', a, b, org, contactId, ['admin'])).toBe(true);

  // A Site/Device Group responsibility must never widen into org-level authority.
  m.resolved = { level: 'site', assignments: [{ contactId }] };
  expect(await requesterAuthorized('disable_user', a, b, org, contactId, ['admin'])).toBe(false);
  m.resolved = { level: 'device_group', assignments: [{ contactId }] };
  expect(await requesterAuthorized('disable_user', a, b, org, contactId, ['admin'])).toBe(false);

  // Organization responsibility held by another contact does not authorize this requester.
  m.resolved = { level: 'organization', assignments: [{ contactId: 'other-contact' }] };
  expect(await requesterAuthorized('disable_user', a, b, org, contactId, ['admin'])).toBe(false);

  // Policy with no authorizer roles: nobody may authorize another account.
  expect(await requesterAuthorized('disable_user', a, b, org, contactId, [])).toBe(false);
  // reset_password remains self-only.
  expect(await requesterAuthorized('reset_password', a, b, org, contactId, ['admin'])).toBe(false);
});
