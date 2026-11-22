import { describe, expect, it } from 'vitest';
import { DR_STEP_TYPES, isDrStepType, normalizeDrStepType } from './drStepTypes';

describe('normalizeDrStepType', () => {
  it.each(DR_STEP_TYPES)('maps every case spelling of %s to the canonical value', (type) => {
    for (const spelling of [type, type.toUpperCase(), type.toLowerCase(), ` ${type} `]) {
      expect(normalizeDrStepType(spelling)).toBe(type);
    }
  });

  it('rejects unknown and non-string values', () => {
    for (const value of ['', 'vm_restore', 'file_delete', null, undefined, 4, {}]) {
      expect(normalizeDrStepType(value)).toBeNull();
    }
  });

  it('isDrStepType only accepts the canonical spelling', () => {
    expect(isDrStepType('vm_restore_from_backup')).toBe(true);
    expect(isDrStepType('VM_RESTORE_FROM_BACKUP')).toBe(false);
  });
});
