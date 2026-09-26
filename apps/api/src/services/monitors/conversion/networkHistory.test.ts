import { describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../../../middleware/auth';
import { alerts, monitorConversions, networkMonitors, networkMonitorAlertRules, monitorDefinitions } from '../../../db/schema';
import { carryNetworkAlerts, snapshotNetworkSource, retireNetworkCheckInTx, revertNetworkCheckConversionInTx } from './networkHistory';
import { OPEN_ALERT_STATUSES } from './loadSources';

vi.mock('./convert', () => ({ inCallerTransaction: vi.fn(), lockConversion: vi.fn() }));

const auth = { scope: 'organization', user: { id: 'user' }, canAccessOrg: (id: string) => id === 'org' } as unknown as AuthContext;
const source = {
  id: 'legacy', orgId: 'org', name: 'Gateway', monitorType: 'http', target: 'https://old.example.com',
  config: { followRedirects: true }, pollingInterval: 60, timeout: 5,
  assetId: null, siteId: 'site', isActive: true, retiredAt: null, retiredReason: null, managedByMonitorId: null,
};
const definition = { id: 'definition', compiledAlertRuleId: 'compiled' };

function executor(results: unknown[][]) {
  const writes: Array<{ table: unknown; values: Record<string, unknown> }> = [];
  const inserts: Array<{ table: unknown; values: Record<string, unknown> }> = [];
  const deletes: unknown[] = [];
  const tx = {
    select: vi.fn(() => {
      const rows = results.shift() ?? [];
      const query: Record<string, unknown> = {};
      for (const method of ['from', 'where', 'innerJoin', 'leftJoin', 'for', 'limit', 'orderBy']) query[method] = () => query;
      query.then = (resolve: (value: unknown[]) => unknown) => Promise.resolve(rows).then(resolve);
      return query;
    }),
    update: vi.fn((table: unknown) => ({ set: (values: Record<string, unknown>) => ({ where: async () => { writes.push({ table, values }); } }) })),
    insert: vi.fn((table: unknown) => ({ values: (values: Record<string, unknown>) => {
      inserts.push({ table, values });
      const result = { onConflictDoNothing: () => result, returning: async () => [{ id: 'conversion' }] };
      return result;
    } })),
    delete: vi.fn((table: unknown) => ({ where: async () => { deletes.push(table); } })),
  };
  return { tx, writes, inserts, deletes };
}

describe('carryNetworkAlerts', () => {
  it('carries every shared open status with original refs and never writes a resolution', async () => {
    const rows = OPEN_ALERT_STATUSES.map((status, i) => ({ id: `a-${i}`, status, ruleId: null,
      configPolicyId: null, monitorId: null, context: { source: 'network_monitor', monitorId: 'legacy', alertRuleId: 'rule' } }));
    const { tx, writes } = executor([rows]);
    const refs = await carryNetworkAlerts(tx as never, source as never, definition as never);
    expect(refs.map(r => r.id)).toEqual(rows.map(r => r.id));
    expect(refs[2]?.context).toEqual(rows[2]?.context);
    expect(writes).toHaveLength(OPEN_ALERT_STATUSES.length);
    for (const { values } of writes) {
      expect(values).toMatchObject({ ruleId: 'compiled', configPolicyId: null, monitorId: 'definition',
        context: { convertedFrom: { sourceTable: 'network_monitors', sourceId: 'legacy' } } });
      expect(values).not.toHaveProperty('status');
      expect(values).not.toHaveProperty('resolvedAt');
    }
  });

  it('preserves all same-device open alerts without colliding on the compiled rule subject identity', async () => {
    const rows = OPEN_ALERT_STATUSES.map((status, i) => ({ id: `a-${i}`, status, deviceId: 'device', subjectKey: null,
      ruleId: null, configPolicyId: null, monitorId: null,
      context: { source: 'network_monitor', monitorId: 'legacy', alertRuleId: `legacy-rule-${i}` } }));
    const { tx, writes } = executor([rows]);
    const refs = await carryNetworkAlerts(tx as never, source as never, definition as never);
    expect(refs.map(ref => ref.subjectKey)).toEqual([null, null, null]);
    const effectiveSubjects = writes.map(({ values }, i) => values.subjectKey ?? rows[i]!.subjectKey);
    expect(effectiveSubjects[0]).toBeNull();
    expect(new Set(effectiveSubjects).size).toBe(3);
    expect(effectiveSubjects.slice(1).every(subject => typeof subject === 'string' && subject.length > 0)).toBe(true);
  });

  it('keeps distinct existing device and subject identities unchanged', async () => {
    const rows = [
      { id: 'a', deviceId: 'device-1', subjectKey: null },
      { id: 'b', deviceId: 'device-2', subjectKey: null },
      { id: 'c', deviceId: 'device-1', subjectKey: 'latency' },
    ].map(row => ({ ...row, ruleId: null, configPolicyId: null, monitorId: null, context: null }));
    const { tx, writes } = executor([rows]);
    const refs = await carryNetworkAlerts(tx as never, source as never, definition as never);
    expect(refs.map(ref => ref.subjectKey)).toEqual([null, null, 'latency']);
    expect(writes.map(({ values }, i) => values.subjectKey ?? rows[i]!.subjectKey)).toEqual([null, null, 'latency']);
  });

  it('rejects malformed historical context before changing any alert', async () => {
    const { tx, writes } = executor([[{ id: 'valid', context: null }, { id: 'bad', context: ['legacy'] }]]);
    await expect(carryNetworkAlerts(tx as never, source as never, definition as never)).rejects.toThrow('unsupported context');
    expect(writes).toEqual([]);
  });

  it('requires a compiled rule before reading or writing alerts', async () => {
    const { tx } = executor([]);
    await expect(carryNetworkAlerts(tx as never, source as never, { ...definition, compiledAlertRuleId: null } as never)).rejects.toThrow('network_compiled_rule_missing');
    expect(tx.select).not.toHaveBeenCalled();
  });
});

it('snapshots the source site and every rule retirement state', async () => {
  const retiredAt = new Date('2026-09-01T00:00:00.000Z');
  const rules = [{ id: 'active-rule', retiredAt: null, retiredReason: null, isActive: true },
    { id: 'old-rule', retiredAt, retiredReason: 'operator', isActive: false }];
  const { tx } = executor([rules]);
  expect(await snapshotNetworkSource(tx as never, source as never)).toEqual({
    name: source.name, monitorType: source.monitorType, target: source.target, config: source.config,
    pollingInterval: 60, timeout: 5, assetId: null, siteId: 'site', isActive: true, retiredAt: null, retiredReason: null,
    rules: [rules[0], { ...rules[1], retiredAt: retiredAt.toISOString() }],
  });
});

describe('retireNetworkCheckInTx', () => {
  it('writes a named zero-output ledger and preserves alerts', async () => {
    const { tx, writes, inserts } = executor([[source], [source], [], []]);
    expect(await retireNetworkCheckInTx(tx as never, 'legacy', 'operator', auth)).toEqual({ conversionId: 'conversion' });
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({ table: monitorConversions, values: { sourceTable: 'network_monitors', sourceId: 'legacy', orgId: 'org', partnerId: null,
      policyId: null, sourceState: { name: 'Gateway' }, convertedBy: 'user', networkSourceSnapshot: { siteId: 'site', rules: [] } } });
    expect(writes.find(write => write.table === networkMonitors)?.values).toMatchObject({ isActive: false, retiredReason: 'operator', retiredAt: expect.any(Date) });
    expect(writes.some(write => write.table === networkMonitorAlertRules)).toBe(true);
    expect(writes.some(write => write.table === alerts)).toBe(false);
  });

  it.each([{ rows: [] }, { rows: [{ ...source, orgId: 'other' }] }])('refuses invisible sources before creating a global ledger entry (%j)', async ({ rows }) => {
    const { tx, writes, inserts } = executor([rows]);
    await expect(retireNetworkCheckInTx(tx as never, 'legacy', 'operator', auth)).rejects.toMatchObject({ status: 404 });
    expect(writes).toEqual([]);
    expect(inserts).toEqual([]);
  });

  it.each([{ allowedSiteIds: [] }, { allowedDeviceIds: [] }])('refuses restricted callers before reads (%j)', async ceiling => {
    const { tx } = executor([]);
    await expect(retireNetworkCheckInTx(tx as never, 'legacy', 'operator', { ...auth, ...ceiling } as AuthContext)).rejects.toMatchObject({ status: 403 });
    expect(tx.select).not.toHaveBeenCalled();
  });

  it('rejects unsupported retirement reasons before reads', async () => {
    const { tx } = executor([]);
    await expect(retireNetworkCheckInTx(tx as never, 'legacy', 'arbitrary', auth)).rejects.toMatchObject({ status: 400 });
    expect(tx.select).not.toHaveBeenCalled();
  });

  it.each([{ retiredAt: new Date() }, { managedByMonitorId: 'definition' }])('rejects already retired or managed sources (%j)', async state => {
    const { tx, inserts } = executor([[{ ...source, ...state }], [{ ...source, ...state }]]);
    await expect(retireNetworkCheckInTx(tx as never, 'legacy', 'operator', auth)).rejects.toMatchObject({ status: 409 });
    expect(inserts).toEqual([]);
  });

  it('refuses another live ledger entry without duplicate writes', async () => {
    const { tx, inserts, writes } = executor([[source], [source], [{ id: 'other-conversion' }]]);
    await expect(retireNetworkCheckInTx(tx as never, 'legacy', 'operator', auth)).rejects.toMatchObject({ status: 409 });
    expect(inserts).toEqual([]);
    expect(writes).toEqual([]);
  });

  it('persists null for system actors', async () => {
    const { tx, inserts } = executor([[source], [source], [], []]);
    await retireNetworkCheckInTx(tx as never, 'legacy', 'operator', { ...auth, scope: 'system' } as AuthContext);
    expect(inserts[0]?.values.convertedBy).toBeNull();
  });
});


describe('revertNetworkCheckConversionInTx', () => {
  const snapshot = {
    name: source.name, monitorType: source.monitorType, target: source.target, config: source.config,
    pollingInterval: 60, timeout: 5, assetId: null, siteId: 'site', isActive: true,
    retiredAt: null, retiredReason: null,
    rules: [{ id: 'rule', retiredAt: null, retiredReason: null, isActive: true }],
  };
  const entry = { id: 'conversion', orgId: 'org', sourceTable: 'network_monitors', sourceId: 'legacy',
    policyId: null, revertedAt: null, networkSourceSnapshot: snapshot };

  it('restores a zero-output retirement and preserves its site and rule states', async () => {
    const { tx, writes, deletes } = executor([[entry], [{ ...source, isActive: false, retiredAt: new Date() }], []]);
    await revertNetworkCheckConversionInTx(tx as never, entry as never, auth);
    expect(writes.find(write => write.table === networkMonitors)?.values).toMatchObject({
      name: 'Gateway', siteId: 'site', isActive: true, retiredAt: null, retiredReason: null, managedByMonitorId: null,
    });
    expect(writes.find(write => write.table === networkMonitorAlertRules)?.values).toMatchObject({ isActive: true, retiredAt: null, retiredReason: null });
    expect(writes.find(write => write.table === monitorConversions)?.values).toEqual({ revertedAt: expect.any(Date) });
    expect(writes.some(write => write.table === alerts)).toBe(false);
    expect(deletes).toEqual([]);
  });

  it('restores original refs and rehomes later terminal alerts before releasing and deleting the definition', async () => {
    const refs = [{ id: 'original-alert', ruleId: null, configPolicyId: null, monitorId: null, subjectKey: null,
      context: { source: 'network_monitor', monitorId: 'legacy', alertRuleId: 'rule' } }];
    const output = { monitorId: 'definition', movedAlertRefs: refs };
    const later = { id: 'later-alert', status: 'resolved', ruleId: 'compiled', monitorId: 'definition', context: { source: 'monitor' } };
    const { tx, writes, deletes } = executor([[entry], [{ ...source, managedByMonitorId: 'definition' }], [output], [{ id: 'definition', orgId: 'org' }], [], [], [later]]);
    await revertNetworkCheckConversionInTx(tx as never, entry as never, auth);
    const alertWrites = writes.filter(write => write.table === alerts);
    expect(alertWrites).toHaveLength(2);
    expect(alertWrites[0]?.values).toEqual({ ruleId: null, configPolicyId: null, monitorId: null, subjectKey: null, context: refs[0]!.context });
    expect(alertWrites[1]?.values).toMatchObject({ ruleId: null, configPolicyId: null, monitorId: null,
      context: { source: 'network_monitor', monitorId: 'legacy', alertRuleId: 'rule' } });
    for (const { values } of alertWrites) {
      expect(values).not.toHaveProperty('status');
      expect(values).not.toHaveProperty('resolvedAt');
    }
    expect(writes.find(write => write.table === networkMonitors)?.values.managedByMonitorId).toBeNull();
    expect(deletes).toEqual([monitorDefinitions]);
    const releaseCall = tx.update.mock.calls.findIndex(([table]) => table === networkMonitors);
    expect(tx.update.mock.invocationCallOrder[releaseCall]).toBeLessThan(tx.delete.mock.invocationCallOrder[0]!);
  });

  it.each([
    { other: [{ id: 'other-conversion' }], attachments: [] },
    { other: [], attachments: [{ policyId: 'foreign-policy' }] },
  ])('refuses outputs used by another conversion or policy before writes (%j)', async ({ other, attachments }) => {
    const { tx, writes, deletes } = executor([[entry], [source], [{ monitorId: 'definition', movedAlertRefs: [] }], [{ id: 'definition', orgId: 'org' }], other, attachments]);
    await expect(revertNetworkCheckConversionInTx(tx as never, entry as never, auth)).rejects.toMatchObject({ code: 'network_revert_in_use', status: 409 });
    expect(writes).toEqual([]);
    expect(deletes).toEqual([]);
  });

  it('restores asset binding to the asset current site and invalidates changed endpoint TLS evidence', async () => {
    const bound = { ...entry, networkSourceSnapshot: { ...snapshot, assetId: 'asset', siteId: 'old-site' } };
    const edited = { ...source, assetId: 'asset', siteId: 'new-site', target: 'https://changed.example.com', tlsState: 'observed' };
    const { tx, writes } = executor([[bound], [edited], [], [{ id: 'asset', orgId: 'org', siteId: 'new-site' }]]);
    await revertNetworkCheckConversionInTx(tx as never, bound as never, auth);
    expect(writes.find(write => write.table === networkMonitors)?.values).toMatchObject({
      assetId: 'asset', siteId: 'new-site', target: source.target,
      tlsState: null, tlsObservedAt: null, tlsObservedHost: null, tlsNotAfter: null, tlsIssuer: null,
    });
  });

  it('preserves TLS evidence when the endpoint identity is unchanged', async () => {
    const { tx, writes } = executor([[entry], [source], []]);
    await revertNetworkCheckConversionInTx(tx as never, entry as never, auth);
    const update = writes.find(write => write.table === networkMonitors)?.values ?? {};
    expect(Object.keys(update).some(key => key.startsWith('tls'))).toBe(false);
  });

  it('refuses cross-org reversal before any read or write', async () => {
    const { tx, writes } = executor([]);
    await expect(revertNetworkCheckConversionInTx(tx as never, { ...entry, orgId: 'other' } as never, auth)).rejects.toMatchObject({ status: 404 });
    expect(tx.select).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it('refuses a missing snapshot without writes', async () => {
    const missing = { ...entry, networkSourceSnapshot: null };
    const { tx, writes } = executor([[missing], [source], []]);
    await expect(revertNetworkCheckConversionInTx(tx as never, missing as never, auth)).rejects.toMatchObject({ code: 'network_source_snapshot_missing', status: 409 });
    expect(writes).toEqual([]);
  });

  it('refuses already reverted entries', async () => {
    const { tx, writes } = executor([[{ ...entry, revertedAt: new Date() }]]);
    await expect(revertNetworkCheckConversionInTx(tx as never, entry as never, auth)).rejects.toMatchObject({ status: 409 });
    expect(writes).toEqual([]);
  });
});
