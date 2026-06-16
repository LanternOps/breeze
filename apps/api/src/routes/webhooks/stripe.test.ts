// apps/api/src/routes/webhooks/stripe.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The route is UNAUTHENTICATED (Stripe-signed). We mock the signature verifier,
// the dispatch handler, the rate limiter, and the client-ip helper so the test
// exercises the route's contract (status codes + that the RAW body string is what
// reaches verifyStripeEvent) without a real Stripe SDK or Redis.
const { verifyStripeEvent, handleStripeEvent, rateLimiter, captureException } = vi.hoisted(() => ({
  verifyStripeEvent: vi.fn(),
  handleStripeEvent: vi.fn().mockResolvedValue(undefined),
  rateLimiter: vi.fn().mockResolvedValue({ allowed: true }),
  captureException: vi.fn(),
}));

vi.mock('../../services/stripeWebhook', () => ({ verifyStripeEvent, handleStripeEvent }));
vi.mock('../../services/rate-limit', () => ({ rateLimiter }));
vi.mock('../../services/redis', () => ({ getRedis: () => ({}) }));
vi.mock('../../services/clientIp', () => ({ getTrustedClientIp: () => '1.2.3.4' }));
vi.mock('../../services/sentry', () => ({ captureException }));

import { stripeWebhookRoutes } from './stripe';

const RAW_BODY = '{"id":"evt_1","type":"checkout.session.completed"}';

function post(opts: { sig?: string; body?: string } = {}) {
  const headers: Record<string, string> = {};
  if (opts.sig !== undefined) headers['stripe-signature'] = opts.sig;
  return stripeWebhookRoutes.request('/stripe/connect', {
    method: 'POST',
    headers,
    body: opts.body ?? RAW_BODY,
  });
}

describe('POST /stripe/connect (Stripe webhook)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rateLimiter.mockResolvedValue({ allowed: true });
    handleStripeEvent.mockResolvedValue(undefined);
    verifyStripeEvent.mockReturnValue({ id: 'evt_1', type: 'checkout.session.completed' });
  });

  it('429s when rate-limited (before any signature work)', async () => {
    rateLimiter.mockResolvedValue({ allowed: false });
    const res = await post({ sig: 't=1,v1=abc' });
    expect(res.status).toBe(429);
    expect(verifyStripeEvent).not.toHaveBeenCalled();
    expect(handleStripeEvent).not.toHaveBeenCalled();
  });

  it('400s when the stripe-signature header is missing', async () => {
    const res = await post({}); // no sig header
    expect(res.status).toBe(400);
    expect(verifyStripeEvent).not.toHaveBeenCalled();
  });

  it('400s on an invalid signature (verifyStripeEvent throws)', async () => {
    verifyStripeEvent.mockImplementation(() => { throw new Error('bad sig'); });
    const res = await post({ sig: 't=1,v1=bad' });
    expect(res.status).toBe(400);
    expect(handleStripeEvent).not.toHaveBeenCalled();
  });

  it('passes the RAW request body string to verifyStripeEvent (signature integrity)', async () => {
    await post({ sig: 't=1,v1=abc', body: RAW_BODY });
    expect(verifyStripeEvent).toHaveBeenCalledWith(RAW_BODY, 't=1,v1=abc');
  });

  it('500s (transient-retry contract) and captures to Sentry when the handler throws', async () => {
    handleStripeEvent.mockRejectedValue(new Error('boom'));
    const res = await post({ sig: 't=1,v1=abc' });
    // 500 so Stripe retries; idempotency makes retries safe.
    expect(res.status).toBe(500);
    expect(captureException).toHaveBeenCalled();
  });

  it('202s on success', async () => {
    const res = await post({ sig: 't=1,v1=abc' });
    expect(res.status).toBe(202);
    expect(handleStripeEvent).toHaveBeenCalled();
    expect(await res.json()).toMatchObject({ received: true });
  });
});
