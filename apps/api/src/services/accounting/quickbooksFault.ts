/**
 * Reading Intuit's `Fault` envelope off a failed QuickBooks response.
 *
 * A DEPENDENCY-FREE LEAF, for the same reason `accountingPaymentMarker.ts` is
 * one: both sides of the edge need it and neither may import the other. The
 * provider PARSES a fault (to classify 610/5010 and to attach the fields), and
 * the provider-neutral coordinators READ the attached fields (to tag Sentry and
 * to name the failure on the mapping card). Putting this in
 * `quickbooksProvider.ts` would make those coordinators import a provider
 * implementation; putting it in `types.ts` would put runtime code in a
 * types-only module.
 *
 * WHY THE PARSE HAPPENS BEFORE TRUNCATION. `qboRequest` stores `body` truncated
 * to 500 characters, which is right for storage — a QBO fault body can carry an
 * unbounded `Detail` string — but the classifiers used to regex that TRUNCATED
 * text. A fault whose `code` sits past the 500th character (a long `Detail`, a
 * batch response, a padded envelope) then read as "not a stale object", so the
 * SyncToken re-read never fired and the write failed permanently on a fault
 * designed to be retried. The fields are extracted from the FULL text and
 * carried as their own properties; `body` stays truncated.
 *
 * `Detail` IS DELIBERATELY NEVER SURFACED. Intuit puts the offending values in
 * it — customer names, amounts, memo text — so it is the one field that must
 * not reach an operator-visible `last_error` or a Sentry tag. `Message` is the
 * short fault CLASS ("Stale Object Error", "Business Validation Error"), which
 * is what makes a failure recognisable without leaking its contents.
 */

/** The fields worth carrying off a QuickBooks fault. */
export interface QboFault {
  /** Intuit's numeric fault code as a string, e.g. `'5010'`. */
  code: string | null;
  /** The short fault CLASS. Never `Detail`. */
  message: string | null;
  /**
   * The fault says the transaction is refused because a Payment is applied to
   * it (or it is otherwise linked to another transaction). Read off the FULL
   * body at parse time for the same reason the code is (see the module note):
   * Intuit puts this reason in `Detail`, which is exactly the field that gets
   * truncated away before storage. A BOOLEAN, not the text — the Detail itself
   * still never leaves this module.
   *
   * Optional so a hand-built fault (a caller that only cares about
   * `qboFaultSuffix`) does not have to say `false`.
   */
  paymentLinked?: boolean;
}

/**
 * Phrases Intuit uses when a write is refused because the transaction has a
 * Payment applied / is linked to another transaction. Matched against the FULL
 * fault body, never against the 500-character stored copy.
 *
 * Deliberately phrase-based rather than fault-code-based: the production
 * incident (#5180) was reported through Sentry, whose scrubber redacts the
 * message, so no verified fault CODE for this rejection exists to key on. Each
 * pattern names both a payment/linked-transaction noun and a
 * refusal/attachment verb, so a generic `Business Validation Error` or a
 * network/gateway failure cannot match — the classification only ever turns a
 * retryable failure into a terminal one, so a false positive would stop a
 * retry that might have worked.
 */
const PAYMENT_LINKED_PATTERNS: readonly RegExp[] = [
  /payments?\s+(?:is|are|was|were|has\s+been|have\s+been)?\s*(?:applied|linked|associated)/i,
  /(?:has|have|with|contains?)\s+(?:an?\s+)?(?:applied\s+)?payments?\b/i,
  /linked\s+(?:to\s+(?:another|other|an?)\s+)?transactions?/i,
];

/** Does this raw fault body say "there is a payment applied to this thing"? */
function bodySaysPaymentLinked(rawBody: string): boolean {
  return PAYMENT_LINKED_PATTERNS.some((re) => re.test(rawBody));
}

/** How many characters of a fault message may reach a log or a mapping card. */
const FAULT_MESSAGE_MAX = 120;

/**
 * Parse `Fault.Error[0]` out of a raw response body.
 *
 * Deliberately tolerant: a QBO fault arrives as JSON, but a gateway or WAF can
 * answer the same request with HTML or an empty body, and a classifier that
 * threw there would turn a transient edge failure into an unhandled one. A
 * regex fallback also catches a fault nested somewhere the shape check misses.
 */
export function parseQboFault(rawBody: string): QboFault {
  let code: string | null = null;
  let message: string | null = null;

  try {
    const parsed = JSON.parse(rawBody) as {
      Fault?: { Error?: Array<{ code?: unknown; Message?: unknown }> };
    };
    const first = parsed?.Fault?.Error?.[0];
    if (first) {
      if (typeof first.code === 'string' || typeof first.code === 'number') code = String(first.code);
      if (typeof first.Message === 'string') message = first.Message;
    }
  } catch {
    // Not JSON. The regexes below are the fallback.
  }

  if (code === null) {
    const m = /"code"\s*:\s*"?(\d{1,6})"?/.exec(rawBody);
    if (m) code = m[1]!;
  }
  if (message === null) {
    const m = /"Message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(rawBody);
    if (m) message = m[1]!.replace(/\\"/g, '"');
  }

  return {
    code,
    message: message === null ? null : message.slice(0, FAULT_MESSAGE_MAX),
    paymentLinked: bodySaysPaymentLinked(rawBody),
  };
}

/** The fault fields `qboRequest` attaches to a non-2xx error, if any. */
export function qboFaultOf(err: unknown): QboFault {
  if (!err || typeof err !== 'object') return { code: null, message: null, paymentLinked: false };
  const e = err as { qboFaultCode?: unknown; qboFaultMessage?: unknown; qboPaymentLinked?: unknown };
  return {
    code: typeof e.qboFaultCode === 'string' ? e.qboFaultCode : null,
    message: typeof e.qboFaultMessage === 'string' ? e.qboFaultMessage : null,
    paymentLinked: e.qboPaymentLinked === true,
  };
}

/**
 * Did QuickBooks refuse this write because the Invoice has a Payment applied to
 * it in QuickBooks (#5180)?
 *
 * This is a RULE, not an outage: QuickBooks will not void an invoice a payment
 * settles, and it will answer identically on every retry. Callers use it to
 * classify the failure as terminal so the BullMQ ladder does not burn five
 * attempts (and five Sentry alerts) on a deterministic refusal.
 *
 * The attached flag is authoritative — it was computed from the FULL body
 * before truncation. The stored `body` is still consulted as a fallback so a
 * fault assembled by an older code path (or a test fixture) is not missed;
 * that copy is truncated, so it can only ever add a match, never remove one.
 */
export function isQboPaymentLinkedRefusal(err: unknown): boolean {
  if (qboFaultOf(err).paymentLinked) return true;
  const body = err && typeof err === 'object' && typeof (err as { body?: unknown }).body === 'string'
    ? (err as { body: string }).body
    : '';
  const message = err instanceof Error ? err.message : '';
  return bodySaysPaymentLinked(`${body} ${message}`);
}

/**
 * `(HTTP 400: Business Validation Error)` — the parenthetical both coordinators
 * append to an operator-visible sync failure.
 *
 * Status alone told an operator only that something was rejected; the fault
 * class is what separates "the customer is not mapped" from "the token is
 * stale" without opening QuickBooks. Returns an empty string when there is
 * neither, so a caller can always append it.
 */
export function qboFaultSuffix(status: number | undefined, fault: QboFault): string {
  if (status === undefined) return fault.message ? ` (${fault.message})` : '';
  return fault.message ? ` (HTTP ${status}: ${fault.message})` : ` (HTTP ${status})`;
}
