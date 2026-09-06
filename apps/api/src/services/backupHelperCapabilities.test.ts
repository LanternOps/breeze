import { describe, expect, it } from 'vitest';
import { BACKUP_QUEUE_MIN_HELPER_VERSION, backupHelperSupportsQueue } from './backupHelperCapabilities';

describe('backupHelperSupportsQueue', () => {
  it('accepts the introducing release and anything newer', () => {
    expect(backupHelperSupportsQueue(BACKUP_QUEUE_MIN_HELPER_VERSION)).toBe(true);
    expect(backupHelperSupportsQueue('v0.110.0')).toBe(true);
    expect(backupHelperSupportsQueue('0.110.1')).toBe(true);
    expect(backupHelperSupportsQueue('0.111.0')).toBe(true);
    expect(backupHelperSupportsQueue('1.0.0')).toBe(true);
  });

  it('rejects older helpers, pre-releases of the introducing version, and unknowns', () => {
    expect(backupHelperSupportsQueue('0.109.0')).toBe(false);
    expect(backupHelperSupportsQueue('0.109.99')).toBe(false);
    expect(backupHelperSupportsQueue('0.110.0-rc.1')).toBe(false);
    expect(backupHelperSupportsQueue(null)).toBe(false);
    expect(backupHelperSupportsQueue(undefined)).toBe(false);
    expect(backupHelperSupportsQueue('')).toBe(false);
    expect(backupHelperSupportsQueue('dev')).toBe(false);
    expect(backupHelperSupportsQueue('unknown')).toBe(false);
  });
});
