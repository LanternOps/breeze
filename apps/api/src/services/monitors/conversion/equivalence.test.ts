import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { diffSignatureSets, signatureMapForLegacy, signatureMapForMonitors, computeEquivalence, applyProposalInTx } from './equivalence';
import { resolveLegacyBaseline, resolveDeviceIdsForPolicy } from './legacyBaseline';
import { mapInlineRule } from './mapping';
import { db, withDbAccessContext } from '../../../db';
import { alerts, configPolicyAlertRules, configPolicyFeatureLinks, configPolicyMonitors, monitorConversions, monitorConversionOutputs } from '../../../db/schema';
import { resolveMonitorsForDevice } from '../monitorResolver';
import { loadPolicySources } from './loadSources';
import { createMonitorDefinition } from '../monitorService';

vi.mock('./legacyBaseline', async (original) => ({ ...await original<typeof import('./legacyBaseline')>(), resolveLegacyBaseline: vi.fn() }));
vi.mock('../../../db', async (original) => ({ ...await original<typeof import('../../../db')>(), db: { transaction: vi.fn() },
  getCurrentDbAccessContext: () => ({ scope: 'organization', orgId: 'org', accessibleOrgIds: ['org'] }),
  withDbAccessContext: vi.fn(async (_context, fn) => fn()),
}));
vi.mock('../monitorResolver', () => ({ resolveMonitorsForDevice: vi.fn() }));
vi.mock('./loadSources', () => ({ loadPolicySources: vi.fn() }));
vi.mock('../monitorService', () => ({ createMonitorDefinition: vi.fn() }));
vi.mock('../../configurationPolicy', () => ({ addFeatureLink: vi.fn(), getConfigPolicy: vi.fn() }));
vi.mock('./convert', () => ({ ConversionError: class extends Error { constructor(readonly code: string, message: string) { super(message); } } }));

const rule = { id: 'rule', name: 'CPU', conditions: [{ type: 'metric', metric: 'cpu', operator: 'gt', value: 80 }],
  cooldownMinutes: 5, autoResolve: true, autoResolveConditions: null, severity: 'high', notificationChannelIds: null,
  escalationPolicyId: 'escalation-a', retiredAt: null };
const device = { id: 'device', orgId: 'org', siteId: 'site' };
const route = { id: 'route', orgId: 'org', partnerId: null, enabled: true, isDefault: false, priority: 0,
  conditions: {}, channelIds: ['channel'], escalationPolicyId: 'escalation-b' };
const channel = { id: 'channel', orgId: 'org', partnerId: null, enabled: true };
function fixture(results: unknown[][]) {
  const predicates: unknown[] = [];
  const query = () => {
    if (!results.length) throw new Error('Unexpected query');
    const rows = results.shift()!;
    const chain: any = { then: (yes: any, no: any) => Promise.resolve(rows).then(yes, no) };
    for (const method of ['from', 'where', 'limit', 'orderBy', 'innerJoin', 'leftJoin']) chain[method] = (...args: unknown[]) => {
      if (method === 'where') predicates.push(args[0]);
      return chain;
    };
    return chain;
  };
  return { tx: { select: query, selectDistinct: query, insert: vi.fn(), update: vi.fn() } as any, predicates };
}
function proposed() {
  const result = mapInlineRule(rule as never);
  if (!result.ok) throw new Error('Invalid fixture');
  return result.proposed[0]!;
}
beforeEach(() => vi.clearAllMocks());

describe('diffSignatureSets', () => {
  it('compares behavior as a multiset independent of source labels', () => {
    expect(diffSignatureSets(new Map([['old', 'a']]), new Map([['new', 'a']]))).toEqual([]);
    expect(diffSignatureSets(new Map(), new Map([['new', 'a']]))).toEqual(['gains 1 condition instance(s): a']);
    expect(diffSignatureSets(new Map([['old', 'a']]), new Map())).toEqual(['loses 1 condition instance(s): a']);
    expect(diffSignatureSets(new Map([['old', 'a']]), new Map([['new', 'b']]))).toHaveLength(2);
    expect(diffSignatureSets(new Map([['one', 'a'], ['two', 'a']]), new Map([['new', 'a']]))).toEqual(['loses 1 condition instance(s): a']);
  });
});

it('preserves explicit legacy escalation with inherited channels; dropping it changes behavior', async () => {
  const beforeTx = fixture([[device], [], [{ partnerId: 'partner' }], [route], [channel]]).tx;
  const before = await signatureMapForLegacy('device', { rules: [rule as never], monitoring: null }, beforeTx);
  for (const escalation of ['escalation-a', null]) {
    const def = { ...proposed(), id: 'monitor', escalationPolicyId: escalation };
    vi.mocked(resolveMonitorsForDevice).mockResolvedValue({ kind: 'resolved', monitors: [{ monitorId: 'monitor', enabled: true, overrides: null } as never] });
    const afterTx = fixture([[def], [device], [{ partnerId: 'partner' }], [def], [route], [channel]]).tx;
    const after = await signatureMapForMonitors('device', afterTx);
    expect(diffSignatureSets(before, after).length).toBe(escalation ? 0 : 2);
  }
});

