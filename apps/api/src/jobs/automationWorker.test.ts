import { describe, expect, it } from 'vitest';
import {
  collectDueConfigPolicyScheduleDispatches,
  shouldTriggerEventAutomation,
  shouldTriggerScheduleAutomation,
} from './automationWorker';

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

  it('deduplicates due config-policy schedule dispatches by automation per slot', () => {
    const scanDate = new Date('2026-01-01T10:00:00Z');
    const baseAutomation = {
      id: 'cp-auto-1',
      name: 'Patching',
      cronExpression: '0 * * * *',
      timezone: 'UTC',
    };

    const dispatches = collectDueConfigPolicyScheduleDispatches([
      {
        automation: baseAutomation as any,
        assignmentLevel: 'organization',
        assignmentTargetId: 'org-1',
        policyId: 'policy-1',
        policyName: 'Policy 1',
      } as any,
      {
        automation: baseAutomation as any,
        assignmentLevel: 'site',
        assignmentTargetId: 'site-1',
        policyId: 'policy-1',
        policyName: 'Policy 1',
      } as any,
      {
        automation: {
          ...baseAutomation,
          id: 'cp-auto-2',
          cronExpression: '15 * * * *',
        } as any,
        assignmentLevel: 'organization',
        assignmentTargetId: 'org-1',
        policyId: 'policy-2',
        policyName: 'Policy 2',
      } as any,
    ], scanDate);

    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]?.configPolicyAutomationId).toBe('cp-auto-1');
    expect(dispatches[0]?.assignmentTargets).toEqual(
      expect.arrayContaining([
        { level: 'organization', targetId: 'org-1' },
        { level: 'site', targetId: 'site-1' },
      ]),
    );
  });
});
