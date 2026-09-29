import { expect, it } from 'vitest';
import { interpolateAlertTemplate } from '@breeze/shared';
import { getMonitorKindSpec, applyOverrides } from './index';
const condition = { findings: ['sync_stale'], consecutiveSnapshots: 2 };
it('compiles subjects with exact category, templates and delivery metadata', () => {
  const spec = getMonitorKindSpec('time_sync');
  expect(
    spec.toAlertCondition(condition, {
      monitorId: '11111111-1111-4111-8111-111111111111',
    }),
  ).toEqual({ type: 'time_sync', ...condition });
  expect(spec).toMatchObject({
    alertCategory: 'system',
    agentDelivered: false,
    defaultSeverity: 'medium',
    titleTemplate: '{{findingLabel}} on {{deviceName}}',
    messageTemplate: '{{ruleName}}: {{findingDetail}}',
  });
  expect(
    interpolateAlertTemplate(spec.titleTemplate, {
      findingLabel: 'Time sync stale',
      deviceName: 'Device A',
    }),
  ).toBe('Time sync stale on Device A');
  expect(
    interpolateAlertTemplate(spec.messageTemplate, {
      ruleName: 'Time',
      findingDetail: 'Last sync exceeded 24 hours',
    }),
  ).toBe('Time: Last sync exceeded 24 hours');
});
it('overrides count but never changes findings', () => {
  const spec = getMonitorKindSpec('time_sync');
  expect(
    applyOverrides(spec, condition, {
      findings: ['sync_disabled'],
      consecutiveSnapshots: 3,
    }),
  ).toEqual({ findings: ['sync_stale'], consecutiveSnapshots: 3 });
  expect(() =>
    applyOverrides(spec, condition, { consecutiveSnapshots: 11 }),
  ).toThrow();
});
