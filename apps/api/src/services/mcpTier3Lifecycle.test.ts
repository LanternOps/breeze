import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  createAuditLogAsync: vi.fn(async () => undefined),
  begin: vi.fn(),
  complete: vi.fn(async () => undefined),
  existingAudit: [] as unknown[],
}));

vi.mock('./auditService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./auditService')>()),
  createAuditLogAsync: mocks.createAuditLogAsync,
}));
vi.mock('./mcpToolExecutionLedger', () => ({
  beginMcpToolExecutionLedger: mocks.begin,
  completeMcpToolExecutionLedger: mocks.complete,
}));
vi.mock('../db', () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => mocks.existingAudit }) }) }) },
  withSystemDbAccessContext: vi.fn(async (fn: () => unknown) => fn()),
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
}));

import { Hono } from 'hono';
import {
  beginMcpReleaseLifecycle,
  requestAuditSink,
  runMcpTier3Lifecycle,
  systemAuditSink,
  writeMcpIntentOutcomeAudit,
  writeMcpToolAuditEvent,
} from './mcpTier3Lifecycle';
import type { McpRequestCorrelation } from './mcpRequestCorrelation';
import type { ActionIntent } from '../db/schema/actionIntents';

const ORG = '33333333-3333-4333-8333-333333333333';
const USER = '22222222-2222-4222-8222-222222222222';
const KEY = '11111111-1111-4111-8111-111111111111';
const INTENT = '77777777-7777-4777-8777-777777777777';

const auth = {
  principal: { kind: 'api_key', apiKeyId: KEY }, user: { id: USER }, token: {}, orgId: ORG, partnerId: null,
  accessibleOrgIds: [ORG], scope: 'organization',
} as never;
const correlation: McpRequestCorrelation = {
  requestId: '6f2b7c1e-1d2a-4c3b-9e8f-0a1b2c3d4e5f', era: 'legacy', protocolVersion: '2025-11-25' as never,
  transport: 'streamable_http', sessionId: null, principalKey: `api_key:${KEY}`, tokenJti: null, clientInfo: null,
};
const principal = { id: KEY, orgId: ORG, partnerId: null, oauthGrantId: null, partnerServicePrincipalId: null };

const intent = (o: Partial<ActionIntent> = {}) => ({
  id: INTENT, orgId: ORG, actionName: 'execute_command', arguments: { deviceId: 'd1', command: 'whoami' }, riskTier: 3,
  correlationId: correlation.requestId, originPrincipalKind: 'api_key', originPrincipalId: KEY, ...o,
}) as ActionIntent;

async function honoContext(): Promise<any> {
  let captured: unknown;
  const app = new Hono();
  app.get('/', (c) => { captured = c; return c.text('ok'); });
  await app.request('/', { headers: { 'user-agent': 'test-agent' } });
  return captured;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.existingAudit = [];
  mocks.begin.mockResolvedValue({ sessionId: 's-1', executionId: 'e-1', orgId: ORG, aiOrigin: { kind: 'ai_assistant', sessionId: 's-1' } });
});

describe('audit sinks', () => {
  it('the request sink and the system sink write identical details except ip/userAgent', async () => {
    const event = {
      principal, auth, correlation, orgId: ORG, toolName: 'execute_command', tier: 3,
      toolInput: { deviceId: 'd1' }, durationMs: 5, status: 'success' as const, result: 'ok',
    };
    writeMcpToolAuditEvent(requestAuditSink(await honoContext()), event);
    writeMcpToolAuditEvent(systemAuditSink, event);
    await new Promise((r) => setImmediate(r));
    expect(mocks.createAuditLogAsync).toHaveBeenCalledTimes(2);
    const [req, sys] = mocks.createAuditLogAsync.mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(req!.userAgent).toBe('test-agent');
    expect(sys!.userAgent).toBeUndefined();
    expect(sys!.ipAddress).toBeUndefined();
    expect(sys!.details).toEqual(req!.details);
    expect(sys!.action).toBe('mcp.tool.execute_command');
  });

  it('requestAuditSink(undefined) is null, so the audit is skipped exactly as before', () => {
    expect(requestAuditSink(undefined)).toBeNull();
  });
});

