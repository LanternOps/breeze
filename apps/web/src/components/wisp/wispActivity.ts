// Wisp W06 (web) Task 14: the activity timeline client (w00 A31). Types are
// W06a's shared DTOs (`packages/shared/src/types/wispActivity.ts`), never re-typed.
import { WISP_ACTIVITY_KINDS } from '@breeze/shared';
import type { ActivityItem, CurrentActivity, WispActivityKind } from '@breeze/shared';
import { fetchWithAuth } from '@/stores/auth';

const PAGE_LIMIT = 50;

function isKind(v: unknown): v is WispActivityKind {
  return typeof v === 'string' && (WISP_ACTIVITY_KINDS as readonly string[]).includes(v);
}

function parseItem(raw: unknown): ActivityItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  // Unknown kinds / malformed rows are dropped so a newer server stays compatible.
  if (!isKind(r.kind) || typeof r.id !== 'string' || typeof r.at !== 'string' || typeof r.title !== 'string') return null;
  return {
    id: r.id,
    at: r.at,
    kind: r.kind,
    orgId: typeof r.orgId === 'string' ? r.orgId : null,
    title: r.title,
    detail: typeof r.detail === 'string' ? r.detail : null,
    href: typeof r.href === 'string' ? r.href : null,
    costCents: typeof r.costCents === 'number' ? r.costCents : null,
  };
}

/** The running assessment behind the live "Checking …" line; anything malformed reads as "nothing running". */
function parseCurrent(raw: unknown): CurrentActivity {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.orgId !== 'string' || typeof r.orgName !== 'string' || typeof r.startedAt !== 'string') return null;
  return { orgId: r.orgId, orgName: r.orgName, startedAt: r.startedAt };
}

/** `GET /wisp/thread/:id/activity?limit=&cursor=` → `{ data: { items, nextCursor, current } }` (W06a). */
export async function fetchWispActivity(
  threadId: string,
  cursor: string | null,
  limit: number = PAGE_LIMIT,
): Promise<{ items: ActivityItem[]; nextCursor: string | null; current: CurrentActivity }> {
  const res = await fetchWithAuth(
    `/wisp/thread/${encodeURIComponent(threadId)}/activity?limit=${limit}` +
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''),
  );
  if (!res.ok) throw new Error(`Wisp activity request failed (${res.status})`);
  const body = (await res.json()) as { data?: { items?: unknown; nextCursor?: unknown; current?: unknown } };
  const items = body?.data?.items;
  // A malformed body is a contract break, not "no activity".
  if (!Array.isArray(items)) throw new Error('Wisp activity response malformed: data.items is not an array');
  const parsed = items.map(parseItem).filter((i): i is ActivityItem => i !== null);
  const dropped = items.length - parsed.length;
  if (dropped > 0) {
    // A few unknown kinds are a newer server; every row unknown is a contract break.
    if (parsed.length === 0) throw new Error(`Wisp activity response malformed: none of ${items.length} rows parsed`);
    console.error(`[wispActivity] dropped ${dropped} of ${items.length} activity rows (unknown kind or missing fields)`, items);
  }
  if (body.data?.current != null && parseCurrent(body.data.current) === null) {
    console.error('[wispActivity] malformed `current`; showing no live line', body.data.current);
  }
  return {
    items: parsed,
    nextCursor: typeof body.data?.nextCursor === 'string' ? body.data.nextCursor : null,
    current: parseCurrent(body.data?.current),
  };
}

// Browsers strip tab/CR/LF from URLs and treat `\` as `/`, so `/\t/evil` would
// navigate to `//evil`: refuse any control character, whitespace or backslash.
const UNSAFE_HREF = /[\u0000-\u001F\u007F\s\\]/;

/** Server writes relative same-origin links; never render anything that could leave the origin. */
export function safeActivityHref(href: string | null): string | null {
  if (!href || !href.startsWith('/') || href.startsWith('//') || UNSAFE_HREF.test(href)) return null;
  try {
    const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost';
    if (new URL(href, origin).origin !== new URL(origin).origin) return null;
  } catch {
    return null;
  }
  return href;
}
