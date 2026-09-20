import { describe, expect, it } from 'vitest';
import { createPolicySchema, updatePolicySchema, escalationStepSchema } from './schemas';

const CH = '9a8b7c6d-2222-4333-8444-555566667777';

describe('escalation policy steps schema (W05b)', () => {
  it('accepts delayMinutes + channelIds', () => {
    expect(escalationStepSchema.safeParse({ delayMinutes: 15, channelIds: [CH] }).success).toBe(true);
  });
  it('rejects a step with no targets, a zero delay, and invalid user IDs', () => {
    expect(escalationStepSchema.safeParse({ delayMinutes: 15, channelIds: [] }).success).toBe(false);
    expect(escalationStepSchema.safeParse({ delayMinutes: 0, channelIds: [CH] }).success).toBe(false);
    expect(escalationStepSchema.safeParse({ delayMinutes: 5, channelIds: [CH], userIds: ['u'] }).success).toBe(false);
  });
  it('accepts user-only steps and bounded repeats; rejects malformed repetition', () => {
    expect(escalationStepSchema.parse({ delayMinutes: 5, userIds: [CH], repeat: { everyMinutes: 10, maxTimes: 2 } }))
      .toEqual({ delayMinutes: 5, channelIds: [], userIds: [CH], repeat: { everyMinutes: 10, maxTimes: 2 } });
    for (const repeat of [{ everyMinutes: 0, maxTimes: 2 }, { everyMinutes: 10, maxTimes: 0 }, { everyMinutes: 10, maxTimes: 101 }]) {
      expect(escalationStepSchema.safeParse({ delayMinutes: 5, channelIds: [CH], repeat }).success).toBe(false);
    }
  });
  it('create requires 1..10 steps; update keeps steps optional', () => {
    expect(createPolicySchema.safeParse({ name: 'On-call', steps: [] }).success).toBe(false);
    expect(createPolicySchema.safeParse({ name: 'On-call', steps: [{ delayMinutes: 5, channelIds: [CH] }] }).success).toBe(true);
    expect(createPolicySchema.safeParse({ name: 'On-call', steps: 'nope' }).success).toBe(false);
    expect(updatePolicySchema.safeParse({ name: 'Renamed' }).success).toBe(true);
  });
});
