import { beforeEach, describe, expect, it, vi } from 'vitest';

const PARTNER = '00000000-0000-4000-8000-0000000000e1';
const ORG = '00000000-0000-4000-8000-0000000000c1';
const INV_A = '00000000-0000-4000-8000-0000000000a1';
const INV_B = '00000000-0000-4000-8000-0000000000a2';
const INV_C = '00000000-0000-4000-8000-0000000000a3';

const h = vi.hoisted(() => {
  const rows: unknown[][] = [];
  const projections: string[][] = [];
  return {
    rows, projections,
    select: vi.fn((projection?: Record<string, unknown>) => {
      projections.push(projection ? Object.keys(projection) : []);
      const result = rows.length > 0 ? rows.shift()! : [];
      const proxy: unknown = new Proxy({}, {
        get(_t, prop) {
          if (prop === 'then') return (resolve: (v: unknown) => unknown) => resolve(result);
          return () => proxy;
        },
      });
      return proxy;
    }),
    audit: vi.fn(),
    findProvider: vi.fn(),
    getProvider: vi.fn(),
    supports: vi.fn(),
    resolveConn: vi.fn(),
    saveDecision: vi.fn(),
    syncMapped: vi.fn(),
    listProposals: vi.fn(),
    listIncome: vi.fn(),
    listCustomers: vi.fn(),
    push: vi.fn(),
    enqueueMapping: vi.fn(),
    enqueueInvoicePush: vi.fn(),
  };
});

vi.mock('../db', () => ({ db: { select: h.select } }));
vi.mock('../middleware/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../middleware/auth')>()),
  withAuthDbAccessContext: (_auth: unknown, fn: () => unknown) => fn(),
}));
vi.mock('./aiToolsSoftwareShared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./aiToolsSoftwareShared')>()),
  auditToolWrite: h.audit,
}));
vi.mock('./accounting/providerRegistry', () => ({
  findAccountingProvider: h.findProvider, getAccountingProvider: h.getProvider, providerSupports: h.supports,
}));
vi.mock('./accounting/accountingMappingService', () => {
  class AccountingMappingError extends Error {
    constructor(public code: string, public status: number, message: string) { super(message); }
  }
  return {
    AccountingMappingError,
    listMappingProposals: h.listProposals, listRemoteIncomeAccountsForPartner: h.listIncome,
    resolveConnectionAndToken: h.resolveConn, saveMappingDecision: h.saveDecision, syncMappedEntity: h.syncMapped,
  };
});
vi.mock('./accounting/accountingCustomerImport', () => {
  class AccountingImportError extends Error { code = 'import'; }
  return { AccountingImportError, listAccountingCustomersAnnotated: h.listCustomers };
});
vi.mock('./accounting/accountingInvoicePush', () => ({ pushInvoiceToAccounting: h.push }));
vi.mock('../jobs/accountingSyncWorker', () => ({
  enqueueAccountingMappingSync: h.enqueueMapping,
  enqueueAccountingInvoicePush: h.enqueueInvoicePush,
}));

import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { registerAccountingSyncTools } from './aiToolsAccountingSync';
import { AccountingInvoicePushError } from './accounting/accountingInvoicePushErrors';

const tools = new Map<string, AiTool>();
registerAccountingSyncTools(tools);

const makeAuth = (over: Record<string, unknown> = {}) => ({
  principal: { kind: 'user_session' },
  user: { id: 'user-1', email: 'tech@example.test' },
  scope: 'partner', orgId: null, partnerId: PARTNER, partnerOrgAccess: 'all',
  accessibleOrgIds: [ORG], canAccessOrg: () => true, orgCondition: () => undefined,
  token: { mfa: true, amr: ['pwd', 'mfa'] },
  aiOrigin: { kind: 'chat', sessionId: 's1' },
  ...over,
}) as unknown as AuthContext;
const run = async (input: Record<string, unknown>, auth: AuthContext = makeAuth()) =>
  JSON.parse(await tools.get('manage_accounting_sync')!.handler(input, auth)) as Record<string, any>;
