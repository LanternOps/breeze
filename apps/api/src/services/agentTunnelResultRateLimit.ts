import type { Redis } from 'ioredis';
import { rateLimiter } from './rate-limit';
import { TUNNEL_HTTP_RATE_LIMITS } from './tunnelHttpBudget';

/**
 * Request-rate gate for an agent's REST acknowledgement of a Network Proxy
 * `http_request` command (`POST /api/v1/agents/<id>/commands/http-req-…/result`),
 * applied by agentAuthMiddleware IN PLACE OF the general agent buckets
 * (per-(agent, source-IP), per-agent and per-org). This is the canonical note
 * for #11464's agent-side half; the other sites point here.
 *
 * Why separate: a proxied request's result comes back over the agent
 * WebSocket. Agents released before #11464 ALSO POST it to the REST result
 * route, once per proxied request, and the route answers it as a no-op from the
 * id alone (routes/agents/commands.ts answerRowlessCommandResult). Charged to
 * the general buckets, one asset-heavy device page load exhausted the
 * per-(agent, source-IP) bucket and the agent's own heartbeats were refused.
 * Current agents send no such POST (agent/internal/heartbeat isEphemeralCommand),
 * so this gate only matters while older agents remain.
 *
 * Still bounded, never unmetered. Two sliding 60 s windows:
 *   - per device: AGENT_TUNNEL_RESULT_DEVICE_RATE_LIMIT, sized to the per-agent
 *     host-mode proxy request rate (TUNNEL_HTTP_RATE_LIMITS.agent), so host-mode
 *     traffic never outruns it. Path-mode proxy traffic (routes/tunnelHttp.ts)
 *     is not under that budget and can exceed it; the excess acknowledgements are
 *     refused, which costs nothing because they are no-ops.
 *   - per org, across all its devices: AGENT_TUNNEL_RESULT_ORG_RATE_LIMIT, the
 *     platform ceiling of the general per-org agent bucket, as for brokered
 *     storage sessions.
 *
 * Refusals are free (refundOnReject), so an older agent that retries a refused
 * acknowledgement does not keep itself throttled. Fails closed without Redis,
 * like the general agent limiters (429 with a full-window Retry-After). The
 * agent credential is verified before this gate, unchanged.
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
