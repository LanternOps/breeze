/**
 * Live-DB regression coverage for the W04a review findings on the public,
 * token-less bare-metal recovery routes (bmrRecoveries.ts):
 *
 *  1. Both public routes (exchange, progress) run their initial hash lookup
 *     with NO ambient DB access context — exactly like production, where
 *     they are mounted before authMiddleware and there is no session to
 *     derive one from. bare_metal_recoveries and recovery_tokens are FORCE
 *     RLS on breeze_has_org_access(org_id); a contextless SELECT resolves
 *     breeze.scope to 'none' and returns zero rows for every real code/token,
 *     which a fully-mocked unit suite can never observe (the mocks just
 *     return whatever they're told regardless of RLS).
 *  2. The code-exchange must be exactly-once under concurrency: two racing
 *     requests for the same code must not both mint a recovery token.
 *
 * Deliberately does NOT wrap app.request() calls in any DB access context —
 * that would mask exactly the bug this file exists to catch. Seeding uses
 * getTestDb() (the superuser client), which bypasses RLS the same way the
 * migration runner does, so seeding needs no context either.
 */
import './setup';

import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { getTestDb } from './setup';
import { createOrganization, createPartner, createSite } from './db-utils';
import {
  backupConfigs,
  backupJobs,
  backupSnapshots,
  bareMetalRecoveries,
  devices,
  recoveryTokens,
} from '../../db/schema';
import { bmrRecoveryPublicRoutes } from '../../routes/backup/bmrRecoveries';
import { hashRecoveryCode, hashRecoveryNonce, normalizeRecoveryCode } from '../../services/bareMetalRecoveryCodes';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function makePublicApp(): Hono {
  const app = new Hono();
  app.route('/', bmrRecoveryPublicRoutes);
  return app;
}

async function seedRecovery(codeSuffix: string, plainCode: string) {
  const testDb = getTestDb();
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const suffix = `${codeSuffix}-${crypto.randomUUID().slice(0, 8)}`;

  const [device] = await testDb.insert(devices).values({
    orgId: org.id,
    siteId: site.id,
    agentId: `bmr-public-${suffix}`,
    hostname: 'bmr-public-host',
    osType: 'linux',
    osVersion: '1',
    architecture: 'amd64',
    agentVersion: '1',
  }).returning();
  if (!device) throw new Error('device fixture insert failed');

  const [config] = await testDb.insert(backupConfigs).values({
    orgId: org.id,
    name: `BMR public ${suffix}`,
    type: 'file',
    provider: 'local',
    providerConfig: { path: `/tmp/bmr-public-${suffix}` },
  }).returning();
  if (!config) throw new Error('config fixture insert failed');

  const [job] = await testDb.insert(backupJobs).values({
    orgId: org.id,
    configId: config.id,
    deviceId: device.id,
    status: 'completed',
  }).returning();
  if (!job) throw new Error('job fixture insert failed');

  const [snapshot] = await testDb.insert(backupSnapshots).values({
    orgId: org.id,
    configId: config.id,
    jobId: job.id,
    deviceId: device.id,
    snapshotId: `bmr-provider-${suffix}`,
    metadata: { platform: 'linux' },
    bareMetalRestorable: true,
  }).returning();
  if (!snapshot) throw new Error('snapshot fixture insert failed');

  const code = normalizeRecoveryCode(plainCode);
  if (!code) throw new Error(`test code did not normalize: ${plainCode}`);

  const [recovery] = await testDb.insert(bareMetalRecoveries).values({
    orgId: org.id,
    deviceId: device.id,
    snapshotId: snapshot.id,
    identity: 'original',
    codeHash: hashRecoveryCode(code),
    codeExpiresAt: new Date(Date.now() + 15 * 60 * 1000),
    // Placeholder, same as the real create route — overwritten at exchange.
    nonceHash: hashRecoveryNonce(crypto.randomUUID()),
    status: 'created',
  }).returning();
  if (!recovery) throw new Error('recovery fixture insert failed');

  return { org, site, device, config, job, snapshot, recovery, code };
}

describe('bare-metal recovery public routes against real PostgreSQL (W04a review)', () => {
  runDb('exchange succeeds for a real code under RLS', async () => {
    const { recovery, code } = await seedRecovery('code0001', 'ABCDEFGH2');
    const app = makePublicApp();

    const res = await app.request('/bmr/recover/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as { token: string; bootstrap: { bootstrap: { recovery: { nonce: string } } } };
    expect(body.token).toMatch(/^brz_rec_[0-9a-f]{64}$/);
    expect(body.bootstrap.bootstrap.recovery.nonce).toMatch(/^[0-9a-f]{64}$/);

    const testDb = getTestDb();
    const [row] = await testDb.select().from(bareMetalRecoveries).where(eq(bareMetalRecoveries.id, recovery.id));
    expect(row?.status).toBe('media_booted');
    expect(row?.codeUsedAt).toBeInstanceOf(Date);
    expect(row?.recoveryTokenId).toBeTruthy();

    const [tokenRow] = await testDb.select().from(recoveryTokens).where(eq(recoveryTokens.id, row!.recoveryTokenId!));
    expect(tokenRow?.status).toBe('authenticated');
    expect(tokenRow?.restoreType).toBe('bare_metal');
  });

  runDb('a code can be exchanged exactly once under concurrency', async () => {
    const { org, code } = await seedRecovery('code0002', 'ABCDEFGH3');
    const app = makePublicApp();

    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        app.request('/bmr/recover/exchange', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code }),
        })
      )
    );

    const statuses = responses.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 404)).toHaveLength(4);

    const testDb = getTestDb();
    const tokenRows = await testDb.select().from(recoveryTokens).where(eq(recoveryTokens.orgId, org.id));
    expect(tokenRows).toHaveLength(1);
  });

  runDb('progress works with the minted token under RLS', async () => {
    const { recovery, code } = await seedRecovery('code0003', 'ABCDEFGH4');
    const app = makePublicApp();

    const exchangeRes = await app.request('/bmr/recover/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    expect(exchangeRes.status).toBe(200);
    const { token } = await exchangeRes.json() as { token: string };

    const plannedRes = await app.request('/bmr/recover/progress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, status: 'planned' }),
    });
    expect(plannedRes.status).toBe(200);
    expect((await plannedRes.json()).status).toBe('planned');

    const restoringRes = await app.request('/bmr/recover/progress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, status: 'restoring' }),
    });
    expect(restoringRes.status).toBe(200);
    expect((await restoringRes.json()).status).toBe('restoring');

    const backwardsRes = await app.request('/bmr/recover/progress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, status: 'planned' }),
    });
    expect(backwardsRes.status).toBe(409);
    expect(await backwardsRes.json()).toMatchObject({ error: 'invalid_transition', from: 'restoring', to: 'planned' });

    const testDb = getTestDb();
    const [row] = await testDb.select().from(bareMetalRecoveries).where(eq(bareMetalRecoveries.id, recovery.id));
    expect(row?.status).toBe('restoring');
    expect(row?.plannedAt).toBeInstanceOf(Date);
    expect(row?.restoringAt).toBeInstanceOf(Date);
  });
});
