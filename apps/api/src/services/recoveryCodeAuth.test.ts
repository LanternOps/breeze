import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { Tx as AuthLifecycleTransaction } from './authLifecycle';
import {
  RecoveryCodeInvalidError,
  consumeRecoveryCode,
  hashRecoveryCode,
  normalizeRecoveryCode,
} from './recoveryCodeAuth';

function transactionHarness(returningRows: Array<{ id: string }>) {
  const setValues = vi.fn();
  const returning = vi.fn(async () => returningRows);
  const where = vi.fn(() => ({ returning }));
  const set = vi.fn((value: Record<string, unknown>) => {
    setValues(value);
    return { where };
  });
  const update = vi.fn(() => ({ set }));
  return {
    tx: { update } as unknown as AuthLifecycleTransaction,
    setValues,
    where,
  };
}

describe('recovery-code finalization helper', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'test';
  });

  it('normalizes and hashes a documented recovery code without retaining plaintext', () => {
    expect(normalizeRecoveryCode('  abcd-2345  ')).toBe('ABCD-2345');
    expect(hashRecoveryCode('  abcd-2345  ')).toMatch(/^scrypt\$v1\$[a-f0-9]{64}$/);
    expect(hashRecoveryCode('  abcd-2345  ')).not.toContain('ABCD-2345');
    expect(hashRecoveryCode('  abcd-2345  ')).toBe(hashRecoveryCode('ABCD-2345'));
  });

  it('rejects malformed recovery authority before any database write', async () => {
    const harness = transactionHarness([{ id: 'user-1' }]);

    await expect(consumeRecoveryCode(harness.tx, 'user-1', 'abcd2345'))
      .rejects.toBeInstanceOf(RecoveryCodeInvalidError);

    expect(harness.setValues).not.toHaveBeenCalled();
  });

  it('uses one relative database delete guarded by the exact user and hash', async () => {
    const harness = transactionHarness([{ id: 'user-1' }]);
    const hash = hashRecoveryCode('ABCD-2345');

    await expect(consumeRecoveryCode(harness.tx, 'user-1', 'ABCD-2345'))
      .resolves.toEqual({ hash });

    const values = harness.setValues.mock.calls[0]![0] as Record<string, unknown>;
    expect('mfaRecoveryCodes' in values).toBe(true);
    expect(Array.isArray(values.mfaRecoveryCodes)).toBe(false);
    const rendered = new PgDialect().sqlToQuery(values.mfaRecoveryCodes as never);
    expect(rendered.sql).toContain('mfa_recovery_codes');
    expect(rendered.params).toContain(hash);
    expect(rendered.params).not.toContain('ABCD-2345');
    expect(rendered.params.some((value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)))
      .toBe(true); // rolling compatibility: one-time legacy SHA-256 hashes
    expect(harness.where).toHaveBeenCalledOnce();
  });

  it('rejects the compare/delete loser without granting success', async () => {
    const harness = transactionHarness([]);

    await expect(consumeRecoveryCode(harness.tx, 'user-1', 'ABCD-2345'))
      .rejects.toBeInstanceOf(RecoveryCodeInvalidError);
  });
});
