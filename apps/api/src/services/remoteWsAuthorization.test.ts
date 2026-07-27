import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PERMISSIONS } from './permissions';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const ORG_ID = '33333333-3333-4333-8333-333333333333';
const SITE_ID = '44444444-4444-4444-8444-444444444444';
const DEVICE_ID = '55555555-5555-4555-8555-555555555555';
const PARTNER_ID = '66666666-6666-4666-8666-666666666666';

const mocks = vi.hoisted(() => ({
  consumeWsTicket: vi.fn(),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  select: vi.fn(),
  checkRemoteAccess: vi.fn(async () => ({ allowed: true })),
  rateLimiter: vi.fn(async () => ({
    allowed: true,
    remaining: 9,
    resetAt: new Date(Date.now() + 60_000),
  })),
  getRedis: vi.fn(() => ({ redis: true })),
}));

vi.mock('./remoteSessionAuth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./remoteSessionAuth')>();
  return { ...actual, consumeWsTicket: mocks.consumeWsTicket };
});

vi.mock('../db', () => ({
  db: { select: mocks.select },
  withSystemDbAccessContext: mocks.withSystemDbAccessContext,
}));

vi.mock('./remoteAccessPolicy', () => ({
  checkRemoteAccess: mocks.checkRemoteAccess,
}));

vi.mock('./rate-limit', () => ({
  rateLimiter: mocks.rateLimiter,
}));

vi.mock('./redis', () => ({
  getRedis: mocks.getRedis,
}));

import {
  authorizeConsumedRemoteWsTicket,
  consumeRemoteWsUpgradeTicket,
  type ConsumedRemoteWsTicketContext,
} from './remoteWsAuthorization';

function queryRows(rows: readonly unknown[]) {
  const whereResult = Promise.resolve(rows) as Promise<readonly unknown[]> & {
    limit: ReturnType<typeof vi.fn>;
  };
  whereResult.limit = vi.fn(async () => rows);
  const afterFrom = {
    where: vi.fn(() => whereResult),
    innerJoin: vi.fn(() => ({
      where: vi.fn(() => whereResult),
    })),
  };
  return { from: vi.fn(() => afterFrom) };
}

function v2Ticket(kind: 'terminal' | 'desktop' | 'tunnel') {
  return {
    ok: true as const,
    sessionId: SESSION_ID,
    sessionType: kind,
    userId: USER_ID,
    expiresAt: Date.now() + 60_000,
    version: 2 as const,
    ticketJti: '77777777-7777-4777-8777-777777777777',
    mfaSatisfied: true,
  };
}

function consumed(kind: 'terminal' | 'desktop' | 'tunnel'): ConsumedRemoteWsTicketContext {
  return {
    sessionId: SESSION_ID,
    sessionType: kind,
    userId: USER_ID,
    ticketAssurance: { kind: 'mfa_v2', mfaSatisfied: true },
    ticketJti: '77777777-7777-4777-8777-777777777777',
  };
}

function installAuthorizationRows(input: {
  kind: 'terminal' | 'desktop' | 'tunnel';
  userStatus?: string;
  session?: null | Readonly<{
    userId?: string;
    status?: string;
    type?: string;
  }>;
  deviceStatus?: string;
  deviceOrgId?: string;
  siteIds?: readonly string[] | null;
  permissions?: ReadonlyArray<{ resource: string; action: string }>;
  orgMembership?: boolean;
  partnerOrgAccess?: 'all' | 'selected' | 'none';
  partnerOrgIds?: string[] | null;
}): void {
  const sessionType = input.kind === 'terminal'
    ? 'terminal'
    : input.kind === 'desktop'
      ? 'desktop'
      : 'vnc';
  const session = input.session === null
    ? null
    : {
        id: SESSION_ID,
        userId: input.session?.userId ?? USER_ID,
        orgId: ORG_ID,
        deviceId: DEVICE_ID,
        type: input.session?.type ?? sessionType,
        status: input.session?.status ?? 'active',
      };
  const user = {
    id: USER_ID,
    status: input.userStatus ?? 'active',
    partnerId: PARTNER_ID,
  };
  const sessionRows = session
    ? [{
        session,
        device: {
          id: DEVICE_ID,
          orgId: input.deviceOrgId ?? ORG_ID,
          siteId: SITE_ID,
          agentId: 'agent-1',
          status: input.deviceStatus ?? 'online',
        },
      }]
    : [];
  const orgRows = input.orgMembership === false
    ? []
    : [{ roleId: 'org-role', siteIds: input.siteIds === undefined ? null : input.siteIds }];
  const partnerRows = [{
    roleId: 'partner-role',
    orgAccess: input.partnerOrgAccess ?? 'all',
    orgIds: input.partnerOrgIds ?? null,
  }];
  const permissions = input.permissions ?? [{
    resource: PERMISSIONS.REMOTE_ACCESS.resource,
    action: PERMISSIONS.REMOTE_ACCESS.action,
  }];

  mocks.select
    .mockReturnValueOnce(queryRows([user]))
    .mockReturnValueOnce(queryRows(sessionRows))
    .mockReturnValueOnce(queryRows(orgRows))
    .mockReturnValueOnce(queryRows(partnerRows))
    .mockReturnValueOnce(queryRows(permissions));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.select.mockReset();
  mocks.consumeWsTicket.mockResolvedValue(v2Ticket('terminal'));
  mocks.checkRemoteAccess.mockResolvedValue({ allowed: true });
  mocks.rateLimiter.mockResolvedValue({
    allowed: true,
    remaining: 9,
    resetAt: new Date(Date.now() + 60_000),
  });
  mocks.getRedis.mockReturnValue({ redis: true });
});

