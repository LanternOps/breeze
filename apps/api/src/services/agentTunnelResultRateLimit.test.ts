import { beforeEach, describe, expect, it, vi } from 'vitest';

const { rateLimiterMock } = vi.hoisted(() => ({ rateLimiterMock: vi.fn() }));
vi.mock('./rate-limit', () => ({ rateLimiter: rateLimiterMock }));

import {
  AGENT_TUNNEL_RESULT_DEVICE_RATE_LIMIT,
  AGENT_TUNNEL_RESULT_ORG_RATE_LIMIT,
  checkAgentTunnelResultRateLimit,
} from './agentTunnelResultRateLimit';
import { TUNNEL_HTTP_RATE_LIMITS } from './tunnelHttpBudget';
import { DEFAULT_AGENT_ORG_RATE_LIMIT_MAX } from './agentOrgRateLimit';

const redis = {} as never;
const input = { orgId: 'org-1', deviceId: 'device-1' };
const allowed = () => ({ allowed: true, remaining: 1, resetAt: new Date(Date.now() + 60_000) });
const refusedFor = (ms: number) => ({ allowed: false, remaining: 0, resetAt: new Date(Date.now() + ms) });

beforeEach(() => {
  rateLimiterMock.mockReset();
  rateLimiterMock.mockResolvedValue(allowed());
});

describe('checkAgentTunnelResultRateLimit (#11464)', () => {
  it('sizes the device window to the host-mode per-agent proxy rate and the org window to the platform ceiling', () => {
    expect(AGENT_TUNNEL_RESULT_DEVICE_RATE_LIMIT).toBe(TUNNEL_HTTP_RATE_LIMITS.agent);
    expect(AGENT_TUNNEL_RESULT_ORG_RATE_LIMIT).toBe(DEFAULT_AGENT_ORG_RATE_LIMIT_MAX);
  });

  it('charges the device window, then the org window, both refund-on-reject over 60 s', async () => {
    expect(await checkAgentTunnelResultRateLimit(redis, input)).toEqual({ allowed: true });
    expect(rateLimiterMock.mock.calls).toEqual([
      [redis, 'agent_tunnel_result_rate:device:device-1', AGENT_TUNNEL_RESULT_DEVICE_RATE_LIMIT, 60, 1, { refundOnReject: true }],
      [redis, 'agent_tunnel_result_rate:org:org-1', AGENT_TUNNEL_RESULT_ORG_RATE_LIMIT, 60, 1, { refundOnReject: true }],
    ]);
  });

  it('a device refusal does not touch the org window', async () => {
    rateLimiterMock.mockResolvedValueOnce(refusedFor(30_000));
    const decision = await checkAgentTunnelResultRateLimit(redis, input);
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.retryAfterSeconds).toBeGreaterThanOrEqual(29);
    expect(rateLimiterMock).toHaveBeenCalledTimes(1);
  });

  it('an org refusal refuses the call, with a Retry-After of at least one second', async () => {
    rateLimiterMock.mockResolvedValueOnce(allowed()).mockResolvedValueOnce(refusedFor(-5_000));
    expect(await checkAgentTunnelResultRateLimit(redis, input)).toEqual({ allowed: false, retryAfterSeconds: 1 });
  });
});
