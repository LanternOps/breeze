/**
 * Wisp W06 — per-user nudge preference reads/upserts (w00 "Nudges (W06)",
 * A28, A29). The partner's urgent-capable severities (partner-wide state,
 * gated on canManagePartnerWidePolicies) live in ./partnerNudgeSettings.ts.
 *
 * `loadNudgePrefs` / `upsertNudgePrefs` run in
 * WHATEVER context the caller holds: the routes call them under the caller's
 * own RLS (a user reads/writes only their own row inside their own partner),
 * notifyUser calls them inside its system context. The worker bookkeeping
 * helpers (`markDigestSent`, `markBriefSent`, `loadNudgeBookkeeping`) elect
 * system scope themselves.
 *
 * A missing preference row means "defaults" (`resolveWispNudgePrefs`); a read
 * never inserts one.
 */
import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import {
  resolveBriefTimezone,
  resolveWispNudgePrefs,
  updateWispBrowserTimezoneSchema,
  type UpdateWispNudgePreferences,
  type WispBriefSchedule,
  type WispNudgePreferences,
} from '@breeze/shared';
import { db } from '../../db';
import { mobileDevices } from '../../db/schema/mobile';
import { partners } from '../../db/schema/orgs';
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

export type NudgeBookkeeping = {
  prefs: WispNudgePreferences;
  lastDigestAt: Date | null;
  lastBriefAt: Date | null;
  browserTimezone: string | null;
};

/** Prefs + digest/brief stamps for many users (system context); users without a row are absent from the map. */
export async function loadNudgeBookkeeping(userIds: string[]): Promise<Map<string, NudgeBookkeeping>> {
  const out = new Map<string, NudgeBookkeeping>();
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return out;
  const rows = await inSystemContext(() => db
    .select({
      ...prefColumns,
      userId: wispNudgePreferences.userId,
      lastDigestAt: wispNudgePreferences.lastDigestAt,
      lastBriefAt: wispNudgePreferences.lastBriefAt,
      browserTimezone: wispNudgePreferences.browserTimezone,
    })
    .from(wispNudgePreferences)
    .where(inArray(wispNudgePreferences.userId, ids)));
  for (const r of rows) {
    out.set(r.userId, {
      prefs: toPrefs(r),
      lastDigestAt: r.lastDigestAt ?? null,
      lastBriefAt: r.lastBriefAt ?? null,
      browserTimezone: r.browserTimezone ?? null,
    });
  }
  return out;
}

/**
 * Store the zone a user's browser reports (#10402). System context with the
 * caller's own ids, in its own transaction: the grant route calls this after a
 * committed grant, and its failure must not touch the request's. A zone this
 * server's ICU does not know is ignored (false): the browser's can be newer.
 */
export async function saveBrowserTimezone(userId: string, partnerId: string, timezone: string): Promise<boolean> {
  if (!updateWispBrowserTimezoneSchema.safeParse({ timezone }).success) {
    console.warn('[wisp.nudgePreferences] ignored a browser time zone this server does not know', { userId, timezone });
    return false;
  }
  await inSystemContext(async () => {
    await db.insert(wispNudgePreferences)
      .values({ userId, partnerId, browserTimezone: timezone })
      .onConflictDoUpdate({ target: wispNudgePreferences.userId, set: { browserTimezone: timezone, updatedAt: sql`now()` } });
  });
  return true;
}

/** Grantor → zone of the oldest active mobile device that has one. Runs on the caller's context. */
export async function phoneTimezones(userIds: string[]): Promise<Map<string, string>> {
  if (userIds.length === 0) return new Map();
  const tzExpr = sql<string | null>`${mobileDevices.quietHours}->>'timezone'`;
  const rows = await db
    .select({ userId: mobileDevices.userId, timezone: tzExpr })
    .from(mobileDevices)
    .where(and(inArray(mobileDevices.userId, userIds), eq(mobileDevices.status, 'active'), isNotNull(tzExpr)))
    .orderBy(asc(mobileDevices.createdAt));
  const out = new Map<string, string>();
  for (const r of rows) if (r.timezone && !out.has(r.userId)) out.set(r.userId, r.timezone);
  return out;
}

/** Partner → its timezone setting. Runs on the caller's context. */
export async function partnerTimezones(partnerIds: string[]): Promise<Map<string, string>> {
  if (partnerIds.length === 0) return new Map();
  const rows = await db
    .select({ id: partners.id, timezone: partners.timezone })
    .from(partners)
    .where(inArray(partners.id, partnerIds));
  return new Map(rows.map((r) => [r.id, r.timezone]));
}

/** When and where this user's morning brief goes out (system context): the same chain the sweep uses. */
export async function loadBriefSchedule(userId: string, partnerId: string): Promise<WispBriefSchedule> {
  return inSystemContext(async () => {
    const [row] = await db.select({ ...prefColumns, browserTimezone: wispNudgePreferences.browserTimezone })
      .from(wispNudgePreferences)
      .where(eq(wispNudgePreferences.userId, userId))
      .limit(1);
    const prefs = toPrefs(row);
    const browserTimezone = row?.browserTimezone ?? null;
    const phone = await phoneTimezones([userId]);
    const partner = await partnerTimezones([partnerId]);
    return {
      timeLocal: prefs.briefTimeLocal,
      timezone: resolveBriefTimezone({
        preference: prefs.briefTimezone,
        phone: phone.get(userId),
        browser: browserTimezone,
        partner: partner.get(partnerId),
      }),
      browserTimezone,
    };
  });
}
