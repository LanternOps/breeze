/**
 * Wisp W05b Task 14 — the partner-level incident correlator (w00 A30).
 *
 * "Five customers opened Outlook tickets in fifteen minutes." The ticket
 * poller (`pollTicketClusters`) keeps one live org-level `incident` concern
 * per ticket cluster; this pass, run by the wake tick right after it, looks
 * ACROSS the orgs of each partner that holds at least one active partner-wide
 * grant:
 *
 * - Org-level incident concerns whose last ticket (`evidence.lastTicketAt`,
 *   stamped by the poller) is inside the last 60 minutes are grouped by their
 *   cluster names (single-link, Jaccard ≥ 0.5 — the same rule as the poller;
 *   exact top-5 equality across different customers' wording is too brittle).
 *   `updated_at` is NOT a signal: every assessment run touches it.
 * - A group spanning ≥ 2 orgs, or holding ≥ 8 tickets, becomes / updates one
 *   partner-level concern (`org_id NULL`, severity high, signature =
 *   clusterSignature(partnerId, tokens)) with the connection-health incidents
 *   opened in the same window as evidence. An existing live one is found by
 *   signature or by shared child concerns, and its evidence is read-merged-
 *   written (updateConcern replaces evidence). A partner-level concern a
 *   person closed in the last 24 h is not re-opened for the same children.
 * - Only orgs inside EVERY partner-wide ceiling of the partner are
 *   correlated, so each grantor who can see the partner-level concern can see
 *   every org it names. A partner with only org-scoped grants gets nothing.
 * - Each partner-wide grantor gets one in-app notice per concern
 *   (`deliverInApp`, dedupe `wisp-incident-<concern>-<grant>`); W06 swaps the
 *   delivery for notifyUser. Every tick re-checks each live partner-level
 *   incident's recipients, so a failed delivery is retried on the next tick.
 *   Cost: one recipient read per (live incident, grantor) per tick.
 * - Auto-close (every partner, grant or not): a partner-level incident whose
 *   children are all resolved/dismissed, or any poller-made incident whose
 *   last ticket is older than 24 h → resolveConcern(id, {}, 'auto_closed').
 *
 * Reads run in system context (`runOutsideDbContext(withSystemDbAccessContext)`);
 * every write goes through concerns.ts / deliver.ts, which open their own
 * system context after the read block has returned. No model call anywhere.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { wispEnabled } from '../../config/env';
import { captureException } from '../sentry';
import { recipientState, recordNudge, resolveConcern, updateConcern, upsertConcern } from './concerns';
import { deliverInApp } from './deliver';
import { assertWithinCeiling, CeilingViolationError, GrantInactiveError, resolveGrantCeiling, type GrantCeiling } from './grantAuthority';
import { assessableOrgIds } from './assessableOrgs';
import {
  appendCapped,
  clusterSignature,
  evidenceIso,
  INCIDENT_EVIDENCE_TICKET_CAP,
  jsonRecord,
  maxIso,
  singleLinkClusters,
  stringArray,
  topClusterTokens,
  uuidArraySql,
} from './pollers';
import { getOrCreateThread } from './threads';

export const INCIDENT_CORRELATION_WINDOW_MINUTES = 60;
export const INCIDENT_MIN_ORGS = 2;
export const INCIDENT_MIN_TICKETS = 8;
export const INCIDENT_AUTO_CLOSE_HOURS = 24;

const GRANT_READ_LIMIT = 500;
const ORG_CONCERN_READ_LIMIT = 500;
const PARTNER_INCIDENT_READ_LIMIT = 200;
const HEALTH_READ_LIMIT = 50;
const AUTO_CLOSE_LIMIT = 500;
const CHILD_CAP = 100;
const ORG_CAP = 100;
const HEALTH_CAP = 50;
/** A person's close of a partner-level incident holds for this long against the same children. */
const CLOSED_SUPPRESSION_HOURS = 24;

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

type Result = { partnerIncidentsOpened: number; updated: number; autoClosed: number };

