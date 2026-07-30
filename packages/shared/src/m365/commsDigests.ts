import { canonicalizeArguments, computeArgumentDigest } from '../canonicalize/index';
import type { CommsSendEffect } from './commsEffect';
import { buildSendPlan } from './commsPlan';

/**
 * The two digests that bind an approved comms send (design §5.2 + §5.3, as reconciled
 * 2026-07-29). They are separate on purpose, and each one covers something the other
 * cannot:
 *
 * | Digest | Covers | Where it lives | What it catches |
 * |---|---|---|---|
 * | envelope | sender binding, consent generation, recipients, subject, body | `action_intents.argument_digest` — literally `sha256(canonicalize(arguments))` | the approved effect being altered between approval and release |
 * | plan | the exact Graph request bytes | persisted at creation, carried as a second signed claim | the *same* envelope being turned into a *different* HTTP request |
 *
 * Why both. The envelope digest alone leaves the envelope→Graph construction unbound, which
 * is §5.3's finding: `bcc` dropped, recipients written to the wrong field, body emitted as
 * HTML, `saveToSentItems` flipped — each changes the real effect while the envelope digest
 * still verifies. The plan digest alone cannot replace the envelope digest, because the plan
 * deliberately carries none of the binding fields: two sends differing only in
 * `consentGeneration` produce a byte-identical plan (pinned by
 * `consent-generation-changes-envelope-digest-only` in the vector corpus).
 *
 * And the plan digest is not redundant with "the executor uses shared code," because that is
 * a *build-time* guarantee. The executor ships as a separately-released image; one running a
 * stale `@breeze/shared` computes a different plan from the same envelope, and only a
 * digest comparison notices.
 *
 * ⚠️ **Release-path rule.** Both claims must be populated from the values *stored at intent
 * creation*, never recomputed while releasing. A claim recomputed on the release path from
 * the same envelope it is about to authorize is a self-consistency check that always passes
 * (design §5.2). These functions therefore have exactly two legitimate callers: the API at
 * intent creation, and the executor when recomputing to verify. Not the release path.
 */

/** `sha256(canonicalize(envelope))`. Must equal `action_intents.argument_digest`. */
export function computeCommsEnvelopeDigest(envelope: CommsSendEffect): string {
  return computeArgumentDigest(canonicalizeArguments(envelope));
}

/** `sha256(canonicalize(buildSendPlan(envelope)))`. Persisted at creation, re-derived to verify. */
export function computeCommsPlanDigest(envelope: CommsSendEffect): string {
  return computeArgumentDigest(canonicalizeArguments(buildSendPlan(envelope)));
}
