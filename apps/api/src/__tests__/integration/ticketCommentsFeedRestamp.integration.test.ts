/**
 * Feed-only invalidation, per comment writer (Partner API tickets, design doc
 * §5.2; migration 2026-12-13-110000).
 *
 * `breeze_ticket_comments_touch_parent_feed` restamps the parent ticket's
 * `partner_feed_xid` whenever a comment is inserted, edited or soft-deleted.
 * It is SECURITY INVOKER: it runs with the WRITER's role and RLS context, so
 * it only works because whatever may write a comment may also update its
 * parent. That equivalence is a property of the policies, not of the trigger,
 * and its failure mode is SILENT (the UPDATE matches zero rows, the feed
 * misses the comment, nothing errors). So it is proven here, one case per
 * writer, through the production `db` pool — which connects as the
 * unprivileged `breeze_app` role — inside the DB context that writer really
 * uses. The test database's owner is a superuser, so a SECURITY DEFINER
 * version of the trigger would pass these cases vacuously.
 *
 * A new comment writer or a new ticket_comments policy MUST add its case.
 */
import './setup';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { partnerServicePrincipals, portalUsers, ticketComments, tickets } from '../../db/schema';
import { agentDbAccessContext } from '../../services/aiAgents/agentAuthContext';
import { deleteTicketComment, editTicketComment } from '../../services/ticketService';
import { createOrganization, createPartner, createUser } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

type CommentInsert = typeof ticketComments.$inferInsert;

async function seed() {
  const admin = getTestDb();
  const partner = await createPartner({ name: 'FeedRestamp-Partner' });
  const user = await createUser({ partnerId: partner.id });
  const org = await createOrganization({ partnerId: partner.id, name: 'FeedRestamp-Org' });
  const otherOrg = await createOrganization({ partnerId: partner.id, name: 'FeedRestamp-Other' });
  const [portalUser] = await admin.insert(portalUsers).values({
    orgId: org.id,
    email: `feed-restamp-${crypto.randomUUID()}@example.test`,
    name: 'Portal Requester',
  }).returning();
  const [principal] = await admin.insert(partnerServicePrincipals).values({
    partnerId: partner.id,
    name: `Feed restamp ${crypto.randomUUID()}`,
    scopes: ['tickets:read', 'tickets:write'],
    sourceCidrs: [],
    expiresAt: null,
    createdBy: user.id,
    updatedBy: user.id,
  }).returning();
  if (!portalUser || !principal) throw new Error('feed restamp seed failed');
  return { partner, org, otherOrg, user, portalUser, principal };
}

async function insertTicket(orgId: string, partnerId: string) {
  const [row] = await getTestDb().insert(tickets).values({
    orgId, partnerId, subject: 'feed restamp', source: 'api', priority: 'normal',
    ticketNumber: `RST-${crypto.randomUUID().slice(0, 8)}`,
  }).returning({ id: tickets.id });
  return row!.id;
}

async function stamp(ticketId: string): Promise<{ xid: bigint; updatedAt: string }> {
  const [row] = (await getTestDb().execute(sql`
    SELECT partner_feed_xid::text AS xid, updated_at::text AS updated_at FROM tickets WHERE id = ${ticketId}
  `)) as unknown as Array<{ xid: string; updated_at: string }>;
  return { xid: BigInt(row!.xid), updatedAt: row!.updated_at };
}

/** Sanity: the production pool really is the unprivileged role under forced RLS. */
async function currentRole(ctx: DbAccessContext): Promise<{ role: string; bypass: boolean }> {
  return withDbAccessContext(ctx, async () => {
    const [row] = (await db.execute(sql`
      SELECT current_user::text AS role,
             (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypass
    `)) as unknown as Array<{ role: string; bypass: boolean }>;
    return row!;
  });
}

