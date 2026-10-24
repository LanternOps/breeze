/**
 * Wisp W05 pollers — time-derived events the bus has no natural publisher for.
 *
 * `pollStaleTickets` publishes `ticket.stale` for tickets that crossed the
 * `staleHours` threshold. It is stateless: each call scans a sliding window
 * that ends exactly `staleHours` ago and is `TICKET_STALE_SCAN_WINDOW_MINUTES`
 * (10) wide — TWICE the 5 minute tick, because each tick's `now` drifts
 * (queue latency, the sections that run before it), and a window exactly one
 * tick wide leaves a gap whenever a tick runs late. So a crossing is normally
 * published by two consecutive ticks: at least once, not exactly once.
 *
 * The duplicate carries the same deterministic eventId (`ticketStaleEventId`).
 * publishEvent itself does NOT dedupe on it (the stream entry, pub/sub and
 * local handlers run per publish); the consumers do: the durable route-event
 * job is keyed `event-route-<eventId>` (while the previous one is retained),
 * webhook delivery skips a (webhook, eventId) pair it already recorded, the
 * automation worker admits one run per (automation, eventId), and
 * upsertConcern is idempotent. The Wisp wake debounce (60 s per grant/org)
 * would NOT cover it (the duplicate arrives one tick later and would request a
 * second funded assessment), so the poller claims each eventId with a Redis
 * `SET NX` marker before publishing (released if the publish fails): with
 * Redis up a crossing is published once; with Redis down, at least once.
 *
 * LIMITS, by design: a scheduler outage that puts two consecutive ticks more
 * than the window (10 minutes) apart misses the crossings that fell inside
 * the gap. The Wisp floor tick (30 minute sweep of every active grant) covers
 * that case, so no watermark table is kept here. A ticket updated again before it
 * goes stale simply never enters a window.
 *
 * Only orgs covered by an active `wisp_grants` row are scanned (the grant
 * predicate is in the SQL, not a TS filter), so a partner without Wisp never
 * pays for the scan.
 *
 * `pollTicketClusters` (w00 A30, Task 14) is the deterministic `ticket_cluster`
 * watch: per active watch it reads the tickets created in the watch window
 * for each org the grant's LIVE ceiling still covers, tokenises the subjects
 * in TS (no pg_trgm, no model call), groups them single-link at Jaccard ≥ 0.5
 * and keeps one live org-level `incident` concern per cluster. The poller
 * stamps `evidence.firstSeenAt` / `evidence.lastTicketAt` itself: assessment
 * runs touch `updated_at` on every open concern, so the correlator keys its
 * windows on these stamps, never on `updated_at`.
 */
import { createHash, randomUUID } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { wispEnabled } from '../../config/env';
import { publishEvent } from '../eventBus';
import { getRedis } from '../redis';
import { captureException } from '../sentry';
import { updateConcern, upsertConcern } from './concerns';
import {
  assertWithinCeiling,
  CeilingViolationError,
  GrantInactiveError,
  resolveGrantCeiling,
  type GrantCeiling,
} from './grantAuthority';
import { assessableOrgIds } from './assessableOrgs';

export const TICKET_STALE_DEFAULT_HOURS = 72;
/** Twice the 5 minute wake tick: consecutive windows overlap, so a late tick leaves no gap (see the header). */
export const TICKET_STALE_SCAN_WINDOW_MINUTES = 10;
/** Redis marker per published crossing (eventId); outlives the overlap many times over. */
const TICKET_STALE_MARKER_PREFIX = 'wisp:ticket-stale:';
const TICKET_STALE_MARKER_TTL_SECONDS = 6 * 60 * 60;
const TICKET_STALE_SCAN_LIMIT = 500;

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

/** `lower < updated_at <= upper` selects tickets that crossed `staleHours` within the last window. */
export function ticketStaleWindow(
  now: Date,
  staleHours: number,
  windowMinutes: number,
): { lower: Date; upper: Date } {
  const upper = new Date(now.getTime() - staleHours * HOUR_MS);
  const lower = new Date(upper.getTime() - windowMinutes * MINUTE_MS);
  return { lower, upper };
}

/**
 * Stable logical id for one ticket crossing one threshold. The event bus
 * requires a UUID, so the logical key `ticket-stale:<ticketId>:<staleHours>` is
 * hashed into a name-based (version 5 shaped) UUID.
 */
