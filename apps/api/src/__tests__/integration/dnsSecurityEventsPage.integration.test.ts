/**
 * Real-Postgres coverage for the DNS Security Events list paging (#10054).
 *
 * THE DEFECT: GET /dns-security/events paged with OFFSET and an exact
 * count(*) over an unbounded window; a blocked-only list on a 30M-row table
 * took 131 s. It now pages with a keyset cursor on (timestamp, id) inside a
 * default window, counts up to a cap, and the blocked-only list has a partial
 * index.
 *
 * Why a real database: the cursor is the timestamp as Postgres renders it
 * (microseconds) and the bound is a SQL row comparison; a mocked db resolves
 * any statement. A JS Date keeps milliseconds only, so a Date-based cursor
 * would skip rows whose timestamps differ below a millisecond — the seed
 * below has exactly those rows, and timestamp ties broken only by id.
 */
import './setup';

import { describe, expect, it } from 'vitest';
import { and, eq, gte, sql, type SQL } from 'drizzle-orm';

import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { dnsFilterIntegrations, dnsSecurityEvents } from '../../db/schema';
import {
  DNS_EVENTS_COUNT_CAP,
  buildDnsEventsCappedCountQuery,
  buildDnsEventsPageQuery,
  decodeDnsEventsCursor,
  dnsEventsActionCondition,
  listDnsSecurityEventsPage,
} from '../../services/dnsSecurityEventsPage';
import { createOrganization, createPartner } from './db-utils';
import { analyzeTable, explainAsBreezeApp } from './explainAsBreezeApp';

function asSystem<T>(fn: () => Promise<T>): Promise<T> {
  return runOutsideDbContext(() => withSystemDbAccessContext(fn));
}

async function seedOrgWithIntegration() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const integrationId = await asSystem(async () => {
    const [integration] = await db.insert(dnsFilterIntegrations).values({
      orgId: org.id,
      provider: 'umbrella',
      name: 'umbrella',
      config: { organizationId: '1' },
    }).returning();
    return integration!.id;
  });
  return { orgId: org.id, integrationId };
}

describe('dns security events keyset paging (#10054)', () => {
  it('walks every row exactly once in (timestamp desc, id desc) order, across sub-millisecond timestamps and ties', async () => {
    const { orgId, integrationId } = await seedOrgWithIntegration();
    await asSystem(() => db.execute(sql`
      INSERT INTO dns_security_events (org_id, integration_id, timestamp, domain, action, provider_event_id)
      SELECT ${orgId}::uuid, ${integrationId}::uuid,
             -- 4 rows per base instant: two exact ties, two sub-millisecond offsets
             date_trunc('second', now()::timestamp) - (g / 4) * interval '1 second'
               + CASE g % 4 WHEN 0 THEN interval '0' WHEN 1 THEN interval '0'
                            WHEN 2 THEN interval '250 microseconds' ELSE interval '750 microseconds' END,
             'd' || g || '.example',
             CASE WHEN g % 3 = 0 THEN 'allowed'::dns_action ELSE 'blocked'::dns_action END,
             'evt-' || g
      FROM generate_series(1, 41) g
    `));

    const where = and(
      eq(dnsSecurityEvents.orgId, orgId),
      dnsEventsActionCondition('blocked'),
      gte(dnsSecurityEvents.timestamp, new Date(Date.now() - 86_400_000)),
    );

    const expected = await asSystem(async () => {
      const rows = await db.execute(sql`
        SELECT id FROM dns_security_events
        WHERE org_id = ${orgId}::uuid AND action = 'blocked'
        ORDER BY timestamp DESC, id DESC
      `) as unknown as Array<{ id: string }>;
      return [...rows].map((r) => r.id);
    });
    expect(expected.length).toBe(28);

    const seen: string[] = [];
    const totals: Array<number | null> = [];
    let cursor: ReturnType<typeof decodeDnsEventsCursor> = null;
    for (let pageNo = 0; pageNo < 20; pageNo++) {
      const page = await asSystem(() => listDnsSecurityEventsPage({ where, limit: 5, cursor }));
      seen.push(...page.rows.map((r) => r.id as string));
      totals.push(page.total);
      if (!page.nextCursor) break;
      cursor = decodeDnsEventsCursor(page.nextCursor);
      expect(cursor).not.toBeNull();
    }

    expect(seen).toEqual(expected);
    // The capped count runs on the first page only.
    expect(totals[0]).toBe(28);
    expect(totals.slice(1).every((t) => t === null)).toBe(true);
  });

  it('caps the count and says so', async () => {
    const { orgId, integrationId } = await seedOrgWithIntegration();
    await asSystem(() => db.execute(sql`
      INSERT INTO dns_security_events (org_id, integration_id, timestamp, domain, action, provider_event_id)
      SELECT ${orgId}::uuid, ${integrationId}::uuid, now()::timestamp - g * interval '1 second',
             'cap.example', 'blocked'::dns_action, 'cap-' || g
      FROM generate_series(1, ${DNS_EVENTS_COUNT_CAP + 1}) g
    `));

    const page = await asSystem(() => listDnsSecurityEventsPage({
      where: eq(dnsSecurityEvents.orgId, orgId),
      limit: 10,
    }));
    expect(page.rows).toHaveLength(10);
    expect(page.total).toBe(DNS_EVENTS_COUNT_CAP);
    expect(page.totalCapped).toBe(true);
    expect(page.nextCursor).not.toBeNull();
  });

  it('reports an exact total and no next page when everything fits', async () => {
    const { orgId, integrationId } = await seedOrgWithIntegration();
    await asSystem(() => db.execute(sql`
      INSERT INTO dns_security_events (org_id, integration_id, timestamp, domain, action, provider_event_id)
      SELECT ${orgId}::uuid, ${integrationId}::uuid, now()::timestamp - g * interval '1 second',
             'small.example', 'blocked'::dns_action, 'small-' || g
      FROM generate_series(1, 3) g
    `));

    const page = await asSystem(() => listDnsSecurityEventsPage({
      where: eq(dnsSecurityEvents.orgId, orgId),
      limit: 3,
    }));
    expect(page.rows).toHaveLength(3);
    expect(page).toMatchObject({ total: 3, totalCapped: false, nextCursor: null });
    expect(page.rows[0]).not.toHaveProperty('cursorTs');
  });
});

