import { describe, expect, it, afterEach, vi } from 'vitest';
import {
  resolveMsKnob,
  resolveBackupBaseLeaseMs,
  resolveBackupRestorePinLingerMs,
  resolveBackupPublishMarginMs,
  resolveBackupOrphanManifestMaxAgeMs,
  BACKUP_BASE_LEASE_MS_DEFAULT,
  HELPER_PUBLISH_MARGIN_MS,
  BACKUP_RESTORE_PIN_LINGER_MS_DEFAULT,
  BACKUP_PUBLISH_MARGIN_MS_DEFAULT,
  BACKUP_ORPHAN_MANIFEST_MAX_AGE_MS_DEFAULT,
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

describe('resolveBackupOrphanManifestMaxAgeMs', () => {
  const ENV = 'BACKUP_GC_ORPHAN_MANIFEST_MAX_AGE_MS';
  afterEach(() => {
    delete process.env[ENV];
  });

  it('defaults to 9 days (journalMaxAge + 48h)', () => {
    expect(resolveBackupOrphanManifestMaxAgeMs()).toBe(BACKUP_ORPHAN_MANIFEST_MAX_AGE_MS_DEFAULT);
    expect(BACKUP_ORPHAN_MANIFEST_MAX_AGE_MS_DEFAULT).toBe(9 * 24 * 60 * 60 * 1000);
  });

  it('honors a positive override outside production', () => {
    process.env[ENV] = '1234';
    expect(resolveBackupOrphanManifestMaxAgeMs()).toBe(1234);
  });

  it('floors an override at/below the agent journal max age in production', () => {
    process.env.NODE_ENV = 'production';
    process.env[ENV] = String(7 * 24 * 60 * 60 * 1000); // exactly journalMaxAge
    expect(resolveBackupOrphanManifestMaxAgeMs()).toBeGreaterThan(7 * 24 * 60 * 60 * 1000);
  });
});

describe('BACKUP_BASE_LEASE_MS vs the helper publish margin', () => {
  afterEach(() => {
    delete process.env.BACKUP_BASE_LEASE_MS;
  });

  // The helper refuses to publish once now + its built-in 1 h margin passes the lease
  // (agent/internal/backup/snapshot.go publishMargin). A lease <= 1 h therefore fails EVERY
  // backup at the manifest upload — proven in the D18 W04 lab run (#5453).
  it('floors a production lease strictly above the helper publish margin', () => {
    process.env.NODE_ENV = 'production';
    process.env.BACKUP_BASE_LEASE_MS = String(60 * 60 * 1000);
    expect(resolveBackupBaseLeaseMs()).toBeGreaterThan(HELPER_PUBLISH_MARGIN_MS);
    expect(resolveBackupBaseLeaseMs()).toBe(2 * 60 * 60 * 1000);
  });

  it('warns outside production when the lease leaves the helper no publish window', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.BACKUP_BASE_LEASE_MS = '60000';
    expect(resolveBackupBaseLeaseMs()).toBe(60000);
    expect(warn.mock.calls.flat().join(' ')).toMatch(/every backup will fail to publish/);
    warn.mockRestore();
  });
});