it('retired sources supply neither behavior nor legacy escalation', async () => {
  const { tx } = fixture([[device]]);
  expect(await signatureMapForLegacy('device', { rules: [{ ...rule, retiredAt: new Date() } as never], monitoring: null }, tx)).toEqual(new Map());
});

it('kind-specific routing can introduce a delta after conversion', async () => {
  const kindRoute = { ...route, conditions: { monitorKinds: ['cpu'] } };
  const before = await signatureMapForLegacy('device', { rules: [rule as never], monitoring: null }, fixture([[device], [], [{ partnerId: 'partner' }], [kindRoute]]).tx);
  const def = { ...proposed(), id: 'monitor' };
  vi.mocked(resolveMonitorsForDevice).mockResolvedValue({ kind: 'resolved', monitors: [{ monitorId: 'monitor', enabled: true, overrides: null } as never] });
  const after = await signatureMapForMonitors('device', fixture([[def], [device], [{ partnerId: 'partner' }], [def], [kindRoute], [channel]]).tx);
  expect(diffSignatureSets(before, after)).toHaveLength(2);
});

it('scope query includes inherited consumers and applies server-only role / OS predicates', async () => {
  const { tx, predicates } = fixture([[{ id: 'server' }]]);
  expect(await resolveDeviceIdsForPolicy('policy', tx)).toEqual(['server']);
  const sql = new PgDialect().sqlToQuery(predicates[0] as never).sql;
  expect(sql).toContain('"role_filter"');
  expect(sql).toContain('"os_filter"');
  expect(sql).toContain('"source_policy_id"');
});

it('refuses invisible sources before any ledger or monitor writes', async () => {
  const { tx } = fixture([]);
  vi.mocked(loadPolicySources).mockResolvedValue({ policy: { id: 'policy', orgId: 'org', partnerId: null }, inlineRules: [], watches: [], standaloneAutomations: [], policyAutomations: [] } as never);
  await expect(applyProposalInTx(tx, { policy: { id: 'policy', orgId: 'org', partnerId: null } as never, inheritanceMode: 'replace', bySource: [{ sourceTable: 'config_policy_alert_rules', sourceId: 'foreign', monitors: [proposed()] }] }, { scope: 'organization', canAccessOrg: () => true } as never)).rejects.toMatchObject({ code: 'source_not_found' });
  expect(tx.insert).not.toHaveBeenCalled();
  expect(tx.update).not.toHaveBeenCalled();
  expect(createMonitorDefinition).not.toHaveBeenCalled();
});

it('propagates transaction failures rather than reporting a successful preview', async () => {
  vi.mocked(db.transaction).mockRejectedValue(new Error('database unavailable'));
  await expect(computeEquivalence({ policy: { id: 'policy' } as never, inheritanceMode: 'replace', bySource: [] }, ['device'], {} as never)).rejects.toThrow('database unavailable');
});


it('visits all 501 devices, reports progress, and rolls the dry run back', async () => {
  const ids = Array.from({ length: 501 }, (_, i) => `device-${i}`);
  const { tx } = fixture(Array.from({ length: 1002 }, () => [device]));
  vi.mocked(resolveLegacyBaseline).mockResolvedValue({ rules: [], monitoring: null });
  vi.mocked(resolveMonitorsForDevice).mockResolvedValue({ kind: 'resolved', monitors: [] });
  vi.mocked(loadPolicySources).mockResolvedValue({ policy: { id: 'policy', orgId: 'org', partnerId: null } } as never);
  let rolledBack = false;
  vi.mocked(db.transaction).mockImplementation(async (fn) => {
    try { return await fn(tx); } catch (error) { rolledBack = true; throw error; }
  });
  const onProgress = vi.fn();
  const result = await computeEquivalence({ policy: { id: 'policy', orgId: 'org', partnerId: null } as never,
    inheritanceMode: 'replace', bySource: [] }, ids, { scope: 'organization', canAccessOrg: () => true } as never, onProgress);
  expect(result).toEqual({ devicesChecked: 501, deltas: [] });
  expect(rolledBack).toBe(true);
  expect(withDbAccessContext).toHaveBeenCalledWith({ scope: 'organization', orgId: 'org', accessibleOrgIds: ['org'] }, expect.any(Function), { isolationLevel: 'repeatable read' });
  expect(resolveLegacyBaseline).toHaveBeenCalledTimes(1002);
  expect(onProgress).toHaveBeenCalledTimes(11);
  expect(onProgress).toHaveBeenLastCalledWith(501, 501);
  expect(db.transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'repeatable read' });
});

