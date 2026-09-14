/**
 * Antivirus condition handler (#5291 W04).
 *
 * `securityStatus.realTimeProtection` and `.definitionsDate` are nullable —
 * the agent may simply never have reported a security posture for a device.
 * A `null` here is "no data", NOT "protection is off" / "definitions are
 * stale". Treating a nullable boolean/timestamp with a loose falsy check
 * (`!realTimeProtection`, `!definitionsDate`) conflates "unknown" with "bad"
 * and fires false alerts on devices we've simply never heard from. Every
 * check below evaluates the three states explicitly: known-bad (breach),
 * known-good (no breach), and unknown (no breach, with a "no data"
 * description so the caller can tell the two false cases apart).
 */
import { eq } from 'drizzle-orm';
import { db } from '../../../db';
import { securityStatus } from '../../../db/schema';
import type { ConditionHandler } from '../registry';
import type { ConditionResult } from '../types';

export interface AntivirusCondition {
  type: 'antivirus';
  check: 'not_protected' | 'definitions_stale' | 'realtime_disabled' | 'threats_present';
  staleAfterDays?: number;
  minThreatCount?: number;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export const antivirusHandler: ConditionHandler = {
  type: 'antivirus',

  async evaluate(condition: unknown, deviceId: string): Promise<ConditionResult> {
    const cond = condition as AntivirusCondition;

    const [status] = await db
      .select({
        realTimeProtection: securityStatus.realTimeProtection,
        definitionsDate: securityStatus.definitionsDate,
        threatCount: securityStatus.threatCount,
      })
      .from(securityStatus)
      .where(eq(securityStatus.deviceId, deviceId))
      .limit(1);

    if (!status) {
      return { passed: false, description: 'No antivirus status reported' };
    }

    switch (cond.check) {
      case 'realtime_disabled': {
        if (status.realTimeProtection === null) {
          return { passed: false, description: 'Real-time protection status unknown (no data reported)' };
        }
        const passed = status.realTimeProtection === false;
        return {
          passed,
          description: passed ? 'Real-time protection is disabled' : 'Real-time protection is enabled',
        };
      }

      case 'not_protected': {
        if (status.realTimeProtection === null) {
          return { passed: false, description: 'Protection status unknown (no data reported)' };
        }
        const passed = status.realTimeProtection === false;
        return {
          passed,
          description: passed ? 'Device is not protected' : 'Device is protected',
        };
      }

      case 'definitions_stale': {
        const staleAfterDays = cond.staleAfterDays ?? 1;
        if (!status.definitionsDate) {
          return { passed: false, description: 'Definitions date unknown (no data reported)' };
        }
        const ageDays = Math.floor((Date.now() - status.definitionsDate.getTime()) / MS_PER_DAY);
        const passed = ageDays > staleAfterDays;
        return {
          passed,
          description: passed
            ? `Antivirus definitions are ${ageDays} days old (stale after ${staleAfterDays})`
            : `Antivirus definitions are ${ageDays} days old`,
          actualValue: ageDays,
        };
      }

      case 'threats_present': {
        const minThreatCount = cond.minThreatCount ?? 1;
        const threatCount = status.threatCount;
        const passed = threatCount >= minThreatCount;
        return {
          passed,
          description: passed
            ? `${threatCount} threat(s) detected (threshold: ${minThreatCount})`
            : `${threatCount} threat(s) detected`,
          actualValue: threatCount,
        };
      }

      default:
        return { passed: false, description: `Unknown antivirus check: ${String((cond as { check?: unknown }).check)}` };
    }
  },

  validate(condition: unknown, path: string): string[] {
    const errors: string[] = [];
    const c = condition as Record<string, unknown>;

    if (!['not_protected', 'definitions_stale', 'realtime_disabled', 'threats_present'].includes(c.check as string)) {
      errors.push(`${path}.check: Invalid check`);
    }
    if (c.check === 'definitions_stale' && (typeof c.staleAfterDays !== 'number' || c.staleAfterDays <= 0)) {
      errors.push(`${path}.staleAfterDays: Must be a positive number`);
    }

    return errors;
  }
};
