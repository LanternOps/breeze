import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const ORG_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OTHER_ORG = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const HISTORY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const m = vi.hoisted(() => ({
  list: vi.fn(),
  check: vi.fn(),
  attest: vi.fn(),
  rateLimiter: vi.fn(),
  audit: vi.fn(),
  withAuthCtx: vi.fn(),
  canMutate: vi.fn(() => true),
}));

vi.mock('../../services/backupStorageCredentialHistory', () => ({
  listOutstandingCredentials: m.list,
  checkReplacedCredential: m.check,
  attestCredentialDisabled: m.attest,
}));
vi.mock('../../services/rate-limit', () => ({ rateLimiter: m.rateLimiter }));
vi.mock('../../services/redis', () => ({ getRedis: vi.fn(() => ({})) }));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: m.audit }));
vi.mock('../../services/siteCeilingAccess', () => ({
  canMutateOrgWideGovernance: m.canMutate,
  SITE_CEILING_WRITE_DENIED_MESSAGE: 'site ceiling',
}));
vi.mock('../../middleware/auth', () => ({
  requirePermission: vi.fn(() => (_c: unknown, next: () => Promise<void>) => next()),
  requireScope: vi.fn(() => (_c: unknown, next: () => Promise<void>) => next()),
  requireMfa: vi.fn(() => (_c: unknown, next: () => Promise<void>) => next()),
  withAuthDbAccessContext: m.withAuthCtx,
}));

import { storageCredentialRoutes } from './storageCredentials';

function app() {
  const a = new Hono();
  a.use('*', async (c, next) => {
    c.set('auth', {
      user: { id: 'user-1' },
      scope: 'organization',
      orgId: ORG_ID,
      accessibleOrgIds: [ORG_ID],
      canAccessOrg: (id: string) => id === ORG_ID,
    } as never);
    await next();
  });
  a.route('/backup', storageCredentialRoutes);
  return a;
}

beforeEach(() => {
  vi.clearAllMocks();
  m.rateLimiter.mockResolvedValue({ allowed: true, remaining: 9, resetAt: new Date(Date.now() + 60_000) });
  m.withAuthCtx.mockImplementation(async (_auth: unknown, fn: () => Promise<unknown>) => fn());
  m.canMutate.mockReturnValue(true);
});

describe('GET /backup/storage-credentials', () => {
  it('lists the organization\'s keys that still need replacing or disabling', async () => {
    m.list.mockResolvedValue([{
      id: HISTORY_ID,
      configId: 'cfg-1',
      configName: 'Primary',
      storageIdentity: 's3::storage.example::backups',
      broadcastUntil: new Date('2026-12-01T00:00:00Z'),
      supersededAt: new Date('2026-12-02T00:00:00Z'),
      canCheck: true,
      lastProbeAt: null,
      lastProbeOutcome: null,
    }]);
    const res = await app().request('/backup/storage-credentials');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(m.list).toHaveBeenCalledWith(ORG_ID);
    expect(body.data).toEqual([{
      id: HISTORY_ID,
      configId: 'cfg-1',
      configName: 'Primary',
      bucket: 'backups',
      endpoint: 'storage.example',
      usedBefore: '2026-12-01T00:00:00.000Z',
      replacedAt: '2026-12-02T00:00:00.000Z',
      canCheck: true,
      lastCheckedAt: null,
      lastCheckOutcome: null,
    }]);
  });

  it('refuses an organization the caller cannot access', async () => {
    const res = await app().request(`/backup/storage-credentials?orgId=${OTHER_ORG}`);
    expect(res.status).toBe(400);
    expect(m.list).not.toHaveBeenCalled();
  });
});

describe('POST /backup/storage-credentials/:id/check', () => {
  const check = () => app().request(`/backup/storage-credentials/${HISTORY_ID}/check`, { method: 'POST' });

  it.each([
    [{ status: 'revoked', code: 'InvalidAccessKeyId' }, 200, 'revoked'],
    [{ status: 'still_live' }, 200, 'still_live'],
    [{ status: 'inconclusive', code: 'ECONNREFUSED' }, 200, 'inconclusive'],
  ])('answers the check outcome (%o)', async (result, status, outcome) => {
    m.check.mockResolvedValue(result);
    const res = await check();
    expect(res.status).toBe(status);
    const body = await res.json();
    expect(body.outcome).toBe(outcome);
    expect(typeof body.message).toBe('string');
    expect(m.check).toHaveBeenCalledWith(expect.objectContaining({ historyId: HISTORY_ID, orgId: ORG_ID, userId: 'user-1' }));
    expect(m.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      orgId: ORG_ID, action: 'backup.storage_credential.check', resourceId: HISTORY_ID, details: { outcome },
    }));
  });

  it('tells the operator to disable a key that still works', async () => {
    m.check.mockResolvedValue({ status: 'still_live' });
    const body = await (await check()).json();
    expect(body.message).toBe('The previous key still works. Disable it with your storage provider, then check again.');
  });

  it('runs the check in the caller\'s own organization context', async () => {
    m.check.mockImplementation(async (input: { inOrg: (fn: () => Promise<unknown>) => Promise<unknown> }) => {
      await input.inOrg(async () => undefined);
      return { status: 'still_live' };
    });
    await check();
    expect(m.withAuthCtx).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ status: 'not_found' }, 404],
    [{ status: 'not_checkable', reason: 'in_use' }, 409],
    [{ status: 'not_checkable', reason: 'already_revoked' }, 409],
    [{ status: 'not_checkable', reason: 'no_sealed_settings' }, 409],
  ])('maps %o to %i', async (result, status) => {
    m.check.mockResolvedValue(result);
    expect((await check()).status).toBe(status);
  });

  it('is rate limited per organization, before any check runs', async () => {
    m.rateLimiter.mockResolvedValue({ allowed: false, remaining: 0, resetAt: new Date(Date.now() + 30_000) });
    const res = await check();
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBeTruthy();
    expect(m.check).not.toHaveBeenCalled();
    const [, key] = m.rateLimiter.mock.calls[0] as unknown as [unknown, string];
    expect(key).toBe(`backup-credential-check:${ORG_ID}`);
  });

  it('refuses a caller below the organization-wide governance ceiling', async () => {
    m.canMutate.mockReturnValue(false);
    expect((await check()).status).toBe(403);
    expect(m.check).not.toHaveBeenCalled();
  });
});

describe('POST /backup/storage-credentials/:id/confirm-disabled', () => {
  const confirm = (body: unknown) => app().request(`/backup/storage-credentials/${HISTORY_ID}/confirm-disabled`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  it('records the operator\'s confirmation as operator_attested', async () => {
    m.attest.mockResolvedValue({ status: 'revoked' });
    const res = await confirm({ confirm: true, detail: 'Deleted in the console' });
    expect(res.status).toBe(200);
    expect(m.attest).toHaveBeenCalledWith(expect.objectContaining({
      historyId: HISTORY_ID, orgId: ORG_ID, userId: 'user-1', evidence: 'operator_attested', detail: 'Deleted in the console',
    }));
    expect(m.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'backup.storage_credential.confirm_disabled', resourceId: HISTORY_ID,
    }));
  });

  it('requires an explicit confirmation', async () => {
    expect((await confirm({})).status).toBe(400);
    expect((await confirm({ confirm: false })).status).toBe(400);
    expect(m.attest).not.toHaveBeenCalled();
  });

  it('refuses the key a destination still uses', async () => {
    m.attest.mockResolvedValue({ status: 'not_checkable', reason: 'in_use' });
    expect((await confirm({ confirm: true })).status).toBe(409);
  });
});
