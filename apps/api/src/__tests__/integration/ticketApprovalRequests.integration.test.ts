/**
 * ticket_approval_requests + the customer-work-approval columns (#4617 W01,
 * spec §4.2–§4.5), against real Postgres.
 *
 * Proves what only the database can: the pending partial UNIQUE, the decision
 * shape CHECK, the decided-row immutability trigger, the time_entries link's
 * ON DELETE SET NULL (approval_request_id), the ticket_parts hold guard, the
 * ticket budget CHECK, Shape 1 RLS, and that both org movers carry a ticket's
 * request (and its held entry) to the new org without a deferred-FK abort.
 */
import './setup';
import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import {
  devices, organizations, partners, sites, ticketApprovalRequests, ticketParts, tickets, timeEntries, users,
} from '../../db/schema';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';
import { getTestDb } from './setup';
import { moveTicketOrg } from '../../services/ticketService';
import { moveDeviceOrgInTransaction } from '../../services/deviceOrgMove/moveDeviceOrgInTransaction';
import { runPolicy } from '../../services/orgMerge';
import { getOrgMergePolicies } from '../../services/orgMergeRegistry';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pgErrorCode } from '../../utils/pgErrors';

const seededPartnerIds: string[] = [];
const seededOrgIds: string[] = [];
const uniqueSuffix = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const runDb = it.runIf(!!process.env.DATABASE_URL);

async function seed() {
  const adminDb = getTestDb() as any;
  const unique = uniqueSuffix();
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });
  const siteA = await createSite({ orgId: orgA.id });
  const actor = await createUser({ partnerId: partner.id, orgId: null, email: `approval-${unique}@example.test` });
  seededPartnerIds.push(partner.id);
  seededOrgIds.push(orgA.id, orgB.id);

  const [device] = await adminDb.insert(devices).values({
    orgId: orgA.id, siteId: siteA.id, agentId: `approval-device-${unique}`, hostname: `approval-host-${unique}`,
    osType: 'windows', osVersion: '10.0.19041', architecture: 'x64', agentVersion: '0.1.0',
  }).returning();
  const [ticket] = await adminDb.insert(tickets).values({
    orgId: orgA.id, partnerId: partner.id, ticketNumber: `APR-${unique}`,
    subject: 'customer work approval', deviceId: device!.id, source: 'manual',
  }).returning();
  return { partner, orgA, orgB, actor, device: device!, ticket: ticket!, unique };
}

type Fixture = Awaited<ReturnType<typeof seed>>;

function requestValues(f: Fixture, overrides: Record<string, unknown> = {}) {
  return {
    orgId: f.orgA.id,
    ticketId: f.ticket.id,
    trigger: 'budget' as const,
    origin: 'auto' as const,
    status: 'pending' as const,
    enforcement: 'soft' as const,
    expiresAt: new Date(Date.now() + 72 * 3600_000),
    ...overrides,
  };
}

async function insertRequest(f: Fixture, overrides: Record<string, unknown> = {}): Promise<string> {
  const [row] = await (getTestDb() as any).insert(ticketApprovalRequests)
    .values(requestValues(f, overrides)).returning({ id: ticketApprovalRequests.id });
  return row!.id;
}

const DECIDED = {
  status: 'approved' as const,
  decidedAt: new Date(),
  decisionOrigin: 'on_behalf' as const,
  decisionMethod: 'verbal' as const,
  decisionReference: 'Phone call with J. Smith',
  decidedRevision: 1,
  approvedExtensionMinutes: 60,
};

async function insertHeldEntry(f: Fixture, approvalRequestId: string): Promise<string> {
  const [row] = await (getTestDb() as any).insert(timeEntries).values({
    partnerId: f.partner.id, orgId: f.orgA.id, ticketId: f.ticket.id, userId: f.actor.id,
    startedAt: new Date(Date.now() - 3600_000), endedAt: new Date(), durationMinutes: 60,
    currencyCode: 'USD', isBillable: true, billingStatus: 'awaiting_approval', approvalRequestId,
  }).returning({ id: timeEntries.id });
  return row!.id;
}

