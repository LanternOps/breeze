import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => unknown) => fn()),
}));

vi.mock('../../db', () => ({
  db: { update: mocks.update },
  runOutsideDbContext: mocks.runOutsideDbContext,
  withSystemDbAccessContext: mocks.withSystemDbAccessContext,
}));

vi.mock('../../services/sentry', () => ({
  captureException: vi.fn(),
}));

vi.mock('../../services/auditEvents', () => ({
  writeAuditEvent: vi.fn(),
}));

// ---- helpers ---------------------------------------------------------------

/** Queue a db.update().set().where().returning() that returns the given rows. */
function queueUpdateReturning(rows: unknown[] = []) {
  const returning = vi.fn(async () => rows);
  const where = vi.fn(() => ({ returning }));
  const set = vi.fn(() => ({ where }));
  mocks.update.mockImplementationOnce(() => ({ set }));
  return { set, where, returning };
}

// ---- tests -----------------------------------------------------------------

describe('POST /internal/partners/:id/activate', () => {
  let app: Hono;

  beforeEach(async () => {
    process.env.BREEZE_BILLING_CALLBACK_SECRET = 'test-secret';
    vi.clearAllMocks();
    // Import fresh each time so the route picks up the current env.
    // vi.mock above is hoisted and persists across resets.
    vi.resetModules();
    const { partnerActivateRoute } = await import('./partnerActivate');
    app = new Hono().route('/', partnerActivateRoute);
  });

  afterEach(() => {
    delete process.env.BREEZE_BILLING_CALLBACK_SECRET;
  });

  const validBody = JSON.stringify({
    stripe_customer_id: 'cus_x',
    payment_method_attached_at: '2026-04-29T12:00:00Z',
  });

  it('returns 401 when shared-secret header is missing', async () => {
    const res = await app.request('/internal/partners/p1/activate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: validBody,
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  it('returns 401 when shared-secret header is wrong', async () => {
    const res = await app.request('/internal/partners/p1/activate', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-breeze-billing-secret': 'wrong-secret',
      },
      body: validBody,
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  it('returns 401 when BREEZE_BILLING_CALLBACK_SECRET is unset (fail closed)', async () => {
    // Clear the env var and rebuild the app so the handler sees it unset.
    delete process.env.BREEZE_BILLING_CALLBACK_SECRET;
    vi.resetModules();
    const { partnerActivateRoute } = await import('./partnerActivate');
    const appWithoutSecret = new Hono().route('/', partnerActivateRoute);

    const res = await appWithoutSecret.request('/internal/partners/p1/activate', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-breeze-billing-secret': 'anything',
      },
      body: validBody,
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  it('returns 400 when body validation fails (missing stripe_customer_id)', async () => {
    const res = await app.request('/internal/partners/p1/activate', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-breeze-billing-secret': 'test-secret',
      },
      body: JSON.stringify({ payment_method_attached_at: '2026-04-29T12:00:00Z' }),
    });
    expect(res.status).toBe(400);
  });

  it('flips status=active and records stripe_customer_id when secret matches', async () => {
    const PARTNER_UUID = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
    const { set } = queueUpdateReturning([{ id: PARTNER_UUID, status: 'active' }]);
    const res = await app.request(`/internal/partners/${PARTNER_UUID}/activate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-breeze-billing-secret': 'test-secret',
      },
      body: validBody,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: PARTNER_UUID, status: 'active' });
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'active',
        stripeCustomerId: 'cus_x',
        paymentMethodAttachedAt: expect.any(Date),
      }),
    );
  });

  it('returns 400 when partner id is not a valid UUID', async () => {
    const res = await app.request('/internal/partners/not-a-uuid/activate', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-breeze-billing-secret': 'test-secret',
      },
      body: validBody,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_partner_id' });
  });

  it('returns 404 when partner does not exist', async () => {
    const MISSING_UUID = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
    queueUpdateReturning([]); // empty result = no row matched
    const res = await app.request(`/internal/partners/${MISSING_UUID}/activate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-breeze-billing-secret': 'test-secret',
      },
      body: validBody,
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'partner_not_found' });
  });
});
