import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

const state = vi.hoisted(() => ({
  reads: [] as unknown[][], writes: [] as Array<{ kind: string; value?: any; where?: any }>,
  storedRules: [{ workTypeId: 'old' }] as any[], storedProfile: {} as any, failInsert: false, failRows: false,
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
          if (state.failInsert || (state.failRows && Array.isArray(value))) throw new Error('insert failed');
          if (state.conflicts.shift()) return [];
          const rows = (Array.isArray(value) ? value : [{ id: 'new', ...value }]);
          state.inserted.push(...rows);
          if (Array.isArray(value)) state.storedRules = rows;
          return rows;
        }, then: (resolve: any, reject: any) => result.returning().then(resolve, reject) };
      return result;
    } })),
    update: vi.fn(() => ({ set: (value: any) => ({ where: (where: unknown) => {
      state.writes.push({ kind: 'update', value, where });
      state.storedProfile = { ...state.storedProfile, ...value };
      return { returning: async () => [{ ...profile, ...value }], then: (resolve: any) => Promise.resolve([]).then(resolve) };
    } }) })),
    delete: vi.fn(() => ({ where: () => { state.storedRules = []; return Promise.resolve([]); } })),
    transaction: vi.fn(async (fn: any) => {
      const before = [...state.storedRules];
      const beforeProfile = { ...state.storedProfile };
      const beforeInserted = [...state.inserted];
      try { return await fn(executor); } catch (error) {
        state.storedRules = before; state.storedProfile = beforeProfile; state.inserted = beforeInserted; throw error;
      }
    }),
  };
  return { db: executor };
});
import { db } from '../db';
import {
  createProfile, updateProfile, saveProfile, replaceProfileRows, cloneProfile, setDefaultProfile,
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
  state.conflicts = []; state.storedRules = [{ workTypeId: 'old' }]; state.failInsert = false; state.failRows = false; state.storedProfile = { ...profile }; });

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
    state.reads.push([profile]);
    await expect(replaceProfileRows(caller, id, partner, [row, row])).rejects.toMatchObject({ status: 400 });
    expect(db.delete).not.toHaveBeenCalled();
  });
  it('rejects unknown or cross-partner work types before deleting', async () => {
    state.reads.push([profile], []);
    await expect(replaceProfileRows(caller, id, partner, [row])).rejects.toMatchObject({ status: 404 });
    expect(db.delete).not.toHaveBeenCalled();
  });
  it('saves metadata, base pricing, rounding and all rows in one transaction', async () => {
    state.reads.push([profile], [{ id: workTypeId }]);
    const input = { name: 'Revised', currencyCode: 'USD', notes: 'Service terms', baseCoverage: 'billable' as const,
      baseHourlyRate: '175.00', baseMinimumMinutes: 45, roundingIncrementMinutes: 30, rows: [row] };
    await expect(saveProfile(caller, id, partner, input)).resolves.toMatchObject({ name: input.name, baseHourlyRate: input.baseHourlyRate, rules: [row] });
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(state.storedProfile).toMatchObject({ name: 'Revised', baseHourlyRate: '175.00', baseMinimumMinutes: 45, roundingIncrementMinutes: 30 });
    expect(state.storedRules).toEqual([expect.objectContaining({ ...row, partnerId: partner, billingProfileId: id })]);
  });
  it('rolls back metadata and base pricing together with rows when the last insert fails', async () => {
    state.reads.push([profile], [{ id: workTypeId }]); state.failRows = true;
    await expect(saveProfile(caller, id, partner, { name: 'Revised', currencyCode: 'USD', baseCoverage: 'included',
      baseHourlyRate: null, baseMinimumMinutes: null, rows: [row] })).rejects.toThrow('insert failed');
    expect(state.storedProfile).toEqual(profile);
    expect(state.storedRules).toEqual([{ workTypeId: 'old' }]);
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });
  it('creates the base and rules atomically', async () => {
    state.reads.push([{ code: 'USD' }], [{ id: workTypeId }]);
    await createProfile(caller, partner, { name: 'Silver', currencyCode: 'USD', baseCoverage: 'billable', rows: [row] });
    expect(state.inserted).toEqual([expect.objectContaining({ name: 'Silver' }), expect.objectContaining({ ...row, billingProfileId: 'new' })]);
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });
  it('rolls back a new profile when its rules fail to save', async () => {
    state.reads.push([{ code: 'USD' }], [{ id: workTypeId }]); state.failRows = true;
    await expect(createProfile(caller, partner, { name: 'Silver', currencyCode: 'USD', baseCoverage: 'billable', rows: [row] }))
      .rejects.toThrow('insert failed');
    expect(state.inserted).toEqual([]);
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });
  it.each(['billable', 'included', 'non_billable'] as const)('saves %s base coverage and clears all rules', async baseCoverage => {
    state.reads.push([profile]);
    await expect(saveProfile(caller, id, partner, { name: 'Standard', currencyCode: 'USD', baseCoverage,
      baseHourlyRate: null, baseMinimumMinutes: null, rows: [] })).resolves.toMatchObject({ baseCoverage, baseHourlyRate: null, rules: [] });
  });
  it('rejects invalid base coverage pricing before writing either part of the card', async () => {
    state.reads.push([profile]);
    await expect(saveProfile(caller, id, partner, { name: 'Standard', currencyCode: 'USD', baseCoverage: 'included',
      baseHourlyRate: '50.00', rows: [] })).rejects.toMatchObject({ status: 400 });
    expect(db.update).not.toHaveBeenCalled(); expect(db.delete).not.toHaveBeenCalled();
  });
  it('rolls back base edits when a rule belongs to another partner', async () => {
    state.reads.push([profile], []);
    await expect(saveProfile(caller, id, partner, { name: 'Revised', currencyCode: 'USD', baseCoverage: 'billable',
      baseHourlyRate: '175.00', rows: [row] })).rejects.toMatchObject({ status: 404, code: 'WORK_TYPE_NOT_FOUND' });
    expect(state.storedProfile).toEqual(profile); expect(db.delete).not.toHaveBeenCalled();
  });
  it('rejects a cross-partner save before writing', async () => {
    state.reads.push([]);
    await expect(saveProfile(caller, id, partner, { name: 'Revised', currencyCode: 'USD', baseCoverage: 'billable', rows: [] }))
      .rejects.toMatchObject({ status: 404, code: 'PROFILE_NOT_FOUND' });
    expect(sqlText(state.writes[0]!.where).params).toContain(partner);
    expect(db.update).not.toHaveBeenCalled(); expect(db.delete).not.toHaveBeenCalled();
  });
  it('rejects selected-org saves in the service before querying', async () => {
    await expect(saveProfile({ scope: 'partner', partnerOrgAccess: 'selected' }, id, partner,
      { name: 'Revised', currencyCode: 'USD', baseCoverage: 'billable', rows: [] })).rejects.toThrow('full partner org access');
    expect(db.select).not.toHaveBeenCalled();
  });
  it('keeps the currency lock when saving base and work-type rows together', async () => {
    state.reads.push([profile]);
    await expect(saveProfile(caller, id, partner, { name: 'Revised', currencyCode: 'EUR', baseCoverage: 'billable',
      baseHourlyRate: null, rows: [] })).rejects.toMatchObject({ status: 409, code: 'PROFILE_CURRENCY_LOCKED' });
    expect(db.update).not.toHaveBeenCalled();
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
  it('uses the supplied transaction for every assignment query without opening another transaction', async () => {
    const executor = { select: vi.fn().mockImplementation(db.select), insert: vi.fn().mockImplementation(db.insert) } as unknown as typeof db;
    state.reads.push([{ currencyCode: 'USD' }], [profile], [{ id: orgId }]);
    await expect(assignProfileToOrg(orgId, partner, id, workTypeId, executor))
      .resolves.toMatchObject({ orgId, partnerId: partner, billingProfileId: id, assignedBy: workTypeId });
    expect(executor.select).toHaveBeenCalledTimes(3);
    expect(executor.insert).toHaveBeenCalledTimes(1);
    expect(db.transaction).not.toHaveBeenCalled();
  });
  it.each([
    { name: 'missing organization', reads: [[]], code: 'ORG_NOT_FOUND' },
    { name: 'another partner profile', reads: [[{ currencyCode: 'USD' }], []], code: 'PROFILE_NOT_FOUND' },
    { name: 'inactive profile', reads: [[{ currencyCode: 'USD' }], [{ ...profile, isActive: false }]], code: 'PROFILE_NOT_FOUND' },
    { name: 'currency mismatch', reads: [[{ currencyCode: 'EUR' }], [profile]], code: 'PROFILE_CURRENCY_MISMATCH' },
    { name: 'another partner organization', reads: [[{ currencyCode: 'USD' }], [profile], []], code: 'ORG_NOT_FOUND' },
  ])('preserves $name validation inside a supplied transaction', async ({ reads, code }) => {
    const executor = { select: vi.fn().mockImplementation(db.select), insert: vi.fn().mockImplementation(db.insert) } as unknown as typeof db;
    state.reads.push(...reads);
    await expect(assignProfileToOrg(orgId, partner, id, workTypeId, executor))
      .rejects.toMatchObject({ name: 'BillingProfileServiceError', code });
    expect(executor.select).toHaveBeenCalled();
    expect(executor.insert).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });
  it('clears the assignment through the supplied transaction with both ownership predicates', async () => {
    const where = vi.fn().mockResolvedValue([]);
    const executor = { delete: vi.fn().mockReturnValue({ where }) } as unknown as typeof db;
    await clearOrgAssignment(orgId, partner, executor);
    expect(executor.delete).toHaveBeenCalledTimes(1);
    expect(sqlText(where.mock.calls[0]![0]).params).toEqual([orgId, partner]);
    expect(db.delete).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });
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
    expect(db.transaction).toHaveBeenCalledTimes(1);
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
