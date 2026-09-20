// services/delivery/inheritedRails.test.ts
import { expect, it, vi } from 'vitest';
import { readInheritedRails } from './inheritedRails';
const ORG = '10000000-0000-4000-8000-000000000001';
const PARTNER = '20000000-0000-4000-8000-000000000001';
function executorFor(rows: unknown[][]) {
  const select = vi.fn((projection: Record<string, unknown>) => {
    const result = rows.shift() ?? [];
    const q: any = { from: () => q, where: () => q, orderBy: () => q,
      then: (ok: any, bad: any) => Promise.resolve(result.map(row => Object.fromEntries(
        Object.keys(projection).map(key => [key, (row as any)[key]])))).then(ok, bad) };
    return q;
  });
  return { select };
}
it('selects only inherited channel metadata, with no config key at any stage', async () => {
  const executor = executorFor([[{ id: 'ch', name: 'NOC', type: 'slack', enabled: true,
    config: { webhookUrl: 'secret' }, lastTestError: 'private' }]]);
  const result = await readInheritedRails('channels', { orgId: ORG, partnerId: PARTNER }, executor as any);
  expect(result).toEqual([{ id: 'ch', name: 'NOC', type: 'slack', enabled: true, inherited: true }]);
  expect(Object.keys(executor.select.mock.calls[0]![0]).sort()).toEqual(['enabled','id','name','type']);
  expect(result[0]).not.toHaveProperty('config');
});
it('projects stepCount, never policy targets or owner IDs', async () => {
  const executor = executorFor([[{ id: 'ep', name: 'On call', stepCount: 2, steps: [{ userIds: ['private'] }] }]]);
  expect(await readInheritedRails('escalation', { orgId: ORG, partnerId: PARTNER }, executor as any))
    .toEqual([{ id: 'ep', name: 'On call', stepCount: 2, inherited: true }]);
  expect(Object.keys(executor.select.mock.calls[0]![0]).sort()).toEqual(['id','name','stepCount']);
});
it('filters inherited routing sites and exposes only the supported condition fields', async () => {
  const executor = executorFor([[{ id: 'r', name: 'NOC', priority: 1, enabled: true, isDefault: false,
    conditions: { severities: ['high'], monitorKinds: ['cpu'], siteIds: ['visible','foreign'], deviceTags: ['private'] },
    channelIds: ['ch'], escalationPolicyId: 'ep' }], [{ id: 'visible' }]]);
  expect(await readInheritedRails('routing', { orgId: ORG, partnerId: PARTNER, allowedSiteIds: ['visible'] }, executor as any))
    .toEqual([{ id: 'r', name: 'NOC', priority: 1, enabled: true, isDefault: false,
      conditions: { severities: ['high'], monitorKinds: ['cpu'], siteIds: ['visible'] },
      channelIds: ['ch'], escalationPolicyId: 'ep', inherited: true }]);
});
it.each([{ allowedSiteIds: [] }, { allowedSiteIds: ['unrelated'] }])('hides targeted routing rows with no visible sites: %j', async ({ allowedSiteIds }) => {
  const executor = executorFor([[{ id: 'r', conditions: { siteIds: ['hidden'] } }], []]);
  expect(await readInheritedRails('routing', { orgId: ORG, partnerId: PARTNER, allowedSiteIds }, executor as any)).toEqual([]);
});
