import { describe, expect, it } from 'vitest';
import { createPolicySchema, escalationStepSchema, updatePolicySchema } from './schemas';
const step = { delayMinutes: 5, channelIds: ['11111111-1111-4111-8111-111111111111'], userIds: [] };
describe('escalation fan-out bounds', () => {
  it.each([{ everyMinutes: 1441, maxTimes: 1 }, { everyMinutes: 1, maxTimes: 11 },
    { everyMinutes: 0, maxTimes: 1 }, { everyMinutes: 1, maxTimes: 0 },
    { everyMinutes: 1.5, maxTimes: 1 }, { everyMinutes: 1, maxTimes: 1.5 }])('rejects repeat %j', renotify => {
    expect(escalationStepSchema.safeParse({ ...step, renotify }).success).toBe(false);
  });
  it.each([{ everyMinutes: 1, maxTimes: 1 }, { everyMinutes: 1440, maxTimes: 10 }])('accepts repeat boundary %j', renotify => {
    expect(escalationStepSchema.safeParse({ ...step, renotify }).success).toBe(true);
  });
  it.each([createPolicySchema, updatePolicySchema])('limits total policy occurrences on create and update', schema => {
    const steps = Array.from({ length: 5 }, () => ({ ...step, renotify: { everyMinutes: 1, maxTimes: 9 } }));
    expect(schema.safeParse({ name: 'Policy', steps }).success).toBe(true);
    const result = schema.safeParse({ name: 'Policy', steps: [...steps, step] });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toBe('Escalation policy must have at most 50 total occurrences');
  });
});
