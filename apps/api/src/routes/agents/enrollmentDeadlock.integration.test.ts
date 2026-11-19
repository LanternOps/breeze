/**
 * #9521 — enrollment under a cold ramp: `deadlock detected` on the devices
 * INSERT surfaced to the agent as HTTP 500.
 *
 * The cycle, as Postgres reported it when the storm case below was run
 * against the code before the fix:
 *
 *  - enrollment: `INSERT INTO devices` fires the row trigger
 *    `topology_capture_legacy_change`, which locks the site's
 *    `topology_site_state` row (FOR UPDATE), and only THEN the statement
 *    trigger `breeze_partner_export_devices_insert`, which takes the org's
 *    partner-export advisory lock (1000201) exclusively;
 *  - a device that enrolled a moment earlier sends its first inventory: the
 *    partner-export trigger on its `device_network` write takes the org lock
 *    first, then `markTopologyIdentityDirty` UPDATEs the same
 *    `topology_site_state` row.
 *
 * Opposite orders over the same two locks. The fix takes the org lock in the
 * enrollment's device transaction after the admission and trust gates and
 * before the first devices write, so enrollment follows the report paths'
 * order (export lock, then topology_site_state); a bounded in-handler retry
 * covers any residual lost lock race.
 *
 * The lock-order case below is deterministic: a second connection plays the
 * report side, and its own short `deadlock_timeout` makes IT the victim when a
 * cycle exists, so the assertion is "the report-side UPDATE never deadlocked",
 * not a timing race.
 */
import '../../__tests__/integration/setup';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { and, eq, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { devices, enrollmentKeys } from '../../db/schema';
import { createPartner, createOrganization, createSite } from '../../__tests__/integration/db-utils';
import { getTestDb } from '../../__tests__/integration/setup';
import { hashEnrollmentKey } from '../../services/enrollmentKeySecurity';
import { pgErrorCode } from '../../utils/pgErrors';
import { enrollmentRoutes } from './enrollment';
import { agentRoutes } from './index';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const previousRateLimit = process.env.AGENT_ENROLL_RATE_LIMIT;
afterEach(() => {
  if (previousRateLimit === undefined) delete process.env.AGENT_ENROLL_RATE_LIMIT;
  else process.env.AGENT_ENROLL_RATE_LIMIT = previousRateLimit;
  vi.restoreAllMocks();
});

async function seedTenant() {
  // Every request below comes from the same (unknown) client IP; the per-IP
  // enrollment limiter is not what these cases measure.
  process.env.AGENT_ENROLL_RATE_LIMIT = '100000';
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const rawKey = `deadlock-key-${unique}`;
  const key = await withSystemDbAccessContext(async () => {
    const [row] = await db
      .insert(enrollmentKeys)
      .values({
        orgId: org.id,
        siteId: site.id,
        name: 'Deadlock Test Key',
        key: hashEnrollmentKey(rawKey),
        keySecretHash: null,
        usageCount: 0,
        maxUsage: null,
        expiresAt: null,
      })
      .returning();
    if (!row) throw new Error('seedTenant: no key row');
    return row;
  });
  return { unique, partnerId: partner.id, orgId: org.id, siteId: site.id, rawKey, keyId: key.id };
}

type Tenant = Awaited<ReturnType<typeof seedTenant>>;

function enrollBody(tenant: Tenant, hostname: string, i = 0) {
  return {
    enrollmentKey: tenant.rawKey,
    hostname,
    osType: 'linux' as const,
    osVersion: 'Ubuntu 24.04',
    architecture: 'amd64',
    agentVersion: '1.0.0-test',
    hardwareInfo: {
      cpuModel: 'cpu', cpuCores: 4, cpuThreads: 8, ramTotalMb: 8192, diskTotalGb: 256,
      serialNumber: `SN-${i}`, manufacturer: 'vendor', model: 'model',
    },
    networkInfo: [{
      name: 'eth0',
      mac: `02:42:00:00:${((i >> 8) & 255).toString(16).padStart(2, '0')}:${(i & 255).toString(16).padStart(2, '0')}`,
      ip: `10.64.${(i >> 8) & 255}.${i & 255}`,
      isPrimary: true,
    }],
  };
}

async function enroll(app: Hono, tenant: Tenant, hostname: string, i = 0): Promise<Response> {
  return app.request('/agents/enroll', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(enrollBody(tenant, hostname, i)),
  });
}

