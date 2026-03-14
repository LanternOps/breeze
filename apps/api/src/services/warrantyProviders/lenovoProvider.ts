import type { WarrantyProvider, WarrantyLookupResult, WarrantyEntitlement } from './types';

export const lenovoProvider: WarrantyProvider = {
  name: 'lenovo',

  supports(manufacturer: string): boolean {
    return manufacturer.toLowerCase().includes('lenovo');
  },

  isConfigured(): boolean {
    return Boolean(process.env.LENOVO_API_KEY);
  },

  async lookup(serialNumbers: string[]): Promise<Map<string, WarrantyLookupResult>> {
    const results = new Map<string, WarrantyLookupResult>();
    const apiKey = process.env.LENOVO_API_KEY;

    if (!apiKey) {
      for (const sn of serialNumbers) {
        results.set(sn, {
          found: false,
          entitlements: [],
          warrantyStartDate: null,
          warrantyEndDate: null,
          error: 'Lenovo API key not configured',
        });
      }
      return results;
    }

    for (const sn of serialNumbers) {
      try {
        const response = await fetch(
          `https://pcsupport.lenovo.com/us/en/api/v4/upsell/redport/getIbaseInfo?Serial=${encodeURIComponent(sn)}`,
          {
            headers: {
              'ClientID': apiKey,
              Accept: 'application/json',
            },
          }
        );

        if (!response.ok) {
          results.set(sn, {
            found: false,
            entitlements: [],
            warrantyStartDate: null,
            warrantyEndDate: null,
            error: `Lenovo API ${response.status}`,
          });
          continue;
        }

        const data = await response.json() as {
          BaseWarranties?: Array<{
            Description?: string;
            Type?: string;
            Start?: string;
            End?: string;
          }>;
          UpmaWarranties?: Array<{
            Description?: string;
            Type?: string;
            Start?: string;
            End?: string;
          }>;
        };

        const allWarranties = [
          ...(data.BaseWarranties ?? []),
          ...(data.UpmaWarranties ?? []),
        ];

        if (allWarranties.length === 0) {
          results.set(sn, {
            found: false,
            entitlements: [],
            warrantyStartDate: null,
            warrantyEndDate: null,
          });
          continue;
        }

        const entitlements: WarrantyEntitlement[] = allWarranties.map((w) => ({
          provider: 'lenovo' as const,
          serviceLevelDescription: w.Description ?? 'Standard',
          entitlementType: w.Type ?? 'INITIAL',
          startDate: w.Start ?? '',
          endDate: w.End ?? '',
        }));

        const endDates = entitlements.map((e) => e.endDate).filter(Boolean).sort().reverse();
        const startDates = entitlements.map((e) => e.startDate).filter(Boolean).sort();

        results.set(sn, {
          found: true,
          entitlements,
          warrantyStartDate: startDates[0] ?? null,
          warrantyEndDate: endDates[0] ?? null,
        });
      } catch (err) {
        results.set(sn, {
          found: false,
          entitlements: [],
          warrantyStartDate: null,
          warrantyEndDate: null,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return results;
  },
};
