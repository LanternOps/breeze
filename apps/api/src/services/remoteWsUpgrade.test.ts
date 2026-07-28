import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const {
  authorizeConsumedRemoteWsTicket,
  consumeRemoteWsUpgradeTicket,
  recoverDesktopFinalizationOrphan,
} = vi.hoisted(() => ({
  authorizeConsumedRemoteWsTicket: vi.fn(),
  consumeRemoteWsUpgradeTicket: vi.fn(),
  recoverDesktopFinalizationOrphan: vi.fn(),
}));

vi.mock('./remoteWsAuthorization', () => ({
  authorizeConsumedRemoteWsTicket,
  consumeRemoteWsUpgradeTicket,
}));

vi.mock('./desktopSessionFinalization', () => ({
  recoverDesktopFinalizationOrphan,
}));

vi.mock('./clientIp', () => ({
  getTrustedClientIp: vi.fn(() => '192.0.2.10'),
}));

import { requireRemoteWsUpgrade } from './remoteWsUpgrade';

const SESSION_ID = '33333333-3333-4333-8333-333333333333';
const claim = {
  kind: 'terminal' as const,
  sessionId: SESSION_ID,
  connectionId: '11111111-1111-4111-8111-111111111111',
  generation: 7,
  instanceId: '22222222-2222-4222-8222-222222222222',
  leaseToken: '44444444-4444-4444-8444-444444444444',
  ownerValue: 'opaque-owner',
  safeForwardingUntilMonotonicMs: 20_000,
};

const v2Ticket = {
  sessionId: SESSION_ID,
  sessionType: 'terminal' as const,
  userId: '55555555-5555-4555-8555-555555555555',
  ticketAssurance: { kind: 'mfa_v2' as const, mfaSatisfied: true as const },
  ticketJti: '66666666-6666-4666-8666-666666666666',
};

const authorized = {
  sessionId: SESSION_ID,
  sessionType: 'terminal' as const,
  userId: v2Ticket.userId,
  orgId: '77777777-7777-4777-8777-777777777777',
  siteId: null,
  deviceId: '88888888-8888-4888-8888-888888888888',
  agentId: 'agent-1',
  permission: { resource: 'remote', action: 'access' },
  ticketAssurance: v2Ticket.ticketAssurance,
  ticketJti: v2Ticket.ticketJti,
};

function makeHarness(input?: {
  expectedType?: 'terminal' | 'desktop' | 'tunnel';
  acquireResult?: unknown;
  installResult?: { ok: true } | { ok: false; reason: 'already_owned' };
  downstreamThrows?: boolean;
}) {
  const expectedType = input?.expectedType ?? 'terminal';
  const localClaim = { ...claim, kind: expectedType };
  const sharedLeases = {
    acquire: vi.fn().mockResolvedValue(
      input?.acquireResult ?? { ok: true, claim: localClaim },
    ),
    release: vi.fn().mockResolvedValue(true),
  };
  const installLocal = vi.fn(() => input?.installResult ?? { ok: true as const });
  const removeLocal = vi.fn(() => true);
  const downstream = vi.fn((context: unknown) => context);
  const app = new Hono();
  app.get(
    '/:id/ws',
    requireRemoteWsUpgrade({
      expectedType,
      sharedLeases: sharedLeases as never,
      installLocal,
      removeLocal,
    }),
    (c) => {
      downstream(c.get('remoteWs'));
      if (input?.downstreamThrows) throw new Error('upgrade setup failed');
      return c.body(null, 204);
    },
  );
  return { app, sharedLeases, installLocal, removeLocal, downstream, localClaim };
}

