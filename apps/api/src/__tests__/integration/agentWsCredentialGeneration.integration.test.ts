/** Real-PostgreSQL proof that established agent sockets follow credential generations. */
import './setup';

import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { devices } from '../../db/schema';
import {
  isAgentDeviceStillAuthorized,
  publishAgentCredentialRevocation,
} from '../../routes/agentWs';
import { getRedis } from '../../services/redis';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const digest = (token: string) => createHash('sha256').update(token).digest('hex');

describe('agent websocket credential generation (real PostgreSQL)', () => {
  runDb('allows the admitted generation, then denies it after replacement and row removal', async () => {
    const role = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT current_user AS who, rolsuper, rolbypassrls
      FROM pg_roles WHERE rolname = current_user
    `)) as unknown as Array<{ who: string; rolsuper: boolean; rolbypassrls: boolean }>;
    expect(role[0]).toMatchObject({ who: 'breeze_app', rolsuper: false, rolbypassrls: false });

    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    const agentId = `ws-generation-${randomUUID()}`;
    const oldHash = digest('brz_old_generation');
    const replacementHash = digest('brz_replacement_generation');
    const [device] = await getTestDb().insert(devices).values({
      orgId: org.id,
      siteId: site.id,
      agentId,
      agentTokenHash: oldHash,
      hostname: `ws-generation-${randomUUID()}`,
      osType: 'linux',
      osVersion: 'test',
      architecture: 'amd64',
      agentVersion: '0.0.0-test',
      status: 'online',
    }).returning({ id: devices.id });
    expect(device).toBeDefined();

    expect(await isAgentDeviceStillAuthorized(agentId, oldHash)).toBe(true);

    await getTestDb().update(devices)
      .set({
        agentTokenHash: replacementHash,
        previousTokenHash: oldHash,
        previousTokenExpiresAt: new Date(Date.now() + 60_000),
      })
      .where(eq(devices.id, device!.id));

    // A previous generation remains valid only inside its explicit grace.
    expect(await isAgentDeviceStillAuthorized(agentId, oldHash)).toBe(true);
    await getTestDb().update(devices)
      .set({ previousTokenExpiresAt: new Date(Date.now() - 1) })
      .where(eq(devices.id, device!.id));
    expect(await isAgentDeviceStillAuthorized(agentId, oldHash)).toBe(false);
    expect(await isAgentDeviceStillAuthorized(agentId, replacementHash)).toBe(true);

    // A staged generation follows the same expiry boundary.
    const pendingHash = digest('brz_pending_generation');
    await getTestDb().update(devices)
      .set({ pendingTokenHash: pendingHash, pendingTokenExpiresAt: new Date(Date.now() + 60_000) })
      .where(eq(devices.id, device!.id));
    expect(await isAgentDeviceStillAuthorized(agentId, pendingHash)).toBe(true);
    await getTestDb().update(devices)
      .set({ pendingTokenExpiresAt: new Date(Date.now() - 1) })
      .where(eq(devices.id, device!.id));
    expect(await isAgentDeviceStillAuthorized(agentId, pendingHash)).toBe(false);

    await getTestDb().delete(devices).where(eq(devices.id, device!.id));
    expect(await isAgentDeviceStillAuthorized(agentId, replacementHash)).toBe(false);
  });

  runDb('broadcasts a hash-targeted revocation through real Redis for peer instances', async () => {
    const redis = getRedis();
    if (!redis) throw new Error('Redis is required for this integration test');
    const subscriber = redis.duplicate({ connectionName: 'credential-revocation-integration-peer' });
    const received = new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('revocation broadcast timed out')), 2_000);
      subscriber.on('message', (channel, message) => {
        if (channel !== 'agent-credential:revoked') return;
        clearTimeout(timeout);
        resolve(message);
      });
    });

    try {
      await subscriber.subscribe('agent-credential:revoked');
      const tokenHash = digest('brz_cross_instance_revocation');
      await expect(publishAgentCredentialRevocation({
        agentId: 'agent-cross-instance',
        revokedTokenHashes: [tokenHash],
      })).resolves.toBe('published');
      expect(JSON.parse(await received)).toEqual({
        agentId: 'agent-cross-instance',
        revokedTokenHashes: [tokenHash],
      });
    } finally {
      await subscriber.quit();
    }
  });
});
