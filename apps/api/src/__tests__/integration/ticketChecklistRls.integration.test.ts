/**
 * ticket_checklist_items — RLS and FK isolation against real Postgres (#5783 W01).
 *
 * Migration under test: 2026-10-16-190000-ticket-checklist-items.sql
 *
 * Shape 1 (direct org_id, RLS auto-discovered by rls-coverage). Everything here
 * runs through the REAL postgres.js driver as `breeze_app` (rolbypassrls =
 * false), so the policy is genuinely enforced; the mocked unit suites prove
 * statement SHAPE, this one proves Postgres agrees.
 *
 * Proves:
 *   1. a cross-org INSERT forge raises 42501 — WITH the same-org positive
 *      control succeeding in the same test, so a policy that denies everything
 *      cannot masquerade as a passing isolation check.
 *   2. attaching a checklist item to ANOTHER org's ticket, even under the
 *      caller's own org_id, raises 23503 — that is the COMPOSITE FK, not RLS,
 *      and it is proved separately because a future "simplification" to a
 *      single-column ticket_id FK would silently reopen it.
 *   3. an org-B context cannot SELECT org A's rows (zero rows, not an error).
 *   4. deleting the ticket cascades its checklist items away.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  db,
  withDbAccessContext,
  withSystemDbAccessContext,
  type DbAccessContext,
} from '../../db';
import { devices, tickets, ticketChecklistItems } from '../../db/schema';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';
import { getTestDb } from './setup';

const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

function orgContext(orgId: string, userId: string | null = null): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId };
}

/**
 * Returns the postgres.js cause on a rejection, or undefined when the call
 * unexpectedly succeeded (which is an isolation hole, not a pass).
 */
async function captureRlsCause(fn: () => Promise<unknown>) {
  try {
    await fn();
    return undefined;
  } catch (err) {
    return (err as { cause?: { code?: string; message?: string } } | undefined)?.cause;
  }
}

interface Fixture {
  partnerId: string;
  orgA: string;
  orgB: string;
  userId: string;
  deviceId: string;
  ticketA: string;
  ticketB: string;
}

/** partner P -> orgA + orgB, one device in A, one ticket in each org. */
async function seed(): Promise<Fixture> {
  const adminDb = getTestDb() as never as {
    insert: (t: unknown) => { values: (v: unknown) => { returning: () => Promise<Array<{ id: string }>> } };
  };
  const unique = uid();
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });
  const user = await createUser({ partnerId: partner.id, orgId: null, email: `chk-${unique}@example.test` });
  const siteA = await createSite({ orgId: orgA.id });

  const [device] = await adminDb.insert(devices).values({
    orgId: orgA.id,
    siteId: siteA.id,
    agentId: `chk-device-${unique}`,
    hostname: `chk-host-${unique}`,
    osType: 'windows',
    osVersion: '10.0.19041',
    architecture: 'x64',
    agentVersion: '0.1.0',
  }).returning();

  const [ticketA] = await adminDb.insert(tickets).values({
    orgId: orgA.id,
    partnerId: partner.id,
    ticketNumber: `CHK-A-${unique}`,
    subject: 'checklist rls A',
    deviceId: device!.id,
    source: 'manual',
  }).returning();

  const [ticketB] = await adminDb.insert(tickets).values({
    orgId: orgB.id,
    partnerId: partner.id,
    ticketNumber: `CHK-B-${unique}`,
    subject: 'checklist rls B',
    source: 'manual',
  }).returning();

  return {
    partnerId: partner.id,
    orgA: orgA.id,
    orgB: orgB.id,
    userId: user.id,
    deviceId: device!.id,
    ticketA: ticketA!.id,
    ticketB: ticketB!.id,
  };
}

