/**
 * The org "Billing contact" setting edits the contact that HOLDS THE BILLING
 * ROLE — never the org's primary contact (browser sweep on main 628204785b).
 *
 * The bug: `PATCH /orgs/:orgId/billing-settings` merged the billing email into
 * whichever contact held `is_primary` at org level. An org whose primary was a
 * technical contact (Dana) and whose billing contact was someone else (Bill)
 * had DANA's email overwritten with the billing address, and a save that
 * cleared the field deleted Dana outright. Separately, making a non-billing
 * contact primary in the Contacts list re-pointed `organizations.billing_contact`
 * — the invoice/quote recipient — at that contact.
 *
 * Driven through the real routes (billing-settings, org PATCH, contact CRUD)
 * against real Postgres as `breeze_app`, so the request's RLS context, the
 * compat service and the projection all run for real.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { invoiceSettingsRoutes } from '../../routes/invoices/settings';
import { orgRoutes } from '../../routes/orgs';
import { contactRoles, contacts, organizations } from '../../db/schema';
import { createAccessToken, type TokenPayload } from '../../services/jwt';
import { setupTestEnvironment } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function buildApp(): Hono {
  const app = new Hono();
  // index.ts mounts both: orgRoutes under /orgs, invoiceSettingsRoutes at the root.
  app.route('/orgs', orgRoutes);
  app.route('/', invoiceSettingsRoutes);
  return app;
}

interface Fixture {
  orgId: string;
  request: (method: string, path: string, body?: unknown) => Promise<Response>;
}

/** A partner-scope admin with a step-up (mfa: true) session — both routes require it. */
async function seed(): Promise<Fixture> {
  const env = await setupTestEnvironment({ scope: 'partner' });
  const payload: Omit<TokenPayload, 'type'> = {
    sub: env.user.id,
    email: env.user.email,
    roleId: env.role.id,
    orgId: null,
    partnerId: env.partner.id,
    scope: 'partner',
    mfa: true,
    aep: 1,
    mep: 1,
    sid: randomUUID(),
  };
  const token = await createAccessToken(payload);
  const app = buildApp();
  return {
    orgId: env.organization.id,
    request: async (method, path, body) => app.request(path, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  };
}

type Seeded = typeof contacts.$inferInsert;

/** Privileged fixture insert (RLS-bypassing scaffolding, like every db-utils seed). */
async function insertContact(values: Seeded): Promise<string> {
  const [row] = await getTestDb().insert(contacts).values(values).returning({ id: contacts.id, siteId: contacts.siteId });
  const roles = Array.isArray(values.roles) ? values.roles : [];
  if (roles.length > 0) {
    await getTestDb().insert(contactRoles).values(roles.map((role) => ({
      contactId: row!.id,
      orgId: values.orgId,
      role,
      siteId: row!.siteId,
      deviceGroupId: null,
    })));
  }
  return row!.id;
}

async function readContact(id: string) {
  const [row] = await getTestDb().select().from(contacts).where(eq(contacts.id, id)).limit(1);
  return row ?? null;
}

async function orgLevelContacts(orgId: string) {
  return getTestDb().select().from(contacts)
    .where(and(eq(contacts.orgId, orgId), isNull(contacts.siteId)))
    .orderBy(asc(contacts.createdAt), asc(contacts.id));
}

async function readBlob(orgId: string) {
  const [row] = await getTestDb().select({ billingContact: organizations.billingContact })
    .from(organizations).where(eq(organizations.id, orgId)).limit(1);
  return row!.billingContact as Record<string, unknown> | null;
}

/**
 * The shape the sweep found: Bill was the org's billing contact, then Dana (a
 * technical contact) was made primary in the Contacts list. `created_at` is
 * pinned so Bill is unambiguously the older row. The blob holds what the old
 * code projected there — the PRIMARY's details.
 */
async function seedDanaAndBill(orgId: string) {
  const billId = await insertContact({
    orgId, name: 'Bill Payer', email: 'bill@customer.example', phone: '555-0100',
    roles: ['billing'], isPrimary: false, createdAt: new Date('2026-01-01T00:00:00Z'),
  });
  const danaId = await insertContact({
    orgId, name: 'Dana Tech', email: 'dana@customer.example', phone: '555-0199',
    title: 'IT lead', roles: ['technical'], isPrimary: true, createdAt: new Date('2026-02-01T00:00:00Z'),
  });
  await getTestDb().update(organizations)
    .set({ billingContact: { name: 'Dana Tech', email: 'dana@customer.example', phone: '555-0199' } })
    .where(eq(organizations.id, orgId));
  return { billId, danaId, danaBefore: (await readContact(danaId))! };
}

describe('Billing contact setting targets the billing-role contact (real DB, through the routes)', () => {
  runDb('saving a billing email edits the billing contact and leaves the primary contact untouched', async () => {
    const { orgId, request } = await seed();
    const { billId, danaId, danaBefore } = await seedDanaAndBill(orgId);

    const res = await request('PATCH', `/orgs/${orgId}/billing-settings`, {
      billingContactEmail: 'ap@customer.example', billingContactName: 'Accounts Payable',
    });
    expect(res.status).toBe(200);

    // Dana is byte-identical — not one column, updated_at included, moved.
    expect(await readContact(danaId)).toEqual(danaBefore);

    const bill = await readContact(billId);
    expect(bill).toMatchObject({
      name: 'Accounts Payable', email: 'ap@customer.example', roles: ['billing'], isPrimary: false,
    });
    // Invoices and quotes resolve their recipient from this column.
    expect(await readBlob(orgId)).toMatchObject({ contactId: billId, email: 'ap@customer.example', name: 'Accounts Payable' });
    const body = await res.json() as { data: { billingContact: { email: string } } };
    expect(body.data.billingContact.email).toBe('ap@customer.example');
  });

  runDb('creates a billing contact when nobody holds the role, instead of adopting the primary', async () => {
    const { orgId, request } = await seed();
    const danaId = await insertContact({
      orgId, name: 'Dana Tech', email: 'dana@customer.example', roles: ['technical'], isPrimary: true,
    });
    const danaBefore = await readContact(danaId);

    const res = await request('PATCH', `/orgs/${orgId}/billing-settings`, {
      billingContactEmail: 'ap@customer.example', billingContactName: 'Accounts Payable',
    });
    expect(res.status).toBe(200);

    expect(await readContact(danaId)).toEqual(danaBefore);
    const rows = await orgLevelContacts(orgId);
    expect(rows).toHaveLength(2);
    const created = rows.find((r) => r.id !== danaId)!;
    // Not primary: the org already has a headline contact, and claiming the
    // slot would demote Dana.
    expect(created).toMatchObject({
      name: 'Accounts Payable', email: 'ap@customer.example', roles: ['billing'], isPrimary: false,
    });
    expect(await readBlob(orgId)).toMatchObject({ email: 'ap@customer.example' });
  });

  runDb('clearing the billing contact removes the billing role only — no contact is deleted or edited', async () => {
    const { orgId, request } = await seed();
    const { billId, danaId, danaBefore } = await seedDanaAndBill(orgId);
    const billBefore = (await readContact(billId))!;

    const res = await request('PATCH', `/orgs/${orgId}/billing-settings`, {
      billingContactEmail: null, billingContactName: null,
    });
    expect(res.status).toBe(200);

    // The primary contact survives, untouched. (Before the fix it was DELETED.)
    expect(await readContact(danaId)).toEqual(danaBefore);
    // Bill still exists with every detail intact; he is just no longer the
    // billing contact.
    const bill = await readContact(billId);
    expect(bill, 'the billing contact row must not be deleted').not.toBeNull();
    expect(bill).toMatchObject({
      name: billBefore.name, email: billBefore.email, phone: billBefore.phone, isPrimary: false,
    });
    expect(bill!.roles).not.toContain('billing');
    expect(await orgLevelContacts(orgId)).toHaveLength(2);

    // Nobody holds the billing role now, so there is no default recipient.
    // Deliberately NOT a fallback to the primary contact: that would put Dana
    // straight back on every invoice.
    expect(await readBlob(orgId)).toBeNull();
  });

  runDb('clearing never deletes a primary contact that has only a name and an email', async () => {
    // Before the fix the clear landed on Dana; with no phone or mobile left to
    // keep her identifiable, the compat service DELETED her.
    const { orgId, request } = await seed();
    const danaId = await insertContact({
      orgId, name: 'Dana Tech', email: 'dana@customer.example', roles: ['technical'], isPrimary: true,
    });
    const danaBefore = await readContact(danaId);

    const res = await request('PATCH', `/orgs/${orgId}/billing-settings`, {
      billingContactEmail: null, billingContactName: null,
    });
    expect(res.status).toBe(200);
    expect(await readContact(danaId)).toEqual(danaBefore);
  });

  runDb('the org PATCH billingContact field edits the billing contact, not the primary', async () => {
    const { orgId, request } = await seed();
    const { billId, danaId, danaBefore } = await seedDanaAndBill(orgId);

    const res = await request('PATCH', `/orgs/organizations/${orgId}`, {
      billingContact: { name: 'Accounts Payable', email: 'ap@customer.example' },
    });
    expect(res.status).toBe(200);

    expect(await readContact(danaId)).toEqual(danaBefore);
    expect(await readContact(billId)).toMatchObject({
      name: 'Accounts Payable', email: 'ap@customer.example', roles: ['billing'],
    });
    expect(await readBlob(orgId)).toMatchObject({ email: 'ap@customer.example' });
  });

  runDb('with several billing contacts, the org PATCH edits the one invoices currently go to', async () => {
    // Bill is older, but invoices go to Carol. The route must pick its target
    // BEFORE the request's value lands in organizations.billing_contact, or
    // the "current recipient" tiebreak compares against the new address and
    // falls through to the oldest contact — Bill.
    const { orgId, request } = await seed();
    const billId = await insertContact({
      orgId, name: 'Bill Payer', email: 'bill@customer.example', phone: '555-0100',
      roles: ['billing'], createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    const carolId = await insertContact({
      orgId, name: 'Carol AP', email: 'carol@customer.example',
      roles: ['billing'], createdAt: new Date('2026-02-01T00:00:00Z'),
    });
    await getTestDb().update(organizations)
      .set({ billingContact: { name: 'Carol AP', email: 'carol@customer.example', phone: null } })
      .where(eq(organizations.id, orgId));
    const billBefore = await readContact(billId);

    const res = await request('PATCH', `/orgs/organizations/${orgId}`, {
      billingContact: { name: 'Accounts Payable', email: 'ap@customer.example' },
    });
    expect(res.status).toBe(200);

    expect(await readContact(billId)).toEqual(billBefore);
    expect(await readContact(carolId)).toMatchObject({ name: 'Accounts Payable', email: 'ap@customer.example' });
    expect(await readBlob(orgId)).toMatchObject({ email: 'ap@customer.example' });
    const body = await res.json() as { billingContact: { email: string } };
    expect(body.billingContact.email).toBe('ap@customer.example');
  });

  runDb('editing the current recipient\'s own email keeps it the billing contact', async () => {
    // Identity, not email, is what keeps Carol the recipient: matched on the
    // old address, her own email change would hand invoices to the older Bill.
    const { orgId, request } = await seed();
    await insertContact({
      orgId, name: 'Bill Payer', email: 'bill@customer.example',
      roles: ['billing'], createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    const carolId = await insertContact({
      orgId, name: 'Carol AP', email: 'carol@customer.example',
      roles: ['billing'], createdAt: new Date('2026-02-01T00:00:00Z'),
    });
    // Make Carol the recipient through the product path (billing-settings edits
    // the current recipient; the incumbent here is resolved by legacy email).
    await getTestDb().update(organizations)
      .set({ billingContact: { name: 'Carol AP', email: 'carol@customer.example', phone: null } })
      .where(eq(organizations.id, orgId));
    expect((await request('PATCH', `/orgs/${orgId}/billing-settings`, { billingContactName: 'Carol A. P.' })).status).toBe(200);
    expect(await readBlob(orgId)).toMatchObject({ contactId: carolId, name: 'Carol A. P.' });

    expect((await request('PATCH', `/orgs/contacts/${carolId}`, { email: 'carol.new@customer.example' })).status).toBe(200);
    expect(await readBlob(orgId)).toMatchObject({ contactId: carolId, email: 'carol.new@customer.example' });
  });

  runDb('making a non-billing contact primary does not re-point the invoice recipient', async () => {
    const { orgId, request } = await seed();
    const billId = await insertContact({
      orgId, name: 'Bill Payer', email: 'bill@customer.example', roles: ['billing'], isPrimary: true,
    });
    await getTestDb().update(organizations)
      .set({ billingContact: { name: 'Bill Payer', email: 'bill@customer.example', phone: null } })
      .where(eq(organizations.id, orgId));

    const res = await request('POST', `/orgs/organizations/${orgId}/contacts`, {
      name: 'Dana Tech', email: 'dana@customer.example', roles: ['technical'], isPrimary: true,
    });
    expect(res.status).toBe(201);

    // Dana took the primary slot (Bill was demoted)...
    expect(await readContact(billId)).toMatchObject({ isPrimary: false, roles: ['billing'] });
    // ...but invoices still go to the billing contact.
    expect(await readBlob(orgId)).toMatchObject({ email: 'bill@customer.example' });
  });

  runDb('importing an org-level contact with the billing role makes it the invoice recipient', async () => {
    const { orgId, request } = await seed();
    const res = await request('POST', '/orgs/contacts/import', {
      rows: [{ organizationId: orgId, name: 'Imported AP', email: 'ap@customer.example', roles: ['billing'] }],
    });
    expect(res.status).toBe(200);
    expect(await readBlob(orgId)).toMatchObject({ email: 'ap@customer.example' });
  });

  runDb('giving a contact the billing role in the Contacts list makes it the invoice recipient', async () => {
    const { orgId, request } = await seed();
    const { billId, danaId } = await seedDanaAndBill(orgId);
    // Bill loses the role; Dana gains it — the Contacts list is the home for this.
    expect((await request('PATCH', `/orgs/contacts/${billId}`, { roles: [] })).status).toBe(200);
    expect((await request('PATCH', `/orgs/contacts/${danaId}`, { roles: ['technical', 'billing'] })).status).toBe(200);
    expect(await readBlob(orgId)).toMatchObject({ email: 'dana@customer.example' });

    const carolRes = await request('POST', `/orgs/organizations/${orgId}/contacts`, {
      name: 'Carol AP', email: 'carol@customer.example', roles: ['billing'],
    });
    expect(carolRes.status).toBe(201);
    // Two billing contacts: the primary one wins the tiebreak.
    expect(await readBlob(orgId)).toMatchObject({ email: 'dana@customer.example' });

    expect((await request('DELETE', `/orgs/contacts/${danaId}`)).status).toBe(200);
    expect(await readBlob(orgId)).toMatchObject({ email: 'carol@customer.example' });
  });
});
