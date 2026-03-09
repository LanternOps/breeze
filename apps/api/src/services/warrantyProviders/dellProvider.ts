import type { WarrantyProvider, WarrantyLookupResult, WarrantyEntitlement } from './types';

// Module-level OAuth token cache with promise coalescing to prevent concurrent token fetches
let tokenPromise: Promise<string> | null = null;
let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  // Return cached token if still valid (with 60s buffer)
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.token;
  }

  // Coalesce concurrent requests into a single token fetch
  if (tokenPromise) return tokenPromise;

  tokenPromise = fetchNewToken().finally(() => { tokenPromise = null; });
  return tokenPromise;
}

async function fetchNewToken(): Promise<string> {
  const clientId = process.env.DELL_CLIENT_ID;
  const clientSecret = process.env.DELL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('Dell API credentials not configured');
  }

  const response = await fetch('https://apigtwb2c.us.dell.com/auth/oauth/v2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!response.ok) {
    throw new Error(`Dell OAuth failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json() as { access_token: string; expires_in: number };
  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };

  return cachedToken.token;
}

export const dellProvider: WarrantyProvider = {
  name: 'dell',

  supports(manufacturer: string): boolean {
    return manufacturer.toLowerCase().includes('dell');
  },

  isConfigured(): boolean {
    return Boolean(process.env.DELL_CLIENT_ID && process.env.DELL_CLIENT_SECRET);
  },

  async lookup(serialNumbers: string[]): Promise<Map<string, WarrantyLookupResult>> {
    const results = new Map<string, WarrantyLookupResult>();

    // Batch up to 100 service tags per request
    const batches: string[][] = [];
    for (let i = 0; i < serialNumbers.length; i += 100) {
      batches.push(serialNumbers.slice(i, i + 100));
    }

    const token = await getAccessToken();

    for (const batch of batches) {
      try {
        const tags = batch.join(',');
        const response = await fetch(
          `https://apigtwb2c.us.dell.com/PROD/sbil/eapi/v5/asset-entitlements?servicetags=${encodeURIComponent(tags)}`,
          {
            headers: { Authorization: `Bearer ${token}` },
          }
        );

        if (!response.ok) {
          const errorText = await response.text();
          for (const sn of batch) {
            results.set(sn, {
              found: false,
              entitlements: [],
              warrantyStartDate: null,
              warrantyEndDate: null,
              error: `Dell API ${response.status}: ${errorText.slice(0, 200)}`,
            });
          }
          continue;
        }

        const data = await response.json() as Array<{
          serviceTag: string;
          shipDate?: string;
          entitlements?: Array<{
            serviceLevelDescription?: string;
            entitlementType?: string;
            startDate?: string;
            endDate?: string;
          }>;
        }>;

        // Map results by service tag
        const dataMap = new Map(data.map((d) => [d.serviceTag?.toUpperCase(), d]));

        for (const sn of batch) {
          const asset = dataMap.get(sn.toUpperCase());
          if (!asset || !asset.entitlements?.length) {
            results.set(sn, {
              found: false,
              entitlements: [],
              warrantyStartDate: null,
              warrantyEndDate: null,
            });
            continue;
          }

          const entitlements: WarrantyEntitlement[] = asset.entitlements.map((e) => ({
            provider: 'dell' as const,
            serviceLevelDescription: e.serviceLevelDescription ?? 'Unknown',
            entitlementType: e.entitlementType ?? 'UNKNOWN',
            startDate: e.startDate ?? '',
            endDate: e.endDate ?? '',
          }));

          // Find the latest end date across all entitlements
          const endDates = entitlements
            .map((e) => e.endDate)
            .filter(Boolean)
            .sort()
            .reverse();

          const startDates = entitlements
            .map((e) => e.startDate)
            .filter(Boolean)
            .sort();

          results.set(sn, {
            found: true,
            entitlements,
            warrantyStartDate: startDates[0] ?? null,
            warrantyEndDate: endDates[0] ?? null,
          });
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        for (const sn of batch) {
          if (!results.has(sn)) {
            results.set(sn, {
              found: false,
              entitlements: [],
              warrantyStartDate: null,
              warrantyEndDate: null,
              error: errorMsg,
            });
          }
        }
      }
    }

    return results;
  },
};
