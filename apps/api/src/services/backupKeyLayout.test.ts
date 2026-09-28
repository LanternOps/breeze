import { describe, expect, it } from 'vitest';
import { BACKUP_KEY_LAYOUTS, isSupportedKeyLayout } from './backupKeyLayout';

describe('backup snapshot key layout', () => {
  it('accepts only the flat layout', () => {
    expect(BACKUP_KEY_LAYOUTS).toEqual(['legacy_flat']);
    expect(isSupportedKeyLayout('legacy_flat')).toBe(true);
  });

  it.each(['device_scoped', '', null, undefined, 'LEGACY_FLAT', ' legacy_flat', 1])('refuses %p', (value) => {
    expect(isSupportedKeyLayout(value)).toBe(false);
  });
});
