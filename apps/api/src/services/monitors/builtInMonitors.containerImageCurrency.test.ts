import { expect, it } from 'vitest';
import { monitorConditionSchemas } from '@breeze/shared';
import {
  BUILT_IN_MONITOR_DEFAULTS,
  BUILT_IN_MONITORS_VERSION,
  defaultsToProvision,
} from './builtInMonitors';

it('v6 adds one partner-wide container image currency default', () => {
  expect(BUILT_IN_MONITORS_VERSION).toBe(6);
  const added = BUILT_IN_MONITOR_DEFAULTS.filter((d) => d.sinceVersion === 6);
  expect(added).toEqual([
    {
      key: 'container_image_out_of_date',
      name: 'Container image out of date',
      description: expect.stringContaining('7 days'),
      kind: 'container_image_currency',
      condition: { minDaysBehind: 7 },
      severity: 'low',
      cooldownMinutes: 1440,
      sinceVersion: 6,
    },
  ]);
  expect(monitorConditionSchemas.container_image_currency.parse(added[0]!.condition)).toEqual({ minDaysBehind: 7 });
});

it('a partner already at v5 gets only the new default; one at v6 gets nothing', () => {
  expect(defaultsToProvision(5).map((d) => d.key)).toEqual(['container_image_out_of_date']);
  expect(defaultsToProvision(6)).toEqual([]);
});
