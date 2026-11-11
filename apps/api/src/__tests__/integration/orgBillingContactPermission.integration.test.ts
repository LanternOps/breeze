/**
 * Changing an org's billing contact through `PATCH /orgs/:orgId/billing-settings`
 * needs `billing:manage`, not only `invoices:write`.
 *
 * The billing contact is the recipient of every invoice, quote and autopay
 * notice for the org, so re-pointing it is a billing-administration change.
 * The other writers of the same contact (org PATCH, contact CRUD) already sit
 * behind `organizations:write`; this route admitted any `invoices:write`
 * holder. Every other field of the same form (tax, terms, address) stays
 * `invoices:write`.
 *
 * Driven through the real route and the real auth middleware against real
 * Postgres as `breeze_app`, with partner roles granted through the real
 * permission tables.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { and, eq, isNull } from 'drizzle-orm';
import { invoiceSettingsRoutes } from '../../routes/invoices/settings';
import { contactRoles, contacts, organizations } from '../../db/schema';
import { PERMISSIONS } from '../../services/permissions';
import { checkToolPermission } from '../../services/aiGuardrails';
import type { AuthContext } from '../../middleware/auth';
import { createAccessToken, type TokenPayload } from '../../services/jwt';
import { setupTestEnvironment } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const INVOICES_WRITE = { resource: PERMISSIONS.INVOICES_WRITE.resource, action: PERMISSIONS.INVOICES_WRITE.action };
const BILLING_MANAGE = { resource: PERMISSIONS.BILLING_MANAGE.resource, action: PERMISSIONS.BILLING_MANAGE.action };
const PROFILES_WRITE = { resource: PERMISSIONS.BILLING_PROFILES_WRITE.resource, action: PERMISSIONS.BILLING_PROFILES_WRITE.action };

const BILLING_EMAIL = 'billing@customer.example';

interface Fixture {
  orgId: string;
  patch: (body: unknown) => Promise<Response>;
  /** The same user, as the AI assistant / MCP server present them to the tool permission check. */
  toolAuth: AuthContext;
}

