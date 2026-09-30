/**
 * Real-Postgres + real-Redis proof that a remote session (desktop, terminal,
 * tunnel) ends with the sign-in session that opened it.
 *
 * Logout durably revokes the sign-in's refresh family and nothing user-wide
 * (services/terminalLogout.ts). Remote sessions record that family at
 * creation (`auth_session_id`), and the live authority every viewer token,
 * WebSocket ticket, continuation and periodic socket recheck funnels through
 * refuses a session whose family was revoked — so logging out stops the
 * remote sessions opened from that sign-in, and only those.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { withSystemDbAccessContext } from '../../db';
import { devices, refreshTokenFamilies } from '../../db/schema';
import { revalidateTunnelSession } from '../../routes/tunnelWs';
import { createRemoteSession } from '../../services/remoteSessionCreate';
import { revalidateRemoteWsAuthority } from '../../services/remoteWsAuthorization';
import { setupTestEnvironment } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL && !!process.env.REDIS_URL);

async function signInFamily(userId: string): Promise<string> {
  const familyId = randomUUID();
  await getTestDb().insert(refreshTokenFamilies).values({
    familyId,
    userId,
    absoluteExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });
  return familyId;
}

async function endSignIn(familyId: string): Promise<void> {
  await getTestDb().update(refreshTokenFamilies)
    .set({ revokedAt: new Date(), revokedReason: 'terminal_logout' })
    .where(eq(refreshTokenFamilies.familyId, familyId));
}

describe('remote sessions end with the sign-in session that opened them', () => {
  runDb('denies a terminal session after its sign-in ends, and keeps one from another sign-in', async () => {
    const env = await setupTestEnvironment({
      rolePermissions: [{ resource: 'remote', action: 'access' }],
    });
    const [device] = await getTestDb().insert(devices).values({
      orgId: env.organization.id,
      siteId: env.site.id,
      agentId: `signin-binding-${randomUUID()}`,
      hostname: 'synthetic-signin-binding',
      osType: 'linux',
      osVersion: 'test',
      architecture: 'x64',
      agentVersion: 'test',
      status: 'online',
    }).returning({ id: devices.id });

    const endedSignIn = await signInFamily(env.user.id);
    const otherSignIn = await signInFamily(env.user.id);
    const create = (authSessionId: string) => withSystemDbAccessContext(() => createRemoteSession('remote', {
      deviceId: device!.id,
      orgId: env.organization.id,
      userId: env.user.id,
      type: 'terminal',
      authSessionId,
    }));
    const ended = await create(endedSignIn);
    const kept = await create(otherSignIn);
    const subject = (sessionId: string) => ({ sessionId, sessionType: 'terminal' as const, userId: env.user.id });

    await expect(revalidateRemoteWsAuthority(subject(ended.id))).resolves.toEqual({ ok: true });
    await expect(revalidateRemoteWsAuthority(subject(kept.id))).resolves.toEqual({ ok: true });

    await endSignIn(endedSignIn);

    await expect(revalidateRemoteWsAuthority(subject(ended.id))).resolves.toEqual({
      ok: false, status: 403, reason: 'credential_revoked',
    });
    await expect(revalidateRemoteWsAuthority(subject(kept.id))).resolves.toEqual({ ok: true });
  });

  runDb('denies a relay tunnel after its sign-in ends', async () => {
    const env = await setupTestEnvironment({
      rolePermissions: [
        { resource: 'remote', action: 'access' },
        { resource: 'devices', action: 'execute' },
      ],
    });
    const [device] = await getTestDb().insert(devices).values({
      orgId: env.organization.id,
      siteId: env.site.id,
      agentId: `signin-binding-tunnel-${randomUUID()}`,
      hostname: 'synthetic-signin-binding-tunnel',
      osType: 'linux',
      osVersion: 'test',
      architecture: 'x64',
      agentVersion: 'test',
      status: 'online',
    }).returning({ id: devices.id });
    const signIn = await signInFamily(env.user.id);
    const tunnel = await withSystemDbAccessContext(() => createRemoteSession('tunnel', {
      deviceId: device!.id,
      userId: env.user.id,
      orgId: env.organization.id,
      type: 'proxy',
      status: 'active',
      targetHost: '127.0.0.1',
      targetPort: 8080,
      authSessionId: signIn,
    }));
    const conn = { userId: env.user.id, deviceId: device!.id, tunnelType: 'proxy' as const };

    await expect(revalidateTunnelSession(tunnel.id, conn)).resolves.toEqual({ ok: true });
    await endSignIn(signIn);
    await expect(revalidateTunnelSession(tunnel.id, conn)).resolves.toMatchObject({ ok: false });
  });

  runDb('leaves a session with no recorded sign-in to its other checks', async () => {
    const env = await setupTestEnvironment({
      rolePermissions: [{ resource: 'remote', action: 'access' }],
    });
    const [device] = await getTestDb().insert(devices).values({
      orgId: env.organization.id,
      siteId: env.site.id,
      agentId: `signin-binding-none-${randomUUID()}`,
      hostname: 'synthetic-signin-binding-none',
      osType: 'linux',
      osVersion: 'test',
      architecture: 'x64',
      agentVersion: 'test',
      status: 'online',
    }).returning({ id: devices.id });
    const session = await withSystemDbAccessContext(() => createRemoteSession('remote', {
      deviceId: device!.id,
      orgId: env.organization.id,
      userId: env.user.id,
      type: 'terminal',
    }));
    await expect(revalidateRemoteWsAuthority({
      sessionId: session.id, sessionType: 'terminal', userId: env.user.id,
    })).resolves.toEqual({ ok: true });
  });
});
