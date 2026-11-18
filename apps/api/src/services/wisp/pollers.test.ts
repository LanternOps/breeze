/**
 * Wisp W05 Task 8 — pollStaleTickets. `db.execute` is a recorder (the SQL is
 * rendered with PgDialect for assertions); the event bus and the flag are
 * mocked. The window arithmetic is asserted on the bound parameters and on the
 * pure `ticketStaleWindow` helper, since a mock cannot evaluate the predicate.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

const h = vi.hoisted(() => ({
  enabled: true,
  executes: [] as Array<{ query: unknown; inSystem: boolean }>,
  rows: [] as unknown[],
  state: { inSystem: false },
  publishEvent: vi.fn(async (..._a: unknown[]) => 'evt-1'),
  publishedInsideSystem: [] as boolean[],
  captureException: vi.fn(),
  /** When set, db.execute answers through it (ticket-cluster tests); else returns `rows`. */
  handler: null as null | ((query: unknown) => unknown[]),
  upsertConcern: vi.fn(),
  updateConcern: vi.fn(),
  resolveGrantCeiling: vi.fn(),
  writesInsideSystem: [] as boolean[],
  /** A tiny in-memory Redis for the ticket.stale publish markers; null = Redis unavailable. */
  redisKeys: new Set<string>(),
  redisAvailable: true,
  redisSet: vi.fn(),
  redisDel: vi.fn(),
}));
vi.mock('../redis', () => ({
  getRedis: () => (h.redisAvailable ? { set: h.redisSet, del: h.redisDel } : null),
}));

vi.mock('../../db', () => ({
  db: {
    execute: vi.fn(async (query: unknown) => {
      h.executes.push({ query, inSystem: h.state.inSystem });
      return h.handler ? h.handler(query) : h.rows;
    }),
  },
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => {
    h.state.inSystem = true;
    try { return await fn(); } finally { h.state.inSystem = false; }
  }),
}));
vi.mock('../../config/env', () => ({ wispEnabled: () => h.enabled }));
vi.mock('../eventBus', () => ({
  publishEvent: vi.fn(async (...a: unknown[]) => {
    h.publishedInsideSystem.push(h.state.inSystem);
    return h.publishEvent(...a);
  }),
}));
vi.mock('../sentry', () => ({ captureException: h.captureException }));
vi.mock('./concerns', () => ({
  upsertConcern: vi.fn(async (...a: unknown[]) => {
    h.writesInsideSystem.push(h.state.inSystem);
    return h.upsertConcern(...a);
  }),
  updateConcern: vi.fn(async (...a: unknown[]) => {
    h.writesInsideSystem.push(h.state.inSystem);
    return h.updateConcern(...a);
  }),
}));
// The real assertWithinCeiling / CeilingViolationError (the cluster scan's
// tickets:read gate); only the ceiling lookup is faked.
vi.mock('./grantAuthority', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./grantAuthority')>()),
  resolveGrantCeiling: (...a: unknown[]) => h.resolveGrantCeiling(...a),
}));

import { createHash } from 'node:crypto';
import { GrantInactiveError } from './grantAuthority';
import {
  TICKET_CLUSTER_DEFAULT_PARAMS,
  clusterSignature,
  clusterTickets,
  jaccard,
  normalizeTicketTokens,
  pollTicketClusters,
  ticketClusterParams,
  TICKET_STALE_DEFAULT_HOURS,
  TICKET_STALE_SCAN_WINDOW_MINUTES,
  pollStaleTickets,
  ticketStaleEventId,
  ticketStaleWindow,
} from './pollers';

const dialect = new PgDialect();
const NOW = new Date('2026-10-24T12:00:00.000Z');
const HOUR = 3_600_000;
const MIN = 60_000;
const T1 = '00000000-0000-4000-8000-0000000000a1';
const ORG = '00000000-0000-4000-8000-0000000000b1';

function rendered() {
  const q = h.executes[0]!.query as Parameters<PgDialect['sqlToQuery']>[0];
  return dialect.sqlToQuery(q);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.enabled = true;
  h.executes = [];
  h.rows = [];
  h.publishedInsideSystem = [];
  h.state.inSystem = false;
  h.publishEvent.mockImplementation(async () => 'evt-1');
  h.handler = null;
  h.writesInsideSystem = [];
});

