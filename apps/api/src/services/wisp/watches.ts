/**
 * Wisp W05 — watches: standing "keep an eye on X" requests a grant holds.
 *
 * Authority is structural (spec §4): every create is checked against the
 * grant's ceiling with `assertWithinCeiling` BEFORE anything is written, and a
 * watch with `org_id = NULL` ("every org in the grant") is admitted only for a
 * partner-wide grant held with full partner org access (`orgId: null` passes
 * the ceiling only then). List / delete are keyed on the caller's pinned
 * `grant_id`, never on an id the model chose alone.
 *
 * Every read and write runs in the SYSTEM DB context (`inSystemContext`, w00
 * A7): the wake scheduler and the agent principal carry `userId: null` and
 * cannot satisfy wisp_watches' policies, and the grant id is always the pinned
 * one.
 *
 * Stopping: when a grant leaves `active` (paused / revoked / expired, or its
 * `expires_at` passes) the scheduler tick calls `stopWatchesForInactiveGrants`.
 * `stopped_reason` carries the grant status (`'expired'` when only the expiry
 * passed); the literal `'paused'` is what W02's `userResumeGrant` restarts on
 * (w00 A29), so it must not change. The partner admins (`org_access = 'all'`,
 * w00 A1) get one in-app notice per grant — except for a grant the user paused
 * themselves (`paused_reason = 'user_paused'`): their own resume restarts the
 * watches, so nobody needs telling.
 */
import { and, count, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  WATCH_CADENCE_MAX_MINUTES,
  WATCH_CADENCE_MIN_MINUTES,
  WATCH_KINDS,
  type Watch,
  type WatchKind,
} from '@breeze/shared';
import { db } from '../../db';
import { wispWatches, type WispWatchRow } from '../../db/schema/wispConcerns';
import { partnerUsers, users } from '../../db/schema/users';
import { captureException } from '../sentry';
import { deliverInApp } from './deliver';
import { assertWithinCeiling, inSystemContext, type GrantCeiling } from './grantAuthority';

export type { WatchKind, Watch } from '@breeze/shared';

/** Active watches one grant may hold at once. */
export const WATCH_MAX_PER_GRANT = 50;
/** listWatches returns at most this many rows. */
const LIST_CAP = 200;
/** One claim never takes more than this many rows, whatever the caller asks. */
const CLAIM_CAP = 1000;

const PROMPT_MAX_PARAMS = 20;
const PROMPT_MAX_VALUE_CHARS = 200;
const PROMPT_MAX_KEY_CHARS = 64;
const PROMPT_KEY_RE = /^[A-Za-z0-9_.-]+$/;
/** C0 / DEL / C1 controls and the two JS line terminators outside C0 (escapes keep the source ASCII). */
const PROMPT_UNSAFE_RE = new RegExp(`[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]`, 'g');

export class WatchLimitReachedError extends Error {
  readonly code = 'watch_limit_reached' as const;
  constructor(grantId: string) {
    super(`Wisp grant ${grantId} already holds ${WATCH_MAX_PER_GRANT} active watches`);
    this.name = 'WatchLimitReachedError';
  }
}

// ---------------------------------------------------------------------------
// DTO mapping
// ---------------------------------------------------------------------------

/**
 * Raw `db.execute` rows may carry timestamptz as a Date or as Postgres text
 * (`2026-10-20 00:00:00+00`), whose short offset JS does not parse.
 */
function iso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  const s = String(v);
  const direct = new Date(s);
  if (!Number.isNaN(direct.getTime())) return direct.toISOString();
  return new Date(s.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00')).toISOString();
}

function isoOrNull(v: unknown): string | null {
  return v === null || v === undefined ? null : iso(v);
}

function toWatch(r: WispWatchRow): Watch {
  return {
    id: r.id,
    partnerId: r.partnerId,
    orgId: r.orgId ?? null,
    grantId: r.grantId,
    kind: r.kind,
    params: r.params ?? {},
    cadenceMinutes: r.cadenceMinutes,
    status: r.status,
    stoppedReason: r.stoppedReason ?? null,
    lastRanAt: isoOrNull(r.lastRanAt),
    nextDueAt: iso(r.nextDueAt),
    createdAt: iso(r.createdAt),
  };
}

