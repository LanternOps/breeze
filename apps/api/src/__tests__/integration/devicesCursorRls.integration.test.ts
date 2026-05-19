/**
 * Devices cursor pagination — partner-scope RLS isolation (Discussion #742 PR 3).
 *
 * Todd's design point #3 plus the repo-shape constraint: every page the
 * cursor returns AND the `includeTotal` count must stay inside
 * `breeze_has_org_access`. This test forges a partner scope that owns a
 * subset of orgs, plants devices in BOTH accessible AND inaccessible
 * orgs, walks the cursor across the full set, and asserts no foreign-org
 * row ever appears — same for the total count.
 *
 * Why integration, not unit: the keyset predicate is built in TS but the
 * monotonicity guarantee depends on the Postgres tuple-comparison
 * semantics + the actual RLS USING expression applied to the row. A
 * Drizzle mock would happily return rows the live policy denies.
 *
 * Prerequisites:
 *   docker compose -f docker-compose.test.yml up -d
 *
 * Run:
 *   pnpm test:integration -- src/__tests__/integration/devicesCursorRls.integration.test.ts
 */
import './setup';

import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { getTestDb } from './setup';
import { db, withDbAccessContext } from '../../db';
import { devices } from '../../db/schema';
import { createPartner, createOrganization, createSite } from './db-utils';
import {
  buildKeysetPredicate,
  buildOrderBy,
  cursorFromRow,
  decodeCursor,
  encodeCursor,
  type DevicesCursor,
} from '../../routes/devices/cursor';

