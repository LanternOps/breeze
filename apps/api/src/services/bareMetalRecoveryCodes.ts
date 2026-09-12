// Bare-metal recovery W04a: one-time recovery codes, nonce helpers, and the
// server-enforced forward-only recovery status state machine. See spec
// docs/superpowers/specs/backup/2026-09-10-bare-metal-boot-media-recovery-design.md
// Sec8.1/Sec9 and plan docs/superpowers/plans/backup/2026-09-10-bare-metal-w04a-recovery-codes-state-machine-checkin.md.
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { BARE_METAL_RECOVERY_STATUSES, BARE_METAL_RECOVERY_TERMINAL, type BareMetalRecoveryStatus } from '../db/schema/bareMetalRecoveries';

export type { BareMetalRecoveryStatus };
// Unambiguous alphabet: no 0/O or 1/I, so a code read off a screen or spoken
// over the phone can't be misheard/mistyped into a different valid code.
export const RECOVERY_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const RECOVERY_CODE_LENGTH = 9;
export const RECOVERY_CODE_TTL_MS = 15 * 60 * 1000;
export const RECOVERY_NONCE_BYTES = 32;
export const RECOVERY_OVERDUE_MS = 30 * 60 * 1000;

export function generateRecoveryCode(): string {
  let out = '';
  for (let i = 0; i < RECOVERY_CODE_LENGTH; i++) {
    out += RECOVERY_CODE_ALPHABET[randomInt(RECOVERY_CODE_ALPHABET.length)];
  }
  return out;
}

export function formatRecoveryCode(code: string): string {
  return `${code.slice(0, 3)}-${code.slice(3, 6)}-${code.slice(6, 9)}`;
}

export function normalizeRecoveryCode(input: string): string | null {
  const s = input.toUpperCase().replace(/[\s-]/g, '');
  if (s.length !== RECOVERY_CODE_LENGTH) return null;
  for (const ch of s) {
    if (!RECOVERY_CODE_ALPHABET.includes(ch)) return null;
  }
  return s;
}

export function hashRecoveryCode(normalized: string): string {
  return createHash('sha256').update(normalized).digest('hex');
}

export function generateRecoveryNonce(): string {
  return randomBytes(RECOVERY_NONCE_BYTES).toString('hex');
}

export function hashRecoveryNonce(nonce: string): string {
  return createHash('sha256').update(nonce).digest('hex');
}

// Forward path only (no "media_booted -> completed" jump list needed — the
// numeric index comparison below already allows any forward skip, e.g. a
// helper that lost network before posting `planned` can still post
// `restoring` directly).
export const RECOVERY_STATUS_ORDER: readonly BareMetalRecoveryStatus[] = [
  'created', 'media_booted', 'planned', 'restoring', 'validated', 'rebooted', 'checked_in',
];

export function canTransition(from: BareMetalRecoveryStatus, to: BareMetalRecoveryStatus): boolean {
  if (BARE_METAL_RECOVERY_TERMINAL.has(from)) return false;
  if (to === 'failed' || to === 'refused') return true;
  if (to === 'completed') {
    // A `validated` post on an identity:'new' recovery is stored as
    // `completed` directly (see canTransition callers in bmrRecoveries.ts) —
    // there is no heartbeat check-in to wait for when the restored machine
    // has a brand-new identity. Treat 'completed' as reachable from anywhere
    // up to and including 'validated' in the forward order, not only from
    // 'validated' itself.
    const validatedIdx = RECOVERY_STATUS_ORDER.indexOf('validated');
    const fromIdx = RECOVERY_STATUS_ORDER.indexOf(from);
    return fromIdx >= 0 && fromIdx <= validatedIdx;
  }
  const a = RECOVERY_STATUS_ORDER.indexOf(from);
  const b = RECOVERY_STATUS_ORDER.indexOf(to);
  return a >= 0 && b > a;
}

export function isOverdue(status: BareMetalRecoveryStatus, rebootedAt: Date | null, now: Date = new Date()): boolean {
  return status === 'rebooted' && rebootedAt !== null && now.getTime() - rebootedAt.getTime() > RECOVERY_OVERDUE_MS;
}

// Referenced for completeness / re-export convenience; not used directly in
// this module beyond BARE_METAL_RECOVERY_TERMINAL above.
void BARE_METAL_RECOVERY_STATUSES;