export function ticketStaleEventId(ticketId: string, staleHours: number): string {
  const h = createHash('sha1').update(`ticket-stale:${ticketId}:${staleHours}`).digest();
  h[6] = ((h[6] ?? 0) & 0x0f) | 0x50;
  h[8] = ((h[8] ?? 0) & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

type StaleTicketRow = { id: string; org_id: string; updated_at: Date | string };

/** `tickets.updated_at` is timestamp WITHOUT time zone, stored in UTC; a bare driver string is UTC. */
function toUtcDate(v: Date | string): Date {
  if (v instanceof Date) return v;
  const s = String(v);
  const hasZone = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/.test(s);
  return new Date(hasZone ? s : `${s.replace(' ', 'T')}Z`);
}

export async function pollStaleTickets(
  now: Date,
  opts: { staleHours?: number; windowMinutes?: number; limit?: number } = {},
): Promise<{ scanned: number; published: number }> {
  if (!wispEnabled()) return { scanned: 0, published: 0 };
  const staleHours = opts.staleHours ?? TICKET_STALE_DEFAULT_HOURS;
  const windowMinutes = opts.windowMinutes ?? TICKET_STALE_SCAN_WINDOW_MINUTES;
  const limit = opts.limit ?? TICKET_STALE_SCAN_LIMIT;
  const { lower, upper } = ticketStaleWindow(now, staleHours, windowMinutes);
  const lowerIso = lower.toISOString();
  const upperIso = upper.toISOString();

  // `resolved`, `closed` and `on_hold` (a deliberate wait) are not stale.
  const rows = await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const result = (await db.execute(sql`
      SELECT t.id, t.org_id, t.updated_at
        FROM tickets t
        JOIN organizations o ON o.id = t.org_id
       WHERE t.status IN ('new', 'open', 'pending')
         AND t.updated_at > (${lowerIso}::timestamptz AT TIME ZONE 'UTC')
         AND t.updated_at <= (${upperIso}::timestamptz AT TIME ZONE 'UTC')
         AND EXISTS (
           SELECT 1 FROM wisp_grants g
            WHERE g.status = 'active'
              AND g.partner_id = o.partner_id
              AND (g.org_id IS NULL OR g.org_id = t.org_id)
         )
       ORDER BY t.updated_at
       LIMIT ${limit}`)) as unknown as StaleTicketRow[];
    return [...result];
  }, 'wisp-poll-stale-tickets'));

  // Publish only after the DB block has returned (#1105).
  let published = 0;
  for (const row of rows) {
    const updatedAt = toUtcDate(row.updated_at);
    const eventId = ticketStaleEventId(row.id, staleHours);
    // Effectively-once across the overlapping windows: the first tick to see a
    // crossing claims its eventId; the next tick skips it. Without Redis the
    // poller still publishes (at least once) rather than dropping crossings.
    const markerKey = `${TICKET_STALE_MARKER_PREFIX}${eventId}`;
    let claimed = false;
    const redis = getRedis();
    if (redis) {
      try {
        if ((await redis.set(markerKey, '1', 'EX', TICKET_STALE_MARKER_TTL_SECONDS, 'NX')) !== 'OK') continue;
        claimed = true;
      } catch (err) {
        captureException(err instanceof Error ? err : new Error(String(err)));
        console.warn('[wisp] ticket.stale marker claim failed; publishing without it', err instanceof Error ? err.message : err);
      }
    }
    try {
      await publishEvent(
        'ticket.stale',
        row.org_id,
        { ticketId: row.id, orgId: row.org_id, staleHours, updatedAt: updatedAt.toISOString() },
        'wisp-pollers',
        {
          eventId,
          occurredAt: new Date(updatedAt.getTime() + staleHours * HOUR_MS).toISOString(),
        },
      );
      published += 1;
    } catch (err) {
      captureException(err instanceof Error ? err : new Error(String(err)));
      console.error('[wisp] ticket.stale publish failed', err instanceof Error ? err.message : err);
      // Let the next (overlapping) tick retry this crossing.
      if (claimed) await redis?.del(markerKey).catch(() => undefined);
    }
  }
  return { scanned: rows.length, published };
}

// ---------------------------------------------------------------------------
// Ticket clustering (Task 14, w00 A30)
// ---------------------------------------------------------------------------

