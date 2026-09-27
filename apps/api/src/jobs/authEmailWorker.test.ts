import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getEligibilityMock,
  advanceUserEpochsMock,
  setexMock,
  setMock,
  evalMock,
  sendPasswordResetMock,
  sendVerificationEmailMock,
  sendSignupAttemptMock,
  recordFailedLoginMock,
  createAuditLogMock,
  captureExceptionMock,
  peekPendingRegistrationMock,
  consumePendingRegistrationMock,
  dbSelectMock,
} = vi.hoisted(() => ({
  getEligibilityMock: vi.fn(),
  advanceUserEpochsMock: vi.fn(),
  setexMock: vi.fn(async (_key: string, _ttl: number, _value: string) => 'OK'),
  // ioredis-style: set(key, val, 'EX', ttl, 'NX') -> 'OK' | null. Defaults to
  // claiming the cooldown successfully (matches the pre-existing tests, which
  // exercise the always-first-request-in-window path).
  setMock: vi.fn(async (..._args: unknown[]): Promise<string | null> => 'OK'),
  // ioredis-style eval(script, numkeys, ...keys, ...argv) for the
  // compare-and-delete release. Defaults to "released" (1).
  evalMock: vi.fn(async (..._args: unknown[]): Promise<number> => 1),
  sendPasswordResetMock: vi.fn(async () => undefined),
  sendVerificationEmailMock: vi.fn(async (_p: { to: string; name?: string; verificationUrl: string }) => undefined),
  sendSignupAttemptMock: vi.fn(async (_p: { to: string; name?: string | null }) => undefined),
  recordFailedLoginMock: vi.fn(),
  createAuditLogMock: vi.fn(async () => undefined),
  captureExceptionMock: vi.fn(),
  peekPendingRegistrationMock: vi.fn(),
  consumePendingRegistrationMock: vi.fn(),
  dbSelectMock: vi.fn(),
}));

// The worker runs OUTSIDE a request. In production `withSystemDbAccessContext`
// establishes a real system-scope transaction so the FORCE-RLS `users` read /
// UPDATE isn't filtered to 0 rows. Here it (and db.transaction) simply run the
// callback — the real-DB context correctness is proven separately in
// authEmailWorker.integration.test.ts, which does NOT mock the DB.
vi.mock('../db', () => ({
  db: {
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
    select: dbSelectMock,
  },
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db/schema', () => ({
  users: { id: 'users.id', name: 'users.name', email: 'users.email' },
}));

// `eval` here is ioredis's client method for running a server-side Redis Lua
// script (EVAL command) — not JavaScript's eval. It executes literal Lua
// against Redis, no client-controlled code. Mocked only, never invoked.
const redis = { setex: setexMock, set: setMock, eval: evalMock };
vi.mock('../services/redis', () => ({
  getRedis: vi.fn(() => redis),
}));

vi.mock('../services/email', () => ({
  getEmailService: vi.fn(() => ({
    sendPasswordReset: sendPasswordResetMock,
    sendVerificationEmail: sendVerificationEmailMock,
    sendSignupAttemptOnExistingAccount: sendSignupAttemptMock,
  })),
}));

vi.mock('../services/pendingRegistration', () => ({
  peekPendingRegistration: peekPendingRegistrationMock,
  consumePendingRegistration: consumePendingRegistrationMock,
}));

vi.mock('../services/passwordResetEligibility', () => ({
  getPasswordResetEligibility: getEligibilityMock,
}));

vi.mock('../services/authLifecycle', () => ({
  advanceUserEpochs: advanceUserEpochsMock,
}));

vi.mock('../services/anomalyMetrics', () => ({
  recordFailedLogin: recordFailedLoginMock,
}));

vi.mock('../services/auditService', () => ({
  createAuditLog: createAuditLogMock,
}));

vi.mock('../services/sentry', () => ({
  captureException: captureExceptionMock,
}));

import { handleAuthEmailJob } from './authEmailWorker';

