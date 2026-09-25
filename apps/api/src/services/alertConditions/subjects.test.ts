import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../../db', () => ({ db: {} }));
vi.mock('./utils', async original => ({ ...await original<typeof import('./utils')>(), getLatestMetric: vi.fn().mockResolvedValue(null) }));
import { evaluateConditions, conditionRegistry } from './index';
import { hardwareHealthHandler } from './handlers/hardwareHealth';
afterEach(() => vi.restoreAllMocks());
it('registers the hardware handler', () => expect(conditionRegistry.get('hardware_health')).toBe(hardwareHealthHandler));
it.each(['leaf', 'array', 'and', 'or'])('subjects on %s', async shape => {
  const subjects = [{ subjectKey: 'disk:3', status: 'unknown' as const, description: 'Waiting for evidence' }];
  vi.spyOn(conditionRegistry, 'evaluate').mockResolvedValue({ passed: false, dataAvailable: false, description: 'No data', subjects });
  const leaf = { type: 'hardware_health' };
  const input = shape === 'leaf' ? leaf : shape === 'array' ? [leaf] : { logic: shape, conditions: [leaf] };
  const result = await evaluateConditions(input, 'device');
  expect(result.dataState).toBe('unknown');
  expect(result.subjects).toEqual(shape === 'leaf' ? subjects : undefined);
  expect(conditionRegistry.evaluate).toHaveBeenCalledTimes(1);
});
