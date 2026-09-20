import './setup';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../../db';
import {
  contractLines,
  contracts,
  partnerServicePrincipals,
} from '../../db/schema';
import { contractRoutes } from '../../routes/contracts';
import { partnerApiRoutes } from '../../routes/partnerApi';
import { issuePartnerServicePrincipalKey } from '../../services/partnerServicePrincipalKeys';
import type { PartnerServicePrincipalScope } from '../../services/partnerServicePrincipalScopes';
import { createOrganization, createPartner, createUser } from './db-utils';
import { getTestDb } from './setup';

vi.mock('../../config/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config/env')>();
  return {
    ...actual,
    PARTNER_API_CURSOR_SIGNING_KEY: Buffer.from('0123456789abcdef0123456789abcdef', 'utf8'),
  };
});

const runDb = it.runIf(!!process.env.DATABASE_URL);

describe('partner API contract writes', () => {
  runDb('mints a key, creates a contract, patches quantity, reads it back, and refuses a foreign org', async () => {
    const partner = await createPartner();
    const user = await createUser({ partnerId: partner.id });
    const org = await createOrganization({ partnerId: partner.id });
    const otherPartner = await createPartner();
    const foreignOrg = await createOrganization({ partnerId: otherPartner.id });
    const rawKey = await issueKey(partner.id, user.id, ['contracts:write']);
    const app = partnerApp();

    const created = await app.request('/contracts', {
      method: 'POST',
      headers: jsonHeaders(rawKey),
      body: JSON.stringify({
        orgId: org.id,
        name: 'Data Protect',
        billingTiming: 'advance',
        intervalMonths: 1,
        startDate: '2026-09-01',
      }),
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const createdBody = await created.json() as { data: { id: string } };
    const contractId = createdBody.data.id;

    const added = await app.request(`/contracts/${contractId}/lines`, {
      method: 'POST',
      headers: jsonHeaders(rawKey),
      body: JSON.stringify({
        lineType: 'manual',
        description: 'Backup seats',
        unitPrice: '10.00',
        taxable: false,
        manualQuantity: '3',
      }),
    });
    expect(added.status, await added.clone().text()).toBe(201);
    const addedBody = await added.json() as { data: { id: string; manualQuantity: string } };
    expect(addedBody.data.manualQuantity).toBe('3.00');
    const lineId = addedBody.data.id;

    const patched = await app.request(`/contracts/${contractId}/lines/${lineId}`, {
      method: 'PATCH',
      headers: jsonHeaders(rawKey),
      body: JSON.stringify({ manualQuantity: '5' }),
    });
    expect(patched.status, await patched.clone().text()).toBe(200);

    const readBack = await app.request(`/contracts/${contractId}`, {
      headers: { 'X-API-Key': rawKey },
    });
    expect(readBack.status, await readBack.clone().text()).toBe(200);
    const readBody = await readBack.json() as {
      data: { contract: { id: string; name: string }; lines: Array<{ id: string; manualQuantity: string }> };
    };
    expect(readBody.data.contract.id).toBe(contractId);
    expect(readBody.data.contract.name).toBe('Data Protect');
    expect(readBody.data.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: lineId, manualQuantity: '5.00' }),
    ]));

    const admin = getTestDb();
    const [storedLine] = await admin.select({
      id: contractLines.id,
      manualQuantity: contractLines.manualQuantity,
    }).from(contractLines).where(eq(contractLines.id, lineId));
    expect(storedLine?.manualQuantity).toBe('5.00');
    const [storedContract] = await admin.select({ id: contracts.id, orgId: contracts.orgId })
      .from(contracts).where(eq(contracts.id, contractId));
    expect(storedContract?.orgId).toBe(org.id);

    const foreign = await app.request('/contracts', {
      method: 'POST',
      headers: jsonHeaders(rawKey),
      body: JSON.stringify({
        orgId: foreignOrg.id,
        name: 'Should fail',
        billingTiming: 'advance',
        intervalMonths: 1,
        startDate: '2026-09-01',
      }),
    });
    expect(foreign.status).toBe(403);
    expect((await foreign.json() as { code: string }).code).toBe('ORG_DENIED');
  });

  runDb('refuses GET and PATCH of a contract in an org outside the principal set', async () => {
    const partner = await createPartner();
    const user = await createUser({ partnerId: partner.id });
    await createOrganization({ partnerId: partner.id });
    const otherPartner = await createPartner();
    const foreignOrg = await createOrganization({ partnerId: otherPartner.id });
    const admin = getTestDb();
    const [foreignContract] = await admin.insert(contracts).values({
      partnerId: otherPartner.id,
      orgId: foreignOrg.id,
      name: 'Foreign contract',
      status: 'draft',
      billingTiming: 'advance',
      intervalMonths: 1,
      startDate: '2026-09-01',
      currencyCode: 'USD',
      createdBy: null,
    }).returning({ id: contracts.id });
    if (!foreignContract) throw new Error('foreign contract seed failed');

    const rawKey = await issueKey(partner.id, user.id, ['contracts:write']);
    const app = partnerApp();
    const got = await app.request(`/contracts/${foreignContract.id}`, {
      headers: { 'X-API-Key': rawKey },
    });
    expect([403, 404]).toContain(got.status);

    const patched = await app.request(`/contracts/${foreignContract.id}`, {
      method: 'PATCH',
      headers: jsonHeaders(rawKey),
      body: JSON.stringify({ name: 'Should not land' }),
    });
    expect([403, 404]).toContain(patched.status);
    const [unchanged] = await admin.select({ name: contracts.name })
      .from(contracts).where(eq(contracts.id, foreignContract.id));
    expect(unchanged?.name).toBe('Foreign contract');
  });

  runDb('refuses a lineId that belongs to a different contract', async () => {
    const partner = await createPartner();
    const user = await createUser({ partnerId: partner.id });
    const org = await createOrganization({ partnerId: partner.id });
    const rawKey = await issueKey(partner.id, user.id, ['contracts:write']);
    const app = partnerApp();

    const a = await app.request('/contracts', {
      method: 'POST',
      headers: jsonHeaders(rawKey),
      body: JSON.stringify({
        orgId: org.id,
        name: 'Contract A',
        billingTiming: 'advance',
        intervalMonths: 1,
        startDate: '2026-09-01',
      }),
    });
    expect(a.status, await a.clone().text()).toBe(201);
    const contractA = (await a.json() as { data: { id: string } }).data.id;

    const b = await app.request('/contracts', {
      method: 'POST',
      headers: jsonHeaders(rawKey),
      body: JSON.stringify({
        orgId: org.id,
        name: 'Contract B',
        billingTiming: 'advance',
        intervalMonths: 1,
        startDate: '2026-09-01',
      }),
    });
    expect(b.status, await b.clone().text()).toBe(201);
    const contractB = (await b.json() as { data: { id: string } }).data.id;

    const added = await app.request(`/contracts/${contractA}/lines`, {
      method: 'POST',
      headers: jsonHeaders(rawKey),
      body: JSON.stringify({
        lineType: 'manual',
        description: 'A-only line',
        unitPrice: '10.00',
        taxable: false,
        manualQuantity: '1',
      }),
    });
    expect(added.status, await added.clone().text()).toBe(201);
    const lineA = (await added.json() as { data: { id: string } }).data.id;

    const patched = await app.request(`/contracts/${contractB}/lines/${lineA}`, {
      method: 'PATCH',
      headers: jsonHeaders(rawKey),
      body: JSON.stringify({ manualQuantity: '9' }),
    });
    expect(patched.status).toBe(404);
    expect((await patched.json() as { code: string }).code).toBe('LINE_NOT_FOUND');

    const removed = await app.request(`/contracts/${contractB}/lines/${lineA}`, {
      method: 'DELETE',
      headers: jsonHeaders(rawKey),
    });
    expect(removed.status).toBe(404);
    expect((await removed.json() as { code: string }).code).toBe('LINE_NOT_FOUND');

    const [stillThere] = await getTestDb().select({
      id: contractLines.id,
      contractId: contractLines.contractId,
      manualQuantity: contractLines.manualQuantity,
    }).from(contractLines).where(eq(contractLines.id, lineA));
    expect(stillThere?.contractId).toBe(contractA);
    expect(stillThere?.manualQuantity).toBe('1.00');
  });

  runDb('refuses a principal without contracts:write', async () => {
    const partner = await createPartner();
    const user = await createUser({ partnerId: partner.id });
    const org = await createOrganization({ partnerId: partner.id });
    const rawKey = await issueKey(partner.id, user.id, ['organizations:read']);
    const app = partnerApp();
    const res = await app.request('/contracts', {
      method: 'POST',
      headers: jsonHeaders(rawKey),
      body: JSON.stringify({
        orgId: org.id,
        name: 'No grant',
        billingTiming: 'advance',
        intervalMonths: 1,
        startDate: '2026-09-01',
      }),
    });
    expect(res.status).toBe(403);
  });

  runDb('still returns 401 when the same key hits /api/v1/contracts', async () => {
    const partner = await createPartner();
    const user = await createUser({ partnerId: partner.id });
    const rawKey = await issueKey(partner.id, user.id, ['contracts:write']);
    const human = new Hono();
    human.route('/contracts', contractRoutes);
    const res = await human.request('/contracts', {
      headers: { 'X-API-Key': rawKey },
    });
    expect(res.status).toBe(401);
  });
});

function partnerApp(): Hono {
  const app = new Hono();
  app.route('/', partnerApiRoutes);
  return app;
}

function jsonHeaders(rawKey: string): Record<string, string> {
  return { 'X-API-Key': rawKey, 'Content-Type': 'application/json' };
}

async function issueKey(
  partnerId: string,
  userId: string,
  scopes: readonly PartnerServicePrincipalScope[],
): Promise<string> {
  const admin = getTestDb();
  const [principal] = await admin.insert(partnerServicePrincipals).values({
    partnerId,
    name: `Contract write ${crypto.randomUUID()}`,
    scopes: [...scopes],
    createdBy: userId,
    updatedBy: userId,
  }).returning();
  if (!principal) throw new Error('service principal seed failed');
  return (await issuePartnerServicePrincipalKey(admin as unknown as Database, {
    partnerServicePrincipalId: principal.id,
    partnerId,
    name: 'Contract write key',
    actorId: userId,
  })).rawKey;
}
