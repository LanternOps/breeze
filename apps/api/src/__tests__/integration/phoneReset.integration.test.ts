import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { partnerUsers, users } from '../../db/schema';
import { createPartner, createUser } from './db-utils';
import { getTestDb, getTestRedis } from './setup';
import { createAccessToken } from '../../services/jwt';
import { resetAllFactorsAndInvalidate } from '../../services/mfaFactorReset';
import { invalidateMfaAssuranceAfterFactorChange } from '../../services/mfaAssurance';
import { EpochAdvancePreconditionError } from '../../services/authLifecycle';
import { withSystemDbAccessContext } from '../../db';

const provider = vi.hoisted(() => ({ send: vi.fn(), check: vi.fn() }));
vi.mock('../../services/twilio', () => ({ getTwilioService: () => ({
  sendVerificationCode: provider.send, checkVerificationCode: provider.check,
}) }));
import { phoneRoutes } from '../../routes/auth/phone';

const PASSWORD = 'TestPass123!';
const PHONE = '+15555550100';

async function userRow(id: string) {
  const [row] = await getTestDb().select().from(users).where(eq(users.id, id));
  return row!;
}

async function fixture() {
  provider.send.mockResolvedValue({ success: true });
  provider.check.mockResolvedValue({ valid: true });
  const partner = await createPartner();
  const target = await createUser({ partnerId: partner.id, password: PASSWORD, withMembership: true, status: 'active' });
  const [membership] = await getTestDb().select().from(partnerUsers).where(eq(partnerUsers.userId, target.id));
  const mint = async () => {
    const live = await userRow(target.id);
    return createAccessToken({ sub: target.id, email: target.email, roleId: membership!.roleId,
      orgId: null, partnerId: partner.id, scope: 'partner', mfa: false,
      aep: live.authEpoch, mep: live.mfaEpoch, sid: randomUUID() });
  };
  const request = (path: string, token: string) => phoneRoutes.request(path, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ phoneNumber: PHONE, code: '123456', currentPassword: PASSWORD }),
  });
  return { target, mint, request };
}

describe('phone enrollment cannot restore factors across MFA reset', () => {
  it('rejects a stale secondary-factor write before mutation or another epoch advance', async () => {
    const { target } = await fixture();
    const before = await userRow(target.id);
    await resetAllFactorsAndInvalidate(target.id, 'admin-mfa-reset');
    const reset = await userRow(target.id);
    const mutate = vi.fn();
    await expect(withSystemDbAccessContext(() => invalidateMfaAssuranceAfterFactorChange(
      target.id, 'phone-replacement', mutate,
      { authEpoch: before.authEpoch, mfaEpoch: before.mfaEpoch, status: 'active' },
    ))).rejects.toBeInstanceOf(EpochAdvancePreconditionError);
    expect(mutate).not.toHaveBeenCalled();
    expect(await userRow(target.id)).toEqual(reset);
  });

  it('rejects a confirmation already waiting on the provider when reset commits', async () => {
    const { target, mint, request } = await fixture();
    const token = await mint();
    expect((await request('/phone/verify', token)).status).toBe(200);
    let release!: () => void;
    let entered!: () => void;
    const enteredProvider = new Promise<void>((resolve) => { entered = resolve; });
    const releaseProvider = new Promise<void>((resolve) => { release = resolve; });
    provider.check.mockImplementationOnce(async () => { entered(); await releaseProvider; return { valid: true }; });
    const confirming = request('/phone/confirm', token);
    try {
      await enteredProvider;
      await resetAllFactorsAndInvalidate(target.id, 'admin-mfa-reset');
    } finally {
      release();
    }
    expect((await confirming).status).toBe(409);
    expect(await userRow(target.id)).toMatchObject({ phoneNumber: null, phoneVerified: false, mfaEnabled: false });
  });

  it('rejects a preserved old SMS setup after fresh login, but permits newly requested verification', async () => {
    const { target, mint, request } = await fixture();
    expect((await request('/phone/verify', await mint())).status).toBe(200);
    const redis = getTestRedis();
    const key = `sms:phone-setup:${target.id}`;
    const oldSetup = await redis.get(key);
    expect(oldSetup).not.toBeNull();
    await resetAllFactorsAndInvalidate(target.id, 'admin-mfa-reset');
    await redis.set(key, oldSetup!, 'EX', 600);
    const freshToken = await mint();
    expect((await request('/phone/confirm', freshToken)).status).toBe(400);
    expect(await userRow(target.id)).toMatchObject({ phoneNumber: null, phoneVerified: false });
    expect((await request('/phone/verify', freshToken)).status).toBe(200);
    expect((await request('/phone/confirm', freshToken)).status).toBe(200);
    expect(await userRow(target.id)).toMatchObject({ phoneNumber: PHONE, phoneVerified: true, mfaEnabled: false });
  });
});
