import { describe, expect, it, vi } from 'vitest';
import {
  sendPagerDutyNotification,
  validatePagerDutyConfig
} from './pagerDutySender';

describe('pagerDutySender', () => {
  it('rejects config without routing/integration key', () => {
    const result = validatePagerDutyConfig({});
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('routingKey or integrationKey');
  });

  it('accepts config with integrationKey', () => {
    const result = validatePagerDutyConfig({ integrationKey: 'pd_key' });
    expect(result.valid).toBe(true);
  });

  it('fails closed without calling fetch when config is invalid', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const result = await sendPagerDutyNotification(
      {},
      {
        alertId: 'alert-1',
        alertName: 'Test Alert',
        severity: 'high',
        summary: 'summary',
        orgId: 'org-1',
        triggeredAt: new Date().toISOString()
      }
    );

    expect(result.success).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });
});
