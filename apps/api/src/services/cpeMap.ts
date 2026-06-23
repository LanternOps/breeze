import { db, withSystemDbAccessContext } from '../db';
import { softwareProducts } from '../db/schema';
import cpeMapJson from './__fixtures__/cpe-map.json';

export const CPE_MAP = cpeMapJson as Array<{ name: string; vendor: string | null; cpe: string }>;

export const normalizeName = (s: string): string => s.toLowerCase().trim();
export const normalizeVendor = (s: string | null): string | null => (
  s ? s.toLowerCase().trim() : null
);

export async function seedCpeMap(): Promise<number> {
  return withSystemDbAccessContext(async () => {
    let count = 0;

    for (const entry of CPE_MAP) {
      await db
        .insert(softwareProducts)
        .values({
          normalizedName: normalizeName(entry.name),
          normalizedVendor: normalizeVendor(entry.vendor),
          cpe: entry.cpe,
          cpeConfidence: 'curated',
        })
        .onConflictDoUpdate({
          target: [softwareProducts.normalizedName, softwareProducts.normalizedVendor],
          set: {
            cpe: entry.cpe,
            cpeConfidence: 'curated',
          },
        });
      count += 1;
    }

    return count;
  });
}
