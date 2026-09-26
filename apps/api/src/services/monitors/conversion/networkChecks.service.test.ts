import { beforeEach, expect, it, vi } from 'vitest';
import type { AuthContext } from '../../../middleware/auth';
import { configurationPolicies, configPolicyAssignments, configPolicyFeatureLinks, configPolicyMonitors, monitorConversions, networkMonitors, networkMonitorAlertRules, organizations } from '../../../db/schema';
import { previewNetworkCheckConversion, convertNetworkChecks, networkPreviewHash, findOrCreateNetworkChecksPolicy } from './networkChecks';
const mocks = vi.hoisted(() => ({ runtime: { NETWORK_CHECK_DEVICE_INDEPENDENT_EVALUATION: true as boolean | undefined }, tx: undefined as any,
  create: vi.fn(), policy: vi.fn(), assign: vi.fn(), link: vi.fn(), snapshot: vi.fn(), carry: vi.fn() }));
vi.mock('../../alertConditions/handlers/networkCheck', () => ({ get NETWORK_CHECK_DEVICE_INDEPENDENT_EVALUATION() { return mocks.runtime.NETWORK_CHECK_DEVICE_INDEPENDENT_EVALUATION; }, networkCheckHandler: { type: 'network_check' } }));
vi.mock('./convert', () => ({ inCallerTransaction: (_auth: unknown, fn: (tx: unknown) => unknown) => fn(mocks.tx), lockConversion: vi.fn() }));
vi.mock('../monitorService', () => ({ createMonitorDefinition: mocks.create }));
vi.mock('../../configurationPolicy', () => ({ createConfigPolicy: mocks.policy, assignPolicy: mocks.assign, addFeatureLink: mocks.link }));
vi.mock('./networkHistory', () => ({ snapshotNetworkSource: mocks.snapshot, carryNetworkAlerts: mocks.carry, retireNetworkCheck: vi.fn(), revertNetworkCheckConversion: vi.fn() }));
const auth = { scope: 'organization', user: { id: 'user' }, canAccessOrg: (id: string) => id === 'org' } as unknown as AuthContext;
const row = { id: 'legacy', orgId: 'org', name: 'Gateway', monitorType: 'icmp_ping', target: 'example.com', config: {},
  assetId: null, siteId: null, pollingInterval: 60, timeout: 5, isActive: false, managedByMonitorId: null, retiredAt: null };
