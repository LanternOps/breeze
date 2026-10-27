/**
 * #10190 W06 — live-Postgres proof for recordDesktopSessionEndedByUser
 * (services/desktopUserEnd.ts): the `desk-userend-<sessionId>` report sets
 * remote_sessions.end_reason and writes the remote.session.ended_by_user audit
 * row in one transaction, through the breeze_app pool under system scope
 * (FORCE RLS), only for a desktop session of the reporting device that is
 * active or went disconnected in the last ten minutes, and only once.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import './setup';
import { getTestDb } from './setup';
import { createDevice, setupTestEnvironment, type TestEnvironment } from './db-utils';
import { auditLogs, remoteSessions } from '../../db/schema';
import { DESKTOP_ENDED_BY_USER_ACTION, recordDesktopSessionEndedByUser } from '../../services/desktopUserEnd';

const hasDb = !!process.env.DATABASE_URL;

let env: TestEnvironment;
let deviceId: string;
let otherDeviceId: string;

async function seedSession(input: {
  status: 'active' | 'disconnected' | 'failed' | 'connecting';
  type?: 'desktop' | 'terminal';
  endedAt?: Date | null;
  device?: string;
}): Promise<string> {
  const id = randomUUID();
  await getTestDb().insert(remoteSessions).values({
    id,
    deviceId: input.device ?? deviceId,
    orgId: env.organization.id,
    userId: env.user.id,
    type: input.type ?? 'desktop',
    status: input.status,
    endedAt: input.endedAt ?? null,
    iceCandidates: [],
    ...(input.status === 'disconnected' || input.status === 'failed'
      ? { terminalGeneration: 1n, terminationPhase: 'confirmed' as const, desktopStartGeneration: 1n }
      : {}),
  });
  return id;
}

async function rowOf(id: string) {
  const [row] = await getTestDb().select({ endReason: remoteSessions.endReason }).from(remoteSessions).where(eq(remoteSessions.id, id));
  return row;
}

async function auditRowsFor(id: string) {
  return getTestDb().select().from(auditLogs).where(and(
    eq(auditLogs.resourceType, 'remote_session'),
    eq(auditLogs.resourceId, id),
    eq(auditLogs.action, DESKTOP_ENDED_BY_USER_ACTION),
  ));
}

describe.runIf(hasDb)('recordDesktopSessionEndedByUser (live DB)', () => {
  beforeEach(async () => {
    env = await setupTestEnvironment();
    deviceId = (await createDevice({ orgId: env.organization.id, siteId: env.site.id })).id;
    otherDeviceId = (await createDevice({ orgId: env.organization.id, siteId: env.site.id })).id;
  });

  it('records the reason and one audit row for an active session, once', async () => {
    const id = await seedSession({ status: 'active' });

    await expect(recordDesktopSessionEndedByUser({ sessionId: id, deviceId })).resolves.toBe('recorded');
    await expect(recordDesktopSessionEndedByUser({ sessionId: id, deviceId })).resolves.toBe('not_recorded');

    expect((await rowOf(id))?.endReason).toBe('ended_by_user');
    const audit = await auditRowsFor(id);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      orgId: env.organization.id,
      actorType: 'agent',
      actorId: deviceId,
      result: 'success',
    });
    expect(audit[0]!.details).toMatchObject({ sessionId: id, deviceId, endReason: 'ended_by_user', sessionOwnerId: env.user.id });
  });

  it('records it for a session the disconnect already ended a moment ago', async () => {
    const id = await seedSession({ status: 'disconnected', endedAt: new Date(Date.now() - 30_000) });
    await expect(recordDesktopSessionEndedByUser({ sessionId: id, deviceId })).resolves.toBe('recorded');
    expect((await rowOf(id))?.endReason).toBe('ended_by_user');
  });

  it('refuses a session that ended long ago, a failed one, a terminal session and another device\'s session', async () => {
    const old = await seedSession({ status: 'disconnected', endedAt: new Date(Date.now() - 11 * 60_000) });
    const failed = await seedSession({ status: 'failed', endedAt: new Date() });
    const terminal = await seedSession({ status: 'active', type: 'terminal' });
    const foreign = await seedSession({ status: 'active', device: otherDeviceId });

    for (const id of [old, failed, terminal, foreign]) {
      await expect(recordDesktopSessionEndedByUser({ sessionId: id, deviceId })).resolves.toBe('not_recorded');
      expect((await rowOf(id))?.endReason).toBeNull();
      expect(await auditRowsFor(id)).toHaveLength(0);
    }
  });

  it('refuses an unknown session id', async () => {
    await expect(recordDesktopSessionEndedByUser({ sessionId: randomUUID(), deviceId })).resolves.toBe('not_recorded');
  });

  it('the CHECK constraint keeps end_reason a closed set', async () => {
    const id = await seedSession({ status: 'active' });
    await expect(
      getTestDb().update(remoteSessions).set({ endReason: 'whatever' as never }).where(eq(remoteSessions.id, id)),
    ).rejects.toThrow();
  });
});
