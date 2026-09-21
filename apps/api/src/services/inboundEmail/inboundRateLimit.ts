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
 * (jobs/inboundEmailWorker.ts) drives an admit/settle flow, all outside the
 * pipeline's DB context:
 *
 *   1. ADMIT BEFORE opening the pipeline transaction: `admitInboundTicket`
 *      charges each window and checks it in ONE atomic Redis step (ZADD then
 *      ZCARD in a MULTI, via the shared `rateLimiter`). Because the charge and the
 *      count are atomic per window, two concurrent workers cannot both pass the
 *      same slot — the limit is EXACT under concurrency, not merely advisory (the
 *      race a read-only peek-then-charge would have allowed).
 *   2. The pipeline consults that cached verdict at its four create paths only
 *      (never on a reply that appends to an existing ticket — those are never
 *      throttled), with no Redis of its own.
 *   3. SETTLE AFTER the transaction commits: if the message did NOT create a
 *      ticket (throttled, a reply-append, a drop, a dedup, or a quarantine),
 *      `releaseInboundCharges` refunds every window this message charged at
 *      admission. So each window ends up counting REAL creations only — a message
 *      rejected by a broader window leaves NO residual charge in a narrower one.
 *
 * The charge is idempotent per provider-message-id, so an at-least-once
 * redelivery of the SAME message occupies one slot, not N. Admission fails OPEN
 * when Redis is entirely unavailable (a null client ⇒ no charge, not throttled: a
 * Redis blip must not quarantine every inbound ticket; the global BullMQ queue
 * limiter still bounds total throughput and an attacker cannot force Redis
 * offline), but a present-but-erroring Redis fails CLOSED via `rateLimiter`.
 * This module is pure Redis — no DB import — so it holds no connection of its own,
 * and because the worker calls it OUTSIDE the pipeline context the #1105 tripwire
 * inside `rateLimiter` passes (and guards against a future in-context regression).
 * Over-cap mail is quarantined (visible, recoverable), never dropped.
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

export interface InboundAdmission {
  verdict: InboundThrottleVerdict;
  /**
   * The window keys this call actually charged (ZADDed the message into), in
   * charge order. The worker passes these to `releaseInboundCharges` when the
   * message does not go on to create a ticket, so nothing but real creations
   * remains counted. Empty when Redis was unavailable (fail-open, nothing charged).
   */
  chargedKeys: string[];
}

/**
 * Atomically admit ONE would-be ticket creation against every enabled window,
 * tightest (sender) → broadest (partner). Each window is charged-and-checked in a
 * single atomic `rateLimiter` step (ZADD then ZCARD in a MULTI), so concurrent
 * workers serialise on Redis and the limit holds exactly — no two can pass the
 * same slot. Stops at the first window that rejects and reports its bucket. The
 * charge is idempotent per `dedupeMember` (provider message id), so a redelivery
 * of the same message re-occupies its one slot rather than consuming another.
 *
 * Fails OPEN only when Redis is entirely absent (null client ⇒ nothing charged,
 * not throttled). A present-but-erroring Redis fails CLOSED inside `rateLimiter`
 * (denies), which surfaces here as throttled — the safe direction for a flood cap.
 *
 * Runs OUTSIDE any DB context (the worker admits before opening the pipeline
 * transaction), so it holds no pooled connection and the #1105 tripwire passes.
 * The caller MUST release the returned `chargedKeys` if the message ends up NOT
 * creating a ticket, or those charges wrongly persist as phantom creations.
 */
export async function admitInboundTicket(
  redis: Redis | null,
  checks: InboundCapCheck[],
  dedupeMember: string,
): Promise<InboundAdmission> {
  if (!redis || checks.length === 0) return { verdict: { throttled: false, bucket: null }, chargedKeys: [] };
  const chargedKeys: string[] = [];
  for (const c of checks) {
    // Atomic charge-and-check (rateLimiter uses a MULTI: ZADD then ZCARD). The
    // member is added before the count is read, so this window's own charge is
    // included in the decision and concurrent admissions cannot both pass.
    const res = await rateLimiter(redis, c.key, c.limit, WINDOW_SECONDS, 1, { dedupeMember });
    chargedKeys.push(c.key);
    if (!res.allowed) return { verdict: { throttled: true, bucket: c.bucket }, chargedKeys };
  }
  return { verdict: { throttled: false, bucket: null }, chargedKeys };
}

/**
 * Refund an admission: remove this message's member from each window it charged.
 * The worker calls it when the message did NOT create a ticket (throttled, a
 * reply-append, a drop, a dedup, or a quarantine), so a window counts only real
 * creations and a message rejected by a broader window leaves no residual charge
 * in a narrower one. Idempotent (ZREM of an absent member is a no-op) and
 * best-effort: a failed refund only leaves a slot that expires at the window edge,
 * never blocks a created ticket.
 */
export async function releaseInboundCharges(
  redis: Redis | null,
  chargedKeys: string[],
  dedupeMember: string,
): Promise<void> {
  if (!redis || chargedKeys.length === 0) return;
  await Promise.all(
    chargedKeys.map(async (key) => {
      try {
        await redis.zrem(key, dedupeMember);
      } catch (err) {
        console.warn('[InboundEmail] flood charge refund failed (skipped)', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }),
  );
}