describe('handleAuthEmailJob — password-reset', () => {
  beforeEach(() => {
    getEligibilityMock.mockReset();
    advanceUserEpochsMock.mockReset();
    setexMock.mockReset();
    setexMock.mockResolvedValue('OK');
    setMock.mockReset();
    setMock.mockResolvedValue('OK');
    evalMock.mockReset();
    evalMock.mockResolvedValue(1);
    sendPasswordResetMock.mockReset();
    sendPasswordResetMock.mockResolvedValue(undefined);
    recordFailedLoginMock.mockReset();
    createAuditLogMock.mockReset();
    createAuditLogMock.mockResolvedValue(undefined);
    captureExceptionMock.mockReset();
  });

  it('an ELIGIBLE user: advances password_reset_epoch, writes the envelope, sends the mail', async () => {
    getEligibilityMock.mockResolvedValue({
      allowed: true, userId: 'u1', email: 'admin@msp.com',
    });
    advanceUserEpochsMock.mockResolvedValue({
      authEpoch: 1, mfaEpoch: 1, emailEpoch: 1, passwordResetEpoch: 7,
    });
    await handleAuthEmailJob({ kind: 'password-reset', email: 'admin@msp.com' });
    const [key, ttl, value] = setexMock.mock.calls[0]!;
    expect(key).toMatch(/^reset:[0-9a-f]{64}$/);
    expect(ttl).toBe(3600);
    expect(JSON.parse(value as string)).toEqual({
      userId: 'u1', passwordResetEpoch: 7, email: 'admin@msp.com',
    });
    expect(sendPasswordResetMock).toHaveBeenCalledTimes(1);
    expect(sendPasswordResetMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'admin@msp.com' }),
    );
  });

  it('an UNKNOWN address: no epoch advance, no envelope, no mail — and no throw', async () => {
    getEligibilityMock.mockResolvedValue({ allowed: false, reason: 'unknown_user' });
    await expect(
      handleAuthEmailJob({ kind: 'password-reset', email: 'nobody@nowhere.test' }),
    ).resolves.toBeUndefined();
    expect(advanceUserEpochsMock).not.toHaveBeenCalled();
    expect(setexMock).not.toHaveBeenCalled();
    expect(sendPasswordResetMock).not.toHaveBeenCalled();
    expect(createAuditLogMock).not.toHaveBeenCalled();
  });

  it('an INELIGIBLE known user (tenant_inactive): denial audit + anomaly metric, no mail', async () => {
    getEligibilityMock.mockResolvedValue({
      allowed: false, reason: 'tenant_inactive', detail: 'partner:suspended', userId: 'u1', email: 'admin@msp.com',
    });
    await handleAuthEmailJob({ kind: 'password-reset', email: 'admin@msp.com' });
    expect(sendPasswordResetMock).not.toHaveBeenCalled();
    expect(advanceUserEpochsMock).not.toHaveBeenCalled();
    expect(setexMock).not.toHaveBeenCalled();
    expect(recordFailedLoginMock).toHaveBeenCalledWith('reset_tenant_inactive');
    expect(createAuditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'user.password.reset.requested',
        result: 'denied',
        resourceId: 'u1',
        details: expect.objectContaining({ reason: 'tenant_inactive', detail: 'partner:suspended' }),
      }),
    );
  });

  it('an SSO-blocked known user: denial audit, NO anomaly metric, no mail', async () => {
    getEligibilityMock.mockResolvedValue({
      allowed: false, reason: 'sso_required', userId: 'u2', email: 'sso@msp.com',
    });
    await handleAuthEmailJob({ kind: 'password-reset', email: 'sso@msp.com' });
    expect(sendPasswordResetMock).not.toHaveBeenCalled();
    // Only tenant_inactive feeds the inactive-tenant signal.
    expect(recordFailedLoginMock).not.toHaveBeenCalled();
    expect(createAuditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'user.password.reset.requested', result: 'denied' }),
    );
  });

  it('claims a per-user cooldown before minting a new generation (keyed on userId, NX+EX)', async () => {
    getEligibilityMock.mockResolvedValue({ allowed: true, userId: 'u1', email: 'admin@msp.com' });
    advanceUserEpochsMock.mockResolvedValue({
      authEpoch: 1, mfaEpoch: 1, emailEpoch: 1, passwordResetEpoch: 7,
    });
    await handleAuthEmailJob({ kind: 'password-reset', email: 'admin@msp.com' });
    expect(setMock).toHaveBeenCalledTimes(1);
    const [key, value, ...rest] = setMock.mock.calls[0]!;
    expect(key).toBe('reset-cooldown:u1');
    // A unique per-attempt token, not a constant sentinel — the release path
    // is a compare-and-delete keyed on this exact value (see the dedicated
    // release tests below).
    expect(typeof value).toBe('string');
    expect((value as string).length).toBeGreaterThan(0);
    expect(rest).toContain('NX');
    expect(rest).toContain('EX');
    // Nothing released a claim that was never contested.
    expect(evalMock).not.toHaveBeenCalled();
  });

  it('a second accepted request for the SAME user inside the cooldown window: no epoch advance, no mail', async () => {
    getEligibilityMock.mockResolvedValue({ allowed: true, userId: 'u1', email: 'admin@msp.com' });
    setMock.mockResolvedValueOnce(null); // cooldown already held by a prior request
    await expect(
      handleAuthEmailJob({ kind: 'password-reset', email: 'admin@msp.com' }),
    ).resolves.toBeUndefined();
    expect(advanceUserEpochsMock).not.toHaveBeenCalled();
    expect(setexMock).not.toHaveBeenCalled();
    expect(sendPasswordResetMock).not.toHaveBeenCalled();
    expect(createAuditLogMock).not.toHaveBeenCalled();
  });

  it('a send failure releases the cooldown claim (compare-and-delete, this token only) and re-throws for BullMQ retry', async () => {
    getEligibilityMock.mockResolvedValue({ allowed: true, userId: 'u1', email: 'admin@msp.com' });
    advanceUserEpochsMock.mockResolvedValue({
      authEpoch: 1, mfaEpoch: 1, emailEpoch: 1, passwordResetEpoch: 7,
    });
    const sendError = new Error('smtp unavailable');
    sendPasswordResetMock.mockRejectedValueOnce(sendError);

    await expect(
      handleAuthEmailJob({ kind: 'password-reset', email: 'admin@msp.com' }),
    ).rejects.toThrow(sendError);

    // Released using the SAME token this attempt claimed with — proves the
    // release is a compare-and-delete, not a bare DEL.
    const [claimKey, claimToken] = setMock.mock.calls[0]!;
    expect(evalMock).toHaveBeenCalledTimes(1);
    const [script, numKeys, evalKey, evalToken] = evalMock.mock.calls[0]!;
    expect(script).toMatch(/DEL/);
    expect(numKeys).toBe(1);
    expect(evalKey).toBe(claimKey);
    expect(evalToken).toBe(claimToken);
  });

  it('after a released claim, a retried job successfully claims the SAME key again and sends', async () => {
    getEligibilityMock.mockResolvedValue({ allowed: true, userId: 'u1', email: 'admin@msp.com' });
    advanceUserEpochsMock.mockResolvedValue({
      authEpoch: 1, mfaEpoch: 1, emailEpoch: 1, passwordResetEpoch: 7,
    });
    sendPasswordResetMock.mockRejectedValueOnce(new Error('smtp unavailable'));

    await expect(
      handleAuthEmailJob({ kind: 'password-reset', email: 'admin@msp.com' }),
    ).rejects.toThrow();

    // BullMQ's retry re-invokes the handler. setMock still resolves 'OK' by
    // default (the key was released, not left claimed), so the retry can
    // claim it again and this time the send succeeds.
    await handleAuthEmailJob({ kind: 'password-reset', email: 'admin@msp.com' });
    expect(sendPasswordResetMock).toHaveBeenCalledTimes(2);
    expect(setMock).toHaveBeenCalledTimes(2);
  });

  it('fails CLOSED (throws for retry) when Redis is unavailable for an eligible user', async () => {
    getEligibilityMock.mockResolvedValue({ allowed: true, userId: 'u1', email: 'admin@msp.com' });
    const { getRedis } = await import('../services/redis');
    vi.mocked(getRedis).mockReturnValueOnce(null as never);
    await expect(
      handleAuthEmailJob({ kind: 'password-reset', email: 'admin@msp.com' }),
    ).rejects.toThrow();
    expect(advanceUserEpochsMock).not.toHaveBeenCalled();
    expect(sendPasswordResetMock).not.toHaveBeenCalled();
  });
});

