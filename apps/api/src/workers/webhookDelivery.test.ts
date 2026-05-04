import { beforeEach, describe, expect, it, vi } from 'vitest';

const { safeFetchMock, validateWebhookUrlSafetyWithDnsMock } = vi.hoisted(() => ({
  safeFetchMock: vi.fn(),
  validateWebhookUrlSafetyWithDnsMock: vi.fn(),
}));

vi.mock('../services/redis', () => ({
  getRedisConnection: vi.fn(),
}));

vi.mock('../services/eventBus', () => ({
  getEventBus: vi.fn(() => ({ subscribe: vi.fn() })),
}));

vi.mock('../services/notificationSenders/webhookSender', () => ({
  validateWebhookUrlSafetyWithDns: (...args: unknown[]) => validateWebhookUrlSafetyWithDnsMock(...(args as [])),
}));

vi.mock('../services/urlSafety', async () => {
  const actual = await vi.importActual<typeof import('../services/urlSafety')>('../services/urlSafety');
  return {
    ...actual,
    safeFetch: (...args: unknown[]) => safeFetchMock(...(args as [])),
  };
});

vi.mock('../db', () => ({
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

import { SsrfBlockedError } from '../services/urlSafety';
import { deliverWebhook, type WebhookDeliveryJob } from './webhookDelivery';

function makeJob(overrides: Partial<WebhookDeliveryJob> = {}): WebhookDeliveryJob {
  return {
    id: 'delivery-1',
    webhookId: 'webhook-1',
    webhook: {
      id: 'webhook-1',
      orgId: 'org-1',
      name: 'Webhook',
      url: 'https://hooks.example.test/events',
      secret: 'signing-secret',
      events: ['device.created'],
      headers: { Authorization: 'Bearer token' },
    },
    event: {
      id: 'event-1',
      orgId: 'org-1',
      type: 'device.created',
      payload: { deviceId: 'device-1' },
      metadata: { timestamp: '2026-05-02T00:00:00.000Z' },
    } as any,
    attempts: 0,
    createdAt: '2026-05-02T00:00:00.000Z',
    ...overrides,
  };
}

describe('webhook delivery worker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    validateWebhookUrlSafetyWithDnsMock.mockResolvedValue([]);
  });

  it('delivers with safeFetch so DNS resolution is pinned at connection time', async () => {
    safeFetchMock.mockResolvedValueOnce(new Response('ok', { status: 200 }));

    const result = await deliverWebhook(makeJob({
      webhook: {
        ...makeJob().webhook,
        headers: {
          Authorization: 'Bearer token',
          Host: '169.254.169.254',
          'X-Breeze-Event-Type': 'forged',
          'X-Custom': 'ok'
        }
      }
    }));

    expect(result.success).toBe(true);
    expect(safeFetchMock).toHaveBeenCalledWith(
      'https://hooks.example.test/events',
      expect.objectContaining({
        method: 'POST',
        redirect: 'error',
      })
    );
    const init = safeFetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer token');
    expect((init.headers as Record<string, string>)['X-Custom']).toBe('ok');
    expect((init.headers as Record<string, string>).Host).toBeUndefined();
    expect((init.headers as Record<string, string>)['X-Breeze-Event-Type']).toBe('device.created');
    expect((init.headers as Record<string, string>)['X-Breeze-Signature']).toMatch(/^sha256=/);
  });

  it('returns an unsafe-url failure when safeFetch blocks rebinding to private networks', async () => {
    safeFetchMock.mockRejectedValueOnce(new SsrfBlockedError('all resolved IPs are private/loopback/link-local'));

    const result = await deliverWebhook(makeJob());

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('Unsafe webhook URL');
    expect(validateWebhookUrlSafetyWithDnsMock).toHaveBeenCalled();
  });
});
