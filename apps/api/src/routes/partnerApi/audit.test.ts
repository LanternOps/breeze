import { Hono, type Handler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  writeAuditEventAsync: vi.fn(),
}));

vi.mock('../../services/auditEvents', () => ({
  requestLikeFromSnapshot: vi.fn(() => ({ req: { header: () => undefined } })),
  writeAuditEventAsync: mocks.writeAuditEventAsync,
}));

import {
  __testOnly,
  partnerExportAuditMiddleware,
  type PartnerExportAuditPrincipal,
} from './audit';
import { PARTNER_EXPORT_RESOURCES, type PartnerExportResource } from './schemas';

const SERVICE_PRINCIPAL_ID = '11111111-1111-4111-8111-111111111111';
const KEY_ID = '22222222-2222-4222-8222-222222222222';
const PARTNER_ID = '33333333-3333-4333-8333-333333333333';
const RECORD_ID = '44444444-4444-4444-8444-444444444444';
const ORG_ID = '55555555-5555-4555-8555-555555555555';

const principal: PartnerExportAuditPrincipal = {
  partnerServicePrincipalId: SERVICE_PRINCIPAL_ID,
  keyId: KEY_ID,
  partnerId: PARTNER_ID,
};

function envelope(data: unknown[] = []) {
  return {
    schemaVersion: '1',
    snapshotAt: '2026-07-14T12:00:00.000Z',
    data,
    nextCursor: null,
    hasMore: false,
  };
}

function createApp(
  resource: PartnerExportResource,
  handler: Handler,
  options: { authenticated?: boolean } = {},
) {
  const app = new Hono();
  app.use('*', partnerExportAuditMiddleware);
  app.use('*', async (c, next) => {
    if (options.authenticated !== false) c.set('partnerApiPrincipal', principal as never);
    await next();
  });
  app.get(`/api/v1/partner-api/${resource}`, handler);
  return app;
}

function auditedEvent() {
  expect(mocks.writeAuditEventAsync).toHaveBeenCalledTimes(1);
  return mocks.writeAuditEventAsync.mock.calls[0]![1] as Record<string, unknown>;
}

