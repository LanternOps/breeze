import { and, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { db } from '../../db';
import {
  connectionHealthDigestDeliveries as ledger,
  connectionHealthIncidents as chi,
  organizations,
  partners,
  userEmailOptouts,
  users,
} from '../../db/schema';
import type { EmailOptoutTopic } from '../emailOptouts';

// Data access for the daily digest (spec 2026-10-15 §2.3, §4). Every function
// runs inside the CALLER's system DB context (digest.ts wraps each call) and
// never opens its own. Writes to the ledger happen only here.

export const ERROR_MAX = 500;

export type DigestIncidentRow = {
  id: string;
  partnerId: string;
  orgId: string | null;
  orgName: string | null;
  ownerUserId: string | null;
  displayName: string;
  condition: string;
  severity: string;
  detail: string | null;
  fixHref: string;
  ownerFixHref: string | null;
  viewPermission: string;
  repairPermission: string;
  openedAt: Date;
  resolvedAt: Date | null;
  resolution: string | null;
};

/** A claim still `claimed` after the window is marked failed — never resent (at most once). */
export async function expireStaleClaims(cutoff: Date): Promise<number> {
  const rows = await db
    .update(ledger)
    .set({ status: 'failed', error: 'claim expired' })
    .where(and(eq(ledger.status, 'claimed'), lt(ledger.claimedAt, cutoff)))
    .returning({ id: ledger.id });
  return rows.length;
}

/** Ledger retention: one batch of rows older than `beforeDate` (YYYY-MM-DD). */
export async function deleteOldDeliveries(beforeDate: string, limit: number): Promise<number> {
  const rows = await db.execute(sql`
    DELETE FROM connection_health_digest_deliveries
    WHERE id IN (
      SELECT id FROM connection_health_digest_deliveries
      WHERE digest_date < ${beforeDate}::date
      LIMIT ${limit}
    )
    RETURNING id
  `);
  return (rows as unknown as unknown[]).length;
}

const digestableIncident = (since: Date) => and(
  isNotNull(chi.openedAt),
  or(isNull(chi.resolvedAt), and(eq(chi.resolution, 'recovered'), gt(chi.resolvedAt, since))),
);

/** Active, non-deleted partners with an open incident or one recovered since `since`. */
export async function loadCandidatePartners(since: Date): Promise<Array<{ id: string; timezone: string }>> {
  return db
    .select({ id: partners.id, timezone: partners.timezone })
    .from(partners)
    .where(and(
      eq(partners.status, 'active'),
      isNull(partners.deletedAt),
      sql`EXISTS (SELECT 1 FROM ${chi} WHERE ${chi.partnerId} = ${partners.id} AND ${digestableIncident(since)})`,
    ));
}

export async function loadPartnerIncidents(partnerId: string, since: Date): Promise<DigestIncidentRow[]> {
  const rows = await db
    .select({
      id: chi.id,
      partnerId: chi.partnerId,
      orgId: chi.orgId,
      orgName: organizations.name,
      ownerUserId: chi.ownerUserId,
      displayName: chi.displayName,
      condition: chi.condition,
      severity: chi.severity,
      detail: chi.detail,
      fixHref: chi.fixHref,
      ownerFixHref: chi.ownerFixHref,
      viewPermission: chi.viewPermission,
      repairPermission: chi.repairPermission,
      openedAt: chi.openedAt,
      resolvedAt: chi.resolvedAt,
      resolution: chi.resolution,
    })
    .from(chi)
    .leftJoin(organizations, eq(organizations.id, chi.orgId))
    .where(and(eq(chi.partnerId, partnerId), digestableIncident(since)));
  // openedAt is non-null by the WHERE.
  return rows.map((r) => ({ ...r, openedAt: r.openedAt as Date }));
}

export async function loadActiveUsers(
  ids: readonly string[],
): Promise<Array<{ id: string; email: string; partnerId: string; orgId: string | null; partnerName: string | null }>> {
  if (ids.length === 0) return [];
  return db
    .select({ id: users.id, email: users.email, partnerId: users.partnerId, orgId: users.orgId, partnerName: partners.name })
    .from(users)
    .leftJoin(partners, eq(partners.id, users.partnerId))
    .where(and(inArray(users.id, [...ids]), eq(users.status, 'active')));
}

export async function loadOptedOut(ids: readonly string[], topic: EmailOptoutTopic): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ userId: userEmailOptouts.userId })
    .from(userEmailOptouts)
    .where(and(inArray(userEmailOptouts.userId, [...ids]), eq(userEmailOptouts.topic, topic)));
  return new Set(rows.map((r) => r.userId));
}

/** Users that already have a ledger row (any status) for the local date. */
export async function loadLedgerForDate(ids: readonly string[], digestDate: string): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ userId: ledger.userId })
    .from(ledger)
    .where(and(inArray(ledger.userId, [...ids]), eq(ledger.digestDate, digestDate)));
  return new Set(rows.map((r) => r.userId));
}

/** Per user: the last sent digest time and every incident id their sent digests since `sinceDate` mentioned. */
export async function loadRecentSent(
  ids: readonly string[],
  sinceDate: string,
): Promise<Map<string, { lastSentAt: Date; told: Set<string> }>> {
  const out = new Map<string, { lastSentAt: Date; told: Set<string> }>();
  if (ids.length === 0) return out;
  const rows = await db
    .select({ userId: ledger.userId, sentAt: ledger.sentAt, incidentIds: ledger.incidentIds })
    .from(ledger)
    .where(and(inArray(ledger.userId, [...ids]), eq(ledger.status, 'sent'), gte(ledger.digestDate, sinceDate)))
    .orderBy(desc(ledger.sentAt));
  for (const r of rows) {
    if (!r.sentAt) continue;
    const prev = out.get(r.userId);
    if (!prev) {
      out.set(r.userId, { lastSentAt: r.sentAt, told: new Set(r.incidentIds) });
    } else {
      for (const id of r.incidentIds) prev.told.add(id);
    }
  }
  return out;
}

/** Records "nothing to say today" so the catch-up hours skip this user. */
export async function insertSkippedEmpty(userId: string, digestDate: string, now: Date): Promise<boolean> {
  const rows = await db
    .insert(ledger)
    .values({ userId, digestDate, status: 'skipped_empty', incidentIds: [], claimedAt: now })
    .onConflictDoNothing({ target: [ledger.userId, ledger.digestDate] })
    .returning({ id: ledger.id });
  return rows.length > 0;
}

/** The at-most-once claim. Returns the ledger id, or null when another run already holds this (user, date). */
export async function claimDelivery(
  userId: string,
  digestDate: string,
  incidentIds: readonly string[],
  now: Date,
): Promise<string | null> {
  const rows = await db
    .insert(ledger)
    .values({ userId, digestDate, status: 'claimed', incidentIds: [...incidentIds], claimedAt: now })
    .onConflictDoNothing({ target: [ledger.userId, ledger.digestDate] })
    .returning({ id: ledger.id });
  return rows[0]?.id ?? null;
}

export async function markDeliverySent(id: string, at: Date): Promise<void> {
  await db
    .update(ledger)
    .set({ status: 'sent', sentAt: at, error: null })
    .where(and(eq(ledger.id, id), eq(ledger.status, 'claimed')));
}

export async function markDeliveryFailed(id: string, error: string): Promise<void> {
  await db
    .update(ledger)
    .set({ status: 'failed', error: error.slice(0, ERROR_MAX) })
    .where(and(eq(ledger.id, id), eq(ledger.status, 'claimed')));
}