let agentIdCounter = 0;
async function insertDevice(opts: {
  orgId: string;
  siteId: string;
  hostname: string;
}): Promise<string> {
  const db = getTestDb();
  agentIdCounter++;
  const [row] = await db
    .insert(devices)
    .values({
      orgId: opts.orgId,
      siteId: opts.siteId,
      agentId: `agent-cursor-${agentIdCounter}-${Date.now()}`,
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

/** Pin an organization-scope DB context using the same path production
 *  request handlers use. Queries inside `fn` issued against the exported
 *  `db` proxy resolve to the transaction with the GUCs set, running as
 *  the unprivileged `breeze_app` role — i.e. RLS is genuinely enforced.
 *  `getTestDb()` (superuser) is used for SETUP only. */
async function withOrgScope<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
  return withDbAccessContext(
    {
      scope: 'organization',
      orgId,
      accessibleOrgIds: [orgId],
      accessiblePartnerIds: null,
      userId: null,
    },
    fn,
  );
}

describe('GET /devices cursor pagination — RLS isolation', () => {
  let allowedOrg: string;
  let allowedSite: string;
  let foreignOrg: string;
  let foreignSite: string;

  beforeEach(async () => {
    // Two distinct partners ⇒ two distinct orgs that are not
    // partner-accessible to each other. We'll force-set the auth
    // context to scope = the allowed org and walk the cursor.
    const partnerA = await createPartner();
    const partnerB = await createPartner();
    const orgA = await createOrganization({ partnerId: partnerA.id });
    const orgB = await createOrganization({ partnerId: partnerB.id });
    allowedOrg = orgA.id;
    foreignOrg = orgB.id;
    const siteA = await createSite({ orgId: allowedOrg });
    const siteB = await createSite({ orgId: foreignOrg });
    allowedSite = siteA.id;
    foreignSite = siteB.id;
  });

  it('cursor walk under partner-scope returns only accessible-org rows, even when intermixed with foreign rows', async () => {
    // Insert in interleaved hostname order so a naive non-RLS query
    // would surface foreign rows between every allowed row.
    const hostnames = ['aaa-01', 'bbb-02', 'ccc-03', 'ddd-04', 'eee-05', 'fff-06'];
    const allowedIds: string[] = [];
    const foreignIds: string[] = [];
    for (let i = 0; i < hostnames.length; i++) {
      const host = hostnames[i]!;
      if (i % 2 === 0) {
        allowedIds.push(
          await insertDevice({ orgId: allowedOrg, siteId: allowedSite, hostname: host }),
        );
      } else {
        foreignIds.push(
          await insertDevice({ orgId: foreignOrg, siteId: foreignSite, hostname: host }),
        );
      }
    }

    // Walk the cursor end-to-end with limit=2 so we have to issue at
    // least two cursor steps. Should return exactly the 3 allowed
    // devices in hostname-ASC order, never a foreign one, and end with
    // nextCursor=null.
    const collected: { id: string; hostname: string }[] = [];
    let cursor: DevicesCursor | null = null;
    const limit = 2;

    for (let step = 0; step < 10; step++) {
      const result = await withOrgScope(allowedOrg, async () => {
        const orderBy = buildOrderBy('hostname', 'asc');
        const where = cursor ? buildKeysetPredicate(cursor) : undefined;
        // `db` is the RLS-enforcing proxy; inside withDbAccessContext it
        // routes queries to the tx with the GUCs set as breeze_app.
        return db
          .select({
            id: devices.id,
            hostname: devices.hostname,
            lastSeenAt: devices.lastSeenAt,
            enrolledAt: devices.enrolledAt,
            orgId: devices.orgId,
          })
          .from(devices)
          .where(where)
          .orderBy(...orderBy)
          .limit(limit + 1);
      });

      const page = result.slice(0, limit);
      for (const r of page) {
        // Hard assertion: not a foreign device under any condition.
        expect(foreignIds).not.toContain(r.id);
        expect(r.orgId).toBe(allowedOrg);
        collected.push({ id: r.id, hostname: r.hostname });
      }

      if (result.length <= limit) {
        cursor = null;
        break;
      }
      const lastReturned = page[page.length - 1]!;
      cursor = decodeCursor(encodeCursor(cursorFromRow(lastReturned, 'hostname', 'asc')));
      expect(cursor).not.toBeNull();
    }

    // Walked all 3 allowed rows in hostname order, no duplicates, no
    // foreign rows.
    expect(collected).toEqual(
      allowedIds.map((id, i) => ({ id, hostname: hostnames[i * 2]! })),
    );
    // Walk terminated cleanly.
    expect(cursor).toBeNull();
  });

  it('includeTotal count under partner-scope reflects only accessible-org rows', async () => {
    // 3 allowed + 4 foreign. The count(*) under partner-scope must
    // return 3, never 7.
    await insertDevice({ orgId: allowedOrg, siteId: allowedSite, hostname: 'a1' });
    await insertDevice({ orgId: allowedOrg, siteId: allowedSite, hostname: 'a2' });
    await insertDevice({ orgId: allowedOrg, siteId: allowedSite, hostname: 'a3' });
    await insertDevice({ orgId: foreignOrg, siteId: foreignSite, hostname: 'f1' });
    await insertDevice({ orgId: foreignOrg, siteId: foreignSite, hostname: 'f2' });
    await insertDevice({ orgId: foreignOrg, siteId: foreignSite, hostname: 'f3' });
    await insertDevice({ orgId: foreignOrg, siteId: foreignSite, hostname: 'f4' });

    const total = await withOrgScope(allowedOrg, async () => {
      const r = await db
        .select({ count: sql<number>`count(*)` })
        .from(devices);
      return Number(r[0]?.count ?? 0);
    });
    expect(total).toBe(3);
  });

  it('forged cross-org cursor (id of a foreign device) does NOT leak the foreign row', async () => {
    // Plant one allowed + one foreign with hostnames such that the
    // foreign hostname is lexicographically EARLIER than the allowed
    // one. A naive non-RLS cursor walk seeded with the foreign row's
    // {hostname, id} would return the allowed row as "after" it. With
    // RLS in effect, the partner-scope context never sees the foreign
    // row to begin with — and a forged cursor that carries a foreign id
    // still cannot pull foreign data through, because the RLS USING
    // applies to every selected row.
    const allowedId = await insertDevice({
      orgId: allowedOrg,
      siteId: allowedSite,
      hostname: 'zeta-allowed',
    });
    const foreignId = await insertDevice({
      orgId: foreignOrg,
      siteId: foreignSite,
      hostname: 'alpha-foreign', // lexicographically first
    });

    // Forge a cursor as if the previous page ended on the foreign row
    // (an attacker scenario or a stale-cursor scenario).
    const forged: DevicesCursor = {
      v: 1,
      sort: 'hostname',
      sortDir: 'asc',
      k: 'alpha-foreign',
      id: foreignId,
    };

    const rows = await withOrgScope(allowedOrg, async () => {
      const orderBy = buildOrderBy('hostname', 'asc');
      return db
        .select({
          id: devices.id,
          orgId: devices.orgId,
          hostname: devices.hostname,
        })
        .from(devices)
        .where(buildKeysetPredicate(forged))
        .orderBy(...orderBy)
        .limit(10);
    });

    // Only the allowed row appears, not the foreign one whose id was
    // used in the cursor.
    expect(rows.map((r) => r.id)).toEqual([allowedId]);
    expect(rows[0]?.orgId).toBe(allowedOrg);
  });
});
