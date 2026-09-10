import type { WarrantyProvider, WarrantyLookupResult, WarrantyEntitlement } from './types';
import { lenovoRateLimiter } from './throttle';

// Two ways to reach Lenovo, tried in this order per serial:
//
// 1. Official Warranty API (LENOVO_API_KEY): GET supportapi.lenovo.com/v2.5/warranty
//    with a Lenovo-issued ClientID header. Documented at
//    https://supportapi.lenovo.com/Documentation/Warranty.html — Lenovo hands the
//    ClientID out through a partner manager, so most deployments will not have one.
//
// 2. pcsupport.lenovo.com (LENOVO_WARRANTY_ENABLED=true): the JSON endpoint behind
//    Lenovo's public warranty-lookup page. Needs no credential, but it is
//    undocumented and could change or be bot-gated at any time, so it is opt-in
//    (same posture as HP_WARRANTY_ENABLED). Verified 2026-09-09 against real
//    serials: the body key is `serialNumber` (case-sensitive — `Serial` returns
//    "No information was found"), the method must be POST, and Akamai rejects
//    default curl-style User-Agents but accepts a plain product token.
//
// When both are configured the official API is authoritative: a definite
// not-found from it is final, and pcsupport is only consulted when the official
// call fails (bad/expired key, outage, non-2xx).

const OFFICIAL_URL = 'https://supportapi.lenovo.com/v2.5/warranty';
const PCSUPPORT_URL = 'https://pcsupport.lenovo.com/us/en/api/v4/upsell/redport/getIbaseInfo';
const USER_AGENT = 'Mozilla/5.0 (compatible; Breeze-RMM/1.0)';

// pcsupport envelope codes observed live.
const PCSUPPORT_OK = 0;
const PCSUPPORT_NOT_FOUND = 100;

function officialClientId(): string | undefined {
  const key = process.env.LENOVO_API_KEY?.trim();
  return key ? key : undefined;
}

function pcsupportEnabled(): boolean {
  const v = process.env.LENOVO_WARRANTY_ENABLED;
  return v === 'true' || v === '1';
}

const notFound = (error?: string): WarrantyLookupResult => ({
  found: false,
  entitlements: [],
  warrantyStartDate: null,
  warrantyEndDate: null,
  ...(error ? { error } : {}),
});

/** "2025-12-23T00:00:00" → "2025-12-23"; anything else passes through. */
function toDateOnly(value: string | undefined | null): string {
  if (!value) return '';
  return /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : value;
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
}

function parseOfficial(body: unknown, serial: string): WarrantyLookupResult {
  // Single-serial GET returns one object; the multi-serial variants return a list.
  let record: OfficialResponse | undefined;
  if (Array.isArray(body)) {
    const list = body as OfficialResponse[];
    record = list.find((r) => r.Serial?.toUpperCase() === serial.toUpperCase()) ?? list[0];
  } else if (body && typeof body === 'object') {
    record = body as OfficialResponse;
  }
  if (!record) return notFound();

  const entitlements: WarrantyEntitlement[] = [
    ...(record.Warranty ?? []).map((w) => ({
      provider: 'lenovo' as const,
      serviceLevelDescription: w.Name ?? w.Description ?? 'Standard',
      entitlementType: w.Type ?? 'BASE',
      startDate: toDateOnly(w.Start),
      endDate: toDateOnly(w.End),
    })),
    ...(record.Contract ?? []).map((c) => ({
      provider: 'lenovo' as const,
      serviceLevelDescription: c.SLA ?? c.Contract ?? 'Contract',
      entitlementType: 'CONTRACT',
      startDate: toDateOnly(c.Start),
      endDate: toDateOnly(c.End),
    })),
  ];
  return summarize(entitlements);
}

/** Throws on transport/HTTP failure so the caller can decide whether to fall back. */
async function lookupOfficial(serial: string, clientId: string): Promise<WarrantyLookupResult> {
  const response = await fetch(`${OFFICIAL_URL}?Serial=${encodeURIComponent(serial)}`, {
    method: 'GET',
    headers: {
      ClientID: clientId,
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
    },
  });
  if (!response.ok) {
    throw new Error(`Lenovo API ${response.status}`);
  }
  return parseOfficial(await response.json(), serial);
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

function parsePcsupport(body: PcsupportResponse): WarrantyLookupResult {
  if (body.code === PCSUPPORT_NOT_FOUND) return notFound();
  if (body.code !== PCSUPPORT_OK) {
    throw new Error(`Lenovo pcsupport code ${body.code ?? 'unknown'}: ${body.msg?.desc ?? 'unexpected response'}`);
  }
  const all = [
    ...(body.data?.baseWarranties ?? []),
    ...(body.data?.upgradeWarranties ?? []),
    ...(body.data?.contractWarranties ?? []),
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

/** Throws on transport/HTTP failure and on unexpected envelope codes. */
async function lookupPcsupport(serial: string): Promise<WarrantyLookupResult> {
  const response = await fetch(PCSUPPORT_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify({ serialNumber: serial }),
  });
  if (!response.ok) {
    throw new Error(`Lenovo pcsupport API ${response.status}`);
  }
  return parsePcsupport((await response.json()) as PcsupportResponse);
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
        await lenovoRateLimiter.acquire();
        try {
          result = await lookupOfficial(sn, clientId);
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
        }
      }

      if (!result && usePcsupport) {
        await lenovoRateLimiter.acquire();
        try {
          result = await lookupPcsupport(sn);
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
        }
      }

      results.set(sn, result ?? notFound(lastError));
    }

    return results;
  },
};
