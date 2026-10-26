import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { WispTimelineItem, WispTimelinePost } from '@breeze/shared';
import type { AiMessage } from '@/stores/processStreamEvent';
import { fetchWispTimeline, mergeTimelineItems, splitTimelinePage } from './wispTimeline';

/**
 * Which timeline the column holds: the thread, and the session the chat store
 * is showing. That session's rows come from the store (streaming ids and
 * persisted ids differ, so the two copies could never be deduplicated by id);
 * the timeline is read without it. `null` = hold nothing.
 */
export type TimelineTarget = { threadId: string; excludeSessionId: string | null } | null;

type Held = { key: string; items: WispTimelineItem[]; nextCursor: string | null };
/** `first`: nothing loaded for the target. `refresh`: a re-read of the newest page. `earlier`: a Load earlier. */
export type TimelineFailure = 'first' | 'refresh' | 'earlier';
type Failure = { key: string; what: TimelineFailure };

const keyOf = (t: TimelineTarget): string | null => (t ? `${t.threadId}|${t.excludeSessionId ?? ''}` : null);

const NO_MESSAGES: AiMessage[] = [];
const NO_POSTS: WispTimelinePost[] = [];

export type WispThreadTimeline = {
  /** Older sessions' messages, oldest first, never the excluded session's. */
  messages: AiMessage[];
  /** Wisp's posts, oldest first. */
  posts: WispTimelinePost[];
  hasEarlier: boolean;
  loadingEarlier: boolean;
  loadEarlier: () => void;
  /** The first page for the current target has landed (or failed): an empty thread is really empty. */
  settled: boolean;
  /** What last failed for the current target (the rows on screen stay), with its retry. */
  failed: TimelineFailure | null;
  retry: () => void;
};

/**
 * Wisp companion W02b (#10213, plan Task 13): the thread column's read of
 * `GET /wisp/thread/:id/timeline`.
 *
 * - A new target (bind, rebind to another session, thread change) reads page
 *   one with the new exclusion and replaces what was held when it lands; a
 *   page or a failure for an earlier target is dropped. Until then the held
 *   rows of the same thread stay on screen, minus any row of the session the
 *   store now shows, so a rebind never shows a session twice. The session the
 *   store left is missing until the new page lands (it was excluded from the
 *   held page), and the pages loaded with Load earlier are replaced.
 * - `refreshKey` changing re-reads page one and merges it (new posts appear
 *   once, a post's read flag follows the server); pages already loaded and the
 *   cursor past them are kept.
 * - Load earlier reads the page after the cursor and appends it.
 * - Every failure is reported for its target with a retry of what failed; the
 *   rows on screen stay.
 */
export function useWispThreadTimeline(target: TimelineTarget, refreshKey: number): WispThreadTimeline {
  const key = keyOf(target);
  const [held, setHeld] = useState<Held | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const targetRef = useRef(target);
  targetRef.current = target;
  const heldRef = useRef(held);
  heldRef.current = held;
  // Bumped by every Load earlier and every new target: only the newest Load earlier may land or clear the spinner.
  const earlierToken = useRef(0);

  const loadFirstPage = useCallback(async () => {
    const t = targetRef.current;
    const k = keyOf(t);
    if (!t || !k) return;
    try {
      const page = await fetchWispTimeline(t.threadId, { excludeSessionId: t.excludeSessionId });
      if (keyOf(targetRef.current) !== k) return;
      // The first answer for a target replaces what was held; a later one (a refresh) merges into it.
      setHeld((prev) =>
        prev && prev.key === k
          ? { ...prev, items: mergeTimelineItems(prev.items, page.items) }
          : { key: k, items: page.items, nextCursor: page.nextCursor },
      );
      // A failed Load earlier stays reported: this read did not fetch that page.
      setFailure((f) => (f?.key === k && f.what !== 'earlier' ? null : f));
    } catch (err) {
      console.error('[WispHomeThread] reading the thread timeline failed', err);
      if (keyOf(targetRef.current) !== k) return;
      // The rows on screen stay; the notice says whether nothing loaded or only the re-read failed.
      setFailure({ key: k, what: heldRef.current?.key === k ? 'refresh' : 'first' });
    }
  }, []);

  const loadEarlier = useCallback(async () => {
    const t = targetRef.current;
    const k = keyOf(t);
    const h = heldRef.current;
    if (!t || !k || h?.key !== k || h.nextCursor === null) return;
    const token = ++earlierToken.current;
    setLoadingEarlier(true);
    try {
      const page = await fetchWispTimeline(t.threadId, { cursor: h.nextCursor, excludeSessionId: t.excludeSessionId });
      if (token !== earlierToken.current) return;
      setHeld((prev) =>
        prev && prev.key === k
          ? { ...prev, items: mergeTimelineItems(prev.items, page.items), nextCursor: page.nextCursor }
          : prev,
      );
      setFailure((f) => (f?.key === k && f.what === 'earlier' ? null : f));
    } catch (err) {
      console.error('[WispHomeThread] loading earlier messages failed', err);
      if (token === earlierToken.current) setFailure({ key: k, what: 'earlier' });
    } finally {
      // Same tick as the page landing, so the kit sees the prepend and the end of loading in one commit.
      if (token === earlierToken.current) setLoadingEarlier(false);
    }
  }, []);

  useEffect(() => {
    earlierToken.current += 1;
    setLoadingEarlier(false);
    // A failure belongs to the read that failed; returning to a target later starts clean.
    setFailure(null);
    if (key !== null) void loadFirstPage();
  }, [key, loadFirstPage]);

  const lastRefreshKey = useRef(refreshKey);
  useEffect(() => {
    if (refreshKey === lastRefreshKey.current) return;
    lastRefreshKey.current = refreshKey;
    void loadFirstPage();
  }, [refreshKey, loadFirstPage]);

  // During a retarget the held rows of the same thread stay visible; another thread's never do.
  const visible = target && held && held.key.startsWith(`${target.threadId}|`) ? held : null;
  const exclude = target?.excludeSessionId ?? null;
  const split = useMemo(() => {
    if (!visible) return { messages: NO_MESSAGES, posts: NO_POSTS };
    const items = exclude
      ? visible.items.filter((i) => i.source !== 'message' || i.sessionId !== exclude)
      : visible.items;
    return splitTimelinePage(items);
  }, [visible, exclude]);

  const current = key !== null && held?.key === key ? held : null;
  const failed = key !== null && failure?.key === key ? failure.what : null;
  const retry = useCallback(() => {
    if (failure?.what === 'earlier') void loadEarlier();
    else void loadFirstPage();
  }, [failure, loadEarlier, loadFirstPage]);
  const onLoadEarlier = useCallback(() => { void loadEarlier(); }, [loadEarlier]);

  return {
    messages: split.messages,
    posts: split.posts,
    hasEarlier: current !== null && current.nextCursor !== null,
    loadingEarlier,
    loadEarlier: onLoadEarlier,
    settled: current !== null || failed === 'first',
    failed,
    retry,
  };
}
