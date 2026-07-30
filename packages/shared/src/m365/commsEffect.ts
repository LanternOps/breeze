import { z } from 'zod';
import {
  M365_COMMS_MAX_BODY_TEXT_CHARS,
  M365_COMMS_MAX_RECIPIENTS,
  M365_COMMS_MAX_SUBJECT_CHARS,
  countCodePoints,
  m365CommsEmailSchema,
} from './commsActions';

/**
 * The canonical effect envelope for a Tier-3 comms send (design §5.2).
 *
 * **This envelope IS the intent's `arguments`** — not a projection of them, not something
 * derived from them at release time. That equivalence is the whole point: it makes
 * `action_intents.argument_digest` literally the content hash of the effect, protected by
 * the immutability trigger that already guards that column.
 *
 * The consequence for anything downstream: **the mapper stops mapping.** A headless
 * dispatcher validates this envelope against the schema below and forwards it unchanged.
 * Schema validation may *reject*; it may never *transform*. Every rebuild step is a place
 * where the sent content can drift from the approved content while both digest checks
 * still pass, which is the gap §5.1 found in the shipped chain.
 */

export const COMMS_SEND_EFFECT_ENVELOPE_VERSION = 1 as const;
export const COMMS_SEND_EFFECT_ACTION = 'm365.comms.mail.send' as const;

/**
 * Recipient lists are normalized once, here, at envelope construction:
 * lowercased, deduplicated, and sorted.
 *
 * Two things worth being explicit about, because both look like bugs otherwise:
 *
 * 1. **Sorting is correct here even though the canonicalizer deliberately preserves array
 *    order.** The canonicalizer must not reorder arrays, because it cannot know whether an
 *    array is a set or a sequence. This function does know: a recipient list is a set, so
 *    two requests differing only in recipient order are the same effect and should digest
 *    identically. Normalization happens once, before the digest; the digest never reorders.
 *
 * 2. **Dedup is within each list, never across them.** Removing an address from `bcc`
 *    because it also appears in `to` would change who is blind-copied — a silent
 *    modification of an approved effect. Cross-list overlap is left exactly as the caller
 *    wrote it and is Graph's to resolve.
 */
export function normalizeRecipients(addresses: readonly string[] | undefined): string[] {
  if (!addresses) return [];
  const seen = new Set<string>();
  for (const address of addresses) seen.add(address.trim().toLowerCase());
  return [...seen].sort();
}

// Declared as a type alias, not an interface: an interface has no implicit index
// signature, so it is not assignable to the `Record<string, unknown>` the shared
// canonicalizer takes — and this value's entire purpose is to be canonicalized.
export type CommsSendEffect = {
  envelopeVersion: typeof COMMS_SEND_EFFECT_ENVELOPE_VERSION;
  action: typeof COMMS_SEND_EFFECT_ACTION;
  actionVersion: number;
  /** Sender pinning (design §5.2) — all four are re-checked at release. */
  connectionId: string;
  tenantId: string;
  senderObjectId: string;
  /**
   * Bumped by every consent promotion. This is the load-bearing one: reconnect reuses the
   * same connection row, so `connectionId` alone cannot detect that the mailbox was
   * re-established — possibly as a different person — between approval and release.
   */
  consentGeneration: number;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  bodyText: string;
};

const guidSchema = z.string().guid();

/**
 * Validates a stored envelope. Strict, and intentionally re-asserts the normalization
 * invariants rather than trusting them: this schema is what a headless dispatcher and the
 * executor run against content loaded from the database, so "it was normalized when it was
 * created" is an assumption about the past, not a property of the bytes in hand.
 */
export const commsSendEffectSchema = z.object({
  envelopeVersion: z.literal(COMMS_SEND_EFFECT_ENVELOPE_VERSION),
  action: z.literal(COMMS_SEND_EFFECT_ACTION),
  actionVersion: z.number().int().min(1),
  connectionId: guidSchema,
  tenantId: guidSchema,
  senderObjectId: guidSchema,
  consentGeneration: z.number().int().min(0),
  to: z.array(m365CommsEmailSchema),
  cc: z.array(m365CommsEmailSchema),
  bcc: z.array(m365CommsEmailSchema),
  subject: z.string(),
  bodyText: z.string(),
})
  .strict()
  .refine((e) => e.to.length > 0, { message: 'at least one `to` recipient is required' })
  .refine((e) => e.to.length + e.cc.length + e.bcc.length <= M365_COMMS_MAX_RECIPIENTS, {
    message: `total recipients exceed ${M365_COMMS_MAX_RECIPIENTS}`,
  })
  .refine((e) => countCodePoints(e.subject) <= M365_COMMS_MAX_SUBJECT_CHARS, {
    message: `subject exceeds ${M365_COMMS_MAX_SUBJECT_CHARS} characters`,
  })
  .refine((e) => countCodePoints(e.bodyText) <= M365_COMMS_MAX_BODY_TEXT_CHARS, {
    message: `bodyText exceeds ${M365_COMMS_MAX_BODY_TEXT_CHARS} characters`,
  })
  .refine(
    (e) => [e.to, e.cc, e.bcc].every(isNormalizedList),
    { message: 'recipient lists must be lowercased, deduplicated, and sorted' }
  );

function isNormalizedList(list: readonly string[]): boolean {
  for (let i = 0; i < list.length; i++) {
    const value = list[i]!;
    if (value !== value.toLowerCase().trim()) return false;
    if (i > 0 && !(list[i - 1]! < value)) return false; // strictly ascending ⇒ sorted and deduped
  }
  return true;
}

export interface BuildCommsSendEffectInput {
  actionVersion: number;
  connectionId: string;
  tenantId: string;
  senderObjectId: string;
  consentGeneration: number;
  to: readonly string[];
  cc?: readonly string[];
  bcc?: readonly string[];
  subject: string;
  bodyText: string;
}

/**
 * Builds the envelope. Pure and total: no I/O, no clock, no randomness — the same input
 * must produce the same bytes in the API today and in the executor a minute later, or the
 * digest binding is worthless.
 *
 * Subject and body are carried **verbatim**. No trimming, no line-ending normalization, no
 * Unicode normalization: the approver sees these bytes and the recipient must receive these
 * bytes. (The canonicalizer's frozen vectors pin that property from the other side.)
 */
export function buildCommsSendEffect(input: BuildCommsSendEffectInput): CommsSendEffect {
  return {
    envelopeVersion: COMMS_SEND_EFFECT_ENVELOPE_VERSION,
    action: COMMS_SEND_EFFECT_ACTION,
    actionVersion: input.actionVersion,
    connectionId: input.connectionId,
    tenantId: input.tenantId,
    senderObjectId: input.senderObjectId,
    consentGeneration: input.consentGeneration,
    to: normalizeRecipients(input.to),
    cc: normalizeRecipients(input.cc),
    bcc: normalizeRecipients(input.bcc),
    subject: input.subject,
    bodyText: input.bodyText,
  };
}
