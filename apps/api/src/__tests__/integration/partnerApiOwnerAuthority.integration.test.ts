/**
 * Partner service principal keys on the Partner API are bounded by their
 * owner's LIVE authority, end to end against real Postgres (FORCE RLS as
 * `breeze_app`) and real Redis, through the real partnerApiRoutes stack
 * (audit -> partnerApiAuthMiddleware -> route).
 *
 * The owner is `partner_service_principals.created_by`. Every request
 * re-checks that the owner is still an active partner member with all-org
 * access whose current role can still delegate every Partner API scope the
 * principal carries (or, for a principal a platform admin created, that the
 * owner is still a platform admin). The same rule already applies on MCP
 * (mcpPartnerServicePrincipal.integration.test.ts).
 */
import './setup';

import { Hono } from 'hono';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

import type { Database } from '../../db';
import { partnerServicePrincipalKeys, partnerServicePrincipals, partnerUsers, rolePermissions, users } from '../../db/schema';
import { partnerApiRoutes } from '../../routes/partnerApi';
import { clearPermissionCache } from '../../services/permissions';
import { issuePartnerServicePrincipalKey } from '../../services/partnerServicePrincipalKeys';
import type { PartnerServicePrincipalScope } from '../../services/partnerServicePrincipalScopes';
import {
  assignUserToPartner,
  createOrganization,
  createPartner,
  createRole,
  createUser,
  grantRolePermissions,
  userEpochs,
} from './db-utils';
import { getTestDb } from './setup';

vi.mock('../../config/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config/env')>();
  return {
    ...actual,
    PARTNER_API_CURSOR_SIGNING_KEY: Buffer.from('0123456789abcdef0123456789abcdef', 'utf8'),
  };
});

const runDb = it.runIf(!!process.env.DATABASE_URL);

const WRITE_SCOPES: PartnerServicePrincipalScope[] = [
  'organizations:read',
  'organizations:write',
  'tickets:read',
  'tickets:write',
];

// A read-only partner role: it still backs organizations:read and
// tickets:read, but neither organizations:write nor tickets:write.
const READ_ONLY_ROLE_PERMS = [
  { resource: 'organizations', action: 'read' },
  { resource: 'devices', action: 'read' },
  { resource: 'tickets', action: 'read' },
  { resource: 'alerts', action: 'read' },
];

function app(): Hono {
  const hono = new Hono();
  hono.route('/', partnerApiRoutes);
  return hono;
}

async function partnerAdmin(partnerId: string, orgAccess: 'all' | 'selected' | 'none' = 'all') {
  const user = await createUser({ partnerId, email: `owner-${randomUUID()}@example.test` });
  const role = await createRole({ scope: 'partner', partnerId, name: `Owner ${randomUUID().slice(0, 8)}` });
  await grantRolePermissions(role.id, [{ resource: '*', action: '*' }]);
  const membership = await assignUserToPartner(user.id, partnerId, role.id, orgAccess);
  return { user, role, membership };
}

async function principalWithKey(opts: {
  partnerId: string;
  ownerId: string;
  scopes: readonly PartnerServicePrincipalScope[];
  /** Who issues the key; defaults to the owner. */
  issuerId?: string;
}): Promise<{ principalId: string; rawKey: string }> {
  const admin = getTestDb();
  const [principal] = await admin.insert(partnerServicePrincipals).values({
    partnerId: opts.partnerId,
    name: `Owner authority ${randomUUID()}`,
    scopes: [...opts.scopes],
    createdBy: opts.ownerId,
    updatedBy: opts.ownerId,
  }).returning();
  if (!principal) throw new Error('service principal seed failed');
  if (opts.issuerId && opts.issuerId !== opts.ownerId) {
    // Only the owner can issue keys today; a key another admin issued before
    // that rule existed is seeded directly, bound to the owner's epochs.
    const rawKey = `brz_sp_${randomBytes(32).toString('base64url')}`;
    const ownerEpochs = await userEpochs(opts.ownerId);
    await admin.insert(partnerServicePrincipalKeys).values({
      partnerId: opts.partnerId,
      partnerServicePrincipalId: principal.id,
      name: 'Legacy key',
      keyHash: createHash('sha256').update(rawKey).digest('hex'),
      keyPrefix: rawKey.slice(0, 18),
      rateLimit: 10000,
      createdBy: opts.issuerId,
      ownerCredentialEpoch: ownerEpochs.credentialEpoch,
      ownerMfaEpoch: ownerEpochs.mfaEpoch,
    });
    return { principalId: principal.id, rawKey };
  }
  const { rawKey } = await issuePartnerServicePrincipalKey(admin as unknown as Database, {
    partnerServicePrincipalId: principal.id,
    partnerId: opts.partnerId,
    name: 'Owner authority key',
    actorId: opts.ownerId,
    actorSessionEpochs: await userEpochs(opts.ownerId),
  });
  return { principalId: principal.id, rawKey };
}

