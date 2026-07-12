import { eq, isNull, inArray } from 'drizzle-orm';
import { db } from '../../db';
import { partnerAbuseSignals } from '../../db/schema';
import { captureException } from '../sentry';
import type { ComputedSignal } from './types';

const key = (partnerId: string, signalKey: string) => `${partnerId}|${signalKey}`;

/**
 * Reconciles this sweep's computed signals against open rows. State-based
 * dedup: notify on first alert firing or on escalation-to-alert, never on
 * hourly recomputation of an already-delivered alert. MUST run inside a
 * system DB context.
 *
 * Stale-resolution rule (state-machine rule 3): an open row is auto-resolved
 * as stale ONLY when (a) its signalKey is an `invariant.*` row — those are
 * computed fleet-wide every sweep, so absence this sweep is real evidence
 * the condition cleared — OR (b) its partnerId is in `evaluatedPartnerIds`,
 * i.e. this sweep actually scored that partner and it simply didn't fire.
 * Rows belonging to a partner the `scoped` CTE excluded this sweep (aged out
 * of the young/recently-enrolling window) are left untouched — resolving
 * them would be resolving on scope exit, not on evidence the abuse cleared.
 */
export async function persistSignals(
  computed: ComputedSignal[],
  now: Date,
  evaluatedPartnerIds: ReadonlySet<string>,
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
      // In practice this should never happen — but if it does, it's a silent
      // RLS misconfiguration (a row that INSERT reported success for but the
      // caller can't read back), not something to quietly skip.
      if (!row) {
        console.error('[AbuseSignals] INSERT returned no row — possible RLS misconfiguration', {
          partnerId: s.partnerId,
          signalKey: s.signalKey,
        });
        captureException(new Error('[AbuseSignals] INSERT returned no row — possible RLS misconfiguration'));
        continue;
      }
      if (s.severity === 'alert') toNotify.push({ ...s, rowId: row.id });
      continue;
    }

    await db
      .update(partnerAbuseSignals)
      .set({ severity: s.severity, score: s.score, evidence: s.evidence, computedAt: now })
      .where(eq(partnerAbuseSignals.id, open.id));

    // An open row that was never delivered/acknowledged must still notify if
    // EITHER this sweep's severity is 'alert' OR the row was already sitting
    // at 'alert' severity before this update — otherwise a decayed-but-
    // undelivered alert (e.g. score dropped back to 'watch' this sweep
    // before ever reaching an operator) would silently vanish without ever
    // having been seen.
    const hadUndeliveredAlert = open.severity === 'alert' && open.deliveredAt === null;
    const notifiable =
      (s.severity === 'alert' || hadUndeliveredAlert) &&
      open.deliveredAt === null &&
      open.acknowledgedAt === null;
    if (notifiable) toNotify.push({ ...s, rowId: open.id });
  }

  const staleRows = openRows
    .filter((r) => !firedKeys.has(key(r.partnerId, r.signalKey)))
    .filter((r) => r.signalKey.startsWith('invariant.') || evaluatedPartnerIds.has(r.partnerId));

  // An alert-grade condition that was never delivered or acknowledged is
  // about to be auto-resolved as stale — i.e. it will disappear having never
  // been seen by an operator. That's worth a loud record even though we
  // still resolve it (the condition genuinely cleared; we just want a trail).
  for (const r of staleRows) {
    if (r.severity === 'alert' && r.deliveredAt === null && r.acknowledgedAt === null) {
      console.error('[AbuseSignals] Resolving an undelivered alert-severity signal as stale', {
        rowId: r.id,
        partnerId: r.partnerId,
        signalKey: r.signalKey,
      });
      captureException(
        new Error('[AbuseSignals] Resolving an undelivered alert-severity signal as stale'),
      );
    }
  }

  const staleIds = staleRows.map((r) => r.id);
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
