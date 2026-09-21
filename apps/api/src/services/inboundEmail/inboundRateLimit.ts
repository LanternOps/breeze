/**
 * Inbound-email flood protection.
 *
 * A burst of inbound mail must not be able to mint an unbounded number of
 * tickets. Three per-hour sliding-window caps — per sender address, per sender
 * domain, per partner — bound ticket CREATION.
 *
 * WHERE THIS RUNS (#1105): the inbound pipeline runs inside one held
 * `withSystemDbAccessContext` transaction, and a Redis round-trip made while
 * that context is held pins the pooled Postgres connection idle-in-transaction
 * (#1105). So NO Redis happens inside the pipeline. Instead the worker
 * (jobs/inboundEmailWorker.ts) drives a two-phase, all-outside-the-context flow:
 *
 *   1. PEEK (read-only) BEFORE opening the pipeline transaction: is any window
 *      already at its limit? `peekInboundThrottle` uses ZCOUNT and never mutates,
 *      so peeking a message that never creates a ticket charges nothing.
 *   2. The pipeline consults that cached verdict at its four create paths only
 *      (never on a reply that appends to an existing ticket — those must never be
 *      throttled), with no Redis of its own.
 *   3. CHARGE AFTER the transaction commits, and ONLY when a ticket was actually
 *      created (`chargeInboundTickets`). Because a charge is recorded solely for a
 *      real creation, a message rejected by a broader window leaves NO residual
 *      charge in a narrower one — the over-count that a charge-then-check inside
 *      the pipeline produced is gone by construction.
 *
 * The charge is idempotent per provider-message-id, so an at-least-once
 * redelivery of the SAME message occupies one slot, not N (a re-charge of the
 * same member is a no-op — and because nothing is ever refunded, a redelivery can
 * never free the original's slot). Peek and charge both fail OPEN when Redis is
 * unavailable (a Redis blip must not quarantine every inbound ticket; the global
 * BullMQ queue limiter still caps total throughput and an attacker cannot force
 * Redis offline). This module is pure Redis — no DB import — so it holds no
 * connection of its own and cannot trip the #1105 guard. Over-cap mail is
 * quarantined (visible, recoverable), never dropped.
 *
 * DELIBERATE, BOUNDED OVERSHOOT (design decision, Billy 2026-09-20, option A).
 * Because the peek (a read) and the charge (a later write, after the pipeline
 * commits) are NOT one atomic step, concurrent workers can each peek an
 * under-limit window and each go on to create a ticket, so a window can exceed its
 * configured limit by up to the number of in-flight creations for the same
 * sender/domain/partner — bounded by the worker concurrency (5) times the number
 * of API replicas. This is chosen ON PURPOSE over the two alternatives, both of
 * which are worse: (a) an atomic reserve-before-the-pipeline would let a
 * NON-creating in-flight delivery (a dedup, a reply, an unknown-sender drop)
 * transiently quarantine a concurrent LEGITIMATE creation — punishing real
 * customer mail — and, if the reservation were keyed by message-id, a redelivery's
 * refund would free the original ticket's charge (a cap bypass); (b) making the
 * check-and-charge atomic inside the pipeline would require a Redis round-trip
 * inside the held DB transaction (#1105), the very thing this design exists to
 * avoid. For a flood cap whose job is to stop bursts of THOUSANDS, tripping a
 * 200/hour window at ~205 under a simultaneous burst is immaterial, and the global
 * BullMQ queue limiter (INBOUND_QUEUE_MAX_PER_SEC) is the hard throughput bound
 * regardless. The trade accepted here is: the cap is approximate under
 * concurrency, and in exchange it NEVER quarantines a legitimate creation and has
 * no redelivery cap-bypass.
 */

import type { Redis } from 'ioredis';
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

export type InboundCapBucket = 'sender' | 'domain' | 'partner';

export interface InboundCapCheck {
  bucket: InboundCapBucket;
  key: string;
  limit: number;
}

export interface InboundThrottleVerdict {
  throttled: boolean;
  /** Low-cardinality bucket label of the tripped window (never the address). */
  bucket: InboundCapBucket | null;
}

