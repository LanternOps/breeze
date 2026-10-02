/**
 * The SQL behind the W03 registry cutover (#7601, Task 6A). One function per
 * step registryCutover.ts takes, so its unit test can stand the two tables in
 * memory. Every function runs in its own SYSTEM context outside any ambient
 * request transaction, except the stale-offering disable, which runs inside
 * withPartnerCutoverTx's transaction.
 */
import { and, asc, eq, gt, inArray, not, notExists, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { aiModelRegistryPartnerCutover, aiModelRegistryState, partnerAiModels, partners } from '../../db/schema';
import { lockPartnerRegistryReconcile } from './legacyReconcile';

const sys = <T>(fn: () => Promise<T>, label: string) =>
  runOutsideDbContext(() => withSystemDbAccessContext(fn, label));

const leaseSecs = (leaseMs: number) => Math.max(1, Math.ceil(leaseMs / 1000));

/**
 * ONE system transaction: W02's per-partner reconcile lock → existence check →
 * fn → cutover row. A throw from fn rolls back the projection AND leaves the
 * partner un-rowed, so a half-projected partner is never marked cut over.
 */
export async function withPartnerCutoverTx(partnerId: string, fn: (exists: boolean) => Promise<void>): Promise<void> {
  await sys(async () => {
    // The same transaction-scoped advisory lock W02's reconcile takes (re-entrant
    // within the session): concurrent cutovers of one partner serialize here, and
    // the loser sees the winner's committed row below.
    await lockPartnerRegistryReconcile(partnerId);
    const [row] = await db.select({ id: aiModelRegistryPartnerCutover.partnerId }).from(aiModelRegistryPartnerCutover)
      .where(eq(aiModelRegistryPartnerCutover.partnerId, partnerId)).limit(1);
    await fn(Boolean(row));
    if (!row) await db.insert(aiModelRegistryPartnerCutover).values({ partnerId }).onConflictDoNothing();
  }, 'aiModelRegistry.cutoverPartner');
}

/**
 * Stale-offering rule (W02 handoff): before cutover the partner's registry is
 * a pure projection of legacy config — nothing else writes partner_ai_models —
 * so an enabled offering the final projection pass did not produce is a
 * leftover of an earlier projection (an old default model, a BYOK → catalog
 * switch, the orphan pass's interim platform offerings). The projection has
 * just rewritten every assignment of the partner and rebound every live
 * session and live agent onto produced offerings, so nothing that routes
 * references a stale one. Disabled (enabled = false), never deleted: ledger
 * rows, expired sessions and disabled agents keep their references. Must run
 * inside withPartnerCutoverTx's transaction, after the projection.
 */
export async function disableUnproducedOfferings(partnerId: string, producedOfferingIds: readonly string[]): Promise<number> {
  const disabled = await db.update(partnerAiModels)
    .set({ enabled: false, updatedAt: new Date() })
    .where(and(
      eq(partnerAiModels.partnerId, partnerId),
      eq(partnerAiModels.enabled, true),
      producedOfferingIds.length ? not(inArray(partnerAiModels.id, [...producedOfferingIds])) : undefined,
    ))
    .returning({ id: partnerAiModels.id });
  return disabled.length;
}

export async function hasCutoverRow(partnerId: string): Promise<boolean> {
  const [row] = await sys(() => db.select({ id: aiModelRegistryPartnerCutover.partnerId }).from(aiModelRegistryPartnerCutover)
    .where(eq(aiModelRegistryPartnerCutover.partnerId, partnerId)).limit(1), 'aiModelRegistry.cutoverRow');
  return Boolean(row);
}

/** CAS on the singleton: free, expired, or already ours. 'complete' once the stamp is set (monotonic). */
export async function takeLease(owner: string, leaseMs: number): Promise<'taken' | 'held' | 'complete'> {
  return sys(async () => {
    const taken = await db.update(aiModelRegistryState)
      .set({
        leaseOwner: owner,
        leaseExpiresAt: sql`now() + make_interval(secs => ${leaseSecs(leaseMs)})`,
        updatedAt: sql`now()`,
      })
      .where(and(
        eq(aiModelRegistryState.id, 1),
        sql`${aiModelRegistryState.cutoverCompletedAt} IS NULL`,
        sql`(${aiModelRegistryState.leaseExpiresAt} IS NULL OR ${aiModelRegistryState.leaseExpiresAt} < now() OR ${aiModelRegistryState.leaseOwner} = ${owner})`,
      ))
      .returning({ id: aiModelRegistryState.id });
    if (taken.length > 0) return 'taken';
    const [state] = await db.select({ completedAt: aiModelRegistryState.cutoverCompletedAt }).from(aiModelRegistryState)
      .where(eq(aiModelRegistryState.id, 1)).limit(1);
    if (!state) throw new Error('ai_model_registry_state singleton is missing');
    return state.completedAt ? 'complete' : 'held';
  }, 'aiModelRegistry.cutoverLease');
}

export async function renewLease(owner: string, leaseMs: number): Promise<boolean> {
  const renewed = await sys(() => db.update(aiModelRegistryState)
    .set({ leaseExpiresAt: sql`now() + make_interval(secs => ${leaseSecs(leaseMs)})`, updatedAt: sql`now()` })
    .where(and(eq(aiModelRegistryState.id, 1), eq(aiModelRegistryState.leaseOwner, owner)))
    .returning({ id: aiModelRegistryState.id }), 'aiModelRegistry.cutoverLease');
  return renewed.length > 0;
}

/** Partners with no cutover row, in id order after `after`. The anti-join IS the resume cursor. */
export async function nextUncutPartners(after: string | null, limit: number): Promise<string[]> {
  const rows = await sys(() => db.select({ id: partners.id }).from(partners)
    .where(and(
      after ? gt(partners.id, after) : undefined,
      notExists(db.select({ x: sql`1` }).from(aiModelRegistryPartnerCutover)
        .where(eq(aiModelRegistryPartnerCutover.partnerId, partners.id))),
    ))
    .orderBy(asc(partners.id)).limit(limit), 'aiModelRegistry.cutoverSweep');
  return rows.map((r) => r.id);
}

/** Monotonic: COALESCE never moves or clears an existing stamp (finding 8). Owner-guarded. */
export async function markComplete(owner: string): Promise<boolean> {
  const marked = await sys(() => db.update(aiModelRegistryState)
    .set({
      cutoverCompletedAt: sql`COALESCE(${aiModelRegistryState.cutoverCompletedAt}, now())`,
      leaseOwner: null, leaseExpiresAt: null, updatedAt: sql`now()`,
    })
    .where(and(eq(aiModelRegistryState.id, 1), eq(aiModelRegistryState.leaseOwner, owner)))
    .returning({ id: aiModelRegistryState.id }), 'aiModelRegistry.cutoverLease');
  return marked.length > 0;
}

export async function releaseLease(owner: string): Promise<void> {
  await sys(() => db.update(aiModelRegistryState)
    .set({ leaseOwner: null, leaseExpiresAt: null, updatedAt: sql`now()` })
    .where(and(eq(aiModelRegistryState.id, 1), eq(aiModelRegistryState.leaseOwner, owner))), 'aiModelRegistry.cutoverLease');
}
