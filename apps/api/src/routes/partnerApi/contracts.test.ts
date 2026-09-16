import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { ContractServiceError } from '../../services/contractTypes';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG_ID = '22222222-2222-4222-8222-222222222222';
const PARTNER_ID = '33333333-3333-4333-8333-333333333333';
const CONTRACT_ID = '44444444-4444-4444-8444-444444444444';
const LINE_ID = '55555555-5555-4555-8555-555555555555';
const PRINCIPAL_ID = '66666666-6666-4666-8666-666666666666';
const KEY_ID = '77777777-7777-4777-8777-777777777777';

const mocks = vi.hoisted(() => ({
  accessibleOrgIds: [] as string[],
  partnerContexts: [] as unknown[],
  createContract: vi.fn(),
  updateContract: vi.fn(),
  getContract: vi.fn(),
  addContractLineToContract: vi.fn(),
  updateContractLine: vi.fn(),
  removeContractLine: vi.fn(),
  audit: vi.fn(async () => undefined),
}));

vi.mock('../../db', () => ({
  db: {},
  hasDbAccessContext: () => true,
  getCurrentDbAccessContext: vi.fn(() => undefined),
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withDbAccessContext: async (ctx: unknown, fn: () => unknown) => {
    mocks.partnerContexts.push(ctx);
    return fn();
  },
  withSystemDbAccessContext: async (fn: () => unknown) => fn(),
}));
vi.mock('../../services/redis', () => ({ getRedis: () => ({}) }));
vi.mock('../../services/rate-limit', () => ({ rateLimiter: vi.fn() }));
vi.mock('../../config/env', () => ({
  PARTNER_API_CURSOR_SIGNING_KEY: Buffer.from('0123456789abcdef0123456789abcdef', 'utf8'),
}));
vi.mock('../../services/auditEvents', () => ({
  writeAuditEventAsync: mocks.audit,
  requestLikeFromSnapshot: (value: unknown) => value,
}));
vi.mock('../../middleware/partnerApiAuth', () => ({
  partnerApiAuthMiddleware: async (c: any, next: any) => {
    if (c.req.header('X-API-Key') !== 'test-key') return c.json({ error: 'authentication required' }, 401);
    c.set('partnerApiPrincipal', {
      partnerServicePrincipalId: PRINCIPAL_ID,
      keyId: KEY_ID,
      partnerId: PARTNER_ID,
      name: 'billing-bot',
      rateLimit: 1000,
      accessibleOrgIds: mocks.accessibleOrgIds,
      scopes: (c.req.header('X-Test-Scopes') ?? '').split(',').filter(Boolean),
    });
    return next();
  },
  requirePartnerApiScope: (...required: string[]) => async (c: any, next: any) => {
    const principal = c.get('partnerApiPrincipal');
    return required.every((scope) => principal.scopes.includes(scope))
      ? next()
      : c.json({ error: 'scope required' }, 403);
  },
}));
vi.mock('../../services/contractService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/contractService')>();
  return {
    ...actual,
    createContract: mocks.createContract,
    updateContract: mocks.updateContract,
    getContract: mocks.getContract,
    addContractLineToContract: mocks.addContractLineToContract,
    updateContractLine: mocks.updateContractLine,
    removeContractLine: mocks.removeContractLine,
    contractLineAuditDetails: (a: { contractLineId: string }) => ({ contractLineId: a.contractLineId }),
  };
});

import { partnerApiRoutes } from './index';
import { contractRoutes } from '../contracts';

const app = new Hono();
app.route('/', partnerApiRoutes);

const createBody = {
  orgId: ORG_ID,
  name: 'Data Protect',
  billingTiming: 'advance' as const,
  intervalMonths: 1,
  startDate: '2026-09-01',
};

const contractRow = {
  id: CONTRACT_ID,
  orgId: ORG_ID,
  partnerId: PARTNER_ID,
  name: 'Data Protect',
  status: 'draft',
  billingTiming: 'advance',
  intervalMonths: 1,
  startDate: '2026-09-01',
};

const manualLine = {
  lineType: 'manual' as const,
  description: 'Backup seats',
  unitPrice: '10.00',
  taxable: false,
  manualQuantity: '3',
};

const lineRow = {
  id: LINE_ID,
  orgId: ORG_ID,
  contractId: CONTRACT_ID,
  lineType: 'manual',
  description: 'Backup seats',
  unitPrice: '10.00',
  manualQuantity: '3',
  contractName: 'Data Protect',
};

