import { describe, expect, it } from 'vitest';
import type { DeviceStatus } from '../types';
import { deviceQuerySchema } from '../validators';
import { DEVICE_STATUSES } from './index';

describe('DEVICE_STATUSES', () => {
  it('matches every device status accepted by the shared type and query validator', () => {
    const allDeviceStatuses = [
      'online',
      'offline',
      'maintenance',
      'decommissioned',
      'quarantined',
      'updating',
      'pending',
    ] as const satisfies readonly DeviceStatus[];

    expect(DEVICE_STATUSES).toEqual(allDeviceStatuses);
    for (const status of allDeviceStatuses) {
      expect(deviceQuerySchema.safeParse({ status }).success).toBe(true);
    }
    expect(deviceQuerySchema.safeParse({ status: 'invalid' }).success).toBe(false);
  });
});
