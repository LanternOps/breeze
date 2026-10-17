import { describe, expect, it, vi, beforeEach } from 'vitest';

const dbm = vi.hoisted(() => ({ rows: [] as unknown[][], select: vi.fn() }));
vi.mock('../../../db', () => {
  const chain = () => {
    const c: Record<string, unknown> = {};
    for (const m of ['from', 'where', 'orderBy', 'limit']) c[m] = vi.fn(() => c);
    c.then = (r: (v: unknown) => unknown) => Promise.resolve(dbm.rows.shift() ?? []).then(r);
    return c;
  };
  dbm.select.mockImplementation(() => chain());
  return { db: { select: (...a: unknown[]) => dbm.select(...a) }, runOutsideDbContext: (fn: () => unknown) => fn(), withSystemDbAccessContext: (fn: () => unknown) => fn() };
});

import { resolveFrozenConfig, trustPagePublicPayloadSchema, trustPublishedConfigSchema } from '@breeze/shared';
import { buildDeclaredControls, freezeDeclarationIds } from './declarations';
import type { SectionBuildContext } from './types';

const page = { id: 'pg', orgId: 'o', partnerId: 'p' } as never;
const asOf = new Date('2026-10-17T12:00:00.000Z');
const ID = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
const DOC = '7b0c6a52-58a2-4c8e-9d0c-1a2b3c4d5e6f';

const row = (over: Record<string, unknown> = {}) => ({
  id: ID(1), trustPageId: 'pg', orgId: 'o', controlId: 'incident_response_plan', statement: 'We keep a tested IR plan.',
  evidenceDocumentId: null, evidenceDocumentSha256: null, declaredByPartnerName: 'Northwind IT', declaredByUserId: 'u',
  declaredAt: new Date('2026-01-01T00:00:00.000Z'), expiresAt: new Date(asOf.getTime() + 86_400_000),
  supersededAt: null, withdrawnAt: null, withdrawnByUserId: null, reminderSentAt: null, createdAt: new Date('2026-01-01T00:00:00.000Z'),
  ...over,
});
const ctx = (declarationIds: string[], documents: SectionBuildContext['documents'] = []): SectionBuildContext => ({
  page, asOf, partnerName: 'Northwind IT', documents,
  config: resolveFrozenConfig(trustPublishedConfigSchema.parse({
    hiddenControlIds: [], showPercentages: false, showDeviceCount: false, showManagedBy: true, searchIndexable: false,
    introHtml: null, websiteUrl: null, securityContactEmail: null, documentIds: [], declarationIds,
  })),
});
const declaredSchema = trustPagePublicPayloadSchema.shape.declaredControls;

beforeEach(() => { dbm.rows = []; dbm.select.mockClear(); });

describe('buildDeclaredControls', () => {
  it('no frozen ids → [] without a query', async () => {
    expect(await buildDeclaredControls(ctx([]))).toEqual([]);
    expect(dbm.select).not.toHaveBeenCalled();
  });

  it('a frozen id expiring at asOf − 1ms is expired; at asOf + 1ms it is current (Review Focus 4)', async () => {
    dbm.rows.push([row({ expiresAt: new Date(asOf.getTime() - 1) })]);
    const [expired] = await buildDeclaredControls(ctx([ID(1)]));
    expect(expired!.status).toBe('expired');
    dbm.rows.push([row({ expiresAt: new Date(asOf.getTime() + 1) })]);
    const [current] = await buildDeclaredControls(ctx([ID(1)]));
    expect(current!.status).toBe('current');
  });

  it('projects the public entry exactly (schema-valid, partner name captured at declaration, catalog framework refs)', async () => {
    dbm.rows.push([row({ declaredByPartnerName: 'Old Name IT' })]);
    const out = await buildDeclaredControls(ctx([ID(1)]));
    expect(declaredSchema.parse(out)).toEqual(out);
    expect(out[0]).toEqual({
      id: 'incident_response_plan', category: 'governance', source: 'declared', status: 'current',
      statement: 'We keep a tested IR plan.', declaredBy: 'Old Name IT',
      declaredAt: '2026-01-01T00:00:00.000Z', expiresAt: new Date(asOf.getTime() + 86_400_000).toISOString(),
      evidenceDocumentId: null,
      frameworkRefs: [{ framework: 'cis_v8', ref: '17.1' }, { framework: 'cis_v8', ref: '17.2' }, { framework: 'cis_v8', ref: '17.3' }, { framework: 'nist_csf_2', ref: 'RS.MA-01' }, { framework: 'nist_csf_2', ref: 'ID.IM-04' }],
    });
  });

  it('a withdrawn frozen id is omitted', async () => {
    dbm.rows.push([row({ withdrawnAt: new Date(asOf.getTime() - 1000) })]);
    expect(await buildDeclaredControls(ctx([ID(1)]))).toEqual([]);
  });

  it('a superseded frozen id still renders until a republish (Open Decision 5)', async () => {
    dbm.rows.push([row({ supersededAt: new Date(asOf.getTime() - 1000) })]);
    expect(await buildDeclaredControls(ctx([ID(1)]))).toHaveLength(1);
  });

  it('an evidence document not on the page → null; one on the page is kept', async () => {
    const onPage = [{ id: DOC, title: 'IR plan', category: 'policy', contentType: 'application/pdf', byteSize: 1, updatedAt: asOf.toISOString(), visibility: 'public' as const }];
    dbm.rows.push([row({ evidenceDocumentId: DOC })]);
    expect((await buildDeclaredControls(ctx([ID(1)])))[0]!.evidenceDocumentId).toBeNull();
    dbm.rows.push([row({ evidenceDocumentId: DOC })]);
    expect((await buildDeclaredControls(ctx([ID(1)], onPage as never)))[0]!.evidenceDocumentId).toBe(DOC);
  });

  it('an unknown id (deleted by cascade) and a control no longer in the catalog are skipped without a throw', async () => {
    dbm.rows.push([row({ id: ID(2), controlId: 'retired_control' })]);
    expect(await buildDeclaredControls(ctx([ID(1), ID(2)]))).toEqual([]);
  });

  it('orders by the declared catalog, not by frozen order', async () => {
    dbm.rows.push([
      row({ id: ID(1), controlId: 'cyber_insurance' }),
      row({ id: ID(2), controlId: 'security_awareness_training' }),
    ]);
    const out = await buildDeclaredControls(ctx([ID(1), ID(2)]));
    expect(out.map((d) => d.id)).toEqual(['security_awareness_training', 'cyber_insurance']);
  });
});

describe('freezeDeclarationIds', () => {
  it('freezes active, unexpired rows in declared-catalog order', async () => {
    dbm.rows.push([
      { id: ID(1), controlId: 'cyber_insurance', expiresAt: new Date(asOf.getTime() + 1) },
      { id: ID(2), controlId: 'security_awareness_training', expiresAt: new Date(asOf.getTime() + 1) },
      { id: ID(3), controlId: 'access_review', expiresAt: asOf },
      { id: ID(4), controlId: 'retired_control', expiresAt: new Date(asOf.getTime() + 1) },
    ]);
    expect(await freezeDeclarationIds({ page, asOf })).toEqual([ID(2), ID(1)]);
  });
});
