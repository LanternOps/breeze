/**
 * Created contacts (#8313 W4b; spec
 * docs/superpowers/specs/api-platform/2026-10-19-ticket-import-modules-design.md
 * §5.3 item 6, §5.13, §8 W4b row) against real Postgres (as breeze_app) and
 * Redis: the fake module through the real worker, ledger and writer, and the
 * writer called directly where the module's own lookup would answer first.
 *
 * Proves: with "create missing requester contacts" on, a contact is created
 * once per (org, email) across tickets and passes, linked under the source's
 * system; this import's link wins, then one email match (reused, no link);
 * several matches stay display-only; no email, no contact; an unmatched owner
 * never becomes a user; no outbox row, event, audit row or mail; option off,
 * nothing is created; the dry run predicts per org; and removal deletes what
 * is still as imported, skips an edited contact, and leaves tickets on their
 * submitter snapshot.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';

const effects = vi.hoisted(() => ({ ticketEvents: [] as unknown[], mail: [] as unknown[] }));

vi.mock('../../services/s3Storage', async (orig) => ({
  ...(await orig<typeof import('../../services/s3Storage')>()),
  isS3Configured: () => true,
}));
vi.mock('../../services/ticketEvents', async (orig) => {
  const actual = await orig<typeof import('../../services/ticketEvents')>();
  const record = async (event: unknown) => { effects.ticketEvents.push(event); };
  return { ...actual, emitTicketEvent: record, enqueueTicketEvent: record };
});
vi.mock('../../services/email', async (orig) => {
  const actual = await orig<typeof import('../../services/email')>();
  // Any method of the mailer records its call: nothing in an import may send.
  const mailer = new Proxy({}, { get: (_t, name) => async (...args: unknown[]) => { effects.mail.push([name, ...args]); } });
  return { ...actual, getEmailService: () => mailer };
});

import { db, withDbAccessContext } from '../../db';
import { auditLogs, contactExternalLinks, contacts, ticketExternalRefs, ticketImportRunIssues, ticketOutbox, tickets, users } from '../../db/schema';
import { updateContact } from '../../services/contacts/crud';
import { listCreatedContacts, removeCreatedContacts } from '../../services/ticketImport/createdContacts';
import { importTicket } from '../../services/ticketImport/importWriter';
import type { ImportedTicket } from '../../services/ticketImport/importedTicket';
import { registerTicketImportModule } from '../../services/ticketImport/moduleRegistry';
import { normalizeCounters } from '../../services/ticketImport/runReport';
import { clearFakeSources, fakeTicketImportModule } from '../../services/ticketImport/testing/fakeModule';
import { drive, fakeTickets, minutes, openWindow, runRow, seedImport, setMappings, startImportRun, type ImportFx } from './ticketImportFixtures';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const CASE_TIMEOUT = 120_000;
const ON = { createRequesterContacts: true };

let unregister: () => void;
beforeAll(() => { unregister = registerTicketImportModule(fakeTicketImportModule); });
afterAll(() => unregister());
beforeEach(() => { effects.ticketEvents.length = 0; effects.mail.length = 0; });
afterEach(() => clearFakeSources());

const MAPS = {
  orgs: [
    { sourceOrgKey: 'acme', sourceOrgName: 'Acme', orgId: '' },
    { sourceOrgKey: 'beta', sourceOrgName: 'Beta', orgId: '' },
  ],
  categories: [],
};

async function withOptions(fx: ImportFx, options: Record<string, unknown>) {
  await setMappings(fx, {
    ...MAPS,
    orgs: [{ ...MAPS.orgs[0]!, orgId: fx.orgA.id }, { ...MAPS.orgs[1]!, orgId: fx.orgB.id }],
  }, options);
}

const system = (fx: ImportFx) => `ticket-import:${fx.sourceId}`;

async function contactsWith(orgId: string, email: string) {
  return getTestDb().select().from(contacts).where(and(eq(contacts.orgId, orgId), sql`lower(${contacts.email}) = ${email.toLowerCase()}`));
}

async function linksOf(fx: ImportFx) {
  return getTestDb().select().from(contactExternalLinks).where(eq(contactExternalLinks.system, system(fx)));
}

async function ticketsByKey(fx: ImportFx) {
  const rows = await getTestDb()
    .select({
      key: ticketExternalRefs.externalId,
      id: tickets.id,
      orgId: tickets.orgId,
      requesterContactId: tickets.requesterContactId,
      submitterName: tickets.submitterName,
      submitterEmail: tickets.submitterEmail,
      assignedTo: tickets.assignedTo,
    })
    .from(tickets)
    .innerJoin(ticketExternalRefs, eq(ticketExternalRefs.ticketId, tickets.id))
    .where(eq(ticketExternalRefs.partnerServicePrincipalId, fx.principal.id));
  return new Map(rows.map((r) => [r.key, r]));
}

/** A ticket whose requester is `{ createContact }`, written through importTicket directly. */
function direct(fx: ImportFx, key: string, requester: ImportedTicket['requester']): ImportedTicket {
  return {
    sourceId: key,
    orgId: fx.orgA.id,
    createdAt: minutes(0),
    updatedAt: minutes(10),
    subject: `Direct ${key}`,
    description: '',
    priority: 'normal',
    source: 'email',
    requester,
    finalStatus: 'open',
    comments: [],
  };
}

