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
  /** pg_try_advisory_xact_lock result; false = another registry write holds the partner lock. */
  lockAcquired: true,
}));

vi.mock('./candidateLoader', async (orig) => ({
  ...(await orig<typeof import('./candidateLoader')>()),
  loadOfferingCandidate: vi.fn(async (id: string) => h.candidates.get(id) ?? null),
  loadPartnerFacts: vi.fn(async () => ({ plan: 'pro', residencyRequired: false })),
}));
vi.mock('../../config/env', () => ({ isHosted: () => true }));
vi.mock('./registryWriteLock', () => ({
  tryLockPartnerRegistryWrite: vi.fn(async (partnerId: string) => { h.calls.push(`lock:${partnerId}`); return h.lockAcquired; }),
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

import { putOrgAssignments, putPartnerAssignments, touchesSurface } from './assignmentWrites';

const P = '22222222-2222-4222-8222-222222222222';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
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
  h.lockAcquired = true;
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

  it('a held partner registry lock is 503 registry_busy: no read, no write, no waiting', async () => {
    h.candidates.set(A, cand());
    h.lockAcquired = false;
    const err = await putPartnerAssignments({ partnerId: P, rows: [row()] }).catch((e) => e);
    expect([err.status, err.code]).toEqual([503, 'registry_busy']);
    expect(h.calls).toEqual([`lock:${P}`]);
    expect(h.upserts).toHaveLength(0);
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

  describe('already-stored permitted ids (stale ids stay saveable)', () => {
    const V = '2026-10-01T10:00:00.000Z';
    const stored = (over: Record<string, unknown> = {}) => [{ id: 'r1', surface: 'chat', role: 'default', orgId: null, defaultOfferingId: A, permittedOfferingIds: [A, B], updatedAt: new Date(V), ...over }];

    it('accepts a stored permitted id that has since been disabled', async () => {
      h.candidates.set(A, cand());
      h.candidates.set(B, cand({ enabled: false }));
      h.partnerRows = stored();
      await putPartnerAssignments({ partnerId: P, rows: [row({ permittedOfferingIds: [A, B], expectedUpdatedAt: V })] });
      expect(h.upserts[0]!.values).toMatchObject({ permittedOfferingIds: [A, B] });
    });

    it('accepts a stored permitted id whose offering no longer loads', async () => {
      h.candidates.set(A, cand());
      h.partnerRows = stored();
      await expect(putPartnerAssignments({ partnerId: P, rows: [row({ permittedOfferingIds: [A, B], expectedUpdatedAt: V })] })).resolves.toHaveLength(1);
    });

    it('still validates a newly added id alongside stored ones', async () => {
      h.candidates.set(A, cand());
      h.candidates.set(B, cand({ enabled: false }));
      h.candidates.set(C, cand({ enabled: false }));
      h.partnerRows = stored();
      const err = await putPartnerAssignments({ partnerId: P, rows: [row({ permittedOfferingIds: [A, B, C], expectedUpdatedAt: V })] }).catch((e) => e);
      expect([err.code, err.details.offeringId, err.details.reason]).toEqual(['not_eligible', C, 'disabled']);
      expect(h.upserts).toHaveLength(0);
    });

    it('still requires an eligible default even when it is a stored permitted id', async () => {
      h.candidates.set(A, cand());
      h.candidates.set(B, cand({ enabled: false }));
      h.partnerRows = stored();
      const err = await putPartnerAssignments({ partnerId: P, rows: [row({ defaultOfferingId: B, permittedOfferingIds: [A, B], expectedUpdatedAt: V })] }).catch((e) => e);
      expect([err.code, err.details.field, err.details.offeringId]).toEqual(['not_eligible', 'defaultOfferingId', B]);
    });

    it('a stored id on another surface is not exempt on this one', async () => {
      h.candidates.set(A, cand());
      h.candidates.set(B, cand({ enabled: false }));
      h.partnerRows = stored({ surface: 'helper' });
      const err = await putPartnerAssignments({ partnerId: P, rows: [row({ permittedOfferingIds: [A, B] })] }).catch((e) => e);
      expect([err.code, err.details.offeringId]).toEqual(['not_eligible', B]);
    });
  });

  it('writes nothing when any row fails (all-or-nothing)', async () => {
    h.candidates.set(A, cand());
    const err = await putPartnerAssignments({ partnerId: P, rows: [row(), row({ surface: 'helper', defaultOfferingId: B })] }).catch((e) => e);
    expect([err.code, err.details.surface]).toEqual(['not_eligible', 'helper']);
    expect(h.upserts).toHaveLength(0);
  });
});

describe('putOrgAssignments — the org write rejects every widening', () => {
  const ORG = '55555555-5555-4555-8555-555555555555';
  const orgRow = (over: Record<string, unknown> = {}) => ({
    surface: 'chat' as const, role: 'default' as const, defaultOfferingId: null as string | null,
    permittedOfferingIds: null as string[] | null, allowUserChoice: null as false | null,
    options: null as Record<string, unknown> | null, expectedUpdatedAt: null as string | null, ...over,
  });
  beforeEach(() => {
    for (const id of [A, B, C]) h.candidates.set(id, cand());
    h.partnerRows = [{ surface: 'chat', role: 'default', orgId: null, defaultOfferingId: A, permittedOfferingIds: [A, B], allowUserChoice: true, options: { effort: 'medium' }, updatedAt: new Date() }];
  });

  it.each([
    ['a permitted id outside the partner set', { permittedOfferingIds: [A, C] }, 'permittedOfferingIds'],
    ['a default outside the partner set', { defaultOfferingId: C }, 'defaultOfferingId'],
    ['a default outside its own narrowed set', { permittedOfferingIds: [A], defaultOfferingId: B }, 'defaultOfferingId'],
    ['a narrowed set that excludes the inherited partner default', { permittedOfferingIds: [B] }, 'defaultOfferingId'],
    ['an effort above the partner', { options: { effort: 'high' } }, 'options'],
    ['fast when the partner has no fast', { options: { speed: 'fast' } }, 'options'],
    ['budget thinking on when the partner has not turned it on (W05)', { options: { budgetThinking: 'on' } }, 'options'],
    ['user choice the partner did not lock (runtime guard behind zod)', { allowUserChoice: true }, 'allowUserChoice'],
  ])('rejects %s', async (_l, over, field) => {
    const err = await putOrgAssignments({ partnerId: P, orgId: ORG, rows: [orgRow(over) as never] }).catch((e) => e);
    expect([err.status, err.code, err.details.field, err.details.surface]).toEqual([422, 'widens_partner', field, 'chat']);
    expect(h.upserts).toHaveLength(0);
  });

  it('names the offending permitted id and option key', async () => {
    const e1 = await putOrgAssignments({ partnerId: P, orgId: ORG, rows: [orgRow({ permittedOfferingIds: [A, C] })] }).catch((e) => e);
    expect(e1.details.offeringId).toBe(C);
    const e2 = await putOrgAssignments({ partnerId: P, orgId: ORG, rows: [orgRow({ options: { effort: 'max' } })] }).catch((e) => e);
    expect(e2.details.key).toBe('effort');
    const e3 = await putOrgAssignments({ partnerId: P, orgId: ORG, rows: [orgRow({ options: { speed: 'fast' } })] }).catch((e) => e);
    expect(e3.details.key).toBe('speed');
    const e4 = await putOrgAssignments({ partnerId: P, orgId: ORG, rows: [orgRow({ options: { budgetThinking: 'on' } })] }).catch((e) => e);
    expect(e4.details.key).toBe('budgetThinking');
  });

  it('accepts a narrowing (subset, default inside it, lower effort, user choice locked)', async () => {
    await putOrgAssignments({ partnerId: P, orgId: ORG, rows: [orgRow({ permittedOfferingIds: [B], defaultOfferingId: B, options: { effort: 'low' }, allowUserChoice: false })] });
    expect(h.upserts[0]!.values).toMatchObject({ orgId: ORG, partnerId: null, offeringPartnerId: P, permittedOfferingIds: [B], defaultOfferingId: B, allowUserChoice: false });
    expect(h.upserts[0]!.values).not.toHaveProperty('fallbackOfferingIds');
  });

  it('accepts a narrowed set that keeps the inherited partner default', async () => {
    await putOrgAssignments({ partnerId: P, orgId: ORG, rows: [orgRow({ permittedOfferingIds: [A] })] });
    expect(h.upserts[0]!.values).toMatchObject({ permittedOfferingIds: [A], defaultOfferingId: null });
  });

  it('reads, validates and writes inside one system transaction behind the partner registry lock', async () => {
    await putOrgAssignments({ partnerId: P, orgId: ORG, rows: [orgRow({ allowUserChoice: false })] });
    expect(h.systemContexts).toBe(1);
    expect(h.calls[0]).toBe(`lock:${P}`);
    expect(h.calls.slice(-1)).toEqual(['insert']);
  });

  it('a permitted id the partner allows still has to be usable (disabled → not_eligible)', async () => {
    h.candidates.set(B, cand({ enabled: false }));
    const err = await putOrgAssignments({ partnerId: P, orgId: ORG, rows: [orgRow({ permittedOfferingIds: [B] , defaultOfferingId: B })] }).catch((e) => e);
    expect([err.code, err.details.field, err.details.offeringId]).toEqual(['not_eligible', 'permittedOfferingIds', B]);
  });

  it('accepts a stored org permitted id that has since been disabled', async () => {
    const V = '2026-10-01T10:00:00.000Z';
    h.candidates.set(B, cand({ enabled: false }));
    h.existingRows = [{ id: 'o1', surface: 'chat', role: 'default', orgId: ORG, permittedOfferingIds: [A, B], updatedAt: new Date(V) }];
    await putOrgAssignments({ partnerId: P, orgId: ORG, rows: [orgRow({ permittedOfferingIds: [A, B], allowUserChoice: false, expectedUpdatedAt: V })] });
    expect(h.upserts[0]!.values).toMatchObject({ permittedOfferingIds: [A, B], allowUserChoice: false });
  });

  it('accepts a stored org permitted id the partner has since dropped (the merge intersects)', async () => {
    const V = '2026-10-01T10:00:00.000Z';
    h.existingRows = [{ id: 'o1', surface: 'chat', role: 'default', orgId: ORG, permittedOfferingIds: [A, C], updatedAt: new Date(V) }];
    await putOrgAssignments({ partnerId: P, orgId: ORG, rows: [orgRow({ permittedOfferingIds: [A, C], expectedUpdatedAt: V })] });
    expect(h.upserts[0]!.values).toMatchObject({ permittedOfferingIds: [A, C] });
  });

  it('a newly added org id is still checked even when other ids are stored', async () => {
    const V = '2026-10-01T10:00:00.000Z';
    h.candidates.set(B, cand({ enabled: false }));
    h.existingRows = [{ id: 'o1', surface: 'chat', role: 'default', orgId: ORG, permittedOfferingIds: [A], updatedAt: new Date(V) }];
    const err = await putOrgAssignments({ partnerId: P, orgId: ORG, rows: [orgRow({ permittedOfferingIds: [A, B], expectedUpdatedAt: V })] }).catch((e) => e);
    expect([err.code, err.details.offeringId]).toEqual(['not_eligible', B]);
  });

  it('checks set options against the inherited partner default', async () => {
    h.candidates.set(A, cand({}, { optionSupport: { effort: ['medium'], thinkingDisplay: [], speed: ['standard'], inferenceGeo: [] } }));
    const err = await putOrgAssignments({ partnerId: P, orgId: ORG, rows: [orgRow({ options: { effort: 'low' } })] }).catch((e) => e);
    expect([err.code, err.details]).toEqual(['invalid', { surface: 'chat', field: 'options', key: 'effort' }]);
  });

  it('an all-blank row deletes the override (blank = inherit)', async () => {
    h.existingRows = [{ id: 'o1', surface: 'chat', role: 'default', orgId: ORG, updatedAt: new Date('2026-10-01T10:00:00Z') }];
    await putOrgAssignments({ partnerId: P, orgId: ORG, rows: [orgRow({ expectedUpdatedAt: '2026-10-01T10:00:00.000Z' })] });
    expect(h.deletes).toHaveLength(1);
    expect(h.upserts).toHaveLength(0);
  });

  it('an all-blank row with no override is a no-op', async () => {
    await expect(putOrgAssignments({ partnerId: P, orgId: ORG, rows: [orgRow()] })).resolves.toEqual([]);
    expect([h.deletes.length, h.upserts.length]).toEqual([0, 0]);
  });

  it('409s a blank row whose version does not match the stored override', async () => {
    h.existingRows = [{ id: 'o1', surface: 'chat', role: 'default', orgId: ORG, updatedAt: new Date('2026-10-01T10:00:00Z') }];
    const err = await putOrgAssignments({ partnerId: P, orgId: ORG, rows: [orgRow()] }).catch((e) => e);
    expect([err.status, err.code]).toEqual([409, 'stale_write']);
    expect(h.deletes).toHaveLength(0);
  });

  it('refuses a default when the partner has no row for the surface', async () => {
    h.partnerRows = [];
    const err = await putOrgAssignments({ partnerId: P, orgId: ORG, rows: [orgRow({ defaultOfferingId: A })] }).catch((e) => e);
    expect([err.code, err.details.field]).toEqual(['widens_partner', 'defaultOfferingId']);
  });

  it('may narrow permitted when the partner has no row for the surface', async () => {
    h.partnerRows = [];
    await putOrgAssignments({ partnerId: P, orgId: ORG, rows: [orgRow({ permittedOfferingIds: [C] })] });
    expect(h.upserts[0]!.values).toMatchObject({ permittedOfferingIds: [C], defaultOfferingId: null });
  });

  it('writes nothing when any row widens (all-or-nothing)', async () => {
    const err = await putOrgAssignments({ partnerId: P, orgId: ORG, rows: [orgRow({ allowUserChoice: false }), orgRow({ surface: 'helper', defaultOfferingId: A })] }).catch((e) => e);
    expect([err.code, err.details.surface]).toEqual(['widens_partner', 'helper']);
    expect(h.upserts).toHaveLength(0);
  });

  it('touchesSurface detects the reviewer surface', () => {
    expect(touchesSurface([{ surface: 'chat' }, { surface: 'script_reviewer' }], 'script_reviewer')).toBe(true);
    expect(touchesSurface([{ surface: 'chat' }], 'script_reviewer')).toBe(false);
  });
});
