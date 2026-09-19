import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { m365Connections, m365SigninEvents, m365SyncState } from '../../db/schema';
import { createOrganization, createPartner, createUser } from './db-utils';
import { getTestDb } from './setup';
import { executeOrgMerge } from '../../services/orgMerge';
import { pruneM365SyncRetention, SIGNIN_EVENTS_RETENTION_DAYS } from '../../jobs/m365SyncRetentionWorker';
import {
  persistSigninEvents,
  signinEventsWindow,
  SIGNIN_EVENTS_OVERLAP_MINUTES,
} from '../../services/m365Sync/domains/signinEvents';
import { cascadeDeleteOrg } from '../../services/tenantCascade';

/**
 * #5784 W05. The load-bearing cases for the new shape-1 table: the RLS forge,
 * the system-context cross-org write the sync worker depends on, idempotent
 * re-sync, the overlapping delta window, event-vs-ingestion time, the 120-day
 * purge, and the org-merge disposition (repoint-dedupe, NOT a delete).
 */

const runDb = it.runIf(!!process.env.DATABASE_URL);
const credentialVersion = '0123456789abcdef0123456789abcdef';
const DAY_MS = 24 * 3600 * 1000;

async function seedOrg(label: string, existingPartnerId?: string) {
  const partner = existingPartnerId ? { id: existingPartnerId } : await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const user = await createUser({
    partnerId: partner.id,
    orgId: org.id,
    email: `m365-signin-events-${label}-${randomUUID()}@example.com`,
  });
  const tenantId = randomUUID();
  const [connection] = await db.insert(m365Connections).values({
    orgId: org.id,
    userId: null,
    tenantId,
    consentAttemptId: randomUUID(),
    clientId: randomUUID(),
    clientSecret: null,
    profile: 'customer-graph-read',
    authMode: 'application-certificate',
    credentialDomain: 'customer-graph-read',
    vaultRef: `akv://vault.example/m365-customer-graph-read-${tenantId}/${credentialVersion}`,
    credentialVersion,
    permissionManifestVersion: 3,
    status: 'active',
  }).returning({ id: m365Connections.id });
  const context: DbAccessContext = {
    scope: 'organization',
    orgId: org.id,
    accessibleOrgIds: [org.id],
    accessiblePartnerIds: [],
    userId: user.id,
  };
  return { partner, org, user, tenantId, connection: connection!, context };
}

function seedFixture() {
  return withSystemDbAccessContext(async () => ({
    a: await seedOrg('a'),
    b: await seedOrg('b'),
  }));
}

function graphEvent(id: string, createdDateTime: string, over: Record<string, unknown> = {}) {
  return {
    id,
    createdDateTime,
    userId: randomUUID(),
    userPrincipalName: 'ada@contoso.test',
    appId: 'app-1',
    appDisplayName: 'Outlook',
    clientAppUsed: 'Browser',
    ipAddress: '203.0.113.7',
    location: { city: 'Austin', countryOrRegion: 'US' },
    conditionalAccessStatus: 'success',
    status: { errorCode: 0 },
    riskLevelAggregated: 'none',
    riskState: 'none',
    isInteractive: true,
    ...over,
  };
}

function syncResult(items: Record<string, unknown>[], over: Record<string, unknown> = {}) {
  return {
    success: true as const,
    kind: 'sync' as const,
    items,
    truncated: false,
    fetchedAt: new Date().toISOString(),
    sources: { signinEvents: 'ok' as const },
    ...over,
  } as never;
}

function persistCtx(orgId: string, tenantId: string, now = new Date()) {
  return {
    orgId,
    tenantId,
    connectionId: randomUUID(),
    generation: 1,
    // No `domain`: the FOR SHARE ownership guard is skipped, which is what lets
    // these cases exercise the WRITE without standing up a whole sync run.
    existing: new Map<string, { coreHash: string; isStale: boolean }>(),
    now,
  };
}

