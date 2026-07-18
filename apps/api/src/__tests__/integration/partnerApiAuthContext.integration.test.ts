import './setup';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { Database } from '../../db';
import { organizations, partnerServicePrincipals } from '../../db/schema';
import {
  partnerApiAuthMiddleware,
  type PartnerApiPrincipalContext,
} from '../../middleware/partnerApiAuth';
import { partnerOrganizationRoutes } from '../../routes/partnerApi/organizations';
import { issuePartnerServicePrincipalKey } from '../../services/partnerServicePrincipalKeys';
import { createOrganization, createPartner, createUser } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

describe('partner API authentication database context', () => {
  runDb('keeps active-org discovery, status serialization, and the route in one transaction', async () => {
    const partner = await createPartner();
    const user = await createUser({ partnerId: partner.id });
    const activeOrg = await createOrganization({ partnerId: partner.id });
    await createOrganization({ partnerId: partner.id, status: 'suspended' });
    const otherPartner = await createPartner();
    await createOrganization({ partnerId: otherPartner.id });
    const rawKey = await issueKey(partner.id, user.id);
    const entered = deferred<void>();
    const release = deferred<void>();
    let principal: PartnerApiPrincipalContext | undefined;
    const app = actualAuthApp(async (resolved) => {
      principal = resolved;
      entered.resolve();
      await release.promise;
    });

    const request = Promise.resolve(app.request('/organizations', {
      headers: { 'X-API-Key': rawKey },
    }));
    await entered.promise;
    expect(principal?.accessibleOrgIds).toEqual([activeOrg.id]);

    let statusWriterSettled = false;
    const statusWriter = getTestDb().update(organizations)
      .set({ status: 'suspended' })
      .where(eq(organizations.id, activeOrg.id))
      .then(() => { statusWriterSettled = true; });
    await delay(100);
    expect(statusWriterSettled).toBe(false);
    release.resolve();

    const response = await request;
    expect(response.status).toBe(200);
    const body = await response.json() as { data: Array<{ id: string }> };
    expect(body.data.map((row) => row.id)).toEqual([activeOrg.id]);
    await statusWriter;
  }, 15_000);

  runDb('empty discovery returns a DB-clock snapshot before a concurrent new organization stamp', async () => {
    const partner = await createPartner();
    const user = await createUser({ partnerId: partner.id });
    const rawKey = await issueKey(partner.id, user.id);
    const entered = deferred<void>();
    const release = deferred<void>();
    const app = actualAuthApp(async (principal) => {
      expect(principal.accessibleOrgIds).toEqual([]);
      entered.resolve();
      await release.promise;
    });

    const request = Promise.resolve(app.request('/organizations', {
      headers: { 'X-API-Key': rawKey },
    }));
    await entered.promise;
    let writerSettled = false;
    const writer = createOrganization({ partnerId: partner.id })
      .then((org) => { writerSettled = true; return org; });
    await delay(100);
    expect(writerSettled).toBe(false);
    release.resolve();

    const response = await request;
    expect(response.status).toBe(200);
    const first = await response.json() as { snapshotAt: string; data: unknown[] };
    expect(first.data).toEqual([]);
    const created = await writer;
    const [stored] = await getTestDb().select({ updatedAt: organizations.partnerExportUpdatedAt })
      .from(organizations).where(eq(organizations.id, created.id));
    expect(stored?.updatedAt.getTime()).toBeGreaterThan(Date.parse(first.snapshotAt));

    const following = await app.request(
      `/organizations?updatedSince=${encodeURIComponent(first.snapshotAt)}`,
      { headers: { 'X-API-Key': rawKey } },
    );
    expect(following.status).toBe(200);
    const followingBody = await following.json() as { data: Array<{ id: string }> };
    expect(followingBody.data.map((row) => row.id)).toContain(created.id);
  }, 15_000);
});

function actualAuthApp(
  hold: (principal: PartnerApiPrincipalContext) => Promise<void>,
): Hono {
  const app = new Hono();
  app.use('*', partnerApiAuthMiddleware);
  let held = false;
  app.use('*', async (c, next) => {
    if (!held) {
      held = true;
      await hold(c.get('partnerApiPrincipal'));
    }
    return next();
  });
  app.route('/', partnerOrganizationRoutes);
  return app;
}

async function issueKey(partnerId: string, userId: string): Promise<string> {
  const db = getTestDb();
  const [principal] = await db.insert(partnerServicePrincipals).values({
    partnerId,
    name: `Partner export integration ${crypto.randomUUID()}`,
    scopes: ['organizations:read'],
    createdBy: userId,
    updatedBy: userId,
  }).returning();
  if (!principal) throw new Error('service principal insert failed');
  const issued = await issuePartnerServicePrincipalKey(db as unknown as Database, {
    partnerServicePrincipalId: principal.id,
    partnerId,
    name: 'Integration key',
    actorId: userId,
  });
  return issued.rawKey;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
