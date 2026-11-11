import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  db: { select: vi.fn(), update: vi.fn() },
  validateLines: vi.fn(),
  events: [] as string[],
  createClient: vi.fn(),
  logError: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock('./pax8OrderObservability', () => ({ errorIds: { PAX8_BILLING_CONFLICT: 'PAX8_BILLING_CONFLICT', PAX8_BILLING_INTEGRITY_DRIFT: 'PAX8_BILLING_INTEGRITY_DRIFT', PAX8_REOPEN_FAILED: 'PAX8_REOPEN_FAILED' }, logError: mocks.logError }));
vi.mock('./sentry', () => ({ captureException: mocks.captureException }));

vi.mock('../db', () => ({
  db: mocks.db,
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withDbAccessContext: (_context: unknown, fn: () => unknown) => fn(),
}));

vi.mock('./pax8OrderService', () => {
  class Pax8OrderError extends Error {
    constructor(message: string, public readonly status: number, options: { phase?: string; code?: string; cause?: unknown } = {}) {
      super(message, { cause: options.cause });
      Object.assign(this, { phase: options.phase ?? 'claim', code: options.code });
    }
  }
  class Pax8OrderRestageRequiredError extends Pax8OrderError {
    constructor(message: string) {
      super(message, 409);
    }
  }
  return {
    Pax8OrderError,
    Pax8OrderRestageRequiredError,
    Pax8ClaimDriftError: class extends Pax8OrderError { constructor(message: string) { super(message, 409, { phase: 'claim', code: 'PREVIEW_MISMATCH' }); } },
    requireImmediateCancelDate: vi.fn(),
    validateDirectOrderLinesForSubmit: mocks.validateLines,
  };
});

vi.mock('./pax8SyncService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./pax8SyncService')>();
  return { ...actual, createPax8ClientForIntegration: mocks.createClient };
});

import { pax8CredentialGeneration } from './actionIntents/pax8OrderDigest';
import { pax8OrderSubmitRepository } from './pax8OrderSubmitRepository';

const READY_METADATA = {
  contacts: [{ types: [
    { type: 'Admin', primary: true },
    { type: 'Billing', primary: true },
    { type: 'Technical', primary: true },
  ] }],
};

const order = {
  id: 'order-1', integrationId: 'integration-1', partnerId: 'partner-1', orgId: 'org-1',
  pax8CompanyId: 'company-1', status: 'ready', source: 'quote', sourceQuoteId: null,
  dedupeKey: 'order:order-1', pax8OrderId: null, error: null, createdBy: 'user-1',
  submittedBy: null, submittedAt: null, createdAt: new Date(), updatedAt: new Date(),
  rowVersion: '7',
} as const;

function selectChain(rows: unknown[], terminal: 'limit' | 'for' | 'orderBy', event?: string) {
  const chain: Record<string, unknown> = {};
  chain.then = Promise.resolve(rows).then.bind(Promise.resolve(rows));
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.limit = vi.fn(async () => {
    if (terminal === 'limit' && event) mocks.events.push(event);
    return rows;
  });
  chain.for = vi.fn(() => {
    if (terminal === 'for' && event) mocks.events.push(event);
    return Object.assign(Promise.resolve(rows), { limit: chain.limit });
  });
  chain.orderBy = vi.fn(async () => {
    if (terminal === 'orderBy' && event) mocks.events.push(event);
    return rows;
  });
  return chain;
}

beforeEach(() => {
  mocks.db.select.mockReset();
  mocks.db.update.mockReset();
  mocks.validateLines.mockReset();
  mocks.createClient.mockReset();
  mocks.events.length = 0;
  mocks.logError.mockReset();
  mocks.captureException.mockReset();
});

