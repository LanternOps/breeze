/**
 * Real-Postgres proof for the two raw-SQL fragments introduced by #3770's
 * fix to GET /mobile/alerts/inbox and GET /mobile/devices
 * (apps/api/src/routes/mobile.ts).
 *
 * apps/api/src/routes/mobile.test.ts already covers the route's BEHAVIOR
 * (nextCursor reachability, ordering-mode split, response shape) against a
 * mocked `db.select` — but a mock cannot catch a typo in a `to_char` format
 * string, an invalid `::timestamp`/`::uuid` cast, or Postgres's actual tuple-
 * comparison / NULL-ordering semantics; it would happily return whatever rows
 * the test tells it to. This file executes the SAME query fragments the
 * route builds (select projection, cursor predicate, ORDER BY) against a
 * real table, so a cast or syntax mistake fails here instead of in
 * production. See `devicesCursorRls.integration.test.ts` for the identical
 * rationale applied to routes/devices/core.ts's cursor.
 *
 * Prerequisites:
 *   docker compose -f docker-compose.test.yml up -d
 *
 * Run:
 *   pnpm test:integration -- src/__tests__/integration/mobileCursorPagination.integration.test.ts
 */
import './setup';

import { describe, it, expect } from 'vitest';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { getTestDb } from './setup';
import { alerts, devices } from '../../db/schema';
import { createOrganization, createPartner, createSite } from './db-utils';
import { encodeCursor, decodeCursor, decodeTimestampCursor } from '../../routes/mobile';

let agentIdCounter = 0;
async function insertDevice(opts: { orgId: string; siteId: string; hostname: string }): Promise<string> {
  const db = getTestDb();
  agentIdCounter++;
  const [row] = await db
    .insert(devices)
    .values({
      orgId: opts.orgId,
      siteId: opts.siteId,
      agentId: `agent-mobile-cursor-${agentIdCounter}-${Date.now()}`,
      hostname: opts.hostname,
      displayName: opts.hostname,
      osType: 'windows',
      osVersion: '11',
      osBuild: '22000',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      status: 'online',
      enrolledAt: new Date(),
    })
    .returning({ id: devices.id });
  if (!row) throw new Error('insertDevice: insert returned no row');
  return row.id;
}

/**
 * Insert an alert with a `triggered_at` carrying a specific fractional-second
 * suffix (up to 6 digits) that a JS `Date` cannot represent — using raw SQL
 * rather than Drizzle's `.values({ triggeredAt: someDate })`, because a plain
 * `Date` object can only ever contribute millisecond precision. That's the
 * whole point of this test: proving the fix survives the values a `Date`
 * cannot even construct.
 */
async function insertAlertAt(opts: { orgId: string; deviceId: string; triggeredAt: string }): Promise<string> {
  const db = getTestDb();
  const rows = await db.execute<{ id: string }>(sql`
    INSERT INTO alerts (device_id, org_id, severity, title, triggered_at)
    VALUES (${opts.deviceId}, ${opts.orgId}, 'critical', 'test alert', ${opts.triggeredAt}::timestamp)
    RETURNING id
  `);
  const row = rows[0];
  if (!row) throw new Error('insertAlertAt: insert returned no row');
  return row.id;
}