async function rejection(fn: () => Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await fn();
  } catch (err) {
    const cause = (err as { cause?: { message?: string } }).cause;
    return { code: pgErrorCode(err), message: `${(err as Error).message} ${cause?.message ?? ''}` };
  }
  throw new Error('expected the statement to be rejected, but it succeeded');
}

async function row(table: string, id: string): Promise<Record<string, unknown> | undefined> {
  const rows = (await getTestDb().execute(
    sql`SELECT * FROM ${sql.identifier(table)} WHERE id = ${id}::uuid`,
  )) as unknown as Array<Record<string, unknown>>;
  return rows[0];
}

afterAll(async () => {
  if (seededPartnerIds.length === 0) return;
  const adminDb = getTestDb() as any;
  const orgList = sql.join(seededOrgIds.map((id) => sql`${id}`), sql`, `);
  const partnerList = sql.join(seededPartnerIds.map((id) => sql`${id}`), sql`, `);
  await adminDb.delete(timeEntries).where(sql`${timeEntries.partnerId} IN (${partnerList})`);
  await adminDb.delete(ticketParts).where(sql`${ticketParts.orgId} IN (${orgList})`);
  await adminDb.delete(ticketApprovalRequests).where(sql`${ticketApprovalRequests.orgId} IN (${orgList})`);
  await adminDb.delete(tickets).where(sql`${tickets.orgId} IN (${orgList})`);
  await adminDb.delete(devices).where(sql`${devices.orgId} IN (${orgList})`);
  await adminDb.delete(sites).where(sql`${sites.orgId} IN (${orgList})`);
  await adminDb.delete(organizations).where(sql`${organizations.id} IN (${orgList})`);
  await adminDb.delete(users).where(sql`${users.partnerId} IN (${partnerList})`);
  await adminDb.delete(partners).where(sql`${partners.id} IN (${partnerList})`);
});

