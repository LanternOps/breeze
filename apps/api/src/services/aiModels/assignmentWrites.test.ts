import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  candidates: new Map<string, unknown>(),
  existingRows: [] as Array<Record<string, unknown>>,
  partnerRows: [] as Array<Record<string, unknown>>,
  upserts: [] as Array<{ kind: 'insert' | 'update'; values: Record<string, unknown> }>,
  deletes: [] as Array<unknown>,
  insertResult: null as unknown[] | null,   // null → echo the row; [] → a concurrent insert won
  updateResult: null as unknown[] | null,   // [] → a concurrent update won (version mismatch)
  /** Ordered log: lock acquisition, row reads, row writes. */
  calls: [] as string[],
  systemContexts: 0,
}));

vi.mock('./candidateLoader', async (orig) => ({
  ...(await orig<typeof import('./candidateLoader')>()),
  loadOfferingCandidate: vi.fn(async (id: string) => h.candidates.get(id) ?? null),
  loadPartnerFacts: vi.fn(async () => ({ plan: 'pro', residencyRequired: false })),
}));
vi.mock('../../config/env', () => ({ isHosted: () => true }));
vi.mock('./legacyReconcile', () => ({
  lockPartnerRegistryReconcile: vi.fn(async (partnerId: string) => { h.calls.push(`lock:${partnerId}`); }),
}));
vi.mock('./assignmentRows', () => ({
  listAssignmentRows: vi.fn(async ({ orgId }: { orgId?: string | null }) => {
    h.calls.push('read');
    return orgId ? h.existingRows.filter((r) => r.orgId === orgId) : h.partnerRows;
  }),
}));
vi.mock('../../db', () => {
  const echo = (values: Record<string, unknown>) => [{ ...values, id: 'row', updatedAt: new Date() }];
  return {
    db: {
      insert: () => ({
        values: (values: Record<string, unknown>) => ({
          onConflictDoNothing: () => ({
            returning: async () => {
              h.calls.push('insert');
              h.upserts.push({ kind: 'insert', values });
              return h.insertResult ?? echo(values);
            },
          }),
        }),
      }),
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: () => ({
            returning: async () => {
              h.calls.push('update');
              h.upserts.push({ kind: 'update', values });
              return h.updateResult ?? echo(values);
            },
          }),
        }),
      }),
      delete: () => ({ where: (w: unknown) => ({ returning: async () => { h.deletes.push(w); return [{ id: 'row' }]; } }) }),
    },
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: async (fn: () => Promise<unknown>) => {
      h.systemContexts += 1;
      return fn();
    },
  };
});

import { putPartnerAssignments } from './assignmentWrites';

const P = '22222222-2222-4222-8222-222222222222';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const RATES = { inputCentsPerM: 300, outputCentsPerM: 1500, cacheReadCentsPerM: 30, cacheWriteCentsPerM: 375 };

function cand(factsOver: Record<string, unknown> = {}, over: Record<string, unknown> = {}) {
  return {
    connectionId: null, funding: 'platform', optionRates: null, allowedOptions: null, defaultOptions: null,
    optionSupport: { effort: ['low', 'medium', 'high', 'max'], thinkingDisplay: ['summarized'], speed: ['standard'], inferenceGeo: [] },
    facts: {
      ownerPartnerId: P, enabled: true, lifecycle: 'available', requiredPermission: null,
      platform: { platformOffered: true, lifecycle: 'available', minPlan: null },
      connection: { kind: 'platform', status: 'active', keyUsable: true }, catalog: null,
      rate: { source: 'platform', standard: RATES }, supportsTools: true, inferenceGeo: null, supportedInferenceGeos: [],
      ...factsOver,
    },
    ...over,
  };
}

beforeEach(() => {
  h.candidates.clear();
  h.existingRows = [];
  h.partnerRows = [];
  h.upserts = [];
  h.deletes = [];
  h.insertResult = null;
  h.updateResult = null;
  h.calls = [];
  h.systemContexts = 0;
});

