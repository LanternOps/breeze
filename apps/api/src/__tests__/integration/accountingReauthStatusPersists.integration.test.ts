/**
 * Real-DB proof that `getValidAccessToken` PERSISTS `status = 'reauth_required'`
 * when it concludes a connection needs reauthorization (#7189).
 *
 * The unit suite (`accountingTokens.test.ts`) mocks `markStatus` and asserts
 * only that it was called, so it cannot see whether the write survives. Before
 * #7189 two paths wrote the status and then threw `ReauthRequiredError` INSIDE
 * the same `db.transaction`, which rolled the write back — a revoked QuickBooks
 * grant stayed `connected` forever and every push/pull retried into the same
 * failure. Only Postgres can prove the write commits:
 *
 *  - `refreshFailureRecheck`: the provider refresh returns a genuine
 *    `invalid_grant` while the row still holds the token we tried.
 *  - `captureRefresh`: the in-memory connection looks refreshable, but the row
 *    read under lock carries an expired refresh token.
 *
 * A third case (the pre-lock expiry check, which already wrote outside the
 * transaction) is the control: it proves this harness can observe a committed
 * `reauth_required`, so a red on the other two is the rollback, not the test.
 */
import './setup';
import { describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { accountingConnections } from '../../db/schema';
import { createPartner } from './db-utils';
import { upsertConnection } from '../../services/accounting/accountingConnectionService';
import type { AccountingConnection } from '../../services/accounting/accountingConnectionService';

const refreshMock = vi.fn();

vi.mock('../../services/accounting/providerRegistry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/accounting/providerRegistry')>();
  return {
    ...actual,
    getAccountingProvider: () => ({ refresh: refreshMock }),
  };
});

import { getValidAccessToken, ReauthRequiredError } from '../../services/accounting/accountingTokens';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

async function seedConnection(opts: { refreshTokenExpiresAt: Date }): Promise<AccountingConnection> {
  return withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    return upsertConnection(db, partner.id, 'quickbooks', {
      realmId: `realm-reauth-${partner.id.slice(0, 8)}`,
      accessToken: 'stale-access-token',
      refreshToken: 'the-refresh-token',
      // Already inside the 5-minute refresh buffer, so a refresh is attempted.
      accessTokenExpiresAt: new Date(Date.now() - HOUR),
      refreshTokenExpiresAt: opts.refreshTokenExpiresAt,
      environment: 'sandbox',
      homeCurrency: 'USD',
    });
  });
}

async function readStatus(conn: AccountingConnection): Promise<{ status: string; lastError: string | null }> {
  return withSystemDbAccessContext(async () => {
    const [row] = await db
      .select({ status: accountingConnections.status, lastError: accountingConnections.lastError })
      .from(accountingConnections)
      .where(eq(accountingConnections.id, conn.id));
    if (!row) throw new Error(`connection ${conn.id} vanished`);
    return row;
  });
}

describe('getValidAccessToken persists reauth_required (#7189)', () => {
  runDb('control: pre-lock expired refresh token commits reauth_required', async () => {
    const conn = await seedConnection({ refreshTokenExpiresAt: new Date(Date.now() - DAY) });
    expect(conn.status).toBe('connected');

    await expect(getValidAccessToken(db, conn)).rejects.toBeInstanceOf(ReauthRequiredError);

    expect(await readStatus(conn)).toEqual({
      status: 'reauth_required',
      lastError: 'QuickBooks refresh token expired',
    });
    expect(refreshMock).not.toHaveBeenCalled();
  });

  runDb('refreshFailureRecheck: a genuine invalid_grant commits reauth_required', async () => {
    const conn = await seedConnection({ refreshTokenExpiresAt: new Date(Date.now() + 30 * DAY) });
    expect(conn.status).toBe('connected');
    refreshMock.mockReset();
    refreshMock.mockRejectedValueOnce(Object.assign(new Error('invalid_grant'), { status: 400, qboError: 'invalid_grant' }));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await expect(getValidAccessToken(db, conn)).rejects.toBeInstanceOf(ReauthRequiredError);
    } finally {
      consoleError.mockRestore();
    }

    expect(refreshMock).toHaveBeenCalledWith('the-refresh-token');
    expect(await readStatus(conn)).toEqual({
      status: 'reauth_required',
      lastError: 'QuickBooks refresh token is invalid or expired',
    });
  });

  runDb('captureRefresh: an expired refresh token on the locked row commits reauth_required', async () => {
    // The ROW's refresh token is expired; the caller's in-memory snapshot is
    // stale and still claims it is valid, so the pre-lock check passes and the
    // expiry is only discovered under the lock in Transaction A.
    const conn = await seedConnection({ refreshTokenExpiresAt: new Date(Date.now() - DAY) });
    const staleSnapshot: AccountingConnection = { ...conn, refreshTokenExpiresAt: new Date(Date.now() + 30 * DAY) };
    refreshMock.mockReset();

    await expect(getValidAccessToken(db, staleSnapshot)).rejects.toBeInstanceOf(ReauthRequiredError);

    expect(refreshMock).not.toHaveBeenCalled();
    expect(await readStatus(conn)).toEqual({
      status: 'reauth_required',
      lastError: 'QuickBooks refresh token expired',
    });
  });
});
