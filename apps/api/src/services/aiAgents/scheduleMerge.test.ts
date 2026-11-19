import { describe, expect, it } from 'vitest';
import type { AiSweepKind } from '@breeze/shared';
import { scheduleWriteWidens } from './scheduleMerge';

const kinds = (...k: string[]) => k as AiSweepKind[];
const state = (over: Partial<{ enabled: boolean; sweepKinds: AiSweepKind[]; actMode: boolean }> = {}) => ({
  enabled: true,
  sweepKinds: kinds('disk_pressure', 'stale_agents'),
  actMode: true,
  ...over,
});

describe('scheduleWriteWidens (W16 Decision 3)', () => {
  it.each([
    ['enabling a disabled schedule', state({ enabled: false }), state()],
    ['a kind the schedule did not have', state({ sweepKinds: kinds('disk_pressure') }), state()],
    ['re-arming', state({ actMode: false }), state()],
  ])('%s widens', (_label, before, after) => {
    expect(scheduleWriteWidens(before, after)).toBe(true);
  });

  it.each([
    ['no change', state(), state()],
    ['disabling', state(), state({ enabled: false })],
    ['removing a kind', state(), state({ sweepKinds: kinds('disk_pressure') })],
    ['disarming', state(), state({ actMode: false })],
    ['the same kinds in another order', state(), state({ sweepKinds: kinds('stale_agents', 'disk_pressure') })],
  ])('%s does not widen', (_label, before, after) => {
    expect(scheduleWriteWidens(before, after)).toBe(false);
  });
});
