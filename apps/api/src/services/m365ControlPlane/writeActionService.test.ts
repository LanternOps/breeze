import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { M365WriteAction } from '@breeze/shared/m365';

/**
 * writeActionService is the security-critical write-side authz ladder:
 * feature flag (no DB) -> load connection (ambient RLS) -> readiness
 * (missing/wrong-org/status/no-tenant -> connection_not_ready) -> budget
 * (write_rate_limited) -> executor call (executor_unavailable) -> executor
 * result. Every fail-closed branch must be proven to NEVER call the
 * executor — mirrors the Task 7 lesson (a fail-closed branch that still lets
 * the mutating call through is the actual bug class this ladder exists to
 * prevent). Mock declarations use vi.hoisted (not bare module-scope consts)
 * because vi.mock factories are hoisted above the rest of the file and
 * referencing a non-"mock"-prefixed outer const throws — same pattern as
 * readActionService.test.ts / connectionService.test.ts in this directory.
 */
const { enabled, budget, executeWriteAction, connRows, recordEvent } = vi.hoisted(() => ({
  enabled: vi.fn(),
  budget: vi.fn(),
  executeWriteAction: vi.fn(),
  connRows: vi.fn(),
  recordEvent: vi.fn(),
}));

vi.mock('./writeActionRuntimeConfig', () => ({
  isM365GraphActionsEnabledForOrg: (o: string) => enabled(o),
  loadM365CustomerGraphActionsRuntimeConfig: () => ({
    executorUrl: 'https://x/',
    executorAudience: 'm365-graph-actions-executor',
    executorSigningPrivateJwk: {},
    executorSigningKid: 'k',
  }),
}));
vi.mock('./writeActionBudget', () => ({
  consumeM365WriteActionBudget: (id: string) => budget(id),
}));
vi.mock('./graphActionsExecutorClient', () => ({
  createGraphActionsExecutorClient: () => ({ executeWriteAction }),
  GraphActionsExecutorClientError: class extends Error {},
}));
vi.mock('./writeActionMetrics', () => ({
  recordM365WriteActionEvent: (...a: unknown[]) => recordEvent(...a),
}));
vi.mock('../../db', () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: () => connRows() }) }) }) },
}));
vi.mock('../../db/schema', () => ({
  m365Connections: { orgId: 'orgId', profile: 'profile' },
}));

import { executeM365WriteActionByOrg } from './writeActionService';
import { GraphActionsExecutorClientError } from './graphActionsExecutorClient';

const ORG = '44444444-4444-4444-8444-444444444444';
const TENANT = '22222222-2222-4222-8222-222222222222';
const action: M365WriteAction = { type: 'm365.user.disable', userIdentifier: 'a@b.com', reason: 'x' };

beforeEach(() => {
  vi.clearAllMocks();
  enabled.mockReturnValue(true);
  budget.mockResolvedValue({ allowed: true });
  connRows.mockResolvedValue([
    { id: 'conn-1', orgId: ORG, profile: 'customer-graph-actions', status: 'active', tenantId: TENANT },
  ]);
  executeWriteAction.mockResolvedValue({ success: true, action: 'm365.user.disable', userId: 'u1' });
});

