/**
 * #11113 — a reconnect must not extend a remote desktop session's max duration.
 * #11149 — and a session that is reconnecting must not be ended as stale.
 *
 * The lease hard deadline is `started_at + max duration`. A WebRTC reconnect
 * moves the row back to `connecting` and the agent answers again, so the row's
 * clock has to survive every later answer and every later start. This drives
 * the real agent answer handler, the real start commits and the real lease code
 * against live Postgres and Redis. A mocked row would not prove any of that.
 *
 * Run:
 *   pnpm test-stack up   # worktree root
 *   pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts \
 *     src/__tests__/integration/remoteSessionMaxDuration.integration.test.ts
 */
import './setup';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

// The teardown side effect (viewer-token revoke + durable stop relay) has its
// own suite. Here only the verdict and the row matter.
vi.mock('../../services/remoteSessionTeardown', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/remoteSessionTeardown')>()),
  teardownDisconnectedSessions: vi.fn(async () => {}),
}));

import { withSystemDbAccessContext } from '../../db';
import { devices, remoteSessions, users } from '../../db/schema';
import { REAPER_DOMAINS } from '../../jobs/staleCommandReaper';
import { createAgentWsHandlers } from '../../routes/agentWs';
import { expireStaleSessions, expireStaleSessionsForUser } from '../../routes/remote/helpers';
import {
  commitDesktopStartIntent,
  commitDesktopStreamStartIntent,
} from '../../services/remoteDesktopStartIntent';
import {
  REVOCATION_LEASE_HARD_CAP_MS,
  prepareRevocationLeaseForStart,
  renewRevocationLease,
} from '../../services/remoteRevocationLease';
import { remoteSessionStaleCondition } from '../../services/remoteSessionStaleness';
import {
  assignUserToOrganization,
  createOrganization,
  createPartner,
  createRole,
  createSite,
  createUser,
} from './db-utils';
import { getTestDb } from './setup';

const CREDENTIAL_HASH = createHash('sha256').update('synthetic-max-duration-agent').digest('hex');
const fakeWs = { send: () => {}, close: () => {} } as unknown as Parameters<
  ReturnType<typeof createAgentWsHandlers>['onMessage']
>[1];

interface Fixture {
  partnerId: string;
  orgId: string;
  siteId: string;
  deviceId: string;
  agentId: string;
  sessionId: string;
  userId: string;
}

async function buildFixture(): Promise<Fixture> {
  const db = getTestDb();
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const partner = await createPartner({ name: `Max Duration Partner ${unique}` });
  const org = await createOrganization({ partnerId: partner.id, name: `Max Duration Org ${unique}` });
  const site = await createSite({ orgId: org.id, name: `Max Duration Site ${unique}` });
  const role = await createRole({ scope: 'organization', orgId: org.id, partnerId: partner.id });
  const user = await createUser({
    partnerId: partner.id,
    orgId: org.id,
    email: `max-duration-${unique}@example.com`,
  });
  await assignUserToOrganization(user.id, org.id, role.id);

  const agentId = `max-duration-agent-${unique}`;
  const [device] = await db
    .insert(devices)
    .values({
      orgId: org.id,
      siteId: site.id,
      agentId,
      agentTokenHash: CREDENTIAL_HASH,
      hostname: `max-duration-host-${unique}`,
      osType: 'linux',
      osVersion: '22.04',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      status: 'online',
      enrolledAt: new Date(),
      revocationLeaseProtocolVersion: 1,
      desktopFenceProtocolVersion: 1,
    })
    .returning({ id: devices.id });

  const [live] = await db
    .select({ permissionsEpoch: users.permissionsEpoch })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1);

  const [session] = await db
    .insert(remoteSessions)
    .values({
      deviceId: device!.id,
      orgId: org.id,
      userId: user.id,
      type: 'desktop',
      status: 'pending',
      permissionsEpochSnapshot: Number(live!.permissionsEpoch),
      iceCandidates: [],
    })
    .returning({ id: remoteSessions.id });

  return {
    partnerId: partner.id,
    orgId: org.id,
    siteId: site.id,
    deviceId: device!.id,
    agentId,
    sessionId: session!.id,
    userId: user.id,
  };
}

