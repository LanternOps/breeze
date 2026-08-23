import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { users } from '../db/schema/users';
import type { Tx as AuthLifecycleTransaction } from './authLifecycle';

export class RecoveryCodeInvalidError extends Error {
  constructor() {
    super('Invalid MFA code');
    this.name = 'RecoveryCodeInvalidError';
  }
}

export function normalizeRecoveryCode(code: string): string {
  const normalized = code.trim().toUpperCase();
  if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(normalized)) {
    throw new RecoveryCodeInvalidError();
  }
  return normalized;
}

export function getRecoveryCodePepper(): string {
  const pepper = process.env.MFA_RECOVERY_CODE_PEPPER?.trim();
  if (pepper) return pepper;
  if (process.env.NODE_ENV === 'test') return 'test-mfa-recovery-code-pepper';
  throw new Error('No MFA recovery code pepper configured. Set MFA_RECOVERY_CODE_PEPPER.');
}

export function hashRecoveryCode(code: string): string {
  const normalized = normalizeRecoveryCode(code);
  return createHash('sha256')
    .update(`${getRecoveryCodePepper()}:${normalized}`)
    .digest('hex');
}

export function hashRecoveryCodes(codes: string[]): string[] {
  return codes.map(hashRecoveryCode);
}

/**
 * Consume one matching recovery hash inside the caller-owned issuance
 * finalization. The relative jsonb delete composes under READ COMMITTED: two
 * distinct codes cannot resurrect each other, and the same-code loser sees
 * zero returned rows.
 */
export async function consumeRecoveryCode(
  tx: AuthLifecycleTransaction,
  userId: string,
  code: string,
): Promise<{ hash: string }> {
  const hash = hashRecoveryCode(code);
  const removed = await tx
    .update(users)
    .set({
      mfaRecoveryCodes: sql`${users.mfaRecoveryCodes} - ${hash}`,
      updatedAt: new Date(),
    })
    .where(and(
      eq(users.id, userId),
      sql`${users.mfaRecoveryCodes} @> ${JSON.stringify([hash])}::jsonb`,
    ))
    .returning({ id: users.id });
  if (removed.length !== 1) throw new RecoveryCodeInvalidError();
  return { hash };
}
