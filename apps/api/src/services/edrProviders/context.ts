import type { Redis } from 'ioredis';
import { getRedis } from '../redis';
import { credentialFingerprint } from './credentials';
import { createGuardedFetch } from './guardedFetch';
import { createEdrRateLimiter } from './rateLimiter';
import type { EdrAdapterContext, EdrProviderAdapter } from './types';

/**
 * Build the per-run adapter context: host-allowlisted fetch, a Redis budget
 * keyed by the credential fingerprint (so two connections holding one key share
 * a budget) and a FRESH runCache. A sync run builds ONE context and reuses it
 * for every tenant so connection-wide memoized calls are made once per run.
 * Redis unavailable -> the limiter fails closed.
 */
export function buildEdrAdapterContext(
  adapter: EdrProviderAdapter,
  o: {
    creds: unknown;
    baseUrl: string | null;
    region: string | null;
    /** Accepted for caller compatibility; deliberately NOT part of the budget identity (see below). */
    vendorRootId?: string | null;
    redis?: Redis | null;
  },
): EdrAdapterContext {
  return {
    creds: o.creds,
    baseUrl: o.baseUrl,
    region: o.region,
    fetch: createGuardedFetch(adapter.hostAllowlist),
    // The vendor rate-limits per KEY, so the key alone identifies the budget. Mixing in the root id
    // would give testConnection (no root yet) and sync (real root) separate Redis budgets for one key.
    limiter: createEdrRateLimiter({
      redis: o.redis === undefined ? getRedis() : o.redis,
      fingerprint: credentialFingerprint(adapter.key, null, o.creds),
      budget: adapter.capabilities.requestBudget,
      operationBudgets: adapter.capabilities.operationBudgets,
    }),
    runCache: new Map(),
  };
}
