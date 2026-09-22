/**
 * Waiting for fire-and-forget audit rows.
 *
 * `writeRouteAudit` / `writeAuditEvent` (`services/auditEvents.ts`) do
 * `void writeAuditEventAsync(...)`, and `persistAuditLog`
 * (`services/auditService.ts`) deliberately runs the INSERT **outside** the
 * caller's request transaction — `runOutsideDbContext(() =>
 * withSystemDbAccessContext(...))`, i.e. on a second pooled connection. The
 * route therefore returns its response while the audit INSERT is still in
 * flight.
 *
 * A test that reads `audit_logs` straight after the response races that write:
 * it wins on an idle local database and loses on a loaded CI shard. A fixed
 * `setTimeout(300)` only moves the odds — it is still a race, and it also costs
 * 300 ms on every green run. #6554 replaced one such read with a bounded poll;
 * this helper is that poll, shared (issue #6555).
 *
 * Deliberately count-based and caller-driven: each suite keeps its own database
 * handle (`getTestDb()`, a fixture's `adminDb`, or a `withSystemDbAccessContext`
 * wrapper) and its own column selection, so the existing assertions — which pin
 * the exact actions, org ids and details — stay untouched and keep producing
 * their own failure messages.
 */

/**
 * Poll `read` until it returns exactly `expectedCount` rows, or the deadline
 * passes.
 *
 * Returns the last rows read **without asserting**: on a real regression the
 * caller's own `expect` reports the mismatch with its own message. This only
 * removes the timing race — it never makes a failing assertion pass.
 *
 * Note this cannot prove an *absence*: waiting for zero rows is satisfied
 * immediately. Assertions that no audit row was written still need a plain
 * delay (and are the safe direction anyway — a slow write makes them pass
 * spuriously, not fail flakily).
 */
export async function awaitAuditRows<Row>(
  read: () => Promise<Row[]>,
  expectedCount: number,
  options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<Row[]> {
  const { timeoutMs = 10_000, pollMs = 25 } = options;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await read();
    if (rows.length >= expectedCount || Date.now() > deadline) return rows;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
