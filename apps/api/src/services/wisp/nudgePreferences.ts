/**
 * Wisp W06 — per-user nudge preference reads/upserts (w00 "Nudges (W06)",
 * A28, A29). The partner's urgent-capable severities (partner-wide state,
 * gated on canManagePartnerWidePolicies) live in ./partnerNudgeSettings.ts.
 *
 * `loadNudgePrefs` / `upsertNudgePrefs` / the urgent-capable pair run in
 * WHATEVER context the caller holds: the routes call them under the caller's
 * own RLS (a user reads/writes only their own row inside their own partner),
 * notifyUser calls them inside its system context. The worker bookkeeping
 * helpers (`markDigestSent`, `markBriefSent`, `loadNudgeBookkeeping`) elect
 * system scope themselves.
 *
 * A missing preference row means "defaults" (`resolveWispNudgePrefs`); a read
 * never inserts one.
 */
import { eq, inArray, sql } from 'drizzle-orm';
import {
  resolveWispNudgePrefs,
  type UpdateWispNudgePreferences,
  type WispNudgePreferences,
} from '@breeze/shared';
import { db } from '../../db';
import { wispNudgePreferences, type WispNudgePreferencesRow } from '../../db/schema/wispNudgePreferences';
import { inSystemContext } from './grantAuthority';

type PrefFields = Pick<WispNudgePreferencesRow,
  'channels' | 'quietOverride' | 'digestCadenceMinutes' | 'briefTimeLocal' | 'briefTimezone' | 'proactivity'>;

const prefColumns = {
  channels: wispNudgePreferences.channels,
  quietOverride: wispNudgePreferences.quietOverride,
  digestCadenceMinutes: wispNudgePreferences.digestCadenceMinutes,
  briefTimeLocal: wispNudgePreferences.briefTimeLocal,
  briefTimezone: wispNudgePreferences.briefTimezone,
  proactivity: wispNudgePreferences.proactivity,
};

const toPrefs = (row: PrefFields | undefined): WispNudgePreferences => resolveWispNudgePrefs(row ?? null);

/** Missing row = defaults. */
export async function loadNudgePrefs(userId: string): Promise<WispNudgePreferences> {
  const [row] = await db.select(prefColumns).from(wispNudgePreferences)
    .where(eq(wispNudgePreferences.userId, userId)).limit(1);
  return toPrefs(row);
}

/** Only the patched fields are written on conflict; ids come from the caller's auth, never a body. */
export async function upsertNudgePrefs(userId: string, partnerId: string, patch: UpdateWispNudgePreferences): Promise<WispNudgePreferences> {
  const set: Partial<PrefFields> = {};
  for (const key of Object.keys(prefColumns) as Array<keyof PrefFields>) {
    if (patch[key] !== undefined) (set as Record<string, unknown>)[key] = patch[key];
  }
  const [row] = await db.insert(wispNudgePreferences)
    .values({ userId, partnerId, ...set })
    .onConflictDoUpdate({ target: wispNudgePreferences.userId, set: { ...set, updatedAt: sql`now()` } })
    .returning(prefColumns);
  return toPrefs(row);
}

async function stamp(userId: string, partnerId: string, field: 'lastDigestAt' | 'lastBriefAt', at: Date): Promise<void> {
  await inSystemContext(async () => {
    await db.insert(wispNudgePreferences)
      .values({ userId, partnerId, [field]: at })
      .onConflictDoUpdate({ target: wispNudgePreferences.userId, set: { [field]: at, updatedAt: sql`now()` } });
  });
}

/** Stamp `last_digest_at` after a delivered digest (system context; inserts a defaults row when missing). */
export async function markDigestSent(userId: string, partnerId: string, at: Date): Promise<void> {
  await stamp(userId, partnerId, 'lastDigestAt', at);
}

/** Stamp `last_brief_at` after a delivered brief (system context; inserts a defaults row when missing). */
export async function markBriefSent(userId: string, partnerId: string, at: Date): Promise<void> {
  await stamp(userId, partnerId, 'lastBriefAt', at);
}

/** Prefs + digest/brief stamps for many users (system context); users without a row are absent from the map. */
export async function loadNudgeBookkeeping(userIds: string[]): Promise<Map<string, { prefs: WispNudgePreferences; lastDigestAt: Date | null; lastBriefAt: Date | null }>> {
  const out = new Map<string, { prefs: WispNudgePreferences; lastDigestAt: Date | null; lastBriefAt: Date | null }>();
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return out;
  const rows = await inSystemContext(() => db
    .select({ ...prefColumns, userId: wispNudgePreferences.userId, lastDigestAt: wispNudgePreferences.lastDigestAt, lastBriefAt: wispNudgePreferences.lastBriefAt })
    .from(wispNudgePreferences)
    .where(inArray(wispNudgePreferences.userId, ids)));
  for (const r of rows) {
    out.set(r.userId, { prefs: toPrefs(r), lastDigestAt: r.lastDigestAt ?? null, lastBriefAt: r.lastBriefAt ?? null });
  }
  return out;
}
