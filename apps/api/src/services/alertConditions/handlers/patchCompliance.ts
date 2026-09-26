import { db } from '../../../db';
import { securityPostureSnapshots } from '../../../db/schema';
import { eq, desc } from 'drizzle-orm';
import type { ConditionHandler } from '../registry';
import type { PatchComplianceCondition, ConditionResult } from '../types';
import { compareValue, getOperatorDisplay } from '../utils';

/**
 * Posture snapshots are written hourly by the security-posture-scan job
 * (jobs/scheduleRegistry.ts, '7 * * * *'). A snapshot older than this is not
 * current evidence — the scan stopped (worker outage) or the device dropped out
 * of it — so it is reported as "no data" instead of re-alerting (or holding an
 * alert open) on a score that may be days stale. 24h tolerates a long run of
 * missed scans without flapping every patch monitor to no-data.
 */
export const PATCH_COMPLIANCE_MAX_SNAPSHOT_AGE_MS = 24 * 60 * 60 * 1000;

function hasPatchDataGap(factorDetails: unknown): boolean {
  if (typeof factorDetails !== 'object' || factorDetails === null) return false;
  const patch = (factorDetails as Record<string, unknown>).patch_compliance;
  if (typeof patch !== 'object' || patch === null) return false;
  const gap = (patch as Record<string, unknown>).dataGap;
  return typeof gap === 'string' && gap.length > 0;
}

export const patchComplianceHandler: ConditionHandler = {
  type: 'patch_compliance',

  async evaluate(condition: unknown, deviceId: string): Promise<ConditionResult> {
    const cond = condition as PatchComplianceCondition;

    const [latest] = await db
      .select({
        patchComplianceScore: securityPostureSnapshots.patchComplianceScore,
        capturedAt: securityPostureSnapshots.capturedAt,
        factorDetails: securityPostureSnapshots.factorDetails,
      })
      .from(securityPostureSnapshots)
      .where(eq(securityPostureSnapshots.deviceId, deviceId))
      .orderBy(desc(securityPostureSnapshots.capturedAt))
      .limit(1);

    if (!latest) {
      return { passed: false, description: 'No patch compliance data available', dataAvailable: false };
    }

    const ageMs = Date.now() - new Date(latest.capturedAt).getTime();
    if (!(ageMs <= PATCH_COMPLIANCE_MAX_SNAPSHOT_AGE_MS)) {
      const ageHours = Math.floor(ageMs / 3_600_000);
      return {
        passed: false,
        description: `Patch compliance data is stale (last scored ${ageHours}h ago)`,
        dataAvailable: false,
      };
    }

    // scorePatchCompliance() (services/securityPosture.ts) emits a placeholder
    // score of 100 with a dataGap when the device has no critical/important
    // patch telemetry at all. That is not a measurement; don't evaluate it.
    if (hasPatchDataGap(latest.factorDetails)) {
      return {
        passed: false,
        description: 'No patch telemetry for this device',
        dataAvailable: false,
      };
    }

    const score = latest.patchComplianceScore;
    const passed = compareValue(score, cond.operator, cond.value);
    const operatorDisplay = getOperatorDisplay(cond.operator);

    return {
      passed,
      description: `Patch compliance score ${operatorDisplay} ${cond.value}% (actual: ${score}%)`,
      actualValue: score,
    };
  },

  validate(condition: unknown, path: string): string[] {
    const errors: string[] = [];
    const c = condition as Record<string, unknown>;

    if (!['gt', 'gte', 'lt', 'lte', 'eq', 'neq'].includes(c.operator as string)) {
      errors.push(`${path}.operator: Invalid operator`);
    }
    if (typeof c.value !== 'number' || c.value < 0 || c.value > 100) {
      errors.push(`${path}.value: Must be a number between 0 and 100`);
    }

    return errors;
  }
};