describe('ticket_approval_requests constraints (#4617 §4.3)', () => {
  runDb('allows only one pending request per ticket + trigger', async () => {
    const f = await seed();
    await insertRequest(f);
    expect((await rejection(() => insertRequest(f))).code).toBe('23505');
    // A different trigger on the same ticket is a separate request.
    await expect(insertRequest(f, { trigger: 'after_hours' })).resolves.toBeDefined();
    // A decided request frees the slot for a new pending one.
    const g = await seed();
    await insertRequest(g, DECIDED);
    await expect(insertRequest(g)).resolves.toBeDefined();
  });

  runDb('rejects an approved row with no decision evidence', async () => {
    const f = await seed();
    expect((await rejection(() => insertRequest(f, { status: 'approved' }))).code).toBe('23514');
  });

  runDb('rejects an on-behalf decision with a blank reference', async () => {
    const f = await seed();
    expect((await rejection(() => insertRequest(f, { ...DECIDED, decisionReference: '   ' }))).code).toBe('23514');
  });

  runDb('rejects a customer decision with no signer email', async () => {
    const f = await seed();
    const customer = { ...DECIDED, decisionOrigin: 'customer', decisionMethod: null, decisionReference: null };
    expect((await rejection(() => insertRequest(f, customer))).code).toBe('23514');
    await expect(insertRequest(f, { ...customer, signerEmail: 'approver@customer.example' })).resolves.toBeDefined();
  });

  runDb('rejects a coverage window over 14 days or with one end missing', async () => {
    const f = await seed();
    const start = new Date();
    const long = new Date(start.getTime() + 15 * 86400_000);
    expect((await rejection(() => insertRequest(f, { coverageStartsAt: start, coverageEndsAt: long }))).code).toBe('23514');
    expect((await rejection(() => insertRequest(f, { coverageStartsAt: start }))).code).toBe('23514');
  });

  runDb('freezes a decided row except org_id and user-id nulling', async () => {
    const f = await seed();
    const id = await insertRequest(f, { ...DECIDED, decidedByUserId: f.actor.id });
    const frozen = await rejection(() => getTestDb().execute(
      sql`UPDATE ticket_approval_requests SET approved_extension_minutes = 999 WHERE id = ${id}::uuid`,
    ));
    expect(frozen.code).toBe('55000');
    expect(frozen.message).toMatch(/decided approval request is immutable/);
    // Re-pointing a user id to someone else is also frozen …
    const other = await createUser({ partnerId: f.partner.id, orgId: null, email: `other-${f.unique}@example.test` });
    expect((await rejection(() => getTestDb().execute(
      sql`UPDATE ticket_approval_requests SET decided_by_user_id = ${other.id}::uuid WHERE id = ${id}::uuid`,
    ))).code).toBe('55000');
    // … but nulling one (FK SET NULL) and re-stamping org_id are allowed.
    await getTestDb().execute(sql`UPDATE ticket_approval_requests SET decided_by_user_id = NULL WHERE id = ${id}::uuid`);
    expect((await row('ticket_approval_requests', id))!.decided_by_user_id).toBeNull();
    // A pending row stays fully mutable.
    const pending = await insertRequest(f);
    await getTestDb().execute(sql`UPDATE ticket_approval_requests SET revision = 2 WHERE id = ${pending}::uuid`);
    expect((await row('ticket_approval_requests', pending))!.revision).toBe(2);
  });

  // Every terminal status is frozen, including against re-opening it (a late
  // approval of an expired request is the main business invariant).
  const TERMINAL: Array<[string, Record<string, unknown>]> = [
    ['approved', DECIDED],
    ['denied', { ...DECIDED, status: 'denied' }],
    ['expired', { status: 'expired' }],
    ['cancelled', { status: 'cancelled' }],
  ];
  for (const [status, values] of TERMINAL) {
    runDb(`a ${status} request cannot be re-opened or re-decided`, async () => {
      const f = await seed();
      const id = await insertRequest(f, values);
      for (const change of [
        sql`status = 'pending'`,
        sql`status = 'approved', decided_at = now(), decision_origin = 'on_behalf', decision_method = 'verbal', decision_reference = 'late', decided_revision = 1`,
        sql`expires_at = now() + interval '30 days'`,
        sql`revision = revision + 1`,
      ]) {
        const r = await rejection(() => getTestDb().execute(
          sql`UPDATE ticket_approval_requests SET ${change} WHERE id = ${id}::uuid`));
        expect(r.code, `${status}: ${r.message}`).toBe('55000');
      }
      expect((await row('ticket_approval_requests', id))!.status).toBe(status);
    });
  }

  runDb('requested_by_user_id on a decided row can be nulled but not re-pointed', async () => {
    const f = await seed();
    const id = await insertRequest(f, { ...DECIDED, requestedByUserId: f.actor.id, origin: 'staff' });
    const other = await createUser({ partnerId: f.partner.id, orgId: null, email: `req-other-${f.unique}@example.test` });
    expect((await rejection(() => getTestDb().execute(
      sql`UPDATE ticket_approval_requests SET requested_by_user_id = ${other.id}::uuid WHERE id = ${id}::uuid`))).code).toBe('55000');
    await getTestDb().execute(sql`UPDATE ticket_approval_requests SET requested_by_user_id = NULL WHERE id = ${id}::uuid`);
    expect((await row('ticket_approval_requests', id))!.requested_by_user_id).toBeNull();
  });

  runDb('a decided row stays deletable (tenant erasure)', async () => {
    const f = await seed();
    const id = await insertRequest(f, DECIDED);
    await getTestDb().execute(sql`DELETE FROM ticket_approval_requests WHERE id = ${id}::uuid`);
    expect(await row('ticket_approval_requests', id)).toBeUndefined();
  });
});

