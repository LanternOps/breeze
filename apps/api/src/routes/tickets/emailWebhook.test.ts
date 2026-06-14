import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const { verifyMock, parseMock, enqueueMock, rateLimiterMock, getRedisStub } = vi.hoisted(() => ({
  verifyMock: vi.fn(),
  parseMock: vi.fn(),
  enqueueMock: vi.fn().mockResolvedValue(undefined),
  rateLimiterMock: vi.fn(),
  getRedisStub: vi.fn(() => ({}))
}));

vi.mock('../../services/inboundEmail/mailgun', () => ({
  MailgunInboundProvider: class {
    name = 'mailgun';
    verify(...args: unknown[]) { return verifyMock(...args); }
    parse(...args: unknown[]) { return parseMock(...args); }
  }
}));
vi.mock('../../services/inboundEmailQueue', () => ({
  enqueueInboundEmail: enqueueMock
}));
vi.mock('../../services/rate-limit', () => ({
  rateLimiter: rateLimiterMock
}));
vi.mock('../../services/redis', () => ({
  getRedis: getRedisStub
}));
vi.mock('../../services/clientIp', () => ({
  getTrustedClientIp: vi.fn(() => '1.2.3.4')
}));

import { emailWebhookRoutes } from './emailWebhook';

const normalizedEmail = {
  provider: 'mailgun',
  providerMessageId: 'mg-abc',
  to: 'support@tickets.example.com',
  from: 'user@acme.example',
  fromName: 'A User',
  subject: 'Printer broken',
  text: 'Help please',
  attachments: [],
  raw: {}
};

function buildApp() {
  const app = new Hono();
  app.route('/webhooks/tickets', emailWebhookRoutes);
  return app;
}

async function post(app: Hono, body: Record<string, string> = {}) {
  const form = new FormData();
  for (const [k, v] of Object.entries(body)) {
    form.append(k, v);
  }
  return app.request('/webhooks/tickets/email-inbound', {
    method: 'POST',
    body: form
  });
}

describe('POST /webhooks/tickets/email-inbound', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: rate limit allowed
    rateLimiterMock.mockResolvedValue({ allowed: true, remaining: 59, resetAt: new Date() });
    // Default: verify passes
    verifyMock.mockResolvedValue(true);
    // Default: parse returns normalized email
    parseMock.mockResolvedValue(normalizedEmail);
    // Default: enqueue succeeds
    enqueueMock.mockResolvedValue(undefined);
  });

  it('returns 202 on a valid verified request', async () => {
    const app = buildApp();
    const res = await post(app, { timestamp: 't', token: 'k', signature: 'sig' });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toEqual({ accepted: true });
    expect(enqueueMock).toHaveBeenCalledWith(normalizedEmail);
  });

  it('returns 401 when HMAC verify fails', async () => {
    verifyMock.mockResolvedValue(false);
    const app = buildApp();
    const res = await post(app, { timestamp: 't', token: 'k', signature: 'bad' });
    expect(res.status).toBe(401);
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('returns 400 when parse throws', async () => {
    parseMock.mockRejectedValue(new Error('malformed multipart'));
    const app = buildApp();
    const res = await post(app, { timestamp: 't', token: 'k', signature: 'sig' });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string; detail: string };
    expect(body.detail).toContain('malformed multipart');
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('returns 503 when enqueue throws so the provider can retry', async () => {
    enqueueMock.mockRejectedValue(new Error('Redis connection refused'));
    const app = buildApp();
    const res = await post(app, { timestamp: 't', token: 'k', signature: 'sig' });
    expect(res.status).toBe(503);
  });

  it('returns 429 when rate limit is exceeded', async () => {
    rateLimiterMock.mockResolvedValue({ allowed: false, remaining: 0, resetAt: new Date() });
    const app = buildApp();
    const res = await post(app);
    expect(res.status).toBe(429);
    expect(verifyMock).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('calls provider.verify before provider.parse', async () => {
    const callOrder: string[] = [];
    verifyMock.mockImplementation(async () => { callOrder.push('verify'); return true; });
    parseMock.mockImplementation(async () => { callOrder.push('parse'); return normalizedEmail; });

    const app = buildApp();
    await post(app, { timestamp: 't', token: 'k', signature: 'sig' });
    expect(callOrder).toEqual(['verify', 'parse']);
  });

  it('does not call parse when verify returns false', async () => {
    verifyMock.mockResolvedValue(false);
    const app = buildApp();
    await post(app, { timestamp: 't', token: 'k', signature: 'bad' });
    expect(parseMock).not.toHaveBeenCalled();
  });
});
