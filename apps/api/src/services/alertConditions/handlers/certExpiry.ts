import type { ConditionHandler } from '../registry';
import type { CertExpiryCondition, ConditionResult } from '../types';
import { getDevice } from '../utils';

export const certExpiryHandler: ConditionHandler = {
  type: 'cert_expiry',

  async evaluate(condition: unknown, deviceId: string): Promise<ConditionResult> {
    const cond = condition as CertExpiryCondition;
    const device = await getDevice(deviceId);

    if (!device) {
      return { passed: false, description: 'Device not found' };
    }

    const expiresAt = (device as Record<string, unknown>).mtlsCertExpiresAt as Date | null;
    if (!expiresAt) {
      return { passed: false, description: 'No mTLS certificate configured' };
    }

    const thresholdDate = new Date(Date.now() + cond.withinDays * 24 * 60 * 60 * 1000);
    const daysUntilExpiry = Math.ceil((expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
    const passed = expiresAt <= thresholdDate;

    return {
      passed,
      description: `Certificate expires within ${cond.withinDays} days (${daysUntilExpiry} days remaining)`,
      actualValue: daysUntilExpiry,
    };
  },

  validate(condition: unknown, path: string): string[] {
    const errors: string[] = [];
    const c = condition as Record<string, unknown>;

    if (typeof c.withinDays !== 'number' || c.withinDays < 1) {
      errors.push(`${path}.withinDays: Must be a positive number`);
    }

    return errors;
  }
};