const rule = { id: 'rule', monitorId: 'legacy', condition: 'offline', threshold: null, severity: 'high', message: 'custom', isActive: true, retiredAt: null };
const data = new Map<unknown, unknown[]>();
const writes: Array<{ table: unknown; values: any }> = [];
beforeEach(() => {
  vi.clearAllMocks(); data.clear(); writes.length = 0;
  mocks.runtime.NETWORK_CHECK_DEVICE_INDEPENDENT_EVALUATION = true;
  data.set(networkMonitors, [row]); data.set(networkMonitorAlertRules, [rule]); data.set(organizations, [{ name: 'Customer' }]);
  mocks.tx = {
    select: vi.fn(() => {
      let table: unknown;
      const query: any = { from: (value: unknown) => { table = value; return query; }, then: (resolve: any) => Promise.resolve(data.get(table) ?? []).then(resolve) };
      for (const method of ['where', 'orderBy', 'for', 'limit']) query[method] = () => query;
      return query;
    }),
    insert: vi.fn((table: unknown) => ({ values: (values: unknown) => { writes.push({ table, values }); return { returning: async () => [{ id: 'conversion' }] }; } })),
    update: vi.fn((table: unknown) => ({ set: (values: unknown) => ({ where: async () => { writes.push({ table, values }); } }) })),
  };
  mocks.policy.mockResolvedValue({ id: 'policy' }); mocks.link.mockResolvedValue({ id: 'link' });
  mocks.create.mockResolvedValue({ id: 'definition', compiledAlertRuleId: 'compiled' });
  mocks.snapshot.mockResolvedValue({ name: 'Gateway' }); mocks.carry.mockResolvedValue([{ id: 'alert', context: { source: 'network_monitor' } }]);
});
it.each([undefined, false])('blocks missing capability without even opening source reads', async capability => {
  mocks.runtime.NETWORK_CHECK_DEVICE_INDEPENDENT_EVALUATION = capability;
  expect(await previewNetworkCheckConversion('org', auth)).toMatchObject({ orgId: 'org', previewHash: '', blockedBy: 'prerequisite_missing', items: [] });
  await expect(convertNetworkChecks('org', 'hash', auth)).rejects.toMatchObject({ missing: expect.any(Array) });
  expect(mocks.tx.select).not.toHaveBeenCalled(); expect(writes).toEqual([]);
});
it('previews representable and unsupported checks distinctly', async () => {
  expect((await previewNetworkCheckConversion('org', auth)).items[0]).toMatchObject({ outcome: 'convertible', proposed: [{ enabled: false }] });
  data.set(networkMonitorAlertRules, [{ ...rule, condition: 'degraded' }]);
  expect((await previewNetworkCheckConversion('org', auth)).items[0]).toMatchObject({ outcome: 'unconvertible', reason: 'unconvertible:network_predicate_unsupported' });
});
it('rejects changed authoring inputs before writes', async () => {
  await expect(convertNetworkChecks('org', 'stale', auth)).rejects.toMatchObject({ code: 'stale_preview' });
  expect(writes).toEqual([]); expect(mocks.policy).not.toHaveBeenCalled();
});
it('refuses invisible selected source before ledger inserts', async () => {
  const preview = await previewNetworkCheckConversion('org', auth);
  await expect(convertNetworkChecks('org', preview.previewHash, auth, { sourceIds: ['foreign'] })).rejects.toMatchObject({ code: 'source_not_found', status: 404 });
  expect(writes).toEqual([]);
});
it('adopts with the executor, disabled state, named snapshot and alert provenance', async () => {
  const preview = await previewNetworkCheckConversion('org', auth);
  expect(await convertNetworkChecks('org', preview.previewHash, auth)).toEqual({ conversionIds: ['conversion'], retired: 0, monitorsCreated: 1, policyId: 'policy' });
  expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ enabled: false, description: 'custom', cooldownMinutes: 5, autoResolve: true }), auth, { adoptNetworkMonitorId: 'legacy' }, mocks.tx);
  expect(mocks.policy).toHaveBeenCalledWith({ orgId: 'org' }, { name: 'Network checks — Customer' }, 'user', mocks.tx);
  expect(mocks.link).toHaveBeenCalledWith('policy', 'monitors', null, { items: [], inheritance: 'cumulative' }, undefined, mocks.tx);
  expect(writes).toContainEqual({ table: monitorConversions, values: expect.objectContaining({ orgId: 'org', partnerId: null, sourceState: { name: 'Gateway' }, networkSourceSnapshot: { name: 'Gateway' } }) });
  expect(writes).toContainEqual({ table: configPolicyMonitors, values: expect.objectContaining({ enabled: false }) });
});
it('persists null system actor', async () => {
  const system = { ...auth, scope: 'system' } as AuthContext;
  await convertNetworkChecks('org', networkPreviewHash([row as never], new Map([['legacy', [rule as never]]])), system);
  expect(writes.find(w => w.table === monitorConversions)?.values.convertedBy).toBeNull();
});
it.each(['inactive', 'filtered', 'replace', 'unassigned'])('does not reuse an ineligible policy: %s', async problem => {
  data.set(monitorConversions, [{ policyId: 'old' }]);
  data.set(configurationPolicies, problem === 'inactive' ? [] : [{ id: 'old', parentPolicyId: null }]);
  data.set(configPolicyAssignments, problem === 'unassigned' ? [] : [{ level: 'organization', targetId: 'org', roleFilter: problem === 'filtered' ? ['server'] : null, osFilter: null }]);
  data.set(configPolicyFeatureLinks, [{ id: 'old-link', inlineSettings: { inheritance: problem === 'replace' ? 'replace' : 'cumulative' } }]);
  expect(await findOrCreateNetworkChecksPolicy('org', auth, mocks.tx)).toEqual({ policyId: 'policy', monitorsLinkId: 'link' });
  expect(mocks.policy).toHaveBeenCalledOnce();
});
it('reuses only a cumulative unfiltered org-assigned active policy', async () => {
  data.set(monitorConversions, [{ policyId: 'old' }]); data.set(configurationPolicies, [{ id: 'old', parentPolicyId: null }]);
  data.set(configPolicyAssignments, [{ level: 'organization', targetId: 'org', roleFilter: null, osFilter: null }]);
  data.set(configPolicyFeatureLinks, [{ id: 'old-link', inlineSettings: { inheritance: 'cumulative' } }]);
  expect(await findOrCreateNetworkChecksPolicy('org', auth, mocks.tx)).toEqual({ policyId: 'old', monitorsLinkId: 'old-link' });
  expect(mocks.policy).not.toHaveBeenCalled();
});
it('preserves existing feature settings when refreshing the attachment snapshot', async () => {
  data.set(configPolicyFeatureLinks, [{ id: 'link', inlineSettings: { inheritance: 'cumulative', checkIntervalSeconds: 120 } }]);
  const preview = await previewNetworkCheckConversion('org', auth);
  await convertNetworkChecks('org', preview.previewHash, auth);
  expect(writes.find(w => w.table === configPolicyFeatureLinks)?.values.inlineSettings).toMatchObject({ checkIntervalSeconds: 120, inheritance: 'cumulative' });
});
