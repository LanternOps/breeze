import { captureMessage } from '../services/sentry';

/**
 * Resolves extra Sentry TAGS describing why a write moved 0 rows. Invoked ONLY
 * on the 0-row branch, so the evidence read is never paid for on the happy
 * path — the callers here sit on hot paths under connection-pool pressure
 * (#1105). Never let it throw: a diagnostic must not change the outcome of the
 * write it describes.
 *
 * Keys must be in sentry.ts's ALLOWED_TAG_NAMES or they are dropped twice over
 * (setCallerTags at capture time, pickAllowedTags in the beforeSend scrubber);
 * values must stay low-cardinality and free of tenant/row identifiers.
 */
export type ExpectedRowsDiagnosticTags = () =>
  | Record<string, string>
  | Promise<Record<string, string>>;

/**
 * Run a write that MUST move ≥1 row (use `.returning()`) and surface a 0-row
 * result as a Sentry warning (#1379 A2). Catches an RLS regression that lets
 * the context wrapper through but still denies the row — the #1375 class, at
 * the call-site. Opt-in and non-throwing: zero false positives, only wrap
 * sites you KNOW must affect a row (never idempotent upserts).
 *
 * The label is emitted as the `cas_label` tag, not just inside the message:
 * scrubEvent deletes `message`/`logentry`/`extra` before the event leaves the
 * process, so tags are the only channel that survives — without it every call
 * site collapses into one untriageable Sentry bucket (BREEZE-X).
 */
export async function dbWriteExpectingRows<T>(
  label: string,
  run: () => Promise<T[]>,
  diagnosticTags?: ExpectedRowsDiagnosticTags,
): Promise<T[]> {
  const rows = await run();
  if (rows.length === 0) {
    const message = `Expected-rows write affected 0 rows: ${label}`;
    console.warn(message);
    let tags: Record<string, string> = { cas_label: label };
    if (diagnosticTags) {
      try {
        tags = { ...tags, ...(await diagnosticTags()) };
      } catch (err) {
        console.warn(`[dbWriteExpectingRows] diagnostic tags failed for ${label}:`, err);
      }
    }
    captureMessage(message, 'warning', { label, stack: new Error().stack }, tags);
  }
  return rows;
}
