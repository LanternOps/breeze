/**
 * Wisp W06 Task 14 — the activity timeline and the live "checking…" line
 * (w00 A31). A DERIVED union, no table:
 *
 *   assessment  ai_agent_runs        grant_id = G, profile 'assessment'
 *   concern     wisp_concerns        raised_by_grant_id = G OR a recipient row for G
 *   approval    action_intents       requesting_agent_run_id → a run with grant_id = G
 *   memory      ai_memory_blocks     authored_by_grant_id = G
 *   nudge/brief user_notifications   user_id = grantor AND metadata->>'grantId' = G
 *   specialist  — W07 lineage (`ai_agent_runs.requested_by_run_id`) does not
 *                 exist yet; the source is added with that column.
 *
 * Every read runs in system context (the caller may be a request, a worker or
 * the brief), pinned to the ceiling's grant / partner / grantor. Isolation is
 * the ceiling's, applied twice: IN SQL (readable orgs, partner-level rows only
 * for a partner-wide grant with full reach — the concerns.ts rule), then as a
 * belt every item passes `assertWithinCeiling` before it leaves. Org-NULL
 * nudge / brief / memory items are the grantor's own and need no org term.
 *
 * Keyset: (at DESC, kind DESC, id DESC), compared at MILLISECOND precision in
 * SQL (`date_trunc`) because the cursor carries a JS Date. Each source fetches
 * `limit + 1` past the cursor; the union is merged, sorted and sliced.
 */
