import { db } from '../../../db';
import { securityPostureSnapshots } from '../../../db/schema';
import { eq, desc } from 'drizzle-orm';
import type { ConditionHandler } from '../registry';
import type { PatchComplianceCondition, ConditionResult } from '../types';
import { compareValue, getOperatorDisplay } from '../utils';

export const patchComplianceHandler: ConditionHandler = {
  type: 'patch_compliance',

  async evaluate(condition: unknown, deviceId: string): Promise<ConditionResult> {
    const cond = condition as PatchComplianceCondition;

    const [latest] = await db
      .select({ patchComplianceScore: securityPostureSnapshots.patchComplianceScore })
      .from(securityPostureSnapshots)
      .where(eq(securityPostureSnapshots.deviceId, deviceId))
      .orderBy(desc(securityPostureSnapshots.capturedAt))
      .limit(1);

    if (!latest) {
      return { passed: false, description: 'No patch compliance data available' };
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
