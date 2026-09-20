import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

const state = vi.hoisted(() => ({
  reads: [] as unknown[][], writes: [] as Array<{ kind: string; value?: any; where?: any }>,
  storedRules: [{ workTypeId: 'old' }] as any[], failInsert: false,
  inserted: [] as any[], conflicts: [] as boolean[],
}));
vi.mock('../db', () => {
  const executor: any = {
    select: vi.fn(() => ({ from: () => ({ where: (where: unknown) => {
      state.writes.push({ kind: 'select', where });
      const result: any = { limit: () => result, for: () => result, orderBy: () => result,
        then: (resolve: any) => Promise.resolve(state.reads.shift() ?? []).then(resolve) };
      return result;
    } }) })),
    insert: vi.fn(() => ({ values: (value: any) => {
      state.writes.push({ kind: 'insert', value });
      const result: any = { onConflictDoNothing: () => result, onConflictDoUpdate: () => result,
        returning: async () => {
          if (state.failInsert) throw new Error('insert failed');
          if (state.conflicts.shift()) return [];
          const rows = (Array.isArray(value) ? value : [{ id: 'new', ...value }]);
          state.inserted.push(...rows); return rows;
        }, then: (resolve: any, reject: any) => result.returning().then(resolve, reject) };
      return result;
    } })),
    update: vi.fn(() => ({ set: (value: any) => ({ where: (where: unknown) => {
      state.writes.push({ kind: 'update', value, where });
      return { returning: async () => [{ ...profile, ...value }], then: (resolve: any) => Promise.resolve([]).then(resolve) };
    } }) })),
    delete: vi.fn(() => ({ where: () => { state.storedRules = []; return Promise.resolve([]); } })),
    transaction: vi.fn(async (fn: any) => {
      const before = [...state.storedRules];
      try { return await fn(executor); } catch (error) { state.storedRules = before; throw error; }
    }),
  };
  return { db: executor };
});
import { db } from '../db';
import {
  createProfile, updateProfile, replaceProfileRows, cloneProfile, setDefaultProfile,
  assignProfileToOrg, loadCardsForOrg, ensureDefaultProfile, getOrgAssignment, clearOrgAssignment,
} from './billingProfileService';
const partner = '11111111-1111-4111-8111-111111111111';
const id = '22222222-2222-4222-8222-222222222222';
const workTypeId = '33333333-3333-4333-8333-333333333333';
const orgId = '44444444-4444-4444-8444-444444444444';
const caller = { scope: 'partner', partnerOrgAccess: 'all' } as const;
const profile = { id, partnerId: partner, name: 'Standard', currencyCode: 'USD', isActive: true,
  isDefault: false, notes: null, baseCoverage: 'billable', baseHourlyRate: '150.00',
  baseMinimumMinutes: 30, roundingIncrementMinutes: 15 };
const row = { workTypeId, coverage: 'billable' as const, hourlyRate: '200.00', minimumMinutes: 60 };
const sqlText = (where: any) => new PgDialect().sqlToQuery(where);
beforeEach(() => { vi.clearAllMocks(); state.reads = []; state.writes = []; state.inserted = [];
  state.conflicts = []; state.storedRules = [{ workTypeId: 'old' }]; state.failInsert = false; });

