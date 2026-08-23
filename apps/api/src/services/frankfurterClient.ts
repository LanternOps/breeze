import { isKnownCurrency } from '@breeze/shared';

/** The ECB publishes against EUR, so EUR is the fixed pivot for every stored
 *  rate and every cross rate derived from them (multi-currency spec §8). */
export const ECB_REPORTING_BASE_CODE = 'EUR';

/** Deployment override (`FRANKFURTER_BASE_URL`) exists for self-hosted mirrors
 *  and air-gapped installs pointing at an internal proxy. It is trusted
 *  deployment config, NEVER request input. */
export const FRANKFURTER_DEFAULT_BASE_URL = 'https://api.frankfurter.dev/v2';

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const RATE_SCALE = 8;
/** numeric(18,8) => 18 - 8 = 10 digits available left of the point. */
const RATE_WHOLE_DIGITS = 10;

export type FrankfurterFailureKind = 'transient' | 'permanent';

/** `transient` = retry the same job (429/5xx/timeout/network). `permanent` =
 *  a protocol or validation failure; retrying the identical request cannot
 *  help, so the job fails without burning attempts (the worker wraps these in
 *  BullMQ's UnrecoverableError — see Task 6). */
export class FrankfurterClientError extends Error {
  constructor(
    message: string,
    public readonly kind: FrankfurterFailureKind,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'FrankfurterClientError';
  }
}

export interface FrankfurterRate {
  rateDate: string;
  baseCode: string;
  quoteCode: string;
  rate: string;
}

/** One row the provider returned that this client refused to store, with the
 *  reason. Surfaced so a bad row is REPORTED rather than silently dropped —
 *  and, crucially, rather than costing every other currency its update. */
export interface FrankfurterRowRejection {
  /** The row's currency when it could be read at all, else null. */
  quoteCode: string | null;
  reason: string;
}

export interface FrankfurterFetchResult {
  rates: FrankfurterRate[];
  requestedQuoteCodes: string[];
  /** Requested codes with no usable row in this response — either the provider
   *  did not cover them or their row was rejected (see `rejected`). These are
   *  UNAVAILABLE — the caller must not store anything for them, and must never
   *  assume 1:1. */
  unavailableQuoteCodes: string[];
  /** Per-row failures. Empty on a clean response. A non-empty list is an
   *  operational WARNING (the job reports it), not a batch failure. */
  rejected: FrankfurterRowRejection[];
}

function normalizeQuoteCodes(codes: readonly string[]): string[] {
  const set = new Set<string>();
  for (const raw of codes) {
    const code = String(raw ?? '').trim().toUpperCase();
    if (!code || code === ECB_REPORTING_BASE_CODE) continue;
    if (!isKnownCurrency(code)) continue;
    set.add(code);
  }
  return [...set].sort();
}

/** Frankfurter **v2** — `/v2/rates`, flat row array. `/v2/latest` is a v1 path
 *  and 404s here (verified against the live service 2026-08-23). */
export function buildEcbRatesUrl(baseUrl: string, quoteCodes: readonly string[]): string {
  const url = new URL(`${baseUrl.replace(/\/+$/, '')}/rates`);
  url.searchParams.set('base', ECB_REPORTING_BASE_CODE);
  url.searchParams.set('quotes', normalizeQuoteCodes(quoteCodes).join(','));
  // EXPLICIT provider selection. v2 blends providers by default and a blended
  // series is not the ECB reference rate the spec requires (§8).
  url.searchParams.set('providers', 'ECB');
  return url.toString();
}

/** Fixed-scale decimal string with no float formatting surprises: the value is
 *  normalized textually, never via toFixed on a parsed double. */
function toFixedScale(raw: string): string {
  const m = /^(-?)(\d+)(?:\.(\d*))?$/.exec(raw.trim());
  if (!m) throw new FrankfurterClientError(`Unparseable rate "${raw}"`, 'permanent');
  const [, sign, whole = '', frac = ''] = m;
  if (sign === '-') throw new FrankfurterClientError(`Negative rate "${raw}"`, 'permanent');
  if (frac.length > RATE_SCALE) throw new FrankfurterClientError(`Rate "${raw}" exceeds ${RATE_SCALE} decimals`, 'permanent');
  // numeric(18,8) holds at most 10 integer digits; a longer whole part would
  // reach Postgres as a numeric field overflow mid-batch.
  if (whole.replace(/^0+(?=\d)/, '').length > RATE_WHOLE_DIGITS) {
    throw new FrankfurterClientError(`Rate "${raw}" exceeds ${RATE_WHOLE_DIGITS} integer digits`, 'permanent');
  }
  if (/^0+$/.test(whole) && /^0*$/.test(frac)) throw new FrankfurterClientError(`Non-positive rate "${raw}"`, 'permanent');
  // Strip leading zeros TEXTUALLY. `Number(whole)` would round a long integer
  // part and can render it in exponent notation — the one float step this
  // deliberately float-free normalizer must not take.
  return `${whole.replace(/^0+(?=\d)/, '')}.${frac.padEnd(RATE_SCALE, '0')}`;
}

/** One flat v2 row: `{ date, base, quote, rate }`. Every field is validated.
 *  A bad row is REJECTED (collected and reported by the caller), never silently
 *  dropped — a silently-dropped row is indistinguishable from "the ECB does not
 *  cover this pair", and those two cases must never be conflated. It is also
 *  not allowed to fail the batch: one unknown code or one over-precision rate
 *  must not cost the other 33 currencies their update for the day. */
