/**
 * Integration test — `search_logs` keyset pagination against real Postgres
 * (regression guard for #3329).
 *
 * The keyset predicate used to be a hand-written Drizzle `sql` template that
 * interpolated the cursor's JS `Date` directly. A bare value inside a `sql`
 * template is bound with the NOOP encoder, so postgres.js received a `Date`
 * object at its Bind step and threw
 * `ERR_INVALID_ARG_TYPE ... Received an instance of Date`. No mock reproduces
 * this — the failure is in the driver's own type coercion, not in Drizzle's
 * query-building or in application logic. The fix (`buildLogSearchKeysetCondition`
 * in `services/logSearch.ts`) routes the comparison through Drizzle's typed
 * `lt`/`gt`/`eq` helpers instead, which serialize through the column's own
 * encoder.
 *
 * This file proves, against a real DB connection as the unprivileged
 * `breeze_app` role (the same path production request handlers use via
 * `withDbAccessContext`):
 *   1. Paging with a cursor `searchFleetLogs` itself issued resolves, not
 *      throws — this alone fails on the pre-fix code.
 *   2. A full keyset walk (limit=4) over ~25 seeded rows exactly reproduces
 *      a single unpaginated query's order — no gaps, no duplicates.
 *   3. The uuid tiebreaker: a tie group of 3 rows sharing an identical
 *      `timestamp` is split across a page boundary, and paging still walks
 *      through it correctly. The fix removed an explicit `cast(... as uuid)`
 *      from the old code, so this proves the id comparison still resolves as
 *      uuid against the live driver. The test also asserts the tie group
 *      really was split across a page boundary (not merely present) — if it
 *      landed entirely within one page, dropping the tiebreaker would go
 *      undetected.
 *   4. Both `sortOrder: 'desc'` (default) and `sortOrder: 'asc'`.
 *
 * Run:
 *   pnpm test:integration -- src/__tests__/integration/logSearchCursor.integration.test.ts
 */
import './setup';

import { describe, it, expect } from 'vitest';
import { getTestDb } from './setup';
import { withDbAccessContext, type DbAccessContext } from '../../db';
import { deviceEventLogs, devices } from '../../db/schema';
import { createPartner, createOrganization, createSite } from './db-utils';
import { searchFleetLogs } from '../../services/logSearch';
import { buildOrgAccessClosures, type AuthContext } from '../../middleware/auth';

// Wide enough to contain every timestamp seeded below without relying on the
// default 24h window.
const WIDE_TIME_RANGE = {
  start: '2020-01-01T00:00:00.000Z',
  end: '2030-01-01T00:00:00.000Z',
};

async function seedFixture() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const [device] = await getTestDb()
    .insert(devices)
    .values({
      orgId: org.id,
      siteId: site.id,
      agentId: `agent-${org.id}`,
      hostname: `host-${org.id.slice(0, 8)}`,
      osType: 'linux',
      osVersion: '1.0',
      architecture: 'amd64',
      agentVersion: '1.0.0',
      status: 'online',
    })
    .returning();
  if (!device) throw new Error('seedFixture: device insert returned no row');
  return { partner, org, site, device };
}

// Distinct `source` per row so seeded rows never collide with the
// device_event_logs_dedup_idx unique index on (device_id, source, event_id) —
// eventId is left null on every row.
async function seedLog(opts: {
  orgId: string;
  deviceId: string;
  timestamp: Date;
  source: string;
}) {
  const [row] = await getTestDb()
    .insert(deviceEventLogs)
    .values({
      deviceId: opts.deviceId,
      orgId: opts.orgId,
      timestamp: opts.timestamp,
      level: 'info',
      category: 'system',
      source: opts.source,
      message: `msg-${opts.source}`,
    })
    .returning();
  if (!row) throw new Error('seedLog: insert returned no row');
  return row;
}