/** `ticket_cluster` watch defaults; `ticketClusterParams` clamps whatever a watch stores. */
export const TICKET_CLUSTER_DEFAULT_PARAMS = { windowMinutes: 15, minTickets: 3 } as const;
export const TICKET_CLUSTER_JACCARD_THRESHOLD = 0.5;
/** Evidence keeps at most this many ticket ids (the newest); `ticketCount` keeps the full count. */
export const INCIDENT_EVIDENCE_TICKET_CAP = 200;
const TICKET_CLUSTER_PER_ORG_LIMIT = 500;
const TICKET_CLUSTER_WATCH_LIMIT = 500;
const TICKET_CLUSTER_MAX_ORGS = 1000;
const TICKET_CLUSTER_ORG_CHUNK = 50;
const LIVE_INCIDENT_READ_LIMIT = 1000;
const MAX_SUBJECT_TOKENS = 12;
const CLUSTER_NAME_TOKENS = 5;

/**
 * Words that carry no "same problem" signal in a ticket subject: reply/forward
 * prefixes, function words, and help-desk filler ("not working", "please
 * help") that would otherwise make unrelated tickets look alike.
 */
const STOP_WORDS = new Set([
  're', 'fw', 'fwd', 'aw', 'wg', 'tr',
  'a', 'an', 'the', 'and', 'or', 'but', 'nor', 'so', 'if', 'then', 'than',
  'for', 'to', 'of', 'in', 'on', 'at', 'by', 'as', 'from', 'into', 'onto', 'with', 'without', 'about', 'over', 'after', 'before', 'since', 'when', 'while',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am', 'has', 'have', 'had', 'do', 'does', 'did', 'will', 'would', 'should', 'could', 'can', 'cannot', 'may', 'might', 'must',
  'it', 'its', 'this', 'that', 'these', 'those', 'there', 'here',
  'my', 'our', 'your', 'their', 'his', 'her', 'we', 'you', 'they', 'he', 'she', 'me', 'us', 'them', 'im', 'ive',
  'not', 'no', 'cant', 'dont', 'doesnt', 'didnt', 'wont', 'isnt', 'wasnt', 'arent', 'couldnt', 'don', 'doesn', 'didn', 'isn', 'wasn', 'aren', 'couldn',
  'please', 'pls', 'plz', 'help', 'need', 'needs', 'needed', 'urgent', 'asap', 'issue', 'issues', 'problem', 'problems',
  'ticket', 'request', 'hi', 'hello', 'hey', 'thanks', 'thank', 'regarding', 're:', 'some', 'any', 'all', 'again', 'still', 'just', 'also', 'very',
  'up', 'out', 'now', 'today', 'working', 'work', 'works', 'get', 'gets', 'getting', 'got',
]);

/** `#4021`, `T-1234`, `INC0012345`, `REQ-77`, `SR#5`, `case 12` style references. */
const TICKET_REF_RE = /#\S*|\b(?:t|tkt|inc|req|sr|case)[-#:]?\d+\b/gu;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(v)));
}

/** A watch's stored params, clamped (window 5–1440 min, minTickets 2–50); garbage falls back to the defaults. */
export function ticketClusterParams(params: Record<string, unknown> | null | undefined): { windowMinutes: number; minTickets: number } {
  const p = params ?? {};
  return {
    windowMinutes: clampInt(p.windowMinutes, 5, 1440, TICKET_CLUSTER_DEFAULT_PARAMS.windowMinutes),
    minTickets: clampInt(p.minTickets, 2, 50, TICKET_CLUSTER_DEFAULT_PARAMS.minTickets),
  };
}

/** Lowercase, drop ticket references, split on non-alphanumerics, drop stop-words / bare numbers / dupes; ≤ 12 tokens. */
export function normalizeTicketTokens(subject: string): string[] {
  const text = String(subject ?? '').normalize('NFKC').toLowerCase().replace(TICKET_REF_RE, ' ');
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tok of text.split(/[^\p{L}\p{N}]+/u)) {
    if (tok.length < 2 || /^\p{N}+$/u.test(tok) || STOP_WORDS.has(tok) || seen.has(tok)) continue;
    seen.add(tok);
    out.push(tok);
    if (out.length >= MAX_SUBJECT_TOKENS) break;
  }
  return out;
}