/** A viewer offer: the row goes to `connecting` on a new start generation. */
async function commitOffer(f: Fixture): Promise<string> {
  const startCommandId = `desk-start-${f.sessionId}-${randomUUID()}`;
  const result = await withSystemDbAccessContext(() =>
    commitDesktopStartIntent({
      sessionId: f.sessionId,
      startCommandId,
      promptMode: 'off',
      consentUnavailableBehavior: null,
      offer: 'v=0\r\noffer\r\n',
    }),
  );
  expect(result.ok).toBe(true);
  return startCommandId;
}

/** The agent's answer, through the real command-result handler. */
async function sendAnswer(f: Fixture, startCommandId: string): Promise<void> {
  const handlers = createAgentWsHandlers(f.agentId, {
    agentId: f.agentId,
    siteId: f.siteId,
    installIncarnation: 1,
    deviceId: f.deviceId,
    orgId: f.orgId,
    partnerId: f.partnerId,
    credentialTokenHash: CREDENTIAL_HASH,
  });
  await handlers.onOpen({}, fakeWs);
  await handlers.onMessage(
    {
      data: JSON.stringify({
        type: 'command_result',
        commandId: startCommandId,
        status: 'completed',
        result: { sessionId: f.sessionId, answer: 'v=0\r\nanswer\r\n' },
      }),
    } as MessageEvent,
    fakeWs,
  );
  await handlers.onClose({}, fakeWs);
}

async function readSession(sessionId: string) {
  const [row] = await getTestDb()
    .select({
      status: remoteSessions.status,
      startedAt: remoteSessions.startedAt,
      lastStartAttemptAt: remoteSessions.lastStartAttemptAt,
      createdAt: remoteSessions.createdAt,
    })
    .from(remoteSessions)
    .where(eq(remoteSessions.id, sessionId))
    .limit(1);
  if (!row) throw new Error('session not found');
  return row;
}

async function backdateStart(sessionId: string, startedAt: Date): Promise<void> {
  await getTestDb().update(remoteSessions).set({ startedAt }).where(eq(remoteSessions.id, sessionId));
}

/** Far enough back that a first start stamped from created_at cannot pass as `now`. */
async function backdateCreation(sessionId: string): Promise<void> {
  await getTestDb()
    .update(remoteSessions)
    .set({ createdAt: new Date(Date.now() - 10 * 60 * 1000) })
    .where(eq(remoteSessions.id, sessionId));
}

/** Reach a live session whose first answer was at `startedAt`. */
async function liveSessionStartedAt(startedAt: Date): Promise<Fixture> {
  const f = await buildFixture();
  await sendAnswer(f, await commitOffer(f));
  expect((await readSession(f.sessionId)).status).toBe('active');
  await backdateStart(f.sessionId, startedAt);
  return f;
}

async function backdateAttempt(sessionId: string, lastStartAttemptAt: Date): Promise<void> {
  await getTestDb().update(remoteSessions).set({ lastStartAttemptAt }).where(eq(remoteSessions.id, sessionId));
}

function agoMs(ms: number): Date {
  return new Date(Date.now() - ms);
}

const MINUTE_MS = 60 * 1000;

async function readsAsStale(sessionId: string): Promise<boolean> {
  const rows = await getTestDb()
    .select({ id: remoteSessions.id })
    .from(remoteSessions)
    .where(and(eq(remoteSessions.id, sessionId), remoteSessionStaleCondition(new Date())));
  return rows.length === 1;
}

async function runReaper(): Promise<void> {
  const domain = REAPER_DOMAINS.find(([name]) => name === 'remoteSessions');
  if (!domain) throw new Error('remoteSessions reaper domain missing');
  await withSystemDbAccessContext(() => domain[1]());
}

/** Everything that can end a row by age: both stale cleanups, then the reaper. */
async function runStaleCleanups(f: Fixture): Promise<void> {
  await withSystemDbAccessContext(() => expireStaleSessions(f.orgId));
  await withSystemDbAccessContext(() => expireStaleSessionsForUser(f.userId));
  await runReaper();
}

function expectFresh(stamp: Date, before: number): void {
  expect(stamp.getTime()).toBeGreaterThanOrEqual(before - 1_000);
  expect(stamp.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);
}