describe('created contacts (W4b): requesters of imported tickets become contacts, opt-in', () => {
  runDb('a contact is created once per (org, email) across tickets and passes; the dry run predicts it; nothing else fires', async () => {
    const fx = await seedImport();
    await withOptions(fx, ON);
    fx.source.tickets = fakeTickets(['t1', 't2', 't3']).map((t, i) => ({
      ...t,
      orgKey: i === 2 ? 'beta' : 'acme',
      requesterEmail: i === 1 ? 'New.Person@Customer.example' : 'new.person@customer.example',
      requesterKey: 'u1',
      requesterName: 'New Person',
    }));

    // The dry run: one per org, although t1 and t2 share the requester; it creates nothing.
    const dry = await startImportRun(fx, 'dry_run');
    await drive(fx, dry.id);
    const dryCounters = normalizeCounters((await runRow(dry.id)).counters);
    expect(dryCounters.predicted.contactsToCreate).toEqual({ [fx.orgA.id]: 1, [fx.orgB.id]: 1 });
    expect(dryCounters.contactsCreated).toBe(0);
    expect(await linksOf(fx)).toEqual([]);
    expect(await contactsWith(fx.orgA.id, 'new.person@customer.example')).toEqual([]);

    const window = await openWindow(fx);
    const bulk = await startImportRun(fx, 'import', window.id);
    await drive(fx, bulk.id);
    const bulkRow = await runRow(bulk.id);
    expect(bulkRow).toMatchObject({ state: 'completed' });
    const c1 = normalizeCounters(bulkRow.counters);
    expect(c1.tickets).toMatchObject({ created: 3, failed: 0 });
    expect(c1.contactsCreated).toBe(2);
    expect(c1.requestersWithoutContact).toBe(0);

    const [inA] = await contactsWith(fx.orgA.id, 'new.person@customer.example');
    const [inB] = await contactsWith(fx.orgB.id, 'new.person@customer.example');
    expect(await contactsWith(fx.orgA.id, 'new.person@customer.example')).toHaveLength(1);
    // No portal access, no creator, the address as Breeze stores it.
    expect(inA).toMatchObject({ name: 'New Person', email: 'new.person@customer.example', roles: [], createdBy: null, isPrimary: false });
    expect(inB).toBeDefined();
    const links = await linksOf(fx);
    expect(links.map((l) => [l.orgId, l.contactId, l.externalId]).sort()).toEqual(
      [[fx.orgA.id, inA!.id, 'u1'], [fx.orgB.id, inB!.id, 'u1']].sort(),
    );
    const t = await ticketsByKey(fx);
    expect(t.get('t1')).toMatchObject({ requesterContactId: inA!.id, submitterEmail: 'new.person@customer.example', submitterName: 'New Person' });
    expect(t.get('t2')!.requesterContactId).toBe(inA!.id);
    expect(t.get('t3')).toMatchObject({ orgId: fx.orgB.id, requesterContactId: inB!.id });

    // The second pass: the three resume (the requester is never re-applied), t4
    // is the same source person (its link), t5 another source person with the
    // address (one email match: reused, and no link, as the import did not create it).
    fx.source.tickets = [
      ...fx.source.tickets.map((x) => ({ ...x, version: 'v2', updatedAt: minutes(90) })),
      ...fakeTickets(['t4', 't5']).map((x, i) => ({
        ...x,
        requesterEmail: 'new.person@customer.example',
        requesterKey: i === 0 ? 'u1' : 'u2',
        requesterName: 'New Person',
      })),
    ];
    const delta = await startImportRun(fx, 'import', window.id);
    await drive(fx, delta.id);
    const c2 = normalizeCounters((await runRow(delta.id)).counters);
    expect(c2.tickets).toMatchObject({ created: 2, resumed: 3, failed: 0 });
    expect(c2.contactsCreated).toBe(0);
    expect(await contactsWith(fx.orgA.id, 'new.person@customer.example')).toHaveLength(1);
    expect(await linksOf(fx)).toHaveLength(2);
    const t2 = await ticketsByKey(fx);
    expect(t2.get('t4')!.requesterContactId).toBe(inA!.id);
    expect(t2.get('t5')!.requesterContactId).toBe(inA!.id);

    // The run's audit row carries the count (it is written fire-and-forget).
    await vi.waitFor(async () => {
      const [finished] = await getTestDb().select().from(auditLogs)
        .where(and(eq(auditLogs.action, 'ticket_import.run_finished'), eq(auditLogs.resourceId, bulk.id)));
      expect((finished?.details as { counters?: { contactsCreated?: number } } | undefined)?.counters?.contactsCreated).toBe(2);
    });
    // No outbox row, no ticket event, no mail, and no per-contact audit row.
    const orgIds = [fx.orgA.id, fx.orgB.id];
    expect(await getTestDb().select().from(ticketOutbox).where(inArray(ticketOutbox.orgId, orgIds))).toEqual([]);
    expect(effects.ticketEvents).toEqual([]);
    expect(effects.mail).toEqual([]);
    expect(await getTestDb().select().from(auditLogs).where(and(eq(auditLogs.resourceType, 'contact'), inArray(auditLogs.orgId, orgIds)))).toEqual([]);
  }, CASE_TIMEOUT);

  runDb('the writer: an existing single match is reused without a link; several matches stay display-only; the link wins over the email', async () => {
    const fx = await seedImport();
    const window = await openWindow(fx);
    const testDb = getTestDb();
    const [single] = await testDb.insert(contacts).values({ orgId: fx.orgA.id, name: 'Existing', email: 'existing@customer.example' }).returning();
    await testDb.insert(contacts).values([
      { orgId: fx.orgA.id, name: 'Front desk', email: 'shared@customer.example' },
      { orgId: fx.orgA.id, name: 'Accounts', email: 'shared@customer.example' },
    ]);
    const people = { sourceId: fx.sourceId, runId: randomUUID() };
    const options = { partnerId: fx.partner.id, people };

    const reused = await importTicket(window.id, direct(fx, 'd1', { createContact: { name: 'Ex', email: 'Existing@customer.example', sourceUserKey: 'p1' } }), options);
    expect(reused).toMatchObject({ outcome: 'created', contactsCreated: 0, requesterResolution: 'matched' });
    const shared = await importTicket(window.id, direct(fx, 'd2', { createContact: { name: 'Shared', email: 'shared@customer.example', sourceUserKey: 'p2' } }), options);
    expect(shared).toMatchObject({ outcome: 'created', contactsCreated: 0, requesterResolution: 'display_only' });
    const t = await ticketsByKey(fx);
    expect(t.get('d1')!.requesterContactId).toBe(single!.id);
    expect(t.get('d2')).toMatchObject({ requesterContactId: null, submitterEmail: 'shared@customer.example', submitterName: 'Shared' });
    expect(await contactsWith(fx.orgA.id, 'shared@customer.example')).toHaveLength(2);
    expect(await linksOf(fx)).toEqual([]);

    // A created contact whose email later changes in Breeze: the source person's link still finds it.
    const created = await importTicket(window.id, direct(fx, 'd3', { createContact: { email: 'fresh@customer.example', sourceUserKey: 'p3' } }), options);
    expect(created).toMatchObject({ contactsCreated: 1, requesterResolution: 'created' });
    const [fresh] = await contactsWith(fx.orgA.id, 'fresh@customer.example');
    // A nameless contact is identified by its address alone; the ticket's snapshot is named by it.
    expect(fresh).toMatchObject({ name: null, roles: [] });
    expect((await ticketsByKey(fx)).get('d3')).toMatchObject({ requesterContactId: fresh!.id, submitterName: 'fresh@customer.example' });
    await testDb.update(contacts).set({ email: 'renamed@customer.example' }).where(eq(contacts.id, fresh!.id));
    const again = await importTicket(window.id, direct(fx, 'd4', { createContact: { email: 'fresh@customer.example', sourceUserKey: 'p3' } }), options);
    expect(again).toMatchObject({ contactsCreated: 0, requesterResolution: 'linked' });
    expect((await ticketsByKey(fx)).get('d4')!.requesterContactId).toBe(fresh!.id);
    expect(await contactsWith(fx.orgA.id, 'fresh@customer.example')).toEqual([]);

    // Without the ledger the variant is refused before anything is written.
    await expect(importTicket(window.id, direct(fx, 'd5', { createContact: { email: 'x@customer.example', sourceUserKey: 'p5' } }), { partnerId: fx.partner.id }))
      .rejects.toMatchObject({ code: 'MIGRATION_IMPORT_INVALID' });
    expect((await ticketsByKey(fx)).has('d5')).toBe(false);
  }, CASE_TIMEOUT);

  runDb('no email, no contact; an unmatched owner never becomes a user; with the option off nothing is created', async () => {
    const fx = await seedImport();
    await withOptions(fx, ON);
    fx.source.tickets = [
      // No requester email (Zammad's Eve): display-only.
      ...fakeTickets(['n1']).map((x) => ({ ...x, requesterName: 'Eve Nomail' })),
      // An owner who matches no user: unassigned, reported, and never created.
      ...fakeTickets(['n2']).map((x) => ({ ...x, ownerEmail: 'gone.owner@former.example', requesterEmail: 'gone.owner@former.example' })),
    ];
    const contactsBefore = await getTestDb().select({ id: contacts.id }).from(contacts).where(inArray(contacts.orgId, [fx.orgA.id, fx.orgB.id]));
    const window = await openWindow(fx);
    const run = await startImportRun(fx, 'import', window.id);
    await drive(fx, run.id);
    const counters = normalizeCounters((await runRow(run.id)).counters);
    expect(counters.tickets).toMatchObject({ created: 2, failed: 0 });
    expect(counters.requestersWithoutContact).toBe(1);
    expect(counters.ownersUnmatched).toBe(1);
    const t = await ticketsByKey(fx);
    expect(t.get('n1')).toMatchObject({ requesterContactId: null, submitterEmail: null, submitterName: 'Eve Nomail' });
    expect(t.get('n2')!.assignedTo).toBeNull();
    expect(await getTestDb().select().from(users).where(sql`lower(${users.email}) = 'gone.owner@former.example'`)).toEqual([]);
    const issues = await getTestDb().select().from(ticketImportRunIssues).where(eq(ticketImportRunIssues.runId, run.id));
    expect(issues.filter((i) => i.kind === 'owner_unmatched').map((i) => i.code)).toEqual(['gone.owner@former.example']);
    // The requester of n2 is a contact; the owner, with the same address, is no user.
    expect(await contactsWith(fx.orgA.id, 'gone.owner@former.example')).toHaveLength(1);
    expect(counters.contactsCreated).toBe(1);

    // Option off (the default): the same tickets in another source create nothing.
    const off = await seedImport();
    off.source.tickets = fakeTickets(['o1', 'o2']).map((x) => ({ ...x, requesterEmail: 'off.person@customer.example', requesterKey: 'u1' }));
    const offWindow = await openWindow(off);
    const offRun = await startImportRun(off, 'import', offWindow.id);
    await drive(off, offRun.id);
    const offCounters = normalizeCounters((await runRow(offRun.id)).counters);
    expect(offCounters.tickets).toMatchObject({ created: 2, failed: 0 });
    expect(offCounters.contactsCreated).toBe(0);
    expect(offCounters.requestersWithoutContact).toBe(2);
    expect(await contactsWith(off.orgA.id, 'off.person@customer.example')).toEqual([]);
    expect(await linksOf(off)).toEqual([]);
    expect([...(await ticketsByKey(off)).values()].every((x) => x.requesterContactId === null && x.submitterEmail === 'off.person@customer.example')).toBe(true);
    expect(contactsBefore).toEqual([]);
  }, CASE_TIMEOUT);

  runDb('removal deletes the contacts still as imported, skips an edited one, and tickets keep their snapshot', async () => {
    const fx = await seedImport();
    await withOptions(fx, ON);
    fx.source.tickets = fakeTickets(['r1', 'r2', 'r3']).map((x, i) => ({
      ...x,
      requesterEmail: i === 2 ? 'edited@customer.example' : 'plain@customer.example',
      requesterKey: i === 2 ? 'u-edited' : 'u-plain',
      requesterName: i === 2 ? 'Edited Person' : 'Plain Person',
    }));
    const window = await openWindow(fx);
    const run = await startImportRun(fx, 'import', window.id);
    await drive(fx, run.id);
    expect(normalizeCounters((await runRow(run.id)).counters).contactsCreated).toBe(2);
    const [plain] = await contactsWith(fx.orgA.id, 'plain@customer.example');
    const [edited] = await contactsWith(fx.orgA.id, 'edited@customer.example');

    // A technician edits one (through the live service, as breeze_app).
    await withDbAccessContext(fx.ownerContext(), () => updateContact(db, edited!.id, fx.orgA.id, { title: 'Office manager' }, { userId: fx.owner.id }));

    const listed = await withDbAccessContext(fx.ownerContext(), () => listCreatedContacts(fx.sourceId));
    expect(listed.contacts.map((c) => [c.contactId, c.keptBecause]).sort()).toEqual([[edited!.id, ['edited']], [plain!.id, []]].sort());

    const result = await withDbAccessContext(fx.ownerContext(), () => removeCreatedContacts(fx.sourceId, { userId: fx.owner.id, destinationSource: 'technician' }));
    expect(result.removed.map((r) => r.contactId)).toEqual([plain!.id]);
    expect(result).toMatchObject({ skipped: 1, skippedBy: { edited: 1, portal_login: 0, role: 0, other_link: 0 }, remaining: 0 });

    expect(await contactsWith(fx.orgA.id, 'plain@customer.example')).toEqual([]);
    expect(await contactsWith(fx.orgA.id, 'edited@customer.example')).toHaveLength(1);
    // The removed contact's link went with it (cascade); the edited one's stays.
    expect((await linksOf(fx)).map((l) => l.externalId)).toEqual(['u-edited']);
    // Its tickets fall back to display-only, on the snapshot the create stored (F37).
    const t = await ticketsByKey(fx);
    for (const key of ['r1', 'r2']) {
      expect(t.get(key)).toMatchObject({ requesterContactId: null, submitterEmail: 'plain@customer.example', submitterName: 'Plain Person' });
    }
    expect(t.get('r3')!.requesterContactId).toBe(edited!.id);

    // A second removal finds nothing more to remove.
    const again = await withDbAccessContext(fx.ownerContext(), () => removeCreatedContacts(fx.sourceId, { userId: fx.owner.id }));
    expect(again).toMatchObject({ removed: [], skipped: 1 });

    // A later pass does not recreate the removed contact for the tickets it resumes.
    fx.source.tickets = fx.source.tickets.map((x) => ({ ...x, version: 'v2', updatedAt: minutes(90) }));
    const delta = await startImportRun(fx, 'import', window.id);
    await drive(fx, delta.id);
    expect(normalizeCounters((await runRow(delta.id)).counters)).toMatchObject({ contactsCreated: 0, tickets: { resumed: 3 } });
    expect(await contactsWith(fx.orgA.id, 'plain@customer.example')).toEqual([]);
  }, CASE_TIMEOUT);
});