describe('runMcpTier3Lifecycle', () => {
  it('ledger unavailable → the caller-supplied response, execute never runs', async () => {
    mocks.begin.mockRejectedValueOnce(new Error('db down'));
    const execute = vi.fn();
    const out = await runMcpTier3Lifecycle(
      { audit: null, auth, principal, correlation, orgId: ORG, toolName: 'execute_command', tier: 3, toolInput: {} },
      execute,
      { ledgerUnavailable: () => 'LEDGER_DOWN', unexpectedThrow: () => 'THREW' },
    );
    expect(out).toBe('LEDGER_DOWN');
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('beginMcpReleaseLifecycle', () => {
  it('opens the ledger with intent_id and era release, then completes + audits once', async () => {
    const lc = await beginMcpReleaseLifecycle(intent(), auth);
    expect(lc).not.toBeNull();
    expect(mocks.begin).toHaveBeenCalledWith(expect.objectContaining({
      intentId: INTENT, era: 'release', orgId: ORG, toolName: 'execute_command',
      principal: expect.objectContaining({ apiKeyId: KEY, actorUserId: USER }),
    }));
    expect(lc!.auth).toMatchObject({ aiOrigin: { kind: 'ai_assistant', sessionId: 's-1' } });
    await lc!.finish({ status: 'success', ledgerResult: 'ok' });
    await lc!.finish({ status: 'success', ledgerResult: 'ok' });
    expect(mocks.complete).toHaveBeenCalledTimes(1);
    await new Promise((r) => setImmediate(r));
    expect(mocks.createAuditLogAsync).toHaveBeenCalledTimes(1);
    expect(mocks.createAuditLogAsync.mock.calls[0]![0]).toMatchObject({
      action: 'mcp.tool.execute_command',
      details: expect.objectContaining({ correlation: expect.objectContaining({ kind: 'intent_release', intentId: INTENT }) }),
    });
  });

  it('ledger begin failure → null (the worker must not dispatch)', async () => {
    mocks.begin.mockRejectedValueOnce(new Error('db down'));
    expect(await beginMcpReleaseLifecycle(intent(), auth)).toBeNull();
  });

  it('an OAuth origin records the grant as the principal', async () => {
    const oauthAuth = { ...(auth as object), principal: { kind: 'oauth_grant', grantId: 'g-1' } } as never;
    await beginMcpReleaseLifecycle(intent({ originPrincipalKind: 'oauth_grant', originPrincipalId: 'g-1' }), oauthAuth);
    expect(mocks.begin).toHaveBeenCalledWith(expect.objectContaining({
      principal: expect.objectContaining({ apiKeyId: 'oauth:grant:g-1', oauthGrantId: 'g-1' }),
    }));
  });
});

describe('writeMcpIntentOutcomeAudit', () => {
  it('writes one failure audit with intentOutcome', async () => {
    await writeMcpIntentOutcomeAudit(intent(), 'rejected');
    await new Promise((r) => setImmediate(r));
    expect(mocks.createAuditLogAsync).toHaveBeenCalledWith(expect.objectContaining({
      action: 'mcp.tool.execute_command', resourceType: 'action_intent', resourceId: INTENT, result: 'failure',
      details: expect.objectContaining({ intentOutcome: 'rejected' }),
    }));
  });

  it('terminal audit is written once under redelivery (an existing row makes it a no-op)', async () => {
    mocks.existingAudit = [{ id: 'audit-1' }];
    await writeMcpIntentOutcomeAudit(intent(), 'rejected');
    await new Promise((r) => setImmediate(r));
    expect(mocks.createAuditLogAsync).not.toHaveBeenCalled();
  });

  it('release_refused carries the errorCode', async () => {
    await writeMcpIntentOutcomeAudit(intent(), 'release_refused', 'mcp_origin_revoked');
    await new Promise((r) => setImmediate(r));
    expect(mocks.createAuditLogAsync).toHaveBeenCalledWith(expect.objectContaining({
      details: expect.objectContaining({ intentOutcome: 'release_refused', errorCode: 'mcp_origin_revoked' }),
    }));
  });
});