/**
 * The enabled windows for this message, tightest (sender) to broadest (partner),
 * namespaced by partner so one partner's traffic can never consume another's
 * budget. A window with limit 0 (unlimited) or an unparseable key is omitted, so
 * an empty result means "no caps apply" and the caller can skip Redis entirely.
 * Both peek and charge derive their keys from THIS function, so they always agree.
 */
export function buildInboundCapChecks(
  partnerId: string,
  from: string,
  limits: InboundCapLimits,
): InboundCapCheck[] {
  const sender = from.trim().toLowerCase();
  const senderDomain = domainOf(from);
  const checks: InboundCapCheck[] = [];
  if (limits.perSenderPerHour > 0 && sender) {
    checks.push({ bucket: 'sender', key: `inbound:tix:sender:${partnerId}:${sender}`, limit: limits.perSenderPerHour });
  }
  if (limits.perDomainPerHour > 0 && senderDomain) {
    checks.push({ bucket: 'domain', key: `inbound:tix:sdom:${partnerId}:${senderDomain}`, limit: limits.perDomainPerHour });
  }
  if (limits.perPartnerPerHour > 0) {
    checks.push({ bucket: 'partner', key: `inbound:tix:partner:${partnerId}`, limit: limits.perPartnerPerHour });
  }
  return checks;
}

/**
 * READ-ONLY flood peek. Returns the tightest window that is already at its limit
 * (so admitting one more would exceed it), or `{ throttled: false }` when every
 * window has room. Uses ZCOUNT over the live window and NEVER mutates Redis, so a
 * message that is peeked but never creates a ticket charges nothing.
 *
 * Fails OPEN: a null client or any Redis error yields "not throttled" — a Redis
 * blip must not quarantine legitimate mail (the global BullMQ queue limiter still
 * bounds total throughput). Runs OUTSIDE any DB context (the worker peeks before
 * opening the pipeline transaction), so it holds no pooled connection.
 */
export async function peekInboundThrottle(
  redis: Redis | null,
  checks: InboundCapCheck[],
  nowMs: number = Date.now(),
): Promise<InboundThrottleVerdict> {
  if (!redis || checks.length === 0) return { throttled: false, bucket: null };
  const windowStart = nowMs - WINDOW_SECONDS * 1000;
  try {
    for (const c of checks) {
      // Count only members inside the live window; stale ones (trimmed lazily on
      // the next charge) are excluded here so the peek reflects the true rate.
      const count = await redis.zcount(c.key, windowStart, '+inf');
      // At or above the limit ⇒ no room for one more ⇒ throttle this creation.
      if (count >= c.limit) return { throttled: true, bucket: c.bucket };
    }
  } catch (err) {
    // Fail OPEN — never block a ticket on a Redis read error.
    console.warn('[InboundEmail] flood peek failed (open)', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { throttled: false, bucket: null };
  }
  return { throttled: false, bucket: null };
}

/**
 * Record ONE ticket creation against every enabled window. Called by the worker
 * AFTER the pipeline transaction commits and ONLY when a ticket was created, so
 * the windows count real creations and nothing else. Idempotent per
 * `dedupeMember` (the provider message id): a redelivery of the same message
 * re-adds the SAME ZSET member, refreshing its score rather than double-counting.
 *
 * Best-effort and fails OPEN: a null client or a Redis error is swallowed (the
 * worst case is a single uncounted creation — an under-count that never blocks
 * legitimate mail). Runs OUTSIDE any DB context, so it holds no pooled connection.
 */
export async function chargeInboundTickets(
  redis: Redis | null,
  checks: InboundCapCheck[],
  dedupeMember: string,
  nowMs: number = Date.now(),
): Promise<void> {
  if (!redis || checks.length === 0) return;
  const windowStart = nowMs - WINDOW_SECONDS * 1000;
  await Promise.all(
    checks.map(async (c) => {
      try {
        await redis
          .multi()
          .zremrangebyscore(c.key, '-inf', windowStart) // trim expired members
          .zadd(c.key, nowMs, dedupeMember)             // idempotent: one slot per message
          .expire(c.key, WINDOW_SECONDS)
          .exec();
      } catch (err) {
        // Under-count on error, never over-count; never block a created ticket.
        console.warn('[InboundEmail] flood charge failed (skipped)', {
          bucket: c.bucket,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }),
  );
}
