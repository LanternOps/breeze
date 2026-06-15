import { describe, it, expect, beforeAll } from 'vitest';
import { db, withSystemDbAccessContext } from '../db';
import { partners, organizations, sites, devices, users, organizationUsers, roles } from '../db/schema';
// Note: sites table has no slug column — only orgId, name, address, timezone, contact, settings
import { countContractDevices, countContractSeats } from './contractQuantities';

describe('contract quantity resolvers', () => {
  let orgId = '';
  let siteAId = '';
  const sfx = Math.random().toString(36).slice(2, 8);

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) return;
    await withSystemDbAccessContext(async () => {
      const [p] = await db.insert(partners).values({ name: `QP ${sfx}`, slug: `qp-${sfx}`, type: 'msp', plan: 'pro', status: 'active' }).returning({ id: partners.id });
      const [o] = await db.insert(organizations).values({ partnerId: p!.id, name: 'QOrg', slug: `qo-${sfx}` }).returning({ id: organizations.id });
      orgId = o!.id;
      const [sA, sB] = await db.insert(sites).values([
        { orgId, name: `A-${sfx}` }, { orgId, name: `B-${sfx}` }
      ]).returning({ id: sites.id });
      siteAId = sA!.id;
      // devices requires agentId (unique), osType, osVersion, architecture, agentVersion
      await db.insert(devices).values([
        { orgId, siteId: sA!.id, agentId: `d1-${sfx}`, hostname: 'd1', status: 'online', osType: 'linux', osVersion: '22.04', architecture: 'x86_64', agentVersion: '1.0.0' },
        { orgId, siteId: sA!.id, agentId: `d2-${sfx}`, hostname: 'd2', status: 'offline', osType: 'linux', osVersion: '22.04', architecture: 'x86_64', agentVersion: '1.0.0' },
        { orgId, siteId: sB!.id, agentId: `d3-${sfx}`, hostname: 'd3', status: 'online', osType: 'linux', osVersion: '22.04', architecture: 'x86_64', agentVersion: '1.0.0' },
        { orgId, siteId: sB!.id, agentId: `d4-${sfx}`, hostname: 'd4', status: 'decommissioned', osType: 'linux', osVersion: '22.04', architecture: 'x86_64', agentVersion: '1.0.0' } // excluded
      ]);
      // organizationUsers requires roleId — seed a minimal org-scope role
      const [r] = await db.insert(roles).values({ name: `QRole ${sfx}`, scope: 'organization', partnerId: p!.id, orgId }).returning({ id: roles.id });
      const roleId = r!.id;
      const [u1, u2, u3] = await db.insert(users).values([
        { partnerId: p!.id, orgId, email: `u1-${sfx}@x.io`, name: 'U1', status: 'active' },
        { partnerId: p!.id, orgId, email: `u2-${sfx}@x.io`, name: 'U2', status: 'active' },
        { partnerId: p!.id, orgId, email: `u3-${sfx}@x.io`, name: 'U3', status: 'disabled' } // excluded
      ]).returning({ id: users.id });
      await db.insert(organizationUsers).values([
        { orgId, userId: u1!.id, roleId }, { orgId, userId: u2!.id, roleId }, { orgId, userId: u3!.id, roleId }
      ]);
    });
  });

  it.runIf(!!process.env.DATABASE_URL)('counts billable devices org-wide (excludes decommissioned)', async () => {
    expect(await withSystemDbAccessContext(() => countContractDevices(orgId, null))).toBe(3);
  });
  it.runIf(!!process.env.DATABASE_URL)('counts billable devices filtered by site', async () => {
    expect(await withSystemDbAccessContext(() => countContractDevices(orgId, siteAId))).toBe(2);
  });
  it.runIf(!!process.env.DATABASE_URL)('counts active seats (excludes disabled)', async () => {
    expect(await withSystemDbAccessContext(() => countContractSeats(orgId))).toBe(2);
  });
});