function makeAuth(orgId: string): AuthContext {
  const { orgCondition, canAccessOrg } = buildOrgAccessClosures([orgId]);
  return {
    principal: 'user',
    user: { id: '00000000-0000-0000-0000-0000000000aa', email: 'op@example.com', name: 'Op', isPlatformAdmin: false },
    token: {} as unknown as AuthContext['token'],
    partnerId: null,
    orgId,
    scope: 'organization',
    accessibleOrgIds: [orgId],
    orgCondition,
    canAccessOrg,
  } as unknown as AuthContext;
}

function ctxFor(orgId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: null,
    userId: null,
  };
}

// Postgres compares `uuid` columns byte-by-byte in the order the bytes appear
// in the canonical lowercase hex text (no re-ordering, unlike e.g. Windows
// mixed-endian GUIDs), so a plain string `<`/`>` comparison on the ids
// returned by the driver reproduces the same ordering as the DB's own id
// tiebreaker.
function compareIdsAsc(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

describe('search_logs keyset pagination — real Postgres (#3329)', () => {
  it('resolves (not throws) when paging with a cursor the service itself issued', async () => {
    const { org, device } = await seedFixture();
    const base = new Date('2026-01-01T00:00:00.000Z');
    for (let i = 0; i < 5; i++) {
      await seedLog({ orgId: org.id, deviceId: device.id, timestamp: new Date(base.getTime() + i * 1000), source: `regress-${i}` });
    }
    const auth = makeAuth(org.id);

    const first = await withDbAccessContext(ctxFor(org.id), () =>
      searchFleetLogs(auth, { limit: 2, timeRange: WIDE_TIME_RANGE, countMode: 'none' }),
    );
    expect(first.nextCursor).not.toBeNull();

    // THE regression: on the pre-fix code this rejects with
    // ERR_INVALID_ARG_TYPE from postgres.js's Bind step. It must resolve.
    await expect(
      withDbAccessContext(ctxFor(org.id), () =>
        searchFleetLogs(auth, {
          limit: 2,
          timeRange: WIDE_TIME_RANGE,
          countMode: 'none',
          cursor: first.nextCursor!,
        }),
      ),
    ).resolves.toBeDefined();
  });

  it('full keyset walk (limit=4) exactly matches an unpaginated query — no gaps, no duplicates (desc + asc)', async () => {
    const { org, device } = await seedFixture();
    const base = new Date('2026-02-01T00:00:00.000Z');
    const total = 25;
    for (let i = 0; i < total; i++) {
      await seedLog({
        orgId: org.id,
        deviceId: device.id,
        timestamp: new Date(base.getTime() + i * 60_000),
        source: `walk-${i}`,
      });
    }
    const auth = makeAuth(org.id);

    for (const sortOrder of ['desc', 'asc'] as const) {
      const unpaginated = await withDbAccessContext(ctxFor(org.id), () =>
        searchFleetLogs(auth, { limit: 1000, timeRange: WIDE_TIME_RANGE, countMode: 'none', sortOrder }),
      );
      expect(unpaginated.results).toHaveLength(total);
      const expectedIds = unpaginated.results.map((r) => r.log.id);

      const walked: string[] = [];
      let cursor: string | undefined;
      let steps = 0;
      const MAX_STEPS = total + 2; // generous guard against an infinite loop on a real bug
      while (steps < MAX_STEPS) {
        steps++;
        const page = await withDbAccessContext(ctxFor(org.id), () =>
          searchFleetLogs(auth, { limit: 4, timeRange: WIDE_TIME_RANGE, countMode: 'none', sortOrder, cursor }),
        );
        for (const r of page.results) walked.push(r.log.id);
        if (!page.hasMore) {
          expect(page.nextCursor).toBeNull();
          break;
        }
        expect(page.nextCursor).not.toBeNull();
        cursor = page.nextCursor!;
      }

      expect(steps).toBeLessThan(MAX_STEPS); // walk actually terminated via hasMore=false
      expect(walked).toEqual(expectedIds); // same order, no gaps, no dupes
      expect(new Set(walked).size).toBe(total);
    }
  });

  it('uuid tiebreaker: paging continues correctly through a tie group split across a page boundary (desc + asc)', async () => {
    const { org, device } = await seedFixture();
    const tieTime = new Date('2026-03-01T12:00:00.000Z');
    const earlierTime = new Date(tieTime.getTime() - 10_000);
    const laterTime = new Date(tieTime.getTime() + 10_000);

    const earlier = await seedLog({ orgId: org.id, deviceId: device.id, timestamp: earlierTime, source: 'tie-earlier' });
    const tieRows = [];
    for (let i = 0; i < 3; i++) {
      tieRows.push(await seedLog({ orgId: org.id, deviceId: device.id, timestamp: tieTime, source: `tie-${i}` }));
    }
    const later = await seedLog({ orgId: org.id, deviceId: device.id, timestamp: laterTime, source: 'tie-later' });

    // Sanity: the tie group must genuinely share an identical timestamp AS
    // ROUND-TRIPPED THROUGH POSTGRES, or the "split across a page boundary"
    // premise below is untested.
    const tieTimestampValues = new Set(tieRows.map((r) => r.timestamp.getTime()));
    expect(tieTimestampValues.size).toBe(1);

    const auth = makeAuth(org.id);

    for (const sortOrder of ['desc', 'asc'] as const) {
      const tieSortedIds = tieRows
        .map((r) => r.id)
        .sort((a, b) => (sortOrder === 'desc' ? compareIdsAsc(b, a) : compareIdsAsc(a, b)));

      const expectedOrder = sortOrder === 'desc'
        ? [later.id, ...tieSortedIds, earlier.id]
        : [earlier.id, ...tieSortedIds, later.id];

      // limit=2 over 5 rows guarantees at least one page boundary falls
      // strictly inside the 3-row tie group.
      const walked: string[] = [];
      let cursor: string | undefined;
      let sawBoundaryInsideTieGroup = false;
      let steps = 0;
      const MAX_STEPS = 8;
      while (steps < MAX_STEPS) {
        steps++;
        const page = await withDbAccessContext(ctxFor(org.id), () =>
          searchFleetLogs(auth, { limit: 2, timeRange: WIDE_TIME_RANGE, countMode: 'none', sortOrder, cursor }),
        );
        const pageIds = page.results.map((r) => r.log.id);
        if (pageIds.length > 0) {
          const lastIdOnPage = pageIds[pageIds.length - 1]!;
          // The page boundary lands INSIDE the tie group when the last row
          // on this page is a tie-group member that is not the tie group's
          // own last element in sort order (i.e. at least one more tied row
          // remains for the next page to serve).
          if (tieSortedIds.includes(lastIdOnPage) && lastIdOnPage !== tieSortedIds[tieSortedIds.length - 1]) {
            sawBoundaryInsideTieGroup = true;
          }
        }
        walked.push(...pageIds);
        if (!page.hasMore) {
          expect(page.nextCursor).toBeNull();
          break;
        }
        expect(page.nextCursor).not.toBeNull();
        cursor = page.nextCursor!;
      }

      expect(steps).toBeLessThan(MAX_STEPS);
      // If this is ever false, the test fixture stopped exercising the
      // boundary-inside-a-tie-group scenario and the assertion below would
      // no longer be able to catch a dropped tiebreaker.
      expect(sawBoundaryInsideTieGroup).toBe(true);
      // Without the uuid tiebreaker, the keyset predicate degrades to
      // `timestamp < cursor.timestamp` alone, which would skip every
      // remaining tied row once the cursor's own timestamp equals the tie
      // value — collapsing this to a 3-element list missing the tied rows
      // that were still due. Exact-order equality catches that.
      expect(walked).toEqual(expectedOrder);
    }
  });
});
