import { describe, expect, it, vi } from 'vitest';
import {
  sendWebhookNotification,
  validateWebhookConfig,
  validateWebhookUrlSafety
} from './webhookSender';

describe('webhook sender safety', () => {
  it('rejects non-https and private URLs during config validation', () => {
    const result = validateWebhookConfig({
      url: 'http://127.0.0.1/webhook',
      method: 'POST'
    });

    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('HTTPS');
  });

  it('returns safety errors for loopback targets', () => {
    const errors = validateWebhookUrlSafety('https://127.0.0.1/webhook');
    expect(errors.length).toBeGreaterThan(0);
  });

  it('fails closed before fetch when webhook URL is unsafe', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const result = await sendWebhookNotification(
      {
        url: 'http://169.254.169.254/latest/meta-data',
        method: 'POST'
      },
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
    expect(result.error).toContain('Unsafe webhook URL');
    expect(fetchSpy).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });
});
