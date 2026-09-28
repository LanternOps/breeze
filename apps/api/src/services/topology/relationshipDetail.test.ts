import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { relationshipDetailResponseSchema, relationshipEvidenceResponseSchema } from '@breeze/shared';
import { physicalDetail, readRelationshipDetail, readRelationshipEvidence, type DetailRow } from './relationshipDetail';

const dialect = new PgDialect();
const scope = { orgId: '10000000-0000-4000-8000-000000000001', siteId: '20000000-0000-4000-8000-000000000001' };
const id = (n: number) => `40000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const REL = id(1), ALT = id(2), SWITCH = id(10), HOST = id(11), SWITCH2 = id(12), PORT = id(20), ALT_PORT = id(21), EXCLUSION = id(30);
const fdb: DetailRow = { id: REL, kind: 'attachment', sourceNodeId: SWITCH, targetNodeId: HOST, sourceInterfaceId: PORT, targetInterfaceId: null,
  directness: 'unknown', confidence: 'low', evidenceClass: 'inferred', lifecycle: 'active', lastSupportedAt: '2026-09-26T11:00:00.000Z', supportCount: '1',
  legacy: false, method: 'fdb', observedFreshUntil: '2999-01-01T00:00:00.000Z',
  physical: { resolution: 'resolved', localPort: { namespace: 'if_index', value: '24' }, remoteChassis: { subtype: 'mac_address', value: 'aa:bb:cc:dd:ee:ff' },
    fdbSelection: 'competing', alternativeRelationshipIds: [ALT, 'not-a-uuid'] } };
const envelope = { siteId: scope.siteId, graphRevision: '5' };

describe('physicalDetail — truthful port roles', () => {
  it('distinguishes learned, shared, unresolved and identified ports', () => {
    expect(physicalDetail({ ...fdb, physical: { ...fdb.physical, fdbSelection: 'selected' } })).toMatchObject({ method: 'fdb', portRole: 'learned', fdbSelection: 'selected', association: null });
    expect(physicalDetail({ ...fdb, physical: { ...fdb.physical, fdbSelection: 'excluded' } })?.portRole).toBe('shared');
    expect(physicalDetail({ ...fdb, sourceInterfaceId: null })?.portRole).toBe('unresolved');
    expect(physicalDetail({ ...fdb, kind: 'physical_link', method: 'lldp', physical: { resolution: 'resolved' } })).toMatchObject({ portRole: 'identified', association: 'wired', fdbSelection: null });
  });
  it('keeps wireless and VPN associations distinct and ignores logical relationships', () => {
    expect(physicalDetail({ ...fdb, method: 'unifi', physical: { association: 'wireless' } })?.association).toBe('wireless');
    expect(physicalDetail({ ...fdb, method: 'unifi', physical: { association: 'vpn' } })?.association).toBe('vpn');
    expect(physicalDetail({ ...fdb, method: 'unifi', physical: { association: 'carrier-pigeon' } })?.association).toBeNull();
    expect(physicalDetail({ ...fdb, kind: 'network_member' })).toBeNull();
  });
});

describe('readRelationshipDetail', () => {
  it('returns port names, FDB alternatives and exclusion state without hiding the relationship', async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce([{ id: EXCLUSION, view: 'physical', reason: 'Lab bench', createdAt: '2026-09-26T10:00:00.000Z' }])
      .mockResolvedValueOnce([{ id: ALT, sourceNodeId: SWITCH2, targetNodeId: HOST, sourceInterfaceId: ALT_PORT, confidence: 'low' }])
      .mockResolvedValueOnce([{ id: PORT, name: 'port-24', alias: 'Desk drop', key: 'if:24', retired: false }, { id: ALT_PORT, name: 'ge-0/0/3', alias: null, key: 'if:3', retired: false }])
      .mockResolvedValueOnce([{ id: SWITCH, label: 'Core switch' }, { id: HOST, label: 'Desk 12' }, { id: SWITCH2, label: 'Closet switch' }]);
    const detail = await readRelationshipDetail({ execute }, scope, fdb, { canEdit: true, physical: true });
    expect(relationshipDetailResponseSchema.safeParse({ ...envelope, ...detail }).success).toBe(true);
    expect(detail.relationship).toMatchObject({ id: REL, excluded: true, evidence: { methods: ['fdb'] } });
    expect(detail.exclusions).toEqual([{ id: EXCLUSION, view: 'physical', reason: 'Lab bench', createdAt: '2026-09-26T10:00:00.000Z' }]);
    expect(detail.endpoints.source).toMatchObject({ label: 'Core switch', port: { name: 'port-24', alias: 'Desk drop' }, reportedPort: null });
    expect(detail.endpoints.target).toMatchObject({ label: 'Desk 12', port: null });
    expect(detail.alternatives).toEqual([{ relationshipId: ALT, sourceNodeId: SWITCH2, sourceNodeLabel: 'Closet switch', targetNodeId: HOST,
      port: { interfaceId: ALT_PORT, name: 'ge-0/0/3', alias: null, key: 'if:3', retired: false }, confidence: 'low' }]);
    expect(detail.detailCoverage).toEqual({ state: 'limited', reason: 'fdb_competing_candidates' });
    const alternativesQuery = dialect.sqlToQuery(execute.mock.calls[1]![0]);
    expect(alternativesQuery.params).toContain(`{${ALT}}`);
    for (const call of execute.mock.calls) {
      const query = dialect.sqlToQuery(call[0]);
      expect(query.sql).not.toMatch(/\b(insert|update|delete)\b/i);
      expect(query.params).toEqual(expect.arrayContaining([scope.orgId, scope.siteId]));
    }
  });

  it('reports the collector port reference when the port is not identified', async () => {
    const execute = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: SWITCH, label: 'Core switch' }, { id: HOST, label: 'Desk 12' }]);
    const detail = await readRelationshipDetail({ execute }, scope, { ...fdb, sourceInterfaceId: null, physical: { ...fdb.physical, alternativeRelationshipIds: undefined } }, { canEdit: false, physical: true });
    expect(detail.relationship.excluded).toBe(false);
    expect(detail.endpoints.source).toMatchObject({ port: null, reportedPort: { namespace: 'if_index', value: '24' } });
    expect(detail.physical?.portRole).toBe('unresolved');
    expect(detail.detailCoverage).toEqual({ state: 'limited', reason: 'interface_unresolved' });
  });
});

describe('readRelationshipEvidence', () => {
  const observation = (n: number, freshUntil: string, withdrawnAt: string | null = null) => ({ id: id(100 + n), method: 'fdb', evidenceClass: 'inferred', producerKind: 'discovery', protocol: 'fdb',
    observedAt: '2026-09-26T10:00:00.000Z', effectiveAt: '2026-09-26T10:00:00.000Z', receivedAt: `2026-09-26T10:0${n}:00.000Z`, freshUntil, withdrawnAt });
  const confirmation = { sourceId: id(200), producerKind: 'discovery', protocol: 'fdb', firstPositiveAt: '2026-09-25T10:00:00.000Z', lastPositiveAt: '2026-09-26T10:00:00.000Z',
    freshUntil: '2026-09-26T13:00:00.000Z', lifecycle: 'active', completeMissCount: 0 };
  const now = new Date('2026-09-26T12:00:00.000Z');

  it('pages newest-first observations with current/expired/withdrawn status and confirmations on the first page', async () => {
    const execute = vi.fn().mockResolvedValueOnce([observation(3, '2026-09-26T13:00:00.000Z'), observation(2, '2026-09-26T11:00:00.000Z'), observation(1, '2026-09-26T13:00:00.000Z', '2026-09-26T11:30:00.000Z')])
      .mockResolvedValueOnce([confirmation]);
    const page = await readRelationshipEvidence({ execute }, scope, fdb, { limit: 2 }, now);
    expect(page.observations.map((o) => o.status)).toEqual(['current', 'expired']);
    expect(page.nextAfter).toBe(id(102));
    expect(page.confirmations).toHaveLength(1);
    expect(page.details).toEqual({ state: 'available', reason: null });
    const { nextAfter, ...body } = page; void nextAfter;
    expect(relationshipEvidenceResponseSchema.safeParse({ ...envelope, relationshipId: REL, cursor: null, summary: { classes: ['inferred'], methods: ['fdb'], count: '1', lastObservedAt: null }, ...body }).success).toBe(true);
    const query = dialect.sqlToQuery(execute.mock.calls[0]![0]);
    expect(query.sql).toMatch(/order by o\.received_at desc, o\.id desc/i);
    expect(query.params).toContain(3);
  });

  it('continues after the cursor observation and does not repeat confirmations', async () => {
    const execute = vi.fn().mockResolvedValueOnce([observation(1, '2026-09-26T13:00:00.000Z', '2026-09-26T11:30:00.000Z')]);
    const page = await readRelationshipEvidence({ execute }, scope, fdb, { limit: 2, after: id(102) }, now);
    expect(page.observations.map((o) => o.status)).toEqual(['withdrawn']);
    expect(page.confirmations).toEqual([]); expect(page.nextAfter).toBeNull();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(dialect.sqlToQuery(execute.mock.calls[0]![0]).params).toContain(id(102));
  });

  it('reports expired detail when support survives observation retention', async () => {
    const execute = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([confirmation]);
    expect((await readRelationshipEvidence({ execute }, scope, fdb, { limit: 50 }, now)).details).toEqual({ state: 'expired', reason: 'observation_detail_expired' });
    const legacy = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    expect((await readRelationshipEvidence({ execute: legacy }, scope, { ...fdb, legacy: true }, { limit: 50 }, now)).details).toEqual({ state: 'unavailable', reason: 'legacy_summary_only' });
  });
});