describe('pax8OrderSubmitRepository.claimOrder', () => {
  it('reads and returns the authoritative line only after the parent claim lock', async () => {
    const patchedLine = {
      id: 'line-1', orderId: order.id, partnerId: order.partnerId, orgId: order.orgId,
      action: 'new_subscription', submitState: 'pending', pax8ProductId: 'product-1',
      catalogItemId: 'catalog-1', billingTerm: 'Monthly', commitmentTermId: 'commit-new',
      quantity: '2.00', authorizedBaselineQuantity: null,
      provisioningDetails: [{ key: 'domain', values: ['patched.example'] }],
      targetSubscriptionId: null, cancelDate: null, resultSubscriptionId: null,
      contractLineId: null, sourceQuoteLineId: 'quote-line-1', error: null, sortOrder: 0,
      createdAt: new Date(), updatedAt: new Date(),
    };
    mocks.db.select
      .mockReturnValueOnce(selectChain([order], 'limit', 'org-discovered'))
      .mockReturnValueOnce(selectChain([order], 'limit', 'order-reloaded'))
      .mockReturnValueOnce(selectChain([{
        pax8CompanyId: 'company-1', status: 'Active', metadata: READY_METADATA,
      }], 'for', 'company-locked'))
      .mockReturnValueOnce(selectChain([patchedLine], 'orderBy', 'lines-read'))
      .mockReturnValueOnce(selectChain([integration], 'limit'));
    const returning = vi.fn(async () => {
      mocks.events.push('parent-claimed');
      return [{ ...order, status: 'submitting', submittedAt: new Date() }];
    });
    mocks.db.update.mockReturnValue({
      set: vi.fn(() => ({ where: vi.fn(() => ({ returning })) })),
    });
    mocks.validateLines.mockImplementation(async (_order, lines) => {
      mocks.events.push('lines-validated');
      return lines;
    });

    const bundle = await pax8OrderSubmitRepository.claimOrder({
      partnerId: order.partnerId,
      orderId: order.id,
      actorUserId: 'actor-1', mode: { kind: 'rest' },
    });

    expect(mocks.events.indexOf('parent-claimed')).toBeLessThan(mocks.events.indexOf('lines-read'));
    expect(mocks.events.indexOf('lines-read')).toBeLessThan(mocks.events.indexOf('lines-validated'));
    expect(bundle.lines).toEqual([patchedLine]);
  });

  it('commits a safe direct ready-to-draft recovery before surfacing a baseline conflict', async () => {
    const directOrder = { ...order, source: 'direct' as const };
    const legacyLine = {
      id: 'line-legacy', orderId: order.id, partnerId: order.partnerId, orgId: order.orgId,
      action: 'change_quantity', submitState: 'pending', targetSubscriptionId: 'sub-1',
      contractLineId: 'contract-line-1', authorizedBaselineQuantity: null,
    };
    mocks.db.select
      .mockReturnValueOnce(selectChain([directOrder], 'limit'))
      .mockReturnValueOnce(selectChain([directOrder], 'limit'))
      .mockReturnValueOnce(selectChain([{
        pax8CompanyId: 'company-1', status: 'Active', metadata: READY_METADATA,
      }], 'for'))
      .mockReturnValueOnce(selectChain([legacyLine], 'orderBy'));
    const claimedAt = new Date('2026-07-14T12:00:00.000Z');
    const claimReturning = vi.fn(async () => [{
      ...directOrder, status: 'submitting', submittedAt: claimedAt,
    }]);
    const resetReturning = vi.fn(async () => {
      mocks.events.push('draft-reset-committed');
      return [{ id: order.id }];
    });
    const claimSet = vi.fn(() => ({ where: vi.fn(() => ({ returning: claimReturning })) }));
    const resetSet = vi.fn(() => ({ where: vi.fn(() => ({ returning: resetReturning })) }));
    mocks.db.update
      .mockReturnValueOnce({ set: claimSet })
      .mockReturnValueOnce({ set: resetSet });
    const { Pax8OrderRestageRequiredError } = await import('./pax8OrderService');
    mocks.validateLines.mockRejectedValueOnce(new Pax8OrderRestageRequiredError(
      'This legacy quantity change has no authorization baseline; remove and stage it again.',
    ));

    await expect(pax8OrderSubmitRepository.claimOrder({
      partnerId: order.partnerId,
      orderId: order.id,
      actorUserId: 'actor-1', mode: { kind: 'rest' },
    })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('stage it again') });

    expect(resetSet).toHaveBeenCalledWith(expect.objectContaining({
      status: 'draft', submittedBy: null, submittedAt: null,
    }));
    expect(mocks.events).toContain('draft-reset-committed');
  });

  it('never demotes a quote order for a restage-required conflict', async () => {
    const quoteLine = {
      id: 'line-quote', orderId: order.id, partnerId: order.partnerId, orgId: order.orgId,
      action: 'change_quantity', submitState: 'pending', targetSubscriptionId: 'sub-1',
      contractLineId: 'contract-line-1', authorizedBaselineQuantity: null,
    };
    mocks.db.select
      .mockReturnValueOnce(selectChain([order], 'limit'))
      .mockReturnValueOnce(selectChain([order], 'limit'))
      .mockReturnValueOnce(selectChain([{
        pax8CompanyId: 'company-1', status: 'Active', metadata: READY_METADATA,
      }], 'for'))
      .mockReturnValueOnce(selectChain([quoteLine], 'orderBy'));
    const claimReturning = vi.fn(async () => [{
      ...order, status: 'submitting', submittedAt: new Date('2026-07-14T12:00:00.000Z'),
    }]);
    mocks.db.update.mockReturnValueOnce({
      set: vi.fn(() => ({ where: vi.fn(() => ({ returning: claimReturning })) })),
    });
    const { Pax8OrderRestageRequiredError } = await import('./pax8OrderService');
    mocks.validateLines.mockRejectedValueOnce(new Pax8OrderRestageRequiredError(
      'Quote conflict must remain non-actionable.',
    ));

    await expect(pax8OrderSubmitRepository.claimOrder({
      partnerId: order.partnerId,
      orderId: order.id,
      actorUserId: 'actor-1', mode: { kind: 'rest' },
    })).rejects.toMatchObject({ status: 409 });

    expect(mocks.db.update).toHaveBeenCalledTimes(1);
  });
});