const base = { provider: 'quickbooks' };

const pushOutcome = {
  mappingId: 'm1', remoteEntityId: 'R1', docNumber: '1001', syncStatus: 'synced', taxVarianceCents: 0, totalVarianceCents: 0,
};
const mappingRow = {
  id: 'internal-id', integrationId: 'conn-1', remoteSyncToken: 'tok', breezeEntityType: 'org', breezeEntityId: ORG,
  remoteEntityType: 'customer', remoteEntityId: 'R9', linkStatus: 'confirmed', syncStatus: 'pending',
  lastSyncedAt: null, lastError: null, confidence: 'high', proposedRemoteName: null,
};
let impl: Record<string, any>;

beforeEach(() => {
  vi.clearAllMocks();
  h.rows.length = 0; h.projections.length = 0;
  impl = {
    displayName: 'QuickBooks', capabilities: { connect: true }, configError: vi.fn(() => null),
    listRemoteCustomers: vi.fn(async () => []), listRemoteItems: vi.fn(async () => []),
  };
  h.findProvider.mockReturnValue(impl);
  h.getProvider.mockReturnValue(impl);
  h.supports.mockReturnValue(true);
  h.resolveConn.mockResolvedValue({ liveConn: { token: 'decrypted' } });
  h.saveDecision.mockResolvedValue(mappingRow);
  h.syncMapped.mockResolvedValue(mappingRow);
  h.enqueueMapping.mockResolvedValue(true);
  h.push.mockResolvedValue(pushOutcome);
});

const noServiceCalls = () => {
  for (const fn of [h.select, h.saveDecision, h.syncMapped, h.push, h.resolveConn, h.enqueueMapping]) expect(fn).not.toHaveBeenCalled();
};

describe('manage_accounting_sync gates', () => {
  it('refuses organization scope and partner scope with selected org access, calling nothing', async () => {
    const orgScope = await run({ action: 'status', ...base }, makeAuth({ scope: 'organization', orgId: ORG, partnerId: null }));
    expect(orgScope.code).toBe('PARTNER_SCOPE_REQUIRED');
    const selected = await run({ action: 'push', ...base, invoiceId: INV_A }, makeAuth({ partnerOrgAccess: 'selected' }));
    expect(selected.code).toBe('ACCESS_DENIED');
    expect(h.findProvider).not.toHaveBeenCalled();
    noServiceCalls();
  });

  it('refuses a device-bound session (the realm is partner-wide; canMutateOrgWideGovernance), calling nothing', async () => {
    const status = await run({ action: 'status', ...base }, makeAuth({ allowedDeviceIds: ['d-1'] }));
    expect(status.code).toBe('ACCESS_DENIED');
    const device = await run({ action: 'push', ...base, invoiceId: INV_A }, makeAuth({ allowedDeviceIds: ['d-1'] }));
    expect(device.code).toBe('ACCESS_DENIED');
    noServiceCalls();
  });

  it('provider gate: unregistered, unsupported capability, and unconfigured provider', async () => {
    h.findProvider.mockReturnValue(undefined);
    expect((await run({ action: 'status', ...base })).code).toBe('capability_unavailable');

    h.findProvider.mockReturnValue(impl);
    h.supports.mockReturnValue(false);
    expect((await run({ action: 'status', ...base })).code).toBe('capability_unavailable');

    h.supports.mockReturnValue(true);
    impl.configError.mockReturnValue('QuickBooks client id is not set');
    const mappings = await run({ action: 'mappings', ...base, entityType: 'org' });
    expect(mappings).toMatchObject({ code: 'provider_not_configured', error: 'QuickBooks client id is not set' });
    expect(h.listProposals).not.toHaveBeenCalled();

    // status does not require the provider to be configured
    h.rows.push([]);
    expect((await run({ action: 'status', ...base })).status).toBe('disconnected');
  });

  it('refuses a write without MFA before any service call, but allows a read', async () => {
    const noMfa = makeAuth({ token: {} });
    for (const input of [
      { action: 'link_mapping', entityType: 'org', entityId: ORG, remoteEntityId: 'R1' },
      { action: 'unlink_mapping', entityType: 'org', entityId: ORG },
      { action: 'sync_mapping', entityType: 'org', entityId: ORG },
      { action: 'push', invoiceId: INV_A },
      { action: 'push_bulk', invoiceIds: [INV_A] },
    ]) {
      expect((await run({ ...input, ...base }, noMfa)).code).toBe('MFA_REQUIRED');
    }
    noServiceCalls();
    h.rows.push([]);
    expect((await run({ action: 'status', ...base }, noMfa)).status).toBe('disconnected');
  });
});