describe('mobile cursor pagination — real SQL (#3770)', () => {
  it('/alerts/inbox: to_char + ::timestamp round-trips full microsecond precision and does not skip the boundary row', async () => {
    const db = getTestDb();
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const deviceId = await insertDevice({ orgId: org.id, siteId: site.id, hostname: 'host-1' });

    // A sits just above B on the SAME millisecond, differing only in the
    // fractional digits a JS Date cannot hold. The historical bug: encoding
    // A's cursor via `Date.toISOString()` truncates '.123999' to '.123',
    // and `triggered_at < '.123'` then wrongly excludes B ('.123500' is NOT
    // less than the truncated '.123000').
    const idA = await insertAlertAt({ orgId: org.id, deviceId, triggeredAt: '2026-07-28 12:00:00.123999' });
    const idB = await insertAlertAt({ orgId: org.id, deviceId, triggeredAt: '2026-07-28 12:00:00.123500' });

    // ---- Page 1: exactly what the route selects/orders, limit=1 ----
    const page1 = await db
      .select({
        id: alerts.id,
        triggeredAtKey: sql<string>`to_char(${alerts.triggeredAt}, 'YYYY-MM-DD"T"HH24:MI:SS.US')`,
      })
      .from(alerts)
      .where(eq(alerts.orgId, org.id))
      .orderBy(desc(alerts.triggeredAt), desc(alerts.id))
      .limit(1);

    expect(page1.map(r => r.id)).toEqual([idA]);
    const last = page1[0]!;
    // Full 6-digit microsecond precision preserved end to end.
    expect(last.triggeredAtKey).toBe('2026-07-28T12:00:00.123999');

    const token = encodeCursor(last.triggeredAtKey, last.id);
    expect(token).not.toBeNull();
    const cursor = decodeTimestampCursor(token ?? undefined);
    expect(cursor).toEqual({ key: '2026-07-28T12:00:00.123999', id: idA });

    // ---- Page 2: the exact keyset predicate the route builds ----
    const page2 = await db
      .select({ id: alerts.id })
      .from(alerts)
      .where(
        and(
          eq(alerts.orgId, org.id),
          sql`(${alerts.triggeredAt} < ${cursor!.key}::timestamp OR (${alerts.triggeredAt} = ${cursor!.key}::timestamp AND ${alerts.id} < ${cursor!.id}::uuid))`,
        ),
      )
      .orderBy(desc(alerts.triggeredAt), desc(alerts.id))
      .limit(1);

    // With the fix: B is returned (no skip). Against the old
    // `.toISOString()`-truncated cursor this would come back empty.
    expect(page2.map(r => r.id)).toEqual([idB]);
  });

  it('/devices: hostname ASC tuple predicate walks with no duplicates or gaps, including a never-checked-in (NULL last_seen_at) device', async () => {
    const db = getTestDb();
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });

    // Interleaved insert order so a naive scan wouldn't accidentally match
    // the expected walk order. 'zzz-never-seen' has NULL last_seen_at,
    // which the OLD `last_seen_at DESC` keyset would have sorted FIRST
    // (Postgres puts NULLs first on DESC with no NULLS LAST) — the new
    // hostname-keyed walk isn't sensitive to that column at all.
    const hostnames = ['ccc-host', 'aaa-host', 'zzz-never-seen', 'bbb-host'];
    const idByHostname = new Map<string, string>();
    for (const hostname of hostnames) {
      idByHostname.set(hostname, await insertDevice({ orgId: org.id, siteId: site.id, hostname }));
    }
    // Never checked in: NULL last_seen_at.
    await db.execute(sql`UPDATE devices SET last_seen_at = NULL WHERE id = ${idByHostname.get('zzz-never-seen')}`);

    const walked: string[] = [];
    let cursor: { key: string; id: string } | null = null;
    const limit = 1;

    for (let step = 0; step < 10; step++) {
      const whereCursor = cursor
        ? sql`(${devices.hostname}, ${devices.id}) > (${cursor.key}, ${cursor.id}::uuid)`
        : undefined;
      const rows = await db
        .select({ id: devices.id, hostname: devices.hostname })
        .from(devices)
        .where(whereCursor ? and(eq(devices.orgId, org.id), whereCursor) : eq(devices.orgId, org.id))
        .orderBy(asc(devices.hostname), asc(devices.id))
        .limit(limit + 1);

      const page = rows.slice(0, limit);
      for (const r of page) walked.push(r.hostname);

      if (rows.length <= limit) {
        cursor = null;
        break;
      }
      const lastRow = page[page.length - 1]!;
      const token = encodeCursor(lastRow.hostname, lastRow.id);
      cursor = decodeCursor(token ?? undefined);
      expect(cursor).not.toBeNull();
    }

    // Alphabetical order, every device exactly once, walk terminated.
    expect(walked).toEqual(['aaa-host', 'bbb-host', 'ccc-host', 'zzz-never-seen']);
    expect(cursor).toBeNull();
  });
});