function usersSelectChain(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
      }),
    }),
  };
}

const pendingRecord = {
  email: 'new@corp.com',
  companyName: 'Acme',
  name: 'New Admin',
  passwordHash: 'argon2-hash',
  acceptTerms: true,
  termsVersion: 'v1',
  hostedExpectation: true,
  createdAt: Date.now(),
  signupIp: '203.0.113.7',
  signupUserAgent: 'Mozilla/5.0 (signup)',
  rawToken: 'RAW-TOKEN-VALUE',
};

describe('handleAuthEmailJob — registration (SR2-21)', () => {
  beforeEach(() => {
    peekPendingRegistrationMock.mockReset();
    consumePendingRegistrationMock.mockReset();
    dbSelectMock.mockReset();
    sendVerificationEmailMock.mockReset();
    sendVerificationEmailMock.mockResolvedValue(undefined);
    sendSignupAttemptMock.mockReset();
    sendSignupAttemptMock.mockResolvedValue(undefined);
    captureExceptionMock.mockReset();
  });

  it('an address with NO account: sends the signup-verification link carrying the raw token', async () => {
    peekPendingRegistrationMock.mockResolvedValue(pendingRecord);
    dbSelectMock.mockReturnValue(usersSelectChain([]) as never); // no existing user

    await handleAuthEmailJob({ kind: 'registration', tokenHash: 'h' });

    expect(sendVerificationEmailMock).toHaveBeenCalledTimes(1);
    const [arg] = sendVerificationEmailMock.mock.calls[0]!;
    expect(arg).toMatchObject({ to: 'new@corp.com', name: 'New Admin' });
    expect((arg as { verificationUrl: string }).verificationUrl).toContain(
      encodeURIComponent('RAW-TOKEN-VALUE'),
    );
    // The "already have an account" notice must NOT be sent for a free address.
    expect(sendSignupAttemptMock).not.toHaveBeenCalled();
  });

  it('an address WITH an account: sends the "someone tried to sign up" notice, NOT a signup link (Q5 option b)', async () => {
    peekPendingRegistrationMock.mockResolvedValue(pendingRecord);
    dbSelectMock.mockReturnValue(usersSelectChain([{ id: 'existing-u', name: 'Real Owner' }]) as never);

    await handleAuthEmailJob({ kind: 'registration', tokenHash: 'h' });

    expect(sendSignupAttemptMock).toHaveBeenCalledTimes(1);
    expect(sendSignupAttemptMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'new@corp.com', name: 'Real Owner' }),
    );
    // Critically: the verification link is NEVER mailed to an existing holder.
    expect(sendVerificationEmailMock).not.toHaveBeenCalled();
  });

  it('the pending record is NOT consumed by the worker (only the click consumes it)', async () => {
    peekPendingRegistrationMock.mockResolvedValue(pendingRecord);
    dbSelectMock.mockReturnValue(usersSelectChain([]) as never);

    await handleAuthEmailJob({ kind: 'registration', tokenHash: 'h' });

    expect(consumePendingRegistrationMock).not.toHaveBeenCalled();
    expect(peekPendingRegistrationMock).toHaveBeenCalledWith('h');
  });

  it('an expired/absent record: no email, no throw (no retry)', async () => {
    peekPendingRegistrationMock.mockResolvedValue(null);
    await expect(
      handleAuthEmailJob({ kind: 'registration', tokenHash: 'gone' }),
    ).resolves.toBeUndefined();
    expect(sendVerificationEmailMock).not.toHaveBeenCalled();
    expect(sendSignupAttemptMock).not.toHaveBeenCalled();
  });
});
