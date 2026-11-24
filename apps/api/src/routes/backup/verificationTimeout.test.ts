import { describe, expect, it } from 'vitest';
import { getCommandTimeoutMs, getCommandUndeliveredTimeoutMs } from '../../services/commandTimeouts';
import { CommandTypes } from '../../services/commandTypes';
import {
  LEGACY_VERIFICATION_TIMEOUT_REASON,
  VERIFICATION_TIMEOUT_GRACE_MS,
  VERIFICATION_TIMEOUT_REASON_CODE,
  isVerificationTimeoutDetails,
  shortestVerificationTimeoutMs,
  verificationBudgetMs,
  verificationCommandType,
  verificationDeadline,
  verificationStuckAfterMs,
  verificationTimeoutDetails,
  verificationTimeoutReason,
} from './verificationTimeout';

const MIN = 60_000;
const HOUR = 60 * MIN;
const STARTED = new Date('2026-11-19T10:00:00.000Z');

describe('verification timeout budget (#11813)', () => {
  it('maps each verification type to the command it dispatches', () => {
    expect(verificationCommandType('integrity')).toBe(CommandTypes.BACKUP_VERIFY);
    expect(verificationCommandType('test_restore')).toBe(CommandTypes.BACKUP_TEST_RESTORE);
  });

  it.each(['integrity', 'test_restore'] as const)('reads a %s budget from details.timeBudgetSeconds through the command clamp', (type) => {
    expect(verificationBudgetMs(type, { timeBudgetSeconds: 395 * 60 })).toBe(395 * MIN);
    expect(verificationBudgetMs(type, { timeBudgetSeconds: 395 * 60 })).toBe(
      getCommandTimeoutMs(verificationCommandType(type), { timeBudgetSeconds: 395 * 60 }),
    );
    expect(verificationBudgetMs(type, { timeBudgetSeconds: 60 })).toBe(2 * HOUR);
    expect(verificationBudgetMs(type, { timeBudgetSeconds: 99 * 3600 })).toBe(12 * HOUR);
    // Rows created before the field existed, and malformed details: the base.
    for (const details of [{}, null, undefined, [], 'x', { timeBudgetSeconds: '36000' }]) {
      expect(verificationBudgetMs(type, details)).toBe(2 * HOUR);
    }
  });

  // getCommandTimeoutMs falls back to 30 minutes for an unclassified type, so
  // pin the floor: dropping either command's budget must fail here rather
  // than quietly bring the 30-minute cut-off back.
  it.each(['integrity', 'test_restore'] as const)('never cuts a %s verification off before 2h + grace', (type) => {
    expect(verificationBudgetMs(type, {})).toBeGreaterThanOrEqual(2 * HOUR);
    expect(shortestVerificationTimeoutMs()).toBe(2 * HOUR + VERIFICATION_TIMEOUT_GRACE_MS);
  });
});

describe('verificationDeadline', () => {
  // The production failure: the command sat ~20 min undelivered while the
  // snapshot's file index hydrated, and the old clock ran from started_at.
  it('runs from the command claim (executed_at) plus the scaled budget plus grace', () => {
    const executedAt = new Date(STARTED.getTime() + 20 * MIN);
    const result = verificationDeadline({
      verificationType: 'integrity',
      startedAt: STARTED.toISOString(),
      details: { commandId: 'c', timeBudgetSeconds: 395 * 60 },
      command: { executedAt },
    });
    expect(result.budgetMs).toBe(395 * MIN);
    expect(result.deadlineMs).toBe(executedAt.getTime() + 395 * MIN + VERIFICATION_TIMEOUT_GRACE_MS);
  });

  it('uses the 2h budget for a delivered command whose row carries none', () => {
    const executedAt = new Date(STARTED.getTime() + 20 * MIN);
    const result = verificationDeadline({
      verificationType: 'test_restore',
      startedAt: STARTED,
      details: { commandId: 'c' },
      command: { executedAt },
    });
    expect(result.deadlineMs).toBe(executedAt.getTime() + 2 * HOUR + VERIFICATION_TIMEOUT_GRACE_MS);
  });

  // An undelivered command cannot be claimed after its 2h undelivered limit
  // (the reaper expires it), so its verification settles on that clock, not
  // on a 12h execution budget it never started.
  it.each([
    ['never delivered', { executedAt: null }],
    ['missing', null],
  ] as const)('a %s command settles at started_at + the undelivered limit + grace', (_label, command) => {
    const result = verificationDeadline({
      verificationType: 'integrity',
      startedAt: STARTED,
      details: { timeBudgetSeconds: 12 * 3600 },
      command,
    });
    expect(result.budgetMs).toBe(getCommandUndeliveredTimeoutMs(CommandTypes.BACKUP_VERIFY));
    expect(result.deadlineMs).toBe(STARTED.getTime() + 2 * HOUR + VERIFICATION_TIMEOUT_GRACE_MS);
  });

  it('is never earlier than the SQL pre-filter cut-off (a valid superset)', () => {
    for (const command of [null, { executedAt: null }, { executedAt: STARTED }, { executedAt: new Date(STARTED.getTime() + HOUR) }]) {
      for (const details of [{}, { timeBudgetSeconds: 60 }, { timeBudgetSeconds: 12 * 3600 }]) {
        const { deadlineMs } = verificationDeadline({ verificationType: 'integrity', startedAt: STARTED, details, command });
        expect(deadlineMs).toBeGreaterThanOrEqual(STARTED.getTime() + shortestVerificationTimeoutMs());
      }
    }
  });
});

