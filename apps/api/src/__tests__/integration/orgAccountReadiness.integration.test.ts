/**
 * Real-Postgres coverage for GET /orgs/account-readiness (Organizations
 * account board, feature #5721 W01). routes/orgAccountReadiness.test.ts
 * pins validation, gating and shaping with the service mocked;
 * services/orgAccountReadiness.test.ts pins the compiled predicates. This file
 * proves the grouped SQL, the accepted-id resolution and the composed-app
 * path against genuine rows under forced RLS as breeze_app.
 *
 * The app mounts the REAL orgRoutes before orgAccountReadinessRoutes, in the
 * same order as apps/api/src/index.ts, so a regression that moved the path
 * under `/organizations/…` (captured by orgRoutes' `/organizations/:id`)
 * fails here rather than in production.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { orgRoutes } from '../../routes/orgs';
import { orgAccountReadinessRoutes } from '../../routes/orgAccountReadiness';
import { db, withSystemDbAccessContext } from '../../db';
import {
  configPolicyAssignments,
  configurationPolicies,
  contacts,
  devices,
  invoices,
  organizations,
  partners,
  partnerUsers,
  portalUsers,
  tickets,
  users,
} from '../../db/schema';
import { createAccessToken, type TokenPayload } from '../../services/jwt';
import { PERMISSIONS } from '../../services/permissions';
import {
  assignUserToPartner,
  createIntegrationTestClient,
  createOrganization,
  createRole,
  createSite,
  createUser,
  grantRolePermissions,
  type IntegrationTestClient,
} from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function buildApp(): Hono {
  const app = new Hono();
  // index.ts order: orgRoutes owns `/orgs/organizations/:id`; the readiness
  // router must still answer `/orgs/account-readiness` behind it.
  app.route('/orgs', orgRoutes);
  app.route('/orgs', orgAccountReadinessRoutes);
  return app;
}

interface Board {
  app: Hono;
  /** Partner P1's wildcard-permission, orgAccess=all client. */
  client: IntegrationTestClient;
  partnerId: string;
  /** client.env.organization: customer, active, owns client.env.site. */
  orgA: string;
  /** internal, trial, no site. */
  orgB: string;
  /** customer, active, nothing seeded. */
  orgC: string;
  quickSupportId: string;
  deletedId: string;
  /** A second partner (P2) with its own client and org D. */
  other: IntegrationTestClient;
  orgD: string;
  suffix: string;
}

async function seedBoard(): Promise<Board> {
  const app = buildApp();
  const client = await createIntegrationTestClient(app, { scope: 'partner' });
  const partnerId = client.env.partner.id;
  const suffix = randomUUID().slice(0, 8);

  const orgB = await createOrganization({ partnerId, type: 'internal', status: 'trial', name: `Board internal ${suffix}` });
  const orgC = await createOrganization({ partnerId, name: `Board bare ${suffix}` });
  const deleted = await createOrganization({ partnerId, name: `Board deleted ${suffix}`, deletedAt: new Date() });
  // createOrganization's option type stops at customer/internal; the hidden
  // per-partner support org goes in through the privileged test handle, like
  // every other db-utils fixture (RLS-bypassing scaffolding).
  const [quickSupport] = await getTestDb()
    .insert(organizations)
    .values({ partnerId, name: `Quick Support ${suffix}`, slug: `quick-support-${suffix}`, type: 'quick_support', currencyCode: 'USD' })
    .returning({ id: organizations.id });

  const other = await createIntegrationTestClient(app, { scope: 'partner' });

  return {
    app,
    client,
    partnerId,
    orgA: client.env.organization.id,
    orgB: orgB.id,
    orgC: orgC.id,
    quickSupportId: quickSupport!.id,
    deletedId: deleted.id,
    other,
    orgD: other.env.organization.id,
    suffix,
  };
}

function readinessPath(orgIds: string[], partnerId?: string): string {
  const query = `orgIds=${orgIds.join(',')}` + (partnerId ? `&partnerId=${partnerId}` : '');
  return `/orgs/account-readiness?${query}`;
}

