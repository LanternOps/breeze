import type { WarrantyProvider, WarrantyLookupResult, WarrantyEntitlement } from './types';
import { lenovoRateLimiter } from './throttle';
import { envFlag } from '../../config/env';

// Two ways to reach Lenovo, tried in this order per serial:
//
// 1. Official Warranty API (LENOVO_API_KEY): GET supportapi.lenovo.com/v2.5/warranty
//    with a Lenovo-issued ClientID header. Documented at
//    https://supportapi.lenovo.com/Documentation/Warranty.html — Lenovo hands the
//    ClientID out through a partner manager, so most deployments will not have one.
//
// 2. pcsupport.lenovo.com (LENOVO_WARRANTY_ENABLED=true): the JSON endpoint behind
//    Lenovo's public warranty-lookup page. Needs no credential, but it is
//    undocumented and could change or be bot-gated at any time, so it is opt-in.
//    Verified 2026-09-09 against real serials: the body key is `serialNumber`
//    (case-sensitive — `Serial` returns "No information was found"), the method
//    must be POST, and Akamai rejects default curl-style User-Agents but accepts
//    a plain product token.
//
// When both are configured the official API is authoritative: a definite
// not-found from it is final, and pcsupport is only consulted when the official
// call fails (rejected key, outage, non-2xx, malformed body). A rejected key
// (401/403) backs the official path off for an hour and logs, so a dead key is
// visible in the API log instead of silently costing a wasted request per device.

const OFFICIAL_URL = 'https://supportapi.lenovo.com/v2.5/warranty';
const PCSUPPORT_URL = 'https://pcsupport.lenovo.com/us/en/api/v4/upsell/redport/getIbaseInfo';
const USER_AGENT = 'Mozilla/5.0 (compatible; Breeze-RMM/1.0)';
// Vendor calls run inside the warranty worker's system DB context; an unbounded
// fetch would pin a pooled connection for as long as Lenovo keeps the socket open.
const FETCH_TIMEOUT_MS = 15_000;
const OFFICIAL_AUTH_BACKOFF_MS = 60 * 60_000;
const WARN_THROTTLE_MS = 5 * 60_000;

// pcsupport envelope codes observed live.
const PCSUPPORT_OK = 0;
const PCSUPPORT_NOT_FOUND = 100;
// Official API "error codes in response object" per the v2.5 docs.
const OFFICIAL_NOT_FOUND = 100;

// Module-level like dellProvider's token cache: shared by every lookup() in this
// process. Reset via resetLenovoProviderState() in tests.
let officialDisabledUntil = 0;
let lastOfficialWarnAt = 0;

export function resetLenovoProviderState(): void {
  officialDisabledUntil = 0;
  lastOfficialWarnAt = 0;
}

function officialClientId(): string | undefined {
  const key = process.env.LENOVO_API_KEY?.trim();
  return key ? key : undefined;
}

function pcsupportEnabled(): boolean {
  return envFlag('LENOVO_WARRANTY_ENABLED');
}

const notFound = (error?: string): WarrantyLookupResult => ({
  found: false,
  entitlements: [],
  warrantyStartDate: null,
  warrantyEndDate: null,
  ...(error ? { error } : {}),
});

/**
 * Coerce a vendor date to YYYY-MM-DD for the `date` columns. ISO-prefixed values
 * are sliced; anything else must parse as a Date or it is dropped ('' is
 * filtered out by summarize), never passed through to Postgres.
 */
function toDateOnly(value: string | undefined | null): string {
  if (!value) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  const parsed = new Date(value);
  return isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10);
}

function summarize(entitlements: WarrantyEntitlement[]): WarrantyLookupResult {
  if (entitlements.length === 0) return notFound();
  const startDates = entitlements.map((e) => e.startDate).filter(Boolean).sort();
  const endDates = entitlements.map((e) => e.endDate).filter(Boolean).sort().reverse();
  return {
    found: true,
    entitlements,
    warrantyStartDate: startDates[0] ?? null,
    warrantyEndDate: endDates[0] ?? null,
  };
}

function warnOfficial(message: string): void {
  const now = Date.now();
  if (now - lastOfficialWarnAt < WARN_THROTTLE_MS) return;
  lastOfficialWarnAt = now;
  console.warn(`[LenovoWarranty] ${message}`);
}

// ---------------------------------------------------------------------------
// Official supportapi.lenovo.com v2.5
// ---------------------------------------------------------------------------

