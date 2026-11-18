import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  sendPagerDutyNotification,
  validatePagerDutyConfig
} from './pagerDutySender';

describe('pagerDutySender', () => {
  afterEach(() => vi.restoreAllMocks());
  it.each([true, false])('renders the subject in PagerDuty (workload=%s)', async (workload) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ status: 'success' }), { status: 202 }));
    const subjectName = workload ? 'Microsoft 365 mail backup · Example customer' : 'Server-1';
    await sendPagerDutyNotification({ integrationKey: 'pd_key' }, { alertId: 'alert-1', alertName: 'Alert', severity: 'high', summary: 'Failed', orgId: 'org-1', triggeredAt: '2026-10-31T00:00:00Z', subjectName, ownerKind: workload ? 'backup_workload' : 'device', deviceName: workload ? undefined : 'Server-1' });
    expect(JSON.parse(fetchSpy.mock.calls[0]?.[1]?.body as string).payload).toMatchObject({ source: subjectName, component: subjectName, custom_details: { subjectName, ownerKind: workload ? 'backup_workload' : 'device' } });
    fetchSpy.mockRestore();
  });

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
