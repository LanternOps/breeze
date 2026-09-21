/**
 * Inbound-email flood protection.
 *
 * A burst of inbound mail must not be able to mint an unbounded number of
 * tickets (or spend unbounded pipeline work). This applies three per-hour
 * sliding-window caps — per sender address, per sender domain, per partner —
 * at the ticket-creation choke point.
 *
 * WHERE THIS RUNS (#1105): the caller (processInboundEmail) invokes
 * `evaluateInboundThrottle` from inside the pipeline's single held
 * `withSystemDbAccessContext` transaction, so each `rateLimiter` Redis
 * round-trip pins the pooled Postgres connection idle-in-transaction for its
 * duration — the pattern the #1105 tripwire warns about (warn-only by default,
 * prod-safe). This is the SAME accepted tolerance the autoresponder relies on,
 * and it is deliberately bounded to REAL ticket creations: the caller invokes it
 * only at the four create paths, past provider-dedup and the sender-auth gate,
 * so dropped / duplicate / unauthenticated mail never charges a cap and never
 * pins the pool. The tightest-first, short-circuiting bucket order means a
 * charge is usually a single round-trip. The module itself is pure Redis (no DB
 * import) so it holds no connection of its own. If the strict tripwire
 * (DB_CONTEXT_TRIPWIRE_STRICT) makes `rateLimiter` throw, the caller catches it
 * and fails OPEN — a strict deployment logs the skip and still creates the
 * ticket rather than losing it. Over-cap mail is quarantined (visible,
 * recoverable), never dropped.
 */

import type { Redis } from 'ioredis';
import { rateLimiter } from '../rate-limit';
import {
  inboundMaxPerSenderPerHour,
  inboundMaxPerDomainPerHour,
  inboundMaxPerPartnerPerHour,
} from '../../config/env';

const WINDOW_SECONDS = 60 * 60; // 1 hour

/** Effective per-hour caps. 0 ⇒ that window is disabled (unlimited). */
export interface InboundCapLimits {
  perSenderPerHour: number;
  perDomainPerHour: number;
  perPartnerPerHour: number;
}

/** The three per-partner cap overrides (null ⇒ fall back to the env default). */
export interface InboundCapOverrides {
  maxTicketsPerSenderPerHour: number | null;
  maxTicketsPerDomainPerHour: number | null;
  maxTicketsPerPartnerPerHour: number | null;
}

/**
 * Resolve effective caps: a non-null partner override wins (including 0 =
 * unlimited); otherwise the INBOUND_MAX_* env default. Read the env defaults at
 * call time so an operator can retune without a redeploy and so tests can flip them.
 */
export function resolveInboundCapLimits(overrides: InboundCapOverrides): InboundCapLimits {
  return {
    perSenderPerHour: overrides.maxTicketsPerSenderPerHour ?? inboundMaxPerSenderPerHour(),
    perDomainPerHour: overrides.maxTicketsPerDomainPerHour ?? inboundMaxPerDomainPerHour(),
    perPartnerPerHour: overrides.maxTicketsPerPartnerPerHour ?? inboundMaxPerPartnerPerHour(),
  };
}

/** Lowercased domain of an email address, or null when unparseable. */
function domainOf(address: string | null | undefined): string | null {
  if (!address) return null;
  const at = address.lastIndexOf('@');
  if (at <= 0 || at === address.length - 1) return null;
  return address.slice(at + 1).trim().toLowerCase() || null;
}

export interface InboundThrottleVerdict {
  throttled: boolean;
  /** Low-cardinality bucket label of the tripped window (never the address). */
  bucket: 'sender' | 'domain' | 'partner' | null;
}

export interface EvaluateInboundThrottleArgs {
  redis: Redis | null;
  /** Envelope/From sender address. */
  from: string;
  partnerId: string;
  limits: InboundCapLimits;
  /**
   * Stable per-message identity (the provider message id). Makes each window
   * charge idempotent, so an at-least-once redelivery or a transaction-retry of
   * the SAME message counts once, not N times — a legitimate sender is never
   * quarantined for a duplicate the pipeline dedups anyway.
   */
  dedupeMember: string;
}

/**
 * Check the three windows in tightest-to-broadest order and return the first
 * tripped. Each enabled window (limit > 0) records one hit for this message and
 * denies once the hour's count exceeds the limit. `refundOnReject` is left OFF:
 * a flood should stay throttled, and every rejected attempt keeps the window
 * full so an attacker cannot walk the limit by hammering. `rateLimiter` already
 * fails CLOSED (denies) when Redis is unavailable, so a Redis outage throttles
 * rather than opening the floodgates — acceptable, because the alternative is an
 * unbounded ticket factory. A window with limit 0 is skipped entirely.
 */
export async function evaluateInboundThrottle(
  args: EvaluateInboundThrottleArgs,
): Promise<InboundThrottleVerdict> {
  const { redis, from, partnerId, limits, dedupeMember } = args;

  // Redis unavailable ⇒ do NOT throttle. Deliberate fail-OPEN, unlike rateLimiter's
  // own fail-closed. `getRedis()` returns null only after the general Redis client
  // has hit a connection error; there is a narrow window where BullMQ's separate
  // connection has recovered (so jobs resume) before that client does, and during
  // it the per-sender/domain/partner caps are briefly not enforced. That is an
  // accepted trade: quarantining every inbound ticket on a Redis blip is worse than
  // briefly not metering, the window is bounded by client reconnect, the global
  // BullMQ queue limiter still caps total throughput, and an attacker cannot force
  // Redis null. (Redis present-but-erroring still fails CLOSED via rateLimiter.)
  if (!redis) return { throttled: false, bucket: null };

  const sender = from.trim().toLowerCase();
  const senderDomain = domainOf(from);

  // Namespaced by partner so one partner's traffic can never consume another's
  // sender/domain budget (multi-tenant isolation of the rate windows).
  const checks: Array<{ bucket: InboundThrottleVerdict['bucket']; key: string; limit: number }> = [];
  if (limits.perSenderPerHour > 0 && sender) {
    checks.push({ bucket: 'sender', key: `inbound:tix:sender:${partnerId}:${sender}`, limit: limits.perSenderPerHour });
  }
  if (limits.perDomainPerHour > 0 && senderDomain) {
    checks.push({ bucket: 'domain', key: `inbound:tix:sdom:${partnerId}:${senderDomain}`, limit: limits.perDomainPerHour });
  }
  if (limits.perPartnerPerHour > 0) {
    checks.push({ bucket: 'partner', key: `inbound:tix:partner:${partnerId}`, limit: limits.perPartnerPerHour });
  }

  for (const c of checks) {
    // cost 1, idempotent per message: a redelivery/retry of the same message
    // refreshes its single slot rather than consuming another.
    const res = await rateLimiter(redis, c.key, c.limit, WINDOW_SECONDS, 1, { dedupeMember });
    if (!res.allowed) return { throttled: true, bucket: c.bucket };
  }
  return { throttled: false, bucket: null };
}
