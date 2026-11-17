/**
 * Wisp analysis sessions W05 carry-over: `metrics`, `vulnerabilities` and
 * `custom_fields` on real Postgres, set-based, as the unprivileged app role
 * under forced RLS.
 *
 * What only a real database shows: the org axis comes from RLS plus the
 * adapter's own `org_id` predicate, the site axis comes only from the run's
 * device set, the `(device_id, timestamp)` / `(device_id, id)` / `id` keyset
 * cursors neither repeat nor skip, partner-wide custom-field definitions
 * (`org_id IS NULL`) are read, and the no-frame fallback exports exactly the
 * devices the caller listed.
 *
 * Fixtures are re-seeded per test (the integration setup truncates between
 * tests).
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { DATASET_ADAPTERS, EXPORT_DATASETS, type DatasetRequest, type ExportDataset } from '../../services/aiToolsExportDatasets';
import type { AuthContext } from '../../middleware/auth';
import { createDevice, createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

type Tenant = {
  partner: string; orgA: string; orgB: string; siteS1: string; siteS2: string;
  a1: string; a2: string; b1: string;
};

async function seedTenant(): Promise<Tenant> {
  return withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    const s1 = await createSite({ orgId: orgA.id });
    const s2 = await createSite({ orgId: orgA.id });
    const sB = await createSite({ orgId: orgB.id });
    const a1 = await createDevice({ orgId: orgA.id, siteId: s1.id, hostname: 'a1' });
    const a2 = await createDevice({ orgId: orgA.id, siteId: s2.id, hostname: 'a2' });
    const b1 = await createDevice({ orgId: orgB.id, siteId: sB.id, hostname: 'b1' });
    return {
      partner: partner.id, orgA: orgA.id, orgB: orgB.id, siteS1: s1.id, siteS2: s2.id,
      a1: a1.id, a2: a2.id, b1: b1.id,
    };
  });
}

function orgCtx(orgId: string, currentPartnerId?: string): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], userId: null, currentPartnerId };
}

/** An org context that can see both orgs (the `[A, B]` case). */
function multiCtx(orgId: string, other: string, currentPartnerId?: string): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId, other], userId: null, currentPartnerId };
}

/** An analysis run's auth: an ai_agent principal pinned to the frame (agentAuthContext). */
function runAuth(orgId: string, frame: string[], o: { sites?: string[]; partnerId?: string } = {}): AuthContext {
  return {
    orgId,
    partnerId: o.partnerId ?? null,
    accessibleOrgIds: [orgId],
    canAccessOrg: (id: string) => id === orgId,
    principal: { kind: 'ai_agent', agentId: randomUUID(), runId: randomUUID() },
    allowedDeviceIds: frame,
    ...(o.sites ? { allowedSiteIds: o.sites, canAccessSite: (s: string | null | undefined) => !!s && o.sites!.includes(s) } : {}),
  } as unknown as AuthContext;
}

function request(orgId: string, frame: string[] | null, o: Partial<DatasetRequest> = {}): DatasetRequest {
  return {
    auth: runAuth(orgId, frame ?? []),
    orgId,
    filters: {},
    deviceIds: null,
    runTargets: frame,
    siteId: null,
    pageSize: 500,
    exportGrants: { datasets: [...EXPORT_DATASETS], sensitiveGates: [] },
    notes: [],
    ...o,
  };
}

async function drain(dataset: ExportDataset, req: DatasetRequest, ctx: DbAccessContext = orgCtx(req.orgId)) {
  return withDbAccessContext(ctx, async () => {
    const pager = await DATASET_ADAPTERS[dataset].createPager(req);
    const pages: Array<{ rows: Array<Record<string, unknown>>; nextCursor: string | null }> = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 100; guard++) {
      const page = await pager(cursor);
      pages.push(page);
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    return { pages, rows: pages.flatMap((p) => p.rows) };
  });
}

const devicesOf = (rows: Array<Record<string, unknown>>) => [...new Set(rows.map((r) => r.deviceId as string))].sort();

