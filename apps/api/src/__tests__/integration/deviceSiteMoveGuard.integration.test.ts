/**
 * Site-move hardening on PATCH /devices/:id (topology site location W1, #7885; spec S§12),
 * against real Postgres through the real app and auth middleware:
 *  - two concurrent moves of one device: exactly one wins, the other gets 409, never a silent overwrite;
 *  - a move racing a committed site change it cannot see yet is refused by the DB-level guard
 *    (row lock + re-read), deterministically, without any expectedSiteId;
 *  - exactly one post-commit `device.site_move` audit per successful move.
 *
 * Prerequisites (private per-worktree stack): pnpm test-stack up
 * Run: cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/deviceSiteMoveGuard.integration.test.ts
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The site change schedules peripheral reconciliation; no queue worker runs here.
vi.mock('../../jobs/peripheralJobs', () => ({ schedulePeripheralPolicyDevice: vi.fn().mockResolvedValue('job-id') }));

import { devices } from '../../db/schema';
import { deviceRoutes } from '../../routes/devices';
import { createAccessToken, type TokenPayload } from '../../services/jwt';
import { createSite, setupTestEnvironment } from './db-utils';
import { getTestDb } from './setup';

type Env = Awaited<ReturnType<typeof setupTestEnvironment>>;

async function fixture() {
  const env = await setupTestEnvironment({ scope: 'organization' });
  const orgId = env.organization.id;
  const siteA = env.site.id;
  const siteB = (await createSite({ orgId, name: 'Lakeside' })).id;
  const siteC = (await createSite({ orgId, name: 'Annex' })).id;
  const suffix = randomUUID();
  const [device] = await getTestDb().insert(devices).values({
    orgId, siteId: siteA, agentId: `site-move-${suffix}`, hostname: `FRONTDESK-${suffix.slice(0, 6)}`, osType: 'windows', osVersion: '11',
    architecture: 'x64', agentVersion: 'test', status: 'online', lastSeenAt: new Date(),
  }).returning({ id: devices.id });
  if (!device) throw new Error('fixture device insert failed');
  // A denormalized child row that must follow the winning move (DEVICE_SITE_DENORMALIZED_TABLES).
  await getTestDb().execute(sql`INSERT INTO elevation_requests (org_id, site_id, device_id, flow_type, subject_username, reason, target_executable_path)
    VALUES (${orgId}::uuid, ${siteA}::uuid, ${device.id}::uuid, 'uac_intercept', 'frontdesk', 'Install the imaging bridge', 'C:\\Tools\\setup.exe')`);
  return { env, orgId, siteA, siteB, siteC, deviceId: device.id, token: await assuredToken(env) };
}

/** An org-admin session that satisfies requireMfa (the fixture token is mfa:false). */
async function assuredToken(env: Env): Promise<string> {
  const payload: Omit<TokenPayload, 'type'> = { sub: env.user.id, email: env.user.email, roleId: env.role.id, orgId: env.organization.id,
    partnerId: env.partner.id, scope: 'organization', mfa: true, aep: 1, mep: 1, sid: randomUUID() };
  return createAccessToken(payload);
}

