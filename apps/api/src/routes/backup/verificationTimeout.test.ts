import { describe, expect, it } from 'vitest';
import { getCommandTimeoutMs } from '../../services/commandTimeouts';
import { CommandTypes } from '../../services/commandTypes';
import {
  LEGACY_VERIFICATION_TIMEOUT_REASON,
  VERIFICATION_TIMEOUT_GRACE_MS,
  VERIFICATION_TIMEOUT_REASON_CODE,
  isVerificationTimeoutDetails,
  shortestVerificationTimeoutMs,
  verificationCommandType,
  verificationTimeoutDetails,
  verificationTimeoutMs,
  verificationTimeoutReason,
} from './verificationTimeout';

describe('verification timeout budget (#11813)', () => {
  it('maps each verification type to the command it dispatches', () => {
    expect(verificationCommandType('integrity')).toBe(CommandTypes.BACKUP_VERIFY);
    expect(verificationCommandType('test_restore')).toBe(CommandTypes.BACKUP_TEST_RESTORE);
  });

  it('derives the timeout from the command budget plus a grace, never shorter than the budget', () => {
    for (const type of ['integrity', 'test_restore'] as const) {
      const budget = getCommandTimeoutMs(verificationCommandType(type));
      expect(verificationTimeoutMs(type)).toBe(budget + VERIFICATION_TIMEOUT_GRACE_MS);
      expect(verificationTimeoutMs(type)).toBeGreaterThan(budget);
    }
  });

  it('no longer cuts an integrity check off at 30 minutes', () => {
    // The reported failure: a ~59 GB snapshot still verifying at 35 minutes.
    expect(verificationTimeoutMs('integrity')).toBeGreaterThan(35 * 60 * 1000);
    expect(verificationTimeoutMs('integrity')).toBeGreaterThanOrEqual(2 * 60 * 60 * 1000);
  });

  it('exposes the shortest per-type timeout for the SQL pre-filter', () => {
    expect(shortestVerificationTimeoutMs()).toBe(
      Math.min(verificationTimeoutMs('integrity'), verificationTimeoutMs('test_restore')),
    );
  });

  it('states the real duration in the human-readable reason', () => {
    const minutes = verificationTimeoutMs('integrity') / 60_000;
    expect(verificationTimeoutReason('integrity')).toBe(`Verification timed out after ${minutes} minutes`);
    expect(verificationTimeoutReason('integrity')).not.toBe(LEGACY_VERIFICATION_TIMEOUT_REASON);
  });

  it('builds details carrying the stable reason code', () => {
    expect(verificationTimeoutDetails('integrity')).toEqual({
      reason: verificationTimeoutReason('integrity'),
      reasonCode: VERIFICATION_TIMEOUT_REASON_CODE,
    });
  });
});

describe('isVerificationTimeoutDetails', () => {
  it('recognises a row written with the reason code, whatever its text says', () => {
    expect(isVerificationTimeoutDetails({ reasonCode: VERIFICATION_TIMEOUT_REASON_CODE, reason: 'anything' })).toBe(true);
    expect(isVerificationTimeoutDetails(verificationTimeoutDetails('test_restore'))).toBe(true);
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