async function fixture(scopes: readonly PartnerServicePrincipalScope[] = WRITE_SCOPES) {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const owner = await partnerAdmin(partner.id);
  const key = await principalWithKey({ partnerId: partner.id, ownerId: owner.user.id, scopes });
  return { partner, org, owner, key };
}

function headers(rawKey: string): Record<string, string> {
  return { 'X-API-Key': rawKey, 'Content-Type': 'application/json' };
}

async function listOrganizations(rawKey: string): Promise<number> {
  return (await app().request('/organizations', { headers: headers(rawKey) })).status;
}

async function createTicket(rawKey: string, orgId: string): Promise<number> {
  return (await app().request('/tickets', {
    method: 'POST',
    headers: { ...headers(rawKey), 'X-Idempotency-Key': `t-${randomUUID()}` },
    body: JSON.stringify({ orgId, subject: 'Opened by an integration', description: 'Printer offline', priority: 'normal' }),
  })).status;
}

async function createOrg(rawKey: string): Promise<number> {
  const suffix = randomUUID().slice(0, 8);
  return (await app().request('/organizations', {
    method: 'POST',
    headers: headers(rawKey),
    body: JSON.stringify({ name: `Provisioned ${suffix}`, slug: `provisioned-${suffix}` }),
  })).status;
}

async function reduceToReadOnly(roleId: string): Promise<void> {
  await getTestDb().delete(rolePermissions).where(eq(rolePermissions.roleId, roleId));
  await grantRolePermissions(roleId, READ_ONLY_ROLE_PERMS);
}

