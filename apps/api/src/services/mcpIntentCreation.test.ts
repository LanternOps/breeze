import { describe, it, expect, vi, beforeEach } from 'vitest';
import { canonicalizeArguments, computeArgumentDigest } from '@breeze/shared/canonicalize';

const mocks = vi.hoisted(() => ({
  revokeApiKey: vi.fn(async () => ({ revoked: true })),
  revokeGrantsDurably: vi.fn(async () => undefined),
  writeMarker: vi.fn(async () => ({ status: 'written' })),
  createNotification: vi.fn(async (..._args: unknown[]) => 'n-1'),
  captureException: vi.fn(),
  createActionIntent: vi.fn(),
  cancelActionIntent: vi.fn(),
  validateToolInput: vi.fn(),
  rateLimiter: vi.fn(),
  loadRow: vi.fn(),
  approverRows: [] as Array<{ userId: string }>,
}));

vi.mock('./actionIntents/intentService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./actionIntents/intentService')>();
  return { ...actual, createActionIntent: mocks.createActionIntent, cancelActionIntent: mocks.cancelActionIntent };
});
vi.mock('./aiToolSchemas', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./aiToolSchemas')>()), validateToolInput: mocks.validateToolInput,
}));
vi.mock('./rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./rate-limit')>()), rateLimiter: mocks.rateLimiter,
}));
vi.mock('./redis', () => ({ getRedis: () => ({}) }));
vi.mock('./apiKeyRevocation', () => ({ revokeApiKey: mocks.revokeApiKey }));
vi.mock('../oauth/grantStatus', () => ({ revokeGrantsDurablyInCurrentDbContext: mocks.revokeGrantsDurably }));
vi.mock('../oauth/revocationRetry', () => ({ writeOAuthRevocationMarkerDurably: mocks.writeMarker }));
vi.mock('../oauth/provider', () => ({ ACCESS_TOKEN_TTL_SECONDS: 600 }));
vi.mock('./userNotifications', () => ({ createNotification: mocks.createNotification }));
vi.mock('./sentry', () => ({ captureException: mocks.captureException }));
vi.mock('../middleware/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../middleware/auth')>()),
  withAuthDbAccessContext: (_auth: unknown, fn: () => unknown) => fn(),
}));
vi.mock('../db', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => Object.assign(Promise.resolve(mocks.approverRows), { limit: () => mocks.loadRow() }) }) }),
  },
  withSystemDbAccessContext: vi.fn(async (fn: () => unknown) => fn()),
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
}));

import { cancelOwnedMcpIntent, countLiveMcpIntentsForOrigin, createMcpActionIntent, reportSuspiciousMcpOrigin, type CreateMcpActionIntentInput } from './mcpIntentCreation';
import { ActionIntentError } from './actionIntents/intentService';

const USER = '22222222-2222-4222-8222-222222222222';
const ORG = '33333333-3333-4333-8333-333333333333';
const REQ = '6f2b7c1e-1d2a-4c3b-9e8f-0a1b2c3d4e5f';
const INTENT = '77777777-7777-4777-8777-777777777777';

function input(over: Partial<CreateMcpActionIntentInput> = {}): CreateMcpActionIntentInput {
  return {
    auth: { principal: { kind: 'api_key', apiKeyId: 'key-A' }, user: { id: USER } } as never,
    apiKey: { id: 'key-A', orgId: ORG, name: 'ci key', mcpDomains: null } as never,
    toolName: 'execute_command',
    toolInput: { deviceId: 'd1', command: 'whoami' },
    executionOrgId: ORG,
    correlationRequestId: REQ,
    clientLabel: 'MCP · ci key',
    appBaseUrl: 'https://app.example.com',
    ...over,
  };
}

const row = (over: Record<string, unknown> = {}) => ({
  id: INTENT, status: 'pending_approval', actionName: 'execute_command', approvalScope: 'four_eyes',
  expiresAt: new Date('2027-01-01T00:00:00Z'), result: null, errorCode: null, executedAt: null, ...over,
});