function jaccardSets(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/** |A∩B| / |A∪B| over the token SETS; 0 when either side is empty. */
export function jaccard(a: readonly string[], b: readonly string[]): number {
  return jaccardSets(new Set(a), new Set(b));
}

/**
 * Single-link clusters (union-find over every pair at Jaccard ≥ threshold).
 * Rows are sorted by id first, so the result — group membership, member order
 * (by id) and group order (by smallest id) — does not depend on input order.
 */
export function singleLinkClusters<T extends { id: string; tokens: readonly string[] }>(
  rows: readonly T[],
  threshold: number = TICKET_CLUSTER_JACCARD_THRESHOLD,
): T[][] {
  const sorted = [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const sets = sorted.map((r) => new Set(r.tokens));
  const parent = sorted.map((_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (parent[root]! !== root) root = parent[root]!;
    let cur = i;
    while (parent[cur]! !== root) {
      const next = parent[cur]!;
      parent[cur] = root;
      cur = next;
    }
    return root;
  };
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      if (jaccardSets(sets[i]!, sets[j]!) < threshold) continue;
      const a = find(i);
      const b = find(j);
      // The smaller index stays the root, so a group's root is its first member.
      if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
    }
  }
  const groups = new Map<number, T[]>();
  sorted.forEach((r, i) => {
    const root = find(i);
    const g = groups.get(root);
    if (g) g.push(r);
    else groups.set(root, [r]);
  });
  return [...groups.entries()].sort((x, y) => x[0] - y[0]).map(([, g]) => g);
}

/** The cluster's name: tokens by member frequency (each member counts a token once), ties alphabetical; top 5. */
export function topClusterTokens(tokenLists: ReadonlyArray<readonly string[]>, n: number = CLUSTER_NAME_TOKENS): string[] {
  const freq = new Map<string, number>();
  for (const list of tokenLists) for (const t of new Set(list)) freq.set(t, (freq.get(t) ?? 0) + 1);
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, n)
    .map(([t]) => t);
}

/** Pure: per-org single-link groups of ≥ minTickets tickets (never across orgs), named by their top-5 tokens. */
export function clusterTickets(
  rows: Array<{ id: string; orgId: string; tokens: string[] }>,
  minTickets: number,
  threshold: number = TICKET_CLUSTER_JACCARD_THRESHOLD,
): Array<{ orgId: string; ticketIds: string[]; tokens: string[] }> {
  const byOrg = new Map<string, Array<{ id: string; orgId: string; tokens: string[] }>>();
  for (const r of rows) {
    if (r.tokens.length === 0) continue;
    const list = byOrg.get(r.orgId);
    if (list) list.push(r);
    else byOrg.set(r.orgId, [r]);
  }
  const min = Math.max(1, Math.trunc(minTickets));
  const out: Array<{ orgId: string; ticketIds: string[]; tokens: string[] }> = [];
  for (const orgId of [...byOrg.keys()].sort()) {
    for (const group of singleLinkClusters(byOrg.get(orgId)!, threshold)) {
      if (group.length < min) continue;
      out.push({ orgId, ticketIds: group.map((r) => r.id), tokens: topClusterTokens(group.map((r) => r.tokens)) });
    }
  }
  return out;
}

/**
 * The correlator's idempotency key: sha256 hex of `${scope}:${sorted tokens}`
 * (deduped; callers pass a cluster's top-5 tokens, so at most 5 survive).
 */
export function clusterSignature(scope: string, tokens: string[]): string {
  const name = [...new Set(tokens)].sort().slice(0, CLUSTER_NAME_TOKENS).join(' ');
  return createHash('sha256').update(`${scope}:${name}`).digest('hex');
}

// --- small shared helpers (the correlator uses them too) -------------------

/** A Postgres `uuid[]` parameter from ids (non-uuids dropped, so the literal stays well-formed). */
export function uuidArraySql(ids: Iterable<string>): SQL {
  const clean = [...ids].filter((id) => UUID_RE.test(id));
  return sql`${`{${clean.join(',')}}`}::uuid[]`;
}

/** A string list from a parsed json array, a JSON string, or a Postgres array literal. */
export function stringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  if (typeof v !== 'string') return [];
  const s = v.trim();
  if (s.startsWith('[')) {
    try { return stringArray(JSON.parse(s)); } catch { return []; }
  }
  if (s.startsWith('{') && s.endsWith('}')) {
    return s.slice(1, -1).split(',').map((x) => x.trim().replace(/^"|"$/g, '')).filter(Boolean);
  }
  return [];
}