import { and, asc, desc, eq, inArray, isNull, or, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { WISP_ACTIVITY_KINDS, type ActivityItem, type CurrentActivity, type WispActivityKind } from '@breeze/shared';
import { db } from '../../db';
import { actionIntents } from '../../db/schema/actionIntents';
import { aiAgentRuns } from '../../db/schema/aiAgents';
import { aiMemoryBlocks } from '../../db/schema/aiMemoryBlocks';
import { userNotifications } from '../../db/schema/notifications';
import { organizations } from '../../db/schema/orgs';
import { wispConcernRecipients, wispConcerns } from '../../db/schema/wispConcerns';
import { assertWithinCeiling, CeilingViolationError, inSystemContext, type GrantCeiling } from './grantAuthority';
import { webDeepLink } from './nudgeLinks';

export type { ActivityItem, CurrentActivity } from '@breeze/shared';

export class InvalidActivityCursorError extends Error {
  readonly code = 'invalid_cursor' as const;
  constructor() {
    super('Invalid activity cursor');
    this.name = 'InvalidActivityCursorError';
  }
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_CURSOR_LENGTH = 256;
/** Lowercase only: Postgres renders uuids lowercase, and the JS tiebreak must match its byte order. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The assessment profile literal (`isAssessmentProfile`, aiAgents/assessmentProfile.ts) as SQL needs it. */
const ASSESSMENT_PROFILE = 'assessment' as const;

export type ActivityCursor = { at: Date; kind: WispActivityKind; id: string };

export function encodeActivityCursor(item: Pick<ActivityItem, 'at' | 'kind' | 'id'>): string {
  return Buffer.from(`${item.at}|${item.kind}|${item.id}`, 'utf8').toString('base64url');
}

/** Throws InvalidActivityCursorError on anything but a cursor this module encoded. */
export function decodeActivityCursor(cursor: string): ActivityCursor {
  if (cursor.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new InvalidActivityCursorError();
  const parts = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (parts.length !== 3) throw new InvalidActivityCursorError();
  const [atText, kind, id] = parts as [string, string, string];
  const at = new Date(atText);
  if (Number.isNaN(at.getTime()) || at.toISOString() !== atText) throw new InvalidActivityCursorError();
  if (!(WISP_ACTIVITY_KINDS as readonly string[]).includes(kind)) throw new InvalidActivityCursorError();
  if (!UUID_RE.test(id)) throw new InvalidActivityCursorError();
  return { at, kind: kind as WispActivityKind, id };
}

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

type Keyed = { ms: number; kind: WispActivityKind; id: string };
type Row = { key: Keyed; item: ActivityItem };

/** Negative when `a` comes first (newer) in (at DESC, kind DESC, id DESC). */
function compareKeys(a: Keyed, b: Keyed): number {
  if (a.ms !== b.ms) return b.ms - a.ms;
  if (a.kind !== b.kind) return a.kind < b.kind ? 1 : -1;
  if (a.id !== b.id) return a.id < b.id ? 1 : -1;
  return 0;
}

const ms = (column: SQLWrapper): SQL => sql`date_trunc('milliseconds', ${column})`;

/**
 * Rows strictly after the cursor. `kind` is the source's constant kind, or an
 * SQL expression when one source yields two kinds (nudge / brief). `noTz`:
 * the column is `timestamp without time zone` holding UTC (user_notifications).
 */
function keysetAfter(cursor: ActivityCursor | null, at: SQL, kind: WispActivityKind | SQL, id: SQLWrapper, noTz = false): SQL | undefined {
  if (!cursor) return undefined;
  const iso = cursor.at.toISOString();
  const bound = () => (noTz ? sql`(${iso}::timestamptz AT TIME ZONE 'UTC')` : sql`${iso}::timestamptz`);
  const sameAt = (tail: SQL) => sql`(${at} < ${bound()} OR (${at} = ${bound()} AND ${tail}))`;
  if (typeof kind === 'string') {
    if (kind < cursor.kind) return sql`${at} <= ${bound()}`;
    if (kind > cursor.kind) return sql`${at} < ${bound()}`;
    return sameAt(sql`${id} < ${cursor.id}::uuid`);
  }
  return sameAt(sql`(${kind} < ${cursor.kind} COLLATE "C" OR (${kind} = ${cursor.kind} COLLATE "C" AND ${id} < ${cursor.id}::uuid))`);
}

// ---------------------------------------------------------------------------
// Ceiling
// ---------------------------------------------------------------------------

/**
 * Orgs whose rows this ceiling may read — the concerns.ts `readableOrgIds`
 * rule: a site-restricted ceiling (ceiling-wide, or the org's own membership
 * term) cannot be shown to cover an org-level row, so those orgs read nothing.
 */
function readableOrgIds(ceiling: GrantCeiling): string[] {
  if (ceiling.siteIds !== null) return [];
  return [...ceiling.orgIds].filter((id) => (ceiling.orgTerms.get(id)?.siteIds ?? null) === null);
}

/** Partner-level (org NULL) concern / assessment / approval rows: the concerns.ts partner-level rule. */
function readsPartnerLevel(ceiling: GrantCeiling): boolean {
  return ceiling.scopeOrgId === null && ceiling.partnerWide && ceiling.siteIds === null;
}

const GRANTOR_OWN_KINDS: ReadonlySet<WispActivityKind> = new Set(['nudge', 'brief', 'memory']);

/** The belt: the item's org term against the live ceiling. */
function passesCeiling(ceiling: GrantCeiling, item: ActivityItem): boolean {
  if (item.orgId === null && GRANTOR_OWN_KINDS.has(item.kind)) return true;
  try {
    assertWithinCeiling(ceiling, { orgId: item.orgId });
    return true;
  } catch (err) {
    if (err instanceof CeilingViolationError) return false;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Item builders (field by field — never a row spread)
// ---------------------------------------------------------------------------

function truncate(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

const optionalText = (text: string | null, max: number): string | null => (text && text.trim() ? truncate(text, max) : null);
const humanize = (s: string): string => s.replace(/_/g, ' ');

function row(kind: WispActivityKind, id: string, at: Date, fields: Omit<ActivityItem, 'id' | 'at' | 'kind'>): Row {
  return {
    key: { ms: at.getTime(), kind, id },
    item: { id, at: at.toISOString(), kind, orgId: fields.orgId, title: fields.title, detail: fields.detail, href: fields.href, costCents: fields.costCents },
  };
}

function assessmentTitle(status: string, orgName: string): string {
  if (status === 'queued' || status === 'running') return `Checking ${orgName}`;
  if (status === 'completed') return `Checked ${orgName}`;
  return `Assessment ${humanize(status)}: ${orgName}`;
}

const CONCERN_STATUS_LABEL: Record<string, string> = { open: 'Raised', snoozed: 'Snoozed', resolved: 'Resolved', dismissed: 'Dismissed' };

/** A same-origin relative path, or null (user_notifications.link has a CHECK; this is a belt). */
const relativeHref = (link: string | null): string | null => (link && link.startsWith('/') && !link.startsWith('//') ? link : null);

// ---------------------------------------------------------------------------
// Sources — each must run inside the caller's system context
// ---------------------------------------------------------------------------

type SourceArgs = { ceiling: GrantCeiling; readable: string[]; cursor: ActivityCursor | null; take: number; threadId: string | null };

async function assessmentRows({ ceiling, readable, cursor, take }: SourceArgs): Promise<Row[]> {
  // ai_agent_runs.org_id is NOT NULL: there is no partner-level branch.
  if (readable.length === 0) return [];
  const at = ms(sql`COALESCE(${aiAgentRuns.finishedAt}, ${aiAgentRuns.queuedAt})`);
  const rows = await db
    .select({
      id: aiAgentRuns.id, orgId: aiAgentRuns.orgId, orgName: organizations.name, status: aiAgentRuns.status,
      summary: aiAgentRuns.summary, costCents: aiAgentRuns.costCents, queuedAt: aiAgentRuns.queuedAt, finishedAt: aiAgentRuns.finishedAt,
    })
    .from(aiAgentRuns)
    .innerJoin(organizations, and(eq(organizations.id, aiAgentRuns.orgId), eq(organizations.partnerId, ceiling.partnerId)))
    .where(and(
      eq(aiAgentRuns.grantId, ceiling.grantId),
      eq(aiAgentRuns.profile, ASSESSMENT_PROFILE),
      inArray(aiAgentRuns.orgId, readable),
      keysetAfter(cursor, at, 'assessment', aiAgentRuns.id),
    ))
    .orderBy(desc(at), desc(aiAgentRuns.id))
    .limit(take);
  return rows.map((r) => row('assessment', r.id, r.finishedAt ?? r.queuedAt, {
    orgId: r.orgId,
    title: assessmentTitle(r.status, r.orgName),
    detail: optionalText(r.summary, 200),
    href: `/ai-agents/runs/${r.id}`,
    costCents: r.costCents,
  }));
}

async function concernRows({ ceiling, readable, cursor, take, threadId }: SourceArgs): Promise<Row[]> {
  const branches: SQL[] = [];
  if (readable.length > 0) branches.push(inArray(wispConcerns.orgId, readable));
  if (readsPartnerLevel(ceiling)) branches.push(isNull(wispConcerns.orgId));
  if (branches.length === 0) return [];
  const at = ms(wispConcerns.updatedAt);
  const rows = await db
    .select({
      id: wispConcerns.id, orgId: wispConcerns.orgId, summary: wispConcerns.summary, severity: wispConcerns.severity,
      status: wispConcerns.status, outcome: wispConcerns.outcome, updatedAt: wispConcerns.updatedAt,
    })
    .from(wispConcerns)
    .where(and(
      eq(wispConcerns.partnerId, ceiling.partnerId),
      or(
        eq(wispConcerns.raisedByGrantId, ceiling.grantId),
        sql`EXISTS (SELECT 1 FROM ${wispConcernRecipients} WHERE ${wispConcernRecipients.concernId} = ${wispConcerns.id} AND ${wispConcernRecipients.grantId} = ${ceiling.grantId})`,
      ),
      branches.length === 1 ? branches[0] : or(...branches),
      keysetAfter(cursor, at, 'concern', wispConcerns.id),
    ))
    .orderBy(desc(at), desc(wispConcerns.id))
    .limit(take);
  return rows.map((r) => row('concern', r.id, r.updatedAt, {
    orgId: r.orgId,
    title: `${CONCERN_STATUS_LABEL[r.status] ?? humanize(r.status)}: ${truncate(r.summary, 120)}`,
    detail: optionalText(r.outcome, 200) ?? `Severity: ${r.severity}`,
    href: threadId ? webDeepLink(threadId, r.id) : null,
    costCents: null,
  }));
}

async function approvalRows({ ceiling, readable, cursor, take }: SourceArgs): Promise<Row[]> {
  // action_intents.org_id is NOT NULL: there is no partner-level branch.
  if (readable.length === 0) return [];
  const at = ms(actionIntents.createdAt);
  const rows = await db
    .select({ id: actionIntents.id, orgId: actionIntents.orgId, status: actionIntents.status, targetSummary: actionIntents.targetSummary, createdAt: actionIntents.createdAt })
    .from(actionIntents)
    .innerJoin(aiAgentRuns, and(eq(aiAgentRuns.id, actionIntents.requestingAgentRunId), eq(aiAgentRuns.orgId, actionIntents.orgId)))
    .where(and(
      eq(aiAgentRuns.grantId, ceiling.grantId),
      inArray(actionIntents.orgId, readable),
      keysetAfter(cursor, at, 'approval', actionIntents.id),
    ))
    .orderBy(desc(at), desc(actionIntents.id))
    .limit(take);
  return rows.map((r) => row('approval', r.id, r.createdAt, {
    orgId: r.orgId,
    title: `Approval requested: ${truncate(r.targetSummary, 120)}`,
    detail: r.status === 'pending_approval' ? 'Waiting for approval' : humanize(r.status),
    href: `/approvals#intent-${r.id}`,
    costCents: null,
  }));
}

async function memoryRows({ ceiling, readable, cursor, take }: SourceArgs): Promise<Row[]> {
  // Content may be private: only the block type, subject key and status leave.
  const owners: SQL[] = [
    and(eq(aiMemoryBlocks.ownerKind, 'user'), eq(aiMemoryBlocks.ownerUserId, ceiling.grantorUserId))!,
    eq(aiMemoryBlocks.ownerKind, 'partner'),
  ];
  if (readable.length > 0) owners.push(and(eq(aiMemoryBlocks.ownerKind, 'org'), inArray(aiMemoryBlocks.ownerOrgId, readable))!);
  const at = ms(aiMemoryBlocks.createdAt);
  const rows = await db
    .select({
      id: aiMemoryBlocks.id, ownerKind: aiMemoryBlocks.ownerKind, ownerOrgId: aiMemoryBlocks.ownerOrgId, blockType: aiMemoryBlocks.blockType,
      subjectKey: aiMemoryBlocks.subjectKey, status: aiMemoryBlocks.status, createdAt: aiMemoryBlocks.createdAt,
    })
    .from(aiMemoryBlocks)
    .where(and(
      eq(aiMemoryBlocks.tenantPartnerId, ceiling.partnerId),
      eq(aiMemoryBlocks.authoredByGrantId, ceiling.grantId),
      or(...owners),
      keysetAfter(cursor, at, 'memory', aiMemoryBlocks.id),
    ))
    .orderBy(desc(at), desc(aiMemoryBlocks.id))
    .limit(take);
  return rows.map((r) => row('memory', r.id, r.createdAt, {
    orgId: r.ownerKind === 'org' ? r.ownerOrgId : null,
    title: `Remembered ${humanize(r.blockType)}: ${truncate(r.subjectKey, 100)}`,
    detail: humanize(r.status),
    href: null,
    costCents: null,
  }));
}

async function notificationRows({ ceiling, readable, cursor, take }: SourceArgs): Promise<Row[]> {
  const isBrief = sql<boolean>`((${userNotifications.metadata} -> 'brief') IS NOT NULL)`;
  const kind = sql`(CASE WHEN ${isBrief} THEN 'brief' ELSE 'nudge' END)`;
  const at = ms(userNotifications.createdAt);
  const rows = await db
    .select({
      id: userNotifications.id, orgId: userNotifications.orgId, title: userNotifications.title, message: userNotifications.message,
      link: userNotifications.link, isBrief, createdAt: userNotifications.createdAt,
    })
    .from(userNotifications)
    .where(and(
      eq(userNotifications.userId, ceiling.grantorUserId),
      sql`${userNotifications.metadata} ->> 'grantId' = ${ceiling.grantId}`,
      readable.length > 0 ? or(isNull(userNotifications.orgId), inArray(userNotifications.orgId, readable)) : isNull(userNotifications.orgId),
      keysetAfter(cursor, at, kind, userNotifications.id, true),
    ))
    .orderBy(desc(at), sql`${kind} COLLATE "C" DESC`, desc(userNotifications.id))
    .limit(take);
  return rows.map((r) => row(r.isBrief === true ? 'brief' : 'nudge', r.id, r.createdAt, {
    orgId: r.orgId,
    title: truncate(r.title, 200),
    detail: optionalText(r.message, 200),
    href: relativeHref(r.link),
    costCents: null,
  }));
}

const SOURCES = [assessmentRows, concernRows, approvalRows, memoryRows, notificationRows] as const;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(limit)));
}

/**
 * The grant's timeline, newest first. `threadId` (the route's `:id`) lets
 * concern items deep-link into the thread; without it their href is null.
 * Throws InvalidActivityCursorError on a malformed cursor (route → 400).
 */
export async function listActivity(
  ceiling: GrantCeiling,
  opts: { cursor?: string; limit?: number; threadId?: string } = {},
): Promise<{ items: ActivityItem[]; nextCursor: string | null }> {
  const cursor = opts.cursor ? decodeActivityCursor(opts.cursor) : null;
  const limit = clampLimit(opts.limit);
  const args: SourceArgs = { ceiling, readable: readableOrgIds(ceiling), cursor, take: limit + 1, threadId: opts.threadId ?? null };

  // Sequential: one system transaction holds one connection.
  const fetched = await inSystemContext(async () => {
    const all: Row[] = [];
    for (const source of SOURCES) all.push(...await source(args));
    return all;
  });

  // Keyset belt: drop anything not strictly after the cursor, whatever SQL returned.
  const cursorKey: Keyed | null = cursor ? { ms: cursor.at.getTime(), kind: cursor.kind, id: cursor.id } : null;
  const ordered = fetched
    .filter((r) => cursorKey === null || compareKeys(cursorKey, r.key) < 0)
    .sort((a, b) => compareKeys(a.key, b.key));
  const page = ordered.slice(0, limit);
  const last = page[page.length - 1];
  // Pagination is computed on the pre-belt page so a dropped item can never stall it.
  const nextCursor = ordered.length > limit && last ? encodeActivityCursor(last.item) : null;
  return { items: page.filter((r) => passesCeiling(ceiling, r.item)).map((r) => r.item), nextCursor };
}

/** The oldest queued/running assessment under the grant, for "Wisp is checking Greenwood…"; null when idle. */
export async function currentActivity(grantId: string): Promise<CurrentActivity> {
  const [run] = await inSystemContext(() => db
    .select({ orgId: aiAgentRuns.orgId, orgName: organizations.name, startedAt: aiAgentRuns.startedAt, queuedAt: aiAgentRuns.queuedAt })
    .from(aiAgentRuns)
    .innerJoin(organizations, eq(organizations.id, aiAgentRuns.orgId))
    .where(and(
      eq(aiAgentRuns.grantId, grantId),
      eq(aiAgentRuns.profile, ASSESSMENT_PROFILE),
      inArray(aiAgentRuns.status, ['queued', 'running']),
    ))
    .orderBy(asc(aiAgentRuns.queuedAt), asc(aiAgentRuns.id))
    .limit(1));
  if (!run) return null;
  return { orgId: run.orgId, orgName: run.orgName, startedAt: (run.startedAt ?? run.queuedAt).toISOString() };
}