interface OfficialWarranty {
  ID?: string;
  Name?: string;
  Description?: string;
  Type?: string;
  Start?: string;
  End?: string;
}

interface OfficialContract {
  Contract?: string;
  SLA?: string;
  EntitlementCode?: string;
  Status?: string;
  Start?: string;
  End?: string;
}

interface OfficialResponse {
  Serial?: string;
  Product?: string;
  InWarranty?: boolean;
  Warranty?: OfficialWarranty[];
  Contract?: OfficialContract[];
  // Error envelope. The docs say error codes arrive "in the response object"
  // without pinning the field names, so accept the shapes seen in the wild.
  Error?: { Code?: number | string; Message?: string } | string;
  ErrorCode?: number | string;
  Code?: number | string;
  Message?: string;
}

// A contract with a future End but a non-active Status must not extend coverage.
const INACTIVE_CONTRACT_STATUS = /cancel|pending|suspend|inactive|terminat|expired/i;

function officialErrorCode(record: OfficialResponse): { code: number; message: string } | null {
  let raw: number | string | undefined;
  let message = record.Message ?? '';
  if (record.Error && typeof record.Error === 'object') {
    raw = record.Error.Code;
    message = record.Error.Message ?? message;
  } else if (typeof record.Error === 'string') {
    message = record.Error;
    raw = record.ErrorCode ?? record.Code;
  } else {
    raw = record.ErrorCode ?? record.Code;
  }
  if (raw === undefined && !message) return null;
  const code = Number(raw);
  return { code: isNaN(code) ? -1 : code, message };
}

/** Throws on anything that is not a definite answer, so the caller can fall back. */
function parseOfficial(body: unknown, serial: string): WarrantyLookupResult {
  const wanted = serial.toUpperCase();
  let record: OfficialResponse | undefined;
  if (Array.isArray(body)) {
    // Multi-serial variants return a list; never adopt another machine's record.
    record = (body as OfficialResponse[]).find((r) => r.Serial?.toUpperCase() === wanted);
    if (!record) throw new Error(`Lenovo API response did not include serial ${serial}`);
  } else if (body && typeof body === 'object') {
    record = body as OfficialResponse;
    if (record.Serial && record.Serial.toUpperCase() !== wanted) {
      throw new Error(`Lenovo API returned serial ${record.Serial} for ${serial}`);
    }
  }
  if (!record) throw new Error('Lenovo API returned an empty response');

  const err = officialErrorCode(record);
  if (err) {
    if (err.code === OFFICIAL_NOT_FOUND) return notFound();
    throw new Error(`Lenovo API error ${err.code}: ${err.message || 'unexpected response'}`);
  }
  if (!('Serial' in record) && !('Warranty' in record) && !('Contract' in record)) {
    throw new Error('Lenovo API returned an unrecognised response');
  }

  const entitlements: WarrantyEntitlement[] = [
    ...(record.Warranty ?? []).map((w) => ({
      provider: 'lenovo' as const,
      serviceLevelDescription: w.Name ?? w.Description ?? 'Standard',
      entitlementType: w.Type ?? 'BASE',
      startDate: toDateOnly(w.Start),
      endDate: toDateOnly(w.End),
    })),
    ...(record.Contract ?? [])
      .filter((c) => !(c.Status && INACTIVE_CONTRACT_STATUS.test(c.Status)))
      .map((c) => ({
        provider: 'lenovo' as const,
        serviceLevelDescription: c.SLA ?? c.Contract ?? 'Contract',
        entitlementType: 'CONTRACT',
        startDate: toDateOnly(c.Start),
        endDate: toDateOnly(c.End),
      })),
  ];
  return summarize(entitlements);
}

class OfficialAuthError extends Error {}

