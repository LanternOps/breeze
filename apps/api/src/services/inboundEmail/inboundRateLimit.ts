/**
 * Inbound-email flood protection.
 *
 * A burst of inbound mail must not be able to mint an unbounded number of
 * tickets (or spend unbounded pipeline work). This applies three per-hour
 * sliding-window caps — per sender address, per sender domain, per partner —
 * BEFORE the ticket-creation transaction runs.
 *
 * WHY THIS LIVES IN THE WORKER, NOT IN processInboundEmail: the pipeline runs
 * inside one held `withSystemDbAccessContext` transaction, and a `rateLimiter`
 * call is a Redis round-trip that pins the pooled Postgres connection
 * idle-in-transaction for its duration (#1105). The autoresponder tolerates this
 * because it fires only on the fresh-ticket / known-sender subset; a per-MESSAGE
 * check would pin the pool on every inbound email — the exact scale #1105 warns
 * about. So this module is pure Redis (no DB import), runs OUTSIDE any DB
 * context in the worker, and its verdict is passed into the pipeline as a
 * dependency. Over-cap mail is quarantined (visible, recoverable), never dropped.
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
  const { redis, from, partnerId, limits } = args;

  // Redis unavailable ⇒ do NOT throttle. This is a deliberate fail-OPEN, unlike
  // rateLimiter's own fail-closed: the inbound worker only runs when BullMQ (also
  // Redis-backed) is delivering jobs, so a truly absent Redis means the pipeline
  // is not processing at all — quarantining every ticket on a Redis blip would be
  // strictly worse than briefly not enforcing the per-sender cap, and the global
  // BullMQ queue limiter still bounds total throughput. An attacker cannot force
  // Redis to be null. (Redis present-but-erroring still fails closed via rateLimiter.)
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
    const res = await rateLimiter(redis, c.key, c.limit, WINDOW_SECONDS);
    if (!res.allowed) return { throttled: true, bucket: c.bucket };
  }
  return { throttled: false, bucket: null };
}
