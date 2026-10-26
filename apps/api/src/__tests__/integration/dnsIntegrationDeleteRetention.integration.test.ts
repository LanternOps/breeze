/**
 * Real-Postgres coverage for DNS filter integration delete and retention
 * (#10019, #10020).
 *
 * THE DEFECTS:
 *  - dns_event_aggregations / dns_security_events / dns_policies reference
 *    dns_filter_integrations with no ON DELETE action, and the old DELETE route
 *    never cleared aggregations, so deleting any integration that had synced
 *    failed with 23503. 2027-01-05-100300-dns-event-aggregations-fk-on-delete.sql
 *    flips all three to ON DELETE CASCADE (NOT VALID, see the migration).
 *  - Retention never pruned aggregations, and pruned events only inline in a
 *    sync and only when retentionDays was set.
 *
 * Why a real database: FK actions and the ctid-batched DELETE predicates live
 * in SQL; the mocked unit suites resolve every statement regardless.
 */
import './setup';

import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';

import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import {
  dnsEventAggregations,
  dnsFilterIntegrations,
  dnsPolicies,
  dnsSecurityEvents,
} from '../../db/schema';
import {
  DNS_INTEGRATION_DELETING_STATUS,
  runDnsIntegrationDelete,
  runDnsSecurityRetention,
} from '../../jobs/dnsSecurityRetention';
import { createOrganization, createPartner } from './db-utils';

function asSystem<T>(fn: () => Promise<T>): Promise<T> {
  return runOutsideDbContext(() => withSystemDbAccessContext(fn));
}

const DAY_MS = 86_400_000;

async function seedIntegration(opts: { retentionDays?: number } = {}) {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  return asSystem(async () => {
    const [integration] = await db.insert(dnsFilterIntegrations).values({
      orgId: org.id,
      provider: 'umbrella',
      name: 'umbrella',
      config: opts.retentionDays ? { retentionDays: opts.retentionDays } : { organizationId: '1' },
    }).returning();
    const id = integration!.id;
    const now = Date.now();
    const ages = [1, 2, 40, 41, 120];
    await db.insert(dnsSecurityEvents).values(ages.map((age, i) => ({
      orgId: org.id,
      integrationId: id,
      timestamp: new Date(now - age * DAY_MS),
      domain: `d${i}.example`,
      action: 'blocked' as const,
      providerEventId: `evt-${i}`,
    })));
    await db.insert(dnsEventAggregations).values(ages.map((age, i) => ({
      orgId: org.id,
      integrationId: id,
      date: new Date(now - age * DAY_MS).toISOString().slice(0, 10),
      domain: `d${i}.example`,
      totalQueries: 1,
    })));
    await db.insert(dnsPolicies).values({ orgId: org.id, integrationId: id, name: 'p', type: 'blocklist' });
    return { orgId: org.id, integrationId: id };
  });
}

async function counts(integrationId: string) {
  return asSystem(async () => {
    const [row] = await db.execute(sql`
      SELECT
        (SELECT count(*)::int FROM dns_security_events WHERE integration_id = ${integrationId}) AS events,
        (SELECT count(*)::int FROM dns_event_aggregations WHERE integration_id = ${integrationId}) AS aggregations,
        (SELECT count(*)::int FROM dns_policies WHERE integration_id = ${integrationId}) AS policies,
        (SELECT count(*)::int FROM dns_filter_integrations WHERE id = ${integrationId}) AS integrations
    `) as unknown as Array<{ events: number; aggregations: number; policies: number; integrations: number }>;
    return row!;
  });
}

describe('dns integration FKs (#10019)', () => {
  it('cascade from dns_filter_integrations for aggregations, events and policies', async () => {
    const rows = await asSystem(() => db.execute(sql`
      SELECT conrelid::regclass::text AS child, confdeltype
      FROM pg_constraint
      WHERE contype = 'f' AND confrelid = 'public.dns_filter_integrations'::regclass
      ORDER BY 1
    `)) as unknown as Array<{ child: string; confdeltype: string }>;
    expect([...rows]).toEqual([
      { child: 'dns_event_aggregations', confdeltype: 'c' },
      { child: 'dns_policies', confdeltype: 'c' },
      { child: 'dns_security_events', confdeltype: 'c' },
    ]);
  });

  it('a bare parent delete no longer fails on an integration with history', async () => {
    const { integrationId } = await seedIntegration();
    await asSystem(() => db.delete(dnsFilterIntegrations).where(eq(dnsFilterIntegrations.id, integrationId)));
    expect(await counts(integrationId)).toEqual({ events: 0, aggregations: 0, policies: 0, integrations: 0 });
  });
});

describe('background integration delete (#10019)', () => {
  it('drains every child in small batches, then removes the integration', async () => {
    const { integrationId } = await seedIntegration();
    await asSystem(() => db.update(dnsFilterIntegrations)
      .set({ isActive: false, lastSyncStatus: DNS_INTEGRATION_DELETING_STATUS })
      .where(eq(dnsFilterIntegrations.id, integrationId)));

    const result = await runDnsIntegrationDelete({ integrationId, batchSize: 2, maxBatches: 10 });

    expect(result).toEqual({ status: 'deleted', aggregationsDeleted: 5, eventsDeleted: 5 });
    expect(await counts(integrationId)).toEqual({ events: 0, aggregations: 0, policies: 0, integrations: 0 });
  });

  it('touches nothing for an integration that is still active', async () => {
    const { integrationId } = await seedIntegration();
    const result = await runDnsIntegrationDelete({ integrationId, batchSize: 2, maxBatches: 10 });
    expect(result.status).toBe('skipped_active');
    expect(await counts(integrationId)).toEqual({ events: 5, aggregations: 5, policies: 1, integrations: 1 });
  });
});

describe('dns security retention sweep (#10020)', () => {
  it('prunes events AND aggregations past the integration window, keeping newer rows', async () => {
    const short = await seedIntegration({ retentionDays: 30 });
    const dflt = await seedIntegration();

    await runDnsSecurityRetention({ defaultRetentionDays: 90, batchSize: 1, maxBatches: 50 });

    // 30-day window: ages 40, 41, 120 go; 1 and 2 stay.
    expect(await counts(short.integrationId)).toMatchObject({ events: 2, aggregations: 2, integrations: 1 });
    // Unset -> 90-day default: only the 120-day-old row goes.
    expect(await counts(dflt.integrationId)).toMatchObject({ events: 4, aggregations: 4, integrations: 1 });
  });
});
