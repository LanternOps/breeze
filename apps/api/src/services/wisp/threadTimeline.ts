/**
 * Wisp companion W02a (#10212) — the thread timeline (spec
 * 2026-10-25-wisp-home-companion §6, quorum B). A DERIVED union, newest first:
 *
 *   message  ai_messages        every session attached to the thread
 *                               (wisp_thread_sessions), session org inside the
 *                               grant's live ceiling, `excludeSessionId` left out
 *                               (the live session's rows come from the web store:
 *                               streaming ids and persisted ids differ)
 *   post     wisp_thread_posts  the thread's own posts (brief / nudge / digest),
 *                               org NULL or a readable org; `read` from the
 *                               linked notification, null when unlinked
 *
 * Every read runs in ONE system context (like listActivity), pinned to the
 * ceiling's partner and to the caller-owned thread (one thread per grant);
 * posts are additionally pinned to the ceiling's grant. Isolation is the
 * ceiling's, applied twice: in SQL, then as an in-process belt on every row.
 * The ceiling may be a PAUSED grant's (the route reads history from the stored
 * revision), so the belt is plain set membership, never assertWithinCeiling
 * (which refuses anything but an active ceiling, by design).
 *
 *   - messages: the session's org ∈ `ceiling.orgIds`. A session is the
 *     grantor's own conversation, held under their own authority at the time.
 *   - posts: org NULL (the grantor's own brief / digest / partner-level nudge)
 *     or an org the activity timeline would show (`readableOrgIds`: a
 *     site-restricted org's org-level rows read nothing), so the timeline never
 *     shows a nudge the activity list hides.
 *
 * Historical scope leakage (an attached session that quoted an org the grant
 * has since lost) is a known follow-up; today's single-session history has the
 * same property.
 *
 * Keyset: (created_at DESC, source DESC, id DESC), compared at MILLISECOND
 * precision in SQL (`date_trunc`) because the cursor carries a JS Date; source
 * compares bytewise ('post' > 'message'). `ai_messages.created_at` is
 * `timestamp without time zone` holding UTC, so its bound is converted with
 * `AT TIME ZONE 'UTC'` (the activity.ts `noTz` rule). Each source fetches
 * `limit + 1` past the cursor; the union is merged, sorted and sliced.
 */
