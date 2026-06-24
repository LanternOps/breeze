import '../__tests__/integration/setup';

import { beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';

import { db, withSystemDbAccessContext } from '../db';
import { softwareProducts } from '../db/schema';
import { seedCpeMap } from './cpeMap';

const runDb = it.runIf(!!process.env.DATABASE_URL);

beforeEach(async () => {
  await withSystemDbAccessContext(async () => {
    await db.delete(softwareProducts);
  });
});

async function countSoftwareProducts(): Promise<number> {
  const [row] = await withSystemDbAccessContext(() =>
    db.select({ count: sql<number>`count(*)` }).from(softwareProducts)
  );
  return Number(row?.count ?? 0);
}

describe('seedCpeMap', () => {
  runDb('seeds curated products with cpeConfidence=curated', async () => {
    const count = await seedCpeMap();

    expect(count).toBeGreaterThan(0);

    const rows = await withSystemDbAccessContext(() =>
      db
        .select()
        .from(softwareProducts)
        .where(eq(softwareProducts.cpeConfidence, 'curated'))
    );

    const chrome = rows.find((row) => row.normalizedName === 'google chrome');
    expect(chrome?.normalizedVendor).toBe('google llc');
    expect(chrome?.cpe).toBe('cpe:2.3:a:google:chrome');
  });

  runDb('is idempotent and does not increase software product count', async () => {
    await seedCpeMap();
    const before = await countSoftwareProducts();

    await seedCpeMap();
    const after = await countSoftwareProducts();

    expect(after).toBe(before);
  });
});