let counters: Map<string, number>;
beforeEach(() => {
  vi.clearAllMocks();
  counters = new Map();
  mocks.validateToolInput.mockReturnValue({ success: true });
  mocks.rateLimiter.mockImplementation(async (_r: unknown, key: string, limit: number) => {
    const n = (counters.get(key) ?? 0) + 1;
    counters.set(key, n);
    return { allowed: n <= limit, remaining: Math.max(0, limit - n), resetAt: new Date() };
  });
  // Default: a new row; invoke the churn charge the way createActionIntent does.
  mocks.createActionIntent.mockImplementation(async (_auth: unknown, i: { beforeInsert?: () => Promise<void> }) => {
    await i.beforeInsert?.();
    return { id: INTENT, status: 'pending_approval' };
  });
  mocks.loadRow.mockResolvedValue([row()]);
});

describe('createMcpActionIntent', () => {
  it('invalid tool input is refused before insert', async () => {
    mocks.validateToolInput.mockReturnValue({ success: false, error: 'command is required' });
    const out = await createMcpActionIntent(input());
    expect(out).toMatchObject({ kind: 'refused', code: 'invalid_params' });
    expect(mocks.createActionIntent).not.toHaveBeenCalled();
  });

  it('org service-principal key → principal_not_supported', async () => {
    const out = await createMcpActionIntent(input({ apiKey: { id: 'key-A', orgId: ORG, principalType: 'service', mcpDomains: null } as never }));
    expect(out).toMatchObject({ kind: 'refused', code: 'principal_not_supported' });
    expect(mocks.createActionIntent).not.toHaveBeenCalled();
  });

  it('partner service principal → principal_not_supported', async () => {
    const out = await createMcpActionIntent(input({
      auth: { principal: { kind: 'api_key', apiKeyId: 'k', partnerServicePrincipalId: 'sp' }, user: { id: USER } } as never,
    }));
    expect(out).toMatchObject({ kind: 'refused', code: 'principal_not_supported' });
  });

  it('passes executionOrgId, source mcp_api, the mcp:v1 idempotency key, correlationId and the label', async () => {
    const out = await createMcpActionIntent(input());
    expect(out).toMatchObject({ kind: 'pending', isNew: true, status: { actionId: INTENT, status: 'pending_approval' } });
    const [, args] = mocks.createActionIntent.mock.calls[0]!;
    expect(args).toMatchObject({
      toolName: 'execute_command', source: 'mcp_api', orgId: ORG, correlationId: REQ,
      requestingClientLabel: 'MCP · ci key', maxLiveForOrigin: 20,
      // #10027: every MCP filing asks for registry-Tier-3 approval of a
      // non-read action rated below Tier 3 (the service applies it only then).
      mcpRegistryTierApproval: true,
    });
    expect(args.idempotencyKey).toMatch(/^mcp:v1:[0-9a-f]{64}$/);
    expect(args.input).toEqual({ deviceId: 'd1', command: 'whoami' });
  });

  // #9758: the epoch the bearer middleware verified rides into the intent row.
  it('an OAuth origin passes the verified auth epoch as originAuthEpoch', async () => {
    await createMcpActionIntent(input({
      auth: { principal: { kind: 'oauth_grant', grantId: 'grant-1' }, user: { id: USER } } as never,
      apiKey: { id: 'oauth:jti', orgId: ORG, oauthGrantId: 'grant-1', oauthAuthEpoch: 4, mcpDomains: null } as never,
    }));
    const [, args] = mocks.createActionIntent.mock.calls[0]!;
    expect(args.originAuthEpoch).toBe(4);
  });

  it('an API-key origin passes no originAuthEpoch', async () => {
    await createMcpActionIntent(input());
    const [, args] = mocks.createActionIntent.mock.calls[0]!;
    expect(args.originAuthEpoch).toBeUndefined();
  });

  it('the argument digest equals the stored argument_digest (same canonicalisation)', async () => {
    const { mcpIntentIdempotencyKey } = await import('./mcpIntentEligibility');
    await createMcpActionIntent(input());
    const [, args] = mocks.createActionIntent.mock.calls[0]!;
    const digest = computeArgumentDigest(canonicalizeArguments({ deviceId: 'd1', command: 'whoami' }));
    expect(args.idempotencyKey).toBe(mcpIntentIdempotencyKey('api_key:key-A', 'execute_command', digest));
  });

  it('same user, different credential: separate idempotency keys', async () => {
    await createMcpActionIntent(input());
    await createMcpActionIntent(input({
      auth: { principal: { kind: 'api_key', apiKeyId: 'key-B' }, user: { id: USER } } as never,
      apiKey: { id: 'key-B', orgId: ORG, name: 'other', mcpDomains: null } as never,
    }));
    const keys = mocks.createActionIntent.mock.calls.map((c) => c[1].idempotencyKey);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('churn guard: the 61st creation in an hour → rate_limited', async () => {
    for (let i = 0; i < 60; i++) {
      expect((await createMcpActionIntent(input())).kind).toBe('pending');
    }
    expect(await createMcpActionIntent(input())).toMatchObject({ kind: 'refused', code: 'rate_limited' });
  });

  it('a replay of a live intent is not charged', async () => {
    mocks.createActionIntent.mockResolvedValue({ id: INTENT, status: 'pending_approval' }); // never calls beforeInsert
    for (let i = 0; i < 65; i++) await createMcpActionIntent(input());
    expect(mocks.rateLimiter).not.toHaveBeenCalled();
  });

  it('per-user guard: one human across two credentials hits rate_limited at 61 creations/hour', async () => {
    const keyB = input({
      auth: { principal: { kind: 'api_key', apiKeyId: 'key-B' }, user: { id: USER } } as never,
      apiKey: { id: 'key-B', orgId: ORG, name: 'other', mcpDomains: null } as never,
    });
    for (let i = 0; i < 30; i++) await createMcpActionIntent(input());
    for (let i = 0; i < 30; i++) await createMcpActionIntent(keyB);
    expect(await createMcpActionIntent(keyB)).toMatchObject({ kind: 'refused', code: 'rate_limited' });
  });

  it.each(['no_eligible_approvers', 'no_eligible_approvers_site_ceiling'])(
    '%s maps to a refusal, not a pending result, and stays charged',
    async (code) => {
      mocks.loadRow.mockResolvedValue([row({ status: 'cancelled', errorCode: code })]);
      mocks.createActionIntent.mockImplementation(async (_a: unknown, i: { beforeInsert?: () => Promise<void> }) => {
        await i.beforeInsert?.();
        return { id: INTENT, status: 'cancelled', errorCode: code };
      });
      expect(await createMcpActionIntent(input())).toMatchObject({ kind: 'refused', code });
      expect(mocks.rateLimiter).toHaveBeenCalled();
    },
  );

  it('too_many_pending_actions and principal_not_supported from createActionIntent map to refusals', async () => {
    mocks.createActionIntent.mockRejectedValueOnce(new ActionIntentError('cap', 'too_many_pending_actions'));
    expect(await createMcpActionIntent(input())).toMatchObject({ kind: 'refused', code: 'too_many_pending_actions' });
    mocks.createActionIntent.mockRejectedValueOnce(new ActionIntentError('sp', 'principal_not_supported'));
    expect(await createMcpActionIntent(input())).toMatchObject({ kind: 'refused', code: 'principal_not_supported' });
  });

  it('a replayed live intent returns pending with isNew false', async () => {
    mocks.createActionIntent.mockResolvedValue({ id: INTENT, status: 'approved', replayed: true });
    mocks.loadRow.mockResolvedValue([row({ status: 'approved' })]);
    expect(await createMcpActionIntent(input())).toMatchObject({
      kind: 'pending', isNew: false, status: { status: 'in_progress', approvalUrl: `https://app.example.com/approvals#intent-${INTENT}` },
    });
  });

  it('caps the client label at 255 characters', async () => {
    await createMcpActionIntent(input({ clientLabel: `MCP · ${'x'.repeat(400)}` }));
    expect(mocks.createActionIntent.mock.calls[0]![1].requestingClientLabel).toHaveLength(255);
  });
});

describe('reportSuspiciousMcpOrigin (B-W04 D-B35)', () => {
  const mcpRow = (o: Record<string, unknown> = {}) => ({
    id: INTENT, orgId: ORG, source: 'mcp_api', originPrincipalKind: 'api_key', originPrincipalId: 'key-A',
    requestedByUserId: USER, requestingClientLabel: 'MCP · ci key', actionName: 'execute_command', ...o,
  });
  const OTHER = '99999999-9999-4999-8999-999999999999';

  it('non-MCP intents return null (today\'s behaviour)', async () => {
    mocks.loadRow.mockResolvedValue([mcpRow({ source: 'chat', originPrincipalKind: 'user_session', originPrincipalId: null })]);
    expect(await reportSuspiciousMcpOrigin(INTENT, USER)).toBeNull();
    mocks.loadRow.mockResolvedValue([mcpRow({ originPrincipalKind: 'user_session', originPrincipalId: null })]);
    expect(await reportSuspiciousMcpOrigin(INTENT, USER)).toBeNull();
  });

  it('api-key intent reported by its requester revokes the key', async () => {
    mocks.loadRow.mockResolvedValue([mcpRow()]);
    expect(await reportSuspiciousMcpOrigin(INTENT, USER)).toEqual({ credentialRevoked: true });
    expect(mocks.revokeApiKey).toHaveBeenCalledWith('key-A', USER, expect.any(String), expect.objectContaining({ includeReasonInAudit: true }));
  });

  it('oauth intent reported by its requester revokes that grant (marker + durable, refresh tokens cascaded)', async () => {
    mocks.loadRow.mockResolvedValue([mcpRow({ originPrincipalKind: 'oauth_grant', originPrincipalId: 'grant-1' })]);
    expect(await reportSuspiciousMcpOrigin(INTENT, USER)).toEqual({ credentialRevoked: true });
    expect(mocks.writeMarker).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ markerType: 'grant', markerId: 'grant-1', userId: USER }));
    expect(mocks.revokeGrantsDurably).toHaveBeenCalledWith(expect.objectContaining({
      grantIds: ['grant-1'], revokedByUserId: USER, cascadeRefreshTokens: true,
    }));
  });

  it('reported by a non-owner approver → no revocation; owner and approvers notified', async () => {
    mocks.loadRow.mockResolvedValue([mcpRow()]);
    mocks.approverRows = [{ userId: OTHER }, { userId: USER }];
    expect(await reportSuspiciousMcpOrigin(INTENT, OTHER)).toEqual({ credentialRevoked: false });
    expect(mocks.revokeApiKey).not.toHaveBeenCalled();
    const notified = mocks.createNotification.mock.calls.map((c) => (c[0] as { userId: string }).userId).sort();
    expect(notified).toEqual([OTHER, USER].sort());
    expect(mocks.createNotification.mock.calls[0]![0]).toMatchObject({ type: 'security', message: expect.stringContaining('MCP · ci key') });
  });

  it('revocation failure → captureException and credentialRevoked false with revocationError', async () => {
    mocks.loadRow.mockResolvedValue([mcpRow()]);
    mocks.revokeApiKey.mockRejectedValueOnce(new Error('db down'));
    expect(await reportSuspiciousMcpOrigin(INTENT, USER)).toEqual({ credentialRevoked: false, revocationError: 'revocation_failed' });
    expect(mocks.captureException).toHaveBeenCalled();
  });

  it('a grant marker queued for retry still counts as revoked only once the durable stamp lands', async () => {
    mocks.loadRow.mockResolvedValue([mcpRow({ originPrincipalKind: 'oauth_grant', originPrincipalId: 'grant-1' })]);
    mocks.writeMarker.mockResolvedValueOnce({ status: 'retry_queued', errorCode: 'redis_unavailable' } as never);
    expect(await reportSuspiciousMcpOrigin(INTENT, USER)).toEqual({ credentialRevoked: true });
    expect(mocks.revokeGrantsDurably).toHaveBeenCalled();
  });
});