/** A partner user holding exactly `rolePermissions`, with an MFA-verified session. */
async function seed(rolePermissions: Array<{ resource: string; action: string }>): Promise<Fixture> {
  const env = await setupTestEnvironment({ scope: 'partner', rolePermissions });
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
  const app = new Hono();
  app.route('/', invoiceSettingsRoutes);
  const orgId = env.organization.id;

  // The org already has a billing contact, projected into the recipient blob.
  const [row] = await getTestDb().insert(contacts).values({
    orgId, name: 'Accounts Payable', email: BILLING_EMAIL, roles: ['billing'], isPrimary: true,
  }).returning({ id: contacts.id });
  await getTestDb().insert(contactRoles).values({
    contactId: row!.id, orgId, role: 'billing', siteId: null, deviceGroupId: null,
  });
  await getTestDb().update(organizations)
    .set({ billingContact: { contactId: row!.id, email: BILLING_EMAIL, name: 'Accounts Payable', phone: null } })
    .where(eq(organizations.id, orgId));

  const toolAuth = {
    principal: { kind: 'user_session' },
    user: { id: env.user.id, email: env.user.email, name: 'Billing user', isPlatformAdmin: false },
    token: { ...payload, type: 'access' },
    partnerId: env.partner.id,
    orgId: null,
    scope: 'partner',
  } as unknown as AuthContext;

  return {
    orgId,
    toolAuth,
    patch: async (body) => app.request(`/orgs/${orgId}/billing-settings`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  };
}

async function readBlob(orgId: string) {
  const [row] = await getTestDb().select({ billingContact: organizations.billingContact, taxId: organizations.taxId })
    .from(organizations).where(eq(organizations.id, orgId)).limit(1);
  return row!;
}

async function orgLevelContacts(orgId: string) {
  return getTestDb().select({ name: contacts.name, email: contacts.email, roles: contacts.roles })
    .from(contacts).where(and(eq(contacts.orgId, orgId), isNull(contacts.siteId)));
}

describe('billing contact changes on PATCH /orgs/:orgId/billing-settings require billing:manage', () => {
  runDb('an invoices:write-only user cannot change the billing contact email', async () => {
    const { orgId, patch } = await seed([INVOICES_WRITE]);

    const res = await patch({ billingContactEmail: 'someone-else@example.test' });
    expect(res.status).toBe(403);

    expect((await readBlob(orgId)).billingContact).toMatchObject({ email: BILLING_EMAIL });
    expect(await orgLevelContacts(orgId)).toEqual([
      { name: 'Accounts Payable', email: BILLING_EMAIL, roles: ['billing'] },
    ]);
  });

  runDb('an invoices:write-only user cannot clear or rename the billing contact', async () => {
    const { orgId, patch } = await seed([INVOICES_WRITE]);

    expect((await patch({ billingContactEmail: null })).status).toBe(403);
    expect((await patch({ billingContactName: 'Someone Else' })).status).toBe(403);

    expect((await readBlob(orgId)).billingContact).toMatchObject({ email: BILLING_EMAIL, name: 'Accounts Payable' });
  });

  runDb('a contact field alongside other fields rejects the whole request', async () => {
    const { orgId, patch } = await seed([INVOICES_WRITE]);

    const res = await patch({ taxId: 'TAX-1', billingContactEmail: 'someone-else@example.test' });
    expect(res.status).toBe(403);

    const after = await readBlob(orgId);
    expect(after.taxId).toBeNull();
    expect(after.billingContact).toMatchObject({ email: BILLING_EMAIL });
  });

  runDb('billing profile permission does not stand in for billing:manage on a contact change', async () => {
    const { orgId, patch } = await seed([INVOICES_WRITE, PROFILES_WRITE]);

    const res = await patch({ billingProfileId: null, billingContactEmail: 'someone-else@example.test' });
    expect(res.status).toBe(403);
    expect((await readBlob(orgId)).billingContact).toMatchObject({ email: BILLING_EMAIL });
  });

  runDb('an invoices:write-only user can still save the non-contact billing settings', async () => {
    const { orgId, patch } = await seed([INVOICES_WRITE]);

    const res = await patch({ taxId: 'TAX-1', invoiceTermsDays: 15, billingAddressCity: 'Springfield' });
    expect(res.status).toBe(200);

    const after = await readBlob(orgId);
    expect(after.taxId).toBe('TAX-1');
    expect(after.billingContact).toMatchObject({ email: BILLING_EMAIL });
  });

  runDb('a user with billing:manage can change the billing contact', async () => {
    const { orgId, patch } = await seed([INVOICES_WRITE, BILLING_MANAGE]);

    const res = await patch({ billingContactEmail: 'new-ap@customer.example', billingContactName: 'New AP' });
    expect(res.status).toBe(200);

    expect((await readBlob(orgId)).billingContact).toMatchObject({ email: 'new-ap@customer.example', name: 'New AP' });
  });

  runDb('billing:manage alone does not open the route', async () => {
    const { orgId, patch } = await seed([BILLING_MANAGE]);

    expect((await patch({ billingContactEmail: 'new-ap@customer.example' })).status).toBe(403);
    expect((await readBlob(orgId)).billingContact).toMatchObject({ email: BILLING_EMAIL });
  });
});

// The AI assistant and MCP server reach the same service through manage_billing_settings:update_org. Its permission
// check (checkToolPermission: the requester's call, approver eligibility and the re-check at release all resolve the
// same requirements) must refuse a contact change on the same condition as the route.
describe('billing contact changes through manage_billing_settings:update_org require billing:manage', () => {
  const updateOrg = (orgId: string, orgPatch: Record<string, unknown>) =>
    ({ action: 'update_org', orgId, orgPatch });

  runDb('an invoices:write-only user is refused a contact change', async () => {
    const { orgId, toolAuth } = await seed([INVOICES_WRITE]);

    expect(await checkToolPermission('manage_billing_settings',
      updateOrg(orgId, { billingContactEmail: 'someone-else@example.test' }), toolAuth)).toEqual(expect.stringMatching(/billing\.manage/));
    expect(await checkToolPermission('manage_billing_settings',
      updateOrg(orgId, { billingContactEmail: null }), toolAuth)).toEqual(expect.stringMatching(/billing\.manage/));
    expect(await checkToolPermission('manage_billing_settings',
      updateOrg(orgId, { taxId: 'TAX-1', billingContactName: 'Someone Else' }), toolAuth)).toEqual(expect.stringMatching(/billing\.manage/));
  });

  runDb('an invoices:write-only user may still change the non-contact settings', async () => {
    const { orgId, toolAuth } = await seed([INVOICES_WRITE]);

    expect(await checkToolPermission('manage_billing_settings',
      updateOrg(orgId, { taxId: 'TAX-1', invoiceTermsDays: 15 }), toolAuth)).toBeNull();
  });

  runDb('a user with billing:manage may change the contact', async () => {
    const { orgId, toolAuth } = await seed([INVOICES_WRITE, BILLING_MANAGE]);

    expect(await checkToolPermission('manage_billing_settings',
      updateOrg(orgId, { billingContactEmail: 'new-ap@customer.example' }), toolAuth)).toBeNull();
  });
});
