// Owner: W02f (90-day "controls met" history). buildSections (./index.ts) only calls this when the frozen config's
// showHistory is true; the guard is repeated here so the module is safe on its own.
//
// History lives inside the snapshot but outside payloadSha256 (Open Decision 1): it grows on its own, and the
// portal appends the current point at lastEvaluatedAt. It records change-points only: snapshots are stored when
// the payload hash changes, and consecutive equal (met, shown) pairs are collapsed here at read time. It is built
// from ALL earlier snapshots of the page, so enabling history can surface changes from before it was enabled.
import { and, asc, desc, eq, gte, lt, sql } from 'drizzle-orm';
import { TRUST_HISTORY_MAX_POINTS, type TrustPagePublicPayload } from '@breeze/shared';
import { db } from '../../../db';
import { trustPageSnapshots } from '../../../db/schema';
import type { SectionBuildContext } from './types';

const WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

// Built per call, not at module load: suites that mock `../db/schema` partially (routes/portal.test.ts and
// friends) import this module transitively, and a top-level `trustPageSnapshots.payload` would throw there.
// The counts come back as text with no SQL cast: one malformed old snapshot (say controlsMet 3.5) would make a
// `::int` cast raise and fail the whole publish or refresh. readCount() parses them, and bad rows are skipped.
const historyColumns = () => ({
  generatedAt: trustPageSnapshots.generatedAt,
  met: sql<string | null>`${trustPageSnapshots.payload}->'summary'->>'controlsMet'`,
  shown: sql<string | null>`${trustPageSnapshots.payload}->'summary'->>'controlsShown'`,
});

/** A non-negative safe integer written as plain digits, else null. Rejects '3.5', '-1', '1e2', 'x' and overflow. */
function readCount(v: string | null): number | null {
  if (v === null || !/^\d+$/.test(v)) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : null;
}

export async function buildHistory(ctx: SectionBuildContext): Promise<TrustPagePublicPayload['history']> {
  if (!ctx.config.showHistory) return [];
  const windowStart = new Date(ctx.asOf.getTime() - WINDOW_MS);
  // The snapshot being built is not in the table yet, so it is excluded by construction.
  const cols = historyColumns();
  const inWindow = await db.select(cols).from(trustPageSnapshots)
    .where(and(eq(trustPageSnapshots.trustPageId, ctx.page.id), gte(trustPageSnapshots.generatedAt, windowStart)))
    .orderBy(asc(trustPageSnapshots.generatedAt));
  // The newest point before the window is the baseline: it says what the state was when the window opened.
  const baseline = await db.select(cols).from(trustPageSnapshots)
    .where(and(eq(trustPageSnapshots.trustPageId, ctx.page.id), lt(trustPageSnapshots.generatedAt, windowStart)))
    .orderBy(desc(trustPageSnapshots.generatedAt)).limit(1);

  const out: TrustPagePublicPayload['history'] = [];
  let skipped = 0;
  for (const r of [...baseline, ...inWindow]) {
    const met = readCount(r.met);
    const shown = readCount(r.shown);
    if (met === null || shown === null) { skipped++; continue; } // unreadable (e.g. a very old payload)
    const prev = out[out.length - 1];
    if (prev && prev.met === met && prev.shown === shown) continue;
    out.push({ at: r.generatedAt.toISOString(), met, shown });
  }
  if (skipped > 0) console.warn('[trustPage] history skipped unreadable snapshots', { pageId: ctx.page.id, skipped });
  return out.slice(-TRUST_HISTORY_MAX_POINTS);
}