describe('ticket_comments writes restamp the parent ticket feed column, as breeze_app', () => {
  runDb('every comment writer restamps its parent ticket and leaves updated_at alone', async () => {
    const f = await seed();
    const orgCtx = (userId: string | null): DbAccessContext => ({
      scope: 'organization', orgId: f.org.id, accessibleOrgIds: [f.org.id], accessiblePartnerIds: [],
      currentPartnerId: f.partner.id, userId,
    });
    const partnerCtx = (userId: string | null): DbAccessContext => ({
      scope: 'partner', orgId: null, accessibleOrgIds: [f.org.id, f.otherOrg.id], accessiblePartnerIds: [f.partner.id],
      currentPartnerId: f.partner.id, userId,
    });

    expect(await currentRole(orgCtx(f.user.id))).toEqual({ role: 'breeze_app', bypass: false });

    // One case per INSERT policy on ticket_comments, in the context its writer uses.
    const writers: Array<{
      name: string;
      run: <T>(fn: () => Promise<T>) => Promise<T>;
      row: Omit<CommentInsert, 'ticketId'>;
    }> = [
      {
        name: 'staff, organization scope (breeze_user_isolation_insert)',
        run: (fn) => withDbAccessContext(orgCtx(f.user.id), fn),
        row: { userId: f.user.id, authorType: 'internal', content: 'staff org', isPublic: false },
      },
      {
        name: 'staff, partner scope (breeze_user_isolation_insert)',
        run: (fn) => withDbAccessContext(partnerCtx(f.user.id), fn),
        row: { userId: f.user.id, authorType: 'internal', content: 'staff partner', isPublic: true },
      },
      {
        name: 'portal (breeze_ticket_parent_portal_insert)',
        run: (fn) => withDbAccessContext(orgCtx(null), fn),
        row: { portalUserId: f.portalUser.id, authorType: 'portal', authorName: 'Portal Requester', content: 'portal', isPublic: true },
      },
      {
        name: 'inbound email, organization scope (breeze_ticket_parent_email_insert)',
        run: (fn) => withDbAccessContext(orgCtx(null), fn),
        row: { authorType: 'email', authorName: 'jane@example.test', content: 'email', isPublic: true },
      },
      {
        name: 'inbound email, system scope (the inbound worker)',
        run: (fn) => withSystemDbAccessContext(fn),
        row: { authorType: 'email', authorName: 'jane@example.test', content: 'email system', isPublic: true },
      },
      {
        name: 'AI note, agent context (breeze_ticket_parent_ai_agent_insert)',
        run: (fn) => withDbAccessContext(agentDbAccessContext(f.org.id, f.partner.id), fn),
        row: { authorType: 'ai_agent', authorName: 'AI Agent', commentType: 'internal', originPrincipalKind: 'ai_agent', content: 'ai note', isPublic: false },
      },
      {
        name: 'system note (breeze_ticket_parent_system_note_insert)',
        run: (fn) => withDbAccessContext(orgCtx(f.user.id), fn),
        row: { authorType: 'internal', authorName: 'Breeze', commentType: 'system', originPrincipalKind: 'system', content: 'system note', isPublic: false },
      },
      {
        name: 'service principal, partner scope (breeze_ticket_parent_service_principal_insert)',
        run: (fn) => withDbAccessContext(partnerCtx(null), fn),
        row: {
          authorType: 'internal', authorName: f.principal.name, originPrincipalKind: 'service_principal',
          originPrincipalId: f.principal.id, content: 'integration', isPublic: false,
        },
      },
    ];

    for (const writer of writers) {
      const ticketId = await insertTicket(f.org.id, f.partner.id);
      const before = await stamp(ticketId);
      const inserted = await writer.run(() =>
        db.insert(ticketComments).values({ ...writer.row, ticketId }).returning({ id: ticketComments.id }),
      );
      expect(inserted, writer.name).toHaveLength(1);
      const after = await stamp(ticketId);
      expect(after.xid > before.xid, `${writer.name}: parent ticket was not restamped`).toBe(true);
      expect(after.updatedAt, `${writer.name}: updated_at must not move`).toBe(before.updatedAt);
    }
  });

  runDb('an edit and a soft delete restamp the parent too; a column outside the trigger list does not', async () => {
    const f = await seed();
    const ctx: DbAccessContext = {
      scope: 'organization', orgId: f.org.id, accessibleOrgIds: [f.org.id], accessiblePartnerIds: [],
      currentPartnerId: f.partner.id, userId: f.user.id,
    };
    const actor = { kind: 'user' as const, userId: f.user.id, name: 'Tech' };
    const ticketId = await insertTicket(f.org.id, f.partner.id);
    const [comment] = await withDbAccessContext(ctx, () =>
      db.insert(ticketComments).values({
        ticketId, userId: f.user.id, authorType: 'internal', commentType: 'internal', content: 'first', isPublic: false,
      }).returning({ id: ticketComments.id }),
    );

    const created = await stamp(ticketId);
    await withDbAccessContext(ctx, () => editTicketComment(comment!.id, { content: 'edited' }, actor, { canManageAny: false }));
    const edited = await stamp(ticketId);
    expect(edited.xid > created.xid).toBe(true);

    // author_name is not in the trigger's column list: a write that changes
    // nothing a consumer can read does not re-deliver the ticket.
    await withDbAccessContext(ctx, () =>
      db.update(ticketComments).set({ authorName: 'Renamed' }).where(eq(ticketComments.id, comment!.id)),
    );
    expect((await stamp(ticketId)).xid).toBe(edited.xid);

    await withDbAccessContext(ctx, () => deleteTicketComment(comment!.id, actor, { canManageAny: false }));
    const deleted = await stamp(ticketId);
    expect(deleted.xid > edited.xid).toBe(true);
    expect(deleted.updatedAt).toBe(created.updatedAt);
  });

  runDb('a context that cannot reach the ticket cannot write the comment either — there is no write the restamp could miss', async () => {
    const f = await seed();
    const ticketId = await insertTicket(f.org.id, f.partner.id);
    const before = await stamp(ticketId);
    // Same partner, another organization: every INSERT policy checks the
    // parent ticket's org, so the comment is refused outright (42501).
    const foreignCtx: DbAccessContext = {
      scope: 'organization', orgId: f.otherOrg.id, accessibleOrgIds: [f.otherOrg.id], accessiblePartnerIds: [],
      currentPartnerId: f.partner.id, userId: f.user.id,
    };
    const refused = await withDbAccessContext(foreignCtx, () =>
      db.insert(ticketComments).values({
        ticketId, userId: f.user.id, authorType: 'internal', content: 'forged', isPublic: false,
      }).returning({ id: ticketComments.id }),
    ).then(() => null, (err: unknown) => err);
    expect((refused as { cause?: { code?: string } } | null)?.cause?.code).toBe('42501');
    expect((await stamp(ticketId)).xid).toBe(before.xid);
  });
});