describe('consumeRemoteWsUpgradeTicket', () => {
  it('rejects missing and invalid tickets without entering system DB context', async () => {
    expect(await consumeRemoteWsUpgradeTicket({
      sessionId: SESSION_ID,
      expectedType: 'terminal',
      ticket: undefined,
      mode: 'pre_upgrade',
      caller: { ip: '203.0.113.1', userAgent: 'test' },
    })).toEqual({ ok: false, status: 401, reason: 'ticket_missing' });

    mocks.consumeWsTicket.mockResolvedValueOnce({ ok: false, reason: 'not_found' });
    expect(await consumeRemoteWsUpgradeTicket({
      sessionId: SESSION_ID,
      expectedType: 'terminal',
      ticket: 'invalid',
      mode: 'pre_upgrade',
      caller: { ip: '203.0.113.1', userAgent: 'test' },
    })).toEqual({ ok: false, status: 401, reason: 'ticket_invalid' });
    expect(mocks.withSystemDbAccessContext).not.toHaveBeenCalled();
  });

  it('rejects ticket path, type, and session mismatches', async () => {
    for (const ticketResult of [
      { ...v2Ticket('desktop'), sessionType: 'tunnel-http' as const },
      { ...v2Ticket('desktop') },
      { ...v2Ticket('terminal'), sessionId: 'other-session' },
    ]) {
      mocks.consumeWsTicket.mockResolvedValueOnce(ticketResult);
      const result = await consumeRemoteWsUpgradeTicket({
        sessionId: SESSION_ID,
        expectedType: 'terminal',
        ticket: 'ticket',
        mode: 'pre_upgrade',
        caller: { ip: '203.0.113.1', userAgent: 'test' },
      });
      expect(result).toEqual({ ok: false, status: 401, reason: 'ticket_mismatch' });
    }
  });

  it('keeps V0/V1 distinct and accepts them only in post-upgrade', async () => {
    const compatibility = [
      {
        result: {
          ...v2Ticket('desktop'),
          version: 0 as const,
          ticketJti: null,
          mfaSatisfied: 'forged',
        },
        assurance: { kind: 'legacy_unversioned_v0' },
        jti: null,
      },
      {
        result: {
          ...v2Ticket('desktop'),
          version: 1 as const,
          ticketJti: 'legacy-jti',
          mfaSatisfied: undefined,
        },
        assurance: { kind: 'legacy_viewer_compatibility' },
        jti: 'legacy-jti',
      },
    ];

    for (const item of compatibility) {
      mocks.consumeWsTicket.mockResolvedValueOnce(item.result);
      const accepted = await consumeRemoteWsUpgradeTicket({
        sessionId: SESSION_ID,
        expectedType: 'desktop',
        ticket: 'ticket',
        mode: 'post_upgrade',
        caller: { ip: '203.0.113.1', userAgent: 'test' },
      });
      expect(accepted).toMatchObject({
        ok: true,
        ticket: {
          ticketAssurance: item.assurance,
          ticketJti: item.jti,
        },
      });
      if (accepted.ok) {
        expect(accepted.ticket.ticketAssurance).not.toHaveProperty('mfaSatisfied');
      }

      mocks.consumeWsTicket.mockResolvedValueOnce(item.result);
      expect(await consumeRemoteWsUpgradeTicket({
        sessionId: SESSION_ID,
        expectedType: 'desktop',
        ticket: 'ticket',
        mode: 'pre_upgrade',
        caller: { ip: '203.0.113.1', userAgent: 'test' },
      })).toEqual({
        ok: false,
        status: 403,
        reason: 'ticket_version_not_allowed',
      });
    }
  });

  it('requires true MFA on V2 and translates ticket-store failure to 503', async () => {
    mocks.consumeWsTicket.mockResolvedValueOnce({
      ...v2Ticket('terminal'),
      mfaSatisfied: false,
    });
    expect(await consumeRemoteWsUpgradeTicket({
      sessionId: SESSION_ID,
      expectedType: 'terminal',
      ticket: 'ticket',
      mode: 'post_upgrade',
      caller: { ip: '203.0.113.1', userAgent: 'test' },
    })).toEqual({ ok: false, status: 403, reason: 'mfa_unassured' });

    mocks.consumeWsTicket.mockRejectedValueOnce(new Error('redis down'));
    expect(await consumeRemoteWsUpgradeTicket({
      sessionId: SESSION_ID,
      expectedType: 'terminal',
      ticket: 'ticket',
      mode: 'pre_upgrade',
      caller: { ip: '203.0.113.1', userAgent: 'test' },
    })).toEqual({ ok: false, status: 503, reason: 'authorization_unavailable' });
  });
});

