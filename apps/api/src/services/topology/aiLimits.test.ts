import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ eval: vi.fn(), redis: vi.fn() }));
vi.mock('../redis', () => ({ getRedis: mocks.redis }));

import { consumeTopologyAiBudget, reserveTopologyInvestigation, TOPOLOGY_AI_QUOTAS, TopologyAiLimitError } from './aiLimits';

const ctx = { auth: { user: { id: 'user-1' } }, permissions: {}, scope: { orgId: 'org-1', siteId: 'site-1' } } as never;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.redis.mockReturnValue({ eval: mocks.eval });
});

describe('topology AI limits (M4 Task 3) — failure modes; atomic behaviour is proven against real Redis in topologyAiSessions.integration', () => {
  it('fails AI starts CLOSED when Redis is unavailable or errors', async () => {
    mocks.redis.mockReturnValue(null);
    await expect(reserveTopologyInvestigation(ctx, 'session-1')).rejects.toMatchObject({ code: 'topology_ai_limits_unavailable', status: 503 });
    mocks.redis.mockReturnValue({ eval: vi.fn().mockRejectedValue(new Error('ECONNRESET')) });
    await expect(reserveTopologyInvestigation(ctx, 'session-1')).rejects.toBeInstanceOf(TopologyAiLimitError);
    await expect(consumeTopologyAiBudget('session-1', { readCalls: 1 })).rejects.toMatchObject({ code: 'topology_ai_limits_unavailable' });
  });

  it('maps each refusal to a typed, user-actionable limit error', async () => {
    for (const [answer, code] of [['concurrency', 'topology_ai_concurrency'], ['user_hourly', 'topology_ai_user_hourly'], ['org_daily', 'topology_ai_org_daily']] as const) {
      mocks.eval.mockResolvedValueOnce(answer);
      await expect(reserveTopologyInvestigation(ctx, 'session-1')).rejects.toMatchObject({ code, status: 429 });
    }
    mocks.eval.mockResolvedValueOnce('readCalls');
    await expect(consumeTopologyAiBudget('session-1', { readCalls: 1 })).rejects.toMatchObject({ code: 'topology_ai_budget_exhausted', dimension: 'readCalls' });
  });

  it('applies a LOWER configured ceiling, never a higher one', async () => {
    mocks.eval.mockResolvedValue('ok');
    await reserveTopologyInvestigation(ctx, 'session-1', { limits: { concurrentPerOrg: 1, perUserHour: 50 } });
    const argv = mocks.eval.mock.calls[0]!;
    // [script, numKeys, ...keys(5), sessionId, leaseId, now, expires, maxConcurrent, maxUserHour, maxOrgDay, ...]
    expect(argv[2 + 5 + 4]).toBe('1');
    expect(argv[2 + 5 + 5]).toBe(String(TOPOLOGY_AI_QUOTAS.perUserHour));
  });

  it('releases only its own lease (a replacement lease is never released by an old callback)', async () => {
    mocks.eval.mockResolvedValue('ok');
    const lease = await reserveTopologyInvestigation(ctx, 'session-1');
    await lease.release();
    const releaseCall = mocks.eval.mock.calls[1]!;
    expect(releaseCall).toContain(lease.leaseId);
    expect(releaseCall).toContain('session-1');
  });
});