describe('profile mutations', () => {
  it('creates a partner-owned card', async () => {
    state.reads.push([{ code: 'USD' }]);
    await expect(createProfile(caller, partner, { name: 'Silver', currencyCode: 'USD', baseCoverage: 'billable' }))
      .resolves.toMatchObject({ name: 'Silver', partnerId: partner, isDefault: false });
  });
  it('rejects selected-org writers before any query', async () => {
    await expect(createProfile({ scope: 'partner', partnerOrgAccess: 'selected' }, partner,
      { name: 'Silver', currencyCode: 'USD', baseCoverage: 'billable' })).rejects.toThrow('full partner org access');
    expect(db.insert).not.toHaveBeenCalled();
  });
  it('updates and archives a non-default card', async () => {
    state.reads.push([profile]);
    await expect(updateProfile(caller, id, partner, { name: 'New', isActive: false }))
      .resolves.toMatchObject({ name: 'New', isActive: false });
    expect(db.delete).not.toHaveBeenCalled();
  });
  it('maps a duplicate rename after the savepoint rolls back', async () => {
    vi.mocked(db.transaction).mockRejectedValueOnce(Object.assign(new Error('wrapped'), {
      cause: { code: '23505' },
    }));
    await expect(updateProfile(caller, id, partner, { name: 'Taken' }))
      .rejects.toMatchObject({ status: 409, code: 'PROFILE_NAME_TAKEN' });
  });
  it('allows a minimum larger than the rounding increment limit', async () => {
    state.reads.push([profile]);
    await expect(updateProfile(caller, id, partner, { baseMinimumMinutes: 600 }))
      .resolves.toMatchObject({ baseMinimumMinutes: 600 });
  });
  it('maps concurrent default conflicts after rollback', async () => {
    vi.mocked(db.transaction).mockRejectedValueOnce(Object.assign(new Error('wrapped'), {
      cause: { code: '23505' },
    }));
    await expect(setDefaultProfile(caller, id, partner))
      .rejects.toMatchObject({ status: 409, code: 'PROFILE_DEFAULT_CONFLICT' });
  });
  it('cannot archive the active default', async () => {
    state.reads.push([{ ...profile, isDefault: true }]);
    await expect(updateProfile(caller, id, partner, { isActive: false })).rejects.toMatchObject({ status: 409 });
  });
  it('returns 404 for another partner profile', async () => {
    state.reads.push([]);
    await expect(updateProfile(caller, id, partner, { name: 'Other' })).rejects.toMatchObject({ status: 404 });
    expect(sqlText(state.writes[0]!.where).params).toContain(partner);
  });
  it('locks currency once the base has a rate', async () => {
    state.reads.push([profile]);
    await expect(updateProfile(caller, id, partner, { currencyCode: 'EUR' })).rejects.toMatchObject({ code: 'PROFILE_CURRENCY_LOCKED' });
  });
  it('locks currency once any work-type row has a rate', async () => {
    state.reads.push([{ ...profile, baseHourlyRate: null }], [row]);
    await expect(updateProfile(caller, id, partner, { currencyCode: 'EUR' })).rejects.toMatchObject({ code: 'PROFILE_CURRENCY_LOCKED' });
  });
  it('rejects a rate on included base coverage', async () => {
    state.reads.push([profile]);
    await expect(updateProfile(caller, id, partner, { baseCoverage: 'included' })).rejects.toMatchObject({ status: 400 });
  });
  it('replaces every row in one transaction', async () => {
    state.reads.push([profile], [{ id: workTypeId }]);
    await expect(replaceProfileRows(caller, id, partner, [row])).resolves.toMatchObject({ id, rules: [row] });
    expect(db.transaction).toHaveBeenCalledTimes(1); expect(db.delete).toHaveBeenCalledTimes(1);
  });
  it('rolls back the delete when the replacement insert throws', async () => {
    state.reads.push([profile], [{ id: workTypeId }]); state.failInsert = true;
    await expect(replaceProfileRows(caller, id, partner, [row])).rejects.toThrow('insert failed');
    expect(state.storedRules).toEqual([{ workTypeId: 'old' }]);
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });
  it('clears all rules for an empty replacement', async () => {
    state.reads.push([profile]);
    await expect(replaceProfileRows(caller, id, partner, [])).resolves.toMatchObject({ rules: [] });
    expect(db.insert).not.toHaveBeenCalled();
  });
  it('rejects duplicate work types before deleting', async () => {
    await expect(replaceProfileRows(caller, id, partner, [row, row])).rejects.toMatchObject({ status: 400 });
    expect(db.delete).not.toHaveBeenCalled();
  });
  it('rejects unknown or cross-partner work types before deleting', async () => {
    state.reads.push([profile], []);
    await expect(replaceProfileRows(caller, id, partner, [row])).rejects.toMatchObject({ status: 404 });
    expect(db.delete).not.toHaveBeenCalled();
  });
  it('clones base columns and all rules but never default status', async () => {
    state.reads.push([{ ...profile, isDefault: true }], [row]);
    await cloneProfile(caller, id, partner, 'Copy');
    expect(state.inserted[0]).toMatchObject({ name: 'Copy', isDefault: false, baseHourlyRate: '150.00', baseMinimumMinutes: 30, roundingIncrementMinutes: 15 });
    expect(state.inserted[1]).toMatchObject({ ...row, billingProfileId: 'new', partnerId: partner });
  });
  it('clears only the same-currency default before setting the new one in one transaction', async () => {
    state.reads.push([profile]);
    await setDefaultProfile(caller, id, partner);
    const updates = state.writes.filter(w => w.kind === 'update');
    expect(updates.map(w => w.value.isDefault)).toEqual([false, true]);
    expect(sqlText(updates[0]!.where).params).toEqual(expect.arrayContaining([partner, 'USD']));
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });
});
describe('assignments and loader', () => {
  it('maps a missing organization from the canonical lock helper', async () => {
    state.reads.push([]);
    await expect(assignProfileToOrg(orgId, partner, id, workTypeId))
      .rejects.toMatchObject({ name: 'BillingProfileServiceError', status: 404, code: 'ORG_NOT_FOUND' });
  });
  it('rejects mismatched currency', async () => {
    state.reads.push([{ currencyCode: 'EUR' }], [profile]);
    await expect(assignProfileToOrg(orgId, partner, id, workTypeId)).rejects.toMatchObject({ status: 409, code: 'PROFILE_CURRENCY_MISMATCH' });
    expect(db.insert).not.toHaveBeenCalled();
  });
  it('rejects a card from another partner', async () => {
    state.reads.push([{ currencyCode: 'USD' }], []);
    await expect(assignProfileToOrg(orgId, partner, id, workTypeId)).rejects.toMatchObject({ status: 404 });
  });
  it('assigns a matching card and stamps the real actor', async () => {
    state.reads.push([{ currencyCode: 'USD' }], [profile], [{ id: orgId }]);
    await expect(assignProfileToOrg(orgId, partner, id, workTypeId)).resolves.toMatchObject({ orgId, partnerId: partner, assignedBy: workTypeId });
  });
  it('reads and clears with both partner and org predicates', async () => {
    state.reads.push([{ id: 'assignment' }]);
    await expect(getOrgAssignment(orgId, partner)).resolves.toEqual({ id: 'assignment' });
    expect(sqlText(state.writes[0]!.where).params).toEqual([orgId, partner]);
    await clearOrgAssignment(orgId, partner); expect(db.delete).toHaveBeenCalledTimes(1);
  });
  it('filters inactive candidates in SQL and retains an active default', async () => {
    state.reads.push([{ billingProfileId: id }], [], [profile], [row]);
    await expect(loadCardsForOrg(orgId, partner, 'USD')).resolves.toMatchObject({ assignedCard: null, partnerDefaultCard: { id, rules: [row] } });
    const queries = state.writes.filter(w => w.kind === 'select').map(w => sqlText(w.where));
    expect(queries[1]!.sql).toContain('is_active'); expect(queries[1]!.params).toContain(true);
    expect(queries[2]!.sql).toContain('is_active'); expect(queries[2]!.params).toContain(true);
  });
});
describe('ensureDefaultProfile', () => {
  it('returns an existing active default without inserting', async () => {
    state.reads.push([profile], [profile]);
    expect(await ensureDefaultProfile(partner, 'USD')).toEqual(profile);
    expect(await ensureDefaultProfile(partner, 'USD')).toEqual(profile);
    expect(db.insert).not.toHaveBeenCalled();
  });
  it('creates once when called twice for a new currency', async () => {
    const created = { ...profile, id: 'new', isDefault: true };
    state.reads.push([], [created]);
    await ensureDefaultProfile(partner, 'USD');
    await expect(ensureDefaultProfile(partner, 'USD')).resolves.toEqual(created);
    expect(db.insert).toHaveBeenCalledTimes(1);
  });
  it('concurrent callers return one winner without throwing', async () => {
    state.reads.push([], [], [{ id: 'new', currencyCode: 'USD' }]);
    state.conflicts.push(false, true);
    const results = await Promise.all([ensureDefaultProfile(partner, 'USD'), ensureDefaultProfile(partner, 'USD')]);
    expect(results.map(result => result.id)).toEqual(['new', 'new']);
    expect(state.inserted).toHaveLength(1);
  });
  it('creates an auditable billable no-rate default', async () => {
    state.reads.push([]);
    await expect(ensureDefaultProfile(partner, 'USD')).resolves.toMatchObject({ name: 'Standard rates', baseCoverage: 'billable', baseHourlyRate: null, isDefault: true });
  });
  it('reselects the winner after ON CONFLICT, without catching a 23505', async () => {
    state.reads.push([], [profile]); state.conflicts.push(true);
    await expect(ensureDefaultProfile(partner, 'USD')).resolves.toEqual(profile);
  });
  it('handles the partner-wide name collision for a second currency', async () => {
    state.reads.push([], []); state.conflicts.push(true, false);
    await expect(ensureDefaultProfile(partner, 'EUR')).resolves.toMatchObject({ name: 'Standard rates (EUR)', currencyCode: 'EUR' });
  });
});