const integration = {
  id: order.integrationId, partnerId: order.partnerId, isActive: true,
  apiBaseUrl: 'https://api.example.test', tokenUrl: 'https://auth.example.test/token',
  clientIdEncrypted: 'synthetic-client-ciphertext', clientSecretEncrypted: 'synthetic-secret-ciphertext',
} as import('./pax8SyncService').Pax8IntegrationSnapshot;

const generation = { id: integration.id, partnerId: integration.partnerId, apiBaseUrl: integration.apiBaseUrl, tokenUrl: integration.tokenUrl, isActive: integration.isActive, credentialGeneration: pax8CredentialGeneration(integration) };

const line = {
  id: 'line-1', orderId: order.id, partnerId: order.partnerId, orgId: order.orgId,
  action: 'new_subscription', submitState: 'pending', contractLineId: 'contract-line-1',
  quantity: '7.00', authorizedBaselineQuantity: null, sortOrder: 0,
} as import('./pax8OrderService').Pax8OrderLineRow;

function mutation(rows: unknown[]) {
  const returning = vi.fn().mockResolvedValue(rows);
  const where = vi.fn((_condition: unknown) => ({ returning }));
  const set = vi.fn(() => ({ where }));
  return { set, where, returning };
}

function prepareClaim(action: string = 'new_subscription', status: string = 'ready') {
  const original = { ...order, status };
  const claimed = { ...original, status: 'submitting', submittedAt: new Date('2026-10-31T12:00:00Z') };
  const staged = { ...line, action };
  mocks.db.select
    .mockReturnValueOnce(selectChain([original], 'limit'))
    .mockReturnValueOnce(selectChain([original], 'limit'))
    .mockReturnValueOnce(selectChain([{ pax8CompanyId: 'company-1', status: 'Active', metadata: READY_METADATA }], 'for'))
    .mockReturnValueOnce(selectChain([staged], 'orderBy'))
    .mockReturnValueOnce(selectChain([integration], 'limit'))
    .mockReturnValueOnce(selectChain([{ id: line.contractLineId, manualQuantity: '4.00', lineType: 'manual' }], 'limit'));
  const parent = mutation([claimed]);
  const baseline = mutation([{ id: line.id }]);
  mocks.db.update.mockReturnValueOnce(parent).mockReturnValueOnce(baseline);
  mocks.validateLines.mockImplementation(async (_order, lines) => { mocks.events.push('validated'); return lines; });
  return { parent, baseline, claimed };
}