describe('B-W04 review fixes', () => {
  const mcpRow = (o: Record<string, unknown> = {}) => ({
    id: INTENT, orgId: ORG, source: 'mcp_api', originPrincipalKind: 'api_key', originPrincipalId: 'key-A',
    requestedByUserId: USER, requestingClientLabel: 'MCP · ci key', actionName: 'execute_command', ...o,
  });
  const OTHER = '99999999-9999-4999-8999-999999999999';
  const THIRD = '88888888-8888-4888-8888-888888888888';

  it('one failed notification does not stop the others', async () => {
    mocks.loadRow.mockResolvedValue([mcpRow()]);
    mocks.approverRows = [{ userId: OTHER }, { userId: THIRD }];
    mocks.createNotification.mockRejectedValueOnce(new Error('insert failed'));
    expect(await reportSuspiciousMcpOrigin(INTENT, OTHER)).toEqual({ credentialRevoked: false });
    expect(mocks.createNotification).toHaveBeenCalledTimes(3);
    expect(mocks.captureException).toHaveBeenCalled();
  });

  it('owner report of a key that is gone reports credentialRevoked false', async () => {
    mocks.loadRow.mockResolvedValueOnce([mcpRow()]).mockResolvedValueOnce([]);
    mocks.revokeApiKey.mockResolvedValueOnce({ revoked: false });
    expect(await reportSuspiciousMcpOrigin(INTENT, USER)).toEqual({ credentialRevoked: false, revocationError: 'not_found' });
  });

  it('owner report of an already-revoked key reports credentialRevoked true', async () => {
    mocks.loadRow.mockResolvedValueOnce([mcpRow()]).mockResolvedValueOnce([{ status: 'revoked' }]);
    mocks.revokeApiKey.mockResolvedValueOnce({ revoked: false });
    expect(await reportSuspiciousMcpOrigin(INTENT, USER)).toEqual({ credentialRevoked: true });
  });
});