type GrantRow = { id: string; partner_id: string; current_revision_id: string };
type OrgConcernRow = { id: string; org_id: string; evidence: unknown; created_at: Date | string };
type PartnerIncidentRow = { id: string; signature: string | null; status: string; evidence: unknown; child_concern_ids: unknown };
type AutoCloseRow = {
  id: string;
  org_id: string | null;
  created_at: Date | string;
  last_ticket_at: string | null;
  child_count: number | string | null;
  live_children: number | string | null;
};

type ChildConcern = { id: string; orgId: string; tokens: string[]; ticketIds: string[]; ticketCount: number; lastTicketAt: string | null };
type PartnerIncident = { id: string; signature: string | null; live: boolean; evidence: Record<string, unknown>; children: string[] };
type Touched = { id: string; summary: string; orgCount: number };

function inSystemRead<T>(fn: () => Promise<T>, label: string): Promise<T> {
  return runOutsideDbContext(() => withSystemDbAccessContext(fn, label));
}

/** Raw rows carry timestamptz as a Date or as Postgres text (`… +00`, a short offset JS does not parse). */
function tsIso(v: unknown): string | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (typeof v !== 'string') return null;
  const direct = new Date(v);
  if (!Number.isNaN(direct.getTime())) return direct.toISOString();
  const fixed = new Date(v.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'));
  return Number.isNaN(fixed.getTime()) ? null : fixed.toISOString();
}

function intersectOrgIds(ceilings: GrantCeiling[]): Set<string> {
  if (ceilings.length === 0) return new Set();
  // Site-aware (assessableOrgs.ts): an org a grantor reaches only through
  // sites is never named in a partner-level incident they are nudged about,
  // and a site-restricted ceiling contributes nothing.
  // The summary also quotes cluster tokens (words from ticket subjects), so
  // the grantor must hold tickets:read in the org as well.
  const sets = ceilings.map((c) => new Set([...assessableOrgIds(c)].filter((id) => canReadTickets(c, id))));
  return new Set([...sets[0]!].filter((id) => sets.slice(1).every((s) => s.has(id))));
}

function canReadTickets(ceiling: GrantCeiling, orgId: string): boolean {
  try {
    assertWithinCeiling(ceiling, { orgId, permission: 'tickets:read' });
    return true;
  } catch (err) {
    if (err instanceof CeilingViolationError) return false;
    throw err;
  }
}

function incidentSummary(orgCount: number, tokens: string[]): string {
  return `Possible incident across ${orgCount} customer${orgCount === 1 ? '' : 's'}: ${tokens.join(' ')}`;
}

function toChild(r: OrgConcernRow, allowed: ReadonlySet<string>, windowStart: string): ChildConcern | null {
  if (!allowed.has(r.org_id)) return null;
  const ev = jsonRecord(r.evidence);
  const tokens = stringArray(ev.tokens);
  if (tokens.length === 0) return null;
  const lastTicketAt = evidenceIso(ev.lastTicketAt);
  // Keyed on the poller's own stamp; created_at only when the stamp is absent.
  const freshAt = lastTicketAt ?? tsIso(r.created_at);
  if (freshAt === null || freshAt < windowStart) return null;
  const ticketIds = stringArray(ev.ticketIds);
  const ticketCount = typeof ev.ticketCount === 'number' && Number.isFinite(ev.ticketCount)
    ? Math.max(ev.ticketCount, ticketIds.length)
    : ticketIds.length;
  return { id: r.id, orgId: r.org_id, tokens, ticketIds, ticketCount, lastTicketAt };
}

function toPartnerIncident(r: PartnerIncidentRow): PartnerIncident {
  const evidence = jsonRecord(r.evidence);
  const children = appendCapped(stringArray(r.child_concern_ids), stringArray(evidence.childConcernIds), Number.MAX_SAFE_INTEGER).ids;
  return { id: r.id, signature: r.signature, live: r.status === 'open' || r.status === 'snoozed', evidence, children };
}

