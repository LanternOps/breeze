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
  partnerTrustMode: vi.fn((): 'off' | 'enforce' => 'off'),
  evaluateCapability: vi.fn(async (): Promise<any> => ({ allow: true })),
  evaluateCapabilityContinuationForState: vi.fn((): any => ({ allow: true })),
  unresolvedPartnerDecision: vi.fn(async () => ({ allow: false as const, code: 'TRUST_RESTRICTED' as const, capability: 'remote_control' as const, reason: 'unresolved' })),
  tightenStatementTimeout: vi.fn(async () => 0),
}));

vi.mock('./remoteSessionAuth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./remoteSessionAuth')>();
  return { ...actual, consumeWsTicket: mocks.consumeWsTicket };
});

vi.mock('../db', () => ({
  db: { select: mocks.select },
  withSystemDbAccessContext: mocks.withSystemDbAccessContext,
  runOutsideDbContext: (fn: () => unknown) => fn(),
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

vi.mock('../config/partnerTrustMode', () => ({ partnerTrustMode: mocks.partnerTrustMode }));
vi.mock('./partnerTrust', () => ({
  evaluateCapability: mocks.evaluateCapability,
  evaluateCapabilityContinuationForState: mocks.evaluateCapabilityContinuationForState,
  unresolvedPartnerDecision: mocks.unresolvedPartnerDecision,
}));

vi.mock('../db/lockTimeout', () => ({
  tightenStatementTimeout: mocks.tightenStatementTimeout,
}));

import {
  authorizeConsumedRemoteWsTicket,
  authorizeRemoteSessionContinuation,
  authorizeLiveRemoteSessionAccess,
  consumeRemoteWsUpgradeTicket,
  revalidateRemoteWsAuthority,
  revalidateRemoteWsAuthorityBounded,
  type ConsumedRemoteWsTicketContext,
} from './remoteWsAuthorization';

function queryRows(rows: readonly unknown[]) {
  const whereResult = Promise.resolve(rows) as Promise<readonly unknown[]> & {
    limit: ReturnType<typeof vi.fn>;
  };
  whereResult.limit = vi.fn(async () => rows);
  const afterFrom: any = { where: vi.fn(() => whereResult) };
  afterFrom.innerJoin = vi.fn(() => afterFrom);
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
    errorMessage?: string | null;
  }>;
  deviceStatus?: string;
  deviceOrgId?: string;
  siteIds?: readonly string[] | null;
  permissions?: ReadonlyArray<{ resource: string; action: string }>;
  orgMembership?: boolean;
  partnerOrgAccess?: 'all' | 'selected' | 'none';
  partnerOrgIds?: string[] | null;
  organizationPartnerId?: string;
  organizationStatus?: string;
  organizationDeletedAt?: Date | null;
  partnerStatus?: string;
  partnerDeletedAt?: Date | null;
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
        errorMessage: input.session?.errorMessage ?? null,
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
        partner: {
          id: PARTNER_ID,
          trustState: 'trusted',
          probationEnrollments: 0,
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
  const permissions = input.permissions ?? [
    PERMISSIONS.REMOTE_ACCESS,
    ...(input.kind === 'tunnel' ? [PERMISSIONS.DEVICES_EXECUTE] : []),
  ];
  const owningPartnerRows = input.partnerDeletedAt
    ? []
    : [{
        id: input.organizationPartnerId ?? PARTNER_ID,
        status: input.partnerStatus ?? 'active',
        deletedAt: null,
      }];

  mocks.select
    .mockReturnValueOnce(queryRows([user]))
    .mockReturnValueOnce(queryRows(sessionRows))
    .mockReturnValueOnce(queryRows([{
      id: ORG_ID,
      partnerId: input.organizationPartnerId ?? PARTNER_ID,
      status: input.organizationStatus ?? 'active',
      deletedAt: input.organizationDeletedAt ?? null,
    }]))
    .mockReturnValueOnce(queryRows(owningPartnerRows))
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
  mocks.partnerTrustMode.mockReturnValue('off');
  mocks.evaluateCapability.mockResolvedValue({ allow: true });
  mocks.evaluateCapabilityContinuationForState.mockReturnValue({ allow: true });
  mocks.tightenStatementTimeout.mockResolvedValue(0);
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

it('reuses the complete live boundary without charging a connection rate limit', async () => {
  installAuthorizationRows({ kind: 'desktop' });

  const result = await authorizeLiveRemoteSessionAccess({
    sessionId: SESSION_ID,
    sessionType: 'desktop',
    userId: USER_ID,
  });

  expect(result).toMatchObject({
    ok: true,
    user: { id: USER_ID, status: 'active' },
    session: { id: SESSION_ID, userId: USER_ID, deviceId: DEVICE_ID },
    device: { id: DEVICE_ID, orgId: ORG_ID, siteId: SITE_ID },
  });
  expect(mocks.rateLimiter).not.toHaveBeenCalled();
});

it('uses vncRelay for VNC tunnels and proxy for proxy tunnels', async () => {
  installAuthorizationRows({ kind: 'tunnel' });
  await authorizeConsumedRemoteWsTicket(consumed('tunnel'));
  expect(mocks.checkRemoteAccess).toHaveBeenLastCalledWith(DEVICE_ID, 'vncRelay');

  installAuthorizationRows({ kind: 'tunnel', session: { type: 'proxy' } });
  await authorizeConsumedRemoteWsTicket(consumed('tunnel'));
  expect(mocks.checkRemoteAccess).toHaveBeenLastCalledWith(DEVICE_ID, 'proxy');
});

describe('live WebSocket authority', () => {
  it('allows the unchanged live subject without consuming admission rate limit', async () => {
    installAuthorizationRows({ kind: 'desktop' });
    await expect(revalidateRemoteWsAuthority(consumed('desktop'))).resolves.toEqual({ ok: true });
    expect(mocks.rateLimiter).not.toHaveBeenCalled();
  });

  it.each([
    ['user_inactive', { userStatus: 'disabled' }],
    ['session_not_owned', { orgMembership: false, partnerOrgAccess: 'none' }],
    ['site_denied', { siteIds: [] }],
    ['permission_denied', { permissions: [] }],
    ['device_offline', { deviceStatus: 'offline' }],
  ] as const)('denies %s without consuming admission rate limit', async (reason, overrides) => {
    installAuthorizationRows({ kind: 'terminal', ...overrides });
    await expect(revalidateRemoteWsAuthority(consumed('terminal'))).resolves.toMatchObject({ ok: false, reason });
    expect(mocks.rateLimiter).not.toHaveBeenCalled();
  });

  it('bypasses the policy cache and enforces current partner trust', async () => {
    installAuthorizationRows({ kind: 'desktop' });
    mocks.partnerTrustMode.mockReturnValue('enforce');
    mocks.evaluateCapabilityContinuationForState.mockReturnValueOnce({
      allow: false, code: 'TRUST_RESTRICTED', capability: 'remote_control', reason: 'restricted',
    });
    await expect(revalidateRemoteWsAuthority(consumed('desktop'))).resolves.toEqual({
      ok: false, status: 403, reason: 'partner_trust_denied',
    });
    expect(mocks.checkRemoteAccess).toHaveBeenCalledWith(DEVICE_ID, 'webrtcDesktop', { bypassCache: true });
    expect(mocks.rateLimiter).not.toHaveBeenCalled();
  });

  it('repeated continuation checks never replay admission trust side effects', async () => {
    installAuthorizationRows({ kind: 'desktop' });
    mocks.partnerTrustMode.mockReturnValue('enforce');
    await expect(revalidateRemoteWsAuthority(consumed('desktop'))).resolves.toEqual({ ok: true });
    installAuthorizationRows({ kind: 'desktop' });
    await expect(revalidateRemoteWsAuthority(consumed('desktop'))).resolves.toEqual({ ok: true });

    expect(mocks.evaluateCapabilityContinuationForState).toHaveBeenCalledTimes(2);
    expect(mocks.evaluateCapability).not.toHaveBeenCalled();
    expect(mocks.tightenStatementTimeout).toHaveBeenCalledTimes(2);
  });

  it('fails closed when the freshly resolved remote policy is disabled', async () => {
    installAuthorizationRows({ kind: 'terminal' });
    mocks.checkRemoteAccess.mockResolvedValueOnce({ allowed: false });
    await expect(revalidateRemoteWsAuthority(consumed('terminal'))).resolves.toEqual({
      ok: false, status: 403, reason: 'policy_denied',
    });
    expect(mocks.checkRemoteAccess).toHaveBeenCalledWith(DEVICE_ID, 'remoteTools', { bypassCache: true });
  });

  it('fails closed within the configured bound when DB resolution never settles', async () => {
    vi.useFakeTimers();
    mocks.withSystemDbAccessContext.mockImplementationOnce(async () => new Promise(() => undefined));
    const pending = revalidateRemoteWsAuthorityBounded(consumed('terminal'), 25);
    await vi.advanceTimersByTimeAsync(25);
    await expect(pending).resolves.toEqual({ ok: false, status: 503, reason: 'authorization_unavailable' });
    vi.useRealTimers();
  });
});
it.each([
  ['transferred', { organizationPartnerId: '99999999-9999-4999-8999-999999999999' }],
  ['inactive', { organizationStatus: 'churned' }],
  ['deleted', { organizationDeletedAt: new Date() }],
] as const)('denies partner continuation when the organization is %s', async (_case, override) => {
  installAuthorizationRows({ kind: 'tunnel', orgMembership: false, ...override });
  expect(await authorizeConsumedRemoteWsTicket(consumed('tunnel'))).toEqual({
    ok: false,
    status: 403,
    reason: 'session_not_owned',
  });
});

it.each([
  ['suspended', { partnerStatus: 'suspended' }],
  ['churned', { partnerStatus: 'churned' }],
  ['deleted', { partnerDeletedAt: new Date() }],
] as const)('denies continuation when the owning partner is %s', async (_case, override) => {
  installAuthorizationRows({ kind: 'tunnel', ...override });
  expect(await authorizeConsumedRemoteWsTicket(consumed('tunnel'))).toEqual({
    ok: false,
    status: 403,
    reason: 'session_not_owned',
  });
  expect(mocks.checkRemoteAccess).not.toHaveBeenCalled();
  expect(mocks.rateLimiter).not.toHaveBeenCalled();
});

it('denies tunnel WS admission after DEVICES_EXECUTE is revoked while preserving the desktop/terminal contract', async () => {
  installAuthorizationRows({
    kind: 'tunnel',
    permissions: [PERMISSIONS.REMOTE_ACCESS],
  });
  expect(await authorizeConsumedRemoteWsTicket(consumed('tunnel'))).toEqual({
    ok: false,
    status: 403,
    reason: 'permission_denied',
  });

  for (const kind of ['desktop', 'terminal'] as const) {
    installAuthorizationRows({ kind, permissions: [PERMISSIONS.REMOTE_ACCESS] });
    expect(await authorizeConsumedRemoteWsTicket(consumed(kind))).toMatchObject({ ok: true });
  }
});

it('requires every requested continuation permission without consuming a connection rate-limit slot', async () => {
  installAuthorizationRows({
    kind: 'tunnel',
    permissions: [PERMISSIONS.REMOTE_ACCESS],
  });

  expect(await authorizeRemoteSessionContinuation(
    { sessionId: SESSION_ID, sessionType: 'tunnel', userId: USER_ID },
    [PERMISSIONS.REMOTE_ACCESS, PERMISSIONS.DEVICES_EXECUTE],
  )).toEqual({ ok: false, status: 403, reason: 'permission_denied' });
  expect(mocks.rateLimiter).not.toHaveBeenCalled();

  installAuthorizationRows({
    kind: 'tunnel',
    permissions: [PERMISSIONS.REMOTE_ACCESS, PERMISSIONS.DEVICES_EXECUTE],
  });
  expect(await authorizeRemoteSessionContinuation(
    { sessionId: SESSION_ID, sessionType: 'tunnel', userId: USER_ID },
    [PERMISSIONS.REMOTE_ACCESS, PERMISSIONS.DEVICES_EXECUTE],
  )).toMatchObject({ ok: true, context: { sessionId: SESSION_ID, userId: USER_ID } });
  expect(mocks.rateLimiter).not.toHaveBeenCalled();
});


describe('read-only viewer failure diagnostics preserve live authority', () => {
  it.each(['failed', 'disconnected'] as const)('allows an authorized offline %s diagnostic without admitting a live connection', async (status) => {
    installAuthorizationRows({ kind: 'desktop', deviceStatus: 'offline', session: { status, errorMessage: 'capture stopped' } });
    expect(await authorizeLiveRemoteSessionAccess(consumed('desktop'), 'failure-diagnostics')).toMatchObject({ ok: true });
    expect(mocks.rateLimiter).not.toHaveBeenCalled();
  });

  it('keeps terminal sessions denied on the default live path', async () => {
    installAuthorizationRows({ kind: 'desktop', session: { status: 'failed', errorMessage: 'capture stopped' } });
    expect(await authorizeLiveRemoteSessionAccess(consumed('desktop'))).toEqual({ ok: false, status: 403, reason: 'session_inactive' });
  });

  it('does not turn an ordinary disconnected row into a diagnostic exception', async () => {
    installAuthorizationRows({ kind: 'desktop', session: { status: 'disconnected' } });
    expect(await authorizeLiveRemoteSessionAccess(consumed('desktop'), 'failure-diagnostics')).toEqual({ ok: false, status: 403, reason: 'session_inactive' });
  });

  it('still denies diagnostic reads after site authority is revoked', async () => {
    installAuthorizationRows({ kind: 'desktop', siteIds: [], session: { status: 'failed' } });
    expect(await authorizeLiveRemoteSessionAccess(consumed('desktop'), 'failure-diagnostics')).toEqual({ ok: false, status: 403, reason: 'site_denied' });
    expect(mocks.checkRemoteAccess).not.toHaveBeenCalled();
  });
});