describe('hold-state columns (#4617 §4.2, §4.4)', () => {
  runDb('nulls time_entries.approval_request_id when the request is deleted', async () => {
    const f = await seed();
    const id = await insertRequest(f);
    const entryId = await insertHeldEntry(f, id);
    await getTestDb().execute(sql`DELETE FROM ticket_approval_requests WHERE id = ${id}::uuid`);
    const entry = await row('time_entries', entryId);
    expect(entry!.approval_request_id).toBeNull();
    // Only the link is nulled — the entry keeps its ticket.
    expect(entry!.ticket_id).toBe(f.ticket.id);
  });

  runDb("refuses an entry linked to another ticket's request", async () => {
    const f = await seed();
    const g = await seed();
    const otherTicketsRequest = await insertRequest(g);
    expect((await rejection(() => insertHeldEntry(f, otherTicketsRequest))).code).toBe('23503');
  });

  runDb('a hard ticket delete removes its requests and leaves no dangling link', async () => {
    const f = await seed();
    const id = await insertRequest(f);
    await insertHeldEntry(f, id);
    await getTestDb().execute(sql`DELETE FROM tickets WHERE id = ${f.ticket.id}::uuid`);
    expect(await row('ticket_approval_requests', id)).toBeUndefined();
  });

  runDb('forbids awaiting_approval on ticket_parts', async () => {
    const f = await seed();
    const insertPart = () => (getTestDb() as any).insert(ticketParts).values({
      ticketId: f.ticket.id, orgId: f.orgA.id, description: 'SSD', quantity: '1.00', unitPrice: '80.00',
      currencyCode: 'USD', isBillable: true, billingStatus: 'awaiting_approval', addedBy: f.actor.id,
    });
    expect((await rejection(insertPart)).code).toBe('23514');
  });

  runDb('enforces the ticket budget CHECK', async () => {
    const f = await seed();
    const set = (fragment: ReturnType<typeof sql>) =>
      getTestDb().execute(sql`UPDATE tickets SET ${fragment} WHERE id = ${f.ticket.id}::uuid`);
    expect((await rejection(() => set(sql`budget_minutes = 0`))).code).toBe('23514');
    expect((await rejection(() => set(sql`budget_amount = 100`))).code).toBe('23514'); // no currency
    expect((await rejection(() => set(sql`budget_amount = 100, budget_currency_code = 'usd'`))).code).toBe('23514');
    await set(sql`budget_minutes = 120, budget_amount = 250.00, budget_currency_code = 'USD'`);
    const t = await row('tickets', f.ticket.id);
    expect(t!.budget_minutes).toBe(120);
    expect(t!.budget_currency_code).toBe('USD');
  });

  runDb('work_types.is_after_hours defaults to false', async () => {
    const [col] = (await getTestDb().execute(sql`
      SELECT column_default, is_nullable FROM information_schema.columns
       WHERE table_name = 'work_types' AND column_name = 'is_after_hours'
    `)) as unknown as Array<{ column_default: string; is_nullable: string }>;
    expect(col).toEqual({ column_default: 'false', is_nullable: 'NO' });
  });
});

describe('ticket_approval_requests RLS (Shape 1)', () => {
  function orgCtx(orgId: string, partnerId: string): DbAccessContext {
    return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null, currentPartnerId: partnerId };
  }

  runDb('rejects a cross-org request insert from an org context', async () => {
    const f = await seed();
    const forged = await rejection(() => withDbAccessContext(orgCtx(f.orgB.id, f.partner.id), () =>
      db.insert(ticketApprovalRequests).values(requestValues(f)).returning()));
    expect(forged.code).toBe('42501');
  });

  runDb("an org context cannot read another org's requests", async () => {
    const f = await seed();
    const id = await insertRequest(f);
    const seenByOwner = await withDbAccessContext(orgCtx(f.orgA.id, f.partner.id), () =>
      db.select().from(ticketApprovalRequests).where(sql`${ticketApprovalRequests.id} = ${id}`));
    const seenByOther = await withDbAccessContext(orgCtx(f.orgB.id, f.partner.id), () =>
      db.select().from(ticketApprovalRequests).where(sql`${ticketApprovalRequests.id} = ${id}`));
    expect(seenByOwner).toHaveLength(1);
    expect(seenByOther).toHaveLength(0);
  });

  runDb("an org context cannot UPDATE or DELETE another org's request", async () => {
    const f = await seed();
    const id = await insertRequest(f);
    const updated = await withDbAccessContext(orgCtx(f.orgB.id, f.partner.id), () =>
      db.update(ticketApprovalRequests).set({ revision: 9 }).where(sql`${ticketApprovalRequests.id} = ${id}`).returning());
    const deleted = await withDbAccessContext(orgCtx(f.orgB.id, f.partner.id), () =>
      db.delete(ticketApprovalRequests).where(sql`${ticketApprovalRequests.id} = ${id}`).returning());
    expect(updated).toHaveLength(0);
    expect(deleted).toHaveLength(0);
    expect((await row('ticket_approval_requests', id))!.revision).toBe(1);
  });

  runDb('an org context cannot hop its own request into another org (WITH CHECK)', async () => {
    const f = await seed();
    const id = await insertRequest(f);
    const hop = await rejection(() => withDbAccessContext(orgCtx(f.orgA.id, f.partner.id), () =>
      db.update(ticketApprovalRequests).set({ orgId: f.orgB.id }).where(sql`${ticketApprovalRequests.id} = ${id}`).returning()));
    expect(hop.code).toBe('42501');
  });
});

