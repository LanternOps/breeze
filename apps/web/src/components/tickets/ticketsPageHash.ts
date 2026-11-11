import { ticketTypeFromHash, type TicketType } from './ticketType';

// 'review' is the inbound email review queue — a sibling surface, not a ticket
// query. It renders InboundReviewQueue instead of the queue, and is only
// present for admins (visibility gated by a 200 from the queue endpoint).
// 'archived' is the soft-deleted queue (GET /tickets?deleted=only) — a ticket
// query, but rendered as a restore-only list (no focus). tickets:manage-gated.
export type Tab = 'mine' | 'unassigned' | 'open' | 'breaching' | 'closed' | 'review' | 'archived';
export type LiveTab = Exclude<Tab, 'review' | 'archived'>;
export type TicketSort = 'triage' | 'newest' | 'oldest' | 'due';

export const SORT_OPTIONS: Array<{ value: TicketSort; labelKey: string }> = [
  { value: 'triage', labelKey: 'triage' },
  { value: 'newest', labelKey: 'newest' },
  { value: 'oldest', labelKey: 'oldest' },
  { value: 'due', labelKey: 'due' }
];

export const isTicketSort = (value: string): value is TicketSort =>
  SORT_OPTIONS.some((o) => o.value === value);

export const TABS: Array<{ id: LiveTab; labelKey: string }> = [
  { id: 'mine', labelKey: 'mine' },
  { id: 'unassigned', labelKey: 'unassigned' },
  { id: 'open', labelKey: 'open' },
  { id: 'breaching', labelKey: 'breaching' },
  { id: 'closed', labelKey: 'closed' }
];

export const isLiveTab = (value: unknown): value is LiveTab =>
  typeof value === 'string' && TABS.some((tab) => tab.id === value);

export function tabQuery(tab: LiveTab): string {
  switch (tab) {
    case 'mine': return 'statusGroup=open&assignee=me';
    case 'unassigned': return 'statusGroup=open&assignee=unassigned';
    case 'open': return 'statusGroup=open';
    // Server-defined: breached ∪ at-risk (pause-aware — paused clocks are frozen, so
    // paused tickets are intentionally excluded). Rows arrive pre-filtered.
    case 'breaching': return 'statusGroup=open&slaState=breaching';
    case 'closed': return 'statusGroup=closed&sort=newest';
  }
}

// Hash layout (hash-based UI state per CLAUDE.md):
// `#<focus>&sort=<sort>&type=<type>&merged=1`.
// The bare segment is the focused ticket key (internal number or id): with it
// the page shows that ticket in focus, without it the triage board.
// `merged=1` is the "Show merged" list toggle (#8972); absent = off. `sort=`
// carries the queue sort and `type=` the ticket-type filter (#7900). All are
// optional, and the default sort ('triage') is omitted so plain
// `#T-2026-0001` hashes keep working. A `type=` segment is matched BEFORE the
// focus fallback, so it can never be read as a ticket key; an unknown type
// value is dropped, not turned into a focus key.
// Pure: takes the raw hash (leading `#` already stripped by useHashState, #2421).
export function parseHash(hash: string): { selection: string | null; sort: TicketSort; type: TicketType | null; showMerged: boolean } {
  let selection: string | null = null;
  let sort: TicketSort = 'triage';
  let showMerged = false;
  for (const part of hash.split('&')) {
    if (!part) continue;
    if (part.startsWith('sort=')) {
      const value = part.slice('sort='.length);
      if (isTicketSort(value)) sort = value;
    } else if (part.startsWith('merged=')) {
      showMerged = part.slice('merged='.length) === '1';
    } else if (!part.startsWith('type=')) {
      selection = part;
    }
  }
  // Same helper as the sidebar, over the whole hash, so a repeated `type=`
  // segment resolves identically in the list filter and the nav highlight.
  return { selection, sort, type: ticketTypeFromHash(hash), showMerged };
}

// The whole queue hash as ONE piece of state (#8682 sweep). Focus, sort and
// type must move together: with one `useHashState` per field, each field had
// its own hashchange listener, and an external change landed one field at a
// time while a state-to-hash writer could clobber the half-applied URL.
export type QueueHash = { selection: string | null; sort: TicketSort; type: TicketType | ''; showMerged: boolean };
export const DEFAULT_QUEUE_HASH: QueueHash = { selection: null, sort: 'triage', type: '', showMerged: false };
export function parseQueueHash(hash: string): QueueHash {
  const { selection, sort, type, showMerged } = parseHash(hash);
  return { selection, sort, type: type ?? '', showMerged };
}

export function hashFor(selection: string | null, sort: TicketSort, type: TicketType | null = null, showMerged = false): string {
  const parts: string[] = [];
  if (selection) parts.push(selection);
  if (sort !== 'triage') parts.push(`sort=${sort}`);
  if (type) parts.push(`type=${type}`);
  if (showMerged) parts.push('merged=1');
  return parts.length > 0 ? `#${parts.join('&')}` : '';
}

export const isUuid = (key: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key);

// The queue tab a tech last worked in, per browser: /tickets/[id] opens in
// focus with that tab as its list context. A convenience, so storage failures
// (private mode, blocked site data) just fall back to "All open".
const QUEUE_TAB_KEY = 'breeze.tickets.queueTab';
export function readStoredQueueTab(): LiveTab | null {
  try {
    const value = window.localStorage.getItem(QUEUE_TAB_KEY);
    return isLiveTab(value) ? value : null;
  } catch {
    return null;
  }
}
export function storeQueueTab(tab: LiveTab): void {
  try {
    window.localStorage.setItem(QUEUE_TAB_KEY, tab);
  } catch {
    // Storage unavailable: the tab simply is not remembered.
  }
}
