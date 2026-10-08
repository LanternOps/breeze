import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => ({
  overview: vi.fn(),
  detail: vi.fn(),
}));

vi.mock('../../services/portal/performanceReadModel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/portal/performanceReadModel')>();
  return {
    ...actual,
    performanceOverview: mocks.overview,
    performanceDeviceSeries: mocks.detail,
  };
});

import { portalPerformanceRoutes } from './performance';

const ORG = '11111111-1111-4111-8111-111111111111';
const DEVICE = '22222222-2222-4222-8222-222222222222';

function app() {
  const hono = new Hono();
  hono.use('*', async (c, next) => {
    c.set('portalAuth', {
      user: { id: 'pu', orgId: ORG, email: 'c@example.test', name: 'Customer', contactId: null, receiveNotifications: true, status: 'active' },
      token: 't', authMethod: 'bearer', timezone: 'UTC',
    });
    await next();
  });
  hono.route('/', portalPerformanceRoutes);
  return hono;
}

beforeEach(() => vi.clearAllMocks());

describe('portal performance handlers', () => {
  it('defaults overview to 24h and takes the org only from portalAuth', async () => {
    mocks.overview.mockResolvedValue({ asOf: '2026-10-07T12:00:00.000Z', dataStatus: 'ok' });
    const response = await app().request('/performance/overview?orgId=forged');
    expect(response.status).toBe(200);
    expect(mocks.overview).toHaveBeenCalledWith(ORG, '24h', expect.any(Date));
    expect(response.headers.get('cache-control')).toContain('private');
  });

  it.each(['24h', '7d', '30d'] as const)('accepts range=%s', async (range) => {
    mocks.overview.mockResolvedValue({ asOf: '2026-10-07T12:00:00.000Z', dataStatus: 'ok' });
    expect((await app().request(`/performance/overview?range=${range}`)).status).toBe(200);
    expect(mocks.overview).toHaveBeenCalledWith(ORG, range, expect.any(Date));
  });

  it('rejects an unsupported range', async () => {
    expect((await app().request('/performance/overview?range=90d')).status).toBe(400);
    expect(mocks.overview).not.toHaveBeenCalled();
  });

  it('returns 404 for a forged device id from another org', async () => {
    mocks.detail.mockResolvedValue(null);
    const response = await app().request(`/performance/devices/${DEVICE}?range=7d&orgId=forged`);
    expect(response.status).toBe(404);
    expect(mocks.detail).toHaveBeenCalledWith(ORG, DEVICE, '7d', expect.any(Date));
  });

  it('revalidates unchanged data when only asOf changes', async () => {
    mocks.overview
      .mockResolvedValueOnce({ asOf: '2026-10-07T12:00:00.000Z', range: '24h', dataStatus: 'ok' })
      .mockResolvedValueOnce({ asOf: '2026-10-07T12:00:01.000Z', range: '24h', dataStatus: 'ok' });
    const first = await app().request('/performance/overview');
    const second = await app().request('/performance/overview', {
      headers: { 'If-None-Match': first.headers.get('etag')! },
    });
    expect(second.status).toBe(304);
  });
});
