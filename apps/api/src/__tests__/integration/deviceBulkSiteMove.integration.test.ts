/**
 * POST /devices/bulk/site (#9796; spec §4.4, §5) against real Postgres through the real app, the
 * real auth middleware (real MFA claim, real RLS, real allowedSiteIds) and real per-device
 * transactions. Mounted under /api/v1 so the route's selfManagedDbContextRoutes opt-out is the
 * one production uses: no ambient request transaction, one caller-scoped transaction per device.
 *
 * Prerequisites (private per-worktree stack): pnpm test-stack up
 * Run: cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/deviceBulkSiteMove.integration.test.ts
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// A moved device schedules peripheral reconciliation; no queue worker runs here.
vi.mock('../../jobs/peripheralJobs', () => ({ schedulePeripheralPolicyDevice: vi.fn().mockResolvedValue('job-id') }));

import { devices, organizationUsers } from '../../db/schema';
import { deviceRoutes } from '../../routes/devices';
import { BULK_SITE_MOVE_CAP } from '../../routes/devices/schemas';
import { createAccessToken, type TokenPayload } from '../../services/jwt';
import { clearPermissionCache } from '../../services/permissions';
import { createOrganization, createSite, setupTestEnvironment, type TestEnvironment } from './db-utils';
import { getTestDb } from './setup';

const app = new Hono();
app.route('/api/v1/devices', deviceRoutes);

const bulk = (token: string, body: unknown) => app.request('/api/v1/devices/bulk/site', {
  method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const patch = (token: string, deviceId: string, body: unknown) => app.request(`/api/v1/devices/${deviceId}`, {
  method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

/** A session that satisfies requireMfa (the fixture token is mfa:false). */
async function assuredToken(env: TestEnvironment, scope: 'organization' | 'partner' = 'organization'): Promise<string> {
  const payload: Omit<TokenPayload, 'type'> = {
    sub: env.user.id, email: env.user.email, roleId: env.role.id,
    orgId: scope === 'organization' ? env.organization.id : null, partnerId: env.partner.id,
    scope, mfa: true, aep: 1, mep: 1, sid: randomUUID(),
  };
  return createAccessToken(payload);
}

async function insertDevice(orgId: string, siteId: string, label: string): Promise<string> {
  const suffix = randomUUID();
  const [row] = await getTestDb().insert(devices).values({
    orgId, siteId, agentId: `bulk-site-${label}-${suffix}`, hostname: `${label}-${suffix.slice(0, 6)}`, osType: 'windows',
    osVersion: '11', architecture: 'x64', agentVersion: 'test', status: 'online', lastSeenAt: new Date(),
  }).returning({ id: devices.id });
  return row!.id;
}

const siteOf = async (deviceId: string) =>
  ((await getTestDb().execute(sql`SELECT site_id::text AS site_id FROM devices WHERE id = ${deviceId}::uuid`)) as unknown as { site_id: string }[])[0]!.site_id;
const auditRows = async (ids: string[]) => (await getTestDb().execute(sql`SELECT resource_id::text AS id, action, details FROM audit_logs
  WHERE action IN ('device.update', 'device.site_move') AND resource_id = ANY(${`{${ids.join(',')}}`}::uuid[])`)) as unknown as
  { id: string; action: string; details: Record<string, unknown> }[];
/** Audits are written through the route audit queue: poll for up to 3 s. */
async function waitForAudits(ids: string[], count: number) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const rows = await auditRows(ids);
    if (rows.length >= count) return rows;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return auditRows(ids);
}
const settleThenAudits = async (ids: string[]) => {
  await new Promise((resolve) => setTimeout(resolve, 300)); // a wrong audit would have landed by now
  return auditRows(ids);
};

async function restrictUserToSites(env: TestEnvironment, siteIds: string[] | null) {
  await getTestDb().update(organizationUsers).set({ siteIds }).where(and(
    eq(organizationUsers.userId, env.user.id), eq(organizationUsers.orgId, env.organization.id),
  ));
  await clearPermissionCache(env.user.id);
}