describe('m365_signin_events — tenant isolation as breeze_app', () => {
  runDb('Case 1: refuses a forged cross-org insert with 42501 and hides the other org rows', async () => {
    const fx = await seedFixture();
    await expect(withDbAccessContext(fx.a.context, () => db.insert(m365SigninEvents).values({
      orgId: fx.b.org.id,
      tenantId: fx.b.tenantId,
      graphId: randomUUID(),
      signedInAt: new Date(),
    })), 'm365_signin_events accepted a cross-tenant insert')
      .rejects.toMatchObject({ cause: { code: '42501' } });

    const foreign = randomUUID();
    await withSystemDbAccessContext(() => db.insert(m365SigninEvents).values({
      orgId: fx.b.org.id, tenantId: fx.b.tenantId, graphId: foreign, signedInAt: new Date(),
    }));
    const visible = await withDbAccessContext(fx.a.context, () =>
      db.select({ id: m365SigninEvents.id }).from(m365SigninEvents)
        .where(sql`${m365SigninEvents.graphId} = ${foreign}`));
    expect(visible).toEqual([]);
  });

  runDb('runs as breeze_app without BYPASSRLS, and the table is RLS enabled AND forced', async () => {
    const fx = await seedFixture();
    const who = await withDbAccessContext(fx.a.context, () =>
      db.execute(sql`SELECT current_user AS who, rolbypassrls FROM pg_roles WHERE rolname = current_user`));
    expect((who as unknown as Array<{ who: string; rolbypassrls: boolean }>)[0])
      .toEqual({ who: 'breeze_app', rolbypassrls: false });

    const rows = (await getTestDb().execute(sql`
      SELECT relrowsecurity, relforcerowsecurity FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND relname = 'm365_signin_events'
    `)) as unknown as Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>;
    expect(rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });

    const policies = (await getTestDb().execute(sql`
      SELECT policyname, cmd, qual, with_check FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'm365_signin_events'
    `)) as unknown as Array<{ policyname: string; cmd: string; qual: string; with_check: string }>;
    expect(policies).toHaveLength(1);
    expect(policies[0]!.policyname).toBe('m365_signin_events_org_access');
    expect(policies[0]!.cmd).toBe('ALL');
    expect(policies[0]!.qual).toContain('breeze_has_org_access');
    expect(policies[0]!.with_check).toContain('breeze_has_org_access');
  });

  runDb('Case 2: the system context writes and reads across orgs — no second policy needed', async () => {
    const fx = await seedFixture();
    const [ga, gb] = [randomUUID(), randomUUID()];
    await withSystemDbAccessContext(() => db.insert(m365SigninEvents).values([
      { orgId: fx.a.org.id, tenantId: fx.a.tenantId, graphId: ga, signedInAt: new Date() },
      { orgId: fx.b.org.id, tenantId: fx.b.tenantId, graphId: gb, signedInAt: new Date() },
    ]));
    const rows = await withSystemDbAccessContext(() =>
      db.select({ graphId: m365SigninEvents.graphId }).from(m365SigninEvents)
        .where(sql`${m365SigninEvents.graphId} IN (${ga}, ${gb})`));
    expect(rows.map((r) => r.graphId).sort()).toEqual([ga, gb].sort());
  });

  runDb('the m365_sync_domain enum carries the seventh label', async () => {
    const rows = (await getTestDb().execute(sql`
      SELECT array_agg(e.enumlabel ORDER BY e.enumsortorder) AS labels
      FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE t.typname = 'm365_sync_domain'
    `)) as unknown as Array<{ labels: string[] }>;
    expect(rows[0]!.labels).toContain('signin_events');
  });
});