/** `YYYY-MM-DD HH:MM:SS.ffffff` (UTC) `minsAgo` minutes back, for a `timestamp` literal. */
function minutesAgo(minsAgo: number, micros = '000000'): string {
  return `${new Date(Date.now() - minsAgo * 60_000).toISOString().replace('T', ' ').slice(0, 19)}.${micros}`;
}

async function seedMetric(orgId: string, deviceId: string, ts: string, cpu = 10): Promise<void> {
  await getTestDb().execute(sql`
    INSERT INTO device_metrics (device_id, org_id, "timestamp", cpu_percent, ram_percent, ram_used_mb, disk_percent, disk_used_gb)
    VALUES (${deviceId}, ${orgId}, ${ts}::timestamp, ${cpu}, 20, 3000, 40, 50)`);
}

async function seedCve(label: string): Promise<string> {
  const [row] = await getTestDb().execute(sql`
    INSERT INTO vulnerabilities (cve_id, description, severity, cvss_score, raw_payload)
    VALUES (${`CVE-2026-${label}-${randomUUID().slice(0, 6)}`}, 'test', 'high', 8.8, '{}'::jsonb)
    RETURNING id::text AS id`) as unknown as Array<{ id: string }>;
  return row!.id;
}

async function seedFinding(orgId: string, deviceId: string, vulnerabilityId: string, status = 'open'): Promise<string> {
  const [row] = await getTestDb().execute(sql`
    INSERT INTO device_vulnerabilities (org_id, device_id, vulnerability_id, status, risk_score, detected_at)
    VALUES (${orgId}, ${deviceId}, ${vulnerabilityId}, ${status}, 80, now()::timestamp)
    RETURNING id::text AS id`) as unknown as Array<{ id: string }>;
  return row!.id;
}

async function seedDefinition(o: { orgId: string | null; partnerId: string | null; key: string; name: string }): Promise<void> {
  await getTestDb().execute(sql`
    INSERT INTO custom_field_definitions (org_id, partner_id, name, field_key, type)
    VALUES (${o.orgId}, ${o.partnerId}, ${o.name}, ${o.key}, 'text')`);
}

async function setCustomFields(deviceId: string, values: Record<string, unknown>): Promise<void> {
  await getTestDb().execute(sql`UPDATE devices SET custom_fields = ${JSON.stringify(values)}::jsonb WHERE id = ${deviceId}::uuid`);
}

