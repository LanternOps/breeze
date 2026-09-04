import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// Tracks how many times the count(*) query (db.select({ count })...where()) is
// issued, so tests can prove the unbounded count is skipped unless withTotal is
// set. The count select is distinguishable from the row select by its shape:
// the count projection has a `count` key; the row projection does not.
const countQueryCalls = vi.fn();
// Captures the WHERE condition handed to the feed query so tests can prove the
// org_id scoping is present (BREEZE-B — it is load-bearing for performance, not
// cosmetic; see the comment in events.ts).
const feedWhereArgs: unknown[] = [];

vi.mock('../../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn((projection?: Record<string, unknown>) => ({
      from: vi.fn(() => ({
        leftJoin: vi.fn(() => ({
          where: vi.fn((cond: unknown) => {
            feedWhereArgs.push(cond);
            return {
              orderBy: vi.fn(() => ({
                // Each feed arm is a bounded `limit(offset + limit)` read; the
                // page is cut client-side by mergeFeedPage. No `.offset()`.
                limit: vi.fn().mockResolvedValue([])
              }))
            };
          })
        })),
        where: vi.fn(() => {
          if (projection && 'count' in projection) countQueryCalls();
          return Promise.resolve([{ count: 0 }]);
        }),
      }))
    })),
  }
}));

vi.mock('../../db/schema', () => ({
  auditLogs: {
    id: 'id',
    orgId: 'org_id',
    timestamp: 'timestamp',
    action: 'action',
    actorType: 'actor_type',
    actorEmail: 'actor_email',
    actorId: 'actor_id',
    resourceType: 'resource_type',
    resourceId: 'resource_id',
    resourceName: 'resource_name',
    result: 'result',
    details: 'details',
    errorMessage: 'error_message',
    ipAddress: 'ip_address',
    initiatedBy: 'initiated_by',
  },
  users: { id: 'id', name: 'name' },
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      scope: 'organization',
      orgId: 'org-123',
      partnerId: null,
      user: { id: 'user-123', email: 't@example.com' }
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  requirePermission: vi.fn((resource: string, action: string) => async (c: any, next: any) => {
    if (resource === 'devices' && action === 'read' && c.req.header('x-deny-devices-read') === 'true') {
      return c.json({ error: 'Permission denied' }, 403);
    }
    return next();
  }),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
}));

vi.mock('./helpers', () => ({
  getDeviceWithOrgCheck: vi.fn().mockResolvedValue({ id: '11111111-1111-1111-1111-111111111111', orgId: 'org-123' }),
  getDeviceWithOrgAndSiteCheck: vi.fn().mockResolvedValue({ id: '11111111-1111-1111-1111-111111111111', orgId: 'org-123', siteId: 'site-1' }),
  SITE_ACCESS_DENIED: Symbol('SITE_ACCESS_DENIED'),
}));

import { eventsRoutes, likePrefixPattern, formatActionMessage, mergeFeedPage } from './events';

describe('likePrefixPattern (action-prefix LIKE escaping)', () => {
  it('appends a trailing wildcard for a clean dotted prefix', () => {
    expect(likePrefixPattern('device.command')).toBe('device.command%');
  });

  it('escapes LIKE metacharacters so they match literally', () => {
    // `_` and `%` would otherwise act as wildcards.
    expect(likePrefixPattern('device_x')).toBe('device\\_x%');
    expect(likePrefixPattern('a%b')).toBe('a\\%b%');
    expect(likePrefixPattern('back\\slash')).toBe('back\\\\slash%');
  });

  it('escapes all metacharacters in a single value', () => {
    expect(likePrefixPattern('a_b%c\\d')).toBe('a\\_b\\%c\\\\d%');
  });
});

