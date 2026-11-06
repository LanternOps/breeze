/**
 * Wisp companion W02a (#10212) — durable proactive posts on a Wisp thread
 * (`wisp_thread_posts`; spec 2026-10-25-wisp-home-companion §6, quorum B).
 *
 * The ONLY writer is `notifyUser` (services/wisp/notifyUser.ts), through
 * `deliverInApp` when the in-app channel is on (one system-context callback,
 * so the notification and the post commit together, before any push) or
 * directly under its own system context when it is off. Budget, watch and
 * assessment notices also go through `deliverInApp` but pass no post, so they
 * never become posts.
 *
 * `recordThreadPost` opens no context of its own: it runs on the caller's
 * connection (always a system context). A retried delivery with the same
 * dedupe key writes nothing (ON CONFLICT (thread_id, dedupe_key) DO NOTHING).
 */
import { and, eq } from 'drizzle-orm';
import type { BriefSection, WispFirstLookState } from '@breeze/shared';
import { db } from '../../db';
import { wispConcerns } from '../../db/schema/wispConcerns';
import { wispThreadPosts, type WispThreadPostKind } from '../../db/schema/wispThreadPosts';
import { inSystemContext } from './grantAuthority';

export type ThreadPostKind = WispThreadPostKind;

export type ThreadPostInput = {
  threadId: string;
  partnerId: string;
  grantId: string;
  /** The concern's org; null for a partner-level post (brief, digest, org-less concern). */
  orgId: string | null;
  kind: ThreadPostKind;
  title: string;
  body: string | null;
  /** Relative same-origin path (a CHECK on the table enforces it). */
  link: string;
  sections: BriefSection[] | null;
  concernId: string | null;
  /** The notification written in the same call; null when none was (channel off, or it already existed). */
  notificationId: string | null;
  /** The notification's dedupe key (`wisp.brief:` / `wisp.nudge:` / `wisp.digest:`). */
  dedupeKey: string;
};

/** The post's concern is missing or belongs to another partner. */
export class ThreadPostConcernError extends Error {
  constructor(concernId: string, partnerId: string) {
    super(`recordThreadPost: concern ${concernId} not found under partner ${partnerId}`);
    this.name = 'ThreadPostConcernError';
  }
}

/**
 * A grant older than this gets no couldn't-look post and shows no progress
 * (#10402). It gets the real first look only if it was already told "I couldn't
 * look yet" (#11145).
 */
export const FIRST_LOOK_WINDOW_MS = 24 * 60 * 60 * 1000;

const COULDNT_LOOK_KEY_PREFIX = 'wisp.first_look_failed:';

/**
 * The couldn't-look post's key (#11145): one per grant, and NOT the first look's
 * key, so it can never stop the real post when a later retry does look.
 */
export function couldntLookDedupeKey(grantId: string): string {
  return `${COULDNT_LOOK_KEY_PREFIX}${grantId}`;
}

export type FirstLookPostTimes = { firstLookAt: string | null; couldntLookAt: string | null };

/**
 * When this thread's first-look posts were written (#10402, #11145). The home
 * reads it so a post the poll would otherwise have no reason to fetch still
 * reaches the page, and the thread payload so the chat surfaces can stop saying
 * "I'm looking around". A thread holds at most one of each. System context: the
 * caller already checked it is the grantor's thread.
 */
export async function firstLookPostTimes(threadId: string): Promise<FirstLookPostTimes> {
  const rows = await inSystemContext(() => db
    .select({ createdAt: wispThreadPosts.createdAt, dedupeKey: wispThreadPosts.dedupeKey })
    .from(wispThreadPosts)
    .where(and(eq(wispThreadPosts.threadId, threadId), eq(wispThreadPosts.kind, 'first_look')))
    .limit(2));
  const at = (couldntLook: boolean) =>
    rows.find((r) => r.dedupeKey.startsWith(COULDNT_LOOK_KEY_PREFIX) === couldntLook)?.createdAt.toISOString() ?? null;
  return { firstLookAt: at(false), couldntLookAt: at(true) };
}

/** A real first look wins: a later retry that looked outdates the couldn't-look post above it. */
export function firstLookStateFrom(times: FirstLookPostTimes): WispFirstLookState {
  if (times.firstLookAt) return 'done';
  return times.couldntLookAt ? 'couldnt_look' : 'looking';
}

const TITLE_MAX_CHARS = 255;

/** varchar(255) counts characters (code points), so truncate by code point, never mid surrogate pair. */
function truncateTitle(title: string): string {
  const chars = Array.from(title);
  return chars.length <= TITLE_MAX_CHARS ? title : chars.slice(0, TITLE_MAX_CHARS).join('');
}

/**
 * INSERT … ON CONFLICT (thread_id, dedupe_key) DO NOTHING. `created: false,
 * id: null` when the thread already has a post for this dedupe key. Throws
 * ThreadPostConcernError for a concern outside `partnerId` (notifyUser checks
 * this already; re-asserted here because the FK is single-column).
 */
export async function recordThreadPost(input: ThreadPostInput): Promise<{ created: boolean; id: string | null }> {
  if (input.concernId) {
    const [concern] = await db
      .select({ partnerId: wispConcerns.partnerId })
      .from(wispConcerns)
      .where(eq(wispConcerns.id, input.concernId))
      .limit(1);
    if (!concern || concern.partnerId !== input.partnerId) throw new ThreadPostConcernError(input.concernId, input.partnerId);
  }

  const rows = await db
    .insert(wispThreadPosts)
    .values({
      threadId: input.threadId,
      partnerId: input.partnerId,
      grantId: input.grantId,
      orgId: input.orgId,
      kind: input.kind,
      title: truncateTitle(input.title),
      body: input.body,
      link: input.link,
      sections: input.sections,
      concernId: input.concernId,
      notificationId: input.notificationId,
      dedupeKey: input.dedupeKey,
    })
    // Targeted at the (thread_id, dedupe_key) unique index: an untargeted
    // DO NOTHING would swallow a conflict on any unique index added later.
    .onConflictDoNothing({ target: [wispThreadPosts.threadId, wispThreadPosts.dedupeKey] })
    .returning({ id: wispThreadPosts.id });

  const id = rows[0]?.id ?? null;
  return { created: id !== null, id };
}
