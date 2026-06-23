import { captureMessage } from '../services/sentry';

/**
 * Run a write that MUST move ≥1 row (use `.returning()`) and surface a 0-row
 * result as a Sentry warning (#1379 A2). Catches an RLS regression that lets
 * the context wrapper through but still denies the row — the #1375 class, at
 * the call-site. Opt-in and non-throwing: zero false positives, only wrap
 * sites you KNOW must affect a row (never idempotent upserts).
 */
export async function dbWriteExpectingRows<T>(label: string, run: () => Promise<T[]>): Promise<T[]> {
  const rows = await run();
  if (rows.length === 0) {
    const message = `Expected-rows write affected 0 rows: ${label}`;
    console.warn(message);
    captureMessage(message, 'warning', { label, stack: new Error().stack });
  }
  return rows;
}