/** An org-owned policy assigned at organization level, in its own transaction. */
async function seedOrgPolicy(orgId: string, name: string, status: 'active' | 'inactive'): Promise<string> {
  return withSystemDbAccessContext(async () => {
    const [policy] = await db
      .insert(configurationPolicies)
      .values({ orgId, partnerId: null, name, status })
      .returning({ id: configurationPolicies.id });
    await db.insert(configPolicyAssignments).values({ configPolicyId: policy!.id, level: 'organization', targetId: orgId });
    return policy!.id;
  });
}

/** An active org-owned policy assigned at SITE level only (a fresh site of the org). */
async function seedSitePolicy(orgId: string, name: string): Promise<void> {
  const site = await createSite({ orgId, name: `${name} site` });
  await withSystemDbAccessContext(async () => {
    const [policy] = await db
      .insert(configurationPolicies)
      .values({ orgId, partnerId: null, name, status: 'active' })
      .returning({ id: configurationPolicies.id });
    await db.insert(configPolicyAssignments).values({ configPolicyId: policy!.id, level: 'site', targetId: site.id });
  });
}

const ZERO_TICKETS = { open: 0, awaitingCustomer: 0, slaBreached: 0 };
const ALL_CAPABILITIES = {
  sites: true,
  devices: true,
  policies: true,
  contacts: true,
  portalUsers: true,
  invoices: true,
  tickets: true,
  // W03 (#5724): the default partner client carries connected_apps:read,
  // contracts:read and backup:read, so all three sections are on.
  integrations: true,
  contracts: true,
  backup: true,
};
// W03 per-org fields when every section is on and the partner has no
// connectors, contracts or backup configs seeded: empty badges, zero
// contracts, backup not applicable.
const NO_EXTRAS = { integrations: [] as unknown[], activeContracts: 0, backupApplicable: false, backupConfigured: false };