describe('#11113 remote session max duration across reconnects', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('the first answer starts the clock', async () => {
    const f = await buildFixture();
    await backdateCreation(f.sessionId);
    expect((await readSession(f.sessionId)).startedAt).toBeNull();

    const before = Date.now();
    await sendAnswer(f, await commitOffer(f));
    const after = Date.now();

    const row = await readSession(f.sessionId);
    expect(row.status).toBe('active');
    expect(row.startedAt).not.toBeNull();
    expect(row.startedAt!.getTime()).toBeGreaterThanOrEqual(before - 1_000);
    expect(row.startedAt!.getTime()).toBeLessThanOrEqual(after + 1_000);
  });

  it('an answer after a reconnect keeps the original start', async () => {
    const original = new Date(Date.now() - 60 * 60 * 1000);
    const f = await liveSessionStartedAt(original);

    await sendAnswer(f, await commitOffer(f));

    const row = await readSession(f.sessionId);
    expect(row.status).toBe('active');
    expect(row.startedAt!.getTime()).toBe(original.getTime());
  });

  it('every lease across N reconnects carries the same hard deadline', async () => {
    const original = new Date(Date.now() - 60 * 60 * 1000);
    const f = await liveSessionStartedAt(original);

    const deadlines: number[] = [];
    for (let reconnect = 0; reconnect < 3; reconnect += 1) {
      const lease = await prepareRevocationLeaseForStart(f.sessionId);
      expect(lease.ok).toBe(true);
      if (!lease.ok) return;
      deadlines.push(lease.lease.hardDeadline);
      await sendAnswer(f, await commitOffer(f));
    }

    expect(new Set(deadlines).size).toBe(1);
    expect(deadlines[0]).toBeLessThanOrEqual(original.getTime() + REVOCATION_LEASE_HARD_CAP_MS);

    // The other side of the deadline: a session still inside its maximum keeps
    // renewing after the same reconnects, on the deadline it already had.
    const renewal = await renewRevocationLease(f.sessionId);
    expect(renewal).toMatchObject({ status: 'renewed', hardDeadline: deadlines[0] });
    expect((await readSession(f.sessionId)).status).toBe('active');
  });

  it('a session past original + max is revoked even after N reconnects', async () => {
    const original = new Date(Date.now() - REVOCATION_LEASE_HARD_CAP_MS - 60_000);
    const f = await liveSessionStartedAt(original);

    for (let reconnect = 0; reconnect < 3; reconnect += 1) {
      const lease = await prepareRevocationLeaseForStart(f.sessionId);
      expect(lease.ok).toBe(true);
      await sendAnswer(f, await commitOffer(f));
    }

    const renewal = await renewRevocationLease(f.sessionId);
    expect(renewal).toMatchObject({ status: 'revoked', reason: 'hard_deadline' });
    expect((await readSession(f.sessionId)).status).toBe('disconnected');
  });

  it('a WebSocket-fallback start after a reconnect keeps the original start too', async () => {
    const original = new Date(Date.now() - 60 * 60 * 1000);
    const f = await liveSessionStartedAt(original);

    // The WebSocket path only accepts a `connecting` row, which is what a
    // WebRTC re-offer leaves behind. Without this the fallback is a second way
    // to restart the clock.
    await commitOffer(f);
    const result = await withSystemDbAccessContext(() =>
      commitDesktopStreamStartIntent({
        sessionId: f.sessionId,
        startCommandId: `desk-start-${f.sessionId}-${randomUUID()}`,
        promptMode: 'off',
        consentUnavailableBehavior: null,
      }),
    );

    expect(result.ok).toBe(true);
    expect((await readSession(f.sessionId)).startedAt!.getTime()).toBe(original.getTime());
  });

  it('the first WebSocket-fallback start still stamps the start attempt', async () => {
    const f = await buildFixture();
    await backdateCreation(f.sessionId);

    const before = Date.now();
    const result = await withSystemDbAccessContext(() =>
      commitDesktopStreamStartIntent({
        sessionId: f.sessionId,
        startCommandId: `desk-start-${f.sessionId}-${randomUUID()}`,
        promptMode: 'off',
        consentUnavailableBehavior: null,
      }),
    );
    const after = Date.now();

    expect(result.ok).toBe(true);
    const row = await readSession(f.sessionId);
    expect(row.status).toBe('connecting');
    expect(row.startedAt!.getTime()).toBeGreaterThanOrEqual(before - 1_000);
    expect(row.startedAt!.getTime()).toBeLessThanOrEqual(after + 1_000);
  });
});

