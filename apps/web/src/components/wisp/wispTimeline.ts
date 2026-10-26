// Wisp companion W02b (#10213): the thread timeline client. Types are W02a's
// shared DTOs (`packages/shared/src/types/wispTimeline.ts`), never re-typed.
import { WISP_TIMELINE_DEFAULT_LIMIT, WISP_TIMELINE_POST_KINDS } from '@breeze/shared';
import type { WispTimelineItem, WispTimelineMessage, WispTimelinePost } from '@breeze/shared';
import { fetchWithAuth } from '@/stores/auth';
import { mapMessagesFromApi, type AiMessage } from '@/stores/processStreamEvent';

const ROLES: readonly string[] = ['user', 'assistant', 'tool_use', 'tool_result'];
const KINDS: readonly string[] = WISP_TIMELINE_POST_KINDS;

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function parseItem(raw: unknown): WispTimelineItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || typeof r.createdAt !== 'string' || !Number.isFinite(Date.parse(r.createdAt))) return null;
  if (r.source === 'message') {
    if (typeof r.sessionId !== 'string' || typeof r.role !== 'string' || !ROLES.includes(r.role)) return null;
    return {
      source: 'message',
      id: r.id,
      sessionId: r.sessionId,
      role: r.role as WispTimelineMessage['role'],
      content: str(r.content),
      contentBlocks: r.contentBlocks ?? null,
      toolName: str(r.toolName),
      toolInput: r.toolInput ?? null,
      toolOutput: r.toolOutput ?? null,
      toolUseId: str(r.toolUseId),
      createdAt: r.createdAt,
    };
  }
  if (r.source === 'post') {
    if (typeof r.kind !== 'string' || !KINDS.includes(r.kind) || typeof r.title !== 'string') return null;
    return {
      source: 'post',
      id: r.id,
      kind: r.kind as WispTimelinePost['kind'],
      title: r.title,
      body: str(r.body),
      link: str(r.link),
      sections: Array.isArray(r.sections) ? (r.sections as WispTimelinePost['sections']) : null,
      concernId: str(r.concernId),
      orgId: str(r.orgId),
      read: typeof r.read === 'boolean' ? r.read : null,
      createdAt: r.createdAt,
    };
  }
  return null;
}

/**
 * `GET /wisp/thread/:id/timeline?limit=&cursor=&excludeSessionId=` →
 * `{ data: { items, nextCursor } }` (W02a), newest first. `excludeSessionId`
 * is the session the store is streaming: its rows come from the store, never
 * from here (streaming ids and persisted ids differ, so they cannot be
 * deduplicated by id).
 */
export async function fetchWispTimeline(
  threadId: string,
  opts: { cursor?: string | null; limit?: number; excludeSessionId?: string | null },
): Promise<{ items: WispTimelineItem[]; nextCursor: string | null }> {
  const params = new URLSearchParams({ limit: String(opts.limit ?? WISP_TIMELINE_DEFAULT_LIMIT) });
  if (opts.cursor) params.set('cursor', opts.cursor);
  if (opts.excludeSessionId) params.set('excludeSessionId', opts.excludeSessionId);
  // Id-addressed and grant-scoped: the org switcher's ambient orgId has no meaning here.
  const res = await fetchWithAuth(`/wisp/thread/${encodeURIComponent(threadId)}/timeline?${params.toString()}`, {
    skipOrgIdInjection: true,
  });
  if (!res.ok) throw new Error(`Wisp timeline request failed (${res.status})`);
  const body = (await res.json()) as { data?: { items?: unknown; nextCursor?: unknown } } | null;
  const items = body?.data?.items;
  // A malformed body is a contract break, not "no history".
  if (!Array.isArray(items)) throw new Error('Wisp timeline response malformed: data.items is not an array');
  const parsed = items.map(parseItem).filter((i): i is WispTimelineItem => i !== null);
  const dropped = items.length - parsed.length;
  if (dropped > 0) {
    // A few unknown rows are a newer server; every row unknown is a contract break.
    if (parsed.length === 0) throw new Error(`Wisp timeline response malformed: none of ${items.length} rows parsed`);
    console.error(`[wispTimeline] dropped ${dropped} of ${items.length} timeline rows (unknown source or kind, or missing fields)`, items);
  }
  return { items: parsed, nextCursor: typeof body?.data?.nextCursor === 'string' ? body.data.nextCursor : null };
}

/**
 * Splits a newest-first page into the kit's inputs, both oldest first:
 * messages in the store's shape (`mapMessagesFromApi`, as session history
 * loads) and posts.
 */
export function splitTimelinePage(items: readonly WispTimelineItem[]): { messages: AiMessage[]; posts: WispTimelinePost[] } {
  const oldestFirst = [...items].reverse();
  const rows: Record<string, unknown>[] = [];
  const posts: WispTimelinePost[] = [];
  for (const item of oldestFirst) {
    if (item.source === 'post') {
      posts.push(item);
      continue;
    }
    // The store's rows carry absent tool fields as undefined, not null.
    rows.push({
      id: item.id,
      role: item.role,
      content: item.content,
      contentBlocks: item.contentBlocks ?? undefined,
      toolName: item.toolName ?? undefined,
      toolInput: item.toolInput ?? undefined,
      toolOutput: item.toolOutput ?? undefined,
      toolUseId: item.toolUseId ?? undefined,
      createdAt: item.createdAt,
    });
  }
  return { messages: mapMessagesFromApi(rows), posts };
}
