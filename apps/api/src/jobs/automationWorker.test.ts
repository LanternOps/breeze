import { describe, expect, it } from 'vitest';
import { shouldTriggerEventAutomation, shouldTriggerScheduleAutomation } from './automationWorker';

describe('automationWorker trigger helpers', () => {
  it('matches due schedule slots using cron + timezone', () => {
    const trigger = {
      type: 'schedule' as const,
      cronExpression: '0 * * * *',
      timezone: 'UTC',
    };

    expect(shouldTriggerScheduleAutomation(trigger, new Date('2026-01-01T10:00:00Z'))).toBe(true);
    expect(shouldTriggerScheduleAutomation(trigger, new Date('2026-01-01T10:01:00Z'))).toBe(false);
  });

  it('matches event triggers with nested filter values', () => {
    const trigger = {
      type: 'event' as const,
      eventType: 'device.offline',
      filter: {
        'device.siteId': 'site-1',
        'device.tags': ['prod', 'linux'],
      },
    };

    const payload = {
      device: {
        siteId: 'site-1',
        tags: ['prod', 'linux', 'critical'],
      },
    };

    expect(shouldTriggerEventAutomation(trigger, 'device.offline', payload)).toBe(true);
  });

  it('rejects event triggers when type or filter mismatch', () => {
    const trigger = {
      type: 'event' as const,
      eventType: 'device.offline',
      filter: {
        'device.siteId': 'site-1',
      },
    };

    expect(shouldTriggerEventAutomation(trigger, 'device.online', { device: { siteId: 'site-1' } })).toBe(false);
    expect(shouldTriggerEventAutomation(trigger, 'device.offline', { device: { siteId: 'site-2' } })).toBe(false);
  });
});