describe('verificationStuckAfterMs (readiness upper bound)', () => {
  it('is the undelivered limit + budget + grace, so a healthy run is never flagged', () => {
    expect(verificationStuckAfterMs('integrity', {})).toBe(2 * HOUR + 2 * HOUR + VERIFICATION_TIMEOUT_GRACE_MS);
    expect(verificationStuckAfterMs('test_restore', { timeBudgetSeconds: 395 * 60 })).toBe(
      2 * HOUR + 395 * MIN + VERIFICATION_TIMEOUT_GRACE_MS,
    );
  });

  it('is never earlier than the timeout job deadline for a command claimed inside its undelivered limit', () => {
    const details = { timeBudgetSeconds: 395 * 60 };
    const latestClaim = new Date(STARTED.getTime() + 2 * HOUR);
    const { deadlineMs } = verificationDeadline({ verificationType: 'integrity', startedAt: STARTED, details, command: { executedAt: latestClaim } });
    expect(STARTED.getTime() + verificationStuckAfterMs('integrity', details)).toBeGreaterThanOrEqual(deadlineMs);
  });
});

describe('verification timeout reason', () => {
  it('states the actual budget + grace in minutes', () => {
    expect(verificationTimeoutReason(2 * HOUR)).toBe('Verification timed out after 125 minutes');
    expect(verificationTimeoutReason(395 * MIN)).toBe('Verification timed out after 400 minutes');
    expect(verificationTimeoutReason(2 * HOUR)).not.toBe(LEGACY_VERIFICATION_TIMEOUT_REASON);
  });

  it('builds details carrying the stable reason code', () => {
    expect(verificationTimeoutDetails(395 * MIN)).toEqual({
      reason: verificationTimeoutReason(395 * MIN),
      reasonCode: VERIFICATION_TIMEOUT_REASON_CODE,
    });
  });
});

describe('isVerificationTimeoutDetails', () => {
  it('recognises a row written with the reason code, whatever its text says', () => {
    expect(isVerificationTimeoutDetails({ reasonCode: VERIFICATION_TIMEOUT_REASON_CODE, reason: 'anything' })).toBe(true);
    expect(isVerificationTimeoutDetails(verificationTimeoutDetails(2 * HOUR))).toBe(true);
  });

  it('still recognises rows written before the reason code existed (legacy text)', () => {
    expect(LEGACY_VERIFICATION_TIMEOUT_REASON).toBe('Verification timed out after 30 minutes');
    expect(isVerificationTimeoutDetails({ reason: LEGACY_VERIFICATION_TIMEOUT_REASON, commandId: 'c1' })).toBe(true);
  });

  it('rejects other failure reasons and malformed details', () => {
    expect(isVerificationTimeoutDetails({ reason: 'Agent unreachable' })).toBe(false);
    expect(isVerificationTimeoutDetails({ reasonCode: 'something_else' })).toBe(false);
    expect(isVerificationTimeoutDetails(null)).toBe(false);
    expect(isVerificationTimeoutDetails(undefined)).toBe(false);
    expect(isVerificationTimeoutDetails(['verification_timeout'])).toBe(false);
  });
});
