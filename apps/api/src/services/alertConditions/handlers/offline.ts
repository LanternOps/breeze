import type { ConditionHandler } from '../registry';
import type { OfflineCondition, ConditionResult } from '../types';
import { getDevice } from '../utils';

export const offlineHandler: ConditionHandler = {
  type: 'offline',

  async evaluate(condition: unknown, deviceId: string): Promise<ConditionResult> {
    const cond = condition as OfflineCondition;
    const device = await getDevice(deviceId);

    if (!device) {
      return { passed: false, description: 'Device not found' };
    }

    const durationMinutes = cond.durationMinutes || 5;
    const offlineThreshold = new Date(Date.now() - durationMinutes * 60 * 1000);

    const isOffline = device.status === 'offline' ||
      (device.lastSeenAt !== null && device.lastSeenAt < offlineThreshold);

    return {
      passed: isOffline,
      description: `Device offline for ${durationMinutes}min`
    };
  },

  validate(condition: unknown, path: string): string[] {
    const errors: string[] = [];
    const c = condition as Record<string, unknown>;

    if (c.durationMinutes !== undefined && typeof c.durationMinutes !== 'number') {
      errors.push(`${path}.durationMinutes: Must be a number`);
    }

    return errors;
  }
};
