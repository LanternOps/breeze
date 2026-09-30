import { afterEach, expect, it, vi } from 'vitest';
import { CommandTypes } from '../commandTypes';
import {
  defaultOfflinePolicy,
  deliverByFor,
  EXPLICITLY_CLASSIFIED_COMMAND_TYPES,
} from '../commandOfflinePolicy';
import { getCommandTimeoutMs } from '../commandTimeouts';
import { GATED_COMMAND_TYPES } from '../partnerTrust';
import { createCommandSchema } from '../../routes/devices/schemas';
const commands = [
  ['TIME_RESYNC', 'time_resync'],
  ['TIME_SET_TIMEZONE', 'time_set_timezone'],
  ['TIME_APPLY_POLICY', 'time_apply_policy'],
] as const;
afterEach(() => vi.unstubAllEnvs());
it.each(commands)(
  '%s has a fixed hour to deliver and a minute to execute',
  (key, type) => {
    expect((CommandTypes as Record<string, string>)[key]).toBe(type);
    expect(GATED_COMMAND_TYPES).toContain(type);
    expect(EXPLICITLY_CLASSIFIED_COMMAND_TYPES.has(type)).toBe(true);
    vi.stubEnv('DEVICE_COMMAND_QUEUE_SHORT_TTL_HOURS', '24');
    const policy = defaultOfflinePolicy(type);
    expect(policy).toEqual({ kind: 'queue', deliverWithinMs: 3_600_000 });
    expect(
      deliverByFor(policy, new Date('2026-09-28T12:00:00Z'))?.toISOString(),
    ).toBe('2026-09-28T13:00:00.000Z');
    expect(getCommandTimeoutMs(type)).toBe(60_000);
  },
);
it.each(['time_resync', 'time_apply_policy'])(
  '%s accepts only empty payloads',
  (type) => {
    expect(createCommandSchema.safeParse({ type }).success).toBe(true);
    expect(createCommandSchema.safeParse({ type, payload: {} }).success).toBe(
      true,
    );
    for (const payload of [{ command: 'anything' }, [], 'anything', null])
      expect(createCommandSchema.safeParse({ type, payload }).success).toBe(
        false,
      );
  },
);
it('accepts a known Windows ID', () => {
  expect(
    createCommandSchema.safeParse({
      type: 'time_set_timezone',
      payload: { windowsId: 'Eastern Standard Time' },
    }).success,
  ).toBe(true);
});
it.each([
  undefined,
  {},
  { windowsId: 'America/New_York' },
  { windowsId: 'Unknown Standard Time' },
  { windowsId: 'UTC /s invalid' },
  { windowsId: 'UTC', extra: true },
  { windowsId: 42 },
])('rejects timezone payload %#', (payload) => {
  expect(
    createCommandSchema.safeParse({ type: 'time_set_timezone', payload })
      .success,
  ).toBe(false);
});
it('preserves other command payloads', () => {
  expect(
    createCommandSchema.parse({ type: 'reboot', payload: { delay: 30 } }),
  ).toEqual({ type: 'reboot', payload: { delay: 30 } });
});
