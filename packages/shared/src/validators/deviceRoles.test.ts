import { describe, it, expect } from 'vitest';
import { BILLABLE_DEVICE_ROLES, DEVICE_ROLES } from './deviceRoles';

describe('device role tuples (#3205)', () => {
  it('DEVICE_ROLES is BILLABLE_DEVICE_ROLES plus a trailing unknown', () => {
    expect(DEVICE_ROLES).toEqual([...BILLABLE_DEVICE_ROLES, 'unknown']);
    expect(BILLABLE_DEVICE_ROLES).not.toContain('unknown');
    expect(BILLABLE_DEVICE_ROLES).toHaveLength(11);
  });

  it('is still exported from the validators barrel', async () => {
    const barrel = await import('./index');
    expect(barrel.DEVICE_ROLES).toBe(DEVICE_ROLES);
    expect(barrel.BILLABLE_DEVICE_ROLES).toBe(BILLABLE_DEVICE_ROLES);
  });
});
