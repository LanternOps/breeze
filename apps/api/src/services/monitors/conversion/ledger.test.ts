import { beforeEach, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
const m = vi.hoisted(() => ({ rows: [] as unknown[][], predicates: [] as any[] }));
vi.mock('../../../db', () => ({ db: { select: () => {
  const rows = m.rows.shift() ?? [];
  const c: any = { then: (yes: any, no: any) => Promise.resolve(rows).then(yes, no) };
  for (const method of ['from', 'orderBy', 'limit']) c[method] = () => c;
  c.where = (predicate: unknown) => { m.predicates.push(predicate); return c; };
  return c;
} } }));
vi.mock('../../configurationPolicy', () => ({ getConfigPolicy: vi.fn() }));
vi.mock('./convert', () => ({ ConversionError: class extends Error {
  constructor(public code: string, message: string) { super(message); }
} }));
import { listConversionLedger } from './ledger';
import { getConfigPolicy } from '../../configurationPolicy';
import type { AuthContext } from '../../../middleware/auth';
const ORG = '10000000-0000-4000-8000-000000000001';
const RESPONSE = '10000000-0000-4000-8000-000000000002';
const TARGET = '10000000-0000-4000-8000-000000000003';
const auth: AuthContext = { scope: 'organization', orgId: ORG, partnerId: null, accessibleOrgIds: [ORG],
  principal: { kind: 'user_session' }, token: null,
  user: { id: RESPONSE, email: 'tech@example.com', name: 'Tech', isPlatformAdmin: false },
  orgCondition: () => undefined, canAccessOrg: (id: string) => id === ORG };
const entry = { id: RESPONSE, orgId: ORG, partnerId: null, sourceTable: 'automations', sourceId: RESPONSE,
  policyId: null, convertedBy: null, convertedAt: new Date(0), revertedAt: null,
  sourceState: { name: 'CPU response', targetConversionId: TARGET } };
beforeEach(() => { vi.clearAllMocks(); m.rows = []; m.predicates = []; });
it.each([true, false])('projects response Undo against target liveness outside this page (%s)', async (live) => {
  m.rows = [[entry], live ? [{ id: TARGET }] : [], []];
  const result = await listConversionLedger({ limit: 1 }, auth);
  expect(result.items[0]).toMatchObject({ id: RESPONSE, sourceName: 'CPU response', revertable: !live });
  const dependency = new PgDialect().sqlToQuery(m.predicates[1]);
  expect(dependency.sql).toContain('"reverted_at" is null');
  expect(dependency.params).toEqual([TARGET]);
});
it('retirement has no dependency and network history preserves its stored name', async () => {
  m.rows = [[{ ...entry, sourceTable: 'network_monitors', sourceState: { name: 'Branch gateway' } }], []];
  expect((await listConversionLedger({}, auth)).items[0]).toMatchObject({ sourceName: 'Branch gateway', revertable: true, outputs: [] });
});
it.each([
  { row: { ...entry, revertedAt: new Date(1), sourceState: {} }, caller: auth },
  { row: { ...entry, sourceState: {} }, caller: { ...auth, allowedSiteIds: [] } },
  { row: { ...entry, orgId: null, partnerId: TARGET, sourceState: {} }, caller: auth },
])('retains lifecycle, governance and owner restrictions', async ({ row, caller }) => {
  m.rows = [[row], []];
  expect((await listConversionLedger({}, caller)).items[0]!.revertable).toBe(false);
});

it('denies inaccessible org and policy filters before selecting ledger rows', async () => {
  await expect(listConversionLedger({ orgId: TARGET }, auth)).rejects.toMatchObject({ code: 'partner_wide_denied' });
  expect(getConfigPolicy).not.toHaveBeenCalled();
  vi.mocked(getConfigPolicy).mockResolvedValueOnce(null);
  await expect(listConversionLedger({ policyId: TARGET }, auth)).rejects.toMatchObject({ code: 'policy_not_found' });
  expect(getConfigPolicy).toHaveBeenCalledWith(TARGET, auth);
  expect(m.predicates).toEqual([]);
});

it.each(['organization', 'partner'] as const)('limits %s ownership and gates the partner read branch', async (scope) => {
  await listConversionLedger({}, { ...auth, scope, partnerId: TARGET, partnerOrgAccess: 'selected' });
  const predicate = new PgDialect().sqlToQuery(m.predicates[0]);
  expect(predicate.sql).toContain('"org_id" in');
  expect(predicate.params).toContain(ORG);
  if (scope === 'partner') {
    expect(predicate.sql).toContain('"org_id" is null');
    expect(predicate.sql).toContain('"partner_id" =');
    expect(predicate.params).toContain(TARGET);
  } else {
    expect(predicate.sql).not.toContain('"partner_id"');
    expect(predicate.params).not.toContain(TARGET);
  }
});

it('filters by source policy or output association and uses the last visible row as cursor', async () => {
  vi.mocked(getConfigPolicy).mockResolvedValueOnce({ id: TARGET } as Awaited<ReturnType<typeof getConfigPolicy>>);
  m.rows = [[{ ...entry, sourceState: { template: { name: 'Template CPU' } } }, { ...entry, id: TARGET }], [
    { conversionId: RESPONSE, monitorId: TARGET, role: 'primary', reusedMonitor: true },
    { conversionId: RESPONSE, monitorId: null, role: 'response', reusedMonitor: false },
  ]];
  const result = await listConversionLedger({ orgId: ORG, policyId: TARGET, cursor: TARGET, limit: 1 }, auth);
  expect(result).toEqual({ items: [{
    id: RESPONSE, sourceTable: 'automations', sourceId: RESPONSE, sourceName: 'Template CPU',
    policyId: null, convertedBy: null, convertedByName: null, convertedAt: new Date(0).toISOString(), revertedAt: null,
    revertable: true, outputs: [{ monitorId: TARGET, monitorName: null, role: 'primary', reused: true }],
  }], nextCursor: RESPONSE });
  const predicate = new PgDialect().sqlToQuery(m.predicates[0]);
  expect(predicate.sql).toContain('"monitor_conversions"."policy_id" =');
  expect(predicate.sql).toContain('EXISTS (SELECT 1 FROM "monitor_conversion_outputs"');
  expect(predicate.sql).toContain('"monitor_conversion_outputs"."conversion_id" = "monitor_conversions"."id"');
  expect(predicate.sql).toContain('"monitor_conversion_outputs"."policy_id" =');
  expect(predicate.sql).toContain('"monitor_conversions"."id" <');
  expect(predicate.params).toEqual([ORG, ORG, TARGET, TARGET, TARGET]);
  expect(new PgDialect().sqlToQuery(m.predicates[1]).params).toEqual([RESPONSE]);
});

it('resolves the converter and output monitor names for display', async () => {
  m.rows = [
    [{ ...entry, convertedBy: RESPONSE, sourceState: {} }],
    [{ conversionId: RESPONSE, monitorId: TARGET, role: 'primary', reusedMonitor: false }],
    [{ id: RESPONSE, name: 'Jamie Lee' }],
    [{ id: TARGET, name: 'High CPU' }],
  ];
  const result = await listConversionLedger({}, auth);
  expect(result.items[0]).toMatchObject({ convertedBy: RESPONSE, convertedByName: 'Jamie Lee',
    outputs: [{ monitorId: TARGET, monitorName: 'High CPU' }] });
});
it('returns an empty terminal page without reading outputs', async () => {
  expect(await listConversionLedger({}, auth)).toEqual({ items: [], nextCursor: null });
  expect(m.predicates).toHaveLength(1);
});
// The writers store the converted row under `source` (convert.ts, equivalence.ts),
// so the ledger must read the name from there, not from a top-level `name`.
it.each([
  { sourceState: { source: { id: RESPONSE, name: 'High CPU rule' }, monitorsLink: null }, name: 'High CPU rule' },
  { sourceState: { source: { id: RESPONSE, watchType: 'service', name: 'Spooler' }, rules: [] }, name: 'Spooler' },
  { sourceState: { template: { name: 'Template CPU' }, rules: [] }, name: 'Template CPU' },
])('names history entries from the stored source row ($name)', async ({ sourceState, name }) => {
  m.rows = [[{ ...entry, sourceState }], []];
  expect((await listConversionLedger({}, auth)).items[0]).toMatchObject({ sourceName: name });
});
