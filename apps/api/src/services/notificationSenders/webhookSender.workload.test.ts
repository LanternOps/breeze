import { beforeEach, describe, expect, it, vi } from 'vitest';
const { safeFetch } = vi.hoisted(() => ({ safeFetch: vi.fn() }));
vi.mock('../urlSafety', async (original) => ({ ...await original<typeof import('../urlSafety')>(), safeFetch }));
import { sendWebhookNotification } from './webhookSender';
const payload = {
  alertId: 'alert-1', alertName: 'Backup failed', severity: 'high', summary: 'Microsoft 365 mail backup failed',
  deviceId: null, orgId: 'org-1', triggeredAt: '2026-10-30T00:00:00.000Z',
  owner: { kind: 'backup_workload' as const, ref: 'workload-1' }, ownerKind: 'backup_workload' as const,
  ownerLabel: 'Microsoft 365 mail backup', subjectName: 'Microsoft 365 mail backup · Example customer',
};
beforeEach(() => { safeFetch.mockReset().mockResolvedValue({ ok: true, status: 200, text: async () => '' }); });
describe('workload webhook channel payload', () => {
  it('renders owner template fields and the legacy device alias without null text', async () => {
    await sendWebhookNotification({ url: 'https://example.com/hook', payloadTemplate: '{"subject":"{{device}}","legacyName":"{{deviceName}}","kind":"{{ownerKind}}","label":"{{ownerLabel}}","name":"{{subjectName}}","ref":"{{owner.ref}}"}' }, payload);
    const body = safeFetch.mock.calls[0]?.[1].body;
    expect(JSON.parse(body)).toEqual({ subject: payload.subjectName, legacyName: payload.subjectName, kind: 'backup_workload', label: payload.ownerLabel, name: payload.subjectName, ref: 'workload-1' });
    expect(body).not.toContain('null');
  });
  it('adds owner metadata to the default payload while preserving the null device', async () => {
    await sendWebhookNotification({ url: 'https://example.com/hook' }, payload);
    expect(JSON.parse(safeFetch.mock.calls[0]?.[1].body)).toMatchObject({ device: null, alert: { owner: payload.owner, ownerKind: 'backup_workload', subjectName: payload.subjectName } });
  });
});