async function fixture() {
  const env = await setupTestEnvironment({ scope: 'organization' });
  const orgId = env.organization.id;
  const siteA1 = env.site.id;
  const siteA2 = (await createSite({ orgId, name: 'Lakeside' })).id;
  const siteA3 = (await createSite({ orgId, name: 'Warehouse' })).id;
  const d1 = await insertDevice(orgId, siteA1, 'FRONTDESK');
  const d2 = await insertDevice(orgId, siteA1, 'LAB');
  const d3 = await insertDevice(orgId, siteA3, 'SERVER');
  // A denormalized child row that must follow the move (DEVICE_SITE_DENORMALIZED_TABLES).
  await getTestDb().execute(sql`INSERT INTO elevation_requests (org_id, site_id, device_id, flow_type, subject_username, reason, target_executable_path)
    VALUES (${orgId}::uuid, ${siteA1}::uuid, ${d1}::uuid, 'uac_intercept', 'frontdesk', 'Install the imaging bridge', 'C:\\Tools\\setup.exe')`);
  return { env, orgId, siteA1, siteA2, siteA3, d1, d2, d3, token: await assuredToken(env) };
}

describe('POST /devices/bulk/site (real Postgres)', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => { f = await fixture(); });

  it('happy path: 3 moved, committed, denormalized site_id rewritten, 3 × 2 audit rows tagged bulk', async () => {
    const res = await bulk(f.token, { siteId: f.siteA2, devices: [
      { id: f.d1, expectedSiteId: f.siteA1 }, { id: f.d2, expectedSiteId: f.siteA1 }, { id: f.d3, expectedSiteId: f.siteA3 },
    ] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      results: [{ id: f.d1, outcome: 'moved' }, { id: f.d2, outcome: 'moved' }, { id: f.d3, outcome: 'moved' }],
      summary: { moved: 3, total: 3 },
    });
    for (const id of [f.d1, f.d2, f.d3]) expect(await siteOf(id)).toBe(f.siteA2);
    const children = (await getTestDb().execute(sql`SELECT site_id::text AS site_id FROM elevation_requests WHERE device_id = ${f.d1}::uuid`)) as unknown as { site_id: string }[];
    expect(children.map((c) => c.site_id)).toEqual([f.siteA2]);

    const audits = await waitForAudits([f.d1, f.d2, f.d3], 6);
    expect(audits).toHaveLength(6);
    for (const id of [f.d1, f.d2, f.d3]) {
      expect(audits.filter((a) => a.id === id).map((a) => a.action).sort()).toEqual(['device.site_move', 'device.update']);
    }
    const d3Move = audits.find((a) => a.id === f.d3 && a.action === 'device.site_move')!;
    expect(d3Move.details).toMatchObject({ fromSiteId: f.siteA3, fromSiteName: 'Warehouse', toSiteId: f.siteA2, toSiteName: 'Lakeside',
      expectedSiteId: f.siteA3, trigger: 'manual', bulk: true });
    expect(audits.find((a) => a.id === f.d1 && a.action === 'device.update')!.details).toMatchObject({ changedFields: ['siteId'], bulk: true });
  });

  it('partial: a stale expectedSiteId conflicts for that device; the others are committed (re-read after the response)', async () => {
    const res = await bulk(f.token, { siteId: f.siteA2, devices: [
      { id: f.d1, expectedSiteId: f.siteA1 }, { id: f.d2, expectedSiteId: f.siteA3 }, { id: f.d3, expectedSiteId: f.siteA3 },
    ] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results.map((r: { outcome: string }) => r.outcome)).toEqual(['moved', 'conflict', 'moved']);
    expect(body.results[1]).toMatchObject({ id: f.d2, currentSiteId: f.siteA1 });
    expect(body.summary).toEqual({ moved: 2, total: 3 });
    expect(await siteOf(f.d1)).toBe(f.siteA2);
    expect(await siteOf(f.d2)).toBe(f.siteA1);
    expect(await siteOf(f.d3)).toBe(f.siteA2);
    await waitForAudits([f.d1, f.d3], 4);
    expect(await settleThenAudits([f.d2])).toHaveLength(0);
  });

  it('already_there writes nothing and no audit', async () => {
    const res = await bulk(f.token, { siteId: f.siteA1, devices: [{ id: f.d1, expectedSiteId: f.siteA1 }] });
    expect((await res.json()).results).toEqual([{ id: f.d1, outcome: 'already_there' }]);
    expect(await settleThenAudits([f.d1])).toHaveLength(0);
  });

  it('site-scoped session: an out-of-allowlist SOURCE is forbidden for that device; the in-scope one moves', async () => {
    await restrictUserToSites(f.env, [f.siteA1, f.siteA2]);
    const res = await bulk(f.token, { siteId: f.siteA2, devices: [{ id: f.d1, expectedSiteId: f.siteA1 }, { id: f.d3, expectedSiteId: f.siteA3 }] });
    expect(res.status).toBe(200);
    expect((await res.json()).results).toEqual([{ id: f.d1, outcome: 'moved' }, { id: f.d3, outcome: 'forbidden', message: 'Access to this site denied' }]);
    expect(await siteOf(f.d3)).toBe(f.siteA3);
  });

  it('site-scoped session: an out-of-allowlist TARGET refuses the whole batch (400 site_not_found), zero writes', async () => {
    await restrictUserToSites(f.env, [f.siteA1]);
    const res = await bulk(f.token, { siteId: f.siteA2, devices: [{ id: f.d1, expectedSiteId: f.siteA1 }, { id: f.d2, expectedSiteId: f.siteA1 }] });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'site_not_found' });
    expect(await siteOf(f.d1)).toBe(f.siteA1);
    expect(await siteOf(f.d2)).toBe(f.siteA1);
    expect(await settleThenAudits([f.d1, f.d2])).toHaveLength(0);
  });

  it('org-scoped session: another org\'s device is not_found (no leak) and untouched; another org\'s site is site_not_found', async () => {
    const other = await setupTestEnvironment({ scope: 'organization' });
    const foreign = await insertDevice(other.organization.id, other.site.id, 'FOREIGN');
    const res = await bulk(f.token, { siteId: f.siteA2, devices: [{ id: f.d1, expectedSiteId: f.siteA1 }, { id: foreign, expectedSiteId: other.site.id }] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results).toEqual([{ id: f.d1, outcome: 'moved' }, { id: foreign, outcome: 'not_found' }]);
    expect(JSON.stringify(body)).not.toContain(other.site.id);
    expect(await siteOf(foreign)).toBe(other.site.id);

    const toForeignSite = await bulk(f.token, { siteId: other.site.id, devices: [{ id: f.d2, expectedSiteId: f.siteA1 }] });
    expect(toForeignSite.status).toBe(400);
    expect(await toForeignSite.json()).toMatchObject({ code: 'site_not_found' });
    expect(await siteOf(f.d2)).toBe(f.siteA1);
  });

  it('partner session, devices in two orgs → 400 mixed_org with zero writes', async () => {
    const p = await setupTestEnvironment({ scope: 'partner' });
    const token = await assuredToken(p, 'partner');
    const orgB = await createOrganization({ partnerId: p.partner.id });
    const siteB = (await createSite({ orgId: orgB.id })).id;
    const siteA2 = (await createSite({ orgId: p.organization.id, name: 'Annex' })).id;
    const inA = await insertDevice(p.organization.id, p.site.id, 'PA');
    const inB = await insertDevice(orgB.id, siteB, 'PB');
    const res = await bulk(token, { siteId: siteA2, devices: [{ id: inA, expectedSiteId: p.site.id }, { id: inB, expectedSiteId: siteB }] });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'mixed_org' });
    expect(await siteOf(inA)).toBe(p.site.id);
    expect(await siteOf(inB)).toBe(siteB);
    expect(await settleThenAudits([inA, inB])).toHaveLength(0);

    // The same partner moving one org's devices to the OTHER org's site → site_org_mismatch.
    const mismatch = await bulk(token, { siteId: siteB, devices: [{ id: inA, expectedSiteId: p.site.id }] });
    expect(mismatch.status).toBe(400);
    expect(await mismatch.json()).toMatchObject({ code: 'site_org_mismatch' });
    // And a single-org partner batch moves.
    const ok = await bulk(token, { siteId: siteA2, devices: [{ id: inA, expectedSiteId: p.site.id }] });
    expect((await ok.json()).results).toEqual([{ id: inA, outcome: 'moved' }]);
  });

  it('a Postgres error on device 2 of 3 rolls back only that device: [moved, error, moved], no audit for it', async () => {
    // A real database failure inside device 2's own transaction (raised by a trigger on its UPDATE).
    const fn = `bulk_site_fail_${randomUUID().replace(/-/g, '')}`;
    await getTestDb().execute(sql.raw(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF OLD.id = '${f.d2}'::uuid THEN RAISE EXCEPTION 'injected failure for bulk site move test'; END IF; RETURN NEW; END $$`));
    await getTestDb().execute(sql.raw(`CREATE TRIGGER ${fn} BEFORE UPDATE OF site_id ON devices FOR EACH ROW EXECUTE FUNCTION ${fn}()`));
    try {
      const res = await bulk(f.token, { siteId: f.siteA2, devices: [
        { id: f.d1, expectedSiteId: f.siteA1 }, { id: f.d2, expectedSiteId: f.siteA1 }, { id: f.d3, expectedSiteId: f.siteA3 },
      ] });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.results).toEqual([{ id: f.d1, outcome: 'moved' }, { id: f.d2, outcome: 'error', message: 'Move failed' }, { id: f.d3, outcome: 'moved' }]);
      expect(JSON.stringify(body)).not.toContain('injected');
      expect(await siteOf(f.d1)).toBe(f.siteA2);
      expect(await siteOf(f.d2)).toBe(f.siteA1);
      expect(await siteOf(f.d3)).toBe(f.siteA2);
      await waitForAudits([f.d1, f.d3], 4);
      expect(await settleThenAudits([f.d2])).toHaveLength(0);
    } finally {
      await getTestDb().execute(sql.raw(`DROP TRIGGER IF EXISTS ${fn} ON devices`));
      await getTestDb().execute(sql.raw(`DROP FUNCTION IF EXISTS ${fn}()`));
    }
  });

  it('PATCH (shared service): a partner moving a device into ANOTHER org\'s site → 400, zero writes', async () => {
    const p = await setupTestEnvironment({ scope: 'partner' });
    const token = await assuredToken(p, 'partner');
    const orgB = await createOrganization({ partnerId: p.partner.id });
    const siteB = (await createSite({ orgId: orgB.id })).id;
    const device = await insertDevice(p.organization.id, p.site.id, 'XORG');
    const res = await patch(token, device, { siteId: siteB, expectedSiteId: p.site.id });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Target site not found or belongs to a different organization' });
    expect(await siteOf(device)).toBe(p.site.id);
    expect(await settleThenAudits([device])).toHaveLength(0);
  });

  it('duplicate ids → 400 duplicate_device_ids with zero writes', async () => {
    const res = await bulk(f.token, { siteId: f.siteA2, devices: [{ id: f.d1, expectedSiteId: f.siteA1 }, { id: f.d1, expectedSiteId: f.siteA1 }] });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'duplicate_device_ids' });
    expect(await siteOf(f.d1)).toBe(f.siteA1);
    expect(await settleThenAudits([f.d1])).toHaveLength(0);
  });

  it(`cap + 1 (${BULK_SITE_MOVE_CAP + 1}) → 400 with zero writes`, async () => {
    const entries = [{ id: f.d1, expectedSiteId: f.siteA1 },
      ...Array.from({ length: BULK_SITE_MOVE_CAP }, () => ({ id: randomUUID(), expectedSiteId: f.siteA1 }))];
    const res = await bulk(f.token, { siteId: f.siteA2, devices: entries });
    expect(res.status).toBe(400);
    expect(await siteOf(f.d1)).toBe(f.siteA1);
    expect(await settleThenAudits([f.d1])).toHaveLength(0);
  });

  it('a session without MFA → 403 MFA_REQUIRED, zero writes', async () => {
    const res = await bulk(f.env.token, { siteId: f.siteA2, devices: [{ id: f.d1, expectedSiteId: f.siteA1 }] });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'MFA_REQUIRED' });
    expect(await siteOf(f.d1)).toBe(f.siteA1);
  });

  it('a concurrent single PATCH and bulk move on one device: exactly one wins, the other is refused', async () => {
    const [single, batch] = await Promise.all([
      patch(f.token, f.d1, { siteId: f.siteA2, expectedSiteId: f.siteA1 }),
      bulk(f.token, { siteId: f.siteA3, devices: [{ id: f.d1, expectedSiteId: f.siteA1 }] }),
    ]);
    const batchOutcome = ((await batch.json()) as { results: { outcome: string }[] }).results[0]!.outcome;
    const patchWon = single.status === 200;
    expect(patchWon ? batchOutcome : 'moved').toBe(patchWon ? 'conflict' : 'moved');
    if (!patchWon) expect(single.status).toBe(409);
    expect(await siteOf(f.d1)).toBe(patchWon ? f.siteA2 : f.siteA3);
    const moves = (await waitForAudits([f.d1], 2)).filter((a) => a.action === 'device.site_move');
    expect((await settleThenAudits([f.d1])).filter((a) => a.action === 'device.site_move')).toHaveLength(1);
    expect(moves[0]!.details).toMatchObject({ toSiteId: patchWon ? f.siteA2 : f.siteA3 });
  });

  it(`a full batch of ${BULK_SITE_MOVE_CAP} moves inside a normal request (Gate B #2 timing)`, async () => {
    const ids: string[] = [];
    for (let i = 0; i < BULK_SITE_MOVE_CAP; i++) ids.push(await insertDevice(f.orgId, f.siteA1, `CAP${i}`));
    const started = performance.now();
    const res = await bulk(f.token, { siteId: f.siteA2, devices: ids.map((id) => ({ id, expectedSiteId: f.siteA1 })) });
    const elapsedMs = performance.now() - started;
    expect(res.status).toBe(200);
    expect((await res.json()).summary).toEqual({ moved: BULK_SITE_MOVE_CAP, total: BULK_SITE_MOVE_CAP });
    const perDeviceMs = elapsedMs / BULK_SITE_MOVE_CAP;
    // Reported in the PR body (Gate B #2: lower the cap to 50 above ~100 ms/device; measured locally at
    // 17–43 ms/device). The bound here is deliberately loose so a loaded CI shard cannot flake it; it only
    // catches an order-of-magnitude regression such as a lock held across the whole batch.
    process.stderr.write(`[bulk-site-move timing] ${BULK_SITE_MOVE_CAP} devices in ${elapsedMs.toFixed(0)} ms = ${perDeviceMs.toFixed(1)} ms/device\n`);
    expect(perDeviceMs).toBeLessThan(500);
    const moved = (await getTestDb().execute(sql`SELECT count(*)::int AS n FROM devices WHERE org_id = ${f.orgId}::uuid AND site_id = ${f.siteA2}::uuid`)) as unknown as { n: number }[];
    expect(moved[0]!.n).toBe(BULK_SITE_MOVE_CAP);
  });
});