describe('org moves carry the request and its held entry (#4617 §4.6)', () => {
  runDb('the TICKET axis (real moveTicketOrg) re-stamps a pending and a decided request', async () => {
    const f = await seed();
    const pending = await insertRequest(f);
    const decided = await insertRequest(f, { ...DECIDED, trigger: 'after_hours' });
    const entryId = await insertHeldEntry(f, pending);

    await withSystemDbAccessContext(() =>
      moveTicketOrg(f.ticket.id, f.orgB.id, { kind: 'user' as const, userId: f.actor.id }));

    expect((await row('ticket_approval_requests', pending))!.org_id).toBe(f.orgB.id);
    expect((await row('ticket_approval_requests', decided))!.org_id).toBe(f.orgB.id);
    const entry = await row('time_entries', entryId);
    expect(entry!.org_id).toBe(f.orgB.id);
    expect(entry!.approval_request_id).toBe(pending);
    expect(entry!.billing_status).toBe('awaiting_approval');
  });

  runDb('the DEVICE axis (real moveDeviceOrgInTransaction) re-stamps the request and its held entry', async () => {
    const f = await seed();
    const pending = await insertRequest(f);
    const decided = await insertRequest(f, { ...DECIDED, trigger: 'after_hours' });
    const entryId = await insertHeldEntry(f, pending);
    const siteB = await createSite({ orgId: f.orgB.id });
    // Bystander: a request on another ticket in the same source org, not bound
    // to the moving device. It must stay behind.
    const [otherTicket] = await (getTestDb() as any).insert(tickets).values({
      orgId: f.orgA.id, partnerId: f.partner.id, ticketNumber: `APR-B-${f.unique}`,
      subject: 'bystander', source: 'manual',
    }).returning();
    const bystander = await insertRequest(f, { ticketId: otherTicket!.id });

    await withSystemDbAccessContext(() => db.transaction((tx) => moveDeviceOrgInTransaction(tx, {
      deviceId: f.device.id,
      sourceOrgId: f.orgA.id,
      targetOrgId: f.orgB.id,
      targetSiteId: siteB.id,
      targetOrgName: 'target',
      deviceLinkGroupId: null,
      acceptCurrencyMismatch: false,
      actor: { userId: f.actor.id, allowedSiteIds: undefined },
      stepUp: null,
      via: 'generic_move',
    } as Parameters<typeof moveDeviceOrgInTransaction>[1])));

    expect((await row('tickets', f.ticket.id))!.org_id).toBe(f.orgB.id);
    expect((await row('ticket_approval_requests', pending))!.org_id).toBe(f.orgB.id);
    expect((await row('ticket_approval_requests', decided))!.org_id).toBe(f.orgB.id);
    expect((await row('ticket_approval_requests', bystander))!.org_id).toBe(f.orgA.id);
    const entry = await row('time_entries', entryId);
    expect(entry!.org_id).toBe(f.orgB.id);
    expect(entry!.approval_request_id).toBe(pending);
  });

  runDb('org MERGE (real repoint policies) carries a decided request and its held entry to the survivor', async () => {
    const f = await seed();
    const decided = await insertRequest(f, DECIDED);
    const pending = await insertRequest(f, { trigger: 'after_hours' });
    const entryId = await insertHeldEntry(f, pending);
    const policies = getOrgMergePolicies();
    expect(policies.get('ticket_approval_requests')).toEqual({ kind: 'repoint' });

    // Loser orgA → survivor orgB, the merge engine's way: one transaction,
    // SET CONSTRAINTS ALL DEFERRED, each table repointed in its own statement.
    await withSystemDbAccessContext(() => db.transaction(async (tx) => {
      await tx.execute(sql`SET CONSTRAINTS ALL DEFERRED`);
      await tx.execute(sql`UPDATE tickets SET org_id = ${f.orgB.id}::uuid WHERE org_id = ${f.orgA.id}::uuid`);
      for (const table of ['time_entries', 'ticket_approval_requests']) {
        await runPolicy(table, policies.get(table)!, f.orgA.id, f.orgB.id, 'resolve');
        await runPolicy(table, policies.get(table)!, f.orgA.id, f.orgB.id, 'move');
      }
    }));

    expect((await row('ticket_approval_requests', decided))!.org_id).toBe(f.orgB.id);
    expect((await row('ticket_approval_requests', pending))!.org_id).toBe(f.orgB.id);
    const entry = await row('time_entries', entryId);
    expect(entry!.org_id).toBe(f.orgB.id);
    expect(entry!.approval_request_id).toBe(pending);
  });

  runDb('without the deferral, moving the ticket first aborts on ticket_approval_requests_ticket_org_fk (the name is load-bearing)', async () => {
    const f = await seed();
    await insertRequest(f);
    const failed = await rejection(() => withSystemDbAccessContext(() => db.transaction(async (tx) => {
      await tx.execute(sql`SET CONSTRAINTS time_entries_ticket_org_fk DEFERRED`);
      await tx.execute(sql`UPDATE tickets SET org_id = ${f.orgB.id}::uuid WHERE id = ${f.ticket.id}::uuid`);
    })));
    expect(failed.code).toBe('23503');
    expect(failed.message).toMatch(/ticket_approval_requests_ticket_org_fk/);
  });
});