describe('requireRemoteWsUpgrade', () => {
  const originalMode = process.env.REMOTE_WS_AUTH_MODE;
  const originalTicketDrain =
    process.env.REMOTE_WS_LEGACY_TICKET_WRITER_DRAINED_AT;
  const originalViewerDrain =
    process.env.REMOTE_WS_LEGACY_VIEWER_ISSUER_DRAINED_AT;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.REMOTE_WS_AUTH_MODE = 'post_upgrade';
    process.env.REMOTE_WS_LEGACY_TICKET_WRITER_DRAINED_AT =
      '2020-01-01T00:00:00.000Z';
    process.env.REMOTE_WS_LEGACY_VIEWER_ISSUER_DRAINED_AT =
      '2020-01-01T00:00:00.000Z';
    consumeRemoteWsUpgradeTicket.mockResolvedValue({ ok: true, ticket: v2Ticket });
    authorizeConsumedRemoteWsTicket.mockResolvedValue({ ok: true, context: authorized });
    recoverDesktopFinalizationOrphan.mockResolvedValue('not_orphaned');
  });

  afterEach(() => {
    if (originalMode === undefined) delete process.env.REMOTE_WS_AUTH_MODE;
    else process.env.REMOTE_WS_AUTH_MODE = originalMode;
    if (originalTicketDrain === undefined) {
      delete process.env.REMOTE_WS_LEGACY_TICKET_WRITER_DRAINED_AT;
    } else {
      process.env.REMOTE_WS_LEGACY_TICKET_WRITER_DRAINED_AT =
        originalTicketDrain;
    }
    if (originalViewerDrain === undefined) {
      delete process.env.REMOTE_WS_LEGACY_VIEWER_ISSUER_DRAINED_AT;
    } else {
      process.env.REMOTE_WS_LEGACY_VIEWER_ISSUER_DRAINED_AT =
        originalViewerDrain;
    }
  });

  it.each([
    ['missing', 401, 'ticket_missing'],
    ['invalid', 401, 'ticket_invalid'],
    ['expired', 401, 'ticket_invalid'],
    ['consumed', 401, 'ticket_invalid'],
    ['mismatched', 401, 'ticket_mismatch'],
    ['unassured', 403, 'mfa_unassured'],
    ['unavailable', 503, 'authorization_unavailable'],
  ])('rejects a %s ticket before reservation or upgrade', async (_label, status, reason) => {
    consumeRemoteWsUpgradeTicket.mockResolvedValueOnce({ ok: false, status, reason });
    const harness = makeHarness();

    const response = await harness.app.request(`/${SESSION_ID}/ws?ticket=ticket-value`);

    expect(response.status).toBe(status);
    expect(harness.sharedLeases.acquire).not.toHaveBeenCalled();
    expect(harness.installLocal).not.toHaveBeenCalled();
    expect(harness.downstream).not.toHaveBeenCalled();
  });

  it.each([
    [403, 'user_inactive'],
    [403, 'permission_denied'],
    [403, 'site_denied'],
    [403, 'policy_denied'],
    [404, 'session_missing'],
    [429, 'rate_limited'],
    [503, 'authorization_unavailable'],
  ])('rejects live authorization status %s before reservation or upgrade', async (status, reason) => {
    process.env.REMOTE_WS_AUTH_MODE = 'pre_upgrade';
    authorizeConsumedRemoteWsTicket.mockResolvedValueOnce({ ok: false, status, reason });
    const harness = makeHarness();

    const response = await harness.app.request(`/${SESSION_ID}/ws?ticket=ticket-value`);

    expect(response.status).toBe(status);
    expect(harness.sharedLeases.acquire).not.toHaveBeenCalled();
    expect(harness.downstream).not.toHaveBeenCalled();
  });

  it('preserves a post-upgrade V0 ticket with a null JTI through middleware context', async () => {
    const legacyTicket = {
      ...v2Ticket,
      ticketAssurance: { kind: 'legacy_unversioned_v0' as const },
      ticketJti: null,
    };
    consumeRemoteWsUpgradeTicket.mockResolvedValueOnce({ ok: true, ticket: legacyTicket });
    const harness = makeHarness();

    const response = await harness.app.request(`/${SESSION_ID}/ws?ticket=legacy-v0`);

    expect(response.status).toBe(204);
    expect(authorizeConsumedRemoteWsTicket).not.toHaveBeenCalled();
    expect(harness.downstream).toHaveBeenCalledWith({
      authorizationPhase: 'ticket_only',
      ticket: legacyTicket,
      connection: expect.objectContaining({
        connectionId: claim.connectionId,
        generation: claim.generation,
      }),
      sharedClaim: expect.objectContaining({ sessionId: SESSION_ID }),
    });
  });

  it('completes pre-upgrade authorization, reserves once, installs once, and invokes upgrade once', async () => {
    process.env.REMOTE_WS_AUTH_MODE = 'pre_upgrade';
    const harness = makeHarness();

    const response = await harness.app.request(`/${SESSION_ID}/ws?ticket=v2-ticket`, {
      headers: { 'user-agent': 'test-agent' },
    });

    expect(response.status).toBe(204);
    expect(consumeRemoteWsUpgradeTicket).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: SESSION_ID,
      expectedType: 'terminal',
      ticket: 'v2-ticket',
      mode: 'pre_upgrade',
      caller: { ip: '192.0.2.10', userAgent: 'test-agent' },
    }));
    expect(authorizeConsumedRemoteWsTicket).toHaveBeenCalledWith(v2Ticket);
    expect(harness.sharedLeases.acquire).toHaveBeenCalledOnce();
    expect(harness.installLocal).toHaveBeenCalledOnce();
    expect(harness.downstream).toHaveBeenCalledOnce();
    expect(harness.downstream).toHaveBeenCalledWith(expect.objectContaining({
      authorizationPhase: 'complete',
      authorization: expect.objectContaining({
        ...authorized,
        connection: expect.objectContaining({ leaseToken: claim.leaseToken }),
      }),
    }));
  });

  it.each([
    ['already_owned', 409],
    ['desktop_finalizing', 409],
    ['desktop_orphan_recovery', 409],
    ['unsupported_topology', 503],
    ['unavailable', 503],
  ])('maps shared acquire reason %s to HTTP %s without upgrade', async (reason, status) => {
    const harness = makeHarness({ acquireResult: { ok: false, reason } });

    const response = await harness.app.request(`/${SESSION_ID}/ws?ticket=v2-ticket`);

    expect(response.status).toBe(status);
    expect(harness.installLocal).not.toHaveBeenCalled();
    expect(harness.downstream).not.toHaveBeenCalled();
  });

  it('blocks desktop orphan recovery before reservation and upgrade', async () => {
    recoverDesktopFinalizationOrphan.mockResolvedValueOnce('retained');
    const harness = makeHarness({ expectedType: 'desktop' });

    const response = await harness.app.request(`/${SESSION_ID}/ws?ticket=v2-ticket`);

    expect(response.status).toBe(409);
    expect(recoverDesktopFinalizationOrphan).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      trigger: 'admission',
    });
    expect(harness.sharedLeases.acquire).not.toHaveBeenCalled();
    expect(harness.downstream).not.toHaveBeenCalled();
  });

  it('fails desktop admission closed when orphan state cannot be proved', async () => {
    recoverDesktopFinalizationOrphan.mockRejectedValueOnce(new Error('redis unavailable'));
    const harness = makeHarness({ expectedType: 'desktop' });

    const response = await harness.app.request(`/${SESSION_ID}/ws?ticket=v2-ticket`);

    expect(response.status).toBe(503);
    expect(harness.sharedLeases.acquire).not.toHaveBeenCalled();
    expect(harness.downstream).not.toHaveBeenCalled();
  });

  it('releases only the exact shared claim when local installation fails', async () => {
    const harness = makeHarness({
      installResult: { ok: false, reason: 'already_owned' },
    });

    const response = await harness.app.request(`/${SESSION_ID}/ws?ticket=v2-ticket`);

    expect(response.status).toBe(409);
    expect(harness.sharedLeases.release).toHaveBeenCalledWith(harness.localClaim);
    expect(harness.downstream).not.toHaveBeenCalled();
  });

  it('expires forwarding and removes/releases the exact opening claim when upgrade setup throws', async () => {
    const harness = makeHarness({ downstreamThrows: true });

    const response = await harness.app.request(`/${SESSION_ID}/ws?ticket=v2-ticket`);

    expect(response.status).toBe(500);
    expect(harness.localClaim.safeForwardingUntilMonotonicMs).toBe(0);
    expect(harness.removeLocal).toHaveBeenCalledWith(SESSION_ID, harness.localClaim);
    expect(harness.sharedLeases.release).toHaveBeenCalledWith(harness.localClaim);
  });
});