describe('#11149 staleness is measured from the latest start attempt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['long after the last answer', 60 * MINUTE_MS, 60 * MINUTE_MS],
    ['a second reconnect, 90 s after the previous answer', 3 * MINUTE_MS, 1.5 * MINUTE_MS],
  ])('a re-offer %s survives every stale cleanup', async (_label, startedAgoMs, answeredAgoMs) => {
    const original = agoMs(startedAgoMs);
    const f = await liveSessionStartedAt(original);
    await getTestDb()
      .update(remoteSessions)
      .set({ createdAt: agoMs(startedAgoMs + MINUTE_MS) })
      .where(eq(remoteSessions.id, f.sessionId));
    await backdateAttempt(f.sessionId, agoMs(answeredAgoMs));

    const before = Date.now();
    await commitOffer(f);

    expect(await readsAsStale(f.sessionId)).toBe(false);
    await runStaleCleanups(f);

    const row = await readSession(f.sessionId);
    expect(row.status).toBe('connecting');
    expectFresh(row.lastStartAttemptAt, before);
    expect(row.startedAt!.getTime()).toBe(original.getTime());
  });

  it('a reconnect that falls back to the WebSocket path survives every stale cleanup', async () => {
    const original = agoMs(60 * MINUTE_MS);
    const f = await liveSessionStartedAt(original);
    await commitOffer(f);
    await backdateAttempt(f.sessionId, agoMs(3 * MINUTE_MS));

    const before = Date.now();
    const result = await withSystemDbAccessContext(() =>
      commitDesktopStreamStartIntent({
        sessionId: f.sessionId,
        startCommandId: `desk-start-${f.sessionId}-${randomUUID()}`,
        promptMode: 'off',
        consentUnavailableBehavior: null,
      }),
    );
    expect(result.ok).toBe(true);

    expect(await readsAsStale(f.sessionId)).toBe(false);
    await runStaleCleanups(f);

    const row = await readSession(f.sessionId);
    expect(row.status).toBe('connecting');
    expectFresh(row.lastStartAttemptAt, before);
    expect(row.startedAt!.getTime()).toBe(original.getTime());
  });

  it('an agent answer stamps the attempt and leaves the original start alone', async () => {
    const original = agoMs(60 * MINUTE_MS);
    const f = await liveSessionStartedAt(original);
    const startCommandId = await commitOffer(f);
    await backdateAttempt(f.sessionId, agoMs(MINUTE_MS));

    const before = Date.now();
    await sendAnswer(f, startCommandId);

    const row = await readSession(f.sessionId);
    expect(row.status).toBe('active');
    expectFresh(row.lastStartAttemptAt, before);
    expect(row.startedAt!.getTime()).toBe(original.getTime());
  });

  it('a first offer on an old pending row is measured from the offer', async () => {
    const f = await buildFixture();
    await getTestDb()
      .update(remoteSessions)
      .set({ createdAt: agoMs(11 * MINUTE_MS), lastStartAttemptAt: agoMs(11 * MINUTE_MS) })
      .where(eq(remoteSessions.id, f.sessionId));

    await commitOffer(f);
    await runStaleCleanups(f);

    expect((await readSession(f.sessionId)).status).toBe('connecting');
  });

  it('a new row starts its clock at creation, so an abandoned pending row still expires', async () => {
    const f = await buildFixture();
    // Both defaults come from the same statement's now(), so this does not
    // depend on the database and test clocks agreeing.
    const created = await readSession(f.sessionId);
    expect(created.lastStartAttemptAt.getTime()).toBe(created.createdAt.getTime());
    expect(await readsAsStale(f.sessionId)).toBe(false);

    await backdateAttempt(f.sessionId, agoMs(6 * MINUTE_MS));

    expect(await readsAsStale(f.sessionId)).toBe(true);
  });

  it('a refused offer does not move the attempt clock', async () => {
    const f = await buildFixture();
    await commitOffer(f);
    const attemptAt = agoMs(MINUTE_MS);
    await backdateAttempt(f.sessionId, attemptAt);

    const refused = await withSystemDbAccessContext(() =>
      commitDesktopStartIntent({
        sessionId: f.sessionId,
        startCommandId: `desk-start-${f.sessionId}-${randomUUID()}`,
        promptMode: 'off',
        consentUnavailableBehavior: null,
        offer: 'v=0\r\nsecond-offer\r\n',
      }),
    );

    expect(refused).toEqual({ ok: false, reason: 'start_in_flight' });
    expect((await readSession(f.sessionId)).lastStartAttemptAt.getTime()).toBe(attemptAt.getTime());
  });

  it('an abandoned re-offer is stale 2 minutes after its attempt, however recent the start', async () => {
    const f = await liveSessionStartedAt(new Date());
    await commitOffer(f);
    await backdateAttempt(f.sessionId, agoMs(3 * MINUTE_MS));

    expect(await readsAsStale(f.sessionId)).toBe(true);
    await runReaper();
    expect((await readSession(f.sessionId)).status).toBe('connecting');

    await withSystemDbAccessContext(() => expireStaleSessionsForUser(f.userId));
    expect((await readSession(f.sessionId)).status).toBe('disconnected');
  });

  it('the reaper ends a connecting row 10 minutes after its attempt, however recent the start', async () => {
    const f = await liveSessionStartedAt(new Date());
    await commitOffer(f);
    await backdateAttempt(f.sessionId, agoMs(11 * MINUTE_MS));

    await runReaper();

    expect((await readSession(f.sessionId)).status).toBe('disconnected');
  });

  it('an active row is never stale on age, however old its attempt', async () => {
    const f = await liveSessionStartedAt(agoMs(60 * MINUTE_MS));
    await backdateAttempt(f.sessionId, agoMs(60 * MINUTE_MS));

    expect(await readsAsStale(f.sessionId)).toBe(false);
    await runStaleCleanups(f);

    expect((await readSession(f.sessionId)).status).toBe('active');
  });

  it('the hard deadline still fires on the original start while a fresh re-offer is in progress', async () => {
    const f = await liveSessionStartedAt(agoMs(REVOCATION_LEASE_HARD_CAP_MS + MINUTE_MS));
    const before = Date.now();
    await commitOffer(f);
    const row = await readSession(f.sessionId);
    expect(row.status).toBe('connecting');
    expectFresh(row.lastStartAttemptAt, before);

    const renewal = await renewRevocationLease(f.sessionId);

    expect(renewal).toMatchObject({ status: 'revoked', reason: 'hard_deadline' });
    expect((await readSession(f.sessionId)).status).toBe('disconnected');
  });

  describe('migration', () => {
    const ROLLBACK = new Error('roll back the migration replay');

    it('backfills from the original start, then creation, in UTC, and re-applying changes nothing', async () => {
      const answered = await buildFixture();
      const neverAnswered = await buildFixture();
      const migration = await readFile(
        new URL('../../../migrations/2027-01-22-200100-remote-sessions-last-start-attempt.sql', import.meta.url),
        'utf8',
      );

      // Everything runs in one transaction and rolls back, so the rest of the
      // suite keeps its column.
      await getTestDb()
        .transaction(async (tx) => {
          await tx.execute(sql`
            UPDATE remote_sessions SET started_at = '2027-01-01 10:00:00', created_at = '2027-01-01 09:00:00'
             WHERE id = ${answered.sessionId}::uuid`);
          await tx.execute(sql`
            UPDATE remote_sessions SET started_at = NULL, created_at = '2027-01-01 08:00:00'
             WHERE id = ${neverAnswered.sessionId}::uuid`);
          await tx.execute(sql`ALTER TABLE remote_sessions DROP COLUMN last_start_attempt_at`);
          // A session zone that is not UTC: a bare cast would shift the backfill.
          await tx.execute(sql`SET LOCAL TimeZone = 'America/New_York'`);

          await tx.execute(sql.raw(migration));

          const readStamp = async (sessionId: string) => {
            const rows = await tx.execute(sql`
              SELECT to_char(last_start_attempt_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS stamp
                FROM remote_sessions WHERE id = ${sessionId}::uuid`);
            return (rows as unknown as { stamp: string }[])[0]?.stamp;
          };
          expect(await readStamp(answered.sessionId)).toBe('2027-01-01 10:00:00');
          expect(await readStamp(neverAnswered.sessionId)).toBe('2027-01-01 08:00:00');

          await tx.execute(sql`
            UPDATE remote_sessions SET last_start_attempt_at = '2027-01-02 00:00:00+00'
             WHERE id = ${answered.sessionId}::uuid`);
          await tx.execute(sql.raw(migration));
          expect(await readStamp(answered.sessionId)).toBe('2027-01-02 00:00:00');

          const columns = await tx.execute(sql`
            SELECT is_nullable, column_default, data_type FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'remote_sessions'
               AND column_name = 'last_start_attempt_at'`);
          expect((columns as unknown as Record<string, string>[])[0]).toEqual({
            is_nullable: 'NO',
            column_default: 'now()',
            data_type: 'timestamp with time zone',
          });

          throw ROLLBACK;
        })
        .catch((err) => {
          if (err !== ROLLBACK) throw err;
        });
    });
  });
});
