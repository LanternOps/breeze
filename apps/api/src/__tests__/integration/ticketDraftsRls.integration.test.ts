/**
 * ticket_drafts — RLS forge proof + registry contracts (P2-4, #4191, Task A10).
 *
 * Migration under test: 2026-09-25-ai-agents-ticket-triage.sql (table +
 * Shape-1 RLS), fixed up by 2026-09-25-ai-agents-ticket-triage's Finding 1/2
 * (deferrable composite FKs, `ticket_drafts` reclassified `custom` in
 * `orgMergeRegistry.ts`) — see Task 2's report.
 *
 * Runs through the REAL postgres.js driver (breeze_app role, rolbypassrls =
 * false), so RLS/FK are genuinely enforced — mirrors
 * ticketEmailLinksRls.integration.test.ts's structure for the first two
 * cases, and aiAgentNarrativeReport.integration.test.ts's cascade-erasure
 * case for the third. Proves:
 *
 *  1. Cross-org SELECT/INSERT is denied (42501) — the plain Shape-1
 *     `breeze_has_org_access(org_id)` policy.
 *  2. A composite-FK forge — same-org `org_id` (passes RLS) but a `ticket_id`
 *     that belongs to a DIFFERENT org — is rejected (23503) by
 *     `ticket_drafts_ticket_org_fk (ticket_id, org_id) -> tickets(id,
 *     org_id)`, not silently linked to a victim's ticket.
 *  3. `cascadeDeleteOrg` erases an org holding an active draft without an FK
 *     violation (children-before-parents ordering) — CORE_ORG_CASCADE_DELETE_ORDER
 *     membership (tenantCascade.ts) is a SEPARATE contract from RLS coverage;
 *     this is the "does it actually run clean against a real row" proof
 *     CLAUDE.md's cascade section calls out as the thing code review misses.
 *  4. `executeOrgMerge` succeeds for a loser org holding a draft — proving
 *     Task 2's Finding 2 fix (a plain `leave-for-erasure` classification
 *     aborted every merge whose loser held a single ticket with a draft;
 *     `ticket_drafts` is `custom`, unconditionally dropping the loser's
 *     drafts in the merge's `resolve` phase, BEFORE `tickets`' own repoint
 *     in the `move` phase races the composite FK).
 */
import './setup';
import { getTestDb } from './setup';

import { afterAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { organizations, partners, ticketDrafts, tickets, users } from '../../db/schema';
import { createOrganization, createPartner, createUser } from './db-utils';
import { cascadeDeleteOrg } from '../../services/tenantCascade';
import { executeOrgMerge } from '../../services/orgMerge';

const uniqueSuffix = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const seededPartnerIds: string[] = [];
const seededOrgIds: string[] = [];

/** Seeds two unrelated partner/org/ticket triples (privileged test role,
 *  bypassing RLS). Org A is the "attacker" context; org B is the victim. */
async function seedTwoOrgsWithTickets() {
  const adminDb = getTestDb() as any;
  const unique = uniqueSuffix();

  const partnerA = await createPartner();
  const orgA = await createOrganization({ partnerId: partnerA.id });
  const partnerB = await createPartner();
  const orgB = await createOrganization({ partnerId: partnerB.id });

  seededPartnerIds.push(partnerA.id, partnerB.id);
  seededOrgIds.push(orgA.id, orgB.id);

  const [ticketA] = await adminDb.insert(tickets).values({
    orgId: orgA.id, partnerId: partnerA.id, ticketNumber: `TD-RLS-A-${unique}`,
    subject: 'ticket_drafts RLS test — org A', source: 'manual',
  }).returning();
  const [ticketB] = await adminDb.insert(tickets).values({
    orgId: orgB.id, partnerId: partnerB.id, ticketNumber: `TD-RLS-B-${unique}`,
    subject: 'ticket_drafts RLS test — org B', source: 'manual',
  }).returning();

  const orgAContext: DbAccessContext = {
    scope: 'organization', orgId: orgA.id, accessibleOrgIds: [orgA.id], accessiblePartnerIds: [], userId: null,
  };
  const orgBContext: DbAccessContext = {
    scope: 'organization', orgId: orgB.id, accessibleOrgIds: [orgB.id], accessiblePartnerIds: [], userId: null,
  };

  return { partnerA, orgA, ticketA, orgAContext, partnerB, orgB, ticketB, orgBContext };
}

/** postgres.js surfaces the real policy/constraint error on `.cause`; drizzle
 *  wraps the top-level message as "Failed query: ...". Returns undefined
 *  (isolation hole) if the call unexpectedly succeeded. */
async function captureDbErrorCause(
  fn: () => Promise<unknown>,
): Promise<{ code?: string; message?: string } | undefined> {
  try {
    await fn();
    return undefined;
  } catch (err) {
    return (err as { cause?: { code?: string; message?: string } } | undefined)?.cause;
  }
}

afterAll(async () => {
  if (seededPartnerIds.length === 0) return;
  const adminDb = getTestDb() as any;
  const orgList = sql.join(seededOrgIds.map((id) => sql`${id}`), sql`, `);
  const partnerList = sql.join(seededPartnerIds.map((id) => sql`${id}`), sql`, `);
  // FK order: ticket_drafts (FK ticket_id) -> tickets -> orgs -> partners.
  // users (the cascade/merge tests' `actor` fixtures, partner-level staff
  // with orgId null) must go before partners too.
  await adminDb.delete(ticketDrafts).where(sql`${ticketDrafts.orgId} IN (${orgList})`);
  await adminDb.delete(tickets).where(sql`${tickets.orgId} IN (${orgList})`);
  await adminDb.delete(organizations).where(sql`${organizations.id} IN (${orgList})`);
  await adminDb.delete(users).where(sql`${users.partnerId} IN (${partnerList})`);
  await adminDb.delete(partners).where(sql`${partners.id} IN (${partnerList})`);
});

describe('ticket_drafts RLS — cross-org forge (breeze_app role)', () => {
  it('rejects a cross-org INSERT with 42501', async () => {
    const { orgAContext, orgB, ticketB } = await seedTwoOrgsWithTickets();

    const cause = await captureDbErrorCause(() =>
      withDbAccessContext(orgAContext, () =>
        db.insert(ticketDrafts).values({
          ticketId: ticketB.id, // forged: belongs to org B
          orgId: orgB.id, // forged: belongs to org B, not the caller's own org
          kind: 'reply',
          content: 'Forged draft content',
        })),
    );

    expect(cause).toBeDefined();
    expect(cause?.code).toBe('42501');
    expect(cause?.message).toMatch(/new row violates row-level security policy for table "ticket_drafts"/);
  });

  it('allows a same-org INSERT/SELECT and blocks cross-org SELECT', async () => {
    const { orgAContext, orgBContext, orgA, ticketA } = await seedTwoOrgsWithTickets();

    const inserted = await withDbAccessContext(orgAContext, () =>
      db.insert(ticketDrafts).values({
        ticketId: ticketA.id,
        orgId: orgA.id,
        kind: 'reply',
        content: 'A genuine draft for org A\'s own ticket',
      }).returning({ id: ticketDrafts.id }));
    expect(inserted).toHaveLength(1);

    const ownRows = await withDbAccessContext(orgAContext, () =>
      db.select({ id: ticketDrafts.id }).from(ticketDrafts).where(eq(ticketDrafts.id, inserted[0]!.id)));
    expect(ownRows).toHaveLength(1);

    const crossOrgRows = await withDbAccessContext(orgBContext, () =>
      db.select({ id: ticketDrafts.id }).from(ticketDrafts).where(eq(ticketDrafts.id, inserted[0]!.id)));
    expect(crossOrgRows).toEqual([]);
  });

  it('rejects a composite-FK forge — own org_id, a victim org\'s ticket_id — with 23503, not a silent cross-tenant link', async () => {
    const { orgAContext, orgA, ticketB } = await seedTwoOrgsWithTickets();

    const cause = await captureDbErrorCause(() =>
      withDbAccessContext(orgAContext, () =>
        db.insert(ticketDrafts).values({
          ticketId: ticketB.id, // belongs to org B
          orgId: orgA.id, // the caller's OWN org — passes RLS's WITH CHECK
          kind: 'reply',
          content: 'Composite-FK forge attempt',
        })),
    );

    // The (ticket_id, org_id) pair (ticketB.id, orgA.id) does not exist in
    // tickets(id, org_id) — ticket_drafts_ticket_org_fk rejects it. This is a
    // DIFFERENT failure mode than the RLS test above: RLS never even
    // considers ticket_id, only org_id, so a bare org-scoping test alone
    // would miss this class of forge entirely.
    expect(cause).toBeDefined();
    expect(cause?.code).toBe('23503');
    expect(cause?.message ?? '').toMatch(/ticket_drafts_ticket_org_fk/);
  });
});

describe('ticket_drafts — cascade erasure (registry contract)', () => {
  it('cascadeDeleteOrg erases an org holding an active draft with no FK violation', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const sibling = await createOrganization({ partnerId: partner.id });
    const actor = await createUser({ partnerId: partner.id, orgId: null, email: `td-cascade-${uniqueSuffix()}@example.test` });

    const adminDb = getTestDb() as any;
    const [ticket] = await adminDb.insert(tickets).values({
      orgId: org.id, partnerId: partner.id, ticketNumber: `TD-CASCADE-${uniqueSuffix()}`,
      subject: 'ticket_drafts cascade erasure test', source: 'manual',
    }).returning();
    const [draft] = await adminDb.insert(ticketDrafts).values({
      ticketId: ticket.id, orgId: org.id, kind: 'reply', content: 'A draft the erasure must remove',
    }).returning();

    const stats = await cascadeDeleteOrg(org.id, actor.id);

    expect(stats.tablesDeleted.organizations).toBe(1);
    const remainingDrafts = await adminDb
      .select({ id: ticketDrafts.id })
      .from(ticketDrafts)
      .where(eq(ticketDrafts.id, draft.id));
    expect(remainingDrafts).toHaveLength(0);
    const remainingTickets = await adminDb
      .select({ id: tickets.id })
      .from(tickets)
      .where(eq(tickets.id, ticket.id));
    expect(remainingTickets).toHaveLength(0);

    // The sibling org under the same partner is untouched.
    const siblingRow = await adminDb
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, sibling.id));
    expect(siblingRow).toHaveLength(1);

    seededPartnerIds.push(partner.id);
    seededOrgIds.push(sibling.id); // org itself is gone; sibling needs afterAll cleanup
  });
});