function enrollmentApp(): Hono {
  const app = new Hono();
  app.route('/agents', enrollmentRoutes);
  return app;
}

async function devicesNamed(orgId: string, hostname: string) {
  return withSystemDbAccessContext(() =>
    db.select({ id: devices.id }).from(devices)
      .where(and(eq(devices.orgId, orgId), eq(devices.hostname, hostname))));
}

async function keyUsage(keyId: string): Promise<number> {
  const [row] = await withSystemDbAccessContext(() =>
    db.select({ usageCount: enrollmentKeys.usageCount }).from(enrollmentKeys).where(eq(enrollmentKeys.id, keyId)));
  return row?.usageCount ?? -1;
}

/**
 * True once some backend is queued on (not holding) the org's partner-export
 * lock. Mirrors the key `breeze_partner_export_lock_orgs_exclusive` takes,
 * `pg_advisory_xact_lock(1000201, hashtext(org_id::text))`: a two-int4
 * advisory key shows in pg_locks as classid/objid with objsubid 2, objid being
 * the int4 hash read as unsigned. If that key changes, this times out loudly.
 */
async function someoneWaitsOnOrgExportLock(orgId: string): Promise<boolean> {
  const rows = await getTestDb().execute<{ waiting: number }>(sql`
    SELECT count(*)::int AS waiting FROM pg_locks
     WHERE locktype = 'advisory' AND classid = 1000201 AND objsubid = 2 AND NOT granted
       AND objid::bigint = (hashtext(${orgId}::text)::bigint & 4294967295)`);
  return Number(rows[0]?.waiting ?? 0) > 0;
}

