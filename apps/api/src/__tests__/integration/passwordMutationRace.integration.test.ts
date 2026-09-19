import './setup';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

const hashPause = vi.hoisted(() => ({
  active: false,
  entered: undefined as (() => void) | undefined,
  wait: undefined as Promise<void> | undefined,
}));

vi.mock('../../services', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services')>();
  return {
    ...actual,
    hashPassword: vi.fn(async (password: string) => {
      if (hashPause.active) {
        hashPause.entered?.();
        await hashPause.wait;
      }
      return actual.hashPassword(password);
    }),
  };
});

import { passwordRoutes } from '../../routes/auth/password';
import { db, withSystemDbAccessContext } from '../../db';
import { partnerUsers, users } from '../../db/schema';
import { advanceUserEpochs } from '../../services/authLifecycle';
import { hashPassword as hashPasswordDirect } from '../../services/password';
import { createAccessToken } from '../../services/jwt';
import { createPartner, createUser } from './db-utils';
import { getTestDb, getTestRedis } from './setup';

const CURRENT_PASSWORD = 'CurrentPass123!';
const REQUEST_PASSWORD = 'RequestedPass123!';
const WINNING_PASSWORD = 'WinningPass123!';

function pauseNextRouteHash() {
  let enteredResolve!: () => void;
  let releaseResolve!: () => void;
  const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
  const wait = new Promise<void>((resolve) => { releaseResolve = resolve; });
  hashPause.active = true;
  hashPause.entered = enteredResolve;
  hashPause.wait = wait;
  return { entered, release: releaseResolve };
}

async function readUser(userId: string) {
  const [row] = await getTestDb().select().from(users).where(eq(users.id, userId)).limit(1);
  if (!row) throw new Error(`missing user ${userId}`);
  return row;
}

afterEach(() => {
  hashPause.active = false;
  hashPause.entered = undefined;
  hashPause.wait = undefined;
});

describe('password mutations retain their authorizing generation through commit', () => {
  it('lets a newer reset generation win while an older redemption hashes, rolling back the stale password', async () => {
    const partner = await createPartner();
    const user = await createUser({
      partnerId: partner.id,
      password: CURRENT_PASSWORD,
      status: 'active',
      withMembership: true,
    });
    const before = await readUser(user.id);
    const token = 'synthetic-reset-token';
    const tokenHash = createHash('sha256').update(token).digest('hex');
    await getTestRedis().set(
      `reset:${tokenHash}`,
      JSON.stringify({
        userId: user.id,
        passwordResetEpoch: before.passwordResetEpoch,
        email: before.email,
      }),
      'EX',
      60,
    );

    const gate = pauseNextRouteHash();
    const redeeming = passwordRoutes.request('/reset-password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, password: REQUEST_PASSWORD }),
    });
    await gate.entered;

    await withSystemDbAccessContext(() =>
      db.transaction((tx) => advanceUserEpochs(tx, user.id, { passwordReset: true })),
    );
    const winner = await readUser(user.id);
    gate.release();

    const response = await redeeming;
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid or expired reset token' });
    const after = await readUser(user.id);
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(after.passwordResetEpoch).toBe(winner.passwordResetEpoch);
  });

  it('lets a newer password transition win while an admitted change hashes, rolling back the stale write', async () => {
    const partner = await createPartner();
    const user = await createUser({
      partnerId: partner.id,
      password: CURRENT_PASSWORD,
      status: 'active',
      withMembership: true,
    });
    const before = await readUser(user.id);
    const [membership] = await getTestDb()
      .select({ roleId: partnerUsers.roleId })
      .from(partnerUsers)
      .where(eq(partnerUsers.userId, user.id))
      .limit(1);
    if (!membership) throw new Error('missing partner membership');
    const bearer = await createAccessToken({
      sub: user.id,
      email: user.email,
      roleId: membership.roleId,
      orgId: null,
      partnerId: partner.id,
      scope: 'partner',
      mfa: false,
      aep: before.authEpoch,
      mep: before.mfaEpoch,
      sid: randomUUID(),
    });
    const winningHash = await hashPasswordDirect(WINNING_PASSWORD);

    const gate = pauseNextRouteHash();
    const changing = passwordRoutes.request('/change-password', {
      method: 'POST',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      body: JSON.stringify({ currentPassword: CURRENT_PASSWORD, newPassword: REQUEST_PASSWORD }),
    });
    await gate.entered;

    await withSystemDbAccessContext(() =>
      db.transaction(async (tx) => {
        await tx.update(users).set({ passwordHash: winningHash }).where(eq(users.id, user.id));
        await advanceUserEpochs(tx, user.id, { auth: true, passwordReset: true });
      }),
    );
    const winner = await readUser(user.id);
    gate.release();

    const response = await changing;
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Current password is incorrect',
      message: 'Current password is incorrect',
      code: 'invalid_credentials',
    });
    const after = await readUser(user.id);
    expect(after.passwordHash).toBe(winningHash);
    expect(after.authEpoch).toBe(winner.authEpoch);
    expect(after.passwordResetEpoch).toBe(winner.passwordResetEpoch);
  });
});