describe('ticket_drafts — org-merge (registry contract, Task 2 Finding 2 fix)', () => {
  it('executeOrgMerge succeeds for a loser org holding a draft, repoints the ticket, and drops the draft', async () => {
    const priorDrain = process.env.ORG_MERGE_FENCE_DRAIN_MS;
    process.env.ORG_MERGE_FENCE_DRAIN_MS = '0';

    try {
      const partner = await createPartner();
      const loser = await createOrganization({ partnerId: partner.id });
      const survivor = await createOrganization({ partnerId: partner.id });
      const actor = await createUser({ partnerId: partner.id, orgId: null, email: `td-merge-${uniqueSuffix()}@example.test` });

      const adminDb = getTestDb() as any;
      const [ticket] = await adminDb.insert(tickets).values({
        orgId: loser.id, partnerId: partner.id, ticketNumber: `TD-MERGE-${uniqueSuffix()}`,
        subject: 'ticket_drafts org-merge test', source: 'manual',
      }).returning();
      const [draft] = await adminDb.insert(ticketDrafts).values({
        ticketId: ticket.id, orgId: loser.id, kind: 'reply', content: 'A loser-org draft the merge must drop',
      }).returning();

      const result = await executeOrgMerge({
        loserOrgId: loser.id,
        survivorOrgId: survivor.id,
        partnerId: partner.id,
        performedBy: actor.id,
        performedByEmail: actor.email,
      });

      expect(result).toBeDefined();

      const movedTicket = await adminDb
        .select({ orgId: tickets.orgId })
        .from(tickets)
        .where(eq(tickets.id, ticket.id));
      expect(movedTicket).toHaveLength(1);
      expect(movedTicket[0]!.orgId).toBe(survivor.id);

      // ticket_drafts is registered `custom` in orgMergeRegistry.ts
      // (resolveTicketDrafts: unconditional DELETE FROM ticket_drafts WHERE
      // org_id = loser, in the resolve phase) — the row must be GONE, not
      // repointed onto the survivor.
      const draftAfterMerge = await adminDb
        .select({ id: ticketDrafts.id })
        .from(ticketDrafts)
        .where(eq(ticketDrafts.id, draft.id));
      expect(draftAfterMerge).toHaveLength(0);

      // The loser org becomes a terminal shell (stampTerminalShell) rather
      // than being physically removed — both rows still need cleanup.
      seededPartnerIds.push(partner.id);
      seededOrgIds.push(loser.id, survivor.id);
    } finally {
      if (priorDrain === undefined) delete process.env.ORG_MERGE_FENCE_DRAIN_MS;
      else process.env.ORG_MERGE_FENCE_DRAIN_MS = priorDrain;
    }
  });
});
