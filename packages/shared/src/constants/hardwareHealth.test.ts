import { expect, it } from 'vitest';
import { HARDWARE_STATES, HARDWARE_STATE_HEALTH, deriveHardwareHealth, worstHardwareHealth,
  type HardwareComponentType } from './hardwareHealth';
it('maps every legal state exactly once', () => {
  for (const type of Object.keys(HARDWARE_STATES) as HardwareComponentType[]) {
    expect(Object.keys(HARDWARE_STATE_HEALTH[type]).sort()).toEqual([...HARDWARE_STATES[type]].sort());
    for (const state of HARDWARE_STATES[type]) expect(deriveHardwareHealth({componentType:type,state,predictiveFailure:false})).toBe(HARDWARE_STATE_HEALTH[type][state]);
  }
});
it.each([
  ['virtual_disk','degraded','critical'], ['physical_disk','degraded','warning'],
  ['virtual_disk','rebuilding','warning'], ['cache_battery','learning','ok'],
  ['collector','backing_off','warning'], ['bmc','unknown','unknown'],
] as const)('%s %s derives %s', (componentType,state,health) => {
  expect(deriveHardwareHealth({componentType,state,predictiveFailure:false})).toBe(health);
});
it('raises flags without lowering failed state', () => {
  const input = {componentType:'physical_disk' as const,state:'online',predictiveFailure:false};
  expect(deriveHardwareHealth({...input,predictiveFailure:true})).toBe('warning');
  expect(deriveHardwareHealth({...input,memberErrors:true})).toBe('warning');
  expect(deriveHardwareHealth({...input,osHealthStatus:'warning'})).toBe('warning');
  expect(deriveHardwareHealth({...input,osHealthStatus:'unhealthy'})).toBe('critical');
  expect(deriveHardwareHealth({...input,smartPassed:false})).toBe('critical');
  expect(deriveHardwareHealth({...input,state:'failed',smartPassed:true,osHealthStatus:'healthy'})).toBe('critical');
  expect(worstHardwareHealth([])).toBe('unknown');
  expect(worstHardwareHealth(['unknown','ok'])).toBe('ok');
  expect(worstHardwareHealth(['critical','warning','ok'])).toBe('critical');
});
