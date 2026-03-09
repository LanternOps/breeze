import type { WarrantyProvider, WarrantyLookupResult, WarrantyEntitlement } from './types';

export const hpProvider: WarrantyProvider = {
  name: 'hp',

  supports(manufacturer: string): boolean {
    const lower = manufacturer.toLowerCase();
    return lower.includes('hp') || lower.includes('hewlett');
  },

  isConfigured(): boolean {
    const enabled = process.env.HP_WARRANTY_ENABLED;
    // Opt-in only — requires explicit enable (consistent with Dell/Lenovo credential requirements)
    return enabled === 'true' || enabled === '1';
  },

  async lookup(serialNumbers: string[]): Promise<Map<string, WarrantyLookupResult>> {
    const results = new Map<string, WarrantyLookupResult>();

    // HP unofficial API — single serial lookup, no batching
    for (const sn of serialNumbers) {
      try {
        const response = await fetch(
          `https://support.hp.com/hp-pps-api/os/getWarrantyInfo?serialNumber=${encodeURIComponent(sn)}&country=US`,
          {
            headers: {
              Accept: 'application/json',
              'User-Agent': 'Mozilla/5.0',
            },
          }
        );

        if (!response.ok) {
          results.set(sn, {
            found: false,
            entitlements: [],
            warrantyStartDate: null,
            warrantyEndDate: null,
            error: `HP API ${response.status}`,
          });
          continue;
        }

        const data = await response.json() as {
          warrantyResultList?: Array<{
            warrantyType?: string;
            startDate?: string;
            endDate?: string;
          }>;
          overallWarrantyStartDate?: string;
          overallWarrantyEndDate?: string;
        };

        if (!data.warrantyResultList?.length) {
          results.set(sn, {
            found: false,
            entitlements: [],
            warrantyStartDate: null,
            warrantyEndDate: null,
          });
          continue;
        }

        const entitlements: WarrantyEntitlement[] = data.warrantyResultList.map((w) => ({
          provider: 'hp' as const,
          serviceLevelDescription: w.warrantyType ?? 'Standard',
          entitlementType: 'INITIAL',
          startDate: w.startDate ?? '',
          endDate: w.endDate ?? '',
        }));

        results.set(sn, {
          found: true,
          entitlements,
          warrantyStartDate: data.overallWarrantyStartDate ?? entitlements[0]?.startDate ?? null,
          warrantyEndDate: data.overallWarrantyEndDate ?? entitlements[entitlements.length - 1]?.endDate ?? null,
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
