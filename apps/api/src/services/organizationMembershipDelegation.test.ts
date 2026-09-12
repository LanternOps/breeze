import { describe, expect, it, vi } from 'vitest';
import type { db } from '../db';
import { resolveDelegatedSiteIds } from './organizationMembershipDelegation';

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

function transactionWithRows(membershipRows: unknown[], siteRows: unknown[] = []) {
  let selectIndex = 0;
  const select = vi.fn(() => {
    const rows = selectIndex++ === 0 ? membershipRows : siteRows;
    const terminal = { for: vi.fn().mockResolvedValue(rows) };
    return {
      from: () => ({
        where: () => ({
          ...terminal,
          limit: () => terminal,
        }),
      }),
    };
  });
  return { tx: { select } as unknown as Transaction, select };
}

describe('resolveDelegatedSiteIds', () => {
  it('inherits and deduplicates a restricted inviter scope when siteIds is omitted', async () => {
    const { tx, select } = transactionWithRows([{ siteIds: ['site-a', 'site-a', 'site-b'] }], [
      { id: 'site-a' },
      { id: 'site-b' },
    ]);

    await expect(resolveDelegatedSiteIds(tx, {
      inviterUserId: 'user-a',
      orgId: 'org-a',
    })).resolves.toEqual(['site-a', 'site-b']);
    expect(select).toHaveBeenCalledTimes(2);
  });

  it('allows only an explicit subset of a restricted inviter scope', async () => {
    const { tx } = transactionWithRows([{ siteIds: ['site-a', 'site-b'] }], [{ id: 'site-b' }]);
    await expect(resolveDelegatedSiteIds(tx, {
      inviterUserId: 'user-a',
      orgId: 'org-a',
      requestedSiteIds: ['site-b'],
    })).resolves.toEqual(['site-b']);
  });

  it('preserves an explicit empty scope as restricted-to-no-sites', async () => {
    const { tx, select } = transactionWithRows([{ siteIds: ['site-a'] }]);
    await expect(resolveDelegatedSiteIds(tx, {
      inviterUserId: 'user-a',
      orgId: 'org-a',
      requestedSiteIds: [],
    })).resolves.toEqual([]);
    expect(select).toHaveBeenCalledTimes(1);
  });

  it('rejects an explicit site outside the inviter scope before probing site existence', async () => {
    const { tx, select } = transactionWithRows([{ siteIds: ['site-a'] }]);
    await expect(resolveDelegatedSiteIds(tx, {
      inviterUserId: 'user-a',
      orgId: 'org-a',
      requestedSiteIds: ['site-hidden'],
    })).rejects.toMatchObject({ status: 403 });
    expect(select).toHaveBeenCalledTimes(1);
  });

  it('preserves unrestricted only for an unrestricted inviter', async () => {
    const { tx, select } = transactionWithRows([{ siteIds: null }]);
    await expect(resolveDelegatedSiteIds(tx, {
      inviterUserId: 'user-a',
      orgId: 'org-a',
    })).resolves.toBeNull();
    expect(select).toHaveBeenCalledTimes(1);
  });

  it('rejects an unknown or foreign site for an unrestricted inviter', async () => {
    const { tx } = transactionWithRows([{ siteIds: null }], []);
    await expect(resolveDelegatedSiteIds(tx, {
      inviterUserId: 'user-a',
      orgId: 'org-a',
      requestedSiteIds: ['not-in-org-a'],
    })).rejects.toMatchObject({ status: 400 });
  });

  it('fails closed if the inviter no longer has an organization membership', async () => {
    const { tx, select } = transactionWithRows([]);
    await expect(resolveDelegatedSiteIds(tx, {
      inviterUserId: 'user-a',
      orgId: 'org-a',
    })).rejects.toMatchObject({ status: 403 });
    expect(select).toHaveBeenCalledTimes(1);
  });
});