describe.each(['terminal', 'desktop', 'tunnel'] as const)(
  'authorizeConsumedRemoteWsTicket %s',
  (kind) => {
    it('returns the complete bounded live authorization context', async () => {
      installAuthorizationRows({ kind });
      const result = await authorizeConsumedRemoteWsTicket(consumed(kind));

      expect(result).toMatchObject({
        ok: true,
        context: {
          sessionId: SESSION_ID,
          sessionType: kind,
          userId: USER_ID,
          orgId: ORG_ID,
          siteId: SITE_ID,
          deviceId: DEVICE_ID,
          agentId: 'agent-1',
          permission: PERMISSIONS.REMOTE_ACCESS,
        },
      });
      expect(mocks.withSystemDbAccessContext).toHaveBeenCalledTimes(1);
      expect(mocks.rateLimiter).toHaveBeenCalledWith(
        { redis: true },
        `${kind}ws:conn:${USER_ID}`,
        10,
        60,
      );
    });

    it.each([
      ['user_inactive', { userStatus: 'disabled' }, 403],
      ['session_missing', { session: null }, 404],
      ['session_not_owned', { session: { userId: 'other-user' } }, 403],
      ['session_inactive', { session: { status: 'disconnected' } }, 403],
      ['site_denied', { siteIds: [] }, 403],
      ['permission_denied', { permissions: [] }, 403],
      ['device_offline', { deviceStatus: 'offline' }, 503],
    ] as const)('returns %s without side effects', async (reason, overrides, status) => {
      installAuthorizationRows({ kind, ...overrides });
      const result = await authorizeConsumedRemoteWsTicket(consumed(kind));
      expect(result).toEqual({ ok: false, reason, status });
      expect(mocks.rateLimiter).not.toHaveBeenCalled();
    });

    it('rejects a session/device tenant mismatch from the system-scoped join', async () => {
      installAuthorizationRows({
        kind,
        deviceOrgId: '99999999-9999-4999-8999-999999999999',
      });

      expect(await authorizeConsumedRemoteWsTicket(consumed(kind))).toEqual({
        ok: false,
        status: 403,
        reason: 'session_not_owned',
      });
      expect(mocks.rateLimiter).not.toHaveBeenCalled();
    });

    it('fails closed for policy denial, rate limit, and database failure', async () => {
      installAuthorizationRows({ kind });
      mocks.checkRemoteAccess.mockResolvedValueOnce({ allowed: false });
      expect(await authorizeConsumedRemoteWsTicket(consumed(kind))).toEqual({
        ok: false,
        status: 403,
        reason: 'policy_denied',
      });

      installAuthorizationRows({ kind });
      mocks.rateLimiter.mockResolvedValueOnce({
        allowed: false,
        remaining: 0,
        resetAt: new Date(),
      });
      expect(await authorizeConsumedRemoteWsTicket(consumed(kind))).toEqual({
        ok: false,
        status: 429,
        reason: 'rate_limited',
      });

      mocks.select.mockImplementationOnce(() => {
        throw new Error('database down');
      });
      expect(await authorizeConsumedRemoteWsTicket(consumed(kind))).toEqual({
        ok: false,
        status: 503,
        reason: 'authorization_unavailable',
      });
    });
  },
);

it('uses vncRelay for VNC tunnels and proxy for proxy tunnels', async () => {
  installAuthorizationRows({ kind: 'tunnel' });
  await authorizeConsumedRemoteWsTicket(consumed('tunnel'));
  expect(mocks.checkRemoteAccess).toHaveBeenLastCalledWith(DEVICE_ID, 'vncRelay');

  installAuthorizationRows({ kind: 'tunnel', session: { type: 'proxy' } });
  await authorizeConsumedRemoteWsTicket(consumed('tunnel'));
  expect(mocks.checkRemoteAccess).toHaveBeenLastCalledWith(DEVICE_ID, 'proxy');
});