describe('metrics / vulnerabilities / custom_fields set-based on real Postgres (breeze_app, forced RLS)', () => {
  runDb('the code under test runs as a non-BYPASSRLS role (guards against vacuous RLS)', async () => {
    const t = await seedTenant();
    const rows = await withDbAccessContext(orgCtx(t.orgA), () =>
      db.execute(sql`SELECT current_user AS who, rolbypassrls FROM pg_roles WHERE rolname = current_user`));
    const row = (rows as unknown as Array<{ who: string; rolbypassrls: boolean }>)[0];
    expect(row?.who).toBe('breeze_app');
    expect(row?.rolbypassrls).toBe(false);
  });

  describe('metrics', () => {
    async function seed(t: Tenant) {
      for (const [org, dev] of [[t.orgA, t.a1], [t.orgA, t.a2], [t.orgB, t.b1]] as const) {
        await seedMetric(org, dev, minutesAgo(10));
        await seedMetric(org, dev, minutesAgo(20));
      }
    }

    runDb('non-vacuity: the seeded org-B rows exist and are only hidden by the adapter + RLS', async () => {
      const t = await seedTenant();
      await seed(t);
      const [count] = await getTestDb().execute(sql`SELECT count(*)::int AS n FROM device_metrics WHERE org_id = ${t.orgB}`) as unknown as Array<{ n: number }>;
      expect(count!.n).toBe(2);
    });

    runDb('org isolation under org-A and [A, B] contexts: frame [A1, A2, B1] never reads B1', async () => {
      const t = await seedTenant();
      await seed(t);
      for (const ctx of [orgCtx(t.orgA), multiCtx(t.orgA, t.orgB)]) {
        const { rows } = await drain('metrics', request(t.orgA, [t.a1, t.a2, t.b1]), ctx);
        expect(devicesOf(rows)).toEqual([t.a1, t.a2].sort());
        expect(rows).toHaveLength(4);
      }
    });

    runDb('site restriction applies through the device set; a frame of only B1 exports nothing', async () => {
      const t = await seedTenant();
      await seed(t);
      const frame = [t.a1, t.a2];
      const { rows } = await drain('metrics', request(t.orgA, frame, { auth: runAuth(t.orgA, frame, { sites: [t.siteS1] }) }));
      expect(devicesOf(rows)).toEqual([t.a1]);
      expect((await drain('metrics', request(t.orgA, [t.b1]))).rows).toEqual([]);
    });

    runDb('paging at pageSize 1 across 2 devices x 3 samples: 6 rows, (deviceId, timestamp) ascending, no repeat, null last cursor', async () => {
      const t = await seedTenant();
      for (const dev of [t.a1, t.a2]) {
        for (const [i, micros] of [[30, '123003'], [20, '123002'], [10, '123001']] as const) {
          await seedMetric(t.orgA, dev, minutesAgo(i, micros));
        }
      }
      const { pages, rows } = await drain('metrics', request(t.orgA, [t.a1, t.a2], { pageSize: 1 }));
      expect(rows).toHaveLength(6);
      expect(pages).toHaveLength(6);
      expect(pages[pages.length - 1]!.nextCursor).toBeNull();
      const keys = rows.map((r) => `${r.deviceId}|${r.timestamp}`);
      expect(new Set(keys).size).toBe(6);
      const expected = (await getTestDb().execute(sql`
        SELECT device_id::text AS device_id, to_char("timestamp", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ts FROM device_metrics
        WHERE org_id = ${t.orgA} ORDER BY device_id, "timestamp"`) as unknown as Array<{ device_id: string; ts: string }>)
        .map((r) => `${r.device_id}|${r.ts}`);
      expect(keys).toEqual(expected);
    });

    runDb('hoursBack bounds the window', async () => {
      const t = await seedTenant();
      await seedMetric(t.orgA, t.a1, minutesAgo(60 * 2));
      await seedMetric(t.orgA, t.a1, minutesAgo(60 * 30));
      expect((await drain('metrics', request(t.orgA, [t.a1]))).rows).toHaveLength(1); // default 24 h
      expect((await drain('metrics', request(t.orgA, [t.a1], { filters: { hoursBack: 48 } }))).rows).toHaveLength(2);
      expect((await drain('metrics', request(t.orgA, [t.a1], { filters: { hoursBack: 1 } }))).rows).toEqual([]);
    });

    runDb('no frame: a run that lists deviceIds exports those devices; with neither it exports nothing', async () => {
      const t = await seedTenant();
      await seed(t);
      const listed = await drain('metrics', request(t.orgA, null, { deviceIds: [t.a1], auth: runAuth(t.orgA, [t.a1, t.a2]) }));
      expect(devicesOf(listed.rows)).toEqual([t.a1]);
      expect(listed.rows).toHaveLength(2);
      const neither = await drain('metrics', request(t.orgA, null, { auth: runAuth(t.orgA, [t.a1, t.a2]) }));
      expect(neither.rows).toEqual([]);
    });
  });

  describe('vulnerabilities', () => {
    async function seed(t: Tenant) {
      const cve = await seedCve('iso');
      for (const [org, dev] of [[t.orgA, t.a1], [t.orgA, t.a2], [t.orgB, t.b1]] as const) {
        await seedFinding(org, dev, cve);
        await seedFinding(org, dev, cve);
      }
    }

    runDb('non-vacuity: org-B findings exist', async () => {
      const t = await seedTenant();
      await seed(t);
      const [count] = await getTestDb().execute(sql`SELECT count(*)::int AS n FROM device_vulnerabilities WHERE org_id = ${t.orgB}`) as unknown as Array<{ n: number }>;
      expect(count!.n).toBe(2);
    });

    runDb('org isolation under org-A and [A, B] contexts: frame [A1, A2, B1] never reads B1', async () => {
      const t = await seedTenant();
      await seed(t);
      for (const ctx of [orgCtx(t.orgA), multiCtx(t.orgA, t.orgB)]) {
        const { rows } = await drain('vulnerabilities', request(t.orgA, [t.a1, t.a2, t.b1]), ctx);
        expect(devicesOf(rows)).toEqual([t.a1, t.a2].sort());
        expect(rows).toHaveLength(4);
        expect(rows[0]).toHaveProperty('hostname');
      }
    });

    runDb('site restriction applies through the device set; a frame of only B1 exports nothing', async () => {
      const t = await seedTenant();
      await seed(t);
      const frame = [t.a1, t.a2];
      const { rows } = await drain('vulnerabilities', request(t.orgA, frame, { auth: runAuth(t.orgA, frame, { sites: [t.siteS1] }) }));
      expect(devicesOf(rows)).toEqual([t.a1]);
      expect((await drain('vulnerabilities', request(t.orgA, [t.b1]))).rows).toEqual([]);
    });

    runDb('status filter: default open, patched, all', async () => {
      const t = await seedTenant();
      const cve = await seedCve('status');
      await seedFinding(t.orgA, t.a1, cve, 'open');
      await seedFinding(t.orgA, t.a1, cve, 'patched');
      const statuses = async (filters: Record<string, unknown>) =>
        (await drain('vulnerabilities', request(t.orgA, [t.a1], { filters }))).rows.map((r) => r.status).sort();
      expect(await statuses({})).toEqual(['open']);
      expect(await statuses({ status: 'patched' })).toEqual(['patched']);
      expect(await statuses({ status: 'all' })).toEqual(['open', 'patched']);
    });

    runDb('paging at pageSize 1: a finding whose catalog row is missing is skipped, the others appear once, last cursor null', async () => {
      const t = await seedTenant();
      const cves = [await seedCve('p1'), await seedCve('p2'), await seedCve('p3'), await seedCve('p4')];
      const ids: string[] = [];
      for (const [i, cve] of cves.entries()) ids.push(await seedFinding(t.orgA, i % 2 === 0 ? t.a1 : t.a2, cve));
      // Remove one catalog row behind the FK (replica role skips the FK triggers).
      const orphaned = cves[1]!;
      await getTestDb().transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL session_replication_role = replica`);
        await tx.execute(sql`DELETE FROM vulnerabilities WHERE id = ${orphaned}::uuid`);
      });
      const orphanFinding = ids[1]!;
      const { pages, rows } = await drain('vulnerabilities', request(t.orgA, [t.a1, t.a2], { pageSize: 1 }));
      expect(pages[pages.length - 1]!.nextCursor).toBeNull();
      expect(rows.map((r) => r.id).sort()).toEqual(ids.filter((x) => x !== orphanFinding).sort());
      expect(new Set(rows.map((r) => r.id)).size).toBe(3);
      // device-major, then id ascending
      const keys = rows.map((r) => `${r.deviceId}|${r.id}`);
      expect(keys).toEqual([...keys].sort());
      // the skipped finding consumed a page: 4 fetched pages worth, 3 with rows
      expect(pages.filter((p) => p.rows.length === 0).length).toBe(1);
    });

    runDb('no frame: a run that lists deviceIds exports those devices; with neither it exports nothing', async () => {
      const t = await seedTenant();
      await seed(t);
      const listed = await drain('vulnerabilities', request(t.orgA, null, { deviceIds: [t.a1], auth: runAuth(t.orgA, [t.a1, t.a2]) }));
      expect(devicesOf(listed.rows)).toEqual([t.a1]);
      expect((await drain('vulnerabilities', request(t.orgA, null, { auth: runAuth(t.orgA, [t.a1, t.a2]) }))).rows).toEqual([]);
    });
  });

  describe('custom_fields', () => {
    async function seed(t: Tenant) {
      await seedDefinition({ orgId: t.orgA, partnerId: null, key: 'tier', name: 'Tier' });
      await seedDefinition({ orgId: null, partnerId: t.partner, key: 'contract', name: 'Contract' });
      await setCustomFields(t.a1, { tier: 'gold', contract: 'c-a1' });
      await setCustomFields(t.a2, { tier: 'silver', contract: 'c-a2' });
      await setCustomFields(t.b1, { tier: 'leak', contract: 'c-b1' });
    }
    const authFor = (t: Tenant, frame: string[], sites?: string[]) => runAuth(t.orgA, frame, { partnerId: t.partner, sites });
    // The partner-wide definition is readable through the read-only own-partner branch of the SELECT policy.
    const ctxFor = (t: Tenant) => orgCtx(t.orgA, t.partner);

    runDb('non-vacuity: org-B device carries a value that must never be exported', async () => {
      const t = await seedTenant();
      await seed(t);
      const [row] = await getTestDb().execute(sql`SELECT custom_fields->>'tier' AS tier FROM devices WHERE id = ${t.b1}::uuid`) as unknown as Array<{ tier: string }>;
      expect(row!.tier).toBe('leak');
    });

    runDb('org and partner-wide definitions both appear per device; org isolation under org-A and [A, B] contexts', async () => {
      const t = await seedTenant();
      await seed(t);
      const frame = [t.a1, t.a2, t.b1];
      for (const ctx of [ctxFor(t), multiCtx(t.orgA, t.orgB, t.partner)]) {
        const { rows } = await drain('custom_fields', request(t.orgA, frame, { auth: authFor(t, frame) }), ctx);
        expect(devicesOf(rows)).toEqual([t.a1, t.a2].sort());
        expect(rows).toHaveLength(4);
        const a1 = Object.fromEntries(rows.filter((r) => r.deviceId === t.a1).map((r) => [r.fieldKey, r.value]));
        expect(a1).toEqual({ tier: 'gold', contract: 'c-a1' });
        expect(JSON.stringify(rows)).not.toContain('leak');
      }
    });

    runDb('site restriction applies through the device set; a frame of only B1 exports nothing', async () => {
      const t = await seedTenant();
      await seed(t);
      const frame = [t.a1, t.a2];
      const { rows } = await drain('custom_fields', request(t.orgA, frame, { auth: authFor(t, frame, [t.siteS1]) }), ctxFor(t));
      expect(devicesOf(rows)).toEqual([t.a1]);
      expect((await drain('custom_fields', request(t.orgA, [t.b1], { auth: authFor(t, [t.b1]) }), ctxFor(t))).rows).toEqual([]);
    });

    runDb('paging at pageSize 2 with 2 definitions (one device per page): every device x definition once, null last cursor', async () => {
      const t = await seedTenant();
      await seed(t);
      const frame = [t.a1, t.a2];
      const { pages, rows } = await drain('custom_fields', request(t.orgA, frame, { pageSize: 2, auth: authFor(t, frame) }), ctxFor(t));
      expect(pages).toHaveLength(2);
      expect(pages.every((p) => p.rows.length === 2)).toBe(true);
      expect(pages[pages.length - 1]!.nextCursor).toBeNull();
      expect(rows).toHaveLength(4);
      expect(new Set(rows.map((r) => `${r.deviceId}|${r.fieldKey}`)).size).toBe(4);
      expect(rows.map((r) => r.deviceId)).toEqual([...rows.map((r) => r.deviceId as string)].sort());
    });

    runDb('no frame: a run that lists deviceIds exports those devices; with neither it exports nothing', async () => {
      const t = await seedTenant();
      await seed(t);
      const auth = authFor(t, [t.a1, t.a2]);
      const listed = await drain('custom_fields', request(t.orgA, null, { deviceIds: [t.a1], auth }), ctxFor(t));
      expect(devicesOf(listed.rows)).toEqual([t.a1]);
      expect(listed.rows).toHaveLength(2);
      expect((await drain('custom_fields', request(t.orgA, null, { auth }), ctxFor(t))).rows).toEqual([]);
    });

    runDb('no definitions: nothing exported', async () => {
      const t = await seedTenant();
      await setCustomFields(t.a1, { tier: 'gold' });
      expect((await drain('custom_fields', request(t.orgA, [t.a1], { auth: authFor(t, [t.a1]) }), ctxFor(t))).rows).toEqual([]);
    });
  });
});
