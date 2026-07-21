import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
  },
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db/schema', () => ({
  devices: {
    id: 'devices.id',
    agentId: 'devices.agentId',
    orgId: 'devices.orgId',
    siteId: 'devices.siteId',
    hostname: 'devices.hostname',
    osType: 'devices.osType',
    osVersion: 'devices.osVersion',
    agentVersion: 'devices.agentVersion',
    helperTokenHash: 'devices.helperTokenHash',
    previousHelperTokenHash: 'devices.previousHelperTokenHash',
    previousHelperTokenExpiresAt: 'devices.previousHelperTokenExpiresAt',
    status: 'devices.status',
  },
  organizations: {
    id: 'organizations.id',
    partnerId: 'organizations.partnerId',
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...args: unknown[]) => ({ eq: args })),
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  or: vi.fn((...args: unknown[]) => ({ or: args })),
}));

vi.mock('./agentAuth', () => ({
  matchAgentTokenHash: vi.fn(() => true),
}));

import { helperAuth } from './helperAuth';
import { db, withDbAccessContext } from '../db';
import { matchAgentTokenHash } from './agentAuth';

function mockDeviceRow(overrides: Record<string, unknown> = {}) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      innerJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{
            id: 'dev-1',
            agentId: 'agent-1',
            orgId: 'org-1',
            siteId: 'site-1',
            hostname: 'host-1',
            osType: 'linux',
            osVersion: '6.8',
            agentVersion: '1.0.0',
            helperTokenHash: 'hash',
            previousHelperTokenHash: null,
            previousHelperTokenExpiresAt: null,
            status: 'online',
            partnerId: 'partner-1',
            ...overrides,
          }]),
        }),
      }),
    }),
  } as never);
}

describe('helperAuth middleware', () => {
  const app = new Hono();
  app.use('*', helperAuth);
  app.get('/probe', (c) => {
    const device = c.get('helperDevice');
    const auth = c.get('auth');
    return c.json({
      deviceId: device.id,
      orgId: auth.orgId,
      helperDeviceId: auth.helperDeviceId,
      scope: auth.scope,
    });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(matchAgentTokenHash).mockReturnValue(true as never);
  });

  it('rejects a missing bearer token', async () => {
    const res = await app.request('/probe');
    expect(res.status).toBe(401);
  });

  it('rejects a non-brz token', async () => {
    const res = await app.request('/probe', { headers: { Authorization: 'Bearer eyJhbGciOi' } });
    expect(res.status).toBe(401);
  });

  it('rejects a token that matches no device', async () => {
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
    } as never);

    const res = await app.request('/probe', { headers: { Authorization: 'Bearer brz_' + 'a'.repeat(64) } });
    expect(res.status).toBe(401);
  });

  it('rejects when the token hash does not match', async () => {
    mockDeviceRow();
    vi.mocked(matchAgentTokenHash).mockReturnValue(null as never);

    const res = await app.request('/probe', { headers: { Authorization: 'Bearer brz_' + 'a'.repeat(64) } });
    expect(res.status).toBe(401);
  });

  it('sets helperDevice and synthetic org auth for a valid token', async () => {
    mockDeviceRow();

    const res = await app.request('/probe', { headers: { Authorization: 'Bearer brz_' + 'a'.repeat(64) } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      deviceId: 'dev-1',
      orgId: 'org-1',
      helperDeviceId: 'dev-1',
      scope: 'organization',
    });
    expect(withDbAccessContext).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: 'organization',
        orgId: 'org-1',
        accessibleOrgIds: ['org-1'],
      }),
      expect.any(Function),
    );
  });

  it('rejects decommissioned devices with 403', async () => {
    mockDeviceRow({ status: 'decommissioned' });

    const res = await app.request('/probe', { headers: { Authorization: 'Bearer brz_' + 'a'.repeat(64) } });
    expect(res.status).toBe(403);
  });

  it('rejects quarantined devices with 403', async () => {
    mockDeviceRow({ status: 'quarantined' });

    const res = await app.request('/probe', { headers: { Authorization: 'Bearer brz_' + 'a'.repeat(64) } });
    expect(res.status).toBe(403);
  });
});
