/**
 * Unit tests for the lifecycle-internal `organizations.settings` key strip
 * (org-lifecycle Wave 4, review r3).
 *
 * `settings` is a client-writable `z.any()` blob and the org PATCH replaces the
 * column wholesale, so without this every engine-owned key is attacker-writable
 * through an ordinary API call — including the purge-retry counter a fleet-wide
 * sweep casts to int, and the prior-status keys that decide what a restore or a
 * merge unfence reactivates a tenant AS.
 */
import { describe, expect, it } from 'vitest';
import { ARCHIVE_PRIOR_STATUS_KEY } from './orgArchive';
import { MERGE_PRIOR_STATUS_KEY } from './orgMerge';
import {
  ARCHIVE_PURGE_WARN_14_SENT_AT_KEY,
  ARCHIVE_PURGE_WARN_1_SENT_AT_KEY,
  ARCHIVE_PURGING_RECOVERY_ATTEMPTS_KEY,
} from './tenantOffboarding';
import {
  ORG_LIFECYCLE_INTERNAL_SETTINGS_KEYS,
  stripOrgLifecycleInternalSettings,
} from './orgSettingsInternalKeys';

describe('ORG_LIFECYCLE_INTERNAL_SETTINGS_KEYS', () => {
  it('covers every key the lifecycle engine stores in organizations.settings', () => {
    // Imported from their owning modules, never re-declared here: a rename
    // reddens this list instead of silently un-protecting a key.
    expect([...ORG_LIFECYCLE_INTERNAL_SETTINGS_KEYS].sort()).toEqual(
      [
        ARCHIVE_PRIOR_STATUS_KEY,
        ARCHIVE_PURGE_WARN_14_SENT_AT_KEY,
        ARCHIVE_PURGE_WARN_1_SENT_AT_KEY,
        ARCHIVE_PURGING_RECOVERY_ATTEMPTS_KEY,
        MERGE_PRIOR_STATUS_KEY,
      ].sort(),
    );
  });
});

describe('stripOrgLifecycleInternalSettings', () => {
  it('removes every engine-owned key and keeps everything else', () => {
    const result = stripOrgLifecycleInternalSettings({
      [ARCHIVE_PURGING_RECOVERY_ATTEMPTS_KEY]: -9999,
      [ARCHIVE_PRIOR_STATUS_KEY]: 'active',
      [MERGE_PRIOR_STATUS_KEY]: 'active',
      [ARCHIVE_PURGE_WARN_14_SENT_AT_KEY]: '2026-01-01T00:00:00.000Z',
      [ARCHIVE_PURGE_WARN_1_SENT_AT_KEY]: '2026-01-01T00:00:00.000Z',
      branding: { primaryColor: '#123456' },
      defaults: { maintenanceWindow: 'sat:02:00-04:00' },
    });

    expect(result).toEqual({
      branding: { primaryColor: '#123456' },
      defaults: { maintenanceWindow: 'sat:02:00-04:00' },
    });
  });

  it.each([
    ['a preseeded negative that would extend the retry ceiling', -1],
    ['a preseeded value at the ceiling that would exhaust recovery instantly', 5],
    ['a fractional value that a bare ::int cast would reject', 0.5],
    ['a non-number that would break a typed read', 'oops'],
  ])('strips the recovery counter for %s', (_label, value) => {
    const result = stripOrgLifecycleInternalSettings({
      [ARCHIVE_PURGING_RECOVERY_ATTEMPTS_KEY]: value,
    }) as Record<string, unknown>;

    expect(ARCHIVE_PURGING_RECOVERY_ATTEMPTS_KEY in result).toBe(false);
  });

  it('does not mutate the caller\'s object', () => {
    const input = { [ARCHIVE_PRIOR_STATUS_KEY]: 'active', keep: 1 };
    stripOrgLifecycleInternalSettings(input);
    expect(input[ARCHIVE_PRIOR_STATUS_KEY]).toBe('active');
  });

  it('returns the SAME reference when there is nothing to strip (no needless copy)', () => {
    const input = { branding: {} };
    expect(stripOrgLifecycleInternalSettings(input)).toBe(input);
  });

  it.each([[null], [undefined], ['a string'], [42], [['array']]])(
    'passes a non-object payload through untouched: %s',
    (value) => {
      expect(stripOrgLifecycleInternalSettings(value)).toEqual(value);
    },
  );
});
