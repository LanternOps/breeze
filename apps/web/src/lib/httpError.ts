/**
 * A fetch failure that still carries its HTTP status.
 *
 * Loaders that did `throw new Error(\`${res.status} ${res.statusText}\`)` lost the
 * status into a string the moment they threw, so a 403 was indistinguishable
 * from a 500 and got the same "couldn't be loaded — Retry" banner. Retry can
 * never clear a 403 (the server-side permission gate will deny it again), so the
 * status has to survive the throw for the UI to branch on it. (#2429)
 *
 * The message is kept in the historical `"<status> <statusText>"` shape so the
 * existing `friendlyFetchError()` string-sniff in `lib/utils.ts` keeps working
 * for callers that have not been migrated to `errorKindOf()`.
 */
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, statusText = '') {
    super(`${status} ${statusText}`.trim());
    this.name = 'HttpError';
    this.status = status;
  }
}

/**
 * How a load failure should be surfaced.
 * - `none`   — no failure.
 * - `denied` — 403. Terminal for this user: show a permissions message, NO retry.
 * - `other`  — transient/unknown. Retry is meaningful.
 */
export type LoadErrorKind = 'none' | 'denied' | 'other';

/** Classify a thrown loader error. Anything without a 403 status is retryable. */
export function errorKindOf(err: unknown): Exclude<LoadErrorKind, 'none'> {
  return err instanceof HttpError && err.status === 403 ? 'denied' : 'other';
}

/** Throw an `HttpError` if the response is not ok. Returns the response otherwise. */
export function throwIfNotOk(response: Response): Response {
  if (!response.ok) {
    throw new HttpError(response.status, response.statusText);
  }
  return response;
}