type RawWatchRow = {
  id: string;
  partner_id: string;
  org_id: string | null;
  grant_id: string;
  kind: WatchKind;
  params: Record<string, unknown> | null;
  cadence_minutes: number;
  status: Watch['status'];
  stopped_reason: string | null;
  last_ran_at: Date | string | null;
  next_due_at: Date | string;
  created_at: Date | string;
};

function rawToWatch(r: RawWatchRow): Watch {
  return {
    id: r.id,
    partnerId: r.partner_id,
    orgId: r.org_id ?? null,
    grantId: r.grant_id,
    kind: r.kind,
    params: r.params ?? {},
    cadenceMinutes: Number(r.cadence_minutes),
    status: r.status,
    stoppedReason: r.stopped_reason ?? null,
    lastRanAt: isoOrNull(r.last_ran_at),
    nextDueAt: iso(r.next_due_at),
    createdAt: iso(r.created_at),
  };
}

// ---------------------------------------------------------------------------
// CRUD (on behalf of a grant)
// ---------------------------------------------------------------------------

export async function createWatch(
  ceiling: GrantCeiling,
  input: { orgId: string | null; kind: WatchKind; params: Record<string, unknown>; cadenceMinutes: number },
  now: Date = new Date(),
): Promise<Watch> {
  // Ceiling first: an out-of-ceiling org, a partner-wide watch on a non
  // partner-wide grant, or an inactive grant writes nothing.
  assertWithinCeiling(ceiling, { orgId: input.orgId });

  // Routes and tools validate with Zod first; this is belt and braces.
  if (
    !Number.isInteger(input.cadenceMinutes)
    || input.cadenceMinutes < WATCH_CADENCE_MIN_MINUTES
    || input.cadenceMinutes > WATCH_CADENCE_MAX_MINUTES
  ) {
    throw new RangeError(`watch cadence must be an integer between ${WATCH_CADENCE_MIN_MINUTES} and ${WATCH_CADENCE_MAX_MINUTES} minutes`);
  }
  if (!(WATCH_KINDS as readonly string[]).includes(input.kind)) {
    throw new RangeError(`unknown watch kind ${String(input.kind)}`);
  }

  return inSystemContext(async () => {
    // Serialise creates per grant (transaction-scoped advisory lock, the
    // memoryKeyLock precedent) so two racing creates cannot both pass the cap.
    await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext('wisp.watches.create'), hashtext(${ceiling.grantId}))`);
    const [counted] = await db
      .select({ n: count() })
      .from(wispWatches)
      .where(and(eq(wispWatches.grantId, ceiling.grantId), eq(wispWatches.status, 'active')));
    if (Number(counted?.n ?? 0) >= WATCH_MAX_PER_GRANT) throw new WatchLimitReachedError(ceiling.grantId);

    const [row] = await db
      .insert(wispWatches)
      .values({
        partnerId: ceiling.partnerId,
        orgId: input.orgId,
        grantId: ceiling.grantId,
        ownerUserId: ceiling.grantorUserId,
        kind: input.kind,
        params: input.params,
        cadenceMinutes: input.cadenceMinutes,
        nextDueAt: new Date(now.getTime() + input.cadenceMinutes * 60_000),
      })
      .returning();
    if (!row) throw new Error('wisp_watches insert returned no row');
    return toWatch(row);
  });
}

/** The grant's watches: active first, then newest first; at most 200. */
export async function listWatches(ceiling: GrantCeiling): Promise<Watch[]> {
  return inSystemContext(async () => {
    const rows = await db
      .select()
      .from(wispWatches)
      .where(eq(wispWatches.grantId, ceiling.grantId))
      .orderBy(sql`CASE WHEN ${wispWatches.status} = 'active' THEN 0 ELSE 1 END`, desc(wispWatches.createdAt))
      .limit(LIST_CAP);
    return rows.map(toWatch);
  });
}

/** True iff a watch owned by this grant was deleted. */
export async function deleteWatch(ceiling: GrantCeiling, watchId: string): Promise<boolean> {
  return inSystemContext(async () => {
    const gone = await db
      .delete(wispWatches)
      .where(and(eq(wispWatches.id, watchId), eq(wispWatches.grantId, ceiling.grantId)))
      .returning({ id: wispWatches.id });
    return gone.length > 0;
  });
}

// ---------------------------------------------------------------------------
// Scheduler side
// ---------------------------------------------------------------------------

/**
 * Claim up to `limit` due active watches and advance them in ONE statement:
 * concurrent schedulers skip each other's locked rows, and a claimed watch is
 * not due again until `now + cadence`.
 */
export async function claimDueWatches(now: Date, limit: number): Promise<Watch[]> {
  if (!Number.isFinite(limit) || limit < 1) return [];
  const take = Math.min(Math.floor(limit), CLAIM_CAP);
  const at = now.toISOString();
  return inSystemContext(async () => {
    const rows = (await db.execute(sql`
      UPDATE wisp_watches
         SET last_ran_at = ${at}::timestamptz,
             next_due_at = ${at}::timestamptz + cadence_minutes * interval '1 minute',
             updated_at = ${at}::timestamptz
       WHERE id IN (
         SELECT id FROM wisp_watches
          WHERE status = 'active' AND next_due_at <= ${at}::timestamptz
          ORDER BY next_due_at
          LIMIT ${take}
          FOR UPDATE SKIP LOCKED
       )
      RETURNING *`)) as unknown as RawWatchRow[];
    return [...rows].map(rawToWatch);
  });
}

type StoppedRow = {
  id: string;
  grant_id: string;
  kind: WatchKind;
  status: string;
  paused_reason: string | null;
  grantor_user_id: string;
  partner_id: string;
};

type GrantGroup = { grantId: string; partnerId: string; grantorUserId: string; status: string; kinds: WatchKind[] };

/** Stopped rows grouped per grant for the admin notice; user-paused grants are skipped. */
function groupForNotice(rows: StoppedRow[]): Map<string, GrantGroup> {
  const groups = new Map<string, GrantGroup>();
  for (const r of rows) {
    // A user who paused their own Wisp resumes it themselves (and that resume
    // restarts these watches): no admin notice.
    if (r.paused_reason === 'user_paused') continue;
    const g = groups.get(r.grant_id) ?? {
      grantId: r.grant_id,
      partnerId: r.partner_id,
      grantorUserId: r.grantor_user_id,
      // A still-'active' grant here only passed its expiry.
      status: r.status === 'active' ? 'expired' : r.status,
      kinds: [],
    };
    g.kinds.push(r.kind);
    groups.set(r.grant_id, g);
  }
  return groups;
}

/**
 * Stop every active watch whose grant is no longer active (or has passed its
 * expiry), then tell the partner admins once per grant. A delivery failure for
 * one admin is captured and does not stop the others.
 */
export async function stopWatchesForInactiveGrants(now: Date): Promise<{ stopped: number; grantsNotified: number }> {
  const at = now.toISOString();
  // The stop UPDATE and the recipient lookups share ONE transaction: if a
  // lookup fails, the stop rolls back and the next tick retries both — the
  // watches are never left stopped with nobody ever told.
  const result = await inSystemContext(async () => {
    const rows = [...((await db.execute(sql`
      UPDATE wisp_watches w
         SET status = 'stopped',
             stopped_reason = CASE WHEN g.status = 'active' THEN 'expired' ELSE g.status END,
             updated_at = ${at}::timestamptz
        FROM wisp_grants g
       WHERE w.grant_id = g.id
         AND w.status = 'active'
         AND (g.status <> 'active' OR g.expires_at <= ${at}::timestamptz)
      RETURNING w.id, w.grant_id, w.kind, g.status, g.paused_reason, g.grantor_user_id, g.partner_id`)) as unknown as StoppedRow[])];
    const groups = groupForNotice(rows);
    if (groups.size === 0) return { rows, groups, grantors: [], admins: [] };

    const grantorIds = [...new Set([...groups.values()].map((g) => g.grantorUserId))];
    const partnerIds = [...new Set([...groups.values()].map((g) => g.partnerId))];
    const grantors = await db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(inArray(users.id, grantorIds));
    const admins = await db
      .select({ userId: partnerUsers.userId, partnerId: partnerUsers.partnerId })
      .from(partnerUsers)
      .innerJoin(users, eq(users.id, partnerUsers.userId))
      .where(and(
        inArray(partnerUsers.partnerId, partnerIds),
        eq(partnerUsers.orgAccess, 'all'),
        eq(users.status, 'active'),
      ));
    return { rows, groups, grantors, admins };
  });
  const { rows, groups, grantors, admins } = result;
  if (groups.size === 0) return { stopped: rows.length, grantsNotified: 0 };

  const grantorName = new Map(grantors.map((u) => [u.id, u.name?.trim() ? u.name : u.email]));
  const adminsByPartner = new Map<string, Set<string>>();
  for (const a of admins) {
    const set = adminsByPartner.get(a.partnerId) ?? new Set<string>();
    set.add(a.userId);
    adminsByPartner.set(a.partnerId, set);
  }

  let grantsNotified = 0;
  for (const g of groups.values()) {
    const recipients = adminsByPartner.get(g.partnerId);
    if (!recipients || recipients.size === 0) continue;
    let delivered = false;
    const kinds = [...new Set(g.kinds)].sort().join(', ');
    const name = grantorName.get(g.grantorUserId) ?? 'A user';
    for (const userId of recipients) {
      try {
        await deliverInApp({
          userId,
          orgId: null,
          title: 'Wisp: watches stopped',
          body: `${name}'s Wisp grant is ${g.status}; ${g.kinds.length} watch(es) no longer running: ${kinds}`,
          link: '/approvals',
          // Per UTC day: a grant paused, resumed and paused again tells the
          // admins again; a redelivery the same day writes nothing.
          dedupeKey: `wisp-watches-orphaned-${g.grantId}-${at.slice(0, 10)}`,
          grantId: g.grantId,
        });
        delivered = true;
      } catch (err) {
        captureException(err, undefined, { component: 'wisp.watches', op: 'orphan_notice', grantId: g.grantId, userId });
      }
    }
    if (delivered) grantsNotified += 1;
  }
  return { stopped: rows.length, grantsNotified };
}

