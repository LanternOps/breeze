import { MigrationWindowError } from '../migrationWindows';
import { ticketImportMaxBytesPerHour } from '../migrationWindowLimits';
import { assertOutsideHeldDbContextSafe, rateLimiter } from '../rate-limit';
import { getRedis } from '../redis';

/**
 * The import throughput bucket (#8313; spec §4.7): a third hourly bucket,
 * `migration_window_rate:{windowId}`, limited to the window's
 * writes_per_hour. It is independent of the Partner API buckets, so an
 * import never consumes a live integration's 1200/6000 and a live
 * integration cannot starve an import.
 *
 * The writer charges it BEFORE each transaction with the transaction's cost,
 * one unit per service write. `refundOnReject`: a rejected attempt costs
 * nothing, so a writer that waits for `retryAfterSeconds` is admitted. Fails
 * closed like every limiter here: no Redis, no import.
 */
export const MIGRATION_WINDOW_RATE_BUCKET = 'migration_window_rate';

export function migrationWindowRateKey(windowId: string): string {
  return `${MIGRATION_WINDOW_RATE_BUCKET}:${windowId}`;
}

export async function chargeWindowThroughput(
  window: { id: string; writesPerHour: number },
  cost: number,
): Promise<void> {
  if (cost <= 0) return;
  const result = await rateLimiter(getRedis(), migrationWindowRateKey(window.id), window.writesPerHour, 3600, cost, {
    refundOnReject: true,
  });
  if (!result.allowed) {
    throw new MigrationWindowError(
      'MIGRATION_WINDOW_RATE_LIMITED',
      'The migration window throughput limit is reached',
      429,
      {
        kind: 'writes',
        writesPerHour: window.writesPerHour,
        retryAfterSeconds: Math.max(1, Math.ceil((result.resetAt.getTime() - Date.now()) / 1000)),
      },
    );
  }
}

/**
 * The byte bucket of an import (#8313 W1; spec 2026-10-19 §4.5): a sibling of
 * the units bucket, `migration_window_bytes:{windowId}`, limited to
 * `TICKET_IMPORT_MAX_BYTES_PER_HOUR` (default 2 GiB). Bytes load S3, the
 * network and the source; units meter database writes, and folding one into
 * the other would give writes_per_hour two meanings.
 *
 * `rateLimiter` cannot meter bytes (it adds one ZSET member per unit, F23), so
 * this is a token bucket in one Lua script: it holds up to an hour's bytes,
 * refills continuously at the hourly rate, and admits a charge only when the
 * whole charge fits. A refused charge takes nothing (it waits for the
 * refill), and says when it will fit. The clock is Redis's own (`TIME`), so
 * API hosts with skewed clocks share one bucket correctly.
 */
export const MIGRATION_WINDOW_BYTES_BUCKET = 'migration_window_bytes';

export function migrationWindowBytesKey(windowId: string): string {
  return `${MIGRATION_WINDOW_BYTES_BUCKET}:${windowId}`;
}

/** Idle buckets refill completely within an hour; two hours of TTL leaves nothing behind. */
const BYTE_BUCKET_TTL_MS = 2 * 3600 * 1000;

/**
 * KEYS[1] the bucket; ARGV[1] its capacity (bytes per hour); ARGV[2] the
 * charge; ARGV[3] the TTL in ms. Returns { admitted (1/0), wait in ms }.
 */
export const BYTE_BUCKET_LUA = `
local capacity = tonumber(ARGV[1])
local cost = tonumber(ARGV[2])
local rate = capacity / 3600000
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local state = redis.call('HMGET', KEYS[1], 'tokens', 'at')
local tokens = tonumber(state[1])
local at = tonumber(state[2])
if tokens == nil or at == nil then
  tokens = capacity
  at = now
end
if now > at then
  tokens = tokens + (now - at) * rate
end
if tokens > capacity then
  tokens = capacity
end
local admitted = 0
local wait = 0
if tokens >= cost then
  tokens = tokens - cost
  admitted = 1
else
  wait = math.ceil((cost - tokens) / rate)
end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'at', tostring(now))
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[3]))
return { admitted, wait }
`;

function bytesRefused(bytesPerHour: number, retryAfterSeconds: number): MigrationWindowError {
  return new MigrationWindowError(
    'MIGRATION_WINDOW_RATE_LIMITED',
    'The migration window byte limit is reached',
    429,
    { kind: 'bytes', bytesPerHour, retryAfterSeconds },
  );
}

/**
 * Charges `bytes` to the window's byte bucket before a download (§4.5), or
 * throws `429 MIGRATION_WINDOW_RATE_LIMITED` with `details.kind: 'bytes'` and
 * `retryAfterSeconds`. Fails closed: with no Redis, or a Redis error, nothing
 * is downloaded (retry in a minute). Runs outside any DB context, like every
 * Redis round trip here.
 */
export async function chargeWindowBytes(window: { id: string }, bytes: number): Promise<void> {
  if (!(bytes > 0)) return;
  assertOutsideHeldDbContextSafe('chargeWindowBytes');
  const capacity = ticketImportMaxBytesPerHour();
  const cost = Math.min(capacity, Math.ceil(bytes));
  const redis = getRedis();
  if (!redis) {
    console.error('[ticket-import] Redis unavailable, failing the byte bucket closed for window:', window.id);
    throw bytesRefused(capacity, 60);
  }
  let admitted: number;
  let waitMs: number;
  try {
    const result = await redis.eval(BYTE_BUCKET_LUA, 1, migrationWindowBytesKey(window.id), String(capacity), String(cost), String(BYTE_BUCKET_TTL_MS));
    [admitted, waitMs] = (Array.isArray(result) ? result : [0, 60_000]).map(Number) as [number, number];
  } catch (err) {
    console.error('[ticket-import] The byte bucket failed closed for window:', window.id, err);
    throw bytesRefused(capacity, 60);
  }
  if (admitted !== 1) throw bytesRefused(capacity, Math.max(1, Math.ceil((Number.isFinite(waitMs) ? waitMs : 60_000) / 1000)));
}
