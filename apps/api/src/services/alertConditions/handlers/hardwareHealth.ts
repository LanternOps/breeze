import { and, eq, inArray } from 'drizzle-orm';
import { HARDWARE_HEALTH_RANK, monitorConditionSchemas } from '@breeze/shared';
import { db } from '../../../db';
import { deviceHardwareComponents, deviceHardwareHealth } from '../../../db/schema';
import { isComponentFresh } from '../../hardwareHealth/freshness';
import type { ConditionHandler } from '../registry';
import type { SubjectEvidence, SubjectStatus } from '../types';

const labels: Record<string, string> = {
  controller: 'Controller', virtual_disk: 'Virtual disk', physical_disk: 'Physical disk',
  cache_battery: 'Cache battery', enclosure: 'Enclosure', collector: 'Monitoring tool',
};

export const hardwareHealthHandler: ConditionHandler = {
  type: 'hardware_health',
  async evaluate(condition, deviceId) {
    const { type: _type, ...rest } = condition as Record<string, unknown>;
    const cond = monitorConditionSchemas.hardware_health.parse(rest);
    const [health] = await db.select().from(deviceHardwareHealth)
      .where(eq(deviceHardwareHealth.deviceId, deviceId)).limit(1);
    if (!health) return { passed: false, dataAvailable: false, subjects: [], description: 'No hardware health reported' };
    const components = await db.select().from(deviceHardwareComponents).where(and(
      eq(deviceHardwareComponents.deviceId, deviceId), eq(deviceHardwareComponents.stale, false),
      eq(deviceHardwareComponents.alertExempt, false), inArray(deviceHardwareComponents.componentType, cond.componentTypes),
    ));
    const now = new Date();
    const subjects: SubjectEvidence[] = components.map(c => {
      let status: SubjectStatus = 'unknown';
      const n = cond.consecutiveSnapshots;
      if (c.health !== 'unknown' && isComponentFresh(c, health, now)) {
        const breachCount = cond.minHealth === 'warning' ? c.unhealthyStreak : c.criticalStreak;
        const recoveryCount = cond.minHealth === 'warning' ? c.healthyStreak : c.belowCriticalStreak;
        if (breachCount >= n || (cond.includePredictiveFailure && c.predictiveStreak >= n)) status = 'breaching';
        else if (recoveryCount >= n && !c.predictiveFailure) status = 'recovered';
      }
      const attributes = c.attributes as Record<string, unknown>;
      const identity = [c.model, c.serial].filter(Boolean).join(' ');
      const componentLabel = `${labels[c.componentType]} ${attributes.slot ?? c.name}${identity ? ` (${identity})` : ''}`;
      const stateLabel = c.state.replaceAll('_', ' ');
      return { subjectKey: c.componentKey, status, description: `${componentLabel} is ${stateLabel}`,
        actualValue: HARDWARE_HEALTH_RANK[c.health], context: {
          source: 'hardware_health', subjectKey: c.componentKey, componentType: c.componentType,
          componentKey: c.componentKey, componentLabel, stateLabel, name: c.name, model: c.model,
          serial: c.serial, state: c.state, stateDetail: c.stateDetail ?? stateLabel, health: c.health,
          slot: attributes.slot ?? null, controller: c.parentKey, predictiveFailure: c.predictiveFailure,
        } };
    });
    const count = (status: SubjectStatus) => subjects.filter(s => s.status === status).length;
    return { passed: count('breaching') > 0, dataAvailable: components.length > 0, subjects,
      description: `${count('breaching')} breaching, ${count('recovered')} recovered, ${count('unknown')} unknown hardware components` };
  },
  validate(condition, path) {
    const { type: _type, ...rest } = (condition ?? {}) as Record<string, unknown>;
    const result = monitorConditionSchemas.hardware_health.safeParse(rest);
    return result.success ? [] : result.error.issues.map(i => `${path}.${i.path.join('.')}: ${i.message}`);
  },
};