describe('blocked-only page plan as breeze_app (#10054)', () => {
  const INDEX = 'dns_security_events_org_blocked_ts_idx';

  async function seedSkewedOrg() {
    const { orgId, integrationId } = await seedOrgWithIntegration();
    // ~1% blocked, like a stored DNS log; enough rows that the plan is not a coin toss.
    await asSystem(() => db.execute(sql`
      INSERT INTO dns_security_events (org_id, integration_id, timestamp, domain, action, provider_event_id)
      SELECT ${orgId}::uuid, ${integrationId}::uuid, now()::timestamp - g * interval '10 seconds',
             'd' || (g % 50) || '.example',
             CASE WHEN g % 100 = 0 THEN 'blocked'::dns_action ELSE 'allowed'::dns_action END,
             'plan-' || g
      FROM generate_series(1, 6000) g
    `));
    await analyzeTable(dnsSecurityEvents);
    return orgId;
  }

  function routeWhere(orgId: string, action: SQL) {
    // Same shape the route builds: org condition, window start, action.
    return and(
      eq(dnsSecurityEvents.orgId, orgId),
      gte(dnsSecurityEvents.timestamp, new Date(Date.now() - 7 * 86_400_000)),
      action,
    );
  }

  it('the first page and a cursor page use the partial index under a generic plan', async () => {
    const orgId = await seedSkewedOrg();
    const where = routeWhere(orgId, dnsEventsActionCondition('blocked'));

    const first = await explainAsBreezeApp({
      orgId,
      forceGenericPlan: true,
      sql: buildDnsEventsPageQuery({ where, limit: 100 }),
    });
    expect(first.usesIndex(INDEX), first.plan).toBe(true);
    expect(first.hasSeqScan, first.plan).toBe(false);

    const next = await explainAsBreezeApp({
      orgId,
      forceGenericPlan: true,
      sql: buildDnsEventsPageQuery({
        where,
        limit: 100,
        cursor: { ts: '2026-10-27T10:00:00.123456', id: '0b5d0f4e-1c2a-4d3b-9e8f-7a6b5c4d3e2f' },
      }),
    });
    expect(next.usesIndex(INDEX), next.plan).toBe(true);
    // The keyset bound is an index condition, not a filter over the window.
    expect(next.plan).toMatch(/Index Cond: .*ROW\("timestamp", id\) </);

    const count = await explainAsBreezeApp({
      orgId,
      forceGenericPlan: true,
      sql: buildDnsEventsCappedCountQuery(where),
    });
    expect(count.usesIndex(INDEX), count.plan).toBe(true);
  });

  it('control: a bound action parameter cannot use the partial index under a generic plan', async () => {
    const orgId = await seedSkewedOrg();
    const bound = await explainAsBreezeApp({
      orgId,
      forceGenericPlan: true,
      sql: buildDnsEventsPageQuery({ where: routeWhere(orgId, eq(dnsSecurityEvents.action, 'blocked')), limit: 100 }),
    });
    expect(bound.usesIndex(INDEX), bound.plan).toBe(false);
  });
});

describe('dns_security_events indexes (#10054)', () => {
  it('has the blocked-only partial index and no duplicate provider-event index', async () => {
    const rows = await asSystem(() => db.execute(sql`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'dns_security_events'
    `)) as unknown as Array<{ indexname: string; indexdef: string }>;
    const byName = new Map([...rows].map((r) => [r.indexname, r.indexdef]));

    expect(byName.get('dns_security_events_org_blocked_ts_idx')).toMatch(
      /\(org_id, "timestamp", id\) WHERE \(action = 'blocked'::dns_action\)/,
    );
    expect(byName.has('dns_security_events_provider_id_idx')).toBe(false);
    expect(byName.has('dns_security_events_provider_evt_uniq')).toBe(true);
  });
});