describe('status', () => {
  it('projects no token column and the output names none', async () => {
    h.rows.push([{ status: 'connected', environment: 'production', pushMode: 'manual', lastError: null }]);
    const out = await run({ action: 'status', ...base });
    expect(out.status).toBe('connected');
    const forbidden = ['accessTokenEncrypted', 'refreshTokenEncrypted', 'realmIdEncrypted', 'webhookVerifierTokenEncrypted'];
    expect(h.projections).toHaveLength(1);
    for (const key of forbidden) expect(h.projections[0]).not.toContain(key);
    expect(h.projections[0]).toContain('status');
    const text = JSON.stringify(out);
    for (const key of forbidden) expect(text).not.toContain(key);
  });
});

describe('remote_candidates', () => {
  it('lists customers with only the live connection (q never reaches the provider) and filters locally', async () => {
    impl.listRemoteCustomers.mockResolvedValue([
      { id: '1', displayName: 'Acme Corp' }, { id: '2', displayName: 'Beta LLC', active: false }, { id: '3', displayName: 'acme two' },
    ]);
    const out = await run({ action: 'remote_candidates', ...base, entityType: 'org', q: ' ACME ' });
    expect(impl.listRemoteCustomers).toHaveBeenCalledTimes(1);
    expect(impl.listRemoteCustomers.mock.calls[0]).toEqual([{ token: 'decrypted' }]);
    expect(out.candidates.map((c: any) => c.id)).toEqual(['1', '3']);
    expect(out.truncated).toBe(false);
  });

  it('catalog_item matches on sku and caps at 25 with truncated', async () => {
    impl.listRemoteItems.mockResolvedValue(
      Array.from({ length: 30 }, (_, i) => ({ id: `i${i}`, displayName: `Item ${i}`, sku: `SKU-${i}` })),
    );
    const bySku = await run({ action: 'remote_candidates', ...base, entityType: 'catalog_item', q: 'sku-7' });
    expect(bySku.candidates.map((c: any) => c.id)).toEqual(['i7']);
    expect(impl.listRemoteItems.mock.calls[0]).toHaveLength(1);

    const all = await run({ action: 'remote_candidates', ...base, entityType: 'catalog_item', q: 'item' });
    expect(all.total).toBe(30);
    expect(all.candidates).toHaveLength(25);
    expect(all.truncated).toBe(true);
  });
});