export function jsonRecord(v: unknown): Record<string, unknown> {
  if (typeof v === 'string') {
    try { return jsonRecord(JSON.parse(v)); } catch { return {}; }
  }
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? { ...(v as Record<string, unknown>) } : {};
}

/** `prev` then the new ids of `add`; past `cap`, the oldest drop off. */
export function appendCapped(prev: readonly string[], add: readonly string[], cap: number): { ids: string[]; added: number } {
  const seen = new Set(prev);
  const ids = [...prev];
  let added = 0;
  for (const id of add) {
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    added += 1;
  }
  return { ids: ids.length > cap ? ids.slice(ids.length - cap) : ids, added };
}

/** The later of two ISO instants (toISOString output sorts lexically); null-tolerant. */
export function maxIso(a: string | null | undefined, b: string | null | undefined): string | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return a >= b ? a : b;
}

export function evidenceIso(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// --- pollTicketClusters ----------------------------------------------------

type ClusterWatchRow = {
  id: string;
  org_id: string | null;
  grant_id: string;
  partner_id: string;
  current_revision_id: string;
  params: unknown;
};
type ClusterTarget = { orgId: string; partnerId: string; grantId: string; windowMinutes: number; minTickets: number };
type ClusterTicketRow = { id: string; org_id: string; subject: string | null; created_at: Date | string };
type LiveIncident = { id: string; signature: string | null; evidence: Record<string, unknown> };

function inSystemRead<T>(fn: () => Promise<T>, label: string): Promise<T> {
  return runOutsideDbContext(() => withSystemDbAccessContext(fn, label));
}

/**
 * The ceiling orgs a cluster scan may read: reached whole (a cluster summary
 * quotes ticket subjects across the org, so a site-restricted reach is never
 * scanned) AND with `tickets:read` held there — the grantor's per-org term
 * included (org-axis precedence, grantAuthority.ts).
 */
function ticketReadableOrgIds(ceiling: GrantCeiling): Set<string> {
  const out = new Set<string>();
  for (const orgId of assessableOrgIds(ceiling)) {
    try {
      assertWithinCeiling(ceiling, { orgId, permission: 'tickets:read' });
      out.add(orgId);
    } catch (err) {
      if (!(err instanceof CeilingViolationError)) throw err;
    }
  }
  return out;
}

/**
 * Orgs to scan, from the active watches and each grant's LIVE ceiling: an
 * org-scoped watch counts only while its org is still inside the ceiling; a
 * partner-wide watch expands to every ceiling org. Either way only orgs where
 * the grant holds `tickets:read` (ticketReadableOrgIds). Several watches on
 * one org merge to the widest window and the smallest minTickets; the first
 * watch (by id) names the raising grant. An inactive grant is skipped silently.
 */
async function resolveClusterTargets(watches: ClusterWatchRow[]): Promise<ClusterTarget[]> {
  const ceilings = new Map<string, ReadonlySet<string> | null>();
  const targets = new Map<string, ClusterTarget>();
  for (const w of watches) {
    let orgs = ceilings.get(w.grant_id);
    if (orgs === undefined) {
      try {
        orgs = ticketReadableOrgIds(await resolveGrantCeiling(w.grant_id, w.current_revision_id));
      } catch (err) {
        if (!(err instanceof GrantInactiveError)) {
          captureException(err, undefined, { component: 'wisp.pollers', op: 'ticket_cluster_ceiling' });
        }
        orgs = null;
      }
      ceilings.set(w.grant_id, orgs);
    }
    if (!orgs) continue;
    const params = ticketClusterParams(jsonRecord(w.params));
    const orgIds = w.org_id ? (orgs.has(w.org_id) ? [w.org_id] : []) : [...orgs].sort();
    for (const orgId of orgIds) {
      const t = targets.get(orgId);
      if (t) {
        t.windowMinutes = Math.max(t.windowMinutes, params.windowMinutes);
        t.minTickets = Math.min(t.minTickets, params.minTickets);
      } else if (targets.size < TICKET_CLUSTER_MAX_ORGS) {
        targets.set(orgId, { orgId, partnerId: w.partner_id, grantId: w.grant_id, ...params });
      }
    }
  }
  return [...targets.values()].sort((a, b) => (a.orgId < b.orgId ? -1 : 1));
}

function clusterSummary(count: number, windowMinutes: number, tokens: string[]): string {
  return `${count} similar tickets in ${windowMinutes} min: ${tokens.join(' ')}`;
}

/** Read-merge-write: updateConcern REPLACES evidence. Returns false when nothing new arrived. */
async function mergeCluster(
  live: LiveIncident,
  cluster: { ticketIds: string[]; lastTicketAt: string | null },
  windowMinutes: number,
): Promise<boolean> {
  const ev = live.evidence;
  const prevIds = stringArray(ev.ticketIds);
  const { ids, added } = appendCapped(prevIds, cluster.ticketIds, INCIDENT_EVIDENCE_TICKET_CAP);
  const prevLast = evidenceIso(ev.lastTicketAt);
  const lastTicketAt = maxIso(prevLast, cluster.lastTicketAt);
  if (added === 0 && lastTicketAt === prevLast) return false;
  const prevCount = typeof ev.ticketCount === 'number' && Number.isFinite(ev.ticketCount) ? ev.ticketCount : prevIds.length;
  const ticketCount = prevCount + added;
  // Tokens (and so the signature) stay as first named; the window is the scan's.
  const tokens = stringArray(ev.tokens);
  const evidence = { ...ev, ticketIds: ids, ticketCount, lastTicketAt, windowMinutes: Number(ev.windowMinutes) || windowMinutes };
  await updateConcern(live.id, {
    evidence,
    summary: clusterSummary(ticketCount, Number(evidence.windowMinutes), tokens.length ? tokens : ['(unnamed)']),
  });
  live.evidence = evidence;
  return true;
}

function findLiveMatch(list: LiveIncident[], signature: string, ticketIds: string[]): LiveIncident | null {
  const bySig = list.find((c) => c.signature === signature);
  if (bySig) return bySig;
  // The top tokens can drift as tickets age out of the window; a live concern
  // already holding one of these tickets is the same incident.
  const ids = new Set(ticketIds);
  return list.find((c) => stringArray(c.evidence.ticketIds).some((id) => ids.has(id))) ?? null;
}

/**
 * The `ticket_cluster` watch (see the file header). Returns the tickets read,
 * the concerns opened and the live concerns that took new tickets.
 */
export async function pollTicketClusters(
  now: Date,
  opts: { limit?: number } = {},
): Promise<{ scanned: number; clustersOpened: number; clustersUpdated: number }> {
  const result = { scanned: 0, clustersOpened: 0, clustersUpdated: 0 };
  if (!wispEnabled()) return result;
  const perOrgLimit = clampInt(opts.limit, 1, TICKET_CLUSTER_PER_ORG_LIMIT, TICKET_CLUSTER_PER_ORG_LIMIT);
  const nowIso = now.toISOString();

  const watches = await inSystemRead(async () => [...((await db.execute(sql`
    /* wisp:cluster-watches */
    SELECT w.id, w.org_id, w.grant_id, w.params, g.partner_id, g.current_revision_id
      FROM wisp_watches w
      JOIN wisp_grants g ON g.id = w.grant_id
     WHERE w.kind = 'ticket_cluster'
       AND w.status = 'active'
       AND g.status = 'active'
       AND g.expires_at > ${nowIso}::timestamptz
       AND g.current_revision_id IS NOT NULL
     ORDER BY w.id
     LIMIT ${TICKET_CLUSTER_WATCH_LIMIT}`)) as unknown as ClusterWatchRow[])], 'wisp-poll-ticket-clusters');
  if (watches.length === 0) return result;

  const targets = await resolveClusterTargets(watches);
  for (let i = 0; i < targets.length; i += TICKET_CLUSTER_ORG_CHUNK) {
    const chunk = targets.slice(i, i + TICKET_CLUSTER_ORG_CHUNK);
    const windows = chunk.map((t) => sql`(${t.orgId}::uuid, ${new Date(now.getTime() - t.windowMinutes * MINUTE_MS).toISOString()}::timestamptz)`);
    const { tickets, live } = await inSystemRead(async () => {
      const ticketRows = (await db.execute(sql`
        /* wisp:cluster-tickets */
        SELECT r.id, r.org_id, r.subject, r.created_at FROM (
          SELECT t.id, t.org_id, t.subject, t.created_at,
                 row_number() OVER (PARTITION BY t.org_id ORDER BY t.created_at DESC, t.id) AS rn
            FROM (VALUES ${sql.join(windows, sql`, `)}) AS w(org_id, lower_at)
            JOIN tickets t ON t.org_id = w.org_id
           WHERE t.created_at > (w.lower_at AT TIME ZONE 'UTC')
             AND t.created_at <= (${nowIso}::timestamptz AT TIME ZONE 'UTC')
             AND t.status <> 'closed'
             AND t.deleted_at IS NULL
             AND t.merged_into_ticket_id IS NULL
             AND t.migration_window_id IS NULL
             AND t.work_kind = 'support'
        ) r
         WHERE r.rn <= ${perOrgLimit}`)) as unknown as ClusterTicketRow[];
      const liveRows = (await db.execute(sql`
        /* wisp:cluster-live */
        SELECT id, org_id, signature, evidence
          FROM wisp_concerns
         WHERE org_id = ANY(${uuidArraySql(chunk.map((t) => t.orgId))})
           AND subject_kind = 'incident'
           AND status IN ('open', 'snoozed')
         ORDER BY id
         LIMIT ${LIVE_INCIDENT_READ_LIMIT}`)) as unknown as Array<{ id: string; org_id: string; signature: string | null; evidence: unknown }>;
      return { tickets: [...ticketRows], live: [...liveRows] };
    }, 'wisp-poll-ticket-clusters');
    result.scanned += tickets.length;

    const liveByOrg = new Map<string, LiveIncident[]>();
    for (const c of live) {
      const list = liveByOrg.get(c.org_id) ?? [];
      list.push({ id: c.id, signature: c.signature, evidence: jsonRecord(c.evidence) });
      liveByOrg.set(c.org_id, list);
    }
    const createdAt = new Map(tickets.map((t) => [t.id, toUtcDate(t.created_at).toISOString()]));

    // Writes run after the read block returned, each in its own system context.
    for (const target of chunk) {
      const rows = tickets
        .filter((t) => t.org_id === target.orgId)
        .map((t) => ({ id: t.id, orgId: t.org_id, tokens: normalizeTicketTokens(t.subject ?? '') }));
      for (const cluster of clusterTickets(rows, target.minTickets)) {
        try {
          const lastTicketAt = cluster.ticketIds.reduce<string | null>((m, id) => maxIso(m, createdAt.get(id)), null);
          const signature = clusterSignature(target.orgId, cluster.tokens);
          const list = liveByOrg.get(target.orgId) ?? [];
          liveByOrg.set(target.orgId, list);
          const match = findLiveMatch(list, signature, cluster.ticketIds);
          if (match) {
            if (await mergeCluster(match, { ticketIds: cluster.ticketIds, lastTicketAt }, target.windowMinutes)) result.clustersUpdated += 1;
            continue;
          }
          const evidence = {
            ticketIds: cluster.ticketIds.slice(-INCIDENT_EVIDENCE_TICKET_CAP),
            ticketCount: cluster.ticketIds.length,
            tokens: cluster.tokens,
            windowMinutes: target.windowMinutes,
            firstSeenAt: nowIso,
            lastTicketAt,
          };
          const { id, created } = await upsertConcern({
            partnerId: target.partnerId,
            orgId: target.orgId,
            subject: { kind: 'incident', id: randomUUID() },
            signature,
            severity: 'medium',
            summary: clusterSummary(cluster.ticketIds.length, target.windowMinutes, cluster.tokens),
            evidence,
            raisedByGrantId: target.grantId,
          });
          if (created) {
            result.clustersOpened += 1;
            list.push({ id, signature, evidence });
            continue;
          }
          // Lost a race on the signature index: merge into the winner.
          const [winner] = await inSystemRead(async () => [...((await db.execute(sql`
            /* wisp:cluster-live */
            SELECT id, org_id, signature, evidence FROM wisp_concerns WHERE id = ${id}::uuid LIMIT 1`)) as unknown as Array<{ id: string; signature: string | null; evidence: unknown }>)], 'wisp-poll-ticket-clusters');
          const entry: LiveIncident = { id, signature: winner?.signature ?? signature, evidence: jsonRecord(winner?.evidence) };
          list.push(entry);
          if (await mergeCluster(entry, { ticketIds: cluster.ticketIds, lastTicketAt }, target.windowMinutes)) result.clustersUpdated += 1;
        } catch (err) {
          captureException(err, undefined, { component: 'wisp.pollers', op: 'ticket_cluster_write' });
        }
      }
    }
  }
  return result;
}
