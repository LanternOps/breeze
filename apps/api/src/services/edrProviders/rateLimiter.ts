import type { Redis } from 'ioredis';
import { rateLimiter } from '../rate-limit';
import { EdrProviderRequestError, type EdrCapabilities, type EdrRateLimiter } from './types';

type Window = { name: string; limit: number; seconds: number };

function windowsOf(b: { perSecond?: number; perMinute?: number; perHour?: number; perDay?: number } | undefined): Window[] {
  if (!b) return [];
  const out: Window[] = [];
  if (b.perSecond) out.push({ name: 's', limit: b.perSecond, seconds: 1 });
  if (b.perMinute) out.push({ name: 'm', limit: b.perMinute, seconds: 60 });
  if (b.perHour) out.push({ name: 'h', limit: b.perHour, seconds: 3600 });
  if (b.perDay) out.push({ name: 'd', limit: b.perDay, seconds: 86400 });
  return out;
}

/**
 * Redis sliding-window budget shared by every connection holding the same
 * credential (key = credential fingerprint, spec 4.4). Fails CLOSED when Redis
 * is unavailable: an unthrottled vendor call could get the customer's key
 * banned. Must run outside a held DB context (the rateLimiter tripwire).
 */
export function createEdrRateLimiter(o: {
  redis: Redis | null;
  fingerprint: string;
  budget: EdrCapabilities['requestBudget'];
  operationBudgets?: EdrCapabilities['operationBudgets'];
  maxWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Share of the credential-wide windows held back for response actions
   * (spec §4.4, W03). Applies only when the adapter declares an `actions`
   * operation class: every other class is admitted while usage is below
   * `floor(limit * (1 - reserve))` (never below 1); `actions` may use the full
   * limit. The `actions` class's own window caps actions, so they cannot
   * starve polling either (the polling floor).
   */
  actionReserveFraction?: number;
}): EdrRateLimiter {
  const maxWaitMs = o.maxWaitMs ?? 60_000;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const reserve = o.operationBudgets?.actions ? (o.actionReserveFraction ?? 0.2) : 0;
  const sharedLimit = (limit: number, operationClass: string | undefined): number =>
    operationClass === 'actions' || reserve <= 0 ? limit : Math.max(1, Math.floor(limit * (1 - reserve)));

  return {
    async acquire(operationClass?: string): Promise<void> {
      if (!o.redis) {
        throw new EdrProviderRequestError('Rate-limit store unavailable; refusing an unthrottled vendor call', {
          code: 'rate_budget_exhausted',
          reauth: false,
          scope: 'connection',
        });
      }
      const checks: Array<{ key: string; w: Window }> = windowsOf(o.budget).map((w) => ({
        key: `edr:${o.fingerprint}:${w.name}`,
        w: { ...w, limit: sharedLimit(w.limit, operationClass) },
      }));
      if (operationClass) {
        for (const w of windowsOf(o.operationBudgets?.[operationClass])) {
          checks.push({ key: `edr:${o.fingerprint}:${w.name}:${operationClass}`, w });
        }
      }

      let waited = 0;
      for (;;) {
        let retryAfterMs = 0;
        for (const { key, w } of checks) {
          const res = await rateLimiter(o.redis, key, w.limit, w.seconds, 1, { refundOnReject: true });
          if (!res.allowed) {
            retryAfterMs = Math.max(retryAfterMs, res.resetAt.getTime() - Date.now(), 50);
            break;
          }
        }
        if (retryAfterMs === 0) return;
        if (waited + retryAfterMs > maxWaitMs) {
          throw new EdrProviderRequestError('Vendor request budget exhausted', {
            code: 'rate_budget_exhausted',
            reauth: false,
            scope: 'connection',
            retryAfterMs,
          });
        }
        waited += retryAfterMs;
        await sleep(retryAfterMs);
      }
    },
  };
}
