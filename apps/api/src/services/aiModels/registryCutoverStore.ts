/**
 * The SQL behind the per-partner registry gate (W03 #7601 Task 6A; W08 #7606).
 * One function per step registryCutover.ts takes, so its unit test can stand
 * the table in memory. Each runs in its own SYSTEM context outside any ambient
 * request transaction.
 */
import { eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { aiModelRegistryPartnerCutover } from '../../db/schema';
import { lockPartnerRegistry } from './registryWriteLock';

const sys = <T>(fn: () => Promise<T>, label: string) =>
  runOutsideDbContext(() => withSystemDbAccessContext(fn, label));

/**
 * ONE system transaction: the per-partner registry lock → existence check →
 * fn → cutover row. A throw from fn rolls back the bootstrap AND leaves the
 * partner un-rowed, so a half-bootstrapped partner is never marked done.
 */
export async function withPartnerCutoverTx(partnerId: string, fn: (exists: boolean) => Promise<void>): Promise<void> {
  await sys(async () => {
    // The transaction-scoped advisory lock every registry writer takes
    // (re-entrant within the session): concurrent gates for one partner
    // serialize here, and the loser sees the winner's committed row below.
    await lockPartnerRegistry(partnerId);
    const [row] = await db.select({ id: aiModelRegistryPartnerCutover.partnerId }).from(aiModelRegistryPartnerCutover)
      .where(eq(aiModelRegistryPartnerCutover.partnerId, partnerId)).limit(1);
    await fn(Boolean(row));
    if (!row) await db.insert(aiModelRegistryPartnerCutover).values({ partnerId }).onConflictDoNothing();
  }, 'aiModelRegistry.cutoverPartner');
}

export async function hasCutoverRow(partnerId: string): Promise<boolean> {
  const [row] = await sys(() => db.select({ id: aiModelRegistryPartnerCutover.partnerId }).from(aiModelRegistryPartnerCutover)
    .where(eq(aiModelRegistryPartnerCutover.partnerId, partnerId)).limit(1), 'aiModelRegistry.cutoverRow');
  return Boolean(row);
}
