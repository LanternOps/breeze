import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
const m = vi.hoisted(() => ({ rows: [] as unknown[][], inserts: [] as unknown[], predicates: [] as any[], links: vi.fn(), add: vi.fn(), update: vi.fn() }));
vi.mock('../../../db', () => {
  const tx: any = {
    transaction: (fn: any) => fn(tx),
    select: () => {
      const result = m.rows.shift() ?? [];
      const c: any = { from: () => c, where: (p: any) => { m.predicates.push(p); return c; },
        limit: () => c, for: () => c, orderBy: () => c,
        then: (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject) };
      return c;
    },
    insert: (table: unknown) => ({ values: (value: unknown) => {
      m.inserts.push({ table, value });
      const c: any = { onConflictDoNothing: () => c, returning: async () => [{ id: '20000000-0000-4000-8000-000000000003' }] };
      return c;
    } }),
  };
  return { db: tx };
});
vi.mock('../../../services/configurationPolicy', () => ({ listFeatureLinks: m.links, addFeatureLink: m.add, updateFeatureLink: m.update }));
import { applyStandardAlertPolicy } from './configureDefaults.monitors';
import { alertRules, configPolicyAssignments, configurationPolicies } from '../../../db/schema';
const ORG = '20000000-0000-4000-8000-000000000001';
const PARTNER = '20000000-0000-4000-8000-000000000002';
const MONITOR = '20000000-0000-4000-8000-000000000004';
const OTHER = '20000000-0000-4000-8000-000000000005';
beforeEach(() => {
  vi.resetAllMocks(); m.rows = []; m.inserts = []; m.predicates = [];
  m.links.mockResolvedValue([]); m.add.mockResolvedValue({ id: 'link-1' });
});
describe('baseline monitor attachments', () => {
  it('creates an org policy, assignment and monitors link, never a legacy rule', async () => {
    m.rows = [[{ id: ORG }], [{ id: MONITOR }], []];
    expect(await applyStandardAlertPolicy(ORG, 'standard', PARTNER)).toEqual({ created: true });
    expect(m.inserts).toContainEqual({ table: configurationPolicies, value: expect.objectContaining({ orgId: ORG, partnerId: null, createdBy: null }) });
    expect(m.inserts).toContainEqual({ table: configPolicyAssignments, value: expect.objectContaining({ targetId: ORG, level: 'organization', assignedBy: null }) });
    expect(m.inserts.some((x: any) => x.table === alertRules)).toBe(false);
    expect(m.add).toHaveBeenCalledWith(expect.any(String), 'monitors', null,
      expect.objectContaining({ inheritance: 'cumulative', items: [{ monitorId: MONITOR, enabled: true, overrides: null, sortOrder: 0 }] }), undefined, expect.anything());
    const query = m.predicates.map((p) => new PgDialect().sqlToQuery(p));
    expect(query[0]!.params).toEqual([ORG, PARTNER]);
    expect(query[1]!.sql).toContain('"builtin_key" is not null');
    expect(query[1]!.params).toContain(PARTNER);
  });
  it('preserves a disabled attachment, custom overrides and replace inheritance', async () => {
    m.rows = [[{ id: ORG }], [{ id: MONITOR }, { id: OTHER }], [{ id: 'policy', status: 'active' }]];
    const existing = { monitorId: MONITOR, enabled: false, overrides: { value: 95 }, sortOrder: 8 };
    m.links.mockResolvedValue([{ id: 'link', featureType: 'monitors', inlineSettings: { inheritance: 'replace', items: [existing] } }]);
    await applyStandardAlertPolicy(ORG, 'standard', PARTNER);
    expect(m.update).toHaveBeenCalledWith('link', { inlineSettings: {
      checkIntervalSeconds: 60, inheritance: 'replace', items: [existing, { monitorId: OTHER, enabled: true, overrides: null, sortOrder: 9 }],
    } }, 'policy', undefined, expect.anything());
  });
  it('does not rewrite a fully attached baseline', async () => {
    m.rows = [[{ id: ORG }], [{ id: MONITOR }], [{ id: 'policy', status: 'active' }]];
    m.links.mockResolvedValue([{ id: 'link', featureType: 'monitors', inlineSettings: { items: [{ monitorId: MONITOR, enabled: false, overrides: null, sortOrder: 0 }], inheritance: 'cumulative' } }]);
    // The assignment already exists; returning [] makes this a genuine no-op.
    const { db } = await import('../../../db');
    vi.spyOn(db, 'insert').mockReturnValueOnce({ values: () => ({ onConflictDoNothing: () => ({ returning: async () => [] }) }) } as never);
    expect(await applyStandardAlertPolicy(ORG, 'standard', PARTNER)).toEqual({ created: false });
    expect(m.update).not.toHaveBeenCalled();
    expect(m.add).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
  it('does not create policies when built-ins are absent and respects an inactive baseline', async () => {
    m.rows = [[{ id: ORG }], []];
    expect(await applyStandardAlertPolicy(ORG, 'cis', PARTNER)).toMatchObject({ created: false, skipped_reason: 'no enabled built-in monitors found' });
    m.rows = [[{ id: ORG }], [{ id: MONITOR }], [{ id: 'policy', status: 'archived' }]];
    expect(await applyStandardAlertPolicy(ORG, 'cis', PARTNER)).toMatchObject({ created: false, skipped_reason: 'default monitoring policy is inactive' });
    expect(m.inserts).toEqual([]);
  });
  it('fails closed on a missing or cross-partner organization', async () => {
    m.rows = [[]];
    await expect(applyStandardAlertPolicy(ORG, 'standard', PARTNER)).rejects.toThrow('Organization not found for bootstrap partner');
    expect(m.inserts).toEqual([]);
    expect(m.add).not.toHaveBeenCalled();
  });
});