describe('formatActionMessage (automated command labels)', () => {
  // #4225: these rows are written at DISPATCH time (commandQueue.ts), before
  // the agent has reported back, so the label must not claim completion and
  // the audit row's `result` must not claim 'success'.
  it('labels automated patch installs in dispatch tense, not completed tense, with no suffix for the neutral result', () => {
    expect(formatActionMessage('agent.command.install_patches', 'host-1', 'dispatched'))
      .toBe('Patch install command sent — host-1');
  });

  it('labels automated script runs', () => {
    expect(formatActionMessage('agent.command.script', null, 'dispatched'))
      .toBe('Script run command sent');
  });

  it('still marks a failed automated command explicitly', () => {
    expect(formatActionMessage('agent.command.install_patches', 'host-1', 'failure'))
      .toBe('Patch install command sent — host-1 (failed)');
  });

  it('labels rollback, uninstall, and update', () => {
    expect(formatActionMessage('agent.command.rollback_patches', null, 'dispatched')).toBe('Patch rollback command sent');
    expect(formatActionMessage('agent.command.software_uninstall', null, 'dispatched')).toBe('Software uninstall command sent');
    expect(formatActionMessage('agent.command.software_update', null, 'dispatched')).toBe('Software update command sent');
  });
});

describe('GET /devices/:id/events validation', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/devices', eventsRoutes);
  });

  it('rejects non-UUID device id with 400', async () => {
    const res = await app.request('/devices/not-a-uuid/events', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' }
    });
    expect(res.status).toBe(400);
  });

  it('rejects invalid result query value with 400', async () => {
    const res = await app.request('/devices/11111111-1111-1111-1111-111111111111/events?result=bogus', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' }
    });
    expect(res.status).toBe(400);
  });

  it('rejects invalid category with 400', async () => {
    const res = await app.request('/devices/11111111-1111-1111-1111-111111111111/events?category=not-a-category', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' }
    });
    expect(res.status).toBe(400);
  });

  it('rejects limit over 200 with 400', async () => {
    const res = await app.request('/devices/11111111-1111-1111-1111-111111111111/events?limit=9999', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' }
    });
    expect(res.status).toBe(400);
  });

  it('accepts a fully valid query', async () => {
    const res = await app.request(
      '/devices/11111111-1111-1111-1111-111111111111/events?result=success&category=device&limit=25&page=1',
      { method: 'GET', headers: { Authorization: 'Bearer token' } }
    );
    expect(res.status).toBe(200);
  });

  it('accepts an actions prefix filter', async () => {
    const res = await app.request(
      '/devices/11111111-1111-1111-1111-111111111111/events?actions=device.command,script.,device.patch&limit=10',
      { method: 'GET', headers: { Authorization: 'Bearer token' } }
    );
    expect(res.status).toBe(200);
  });

  it('treats an empty / whitespace-only actions value as no filter (200, no empty OR)', async () => {
    // The transform splits, trims, and drops empties; the handler guards on a
    // non-empty array, so these must not build an empty or(...) (which throws).
    for (const value of ['', ',,,', '%20%20']) {
      const res = await app.request(
        `/devices/11111111-1111-1111-1111-111111111111/events?actions=${value}&limit=10`,
        { method: 'GET', headers: { Authorization: 'Bearer token' } }
      );
      expect(res.status).toBe(200);
    }
  });

  it('accepts includeAutomated=true', async () => {
    const res = await app.request(
      '/devices/11111111-1111-1111-1111-111111111111/events?includeAutomated=true',
      { method: 'GET', headers: { Authorization: 'Bearer token' } }
    );
    expect(res.status).toBe(200);
  });

  it('accepts includeAutomated=false', async () => {
    const res = await app.request(
      '/devices/11111111-1111-1111-1111-111111111111/events?includeAutomated=false',
      { method: 'GET', headers: { Authorization: 'Bearer token' } }
    );
    expect(res.status).toBe(200);
  });

  it('rejects an invalid includeAutomated value with 400', async () => {
    const res = await app.request(
      '/devices/11111111-1111-1111-1111-111111111111/events?includeAutomated=maybe',
      { method: 'GET', headers: { Authorization: 'Bearer token' } }
    );
    expect(res.status).toBe(400);
  });

  it('rejects an actions value over 500 chars with 400', async () => {
    const long = 'a.'.repeat(300); // 600 chars
    const res = await app.request(
      `/devices/11111111-1111-1111-1111-111111111111/events?actions=${long}`,
      { method: 'GET', headers: { Authorization: 'Bearer token' } }
    );
    expect(res.status).toBe(400);
  });

  it('omits the total count by default and does NOT run the count(*) query', async () => {
    const res = await app.request('/devices/11111111-1111-1111-1111-111111111111/events?limit=10', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { pagination: { total: number | null } };
    expect(json.pagination.total).toBeNull();
    // The whole point of #1726: the unbounded count(*) must not run by default.
    expect(countQueryCalls).not.toHaveBeenCalled();
  });

  it('includes a numeric total and runs the count(*) query when withTotal=true', async () => {
    const res = await app.request(
      '/devices/11111111-1111-1111-1111-111111111111/events?limit=10&withTotal=true',
      { method: 'GET', headers: { Authorization: 'Bearer token' } }
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { pagination: { total: number | null } };
    expect(json.pagination.total).toBe(0);
    // One count per feed arm (resource arm + details arm), summed.
    expect(countQueryCalls).toHaveBeenCalledTimes(2);
  });

  it('rejects an invalid withTotal value with 400', async () => {
    const res = await app.request(
      '/devices/11111111-1111-1111-1111-111111111111/events?withTotal=maybe',
      { method: 'GET', headers: { Authorization: 'Bearer token' } }
    );
    expect(res.status).toBe(400);
  });
});

