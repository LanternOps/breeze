import { eq } from 'drizzle-orm';
import { db } from '../db';
import { users } from '../db/schema';
import { hashPassword, verifyPassword } from './password';

const MAX_PIN_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60_000;

export async function setApproverPin(userId: string, pin: string): Promise<void> {
  const approverPinHash = await hashPassword(pin);
  await db.update(users).set({
    approverPinHash,
    approverPinSetAt: new Date(),
    approverPinFailedCount: 0,
    approverPinLockedUntil: null,
  }).where(eq(users.id, userId));
}

export async function verifyPinAttempt(userId: string, pin: string): Promise<{ verified: boolean; locked: boolean }> {
  const [u] = await db.select({
    hash: users.approverPinHash,
    failed: users.approverPinFailedCount,
    lockedUntil: users.approverPinLockedUntil,
  }).from(users).where(eq(users.id, userId)).limit(1);
  if (!u || !u.hash) return { verified: false, locked: false };
  const now = new Date();
  if (u.lockedUntil && u.lockedUntil > now) return { verified: false, locked: true };

  const ok = await verifyPassword(u.hash, pin);
  if (ok) {
    await db.update(users).set({ approverPinFailedCount: 0, approverPinLockedUntil: null }).where(eq(users.id, userId));
    return { verified: true, locked: false };
  }
  // An expired lock starts a FRESH window — otherwise the stale failed count
  // (left at MAX after the previous lockout) would re-lock on the very first
  // wrong attempt, degrading the user to one try per window forever.
  const lockExpired = u.lockedUntil != null && u.lockedUntil <= now;
  const failed = (lockExpired ? 0 : (u.failed ?? 0)) + 1;
  const locked = failed >= MAX_PIN_ATTEMPTS;
  await db.update(users).set({
    approverPinFailedCount: failed,
    approverPinLockedUntil: locked ? new Date(Date.now() + LOCKOUT_MS) : null,
  }).where(eq(users.id, userId));
  return { verified: false, locked };
}