describe('constants', () => {
  it('defaults to 72h stale and a 10 minute scan window (twice the 5 minute tick)', () => {
    expect(TICKET_STALE_DEFAULT_HOURS).toBe(72);
    expect(TICKET_STALE_SCAN_WINDOW_MINUTES).toBe(10);
  });
});

describe('ticketStaleWindow — consecutive ticks', () => {
  // The repeatable fires every 5 minutes, but each tick's `now` is read after
  // the earlier sections ran, so consecutive `now`s drift apart by more than 5.
  it('leaves no gap between two ticks up to 5 minutes late, and overlaps them', () => {
    const tick = 5 * MIN;
    for (const lateBy of [0, 30_000, 2 * MIN, 5 * MIN]) {
      const first = ticketStaleWindow(NOW, 72, TICKET_STALE_SCAN_WINDOW_MINUTES);
      const second = ticketStaleWindow(new Date(NOW.getTime() + tick + lateBy), 72, TICKET_STALE_SCAN_WINDOW_MINUTES);
      // (lower, upper] windows: no gap iff the next lower edge is at or before the previous upper edge.
      expect(second.lower.getTime(), `late by ${lateBy} ms`).toBeLessThanOrEqual(first.upper.getTime());
    }
  });

  it('the old 5 minute window gapped as soon as a tick ran late', () => {
    const first = ticketStaleWindow(NOW, 72, 5);
    const second = ticketStaleWindow(new Date(NOW.getTime() + 5 * MIN + 30_000), 72, 5);
    expect(second.lower.getTime()).toBeGreaterThan(first.upper.getTime());
  });
});

describe('ticketStaleWindow', () => {
  const { lower, upper } = ticketStaleWindow(NOW, 72, 5);
  const inWindow = (updatedAt: number) => updatedAt > lower.getTime() && updatedAt <= upper.getTime();

  it('includes a ticket updated exactly stale hours ago', () => {
    expect(inWindow(NOW.getTime() - 72 * HOUR)).toBe(true);
  });
  it('excludes a ticket updated stale + window + 1 minute ago', () => {
    expect(inWindow(NOW.getTime() - 72 * HOUR - 6 * MIN)).toBe(false);
  });
  it('excludes a ticket updated stale - 1 minute ago (not stale yet)', () => {
    expect(inWindow(NOW.getTime() - 72 * HOUR + 1 * MIN)).toBe(false);
  });
  it('includes the whole sliding window just inside the lower edge', () => {
    expect(inWindow(NOW.getTime() - 72 * HOUR - 5 * MIN + 1)).toBe(true);
    expect(inWindow(NOW.getTime() - 72 * HOUR - 5 * MIN)).toBe(false);
  });
});

describe('ticketStaleEventId', () => {
  it('is a deterministic UUID the event bus accepts, distinct per ticket and threshold', () => {
    const re = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const a = ticketStaleEventId(T1, 72);
    expect(a).toMatch(re);
    expect(ticketStaleEventId(T1, 72)).toBe(a);
    expect(ticketStaleEventId(T1, 48)).not.toBe(a);
    expect(ticketStaleEventId('00000000-0000-4000-8000-0000000000a2', 72)).not.toBe(a);
  });
});

