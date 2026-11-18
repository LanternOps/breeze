/**
 * W04-D11 (#6758): `create_remote_session` applies the same gates as
 * `POST /remote/sessions` (routes/remote/sessions.ts) before it creates a
 * session row: the tenant's remote-access policy (`checkRemoteAccess`, the
 * `remoteTools` capability for terminal and file transfer), the org and
 * per-user concurrent-session caps, and the `session_initiated` audit row.
 * Before W04 the tool skipped all four, so a chat or agent caller could open a
 * terminal on a device whose policy forbids remote tools.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  class RemoteSessionDeniedError extends Error {
    readonly capability = 'remote_control' as const;
    constructor(readonly code: 'TRUST_PROBATION' | 'TRUST_RESTRICTED', readonly reason: string) {
      super(reason);
    }
  }
  return {
    createRemoteSession: vi.fn(),
    RemoteSessionDeniedError,
    checkRemoteAccess: vi.fn(),
    checkSessionRateLimit: vi.fn(),
    checkUserSessionRateLimit: vi.fn(),
    logSessionAudit: vi.fn(),
  };
});

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));
vi.mock('./commandQueue', () => ({ executeCommand: vi.fn(), queueCommandForExecution: vi.fn() }));
vi.mock('./remoteSessionCreate', () => ({
  createRemoteSession: mocks.createRemoteSession,
  RemoteSessionDeniedError: mocks.RemoteSessionDeniedError,
}));
vi.mock('./remoteAccessPolicy', () => ({ checkRemoteAccess: mocks.checkRemoteAccess }));
vi.mock('../routes/remote/helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../routes/remote/helpers')>()),
  checkSessionRateLimit: mocks.checkSessionRateLimit,
  checkUserSessionRateLimit: mocks.checkUserSessionRateLimit,
  logSessionAudit: mocks.logSessionAudit,
}));

import { db } from '../db';
import { registerRemoteTools } from './aiToolsRemote';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';

const DEVICE = { id: 'device-1', orgId: 'org-1', siteId: 'site-A', hostname: 'host-1', status: 'online' };

function handler(): AiTool['handler'] {
  const reg = new Map<string, AiTool>();
  registerRemoteTools(reg);
  return reg.get('create_remote_session')!.handler;
}

function auth(scope: AuthContext['scope'] = 'organization'): AuthContext {
  return {
    principal: { kind: 'user_session' },
    user: { id: 'u1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
    token: {} as any,
    partnerId: null,
    orgId: 'org-1',
    scope,
    accessibleOrgIds: ['org-1'],
    orgCondition: () => undefined,
    canAccessOrg: () => true,
    canAccessSite: () => true,
  } as unknown as AuthContext;
}

const call = async (type = 'terminal', scope?: AuthContext['scope']) =>
  JSON.parse(await handler()({ deviceId: 'device-1', type }, auth(scope)));

beforeEach(() => {
  vi.clearAllMocks();
  (db.select as ReturnType<typeof vi.fn>).mockReturnValue({
    from: () => ({ where: () => ({ limit: () => Promise.resolve([DEVICE]) }) }),
  });
  mocks.checkRemoteAccess.mockResolvedValue({ allowed: true });
  mocks.checkSessionRateLimit.mockResolvedValue({ allowed: true, currentCount: 0 });
  mocks.checkUserSessionRateLimit.mockResolvedValue({ allowed: true, currentCount: 0 });
  mocks.createRemoteSession.mockResolvedValue({ id: 'sess-1', status: 'pending' });
});

describe('create_remote_session applies the POST /remote/sessions gates (W04-D11, #6758)', () => {
  it('refuses when the remote-access policy denies remote tools, before creating anything', async () => {
    mocks.checkRemoteAccess.mockResolvedValue({ allowed: false, reason: 'Remote tools disabled by policy', policyName: 'Lockdown' });

    const out = await call('file_transfer');

    expect(mocks.checkRemoteAccess).toHaveBeenCalledWith('device-1', 'remoteTools');
    expect(out).toMatchObject({ error: 'Remote tools disabled by policy', code: 'REMOTE_ACCESS_POLICY_DENIED', policyName: 'Lockdown' });
    expect(mocks.createRemoteSession).not.toHaveBeenCalled();
  });

  it('keeps a parked-device policy code', async () => {
    mocks.checkRemoteAccess.mockResolvedValue({ allowed: false, reason: 'pending', code: 'DEVICE_PENDING_ASSIGNMENT' });

    expect((await call()).code).toBe('DEVICE_PENDING_ASSIGNMENT');
    expect(mocks.createRemoteSession).not.toHaveBeenCalled();
  });

  it('refuses at the org concurrent-session cap', async () => {
    mocks.checkSessionRateLimit.mockResolvedValue({ allowed: false, currentCount: 99 });

    const out = await call();

    expect(mocks.checkSessionRateLimit).toHaveBeenCalledWith('org-1');
    expect(out.error).toMatch(/maximum concurrent sessions .* organization/i);
    expect(mocks.createRemoteSession).not.toHaveBeenCalled();
  });

  it('refuses at the per-user concurrent-session cap', async () => {
    mocks.checkUserSessionRateLimit.mockResolvedValue({ allowed: false, currentCount: 9 });

    const out = await call();

    expect(mocks.checkUserSessionRateLimit).toHaveBeenCalledWith('u1');
    expect(out.error).toMatch(/maximum concurrent sessions .* user/i);
    expect(mocks.createRemoteSession).not.toHaveBeenCalled();
  });

  it('a system-scope caller skips the per-user cap, as on the route', async () => {
    await call('terminal', 'system');
    expect(mocks.checkUserSessionRateLimit).not.toHaveBeenCalled();
    expect(mocks.createRemoteSession).toHaveBeenCalledTimes(1);
  });

  it('writes the session_initiated audit row after creating the session', async () => {
    const out = await call('terminal');

    expect(out).toMatchObject({ id: 'sess-1', status: 'pending' });
    expect(mocks.logSessionAudit).toHaveBeenCalledWith(
      'session_initiated',
      'u1',
      'org-1',
      expect.objectContaining({ sessionId: 'sess-1', deviceId: 'device-1', deviceHostname: 'host-1', type: 'terminal' }),
    );
  });
});