function findPartnerMatch(list: PartnerIncident[], signature: string, childIds: string[]): PartnerIncident | null {
  const bySig = list.find((c) => c.live && c.signature === signature);
  if (bySig) return bySig;
  const ids = new Set(childIds);
  const overlaps = (c: PartnerIncident) => c.children.some((id) => ids.has(id));
  // A live one first; a recently closed one only blocks re-opening for the same children.
  return list.find((c) => c.live && overlaps(c)) ?? list.find((c) => !c.live && overlaps(c)) ?? null;
}

type Group = {
  orgIds: string[];
  childConcernIds: string[];
  ticketIds: string[];
  ticketCount: number;
  tokens: string[];
  lastTicketAt: string | null;
};

function toGroup(members: ChildConcern[]): Group {
  let ticketIds: string[] = [];
  let lastTicketAt: string | null = null;
  for (const m of members) {
    ticketIds = appendCapped(ticketIds, m.ticketIds, Number.MAX_SAFE_INTEGER).ids;
    lastTicketAt = maxIso(lastTicketAt, m.lastTicketAt);
  }
  return {
    orgIds: [...new Set(members.map((m) => m.orgId))].sort(),
    childConcernIds: members.map((m) => m.id),
    ticketIds,
    ticketCount: Math.max(ticketIds.length, members.reduce((n, m) => n + m.ticketCount, 0)),
    tokens: topClusterTokens(members.map((m) => m.tokens)),
    lastTicketAt,
  };
}

/** Read-merge-write of a live partner-level incident. False when nothing new arrived. */
async function mergePartnerIncident(live: PartnerIncident, g: Group, healthIds: string[]): Promise<Touched | null> {
  const ev = live.evidence;
  const children = appendCapped(live.children, g.childConcernIds, CHILD_CAP);
  const orgs = appendCapped(stringArray(ev.orgIds), g.orgIds, ORG_CAP);
  const prevTickets = stringArray(ev.ticketIds);
  const tickets = appendCapped(prevTickets, g.ticketIds, INCIDENT_EVIDENCE_TICKET_CAP);
  const health = appendCapped(stringArray(ev.healthIncidentIds), healthIds, HEALTH_CAP);
  const prevLast = evidenceIso(ev.lastTicketAt);
  const lastTicketAt = maxIso(prevLast, g.lastTicketAt);
  if (children.added + orgs.added + tickets.added + health.added === 0 && lastTicketAt === prevLast) return null;

  const prevCount = typeof ev.ticketCount === 'number' && Number.isFinite(ev.ticketCount) ? ev.ticketCount : prevTickets.length;
  const tokens = stringArray(ev.tokens).length ? stringArray(ev.tokens) : g.tokens;
  const evidence = {
    ...ev,
    orgIds: orgs.ids,
    ticketIds: tickets.ids,
    ticketCount: Math.max(prevCount + tickets.added, g.ticketCount),
    childConcernIds: children.ids,
    healthIncidentIds: health.ids,
    tokens,
    lastTicketAt,
  };
  const summary = incidentSummary(orgs.ids.length, tokens);
  await updateConcern(live.id, { evidence, childConcernIds: children.ids, summary });
  live.evidence = evidence;
  live.children = children.ids;
  return { id: live.id, summary, orgCount: orgs.ids.length };
}

/**
 * One in-app notice per (concern, partner-wide grantor). "Needs a nudge" is
 * read from the grantor's recipient row (never nudged, not dismissed, not
 * snoozed), not from "evidence changed this tick": a delivery that failed is
 * retried on the next tick even when no new ticket arrived. The dedupeKey
 * makes a second delivery impossible (a lost recordNudge after a successful
 * delivery only costs a no-op insert per tick).
 */
