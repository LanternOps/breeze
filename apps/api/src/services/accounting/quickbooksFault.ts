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

/** The two fields worth carrying off a QuickBooks fault. */
export interface QboFault {
  /** Intuit's numeric fault code as a string, e.g. `'5010'`. */
  code: string | null;
  /** The short fault CLASS. Never `Detail`. */
  message: string | null;
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
  };
}

/** The fault fields `qboRequest` attaches to a non-2xx error, if any. */
export function qboFaultOf(err: unknown): QboFault {
  if (!err || typeof err !== 'object') return { code: null, message: null };
  const e = err as { qboFaultCode?: unknown; qboFaultMessage?: unknown };
  return {
    code: typeof e.qboFaultCode === 'string' ? e.qboFaultCode : null,
    message: typeof e.qboFaultMessage === 'string' ? e.qboFaultMessage : null,
  };
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
