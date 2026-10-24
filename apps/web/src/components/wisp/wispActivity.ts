import { fetchWithAuth } from '@/stores/auth';

// Mirrors w00 A31; replace with the @breeze/shared export if W06a (#9912) publishes one.
export const ACTIVITY_KINDS = ['assessment', 'concern', 'specialist', 'approval', 'memory', 'nudge', 'brief'] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export type ActivityItem = {
  at: string;
  kind: ActivityKind;
  orgId: string | null;
  title: string;
  detail: string | null;
  href: string | null;
  costCents: number | null;
};

const PAGE_LIMIT = 50;

function isKind(v: unknown): v is ActivityKind {
  return typeof v === 'string' && (ACTIVITY_KINDS as readonly string[]).includes(v);
}

function parseItem(raw: unknown): ActivityItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  // Unknown kinds / malformed rows are dropped so a newer server stays compatible.
  if (!isKind(r.kind) || typeof r.at !== 'string' || typeof r.title !== 'string') return null;
  return {
    at: r.at,
    kind: r.kind,
    orgId: typeof r.orgId === 'string' ? r.orgId : null,
    title: r.title,
    detail: typeof r.detail === 'string' ? r.detail : null,
    href: typeof r.href === 'string' ? r.href : null,
    costCents: typeof r.costCents === 'number' ? r.costCents : null,
  };
}

export async function fetchWispActivity(
  threadId: string,
  cursor: string | null,
): Promise<{ items: ActivityItem[]; nextCursor: string | null }> {
  const res = await fetchWithAuth(
    `/wisp/thread/${encodeURIComponent(threadId)}/activity?limit=${PAGE_LIMIT}` +
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''),
  );
  if (!res.ok) throw new Error(`Wisp activity request failed (${res.status})`);
  const body = (await res.json()) as { data?: { items?: unknown; nextCursor?: unknown } };
  const items = body?.data?.items;
  // A malformed body is a contract break, not "no activity".
  if (!Array.isArray(items)) throw new Error('Wisp activity response malformed: data.items is not an array');
  return {
    items: items.map(parseItem).filter((i): i is ActivityItem => i !== null),
    nextCursor: typeof body.data?.nextCursor === 'string' ? body.data.nextCursor : null,
  };
}

/** Server writes relative links; never render an absolute or protocol-relative URL. */
export function safeActivityHref(href: string | null): string | null {
  if (!href || !href.startsWith('/')) return null;
  if (href.startsWith('//') || href.startsWith('/\\')) return null;
  return href;
}
