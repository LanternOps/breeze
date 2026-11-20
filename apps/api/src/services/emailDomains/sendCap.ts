import { getRedis } from '../redis';
import { recordCapHit } from './capHits';
import { getEmailDomainsConfig } from './config';

/**
 * Daily partner-lane send cap (spec §9.1).
 *
 * A fixed-window counter per partner per UTC day, incremented and expired in
 * ONE round trip — the `services/m365ControlPlane/readActionBudget.ts` idiom,
 * on the same shared `getRedis()` client as the feature's other Redis state
 * (`services/emailDomains/keyProbe.ts`).
 * The increment happens even on the call that trips the limit: a denied send
 * still cost a slot, which makes the cap slightly conservative under bursts,
 * the safe direction for an abuse control.
 *
 * THREE VERDICTS (countPartnerLaneSend):
 * - `allowed`     — under the cap (or the cap is 0 = unlimited).
 * - `over_cap`    — a genuine count past the cap. For the `internal` bucket
 *                   resolveSender HOLDS the send (EmailSendHeldError, retry at
 *                   the next window): moving it to the platform sender would let
 *                   a partner exceed a partner-level limit on the platform
 *                   domain. For the `external` bucket it sends on the platform
 *                   lane instead, so an outsider cannot stop the partner's mail.
 * - `unavailable` — Redis could not answer. The send goes out on the PLATFORM
 *                   lane. That is the only option that satisfies both halves of
 *                   the contract at once: nothing is lost (spec G3 — the
 *                   platform lane still delivers the message from EMAIL_FROM),
 *                   and an outage cannot silently lift the cap on
 *                   partner-domain mail. Failing "open to the partner lane"
 *                   would turn a Redis blip into unbounded sending from customer
 *                   domains; holding would stop every partner's mail whenever
 *                   our own cache blips. Cf. readActionBudget.ts, which fails
 *                   closed but has no second lane to fall to.
 */

/** TTL comfortably past the window so a clock skew cannot orphan the counter. */
const CAP_KEY_TTL_SECONDS = 90_000; // 25 h

/**
 * Which daily budget a send spends (#12249). Mail an outsider can cause —
 * an inbound-email autoresponse, a portal self-registration or password-reset
 * mail, a trust-page access confirmation — counts against `external`, so it can
 * never spend the budget the partner's own mail (`internal`) draws on. The call
 * site decides, not the purpose: the inbound autoresponse and a technician's
 * reply share `ticket.customer_notification`. Both buckets use the same daily
 * cap value.
 */
export type PartnerLaneCapBucket = 'internal' | 'external';

export function partnerLaneCapKey(partnerId: string, now: number, bucket: PartnerLaneCapBucket): string {
  const day = new Date(now).toISOString().slice(0, 10); // YYYY-MM-DD, UTC
  // The internal key is the pre-#12249 key unchanged, so a deploy mid-day keeps
  // the count already spent.
  return bucket === 'internal'
    ? `email-domains:partner-lane-sends:${partnerId}:${day}`
    : `email-domains:partner-lane-sends:external:${partnerId}:${day}`;
}

/** The start of the next daily window (00:00 UTC strictly after `now`): when an over-cap send can go out. */
export function nextCapWindowStart(now: number): Date {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));
}

/**
 * The daily cap was reached for this partner. W06 owns the abuse-signal
 * producer (spec §9.2) and wires it here; W04 records the structured line so
 * the event is observable from day one.
 *
 * Called ONLY on a genuine over-cap count — never on a Redis outage, which
 * also returns false. A signal that cannot tell the two apart would accuse a
 * partner of abuse every time our own cache went down.
 */
export function recordPartnerLaneCapHit(partnerId: string): void {
  console.warn('[emailDomains/sendCap] daily partner-lane cap reached', { partnerId });
  // W06: make the hit readable by the abuse sweep (spec §9.2). Fire-and-forget
  // into a Redis day-hash — this runs on the send path, which must not await a
  // write and must not write a partner-axis table.
  recordCapHit(partnerId);
}

export type PartnerLaneCapVerdict = 'allowed' | 'over_cap' | 'unavailable';

/**
 * Boolean form for callers that refuse in both non-allowed cases (the domain
 * test send, sendingDomainsWorker.ts). The send path uses countPartnerLaneSend,
 * which tells an over-cap verdict from an outage.
 */
export async function tryCountPartnerLaneSend(partnerId: string): Promise<boolean> {
  return (await countPartnerLaneSend(partnerId, 'internal')) === 'allowed';
}

export async function countPartnerLaneSend(
  partnerId: string,
  bucket: PartnerLaneCapBucket,
): Promise<PartnerLaneCapVerdict> {
  const cap = getEmailDomainsConfig().dailySendCap;
  // 0 = unlimited (spec §11). Do not even open a Redis connection for it: the
  // self-hosted default is unlimited and most self-hosted installs run without
  // any of this configured.
  if (!Number.isFinite(cap) || cap <= 0) return 'allowed';

  const now = Date.now();
  const key = partnerLaneCapKey(partnerId, now, bucket);

  try {
    const redis = getRedis();
    if (!redis) {
      console.error('[emailDomains/sendCap] Redis unavailable; routing to the platform lane', { partnerId });
      return 'unavailable';
    }

    const results = await redis.multi().incr(key).expire(key, CAP_KEY_TTL_SECONDS).exec();
    if (!results) {
      console.error('[emailDomains/sendCap] Redis multi returned null; routing to the platform lane', { partnerId });
      return 'unavailable';
    }

    const raw = results[0]?.[1];
    const count = typeof raw === 'number' ? raw : Number(raw ?? NaN);
    if (!Number.isFinite(count)) {
      console.error('[emailDomains/sendCap] unexpected multi() result shape; routing to the platform lane', { partnerId, results });
      return 'unavailable';
    }

    if (count > cap) {
      if (bucket === 'internal') {
        recordPartnerLaneCapHit(partnerId);
      } else {
        // NOT an abuse signal against the partner: outsiders drove this volume.
        // Logged once per send so a flood is visible to operators.
        console.warn('[emailDomains/sendCap] daily external-trigger bucket full; sending on the platform lane', { partnerId });
      }
      return 'over_cap';
    }
    return 'allowed';
  } catch (err) {
    console.error('[emailDomains/sendCap] Redis error; routing to the platform lane', { partnerId, err });
    return 'unavailable';
  }
}
