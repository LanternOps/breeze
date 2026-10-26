// Wisp W08 (web): the Wisp home's reads and pure helpers. Server contract:
// W08a `routes/wispHome.ts` (`GET /wisp/home`) and `routes/wispPartnerSettings.ts`.
// Types come from @breeze/shared — never re-typed here.
import { CONCERN_SEVERITIES, type Concern, type WispHomePayload } from '@breeze/shared';
import { fetchWithAuth } from '@/stores/auth';
import type { WispState } from '@/stores/aiStore';
import { wispStateFromThread } from '@/lib/wispGrant';
import { concernIdFromHash } from './wispThreadHash';

export type HomeLoad =
  | { kind: 'ready'; payload: WispHomePayload; wisp: NonNullable<WispState> }
  /** The caller has no usable grant: the page shows the start card. */
  | { kind: 'noGrant' }
  /** The partner has no `wisp` entitlement (the hub's 403): FeatureLock. */
  | { kind: 'locked' };

/**
 * `GET /wisp/home` — the caller's usable grant (active before paused). The
 * home is grant-addressed, never the switcher's org (routeScope:
 * partner-settings), so no ambient `?orgId=`. Any failure other than the two
 * expected refusals throws: a broken read is an error state, not "no grant".
 */
export async function fetchWispHome(): Promise<HomeLoad> {
  const res = await fetchWithAuth('/wisp/home', { skipOrgIdInjection: true });
  const body = (await res.json().catch(() => null)) as { code?: unknown; data?: WispHomePayload } | null;
  if (res.status === 404 && body?.code === 'no_grant') return { kind: 'noGrant' };
  if (res.status === 403 && body?.code === 'entitlement_required') return { kind: 'locked' };
  if (!res.ok) throw new Error(`wisp home read failed: ${res.status}`);
  // The home payload is a superset of GET /wisp/thread/:id, so the panel's
  // parser applies as-is.
  const wisp = wispStateFromThread(body);
  if (!wisp || !body?.data || !Array.isArray(body.data.needsYou) || !Array.isArray(body.data.links)) {
    throw new Error('wisp home read: malformed payload');
  }
  return { kind: 'ready', payload: body.data, wisp };
}

/** The partner's "Wisp enabled" switch (the home's no-grant branch reads it to pick start vs. disabled). */
export { getWispPartnerEnabled as fetchWispPartnerEnabled } from '@/lib/wispPartnerSettingsApi';

export const HOME_SECTIONS = ['brief', 'needs-you', 'activity', 'thread', 'links'] as const;
export type HomeSection = (typeof HOME_SECTIONS)[number];

/** `#needs-you` → `'needs-you'`; a `#concern=<id>` deep link belongs to needs-you; anything else → null. */
export function homeSectionFromHash(hash: string): HomeSection | null {
  if (concernIdFromHash(hash)) return 'needs-you';
  const id = hash.replace(/^#/, '');
  return (HOME_SECTIONS as readonly string[]).includes(id) ? (id as HomeSection) : null;
}

const SEVERITY_RANK: Record<string, number> = Object.fromEntries(
  // CONCERN_SEVERITIES runs low → high; rank high first.
  [...CONCERN_SEVERITIES].reverse().map((s, i) => [s, i]),
);

/** Approvals first (they block work), then severity high → info; stable within ties. */
export function needsYouOrder<T extends Pick<Concern, 'severity' | 'approvalIntentId'>>(concerns: readonly T[]): T[] {
  return concerns
    .map((c, i) => ({ c, i }))
    .sort((a, b) =>
      Number(b.c.approvalIntentId != null) - Number(a.c.approvalIntentId != null)
      || (SEVERITY_RANK[a.c.severity] ?? 99) - (SEVERITY_RANK[b.c.severity] ?? 99)
      || a.i - b.i)
    .map(({ c }) => c);
}

/** A brief older than this reads as "from an earlier day" (the API returns briefs up to 36 h old). */
const FRESH_BRIEF_MS = 20 * 60 * 60 * 1000;

export function briefAge(sentAt: string, now: number = Date.now()): 'fresh' | 'stale' | null {
  const t = Date.parse(sentAt);
  if (!Number.isFinite(t)) return null;
  return now - t <= FRESH_BRIEF_MS ? 'fresh' : 'stale';
}

/** Which home sections have nothing to show (each renders its own empty line). */
export function emptyStateFor(payload: WispHomePayload): Record<'brief' | 'needsYou' | 'activity' | 'links', boolean> {
  return {
    brief: !payload.brief || payload.brief.sections.length === 0,
    needsYou: payload.needsYou.length === 0,
    activity: payload.activity.items.length === 0,
    links: payload.links.length === 0,
  };
}