describe('putPartnerAssignments', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    surface: 'chat' as const, role: 'default' as const, defaultOfferingId: A, permittedOfferingIds: null as string[] | null,
    allowUserChoice: true, options: null, expectedUpdatedAt: null as string | null, ...over,
  });

  it('upserts a valid row with offering_partner_id = partner, and never the fallback columns', async () => {
    h.candidates.set(A, cand());
    await putPartnerAssignments({ partnerId: P, rows: [row()] });
    expect(h.upserts[0]!.values).toMatchObject({ partnerId: P, orgId: null, offeringPartnerId: P, surface: 'chat', role: 'default', defaultOfferingId: A });
    expect(h.upserts[0]!.kind).toBe('insert');                 // expectedUpdatedAt null → insert-only
    expect(h.upserts[0]!.values).not.toHaveProperty('fallbackOfferingIds');
    expect(h.upserts[0]!.values).not.toHaveProperty('fallbackMayCrossFunding');
  });

  it('reads, validates and writes inside one system transaction behind the partner registry lock', async () => {
    h.candidates.set(A, cand());
    await putPartnerAssignments({ partnerId: P, rows: [row()] });
    expect(h.systemContexts).toBe(1);
    expect(h.calls).toEqual([`lock:${P}`, 'read', 'insert']);
  });

  it('updates an existing row by version and never touches the fallback columns', async () => {
    h.candidates.set(A, cand());
    h.partnerRows = [{ id: 'r1', surface: 'chat', role: 'default', orgId: null, updatedAt: new Date('2026-10-01T10:00:00.000Z') }];
    await putPartnerAssignments({ partnerId: P, rows: [row({ expectedUpdatedAt: '2026-10-01T10:00:00.000Z' })] });
    expect(h.upserts[0]!.kind).toBe('update');
    expect(Object.keys(h.upserts[0]!.values)).not.toContain('fallbackOfferingIds');
    expect(Object.keys(h.upserts[0]!.values)).not.toContain('fallbackMayCrossFunding');
  });

  it('a concurrent insert (row appeared after validation) is stale and rolls back the batch', async () => {
    h.candidates.set(A, cand());
    h.insertResult = [];
    const err = await putPartnerAssignments({ partnerId: P, rows: [row()] }).catch((e) => e);
    expect([err.status, err.code, err.details.surface]).toEqual([409, 'stale_write', 'chat']);
  });

  it('a concurrent update (version moved after validation) is stale', async () => {
    h.candidates.set(A, cand());
    h.partnerRows = [{ id: 'r1', surface: 'chat', role: 'default', orgId: null, updatedAt: new Date('2026-10-01T10:00:00.000Z') }];
    h.updateResult = [];
    const err = await putPartnerAssignments({ partnerId: P, rows: [row({ expectedUpdatedAt: '2026-10-01T10:00:00.000Z' })] }).catch((e) => e);
    expect([err.status, err.code]).toEqual([409, 'stale_write']);
  });

  it('rejects a default without tool support on a tool surface (spec §7)', async () => {
    h.candidates.set(A, cand({ supportsTools: false }));
    const err = await putPartnerAssignments({ partnerId: P, rows: [row()] }).catch((e) => e);
    expect([err.status, err.code, err.details]).toEqual([422, 'tools_unsupported', { surface: 'chat', field: 'defaultOfferingId', offeringId: A }]);
  });

  it('accepts a tool-less model on a non-tool surface', async () => {
    h.candidates.set(A, cand({ supportsTools: false }));
    await expect(putPartnerAssignments({ partnerId: P, rows: [row({ surface: 'catalog_enrichment' })] })).resolves.toBeDefined();
  });

  it('rejects a disabled permitted offering', async () => {
    h.candidates.set(A, cand());
    h.candidates.set(B, cand({ enabled: false }));
    const err = await putPartnerAssignments({ partnerId: P, rows: [row({ permittedOfferingIds: [A, B] })] }).catch((e) => e);
    expect([err.code, err.details.field, err.details.offeringId, err.details.reason]).toEqual(['not_eligible', 'permittedOfferingIds', B, 'disabled']);
  });

  it('rejects an enabled default that fails the shared rule table (checkEnableEligibility)', async () => {
    h.candidates.set(A, cand({ platform: { platformOffered: false, lifecycle: 'available', minPlan: null } }));
    const err = await putPartnerAssignments({ partnerId: P, rows: [row()] }).catch((e) => e);
    expect([err.status, err.code, err.details.field, err.details.offeringId]).toEqual([422, 'not_eligible', 'defaultOfferingId', A]);
    expect(err.details.reason).not.toBe('disabled');
    expect(h.upserts).toHaveLength(0);
  });

  it('rejects another partner’s offering as 422 not_eligible (loader returns null)', async () => {
    const err = await putPartnerAssignments({ partnerId: P, rows: [row()] }).catch((e) => e);
    expect([err.status, err.code, err.details.reason]).toEqual([422, 'not_eligible', 'not_found']);
  });

  it('rejects a default outside the permitted list', async () => {
    h.candidates.set(A, cand());
    h.candidates.set(B, cand());
    const err = await putPartnerAssignments({ partnerId: P, rows: [row({ permittedOfferingIds: [B] })] }).catch((e) => e);
    expect([err.code, err.details.field]).toEqual(['invalid', 'defaultOfferingId']);
  });

  it('rejects an effort the default model does not support', async () => {
    h.candidates.set(A, cand({}, { optionSupport: { effort: ['low'], thinkingDisplay: [], speed: ['standard'], inferenceGeo: [] } }));
    const err = await putPartnerAssignments({ partnerId: P, rows: [row({ options: { effort: 'max' } })] }).catch((e) => e);
    expect([err.code, err.details]).toEqual(['invalid', { surface: 'chat', field: 'options', key: 'effort' }]);
  });

  it('rejects an option the default offering supports but does not allow', async () => {
    h.candidates.set(A, cand({}, { allowedOptions: { effort: ['low', 'medium'] } }));
    const err = await putPartnerAssignments({ partnerId: P, rows: [row({ options: { effort: 'high' } })] }).catch((e) => e);
    expect([err.code, err.details]).toEqual(['invalid', { surface: 'chat', field: 'options', key: 'effort' }]);
  });

  it('409s when expectedUpdatedAt does not match the stored row', async () => {
    h.candidates.set(A, cand());
    h.partnerRows = [{ id: 'r1', surface: 'chat', role: 'default', orgId: null, updatedAt: new Date('2026-10-01T10:00:00Z') }];
    const err = await putPartnerAssignments({ partnerId: P, rows: [row({ expectedUpdatedAt: null })] }).catch((e) => e);
    expect([err.status, err.code, err.details.surface]).toEqual([409, 'stale_write', 'chat']);
  });

  it('409s when a version is expected but no row exists', async () => {
    h.candidates.set(A, cand());
    const err = await putPartnerAssignments({ partnerId: P, rows: [row({ expectedUpdatedAt: '2026-10-01T10:00:00.000Z' })] }).catch((e) => e);
    expect([err.status, err.code]).toEqual([409, 'stale_write']);
    expect(h.upserts).toHaveLength(0);
  });

  it('writes nothing when any row fails (all-or-nothing)', async () => {
    h.candidates.set(A, cand());
    const err = await putPartnerAssignments({ partnerId: P, rows: [row(), row({ surface: 'helper', defaultOfferingId: B })] }).catch((e) => e);
    expect([err.code, err.details.surface]).toEqual(['not_eligible', 'helper']);
    expect(h.upserts).toHaveLength(0);
  });
});
