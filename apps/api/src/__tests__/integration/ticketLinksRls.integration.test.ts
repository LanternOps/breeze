/**
 * ticket_links — RLS, constraint and FK isolation against real Postgres
 * (#7900, feature #8592 W02).
 *
 * Migration under test: 2026-12-27-040000-ticket-links.sql
 *
 * Shape 1 (direct org_id, RLS auto-discovered by rls-coverage). Everything
 * runs through the real postgres.js driver as `breeze_app`, so the policy is
 * genuinely enforced; each negative case has a same-org positive control so a
 * policy or constraint that rejects everything cannot pass as isolation.
 *
 * Proves:
 *   1. a cross-org INSERT forge raises 42501;
 *   2. a link between a ticket in A and a ticket in B, stamped org A, raises
 *      23503 — the COMPOSITE FKs, not RLS (cross-org links are unrepresentable);
 *   3. self-link and non-canonical `related` raise 23514; a duplicate
 *      (source, target, type) and a second `duplicate_of` for one source 23505;
 *   4. an org-B context selects zero of org A's links;
 *   5. both composite FKs are DEFERRABLE INITIALLY IMMEDIATE (catalog read);
 *   6. hard-deleting either ticket cascades its links away;
 *   7. org erasure (cascadeDeleteOrg) removes an org that has links.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { eq, or, sql } from 'drizzle-orm';
import {
  db,
  withDbAccessContext,
  withSystemDbAccessContext,
  type DbAccessContext,
} from '../../db';
import { organizations, ticketLinks, tickets } from '../../db/schema';
import { createOrganization, createPartner, createUser } from './db-utils';
import { getTestDb } from './setup';
import { cascadeDeleteOrg } from '../../services/tenantCascade';

const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

function orgContext(orgId: string, userId: string | null = null): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId };
}

async function captureCause(fn: () => Promise<unknown>) {
  try {
    await fn();
    return undefined;
  } catch (err) {
    return (err as { cause?: { code?: string; message?: string; constraint_name?: string } } | undefined)?.cause;
  }
}

interface Fixture {
  partnerId: string;
  orgA: string;
  orgB: string;
  userId: string;
  /** Three tickets in A, sorted ascending by id (for `related` canonical order). */
  a: [string, string, string];
  ticketB: string;
}

async function seed(): Promise<Fixture> {
  const adminDb = getTestDb() as never as {
    insert: (t: unknown) => { values: (v: unknown) => { returning: () => Promise<Array<{ id: string }>> } };
  };
  const unique = uid();
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });
  const user = await createUser({ partnerId: partner.id, orgId: null, email: `lnk-${unique}@example.test` });

  const mk = async (orgId: string, n: string) => {
    const [row] = await adminDb.insert(tickets).values({
      orgId, partnerId: partner.id, ticketNumber: `LNK-${n}-${unique}`, subject: `link rls ${n}`, source: 'manual',
    }).returning();
    return row!.id;
  };
  const a = [await mk(orgA.id, 'A1'), await mk(orgA.id, 'A2'), await mk(orgA.id, 'A3')].sort() as [string, string, string];
  const ticketB = await mk(orgB.id, 'B1');
  return { partnerId: partner.id, orgA: orgA.id, orgB: orgB.id, userId: user.id, a, ticketB };
}

const insertLink = (ctx: DbAccessContext, v: typeof ticketLinks.$inferInsert) =>
  withDbAccessContext(ctx, () => db.insert(ticketLinks).values(v).returning({ id: ticketLinks.id }));

