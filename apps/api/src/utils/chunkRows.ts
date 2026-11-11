/**
 * Row cap for one multi-row INSERT on a hot ingest path (#10859).
 *
 * Postgres allows 65,534 bind parameters per statement, but staying under that
 * limit is not enough. Drizzle builds the whole statement synchronously on the
 * main thread, and a 55,000-parameter `device_connections` insert blocked the
 * event loop for over a second, which stalled every heartbeat queued behind
 * it. 500 rows keeps a statement to a few thousand parameters (5,500 for
 * `device_connections` at 11 columns, 6,000 for `software_inventory` at 12),
 * and the await between chunks lets other requests run.
 */
export const BULK_INSERT_CHUNK_ROWS = 500;

/** Split `rows` into consecutive slices of at most `size`, preserving order. */
export function chunkRows<T>(rows: readonly T[], size: number = BULK_INSERT_CHUNK_ROWS): T[][] {
  if (!Number.isInteger(size) || size < 1) {
    throw new Error(`chunkRows: size must be a positive integer, got ${size}`);
  }
  const batches: T[][] = [];
  for (let i = 0; i < rows.length; i += size) {
    batches.push(rows.slice(i, i + size));
  }
  return batches;
}
