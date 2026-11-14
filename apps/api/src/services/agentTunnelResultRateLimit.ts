import type { Redis } from 'ioredis';
import { rateLimiter } from './rate-limit';
import { TUNNEL_HTTP_RATE_LIMITS } from './tunnelHttpBudget';

/**
 * Request-rate gate for an agent's HTTP acknowledgement of a Network Proxy
 * `http_request` command (`POST /api/v1/agents/<id>/commands/http-req-…/result`),
 * applied by agentAuthMiddleware IN PLACE OF the general agent buckets
 * (per-(agent, source-IP), per-agent and per-org). #11464.
 *
 * Why separate: each proxied request is an `http_request` command sent over
 * the agent WebSocket, and its response comes back on the same socket. Agents
 * released before #11464 ALSO POST every such result to the REST result
 * route, which answers it as a no-op (the id is not a device_commands UUID).
 * Charged to the general buckets, one device web UI page load (~90 assets)
 * exhausted the 30/min per-(agent, source-IP) bucket, and the agent's own
 * heartbeats were refused with it. Current agents no longer send this POST
 * (agent/internal/heartbeat isEphemeralCommand); this gate is for the agents
 * still in the field.
 *
 * Still bounded, never unmetered. Two sliding 60 s windows:
 *   - per device: AGENT_TUNNEL_RESULT_DEVICE_RATE_LIMIT = the per-agent proxy
 *     request rate (TUNNEL_HTTP_RATE_LIMITS.agent, 2400/min). An agent can be
 *     sent at most that many `http_request` commands a minute, so a legitimate
 *     agent never acknowledges more; anything past it is refused.
 *   - per org, across all its devices: AGENT_TUNNEL_RESULT_ORG_RATE_LIMIT
 *     (20,000/min), the platform ceiling of the general per-org agent bucket,
 *     as for brokered storage sessions.
 *
 * Refusals are free (refundOnReject), so an old agent that retries a refused
 * acknowledgement does not keep itself throttled. Fails closed without Redis.
 * The agent credential is verified before this gate, unchanged.
 */
export const AGENT_TUNNEL_RESULT_RATE_WINDOW_SECONDS = 60;
export const AGENT_TUNNEL_RESULT_DEVICE_RATE_LIMIT = TUNNEL_HTTP_RATE_LIMITS.agent;
/** Equal to DEFAULT_AGENT_ORG_RATE_LIMIT_MAX (agentOrgRateLimit.ts); a literal so this module stays free of database imports. */
export const AGENT_TUNNEL_RESULT_ORG_RATE_LIMIT = 20_000;

export type AgentTunnelResultRateDecision =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

/**
 * Charge one proxy result acknowledgement to its device and org windows.
 * Device first, so an org-wide refusal is only reached by a device within its
 * own ceiling; an org refusal leaves that device's entry counted (stricter,
 * never looser).
 */
export async function checkAgentTunnelResultRateLimit(
  redis: Redis | null,
  input: { orgId: string; deviceId: string },
): Promise<AgentTunnelResultRateDecision> {
  const buckets = [
    { key: `agent_tunnel_result_rate:device:${input.deviceId}`, limit: AGENT_TUNNEL_RESULT_DEVICE_RATE_LIMIT },
    { key: `agent_tunnel_result_rate:org:${input.orgId}`, limit: AGENT_TUNNEL_RESULT_ORG_RATE_LIMIT },
  ];
  for (const bucket of buckets) {
    const check = await rateLimiter(
      redis,
      bucket.key,
      bucket.limit,
      AGENT_TUNNEL_RESULT_RATE_WINDOW_SECONDS,
      1,
      { refundOnReject: true },
    );
    if (!check.allowed) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((check.resetAt.getTime() - Date.now()) / 1000)),
      };
    }
  }
  return { allowed: true };
}
