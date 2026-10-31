// Pure helpers for the Wisp home sections on the mobile thread screen (W08 T12):
// the morning brief, the thread's entity links and the full activity timeline.
// No React / react-native — node-tested beside this file.
//
// Types are declared locally (the mobile app has no `@breeze/shared`
// dependency; see services/wisp.ts) and mirror the w00 A35 contract:
// `BreezeEntityRef`, `WispThreadLink` and the `brief` / `links` members of
// `WispHomePayload`. Everything is normalised from `unknown`, so a newer or
// truncated server body degrades to an empty section instead of throwing.
import type { WispActivityItem } from '../../services/wisp';

export type WispEntityKind = 'ticket' | 'quote' | 'invoice' | 'contract' | 'device' | 'organization' | 'site' | 'alert' | 'run' | 'task' | 'user';
export const WISP_ENTITY_KINDS: readonly WispEntityKind[] = [
  'ticket', 'quote', 'invoice', 'contract', 'device', 'organization', 'site', 'alert', 'run', 'task', 'user',
];

export interface WispBriefSection { heading: string; lines: string[] }
export interface WispThreadLink {
  id: string | null;
  ref: { kind: WispEntityKind; id: string; orgId: string | null };
  label: string;
  status: string | null;
  href: string;
  source: 'user_pin' | 'wisp_pin' | 'auto' | 'concern';
  lastTouchedAt: string;
  createdAt: string;
}
const MAX_SECTIONS = 12;
const MAX_LINES = 20;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

export function normalizeBriefSections(raw: unknown): WispBriefSection[] {
  if (!Array.isArray(raw)) return [];
  const out: WispBriefSection[] = [];
  for (const entry of raw) {
    if (out.length >= MAX_SECTIONS) break;
    if (!isObj(entry) || !nonEmpty(entry.heading) || !Array.isArray(entry.lines)) continue;
    const lines = entry.lines.filter(nonEmpty).slice(0, MAX_LINES);
    if (lines.length === 0) continue;
    out.push({ heading: entry.heading.trim(), lines });
  }
  return out;
}

/**
 * Brief sections out of a brief notification's `metadata`. The landed W06
 * writer (`services/wisp/brief.ts` → `notifyUser`) stores them as
 * `briefSections`; the W08 plan names them `brief.sections`. Either is read.
 */
export function briefSectionsFromNotification(metadata: unknown): WispBriefSection[] {
  if (!isObj(metadata)) return [];
  if (Array.isArray(metadata.briefSections)) return normalizeBriefSections(metadata.briefSections);
  const brief = metadata.brief;
  return isObj(brief) ? normalizeBriefSections(brief.sections) : [];
}

export interface WispHomeSections {
  /** null when there is no brief in the window or none of its sections is usable. */
  brief: { sentAt: string | null; sections: WispBriefSection[] } | null;
  links: WispThreadLink[];
}

/**
 * The parts of `GET /wisp/home` this screen draws (the thread, grant and
 * concerns already come from the W06 routes it calls). Total: never throws.
 */
export function homeSectionsFromPayload(raw: unknown): WispHomeSections {
  if (!isObj(raw)) return { brief: null, links: [] };
  const brief = isObj(raw.brief) ? raw.brief : null;
  // Contract shape first; a server that passed the notification metadata key
  // straight through (`briefSections`) still renders.
  const sections = brief
    ? Array.isArray(brief.sections)
      ? normalizeBriefSections(brief.sections)
      : briefSectionsFromNotification(brief)
    : [];
  const links = Array.isArray(raw.links)
    ? raw.links.map(normalizeLink).filter((l): l is WispThreadLink => l !== null)
    : [];
  return {
    brief:
      brief && sections.length > 0
        ? { sentAt: typeof brief.sentAt === 'string' ? brief.sentAt : null, sections }
        : null,
    links: linksForDisplay(links),
  };
}

export function normalizeLink(raw: unknown): WispThreadLink | null {
  if (!isObj(raw)) return null;
  if (!(raw.id === null && raw.source === 'concern') && (typeof raw.id !== 'string' || raw.id.length === 0)) return null;
  const ref = raw.ref;
  if (!isObj(ref)) return null;
  if (!WISP_ENTITY_KINDS.includes(ref.kind as WispEntityKind)) return null;
  if (typeof ref.id !== 'string' || ref.id.length === 0) return null;
  if (typeof raw.label !== 'string' || raw.label.length === 0) return null;
  return {
    id: raw.id as string | null,
    ref: {
      kind: ref.kind as WispEntityKind,
      id: ref.id,
      orgId: typeof ref.orgId === 'string' ? ref.orgId : null,
    },
    label: raw.label,
    status: typeof raw.status === 'string' ? raw.status : null,
    href: typeof raw.href === 'string' ? raw.href : '',
    source: raw.source === 'wisp_pin' || raw.source === 'auto' || raw.source === 'concern' ? raw.source : 'user_pin',
    lastTouchedAt: typeof raw.lastTouchedAt === 'string' ? raw.lastTouchedAt : '',
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
  };
}