it.each(['new_subscription', 'change_quantity', 'cancel'])('captures and durably stores the %s approved baseline before verifyClaim', async (action) => {
  const { baseline } = prepareClaim(action);
  const verifyClaim = vi.fn(async (bundle: import('./pax8OrderSubmit').ClaimedBundle) => {
    expect(mocks.events).toContain('validated');
    expect(bundle.lines[0]!.authorizedBaselineQuantity).toBe('4.00');
    expect(baseline.returning).toHaveBeenCalled();
    return { ok: true as const };
  });
  const bundle = await pax8OrderSubmitRepository.claimOrder({ partnerId: order.partnerId, orderId: order.id, actorUserId: 'actor-1', mode: { kind: 'ai', verifyClaim } });
  expect(verifyClaim).toHaveBeenCalledWith(bundle, { select: expect.any(Function) });
  expect(bundle.preClaimStatus).toBe('ready');
  expect(bundle.integrationGeneration).toEqual(generation);
  expect(bundle.integrationGeneration).not.toHaveProperty('clientSecretEncrypted');
  expect(baseline.set).toHaveBeenCalledWith(expect.objectContaining({ authorizedBaselineQuantity: '4.00' }));
});

it('propagates verifyClaim drift inside the claim context without constructing a client', async () => {
  prepareClaim();
  await expect(pax8OrderSubmitRepository.claimOrder({
    partnerId: order.partnerId, orderId: order.id, actorUserId: 'actor-1',
    mode: { kind: 'ai', verifyClaim: async () => ({ ok: false, code: 'PREVIEW_MISMATCH', message: 'PREVIEW_MISMATCH' }) },
  })).rejects.toThrow('PREVIEW_MISMATCH');
});

it.each(['apiBaseUrl', 'tokenUrl', 'clientIdEncrypted', 'clientSecretEncrypted', 'isActive'] as const)('refuses a client when the claimed integration %s changed', async (field) => {
  const generationSelect = selectChain([integration], 'limit');
  mocks.db.select.mockReturnValueOnce(generationSelect).mockReturnValueOnce(selectChain([integration], 'limit'));
  mocks.createClient.mockResolvedValue({ integration: { ...integration, [field]: field === 'isActive' ? false : 'changed' }, client: {} });
  await expect(pax8OrderSubmitRepository.createClient({ order, lines: [], integrationGeneration: generation, preClaimStatus: 'ready' }))
    .rejects.toMatchObject({ name: 'Pax8IntegrationGenerationChangedError' });
  expect(mocks.createClient).toHaveBeenCalled();
});

it('accepts access-token churn without changing the claimed integration generation', async () => {
  const client = {};
  mocks.db.select.mockReturnValueOnce(selectChain([integration], 'limit')).mockReturnValueOnce(selectChain([integration], 'limit'));
  mocks.createClient.mockResolvedValue({ integration: { ...integration, accessTokenEncrypted: 'refreshed' }, client });
  await expect(pax8OrderSubmitRepository.createClient({ order, lines: [], integrationGeneration: generation, preClaimStatus: 'ready' })).resolves.toBe(client);
});

it.each(['draft', 'awaiting_details', 'ready'])('reopens a provably unsent claim to %s with pending lines', async (preClaimStatus) => {
  const claimed = { ...order, status: 'submitting', submittedAt: new Date('2026-10-31T12:00:00Z') };
  mocks.db.select.mockReturnValueOnce(selectChain([claimed], 'limit')).mockReturnValueOnce(selectChain([line], 'limit'));
  const reset = mutation([{ id: order.id }]);
  mocks.db.update.mockReturnValueOnce(reset);
  const result = await pax8OrderSubmitRepository.reopenUnsentOrder({ order: claimed, lines: [line], preClaimStatus: preClaimStatus as never, integrationGeneration: generation }, 'preflight failed', 'PREFLIGHT_FAILED');
  expect(result.status).toBe(preClaimStatus);
  expect(result.lines[0]?.submitState).toBe('pending');
  expect(reset.set).toHaveBeenCalledWith(expect.objectContaining({ status: preClaimStatus, submittedBy: null, submittedAt: null }));
  const { PgDialect } = await import('drizzle-orm/pg-core');
  const query = new PgDialect().sqlToQuery(reset.where.mock.calls[0]![0] as never);
  expect(query.sql).toContain('submitted_at');
  expect(query.sql).toContain("submit_state <> 'pending'");
  expect(result).toMatchObject({ kind: 'refused', refusalCode: 'PREFLIGHT_FAILED' });
});

