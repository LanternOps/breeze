/**
 * Wisp W08 Task 4 + Task 13 (#9914, feature #9906; Review Focus 1–3) — thread
 * links against real Postgres: every read re-derives tenancy from the entity
 * and re-checks the caller, the live ceiling and the token.
 *
 * Partner P, orgs A and B; grantor U is a partner technician (org_access
 * 'all') whose partner role holds tickets/users read. Grant G is partner-wide
 * over A and B; its thread links a ticket in A, a ticket in B and a user
 * (org_id NULL). Then:
 *   (a) G narrowed to A (new revision) → listLinks, the home, the session seed
 *       and list_links return A's link + the user link; B's row still exists;
 *   (b) A's ticket deleted → the next listLinks deletes its row;
 *   (c) an org-scoped context for A sees only A's row by RLS, and an org token
 *       never resolves the partner-level user link (outside_token_scope);
 *   (d) U loses tickets:read → ticket links vanish from the home, rows stay.
 * Plus the service contract: idempotent re-add, a model-made-up orgId is
 * not_found, the 50-link cap.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import * as testSetup from './setup';
import { replayMigration } from './replayMigration';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import {
  permissions,
  rolePermissions,
  tickets,
  wispGrantRevisions,
  wispGrants,
  wispThreadLinks,
} from '../../db/schema';
import type { WispCeilingSnapshot } from '../../db/schema/wisp';
import { buildOrgAccessClosures, type AuthContext } from '../../middleware/auth';
import { resolveEntityRef } from '../../services/wisp/entityRefs';
import { resolveGrantCeiling } from '../../services/wisp/grantAuthority';
import { buildHomeSections } from '../../services/wisp/home';
import { addLink, listLinks, ThreadLinkError } from '../../services/wisp/threadLinks';
import { registerWispLinkTools } from '../../services/wisp/linkTools';
import { getOrCreateThread, seedContextForSession } from '../../services/wisp/threads';
import type { AiTool } from '../../services/aiTools';
import {
  assignUserToPartner,
  createOrganization,
  createPartner,
  createRole,
  createUser,
  grantRolePermissions,
} from './db-utils';

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null, userId: null,
};
const asSystem = <T>(fn: () => Promise<T>) => withDbAccessContext(SYSTEM_CTX, fn);

const KEYS = ['ai_sessions:use', 'tickets:read', 'users:read'];
const perm = (key: string) => {
  const [resource, action] = key.split(':') as [string, string];
  return { resource, action };
};

beforeEach(() => {
  vi.stubEnv('IS_HOSTED', 'true');
  vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true');
  vi.stubEnv('BREEZE_WISP_ENABLED', 'true');
});
afterEach(() => vi.unstubAllEnvs());

async function insertRevision(grantId: string, partnerId: string, revision: number, orgIds: string[], partnerWide: boolean) {
  const snapshot: WispCeilingSnapshot = {
    version: 1, permissionKeys: KEYS, orgIds, siteIds: null, toolAllowlist: null, deniedTools: [], partnerWide,
  };
  return asSystem(async () => {
    const [r] = await db.insert(wispGrantRevisions).values({
      grantId, partnerId, revision, ceilingSnapshot: snapshot,
      factorProof: { method: 'step_up', verifiedAt: new Date().toISOString() },
    }).returning({ id: wispGrantRevisions.id });
    await db.update(wispGrants).set({ currentRevisionId: r!.id }).where(eq(wispGrants.id, grantId));
    return r!.id;
  });
}

async function insertTicket(orgId: string, partnerId: string, subject: string) {
  return asSystem(async () => {
    const [t] = await db.insert(tickets).values({
      orgId, partnerId, ticketNumber: `WL-${randomUUID().slice(0, 12)}`, subject, source: 'manual',
    }).returning({ id: tickets.id, ticketNumber: tickets.ticketNumber });
    return t!;
  });
}

async function seed() {
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });
  const grantor = await createUser({ partnerId: partner.id, email: `wisp-links-${randomUUID()}@wisp.test` });
  const other = await createUser({ partnerId: partner.id, email: `wisp-links-other-${randomUUID()}@wisp.test` });
  const role = await createRole({ scope: 'partner', partnerId: partner.id });
  await grantRolePermissions(role.id, KEYS.map(perm));
  await assignUserToPartner(grantor.id, partner.id, role.id, 'all');

  const grantId = await asSystem(async () => {
    const [g] = await db.insert(wispGrants).values({
      partnerId: partner.id, orgId: null, grantorUserId: grantor.id,
      expiresAt: new Date(Date.now() + 30 * 86_400_000),
    }).returning({ id: wispGrants.id });
    return g!.id;
  });
  let revisionId = await insertRevision(grantId, partner.id, 1, [orgA.id, orgB.id], true);
  const thread = await getOrCreateThread(grantId);
  const ticketA = await insertTicket(orgA.id, partner.id, 'Printer offline in A');
  const ticketB = await insertTicket(orgB.id, partner.id, 'VPN down in B');

  const auth = {
    principal: { kind: 'user' },
    user: { id: grantor.id, email: grantor.email, name: 'Grantor', isPlatformAdmin: false },
    token: null, partnerId: partner.id, orgId: null, scope: 'partner', partnerOrgAccess: 'all',
    accessibleOrgIds: [orgA.id, orgB.id],
    ...buildOrgAccessClosures([orgA.id, orgB.id]),
  } as unknown as AuthContext;
  const requestCtx: DbAccessContext = {
    scope: 'partner', orgId: null, accessibleOrgIds: [orgA.id, orgB.id], accessiblePartnerIds: [partner.id],
    userId: grantor.id, currentPartnerId: partner.id,
  };

  const env = {
    partner, orgA, orgB, grantor, other, role, grantId, thread, ticketA, ticketB, auth, requestCtx,
    get revisionId() { return revisionId; },
    narrowTo: async (orgIds: string[]) => { revisionId = await insertRevision(grantId, partner.id, 2, orgIds, false); },
    ceiling: () => resolveGrantCeiling(grantId, revisionId),
    inRequest: <T>(fn: () => Promise<T>) => withDbAccessContext(requestCtx, fn),
  };
  return env;
}
type Env = Awaited<ReturnType<typeof seed>>;

async function linkAll(env: Env) {
  const ceiling = await env.ceiling();
  const ctx = { auth: env.auth, ceiling };
  return env.inRequest(async () => ({
    a: await addLink(ctx, env.thread.id, { kind: 'ticket', id: env.ticketA.id }),
    b: await addLink(ctx, env.thread.id, { kind: 'ticket', id: env.ticketB.id }),
    u: await addLink(ctx, env.thread.id, { kind: 'user', id: env.other.id }),
  }));
}

const rowsOf = (threadId: string) => asSystem(() => db.select().from(wispThreadLinks).where(eq(wispThreadLinks.threadId, threadId)));
const refusal = async (p: Promise<unknown>) => p.then(() => 'resolved', (e) => (e instanceof ThreadLinkError ? e.code : `threw ${String(e)}`));

describe('thread links working-set migration (real Postgres)', () => {
  it('migration backfills source and recency', async () => {
    const env = await seed();
    const testDb = testSetup.getTestDb();
    // Fail before DDL when the migration has not shipped yet.
    await testDb.execute(sql`SELECT source, last_touched_at, touch_count FROM wisp_thread_links LIMIT 0`);
    const rollback = new Error('rollback migration fixture');
    await expect(testDb.transaction(async (tx) => {
      // Roll back all DDL and fixtures even if replay or an assertion fails.
      await tx.execute(sql`ALTER TABLE wisp_thread_links
        DROP COLUMN source, DROP COLUMN last_touched_at, DROP COLUMN touch_count`);
      await tx.execute(sql`SELECT set_config('breeze.scope', 'system', true)`);
      for (const grantId of [null, env.grantId]) {
        await tx.execute(sql`INSERT INTO wisp_thread_links
          (thread_id, partner_id, org_id, entity_kind, entity_id, label,
           added_by_user_id, added_by_grant_id, created_at)
          VALUES (${env.thread.id}, ${env.partner.id}, ${env.orgA.id}, 'ticket',
            ${randomUUID()}, 'Legacy link', ${env.grantor.id}, ${grantId},
            '2026-01-02T03:04:05.123456Z')`);
      }
      // Route the standard replay helper through this rollback-only transaction.
      const connection = vi.spyOn(testSetup, 'getTestDb').mockReturnValue(tx);
      try {
        await replayMigration('2027-01-09-130000-wisp-thread-links-working-set.sql');
        const rows = await tx.execute(sql`SELECT source, touch_count,
          last_touched_at = created_at AS recency_backfilled
          FROM wisp_thread_links WHERE thread_id = ${env.thread.id} ORDER BY source`);
        expect([...rows]).toEqual([
          { source: 'user_pin', touch_count: 1, recency_backfilled: true },
          { source: 'wisp_pin', touch_count: 1, recency_backfilled: true },
        ]);
        const indexes = await tx.execute(sql`SELECT indexdef FROM pg_indexes
          WHERE schemaname = 'public' AND indexname = 'wisp_thread_links_thread_touched_idx'`);
        expect(indexes).toHaveLength(1);
        expect(indexes[0]!.indexdef).toContain('(thread_id, last_touched_at DESC)');
        await expect(tx.transaction(async (savepoint) => {
          await savepoint.execute(sql`UPDATE wisp_thread_links SET source = 'unknown'
            WHERE thread_id = ${env.thread.id}`);
        })).rejects.toMatchObject({ cause: { code: '23514' } });
        await tx.execute(sql`UPDATE wisp_thread_links SET source = 'auto', touch_count = 7,
          last_touched_at = '2026-02-03T04:05:06Z' WHERE thread_id = ${env.thread.id}`);
        await replayMigration('2027-01-09-130000-wisp-thread-links-working-set.sql');
        const replayed = await tx.execute(sql`SELECT source, touch_count,
          last_touched_at = '2026-02-03T04:05:06Z'::timestamptz AS recency_preserved
          FROM wisp_thread_links WHERE thread_id = ${env.thread.id}`);
        expect([...replayed]).toEqual(Array(2).fill({
          source: 'auto', touch_count: 7, recency_preserved: true,
        }));
      } finally {
        connection.mockRestore();
      }
      throw rollback;
    })).rejects.toBe(rollback);
  });
});

describe('thread links service (real Postgres)', () => {
  it('links take the org from the entity; labels come from the entity; partner-level user has org null', async () => {
    const env = await seed();
    const { a, b, u } = await linkAll(env);
    expect(a.ref).toEqual({ kind: 'ticket', id: env.ticketA.id, orgId: env.orgA.id });
    expect(a.label).toBe(`#${env.ticketA.ticketNumber} Printer offline in A`);
    expect(b.ref.orgId).toBe(env.orgB.id);
    expect(u.ref.orgId).toBeNull();
    expect(a.source).toBe('user_pin');
    const rows = await rowsOf(env.thread.id);
    expect(rows.map((r) => r.orgId).sort()).toEqual([env.orgA.id, env.orgB.id, null].sort());
    expect(rows.map((r) => r.source)).toEqual(['user_pin', 'user_pin', 'user_pin']);
  });

  it.each([false, true])('derives source from the insert grant (has grant: %s)', async (hasGrant) => {
    const env = await seed();
    const ceiling = await env.ceiling();
    await env.inRequest(() => addLink(
      { auth: env.auth, ceiling }, env.thread.id, { kind: 'ticket', id: env.ticketA.id },
      { addedByGrantId: hasGrant ? env.grantId : null },
    ));
    const [row] = await rowsOf(env.thread.id);
    expect(row).toMatchObject({
      addedByGrantId: hasGrant ? env.grantId : null,
      source: hasGrant ? 'wisp_pin' : 'user_pin',
      touchCount: 1,
    });
    expect(row!.lastTouchedAt).toEqual(row!.createdAt);
  });

  it('re-adding the same entity is idempotent (same row id)', async () => {
    const env = await seed();
    const { a } = await linkAll(env);
    const ceiling = await env.ceiling();
    const again = await env.inRequest(() => addLink({ auth: env.auth, ceiling }, env.thread.id, { kind: 'ticket', id: env.ticketA.id }));
    expect(again.id).toBe(a.id);
    expect(await rowsOf(env.thread.id)).toHaveLength(3);
  });

  it('a made-up orgId (Review Focus 3) is not_found and writes nothing', async () => {
    const env = await seed();
    const ceiling = await env.ceiling();
    const code = await refusal(env.inRequest(() => addLink(
      { auth: env.auth, ceiling }, env.thread.id, { kind: 'ticket', id: env.ticketA.id, orgId: env.orgB.id }, { addedByGrantId: env.grantId },
    )));
    expect(code).toBe('not_found');
    expect(await rowsOf(env.thread.id)).toHaveLength(0);
  });

  it('another partner\'s ticket is not_found', async () => {
    const env = await seed();
    const otherPartner = await createPartner();
    const otherOrg = await createOrganization({ partnerId: otherPartner.id });
    const foreign = await insertTicket(otherOrg.id, otherPartner.id, 'not yours');
    const ceiling = await env.ceiling();
    expect(await refusal(env.inRequest(() => addLink({ auth: env.auth, ceiling }, env.thread.id, { kind: 'ticket', id: foreign.id }))))
      .toBe('not_found');
  });

  it('caps a thread at 50 links (link_limit)', async () => {
    const env = await seed();
    await asSystem(() => db.insert(wispThreadLinks).values(Array.from({ length: 50 }, () => ({
      threadId: env.thread.id, partnerId: env.partner.id, orgId: env.orgA.id, entityKind: 'ticket' as const,
      entityId: randomUUID(), label: 'filler', addedByUserId: env.grantor.id, source: 'user_pin' as const,
    }))));
    const ceiling = await env.ceiling();
    expect(await refusal(env.inRequest(() => addLink({ auth: env.auth, ceiling }, env.thread.id, { kind: 'ticket', id: env.ticketA.id }))))
      .toBe('link_limit');
  });

  it('the cap counts partner-level rows an org-scoped caller cannot see', async () => {
    const env = await seed();
    await asSystem(() => db.insert(wispThreadLinks).values(Array.from({ length: 50 }, () => ({
      threadId: env.thread.id, partnerId: env.partner.id, orgId: null, entityKind: 'user' as const,
      entityId: randomUUID(), label: 'filler', addedByUserId: env.grantor.id, source: 'user_pin' as const,
    }))));
    const ceiling = await env.ceiling();
    const orgToken = { ...env.auth, scope: 'organization', orgId: env.orgA.id } as AuthContext;
    const orgCtx: DbAccessContext = {
      scope: 'organization', orgId: env.orgA.id, accessibleOrgIds: [env.orgA.id], accessiblePartnerIds: [],
      userId: env.grantor.id, currentPartnerId: env.partner.id,
    };
    expect(await refusal(withDbAccessContext(orgCtx, () => addLink({ auth: orgToken, ceiling }, env.thread.id, { kind: 'ticket', id: env.ticketA.id }))))
      .toBe('link_limit');
  });
});

describe('Task 13 — revocation drops a link everywhere (real Postgres)', () => {
  it('(a) narrowing the grant to org A hides org B\'s link from listLinks and the home; the row stays', async () => {
    const env = await seed();
    const { a, b, u } = await linkAll(env);
    await env.narrowTo([env.orgA.id]);
    const ceiling = await env.ceiling();

    const listed = await env.inRequest(() => listLinks({ auth: env.auth, ceiling }, env.thread.id));
    // The user link needs a partner-wide grant: the narrowed (org-scoped breadth) revision drops it too.
    expect(listed.map((l) => l.id)).toEqual([a.id]);

    const home = await env.inRequest(() => buildHomeSections({
      auth: env.auth, partnerId: env.partner.id, grantId: env.grantId, grantorUserId: env.grantor.id, threadId: env.thread.id, ceiling,
    }));
    expect(home.links.map((l) => l.id)).toEqual([a.id]);

    // The session seed (no caller: the live ceiling decides) carries A's handle only.
    const seedText = await withDbAccessContext(SYSTEM_CTX, () => seedContextForSession(env.thread.id, ceiling));
    expect(seedText).toContain(`id=${env.ticketA.id}`);
    expect(seedText).not.toContain(env.ticketB.id);
    expect(seedText).not.toContain(env.other.id);

    // list_links from a chat turn under the narrowed grant.
    const tools = new Map<string, AiTool>();
    registerWispLinkTools(tools);
    const chatAuth = { ...env.auth, wispGrant: { grantId: env.grantId, grantRevisionId: env.revisionId, sessionId: null } } as AuthContext;
    const out = await env.inRequest(async () => String(await tools.get('list_links')!.handler({}, chatAuth)));
    expect(out).toContain(env.ticketA.id);
    expect(out).not.toContain(env.ticketB.id);
    expect(out).not.toContain(env.other.id);

    expect((await rowsOf(env.thread.id)).map((r) => r.id).sort()).toEqual([a.id, b.id, u.id].sort());
  });

  it('(b) deleting org A\'s ticket deletes its link row on the next read', async () => {
    const env = await seed();
    const { a } = await linkAll(env);
    await asSystem(() => db.delete(tickets).where(eq(tickets.id, env.ticketA.id)));
    const ceiling = await env.ceiling();
    const listed = await env.inRequest(() => listLinks({ auth: env.auth, ceiling }, env.thread.id));
    expect(listed.map((l) => l.id)).not.toContain(a.id);
    expect((await rowsOf(env.thread.id)).map((r) => r.id)).not.toContain(a.id);
    expect(await rowsOf(env.thread.id)).toHaveLength(2);
  });

  it('(c) an org-scoped context for A sees only A\'s row; an org token never resolves the user link', async () => {
    const env = await seed();
    const { a } = await linkAll(env);
    const orgCtx: DbAccessContext = {
      scope: 'organization', orgId: env.orgA.id, accessibleOrgIds: [env.orgA.id], accessiblePartnerIds: [],
      userId: env.grantor.id, currentPartnerId: env.partner.id,
    };
    const visible = await withDbAccessContext(orgCtx, () => db.select({ id: wispThreadLinks.id }).from(wispThreadLinks)
      .where(eq(wispThreadLinks.threadId, env.thread.id)));
    expect(visible.map((r) => r.id)).toEqual([a.id]);

    const orgToken = { ...env.auth, scope: 'organization', orgId: env.orgA.id } as AuthContext;
    const ceiling = await env.ceiling();
    expect(await resolveEntityRef({ auth: orgToken, ceiling }, { kind: 'user', id: env.other.id })).toEqual({ reason: 'outside_token_scope' });
    expect(await resolveEntityRef({ auth: orgToken, ceiling }, { kind: 'ticket', id: env.ticketB.id })).toEqual({ reason: 'outside_token_scope' });

    // A Wisp session created from an org-scoped sign-in: the seed carries A's handle only.
    const seedText = await withDbAccessContext(SYSTEM_CTX, () => seedContextForSession(env.thread.id, ceiling, orgToken));
    expect(seedText).toContain(`id=${env.ticketA.id}`);
    expect(seedText).not.toContain(env.ticketB.id);
    expect(seedText).not.toContain(env.other.id);
  });

  it('(d) the grantor losing tickets:read drops ticket links from the home; the rows remain', async () => {
    const env = await seed();
    await linkAll(env);
    await asSystem(async () => {
      const [p] = await db.select({ id: permissions.id }).from(permissions)
        .where(and(eq(permissions.resource, 'tickets'), eq(permissions.action, 'read'))).limit(1);
      await db.delete(rolePermissions).where(and(eq(rolePermissions.roleId, env.role.id), eq(rolePermissions.permissionId, p!.id)));
    });
    const ceiling = await env.ceiling();
    const home = await env.inRequest(() => buildHomeSections({
      auth: env.auth, partnerId: env.partner.id, grantId: env.grantId, grantorUserId: env.grantor.id, threadId: env.thread.id, ceiling,
    }));
    expect(home.links.map((l) => l.ref.kind)).toEqual(['user']);
    expect(await rowsOf(env.thread.id)).toHaveLength(3);
  });
});
