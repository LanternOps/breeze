import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { forOrgMock } = vi.hoisted(() => ({ forOrgMock: vi.fn() }));
vi.mock('../../services/portal/hourBlock', () => ({ portalHourBlockForOrg: forOrgMock }));

import { portalHourBlockRoutes } from './hourBlock';

const SESSION_ORG = '22222222-2222-4222-8222-222222222222';
const OTHER_ORG = '99999999-9999-4999-8999-999999999999';

function buildApp() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('portalAuth', {
      user: {
        id: 'pu-1', orgId: SESSION_ORG, email: 'c@example.test', name: 'Cust',
        contactId: null, receiveNotifications: true, status: 'active',
      },
      token: 't',
      authMethod: 'bearer',
      timezone: 'UTC',
    });
    await next();
  });
  app.route('/', portalHourBlockRoutes);
  return app;
}

const dto = {
  periodStart: '2026-12-01', periodEnd: '2027-01-01', includedHours: 10, carriedInHours: 0,
  usedHours: 4, remainingHours: 6, overageHours: 0, overageRate: '150.00',
  currencyCode: 'USD', billingTiming: 'arrears',
};
const response = { hourBlock: dto, startsOn: null };

describe('GET /support-usage/hour-block', () => {
  beforeEach(() => vi.clearAllMocks());

  it('ignores every org selector on the request — only the session org is read', async () => {
    forOrgMock.mockResolvedValue(response);

    const res = await buildApp().request(
      `/support-usage/hour-block?orgId=${OTHER_ORG}&org_id=${OTHER_ORG}`,
      { headers: { 'X-Org-Id': OTHER_ORG } },
    );

    expect(res.status).toBe(200);
    expect(forOrgMock).toHaveBeenCalledTimes(1);
    expect(forOrgMock).toHaveBeenCalledWith({ orgId: SESSION_ORG });
  });

  it('wraps the DTO in an envelope and answers null (not 404), carrying startsOn when the block has not started', async () => {
    forOrgMock.mockResolvedValueOnce(response).mockResolvedValueOnce({ hourBlock: null, startsOn: '2026-12-01' });

    const withBlock = await buildApp().request('/support-usage/hour-block');
    expect(await withBlock.json()).toEqual(response);

    const without = await buildApp().request('/support-usage/hour-block');
    expect(without.status).toBe(200);
    expect(await without.json()).toEqual({ hourBlock: null, startsOn: '2026-12-01' });
  });

  it('is privately cached per viewer and honours If-None-Match', async () => {
    forOrgMock.mockResolvedValue(response);

    const first = await buildApp().request('/support-usage/hour-block');
    expect(first.headers.get('Cache-Control')).toContain('private');
    expect(first.headers.get('Vary')).toContain('Authorization');
    const etag = first.headers.get('ETag');
    expect(etag).toBeTruthy();

    const second = await buildApp().request('/support-usage/hour-block', {
      headers: { 'If-None-Match': etag! },
    });
    expect(second.status).toBe(304);
  });
});
