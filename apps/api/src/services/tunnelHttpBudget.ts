/**
 * Network Proxy request budgets (spec 2026-10-06 §9): per-tunnel, per-user and
 * per-agent request rate (Redis sliding window via `rateLimiter`, which fails
 * closed without Redis, like ticket storage) and in-flight concurrency
 * (process-local, like the agentCommandAwait correlation map it protects).
 *
 * These sit behind the per-IP `tunnelhost` global bucket (G7): that one bounds
 * a client address, these bound one user, one tunnel and one bridging agent
 * however many addresses the traffic comes from.
 */
import { getRedis } from './redis';
import { rateLimiter } from './rate-limit';

export const TUNNEL_HTTP_RATE_LIMITS = { user: 1200, tunnel: 900, agent: 2400, windowSeconds: 60 } as const;
export const TUNNEL_HTTP_CONCURRENCY_LIMITS = { user: 24, tunnel: 12, agent: 32 } as const;
export type TunnelBudgetScope = 'user' | 'tunnel' | 'agent';
export interface TunnelBudgetKeys { userId: string; tunnelId: string; agentId: string }

// Narrowest first, so the reported scope is the most specific one exhausted.
const SCOPES: readonly TunnelBudgetScope[] = ['tunnel', 'user', 'agent'];
const idFor = (keys: TunnelBudgetKeys, scope: TunnelBudgetScope) =>
  scope === 'user' ? keys.userId : scope === 'tunnel' ? keys.tunnelId : keys.agentId;

/** Retry hint when the budget store itself is down (not a budget being spent). */
const BUDGET_UNAVAILABLE_RETRY_SECONDS = 5;

export type TunnelRateResult =
  | { ok: true }
  | { ok: false; scope: TunnelBudgetScope; retryAfterSeconds: number }
  // Redis unavailable: still refused (fail closed), but reported as an outage,
  // not as this user/tunnel/agent exhausting a budget.
  | { ok: false; scope: 'unavailable'; retryAfterSeconds: number };

export async function checkTunnelHttpRate(keys: TunnelBudgetKeys): Promise<TunnelRateResult> {
  const redis = getRedis();
  if (!redis) return { ok: false, scope: 'unavailable', retryAfterSeconds: BUDGET_UNAVAILABLE_RETRY_SECONDS };
  for (const scope of SCOPES) {
    const result = await rateLimiter(
      redis,
      `tunnel-http:rate:${scope}:${idFor(keys, scope)}`,
      TUNNEL_HTTP_RATE_LIMITS[scope],
      TUNNEL_HTTP_RATE_LIMITS.windowSeconds,
    );
    if (!result.allowed) {
      return {
        ok: false,
        scope,
        retryAfterSeconds: Math.max(1, Math.ceil((result.resetAt.getTime() - Date.now()) / 1000)),
      };
    }
  }
  return { ok: true };
}

const inFlight = new Map<string, number>();

/**
 * Reserve one in-flight slot in every scope, or none. The caller MUST call
 * `release()` exactly once when the request finishes (it is idempotent, so a
 * `finally` plus an early release is safe).
 */
export function acquireTunnelHttpSlot(
  keys: TunnelBudgetKeys,
): { ok: true; release: () => void } | { ok: false; scope: TunnelBudgetScope } {
  const entries = SCOPES.map((scope) => [scope, `${scope}:${idFor(keys, scope)}`] as const);
  for (const [scope, key] of entries) {
    if ((inFlight.get(key) ?? 0) >= TUNNEL_HTTP_CONCURRENCY_LIMITS[scope]) return { ok: false, scope };
  }
  for (const [, key] of entries) inFlight.set(key, (inFlight.get(key) ?? 0) + 1);
  let released = false;
  return {
    ok: true,
    release: () => {
      if (released) return;
      released = true;
      for (const [, key] of entries) {
        const next = (inFlight.get(key) ?? 1) - 1;
        if (next <= 0) inFlight.delete(key);
        else inFlight.set(key, next);
      }
    },
  };
}

export function __resetTunnelHttpBudgetForTests(): void {
  inFlight.clear();
}
