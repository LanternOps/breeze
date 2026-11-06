/**
 * Shared fixtures for the #11225 catch-around-a-query row suites
 * (caughtQueryServiceRows / WorkerRows / KeptFailClosed).
 */
import { randomUUID } from 'node:crypto';
import { eq, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { expect } from 'vitest';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { devices, sites } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';
import { getTestDb } from './setup';

export async function tenant() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const [device] = await getTestDb().insert(devices).values({
    orgId: org.id,
    siteId: site.id,
    agentId: `rows-${randomUUID()}`,
    hostname: `rows-${randomUUID()}`,
    osType: 'linux',
    osVersion: 'test',
    architecture: 'amd64',
    agentVersion: '1.0.0-test',
    status: 'online',
    lastSeenAt: new Date(),
    enrolledAt: new Date(),
  }).returning();
  return { partnerId: partner.id, orgId: org.id, siteId: site.id, deviceId: device!.id };
}
export type Tenant = Awaited<ReturnType<typeof tenant>>;

export const orgContext = (t: Pick<Tenant, 'orgId' | 'partnerId'>): DbAccessContext => ({
  scope: 'organization',
  orgId: t.orgId,
  accessibleOrgIds: [t.orgId],
  accessiblePartnerIds: [],
  currentPartnerId: t.partnerId,
});

/** Assert a site rename written beside the code under test committed. */
async function expectNameCommitted(siteId: string, name: string) {
  const [site] = await getTestDb().select({ name: sites.name }).from(sites).where(eq(sites.id, siteId));
  expect(site!.name).toBe(name);
}

/** Run `fn` in a held org context, then write beside it and prove that write committed. */
export async function inHeldContext<T>(t: Tenant, fn: () => Promise<T>): Promise<T> {
  const name = `kept-${randomUUID()}`;
  const result = await withDbAccessContext(orgContext(t), async () => {
    const value = await fn();
    await db.update(sites).set({ name }).where(eq(sites.id, t.siteId));
    return value;
  });
  await expectNameCommitted(t.siteId, name);
  return result;
}

/** The same proof in the held system context a worker runs in. */
export async function inHeldSystemContext<T>(t: Pick<Tenant, 'siteId'>, fn: () => Promise<T>): Promise<T> {
  const name = `kept-${randomUUID()}`;
  const result = await withSystemDbAccessContext(async () => {
    const value = await fn();
    await db.update(sites).set({ name }).where(eq(sites.id, t.siteId));
    return value;
  });
  await expectNameCommitted(t.siteId, name);
  return result;
}

/** An org-scoped AuthContext for the AI tool handlers and route-shaped services. */
export async function toolAuth(t: Tenant, aiOrigin: object = { kind: 'ai_assistant', sessionId: 'rows' }): Promise<AuthContext> {
  const user = await createUser({ partnerId: t.partnerId, orgId: t.orgId });
  return {
    principal: { kind: 'user_session' },
    user: { id: user.id, email: 'op@example.com', name: 'Op', isPlatformAdmin: false },
    token: {} as AuthContext['token'],
    partnerId: t.partnerId,
    orgId: t.orgId,
    scope: 'organization',
    accessibleOrgIds: [t.orgId],
    orgCondition: (col: PgColumn): SQL => eq(col, t.orgId),
    canAccessOrg: (id: string) => id === t.orgId,
    canAccessSite: () => true,
    aiOrigin,
  } as unknown as AuthContext;
}
