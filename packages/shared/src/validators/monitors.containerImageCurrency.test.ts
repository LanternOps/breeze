import { expect, it } from 'vitest';
import {
  compositeConditionSchema,
  MONITOR_KINDS,
  monitorConditionSchemas,
  SERVER_EVALUATED_MONITOR_KINDS,
} from './monitors';

it('registers container_image_currency as a root-only kind, last in the enum order', () => {
  expect(MONITOR_KINDS[MONITOR_KINDS.length - 1]).toBe('container_image_currency');
  expect(SERVER_EVALUATED_MONITOR_KINDS).not.toContain('container_image_currency');
});

it('defaults the behind age to 7 days and bounds it', () => {
  expect(monitorConditionSchemas.container_image_currency.parse({})).toEqual({ minDaysBehind: 7 });
  expect(monitorConditionSchemas.container_image_currency.parse({ minDaysBehind: 0 })).toEqual({ minDaysBehind: 0 });
  expect(monitorConditionSchemas.container_image_currency.safeParse({ minDaysBehind: -1 }).success).toBe(false);
  expect(monitorConditionSchemas.container_image_currency.safeParse({ minDaysBehind: 366 }).success).toBe(false);
  expect(monitorConditionSchemas.container_image_currency.safeParse({ minDaysBehind: 1.5 }).success).toBe(false);
  expect(monitorConditionSchemas.container_image_currency.safeParse({ minDaysBehind: 7, extra: 1 }).success).toBe(false);
});

it('rejects image subjects inside composites', () => {
  expect(
    compositeConditionSchema.safeParse({
      match: 'all',
      children: [
        { kind: 'container_image_currency', condition: { minDaysBehind: 7 } },
        { kind: 'cpu', condition: { operator: 'gt', value: 90 } },
      ],
    }).success,
  ).toBe(false);
});
