import { db } from '../db';
import { cisCheckCatalog } from '../db/schema';
import { defaultCisCatalog } from './cisHardening';

export async function seedDefaultCisCheckCatalog(): Promise<number> {
  if (defaultCisCatalog.length === 0) return 0;

  const now = new Date();
  const values = defaultCisCatalog.map((item) => ({
    osType: item.osType,
    benchmarkVersion: item.benchmarkVersion,
    level: item.level,
    checkId: item.checkId,
    title: item.title,
    severity: item.severity,
    defaultAction: item.defaultAction,
    isActive: true,
    createdAt: now,
    updatedAt: now,
  }));

  const inserted = await db
    .insert(cisCheckCatalog)
    .values(values)
    .onConflictDoNothing({
      target: [
        cisCheckCatalog.osType,
        cisCheckCatalog.benchmarkVersion,
        cisCheckCatalog.level,
        cisCheckCatalog.checkId,
      ],
    })
    .returning({ id: cisCheckCatalog.id });

  return inserted.length;
}
