import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('../../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn() },
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', { user: { id: 'user-1' }, scope: 'organization', orgId: 'org-1', canAccessOrg: () => true });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn((resource: string, action: string) => async (c: any, next: any) => {
    if (resource === 'devices' && action === 'read' && c.req.header('x-deny') === '1') {
      return c.json({ error: 'Permission denied' }, 403);
    }
    return next();
  }),
}));

vi.mock('./helpers', () => ({
  getDeviceWithOrgAndSiteCheck: vi.fn(),
  SITE_ACCESS_DENIED: Symbol('SITE_ACCESS_DENIED'),
}));

import { db, withSystemDbAccessContext } from '../../db';
import { getDeviceWithOrgAndSiteCheck, SITE_ACCESS_DENIED } from './helpers';
import { deviceRestorePointAttemptsRoutes, encodeBefore } from './restorePoints';

const DEVICE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const URL_BASE = `/devices/${DEVICE_ID}/restore-point-attempts`;

function row(over: Record<string, unknown> = {}) {
  return {
    requestId: '11111111-1111-4111-8111-111111111111',
    orgId: 'org-1',
    deviceId: DEVICE_ID,
    deviceCommandId: 'cmd-secret',
    trigger: 'script',
    status: 'requested',
    policyRevision: 'rev-1',
    requestedAt: new Date('2026-09-02T14:00:00.000Z'),
    cursorTs: '2026-09-02T14:00:00.123456Z',
    attemptedAt: null,
    receivedAt: null,
    sequenceNumber: null,
    description: null,
    message: null,
    acceptedExistingPoint: false,
    existingPointAgeMinutes: null,
    frequencyMinutes: null,
    durationMs: null,
    scriptExecutionId: null,
    softwareDeploymentId: null,
    patchJobId: null,
    ...over,
  };
}

/** Mocks db.select().from().where().orderBy().limit(n) and returns the limit spy. */
function mockRows(rows: unknown[]) {
  const limit = vi.fn().mockResolvedValue(rows);
  vi.mocked(db.select).mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ orderBy: vi.fn().mockReturnValue({ limit }) }),
    }),
  } as never);
  return limit;
}

describe('GET /devices/:id/restore-point-attempts', () => {
  let app: Hono;
  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/devices', deviceRestorePointAttemptsRoutes);
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue({ id: DEVICE_ID, orgId: 'org-1' } as never);
  });

  it('returns attempts in the order the query yields (newest first) as DTOs', async () => {
    mockRows([
      row({ requestId: '22222222-2222-4222-8222-222222222222', status: 'created', trigger: 'patch' }),
      row(),
    ]);
    const res = await app.request(URL_BASE);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.attempts.map((a: any) => a.requestId)).toEqual([
      '22222222-2222-4222-8222-222222222222',
      '11111111-1111-4111-8111-111111111111',
    ]);
    expect(body.attempts[0]).toMatchObject({ trigger: 'patch', status: 'created', policyRevision: 'rev-1' });
    expect(body.nextBefore).toBeUndefined();
  });

  it('does not expose deviceCommandId, orgId or the cursor timestamp', async () => {
    mockRows([row()]);
    const body = await (await app.request(URL_BASE)).json();
    const keys = Object.keys(body.attempts[0]);
    expect(keys).not.toContain('deviceCommandId');
    expect(keys).not.toContain('orgId');
    expect(keys).not.toContain('cursorTs');
    expect(JSON.stringify(body)).not.toContain('cmd-secret');
  });

  it('renders sequenceNumber as a string, never a number', async () => {
    mockRows([row({ sequenceNumber: 9223372036854775807n })]);
    const res = await app.request(URL_BASE);
    expect(res.status).toBe(200); // a bigint through JSON.stringify would throw
    const body = await res.json();
    expect(body.attempts[0].sequenceNumber).toBe('9223372036854775807');
  });

  it('keeps a null sequenceNumber null', async () => {
    mockRows([row()]);
    const body = await (await app.request(URL_BASE)).json();
    expect(body.attempts[0].sequenceNumber).toBeNull();
  });

  it('returns a stray requested row as-is (status requested)', async () => {
    mockRows([row({ status: 'requested', receivedAt: null })]);
    const body = await (await app.request(URL_BASE)).json();
    expect(body.attempts[0].status).toBe('requested');
    expect(body.attempts[0].receivedAt).toBeNull();
  });

  it('defaults to 50 and caps at 200 (fetching one extra row to detect another page)', async () => {
    let limit = mockRows([]);
    await app.request(URL_BASE);
    expect(limit).toHaveBeenCalledWith(51);
    limit = mockRows([]);
    await app.request(`${URL_BASE}?limit=10000`);
    expect(limit).toHaveBeenCalledWith(201);
  });

  it('emits nextBefore only when more rows exist, and drops the probe row', async () => {
    mockRows([
      row({ requestId: '33333333-3333-4333-8333-333333333333', cursorTs: '2026-09-02T14:00:00.000003Z' }),
      row({ requestId: '22222222-2222-4222-8222-222222222222', cursorTs: '2026-09-02T14:00:00.000002Z' }),
      row({ requestId: '11111111-1111-4111-8111-111111111111', cursorTs: '2026-09-02T14:00:00.000001Z' }),
    ]);
    const body = await (await app.request(`${URL_BASE}?limit=2`)).json();
    expect(body.attempts).toHaveLength(2);
    expect(body.nextBefore).toBe(
      encodeBefore('2026-09-02T14:00:00.000002Z', '22222222-2222-4222-8222-222222222222'),
    );
  });

  it.each([
    ['limit=abc'],
    ['limit=0'],
    ['limit=-5'],
    ['limit=1.5'],
    ['before=not-a-cursor'],
    ['before=' + Buffer.from('{"t":"nope","id":"x"}').toString('base64url')],
    ['before=' + encodeBefore('2026-09-02T14:00:00Z', 'not-a-uuid')],
  ])('rejects malformed paging (%s) with 400, not 500', async (qs) => {
    mockRows([]);
    const res = await app.request(`${URL_BASE}?${qs}`);
    expect(res.status).toBe(400);
  });

  it('accepts a well-formed before cursor', async () => {
    mockRows([]);
    const before = encodeBefore('2026-09-02T14:00:00.123456Z', '11111111-1111-4111-8111-111111111111');
    expect((await app.request(`${URL_BASE}?before=${before}`)).status).toBe(200);
  });

  it('returns 404 (not an empty list) for a device the caller cannot see', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(null as never);
    const res = await app.request(URL_BASE);
    expect(res.status).toBe(404);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('returns 403 when the site allowlist excludes the device', async () => {
    vi.mocked(getDeviceWithOrgAndSiteCheck).mockResolvedValue(SITE_ACCESS_DENIED as never);
    expect((await app.request(URL_BASE)).status).toBe(403);
  });

  it('requires devices:read', async () => {
    mockRows([]);
    const res = await app.request(URL_BASE, { headers: { 'x-deny': '1' } });
    expect(res.status).toBe(403);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('reads on the request path, never through a system DB context', async () => {
    mockRows([row()]);
    await app.request(URL_BASE);
    expect(withSystemDbAccessContext).not.toHaveBeenCalled();
  });
});
