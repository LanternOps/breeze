/**
 * Deterministic 4-digit numeric suffix derived from an arbitrary base36
 * string (e.g. a test fixture's `<epoch>-<random>` unique suffix).
 *
 * Callers building test fixtures previously did `Number(x.slice(-4))` to get
 * a "numeric-looking" 4-digit tail. That silently breaks when the sliced
 * 4 characters happen to parse as scientific notation (e.g. "4e19"):
 * `Number('4e19')` is `4e19` (40000000000000000000), a 20-digit decimal once
 * stringified, which overflows narrow fixed-width fixture columns such as
 * `tickets.internal_number varchar(20)`. See #4495.
 *
 * This helper never calls `Number()` on the slice — it parses it explicitly
 * as base36 (`parseInt(x, 36)`, which has no scientific-notation reading) and
 * reduces mod 10000, so the result is always exactly 4 decimal digits
 * regardless of what characters the slice contains.
 */
export function fourDigitSuffix(input: string, offset = 0): string {
  const parsed = parseInt(input.slice(-4), 36);
  const base = Number.isNaN(parsed) ? 0 : Math.abs(parsed) % 10000;
  const n = (((base + offset) % 10000) + 10000) % 10000;
  return n.toString().padStart(4, '0');
}

// Per-process counter + random per-process base: collision-free inside a run,
// and a 1e9 space across runs sharing one integration DB (#7868).
let internalNumberCounter = 0;
const internalNumberBase = Math.floor(Math.random() * 1_000_000_000);

/**
 * Fixture `tickets.internal_number` that cannot collide with another fixture
 * ticket under the same partner (`tickets_partner_internal_number_uq`) or with
 * the app's allocator (`partner_ticket_sequences`, 4-digit zero-padded counter
 * starting at 1). `fourDigitSuffix` has only 10,000 values and is derived from
 * a per-call suffix, so independently-derived numbers collide at random (#7868).
 * Nine digits keep it within varchar(20) and the `T-YYYY-\d{4,}` subject token.
 */
export function uniqueInternalNumber(): string {
  internalNumberCounter += 1;
  const n = (internalNumberBase + internalNumberCounter) % 1_000_000_000;
  return `T-2026-${n.toString().padStart(9, '0')}`;
}