async function nudgeGrantors(touched: Touched, ceilings: GrantCeiling[], now: Date, threads: Map<string, string>): Promise<void> {
  for (const c of [...ceilings].sort((a, b) => (a.grantId < b.grantId ? -1 : 1))) {
    try {
      const rs = await recipientState(touched.id, c.grantId);
      if (rs.nudgeCount > 0) continue;
      if (rs.dismissedAt || (rs.snoozedUntil && rs.snoozedUntil.getTime() > now.getTime())) continue;
      let threadId = threads.get(c.grantId);
      if (!threadId) {
        threadId = (await getOrCreateThread(c.grantId)).id;
        threads.set(c.grantId, threadId);
      }
      const link = `/ai/wisp/thread/${threadId}#concern=${touched.id}`;
      const { created } = await deliverInApp({
        userId: c.grantorUserId,
        orgId: null,
        title: `Wisp: possible incident across ${touched.orgCount} customer${touched.orgCount === 1 ? '' : 's'}`,
        body: touched.summary,
        link,
        priority: 'high',
        dedupeKey: `wisp-incident-${touched.id}-${c.grantId}`,
        concernId: touched.id,
        threadId,
        grantId: c.grantId,
        deepLink: link,
      });
      if (created) await recordNudge(touched.id, c.grantId, now);
    } catch (err) {
      captureException(err, undefined, { component: 'wisp.incidentCorrelator', op: 'nudge' });
    }
  }
}