describe('executeM365WriteActionByOrg', () => {
  it('runs the happy path, calls the executor once, and audits ok', async () => {
    const r = await executeM365WriteActionByOrg(ORG, action);
    expect(r).toEqual({ ok: true, result: { success: true, action: 'm365.user.disable', userId: 'u1' } });
    expect(executeWriteAction).toHaveBeenCalledTimes(1);
    expect(recordEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ orgId: ORG, connectionId: 'conn-1', actionType: 'm365.user.disable', outcome: 'ok' }),
    );
  });

  it('refuses when the flag is off (no DB, no executor)', async () => {
    enabled.mockReturnValue(false);
    const r = await executeM365WriteActionByOrg(ORG, action);
    expect(r).toMatchObject({ ok: false, code: 'tools_disabled' });
    expect(connRows).not.toHaveBeenCalled();
    expect(budget).not.toHaveBeenCalled();
    expect(executeWriteAction).not.toHaveBeenCalled();
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it('fails closed when there is no connection row at all', async () => {
    connRows.mockResolvedValue([]);
    const r = await executeM365WriteActionByOrg(ORG, action);
    expect(r).toMatchObject({ ok: false, code: 'connection_not_ready' });
    expect(budget).not.toHaveBeenCalled();
    expect(executeWriteAction).not.toHaveBeenCalled();
  });

  it('fails closed when the connection is for a different org (defense-in-depth over RLS)', async () => {
    connRows.mockResolvedValue([
      { id: 'conn-2', orgId: 'other-org', profile: 'customer-graph-actions', status: 'active', tenantId: TENANT },
    ]);
    const r = await executeM365WriteActionByOrg(ORG, action);
    expect(r).toMatchObject({ ok: false, code: 'connection_not_ready' });
    expect(budget).not.toHaveBeenCalled();
    expect(executeWriteAction).not.toHaveBeenCalled();
  });

  it('fails closed when the connection is revoked', async () => {
    connRows.mockResolvedValue([
      { id: 'conn-1', orgId: ORG, profile: 'customer-graph-actions', status: 'revoked', tenantId: TENANT },
    ]);
    const r = await executeM365WriteActionByOrg(ORG, action);
    expect(r).toMatchObject({ ok: false, code: 'connection_not_ready' });
    expect(budget).not.toHaveBeenCalled();
    expect(executeWriteAction).not.toHaveBeenCalled();
  });

  it('fails closed when the connection is degraded (write side is stricter than read: active-only)', async () => {
    connRows.mockResolvedValue([
      { id: 'conn-1', orgId: ORG, profile: 'customer-graph-actions', status: 'degraded', tenantId: TENANT },
    ]);
    const r = await executeM365WriteActionByOrg(ORG, action);
    expect(r).toMatchObject({ ok: false, code: 'connection_not_ready' });
    expect(executeWriteAction).not.toHaveBeenCalled();
  });

  it('fails closed when the connection has no verified tenant', async () => {
    connRows.mockResolvedValue([
      { id: 'conn-1', orgId: ORG, profile: 'customer-graph-actions', status: 'active', tenantId: null },
    ]);
    const r = await executeM365WriteActionByOrg(ORG, action);
    expect(r).toMatchObject({ ok: false, code: 'connection_not_ready' });
    expect(executeWriteAction).not.toHaveBeenCalled();
  });

  it('refuses when the budget denies (no executor call)', async () => {
    budget.mockResolvedValue({ allowed: false, retryAfterSeconds: 60 });
    const r = await executeM365WriteActionByOrg(ORG, action);
    expect(r).toMatchObject({ ok: false, code: 'write_rate_limited', retryAfterSeconds: 60 });
    expect(executeWriteAction).not.toHaveBeenCalled();
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it('reports executor_unavailable and audits it when the executor client throws', async () => {
    executeWriteAction.mockRejectedValue(new GraphActionsExecutorClientError());
    const r = await executeM365WriteActionByOrg(ORG, action);
    expect(r).toMatchObject({ ok: false, code: 'executor_unavailable' });
    expect(recordEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ outcome: 'executor_unavailable' }),
    );
  });

  it('rethrows unexpected (non-executor-client) errors instead of swallowing them', async () => {
    executeWriteAction.mockRejectedValue(new Error('boom'));
    await expect(executeM365WriteActionByOrg(ORG, action)).rejects.toThrow('boom');
  });

  it('returns the executor-reported failure code and audits it, never the raw result contents', async () => {
    executeWriteAction.mockResolvedValue({ success: false, errorCode: 'user_not_found' });
    const r = await executeM365WriteActionByOrg(ORG, action);
    expect(r).toMatchObject({ ok: false, code: 'user_not_found' });
    expect(recordEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ outcome: 'user_not_found' }),
    );
  });

  it('never leaks a temporary password into the audit event details', async () => {
    executeWriteAction.mockResolvedValue({
      success: true,
      action: 'm365.user.reset_password',
      userId: 'u1',
      temporaryPassword: 'SUPER-SECRET-DO-NOT-LOG',
      forceChangeNextSignIn: true,
    });
    const r = await executeM365WriteActionByOrg(ORG, {
      type: 'm365.user.reset_password',
      userIdentifier: 'a@b.com',
      reason: 'x',
    });
    expect(r).toMatchObject({ ok: true });
    const call = recordEvent.mock.calls[0];
    expect(JSON.stringify(call)).not.toContain('SUPER-SECRET-DO-NOT-LOG');
  });
});