describe('ticket_checklist_items RLS (real driver, breeze_app)', () => {
  it('rejects a cross-org forge with 42501 while the same-org control succeeds', async () => {
    const f = await seed();
    const ctxA = orgContext(f.orgA, f.userId);

    // POSITIVE CONTROL FIRST. If this insert fails, the forge below proves
    // nothing — a policy that denies everything would "pass" the forge case.
    const own = await withDbAccessContext(ctxA, () =>
      db.insert(ticketChecklistItems).values({
        orgId: f.orgA, ticketId: f.ticketA, label: 'Same-org control', position: 0,
      }).returning({ id: ticketChecklistItems.id }),
    );
    expect(own).toHaveLength(1);

    const cause = await captureRlsCause(() =>
      withDbAccessContext(ctxA, () =>
        db.insert(ticketChecklistItems).values({
          orgId: f.orgB,          // forged
          ticketId: f.ticketB,
          label: 'Forged', position: 0,
        }),
      ),
    );
    expect(cause).toBeDefined();
    expect(cause?.code).toBe('42501');
    expect(cause?.message).toMatch(
      /new row violates row-level security policy for table "ticket_checklist_items"/,
    );
  });

  it('cannot attach a checklist item to ANOTHER org’s ticket even with its own org_id', async () => {
    // The composite FK, not RLS, is what stops this one: (ticket_id, org_id)
    // must resolve against tickets(id, org_id), and org B's ticket does not
    // carry org A's id.
    const f = await seed();
    const cause = await captureRlsCause(() =>
      withDbAccessContext(orgContext(f.orgA, f.userId), () =>
        db.insert(ticketChecklistItems).values({
          orgId: f.orgA, ticketId: f.ticketB, label: 'Wrong ticket', position: 0,
        }),
      ),
    );
    expect(cause).toBeDefined();
    expect(cause?.code).toBe('23503');
  });

  it('an org-B context cannot SELECT org A’s checklist items', async () => {
    const f = await seed();
    await withDbAccessContext(orgContext(f.orgA, f.userId), () =>
      db.insert(ticketChecklistItems).values({
        orgId: f.orgA, ticketId: f.ticketA, label: 'Private', position: 0,
      }),
    );
    // Control: org A sees its own row, so the empty result below is isolation
    // and not a broken fixture.
    const mine = await withDbAccessContext(orgContext(f.orgA, f.userId), () =>
      db.select().from(ticketChecklistItems).where(eq(ticketChecklistItems.ticketId, f.ticketA)),
    );
    expect(mine).toHaveLength(1);

    const seen = await withDbAccessContext(orgContext(f.orgB, f.userId), () =>
      db.select().from(ticketChecklistItems).where(eq(ticketChecklistItems.ticketId, f.ticketA)),
    );
    expect(seen).toEqual([]);
  });

  it('the composite FK is DEFERRABLE INITIALLY IMMEDIATE', async () => {
    // Load-bearing for org merge and both org movers: a non-deferrable version
    // aborts a merge with 23503. Read it from the catalog rather than trusting
    // the migration text.
    const rows = (await getTestDb().execute(sql`
      SELECT condeferrable, condeferred
        FROM pg_constraint
       WHERE conname = 'ticket_checklist_items_ticket_org_fk'
    `)) as unknown as Array<{ condeferrable: boolean; condeferred: boolean }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.condeferrable).toBe(true);
    expect(rows[0]!.condeferred).toBe(false);
  });

  it('deleting the ticket cascades its checklist items away', async () => {
    // ON DELETE CASCADE on the composite FK. If this ever stops holding, org
    // erasure strands rows under a dead ticket.
    const f = await seed();
    await withDbAccessContext(orgContext(f.orgA, f.userId), () =>
      db.insert(ticketChecklistItems).values({
        orgId: f.orgA, ticketId: f.ticketA, label: 'Doomed', position: 0,
      }),
    );
    await withSystemDbAccessContext(() => db.delete(tickets).where(eq(tickets.id, f.ticketA)));
    const left = await withSystemDbAccessContext(() =>
      db.select().from(ticketChecklistItems).where(eq(ticketChecklistItems.ticketId, f.ticketA)),
    );
    expect(left).toEqual([]);
  });
});
