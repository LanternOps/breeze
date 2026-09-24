import { expect, it } from 'vitest';
import { interpolateAlertTemplate } from '@breeze/shared';
import { getMonitorKindSpec, applyOverrides } from './index';
const condition = { componentTypes: ['physical_disk'], minHealth: 'critical', includePredictiveFailure: true, consecutiveSnapshots: 2 };
it('compiles a hardware root with exact templates and category', () => {
  const spec = getMonitorKindSpec('hardware_health');
  expect(spec.toAlertCondition(condition, { monitorId: 'monitor' })).toEqual({ type: 'hardware_health', ...condition });
  expect(spec.alertCategory).toBe('hardware'); expect(spec.agentDelivered).toBe(false); expect(spec.defaultSeverity).toBe('high');
  expect(spec.titleTemplate).toBe('{{componentLabel}} {{stateLabel}} on {{deviceName}}');
  expect(spec.messageTemplate).toBe('{{ruleName}}: {{componentLabel}} is {{stateLabel}} ({{stateDetail}})');
  const context = { componentLabel: 'Physical disk 252:3', stateLabel: 'failed', deviceName: 'server', ruleName: 'Disks', stateDetail: 'Failed' };
  expect(interpolateAlertTemplate(spec.titleTemplate, context)).toBe('Physical disk 252:3 failed on server');
  expect(interpolateAlertTemplate(spec.messageTemplate, context)).toBe('Disks: Physical disk 252:3 is failed (Failed)');
});
it('overrides threshold, predictive inclusion and streak length but not component identity', () => {
  const spec = getMonitorKindSpec('hardware_health');
  expect(applyOverrides(spec, condition, { componentTypes: ['collector'], minHealth: 'warning',
    includePredictiveFailure: false, consecutiveSnapshots: 3 })).toEqual({ ...condition,
    minHealth: 'warning', includePredictiveFailure: false, consecutiveSnapshots: 3 });
  expect(() => applyOverrides(spec, condition, { consecutiveSnapshots: 11 })).toThrow();
});