describe('ticket_links RLS and constraints (real driver, breeze_app)', () => {
  it('rejects a cross-org forge with 42501 while the same-org control succeeds', async () => {
    const f = await seed();
    const ctxA = orgContext(f.orgA, f.userId);
    const own = await insertLink(ctxA, { orgId: f.orgA, sourceTicketId: f.a[0], targetTicketId: f.a[1], linkType: 'caused_by' });
    expect(own).toHaveLength(1);

    const cause = await captureCause(() =>
      insertLink(ctxA, { orgId: f.orgB, sourceTicketId: f.ticketB, targetTicketId: f.ticketB, linkType: 'caused_by' }),
    );
    expect(cause?.code).toBe('42501');
    expect(cause?.message).toMatch(/new row violates row-level security policy for table "ticket_links"/);
  });

  it('cannot link a ticket of org A to a ticket of org B even under org A’s own org_id (composite FK, 23503)', async () => {
    const f = await seed();
    const cause = await captureCause(() =>
      insertLink(orgContext(f.orgA, f.userId), { orgId: f.orgA, sourceTicketId: f.a[0], targetTicketId: f.ticketB, linkType: 'caused_by' }),
    );
    expect(cause?.code).toBe('23503');
    expect(cause?.constraint_name).toBe('ticket_links_target_org_fk');
    // A partner-wide context that can see BOTH orgs is refused the same way.
    const partnerCtx: DbAccessContext = {
      scope: 'partner', orgId: null, accessibleOrgIds: [f.orgA, f.orgB], accessiblePartnerIds: [f.partnerId], userId: f.userId,
    };
    const cause2 = await captureCause(() =>
      insertLink(partnerCtx, { orgId: f.orgB, sourceTicketId: f.a[0], targetTicketId: f.ticketB, linkType: 'caused_by' }),
    );
    expect(cause2?.code).toBe('23503');
    expect(cause2?.constraint_name).toBe('ticket_links_source_org_fk');
  });

  it('enforces no-self-link, canonical related, pair uniqueness and one canonical duplicate', async () => {
    const f = await seed();
    const ctx = orgContext(f.orgA, f.userId);
    const [lo, mid, hi] = f.a;

    expect((await captureCause(() => insertLink(ctx, { orgId: f.orgA, sourceTicketId: lo, targetTicketId: lo, linkType: 'caused_by' })))?.code).toBe('23514');

    // related: canonical (lo, hi) is accepted, the reversed spelling is not.
    expect(await insertLink(ctx, { orgId: f.orgA, sourceTicketId: lo, targetTicketId: hi, linkType: 'related' })).toHaveLength(1);
    const reversed = await captureCause(() => insertLink(ctx, { orgId: f.orgA, sourceTicketId: hi, targetTicketId: mid, linkType: 'related' }));
    expect(reversed?.code).toBe('23514');
    expect(reversed?.constraint_name).toBe('ticket_links_related_canonical_chk');

    // Same (source, target, type) twice.
    await insertLink(ctx, { orgId: f.orgA, sourceTicketId: lo, targetTicketId: mid, linkType: 'caused_by' });
    const dup = await captureCause(() => insertLink(ctx, { orgId: f.orgA, sourceTicketId: lo, targetTicketId: mid, linkType: 'caused_by' }));
    expect(dup?.code).toBe('23505');
    expect(dup?.constraint_name).toBe('ticket_links_pair_type_uq');

    // A ticket duplicates at most one canonical ticket.
    await insertLink(ctx, { orgId: f.orgA, sourceTicketId: hi, targetTicketId: lo, linkType: 'duplicate_of' });
    const second = await captureCause(() => insertLink(ctx, { orgId: f.orgA, sourceTicketId: hi, targetTicketId: mid, linkType: 'duplicate_of' }));
    expect(second?.code).toBe('23505');
    expect(second?.constraint_name).toBe('ticket_links_one_canonical_uq');
  });

  it('an org-B context cannot SELECT org A’s links', async () => {
    const f = await seed();
    await insertLink(orgContext(f.orgA, f.userId), { orgId: f.orgA, sourceTicketId: f.a[0], targetTicketId: f.a[1], linkType: 'resolves' });
    const mine = await withDbAccessContext(orgContext(f.orgA, f.userId), () =>
      db.select().from(ticketLinks).where(eq(ticketLinks.sourceTicketId, f.a[0])),
    );
    expect(mine).toHaveLength(1);
    const seen = await withDbAccessContext(orgContext(f.orgB, f.userId), () =>
      db.select().from(ticketLinks).where(eq(ticketLinks.sourceTicketId, f.a[0])),
    );
    expect(seen).toEqual([]);
  });

  it('both composite FKs are DEFERRABLE INITIALLY IMMEDIATE', async () => {
    const rows = (await getTestDb().execute(sql`
      SELECT conname, condeferrable, condeferred
        FROM pg_constraint
       WHERE conname IN ('ticket_links_source_org_fk', 'ticket_links_target_org_fk')
       ORDER BY conname
    `)) as unknown as Array<{ conname: string; condeferrable: boolean; condeferred: boolean }>;
    expect(rows.map((r) => [r.conname, r.condeferrable, r.condeferred])).toEqual([
      ['ticket_links_source_org_fk', true, false],
      ['ticket_links_target_org_fk', true, false],
    ]);
  });

  it('hard-deleting either ticket cascades its links away', async () => {
    const f = await seed();
    const ctx = orgContext(f.orgA, f.userId);
    await insertLink(ctx, { orgId: f.orgA, sourceTicketId: f.a[0], targetTicketId: f.a[1], linkType: 'caused_by' });
    await insertLink(ctx, { orgId: f.orgA, sourceTicketId: f.a[2], targetTicketId: f.a[0], linkType: 'resolves' });
    await withSystemDbAccessContext(() => db.delete(tickets).where(eq(tickets.id, f.a[0])));
    const left = await withSystemDbAccessContext(() =>
      db.select().from(ticketLinks).where(or(eq(ticketLinks.sourceTicketId, f.a[0]), eq(ticketLinks.targetTicketId, f.a[0]))),
    );
    expect(left).toEqual([]);
  });

  it('org erasure removes an organization that has links', async () => {
    const f = await seed();
    await insertLink(orgContext(f.orgA, f.userId), { orgId: f.orgA, sourceTicketId: f.a[0], targetTicketId: f.a[1], linkType: 'duplicate_of' });
    const stats = await cascadeDeleteOrg(f.orgA, f.userId);
    expect(stats.tablesDeleted.organizations).toBe(1);
    // Deleted at its own registered position, before `tickets` — not swept
    // up by the FK cascade, which would report 0 here.
    expect(stats.tablesDeleted.ticket_links).toBe(1);
    const links = (await getTestDb().execute(sql`SELECT count(*)::int AS n FROM ticket_links WHERE org_id = ${f.orgA}`)) as unknown as Array<{ n: number }>;
    expect(links[0]!.n).toBe(0);
    const org = await withSystemDbAccessContext(() => db.select({ id: organizations.id }).from(organizations).where(eq(organizations.id, f.orgA)));
    expect(org).toEqual([]);
  });
});