// ---------------------------------------------------------------------------
// Prompt rendering
// ---------------------------------------------------------------------------

function promptValue(v: unknown): string {
  let s: string;
  if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') {
    s = String(v);
  } else if (v === undefined) {
    s = 'undefined';
  } else {
    try {
      s = JSON.stringify(v) ?? String(v);
    } catch {
      s = '[unserializable]';
    }
  }
  return s.replace(PROMPT_UNSAFE_RE, ' ').slice(0, PROMPT_MAX_VALUE_CHARS);
}

/**
 * Deterministic lines describing a watch, safe to embed in a model prompt:
 * params sorted by key, keys restricted to `[A-Za-z0-9_.-]` (≤ 64 chars,
 * others dropped), values single-line and capped at 200 chars, at most 20.
 */
export function watchPromptLines(w: Watch): string[] {
  const lines = [
    `watch ${w.id}: ${w.kind}`,
    `scope: ${w.orgId ? `org ${w.orgId}` : 'every org in the grant'}`,
    `cadence: every ${w.cadenceMinutes} minutes`,
  ];
  const keys = Object.keys(w.params ?? {})
    .filter((k) => k.length <= PROMPT_MAX_KEY_CHARS && PROMPT_KEY_RE.test(k))
    .sort()
    .slice(0, PROMPT_MAX_PARAMS);
  for (const k of keys) lines.push(`param ${k}=${promptValue(w.params[k])}`);
  return lines;
}