async function correlatePartner(
  partnerId: string,
  ceilings: GrantCeiling[],
  now: Date,
  out: Result,
  threads: Map<string, string>,
): Promise<void> {
  const allowed = intersectOrgIds(ceilings);
  if (allowed.size === 0) return;
  const nowIso = now.toISOString();
  const windowStart = new Date(now.getTime() - INCIDENT_CORRELATION_WINDOW_MINUTES * MINUTE_MS).toISOString();
  const closedSince = new Date(now.getTime() - CLOSED_SUPPRESSION_HOURS * HOUR_MS).toISOString();

  const { orgRows, partnerRows, healthRows } = await inSystemRead(async () => {
    const orgRows = (await db.execute(sql`
      /* wisp:incident-org-concerns */
      SELECT c.id, c.org_id, c.evidence, c.created_at
        FROM wisp_concerns c
       WHERE c.partner_id = ${partnerId}::uuid
         AND c.org_id IS NOT NULL
         AND c.subject_kind = 'incident'
         AND c.status IN ('open', 'snoozed')
         AND c.signature IS NOT NULL
         AND (c.evidence->>'lastTicketAt' >= ${windowStart}
              OR (c.evidence->>'lastTicketAt' IS NULL AND c.created_at >= ${windowStart}::timestamptz))
       ORDER BY c.id
       LIMIT ${ORG_CONCERN_READ_LIMIT}`)) as unknown as OrgConcernRow[];
    const partnerRows = (await db.execute(sql`
      /* wisp:incident-partner-live */
      SELECT c.id, c.signature, c.status, c.evidence, to_jsonb(c.child_concern_ids) AS child_concern_ids
        FROM wisp_concerns c
       WHERE c.partner_id = ${partnerId}::uuid
         AND c.org_id IS NULL
         AND c.subject_kind = 'incident'
         AND (c.status IN ('open', 'snoozed')
              OR (c.status IN ('resolved', 'dismissed') AND c.updated_at >= ${closedSince}::timestamptz))
       ORDER BY c.id
       LIMIT ${PARTNER_INCIDENT_READ_LIMIT}`)) as unknown as PartnerIncidentRow[];
    const healthRows = (await db.execute(sql`
      /* wisp:incident-health */
      SELECT h.id
        FROM connection_health_incidents h
       WHERE h.partner_id = ${partnerId}::uuid
         AND h.opened_at >= ${windowStart}::timestamptz
         AND h.opened_at <= ${nowIso}::timestamptz
         AND (h.org_id IS NULL OR h.org_id = ANY(${uuidArraySql(allowed)}))
       ORDER BY h.opened_at DESC, h.id
       LIMIT ${HEALTH_READ_LIMIT}`)) as unknown as Array<{ id: string }>;
    return { orgRows: [...orgRows], partnerRows: [...partnerRows], healthRows: [...healthRows] };
  }, 'wisp-correlate-incidents');

  const children = orgRows.map((r) => toChild(r, allowed, windowStart)).filter((c): c is ChildConcern => c !== null);
  const partnerIncidents = partnerRows.map(toPartnerIncident);
  const healthIds = healthRows.map((r) => r.id);
  /** Summaries written this tick, so the nudge quotes the merged text. */
  const touchedById = new Map<string, Touched>();

  for (const members of singleLinkClusters(children)) {
    const g = toGroup(members);
    if (g.orgIds.length < INCIDENT_MIN_ORGS && g.ticketCount < INCIDENT_MIN_TICKETS) continue;
    try {
      const signature = clusterSignature(partnerId, g.tokens);
      const match = findPartnerMatch(partnerIncidents, signature, g.childConcernIds);
      if (match && !match.live) continue; // a person closed this incident recently
      let touched: Touched | null = null;
      if (match) {
        touched = await mergePartnerIncident(match, g, healthIds);
        if (touched) out.updated += 1;
      } else {
        const summary = incidentSummary(g.orgIds.length, g.tokens);
        const evidence = {
          orgIds: g.orgIds.slice(0, ORG_CAP),
          ticketIds: g.ticketIds.slice(-INCIDENT_EVIDENCE_TICKET_CAP),
          ticketCount: g.ticketCount,
          childConcernIds: g.childConcernIds.slice(0, CHILD_CAP),
          healthIncidentIds: healthIds.slice(0, HEALTH_CAP),
          tokens: g.tokens,
          firstSeenAt: nowIso,
          lastTicketAt: g.lastTicketAt,
        };
        const { id, created } = await upsertConcern({
          partnerId,
          orgId: null,
          subject: { kind: 'incident', id: randomUUID() },
          signature,
          severity: 'high',
          summary,
          evidence,
          childConcernIds: evidence.childConcernIds,
        });
        if (created) {
          out.partnerIncidentsOpened += 1;
          partnerIncidents.push({ id, signature, live: true, evidence, children: evidence.childConcernIds });
          touched = { id, summary, orgCount: g.orgIds.length };
        } else {
          // Lost the signature race: merge into the winner.
          const [winner] = await inSystemRead(async () => [...((await db.execute(sql`
            /* wisp:incident-partner-live */
            SELECT c.id, c.signature, c.status, c.evidence, to_jsonb(c.child_concern_ids) AS child_concern_ids
              FROM wisp_concerns c
             WHERE c.partner_id = ${partnerId}::uuid AND c.id = ${id}::uuid
             LIMIT 1`)) as unknown as PartnerIncidentRow[])], 'wisp-correlate-incidents');
          const entry = winner ? toPartnerIncident(winner) : { id, signature, live: true, evidence: {}, children: [] };
          partnerIncidents.push(entry);
          touched = await mergePartnerIncident(entry, g, healthIds);
          if (touched) out.updated += 1;
        }
      }
      if (touched) touchedById.set(touched.id, touched);
    } catch (err) {
      captureException(err, undefined, { component: 'wisp.incidentCorrelator', op: 'correlate' });
    }
  }

  // Nudge pass over EVERY live partner-level incident of the partner, not only
  // the ones touched above, so a nudge that failed on an earlier tick is
  // retried (nudgeGrantors skips grantors already nudged). Only an incident
  // whose named orgs all sit inside every grantor's assessable reach is in
  // scope: a ceiling that shrank since the incident opened must not be nudged
  // about orgs it can no longer see.
  for (const inc of partnerIncidents) {
    if (!inc.live) continue;
    const orgIds = stringArray(inc.evidence.orgIds);
    if (orgIds.length === 0 || !orgIds.every((id) => allowed.has(id))) continue;
    const touched = touchedById.get(inc.id)
      ?? { id: inc.id, summary: incidentSummary(orgIds.length, stringArray(inc.evidence.tokens)), orgCount: orgIds.length };
    await nudgeGrantors(touched, ceilings, now, threads);
  }
}