describe('cancelOwnedMcpIntent', () => {
  const auth = { principal: { kind: 'api_key', apiKeyId: 'key-A' }, user: { id: USER } } as never;
  const owned = (o: Record<string, unknown> = {}) => ({ ...row(), source: 'mcp_api', originPrincipalKind: 'api_key', originPrincipalId: 'key-A', ...o });

  it('pending → cancelled reports the actual outcome', async () => {
    mocks.loadRow.mockResolvedValueOnce([owned()]).mockResolvedValueOnce([owned({ status: 'cancelled' })]);
    mocks.cancelActionIntent.mockResolvedValueOnce({ ok: true, status: 'cancelled' });
    expect(await cancelOwnedMcpIntent(auth, INTENT, 'https://app.example.com')).toMatchObject({
      kind: 'cancelled', status: { status: 'cancelled' },
    });
  });

  it('lost the CAS to the worker → not_cancellable with the winner\'s status', async () => {
    mocks.loadRow.mockResolvedValueOnce([owned({ status: 'approved' })]).mockResolvedValueOnce([owned({ status: 'executing' })]);
    mocks.cancelActionIntent.mockResolvedValueOnce({ ok: false, status: 'executing' });
    expect(await cancelOwnedMcpIntent(auth, INTENT, 'https://app.example.com')).toMatchObject({
      kind: 'not_cancellable', status: { status: 'in_progress' },
    });
  });

  it('a non-uuid or unowned id is not_found and never reaches cancelActionIntent', async () => {
    expect(await cancelOwnedMcpIntent(auth, 'not-a-uuid', 'https://app.example.com')).toEqual({ kind: 'not_found' });
    mocks.loadRow.mockResolvedValueOnce([]);
    expect(await cancelOwnedMcpIntent(auth, INTENT, 'https://app.example.com')).toEqual({ kind: 'not_found' });
    expect(mocks.cancelActionIntent).not.toHaveBeenCalled();
  });
});

describe('countLiveMcpIntentsForOrigin (B-W06 #6160, D-B52)', () => {
  it('counts the caller origin\'s live mcp_api intents', async () => {
    mocks.approverRows = [{ n: 7 }] as never;
    try {
      expect(await countLiveMcpIntentsForOrigin(input().auth)).toBe(7);
    } finally {
      mocks.approverRows = [];
    }
  });

  it('no row → 0', async () => {
    mocks.approverRows = [];
    expect(await countLiveMcpIntentsForOrigin(input().auth)).toBe(0);
  });

  it('a principal without an origin ref (partner service principal, user session) → 0 without a query', async () => {
    const { withSystemDbAccessContext } = await import('../db');
    vi.mocked(withSystemDbAccessContext).mockClear();
    expect(await countLiveMcpIntentsForOrigin({ principal: { kind: 'user_session' }, user: { id: USER } } as never)).toBe(0);
    expect(withSystemDbAccessContext).not.toHaveBeenCalled();
  });
});
