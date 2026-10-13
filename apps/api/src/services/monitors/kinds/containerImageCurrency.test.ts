import { expect, it } from 'vitest';
import { interpolateAlertTemplate } from '@breeze/shared';
import { applyOverrides, getMonitorKindSpec } from './index';
import { isSubjectMonitorKind } from '../subjectMonitorKinds';

it('compiles to the server-evaluated image currency condition with subject templates', () => {
  const spec = getMonitorKindSpec('container_image_currency');
  expect(spec.toAlertCondition({ minDaysBehind: 7 }, { monitorId: '11111111-1111-4111-8111-111111111111' }))
    .toEqual({ type: 'container_image_currency', minDaysBehind: 7 });
  expect(spec).toMatchObject({
    alertCategory: 'system',
    agentDelivered: false,
    defaultSeverity: 'low',
    titleTemplate: 'Container image {{imageRef}} is out of date on {{deviceName}}',
    messageTemplate: '{{ruleName}}: {{imageRef}} has been behind its registry tag for {{daysBehind}} days',
  });
  expect(interpolateAlertTemplate(spec.titleTemplate, { imageRef: 'nginx:1.25', deviceName: 'Host A' }))
    .toBe('Container image nginx:1.25 is out of date on Host A');
  expect(interpolateAlertTemplate(spec.messageTemplate, { ruleName: 'Images', imageRef: 'nginx:1.25', daysBehind: 9 }))
    .toBe('Images: nginx:1.25 has been behind its registry tag for 9 days');
});

it('lets a policy override the age threshold within bounds', () => {
  const spec = getMonitorKindSpec('container_image_currency');
  expect(applyOverrides(spec, { minDaysBehind: 7 }, { minDaysBehind: 14 })).toEqual({ minDaysBehind: 14 });
  expect(() => applyOverrides(spec, { minDaysBehind: 7 }, { minDaysBehind: 400 })).toThrow();
});

it('runs through the subject alert path', () => {
  expect(isSubjectMonitorKind('container_image_currency')).toBe(true);
});