function request(path: string, init: RequestInit & { scope?: string } = {}) {
  const { scope = 'contracts:write', ...rest } = init;
  const headers = new Headers(rest.headers);
  if (!headers.has('X-API-Key')) headers.set('X-API-Key', 'test-key');
  headers.set('X-Test-Scopes', scope);
  if (rest.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  return app.request(path, { ...rest, headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.accessibleOrgIds = [ORG_ID];
  mocks.partnerContexts = [];
  mocks.createContract.mockResolvedValue(contractRow);
  mocks.updateContract.mockResolvedValue({ ...contractRow, name: 'Data Protect Plus' });
  mocks.getContract.mockResolvedValue({ contract: contractRow, lines: [{ ...lineRow, manualQuantity: '5' }], periods: [] });
  mocks.addContractLineToContract.mockResolvedValue(lineRow);
  mocks.updateContractLine.mockResolvedValue({
    line: { ...lineRow, manualQuantity: '5' },
    audit: {
      orgId: ORG_ID,
      contractId: CONTRACT_ID,
      contractName: 'Data Protect',
      contractLineId: LINE_ID,
      lineType: 'manual',
      changedFields: ['manualQuantity'],
    },
  });
  mocks.removeContractLine.mockResolvedValue({
    orgId: ORG_ID,
    contractId: CONTRACT_ID,
    contractName: 'Data Protect',
    contractLineId: LINE_ID,
    lineType: 'manual',
  });
});

describe('POST /contracts', () => {
  it('requires authentication', async () => {
    const res = await request('/contracts', {
      method: 'POST',
      scope: 'contracts:write',
      headers: { 'X-API-Key': 'wrong' },
      body: JSON.stringify(createBody),
    });
    expect(res.status).toBe(401);
    expect(mocks.createContract).not.toHaveBeenCalled();
  });

  it('requires the contracts:write scope', async () => {
    const res = await request('/contracts', {
      method: 'POST',
      scope: 'organizations:read',
      body: JSON.stringify(createBody),
    });
    expect(res.status).toBe(403);
    expect(mocks.createContract).not.toHaveBeenCalled();
  });

  it('creates a contract for an accessible org and opens a partner DB context', async () => {
    const res = await request('/contracts', { method: 'POST', body: JSON.stringify(createBody) });
    expect(res.status).toBe(201);
    const body = await res.json() as { data: { id: string; name: string } };
    expect(body.data).toMatchObject({ id: CONTRACT_ID, name: 'Data Protect' });
    expect(mocks.createContract).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ORG_ID, name: 'Data Protect' }),
      expect.objectContaining({
        userId: null,
        partnerId: PARTNER_ID,
        accessibleOrgIds: [ORG_ID],
      }),
    );
    expect(mocks.partnerContexts[0]).toMatchObject({
      scope: 'partner',
      currentPartnerId: PARTNER_ID,
      accessibleOrgIds: [ORG_ID],
      userId: null,
    });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'contract.create',
        actorType: 'api_key',
        actorId: KEY_ID,
        resourceId: CONTRACT_ID,
        details: expect.objectContaining({
          principalType: 'partner_service_principal',
          partnerServicePrincipalId: PRINCIPAL_ID,
        }),
      }),
    );
  });

  it('refuses a foreign org before calling the contract engine', async () => {
    const res = await request('/contracts', {
      method: 'POST',
      body: JSON.stringify({ ...createBody, orgId: OTHER_ORG_ID }),
    });
    expect(res.status).toBe(403);
    const body = await res.json() as { code: string };
    expect(body.code).toBe('ORG_DENIED');
    expect(mocks.createContract).not.toHaveBeenCalled();
  });
});