function readRow(value: unknown): FrankfurterRate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new FrankfurterClientError('Frankfurter row was not an object', 'permanent');
  }
  const row = value as { date?: unknown; base?: unknown; quote?: unknown; rate?: unknown };
  const rateDate = typeof row.date === 'string' ? row.date : '';
  if (!ISO_DATE_RE.test(rateDate)) {
    throw new FrankfurterClientError(`Frankfurter row carried an invalid date "${String(row.date)}"`, 'permanent');
  }
  const baseCode = String(row.base ?? '').trim().toUpperCase();
  if (baseCode !== ECB_REPORTING_BASE_CODE) {
    throw new FrankfurterClientError(`Frankfurter row base "${String(row.base)}", expected EUR`, 'permanent');
  }
  const quoteCode = String(row.quote ?? '').trim().toUpperCase();
  if (!isKnownCurrency(quoteCode)) {
    throw new FrankfurterClientError(`Frankfurter returned unknown currency "${String(row.quote)}"`, 'permanent');
  }
  if (typeof row.rate !== 'number' && typeof row.rate !== 'string') {
    throw new FrankfurterClientError(`Frankfurter row for ${quoteCode} carried no rate`, 'permanent');
  }
  return { rateDate, baseCode, quoteCode, rate: toFixedScale(String(row.rate)) };
}

/** Best-effort currency label for a row that failed validation, so the
 *  rejection report can name the pair when the row is readable enough. */
function rowQuoteHint(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const quote = (raw as { quote?: unknown }).quote;
  if (typeof quote !== 'string') return null;
  const code = quote.trim().toUpperCase();
  return code.length > 0 && code.length <= 8 ? code : null;
}

export async function fetchLatestEcbRates(
  quoteCodes: readonly string[],
  options: { baseUrl?: string; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<FrankfurterFetchResult> {
  const requested = normalizeQuoteCodes(quoteCodes);
  if (requested.length === 0) {
    return { rates: [], requestedQuoteCodes: [], unavailableQuoteCodes: [], rejected: [] };
  }

  // `||`, not `??`: docker-compose maps this as `${FRANKFURTER_BASE_URL:-}`, so
  // an operator who never sets it hands us the EMPTY STRING, not undefined. `??`
  // would accept '' and `new URL('/rates')` would throw a bare TypeError on every
  // default deploy. Empty === unset (wave-7 plan, Global Constraints).
  const baseUrl = options.baseUrl || process.env.FRANKFURTER_BASE_URL?.trim() || FRANKFURTER_DEFAULT_BASE_URL;
  const doFetch = options.fetchImpl ?? fetch;
  const url = buildEcbRatesUrl(baseUrl, requested);

  let res: Response;
  try {
    res = await doFetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (err) {
    throw new FrankfurterClientError(`Frankfurter request failed: ${(err as Error).message}`, 'transient');
  }

  if (res.status === 429 || res.status >= 500) {
    throw new FrankfurterClientError(`Frankfurter responded ${res.status}`, 'transient', res.status);
  }
  if (!res.ok) {
    throw new FrankfurterClientError(`Frankfurter responded ${res.status}`, 'permanent', res.status);
  }

  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > MAX_RESPONSE_BYTES) {
    throw new FrankfurterClientError(`Frankfurter response too large (${declared} bytes)`, 'permanent');
  }
  const text = await res.text();
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new FrankfurterClientError(`Frankfurter response too large (${text.length} bytes)`, 'permanent');
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new FrankfurterClientError('Frankfurter response was not valid JSON', 'permanent');
  }
  // v2 returns a flat ARRAY of rows. An object body means either the v1
  // envelope or an error payload — both are protocol failures.
  if (!Array.isArray(body)) {
    throw new FrankfurterClientError('Frankfurter v2 response was not a row array', 'permanent');
  }

  const wanted = new Set(requested);
  const accepted = new Map<string, FrankfurterRate>();
  const rejected: FrankfurterRowRejection[] = [];
  // A currency whose rows contradict each other is ambiguous: BOTH readings are
  // discarded and the pair stays unavailable rather than picking one at random.
  const ambiguous = new Set<string>();
  for (const raw of body) {
    let row: FrankfurterRate;
    try {
      row = readRow(raw);
    } catch (err) {
      rejected.push({ quoteCode: rowQuoteHint(raw), reason: err instanceof Error ? err.message : String(err) });
      continue;
    }
    if (accepted.has(row.quoteCode) || ambiguous.has(row.quoteCode)) {
      rejected.push({ quoteCode: row.quoteCode, reason: `Frankfurter returned duplicate currency "${row.quoteCode}"` });
      ambiguous.add(row.quoteCode);
      accepted.delete(row.quoteCode);
      continue;
    }
    accepted.set(row.quoteCode, row);
  }

  // A response whose EVERY row was rejected is not "a bad row", it is a
  // protocol change (or an error payload shaped as an array) — batch-level, so
  // permanent, so the worker stops retrying a doomed request.
  if (body.length > 0 && rejected.length === body.length) {
    throw new FrankfurterClientError(
      `Frankfurter returned ${body.length} row(s), none usable: ${rejected[0]!.reason}`,
      'permanent',
    );
  }

  // Extra coverage is not an error, it is just not ours to store.
  const rates = [...accepted.values()].filter((row) => wanted.has(row.quoteCode));

  return {
    rates,
    requestedQuoteCodes: requested,
    // A pair the provider does not cover — or whose row we refused — is
    // UNAVAILABLE, never 1:1 (spec §8).
    unavailableQuoteCodes: requested.filter((code) => !accepted.has(code)),
    rejected,
  };
}
