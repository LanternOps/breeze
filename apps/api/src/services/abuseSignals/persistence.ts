import { eq, isNull, inArray } from 'drizzle-orm';
import { db } from '../../db';
import { partnerAbuseSignals } from '../../db/schema';
import type { ComputedSignal } from './types';

const key = (partnerId: string, signalKey: string) => `${partnerId}|${signalKey}`;

/**
 * Reconciles this sweep's computed signals against open rows. State-based
 * dedup: notify on first alert firing or on escalation-to-alert, never on
 * hourly recomputation of an already-delivered alert. MUST run inside a
 * system DB context.
 */
export async function persistSignals(
  computed: ComputedSignal[],
  now: Date,
): Promise<{ toNotify: Array<ComputedSignal & { rowId: string }> }> {
  // Defensive: one entry per (partner, signal) — the open-row unique index
  // would reject a duplicate INSERT mid-loop. Last write wins.
  const dedupedByKey = new Map<string, ComputedSignal>();
  for (const s of computed) dedupedByKey.set(key(s.partnerId, s.signalKey), s);
  const deduped = [...dedupedByKey.values()];

  const openRows = await db
    .select()
    .from(partnerAbuseSignals)
    .where(isNull(partnerAbuseSignals.resolvedAt));

  const openByKey = new Map(openRows.map((r) => [key(r.partnerId, r.signalKey), r]));
  const firedKeys = new Set(deduped.map((s) => key(s.partnerId, s.signalKey)));
  const toNotify: Array<ComputedSignal & { rowId: string }> = [];

  for (const s of deduped) {
    const open = openByKey.get(key(s.partnerId, s.signalKey));
    if (!open) {
      const [row] = await db
        .insert(partnerAbuseSignals)
        .values({
          partnerId: s.partnerId,
          signalKey: s.signalKey,
          severity: s.severity,
          score: s.score,
          evidence: s.evidence,
          firstFiredAt: now,
          computedAt: now,
        })
        .returning();
      // noUncheckedIndexedAccess: .returning() is typed as possibly-empty;
      // an INSERT that runs without error always returns the inserted row.
      if (!row) continue;
      if (s.severity === 'alert') toNotify.push({ ...s, rowId: row.id });
      continue;
    }

    await db
      .update(partnerAbuseSignals)
      .set({ severity: s.severity, score: s.score, evidence: s.evidence, computedAt: now })
      .where(eq(partnerAbuseSignals.id, open.id));

    const notifiable =
      s.severity === 'alert' && open.deliveredAt === null && open.acknowledgedAt === null;
    if (notifiable) toNotify.push({ ...s, rowId: open.id });
  }

  const staleIds = openRows
    .filter((r) => !firedKeys.has(key(r.partnerId, r.signalKey)))
    .map((r) => r.id);
  if (staleIds.length > 0) {
    await db
      .update(partnerAbuseSignals)
      .set({ resolvedAt: now })
      .where(inArray(partnerAbuseSignals.id, staleIds));
  }

  return { toNotify };
}

/** MUST run inside a system DB context. */
export async function markDelivered(rowIds: string[], now: Date): Promise<void> {
  if (rowIds.length === 0) return;
  await db
    .update(partnerAbuseSignals)
    .set({ deliveredAt: now })
    .where(inArray(partnerAbuseSignals.id, rowIds));
}