const app = new Hono();
app.route('/devices', deviceRoutes);
const patch = (token: string, deviceId: string, body: unknown) => app.request(`/devices/${deviceId}`, {
  method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

const currentSite = async (deviceId: string) =>
  ((await getTestDb().execute(sql`SELECT site_id::text AS site_id FROM devices WHERE id = ${deviceId}::uuid`)) as unknown as { site_id: string }[])[0]!.site_id;
const siteMoveAudits = async (deviceId: string) => (await getTestDb().execute(sql`SELECT details FROM audit_logs
  WHERE action = 'device.site_move' AND resource_id = ${deviceId}::uuid`)) as unknown as { details: Record<string, unknown> }[];
/** The audit is written after commit through the route audit queue: poll for up to 2 s. */
async function waitForAudits(deviceId: string, count: number) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const rows = await siteMoveAudits(deviceId);
    if (rows.length >= count) return rows;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return siteMoveAudits(deviceId);
}

describe('PATCH /devices/:id site-move guard (real Postgres)', () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => { f = await fixture(); });

  it('concurrent PATCH site moves: one wins, one 409', async () => {
    // Both clients saw the device in site A (the web modal always sends expectedSiteId).
    const [toB, toC] = await Promise.all([
      patch(f.token, f.deviceId, { siteId: f.siteB, expectedSiteId: f.siteA }),
      patch(f.token, f.deviceId, { siteId: f.siteC, expectedSiteId: f.siteA }),
    ]);
    const statuses = [toB.status, toC.status].sort();
    expect(statuses).toEqual([200, 409]);
    const winner = toB.status === 200 ? f.siteB : f.siteC;
    const loser = toB.status === 200 ? toC : toB;
    expect(await loser.json()).toEqual({ error: 'device_site_changed', currentSiteId: winner });
    expect(await currentSite(f.deviceId)).toBe(winner);

    const audits = await waitForAudits(f.deviceId, 1);
    await new Promise((resolve) => setTimeout(resolve, 200)); // a second (wrong) audit would have landed by now
    expect(await siteMoveAudits(f.deviceId)).toHaveLength(1);
    expect(audits[0]!.details).toMatchObject({ fromSiteId: f.siteA, toSiteId: winner, expectedSiteId: f.siteA, trigger: 'manual' });
  });

  it('a move racing an uncommitted site change is refused by the row lock, without expectedSiteId', async () => {
    // A competing writer holds the device row, moves it to C and commits only after the PATCH has passed
    // its access check (device read in A) and is waiting on the row. Deterministic: no timing luck needed.
    let patchResponse: Promise<Response> | undefined;
    await getTestDb().transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM devices WHERE id = ${f.deviceId}::uuid FOR UPDATE`);
      patchResponse = Promise.resolve(patch(f.token, f.deviceId, { siteId: f.siteB }));
      // Wait until the PATCH's backend is actually blocked on our row lock.
      let blocked = false;
      for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        const rows = (await getTestDb().execute(sql`SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE wait_event_type = 'Lock' AND query ILIKE '%from "devices"%for update%'`)) as unknown as { n: number }[];
        blocked = rows[0]!.n > 0;
      }
      expect(blocked).toBe(true);
      await tx.execute(sql`UPDATE devices SET site_id = ${f.siteC}::uuid WHERE id = ${f.deviceId}::uuid`);
    });
    const response = await patchResponse!;
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'device_site_changed', currentSiteId: f.siteC });
    expect(await currentSite(f.deviceId)).toBe(f.siteC);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await siteMoveAudits(f.deviceId)).toHaveLength(0);
  });

  it('a stale expectedSiteId is refused before any write; a correct one moves the device and its denormalized rows', async () => {
    const before = ((await getTestDb().execute(sql`SELECT updated_at FROM devices WHERE id = ${f.deviceId}::uuid`)) as unknown as { updated_at: unknown }[])[0];
    const stale = await patch(f.token, f.deviceId, { siteId: f.siteC, expectedSiteId: f.siteB, displayName: 'Front desk' });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: 'device_site_changed', currentSiteId: f.siteA });
    const after = ((await getTestDb().execute(sql`SELECT updated_at, display_name FROM devices WHERE id = ${f.deviceId}::uuid`)) as unknown as { updated_at: unknown; display_name: string | null }[])[0];
    expect(after!.updated_at).toEqual(before!.updated_at);
    expect(after!.display_name).toBeNull();

    const moved = await patch(f.token, f.deviceId, { siteId: f.siteB, expectedSiteId: f.siteA });
    expect(moved.status).toBe(200);
    expect(await currentSite(f.deviceId)).toBe(f.siteB);
    const children = (await getTestDb().execute(sql`SELECT site_id::text AS site_id FROM elevation_requests WHERE device_id = ${f.deviceId}::uuid`)) as unknown as { site_id: string }[];
    expect(children.map((child) => child.site_id)).toEqual([f.siteB]);
    const [audit] = await waitForAudits(f.deviceId, 1);
    expect(audit!.details).toMatchObject({ fromSiteId: f.siteA, toSiteId: f.siteB, toSiteName: 'Lakeside', expectedSiteId: f.siteA, trigger: 'manual' });
  });
});
