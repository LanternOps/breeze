/**
 * Unit tests for the P2-6 partner impact weights service (#4193, Task A6).
 *
 * `readWithPartnerAxisVisibility` is a real, unmocked import here (only its
 * three dependencies — `getCurrentDbAccessContext`, `runOutsideDbContext`,
 * `withSystemDbAccessContext` — are mocked in the `../../db` factory), so
 * these tests prove `loadImpactWeights` actually calls through the escape,
 * not just that a similarly-named function exists. The WHERE-clause
 * assertions compile the real condition objects the service builds (`eq`
 * from drizzle-orm is not mocked) with `PgDialect`, so a regression that
 * drops or mis-targets a predicate changes the compiled text/params, not
 * just a mock's call shape.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { AuthContext } from '../../middleware/auth';

const { getCurrentDbAccessContextMock, runOutsideDbContextMock, withSystemDbAccessContextMock, dbMock } =
  vi.hoisted(() => {
    const limit = vi.fn();
    const selectWhere = vi.fn((_condition?: unknown) => ({ limit }));
    const from = vi.fn(() => ({ where: selectWhere }));
    const select = vi.fn(() => ({ from }));

    const updateWhere = vi.fn((_condition?: unknown) => Promise.resolve(undefined));
    const set = vi.fn(() => ({ where: updateWhere }));
    const update = vi.fn(() => ({ set }));

    return {
      dbMock: { select, from, selectWhere, limit, update, set, updateWhere },
      getCurrentDbAccessContextMock: vi.fn<
        () => { scope: string; accessiblePartnerIds?: string[] | null } | undefined
      >(() => undefined),
      runOutsideDbContextMock: vi.fn(<T>(fn: () => T): T => fn()),
      withSystemDbAccessContextMock: vi.fn(async <T>(fn: () => Promise<T>): Promise<T> => fn()),
    };
  });

vi.mock('../../db', () => ({
  db: { select: dbMock.select, update: dbMock.update },
  getCurrentDbAccessContext: getCurrentDbAccessContextMock,
  runOutsideDbContext: runOutsideDbContextMock,
  withSystemDbAccessContext: withSystemDbAccessContextMock,
}));

import {
  ImpactPartnerUnresolvedError,
  loadImpactWeights,
  resolveImpactPartnerId,
  saveImpactWeights,
} from './impactWeights';
import { PartnerWideWriteDeniedError } from '../partnerWideAccess';
import { DEFAULT_IMPACT_WEIGHTS } from '@breeze/shared';

const PARTNER_ID = '00000000-0000-4000-8000-0000000000a1';
const ORG_ID = '00000000-0000-4000-8000-0000000000b2';

const compile = (node: unknown) => new PgDialect().sqlToQuery(node as never);

beforeEach(() => {
  vi.clearAllMocks();
  getCurrentDbAccessContextMock.mockReturnValue(undefined);

  dbMock.select.mockReturnValue({ from: dbMock.from });
  dbMock.from.mockReturnValue({ where: dbMock.selectWhere });
  dbMock.selectWhere.mockReturnValue({ limit: dbMock.limit });
  dbMock.limit.mockResolvedValue([]);

  dbMock.update.mockReturnValue({ set: dbMock.set });
  dbMock.set.mockReturnValue({ where: dbMock.updateWhere });
  dbMock.updateWhere.mockResolvedValue(undefined);
});

describe('loadImpactWeights', () => {
  it('reads through readWithPartnerAxisVisibility and defaults on a NULL column', async () => {
    dbMock.limit.mockResolvedValueOnce([{ aiImpactWeights: null }]);

    const result = await loadImpactWeights(PARTNER_ID);

    expect(result).toEqual({
      partnerId: PARTNER_ID,
      effective: DEFAULT_IMPACT_WEIGHTS,
      overrides: null,
    });
    // The escape helpers are the proof the read went through
    // readWithPartnerAxisVisibility rather than a plain db.select.
    expect(runOutsideDbContextMock).toHaveBeenCalledTimes(1);
    expect(withSystemDbAccessContextMock).toHaveBeenCalledTimes(1);
  });

  it('merges a stored partial override onto the defaults', async () => {
    dbMock.limit.mockResolvedValueOnce([{ aiImpactWeights: { fixExecuted: 1200 } }]);

    const result = await loadImpactWeights(PARTNER_ID);

    expect(result.effective.fixExecuted).toBe(1200);
    expect(result.effective.alertJudged).toBe(DEFAULT_IMPACT_WEIGHTS.alertJudged);
    expect(result.effective.noiseFlagged).toBe(DEFAULT_IMPACT_WEIGHTS.noiseFlagged);
    expect(result.effective.ticketTriaged).toBe(DEFAULT_IMPACT_WEIGHTS.ticketTriaged);
    expect(result.effective.draftSent).toBe(DEFAULT_IMPACT_WEIGHTS.draftSent);
    expect(result.effective.narrativeDelivered).toBe(DEFAULT_IMPACT_WEIGHTS.narrativeDelivered);
  });

  it('drops unknown/out-of-range keys, keeping only the valid override', async () => {
    dbMock.limit.mockResolvedValueOnce([
      { aiImpactWeights: { fixExecuted: 1200, bogus: 5, draftSent: -1 } },
    ]);

    const result = await loadImpactWeights(PARTNER_ID);

    expect(result.overrides).toEqual({ fixExecuted: 1200 });
    expect(result.effective.draftSent).toBe(DEFAULT_IMPACT_WEIGHTS.draftSent);
  });
});

describe('resolveImpactPartnerId', () => {
  it('returns auth.partnerId for organization scope', async () => {
    const auth = { scope: 'organization', partnerId: PARTNER_ID } as unknown as AuthContext;

    await expect(resolveImpactPartnerId(auth)).resolves.toBe(PARTNER_ID);
    expect(dbMock.select).not.toHaveBeenCalled();
  });

  it('returns auth.partnerId for partner scope', async () => {
    const auth = { scope: 'partner', partnerId: PARTNER_ID } as unknown as AuthContext;

    await expect(resolveImpactPartnerId(auth)).resolves.toBe(PARTNER_ID);
    expect(dbMock.select).not.toHaveBeenCalled();
  });

  it('rejects with ImpactPartnerUnresolvedError for system scope with no orgId', async () => {
    const auth = { scope: 'system', partnerId: null } as unknown as AuthContext;

    await expect(resolveImpactPartnerId(auth)).rejects.toBeInstanceOf(ImpactPartnerUnresolvedError);
    expect(dbMock.select).not.toHaveBeenCalled();
  });

  it('for system scope with an orgId, reads organizations.partner_id pinned to that org', async () => {
    dbMock.limit.mockResolvedValueOnce([{ partnerId: PARTNER_ID }]);
    const auth = { scope: 'system', partnerId: null } as unknown as AuthContext;

    await expect(resolveImpactPartnerId(auth, ORG_ID)).resolves.toBe(PARTNER_ID);

    const condition = dbMock.selectWhere.mock.calls[0]?.[0];
    const { sql, params } = compile(condition);
    expect(sql).toContain('"organizations"."id" =');
    expect(params).toEqual([ORG_ID]);
    // A plain org-axis read — no escape needed, unlike the partner-axis reads.
    expect(withSystemDbAccessContextMock).not.toHaveBeenCalled();
  });

  it('rejects with ImpactPartnerUnresolvedError when the org row does not exist', async () => {
    dbMock.limit.mockResolvedValueOnce([]);
    const auth = { scope: 'system', partnerId: null } as unknown as AuthContext;

    await expect(resolveImpactPartnerId(auth, ORG_ID)).rejects.toBeInstanceOf(
      ImpactPartnerUnresolvedError
    );
  });
});

describe('saveImpactWeights', () => {
  it('throws PartnerWideWriteDeniedError for a selected-access partner user, with no UPDATE', async () => {
    const auth = { scope: 'partner', partnerOrgAccess: 'selected' } as unknown as AuthContext;

    await expect(saveImpactWeights(auth, PARTNER_ID, { fixExecuted: 1200 })).rejects.toBeInstanceOf(
      PartnerWideWriteDeniedError
    );
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it('throws PartnerWideWriteDeniedError for organization scope, with no UPDATE', async () => {
    const auth = { scope: 'organization', partnerOrgAccess: null } as unknown as AuthContext;

    await expect(saveImpactWeights(auth, PARTNER_ID, { fixExecuted: 1200 })).rejects.toBeInstanceOf(
      PartnerWideWriteDeniedError
    );
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it('issues exactly one UPDATE with the normalized SET and a WHERE pinned to partners.id', async () => {
    dbMock.limit.mockResolvedValueOnce([{ aiImpactWeights: null }]);
    const auth = { scope: 'partner', partnerOrgAccess: 'all' } as unknown as AuthContext;

    const result = await saveImpactWeights(auth, PARTNER_ID, { fixExecuted: 1200, bogus: 5 } as never);

    expect(dbMock.update).toHaveBeenCalledTimes(1);
    expect(dbMock.set).toHaveBeenCalledExactlyOnceWith({ aiImpactWeights: { fixExecuted: 1200 } });

    const condition = dbMock.updateWhere.mock.calls[0]?.[0];
    const { sql, params } = compile(condition);
    expect(sql).toContain('"partners"."id" =');
    expect(params).toEqual([PARTNER_ID]);

    expect(result.after).toEqual({ fixExecuted: 1200 });
    expect(result.effective.fixExecuted).toBe(1200);
  });

  it('sets the column to null when overrides is null (reset to defaults)', async () => {
    dbMock.limit.mockResolvedValueOnce([{ aiImpactWeights: { fixExecuted: 1200 } }]);
    const auth = { scope: 'system', partnerOrgAccess: null } as unknown as AuthContext;

    const result = await saveImpactWeights(auth, PARTNER_ID, null);

    expect(dbMock.set).toHaveBeenCalledExactlyOnceWith({ aiImpactWeights: null });
    expect(result.before).toEqual({ fixExecuted: 1200 });
    expect(result.after).toBeNull();
    expect(result.effective).toEqual(DEFAULT_IMPACT_WEIGHTS);
  });

  it('does not go through readWithPartnerAxisVisibility for the write path', async () => {
    dbMock.limit.mockResolvedValueOnce([{ aiImpactWeights: null }]);
    const auth = { scope: 'system', partnerOrgAccess: null } as unknown as AuthContext;

    await saveImpactWeights(auth, PARTNER_ID, { fixExecuted: 1200 });

    expect(withSystemDbAccessContextMock).not.toHaveBeenCalled();
    expect(runOutsideDbContextMock).not.toHaveBeenCalled();
  });
});
