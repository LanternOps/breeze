import { describe, expect, it } from 'vitest';
import {
  isCronDue,
  normalizeAutomationActions,
  normalizeAutomationTrigger,
  normalizeNotificationTargets,
  withWebhookDefaults,
} from './automationRuntime';

describe('automationRuntime', () => {
  it('normalizes schedule trigger and evaluates due cron slots', () => {
    const trigger = normalizeAutomationTrigger({
      type: 'schedule',
      cronExpression: '30 14 * * *',
      timezone: 'UTC',
    });

    expect(trigger.type).toBe('schedule');
    expect(isCronDue('30 14 * * *', 'UTC', new Date('2026-01-01T14:30:00Z'))).toBe(true);
    expect(isCronDue('30 14 * * *', 'UTC', new Date('2026-01-01T14:31:00Z'))).toBe(false);
  });

  it('normalizes event trigger with filter', () => {
    const trigger = normalizeAutomationTrigger({
      type: 'event',
      eventType: 'device.offline',
      filter: { 'device.siteId': 'site-1' },
    });

    expect(trigger).toEqual({
      type: 'event',
      eventType: 'device.offline',
      filter: { 'device.siteId': 'site-1' },
    });
  });

  it('adds webhook defaults when secret and url are missing', () => {
    const base = normalizeAutomationTrigger({ type: 'webhook' });
    const trigger = withWebhookDefaults(base, 'automation-123', 'https://api.example.com/api/v1/automations');

    expect(trigger.type).toBe('webhook');
    if (trigger.type !== 'webhook') {
      throw new Error('expected webhook trigger');
    }
    expect(trigger.webhookUrl).toBe('https://api.example.com/api/v1/automations/webhooks/automation-123');
    expect(trigger.secret).toBeTruthy();
  });

  it('normalizes all supported action types', () => {
    const actions = normalizeAutomationActions([
      { type: 'run_script', scriptId: 'script-1' },
      { type: 'send_notification', notificationChannelId: 'channel-1' },
      { type: 'create_alert', alertSeverity: 'high', alertMessage: 'Disk low' },
      { type: 'execute_command', command: 'echo ok' },
    ]);

    expect(actions.map((action) => action.type)).toEqual([
      'run_script',
      'send_notification',
      'create_alert',
      'execute_command',
    ]);
  });

  it('normalizes notification targets from legacy and canonical payloads', () => {
    expect(normalizeNotificationTargets(['channel-1', 'channel-2'])).toEqual({
      channelIds: ['channel-1', 'channel-2'],
    });

    expect(normalizeNotificationTargets({ channelIds: ['channel-1'], emails: ['ops@example.com'] })).toEqual({
      channelIds: ['channel-1'],
      emails: ['ops@example.com'],
    });
  });
});
