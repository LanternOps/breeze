import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => ({
  listMock: vi.fn(),
  generateMock: vi.fn(),
  pdfMock: vi.fn(),
  csvMock: vi.fn(),
  reportsEnabled: false,
}));

vi.mock('../../services/portal/reportsSelfService', async (load) => {
  const actual = await load<
    typeof import('../../services/portal/reportsSelfService')
  >();
  return {
    ...actual,
    listPortalRuns: mocks.listMock,
    generatePortalReport: mocks.generateMock,
    renderRunPdf: mocks.pdfMock,
    renderRunCsv: mocks.csvMock,
  };
});

vi.mock('../../db', () => ({
  db: {
    select: vi.fn((selection: Record<string, unknown>) => ({
      from: vi.fn(() => ({
        where: vi.fn(() => {
          if ('enableReports' in selection) {
            return {
              limit: vi.fn(() =>
                Promise.resolve([{ enableReports: mocks.reportsEnabled }]),
              ),
            };
          }
          return Promise.resolve([]);
        }),
      })),
    })),
  },
  runOutsideDbContext: <T,>(fn: () => T): T => fn(),
  withSystemDbAccessContext: <T,>(fn: () => Promise<T>): Promise<T> => fn(),
  withDbAccessContext: <T,>(
    _context: unknown,
    fn: () => Promise<T>,
  ): Promise<T> => fn(),
}));

vi.mock('./auth', async () => {
  const { Hono } = await import('hono');
  return {
    authRoutes: new Hono(),
    portalAuthMiddleware: async (
      c: {
        req: { header(name: string): string | undefined };
        json(body: unknown, status: 401): Response;
        set(key: string, value: unknown): void;
      },
      next: () => Promise<void>,
    ) => {
      if (!c.req.header('Authorization')) {
        return c.json({ error: 'Authentication required' }, 401);
      }
      c.set('portalAuth', {
        user: {
          id: '22222222-2222-4222-8222-222222222222',
          orgId: '11111111-1111-4111-8111-111111111111',
          email: 'customer@example.test',
          name: 'Customer',
          contactId: null,
          receiveNotifications: true,
          status: 'active',
        },
        token: 'token',
        authMethod: 'bearer',
        timezone: 'UTC',
      });
      await next();
    },
  };
});

vi.mock('./helpers', async (load) => {
  const actual = await load<typeof import('./helpers')>();
  return {
    ...actual,
    validatePortalCookieCsrfRequest: vi.fn(() => null),
  };
});

import {
  PortalReportNoTabularDataError,
  PortalReportNotFoundError,
  PortalReportRateLimitError,
} from '../../services/portal/reportsSelfService';
import { validatePortalCookieCsrfRequest } from './helpers';
import { portalRoutes } from './index';
import { portalReportRoutes } from './reports';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const PORTAL_USER_ID = '22222222-2222-4222-8222-222222222222';
const RUN_ID = '33333333-3333-4333-8333-333333333333';

function isolatedApp() {
  const hono = new Hono();
  hono.use('*', async (c, next) => {
    c.set('portalAuth', {
      user: {
        id: PORTAL_USER_ID,
        orgId: ORG_ID,
        email: 'customer@example.test',
        name: 'Customer',
        contactId: null,
        receiveNotifications: true,
        status: 'active',
      },
      token: 'token',
      authMethod: 'bearer',
      timezone: 'UTC',
    });
    await next();
  });
  hono.route('/', portalReportRoutes);
  return hono;
}