import { and, desc, eq, inArray, isNull, ne, or, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import {
  WISP_TIMELINE_DEFAULT_LIMIT,
  WISP_TIMELINE_MAX_LIMIT,
  type WispTimelineItem,
  type WispTimelineMessage,
  type WispTimelinePost,
} from '@breeze/shared';
import { db } from '../../db';
import { aiMessages } from '../../db/schema/ai';
import { userNotifications } from '../../db/schema/notifications';
import { wispThreadPosts } from '../../db/schema/wispThreadPosts';
import { wispThreadSessions } from '../../db/schema/wispThreads';
import { inSystemContext, type GrantCeiling } from './grantAuthority';

export type TimelineSource = WispTimelineItem['source'];
export type TimelineCursor = { at: Date; source: TimelineSource; id: string };

export class InvalidTimelineCursorError extends Error {
  readonly code = 'invalid_cursor' as const;
  constructor() {
    super('Invalid timeline cursor');
    this.name = 'InvalidTimelineCursorError';
  }
}

/** The query schema's cursor bound (wispTimelineQuerySchema). */
const MAX_CURSOR_LENGTH = 512;
/** Lowercase only: Postgres renders uuids lowercase, and the JS tiebreak must match its byte order. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SOURCES: readonly TimelineSource[] = ['message', 'post'];
/** `system` rows are never shown (the shared DTO has no such role). */
const VISIBLE_ROLES = ['user', 'assistant', 'tool_use', 'tool_result'] as const;

export function encodeTimelineCursor(item: Pick<WispTimelineItem, 'createdAt' | 'source' | 'id'>): string {
  return Buffer.from(`${item.createdAt}|${item.source}|${item.id}`, 'utf8').toString('base64url');
}

/** Throws InvalidTimelineCursorError on anything but a cursor this module encoded. */
export function decodeTimelineCursor(cursor: string): TimelineCursor {
  if (cursor.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new InvalidTimelineCursorError();
  const parts = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (parts.length !== 3) throw new InvalidTimelineCursorError();
  const [atText, source, id] = parts as [string, string, string];
  const at = new Date(atText);
  if (Number.isNaN(at.getTime()) || at.toISOString() !== atText) throw new InvalidTimelineCursorError();
  if (!(SOURCES as readonly string[]).includes(source)) throw new InvalidTimelineCursorError();
  if (!UUID_RE.test(id)) throw new InvalidTimelineCursorError();
  return { at, source: source as TimelineSource, id };
}

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

type Keyed = { ms: number; source: TimelineSource; id: string };
/** `visible: false` = failed the in-process belt; kept for pagination, never returned. */
type Row = { key: Keyed; item: WispTimelineItem; visible: boolean };

/** Negative when `a` comes first (newer) in (at DESC, source DESC, id DESC). */
function compareKeys(a: Keyed, b: Keyed): number {
  if (a.ms !== b.ms) return b.ms - a.ms;
  if (a.source !== b.source) return a.source < b.source ? 1 : -1;
  if (a.id !== b.id) return a.id < b.id ? 1 : -1;
  return 0;
}

const ms = (column: SQLWrapper): SQL => sql`date_trunc('milliseconds', ${column})`;

/**
 * Rows of one constant-`source` query strictly after the cursor. The same
 * rule as activity.ts `keysetAfter` (string-kind branch), duplicated rather
 * than shared so the activity cursor stays untouched. `noTz`: the column is
 * `timestamp without time zone` holding UTC (ai_messages).
 */
function keysetAfter(cursor: TimelineCursor | null, at: SQL, source: TimelineSource, id: SQLWrapper, noTz = false): SQL | undefined {
  if (!cursor) return undefined;
  const iso = cursor.at.toISOString();
  const bound = () => (noTz ? sql`(${iso}::timestamptz AT TIME ZONE 'UTC')` : sql`${iso}::timestamptz`);
  if (source < cursor.source) return sql`${at} <= ${bound()}`;
  if (source > cursor.source) return sql`${at} < ${bound()}`;
  return sql`(${at} < ${bound()} OR (${at} = ${bound()} AND ${id} < ${cursor.id}::uuid))`;
}

// ---------------------------------------------------------------------------
// Ceiling
// ---------------------------------------------------------------------------

/** activity.ts `readableOrgIds`: a site-restricted ceiling or org membership reads no org-level rows. */
function readableOrgIds(ceiling: GrantCeiling): string[] {
  if (ceiling.siteIds !== null) return [];
  return [...ceiling.orgIds].filter((id) => (ceiling.orgTerms.get(id)?.siteIds ?? null) === null);
}

// ---------------------------------------------------------------------------
// Sources — each must run inside the caller's system context
// ---------------------------------------------------------------------------

type SourceArgs = {
  ceiling: GrantCeiling;
  threadId: string;
  cursor: TimelineCursor | null;
  take: number;
  excludeSessionId: string | null;
};

async function messageRows({ ceiling, threadId, cursor, take, excludeSessionId }: SourceArgs): Promise<Row[]> {
  const orgIds = [...ceiling.orgIds];
  if (orgIds.length === 0) return [];
  const at = ms(aiMessages.createdAt);
  const rows = await db
    .select({
      id: aiMessages.id,
      sessionId: aiMessages.sessionId,
      sessionOrgId: wispThreadSessions.orgId,
      role: aiMessages.role,
      content: aiMessages.content,
      contentBlocks: aiMessages.contentBlocks,
      toolName: aiMessages.toolName,
      toolInput: aiMessages.toolInput,
      toolOutput: aiMessages.toolOutput,
      toolUseId: aiMessages.toolUseId,
      createdAt: aiMessages.createdAt,
    })
    .from(aiMessages)
    .innerJoin(wispThreadSessions, eq(wispThreadSessions.sessionId, aiMessages.sessionId))
    .where(and(
      eq(wispThreadSessions.threadId, threadId),
      eq(wispThreadSessions.partnerId, ceiling.partnerId),
      inArray(wispThreadSessions.orgId, orgIds),
      excludeSessionId ? ne(aiMessages.sessionId, excludeSessionId) : undefined,
      inArray(aiMessages.role, [...VISIBLE_ROLES]),
      keysetAfter(cursor, at, 'message', aiMessages.id, true),
    ))
    .orderBy(desc(at), desc(aiMessages.id))
    .limit(take);

  return rows.map((r) => {
    // Belt: the ceiling, the exclusion and the roles again, whatever SQL returned.
    const visible = ceiling.orgIds.has(r.sessionOrgId)
      && r.sessionId !== excludeSessionId
      && (VISIBLE_ROLES as readonly string[]).includes(r.role);
    const item: WispTimelineMessage = {
      source: 'message',
      id: r.id,
      sessionId: r.sessionId,
      role: r.role as WispTimelineMessage['role'],
      content: r.content ?? null,
      contentBlocks: r.contentBlocks ?? null,
      toolName: r.toolName ?? null,
      toolInput: r.toolInput ?? null,
      toolOutput: r.toolOutput ?? null,
      toolUseId: r.toolUseId ?? null,
      createdAt: r.createdAt.toISOString(),
    };
    return { key: { ms: r.createdAt.getTime(), source: 'message' as const, id: r.id }, item, visible };
  });
}

async function postRows({ ceiling, threadId, cursor, take }: SourceArgs): Promise<Row[]> {
  const readable = readableOrgIds(ceiling);
  const at = ms(wispThreadPosts.createdAt);
  const rows = await db
    .select({
      id: wispThreadPosts.id,
      orgId: wispThreadPosts.orgId,
      kind: wispThreadPosts.kind,
      title: wispThreadPosts.title,
      body: wispThreadPosts.body,
      link: wispThreadPosts.link,
      sections: wispThreadPosts.sections,
      concernId: wispThreadPosts.concernId,
      notificationId: wispThreadPosts.notificationId,
      read: userNotifications.read,
      createdAt: wispThreadPosts.createdAt,
    })
    .from(wispThreadPosts)
    .leftJoin(userNotifications, and(
      eq(userNotifications.id, wispThreadPosts.notificationId),
      eq(userNotifications.userId, ceiling.grantorUserId),
    ))
    .where(and(
      eq(wispThreadPosts.threadId, threadId),
      eq(wispThreadPosts.partnerId, ceiling.partnerId),
      eq(wispThreadPosts.grantId, ceiling.grantId),
      readable.length > 0
        ? or(isNull(wispThreadPosts.orgId), inArray(wispThreadPosts.orgId, readable))
        : isNull(wispThreadPosts.orgId),
      keysetAfter(cursor, at, 'post', wispThreadPosts.id),
    ))
    .orderBy(desc(at), desc(wispThreadPosts.id))
    .limit(take);

  const readableSet = new Set(readable);
  return rows.map((r) => {
    const visible = r.orgId === null || readableSet.has(r.orgId);
    const item: WispTimelinePost = {
      source: 'post',
      id: r.id,
      kind: r.kind,
      title: r.title,
      body: r.body ?? null,
      link: r.link ?? null,
      sections: r.sections ?? null,
      concernId: r.concernId ?? null,
      orgId: r.orgId,
      read: r.notificationId === null ? null : (r.read ?? null),
      createdAt: r.createdAt.toISOString(),
    };
    return { key: { ms: r.createdAt.getTime(), source: 'post' as const, id: r.id }, item, visible };
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return WISP_TIMELINE_DEFAULT_LIMIT;
  return Math.min(WISP_TIMELINE_MAX_LIMIT, Math.max(1, Math.trunc(limit)));
}

/**
 * The thread's timeline, newest first. The caller owns `threadId` (the route's
 * loadOwnThread) and `ceiling` is that thread's grant. Throws
 * InvalidTimelineCursorError on a malformed cursor (route → 400).
 */
export async function listThreadTimeline(
  ceiling: GrantCeiling,
  threadId: string,
  opts: { cursor?: string; limit?: number; excludeSessionId?: string } = {},
): Promise<{ items: WispTimelineItem[]; nextCursor: string | null }> {
  const cursor = opts.cursor ? decodeTimelineCursor(opts.cursor) : null;
  const limit = clampLimit(opts.limit);
  const args: SourceArgs = { ceiling, threadId, cursor, take: limit + 1, excludeSessionId: opts.excludeSessionId ?? null };

  // Sequential: one system transaction holds one connection.
  const fetched = await inSystemContext(async () => [...await messageRows(args), ...await postRows(args)]);

  // Keyset belt: drop anything not strictly after the cursor, whatever SQL returned.
  const cursorKey: Keyed | null = cursor ? { ms: cursor.at.getTime(), source: cursor.source, id: cursor.id } : null;
  const ordered = fetched
    .filter((r) => cursorKey === null || compareKeys(cursorKey, r.key) < 0)
    .sort((a, b) => compareKeys(a.key, b.key));
  const page = ordered.slice(0, limit);
  const last = page[page.length - 1];
  // Pagination is computed on the pre-belt page so a dropped row can never stall it (listActivity's rule).
  const nextCursor = ordered.length > limit && last ? encodeTimelineCursor(last.item) : null;
  return { items: page.filter((r) => r.visible).map((r) => r.item), nextCursor };
}
