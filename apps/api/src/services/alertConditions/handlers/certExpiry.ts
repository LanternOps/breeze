/**
 * Evaluates the expiry of the device's AGENT mTLS client certificate
 * (devices.mtls_cert_expires_at) — the credential the agent uses to talk to
 * Breeze. It does NOT inspect certificates installed on or served by the
 * endpoint; every user-facing string says "agent mTLS certificate" so a
 * monitor on this kind is never mistaken for general certificate monitoring.
 */
import type { ConditionHandler } from '../registry';
import type { CertExpiryCondition, ConditionResult } from '../types';
import { getDevice } from '../utils';

export const certExpiryHandler: ConditionHandler = {
  type: 'cert_expiry',

  async evaluate(condition: unknown, deviceId: string): Promise<ConditionResult> {
    const cond = condition as CertExpiryCondition;
    const device = await getDevice(deviceId);

    if (!device) {
      return { passed: false, description: 'Device not found', dataAvailable: false };
    }

    const expiresAt = (device as Record<string, unknown>).mtlsCertExpiresAt as Date | null;
    if (!expiresAt) {
      return { passed: false, description: 'Agent has no mTLS certificate', dataAvailable: false };
    }

    const thresholdDate = new Date(Date.now() + cond.withinDays * 24 * 60 * 60 * 1000);
    const daysUntilExpiry = Math.ceil((expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
    const passed = expiresAt <= thresholdDate;

    return {
      passed,
      description: `Agent mTLS certificate expires within ${cond.withinDays} days (${daysUntilExpiry} days remaining)`,
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
