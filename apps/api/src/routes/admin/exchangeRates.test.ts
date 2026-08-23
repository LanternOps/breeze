/**
 * Platform-admin manual exchange-rate API (multi-currency wave 7, #3779).
 *
 * `exchange_rates` has NO tenant axis, so a partner-scoped write would be a
 * cross-tenant mutation (partner A's override moves partner B's dashboard).
 * These tests pin the posture: platform-admin for every verb, MFA on the
 * mutating ones, and provenance that a caller can never choose.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { listMock, setMock, deleteMock } = vi.hoisted(() => ({
  listMock: vi.fn(),
  setMock: vi.fn(),
  deleteMock: vi.fn(),
}));

// Keep the REAL ExchangeRateServiceError class (the route maps it) and the
// real assertIsoDate; mock only the three data functions.
vi.mock('../../services/exchangeRateService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/exchangeRateService')>()),
  listExchangeRates: listMock,
  setManualRate: setMock,
  deleteManualRate: deleteMock,
}));

vi.mock('../../services/auditService', () => ({
  createAuditLog: vi.fn(async () => undefined),
  createAuditLogAsync: vi.fn(async () => undefined),
}));

vi.mock('../../services/clientIp', () => ({
  getTrustedClientIpOrUndefined: vi.fn(() => '127.0.0.1'),
}));

// authMiddleware is stubbed to mirror real behavior: 401 when the request
// carries no auth context, pass-through otherwise. requireMfa keeps the real
// 401/403 split.
vi.mock('../../middleware/auth', async () => {
  const actual = await vi.importActual<typeof import('../../middleware/auth')>('../../middleware/auth');
  const { HTTPException } = await import('hono/http-exception');
  return {
    ...actual,
    authMiddleware: vi.fn(async (c: any, next: () => Promise<void>) => {
      if (!c.get('auth')) throw new HTTPException(401, { message: 'Not authenticated' });
      await next();
    }),
  };
});

import { Hono } from 'hono';
import { adminRoutes } from './index';
import { ExchangeRateServiceError } from '../../services/exchangeRateService';

type FakeAuth = {
  user: { id: string; email: string; name: string; isPlatformAdmin: boolean };
  token: { mfa: boolean };
};

const platformAdmin: FakeAuth = {
  user: { id: 'admin-1', email: 'admin@breeze.test', name: 'PA', isPlatformAdmin: true },
  token: { mfa: true },
};
const platformAdminNoMfa: FakeAuth = { ...platformAdmin, token: { mfa: false } };
const partnerAdmin: FakeAuth = {
  user: { id: 'pa-1', email: 'partner@x.com', name: 'Partner', isPlatformAdmin: false },
  token: { mfa: true },
};

function buildApp(auth: FakeAuth | null) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (auth) c.set('auth', auth as never);
    await next();
  });
  app.route('/admin', adminRoutes);
  return app;
}

const KEY = '2026-09-03/EUR/USD';
const RECORD = {
  rateDate: '2026-09-03',
  baseCode: 'EUR',
  quoteCode: 'USD',
  rate: '1.09000000',
  source: 'manual' as const,
  fetchedAt: new Date('2026-09-03T00:00:00Z'),
};

function put(app: Hono, key: string, body: unknown) {
  return app.request(`/admin/exchange-rates/${key}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('admin exchange-rate routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listMock.mockResolvedValue([RECORD]);
    setMock.mockResolvedValue(RECORD);
    deleteMock.mockResolvedValue(true);
  });

  describe('authorization', () => {
    it('401s an unauthenticated GET', async () => {
      const res = await buildApp(null).request('/admin/exchange-rates');
      expect(res.status).toBe(401);
      expect(listMock).not.toHaveBeenCalled();
    });

    it('403s a non-platform-admin GET at platformAdminMiddleware', async () => {
      const res = await buildApp(partnerAdmin).request('/admin/exchange-rates');
      expect(res.status).toBe(403);
      expect(await res.text()).toContain('platform admin');
      expect(listMock).not.toHaveBeenCalled();
    });

    it('403s a non-platform-admin PUT', async () => {
      const res = await put(buildApp(partnerAdmin), KEY, { rate: '1.09' });
      expect(res.status).toBe(403);
      expect(setMock).not.toHaveBeenCalled();
    });

    it('403s a PUT from a platform admin who has not satisfied MFA', async () => {
      const res = await put(buildApp(platformAdminNoMfa), KEY, { rate: '1.09' });
      expect(res.status).toBe(403);
      expect((await res.json() as any).code).toBe('MFA_REQUIRED');
      expect(setMock).not.toHaveBeenCalled();
    });

    it('403s a DELETE from a platform admin who has not satisfied MFA', async () => {
      const res = await buildApp(platformAdminNoMfa).request(`/admin/exchange-rates/${KEY}`, { method: 'DELETE' });
      expect(res.status).toBe(403);
      expect(deleteMock).not.toHaveBeenCalled();
    });

    it('does NOT require MFA to read', async () => {
      const res = await buildApp({ ...platformAdmin, token: { mfa: false } }).request('/admin/exchange-rates');
      expect(res.status).toBe(200);
    });
  });

  describe('GET /admin/exchange-rates', () => {
    it('returns the service rows and forwards validated filters', async () => {
      const res = await buildApp(platformAdmin).request(
        '/admin/exchange-rates?baseCode=eur&quoteCode=usd&source=manual&onOrBefore=2026-09-03&limit=5',
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        data: [{ ...RECORD, fetchedAt: RECORD.fetchedAt.toISOString() }],
      });
      expect(listMock).toHaveBeenCalledWith({
        baseCode: 'EUR',
        quoteCode: 'USD',
        source: 'manual',
        onOrBefore: '2026-09-03',
        limit: 5,
      });
    });

    it('400s an unknown query key (strict schema)', async () => {
      const res = await buildApp(platformAdmin).request('/admin/exchange-rates?soruce=manual');
      expect(res.status).toBe(400);
      expect(listMock).not.toHaveBeenCalled();
    });

    it('400s a limit above the ceiling', async () => {
      const res = await buildApp(platformAdmin).request('/admin/exchange-rates?limit=501');
      expect(res.status).toBe(400);
      expect(listMock).not.toHaveBeenCalled();
    });
  });

  describe('PUT /admin/exchange-rates/:rateDate/:baseCode/:quoteCode', () => {
    it('stores the rate and returns the persisted record', async () => {
      const res = await put(buildApp(platformAdmin), KEY, { rate: '1.09' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ data: { ...RECORD, fetchedAt: RECORD.fetchedAt.toISOString() } });
      expect(setMock).toHaveBeenCalledWith({
        rateDate: '2026-09-03',
        baseCode: 'EUR',
        quoteCode: 'USD',
        rate: '1.09',
      });
    });

    it('never lets the caller choose provenance — a body carrying `source` is a 400 and the service is not called', async () => {
      const res = await put(buildApp(platformAdmin), KEY, { rate: '1.09', source: 'ecb' });
      expect(res.status).toBe(400);
      expect(setMock).toHaveBeenCalledTimes(0);
    });

    it.each([
      ['9 decimal places', '1.123456789'],
      ['zero', '0'],
      ['negative', '-1'],
      ['empty', ''],
      ['not a number', 'abc'],
      // numeric(18,8) overflow would escape mapServiceError as a 500.
      ['11 integer digits', '12345678901.5'],
    ])('400s INVALID_RATE for %s', async (_label, rate) => {
      const res = await put(buildApp(platformAdmin), KEY, { rate });
      expect(res.status).toBe(400);
      expect((await res.json() as any).error.code).toBe('INVALID_RATE');
      expect(setMock).not.toHaveBeenCalled();
    });

    it('400s INVALID_RATE for a numeric (non-string) rate', async () => {
      const res = await put(buildApp(platformAdmin), KEY, { rate: 1.09 });
      expect(res.status).toBe(400);
      expect(setMock).not.toHaveBeenCalled();
    });

    it('400s INVALID_DATE for a malformed rateDate before reaching the service', async () => {
      const res = await put(buildApp(platformAdmin), '03-09-2026/EUR/USD', { rate: '1.09' });
      expect(res.status).toBe(400);
      expect((await res.json() as any).error.code).toBe('INVALID_DATE');
      expect(setMock).not.toHaveBeenCalled();
    });

    it('400s INVALID_DATE for a non-existent calendar date, mapped from the service', async () => {
      setMock.mockRejectedValue(
        new ExchangeRateServiceError(400, 'INVALID_DATE', '"2026-02-30" is not a real calendar date'),
      );
      const res = await put(buildApp(platformAdmin), '2026-02-30/EUR/USD', { rate: '1.09' });
      expect(res.status).toBe(400);
      expect((await res.json() as any).error).toEqual({
        code: 'INVALID_DATE',
        message: '"2026-02-30" is not a real calendar date',
      });
      expect(setMock).toHaveBeenCalledTimes(1);
    });

    it('400s UNSUPPORTED_BASE for a non-EUR base, mapped from the service', async () => {
      setMock.mockRejectedValue(
        new ExchangeRateServiceError(400, 'UNSUPPORTED_BASE', 'Only EUR-based rates are stored'),
      );
      const res = await put(buildApp(platformAdmin), '2026-09-03/USD/GBP', { rate: '1.09' });
      expect(res.status).toBe(400);
      expect((await res.json() as any).error).toEqual({
        code: 'UNSUPPORTED_BASE',
        message: 'Only EUR-based rates are stored',
      });
    });

    it('400s INVALID_CURRENCY when base and quote are the same', async () => {
      const res = await put(buildApp(platformAdmin), '2026-09-03/EUR/EUR', { rate: '1.09' });
      expect(res.status).toBe(400);
      expect((await res.json() as any).error.code).toBe('INVALID_CURRENCY');
      expect(setMock).not.toHaveBeenCalled();
    });

    it('400s INVALID_CURRENCY for an unsupported currency code', async () => {
      const res = await put(buildApp(platformAdmin), '2026-09-03/EUR/XXY', { rate: '1.09' });
      expect(res.status).toBe(400);
      expect((await res.json() as any).error.code).toBe('INVALID_CURRENCY');
      expect(setMock).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /admin/exchange-rates/:rateDate/:baseCode/:quoteCode', () => {
    it('204s when a manual cell was removed', async () => {
      const res = await buildApp(platformAdmin).request(`/admin/exchange-rates/${KEY}`, { method: 'DELETE' });
      expect(res.status).toBe(204);
      expect(deleteMock).toHaveBeenCalledWith({ rateDate: '2026-09-03', baseCode: 'EUR', quoteCode: 'USD' });
    });

    it('404s when the cell is absent or is not a manual override', async () => {
      deleteMock.mockResolvedValue(false);
      const res = await buildApp(platformAdmin).request(`/admin/exchange-rates/${KEY}`, { method: 'DELETE' });
      expect(res.status).toBe(404);
      expect((await res.json() as any).error.code).toBe('NOT_FOUND');
    });

    it('maps a service error', async () => {
      deleteMock.mockRejectedValue(
        new ExchangeRateServiceError(400, 'UNSUPPORTED_BASE', 'Only EUR-based rates are stored'),
      );
      const res = await buildApp(platformAdmin).request('/admin/exchange-rates/2026-09-03/USD/GBP', { method: 'DELETE' });
      expect(res.status).toBe(400);
      expect((await res.json() as any).error.code).toBe('UNSUPPORTED_BASE');
    });
  });
});