describe('portal report routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.reportsEnabled = false;
  });

  it('lists only the service result for the session org with private caching', async () => {
    const payload = {
      data: [{ id: 'run-1', status: 'completed' }],
      pagination: { page: 1, limit: 20, total: 1 },
      timezone: 'UTC',
    };
    mocks.listMock.mockResolvedValue(payload);

    const response = await isolatedApp().request(
      '/reports/runs?page=1&limit=20',
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(payload);
    expect(response.headers.get('cache-control')).toContain(
      'private, max-age=30',
    );
    expect(response.headers.get('etag')).toMatch(/^W\//);
    expect(mocks.listMock).toHaveBeenCalledWith(
      ORG_ID,
      'UTC',
      { page: 1, limit: 20 },
    );
  });

  it('generates synchronously for the portal user', async () => {
    mocks.generateMock.mockResolvedValue({
      id: 'run-1',
      status: 'completed',
    });

    const response = await isolatedApp().request('/reports/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'executive_summary' }),
    });

    expect(response.status).toBe(201);
    expect(mocks.generateMock).toHaveBeenCalledWith({
      orgId: ORG_ID,
      portalUserId: PORTAL_USER_ID,
      type: 'executive_summary',
    });
  });

  it('returns 403 on CSRF failure without generating a report', async () => {
    vi.mocked(validatePortalCookieCsrfRequest).mockReturnValueOnce(
      'csrf token mismatch',
    );

    const response = await isolatedApp().request('/reports/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'executive_summary' }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'csrf token mismatch',
    });
    expect(mocks.generateMock).not.toHaveBeenCalled();
  });

  it('rejects non-portal report types without generating a report', async () => {
    const response = await isolatedApp().request('/reports/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'device_inventory' }),
    });

    expect(response.status).toBe(400);
    expect(mocks.generateMock).not.toHaveBeenCalled();
  });

  it('returns 404 when the canonical definition or run is absent', async () => {
    mocks.generateMock.mockRejectedValue(new PortalReportNotFoundError());
    const response = await isolatedApp().request('/reports/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'executive_summary' }),
    });
    expect(response.status).toBe(404);
  });

  it('returns 429 with Retry-After for either limiter', async () => {
    mocks.generateMock.mockRejectedValue(new PortalReportRateLimitError(47));
    const response = await isolatedApp().request('/reports/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'security_compliance_posture' }),
    });
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('47');
  });

  it('returns PDF bytes as an attachment', async () => {
    mocks.pdfMock.mockResolvedValue(Buffer.from('%PDF-test'));
    const response = await isolatedApp().request(
      `/reports/runs/${RUN_ID}/pdf`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/pdf');
    expect(response.headers.get('content-disposition')).toContain('attachment');
    expect(response.headers.get('cache-control')).toBe(
      'private, max-age=0, no-store',
    );
    expect(response.headers.get('vary')).toContain('Authorization');
    expect(response.headers.get('vary')).toContain('Cookie');
    expect(await response.text()).toBe('%PDF-test');
    expect(mocks.pdfMock).toHaveBeenCalledWith(RUN_ID, ORG_ID, 'UTC');
  });

  it('returns 404 when an artifact run is absent', async () => {
    mocks.pdfMock.mockRejectedValue(new PortalReportNotFoundError());
    const response = await isolatedApp().request(
      `/reports/runs/${RUN_ID}/pdf`,
    );
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: 'Report run not found',
    });
  });

  it('returns CSV text as an attachment', async () => {
    mocks.csvMock.mockResolvedValue('Device,Status\nLaptop,online\n');
    const response = await isolatedApp().request(
      `/reports/runs/${RUN_ID}/csv`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(
      'text/csv; charset=utf-8',
    );
    expect(response.headers.get('content-disposition')).toContain('attachment');
    expect(response.headers.get('cache-control')).toBe(
      'private, max-age=0, no-store',
    );
    expect(response.headers.get('vary')).toContain('Authorization');
    expect(response.headers.get('vary')).toContain('Cookie');
    expect(await response.text()).toBe('Device,Status\nLaptop,online\n');
    expect(mocks.csvMock).toHaveBeenCalledWith(RUN_ID, ORG_ID);
  });

  it.each([
    ['PDF', 'pdf', mocks.pdfMock],
    ['CSV', 'csv', mocks.csvMock],
  ] as const)('logs the thrown error when %s rendering fails', async (_label, format, renderMock) => {
    const error = new Error(`${format} render crashed`);
    renderMock.mockRejectedValue(error);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const response = await isolatedApp().request(
        `/reports/runs/${RUN_ID}/${format}`,
      );

      expect(response.status).toBe(500);
      expect(consoleError).toHaveBeenCalledWith(
        `[portal] ${format.toUpperCase()} report render failed`,
        { runId: RUN_ID, error },
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it('returns 422 when a completed run has no tabular data', async () => {
    mocks.csvMock.mockRejectedValue(new PortalReportNoTabularDataError());
    const response = await isolatedApp().request(
      `/reports/runs/${RUN_ID}/csv`,
    );
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: 'Report run has no tabular data to download',
    });
  });
});

describe('real portal router auth and enableReports gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.reportsEnabled = false;
  });

  it.each([
    ['GET', '/reports/runs'],
    ['POST', '/reports/generate'],
  ])('returns 401 for unauthenticated %s %s', async (method, path) => {
    const response = await portalRoutes.request(path, { method });
    expect(response.status).toBe(401);
    expect(mocks.listMock).not.toHaveBeenCalled();
    expect(mocks.generateMock).not.toHaveBeenCalled();
  });

  it.each([
    ['GET', '/reports/runs'],
    ['POST', '/reports/generate'],
  ])('returns 403 when enableReports is false for %s %s', async (method, path) => {
    const response = await portalRoutes.request(path, {
      method,
      headers: { Authorization: 'Bearer portal-token' },
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: 'PORTAL_REPORTS_DISABLED',
    });
    expect(mocks.listMock).not.toHaveBeenCalled();
    expect(mocks.generateMock).not.toHaveBeenCalled();
  });
});
