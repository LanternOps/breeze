import './setup';

import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { devices, organizationUsers, remoteSessions } from '../../db/schema';
import { getRedis } from '../../services/redis';
import {
  authorizeLiveRemoteSessionAccess,
  revalidateRemoteWsAuthority,
  revalidateRemoteWsAuthorityBounded,
} from '../../services/remoteWsAuthorization';
import { isViewerSessionRevoked, revokeViewerSession } from '../../services/viewerTokenRevocation';
import { createSite, setupTestEnvironment } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL && !!process.env.REDIS_URL);

describe('remote WebSocket live authority — real PostgreSQL and Redis', () => {
  runDb('allows the current site, then denies after a committed membership narrowing', async () => {
    const env = await setupTestEnvironment({
      rolePermissions: [{ resource: 'remote', action: 'access' }],
    });
    const hiddenSite = await createSite({ orgId: env.organization.id, name: `Hidden ${randomUUID()}` });
    const [device] = await getTestDb().insert(devices).values({
      orgId: env.organization.id,
      siteId: env.site.id,
      agentId: `live-auth-${randomUUID()}`,
      hostname: 'synthetic-live-auth',
      osType: 'linux',
      osVersion: 'test',
      architecture: 'x64',
      agentVersion: 'test',
      status: 'online',
    }).returning({ id: devices.id });
    const [session] = await getTestDb().insert(remoteSessions).values({
      orgId: env.organization.id,
      deviceId: device!.id,
      userId: env.user.id,
      type: 'terminal',
      status: 'active',
    }).returning({ id: remoteSessions.id });
    const subject = { sessionId: session!.id, sessionType: 'terminal' as const, userId: env.user.id };

    await expect(revalidateRemoteWsAuthority(subject)).resolves.toEqual({ ok: true });

    await getTestDb().update(organizationUsers).set({ siteIds: [hiddenSite.id] }).where(and(
      eq(organizationUsers.userId, env.user.id),
      eq(organizationUsers.orgId, env.organization.id),
    ));
    await expect(revalidateRemoteWsAuthority(subject)).resolves.toEqual({
      ok: false, status: 403, reason: 'site_denied',
    });

    const redis = getRedis();
    expect(redis).toBeTruthy();
    await revokeViewerSession(session!.id);
    await expect(isViewerSessionRevoked(session!.id)).resolves.toBe(true);
    await redis!.del(`viewer-session-revoked:${session!.id}`);
  });

  runDb('cancels a lock-stalled PostgreSQL revalidation and releases the loser', async () => {
    const env = await setupTestEnvironment({
      rolePermissions: [{ resource: 'remote', action: 'access' }],
    });
    const [device] = await getTestDb().insert(devices).values({
      orgId: env.organization.id,
      siteId: env.site.id,
      agentId: `live-auth-lock-${randomUUID()}`,
      hostname: 'synthetic-live-auth-lock',
      osType: 'linux',
      osVersion: 'test',
      architecture: 'x64',
      agentVersion: 'test',
      status: 'online',
    }).returning({ id: devices.id });
    const [session] = await getTestDb().insert(remoteSessions).values({
      orgId: env.organization.id,
      deviceId: device!.id,
      userId: env.user.id,
      type: 'terminal',
      status: 'active',
    }).returning({ id: remoteSessions.id });
    const subject = {
      sessionId: session!.id,
      sessionType: 'terminal' as const,
      userId: env.user.id,
    };

    await getTestDb().transaction(async (tx) => {
      await tx.execute(sql`LOCK TABLE users IN ACCESS EXCLUSIVE MODE`);
      const startedAt = Date.now();
      await expect(revalidateRemoteWsAuthorityBounded(subject, 100)).resolves.toEqual({
        ok: false,
        status: 503,
        reason: 'authorization_unavailable',
      });
      expect(Date.now() - startedAt).toBeLessThan(1_000);

      // The outer caller timeout and transaction-local statement timeout share
      // the same bound. Allow cancellation cleanup to settle, then prove the
      // app-pool SELECT is no longer waiting behind this lock.
      await new Promise((resolve) => setTimeout(resolve, 150));
      const waiting = await tx.execute(sql<{ count: number }>`
        SELECT count(*)::int AS count
        FROM pg_locks
        WHERE relation = 'users'::regclass
          AND NOT granted
      `);
      expect(Number(waiting[0]?.count ?? -1)).toBe(0);
    });
  });
});


runDb('failure diagnostics remain read-only and subject to live site authority', async () => {
  const env = await setupTestEnvironment({ rolePermissions: [{ resource: 'remote', action: 'access' }] });
  const [device] = await getTestDb().insert(devices).values({
    orgId: env.organization.id, siteId: env.site.id,
    agentId: `diagnostic-auth-${randomUUID()}`, hostname: 'synthetic-diagnostic-auth',
    osType: 'linux', osVersion: 'test', architecture: 'x64', agentVersion: 'test', status: 'offline',
  }).returning({ id: devices.id });
  const [session] = await getTestDb().insert(remoteSessions).values({
    orgId: env.organization.id, deviceId: device!.id, userId: env.user.id,
    type: 'desktop', status: 'failed', errorMessage: 'synthetic capture diagnosis',
  }).returning({ id: remoteSessions.id });
  const subject = { sessionId: session!.id, sessionType: 'desktop' as const, userId: env.user.id };
  await expect(authorizeLiveRemoteSessionAccess(subject, 'failure-diagnostics')).resolves.toMatchObject({ ok: true });
  await expect(authorizeLiveRemoteSessionAccess(subject)).resolves.toEqual({ ok: false, status: 403, reason: 'session_inactive' });
  await expect(revalidateRemoteWsAuthority(subject)).resolves.toEqual({ ok: false, status: 403, reason: 'session_inactive' });
  await getTestDb().update(organizationUsers).set({ siteIds: [] }).where(and(
    eq(organizationUsers.userId, env.user.id), eq(organizationUsers.orgId, env.organization.id),
  ));
  await expect(authorizeLiveRemoteSessionAccess(subject, 'failure-diagnostics')).resolves.toEqual({ ok: false, status: 403, reason: 'site_denied' });
  const [persisted] = await getTestDb().select({ status: remoteSessions.status, errorMessage: remoteSessions.errorMessage })
    .from(remoteSessions).where(eq(remoteSessions.id, session!.id));
  expect(persisted).toEqual({ status: 'failed', errorMessage: 'synthetic capture diagnosis' });
});
