import { sendOpsAlert } from '../opsAlerts';
import { getRedis } from '../redis';
import type { MailPurpose, PartnerMailStream } from './mailPurposes';
import { BREEZE_OUTBOUND_HEADER, BREEZE_OUTBOUND_HEADER_VALUE } from './outboundMarker';
import { PartnerLaneSendFailure, type PartnerLaneMessage } from './provider';
import { getEmailDomainProvider } from './providerRegistry';

/**
 * The partner-lane transport (spec §8.4).
 *
 * Returns `{ delivered: false }` ONLY for the two failures that mean the
 * message was definitively not sent, so the caller can put it on the platform
 * lane. `message_rejected` and `ambiguous` are rethrown, as today — an
 * ambiguous failure is never retried on the other lane, because a recipient
 * receiving two copies is worse than a retry the caller can decide on.
 */

/**
 * At most one ops alert per hour for a paused/rate-limited lane (spec §13),
 * PER PARTNER. A single global key would let the first partner to hit a paused
 * lane silence the alert for every other partner for the whole hour — on a
 * busy instance that is most of them, and the ones you would most want to hear
 * about are the ones that lose the race.
 */
const LANE_ALERT_KEY_PREFIX = 'email-domains:lane-unavailable-alert';
const LANE_ALERT_WINDOW_SECONDS = 3600;

export interface PartnerLaneSendInput {
  /** `from` is already the partner address decided by resolveSender. */
  message: PartnerLaneMessage;
  purpose: MailPurpose;
  partnerId: string;
  domainId: string;
  stream: PartnerMailStream;
}

export type PartnerLaneSendOutcome =
  | { delivered: true; providerMessageId: string }
  | { delivered: false; failure: 'domain_unusable' | 'lane_unavailable' };

/**
 * `SET NX EX` reservation, the `services/m365Sync/onDemandLimiter.ts` idiom:
 * the semantics are "a slot is held for the hour", not "count the failures".
 * When Redis cannot answer we ALERT — an ops alert we cannot deduplicate is a
 * nuisance; a paused sending account nobody hears about is an outage.
 */
async function claimLaneAlertSlot(partnerId: string): Promise<boolean> {
  try {
    const redis = getRedis();
    if (!redis) return true;
    const key = `${LANE_ALERT_KEY_PREFIX}:${partnerId}`;
    return (await redis.set(key, '1', 'EX', LANE_ALERT_WINDOW_SECONDS, 'NX')) === 'OK';
  } catch {
    return true;
  }
}

export async function sendOnPartnerLane(input: PartnerLaneSendInput): Promise<PartnerLaneSendOutcome> {
  const provider = getEmailDomainProvider();
  if (!provider) {
    // resolveSender only returns the partner lane when the lane is configured,
    // so this is a race with a config change, not a normal state. Fall back
    // rather than throw: nothing was sent.
    console.error('[emailDomains/partnerLaneSend] resolved to the partner lane with no provider registered', {
      partnerId: input.partnerId, domainId: input.domainId,
    });
    return { delivered: false, failure: 'lane_unavailable' };
  }

  // A NEW headers object. The caller rebuilds the fallback message from the
  // ORIGINAL params, so mutating in place would put X-Breeze-Outbound on a
  // platform-lane message — which would then be ignored by our own inbound
  // pipeline if it ever came back.
  const headers = { ...(input.message.headers ?? {}), [BREEZE_OUTBOUND_HEADER]: BREEZE_OUTBOUND_HEADER_VALUE };

  try {
    const { providerMessageId } = await provider.send({
      ...input.message,
      headers,
      partnerRef: input.partnerId,
      // W06 attributes every delivery event by these four (spec §9.3).
      tags: {
        partner_id: input.partnerId,
        domain_id: input.domainId,
        stream: input.stream,
        purpose: input.purpose,
      },
    });
    return { delivered: true, providerMessageId };
  } catch (err) {
    // Anything that is not the adapter's declared failure type is AMBIGUOUS: a
    // bug, an SDK panic or an OOM tells us nothing about whether the message
    // left. Rethrow without falling back.
    if (!(err instanceof PartnerLaneSendFailure)) throw err;
    const { kind } = err.error;
    // W02's review round widened `lane_unavailable` to carry an optional
    // `detail` too, so this reads the field off the union rather than the
    // variant — it is correct whether or not that change is in the tree yet.
    const detail = 'detail' in err.error && typeof err.error.detail === 'string' ? err.error.detail : '';

    if (kind === 'message_rejected' || kind === 'ambiguous') {
      // These rethrow, so nothing further in this module records them — and
      // without a line here an operator sees only the caller's generic send
      // failure, with no way to tell a bad recipient from a lane that might
      // have delivered. The message is NOT re-sent (§8.4), so this log is the
      // only trace that the partner lane was even involved.
      console.warn('[emailDomains/partnerLaneSend] partner lane did not deliver; rethrowing without falling back', {
        partnerId: input.partnerId, domainId: input.domainId, purpose: input.purpose, kind, detail: detail || undefined,
      });
      throw err;
    }

    const lastSendError = detail ? `${kind}: ${detail}` : kind;
    console.warn('[emailDomains/partnerLaneSend] partner lane refused the message; falling back to the platform lane', {
      partnerId: input.partnerId, domainId: input.domainId, purpose: input.purpose, kind, detail: detail || undefined,
    });

    // The refusal text reaches partner_sending_domains.last_send_error through
    // the WORKER (spec §3.1): the send path may be running in a context that
    // cannot write that table, and writing a partner-axis table from
    // services/** would also red partner-wide-write-coverage.test.ts.
    await import('../../jobs/sendingDomainsWorker')
      .then(({ enqueueSyncDomain }) => enqueueSyncDomain(input.domainId, { lastSendError }))
      .catch((enqueueErr) => {
        // Best effort. Losing the diagnostic must never cost us the fallback.
        console.error('[emailDomains/partnerLaneSend] could not enqueue sync-domain for the refusal', {
          domainId: input.domainId, enqueueErr,
        });
      });

    if (kind === 'lane_unavailable' && await claimLaneAlertSlot(input.partnerId)) {
      await sendOpsAlert({
        title: 'Partner sending lane unavailable',
        body: `The partner-lane provider refused a send (429, paused account, or quota). Messages are falling back to EMAIL_FROM meanwhile. partner=${input.partnerId} domain=${input.domainId}${detail ? ` detail=${detail}` : ''}`,
      }).catch(() => undefined);
    }

    return { delivered: false, failure: kind };
  }
}
