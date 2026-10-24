// #9840 W4 (Task 15, spec §3.7): the one conversation list the side panel's
// History and the workspace's "Open a past conversation" picker both read.
//
// GETs only. The server already returns only the caller's own chat sessions
// across every accessible org (W1 T5); nothing here narrows by the org
// switcher (D4/D5). The type filter is repeated client-side so an older API
// can never put a session the open paths would refuse into a list.
import { useEffect, useMemo, useState } from 'react';
import { fetchWithAuth } from '@/stores/auth';
import { useAiStore } from '@/stores/aiStore';
import { isChatSessionType } from '@/stores/aiSessionOpen';

export const SEARCH_DEBOUNCE_MS = 300;
export const MIN_SEARCH_CHARS = 2;
const SEARCH_LIMIT = 20;

export type ConversationSurface = 'panel' | 'workspace';
type SessionStatus = 'active' | 'closed' | 'expired';

export interface ConversationRow {
  id: string;
  title: string | null;
  orgId: string;
  type: 'general' | 'topology';
  deviceId: string | null;
  status: SessionStatus;
  lastActivityAt?: string;
  createdAt: string;
  matchedContent?: string;
  /** Which surface of this document holds the conversation right now. */
  openIn: 'panel' | 'workspace' | null;
}

type BaseRow = Omit<ConversationRow, 'openIn'>;

const STATUSES: ReadonlySet<string> = new Set(['active', 'closed', 'expired']);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** A server row, or null when it is not a chat session both open paths accept. */
function toRow(raw: unknown): BaseRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id);
  const orgId = str(r.orgId);
  const createdAt = str(r.createdAt);
  const status = str(r.status);
  if (!id || !orgId || !createdAt || !status || !STATUSES.has(status) || !isChatSessionType(r.type)) return null;
  const lastActivityAt = str(r.lastActivityAt);
  const matchedContent = str(r.matchedContent);
  return {
    id,
    title: str(r.title) ?? null,
    orgId,
    type: r.type,
    deviceId: str(r.deviceId) ?? null,
    status: status as SessionStatus,
    createdAt,
    ...(lastActivityAt ? { lastActivityAt } : {}),
    ...(matchedContent ? { matchedContent } : {}),
  };
}

/** A response body's rows; a body without a `data` array is a failure, not an empty history. */
const rowsOf = (data: unknown): BaseRow[] => {
  const list = (data as { data?: unknown } | null)?.data;
  if (!Array.isArray(list)) throw new Error('Unexpected conversation list response');
  const rows = list.map(toRow).filter((r): r is BaseRow => r !== null);
  if (rows.length < list.length) {
    console.warn(`[AI] Dropped ${list.length - rows.length} of ${list.length} conversation rows (malformed or not a chat session)`);
  }
  return rows;
};

/** The workspace opens neither topology investigations nor closed sessions (D4). */
const visibleOn = (surface: ConversationSurface) => (r: BaseRow): boolean =>
  surface === 'panel' || (r.type !== 'topology' && r.status === 'active');

/**
 * Session ids held by workspace tabs, as one comparable string so streaming
 * deltas on a tab do not re-render the list. The store is imported lazily:
 * the side panel's bundle must not carry workspaceStore statically (on any
 * other page the import hydrates the persisted tabs — exactly the "open
 * elsewhere in this document" fact a row needs).
 */
function useWorkspaceTabSessionIds(): ReadonlySet<string> {
  const [key, setKey] = useState('');
  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    import('@/stores/workspaceStore')
      .then(({ useWorkspaceStore }) => {
        if (cancelled) return;
        let last: string | null = null;
        const read = () => {
          const next = useWorkspaceStore.getState().tabs
            .map((t) => t.sessionId)
            .filter((id): id is string => !!id)
            .join(',');
          // Compared here, not by React: a same-value setState can still re-render once.
          if (next === last) return;
          last = next;
          setKey(next);
        };
        read();
        unsubscribe = useWorkspaceStore.subscribe(read);
      })
      // Without the tabs no row can say "open elsewhere", so a pick would not move.
      .catch((err) => console.error('[AI] Could not read the AI Assistant tabs for the conversation list:', err));
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);
  return useMemo(() => new Set(key ? key.split(',') : []), [key]);
}

export function useAiConversationSource({ surface }: { surface: ConversationSurface }) {
  const [list, setList] = useState<BaseRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<BaseRow[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const panelSessionId = useAiStore((s) => s.sessionId);
  const tabSessionIds = useWorkspaceTabSessionIds();

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetchWithAuth('/ai/sessions?status=active');
        if (!alive) return;
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!alive) return;
        setList(rowsOf(data));
      } catch (err) {
        if (!alive) return;
        console.error('[AI] Failed to load conversations:', err);
        setListError('list_failed');
      } finally {
        if (alive) setIsLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  const searching = query.length >= MIN_SEARCH_CHARS;
  useEffect(() => {
    if (!searching) {
      setHits([]);
      setIsSearching(false);
      setSearchError(null);
      return;
    }
    let current = true;
    setIsSearching(true);
    const timer = setTimeout(async () => {
      try {
        const res = await fetchWithAuth(`/ai/sessions/search?q=${encodeURIComponent(query)}&limit=${SEARCH_LIMIT}`);
        if (!current) return;
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!current) return;
        setHits(rowsOf(data));
        setSearchError(null);
      } catch (err) {
        if (!current) return;
        console.error('[AI] Conversation search failed:', err);
        setHits([]);
        setSearchError('search_failed');
      } finally {
        if (current) setIsSearching(false);
      }
    }, SEARCH_DEBOUNCE_MS);
    // A newer query (or unmount) supersedes this one: nothing it fetches lands.
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [query, searching]);

  const items = useMemo<ConversationRow[]>(
    () => (searching ? hits : list)
      .filter(visibleOn(surface))
      .map((r) => ({
        ...r,
        openIn: r.id === panelSessionId ? 'panel' : tabSessionIds.has(r.id) ? 'workspace' : null,
      })),
    [searching, hits, list, surface, panelSessionId, tabSessionIds],
  );

  return {
    items,
    query,
    setQuery,
    isLoading,
    isSearching,
    error: searching ? searchError : listError,
  };
}