describe("GET /devices/:id/events — org scoping of the audit feed (BREEZE-B)", () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    feedWhereArgs.length = 0;
    app = new Hono();
    app.route('/devices', eventsRoutes);
  });

  it("filters on the device's org_id so the scan can use audit_logs_org_timestamp_idx", async () => {
    const res = await app.request(
      '/devices/11111111-1111-1111-1111-111111111111/events',
      { method: 'GET', headers: { Authorization: 'Bearer token' } }
    );
    expect(res.status).toBe(200);

    // Without this predicate the feed query cannot use ANY index under RLS: the
    // `details->>'deviceId'` arm is non-leakproof so Postgres may not evaluate
    // it before the security qual, which makes its expression index unusable
    // and forces a full scan (measured 11,938ms on 800k rows vs 178ms with
    // this predicate). Assert the org column and the device's org id are both
    // in the WHERE, so removing the scoping fails here rather than silently
    // regressing to a seq scan in production.
    expect(feedWhereArgs).toHaveLength(2);
    for (const arm of feedWhereArgs) {
      const serialized = JSON.stringify(arm);
      expect(serialized).toContain('org_id');
      expect(serialized).toContain('org-123');
    }
  });
});

// The feed runs as breeze_app under forced RLS, where only leakproof clauses
// can become index conditions. These tests pin the SHAPE of each arm's WHERE so
// a refactor cannot quietly re-merge the arms into the one-query form that
// walked the whole org (2.4M rows, 13-minute page loads on US, 2026-09-03).
// The runtime proof that the shapes actually hit the partial indexes lives in
// __tests__/integration/deviceEventsFeedIndexes.integration.test.ts.
describe('GET /devices/:id/events — two-arm feed predicate (RLS index promotability)', () => {
  let app: Hono;
  const DEVICE = '11111111-1111-1111-1111-111111111111';

  beforeEach(() => {
    vi.clearAllMocks();
    feedWhereArgs.length = 0;
    app = new Hono();
    app.route('/devices', eventsRoutes);
  });

  async function arms(query: string) {
    const res = await app.request(`/devices/${DEVICE}/events${query}`, {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });
    expect(res.status).toBe(200);
    expect(feedWhereArgs).toHaveLength(2);
    return {
      resource: JSON.stringify(feedWhereArgs[0]),
      details: JSON.stringify(feedWhereArgs[1]),
    };
  }

  it('resource arm keys on resource_id only — never the non-leakproof details->>deviceId', async () => {
    const { resource } = await arms('');
    expect(resource).toContain('resource_id');
    expect(resource).not.toContain("->>'deviceId'");
  });

  it('details arm carries the JSONB key test (the partial-index predicate), the equality, and the disjointness guard', async () => {
    const { details } = await arms('');
    expect(details).toContain("? 'deviceId'");
    expect(details).toContain("->>'deviceId'");
    expect(details).toContain('IS DISTINCT FROM');
    // Unfiltered feed: no actor is excluded from either arm (old OR semantics).
    expect(details).not.toContain("<> 'agent'");
  });

  it('unfiltered Activities feed keeps agent rows in the resource arm (no actor exclusion)', async () => {
    const { resource } = await arms('?limit=50&withTotal=true');
    expect(resource).not.toContain("<> 'agent'");
  });

  it('deliberate-action feed adds actor_type <> agent to both arms (partial index on the resource arm)', async () => {
    const { resource, details } = await arms('?actions=script.,device.command&includeAutomated=true');
    expect(resource).toContain("<> 'agent'");
    expect(resource).toContain('LIKE');
    expect(details).toContain("<> 'agent'");
  });

  it('includeAutomated alone also counts as the deliberate feed', async () => {
    const { resource } = await arms('?includeAutomated=true');
    expect(resource).toContain("<> 'agent'");
    // The automated arm is system-only; the agent's own command-result rows
    // are telemetry.
    expect(resource).toContain("= 'system'");
    expect(resource).not.toContain("'agent')");
  });
});