it('refuses to reopen after a line has entered in_flight', async () => {
  const claimed = { ...order, status: 'submitting', submittedAt: new Date() };
  mocks.db.select.mockReturnValueOnce(selectChain([claimed], 'limit')).mockReturnValueOnce(selectChain([{ ...line, submitState: 'in_flight' }], 'limit'));
  await expect(pax8OrderSubmitRepository.reopenUnsentOrder({ order: claimed, lines: [line], preClaimStatus: 'draft', integrationGeneration: generation }, 'failed', 'PREFLIGHT_FAILED')).rejects.toMatchObject({ status: 409 });
  expect(mocks.db.update).not.toHaveBeenCalled();
});

it.each(['persistSubmitResults', 'persistReconcileResults'] as const)('%s preserves a succeeded remote outcome on a billing CAS conflict', async (method) => {
  const claimed = { ...order, status: 'submitting', submittedAt: new Date() };
  const sentLine = { ...line, authorizedBaselineQuantity: '4.00', submitState: 'in_flight' };
  const recorded = { ...sentLine, submitState: 'succeeded', error: 'billing_conflict' };
  mocks.db.select.mockReturnValueOnce(selectChain([claimed], 'limit'))
    .mockReturnValueOnce(selectChain([{ id: line.contractLineId, lineType: 'manual', manualQuantity: '3.00' }], 'limit'))
    .mockReturnValueOnce(selectChain([recorded], 'limit'));
  // The billing CAS sees a concurrent manual quantity edit and matches no row.
  const billingWrite = mutation([]);
  const lineWrite = mutation([{ id: line.id }]);
  const parentWrite = mutation([{ id: order.id }]);
  mocks.db.update.mockReturnValueOnce(billingWrite).mockReturnValueOnce(lineWrite).mockReturnValueOnce(parentWrite);
  const result = await pax8OrderSubmitRepository[method]({ order: claimed, lines: [sentLine] } as never, [{ lineId: line.id, submitState: 'succeeded', error: null, resultSubscriptionId: 'synthetic-subscription' }], 'synthetic-order');
  expect(result.billingConflicts).toEqual([{ lineId: line.id, reason: 'baseline_changed' }]);
  expect(billingWrite.set).toHaveBeenCalledWith({ manualQuantity: '7.00' });
  expect(lineWrite.set).toHaveBeenCalledWith(expect.objectContaining({ submitState: 'succeeded', resultSubscriptionId: 'synthetic-subscription', error: expect.stringContaining('billing_conflict') }));
  const { PgDialect } = await import('drizzle-orm/pg-core');
  const query = new PgDialect().sqlToQuery(billingWrite.where.mock.calls[0]![0] as never);
  expect(query.sql).toContain('"manual_quantity" =');
  expect(query.params).toContain('4.00');
});