describe('mapping writes', () => {
  it('link_mapping needs remoteEntityId; with it saves confirmed and enqueues; result omits internals', async () => {
    const bad = await run({ action: 'link_mapping', ...base, entityType: 'org', entityId: ORG });
    expect(bad.code).toBe('VALIDATION_ERROR');
    expect(h.saveDecision).not.toHaveBeenCalled();

    const out = await run({ action: 'link_mapping', ...base, entityType: 'org', entityId: ORG, remoteEntityId: 'R9' });
    expect(h.saveDecision.mock.calls[0]![0]).toMatchObject({ decision: 'confirmed', remoteEntityId: 'R9', partnerId: PARTNER });
    expect(h.enqueueMapping).toHaveBeenCalledWith('org', ORG, PARTNER, 'conn-1');
    expect(out.syncEnqueued).toBe(true);
    for (const k of ['id', 'integrationId', 'remoteSyncToken']) expect(out.mapping).not.toHaveProperty(k);
    expect(out.mapping.remoteEntityId).toBe('R9');
    expect(h.audit).toHaveBeenCalledTimes(1);
  });

  it('unlink_mapping saves unlinked and never enqueues', async () => {
    const out = await run({ action: 'unlink_mapping', ...base, entityType: 'org', entityId: ORG });
    expect(h.saveDecision.mock.calls[0]![0]).toMatchObject({ decision: 'unlinked' });
    expect(h.enqueueMapping).not.toHaveBeenCalled();
    expect(out).not.toHaveProperty('syncEnqueued');
  });

  it('sync_mapping refuses create_new, id-less, and missing rows; syncs a confirmed linked row', async () => {
    const input = { action: 'sync_mapping', ...base, entityType: 'org', entityId: ORG };
    for (const rows of [[{ linkStatus: 'create_new', remoteEntityId: 'R1' }], [{ linkStatus: 'confirmed', remoteEntityId: null }], []]) {
      h.rows.push(rows);
      expect((await run(input)).code).toBe('CREATE_NOT_SUPPORTED');
    }
    expect(h.syncMapped).not.toHaveBeenCalled();

    h.rows.push([{ linkStatus: 'confirmed', remoteEntityId: 'R9' }]);
    const out = await run(input);
    expect(h.syncMapped).toHaveBeenCalledTimes(1);
    expect(out.mapping).not.toHaveProperty('remoteSyncToken');
  });
});

describe('push and push_bulk', () => {
  it('push: an invoice not owned by the partner is NOT_FOUND and nothing is pushed', async () => {
    h.rows.push([]);
    expect((await run({ action: 'push', ...base, invoiceId: INV_A })).code).toBe('NOT_FOUND');
    expect(h.push).not.toHaveBeenCalled();
  });

  it('push: owned invoice is pushed with (id, partner, runner, {provider}) and a minimal output', async () => {
    h.rows.push([{ id: INV_A }]);
    const out = await run({ action: 'push', ...base, invoiceId: INV_A });
    const call = h.push.mock.calls[0]!;
    expect(call[0]).toBe(INV_A);
    expect(call[1]).toBe(PARTNER);
    expect(typeof call[2]).toBe('function');
    expect(call[3]).toEqual({ provider: 'quickbooks' });
    expect(Object.keys(out).sort()).toEqual(['docNumber', 'invoiceId', 'syncStatus', 'taxVarianceCents', 'totalVarianceCents']);
  });

  it('push_bulk rejects more than 10 ids', async () => {
    const ids = Array.from({ length: 11 }, (_, i) => `00000000-0000-4000-8000-00000000f${String(i).padStart(3, '0')}`);
    expect((await run({ action: 'push_bulk', ...base, invoiceIds: ids })).code).toBe('VALIDATION_ERROR');
    expect(h.select).not.toHaveBeenCalled();
  });

  it('push_bulk pushes synchronously per owned id, reports a foreign id, never queues', async () => {
    h.rows.push([{ id: INV_A }, { id: INV_C }]);
    const out = await run({ action: 'push_bulk', ...base, invoiceIds: [INV_A, INV_B, INV_C] });
    expect(h.push.mock.calls.map((c) => c[0])).toEqual([INV_A, INV_C]);
    expect(h.enqueueInvoicePush).not.toHaveBeenCalled();
    expect(out.results[1]).toEqual({ invoiceId: INV_B, code: 'NOT_FOUND' });
    expect(out.pushed).toBe(2);
    expect(out.notAttempted).toEqual([]);
  });

  it('push_bulk stops on rate_limited and lists the rest as notAttempted', async () => {
    h.rows.push([{ id: INV_A }, { id: INV_B }, { id: INV_C }]);
    h.push.mockRejectedValueOnce(new AccountingInvoicePushError('rate_limited', 429, 'slow down', { retryAfterMs: 5000 }));
    const out = await run({ action: 'push_bulk', ...base, invoiceIds: [INV_A, INV_B, INV_C] });
    expect(h.push).toHaveBeenCalledTimes(1);
    expect(out.results).toEqual([{ invoiceId: INV_A, code: 'rate_limited', error: 'slow down' }]);
    expect(out.notAttempted).toEqual([INV_B, INV_C]);
  });
});
