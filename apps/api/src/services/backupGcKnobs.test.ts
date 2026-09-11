import { describe, expect, it, afterEach } from 'vitest';
import {
  resolveMsKnob,
  resolveBackupBaseLeaseMs,
  resolveBackupRestorePinLingerMs,
  resolveBackupPublishMarginMs,
  BACKUP_BASE_LEASE_MS_DEFAULT,
  BACKUP_RESTORE_PIN_LINGER_MS_DEFAULT,
  BACKUP_PUBLISH_MARGIN_MS_DEFAULT,
} from './backupGcKnobs';

const ENV_VAR = 'BACKUP_TEST_KNOB_MS';

afterEach(() => {
  delete process.env[ENV_VAR];
  delete process.env.NODE_ENV;
});

describe('resolveMsKnob', () => {
  it('returns the default when unset', () => {
    expect(resolveMsKnob(ENV_VAR, 1000, 100)).toBe(1000);
  });

  it('returns the override when set to a valid positive number above the floor', () => {
    process.env[ENV_VAR] = '5000';
    expect(resolveMsKnob(ENV_VAR, 1000, 100)).toBe(5000);
  });

  it('ignores a non-numeric override and falls back to default', () => {
    process.env[ENV_VAR] = 'not-a-number';
    expect(resolveMsKnob(ENV_VAR, 1000, 100)).toBe(1000);
  });

  it('enforces the production floor', () => {
    process.env.NODE_ENV = 'production';
    process.env[ENV_VAR] = '10';
    expect(resolveMsKnob(ENV_VAR, 1000, 100)).toBe(100);
  });

  it('is resolved fresh on every call — not cached at module load', () => {
    expect(resolveMsKnob(ENV_VAR, 1000, 100)).toBe(1000);
    process.env[ENV_VAR] = '2000';
    expect(resolveMsKnob(ENV_VAR, 1000, 100)).toBe(2000);
  });
});

describe('per-knob defaults', () => {
  it('BACKUP_BASE_LEASE_MS / BACKUP_RESTORE_PIN_LINGER_MS default to 7 days, BACKUP_PUBLISH_MARGIN_MS to 1 hour', () => {
    expect(resolveBackupBaseLeaseMs()).toBe(BACKUP_BASE_LEASE_MS_DEFAULT);
    expect(resolveBackupRestorePinLingerMs()).toBe(BACKUP_RESTORE_PIN_LINGER_MS_DEFAULT);
    expect(resolveBackupPublishMarginMs()).toBe(BACKUP_PUBLISH_MARGIN_MS_DEFAULT);
    expect(BACKUP_BASE_LEASE_MS_DEFAULT).toBe(7 * 24 * 60 * 60 * 1000);
    expect(BACKUP_PUBLISH_MARGIN_MS_DEFAULT).toBe(60 * 60 * 1000);
  });
});
