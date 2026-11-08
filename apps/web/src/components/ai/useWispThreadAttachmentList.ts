import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchWithAuth } from '@/stores/auth';
import type { WispState } from '@/stores/aiStore';

export type ThreadAttachment = { id: string; label: string; bytes: number; expiresAt: string };

/** A partner-wide thread with no customer focus has no org to file an attachment under (the server answers 409 focus_required). */
export const wispAttachmentsNeedFocus = (wisp: NonNullable<WispState>) => wisp.scopeOrgId === null && wisp.focusOrgId === null;

function parseItems(body: unknown): ThreadAttachment[] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  return data.filter((x): x is ThreadAttachment => {
    const r = x as Partial<ThreadAttachment> | null;
    return !!r && typeof r.id === 'string' && typeof r.label === 'string'
      && typeof r.bytes === 'number' && typeof r.expiresAt === 'string';
  });
}

export type WispThreadAttachmentList = {
  items: ThreadAttachment[];
  loaded: boolean;
  loadFailed: boolean;
  reload: () => Promise<void>;
};

/**
 * The thread's attachments (`GET /wisp/thread/:id/attachments`), loaded once
 * per thread. Null loads nothing (a parent already holds the list). Only the
 * newest load may commit: a slow response for a previous thread (or one that
 * lands after unmount) must not overwrite the current list.
 */
export function useWispThreadAttachmentList(threadId: string | null): WispThreadAttachmentList {
  const [items, setItems] = useState<ThreadAttachment[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const loadToken = useRef(0);
  const reload = useCallback(async () => {
    if (threadId === null) return;
    const token = ++loadToken.current;
    try {
      const res = await fetchWithAuth(`/wisp/thread/${threadId}/attachments`);
      if (!res.ok) throw new Error(`status ${res.status}`);
      const next = parseItems(await res.json());
      if (token !== loadToken.current) return;
      setItems(next);
      setLoadFailed(false);
    } catch {
      if (token === loadToken.current) setLoadFailed(true);
    } finally {
      if (token === loadToken.current) setLoaded(true);
    }
  }, [threadId]);

  useEffect(() => {
    if (threadId === null) return undefined;
    setLoaded(false);
    void reload();
    return () => { loadToken.current++; };
  }, [threadId, reload]);

  return { items, loaded, loadFailed, reload };
}