describe('PATCH /contracts/:id', () => {
  it('requires contracts:write', async () => {
    const res = await request(`/contracts/${CONTRACT_ID}`, {
      method: 'PATCH',
      scope: 'organizations:read',
      body: JSON.stringify({ name: 'Data Protect Plus' }),
    });
    expect(res.status).toBe(403);
    expect(mocks.updateContract).not.toHaveBeenCalled();
  });

  it('updates header fields through the contract engine', async () => {
    const res = await request(`/contracts/${CONTRACT_ID}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Data Protect Plus' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { name: string } };
    expect(body.data.name).toBe('Data Protect Plus');
    expect(mocks.updateContract).toHaveBeenCalledWith(
      CONTRACT_ID,
      { name: 'Data Protect Plus' },
      expect.objectContaining({ partnerId: PARTNER_ID, accessibleOrgIds: [ORG_ID] }),
    );
  });

  it('does not bypass draft-only schedule rules from the engine', async () => {
    mocks.updateContract.mockRejectedValue(
      new ContractServiceError('Cannot change schedule fields on a non-draft contract', 409, 'INVALID_STATE'),
    );
    const res = await request(`/contracts/${CONTRACT_ID}`, {
      method: 'PATCH',
      body: JSON.stringify({ intervalMonths: 3 }),
    });
    expect(res.status).toBe(409);
    const body = await res.json() as { code: string };
    expect(body.code).toBe('INVALID_STATE');
  });
});

describe('POST /contracts/:id/lines', () => {
  it('adds a manual line', async () => {
    const res = await request(`/contracts/${CONTRACT_ID}/lines`, {
      method: 'POST',
      body: JSON.stringify(manualLine),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { data: { id: string; lineType: string } };
    expect(body.data).toMatchObject({ id: LINE_ID, lineType: 'manual' });
    expect(mocks.addContractLineToContract).toHaveBeenCalledWith(
      CONTRACT_ID,
      expect.objectContaining({ lineType: 'manual', manualQuantity: '3' }),
      expect.objectContaining({ partnerId: PARTNER_ID }),
    );
  });

  it('adds a flat line', async () => {
    mocks.addContractLineToContract.mockResolvedValue({ ...lineRow, lineType: 'flat', manualQuantity: null });
    const res = await request(`/contracts/${CONTRACT_ID}/lines`, {
      method: 'POST',
      body: JSON.stringify({
        lineType: 'flat',
        description: 'Retainer',
        unitPrice: '100.00',
        taxable: false,
      }),
    });
    expect(res.status).toBe(201);
    expect(mocks.addContractLineToContract).toHaveBeenCalledWith(
      CONTRACT_ID,
      expect.objectContaining({ lineType: 'flat' }),
      expect.anything(),
    );
  });
});

describe('PATCH /contracts/:id/lines/:lineId', () => {
  it('requires contracts:write', async () => {
    const res = await request(`/contracts/${CONTRACT_ID}/lines/${LINE_ID}`, {
      method: 'PATCH',
      scope: 'organizations:read',
      body: JSON.stringify({ manualQuantity: '5' }),
    });
    expect(res.status).toBe(403);
    expect(mocks.updateContractLine).not.toHaveBeenCalled();
  });

  it('patches manualQuantity through the contract engine', async () => {
    const res = await request(`/contracts/${CONTRACT_ID}/lines/${LINE_ID}`, {
      method: 'PATCH',
      body: JSON.stringify({ manualQuantity: '5' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { manualQuantity: string } };
    expect(body.data.manualQuantity).toBe('5');
    expect(mocks.updateContractLine).toHaveBeenCalledWith(
      CONTRACT_ID,
      LINE_ID,
      { manualQuantity: '5' },
      expect.objectContaining({ partnerId: PARTNER_ID, accessibleOrgIds: [ORG_ID] }),
    );
  });

  it('maps a foreign-org engine deny', async () => {
    mocks.updateContractLine.mockRejectedValue(
      new ContractServiceError('Organization access denied', 403, 'ORG_DENIED'),
    );
    const res = await request(`/contracts/${CONTRACT_ID}/lines/${LINE_ID}`, {
      method: 'PATCH',
      body: JSON.stringify({ manualQuantity: '5' }),
    });
    expect(res.status).toBe(403);
    expect((await res.json() as { code: string }).code).toBe('ORG_DENIED');
  });
});

describe('DELETE /contracts/:id/lines/:lineId', () => {
  it('removes a line', async () => {
    const res = await request(`/contracts/${CONTRACT_ID}/lines/${LINE_ID}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { ok: true } });
    expect(mocks.removeContractLine).toHaveBeenCalledWith(
      CONTRACT_ID,
      LINE_ID,
      expect.objectContaining({ partnerId: PARTNER_ID }),
    );
  });
});

describe('GET /contracts/:id', () => {
  it('requires contracts:write', async () => {
    const res = await request(`/contracts/${CONTRACT_ID}`, { scope: 'organizations:read' });
    expect(res.status).toBe(403);
    expect(mocks.getContract).not.toHaveBeenCalled();
  });

  it('returns the contract and lines for read-back', async () => {
    const res = await request(`/contracts/${CONTRACT_ID}`);
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { contract: { id: string }; lines: Array<{ manualQuantity: string }> } };
    expect(body.data.contract.id).toBe(CONTRACT_ID);
    expect(body.data.lines[0]?.manualQuantity).toBe('5');
    expect(mocks.getContract).toHaveBeenCalledWith(
      CONTRACT_ID,
      expect.objectContaining({ partnerId: PARTNER_ID, accessibleOrgIds: [ORG_ID] }),
    );
  });
});

describe('human /api/v1/contracts still rejects a partner SP key', () => {
  it('returns 401 for X-API-Key without a Bearer token', async () => {
    const human = new Hono();
    human.route('/contracts', contractRoutes);
    const res = await human.request('/contracts', {
      headers: { 'X-API-Key': 'brz_sp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
    });
    expect(res.status).toBe(401);
    const body = await res.text();
    expect(body).toMatch(/authorization header/i);
  });
});