it('keeps checking after 200 deltas and reports the exact omitted count', async () => {
  const ids = Array.from({ length: 201 }, (_, i) => `device-${i}`);
  const results = [...ids.flatMap(() => [[device], [], [{ partnerId: 'partner' }], [route], [channel]]), ...ids.map(() => [device])];
  const { tx } = fixture(results);
  let calls = 0;
  vi.mocked(resolveLegacyBaseline).mockImplementation(async () => ({ rules: calls++ < ids.length ? [rule as never] : [], monitoring: null }));
  vi.mocked(resolveMonitorsForDevice).mockResolvedValue({ kind: 'resolved', monitors: [] });
  vi.mocked(loadPolicySources).mockResolvedValue({ policy: { id: 'policy', orgId: 'org', partnerId: null } } as never);
  vi.mocked(db.transaction).mockImplementation(async (fn) => fn(tx));
  const result = await computeEquivalence({ policy: { id: 'policy', orgId: 'org', partnerId: null } as never,
    inheritanceMode: 'replace', bySource: [] }, ids, { scope: 'organization', canAccessOrg: () => true } as never);
  expect(result.devicesChecked).toBe(201);
  expect(result.deltas).toHaveLength(201);
  expect(result.deltas.at(-1)).toEqual({ deviceId: '*', detail: '… and 1 more differences' });
});


it('preserves unrelated attachments and carries open alerts before retiring in the same executor', async () => {
  const unrelated = { id: 'keep-attachment', monitorId: 'keep-monitor', enabled: false, overrides: { value: 90 }, sortOrder: 5 };
  const originalAlert = { id: 'open-alert', ruleId: null, configPolicyId: 'rule', monitorId: null, orgId: 'device-org', context: { retained: true } };
  const { tx } = fixture([[], [], [unrelated], [originalAlert]]);
  const writes: Array<{ table: unknown; values: any }> = [];
  tx.insert.mockImplementation((table: unknown) => ({ values: (values: unknown) => {
    writes.push({ table, values });
    const result = table === monitorConversions ? [{ id: 'conversion' }]
      : table === configPolicyMonitors ? [{ ...(values as object), id: 'new-attachment' }] : [];
    const chain: any = { then: (yes: any, no: any) => Promise.resolve(result).then(yes, no), returning: async () => result };
    chain.onConflictDoNothing = () => chain;
    return chain;
  } }));
  tx.update.mockImplementation((table: unknown) => ({ set: (values: unknown) => {
    writes.push({ table, values });
    return { where: () => ({ then: (yes: any, no: any) => Promise.resolve([]).then(yes, no), returning: async () => [{ id: 'rule' }] }) };
  } }));
  vi.mocked(loadPolicySources).mockResolvedValue({ policy: { id: 'policy', orgId: 'org', partnerId: null },
    links: { monitors: { id: 'link', inheritance: 'cumulative', items: [unrelated] } },
    inlineRules: [rule], watches: [], standaloneAutomations: [], policyAutomations: [] } as never);
  vi.mocked(createMonitorDefinition).mockResolvedValue({ ...proposed(), id: 'new-monitor', compiledAlertRuleId: 'compiled-rule', orgId: 'org', partnerId: null } as never);
  const result = await applyProposalInTx(tx, { policy: { id: 'policy', orgId: 'org', partnerId: null } as never,
    inheritanceMode: 'replace', bySource: [{ sourceTable: 'config_policy_alert_rules', sourceId: 'rule', monitors: [proposed()] }] },
    { scope: 'organization', user: { id: 'actor' }, canAccessOrg: () => true } as never);
  expect(result).toEqual({ conversionIds: ['conversion'], retired: 1, monitorsCreated: 1 });
  expect(createMonitorDefinition).toHaveBeenCalledWith(expect.objectContaining({ ownerScope: 'organization', orgId: 'org' }), expect.anything(), {}, tx);
  expect(writes.find((w) => w.table === configPolicyFeatureLinks)?.values.inlineSettings.items).toEqual([
    { monitorId: 'keep-monitor', enabled: false, overrides: { value: 90 }, sortOrder: 5 },
    { monitorId: 'new-monitor', enabled: true, overrides: null, sortOrder: 6 },
  ]);
  expect(writes.find((w) => w.table === monitorConversionOutputs)?.values).toMatchObject({
    orgId: 'org', partnerId: null, conversionId: 'conversion', attachmentId: 'new-attachment', reusedMonitor: false,
    movedAlertIds: ['open-alert'], movedAlertRefs: [{ id: 'open-alert', ruleId: null, configPolicyId: 'rule', monitorId: null, context: { retained: true } }],
  });
  const alertWrite = writes.findIndex((w) => w.table === alerts);
  expect(writes[alertWrite]!.values).toMatchObject({ monitorId: 'new-monitor', ruleId: 'compiled-rule' });
  expect(writes[alertWrite]!.values).not.toHaveProperty('orgId');
  expect(alertWrite).toBeLessThan(writes.findIndex((w) => w.table === configPolicyAlertRules));
});