describe('partner export audit middleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.writeAuditEventAsync.mockResolvedValue(undefined);
  });

  it.each([
    '/api/v1/partner-api/foo/partner-api/sites',
    '/api/v1/partner-api//sites',
    '/api/v1/partner-api/%2Fsites',
    '/api/v1/partner-api/%2e/sites',
    '/partner-api/sites',
  ])('does not classify a spoofed raw pathname as canonical: %s', (path) => {
    expect(__testOnly.routeResource(path)).toBeNull();
  });

  it.each(PARTNER_EXPORT_RESOURCES)('audits one bounded success event for %s', async (resource) => {
    const app = createApp(resource, (c) => c.json(envelope([
      { id: RECORD_ID, orgId: ORG_ID, cursor: 'must-not-enter-audit' },
      { id: KEY_ID, orgId: ORG_ID, definition: { password: 'must-not-enter-audit' } },
    ])));

    const response = await app.request(`/api/v1/partner-api/${resource}?cursor=raw-cursor`, {
      headers: {
        'X-API-Key': 'brz_sp_plaintext-must-not-enter-audit',
        'user-agent': 'secret-bearing-client',
      },
    });

    expect(response.status).toBe(200);
    const event = auditedEvent();
    expect(event).toMatchObject({
      orgId: null,
      actorType: 'api_key',
      actorId: KEY_ID,
      action: 'partner_api.export',
      resourceType: 'partner_export',
      resourceId: SERVICE_PRINCIPAL_ID,
      result: 'success',
      details: {
        partnerServicePrincipalId: SERVICE_PRINCIPAL_ID,
        keyId: KEY_ID,
        partnerId: PARTNER_ID,
        route: `GET /api/v1/partner-api/${resource}`,
        resource,
        result: 'success',
        schemaVersion: '1',
        recordCount: 2,
        httpStatus: 200,
        durationMs: expect.any(Number),
      },
    });
    expect(Object.keys(event.details as object).sort()).toEqual([
      'durationMs',
      'httpStatus',
      'keyId',
      'partnerId',
      'partnerServicePrincipalId',
      'recordCount',
      'resource',
      'result',
      'route',
      'schemaVersion',
    ]);

    const serialized = JSON.stringify(mocks.writeAuditEventAsync.mock.calls);
    expect(serialized).not.toMatch(/brz_sp_plaintext|raw-cursor|must-not-enter-audit|password|definition|stack|secret-bearing-client/u);
  });

  it('returns a stable auth error and does not invent an audit identity', async () => {
    const app = createApp('organizations', () => {
      throw new HTTPException(401, { message: 'Partner API authentication required' });
    }, { authenticated: false });

    const response = await app.request('/api/v1/partner-api/organizations');

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: 'Partner API authentication required',
      code: 'partner_api_auth_required',
    });
    expect(mocks.writeAuditEventAsync).not.toHaveBeenCalled();
  });

  it.each([
    [
      'Invalid partner API credentials',
      'Invalid partner API credentials',
      'partner_api_invalid_credentials',
    ],
    [
      'Too many API key authentication attempts',
      'Too many API key authentication attempts',
      'partner_api_auth_rate_limited',
    ],
  ] as const)('preserves bounded pre-route auth semantics for %s', async (message, error, code) => {
    const status = message.startsWith('Too many') ? 429 : 401;
    const app = createApp('organizations', () => {
      throw new HTTPException(status, { message });
    }, { authenticated: false });

    const response = await app.request('/api/v1/partner-api/organizations');

    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error, code });
    expect(mocks.writeAuditEventAsync).not.toHaveBeenCalled();
  });

  it('audits scope denial once with no rejected values', async () => {
    const app = createApp('devices', () => {
      throw new HTTPException(403, { message: 'Partner API scope required' });
    });

    const response = await app.request('/api/v1/partner-api/devices');

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: 'Partner API scope required',
      code: 'partner_api_scope_required',
    });
    expect(auditedEvent()).toMatchObject({
      result: 'denied',
      details: { resource: 'devices', result: 'denied', recordCount: 0, httpStatus: 403 },
    });
  });

  it('audits an explicit validation response without replacing it', async () => {
    const app = createApp('sites', (c) => c.json({
      error: 'Invalid partner export query.',
      code: 'invalid_partner_export_query',
    }, 400));

    const response = await app.request('/api/v1/partner-api/sites?orgId=rejected-secret');

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Invalid partner export query.',
      code: 'invalid_partner_export_query',
    });
    expect(auditedEvent()).toMatchObject({
      result: 'failure',
      details: { resource: 'sites', result: 'failure', recordCount: 0, httpStatus: 400 },
    });
    expect(JSON.stringify(mocks.writeAuditEventAsync.mock.calls)).not.toContain('rejected-secret');
  });

  it('audits a rate-limit denial with the authenticated IDs', async () => {
    const app = createApp('device-inventory', () => {
      throw new HTTPException(429, { message: 'Partner API rate limit exceeded' });
    });

    const response = await app.request('/api/v1/partner-api/device-inventory');

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({
      error: 'Partner API rate limit exceeded',
      code: 'partner_api_rate_limited',
    });
    expect(auditedEvent()).toMatchObject({
      result: 'denied',
      details: { resource: 'device-inventory', result: 'denied', httpStatus: 429 },
    });
  });

  it('bounds unexpected failures to a stable public error with no stack or message leakage', async () => {
    const app = createApp('custom-field-values', () => {
      throw new Error('database password=do-not-leak');
    });

    const response = await app.request('/api/v1/partner-api/custom-field-values');

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: 'Partner export request failed.',
      code: 'partner_export_failed',
    });
    const event = auditedEvent();
    expect(event).toMatchObject({
      result: 'failure',
      details: { resource: 'custom-field-values', result: 'failure', httpStatus: 500 },
    });
    expect(JSON.stringify(event)).not.toMatch(/database password|do-not-leak|stack/u);
  });

  it('preserves the completed response when the audit write rejects', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.writeAuditEventAsync.mockRejectedValueOnce(new Error('audit writer secret'));
    const app = createApp('scripts', (c) => c.json(envelope([])));

    try {
      const response = await app.request('/api/v1/partner-api/scripts');

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(envelope([]));
      expect(mocks.writeAuditEventAsync).toHaveBeenCalledTimes(1);
      expect(consoleError).toHaveBeenCalledWith('Failed to write partner export audit');
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain('audit writer secret');
    } finally {
      consoleError.mockRestore();
    }
  });
});