/** Throws on transport/HTTP failure so the caller can decide whether to fall back. */
async function lookupOfficial(serial: string, clientId: string): Promise<WarrantyLookupResult> {
  const response = await fetch(`${OFFICIAL_URL}?Serial=${encodeURIComponent(serial)}`, {
    method: 'GET',
    headers: {
      ClientID: clientId,
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (response.status === 401 || response.status === 403) {
    throw new OfficialAuthError(`Lenovo API ${response.status}`);
  }
  if (!response.ok) {
    throw new Error(`Lenovo API ${response.status}`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error('Lenovo API returned non-JSON');
  }
  return parseOfficial(body, serial);
}

// ---------------------------------------------------------------------------
// pcsupport.lenovo.com getIbaseInfo
// ---------------------------------------------------------------------------

interface PcsupportWarranty {
  type?: string;
  name?: string;
  description?: string;
  startDate?: string;
  endDate?: string;
}

interface PcsupportResponse {
  code?: number;
  msg?: { desc?: string | null };
  data?: {
    baseWarranties?: PcsupportWarranty[];
    upgradeWarranties?: PcsupportWarranty[];
    contractWarranties?: PcsupportWarranty[];
  } | null;
}

function parsePcsupport(body: unknown): WarrantyLookupResult {
  if (!body || typeof body !== 'object') {
    throw new Error('Lenovo pcsupport returned an empty response');
  }
  const envelope = body as PcsupportResponse;
  if (envelope.code === PCSUPPORT_NOT_FOUND) return notFound();
  if (envelope.code !== PCSUPPORT_OK) {
    throw new Error(
      `Lenovo pcsupport code ${envelope.code ?? 'unknown'}: ${envelope.msg?.desc ?? 'unexpected response'}`
    );
  }
  const all = [
    ...(envelope.data?.baseWarranties ?? []),
    ...(envelope.data?.upgradeWarranties ?? []),
    ...(envelope.data?.contractWarranties ?? []),
  ];
  const entitlements: WarrantyEntitlement[] = all.map((w) => ({
    provider: 'lenovo' as const,
    serviceLevelDescription: w.name ?? w.description ?? 'Standard',
    entitlementType: w.type ?? 'BASE',
    startDate: toDateOnly(w.startDate),
    endDate: toDateOnly(w.endDate),
  }));
  return summarize(entitlements);
}

/** Throws on transport/HTTP failure and on unexpected envelopes. */
async function lookupPcsupport(serial: string): Promise<WarrantyLookupResult> {
  const response = await fetch(PCSUPPORT_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify({ serialNumber: serial }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Lenovo pcsupport API ${response.status}`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // Akamai serves an HTML challenge page with a 200 when it decides to gate.
    throw new Error('Lenovo pcsupport returned non-JSON (bot challenge?)');
  }
  return parsePcsupport(body);
}

// ---------------------------------------------------------------------------

export const lenovoProvider: WarrantyProvider = {
  name: 'lenovo',

  supports(manufacturer: string): boolean {
    return manufacturer.toLowerCase().includes('lenovo');
  },

  isConfigured(): boolean {
    return Boolean(officialClientId()) || pcsupportEnabled();
  },

  async lookup(serialNumbers: string[]): Promise<Map<string, WarrantyLookupResult>> {
    const results = new Map<string, WarrantyLookupResult>();
    const clientId = officialClientId();
    const usePcsupport = pcsupportEnabled();

    if (!clientId && !usePcsupport) {
      for (const sn of serialNumbers) {
        results.set(sn, notFound('Lenovo warranty lookup not configured'));
      }
      return results;
    }

    // One single-serial vendor request per device, across concurrent worker
    // jobs — rate-limit at the request boundary (#3201). A fallback request is
    // a second vendor request, so it acquires again.
    for (const sn of serialNumbers) {
      let result: WarrantyLookupResult | null = null;
      let lastError: string | undefined;

      if (clientId) {
        if (Date.now() < officialDisabledUntil) {
          lastError = 'Lenovo API credentials rejected; official lookups paused';
        } else {
          await lenovoRateLimiter.acquire();
          try {
            result = await lookupOfficial(sn, clientId);
          } catch (err) {
            lastError = err instanceof Error ? err.message : String(err);
            if (err instanceof OfficialAuthError) {
              officialDisabledUntil = Date.now() + OFFICIAL_AUTH_BACKOFF_MS;
              warnOfficial(
                `official API rejected LENOVO_API_KEY (${lastError}); pausing official lookups for ${OFFICIAL_AUTH_BACKOFF_MS / 60_000} min${usePcsupport ? ', using pcsupport fallback' : ''}`
              );
            } else {
              warnOfficial(`official API failed for a serial (${lastError})${usePcsupport ? '; trying pcsupport fallback' : ''}`);
            }
          }
        }
      }

      if (!result && usePcsupport) {
        await lenovoRateLimiter.acquire();
        try {
          result = await lookupPcsupport(sn);
        } catch (err) {
          const pcsupportError = err instanceof Error ? err.message : String(err);
          lastError = lastError ? `${pcsupportError} (official: ${lastError})` : pcsupportError;
        }
      }

      results.set(sn, result ?? notFound(lastError));
    }

    return results;
  },
};