async function waitFor(label: string, predicate: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

/**
 * A row trigger on devices that raises a real 40P01 from inside the
 * enrollment's device transaction, AFTER the row is written (so a retry that
 * failed to roll the first attempt back would leave two rows). Gated on one
 * hostname and a sequence: nextval() is not rolled back with the aborted
 * attempt, so exactly `failures` attempts are killed.
 */
async function injectDeadlocks(hostname: string, failures: number): Promise<() => Promise<void>> {
  const tag = randomUUID().replace(/-/g, '').slice(0, 12);
  const seq = `t9521_fault_seq_${tag}`;
  const fn = `t9521_fault_fn_${tag}`;
  const trigger = `t9521_fault_trg_${tag}`;
  const testDb = getTestDb();
  const restore = async () => {
    await testDb.execute(sql.raw(`DROP TRIGGER IF EXISTS ${trigger} ON public.devices`));
    await testDb.execute(sql.raw(`DROP FUNCTION IF EXISTS public.${fn}()`));
    await testDb.execute(sql.raw(`DROP SEQUENCE IF EXISTS public.${seq}`));
  };
  try {
    await testDb.execute(sql.raw(`CREATE SEQUENCE public.${seq}`));
    await testDb.execute(sql.raw(`
      CREATE FUNCTION public.${fn}() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
      SET search_path = pg_catalog, public AS $$
      BEGIN
        IF NEW.hostname = '${hostname.replace(/'/g, "''")}' AND nextval('public.${seq}') <= ${failures} THEN
          RAISE EXCEPTION 'injected deadlock (#9521 test)' USING ERRCODE = '40P01';
        END IF;
        RETURN NULL;
      END $$`));
    await testDb.execute(sql.raw(
      `CREATE TRIGGER ${trigger} AFTER INSERT ON public.devices FOR EACH ROW EXECUTE FUNCTION public.${fn}()`));
  } catch (err) {
    await restore(); // a half-built injection must not outlive this case
    throw err;
  }
  return restore;
}

describe('enrollment deadlock under a cold ramp (#9521)', () => {
  runDb('takes the org export lock before the topology_site_state row, so a first report cannot deadlock it', async () => {
    const tenant = await seedTenant();
    const app = enrollmentApp();
    // The report side UPDATEs an existing row; create it the way the first
    // enrolled device of a site does.
    await getTestDb().execute(sql`
      INSERT INTO topology_site_state (org_id, site_id) VALUES (${tenant.orgId}::uuid, ${tenant.siteId}::uuid)
      ON CONFLICT DO NOTHING`);

    const hostname = `lock-order-${tenant.unique}`;
    let enrollment: Promise<Response> | undefined;
    let reportSideError: unknown;

    try {
      // The report side, as the network-inventory writer runs it: the org's
      // partner-export lock first (its device_network trigger), then the
      // topology identity mark. Its short deadlock_timeout makes it the
      // deadlock victim if a cycle forms, which is what this case detects.
      await getTestDb().transaction(async (report) => {
        await report.execute(sql`SET LOCAL deadlock_timeout = '50ms'`);
        await report.execute(sql`SELECT public.breeze_partner_export_lock_orgs_exclusive(ARRAY[${tenant.orgId}]::uuid[])`);

        enrollment = Promise.resolve(enroll(app, tenant, hostname));
        await waitFor('enrollment queued on the org export lock', () => someoneWaitsOnOrgExportLock(tenant.orgId));

        await report.execute(sql`
          UPDATE topology_site_state
             SET identity_revision = identity_revision + 1, dirty_revision = dirty_revision + 1,
                 last_build_status = 'pending', updated_at = now()
           WHERE org_id = ${tenant.orgId}::uuid AND site_id = ${tenant.siteId}::uuid`);
      });
    } catch (err) {
      reportSideError = err;
    }

    const res = await enrollment!;
    expect(pgErrorCode(reportSideError), 'the report side must not be a deadlock victim').toBeUndefined();
    expect(reportSideError).toBeUndefined();
    expect(res.status).toBe(201);
    expect(await devicesNamed(tenant.orgId, hostname)).toHaveLength(1);
  }, 60_000);

  runDb('retries a deadlocked device write inside the handler: 201, one device, one key use', async () => {
    const tenant = await seedTenant();
    const hostname = `retry-${tenant.unique}`;
    const warn = vi.spyOn(console, 'warn');
    const restore = await injectDeadlocks(hostname, 1);
    try {
      const res = await enroll(enrollmentApp(), tenant, hostname);
      expect(res.status).toBe(201);
      const body = await res.json() as { deviceId: string };
      const rows = await devicesNamed(tenant.orgId, hostname);
      expect(rows.map((r) => r.id)).toEqual([body.deviceId]);
      expect(await keyUsage(tenant.keyId)).toBe(1);
      const lostRaces = warn.mock.calls.filter((args) => /\[enrollment\] transient lock error 40P01/.test(String(args[0])));
      expect(lostRaces).toHaveLength(1);
    } finally {
      await restore();
    }
  }, 60_000);

  runDb('a deadlock that outlasts the bounded retry answers 503 + Retry-After, never 500, and writes nothing', async () => {
    const tenant = await seedTenant();
    const hostname = `exhaust-${tenant.unique}`;
    const warn = vi.spyOn(console, 'warn');
    const restore = await injectDeadlocks(hostname, 1_000);
    try {
      const res = await enroll(enrollmentApp(), tenant, hostname);
      const lostRaces = warn.mock.calls.filter((args) => /\[enrollment\] transient lock error 40P01/.test(String(args[0])));
      expect(lostRaces).toHaveLength(3); // bounded: three attempts, each logged
      expect(res.status).toBe(503);
      expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
      expect(await res.json()).toMatchObject({ reason: 'enrollment_contended' });
      expect(await devicesNamed(tenant.orgId, hostname)).toHaveLength(0);
      expect(await keyUsage(tenant.keyId)).toBe(0);
    } finally {
      await restore();
    }
  }, 60_000);

  runDb('a cold ramp of enrollments, each followed at once by its first reports, never deadlocks an enrollment', async () => {
    const tenant = await seedTenant();
    const warn = vi.spyOn(console, 'warn');
    const app = new Hono();
    app.route('/api/v1/agents', agentRoutes);
    const N = 60;
    const nowIso = () => new Date().toISOString();
    const firstReports = (d: { agentId: string; deviceId: string; hostname: string }) => [
      ['POST', 'heartbeat', { status: 'ok', agentVersion: '1.0.0-test', metricsAvailable: false, hostname: d.hostname, osVersion: 'Ubuntu 24.04', uptime: 60 }],
      ['PUT', 'network', { adapters: [{ interfaceName: 'eth0', macAddress: '02:42:00:00:00:01', ipAddress: '10.64.0.1', ipType: 'ipv4', isPrimary: true }], vpns: [] }],
      ['PUT', 'disks', { disks: [{ mountPoint: '/', device: '/dev/sda1', fsType: 'ext4', totalGb: 500, usedGb: 200, freeGb: 300, usedPercent: 40, health: 'healthy' }] }],
      ['PUT', 'software', {
        schemaVersion: 2, observationId: randomUUID(), collectorVersion: 'test', observedAt: nowIso(), completeness: 'complete',
        expectedSources: ['dpkg'], succeededSources: ['dpkg'], failedSources: [], truncated: false, itemCount: 1,
        items: [{ name: 'curl', version: '8.5.0', vendor: 'Ubuntu' }],
      }],
    ] as const;

    const enrollStatuses = await Promise.all(Array.from({ length: N }, async (_, i) => {
      // ~100/s: a burst well past the issue's 20/s ramp.
      await new Promise((resolve) => setTimeout(resolve, i * 10));
      const hostname = `ramp-${tenant.unique}-${i}`;
      const res = await app.request('/api/v1/agents/enroll', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(enrollBody(tenant, hostname, i)),
      });
      if (res.status !== 201) return res.status;
      const d = { ...(await res.json() as { agentId: string; deviceId: string; authToken: string }), hostname };
      // Report outcomes are not asserted: this case is about enrollment.
      await Promise.all(firstReports(d).map(([method, action, body]) =>
        app.request(`/api/v1/agents/${d.agentId}/${action}`, {
          method,
          headers: { authorization: `Bearer ${d.authToken}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })));
      return 201;
    }));

    // Before the fix: 17 of 60 answered 500 here, and (with only the retry
    // added) 13 of 60 exhausted three deadlocked attempts. The deadlock
    // signature is the retry's 40P01 warning, so that is asserted to be absent.
    // A 503 is tolerated only as a partner-row lock_timeout (55P03): every
    // enrollment of a partner queues on that row, and a slow CI host can push
    // the queue past the admission's 3 s bound, which is load, not this bug.
    const deadlocked = warn.mock.calls.filter((args) => /\[enrollment\] transient lock error 40P01/.test(String(args[0])));
    expect(deadlocked).toEqual([]);
    expect(enrollStatuses.filter((s) => s !== 201 && s !== 503)).toEqual([]);
    const enrolled = enrollStatuses.filter((s) => s === 201).length;
    expect(enrolled).toBeGreaterThan(0);
    const rows = await withSystemDbAccessContext(() =>
      db.select({ id: devices.id }).from(devices).where(eq(devices.orgId, tenant.orgId)));
    expect(rows).toHaveLength(enrolled);
    expect(await keyUsage(tenant.keyId)).toBe(enrolled);
  }, 180_000);
});
