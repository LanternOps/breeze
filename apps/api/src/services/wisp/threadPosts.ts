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
import { eq } from 'drizzle-orm';
import type { BriefSection } from '@breeze/shared';
import { db } from '../../db';
import { wispConcerns } from '../../db/schema/wispConcerns';
import { wispThreadPosts, type WispThreadPostKind } from '../../db/schema/wispThreadPosts';

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