describe('mergeFeedPage (two-arm page merge)', () => {
  // sortKey mirrors FEED_SORT_KEY: to_char(timestamp, 'YYYYMMDDHH24MISSUS').
  const row = (id: string, sortKey: string) => ({ id, sortKey });

  it('interleaves both arms newest-first and cuts the page', () => {
    const a = [row('a3', '20260103000000000000'), row('a1', '20260101000000000000')];
    const b = [row('b2', '20260102000000000000')];
    expect(mergeFeedPage(a, b, 0, 10).map((r) => r.id)).toEqual(['a3', 'b2', 'a1']);
    expect(mergeFeedPage(a, b, 1, 1).map((r) => r.id)).toEqual(['b2']);
    expect(mergeFeedPage(a, b, 2, 5).map((r) => r.id)).toEqual(['a1']);
  });

  it('orders by the microsecond key, not the millisecond Date, so it matches SQL', () => {
    // Same millisecond (…123ms), different microseconds: SQL puts the later
    // microsecond first. A Date-based merge would see a tie and fall through to
    // the id tiebreak, putting 'zzzz' first — wrong.
    const a = [row('zzzz', '20260101000000123400')];
    const b = [row('aaaa', '20260101000000123900')];
    expect(mergeFeedPage(a, b, 0, 10).map((r) => r.id)).toEqual(['aaaa', 'zzzz']);
  });

  it('breaks exact timestamp ties by id DESC, matching the SQL ORDER BY', () => {
    const a = [row('aaaa', '20260101000000000000')];
    const b = [row('bbbb', '20260101000000000000')];
    expect(mergeFeedPage(a, b, 0, 10).map((r) => r.id)).toEqual(['bbbb', 'aaaa']);
  });

  it('applies the offset even when one arm is empty', () => {
    const a = [row('a3', '20260103000000000000'), row('a2', '20260102000000000000'), row('a1', '20260101000000000000')];
    expect(mergeFeedPage(a, [], 1, 1).map((r) => r.id)).toEqual(['a2']);
    expect(mergeFeedPage([], a, 2, 5).map((r) => r.id)).toEqual(['a1']);
  });
});