/** Parsed time, or null when unparseable. */
function ms(s: string): number | null {
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

/** Newest first; unparseable last; 0 (stable) otherwise. */
function newestFirst(a: string, b: string): number {
  const ta = ms(a);
  const tb = ms(b);
  if (ta === null && tb === null) return 0;
  if (ta === null) return 1;
  if (tb === null) return -1;
  return tb - ta;
}

export function linksForDisplay(links: readonly WispThreadLink[]): WispThreadLink[] {
  const rank = (l: WispThreadLink) => (l.source === 'wisp_pin' ? 1 : 0);
  const sorted = [...links].sort((a, b) => rank(a) - rank(b) || newestFirst(a.createdAt, b.createdAt));
  const seen = new Set<string>();
  const out: WispThreadLink[] = [];
  for (const l of sorted) {
    const key = `${l.ref.kind}:${l.ref.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(l);
  }
  return out;
}

const KIND_LABELS: Record<WispEntityKind, string> = {
  ticket: 'Ticket',
  quote: 'Quote',
  invoice: 'Invoice',
  contract: 'Contract',
  device: 'Device',
  organization: 'Organization',
  site: 'Site',
  alert: 'Alert',
  run: 'Run',
  task: 'Task',
  user: 'User',
};

export function linkKindLabel(kind: WispEntityKind): string {
  return KIND_LABELS[kind] ?? '';
}

export function linkTarget(link: WispThreadLink): { screen: 'ticket'; ticketId: string } | null {
  if (link.ref.kind !== 'ticket' || !link.ref.id) return null;
  return { screen: 'ticket', ticketId: link.ref.id };
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

const pad = (n: number, w: number) => String(n).padStart(w, '0');
const localKey = (d: Date) => `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1, 2)}-${pad(d.getDate(), 2)}`;

export function activityGroups(
  items: readonly WispActivityItem[],
  now: Date,
): Array<{ key: string; title: string; items: WispActivityItem[] }> {
  const todayKey = localKey(now);
  // Calendar-field arithmetic (not -86400000 ms) so DST days of 23/25h are safe.
  const yesterdayKey = localKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));

  const dated = new Map<string, { title: string; items: Array<{ t: number; item: WispActivityItem }> }>();
  const unknown: WispActivityItem[] = [];
  for (const item of items) {
    const t = ms(item.at);
    if (t === null) {
      unknown.push(item);
      continue;
    }
    const d = new Date(t);
    const key = localKey(d);
    let g = dated.get(key);
    if (!g) {
      const title =
        key === todayKey
          ? 'Today'
          : key === yesterdayKey
            ? 'Yesterday'
            : `${WEEKDAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}`;
      g = { title, items: [] };
      dated.set(key, g);
    }
    g.items.push({ t, item });
  }

  const groups = [...dated.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0))
    .map(([key, g]) => ({
      key,
      title: g.title,
      items: g.items.sort((a, b) => b.t - a.t).map((x) => x.item),
    }));
  if (unknown.length > 0) groups.push({ key: 'unknown', title: 'Earlier', items: unknown });
  return groups;
}

/** The screen's cursor-paged activity timeline. */
export interface ActivityState {
  items: WispActivityItem[];
  nextCursor: string | null;
  loading: boolean;
  error: string | null;
}

export const EMPTY_ACTIVITY: ActivityState = { items: [], nextCursor: null, loading: false, error: null };

/** `requestedCursor` null = the first page, which REPLACES the list (a refresh); otherwise append. */
export function activityPageLoaded(
  state: ActivityState,
  requestedCursor: string | null,
  page: { items: readonly WispActivityItem[]; nextCursor: string | null },
): ActivityState {
  return {
    items: requestedCursor ? mergeActivityPages(state.items, page.items) : [...page.items],
    nextCursor: page.nextCursor,
    loading: false,
    error: null,
  };
}

/**
 * A failed page keeps what is already shown and offers a retry. A 404 (a
 * server older than the activity route, or a thread gone since) can never
 * succeed on retry, so it ends paging quietly instead.
 */
export function activityPageFailed(state: ActivityState, status: number | undefined): ActivityState {
  if (status === 404) return { ...state, nextCursor: null, loading: false, error: null };
  return { ...state, loading: false, error: 'Could not load activity.' };
}

/** What "Show earlier" / "Try again" asks for: a failed FIRST page retries the first page. */
export function activityLoadMoreCursor(state: ActivityState): string | null {
  return state.error && state.items.length === 0 ? null : state.nextCursor;
}

export function mergeActivityPages(
  existing: readonly WispActivityItem[],
  next: readonly WispActivityItem[],
): WispActivityItem[] {
  const seen = new Set<string>();
  const out: WispActivityItem[] = [];
  for (const item of [...existing, ...next]) {
    const key = `${item.at}|${item.kind}|${item.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}
