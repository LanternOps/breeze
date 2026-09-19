/** Current authenticated invitation serialization on disposable PostgreSQL.
 * The only substituted boundary is outbound mail; auth, permissions, request
 * context, delegation and final membership insert use the production path.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import postgres from 'postgres';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { organizationUsers } from '../../db/schema';
import { userRoutes } from '../../routes/users';
import { createAccessToken } from '../../services/jwt';
import { createSite, setupTestEnvironment } from './db-utils';
import { getTestDb } from './setup';

const mail = vi.hoisted(() => ({ sendInvite: vi.fn(async () => undefined) }));
vi.mock('../../services/email', () => ({ getEmailService: () => mail }));
const writer = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => undefined });

function barrier() {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  return { ready, release };
}

// Attach rejection handlers immediately, then drain every started operation after
// releasing barriers. A cleanup rejection must not replace the primary assertion.
function startedOperations() {
  const pending: Promise<PromiseSettledResult<unknown>[]>[] = [];
  return {
    track<T>(operation: Promise<T>): Promise<T> {
      pending.push(Promise.allSettled([operation]));
      return operation;
    },
    async drain(primaryFailed: boolean) {
      const results = (await Promise.all(pending)).flat();
      const rejected = results.find((result) => result.status === 'rejected');
      if (!primaryFailed && rejected?.status === 'rejected') throw rejected.reason;
    },
  };
}

async function blockedBy(pid: number) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const rows = await getTestDb().execute<{ waiting: number }>(sql`
      SELECT count(*)::int AS waiting FROM pg_stat_activity
      WHERE datname = current_database() AND state = 'active'
        AND ${pid} = ANY(pg_blocking_pids(pid))
    `);
    if (rows[0]?.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('expected membership writer/request lock dependency was not observed');
}

async function fixture() {
  const env = await setupTestEnvironment({ scope: 'organization', userOptions: { mfaEnabled: true },
    rolePermissions: [{ resource: 'users', action: 'invite' }] });
  const second = await createSite({ orgId: env.organization.id });
  await getTestDb().update(organizationUsers).set({ siteIds: [env.site.id, second.id] })
    .where(and(eq(organizationUsers.orgId, env.organization.id), eq(organizationUsers.userId, env.user.id)));
  const token = await createAccessToken({ sub: env.user.id, email: env.user.email,
    roleId: env.role.id, orgId: env.organization.id, partnerId: env.partner.id,
    scope: 'organization', mfa: true, aep: 1, mep: 1, sid: randomUUID() });
  const email = `invitation-${randomUUID()}@example.test`;
  const app = new Hono();
  app.route('/users', userRoutes);
  const invite = async (siteIds?: string[]) => app.request('/users/invite', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, name: 'Synthetic invitee', roleId: env.role.id, siteIds }),
  });
  const memberships = () => getTestDb().select().from(organizationUsers)
    .where(eq(organizationUsers.orgId, env.organization.id));
  return { env, second, email, invite, memberships };
}

beforeEach(() => { mail.sendInvite.mockReset(); mail.sendInvite.mockResolvedValue(undefined); });
afterAll(async () => { await writer.end({ timeout: 5 }); });

describe('authenticated invitation transaction serialization', () => {
  for (const explicitRemovedSite of [false, true]) {
    it(explicitRemovedSite ? 'denies a removed explicit site after the concurrent scope writer commits'
      : 'inherits the committed reduced scope through the final membership insert', async () => {
      const fx = await fixture();
      const changed = barrier();
      const release = barrier();
      const pid = (await writer<{ pid: number }[]>`SELECT pg_backend_pid()::int AS pid`)[0]!.pid;
      const started = startedOperations();
      let primaryFailed = false;
      try {
        const update = started.track(writer.begin(async (connection) => {
          await connection`UPDATE organization_users SET site_ids = ARRAY[${fx.second.id}]::uuid[]
            WHERE org_id = ${fx.env.organization.id} AND user_id = ${fx.env.user.id}`;
          changed.release();
          await release.ready;
        }));
        await Promise.race([changed.ready, update.then(() => {
          throw new Error('scope writer ended before its barrier');
        })]);
        const request = started.track(fx.invite(explicitRemovedSite ? [fx.env.site.id] : undefined));
        try { await blockedBy(pid); } finally { release.release(); }
        await update;
        const response = await request;
        expect(response.status).toBe(explicitRemovedSite ? 403 : 201);
        const links = await fx.memberships();
        const invited = links.filter((link) => link.userId !== fx.env.user.id);
        if (explicitRemovedSite) {
          expect(invited).toEqual([]);
          expect(mail.sendInvite).not.toHaveBeenCalled();
        } else {
          expect(invited).toHaveLength(1);
          expect(invited[0]?.siteIds).toEqual([fx.second.id]);
          expect(mail.sendInvite).toHaveBeenCalledOnce();
        }
      } catch (error) {
        primaryFailed = true;
        throw error;
      } finally {
        release.release();
        await started.drain(primaryFailed);
      }
    });
  }

  it('holds the inviter lock through membership insertion and request commit before the next scope writer', async () => {
    const fx = await fixture();
    const reachedMail = barrier();
    const releaseMail = barrier();
    mail.sendInvite.mockImplementationOnce(async () => { reachedMail.release(); await releaseMail.ready; });
    const started = startedOperations();
    let primaryFailed = false;
    try {
      const request = started.track(fx.invite([fx.env.site.id]));
      await Promise.race([reachedMail.ready, request.then(async (response) => {
        throw new Error(`request ended before inert-mail barrier: ${response.status}: ${await response.clone().text()}`);
      })]);
      // The mail boundary is after INSERT, still inside the real request context.
      // Its transaction is not visible to an independent reader until commit.
      expect(await fx.memberships()).toHaveLength(1);
      const rows = await getTestDb().execute<{ pid: number }>(sql`
        SELECT DISTINCT activity.pid FROM pg_stat_activity activity JOIN pg_locks locks USING (pid)
        WHERE activity.datname = current_database() AND activity.usename = 'breeze_app'
          AND activity.state = 'idle in transaction'
          AND locks.relation = 'organization_users'::regclass
      `);
      expect(rows).toHaveLength(1);
      const update = started.track(writer`UPDATE organization_users SET site_ids = ARRAY[${fx.second.id}]::uuid[]
        WHERE org_id = ${fx.env.organization.id} AND user_id = ${fx.env.user.id}`.execute());
      try { await blockedBy(rows[0]!.pid); } finally { releaseMail.release(); }
      expect((await request).status).toBe(201);
      await update;
      const links = await fx.memberships();
      expect(links.find((link) => link.userId === fx.env.user.id)?.siteIds).toEqual([fx.second.id]);
      expect(links.find((link) => link.userId !== fx.env.user.id)?.siteIds).toEqual([fx.env.site.id]);
      expect(mail.sendInvite).toHaveBeenCalledOnce();
    } catch (error) {
      primaryFailed = true;
      throw error;
    } finally {
      releaseMail.release();
      await started.drain(primaryFailed);
    }
  });
});