describe('tickets:record_approval back-fill (2026-12-18-150400), executed', () => {
  const FILE = path.resolve(__dirname, '../../../migrations/2026-12-18-150400-tickets-record-approval-permission.sql');

  runDb('grants it to a custom role holding tickets:manage, not to one without, and re-applies as a no-op', async () => {
    const f = await seed();
    const adminDb = getTestDb() as any;
    const mkRole = async (name: string) => (await adminDb.execute(sql`
      INSERT INTO roles (name, scope, partner_id, is_system) VALUES (${name}, 'partner', ${f.partner.id}::uuid, false) RETURNING id
    `) as Array<{ id: string }>)[0]!.id;
    const grant = (roleId: string, action: string) => adminDb.execute(sql`
      INSERT INTO role_permissions (role_id, permission_id)
      SELECT ${roleId}::uuid, id FROM permissions WHERE resource = 'tickets' AND action = ${action} ORDER BY id LIMIT 1
    `);
    const manager = await mkRole(`Custom manager ${f.unique}`);
    const writer = await mkRole(`Custom writer ${f.unique}`);
    await grant(manager, 'manage');
    await grant(writer, 'write');

    const migration = readFileSync(FILE, 'utf8');
    const holds = async (roleId: string) => ((await adminDb.execute(sql`
      SELECT count(*)::int AS n FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id
       WHERE rp.role_id = ${roleId}::uuid AND p.resource = 'tickets' AND p.action = 'record_approval'
    `)) as Array<{ n: number }>)[0]!.n;

    try {
      await adminDb.execute(sql.raw(migration));
      expect(await holds(manager)).toBe(1);
      expect(await holds(writer)).toBe(0);
      await adminDb.execute(sql.raw(migration)); // re-apply
      expect(await holds(manager)).toBe(1);
      const rows = (await adminDb.execute(sql`
        SELECT count(*)::int AS n FROM permissions WHERE resource = 'tickets' AND action = 'record_approval'
      `)) as Array<{ n: number }>;
      expect(rows[0]!.n).toBe(1);
    } finally {
      await adminDb.execute(sql`DELETE FROM role_permissions WHERE role_id IN (${manager}::uuid, ${writer}::uuid)`);
      await adminDb.execute(sql`DELETE FROM roles WHERE id IN (${manager}::uuid, ${writer}::uuid)`);
    }
  });
});