async function autoCloseIncidents(now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - INCIDENT_AUTO_CLOSE_HOURS * HOUR_MS).toISOString();
  const rows = await inSystemRead(async () => [...((await db.execute(sql`
    /* wisp:incident-autoclose */
    SELECT c.id, c.org_id, c.created_at, c.evidence->>'lastTicketAt' AS last_ticket_at,
           cardinality(c.child_concern_ids) AS child_count,
           CASE WHEN c.org_id IS NULL THEN (
             SELECT count(*)::int FROM wisp_concerns ch
              WHERE ch.id = ANY(c.child_concern_ids) AND ch.status IN ('open', 'snoozed')
           ) END AS live_children
      FROM wisp_concerns c
     WHERE c.subject_kind = 'incident'
       AND c.status IN ('open', 'snoozed')
       AND c.signature IS NOT NULL
       AND (c.org_id IS NULL
            OR (c.evidence->>'lastTicketAt' IS NOT NULL AND c.evidence->>'lastTicketAt' < ${cutoff}))
     ORDER BY c.created_at, c.id
     LIMIT ${AUTO_CLOSE_LIMIT}`)) as unknown as AutoCloseRow[])], 'wisp-correlate-incidents-autoclose');

  let closed = 0;
  for (const r of rows) {
    const partnerLevel = r.org_id === null;
    // Org-level: only poller-made concerns (they carry the stamp). Partner-level fall back to created_at.
    const lastAt = evidenceIso(r.last_ticket_at) ?? (partnerLevel ? tsIso(r.created_at) : null);
    const stale = lastAt !== null && lastAt < cutoff;
    const childrenDone = partnerLevel && Number(r.child_count ?? 0) > 0 && Number(r.live_children ?? 0) === 0;
    if (!stale && !childrenDone) continue;
    try {
      await resolveConcern(r.id, {}, 'auto_closed');
      closed += 1;
    } catch (err) {
      captureException(err, undefined, { component: 'wisp.incidentCorrelator', op: 'auto_close' });
    }
  }
  return closed;
}

export async function correlateIncidents(now: Date): Promise<Result> {
  const out: Result = { partnerIncidentsOpened: 0, updated: 0, autoClosed: 0 };
  if (!wispEnabled()) return out;

  const grants = await inSystemRead(async () => [...((await db.execute(sql`
    /* wisp:incident-grants */
    SELECT g.id, g.partner_id, g.current_revision_id
      FROM wisp_grants g
     WHERE g.status = 'active'
       AND g.org_id IS NULL
       AND g.expires_at > ${now.toISOString()}::timestamptz
       AND g.current_revision_id IS NOT NULL
     ORDER BY g.partner_id, g.id
     LIMIT ${GRANT_READ_LIMIT}`)) as unknown as GrantRow[])], 'wisp-correlate-incidents');

  const byPartner = new Map<string, GrantCeiling[]>();
  for (const g of grants) {
    let ceiling: GrantCeiling;
    try {
      ceiling = await resolveGrantCeiling(g.id, g.current_revision_id);
    } catch (err) {
      if (!(err instanceof GrantInactiveError)) {
        captureException(err, undefined, { component: 'wisp.incidentCorrelator', op: 'ceiling' });
      }
      continue;
    }
    // Partner-level subjects need the live partner-wide reach (w00 A30).
    // A ceiling-wide site restriction cannot see partner-level concerns at all
    // (W05a's listConcernsForCeiling), so that grantor is neither a reader nor
    // a nudge target, and does not narrow the other grantors' intersection.
    if (ceiling.scopeOrgId !== null || !ceiling.partnerWide || ceiling.partnerId !== g.partner_id || ceiling.siteIds !== null) continue;
    const list = byPartner.get(g.partner_id) ?? [];
    list.push(ceiling);
    byPartner.set(g.partner_id, list);
  }

  const threads = new Map<string, string>();
  for (const partnerId of [...byPartner.keys()].sort()) {
    try {
      await correlatePartner(partnerId, byPartner.get(partnerId)!, now, out, threads);
    } catch (err) {
      captureException(err, undefined, { component: 'wisp.incidentCorrelator', op: 'partner' });
    }
  }

  out.autoClosed = await autoCloseIncidents(now);
  return out;
}