describe('billing result fidelity', () => {
  it.each([
    ['baseline_changed', [{ id: line.contractLineId, lineType: 'manual', manualQuantity: '3.00' }], '4.00', '7.00'],
    ['line_missing', [], '4.00', '7.00'],
    ['not_manual', [{ id: line.contractLineId, lineType: 'fixed', manualQuantity: '4.00' }], '4.00', '7.00'],
    ['no_quantity', [], '4.00', null],
    ['baseline_missing', [{ id: line.contractLineId, lineType: 'manual', manualQuantity: '3.00' }], null, '7.00'],
  ] as const)('surfaces %s without rewriting a successful vendor result', async (reason, linked, baseline, quantity) => {
    const claimed = { ...order, status: 'submitting', submittedAt: new Date() };
    const sent = { ...line, quantity, authorizedBaselineQuantity: baseline, submitState: 'in_flight' };
    const error = `billing_conflict:${reason}: review billing`;
    mocks.db.select.mockReturnValueOnce(selectChain([claimed], 'limit'));
    if (reason !== 'no_quantity') mocks.db.select.mockReturnValueOnce(selectChain([...linked], 'limit'));
    mocks.db.select.mockReturnValueOnce(selectChain([{ ...sent, submitState: 'succeeded', error }], 'limit'));
    if (reason !== 'no_quantity') mocks.db.update.mockReturnValueOnce(mutation([]));
    const lineWrite = mutation([{ id: line.id }]);
    const parentWrite = mutation([{ id: order.id }]);
    mocks.db.update.mockReturnValueOnce(lineWrite).mockReturnValueOnce(parentWrite);
    const result = await pax8OrderSubmitRepository.persistSubmitResults({ order: claimed, lines: [sent] } as never,
      [{ lineId: line.id, submitState: 'succeeded', error: null, resultSubscriptionId: 'remote-sub' }], 'remote-order');
    expect(result.billingConflicts).toEqual([{ lineId: line.id, reason }]);
    expect(result.status).toBe('partially_failed');
    expect(lineWrite.set).toHaveBeenCalledWith(expect.objectContaining({ submitState: 'succeeded', error: expect.stringContaining(`billing_conflict:${reason}:`) }));
    expect(mocks.logError).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.objectContaining({ partnerId: order.partnerId, orderId: order.id, lineId: line.id }));
    if (reason === 'line_missing' || reason === 'not_manual') expect(mocks.captureException).toHaveBeenCalled();
  });

  it.each(['new_subscription', 'cancel'] as const)('uses the null-baseline SQL CAS and correct %s quantity', async (action) => {
    const claimed = { ...order, status: 'submitting', submittedAt: new Date() };
    const sent = { ...line, action, authorizedBaselineQuantity: null, submitState: 'in_flight' };
    mocks.db.select.mockReturnValueOnce(selectChain([claimed], 'limit')).mockReturnValueOnce(selectChain([{ ...sent, submitState: 'succeeded' }], 'limit'));
    const billing = mutation([{ id: line.contractLineId }]);
    mocks.db.update.mockReturnValueOnce(billing).mockReturnValueOnce(mutation([{ id: line.id }])).mockReturnValueOnce(mutation([{ id: order.id }]));
    const result = await pax8OrderSubmitRepository.persistSubmitResults({ order: claimed, lines: [sent] } as never,
      [{ lineId: line.id, submitState: 'succeeded', error: null, resultSubscriptionId: 'remote-sub' }], 'remote-order');
    expect(result.billingConflicts).toEqual([]);
    expect(billing.set).toHaveBeenCalledWith({ manualQuantity: action === 'cancel' ? '0' : '7.00' });
    const { PgDialect } = await import('drizzle-orm/pg-core');
    expect(new PgDialect().sqlToQuery(billing.where.mock.calls[0]![0] as never).sql).toContain('"manual_quantity" is null');
  });
});


it('keeps the original refusal as cause when reopening loses its CAS', async () => {
  const claimed = { ...order, status: 'submitting', submittedAt: new Date() };
  mocks.db.select.mockReturnValueOnce(selectChain([claimed], 'limit')).mockReturnValueOnce(selectChain([line], 'limit'));
  mocks.db.update.mockReturnValueOnce(mutation([]));
  await expect(pax8OrderSubmitRepository.reopenUnsentOrder({ order: claimed, lines: [line], preClaimStatus: 'ready', integrationGeneration: generation },
    'Vendor dry run rejected input', 'PREFLIGHT_FAILED')).rejects.toMatchObject({
    code: 'CLAIM_LOST', cause: { code: 'PREFLIGHT_FAILED', message: 'Vendor dry run rejected input' },
  });
  expect(mocks.logError).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.objectContaining({
    orderId: order.id, partnerId: order.partnerId, refusalCode: 'PREFLIGHT_FAILED', originalError: 'Vendor dry run rejected input',
  }));
});

it('checks exact API URL and ciphertext generation predicates under the integration lock', async () => {
  const locked = selectChain([integration], 'limit');
  const exact = selectChain([integration], 'limit');
  mocks.db.select.mockReturnValueOnce(locked).mockReturnValueOnce(exact);
  mocks.createClient.mockResolvedValue({ integration, client: {} });
  await pax8OrderSubmitRepository.createClient({ order, lines: [], integrationGeneration: generation, preClaimStatus: 'ready' });
  const { PgDialect } = await import('drizzle-orm/pg-core');
  const query = new PgDialect().sqlToQuery((exact.where as ReturnType<typeof vi.fn>).mock.calls[0]![0] as never);
  expect(query.sql).toContain('api_base_url');
  expect(query.sql).toContain('client_secret_encrypted');
  expect(query.params).toContain(integration.clientSecretEncrypted);
});