describe('m365_signin_events — persister against real Postgres', () => {
  runDb('Case 3: a re-synced batch is idempotent — same rows, no unique violation', async () => {
    const fx = await withSystemDbAccessContext(() => seedOrg('idempotent'));
    const ids = [randomUUID(), randomUUID()];
    const batch = syncResult([
      graphEvent(ids[0]!, '2026-09-02T09:00:00.000Z'),
      graphEvent(ids[1]!, '2026-09-02T10:00:00.000Z'),
    ]);

    const first = await withSystemDbAccessContext(() =>
      persistSigninEvents(persistCtx(fx.org.id, fx.tenantId), batch));
    expect(first.inserted).toBe(2);
    expect(first.complete).toBe(true);

    // The overlapping delta window deliberately re-fetches recent events.
    const second = await withSystemDbAccessContext(() =>
      persistSigninEvents(persistCtx(fx.org.id, fx.tenantId), batch));
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(2);

    const [count] = (await (getTestDb() as typeof db).execute(sql`
      SELECT count(*)::int AS n FROM m365_signin_events WHERE org_id = ${fx.org.id}::uuid
    `)) as unknown as Array<{ n: number }>;
    expect(count!.n).toBe(2);
  });

  runDb('flattens location and status, stores the `hidden` risk sentinel, and keeps no payload column', async () => {
    const fx = await withSystemDbAccessContext(() => seedOrg('flatten'));
    const id = randomUUID();
    await withSystemDbAccessContext(() => persistSigninEvents(
      persistCtx(fx.org.id, fx.tenantId),
      syncResult([graphEvent(id, '2026-09-02T09:00:00.000Z', {
        location: { city: 'Austin', countryOrRegion: 'US' },
        status: { errorCode: 50126, failureReason: 'Invalid username or password' },
        riskLevelAggregated: 'hidden',
        riskState: 'hidden',
      })]),
    ));
    const [row] = (await (getTestDb() as typeof db).execute(sql`
      SELECT location_city, location_country, status_error_code, status_failure_reason,
             risk_level_aggregated, risk_state
      FROM m365_signin_events WHERE graph_id = ${id}
    `)) as unknown as Array<Record<string, unknown>>;
    expect(row).toMatchObject({
      location_city: 'Austin',
      location_country: 'US',
      status_error_code: 50126,
      status_failure_reason: 'Invalid username or password',
      risk_level_aggregated: 'hidden',
      risk_state: 'hidden',
    });

    // No jsonb/bytea column exists at all — that is what keeps every column out
    // of the excludedOpen export bucket.
    const open = (await getTestDb().execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'm365_signin_events'
        AND data_type IN ('json', 'jsonb', 'bytea')
    `)) as unknown as Array<{ column_name: string }>;
    expect(open).toEqual([]);
  });

  runDb('Case 5: a late arrival keeps its own event time — ingested_at is separate', async () => {
    const fx = await withSystemDbAccessContext(() => seedOrg('late'));
    const id = randomUUID();
    const closedPeriodEvent = new Date(Date.now() - 40 * DAY_MS).toISOString();
    await withSystemDbAccessContext(() => persistSigninEvents(
      persistCtx(fx.org.id, fx.tenantId),
      syncResult([graphEvent(id, closedPeriodEvent)]),
    ));
    const [row] = (await (getTestDb() as typeof db).execute(sql`
      SELECT signed_in_at, ingested_at,
             (ingested_at - signed_in_at) > interval '30 days' AS arrived_late
      FROM m365_signin_events WHERE graph_id = ${id}
    `)) as unknown as Array<{ signed_in_at: Date; ingested_at: Date; arrived_late: boolean }>;
    expect(new Date(row!.signed_in_at).toISOString()).toBe(closedPeriodEvent);
    // A reader can DETECT the late arrival instead of silently seeing a closed
    // period's totals change.
    expect(row!.arrived_late).toBe(true);
  });
});

describe('m365_signin_events — the delta window', () => {
  runDb('Case 4a: cold start pulls a bounded window; steady state subtracts the overlap', async () => {
    const fx = await withSystemDbAccessContext(() => seedOrg('window'));
    const now = new Date();

    const cold = await withSystemDbAccessContext(() => signinEventsWindow(fx.org.id, now));
    expect(cold.until).toBe(now.toISOString());
    expect(Date.parse(cold.until) - Date.parse(cold.since)).toBe(7 * DAY_MS);

    const watermark = new Date(now.getTime() - 2 * 3600_000);
    await withSystemDbAccessContext(() => db.insert(m365SigninEvents).values([
      { orgId: fx.org.id, tenantId: fx.tenantId, graphId: randomUUID(), signedInAt: watermark },
      {
        orgId: fx.org.id,
        tenantId: fx.tenantId,
        graphId: randomUUID(),
        signedInAt: new Date(now.getTime() - 5 * 3600_000),
      },
    ]));

    const steady = await withSystemDbAccessContext(() => signinEventsWindow(fx.org.id, now));
    // MINUS the overlap, not the bare watermark: Graph surfaces records late.
    expect(steady.since)
      .toBe(new Date(watermark.getTime() - SIGNIN_EVENTS_OVERLAP_MINUTES * 60_000).toISOString());
    expect(Date.parse(steady.since)).toBeLessThan(watermark.getTime());
  });

  runDb('Case 4c: an org behind by weeks gets a window covering the WHOLE gap', async () => {
    // Clamping `since` forward to a fixed lookback would move the window past
    // the gap, and no later run would come back for it — Graph purges audit
    // logs at ~30 days, so the range would be unrecoverable, silently.
    const fx = await withSystemDbAccessContext(() => seedOrg('catchup'));
    const now = new Date();
    const stale = new Date(now.getTime() - 21 * DAY_MS);
    await withSystemDbAccessContext(() => db.insert(m365SigninEvents).values({
      orgId: fx.org.id, tenantId: fx.tenantId, graphId: randomUUID(), signedInAt: stale,
    }));
    const window = await withSystemDbAccessContext(() => signinEventsWindow(fx.org.id, now));
    expect(window.since)
      .toBe(new Date(stale.getTime() - SIGNIN_EVENTS_OVERLAP_MINUTES * 60_000).toISOString());
    expect(Date.parse(window.until) - Date.parse(window.since)).toBeGreaterThan(20 * DAY_MS);
  });

  runDb('Case 4b: a truncated page does not advance completeness', async () => {
    const fx = await withSystemDbAccessContext(() => seedOrg('truncated'));
    const truncated = await withSystemDbAccessContext(() => persistSigninEvents(
      persistCtx(fx.org.id, fx.tenantId),
      syncResult([graphEvent(randomUUID(), '2026-09-02T09:00:00.000Z')], { continuation: 'more-pages' }),
    ));
    // `complete` is exactly what writeCompletion gates last_complete_snapshot_at
    // on, so a walk with pages left never stamps a fresh "as of" for W06.
    expect(truncated.complete).toBe(false);
    expect(truncated.continuation).toBe('more-pages');

    const whole = await withSystemDbAccessContext(() => persistSigninEvents(
      persistCtx(fx.org.id, fx.tenantId),
      syncResult([graphEvent(randomUUID(), '2026-09-02T10:00:00.000Z')]),
    ));
    expect(whole.complete).toBe(true);
  });

  runDb('the sync state row accepts the signin_events domain', async () => {
    const fx = await withSystemDbAccessContext(() => seedOrg('state'));
    await withSystemDbAccessContext(() => db.insert(m365SyncState).values({
      orgId: fx.org.id, connectionId: fx.connection.id, domain: 'signin_events', intervalSeconds: 86400,
    }));
    const rows = await withSystemDbAccessContext(() =>
      db.select({ domain: m365SyncState.domain }).from(m365SyncState)
        .where(sql`${m365SyncState.orgId} = ${fx.org.id}::uuid`));
    expect(rows.map((r) => r.domain)).toContain('signin_events');
  });
});

describe('m365_signin_events — retention', () => {
  runDb('Case 6: purges past 120 days and keeps everything inside the window', async () => {
    const fx = await withSystemDbAccessContext(() => seedOrg('retention'));
    const inside = randomUUID();
    const outside = randomUUID();
    const ago = (days: number) => new Date(Date.now() - days * DAY_MS);
    await withSystemDbAccessContext(() => db.insert(m365SigninEvents).values([
      { orgId: fx.org.id, tenantId: fx.tenantId, graphId: inside, signedInAt: ago(119) },
      { orgId: fx.org.id, tenantId: fx.tenantId, graphId: outside, signedInAt: ago(121) },
    ]));
    expect(SIGNIN_EVENTS_RETENTION_DAYS).toBe(120);

    const result = await pruneM365SyncRetention();
    expect(result.deletedSigninEvents).toBeGreaterThanOrEqual(1);

    const rows = (await (getTestDb() as typeof db).execute(sql`
      SELECT graph_id FROM m365_signin_events WHERE org_id = ${fx.org.id}::uuid
    `)) as unknown as Array<{ graph_id: string }>;
    expect(rows.map((r) => r.graph_id)).toEqual([inside]);
  });
});

describe('m365_signin_events — org erasure and org merge', () => {
  runDb('Case 7a: the tenant cascade deletes the org events with no FK violation', async () => {
    const fx = await withSystemDbAccessContext(() => seedOrg('cascade'));
    await withSystemDbAccessContext(() => db.insert(m365SigninEvents).values({
      orgId: fx.org.id, tenantId: fx.tenantId, graphId: randomUUID(), signedInAt: new Date(),
    }));
    const stats = await cascadeDeleteOrg(fx.org.id, fx.user.id, 'erasure@signin-events.test');
    expect(stats.tablesDeleted.m365_signin_events).toBe(1);
    const [row] = (await (getTestDb() as typeof db).execute(sql`
      SELECT count(*)::int AS n FROM m365_signin_events WHERE org_id = ${fx.org.id}::uuid
    `)) as unknown as Array<{ n: number }>;
    expect(row!.n).toBe(0);
  });

  runDb('Case 7b: org merge REPOINTS events and drops only the graph_id collision', async () => {
    const prior = process.env.ORG_MERGE_FENCE_DRAIN_MS;
    process.env.ORG_MERGE_FENCE_DRAIN_MS = '0';
    try {
      const fx = await withSystemDbAccessContext(async () => {
        const loser = await seedOrg('merge-loser');
        const survivor = await createOrganization({ partnerId: loser.partner.id });
        const actor = await createUser({
          partnerId: loser.partner.id,
          email: `m365-signin-events-merge-${randomUUID()}@example.com`,
        });
        return { loser, survivor, actor };
      });
      const L = fx.loser.org.id;
      const S = fx.survivor.id;
      const shared = randomUUID();
      const loserOnly = randomUUID();
      await withSystemDbAccessContext(() => db.insert(m365SigninEvents).values([
        { orgId: L, tenantId: fx.loser.tenantId, graphId: shared, signedInAt: new Date('2026-09-01T00:00:00Z') },
        { orgId: L, tenantId: fx.loser.tenantId, graphId: loserOnly, signedInAt: new Date('2026-09-02T00:00:00Z') },
        { orgId: S, tenantId: fx.loser.tenantId, graphId: shared, signedInAt: new Date('2026-09-03T00:00:00Z') },
      ]));

      const result = await executeOrgMerge({
        loserOrgId: L, survivorOrgId: S, partnerId: fx.loser.partner.id,
        performedBy: fx.actor.id, performedByEmail: fx.actor.email,
      });
      // THE assertion that proves the Task 4 classification. A resolve-phase
      // delete (the disposition the five re-derivable M365 snapshot tables use)
      // would report moved: 0 here and destroy sign-in history Graph cannot
      // reproduce — it retains only ~30 days.
      expect(result.tables.m365_signin_events).toEqual({ moved: 1, dropped: 1 });

      const rows = (await (getTestDb() as typeof db).execute(sql`
        SELECT org_id, graph_id FROM m365_signin_events
        WHERE org_id IN (${L}::uuid, ${S}::uuid) ORDER BY graph_id
      `)) as unknown as Array<{ org_id: string; graph_id: string }>;
      expect(rows.every((r) => r.org_id === S)).toBe(true);
      expect(rows.map((r) => r.graph_id).sort()).toEqual([loserOnly, shared].sort());
    } finally {
      if (prior === undefined) delete process.env.ORG_MERGE_FENCE_DRAIN_MS;
      else process.env.ORG_MERGE_FENCE_DRAIN_MS = prior;
    }
  });
});
