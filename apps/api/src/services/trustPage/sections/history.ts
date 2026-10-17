// Owner: W02f (90-day "controls met" history). buildSections (./index.ts) only calls this when the frozen config's
// showHistory is true; the guard is repeated here so the module is safe on its own.
//
// History lives inside the snapshot but outside payloadSha256 (Open Decision 1): it grows on its own, and the
// portal appends the current point at lastEvaluatedAt. It records change-points only.
import { and, asc, desc, eq, gte, lt, sql } from 'drizzle-orm';
import { TRUST_HISTORY_MAX_POINTS, type TrustPagePublicPayload } from '@breeze/shared';
import { db } from '../../../db';
import { trustPageSnapshots } from '../../../db/schema';
import type { SectionBuildContext } from './types';

const WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

const met = sql<number | null>`(${trustPageSnapshots.payload}->'summary'->>'controlsMet')::int`;
const shown = sql<number | null>`(${trustPageSnapshots.payload}->'summary'->>'controlsShown')::int`;
const cols = { generatedAt: trustPageSnapshots.generatedAt, met, shown };

export async function buildHistory(ctx: SectionBuildContext): Promise<TrustPagePublicPayload['history']> {
  if (!ctx.config.showHistory) return [];
  const windowStart = new Date(ctx.asOf.getTime() - WINDOW_MS);
  // The snapshot being built is not in the table yet, so it is excluded by construction.
  const inWindow = await db.select(cols).from(trustPageSnapshots)
    .where(and(eq(trustPageSnapshots.trustPageId, ctx.page.id), gte(trustPageSnapshots.generatedAt, windowStart)))
    .orderBy(asc(trustPageSnapshots.generatedAt));
  // The newest point before the window is the baseline: it says what the state was when the window opened.
  const baseline = await db.select(cols).from(trustPageSnapshots)
    .where(and(eq(trustPageSnapshots.trustPageId, ctx.page.id), lt(trustPageSnapshots.generatedAt, windowStart)))
    .orderBy(desc(trustPageSnapshots.generatedAt)).limit(1);

  const out: TrustPagePublicPayload['history'] = [];
  for (const r of [...baseline, ...inWindow]) {
    if (r.met === null || r.shown === null || r.met < 0 || r.shown < 0) continue; // unreadable (e.g. a very old payload)
    const prev = out[out.length - 1];
    if (prev && prev.met === r.met && prev.shown === r.shown) continue;
    out.push({ at: r.generatedAt.toISOString(), met: r.met, shown: r.shown });
  }
  return out.slice(-TRUST_HISTORY_MAX_POINTS);
}