describe('GET /orgs/account-readiness', () => {
  runDb('computes every W02 signal for a partner token through the composed app', async () => {
    const board = await seedBoard();
    const { client, partnerId, orgA, orgB, orgC, suffix } = board;
    const site = client.env.site;
    const now = Date.now();
    const daysAgo = (n: number) => new Date(now - n * 86_400_000);

    await getTestDb()
      .update(organizations)
      .set({ billingAddressLine1: '1 Main St', billingAddressCity: 'Springfield', billingAddressCountry: 'US' })
      .where(eq(organizations.id, orgA));

    // Seeds go through breeze_app's FORCE-RLS tables, so they run under system
    // scope on the app handle (same as orgSummary.integration.test.ts).
    const onlineDevice = await withSystemDbAccessContext(async () => {
      const [online] = await db
        .insert(devices)
        .values({
          orgId: orgA,
          siteId: site.id,
          agentId: `ar-online-${suffix}`,
          hostname: 'online-01',
          status: 'online',
          osType: 'linux',
          osVersion: '22.04',
          architecture: 'x86_64',
          agentVersion: '0.113.0',
          lastSeenAt: new Date('2026-08-01T00:00:00.000Z'),
        })
        .returning({ lastSeenAt: devices.lastSeenAt });
      await db.insert(devices).values([
        {
          orgId: orgA,
          siteId: site.id,
          agentId: `ar-offline-${suffix}`,
          hostname: 'offline-01',
          status: 'offline',
          osType: 'linux',
          osVersion: '22.04',
          architecture: 'x86_64',
          agentVersion: '0.113.0',
          lastSeenAt: null,
        },
        // Removed device with the FRESHEST check-in: must count for nothing.
        {
          orgId: orgA,
          siteId: site.id,
          agentId: `ar-gone-${suffix}`,
          hostname: 'gone-01',
          status: 'decommissioned',
          osType: 'linux',
          osVersion: '22.04',
          architecture: 'x86_64',
          agentVersion: '0.113.0',
          lastSeenAt: new Date(now),
        },
      ]);

      await db.insert(contacts).values([
        { orgId: orgA, name: `Ada Primary ${suffix}`, email: `ada-${suffix}@example.com`, phone: '555-0100', isPrimary: true, siteId: null },
        { orgId: orgA, name: `Bill Billing ${suffix}`, email: `bill-${suffix}@example.com`, roles: ['billing'] },
        // A site-level primary is never the org's primary contact.
        { orgId: orgA, siteId: site.id, name: `Site Primary ${suffix}`, email: `site-${suffix}@example.com`, isPrimary: true },
        // Org B: a primary with a name only — reachable by nothing; no billing role anywhere.
        { orgId: orgB, name: `Nameless Reach ${suffix}`, isPrimary: true, siteId: null },
        { orgId: orgB, name: `Tech ${suffix}`, email: `tech-${suffix}@example.com`, roles: ['technical'] },
      ]);

      await db.insert(portalUsers).values([
        { orgId: orgA, email: `stale-${suffix}@example.com`, status: 'active', invitedAt: daysAgo(10), lastLoginAt: null }, // counts
        { orgId: orgA, email: `fresh-${suffix}@example.com`, status: 'active', invitedAt: daysAgo(2), lastLoginAt: null }, // too recent
        { orgId: orgA, email: `signed-${suffix}@example.com`, status: 'active', invitedAt: daysAgo(10), lastLoginAt: daysAgo(1) }, // accepted
        { orgId: orgA, email: `off-${suffix}@example.com`, status: 'disabled', invitedAt: daysAgo(10), lastLoginAt: null }, // disabled
        { orgId: orgB, email: `off-b-${suffix}@example.com`, status: 'disabled', invitedAt: daysAgo(10), lastLoginAt: null },
      ]);

      const ticket = (n: number, extra: Partial<typeof tickets.$inferInsert>) => ({
        orgId: orgA,
        partnerId,
        ticketNumber: `AR-${suffix}-${n}`,
        subject: `Board ticket ${n}`,
        source: 'manual' as const,
        ...extra,
      });
      await db.insert(tickets).values([
        ticket(1, { status: 'new' }),
        ticket(2, { status: 'pending', slaBreachedAt: daysAgo(1) }),
        ticket(3, { status: 'on_hold' }),
        ticket(4, { status: 'closed', slaBreachedAt: daysAgo(1) }), // closed: excluded, breach and all
        ticket(5, { status: 'open', deletedAt: daysAgo(1) }), // soft-deleted: excluded
      ]);

      const invoice = (status: (typeof invoices.$inferInsert)['status'], dueDate: string, orgId = orgA) => ({
        partnerId,
        orgId,
        currencyCode: 'USD',
        status,
        dueDate,
        total: '100.00',
        amountPaid: '0.00',
      });
      await db.insert(invoices).values([
        invoice('sent', '2020-01-01'), // overdue
        invoice('overdue', '2020-02-01'), // overdue
        invoice('partially_paid', '2099-01-01'), // outstanding, not yet due
        invoice('paid', '2020-01-01'), // terminal
        invoice('void', '2020-01-01'), // terminal
        invoice('draft', '2020-01-01'), // never issued
        invoice('draft', '2020-01-01', orgB),
      ]);
      return online!;
    });

    // Policies: A has an ACTIVE org-owned policy assigned at organization
    // level; B has an INACTIVE one assigned — which must not count. One
    // transaction per policy: the partner-export watermark triggers take a
    // shared partner lock on the first org-owned write and refuse the
    // shared -> exclusive upgrade a second org's policy write asks for inside
    // the same transaction (2026-07-22-partner-export-lock-upgrade-hardening).
    await seedOrgPolicy(orgA, `Board active ${suffix}`, 'active');
    await seedOrgPolicy(orgB, `Board inactive ${suffix}`, 'inactive');
    // Org C: an ACTIVE policy assigned only at SITE level. "Assigned" counts
    // org- and partner-level assignments alone, so C must stay unassigned.
    await seedSitePolicy(orgC, `Board site-only ${suffix}`);

    const res = await client.get(readinessPath([orgA, orgB, orgC]));
    expect(res.status, await res.clone().text()).toBe(200);
    const body = await res.json();

    expect(body.partnerId).toBe(partnerId);
    expect(body.serviceManagementMode).toBe('native');
    expect(body.capabilities).toEqual(ALL_CAPABILITIES);
    // W03: connectors is present (an array) whenever capabilities.integrations is on.
    expect(Array.isArray(body.connectors)).toBe(true);
    expect(body.orgs.map((org: { orgId: string }) => org.orgId)).toEqual([orgA, orgB, orgC]);

    const [a, b, c] = body.orgs;
    expect(a).toEqual({
      orgId: orgA,
      type: 'customer',
      status: 'active',
      setup: {
        sites: 1,
        devices: 2,
        lastSeenAt: new Date(onlineDevice.lastSeenAt!).toISOString(),
        policyAssigned: true,
        backupApplicable: NO_EXTRAS.backupApplicable,
        backupConfigured: NO_EXTRAS.backupConfigured,
      },
      account: {
        primaryContact: { name: `Ada Primary ${suffix}`, email: `ada-${suffix}@example.com`, phone: '555-0100', mobile: null },
        billingRoleContact: true,
        billingAddress: true,
        pendingInvitations: 1,
        overdueInvoices: 2,
        activeContracts: NO_EXTRAS.activeContracts,
      },
      tickets: { open: 3, awaitingCustomer: 1, slaBreached: 1 },
      integrations: NO_EXTRAS.integrations,
    });
    expect(b).toEqual({
      orgId: orgB,
      type: 'internal',
      status: 'trial',
      setup: { sites: 0, devices: 0, lastSeenAt: null, policyAssigned: false, backupApplicable: false, backupConfigured: false },
      account: {
        primaryContact: { name: `Nameless Reach ${suffix}`, email: null, phone: null, mobile: null },
        billingRoleContact: false,
        billingAddress: false,
        pendingInvitations: 0,
        overdueInvoices: 0,
        activeContracts: 0,
      },
      tickets: ZERO_TICKETS,
      integrations: [],
    });
    expect(c).toEqual({
      orgId: orgC,
      type: 'customer',
      status: 'active',
      // sites: 1 = the site carrying the site-level assignment; still unassigned.
      setup: { sites: 1, devices: 0, lastSeenAt: null, policyAssigned: false, backupApplicable: false, backupConfigured: false },
      account: { primaryContact: null, billingRoleContact: false, billingAddress: false, pendingInvitations: 0, overdueInvoices: 0, activeContracts: 0 },
      tickets: ZERO_TICKETS,
      integrations: [],
    });

    // The shape the spec ruled out is captured by orgRoutes' UUID guard —
    // the reason the path lives at /orgs/account-readiness.
    const shadowed = await client.get(`/orgs/organizations/account-readiness?orgIds=${orgA}`);
    expect(shadowed.status).toBe(404);
    expect(await shadowed.json()).toEqual({ error: 'Organization not found' });
  });

  runDb('a partner-level assignment of an ACTIVE policy marks every org of that partner only', async () => {
    const board = await seedBoard();
    const { client, other, partnerId, orgA, orgB, orgD, suffix } = board;

    const assigned = async () => {
      const res = await client.get(readinessPath([orgA, orgB]));
      expect(res.status).toBe(200);
      return (await res.json()).orgs.map((org: { setup: { policyAssigned: boolean } }) => org.setup.policyAssigned);
    };

    expect(await assigned()).toEqual([false, false]);

    // An inactive partner-wide policy assigned at partner level counts for nothing.
    const inactiveId = await withSystemDbAccessContext(async () => {
      const [policy] = await db
        .insert(configurationPolicies)
        .values({ orgId: null, partnerId, name: `Board partner-wide inactive ${suffix}`, status: 'inactive' })
        .returning({ id: configurationPolicies.id });
      await db.insert(configPolicyAssignments).values({ configPolicyId: policy!.id, level: 'partner', targetId: partnerId });
      return policy!.id;
    });
    expect(await assigned()).toEqual([false, false]);

    // Activating it flips every org of the partner at once.
    await withSystemDbAccessContext(() =>
      db.update(configurationPolicies).set({ status: 'active' }).where(eq(configurationPolicies.id, inactiveId)),
    );
    expect(await assigned()).toEqual([true, true]);

    // The other partner's org is untouched by this partner's rule.
    const otherRes = await other.get(readinessPath([orgD]));
    expect((await otherRes.json()).orgs[0].setup.policyAssigned).toBe(false);
  });

  runDb('drops unknown, deleted, quick_support and foreign-partner ids silently; a selected-access colleague loses the sibling too', async () => {
    const board = await seedBoard();
    const { app, client, other, partnerId, orgA, orgB, orgC, orgD, quickSupportId, deletedId, suffix } = board;
    const unknownId = randomUUID();

    const res = await client.get(readinessPath([orgD, unknownId, deletedId, quickSupportId, orgC, orgA]));
    expect(res.status).toBe(200);
    // Request order is kept; everything that did not resolve is simply absent.
    expect((await res.json()).orgs.map((org: { orgId: string }) => org.orgId)).toEqual([orgC, orgA]);

    // A colleague at the same partner whose org_access is 'selected' = {A}.
    const restricted = await createUser({ partnerId, email: `restricted-${suffix}@example.com` });
    const role = await createRole({ scope: 'partner', partnerId });
    await grantRolePermissions(role.id, [{ resource: '*', action: '*' }]);
    await assignUserToPartner(restricted.id, partnerId, role.id, 'selected');
    await getTestDb()
      .update(partnerUsers)
      .set({ orgIds: [orgA] })
      .where(and(eq(partnerUsers.userId, restricted.id), eq(partnerUsers.partnerId, partnerId)));
    const restrictedToken = await createAccessToken({
      sub: restricted.id,
      email: restricted.email,
      roleId: role.id,
      orgId: null,
      partnerId,
      scope: 'partner',
      mfa: false,
      aep: 1,
      mep: 1,
      sid: randomUUID(),
    } satisfies Omit<TokenPayload, 'type'>);

    const restrictedRes = await app.request(readinessPath([orgA, orgB, orgC]), {
      headers: { Authorization: `Bearer ${restrictedToken}` },
    });
    expect(restrictedRes.status).toBe(200); // never 403 for a dropped sibling
    expect((await restrictedRes.json()).orgs.map((org: { orgId: string }) => org.orgId)).toEqual([orgA]);

    // The foreign partner's own token sees only its own org, whatever it asks for.
    const otherRes = await other.get(readinessPath([orgA, orgD]));
    expect(otherRes.status).toBe(200);
    expect((await otherRes.json()).orgs.map((org: { orgId: string }) => org.orgId)).toEqual([orgD]);
  });

  // #5733 — a scope='system' token driven through the REAL middleware chain
  // (authMiddleware -> requireScope('partner','system') -> requirePermission).
  // Login mints system scope only for a membership-less platform admin
  // (routes/auth/helpers.ts resolveCurrentUserTokenContext), and before #5733
  // getUserPermissions resolved a role solely from a partner_users /
  // organization_users row — so such a token answered 403 "No permissions
  // found" on EVERY requirePermission route and the system branches in this
  // handler were unreachable in production. These two cases pin the contract
  // against real Postgres: a live platform admin gets through, a
  // non-platform-admin system token does not.

  /** Mints a system-scope access token for a membership-less user. */
  async function systemScopeGet(
    app: Hono,
    partnerId: string,
    options: { isPlatformAdmin: boolean },
  ): Promise<(path: string) => Promise<Response>> {
    // users.partner_id is the row's owning partner; what makes this token
    // SYSTEM scope is the absence of any partner_users / organization_users
    // membership, exactly as login produces it.
    const user = await createUser({ partnerId, orgId: null, email: `sysadmin-${randomUUID()}@example.com` });
    await getTestDb()
      .update(users)
      .set({ isPlatformAdmin: options.isPlatformAdmin })
      .where(eq(users.id, user.id));

    const payload: Omit<TokenPayload, 'type'> = {
      sub: user.id,
      email: user.email,
      roleId: null,
      orgId: null,
      partnerId: null,
      scope: 'system',
      mfa: false,
      aep: 1,
      mep: 1,
      sid: randomUUID(),
    };
    const token = await createAccessToken(payload);
    return async (path: string) => app.request(path, { headers: { Authorization: `Bearer ${token}` } });
  }

  runDb('a live platform admin on a system-scope token reads the board for the named partner', async () => {
    const board = await seedBoard();
    const { app, partnerId, orgA, orgB } = board;
    const get = await systemScopeGet(app, partnerId, { isPlatformAdmin: true });

    const res = await get(readinessPath([orgA, orgB], partnerId));

    expect(res.status).toBe(200);
    const body = await res.json();
    // The wildcard platform-admin grant lights every section up.
    expect(body.capabilities).toEqual(ALL_CAPABILITIES);
    expect(body.orgs.map((org: { orgId: string }) => org.orgId).sort()).toEqual([orgA, orgB].sort());
  });

  // This case pins the OUTER layer only, and passes on a base without #5733 —
  // that is the honest reading, not a discrimination failure to paper over.
  // authMiddleware's SR2-02 live-binding check (middleware/auth.ts, "system
  // scope is only legitimate for a current platform admin") rejects the token
  // before requirePermission runs, so getUserPermissions' own null branch is
  // unreachable through the real chain except in a same-request demotion race.
  // That inner branch is pinned where it CAN be driven: services/permissions.test.ts
  // ("returns null (→ 403) for a system token whose user is NOT a platform
  // admin"). Kept here so a future widening of the fix — one that granted the
  // wildcard set off the token's scope claim alone — fails at BOTH layers.
  runDb('a system-scope token whose user is NOT a platform admin is rejected before the handler', async () => {
    const board = await seedBoard();
    const { app, partnerId, orgA } = board;
    const get = await systemScopeGet(app, partnerId, { isPlatformAdmin: false });

    const res = await get(readinessPath([orgA], partnerId));

    expect(res.status).toBe(403);
  });

  runDb('withholds tickets and invoices when the partner is not in native service-management mode', async () => {
    const board = await seedBoard();
    const { client, partnerId, orgA } = board;
    // 'off' rather than 'external': partners_service_management_connection_chk
    // requires a PSA connection id whenever the mode is 'external'.
    await getTestDb().update(partners).set({ serviceManagementMode: 'off' }).where(eq(partners.id, partnerId));

    const res = await client.get(readinessPath([orgA]));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.serviceManagementMode).toBe('off');
    // W03: contracts is also native-only.
    expect(body.capabilities).toEqual({ ...ALL_CAPABILITIES, invoices: false, tickets: false, contracts: false });
    expect(body.orgs[0]).not.toHaveProperty('tickets');
    expect(body.orgs[0].account).not.toHaveProperty('overdueInvoices');
    expect(body.orgs[0].account).toHaveProperty('pendingInvitations');
  });

  runDb('a caller with only organizations:read gets policies and contacts, nothing else', async () => {
    const app = buildApp();
    const client = await createIntegrationTestClient(app, { scope: 'partner', rolePermissions: [PERMISSIONS.ORGS_READ] });
    const orgId = client.env.organization.id;

    const res = await client.get(readinessPath([orgId]));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.capabilities).toEqual({
      sites: false,
      devices: false,
      policies: true,
      contacts: true,
      portalUsers: false,
      invoices: false,
      tickets: false,
      integrations: false,
      contracts: false,
      backup: false,
    });
    expect(body.orgs[0]).toEqual({
      orgId,
      type: 'customer',
      status: 'active',
      setup: { policyAssigned: false },
      account: { primaryContact: null, billingRoleContact: false, billingAddress: false },
    });
  });
});