describe('Partner API key bounded by its owner', () => {
  runDb('works while the owner is a partner-wide admin who can delegate every scope', async () => {
    const p = await fixture();
    expect(await listOrganizations(p.key.rawKey)).toBe(200);
    expect(await createTicket(p.key.rawKey, p.org.id)).toBe(201);
    expect(await createOrg(p.key.rawKey)).toBe(201);
  }, 30_000);

  runDb('stops when the owner is reduced to a read-only role', async () => {
    const p = await fixture();
    expect(await listOrganizations(p.key.rawKey)).toBe(200);
    await reduceToReadOnly(p.owner.role.id);
    await clearPermissionCache(p.owner.user.id);
    expect(await createTicket(p.key.rawKey, p.org.id)).toBe(401);
    expect(await createOrg(p.key.rawKey)).toBe(401);
    // Denied outright, never narrowed to the scopes the owner still backs.
    expect(await listOrganizations(p.key.rawKey)).toBe(401);
  }, 30_000);

  runDb('a read-only principal of the same reduced owner keeps working', async () => {
    const p = await fixture();
    const readOnly = await principalWithKey({
      partnerId: p.partner.id,
      ownerId: p.owner.user.id,
      scopes: ['organizations:read', 'tickets:read'],
    });
    await reduceToReadOnly(p.owner.role.id);
    await clearPermissionCache(p.owner.user.id);
    expect(await listOrganizations(readOnly.rawKey)).toBe(200);
    expect(await listOrganizations(p.key.rawKey)).toBe(401);
  }, 30_000);

  runDb('stops when the owner is cut to no organization access', async () => {
    const p = await fixture();
    expect(await listOrganizations(p.key.rawKey)).toBe(200);
    await getTestDb().update(partnerUsers).set({ orgAccess: 'none', orgIds: [] })
      .where(eq(partnerUsers.id, p.owner.membership.id));
    await clearPermissionCache(p.owner.user.id);
    expect(await createTicket(p.key.rawKey, p.org.id)).toBe(401);
    expect(await createOrg(p.key.rawKey)).toBe(401);
    expect(await listOrganizations(p.key.rawKey)).toBe(401);
  }, 30_000);

  runDb('stops when the owner is narrowed to selected organizations', async () => {
    const p = await fixture();
    await getTestDb().update(partnerUsers).set({ orgAccess: 'selected', orgIds: [p.org.id] })
      .where(eq(partnerUsers.id, p.owner.membership.id));
    await clearPermissionCache(p.owner.user.id);
    expect(await listOrganizations(p.key.rawKey)).toBe(401);
    expect(await createTicket(p.key.rawKey, p.org.id)).toBe(401);
  }, 30_000);

  runDb('stops when the owner is removed from the partner', async () => {
    const p = await fixture();
    await getTestDb().delete(partnerUsers).where(eq(partnerUsers.id, p.owner.membership.id));
    await clearPermissionCache(p.owner.user.id);
    expect(await listOrganizations(p.key.rawKey)).toBe(401);
    expect(await createOrg(p.key.rawKey)).toBe(401);
  }, 30_000);

  runDb('sees a demotion on the next request even when the permission cache was never invalidated', async () => {
    const p = await fixture();
    expect(await createTicket(p.key.rawKey, p.org.id)).toBe(201);
    // No clearPermissionCache: models a lost cross-process invalidation.
    await reduceToReadOnly(p.owner.role.id);
    expect(await createTicket(p.key.rawKey, p.org.id)).toBe(401);
  }, 30_000);

  runDb('refuses a principal whose owner was never a member of the partner', async () => {
    const partner = await createPartner();
    await createOrganization({ partnerId: partner.id });
    const outsider = await createUser({ partnerId: partner.id, email: `outsider-${randomUUID()}@example.test` });
    const key = await principalWithKey({ partnerId: partner.id, ownerId: outsider.id, scopes: ['organizations:read'] });
    expect(await listOrganizations(key.rawKey)).toBe(401);
  }, 30_000);

  runDb('accepts a principal a platform admin owns only while they remain a platform admin', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const platformAdmin = await createUser({ partnerId: partner.id, email: `platform-${randomUUID()}@example.test` });
    await getTestDb().update(users).set({ isPlatformAdmin: true }).where(eq(users.id, platformAdmin.id));
    const key = await principalWithKey({ partnerId: partner.id, ownerId: platformAdmin.id, scopes: WRITE_SCOPES });
    expect(await listOrganizations(key.rawKey)).toBe(200);
    expect(await createTicket(key.rawKey, org.id)).toBe(201);

    await getTestDb().update(users).set({ isPlatformAdmin: false }).where(eq(users.id, platformAdmin.id));
    expect(await listOrganizations(key.rawKey)).toBe(401);
    expect(await createTicket(key.rawKey, org.id)).toBe(401);
  }, 30_000);

  runDb('a platform admin who is also a partner member is bounded by that membership', async () => {
    const p = await fixture();
    await getTestDb().update(users).set({ isPlatformAdmin: true }).where(eq(users.id, p.owner.user.id));
    expect(await createTicket(p.key.rawKey, p.org.id)).toBe(201);
    await reduceToReadOnly(p.owner.role.id);
    await clearPermissionCache(p.owner.user.id);
    expect(await createTicket(p.key.rawKey, p.org.id)).toBe(401);
    expect(await listOrganizations(p.key.rawKey)).toBe(401);
  }, 30_000);

  runDb('a key another admin issued keeps working, and is bounded by the owner, not the issuer', async () => {
    const p = await fixture();
    const otherAdmin = await partnerAdmin(p.partner.id);
    const issuedByOther = await principalWithKey({
      partnerId: p.partner.id,
      ownerId: p.owner.user.id,
      issuerId: otherAdmin.user.id,
      scopes: WRITE_SCOPES,
    });
    expect(await createTicket(issuedByOther.rawKey, p.org.id)).toBe(201);
    await reduceToReadOnly(p.owner.role.id);
    await clearPermissionCache(p.owner.user.id);
    expect(await createTicket(issuedByOther.rawKey, p.org.id)).toBe(401);
  }, 30_000);
});
