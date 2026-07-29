import type { CommsSendEffect } from './commsEffect';

/**
 * The Graph operation plan for a comms send (design §5.3).
 *
 * Binding the envelope alone is not enough. The executor still has to turn an envelope into
 * an HTTP request, and everything decided during that construction sits outside an
 * envelope-only digest: body emitted as HTML rather than text, `bcc` dropped, recipients
 * written to the wrong Graph field, `saveToSentItems` flipped so the sender has no record
 * of what was sent in their name. Each changes the real-world effect while the envelope
 * digest still verifies.
 *
 * So the digest covers **this plan**, and the plan carries the literal Graph request body.
 *
 * ## Why `body` is the wire payload rather than a friendlier shape
 *
 * The design sketch typed recipients as `string[]`. That leaves one reshaping step after
 * verification — `string[]` → `[{ emailAddress: { address } }]` — and a transposition bug
 * in that step (bcc written into `ccRecipients`, say) survives plan verification intact.
 * That is the same class of gap §5.3 was written to close, just moved one layer down. So
 * `plan.body` is exactly what goes on the wire: the executor's send path is
 * `JSON.stringify(plan.body)` and nothing else. There is no construction left to get wrong.
 *
 * The cost, stated plainly: the plan is now coupled to Graph's wire format, so if Microsoft
 * changes the `sendMail` body shape this becomes a `planVersion` bump — and bumping it
 * changes every digest, invalidating approved-but-unreleased intents. That is the correct
 * failure (re-approve under the new shape), but it is a real operational consequence and
 * not a free win.
 */

export const COMMS_SEND_PLAN_VERSION = 1 as const;

/**
 * Pinned `true` in v1 and NOT settable from the envelope.
 *
 * A message sent as a named human must leave a trace in that human's own Sent Items. It is
 * the recovery oracle for the accepted crash-boundary residual (design §8), and more
 * importantly it is the only place the person whose identity was used can see what was
 * said. An action that could send invisibly from someone's mailbox is not one this system
 * should be able to express.
 */
export const COMMS_SEND_SAVE_TO_SENT_ITEMS = true as const;

export interface GraphRecipient {
  emailAddress: { address: string };
}

/** Exactly the JSON body Graph's `POST /me/sendMail` expects. */
export interface GraphSendMailBody {
  message: {
    subject: string;
    body: { contentType: 'Text'; content: string };
    toRecipients: GraphRecipient[];
    ccRecipients: GraphRecipient[];
    bccRecipients: GraphRecipient[];
  };
  saveToSentItems: boolean;
}

// Type alias rather than interface for the same reason as `CommsSendEffect`: an interface
// is not assignable to the canonicalizer's `Record<string, unknown>` parameter, and this
// value exists to be canonicalized and digested.
export type GraphOperationPlan = {
  planVersion: typeof COMMS_SEND_PLAN_VERSION;
  method: 'POST';
  path: '/me/sendMail';
  body: GraphSendMailBody;
};

function toRecipientList(addresses: readonly string[]): GraphRecipient[] {
  return addresses.map((address) => ({ emailAddress: { address } }));
}

/**
 * Pure, total, no I/O. The API computes this at intent creation and digests it; the
 * executor recomputes it from the envelope it received and refuses on mismatch, before it
 * touches any credential. A mapper divergence becomes a digest mismatch rather than a
 * silent content change.
 *
 * `contentType` is pinned to `'Text'` rather than inferred. Inferring it from the body
 * would mean the same approved bytes could be delivered as HTML — different rendering,
 * different link behaviour, different effect — with no change to the envelope.
 */
export function buildSendPlan(envelope: CommsSendEffect): GraphOperationPlan {
  return {
    planVersion: COMMS_SEND_PLAN_VERSION,
    method: 'POST',
    path: '/me/sendMail',
    body: {
      message: {
        subject: envelope.subject,
        body: { contentType: 'Text', content: envelope.bodyText },
        toRecipients: toRecipientList(envelope.to),
        ccRecipients: toRecipientList(envelope.cc),
        bccRecipients: toRecipientList(envelope.bcc),
      },
      saveToSentItems: COMMS_SEND_SAVE_TO_SENT_ITEMS,
    },
  };
}

/**
 * The plan digest is deliberately NOT computed here.
 *
 * `computeArgumentDigest` imports `node:crypto`, and this module is reachable from
 * `@breeze/shared`'s root barrel, which `apps/web` bundles for the browser. Callers digest
 * a plan with:
 *
 * ```ts
 * import { canonicalizeArguments, computeArgumentDigest } from '@breeze/shared/canonicalize';
 * const digest = computeArgumentDigest(canonicalizeArguments(buildSendPlan(envelope)));
 * ```
 *
 * Both sides must use that shared canonicalizer — a digest scheme with two implementations
 * has none.
 */
