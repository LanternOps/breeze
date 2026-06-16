/**
 * Real-driver service-layer tests for contract quantity resolvers.
 *
 * Runs under vitest.integration.config.ts — the service-under-test connects
 * through the `db` proxy, which inside a `withSystemDbAccessContext(...)` call
 * connects as the unprivileged `breeze_app` role (rolbypassrls=f via
 * system-scope short-circuit). Both the counting logic AND the decommissioned/
 * disabled exclusion predicates are exercised against a real Postgres.
 *
 * Why NO beforeAll fixture: integration/setup.ts runs cleanupDatabase() in a
 * beforeEach that TRUNCATE ... CASCADEs partners/organizations before every
 * test, wiping any beforeAll-seeded rows and making assertions vacuous. Each
 * test calls seedFixture() inline — matching every sibling *.integration.test.ts.
 *
 * Fixture topology per test:
 *   partner → org → siteA + siteB
 *   devices: d1 (online, siteA), d2 (offline, siteA), d3 (online, siteB),
 *            d4 (decommissioned, siteB — excluded from counts)
 *   users: u1 (active), u2 (active), u3 (disabled — excluded from counts)
 *   organization_users: u1, u2, u3 all linked (3 rows; disabled filter is on
 *                       users.status, not presence in org_users)
 */
import './setup';
import { describe, it, expect } from 'vitest';
import { db, withSystemDbAccessContext } from '../../db';
import { partners, organizations, sites, devices, users, organizationUsers, roles } from '../../db/schema';
// Note: sites table has no slug column — only orgId, name, address, timezone, contact, settings
import { countContractDevices, countContractSeats } from '../../services/contractQuantities';

interface Fixture {
  orgId: string;
  siteAId: string;
}

async function seedFixture(): Promise<Fixture> {
  return withSystemDbAccessContext(async () => {
    const sfx = Math.random().toString(36).slice(2, 8);

    const [p] = await db
      .insert(partners)
      .values({ name: `QP ${sfx}`, slug: `qp-${sfx}`, type: 'msp', plan: 'pro', status: 'active' })
      .returning({ id: partners.id });
    const [o] = await db
      .insert(organizations)
      .values({ partnerId: p!.id, name: 'QOrg', slug: `qo-${sfx}` })
      .returning({ id: organizations.id });
    const orgId = o!.id;

    const [sA, sB] = await db
      .insert(sites)
      .values([
        { orgId, name: `A-${sfx}` },
        { orgId, name: `B-${sfx}` },
      ])
      .returning({ id: sites.id });
    const siteAId = sA!.id;

    // devices requires agentId (unique), osType, osVersion, architecture, agentVersion
    await db.insert(devices).values([
      { orgId, siteId: sA!.id, agentId: `d1-${sfx}`, hostname: 'd1', status: 'online',          osType: 'linux', osVersion: '22.04', architecture: 'x86_64', agentVersion: '1.0.0' },
      { orgId, siteId: sA!.id, agentId: `d2-${sfx}`, hostname: 'd2', status: 'offline',         osType: 'linux', osVersion: '22.04', architecture: 'x86_64', agentVersion: '1.0.0' },
      { orgId, siteId: sB!.id, agentId: `d3-${sfx}`, hostname: 'd3', status: 'online',          osType: 'linux', osVersion: '22.04', architecture: 'x86_64', agentVersion: '1.0.0' },
      { orgId, siteId: sB!.id, agentId: `d4-${sfx}`, hostname: 'd4', status: 'decommissioned',  osType: 'linux', osVersion: '22.04', architecture: 'x86_64', agentVersion: '1.0.0' }, // excluded
    ]);

    // organizationUsers requires roleId — seed a minimal org-scope role
    const [r] = await db
      .insert(roles)
      .values({ name: `QRole ${sfx}`, scope: 'organization', partnerId: p!.id, orgId })
      .returning({ id: roles.id });
    const roleId = r!.id;

    const [u1, u2, u3] = await db
      .insert(users)
      .values([
        { partnerId: p!.id, orgId, email: `u1-${sfx}@x.io`, name: 'U1', status: 'active' },
        { partnerId: p!.id, orgId, email: `u2-${sfx}@x.io`, name: 'U2', status: 'active' },
        { partnerId: p!.id, orgId, email: `u3-${sfx}@x.io`, name: 'U3', status: 'disabled' }, // excluded
      ])
      .returning({ id: users.id });

    await db.insert(organizationUsers).values([
      { orgId, userId: u1!.id, roleId },
      { orgId, userId: u2!.id, roleId },
      { orgId, userId: u3!.id, roleId },
    ]);

    return { orgId, siteAId };
  });
}

const runDb = it.runIf(!!process.env.DATABASE_URL);

describe('contract quantity resolvers (breeze_app, real DB)', () => {
  runDb('counts billable devices org-wide (excludes decommissioned)', async () => {
    const { orgId } = await seedFixture();
    expect(await withSystemDbAccessContext(() => countContractDevices(orgId, null))).toBe(3);
  });

  runDb('counts billable devices filtered by site', async () => {
    const { orgId, siteAId } = await seedFixture();
    expect(await withSystemDbAccessContext(() => countContractDevices(orgId, siteAId))).toBe(2);
  });

  runDb('counts active seats (excludes disabled)', async () => {
    const { orgId } = await seedFixture();
    expect(await withSystemDbAccessContext(() => countContractSeats(orgId))).toBe(2);
  });
});
