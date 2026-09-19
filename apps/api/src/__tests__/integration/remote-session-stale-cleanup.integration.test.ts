/**
 * Real PostgreSQL/Redis boundary for caller-owned remote-session cleanup.
 *
 * The public cleanup route is not an administrative session-termination API.
 * It may claim only the caller's pending rows older than five minutes and
 * connecting rows older than two minutes. Active, fresh, and other users'
 * rows must remain untouched.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { and, eq, inArray } from 'drizzle-orm';
import postgres from 'postgres';

import './setup';
import { getTestDb, getTestRedis } from './setup';
import { createSite, createUser, setupTestEnvironment } from './db-utils';
import { createAccessToken } from '../../services/jwt';
import { clearPermissionCache } from '../../services/permissions';

const { sendCommandToAgentMock } = vi.hoisted(() => ({
  sendCommandToAgentMock: vi.fn(() => true),
}));
vi.mock('../../routes/agentWs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../routes/agentWs')>();
  return { ...actual, sendCommandToAgent: sendCommandToAgentMock };
});

import { remoteRoutes } from '../../routes/remote';
import { devices, organizationUsers, remoteSessions } from '../../db/schema';

function app() {
  const api = new Hono();
  api.route('/remote', remoteRoutes);
  return api;
}

async function mfaToken(env: Awaited<ReturnType<typeof setupTestEnvironment>>) {
  return createAccessToken({
    sub: env.user.id,
    email: env.user.email,
    roleId: env.role.id,
    orgId: env.organization.id,
    partnerId: env.partner.id,
    scope: 'organization',
    mfa: true,
    aep: 1,
    mep: 1,
    sid: 'stale-cleanup-integration',
  });
}

async function partnerMfaToken(env: Awaited<ReturnType<typeof setupTestEnvironment>>) {
  return createAccessToken({
    sub: env.user.id,
    email: env.user.email,
    roleId: env.role.id,
    orgId: null,
    partnerId: env.partner.id,
    scope: 'partner',
    mfa: true,
    aep: 1,
    mep: 1,
    sid: 'stale-cleanup-partner-integration',
  });
}

async function restrictToSites(
  env: Awaited<ReturnType<typeof setupTestEnvironment>>,
  siteIds: string[],
) {
  const db = getTestDb();
  await db.update(organizationUsers)
    .set({ siteIds })
    .where(and(
      eq(organizationUsers.userId, env.user.id),
      eq(organizationUsers.orgId, env.organization.id),
    ));
  await clearPermissionCache(env.user.id);
}

async function insertDevice(orgId: string, siteId: string, suffix: string) {
  const [device] = await getTestDb().insert(devices).values({
    orgId,
    siteId,
    agentId: `stale-${suffix}-${Date.now()}`,
    hostname: `stale-${suffix}`,
    osType: 'windows',
    osVersion: '11',
    osBuild: 'test',
    architecture: 'x86_64',
    agentVersion: 'test',
    status: 'online',
    enrolledAt: new Date(),
  }).returning({ id: devices.id });
  if (!device) throw new Error('device fixture missing');
  return device;
}

async function insertStaleSession(
  deviceId: string,
  orgId: string,
  userId: string,
  type: 'desktop' | 'terminal' = 'desktop',
) {
  const [session] = await getTestDb().insert(remoteSessions).values({
    deviceId,
    orgId,
    userId,
    type,
    status: 'pending',
    createdAt: new Date(Date.now() - 10 * 60_000),
  }).returning({ id: remoteSessions.id });
  if (!session) throw new Error('session fixture missing');
  return session;
}

describe('DELETE /remote/sessions/stale — caller-owned stale claim', () => {
  beforeEach(() => sendCommandToAgentMock.mockClear());

  it('disconnects only stale pending/connecting rows owned by the caller', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const token = await mfaToken(env);
    const otherUser = await createUser({
      partnerId: env.partner.id,
      orgId: env.organization.id,
      email: `other-stale-${Date.now()}@example.test`,
    });
    const db = getTestDb();
    const [device] = await db.insert(devices).values({
      orgId: env.organization.id,
      siteId: env.site.id,
      agentId: `stale-agent-${Date.now()}`,
      hostname: 'stale-boundary-host',
      osType: 'windows',
      osVersion: '11',
      osBuild: 'test',
      architecture: 'x86_64',
      agentVersion: 'test',
      status: 'online',
      enrolledAt: new Date(),
    }).returning({ id: devices.id });
    if (!device) throw new Error('device fixture missing');

    const now = Date.now();
    const rows = await db.insert(remoteSessions).values([
      { deviceId: device.id, orgId: env.organization.id, userId: env.user.id, type: 'desktop', status: 'pending', createdAt: new Date(now - 6 * 60_000) },
      { deviceId: device.id, orgId: env.organization.id, userId: env.user.id, type: 'terminal', status: 'connecting', createdAt: new Date(now - 3 * 60_000) },
      { deviceId: device.id, orgId: env.organization.id, userId: env.user.id, type: 'desktop', status: 'pending', createdAt: new Date(now - 60_000) },
      { deviceId: device.id, orgId: env.organization.id, userId: env.user.id, type: 'terminal', status: 'connecting', createdAt: new Date(now - 60_000) },
      { deviceId: device.id, orgId: env.organization.id, userId: env.user.id, type: 'desktop', status: 'active', createdAt: new Date(now - 60 * 60_000) },
      { deviceId: device.id, orgId: env.organization.id, userId: otherUser.id, type: 'desktop', status: 'pending', createdAt: new Date(now - 60 * 60_000) },
    ]).returning({ id: remoteSessions.id });

    const response = await app().request('/remote/sessions/stale', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { cleaned: number; ids: string[] };
    expect(body.cleaned).toBe(2);
    expect(new Set(body.ids)).toEqual(new Set(rows.slice(0, 2).map((row) => row.id)));

    const persisted = await db.select({ id: remoteSessions.id, status: remoteSessions.status })
      .from(remoteSessions)
      .where(inArray(remoteSessions.id, rows.map((row) => row.id)));
    const statusById = new Map(persisted.map((row) => [row.id, row.status]));
    expect(statusById.get(rows[0]!.id)).toBe('disconnected');
    expect(statusById.get(rows[1]!.id)).toBe('disconnected');
    for (const row of rows.slice(2)) expect(statusById.get(row.id)).not.toBe('disconnected');

    // The Redis-backed viewer revocation is part of the real teardown path.
    // Only the exact rows returned by the atomic UPDATE may be revoked; agent
    // transport itself stays mocked because no endpoint is contacted here.
    const redis = getTestRedis();
    expect(await redis.get(`viewer-session-revoked:${rows[0]!.id}`)).toBe('1');
    expect(await redis.get(`viewer-session-revoked:${rows[1]!.id}`)).toBe('1');
    for (const row of rows.slice(2)) {
      expect(await redis.get(`viewer-session-revoked:${row.id}`)).toBeNull();
    }

    // Keep the direct query import live: this assertion also documents that
    // the other-user control is a genuine persisted row, not a mock artifact.
    const [other] = await db.select({ status: remoteSessions.status }).from(remoteSessions)
      .where(eq(remoteSessions.id, rows[5]!.id));
    expect(other?.status).toBe('pending');
  });

  it('does not disconnect a stale candidate made fresh before its blocked UPDATE wins', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const token = await mfaToken(env);
    const db = getTestDb();
    const [device] = await db.insert(devices).values({
      orgId: env.organization.id,
      siteId: env.site.id,
      agentId: `stale-race-agent-${Date.now()}`,
      hostname: 'stale-race-host',
      osType: 'windows',
      osVersion: '11',
      osBuild: 'test',
      architecture: 'x86_64',
      agentVersion: 'test',
      status: 'online',
      enrolledAt: new Date(),
    }).returning({ id: devices.id });
    if (!device) throw new Error('device fixture missing');
    const [session] = await db.insert(remoteSessions).values({
      deviceId: device.id,
      orgId: env.organization.id,
      userId: env.user.id,
      type: 'desktop',
      status: 'pending',
      createdAt: new Date(Date.now() - 10 * 60_000),
    }).returning({ id: remoteSessions.id });
    if (!session) throw new Error('session fixture missing');

    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error('DATABASE_URL is required');
    const holder = postgres(databaseUrl, { max: 1, onnotice: () => {} });
    const monitor = postgres(databaseUrl, { max: 1, onnotice: () => {} });
    let release!: () => void;
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    let locked!: (pid: number) => void;
    const lockedPromise = new Promise<number>((resolve) => { locked = resolve; });

    const holding = holder.begin(async (tx) => {
      const [backend] = await tx<{ pid: number }[]>`SELECT pg_backend_pid()::int AS pid`;
      if (!backend) throw new Error('holder backend pid missing');
      await tx`SELECT id FROM remote_sessions WHERE id = ${session.id}::uuid FOR UPDATE`;
      locked(backend.pid);
      await releasePromise;
      await tx`UPDATE remote_sessions SET created_at = now() WHERE id = ${session.id}::uuid`;
    });

    try {
      const holderPid = await lockedPromise;
      const cleanup = app().request('/remote/sessions/stale', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });

      const deadline = Date.now() + 5_000;
      let observedBlocked = false;
      while (Date.now() < deadline) {
        const [row] = await monitor<{ blocked: boolean }[]>`
          SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity
            WHERE ${holderPid}::int = ANY(pg_blocking_pids(pid))
              AND query ILIKE 'update%remote_sessions%'
          ) AS blocked
        `;
        if (row?.blocked) { observedBlocked = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(observedBlocked).toBe(true);

      release();
      await holding;
      const response = await cleanup;
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ cleaned: 0, ids: [] });
      const [persisted] = await db.select({ status: remoteSessions.status, createdAt: remoteSessions.createdAt })
        .from(remoteSessions).where(eq(remoteSessions.id, session.id));
      expect(persisted?.status).toBe('pending');
      expect(persisted!.createdAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
      expect(await getTestRedis().get(`viewer-session-revoked:${session.id}`)).toBeNull();
    } finally {
      release();
      await holding.catch(() => undefined);
      await holder.end();
      await monitor.end();
    }
  });

  it('enforces selected, empty, partner, and cross-tenant device scope', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const token = await mfaToken(env);
    const hiddenSite = await createSite({ orgId: env.organization.id, name: 'hidden stale cleanup site' });
    const allowedDevice = await insertDevice(env.organization.id, env.site.id, 'allowed');
    const hiddenDevice = await insertDevice(env.organization.id, hiddenSite.id, 'hidden');
    const allowedSession = await insertStaleSession(allowedDevice.id, env.organization.id, env.user.id);
    const hiddenSession = await insertStaleSession(hiddenDevice.id, env.organization.id, env.user.id);

    await restrictToSites(env, [env.site.id]);
    const selected = await app().request('/remote/sessions/stale', {
      method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
    });
    expect(selected.status).toBe(200);
    expect(await selected.json()).toEqual({ cleaned: 1, ids: [allowedSession.id] });

    const denied = await app().request(`/remote/sessions/stale?deviceId=${hiddenDevice.id}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
    });
    expect(denied.status).toBe(403);

    await restrictToSites(env, []);
    const empty = await app().request('/remote/sessions/stale', {
      method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
    });
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ cleaned: 0, ids: [] });
    const emptyExact = await app().request(`/remote/sessions/stale?deviceId=${allowedDevice.id}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
    });
    expect(emptyExact.status).toBe(403);

    const remaining = await getTestDb().select({ id: remoteSessions.id, status: remoteSessions.status })
      .from(remoteSessions).where(eq(remoteSessions.id, hiddenSession.id));
    expect(remaining).toEqual([{ id: hiddenSession.id, status: 'pending' }]);
    expect(await getTestRedis().get(`viewer-session-revoked:${hiddenSession.id}`)).toBeNull();

    const partnerEnv = await setupTestEnvironment({ scope: 'partner' });
    const partnerToken = await partnerMfaToken(partnerEnv);
    const partnerDevice = await insertDevice(partnerEnv.organization.id, partnerEnv.site.id, 'partner');
    const partnerSession = await insertStaleSession(
      partnerDevice.id, partnerEnv.organization.id, partnerEnv.user.id,
    );
    const partnerAllowed = await app().request(`/remote/sessions/stale?deviceId=${partnerDevice.id}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${partnerToken}` },
    });
    expect(partnerAllowed.status).toBe(200);
    expect(await partnerAllowed.json()).toEqual({ cleaned: 1, ids: [partnerSession.id] });

    const foreign = await app().request(`/remote/sessions/stale?deviceId=${hiddenDevice.id}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${partnerToken}` },
    });
    expect(foreign.status).toBe(404);
    const [foreignPersisted] = await getTestDb().select({ status: remoteSessions.status })
      .from(remoteSessions).where(eq(remoteSessions.id, hiddenSession.id));
    expect(foreignPersisted?.status).toBe('pending');
  });

  it('serializes an exact-device cleanup behind an allowed-to-hidden site move', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const token = await mfaToken(env);
    const hiddenSite = await createSite({ orgId: env.organization.id, name: 'race hidden site' });
    const device = await insertDevice(env.organization.id, env.site.id, 'site-race');
    const session = await insertStaleSession(device.id, env.organization.id, env.user.id);
    await restrictToSites(env, [env.site.id]);

    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error('DATABASE_URL is required');
    const mover = postgres(databaseUrl, { max: 1, onnotice: () => {} });
    const monitor = postgres(databaseUrl, { max: 1, onnotice: () => {} });
    let release!: () => void;
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    let moved!: (pid: number) => void;
    const movedPromise = new Promise<number>((resolve) => { moved = resolve; });

    const moving = mover.begin(async (tx) => {
      const [backend] = await tx<{ pid: number }[]>`SELECT pg_backend_pid()::int AS pid`;
      if (!backend) throw new Error('mover backend pid missing');
      await tx`UPDATE devices SET site_id = ${hiddenSite.id}::uuid WHERE id = ${device.id}::uuid`;
      moved(backend.pid);
      await releasePromise;
    });

    try {
      const moverPid = await movedPromise;
      const cleanup = app().request(`/remote/sessions/stale?deviceId=${device.id}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
      });
      const deadline = Date.now() + 5_000;
      let observedBlocked = false;
      while (Date.now() < deadline) {
        const [row] = await monitor<{ blocked: boolean }[]>`
          SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity
            WHERE ${moverPid}::int = ANY(pg_blocking_pids(pid))
          ) AS blocked
        `;
        if (row?.blocked) { observedBlocked = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(observedBlocked).toBe(true);
      release();
      await moving;

      const response = await cleanup;
      expect(response.status).toBe(403);
      const [persisted] = await getTestDb().select({ status: remoteSessions.status })
        .from(remoteSessions).where(eq(remoteSessions.id, session.id));
      expect(persisted?.status).toBe('pending');
      expect(await getTestRedis().get(`viewer-session-revoked:${session.id}`)).toBeNull();
      expect(sendCommandToAgentMock).not.toHaveBeenCalled();
    } finally {
      release();
      await moving.catch(() => undefined);
      await mover.end();
      await monitor.end();
    }
  });
});