describe('pollStaleTickets', () => {
  beforeEach(() => {
    h.redisKeys.clear();
    h.redisAvailable = true;
    h.redisSet.mockImplementation(async (key: string, _v: string, _ex: string, _ttl: number, _nx: string) => {
      if (h.redisKeys.has(key)) return null;
      h.redisKeys.add(key);
      return 'OK';
    });
    h.redisDel.mockImplementation(async (key: string) => { h.redisKeys.delete(key); return 1; });
  });

  it('returns zeros without touching the DB when Wisp is off', async () => {
    h.enabled = false;
    await expect(pollStaleTickets(NOW)).resolves.toEqual({ scanned: 0, published: 0 });
    expect(h.executes).toHaveLength(0);
    expect(h.publishEvent).not.toHaveBeenCalled();
  });

  it('queries the sliding window, open-ish statuses and the grant join in SQL, in system context', async () => {
    await pollStaleTickets(NOW);
    expect(h.executes).toHaveLength(1);
    expect(h.executes[0]!.inSystem).toBe(true);
    const { sql: text, params } = rendered();
    expect(text).toMatch(/FROM tickets/i);
    expect(text).toMatch(/status IN \('new', 'open', 'pending'\)/);
    expect(text).toMatch(/EXISTS/i);
    expect(text).toMatch(/wisp_grants/);
    expect(text).toMatch(/g\.status = 'active'/);
    expect(text).toMatch(/g\.partner_id = o\.partner_id/);
    expect(text).toMatch(/g\.org_id IS NULL OR g\.org_id = t\.org_id/);
    expect(text).toMatch(/LIMIT/i);
    const { lower, upper } = ticketStaleWindow(NOW, 72, 10);
    expect(params).toContain(lower.toISOString());
    expect(params).toContain(upper.toISOString());
    expect(params).toContain(500);
  });

  it('honours opts overrides for the window and limit', async () => {
    await pollStaleTickets(NOW, { staleHours: 24, windowMinutes: 10, limit: 50 });
    const { params } = rendered();
    const { lower, upper } = ticketStaleWindow(NOW, 24, 10);
    expect(params).toContain(lower.toISOString());
    expect(params).toContain(upper.toISOString());
    expect(params).toContain(50);
  });

  it('publishes ticket.stale per row after the DB block with a deterministic eventId', async () => {
    const updatedAt = new Date(NOW.getTime() - 72 * HOUR);
    h.rows = [{ id: T1, org_id: ORG, updated_at: updatedAt }];
    const res = await pollStaleTickets(NOW);
    expect(res).toEqual({ scanned: 1, published: 1 });
    expect(h.publishEvent).toHaveBeenCalledWith(
      'ticket.stale', ORG,
      { ticketId: T1, orgId: ORG, staleHours: 72, updatedAt: updatedAt.toISOString() },
      'wisp-pollers',
      { eventId: ticketStaleEventId(T1, 72), occurredAt: new Date(updatedAt.getTime() + 72 * HOUR).toISOString() },
    );
    expect(h.publishedInsideSystem).toEqual([false]);
  });

  // The overlapping window would publish a crossing on two consecutive ticks;
  // the marker makes it effectively once, so a stale ticket requests at most
  // one funded assessment.
  it('publishes a crossing once across two overlapping ticks (Redis NX marker on the eventId)', async () => {
    h.rows = [{ id: T1, org_id: ORG, updated_at: new Date(NOW.getTime() - 72 * HOUR) }];
    await expect(pollStaleTickets(NOW)).resolves.toEqual({ scanned: 1, published: 1 });
    await expect(pollStaleTickets(new Date(NOW.getTime() + 5 * 60_000))).resolves.toEqual({ scanned: 1, published: 0 });
    expect(h.publishEvent).toHaveBeenCalledTimes(1);
    expect(h.redisSet).toHaveBeenCalledWith(`wisp:ticket-stale:${ticketStaleEventId(T1, 72)}`, '1', 'EX', expect.any(Number), 'NX');
  });

  it('releases the marker when the publish fails, so the next tick retries', async () => {
    h.rows = [{ id: T1, org_id: ORG, updated_at: new Date(NOW.getTime() - 72 * HOUR) }];
    h.publishEvent.mockImplementationOnce(async () => { throw new Error('stream down'); });
    await expect(pollStaleTickets(NOW)).resolves.toEqual({ scanned: 1, published: 0 });
    await expect(pollStaleTickets(new Date(NOW.getTime() + 5 * 60_000))).resolves.toEqual({ scanned: 1, published: 1 });
  });

  it('without Redis it still publishes (at least once), never silently drops', async () => {
    h.redisAvailable = false;
    h.rows = [{ id: T1, org_id: ORG, updated_at: new Date(NOW.getTime() - 72 * HOUR) }];
    await expect(pollStaleTickets(NOW)).resolves.toEqual({ scanned: 1, published: 1 });
  });

  it('treats timestamp-without-time-zone text from the driver as UTC', async () => {
    h.rows = [{ id: T1, org_id: ORG, updated_at: '2026-10-21 12:00:00' }];
    await pollStaleTickets(NOW);
    expect(h.publishEvent).toHaveBeenCalledWith(
      'ticket.stale', ORG,
      expect.objectContaining({ updatedAt: '2026-10-21T12:00:00.000Z' }),
      'wisp-pollers',
      expect.objectContaining({ occurredAt: '2026-10-24T12:00:00.000Z' }),
    );
  });

  it('counts a failed publish as scanned but not published and keeps going', async () => {
    h.rows = [
      { id: T1, org_id: ORG, updated_at: new Date(NOW.getTime() - 72 * HOUR) },
      { id: '00000000-0000-4000-8000-0000000000a2', org_id: ORG, updated_at: new Date(NOW.getTime() - 72 * HOUR) },
    ];
    h.publishEvent.mockImplementationOnce(async () => { throw new Error('redis down'); });
    await expect(pollStaleTickets(NOW)).resolves.toEqual({ scanned: 2, published: 1 });
    expect(h.captureException).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Task 14 — ticket clustering (w00 A30)
// ---------------------------------------------------------------------------

describe('normalizeTicketTokens', () => {
  it('lowercases, strips punctuation, drops stop-words and ticket numbers', () => {
    expect(normalizeTicketTokens('RE: Outlook keeps asking for password #4021'))
      .toEqual(['outlook', 'keeps', 'asking', 'password']);
  });
  it('drops bare numbers, ticket-style ids and duplicates, keeping first-seen order', () => {
    expect(normalizeTicketTokens('FW: Printer offline!!! Printer 42 offline (T-1234)'))
      .toEqual(['printer', 'offline']);
  });
  it('keeps mixed letter/digit tokens such as a KB number', () => {
    expect(normalizeTicketTokens('KB5034441 failed to install')).toEqual(['kb5034441', 'failed', 'install']);
  });
  it('generic filler ("not working", "please help") carries no signal', () => {
    expect(normalizeTicketTokens('Please help - not working')).toEqual([]);
    expect(normalizeTicketTokens('')).toEqual([]);
  });
  it('keeps at most 12 tokens', () => {
    const subject = Array.from({ length: 20 }, (_, i) => `word${String.fromCharCode(97 + i)}`).join(' ');
    expect(normalizeTicketTokens(subject)).toHaveLength(12);
  });
});

describe('jaccard', () => {
  it('is 1 for identical sets and 0 for disjoint ones', () => {
    expect(jaccard(['a', 'b'], ['b', 'a'])).toBe(1);
    expect(jaccard(['a'], ['b'])).toBe(0);
  });
  it('is 0 when either side is empty (no evidence of similarity)', () => {
    expect(jaccard([], [])).toBe(0);
    expect(jaccard(['a'], [])).toBe(0);
  });
  it('treats inputs as sets and computes |A∩B| / |A∪B|', () => {
    expect(jaccard(['a', 'a', 'b'], ['a', 'b'])).toBe(1);
    expect(jaccard(['a', 'b', 'c'], ['b', 'c', 'd'])).toBe(0.5);
  });
});

const OA = '00000000-0000-4000-8000-0000000000c1';
const OB = '00000000-0000-4000-8000-0000000000c2';
const tid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const row = (n: number, orgId: string, subject: string) => ({ id: tid(n), orgId, tokens: normalizeTicketTokens(subject) });

describe('clusterTickets', () => {
  const similar = [
    row(1, OA, 'Outlook keeps asking for password'),
    row(2, OA, 'RE: Outlook asking for password again'),
    row(3, OA, 'Outlook password prompt keeps asking'),
  ];
  const unrelated = [row(4, OA, 'Printer offline in accounting'), row(5, OA, 'New starter laptop setup')];

  it('groups three similar subjects and leaves two unrelated ones alone', () => {
    const out = clusterTickets([...similar, ...unrelated], 3);
    expect(out).toHaveLength(1);
    expect(out[0]!.orgId).toBe(OA);
    expect(out[0]!.ticketIds).toEqual([tid(1), tid(2), tid(3)]);
    expect(out[0]!.tokens).toEqual(expect.arrayContaining(['outlook', 'password', 'asking']));
    expect(out[0]!.tokens.length).toBeLessThanOrEqual(5);
  });

  it('is deterministic under input order', () => {
    const a = clusterTickets([...similar, ...unrelated], 3);
    const b = clusterTickets([...unrelated, ...similar].reverse(), 3);
    expect(b).toEqual(a);
  });

  it('never clusters across orgs and honours minTickets', () => {
    const rows = [row(1, OA, 'VPN down'), row(2, OA, 'VPN down again'), row(3, OB, 'VPN down'), row(4, OB, 'VPN down')];
    expect(clusterTickets(rows, 3)).toEqual([]);
    expect(clusterTickets(rows, 2).map((c) => c.orgId)).toEqual([OA, OB]);
  });

  it('names the cluster by its top-5 tokens: frequency first, then alphabetical', () => {
    const rows = [
      row(1, OA, 'teams outlook onedrive sharepoint login fails'),
      row(2, OA, 'teams outlook onedrive sharepoint login fails'),
      row(3, OA, 'teams outlook onedrive sharepoint login slow'),
    ];
    const [c] = clusterTickets(rows, 3);
    expect(c!.tokens).toEqual(['login', 'onedrive', 'outlook', 'sharepoint', 'teams']);
  });
});

describe('clusterSignature', () => {
  it('is sha256 hex of `${scope}:${sorted tokens}` and stable under token order', () => {
    const expected = createHash('sha256').update(`${OA}:outlook password prompt`).digest('hex');
    expect(clusterSignature(OA, ['password', 'outlook', 'prompt'])).toBe(expected);
    expect(clusterSignature(OA, ['prompt', 'password', 'outlook'])).toBe(expected);
    expect(clusterSignature(OB, ['password', 'outlook', 'prompt'])).not.toBe(expected);
  });
});

describe('ticketClusterParams', () => {
  it('defaults to a 15 minute window and 3 tickets', () => {
    expect(TICKET_CLUSTER_DEFAULT_PARAMS).toEqual({ windowMinutes: 15, minTickets: 3 });
    expect(ticketClusterParams({})).toEqual({ windowMinutes: 15, minTickets: 3 });
  });
  it('clamps to sane bounds and ignores garbage', () => {
    expect(ticketClusterParams({ windowMinutes: 1, minTickets: 1 })).toEqual({ windowMinutes: 5, minTickets: 2 });
    expect(ticketClusterParams({ windowMinutes: 99999, minTickets: 500 })).toEqual({ windowMinutes: 1440, minTickets: 50 });
    expect(ticketClusterParams({ windowMinutes: '30', minTickets: Number.NaN })).toEqual({ windowMinutes: 15, minTickets: 3 });
    expect(ticketClusterParams({ windowMinutes: 30.7, minTickets: 4 })).toEqual({ windowMinutes: 30, minTickets: 4 });
  });
});

describe('pollTicketClusters', () => {
  const PARTNER = '00000000-0000-4000-8000-0000000000d1';
  const GRANT = '00000000-0000-4000-8000-0000000000e1';
  const REV = '00000000-0000-4000-8000-0000000000e2';
  const WATCH = '00000000-0000-4000-8000-0000000000f1';

  type Ticket = { id: string; org_id: string; subject: string; created_at: Date | string };
  type Stored = { id: string; org_id: string; signature: string | null; evidence: Record<string, unknown> };

  let watches: Array<Record<string, unknown>>;
  let tickets: Ticket[];
  let store: Stored[];
  let nextId: number;

  const tag = (q: unknown) => dialect.sqlToQuery(q as Parameters<PgDialect['sqlToQuery']>[0]);
  const queryWith = (marker: string) => h.executes.map((e) => tag(e.query)).find((r) => r.sql.includes(marker));

  const ceiling = (orgIds: string[], o: Record<string, unknown> = {}) => ({
    grantId: GRANT, revisionId: REV, partnerId: PARTNER, grantorUserId: 'user-1', scopeOrgId: null, partnerWide: true,
    orgIds: new Set(orgIds), siteIds: null, permissionKeys: new Set(['*:*']), toolAllowlist: null, deniedTools: new Set(),
    orgTerms: new Map(), status: 'active', ...o,
  });

  beforeEach(() => {
    watches = [{ id: WATCH, org_id: null, grant_id: GRANT, partner_id: PARTNER, current_revision_id: REV, params: {} }];
    tickets = [];
    store = [];
    nextId = 100;
    h.resolveGrantCeiling.mockImplementation(async () => ceiling([OA]));
    h.upsertConcern.mockImplementation(async (input: { orgId: string; signature: string; evidence: Record<string, unknown> }) => {
      const existing = store.find((c) => c.signature === input.signature);
      if (existing) return { id: existing.id, created: false };
      const id = tid(nextId++);
      store.push({ id, org_id: input.orgId, signature: input.signature, evidence: input.evidence });
      return { id, created: true };
    });
    h.updateConcern.mockImplementation(async (id: string, patch: { evidence?: Record<string, unknown> }) => {
      const c = store.find((x) => x.id === id);
      if (c && patch.evidence) c.evidence = patch.evidence;
    });
    h.handler = (q) => {
      const text = tag(q).sql;
      if (text.includes('wisp:cluster-watches')) return watches;
      if (text.includes('wisp:cluster-tickets')) return tickets;
      if (text.includes('wisp:cluster-live')) return store.map((c) => ({ ...c, evidence: structuredClone(c.evidence) }));
      throw new Error(`unexpected query: ${text.slice(0, 80)}`);
    };
  });

  const at = (minAgo: number) => new Date(NOW.getTime() - minAgo * MIN);
  const outlook = (n: number, minAgo: number, orgId = OA): Ticket =>
    ({ id: tid(n), org_id: orgId, subject: `Outlook keeps asking for password #${n}`, created_at: at(minAgo) });

  it('returns zeros without touching the DB when Wisp is off', async () => {
    h.enabled = false;
    await expect(pollTicketClusters(NOW)).resolves.toEqual({ scanned: 0, clustersOpened: 0, clustersUpdated: 0 });
    expect(h.executes).toHaveLength(0);
  });

  it('does nothing past the watch read when no ticket_cluster watch is active', async () => {
    watches = [];
    await expect(pollTicketClusters(NOW)).resolves.toEqual({ scanned: 0, clustersOpened: 0, clustersUpdated: 0 });
    expect(h.executes).toHaveLength(1);
    const q = queryWith('wisp:cluster-watches')!;
    expect(q.sql).toMatch(/kind = 'ticket_cluster'/);
    expect(q.sql).toMatch(/w\.status = 'active'/);
    expect(q.sql).toMatch(/g\.status = 'active'/);
    expect(q.sql).toMatch(/LIMIT/);
  });

  it('opens one concern per cluster with signature, evidence and timestamps the correlator keys on', async () => {
    tickets = [outlook(1, 12), outlook(2, 8), outlook(3, 2),
      { id: tid(4), org_id: OA, subject: 'Printer offline', created_at: at(5) }];
    const res = await pollTicketClusters(NOW);
    expect(res).toEqual({ scanned: 4, clustersOpened: 1, clustersUpdated: 0 });
    expect(h.upsertConcern).toHaveBeenCalledTimes(1);
    const input = h.upsertConcern.mock.calls[0]![0] as Record<string, any>;
    const tokens = input.evidence.tokens as string[];
    expect(input).toMatchObject({
      partnerId: PARTNER,
      orgId: OA,
      subject: { kind: 'incident' },
      severity: 'medium',
      raisedByGrantId: GRANT,
      signature: clusterSignature(OA, tokens),
      summary: `3 similar tickets in 15 min: ${tokens.join(' ')}`,
    });
    expect(input.subject.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(input.evidence).toMatchObject({
      ticketIds: [tid(1), tid(2), tid(3)],
      windowMinutes: 15,
      ticketCount: 3,
      firstSeenAt: NOW.toISOString(),
      lastTicketAt: at(2).toISOString(),
    });
    // Reads in system context; writes happen after the read block returned.
    expect(h.executes.every((e) => e.inSystem)).toBe(true);
    expect(h.writesInsideSystem).toEqual([false]);
  });

  it('updates (never duplicates) the live concern on the next scan and merges new tickets', async () => {
    tickets = [outlook(1, 12), outlook(2, 8), outlook(3, 2)];
    await pollTicketClusters(NOW);
    const later = new Date(NOW.getTime() + 5 * MIN);
    tickets = [outlook(2, 3), outlook(3, 0), outlook(5, -4)];
    const res = await pollTicketClusters(later);
    expect(res).toEqual({ scanned: 3, clustersOpened: 0, clustersUpdated: 1 });
    expect(h.upsertConcern).toHaveBeenCalledTimes(1);
    expect(store).toHaveLength(1);
    const [id, patch] = h.updateConcern.mock.calls[0]! as [string, Record<string, any>];
    expect(id).toBe(store[0]!.id);
    expect(patch.evidence.ticketIds).toEqual([tid(1), tid(2), tid(3), tid(5)]);
    expect(patch.evidence.ticketCount).toBe(4);
    expect(patch.evidence.lastTicketAt).toBe(at(-4).toISOString());
    expect(patch.evidence.firstSeenAt).toBe(NOW.toISOString());
    expect(patch.summary).toMatch(/^4 similar tickets/);
  });

  it('a rescan with nothing new writes nothing (no updated_at churn)', async () => {
    tickets = [outlook(1, 12), outlook(2, 8), outlook(3, 2)];
    await pollTicketClusters(NOW);
    const res = await pollTicketClusters(NOW);
    expect(res).toEqual({ scanned: 3, clustersOpened: 0, clustersUpdated: 0 });
    expect(h.updateConcern).not.toHaveBeenCalled();
  });

  it('merges into a live concern that shares tickets even when the top tokens drifted', async () => {
    store.push({
      id: tid(900), org_id: OA, signature: 'old-signature',
      evidence: { ticketIds: [tid(1)], tokens: ['outlook', 'password'], ticketCount: 1, lastTicketAt: at(30).toISOString(), firstSeenAt: at(30).toISOString(), windowMinutes: 15 },
    });
    tickets = [outlook(1, 12), outlook(2, 8), outlook(3, 2)];
    const res = await pollTicketClusters(NOW);
    expect(res).toMatchObject({ clustersOpened: 0, clustersUpdated: 1 });
    expect(h.upsertConcern).not.toHaveBeenCalled();
    expect(h.updateConcern.mock.calls[0]![0]).toBe(tid(900));
  });

  it('a signature race (created: false) merges into the winner', async () => {
    tickets = [outlook(1, 12), outlook(2, 8), outlook(3, 2)];
    h.upsertConcern.mockImplementationOnce(async () => {
      store.push({ id: tid(901), org_id: OA, signature: 'x', evidence: { ticketIds: [tid(7)], ticketCount: 1, tokens: ['outlook'] } });
      return { id: tid(901), created: false };
    });
    const res = await pollTicketClusters(NOW);
    expect(res).toMatchObject({ clustersOpened: 0, clustersUpdated: 1 });
    const [id, patch] = h.updateConcern.mock.calls[0]! as [string, Record<string, any>];
    expect(id).toBe(tid(901));
    expect(patch.evidence.ticketIds).toEqual([tid(7), tid(1), tid(2), tid(3)]);
  });

  it('caps the merged ticket list at 200, keeping the newest', async () => {
    const old = Array.from({ length: 200 }, (_, i) => tid(1000 + i));
    store.push({ id: tid(902), org_id: OA, signature: clusterSignature(OA, ['outlook', 'keeps', 'asking', 'password']), evidence: { ticketIds: old, tokens: ['outlook', 'password'], ticketCount: 200 } });
    tickets = [outlook(1, 12), outlook(2, 8), outlook(3, 2)];
    await pollTicketClusters(NOW);
    const patch = h.updateConcern.mock.calls[0]![1] as Record<string, any>;
    expect(patch.evidence.ticketIds).toHaveLength(200);
    expect(patch.evidence.ticketIds.slice(-3)).toEqual([tid(1), tid(2), tid(3)]);
    expect(patch.evidence.ticketCount).toBe(203);
  });

  it('a partner-wide watch expands to every org in the ceiling; the ticket query is windowed and bounded', async () => {
    h.resolveGrantCeiling.mockImplementation(async () => ceiling([OA, OB]));
    watches = [{ ...watches[0]!, params: { windowMinutes: 30, minTickets: 2 } }];
    await pollTicketClusters(NOW);
    expect(h.resolveGrantCeiling).toHaveBeenCalledWith(GRANT, REV);
    const q = queryWith('wisp:cluster-tickets')!;
    expect(q.params).toEqual(expect.arrayContaining([OA, OB, at(30).toISOString(), NOW.toISOString(), 500]));
    expect(q.sql).toMatch(/JOIN tickets t/);
    expect(q.sql).toMatch(/t\.status <> 'closed'/);
    expect(q.sql).toMatch(/t\.deleted_at IS NULL/);
    expect(q.sql).toMatch(/t\.merged_into_ticket_id IS NULL/);
    expect(q.sql).toMatch(/t\.migration_window_id IS NULL/);
    expect(q.sql).toMatch(/row_number\(\) OVER \(PARTITION BY t\.org_id/);
  });

  it('never scans an org the grant reaches only through a site restriction', async () => {
    h.resolveGrantCeiling.mockImplementation(async () => ceiling([OA, OB], {
      orgTerms: new Map([[OB, { permissionKeys: new Set(['*:*']), siteIds: new Set(['site-1']) }]]),
    }));
    watches = [{ ...watches[0]!, org_id: null }];
    await pollTicketClusters(NOW);
    const q = queryWith('wisp:cluster-tickets')!;
    expect(q.params).toContain(OA);
    expect(q.params).not.toContain(OB);

    h.executes = [];
    h.resolveGrantCeiling.mockImplementation(async () => ceiling([OA, OB], { siteIds: new Set(['site-1']) }));
    await expect(pollTicketClusters(NOW)).resolves.toEqual({ scanned: 0, clustersOpened: 0, clustersUpdated: 0 });
    expect(queryWith('wisp:cluster-tickets')).toBeUndefined();
  });

  it('scans only orgs where the grant holds tickets:read (the summary quotes ticket subjects)', async () => {
    // Ceiling-wide: no tickets:read at all → nothing is scanned, nothing is captured.
    h.resolveGrantCeiling.mockImplementation(async () => ceiling([OA, OB], { permissionKeys: new Set(['devices:read', 'alerts:*']) }));
    await expect(pollTicketClusters(NOW)).resolves.toEqual({ scanned: 0, clustersOpened: 0, clustersUpdated: 0 });
    expect(queryWith('wisp:cluster-tickets')).toBeUndefined();
    expect(h.captureException).not.toHaveBeenCalled();

    // Per org: OB's membership term lacks tickets:read → only OA is scanned.
    h.executes = [];
    h.resolveGrantCeiling.mockImplementation(async () => ceiling([OA, OB], {
      permissionKeys: new Set(['tickets:read', 'devices:read']),
      orgTerms: new Map([[OB, { permissionKeys: new Set(['devices:read']), siteIds: null }]]),
    }));
    await pollTicketClusters(NOW);
    const q = queryWith('wisp:cluster-tickets')!;
    expect(q.params).toContain(OA);
    expect(q.params).not.toContain(OB);

    // An org-scoped watch on an org without tickets:read scans nothing.
    h.executes = [];
    watches = [{ ...watches[0]!, org_id: OB }];
    await expect(pollTicketClusters(NOW)).resolves.toEqual({ scanned: 0, clustersOpened: 0, clustersUpdated: 0 });
    expect(queryWith('wisp:cluster-tickets')).toBeUndefined();
  });

  it('honours opts.limit as the per-org ticket bound', async () => {
    await pollTicketClusters(NOW, { limit: 50 });
    expect(queryWith('wisp:cluster-tickets')!.params).toContain(50);
  });

  it('skips an org-scoped watch whose org left the ceiling, and an inactive grant', async () => {
    watches = [{ ...watches[0]!, org_id: OB }];
    await expect(pollTicketClusters(NOW)).resolves.toEqual({ scanned: 0, clustersOpened: 0, clustersUpdated: 0 });
    expect(queryWith('wisp:cluster-tickets')).toBeUndefined();

    h.executes = [];
    watches = [{ ...watches[0]!, org_id: null }];
    h.resolveGrantCeiling.mockImplementation(async () => { throw new GrantInactiveError(GRANT, 'paused'); });
    await expect(pollTicketClusters(NOW)).resolves.toEqual({ scanned: 0, clustersOpened: 0, clustersUpdated: 0 });
    expect(queryWith('wisp:cluster-tickets')).toBeUndefined();
    expect(h.captureException).not.toHaveBeenCalled();
  });

  it('a failing write is captured and the scan goes on', async () => {
    h.resolveGrantCeiling.mockImplementation(async () => ceiling([OA, OB]));
    tickets = [outlook(1, 12), outlook(2, 8), outlook(3, 2), outlook(11, 12, OB), outlook(12, 8, OB), outlook(13, 2, OB)];
    h.upsertConcern.mockImplementationOnce(async () => { throw new Error('db down'); });
    const res = await pollTicketClusters(NOW);
    expect(res).toMatchObject({ scanned: 6, clustersOpened: 1 });
    expect(h.captureException).toHaveBeenCalledTimes(1);
  });

  it('reads naive timestamp text from the driver as UTC', async () => {
    tickets = [outlook(1, 12), outlook(2, 8), { ...outlook(3, 2), created_at: '2026-10-24 11:58:00' }];
    await pollTicketClusters(NOW);
    const input = h.upsertConcern.mock.calls[0]![0] as Record<string, any>;
    expect(input.evidence.lastTicketAt).toBe('2026-10-24T11:58:00.000Z');
  });
});
